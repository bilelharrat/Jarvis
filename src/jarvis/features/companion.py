"""The iPhone and Watch companion's feature module: pairing by QR code and the companion's
part of Settings, on top of remote.py's server (jarvis.companion does the work).

Settings it keeps (prefs.features):
- companion_plain_http: plain HTTP for the old app and web page as well as HTTPS. Off
  unless the owner turns it on; Settings warns what it means.

Claude cost policy: nothing here calls a model.
"""

from __future__ import annotations

from typing import Any

from .. import remote
from ..prefs import register_feature_pref

register_feature_pref(remote.PLAIN_PREF, False)

COMMANDS = ("companion", "companion_pairing", "companion_new_certificate")


def install(hub: Any) -> None:
    from ..companion import Companion

    companion = Companion(hub)
    hub.remote.extension = companion
    for kind in COMMANDS:
        hub.register_command(kind, companion.command)
