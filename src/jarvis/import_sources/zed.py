"""Zed: ~/.config/zed/settings.json (JSON with comments): context_servers (its MCP servers),
the agent's default model; a project's .rules (Zed's rules file). Zed's Rules Library and agent
threads live in its own databases: a note says so."""

from __future__ import annotations

from pathlib import Path

from ..code_import import (
    Context,
    Env,
    Item,
    ReadError,
    Source,
    existing,
    is_dir,
    is_file,
    mcp_file,
    model_item,
    note,
    project_rules,
    read_json,
)  # fmt: skip

ORDER = 80


def settings_of(env: Env) -> list[Path]:
    return [d / "settings.json" for d in env.config_dirs("zed")] + [
        env.app_data() / "Zed" / "settings.json"
    ]


def detect(env: Env) -> list[Path]:
    return existing([*(d for d in env.config_dirs("zed")), env.app_data() / "Zed"])


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    for path in settings_of(env):
        if not is_file(path):
            continue
        items += mcp_file("zed", path, "context_servers", "Zed settings.json", ctx)
        try:
            data = read_json(path)
        except ReadError:
            continue
        agent = data.get("agent") or data.get("assistant") if isinstance(data, dict) else None
        model = agent.get("default_model") if isinstance(agent, dict) else None
        if isinstance(model, dict):
            if found := model_item(
                "zed", "Zed", model.get("model"), ctx, where=f"Zed ({model.get('provider', '')})"
            ):
                items.append(found)
    items += project_rules("zed", ctx, (".rules",), "Zed rules")
    if is_dir(env.app_data() / "Zed" / "prompts") or is_dir(env.app_data() / "Zed" / "threads"):
        items.append(note("rules:zed-library", "rules", "Zed's Rules Library and agent threads",
                          "Zed keeps them in its own database: copy a rule into a rules file to bring it."))  # fmt: skip
    return items


SOURCE = Source(id="zed", name="Zed", detect=detect, scan=scan,
                blurb="MCP servers (context servers), default model and .rules files.")  # fmt: skip
