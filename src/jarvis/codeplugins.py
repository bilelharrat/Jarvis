"""Claude Code's plugins, and its agents, skills, commands and hooks as files (features.
code_plugins): what the plugin CLI says is installed and available (claude plugin list /
marketplace list / details, all --json but details), and the files under a project's .claude
folder and the owner's ~/.claude that the Plugins pane edits.

The files, as Claude Code reads them:
- agents: <base>/agents/<name>.md
- commands: <base>/commands/<name>.md (one folder down too: <group>/<name>.md)
- skills: <base>/skills/<name>/SKILL.md
- hooks: the "hooks" object of a settings file (<folder>/.claude/settings.json or
  settings.local.json, or ~/.claude/settings.json), everything else in it kept.

An edit is saved only over the version it was opened from (its stamp: size, modification
time and a hash of the contents): a file changed on disk meanwhile is a Conflict, never
overwritten unseen. Paths are only ever made from a kind, a scope and a checked name, and
must stay inside their folder.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

KINDS = ("agents", "commands", "skills")
FILE_SCOPES = ("project", "user")
HOOK_SCOPES = ("project", "local", "user")
FILE_CHARS = 200_000
FILES_LISTED = 300
_PART = r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}"
NAME = re.compile(rf"^{_PART}$")
COMMAND_NAME = re.compile(rf"^(?:{_PART}/)?{_PART}$")
HOOK_EVENTS = {
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit",
    "Stop", "SubagentStart", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
    "PermissionRequest",
}  # fmt: skip
TEMPLATES = {
    "agents": (
        "---\nname: {name}\ndescription: When Claude should hand work to this agent.\n"
        "tools: Read, Grep, Glob\n---\n\nYou are {name}. Say what this agent does and how.\n"
    ),
    "commands": "---\ndescription: What /{name} does.\n---\n\nThe prompt /{name} sends. $ARGUMENTS\n",
    "skills": (
        "---\nname: {name}\ndescription: What this skill knows, and when Claude should use it.\n"
        "---\n\nThe instructions and knowledge the skill brings.\n"
    ),
}


class Conflict(Exception):
    """The file changed on disk since it was opened: current is its stamp now."""

    def __init__(self, current: str) -> None:
        super().__init__("It changed on disk since you opened it.")
        self.current = current


class EditError(ValueError):
    """Why an edit can't be made, in words for the owner."""


def stamp_of(path: Path) -> str:
    """A file's version ("" when it isn't there)."""
    try:
        data = path.read_bytes()
        info = path.stat()
    except OSError:
        return ""
    return f"{info.st_size}:{info.st_mtime_ns}:{hashlib.sha256(data).hexdigest()[:16]}"


def base(scope: str, folder: Path, user_dir: Path) -> Path:
    return folder / ".claude" if scope == "project" else user_dir


def file_path(kind: str, scope: str, name: str, folder: Path, user_dir: Path) -> Path:
    """Where an agent, command or skill lives (EditError for a kind, scope or name that
    isn't one)."""
    if kind not in KINDS or scope not in FILE_SCOPES:
        raise EditError("That isn't something this can edit.")
    if not (COMMAND_NAME if kind == "commands" else NAME).match(name or ""):
        raise EditError("A name is letters, digits, dots, dashes or underscores, up to 64.")
    root = base(scope, folder, user_dir) / kind
    path = root / name / "SKILL.md" if kind == "skills" else root / f"{name}.md"
    with contextlib.suppress(OSError):
        if path.resolve().is_relative_to(root.resolve()) is False:
            raise EditError("That isn't something this can edit.")
    return path


def list_files(folder: Path, user_dir: Path) -> list[dict[str, Any]]:
    """The agents, commands and skills a folder's sessions have (project, then the owner's)."""
    found: list[dict[str, Any]] = []
    for scope in FILE_SCOPES:
        root = base(scope, folder, user_dir)
        for kind in KINDS:
            where = root / kind
            if not where.is_dir():
                continue
            if kind == "skills":
                names = sorted(p.parent.name for p in where.glob("*/SKILL.md"))
            elif kind == "commands":
                names = sorted(
                    str(p.relative_to(where).with_suffix(""))
                    for p in [*where.glob("*.md"), *where.glob("*/*.md")]
                )
            else:
                names = sorted(p.stem for p in where.glob("*.md"))
            pattern = COMMAND_NAME if kind == "commands" else NAME
            found += [{"kind": kind, "scope": scope, "name": n} for n in names if pattern.match(n)]
            if len(found) >= FILES_LISTED:
                return found[:FILES_LISTED]
    return found


def read_file(path: Path) -> tuple[str, str]:
    """A file's text and stamp ("", "" when it isn't there)."""
    stamp = stamp_of(path)
    if not stamp:
        return "", ""
    try:
        text = path.read_bytes()[:FILE_CHARS].decode("utf-8", "replace")
    except OSError:
        return "", ""
    return text, stamp


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def write_file(path: Path, text: str, stamp: str) -> str:
    """Save over the version opened (stamp; "" for a new file): its new stamp. Conflict
    when the file changed (or appeared) meanwhile."""
    if len(text) > FILE_CHARS:
        raise EditError("That's too long for one file.")
    current = stamp_of(path)
    if current != stamp:
        raise Conflict(current)
    _write(path, text)
    return stamp_of(path)


def delete_file(path: Path, stamp: str) -> None:
    current = stamp_of(path)
    if current != stamp or not current:
        raise Conflict(current)
    path.unlink()
    if path.name == "SKILL.md":  # a skill's folder, once nothing else is in it
        with contextlib.suppress(OSError):
            path.parent.rmdir()


# ── hooks ──


def settings_path(scope: str, folder: Path, user_dir: Path) -> Path:
    if scope not in HOOK_SCOPES:
        raise EditError("That isn't a settings file.")
    if scope == "user":
        return user_dir / "settings.json"
    return folder / ".claude" / ("settings.local.json" if scope == "local" else "settings.json")


def read_hooks(path: Path) -> tuple[str, str]:
    """A settings file's hooks as JSON text, and the file's stamp."""
    text, stamp = read_file(path)
    try:
        data = json.loads(text) if text.strip() else {}
    except ValueError:
        data = {}
    hooks = data.get("hooks") if isinstance(data, dict) else None
    return json.dumps(hooks if isinstance(hooks, dict) else {}, indent=2, ensure_ascii=False), stamp


def check_hooks(hooks: Any) -> None:
    """EditError says what's wrong with hooks that aren't in Claude Code's shape."""
    if not isinstance(hooks, dict):
        raise EditError("Hooks are an object: each event, with its matchers.")
    for event, groups in hooks.items():
        if event not in HOOK_EVENTS:
            raise EditError(f"“{str(event)[:40]}” isn't one of Claude Code's hook events.")
        if not isinstance(groups, list):
            raise EditError(f"{event} holds a list of matchers.")
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise EditError(f"Each of {event}'s matchers has a list of hooks.")
            if "matcher" in group and not isinstance(group["matcher"], str):
                raise EditError(f"A matcher in {event} is text, like Bash or Edit|Write.")
            for hook in group["hooks"]:
                if not isinstance(hook, dict) or hook.get("type") not in ("command", "prompt"):
                    raise EditError(f"Each hook in {event} is a command (or a prompt).")
                if hook["type"] == "command" and not str(hook.get("command") or "").strip():
                    raise EditError(f"A hook in {event} has no command.")


def write_hooks(path: Path, text: str, stamp: str) -> str:
    """Save hooks into a settings file, everything else in it kept: its new stamp."""
    try:
        hooks = json.loads(text)
    except ValueError as exc:
        raise EditError(f"That isn't JSON: {exc.msg} (line {exc.lineno}).") from exc
    check_hooks(hooks)
    current = stamp_of(path)
    if current != stamp:
        raise Conflict(current)
    raw, _ = read_file(path)
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError as exc:
        raise EditError(f"{path.name} isn't JSON, so nothing was written to it.") from exc
    if not isinstance(data, dict):
        raise EditError(f"{path.name} isn't a settings object, so nothing was written to it.")
    if hooks:
        data["hooks"] = hooks
    else:
        data.pop("hooks", None)
    _write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return stamp_of(path)


# ── what the plugin CLI says ──


def plugin_lists(listing: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """`claude plugin list --json --available`: (installed, available), each item's fields
    as the pane uses them."""
    data = listing if isinstance(listing, dict) else {"installed": listing}
    installed = []
    for item in data.get("installed") or [] if isinstance(data.get("installed"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            installed.append(
                {
                    "id": item["id"][:200],
                    "version": str(item.get("version") or "")[:40],
                    "scope": str(item.get("scope") or "")[:20],
                    "enabled": item.get("enabled") is not False,
                }
            )
    have = {p["id"] for p in installed}
    available = []
    for item in data.get("available") or [] if isinstance(data.get("available"), list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("pluginId"), str):
            continue
        if item["pluginId"] in have:
            continue
        available.append(
            {
                "id": item["pluginId"][:200],
                "name": str(item.get("name") or "")[:100],
                "description": " ".join(str(item.get("description") or "").split())[:300],
                "marketplace": str(item.get("marketplaceName") or "")[:100],
                "version": str(item.get("version") or "")[:40],
            }
        )
    return installed, available[:500]


def marketplaces(listing: Any) -> list[dict[str, Any]]:
    out = []
    for item in listing if isinstance(listing, list) else []:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            where = item.get("repo") or item.get("url") or item.get("path") or ""
            out.append(
                {
                    "name": item["name"][:100],
                    "source": str(item.get("source") or "")[:20],
                    "where": str(where)[:300],
                }
            )
    return out


_ALWAYS_ON = re.compile(r"Always-on:\s*~?\s*([\d,.]+)\s*(k?)\s*tok", re.I)


def always_on_tokens(details: str) -> int | None:
    """What `claude plugin details` says a plugin adds to every session's context."""
    found = _ALWAYS_ON.search(details or "")
    if not found:
        return None
    number = float(found.group(1).replace(",", ""))
    return round(number * (1000 if found.group(2) else 1))


def json_line(text: str) -> Any:
    """The last line of a CLI's output that is JSON (None when none is)."""
    for line in reversed(str(text).splitlines()):
        line = line.strip()
        if line.startswith(("{", "[")):
            with contextlib.suppress(ValueError):
                return json.loads(line)
    with contextlib.suppress(ValueError):
        return json.loads(text)
    return None


def context_rows(usage: Any, limit: int = 40) -> list[dict[str, Any]]:
    """A session's context, by what put it there (Claude Code's get_context_usage): its
    skills, agents, MCP tools (by server) and memory files, the most tokens first."""
    if not isinstance(usage, dict):
        return []
    rows: list[dict[str, Any]] = []

    def add(group: str, name: Any, tokens: Any, source: Any = "") -> None:
        if isinstance(tokens, int | float) and not isinstance(tokens, bool) and tokens > 0:
            rows.append(
                {
                    "group": group,
                    "name": str(name)[:120],
                    "source": str(source or "")[:80],
                    "tokens": int(tokens),
                }
            )

    for agent in usage.get("agents") or [] if isinstance(usage.get("agents"), list) else []:
        if isinstance(agent, dict):
            add(
                "Agents",
                agent.get("agentType") or agent.get("name"),
                agent.get("tokens"),
                agent.get("source"),
            )
    servers: dict[str, int] = {}
    for tool in usage.get("mcpTools") or [] if isinstance(usage.get("mcpTools"), list) else []:
        if isinstance(tool, dict) and isinstance(tool.get("tokens"), int | float):
            server = str(tool.get("serverName") or "?")
            servers[server] = servers.get(server, 0) + int(tool["tokens"])
    for server, tokens in servers.items():
        add("MCP servers", server, tokens)
    for memory in (
        usage.get("memoryFiles") or [] if isinstance(usage.get("memoryFiles"), list) else []
    ):
        if isinstance(memory, dict):
            add(
                "Memory files",
                Path(str(memory.get("path") or "")).name or memory.get("path"),
                memory.get("tokens"),
                memory.get("type"),
            )
    skills = usage.get("skills")
    listed = skills.get("skills") if isinstance(skills, dict) else skills
    for skill in listed if isinstance(listed, list) else []:
        if isinstance(skill, dict):
            add("Skills", skill.get("name"), skill.get("tokens"), skill.get("source"))
    rows.sort(key=lambda r: -r["tokens"])
    return rows[:limit]
