"""The workbench terminal on Windows: a shell on a ConPTY (pywinpty), same shape as
workbench.Terminal (output in batches to the windows, keystrokes in, resize, hang up).

A thread reads the pseudo-terminal (pywinpty's reads block) and hands output to the event
loop. Closing ends the shell and everything it started (taskkill /T).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import threading
from collections.abc import Callable
from pathlib import Path

from . import osplat
from .packaged import owner_env

Emit = Callable[..., None]
OUTPUT_CHUNK = 64 * 1024
OUTPUT_EVERY = 0.03
INPUT_LIMIT = 8 * 1024 * 1024


class WinTerminal:
    def __init__(self, term_id: str, cwd: Path, emit: Emit, argv: list[str] | None = None) -> None:
        from winpty import PtyProcess  # pywinpty

        self.id, self.cwd, self.emit = term_id, cwd, emit
        self.loop = asyncio.get_running_loop()
        self.closed = False
        self._out = bytearray()
        self._lock = threading.Lock()
        self._flush_at: asyncio.TimerHandle | None = None
        self._sent_at = 0.0
        shell = argv or [osplat.default_shell()]
        env = {**owner_env(os.environ), "TERM": "xterm-256color"}
        self.proc = PtyProcess.spawn(shell, cwd=str(cwd), env=env, dimensions=(24, 80))
        threading.Thread(target=self._pump, name="jarvis-winterm", daemon=True).start()

    def _pump(self) -> None:
        while not self.closed:
            try:
                data = self.proc.read(65536)
            except EOFError:
                break
            except Exception:  # noqa: BLE001 - the pty is gone
                break
            if data:
                with self._lock:
                    self._out += data.encode("utf-8", "replace")
                self.loop.call_soon_threadsafe(self._schedule)
        self.loop.call_soon_threadsafe(self._ended)

    def _schedule(self) -> None:
        if self._flush_at is None and not self.closed:
            wait = max(0.0, self._sent_at + OUTPUT_EVERY - self.loop.time())
            self._flush_at = self.loop.call_later(wait, self._flush)

    def _flush(self, everything: bool = False) -> None:
        self._flush_at = None
        with self._lock:
            while self._out:
                chunk = bytes(self._out[:OUTPUT_CHUNK])
                del self._out[:OUTPUT_CHUNK]
                self._sent_at = self.loop.time()
                self.emit("term_data", term=self.id, data=base64.b64encode(chunk).decode())
                if not everything:
                    break
            more = bool(self._out)
        if more:
            self._flush_at = self.loop.call_later(OUTPUT_EVERY, self._flush)

    def _ended(self) -> None:
        if self.closed:
            return
        self._flush(everything=True)
        self.close()
        self.emit("term_exit", term=self.id)

    def write(self, text: str) -> None:
        if self.closed or len(text) > INPUT_LIMIT:
            return
        with contextlib.suppress(Exception):
            self.proc.write(text)

    def resize(self, cols: int, rows: int) -> None:
        if not self.closed and cols > 0 and rows > 0:
            with contextlib.suppress(Exception):
                self.proc.setwinsize(rows, cols)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self._flush_at is not None:
            self._flush_at.cancel()
        pid = getattr(self.proc, "pid", None)
        with contextlib.suppress(Exception):
            if pid:
                osplat.kill_group(pid, force=True)
            self.proc.close(force=True)
