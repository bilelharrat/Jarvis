"""How Jarvis listens and speaks: Settings › Listening and Settings › Speaking.

Listening
- Voice detection. Hands-free cuts the microphone's stream into utterances. "Neural" (the
  default) lets vad.py's Silero model say when someone is talking, so a door, the keyboard
  or a fan doesn't start one and a noisy room doesn't hold one open after you stop;
  "Loudness" is the detector from before. A sensitivity slider moves the model's
  threshold. If the model can't load, loudness decides and Settings says why.
- Wake words (wakewords.py): "Jarvis", the persona's own name, and any the owner adds;
  wake.py hears them (configured here), "Jarvis" anywhere, the others when called.

Speaking (speaking.py): the provider (Mac, ElevenLabs, Fish Audio; .env's until picked
here), the voice, API keys (Keychain), model, speed and a preview; mute is remembered
across restarts; a failed cloud voice falls back to the best Enhanced or Premium Mac voice.

The window side is web/features/voice.js (+ .css), its Chinese web/i18n/voice.json.

Commands: voice_status (the pane's state, as a "voice" event), voice_settings ({"changes":
{...}}: the pane's settings, checked here, kept in prefs.features), voice_list
({"provider"}), voice_preview ({"provider", "voice"}), voice_key ({"provider", "key"}: to
the Keychain) and voice_key_forget ({"provider"}).

Cost policy: no Claude model is called here. The voice detector is local (onnxruntime,
about 0.2 ms of CPU per 32 ms of audio while hands-free listens). Listing cloud voices
(free) and a preview (one short sentence of TTS) happen only when the owner presses them.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from typing import Any

from .. import prefs as prefs_module
from .. import vad, wake, wakewords
from ..speaking import PREFS as SPEAKING_PREFS
from ..speaking import Speaking

log = logging.getLogger("jarvis")

DETECTORS = ("neural", "energy")


def _clean_detector(value: Any) -> str | None:
    return value if value in DETECTORS else None


prefs_module.register_feature_pref("voice_detector", "neural", _clean_detector)
prefs_module.register_feature_pref(
    "voice_vad_threshold", vad.DEFAULT_THRESHOLD, vad.clean_threshold
)
prefs_module.register_feature_pref("wake_words", wakewords.EMPTY, wakewords.clean_pref)
for _key, (_default, _clean) in SPEAKING_PREFS.items():
    prefs_module.register_feature_pref(_key, _default, _clean)

# The settings voice_settings may change (and nothing else of prefs.features).
SETTINGS = ("voice_detector", "voice_vad_threshold")

_FEATURES: weakref.WeakKeyDictionary[Any, Voice] = weakref.WeakKeyDictionary()


def feature_for(hub: Any) -> Voice | None:
    """The voice feature installed on this hub (for tests and the other voice modules)."""
    return _FEATURES.get(hub)


class Voice:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.listener: Any = None  # the hands-free listener made last (reopened on changes)
        self.model_checked = False
        self.wake_error = ""  # why the last wake word change didn't happen (shown once)
        self.speaking = Speaking(hub)

    # ── hands-free listening ──

    def make_listener(self, on_utterance: Any, on_level: Any = None, silence_seconds: float = 0.9):
        """The hub's listener factory: the usual hands-free listener, with the voice
        detector chosen here, on the microphone chosen in Settings."""
        from ..listen import ContinuousListener

        listener = ContinuousListener(
            on_utterance, on_level, silence_seconds, getattr(self.hub.prefs, "mic", "builtin")
        )
        listener.voice_factory = self.voice_detector
        self.listener = listener
        return listener

    def voice_detector(self) -> vad.VoiceGate | None:
        """A detector for a stream about to open (on the microphone's thread): the neural
        one when chosen and it loads, else None (loudness)."""
        if self.hub.prefs.feature("voice_detector") != "neural":
            return None
        return vad.make_gate(lambda: self.hub.prefs.feature("voice_vad_threshold"))

    def _reopen_listener(self) -> None:
        listener = self.listener
        if listener is not None and getattr(listener, "running", False):
            listener.reopen()

    # ── the pane ──

    def public(self) -> dict[str, Any]:
        detector = self.hub.prefs.feature("voice_detector")
        why = vad.unavailable_reason()
        return {
            "detector": detector,
            "threshold": self.hub.prefs.feature("voice_vad_threshold"),
            # None until the model has been tried (the pane asks for it to be)
            "neural_ok": (not why) if (self.model_checked or why) else None,
            "neural_why": why,
            "wake_words": wakewords.of(self.hub.prefs),
            "wake_error": self.wake_error,
            "muted": bool(getattr(self.hub.speaker, "muted", False)),
            "effect": bool(getattr(self.hub.prefs, "voice_effect", False)),
            **self.speaking.public(),
        }

    def emit(self) -> None:
        """The pane's state; a problem it shows is shown once."""
        self.hub.emit("voice", **self.public())
        self.speaking.error = ""

    async def status(self, _msg: dict[str, Any] | None = None) -> None:
        if not self.model_checked:
            await asyncio.to_thread(_try_model)
            self.model_checked = True
        self.emit()

    async def settings(self, msg: dict[str, Any]) -> None:
        changes = msg.get("changes")
        if not isinstance(changes, dict):
            return
        wanted = {k: v for k, v in changes.items() if k in SETTINGS}
        before = {k: self.hub.prefs.feature(k) for k in SETTINGS}
        if wanted:
            self.hub.set_feature_prefs(wanted)
        after = {k: self.hub.prefs.feature(k) for k in SETTINGS}
        if before["voice_detector"] != after["voice_detector"]:
            log.info("voice detection: %s", after["voice_detector"])
            self._reopen_listener()  # the new detector from the next block on
        self.wake_error = ""
        for key, change in (("wake_add", wakewords.add), ("wake_remove", wakewords.remove)):
            if key in changes:
                kept, self.wake_error = change(self.hub.prefs, changes[key])
                if kept is not None:
                    self.hub.set_feature_prefs({"wake_words": kept})
        if self.speaking.change(changes):
            await self.speaking.apply()
        await self.status()
        self.wake_error = ""

    async def list_voices(self, msg: dict[str, Any]) -> None:
        self.emit_busy("list")
        try:
            await self.speaking.list(str(msg.get("provider") or ""))
        finally:
            self.speaking.busy = ""
        await self.status()

    async def preview(self, msg: dict[str, Any]) -> None:
        self.emit_busy("preview")
        try:
            await self.speaking.preview(str(msg.get("provider") or ""), msg.get("voice"))
        finally:
            self.speaking.busy = ""
        await self.status()

    async def set_key(self, msg: dict[str, Any]) -> None:
        await self.speaking.set_key(str(msg.get("provider") or ""), msg.get("key"))
        await self.status()

    async def forget_key(self, msg: dict[str, Any]) -> None:
        await self.speaking.forget_key(str(msg.get("provider") or ""))
        await self.status()

    def emit_busy(self, what: str) -> None:
        self.speaking.busy = what
        self.emit()


def _try_model() -> None:
    try:
        vad.load_session()
    except vad.Unavailable:
        pass  # unavailable_reason() now says why


def _wake_source(prefs: Any):
    """wake.py's source of wake words: these settings, read at each check (a persona or
    language change applies at once). Held weakly: a hub that's gone leaves "Jarvis"."""
    ref = weakref.ref(prefs)

    def words() -> list[str]:
        current = ref()
        return wakewords.of(current) if current is not None else []

    return words


def install(hub: Any) -> None:
    voice = Voice(hub)
    _FEATURES[hub] = voice
    wake.configure(_wake_source(hub.prefs))
    if hub.listener_factory is None:  # the app's own listener (a test's stays its own)
        hub.listener_factory = voice.make_listener
    # The Mac voice picked for each language, from now on and for this one.
    hub.mac_voice_for = voice.speaking.mac_voice_for
    hub._speak_language()
    if hub.prefs.feature("voice_muted"):  # muted when the app last quit
        hub.speaker.muted = True
    hub.register_loop("voice_setup", voice.speaking.setup)
    hub.register_command("voice_status", voice.status)
    hub.register_command("voice_settings", voice.settings)
    hub.register_command("voice_list", voice.list_voices)
    hub.register_command("voice_preview", voice.preview)
    hub.register_command("voice_key", voice.set_key)
    hub.register_command("voice_key_forget", voice.forget_key)
