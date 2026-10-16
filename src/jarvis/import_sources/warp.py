"""Warp: a project's WARP.md (Warp's rules file) comes over as rules; Warp keeps its global
rules and MCP servers in its own database (Warp Drive), so a note says how to bring them."""

from __future__ import annotations

from pathlib import Path

from ..code_import import Context, Env, Item, Source, existing, note, project_rules

ORDER = 130


def detect(env: Env) -> list[Path]:
    return existing([
        env.home / ".warp",
        env.app_data() / "dev.warp.Warp-Stable",
        env.home / "Library" / "Group Containers" / "2BBY89MBSN.dev.warp",
        env.app_data() / "warp" / "Warp",
    ])  # fmt: skip


def scan(env: Env, ctx: Context) -> list[Item]:
    items = project_rules("warp", ctx, ("WARP.md",), "WARP.md")
    if detect(env):
        items.append(note("warp:drive", "rules", "Warp's rules and MCP servers",
                          "Warp keeps them in Warp Drive, not in a file: copy a rule into a rules file, and add a "
                          "server in Eden Code's MCP servers pane.", status="manual"))  # fmt: skip
    return items


SOURCE = Source(id="warp", name="Warp", detect=detect, scan=scan, blurb="WARP.md rules files.")
