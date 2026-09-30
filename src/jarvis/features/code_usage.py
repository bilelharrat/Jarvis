"""Jarvis Code's usage meter (codeusage): what each session, project and day cost, Claude's
usage windows (the plan's five-hour and weekly limits, as Claude Code reports them), the
owner's spending caps, and heads-ups at 50, 80 and 100% of each.

What it adds, and where:
- What it hears: each turn's cost (the turn's line in a session's transcript, through
  add_task_sink) and Claude Code's rate-limit reports (TaskManager.on_rate_limit, wrapped:
  JARVIS's own fallback still hears them first).
- A session's options (TaskManager.option_hooks): max_budget_usd, what may still be spent
  on that connection (the least of what's left of the session's, its project's and the
  day's caps, and of any cap another feature set before it), so Claude Code itself stops
  at the cap mid-turn. Its key is the caps (and the day, while a day's cap holds), so a
  cap changed reopens an open session, same conversation, between steps, and a new day
  reopens it quietly with the day's room.
- TaskManager.turn_gate: while a cap is used up, a session's next message waits, with a
  note in its transcript saying which cap and how to go on; a cap raised (or a new day)
  lets it go. A turn that uses up the day's or a project's cap interrupts the other
  sessions still working under that cap: Claude Code's own stop covers one session alone.
- Window commands: cu_state (the meter), cu_cap (one session's or one project's own cap).
- Settings (feature prefs, set from Jarvis Code settings): code_budget_session,
  code_budget_project (a day), code_budget_day, code_budget_alerts.
- A loop that lets held sessions go at midnight, when the day's caps start over.
- It never keeps a session from running because of its own trouble: a cap that can't be
  worked out is no cap, and a count that can't be saved is kept for this run.

Cost policy (Claude): this feature never calls a model. It counts what Claude Code reports
its sessions cost, and caps what they may spend.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .. import lang, prefs
from ..codeplatform import code_task, project_of
from ..codeusage import WINDOWS, WINDOWS_ZH, Caps, Usage, crossed, money, money_value
from ..proactive import Alert

log = logging.getLogger("jarvis")

PREF_SESSION = "code_budget_session"
PREF_PROJECT = "code_budget_project"
PREF_DAY = "code_budget_day"
PREF_ALERTS = "code_budget_alerts"
CAP_MAX = 100_000.0  # a cap past this is a typo, not a budget
NEAR = 0.005  # spent within half a cent of a cap counts as the cap reached
EMIT_EVERY = 0.5  # the meter's pushes to the windows, at most this often


def _cap(value: Any) -> float | None:
    found = money_value(value)
    return found if found is not None and found <= CAP_MAX else None


prefs.register_feature_pref(PREF_SESSION, 0.0, _cap)
prefs.register_feature_pref(PREF_PROJECT, 0.0, _cap)
prefs.register_feature_pref(PREF_DAY, 0.0, _cap)
prefs.register_feature_pref(PREF_ALERTS, True)

ZH = {
    "This Jarvis Code session has used {percent}% of its {cap} limit.": "这个 Jarvis Code 会话已用掉其 {cap} 上限的 {percent}%。",
    "This Jarvis Code session has reached its {cap} limit.": "这个 Jarvis Code 会话已达到 {cap} 的上限。",
    "{project} has used {percent}% of its {cap} limit for today.": "{project} 今天已用掉 {cap} 上限的 {percent}%。",
    "{project} has reached its {cap} limit for today.": "{project} 今天已达到 {cap} 的上限。",
    "Jarvis Code has used {percent}% of today's {cap} limit.": "Jarvis Code 今天已用掉 {cap} 上限的 {percent}%。",
    "Jarvis Code has reached today's {cap} limit.": "Jarvis Code 今天已达到 {cap} 的上限。",
    "You've used {percent}% of Claude's {window}.": "你已用掉 Claude {window}的 {percent}%。",
    "You've reached Claude's {window}.": "你已用完 Claude 的{window}。",
    "Jarvis Code spending": "Jarvis Code 花费",
    "Claude usage": "Claude 用量",
}
lang.add_texts(ZH)

# What a session's transcript says while a cap holds its messages (the window's Chinese is
# in web/i18n/code-platform.json).
HELD_SESSION = "On hold: this session has spent its {cap} limit. Raise it in Usage to go on."
HELD_PROJECT = (
    "On hold: {project} has spent its {cap} limit for today. Raise it in Usage, or it goes "
    "on tomorrow."
)
HELD_DAY = (
    "On hold: Jarvis Code has spent today's {cap} limit. Raise it in Usage, or it goes on tomorrow."
)
STOPPED_DAY = "Stopped: Jarvis Code has spent today's {cap} limit."
STOPPED_PROJECT = "Stopped: {project} has spent its {cap} limit for today."
CHANGED = "Spending limits changed; it goes on with the new ones."


class Meter:
    """One hub's usage meter."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._usage: Usage | None = None
        self._applied: dict[int, tuple] = {}  # task id -> the caps its connection was given
        self._emit_timer: asyncio.TimerHandle | None = None
        self._emitted = 0.0
        self._defaults_seen: Caps | None = None  # the defaults the last prefs event had

    @property
    def usage(self) -> Usage:
        """The counts, read at first use (never at install: tests make many hubs)."""
        if self._usage is None:
            self._usage = Usage(self.hub.feature_path("code_usage.json"))
        return self._usage

    # ── caps ──

    def defaults(self) -> Caps:
        feature = self.hub.prefs.feature
        return Caps(
            session=float(feature(PREF_SESSION) or 0.0),
            project=float(feature(PREF_PROJECT) or 0.0),
            day=float(feature(PREF_DAY) or 0.0),
        )

    @staticmethod
    def session_key(task: Any) -> str:
        return task.session_id or f"task:{task.id}"

    def project(self, task: Any) -> str:
        return project_of(self.hub, task)

    def caps(self, task: Any) -> Caps:
        return self.usage.caps_for(self.session_key(task), self.project(task), self.defaults())

    def left(self, task: Any) -> float | None:
        """What this session may still spend now: the least of what's left of its caps
        (None when no cap holds)."""
        caps = self.caps(task)
        room = []
        if caps.session > 0:
            room.append(caps.session - (task.cost_usd or 0.0))
        if caps.project > 0:
            room.append(caps.project - self.usage.project_today(self.project(task)))
        if caps.day > 0:
            room.append(caps.day - self.usage.today())
        return min(room) if room else None

    def gate(self, task: Any) -> str:
        """TaskManager.turn_gate: why this session's next message must wait, "" if it
        needn't."""
        if task.kind != "code":
            return ""
        caps = self.caps(task)
        if caps.session > 0 and (task.cost_usd or 0.0) >= caps.session - NEAR:
            return HELD_SESSION.format(cap=money(caps.session))
        if caps.day > 0 and self.usage.today() >= caps.day - NEAR:
            return HELD_DAY.format(cap=money(caps.day))
        project = self.project(task)
        if caps.project > 0 and self.usage.project_today(project) >= caps.project - NEAR:
            return HELD_PROJECT.format(project=Path(project).name, cap=money(caps.project))
        return ""

    def caps_changed(self) -> None:
        """A cap changed (or a day began): held sessions are looked at again, and an open
        session whose caps changed reopens with the new limit, between steps."""
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code":
                continue
            if task.gated:
                self.hub.tasks.release(task.id)
            applied = self._applied.get(task.id)
            if task.client is not None and applied is not None and applied != self.key(task):
                same = applied[:3] == self.key(task)[:3]  # (only the day changed)
                self.hub.tasks.reopen(task.id, "" if same else CHANGED)
        self.changed()

    def key(self, task: Any) -> tuple:
        """What of the caps only a new connection takes up: the caps, and the day while a
        day's cap holds (a new day has room again)."""
        caps = self.caps(task)
        day = self.usage.day() if caps.project > 0 or caps.day > 0 else ""
        return (caps.session, caps.project, caps.day, day)

    def apply(self, task: Any, options: Any) -> None:
        """TaskManager.option_hooks: what this connection may spend, so Claude Code stops
        there itself (it counts only what's spent since the connection opened). A cap
        another feature set (an unattended run's) holds too: the lower one."""
        if task.kind != "code":
            return
        self._applied[task.id] = self.key(task)
        left = self.left(task)
        if left is None:
            return
        left = round(max(left, 0.01), 4)
        other = options.max_budget_usd
        if isinstance(other, int | float) and not isinstance(other, bool) and other > 0:
            left = min(left, float(other))
        options.max_budget_usd = left

    # ── what it hears ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> Any:
        if kind == "task_log":
            entry = data.get("entry") or {}
            if entry.get("role") == "turn":
                task = self.hub.tasks.tasks.get(data.get("id"))
                if task is not None and task.kind == "code":
                    return self.on_turn(task, entry.get("cost") or 0.0)
        elif kind == "tasks":
            gone = set(self._applied) - set(self.hub.tasks.tasks)
            for task_id in gone:  # sessions let go of: nothing to remember for them
                self._applied.pop(task_id, None)
        return None

    def on_turn(self, task: Any, cost: Any) -> Any:
        """A turn's cost: counted today, marks it crossed said, and the other sessions
        stopped when it used up a cap they share. A coroutine when there are some to stop."""
        self._migrate_cap(task)
        cost = money_value(cost) or 0.0
        project = self.project(task)
        before_day, before_project = self.usage.add(project, cost)
        caps = self.caps(task)
        after = task.cost_usd or 0.0
        marks = [
            (crossed(before_day, before_day + cost, caps.day), 3, "day"),
            (crossed(before_project, before_project + cost, caps.project), 2, "project"),
            (crossed(max(0.0, after - cost), after, caps.session), 1, "session"),
        ]
        mark, _, scope = max(marks)
        if mark and self.hub.prefs.feature(PREF_ALERTS) is not False:
            self._alert(scope, mark, caps, project, task)
        stop: list[tuple[Any, str]] = []
        if caps.day > 0 and self.usage.today() >= caps.day - NEAR:
            note = STOPPED_DAY.format(cap=money(caps.day))
            stop += [(t, note) for t in self._busy(task)]
        if caps.project > 0 and self.usage.project_today(project) >= caps.project - NEAR:
            note = STOPPED_PROJECT.format(project=Path(project).name, cap=money(caps.project))
            stop += [(t, note) for t in self._busy(task) if self.project(t) == project]
        self.changed()
        return self._stop(stop) if stop else None

    def _busy(self, besides: Any) -> list[Any]:
        return [
            t
            for t in self.hub.tasks.tasks.values()
            if t.kind == "code" and t is not besides and t.busy and t.client is not None
        ]

    async def _stop(self, stop: list[tuple[Any, str]]) -> None:
        done: set[int] = set()
        for task, note in stop:
            if task.id in done:
                continue
            done.add(task.id)
            if await self.hub.tasks.interrupt(task.id):
                self.hub.tasks.add_entry(task.id, "system", note)

    def _migrate_cap(self, task: Any) -> None:
        """A cap set on a session before its first turn was kept by its number: once it
        has a Claude Code session id, the cap goes with that (across restarts)."""
        early = f"task:{task.id}"
        if task.session_id and early in self.usage.session_caps:
            cap = self.usage.session_caps.pop(early)
            if task.session_id not in self.usage.session_caps:
                self.usage.set_session_cap(task.session_id, cap)

    def _alert(self, scope: str, mark: int, caps: Caps, project: str, task: Any) -> None:
        language = self.hub.language
        if scope == "day":
            template = (
                "Jarvis Code has reached today's {cap} limit."
                if mark >= 100
                else "Jarvis Code has used {percent}% of today's {cap} limit."
            )
            text = lang.tr(template, language, cap=money(caps.day), percent=mark)
            key = f"code-budget:day:{self.usage.day()}:{mark}"
        elif scope == "project":
            template = (
                "{project} has reached its {cap} limit for today."
                if mark >= 100
                else "{project} has used {percent}% of its {cap} limit for today."
            )
            name = Path(project).name
            text = lang.tr(template, language, project=name, cap=money(caps.project), percent=mark)
            key = f"code-budget:project:{name}:{self.usage.day()}:{mark}"
        else:
            template = (
                "This Jarvis Code session has reached its {cap} limit."
                if mark >= 100
                else "This Jarvis Code session has used {percent}% of its {cap} limit."
            )
            text = lang.tr(template, language, cap=money(caps.session), percent=mark)
            key = f"code-budget:session:{task.id}:{mark}"
        title = lang.tr("Jarvis Code spending", language)
        self.hub.notify(Alert(key, "budget", title, text), speak_if_busy=False)

    def hear_rate_limit(self, info: Any) -> None:
        """A rate-limit report: the window it's about, and a heads-up when its use went
        past 50, 80 or 100%."""
        window, mark = self.usage.hear(info)
        if window is None:
            return
        if mark and self.hub.prefs.feature(PREF_ALERTS) is not False:
            zh = lang.is_zh(self.hub.language)
            label = (WINDOWS_ZH if zh else WINDOWS).get(window.kind, window.kind.replace("_", " "))
            template = (
                "You've reached Claude's {window}."
                if mark >= 100
                else "You've used {percent}% of Claude's {window}."
            )
            text = lang.tr(template, self.hub.language, window=label, percent=mark)
            key = f"code-budget:window:{window.kind}:{int(window.resets_at)}:{mark}"
            title = lang.tr("Claude usage", self.hub.language)
            self.hub.notify(Alert(key, "budget", title, text), speak_if_busy=False)
        self.changed()

    # ── the windows ──

    def changed(self) -> None:
        """The meter changed: the windows hear, at most every EMIT_EVERY seconds."""
        if self._emit_timer is not None:
            return  # a push is due: it carries this change too
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # (no loop: at once)
            self._emit()
            return
        wait = self._emitted + EMIT_EVERY - loop.time()
        if wait > 0:
            self._emit_timer = loop.call_later(wait, self._emit)
        else:
            self._emit()

    def _emit(self) -> None:
        if self._emit_timer is not None:
            self._emit_timer.cancel()
            self._emit_timer = None
        with contextlib.suppress(RuntimeError):
            self._emitted = asyncio.get_running_loop().time()
        self.hub.emit("cu_state", **self.public())

    def public(self) -> dict[str, Any]:
        usage = self.usage
        defaults = self.defaults()
        sessions: dict[str, Any] = {}
        projects: dict[str, Any] = {}
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code":
                continue
            caps = self.caps(task)
            project = self.project(task)
            sessions[str(task.id)] = {
                "cost": task.cost_usd or 0.0,
                "cap": caps.session,
                "own": self.session_key(task) in usage.session_caps,
                "held": task.gated,
                "project": project,
            }
            if project not in projects:
                projects[project] = {
                    "name": Path(project).name,
                    "today": usage.project_today(project),
                    "cap": caps.project,
                    "own": project in usage.project_caps,
                }
        return {
            "windows": usage.windows_public(),
            "today": usage.today(),
            "recent": usage.recent(14),
            "by_project": usage.projects_on()[:12],
            "sessions": sessions,
            "projects": projects,
            "defaults": {
                "session": defaults.session,
                "project": defaults.project,
                "day": defaults.day,
            },
            "alerts": self.hub.prefs.feature(PREF_ALERTS) is not False,
        }

    # ── window commands ──

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self._emit()

    def cmd_cap(self, msg: dict[str, Any]) -> None:
        """One session's or one project's own cap: a number (0: no cap), or null to go
        back to the default."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        raw = msg.get("cap")
        cap = None if raw is None else _cap(raw)
        if raw is not None and cap is None:
            self.hub.emit("error", text="A limit is an amount in dollars, like 5 or 12.50.")
            return
        if msg.get("scope") == "project":
            self.usage.set_project_cap(self.project(task), cap)
        else:
            self.usage.set_session_cap(self.session_key(task), cap)
        self.caps_changed()

    def on_prefs(self, _event: dict[str, Any]) -> None:
        """Settings changed: the defaults may be new."""
        defaults = self.defaults()
        if defaults != self._defaults_seen:
            self._defaults_seen = defaults
            self.caps_changed()

    async def forever(self) -> None:
        """At each midnight the day's caps start over: held sessions may go on."""
        while True:
            now = datetime.now()
            midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
            await asyncio.sleep(max(1.0, (midnight - now).total_seconds()))
            with contextlib.suppress(Exception):
                self.caps_changed()


class _Budget:
    """What a session's connection gets from the meter (TaskManager.option_hooks)."""

    def __init__(self, meter: Meter) -> None:
        self.meter = meter

    def apply(self, task: Any, options: Any) -> None:
        self.meter.apply(task, options)

    def key(self, task: Any) -> Any:
        return self.meter.key(task) if task.kind == "code" else None


def install(hub: Any) -> None:
    meter = Meter(hub)
    hub.code_usage = meter  # (for the other Jarvis Code features and the tests)
    hub.tasks.option_hooks.append(_Budget(meter))
    hub.tasks.turn_gate = meter.gate
    hub.add_task_sink(meter.on_task_event)
    previous = hub.tasks.on_rate_limit

    def hear(info: Any) -> None:
        if previous is not None:
            previous(info)  # JARVIS's fallback first: when Claude is back
        try:
            meter.hear_rate_limit(info)
        except Exception:
            log.exception("Jarvis Code usage: couldn't take in a rate-limit report")

    hub.tasks.on_rate_limit = hear
    hub.add_event_sink(["prefs"], meter.on_prefs)
    hub.register_command("cu_state", meter.cmd_state)
    hub.register_command("cu_cap", meter.cmd_cap)
    hub.register_loop("code_usage_midnight", meter.forever)
