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
LABS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "code_plugins": ("Plugins", "Claude Code plugins: their commands, agents and hooks in sessions.", ("code-plugins",)),
    "code_queue": ("Routing queue", "Run a project's to-do cards in the background, each on the cheapest model that passes its checks, within a dollar ceiling.", ()),
    "code_spec": ("Spec mode", "Requirements, design and tasks in the repo, each OK'd, then checked against the spec.", ("code-spec",)),
    "code_split": ("Split view", "Two live sessions side by side (⌘⇧\\ or /split).", ("code-split",)),
    "code_share": ("Share live", "A read-only live view of a session for a teammate, by link, on your network.", ("code_share",)),
}  # fmt: skip
# module -> (its own switch's feature pref, its window files' stems). Other agents (ACP) left
# Labs once Eden gave its sessions what Claude's have: Rewind, usage and receipts.
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
