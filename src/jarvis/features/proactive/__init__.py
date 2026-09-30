"""Proactive: JARVIS speaking up at the right moments, and keeping quiet at the others.

Its parts, each a module here with the details (settings, tools, commands, cost):
- quiet.py: quiet hours that follow a Focus mode, the weekend's own hours, and "snooze
  everything for an hour" said out loud.

Window: {"type": "proactive_state"} -> one "proactive" event with every part's state (each
part sends its own piece again, as {"type": "proactive", <part>: {...}}, when it changes);
{"type": "proactive_snooze", "minutes": n} (Settings' Snooze and Resume: 0 resumes).

install(hub) only registers: nothing here reads a file, starts a thread or touches the
network until a loop runs or a command arrives.
"""

from __future__ import annotations

import weakref
from typing import Any

from . import quiet

_FEATURES: weakref.WeakKeyDictionary[Any, Proactive] = weakref.WeakKeyDictionary()


class Proactive:
    """One hub's proactive parts."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.quiet = quiet.Quiet(hub)

    def install(self) -> None:
        self.quiet.install()
        self.hub.register_command("proactive_state", self.send_state)
        self.hub.register_command("proactive_snooze", self.snooze_command)

    def state(self) -> dict[str, Any]:
        return {"quiet": self.quiet.state()}

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
