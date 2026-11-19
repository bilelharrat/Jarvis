"""Continue (~/.continue): config.yaml or config.json (models, MCP servers, custom commands,
rules), mcpServers/*.yaml, rules/*.md, prompts/*.prompt, a project's .continue/rules and
.continuerules, and its saved sessions (sessions/*.json: the read-only history). A model's
apiKey is never copied: a note says where Eden takes keys."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..code_import import (
    Context,
    Env,
    Item,
    ReadError,
    Source,
    chat_entry,
    chats_item,
    command_item,
    commands_in,
    error_item,
    existing,
    files_rules,
    is_file,
    key_note,
    listing,
    mcp_items,
    message,
    model_item,
    note,
    project_rules,
    read_any,
    read_json,
    text_of_content,
)  # fmt: skip

ORDER = 100


def base_of(env: Env) -> Path:
    return env.home / ".continue"


def detect(env: Env) -> list[Path]:
    return existing([base_of(env)])


def _config(path: Path, ctx: Context, items: list[Item]) -> None:
    try:
        data = read_any(path)
    except ReadError as exc:
        items.append(error_item("continue", path, exc))
        return
    if not isinstance(data, dict):
        return
    for i, model in enumerate(
        (data.get("models") or [])[:30] if isinstance(data.get("models"), list) else []
    ):
        if not isinstance(model, dict):
            continue
        if model.get("apiKey"):
            items.append(
                key_note("continue", "Continue", str(model.get("provider") or "model"), path)
            )
        if i == 0 and (
            found := model_item("continue", "Continue", model.get("model"), ctx, where=path.name)
        ):
            items.append(found)
    items += mcp_items("continue", data.get("mcpServers"), path.name, ctx)
    exp = data.get("experimental") if isinstance(data.get("experimental"), dict) else {}
    servers = exp.get("modelContextProtocolServers")
    if isinstance(servers, list):
        items += mcp_items(
            "continue", {f"continue-{n + 1}": s for n, s in enumerate(servers)}, path.name, ctx
        )
    for cmd in (data.get("customCommands") or data.get("prompts") or [])[:100]:
        if isinstance(cmd, dict) and (found := command_item("continue", str(cmd.get("name") or ""),
                                                            str(cmd.get("prompt") or ""), "Continue command", ctx)):  # fmt: skip
            items.append(found)
    rules = data.get("rules")
    if isinstance(rules, list) and any(isinstance(r, (str, dict)) for r in rules):
        items.append(note(f"rules:continue-config:{path}", "rules", "Rules in Continue's config",
                          "They're written inside Continue's settings, not their own file: copy them into a "
                          "rules file (~/.continue/rules/*.md comes over by itself).", status="manual"))  # fmt: skip


def _chats(base: Path) -> list[dict[str, Any]]:
    chats = []
    index = base / "sessions" / "sessions.json"
    listed: dict[str, dict[str, Any]] = {}
    if is_file(index):
        try:
            for s in read_json(index) or []:
                if isinstance(s, dict) and s.get("sessionId"):
                    listed[str(s["sessionId"])] = s
        except (ReadError, TypeError):
            pass
    for path in listing(base / "sessions", "*.json", 3000):
        if path.name == "sessions.json":
            continue
        meta = listed.get(path.stem, {})
        when = meta.get("dateCreated") or 0
        try:
            when = float(when) / (1000 if float(when) > 1e11 else 1)
        except (TypeError, ValueError):
            when = 0
        chats.append(chat_entry(f"continue:{path.stem}", meta.get("title") or path.stem, when or 0, path,
                                str(meta.get("workspaceDirectory") or "")))  # fmt: skip
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    base = base_of(env)
    items: list[Item] = []
    for name in ("config.yaml", "config.json"):
        if is_file(base / name):
            _config(base / name, ctx, items)
            break
    for path in listing(base / "mcpServers", "*.yaml", 50) + listing(
        base / "mcpServers", "*.json", 50
    ):
        try:
            data = read_any(path)
        except ReadError as exc:
            items.append(error_item("continue", path, exc))
            continue
        servers = data.get("mcpServers") if isinstance(data, dict) else data
        items += mcp_items("continue", servers, f"mcpServers/{path.name}", ctx)
    items += files_rules("continue", base / "rules", "*.md", "Continue rule", ctx)
    items += commands_in("continue", base / "prompts", "*.prompt", "Continue prompt", ctx)
    items += project_rules(
        "continue", ctx, (".continuerules", ".continue/rules/*.md"), "Continue rules"
    )
    if found := chats_item("continue", "Continue", _chats(base), ctx):
        items.append(found)
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    data = read_json(Path(entry["path"]))
    out = []
    for step in (data.get("history") or []) if isinstance(data, dict) else []:
        msg = step.get("message") if isinstance(step, dict) else None
        if isinstance(msg, dict) and (
            m := message(str(msg.get("role")), text_of_content(msg.get("content")))
        ):
            out.append(m)
    return out


SOURCE = Source(id="continue", name="Continue", detect=detect, scan=scan, read_chat=read_chat,
                blurb="Models, MCP servers, rules, prompts and saved sessions.")  # fmt: skip
