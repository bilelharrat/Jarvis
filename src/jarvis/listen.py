"""Microphone capture that stops when you stop talking, plus local Whisper transcription."""

from __future__ import annotations

import itertools
import logging
import queue
import re
import threading
from collections import deque
from collections.abc import Callable

import numpy as np

log = logging.getLogger("jarvis")

SAMPLE_RATE = 16_000
BLOCK_SECONDS = 0.05
STALL_SECONDS = 2.0  # no audio at all for this long: the microphone has stalled


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
                self._calibrate()
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

    def _calibrate(self) -> None:
        """The room's level is taken from the quietest of the first blocks. Someone who
        talks the moment they press the key is in them too, and a median would set the bar
        at their voice: the rest of what they said would count as silence and be cut off.
        (The second quietest, so one oddly quiet block doesn't set it; all-zero blocks are
        a device warming up, not the room.)"""
        levels = sorted(rms for rms in self._noise if rms > 0) or [0.0]
        self._threshold = max(levels[min(1, len(levels) - 1)] * 3.0, 0.01)
        for rms in self._noise:  # what they said meanwhile counts as speech
            if rms >= self._threshold:
                self.heard_speech, self._quiet_run = True, 0
            elif self.heard_speech:
                self._quiet_run += 1


# PortAudio is only used for input now (playback goes through the native player), so the
# listener may reset it to re-list devices. The lock keeps a reset from pulling the rug out
# from under a push-to-talk recording.
PORTAUDIO_LOCK = threading.Lock()
RESET_AFTER_FAILURES = 3


def reset_portaudio() -> None:
    """Forget PortAudio's device list and build it again. After sleep or a device change,
    opening a stream can fail with -9986 forever until this happens.

    Straight to PortAudio rather than sounddevice's _terminate()/_initialize(): those point
    the whole process's stderr at /dev/null while PortAudio starts, which swallowed log
    lines from every other thread and handed /dev/null to any process started meanwhile."""
    import sounddevice as sd

    with PORTAUDIO_LOCK:
        if sd._initialized > 0:
            sd._lib.Pa_Terminate()
            sd._initialized -= 1
        sd._check(sd._lib.Pa_Initialize(), "Error initializing PortAudio")
        sd._initialized += 1


def record_utterance(
    silence_seconds: float,
    on_level: Callable[[float], None] | None = None,
    device: int | None = None,
    cancel: threading.Event | None = None,
) -> np.ndarray | None:
    """Blocks until the speaker finishes. Returns 16 kHz mono float32 audio, or None (no
    speech, or cancel was set: Stop, or the composer's mic pressed off)."""
    import sounddevice as sd

    blocks: queue.Queue[np.ndarray] = queue.Queue()

    def on_audio(data, _frames, _time, _status) -> None:
        blocks.put(data[:, 0].copy())

    detector = EndpointDetector(silence_seconds=silence_seconds)
    captured: list[np.ndarray] = []
    stalled = False
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
            try:
                block = blocks.get(timeout=STALL_SECONDS)
            except queue.Empty:  # a stalled device would otherwise hold the lock forever
                stalled = True
                break
            if cancel is not None and cancel.is_set():
                return None  # the microphone closes as the with-block ends
            captured.append(block)
            rms = float(np.sqrt(np.mean(block**2)))
            if on_level is not None:
                on_level(rms)
            if detector.feed(rms):
                break
    if stalled:
        # The stream is closed and the lock free again; a fresh device list gives the
        # next press its best chance (a stall usually follows sleep or a device change).
        try:
            reset_portaudio()
        except Exception as exc:
            log.warning("couldn't reset the audio system (%s)", exc)
        raise RuntimeError(f"no audio arrived for {STALL_SECONDS:g} seconds")
    if not detector.heard_speech:
        return None
    return np.concatenate(captured)


# Numbers every early copy, across Segmenters: a copy from before the microphone reopened
# can't be mistaken for one of the new stream's.
_EARLY_COPIES = itertools.count(1)


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
        (with a number of its own) so it can be transcribed while we wait to be sure
        you've finished; commit(number) then ends it there, as if the full silence had
        passed. Speaking again makes that copy stale: only the newest copy of an
        utterance, with nothing said since, can end it."""
        self.silence_blocks = round(silence_seconds / block_seconds)
        self.early_blocks = round(early_seconds / block_seconds) if early_seconds else 0
        self.on_early = on_early
        self.number = 0  # counts utterances
        self._early = 0  # the number of this utterance's newest early copy; 0 once stale
        self.max_blocks = round(max_seconds / block_seconds)
        self.min_blocks = round(min_seconds / block_seconds)
        self.calibration_blocks = calibration_blocks
        self._noise: list[float] = []
        self._recent: deque[float] = deque(maxlen=max(1, calibration_blocks))
        self.threshold = 0.012
        self._preroll: list[np.ndarray] = []
        self._current: list[np.ndarray] = []
        self._loud_run = 0
        self._quiet_run = 0
        self.in_speech = False
        # feed() runs on the microphone's thread, commit() on the event loop's.
        self._lock = threading.Lock()

    def commit(self, number: int) -> bool:
        """End the utterance at early copy `number` (its transcript was enough). False if
        the copy is stale: speech started again after it, or the utterance already ended
        and went out whole."""
        with self._lock:
            if not self._fresh(number):
                return False
            self._end()
            return True

    def early_is_current(self, number: int) -> bool:
        """Whether early copy `number` could still be committed (worth transcribing)."""
        with self._lock:
            return self._fresh(number)

    def _fresh(self, number: int) -> bool:
        return bool(number) and number == self._early and self.in_speech

    def drop(self) -> None:
        """Forget the utterance in progress (it was two claps, not words)."""
        with self._lock:
            self._end()

    def _end(self) -> None:
        self.in_speech = False
        self._early = 0
        self._current, self._preroll, self._loud_run = [], [], 0

    def feed(self, block: np.ndarray, rms: float) -> np.ndarray | None:
        """Returns a finished utterance, or None."""
        with self._lock:
            utterance, early = self._feed(block, rms)
        if early is not None and self.on_early is not None:
            self.on_early(*early)
        return utterance

    def _feed(
        self, block: np.ndarray, rms: float
    ) -> tuple[np.ndarray | None, tuple[int, np.ndarray] | None]:
        if len(self._noise) < self.calibration_blocks:
            self._noise.append(rms)
            if len(self._noise) == self.calibration_blocks:
                self.threshold = max(float(np.median(self._noise)) * 3.5, 0.012)
            return None, None
        loud = rms >= self.threshold
        if not self.in_speech:
            self._recalibrate(rms)
            self._preroll = (self._preroll + [block])[-6:]
            self._loud_run = self._loud_run + 1 if loud else 0
            if self._loud_run >= 2:
                self.in_speech = True
                self.number += 1
                self._current = list(self._preroll)
                self._quiet_run = 0
            return None, None
        self._current.append(block)
        if loud:
            self._quiet_run = 0
            self._early = 0  # talking again: a copy taken in the pause is missing this
        else:
            self._quiet_run += 1
        early = None
        if (
            self.early_blocks
            and self.on_early is not None
            and self._quiet_run == self.early_blocks
            and len(self._current) - self._quiet_run >= self.min_blocks
        ):
            self._early = next(_EARLY_COPIES)
            early = (self._early, np.concatenate(self._current))
        if self._quiet_run >= self.silence_blocks or len(self._current) >= self.max_blocks:
            voiced = len(self._current) - self._quiet_run
            audio = np.concatenate(self._current)
            self._end()
            return (audio if voiced >= self.min_blocks else None), early
        return None, early

    def _recalibrate(self, rms: float) -> None:
        """Between utterances, keep measuring the room. A level measured while JARVIS was
        talking (the stream reopened mid-reply) is far too high and would leave it deaf
        to a normal voice until the microphone next reopens. Only ever lowered, and only
        when it's off by more than half: a slightly quieter room changes nothing."""
        self._recent.append(rms)
        if len(self._recent) == self._recent.maxlen:
            level = max(float(np.median(self._recent)) * 3.5, 0.012)
            if level < self.threshold / 2:
                self.threshold = level


class ClapDetector:
    """Two claps in a row, heard in the hands-free microphone stream.

    The stream is read in 5 ms frames. A clap is a sharp click: the level jumps from quiet
    to loud within one frame, and has mostly died away 20-80 ms later (echo included); a
    spoken "p" or "t" runs on into a vowel instead. Two claps 0.15-0.8 s apart, of about
    the same loudness, with nothing else heard from `quiet` before the first to `quiet`
    after the second, are a double clap. Typing (a stream of clicks), talking and a third
    clap all break the pattern. feed() says True once, about `quiet` after the second clap.
    """

    FRAME = 80  # samples: 5 ms at 16 kHz

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE,
        min_gap: float = 0.15,
        max_gap: float = 0.8,
        quiet: float = 0.35,
        level: float = 0.05,
        on_clap: Callable[[float], None] | None = None,
    ) -> None:
        per_second = sample_rate / self.FRAME
        self.min_gap = round(min_gap * per_second)
        self.max_gap = round(max_gap * per_second)
        self.quiet = round(quiet * per_second)
        self.level = level  # a clap's loudest frame is at least this loud (RMS)
        self.on_clap = on_clap  # each single clap, with its level (for tuning from the log)
        self.window = round(0.15 * per_second)  # a clap's own sound, echo included
        self.echo = round(0.35 * per_second)  # after that, a fading echo still isn't "noise"
        self._energy: deque[float] = deque(maxlen=2 * self.quiet + self.max_gap + self.echo + 8)
        self._frame = 0  # the number of the next frame
        self._rest = np.zeros(0, dtype=np.float32)
        self._onsets: deque[int] = deque()  # sharp rises waiting to be judged
        self._claps: deque[tuple[int, float]] = deque()  # (first frame, peak)
        self._last_onset = -(10**9)
        self._cooldown_until = 0

    def feed(self, block: np.ndarray, threshold: float) -> bool:
        """One block of audio; threshold is the level speech is heard at (the segmenter's)."""
        samples = np.concatenate([self._rest, block]) if len(self._rest) else block
        count = len(samples) // self.FRAME
        self._rest = samples[count * self.FRAME :].astype(np.float32, copy=True)
        heard = False
        if count:
            frames = samples[: count * self.FRAME].reshape(count, self.FRAME)
            for energy in np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)):
                heard = self._step(float(energy), threshold) or heard
        return heard

    def _at(self, frame: int) -> float:
        first = self._frame - len(self._energy)
        return self._energy[frame - first] if first <= frame < self._frame else 0.0

    def _step(self, energy: float, threshold: float) -> bool:
        now = self._frame
        before = sum(self._at(f) for f in range(now - 4, now)) / 4
        self._energy.append(energy)
        self._frame += 1
        if (
            energy >= max(self.level, threshold * 4)
            and energy >= 6 * max(before, 1e-4)
            and now - self._last_onset > self.window
        ):
            self._onsets.append(now)
            self._last_onset = now
        while self._onsets and self._onsets[0] + self.window <= self._frame:
            self._judge(self._onsets.popleft())
        while self._claps and self._claps[0][0] < self._frame - self._energy.maxlen:
            self._claps.popleft()
        if len(self._claps) >= 2 and self._claps[-1][0] + self.quiet == now:
            return self._pair(threshold)
        return False

    def _judge(self, onset: int) -> None:
        peak = max(self._at(onset + i) for i in range(3))
        body = [self._at(onset + i) for i in range(4, 16)]  # 20-80 ms
        tail = [self._at(onset + i) for i in range(16, self.window)]  # 80-150 ms
        if sum(body) / len(body) <= 0.3 * peak and sum(tail) / len(tail) <= 0.12 * peak:
            self._claps.append((onset, peak))
            if self.on_clap is not None:
                self.on_clap(peak)

    def _pair(self, threshold: float) -> bool:
        (first, one), (second, two) = self._claps[-2], self._claps[-1]
        if not self.min_gap <= second - first <= self.max_gap or self._frame < self._cooldown_until:
            return False
        if max(one, two) > 3 * min(one, two):
            return False
        for frame in range(first - self.quiet, second + self.quiet):
            energy = self._at(frame)
            if energy < threshold:
                continue
            # the latest clap it could belong to (its first sliver can land a frame early)
            own = next((c for c in (second, first) if c - 2 <= frame < c + self.echo), None)
            if own is None:
                return False  # talking, typing, another clap
            peak = one if own == first else two
            if frame >= own + self.window and energy > 0.1 * peak:
                return False  # still loud long after the click: not a clap's echo
        self._claps.clear()
        self._cooldown_until = self._frame + self.quiet * 3
        return True


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
    if len(words) < 2:
        return False
    # "What's the weather like?": asked as a question, "like" is where it ends. (Not "to"
    # or "about": "what's the fastest way to…" pauses there just as often.)
    return words[-1] not in _TRAILING or (words[-1] == "like" and text.endswith("?"))


# One hands-free microphone at a time. A listener being replaced (another mic picked,
# hands-free toggled) can take up to STALL_SECONDS to notice it was stopped; the new one
# waits for it rather than driving PortAudio from two threads at once.
_HANDS_FREE = threading.Lock()


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
        self.on_double_clap: Callable[[], None] | None = None  # two claps (set by the hub)
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
        """End the utterance at early copy `number`: its transcript was enough."""
        return self.segmenter.commit(number) if self.segmenter is not None else False

    def early_is_current(self, number: int) -> bool:
        """Whether early copy `number` can still be committed: if not, it isn't worth
        transcribing (you kept talking; a newer copy or the whole utterance follows)."""
        return self.segmenter.early_is_current(number) if self.segmenter is not None else False

    def _run(self) -> None:
        owned = _HANDS_FREE.acquire(timeout=STALL_SECONDS + 3)
        if not owned:
            log.warning("the previous microphone is still closing; opening this one anyway")
        try:
            self._listen()
        finally:
            if owned:
                _HANDS_FREE.release()

    def _listen(self) -> None:
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
            claps = ClapDetector(on_clap=lambda level: log.debug("a clap (level %.3f)", level))
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
                    while not self._stop.is_set():
                        try:
                            block = blocks.get(timeout=STALL_SECONDS)
                        except queue.Empty:
                            # Open but sending nothing counts as a failure too, so reopening
                            # again and again comes to a PortAudio reset.
                            failures += 1
                            log.warning("microphone went quiet; reopening it")
                            break
                        failures = 0  # sound is arriving: this microphone works
                        rms = float(np.sqrt(np.mean(block**2)))
                        if self.on_level is not None:
                            self.on_level(rms)
                        if self.on_double_clap is not None and claps.feed(
                            block, segmenter.threshold
                        ):
                            segmenter.drop()  # the claps, not words: nothing to transcribe
                            self.on_double_clap()
                        utterance = segmenter.feed(block, rms)
                        if utterance is not None:
                            self.on_utterance(utterance)
            except Exception as exc:  # device vanished, permission revoked
                failures += 1
                log.warning("microphone error (%s); retrying", exc)
                self._stop.wait(min(10.0, 0.5 * 2**failures))


class Transcriber:
    """Offline speech-to-text. The model downloads once (~150 MB for base.en) on first use."""

    def __init__(self, model_name: str, language: str = "en") -> None:
        self.model_name = model_name
        self.language = language  # "zh": Mandarin, with a multilingual model
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
        from . import lang

        padded = np.concatenate([np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32), audio])
        segments, _info = self._load().transcribe(
            padded,
            beam_size=1,
            vad_filter=False,
            # English: language "en" and just the name as a hotword (a longer hint, "Hey
            # Jarvis, Jarvis", made Whisper treat the phrase as said and drop it: 11/32
            # woke vs 30/32, measured). Chinese: "zh", 贾维斯 and a Simplified prompt.
            **lang.transcribe_options(self.language, "" if hotwords == "Jarvis" else hotwords),
            # Faster, and nothing here needs timestamps or the previous utterance.
            without_timestamps=True,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return lang.clean_transcript(text, self.language)


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
