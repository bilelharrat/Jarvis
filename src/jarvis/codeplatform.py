"""What Jarvis Code's platform features share (features.code_usage, code_rules, code_lanes,
code_mcp, code_plugins): which project a session belongs to, and how to read a window
command's session.

A session in an isolated copy (features.code_isolation) works in a folder of its own, but
its spending, permission rules and sandbox allowlist are its project's: the main
checkout's folder the copy was made from.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any


def project_of(hub: Any, task: Any) -> str:
    """The project folder a session works for: an isolated copy's own project (its main
    checkout's folder), else the session's folder."""
    if getattr(task, "workspace", None):
        desk = getattr(hub, "code_desk", None)
        with contextlib.suppress(Exception):  # a copy that can't be looked up: its folder
            copy = desk.store().by_path(task.cwd) if desk is not None else None
            if copy is not None:
                return str(Path(copy.repo) / copy.prefix).rstrip("/") or str(task.cwd)
    return str(task.cwd)


def code_task(hub: Any, msg: dict[str, Any]) -> Any:
    """The Jarvis Code session a window command names by its id, or None."""
    try:
        task = hub.tasks.tasks.get(int(msg.get("id") or 0))
    except (TypeError, ValueError):
        return None
    return task if task is not None and task.kind == "code" else None


def background(hub: Any, handler: Any) -> Any:
    """A window command that can take a while (Claude Code's CLI, a card waiting for the
    owner): run in the background, so it never holds up the window's next command (the
    card's own answer among them)."""

    def start(msg: dict[str, Any]) -> None:
        hub._spawn(handler(msg))

    return start
