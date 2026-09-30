"""Apple's live recognizer (stt_apple.py) and the hub's use of it: utterances go to the helper
as they're heard (nothing between them), each utterance's words are asked for by its own
audio, captions show only what's for Jarvis, and anything that goes wrong leaves Whisper
to transcribe. The helper is tests/fake_hear.py (the same protocol, no speech model):
nothing is compiled, no microphone, no model."""

import asyncio
import os
import stat
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from conftest import FakeClient

from jarvis import audio, stt_apple
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub

FAKE = Path(__file__).with_name("fake_hear.py")


@pytest.fixture
def helper(tmp_path, monkeypatch):
    """An executable fake jarvis-hear, its command log, and the build returning it."""
    path = tmp_path / "jarvis-hear"
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "hear.log"
    monkeypatch.setenv("FAKE_HEAR_LOG", str(log))
    monkeypatch.setattr(audio, "build", lambda name, flags=(): path)
    return path, log


def commands(log):
    return log.read_text().splitlines() if log.exists() else []


def blocks(n, start=0):
    """n distinct 50 ms blocks (each has its own level, so its own fingerprint)."""
    return [np.full(800, (start + i + 1) / 1000, np.float32) for i in range(n)]


def wait_for(check, seconds=20.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.01)
    return False


def test_only_utterances_are_sent_and_their_words_are_found_by_their_audio(helper):
    path, log = helper
    rec = stt_apple.Recognizer(path, "en", lambda _event: None)
    assert rec.start(timeout=10) and rec.locale == "en-US"
    quiet, speech, after = blocks(10), blocks(8, 10), blocks(5, 18)
    for b in quiet:
        rec.tap(b, False)  # nobody talking: nothing sent
    for b in speech:
        rec.tap(b, True)
    for b in after:
        rec.tap(b, False)
    # The segmenter's utterance: its last 6 quiet blocks (the pre-roll) and the speech.
    utterance = np.concatenate(quiet[-6:] + speech)
    assert rec.words_for(utterance) == "heard 0-11200"  # 14 blocks, from where it began
    early = np.concatenate(quiet[-6:] + speech[:5])  # an early copy, part way through
    assert rec.words_for(early) == "heard 0-8800"
    assert rec.words_for(np.concatenate(after)) is None  # never sent: Whisper's
    assert rec.words_for(np.zeros(100, np.float32)) is None
    sent = commands(log)
    assert sent[:2] == ["listen en", "B at 0"] and "F 0-11200" in sent
    rec.close()


def test_a_second_utterance_starts_afresh_where_the_stream_is(helper):
    path, log = helper
    rec = stt_apple.Recognizer(path, "en", lambda _event: None)
    assert rec.start(timeout=10)
    first, gap, second = blocks(4), blocks(20, 4), blocks(4, 24)
    for b in first:
        rec.tap(b, True)
    for b in gap:
        rec.tap(b, False)
    for b in second:
        rec.tap(b, True)
    # The second began after the first's 4 blocks and 6 pre-roll blocks of the gap.
    assert rec.words_for(np.concatenate(gap[-6:] + second)) == "heard 3200-11200"
    assert [c for c in commands(log) if c.startswith("B")] == ["B at 0", "B at 3200"]
    rec.close()


def test_an_answer_that_doesnt_come_or_a_helper_that_dies_leaves_whisper(helper, monkeypatch):
    path, _log = helper
    monkeypatch.setenv("FAKE_HEAR_SILENT", "1")
    rec = stt_apple.Recognizer(path, "en", lambda _event: None)
    assert rec.start(timeout=10)
    speech = blocks(6)
    for b in speech:
        rec.tap(b, True)
    started = time.monotonic()
    assert rec.words_for(np.concatenate(speech), timeout=0.2) is None
    assert time.monotonic() - started < 1.0
    rec.proc.kill()
    assert wait_for(lambda: not rec.alive)
    assert rec.words_for(np.concatenate(speech)) is None and rec.failed


def test_a_missing_model_is_said_at_once(helper, monkeypatch):
    path, _log = helper
    monkeypatch.setenv("FAKE_HEAR_INSTALLED", "0")
    rec = stt_apple.Recognizer(path, "zh", lambda _event: None)
    assert not rec.start(timeout=10)
    assert "zh-CN isn't on this Mac" in rec.failed


def test_words_to_listen_for_are_sent_when_they_change(helper):
    path, log = helper
    rec = stt_apple.Recognizer(path, "en", lambda _event: None)
    assert rec.start(timeout=10)
    rec.context(["Jarvis", "Okin", "Jarvis", " "])
    rec.context(["Jarvis", "Okin"])
    rec.context(["Friday"])
    assert wait_for(lambda: len([c for c in commands(log) if c.startswith("C")]) == 2)
    assert [c for c in commands(log) if c.startswith("C")] == ["C Jarvis,Okin", "C Friday"]
    rec.close()


# ── on the hub ──


def make_hub(settings, speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=speaker, poll=False, **isolated)


async def settle(check, seconds=20.0):
    """True as soon as check() is (a stand-in helper can take seconds to start on a busy Mac)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        await asyncio.sleep(0.02)
    return False


async def test_whisper_is_the_default_and_apple_starts_when_chosen(
    settings, quiet_speaker, isolated, helper
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub._loop = asyncio.get_running_loop()
    ears = voice_feature.feature_for(hub).ears
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    assert hub.prefs.feature("voice_engine") == "whisper" and ears.state == "off"
    assert hub.heard_live(np.zeros(1600, np.float32)) is None  # off: Whisper's

    await hub._handle({"type": "voice_settings", "changes": {"voice_engine": "apple"}})
    assert await settle(lambda: ears.state == "on")
    assert ears.locale == "en-US" and ears.recognizer.alive
    states = [data["apple"]["state"] for kind, data in sent if kind == "voice" and "apple" in data]
    assert "preparing" in states and states[-1] == "on"

    await hub._handle({"type": "voice_settings", "changes": {"voice_engine": "whisper"}})
    assert await settle(lambda: ears.state == "off") and ears.recognizer is None


async def test_the_model_downloads_only_when_asked(
    settings, quiet_speaker, isolated, helper, monkeypatch
):
    path, log = helper
    monkeypatch.setenv("FAKE_HEAR_INSTALLED", "0")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub._loop = asyncio.get_running_loop()
    ears = voice_feature.feature_for(hub).ears
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    hub.set_feature_prefs({"voice_engine": "apple"})
    await ears.refresh()
    assert ears.state == "needs_model" and ears.bytes == 123_000_000
    assert not [c for c in commands(log) if c.startswith("install")]  # nothing yet

    monkeypatch.setenv("FAKE_HEAR_INSTALLED", "1")  # what the download will have done
    await hub._handle({"type": "voice_engine_download"})
    assert await settle(lambda: ears.state == "on")
    assert "install en" in commands(log)
    progress = [
        data["apple"]["progress"]
        for _, data in sent
        if data.get("apple", {}).get("state") == "downloading"
    ]
    assert progress and max(progress) == 1.0


async def test_an_utterance_apple_heard_isnt_transcribed_again(
    settings, quiet_speaker, isolated, helper, monkeypatch
):
    monkeypatch.setenv("FAKE_HEAR_WORDS", "Jarvis, what's on tomorrow?")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub._loop = asyncio.get_running_loop()
    ears = voice_feature.feature_for(hub).ears
    hub.set_feature_prefs({"voice_engine": "apple"})
    await ears.refresh()
    whispered = []

    class Whisper:
        def transcribe(self, audio, *_hints):
            whispered.append(audio.size)
            return "whisper's words"

    hub.transcriber = Whisper()
    speech = blocks(8)
    for b in speech:
        ears.tap(b, True)
    heard = await asyncio.to_thread(hub._transcribe, hub.transcriber, np.concatenate(speech))
    assert heard == "Jarvis, what's on tomorrow?" and whispered == []
    other = await asyncio.to_thread(hub._transcribe, hub.transcriber, np.ones(1600, np.float32))
    assert other == "whisper's words" and whispered == [1600]  # push-to-talk audio: Whisper
    ears._stop()


async def test_captions_show_only_what_is_for_jarvis(settings, quiet_speaker, isolated, helper):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub._loop = asyncio.get_running_loop()
    ears = voice_feature.feature_for(hub).ears
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    hub.set_feature_prefs({"voice_engine": "apple"})
    await ears.refresh()
    warmed = []

    class Cloud:
        async def warm(self):
            warmed.append(1)

    hub.speaker.cloud = Cloud()
    ears.recognizer.utterance_start = 0
    ears._result({"t": "partial", "start": 0, "end": 800, "text": "so anyway the"})
    assert not [k for k, _ in sent if k == "voice_live"]  # room talk: never shown
    ears._result({"t": "partial", "start": 0, "end": 1600, "text": "Jarvis, what's"})
    ears._result({"t": "partial", "start": 0, "end": 2400, "text": "Jarvis, what's on"})
    live = [d for k, d in sent if k == "voice_live"]
    assert [d["text"] for d in live] == ["Jarvis, what's", "Jarvis, what's on"]
    await asyncio.sleep(0)
    assert warmed == [1]  # the voice's connection opens while you're still talking
    ears.recognizer.utterance_start = 4000  # the next utterance
    hub.state = "listening"  # an answer Jarvis is waiting for: shown without the name
    ears._result({"t": "partial", "start": 4000, "end": 4800, "text": "yes please"})
    assert sent[-1] == ("voice_live", {"text": "yes please", "final": False})
    ears._stop()


async def test_the_listener_hands_its_blocks_to_apple(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    listener = hub.listener_factory(lambda _a: None, None, 1.1)
    voice = voice_feature.feature_for(hub)
    tapped = []
    voice.ears.tap = lambda block, speaking: tapped.append((block.size, speaking))
    listener.on_block(np.zeros(800, np.float32), True)
    assert tapped == [(800, True)]


async def test_just_the_name_listens_without_the_full_pause(settings, quiet_speaker, isolated):
    """'Jarvis.' then quiet: the early copy's transcript arms listening at once."""
    from test_hub import Listener
    from test_hub import make_hub as hub_with_script

    hub = hub_with_script(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    committed = []
    hub._listener.early_is_current = lambda n: True
    hub._listener.commit = lambda n: committed.append(n) or True

    class Ears:
        def transcribe(self, *_a):
            return "Jarvis."

    hub.transcriber = Ears()
    hub._arm = lambda **_kw: committed.append("armed")
    await hub._early_utterance(7, np.zeros(8000, np.float32), time.monotonic())
    assert committed == [7, "armed"]


def test_the_helper_is_built_once_and_cached_by_its_source(tmp_path, monkeypatch):
    import subprocess

    from jarvis import prefs

    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path)
    runs = []

    def swiftc(args, **_kw):
        runs.append(args)
        Path(args[args.index("-o") + 1]).write_bytes(b"helper")

    monkeypatch.setattr(subprocess, "run", swiftc)
    first = audio.build("jarvis-hear")
    assert first is not None and first == audio.build("jarvis-hear") and len(runs) == 1
    assert "-parse-as-library" in runs[0] and first.parent == tmp_path / "bin"

    def broken(args, **_kw):
        raise subprocess.CalledProcessError(1, args)

    monkeypatch.setattr(subprocess, "run", broken)
    first.unlink()
    assert audio.build("jarvis-hear") is None
    assert not list((tmp_path / "bin").iterdir())  # nothing half-built left behind


@pytest.mark.skipif(not os.path.exists("/usr/bin/true"), reason="posix")
def test_install_reports_progress_and_says_why_it_failed(helper):
    path, _log = helper
    seen = []
    assert stt_apple.install(path, "zh", lambda f, b: seen.append(f)) == ""
    assert seen == [0.25, 0.5, 1.0]
    assert stt_apple.install(Path("/nonexistent/jarvis-hear"), "zh", lambda f, b: None)
