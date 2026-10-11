"""Trusting a project folder before its own settings run (bug sweep r1, CD1, CD2, CD13).

A folder's Claude Code settings can run commands the moment a session opens there, in any
mode, past every permission check: hooks, apiKeyHelper (and the other helpers), a status
line, the servers in .mcp.json, plugins it switches on; its permissions.allow lets steps
by unasked, and its env can send the whole conversation, with the sign-in, to another
server (ANTHROPIC_BASE_URL). Claude Code's own trust dialog never shows through the SDK,
so this is Eden Code's.

- Until the owner trusts a folder that has any of these, its sessions load the owner's own
  settings alone (setting_sources ["user"]): none of the folder's settings, local
  settings, CLAUDE.md, .mcp.json servers or env. A card in the session (role "trust") lists
  what the folder's settings would run, and "Trust this folder" (ct_trust {id}) remembers it
  for the project (an isolated copy's project, not the copy), in code_trust.json. Sessions
  there reopen with it, same conversation, between steps.
- What was trusted is remembered item by item: something new in the folder's settings (a
  hook a pull brought in) asks again; a folder with none of them needs no trust at all.
- A folder the owner added empty (made for a new project) counts as trusted.
- Trusted, a folder's .mcp.json servers still run only once approved in the MCP servers
  pane (the rest are switched off on the session's connection: disabledMcpjsonServers), so
  the pane says what's so (CD13).
- Window commands: ct_state {id} (answers ct_state {id, project, trusted, items, new}),
  ct_trust {id}, ct_forget {id}. Not the phone's (companion_code's actions don't reach
  them): trusting runs commands on this Mac.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from .. import codemcp, jsonstore, projectfiles
from ..codeplatform import code_task, other_agent, project_of

log = logging.getLogger("jarvis")

STORE = "code_trust.json"
SETTINGS = (".claude/settings.json", ".claude/settings.local.json")
# Settings that only say what the session may not do, or how it looks: nothing to trust.
HARMLESS = {
    "$schema", "model", "outputStyle", "includeCoAuthoredBy", "cleanupPeriodDays",
    "spinnerTipsEnabled", "language", "alwaysThinkingEnabled", "enabledMcpjsonServers",
    "disabledMcpjsonServers", "theme", "respectGitignore", "forceLoginMethod",
}  # fmt: skip
HELPERS = ("apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper")
MAX_ITEMS = 60
CARD = "This folder's own Claude Code settings are off until you trust it."
TRUSTED = "Trusted this folder: its sessions load its settings from their next step."
FORGOTTEN = "This folder isn't trusted any more: its sessions load only your own settings."


READ_CAP = projectfiles.READ_CAP  # a settings file bigger than this isn't read: it needs trust
MCP_CAP = 64_000_000  # .mcp.json and ~/.claude.json, read this far for the servers' names
LIST_CAP = 500  # command, skill and agent files looked at; past it the folder needs trust
HEAD_CAP = 65_536  # a command's or skill's header is looked for this far


# A project's files are read so nothing in them can hold Eden up (a pipe, a device, a huge
# file: CD3-1); the same reader is the MCP pane's, the Plugins pane's and the palette's.
_open = projectfiles.read_capped


def _load(path: Path, cap: int | None = None, lossy: bool = False) -> tuple[Any, str]:
    """A settings file's JSON object and "", or (None, why): projectfiles.load_json, capped
    at READ_CAP unless told otherwise."""
    return projectfiles.load_json(path, READ_CAP if cap is None else cap, lossy)


def _read(path: Path, cap: int | None = None) -> Any:
    """A JSON file's object, or {} (for what only switches things off: never for deciding
    that a folder has nothing to trust, which is _load's)."""
    data, _why = _load(path, cap, lossy=True)
    return data if isinstance(data, dict) else {}


def _digest(path: Path) -> str:
    """What a file holds, for an id: its bytes' hash, or (unreadable) its size and times."""
    try:
        return hashlib.sha256(_open(path, 256_000_000)).hexdigest()[:32]
    except OSError:
        return repr(_stat_key(path))


def _unreadable(rel: str, what: str, why: str, folder: Path) -> dict[str, str]:
    """A file Claude Code may load that couldn't be checked: on the card, for the owner to
    decide, never "nothing to trust"."""
    return _item(
        f"Couldn't read {what} ({rel}): {why}. Claude Code may still load it and run what "
        "it says; trust the folder only if you know this file.",
        [rel, why, _digest(folder / rel)],
    )


def _item(what: str, raw: Any) -> dict[str, str]:
    """One thing a folder's settings would run or allow: what the card says, and an id from
    all of it (a masked secret that changed is a new item)."""
    blob = json.dumps([what.split(":", 1)[0], raw], sort_keys=True, default=str)
    return {"what": what[:300], "id": hashlib.sha256(blob.encode()).hexdigest()[:24]}


COMMAND_KEYS = ("allowed-tools", "hooks")
# A subagent's (.claude/agents/<name>.md): what it may use, its permission mode, its hooks
# and its own MCP servers (keys compared in lower case, "_" read as "-").
AGENT_KEYS = ("tools", "permissionmode", "hooks", "mcpservers")
AGENT_WORDS = {
    "tools": "Agent's tools",
    "permissionmode": "Agent's permission mode",
    "hooks": "Agent's hooks",
    "mcpservers": "Agent's MCP servers",
}


def _frontmatter(path: Path, keys: tuple[str, ...] = COMMAND_KEYS) -> tuple[dict[str, str], str]:
    """A command's, skill's or agent's header keys that let things run (a command's or
    skill's allowed-tools and hooks while it's in use; an agent's AGENT_KEYS), and "" — or
    ({}, why) when it couldn't be checked."""
    try:
        raw = _open(path, HEAD_CAP)
    except FileNotFoundError:
        return {}, ""
    except IsADirectoryError:
        return {}, "it isn't a regular file"
    except PermissionError:
        return {}, "it can't be read (no permission)"
    except OSError as exc:
        return {}, f"it can't be read ({exc.strerror or type(exc).__name__})"
    head = raw[:HEAD_CAP].decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    if not head.startswith("---"):
        return {}, ""
    parts = re.split(r"\n---[ \t]*(?:\n|$)", head[3:], maxsplit=1)
    if len(parts) < 2 and len(raw) > HEAD_CAP:
        return {}, "its header is too long to check"
    found: dict[str, list[str]] = {}
    key = ""
    for line in parts[0].split("\n")[1:]:
        if line[:1] in (" ", "\t", "-") and key:
            found[key].append(line.strip())  # (a list or a block under the key)
            continue
        name, _, value = line.partition(":")
        name = name.strip().strip("'\"").lower().replace("_", "-")
        flat = name.replace("-", "")  # (permissionMode, permission_mode, permission-mode)
        key = name if name in keys else flat if flat in keys else ""
        if key:
            found[key] = [value.strip()]
    out = {k: " ".join(v for v in lines if v)[:200] for k, lines in found.items()}
    return {k: v for k, v in out.items() if v}, ""


def _claude_files(folder: Path) -> tuple[list[Path], bool]:
    """A folder's command files (.claude/commands, any depth), skill files
    (.claude/skills/<name>/SKILL.md) and subagent files (.claude/agents, any depth), names
    in any case and linked folders followed, as Claude Code may load them: up to LIST_CAP,
    and whether there are more."""
    claude = folder / ".claude"
    files: list[Path] = []
    looked = 0  # (every name looked at counts: a huge or looping tree stops early)
    seen: set[tuple[int, int]] = set()
    for top, depth in (("commands", 64), ("skills", 1), ("agents", 64)):
        root = claude / top
        for here, dirs, names in os.walk(root, followlinks=True):
            looked += len(dirs) + len(names)
            with contextlib.suppress(OSError):
                st = os.stat(here)
                if (st.st_dev, st.st_ino) in seen:
                    dirs[:] = []
                    continue
                seen.add((st.st_dev, st.st_ino))
            level = len(Path(here).relative_to(root).parts)
            if level >= depth:
                dirs[:] = []
            dirs.sort()
            for name in sorted(names):
                low = name.lower()
                if (top in ("commands", "agents") and low.endswith(".md")) or (
                    top == "skills" and level == 1 and low == "skill.md"
                ):
                    files.append(Path(here) / name)
            if len(files) > LIST_CAP or looked > LIST_CAP * 20:
                return files[:LIST_CAP], True
    return files, False


def _listed(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    return list(value) if isinstance(value, dict) else [value] if value else []


def inventory(folder: Path, files: tuple[list[Path], bool] | None = None) -> list[dict[str, str]]:
    """What a folder's own settings would run, or let run unasked, at a session's start.
    A file Claude Code may load that can't be checked is an item of its own (CD2-1)."""
    items: list[dict[str, str]] = []
    for rel in SETTINGS:
        where = "local settings" if rel.endswith("local.json") else "settings"
        data, why = _load(folder / rel)
        if why:
            items.append(_unreadable(rel, f"the folder's Claude Code {where}", why, folder))
        if not isinstance(data, dict):
            continue
        for key, value in data.items():
            if key in HARMLESS:
                continue
            if key == "hooks" and isinstance(value, dict):
                for event, groups in value.items():
                    for group in groups if isinstance(groups, list) else [groups]:
                        hooks = group.get("hooks") if isinstance(group, dict) else None
                        for hook in hooks if isinstance(hooks, list) else [group]:
                            cmd = hook.get("command") if isinstance(hook, dict) else hook
                            items.append(_item(f"Hook ({event}, {where}): {cmd}", hook))
            elif key in HELPERS:
                items.append(_item(f"{key} ({where}): {value}", value))
            elif key == "statusLine":
                cmd = value.get("command") if isinstance(value, dict) else value
                items.append(_item(f"Status line command ({where}): {cmd}", value))
            elif key == "env" and isinstance(value, dict):
                for name, val in value.items():
                    shown = codemcp.shown_command(str(val), []) if val is not None else ""
                    items.append(_item(f"Environment ({where}): {name}={shown}", [name, val]))
            elif key == "permissions" and isinstance(value, dict):
                for rule in _listed(value.get("allow")):
                    items.append(_item(f"Allowed without asking ({where}): {rule}", rule))
                for extra in _listed(value.get("additionalDirectories")):
                    items.append(_item(f"Extra folder ({where}): {extra}", extra))
                if value.get("defaultMode"):
                    items.append(
                        _item(
                            f"Permission mode ({where}): {value['defaultMode']}",
                            value["defaultMode"],
                        )
                    )
            elif key == "enableAllProjectMcpServers":
                if value is True:
                    items.append(_item(f"Every .mcp.json server approved ({where})", value))
            elif key == "enabledPlugins" and isinstance(value, dict):
                for name, on in value.items():
                    if on:
                        items.append(_item(f"Plugin switched on ({where}): {name}", [name, on]))
            else:
                items.append(_item(f"Setting ({where}): {key}", value))
    servers, why = _load(folder / ".mcp.json")
    if why:
        names = _mcp_names(folder)
        item = _unreadable(".mcp.json", "the folder's MCP servers file", why, folder)
        if names is None:  # (its servers can't be switched off either: never trusted)
            item = {**item, "always": "1"}
        items.append(item)
    servers = servers.get("mcpServers") if isinstance(servers, dict) else None
    for name, config in servers.items() if isinstance(servers, dict) else []:
        server = codemcp.describe(name, config, "project")
        target = server.target if server is not None else json.dumps(config, default=str)
        items.append(_item(f"MCP server (.mcp.json) {name}: {target}", config))
    listed, more = files if files is not None else _claude_files(folder)
    if more:
        items.append(
            _item(
                f"More than {LIST_CAP} command, skill and agent files in .claude: too many to check "
                "what they let run unasked; trust the folder only if you know them.",
                [p.relative_to(folder).as_posix() for p in listed],
            )
        )
    for path in listed:
        rel = path.relative_to(folder).as_posix()
        if path.relative_to(folder).parts[1:2] == ("agents",):
            found, why = _frontmatter(path, AGENT_KEYS)
            if why:
                items.append(_unreadable(rel, "a subagent", why, folder))
            for key in AGENT_KEYS:
                if found.get(key):
                    value = found[key]
                    items.append(_item(f"{AGENT_WORDS[key]} ({rel}): {value}", [rel, key, value]))
            continue
        found, why = _frontmatter(path)
        if why:
            items.append(_unreadable(rel, "a command or skill", why, folder))
        if found.get("allowed-tools"):
            tools = found["allowed-tools"]
            items.append(_item(f"Runs unasked while in use ({rel}): {tools}", [rel, tools]))
        if found.get("hooks"):
            hooks = found["hooks"]
            items.append(_item(f"Hooks while in use ({rel}): {hooks}", [rel, "hooks", hooks]))
    seen: set[str] = set()
    unique = []
    for item in items:
        if item["id"] not in seen:
            seen.add(item["id"])
            unique.append(item)
    return unique


def _stat_key(path: Path) -> tuple[int, ...]:
    """A file's times, size, inode and type (links followed): any write, swap or chmod
    changes it."""
    try:
        st = path.stat()
    except OSError as exc:
        return (0, 0, 0, 0, 0, exc.errno or 0)
    return (st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino, st.st_mode, 0)


def _stamp(folder: Path) -> tuple[tuple, tuple[list[Path], bool]]:
    """What changes when a folder's settings could have: the files' and folders' times,
    every command and skill file's too (an edit in place: CD2-3), and those files."""
    out: list[Any] = []
    for rel in (
        *SETTINGS, ".mcp.json", ".claude", ".claude/commands", ".claude/skills", ".claude/agents"
    ):  # fmt: skip
        out.append((rel, *_stat_key(folder / rel)))
    files = _claude_files(folder)
    nested = hashlib.sha256()
    for path in files[0]:
        nested.update(repr((str(path), _stat_key(path))).encode())
    out.append(("files", len(files[0]), files[1], nested.hexdigest()))
    return tuple(out), files


def _mcp_names(folder: Path) -> list[str] | None:
    """The servers a folder's .mcp.json names, read as leniently as Claude Code might (a
    BOM, a stray byte, a big file); None when it's there and that still can't be told."""
    data, why = _load(folder / ".mcp.json", MCP_CAP, lossy=True)
    if why.startswith("it's over"):
        return None
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return [n for n in servers if isinstance(n, str)] if isinstance(servers, dict) else []


class TrustDesk:
    """One hub's trusted folders."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.path = hub.feature_path(STORE)
        self._store: dict[str, Any] | None = None
        self._seen: dict[str, tuple[tuple, list[dict[str, str]]]] = {}  # folder -> (stamp, items)
        self._carded: dict[int, frozenset[str]] = {}  # task id -> the items its card showed

    # ── the store ──

    @property
    def store(self) -> dict[str, Any]:
        if self._store is None:
            data = None
            with contextlib.suppress(Exception):
                data = json.loads(self.path.read_text(encoding="utf-8"))
            self._store = data if isinstance(data, dict) else {}
        return self._store

    def _save(self) -> None:
        try:
            jsonstore.save_json(self.path, self.store)
        except OSError as exc:
            log.warning("Eden Code: couldn't save the trusted folders (%s)", exc)

    def items(self, folder: Path) -> list[dict[str, str]]:
        key = str(folder)
        stamp, files = _stamp(folder)
        cached = self._seen.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        found = inventory(folder, files)
        # (past the card's length, what can't be trusted stays: the rest asks again later)
        found = found[:MAX_ITEMS] + [i for i in found[MAX_ITEMS:] if i.get("always")]
        self._seen[key] = (stamp, found)
        return found

    def new_items(self, task: Any) -> list[dict[str, str]]:
        """What the session's folder would run that its project wasn't trusted with."""
        found = self.items(Path(task.cwd))
        if not found:
            return []
        always = [i for i in found if i.get("always")]
        record = self.store.get(project_of(self.hub, task))
        if isinstance(record, dict) and record.get("made"):
            return always
        known = set(record.get("ids") or []) if isinstance(record, dict) else set()
        return [i for i in found if i["id"] not in known or i.get("always")]

    def trusted(self, task: Any) -> bool:
        return not self.new_items(task)

    def trust(self, task: Any) -> None:
        project = project_of(self.hub, task)
        record = self.store.get(project) if isinstance(self.store.get(project), dict) else {}
        ids = set(record.get("ids") or []) | {i["id"] for i in self.items(Path(task.cwd))}
        self.store[project] = {
            **record,
            "ids": sorted(ids),
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        self._save()

    def made(self, folder: str) -> None:
        """A folder the owner added empty: theirs, trusted."""
        self.store[str(folder)] = {"made": True, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        self._save()

    # ── a session's options ──

    def unapproved(self, task: Any) -> list[str]:
        """The folder's .mcp.json servers the owner hasn't approved (switched off)."""
        folder = Path(task.cwd)
        shared = _mcp_names(folder)
        if not shared:
            return []  # (none can't be told apart: then the folder is never trusted)
        mcp = getattr(self.hub, "code_mcp", None)
        state_path, settings_path = (
            mcp.paths() if mcp is not None else (codemcp.claude_json(), codemcp.user_settings())
        )
        state = _read(state_path, MCP_CAP)
        everything, enabled, _disabled = codemcp.approval(
            folder, state if isinstance(state, dict) else {}, settings_path
        )
        if everything:
            return []
        return sorted(n for n in shared if n not in enabled)

    def key(self, task: Any) -> Any:
        if task.kind != "code" or other_agent(task):
            return None
        trusted = self.trusted(task)
        return (trusted, tuple(self.unapproved(task)) if trusted else ())

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code" or other_agent(task):
            return
        try:
            self._apply(task, options)
        except Exception:  # (fails closed: a check that broke never loads the folder's settings)
            log.exception("Eden Code: couldn't check the folder's settings; leaving them off")
            options.setting_sources = ["user"]

    def _apply(self, task: Any, options: Any) -> None:
        new = self.new_items(task)
        if new:
            # The owner's own settings alone: no project or local settings, CLAUDE.md, env,
            # hooks, helpers or .mcp.json servers from the folder.
            options.setting_sources = ["user"]
            self._card(task, new)
            return
        off = self.unapproved(task)
        if off:
            options.settings = _with(options.settings, {"disabledMcpjsonServers": off})

    def _card(self, task: Any, new: list[dict[str, str]]) -> None:
        shown = frozenset(i["id"] for i in new)
        if self._carded.get(task.id) == shown:
            return  # (said once per session for these)
        self._carded[task.id] = shown
        project = project_of(self.hub, task)
        known = self.store.get(project)
        self.hub.tasks.add_entry(
            task.id,
            "trust",
            CARD,
            project=project,
            name=Path(project).name,
            items=[i["what"] for i in new],
            again=bool(isinstance(known, dict) and known.get("ids")),
            state="waiting",
        )

    # ── window commands ──

    def state(self, task: Any, **extra: Any) -> None:
        new = self.new_items(task)
        self.hub.emit(
            "ct_state",
            id=task.id,
            project=project_of(self.hub, task),
            trusted=not new,
            items=[i["what"] for i in self.items(Path(task.cwd))],
            new=[i["what"] for i in new],
            **extra,
        )

    def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self.state(task)

    def cmd_trust(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        self.trust(task)
        self._settle(project_of(self.hub, task), TRUSTED)
        self.state(task)

    def cmd_forget(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        self.store.pop(project_of(self.hub, task), None)
        self._save()
        self._settle(project_of(self.hub, task), FORGOTTEN)
        self.state(task)

    def _settle(self, project: str, note: str) -> None:
        """The project's open sessions take it up, same conversation, between steps."""
        for other in list(self.hub.tasks.tasks.values()):
            if other.kind != "code" or project_of(self.hub, other) != project:
                continue
            self._carded.pop(other.id, None)
            if other.client is not None:
                self.hub.tasks.reopen(other.id, note)

    def on_project_added(self, event: dict[str, Any]) -> None:
        """A folder the owner added: one that's empty (a new project) is theirs."""
        path = Path(str(event.get("path") or ""))
        with contextlib.suppress(OSError):
            names = [p.name for p in path.iterdir()][:10]
            if path.is_dir() and not [n for n in names if n not in (".git", ".DS_Store")]:
                self.made(str(path))


def _with(settings: str | None, extra: dict[str, Any]) -> str | None:
    """A session's flag settings (JSON, or None) with these added; a settings file's path is
    left as it is (nothing can be added to it)."""
    base: dict[str, Any] = {}
    if settings:
        try:
            parsed = json.loads(settings)
        except ValueError:
            return settings
        if not isinstance(parsed, dict):
            return settings
        base = parsed
    for key, value in extra.items():
        have = base.get(key) if isinstance(base.get(key), list) else []
        base[key] = [*have, *(v for v in value if v not in have)]
    return json.dumps(base)


class _Options:
    def __init__(self, desk: TrustDesk) -> None:
        self.desk = desk

    def apply(self, task: Any, options: Any) -> None:
        self.desk.apply(task, options)

    def key(self, task: Any) -> Any:
        return self.desk.key(task)


def install(hub: Any) -> None:
    desk = TrustDesk(hub)
    hub.code_trust = desk  # (for the MCP pane and the tests)
    hub.tasks.option_hooks.append(_Options(desk))
    hub.add_event_sink(["code_project_added"], desk.on_project_added)
    hub.register_command("ct_state", desk.cmd_state)
    hub.register_command("ct_trust", desk.cmd_trust)
    hub.register_command("ct_forget", desk.cmd_forget)
