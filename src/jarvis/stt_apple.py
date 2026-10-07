"""Apple's on-device speech recognition for hands-free (Settings › Listening › Speech
recognition › Apple): SpeechAnalyzer and SpeechTranscriber (macOS 26+) in a small helper,
audio/jarvis-hear.swift. It never opens the microphone.

The hands-free listener hands every block to Recognizer.tap(). While the segmenter hears an
utterance, its blocks (and the pre-roll kept before it) go to the helper, which starts a
fresh analyzer for each utterance; between utterances nothing is sent, so the model only
works while someone talks. Words come back as they're recognized (captions for the window,
and the wake word spotted in them), and when the hub asks for an utterance's transcript
(hub.heard_live, from Hub._transcribe) the helper finalizes it: about 0.2 s after the
request, where Whisper starts transcribing only then. Which utterance is meant is found by
its last block, whose place in the stream the tap wrote down.

Anything that goes wrong (the helper can't be built, the model isn't installed, the helper
dies or takes too long) leaves the utterance to Whisper, as before, and the pane says why.

Apple's model for a language is downloaded by macOS, from Apple, only when the owner
presses Download in Settings (English is usually on the Mac already).

Cost policy: no Claude model is called; everything runs on this Mac (the Neural Engine).
"""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
import queue
import subprocess
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from .speech import to_pcm

log = logging.getLogger("jarvis")

HELPER = "jarvis-hear"
BLOCK = 800  # samples in a microphone block (50 ms at 16 kHz)
PREROLL = 6  # blocks kept before an utterance starts (the segmenter keeps as many)
REMEMBER = 1200  # blocks whose place in the stream is kept (a minute of speech)
READY_SECONDS = 30.0  # the first start loads Apple's model
ANSWER_SECONDS = 1.5  # an utterance's words, at most this long after asking; else Whisper
IDLE_SECONDS = 120.0  # no audio for this long (hands-free off): the helper is let go
QUEUE_FRAMES = 600  # frames waiting for the helper (30 s of audio) before it's given up on


def _code(language: str) -> str:
    """The helper's language for one of JARVIS's: "zh" (Mandarin), else "en"."""
    return "zh" if language == "zh" else "en"


def _digest(block: np.ndarray) -> bytes:
    return hashlib.blake2b(np.ascontiguousarray(block).tobytes(), digest_size=8).digest()


def _frame(kind: bytes, body: bytes = b"") -> bytes:
    return kind + len(body).to_bytes(4, "little") + body


def run_json(path: Path, mode: str, language: str, timeout: float = 30.0) -> dict[str, Any]:
    """One answer from the helper (status or size), or {"error"} when it gives none."""
    code = _code(language)
    try:
        done = subprocess.run(
            [str(path), mode, code], capture_output=True, text=True, timeout=timeout, check=False
        )
        for line in done.stdout.splitlines():
            data = json.loads(line)
            if isinstance(data, dict):
                return data
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return {"error": str(exc)[:200]}
    return {"error": "no answer"}


def install(path: Path, language: str, progress: Callable[[float, int], None]) -> str:
    """Have macOS download Apple's model for the language: "" when done, else why not.
    progress(fraction, bytes) as it goes. Blocks: run it in a thread."""
    code = _code(language)
    try:
        proc = subprocess.Popen(
            [str(path), "install", code], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
    except OSError as exc:
        return str(exc)[:200]
    why = "it stopped"
    for line in proc.stdout or ():
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if data.get("done"):
            why = ""
        elif "error" in data:
            why = str(data["error"])[:200]
        elif "progress" in data:
            progress(float(data.get("progress") or 0), int(data.get("bytes") or 0))
    proc.wait()
    return why


class Recognizer:
    """One jarvis-hear listening, fed utterances by the tap. Thread-safe: the tap runs on
    the microphone's thread, words_for on the hub's worker threads."""

    def __init__(self, path: Path, language: str, on_result: Callable[[dict], None]) -> None:
        self.path = path
        self.language = language
        self.on_result = on_result  # each partial or final result (on the reader thread)
        self.locale = ""
        self.failed = ""  # why it stopped ("" while it works)
        self.ready = threading.Event()
        self.proc: subprocess.Popen | None = None
        self._lock = threading.RLock()  # _send may fail it while the lock is held
        self._writes: queue.Queue[bytes | None] = queue.Queue(maxsize=QUEUE_FRAMES)
        self._position = 0  # samples sent
        self._ends: OrderedDict[bytes, int] = OrderedDict()  # block digest -> position after it
        self._ring: deque[np.ndarray] = deque(maxlen=PREROLL)
        self._speaking = False
        self.utterance_start = 0  # where the utterance being heard began
        self._answers: dict[int, list[Any]] = {}
        self._ids = itertools.count(1)
        self._strings: tuple[str, ...] = ()
        self.last_audio = time.monotonic()

    @property
    def alive(self) -> bool:
        return not self.failed and self.proc is not None and self.proc.poll() is None

    def start(self, timeout: float = READY_SECONDS) -> bool:
        """Start the helper and wait for its model (blocks: run it in a thread)."""
        code = _code(self.language)
        try:
            self.proc = subprocess.Popen(
                [str(self.path), "listen", code],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            self.failed = str(exc)[:200]
            return False
        threading.Thread(target=self._read, name="jarvis-hear-read", daemon=True).start()
        threading.Thread(target=self._write, name="jarvis-hear-write", daemon=True).start()
        if not self.ready.wait(timeout) or self.failed:
            self._fail(self.failed or "Apple's model took too long to load")
            return False
        return True

    # ── the microphone's side ──

    def tap(self, block: np.ndarray, speaking: bool) -> None:
        """Every hands-free block, and whether an utterance is being heard (before the
        segmenter takes this block): an utterance's blocks go to the helper."""
        if not self.alive:
            return
        with self._lock:
            if speaking and not self._speaking:
                self._speaking = True
                self.utterance_start = self._position
                self._send(_frame(b"B"))
                for kept in self._ring:
                    self._feed(kept)
                self._ring.clear()
            if speaking:
                self._feed(block)
            else:
                self._speaking = False
                self._ring.append(block)

    def _feed(self, block: np.ndarray) -> None:
        self._position += len(block)
        self._ends[_digest(block)] = self._position
        while len(self._ends) > REMEMBER:
            self._ends.popitem(last=False)
        self.last_audio = time.monotonic()
        self._send(_frame(b"A", to_pcm(block)))

    def _send(self, data: bytes) -> None:
        try:
            self._writes.put_nowait(data)
        except queue.Full:
            self._fail("Apple's recognizer fell behind")

    # ── the hub's side ──

    def words_for(self, audio: np.ndarray, timeout: float = ANSWER_SECONDS) -> str | None:
        """The words of an utterance the tap sent (found by its last block); None when it
        wasn't sent, or no answer came in time (Whisper then transcribes it)."""
        if not self.alive or getattr(audio, "size", 0) < BLOCK:
            return None
        key = _digest(np.asarray(audio, dtype=np.float32)[-BLOCK:])
        with self._lock:
            end = self._ends.get(key)
            if end is None:
                return None
            ask = next(self._ids)
            waiter: list[Any] = [threading.Event(), None]
            self._answers[ask] = waiter
            body = json.dumps({"id": ask, "start": max(0, end - int(audio.size)), "end": end})
            self._send(_frame(b"F", body.encode()))
        if not waiter[0].wait(timeout):
            with self._lock:
                self._answers.pop(ask, None)
            log.info("Apple's recognizer took too long; Whisper transcribes this one")
            return None
        return waiter[1]

    def context(self, strings: list[str]) -> None:
        """Words to listen for: wake words, names, the owner's learned words."""
        kept = tuple(dict.fromkeys(s.strip() for s in strings if s and s.strip()))[:100]
        with self._lock:
            if kept == self._strings or not self.alive:
                return
            self._strings = kept
            self._send(_frame(b"C", json.dumps({"strings": list(kept)}).encode()))

    def close(self) -> None:
        self._fail(self.failed or "closed")

    # ── the helper's side ──

    def _write(self) -> None:
        proc = self.proc
        while proc is not None:
            data = self._writes.get()
            if data is None:
                break
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
            except (OSError, ValueError):
                self._fail("Apple's recognizer stopped")
                break

    def _read(self) -> None:
        proc = self.proc
        try:
            for line in proc.stdout if proc is not None else ():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("t")
                if kind == "ready":
                    self.locale = str(event.get("locale") or "")
                    self.ready.set()
                elif kind == "done":
                    with self._lock:
                        waiter = self._answers.pop(int(event.get("id") or 0), None)
                    if waiter is not None:
                        waiter[1] = str(event.get("text") or "")
                        waiter[0].set()
                elif kind in ("partial", "final"):
                    try:
                        self.on_result(event)
                    except Exception:
                        log.exception("a live caption failed")
                elif kind == "error":
                    why = str(event.get("why") or "failed")[:200]
                    log.warning("Apple's recognizer: %s", why)
                    if not self.ready.is_set():
                        self.failed = why
                        self.ready.set()
        finally:
            self._fail(self.failed or "Apple's recognizer stopped")

    def _fail(self, why: str) -> None:
        with self._lock:
            first = not self.failed
            self.failed = self.failed or why
            answers, self._answers = self._answers, {}
        for waiter in answers.values():
            waiter[0].set()  # nobody waits on a helper that's gone
        self.ready.set()
        if first:
            try:
                self._writes.put_nowait(None)
            except queue.Full:
                pass
            proc = self.proc
            if proc is not None and proc.poll() is None:
                proc.kill()


class LiveEars:
    """The hub's side of Apple's recognizer: running while Settings says Apple (and
    hands-free listens), fed by the listener's tap, asked for each utterance's words
    (hub.heard_live), and showing what it hears as live captions (a "voice_live" event)
    when it's for Jarvis: the wake word heard in it, or Jarvis listening for an answer.

    state: "off" (Whisper), "preparing" (building the helper, checking the model, loading
    it), "needs_model" (Apple's model for the language isn't on this Mac: Download),
    "downloading", "on", or "failed" (why says why; Whisper listens)."""

    def __init__(self, hub: Any, on_change: Callable[[], None]) -> None:
        self.hub = hub
        self.on_change = on_change  # the pane's state changed
        self.recognizer: Recognizer | None = None
        self.path: Path | None = None
        self.state = "off"
        self.why = ""
        self.locale = ""
        self.progress = 0.0
        self.bytes = 0
        self._refreshing: Any = None  # the refresh under way (an asyncio task)
        self._asked = False  # a refresh is already asked for from the microphone's thread
        self._parts: list[dict[str, Any]] = []  # the caption's results
        self._caption_start = -1
        self._woke = False  # this utterance named a wake word

    def wanted(self) -> bool:
        return self.hub.prefs.feature("voice_engine") == "apple"

    def _language(self) -> str:
        """The recognizer's language for the one JARVIS listens in now."""
        return _code(self.hub.prefs.language)

    def public(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "why": self.why,
            "locale": self.locale,
            "progress": round(self.progress, 3),
            "bytes": self.bytes,
        }

    def _set(self, state: str, why: str = "") -> None:
        self.state, self.why = state, why
        self.on_change()

    # ── bringing it in line with Settings ──

    async def refresh(self) -> None:
        """Start, stop or restart the recognizer for the setting and the language (one
        refresh at a time; a second waits for the first)."""
        import asyncio

        while self._refreshing is not None and not self._refreshing.done():
            await asyncio.shield(self._refreshing)
        self._refreshing = asyncio.ensure_future(self._refresh())
        await asyncio.shield(self._refreshing)

    async def _refresh(self) -> None:
        import asyncio

        from . import audio

        self._asked = False
        language = self._language()
        current = self.recognizer
        if not self.wanted():
            self._stop()
            if self.state != "off":
                self._set("off")
            return
        if current is not None and current.alive and current.language == language:
            return
        self._stop()
        self._set("preparing")
        if self.path is None:
            self.path = await asyncio.to_thread(audio.build, HELPER)
        if self.path is None:
            self._set("failed", "the recognizer couldn't be built on this Mac (swiftc)")
            return
        status = await asyncio.to_thread(run_json, self.path, "status", language)
        self.locale = str(status.get("locale") or "")
        if not status.get("available"):
            # No answer at all is a helper that can't run here (the downloadable app's is
            # built for macOS 26, which SpeechAnalyzer needs): the plain sentence says so.
            said = status.get("error") if "available" in status else ""
            why = said or "Apple's speech recognition isn't available on this Mac"
            self._set("failed", str(why))
            return
        if not status.get("installed"):
            size = await asyncio.to_thread(run_json, self.path, "size", language)
            self.bytes = int(size.get("bytes") or 0) if isinstance(size.get("bytes"), int) else 0
            self._set("needs_model")
            return
        if not self.wanted():  # switched back meanwhile
            self._set("off")
            return
        recognizer = Recognizer(self.path, language, self._result_threadsafe)
        if not await asyncio.to_thread(recognizer.start):
            self._set("failed", recognizer.failed)
            return
        self.recognizer = recognizer
        self.locale = recognizer.locale or self.locale
        recognizer.context(self.words_to_hear())
        self._set("on")
        self.hub._spawn(self._watch(recognizer))

    async def download(self) -> None:
        """Have macOS download Apple's model for the language (the owner pressed Download)."""
        import asyncio

        if self.state != "needs_model" or self.path is None:
            return
        language = self._language()
        loop = asyncio.get_running_loop()
        self.progress = 0.0
        self._set("downloading")

        def progress(fraction: float, size: int) -> None:
            def show() -> None:
                self.progress, self.bytes = fraction, size or self.bytes
                self.on_change()

            loop.call_soon_threadsafe(show)

        why = await asyncio.to_thread(install, self.path, language, progress)
        if why:
            self._set("needs_model", why)
            return
        await self.refresh()

    async def _watch(self, recognizer: Recognizer) -> None:
        """Let an idle recognizer go (hands-free is off): the tap starts it again."""
        import asyncio

        while recognizer is self.recognizer and recognizer.alive:
            await asyncio.sleep(30)
            if time.monotonic() - recognizer.last_audio > IDLE_SECONDS:
                listener = getattr(self.hub, "_listener", None)
                if listener is None or not getattr(listener, "running", False):
                    log.info("Apple's recognizer is idle; letting it go")
                    self._stop()
                    return
        if recognizer is self.recognizer and recognizer.failed and self.wanted():
            self.recognizer = None
            self._set("failed", recognizer.failed)

    def _stop(self) -> None:
        if self.recognizer is not None:
            self.recognizer.close()
            self.recognizer = None

    def words_to_hear(self) -> list[str]:
        """The wake words and the owner's learned words: the recognizer's hints."""
        from . import wake

        words = list(wake.wake_names())
        hearing = getattr(self.hub, "hearing", None)
        if hearing is not None:
            try:
                words += hearing.hotwords("").split()
            except Exception:  # the learned words can't be read now: the names still help
                pass
        return words

    # ── the microphone's side (its thread) ──

    def tap(self, block: np.ndarray, speaking: bool) -> None:
        recognizer = self.recognizer
        if recognizer is not None and recognizer.alive:
            if recognizer.language != self._language():
                self._ask_refresh()  # the language changed: its model follows
            recognizer.tap(block, speaking)
        elif self.wanted() and self.state in ("on", "off"):
            self._ask_refresh()  # let go while idle, or not started yet: start it

    def _ask_refresh(self) -> None:
        loop = getattr(self.hub, "_loop", None)
        if self._asked or loop is None:
            return
        self._asked = True
        try:
            loop.call_soon_threadsafe(lambda: self.hub._spawn(self.refresh()))
        except RuntimeError:  # the app is closing
            pass

    # ── the hub's side ──

    def heard_live(self, audio: Any) -> str | None:
        """hub.heard_live: the words of an utterance Apple heard, cleaned as Whisper's are;
        None when Whisper should transcribe it. Runs on a worker thread."""
        from . import lang

        recognizer = self.recognizer
        if recognizer is None or not recognizer.alive:
            return None
        language = self._language()
        if recognizer.language != language:
            return None
        recognizer.context(self.words_to_hear())
        text = recognizer.words_for(audio)
        if text is None:
            return None
        return lang.clean_transcript(text.lstrip(" ,.;:…、，。"), language)

    # ── captions ──

    def _result_threadsafe(self, event: dict[str, Any]) -> None:
        loop = getattr(self.hub, "_loop", None)
        if loop is not None:
            try:
                loop.call_soon_threadsafe(self._result, event)
            except RuntimeError:
                pass

    def _result(self, event: dict[str, Any]) -> None:
        from . import lang

        recognizer = self.recognizer
        if recognizer is None:
            return
        if recognizer.utterance_start != self._caption_start:  # a new utterance: a new caption
            self._caption_start = recognizer.utterance_start
            self._parts, self._woke = [], False
        try:
            start, end = int(event.get("start") or 0), int(event.get("end") or 0)
        except (TypeError, ValueError):
            return
        if end <= self._caption_start:
            return  # the last utterance's words, finishing late
        # A later reading of the same stretch replaces the earlier one.
        self._parts = [p for p in self._parts if p["end"] <= start or p["start"] >= end]
        self._parts.append({"start": start, "end": end, "text": str(event.get("text") or "")})
        self._parts.sort(key=lambda p: p["start"])
        language = self._language()
        text = lang.clean_transcript(" ".join(p["text"].strip() for p in self._parts), language)
        text = text.lstrip(" ,.;:…")  # a reading that starts mid-sentence
        if not text:
            return
        if not self._woke and lang.find_wake(text, language)[0]:
            self._woke = True
            cloud = getattr(self.hub.speaker, "cloud", None)
            if cloud is not None:  # its connection warms while you're still talking
                self.hub._spawn(cloud.warm())
        if self._woke or self.hub.state == "listening":
            self.hub.emit("voice_live", text=text[-300:], final=event.get("t") == "final")
