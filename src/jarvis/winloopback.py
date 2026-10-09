"""The computer's own sound on a PC, for notes: an online lecture, a seminar or a call playing on
it, heard beside the room's microphone (the Mac has a ScreenCaptureKit helper for this:
features/proactive/calls.py).

What is used is what the bundled audio library (sounddevice, over PortAudio) can open: its
WASAPI devices that are loopback inputs ("… [Loopback]", which newer PortAudio builds list), or
the sound card's own "Stereo Mix" / "What U Hear" input when Windows has it turned on. The
sounddevice in uv.lock has no loopback switch of its own (its WasapiSettings has none), so when
neither kind of device is there, notes go on with the microphone alone and say why, with what the
owner can turn on.

The sound comes in at the device's rate and channels and goes out as the microphone's: 16 kHz
mono blocks of listen.BLOCK_SECONDS, cut into utterances (listen.Segmenter) and transcribed on
this computer like the room's lines. Nothing of it is kept but the notes' words.

Claude cost policy: no model call; the notes' one write-up is meeting.py's.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import numpy as np

from . import listen, osplat

log = logging.getLogger("jarvis")

RATE = listen.SAMPLE_RATE
BLOCK = int(RATE * listen.BLOCK_SECONDS)
QUEUE_BLOCKS = 600  # half a minute of sound waiting at most (older blocks are dropped)
LOOPBACK_NAMES = ("loopback", "stereo mix", "what u hear", "wave out mix", "what you hear")
NO_DEVICE = (
    "this PC offers no way to record its own sound to JARVIS's audio library: turn on Stereo Mix "
    "in Windows' Sound settings (Recording, show disabled devices) if the sound card has it"
)


def find_device(sd: Any) -> tuple[int | None, str]:
    """The input that hears what the PC plays: (its index, "") or (None, why there is none)."""
    try:
        apis = list(sd.query_hostapis())
        devices = list(sd.query_devices())
    except Exception as exc:  # noqa: BLE001 - PortAudio that won't start
        return None, f"the audio library couldn't list the devices ({type(exc).__name__})"
    wasapi = {i for i, api in enumerate(apis) if "wasapi" in str(api.get("name", "")).lower()}
    best: tuple[int, int] | None = None  # (rank, index): a WASAPI loopback first, then Stereo Mix
    for index, device in enumerate(devices):
        name = str(device.get("name", "")).lower()
        if int(device.get("max_input_channels") or 0) <= 0:
            continue
        if not any(word in name for word in LOOPBACK_NAMES):
            continue
        rank = 0 if ("loopback" in name and device.get("hostapi") in wasapi) else 1
        if best is None or rank < best[0]:
            best = (rank, index)
    return (best[1], "") if best is not None else (None, NO_DEVICE)


def to_rate(samples: np.ndarray, rate: int) -> np.ndarray:
    """Any number of channels at any rate, as mono at RATE (float32)."""
    mono = samples.mean(axis=1) if samples.ndim == 2 else samples
    mono = np.asarray(mono, dtype=np.float32)
    if rate == RATE or not len(mono):
        return mono
    count = int(round(len(mono) * RATE / rate))
    where = np.linspace(0, len(mono), count, endpoint=False)
    return np.interp(where, np.arange(len(mono)), mono).astype(np.float32)


class Capture:
    """One open loopback input: blocks() gives its sound as the microphone's blocks."""

    def __init__(self, sd: Any, device: int, loop: asyncio.AbstractEventLoop) -> None:
        self.sd, self.device, self.loop = sd, device, loop
        self.queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue()
        self.pending = np.zeros(0, dtype=np.float32)
        self.stream: Any = None
        self.rate = RATE
        self.closed = False

    def start(self) -> None:
        info = self.sd.query_devices(self.device)
        self.rate = int(info.get("default_samplerate") or 48_000)
        channels = max(1, min(2, int(info.get("max_input_channels") or 1)))
        self.stream = self.sd.InputStream(
            device=self.device,
            channels=channels,
            samplerate=self.rate,
            dtype="float32",
            blocksize=int(self.rate * listen.BLOCK_SECONDS),
            callback=self._heard,
        )
        self.stream.start()

    def _heard(self, indata: Any, _frames: int, _time: Any, _status: Any) -> None:
        """PortAudio's thread: the sound, converted, handed to the event loop."""
        mono = to_rate(np.array(indata, copy=True), self.rate)
        with contextlib.suppress(RuntimeError):  # the loop closed as the app quit
            self.loop.call_soon_threadsafe(self.push, mono)

    def push(self, mono: np.ndarray) -> None:
        if self.closed:
            return
        self.pending = np.concatenate([self.pending, mono])
        while len(self.pending) >= BLOCK:
            block, self.pending = self.pending[:BLOCK], self.pending[BLOCK:]
            if self.queue.qsize() >= QUEUE_BLOCKS:
                with contextlib.suppress(asyncio.QueueEmpty):
                    self.queue.get_nowait()  # the oldest goes: the notes keep up with now
            self.queue.put_nowait(block)

    async def blocks(self) -> AsyncIterator[np.ndarray]:
        while True:
            block = await self.queue.get()
            if block is None:
                return
            yield block

    def stop(self) -> None:
        if self.closed:
            return
        self.closed = True
        stream, self.stream = self.stream, None
        if stream is not None:
            with contextlib.suppress(Exception):
                stream.stop()
            with contextlib.suppress(Exception):
                stream.close()
        self.queue.put_nowait(None)


def _sounddevice() -> Any:
    import sounddevice

    return sounddevice


def open_capture(sd: Any = None) -> tuple[Capture | None, str]:
    """The PC's own sound, opened: (capture, "") or (None, why not, in words). Only on Windows,
    unless an audio library is given (the tests' stand-in)."""
    if sd is None:
        if not osplat.IS_WIN:
            return None, "the computer's own sound is captured this way only on Windows"
        try:
            sd = _sounddevice()
        except Exception as exc:  # noqa: BLE001 - no PortAudio
            return None, f"the audio library didn't load ({type(exc).__name__})"
    device, why = find_device(sd)
    if device is None:
        return None, why
    capture = Capture(sd, device, asyncio.get_running_loop())
    try:
        capture.start()
    except Exception as exc:  # noqa: BLE001 - the device is busy or went away
        log.info("loopback: couldn't open device %s: %s", device, exc)
        return None, f"the PC's sound input wouldn't open ({type(exc).__name__})"
    return capture, ""


async def feed(
    capture: Capture,
    meeting: Any,
    hub: Any,
    speaker: str = "Them",
    heard: Callable[[], None] | None = None,
) -> None:
    """The captured sound into the notes, an utterance a line, as `speaker`: the notes model
    hears it when it is running, else the quick model does now. What plays while JARVIS itself
    speaks is left out, and nothing is added once these notes have stopped."""
    segmenter = listen.Segmenter(calibration_blocks=10)
    async for block in capture.blocks():
        rms = float(np.sqrt(np.mean(block * block)))
        utterance = segmenter.feed(block, rms)
        if utterance is None or getattr(hub, "state", "") == "speaking":
            continue
        if getattr(hub, "meeting", None) is not meeting:
            break
        if heard is not None:
            heard()
        if meeting.refining():
            meeting.add(utterance, "", speaker=speaker)
            continue
        ears = getattr(hub, "transcriber", None)
        text = ""
        if ears is not None and hasattr(ears, "transcribe"):
            try:
                text = await asyncio.to_thread(ears.transcribe, utterance, "")
            except Exception as exc:  # noqa: BLE001 - a model that failed to load
                log.info("loopback: couldn't transcribe (%s)", exc)
        if text and not listen.is_hallucination(text):
            meeting.add(utterance, text, speaker=speaker)
    capture.stop()
