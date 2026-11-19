"""Cline (and, sharing this module's readers, Roo Code: roo_code.py), the VS Code extension, in
any VS Code-style editor it's installed in (VS Code, Cursor, Windsurf, VSCodium): its MCP
settings (globalStorage/<extension>/settings/*mcp_settings.json), rules (.clinerules, a
project's or ~/Documents/Cline/Rules), workflows (.clinerules/workflows,
~/Documents/Cline/Workflows) and its task history (globalStorage/<extension>/tasks/<id>).
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
    existing,
    files_rules,
    is_dir,
    is_file,
    listing,
    mcp_file,
    message,
    mtime,
    project_rules,
    read_json,
    text_of_content,
)  # fmt: skip

ORDER = 60
EDITORS = ("Code", "Cursor", "Windsurf", "VSCodium", "Code - Insiders")
EXTENSION = "saoudrizwan.claude-dev"


def storages(env: Env, extension: str) -> list[Path]:
    return existing([env.vscode_user(e) / "globalStorage" / extension for e in EDITORS])


def tasks_of(storage: Path, source: str) -> list[dict[str, Any]]:
    chats = []
    for folder in listing(storage / "tasks", "*", 3000):
        path = folder / "api_conversation_history.json"
        if not is_file(path):
            continue
        try:
            history = read_json(path)
        except ReadError:
            continue
        if not isinstance(history, list) or not history:
            continue
        first = next(
            (
                text_of_content(m.get("content"))
                for m in history
                if isinstance(m, dict) and m.get("role") == "user"
            ),
            "",
        )
        first = first.split("</task>", 1)[0].replace("<task>", "").strip()
        chats.append(chat_entry(f"{source}:{folder.name}", first, mtime(path), path))
    return chats


def read_task(entry: dict[str, Any]) -> list[dict[str, str]]:
    history = read_json(Path(entry["path"]))
    out = []
    for m in history if isinstance(history, list) else []:
        if isinstance(m, dict) and (
            got := message(str(m.get("role")), text_of_content(m.get("content")))
        ):
            out.append(got)
    return out


def detect(env: Env) -> list[Path]:
    return [*storages(env, EXTENSION), *existing([env.home / "Documents" / "Cline"])]


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    chats: list[dict[str, Any]] = []
    for storage in storages(env, EXTENSION):
        editor = storage.parent.parent.parent.name
        items += mcp_file(
            "cline",
            storage / "settings" / "cline_mcp_settings.json",
            "mcpServers",
            f"Cline in {editor}",
            ctx,
        )
        chats += tasks_of(storage, "cline")
    docs = env.home / "Documents" / "Cline"
    items += files_rules("cline", docs / "Rules", "*.md", "Cline rule", ctx)
    items += commands_in("cline", docs / "Workflows", "*.md", "Cline workflow", ctx)
    items += project_rules("cline", ctx, (".clinerules", ".clinerules/*.md"), "Cline rules")
    for folder in ctx.folders[:200]:
        if is_dir(folder / ".clinerules" / "workflows"):
            items += commands_in(
                "cline",
                folder / ".clinerules" / "workflows",
                "*.md",
                f"Cline workflow in {folder.name}",
                ctx,
            )
    if found := chats_item("cline", "Cline", chats, ctx):
        items.append(found)
    return items


SOURCE = Source(id="cline", name="Cline", detect=detect, scan=scan, read_chat=read_task,
                blurb="MCP servers, rules, workflows and task history.")  # fmt: skip
