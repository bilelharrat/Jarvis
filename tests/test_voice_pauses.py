"""Hands-free: pausing mid-sentence, or finishing after the listening window, never cuts the
user off (they shouldn't have to say "Jarvis" again)."""

import asyncio
import time
from types import SimpleNamespace

from test_hub import Listener, make_hub

from jarvis import hub as hub_module


async def started(settings, speaker, isolated):
    hub = make_hub(settings, speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    return hub


def spoken(hub, began_ago, ended_ago=0.0):
    """The utterance being handled began and ended this many seconds ago."""
    now = time.monotonic()
    hub._utterance_began, hub._utterance_ended = now - began_ago, now - ended_ago


async def test_a_request_begun_in_the_window_counts_though_it_ends_after(
    settings, quiet_speaker, isolated
):
    hub = await started(settings, quiet_speaker, isolated)
    await hub.on_heard("Jarvis.")
    assert hub.state == "listening"
    # The window closed half a second ago; they started talking three seconds ago.
    hub._armed_until, hub._armed_window = 0.0, time.monotonic() - 0.5
    spoken(hub, began_ago=3.0)
    await hub.on_heard("dim the lights in the living room and put on some jazz")
    await asyncio.sleep(0.05)
    assert hub.client.said == ["dim the lights in the living room and put on some jazz"]
    # Talk that began after the window is ignored as ever.
    hub._armed_until, hub._armed_window = 0.0, time.monotonic() - 5
    hub.state = "idle"
    spoken(hub, began_ago=2.0)
    await hub.on_heard("just chatting with a friend about lunch")
    await asyncio.sleep(0.05)
    assert "just chatting with a friend about lunch" not in hub.client.queries


async def test_the_rest_of_a_request_after_a_pause_is_asked_with_the_start(
    settings, quiet_speaker, isolated
):
    hub = await started(settings, quiet_speaker, isolated)
    spoken(hub, began_ago=1.5, ended_ago=0.6)
    await hub._lock.acquire()  # "Jarvis, can you" went off as a request and is running
    hub._ask_by_voice("can you")
    spoken(hub, began_ago=0.3)  # 0.3 s after it ended: "…open my mail"
    await hub.on_heard("open my mail")
    assert hub.client.interrupted  # the half request is stopped
    hub._lock.release()
    await asyncio.sleep(0.1)
    assert hub.client.said[-1] == "can you open my mail"


async def test_talk_long_after_a_request_is_not_its_continuation(settings, quiet_speaker, isolated):
    hub = await started(settings, quiet_speaker, isolated)
    spoken(hub, began_ago=6.0, ended_ago=5.0)
    await hub._lock.acquire()
    hub._ask_by_voice("what's on my calendar")
    spoken(hub, began_ago=1.0)  # four seconds after: someone else in the room
    await hub.on_heard("did you see the game last night")
    assert not hub.client.interrupted
    hub._lock.release()
    await asyncio.sleep(0.05)
    assert "did you see the game last night" not in " ".join(hub.client.queries)


async def test_the_window_stays_open_while_they_are_still_talking(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = await started(settings, quiet_speaker, isolated)
    hub._listener.segmenter = SimpleNamespace(in_speech=True)
    hub._arm(seconds=0.05, chime=False)
    await asyncio.sleep(0.5)
    assert hub.state == "listening"  # mid-sentence: not cut off
    hub._listener.segmenter.in_speech = False
    await asyncio.sleep(0.5)
    assert hub.state == "idle"


def test_a_pause_mid_sentence_no_longer_ends_it():
    assert hub_module.HANDS_FREE_ENDPOINT >= 1.0 > hub_module.EARLY_ENDPOINT
