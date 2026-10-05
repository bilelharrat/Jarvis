"""The live voice player when it stops playing (speech.LivePlayer): measured on this Mac, the
first reply after the Mac slept went unheard and took 10-20 s longer, because the player's
audio engine didn't come back and its sentence marker never did. A ping at each sentence's
start finds that out in about a second; the player is started anew and plays the sentence
from its start. The player is tests/fake_player.py (the same protocol): no audio plays."""

import asyncio
import contextlib
import logging
import stat
import sys
import time
from pathlib import Path

import pytest

from jarvis import speech
from jarvis.speech import LivePlayer, Source

FAKE = Path(__file__).with_name("fake_player.py")
SENTENCE = [b"\x01\x00" * 2400, b"\x02\x00" * 2400, b"\x03\x00" * 2400]  # 0.3 s at 24 kHz


@pytest.fixture
async def player(tmp_path, monkeypatch):
    """The fake player's path, its log and its stuck-count files. Every player a test
    started is gone when the test ends, whether it passed or not."""
    path = tmp_path / "jarvis-player"
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" "$@"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    files = {name: tmp_path / name for name in ("log", "stuck", "wedged")}
    monkeypatch.setenv("FAKE_PLAYER_LOG", str(files["log"]))
    monkeypatch.setenv("FAKE_PLAYER_STUCK", str(files["stuck"]))
    monkeypatch.setenv("FAKE_PLAYER_WEDGED", str(files["wedged"]))
    # The stand-in is a Python process: on a busy Mac it took up to 2.6 s to say hello (the
    # native player takes milliseconds). start() stops waiting the moment it does, so a long
    # wait costs nothing; at 2 s it was used without pings, and no stuck player was found.
    monkeypatch.setattr(speech, "HELLO_SECONDS", 30.0)
    procs = []
    start = LivePlayer.start

    def left(name):
        return files[name].exists() and int(files[name].read_text() or 0) > 0

    async def start_and_keep(self):
        # One that will be stuck is found out at the app's own deadline. One that plays is
        # given whatever a busy Mac takes to say so: a stand-in starved of the CPU for a
        # second was taken for stuck too (what's tested is the stuck one, not its speed).
        stuck = left("stuck") or left("wedged")
        monkeypatch.setattr(speech, "PING_SECONDS", 1.0 if stuck else 30.0)
        await start(self)
        procs.append(self.proc)

    monkeypatch.setattr(LivePlayer, "start", start_and_keep)
    yield path, files
    # A player left running outlived its test, and its pipes the test's event loop.
    for proc in procs:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await asyncio.wait_for(proc.wait(), 30)


def runs(files):
    """The log split per player started: [[its commands], ...]."""
    out = []
    for line in files["log"].read_text().splitlines() if files["log"].exists() else []:
        if line.startswith("start "):
            out.append([])
        elif out:
            out[-1].append(line)
    return out


def audio_and_markers(commands):
    return [c for c in commands if c.startswith(("A ", "M "))]


async def test_a_healthy_player_is_asked_once_a_sentence_and_kept(player):
    path, files = player
    live = LivePlayer(path, 24000, False)
    await live.start()
    assert live.pings  # it said hello: it answers pings
    for _ in range(2):
        for chunk in SENTENCE:
            await live.write(chunk)
        await asyncio.wait_for(live.mark(), 30)
        assert live._ping is None  # the sentence's ping was answered, and its deadline is off
    live.close()
    [only] = runs(files)  # never started anew
    assert only == ["P 1", "A 4800", "A 4800", "A 4800", "M 1"] + [
        "P 2",
        "A 4800",
        "A 4800",
        "A 4800",
        "M 2",
    ]  # the ping goes ahead of each sentence, not each chunk


async def test_an_answer_in_while_the_event_loop_was_busy_counts(player, monkeypatch):
    """The ping's deadline can pass while JARVIS's event loop is busy (a slow step, a busy
    Mac) with the answer already in: the deadline ran before the reader saw it, and a player
    that plays was started anew and said its sentence again from the start."""
    path, files = player
    live = LivePlayer(path, 24000, False)
    await live.start()
    monkeypatch.setattr(speech, "PING_SECONDS", 1.0)
    began = time.monotonic()
    await live.write(SENTENCE[0])  # the sentence's ping goes ahead of it

    def answered():  # it takes the audio in after it answers the ping
        return "A 4800" in runs(files)[-1]

    # Busy (nothing awaited) until the answer is in and the deadline has passed.
    while not answered() and time.monotonic() < began + 30:
        time.sleep(0.01)
    time.sleep(max(0.0, began + speech.PING_SECONDS + 0.2 - time.monotonic()))
    assert answered()
    await asyncio.wait_for(live.mark(), 30)
    assert live._ping is None and not live._revived
    live.close()
    [only] = runs(files)  # never started anew
    assert only == ["P 1", "A 4800", "M 1"]


async def test_a_player_that_stopped_playing_is_started_anew_and_says_the_sentence(
    player, quiet_speaker, caplog
):
    """The measured failure: alive, reading, playing nothing. The sentence is heard about
    a second late from its start, rather than lost after its length plus ten seconds."""
    path, files = player
    files["stuck"].write_text("1")
    quiet_speaker.muted, quiet_speaker.player_path = False, path
    quiet_speaker.player_factory = LivePlayer
    src = Source(quiet_speaker.live_rate)  # nothing resampled: the sizes stay as sent
    for chunk in [*SENTENCE, None]:
        src.chunks.put_nowait(chunk)
    with caplog.at_level(logging.WARNING, logger="jarvis"):
        await asyncio.wait_for(quiet_speaker.play_source(src), 60)
    stuck, fresh = runs(files)
    assert stuck[0] == "P 1"  # asked first; never answered
    assert fresh[0] == "P 2"  # the new one is asked too
    assert audio_and_markers(fresh) == ["A 14400", "M 1"]  # the whole sentence, its marker
    # Found out by its ping, never by waiting out the marker's MARK_SLACK (which closes the
    # player): whatever a busy Mac adds to the new one's start, that wait isn't what ended it.
    said = [r.getMessage() for r in caplog.records]
    assert any("stopped playing (no answer" in m for m in said)
    assert not any("stopped answering" in m for m in said)
    live = quiet_speaker._live
    assert live.alive and live._unheard == bytearray()  # nothing kept once it was heard
    quiet_speaker.shutdown()


async def test_a_player_that_stops_reading_is_started_anew(player):
    """Stuck inside the audio system, it reads nothing: the pipe fills and writing to it
    blocks. Killing it frees the writer, and the new one gets everything."""
    path, files = player
    files["wedged"].write_text("1")
    live = LivePlayer(path, 24000, False)
    await live.start()
    big = b"\x05\x00" * 240_000  # 10 s of audio: far more than a pipe holds
    await asyncio.wait_for(live.write(big), 30)
    await asyncio.wait_for(live.mark(), 60)
    wedged, fresh = runs(files)
    assert wedged == []  # it read nothing
    assert audio_and_markers(fresh) == [f"A {len(big)}", "M 1"]
    live.close()


async def test_a_player_stuck_again_once_started_anew_is_let_go_quickly(
    player, quiet_speaker, caplog
):
    """No sound at all from this Mac now: the reply moves on as soon as the new player
    doesn't answer its ping either (a couple of seconds, not the marker's MARK_SLACK), and
    the next sentence tries a fresh player."""
    path, files = player
    files["stuck"].write_text("2")
    quiet_speaker.muted, quiet_speaker.player_path = False, path
    quiet_speaker.player_factory = LivePlayer
    first = await quiet_speaker.live()
    for chunk in SENTENCE:
        await first.write(chunk)
    with caplog.at_level(logging.WARNING, logger="jarvis"):
        await asyncio.wait_for(first.mark(), 60)
    # Let go at the new one's unanswered ping, not after waiting out the marker: which of
    # the two ended it, not the wall clock (a busy Mac starts the new one slowly).
    said = [r.getMessage() for r in caplog.records]
    assert any("isn't playing either" in m for m in said)
    assert not any("stopped answering" in m for m in said)
    assert not first.alive
    second = await quiet_speaker.live()
    assert second is not first and second.alive  # a fresh one (this one plays)
    for chunk in SENTENCE:
        await second.write(chunk)
    await asyncio.wait_for(second.mark(), 30)
    assert len(runs(files)) == 3
    quiet_speaker.shutdown()


async def test_a_barge_in_while_it_starts_anew_plays_nothing_again(player):
    path, files = player
    files["stuck"].write_text("1")
    live = LivePlayer(path, 24000, False)
    await live.start()
    for chunk in SENTENCE:
        await live.write(chunk)
    marking = asyncio.create_task(live.mark())
    deadline = time.monotonic() + 30  # a busy Mac starts the new one slowly
    while live._revival is None and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    live.stop_now()  # talked over while the new one starts
    await asyncio.wait_for(marking, 10)  # nothing waits on what was dropped
    while live._revival is not None and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    _stuck, fresh = runs(files)
    assert audio_and_markers(fresh) == []  # the dropped sentence isn't played again
    live.close()


async def test_a_player_that_never_says_hello_is_never_pinged(player, monkeypatch):
    """The talk-over helper (duplex.DuplexPlayer) speaks the protocol from before pings:
    a 'P' would put it out of step and lose the audio after it."""
    path, files = player
    monkeypatch.setenv("FAKE_PLAYER_OLD", "1")
    monkeypatch.setattr(speech, "HELLO_SECONDS", 0.3)
    live = LivePlayer(path, 24000, False)
    await live.start()
    assert not live.pings
    for chunk in SENTENCE:
        await live.write(chunk)
    await asyncio.wait_for(live.mark(), 30)
    live.close()
    [only] = runs(files)
    assert only == ["A 4800", "A 4800", "A 4800", "M 1"]


async def test_what_it_keeps_for_playing_again_stays_small(monkeypatch):
    """Realtime replies stream with no markers: only the latest UNHEARD_SECONDS are kept."""

    class Stdin:
        def write(self, _data):
            pass

        async def drain(self):
            pass

    class Proc:
        returncode = None
        stdin = Stdin()

        def kill(self):
            pass

    monkeypatch.setattr(speech, "UNHEARD_SECONDS", 1.0)
    live = LivePlayer(Path("/nonexistent"), 24000, False)
    live.proc = Proc()
    for _ in range(30):
        await live.write(b"\x00\x00" * 2400)  # 0.1 s each
    assert len(live._unheard) == 48_000  # one second's worth


def test_the_player_restarts_its_voice_with_its_engine():
    """Measured on macOS: an AVAudioEngine started again (a new output device, or after the
    Mac slept) leaves its player node saying it plays while it takes no buffer, until the
    node is stopped and played again. The old handler only called play(): every reply after
    that was silent until its marker timed out."""
    source = speech.PLAYER_SOURCE.read_text()
    revive = source[
        source.index("func revive()") : source.index(".AVAudioEngineConfigurationChange")
    ]
    assert revive.index("engine.start()") < revive.index("player.stop()")
    assert revive.index("player.stop()") < revive.index("player.play()")
    assert "if !engine.isRunning { revive() }" in source  # stopped without a notification
    assert 'emit("H 1")' in source and "completionCallbackType: .dataConsumed" in source
