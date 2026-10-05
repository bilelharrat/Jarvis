import asyncio
from pathlib import Path

import numpy as np

from jarvis.speech import LivePlayer, Source, SpeechQueue, clean_for_speech, split_sentences


def test_strips_markdown_for_speech():
    text = "# Today\n- **Standup** at 9\n- Lunch with `Sam`\n\nSee [the doc](https://x.y/z)."
    assert clean_for_speech(text) == "Today. Standup at 9. Lunch with Sam. See the doc."


def test_replaces_code_and_bare_urls():
    spoken = clean_for_speech("Run this:\n```\nrm -rf /\n```\nor visit https://example.com")
    assert "rm -rf" not in spoken
    assert "on screen" in spoken
    assert "https" not in spoken


def test_blank_text_stays_blank():
    assert clean_for_speech("  \n ") == ""


def test_mid_stream_numbers_and_times_are_not_cut_at_their_dot():
    """'It is 23.' then '5 degrees' used to go out as two clips."""
    assert split_sentences("It is 23.") == ([], "It is 23.")
    assert split_sentences("It is 23.5 degrees. Then rain") == (
        ["It is 23.5 degrees."],
        "Then rain",
    )
    assert split_sentences("See you at 3:") == ([], "See you at 3:")
    assert split_sentences("See you at 3:30 tomorrow. Bye") == (
        ["See you at 3:30 tomorrow."],
        "Bye",
    )
    assert split_sentences("The capital is Canberra. It") == (["The capital is Canberra."], "It")
    assert split_sentences("It is 23.", final=True) == (["It is 23."], "")


def test_a_held_short_sentence_keeps_the_space_before_the_next_chunk():
    # "Sure." waits to join the next sentence; the tail kept after it must keep its
    # trailing space, or the next chunk is glued on: "Sure. The quickbrown fox."
    done, rest = split_sentences("Sure. The quick ")
    assert done == [] and rest == "Sure. The quick "
    done, rest = split_sentences(rest + "brown fox jumps. Then")
    assert done == ["Sure. The quick brown fox jumps."] and rest == "Then"
    assert split_sentences("Sure. The quick ", final=True) == (["Sure. The quick"], "")


def test_a_long_reply_splits_in_linear_time():
    import time

    def cpu(size: int) -> float:
        """This thread's CPU time to split a reply of so many characters: a busy Mac's
        other work doesn't count (it slowed the wall clock tenfold)."""
        reply = ("The report is ready, and the team meets at 3:30pm tomorrow. " * 70_000)[:size]
        started = time.thread_time()
        sentences, rest = split_sentences(reply, final=True)
        spent = time.thread_time() - started
        assert " ".join(sentences) == reply.strip() and rest == ""
        return spent

    # Read by position: sliced again after every sentence, 4 MB took 3.6 s. Four times the
    # reply takes about four times as long (0.06 to 0.09 s for 4 MB here), never sixteen.
    # Each pair is timed back to back, the best of three: a busy Mac moves a thread
    # between fast and slow cores.
    pairs = [(cpu(1_000_000), cpu(4_000_000)) for _ in range(3)]
    assert min(large / small for small, large in pairs) < 8, pairs
    assert min(large for _small, large in pairs) < 0.5, pairs


def test_speech_cleaning_is_linear_on_long_runs():
    import time

    from jarvis.voicecode import speakable

    # A line start never looks past its own line, and a run is tried only from where it
    # begins: 16,000 blank lines took 3.7 s to clean and 7 s to make speakable.
    runs = ["\n" * 16_000, " \n" * 8000, " " * 16_000, "\u3000" * 16_000, "\t" * 16_000]
    runs += ["[" * 16_000, "[a](b" * 3200]
    for run in runs:
        for clean in (clean_for_speech, speakable):
            # This thread's CPU time, the best of three (about 3 ms here): a busy Mac's
            # other work, and a slow core now and then, don't count.
            spent = []
            for _ in range(3):
                started = time.thread_time()
                clean(f"Done.{run}ok")
                spent.append(time.thread_time() - started)
            assert min(spent) < 0.05, (clean.__name__, run[:5], spent)


def test_a_link_with_brackets_in_its_address_is_said_as_its_text():
    link = "[the page](https://en.wikipedia.org/wiki/Foo_(bar))"
    assert clean_for_speech(f"See {link} now.") == "See the page now."  # was "the page) now."
    assert clean_for_speech("- one\n- two [1]\n\n  ## Next\nthree") == "one. two. Next. three"


class FakeLive:
    rate = 24000

    def __init__(self):
        self.writes, self.marks, self.stopped = [], 0, False

    async def write(self, pcm):
        self.writes.append(pcm)

    async def mark(self):
        self.marks += 1

    def stop_now(self):
        self.stopped = True


def _speaking(speaker):
    """quiet_speaker, unmuted, playing into a FakeLive instead of the native player."""
    live = FakeLive()

    async def get_live():
        return live

    speaker.muted = False
    speaker.live = get_live
    return live


def _source(*chunks):
    src = Source(24000)
    for chunk in chunks:
        src.chunks.put_nowait(chunk)
    return src


async def test_the_player_only_ever_gets_whole_samples(quiet_speaker):
    """A stream cut off mid-sentence can end on half a sample; a stray byte in the live
    player shifted every later sentence by a byte, into static."""
    live = _speaking(quiet_speaker)
    await quiet_speaker.play_source(
        _source(b"\x01\x02\x03", b"\x04\x05\x06\x07", b"\x08\x09", None)
    )
    assert all(len(w) % 2 == 0 for w in live.writes)
    assert b"".join(live.writes) == bytes(range(1, 9))  # in step; the last half-sample dropped
    assert live.marks == 1


async def test_muting_stops_a_sentence_mid_stream(quiet_speaker):
    live = _speaking(quiet_speaker)
    src = _source(b"\x00\x01")
    src.task = fetching = asyncio.create_task(asyncio.sleep(10))  # the rest downloading
    playing = asyncio.create_task(quiet_speaker.play_source(src))
    await asyncio.sleep(0.01)
    assert live.writes == [b"\x00\x01"]
    quiet_speaker.muted = True
    src.chunks.put_nowait(b"\x02\x03")
    await asyncio.wait_for(playing, 1)
    await asyncio.sleep(0)
    assert live.writes == [b"\x00\x01"] and live.marks == 0
    assert live.stopped  # what it had already queued is dropped too
    assert fetching.cancelled()  # and it stopped fetching the rest


async def test_a_finished_clip_is_not_played_while_muted(quiet_speaker):
    live = _speaking(quiet_speaker)
    quiet_speaker.muted = True
    await quiet_speaker.play(np.zeros(100, np.float32), 24000)
    assert live.writes == []


class SlowSpeaker:
    """Plays each clip for `seconds`, silently."""

    def __init__(self, seconds=10.0):
        self.muted, self.player_path, self.seconds = False, None, seconds
        self.played, self.stops = [], 0

    async def synthesize(self, spoken):
        return (spoken, 16000)

    async def play(self, clip, rate):
        self.played.append(clip)
        await asyncio.sleep(self.seconds)

    def stop(self):
        self.stops += 1


async def test_a_clear_never_leaves_the_count_below_zero():
    """-1 left behind by a barge-in read as 'still speaking' at the end of later turns."""
    q = SpeechQueue(SlowSpeaker())
    q.push("Hello there.")
    await asyncio.sleep(0.01)
    q.clear()
    await asyncio.sleep(0.01)
    assert q._pending == 0


async def test_speech_pushed_right_after_a_clear_still_plays():
    speaker = SlowSpeaker()
    q = SpeechQueue(speaker)
    q.push("First sentence here.")
    await asyncio.sleep(0.01)  # playing
    q.clear()
    speaker.seconds = 0.01
    q.push("Second sentence here.")  # before the old loop has even seen its cancellation
    await asyncio.wait_for(q.drain(), 1)
    assert speaker.played == ["First sentence here.", "Second sentence here."]
    assert q._pending == 0


async def test_clips_queued_before_a_mute_are_dropped():
    speaker = SlowSpeaker(seconds=0.02)
    q = SpeechQueue(speaker)
    q.push("First sentence here.")
    q.push("Second sentence here.")
    await asyncio.sleep(0.01)  # the first is playing
    speaker.muted = True
    await asyncio.wait_for(q.drain(), 1)
    assert speaker.played == ["First sentence here."] and q._pending == 0


async def test_a_player_that_never_confirms_is_given_up_on(monkeypatch):
    """mark() waited forever on a stuck player, holding up every reply after it."""
    from jarvis import speech

    class Stdin:
        def write(self, _data):
            pass

        async def drain(self):
            pass

    class Proc:
        returncode = None

        def __init__(self):
            self.stdin, self.killed = Stdin(), False

        def kill(self):
            self.killed = True

    monkeypatch.setattr(speech, "MARK_SLACK", 0.05)
    live = LivePlayer(Path("/nonexistent"), 24000, False)
    live.proc = Proc()
    await live.write(b"\x00\x00" * 240)  # 10 ms of audio
    await asyncio.wait_for(live.mark(), 1)  # comes back instead of hanging
    assert live.proc.killed and not live.alive  # the next sentence starts a fresh player


async def test_shutdown_closes_the_voice_connection_and_the_reader(quiet_speaker):
    from jarvis.speech import CloudVoice

    class Client:
        is_closed = False

        async def aclose(self):
            self.is_closed = True

    quiet_speaker.cloud = CloudVoice("fish", "k", "v")
    quiet_speaker.cloud._client = client = Client()
    live = LivePlayer(Path("/nonexistent"), 24000, False)
    live._reader = reader = asyncio.create_task(asyncio.sleep(10))
    quiet_speaker._live = live
    quiet_speaker.shutdown()
    await asyncio.sleep(0.01)
    assert client.is_closed and reader.cancelled()


def test_the_player_is_built_under_a_temporary_name(monkeypatch, tmp_path):
    """A build cut short must not leave a half-written binary that looks finished."""
    import subprocess

    from jarvis import prefs, speech

    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path)
    outputs = []

    def cut_short(args, **_kw):
        out = Path(args[args.index("-o") + 1])
        outputs.append(out)
        out.write_bytes(b"half a player")
        raise subprocess.TimeoutExpired(args, 300)

    monkeypatch.setattr(subprocess, "run", cut_short)
    assert speech.ensure_player() is None
    assert list((tmp_path / "bin").iterdir()) == []  # nothing left behind

    def builds(args, **_kw):
        Path(args[args.index("-o") + 1]).write_bytes(b"player")

    monkeypatch.setattr(subprocess, "run", builds)
    path = speech.ensure_player()
    assert path is not None and path.read_bytes() == b"player" and outputs[0] != path
    assert [p.name for p in (tmp_path / "bin").iterdir()] == [path.name]
