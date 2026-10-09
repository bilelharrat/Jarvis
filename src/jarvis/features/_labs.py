"""Labs: half-finished Eden Code surfaces, off until the owner turns them on.

Polish comes before breadth: a surface that isn't finished is kept out of the way rather than
shown half-working. Each Labs module is neither installed nor has its window files loaded
unless it's on in Settings › Eden Code › Labs (prefs.features["labs"], a list of names);
a change takes effect at the next start. JARVIS_LABS=all (the tests, a developer) turns every
one on.

No Claude calls here.
"""

from __future__ import annotations

import os
from typing import Any

from .. import prefs

KEY = "labs"
# module -> (its name in Settings, what it is, its window files' stems in web/features)
LABS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "code_acp": ("Other agents (ACP)", "Run Gemini CLI, Codex and other ACP agents as sessions.", ("code-acp",)),
    "code_plugins": ("Plugins", "Claude Code plugins: their commands, agents and hooks in sessions.", ("code-plugins",)),
    "code_split": ("Split view", "Two live sessions side by side (⌘⇧\\ or /split).", ("code-split",)),
}  # fmt: skip


def _clean(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return sorted({v for v in value if isinstance(v, str) and v in LABS})


prefs.register_feature_pref(KEY, [], _clean)


def enabled(store: Any) -> set[str]:
    """The Labs modules that are on (store: the prefs, or None)."""
    if os.environ.get("JARVIS_LABS") == "all":
        return set(LABS)
    try:
        on = store.feature(KEY) if store is not None else []
    except Exception:
        on = []
    return {name for name in on or [] if name in LABS}


def skipped(store: Any) -> set[str]:
    """Feature modules not to install: the Labs ones that are off."""
    return set(LABS) - enabled(store)


def web_skipped(store: Any) -> set[str]:
    """Window file stems not to load (web/features/<stem>.js and .css)."""
    return {stem for name in skipped(store) for stem in LABS[name][2]}


def public() -> list[dict[str, str]]:
    return [{"name": n, "title": t, "about": a} for n, (t, a, _w) in LABS.items()]
