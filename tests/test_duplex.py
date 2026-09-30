"""Talk over Jarvis (duplex.py and Hub.on_heard): while hands-free listens, JARVIS's voice and
the microphone go through one echo-cancelling helper; the listener hears through it; the
voice ducks while you talk over it; what you said is handled as if "Jarvis" came first; and
anything that goes wrong puts the usual player and microphone back. The helper is
tests/fake_duplex.py (the same protocol, a scripted microphone): nothing is compiled, no
audio plays, no microphone opens."""

import asyncio
import queue
import stat
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import voice_signals as vs
from conftest import FakeClient

from jarvis import audio, duplex, listen, vad
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub
from jarvis.speech import LivePlayer

FAKE = Path(__file__).with_name("fake_duplex.py")


@pytest.fixture
def helper(tmp_path, monkeypatch):
    path = tmp_path / "jarvis-duplex"
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "duplex.log"
    monkeypatch.setenv("FAKE_DUPLEX_LOG", str(log))
    monkeypatch.setattr(audio, "build", lambda name, flags=(): path)
    return path, log


def commands(log):
    return log.read_text().splitlines() if log.exists() else []


@pytest.fixture
def speaking_hub(settings, quiet_speaker, isolated, tmp_path):
    """A hub whose speaker plays through a live player (the fake), hands-free on."""
    quiet_speaker.muted, quiet_speaker.rate = False, 190
    quiet_speaker.player_path = tmp_path / "jarvis-player"  # never run: talk-over's is
    isolated["prefs_store"].prefs.hands_free = True
    # Talk over Jarvis is off until the owner turns it on (Settings › Listening): on here.
    isolated["prefs_store"].prefs.features["voice_talk_over"] = True
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    return hub


async def until(check, seconds=20.0):
    """True as soon as check() is (a stand-in helper can take seconds to start on a busy Mac)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        await asyncio.sleep(0.02)
    return False


async def on(hub):
    hub._loop = asyncio.get_running_loop()
    talk = voice_feature.feature_for(hub).duplex
    await talk.refresh()
    return talk


async def test_the_voice_and_the_microphone_go_through_the_helper(speaking_hub, helper):
    hub, (_path, log) = speaking_hub, helper
    talk = await on(hub)
    assert talk.state == "on" and talk.device == "Fake Mic"
    assert isinstance(hub.speaker._live, duplex.DuplexPlayer)
    assert "--input builtin" in commands(log)[0]  # AirPods stay out of call quality
    assert not hub.talk_over()  # nothing hears through it yet

    blocks = queue.Queue()
    with talk.source(blocks):
        first = await asyncio.to_thread(blocks.get, True, 3)
        assert first.shape == (800,) and first.dtype == np.float32
        assert hub.talk_over()  # the listener hears through it: JARVIS can be talked over
        await hub.speaker.play(np.zeros(2205, np.float32), 22050)
    assert not hub.talk_over()
    assert any(c.startswith("A ") for c in commands(log)) and any(
        c.startswith("M ") for c in commands(log)
    )


async def test_a_refusal_puts_things_back_and_says_why(speaking_hub, helper, monkeypatch):
    monkeypatch.setenv(
        "FAKE_DUPLEX_REFUSE", "the Mac's input is AirPods Pro, not its own microphone"
    )
    hub = speaking_hub
    talk = await on(hub)
    assert talk.state == "unavailable" and "AirPods Pro" in talk.why
    assert hub.speaker.player_factory is LivePlayer
    assert talk.source(queue.Queue()) is None  # the usual microphone
    assert not hub.talk_over()
    await talk.refresh()
    assert talk.state == "unavailable"  # not tried again by itself...
    monkeypatch.delenv("FAKE_DUPLEX_REFUSE")
    await hub._handle({"type": "voice_settings", "changes": {"voice_talk_over": False}})
    await hub._handle({"type": "voice_settings", "changes": {"voice_talk_over": True}})
    assert await until(lambda: talk.state == "on")  # ...but when the setting is switched


async def test_talking_over_ducks_the_voice_and_a_stop_restores_it(
    speaking_hub, helper, monkeypatch
):
    hub, (_path, log) = speaking_hub, helper
    monkeypatch.setattr(duplex, "UNDUCK_SECONDS", 0.05)
    talk = await on(hub)
    blocks = queue.Queue()
    with talk.source(blocks):
        hub.state = "speaking"
        talk.heard(True)  # the neural detector: someone started talking
        assert await until(lambda: "V 250" in commands(log))
        hub.speech.clear()  # the barge-in stops the reply
        assert await until(lambda: "S" in commands(log) and "V 1000" in commands(log))
        talk.heard(False)
        talk.heard(True)
        talk.heard(False)  # a voice that interrupted nothing
        assert await until(lambda: commands(log).count("V 1000") >= 2)


async def test_hands_free_off_closes_the_microphone(speaking_hub, helper):
    hub = speaking_hub
    talk = await on(hub)
    player = talk.player
    with talk.source(queue.Queue()):
        hub.prefs.hands_free = False
    assert await until(lambda: talk.state == "off" and not player.alive)
    assert hub.speaker.player_factory is LivePlayer and talk.player is None


async def test_a_helper_that_dies_is_started_again_then_given_up_on(speaking_hub, helper):
    hub = speaking_hub
    talk = await on(hub)
    for _ in range(duplex.CRASHES - 1):
        old = talk.player
        blocks = queue.Queue()
        with talk.source(blocks):
            old.proc.kill()
            assert await asyncio.to_thread(_drain, blocks)  # the listener hears it end
        # the next sentence's player is a new helper
        assert await until(lambda old=old: talk.player is not old and talk.player.alive)
    talk.player.proc.kill()
    assert await until(lambda: talk.state == "unavailable")
    assert "kept stopping" in talk.why and hub.speaker.player_factory is LivePlayer


def _drain(blocks):
    """Read blocks until the helper's end (None) arrives."""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if blocks.get(timeout=5) is None:
            return True
    return False


async def test_a_microphone_that_goes_quiet_twice_is_given_up_on(speaking_hub, helper, monkeypatch):
    monkeypatch.setenv("FAKE_DUPLEX_QUIET", "1")
    hub = speaking_hub
    talk = await on(hub)
    for _ in range(2):
        with talk.source(queue.Queue()):
            pass  # the listener found nothing for 2 s and let go
        await asyncio.sleep(0.05)
    assert await until(lambda: talk.state == "unavailable")
    assert "went quiet" in talk.why


async def test_the_listener_hears_utterances_through_it(
    speaking_hub, helper, monkeypatch, tmp_path
):
    """The hands-free listener, its neural detector and the echo-cancelled microphone."""
    mic = tmp_path / "mic.pcm"
    voice = np.concatenate([vs.silence(1.2), vs.voice(1.5), vs.silence(1.5)])
    mic.write_bytes((voice * 32767).astype("<i2").tobytes())
    monkeypatch.setenv("FAKE_DUPLEX_MIC", str(mic))
    hub = speaking_hub
    talk = await on(hub)
    heard = []
    listener = listen.ContinuousListener(heard.append, silence_seconds=1.1)
    listener.source = talk.source
    listener.voice_factory = vad.make_gate
    thread = threading.Thread(target=listener._run, daemon=True)
    thread.start()
    whole = lambda: [h for h in heard if 2.5 <= h.size / vs.RATE <= 3.3]  # noqa: E731
    try:
        # the voice once whole: 0.3 s kept from before it, 1.5 s of voice, 1.1 s of quiet
        assert await until(whole), [round(h.size / vs.RATE, 2) for h in heard]
    finally:
        listener.stop()
        thread.join(5)


# ── what was said over JARVIS (Hub.on_heard) ──


async def test_said_over_a_reply_it_stops_it_and_asks(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    stopped = []

    async def stop():
        stopped.append(1)

    hub.stop = stop
    hub.state = "speaking"
    await hub.on_heard("actually, make it Tuesday instead")
    assert stopped == [] and hub.client.said == []  # talk-over off: the wake word it takes
    hub.talk_over = lambda: True
    await hub.on_heard("actually, make it Tuesday instead")
    await asyncio.sleep(0.02)
    assert stopped == [1] and hub.client.said == ["actually, make it Tuesday instead"]


async def test_stop_said_over_it_only_stops(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    stopped = []

    async def stop():
        stopped.append(1)

    hub.stop, hub.talk_over = stop, (lambda: True)
    hub.state = "speaking"
    await hub.on_heard("stop")
    await asyncio.sleep(0.02)
    assert stopped == [1] and hub.client.said == [] and hub.state != "listening"


async def test_its_own_voice_is_still_not_a_request(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.talk_over = lambda: True
    hub.speech._said = [["There are two meetings tomorrow morning", None]]
    hub.state = "speaking"
    await hub.on_heard("two meetings tomorrow morning")
    await asyncio.sleep(0.02)
    assert hub.client.said == []


async def test_after_it_finished_talking_the_wake_word_is_needed_again(
    settings, quiet_speaker, isolated
):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.talk_over = lambda: True
    hub.state = "idle"
    hub._spoke_until = time.monotonic() - 30
    hub._utterance_began = time.monotonic() - 1  # began long after it stopped
    await hub.on_heard("so I told him about the weekend")
    await asyncio.sleep(0.02)
    assert hub.client.said == []
