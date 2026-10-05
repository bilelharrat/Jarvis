"""Richer schedules for routines: every N minutes or hours (within a time window, on chosen
days), monthly (a day of the month, its last day, or its Nth weekday), and cron
expressions with a time zone.

Plain functions of a spec and a clock, so they're tested with fixed times. Times are this
Mac's wall clock, naive, like the routines' own: a cron schedule in another time zone is
worked out there and turned into this Mac's time. Each kind answers the same two
questions the routine clock asks: the latest time it was due at or before now, and the
next time after now (for Settings and the phone).
"""

from __future__ import annotations

import calendar
import functools
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, tzinfo
from datetime import time as clock_time
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

INTERVAL, MONTHLY, CRON = "interval", "monthly", "cron"
KINDS = (INTERVAL, MONTHLY, CRON)
MIN_EVERY = 5  # minutes: a routine more often than this is a loop, not a routine
MAX_EVERY = 24 * 60
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DAY_NAMES_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
ORDINALS = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", -1: "last"}
ORDINALS_ZH = {1: "第一个", 2: "第二个", 3: "第三个", 4: "第四个", 5: "第五个", -1: "最后一个"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
LOOK_BACK_DAYS = 400  # a cron schedule's latest time is looked for this far back, at most
LOOK_AHEAD_DAYS = 5 * 366  # and its next one this far ahead (a 29 February one, say)


# ── times ──


def clean_time(value: Any, what: str = "time") -> str:
    """HH:MM, 24-hour ("7:05" is taken as 07:05); ValueError otherwise."""
    text = str(value if value is not None else "").strip()
    if len(text) == 4 and text[1] == ":":
        text = "0" + text
    if not _HHMM.match(text):
        raise ValueError(f"{what} must be 24-hour HH:MM")
    return text


def _hm(text: str) -> tuple[int, int]:
    hour, minute = text.split(":")
    return int(hour), int(minute)


def clock_en(hour: int, minute: int) -> str:
    """9 AM, 9:30 PM: how the routines say a time."""
    return datetime(2000, 1, 1, hour, minute).strftime("%-I:%M %p").replace(":00 ", " ")


def clock_zh(hour: int, minute: int) -> str:
    """上午9点, 晚上9:30."""
    from .lang import clock_zh as zh

    return zh(hour % 12 or 12, minute, "PM" if hour >= 12 else "AM", spoken=False)


def clock(text: str, lang: str = "en") -> str:
    hour, minute = _hm(text)
    return clock_zh(hour, minute) if lang == "zh" else clock_en(hour, minute)


def _days(value: Any) -> list[int]:
    if value in (None, "", []):
        return []
    if not isinstance(value, list):
        raise ValueError("days must be a list, 0 = Monday … 6 = Sunday")
    days = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int | str):
            raise ValueError("days must be numbers, 0 = Monday … 6 = Sunday")
        text = str(item).strip()
        if not text.lstrip("-").isdigit() or not 0 <= int(text) <= 6:
            raise ValueError("days must be 0 = Monday … 6 = Sunday")
        days.add(int(text))
    return sorted(days) if len(days) < 7 else []


def days_en(days: list[int]) -> str:
    """weekdays, weekends, Mondays and Fridays ("" for every day)."""
    if not days or len(days) == 7:
        return ""
    if days == [0, 1, 2, 3, 4]:
        return "weekdays"
    if days == [5, 6]:
        return "weekends"
    names = [DAY_NAMES[d] + "s" for d in days]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def days_zh(days: list[int]) -> str:
    if not days or len(days) == 7:
        return ""
    if days == [0, 1, 2, 3, 4]:
        return "工作日"
    if days == [5, 6]:
        return "周末"
    return "每" + "、".join(DAY_NAMES_ZH[d] for d in days)


def _int(value: Any, what: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{what} must be a whole number")
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a whole number") from None
    return number


# ── every N minutes, within a window ──


def clean_interval(spec: Any) -> dict[str, Any]:
    """{"every": minutes, "start": "HH:MM", "end": "HH:MM" or "", "days": [0-6]}: every
    `every` minutes from `start` (midnight when not given) until `end` (through the day when
    not given; an end at or before the start runs past midnight), on those days (every day
    when not given). ValueError says what's wrong."""
    if not isinstance(spec, dict):
        raise ValueError("an interval needs every (minutes)")
    every = _int(spec.get("every"), "every")
    if not MIN_EVERY <= every <= MAX_EVERY:
        raise ValueError(f"every must be {MIN_EVERY} to {MAX_EVERY} minutes")
    start = clean_time(spec.get("start") or "00:00", "the window's start")
    end = spec.get("end") or ""
    if end:
        end = clean_time(end, "the window's end")
        if end == start:
            end = ""
    return {"every": every, "start": start, "end": end, "days": _days(spec.get("days"))}


def _window(day: date, spec: dict[str, Any]) -> tuple[datetime, datetime]:
    start = datetime.combine(day, clock_time(*_hm(spec["start"])))
    if spec["end"]:
        end = datetime.combine(day, clock_time(*_hm(spec["end"])))
        if end <= start:
            end += timedelta(days=1)  # 22:00 to 02:00: past midnight
    else:
        end = datetime.combine(day, clock_time(23, 59))
    return start, end


def _interval_latest(spec: dict[str, Any], now: datetime) -> datetime | None:
    every = timedelta(minutes=spec["every"])
    days = set(spec["days"] or range(7))
    for back in range(9):
        day = now.date() - timedelta(days=back)
        if day.weekday() not in days:
            continue
        start, end = _window(day, spec)
        if start > now:
            continue
        upto = min(now, end)
        return start + ((upto - start) // every) * every
    return None


def _interval_next(spec: dict[str, Any], now: datetime) -> datetime | None:
    every = timedelta(minutes=spec["every"])
    days = set(spec["days"] or range(7))
    for ahead in range(-1, 9):  # yesterday's window may still run past midnight
        day = now.date() + timedelta(days=ahead)
        if day.weekday() not in days:
            continue
        start, end = _window(day, spec)
        if end <= now:
            continue
        if now < start:
            return start
        when = start + ((now - start) // every + 1) * every
        if when <= end:
            return when
    return None


def _every_en(minutes: int) -> str:
    if minutes % 60 == 0:
        hours = minutes // 60
        return "every hour" if hours == 1 else f"every {hours} hours"
    return f"every {minutes} minutes"


def _every_zh(minutes: int) -> str:
    if minutes % 60 == 0:
        hours = minutes // 60
        return "每小时" if hours == 1 else f"每{hours}小时"
    return f"每{minutes}分钟"


def _describe_interval(spec: dict[str, Any], lang: str) -> str:
    windowed = spec["start"] != "00:00" or spec["end"]
    if lang == "zh":
        text = _every_zh(spec["every"])
        if windowed:
            end = clock(spec["end"], "zh") if spec["end"] else "午夜"
            text = f"{clock(spec['start'], 'zh')}到{end}之间{text}"
        days = days_zh(spec["days"])
        return f"{days}{text}" if days else text
    text = _every_en(spec["every"])
    if windowed:
        end = clock(spec["end"]) if spec["end"] else "midnight"
        text += f", {clock(spec['start'])} to {end}"
    days = days_en(spec["days"])
    return f"{text}, {days}" if days else text


# ── monthly ──


def clean_monthly(spec: Any) -> dict[str, Any]:
    """{"day": 1-31 or -1 (the last day)} or {"nth": 1-5 or -1 (the last), "weekday": 0-6}.
    A day past a short month's end is its last day (the 31st in April is the 30th)."""
    if not isinstance(spec, dict):
        raise ValueError("monthly needs a day of the month, or nth and weekday")
    if spec.get("day") not in (None, ""):
        day = _int(spec["day"], "the day of the month")
        if not (1 <= day <= 31 or day == -1):
            raise ValueError("the day of the month must be 1 to 31, or -1 for the last day")
        return {"day": day}
    if spec.get("weekday") in (None, "") or spec.get("nth") in (None, ""):
        raise ValueError("monthly needs a day of the month (1-31, -1 last), or nth and weekday")
    nth = _int(spec["nth"], "nth")
    weekday = _int(spec["weekday"], "the weekday")
    if not (1 <= nth <= 5 or nth == -1):
        raise ValueError("nth must be 1 to 5, or -1 for the last one")
    if not 0 <= weekday <= 6:
        raise ValueError("the weekday must be 0 = Monday … 6 = Sunday")
    return {"nth": nth, "weekday": weekday}


def _month_day(year: int, month: int, spec: dict[str, Any]) -> int | None:
    last = calendar.monthrange(year, month)[1]
    if "day" in spec:
        return last if spec["day"] == -1 else min(spec["day"], last)
    weekday, nth = spec["weekday"], spec["nth"]
    if nth == -1:
        return last - ((date(year, month, last).weekday() - weekday) % 7)
    day = (weekday - date(year, month, 1).weekday()) % 7 + 1 + (nth - 1) * 7
    return day if day <= last else None  # no fifth Friday this month


def _month_step(year: int, month: int, step: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + step
    return index // 12, index % 12 + 1


def _monthly_at(year: int, month: int, spec: dict[str, Any], at: str) -> datetime | None:
    day = _month_day(year, month, spec)
    if day is None:
        return None
    return datetime(year, month, day, *_hm(at))


def _monthly_latest(spec: dict[str, Any], at: str, now: datetime) -> datetime | None:
    for back in range(15):
        year, month = _month_step(now.year, now.month, -back)
        when = _monthly_at(year, month, spec, at)
        if when is not None and when <= now:
            return when
    return None


def _monthly_next(spec: dict[str, Any], at: str, now: datetime) -> datetime | None:
    for ahead in range(15):
        year, month = _month_step(now.year, now.month, ahead)
        when = _monthly_at(year, month, spec, at)
        if when is not None and when > now:
            return when
    return None


def _ordinal_en(day: int) -> str:
    suffix = "th" if 10 <= day % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day}{suffix}"


def _describe_monthly(spec: dict[str, Any], at: str, lang: str) -> str:
    if lang == "zh":
        if "day" in spec:
            which = "最后一天" if spec["day"] == -1 else f"{spec['day']}日"
        else:
            which = ORDINALS_ZH[spec["nth"]] + DAY_NAMES_ZH[spec["weekday"]]
        return f"每月{which}{clock(at, 'zh')}"
    if "day" in spec:
        which = "the last day" if spec["day"] == -1 else f"the {_ordinal_en(spec['day'])}"
    else:
        which = f"the {ORDINALS[spec['nth']]} {DAY_NAMES[spec['weekday']]}"
    return f"monthly on {which} at {clock(at)}"


# ── cron ──

_MONTH_NAMES = {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}
_DOW_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
_MACROS = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}
_FIELD = re.compile(r"^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:/(\d{1,3}))?$")


@dataclass(frozen=True)
class Cron:
    """A parsed cron expression: minute, hour, day of month, month, day of week (0 or 7 =
    Sunday). As in cron itself, when neither day field starts with * a day matching either
    one counts; otherwise it must match both."""

    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    doms: frozenset[int]
    months: frozenset[int]
    dows: frozenset[int]
    dom_star: bool
    dow_star: bool

    def day_matches(self, day: date) -> bool:
        if day.month not in self.months:
            return False
        dom = day.day in self.doms
        dow = (day.weekday() + 1) % 7 in self.dows
        if self.dom_star or self.dow_star:
            return dom and dow
        return dom or dow

    @property
    def any_day_of_month(self) -> bool:
        return len(self.doms) == 31

    @property
    def any_weekday(self) -> bool:
        return len(self.dows) == 7


def _value(text: str, lo: int, hi: int, names: dict[str, int] | None, what: str) -> int:
    if names and text in names:
        return names[text]
    if not text.isdigit():
        raise ValueError(f"cron: “{text}” isn't a {what}")
    number = int(text)
    if not lo <= number <= hi:
        raise ValueError(f"cron: {what} must be {lo} to {hi}")
    return number


def _cron_field(
    text: str, lo: int, hi: int, what: str, names: dict[str, int] | None = None
) -> tuple[set[int], bool]:
    """The values one field allows, and whether it starts with * (cron's day rule)."""
    found: set[int] = set()
    for part in text.split(","):
        match = _FIELD.match(part)
        if not match:
            raise ValueError(f"cron: can't read “{part}” in the {what} field")
        body, step_text = match.groups()
        step = int(step_text) if step_text else 1
        if step < 1:
            raise ValueError("cron: a step must be at least 1")
        if body == "*":
            first, last = lo, hi
        elif "-" in body:
            a, b = body.split("-")
            first, last = _value(a, lo, hi, names, what), _value(b, lo, hi, names, what)
            if first > last:
                raise ValueError(f"cron: the {what} range {body} runs backwards")
        else:
            first = _value(body, lo, hi, names, what)
            last = hi if step_text else first  # "5/15": from 5, every 15
        found.update(range(first, last + 1, step))
    return found, text.startswith("*")


def parse_cron(text: Any) -> Cron:
    """A five-field cron expression (or @daily, @hourly…); ValueError says what's wrong."""
    return _parse_cron(" ".join(str(text or "").lower().split()))


@functools.lru_cache(maxsize=64)
def _parse_cron(raw: str) -> Cron:
    """parse_cron, once for each expression (a Cron can't be changed): the routine clock
    reads every cron routine's schedule each half minute. One that's wrong isn't kept, so
    it says why each time."""
    raw = _MACROS.get(raw, raw)
    fields = raw.split(" ")
    if len(fields) != 5 or not all(fields):
        raise ValueError(
            "cron needs five fields: minute hour day-of-month month day-of-week (e.g. 0 9 * * 1-5)"
        )
    minutes, _ = _cron_field(fields[0], 0, 59, "minute")
    hours, _ = _cron_field(fields[1], 0, 23, "hour")
    doms, dom_star = _cron_field(fields[2], 1, 31, "day of the month")
    months, _ = _cron_field(fields[3], 1, 12, "month", _MONTH_NAMES)
    dows, dow_star = _cron_field(fields[4], 0, 7, "day of the week", _DOW_NAMES)
    dows = {0 if d == 7 else d for d in dows}
    cron = Cron(
        tuple(sorted(minutes)),
        tuple(sorted(hours)),
        frozenset(doms),
        frozenset(months),
        frozenset(dows),
        dom_star,
        dow_star,
    )
    if not any(cron.day_matches(date(2028, 1, 1) + timedelta(days=n)) for n in range(366)):
        raise ValueError("cron: that day and month never happen together")
    return cron


def clean_zone(value: Any) -> str:
    """An IANA time zone name ("" is this Mac's own)."""
    name = str(value or "").strip()
    if not name:
        return ""
    if len(name) > 64 or not re.fullmatch(r"[A-Za-z0-9_+\-/]+", name):
        raise ValueError("the time zone must be a name like America/New_York")
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"there's no time zone called {name}") from None
    return name


def clean_cron(spec: Any) -> dict[str, Any]:
    """{"cron": "0 9 * * 1-5", "tz": "America/New_York" or ""}."""
    if not isinstance(spec, dict):
        raise ValueError("a cron schedule needs its expression")
    expression = " ".join(str(spec.get("cron") or "").split())
    if len(expression) > 120:
        raise ValueError("that cron expression is too long")
    parse_cron(expression)
    return {"cron": expression, "tz": clean_zone(spec.get("tz"))}


def _zone(spec: dict[str, Any]) -> tzinfo | None:
    return ZoneInfo(spec["tz"]) if spec.get("tz") else None


def _there(now: datetime, zone: tzinfo | None, local: tzinfo | None) -> datetime:
    """This Mac's naive now, as a wall-clock time in the schedule's zone (naive)."""
    if zone is None:
        return now
    aware = now.replace(tzinfo=local) if local is not None else now.astimezone()
    return aware.astimezone(zone).replace(tzinfo=None)


def _here(when: datetime, zone: tzinfo | None, local: tzinfo | None) -> datetime:
    """A wall-clock time in the schedule's zone, as this Mac's naive time."""
    if zone is None:
        return when
    aware = when.replace(tzinfo=zone)
    return (aware.astimezone(local) if local is not None else aware.astimezone()).replace(
        tzinfo=None
    )


def _cron_latest(
    spec: dict[str, Any],
    now: datetime,
    local: tzinfo | None = None,
    since: datetime | None = None,
) -> datetime | None:
    cron, zone = parse_cron(spec["cron"]), _zone(spec)
    there = _there(now, zone, local).replace(second=0, microsecond=0)
    days = LOOK_BACK_DAYS
    if since is not None:
        # Nothing on a day before the one since falls on (in the schedule's zone, with a
        # day to spare for a clock change) comes from since on: no need to look there.
        first = _there(since, zone, local).date() - timedelta(days=1)
        days = min(days, max(0, (there.date() - first).days + 1))
    for back in range(days):
        day = there.date() - timedelta(days=back)
        if not cron.day_matches(day):
            continue
        for hour in reversed(cron.hours):
            if back == 0 and hour > there.hour:
                continue
            for minute in reversed(cron.minutes):
                if back == 0 and hour == there.hour and minute > there.minute:
                    continue
                return _here(datetime(day.year, day.month, day.day, hour, minute), zone, local)
    return None


def _cron_next(spec: dict[str, Any], now: datetime, local: tzinfo | None = None) -> datetime | None:
    cron, zone = parse_cron(spec["cron"]), _zone(spec)
    after = _there(now, zone, local).replace(second=0, microsecond=0)
    for ahead in range(LOOK_AHEAD_DAYS):
        day = after.date() + timedelta(days=ahead)
        if not cron.day_matches(day):
            continue
        for hour in cron.hours:
            if ahead == 0 and hour < after.hour:
                continue
            for minute in cron.minutes:
                if ahead == 0 and hour == after.hour and minute <= after.minute:
                    continue
                return _here(datetime(day.year, day.month, day.day, hour, minute), zone, local)
    return None


def _step(values: tuple[int, ...], span: int) -> int:
    """The step of 0, n, 2n… covering a whole span (every n), else 0."""
    if len(values) < 2 or values[0] != 0:
        return 0
    step = values[1]
    return step if values == tuple(range(0, span, step)) else 0


def _describe_cron(spec: dict[str, Any], lang: str) -> str:
    """The common shapes in words ("weekdays at 9 AM"); anything else as the expression."""
    cron = parse_cron(spec["cron"])
    zone = spec.get("tz") or ""
    words = ""
    simple_time = len(cron.minutes) == 1 and len(cron.hours) == 1
    every_month = len(cron.months) == 12
    every_day = every_month and cron.any_day_of_month and cron.any_weekday
    step = _step(cron.minutes, 60)
    hour_step = _step(cron.hours, 24)
    if every_day and len(cron.hours) == 24 and step:  # */15 * * * *
        words = _every_zh(step) if lang == "zh" else _every_en(step)
    elif every_day and cron.minutes == (0,) and hour_step:  # 0 */2 * * *
        words = _every_zh(hour_step * 60) if lang == "zh" else _every_en(hour_step * 60)
    elif simple_time and every_month and cron.any_day_of_month:
        at = f"{cron.hours[0]:02d}:{cron.minutes[0]:02d}"
        # Every day of the month allowed: the weekdays decide, unless cron's "either field"
        # rule makes it every day anyway.
        weekdays_decide = (cron.dom_star or cron.dow_star) and not cron.any_weekday
        days = sorted((d - 1) % 7 for d in cron.dows) if weekdays_decide else []
        if lang == "zh":
            words = f"{days_zh(days) or '每天'}{clock(at, 'zh')}"
        else:
            words = f"{days_en(days) or 'every day'} at {clock(at)}"
    if not words:
        words = (
            f"按 cron “{spec['cron']}”"
            if lang == "zh"
            else f"on the cron schedule “{spec['cron']}”"
        )
    if zone:
        words += f"（{zone}）" if lang == "zh" else f" ({zone})"
    return words


# ── one entry point for the routine clock ──


def clean(kind: str, spec: Any) -> dict[str, Any]:
    if kind == INTERVAL:
        return clean_interval(spec)
    if kind == MONTHLY:
        return clean_monthly(spec)
    if kind == CRON:
        return clean_cron(spec)
    raise ValueError(f"schedule must be one of {', '.join(KINDS)}")


def latest(
    kind: str,
    spec: dict[str, Any],
    at: str,
    now: datetime,
    local: tzinfo | None = None,
    since: datetime | None = None,
) -> datetime | None:
    """The most recent time the schedule was due, at or before now (this Mac's time).
    since: only a time from then on is wanted (the routine clock's grace), so a cron
    schedule due once a year isn't looked for a year back every half minute; it may give
    None, or an earlier time, when the latest is before since."""
    if kind == INTERVAL:
        return _interval_latest(spec, now)
    if kind == MONTHLY:
        return _monthly_latest(spec, at, now)
    if kind == CRON:
        return _cron_latest(spec, now, local, since)
    return None


def next_after(
    kind: str, spec: dict[str, Any], at: str, now: datetime, local: tzinfo | None = None
) -> datetime | None:
    """The next time the schedule is due, after now."""
    if kind == INTERVAL:
        return _interval_next(spec, now)
    if kind == MONTHLY:
        return _monthly_next(spec, at, now)
    if kind == CRON:
        return _cron_next(spec, now, local)
    return None


def describe(kind: str, spec: dict[str, Any], at: str, lang: str = "en") -> str:
    """The schedule in words, English or Chinese: "every 30 minutes, 9 AM to 6 PM"."""
    lang = "zh" if lang == "zh" else "en"
    if kind == INTERVAL:
        return _describe_interval(spec, lang)
    if kind == MONTHLY:
        return _describe_monthly(spec, at, lang)
    if kind == CRON:
        return _describe_cron(spec, lang)
    return ""
