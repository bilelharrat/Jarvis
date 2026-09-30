"""Jarvis Code's terminals and "!" commands, on pseudo-terminals.

Terminals (Shells):
- Several per project: each is its own login shell on a pseudo-terminal (the workbench's
  Terminal), in tabs and splits in the window.
- Closing the pane only detaches: the shells and their jobs go on, and each keeps its
  recent output (SCROLLBACK bytes), so a window that opens the pane again, or reloads,
  gets it back. Closing a terminal's tab hangs it up (after asking, when something is
  running in it); quitting the app hangs them all up (they're the workbench's too).
- A terminal's last lines as plain text (escape codes out, progress bars settled), for an
  @terminal mention.

"!" commands (BangRun): the composer's "!npm test" runs on a pseudo-terminal of its own in
the owner's login shell, its output streaming to the window as it comes, with no time
limit and a Cancel (interrupt, then terminate, then kill). The window gets at most
STREAM_CHUNK characters every STREAM_EVERY seconds (the newest, when a command prints
faster than that), and only the last KEEP bytes are kept, for what goes to Claude with the
next message.

Nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import pty
import re
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .packaged import owner_env
from .workbench import _WITH_TERMINAL, Terminal, _hang_up

Emit = Callable[..., None]
SCROLLBACK = 512 * 1024  # bytes of a terminal's output kept for a window that comes back
SHELLS_MAX = 12  # terminals at once, all projects together
LINES_MAX = 200  # lines an @terminal mention carries
TEXT_MAX = 16_000  # characters, at most
KEEP = 256 * 1024  # bytes of a "!" command's output kept
STREAM_EVERY = 0.1  # seconds between a "!" command's messages to the window
STREAM_CHUNK = 32_000  # characters one message carries, at most
CANCEL_STEPS = (3.0, 3.0)  # seconds after interrupting, then terminating, before a kill

# Escape sequences (colours, cursor moves, titles) and the controls a transcript can't show.
_ESCAPES = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"  # CSI: colours, cursor, erase
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?"  # OSC: the window's title, links
    r"|\x1b[PX^_][^\x1b]*(?:\x1b\\)?"  # DCS and the like
    r"|\x1b[@-Z\\-_()*+#%=>78]"  # the rest of the two-character ones
)
_CONTROLS = re.compile(r"[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]")


def plain_text(raw: str) -> str:
    """Terminal output as the lines a person saw: escape codes out, a line rewritten with
    \\r (a progress bar) as it ended up, backspaces applied."""
    text = _ESCAPES.sub("", raw).replace("\r\n", "\n")
    lines = []
    for line in text.split("\n"):
        if "\r" in line:
            parts = [p for p in line.split("\r") if p]
            line = parts[-1] if parts else ""
        while "\b" in line:
            at = line.index("\b")
            line = line[: max(0, at - 1)] + line[at + 1 :]
        lines.append(_CONTROLS.sub("", line))
    return "\n".join(lines)


def shown_part(text: str) -> tuple[str, str]:
    """(what can be shown now, escape codes out; the start of an escape code the next
    read finishes, held back)."""
    at = text.rfind("\x1b", max(0, len(text) - 512))
    held = ""
    if at >= 0:
        m = _ESCAPES.match(text, at)
        seq = m.group(0) if m else ""
        # A title or link (OSC) runs to its terminator, which may come in the next read.
        unended = seq[1:2] in ("]", "P", "X", "^", "_") and not seq.endswith(("\x07", "\x1b\\"))
        if m is None or (unended and m.end() == len(text)):
            text, held = text[:at], text[at:]
    return _CONTROLS.sub("", _ESCAPES.sub("", text)), held


def last_lines(text: str, lines: int = LINES_MAX, chars: int = TEXT_MAX) -> str:
    kept = text.rstrip("\n").split("\n")[-lines:]
    out = "\n".join(line.rstrip() for line in kept).strip("\n")
    return out[-chars:]


# ── terminals ──


@dataclass
class Shell:
    id: str
    cwd: Path
    title: str
    term: Terminal
    created: float = field(default_factory=time.time)
    scrollback: bytearray = field(default_factory=bytearray)
    exited: bool = False
    printed_at: float = 0.0  # when it last printed (monotonic): the one @terminal means

    def keep(self, data: bytes) -> None:
        self.printed_at = time.monotonic()
        self.scrollback += data
        over = len(self.scrollback) - SCROLLBACK
        if over > 0:
            # From a line's start, so what comes back doesn't open mid escape code.
            cut = self.scrollback.find(b"\n", over)
            del self.scrollback[: cut + 1 if 0 <= cut < over + 4096 else over]

    def busy(self) -> str:
        """What's running in it now (a job the shell started), or ""."""
        import psutil

        with contextlib.suppress(Exception):
            children = psutil.Process(self.term.proc.pid).children()
            if children:
                return " ".join(children[0].cmdline()[:4])[:120] or children[0].name()
        return ""

    def text(self) -> str:
        return last_lines(plain_text(bytes(self.scrollback).decode("utf-8", errors="replace")))

    def info(self) -> dict[str, Any]:
        return {
            "term": self.id,
            "title": self.title,
            "cwd": str(self.cwd),
            "folder": self.cwd.name,
            "alive": not self.exited,
            "created": self.created,
        }


class Shells:
    """The terminals, by id (t1, t2…). Registered with the workbench too, so the app's
    quit hangs them up with its own."""

    def __init__(self, emit: Emit, workbench: Any = None) -> None:
        self.emit = emit
        self.workbench = workbench
        self.items: dict[str, Shell] = {}
        self._n = 0

    def of(self, cwd: Path) -> list[Shell]:
        cwd = Path(cwd)
        return [s for s in self.items.values() if s.cwd == cwd]

    def open(self, cwd: Path, title: str = "") -> Shell:
        """A new terminal in a folder. Raises ValueError when there are too many."""
        if len([s for s in self.items.values() if not s.exited]) >= SHELLS_MAX:
            raise ValueError("That's the most terminals at once: close one first.")
        self._n += 1
        term_id = f"t{self._n}"
        shell_name = Path(os.environ.get("SHELL") or "/bin/zsh").name
        taken = {s.title for s in self.of(cwd)}
        n = 1
        while f"{shell_name} {n}" in taken:
            n += 1
        holder: dict[str, Shell] = {}
        term = Terminal(term_id, Path(cwd), lambda kind, **data: self._heard(holder, kind, data))
        shell = holder["shell"] = Shell(term_id, Path(cwd), title or f"{shell_name} {n}", term)
        self.items[term_id] = shell
        if self.workbench is not None:
            self.workbench.terminals[f"cw:{term_id}"] = term
        return shell

    def _heard(self, holder: dict[str, Shell], kind: str, data: dict[str, Any]) -> None:
        shell = holder.get("shell")
        if shell is None:
            return
        if kind == "term_data":
            shell.keep(base64.b64decode(data["data"]))
            self.emit("cw_term_data", term=shell.id, data=data["data"])
        elif kind == "term_exit":
            shell.exited = True
            self.emit("cw_term_exit", term=shell.id)

    def get(self, term_id: str) -> Shell | None:
        return self.items.get(str(term_id))

    def latest(self, cwd: Path) -> Shell | None:
        """The folder's terminal that printed most lately (the one "@terminal" means)."""
        shells = self.of(cwd)
        return max(shells, key=lambda s: (s.printed_at, s.created), default=None)

    def close(self, term_id: str) -> bool:
        shell = self.items.pop(str(term_id), None)
        if shell is None:
            return False
        if self.workbench is not None:
            self.workbench.terminals.pop(f"cw:{shell.id}", None)
        shell.term.close()
        return True

    def close_all(self) -> None:
        for term_id in list(self.items):
            self.close(term_id)


# ── "!" commands ──


class BangRun:
    """One "!" command, on a pseudo-terminal of its own. start(), then await done."""

    def __init__(self, ref: str, command: str, cwd: Path, emit: Emit) -> None:
        self.ref, self.command, self.cwd, self.emit = ref, command, Path(cwd), emit
        self.kept = bytearray()  # the last KEEP bytes it printed
        self.unsent = ""  # printed, for the window, not sent yet
        self.skipped = 0  # characters the window never got (printed faster than it's sent)
        self.cancelled = False
        self.code: int | None = None
        self.proc: subprocess.Popen | None = None
        self.master = -1
        self.loop = asyncio.get_running_loop()
        self.done = self.loop.create_future()
        self._flush_at: asyncio.TimerHandle | None = None
        self._decoder = _Utf8()
        self._started = 0.0

    def start(self) -> None:
        """Start it (raises OSError when it can't)."""
        master, slave = pty.openpty()
        shell = os.environ.get("SHELL") or "/bin/zsh"
        env = {**owner_env(os.environ), "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        try:
            self.proc = subprocess.Popen(  # noqa: S603 - the owner's own command, typed as "!…"
                [sys.executable, "-I", "-S", "-c", _WITH_TERMINAL, shell, "-lc", self.command],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=str(self.cwd),
                env=env,
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        self.master = master
        self._started = time.monotonic()
        os.set_blocking(master, False)
        self.loop.add_reader(master, self._readable)

    def _readable(self) -> None:
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: everything on its terminal is gone
            data = b""
        if not data:
            self.loop.remove_reader(self.master)
            with contextlib.suppress(OSError):
                os.close(self.master)
            self.master = -1
            self.loop.create_task(self._finish())
            return
        self.kept += data
        if len(self.kept) > KEEP:
            del self.kept[: len(self.kept) - KEEP]
        self.unsent += self._decoder.feed(data)
        if len(self.unsent) > STREAM_CHUNK * 4:  # far ahead of the window: the newest only
            self.skipped += len(self.unsent) - STREAM_CHUNK
            self.unsent = self.unsent[-STREAM_CHUNK:]
        if self._flush_at is None:
            self._flush_at = self.loop.call_later(STREAM_EVERY, self._flush)

    def _flush(self, final: bool = False) -> None:
        self._flush_at = None
        if not self.unsent:
            return
        chunk, self.unsent = self.unsent[:STREAM_CHUNK], self.unsent[STREAM_CHUNK:]
        if self.unsent:
            text, held = _CONTROLS.sub("", _ESCAPES.sub("", chunk)), ""
        else:
            text, held = shown_part(chunk) if not final else (shown_part(chunk + "\n")[0], "")
        self.unsent = held + self.unsent
        skipped, self.skipped = self.skipped, 0
        if text or skipped:
            self.emit("cw_bang_data", ref=self.ref, text=text, skipped=skipped)
        if self.unsent and (final or self.unsent != held):
            self._flush_at = self.loop.call_later(STREAM_EVERY, self._flush)

    async def _finish(self) -> None:
        proc = self.proc
        assert proc is not None
        # Its terminal closed; the shell may take a moment more to be reaped.
        code = await asyncio.to_thread(_wait, proc)
        if self._flush_at is not None:
            self._flush_at.cancel()
            self._flush_at = None
        self.unsent += self._decoder.feed(b"", final=True)
        while self.unsent:
            self._flush(final=True)
            if self._flush_at is not None:
                self._flush_at.cancel()
                self._flush_at = None
        self.code = 130 if self.cancelled and code in (None, -2, -15, -9, 130, 143) else code
        if not self.done.done():
            self.done.set_result(self.code)

    def output(self, limit: int) -> str:
        """What it printed, as text, its last `limit` characters."""
        text = plain_text(bytes(self.kept).decode("utf-8", errors="replace")).strip("\n")
        return text if len(text) <= limit else "…" + text[-limit:]

    async def cancel(self) -> None:
        """Interrupt it (as Ctrl-C would), then terminate, then kill what's left."""
        if self.proc is None or self.done.done():
            return
        self.cancelled = True
        group = self.proc.pid
        for sig, wait in ((signal.SIGINT, CANCEL_STEPS[0]), (signal.SIGTERM, CANCEL_STEPS[1])):
            with contextlib.suppress(OSError):
                os.killpg(group, sig)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(self.done), wait)
                return
        with contextlib.suppress(OSError):
            os.killpg(group, signal.SIGKILL)
        if self.master >= 0:  # the terminal still held open by something: let go of it
            with contextlib.suppress(Exception):
                self.loop.remove_reader(self.master)
            with contextlib.suppress(OSError):
                os.close(self.master)
            self.master = -1
            self.loop.create_task(self._finish())

    def kill(self) -> None:
        """The app is quitting: everything it started, now."""
        if self.proc is not None and self.proc.poll() is None:
            _hang_up(self.proc)
            with contextlib.suppress(OSError):
                os.killpg(self.proc.pid, signal.SIGKILL)

    @property
    def seconds(self) -> float:
        return round(time.monotonic() - self._started, 1) if self._started else 0.0


def _wait(proc: subprocess.Popen) -> int | None:
    try:
        return proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            return proc.wait(timeout=5)
    return None


class _Utf8:
    """Bytes to text across reads: a character split between two reads isn't mangled."""

    def __init__(self) -> None:
        import codecs

        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def feed(self, data: bytes, final: bool = False) -> str:
        return self._decoder.decode(data, final)
