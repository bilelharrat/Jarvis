"""Teaching helpers' reading and writing (features/teaching.py has the tools): a folder of student
submissions with the rubric they are marked against, a lecture's words for a quiz, and the
documents that come of them in Documents › Jarvis › Teaching.

- Submissions: every document in the folder (Word, PDF, PowerPoint, OpenDocument, RTF, text,
  Markdown), and one level of subfolders, a subfolder being one student's. The student's name
  comes from the subfolder, or from the file name as Moodle, Canvas and Blackboard write it when
  they hand back a whole assignment ("Ann Lee_1234_assignsubmission_file_essay.docx").
- Nothing in a private folder is read (private_folders.py), and nothing here sends anything:
  what is written goes in a document on this computer and nowhere else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import documents, docx_write, osplat, private_folders
from .knowledge import DOC_SUFFIXES, read_document

READABLE = DOC_SUFFIXES | {".pptx", ".odt"}
EACH_CHARS = 20_000  # of one submission given at once
BATCH_CHARS = 60_000  # of submissions given in one answer (the rest: start)
RUBRIC_CHARS = 20_000
LECTURE_CHUNK = 30_000
MAX_FILES = 400
SKIP = {"__macosx", ".ds_store", "thumbs.db", "desktop.ini"}

MOODLE = re.compile(r"^(?P<name>.+?)_\d+_assign(?:submission|feedback)_\w+", re.IGNORECASE)
BLACKBOARD = re.compile(r"^.+?_(?P<name>[^_]+)_attempt_\d{4}-\d\d-\d\d", re.IGNORECASE)
CANVAS = re.compile(r"^(?P<name>[a-z][a-z-]+)(?:_late)?_\d{3,}_", re.IGNORECASE)


def folder() -> Path:
    """Documents › Jarvis › Teaching: where what the teaching tools write goes."""
    return osplat.personal_folders()[0] / "Jarvis" / "Teaching"


def student_of(path: Path, top: Path) -> str:
    """Whose a submission is: its subfolder's name, or the name in an LMS's file name, or the
    file's own name."""
    if path.parent != top:
        return path.relative_to(top).parts[0]
    stem = path.stem
    for pattern in (MOODLE, BLACKBOARD, CANVAS):
        if m := pattern.match(stem):
            return m.group("name").replace("_", " ").strip()
    return stem


def read_text(path: Path, limit: int = EACH_CHARS * 2) -> str:
    """A document's words ("" when it has none to read). PrivateError for a private folder's."""
    private_folders.check(path)
    if path.suffix.lower() in (".pptx", ".odt"):
        from .rich_text import text_of

        return text_of(path, limit)
    return read_document(path, limit, pages=200)


@dataclass
class Submission:
    student: str
    files: list[Path] = field(default_factory=list)
    text: str = ""
    problems: list[str] = field(default_factory=list)


def submissions(top: Path) -> tuple[list[Submission], list[str]]:
    """Every student's submission in a folder, by name; and the files that couldn't count (in
    words). PrivateError when the folder is private."""
    private_folders.check(top)
    found: dict[str, Submission] = {}
    skipped: list[str] = []
    paths: list[Path] = []
    for entry in sorted(top.iterdir(), key=lambda p: p.name.lower()):
        if entry.name.lower() in SKIP or entry.name.startswith((".", "~$")):
            continue
        if entry.is_dir() and not entry.is_symlink():
            paths += sorted(
                (p for p in entry.rglob("*") if p.is_file() and not p.name.startswith((".", "~$"))),
                key=lambda p: str(p).lower(),
            )
        elif entry.is_file():
            paths.append(entry)
    for path in paths[:MAX_FILES]:
        name = student_of(path, top)
        if private_folders.is_private(path):
            skipped.append(f"{path.name} is in a private folder")
            continue
        if path.suffix.lower() not in READABLE:
            skipped.append(f"{path.name} ({path.suffix.lstrip('.') or 'no'} files can't be read)")
            continue
        item = found.setdefault(name, Submission(name))
        item.files.append(path)
        text = read_text(path)
        if not text.strip():
            item.problems.append(f"{path.name} has no text to read (a scan or a picture?)")
            continue
        head = f"[{path.name}]\n" if len(item.files) > 1 or path.parent != top else ""
        item.text += ("\n\n" if item.text else "") + head + text.strip()
    if len(paths) > MAX_FILES:
        skipped.append(f"{len(paths) - MAX_FILES} more files (at most {MAX_FILES} are read)")
    return list(found.values()), skipped


def batch(items: list[Submission], start: int) -> tuple[list[str], int]:
    """The submissions from `start` that fit in one answer, each as a block; and where the next
    answer starts (len(items) when they all fit)."""
    blocks, size, index = [], 0, start
    for index in range(start, len(items)):
        s = items[index]
        text = s.text[:EACH_CHARS] + (
            f"\n[This submission goes on: {len(s.text) - EACH_CHARS} more characters left out.]"
            if len(s.text) > EACH_CHARS
            else ""
        )
        notes = "".join(f"\n[{p}]" for p in s.problems)
        block = (
            f'<submission number="{index + 1}" student="{s.student}" '
            f'files="{", ".join(f.name for f in s.files)}">\n{text or "(no text)"}{notes}\n</submission>'
        )
        if blocks and size + len(block) > BATCH_CHARS:
            return blocks, index
        blocks.append(block)
        size += len(block)
    return blocks, len(items)


def write(title: str, markdown: str, where: Path | None = None) -> Path:
    """A Word document in Documents › Jarvis › Teaching (never over another: "name 2" then)."""
    target = documents.claim(where or folder(), documents.file_stem(title), ".docx")
    try:
        docx_write.write_docx(target, markdown, title)
    except Exception:
        target.unlink(missing_ok=True)  # the empty name it claimed: nothing half-written stays
        raise
    return target
