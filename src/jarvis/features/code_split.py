"""Eden Code's split view, its place in prefs: which sessions are on screen side by side in the
window (up to six panes, in order), which pane is the window's own, which has the focus, and
the shares the dividers were dragged to. The window keeps it (web/features/code-split.js) and
puts the split back after a reload or a restart: a session is found again by its key, which
outlasts a restart (features/code_sessions.py), where its id doesn't. The two-pane split kept
before ({left, right, ratio, focus: "left" | "right"}) comes in as its two panes. Tests:
tests/test_code_split.py.

Only its setting lives here: code_split. Split view is on for everyone (it left Labs on
2026-10-10). Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import math
from typing import Any

from .. import prefs

PREF = "code_split"
TEXT_MAX = 64  # a session key (16 hex) or a backend's id (12 hex), with room to spare
MAX_PANES = 6
MAX_COLS = 3  # the columns the grid has at the most (web: MAX_COLS); rows: one per pane
FRAC_MIN = 0.05  # a column's or row's share, at the least (web: FRAC_MIN)
RATIO_MIN, RATIO_MAX = 0.2, 0.8  # the old two-pane divider's range
ID_MAX = 2**31


def _text(value: Any) -> str:
    return (
        value if isinstance(value, str) and len(value) <= TEXT_MAX and value.isprintable() else ""
    )


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _pane(value: Any) -> dict[str, Any]:
    """One pane's session: its id on the backend that kept it, and its key."""
    item = value if isinstance(value, dict) else {}
    sid = item.get("id")
    ok = isinstance(sid, int) and not isinstance(sid, bool) and 0 < sid < ID_MAX
    return {"id": sid if ok else None, "key": _text(item.get("key"))}


def _shares(value: Any, most: int) -> list[float]:
    """The dividers' shares, each at least FRAC_MIN, adding up to 1; [] (equal) for anything
    else."""
    if not isinstance(value, list) or not 0 < len(value) <= most:
        return []
    nums = [_number(v) for v in value]
    if any(n is None or n <= 0 for n in nums):
        return []
    kept = [max(FRAC_MIN, min(1.0, n)) for n in nums if n is not None]
    total = sum(kept)
    return [round(n / total, 4) for n in kept]


def _index(value: Any, count: int) -> int:
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value < count
    return value if ok else 0


def clean(value: Any) -> dict[str, Any] | None:
    """The split as the window keeps it, every field checked; None for anything that isn't
    one (prefs then keeps the value it had)."""
    if not isinstance(value, dict):
        return None
    focus = value.get("focus")
    if isinstance(value.get("panes"), list):
        panes = [_pane(p) for p in value["panes"][:MAX_PANES]]
        cols = _shares(value.get("cols"), MAX_COLS)
    else:  # the two-pane split of before, or nothing kept yet
        old = any(k in value for k in ("left", "right", "ratio"))
        panes = (
            [_pane(value.get("left")), _pane(value.get("right"))]
            if old and (value.get("left") or value.get("right"))
            else []
        )
        ratio = _number(value.get("ratio"))
        ratio = 0.5 if ratio is None else min(RATIO_MAX, max(RATIO_MIN, ratio))
        cols = _shares([ratio, 1 - ratio], MAX_COLS) if old else []
        focus = 1 if value.get("focus") == "right" else 0
    count = len(panes)
    return {
        "on": value.get("on") is True and count >= 2,
        "panes": panes,
        "own": _index(value.get("own"), count),
        "focus": _index(focus, count),
        "cols": cols,
        "rows": _shares(value.get("rows"), MAX_PANES),
        "hub": _text(value.get("hub")),
    }


prefs.register_feature_pref(PREF, {}, clean)
