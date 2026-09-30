"""Automation: routines on richer schedules (every N minutes in a window, monthly, cron),
said and shown in the owner's language.

install(hub) only registers: nothing here reads a file, starts a thread or touches the
network until a loop runs or a command arrives.

Window command: automation_state -> the "automation" event (the routines as the window
draws them, and the language).
"""

from __future__ import annotations

from typing import Any


class Automation:
    """One hub's automation: what the window is sent, and its commands."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def state(self) -> dict[str, Any]:
        return {"language": self.hub.prefs.language, "routines": self.hub.routines.public()}

    def send_state(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("automation", **self.state())


def install(hub: Any) -> None:
    feature = Automation(hub)
    # The card that adds a routine asks in the language the owner speaks.
    hub.routines.language = lambda: hub.prefs.language
    hub.register_command("automation_state", feature.send_state)
