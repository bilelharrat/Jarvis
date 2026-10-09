"""Logbook, Eden Code under the Obsidian look (web/features/code-logbook.js): its one setting,
whether the margin beside the transcript (the files touched, the plan, the context window) is
shown. Kept in prefs so it's the same after a restart. Tests: tests/test_code_logbook.py.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

from .. import prefs

PREF = "code_margin"
prefs.register_feature_pref(PREF, True)
