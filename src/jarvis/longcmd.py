"""Claude Code on Windows: a command line short enough to start it.

Windows starts a program from one command line of at most 32,767 characters. JARVIS starts
Claude Code with its whole system prompt on that line (about 40,000 characters, with the
features' parts and what it remembers), so there it did not start at all: "The filename or
extension is too long", which the SDK reports as "Claude Code not found". The SDK builds the
line (SubprocessCLITransport._build_command); this keeps it short by moving what is long into
files that Claude Code is told to read (--system-prompt-file, --append-system-prompt-file, and
a path for --mcp-config and --settings, which take either), and only when the line would not
fit. A Mac has no such limit, and nothing here runs there.

The files hold what the owner has told JARVIS to remember, so they are in the app's own folder
under the user's profile, are removed when the app quits, and older ones are removed at start.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import osplat

log = logging.getLogger("jarvis")

LIMIT = 24_000  # the length of line aimed for: Windows stops at 32,767, quoting included
LONG = 1_000  # a value shorter than this is never worth a file
# A flag whose long value can be given as a file, and the flag that takes the file.
FILE_FLAGS = {
    "--system-prompt": "--system-prompt-file",
    "--append-system-prompt": "--append-system-prompt-file",
}
# Flags that take a file's path or the JSON itself.
JSON_FLAGS = ("--mcp-config", "--settings")
KEEP_SECONDS = 24 * 3600
_made: list[Path] = []


def folder() -> Path:
    path = osplat.app_support() / "cli-args"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _file(text: str, suffix: str, into: Path | None = None) -> Path:
    fd, name = tempfile.mkstemp(prefix="arg-", suffix=suffix, dir=into or folder())
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:  # (newlines as they are)
        handle.write(text)
    path = Path(name)
    _made.append(path)
    return path


def line_length(cmd: list[str]) -> int:
    """How long Windows finds the command line: the arguments quoted as Python quotes them."""
    return len(subprocess.list2cmdline(cmd))


def shorten(cmd: list[str], limit: int = LIMIT, into: Path | None = None) -> list[str]:
    """cmd, with its longest values moved into files until the line is no longer than limit.
    A line that is short enough comes back as it is."""
    if line_length(cmd) <= limit:
        return cmd
    out = list(cmd)
    long_ones = [
        i
        for i, flag in enumerate(out[:-1])
        if (flag in FILE_FLAGS or flag in JSON_FLAGS) and len(out[i + 1]) >= LONG
    ]
    for i in sorted(long_ones, key=lambda i: -len(out[i + 1])):  # (a swap keeps every index)
        if line_length(out) <= limit:
            break
        flag, value = out[i], out[i + 1]
        if flag in FILE_FLAGS:
            out[i], out[i + 1] = FILE_FLAGS[flag], str(_file(value, ".txt", into))
        else:
            out[i + 1] = str(_file(value, ".json", into))
    if line_length(out) > limit:
        log.warning("Claude Code's command line is still %d characters", line_length(out))
    return out


def prune(older_than: float = KEEP_SECONDS, into: Path | None = None) -> None:
    """Files of an earlier run of the app that were never removed."""
    with contextlib.suppress(OSError):
        for path in (into or folder()).glob("arg-*"):
            if time.time() - path.stat().st_mtime > older_than:
                path.unlink(missing_ok=True)


def cleanup() -> None:
    for path in _made:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)
    _made.clear()


def install() -> bool:
    """Make every Claude Code this process starts (the conversation, the sessions, the
    research) use files for what is too long. Windows only; True when it is in place."""
    if not osplat.IS_WIN:
        return False
    try:
        from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
    except ImportError:
        log.warning("the Claude SDK's transport is not where it was: long prompts will not start")
        return False
    if getattr(SubprocessCLITransport, "_jarvis_long_lines", False):
        return True
    original = getattr(SubprocessCLITransport, "_build_command", None)
    if original is None:
        log.warning("the Claude SDK builds its command differently: long prompts will not start")
        return False

    def build_command(self: Any) -> list[str]:
        return shorten(original(self))

    SubprocessCLITransport._build_command = build_command  # type: ignore[method-assign]
    SubprocessCLITransport._jarvis_long_lines = True  # type: ignore[attr-defined]
    prune()
    atexit.register(cleanup)
    return True
