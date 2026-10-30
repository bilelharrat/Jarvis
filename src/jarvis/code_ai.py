"""Eden Code's own Claude calls, and what each may cost.

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
  judge            Haiku 4.5   once a best-of-N comparison's sessions are all done: one
                               tool-less turn on at most 30,000 characters of their diffs
                               and test results                            20 a day
  pr_draft         Haiku 4.5   a pull request's title and description, when the owner
                               asks for a draft or an issue's session has finished: one
                               tool-less turn on at most 24,000 characters of the branch's
                               diff, its commit subjects and the session's last reply
                                                                           30 a day
  spec_check       Haiku 4.5   after a Spec mode task's turn, for the acceptance criteria
                               no test named after them answered: one tool-less turn on at
                               most 24,000 characters of the task's diff, its criteria and
                               the tests' outcome (features/code_spec.py)  40 a day
  assume_risk      Haiku 4.5   only with code_assume_model on (off by default): a guess a
                               session made instead of asking, that the word rules rate
                               low or medium; one tool-less turn on at most 2,000
                               characters of its question, answer and evidence
                               (features/code_assumptions.py)             100 a day
  guardrail        Haiku 4.5   when the owner presses Suggest on one of their rules that
                               the guardrails compiler couldn't turn into a check: one
                               tool-less turn on that rule's words (features/
                               code_guardrails.py); it holds only once they confirm it
                                                                           30 a day
  delegate_easy    Haiku 4.5   only with code_delegate_model on (off by default): a to-do
                               card the word rules rate easy, before Eden starts it
                               without the owner; one tool-less turn on at most 2,000
                               characters of its title and prompt; it can only say no
                               (features/code_delegate.py)                 20 a day

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

from .claude_signin import signed_in
from .prefs import MODELS

log = logging.getLogger("jarvis")

# kind -> (model key in GEMINI_MODELS / prefs.MODELS, calls a day)
GEMINI_MODELS: dict[str, str] = {
    "haiku": "gemini-3.8-flash",
    "flash": "gemini-3.8-flash",
    "sonnet": "gemini-4-argon",
    "argon": "gemini-4-argon",
}
POLICY: dict[str, tuple[str, int]] = {
    "commit_message": ("haiku", 60),
    "review": ("sonnet", 20),
    "deep_review": ("sonnet", 5),
    "judge": ("haiku", 20),
    "merge": ("haiku", 10),  # best of N's "Merge best parts" (features/code_bestof.py)
    "pr_draft": ("haiku", 30),
    "spec_check": ("haiku", 40),
    "assume_risk": ("haiku", 100),  # features/code_assumptions.py, only when the owner turns it on
    "guardrail": ("haiku", 30),  # Suggest on a rule (features/code_guardrails.py)
    "delegate_easy": ("haiku", 20),  # features/code_delegate.py, only when the owner turns it on
}
CALL_SECONDS = 90.0


class OverBudget(Exception):
    """Today's cap for this kind of call is reached."""


class Budget:
    """How many calls of each kind today, kept in a small JSON file (read defensively: a
    damaged one starts the day's counts over, never blocks the owner forever)."""

    def __init__(self, path: Path | None, caps: dict[str, int] | None = None) -> None:
        """Read when made (a feature makes it at its first call, never at install). caps:
        a day's cap for each kind, when they aren't POLICY's (a feature's own counts)."""
        self.path = path
        self.caps = caps if caps is not None else {k: v[1] for k, v in POLICY.items()}
        self.day = date.today().isoformat()
        self.counts: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
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
        day = (today or date.today()).isoformat()
        if day != self.day:
            self.day, self.counts = day, {}
        cap = self.caps[kind]
        if self.counts.get(kind, 0) >= cap:
            raise OverBudget(kind)
        self.counts[kind] = self.counts.get(kind, 0) + 1
        if self.path is not None:
            from . import jsonstore

            with contextlib.suppress(OSError):
                jsonstore.save_json(self.path, {"day": self.day, "counts": self.counts})

    def left(self, kind: str, today: date | None = None) -> int:
        day = (today or date.today()).isoformat()
        used = self.counts.get(kind, 0) if day == self.day else 0
        return max(0, self.caps[kind] - used)


def budget_for(hub: Any) -> Budget:
    """The one budget a hub's features share (two on one file would each save over the
    other's counts)."""
    found = getattr(hub, "code_ai_budget", None)
    if found is None:
        found = Budget(hub.feature_path("code_ai_usage.json"))
        hub.code_ai_budget = found
    return found


def model_for(kind: str) -> str:
    key = POLICY[kind][0]
    return GEMINI_MODELS.get(key, MODELS.get(key, "gemini-3.8-flash"))


async def call(prompt: str, **kw: Any) -> str:
    """complete(), looked up when called: what the features hold, so a test's stand-in
    for complete() (conftest refuses every real one) is always the one reached."""
    return await complete(prompt, **kw)


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
    options = signed_in(options)  # the user's own API key, if that's how Jarvis signs in
    parts: list[str] = []

    async def run() -> None:
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                parts.extend(b.text for b in message.content if isinstance(b, TextBlock))

    await asyncio.wait_for(run(), timeout)
    return "\n".join(parts).strip()
