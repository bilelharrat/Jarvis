"""A window that falls behind gets the newest copy of what only needs its latest state; one
that stops reading is cut off, so it can't grow the backend's memory."""

import asyncio

from jarvis import hub as hubmod
from jarvis.hub import WindowQueue


def test_a_behind_window_keeps_only_the_newest_reply_per_request():
    q = WindowQueue(maxsize=10_000)
    for i in range(hubmod.COALESCE_AT + 50):
        q.put_nowait({"type": "tool", "n": i})  # every one of these matters
    for i in range(1000):
        q.put_nowait({"type": "reply", "rid": "r1", "text": "x" * i})
    replies = [e for e in list(q._items) if e["type"] == "reply"]
    assert len(replies) == 1 and replies[0]["text"] == "x" * 999
    assert sum(1 for e in q._items if e["type"] == "tool") == hubmod.COALESCE_AT + 50


def test_a_window_that_stops_reading_is_cut_off():
    q = WindowQueue(maxsize=100)
    for i in range(150):
        q.put_nowait({"type": "tool", "n": i})
    assert q.cut_off and q.empty()

    async def next_event():
        return await q.get()

    assert asyncio.run(next_event()) is None  # the pump closes the socket on this


async def test_the_hub_stops_feeding_a_cut_off_window(
    settings, quiet_speaker, isolated, monkeypatch
):
    from test_hub import make_hub

    monkeypatch.setattr(hubmod, "WINDOW_QUEUE", 50)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    stalled = hub.subscribe()
    reading = hub.subscribe()
    for i in range(80):
        hub.emit("tool", n=i)
        while not reading.empty():
            reading.get_nowait()
    assert stalled.cut_off and stalled not in hub._subscribers
    assert reading in hub._subscribers and not reading.cut_off
