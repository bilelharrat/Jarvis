"""Jarvis Code's memory files: the CLAUDE.md files Claude Code reads at the start of a
session.

- project: CLAUDE.md in the project's folder, shared with whoever works on it;
- local: CLAUDE.local.md there, just the owner's, for this project;
- user: ~/.claude/CLAUDE.md, the owner's, for every project.

"# note" in the composer adds a line to the one the owner picks; the Files pane edits any
of them (code_editor), saved only over the version they were edited from.

Nothing here calls a model.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

TARGETS = ("project", "local", "user")
NOTE_MAX = 500  # characters of a "#" note
SHOWN = {"project": "CLAUDE.md", "local": "CLAUDE.local.md", "user": "~/.claude/CLAUDE.md"}


def user_dir() -> Path:
    """Where Claude Code keeps the owner's own settings and memory: its config folder
    (CLAUDE_CONFIG_DIR when set, as Claude Code reads it), else ~/.claude. Read when asked,
    so a test gives it a folder of its own."""
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".claude"


def path_for(target: str, folder: Path | str) -> Path:
    if target == "user":
        return user_dir() / "CLAUDE.md"
    return Path(folder) / ("CLAUDE.local.md" if target == "local" else "CLAUDE.md")


def clean_note(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:NOTE_MAX]


def choices(folder: Path | str) -> list[dict[str, Any]]:
    """The memory files a note can go to, and whether each is there yet."""
    return [
        {"target": t, "path": SHOWN[t], "exists": path_for(t, folder).is_file()} for t in TARGETS
    ]


def append_note(path: Path, note: str) -> None:
    """ "- note" at the end of a memory file, on a line of its own; the file (and ~/.claude)
    made when it isn't there. Never through a link to somewhere else; a file that isn't
    UTF-8 gets the line all the same (bytes, not text). Raises OSError."""
    if path.is_symlink():
        raise PermissionError(f"{path.name} is a link")
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o644)
    with os.fdopen(fd, "rb+") as f:
        f.seek(0, os.SEEK_END)
        lead = b""
        if f.tell():
            f.seek(-1, os.SEEK_END)
            lead = b"" if f.read(1) == b"\n" else b"\n"
            f.seek(0, os.SEEK_END)
        f.write(lead + f"- {note}\n".encode())
