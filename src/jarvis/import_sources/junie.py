"""JetBrains Junie: a project's .junie/guidelines.md (rules) and .junie/mcp/mcp.json, ~/.junie/mcp
for every project, and the projects JetBrains IDEs opened (recentProjects.xml)."""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    Source,
    existing,
    listing,
    mcp_file,
    project_items,
    project_rules,
    recent_projects_xml,
    with_folders,
)  # fmt: skip

ORDER = 140


def ide_dirs(env: Env) -> list[Path]:
    return listing(env.app_data() / "JetBrains", "*", 50)


def detect(env: Env) -> list[Path]:
    return existing(
        [env.home / ".junie", *(d / "options" / "recentProjects.xml" for d in ide_dirs(env))]
    )


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    folders: list[Path] = []
    for ide in ide_dirs(env):
        for path in recent_projects_xml(ide / "options" / "recentProjects.xml", env.home):
            if path not in folders:
                folders.append(path)
    items += project_items("junie", [(p, 0) for p in folders], ctx)
    with_folders(ctx, folders)
    items += mcp_file(
        "junie",
        env.home / ".junie" / "mcp" / "mcp.json",
        "mcpServers",
        "~/.junie/mcp/mcp.json",
        ctx,
    )
    for folder in ctx.folders[:200]:
        items += mcp_file("junie", folder / ".junie" / "mcp" / "mcp.json", "mcpServers",
                          f"{folder.name}/.junie/mcp/mcp.json", ctx, project=folder)  # fmt: skip
    items += project_rules("junie", ctx, (".junie/guidelines.md",), "Junie guidelines")
    return items


SOURCE = Source(id="junie", name="JetBrains Junie", detect=detect, scan=scan,
                blurb="Guidelines, MCP servers and the projects your JetBrains IDEs opened.")  # fmt: skip
