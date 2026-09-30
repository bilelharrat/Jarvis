"""JARVIS speaking up on its own: time to leave, a meeting about to start, a low battery,
rain on the way, Claude Code done or waiting. (Texts and email that matter are the
interrupter's: interrupts.py.)

The rules are plain functions of the current state so they can be tested; `Watcher`
runs them every minute and hands anything new to the hub, which shows a card and, when
the moment is right (not busy, not in quiet hours, not taking meeting notes), says it.
Every alert has a key, and a key is only ever announced once.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

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


def time_to_leave(
    events: list[dict[str, Any]], now: datetime, etas: dict[str, int | None]
) -> list[Alert]:
    """etas: minutes of travel per event key (None when Maps couldn't say)."""
    out = []
    for e in events:
        if e.get("all_day") or not is_travel(e.get("location", "")):
            continue
        key = event_key(e)
        minutes = etas.get(key)
        if minutes is None or minutes <= NEAR_MIN or e["begin"] <= now:
            continue
        leave_at = e["begin"] - timedelta(minutes=minutes + LEAVE_BUFFER_MIN)
        if now >= leave_at:
            late = now > e["begin"] - timedelta(minutes=minutes)
            place = e["location"].split(",")[0].split("\n")[0].strip()
            text = (
                f"You'll be a little late for {e['title']}: it's {minutes} minutes to {place} "
                f"with current traffic, and it starts at {_clock(e['begin'])}."
                if late
                else f"Time to leave for {e['title']}. It's {minutes} minutes to {place} with "
                f"current traffic, and it starts at {_clock(e['begin'])}."
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
        self.announced: set[str] = set()
        self._events: list[dict[str, Any]] = []
        self._events_at: datetime | None = None
        self._etas: dict[str, tuple[datetime, int | None]] = {}

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
        alerts += time_to_leave(self._events, now, etas)
        alerts += battery_alerts(self._battery_fn())
        alerts += rain_alerts(self._weather_fn(), now)
        if self._files_fn is not None:
            try:
                alerts += await self._files_fn(self._events, now)
            except Exception as exc:  # an index being rebuilt: next time
                log.info("proactive: no meeting files (%s)", exc)
        power = self._battery_fn() or {}
        if power.get("plugged") or power.get("percent", 100) > 10:
            self.announced -= {"battery:10", "battery:5"}  # charging: warn again next time
        fresh = [a for a in alerts if a.key not in self.announced]
        for alert in fresh:
            self.announced.add(alert.key)
            self.notify(alert)
        return fresh

    async def _refresh_events(self, now: datetime) -> None:
        if self._events_at and (now - self._events_at).total_seconds() < EVENTS_EVERY:
            return
        self._events_at = now
        try:
            self._events = await self._events_fn()
        except Exception as exc:  # no calendar access
            log.info("proactive: no calendar (%s)", exc)
            self._events = []

    async def _etas_for(self, now: datetime) -> dict[str, int | None]:
        out = {}
        for e in needs_eta(self._events, now):
            key = event_key(e)
            cached = self._etas.get(key)
            if cached is None or (now - cached[0]).total_seconds() >= ETA_EVERY:
                try:
                    minutes = await self._eta_fn(e["location"])
                except Exception:
                    minutes = None
                cached = (now, minutes)
                self._etas[key] = cached
            out[key] = cached[1]
        return out
