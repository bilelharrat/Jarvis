"""Amp (Sourcegraph's): ~/.config/amp/settings.json ("amp.mcpServers"), ~/.config/amp/AGENTS.md
(and ~/.config/AGENTS.md), a project's AGENTS.md. Amp keeps its threads on ampcode.com: a note
says so."""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    Source,
    agents_md_items,
    existing,
    mcp_file,
    note,
    rules_item,
)  # fmt: skip

ORDER = 110


def detect(env: Env) -> list[Path]:
    return existing([d for d in env.config_dirs("amp")])


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    for base in env.config_dirs("amp"):
        for name in ("settings.json", "settings.jsonc"):
            items += mcp_file(
                "amp", base / name, ("amp.mcpServers", "mcpServers"), f"Amp {name}", ctx
            )
        if found := rules_item("amp", base / "AGENTS.md", "user", ctx, label="Amp AGENTS.md"):
            items.append(found)
    if found := rules_item(
        "amp", env.config() / "AGENTS.md", "user", ctx, label="~/.config/AGENTS.md"
    ):
        items.append(found)
    items += agents_md_items("amp", ctx)
    if detect(env):
        items.append(note("chats:amp", "chats", "Amp threads",
                          "Amp keeps them on ampcode.com, not on this computer: they stay there."))  # fmt: skip
    return items


SOURCE = Source(id="amp", name="Amp", detect=detect, scan=scan, blurb="MCP servers and AGENTS.md.")
