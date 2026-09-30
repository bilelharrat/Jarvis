"""Processes Jarvis Code runs in a project for the owner: dev servers, test runs, checks.

Each runs in its own session and process group, under a small supervisor:

- Stopping one stops everything it started (npm, then node, then esbuild…): the group gets
  SIGTERM, and what's still there a few seconds later gets SIGKILL.
- Nothing outlives the app. The supervisor (a few lines of Python between the app and the
  command) checks once a second that the app is still its parent; when the app has gone
  without stopping it (a crash, a kill -9), it takes its whole group down.
- Output (stdout and stderr together) arrives as lines: colours stripped, a progress bar's
  redraws (\\r) kept to their last state, a line with no end cut at LINE_MAX.
- The environment is the owner's login shell's, as a terminal has it: an app started from
  the Dock has only the system's PATH, without Homebrew, nvm, uv or cargo.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from collections import deque
from collections.abc import Callable, Iterable
from pathlib import Path

log = logging.getLogger("jarvis")

LINE_MAX = 1000  # characters kept of one line of output
PARTIAL_MAX = 16_000  # a line with no end yet: past this it's taken as it is
STOP_GRACE = 5.0  # seconds between SIGTERM and SIGKILL for a group being stopped
LINGER = 2.0  # seconds what a finished command left holding its output may stay
ENV_TIMEOUT = 10.0  # seconds for the login shell to say its environment
ENV_MARK = "__JARVIS_ENV__"
# Where tools live when the login shell can't be asked (it hung, or there's none).
_COMMON_PATHS = (
    "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "~/.local/bin", "~/.cargo/bin",
    "~/go/bin", "~/.bun/bin", "~/.deno/bin", "~/.volta/bin",
)  # fmt: skip

# Between the app and the command: its own session and group (start_new_session), the
# command in it, and the app watched. Handlers (not SIG_IGN) so the command, after its
# exec, gets the default ones.
SUPERVISE = """
import os, signal, subprocess, sys, time
parent = os.getppid()
child = None
def forward(signum, _frame):
    if child is not None:
        try:
            child.send_signal(signum)
        except OSError:
            pass
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(s, forward)
try:
    child = subprocess.Popen(sys.argv[1:])
except OSError as exc:
    print(f"couldn't start {sys.argv[1]}: {exc.strerror or exc}", flush=True)
    sys.exit(127)
while True:
    try:
        code = child.wait(timeout=1.0)
        break
    except subprocess.TimeoutExpired:
        pass
    if os.getppid() != parent:
        try:
            os.killpg(0, signal.SIGTERM)
        except OSError:
            pass
        try:
            child.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            pass
        os.killpg(0, signal.SIGKILL)
sys.exit(code if code >= 0 else 128 - code)
"""

_ANSI = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]"
)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_ansi(text: str) -> str:
    """Colours, cursor moves and other terminal controls out of a line of output."""
    return _CONTROL.sub("", _ANSI.sub("", text))


class LineSplitter:
    """Output as it comes (in any chunks) -> finished lines. A \\r without a \\n (a progress
    bar redrawing) keeps only what's after it, as a terminal shows it."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._partial = ""

    def feed(self, data: bytes) -> list[str]:
        text = self._partial + self._decoder.decode(data)
        parts = text.split("\n")
        self._partial = parts.pop()
        if len(self._partial) > PARTIAL_MAX:  # no end in sight: take it as it is
            parts.append(self._partial)
            self._partial = ""
        return [_line(p) for p in parts]

    def flush(self) -> list[str]:
        """What's left at the end of the output."""
        rest = self._partial + self._decoder.decode(b"", final=True)
        self._partial = ""
        return [_line(rest)] if rest.strip() else []


def _line(raw: str) -> str:
    raw = raw.rstrip("\r")
    if "\r" in raw:  # redrawn in place: only the last drawing is what shows
        raw = raw.rsplit("\r", 1)[-1]
    return strip_ansi(raw)[:LINE_MAX]


class LogRing:
    """The newest lines of a process's output, each numbered: a window, a tool or a check
    asks for the ones after a number it has seen."""

    def __init__(self, max_lines: int = 2000) -> None:
        self.lines: deque[tuple[int, str]] = deque(maxlen=max_lines)
        self.seq = 0

    def add(self, lines: Iterable[str]) -> list[tuple[int, str]]:
        added = []
        for text in lines:
            self.seq += 1
            item = (self.seq, text)
            self.lines.append(item)
            added.append(item)
        return added

    def since(self, seq: int, limit: int = 500) -> list[tuple[int, str]]:
        """The lines after seq (the newest `limit` of them)."""
        out = [item for item in self.lines if item[0] > seq]
        return out[-limit:] if limit else out

    def tail(self, n: int) -> list[str]:
        return [text for _, text in list(self.lines)[-n:]] if n > 0 else []


# ── the owner's environment ──

_env_cache: dict[str, str] | None = None
_env_at = 0.0
ENV_FRESH = 15 * 60  # seconds a looked-up environment is used before asking the shell again


def fallback_env() -> dict[str, str]:
    """The app's own environment with the usual tool folders added to its PATH."""
    env = dict(os.environ)
    have = env.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").split(":")
    extra = [str(Path(p).expanduser()) for p in _COMMON_PATHS]
    env["PATH"] = ":".join(dict.fromkeys([*extra, *have]))
    return env


def parse_env(raw: bytes) -> dict[str, str]:
    """`env -0` after the marker (whatever the shell's startup files printed before it)."""
    text = raw.decode(errors="replace")
    if ENV_MARK not in text:
        return {}
    body = text.split(ENV_MARK, 1)[1]
    env = {}
    for item in body.split("\0"):
        key, sep, value = item.partition("=")
        if sep and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            env[key] = value
    return env


def shell_env(refresh: bool = False) -> dict[str, str]:
    """The environment a terminal would have: the login shell's, asked once (as an editor
    does), then kept a while. Falls back to the app's own with the usual tool folders."""
    global _env_cache, _env_at
    if _env_cache is not None and not refresh and time.monotonic() - _env_at < ENV_FRESH:
        return dict(_env_cache)
    shell = os.environ.get("SHELL") or "/bin/zsh"
    env: dict[str, str] = {}
    try:
        out = subprocess.run(  # noqa: S603 - the owner's own shell, only to read its environment
            [shell, "-i", "-l", "-c", f"printf '%s' {ENV_MARK}; command env -0"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=ENV_TIMEOUT,
            check=False,
            start_new_session=True,  # its job control never touches the app's terminal
        ).stdout
        env = parse_env(out)
    except (OSError, subprocess.SubprocessError):
        log.warning("couldn't read the login shell's environment; using the app's own")
    if "PATH" not in env:
        env = fallback_env()
    env.pop("PWD", None)
    env.pop("OLDPWD", None)
    env.pop("SHLVL", None)
    _env_cache, _env_at = env, time.monotonic()
    return dict(env)


def which(command: str, env: dict[str, str], cwd: Path) -> str | None:
    """Where a command is: a path (relative to cwd) as it is, a name on the env's PATH."""
    if not command or "\0" in command:
        return None
    if "/" in command:
        # Not resolved: a venv's python is a link, and it's only the venv's by that path.
        path = Path(os.path.normpath(cwd / Path(command).expanduser()))
        return str(path) if path.is_file() and os.access(path, os.X_OK) else None
    return shutil.which(command, path=env.get("PATH", ""))


# ── one supervised process ──


class Proc:
    """One command in its own process group, its output as lines to on_lines and its end
    (the exit code, or None when it couldn't start) to on_exit."""

    def __init__(
        self,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        on_lines: Callable[[list[str]], None],
        on_exit: Callable[[int | None], None] | None = None,
    ) -> None:
        self.argv, self.cwd, self.env = list(argv), cwd, env
        self.on_lines, self.on_exit = on_lines, on_exit
        self.proc: asyncio.subprocess.Process | None = None
        self.returncode: int | None = None
        self.stopping = False
        self._reader: asyncio.Task | None = None
        self._done = asyncio.Event()
        self._launched = asyncio.Event()  # start() is over: started, or couldn't

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None else None

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    @property
    def finished(self) -> bool:
        """Its end has been taken in (the output read, on_exit called)."""
        return self._done.is_set()

    async def start(self) -> None:
        """Raises OSError when it can't start at all."""
        try:
            self.proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-S",
                "-c",
                SUPERVISE,
                *self.argv,
                cwd=str(self.cwd),
                env=self.env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            self._reader = asyncio.create_task(self._read())
            if self.stopping:  # stopped while it was starting: it goes as soon as it's there
                signal_group(self.proc.pid, signal.SIGTERM)
        finally:
            self._launched.set()

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        splitter = LineSplitter()
        ended_at = killed_at = 0.0
        try:
            while True:
                try:
                    data = await asyncio.wait_for(self.proc.stdout.read(65536), 1.0)
                except TimeoutError:
                    # Quiet. Once the command has ended, what it left behind that still holds
                    # its output (a watcher it started in the background) goes too; and one
                    # that slipped into a session of its own is no longer waited for.
                    if self.proc.returncode is None:
                        continue
                    now = time.monotonic()
                    ended_at = ended_at or now
                    if not killed_at and now - ended_at >= LINGER:
                        await asyncio.to_thread(kill_leftovers, self.proc.pid)
                        killed_at = time.monotonic()
                    elif killed_at and now - killed_at >= LINGER:
                        transport = getattr(self.proc, "_transport", None)
                        if transport is not None:
                            transport.close()  # our end of the pipe: no one's output to read
                        break
                    continue
                if not data:
                    break
                lines = splitter.feed(data)
                if lines:
                    self._deliver(lines)
            rest = splitter.flush()
            if rest:
                self._deliver(rest)
            self.returncode = await self.proc.wait()
            # What it left running in its session (a watcher it spawned) goes with it.
            await asyncio.to_thread(kill_leftovers, self.proc.pid)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("reading a process's output failed")
            with contextlib.suppress(Exception):
                self.returncode = await self.proc.wait()
        finally:
            self._done.set()
        if self.on_exit is not None:
            try:
                self.on_exit(self.returncode)
            except Exception:
                log.exception("a process's end couldn't be handled")

    def _deliver(self, lines: list[str]) -> None:
        try:
            self.on_lines(lines)
        except Exception:
            log.exception("a process's output couldn't be handled")

    async def wait(self) -> int | None:
        await self._done.wait()
        return self.returncode

    async def stop(self, grace: float = STOP_GRACE) -> None:
        """SIGTERM to the whole group, then SIGKILL to whatever of it (and its session) is
        still there after grace seconds."""
        if self._done.is_set():
            return
        self.stopping = True
        if self.proc is None:  # still starting: start() sees `stopping` once it's there
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._launched.wait(), 30.0)
            if self.proc is None:
                return  # it never started
        pid = self.proc.pid
        signal_group(pid, signal.SIGTERM)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._done.wait(), grace)
        if not self._done.is_set():
            await asyncio.to_thread(kill_leftovers, pid)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._done.wait(), 3.0)

    def kill_now(self) -> None:
        """The app is quitting: the group gets SIGTERM, then SIGKILL a moment later (one
        still starting gets it as soon as it's there)."""
        self.stopping = True
        if self.proc is None or self.proc.returncode is not None:
            return
        signal_group(self.proc.pid, signal.SIGTERM)


def signal_group(pgid: int, sig: int) -> None:
    with contextlib.suppress(OSError):
        os.killpg(pgid, sig)


def session_pids(sid: int) -> list[int]:
    """Every process still in a session (the supervisor's: it leads its own)."""
    import psutil

    found = []
    for p in psutil.process_iter(["pid"]):
        with contextlib.suppress(OSError):
            if os.getsid(p.info["pid"]) == sid:
                found.append(p.info["pid"])
    return found


def kill_leftovers(sid: int) -> None:
    """SIGKILL to the group and to anything that moved to a group of its own but is still
    in the session."""
    signal_group(sid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        for pid in session_pids(sid):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)


def kill_all_now(procs: Iterable[Proc], grace: float = 1.5) -> None:
    """At exit, synchronously: SIGTERM to every group, a moment, then SIGKILL."""
    live = [p for p in procs if p.proc is not None and p.proc.returncode is None]
    for p in live:
        p.kill_now()
    deadline = time.monotonic() + grace
    while live and time.monotonic() < deadline:
        live = [p for p in live if _group_alive(p.proc.pid)]  # type: ignore[union-attr]
        if live:
            time.sleep(0.05)
    for p in live:
        kill_leftovers(p.proc.pid)  # type: ignore[union-attr]


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def listening_ports(sid: int) -> set[int]:
    """The TCP ports processes in this session listen on (a dev server that never says
    its address still has one)."""
    import psutil

    ports: set[int] = set()
    for pid in session_pids(sid):
        with contextlib.suppress(Exception):
            for conn in psutil.Process(pid).net_connections(kind="inet"):
                if conn.status == psutil.CONN_LISTEN and conn.laddr:
                    ports.add(int(conn.laddr.port))
    return ports


async def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    """Whether something answers on this local port."""
    for where in (host, "::1") if host == "127.0.0.1" else (host,):
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(where, port), timeout)
        except (OSError, TimeoutError):
            continue
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
        return True
    return False


def describe_exit(code: int | None) -> str:
    """How a process ended, to follow "It": "exited with code 3", "was terminated"."""
    if code is None:
        return "didn't start"
    if code == 0:
        return "exited"
    if code > 128:
        name = {137: "killed", 143: "terminated", 130: "interrupted", 129: "hung up"}.get(code)
        return f"was {name}" if name else f"was ended by signal {code - 128}"
    return f"exited with code {code}"


def public_argv(argv: list[str]) -> str:
    """A command line as a person reads it."""
    import shlex

    return shlex.join(argv)


async def run_quiet(
    argv: list[str], cwd: Path, env: dict[str, str], timeout: float = 60, limit: int = 4_000_000
) -> tuple[int | None, str]:
    """A short helper run to its end (a list of schemes, build settings): its exit code
    (None when it couldn't start or ran out of time, and was stopped) and its output."""
    lines: list[str] = []
    size = 0

    def take(new: list[str]) -> None:
        nonlocal size
        for line in new:
            if size < limit:
                lines.append(line)
                size += len(line) + 1

    proc = Proc(argv, cwd, env, take)
    try:
        await proc.start()
    except OSError as exc:
        return None, str(exc)
    try:
        code = await asyncio.wait_for(proc.wait(), timeout)
    except TimeoutError:
        await proc.stop(grace=1.0)
        return None, "\n".join(lines)
    return code, "\n".join(lines)
