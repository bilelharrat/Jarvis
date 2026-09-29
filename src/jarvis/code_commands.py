"""The slash commands a Jarvis Code session knows beyond Jarvis's own, for the composer's
palette as in Claude Code: the project's and the user's custom commands
(.claude/commands/*.md) and skills (.claude/skills/<name>/SKILL.md). Typed, they go to the
session as they are, and Claude Code expands them itself; this only lists them."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

MAX_ITEMS = 200
MAX_READ = 16_000  # bytes of a command file read for its description
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}")


def _front_matter(text: str) -> dict[str, str]:
    """The simple key: value lines of a leading --- block."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        key, sep, value = line.partition(":")
        if sep and re.fullmatch(r"[\w-]+", key.strip()):
            out[key.strip().lower()] = value.strip().strip("\"'")
    return out


def _body_after_front(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            return text[end + 4 :]
    return text


def _describe(text: str) -> str:
    front = _front_matter(text)
    if front.get("description"):
        return front["description"][:120]
    for line in _body_after_front(text).splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line[:120]
    return ""


def _read(path: Path) -> str:
    try:
        with path.open("rb") as f:
            return f.read(MAX_READ).decode("utf-8", errors="replace")
    except OSError:
        return ""


def _inside(path: Path, root: Path) -> bool:
    """No following a link out of the folder the commands live in."""
    try:
        real = path.resolve()
        return real == root.resolve() or root.resolve() in real.parents
    except OSError:
        return False


def catalog(project: Path, home: Path | None = None) -> list[dict[str, Any]]:
    """[{name, help, scope}] for the palette: custom commands, then skills; the project's
    before the user's, and the first of a name wins, as in Claude Code."""
    home = home or Path.home()
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(name: str, help_text: str, scope: str) -> None:
        if len(items) < MAX_ITEMS and NAME.fullmatch(name) and name.lower() not in seen:
            seen.add(name.lower())
            items.append({"name": name, "help": help_text, "scope": scope})

    for scope, root in (
        ("project", project / ".claude" / "commands"),
        ("user", home / ".claude" / "commands"),
    ):
        if not root.is_dir():
            continue
        for md in sorted(root.rglob("*.md"))[: MAX_ITEMS * 2]:
            if _inside(md, root):
                add(md.stem, _describe(_read(md)), scope)
    for scope, root in (
        ("project skill", project / ".claude" / "skills"),
        ("skill", home / ".claude" / "skills"),
    ):
        if not root.is_dir():
            continue
        for skill in sorted(root.glob("*/SKILL.md"))[:MAX_ITEMS]:
            if not _inside(skill, root):
                continue
            text = _read(skill)
            front = _front_matter(text)
            if front.get("user-invocable", "").lower() == "false":
                continue  # a skill only Claude reaches for
            add(front.get("name") or skill.parent.name, _describe(text), scope)
    return items
