"""Neural voice detection: is someone speaking in this block of microphone audio?

The loudness detector (listen.Segmenter's threshold) hears a door, the keyboard or a fan
turning up as speech, and a quiet word as silence. Silero VAD is a small neural model that
tells speech from other sound; faster-whisper already ships it (silero_vad_v6.onnx in its
package), so it adds nothing to install or download. onnxruntime runs it on the CPU: about
0.2 ms per 32 ms of audio, a fraction of a percent of one core.

The model reads 512-sample windows (32 ms at 16 kHz), each with the 64 samples before it,
and carries its memory (h, c) from one window to the next. Read that way, window by window,
it gives exactly the probabilities faster-whisper's own batch call gives (tests check it).

VoiceGate turns the probabilities into speech or not for each 50 ms block, with hysteresis:
speech starts at `threshold` and goes on while the probability stays above threshold -
0.15, so a soft syllable in the middle of a word doesn't end it. When the model can't load
(onnxruntime or the model file missing), make_gate() says why once and the caller keeps the
loudness detector.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
import weakref
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("jarvis")

RATE = 16_000
WINDOW = 512  # samples the model reads at a time (32 ms)
CONTEXT = 64  # samples of the previous window it sees as well
MODEL_FILE = "silero_vad_v6.onnx"
DEFAULT_THRESHOLD = 0.5
MIN_THRESHOLD, MAX_THRESHOLD = 0.2, 0.9
HYSTERESIS = 0.15  # a window this far below the threshold still continues speech


class Unavailable(RuntimeError):
    """The neural detector can't run here (why is the message)."""


def model_path() -> Path:
    """faster-whisper's copy of Silero VAD (installed with it; nothing downloads)."""
    try:
        from faster_whisper.utils import get_assets_path
    except Exception as exc:  # faster-whisper broken or missing
        raise Unavailable(f"faster-whisper isn't importable ({exc})") from None
    return Path(get_assets_path()) / MODEL_FILE


_session: Any = None
_failure = ""  # why the model couldn't load (tried once per run)
_lock = threading.Lock()
_streams: weakref.WeakSet[SileroStream] = weakref.WeakSet()


def quiet_onnxruntime() -> None:
    """Switch off onnxruntime's telemetry for this process, before any session exists.
    Its macOS build sends usage events to Microsoft (mobile.events.data.microsoft.com)
    from a thread of its own once a session is made, and that thread crashed the app on
    quitting (1 run in 4: "recursive_mutex lock failed" in its HTTP client). Nothing about
    the owner's audio leaves the Mac this way, and now nothing at all does. Also covers
    faster-whisper's own use of onnxruntime (video summaries)."""
    try:
        import onnxruntime

        onnxruntime.disable_telemetry_events()
    except Exception:  # not installed, or an older build without the switch
        pass


@atexit.register
def _release() -> None:
    """Let the model go while Python is still whole, not in the interpreter's teardown."""
    global _session
    with _lock:
        for stream in list(_streams):
            stream.session = None  # a stream still fed after this reads as broken: loudness
        _session = None


def load_session() -> Any:
    """The ONNX session, loaded once and shared (running it is thread-safe; each stream
    keeps its own memory). Raises Unavailable, with why, when it can't load."""
    global _session, _failure
    with _lock:
        if _session is not None:
            return _session
        if _failure:
            raise Unavailable(_failure)
        try:
            import onnxruntime

            quiet_onnxruntime()
            path = model_path()
            if not path.is_file():
                raise Unavailable(f"{MODEL_FILE} isn't in faster-whisper's package")
            opts = onnxruntime.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            opts.enable_cpu_mem_arena = False
            opts.log_severity_level = 4
            _session = onnxruntime.InferenceSession(
                os.fspath(path), providers=["CPUExecutionProvider"], sess_options=opts
            )
        except Unavailable as exc:
            _failure = str(exc)
            raise
        except Exception as exc:  # onnxruntime missing, a damaged model file
            _failure = f"the voice model didn't load ({exc})"[:300]
            raise Unavailable(_failure) from None
        return _session


def unavailable_reason() -> str:
    """Why the neural detector can't run ("" when it can, or hasn't been tried yet)."""
    return _failure


class SileroStream:
    """Speech probability for a continuous 16 kHz stream, window by window."""

    def __init__(self, session: Any) -> None:
        self.session = session
        _streams.add(self)
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._context = np.zeros(CONTEXT, dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)
        self.last = 0.0  # the latest window's probability

    def feed(self, samples: np.ndarray) -> list[float]:
        """The probability of each whole window this audio completes (a window left over
        waits for the next block)."""
        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if self._pending.size:
            audio = np.concatenate([self._pending, audio])
        count = audio.size // WINDOW
        self._pending = audio[count * WINDOW :].copy()
        found: list[float] = []
        for k in range(count):
            window = audio[k * WINDOW : (k + 1) * WINDOW]
            frame = np.concatenate([self._context, window])[None, :]
            out, self._h, self._c = self.session.run(
                None, {"input": frame, "h": self._h, "c": self._c}
            )
            self._context = window[-CONTEXT:].copy()
            self.last = float(np.asarray(out).reshape(-1)[0])
            found.append(self.last)
        return found


def clean_threshold(value: Any) -> float | None:
    """A sensitivity setting: a number from MIN_THRESHOLD to MAX_THRESHOLD (lower hears
    more), else None."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if value != value:  # NaN
        return None
    return round(min(MAX_THRESHOLD, max(MIN_THRESHOLD, float(value))), 2)


class VoiceGate:
    """Speech or not, block by block, from a SileroStream's probabilities.

    A block is speech when its most likely window reaches the threshold; once speaking,
    it stays speech while that window keeps above threshold - HYSTERESIS. threshold may be
    a callable, read on every block, so a change in Settings applies at once."""

    def __init__(self, stream: Any, threshold: float | Callable[[], float] = DEFAULT_THRESHOLD):
        self.stream = stream
        self._threshold = threshold
        self.speaking = False
        self.probability = 0.0  # the last block's (for the log when tuning)
        self.broken = ""  # why the model stopped working mid-stream: loudness from then on

    def threshold(self) -> float:
        try:
            value = self._threshold() if callable(self._threshold) else self._threshold
        except Exception:  # a setting that can't be read: the default
            value = DEFAULT_THRESHOLD
        return clean_threshold(value) or DEFAULT_THRESHOLD

    def __call__(self, block: np.ndarray) -> bool | None:
        """Speech or not; None once the model has failed (the caller uses loudness)."""
        if self.broken:
            return None
        try:
            probabilities = self.stream.feed(block)
        except Exception as exc:  # never costs the microphone: loudness takes over
            self.broken = str(exc)[:200] or type(exc).__name__
            log.warning("neural voice detection failed (%s); using loudness", self.broken)
            return None
        self.probability = max(probabilities) if probabilities else self.stream.last
        bar = self.threshold()
        if self.speaking:
            bar = max(0.01, bar - HYSTERESIS)
        self.speaking = self.probability >= bar
        return self.speaking


def make_gate(threshold: float | Callable[[], float] = DEFAULT_THRESHOLD) -> VoiceGate | None:
    """A neural voice gate for one microphone stream, or None when the model can't run
    (said in the log once; the caller keeps the loudness detector)."""
    first = not _failure
    try:
        session = load_session()
    except Unavailable as exc:
        if first:
            log.warning("neural voice detection is off: %s; using loudness", exc)
        return None
    return VoiceGate(SileroStream(session), threshold)
