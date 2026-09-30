"""Proactive: JARVIS speaking up at the right moments, and keeping quiet at the others.

Its parts, each a module here with the details (settings, tools, commands, cost):
- quiet.py: quiet hours that follow a Focus mode, the weekend's own hours, and "snooze
  everything for an hour" said out loud.
- briefing.py: the morning briefing laid out by the owner (sections, order, news topics,
  facts the app already knows) and an evening wrap-up.
- reminders.py: Apple Reminders by voice (list, add, tick off, delete on a card), and the
  reminders due in the briefing and the wrap-up.
- weather_watch.py: severe weather warnings, the air and big temperature swings, as
  heads-ups and in the briefing.
- commute.py: how the owner gets places (by car, transit or on foot, arriving early), which
  the leave-time heads-ups and the briefing's first trip follow.
- calendar_look.py: the calendar the parts share, read by one loop.
- habits.py: "Make it a routine" on a habit card.
- meetings.py: an offer to take notes as a meeting starts; after the notes, a follow-up
  email drafted from the action items and the action items in Reminders.
- calls.py: notes for online calls, with the call's own sound (You and Them).

Window: {"type": "proactive_state"} -> one "proactive" event with every part's state (each
part sends its own piece again, as {"type": "proactive", <part>: {...}}, when it changes);
{"type": "proactive_snooze", "minutes": n} (Settings' Snooze and Resume: 0 resumes).

install(hub) only registers: nothing here reads a file, starts a thread or touches the
network until a loop runs or a command arrives.
"""

from __future__ import annotations

import weakref
from typing import Any

from . import (
    briefing,
    calendar_look,
    calls,
    commute,
    habits,
    meetings,
    quiet,
    reminders,
    weather_watch,
)

_FEATURES: weakref.WeakKeyDictionary[Any, Proactive] = weakref.WeakKeyDictionary()


class Proactive:
    """One hub's proactive parts."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.quiet = quiet.Quiet(hub)
        self.briefing = briefing.Briefing(hub)
        self.reminders = reminders.Reminders(hub, self.briefing)
        self.weather = weather_watch.WeatherWatch(hub, self.briefing)
        self.look = calendar_look.CalendarLook(hub)
        self.commute = commute.Commute(hub, self.briefing, self.look)
        self.habits = habits.Habits(hub)
        self.meetings = meetings.Meetings(hub, self.look)
        self.calls = calls.Calls(hub, self.look)
        self.meetings.calls = self.calls

    def install(self) -> None:
        self.quiet.install()
        self.briefing.install()
        self.reminders.install()
        self.weather.install()
        self.look.install()
        self.commute.install()
        self.habits.install()
        self.meetings.install()
        self.calls.install()
        self.hub.register_command("proactive_state", self.send_state)
        self.hub.register_command("proactive_snooze", self.snooze_command)

    def state(self) -> dict[str, Any]:
        return {
            "quiet": self.quiet.state(),
            "briefing": self.briefing.state(),
            "weather": self.weather.state(),
            "commute": self.commute.state(),
        }

    def send_state(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("proactive", **self.state())

    def snooze_command(self, msg: dict[str, Any]) -> None:
        """Settings' Snooze and Resume: the owner's own tap, no card."""
        try:
            minutes = int(msg.get("minutes", quiet.SNOOZE_DEFAULT))
        except (TypeError, ValueError, OverflowError):
            return
        try:
            self.quiet.snooze(minutes)
        except LookupError:
            self.hub.emit("error", text="Snoozing isn't available in this build.")


def feature_of(hub: Any) -> Proactive | None:
    """This hub's proactive parts (for the tests)."""
    return _FEATURES.get(hub)


def install(hub: Any) -> None:
    feature = Proactive(hub)
    _FEATURES[hub] = feature
    feature.install()
