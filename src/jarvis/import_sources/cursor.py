"""Cursor: ~/.cursor/mcp.json and a project's .cursor/mcp.json, rules (.cursorrules,
.cursor/rules/*.mdc), commands (~/.cursor/commands, .cursor/commands), the folders it opened
(its VS Code-style workspaceStorage) and its chats (state.vscdb, read-only).

- MCP servers → Eden Code's imported servers (a project's for that project only).
- rules → read by sessions with their first message, where they are.
- commands → saved prompts.
- recent folders → Eden Code's projects.
- chats (Composer and chat, in its globalStorage state.vscdb: opened mode=ro, immutable) →
  the read-only history. Cursor's User Rules live in that database too: a note says so.
"""

from __future__ import annotations

import json
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
    is_file,
    mcp_file,
    message,
    note,
    project_items,
    project_rules,
    sqlite_rows,
    vscode_workspaces,
    with_folders,
)  # fmt: skip

ORDER = 20
DB = ("globalStorage", "state.vscdb")


def detect(env: Env) -> list[Path]:
    return existing([env.home / ".cursor", env.vscode_user("Cursor")])


def _db(env: Env) -> Path:
    return env.vscode_user("Cursor").joinpath(*DB)


def _chats(db: Path) -> list[dict[str, Any]]:
    rows = sqlite_rows(
        db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 3000"
    )
    chats = []
    for key, value in rows:
        try:
            data = json.loads(value) if value else {}
        except (ValueError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        cid = str(key).split(":", 1)[1]
        heads = data.get("fullConversationHeadersOnly") or data.get("conversation") or []
        if not heads:
            continue
        when = (data.get("lastUpdatedAt") or data.get("createdAt") or 0) / 1000
        chats.append(
            chat_entry(f"cursor:{cid}", data.get("name") or "Cursor chat", when, db, composer=cid)
        )
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    user = env.vscode_user("Cursor")
    folders = vscode_workspaces(user)
    items += project_items("cursor", [(p, 0) for p in folders], ctx)
    with_folders(ctx, folders)
    items += mcp_file(
        "cursor", env.home / ".cursor" / "mcp.json", "mcpServers", "~/.cursor/mcp.json", ctx
    )
    for folder in ctx.folders[:200]:
        items += mcp_file("cursor", folder / ".cursor" / "mcp.json", "mcpServers",
                          f"{folder.name}/.cursor/mcp.json", ctx, project=folder)  # fmt: skip
    items += project_rules(
        "cursor", ctx, (".cursorrules", ".cursor/rules/*.mdc", ".cursor/rules/*.md"), "Cursor rules"
    )
    items += commands_in("cursor", env.home / ".cursor" / "commands", "*.md", "Cursor command", ctx)
    for folder in ctx.folders[:200]:
        items += commands_in(
            "cursor",
            folder / ".cursor" / "commands",
            "*.md",
            f"Cursor command in {folder.name}",
            ctx,
        )
    db = _db(env)
    if is_file(db):
        try:
            if found := chats_item("cursor", "Cursor", _chats(db), ctx):
                items.append(found)
            rows = sqlite_rows(
                db, "SELECT value FROM ItemTable WHERE key = 'aicontext.personalContext' LIMIT 1"
            )
            if rows and rows[0][0]:
                items.append(note("rules:cursor-user", "rules", "Cursor's User Rules",
                                  "Cursor keeps them in its own database, not a file: copy them into a rules file "
                                  "(a project's CLAUDE.md, or your own) to bring them.", status="manual"))  # fmt: skip
        except ReadError as exc:
            items.append(error_item("cursor", db, exc))
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    db, cid = Path(entry["path"]), entry.get("composer", "")
    rows = sqlite_rows(db, "SELECT value FROM cursorDiskKV WHERE key = ?", (f"composerData:{cid}",))
    data = json.loads(rows[0][0]) if rows and rows[0][0] else {}
    out: list[dict[str, str]] = []
    inline = data.get("conversation") if isinstance(data.get("conversation"), list) else []
    heads = (
        data.get("fullConversationHeadersOnly")
        if isinstance(data.get("fullConversationHeadersOnly"), list)
        else []
    )
    for bubble in inline:
        if isinstance(bubble, dict) and (
            m := message("user" if bubble.get("type") == 1 else "assistant", bubble.get("text"))
        ):
            out.append(m)
    for head in heads[:800]:
        if not isinstance(head, dict):
            continue
        got = sqlite_rows(
            db,
            "SELECT value FROM cursorDiskKV WHERE key = ?",
            (f"bubbleId:{cid}:{head.get('bubbleId')}",),
        )
        try:
            bubble = json.loads(got[0][0]) if got and got[0][0] else {}
        except (ValueError, TypeError):
            continue
        if m := message(
            "user" if bubble.get("type", head.get("type")) == 1 else "assistant", bubble.get("text")
        ):
            out.append(m)
    return out


SOURCE = Source(id="cursor", name="Cursor", detect=detect, scan=scan, read_chat=read_chat,
                blurb="MCP servers, rules, commands, recent folders and chats.")  # fmt: skip
