"""The Mac app's shell, backend side (app/features/shell.js and web/features/shell.js are the
other two parts).

- "Pause heads-ups for an hour" in the menu bar: {"type": "shell_pause", "minutes": 60}
  keeps heads-ups from showing until then, as Heads-ups off in Settings would (a
  conversation held for the user, a call or a voicemail still shows); minutes 0 resumes.
- The app's settings kept with the others: whether JARVIS shows in the menu bar, and the
  global shortcuts for Talk (⌥Space) and What's this? (⌥⇧Space), as Electron accelerators
  (checked as app/features/shell-lib.js's checkAccelerator checks them).

Cost: no model calls.
"""

from __future__ import annotations

import math
import string
import time
from typing import Any

from ..prefs import register_feature_pref

PAUSE_KEY = "shell_pause_until"  # seconds since 1970 (0: not paused)
MENU_BAR_KEY = "shell_menu_bar"
ASK_SHORTCUT_KEY = "shell_shortcut_ask"
WHATS_THIS_SHORTCUT_KEY = "shell_shortcut_whats_this"
PAUSE_MAX_MINUTES = 12 * 60
# What shows even with heads-ups off (Hub.notify): a pause holds back what the switch would.
ALWAYS_SHOWN = ("meeting", "delegate", "call", "voicemail")


def _clean_until(value: Any) -> float | None:
    """When a pause ends: 0, or a time no further off than the longest pause (a hand edit
    can't silence heads-ups for good)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if not math.isfinite(value) or value < 0:
        return None
    if value > time.time() + PAUSE_MAX_MINUTES * 60 + 60:
        return None
    return value


_MODIFIERS = ("Command", "Control", "Alt", "Shift")  # in the one order accelerators are spelled
_FKEYS = {f"F{n}" for n in range(1, 25)}
_KEYS = (
    set(string.ascii_uppercase)
    | set(string.digits)
    | _FKEYS
    | {"Space", "Return", "Tab", "Backspace", "Delete", "Up", "Down", "Left", "Right"}
    | {"Home", "End", "PageUp", "PageDown", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"}
)
# macOS keeps these for itself (the app's RESERVED, in shell-lib.js).
RESERVED = {
    "Control+Space",
    "Command+Control+Space",
    "Command+Alt+Space",
    "Command+Tab",
    "Command+Shift+Tab",
    "Command+Shift+3",
    "Command+Shift+4",
    "Command+Shift+5",
    "Command+Control+Q",
    "Command+Shift+Q",
    "Control+Up",
    "Control+Down",
    "Control+Left",
    "Control+Right",
}


def clean_accelerator(value: Any) -> str | None:
    """A global shortcut as an Electron accelerator, spelled the one way ("Alt+Shift+Space"),
    or None: it needs ⌃ or ⌥, or ⌘ with another modifier (⌘ alone would take the key from
    every app), except a function key; and none of macOS's own."""
    if not isinstance(value, str) or not value or len(value) > 60:
        return None
    *mods, key = value.split("+")
    if key not in _KEYS or len(set(mods)) != len(mods) or any(m not in _MODIFIERS for m in mods):
        return None
    ordered = [m for m in _MODIFIERS if m in mods]
    accelerator = "+".join([*ordered, key])
    strong = "Control" in ordered or "Alt" in ordered or ("Command" in ordered and len(ordered) > 1)
    if (key not in _FKEYS and not strong) or accelerator in RESERVED:
        return None
    return accelerator


register_feature_pref(PAUSE_KEY, 0.0, _clean_until)
register_feature_pref(MENU_BAR_KEY, True)
register_feature_pref(ASK_SHORTCUT_KEY, "Alt+Space", clean_accelerator)
register_feature_pref(WHATS_THIS_SHORTCUT_KEY, "Alt+Shift+Space", clean_accelerator)


def paused(hub: Any) -> bool:
    # Cleaned again here: the settings file is read before feature modules register their
    # checks, so a hand-edited value reaches this as it was written.
    return time.time() < (_clean_until(hub.prefs.feature(PAUSE_KEY)) or 0.0)


def pause_heads_ups(hub: Any, msg: dict[str, Any]) -> None:
    try:
        minutes = int(msg.get("minutes", 60))
    except (TypeError, ValueError, OverflowError):
        return
    minutes = max(0, min(PAUSE_MAX_MINUTES, minutes))
    hub.set_feature_prefs({PAUSE_KEY: time.time() + minutes * 60 if minutes else 0.0})


def install(hub: Any) -> None:
    hub.add_notify_gate(lambda alert: alert.kind in ALWAYS_SHOWN or not paused(hub))
    hub.register_command("shell_pause", lambda msg: pause_heads_ups(hub, msg))
