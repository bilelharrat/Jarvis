"""GitHub Copilot in VS Code: its MCP servers (User/mcp.json, settings.json "mcp", a project's
.vscode/mcp.json), instructions (.github/copilot-instructions.md, .github/instructions,
User/prompts/*.instructions.md), prompt files (.github/prompts, User/prompts/*.prompt.md),
the folders VS Code opened, and Copilot Chat's saved sessions (workspaceStorage/*/chatSessions).
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
    file_uri,
    files_rules,
    is_dir,
    listing,
    mcp_file,
    message,
    mtime,
    project_items,
    project_rules,
    read_json,
    text_of_content,
    vscode_workspaces,
    with_folders,
)  # fmt: skip

ORDER = 40
APPS = ("Code", "Code - Insiders", "VSCodium")


def users(env: Env) -> list[Path]:
    return existing([env.vscode_user(a) for a in APPS])


def detect(env: Env) -> list[Path]:
    return users(env)


def _chats(user: Path) -> list[dict[str, Any]]:
    chats = []
    for meta in listing(user / "workspaceStorage", "*/workspace.json", 2000):
        try:
            folder = file_uri(read_json(meta).get("folder"))
        except (ReadError, AttributeError):
            folder = None
        for path in listing(meta.parent / "chatSessions", "*.json", 500):
            try:
                data = read_json(path)
            except ReadError:
                continue
            requests = data.get("requests") if isinstance(data, dict) else None
            if not requests:
                continue
            first = requests[0].get("message", {}) if isinstance(requests[0], dict) else {}
            title = data.get("customTitle") or (
                first.get("text") if isinstance(first, dict) else ""
            )
            chats.append(
                chat_entry(f"copilot:{path.stem}", title, mtime(path), path, str(folder or ""))
            )
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    chats: list[dict[str, Any]] = []
    for user in users(env):
        folders = vscode_workspaces(user)
        items += project_items("copilot", [(p, 0) for p in folders], ctx)
        with_folders(ctx, folders)
        items += mcp_file(
            "copilot", user / "mcp.json", "servers", f"{user.parent.name}/User/mcp.json", ctx
        )
        items += mcp_file(
            "copilot",
            user / "settings.json",
            "mcp.servers",
            f"{user.parent.name} settings.json",
            ctx,
        )
        items += files_rules(
            "copilot", user / "prompts", "*.instructions.md", "Copilot instructions", ctx
        )
        items += commands_in(
            "copilot",
            user / "prompts",
            "*.prompt.md",
            "Copilot prompt file",
            ctx,
            strip=".prompt.md",
        )
        chats += _chats(user)
    for folder in ctx.folders[:200]:
        items += mcp_file(
            "copilot",
            folder / ".vscode" / "mcp.json",
            "servers",
            f"{folder.name}/.vscode/mcp.json",
            ctx,
            project=folder,
        )
        if is_dir(folder / ".github" / "prompts"):
            items += commands_in("copilot", folder / ".github" / "prompts", "*.prompt.md",
                                 f"Copilot prompt file in {folder.name}", ctx, strip=".prompt.md")  # fmt: skip
    items += project_rules("copilot", ctx, (".github/copilot-instructions.md", ".github/instructions/*.instructions.md"),
                           "Copilot instructions")  # fmt: skip
    if found := chats_item("copilot", "Copilot Chat", chats, ctx):
        items.append(found)
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    data = read_json(Path(entry["path"]))
    out: list[dict[str, str]] = []
    for req in (data.get("requests") or []) if isinstance(data, dict) else []:
        if not isinstance(req, dict):
            continue
        if m := message(
            "user",
            (req.get("message") or {}).get("text") if isinstance(req.get("message"), dict) else "",
        ):
            out.append(m)
        parts = req.get("response") or []
        text = (
            "".join(
                p.get("value", "")
                for p in parts
                if isinstance(p, dict) and isinstance(p.get("value"), str)
            )
            if isinstance(parts, list)
            else text_of_content(parts)
        )
        if m := message("assistant", text):
            out.append(m)
    return out


SOURCE = Source(id="copilot", name="GitHub Copilot (VS Code)", detect=detect, scan=scan, read_chat=read_chat,
                blurb="MCP servers, instructions, prompt files, recent folders and Copilot Chat sessions.")  # fmt: skip
