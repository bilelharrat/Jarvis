"""Kiro: ~/.kiro/settings/mcp.json and a project's .kiro/settings/mcp.json, steering files
(~/.kiro/steering/*.md for every project, .kiro/steering/*.md for one), specs (.kiro/specs: in
the repo already), and the folders it opened (its VS Code-style workspaceStorage)."""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    Source,
    already,
    existing,
    files_rules,
    is_dir,
    listing,
    mcp_file,
    project_items,
    project_rules,
    vscode_workspaces,
    with_folders,
)  # fmt: skip

ORDER = 120


def detect(env: Env) -> list[Path]:
    return existing([env.home / ".kiro", env.vscode_user("Kiro")])


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    folders = vscode_workspaces(env.vscode_user("Kiro"))
    items += project_items("kiro", [(p, 0) for p in folders], ctx)
    with_folders(ctx, folders)
    items += mcp_file(
        "kiro",
        env.home / ".kiro" / "settings" / "mcp.json",
        "mcpServers",
        "~/.kiro/settings/mcp.json",
        ctx,
    )
    items += files_rules("kiro", env.home / ".kiro" / "steering", "*.md", "Kiro steering", ctx)
    for folder in ctx.folders[:200]:
        items += mcp_file("kiro", folder / ".kiro" / "settings" / "mcp.json", "mcpServers",
                          f"{folder.name}/.kiro/settings/mcp.json", ctx, project=folder)  # fmt: skip
        specs = (
            listing(folder / ".kiro" / "specs", "*", 100)
            if is_dir(folder / ".kiro" / "specs")
            else []
        )
        if specs:
            items.append(already(f"specs:{folder}", "rules", f"Kiro specs: {folder.name} ({len(specs)})",
                                 "They're files in the project: any Eden Code session can read them, and Spec mode "
                                 "(/spec) works the same way."))  # fmt: skip
    items += project_rules("kiro", ctx, (".kiro/steering/*.md",), "Kiro steering")
    return items


SOURCE = Source(id="kiro", name="Kiro", detect=detect, scan=scan,
                blurb="MCP servers, steering files, specs and recent folders.")  # fmt: skip
