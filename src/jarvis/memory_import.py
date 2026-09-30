"""Bringing memories in from elsewhere, always shown for review before anything is saved:

- a ChatGPT data export (the .zip, or a .json from it): its saved memories and custom
  instructions ("what should ChatGPT know about you" and "how should it respond", which
  become About me and How Jarvis should behave) when the export has them. Only files named
  for them are opened, each at most a few megabytes; conversations are never read.
- Claude Code's user memory file (~/.claude/CLAUDE.md): read only when the owner clicks
  for it, never changed.
- a pasted list: a line (or a bullet, or a sentence) each.

The owner picks the file in the window; only an ordinary file in their home folder, of a
kind this reads, is opened. Nothing here calls a model or saves anything: the review holds
candidates, and the owner chooses which to keep (memory.add_many does the saving, with
provenance "import" and what it came from).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import about_me, memory
from .textclean import clean_text

log = logging.getLogger("jarvis")

CLAUDE_MD = Path.home() / ".claude" / "CLAUDE.md"
MAX_ITEMS = 200
MAX_JSON = 5 * 1024 * 1024  # one JSON file read
MAX_TEXT_FILE = 1024 * 1024
MAX_ZIP_READ = 20 * 1024 * 1024  # of all the files read from one export
MAX_MEMBERS = 20
MIN_CHARS = 8
SUFFIXES = (".zip", ".json", ".txt", ".md", ".markdown")
# Files in an export that may hold memories or custom instructions (never conversations).
_WANTED_MEMBER = re.compile(
    r"(?:memor|personali[sz]|custom[_ -]?instruction|user[_ -]?(?:settings|profile|data|context)"
    r"|about[_ -]?(?:me|user))[^/]*\.json$",
    re.IGNORECASE,
)
_MEMORY_KEY = re.compile(r"memor", re.IGNORECASE)
_TEXT_KEYS = ("content", "text", "memory", "value", "fact", "body")
_ABOUT_KEYS = (
    "about_user_message",
    "about_user",
    "aboutUser",
    "user_profile",
    "user_bio",
    "about_me",
)
_BEHAVE_KEYS = (
    "about_model_message",
    "about_model",
    "aboutModel",
    "model_instructions",
    "response_style",
    "traits_model_message",
)
_BULLET = re.compile(r"^\s*(?:[-*•+]|\d+[.)])\s+")
_SENTENCE = re.compile(r"(?<=[.!?。！？])\s+")


class NotImportable(ValueError):
    """Why a file can't be imported, in words the window shows."""


@dataclass
class Review:
    kind: str  # chatgpt | claude | paste
    origin: str  # what a kept fact's provenance names
    items: list[dict[str, str]] = field(default_factory=list)  # {id, text, category}
    about: str = ""
    behave: str = ""
    notes: list[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    def public(self) -> dict[str, Any]:
        """As the window gets it (source: the kind; hub.emit's own first argument is kind)."""
        return {
            "id": self.id,
            "source": self.kind,
            "origin": self.origin,
            "items": self.items,
            "about": self.about,
            "behave": self.behave,
            "notes": self.notes,
        }


def _candidate(text: Any) -> str:
    text = " ".join(clean_text(text or "").split())
    text = _BULLET.sub("", text).strip(" \"'“”")
    if len(text) < MIN_CHARS or not re.search(r"\w{2}", text):
        return ""
    return text[: memory.MAX_FACT_CHARS]


def _add(review: Review, texts: list[str]) -> None:
    seen = {memory.signature_of(i["text"]) for i in review.items}
    skipped = 0
    for raw in texts:
        text = _candidate(raw)
        if not text:
            continue
        if memory._SECRET.search(text):
            skipped += 1
            continue
        key = memory.signature_of(text)
        if key in seen:
            continue
        if len(review.items) >= MAX_ITEMS:
            review.notes.append(f"Only the first {MAX_ITEMS} are shown.")
            break
        seen.add(key)
        review.items.append(
            {"id": uuid.uuid4().hex[:8], "text": text, "category": memory.guess_category(text)}
        )
    if skipped:
        were = "was" if skipped == 1 else "were"
        review.notes.append(
            f"{skipped} that looked like a password, key or account number {were} left out."
        )


def split_lines(text: str) -> list[str]:
    """A pasted list or a Markdown file as candidates: a line or bullet each; a paragraph
    of several sentences, a sentence each. Headings, code, tables and comments aside."""
    out: list[str] = []
    fenced = False
    text = re.sub(r"<!--.*?-->", "", text or "", flags=re.S)
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced or not stripped or stripped.startswith(("#", "|", ">", "<")):
            continue
        body = _BULLET.sub("", stripped)
        if len(body) > memory.MAX_FACT_CHARS or (
            not _BULLET.match(stripped) and _SENTENCE.search(body)
        ):
            out += [s for s in _SENTENCE.split(body) if s.strip()]
        else:
            out.append(body)
    return out


def from_text(text: str) -> Review:
    review = Review("paste", "a pasted list")
    _add(review, split_lines(text[:MAX_TEXT_FILE]))
    if not review.items:
        review.notes.append("Nothing in it read like a fact to keep.")
    return review


def from_claude_md(path: Path | None = None) -> Review:
    """Claude Code's user memory file, read (never changed)."""
    path = path or CLAUDE_MD
    review = Review("claude", "Jarvis Code's memory file (~/.claude/CLAUDE.md)")
    try:
        with path.open("rb") as handle:
            text = handle.read(MAX_TEXT_FILE).decode("utf-8", "replace")
    except FileNotFoundError:
        raise NotImportable("There's no ~/.claude/CLAUDE.md on this Mac.") from None
    except OSError as exc:
        raise NotImportable(f"~/.claude/CLAUDE.md can't be read ({exc.strerror or exc}).") from None
    _add(review, split_lines(text))
    if not review.items:
        review.notes.append("Nothing in it read like a fact to keep.")
    return review


def checked_path(value: Any, home: Path | None = None) -> Path:
    """The file the owner picked: an ordinary file in their home folder, of a kind this
    reads. NotImportable says why not."""
    home = (home or Path.home()).resolve()
    try:
        path = Path(str(value or "")).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        raise NotImportable("That file can't be found.") from None
    if home not in path.parents:
        raise NotImportable("Choose a file in your home folder.")
    if path.suffix.lower() not in SUFFIXES:
        raise NotImportable("Choose the export's .zip, or a .json, .txt or .md file.")
    if not path.is_file():
        raise NotImportable("That file can't be found.")
    return path


def from_chatgpt(path: Path) -> Review:
    """A ChatGPT data export (its .zip) or a JSON file from one; a text file of memories
    copied from ChatGPT's settings works too."""
    review = Review("chatgpt", f"ChatGPT export ({path.name[:80]})")
    suffix = path.suffix.lower()
    if suffix == ".zip":
        _from_zip(path, review)
    elif suffix == ".json":
        if path.stat().st_size > MAX_JSON:
            raise NotImportable(
                "That JSON file is too big to be memories; choose the export's .zip."
            )
        _from_json(path.read_bytes(), review, _MEMORY_KEY.search(path.name) is not None)
    else:
        if path.stat().st_size > MAX_TEXT_FILE:
            raise NotImportable("That file is too big to be a list of memories.")
        review.kind = "chatgpt"
        _add(review, split_lines(path.read_text("utf-8", "replace")))
    if not review.items and not (review.about or review.behave):
        review.notes.append(
            "This export has no saved memories or custom instructions in it. In ChatGPT, "
            "Settings › Personalization › Manage memories lists them: copy them and paste "
            "them here instead."
        )
    return review


def _from_zip(path: Path, review: Review) -> None:
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise NotImportable(f"That isn't a zip file that can be opened ({exc}).") from None
    with archive:
        read = 0
        members = [
            info
            for info in archive.infolist()
            if not info.is_dir() and _WANTED_MEMBER.search(info.filename)
        ][:MAX_MEMBERS]
        for info in members:
            if info.file_size > MAX_JSON or read + info.file_size > MAX_ZIP_READ:
                review.notes.append(f"{Path(info.filename).name} was too big to read.")
                continue
            with archive.open(info) as handle:
                data = handle.read(MAX_JSON + 1)
            read += len(data)
            if len(data) > MAX_JSON:  # the directory said less than it holds
                review.notes.append(f"{Path(info.filename).name} was too big to read.")
                continue
            _from_json(data, review, _MEMORY_KEY.search(Path(info.filename).name) is not None)


def _from_json(data: bytes, review: Review, memory_file: bool = False) -> None:
    """A JSON file's memories and custom instructions. In a file named for memories, a
    plain list of strings is its memories."""
    try:
        value = json.loads(data.decode("utf-8", "replace"))
    except ValueError:
        review.notes.append("One of its files isn't JSON that can be read; it was skipped.")
        return
    texts: list[str] = []
    _walk(value, texts, review, under_memory=memory_file and isinstance(value, list), depth=0)
    _add(review, texts)


def _walk(value: Any, texts: list[str], review: Review, *, under_memory: bool, depth: int) -> None:
    """Memories are strings (or objects with a text in them) in a list under a key named
    for memory; custom instructions sit under their own keys. Bounded in depth and size."""
    if depth > 12 or len(texts) > MAX_ITEMS * 2:
        return
    if isinstance(value, dict):
        for key, item in list(value.items())[:2000]:
            name = str(key)
            if isinstance(item, str):
                if name in _ABOUT_KEYS and not review.about:
                    review.about = about_me.tidy(item)
                    continue
                if name in _BEHAVE_KEYS and not review.behave:
                    review.behave = about_me.tidy(item)
                    continue
                if under_memory and name in _TEXT_KEYS:
                    texts.append(item)
                continue
            _walk(
                item,
                texts,
                review,
                under_memory=under_memory or bool(_MEMORY_KEY.search(name)),
                depth=depth + 1,
            )
    elif isinstance(value, list):
        for item in value[:2000]:
            if isinstance(item, str):
                if under_memory:
                    texts.append(item)
            else:
                _walk(item, texts, review, under_memory=under_memory, depth=depth + 1)
