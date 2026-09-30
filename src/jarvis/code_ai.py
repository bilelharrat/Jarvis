"""Jarvis Code's own Claude calls, and what each may cost.

The cost policy, one line per kind of call: the model, when it runs, and a cap per day
(a day's count is kept in code_ai_usage.json beside the settings; past the cap the owner
is told, and nothing is called):

  commit_message   Haiku 4.5   when the owner asks the Git panel to write a commit
                               message; one tool-less turn on at most 24,000 characters
                               of the staged diff                          60 a day
  review           Sonnet 5.5  the Review button or "review this": one tool-less turn on
                               at most 60,000 characters of the session's diff
                                                                           20 a day
  deep_review      Sonnet 5.5  the Deep review button or "deep review": three reviewers
                               at once, each reading the project (read-only, up to 8
                               turns), then one verifier (read-only, up to 10 turns);
                               four calls, counted as one deep review       5 a day

Every call is one tool-less turn unless its kind says otherwise, with none of the
owner's settings, hooks or MCP servers loaded, and a timeout. What it's shown (a diff, a
file) is data: the prompts say so, and nothing it answers is acted on without the owner.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import date
from pathlib import Path
from typing import Any

from .prefs import MODELS

log = logging.getLogger("jarvis")

# kind -> (model key in prefs.MODELS, calls a day)
POLICY: dict[str, tuple[str, int]] = {
    "commit_message": ("haiku", 60),
    "review": ("sonnet", 20),
    "deep_review": ("sonnet", 5),
}
CALL_SECONDS = 90.0


class OverBudget(Exception):
    """Today's cap for this kind of call is reached."""


class Budget:
    """How many calls of each kind today, kept in a small JSON file (read defensively: a
    damaged one starts the day's counts over, never blocks the owner forever)."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.day = ""
        self.counts: dict[str, int] = {}
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.path is None:
            return
        from . import jsonstore

        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        counts = data.get("counts")
        if isinstance(data.get("day"), str) and isinstance(counts, dict):
            self.day = data["day"]
            self.counts = {
                k: v for k, v in counts.items() if isinstance(k, str) and isinstance(v, int)
            }

    def take(self, kind: str, today: date | None = None) -> None:
        """Count one call of this kind, or raise OverBudget when today's cap is reached."""
        self._load()
        day = (today or date.today()).isoformat()
        if day != self.day:
            self.day, self.counts = day, {}
        cap = POLICY[kind][1]
        if self.counts.get(kind, 0) >= cap:
            raise OverBudget(kind)
        self.counts[kind] = self.counts.get(kind, 0) + 1
        if self.path is not None:
            from . import jsonstore

            with contextlib.suppress(OSError):
                jsonstore.save_json(self.path, {"day": self.day, "counts": self.counts})

    def left(self, kind: str, today: date | None = None) -> int:
        self._load()
        day = (today or date.today()).isoformat()
        used = self.counts.get(kind, 0) if day == self.day else 0
        return max(0, POLICY[kind][1] - used)


def budget_for(hub: Any) -> Budget:
    """The one budget a hub's features share (two on one file would each save over the
    other's counts)."""
    found = getattr(hub, "code_ai_budget", None)
    if found is None:
        found = Budget(hub.feature_path("code_ai_usage.json"))
        hub.code_ai_budget = found
    return found


def model_for(kind: str) -> str:
    return MODELS[POLICY[kind][0]]


async def complete(
    prompt: str,
    *,
    kind: str,
    system: str,
    cwd: str | None = None,
    tools: list[str] | None = None,
    can_use_tool: Any = None,
    max_turns: int = 1,
    timeout: float = CALL_SECONDS,
) -> str:
    """One call of this kind (its model from POLICY): Claude's words, joined. Tool-less
    unless tools are named, and then only as can_use_tool allows."""
    from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

    from .config import MAX_BUFFER

    options = ClaudeAgentOptions(
        max_buffer_size=MAX_BUFFER,
        model=model_for(kind),
        system_prompt=system,
        tools=list(tools or []),
        allowed_tools=[],
        setting_sources=[],
        strict_mcp_config=True,
        max_turns=max_turns,
        env={"ENABLE_TOOL_SEARCH": "false"},
        **({"cwd": cwd} if cwd else {}),
        **({"can_use_tool": can_use_tool} if can_use_tool is not None else {}),
    )
    parts: list[str] = []

    async def run() -> None:
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                parts.extend(b.text for b in message.content if isinstance(b, TextBlock))

    await asyncio.wait_for(run(), timeout)
    return "\n".join(parts).strip()
