"""Text-to-speech: macOS `say`, optionally through a light "AI in the house" effect."""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)
_EMPHASIS = re.compile(r"[*_`~]+")
_CITATION = re.compile(r"\s*\[(?:n?\d+(?:,\s*n?\d+)*)\]")

log = logging.getLogger("jarvis")

EFFECT_RATE = 22050


def clean_for_speech(text: str) -> str:
    """Turn a markdown-ish reply into something that sounds natural aloud."""
    text = _CODE_BLOCK.sub(" I've put the details on screen. ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("the link on screen", text)
    text = _CITATION.sub("", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = re.sub(r"\s*\n+\s*", ". ", text.strip())
    text = re.sub(r"([.!?])\.\s", r"\1 ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def available_voices() -> set[str]:
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return set()
    names = set()
    for line in out.splitlines():
        name = re.split(r"\s{2,}|\s+[a-z]{2}_[A-Z]{2}\s", line.strip())[0].strip()
        if name:
            names.add(name)
            names.add(name.split(" (")[0])  # "Daniel (English (UK))" also answers to "Daniel"
    return names


def ai_voice_effect(x: np.ndarray, rate: int = EFFECT_RATE) -> np.ndarray:
    """A subtle synthetic sheen: a tight doubled voice, a small room, trimmed lows and highs.

    Pure numpy so it adds nothing to install. Keeps the words clear: the dry voice
    stays dominant.
    """
    x = x.astype(np.float32)
    if x.size == 0:
        return x
    n = x.size
    # Tight double, very slowly swept, for the faintly synthetic "two voices at once" sheen.
    t = np.arange(n) / rate
    delay = (0.011 + 0.0015 * np.sin(2 * np.pi * 0.35 * t)) * rate
    idx = np.clip(np.arange(n) - delay, 0, n - 1)
    lo = np.floor(idx).astype(np.int64)
    frac = (idx - lo).astype(np.float32)
    hi = np.minimum(lo + 1, n - 1)
    double = x[lo] * (1 - frac) + x[hi] * frac
    y = x + 0.32 * double
    # Small room: a few early reflections that decay fast.
    tail = int(0.12 * rate)
    wet = np.zeros(n + tail, dtype=np.float32)
    wet[:n] += y
    for ms, gain in ((23, 0.20), (37, 0.14), (53, 0.10), (79, 0.06), (107, 0.035)):
        d = int(ms / 1000 * rate)
        wet[d : d + n] += gain * y
    # One-pole high-pass (~140 Hz) and low-pass (~7.5 kHz) to thin it slightly.
    a_hp = np.exp(-2 * np.pi * 140 / rate)
    a_lp = np.exp(-2 * np.pi * 7500 / rate)
    out = _highpass(wet, a_hp)
    out = _lowpass(out, a_lp)
    peak = float(np.max(np.abs(out))) or 1.0
    return (out / peak * 0.89).astype(np.float32)


def _lowpass(x: np.ndarray, a: float) -> np.ndarray:
    """One-pole low-pass y[n] = (1-a)x[n] + a*y[n-1], as a truncated impulse response."""
    length = max(1, int(np.ceil(np.log(1e-4) / np.log(a)))) if 0 < a < 1 else 1
    h = (1 - a) * a ** np.arange(length)
    return np.convolve(x, h.astype(np.float32))[: x.size]


def _highpass(x: np.ndarray, a: float) -> np.ndarray:
    return x - _lowpass(x, a)


def read_wav(source: Path | bytes) -> tuple[np.ndarray, int]:
    """16-bit PCM WAV -> float32 mono. Streamed WAVs (Fish Audio) put placeholder sizes in
    the header, so the samples are taken as everything after the data chunk header."""
    raw = source if isinstance(source, bytes) else Path(source).read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(raw):
        chunk, size = raw[pos : pos + 4], int.from_bytes(raw[pos + 4 : pos + 8], "little")
        body = pos + 8
        if chunk == b"fmt ":
            fmt = raw[body : body + 16]
        elif chunk == b"data":
            data = raw[body : body + size] if body + size <= len(raw) else raw[body:]
            break
        pos = body + size + (size & 1)
    if fmt is None or data is None:
        raise ValueError("WAV without fmt/data")
    channels = int.from_bytes(fmt[2:4], "little")
    rate = int.from_bytes(fmt[4:8], "little")
    bits = int.from_bytes(fmt[14:16], "little")
    if bits != 16:
        raise ValueError(f"expected 16-bit audio, got {bits}-bit")
    data = data[: len(data) - len(data) % (2 * channels)]
    audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    header = (
        b"RIFF"
        + (36 + len(pcm)).to_bytes(4, "little")
        + b"WAVEfmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")  # PCM
        + (1).to_bytes(2, "little")  # mono
        + int(rate).to_bytes(4, "little")
        + int(rate * 2).to_bytes(4, "little")
        + (2).to_bytes(2, "little")
        + (16).to_bytes(2, "little")
        + b"data"
        + len(pcm).to_bytes(4, "little")
    )
    path.write_bytes(header + pcm)


@dataclass
class CloudVoice:
    """ElevenLabs or Fish Audio, with the voice the user picked. Both return WAV."""

    provider: str
    api_key: str
    voice_id: str
    model: str = ""

    async def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        import httpx

        async with httpx.AsyncClient(timeout=45) as client:
            if self.provider == "elevenlabs":
                response = await client.post(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}",
                    params={"output_format": "wav_22050"},
                    headers={"xi-api-key": self.api_key},
                    json={"text": text, "model_id": self.model or "eleven_flash_v2_5"},
                )
            else:
                response = await client.post(
                    "https://api.fish.audio/v1/tts",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "model": self.model or "s2.1-pro",
                    },
                    json={
                        "text": text,
                        "reference_id": self.voice_id,
                        "format": "wav",
                        "sample_rate": 24000,
                        "latency": "low",
                    },
                )
            response.raise_for_status()
        return read_wav(response.content)


def cloud_voice_from(settings) -> CloudVoice | None:
    if settings.tts in ("elevenlabs", "fish") and settings.tts_api_key and settings.tts_voice_id:
        return CloudVoice(
            settings.tts, settings.tts_api_key, settings.tts_voice_id, settings.tts_model
        )
    return None


class Speaker:
    def __init__(
        self,
        voice: str,
        rate: int,
        muted: bool = False,
        effect: bool = False,
        cloud: CloudVoice | None = None,
    ) -> None:
        self.voice = voice if voice in available_voices() else ""
        self.rate = rate
        self.muted = muted
        self.effect = effect
        self.cloud = cloud
        self.cloud_error = ""
        self._proc: asyncio.subprocess.Process | None = None
        self._player: asyncio.subprocess.Process | None = None
        self._playing = False

    def stop(self) -> None:
        for proc in (self._proc, self._player):
            if proc is not None and proc.returncode is None:
                proc.kill()

    def _say_args(self) -> list[str]:
        args = ["say", "-r", str(self.rate)]
        if self.voice:
            args += ["-v", self.voice]
        return args

    async def say(self, text: str) -> None:
        """Speak one piece of text start to finish (confirmations, one-offs)."""
        spoken = clean_for_speech(text)
        if self.muted or not spoken:
            return
        clip = await self.synthesize(spoken)
        if clip is not None:
            await self.play(*clip)

    async def synthesize(self, spoken: str) -> tuple[np.ndarray, int] | None:
        """Text -> audio, using the cloud voice when set, falling back to the Mac voice."""
        if self.cloud is not None:
            try:
                audio, rate = await self.cloud.synthesize(spoken)
                self.cloud_error = ""
                return (
                    await asyncio.to_thread(ai_voice_effect, audio, rate) if self.effect else audio
                ), rate
            except Exception as exc:  # bad key, no credit, offline: fall back to the Mac voice
                self.cloud_error = str(exc)[:200]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reply.wav"
            args = self._say_args() + [f"--data-format=LEI16@{EFFECT_RATE}", "-o", str(path)]
            await self._run(args, spoken)
            if not path.exists():
                return None
            audio, rate = read_wav(path)
        if self.effect:
            audio = await asyncio.to_thread(ai_voice_effect, audio, rate)
        return audio, rate

    async def _run(self, args: list[str], spoken: str) -> None:
        # Text goes over stdin so a reply starting with "-" is never read as a flag.
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE)
        self._proc = proc
        try:
            await proc.communicate(spoken.encode())
        except asyncio.CancelledError:
            proc.kill()
            raise
        finally:
            self._proc = None

    async def play(self, audio: np.ndarray, rate: int) -> None:
        """Play a clip through macOS's own player (afplay).

        Not PortAudio: it reads the audio devices once at startup, so when AirPods switch
        modes or another output is picked, its saved device goes stale and every reply
        fails to open (-10851 Invalid Property Value). Playing from PortAudio across
        threads also crashed the process. afplay follows the current output device.
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.wav"
            write_wav(path, audio, rate)
            proc = await asyncio.create_subprocess_exec(
                "afplay",
                str(path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            self._player = proc
            self._playing = True
            try:
                _, err = await proc.communicate()
            except asyncio.CancelledError:
                proc.kill()
                raise
            finally:
                self._playing = False
                self._player = None
            if proc.returncode not in (0, -9) and err:
                raise RuntimeError(f"afplay failed: {err.decode(errors='replace').strip()[:200]}")


_SENTENCE = re.compile(r"(.+?[.!?…:;])(\s+|$)", re.DOTALL)


def split_sentences(buffer: str, final: bool = False, min_chars: int = 12) -> tuple[list[str], str]:
    """Pull complete sentences off the front of a streaming buffer.

    Very short fragments ("Sure.") wait to join the next sentence so every clip is worth a
    round trip to the voice service. With final=True the rest is flushed.
    """
    out: list[str] = []
    rest = buffer
    pending = ""
    while True:
        match = _SENTENCE.match(rest)
        if not match:
            break
        sentence = (pending + " " + match.group(1)).strip()
        rest = rest[match.end() :]
        if len(sentence) < min_chars and rest.strip():
            pending = sentence
            continue
        out.append(sentence)
        pending = ""
    rest = (pending + " " + rest).strip() if pending else rest
    if final and rest.strip():
        out.append(rest.strip())
        rest = ""
    return out, rest


class SpeechQueue:
    """Speaks sentences in order while synthesizing the next ones ahead of time.

    push() starts synthesis immediately (at most three in flight); a single player plays
    finished clips in order. That's what makes the first words come out quickly: the
    first sentence plays while the rest of the reply is still being written and voiced.
    """

    def __init__(self, speaker: Speaker, on_speaking: Callable[[bool], None] | None = None) -> None:
        self.speaker = speaker
        self.on_speaking = on_speaking or (lambda _on: None)
        self._clips: asyncio.Queue = asyncio.Queue()
        self._limit = asyncio.Semaphore(3)
        self._pending = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._player: asyncio.Task | None = None
        self.spoken_text = ""

    def push(self, text: str) -> None:
        spoken = clean_for_speech(text)
        if self.speaker.muted or not spoken:
            return
        self._pending += 1
        self._idle.clear()
        self.spoken_text = f"{self.spoken_text} {spoken}".strip()
        self._clips.put_nowait(asyncio.create_task(self._synth(spoken)))
        if self._player is None or self._player.done():
            self._player = asyncio.create_task(self._play_loop())

    async def _synth(self, spoken: str):
        async with self._limit:
            return await self.speaker.synthesize(spoken)

    async def _play_loop(self) -> None:
        while not self._clips.empty():
            task = await self._clips.get()
            try:
                clip = await task
                if clip is not None:
                    self.on_speaking(True)
                    await self.speaker.play(*clip)
            except asyncio.CancelledError:
                raise
            except Exception:  # one bad clip shouldn't silence the rest, but say so
                log.exception("couldn't play a reply clip")
            finally:
                self._pending -= 1
        self.on_speaking(False)
        self._idle.set()

    async def drain(self) -> None:
        await self._idle.wait()

    def clear(self) -> None:
        while not self._clips.empty():
            self._clips.get_nowait().cancel()
        if self._player is not None:
            self._player.cancel()
        self.speaker.stop()
        self._pending = 0
        self.spoken_text = ""
        self._idle.set()
        self.on_speaking(False)
