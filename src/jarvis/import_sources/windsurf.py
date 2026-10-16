"""Windsurf (and Devin Desktop, its successor): ~/.codeium/windsurf (mcp_config.json,
memories/global_rules.md, global_workflows), a project's .windsurfrules, .windsurf/rules and
.windsurf/workflows, and the folders it opened (its VS Code-style workspaceStorage).

Cascade's chats and memories are kept encoded (.pb files): they can't be read, a note says so.
"""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    Source,
    commands_in,
    existing,
    files_rules,
    is_dir,
    listing,
    mcp_file,
    note,
    project_items,
    project_rules,
    rules_item,
    vscode_workspaces,
    with_folders,
)  # fmt: skip

ORDER = 30


def base_of(env: Env) -> Path:
    return env.home / ".codeium" / "windsurf"


def detect(env: Env) -> list[Path]:
    return existing([base_of(env), env.vscode_user("Windsurf"), env.vscode_user("Devin")])


def scan(env: Env, ctx: Context) -> list[Item]:
    base = base_of(env)
    items: list[Item] = []
    folders = [
        *vscode_workspaces(env.vscode_user("Windsurf")),
        *vscode_workspaces(env.vscode_user("Devin")),
    ]
    items += project_items("windsurf", [(p, 0) for p in folders], ctx)
    with_folders(ctx, folders)
    items += mcp_file(
        "windsurf",
        base / "mcp_config.json",
        "mcpServers",
        "~/.codeium/windsurf/mcp_config.json",
        ctx,
    )
    if found := rules_item(
        "windsurf",
        base / "memories" / "global_rules.md",
        "user",
        ctx,
        label="Windsurf global rules",
    ):
        items.append(found)
    items += files_rules("windsurf", base / "rules", "*.md", "Windsurf rule", ctx)
    items += project_rules(
        "windsurf", ctx, (".windsurfrules", ".windsurf/rules/*.md"), "Windsurf rules"
    )
    items += commands_in("windsurf", base / "global_workflows", "*.md", "Windsurf workflow", ctx)
    for folder in ctx.folders[:200]:
        items += commands_in(
            "windsurf",
            folder / ".windsurf" / "workflows",
            "*.md",
            f"Windsurf workflow in {folder.name}",
            ctx,
        )
    encoded = len(listing(base / "cascade", "*.pb", 5000)) if is_dir(base / "cascade") else 0
    if encoded:
        items.append(note("chats:windsurf", "chats", f"{encoded} Cascade conversations",
                          "Windsurf keeps them encoded, in a format only it reads: they stay in Windsurf."))  # fmt: skip
    if len(listing(base / "memories", "*.pb", 10)):
        items.append(note("memories:windsurf", "rules", "Cascade memories",
                          "Kept encoded by Windsurf. Tell Eden Code what matters with a # note, or let it learn "
                          "from your corrections (lessons)."))  # fmt: skip
    return items


SOURCE = Source(id="windsurf", name="Windsurf / Devin Desktop", detect=detect, scan=scan,
                blurb="MCP servers, global and project rules, workflows and recent folders.")  # fmt: skip
