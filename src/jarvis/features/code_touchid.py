"""Touch ID for Eden Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, and a risky step allowed from its card ask for the owner's
fingerprint (the window asks: web/features/code-touchid.js, through the app's own
app/features/touchid.js), or the usual question where there's no Touch ID.

Only its setting lives here: code_touchid (on by default), in Eden Code settings ›
General; and check_proof, for the proof the app's main process signs once macOS's sheet said
yes (app/features/touchid.js makeProof, audit S30): "v1.<kind>.<expires ms>.<nonce>.<mac>",
the mac an HMAC-SHA256 under this backend's token of "eden-touchid|v1|<kind>|<expires>|<nonce>".
A proof holds until it expires (two minutes at most) and only once. Nothing asks for one yet:
the window would have to send it with the switch into Bypass, and the backend refuse that
switch from the window without one while Touch ID is on (left for the owner to decide, since
voice and the phone switch without the window).

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time
from collections import OrderedDict

from .. import prefs

PREF = "code_touchid"
prefs.register_feature_pref(PREF, True)

PROOF_SECONDS = 120  # as touchid.js's PROOF_MS
_PROOF = re.compile(r"^v1\.([a-z-]{1,32})\.(\d{13})\.([0-9a-f]{32})\.([0-9a-f]{64})$")
_used: OrderedDict[str, float] = OrderedDict()  # nonce -> its expiry, so each proof works once
_lock = threading.Lock()


def check_proof(token: str, proof: str, kind: str, now: float | None = None) -> bool:
    """Whether proof is the main process's, for kind, unexpired and never used before. Uses it."""
    m = _PROOF.match(str(proof or ""))
    if not token or not m or m.group(1) != kind:
        return False
    expires_ms = int(m.group(2))
    nonce = m.group(3)
    at = time.time() if now is None else now
    if not at * 1000 < expires_ms <= (at + PROOF_SECONDS + 5) * 1000:
        return False
    signed = f"eden-touchid|v1|{kind}|{expires_ms}|{nonce}".encode()
    want = hmac.new(str(token).encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, m.group(4)):
        return False
    with _lock:
        for old, until in list(_used.items()):  # (oldest first: expired ones are forgotten)
            if until * 1000 > at * 1000:
                break
            del _used[old]
        if nonce in _used:
            return False
        _used[nonce] = expires_ms / 1000
        while len(_used) > 1000:
            _used.popitem(last=False)
    return True
