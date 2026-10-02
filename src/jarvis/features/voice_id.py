"""Owner voice recognition: Settings › Listening › "Recognise my voice".

JARVIS learns the owner's voice (they read five short sentences: "Teach Jarvis your
voice") and, when this is on, checks each hands-free utterance against that voiceprint.
The scope setting says what someone else's voice may do:

- "Everything": anyone else is ignored (their request gets no answer at all);
- "Only risky actions" (the default): anyone may ask, but approvals, sends, purchases,
  deletes and Jarvis Code approvals need the owner's voice. Their words don't count as the
  owner's own, so every gate asks first, and a spoken "yes" to a card from them isn't taken.

A voice the check is unsure of (between the owner's threshold and the "someone else" bar,
voiceprint.py) is answered in both scopes, but its words aren't the owner's for a risky
step: the owner from across the room, or through the echo-cancelled microphone, is never
left unanswered.

Tapping the orb, ⌥Space and typed requests are never checked.

No added latency: the hub starts a check (voiceprint.py's embedding, in a thread) as soon
as an utterance's audio arrives, beside its transcription, and awaits it only where JARVIS
would answer, act or take a spoken approval (hub._voice_allows, _settle_turn_voice). A
check that fails, times out, or has too little speech allows, as before.

Fallbacks: off, no model downloaded, not enrolled, or a model that won't load: nothing is
checked (hands-free behaves exactly as before) and the pane says once why.

Files (beside prefs.json): voice_id/voiceprint.json (the owner's embedding, 0600, no
backup copy) and voice_id/speaker.onnx (the model, downloaded only when the owner presses
Download after turning this on, its size shown first; its checksum is checked).

Commands: voice_id_status, voice_id_settings ({"changes": {voice_id_on, voice_id_scope}}),
voice_id_download, voice_id_enroll ({"action": "start" | "cancel"}), voice_id_forget.
Event: "voice_id" (the pane's state).

Cost policy: no Claude model is called here. The embedding is a local ONNX model (tens of
milliseconds of CPU per utterance while hands-free listens, only when this is on and a
voiceprint exists).
"""

from __future__ import annotations

import asyncio
import functools
import logging
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

from .. import lang, voiceprint
from .. import prefs as prefs_module

log = logging.getLogger("jarvis")

SCOPES = ("all", "risky")
SENTENCES = 5  # the window shows them (web/features/voice_id.js), in the owner's language
ENROLL_SILENCE = 1.0  # a sentence ends after this much quiet
ENROLL_MIN_SECONDS = 1.0
ENROLL_TRIES = 3  # per sentence, before it gives up
CHECK_WAIT = 2.0  # a check this late (a busy Mac) allows, as before
# While someone talks, a look-ahead check of what they've said so far runs every this many
# seconds of new audio, so the verdict is ready when the utterance ends, even when its
# words are too (Apple's live recognizer). Only over its first LOOK_SECONDS (who spoke
# shows early) and never while the last look is still running: a busy room or a TV used
# to start a check every half second of every utterance, on the threads transcription
# needs too.
LOOK_AHEAD = 0.5
LOOK_SECONDS = 3.0
MAX_BUFFER = voiceprint.MAX_CHECK_SECONDS  # seconds of one utterance kept for look-aheads
FOLDER = "voice_id"

# A verdict between the owner's threshold and REJECT (voiceprint.py): answered, but not
# the owner's word for a risky step.
UNSURE = voiceprint.UNSURE

# Checks run on a thread of their own, one at a time: they never wait behind other work
# (a transcription, the file index) and never hold it up.
_CHECKS = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jarvis-voice-check")

REFUSED = "Sorry, only the owner's voice can approve that."
lang.add_texts({REFUSED: "抱歉，只有主人的声音才能批准这个。"})

prefs_module.register_feature_pref("voice_id_on", False)
prefs_module.register_feature_pref("voice_id_scope", "risky", lambda v: v if v in SCOPES else None)


def guard_for(hub: Any) -> VoiceGuard | None:
    return getattr(hub, "voice_guard", None)


class VoiceGuard:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.print: voiceprint.Voiceprint | None = None
        self.embedder: Any = None  # audio -> unit embedding (None: not loaded)
        self.embedder_factory: Any = voiceprint.OnnxEmbedder  # tests pass a fake
        self.fetch: Any = None  # the download's fetcher (tests pass a fake)
        self.model: dict[str, Any] = voiceprint.SPEAKER_MODEL
        self.loaded = False  # the voiceprint and model have been looked for
        self.load_error = ""
        self._loading: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._heard: list[Any] = []  # the utterance so far (the microphone's thread)
        self._heard_size, self._heard_began, self._looked = 0, 0.0, 0
        self._looking: asyncio.Future | None = None  # the look-ahead still running
        self._next_look: tuple[Any, float] | None = None  # the newest one waiting for it
        self._ahead: deque[tuple[float, float, asyncio.Future]] = deque(maxlen=4)
        self.downloading: dict[str, int] | None = None
        self.enrolling: dict[str, Any] | None = None
        self._enroll_cancel: threading.Event | None = None
        self.error = ""  # a problem to show once

    # ── files ──

    @property
    def print_path(self) -> Path:
        return self.hub.feature_path(f"{FOLDER}/voiceprint.json")

    @property
    def model_path(self) -> Path:
        return self.hub.feature_path(f"{FOLDER}/{voiceprint.MODEL_FILE}")

    def on(self) -> bool:
        return bool(self.hub.prefs.feature("voice_id_on"))

    def scope(self) -> str:
        return self.hub.prefs.feature("voice_id_scope")

    def configured(self) -> bool:
        return bool(self.model.get("url")) and len(str(self.model.get("sha256") or "")) == 64

    def _load(self) -> None:
        """In a thread: the voiceprint, and the model when it's there."""
        self.print = voiceprint.Voiceprint.load(self.print_path)
        self.load_error = ""
        if self.embedder is None and self.on() and self.model_path.is_file():
            try:
                self.embedder = self.embedder_factory(self.model_path)
            except Exception as exc:  # damaged, or onnxruntime can't run it
                self.load_error = str(exc)
                log.warning("voice recognition: %s", exc)
        self.loaded = True

    async def prepare(self) -> None:
        if self.loaded:
            return
        if self._loading is None or self._loading.done():
            self._loading = asyncio.ensure_future(asyncio.to_thread(self._load))
        await self._loading

    # ── the check (hub._start_voice_check / _voice_allows) ──

    def active(self) -> bool:
        return self.on() and self.print is not None and self.embedder is not None

    def start(self, audio: Any) -> asyncio.Future | None:
        """A hands-free utterance's check, running in a thread; None when there's nothing
        to check (off, not enrolled, no model, too short). Never waits for anything."""
        if not self.on():
            return None
        if not self.loaded:  # the first utterance since it was turned on: load for the next
            self.hub._spawn(self.prepare())
            return None
        length = voiceprint.seconds(audio)
        if not self.active() or length < voiceprint.MIN_SECONDS:
            return None
        began = time.monotonic() - length - 0.5
        # (less a block: a look covers whole microphone blocks)
        enough = max(voiceprint.MIN_SECONDS, min(length / 2, LOOK_SECONDS)) - 0.05
        for start, heard, check in reversed(self._ahead):
            # A look-ahead of this utterance that's done and heard enough of it (half of
            # it, or its first LOOK_SECONDS): its verdict.
            if (
                start >= began
                and heard >= enough
                and check.done()
                and not check.cancelled()
                and check.result() is not None
            ):
                return check
        return self._check(audio)

    def _check(self, audio: Any) -> asyncio.Future:
        loop = asyncio.get_running_loop()
        return asyncio.ensure_future(loop.run_in_executor(_CHECKS, self._verdict, audio))

    # ── look-ahead, while the utterance is still being said ──

    def attach(self, listener: Any) -> None:
        """Hear the hands-free microphone's blocks beside whoever already does."""
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        before = getattr(listener, "on_block", None)

        def tap(block: Any, speaking: bool) -> None:
            if before is not None:
                before(block, speaking)
            try:
                self.tap(block, speaking)
            except Exception:
                log.exception("voice recognition: the look-ahead failed")

        listener.on_block = tap

    def tap(self, block: Any, speaking: bool) -> None:
        """One block (the microphone's thread): kept while an utterance goes on, and a
        look-ahead check of it all started every LOOK_AHEAD seconds."""
        if not speaking or not self.active():
            self._heard, self._heard_size, self._looked = [], 0, 0
            return
        if self._heard_size >= LOOK_SECONDS * voiceprint.SAMPLE_RATE:
            return  # enough heard to tell who it is: the rest isn't looked at
        samples = np.array(block, dtype=np.float32).ravel()
        if not self._heard:
            self._heard_began = time.monotonic() - samples.size / voiceprint.SAMPLE_RATE
        if self._heard_size > MAX_BUFFER * voiceprint.SAMPLE_RATE:
            return
        self._heard.append(samples)
        self._heard_size += samples.size
        rate = voiceprint.SAMPLE_RATE
        last = self._heard_size >= LOOK_SECONDS * rate  # the last look: who it is, by now
        if (
            self._heard_size - self._looked >= LOOK_AHEAD * rate
            or (last and self._looked < self._heard_size)
        ) and (self._heard_size >= voiceprint.MIN_SECONDS * rate):
            self._looked = self._heard_size
            audio = np.concatenate(self._heard)
            if self._loop is not None:
                self._loop.call_soon_threadsafe(self._look_ahead, audio, self._heard_began)

    def _look_ahead(self, audio: Any, began: float) -> None:
        if self._looking is not None and not self._looking.done():
            # One look at a time: the newest waits for the running one (an older waiting
            # one is dropped), so a busy Mac never piles them up and the verdict on the
            # most speech heard is still the one ready when the utterance ends.
            self._next_look = (audio, began)
            return
        check = self._check(audio)
        self._looking = check
        self._ahead.append((began, voiceprint.seconds(audio), check))
        check.add_done_callback(lambda _done: self._look_next())

    def _look_next(self) -> None:
        waiting, self._next_look = self._next_look, None
        if waiting is not None:
            self._look_ahead(*waiting)

    def _verdict(self, audio: Any) -> bool | str | None:
        """True: the owner. False: someone else. UNSURE: between the bars (answered, not
        the owner's word for a risky step). None: can't tell (then it's allowed)."""
        embedder, owner = self.embedder, self.print
        if embedder is None or owner is None:
            return None
        cap = int(voiceprint.MAX_CHECK_SECONDS * voiceprint.SAMPLE_RATE)
        audio = audio[:cap] if getattr(audio, "size", 0) > cap else audio
        try:
            embedding = embedder(audio)
        except Exception:
            log.exception("voice recognition: the check failed")
            return None
        if embedding is None:
            return None
        score = owner.score(embedding)
        judged = owner.judge(score)
        who = {voiceprint.OWNER: "owner", UNSURE: "unsure", voiceprint.OTHER: "not the owner"}
        log.info(
            "voice check: %s (%.2f; owner from %.2f, someone else below %.2f)",
            who[judged],
            score,
            owner.threshold,
            min(voiceprint.REJECT, owner.threshold),
        )
        return {voiceprint.OWNER: True, voiceprint.OTHER: False}.get(judged, UNSURE)

    async def allows(self, check: Any, risky: bool = False) -> bool:
        try:
            same = await asyncio.wait_for(asyncio.shield(check), CHECK_WAIT)
        except Exception:  # timed out or failed: never blocks, never refuses
            log.warning("voice recognition: no verdict in time; allowed")
            return True
        if same is None or same is True:
            return True
        if same == UNSURE:  # probably the owner, further away or in another room
            return not risky
        return not (risky or self.scope() == "all")

    def refused(self) -> None:
        """Someone else answered a card by voice. "Only risky actions": they're told it
        needs the owner; "Everything": they're ignored, as everywhere else."""
        if self.scope() == "risky":
            self.hub.say(REFUSED, follow_up=False)

    # ── the pane ──

    def why_off(self) -> str:
        if not self.on():
            return ""
        if not self.model_path.is_file():
            if not self.configured():
                return "The voice model isn’t set up in this build, so voices aren’t checked."
            return "Download the voice model to turn this on. Until then, voices aren’t checked."
        if self.load_error:
            return "The voice model couldn’t load, so voices aren’t checked."
        if self.print is None:
            return "Teach Jarvis your voice to turn this on. Until then, voices aren’t checked."
        return ""

    def public(self) -> dict[str, Any]:
        owner = self.print
        return {
            "on": self.on(),
            "scope": self.scope(),
            "configured": self.configured(),
            "size": int(self.model.get("size") or 0),
            "model": self.model_path.is_file(),
            "enrolled": owner is not None,
            "clips": owner.clips if owner is not None else 0,
            "made": owner.made if owner is not None else 0,
            "downloading": self.downloading,
            "enrolling": self.enrolling,
            "sentences": SENTENCES,
            "why": self.why_off(),
            "error": self.error,
        }

    def emit(self) -> None:
        self.hub.emit("voice_id", **self.public())
        self.error = ""

    async def status(self, _msg: dict[str, Any] | None = None) -> None:
        await self.prepare()
        self.emit()

    async def settings(self, msg: dict[str, Any]) -> None:
        changes = msg.get("changes")
        if isinstance(changes, dict):
            wanted = {k: v for k, v in changes.items() if k in ("voice_id_on", "voice_id_scope")}
            if wanted:
                self.hub.set_feature_prefs(wanted)
                self.loaded = False  # turned on: the model loads now, for the next utterance
                log.info("voice recognition: %s, %s", "on" if self.on() else "off", self.scope())
        await self.status()

    # ── the model download ──

    async def download(self, _msg: dict[str, Any] | None = None) -> None:
        if self.downloading is not None or not self.on() or self.model_path.is_file():
            return await self.status()
        if not self.configured():
            self.error = "The voice model isn’t set up in this build."
            return await self.status()
        self.hub._spawn(self._download())

    async def _download(self) -> None:
        size = int(self.model.get("size") or 0)
        self.downloading = {"done": 0, "total": size}
        self.emit()
        last = [0]

        def progress(done: int, total: int) -> None:
            self.downloading = {"done": done, "total": total}
            if done - last[0] >= (1 << 20) or (total and done >= total):
                last[0] = done
                self.emit()

        try:
            await voiceprint.download(self.model_path, self.model, progress, self.fetch)
            log.info("voice recognition: model downloaded")
        except Exception as exc:
            log.warning("voice recognition: download failed: %s", exc)
            self.error = f"The voice model didn’t download: {exc}"
        finally:
            self.downloading = None
        self.embedder, self.loaded = None, False
        await self.status()

    # ── enrollment ──

    def _recorder(self, cancel: threading.Event) -> Any:
        recorder = getattr(self.hub, "recorder", None)
        if recorder is not None:
            return recorder
        from ..listen import pick_input_device, record_utterance

        return functools.partial(
            record_utterance, device=pick_input_device(self.hub.prefs.mic), cancel=cancel
        )

    async def enroll(self, msg: dict[str, Any]) -> None:
        action = msg.get("action")
        if action == "cancel":
            if self._enroll_cancel is not None:
                self._enroll_cancel.set()
            return
        if action != "start" or self.enrolling is not None:
            return
        await self.prepare()
        if self.embedder is None:
            self.error = self.why_off() or "Download the voice model first."
            return await self.status()
        cancel = self._enroll_cancel = threading.Event()
        self.enrolling = {"index": 0, "again": False}
        self.hub._spawn(self._enroll(cancel))

    async def _enroll(self, cancel: threading.Event) -> None:
        """The owner reads SENTENCES sentences, one recording each; a clip that's too short
        or unclear is asked for again. The voiceprint replaces the old one only when all
        of them are in."""
        clips: list[Any] = []
        index, tries = 0, 0
        recorder = self._recorder(cancel)
        try:
            while index < SENTENCES and not cancel.is_set():
                self.enrolling = {"index": index, "again": tries > 0}
                self.emit()
                audio = await asyncio.to_thread(recorder, ENROLL_SILENCE, None)
                if cancel.is_set():
                    return
                embedding = None
                if audio is not None and voiceprint.seconds(audio) >= ENROLL_MIN_SECONDS:
                    embedding = await asyncio.to_thread(self.embedder, audio)
                if embedding is None:
                    tries += 1
                    if tries >= ENROLL_TRIES:
                        self.error = "I couldn’t hear that clearly. Try again somewhere quieter."
                        return
                    continue
                clips.append(embedding)
                index, tries = index + 1, 0
            owner = voiceprint.enroll(clips)
            await asyncio.to_thread(owner.save, self.print_path)
            self.print = owner
            log.info("voice recognition: voiceprint saved (%d clips)", owner.clips)
        except Exception as exc:  # no microphone, permission denied
            log.warning("voice recognition: enrollment failed: %s", exc)
            self.error = f"I couldn’t record: {exc}"
        finally:
            self.enrolling = None
            if self._enroll_cancel is cancel:
                self._enroll_cancel = None
            self.emit()

    async def forget(self, _msg: dict[str, Any] | None = None) -> None:
        if self._enroll_cancel is not None:
            self._enroll_cancel.set()
        await asyncio.to_thread(voiceprint.forget, self.print_path)
        self.print = None
        log.info("voice recognition: voiceprint forgotten")
        await self.status()

    async def startup(self) -> None:
        """At launch (the app only): ready for the first utterance, when it's on."""
        if self.on():
            await self.prepare()


def install(hub: Any) -> None:
    guard = VoiceGuard(hub)
    hub.voice_guard = guard
    hub.register_loop("voice_id_setup", guard.startup)
    hub.register_command("voice_id_status", guard.status)
    hub.register_command("voice_id_settings", guard.settings)
    hub.register_command("voice_id_download", guard.download)
    hub.register_command("voice_id_enroll", guard.enroll)
    hub.register_command("voice_id_forget", guard.forget)
