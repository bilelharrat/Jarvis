"""Roo Code (a Cline fork): its MCP settings (globalStorage/rooveterinaryinc.roo-cline/settings/
mcp_settings.json, a project's .roo/mcp.json), rules (.roo/rules, .roorules, ~/.roo/rules),
commands (.roo/commands, ~/.roo/commands), custom modes (a note: Eden Code has subagents
instead) and task history (as Cline's)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..code_import import (
    Context,
    Env,
    Item,
    Source,
    chats_item,
    commands_in,
    existing,
    files_rules,
    is_dir,
    is_file,
    mcp_file,
    note,
    project_rules,
)  # fmt: skip
from .cline import read_task, storages, tasks_of

ORDER = 61
EXTENSION = "rooveterinaryinc.roo-cline"


def detect(env: Env) -> list[Path]:
    return [*storages(env, EXTENSION), *existing([env.home / ".roo"])]


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    chats: list[dict[str, Any]] = []
    for storage in storages(env, EXTENSION):
        editor = storage.parent.parent.parent.name
        items += mcp_file(
            "roo_code",
            storage / "settings" / "mcp_settings.json",
            "mcpServers",
            f"Roo Code in {editor}",
            ctx,
        )
        chats += tasks_of(storage, "roo_code")
        for name in ("custom_modes.yaml", "custom_modes.json"):
            if is_file(storage / "settings" / name):
                items.append(note(f"modes:{storage}", "setting", "Roo Code custom modes",
                                  "Eden Code has no modes of that kind: make each one a subagent "
                                  "(/plugins › Agents) to keep it.", status="manual"))  # fmt: skip
    for folder in ctx.folders[:200]:
        items += mcp_file(
            "roo_code",
            folder / ".roo" / "mcp.json",
            "mcpServers",
            f"{folder.name}/.roo/mcp.json",
            ctx,
            project=folder,
        )
        if is_dir(folder / ".roo" / "commands"):
            items += commands_in(
                "roo_code",
                folder / ".roo" / "commands",
                "*.md",
                f"Roo command in {folder.name}",
                ctx,
            )
    items += files_rules("roo_code", env.home / ".roo" / "rules", "*.md", "Roo rule", ctx)
    items += commands_in("roo_code", env.home / ".roo" / "commands", "*.md", "Roo command", ctx)
    items += project_rules("roo_code", ctx, (".roorules", ".roo/rules/*.md"), "Roo rules")
    if found := chats_item("roo_code", "Roo Code", chats, ctx):
        items.append(found)
    return items


SOURCE = Source(id="roo_code", name="Roo Code", detect=detect, scan=scan, read_chat=read_task,
                blurb="MCP servers, rules, commands and task history.")  # fmt: skip
