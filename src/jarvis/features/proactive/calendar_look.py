"""The calendar the proactive parts share: from a couple of hours ago to two weeks ahead,
read by one loop every EVERY seconds (one run of the EventKit helper, calendar_kit), and
never in tests, which hand it events themselves (update).

Parts read it (look.events: calendar_kit's rows with real datetimes, soonest first) and hear
each fresh read (look.listeners: fn(events), a coroutine or not): the commute's first trip
of the day, and the parts that watch meetings and invitations.

Cost: no model calls; one calendar read every ten minutes while the app runs.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any

log = logging.getLogger("jarvis")

EVERY = 10 * 60
BACK_H = 2  # a meeting that began a little while ago is still known
AHEAD_H = 14 * 24


class CalendarLook:
    """One hub's shared look at the calendar."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.events: list[dict[str, Any]] = []
        self.read_at: datetime | None = None
        self.error = ""
        self.listeners: list[Callable[[list[dict[str, Any]]], Any]] = []

    def install(self) -> None:
        self.hub.register_loop("calendar_look", self.loop)

    async def loop(self) -> None:
        while True:
            try:
                await self.refresh()
            except Exception:  # one bad read never ends the look
                log.exception("proactive: the calendar look failed")
            await asyncio.sleep(EVERY)

    async def refresh(self) -> None:
        from ... import calendar_kit

        found = await calendar_kit.fetch(BACK_H, AHEAD_H)
        if "events" not in found:
            self.error = str(found.get("error") or "The calendar couldn't be read.")
            return
        await self.update(calendar_kit.parse(found["events"]))

    async def update(self, events: list[dict[str, Any]]) -> None:
        """A fresh read (or a test's events): kept, soonest first, and each listener told
        (one that fails is logged; the others still hear it)."""
        self.events = sorted(
            (e for e in events if isinstance(e.get("begin"), datetime)), key=lambda e: e["begin"]
        )
        self.read_at = datetime.now()
        self.error = ""
        for listener in list(self.listeners):
            try:
                result = listener(self.events)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                log.exception("proactive: a calendar listener failed")

    def timed(self) -> list[dict[str, Any]]:
        """The events with a time of day (not all-day ones) the owner hasn't declined."""
        return [e for e in self.events if not e.get("all_day") and e.get("reply") != "declined"]
