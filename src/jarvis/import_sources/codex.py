"""OpenAI Codex CLI (~/.codex, or CODEX_HOME): config.toml (model, MCP servers, trusted
projects, providers), AGENTS.md, prompts, and past sessions (sessions/**/rollout-*.jsonl).

- config.toml model → Eden Code's default model when Eden has it (else a note); a provider's
  key (env_key) is never read: a note says where Eden takes keys.
- [mcp_servers.*] → Eden Code's imported MCP servers (a key in env only when ticked).
- ~/.codex/AGENTS.md → the owner's rules for every project; a project's AGENTS.md is read by
  Eden Code already (when it has no CLAUDE.md).
- prompts/*.md → saved prompts (/name).
- [projects."<path>"] and each session's folder → Eden Code's projects.
- sessions → the read-only history (Codex's own format: read, not continued).
"""

from __future__ import annotations

import os
from collections import Counter
from pathlib import Path
from typing import Any

from ..code_import import (
    Context,
    Env,
    Item,
    ReadError,
    Source,
    agents_md_items,
    chat_entry,
    chats_item,
    commands_in,
    error_item,
    existing,
    is_file,
    jsonl,
    listing,
    mcp_items,
    message,
    model_item,
    mtime,
    note,
    project_items,
    read_toml,
    rules_item,
    text_of_content,
    with_folders,
)  # fmt: skip

ORDER = 10
SKIP_PROMPTS = ("<environment_context>", "<user_instructions>", "# AGENTS.md", "<permissions")


def home_of(env: Env) -> Path:
    given = os.environ.get("CODEX_HOME", "").strip()
    return Path(given).expanduser() if given else env.home / ".codex"


def detect(env: Env) -> list[Path]:
    return existing([home_of(env)])


def _meta(path: Path) -> dict[str, Any]:
    """A rollout's id, folder, start and first prompt."""
    out: dict[str, Any] = {}
    for i, line in enumerate(jsonl(path, limit=8_000_000)):
        if i > 200:
            break
        payload = line.get("payload") if isinstance(line.get("payload"), dict) else line
        if line.get("type") == "session_meta" or (i == 0 and "id" in line and "timestamp" in line):
            out.setdefault("id", payload.get("id"))
            out.setdefault("cwd", payload.get("cwd"))
        if payload.get("type") == "message" and payload.get("role") == "user":
            text = text_of_content(payload.get("content")).strip()
            if text and not text.startswith(SKIP_PROMPTS):
                out.setdefault("title", text)
                break
        if line.get("type") == "turn_context" and isinstance(payload.get("cwd"), str):
            out.setdefault("cwd", payload["cwd"])
    return out


def _chats(base: Path) -> list[dict[str, Any]]:
    chats = []
    for path in listing(base / "sessions", "**/rollout-*.jsonl", 3000):
        meta = _meta(path)
        cid = str(meta.get("id") or path.stem)
        chats.append(chat_entry(f"codex:{cid}", meta.get("title") or path.stem, mtime(path), path,
                                str(meta.get("cwd") or "")))  # fmt: skip
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    base = home_of(env)
    items: list[Item] = []
    config: dict[str, Any] = {}
    path = base / "config.toml"
    if is_file(path):
        try:
            config = read_toml(path)
        except ReadError as exc:
            items.append(error_item("codex", path, exc))
    chats = _chats(base)
    counts = Counter(c["project"] for c in chats if c["project"])
    trusted = (
        [p for p in (config.get("projects") or {}) if isinstance(p, str)]
        if isinstance(config.get("projects"), dict)
        else []
    )
    folders = sorted({*trusted, *counts}, key=lambda p: -counts.get(p, 0))
    items += project_items(
        "codex", [(Path(p), counts.get(p, 0)) for p in folders if p != str(env.home)], ctx
    )
    with_folders(ctx, [Path(p) for p in folders])
    if found := model_item("codex", "Codex", config.get("model"), ctx, where="config.toml"):
        items.append(found)
    providers = (
        config.get("model_providers") if isinstance(config.get("model_providers"), dict) else {}
    )
    for pid, provider in list(providers.items())[:20]:
        if isinstance(provider, dict) and provider.get("env_key"):
            items.append(note(f"provider:{pid}", "model", f"Provider {pid}",
                              f"Codex reads its key from ${provider['env_key']}. Eden never copies keys: add it in "
                              "Settings › Models, where it goes into the Keychain.", status="manual"))  # fmt: skip
    items += mcp_items("codex", config.get("mcp_servers"), "config.toml", ctx)
    for name in ("AGENTS.md", "AGENTS.override.md"):
        if found := rules_item("codex", base / name, "user", ctx, label=f"Codex {name}"):
            items.append(found)
    items += agents_md_items("codex", ctx)
    items += commands_in("codex", base / "prompts", "*.md", "Codex prompt", ctx)
    if found := chats_item("codex", "Codex", chats, ctx):
        items.append(found)
    if is_file(base / "auth.json"):
        items.append(note("signin:codex", "signin", "Codex sign-in",
                          "Codex's own login stays Codex's. To run Codex inside Eden Code, add it under "
                          "Other agents (ACP); it signs in by itself there."))  # fmt: skip
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for line in jsonl(Path(entry["path"])):
        payload = line.get("payload") if isinstance(line.get("payload"), dict) else line
        if payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
            text = text_of_content(payload.get("content"))
            if payload["role"] == "user" and text.strip().startswith(SKIP_PROMPTS):
                continue
            if m := message(payload["role"], text):
                out.append(m)
    return out


SOURCE = Source(id="codex", name="OpenAI Codex CLI", detect=detect, scan=scan, read_chat=read_chat,
                blurb="config.toml (model, MCP servers), AGENTS.md, prompts and past sessions.")  # fmt: skip
