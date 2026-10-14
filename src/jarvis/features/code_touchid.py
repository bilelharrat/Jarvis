"""Touch ID for Eden Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, and a risky step allowed from its card ask for the owner's
fingerprint (the window asks: web/features/code-touchid.js, through the app's own
app/features/touchid.js), or the app's own confirmation where there's no Touch ID.

Its setting: code_touchid (on by default), in Eden Code settings › General. check_proof
checks the proof the app's main process signs once macOS's sheet said
yes (app/features/touchid.js makeProof, audit S30): "v1.<kind>.<expires ms>.<nonce>.<mac>",
the mac an HMAC-SHA256 of "eden-touchid|v1|<kind>|<expires>|<nonce>" under the proof key: one
the app that started this backend gave it on its own pipe (proof_pipe.py), never the launch
token, which the page has (its URL), so a script in the window can't sign a yes of its own
(round 1, A1). A proof holds until it expires (two minutes at most) and only once. A window of
the other app on this backend (backend-share.js) has no key: it asks here
(code_touchid_ask {kind, lang}), this backend asks its own app over the pipe, that app shows
its sheet and the proof comes back the same way, armed at once (code_touchid_answer
{proof_kind, ok} tells the window). A backend run by hand has no key, and no proof holds.

The backend's gate (Gate, audit S30), while code_touchid is on and the backend was started
with a launch token (server.create_app: hub.launch_token): from the window, a session into
Bypass permissions (task_mode, task_new with mode "auto"), new sessions set to start in it
(code_defaults' or set_prefs' code_mode "auto", a project's own default mode "auto" in
feature_prefs' code_project_defaults), a risky step allowed from its card (approve; risky()
is the window's own test, web/features/code-touchid.js, word for word, and any card the
backend marks touchid) and turning this very setting off (feature_prefs code_touchid false:
kind "touchid-off", round 1 A3) each need a proof of their kind. A new session (task_new, and
an ACP agent's acp_start: code_acp.py asks here) in Bypass needs one unless its project's
default (or everyone's) is Bypass already, which needed one to be set. The window sends the
proof just before (code_touchid_proof {kind, proof}: the app's
fingerprint sheet, or on a Mac without Touch ID the app's own confirmation, its native
dialog; a page outside the app can't make one). Without one the switch is refused and said
so (an "error" event; a risky step's card comes back). Answers from the phone (its own gate,
S11) and by voice (the owner's voice and a tap) don't come through here as the window's.

Window commands: code_touchid_proof {kind, proof}: armed for the next command of its kind;
code_touchid_ask {kind, lang}: the app that started this backend asks the owner (above).

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
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
DEFAULTS = "code_project_defaults"  # (code_sessions.py's: a project's own session defaults)
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

KINDS = ("bypass", "bypass-default", "approve", "touchid-off")
# A project's default set to Bypass just after everyone's was, with its proof (the composer's
# choice moves into the project's own defaults: code-sessions.js movedDefaults): one yes.
DEFAULT_GRACE_S = 30.0
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
    if a.get("touchid") is True:  # a card the backend marks itself (Exterminator Mode's landing)
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
    "touchid-off": "Turning off Touch ID for Bypass and risky steps needs your fingerprint (or "
    "the Eden app’s own confirmation) first, so it stayed on.",
}

lang.add_texts(
    {
        NEEDS["bypass"]: "绕过权限需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。",
        NEEDS["bypass-default"]: (
            "让新会话以绕过权限开始需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。"
        ),
        NEEDS["approve"]: "这一步需要先验证你的指纹（或 Eden 应用自己的确认）；它仍在等你回答。",
        NEEDS["touchid-off"]: (
            "关闭“绕过权限和有风险步骤需要触控 ID”需要先验证你的指纹（或 Eden 应用自己的确认），"
            "所以它仍然开着。"
        ),
    }
)


class Gate:
    """The window's switches into Bypass and its risky approvals, each with its proof."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.armed: dict[str, str] = {}  # kind -> the proof the window sent for it, unused
        self.default_proven = -DEFAULT_GRACE_S  # when new sessions were last set to Bypass, proved
        self.loop: Any = None  # the hub's loop, for the pipe's answers (code_touchid_ask)

    def key(self) -> str:
        """The proof key the app gave on its own pipe (proof_pipe.py); "" without one."""
        pipe = getattr(self.hub, "proof_pipe", None)
        return str(getattr(pipe, "key", "") or "")

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
        return check_proof(self.key(), self.armed.pop(kind, ""), kind)

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

    def default_mode(self, msg: dict[str, Any]) -> str:
        """The mode a new session in msg's folder starts in when msg names none: its
        project's own default, else everyone's (each needed a proof to be set to Bypass)."""
        try:
            own = self.hub.tasks.defaults_for(
                str(msg.get("directory") or ""), str(msg.get("session_id") or "")
            )
        except Exception:
            own = {}
        return str(own.get("mode") or self.hub.prefs.code_mode or "ask")

    def on_new(self, msg: dict[str, Any]) -> bool:
        if msg.get("mode") != "auto" or not self.needed():
            return False
        if self.default_mode(msg) == "auto" or self.take("bypass"):
            return False  # (it would start in Bypass without the mode named: proved when set)
        self.refuse("bypass")
        msg["mode"] = "ask"  # it starts all the same, in Manual
        return False

    def proven_default(self) -> bool:
        """A proof that new sessions may start in Bypass (the composer with no session open
        asks as it does for a session's: either kind does)."""
        if self.take("bypass-default") or self.take("bypass"):
            self.default_proven = time.monotonic()
            return True
        return False

    def guard_mode(self, changes: dict[str, Any]) -> None:
        """code_mode "auto" in a settings change, kept only with its proof."""
        if changes.get("code_mode") == "auto" and self.needed():
            if self.hub.prefs.code_mode != "auto" and not self.proven_default():
                self.refuse("bypass-default")
                changes.pop("code_mode")  # the rest of the change goes as it came

    def on_defaults(self, msg: dict[str, Any]) -> bool:
        self.guard_mode(msg)
        return False

    def on_set_prefs(self, msg: dict[str, Any]) -> bool:
        """Settings' own set_prefs: code_mode "auto" there is new sessions in Bypass too (A4)."""
        changes = msg.get("changes")
        if isinstance(changes, dict):
            self.guard_mode(changes)
        return False

    def on_features(self, msg: dict[str, Any]) -> bool:
        """feature_prefs: this setting off (A3), and a project's default mode set to Bypass
        (A4), each only with its proof; the rest of the change goes as it came."""
        changes = msg.get("changes")
        if not isinstance(changes, dict) or not self.needed():
            return False
        if changes.get(PREF) is False and self.hub.prefs.feature(PREF) is not False:
            if not self.take("touchid-off"):
                self.refuse("touchid-off")
                changes.pop(PREF)
        wanted = changes.get(DEFAULTS)
        if not isinstance(wanted, dict):
            return False
        before = self.hub.prefs.feature(DEFAULTS)
        before = before if isinstance(before, dict) else {}
        was = {p: own.get("mode") for p, own in before.items() if isinstance(own, dict)}
        newly = [
            path
            for path, own in wanted.items()
            if isinstance(own, dict) and own.get("mode") == "auto" and was.get(path) != "auto"
        ]
        recent = time.monotonic() - self.default_proven < DEFAULT_GRACE_S
        if newly and not recent and not self.proven_default():
            self.refuse("bypass-default")
            kept = dict(wanted)
            for path in newly:
                own = {k: v for k, v in kept[path].items() if k != "mode"}
                if was.get(path):
                    own["mode"] = was[path]  # as it was
                kept[path] = own
            changes[DEFAULTS] = kept
        return False

    # ── the other app's window: asked through the app that started this backend ──

    def on_ask(self, msg: dict[str, Any]) -> None:
        kind = msg.get("kind")
        pipe = getattr(self.hub, "proof_pipe", None)
        if kind not in KINDS:
            return
        if pipe is None or not pipe.ask(kind, "zh" if msg.get("lang") == "zh" else "en"):
            self.hub.emit("code_touchid_answer", proof_kind=kind, ok=False, unavailable=True)
            return
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = None
        pipe.listen(self.heard)

    def heard(self, line: str) -> None:
        """A line on the app's pipe (on the pipe's own thread): its answer to an ask."""
        from .. import proof_pipe

        found = proof_pipe.parse_answer(line)
        if found is None or found[0] not in KINDS:
            return
        if self.loop is None:
            self.answer(*found)
        else:
            self.loop.call_soon_threadsafe(self.answer, *found)

    def answer(self, kind: str, proof: str) -> None:
        ok = 0 < len(proof) < 200
        if ok:
            self.armed[kind] = proof  # (checked as the window's are, when it's used)
        self.hub.emit("code_touchid_answer", proof_kind=kind, ok=ok)

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
    hub.register_command("code_touchid_ask", gate.on_ask)
    hub.register_command("set_prefs", gate.on_set_prefs)
    hub.register_command("feature_prefs", gate.on_features)
    hub.register_command("task_mode", gate.on_mode)
    hub.register_command("task_new", gate.on_new)
    hub.register_command("code_defaults", gate.on_defaults)
    hub.register_command("approve", gate.on_approve)
