"""The connector activity log in the window: Settings › Tools & Accounts lists every call
JARVIS made in the owner's connected accounts (connectors.py writes each one to
connector_log as it happens and sends the window the latest; this answers the window's
{"type": "connector_activity"} when it first shows the list).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

from typing import Any


def install(hub: Any) -> None:
    def activity(_msg: dict[str, Any]) -> None:
        hub.emit("connector_activity", **hub.connectors.activity_public())

    hub.register_command("connector_activity", activity)
