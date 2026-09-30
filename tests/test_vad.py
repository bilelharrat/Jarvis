"""Neural voice detection (vad.py) and hands-free listening with it: speech starts on a
voice and not on a door, typing, a fan or hum, and ends when the voice does. Every sound
is synthetic (voice_signals.py): nothing is recorded or played."""

import numpy as np
import pytest
import voice_signals as vs

from jarvis import listen, vad
from jarvis.listen import Segmenter


@pytest.fixture
def fresh_vad(monkeypatch):
    """vad's once-per-run load state, reset for this test only."""
    monkeypatch.setattr(vad, "_session", None)
    monkeypatch.setattr(vad, "_failure", "")


def utterances(audio, neural, silence_seconds=1.1):
    """Seconds of each utterance the hands-free segmenter cuts from this audio, after a
    quiet second to calibrate on (and with quiet after, for it to end)."""
    seg = Segmenter(
        silence_seconds=silence_seconds,
        voice=vad.make_gate() if neural else None,
        early_seconds=0.2,
        on_early=lambda _n, _a: None,
    )
    found = []
    for block in vs.blocks(np.concatenate([vs.silence(1.2), audio, vs.silence(1.5)])):
        out = seg.feed(block, vs.rms(block))
        if out is not None:
            found.append(round(out.size / vs.RATE, 2))
    return found


def test_the_model_is_the_one_faster_whisper_ships():
    path = vad.model_path()
    assert path.name == "silero_vad_v6.onnx" and path.is_file()
    assert "faster_whisper" in path.parts  # nothing downloaded, nothing of our own


def test_streamed_block_by_block_it_matches_faster_whispers_own_reading():
    from faster_whisper.vad import get_vad_model

    audio = np.concatenate([vs.silence(0.5), vs.voice(1.5), vs.silence(0.5)])
    audio = audio[: audio.size // vad.WINDOW * vad.WINDOW]
    batch = get_vad_model()(audio).reshape(-1)
    stream = vad.SileroStream(vad.load_session())
    streamed = []
    for block in vs.blocks(audio):  # 800-sample blocks: windows straddle them
        streamed += stream.feed(block)
    streamed += stream.feed(audio[len(vs.blocks(audio)) * vs.BLOCK :])
    assert len(streamed) == len(batch)
    assert np.allclose(streamed, batch, atol=1e-5)


@pytest.mark.parametrize(
    "sound",
    [vs.noise(3, 0.1), vs.hum(3), vs.fan(3), vs.door(1), vs.typing(3)],
    ids=["noise", "hum", "fan", "door", "typing"],
)
def test_room_sounds_start_nothing(sound):
    assert utterances(sound, neural=True) == []


def test_the_loudness_detector_took_those_sounds_for_speech():
    """What the neural detector fixes: each of these started an utterance (and a Whisper
    run) with loudness alone."""
    for sound in (vs.noise(3, 0.1), vs.hum(3), vs.fan(3), vs.door(1)):
        assert len(utterances(sound, neural=False)) == 1


def test_a_voice_is_heard_quiet_or_loud():
    for audio in (vs.voice(2), vs.voice(2, level=0.03), vs.voice(2, seed=7)):
        found = utterances(audio, neural=True)
        # 0.3 s kept from before it started, 2 s of voice, then the 1.1 s of quiet
        assert len(found) == 1 and 3.0 <= found[0] <= 3.6, found


def test_the_utterance_ends_with_the_voice_not_the_noise_after_it():
    audio = np.concatenate([vs.voice(2), vs.fan(3)])
    assert utterances(audio, neural=False) == [pytest.approx(6.3, abs=0.2)]  # the fan held it
    assert utterances(audio, neural=True) == [pytest.approx(3.4, abs=0.2)]


def test_typing_under_a_voice_leaves_one_utterance():
    assert len(utterances(vs.voice(2) + vs.typing(2, 0.3), neural=True)) == 1


class ScriptedStream:
    """A stand-in for SileroStream: one probability per block, as scripted."""

    def __init__(self, probabilities):
        self.probabilities = list(probabilities)
        self.last = 0.0

    def feed(self, _block):
        self.last = self.probabilities.pop(0)
        return [self.last]


def test_speech_goes_on_through_a_soft_syllable():
    gate = vad.VoiceGate(ScriptedStream([0.2, 0.6, 0.4, 0.36, 0.3, 0.45]), threshold=0.5)
    block = np.zeros(800, np.float32)
    # starts at 0.5, carries on above 0.35, stops below it, needs 0.5 again to restart
    assert [gate(block) for _ in range(6)] == [False, True, True, True, False, False]


def test_the_threshold_is_read_live_and_kept_in_range():
    level = [0.5]
    gate = vad.VoiceGate(ScriptedStream([0.45, 0.45]), threshold=lambda: level[0])
    block = np.zeros(800, np.float32)
    assert gate(block) is False
    level[0] = 0.4  # the slider moved
    assert gate(block) is True
    assert vad.clean_threshold(5) == vad.MAX_THRESHOLD and vad.clean_threshold(0) == 0.2
    for bad in ("0.5", None, True, float("nan")):
        assert vad.clean_threshold(bad) is None


def test_a_model_that_fails_mid_stream_hands_back_to_loudness():
    class Broken:
        last = 0.0

        def feed(self, _block):
            raise RuntimeError("onnx went away")

    gate = vad.VoiceGate(Broken())
    seg = Segmenter(calibration_blocks=1, voice=gate)
    quiet, loud = np.zeros(800, np.float32), np.full(800, 0.2, np.float32)
    seg.feed(quiet, 0.0)
    for _ in range(3):
        seg.feed(loud, 0.2)
    assert gate.broken and seg.in_speech  # loudness heard it


def test_when_the_model_cant_load_there_is_no_gate(fresh_vad, monkeypatch, caplog):
    def missing():
        raise vad.Unavailable("faster-whisper isn't importable (nope)")

    monkeypatch.setattr(vad, "model_path", missing)
    assert vad.make_gate() is None
    assert vad.make_gate() is None  # tried once, said once
    assert "faster-whisper isn't importable" in vad.unavailable_reason()
    assert caplog.text.count("neural voice detection is off") == 1


def test_the_hands_free_listener_takes_a_fresh_detector_per_stream(monkeypatch):
    """Each stream opened gets its own detector (its own memory), and reopen() swaps in
    the one chosen now."""
    import sounddevice as sd

    audio = np.concatenate([vs.silence(1.2), vs.voice(1.5), vs.silence(1.5)])
    opened, made, heard = [], [], []

    class Mic:
        def __init__(self, callback, **_kw):
            self.callback = callback

        def __enter__(self):
            opened.append(1)
            if len(opened) == 1:  # the recording, then quiet until the reopen is seen
                for block in vs.blocks(audio) + vs.blocks(vs.silence(0.5)):
                    self.callback(block.reshape(-1, 1), 800, None, None)
            else:
                listener.stop()
            return self

        def __exit__(self, *_exc):
            return False

    def factory():
        made.append(vad.make_gate())
        return made[-1]

    monkeypatch.setattr(sd, "InputStream", Mic)
    monkeypatch.setattr(sd, "query_devices", lambda *_a, **_k: {"name": "Test mic"})
    monkeypatch.setattr(listen, "STALL_SECONDS", 0.05)
    monkeypatch.setattr(listen, "pick_input_device", lambda _p: None)

    def on_utterance(utterance):
        heard.append(utterance)
        listener.reopen()  # say, the detector was switched in Settings

    listener = listen.ContinuousListener(on_utterance, silence_seconds=1.1)
    listener.voice_factory = factory
    listener._run()
    assert len(heard) == 1 and 2.5 <= heard[0].size / vs.RATE <= 3.2
    assert len(opened) == 2 and len(made) == 2 and made[0] is not made[1]


def test_a_detector_factory_that_fails_leaves_loudness(monkeypatch):
    listener = listen.ContinuousListener(lambda _a: None)

    def broken():
        raise OSError("no model")

    listener.voice_factory = broken
    assert listener._voice() is None
