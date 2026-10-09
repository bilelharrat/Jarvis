"""Subagent lanes in Eden Code (codelanes): each session's Agent calls as a tree, with their
steps, tokens, time and estimated cost, and a Stop for one subagent (Claude Code's
stop_task) while the rest of the session goes on.

What it adds, and where:
- TaskManager.message_sinks: every message a session takes in builds its lanes.
- TaskManager.option_hooks: forward_subagent_text, so a subagent's last message (its
  answer, which has no tool call in it) reaches the lanes too and its tokens are all
  counted. The transcript still leaves a subagent's own words out, as it did.
- Window commands: cl_lanes {id} (that session's lanes), cl_stop {id, lane}.
- Events: cl_lanes {id, lanes}, at most every PUSH_EVERY seconds per session while its
  lanes change.

Cost policy (Claude): this feature never calls a model. Its cost figures price the tokens
Claude Code reported, at the rates Claude Code's own per-model costs imply.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from .. import tasks
from ..codelanes import Lanes
from ..codeplatform import background, code_task

log = logging.getLogger("jarvis")

PUSH_EVERY = 0.5
# Its notes in a session's transcript (the window's Chinese: web/i18n/code-lanes.json).
STOPPED = "Stopped that subagent."
NOT_STOPPED = "Couldn't stop that subagent: {error}"


class LaneDesk:
    """One hub's subagent lanes, per session."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.sessions: dict[int, Lanes] = {}
        self._due: dict[int, asyncio.TimerHandle] = {}
        self._pushed: dict[int, float] = {}

    def lanes(self, task_id: int) -> Lanes:
        found = self.sessions.get(task_id)
        if found is None:
            found = self.sessions[task_id] = Lanes()
        return found

    # ── what it hears ──

    def take(self, task: Any, message: Any) -> None:
        """TaskManager.message_sinks: one message of a session's."""
        if task.kind != "code":
            return
        if self.lanes(task.id).take(message, tasks.describe_tool):
            self.push_soon(task.id)

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind != "tasks":
            return
        for task_id in set(self.sessions) - set(self.hub.tasks.tasks):
            self.sessions.pop(task_id, None)  # a session let go of: its lanes too
            self._pushed.pop(task_id, None)
            handle = self._due.pop(task_id, None)
            if handle is not None:
                handle.cancel()

    # ── the windows ──

    def push_soon(self, task_id: int) -> None:
        if task_id in self._due:
            return  # a push is due: it carries this too
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self.push(task_id)
            return
        wait = self._pushed.get(task_id, 0.0) + PUSH_EVERY - loop.time()
        if wait > 0:
            self._due[task_id] = loop.call_later(wait, self.push, task_id)
        else:
            self.push(task_id)

    def push(self, task_id: int) -> None:
        handle = self._due.pop(task_id, None)
        if handle is not None:
            handle.cancel()
        with contextlib.suppress(RuntimeError):
            self._pushed[task_id] = asyncio.get_running_loop().time()
        found = self.sessions.get(task_id)
        self.hub.emit("cl_lanes", id=task_id, lanes=found.public() if found else [])

    def cmd_lanes(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self.push(task.id)

    async def cmd_stop(self, msg: dict[str, Any]) -> None:
        """Stop one subagent (Claude Code's stop_task); the session and its other subagents
        go on."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        found = self.sessions.get(task.id)
        lane = found.lanes.get(str(msg.get("lane") or "")) if found else None
        client = task.client
        if lane is None or not lane.task_id or lane.status != "running" or client is None:
            self.push(task.id)  # (what it shows is out of date)
            return
        lane.stopping = True
        self.push(task.id)
        try:
            await client.stop_task(lane.task_id)
        except Exception as exc:  # it had just ended, or the connection went
            lane.stopping = False
            error = " ".join(str(exc).split())[:200] or type(exc).__name__
            self.hub.tasks.add_entry(task.id, "system", NOT_STOPPED.format(error=error))
        else:
            self.hub.tasks.add_entry(task.id, "system", STOPPED)
        self.push(task.id)


class _ForwardSubagentText:
    """TaskManager.option_hooks: a subagent's own words reach the lanes, for its tokens."""

    @staticmethod
    def apply(task: Any, options: Any) -> None:
        if task.kind == "code":
            options.forward_subagent_text = True

    @staticmethod
    def key(_task: Any) -> Any:
        return None


def install(hub: Any) -> None:
    desk = LaneDesk(hub)
    hub.code_lanes = desk  # (for the tests)
    hub.tasks.message_sinks.append(desk.take)
    hub.tasks.option_hooks.append(_ForwardSubagentText())
    hub.add_task_sink(desk.on_task_event)
    hub.register_command("cl_lanes", desk.cmd_lanes)
    hub.register_command("cl_stop", background(hub, desk.cmd_stop))  # (Claude Code may be slow)
