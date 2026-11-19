"""Which camera hand control watches: the owner picks it in the hand panel's Camera menu
(web/features/hand-camera.js) and web/hands.js opens it.

The choice is kept by the camera's name, not the browser's device id: an id is made for the
page's address, and the window's address changes with the backend's port at every start. ""
is the Mac's default camera, and a camera that isn't plugged in falls back to it.
"""

from __future__ import annotations

from typing import Any

from ..prefs import register_feature_pref
from ..textclean import clean_text

KEY = "hand_camera"
MAX_NAME = 120  # characters: a camera's name, never a document


def _name(value: Any) -> str | None:
    """A camera's name as the Mac gives it, on one line; anything but text keeps the old one."""
    if not isinstance(value, str):
        return None
    return " ".join(clean_text(value).split())[:MAX_NAME]


register_feature_pref(KEY, "", _name)


def install(hub: Any) -> None:
    """Nothing to start: the setting is registered on import and the window does the rest."""
