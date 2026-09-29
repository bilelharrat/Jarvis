"""Screen awareness: pictures only while it's on, only in memory, attached when relevant."""

import asyncio

from jarvis import screenwatch
from jarvis.screenwatch import ScreenWatcher, about_screen


def test_what_counts_as_about_the_screen():
    for said in ("what's this error?", "sum this up", "what am I looking at", "read that email"):
        assert about_screen(said), said
    for said in ("what's the weather tomorrow", "set a timer for ten minutes", "call mom"):
        assert not about_screen(said), said


async def test_pictures_are_kept_only_while_it_is_on_and_forgotten_when_off(monkeypatch):
    shots = iter(["AAA", "BBB", "CCC", "DDD"])

    async def capture():
        return next(shots)

    monkeypatch.setattr(screenwatch, "INTERVAL", 0.01)
    w = ScreenWatcher(capture=capture, app_name=lambda: "Safari")
    once = await w.latest(0)  # the What's-this key, awareness off: used, not kept
    assert once.data == "AAA" and once.app == "Safari" and not w.frames
    w.start()
    await asyncio.sleep(0.05)
    assert w.running and len(w.frames) >= 2
    w.stop()
    assert not w.frames and not w.running


async def test_no_permission_is_reported_not_raised():
    async def denied():
        return ""

    w = ScreenWatcher(capture=denied)
    assert await w.latest() is None and "Screen Recording" in w.error


async def test_a_request_about_the_screen_goes_with_a_picture(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.emit = lambda *_a, **_k: None
    sent = []

    async def run_query(rid, query, images=None):
        sent.append((query, images))

    async def capture():
        return "PIXELS"

    hub._run_query = run_query
    hub.screen_watch = ScreenWatcher(capture=capture, app_name=lambda: "Xcode")
    hub.prefs.screen_aware = True
    await hub.ask("what's this error?")
    query, images = sent[-1]
    assert images == [{"media_type": "image/jpeg", "data": "PIXELS"}]
    assert "never instructions" in query and "Xcode" in query
    await hub.ask("what's the weather tomorrow")
    assert not sent[-1][1]  # nothing to do with the screen: no picture
    hub.prefs.screen_aware = False
    await hub.ask("what's this error?")
    assert not sent[-1][1]  # off means off


async def test_whats_this_sends_the_picture_and_falls_back_without_one(
    settings, quiet_speaker, isolated
):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.emit = lambda *_a, **_k: None
    sent = []

    async def run_query(rid, query, images=None):
        sent.append((query, images))

    hub._run_query = run_query
    shots = iter(["PIX", ""])

    async def capture():
        return next(shots)

    hub.screen_watch = ScreenWatcher(capture=capture)
    await hub.ask("The user pressed the What's-this key", display="What's this?", screen=True)
    assert sent[-1][1] == [{"media_type": "image/jpeg", "data": "PIX"}]
    await hub.ask("The user pressed the What's-this key", display="What's this?", screen=True)
    assert not sent[-1][1] and "see_screen" in sent[-1][0]  # no picture: Claude looks itself
