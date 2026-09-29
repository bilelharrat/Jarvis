"""Microphone capture that stops when you stop talking, plus local Whisper transcription."""

from __future__ import annotations

import queue
import threading

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


def record_utterance(silence_seconds: float) -> np.ndarray | None:
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
            if detector.feed(float(np.sqrt(np.mean(block**2)))):
                break
    if not detector.heard_speech:
        return None
    return np.concatenate(captured)


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
        segments, _info = self._load().transcribe(
            audio, language="en", beam_size=1, vad_filter=True
        )
        return " ".join(seg.text.strip() for seg in segments).strip()
