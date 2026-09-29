"""The slash commands a Jarvis Code session knows beyond Jarvis's own, for the composer's
palette as in Claude Code: the project's and the user's custom commands
(.claude/commands/*.md) and skills (.claude/skills/<name>/SKILL.md). Typed, they go to the
session as they are, and Claude Code expands them itself; this only lists them. Also what
/agents and /hooks show: the subagents and hooks those settings set up."""

from __future__ import annotations

import json
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


def agents(project: Path, home: Path | None = None) -> list[dict[str, Any]]:
    """[{name, help, scope}] of the subagents Claude Code can hand work to, as its /agents
    lists them: the project's (.claude/agents/*.md) before the user's, first of a name."""
    home = home or Path.home()
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for scope, root in (
        ("project", project / ".claude" / "agents"),
        ("user", home / ".claude" / "agents"),
    ):
        if not root.is_dir():
            continue
        for md in sorted(root.rglob("*.md"))[: MAX_ITEMS * 2]:
            if not _inside(md, root) or len(items) >= MAX_ITEMS:
                continue
            text = _read(md)
            name = _front_matter(text).get("name") or md.stem
            if NAME.fullmatch(name) and name.lower() not in seen:
                seen.add(name.lower())
                items.append({"name": name, "help": _describe(text), "scope": scope})
    return items


def hooks(project: Path, home: Path | None = None) -> list[dict[str, str]]:
    """[{event, matcher, command, scope}] of the hooks Claude Code runs, from the user's,
    the project's and its local settings (read only: what /hooks shows)."""
    home = home or Path.home()
    out: list[dict[str, str]] = []
    for scope, path in (
        ("user", home / ".claude" / "settings.json"),
        ("project", project / ".claude" / "settings.json"),
        ("local", project / ".claude" / "settings.local.json"),
    ):
        try:
            data = json.loads(_read(path) or "{}") if path.is_file() else {}
        except ValueError:
            out.append(
                {"event": "", "matcher": "", "command": "", "scope": f"{scope} (unreadable)"}
            )
            continue
        events = data.get("hooks") if isinstance(data, dict) else None
        for event, groups in (events if isinstance(events, dict) else {}).items():
            for group in groups if isinstance(groups, list) else []:
                if not isinstance(group, dict):
                    continue
                for hook in group.get("hooks") or []:
                    if isinstance(hook, dict) and len(out) < MAX_ITEMS:
                        what = hook.get("command") or hook.get("prompt") or hook.get("type")
                        out.append(
                            {
                                "event": str(event)[:60],
                                "matcher": str(group.get("matcher") or "")[:120],
                                "command": str(what or "")[:300],
                                "scope": scope,
                            }
                        )
    return out


def describe(name: str, project: Path, home: Path | None = None) -> str:
    """/agents or /hooks, as a note for the transcript."""
    if name == "agents":
        items = agents(project, home)
        if not items:
            return (
                "No custom subagents here. Claude Code still has its built-in ones; add your "
                "own as .claude/agents/<name>.md."
            )
        lines = [
            f"- {i['name']} ({i['scope']})" + (f": {i['help']}" if i["help"] else "") for i in items
        ]
        return "Subagents:\n" + "\n".join(lines)
    found = hooks(project, home)
    if not found:
        return "No hooks set up (in ~/.claude/settings.json or this project's .claude/settings)."
    lines = []
    for h in found:
        if not h["event"]:
            lines.append(f"- {h['scope']} settings: not valid JSON")
            continue
        matcher = f" [{h['matcher']}]" if h["matcher"] else ""
        lines.append(f"- {h['event']}{matcher}: {h['command']} ({h['scope']})")
    return "Hooks:\n" + "\n".join(lines)
