"""Labs: half-finished Eden Code surfaces, off until the owner turns them on.

Polish comes before breadth: a surface that isn't finished is kept out of the way rather than
shown half-working. Each Labs module is neither installed nor has its window files loaded
unless it's on in Settings › Eden Code › Labs (prefs.features["labs"], a list of names);
a change takes effect at the next start. JARVIS_LABS=all (the tests, a developer) turns every
one on.

A module that's finished leaves Labs ("graduates", GRADUATED): it's on for everyone, with a
switch of its own in Settings (a feature pref, on by default) that turns it off the same
way, at the next start. Its old name stays in the labs list wherever an owner had turned
it on (never dropped from prefs.json), so a build from before it graduated still finds it
on, and the owner who chose it keeps it in either.

No Claude calls here.
"""

from __future__ import annotations

import os
from typing import Any

from .. import prefs

KEY = "labs"
# module -> (its name in Settings, what it is, its window files' stems in web/features)
# Graduated (2026-10-16), now always installed: code_spec (Spec mode, an optional workflow:
# nothing changes for a session that doesn't start one, /spec or the welcome's "Write a spec
# first") and code_plugins (the Plugins pane, with its hook editing: Claude Code's plugins,
# agents, skills and hooks, asked for by owners more than anything else Labs held). A "labs"
# setting that still names either just drops it (_clean).
LABS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "code_split": ("Split view", "Two live sessions side by side (⌘⇧\\ or /split).", ("code-split",)),
    "code_share": ("Share live", "A live view of a session for teammates, by link: read-only unless you let a driver ask; on your network, or anywhere through askeden.com.", ("code_share",)),
}  # fmt: skip
# Out of Labs (on for everyone now; a name still in an owner's list is dropped by _clean):
# code_queue, the routing queue, on 2026-10-16, with the cost forecast beside it
# (features/code_forecast).
# module -> (its own switch's feature pref, its window files' stems). Other agents (ACP) left
# Labs once Eden gave its sessions what Claude's have: Rewind, usage and receipts; its name
# stays in an owner's labs list (_clean keeps it), unlike the ones above with no switch.
GRADUATED: dict[str, tuple[str, tuple[str, ...]]] = {
    "code_acp": ("code_acp_agents", ("code-acp",)),
}


def _clean(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return sorted({v for v in value if isinstance(v, str) and (v in LABS or v in GRADUATED)})


prefs.register_feature_pref(KEY, [], _clean)
for _pref, _stems in GRADUATED.values():
    prefs.register_feature_pref(_pref, True)


def enabled(store: Any) -> set[str]:
    """The Labs modules that are on (store: the prefs, or None)."""
    if os.environ.get("JARVIS_LABS") == "all":
        return set(LABS)
    try:
        on = store.feature(KEY) if store is not None else []
    except Exception:
        on = []
    return {name for name in on or [] if name in LABS}


def graduated_off(store: Any) -> set[str]:
    """The graduated modules whose own switch is off (on unless turned off)."""
    off: set[str] = set()
    for name, (pref, _stems) in GRADUATED.items():
        try:
            value = store.feature(pref) if store is not None else True
        except Exception:
            value = True
        if value is False:
            off.add(name)
    return off


def skipped(store: Any) -> set[str]:
    """Feature modules not to install: the Labs ones that are off, and the graduated ones
    switched off."""
    return (set(LABS) - enabled(store)) | graduated_off(store)


def web_skipped(store: Any) -> set[str]:
    """Window file stems not to load (web/features/<stem>.js and .css)."""
    stems = {name: LABS[name][2] for name in LABS} | {n: g[1] for n, g in GRADUATED.items()}
    return {stem for name in skipped(store) for stem in stems[name]}


def public() -> list[dict[str, str]]:
    return [{"name": n, "title": t, "about": a} for n, (t, a, _w) in LABS.items()]
