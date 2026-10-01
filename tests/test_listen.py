import pytest

from jarvis.listen import EndpointDetector


def feed_all(detector, values):
    for i, rms in enumerate(values):
        if detector.feed(rms):
            return i
    return None


def test_stops_after_silence_following_speech():
    d = EndpointDetector(silence_seconds=0.5, block_seconds=0.05, calibration_blocks=4)
    values = [0.002] * 4 + [0.2] * 10 + [0.002] * 20
    stop = feed_all(d, values)
    assert d.heard_speech
    assert stop == 4 + 10 + 10 - 1  # ten quiet blocks = 0.5s


def test_short_pauses_do_not_end_the_utterance():
    d = EndpointDetector(silence_seconds=0.5, block_seconds=0.05, calibration_blocks=4)
    values = [0.002] * 4 + [0.2] * 5 + [0.002] * 5 + [0.2] * 5
    assert feed_all(d, values) is None


def test_gives_up_when_nobody_speaks():
    d = EndpointDetector(wait_seconds=1.0, block_seconds=0.05, calibration_blocks=4)
    stop = feed_all(d, [0.002] * 100)
    assert stop == 19
    assert not d.heard_speech


def test_threshold_has_a_floor_in_a_silent_room():
    d = EndpointDetector(calibration_blocks=2)
    feed_all(d, [0.0, 0.0, 0.005])
    assert not d.heard_speech


def test_listener_resets_portaudio_after_repeated_failures(monkeypatch):
    import sounddevice as sd

    from jarvis import listen

    opened, resets = [], []

    class Broken:
        def __init__(self, **_kw):
            opened.append(1)
            if len(opened) >= 5:
                listener.stop()
            raise sd.PortAudioError("Internal PortAudio error", -9986)

    monkeypatch.setattr(sd, "InputStream", Broken)
    monkeypatch.setattr(listen, "reset_portaudio", lambda: resets.append(1))
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)
    listener = listen.ContinuousListener(lambda _a: None)
    monkeypatch.setattr(listener._stop, "wait", lambda _t: listener._stop.is_set())
    listener._run()
    assert len(opened) == 5 and len(resets) == 2  # from the fourth try on


def test_agent_options_allow_big_tool_results(settings):
    from jarvis.brain import build_options
    from jarvis.config import MAX_BUFFER

    async def confirm(_q):
        return False

    assert build_options(settings, confirm).max_buffer_size == MAX_BUFFER > 1024 * 1024


def test_sounds_finished():
    from jarvis.listen import sounds_finished

    for done in (
        "Jarvis, what's the weather tomorrow?",
        "Jarvis, turn the lights off.",
        "Yes, send it.",
        "Jarvis, what's the weather like?",
    ):
        assert sounds_finished(done), done
    for more in (
        "Jarvis, what's the weather in",
        "Jarvis, tell me about...",
        "Jarvis, email Ann and",
        "Jarvis.",
        "Jarvis, what's the weather in.",
        "Jarvis, what's the fastest way to?",
        "Jarvis, it's like.",
    ):
        assert not sounds_finished(more), more


def test_segmenter_hands_over_an_early_copy_and_can_be_committed():
    import numpy as np

    from jarvis.listen import BLOCK_SECONDS, Segmenter

    early = []
    seg = Segmenter(
        silence_seconds=0.6,
        calibration_blocks=1,
        early_seconds=0.2,
        on_early=lambda n, a: early.append((n, len(a))),
    )
    loud, quiet = (
        np.full(int(16000 * BLOCK_SECONDS), 0.2, np.float32),
        np.zeros(int(16000 * BLOCK_SECONDS), np.float32),
    )
    seg.feed(quiet, 0.0)  # calibration
    for _ in range(12):
        assert seg.feed(loud, 0.2) is None
    for _ in range(round(0.2 / BLOCK_SECONDS)):
        assert seg.feed(quiet, 0.0) is None
    assert len(early) == 1 and seg.number == 1
    copy = early[0][0]
    assert seg.commit(copy)
    assert seg.feed(quiet, 0.0) is None and not seg.in_speech  # ended, no second copy
    for _ in range(12):
        seg.feed(loud, 0.2)
    assert seg.number == 2 and not seg.commit(copy)  # a stale early copy can't end a new one


def _blocks():
    import numpy as np

    from jarvis.listen import BLOCK_SECONDS

    n = int(16000 * BLOCK_SECONDS)
    return np.full(n, 0.2, np.float32), np.zeros(n, np.float32)


def test_an_early_copy_goes_stale_once_you_speak_again():
    """Pause, carry on, pause again before the first copy is transcribed: the first copy
    must not end the utterance, or what came after the pause is lost."""
    from jarvis.listen import Segmenter

    early = []
    seg = Segmenter(
        silence_seconds=0.6,
        calibration_blocks=1,
        early_seconds=0.2,
        on_early=lambda n, a: early.append((n, len(a))),
    )
    loud, quiet = _blocks()
    seg.feed(quiet, 0.0)  # calibrate
    for _ in range(20):
        seg.feed(loud, 0.2)  # "Jarvis, what's the weather"
    for _ in range(4):
        seg.feed(quiet, 0.0)  # a 0.2 s pause: copy 1
    first = early[-1][0]
    assert seg.early_is_current(first)
    for _ in range(8):
        seg.feed(loud, 0.2)  # "in Paris", while copy 1 is being transcribed
    assert not seg.early_is_current(first)
    for _ in range(4):
        seg.feed(quiet, 0.0)  # another pause: copy 2, with "in Paris"
    second = early[-1][0]
    assert second != first and early[-1][1] > early[0][1]
    assert not seg.commit(first)  # copy 1's transcript arrives: stale
    assert seg.commit(second)  # copy 2's can end it
    assert all(seg.feed(quiet, 0.0) is None for _ in range(20))  # and nothing else follows


def test_without_a_commit_the_whole_utterance_comes_out_once():
    from jarvis.listen import Segmenter

    early = []
    seg = Segmenter(
        silence_seconds=0.6,
        calibration_blocks=1,
        early_seconds=0.2,
        on_early=lambda n, a: early.append(n),
    )
    loud, quiet = _blocks()
    seg.feed(quiet, 0.0)
    for _ in range(20):
        seg.feed(loud, 0.2)
    out = [seg.feed(quiet, 0.0) for _ in range(12)]
    whole = [o for o in out if o is not None]
    assert len(early) == 1 and len(whole) == 1
    assert not seg.commit(early[0])  # it already went out whole: the early copy can't too


def test_a_threshold_set_while_jarvis_talked_comes_back_down():
    """The stream reopened mid-reply: JARVIS's own voice calibrated the room. Once it's
    quiet, an ordinary voice must count as speech again."""
    import numpy as np

    from jarvis.listen import Segmenter

    seg = Segmenter(calibration_blocks=4)
    speaking, room, voice = (
        np.full(800, 0.1, np.float32),
        np.full(800, 0.002, np.float32),
        np.full(800, 0.05, np.float32),
    )
    for _ in range(4):
        seg.feed(speaking, 0.1)  # calibrated on JARVIS's reply
    assert seg.threshold > 0.3
    for _ in range(4):
        seg.feed(room, 0.002)  # the reply ends; the room is quiet
    assert seg.threshold == 0.012
    for _ in range(3):
        seg.feed(voice, 0.05)
    assert seg.in_speech


def test_push_to_talk_keeps_a_voice_that_starts_at_once():
    """Talking the moment the key goes down puts the voice in the calibration blocks; it
    must not become the noise floor."""
    d = EndpointDetector(silence_seconds=0.5, block_seconds=0.05, calibration_blocks=6)
    values = [0.002, 0.002] + [0.15] * 4 + [0.12] * 20 + [0.002] * 10
    stop = feed_all(d, values)
    assert d.heard_speech
    assert stop == 2 + 4 + 20 + 10 - 1  # the whole sentence, then the half-second of quiet


def test_push_to_talk_gives_up_on_a_stalled_microphone(monkeypatch):
    import sounddevice as sd

    from jarvis import listen

    class Stalled:  # opens, then never delivers a block
        def __init__(self, **_kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    resets = []
    monkeypatch.setattr(sd, "InputStream", Stalled)
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.05)
    monkeypatch.setattr(listen, "reset_portaudio", lambda: resets.append(1))
    with pytest.raises(RuntimeError, match="no audio arrived"):
        listen.record_utterance(0.5)
    assert resets == [1]
    assert listen.PORTAUDIO_LOCK.acquire(blocking=False)  # the lock was let go
    listen.PORTAUDIO_LOCK.release()


def test_reset_portaudio_leaves_stderr_alone(monkeypatch):
    """sounddevice's own _initialize() points fd 2 at /dev/null while PortAudio starts,
    swallowing other threads' log lines."""
    import os

    import sounddevice as sd

    from jarvis import listen

    calls = []

    class Lib:
        def Pa_Terminate(self):  # noqa: N802
            calls.append("terminate")
            return 0

        def Pa_Initialize(self):  # noqa: N802
            calls.append("initialize")
            return 0

    real_dup2, redirected = os.dup2, []

    def watch_dup2(fd, fd2, *args, **kwargs):
        if fd2 == 2:
            redirected.append(fd)
        return real_dup2(fd, fd2, *args, **kwargs)

    before = sd._initialized
    monkeypatch.setattr(sd, "_lib", Lib())
    monkeypatch.setattr(os, "dup2", watch_dup2)
    try:
        listen.reset_portaudio()
    finally:
        monkeypatch.setattr(os, "dup2", real_dup2)  # pytest's own capture uses it
    assert redirected == []
    assert calls == ["terminate", "initialize"] and sd._initialized == before


def test_a_microphone_that_stays_quiet_leads_to_a_reset(monkeypatch):
    """A stream that opens but never delivers used to reset the failure count on every
    reopen, so the PortAudio reset never came."""
    import sounddevice as sd

    from jarvis import listen

    opened, resets = [], []

    class Silent:
        def __init__(self, **_kw):
            opened.append(1)
            if len(opened) >= 5:
                listener.stop()

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(sd, "InputStream", Silent)
    monkeypatch.setattr(sd, "query_devices", lambda *_a, **_k: {"name": "Test mic"})
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.01)
    monkeypatch.setattr(listen, "reset_portaudio", lambda: resets.append(1))
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)
    listener = listen.ContinuousListener(lambda _a: None)
    listener._run()
    assert len(opened) == 5 and len(resets) == 2  # from the fourth try on


def test_a_new_hands_free_listener_waits_for_the_old_one(monkeypatch):
    import time

    import sounddevice as sd

    from jarvis import listen

    opened = []

    class Silent:
        def __init__(self, **_kw):
            opened.append(1)

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(sd, "InputStream", Silent)
    monkeypatch.setattr(sd, "query_devices", lambda *_a, **_k: {"name": "Test mic"})
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.01)
    monkeypatch.setattr(listen, "reset_portaudio", lambda: None)
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)
    listener = listen.ContinuousListener(lambda _a: None)
    with listen._HANDS_FREE:  # the replaced listener's thread is still closing its stream
        listener.start()
        time.sleep(0.1)
        assert opened == []
    deadline = time.monotonic() + 3
    while not opened and time.monotonic() < deadline:
        time.sleep(0.01)
    listener.stop()
    listener._thread.join(3)
    assert opened and not listener.running


def test_hands_free_hears_two_claps_and_sends_nothing_to_transcribe(monkeypatch):
    import sounddevice as sd
    from test_claps import clap, room

    from jarvis import listen

    audio = room(3)
    clap(audio, 1.5)
    clap(audio, 1.85)
    opened, claps, utterances = [], [], []

    class Mic:
        def __init__(self, callback, **_kw):
            self.callback = callback

        def __enter__(self):
            opened.append(1)
            if len(opened) > 1:  # the recording has played: end it there
                listener.stop()
                return self
            for i in range(0, audio.size - 800 + 1, 800):
                self.callback(audio[i : i + 800].reshape(-1, 1), 800, None, None)
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(sd, "InputStream", Mic)
    monkeypatch.setattr(sd, "query_devices", lambda *_a, **_k: {"name": "Test mic"})
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.05)
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)
    listener = listen.ContinuousListener(utterances.append)
    listener.on_double_clap = lambda: claps.append(1)
    listener._run()
    assert claps == [1]
    assert utterances == []


def test_a_microphone_opened_before_access_is_granted_is_opened_again(monkeypatch):
    """A fresh install: the stream that set off macOS's prompt hears only zeros even once
    access is granted. Nothing-but-zeros reopens it, and the next stream hears."""
    import numpy as np
    import sounddevice as sd

    from jarvis import listen

    opened, levels = [], []

    class Mic:
        def __init__(self, callback, **_kw):
            self.callback = callback

        def __enter__(self):
            opened.append(1)
            if len(opened) == 1:  # before the grant: digital silence, 4 s of it
                block = np.zeros((800, 1), dtype=np.float32)
            elif len(opened) == 2:  # after: the room's noise floor
                block = (np.random.default_rng(1).normal(0, 0.002, (800, 1))).astype(np.float32)
            else:
                listener.stop()
                return self
            for _ in range(80):
                self.callback(block, 800, None, None)
            return self

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(sd, "InputStream", Mic)
    monkeypatch.setattr(sd, "query_devices", lambda *_a, **_k: {"name": "Test mic"})
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.05)
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)
    listener = listen.ContinuousListener(lambda _a: None, on_level=levels.append)
    listener._run()
    assert len(opened) >= 2  # the silent stream was opened again
    assert any(level > 0 for level in levels)  # and the new one heard the room
