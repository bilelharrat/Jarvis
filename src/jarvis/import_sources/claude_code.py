"""Claude Code (the CLI and Claude Desktop's Code tab): most of it already works in Eden Code.

Every Eden Code session is a Claude Code session (the Agent SDK runs the same CLI, with the
same config folder: Eden never sets CLAUDE_CONFIG_DIR), started with setting_sources user,
project and local (tasks.TaskManager.options_for). So these load in Eden Code as they are,
and the preview says so:
- the sign-in: the CLI's own Claude login (and subscription) is the one Eden Code uses,
  unless the owner chose an API key or Eden Plus in Eden's own Claude sign-in
  (claude_signin.py); nothing is copied, and no token is read here;
- ~/.claude/CLAUDE.md, settings.json (permissions, hooks, env, output style), commands,
  subagents, skills, plugins and marketplaces;
- MCP servers in ~/.claude.json (user scope, and each folder's local scope), and a project's
  .mcp.json (Eden's MCP servers pane asks before one runs);
- past conversations: Eden Code's history is Claude Code's own record of each session
  (~/.claude/projects/<folder>/<id>.jsonl, read by tasks.past_sessions), so a project's
  conversations are listed under it, and resume as the same conversation, once the project
  is on Eden's list.

What it brings: the project folders Claude Code knows (~/.claude.json "projects", and each
record's working folder), the default model (Eden passes its own model to every session, so
Claude Code's own default doesn't apply there by itself) and the default permission mode.
Not applicable: the status line and keybindings.json (Eden Code has its own).

Read-only: ~/.claude and ~/.claude.json are only ever read.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from ..code_import import (
    Context,
    Env,
    Item,
    ReadError,
    Source,
    already,
    error_item,
    existing,
    is_dir,
    is_file,
    jsonl,
    listing,
    model_item,
    note,
    project_items,
    read_json,
)

ORDER = 0
SESSION_FILES = 20_000  # records looked at
HEAD_LINES = 40  # lines of a record read for its folder
# Claude Code's permission modes -> Eden Code's (bypassPermissions has no safe twin: left out)
MODES = {"default": "ask", "acceptEdits": "edits", "plan": "plan"}


def detect(env: Env) -> list[Path]:
    return existing([env.claude_dir(), env.claude_json()])


def sessions(env: Env) -> Counter:
    """How many conversations Claude Code has recorded in each working folder."""
    found: Counter = Counter()
    seen = 0
    for folder in listing(env.claude_dir() / "projects", "*", 2000):
        if not is_dir(folder):
            continue
        for record in listing(folder, "*.jsonl", 5000):
            seen += 1
            if seen > SESSION_FILES:
                return found
            for i, line in enumerate(jsonl(record, limit=4_000_000)):
                if i >= HEAD_LINES:
                    break
                cwd = line.get("cwd")
                if isinstance(cwd, str) and cwd:
                    found[cwd] += 1
                    break
    return found


def _settings(env: Env) -> tuple[dict[str, Any], list[Item]]:
    path = env.claude_dir() / "settings.json"
    if not is_file(path):
        return {}, []
    try:
        data = read_json(path)
    except ReadError as exc:
        return {}, [error_item("claude_code", path, exc)]
    return (data if isinstance(data, dict) else {}), []


def _count(folder: Path, pattern: str) -> int:
    return len(listing(folder, pattern, 1000))


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    base = env.claude_dir()
    # ── sign-in ──
    if ctx.using_key:
        items.append(note("signin", "signin", "Claude sign-in",
                          "Eden Code signs in with your Anthropic API key now. To use the Claude account "
                          "Claude Code is signed in to (your subscription), choose it in Eden's Claude sign-in "
                          "(Setup › Claude).", status="manual"))  # fmt: skip
    elif ctx.signed_in is False:
        items.append(note("signin", "signin", "Claude sign-in",
                          "Claude Code isn't signed in. Sign in through Eden's Claude sign-in (Setup › Claude): "
                          "Eden Code and Claude Code then share it.", status="manual"))  # fmt: skip
    else:
        items.append(already("signin", "signin", "Claude sign-in",
                             "Eden Code runs your own Claude Code, so it uses the account (and subscription) "
                             "Claude Code is signed in to. Nothing to copy."))  # fmt: skip
    # ── projects and their conversations ──
    state: dict[str, Any] = {}
    if is_file(env.claude_json()):
        try:
            loaded = read_json(env.claude_json())
            state = loaded if isinstance(loaded, dict) else {}
        except ReadError as exc:
            items.append(error_item("claude_code", env.claude_json(), exc))
    counts = sessions(env)
    known = (
        [p for p in (state.get("projects") or {}) if isinstance(p, str)]
        if isinstance(state.get("projects"), dict)
        else []
    )
    paths = [*known, *counts]
    home = str(env.home)
    ordered = sorted({p for p in paths if p and p != home}, key=lambda p: -counts.get(p, 0))
    items += project_items("claude_code", [(Path(p), counts.get(p, 0)) for p in ordered], ctx)
    total = sum(counts.values())
    if total:
        items.append(already("chats:claude_code", "chats",
                             f"{total} past conversation{'s' if total != 1 else ''}",
                             "Each one is listed under its project in Eden Code's history and picks up where it "
                             "left off (the same conversation). They come with their project: nothing is copied.",
                             count=total))  # fmt: skip
    # ── instructions and settings ──
    if is_file(base / "CLAUDE.md"):
        items.append(already("rules:claude-user", "rules", "Your CLAUDE.md",
                             "Every Eden Code session reads it, as Claude Code does.", detail="~/.claude/CLAUDE.md"))  # fmt: skip
    settings, errors = _settings(env)
    items += errors
    perms = settings.get("permissions") if isinstance(settings.get("permissions"), dict) else {}
    rules = sum(
        len(perms.get(k) or []) for k in ("allow", "ask", "deny") if isinstance(perms.get(k), list)
    )
    if rules:
        items.append(already("setting:permissions", "setting", f"{rules} permission rule{'s' if rules != 1 else ''}",
                             "Claude Code applies them in every Eden Code session; a deny holds in every mode."))  # fmt: skip
    if isinstance(settings.get("hooks"), dict) and settings["hooks"]:
        n = sum(len(v) for v in settings["hooks"].values() if isinstance(v, list))
        items.append(already("setting:hooks", "setting", f"Hooks ({n})",
                             "They run in Eden Code sessions; edit them in the Plugins pane (/plugins)."))  # fmt: skip
    if isinstance(settings.get("env"), dict) and settings["env"]:
        names = sorted(str(k) for k in settings["env"])[:12]
        items.append(already("setting:env", "setting", f"Environment variables ({len(settings['env'])})",
                             "Claude Code sets them in Eden Code sessions too.", detail=", ".join(names)))  # fmt: skip
    if isinstance(settings.get("outputStyle"), str):
        items.append(already("setting:outputStyle", "setting", f"Output style: {settings['outputStyle']}",
                             "It applies in Eden Code sessions."))  # fmt: skip
    if found := model_item(
        "claude_code", "Claude Code", settings.get("model"), ctx, where="settings.json"
    ):
        items.append(found)
    mode = perms.get("defaultMode")
    if isinstance(mode, str) and mode:
        eden = MODES.get(mode)
        item = Item(id=f"setting:mode:{mode}", kind="model", title=f"Default permission mode: {mode}",
                    detail="settings.json", payload={"pref": "code_mode", "value": eden or ""})  # fmt: skip
        if eden is None:
            item.status = "manual"
            item.why = (
                "Eden Code has its own modes: pick one in the composer or Settings › General."
            )
        elif ctx.code_mode == eden:
            item.status, item.why = "already", "Eden Code's new sessions start in it already."
        else:
            item.why = "New Eden Code sessions start in it."
        items.append(item)
    if settings.get("statusLine"):
        items.append(note("setting:statusLine", "setting", "Status line",
                          "Not needed: Eden Code shows its own status under the composer."))  # fmt: skip
    if is_file(base / "keybindings.json"):
        items.append(note("setting:keybindings", "setting", "Keybindings",
                          "Not applicable: Eden Code has its own keyboard shortcuts."))  # fmt: skip
    # ── commands, subagents, skills, plugins ──
    for folder, pattern, word in (("commands", "**/*.md", "Custom slash commands"),
                                  ("agents", "**/*.md", "Subagents"), ("skills", "*/SKILL.md", "Skills")):  # fmt: skip
        n = _count(base / folder, pattern)
        if n:
            items.append(already(f"setting:{folder}", "command" if folder == "commands" else "setting",
                                 f"{word} ({n})",
                                 "They load in every Eden Code session; edit them in the Plugins pane (/plugins).",
                                 detail=f"~/.claude/{folder}"))  # fmt: skip
    plugins = 0
    installed = base / "plugins" / "installed_plugins.json"
    if is_file(installed):
        try:
            data = read_json(installed)
            raw = data.get("plugins") if isinstance(data, dict) else None
            plugins = len(raw) if isinstance(raw, (dict, list)) else 0
        except ReadError as exc:
            items.append(error_item("claude_code", installed, exc))
    enabled = settings.get("enabledPlugins")
    plugins = max(plugins, len(enabled) if isinstance(enabled, dict) else 0)
    if plugins or is_file(base / "plugins" / "known_marketplaces.json"):
        items.append(already("setting:plugins", "setting", f"Plugins and marketplaces ({plugins} plugins)",
                             "They load in Eden Code sessions and show in the Plugins pane (/plugins)."))  # fmt: skip
    # ── MCP servers ──
    user = state.get("mcpServers") if isinstance(state.get("mcpServers"), dict) else {}
    for name in sorted(user)[:100]:
        items.append(already(f"mcp:{name}", "mcp", str(name),
                             "Your Claude Code server: it already loads in every Eden Code session.", detail="~/.claude.json"))  # fmt: skip
    local = 0
    for _folder, entry in (
        (state.get("projects") or {}).items() if isinstance(state.get("projects"), dict) else ()
    ):
        if isinstance(entry, dict) and isinstance(entry.get("mcpServers"), dict):
            local += len(entry["mcpServers"])
    if local:
        items.append(already("mcp:local", "mcp", f"{local} server{'s' if local != 1 else ''} for single folders",
                             "They load in Eden Code sessions in their folder, as in Claude Code."))  # fmt: skip
    shared = sum(1 for p in ordered if is_file(Path(p) / ".mcp.json"))
    if shared:
        items.append(already("mcp:projects", "mcp", f".mcp.json in {shared} project{'s' if shared != 1 else ''}",
                             "Eden Code's MCP servers pane asks before one of a project's shared servers runs."))  # fmt: skip
    return items


SOURCE = Source(
    id="claude_code",
    name="Claude Code",
    detect=detect,
    scan=scan,
    blurb="The CLI and Claude Desktop's Code tab: your projects, conversations, CLAUDE.md, commands, agents, skills, plugins and MCP servers.",
)
