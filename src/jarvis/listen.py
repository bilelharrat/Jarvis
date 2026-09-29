"""Microphone capture that stops when you stop talking, plus local Whisper transcription."""

from __future__ import annotations

import logging
import queue
import re
import threading
from collections.abc import Callable

import numpy as np

log = logging.getLogger("jarvis")

SAMPLE_RATE = 16_000
BLOCK_SECONDS = 0.05


def pick_input_device(preference: str = "builtin") -> int | None:
    """The microphone to listen with.

    "builtin" (the default) picks the Mac's own microphone when there is one. Opening a
    Bluetooth headset's mic (AirPods) switches it into phone-call mode, which makes all
    audio, Jarvis's voice included, sound scratchy and thin. None means the system default.
    """
    if preference != "builtin":
        return None
    try:
        import sounddevice as sd

        for index, device in enumerate(sd.query_devices()):
            name = device["name"].lower()
            if device["max_input_channels"] > 0 and (
                ("macbook" in name or "imac" in name or "built-in" in name) and "microphone" in name
            ):
                return index
    except Exception:  # no PortAudio devices at all
        return None
    return None


class EndpointDetector:
    """Decides when an utterance is over from a stream of per-block loudness (RMS) values.

    The first few blocks calibrate the room's noise floor; speech is anything well above
    it. The utterance ends after `silence_seconds` of quiet following speech, or gives
    up if nobody speaks within `wait_seconds`.
    """

    def __init__(
        self,
        silence_seconds: float = 1.2,
        wait_seconds: float = 8.0,
        max_seconds: float = 30.0,
        calibration_blocks: int = 6,
        block_seconds: float = BLOCK_SECONDS,
    ) -> None:
        self.silence_blocks = round(silence_seconds / block_seconds)
        self.wait_blocks = round(wait_seconds / block_seconds)
        self.max_blocks = round(max_seconds / block_seconds)
        self.calibration_blocks = calibration_blocks
        self._noise: list[float] = []
        self._threshold = 0.0
        self._blocks = 0
        self._quiet_run = 0
        self.heard_speech = False

    def feed(self, rms: float) -> bool:
        """Returns True once recording should stop."""
        self._blocks += 1
        if len(self._noise) < self.calibration_blocks:
            self._noise.append(rms)
            if len(self._noise) == self.calibration_blocks:
                self._threshold = max(float(np.median(self._noise)) * 3.0, 0.01)
            return False
        if rms >= self._threshold:
            self.heard_speech = True
            self._quiet_run = 0
        else:
            self._quiet_run += 1
        if self._blocks >= self.max_blocks:
            return True
        if not self.heard_speech:
            return self._blocks >= self.wait_blocks
        return self._quiet_run >= self.silence_blocks


# PortAudio is only used for input now (playback goes through the native player), so the
# listener may reset it to re-list devices. The lock keeps a reset from pulling the rug out
# from under a push-to-talk recording.
PORTAUDIO_LOCK = threading.Lock()
RESET_AFTER_FAILURES = 3


def reset_portaudio() -> None:
    """Forget PortAudio's device list and build it again. After sleep or a device change,
    opening a stream can fail with -9986 forever until this happens."""
    import sounddevice as sd

    with PORTAUDIO_LOCK:
        sd._terminate()
        sd._initialize()


def record_utterance(
    silence_seconds: float,
    on_level: Callable[[float], None] | None = None,
    device: int | None = None,
) -> np.ndarray | None:
    """Blocks until the speaker finishes. Returns 16 kHz mono float32 audio, or None."""
    import sounddevice as sd

    blocks: queue.Queue[np.ndarray] = queue.Queue()

    def on_audio(data, _frames, _time, _status) -> None:
        blocks.put(data[:, 0].copy())

    detector = EndpointDetector(silence_seconds=silence_seconds)
    captured: list[np.ndarray] = []
    with (
        PORTAUDIO_LOCK,
        sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=int(SAMPLE_RATE * BLOCK_SECONDS),
            callback=on_audio,
            device=device,
        ),
    ):
        while True:
            block = blocks.get()
            captured.append(block)
            rms = float(np.sqrt(np.mean(block**2)))
            if on_level is not None:
                on_level(rms)
            if detector.feed(rms):
                break
    if not detector.heard_speech:
        return None
    return np.concatenate(captured)


class Segmenter:
    """Cuts a continuous stream of blocks into utterances (for hands-free mode).

    Speech starts after two loud blocks in a row; it ends after `silence_seconds` of
    quiet. A little audio from before the start is kept so first syllables survive.
    """

    def __init__(
        self,
        silence_seconds: float = 0.7,
        calibration_blocks: int = 20,
        max_seconds: float = 20.0,
        min_seconds: float = 0.35,
        block_seconds: float = BLOCK_SECONDS,
        early_seconds: float | None = None,
        on_early: Callable[[int, np.ndarray], None] | None = None,
    ) -> None:
        """early_seconds/on_early: after that much quiet, hand over the utterance so far
        (with its number) so it can be transcribed while we wait to be sure you've
        finished; commit(number) then ends it there, as if the full silence had passed."""
        self.silence_blocks = round(silence_seconds / block_seconds)
        self.early_blocks = round(early_seconds / block_seconds) if early_seconds else 0
        self.on_early = on_early
        self.number = 0  # counts utterances
        self._committed = -1
        self.max_blocks = round(max_seconds / block_seconds)
        self.min_blocks = round(min_seconds / block_seconds)
        self.calibration_blocks = calibration_blocks
        self._noise: list[float] = []
        self.threshold = 0.012
        self._preroll: list[np.ndarray] = []
        self._current: list[np.ndarray] = []
        self._loud_run = 0
        self._quiet_run = 0
        self.in_speech = False

    def commit(self, number: int) -> bool:
        """End utterance `number` now (its early copy was enough). False if speech
        already started again, in which case the early copy is stale."""
        if number != self.number or not self.in_speech or self._quiet_run < self.early_blocks:
            return False
        self._committed = number
        return True

    def feed(self, block: np.ndarray, rms: float) -> np.ndarray | None:
        """Returns a finished utterance, or None."""
        if len(self._noise) < self.calibration_blocks:
            self._noise.append(rms)
            if len(self._noise) == self.calibration_blocks:
                self.threshold = max(float(np.median(self._noise)) * 3.5, 0.012)
            return None
        loud = rms >= self.threshold
        if not self.in_speech:
            self._preroll = (self._preroll + [block])[-6:]
            self._loud_run = self._loud_run + 1 if loud else 0
            if self._loud_run >= 2:
                self.in_speech = True
                self.number += 1
                self._current = list(self._preroll)
                self._quiet_run = 0
            return None
        self._current.append(block)
        self._quiet_run = 0 if loud else self._quiet_run + 1
        if self._committed == self.number:  # already taken early: this one's done
            self.in_speech = False
            self._current, self._preroll, self._loud_run = [], [], 0
            return None
        if (
            self.early_blocks
            and self.on_early is not None
            and self._quiet_run == self.early_blocks
            and len(self._current) - self._quiet_run >= self.min_blocks
        ):
            self.on_early(self.number, np.concatenate(self._current))
        if self._quiet_run >= self.silence_blocks or len(self._current) >= self.max_blocks:
            voiced = len(self._current) - self._quiet_run
            audio = np.concatenate(self._current)
            self.in_speech = False
            self._current, self._preroll, self._loud_run = [], [], 0
            return audio if voiced >= self.min_blocks else None
        return None


# Words an unfinished sentence tends to stop on ("what's the weather in…").
_TRAILING = {
    "and", "but", "or", "so", "the", "a", "an", "to", "of", "for", "with", "in", "on", "at",
    "my", "your", "our", "their", "is", "are", "was", "were", "um", "uh", "like", "because",
    "then", "that", "if", "when", "about", "from", "into", "than", "as", "by", "please",
    "what", "which", "who", "how", "can", "could", "would", "should", "will", "me", "it's",
}  # fmt: skip


def sounds_finished(text: str) -> bool:
    """Whether a transcript reads like a finished request: it ends like a sentence and
    not on a word that promises more. Used to answer before the full silence passes."""
    text = text.strip()
    if not text or text.endswith(("...", "…", ",", "-", "—")):
        return False
    if not text.endswith((".", "?", "!")):
        return False
    words = re.findall(r"[a-z']+", text.lower())
    return len(words) >= 2 and words[-1] not in _TRAILING


class ContinuousListener:
    """Hands-free mode: keeps the microphone open and hands each utterance to a callback."""

    def __init__(
        self,
        on_utterance: Callable[[np.ndarray], None],
        on_level: Callable[[float], None] | None = None,
        silence_seconds: float = 0.9,
        device_preference: str = "builtin",
    ) -> None:
        self.device_preference = device_preference
        self.on_utterance = on_utterance
        self.on_level = on_level
        self.silence_seconds = silence_seconds
        # Smart endpointing (set by the hub): an early copy after this much quiet.
        self.early_seconds: float | None = None
        self.on_early: Callable[[int, np.ndarray], None] | None = None
        self.segmenter: Segmenter | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="jarvis-mic", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def commit(self, number: int) -> bool:
        """End utterance `number` now: its early copy was enough."""
        return self.segmenter.commit(number) if self.segmenter is not None else False

    def _run(self) -> None:
        """Keep a stream open for as long as hands-free is on.

        Reopens the microphone when the stream errors or stalls (AirPods connecting,
        the default input changing, the Mac waking from sleep) instead of going deaf.
        """
        import sounddevice as sd

        failures = 0
        while not self._stop.is_set():
            blocks: queue.Queue[np.ndarray] = queue.Queue()
            segmenter = Segmenter(
                silence_seconds=self.silence_seconds,
                early_seconds=self.early_seconds,
                on_early=self.on_early,
            )
            self.segmenter = segmenter
            try:
                if failures >= RESET_AFTER_FAILURES:
                    log.info("resetting the audio system to find the microphone again")
                    reset_portaudio()
                device = pick_input_device(self.device_preference)
                with sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype="float32",
                    blocksize=int(SAMPLE_RATE * BLOCK_SECONDS),
                    callback=lambda data, *_, q=blocks: q.put(data[:, 0].copy()),
                    device=device,
                ):
                    name = sd.query_devices(device if device is not None else sd.default.device[0])[
                        "name"
                    ]
                    log.info("hands-free microphone open: %s", name)
                    failures = 0
                    while not self._stop.is_set():
                        try:
                            block = blocks.get(timeout=2.0)
                        except queue.Empty:
                            log.warning("microphone went quiet; reopening it")
                            break
                        rms = float(np.sqrt(np.mean(block**2)))
                        if self.on_level is not None:
                            self.on_level(rms)
                        utterance = segmenter.feed(block, rms)
                        if utterance is not None:
                            self.on_utterance(utterance)
            except Exception as exc:  # device vanished, permission revoked
                failures += 1
                log.warning("microphone error (%s); retrying", exc)
                self._stop.wait(min(10.0, 0.5 * 2**failures))


class Transcriber:
    """Offline speech-to-text. The model downloads once (~150 MB for base.en) on first use."""

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self._model = None
        self._lock = threading.Lock()

    def warm_up(self) -> None:
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(
                    self.model_name, device="cpu", compute_type="int8", cpu_threads=8
                )
            return self._model

    def loaded(self) -> bool:
        return self._model is not None

    def transcribe(self, audio: np.ndarray, hotwords: str = "Jarvis") -> str:
        # Hotwords bias Whisper toward spelling the wake word "Jarvis". (An initial_prompt
        # of "Jarvis," made Whisper treat the name as already said and drop it.)
        # Audio arrives already cut at speech boundaries, so Whisper's own VAD only trims
        # first words; a short lead-in of silence stops it swallowing the first word.
        # (Measured with scripts/stress_hands_free.py: 86% -> 88% wake detection.)
        padded = np.concatenate([np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32), audio])
        segments, _info = self._load().transcribe(
            padded,
            language="en",
            beam_size=1,
            vad_filter=False,
            hotwords=hotwords or "Jarvis",
            # Faster, and nothing here needs timestamps or the previous utterance.
            without_timestamps=True,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return "" if is_hallucination(text) else text


# What Whisper tends to invent from silence or room noise.
_HALLUCINATIONS = {
    "you",
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "okay",
    "so",
    "the end",
    "subtitles by the amara org community",
}


def is_hallucination(text: str) -> bool:
    cleaned = "".join(c for c in text.lower() if c.isalnum() or c == " ").strip()
    return cleaned in _HALLUCINATIONS
