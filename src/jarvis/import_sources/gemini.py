"""Gemini CLI and Antigravity (~/.gemini): settings.json (MCP servers, model), GEMINI.md, custom
commands (commands/**/*.toml), trusted folders, Antigravity's mcp_config.json, a project's
GEMINI.md and .gemini/commands, and Gemini CLI's saved chats (tmp/*/chats/*.json).

Antigravity's conversations are kept encoded (.pb): a note says so. Its sign-in stays its own.
"""

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
    commands_in,
    error_item,
    existing,
    is_dir,
    is_file,
    listing,
    mcp_file,
    message,
    model_item,
    mtime,
    note,
    project_items,
    project_rules,
    read_json,
    rules_item,
    text_of_content,
    with_folders,
)  # fmt: skip

ORDER = 50


def detect(env: Env) -> list[Path]:
    return existing([env.home / ".gemini"])


def _chats(base: Path) -> list[dict[str, Any]]:
    chats = []
    for path in listing(base / "tmp", "*/chats/*.json", 3000):
        try:
            data = read_json(path)
        except ReadError:
            continue
        messages = data.get("messages") if isinstance(data, dict) else None
        if not messages:
            continue
        first = next(
            (
                text_of_content(m.get("content"))
                for m in messages
                if isinstance(m, dict) and m.get("type") == "user"
            ),
            "",
        )
        chats.append(chat_entry(f"gemini:{data.get('sessionId') or path.stem}", first, mtime(path), path,
                                str(data.get("projectRoot") or "")))  # fmt: skip
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    base = env.home / ".gemini"
    items: list[Item] = []
    trusted: list[Path] = []
    tf = base / "trustedFolders.json"
    if is_file(tf):
        try:
            data = read_json(tf)
            trusted = (
                [Path(p) for p, v in data.items() if isinstance(p, str) and v != "DO_NOT_TRUST"]
                if isinstance(data, dict)
                else []
            )
        except ReadError as exc:
            items.append(error_item("gemini", tf, exc))
    items += project_items("gemini", [(p, 0) for p in trusted], ctx)
    with_folders(ctx, trusted)
    settings = base / "settings.json"
    items += mcp_file("gemini", settings, "mcpServers", "~/.gemini/settings.json", ctx)
    if is_file(settings):
        try:
            data = read_json(settings)
            model = data.get("model") if isinstance(data, dict) else None
            model = model.get("name") if isinstance(model, dict) else model
            if found := model_item(
                "gemini", "Gemini CLI", model, ctx, where="~/.gemini/settings.json"
            ):
                items.append(found)
        except ReadError:
            pass  # (said once, by mcp_file)
    items += mcp_file(
        "gemini",
        base / "antigravity" / "mcp_config.json",
        "mcpServers",
        "Antigravity mcp_config.json",
        ctx,
    )
    if found := rules_item("gemini", base / "GEMINI.md", "user", ctx, label="Your GEMINI.md"):
        items.append(found)
    items += project_rules("gemini", ctx, ("GEMINI.md",), "GEMINI.md")
    items += commands_in(
        "gemini", base / "commands", "**/*.toml", "Gemini command", ctx, toml_key="prompt"
    )
    for folder in ctx.folders[:200]:
        if is_dir(folder / ".gemini" / "commands"):
            items += commands_in("gemini", folder / ".gemini" / "commands", "**/*.toml",
                                 f"Gemini command in {folder.name}", ctx, toml_key="prompt")  # fmt: skip
    if found := chats_item("gemini", "Gemini CLI", _chats(base), ctx):
        items.append(found)
    encoded = len(listing(base / "antigravity" / "conversations", "*.pb", 5000))
    if encoded:
        items.append(note("chats:antigravity", "chats", f"{encoded} Antigravity conversations",
                          "Antigravity keeps them encoded, in a format only it reads: they stay there."))  # fmt: skip
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    data = read_json(Path(entry["path"]))
    out = []
    for m in (data.get("messages") or []) if isinstance(data, dict) else []:
        if isinstance(m, dict) and (
            got := message(
                "user" if m.get("type") == "user" else "assistant",
                text_of_content(m.get("content")),
            )
        ):
            out.append(got)
    return out


SOURCE = Source(id="gemini", name="Gemini CLI / Antigravity", detect=detect, scan=scan, read_chat=read_chat,
                blurb="MCP servers, GEMINI.md, custom commands, model, trusted folders and saved chats.")  # fmt: skip
