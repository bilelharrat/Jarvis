"""The Jarvis Code workbench: the panes beside a session, as in Claude Code's desktop app.

- Terminal: a real login shell in the project folder, on a pseudo-terminal that is its
  controlling terminal (Ctrl-C, Ctrl-Z, job control and password prompts work), drawn in
  the window with xterm.js. Closing it hangs up, as closing a terminal window does.
- iOS Simulator: which simulators are booted, and a live picture of the screen.
- Keep awake: macOS's own caffeinate, for as long as the switch is on (and never longer
  than the app runs).
- Files: read-only views of the project's files (never credentials or private folders).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import json
import os
import pty
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import computer
from .packaged import owner_env

Emit = Callable[..., None]
MAX_FILE_BYTES = 300_000
# The shell starts through a tiny Python step that makes the terminal its controlling
# terminal (a new session, then TIOCSCTTY), since subprocess can't, and then becomes it.
_WITH_TERMINAL = (
    "import fcntl, os, sys, termios\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "os.execvp(sys.argv[1], sys.argv[1:])"
)
OUTPUT_CHUNK = 64 * 1024  # the most one message to the windows carries
OUTPUT_EVERY = 0.03  # seconds between messages while output streams
OUTPUT_PAUSE = 1024 * 1024  # this much unsent and reading stops: the programs writing wait
INPUT_LIMIT = 8 * 1024 * 1024  # typing and pastes the shell hasn't taken yet
SIM_WATCH_SECONDS = 30 * 60  # a simulator picture stream stops by itself after this
HANG_UP_SECONDS = 3  # a closed terminal's shell gets this long to go before it's killed
STARTING_SECONDS = 60  # and a job it was still starting, at most this long to start
Program = tuple[str, ...] | None  # what a process runs (its command line), None unreadable


class Terminal:
    """One login shell on a pseudo-terminal. Output goes to the windows in batches, at
    most OUTPUT_CHUNK every OUTPUT_EVERY seconds; if the windows fall far behind (a
    runaway `yes`), reading pauses and the programs writing simply wait."""

    def __init__(self, term_id: str, cwd: Path, emit: Emit) -> None:
        self.id, self.cwd, self.emit = term_id, cwd, emit
        self.loop = asyncio.get_running_loop()
        self.closed = False
        self._out = bytearray()  # from the shell, not yet sent to the windows
        self._in = bytearray()  # for the shell, not yet written
        self._flush_at: asyncio.TimerHandle | None = None
        self._sent_at = 0.0
        self._reading = self._writing = False
        master, slave = pty.openpty()
        try:
            shell = os.environ.get("SHELL") or "/bin/zsh"
            env = {**owner_env(os.environ), "TERM": "xterm-256color", "COLORTERM": "truecolor"}
            self.proc = subprocess.Popen(  # noqa: S603 - the user's own shell, in their project
                [sys.executable, "-I", "-S", "-c", _WITH_TERMINAL, shell, "-l"],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=str(cwd),
                env=env,
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(master)  # nothing started: no descriptor left behind either
            raise
        finally:
            os.close(slave)
        self.master = master
        os.set_blocking(master, False)
        self._read_again()

    # ── from the shell ──

    def _read_again(self) -> None:
        if not self._reading and not self.closed:
            self.loop.add_reader(self.master, self._readable)
            self._reading = True

    def _pause_reading(self) -> None:
        if self._reading:
            with contextlib.suppress(Exception):
                self.loop.remove_reader(self.master)
            self._reading = False

    def _readable(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: the shell and everything on its terminal are gone
            data = b""
        if not data:
            self._flush(everything=True)
            self.close()
            self.emit("term_exit", term=self.id)
            return
        self._out += data
        if len(self._out) >= OUTPUT_PAUSE:
            self._pause_reading()
        if self._flush_at is None:
            wait = max(0.0, self._sent_at + OUTPUT_EVERY - self.loop.time())
            self._flush_at = self.loop.call_later(wait, self._flush)

    def _flush(self, everything: bool = False) -> None:
        self._flush_at = None
        while self._out:
            chunk = bytes(self._out[:OUTPUT_CHUNK])
            del self._out[:OUTPUT_CHUNK]
            self._sent_at = self.loop.time()
            self.emit("term_data", term=self.id, data=base64.b64encode(chunk).decode())
            if not everything:
                break
        if self._out:
            self._flush_at = self.loop.call_later(OUTPUT_EVERY, self._flush)
        if len(self._out) < OUTPUT_PAUSE // 2:
            self._read_again()

    # ── to the shell ──

    def write(self, text: str) -> None:
        """Keystrokes and pastes, every byte: what the terminal can't take yet is written
        as it drains."""
        data = text.encode()
        if self.closed or len(self._in) + len(data) > INPUT_LIMIT:
            return
        self._in += data
        self._write_some()

    def _write_some(self) -> None:
        while self._in and not self.closed:
            try:
                written = os.write(self.master, self._in)
            except BlockingIOError:
                break
            except OSError:  # the shell is gone
                self._in.clear()
                break
            del self._in[:written]
        waiting = bool(self._in) and not self.closed
        if waiting and not self._writing:
            self.loop.add_writer(self.master, self._write_some)
            self._writing = True
        elif not waiting and self._writing:
            with contextlib.suppress(Exception):
                self.loop.remove_writer(self.master)
            self._writing = False

    def resize(self, cols: int, rows: int) -> None:
        if not self.closed and cols > 0 and rows > 0:
            with contextlib.suppress(OSError):
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self) -> None:
        """Hang up, as closing a terminal window does: the shell and the jobs it started
        get SIGHUP, and the shell is reaped (killed if it ignores that) off the event
        loop, so nothing is left running or as a zombie."""
        if self.closed:
            return
        self.closed = True
        if self._flush_at is not None:
            self._flush_at.cancel()
        self._pause_reading()
        if self._writing:
            with contextlib.suppress(Exception):
                self.loop.remove_writer(self.master)
        with contextlib.suppress(OSError):
            os.close(self.master)
        _hang_up(self.proc)


def _hang_up(proc: subprocess.Popen) -> None:
    session = proc.pid  # the shell leads its own session and process group
    first = _hang_up_on(_session_members(session) or [session], {})

    def reap(hung_up: dict[int, Program]) -> None:
        # A job the shell was still starting when the hang-up came (forked, so still running
        # the shell's own program, not yet the job's) can lose the signal in the shell's own
        # handling of it, then run on as the job with nothing left to end it. So until the
        # shell is reaped and no job is still starting, whatever in the session is new, or
        # has become another program since, is hung up on too. What was hung up on and
        # stayed (nohup) is left be, as a terminal would.
        shell = hung_up.get(session)
        started = time.monotonic()
        while True:
            if proc.poll() is None:
                with contextlib.suppress(subprocess.TimeoutExpired):
                    proc.wait(timeout=0.2)
            else:
                time.sleep(0.2)
            waited = time.monotonic() - started
            gone = proc.poll() is not None  # (its pid may be another process's now)
            if not gone and waited >= HANG_UP_SECONDS:  # the shell ignores hang-ups
                with contextlib.suppress(OSError):
                    os.killpg(session, signal.SIGKILL)
            members = [pid for pid in _session_members(session) if not (gone and pid == session)]
            hung_up = _hang_up_on(members, hung_up)
            starting = shell is not None and any(
                program == shell for pid, program in hung_up.items() if pid != session
            )
            if (gone and not starting) or waited >= STARTING_SECONDS:
                break

    threading.Thread(target=reap, args=(first,), name="jarvis-terminal-reaper", daemon=True).start()


def _hang_up_on(members: list[int], before: dict[int, Program]) -> dict[int, Program]:
    """SIGHUP to each member that wasn't hung up on before as the program it runs now.
    Returns what each member runs, for the next look."""
    import psutil

    programs: dict[int, Program] = {}
    for pid in members:
        try:
            programs[pid] = tuple(psutil.Process(pid).cmdline())
        except (psutil.Error, OSError):
            programs[pid] = None
        if pid not in before or before[pid] != programs[pid]:
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGHUP)
    return programs


def _session_members(session: int) -> list[int]:
    """Every process in a terminal's session: the shell, its jobs, what they started."""
    import psutil

    members = []
    for pid in psutil.pids():
        with contextlib.suppress(OSError):
            if os.getsid(pid) == session:
                members.append(pid)
    return members


class Workbench:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self.terminals: dict[str, Terminal] = {}
        self._awake: subprocess.Popen | None = None
        self._sim_task: asyncio.Task | None = None

    # ── terminal ──

    def open_terminal(self, cwd: Path) -> str:
        """The project's terminal (one per folder), started if needed."""
        term_id = str(cwd)
        term = self.terminals.get(term_id)
        if term is None or term.closed:
            self.terminals[term_id] = Terminal(term_id, cwd, self.emit)
        return term_id

    def terminal(self, term_id: str) -> Terminal | None:
        term = self.terminals.get(term_id)
        return term if term is not None and not term.closed else None

    def close_terminal(self, term_id: str) -> bool:
        """The window closed a terminal: hang it up."""
        term = self.terminals.pop(term_id, None)
        if term is None:
            return False
        term.close()
        return True

    # ── keep awake ──

    @property
    def awake(self) -> bool:
        return self._awake is not None and self._awake.poll() is None

    def set_awake(self, on: bool) -> bool:
        if on and not self.awake:
            # -w: it ends with this process too, however the app goes.
            self._awake = subprocess.Popen(["caffeinate", "-dimsu", "-w", str(os.getpid())])  # noqa: S607
        elif not on and self.awake:
            self._awake.terminate()
            with contextlib.suppress(Exception):
                self._awake.wait(timeout=2)
            self._awake = None
        return self.awake

    # ── iOS Simulator ──

    async def simulators(self) -> list[dict[str, Any]]:
        out = await _run("xcrun", "simctl", "list", "devices", "-j", timeout=20)
        try:
            data = json.loads(out or "{}")
        except ValueError:
            return []
        devices = []
        for runtime, items in (data.get("devices") or {}).items():
            name, _, version = runtime.rsplit(".", 1)[-1].partition("-")  # iOS-27-0
            os_name = f"{name} {version.replace('-', '.')}".strip()
            for d in items:
                if d.get("isAvailable") and (
                    "iPhone" in d.get("name", "") or "iPad" in d.get("name", "")
                ):
                    devices.append(
                        {
                            "udid": d["udid"],
                            "name": d["name"],
                            "state": d.get("state", ""),
                            "os": os_name,
                        }
                    )
        devices.sort(key=lambda d: (d["state"] != "Booted", d["name"]))
        return devices[:30]

    async def boot(self, udid: str) -> None:
        await _run("xcrun", "simctl", "boot", udid, timeout=120)
        await _run("open", "-a", "Simulator", timeout=20)

    async def screenshot(self, udid: str) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sim.jpg"
            await _run(
                "xcrun", "simctl", "io", udid, "screenshot", "--type=jpeg", str(path), timeout=20
            )
            if not path.exists():
                return ""
            return base64.b64encode(path.read_bytes()).decode()

    def watch_simulator(self, udid: str | None) -> None:
        """Stream the simulator's screen (about one picture a second) while a window
        watches; None stops."""
        if self._sim_task is not None:
            self._sim_task.cancel()
            self._sim_task = None
        if udid:
            self._sim_task = asyncio.create_task(self._sim_loop(udid))

    async def _sim_loop(self, udid: str) -> None:
        # Never forever: a window that went away without saying so stops getting pictures.
        until = asyncio.get_running_loop().time() + SIM_WATCH_SECONDS
        while asyncio.get_running_loop().time() < until:
            frame = await self.screenshot(udid)
            if frame:
                self.emit("sim_frame", udid=udid, jpeg=frame)
            await asyncio.sleep(1.0)
        self.emit("sim_watch_ended", udid=udid)

    # ── files ──

    @staticmethod
    def read_file(root: Path, rel: str) -> dict[str, Any]:
        """A project file for the viewer: inside the project, not a credential or private
        folder (by its own name or the one a link points to), text only, and never more
        than 300 KB read, however big the file."""
        path = (root / rel).resolve()
        if root.resolve() not in path.parents:
            return {"path": rel, "error": "That's outside the project."}
        if computer.is_sensitive(path) or computer.is_sensitive(root / rel):
            return {"path": rel, "error": "That file holds credentials or private data."}
        if not path.is_file():
            return {"path": rel, "error": "Not a file."}
        try:
            with path.open("rb") as f:
                raw = f.read(MAX_FILE_BYTES + 1)
        except OSError as exc:
            return {"path": rel, "error": f"Couldn't read it: {exc.strerror or exc}"}
        truncated, raw = len(raw) > MAX_FILE_BYTES, raw[:MAX_FILE_BYTES]
        if b"\x00" in raw[:4000]:
            return {"path": rel, "error": "That's a binary file."}
        return {"path": rel, "text": raw.decode("utf-8", errors="replace"), "truncated": truncated}

    def close(self) -> None:
        for term in self.terminals.values():
            term.close()
        self.set_awake(False)
        self.watch_simulator(None)


async def _run(*args: str, timeout: float = 30) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except OSError:
        return ""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return ""
    return out.decode(errors="replace")
