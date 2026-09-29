"""Routines: requests the user schedules by voice. "Brief me every weekday at 7",
"check the BSH portfolio every Friday at 4", "at 1am, research X".

Each routine is a prompt JARVIS runs as if the user had just asked it, on a schedule:
daily, weekdays, weekly on chosen days, or once. Anything a routine does still goes
through the usual confirmations. Stored in ~/Library/Application Support/Jarvis/routines.json.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .prefs import APP_SUPPORT

SERVER_NAME = "routines"
KINDS = ("daily", "weekdays", "weekly", "once")
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
GRACE = timedelta(hours=3)  # a Mac asleep at 7:00 still runs the 7:00 routine at 8:30
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


@dataclass
class Routine:
    id: str
    name: str
    prompt: str
    kind: str
    time: str
    days: list[int] = field(default_factory=list)  # weekly: 0 = Monday
    date: str = ""  # once: YYYY-MM-DD
    enabled: bool = True
    last_run: str = ""  # the scheduled occurrence last run, ISO

    def describe(self) -> str:
        clock = datetime.strptime(self.time, "%H:%M").strftime("%-I:%M %p").replace(":00 ", " ")
        if self.kind == "daily":
            return f"every day at {clock}"
        if self.kind == "weekdays":
            return f"weekdays at {clock}"
        if self.kind == "weekly":
            names = [DAY_NAMES[d] + "s" for d in sorted(self.days)]
            return f"{', '.join(names) or 'weekly'} at {clock}"
        return f"once, {self.date} at {clock}"

    def latest(self, now: datetime) -> datetime | None:
        """The most recent scheduled time at or before now."""
        hour, minute = map(int, self.time.split(":"))
        if self.kind == "once":
            try:
                when = datetime.fromisoformat(self.date).replace(hour=hour, minute=minute)
            except ValueError:
                return None
            return when if when <= now else None
        for back in range(8):
            day = (now - timedelta(days=back)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            if day > now:
                continue
            if self.kind == "weekdays" and day.weekday() >= 5:
                continue
            if self.kind == "weekly" and day.weekday() not in self.days:
                continue
            return day
        return None

    def due(self, now: datetime) -> datetime | None:
        if not self.enabled:
            return None
        when = self.latest(now)
        if when is None or now - when > GRACE:
            return None
        if self.last_run and datetime.fromisoformat(self.last_run) >= when:
            return None
        return when

    def public(self) -> dict[str, Any]:
        return {**asdict(self), "when": self.describe()}


def validate(
    kind: str,
    time: str,
    days: list[Any] | None = None,
    date: str = "",
    now: datetime | None = None,
) -> tuple[str, str, list[int], str]:
    kind = str(kind).strip().lower()
    if kind not in KINDS:
        raise ValueError(f"schedule must be one of {', '.join(KINDS)}")
    time = str(time).strip()
    if len(time) == 4 and time[1] == ":":
        time = "0" + time
    if not _TIME.match(time):
        raise ValueError("time must be 24-hour HH:MM")
    clean_days = sorted({int(d) for d in (days or []) if str(d).lstrip("-").isdigit()})
    if kind == "weekly" and (not clean_days or any(d < 0 or d > 6 for d in clean_days)):
        raise ValueError("weekly routines need days, 0 = Monday … 6 = Sunday")
    if kind == "once":
        try:
            day = datetime.fromisoformat(str(date))
        except ValueError:
            raise ValueError("once needs a date, YYYY-MM-DD") from None
        hour, minute = map(int, time.split(":"))
        if day.replace(hour=hour, minute=minute) <= (now or datetime.now()):
            # e.g. "tonight at 1am" said at 23:30 but dated today: it would never run.
            raise ValueError("that time has already passed; use the next date it happens")
    return kind, time, clean_days if kind == "weekly" else [], str(date) if kind == "once" else ""


class RoutineStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "routines.json"
        self.items: list[Routine] = []
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            data = []
        for raw in data if isinstance(data, list) else []:
            try:
                self.items.append(Routine(**raw))
            except TypeError:
                continue

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(r) for r in self.items], indent=2))
        tmp.replace(self.path)

    def add(self, name: str, prompt: str, kind: str, time: str, days=None, date="") -> Routine:
        name, prompt = str(name).strip()[:80], str(prompt).strip()[:2000]
        if not name or not prompt:
            raise ValueError("a routine needs a name and what to do")
        kind, time, days, date = validate(kind, time, days, date)
        routine = Routine(uuid.uuid4().hex[:8], name, prompt, kind, time, days, date)
        # Created after today's time has passed: don't run it right away.
        latest = routine.latest(datetime.now())
        if latest is not None and kind != "once":
            routine.last_run = latest.isoformat(timespec="minutes")
        self.items.append(routine)
        self.save()
        return routine

    def find(self, key: str) -> Routine | None:
        key = str(key).strip().lower()
        return next(
            (r for r in self.items if r.id == key or r.name.lower() == key),
            None,
        ) or next((r for r in self.items if key and key in r.name.lower()), None)

    def remove(self, key: str) -> Routine | None:
        routine = self.find(key)
        if routine is not None:
            self.items.remove(routine)
            self.save()
        return routine

    def set_enabled(self, key: str, on: bool) -> Routine | None:
        routine = self.find(key)
        if routine is not None:
            routine.enabled = bool(on)
            self.save()
        return routine

    def take_due(self, now: datetime) -> list[Routine]:
        """Routines due now, marked as run (a once-routine switches itself off)."""
        due = []
        for routine in self.items:
            when = routine.due(now)
            if when is None:
                continue
            routine.last_run = when.isoformat(timespec="minutes")
            if routine.kind == "once":
                routine.enabled = False
            due.append(routine)
        if due:
            self.save()
        return due

    def public(self) -> list[dict[str, Any]]:
        return [r.public() for r in self.items]


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


async def _always(_action: str, _question: str) -> bool:
    return True


def build_tools(
    store: RoutineStore,
    confirm: Callable[[str], Awaitable[bool]],
    on_change: Callable[[], None] = lambda: None,
    gate: Callable[[str, str], Awaitable[bool]] = _always,
) -> list:
    @tool(
        "create_routine",
        "Schedule something for JARVIS to do on its own, repeatedly or once: 'brief me every "
        "weekday at 7', 'check the portfolio every Friday at 4pm', 'tonight at 1am, research "
        "X'. prompt is the request exactly as JARVIS should run it then, written as the user "
        "asking (e.g. 'Research the European battery market and file a report'). schedule: "
        "daily, weekdays, weekly (with days, 0 = Monday … 6 = Sunday) or once (with date "
        "YYYY-MM-DD). time is 24-hour HH:MM, local. Asks the user first.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "prompt": {"type": "string"},
                "schedule": {"type": "string", "enum": list(KINDS)},
                "time": {"type": "string"},
                "days": {"type": "array", "items": {"type": "integer"}},
                "date": {"type": "string"},
            },
            "required": ["name", "prompt", "schedule", "time"],
        },
    )
    async def create_routine(args):
        try:
            kind, time, days, date = validate(
                args.get("schedule", ""),
                args.get("time", ""),
                args.get("days"),
                args.get("date", ""),
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        preview = Routine("", str(args.get("name", "")), "", kind, time, days, date)
        what = str(args.get("prompt", "")).strip().rstrip("?.! ")
        if not await confirm(f"Add a routine, {preview.describe()}: {what}?"):
            return _text("The user said no. Don't add it.", error=True)
        try:
            routine = store.add(args["name"], args["prompt"], kind, time, days, date)
        except ValueError as exc:
            return _text(str(exc), error=True)
        on_change()
        return _text(f"Added “{routine.name}”, {routine.describe()}.")

    @tool("list_routines", "List the user's scheduled routines.", {})
    async def list_routines(_args):
        if not store.items:
            return _text("No routines yet.")
        return _text(
            "\n".join(
                f"[{r.id}] {r.name}: {r.describe()}{'' if r.enabled else ' (paused)'}: {r.prompt}"
                for r in store.items
            )
        )

    @tool(
        "delete_routine",
        "Delete a routine by id or name.",
        {"routine": str},
    )
    async def delete_routine(args):
        found = store.find(str(args.get("routine", "")))
        if found is None:
            return _text("No routine like that.", error=True)
        if not await gate("delete_routine", f"Delete the routine “{found.name}”?"):
            return _text("The user said no.", error=True)
        routine = store.remove(found.id)
        if routine is None:
            return _text("No routine like that.", error=True)
        on_change()
        return _text(f"Deleted “{routine.name}”.")

    @tool(
        "pause_routine",
        "Pause (enabled false) or resume (enabled true) a routine by id or name.",
        {"routine": str, "enabled": bool},
    )
    async def pause_routine(args):
        found = store.find(str(args.get("routine", "")))
        on = bool(args.get("enabled"))
        if found is None:
            return _text("No routine like that.", error=True)
        verb = "Resume" if on else "Pause"
        if not await gate("pause_routine", f"{verb} the routine “{found.name}”?"):
            return _text("The user said no.", error=True)
        routine = store.set_enabled(found.id, on)
        if routine is None:
            return _text("No routine like that.", error=True)
        on_change()
        return _text(f"“{routine.name}” is {'on' if routine.enabled else 'paused'}.")

    return [create_routine, list_routines, delete_routine, pause_routine]


def build_server(store, confirm, on_change=lambda: None, gate=_always):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=build_tools(store, confirm, on_change, gate)
    )
