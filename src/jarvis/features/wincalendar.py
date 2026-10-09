"""Calendar and Reminders where there is no Calendar or Reminders app (Windows): the calendars the
person keeps, and the reminders said at their time (wincal.py and winreminders.py do the work; the tools
that read and change the calendar are the Mac's own, in win_tools.py, and the reminder tools are
features/proactive/reminders.py: both speak to these through calendar_kit and reminders_desk).

Settings › Calendars (web/features/calendars.js) lists the calendars and adds one from a "subscribe" link:
Brightspace, Outlook on the web, Google Calendar. The link goes straight to the system's secret store
(Windows Credential Manager) and is never shown, logged or echoed back.

Commands (all from the window): calendars_status (the calendars, as a "calendars" event),
calendar_add_feed ({"url", "name"?}), calendar_remove ({"id"}), calendar_refresh ({"id"?}) and
calendar_default ({"id"}) and calendar_outlook ({"on"}: read Outlook for Windows' calendar, while it is open); each answers with a "calendar_result" event in words, and a fresh "calendars".

A loop looks at the reminders every half minute and says each one at its time ("Reminder: call the
dean."), once, as a heads-up that shows and is spoken even with other heads-ups off (the way a timer is).
On a Mac, Calendar and Reminders are used (calendar_kit, reminders_desk) and this module does nothing.

Claude cost policy: no model call is made here.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any

from .. import timers, wincal, winreminders
from ..proactive import Alert

log = logging.getLogger("jarvis")

WATCH_SECONDS = 30


class WinCalendar:
    def __init__(
        self,
        hub: Any,
        store: wincal.Store | None = None,
        reminders: winreminders.Reminders | None = None,
    ) -> None:
        self.hub = hub
        self.store = store or wincal.Store(wincal.folder())
        self.reminders = reminders or winreminders.Reminders()

    # ── to the window ──

    def snapshot(self) -> list[dict[str, Any]]:
        return self.store.calendars()

    def emit_calendars(self) -> None:
        self.hub.emit("calendars", calendars=self.snapshot(), outlook=self.store.outlook_state())

    def _result(self, ok: bool, text: str, **more: Any) -> None:
        self.hub.emit("calendar_result", ok=ok, text=text, **more)
        self.emit_calendars()

    async def status(self, _msg: dict[str, Any]) -> None:
        self.emit_calendars()

    async def add_feed(self, msg: dict[str, Any]) -> None:
        try:
            made = await asyncio.to_thread(
                self.store.add_feed, str(msg.get("url") or ""), str(msg.get("name") or "")
            )
        except wincal.CalendarError as exc:
            self._result(False, str(exc))
            return
        except Exception as exc:  # the network, the secret store: said, never a traceback
            log.warning("calendar link: %s", type(exc).__name__)
            self._result(False, "I couldn't add that calendar just now.")
            return
        count = made.get("events", 0)
        self._result(
            True,
            f"Added {made['title']}: {count} {'event' if count == 1 else 'events'} found. It is read-only here.",
            added=made["id"],
        )

    async def remove(self, msg: dict[str, Any]) -> None:
        found = await asyncio.to_thread(self.store.remove_calendar, str(msg.get("id") or ""))
        self._result(
            found,
            "Removed it. Nothing was deleted from the calendar itself."
            if found
            else "There's no such calendar.",
            removed=found,
        )

    async def refresh(self, msg: dict[str, Any]) -> None:
        said = await asyncio.to_thread(self.store.refresh, True)
        wanted = str(msg.get("id") or "")
        problems = {k: v for k, v in said.items() if v and (not wanted or k == wanted)}
        if problems:
            self._result(False, next(iter(problems.values())))
        else:
            self._result(True, "The calendars are up to date.")

    async def outlook(self, msg: dict[str, Any]) -> None:
        try:
            said = await asyncio.to_thread(self.store.set_outlook, bool(msg.get("on")))
        except wincal.CalendarError as exc:
            self._result(False, str(exc))
            return
        except Exception as exc:  # Outlook itself, COM: said, never a traceback
            log.warning("outlook calendar: %s", type(exc).__name__)
            self._result(False, "I couldn't reach Outlook just now.")
            return
        self._result(True, said)

    async def default(self, msg: dict[str, Any]) -> None:
        try:
            self.store.set_default(str(msg.get("id") or ""))
        except wincal.CalendarError as exc:
            self._result(False, str(exc))
            return
        self._result(True, "New events go on Jarvis's calendar.")

    # ── reminders, said at their time ──

    def say_due(self) -> int:
        """Say each reminder whose time has come; how many were said."""
        language = (
            "zh"
            if self.hub.prefs.language and str(self.hub.prefs.language).startswith("zh")
            else "en"
        )
        said = 0
        for item in self.reminders.due_now():
            title = str(item.get("title") or "").strip()
            if not title:
                continue
            text = timers.say("Reminder: {label}.", language, label=title)
            try:
                self.hub.notify(
                    Alert(
                        f"reminder:{item['id']}", "reminder", timers.say("Reminder", language), text
                    ),
                    False,
                )
                said += 1
            except Exception:
                log.exception("reminders: the heads-up failed")
        return said

    async def watch(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.say_due)
            except Exception:  # a damaged file, a full disk: the clock goes on
                log.exception("reminders: check failed")
            await asyncio.sleep(WATCH_SECONDS)


IS_WIN = sys.platform == "win32"


def install(hub: Any) -> None:
    if not IS_WIN:
        return  # Calendar and Reminders (calendar_kit, reminders_desk)
    feature = WinCalendar(hub)
    hub.wincalendar = feature
    hub.register_command("calendars_status", feature.status)
    hub.register_command("calendar_add_feed", feature.add_feed, slow=True)
    hub.register_command("calendar_remove", feature.remove)
    hub.register_command("calendar_refresh", feature.refresh, slow=True)
    hub.register_command("calendar_default", feature.default)
    hub.register_command("calendar_outlook", feature.outlook, slow=True)
    hub.register_loop("reminders", feature.watch)
