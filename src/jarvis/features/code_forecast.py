"""Eden Code's cost forecast before each message, and the quota-aware plan for the to-do
column and the routing queue (code_forecast; the statistics are in codeforecast.py).

What it adds, and where:
- What it hears (add_task_sink): each session's messages and the end of each turn (the
  turn's line in the transcript: its cost, tokens and seconds). A turn the owner's message
  started is kept for the forecast (codeforecast.History: numbers and salted word hashes,
  never the words); every turn's cost goes into the counter the usage windows' rates are
  learned against, and the windows are read again (the Session card's plan numbers,
  hub.usage.limits, and Claude Code's rate-limit reports, code_usage's meter). Sessions
  already open when the forecast is first asked for are read back once, so the forecast
  has the turns they had.
- Window command cf_forecast {rid, id? (the session), directory? (a new session's folder),
  text, model? (a ref: the Model Router's pick, when it's on)} -> cf_forecast {rid, n, low,
  mid, high, seconds, scope, confidence, model, label, windows: {five_hour | seven_day:
  {low, mid, high}}, now: {five_hour | seven_day: {used, resets}}}, or {rid, off: true}
  when the forecast is off in Settings. The window shows it in the status line under the
  composer (web/features/code-forecast.js): the composer itself is unchanged.
- The plan for each project's waiting cards (plan(folder): codeforecast.schedule): which run
  now, which wait for a window to reset, which go to a cheaper model on the queue's ladder or
  to another provider (only with the Model Router's "other companies" switch on, never a
  card from GitHub), which run overnight; each with its reason in words. code_todo's
  todo_state carries it (plans: {card id: decision}), shown on each card; the routing queue
  (code_queue) follows it: a card that waits keeps its place while the next that fits
  starts, and a card sent to a cheaper model or another provider starts there. Starting a
  card by hand runs it now, whatever the plan says.
- Settings (prefs.features, Eden Code settings › Limits): code_forecast_show (the forecast
  under the composer, on), code_queue_overnight (big cards in the queue wait for the night,
  on).

Cost policy: this feature never calls a model. A forecast and a plan are statistics over
what Claude Code reported earlier turns cost; reading them is local.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import time
from datetime import datetime, timedelta
from typing import Any

from .. import lang, prefs
from ..codeforecast import WINDOW_KINDS, History, Room, reserve, schedule
from ..codeplatform import code_task, other_agent, project_of
from ..codeusage import money
from ..prefs import MODELS

log = logging.getLogger("jarvis")

PREF_SHOW = "code_forecast_show"
PREF_OVERNIGHT = "code_queue_overnight"
CROSS_PREF = "code_router_cross_fallback"  # (code_router's: work may go to another company)
prefs.register_feature_pref(PREF_SHOW, True)
prefs.register_feature_pref(PREF_OVERNIGHT, True)

TEXT_MAX = 20_000
PENDING_MAX = 6  # the owner's messages waiting for their turn, per session
PLANNED_MAX = 40  # waiting cards planned per project (the rest go in their turn)
LEARNED_EVERY = 300.0  # seconds: the queue's learned results, read again this often
BOARD_EVERY = 2.0  # seconds: the board's plans told again after turns, at most this often
PASS_RATE = 2 / 3  # (code_queue's: a model that passed this share here isn't "known bad")

ZH = {
    "Runs in its turn: there's no similar work here yet to forecast from.": "按顺序运行：这里还没有类似的工作可用来预测。",
    "Runs now on {model}: it fits Claude's limits and your spending limits.": "现在用 {model} 运行：在 Claude 的额度和你的花费上限之内。",
    "Runs now on {model}, though it may reach the queue's ceiling ({left} left): it stops there.": "现在用 {model} 运行，不过可能会碰到队列的上限（还剩 {left}）：到了就停。",
    "Runs overnight, from {time}: it's a big one, and the night leaves the day's limits to you. Start it to run it now.": "夜里运行，从{time}开始：这张卡片的工作量大，夜里运行能把白天的额度留给你。点“开始”可立即运行。",
    "Waits for Claude's 5-hour limit to reset ({time}): it's at {used}, and this card would take it past {cap}.": "等 Claude 的 5 小时额度重置（{time}）：现在用了 {used}，这张卡片会让它超过 {cap}。",
    "Waits for Claude's 5-hour limit to reset ({time}): it's used up.": "等 Claude 的 5 小时额度重置（{time}）：已经用完了。",
    "Waits for Claude's weekly limit to reset ({time}): it's at {used}, and this card would take it past {cap}.": "等 Claude 的每周额度重置（{time}）：现在用了 {used}，这张卡片会让它超过 {cap}。",
    "Waits for Claude's weekly limit to reset ({time}): it's used up.": "等 Claude 的每周额度重置（{time}）：已经用完了。",
    "Waits for tomorrow: it would likely spend more than is left of today's spending limit ({left}).": "等到明天：它很可能会超出今天花费上限的剩余额度（{left}）。",
    "Goes to {model}, a cheaper model: on {was} it wouldn't fit Claude's 5-hour limit.": "改用更便宜的 {model}：用 {was} 的话会超出 Claude 的 5 小时额度。",
    "Goes to {model}, a cheaper model: on {was} it wouldn't fit Claude's weekly limit.": "改用更便宜的 {model}：用 {was} 的话会超出 Claude 的每周额度。",
    "Goes to {model}, a cheaper model: on {was} it would likely spend more than is left ({left}).": "改用更便宜的 {model}：用 {was} 的话很可能会超出剩余额度（{left}）。",
    "Goes to {model} on your own key: Claude's 5-hour limit is too near to fit it.": "改用你自己密钥的 {model}：Claude 的 5 小时额度快用完了，放不下它。",
    "Goes to {model} on your own key: Claude's weekly limit is too near to fit it.": "改用你自己密钥的 {model}：Claude 的每周额度快用完了，放不下它。",
    "Likely {cost}.": "预计 {cost}。",
    "Likely {cost}, {five} of Claude's 5-hour limit.": "预计 {cost}，占 Claude 5 小时额度的 {five}。",
    "Likely {cost}, {five} of Claude's 5-hour limit and {week} of the weekly limit.": "预计 {cost}，占 Claude 5 小时额度的 {five}，每周额度的 {week}。",
    "later": "稍后",
}
lang.add_texts(ZH)


def percent(value: float) -> str:
    """A window's share for people: "under 1%", "4%"."""
    pct = round(100 * max(0.0, float(value)))
    return "<1%" if pct < 1 else f"{pct}%"


def share_range(low: float, high: float) -> str:
    a, b = percent(low), percent(high)
    return a if a == b else f"{a.lstrip('<')}–{b}" if a != "<1%" else f"<1–{b}"


def cost_range(low: float, high: float) -> str:
    a, b = money(low), money(high)
    return a if a == b else f"{a}–{b}"


def _next_midnight(now: float) -> float:
    day = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    return (day + timedelta(days=1)).timestamp()


class Forecaster:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._history: History | None = None
        self.pending: dict[int, list[str]] = {}  # session -> the owner's messages this turn
        self.learned: dict[str, tuple[float, dict[str, tuple[int, int]]]] = {}
        self._plans: dict[str, tuple[Any, dict[str, dict[str, Any]]]] = {}
        self.jobs: set[asyncio.Task] = set()
        self._emit_due = False

    # ── plumbing ──

    @property
    def history(self) -> History:
        """The turns, read at first use (never at install: tests make many hubs), with the
        sessions open then read back once."""
        if self._history is None:
            self._history = History(self.hub.feature_path("code_forecast.json"))
            with contextlib.suppress(Exception):  # (a forecast is a guide: never a failure)
                self.read_back()
        return self._history

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def spawn(self, coro: Any) -> None:
        try:
            job = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            coro.close()
            return
        self.jobs.add(job)
        job.add_done_callback(self.jobs.discard)

    def model_id(self, ref: str) -> str:
        """The model a ref runs (what a turn's model is kept as)."""
        ref = str(ref or "")
        if ref in MODELS:
            return MODELS[ref]
        try:
            return str(self.hub.providers.session_config(ref, grant=False).get("model") or ref)
        except Exception:
            return ref

    def label(self, ref: str) -> str:
        try:
            return str(self.hub.providers.describe(ref) or ref)
        except Exception:
            return ref

    def claude(self, ref: str) -> bool:
        """Whether a model is one of Claude's on the owner's sign-in (under its windows)."""
        try:
            return self.hub.providers.resolve(ref) in MODELS
        except Exception:
            return ref in MODELS

    def default_ref(self) -> str:
        p = self.hub.prefs
        return str(getattr(p, "code_model", "") or getattr(p, "model", "") or "opus")

    def prices(self) -> dict[str, Any]:
        events = getattr(self.hub, "code_router_events", None)
        return dict(getattr(events, "prices", {}) or {})

    def session_model(self, task: Any) -> str:
        """The model a session's turns ran on: its ref's (as a forecast names it), else the
        one Claude Code reported, else the owner's default (a session on the default)."""
        if task.model_ref:
            return self.model_id(task.model_ref)
        return str(task.model or "") or self.model_id(self.default_ref())

    @staticmethod
    def key_of(task: Any) -> str:
        return str(task.session_id or f"task:{task.id}")

    # ── what it hears ──

    def read_back(self) -> None:
        """The sessions open now (or resting), read from their transcripts once: a message
        and the turn after it, each kept as one turn (the same turn is never kept twice)."""
        history = self._history
        if history is None:
            return
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code" or other_agent(task):
                continue
            project = _project_hash(project_of(self.hub, task))
            model, texts, depth = self.session_model(task), [], 0
            for entry in list(task.transcript):
                role = entry.get("role")
                if role == "user" and entry.get("text"):
                    texts.append(str(entry["text"]))
                elif role == "turn":
                    if texts:
                        history.add(
                            f"{self.key_of(task)}:{entry.get('n')}",
                            project,
                            model,
                            "\n".join(texts)[:TEXT_MAX],
                            depth,
                            entry.get("cost") or 0.0,
                            entry.get("tokens") or 0,
                            entry.get("seconds") or 0,
                            at=_epoch(entry.get("at")),
                        )
                    texts, depth = [], depth + 1

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        try:
            if kind == "task_log":
                self._on_entry(data.get("id"), data.get("entry") or {})
            elif kind == "tasks":
                for gone in set(self.pending) - set(self.hub.tasks.tasks):
                    self.pending.pop(gone, None)
        except Exception:
            log.exception("Eden Code forecast: couldn't take in a session's turn")

    def _on_entry(self, task_id: Any, entry: dict[str, Any]) -> None:
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or task.kind != "code" or other_agent(task):
            return
        role = entry.get("role")
        if role == "user" and entry.get("text"):
            texts = self.pending.setdefault(task.id, [])
            texts.append(str(entry["text"])[:TEXT_MAX])
            del texts[:-PENDING_MAX]
        elif role == "turn":
            history = self.history
            cost = entry.get("cost") or 0.0
            history.count(cost)
            texts = self.pending.pop(task.id, [])
            depth = max(0, turns_of(task) - 1)  # (its turns before this one)
            if texts:
                history.add(
                    f"{self.key_of(task)}:{entry.get('n')}",
                    _project_hash(project_of(self.hub, task)),
                    self.session_model(task),
                    "\n".join(texts)[:TEXT_MAX],
                    depth,
                    cost,
                    entry.get("tokens") or 0,
                    entry.get("seconds") or 0,
                )
            self.read_windows()
            self.boards_soon()

    def boards_soon(self) -> None:
        """The to-do cards' plans told again after a turn (what's left of the windows moved),
        once for turns close together."""
        todo = getattr(self.hub, "code_todo", None)
        if (
            todo is None
            or self._emit_due
            or not any(c.get("state") in ("todo", "queued") for c in todo.board.cards)
        ):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._emit_due = True

        def emit() -> None:
            self._emit_due = False
            with contextlib.suppress(Exception):
                todo.emit()

        loop.call_later(BOARD_EVERY, emit)

    def windows(self) -> dict[str, dict[str, float | None]]:
        """Claude's 5-hour and weekly windows as last reported: {kind: {used (0..1, None:
        not said), resets (epoch, 0: not said)}}. One that has reset since counts as fresh
        (used 0, reset time not known). The latest report of each wins."""
        now = time.time()
        seen: dict[str, tuple[float, float | None, float]] = {}  # kind -> (heard, used, resets)

        def take(kind: Any, used: Any, resets: Any, status: Any, heard: Any) -> None:
            if kind not in WINDOW_KINDS:
                return
            resets = (
                float(resets)
                if isinstance(resets, int | float) and not isinstance(resets, bool)
                else 0.0
            )
            resets = resets / 1000 if resets > 1e11 else resets
            if status == "rejected":
                used = 1.0
            if isinstance(used, bool) or not isinstance(used, int | float):
                used = None
            if resets and resets <= now:
                used, resets = 0.0, 0.0  # (reset since: a fresh window)
            heard = (
                float(heard)
                if isinstance(heard, int | float) and not isinstance(heard, bool)
                else 0.0
            )
            if kind not in seen or heard >= seen[kind][0]:
                value = None if used is None else min(1.0, max(0.0, float(used)))
                seen[kind] = (heard, value, resets)

        with contextlib.suppress(Exception):
            for kind, e in dict(getattr(self.hub.usage, "limits", {}) or {}).items():
                if isinstance(e, dict):
                    take(
                        kind,
                        e.get("utilization"),
                        e.get("resets_at"),
                        e.get("status"),
                        e.get("seen"),
                    )
        meter = getattr(self.hub, "code_usage", None)
        with contextlib.suppress(Exception):
            for w in dict(meter.usage.windows).values() if meter is not None else ():
                take(w.kind, w.utilization, w.resets_at, w.status, w.heard)
        return {k: {"used": used, "resets": resets} for k, (_h, used, resets) in seen.items()}

    def read_windows(self) -> None:
        history = self.history
        for kind, w in self.windows().items():
            history.hear(kind, w["used"], float(w["resets"] or 0.0))

    # ── a forecast ──

    def forecast(self, folder: str, text: str, ref: str, depth: int = 0) -> dict[str, Any]:
        ref = ref or self.default_ref()
        out = self.history.forecast(
            _project_hash(folder), text, self.model_id(ref), depth, self.prices()
        )
        out["ref"], out["label"] = ref, self.label(ref)
        if not self.claude(ref):
            out["windows"] = {}  # (another provider's model: not on Claude's windows)
        out["now"] = self.windows()
        return out

    def cmd_forecast(self, msg: dict[str, Any]) -> None:
        rid = str(msg.get("rid") or "")[:40]
        if self.hub.prefs.feature(PREF_SHOW) is False:
            self.hub.emit("cf_forecast", rid=rid, off=True)
            return
        text = msg.get("text")
        if not isinstance(text, str) or not text.strip():
            self.hub.emit("cf_forecast", rid=rid, n=0)
            return
        task = code_task(self.hub, msg) if msg.get("id") is not None else None
        if task is not None and other_agent(task):
            self.hub.emit("cf_forecast", rid=rid, n=0)  # (another agent's cost isn't Claude's)
            return
        if task is not None:
            folder = project_of(self.hub, task)
            depth = turns_of(task)
            ref = str(msg.get("model") or task.model_ref or "")
        else:
            try:
                folder = str(self.hub.tasks.resolve_dir(str(msg.get("directory") or "")))
            except (ValueError, OSError):
                self.hub.emit("cf_forecast", rid=rid, n=0)
                return
            depth, ref = 0, str(msg.get("model") or "")
        try:
            out = self.forecast(folder, text[:TEXT_MAX], ref[:200], depth)
        except Exception:
            log.exception("Eden Code forecast: couldn't make a forecast")
            out = {"n": 0}
        self.hub.emit("cf_forecast", rid=rid, **out)

    # ── the plan ──

    def _learned(self, folder: str) -> dict[str, tuple[int, int]]:
        """The queue's learned results in this project (read again in the background now and
        then: the plan never waits for the event log)."""
        at, results = self.learned.get(folder, (0.0, {}))
        queue = getattr(self.hub, "code_queue", None)
        if queue is not None and time.monotonic() - at > LEARNED_EVERY:
            self.learned[folder] = (time.monotonic(), results)

            async def refresh() -> None:
                with contextlib.suppress(Exception):
                    self.learned[folder] = (time.monotonic(), await queue.learned(folder))
                    self._plans.pop(folder, None)

            self.spawn(refresh())
        return results

    def _ladder(self) -> list[str]:
        queue = getattr(self.hub, "code_queue", None)
        if queue is None:
            return []
        try:
            return list(queue.ladder())
        except Exception:
            return []

    def _planned(self, card: dict[str, Any], learned: dict[str, tuple[int, int]]) -> str:
        """The model a card would run on: as code_queue.pick picks it, from what's at hand."""
        if card.get("model"):
            return str(card["model"])
        for ref in self._ladder():
            passed, failed = learned.get(self.model_id(ref), (0, 0))
            if passed and passed / (passed + failed) >= PASS_RATE:
                return ref
        route = card.get("route") if isinstance(card.get("route"), dict) else {}
        ref = str(route.get("ref") or "")
        with contextlib.suppress(Exception):
            if ref and self.hub.providers.known(ref):
                return ref
        return self.default_ref()

    def _cheaper(self, ref: str, learned: dict[str, tuple[int, int]]) -> list[str]:
        """The ladder's rungs below ref, nearest first, leaving out any that failed Eden's
        checks here more than it passed."""
        ladder = self._ladder()
        model = self.model_id(ref)
        at = next((n for n, r in enumerate(ladder) if r == ref or self.model_id(r) == model), None)
        below = ladder[:at] if at is not None else []
        out = []
        for rung in reversed(below):
            passed, failed = learned.get(self.model_id(rung), (0, 0))
            if passed + failed >= 2 and passed / (passed + failed) < PASS_RATE:
                continue
            out.append(rung)
        return out

    def room(self, folder: str) -> Room:
        windows = self.windows()
        five, week = windows.get("five_hour") or {}, windows.get("seven_day") or {}
        room = Room(
            five=five.get("used"),
            five_resets=float(five.get("resets") or 0.0),
            week=week.get("used"),
            week_resets=float(week.get("resets") or 0.0),
        )
        left: list[tuple[float, str]] = []
        meter = getattr(self.hub, "code_usage", None)
        with contextlib.suppress(Exception):
            if meter is not None:
                caps = meter.usage.caps_for("", folder, meter.defaults())
                if caps.day > 0:
                    left.append((caps.day - meter.usage.today(), "day"))
                if caps.project > 0:
                    left.append((caps.project - meter.usage.project_today(folder), "project"))
        queue = getattr(self.hub, "code_queue", None)
        run = getattr(queue, "runs", {}).get(folder) if queue is not None else None
        if run is not None and run.on:
            with contextlib.suppress(Exception):
                left.append((run.ceiling - queue.spent(run), "ceiling"))
        if left:
            value, why = min(left)
            room.money, room.money_why = max(0.0, value), why
            room.money_back = _next_midnight(time.time()) if why != "ceiling" else 0.0
        return room

    def plan(self, folder: str) -> dict[str, dict[str, Any]]:
        """The plan for a project's waiting cards: card id -> its decision (public)."""
        todo = getattr(self.hub, "code_todo", None)
        if todo is None:
            return {}
        cards = todo.board.of(folder)
        waiting = [c for c in cards if c.get("state") in ("todo", "queued")][:PLANNED_MAX]
        if not waiting:
            return {}
        try:
            history = self.history
            learned = self._learned(folder)
            room = self.room(folder)
            overnight = self.hub.prefs.feature(PREF_OVERNIGHT) is not False
            cross = self.hub.prefs.feature(CROSS_PREF) is True
            now = time.time()
            key = (
                history.version,
                tuple(
                    (
                        c["id"],
                        c.get("state"),
                        c.get("model"),
                        hashlib.sha1(str(c["prompt"]).encode()).hexdigest(),
                    )
                    for c in cards
                    if c.get("state") in ("todo", "queued", "running")
                ),
                tuple(sorted(learned.items())),
                (room.five, room.five_resets, room.week, room.week_resets),
                None if room.money is None else round(room.money, 2),
                overnight,
                cross,
                tuple(self._ladder()),
                int(now // 60),  # (the night begins, a reset passes: looked at each minute)
            )
            cached = self._plans.get(folder)
            if cached is not None and cached[0] == key:
                return cached[1]
            plan = self._make_plan(folder, cards, waiting, learned, room, overnight, cross, now)
        except Exception:
            log.exception("Eden Code forecast: couldn't plan the cards")
            return {}
        self._plans[folder] = (key, plan)
        return plan

    def _make_plan(self, folder, cards, waiting, learned, room, overnight, cross, now):
        # What the cards running now are likely to take is taken first (their reports may
        # not be in yet).
        for card in cards:
            if card.get("state") == "running":
                ref = str(((card.get("attempts") or [{}])[-1] or {}).get("model") or "")
                ref = ref or self._planned(card, learned)
                reserve(self.forecast(folder, card["prompt"], ref), room, self.claude(ref))
        other_ref = ""
        if cross:
            with contextlib.suppress(Exception):
                other_ref = str(self.hub.providers.pick_fallback() or "")
        items = []
        for card in waiting:
            ref = self._planned(card, learned)
            claude = self.claude(ref)
            item: dict[str, Any] = {
                "id": card["id"],
                "ref": ref,
                "claude": claude,
                "fixed": bool(card.get("model")),
                "forecast": self.forecast(folder, card["prompt"], ref),
                "cheaper": [],
                "other": None,
            }
            if not item["fixed"] and claude:
                item["cheaper"] = [
                    (r, self.claude(r), self.forecast(folder, card["prompt"], r))
                    for r in self._cheaper(ref, learned)
                ]
                if other_ref and not card.get("untrusted") and not card.get("cloud"):
                    item["other"] = (other_ref, self.forecast(folder, card["prompt"], other_ref))
            items.append(item)
        decisions = schedule(items, room, now, overnight=overnight)
        before = {i["id"]: i["ref"] for i in items}
        return {cid: self.public(d, before.get(cid, ""), room) for cid, d in decisions.items()}

    def public(self, d: dict[str, Any], was: str, room: Room) -> dict[str, Any]:
        """A decision as the card shows it: what, on which model, until when, and why."""
        f = d.get("forecast") or {}
        action, reason, ref = d["action"], d.get("reason", ""), d.get("ref") or ""
        zh = lang.is_zh(self.hub.language)
        until = float(d.get("until") or 0.0)
        when = _when(until, zh) if until else self.tr("later")
        model, was_label = self.label(ref), self.label(was)
        left = money(room.money or 0.0)
        if action == "now":
            if reason == "no_data":
                why = self.tr(
                    "Runs in its turn: there's no similar work here yet to forecast from."
                )
            elif reason == "tight":
                why = self.tr(
                    "Runs now on {model}, though it may reach the queue's ceiling ({left} left): it stops there.",
                    model=model,
                    left=left,
                )
            else:
                why = self.tr(
                    "Runs now on {model}: it fits Claude's limits and your spending limits.",
                    model=model,
                )
        elif action == "overnight":
            why = self.tr(
                "Runs overnight, from {time}: it's a big one, and the night leaves the day's "
                "limits to you. Start it to run it now.",
                time=when,
            )
        elif action == "cheaper":
            if reason == "money":
                why = self.tr(
                    "Goes to {model}, a cheaper model: on {was} it would likely spend more than is left ({left}).",
                    model=model,
                    was=was_label,
                    left=left,
                )
            else:
                limit = "5-hour" if reason == "five" else "weekly"
                why = self.tr(
                    f"Goes to {{model}}, a cheaper model: on {{was}} it wouldn't fit Claude's {limit} limit.",
                    model=model,
                    was=was_label,
                )
        elif action == "other":
            limit = "5-hour" if reason == "five" else "weekly"
            why = self.tr(
                f"Goes to {{model}} on your own key: Claude's {limit} limit is too near to fit it.",
                model=model,
            )
        elif reason == "money":
            why = self.tr(
                "Waits for tomorrow: it would likely spend more than is left of today's spending limit ({left}).",
                left=left,
            )
        else:
            limit = "5-hour" if reason == "five" else "weekly"
            used = room.five if reason == "five" else room.week
            cap = 0.95 if reason == "five" else 0.97
            if used is not None and used >= 0.99:
                why = self.tr(
                    f"Waits for Claude's {limit} limit to reset ({{time}}): it's used up.",
                    time=when,
                )
            else:
                why = self.tr(
                    f"Waits for Claude's {limit} limit to reset ({{time}}): it's at {{used}}, "
                    "and this card would take it past {cap}.",
                    time=when,
                    used=percent(used or 0.0),
                    cap=percent(cap),
                )
        detail = self.detail(f)
        out: dict[str, Any] = {
            "action": action,
            "reason": reason,
            "ref": ref,
            "label": model,
            "until": until or None,
            "why": f"{why} {detail}".strip() if action != "now" or reason != "no_data" else why,
            "n": int(f.get("n") or 0),
        }
        if f.get("n"):
            out.update(low=f.get("low"), mid=f.get("mid"), high=f.get("high"))
            out["windows"] = f.get("windows") or {}
        return out

    def detail(self, f: dict[str, Any]) -> str:
        if not f.get("n"):
            return ""
        cost = cost_range(float(f.get("low") or 0), float(f.get("high") or 0))
        windows = f.get("windows") or {}
        five, week = windows.get("five_hour"), windows.get("seven_day")
        if five and week:
            return self.tr(
                "Likely {cost}, {five} of Claude's 5-hour limit and {week} of the weekly limit.",
                cost=cost,
                five=share_range(five["low"], five["high"]),
                week=share_range(week["low"], week["high"]),
            )
        if five:
            return self.tr(
                "Likely {cost}, {five} of Claude's 5-hour limit.",
                cost=cost,
                five=share_range(five["low"], five["high"]),
            )
        return self.tr("Likely {cost}.", cost=cost)

    def plans(self) -> dict[str, dict[str, Any]]:
        """Every project's plan (for todo_state): card id -> decision."""
        todo = getattr(self.hub, "code_todo", None)
        if todo is None:
            return {}
        folders = {c["folder"] for c in todo.board.cards if c.get("state") in ("todo", "queued")}
        out: dict[str, dict[str, Any]] = {}
        for folder in folders:
            out.update(self.plan(folder))
        return out

    def quit(self) -> None:
        if self._history is not None:
            self._history.flush()


def turns_of(task: Any) -> int:
    """How many turns a session's transcript has (how deep in it the next one is)."""
    return sum(1 for e in task.transcript if e.get("role") == "turn")


def _project_hash(folder: str) -> str:
    from .code_router_events import project_hash

    return project_hash(folder)


def _epoch(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


def _when(epoch: float, zh: bool) -> str:
    from .code_limit import _clock

    return _clock(epoch, zh)


def install(hub: Any) -> None:
    forecaster = Forecaster(hub)
    hub.code_forecast = forecaster  # (for code_todo, code_queue and the tests)
    hub.add_task_sink(forecaster.on_task_event)
    hub.register_command("cf_forecast", forecaster.cmd_forecast)
    hub.add_quit_hook(forecaster.quit)
