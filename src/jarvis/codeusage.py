"""Jarvis Code's spending and Claude's usage limits: what each day and each project cost,
the owner's caps (each session, each project a day, all of Jarvis Code a day) with a
heads-up at 50, 80 and 100% of each, and the usage windows Claude Code reports for the
owner's plan (the five-hour and weekly limits: how much is used, when each resets).

A turn's cost is Claude Code's own estimate, as the turn's line in the transcript shows it
(TaskManager._count_cost). A session's total is its own (ClaudeTask.cost_usd, kept with it
across restarts by features.code_sessions); days and projects are counted here, in
code_usage.json beside the settings (jsonstore: whole saves swapped in, a .bak), for the
last DAYS_KEPT days, with the caps the owner set for one session or one project. Read
defensively: a damaged or hand-edited file is set aside and the counts start over; nothing
here ever keeps a session from running because of the file. Saved a moment after a change,
off the event loop (a turn's cost is counted on it), and at once where there's no loop.

Heads-ups come as a turn's cost crosses a mark (50, 80 or 100% of a cap), once per
crossing: a cap raised later doesn't say anything, and a day starts from nothing.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore

log = logging.getLogger("jarvis")

DAYS_KEPT = 90
PROJECTS_PER_DAY = 200  # projects counted in one day; past this they share "other"
SESSION_CAPS_KEPT = 300
PROJECT_CAPS_KEPT = 300
THRESHOLDS = (50, 80, 100)  # percent of a cap (or of a usage window) worth a heads-up
SAVE_DELAY = 1.0  # seconds: changes close together are saved once
OTHER = "(other projects)"
# Claude's usage windows as Claude Code names them, and as the window says them.
WINDOWS = {
    "five_hour": "5-hour limit",
    "seven_day": "weekly limit",
    "seven_day_opus": "weekly Opus limit",
    "seven_day_sonnet": "weekly Sonnet limit",
    "overage": "extra usage",
}
WINDOWS_ZH = {
    "five_hour": "5 小时额度",
    "seven_day": "每周额度",
    "seven_day_opus": "每周 Opus 额度",
    "seven_day_sonnet": "每周 Sonnet 额度",
    "overage": "额外用量",
}
STATUSES = ("allowed", "allowed_warning", "rejected")


def money_value(value: Any) -> float | None:
    """A cost or cap as it's kept: a finite, non-negative number, else None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    value = float(value)
    return round(value, 6) if math.isfinite(value) and value >= 0 else None


def money(value: float) -> str:
    """$20, $20.50, $0.03: as the window and JARVIS say an amount."""
    value = round(max(0.0, float(value)), 2)
    return f"${value:,.0f}" if value == int(value) else f"${value:,.2f}"


def crossed(before: float, after: float, cap: float) -> int:
    """The highest mark (50, 80, 100 percent of cap) this spending went past, 0 for none."""
    if cap <= 0 or after <= before:
        return 0
    was, now = 100 * before / cap, 100 * after / cap
    passed = [t for t in THRESHOLDS if was < t <= now]
    return max(passed) if passed else 0


@dataclass(frozen=True)
class Caps:
    """What may be spent (0 or less: no cap)."""

    session: float = 0.0  # one session, all told
    project: float = 0.0  # one project, a day
    day: float = 0.0  # all of Jarvis Code, a day

    def any(self) -> bool:
        return self.session > 0 or self.project > 0 or self.day > 0


@dataclass
class Window:
    """One of Claude's usage windows, as Claude Code last reported it."""

    kind: str
    status: str = "allowed"  # allowed | allowed_warning | rejected
    utilization: float | None = None  # 0..1 used, when Claude Code says
    resets_at: float = 0.0  # epoch seconds, 0 when not said
    heard: float = 0.0  # when it was reported (epoch seconds)

    @property
    def percent(self) -> int | None:
        if self.utilization is None:
            return None
        return max(0, min(100, round(self.utilization * 100)))

    def public(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "label": WINDOWS.get(self.kind, self.kind.replace("_", " ")),
            "status": self.status,
            "percent": self.percent,
            "resets_at": self.resets_at or None,
            "heard": self.heard or None,
        }


def _window_from(raw: Any) -> Window | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("kind"), str):
        return None
    status = raw.get("status") if raw.get("status") in STATUSES else "allowed"
    use = raw.get("utilization")
    use = float(use) if isinstance(use, int | float) and not isinstance(use, bool) else None
    if use is not None and not (math.isfinite(use) and 0 <= use <= 10):
        use = None
    resets = money_value(raw.get("resets_at")) or 0.0
    heard = money_value(raw.get("heard")) or 0.0
    return Window(raw["kind"][:40], status, use, resets, heard)


def epoch(value: Any) -> float:
    """A reset time as Claude Code gives it (epoch seconds, or milliseconds), in seconds."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return 0.0
    value = float(value)
    return value / 1000 if value > 1e11 else max(0.0, value)


class Usage:
    """The counts and caps, in code_usage.json (path None keeps them in memory)."""

    def __init__(
        self,
        path: Path | None = None,
        today: Callable[[], date] = date.today,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.path = path
        self._today = today
        self._clock = clock or (lambda: datetime.now().timestamp())
        self.days: dict[str, dict[str, Any]] = {}
        self.windows: dict[str, Window] = {}
        self.session_caps: dict[str, float] = {}  # session key -> its own cap
        self.project_caps: dict[str, float] = {}  # project folder -> its own cap a day
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self._timer: asyncio.TimerHandle | None = None  # a save is due
        self._writing = False
        self._writer: asyncio.Future | None = None  # (held: a running save isn't let go)
        self._again = False  # another change came in while a save was being written
        self._load()

    # ── the file ──

    def _load(self) -> None:
        if self.path is None:
            return
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("Jarvis Code usage: %s can't be read (%s)", self.path.name, exc)
            return
        days = data.get("days")
        for day, raw in days.items() if isinstance(days, dict) else []:
            if not isinstance(raw, dict) or not _is_day(day):
                continue
            total = money_value(raw.get("total"))
            if total is None:
                continue
            projects = raw.get("projects") if isinstance(raw.get("projects"), dict) else {}
            turns = raw.get("turns")
            self.days[day] = {
                "total": total,
                "turns": turns if isinstance(turns, int) and turns >= 0 else 0,
                "projects": {
                    str(k)[:1000]: cost
                    for k, raw_cost in list(projects.items())[:PROJECTS_PER_DAY]
                    if (cost := money_value(raw_cost)) is not None
                },
            }
        windows = data.get("windows")
        for raw in windows if isinstance(windows, list) else []:
            window = _window_from(raw)
            if window is not None:
                self.windows[window.kind] = window
        for name, into in (
            ("session_caps", self.session_caps),
            ("project_caps", self.project_caps),
        ):
            caps = data.get(name)
            for key, value in caps.items() if isinstance(caps, dict) else []:
                if isinstance(key, str) and key and (cap := money_value(value)) is not None:
                    into[key[:1000]] = cap
        self._prune()

    def _data(self) -> dict[str, Any]:
        return {
            "days": copy.deepcopy(self.days),
            "windows": [
                {
                    "kind": w.kind,
                    "status": w.status,
                    "utilization": w.utilization,
                    "resets_at": w.resets_at,
                    "heard": w.heard,
                }
                for w in self.windows.values()
            ],
            "session_caps": dict(self.session_caps),
            "project_caps": dict(self.project_caps),
        }

    def _write(self, data: dict[str, Any]) -> None:
        """A save that fails (a full disk) keeps the counts for this run; it never turns
        into an error for a session."""
        try:
            jsonstore.save_json(self.path, data)
        except OSError as exc:
            log.warning("couldn't save Jarvis Code's usage (%s)", exc)

    def save(self) -> None:
        """Soon, in the background, with a loop running (one save for changes close
        together); at once without one."""
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
        if self._writing:
            self._again = True  # one more after this one
            return
        self._writing = True
        self._writer = asyncio.ensure_future(self._write_later(self._data()))

    async def _write_later(self, data: dict[str, Any]) -> None:
        try:
            try:
                writing = asyncio.get_running_loop().run_in_executor(None, self._write, data)
            except RuntimeError:  # the app is quitting (the loop's threads are gone): now
                self._write(data)
            else:
                await writing
        finally:
            self._writing = False
            if self._again:
                self._again = False
                self.save()

    def day(self) -> str:
        """Today, as the counts are kept."""
        return self._today().isoformat()

    def _prune(self) -> None:
        oldest = (self._today() - timedelta(days=DAYS_KEPT - 1)).isoformat()
        for day in [d for d in self.days if d < oldest]:
            del self.days[day]
        for caps, kept in (
            (self.session_caps, SESSION_CAPS_KEPT),
            (self.project_caps, PROJECT_CAPS_KEPT),
        ):
            for key in list(caps)[:-kept]:
                del caps[key]

    # ── spending ──

    def add(self, project: str, cost: float) -> tuple[float, float]:
        """One turn's cost, counted today (for all of Jarvis Code, and its project): the
        day's and the project's spending before it, for the marks it crossed."""
        cost = money_value(cost) or 0.0
        day = self._today().isoformat()
        entry = self.days.setdefault(day, {"total": 0.0, "turns": 0, "projects": {}})
        before_day = entry["total"]
        projects = entry["projects"]
        key = project if project in projects or len(projects) < PROJECTS_PER_DAY else OTHER
        before_project = projects.get(key, 0.0)
        entry["total"] = round(before_day + cost, 6)
        entry["turns"] += 1
        projects[key] = round(before_project + cost, 6)
        self._prune()
        self.save()
        return before_day, before_project

    def today(self) -> float:
        return self.days.get(self._today().isoformat(), {}).get("total", 0.0)

    def project_today(self, project: str) -> float:
        day = self.days.get(self._today().isoformat(), {})
        return day.get("projects", {}).get(project, 0.0)

    def recent(self, n: int = 14) -> list[dict[str, Any]]:
        """The last n days, oldest first, a day with nothing spent included."""
        today = self._today()
        out = []
        for back in range(n - 1, -1, -1):
            day = (today - timedelta(days=back)).isoformat()
            entry = self.days.get(day, {})
            out.append(
                {"day": day, "total": entry.get("total", 0.0), "turns": entry.get("turns", 0)}
            )
        return out

    def projects_on(self, day: str | None = None) -> list[dict[str, Any]]:
        """Each project's spending on one day (today), the most first."""
        entry = self.days.get(day or self._today().isoformat(), {})
        items = sorted(entry.get("projects", {}).items(), key=lambda kv: -kv[1])
        return [{"project": k, "name": Path(k).name or k, "cost": v} for k, v in items]

    # ── caps set for one session or one project ──

    def set_session_cap(self, key: str, cap: float | None) -> None:
        if not key:
            return
        self.session_caps.pop(key, None)
        if cap is not None and (value := money_value(cap)) is not None:
            self.session_caps[key] = value  # (newest last: the oldest are let go first)
        self._prune()
        self.save()

    def set_project_cap(self, project: str, cap: float | None) -> None:
        if not project:
            return
        self.project_caps.pop(project, None)
        if cap is not None and (value := money_value(cap)) is not None:
            self.project_caps[project] = value
        self._prune()
        self.save()

    def caps_for(self, session_key: str, project: str, defaults: Caps) -> Caps:
        """The caps that hold for one session in one project: its own where the owner set
        one (0 means none), the defaults otherwise."""
        session = self.session_caps.get(session_key) if session_key else None
        project_cap = self.project_caps.get(project) if project else None
        return Caps(
            session=defaults.session if session is None else session,
            project=defaults.project if project_cap is None else project_cap,
            day=defaults.day,
        )

    # ── Claude's usage windows ──

    def hear(self, info: Any) -> tuple[Window | None, int]:
        """A rate-limit report from Claude Code (the SDK's RateLimitInfo): the window it's
        about, and the mark (50, 80, 100%) its use just went past, 0 for none. A window
        that reset (a new reset time) starts from nothing."""
        kind = getattr(info, "rate_limit_type", None)
        status = getattr(info, "status", None)
        if not isinstance(kind, str) or not kind or status not in STATUSES:
            return None, 0
        use = getattr(info, "utilization", None)
        use = float(use) if isinstance(use, int | float) and not isinstance(use, bool) else None
        if use is not None and not (math.isfinite(use) and 0 <= use <= 10):
            use = None
        resets = epoch(getattr(info, "resets_at", None))
        was = self.windows.get(kind)
        before = 0.0
        if (
            was is not None
            and was.utilization is not None
            and (not resets or was.resets_at == resets)
        ):
            before = was.utilization
        window = Window(kind[:40], status, use, resets, self._clock())
        if use is None and was is not None and was.resets_at == resets:
            window.utilization = was.utilization  # (a status change alone keeps what's known)
        self.windows[window.kind] = window
        self.save()
        mark = crossed(before * 100, use * 100, 100) if use is not None else 0
        if status == "rejected" and (was is None or was.status != "rejected"):
            mark = 100  # used up, whether or not it said how much
        return window, mark

    def windows_public(self) -> list[dict[str, Any]]:
        """The windows worth showing: one that has reset since it was heard shows as reset."""
        now = self._clock()
        order = list(WINDOWS)
        out = []
        for window in sorted(
            self.windows.values(),
            key=lambda w: order.index(w.kind) if w.kind in order else len(order),
        ):
            item = window.public()
            if window.resets_at and window.resets_at <= now:
                item.update(
                    status="allowed",
                    percent=0 if window.utilization is not None else None,
                    reset=True,
                )
            out.append(item)
        return out


def _is_day(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 10:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True
