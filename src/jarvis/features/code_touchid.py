"""Touch ID for Eden Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, Touch ID itself switched off, a Bypass session taken out of
the sandbox, and a risky step allowed from its card ask for the owner's fingerprint (the
window asks: web/features/code-touchid.js, through the app's own app/features/touchid.js),
or, where there's no Touch ID, the app's own question (a native dialog the page can't
answer).

The backend holds the line, not only the window (bug sweep r1, CD4/CD5): every way into
Bypass (task_mode, task_new, the defaults and a project's own, the settings, "/bypass" and
"full auto" by voice, best of N) and switching code_touchid off needs a fresh proof from
the app, while code_touchid is on (the default).

- The proof: once the fingerprint (or the native dialog) says yes, the app's main process
  signs "<kind>|<ts>|<nonce>" with the key in touchid.key (HMAC-SHA256), in the data folder,
  readable by this user only and never sent to a window or a session (tasks.data_target
  keeps sessions out of it). The window passes it on ({"type": "touchid_proof", kind, ts,
  nonce, sig}) just before the step it's for; a page or a socket client has no key, so it
  can't make one. Each proof is good once, within PROOF_SECONDS of when it was made; the
  grant it gives is good once, for GRANT_SECONDS.
- Without a proof the step is refused, said in the session (or as an error), and the window
  is asked (code_touchid_ask {need, id?}): it asks for the fingerprint and does it then.
- The phone never gets one (no Face ID-backed proof yet): Bypass from the phone is refused,
  whatever the setting.

Its setting: code_touchid (on by default), in Eden Code settings › General.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

from .. import prefs

log = logging.getLogger("jarvis")

PREF = "code_touchid"
prefs.register_feature_pref(PREF, True)

KEY_FILE = "touchid.key"  # (app/features/touchid.js reads it from the same data folder)
KINDS = ("bypass", "bypass-default", "touchid-off", "sandbox-off")
PROOF_SECONDS = 120  # how old (or how far ahead) a proof's time may be
GRANT_SECONDS = 30  # how long what a proof allows waits to be used
_NONCE = re.compile(r"^[0-9a-f]{16,64}$")
_SIG = re.compile(r"^[0-9a-f]{64}$")

# What's said when a step needs the fingerprint first (the window's Chinese:
# web/i18n/code-touchid.json).
NEEDS = {
    "bypass": "Bypass permissions needs your fingerprint on the Mac first.",
    "bypass-default": "Starting sessions in Bypass permissions needs your fingerprint on the Mac first.",
    "touchid-off": "Turning off Touch ID for Eden Code needs your fingerprint on the Mac first.",
    "sandbox-off": "Taking a Bypass session out of the sandbox needs your fingerprint on the Mac first.",
}
FROM_PHONE = "Bypass permissions can't be turned on from the phone: switch to it on the Mac."


def from_phone() -> bool:
    """Whether the step being handled is a phone's request (companion_code)."""
    with contextlib.suppress(Exception):
        from ..companion_code import from_phone as asked_by_phone

        return asked_by_phone()
    return False


def sign(key: bytes, kind: str, ts: int, nonce: str) -> str:
    """What app/features/touchid.js signs (and the tests)."""
    return hmac.new(key, f"{kind}|{ts}|{nonce}".encode(), hashlib.sha256).hexdigest()


class TouchGate:
    """One hub's proofs and what they allow."""

    def __init__(self, hub: Any, path: Path | None = None) -> None:
        self.hub = hub
        self.path = path or hub.feature_path(KEY_FILE)
        self._key: bytes | None = None
        self.grants: dict[str, list[float]] = {}  # kind -> when each grant runs out
        self.used: dict[str, float] = {}  # nonce -> when it could no longer be used anyway

    # ── the key ──

    def key(self) -> bytes | None:
        """The shared key, made (user-only) the first time. None when it can't be had."""
        if self._key is not None:
            return self._key
        try:
            text = self.path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            text = ""
        except OSError:
            log.warning("Touch ID: the proof key can't be read")
            return None
        if not re.fullmatch(r"[0-9a-f]{64}", text):
            text = secrets.token_hex(32)
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="ascii") as out:
                    out.write(text)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except OSError:
                log.warning("Touch ID: the proof key can't be saved")
                return None
        self._key = text.encode("ascii")
        return self._key

    # ── proofs and grants ──

    def required(self) -> bool:
        return self.hub.prefs.feature(PREF) is not False

    def _prune(self, now: float) -> None:
        for kind in list(self.grants):
            self.grants[kind] = [t for t in self.grants[kind] if t > now]
        for nonce in [n for n, t in self.used.items() if t <= now]:
            del self.used[nonce]

    def present(self, msg: dict[str, Any]) -> bool:
        """The window's {"type": "touchid_proof", kind, ts, nonce, sig}: a grant for its
        kind when the app signed it, it's fresh, and it wasn't used before."""
        if from_phone():
            return False
        kind, nonce, sig = (
            str(msg.get("kind", "")),
            str(msg.get("nonce", "")),
            str(msg.get("sig", "")),
        )
        ts = msg.get("ts")
        if kind not in KINDS or not _NONCE.match(nonce) or not _SIG.match(sig):
            return False
        if not isinstance(ts, int) or isinstance(ts, bool) or abs(time.time() - ts) > PROOF_SECONDS:
            return False
        key = self.key()
        if key is None or not hmac.compare_digest(sign(key, kind, ts, nonce), sig):
            log.warning("Touch ID: a proof that isn't the app's was refused")
            return False
        now = time.monotonic()
        self._prune(now)
        if nonce in self.used:
            return False
        self.used[nonce] = now + 2 * PROOF_SECONDS
        self.grants.setdefault(kind, []).append(now + GRANT_SECONDS)
        return True

    def allow(self, kind: str) -> bool:
        """Whether a step of this kind may go ahead now: never from the phone; always with
        Touch ID switched off; else once per grant."""
        if from_phone():
            return False
        if not self.required():
            return True
        now = time.monotonic()
        self._prune(now)
        waiting = self.grants.get(kind) or []
        if not waiting:
            return False
        waiting.pop(0)
        return True

    def refuse(self, kind: str, task_id: int | None = None) -> str:
        """Says why a step was refused, and asks the window to ask (not the phone)."""
        if from_phone():
            return FROM_PHONE
        text = NEEDS.get(kind, NEEDS["bypass"])
        info: dict[str, Any] = {"need": kind}
        if task_id is not None:
            info["id"] = task_id
        self.hub.emit_to_caller("code_touchid_ask", **info)  # (CA3-8) the window that asked
        return text

    # ── window commands and the settings ──

    def cmd_proof(self, msg: dict[str, Any]) -> None:
        self.present(msg)

    def _task(self, msg: dict[str, Any]) -> Any:
        try:
            return self.hub.tasks.tasks.get(int(msg.get("id")))
        except (TypeError, ValueError, OverflowError):
            return None

    def cmd_task_mode(self, msg: dict[str, Any]) -> Any:
        """task_mode into Bypass needs a grant; anything else goes on to the hub's own."""
        task = self._task(msg)
        if msg.get("mode") != "auto" or task is None or task.mode == "auto":
            return False
        if self.allow("bypass"):
            return False
        why = self.refuse("bypass", task.id)
        self.hub.tasks._log(task, "system", why)
        self.hub.emit("error", text=why)
        return None

    def cmd_task_new(self, msg: dict[str, Any]) -> Any:
        """A new session asked for in Bypass needs a grant; one that starts in it because the
        owner's own default says so goes on (that default took a fingerprint), but never
        from the phone."""
        mode = msg.get("mode")
        if mode is None or mode == "":
            if not from_phone():
                return False
            own: dict[str, Any] = {}
            with contextlib.suppress(Exception):
                own = self.hub.tasks.defaults_for(
                    str(msg.get("directory", "")), str(msg.get("session_id", ""))
                )
            mode = own.get("mode") or self.hub.prefs.code_mode or "ask"
            if mode != "auto":
                return False
            self.hub.emit("error", text=FROM_PHONE)
            return None
        if mode != "auto" or self.allow("bypass"):
            return False
        self.hub.emit("error", text=self.refuse("bypass"))
        return None

    def guard_prefs(self, changes: Any) -> Any:
        """Settings changes, less the ones that need a fingerprint and haven't one: new
        sessions into Bypass (everyone's, or a project's) and Touch ID itself off."""
        if not isinstance(changes, dict):
            return changes
        p = self.hub.prefs
        out = dict(changes)
        refused: list[str] = []
        if out.get("code_mode") == "auto" and p.code_mode != "auto":
            if not self.allow("bypass-default"):
                out.pop("code_mode")
                refused.append("bypass-default")
        features = out.get("features")
        if isinstance(features, dict):
            features = dict(features)
            if features.get(PREF) is False and p.feature(PREF) is not False:
                if not self.allow("touchid-off"):
                    features.pop(PREF)
                    refused.append("touchid-off")
            if "code_project_defaults" in features:
                features = self._guard_projects(features, refused)
            out["features"] = features
        for kind in dict.fromkeys(refused):
            self.hub.emit("error", text=self.refuse(kind))
        return out

    def _guard_projects(self, features: dict[str, Any], refused: list[str]) -> dict[str, Any]:
        new = features.get("code_project_defaults")
        old = self.hub.prefs.feature("code_project_defaults")
        old = old if isinstance(old, dict) else {}
        if not isinstance(new, dict) or self.hub.prefs.code_mode == "auto":
            return features  # (everyone's starts in Bypass already: a project's adds nothing)
        into = [
            path
            for path, own in new.items()
            if isinstance(own, dict)
            and own.get("mode") == "auto"
            and not (isinstance(old.get(path), dict) and old[path].get("mode") == "auto")
        ]
        if not into or self.allow("bypass-default"):
            return features
        kept = {}
        for path, own in new.items():
            if path in into:
                was = old.get(path) if isinstance(old.get(path), dict) else {}
                own = {k: v for k, v in own.items() if k != "mode"}
                if was.get("mode"):
                    own["mode"] = was["mode"]
                if not own:
                    continue
            kept[path] = own
        refused.append("bypass-default")
        return {**features, "code_project_defaults": kept}


def install(hub: Any) -> None:
    gate = TouchGate(hub)
    hub.touch_gate = gate  # (voice coding, best of N, the sandbox and the tests ask it)
    gate.key()  # made now, so the app finds it when it first signs
    # Eden's data folder (the hub's, beside prefs.json) stays out of every session's reach.
    data = hub.feature_path("x").parent
    if data not in hub.tasks.data_dirs:
        hub.tasks.data_dirs.append(data)
    hub.register_command("touchid_proof", gate.cmd_proof)
    hub.register_command("task_mode", gate.cmd_task_mode)
    hub.register_command("task_new", gate.cmd_task_new)
    # Every change of the settings (the window's, the phone's, a tool's, a sync's) passes
    # the guard first: hub.set_prefs is the one way they're changed.
    set_prefs = hub.set_prefs

    def guarded(changes: Any, *args: Any, **kwargs: Any) -> Any:
        return set_prefs(gate.guard_prefs(changes), *args, **kwargs)

    hub.set_prefs = guarded
