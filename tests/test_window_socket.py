"""The window socket under odd events and bursts, driven through the ASGI app in the test's
own event loop (no TestClient thread), so a pump that dies fails on a timeout, not a hang."""

import asyncio
import json

from jarvis import hub as hubmod
from jarvis.hub import Hub, WindowQueue
from jarvis.server import create_app, event_text

SCOPE = {
    "type": "websocket",
    "asgi": {"version": "3.0", "spec_version": "2.4"},
    "http_version": "1.1",
    "scheme": "ws",
    "path": "/ws",
    "raw_path": b"/ws",
    "root_path": "",
    "query_string": b"token=s3cret",
    "headers": [(b"host", b"127.0.0.1:8123"), (b"origin", b"http://127.0.0.1:8123")],
    "server": ("127.0.0.1", 8123),
    "client": ("127.0.0.1", 50000),
    "subprotocols": [],
    "state": {},
}


class Window:
    """One window on the socket: what it sends in, what the server sends out."""

    def __init__(self, app):
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.out: asyncio.Queue = asyncio.Queue()
        self.incoming.put_nowait({"type": "websocket.connect"})
        self.task = asyncio.create_task(app(dict(SCOPE), self.incoming.get, self.out.put))

    async def next(self, timeout=5.0):
        return await asyncio.wait_for(self.out.get(), timeout)

    async def event(self, timeout=5.0):
        while True:
            message = await self.next(timeout)
            if message["type"] == "websocket.send":
                return json.loads(message["text"])
            if message["type"] == "websocket.close":
                return {"closed": message.get("code")}

    def say(self, *commands):
        for command in commands:  # all at once, as one read off the socket delivers them
            self.incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(command)})

    async def leave(self):
        self.incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(self.task, 5)


def make(settings, quiet_speaker, isolated):
    hub = Hub(settings, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)
    return hub, create_app(hub, "s3cret")


async def test_an_event_no_json_can_carry_is_skipped_and_the_window_keeps_hearing(
    settings, quiet_speaker, isolated, caplog
):
    hub, app = make(settings, quiet_speaker, isolated)
    w = Window(app)
    assert (await w.next())["type"] == "websocket.accept"
    assert (await w.event())["type"] == "hello"
    with caplog.at_level("ERROR", logger="jarvis"):
        for _ in range(3):
            hub.emit("odd", counts={(1, 2): 3})  # a tuple key: json.dumps can't write it
        hub.emit("after", n=1)
        assert await w.event() == {"type": "after", "n": 1}
    assert len([r for r in caplog.records if "can't be sent" in r.getMessage()]) == 1
    await w.leave()
    assert not hub._subscribers


async def test_a_burst_from_one_window_does_not_cut_off_the_others(
    settings, quiet_speaker, isolated
):
    hub, app = make(settings, quiet_speaker, isolated)
    flood, other = Window(app), Window(app)
    for w in (flood, other):
        assert (await w.next())["type"] == "websocket.accept"
        assert (await w.event())["type"] == "hello"
    burst = 2 * hubmod.WINDOW_QUEUE + 500  # every reply goes to every window
    flood.say(*({"type": "task_transcript", "id": 5} for _ in range(burst)))
    for w in (other, flood):
        for _ in range(burst):
            event = await w.event()
            assert event.get("type") == "task_transcript", event  # never {"closed": 4408}
    for w in (flood, other):
        await w.leave()


def test_a_window_is_cut_off_by_what_it_holds_not_just_how_many():
    q = WindowQueue()
    chunk = "x" * 100_000  # one terminal message is ~87 KB of base64
    for _ in range(hubmod.WINDOW_BYTES // len(chunk) + 1):
        q.put_nowait({"type": "term_data", "term": "t1", "data": chunk})
    assert q.cut_off and q.empty() and q.bytes == 0


def test_a_busy_window_that_drains_is_not_cut_off():
    q = WindowQueue()
    chunk = "x" * 100_000
    for _ in range(3):
        for _ in range(200):  # 20 MB behind at most, then it catches up
            q.put_nowait({"type": "term_data", "term": "t1", "data": chunk})
        while not q.empty():
            q.get_nowait()
    assert not q.cut_off and q.bytes == 0


def test_a_six_megabyte_attachment_is_kept():
    data = "A" * 8_000_000  # the base64 of a 6,000,000-byte file, which the composer allows
    items = Hub._attachments({"images": [{"media_type": "image/png", "data": data, "name": "a"}]})
    assert items and len(items[0]["data"]) == 8_000_000
    assert (
        Hub._attachments({"images": [{"media_type": "image/png", "data": data + "AAAA"}]}) is None
    )


def test_half_an_emoji_reaches_the_window_as_a_replacement_character():
    assert json.loads(event_text({"type": "x", "s": "party \ud83c"}))["s"] == "party \ufffd"
