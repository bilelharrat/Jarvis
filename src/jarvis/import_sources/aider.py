"""Aider: ~/.aider.conf.yml and a project's .aider.conf.yml (model, the conventions files it
reads), CONVENTIONS.md, and each project's .aider.chat.history.md (the read-only history: one
chat per "# aider chat started at" heading). API keys in its settings are never copied."""

from __future__ import annotations

import re
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
    error_item,
    existing,
    is_file,
    key_note,
    message,
    model_item,
    read_text,
    read_yaml,
    rules_item,
)  # fmt: skip

ORDER = 70
KEYS = {"openai-api-key": "OpenAI", "anthropic-api-key": "Anthropic"}
STARTED = re.compile(r"^# aider chat started at (.+)$", re.M)


def detect(env: Env) -> list[Path]:
    return existing([env.home / ".aider.conf.yml", env.home / ".aider"])


def _config(source: str, path: Path, ctx: Context, project: Path | None, items: list[Item]) -> None:
    if not is_file(path):
        return
    try:
        data = read_yaml(path)
    except ReadError as exc:
        items.append(error_item(source, path, exc))
        return
    if not isinstance(data, dict):
        return
    if found := model_item(source, "Aider", data.get("model"), ctx, where=path.name):
        items.append(found)
    for key, what in KEYS.items():
        if data.get(key):
            items.append(key_note(source, "Aider", what, path))
    keys = data.get("api-key")
    for entry in keys if isinstance(keys, list) else [keys] if keys else []:
        provider = str(entry).split("=", 1)[0] if "=" in str(entry) else "provider"
        items.append(key_note(source, "Aider", provider.capitalize(), path))
    reads = data.get("read")
    for rel in reads if isinstance(reads, list) else [reads] if isinstance(reads, str) else []:
        base = project or path.parent
        target = (
            (base / str(rel)).expanduser()
            if not str(rel).startswith(("/", "~"))
            else Path(str(rel)).expanduser()
        )
        if found := rules_item(source, target, "project" if project else "user", ctx, project=project,
                               label=f"Aider reads: {target.name}"):  # fmt: skip
            items.append(found)


def _chats(folder: Path) -> list[dict[str, Any]]:
    path = folder / ".aider.chat.history.md"
    if not is_file(path):
        return []
    try:
        text = read_text(path, 50_000_000)
    except ReadError:
        return []
    chats = []
    starts = list(STARTED.finditer(text))
    for n, m in enumerate(starts):
        end = starts[n + 1].start() if n + 1 < len(starts) else len(text)
        body = text[m.end() : end]
        first = next((ln[5:] for ln in body.splitlines() if ln.startswith("#### ")), "")
        if not first:
            continue
        when = 0.0
        try:
            from datetime import datetime

            when = datetime.fromisoformat(m.group(1).strip()).timestamp()
        except ValueError:
            pass
        chats.append(chat_entry(f"aider:{folder}#{n}", first, when, path, str(folder), part=n))
    return chats


def scan(env: Env, ctx: Context) -> list[Item]:
    items: list[Item] = []
    _config("aider", env.home / ".aider.conf.yml", ctx, None, items)
    chats: list[dict[str, Any]] = []
    for folder in ctx.folders[:200]:
        _config("aider", folder / ".aider.conf.yml", ctx, folder, items)
        if found := rules_item("aider", folder / "CONVENTIONS.md", "project", ctx, project=folder,
                               label=f"CONVENTIONS.md: {folder.name}"):  # fmt: skip
            items.append(found)
        chats += _chats(folder)
    if found := chats_item("aider", "Aider", chats, ctx):
        items.append(found)
    return items


def read_chat(entry: dict[str, Any]) -> list[dict[str, str]]:
    text = read_text(Path(entry["path"]), 50_000_000)
    starts = list(STARTED.finditer(text))
    n = int(entry.get("part", 0))
    if n >= len(starts):
        return []
    body = text[starts[n].end() : starts[n + 1].start() if n + 1 < len(starts) else len(text)]
    out: list[dict[str, str]] = []
    reply: list[str] = []
    for line in body.splitlines():
        if line.startswith("#### "):
            if reply and (m := message("assistant", "\n".join(reply))):
                out.append(m)
            reply = []
            if m := message("user", line[5:]):
                out.append(m)
        elif not line.startswith("> "):
            reply.append(line)
    if reply and (m := message("assistant", "\n".join(reply))):
        out.append(m)
    return out


SOURCE = Source(id="aider", name="Aider", detect=detect, scan=scan, read_chat=read_chat,
                blurb="Model, conventions files and each project's chat history.")  # fmt: skip
