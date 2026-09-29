"""The Jarvis Code workbench: the panes beside a session, as in Claude Code's desktop app.

- Terminal: a real login shell in the project folder (a pseudo-terminal the window draws
  with xterm.js).
- iOS Simulator: which simulators are booted, and a live picture of the screen.
- Keep awake: macOS's own caffeinate, for as long as the switch is on.
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
import struct
import subprocess
import tempfile
import termios
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import computer

Emit = Callable[..., None]
MAX_FILE_BYTES = 300_000


class Terminal:
    """One shell on a pseudo-terminal. Output goes to the windows as it comes."""

    def __init__(self, term_id: str, cwd: Path, emit: Emit) -> None:
        self.id, self.cwd, self.emit = term_id, cwd, emit
        self.master, slave = pty.openpty()
        shell = os.environ.get("SHELL") or "/bin/zsh"
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        self.proc = subprocess.Popen(  # noqa: S603 - the user's own shell, in their project
            [shell, "-l"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=str(cwd),
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave)
        os.set_blocking(self.master, False)
        self.loop = asyncio.get_running_loop()
        self.loop.add_reader(self.master, self._readable)
        self.closed = False

    def _readable(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.close()
            self.emit("term_exit", term=self.id)
            return
        self.emit("term_data", term=self.id, data=base64.b64encode(data).decode())

    def write(self, text: str) -> None:
        if not self.closed:
            with contextlib.suppress(OSError):
                os.write(self.master, text.encode())

    def resize(self, cols: int, rows: int) -> None:
        if not self.closed and cols > 0 and rows > 0:
            with contextlib.suppress(OSError):
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib.suppress(Exception):
            self.loop.remove_reader(self.master)
        with contextlib.suppress(OSError):
            os.close(self.master)
        if self.proc.poll() is None:
            self.proc.terminate()


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

    # ── keep awake ──

    @property
    def awake(self) -> bool:
        return self._awake is not None and self._awake.poll() is None

    def set_awake(self, on: bool) -> bool:
        if on and not self.awake:
            self._awake = subprocess.Popen(["caffeinate", "-dimsu"])  # noqa: S607
        elif not on and self.awake:
            self._awake.terminate()
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
        while True:
            frame = await self.screenshot(udid)
            if frame:
                self.emit("sim_frame", udid=udid, jpeg=frame)
            await asyncio.sleep(1.0)

    # ── files ──

    @staticmethod
    def read_file(root: Path, rel: str) -> dict[str, Any]:
        """A project file for the viewer: inside the project, not a credential or private
        folder, text only, at most 300 KB."""
        path = (root / rel).resolve()
        if root.resolve() not in path.parents:
            return {"path": rel, "error": "That's outside the project."}
        if computer.is_sensitive(path):
            return {"path": rel, "error": "That file holds credentials or private data."}
        if not path.is_file():
            return {"path": rel, "error": "Not a file."}
        raw = path.read_bytes()[:MAX_FILE_BYTES]
        if b"\x00" in raw[:4000]:
            return {"path": rel, "error": "That's a binary file."}
        return {
            "path": rel,
            "text": raw.decode("utf-8", errors="replace"),
            "truncated": path.stat().st_size > MAX_FILE_BYTES,
        }

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
