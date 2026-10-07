"""Text-to-speech: macOS `say`, optionally through a light "AI in the house" effect."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
# Each of these is linear however long a run of spaces, blank lines or "[": a line start
# never looks past its own line, and a run is tried only from where it begins. A link's
# address may hold one level of brackets (Wikipedia's Foo_(bar)).
_LINK = re.compile(r"\[([^\[\]]+)\]\((?:[^()]|\([^()]*\))+\)")
_URL = re.compile(r"https?://\S+")
_BULLET = re.compile(r"^[^\S\n]*(?:[-*•]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^[^\S\n]*#{1,6}\s*", re.MULTILINE)
_EMPHASIS = re.compile(r"[*_`~]+")
_CITATION = re.compile(r"(?<!\s)\s*\[(?:n?\d+(?:,\s*n?\d+)*)\]")
_LINE_BREAKS = re.compile(r"(?<!\s)\s*\n\s*")

log = logging.getLogger("jarvis")

EFFECT_RATE = 22050
LOCAL_RATE = 24000  # the offline voice's (local_voice.LOCAL_RATE)
# Said once, in the Mac voice, when the offline voice stops working.
LOCAL_FAILED = "My own voice isn't working right now, so the Mac's voice will do."


def clean_for_speech(text: str) -> str:
    """Turn a markdown-ish reply into something that sounds natural aloud."""
    text = _CODE_BLOCK.sub(" I've put the details on screen. ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("the link on screen", text)
    text = _CITATION.sub("", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = _LINE_BREAKS.sub(". ", text.strip())
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
    audio = from_pcm(data[: len(data) - len(data) % (2 * channels)])
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def write_wav(path: Path, audio: np.ndarray, rate: int) -> None:
    path.write_bytes(wav_bytes(audio, rate))


def wav_bytes(audio: np.ndarray, rate: int) -> bytes:
    """float mono -> a 16-bit PCM WAV file's bytes."""
    pcm = to_pcm(audio)
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
    return header + pcm


# The JARVIS voice: a public Fish Audio model ("Jarvis (MCU) J.A.R.V.I.S."), spoken with the
# owner's own Fish key when they have one, else through askeden.com, whose Worker holds a
# key of its own and caps each install's daily use (site/src/worker.js).
JARVIS_VOICE_ID = "612b878b113047d9a770c069c8b4fdfe"
HOSTED_VOICE_URL = "https://askeden.com/api/voice"


@dataclass
class CloudVoice:
    """ElevenLabs or Fish Audio, with the voice the user picked, or "hosted": the JARVIS
    voice through askeden.com (api_key is then the install's id, not a secret). All return
    WAV."""

    provider: str
    api_key: str
    voice_id: str
    model: str = ""
    speed: float = 1.0  # Settings › Speaking › Speed (1.0 sends nothing: the voice's own)
    # hosted: the owner's Jarvis account token ("" when the Mac isn't linked), so the voice
    # counts against the account's allowance rather than the install's.
    bearer: Callable[[], str] | None = None

    _client: Any = None

    def _options(self) -> dict[str, Any]:
        """Request fields beyond the text: a speed other than the voice's own."""
        if abs(self.speed - 1.0) < 0.01:
            return {}
        if self.provider == "elevenlabs":
            return {"voice_settings": {"speed": round(min(1.2, max(0.7, self.speed)), 2)}}
        return {"prosody": {"speed": round(min(2.0, max(0.5, self.speed)), 2)}}

    def _http(self):
        """One long-lived connection: a fresh TLS handshake per sentence cost ~0.3s each."""
        import httpx

        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=45, limits=httpx.Limits(keepalive_expiry=300, max_keepalive_connections=4)
            )
        return self._client

    async def warm(self) -> None:
        """Open the connection ahead of the first sentence (called when you start talking)."""
        host = {
            "elevenlabs": "https://api.elevenlabs.io",
            "hosted": HOSTED_VOICE_URL.rsplit("/api/", 1)[0],
        }.get(self.provider, "https://api.fish.audio")
        try:
            await self._http().head(host, timeout=5)
        except Exception:  # offline: the real request will say so
            pass

    def _hosted(self, text: str, fmt: str) -> dict[str, Any]:
        """The request to askeden.com's voice: the text and the install's id (its daily
        allowance is counted by it)."""
        body: dict[str, Any] = {"text": text, "format": fmt}
        if abs(self.speed - 1.0) >= 0.01:
            body["speed"] = round(min(2.0, max(0.5, self.speed)), 2)
        headers = {"X-Jarvis-Install": self.api_key}
        token = ""
        if self.bearer is not None:
            try:
                token = self.bearer() or ""
            except Exception:
                token = ""
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return {"url": HOSTED_VOICE_URL, "headers": headers, "json": body}

    def _request(self, text: str, fmt: str) -> dict[str, Any]:
        """The request for a sentence, whole ("wav") or as it's made ("pcm"): its address,
        headers and body, the same for the two ways but for the format."""
        if self.provider == "hosted":
            return self._hosted(text, fmt)
        if self.provider == "elevenlabs":
            address = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}"
            return {
                "url": address + "/stream" if fmt == "pcm" else address,
                "params": {"output_format": f"{fmt}_22050"},
                "headers": {"xi-api-key": self.api_key},
                "json": {
                    "text": text,
                    "model_id": self.model or "eleven_flash_v2_5",
                    **self._options(),
                },
            }
        return {
            "url": "https://api.fish.audio/v1/tts",
            "headers": {
                "Authorization": f"Bearer {self.api_key}",
                "model": self.model or "s2.1-pro",
            },
            "json": {
                "text": text,
                "reference_id": self.voice_id,
                "format": fmt,
                "sample_rate": 24000,
                "latency": "low",
                **self._options(),
            },
        }

    async def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        response = await self._http().post(**self._request(text, "wav"))
        response.raise_for_status()
        return read_wav(response.content)

    @property
    def stream_rate(self) -> int:
        return 22050 if self.provider == "elevenlabs" else 24000

    async def stream(self, text: str):
        """Raw 16-bit mono PCM chunks as the service generates them (first bytes ~0.6s,
        long before the whole sentence is ready)."""
        async with self._http().stream("POST", **self._request(text, "pcm")) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk


def cloud_voice_from(settings) -> CloudVoice | None:
    if settings.tts in ("elevenlabs", "fish") and settings.tts_api_key and settings.tts_voice_id:
        return CloudVoice(
            settings.tts, settings.tts_api_key, settings.tts_voice_id, settings.tts_model
        )
    return None


PLAYER_SOURCE = Path(__file__).parent / "player" / "jarvis-player.swift"


def ensure_player() -> Path | None:
    """Build the native streaming player once (a few seconds with swiftc), cached by the
    source's hash, as the other audio helpers are (audio.build: under a temporary name,
    moved into place when done). None if it can't be built; playback then falls back to
    afplay."""
    from . import audio

    return audio.build("jarvis-player", (), source=PLAYER_SOURCE, timeout=300)


MARK_SLACK = 10.0  # seconds a sentence's end marker may lag its audio before we give up
# A player can stop playing while it still runs (its audio engine didn't come back from the
# Mac sleeping): what's written to it is never heard and its markers never come back. Each
# sentence that starts on an idle player sends a ping first; an idle player takes it in
# within milliseconds, whatever the output's latency, so one that doesn't is stuck.
PING_SECONDS = 1.0  # no answer in this long: started anew, and it plays what wasn't heard
PING_LATE = 0.1  # a deadline the event loop reached later than this is looked at again
HELLO_SECONDS = 2.0  # a new player says its engine runs within this, or it's used as it is
UNHEARD_SECONDS = 120.0  # the most audio kept for playing again on a new player


class LivePlayer:
    """The native player kept running between sentences (jarvis-player --live).

    Sentences are written into it back to back, so there's no process to start, no
    engine to spin up and no pre-buffer before each one: the first words play the moment
    they arrive and the next sentence follows without a gap. A marker after each
    sentence tells us when it has actually been heard.

    A player that has stopped playing is found out by the ping at a sentence's start
    (PING_SECONDS) and started anew; the new one plays what the old one hadn't, markers
    and all, so a stale player costs a reply about a second rather than the reply.
    """

    def __init__(self, path: Path, rate: int, effect: bool) -> None:
        self.path, self.rate, self.effect = path, rate, effect
        self.proc: asyncio.subprocess.Process | None = None
        self._markers: dict[int, asyncio.Future] = {}
        self._next = 0
        self._reader: asyncio.Task | None = None
        self._ends_at = 0.0  # when everything written so far should have played
        self._closed = False
        self.pings = False  # it said hello ("H"): it answers pings
        self._hello: asyncio.Event | None = None
        self._ping: tuple[int, asyncio.TimerHandle] | None = None  # the one awaiting its answer
        self._pinged = 0
        # Written and not yet heard for sure, with where each marker falls in it: what a
        # player started anew is given. Trimmed as markers come back.
        self._unheard = bytearray()
        self._marked: list[list[int]] = []  # [marker, offset into _unheard], in order
        self._io = asyncio.Lock()  # one write at a time, and none while it starts anew
        self._stuck: asyncio.subprocess.Process | None = None  # given up on, until replaced
        self._revival: asyncio.Task | None = None
        self._revived = False  # started anew, and not heard from since

    @property
    def alive(self) -> bool:
        if self._closed:
            return False
        if self._revival is not None:
            return True  # being started anew: what's written meanwhile waits for it
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        args = [str(self.path), str(self.rate), "--live"] + (["--effect"] if self.effect else [])
        self.proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._hello = hello = asyncio.Event()
        self._reader = asyncio.create_task(self._read())
        # It says hello once its engine runs, and from then on answers pings. Audio can't
        # play any sooner, so waiting for it costs the first words nothing. One that never
        # says it is used as before, without pings.
        try:
            await asyncio.wait_for(hello.wait(), HELLO_SECONDS)
        except TimeoutError:
            pass

    async def _read(self) -> None:
        proc, hello = self.proc, self._hello
        try:
            while proc is not None and (line := await proc.stdout.readline()):
                if proc is not self.proc or proc is self._stuck:
                    break  # given up on: what it says no longer counts
                parts = line.decode(errors="replace").split()
                if parts[:1] == ["M"] and len(parts) == 2 and parts[1].isdigit():
                    self._revived = False
                    self._settle(int(parts[1]))
                elif parts[:1] == ["P"] and len(parts) == 2 and parts[1].isdigit():
                    self._answered(int(parts[1]))
                elif parts[:1] == ["R"]:  # its engine started again: queued audio is gone
                    self._ends_at = 0.0
                    self._settle_all()
                    self._forget()
                elif parts[:1] == ["H"]:
                    self.pings = True
                    if hello is not None:
                        hello.set()
                else:
                    self._line(parts)
        finally:
            if hello is not None:
                hello.set()  # it exited: start() stops waiting
            if proc is self.proc and proc is not self._stuck:
                self._settle_all()  # it exited: nobody waits forever

    def _line(self, parts: list[str]) -> None:
        """A line of the player's this class doesn't know (duplex.DuplexPlayer's)."""

    def _settle(self, marker: int) -> None:
        for key in [k for k in self._markers if k <= marker]:
            future = self._markers.pop(key)
            if not future.done():
                future.set_result(None)
        cut = -1  # what it has played needn't be kept for playing again
        while self._marked and self._marked[0][0] <= marker:
            cut = self._marked.pop(0)[1]
        if cut > 0:
            del self._unheard[:cut]
            for entry in self._marked:
                entry[1] -= cut
        if not self._unheard:  # all of it heard: the next audio starts now, not later
            self._ends_at = min(self._ends_at, time.monotonic())

    def _settle_all(self) -> None:
        self._settle(self._next)

    def _forget(self) -> None:
        """Nothing it was given needs playing again (dropped on purpose, or lost)."""
        self._unheard.clear()
        self._marked.clear()

    def _keep(self, pcm: bytes) -> None:
        self._unheard += pcm
        over = len(self._unheard) - int(UNHEARD_SECONDS * self.rate) * 2
        if over > 0:  # a long stream with no markers (realtime replies): only its end
            del self._unheard[:over]
            for entry in self._marked:
                entry[1] = max(0, entry[1] - over)

    def _frame(self, kind: str, value: int, payload: bytes = b"") -> bytes:
        return kind.encode() + value.to_bytes(4, "little") + payload

    # ── pings: is it still playing? ──

    def _send_ping(self) -> None:
        self._pinged += 1
        timer = asyncio.get_running_loop().call_later(
            PING_SECONDS, self._unanswered, self._pinged, self.proc
        )
        self._ping = (self._pinged, timer)
        self.proc.stdin.write(self._frame("P", self._pinged))

    def _answered(self, ping: int) -> None:
        self._revived = False
        if self._ping is not None and self._ping[0] <= ping:
            self._ping[1].cancel()
            self._ping = None

    def _unanswered(self, ping: int, proc: Any) -> None:
        """No answer to a ping: it has stopped playing. Started anew once; a new one that
        doesn't play either is closed (nothing waits on it, and the next sentence tries a
        fresh player)."""
        if self._ping is None or self._ping[0] != ping or proc is not self.proc or self._closed:
            return
        loop = asyncio.get_running_loop()
        if loop.time() - self._ping[1].when() > PING_LATE:
            # The event loop was busy past the deadline (a slow step, a busy Mac), and an
            # answer that came meanwhile reaches the reader only after this runs: a player
            # that plays was started anew, its sentence said again. Looked at again once the
            # loop has caught up.
            self._ping = (ping, loop.call_later(PING_LATE, self._unanswered, ping, proc))
            return
        self._ping = None
        if self._revived:
            log.warning("the new voice player isn't playing either; leaving it for now")
            self.close()
            return
        log.warning(
            "the voice player stopped playing (no answer in %.1fs); starting a new one "
            "for what it hadn't played",
            PING_SECONDS,
        )
        self._revived = True
        self._stuck = proc
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        self._revival = asyncio.ensure_future(self._revive())

    async def _revive(self) -> None:
        """Start it anew and give it what the stuck one hadn't played, each marker where
        it was: the sentence plays from its start, and whoever waits on a marker still
        gets it."""
        try:
            async with self._io:
                if self._closed:
                    return
                try:
                    await self.start()
                except OSError as exc:
                    log.warning("the voice player didn't start again (%s)", exc)
                    self.close()
                    return
                self._stuck = None
                if self._closed:
                    self.close()  # closed while it started: this one goes too
                    return
                if self.pings:
                    self._send_ping()  # the new one is asked too
                stdin, at = self.proc.stdin, 0
                for marker, offset in self._marked:
                    if offset > at:
                        stdin.write(self._frame("A", offset - at, bytes(self._unheard[at:offset])))
                    stdin.write(self._frame("M", marker))
                    at = offset
                if len(self._unheard) > at:
                    rest = bytes(self._unheard[at:])
                    stdin.write(self._frame("A", len(rest), rest))
                self._ends_at = time.monotonic() + len(self._unheard) / (2 * self.rate)
                await stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the new one went away too: its reader settles what waits on it
        finally:
            self._revival = None

    # ── what the Speaker uses ──

    async def write(self, pcm: bytes) -> None:
        if not pcm or not self.alive:
            return
        async with self._io:
            if not self.alive:
                return
            now = time.monotonic()
            idle = (
                not self._markers
                and (not self._unheard or self._ends_at <= now)  # all heard, or due to be
                and self._ping is None
                and self.proc is not self._stuck
            )
            if idle:
                # Everything before has played (or was dropped). A sentence starts here,
                # and the ping sent ahead of it says whether the player still plays.
                self._forget()
                if self.pings:
                    self._send_ping()
            self._keep(pcm)
            self._ends_at = max(self._ends_at, now) + len(pcm) / (2 * self.rate)
            if self.proc is self._stuck:
                return  # starting anew: the new one gets this with the rest
            try:
                self.proc.stdin.write(self._frame("A", len(pcm), pcm))
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                if self.proc is not self._stuck:
                    raise
                # stuck, and killed mid-write: the new one plays this with the rest

    async def mark(self) -> None:
        """Wait until everything written so far has been heard.

        Never longer than that audio's length plus MARK_SLACK (a player started anew moves
        that end later): a player whose marker doesn't come back is stuck, and waiting on
        it would hold up every reply after this one. It's closed, and the next sentence
        starts a fresh one."""
        if not self.alive:
            return
        future = asyncio.get_running_loop().create_future()
        async with self._io:
            if not self.alive:
                return
            self._next += 1
            self._markers[self._next] = future
            self._marked.append([self._next, len(self._unheard)])
            if self.proc is not self._stuck:
                try:
                    self.proc.stdin.write(self._frame("M", self._next))
                    await self.proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    if self.proc is not self._stuck:
                        raise
        while not future.done():
            end = self._ends_at
            try:
                await asyncio.wait_for(
                    asyncio.shield(future), max(0.0, end - time.monotonic()) + MARK_SLACK
                )
            except TimeoutError:
                if self._revival is not None or self._ends_at > end:
                    continue  # started anew: its end is later now
                log.warning("the voice player stopped answering; starting a new one")
                self.close()
                return

    def stop_now(self) -> None:
        """Barge-in: silence at once, and nothing waits on what was dropped."""
        if self.alive and self.proc is not self._stuck:
            try:
                self.proc.stdin.write(self._frame("S", 0))
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                pass
        self._ends_at = 0.0
        self._settle_all()
        self._forget()

    def close(self) -> None:
        self._closed = True
        proc = self.proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        if self._reader is not None:
            self._reader.cancel()
        if self._ping is not None:
            self._ping[1].cancel()
            self._ping = None
        self._settle_all()
        self._forget()


def resample(pcm: bytes, rate: int, to_rate: int) -> bytes:
    """16-bit mono PCM from one rate to another (the Mac voice's rate differs)."""
    if rate == to_rate or not pcm:
        return pcm
    audio = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32)
    n = max(1, int(len(audio) * to_rate / rate))
    out = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
    return out.astype("<i2").tobytes()


class Source:
    """One sentence's audio, arriving as raw PCM chunks (None marks the end)."""

    def __init__(self, rate: int) -> None:
        self.rate = rate
        self.chunks: asyncio.Queue = asyncio.Queue()
        self.task: asyncio.Task | None = None

    def cancel(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()


def to_pcm(audio: np.ndarray) -> bytes:
    """float audio -> 16-bit little-endian PCM (what the players and the services take)."""
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def from_pcm(pcm: bytes) -> np.ndarray:
    """16-bit little-endian PCM (whole samples) -> float32 audio (to_pcm the other way)."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


class Speaker:
    def __init__(
        self,
        voice: str,
        rate: int,
        muted: bool = False,
        effect: bool = False,
        cloud: CloudVoice | None = None,
    ) -> None:
        # The voice asked for, kept only while it's installed. Whether it is (`say -v ?`,
        # most of a second of CPU) is asked when the voice is first read, not here: the hub
        # sets the voice for its language the moment it's made, so the backend's start
        # waited on a listing nothing used.
        self._voice_name, self._voice_unchecked = voice or "", bool(voice)
        self.rate = rate
        self.muted = muted
        # What a text becomes before it's voiced; the hub sets the chosen language's
        # (Chinese: numbers, times and money said in Chinese).
        self.clean: Callable[[str], str] = clean_for_speech
        self.effect = effect
        self.cloud = cloud
        self.cloud_error = ""
        # The Mac voice to use when the cloud voice fails ("": the voice above). The voice
        # feature picks the best Enhanced or Premium one installed for the language.
        self.fallback_voice = ""
        # The offline voice (local_voice.LocalVoice): `local` speaks when it's the voice
        # picked, `local_fallback` when a cloud voice fails. Set by speaking.Speaking.
        self.local: Any = None
        self.local_fallback: Any = None
        self._local_told = False  # the Mac voice took over from it: said once
        self._procs: set[asyncio.subprocess.Process] = set()  # every `say` running
        self._player: asyncio.subprocess.Process | None = None
        self._playing = False
        self.player_path: Path | None = None  # set once the native player is built
        self._streams = asyncio.Semaphore(3)
        self._live: LivePlayer | None = None
        self._live_lock: asyncio.Lock | None = None
        # What makes the live player (duplex.Duplex's while JARVIS can be talked over).
        self.player_factory: Callable[[Path, int, bool], LivePlayer] = LivePlayer

    @property
    def voice(self) -> str:
        """The Mac voice `say` speaks with ("": the Mac's default). The one given when it
        was made counts only while it's installed (looked up the first time it's read)."""
        if self._voice_unchecked:
            self._voice_unchecked = False
            if self._voice_name not in available_voices():
                self._voice_name = ""
        return self._voice_name

    @voice.setter
    def voice(self, name: str) -> None:
        self._voice_name, self._voice_unchecked = name, False

    @property
    def live_rate(self) -> int:
        return self.cloud.stream_rate if self.cloud is not None else EFFECT_RATE

    async def live(self) -> LivePlayer | None:
        """The running live player, started (or restarted for a new effect setting) as
        needed. None when the native player isn't built."""
        if self.player_path is None:
            return None
        if self._live_lock is None:
            self._live_lock = asyncio.Lock()
        async with self._live_lock:
            current = self._live
            if current is not None and current.alive and current.effect == self.effect:
                return current
            if current is not None:
                current.close()
            factory = getattr(self, "player_factory", LivePlayer)
            fresh = factory(self.player_path, self.live_rate, self.effect)
            try:
                await fresh.start()
            except OSError as exc:
                log.warning("live player didn't start (%s)", exc)
                return None
            self._live = fresh
            return fresh

    def shutdown(self) -> None:
        """Quitting: the live player goes too, and the voice service's connection."""
        self.stop()
        if self._live is not None:
            self._live.close()
            self._live = None
        client = getattr(self.cloud, "_client", None)
        if client is not None and not client.is_closed:
            try:
                self._closing = asyncio.get_running_loop().create_task(client.aclose())
            except RuntimeError:  # no event loop left: the process is ending anyway
                pass

    def stop(self) -> None:
        for proc in (*self._procs, self._player):
            if proc is not None and proc.returncode is None:
                proc.kill()
        if self._live is not None:
            self._live.stop_now()

    def _say_args(self, fallback: bool = False) -> list[str]:
        """`say`'s arguments; fallback: the cloud voice failed, so the fallback voice."""
        args = ["say", "-r", str(self.rate)]
        voice = (getattr(self, "fallback_voice", "") if fallback else "") or self.voice
        if voice:
            args += ["-v", voice]
        return args

    async def say(self, text: str) -> None:
        """Speak one piece of text start to finish (confirmations, one-offs)."""
        spoken = self.clean(text)
        if self.muted or not spoken:
            return
        if self.player_path is not None:
            await self.play_source(self.open(spoken))
            return
        clip = await self.synthesize(spoken)
        if clip is not None:
            await self.play(*clip)

    # ── streaming (native player) ──

    def open(self, spoken: str) -> Source:
        """Start fetching a sentence's audio now; play it with play_source."""
        src = Source(self.cloud.stream_rate if self.cloud is not None else EFFECT_RATE)
        src.task = asyncio.create_task(self._fill(src, spoken))
        return src

    async def _fill(self, src: Source, spoken: str) -> None:
        try:
            async with self._streams:
                if self.cloud is not None:
                    sent = False
                    try:
                        async for chunk in self.cloud.stream(spoken):
                            sent = True
                            src.chunks.put_nowait(chunk)
                        self.cloud_error = ""
                        return
                    except Exception as exc:  # no credit, offline: fall back to the Mac voice
                        self.cloud_error = str(exc)[:200]
                        log.warning("cloud voice failed (%s)", self.cloud_error)
                        if sent:
                            return
                local = self._local_for(spoken)
                if local is not None:
                    src.rate = LOCAL_RATE
                    async for pcm in self._local_pcm(local, spoken):
                        src.chunks.put_nowait(pcm)
                    return
                audio, rate = await self._mac_voice(spoken, fallback=self.cloud is not None)
                src.rate = rate
                src.chunks.put_nowait(to_pcm(audio))
        finally:
            src.chunks.put_nowait(None)

    # ── the offline voice (local_voice.py) ──

    def _local_for(self, spoken: str) -> Any:
        """The offline voice to say this with: the one picked, or the fallback after a
        cloud voice failed. None for the Mac voice (Chinese, or not downloaded)."""
        if self.cloud is None:
            local = getattr(self, "local", None)
        else:
            local = getattr(self, "local_fallback", None)
        return local if local is not None and local.speaks(spoken) else None

    async def _local_pcm(self, local: Any, spoken: str):
        """16-bit PCM at LOCAL_RATE, sentence by sentence. A sentence it can't pronounce
        is said by the Mac voice; when the model fails, the Mac voice says the rest, and
        the first time it also says why (once, until the voice is set up anew)."""
        async for kind, value in local.pieces(spoken):
            if kind == "audio":
                yield to_pcm(value)
                continue
            text = value
            if local.engine.error and not getattr(self, "_local_told", False):
                self._local_told = True  # (English only: Chinese never reaches it)
                text = f"{LOCAL_FAILED} {text}"
            audio, rate = await self._mac_voice(text, fallback=True)
            yield resample(to_pcm(audio), rate, LOCAL_RATE)

    async def _say_wav(self, spoken: str, fallback: bool) -> tuple[np.ndarray, int] | None:
        """The Mac voice saying it into a WAV file (nothing plays): its audio, or None when
        `say` wrote none. fallback: the cloud voice failed, so the fallback voice."""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reply.wav"
            args = self._say_args(fallback) + [
                f"--data-format=LEI16@{EFFECT_RATE}",
                "-o",
                str(path),
            ]
            await self._run(args, spoken)
            return read_wav(path) if path.exists() else None

    async def _mac_voice(self, spoken: str, fallback: bool = False) -> tuple[np.ndarray, int]:
        clip = await self._say_wav(spoken, fallback)
        return clip if clip is not None else (np.zeros(0, np.float32), EFFECT_RATE)

    async def play_source(self, src: Source) -> None:
        """Play audio as it arrives through the native player (effect applied there).
        Muting stops it mid-sentence, and stops fetching the rest."""
        first = await src.chunks.get()
        if first is None:
            return
        if self.muted:
            src.cancel()
            return
        live = await self.live()
        if live is not None:
            self._playing = True
            try:
                chunk, half = first, b""
                while chunk is not None:
                    if self.muted:  # silence what's queued too, and stop fetching
                        live.stop_now()
                        src.cancel()
                        return
                    # Whole samples only. A chunk can end mid-sample, and a stream that dies
                    # mid-sentence leaves half of one: a stray byte in the player would
                    # shift every later sentence by a byte, into full-scale static.
                    data = half + chunk
                    whole = len(data) - len(data) % 2
                    half = data[whole:]
                    await live.write(resample(data[:whole], src.rate, live.rate))
                    chunk = await src.chunks.get()
                await live.mark()
            except (BrokenPipeError, ConnectionResetError):
                pass  # the player went away; the next sentence starts a new one
            finally:
                self._playing = False
            return
        if self.player_path is None:  # no native player: gather it all and use afplay
            parts = [first]
            while (chunk := await src.chunks.get()) is not None:
                parts.append(chunk)
            data = b"".join(parts)
            audio = from_pcm(data[: len(data) - len(data) % 2])  # it can end mid-sample
            if self.effect:
                audio = await asyncio.to_thread(ai_voice_effect, audio, src.rate)
            await self.play(audio, src.rate)
            return
        args = [str(self.player_path), str(src.rate)] + (["--effect"] if self.effect else [])
        proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        self._player = proc
        self._playing = True
        try:
            chunk = first
            while chunk is not None:
                if self.muted:
                    proc.kill()
                    src.cancel()
                    break
                proc.stdin.write(chunk)
                await proc.stdin.drain()
                chunk = await src.chunks.get()
            proc.stdin.close()
            _, err = await proc.communicate()
            if proc.returncode not in (0, -9) and err:
                log.warning("player: %s", err.decode(errors="replace")[:300])
        except (BrokenPipeError, ConnectionResetError):
            pass  # stopped mid-sentence
        except asyncio.CancelledError:
            proc.kill()
            raise
        finally:
            self._playing = False
            self._player = None

    async def synthesize(self, spoken: str) -> tuple[np.ndarray, int] | None:
        """Text -> audio, using the cloud voice when set, falling back to the Mac voice."""
        if self.cloud is not None:
            try:
                audio, rate = await self.cloud.synthesize(spoken)
                self.cloud_error = ""
                # The native player adds the effect itself; only afplay needs it baked in.
                baked = self.effect and self.player_path is None
                return (
                    await asyncio.to_thread(ai_voice_effect, audio, rate) if baked else audio
                ), rate
            except Exception as exc:  # bad key, no credit, offline: fall back to the Mac voice
                self.cloud_error = str(exc)[:200]
        local = self._local_for(spoken)
        if local is not None:
            pcm = b"".join([chunk async for chunk in self._local_pcm(local, spoken)])
            audio = from_pcm(pcm)
            if self.effect and self.player_path is None:
                audio = await asyncio.to_thread(ai_voice_effect, audio, LOCAL_RATE)
            return audio, LOCAL_RATE
        clip = await self._say_wav(spoken, fallback=self.cloud is not None)
        if clip is None:
            return None
        audio, rate = clip
        if self.effect and self.player_path is None:
            audio = await asyncio.to_thread(ai_voice_effect, audio, rate)
        return audio, rate

    async def _run(self, args: list[str], spoken: str) -> None:
        # Text goes over stdin so a reply starting with "-" is never read as a flag.
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE)
        self._procs.add(proc)  # a phone's clip being made never hides the Mac's own voice
        try:
            await proc.communicate(spoken.encode())
        except asyncio.CancelledError:
            proc.kill()
            raise
        finally:
            self._procs.discard(proc)

    async def play(self, audio: np.ndarray, rate: int) -> None:
        """Play a finished clip: through the live player when it's running (instant), else
        macOS's own player (afplay). Nothing while muted."""
        if self.muted:
            return
        live = await self.live()
        if live is not None:
            self._playing = True
            try:
                await live.write(resample(to_pcm(audio), rate, live.rate))
                await live.mark()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self._playing = False
            return
        await self._afplay(audio, rate)

    async def _afplay(self, audio: np.ndarray, rate: int) -> None:
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
# Mid-stream, a sentence only ends where whitespace follows: "It is 23." or "at 3:" at the
# end of the buffer may be "23.5 degrees" or "3:30" once the next words arrive.
_SENTENCE_SO_FAR = re.compile(r"(.+?[.!?…:;])(\s+)", re.DOTALL)
_NOT_SPACE = re.compile(r"\S")


def split_sentences(buffer: str, final: bool = False, min_chars: int = 12) -> tuple[list[str], str]:
    """Pull complete sentences off the front of a streaming buffer.

    Very short fragments ("Sure.") wait to join the next sentence so every clip is worth a
    round trip to the voice service. With final=True the rest is flushed. The buffer is
    read by position, never sliced per sentence: a long reply splits in linear time.
    """
    pattern = _SENTENCE if final else _SENTENCE_SO_FAR
    out: list[str] = []
    pos, pending = 0, ""
    while (match := pattern.match(buffer, pos)) is not None:
        sentence = (pending + " " + match.group(1)).strip()
        pos = match.end()
        if len(sentence) < min_chars and _NOT_SPACE.search(buffer, pos):
            pending = sentence
            continue
        out.append(sentence)
        pending = ""
    rest = buffer[pos:]
    # The tail keeps its trailing space: the next chunk may go on with another word
    # ("Sure. The quick " + "brown fox."), and only the final flush trims.
    rest = f"{pending} {rest.lstrip()}" if pending else rest
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
        self._pending = 0  # clips queued and not yet played (or dropped)
        self._gen = 0  # bumped by clear(): a play loop from before it no longer counts
        self._idle = asyncio.Event()
        self._idle.set()
        self._player: asyncio.Task | None = None
        self._sources: list[Source] = []
        # [what it said, when that finished playing (None: playing now)], from the moment
        # each clip starts: a sentence still waiting its turn can't come back through the
        # microphone, and counting those took the user's barge-ins for echoes.
        self._said: list[list[Any]] = []

    def push(self, text: str) -> None:
        spoken = getattr(self.speaker, "clean", clean_for_speech)(text)
        if self.speaker.muted or not spoken:
            return
        self._pending += 1
        self._idle.clear()
        self._clips.put_nowait((asyncio.create_task(self._synth(spoken)), spoken))
        if self._player is None or self._player.done():
            self._player = asyncio.create_task(self._play_loop())

    def push_clip(self, clip: tuple[np.ndarray, int], text: str = "") -> None:
        """Queue audio that's already made (the instant 'One moment.' fillers); text is
        what it says."""
        if self.speaker.muted:
            return
        heard = getattr(self.speaker, "clean", clean_for_speech)(text) if text else ""
        self._pending += 1
        self._idle.clear()
        future = asyncio.get_running_loop().create_future()
        future.set_result(clip)
        self._clips.put_nowait((future, heard))
        if self._player is None or self._player.done():
            self._player = asyncio.create_task(self._play_loop())

    async def _synth(self, spoken: str):
        if getattr(self.speaker, "player_path", None) is not None:
            src = self.speaker.open(spoken)
            self._sources.append(src)
            return src
        async with self._limit:
            return await self.speaker.synthesize(spoken)

    async def _play_loop(self) -> None:
        gen = self._gen
        while gen == self._gen and not self._clips.empty():
            task, heard = await self._clips.get()
            said = None
            try:
                clip = await task
                if self.speaker.muted:  # muted after it was queued: drop it unheard
                    if isinstance(clip, Source):
                        clip.cancel()
                elif isinstance(clip, Source):
                    said = self._remember(heard)
                    self.on_speaking(True)
                    await self.speaker.play_source(clip)
                elif clip is not None:
                    said = self._remember(heard)
                    self.on_speaking(True)
                    await self.speaker.play(*clip)
            except asyncio.CancelledError:
                raise
            except Exception:  # one bad clip shouldn't silence the rest, but say so
                log.exception("couldn't play a reply clip")
            finally:
                if said is not None and said[1] is None:
                    said[1] = time.monotonic()  # it may come back until ECHO_WINDOW after
                # After clear() the count restarted at zero without this clip: taking it
                # off again would leave -1, which reads as "still speaking".
                if gen == self._gen:
                    self._pending = max(0, self._pending - 1)
        if gen != self._gen:
            return
        self._sources = [s for s in self._sources if s.task is not None and not s.task.done()]
        self._finished()
        self.on_speaking(False)
        self._idle.set()

    async def drain(self) -> None:
        await self._idle.wait()

    def clear(self) -> None:
        self._gen += 1
        while not self._clips.empty():
            self._clips.get_nowait()[0].cancel()
        if self._player is not None:
            self._player.cancel()
            self._player = None  # a push right after this gets a loop of its own
        for src in self._sources:
            src.cancel()
        self._sources.clear()
        self.speaker.stop()
        self._pending = 0
        self._finished()
        self._idle.set()
        self.on_speaking(False)

    # ── what it just said, for telling its own voice from the user's ──

    def _remember(self, heard: str) -> list[Any] | None:
        """A clip starts playing: from now its words may come back through the mic."""
        if not heard:
            return None
        now = time.monotonic()
        self._said = [s for s in self._said if s[1] is None or now - s[1] < 60]
        entry = [heard, None]
        self._said.append(entry)
        return entry

    def _finished(self) -> None:
        now = time.monotonic()
        for said in self._said:
            if said[1] is None:
                said[1] = now

    def said_recently(self, seconds: float = 12.0) -> str:
        """What it said in the last `seconds`, counting each piece until that long after
        it finished playing (a long reply doesn't age out the sentence playing now): what
        the microphone may hear back."""
        now = time.monotonic()
        return " ".join(text for text, done in self._said if done is None or now - done < seconds)
