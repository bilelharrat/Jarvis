"""Ask Eden from anywhere on the Mac (askeden ROADMAP H10), backend side: the two settings,
kept with the others. app/features/eden-window.js registers the global shortcut and opens
the small Eden window; web/features/eden-hotkey.js is its row in Settings › This Mac.

- eden_hotkey: whether the shortcut is on (off until the owner switches it on).
- eden_hotkey_keys: its keys, an Electron accelerator checked as the other global shortcuts
  are (shell.clean_accelerator); ⌃⌥Space by default, since ⌥Space is Talk.

Cost: no model calls.
"""

from __future__ import annotations

from ..prefs import register_feature_pref
from .shell import clean_accelerator

ON_KEY = "eden_hotkey"
KEYS_KEY = "eden_hotkey_keys"
DEFAULT_KEYS = "Control+Alt+Space"

register_feature_pref(ON_KEY, False)
register_feature_pref(KEYS_KEY, DEFAULT_KEYS, clean_accelerator)
