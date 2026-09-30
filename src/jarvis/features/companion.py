"""The iPhone and Watch companion's feature module: pairing by QR code, push notifications,
the phone's location (for travel times) and health (for the briefing), and the
companion's part of Settings, on top of remote.py's server (jarvis.companion,
jarvis.companion_api and jarvis.companion_push do the work).

Settings it keeps (prefs.features):
- companion_plain_http: plain HTTP for the old app and web page as well as HTTPS. Off
  unless the owner turns it on; Settings warns what it means.
- companion_push_when: "away" (the default: pushes only once the owner has stepped away
  from the Mac) or "always".

Each phone's own push settings (what it's sent) are kept with its push token in
companion.json, and the push key in the Keychain.

Claude cost policy: nothing here calls a model by itself. A photo or a share with a note
from the phone is one ordinary request of the owner's (as /api/ask is), at most three
of the phones' at once (hub.REMOTE_TURNS); phone_health is a tool of the main
conversation, called when the briefing or the owner asks.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from .. import remote
from ..companion_push import WHEN_PREF
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

register_feature_pref(remote.PLAIN_PREF, False)
register_feature_pref(WHEN_PREF, "away", lambda v: v if v in ("away", "always") else None)

COMMANDS = (
    "companion",
    "companion_pairing",
    "companion_new_certificate",
    "companion_push_key",
    "companion_push_forget",
    "companion_push_test",
    "companion_device",
)


def watch_tasks(hub: Any, listener: Callable[[str, dict[str, Any]], Any]) -> None:
    """Jarvis Code's events reach the listener too, after the hub has had each one as
    before (the task manager's emit, wrapped: one failing listener never stops them)."""
    tasks = getattr(hub, "tasks", None)
    original = getattr(tasks, "emit", None)
    if original is None:
        return

    def emit(kind: str, **data: Any) -> None:
        original(kind, **data)
        try:
            listener(kind, data)
        except Exception:
            log.exception("companion: a Jarvis Code event failed")

    tasks.emit = emit


def install(hub: Any) -> None:
    from ..companion import LABELS, PROMPT, Companion

    companion = Companion(hub)
    hub.remote.extension = companion
    for kind in COMMANDS:
        hub.register_command(kind, companion.command)
    # The phone's health, for the briefing (its result is the owner's own: private).
    hub.register_server("companion", companion.build_server, prompt=PROMPT, labels=LABELS)
    hub.travel_fixes.append(companion.phone_fix)  # trips start where the phone is
    notifier, live = companion.notifier, companion.live
    hub.add_approval_sink(notifier.approval)
    hub.add_notify_sink(notifier.alert)
    watch_tasks(hub, notifier.task_event)
    notifier.settle_delegations()  # already in memory: only what changes after this is news
    # Live Activities: a look every few seconds, and at once when a card, a session, a call
    # or a conversation changes (the loop runs with the app, never in tests).
    hub.add_approval_sink(live.approval, resolved=live.resolved)
    hub.add_notify_sink(live.alert)
    watch_tasks(hub, live.task_event)
    hub.register_loop("companion_live", live.loop)
