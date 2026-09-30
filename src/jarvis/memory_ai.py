"""The long-term memory features' own Claude calls, and what each may cost.

The cost policy, one line per kind of call: the model, when it runs, and its caps (a day's
count is kept in memory_ai_usage.json beside the settings, an hour's in memory; past a cap
nothing is called and the feature carries on without it):

  memory_notice  Haiku 4.5  after a conversation has been quiet for four minutes, and only
                            when the owner's own requests since the last look say something
                            about themselves; one tool-less turn on at most 6,000
                            characters of their words, at least ten minutes apart
                                                              24 a day, 6 an hour
  journal        Haiku 4.5  the daily note's summary: once a day at the note's time (or
                            at first use the next day), on at most 8,000 characters of the
                            day's requests, actions, meetings and routines; without it the
                            note is written without its summary       3 a day, 2 an hour
  dream          Haiku 4.5  the nightly consolidation: once a night (after 2 AM, or at
                            first use in the morning), on the last three daily notes, at
                            most 12,000 characters                     2 a day, 1 an hour
  intent_match   Haiku 4.5  a standing intent set to match by meaning: only for arrivals
                            its words-and-people check already let through, at most 12
                            in one call                               40 a day, 10 an hour
  commitments    Haiku 4.5  "Track my promises" on: sent mail and texts with promise-like
                            words, at most 20 items (8,000 characters) in one call, every
                            half hour at most                         12 a day, 3 an hour

Every call is one tool-less turn through code_ai.complete (none of the owner's settings,
hooks or MCP servers, and a timeout), so a test that forgets to fake it fails loudly. What
each is shown is data: the prompts say so, and what comes back is checked (its shape, no
secrets, nothing already known) before the owner sees it. Nothing it answers is kept
without the owner: suggestions wait on a card, notes are the owner's own files.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections import deque
from datetime import date
from pathlib import Path
from typing import Any

from . import code_ai

log = logging.getLogger("jarvis")

# kind -> (model key in prefs.MODELS, calls a day, calls an hour)
POLICY: dict[str, tuple[str, int, int]] = {
    "memory_notice": ("haiku", 24, 6),
    "journal": ("haiku", 3, 2),
    "dream": ("haiku", 2, 1),
    "intent_match": ("haiku", 40, 10),
    "commitments": ("haiku", 12, 3),
}
# code_ai.complete finds each kind's model in its own table.
for _kind, (_model, _per_day, _) in POLICY.items():
    code_ai.POLICY.setdefault(_kind, (_model, _per_day))


class Budget:
    """Calls of each kind made today (kept in a file: a restart doesn't reset the day) and
    this hour (in memory)."""

    def __init__(self, path: Path | None) -> None:
        self.day = code_ai.Budget(path)
        self.hour: dict[str, deque[float]] = {}

    def take(self, kind: str, today: date | None = None, now: float | None = None) -> bool:
        """Count one call of this kind: False (and nothing counted) past a cap."""
        now = time.monotonic() if now is None else now
        recent = self.hour.setdefault(kind, deque())
        while recent and now - recent[0] > 3600:
            recent.popleft()
        if len(recent) >= POLICY[kind][2]:
            return False
        try:
            self.day.take(kind, today)
        except code_ai.OverBudget:
            return False
        recent.append(now)
        return True

    def left(self, kind: str) -> int:
        return self.day.left(kind)


_JSON = re.compile(r"\{.*\}|\[.*\]", re.S)


def parse_json(reply: str) -> Any:
    """The JSON in a model's reply (the first object or list in it); None when there's
    none that parses."""
    if not isinstance(reply, str):
        return None
    found = _JSON.search(reply.strip())
    if not found:
        return None
    try:
        return json.loads(found.group())
    except ValueError:
        return None


async def ask_json(ai: Any, budget: Budget, kind: str, system: str, prompt: str) -> Any:
    """One capped call of this kind, its answer's JSON. None when the cap is reached, the
    call fails or the answer holds no JSON: every caller carries on without it."""
    if not budget.take(kind):
        log.info("memory: today's or this hour's %s calls are used up", kind)
        return None
    try:
        reply = await ai(prompt, kind=kind, system=system)
    except Exception as exc:  # offline, signed out, a timeout: said in the log only
        log.warning("memory: the %s call failed: %s", kind, str(exc)[:200])
        return None
    return parse_json(reply)
