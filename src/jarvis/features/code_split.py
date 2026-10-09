"""Eden Code's split view, its place in prefs: which two sessions are side by side in the
window, where the divider between them sits and which pane has the focus. The window keeps it
(web/features/code-split.js) and puts the split back after a reload or a restart: a session is
found again by its key, which outlasts a restart (features/code_sessions.py), where its id
doesn't. Tests: tests/test_code_split.py.

Only its setting lives here: code_split. Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import math
from typing import Any

from .. import prefs

PREF = "code_split"
TEXT_MAX = 64  # a session key (16 hex) or a backend's id (12 hex), with room to spare
RATIO_MIN, RATIO_MAX = 0.2, 0.8  # the left pane's share of the width (web: RATIO_MIN, RATIO_MAX)
ID_MAX = 2**31


def _text(value: Any) -> str:
    return (
        value if isinstance(value, str) and len(value) <= TEXT_MAX and value.isprintable() else ""
    )


def _side(value: Any) -> dict[str, Any]:
    """One pane's session: its id on the backend that kept it, and its key."""
    item = value if isinstance(value, dict) else {}
    sid = item.get("id")
    ok = isinstance(sid, int) and not isinstance(sid, bool) and 0 < sid < ID_MAX
    return {"id": sid if ok else None, "key": _text(item.get("key"))}


def clean(value: Any) -> dict[str, Any] | None:
    """The split as the window keeps it, every field checked; None for anything that isn't
    one (prefs then keeps the value it had)."""
    if not isinstance(value, dict):
        return None
    ratio = value.get("ratio", 0.5)
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not math.isfinite(ratio):
        ratio = 0.5
    return {
        "on": value.get("on") is True,
        "ratio": round(min(RATIO_MAX, max(RATIO_MIN, float(ratio))), 4),
        "focus": "right" if value.get("focus") == "right" else "left",
        "left": _side(value.get("left")),
        "right": _side(value.get("right")),
        "hub": _text(value.get("hub")),
    }


prefs.register_feature_pref(PREF, {}, clean)
