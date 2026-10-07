"""Dictation for Eden in a browser without speech recognition (ROADMAP G7.2: Firefox has none).
Eden's page records with MediaRecorder, and Eden's server on this Mac (askeden
src/chat/transcribe.ts) posts the recording to POST /transcribe on Jarvis's MCP socket
(mcp_endpoint.build_app: not an MCP tool, since audio doesn't fit a /call). Jarvis hears it
with the Whisper it listens with (faster-whisper, on this Mac), and only the words go back.

- The recording: at most MAX_BYTES and MAX_SECONDS (the page stops at two minutes), in any
  container faster-whisper's decoder (PyAV) reads: WebM/Opus (Firefox, Chrome), MP4/AAC
  (Safari), Ogg, WAV, MP3. It's decoded in memory, never written to disk; neither it nor its
  words are logged.
- One at a time (another waits): Whisper on the CPU is the Mac's own work.
- The model: the one hands-free already loaded, else meeting notes', else one of its own with
  Settings' Whisper model (base.en downloads once, ~150 MB).
- The same card as any other call from Eden: the endpoint asks "Let Eden use Jarvis?" first.

Cost policy: no Claude model is called; Whisper runs on this Mac.
"""

from __future__ import annotations

import asyncio
import io
import logging
import threading
from typing import Any

from . import lang

log = logging.getLogger("jarvis")

MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 120  # the page's limit; a few seconds more are let through (SLACK_SECONDS)
SLACK_SECONDS = 5
SAMPLE_RATE = 16_000
TIMEOUT = 180.0  # the first use may load (or download) the model
TYPES = frozenset(
    {
        "audio/webm",
        "audio/ogg",
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
        "audio/aac",
        "audio/mpeg",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
    }
)


class DictationError(Exception):
    """A recording Jarvis won't or can't hear: an HTTP status and words for the page."""

    def __init__(self, status: int, words: str) -> None:
        super().__init__(words)
        self.status, self.words = status, words


def audio_type(value: Any) -> str | None:
    """The recording's media type without its parameters ("audio/webm;codecs=opus" →
    "audio/webm"), or None when it isn't one Jarvis reads."""
    base = str(value or "").split(";", 1)[0].strip().lower()
    return base if base in TYPES else None


def decode(raw: bytes) -> Any:
    """The recording as 16 kHz mono float samples."""
    from faster_whisper import decode_audio

    try:
        return decode_audio(io.BytesIO(raw), sampling_rate=SAMPLE_RATE)
    except Exception:
        raise DictationError(
            415, "That recording couldn’t be read. Try again, or dictate in another browser."
        ) from None


def model_for(hub: Any) -> Any:
    """Whisper as the Mac has it loaded already, else dictation's own (made once)."""
    from .listen import Transcriber

    for stt in (getattr(hub, "transcriber", None), getattr(hub, "notes_transcriber", None)):
        if isinstance(stt, Transcriber) and stt.loaded():
            return stt
        if stt is not None and stt != "auto" and not isinstance(stt, Transcriber):
            return stt  # a stand-in (tests)
    own = getattr(hub, "_dictation_stt", None)
    if own is None:
        model = lang.whisper_model(hub.language, hub.settings.whisper_model)
        own = hub._dictation_stt = Transcriber(model, hub.language)
    own.language = hub.language
    return own


def hear(stt: Any, audio: Any) -> str:
    """The words in the recording (Whisper's own voice detection skips the silences)."""
    if not hasattr(stt, "_load"):  # a stand-in (tests)
        return str(stt.transcribe(audio)).strip()
    from .video import whisper_transcribe

    segments = whisper_transcribe(stt)(audio, threading.Event())
    return " ".join(s.text for s in segments).strip()


async def transcribe(hub: Any, raw: bytes, mime: Any) -> str:
    """The words of one recording; DictationError (a status and words) when it can't be heard."""
    if audio_type(mime) is None:
        raise DictationError(415, "Send the recording as audio (WebM, Ogg, MP4, WAV or MP3).")
    if not raw:
        raise DictationError(400, "The recording was empty.")
    if len(raw) > MAX_BYTES:
        raise DictationError(413, "That recording is too big (25 MB at most).")
    lock = getattr(hub, "_dictation_lock", None)
    if lock is None:
        lock = hub._dictation_lock = asyncio.Lock()
    async with lock:
        audio = await asyncio.to_thread(decode, raw)
        seconds = len(audio) / SAMPLE_RATE
        if seconds > MAX_SECONDS + SLACK_SECONDS:
            raise DictationError(413, "Recordings are 2 minutes at most.")
        if seconds < 0.2:
            return ""
        stt = model_for(hub)
        try:
            words = await asyncio.wait_for(asyncio.to_thread(hear, stt, audio), TIMEOUT)
        except TimeoutError:
            raise DictationError(
                504, "Jarvis took too long to hear that. Try a shorter one."
            ) from None
        except Exception as exc:
            log.warning("eden dictation: Whisper failed (%s)", type(exc).__name__)
            raise DictationError(500, "Jarvis couldn’t transcribe that recording.") from None
    log.info("eden dictation: %.0f s heard", seconds)
    return words  # each piece cleaned already (video.whisper_transcribe: no made-up lines)
