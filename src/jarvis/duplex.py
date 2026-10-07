"""Talk over Jarvis (Settings › Listening): the Mac's echo cancellation between JARVIS's voice
and the microphone, so speaking while JARVIS talks interrupts it without the wake word.

Echo cancellation needs the voice and the microphone in one audio engine: the canceller
subtracts what it plays from what it hears. So while talk-over is on, one helper,
audio/jarvis-duplex.swift, does both: JARVIS's voice goes to it exactly as it goes to the
usual player (Speaker.player_factory makes a DuplexPlayer, the same live protocol), and it
hands back the microphone, echo cancelled, through a pipe; the hands-free listener reads
that (ContinuousListener.source) instead of PortAudio.

- It runs only while hands-free listens and the setting is on (it's off until the owner
  turns it on). Hands-free off closes it, and the microphone with it.
- With AirPods (or any headset) as the Mac's input and the built-in microphone chosen in
  Settings, it doesn't start: opening their microphone would drop them into call quality.
  Anything else that goes wrong (it can't be built, voice processing won't start, the
  helper dies) puts things back as they were: the usual player and microphone, the wake
  word to interrupt. Settings says why.
- While you talk over JARVIS, its voice drops to a quarter of its volume at once (the
  neural detector hears you start); what you said is then handled as if you had said
  "Jarvis" first (Hub.on_heard: a request, a stop, an answer to its question), and a
  voice that turns out to be nothing gets its volume back 1.5 s later.

Cost policy: no model is called; this is audio plumbing on the Mac.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import queue
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .speech import LivePlayer, Speaker, from_pcm

log = logging.getLogger("jarvis")

HELPER = "jarvis-duplex"
BLOCK = 800  # samples in a microphone block (50 ms at 16 kHz), as the listener expects
READY_SECONDS = 6.0  # the echo-cancelled microphone confirmed within this long, or not at all
PLAYER_SECONDS = 30.0  # the usual voice player built (it's what proves swiftc works here)
DUCK = 250  # permille of the voice's volume while you talk over it
UNDUCK_SECONDS = 1.5  # back to full volume this long after a voice that interrupted nothing
CRASHES = 3  # the helper dying this often in CRASH_WINDOW: it's given up on
CRASH_WINDOW = 120.0


class DuplexPlayer(LivePlayer):
    """The live player, played through the duplex helper (which also hears the microphone).
    Everything the Speaker does with a LivePlayer works the same."""

    def __init__(self, duplex: Duplex, rate: int, effect: bool) -> None:
        super().__init__(duplex.path or Path("jarvis-duplex"), rate, effect)
        self.duplex = duplex
        self.input = duplex.input_preference()  # the microphone it was started on

    async def start(self) -> None:
        read, write = os.pipe()
        args = [str(self.path), str(self.rate), "--live"] + (["--effect"] if self.effect else [])
        args += ["--capture-fd", str(write), "--input", self.input]
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                pass_fds=(write,),
            )
        except OSError:
            os.close(read)
            raise
        finally:
            os.close(write)  # the helper has its own copy; its end closing means it's gone
        self.duplex.attach(self, read)
        self._reader = asyncio.create_task(self._read())

    def _line(self, parts: list[str]) -> None:
        if parts[:1] == ["C"]:
            self.duplex.capture_ready(self, " ".join(parts[1:]))
        elif parts[:1] == ["E"]:
            self.duplex.refused(self, " ".join(parts[1:]))

    def volume(self, permille: int) -> None:
        if self.alive:
            with contextlib.suppress(BrokenPipeError, ConnectionResetError, RuntimeError):
                self.proc.stdin.write(self._frame("V", max(0, min(1000, permille))))

    def stop_now(self) -> None:
        super().stop_now()
        self.volume(1000)  # talked over and stopped: the next reply is heard in full


class Duplex:
    """Talk-over's state, the Speaker's player factory and the listener's microphone."""

    def __init__(self, hub: Any, on_change: Callable[[], None]) -> None:
        self.hub = hub
        self.on_change = on_change
        self.path: Path | None = None
        self.state = "off"  # off | preparing | on | unavailable
        self.why = ""
        self.device = ""  # the microphone it hears through
        self.player: DuplexPlayer | None = None
        self._queue: queue.Queue | None = None  # the listener's, while it listens through us
        self._lock = threading.Lock()
        self._confirmed: asyncio.Future | None = None
        self._crashes: list[float] = []
        self._heard = False  # the owner's voice, heard while JARVIS talked
        self._reopening = False  # we asked the listener to reopen (not a stall)
        self._stalls = 0  # times the listener gave up on it while the helper ran
        self._unduck: asyncio.TimerHandle | None = None
        self._busy: asyncio.Task | None = None

    # ── what's wanted ──

    def wanted(self) -> bool:
        prefs = self.hub.prefs
        return bool(prefs.feature("voice_talk_over")) and bool(getattr(prefs, "hands_free", False))

    def input_preference(self) -> str:
        return "default" if getattr(self.hub.prefs, "mic", "builtin") == "default" else "builtin"

    def active(self) -> bool:
        """Whether JARVIS can be talked over now (hub.talk_over): the echo-cancelled
        microphone is the one hands-free is hearing through."""
        player = self.player
        return (
            self.state == "on" and player is not None and player.alive and self._queue is not None
        )

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "why": self.why, "device": self.device}

    def _set(self, state: str, why: str = "") -> None:
        self.state, self.why = state, why
        self.on_change()

    # ── on and off ──

    async def refresh(self) -> None:
        """Start or stop it to match Settings and hands-free (one change at a time)."""
        while self._busy is not None and not self._busy.done():
            await asyncio.shield(self._busy)
        self._busy = asyncio.ensure_future(self._refresh())
        await asyncio.shield(self._busy)

    async def _refresh(self) -> None:
        from . import audio

        if not self.wanted():
            await self._stop()
            if self.state != "off":
                self._set("off")
            return
        player = self.player
        if player is not None and player.alive and player.input != self.input_preference():
            await self._stop()  # another microphone was chosen: start again on it
            self.state = "off"
        if self.state == "unavailable" or (self.player is not None and self.player.alive):
            return
        speaker = self.hub.speaker
        if not isinstance(speaker, Speaker):
            return  # a test's stand-in speaker: nothing to play through
        self._set("preparing")
        if self.path is None:
            self.path = await asyncio.to_thread(audio.build, HELPER)
        if self.path is None:
            self._set("unavailable", "the helper couldn't be built on this Mac (swiftc)")
            return
        # JARVIS's own player proves the voice path works; wait for it to be built.
        deadline = time.monotonic() + PLAYER_SECONDS
        while speaker.player_path is None and time.monotonic() < deadline:
            await asyncio.sleep(0.25)
        if speaker.player_path is None:
            self._set("unavailable", "Jarvis's voice player isn't ready")
            return
        loop = asyncio.get_running_loop()
        self._confirmed = loop.create_future()
        speaker.player_factory = self.make_player
        await self._retire(LivePlayer)  # the usual player gives way (once it has finished)
        live = await speaker.live()
        if not isinstance(live, DuplexPlayer):
            await self._give_up("the voice couldn't be moved to the echo-cancelling player")
            return
        try:
            why = await asyncio.wait_for(asyncio.shield(self._confirmed), READY_SECONDS)
        except TimeoutError:
            why = "the echo-cancelled microphone didn't start"
        if why:
            await self._give_up(why)
            return
        self._set("on")
        log.info("talk-over on: echo-cancelled microphone %s", self.device)
        self._reopen_listener()

    async def _give_up(self, why: str) -> None:
        log.warning("talk-over unavailable: %s", why)
        await self._stop()
        self._set("unavailable", why)

    async def _stop(self) -> None:
        """Back to the usual player and microphone (the current reply finishes first).
        The listener is reopened only if it hears through this (or may be about to): one
        on its usual microphone already is. Every start with talk-over off reopened the
        microphone the listener had opened a moment before."""
        hearing = self._queue is not None or self.state == "on"
        speaker = self.hub.speaker
        if isinstance(speaker, Speaker):
            speaker.player_factory = LivePlayer
        await self._retire(DuplexPlayer)
        self.player = None
        if hearing or self._queue is not None:
            self._reopen_listener()

    async def _retire(self, kind: type) -> None:
        """Close the Speaker's live player if it's of this kind, once it's done speaking."""
        speaker = self.hub.speaker
        current = getattr(speaker, "_live", None)
        if type(current) is not kind or not current.alive:
            return
        if getattr(self.hub, "state", "") == "speaking":
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.hub.speech.drain(), 60)
        current.close()

    def reset(self) -> None:
        """The setting was switched: a helper that was unavailable is tried again."""
        if self.state == "unavailable":
            self.state, self.why = "off", ""
        self._crashes.clear()
        self._stalls = 0

    def _reopen_listener(self) -> None:
        listener = getattr(self.hub, "_listener", None)
        if listener is not None and getattr(listener, "running", False):
            reopen = getattr(listener, "reopen", None)
            if reopen is not None:
                self._reopening = True
                reopen()

    # ── the Speaker's side ──

    def make_player(self, path: Path, rate: int, effect: bool) -> LivePlayer:
        """Speaker.player_factory while talk-over is on: the duplex player (restarted if
        it died), else the usual one."""
        if self.state in ("preparing", "on") and self.path is not None:
            player = DuplexPlayer(self, rate, effect)
            self.player = player
            return player
        return LivePlayer(path, rate, effect)

    def attach(self, player: DuplexPlayer, fd: int) -> None:
        threading.Thread(
            target=self._pump, args=(player, fd), name="jarvis-duplex-mic", daemon=True
        ).start()

    def capture_ready(self, player: DuplexPlayer, device: str) -> None:
        if player is not self.player:
            return
        self.device = device
        if self._confirmed is not None and not self._confirmed.done():
            self._confirmed.set_result("")
        elif self.state == "on" and self._queue is None:
            self._reopen_listener()  # restarted after a crash: hands-free comes back to it

    def refused(self, player: DuplexPlayer, why: str) -> None:
        if player is not self.player:
            return
        if self._confirmed is not None and not self._confirmed.done():
            self._confirmed.set_result(why or "the helper stopped")

    # ── the microphone's side ──

    def source(self, blocks: queue.Queue) -> Any:
        """ContinuousListener.source: the echo-cancelled microphone while it's on, else
        None (PortAudio's stream, as always)."""
        player = self.player
        if self.state != "on" or player is None or not player.alive:
            return None
        return self._listening(blocks)

    @contextlib.contextmanager
    def _listening(self, blocks: queue.Queue):
        with self._lock:
            self._queue = blocks
        log.info("hands-free microphone open: %s, echo cancelled", self.device or "the Mac's")
        try:
            yield
        finally:
            with self._lock:
                if self._queue is blocks:
                    self._queue = None
            self._on_loop(self._closed)

    def _closed(self) -> None:
        """The listener let go. Hands-free off: the microphone closes too. Given up on
        while the helper runs (nothing arrived for 2 s), twice: the usual microphone."""
        asked, self._reopening = self._reopening, False
        if not self.wanted():
            self.hub._spawn(self.refresh())
            return
        player = self.player
        if asked or self.state != "on" or player is None or not player.alive:
            return  # asked for, or the helper died (_ended counts that)
        self._stalls += 1
        if self._stalls >= 2:
            self.hub._spawn(self._give_up("the echo-cancelled microphone went quiet"))

    def _pump(self, player: DuplexPlayer, fd: int) -> None:
        """The helper's microphone (16 kHz 16-bit PCM), as 50 ms float blocks, into the
        listener's queue while it listens through us."""
        rest = b""
        with os.fdopen(fd, "rb", buffering=0) as pipe:
            while True:
                try:
                    data = pipe.read(BLOCK * 8)
                except OSError:
                    break
                if not data:
                    break
                rest += data
                while len(rest) >= BLOCK * 2:
                    chunk, rest = rest[: BLOCK * 2], rest[BLOCK * 2 :]
                    with self._lock:
                        target = self._queue if player is self.player else None
                    if target is not None:
                        target.put(from_pcm(chunk))
        with self._lock:
            target = self._queue if player is self.player else None
        if target is not None:
            target.put(None)  # the helper is gone: the listener opens its usual microphone
        self._on_loop(lambda: self._ended(player))

    def _ended(self, player: DuplexPlayer) -> None:
        """The helper exited. Often enough in a short while: given up on (Settings says so);
        otherwise the next sentence starts a new one, and hands-free comes back to it."""
        # Its microphone's end can come before the process is reaped: closed now, so the
        # Speaker doesn't take it for alive and keep sending it sentences.
        player.close()
        if player is not self.player or self.state != "on":
            return
        if getattr(self.hub.speaker, "_live", None) is not player:
            # The Speaker let it go (quitting): not a crash. Taken for one, the helper and
            # the Mac's microphone started again while the app quit.
            return
        now = time.monotonic()
        self._crashes = [t for t in self._crashes if now - t < CRASH_WINDOW] + [now]
        if len(self._crashes) >= CRASHES:
            self.hub._spawn(self._give_up("the echo-cancelling helper kept stopping"))
            return
        log.warning("the echo-cancelling helper stopped; starting it again")
        self.hub._spawn(self._restart())

    async def _restart(self) -> None:
        speaker = self.hub.speaker
        if isinstance(speaker, Speaker) and self.state == "on":
            await speaker.live()  # the factory makes a new duplex player

    # ── talking over it ──

    def heard(self, speaking: bool) -> None:
        """Each hands-free block (on the microphone's thread): whether someone is talking.
        Talking starts while JARVIS speaks: its voice ducks at once."""
        if speaking == self._heard:
            return
        self._heard = speaking
        if self.active():
            self._on_loop(self._duck if speaking else self._later_unduck)

    def _duck(self) -> None:
        if self._unduck is not None:
            self._unduck.cancel()
            self._unduck = None
        if getattr(self.hub, "state", "") == "speaking" and self.player is not None:
            self.player.volume(DUCK)

    def _later_unduck(self) -> None:
        loop = asyncio.get_running_loop()
        if self._unduck is not None:
            self._unduck.cancel()
        self._unduck = loop.call_later(UNDUCK_SECONDS, self._full_volume)

    def _full_volume(self) -> None:
        self._unduck = None
        if self.player is not None:
            self.player.volume(1000)

    def _on_loop(self, fn: Callable[[], None]) -> None:
        loop = getattr(self.hub, "_loop", None)
        if loop is None:
            return
        with contextlib.suppress(RuntimeError):  # the app is closing
            loop.call_soon_threadsafe(fn)
