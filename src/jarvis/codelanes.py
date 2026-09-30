"""Subagent lanes: what each Agent (Task) call in a Jarvis Code session is doing, as a tree
(a subagent may start its own), with its steps, tokens, time and an estimate of its cost,
and what Claude Code's stop_task needs to stop one while it runs.

Built from what Claude Code streams, as a session takes it in (TaskManager.message_sinks):
- the Agent call itself (a ToolUseBlock "Agent" or "Task"): a lane, under the lane whose
  steps it's among (its message's parent_tool_use_id), else under the session;
- a subagent's own messages (parent_tool_use_id = its lane): its steps, its latest one,
  and its API usage per model (each message id once: Claude Code sends a message once per
  block, each with the whole message's usage);
- task_started (its task id, which stop_task takes), task_progress (tokens, tool uses and
  time as Claude Code counts them), task_notification and task_updated (how it ended);
- the Agent call's result (how it ended, and its totals when Claude Code gives them);
- each turn's result (modelUsage): each model's cost and tokens so far, which price the
  lanes' tokens.

Cost is an estimate: Claude Code reports cost per model, not per subagent. A model's price
of an input token is worked out from its modelUsage with Claude's price ratios (an output
token is 5 input tokens, a cache write 1.25, a cache read 0.1: Anthropic's pricing for all
current models), and each lane's own tokens are priced at it.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

AGENT_TOOLS = {"Task", "Agent"}
LANES_KEPT = 200  # per session; the oldest finished ones go first
SEEN_KEPT = 400  # message ids remembered per lane
WEB_SEARCH_COST = 0.01  # a web search, in a model's costUSD (not tokens)
# What each kind of token costs, in input tokens (Anthropic's price ratios).
WEIGHTS = {"input": 1.0, "output": 5.0, "cache_write": 1.25, "cache_read": 0.1}
TERMINAL = {"completed": "done", "failed": "failed", "stopped": "stopped", "killed": "stopped"}


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def weighted(tokens: dict[str, int]) -> float:
    """Tokens in input-token terms (what they cost relative to one input token)."""
    return sum(WEIGHTS[k] * tokens.get(k, 0) for k in WEIGHTS)


def api_tokens(usage: Any) -> dict[str, int]:
    """An API message's usage (the Messages API's names) as the four kinds."""
    usage = usage if isinstance(usage, dict) else {}
    return {
        "input": _int(usage.get("input_tokens")),
        "output": _int(usage.get("output_tokens")),
        "cache_write": _int(usage.get("cache_creation_input_tokens")),
        "cache_read": _int(usage.get("cache_read_input_tokens")),
    }


def rates_from(model_usage: Any) -> dict[str, float]:
    """What an input token cost on each model so far (modelUsage, Claude Code's names)."""
    rates: dict[str, float] = {}
    for model, raw in (model_usage or {}).items() if isinstance(model_usage, dict) else []:
        if not isinstance(raw, dict) or not isinstance(model, str):
            continue
        cost = raw.get("costUSD")
        if isinstance(cost, bool) or not isinstance(cost, int | float) or cost <= 0:
            continue
        cost = max(0.0, float(cost) - WEB_SEARCH_COST * _int(raw.get("webSearchRequests")))
        tokens = {
            "input": _int(raw.get("inputTokens")),
            "output": _int(raw.get("outputTokens")),
            "cache_write": _int(raw.get("cacheCreationInputTokens")),
            "cache_read": _int(raw.get("cacheReadInputTokens")),
        }
        units = weighted(tokens)
        if units > 0 and cost > 0:
            rates[model] = cost / units
    return rates


@dataclass
class Lane:
    """One Agent call: a subagent at work, or done."""

    id: str  # the Agent call's tool_use id
    parent: str = ""  # the lane it runs under ("" for the session itself)
    agent: str = "general-purpose"
    description: str = ""
    status: str = "running"  # running | done | failed | stopped
    started: float = field(default_factory=time.time)
    ended: float = 0.0
    task_id: str = ""  # Claude Code's task id, for stop_task
    background: bool = False
    steps: int = 0
    last: str = ""  # its latest step, as the timeline says it
    tokens: int = 0  # Claude Code's own count, when it gives one
    tool_uses: int = 0
    duration_ms: int = 0
    usage: dict[str, dict[str, int]] = field(default_factory=dict)  # model -> tokens by kind
    seen: OrderedDict = field(default_factory=OrderedDict)  # message ids counted
    stopping: bool = False

    def add_usage(self, model: str, message_id: str, usage: Any) -> None:
        if not message_id or message_id in self.seen:
            return
        self.seen[message_id] = None
        while len(self.seen) > SEEN_KEPT:
            self.seen.popitem(last=False)
        got = api_tokens(usage)
        have = self.usage.setdefault(model or "?", dict.fromkeys(WEIGHTS, 0))
        for kind, n in got.items():
            have[kind] += n

    def counted_tokens(self) -> int:
        """Its tokens: Claude Code's count, or those of its messages seen here."""
        if self.tokens:
            return self.tokens
        return sum(
            t["input"] + t["output"] + t["cache_write"] + t["cache_read"]
            for t in self.usage.values()
        )

    def cost(self, rates: dict[str, float]) -> float | None:
        """What it cost, estimated; None while no model it used has a known price."""
        total, priced = 0.0, False
        for model, tokens in self.usage.items():
            rate = rates.get(model)
            if rate is not None:
                total += rate * weighted(tokens)
                priced = True
        return round(total, 6) if priced else None

    def public(self, rates: dict[str, float], now: float) -> dict[str, Any]:
        seconds = (
            self.duration_ms / 1000 if self.duration_ms else (self.ended or now) - self.started
        )
        return {
            "id": self.id,
            "parent": self.parent,
            "agent": self.agent,
            "description": self.description,
            "status": "stopping" if self.stopping and self.status == "running" else self.status,
            "background": self.background,
            "steps": max(self.steps, self.tool_uses),
            "last": self.last,
            "tokens": self.counted_tokens(),
            "seconds": round(max(0.0, seconds), 1),
            "cost": self.cost(rates),
            "models": sorted(m for m in self.usage if m != "?"),
            "can_stop": bool(self.task_id) and self.status == "running",
        }


class Lanes:
    """One session's lanes."""

    def __init__(self) -> None:
        self.lanes: OrderedDict[str, Lane] = OrderedDict()
        self.by_task: dict[str, str] = {}  # Claude Code's task id -> lane id
        self.rates: dict[str, float] = {}

    def _lane(self, lane_id: str) -> Lane | None:
        return self.lanes.get(lane_id) if lane_id else None

    def start(self, lane_id: str, tool_input: dict[str, Any], parent: str = "") -> Lane:
        lane = self.lanes.get(lane_id)
        if lane is None:
            lane = Lane(id=lane_id, parent=parent if parent in self.lanes else "")
            self.lanes[lane_id] = lane
            self._prune()
        lane.agent = str(tool_input.get("subagent_type") or lane.agent)[:80]
        lane.description = str(tool_input.get("description") or lane.description)[:200]
        lane.background = bool(tool_input.get("run_in_background")) or lane.background
        return lane

    def _prune(self) -> None:
        over = len(self.lanes) - LANES_KEPT
        if over <= 0:
            return
        for lane_id in [k for k, v in self.lanes.items() if v.status != "running"][:over]:
            gone = self.lanes.pop(lane_id)
            if gone.task_id:
                self.by_task.pop(gone.task_id, None)

    def take(self, message: Any, describe: Any) -> bool:
        """One message from the session's stream; True when a lane changed. describe(name,
        input) says a step as the timeline does."""
        kind = type(message).__name__
        if kind == "AssistantMessage":
            return self._assistant(message, describe)
        if kind == "UserMessage":
            return self._results(message)
        if kind in (
            "TaskStartedMessage",
            "TaskProgressMessage",
            "TaskNotificationMessage",
            "TaskUpdatedMessage",
        ):
            return self._task(message, kind)
        if kind == "ResultMessage":
            rates = rates_from(getattr(message, "model_usage", None))
            if rates:
                self.rates.update(rates)
                return bool(self.lanes)
        return False

    def _assistant(self, message: Any, describe: Any) -> bool:
        parent = getattr(message, "parent_tool_use_id", None) or ""
        changed = False
        owner = self._lane(parent)
        if owner is not None:
            owner.add_usage(
                str(getattr(message, "model", "") or ""),
                str(getattr(message, "message_id", "") or ""),
                getattr(message, "usage", None),
            )
            changed = True
        for block in getattr(message, "content", None) or []:
            if type(block).__name__ != "ToolUseBlock":
                continue
            name, tool_input = str(block.name), block.input if isinstance(block.input, dict) else {}
            if name in AGENT_TOOLS:
                self.start(str(block.id), tool_input, parent)
                changed = True
            if owner is not None:
                owner.steps += 1
                owner.last = str(describe(name, tool_input))[:200]
        return changed

    def _results(self, message: Any) -> bool:
        changed = False
        for block in getattr(message, "content", None) or []:
            if type(block).__name__ != "ToolResultBlock":
                continue
            lane = self._lane(str(block.tool_use_id))
            if lane is None:
                continue
            totals = getattr(message, "tool_use_result", None)
            totals = totals if isinstance(totals, dict) else {}
            if lane.background and not block.is_error:
                continue  # started in the background: this only says so; its end comes as a task's
            if lane.status == "running":
                lane.status = "failed" if block.is_error else "done"
                lane.ended = time.time()
            lane.tokens = _int(totals.get("totalTokens")) or lane.tokens
            lane.tool_uses = _int(totals.get("totalToolUseCount")) or lane.tool_uses
            lane.duration_ms = _int(totals.get("totalDurationMs")) or lane.duration_ms
            changed = True
        return changed

    def _task(self, message: Any, kind: str) -> bool:
        task_id = str(getattr(message, "task_id", "") or "")
        lane_id = str(getattr(message, "tool_use_id", "") or "") or self.by_task.get(task_id, "")
        lane = self._lane(lane_id)
        if lane is None:
            return False
        data = getattr(message, "data", None)
        data = data if isinstance(data, dict) else {}
        if task_id:
            lane.task_id = task_id
            self.by_task[task_id] = lane.id
        if kind == "TaskStartedMessage":
            lane.background = bool(data.get("is_backgrounded")) or lane.background
            if data.get("subagent_type"):
                lane.agent = str(data["subagent_type"])[:80]
        usage = getattr(message, "usage", None)
        if isinstance(usage, dict):
            lane.tokens = _int(usage.get("total_tokens")) or lane.tokens
            lane.tool_uses = _int(usage.get("tool_uses")) or lane.tool_uses
            lane.duration_ms = _int(usage.get("duration_ms")) or lane.duration_ms
        last = getattr(message, "last_tool_name", None)
        if last and lane.status == "running":
            lane.last = lane.last or str(last)
        status = TERMINAL.get(str(getattr(message, "status", "") or ""))
        if status and lane.status == "running":
            lane.status, lane.ended, lane.stopping = status, time.time(), False
        return True

    def public(self, now: float | None = None) -> list[dict[str, Any]]:
        now = time.time() if now is None else now
        return [lane.public(self.rates, now) for lane in self.lanes.values()]
