"""JARVIS speaking up on its own: time to leave, a meeting about to start, a low battery,
rain on the way, Claude Code done or waiting. (Texts and email that matter are the
interrupter's: interrupts.py.)

The rules are plain functions of the current state so they can be tested; `Watcher`
runs them every minute and hands anything new to the hub, which shows a card and, when
the moment is right (not busy, not in quiet hours, not taking meeting notes), says it.
Every alert has a key, and a key is only ever announced once.

Travel times are by car with current traffic, unless a feature plans the trips
(Watcher.plan: the proactive feature's commute profile, by transit or on foot, arriving
early): time_to_leave then says how, and leaves by a train's departure when Maps gives one.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from . import lang

log = logging.getLogger("jarvis")

TICK_SECONDS = 60
EVENTS_EVERY = 5 * 60
ETA_EVERY = 10 * 60
LEAVE_BUFFER_MIN = 5  # announce this long before you'd have to be out the door
LEAVE_LOOKAHEAD_H = 3
SOON_MIN = 10
NEAR_MIN = 3  # an ETA this short means you're basically there
RAIN_CHANCE = 60
RAINY_CODES = 51  # WMO weather codes from 51 up are drizzle, rain, snow, showers, storms
# An alert key said this long ago is forgotten: each carries its event's start or its day,
# and no rule raises one for an event that has begun or a day that's over. The battery's
# keys are the exception (the same two every time), kept until the Mac is charging.
ANNOUNCED_DAYS = 2
BATTERY_KEYS = ("battery:10", "battery:5")

_VIRTUAL = re.compile(
    r"(https?://|zoom\.us|meet\.google|teams\.microsoft|microsoft teams|webex|facetime|"
    r"\bzoom\b|\bonline\b|\bvirtual\b|\bphone\b|\bcall\b)",
    re.IGNORECASE,
)


@dataclass
class Alert:
    key: str
    kind: str  # leave | soon | battery | rain | mail | task
    title: str
    text: str  # what JARVIS says
    note: str = ""  # what rides along with the next request, when text isn't safe to


def is_travel(location: str) -> bool:
    return bool(location.strip()) and not _VIRTUAL.search(location)


def _clock(when: datetime) -> str:
    return when.strftime("%-I:%M %p").replace(":00 ", " ")


def _travels(e: dict[str, Any], etas: dict[str, int | None]) -> bool:
    """Needs a trip we can time: a real place and a Maps ETA worth announcing."""
    minutes = etas.get(event_key(e))
    return is_travel(e.get("location", "")) and minutes is not None and minutes > NEAR_MIN


def meeting_soon(
    events: list[dict[str, Any]], now: datetime, etas: dict[str, int | None] | None = None
) -> list[Alert]:
    """Starting within ten minutes, unless time_to_leave already covers it (a place we
    have a real travel time for). A room name Maps can't place still gets this."""
    etas = etas or {}
    out = []
    for e in events:
        if e.get("all_day"):
            continue
        minutes = (e["begin"] - now).total_seconds() / 60
        if 0 < minutes <= SOON_MIN and not _travels(e, etas):
            left = max(1, round(minutes))
            out.append(
                Alert(
                    f"soon:{e.get('id') or e['title']}:{e['begin']:%Y%m%d%H%M}",
                    "soon",
                    e["title"],
                    f"{e['title']} starts in {left} minute{'s' if left != 1 else ''}.",
                )
            )
    return out


# What a leave-time heads-up says, by how the owner gets there: (time to go, running late).
LEAVE_TEXTS = {
    "driving": (
        "Time to leave for {title}. It's {minutes} minutes to {place} with current traffic, "
        "and it starts at {time}.",
        "You'll be a little late for {title}: it's {minutes} minutes to {place} with current "
        "traffic, and it starts at {time}.",
    ),
    "transit": (
        "Time to leave for {title}. It's {minutes} minutes to {place} by transit, and it "
        "starts at {time}.",
        "You'll be a little late for {title}: it's {minutes} minutes to {place} by transit, "
        "and it starts at {time}.",
    ),
    "walking": (
        "Time to leave for {title}. It's a {minutes}-minute walk to {place}, and it starts "
        "at {time}.",
        "You'll be a little late for {title}: it's a {minutes}-minute walk to {place}, and "
        "it starts at {time}.",
    ),
}
lang.add_texts(
    {
        LEAVE_TEXTS["transit"][
            0
        ]: "该出发去{title}了。坐公共交通到{place}要{minutes}分钟，{time}开始。",
        LEAVE_TEXTS["transit"][1]: (
            "去{title}可能会晚一点：坐公共交通到{place}要{minutes}分钟，而它{time}就开始了。"
        ),
        LEAVE_TEXTS["walking"][0]: "该出发去{title}了。走到{place}要{minutes}分钟，{time}开始。",
        LEAVE_TEXTS["walking"][1]: (
            "去{title}可能会晚一点：走到{place}要{minutes}分钟，而它{time}就开始了。"
        ),
    }
)


def time_to_leave(
    events: list[dict[str, Any]],
    now: datetime,
    etas: dict[str, int | None],
    trips: dict[str, dict[str, Any]] | None = None,
) -> list[Alert]:
    """etas: minutes of travel per event key (None when Maps couldn't say). trips: how each
    goes when a feature planned it ({mode, early: minutes to arrive before it starts,
    depart: when a train that gets there in time leaves}); by car without one."""
    out = []
    for e in events:
        if e.get("all_day") or not is_travel(e.get("location", "")):
            continue
        key = event_key(e)
        minutes = etas.get(key)
        if minutes is None or minutes <= NEAR_MIN or e["begin"] <= now:
            continue
        trip = (trips or {}).get(key) or {}
        mode = trip.get("mode") if trip.get("mode") in LEAVE_TEXTS else "driving"
        early = max(0, int(trip.get("early") or 0))
        depart = trip.get("depart") if isinstance(trip.get("depart"), datetime) else None
        if depart is not None:  # a timetable: the train that gets there in time
            leave_at = depart - timedelta(minutes=LEAVE_BUFFER_MIN)
            late = now > depart
        else:
            arrive = e["begin"] - timedelta(minutes=early)
            leave_at = arrive - timedelta(minutes=minutes + LEAVE_BUFFER_MIN)
            late = now > e["begin"] - timedelta(minutes=minutes)
        if now >= leave_at:
            place = e["location"].split(",")[0].split("\n")[0].strip()
            template = LEAVE_TEXTS[mode][1 if late else 0]
            text = template.format(
                title=e["title"], minutes=minutes, place=place, time=_clock(e["begin"])
            )
            out.append(Alert(f"leave:{key}", "leave", f"Leave for {e['title']}", text))
    return out


def event_key(e: dict[str, Any]) -> str:
    return f"{e.get('id') or e['title']}:{e['begin']:%Y%m%d%H%M}"


def needs_eta(events: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    return [
        e
        for e in events
        if not e.get("all_day")
        and is_travel(e.get("location", ""))
        and now < e["begin"] <= now + timedelta(hours=LEAVE_LOOKAHEAD_H)
    ]


def battery_alerts(battery: dict[str, Any] | None) -> list[Alert]:
    if not battery or battery.get("plugged"):
        return []
    pct = battery.get("percent", 100)
    if pct <= 5:
        return [
            Alert(
                "battery:5",
                "battery",
                "Battery at 5%",
                f"Battery's at {pct} percent. Plug in soon or I'll be taking an unscheduled nap.",
            )
        ]
    if pct <= 10:
        return [Alert("battery:10", "battery", "Battery low", f"Battery's down to {pct} percent.")]
    return []


def rain_alerts(weather: dict[str, Any] | None, now: datetime) -> list[Alert]:
    """Rain likely within the next two hours when it isn't already coming down. Once a
    day: a wet afternoon is one heads-up, not one an hour."""
    if not weather or weather.get("error"):
        return []
    if int(weather.get("code") or 0) >= RAINY_CODES:
        return []
    # next_hours starts at the first whole hour at or after now, so [0:2] is the next two.
    for hour in (weather.get("next_hours") or [])[0:2]:
        if (hour.get("rain") or 0) >= RAIN_CHANCE:
            return [
                Alert(
                    f"rain:{now:%Y%m%d}",
                    "rain",
                    "Rain on the way",
                    f"Rain's likely around {hour['time']}, {hour['rain']} percent chance. "
                    "Might want an umbrella.",
                )
            ]
    return []


def in_quiet_hours(now: datetime, spec: str) -> bool:
    try:
        start_s, end_s = spec.split("-")
        start = now.replace(hour=int(start_s[:2]), minute=int(start_s[3:5]))
        end = now.replace(hour=int(end_s[:2]), minute=int(end_s[3:5]))
    except (ValueError, IndexError):
        return False
    if start <= end:
        return start <= now < end
    return now >= start or now < end


def feature_quiet(hub: Any, now: datetime) -> bool | None:
    """The hub's features' say on quiet hours now (Hub.quiet_verdict: a Focus mode on, the
    weekend's own hours, heads-ups paused), or None when the range in Settings decides."""
    verdict = getattr(hub, "quiet_verdict", None)
    if not callable(verdict):
        return None
    try:
        said = verdict(now)
    except Exception:
        return None
    return said if isinstance(said, bool) else None


def quiet_hours_now(
    hub: Any, now: datetime, in_range: Callable[[datetime, str], bool] = in_quiet_hours
) -> bool:
    """Quiet hours now, for code that has the hub: its features' say, else the range in
    Settings (in_range: the caller's own in_quiet_hours, so a test faking it still does)."""
    said = feature_quiet(hub, now)
    if said is not None:
        return said
    return bool(in_range(now, str(getattr(getattr(hub, "prefs", None), "quiet_hours", "") or "")))


Notify = Callable[[Alert], None]


class Watcher:
    """Runs the rules on a clock. Everything it needs comes in as callables, so tests can
    drive it with fakes."""

    def __init__(
        self,
        notify: Notify,
        *,
        events: Callable[[], Awaitable[list[dict[str, Any]]]],
        eta: Callable[[str], Awaitable[int | None]],
        battery: Callable[[], dict[str, Any] | None],
        weather: Callable[[], dict[str, Any] | None],
        files: Callable[[list[dict[str, Any]], datetime], Awaitable[list[Alert]]] | None = None,
        enabled: Callable[[], bool] = lambda: True,
    ) -> None:
        self.notify = notify
        self._events_fn, self._eta_fn = events, eta
        self._battery_fn, self._weather_fn = battery, weather
        self._enabled = enabled
        self._files_fn = files  # the file index: a meeting's files, before it starts
        self.announced: dict[str, datetime] = {}  # alert key: when it was said
        self._events: list[dict[str, Any]] = []
        self._events_at: datetime | None = None
        self._etas: dict[str, tuple[datetime, int | None]] = {}
        # A feature's trip planner, used instead of eta when set: plan(event) gives
        # {minutes, mode, early, depart} or None (the proactive feature's commute profile).
        self.plan: Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]] | None = None
        self.trips: dict[str, dict[str, Any]] = {}  # the trip last planned per event key

    async def run(self) -> None:
        while True:
            try:
                await self.tick(datetime.now())
            except Exception:  # one bad rule never stops the rest
                log.exception("proactive check failed")
            await asyncio.sleep(TICK_SECONDS)

    async def tick(self, now: datetime) -> list[Alert]:
        if not self._enabled():
            return []
        alerts: list[Alert] = []
        await self._refresh_events(now)
        etas = await self._etas_for(now)
        alerts += meeting_soon(self._events, now, etas)
        alerts += time_to_leave(self._events, now, etas, self.trips)
        alerts += battery_alerts(self._battery_fn())
        alerts += rain_alerts(self._weather_fn(), now)
        if self._files_fn is not None:
            try:
                alerts += await self._files_fn(self._files_unsaid(), now)
            except Exception as exc:  # an index being rebuilt: next time
                log.info("proactive: no meeting files (%s)", exc)
        power = self._battery_fn() or {}
        if power.get("plugged") or power.get("percent", 100) > 10:
            for key in BATTERY_KEYS:  # charging: warn again next time
                self.announced.pop(key, None)
        fresh = [a for a in alerts if a.key not in self.announced]
        for alert in fresh:
            self.announced[alert.key] = now
            self.notify(alert)
        self._forget_said(now)
        return fresh

    def _files_unsaid(self) -> list[dict[str, Any]]:
        """The events whose files haven't been announced (fileindex.meeting_alerts keys its
        alerts "files:" + event_key). One that was isn't looked up again: each look is a
        full-text search of the index, every minute of the half hour before the meeting."""
        out = []
        for e in self._events:
            try:
                said = f"files:{event_key(e)}" in self.announced
            except (KeyError, TypeError, ValueError):  # no start or title: the index decides
                said = False
            if not said:
                out.append(e)
        return out

    def _forget_said(self, now: datetime) -> None:
        cutoff = now - timedelta(days=ANNOUNCED_DAYS)
        old = [k for k, at in self.announced.items() if at < cutoff and k not in BATTERY_KEYS]
        for key in old:
            del self.announced[key]

    async def _refresh_events(self, now: datetime) -> None:
        if self._events_at and (now - self._events_at).total_seconds() < EVENTS_EVERY:
            return
        self._events_at = now
        try:
            events = await self._events_fn()
        except Exception as exc:  # no calendar access
            log.info("proactive: no calendar (%s)", exc)
            events = []
        # One the owner declined isn't theirs to go to: no heads-up, no leave time, and
        # not a meeting they're in.
        self._events = [e for e in events if e.get("reply") != "declined"]

    async def _etas_for(self, now: datetime) -> dict[str, int | None]:
        out = {}
        for e in needs_eta(self._events, now):
            key = event_key(e)
            cached = self._etas.get(key)
            if cached is None or (now - cached[0]).total_seconds() >= ETA_EVERY:
                trip = None
                try:
                    if self.plan is not None:
                        trip = await self.plan(e)
                        minutes = trip.get("minutes") if trip else None
                    else:
                        minutes = await self._eta_fn(e["location"])
                except Exception:
                    minutes = None
                usable = isinstance(minutes, int | float) and not isinstance(minutes, bool)
                cached = (now, round(minutes) if usable else None)
                self._etas[key] = cached
                if trip:
                    self.trips[key] = trip
                else:
                    self.trips.pop(key, None)
            out[key] = cached[1]
        self.trips = {k: v for k, v in self.trips.items() if k in out}
        return out

    def known_events(self) -> list[dict[str, Any]]:
        """The calendar as last read (the next few hours), for features to look at."""
        return list(self._events)
