"""Touch ID for Jarvis Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, and a risky step allowed from its card ask for the owner's
fingerprint (the window asks: web/features/code-touchid.js, through the app's own
app/features/touchid.js), or the usual question where there's no Touch ID.

Only its setting lives here: code_touchid (on by default), in Jarvis Code settings ›
General.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

from .. import prefs

PREF = "code_touchid"
prefs.register_feature_pref(PREF, True)
