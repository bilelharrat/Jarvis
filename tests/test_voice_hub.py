"""The hub's side of the voice pipeline: mute, changing the microphone, background tasks."""

import asyncio
import logging

from test_hub import Listener, make_hub


class Talking:
    """An unmuted speaker whose clips take a long time to play (silently)."""

    def __init__(self):
        self.muted, self.effect, self.cloud, self.cloud_error = False, False, None, ""
        self.player_path = None
        self.played, self.stops = [], 0

    async def synthesize(self, spoken):
        return (spoken, 16000)

    async def play(self, clip, rate):
        self.played.append(clip)
        await asyncio.sleep(10)

    async def say(self, text):
        self.played.append(text)

    def stop(self):
        self.stops += 1


async def test_mute_silences_the_reply_already_playing(settings, isolated):
    speaker = Talking()
    hub = make_hub(settings, speaker, isolated=isolated)
    for sentence in ("First sentence here.", "Second sentence here."):
        hub.speech.push(sentence)
    await asyncio.sleep(0.01)
    assert hub.state == "speaking" and speaker.played == ["First sentence here."]
    await hub.handle({"type": "mute", "value": True})
    assert speaker.stops and hub.state != "speaking"
    await asyncio.wait_for(hub.speech.drain(), 1)
    assert hub.speech._pending == 0
    hub.speech.push("Third sentence here.")  # muted: never queued
    await asyncio.sleep(0.01)
    assert speaker.played == ["First sentence here."]


async def test_changing_the_microphone_ends_the_old_hands_free_loop(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})

    def loops():
        return [
            t
            for t in hub._background
            if "_hands_free_loop" in getattr(t.get_coro(), "__qualname__", "")
        ]

    old_listener, old_loops = hub._listener, loops()
    assert len(old_loops) == 1
    hub.set_prefs({"mic": "default"})
    await asyncio.sleep(0.01)
    assert not old_listener.running and hub._listener.running
    assert old_loops[0].done() and len(loops()) == 1  # one loop, for the new microphone


async def test_a_failing_background_task_is_logged(settings, quiet_speaker, isolated, caplog):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)

    async def broken():
        raise ValueError("kaput")

    with caplog.at_level(logging.ERROR, logger="jarvis"):
        hub._spawn(broken())
        waiting = hub._spawn(asyncio.sleep(10))
        await asyncio.sleep(0)
        waiting.cancel()  # a cancelled task is not a failure
        await asyncio.sleep(0.01)
    failures = [r for r in caplog.records if "background task" in r.getMessage()]
    assert len(failures) == 1 and "broken" in failures[0].getMessage()
    assert "kaput" in caplog.text
