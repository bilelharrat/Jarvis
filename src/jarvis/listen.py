"""Microphone capture that stops when you stop talking, plus local Whisper transcription."""

from __future__ import annotations

import queue
import threading
from collections.abc import Callable

import numpy as np

SAMPLE_RATE = 16_000
BLOCK_SECONDS = 0.05


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


def record_utterance(
    silence_seconds: float, on_level: Callable[[float], None] | None = None
) -> np.ndarray | None:
    """Blocks until the speaker finishes. Returns 16 kHz mono float32 audio, or None."""
    import sounddevice as sd

    blocks: queue.Queue[np.ndarray] = queue.Queue()

    def on_audio(data, _frames, _time, _status) -> None:
        blocks.put(data[:, 0].copy())

    detector = EndpointDetector(silence_seconds=silence_seconds)
    captured: list[np.ndarray] = []
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        blocksize=int(SAMPLE_RATE * BLOCK_SECONDS),
        callback=on_audio,
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
        silence_seconds: float = 0.9,
        calibration_blocks: int = 20,
        max_seconds: float = 20.0,
        min_seconds: float = 0.35,
        block_seconds: float = BLOCK_SECONDS,
    ) -> None:
        self.silence_blocks = round(silence_seconds / block_seconds)
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
                self._current = list(self._preroll)
                self._quiet_run = 0
            return None
        self._current.append(block)
        self._quiet_run = 0 if loud else self._quiet_run + 1
        if self._quiet_run >= self.silence_blocks or len(self._current) >= self.max_blocks:
            voiced = len(self._current) - self._quiet_run
            audio = np.concatenate(self._current)
            self.in_speech = False
            self._current, self._preroll, self._loud_run = [], [], 0
            return audio if voiced >= self.min_blocks else None
        return None


class ContinuousListener:
    """Hands-free mode: keeps the microphone open and hands each utterance to a callback."""

    def __init__(
        self,
        on_utterance: Callable[[np.ndarray], None],
        on_level: Callable[[float], None] | None = None,
        silence_seconds: float = 0.9,
    ) -> None:
        self.on_utterance = on_utterance
        self.on_level = on_level
        self.silence_seconds = silence_seconds
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

    def _run(self) -> None:
        import sounddevice as sd

        blocks: queue.Queue[np.ndarray] = queue.Queue()
        segmenter = Segmenter(silence_seconds=self.silence_seconds)
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=int(SAMPLE_RATE * BLOCK_SECONDS),
            callback=lambda data, *_: blocks.put(data[:, 0].copy()),
        ):
            while not self._stop.is_set():
                try:
                    block = blocks.get(timeout=0.2)
                except queue.Empty:
                    continue
                rms = float(np.sqrt(np.mean(block**2)))
                if self.on_level is not None:
                    self.on_level(rms)
                utterance = segmenter.feed(block, rms)
                if utterance is not None:
                    self.on_utterance(utterance)


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

                self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            return self._model

    def transcribe(self, audio: np.ndarray) -> str:
        # The prompt nudges Whisper to spell the wake word "Jarvis", not "Travis" or "service".
        segments, _info = self._load().transcribe(
            audio, language="en", beam_size=1, vad_filter=True, initial_prompt="Jarvis,"
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
