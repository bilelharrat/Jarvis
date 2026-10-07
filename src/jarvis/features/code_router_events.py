"""Model Router's learning loop and its extras in Jarvis Code (code_router_events), beside
features/code_router (which moves a session to the routed model) and the window's
web/features/code-router.js (which routes).

What it keeps (beside prefs.json, in Jarvis's folder):
- model_router_events.jsonl (features/_router_log: append-only, rotated at 5 MB with 3 files
  kept, 90-day retention, 0600). One line per routed message as it goes (the route record:
  the prompt's SHA-256, its length and the task profile's numbers, Gemini's rating, the
  settings, the pick, the alternatives, what was applied), then "update" lines with the same
  msg: what the turn actually used (tokens, cost, time, calls; cumulative, so a later
  update's "actual" replaces an earlier one) and the signals (merged key by key). Owner
  feedback on a draft that never went is a "feedback" line. A message sent with Shadow mode
  on is logged as it would have been routed; "applied" is then the session's own model.
- learned.json: what model-router-learn (the Model Router repo's learning CLI) fitted from
  the log. Its overrides go to the window, which passes them to createLocalRouter.
- model_router_state.json: when the learner last ran, the reset point (Reset learning), and
  the price list the window sent (to put a price on other providers' turns).

Privacy: no prompt text is ever written. A prompt is kept as the SHA-256 of its normalized
text (NFC, whitespace collapsed), its length and the router's numbers for it; a project as
the SHA-256 of its folder (12 hex); a session and a message as salted hashes (a fresh salt
each run). The owner's words are read in memory only, for the follow-up and rephrase
signals, and dropped. The only exception is opt-in: with "Learn from my prompts" on (off by
default), a "This pick was wrong" with a model chosen keeps a 400-character excerpt of the
prompt (the session's redactors applied) for the classifier's few-shot examples.

Signals (each update's "signals"; how sure each is about the model, not the owner's mood):
- override {to, by: "menu"} (explicit, strong): a model picked from the composer's menu for
  the session within OVERRIDE_SECONDS of a routed message's turn (the window's task_model;
  picking a model turns the router off). With Shadow mode (the router didn't move the
  session) the same act is switchedAfter/switchedTo (implicit, medium).
- override {to, by: "feedback"}, wrongPick (explicit, strong): the popover's "This pick was
  wrong" (adapter.feedback). thumbs "up"/"down" (explicit, strong).
- effortChanged (implicit, weak): the owner set the session's effort after a routed message.
- retry, retryKind "rewind" (implicit, medium-strong): the conversation rewound to before it
  with new words (code_rewind); "rephrase" (implicit, weak-medium): the owner's next message
  is mostly the same words (Jaccard >= RETRY_SIMILAR, 4+ words, within RETRY_SECONDS).
- negativeFollowup / positiveFollowup (implicit, weak-medium / weak): the owner's next message
  in that session opens like pushback ("no", "that's wrong", "still failing", "不对") or
  thanks ("perfect", "works now", "谢谢"); first 160 characters, regex only.
- completed (implicit, weak +) / interrupted (medium −) / error (infrastructure: excluded
  from quality): how each turn ended (ResultMessage.terminal_reason, is_error).
- testsPassed (implicit, medium): the turn's last test command (codesupervisor's
  TEST_COMMAND) and its counts.
- reverted, revertKind "undo" / "rewind" / "file" / "hunk" (implicit, strong for undo and
  rewind, medium for a file or hunk): the owner undid that round's changes after it.
- fellBack {from, to, why} (infrastructure): the routed model couldn't answer and the
  session moved to the route's next pick (code_router's automatic fallback).

Where they come from: commands the window sends (task_model, task_effort, task_undo,
task_rewind, task_revert, task_interrupt, task_cancel, code_rewind) are heard on their way
and left to their own handlers (each returns False); the transcript through add_task_sink;
the turns' ResultMessage (and each reply's usage, for the session's context size) through
TaskManager.message_sinks; code_hunk_undone through add_event_sink. Voice coding acts on the
sessions directly, so its switches and undos aren't heard.

The window (model_router_state): the learned overrides, Claude's plan use (quota: the
five-hour and weekly windows' utilization, the larger, from the Session card's plan numbers
and Claude Code's rate-limit reports), the month's spend against the budget (pressure past
BUDGET_PRESSURE_FROM raises the router's efficiency), the agentic calls per turn, and for each
session its project hash, context size (the latest reply's input tokens) and whether voice
coding has it.

Window commands:
- model_router_state_get -> model_router_state.
- model_router_feedback {kind: wrong-pick | thumbs-up | thumbs-down, id?, prompt?, pick?,
  chosen?}: on the session's latest routed message when it's for that prompt, else a
  feedback line. The prompt is hashed here and dropped.
- model_router_prices {prices: {model: {in, out}}}: USD per 1M tokens, for pricing turns.
- model_router_call {rid, op, ...} -> model_router_reply {rid, ok, data | error}: op
  "learned" (the report rows), "reset" (delete learned.json; the learner then only reads
  what comes after), "freeze" {frozen}, "spend" (this calendar month from the log),
  "budget" {usd}.

Settings (prefs.features): code_router_agentic_calls (model calls per message in an agentic
session, default 8), code_router_budget (USD a month, 0: none), code_router_projects
({project hash: {efficiency, performance}}: per-project defaults), code_router_auto_fallback
(default on), and in code_router_settings: learn (default on: run the learner, apply what it
learned), learnFromPrompts (default off), subscriptionClaude (default on: Claude on the
owner's sign-in costs no API dollars here), shadow.

Cost policy: nothing here calls a model. The learner is a local Node script
(model-router-learn, from $MODEL_ROUTER_HOME or ~/Model Router), run at low priority off the
event loop: after LEARN_EVERY new routed messages (at most once in LEARN_GAP_SECONDS) and
each night at NIGHTLY (with the log's retention), never while frozen or with learning off.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import os
import re
import secrets
import shutil
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .. import jsonstore
from ..codeplatform import project_of
from ..codesupervisor import TEST_COMMAND, test_counts
from ..prefs import register_feature_pref
from ._router_log import EventLog, epoch_of, iso
from .code_router import FALLBACK_PREF, SETTINGS_PREF, clean_settings

log = logging.getLogger("jarvis")

EVENTS_FILE = "model_router_events.jsonl"
LEARNED_FILE = "learned.json"
STATE_FILE = "model_router_state.json"

PREF_AGENTIC = "code_router_agentic_calls"
PREF_BUDGET = "code_router_budget"
PREF_PROJECTS = "code_router_projects"
PREF_FALLBACK = FALLBACK_PREF
AGENTIC_DEFAULT = 8
BUDGET_MAX = 100_000.0
MAX_PROJECTS = 200

OVERRIDE_SECONDS = 600.0  # a model picked this soon after a routed message's turn: its override
REVERT_SECONDS = 3600.0  # an undo this soon after: that message's changes undone
FOLLOWUP_SECONDS = 1800.0  # the owner's next message this soon after: weighed as a follow-up
RETRY_SECONDS = 600.0
RETRY_SIMILAR = 0.6
TURNS_KEPT = 400  # routed messages remembered (for late signals), newest
PENDING_KEPT = 8  # routed messages per session waiting for their turn to start
BUDGET_PRESSURE_FROM = 0.8  # past this share of the month's budget, the router leans cheaper
BUDGET_BOOST = 40  # efficiency points added at 100% of the budget (linear from 80%)
LEARN_EVERY = 50
LEARN_GAP_SECONDS = 3600.0
LEARN_TIMEOUT = 180.0
NIGHTLY = (3, 40)  # local time: the learner and the log's retention
STATE_EVERY = 0.5  # pushes of model_router_state, at most this often
MAX_LEARNED_BYTES = 1_000_000
MAX_OVERRIDES_JSON = 64_000
EXCERPT_CHARS = 400
NODE_PATHS = ("/opt/homebrew/bin/node", "/usr/local/bin/node")

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-\[\]]{0,99}")
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{0,39}")
_PROJECT = re.compile(r"[0-9a-f]{12}")
_RETRYABLE_CMDS = ("task_undo", "task_rewind", "task_revert", "code_rewind")

# The owner's next message, as pushback or thanks (English and Mandarin): its first words.
_NEGATIVE = re.compile(
    r"^\W*(?:no\b(?! (?:problem|worries|need|rush|hurry|pressure)\b)|nope\b|wrong\b|that'?s (?:not|wrong|incorrect)|not what i|this is wrong"
    r"|(?:it |that |this )?(?:still )?(?:doesn'?t|didn'?t|isn'?t|won'?t|does not|did not) work"
    r"|still (?:fail|broken|wrong|not|the same)|(?:it'?s |that'?s )?(?:broken|incorrect)\b"
    r"|you (?:broke|forgot|missed|ignored|didn'?t)|why did you|revert\b|undo\b|try again"
    r"|不对|错了|还是不行|没用|不行|撤销|重来|你搞错)",
    re.IGNORECASE,
)
_POSITIVE = re.compile(
    r"^\W*(?:thanks?\b|thank you|perfect\b|great\b|nice\b|awesome\b|excellent\b|works(?: now)?\b"
    r"|it works|that works|lgtm\b|ship it|good job|well done|好的|可以了|完美|谢谢|太好了)",
    re.IGNORECASE,
)
_TOKENS = re.compile(r"[\w']+", re.UNICODE)


def verdict_of(text: str) -> int:
    """-1: the words open like pushback; +1: like thanks; 0: neither."""
    head = " ".join(str(text or "").split())[:160]
    if _NEGATIVE.search(head):
        return -1
    if _POSITIVE.search(head):
        return 1
    return 0


def _words(text: str) -> frozenset[str]:
    return frozenset(w.lower() for w in _TOKENS.findall(str(text or "")[:4000])[:400])


def _similar(a: frozenset[str], b: frozenset[str]) -> float:
    if len(a) < 4 or len(b) < 4:
        return 0.0
    return len(a & b) / len(a | b)


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", str(text or "")).split())


def prompt_hash(text: str) -> str:
    """The SHA-256 of a prompt's normalized text: what the log keeps of it."""
    return hashlib.sha256(normalized(text).encode("utf-8")).hexdigest()


def project_hash(folder: str) -> str:
    return hashlib.sha256(str(folder or "").encode("utf-8")).hexdigest()[:12]


# ── cleaning what the window sends (numbers, model ids and enums only) ──


def _num(value: Any, lo: float = 0.0, hi: float = 1e12, digits: int = 6) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if not math.isfinite(value):
        return None
    return round(max(lo, min(hi, float(value))), digits)


def _int(value: Any, lo: int = 0, hi: int = 10**12) -> int | None:
    found = _num(value, lo, hi, 0)
    return None if found is None else int(found)


def _id(value: Any) -> str | None:
    return value if isinstance(value, str) and _ID.fullmatch(value) else None


def _word(value: Any) -> str | None:
    return value if isinstance(value, str) and _WORD.fullmatch(value) else None


def _slug(value: Any, n: int = 60) -> str | None:
    """A router-made reason ("trivial", "classifier failed; used the rules"): lowercase
    letters, digits and a few marks, cut."""
    if not isinstance(value, str) or not value:
        return None
    out = re.sub(r"[^a-z0-9 ;:,.()_\-]", "", value.lower())[:n].strip()
    return out or None


def _row(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    model = _id(value.get("model"))
    if not model:
        return None
    out: dict[str, Any] = {"model": model}
    effort = _word(value.get("effort"))
    if effort:
        out["effort"] = effort
    quality = _num(value.get("quality"), 0, 1000, 2)
    cost = _num(value.get("costUSD"), 0, 1e6, 8)
    if quality is not None:
        out["quality"] = quality
    if cost is not None:
        out["costUSD"] = cost
    return out


def _compact(out: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in out.items() if v is not None}


def clean_info(value: Any) -> dict[str, Any]:
    """What the window says about a route (its task profile, rating, settings, pick,
    alternatives, extras), reduced to numbers, model ids and enums: never words of the
    prompt (the analyzer's signal labels and Gemini's reasons aren't taken)."""
    if not isinstance(value, dict):
        return {}
    info: dict[str, Any] = {}
    p = value.get("profile")
    if isinstance(p, dict):
        weights = p.get("weights") if isinstance(p.get("weights"), dict) else {}
        info["profile"] = _compact(
            {
                "complexity": _word(p.get("complexity")),
                "score": _num(p.get("score"), 0, 1, 4),
                "weights": {
                    k: w
                    for k, w in ((k, _num(v, 0, 1, 4)) for k, v in list(weights.items())[:12])
                    if _word(k) and w is not None
                }
                or None,
                "inputTokens": _int(p.get("inputTokens")),
                "outputTokens": _int(p.get("outputTokens")),
            }
        )
    r = value.get("rating")
    if isinstance(r, dict):
        info["rating"] = _compact(
            {
                "used": r.get("used") is True,
                "by": _id(r.get("by")),
                "mode": _word(r.get("mode")),
                "complexity": _word(r.get("complexity")),
                "rulesComplexity": _word(r.get("rulesComplexity")),
                "skipped": _slug(r.get("skipped")),
                "cached": True if r.get("cached") is True else None,
            }
        )
    s = value.get("settings")
    if isinstance(s, dict):
        info["settings"] = _compact(
            {
                "efficiency": _num(s.get("efficiency"), 0, 100, 1),
                "performance": _num(s.get("performance"), 0, 100, 1),
                "classifier": _word(s.get("classifier")),
                "level": _num(s.get("level"), 0, 10, 0),
                "subscriptionClaude": s.get("subscriptionClaude")
                if isinstance(s.get("subscriptionClaude"), bool)
                else None,
                "project": True if s.get("project") is True else None,
            }
        )
    pick = _row(value.get("pick"))
    if pick:
        info["pick"] = pick
    best = _row(value.get("best"))
    if best:
        info["best"] = best
    alternatives = value.get("alternatives")
    if isinstance(alternatives, list):
        rows = [r for r in (_row(a) for a in alternatives[:3]) if r]
        if rows:
            info["alternatives"] = rows
    e = value.get("extras")
    if isinstance(e, dict):
        info["extras"] = _compact(
            {
                "sessionTokens": _int(e.get("sessionTokens")),
                "agenticCallsPerTurn": _num(e.get("agenticCallsPerTurn"), 1, 100, 1),
                "sticky": True if e.get("sticky") is True else None,
                "subscription": True if e.get("subscription") is True else None,
                "quota": _num(e.get("quota"), 0, 1, 3),
                "interactive": True if e.get("interactive") is True else None,
                "voice": True if e.get("voice") is True else None,
                "budgetBoost": _num(e.get("budgetBoost"), 0, 100, 1),
            }
        )
    return {k: v for k, v in info.items() if v}


def _clean_agentic(value: Any) -> int | None:
    found = _int(value, 1, 50)
    return found if found is not None and found == value else None


def _clean_budget(value: Any) -> float | None:
    found = _num(value, 0, BUDGET_MAX, 2)
    return found if found is not None and found == round(float(value), 2) else None


def clean_projects(value: Any) -> dict[str, dict[str, int]] | None:
    """Per-project defaults: {project hash: {efficiency, performance}}, at most
    MAX_PROJECTS."""
    if not isinstance(value, dict):
        return None
    out: dict[str, dict[str, int]] = {}
    for key, entry in list(value.items())[-MAX_PROJECTS:]:
        if not (isinstance(key, str) and _PROJECT.fullmatch(key) and isinstance(entry, dict)):
            continue
        levels = {}
        for k in ("efficiency", "performance"):
            v = _num(entry.get(k), 0, 100, 0)
            if v is not None:
                levels[k] = int(v)
        if len(levels) == 2:
            out[key] = levels
    return out


register_feature_pref(PREF_AGENTIC, AGENTIC_DEFAULT, _clean_agentic)
register_feature_pref(PREF_BUDGET, 0.0, _clean_budget)
register_feature_pref(PREF_PROJECTS, {}, clean_projects)


# ── what's remembered about a routed message ──


@dataclass
class Turn:
    """A routed message: from when it goes until the owner's next message."""

    msg: str
    session: str
    task_id: int
    hash: str
    sent: float
    model: str  # the model it went on (applied)
    routed: bool  # the router put (or kept) the session on it: not Shadow, not skipped
    n: int | None = None  # its user entry's number in the transcript, once seen
    uuid: str = ""  # Claude Code's id for it (task_entry_meta), once known
    started: bool = False
    ended: float = 0.0
    running: bool = False
    followed: bool = False
    actual: dict[str, Any] = field(default_factory=dict)
    tests: bool | None = None
    signals: dict[str, Any] = field(default_factory=dict)


@dataclass
class Track:
    """One session, as the log knows it."""

    session: str
    pending: deque[Turn] = field(default_factory=lambda: deque(maxlen=PENDING_KEPT))
    current: Turn | None = None  # the routed message its turns now count for
    last: Turn | None = None  # the latest routed message whose turn started
    words: frozenset[str] = frozenset()
    words_at: float = 0.0
    tests: dict[str, str] = field(default_factory=dict)  # tool id -> command, till its result
    context: int = 0  # the session's context, as the latest reply's input tokens
    n: int = 0


def _learned_shape(data: Any) -> bool:
    return isinstance(data, dict)


class Events:
    def __init__(self, hub: Any, clock: Any = time.time) -> None:
        self.hub = hub
        self.clock = clock
        self.run = secrets.token_hex(8)  # salts session and message ids: a fresh one each run
        self.log = EventLog(hub.feature_path(EVENTS_FILE), clock=clock)
        self.tracks: dict[int, Track] = {}
        self.turns: dict[str, Turn] = {}  # msg -> Turn, newest last, TURNS_KEPT at most
        self.prices: dict[str, dict[str, float]] = {}
        self._state: dict[str, Any] | None = None  # model_router_state.json, once read
        self._learned: tuple[float, dict[str, Any]] | None = None  # (mtime, cleaned)
        self._push_timer: asyncio.TimerHandle | None = None
        self._pushed = 0.0
        self._learning: asyncio.Task | None = None
        self._month: tuple[str, float] | None = None  # (YYYY-MM, API dollars so far)
        self._month_job: asyncio.Task | None = None
        self._spend_cache: tuple[tuple, dict[str, Any]] | None = None
        self.learner: Any = None  # (tests: a stand-in for the learner run)
        self._script: tuple[float, bool] | None = None
        self._sessions: frozenset[int] = frozenset()  # the code sessions the windows were told of
        self._projects: dict[tuple[int, str], str] = {}  # (task id, folder) -> project hash

    # ── settings ──

    def settings(self) -> dict[str, Any]:
        return clean_settings(self.hub.prefs.feature(SETTINGS_PREF)) or {}

    def learn_on(self) -> bool:
        return self.settings().get("learn", True) is not False

    def agentic(self) -> int:
        value = self.hub.prefs.feature(PREF_AGENTIC)
        return value if isinstance(value, int) and 1 <= value <= 50 else AGENTIC_DEFAULT

    def budget(self) -> float:
        value = self.hub.prefs.feature(PREF_BUDGET)
        return float(value) if isinstance(value, int | float) and value > 0 else 0.0

    # ── ids ──

    def track(self, task: Any) -> Track:
        track = self.tracks.get(task.id)
        if track is None:
            session = hashlib.sha256(f"{self.run}:{task.id}".encode()).hexdigest()[:16]
            track = self.tracks[task.id] = Track(session)
        return track

    def project(self, task: Any) -> str:
        """The session's project as the log names it (an isolated copy's own project),
        looked up once per folder the session is in."""
        key = (task.id, str(getattr(task, "cwd", "")))
        found = self._projects.get(key)
        if found is None:
            try:
                found = project_hash(project_of(self.hub, task))
            except Exception:
                found = project_hash(key[1])
            if len(self._projects) > 500:
                self._projects.clear()
            self._projects[key] = found
        return found

    def _effort(self, task: Any) -> str:
        settings = getattr(self.hub.tasks, "settings", None)
        return str(task.effort or getattr(settings, "task_effort", "") or "")

    # ── a routed message (code_router calls this as it goes) ──

    def routed(
        self,
        task: Any,
        text: str,
        route: dict[str, Any] | None,
        *,
        source: str = "chip",
        moved: bool = True,
        skipped: str = "",
        shadow: bool = False,
        waited_ms: int = 0,
        new: bool = False,
    ) -> str:
        """Log a routed (or Shadow) message and expect its turn: its msg id ("" if not)."""
        try:
            return self._routed(
                task, text, route or {}, source, moved, skipped, shadow, waited_ms, new
            )
        except Exception:
            log.exception("Model Router: couldn't log a routed message")
            return ""

    def _routed(self, task, text, route, source, moved, skipped, shadow, waited_ms, new) -> str:
        if task is None or getattr(task, "kind", "") != "code":
            return ""
        track = self.track(task)
        track.n += 1
        now = self.clock()
        msg = hashlib.sha256(f"{self.run}:{task.id}:{track.n}".encode()).hexdigest()[:16]
        info = clean_info(route.get("info"))
        h = prompt_hash(text)
        routed = moved and not shadow and not skipped
        pick = info.get("pick") or _compact(
            {"model": _id(route.get("model")), "effort": _word(route.get("effort"))}
        )
        settings = dict(info.get("settings") or {})
        settings["shadow"] = shadow
        record: dict[str, Any] = {
            "v": 1,
            "ts": iso(now),
            "session": track.session,
            "msg": msg,
            "project": self.project(task),
            "prompt": {"hash": h, "chars": len(str(text or ""))},
            "settings": settings,
            "pick": pick,
            "applied": {"model": str(task.model or ""), "effort": self._effort(task)},
            "route": _compact(
                {
                    "source": source,
                    "waitedMs": max(0, int(waited_ms)) or None,
                    "skipped": skipped or None,
                    "new": True if new else None,
                }
            ),
        }
        if info.get("profile"):
            record["prompt"]["profile"] = info["profile"]
        for key in ("rating", "alternatives", "best", "extras"):
            if info.get(key):
                record[key] = info[key]
        self.log.append(record)
        turn = Turn(msg, track.session, task.id, h, now, str(task.model or ""), routed)
        turn.signals = {}
        self.turns[msg] = turn
        while len(self.turns) > TURNS_KEPT:
            self.turns.pop(next(iter(self.turns)))
        track.pending.append(turn)
        if new:  # (a new session may have logged its first message already)
            for entry in reversed(task.transcript[-20:]):
                if entry.get("role") == "user" and prompt_hash(entry.get("text") or "") == h:
                    self._bind(track, h, entry.get("n"))
                    break
        self._counted_new()
        return msg

    # ── updates ──

    def _update(self, turn: Turn, **parts: Any) -> None:
        record = {"v": 1, "kind": "update", "ts": iso(self.clock()), "session": turn.session}
        record["msg"] = turn.msg
        record.update({k: v for k, v in parts.items() if v})
        if len(record) > 5:
            self.log.append(record)

    def signal(self, turn: Turn | None, signals: dict[str, Any]) -> None:
        """New signals on a routed message (only what changed is written)."""
        if turn is None:
            return
        fresh = {k: v for k, v in signals.items() if turn.signals.get(k) != v}
        if not fresh:
            return
        turn.signals.update(fresh)
        self._update(turn, signals=fresh)

    def signal_task(self, task_id: int, signals: dict[str, Any]) -> None:
        """On the session's latest routed message (code_router's fallback)."""
        track = self.tracks.get(task_id)
        turn = track.current or track.last if track else None
        if turn is None and track and track.pending:
            turn = track.pending[-1]
        self.signal(turn, signals)

    # ── what the sessions say (add_task_sink) ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        try:
            if kind == "task_log":
                self._on_entry(data.get("id"), data.get("entry") or {})
            elif kind == "task_log_update":
                self._on_tool_result(data)
            elif kind == "task_entry_meta":
                self._on_meta(data)
            elif kind == "tasks":
                for gone in set(self.tracks) - set(self.hub.tasks.tasks):
                    self.tracks.pop(gone, None)
                ids = frozenset(t.id for t in self.hub.tasks.tasks.values() if t.kind == "code")
                if ids != self._sessions:  # (a new session's project, for its defaults)
                    self._sessions = ids
                    self.push_state()
        except Exception:
            log.exception("Model Router: couldn't take in a session event")

    def _on_entry(self, task_id: Any, entry: dict[str, Any]) -> None:
        if not isinstance(task_id, int):
            return
        role = entry.get("role")
        if role == "user":
            task = self.hub.tasks.tasks.get(task_id)
            if task is not None and task.kind == "code":
                self.on_user(task, str(entry.get("text") or ""), entry.get("n"))
        elif role == "tool" and entry.get("tool") == "Bash" and entry.get("tool_id"):
            track = self.tracks.get(task_id)
            detail = str(entry.get("detail") or entry.get("text") or "")
            command = detail.removeprefix("$ ").removeprefix("Running ").strip()
            if track is not None and track.current is not None and TEST_COMMAND.search(command):
                track.tests[str(entry["tool_id"])] = command[:200]
                while len(track.tests) > 50:
                    del track.tests[next(iter(track.tests))]

    def _on_tool_result(self, data: dict[str, Any]) -> None:
        track = self.tracks.get(data.get("id"))
        if track is None or track.tests.pop(str(data.get("tool_id")), None) is None:
            return
        if track.current is not None:
            _, failed = test_counts(str(data.get("output") or ""))
            track.current.tests = data.get("status") == "done" and not failed

    def _on_meta(self, data: dict[str, Any]) -> None:
        track = self.tracks.get(data.get("id"))
        turn = track.current if track else None
        if turn is not None and turn.n is not None and turn.n == data.get("n"):
            turn.uuid = str(data.get("uuid") or "")[:100]

    def on_user(self, task: Any, text: str, n: Any = None) -> None:
        """The owner's message in a session: the previous routed message's follow-up, and
        the start of this one's turn when it was routed. The words stay in memory."""
        track = self.track(task)
        now = self.clock()
        h = prompt_hash(text)
        words = _words(text)
        last = track.last
        if last is not None and last.started and not last.followed:
            last.followed = True
            if now - (last.ended or last.sent) <= FOLLOWUP_SECONDS:
                found: dict[str, Any] = {}
                verdict = verdict_of(text)
                if verdict < 0:
                    found["negativeFollowup"] = True
                elif verdict > 0:
                    found["positiveFollowup"] = True
                if (
                    now - track.words_at <= RETRY_SECONDS
                    and _similar(words, track.words) >= RETRY_SIMILAR
                ):
                    found.update(retry=True, retryKind="rephrase")
                self.signal(last, found)
        if not self._bind(track, h, n) and not (track.current and track.current.running):
            track.current = None  # a turn of its own, not routed (a steer stays in the running one)
        track.words, track.words_at = words, now

    def _bind(self, track: Track, h: str, n: Any) -> bool:
        """The routed message whose text this user entry is: its turn starts."""
        match = next((t for t in track.pending if t.hash == h), None)
        if match is None:
            return False
        while track.pending:
            if track.pending.popleft() is match:
                break
        match.started, match.running = True, True
        match.n = n if isinstance(n, int) else None
        track.current = track.last = match
        return True

    # ── what the turns used (TaskManager.message_sinks) ──

    def on_message(self, task: Any, message: Any) -> None:
        try:
            name = type(message).__name__
            if name == "AssistantMessage":
                self._on_reply(task, message)
            elif name == "ResultMessage":
                self._on_result(task, message)
        except Exception:
            log.exception("Model Router: couldn't take in a turn's usage")

    def _on_reply(self, task: Any, message: Any) -> None:
        if getattr(message, "parent_tool_use_id", None) or task.kind != "code":
            return
        usage = getattr(message, "usage", None)
        if not isinstance(usage, dict):
            return
        size = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
            if isinstance(usage.get(k) or 0, int)
        )
        if size > 0:
            self.track(task).context = size

    def _on_result(self, task: Any, message: Any) -> None:
        if task.kind != "code":
            return
        track = self.tracks.get(task.id)
        turn = track.current if track else None
        self.push_state()
        if turn is None:
            return
        usage = getattr(message, "usage", None) or {}
        tokens_in = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )
        tokens_out = int(usage.get("output_tokens") or 0)
        notional = self._turn_cost(task)
        usd, notional = self._real_cost(task, notional, tokens_in, tokens_out)
        a = turn.actual
        a["inputTokens"] = a.get("inputTokens", 0) + tokens_in
        a["outputTokens"] = a.get("outputTokens", 0) + tokens_out
        a["cacheReadTokens"] = a.get("cacheReadTokens", 0) + int(
            usage.get("cache_read_input_tokens") or 0
        )
        a["latencyMs"] = a.get("latencyMs", 0) + int(getattr(message, "duration_ms", 0) or 0)
        a["apiMs"] = a.get("apiMs", 0) + int(getattr(message, "duration_api_ms", 0) or 0)
        a["calls"] = a.get("calls", 0) + int(getattr(message, "num_turns", 0) or 0)
        a["turns"] = a.get("turns", 0) + 1
        a["model"] = str(task.model or turn.model)
        before = a.get("costUSD")
        if usd is not None:
            a["costUSD"] = round((before or 0.0) + usd, 6)
        if notional is not None:
            a["notionalUSD"] = round(a.get("notionalUSD", 0.0) + notional, 6)
        self._spent(a.get("costUSD", 0.0) - (before or 0.0))
        reason = str(getattr(message, "terminal_reason", "") or "")
        found: dict[str, Any] = {}
        if reason.startswith("aborted"):
            found.update(completed=False, interrupted=True)
        elif getattr(message, "is_error", False):
            status = getattr(message, "api_error_status", None)
            found.update(completed=False, error=_slug(str(status or message.subtype), 40))
        else:
            found["completed"] = True
        if turn.tests is not None:
            found["testsPassed"] = turn.tests
        turn.ended = self.clock()
        turn.running = False
        fresh = {k: v for k, v in found.items() if turn.signals.get(k) != v}
        turn.signals.update(fresh)
        self._update(turn, actual=dict(a), signals=fresh)
        self.maybe_learn()

    def _turn_cost(self, task: Any) -> float | None:
        """The turn's cost as Claude Code priced it (its transcript's turn line)."""
        for entry in reversed(task.transcript[-8:]):
            if entry.get("role") == "turn":
                cost = entry.get("cost")
                return float(cost) if isinstance(cost, int | float) else None
        return None

    def _real_cost(
        self, task: Any, notional: float | None, tokens_in: int, tokens_out: int
    ) -> tuple[float | None, float | None]:
        """(API dollars, the API price) of a turn: Claude on the owner's sign-in is the plan
        (no dollars, with Claude counted as a subscription); Claude through an Anthropic key
        is Claude Code's price; another provider's model is its tokens at the router's
        prices (Claude Code can't price it), or unknown."""
        ref = str(task.model_ref or "")
        if not ref.startswith("custom:"):
            subscription = self.settings().get("subscriptionClaude", True) is not False
            return (0.0 if subscription else notional), notional
        provider = None
        with contextlib.suppress(Exception):
            provider = self.hub.providers.provider_of(ref)
        if provider is not None and provider.kind == "anthropic":
            return notional, notional
        self._load_state()  # (the prices the window sent before a restart)
        model = str(task.model or "")
        price = self.prices.get(model) or self.prices.get(model.rsplit("/", 1)[-1])
        if price:
            usd = (tokens_in * price["in"] + tokens_out * price["out"]) / 1e6
            return usd, usd
        return None, None

    # ── the owner's acts, heard on their way (each handler returns False) ──

    def observer(self, kind: str) -> Any:
        def hear(msg: dict[str, Any]) -> bool:
            try:
                self.on_command(kind, msg)
            except Exception:
                log.exception("Model Router: couldn't take in %s", kind)
            return False

        return hear

    def _task_of(self, msg: dict[str, Any]) -> Any:
        try:
            return self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError, OverflowError):  # (null, words, infinity: no session)
            return None

    def _recent(self, track: Track | None, seconds: float) -> Turn | None:
        turn = track.last if track else None
        if turn is None:
            return None
        if turn.running or self.clock() - (turn.ended or turn.sent) <= seconds:
            return turn
        return None

    def on_command(self, kind: str, msg: dict[str, Any]) -> None:
        task = self._task_of(msg)
        if task is None or task.kind != "code":
            return
        track = self.tracks.get(task.id)
        if kind == "task_model":
            turn = self._recent(track, OVERRIDE_SECONDS)
            model = self._model_of(str(msg.get("ref") or ""))
            if turn is None or not model or model == turn.model:
                return
            if turn.routed:
                self.signal(turn, {"override": {"to": model, "by": "menu"}})
            else:
                self.signal(turn, {"switchedAfter": True, "switchedTo": model})
        elif kind == "task_effort":
            effort = _word(msg.get("effort"))
            turn = self._recent(track, OVERRIDE_SECONDS)
            if turn is not None and effort:
                self.signal(turn, {"effortChanged": effort})
        elif kind in ("task_interrupt", "task_cancel"):
            turn = track.current if track else None
            if turn is not None and turn.running:
                self.signal(turn, {"interrupted": True, "completed": False})
        elif kind in ("task_undo", "task_revert"):
            turn = self._recent(track, REVERT_SECONDS)
            self.signal(
                turn, {"reverted": True, "revertKind": "undo" if kind == "task_undo" else "file"}
            )
        elif kind in ("task_rewind", "code_rewind"):
            turns = self._from_uuid(task.id, str(msg.get("uuid") or ""))
            signals: dict[str, Any] = {}
            if kind == "task_rewind" or msg.get("files") is True:
                signals.update(reverted=True, revertKind="rewind")
            if kind == "code_rewind" and str(msg.get("text") or "").strip():
                signals.update(retry=True, retryKind="rewind")
            for turn in turns:
                self.signal(turn, signals)

    def on_hunk_undone(self, data: dict[str, Any]) -> None:
        if data.get("undone") is not True or not isinstance(data.get("id"), int):
            return
        turn = self._recent(self.tracks.get(data["id"]), REVERT_SECONDS)
        self.signal(turn, {"reverted": True, "revertKind": "hunk"})

    def _from_uuid(self, task_id: int, uuid: str) -> list[Turn]:
        """The routed messages a rewind to before uuid takes back: that one and later (or
        the latest, when uuid isn't one of them)."""
        mine = [t for t in self.turns.values() if t.task_id == task_id and t.started]
        target = next((t for t in mine if uuid and t.uuid == uuid), None)
        if target is None:
            latest = self._recent(self.tracks.get(task_id), REVERT_SECONDS)
            return [latest] if latest else []
        return [t for t in mine if t.sent >= target.sent]

    def _model_of(self, ref: str) -> str:
        with contextlib.suppress(Exception):
            for entry in self.hub.providers.models():
                if entry.get("ref") == ref:
                    return str(entry.get("model") or "")
        return ""

    # ── the window's feedback ──

    def cmd_feedback(self, msg: dict[str, Any]) -> None:
        kind = msg.get("kind")
        if kind not in ("wrong-pick", "thumbs-up", "thumbs-down"):
            return
        task = self._task_of(msg)
        prompt = msg.get("prompt") if isinstance(msg.get("prompt"), str) else None
        prompt = prompt if prompt and prompt.strip() else None  # (an empty composer: none)
        h = prompt_hash(prompt) if prompt is not None else ""
        chosen = _id(msg.get("chosen"))
        track = self.tracks.get(task.id) if task is not None else None
        turn = None
        if track is not None:
            candidates = [track.last, *reversed(track.pending)]
            turn = next((t for t in candidates if t is not None and (not h or t.hash == h)), None)
        if kind == "wrong-pick":
            signals: dict[str, Any] = {"wrongPick": True}
            if chosen:
                signals["override"] = {"to": chosen, "by": "feedback"}
        else:
            signals = {"thumbs": "up" if kind == "thumbs-up" else "down"}
        if turn is not None:
            self.signal(turn, signals)
            return
        record: dict[str, Any] = {"v": 1, "kind": "feedback", "ts": iso(self.clock())}
        record["signal"] = kind
        if task is not None:
            record["session"] = self.track(task).session
            record["project"] = self.project(task)
        if prompt is not None:
            record["prompt"] = {"hash": h, "chars": len(prompt)}
            if kind == "wrong-pick" and chosen and self.settings().get("learnFromPrompts"):
                excerpt = self._excerpt(task, prompt)
                if excerpt:
                    record["prompt"]["excerpt"] = excerpt
        pick = _row(msg.get("pick"))
        if pick:
            record["pick"] = pick
        if chosen:
            record["chosen"] = chosen
        self.log.append(record)

    def _excerpt(self, task: Any, prompt: str) -> str:
        """The start of a prompt with the session's redactors applied (the owner's secrets
        out); "" when there's no session to redact for, or the redactors failed."""
        if task is None:
            return ""
        try:
            return self.hub.tasks.redact(task, normalized(prompt)[:EXCERPT_CHARS])[:EXCERPT_CHARS]
        except Exception:
            log.exception("Model Router: couldn't redact a prompt excerpt; none kept")
            return ""

    def cmd_prices(self, msg: dict[str, Any]) -> None:
        prices = msg.get("prices")
        if not isinstance(prices, dict):
            return
        out: dict[str, dict[str, float]] = {}
        for model, price in list(prices.items())[:200]:
            if not (_id(model) and isinstance(price, dict)):
                continue
            p_in, p_out = _num(price.get("in"), 0, 10_000, 6), _num(price.get("out"), 0, 10_000, 6)
            if p_in is not None and p_out is not None:
                out[model] = {"in": p_in, "out": p_out}
        if out and out != self.prices:
            self.prices = out
            self._save_state({"prices": out})

    # ── what the window routes with (model_router_state) ──

    def quota(self) -> dict[str, Any]:
        """How much of Claude's plan is used: the five-hour and weekly windows (0..1), as
        the Session card's plan numbers and Claude Code's rate-limit reports last said, a
        window that has reset since counting as unused. used: the larger."""
        now = self.clock()
        seen: dict[str, float] = {}

        def take(kind: Any, used: Any, resets: Any, status: Any = "") -> None:
            if kind not in ("five_hour", "seven_day"):
                return
            if isinstance(resets, int | float) and not isinstance(resets, bool):
                resets = resets / 1000 if resets > 1e12 else resets
                if 0 < resets <= now:
                    return  # reset since: nothing known of the new window
            value = 1.0 if status == "rejected" else used
            if (
                isinstance(value, int | float)
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                seen[kind] = max(seen.get(kind, 0.0), min(1.0, max(0.0, float(value))))

        with contextlib.suppress(Exception):
            for kind, entry in dict(getattr(self.hub.usage, "limits", {}) or {}).items():
                if isinstance(entry, dict):
                    take(
                        kind, entry.get("utilization"), entry.get("resets_at"), entry.get("status")
                    )
        meter = getattr(self.hub, "code_usage", None)
        with contextlib.suppress(Exception):
            for window in dict(meter.usage.windows).values() if meter is not None else ():
                take(window.kind, window.utilization, window.resets_at, window.status)
        out: dict[str, Any] = {k: round(v, 3) for k, v in seen.items()}
        if seen:
            out["used"] = round(max(seen.values()), 3)
        return out

    def budget_state(self) -> dict[str, Any]:
        budget = self.budget()
        spent = self.month_spent()
        out: dict[str, Any] = {"usd": budget, "spentUSD": round(spent, 4)}
        if budget > 0:
            fraction = spent / budget
            out["fraction"] = round(fraction, 4)
            pressure = max(
                0.0, min(1.0, (fraction - BUDGET_PRESSURE_FROM) / (1 - BUDGET_PRESSURE_FROM))
            )
            out["boost"] = round(BUDGET_BOOST * pressure, 1)
        return out

    def state(self) -> dict[str, Any]:
        learned = self.learned()
        on = self.learn_on()
        sessions: dict[str, Any] = {}
        voice = getattr(getattr(self.hub, "voicecode", None), "focus", None)
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code":
                continue
            track = self.tracks.get(task.id)
            sessions[str(task.id)] = _compact(
                {
                    "project": self.project(task),
                    "contextTokens": track.context if track and track.context else None,
                    "voice": True if voice == task.id else None,
                }
            )
        state = self._load_state()
        return {
            "learned": {
                "on": on,
                "frozen": bool(learned.get("frozen")),
                "updated": learned.get("updated"),
                "overrides": learned.get("overrides", {}) if on else {},
            },
            "quota": self.quota(),
            "budget": self.budget_state(),
            "agenticCallsPerTurn": self.agentic(),
            "autoFallback": self.hub.prefs.feature(PREF_FALLBACK) is not False,
            "sessions": sessions,
            "learner": {
                "installed": self.learner_installed(),
                "last": (state.get("learn") or {}).get("last"),
                "note": (state.get("learn") or {}).get("note", ""),
            },
        }

    def learner_installed(self) -> bool:
        """Whether model-router-learn is there (looked for at most once a minute)."""
        now = time.monotonic()
        if self._script is None or now - self._script[0] > 60:
            self._script = (now, learner_script() is not None)
        return self._script[1]

    def push_state(self) -> None:
        """model_router_state to the windows, at most every STATE_EVERY seconds."""
        if self._push_timer is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        wait = self._pushed + STATE_EVERY - loop.time()
        if wait > 0:
            self._push_timer = loop.call_later(wait, self._push_now)
        else:
            self._push_now()

    def _push_now(self) -> None:
        if self._push_timer is not None:
            self._push_timer.cancel()
            self._push_timer = None
        with contextlib.suppress(RuntimeError):
            self._pushed = asyncio.get_running_loop().time()
        try:
            self.hub.emit("model_router_state", **self.state())
        except Exception:
            log.exception("Model Router: couldn't send its state")

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self._push_now()

    # ── learned.json ──

    def learned_path(self) -> Path:
        return self.hub.feature_path(LEARNED_FILE)

    def learned(self) -> dict[str, Any]:
        """learned.json as the window may take it (read again when it changed)."""
        path = self.learned_path()
        try:
            stat = path.stat()
        except OSError:
            self._learned = None
            return {}
        if self._learned is not None and self._learned[0] == stat.st_mtime_ns:
            return self._learned[1]
        data: dict[str, Any] = {}
        if stat.st_size <= MAX_LEARNED_BYTES:
            try:
                raw = jsonstore.load_json(path, _learned_shape)
            except Exception:
                raw = None
            data = clean_learned(raw)
        else:
            log.warning("Model Router: learned.json is %d bytes; not used", stat.st_size)
        self._learned = (stat.st_mtime_ns, data)
        return data

    def _write_learned(self, data: dict[str, Any]) -> None:
        jsonstore.save_json(self.learned_path(), data, indent=None)
        self._learned = None

    # ── model_router_state.json ──

    def _load_state(self) -> dict[str, Any]:
        if self._state is None:
            try:
                data = jsonstore.load_json(self.hub.feature_path(STATE_FILE), dict)
            except Exception:
                data = None
            self._state = data if isinstance(data, dict) else {}
            prices = self._state.get("prices")
            if isinstance(prices, dict) and not self.prices:
                self.prices = {
                    k: v
                    for k, v in prices.items()
                    if _id(k) and isinstance(v, dict) and {"in", "out"} <= set(v)
                }
        return self._state

    def _save_state(self, changes: dict[str, Any]) -> None:
        state = self._load_state()
        state.update(changes)
        data = dict(state)
        path = self.hub.feature_path(STATE_FILE)

        def write() -> None:
            try:
                jsonstore.save_json(path, data, indent=None, backup=False)
            except Exception:
                log.exception("Model Router: couldn't save its state")

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            write()
            return
        loop.run_in_executor(None, write)

    # ── the window's calls (model_router_call -> model_router_reply) ──

    async def cmd_call(self, msg: dict[str, Any]) -> None:
        rid = str(msg.get("rid") or "")[:40]
        op = msg.get("op")
        try:
            data = await self._call(op, msg)
        except ValueError as exc:  # (what the window asked for isn't right: said back)
            self.hub.emit("model_router_reply", rid=rid, ok=False, error=str(exc)[:200])
            return
        except Exception as exc:
            log.exception("Model Router: %s failed", str(op)[:40])
            self.hub.emit("model_router_reply", rid=rid, ok=False, error=str(exc)[:200])
            return
        self.hub.emit("model_router_reply", rid=rid, ok=True, data=data)

    async def _call(self, op: Any, msg: dict[str, Any]) -> Any:
        if op == "learned":
            learned = self.learned()
            return {
                "frozen": bool(learned.get("frozen")),
                "updated": learned.get("updated"),
                "changes": learned.get("report", []),
                "on": self.learn_on(),
            }
        if op == "reset":
            await asyncio.to_thread(self._reset)
            self._push_now()
            return {"reset": True}
        if op == "freeze":
            frozen = msg.get("frozen") is True
            await asyncio.to_thread(self._freeze, frozen)
            self._push_now()
            return {"frozen": frozen}
        if op == "spend":
            return await self.spend()
        if op == "budget":
            usd = _clean_budget(msg.get("usd"))
            if usd is None:
                raise ValueError("A budget is an amount in dollars, like 50.")
            self.hub.set_feature_prefs({PREF_BUDGET: usd})
            self._push_now()
            return {"budgetUSD": usd}
        raise ValueError(f"unknown op {str(op)[:40]!r}")

    def _reset(self) -> None:
        """Reset learning: learned.json goes, and the learner reads only what comes after."""
        for path in (self.learned_path(), self.learned_path().with_name(LEARNED_FILE + ".bak")):
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
        self._learned = None
        state = self._load_state()
        state["since"] = iso(self.clock())
        state["learn"] = {**(state.get("learn") or {}), "new": 0}
        jsonstore.save_json(
            self.hub.feature_path(STATE_FILE), dict(state), indent=None, backup=False
        )

    def _freeze(self, frozen: bool) -> None:
        path = self.learned_path()
        try:
            raw = jsonstore.load_json(path, _learned_shape)
        except Exception:
            raw = None
        data = raw if isinstance(raw, dict) else {"v": 1, "overrides": {}}
        data["frozen"] = frozen
        data.setdefault("updated", iso(self.clock()))
        self._write_learned(data)

    # ── spend (D16) ──

    def month_start(self, now: float | None = None) -> float:
        moment = datetime.fromtimestamp(self.clock() if now is None else now)
        return moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()

    def _month_key(self) -> str:
        return datetime.fromtimestamp(self.clock()).strftime("%Y-%m")

    def month_spent(self) -> float:
        """This calendar month's API dollars on routed messages: read from the log once,
        off the event loop (0 until then), then counted as turns end."""
        key = self._month_key()
        if self._month is not None and self._month[0] == key:
            return self._month[1]
        if self._month_job is None or self._month_job.done():
            with contextlib.suppress(RuntimeError):
                self._month_job = asyncio.get_running_loop().create_task(self.load_month())
        return self._month[1] if self._month is not None else 0.0

    async def load_month(self) -> float:
        key = self._month_key()
        start = self.month_start()

        def read() -> float:
            by_msg: dict[str, float] = {}
            for record in self.log.read(since=start):
                actual = record.get("actual")
                if record.get("kind") == "update" and isinstance(actual, dict):
                    cost = actual.get("costUSD")
                    if isinstance(cost, int | float) and math.isfinite(cost):
                        by_msg[str(record.get("msg"))] = float(cost)  # (cumulative: the last)
            return sum(by_msg.values())

        await self.log.flush()
        try:
            total = await asyncio.to_thread(read)
        except Exception:
            log.exception("Model Router: couldn't read this month's spend")
            total = 0.0
        self._month = (key, total)
        self.push_state()
        return total

    def _spent(self, delta: float) -> None:
        if not delta or self._month is None or self._month[0] != self._month_key():
            return
        key, total = self._month
        self._month = (key, total + delta)
        budget = self.budget()
        if budget and (total + delta) / budget >= BUDGET_PRESSURE_FROM > total / budget:
            self.push_state()

    async def spend(self) -> dict[str, Any]:
        await self.log.flush()
        return await asyncio.to_thread(self.spend_now)

    def spend_now(self) -> dict[str, Any]:
        """This calendar month from the log: API dollars by model, the API price of what ran
        on the plan, and what the routes saved against the best-quality option each time
        (the router's estimates)."""
        start = self.month_start()
        key: tuple | None
        try:
            stats = [(str(p), p.stat()) for p in self.log.files()]
            key = (*((n, st.st_size, st.st_mtime_ns) for n, st in stats), start, self.budget())
        except OSError:  # (rotated meanwhile: read it all again)
            key = None
        if key is not None and self._spend_cache is not None and self._spend_cache[0] == key:
            return self._spend_cache[1]
        routes: dict[str, dict[str, Any]] = {}
        actual: dict[str, dict[str, Any]] = {}
        for record in self.log.read(since=start):
            msg = str(record.get("msg") or "")
            if not msg:
                continue
            if record.get("kind") is None:
                routes[msg] = record
            elif record.get("kind") == "update" and isinstance(record.get("actual"), dict):
                actual[msg] = record["actual"]
        by_model: dict[str, dict[str, Any]] = {}
        saved = 0.0
        for msg, used in actual.items():
            route = routes.get(msg) or {}
            model = str(used.get("model") or (route.get("applied") or {}).get("model") or "?")
            row = by_model.setdefault(model, {"model": model, "calls": 0, "usd": 0.0})
            row["calls"] += 1
            if isinstance(used.get("costUSD"), int | float):
                row["usd"] = round(row["usd"] + float(used["costUSD"]), 6)
            if isinstance(used.get("notionalUSD"), int | float):
                row["notionalUSD"] = round(
                    row.get("notionalUSD", 0.0) + float(used["notionalUSD"]), 6
                )
        for route in routes.values():
            settings = route.get("settings") or {}
            best, pick = route.get("best") or {}, route.get("pick") or {}
            if settings.get("shadow") or (route.get("route") or {}).get("skipped"):
                continue
            b, p = best.get("costUSD"), pick.get("costUSD")
            if isinstance(b, int | float) and isinstance(p, int | float) and b > p:
                saved += b - p
        rows = sorted(by_model.values(), key=lambda r: (-r["usd"], -r["calls"]))
        out: dict[str, Any] = {
            "periodStart": iso(start),
            "totalUSD": round(sum(r["usd"] for r in rows), 4),
            "byModel": rows,
            "savedVsBestUSD": round(saved, 4),
            "notionalUSD": round(sum(r.get("notionalUSD", 0.0) for r in rows), 4),
            "messages": len(routes),
        }
        if self.budget():
            out["budgetUSD"] = self.budget()
        if key is not None:
            self._spend_cache = (key, out)
        return out

    # ── the learner ──

    def _counted_new(self) -> None:
        state = self._load_state()
        learn = dict(state.get("learn") or {})
        learn["new"] = int(learn.get("new") or 0) + 1
        state["learn"] = learn
        self.maybe_learn()

    def maybe_learn(self, force: bool = False) -> None:
        """Run the learner when enough is new (or force: the nightly run), off the loop."""
        if self._learning is not None and not self._learning.done():
            return
        if not self.learn_on() or self.learned().get("frozen"):
            return
        learn = self._load_state().get("learn") or {}
        new = int(learn.get("new") or 0)
        last = epoch_of(learn.get("last")) or 0.0
        if force:  # the nightly run: when anything was logged since the last one
            with contextlib.suppress(OSError):
                if new <= 0 and self.log.path.stat().st_mtime > last:
                    new = 1
            if new <= 0:
                return
        elif new < LEARN_EVERY or self.clock() - last < LEARN_GAP_SECONDS:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._learning = loop.create_task(self.run_learner())

    async def run_learner(self) -> str:
        """model-router-learn over the log, into learned.json: "" when it learned, else why
        not."""
        note = ""
        try:
            await self.log.flush()
            run = self.learner or _run_learner
            note = await run(self)
        except Exception as exc:
            log.exception("Model Router: the learner failed")
            note = f"failed: {type(exc).__name__}"
        state = self._load_state()
        learn = dict(state.get("learn") or {})
        learn.update(last=iso(self.clock()), note=note)
        if not note:
            learn["new"] = 0
        self._save_state({"learn": learn})
        self._learned = None
        self._push_now()
        return note

    async def nightly(self) -> None:
        """Each night: the log's retention, then the learner if anything is new."""
        while True:
            now = datetime.now()
            at = now.replace(hour=NIGHTLY[0], minute=NIGHTLY[1], second=0, microsecond=0)
            if at <= now:
                at += timedelta(days=1)
            await asyncio.sleep(max(60.0, (at - now).total_seconds()))
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.log.prune)
            with contextlib.suppress(Exception):
                self.maybe_learn(force=True)


def clean_learned(raw: Any) -> dict[str, Any]:
    """learned.json as it's used here: frozen, updated, overrides (a model -> override map,
    passed on as it is, within MAX_OVERRIDES_JSON) and the report rows."""
    if not isinstance(raw, dict) or raw.get("v") not in (1, None):
        return {}
    out: dict[str, Any] = {"frozen": raw.get("frozen") is True}
    if isinstance(raw.get("updated"), str):
        out["updated"] = raw["updated"][:40]
    overrides = raw.get("overrides")
    if isinstance(overrides, dict):
        kept = {k: v for k, v in overrides.items() if _id(k) and isinstance(v, dict)}
        if len(json.dumps(kept)) <= MAX_OVERRIDES_JSON:
            out["overrides"] = kept
        else:
            log.warning("Model Router: learned.json's overrides are too big; not used")
    rows = []
    for row in raw.get("report") if isinstance(raw.get("report"), list) else []:
        if not isinstance(row, dict) or not _id(row.get("model")):
            continue
        rows.append(
            _compact(
                {
                    "model": row["model"],
                    "dim": _word(row.get("dim")),
                    "from": _num(row.get("from"), -1e6, 1e6, 3),
                    "to": _num(row.get("to"), -1e6, 1e6, 3),
                    "n": _num(row.get("n"), 0, 1e9, 2),
                    "why": str(row.get("why"))[:300] if isinstance(row.get("why"), str) else None,
                }
            )
        )
        if len(rows) >= 200:
            break
    out["report"] = rows
    return out


def model_router_home() -> Path:
    return Path(os.environ.get("MODEL_ROUTER_HOME") or Path.home() / "Model Router")


def learner_script(folder: Path | None = None) -> Path | None:
    """model-router-learn as the Model Router repo builds it (its package.json bin), or
    None when that repo isn't there or isn't built."""
    folder = folder or model_router_home()
    candidates: list[Path] = []
    with contextlib.suppress(Exception):
        package = json.loads((folder / "package.json").read_text())
        bin_ = package.get("bin") if isinstance(package, dict) else None
        if isinstance(bin_, dict) and isinstance(bin_.get("model-router-learn"), str):
            candidates.append(folder / bin_["model-router-learn"])
    candidates += [folder / "dist" / "learn" / "cli.js", folder / "dist" / "learn-cli.js"]
    for path in candidates:
        with contextlib.suppress(OSError):
            if path.is_file() and folder.resolve() in path.resolve().parents:
                return path
    return None


def _node() -> str | None:
    return shutil.which("node") or next((p for p in NODE_PATHS if Path(p).is_file()), None)


async def _run_learner(events: Events) -> str:
    script = learner_script()
    if script is None:
        return "not installed"
    node = _node()
    if node is None:
        return "no node"
    files = [str(p) for p in events.log.files()]
    since = epoch_of(events._load_state().get("since"))
    scratch: Path | None = None
    if since is not None:  # after Reset learning: only what came since
        scratch = events.hub.feature_path(".model_router_events.since.jsonl")
        await asyncio.to_thread(_copy_since, events.log, since, scratch)
        files = [str(scratch)]
    if not files:
        return "no events"
    out = events.hub.feature_path(".learned.next.json")
    with contextlib.suppress(OSError):  # (what it learned before, should it build on it)
        shutil.copyfile(events.learned_path(), out)
    nice = ["/usr/bin/nice", "-n", "10"] if Path("/usr/bin/nice").is_file() else []
    proc = await asyncio.create_subprocess_exec(
        *nice, node, str(script), *files, "--out", str(out), "--now", iso(events.clock()),
        cwd=str(model_router_home()), stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
    )  # fmt: skip
    try:
        _, err = await asyncio.wait_for(proc.communicate(), LEARN_TIMEOUT)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        return "timed out"
    finally:
        if scratch is not None:
            with contextlib.suppress(OSError):
                scratch.unlink()
    if proc.returncode != 0:
        log.warning("Model Router: the learner said %s", err.decode("utf-8", "replace")[-500:])
        return f"exit {proc.returncode}"
    try:
        raw = json.loads(out.read_text())
    except (OSError, ValueError):
        return "no output"
    finally:
        with contextlib.suppress(OSError):
            out.unlink()
    if not clean_learned(raw) or not isinstance(raw, dict):
        return "bad output"
    if events.learned().get("frozen"):
        return "frozen"  # (frozen while it ran)
    raw["frozen"] = False
    await asyncio.to_thread(events._write_learned, raw)
    return ""


def _copy_since(event_log: EventLog, since: float, dest: Path) -> None:
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        for record in event_log.read(since=since):
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")


def install(hub: Any) -> None:
    events = Events(hub)
    hub.code_router_events = events
    hub.add_task_sink(events.on_task_event)
    hub.tasks.message_sinks.append(events.on_message)
    hub.add_event_sink(["code_hunk_undone"], events.on_hunk_undone)
    hub.add_event_sink(["usage", "cu_state"], lambda _e: events.push_state())
    for kind in (
        "task_model", "task_effort", "task_interrupt", "task_cancel", *_RETRYABLE_CMDS,
    ):  # fmt: skip
        hub.register_command(kind, events.observer(kind))
    hub.register_command("model_router_state_get", events.cmd_state)
    hub.register_command("model_router_feedback", events.cmd_feedback)
    hub.register_command("model_router_prices", events.cmd_prices)
    hub.register_command("model_router_call", events.cmd_call, slow=True)
    hub.register_loop("model_router_nightly", events.nightly)
    hub.add_quit_hook(events.log.flush_now)
