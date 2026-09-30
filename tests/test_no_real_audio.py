"""No test makes a sound, voices anything with the Mac's `say` or opens the real microphone
(conftest's _no_real_audio): the Mac's voice and player can't start, whatever a test does,
and every path that reached them in the suite takes that as the Mac taking it would."""

import asyncio
import queue
import subprocess
import sys

import pytest
from test_hub import Listener, make_hub

from jarvis.listen import ContinuousListener


def test_the_macs_voice_and_player_cant_start_in_a_test(tmp_path):
    clip = tmp_path / "hello.aiff"
    with pytest.raises(FileNotFoundError):
        subprocess.run(["say", "-o", str(clip), "hello"], capture_output=True, check=False)
    with pytest.raises(FileNotFoundError):
        subprocess.Popen(["/usr/bin/afplay", str(tmp_path / "nothing.wav")])
    with pytest.raises(FileNotFoundError):
        subprocess.run("say -o /dev/null hello", shell=True, check=False)
    assert not clip.exists()
    # Anything else still runs: the stand-in players and helpers tests start.
    done = subprocess.run([sys.executable, "-c", "print(6 * 7)"], capture_output=True, text=True)
    assert done.stdout.strip() == "42"


async def test_nor_from_the_event_loop(tmp_path):
    clip = tmp_path / "hello.aiff"
    with pytest.raises(FileNotFoundError):
        await asyncio.create_subprocess_exec("say", "-o", str(clip), "hello")
    assert not clip.exists()


async def test_switching_to_chinese_readies_the_voice_without_the_real_say(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    voiced = asyncio.Event()
    prepare = hub._prepare_fillers

    async def prepare_fillers():
        try:
            await prepare()
        finally:
            voiced.set()

    hub._prepare_fillers = prepare_fillers
    hub.set_prefs({"language": "zh"})
    await asyncio.wait_for(voiced.wait(), 60)  # the fillers the switch readies, tried
    assert hub.speaker.voice == "Tingting"  # the Mandarin voice, as before
    assert hub._fillers == []  # nothing voiced: `say` isn't there for a test


async def test_a_bare_wake_word_plays_no_real_chime(
    settings, quiet_speaker, isolated, _no_real_audio
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    await hub.on_heard("Jarvis.")
    assert hub.state == "listening"  # listening all the same
    assert _no_real_audio == ["afplay"]


def test_a_listener_can_not_open_the_real_microphone(_no_real_audio):
    listener = ContinuousListener(lambda _audio: None)
    with pytest.raises(Exception, match="no real microphone"):
        with listener._stream(queue.Queue()):
            pass
    assert _no_real_audio == ["microphone"]
