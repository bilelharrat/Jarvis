"""How Jarvis listens and speaks: Settings › Listening (and, later in this file, Speaking).

Listening
- Voice detection. Hands-free cuts the microphone's stream into utterances. "Neural" (the
  default) lets vad.py's Silero model say when someone is talking, so a door, the keyboard
  or a fan doesn't start one and a noisy room doesn't hold one open after you stop;
  "Loudness" is the detector from before. A sensitivity slider moves the model's
  threshold. If the model can't load, loudness decides and Settings says why.
- Wake words (wakewords.py): "Jarvis", the persona's own name, and any the owner adds;
  wake.py hears them (configured here), "Jarvis" anywhere, the others when called.

The window side is web/features/voice.js (+ .css), its Chinese web/i18n/voice.json.

Commands: voice_status (the pane's state, as a "voice" event) and voice_settings
({"changes": {...}}: the pane's settings, checked here, kept in prefs.features).

Cost policy: nothing here calls a model or the network. The voice model is local
(onnxruntime, about 0.2 ms of CPU per 32 ms of audio while hands-free listens).
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from typing import Any

from .. import prefs as prefs_module
from .. import vad, wake, wakewords

log = logging.getLogger("jarvis")

DETECTORS = ("neural", "energy")


def _clean_detector(value: Any) -> str | None:
    return value if value in DETECTORS else None


prefs_module.register_feature_pref("voice_detector", "neural", _clean_detector)
prefs_module.register_feature_pref(
    "voice_vad_threshold", vad.DEFAULT_THRESHOLD, vad.clean_threshold
)
prefs_module.register_feature_pref("wake_words", wakewords.EMPTY, wakewords.clean_pref)

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
        }

    def emit(self) -> None:
        self.hub.emit("voice", **self.public())

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
        await self.status()
        self.wake_error = ""


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
    hub.register_command("voice_status", voice.status)
    hub.register_command("voice_settings", voice.settings)
