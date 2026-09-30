"""Routines: requests the user schedules by voice. "Brief me every weekday at 7",
"check the BSH portfolio every Friday at 4", "at 1am, research X", "every 30 minutes
between 9 and 6, check the build", "on the last Friday of the month at 4, …".

Each routine is a prompt JARVIS runs as if the user had just asked it, on a schedule:
daily, weekdays, weekly on chosen days, or once; every N minutes within a window, monthly
(a day, the last day, or the Nth weekday) or a cron expression with a time zone
(schedules.py works those out). Anything a routine does still goes through the usual
confirmations. Stored in ~/Library/Application Support/Jarvis/routines.json: a routine of a
kind an older build doesn't know is kept in the file by it, untouched.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import jsonstore, schedules
from .prefs import APP_SUPPORT
from .textclean import clean_text

log = logging.getLogger("jarvis")

SERVER_NAME = "routines"
KINDS = ("daily", "weekdays", "weekly", "once", *schedules.KINDS)
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
    # interval, monthly and cron: the schedule itself (schedules.py); {} for the rest
    spec: dict[str, Any] = field(default_factory=dict)

    def describe(self, lang: str = "en") -> str:
        """When it runs, in words: English, or Chinese with lang "zh"."""
        if self.kind in schedules.KINDS:
            return schedules.describe(self.kind, self.spec, self.time, lang)
        if lang == "zh":
            return self._describe_zh()
        clock = datetime.strptime(self.time, "%H:%M").strftime("%-I:%M %p").replace(":00 ", " ")
        if self.kind == "daily":
            return f"every day at {clock}"
        if self.kind == "weekdays":
            return f"weekdays at {clock}"
        if self.kind == "weekly":
            names = [DAY_NAMES[d] + "s" for d in sorted(self.days)]
            return f"{', '.join(names) or 'weekly'} at {clock}"
        return f"once, {self.date} at {clock}"

    def _describe_zh(self) -> str:
        clock = schedules.clock(self.time, "zh")
        if self.kind == "daily":
            return f"每天{clock}"
        if self.kind == "weekdays":
            return f"工作日{clock}"
        if self.kind == "weekly":
            return f"{schedules.days_zh(sorted(self.days)) or '每周'}{clock}"
        return f"仅一次，{self.date} {clock}"

    def latest(self, now: datetime) -> datetime | None:
        """The most recent scheduled time at or before now."""
        if self.kind in schedules.KINDS:
            return schedules.latest(self.kind, self.spec, self.time, now)
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

    def next_run(self, now: datetime) -> datetime | None:
        """When it runs next (None: paused, or nothing ahead)."""
        if not self.enabled:
            return None
        if self.kind in schedules.KINDS:
            return schedules.next_after(self.kind, self.spec, self.time, now)
        hour, minute = map(int, self.time.split(":"))
        if self.kind == "once":
            when = _when(self.date)
            if when is None:
                return None
            when = when.replace(hour=hour, minute=minute)
            return when if when > now else None
        for ahead in range(8):
            day = (now + timedelta(days=ahead)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            if day <= now:
                continue
            if self.kind == "weekdays" and day.weekday() >= 5:
                continue
            if self.kind == "weekly" and day.weekday() not in self.days:
                continue
            return day
        return None

    def public(self) -> dict[str, Any]:
        try:
            upcoming = self.next_run(datetime.now())
        except (TypeError, ValueError, KeyError):  # edited after it was loaded
            upcoming = None
        return {
            **asdict(self),
            "when": self.describe(),
            "when_zh": self.describe("zh"),
            "next_run": upcoming.isoformat(timespec="minutes") if upcoming else "",
        }


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
    if kind in (schedules.INTERVAL, schedules.CRON):  # the spec says when; no time of day
        return kind, "00:00", [], ""
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


def clean_spec(kind: str, spec: Any) -> dict[str, Any]:
    """The schedule's details for interval, monthly and cron ({} for the other kinds)."""
    return schedules.clean(kind, spec) if kind in schedules.KINDS else {}


def spec_from(kind: str, args: dict[str, Any]) -> dict[str, Any]:
    """create_routine's arguments as a schedule spec."""
    if kind == schedules.INTERVAL:
        return {
            "every": args.get("every_minutes"),
            "start": args.get("from_time") or "",
            "end": args.get("until_time") or "",
            "days": args.get("days"),
        }
    if kind == schedules.MONTHLY:
        return {
            k: args.get(a)
            for k, a in (("day", "month_day"), ("nth", "nth"), ("weekday", "weekday"))
        }
    if kind == schedules.CRON:
        return {"cron": args.get("cron"), "tz": args.get("timezone")}
    return {}


_FIELDS = frozenset(f.name for f in fields(Routine))


def _when(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _routine_from(raw: Any) -> Routine | None:
    """A routine from the file that can be shown and scheduled, tidied as add() tidies
    them; None for one that can't (another build's time format, a name that isn't text)."""
    try:
        routine = Routine(**{k: v for k, v in raw.items() if k in _FIELDS})
    except (AttributeError, TypeError):  # not an object, or a field it needs is missing
        return None
    text = (routine.id, routine.name, routine.prompt, routine.kind, routine.time)
    if not all(isinstance(v, str) for v in (*text, routine.date, routine.last_run)):
        return None
    routine.name = clean_text(routine.name).strip()[:80]
    routine.prompt = clean_text(routine.prompt).strip()[:2000]
    if not (routine.id and routine.name and routine.prompt) or routine.kind not in KINDS:
        return None
    if not _TIME.fullmatch(routine.time):
        return None
    days = routine.days
    if not isinstance(days, list) or not all(type(d) is int and 0 <= d <= 6 for d in days):
        return None
    if routine.kind == "once":
        day = _when(routine.date)
        if day is None or day.tzinfo is not None:
            return None
    try:  # a schedule's details, cleaned as add() cleans them; one that can't be: kept aside
        routine.spec = clean_spec(routine.kind, routine.spec)
    except (ValueError, TypeError, KeyError, AttributeError):
        return None
    if routine.last_run:
        ran = _when(routine.last_run)
        if ran is None:
            return None
        if ran.tzinfo is not None:  # another build's zoned time: this Mac's clock, like the rest
            routine.last_run = ran.astimezone().replace(tzinfo=None).isoformat(timespec="minutes")
    routine.enabled = routine.enabled is True  # "false", 0, null: paused, never run by surprise
    return routine


class RoutineStore:
    """The routines file. One that can't be read is kept aside for the owner and its last
    good copy used; a single routine that can't be scheduled is left out (never shown or
    run) and written back as it was, so nothing another build made is lost."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "routines.json"
        self.items: list[Routine] = []
        self.broken: list[Any] = []  # rows it can't use, kept in the file as they were
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self.save_error = ""  # why the last save failed, until one works (a full disk)
        # The language cards are asked in ("en" or "zh"): the automation feature sets it.
        self.language: Callable[[], str] = lambda: "en"
        try:
            data = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("routines: %s can't be read (%s); leaving it be", self.path.name, exc)
            data = None
        for raw in data or []:
            routine = _routine_from(raw)
            if routine is not None:
                self.items.append(routine)
            elif jsonstore.shallow(raw):
                self.broken.append(raw)
        if self.broken:
            log.warning("routines: %d can't be scheduled; kept in the file", len(self.broken))

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(r) for r in self.items] + self.broken)
        self.save_error = ""

    def add(
        self, name: str, prompt: str, kind: str, time: str, days=None, date="", spec=None
    ) -> Routine:
        name, prompt = clean_text(name).strip()[:80], clean_text(prompt).strip()[:2000]
        if not name or not prompt:
            raise ValueError("a routine needs a name and what to do")
        kind, time, days, date = validate(kind, time, days, date)
        spec = clean_spec(kind, spec)
        routine = Routine(uuid.uuid4().hex[:8], name, prompt, kind, time, days, date, spec=spec)
        # Created after today's time has passed: don't run it right away.
        latest = routine.latest(datetime.now())
        if latest is not None and kind != "once":
            routine.last_run = latest.isoformat(timespec="minutes")
        self.items.append(routine)
        try:
            self.save()
        except OSError:  # not on disk, so not added: what's listed is what's kept
            self.items.remove(routine)
            raise
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
            before = list(self.items)
            self.items.remove(routine)
            try:
                self.save()
            except OSError:
                self.items = before
                raise
        return routine

    def set_enabled(self, key: str, on: bool) -> Routine | None:
        routine = self.find(key)
        if routine is not None:
            was, routine.enabled = routine.enabled, bool(on)
            try:
                self.save()
            except OSError:
                routine.enabled = was
                raise
        return routine

    def take_due(self, now: datetime) -> list[Routine]:
        """Routines due now, marked as run (a once-routine switches itself off). One that
        can't be scheduled never stops the rest, and a save that fails (a full disk) never
        stops them running: they're marked as run in memory, save_error says why, and the
        save is tried again at every check until it works."""
        due = []
        for routine in self.items:
            try:
                when = routine.due(now)
            except (TypeError, ValueError, AttributeError):  # edited after it was loaded
                log.warning("routines: one can't be scheduled")
                continue
            if when is None:
                continue
            routine.last_run = when.isoformat(timespec="minutes")
            if routine.kind == "once":
                routine.enabled = False
            due.append(routine)
        if due or self.save_error:
            try:
                self.save()
            except OSError as exc:
                if not self.save_error:
                    log.warning("routines: couldn't save (%s)", exc)
                self.save_error = exc.strerror or str(exc) or "the disk may be full"
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


def _language(store: RoutineStore) -> str:
    try:
        return "zh" if str(store.language()).startswith("zh") else "en"
    except Exception:
        return "en"


def _add_question(preview: Routine, what: str, lang: str) -> str:
    """The card that adds a routine: when it runs and exactly what it will ask."""
    if lang == "zh":
        return f"要添加例行任务吗？{preview.describe('zh')}：{what}"
    return f"Add a routine, {preview.describe()}: {what}?"


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
        "X', 'every 30 minutes from 9 to 6, check the build', 'on the last Friday of each "
        "month at 4, …'. prompt is the request exactly as JARVIS should run it then, written "
        "as the user asking (e.g. 'Research the European battery market and file a report'). "
        "schedule: daily, weekdays, weekly (with days, 0 = Monday … 6 = Sunday) or once "
        "(with date YYYY-MM-DD), each at time (24-hour HH:MM, local); interval: every "
        "every_minutes (5 to 1440), optionally only from from_time until until_time (HH:MM) "
        "and on days; monthly at time: month_day (1-31, or -1 for the last day) or nth (1-5, "
        "or -1 for the last) with weekday (0 = Monday); cron: a five-field cron expression "
        "(minute hour day-of-month month day-of-week), optionally in timezone (an IANA name "
        "such as America/New_York). Asks the user first.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "prompt": {"type": "string"},
                "schedule": {"type": "string", "enum": list(KINDS)},
                "time": {"type": "string"},
                "days": {"type": "array", "items": {"type": "integer"}},
                "date": {"type": "string"},
                "every_minutes": {"type": "integer"},
                "from_time": {"type": "string"},
                "until_time": {"type": "string"},
                "month_day": {"type": "integer"},
                "nth": {"type": "integer"},
                "weekday": {"type": "integer"},
                "cron": {"type": "string"},
                "timezone": {"type": "string"},
            },
            "required": ["name", "prompt", "schedule"],
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
            spec = clean_spec(kind, spec_from(kind, args))
        except ValueError as exc:
            return _text(str(exc), error=True)
        preview = Routine("", str(args.get("name", "")), "", kind, time, days, date, spec=spec)
        # The card shows the prompt exactly as it will be kept and run, hidden text and all
        # taken out, and when it runs in the language the user speaks.
        what = clean_text(args.get("prompt", "")).strip()[:2000].rstrip("?.! ")
        if not await confirm(_add_question(preview, what, _language(store))):
            return _text("The user said no. Don't add it.", error=True)
        try:
            routine = store.add(args["name"], args["prompt"], kind, time, days, date, spec)
        except ValueError as exc:
            return _text(str(exc), error=True)
        except OSError as exc:
            return _text(f"I couldn't save the routine ({exc.strerror or exc}).", error=True)
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
