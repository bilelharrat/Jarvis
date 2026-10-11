"""Processes Eden Code runs in a project for the owner: dev servers, test runs, checks.

Each runs in its own session and process group, under a small supervisor:

- Stopping one stops everything it started (npm, then node, then esbuild…): the group gets
  SIGTERM, and what's still there a few seconds later gets SIGKILL.
- Nothing outlives the app. The supervisor (a few lines of Python between the app and the
  command) checks once a second that the app is still its parent; when the app has gone
  without stopping it (a crash, a kill -9), it takes its whole group down.
- Output (stdout and stderr together) arrives as lines: colours stripped, a progress bar's
  redraws (\\r) kept to their last state, a very long line cut at LINE_MAX (marked "…"),
  except for output read as data (a checker's JSON: line_max=None).
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

from . import osplat
from .packaged import owner_env

log = logging.getLogger("jarvis")

LINE_MAX = 1000  # characters kept of one line of output
PARTIAL_MAX = 16_000  # a line with no end yet: past this it's taken as it is
STOP_GRACE = 5.0  # seconds between SIGTERM and SIGKILL for a group being stopped
LINGER = 2.0  # seconds what a finished command left holding its output may stay
ENV_TIMEOUT = 10.0  # seconds for the login shell to say its environment
ENV_MARK = "__JARVIS_ENV__"
_WIN_PATHS = (
    "~/.local/bin", "~/.cargo/bin", "~/go/bin", "~/.bun/bin", "~/.deno/bin", "~/AppData/Roaming/npm",
    "C:/Program Files/Git/cmd", "C:/Program Files/nodejs", "~/AppData/Local/Programs/Python/Launcher",
)  # fmt: skip
# Where tools live when the login shell can't be asked (it hung, or there's none).
_KILL = getattr(signal, "SIGKILL", 9)  # (Windows has no SIGKILL)
_COMMON_PATHS = (
    "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "~/.local/bin", "~/.cargo/bin",
    "~/go/bin", "~/.bun/bin", "~/.deno/bin", "~/.volta/bin",
)  # fmt: skip

# Windows: the same watch without sessions or signals; the command's whole tree is ended with
# taskkill when the app has gone.
SUPERVISE_WIN = """
import os, subprocess, sys, time
import psutil
parent = os.getppid()
try:
    child = subprocess.Popen(sys.argv[1:])
except OSError as exc:
    print(f"couldn't start {sys.argv[1]}: {exc.strerror or exc}", flush=True)
    sys.exit(127)
def tree():
    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True)
while True:
    try:
        code = child.wait(timeout=1.0)
        break
    except subprocess.TimeoutExpired:
        pass
    if not psutil.pid_exists(parent):
        tree()
        sys.exit(1)
sys.exit(code & 0xFF if code >= 0 else 1)
"""

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


# Back to the start of the line (ESC[G, ESC[0G, ESC[1G: Node's readline.cursorTo(0)) or the
# whole line erased (ESC[2K): a redraw in place, as a \r is.
_TO_LINE_START = re.compile(r"\x1b\[(?:[01]?G|2K)")
CUT_BACK = 120  # a cut line goes back this far, at most, to end between words


def strip_ansi(text: str) -> str:
    """Colours, cursor moves and other terminal controls out of a line of output."""
    return _CONTROL.sub("", _ANSI.sub("", text))


class LineSplitter:
    """Output as it comes (in any chunks) -> finished lines. A \\r without a \\n (a progress
    bar redrawing) keeps only what's after it, as a terminal shows it. A line longer than
    line_max is cut, marked with "…" (None: kept whole, for output read as data: a
    checker's JSON). One with no end past partial_max: a progress bar keeps only its latest
    drawing and waits for its end; anything else is said once, cut, and the rest of it is
    left out until its end."""

    def __init__(self, line_max: int | None = LINE_MAX, partial_max: int = PARTIAL_MAX) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._partial = ""
        self._skipping = False  # the rest of a line already said (cut) is left out
        self.line_max, self.partial_max = line_max, partial_max

    def feed(self, data: bytes) -> list[str]:
        text = self._partial + self._decoder.decode(data)
        if "\x1b[" in text:  # a bar redrawn by moving to the line's start (no \r)
            text = _TO_LINE_START.sub("\r", text)
        parts = text.split("\n")
        self._partial = parts.pop()
        if self._skipping and parts:  # the end of the over-long line: its rest goes
            parts.pop(0)
            self._skipping = False
        out = [_line(p, self.line_max) for p in parts]
        if self._skipping:
            self._partial = ""
        elif len(self._partial) > self.partial_max:
            if self.line_max is None:  # (read as data: taken as it is)
                out.append(_line(self._partial, None))
                self._partial = ""
            else:
                if "\r" in self._partial:  # a progress bar: only its latest drawing
                    self._partial = self._partial.rsplit("\r", 1)[-1]
                if len(self._partial) > self.partial_max:  # one very long line: said once
                    out.append(_line(self._partial, self.line_max, cut=True))
                    self._partial, self._skipping = "", True
        return out

    def flush(self) -> list[str]:
        """What's left at the end of the output."""
        rest = self._partial + self._decoder.decode(b"", final=True)
        self._partial = ""
        if self._skipping:
            self._skipping = False
            return []
        return [_line(rest, self.line_max)] if rest.strip() else []


def _line(raw: str, line_max: int | None = LINE_MAX, cut: bool = False) -> str:
    raw = raw.rstrip("\r")
    if "\r" in raw:  # redrawn in place: only the last drawing is what shows
        raw = raw.rsplit("\r", 1)[-1]
    text = strip_ansi(raw)
    if line_max is not None and (cut or len(text) > line_max):
        # Between words where there's one near: a key the cut fell in goes whole (its
        # prefix with it), never its start alone, which masking would no longer know.
        kept = text[: line_max - 1]
        if len(text) >= line_max and not text[line_max - 1].isspace():
            space = kept.rfind(" ", len(kept) - CUT_BACK)
            if space > 0:
                kept = kept[:space]
        return kept + "…"
    return text


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


async def output_end(stream: asyncio.StreamReader, chars: int) -> str:
    """What a process prints, read to its end, as text: only its last `chars` characters
    are wanted, so only the bytes they can take (four a character, at most) are held as it's
    read. A command printing gigabytes costs this much, not its whole output, twice over
    (gathered, then decoded). Longer than `chars` when there was more."""
    keep = chars * 4 + 4  # (and a character cut in two at the start, left out)
    kept = bytearray()
    while chunk := await stream.read(65536):
        kept += chunk
        if len(kept) > keep:
            del kept[: len(kept) - keep]
    return kept.decode(errors="replace")


# ── the owner's environment ──

_env_cache: dict[str, str] | None = None
_env_at = 0.0
ENV_FRESH = 15 * 60  # seconds a looked-up environment is used before asking the shell again


def fallback_env() -> dict[str, str]:
    """The app's own environment (without JARVIS's own settings) with the usual tool
    folders added to its PATH."""
    env = owner_env(os.environ)
    have = env.get("PATH", "" if osplat.IS_WIN else "/usr/bin:/bin:/usr/sbin:/sbin").split(
        os.pathsep
    )
    extra = [str(Path(p).expanduser()) for p in (_WIN_PATHS if osplat.IS_WIN else _COMMON_PATHS)]
    env["PATH"] = os.pathsep.join(dict.fromkeys([*extra, *have]))
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
    shell = osplat.default_shell()
    env: dict[str, str] = {}
    if osplat.IS_WIN:  # (no login shell to ask: the app's own environment, as Explorer gave it)
        env = fallback_env()
        _env_cache, _env_at = env, time.monotonic()
        return dict(env)
    try:
        out = subprocess.run(  # noqa: S603 - the owner's own shell, only to read its environment
            [shell, "-i", "-l", "-c", f"printf '%s' {ENV_MARK}; command env -0"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=ENV_TIMEOUT,
            check=False,
            start_new_session=True,  # its job control never touches the app's terminal
            env=owner_env(os.environ),  # the owner's, never JARVIS's own settings
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
    if "/" in command or (osplat.IS_WIN and "\\" in command):
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
        line_max: int | None = LINE_MAX,
        orphans: bool = False,
    ) -> None:
        self.argv, self.cwd, self.env = list(argv), cwd, env
        # orphans: what it set loose as a daemon (forked twice, its own session, launchd its
        # parent) is found at Stop by the mark its environment carries, and stops with it.
        self.orphans = orphans
        self.tag = f"{os.getpid()}-{id(self)}-{time.time_ns()}"
        self.started_at = 0.0
        self.on_lines, self.on_exit = on_lines, on_exit
        self.line_max = line_max  # None: lines kept whole (output read as data)
        # Processes seen under it: {pid: when it started}. One that moved to a session of
        # its own (a daemon, setsid) is out of the group and the session, and still goes.
        self._kin: dict[int, float] = {}
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
        env = {**self.env, RUN_TAG: self.tag} if self.orphans else self.env
        self.started_at = time.time()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-S",
                "-c",
                SUPERVISE_WIN if osplat.IS_WIN else SUPERVISE,
                *self.argv,
                cwd=str(self.cwd),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                **osplat.group_popen_kwargs(),
            )
            self._reader = asyncio.create_task(self._read())
            if self.stopping:  # stopped while it was starting: it goes as soon as it's there
                signal_group(self.proc.pid, signal.SIGTERM)
        finally:
            self._launched.set()

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        splitter = (
            LineSplitter()
            if self.line_max == LINE_MAX
            else LineSplitter(self.line_max, PARTIAL_MAX if self.line_max else 4_000_000)
        )
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
                        await asyncio.to_thread(self.kill_rest)
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
            await asyncio.to_thread(self.kill_rest)
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
        await asyncio.to_thread(self.note_kin)
        signal_group(pid, signal.SIGTERM)
        if self.orphans:  # (looked for after the SIGTERM: they're launchd's already)
            await asyncio.to_thread(self.note_orphans, signal.SIGTERM)
        end = time.monotonic() + grace
        ended_at = 0.0
        while not self._done.is_set() and time.monotonic() < end:
            if self.proc.returncode is not None and self._kin:
                ended_at = ended_at or time.monotonic()
                if time.monotonic() - ended_at >= 1.0:
                    # It ended a moment ago, and something it set loose still holds its
                    # output: that goes too.
                    await asyncio.to_thread(self.kill_kin)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._done.wait(), 0.1)
        if not self._done.is_set():
            await asyncio.to_thread(self.kill_rest)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._done.wait(), 3.0)
        if self._kin:  # (a daemon found after its end was taken in)
            await asyncio.to_thread(self.kill_kin)

    def note_orphans(self, sig: int | None = None) -> None:
        """Remember (and send sig to) the daemons it set loose: blocking."""
        for pid, born in find_orphans({self.tag: self}).get(self.tag, {}).items():
            self._kin.setdefault(pid, born)
            if sig is not None:
                with contextlib.suppress(OSError):
                    os.kill(pid, sig)

    def note_kin(self) -> None:
        """Remember the processes under it now (blocking: psutil)."""
        if self.proc is None or self.proc.returncode is not None:
            return
        import psutil

        with contextlib.suppress(Exception):
            for child in psutil.Process(self.proc.pid).children(recursive=True):
                with contextlib.suppress(Exception):
                    self._kin.setdefault(child.pid, child.create_time())

    def kill_kin(self) -> None:
        """SIGKILL to the processes seen under it that are still there (the same ones: a
        pid used again by another process is left alone)."""
        if not self._kin:
            return
        import psutil

        for pid, born in list(self._kin.items()):
            with contextlib.suppress(Exception):
                found = psutil.Process(pid)
                if abs(found.create_time() - born) < 0.01:
                    found.kill()
        self._kin.clear()

    def kill_rest(self) -> None:
        """Its group, its session and what was seen under it: SIGKILL (blocking)."""
        if self.proc is not None:
            kill_leftovers(self.proc.pid)
        self.kill_kin()

    def kill_now(self) -> None:
        """The app is quitting: the group gets SIGTERM, then SIGKILL a moment later (one
        still starting gets it as soon as it's there)."""
        self.stopping = True
        if self.proc is None or self.proc.returncode is not None:
            return
        signal_group(self.proc.pid, signal.SIGTERM)


RUN_TAG = "JARVIS_RUN_TAG"  # in the environment of what a Proc(orphans=True) starts


def find_orphans(procs: dict[str, Proc]) -> dict[str, dict[int, float]]:
    """{tag: {pid: when it started}}: processes whose parent is launchd (a daemon, forked
    twice: in neither the group nor the session), started since its Proc, by the same
    user, carrying its mark. One look at the process list for all of them (blocking)."""
    if osplat.IS_WIN or not procs:
        return {}
    import psutil

    since = min(p.started_at for p in procs.values()) - 1.0
    me = os.getuid()
    found: dict[str, dict[int, float]] = {}
    for pid in psutil.pids():
        with contextlib.suppress(Exception):
            p = psutil.Process(pid)
            with p.oneshot():
                if p.ppid() != 1 or p.create_time() < since or p.uids().real != me:
                    continue
                born = p.create_time()
            tag = p.environ().get(RUN_TAG)
            if tag in procs and born >= procs[tag].started_at - 1.0:
                found.setdefault(tag, {})[pid] = born
    return found


def signal_group(pgid: int, sig: int) -> None:
    with contextlib.suppress(OSError):
        if osplat.IS_WIN:
            osplat.kill_group(pgid, force=sig == _KILL)
        else:
            os.killpg(pgid, sig)


def session_pids(sid: int) -> list[int]:
    """Every process still in a session (the supervisor's: it leads its own)."""
    import psutil

    if osplat.IS_WIN:  # no sessions: the supervisor and everything under it
        with contextlib.suppress(Exception):
            return [sid, *(c.pid for c in psutil.Process(sid).children(recursive=True))]
        return []
    # The bare pid list and one getsid each: 1.5 ms for 600 processes, where process_iter
    # (a psutil.Process made for each) took 9-30 ms, and 70 ms on a busy Mac, every 2 s
    # while a dev server hadn't said its address (devservers._watch).
    found = []
    for pid in psutil.pids():
        with contextlib.suppress(OSError):
            if os.getsid(pid) == sid:
                found.append(pid)
    return found


def kill_leftovers(sid: int) -> None:
    """SIGKILL to the group and to anything that moved to a group of its own but is still
    in the session."""
    pids = session_pids(sid) if osplat.IS_WIN else []
    signal_group(sid, _KILL)
    with contextlib.suppress(Exception):
        for pid in pids or session_pids(sid):
            with contextlib.suppress(OSError):
                os.kill(pid, _KILL)


def kill_all_now(procs: Iterable[Proc], grace: float = 1.5) -> None:
    """At exit, synchronously: SIGTERM to every group, a moment, then SIGKILL."""
    procs = list(procs)
    live = [p for p in procs if p.proc is not None and p.proc.returncode is None]
    for p in live:
        p.note_kin()
        p.kill_now()
    with contextlib.suppress(Exception):  # their daemons too (one look for all of them)
        tagged = {p.tag: p for p in live if p.orphans}
        for tag, pids in find_orphans(tagged).items():
            tagged[tag]._kin.update(pids)
    deadline = time.monotonic() + grace
    while live and time.monotonic() < deadline:
        live = [p for p in live if _group_alive(p.proc.pid)]  # type: ignore[union-attr]
        if live:
            time.sleep(0.05)
    for p in live:
        kill_leftovers(p.proc.pid)  # type: ignore[union-attr]
    for p in procs:
        with contextlib.suppress(Exception):
            p.kill_kin()


def _group_alive(pgid: int) -> bool:
    if osplat.IS_WIN:
        return osplat.group_alive(pgid)
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

    proc = Proc(argv, cwd, env, take, line_max=None)
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
