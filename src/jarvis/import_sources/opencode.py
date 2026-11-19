"""OpenCode: ~/.config/opencode (opencode.json or .jsonc: mcp, model, providers; AGENTS.md;
command/*.md), a project's opencode.json and AGENTS.md. A provider's key is never copied; its
sessions are kept in parts in its storage folder: a note says so."""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    ReadError,
    Source,
    agents_md_items,
    commands_in,
    error_item,
    existing,
    is_dir,
    is_file,
    key_note,
    listing,
    mcp_items,
    model_item,
    note,
    read_json,
    rules_item,
)  # fmt: skip

ORDER = 90
NAMES = ("opencode.json", "opencode.jsonc", "config.json")


def dirs(env: Env) -> list[Path]:
    return env.config_dirs("opencode")


def detect(env: Env) -> list[Path]:
    return existing([*dirs(env), env.local_share() / "opencode"])


def _config(path: Path, ctx: Context, items: list[Item], project: Path | None = None) -> None:
    try:
        data = read_json(path)
    except ReadError as exc:
        items.append(error_item("opencode", path, exc))
        return
    if not isinstance(data, dict):
        return
    found = mcp_items(
        "opencode",
        data.get("mcp"),
        path.name if project is None else f"{project.name}/{path.name}",
        ctx,
    )
    for item in found:
        if project is not None and item.payload:
            item.payload["project"] = str(project)
    items += found
    if found_model := model_item("opencode", "OpenCode", data.get("model"), ctx, where=path.name):
        items.append(found_model)
    for pid, provider in (
        (data.get("provider") or {}).items() if isinstance(data.get("provider"), dict) else ()
    ):
        options = provider.get("options") if isinstance(provider, dict) else None
        if isinstance(options, dict) and options.get("apiKey"):
            items.append(key_note("opencode", "OpenCode", str(pid), path))


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    for base in dirs(env):
        for name in NAMES:
            if is_file(base / name):
                _config(base / name, ctx, items)
                break
        if found := rules_item(
            "opencode", base / "AGENTS.md", "user", ctx, label="OpenCode AGENTS.md"
        ):
            items.append(found)
        for sub in ("command", "commands"):
            items += commands_in("opencode", base / sub, "*.md", "OpenCode command", ctx)
    for folder in ctx.folders[:200]:
        for name in NAMES[:2]:
            if is_file(folder / name):
                _config(folder / name, ctx, items, project=folder)
    items += agents_md_items("opencode", ctx)
    storage = env.local_share() / "opencode" / "storage" / "session"
    if is_dir(storage):
        n = len(listing(storage, "*/*.json", 5000))
        if n:
            items.append(note("chats:opencode", "chats", f"{n} OpenCode sessions",
                              "OpenCode keeps each one in many small parts: they stay in OpenCode (opencode "
                              "export prints one)."))  # fmt: skip
    return items


SOURCE = Source(id="opencode", name="OpenCode", detect=detect, scan=scan,
                blurb="MCP servers, model, AGENTS.md and commands.")  # fmt: skip
