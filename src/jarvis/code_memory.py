"""Eden Code's memory files: the CLAUDE.md files Claude Code reads at the start of a
session.

- project: CLAUDE.md in the project's folder, shared with whoever works on it;
- local: CLAUDE.local.md there, just the owner's, for this project;
- user: ~/.claude/CLAUDE.md, the owner's, for every project.

"# note" in the composer adds a line to the one the owner picks; the Files pane edits any
of them (code_editor), saved only over the version they were edited from.

AGENTS.md is the same kind of file for the other coding agents (Codex, Gemini, OpenCode
and the rest read it the way Claude Code reads CLAUDE.md). What Eden itself writes into a
project (a "# note" for the project, the lessons learned from the owner's corrections in
that project) goes into one section of each file, Eden's own, between the EDEN_BEGIN and
EDEN_END lines, kept the same in both: so a session with any agent starts from the same
notes. Nothing outside that section is ever touched (the owner's own CLAUDE.md, a team's
AGENTS.md), a file that's a link to somewhere else is never written through (a CLAUDE.md
that links to the project's own AGENTS.md, a common way to keep one file, is written once,
as that AGENTS.md), and when the two sections differ (the owner edited one), the one edited
last is the one both get.

Nothing here calls a model.
"""

from __future__ import annotations

import contextlib
import os
import re
from pathlib import Path
from typing import Any

TARGETS = ("project", "local", "user")
NOTE_MAX = 500  # characters of a "#" note
SHOWN = {"project": "CLAUDE.md", "local": "CLAUDE.local.md", "user": "~/.claude/CLAUDE.md"}

AGENTS = "AGENTS.md"  # what Codex, Gemini, OpenCode and the other agents read
SHARED = ("CLAUDE.md", AGENTS)  # the project's two files Eden's section is kept the same in
EDEN_BEGIN = "<!-- eden:begin (Eden keeps this section the same in CLAUDE.md and AGENTS.md) -->"
EDEN_END = "<!-- eden:end -->"
NOTES_HEAD = "### Project notes"
LESSONS_HEAD = "### Lessons from the owner's corrections"
NOTES_KEPT = 100  # notes in Eden's section, the newest
LESSONS_KEPT = 50
_SECTION = re.compile(r"<!-- eden:begin\b[^\n]*-->\n?(.*?)<!-- eden:end -->\n?", re.DOTALL)


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


# ── Eden's own section of CLAUDE.md and AGENTS.md ──


def _text_of(path: Path) -> str | None:
    """A memory file's text (bytes that aren't UTF-8 kept as they are), None when there's
    none, it's a link, or it can't be read."""
    if path.is_symlink() or not path.is_file():
        return None
    try:
        return path.read_bytes().decode("utf-8", "surrogateescape")
    except OSError:
        return None


def section_of(text: str | None) -> tuple[list[str], list[str]] | None:
    """(the notes, the lessons) in Eden's section of a file's text; None when it has none."""
    found = _SECTION.search(text or "")
    if found is None:
        return None
    notes: list[str] = []
    lessons: list[str] = []
    into = notes
    for line in found.group(1).splitlines():
        line = line.strip()
        if line.startswith("### "):
            into = lessons if line == LESSONS_HEAD else notes
        elif line.startswith("- ") and line[2:].strip():
            into.append(line[2:].strip())
    return notes, lessons


def render_section(notes: list[str], lessons: list[str]) -> str:
    """Eden's section as it's written: its two lists, under their headings, between the
    markers (a list with nothing in it is left out)."""
    out = [EDEN_BEGIN, "## Notes from Eden", ""]
    for head, items in ((NOTES_HEAD, notes), (LESSONS_HEAD, lessons)):
        if items:
            out += [head, *(f"- {item}" for item in items), ""]
    return "\n".join(out) + EDEN_END + "\n"


def _put_section(path: Path, block: str) -> None:
    """Eden's section into a file, in place of the one there, else at its end (the file
    made when it isn't there); everything else in it as it was. Written whole (a file
    beside it, then renamed over it), never through a link. Raises OSError."""
    if path.is_symlink():
        raise PermissionError(f"{path.name} is a link")
    text = _text_of(path) or ""
    found = _SECTION.search(text)
    if found is not None:
        text = text[: found.start()] + block + text[found.end() :]
    else:
        lead = "" if not text else "\n" if text.endswith("\n") else "\n\n"
        text = text + lead + block
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    tmp = path.with_name(f".{path.name}.eden-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(tmp, flags, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(text.encode("utf-8", "surrogateescape"))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def _shared_files(folder: Path) -> list[Path]:
    """The project's CLAUDE.md and AGENTS.md as Eden writes them: a link between the two
    (CLAUDE.md -> AGENTS.md) is one file, written as the one it links to; a link to
    anywhere else is left alone."""
    out: list[Path] = []
    for name in SHARED:
        path = folder / name
        if path.is_symlink():
            with contextlib.suppress(OSError):
                target = path.resolve()
                if target.parent == folder.resolve() and target.name in SHARED:
                    continue  # (the other one, which is in the list itself)
            continue  # a link elsewhere: never written through
        out.append(path)
    return out


def write_shared(
    folder: Path | str, note: str = "", lessons: list[str] | None = None
) -> list[Path]:
    """Eden's section of the project's CLAUDE.md and AGENTS.md, the same in both: what it
    held (the file edited last, when the two differ), with this note added and these
    lessons in place of its own (None: kept as they are). The files written; none when
    there's nothing to write. Raises OSError when neither can be."""
    folder = Path(folder)
    files = _shared_files(folder)
    held = [(p, section_of(_text_of(p))) for p in files]
    held = [(p, s) for p, s in held if s is not None]
    if held:
        newest = max(held, key=lambda ps: ps[0].stat().st_mtime_ns)[1]
        notes, kept = list(newest[0]), list(newest[1])
    else:
        notes, kept = [], []
    note = clean_note(note)
    if note and note.lower() not in (n.lower() for n in notes):
        notes.append(note)
    if lessons is not None:
        kept = [clean_note(x) for x in lessons if clean_note(x)]
    if not held and not notes and not kept:
        return []
    block = render_section(notes[-NOTES_KEPT:], kept[-LESSONS_KEPT:])
    written: list[Path] = []
    problem: OSError | None = None
    for path in files:
        current = _text_of(path)
        if current is not None and block in current:
            written.append(path)  # (the same already: left as it is, its time too)
            continue
        try:
            _put_section(path, block)
        except OSError as exc:
            problem = exc
            continue
        written.append(path)
    if not written:
        raise problem or PermissionError("neither CLAUDE.md nor AGENTS.md can be written")
    return written


def sync_shared(folder: Path | str) -> bool:
    """Eden's section brought into step in both files when only one has it, or they
    differ; nothing when neither has one. True when something was written."""
    folder = Path(folder)
    sections = [section_of(_text_of(p)) for p in _shared_files(folder)]
    if not any(s is not None for s in sections) or len(set(map(repr, sections))) == 1:
        return False
    try:
        return bool(write_shared(folder))
    except OSError:
        return False


def project_notes(folder: Path | str, chars: int) -> tuple[str, str]:
    """(the file's name, its text, at most chars) of the project's notes for an agent:
    its AGENTS.md, else its CLAUDE.md; ("", "") when it has neither."""
    folder = Path(folder)
    for name in (AGENTS, "CLAUDE.md"):
        path = folder / name
        try:
            if path.is_symlink() and path.resolve().parent != folder.resolve():
                continue  # (a link out of the project: not its notes)
            text = path.read_text(errors="replace") if path.is_file() else ""
        except OSError:
            continue
        if text.strip():
            if len(text) > chars:
                text = text[:chars] + "\n[… the rest of the file is left out]"
            return name, text.strip()
    return "", ""
