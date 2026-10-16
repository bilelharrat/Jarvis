"""Eden Code's cost forecast: what a message is likely to cost before it's sent, and how much
of Claude's 5-hour and weekly usage windows it's likely to take, from what similar messages
in the same project cost before; and the quota-aware plan for a project's to-do cards (which
run now, which wait for a window to reset, which go to a cheaper model or another provider,
which run overnight).

Statistics only: no model is ever asked. What it keeps (code_forecast.json beside the
settings, jsonstore: whole saves swapped in, 0600) is one line per finished turn of an Eden
Code session: when, the project (the SHA-256 of its folder, 12 hex, as the Model Router's
event log keeps it), the model, the turn's cost, tokens and seconds, how deep in its session
the turn was, the prompt's length and kind (a fix, a test, a question…: a few word rules),
and the prompt's words as salted hashes (HMAC-SHA-256 with a secret made on this Mac, 8 hex
each, at most WORDS_KEPT): enough to tell two prompts are alike, never what either said. No
prompt text is written. A turn the owner's message didn't start (a background task's) isn't
kept: it has no prompt to be like.

How a forecast is made (History.forecast):
- The candidates are the project's own turns; with fewer than MIN_SIMILAR of them, every
  project's (scope "all"). Each is scored for likeness: its words (Jaccard over the hashed
  words), its kind, its length and its depth in the session (a turn deep in a long session
  re-reads more of it, and costs more). Each is weighed by how recent it is (HALF_LIFE).
- A turn on another model is priced up or down to the model asked about (Claude's tiers:
  Haiku 1, Sonnet 3, Opus 5, Anthropic's list prices' ratios; another provider's from the
  price list the window sent the Model Router), and counts less; one whose price can't be
  compared isn't used.
- The TOP most alike (at least MIN_SCORE alike, and LIKE_BEST of the best's) give the range: the weighted 20th to 80th
  percentile of their costs, and the median as "typical". Too few alike: the project's
  recent turns, said to be rough.
- The windows' share: Claude reports each window's use as a fraction (the Session card's
  plan numbers, and Claude Code's rate-limit reports), not per turn. So Eden learns a rate
  per window: how much the window's use went up between two readings (the same window: the
  same reset time) against what Eden Code's sessions spent in between (History.hear), with
  older pairs counting less. The share of a forecast is its cost times that rate. The rate
  counts all of the window's use against Eden Code's spending only (the owner's other Claude
  use counts in it too), so a share leans high, never low. Until a rate is known (MIN_RATE
  dollars seen), only the cost is forecast.

The plan (schedule): the waiting cards in the owner's order, each with a forecast on the
model it would run on; Claude's windows as they stand, and the money left under the owner's
caps and the queue's ceiling. A card that fits runs now, and what it's likely to take is
counted as taken for the cards after it. One that doesn't fit Claude's 5-hour (or weekly)
window goes to a cheaper model on the queue's ladder that fits (the owner's own pick for the
card is never changed), else to another provider's model when the owner lets work cross to
another company (the Model Router's code_router_cross_fallback), else waits for that window to
reset. A big card (BIG_FIVE of the 5-hour window, or BIG_COST dollars when no rate is known)
in the day waits for the night (NIGHT_FROM to NIGHT_TO), when the windows are the owner's
least, if the owner lets it (code_queue_overnight). A window already used up holds every
Claude card until it resets, forecast or not. Each decision carries its reason, for the card.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore

log = logging.getLogger("jarvis")
STORE = "code_forecast"
jsonstore.register_store(STORE, 1)

KEPT = 3000  # turns kept, newest
DAYS_KEPT = 90
SEEN_KEPT = 6000  # turn ids already counted (a session's transcript read again isn't twice)
WORDS_KEPT = 48
MIN_SIMILAR = 3  # a project's own turns needed before other projects' are left out
TOP = 15
MIN_SCORE = 0.2
LIKE_BEST = 0.6  # ... and at least this share of the best one's likeness
HALF_LIFE = 30 * 86400.0  # seconds: a turn a month old counts half
OTHER_MODEL = 0.7  # a turn on another model, priced to this one, counts this much
OTHER_PROJECT = 0.6  # ... one from another project (scope "all")
POOL = 1500  # candidates looked at, newest (a forecast stays a few milliseconds)
WINDOW_KINDS = ("five_hour", "seven_day")
MIN_RATE = 1.0  # dollars of Eden Code spending seen against a window before its rate is used
RATE_DECAY = 0.97  # each new pair of readings: the older ones count this much less
STALE = 6 * 3600.0  # a reading older than this isn't paired with the next
SAVE_DELAY = 2.0

# Claude's price tiers (Anthropic's list prices, input and output alike: Haiku $1/$5,
# Sonnet $3/$15, Opus $5/$25 per million tokens): only their ratios are used.
TIERS = {"haiku": 1.0, "sonnet": 3.0, "opus": 5.0}

# The plan's limits.
FIVE_MAX = 0.95  # a card isn't started that would take the 5-hour window past this
WEEK_MAX = 0.97
FULL = 0.99  # a window used this much (or "rejected") holds every Claude card
BIG_FIVE = 0.25  # a card likely to take this much of the 5-hour window is big
BIG_COST = 5.0  # ... or this many dollars, when no rate is known
NIGHT_FROM, NIGHT_TO = 1, 6  # local hours: the night a big card waits for

_KINDS = (
    ("fix", re.compile(r"\b(fix|bug|broken|crash|error|fails?|failing|regression|wrong)\b|修|错误|崩溃|报错")),
    ("test", re.compile(r"\b(tests?|spec|coverage|pytest|jest|unit)\b|测试")),
    ("review", re.compile(r"\b(review|audit|check (?:my|the) (?:changes|diff))\b|审查|检查")),
    ("refactor", re.compile(r"\b(refactor|rename|clean ?up|simplify|extract|reorgani[sz]e)\b|重构|重命名")),
    ("docs", re.compile(r"\b(docs?|readme|comment|docstring|changelog)\b|文档|注释")),
    ("explain", re.compile(r"^\s*(why|what|how|where|when|explain|can you tell)\b|\?\s*$|为什么|怎么|解释|吗[？?]?\s*$")),
    ("build", re.compile(r"\b(add|build|implement|create|make|new|feature|support)\b|添加|实现|新增|做一个")),
)  # fmt: skip
_STOP = frozenset(
    "the a an and or of to in on for with this that it is are be can you me my i we our "
    "please just also then so do does at as by from into up out all any some".split()
)
_LATIN = re.compile(r"[a-z0-9_][a-z0-9_.\-/]{1,40}")
_CJK = re.compile(r"[㐀-鿿]+")


def tokens(text: str) -> list[str]:
    """A prompt's words, as the forecast compares them: lowercased latin words (code names
    kept whole), stop words left out; a run of Chinese characters as its pairs."""
    text = str(text or "").lower()[:20_000]
    out = [w.strip(".-/") for w in _LATIN.findall(text)]
    out = [w for w in out if len(w) > 1 and w not in _STOP]
    for run in _CJK.findall(text):
        out += [run[i : i + 2] for i in range(max(1, len(run) - 1))]
    return out


def kind_of(text: str) -> str:
    """What a prompt asks for, by a few word rules (the first that fits): fix, test, review,
    refactor, docs, explain, build, else other."""
    text = str(text or "").lower()[:2000]
    for kind, rule in _KINDS:
        if rule.search(text):
            return kind
    return "other"


def tier(model: str) -> float | None:
    model = str(model or "").lower()
    return next((v for k, v in TIERS.items() if k in model), None)


def price_ratio(to: str, frm: str, prices: dict[str, Any] | None = None) -> float | None:
    """What a turn on frm would have cost on to, as a factor (None: can't be compared).
    Claude's by tier; another provider's from the router's price list (USD per 1M tokens,
    weighted as agentic turns are: mostly input)."""
    if to == frm:
        return 1.0
    a, b = tier(to), tier(frm)
    if a is not None and b is not None:
        return a / b

    def blended(model: str) -> float | None:
        row = (prices or {}).get(model)
        if not isinstance(row, dict):
            return None
        i, o = row.get("in"), row.get("out")
        if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in (i, o)):
            return None
        value = 0.85 * float(i) + 0.15 * float(o)
        return value if value > 0 and math.isfinite(value) else None

    pa, pb = blended(to), blended(frm)
    return pa / pb if pa and pb else None


def quantile(pairs: list[tuple[float, float]], q: float) -> float:
    """The weighted q-quantile of (value, weight) pairs."""
    pairs = sorted((v, w) for v, w in pairs if w > 0)
    if not pairs:
        return 0.0
    total = sum(w for _, w in pairs)
    seen = 0.0
    for value, weight in pairs:
        seen += weight
        if seen >= q * total - 1e-12:
            return value
    return pairs[-1][0]


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _closeness(a: float, b: float, span: float) -> float:
    """1 for the same, down to 0 when a and b are span apart in log2."""
    return max(0.0, 1.0 - abs(math.log2(1 + a) - math.log2(1 + b)) / span)


@dataclass
class Turn:
    at: float
    project: str
    model: str
    words: frozenset
    kind: str
    chars: int
    depth: int
    cost: float
    tokens: int = 0
    seconds: int = 0

    def saved(self) -> dict[str, Any]:
        return {
            "at": round(self.at, 1),
            "p": self.project,
            "m": self.model,
            "w": sorted(self.words),
            "k": self.kind,
            "c": self.chars,
            "d": self.depth,
            "cost": self.cost,
            "tok": self.tokens,
            "sec": self.seconds,
        }


def _num(value: Any, lo: float = 0.0, hi: float = 1e9) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    value = float(value)
    return value if math.isfinite(value) and lo <= value <= hi else None


def _turn_from(raw: Any) -> Turn | None:
    if not isinstance(raw, dict):
        return None
    at, cost = _num(raw.get("at"), 0, 1e11), _num(raw.get("cost"), 0, 1e5)
    project, model = raw.get("p"), raw.get("m")
    if at is None or cost is None or not isinstance(project, str) or not isinstance(model, str):
        return None
    words = raw.get("w") if isinstance(raw.get("w"), list) else []
    return Turn(
        at=at,
        project=project[:12],
        model=model[:100],
        words=frozenset(w for w in words[:WORDS_KEPT] if isinstance(w, str) and len(w) == 8),
        kind=str(raw.get("k") or "other")[:12],
        chars=int(_num(raw.get("c"), 0, 1e6) or 0),
        depth=int(_num(raw.get("d"), 0, 1e4) or 0),
        cost=round(cost, 6),
        tokens=int(_num(raw.get("tok"), 0, 1e12) or 0),
        seconds=int(_num(raw.get("sec"), 0, 1e7) or 0),
    )


class History:
    """The turns and the windows' rates, in code_forecast.json (path None: in memory)."""

    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self.clock = clock
        self.salt = ""
        self.turns: list[Turn] = []
        self.seen: dict[str, None] = {}  # turn ids counted (insertion order: oldest first)
        # window -> {"du": its use's rise, "cost": Eden Code's spending, both decayed; "n"}
        self.rates: dict[str, dict[str, float]] = {}
        # window -> the last reading: {"used", "resets", "spent" (the counter then), "at"}
        self.readings: dict[str, dict[str, float]] = {}
        self.spent = 0.0  # all Eden Code has spent since the counter began (never goes down)
        self.unreadable = ""
        self.version = 0  # goes up with each change (the plans' caches look at it)
        self._timer: asyncio.TimerHandle | None = None
        self._load()
        if not self.salt:
            self.salt = secrets.token_hex(16)

    # ── the file ──

    def _load(self) -> None:
        if self.path is None:
            return
        try:
            data = jsonstore.load_store(self.path, STORE) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("Eden Code forecast: %s can't be read (%s)", self.path.name, exc)
            return
        salt = data.get("salt")
        if isinstance(salt, str) and re.fullmatch(r"[0-9a-f]{32}", salt):
            self.salt = salt
        for raw in (data.get("turns") if isinstance(data.get("turns"), list) else [])[-KEPT:]:
            turn = _turn_from(raw)
            if turn is not None:
                self.turns.append(turn)
        seen = data.get("seen") if isinstance(data.get("seen"), list) else []
        self.seen = {s: None for s in seen[-SEEN_KEPT:] if isinstance(s, str) and len(s) == 16}
        for name, into in (("rates", self.rates), ("readings", self.readings)):
            raw = data.get(name) if isinstance(data.get(name), dict) else {}
            for kind in WINDOW_KINDS:
                row = raw.get(kind)
                if isinstance(row, dict):
                    clean = {k: v for k, v in row.items() if _num(v, -1, 1e11) is not None}
                    if clean:
                        into[kind] = {k: float(v) for k, v in clean.items()}
        self.spent = _num(data.get("spent"), 0, 1e9) or 0.0
        self._prune()

    def _data(self) -> dict[str, Any]:
        return {
            "salt": self.salt,
            "turns": [t.saved() for t in self.turns],
            "seen": list(self.seen),
            "rates": {k: dict(v) for k, v in self.rates.items()},
            "readings": {k: dict(v) for k, v in self.readings.items()},
            "spent": round(self.spent, 6),
        }

    def _write(self, data: dict[str, Any]) -> None:
        try:
            jsonstore.save_store(self.path, STORE, data)
        except OSError as exc:
            log.warning("couldn't save Eden Code's forecast (%s)", exc)

    def save(self) -> None:
        """Soon, off the event loop (with one running); at once without one."""
        self.version += 1
        if self.path is None or self.unreadable:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._write(self._data())
            return
        if self._timer is None:
            self._timer = loop.call_later(SAVE_DELAY, self._save_now)

    def _save_now(self) -> None:
        self._timer = None
        data = self._data()
        try:
            asyncio.get_running_loop().run_in_executor(None, self._write, data)
        except RuntimeError:
            self._write(data)

    def flush(self) -> None:
        """Now (the app quitting)."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
            if self.path is not None and not self.unreadable:
                self._write(self._data())

    def _prune(self) -> None:
        oldest = self.clock() - DAYS_KEPT * 86400.0
        self.turns = [t for t in self.turns if t.at >= oldest][-KEPT:]
        while len(self.seen) > SEEN_KEPT:
            self.seen.pop(next(iter(self.seen)))

    # ── what it hears ──

    def words(self, text: str) -> frozenset:
        """A prompt's words as kept: salted hashes, 8 hex each."""
        key = self.salt.encode()
        out: dict[str, None] = {}
        for word in tokens(text):
            out[hmac.new(key, word.encode("utf-8"), hashlib.sha256).hexdigest()[:8]] = None
            if len(out) >= WORDS_KEPT:
                break
        return frozenset(out)

    def turn_id(self, key: str) -> str:
        return hmac.new(self.salt.encode(), str(key).encode(), hashlib.sha256).hexdigest()[:16]

    def add(
        self,
        key: str,
        project: str,
        model: str,
        text: str,
        depth: int,
        cost: float,
        tokens_used: int = 0,
        seconds: int = 0,
        at: float | None = None,
    ) -> bool:
        """One finished turn (key: the turn's own, so the same turn read twice counts once).
        project: the project's hash. False when it was counted already."""
        tid = self.turn_id(key)
        if tid in self.seen:
            return False
        cost_value = _num(cost, 0, 1e5)
        if cost_value is None or not str(text or "").strip():
            return False
        self.seen[tid] = None
        self.turns.append(
            Turn(
                at=float(at if at is not None else self.clock()),
                project=str(project)[:12],
                model=str(model or "")[:100],
                words=self.words(text),
                kind=kind_of(text),
                chars=len(str(text)),
                depth=max(0, int(depth)),
                cost=round(cost_value, 6),
                tokens=max(0, int(tokens_used or 0)),
                seconds=max(0, int(seconds or 0)),
            )
        )
        self.turns.sort(key=lambda t: t.at)  # (a session read back may bring older turns)
        self._prune()
        self.save()
        return True

    def count(self, cost: float) -> None:
        """What one of Eden Code's turns spent (every turn's, a prompt's or not): the counter
        a window's rise is paired with."""
        value = _num(cost, 0, 1e5)
        if value:
            self.spent = round(self.spent + value, 6)
            self.save()

    def hear(self, kind: str, used: float | None, resets: float, at: float | None = None) -> None:
        """A window's reading (its use, 0..1, and when it resets). Paired with the last one
        of the same window (the same reset time, not too old): the rise in its use against
        what Eden Code spent between them goes into the window's rate."""
        if kind not in WINDOW_KINDS or used is None:
            return
        now = float(at if at is not None else self.clock())
        last = self.readings.get(kind)
        if last is not None and last.get("used") == used and last.get("resets") == resets:
            last["at"] = now  # (the same reading again: still current, paired from where it was)
            return
        if (
            last is not None
            and resets
            and last.get("resets") == resets
            and now - last.get("at", 0.0) <= STALE
        ):
            rise = used - last.get("used", 0.0)
            spent = self.spent - last.get("spent", self.spent)
            if rise >= 0 and spent > 0:
                row = self.rates.setdefault(kind, {"du": 0.0, "cost": 0.0, "n": 0.0})
                row["du"] = row["du"] * RATE_DECAY + rise
                row["cost"] = row["cost"] * RATE_DECAY + spent
                row["n"] = row.get("n", 0.0) + 1
        self.readings[kind] = {"used": used, "resets": resets, "spent": self.spent, "at": now}
        self.save()

    def rate(self, kind: str) -> float | None:
        """A window's use per dollar Eden Code spends (None until MIN_RATE dollars are seen)."""
        row = self.rates.get(kind)
        if not row or row.get("cost", 0.0) < MIN_RATE or row.get("n", 0) < 2:
            return None
        return row["du"] / row["cost"]

    # ── a forecast ──

    def forecast(
        self,
        project: str,
        text: str,
        model: str,
        depth: int = 0,
        prices: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """What a message is likely to cost on model (project: its hash). {"n": 0} when
        nothing to go by."""
        now = self.clock()
        words, kind, chars = self.words(text), kind_of(text), len(str(text or ""))
        own = [t for t in self.turns[-POOL * 2 :] if t.project == project][-POOL:]
        scope = "project"
        pool = own
        if len(own) < MIN_SIMILAR:
            pool, scope = self.turns[-POOL:], "all"
        scored: list[tuple[float, float, Turn, float]] = []  # (score, weight, turn, its cost here)
        for turn in pool:
            ratio = price_ratio(model, turn.model, prices) if model else 1.0
            if ratio is None:
                continue
            score = (
                0.5 * _jaccard(words, turn.words)
                + 0.2 * (kind == turn.kind)
                + 0.15 * _closeness(chars, turn.chars, 6)
                + 0.15 * _closeness(depth, turn.depth, 4)
            )
            weight = 0.5 ** (max(0.0, now - turn.at) / HALF_LIFE)
            if turn.model != model:
                weight *= OTHER_MODEL
            if turn.project != project:
                weight *= OTHER_PROJECT
            scored.append((score, weight, turn, turn.cost * ratio))
        if not scored:
            return {"n": 0, "model": model}
        best = max(s[0] for s in scored)
        floor = max(
            MIN_SCORE, LIKE_BEST * best
        )  # (alike: near the best, not just better than none)
        alike = sorted((s for s in scored if s[0] >= floor), key=lambda s: -s[0] * s[1])
        chosen = alike[:TOP]
        rough = len(chosen) < MIN_SIMILAR
        if rough:  # (too few alike: the recent turns, said to be rough)
            chosen = sorted(scored, key=lambda s: -s[2].at)[:TOP]
            scope = "recent" if scope == "project" else scope
        pairs = [(cost, max(1e-6, score) * weight) for score, weight, _t, cost in chosen]
        likeness = sum(s for s, *_ in chosen) / len(chosen)
        n = len(chosen)
        confidence = (
            "rough" if rough or n < 4 else "good" if n >= 8 and likeness >= 0.45 else "fair"
        )
        low, mid, high = (quantile(pairs, q) for q in (0.2, 0.5, 0.8))
        seconds = quantile([(t.seconds, w) for _s, w, t, _c in chosen], 0.5)
        out: dict[str, Any] = {
            "n": n,
            "model": model,
            "low": round(low, 4),
            "mid": round(mid, 4),
            "high": round(max(high, mid), 4),
            "seconds": int(seconds),
            "scope": scope,
            "confidence": confidence,
            "windows": {},
        }
        if tier(model) is not None or model.startswith("claude"):  # (only Claude's use its windows)
            for kind_name in WINDOW_KINDS:
                rate = self.rate(kind_name)
                if rate is not None:
                    out["windows"][kind_name] = {
                        "low": round(low * rate, 4),
                        "mid": round(mid * rate, 4),
                        "high": round(max(high, mid) * rate, 4),
                    }
        return out


# ── the plan ──


@dataclass
class Room:
    """What's left now: Claude's windows (used 0..1, None: not known; when each resets) and
    the money under the owner's caps and the queue's ceiling (None: no cap)."""

    five: float | None = None
    five_resets: float = 0.0
    week: float | None = None
    week_resets: float = 0.0
    money: float | None = None
    money_why: str = ""  # "day" | "project" | "ceiling": which of them is least
    money_back: float = 0.0  # when the money comes back (a day's cap: midnight), 0: never


def night_start(now: float) -> float:
    """The next NIGHT_FROM o'clock (local), from now."""
    when = datetime.fromtimestamp(now)
    start = when.replace(hour=NIGHT_FROM, minute=0, second=0, microsecond=0)
    if start <= when:
        start += timedelta(days=1)
    return start.timestamp()


def is_night(now: float) -> bool:
    return NIGHT_FROM <= datetime.fromtimestamp(now).hour < NIGHT_TO


def _share(forecast: dict[str, Any] | None, kind: str, key: str = "high") -> float | None:
    window = ((forecast or {}).get("windows") or {}).get(kind)
    return float(window[key]) if isinstance(window, dict) else None


def _fits(forecast: dict[str, Any] | None, room: Room, claude: bool) -> str:
    """ "" when a card with this forecast fits the room, else what it doesn't fit: "five",
    "week" or "money"."""
    f = forecast or {}
    if claude:
        five, week = _share(f, "five_hour"), _share(f, "seven_day")
        if room.five is not None and five is not None and room.five + five > FIVE_MAX:
            return "five"
        if room.week is not None and week is not None and room.week + week > WEEK_MAX:
            return "week"
    if room.money is not None and f.get("n") and float(f.get("mid") or 0) > room.money:
        return "money"
    return ""


def reserve(forecast: dict[str, Any] | None, room: Room, claude: bool) -> None:
    """A card that starts: what it's likely to take, taken from the room for the next."""
    f = forecast or {}
    if claude:
        five, week = _share(f, "five_hour", "mid"), _share(f, "seven_day", "mid")
        if room.five is not None and five is not None:
            room.five += five
        if room.week is not None and week is not None:
            room.week += week
    if room.money is not None and f.get("n"):
        room.money -= float(f.get("mid") or 0)


def schedule(
    items: list[dict[str, Any]],
    room: Room,
    now: float,
    overnight: bool = True,
) -> dict[str, dict[str, Any]]:
    """The plan for the waiting cards, in order. Each item: {id, ref (the model it would run
    on), claude (whether that's one of Claude's, under its windows), fixed (the owner named
    it: never changed), forecast, cheaper: [(ref, claude, forecast)] (the ladder's cheaper
    rungs, nearest first), other: (ref, forecast) or None (another provider's, when the owner
    lets work cross)}. Card id -> {action: now | cheaper | other | wait | overnight, ref,
    until (epoch, 0: none), reason, forecast}."""
    plan: dict[str, dict[str, Any]] = {}
    for item in items:
        f, claude = item.get("forecast") or {}, bool(item.get("claude"))
        decision: dict[str, Any] = {"ref": item.get("ref") or "", "until": 0.0, "forecast": f}
        full_five = claude and room.five is not None and room.five >= FULL
        full_week = claude and room.week is not None and room.week >= FULL
        short = "five" if full_five else "week" if full_week else _fits(f, room, claude)
        if not short:
            big_share = _share(f, "five_hour")
            big = (big_share is not None and big_share >= BIG_FIVE) or (
                big_share is None and f.get("n") and float(f.get("high") or 0) >= BIG_COST
            )
            if overnight and big and claude and not is_night(now):
                decision.update(action="overnight", until=night_start(now), reason="big")
            else:
                decision.update(action="now", reason="fits" if f.get("n") else "no_data")
                reserve(f, room, claude)
            plan[item["id"]] = decision
            continue
        moved = None
        if not item.get("fixed"):
            for ref, c_claude, c_forecast in item.get("cheaper") or []:
                if (
                    c_forecast.get("n")
                    and not _fits(c_forecast, room, c_claude)
                    and not (c_claude and (full_five or full_week))
                ):
                    moved = ("cheaper", ref, c_claude, c_forecast)
                    break
            other = item.get("other")
            if moved is None and other and short in ("five", "week"):
                ref, o_forecast = other
                if not _fits(o_forecast, room, False):
                    moved = ("other", ref, False, o_forecast)
        if moved is not None:
            action, ref, m_claude, m_forecast = moved
            decision.update(action=action, ref=ref, reason=short, forecast=m_forecast)
            reserve(m_forecast, room, m_claude)
        elif short == "money" and not room.money_back:
            # (the queue's own ceiling: no tomorrow to wait for. It runs, and Claude Code's
            # max_budget_usd stops it at the ceiling, as before)
            decision.update(action="now", reason="tight")
            reserve(f, room, claude)
        else:
            until = (
                room.five_resets
                if short == "five"
                else room.week_resets
                if short == "week"
                else room.money_back
            )
            decision.update(action="wait", until=float(until or 0.0), reason=short)
        plan[item["id"]] = decision
    return plan
