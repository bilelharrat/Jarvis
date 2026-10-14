"""Touch ID for Eden Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, and a risky step allowed from its card ask for the owner's
fingerprint (the window asks: web/features/code-touchid.js, through the app's own
app/features/touchid.js), or the usual question where there's no Touch ID.

Only its setting lives here: code_touchid (on by default), in Eden Code settings ›
General; and check_proof, for the proof the app's main process signs once macOS's sheet said
yes (app/features/touchid.js makeProof, audit S30): "v1.<kind>.<expires ms>.<nonce>.<mac>",
the mac an HMAC-SHA256 under this backend's token of "eden-touchid|v1|<kind>|<expires>|<nonce>".
A proof holds until it expires (two minutes at most) and only once.

The backend's gate (Gate, audit S30), while code_touchid is on and the backend was started
with a launch token (server.create_app: hub.launch_token): from the window, a session into
Bypass permissions (task_mode, task_new with mode "auto"), new sessions set to start in it
(code_defaults' code_mode "auto") and a risky step allowed from its card (approve; risky()
is the window's own test, web/features/code-touchid.js, word for word) each need a proof of
their kind. The window sends it just before (code_touchid_proof {kind, proof}: the app's
fingerprint sheet, or on a Mac without Touch ID the app's own confirmation, its native
dialog; a page outside the app can't make one). Without one the switch is refused and said
so (an "error" event; a risky step's card comes back). Answers from the phone (its own gate,
S11) and by voice (the owner's voice and a tap) don't come through here as the window's.

Window commands: code_touchid_proof {kind, proof}: armed for the next command of its kind.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import threading
import time
from collections import OrderedDict
from typing import Any

from .. import lang, prefs

log = logging.getLogger("jarvis")

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


# ── the backend's gate (S30) ──

KINDS = ("bypass", "bypass-default", "approve")
ALLOWING = frozenset({"allow", "always", "allow_edits"})
BYPASS_BY_VOICE = "code_bypass_by_voice"  # voicecode.BYPASS_BY_VOICE: its card's tap
EDITS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
# The window's RISKY (web/features/code-touchid.js), word for word: the window asks for the
# fingerprint for exactly the steps the backend then wants a proof for.
_B = r"(^|[\s;&|(`])"
RISKY = [
    re.compile(_B + r"(sudo|doas)\s"),
    re.compile(_B + r"rm\s+(-\w*[rRf]\w*|--recursive|--force)"),
    re.compile(
        r"\bgit\b[^;&|\n]*\s(push|reset\s+--hard|clean\s+-\w*f\w*|branch\s+-D|filter-branch"
        r"|filter-repo)\b"
    ),
    re.compile(r"\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?\w*sh\b"),
    re.compile(_B + r"(chmod|chown)\s+-\w*R"),
    re.compile(
        _B + r"(dd\s[^|\n]*\bof=|mkfs\b|diskutil\s+(erase\w*|partition\w*|reformat|zero\w*))"
    ),
    re.compile(
        _B + r"(launchctl|csrutil|spctl|systemsetup|networksetup|defaults\s+(write|delete))\b"
    ),
    re.compile(
        _B + r"((npm|yarn|pnpm)\s+publish|twine\s+upload|cargo\s+publish|gem\s+push"
        r"|docker\s+push|pod\s+trunk\s+push)\b"
    ),
    re.compile(
        _B + r"(kubectl\s+(delete|apply|drain)|terraform\s+(apply|destroy)"
        r"|helm\s+(install|upgrade|uninstall|delete))\b"
    ),
    re.compile(r"\b(drop\s+(table|database|schema)|truncate\s+table)\b", re.I),
    re.compile(_B + r"(killall|pkill|shutdown|reboot|halt)\b"),
    re.compile(_B + r"find\s[^;&|\n]*\s-delete\b"),
]


def risky_command(command: Any) -> bool:
    text = str(command or "")
    return any(p.search(text) for p in RISKY)


def risky(approval: Any, choice: str) -> bool:
    """Whether allowing this approval is a risky step (only an Eden Code session's, and
    only a yes), as the window's risky() says."""
    a = approval if isinstance(approval, dict) else {}
    if a.get("tool") == BYPASS_BY_VOICE:
        return choice in ALLOWING
    if not a.get("task_id") or choice not in ALLOWING:
        return False
    if a.get("tool") == "Bash":
        return risky_command(re.sub(r"^\$\s*", "", str(a.get("detail") or "")))
    if a.get("tool") in EDITS:
        return "outside the project" in str(a.get("question") or "")
    return False


NEEDS = {
    "bypass": "Bypass permissions needs your fingerprint (or the Eden app’s own confirmation) "
    "first, so it stayed as it was.",
    "bypass-default": "Starting new sessions in Bypass permissions needs your fingerprint (or "
    "the Eden app’s own confirmation) first, so it stayed as it was.",
    "approve": "That step needs your fingerprint (or the Eden app’s own confirmation) first; "
    "it’s still waiting for your answer.",
}

lang.add_texts(
    {
        NEEDS["bypass"]: "绕过权限需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。",
        NEEDS["bypass-default"]: (
            "让新会话以绕过权限开始需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。"
        ),
        NEEDS["approve"]: "这一步需要先验证你的指纹（或 Eden 应用自己的确认）；它仍在等你回答。",
    }
)


class Gate:
    """The window's switches into Bypass and its risky approvals, each with its proof."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.armed: dict[str, str] = {}  # kind -> the proof the window sent for it, unused

    def on(self) -> bool:
        return bool(getattr(self.hub, "launch_token", "")) and (
            self.hub.prefs.feature(PREF) is not False
        )

    @staticmethod
    def from_window() -> bool:
        """Not a phone's request (companion_code runs those through hub.handle too)."""
        from ..companion_code import _ASKER

        return _ASKER.get() is None

    def needed(self) -> bool:
        return self.on() and self.from_window()

    def take(self, kind: str) -> bool:
        """The armed proof for kind, checked (and used up)."""
        return check_proof(self.hub.launch_token, self.armed.pop(kind, ""), kind)

    def refuse(self, kind: str) -> None:
        log.warning("Touch ID: %s from the window without a proof; refused", kind)
        self.hub.emit("error", text=lang.tr(NEEDS[kind], self.hub.language))

    # ── the window's commands ──

    def on_proof(self, msg: dict[str, Any]) -> None:
        kind, proof = msg.get("kind"), msg.get("proof")
        if kind in KINDS and isinstance(proof, str) and len(proof) < 200:
            self.armed[kind] = proof

    def on_mode(self, msg: dict[str, Any]) -> bool | None:
        if msg.get("mode") != "auto" or not self.needed():
            return False
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError, OverflowError):
            return False
        if task is None or task.mode == "auto" or self.take("bypass"):
            return False  # (no session, or one in it already: nothing to switch on)
        self.refuse("bypass")
        return None

    def on_new(self, msg: dict[str, Any]) -> bool:
        if msg.get("mode") == "auto" and self.needed() and not self.take("bypass"):
            self.refuse("bypass")
            msg["mode"] = "ask"  # it starts all the same, in Manual
        return False

    def on_defaults(self, msg: dict[str, Any]) -> bool:
        if msg.get("code_mode") == "auto" and self.needed():
            if self.hub.prefs.code_mode != "auto" and not self.take("bypass-default"):
                self.refuse("bypass-default")
                msg.pop("code_mode")  # the rest of the change goes as it came
        return False

    def on_approve(self, msg: dict[str, Any]) -> bool | None:
        approval = self.hub.approvals.get(str(msg.get("id")))
        if approval is None or not risky(approval, str(msg.get("choice"))) or not self.needed():
            return False
        if self.take("approve"):
            return False
        self.refuse("approve")
        self.hub.emit("approval", **approval)  # (the window took its card down: it comes back)
        return None


def install(hub: Any) -> None:
    gate = Gate(hub)
    hub.code_touchid = gate
    hub.register_command("code_touchid_proof", gate.on_proof)
    hub.register_command("task_mode", gate.on_mode)
    hub.register_command("task_new", gate.on_new)
    hub.register_command("code_defaults", gate.on_defaults)
    hub.register_command("approve", gate.on_approve)
