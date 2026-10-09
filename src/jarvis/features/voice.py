"""How Jarvis listens and speaks: Settings › Listening and Settings › Speaking.

Listening
- Voice detection. Hands-free cuts the microphone's stream into utterances. "Neural" (the
  default) lets vad.py's Silero model say when someone is talking, so a door, the keyboard
  or a fan doesn't start one and a noisy room doesn't hold one open after you stop;
  "Loudness" is the detector from before. A sensitivity slider moves the model's
  threshold. If the model can't load, loudness decides and Settings says why.
- Wake words (wakewords.py): "Jarvis", the persona's own name, and any the owner adds;
  wake.py hears them (configured here), "Jarvis" anywhere, the others when called.
- Talk over Jarvis (duplex.py, on by default): while hands-free listens, JARVIS's voice and
  the microphone go through the Mac's echo cancellation, so talking over a reply
  interrupts it without the wake word. Anything in the way (AirPods as the Mac's input, no
  voice processing) falls back to the usual microphone, and the pane says why.
- Speech recognition: Whisper (the default), or Apple's on-device recognizer (stt_apple.py),
  which hears utterances as they're said: live captions, the wake word spotted before you
  finish, and the words ready about 0.2 s after you stop (hub.heard_live), on the Neural
  Engine. Its model downloads (from Apple, by macOS) only when the owner presses Download.

Speaking (speaking.py): the provider (Mac, ElevenLabs, Fish Audio; .env's until picked
here), the voice, API keys (Keychain), model, speed and a preview; mute is remembered
across restarts; a failed cloud voice falls back to the best Enhanced or Premium Mac voice.

The window side is web/features/voice.js (+ .css), its Chinese web/i18n/voice.json.

Commands: voice_status (the pane's state, as a "voice" event), voice_settings ({"changes":
{...}}: the pane's settings, checked here, kept in prefs.features), voice_list
({"provider"}), voice_preview ({"provider", "voice"}), voice_key ({"provider", "key"}: to
the Keychain), voice_key_forget ({"provider"}) and voice_engine_download. Live captions go
to the window as "voice_live" events ({"text", "final"}).

Cost policy: no Claude model is called here. The voice detector is local (onnxruntime,
about 0.2 ms of CPU per 32 ms of audio while hands-free listens). Listing cloud voices
(free) and a preview (one short sentence of TTS) happen only when the owner presses them.
"""

from __future__ import annotations

import re

import asyncio
import logging
import weakref
from typing import Any

from .. import prefs as prefs_module
from .. import vad, wake, wakewords
from ..duplex import Duplex
from ..speaking import PREFS as SPEAKING_PREFS
from ..speaking import Speaking
from ..stt_apple import LiveEars

log = logging.getLogger("jarvis")

DETECTORS = ("neural", "energy")
ENGINES = ("whisper", "apple")


def _clean_detector(value: Any) -> str | None:
    return value if value in DETECTORS else None


prefs_module.register_feature_pref("voice_detector", "neural", _clean_detector)
prefs_module.register_feature_pref(
    "voice_vad_threshold", vad.DEFAULT_THRESHOLD, vad.clean_threshold
)
prefs_module.register_feature_pref("wake_words", wakewords.EMPTY, wakewords.clean_pref)
prefs_module.register_feature_pref("voice_engine", "whisper", lambda v: v if v in ENGINES else None)
# Off until the owner has tried it on this Mac: the echo-cancelling helper is new, and
# voice processing can lower other apps' sound while it listens (Settings › Listening).
prefs_module.register_feature_pref("voice_talk_over", False)
for _key, (_default, _clean) in SPEAKING_PREFS.items():
    prefs_module.register_feature_pref(_key, _default, _clean)

# The settings voice_settings may change (and nothing else of prefs.features).
SETTINGS = ("voice_detector", "voice_vad_threshold", "voice_engine", "voice_talk_over")


def feature_for(hub: Any) -> Voice | None:
    """The voice feature installed on this hub (for tests and the other voice modules)."""
    return getattr(hub, "voice_feature", None)


class Voice:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.listener: Any = None  # the hands-free listener made last (reopened on changes)
        self.model_checked = False
        self.wake_error = ""  # why the last wake word change didn't happen (shown once)
        self.speaking = Speaking(hub)
        self.ears = LiveEars(hub, on_change=self.emit)
        self.duplex = Duplex(hub, on_change=self.emit)

    # ── hands-free listening ──

    def make_listener(self, on_utterance: Any, on_level: Any = None, silence_seconds: float = 0.9):
        """The hub's listener factory: the usual hands-free listener, with the voice
        detector chosen here, on the microphone chosen in Settings."""
        from ..listen import ContinuousListener

        listener = ContinuousListener(
            on_utterance, on_level, silence_seconds, getattr(self.hub.prefs, "mic", "builtin")
        )
        listener.voice_factory = self.voice_detector
        listener.on_block = self._tap
        listener.source = self.duplex.source  # the echo-cancelled microphone, when it's on
        guard = getattr(self.hub, "voice_guard", None)  # features/voice_id.py's look-ahead
        if guard is not None:
            guard.attach(listener)
        self.listener = listener
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return listener  # made outside the app's loop (a test): nothing to start
        self.hub._spawn(self.duplex.refresh())  # hands-free is starting: talk-over too
        return listener

    def _tap(self, block: Any, speaking: bool) -> None:
        """Each hands-free block: to Apple's recognizer (when it's the one chosen), and
        whether someone's talking to talk-over (JARVIS's voice ducks for them)."""
        self.ears.tap(block, speaking)
        self.duplex.heard(speaking)

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
            "engine": self.hub.prefs.feature("voice_engine"),
            "apple": self.ears.public(),
            "talk_over": bool(self.hub.prefs.feature("voice_talk_over")),
            "talk_over_state": self.duplex.public(),
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
        if before["voice_engine"] != after["voice_engine"]:
            log.info("speech recognition: %s", after["voice_engine"])
            self.hub._spawn(self.ears.refresh())  # seconds the first time: in the background
        if before["voice_talk_over"] != after["voice_talk_over"]:
            log.info("talk over Jarvis: %s", "on" if after["voice_talk_over"] else "off")
            self.duplex.reset()  # switched on again: one that failed is tried again
            self.hub._spawn(self.duplex.refresh())
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

    def persona_changed(self) -> None:
        """The persona in use changed, or its voice did: speak as it says from now on."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return  # (no loop: the next apply picks it up)
        self.hub._spawn(self.speaking.apply())

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

    async def download_engine(self, _msg: dict[str, Any]) -> None:
        self.hub._spawn(self.ears.download())

    async def start_ears(self) -> None:
        """At startup (the app only): onnxruntime kept off the network before anything
        loads it (vad.quiet_onnxruntime), then Apple's recognizer if it's the one chosen."""
        await asyncio.to_thread(vad.quiet_onnxruntime)
        if self.ears.wanted():
            await self.ears.refresh()

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


# "Talk faster", "slower", "normal speed", "speak at 150 percent": the speaking speed at once, without
# asking Claude (someone who listens all day changes it often). Steps of 20 points, within the range.
_FASTER = re.compile(r"^(?:please\s+)?(?:talk|speak|read|go)\s+(?:a\s+(?:little|bit)\s+|much\s+)?faster\W*$", re.I)
_SLOWER = re.compile(r"^(?:please\s+)?(?:talk|speak|read|go)\s+(?:a\s+(?:little|bit)\s+|much\s+)?(?:slower|more\s+slowly)\W*$", re.I)
_NORMAL = re.compile(r"^(?:(?:talk|speak|read)\s+(?:at\s+)?(?:normal|regular)(?:\s+(?:speed|pace))?|(?:normal|regular|default)\s+(?:speed|pace))\W*$", re.I)
_AT = re.compile(r"^(?:(?:talk|speak|read)\s+at|set\s+(?:the\s+|your\s+)?(?:speaking\s+|voice\s+)?speed\s+to)\s+(\d{2,3})\s*(?:%|percent)\W*$", re.I)


def speed_for(words: str, now: int) -> int | None:
    """The speaking speed (percent) these words ask for, or None when they don't ask for one."""
    from ..speaking import SPEED_DEFAULT, SPEED_MAX, SPEED_MIN

    text = " ".join(str(words or "").split())
    if _FASTER.match(text):
        wanted = now + (40 if "much" in text.lower() else 20)
    elif _SLOWER.match(text):
        wanted = now - (40 if "much" in text.lower() else 20)
    elif _NORMAL.match(text):
        wanted = SPEED_DEFAULT
    elif m := _AT.match(text):
        wanted = int(m.group(1))
    else:
        return None
    return max(SPEED_MIN, min(SPEED_MAX, wanted))


def install(hub: Any) -> None:
    voice = Voice(hub)
    # Kept on the hub, never in a map of this module's: one keyed weakly by the hub still
    # holds its feature, the feature holds the hub, and no hub would ever be freed.
    hub.voice_feature = voice
    wake.configure(_wake_source(hub.prefs))
    if hub.listener_factory is None:  # the app's own listener (a test's stays its own)
        hub.listener_factory = voice.make_listener
    # The Mac voice picked for each language, from now on and for this one.
    hub.mac_voice_for = voice.speaking.mac_voice_for
    hub._speak_language()
    if hub.prefs.feature("voice_muted"):  # muted when the app last quit
        hub.speaker.muted = True
    hub.heard_live = voice.ears.heard_live  # None from it: Whisper, as before
    hub.talk_over = voice.duplex.active
    hub.register_loop("voice_setup", voice.speaking.setup)
    # A persona of the owner's with a voice of its own speaks with it while it's in use.
    set_prefs = hub.set_prefs

    def set_prefs_then_voice(changes: dict[str, Any], from_tool: bool = False) -> list[str]:
        changed = set_prefs(changes, from_tool=from_tool)
        if "persona" in changed:
            voice.persona_changed()
        return changed

    hub.set_prefs = set_prefs_then_voice
    hub.register_loop("voice_ears", voice.start_ears)
    async def speed_now(words: str) -> str | None:
        now = voice.speaking.speed()
        wanted = speed_for(words, now)
        if wanted is None:
            return None
        voice.speaking.change({"voice_speed": wanted})
        await voice.speaking.apply(refresh=False)
        if wanted == now:
            from ..speaking import SPEED_MAX, SPEED_MIN

            edge = " That's as fast as I go." if now >= SPEED_MAX else " That's as slow as I go." if now <= SPEED_MIN else ""
            return f"I'm already speaking at {now} percent.{edge}"
        return f"Speaking at {wanted} percent."

    hub.register_instant(speed_now)

    async def read_typed(words: str) -> str | None:
        """"Read that back", "read the last line": what voice typing typed, answered at once.
        With nothing typed by voice, the words are Claude's (they may mean its last reply)."""
        from .. import voicetype

        which = voicetype.read_back_request(words)
        typing = getattr(hub, "voice_typing", None)
        if which is None or typing is None:
            return None
        typed = typing.read_back(which)
        if not typed:
            return None
        return f"The last line: {typed}" if which == "lastline" else f"You typed: {typed}"

    hub.register_instant(read_typed)
    hub.register_command("voice_status", voice.status)
    hub.register_command("voice_settings", voice.settings)
    hub.register_command("voice_list", voice.list_voices)
    hub.register_command("voice_preview", voice.preview)
    hub.register_command("voice_key", voice.set_key)
    hub.register_command("voice_key_forget", voice.forget_key)
    hub.register_command("voice_engine_download", voice.download_engine)
