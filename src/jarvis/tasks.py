"""Claude Code tasks: coding agents JARVIS starts in your project folders.

Each task is its own Claude Code session with the full tool set, working in the
background. Reading and searching run freely; every edit and every shell command waits
for the user's answer in the app ("Allow all edits" covers the rest of that task's
edits, never its commands).
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ToolPermissionContext,
    ToolUseBlock,
    create_sdk_mcp_server,
    tool,
)

from .config import Settings

READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite"]
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}

ALLOW, ALLOW_EDITS, DENY = "allow", "allow_edits", "deny"

# (question, detail, [(choice id, button label)]) -> chosen id
Approve = Callable[[str, str, list[tuple[str, str]]], Awaitable[str]]
Emit = Callable[..., None]


@dataclass
class ClaudeTask:
    id: int
    prompt: str
    cwd: Path
    status: str = "running"
    last_action: str = "Starting"
    result: str = ""
    cost_usd: float | None = None
    allow_edits: bool = False
    started: datetime = field(default_factory=datetime.now)
    handle: asyncio.Task | None = None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "prompt": self.prompt,
            "folder": self.cwd.name,
            "status": self.status,
            "last_action": self.last_action,
            "result": self.result,
            "cost_usd": self.cost_usd,
            "started": self.started.isoformat(timespec="seconds"),
        }


def describe_tool(name: str, tool_input: dict[str, Any]) -> str:
    path = tool_input.get("file_path") or tool_input.get("path") or ""
    short = Path(path).name if path else ""
    if name == "Bash":
        return f"Running {tool_input.get('command', '')[:80]}"
    if name in EDIT_TOOLS:
        return f"Editing {short}" if name != "Write" else f"Writing {short}"
    if name == "Read":
        return f"Reading {short}"
    if name in ("Grep", "Glob"):
        return f"Searching for {tool_input.get('pattern', '')[:60]}"
    return name


def approval_detail(name: str, tool_input: dict[str, Any], cwd: Path) -> str:
    if name == "Bash":
        return f"$ {tool_input.get('command', '')}"
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    try:
        path = str(Path(path).relative_to(cwd))
    except ValueError:
        pass
    if name in ("Edit", "MultiEdit"):
        edits = tool_input.get("edits") or [tool_input]
        lines = [path]
        for edit in edits[:3]:
            lines += [f"- {line}" for line in str(edit.get("old_string", "")).splitlines()[:6]]
            lines += [f"+ {line}" for line in str(edit.get("new_string", "")).splitlines()[:6]]
        return "\n".join(lines)
    if name == "Write":
        body = str(tool_input.get("content", "")).splitlines()[:10]
        return "\n".join([f"{path} (new contents)"] + [f"+ {line}" for line in body])
    return f"{name} {path}".strip()


class TaskManager:
    def __init__(
        self,
        settings: Settings,
        approve: Approve,
        emit: Emit,
        client_factory: Callable[..., Any] = ClaudeSDKClient,
    ) -> None:
        self.settings = settings
        self.approve = approve
        self.emit = emit
        self.client_factory = client_factory
        self.tasks: dict[int, ClaudeTask] = {}
        self._ids = itertools.count(1)

    # ── folders ──

    def resolve_dir(self, directory: str) -> Path:
        raw = Path(directory.strip()).expanduser()
        candidates = [raw] if raw.is_absolute() else [self.settings.projects_dir / raw]
        roots = {Path.home().resolve(), self.settings.projects_dir.resolve()}
        for candidate in candidates:
            path = candidate.resolve()
            if path.is_dir() and any(path == r or r in path.parents for r in roots):
                return path
        raise ValueError(
            f"No project folder called {directory!r}. Known projects: {', '.join(self.projects())}"
        )

    def projects(self) -> list[str]:
        root = self.settings.projects_dir
        if not root.is_dir():
            return []
        return sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))

    # ── lifecycle ──

    def start(self, prompt: str, directory: str) -> ClaudeTask:
        task = ClaudeTask(
            id=next(self._ids), prompt=prompt.strip(), cwd=self.resolve_dir(directory)
        )
        self.tasks[task.id] = task
        task.handle = asyncio.create_task(self._run(task))
        self._changed()
        return task

    def cancel(self, task_id: int) -> bool:
        task = self.tasks.get(task_id)
        if task is None or task.handle is None or task.handle.done():
            return False
        task.handle.cancel()
        return True

    async def close(self) -> None:
        for task in self.tasks.values():
            if task.handle is not None and not task.handle.done():
                task.handle.cancel()

    def public(self) -> list[dict[str, Any]]:
        return [t.public() for t in sorted(self.tasks.values(), key=lambda t: -t.id)]

    def _changed(self) -> None:
        self.emit("tasks", items=self.public())

    def options_for(self, task: ClaudeTask) -> ClaudeAgentOptions:
        return ClaudeAgentOptions(
            model=self.settings.model,
            effort=self.settings.task_effort,
            cwd=str(task.cwd),
            tools={"type": "preset", "preset": "claude_code"},
            allowed_tools=list(READ_ONLY_TOOLS),
            permission_mode="default",
            can_use_tool=self.policy_for(task),
            # The project's own CLAUDE.md and settings apply, as in a normal session there.
            setting_sources=["project"],
        )

    async def _run(self, task: ClaudeTask) -> None:
        try:
            async with self.client_factory(options=self.options_for(task)) as client:
                await client.query(task.prompt)
                async for message in client.receive_response():
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, ToolUseBlock):
                                task.last_action = describe_tool(block.name, block.input)
                                self._changed()
                            elif isinstance(block, TextBlock) and block.text.strip():
                                task.result = block.text.strip()
                    elif isinstance(message, ResultMessage):
                        task.cost_usd = message.total_cost_usd
                        task.result = (message.result or task.result).strip()
                        task.status = "failed" if message.is_error else "done"
        except asyncio.CancelledError:
            task.status = "stopped"
            raise
        except Exception as exc:  # the CLI crashed or refused to start
            task.status = "failed"
            task.result = str(exc)
        finally:
            if task.status == "running":
                task.status = "done"
            task.last_action = {"done": "Finished", "stopped": "Stopped"}.get(task.status, "Failed")
            self._changed()
            self.emit(
                "task_finished",
                id=task.id,
                folder=task.cwd.name,
                status=task.status,
                result=task.result[-600:],
            )

    # ── permissions ──

    def policy_for(self, task: ClaudeTask):
        async def can_use_tool(
            tool_name: str, tool_input: dict[str, Any], _context: ToolPermissionContext
        ):
            if tool_name in READ_ONLY_TOOLS:
                return PermissionResultAllow()
            if tool_name in EDIT_TOOLS and task.allow_edits:
                return PermissionResultAllow()
            choices = [(ALLOW, "Allow")]
            if tool_name in EDIT_TOOLS:
                choices.append((ALLOW_EDITS, "Allow all edits"))
            choices.append((DENY, "Deny"))
            verb = "run a command" if tool_name == "Bash" else f"use {tool_name}"
            if tool_name in EDIT_TOOLS:
                verb = "edit a file"
            task.last_action = "Waiting for you"
            self._changed()
            choice = await self.approve(
                f"Claude Code in {task.cwd.name} wants to {verb}",
                approval_detail(tool_name, tool_input, task.cwd),
                choices,
            )
            if choice == ALLOW_EDITS:
                task.allow_edits = True
            if choice in (ALLOW, ALLOW_EDITS):
                return PermissionResultAllow()
            return PermissionResultDeny(message="The user declined this step.")

        return can_use_tool

    # ── JARVIS's tools for driving tasks ──

    def build_server(self):
        @tool(
            "run_claude_code",
            "Start a Claude Code agent in one of the user's project folders to do a coding "
            "task in the background. directory: a folder name under the projects folder "
            "(e.g. bsh-research-center) or an absolute path. Asks the user first.",
            {"task": str, "directory": str},
        )
        async def run_claude_code(args):
            try:
                task = self.start(args["task"], args["directory"])
            except ValueError as exc:
                return {"content": [{"type": "text", "text": str(exc)}], "is_error": True}
            return {
                "content": [
                    {
                        "type": "text",
                        "text": f"Started Claude Code task {task.id} in {task.cwd.name}. "
                        "Its progress shows in the app.",
                    }
                ]
            }

        @tool(
            "claude_task_status",
            "List the Claude Code tasks started this session with their status and results, "
            "plus the known project folders.",
            {},
        )
        async def claude_task_status(_args):
            lines = [
                f"Task {t.id} in {t.cwd.name}: {t.status}. {t.last_action}. {t.result[-300:]}"
                for t in self.tasks.values()
            ] or ["No tasks yet."]
            lines.append("Projects: " + ", ".join(self.projects()))
            return {"content": [{"type": "text", "text": "\n".join(lines)}]}

        return create_sdk_mcp_server(
            name="claude", version="0.1.0", tools=[run_claude_code, claude_task_status]
        )
