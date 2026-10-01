"""Loop detection: a model calling the same tool the same way over and over, or going round
between two or three calls, without getting anywhere.

A LoopGuard hears each tool call of one run (a JARVIS turn, a background task, a Jarvis Code
session's turn) as it's made: note(name, args) gives a Loop once
- the same call (the same tool with the same arguments) is made REPEAT times in a row, or
- a cycle of two or three different calls (A B A B…, A B C A B C…) goes round CYCLES times
  in a row.
Calls are compared by their tool and their arguments as JSON with sorted keys, so the order
an argument object happens to be written in doesn't matter. Once a loop is found the guard
starts over: the same loop carrying on is found again only after as many calls again.

What's done about a loop belongs to the caller: JARVIS's own turn and a background task stop
politely and say so (features.loops, background.py); a Jarvis Code session gets a notice with
a Stop button, never an automatic stop.

No model, no files: plain bookkeeping on the calls as they stream past.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

REPEAT = 3  # the same call this many times in a row
CYCLES = 3  # a cycle of two or three calls going round this many times
PERIODS = (2, 3)
KEEP = max(PERIODS) * CYCLES  # the calls a guard needs to remember


def fingerprint(name: str, args: Any) -> str:
    """A call as compared: its tool and its arguments (canonical JSON), hashed short."""
    try:
        text = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError, RecursionError):
        text = repr(args)
    return hashlib.sha256(f"{name}\x00{text}".encode("utf-8", "replace")).hexdigest()[:20]


@dataclass
class Loop:
    """A loop found: "repeat" (one call, `times` in a row) or "cycle" (the calls in `tools`,
    gone round `times` times)."""

    kind: str
    tools: list[str]
    times: int

    def describe(self) -> str:
        """In words for Claude (never shown to the owner as is: features.loops says it in
        the owner's language)."""
        if self.kind == "repeat":
            return f"called {self.tools[0]} with the same arguments {self.times} times in a row"
        return f"went round the same {len(self.tools)} calls ({', '.join(self.tools)}) {self.times} times"


@dataclass
class LoopGuard:
    repeat: int = REPEAT
    cycles: int = CYCLES
    calls: list[tuple[str, str]] = field(default_factory=list)  # (fingerprint, tool), newest last

    def reset(self) -> None:
        self.calls.clear()

    def note(self, name: str, args: Any) -> Loop | None:
        """One call made; the loop it completes, if any (the guard then starts over)."""
        self.calls.append((fingerprint(name, args), str(name)))
        del self.calls[: -max(KEEP, self.repeat)]
        found = self._found()
        if found is not None:
            self.calls.clear()
        return found

    def _found(self) -> Loop | None:
        calls = self.calls
        if len(calls) >= self.repeat and len({fp for fp, _ in calls[-self.repeat :]}) == 1:
            return Loop("repeat", [calls[-1][1]], self.repeat)
        for period in PERIODS:
            span = period * self.cycles
            if len(calls) < span:
                continue
            tail = [fp for fp, _ in calls[-span:]]
            block = tail[:period]
            if len(set(block)) < 2:  # one call over and over is a repeat, not a cycle
                continue
            if all(tail[i] == block[i % period] for i in range(span)):
                return Loop("cycle", [name for _, name in calls[-period:]], self.cycles)
        return None
