"""Discord over a fake Gateway and a fake REST API (nothing leaves the machine): the token is
checked and kept in the Keychain only, the Gateway is identified with the DM intent alone,
heartbeats are answered, a dropped connection resumes its session, only the paired user's
direct messages count (never the bot's own, never a server's), buttons answer cards, no
message can ping anyone, and a refused token or intent stops it for good."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from channels_fakes import make_hub, settle

from jarvis.channels import discord as dc
from jarvis.channels.router import Card
from jarvis.channels.store import Owner

# A made-up bot token (its first part is "123456789012345678"), built from its three
# parts so secret scanners don't take it for a real one.
TOKEN = ".".join(["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GAbCdE", "abcdefghijklmnopqrstuvwxyz0123456789ab"])


class Closed(Exception):
    """What websockets raises when Discord closes the connection with a code."""

    def __init__(self, code):
        super().__init__(f"closed {code}")
        self.rcvd = SimpleNamespace(code=code)


class Gateway:
    """One pretend Gateway connection: Hello first, then what the test scripts; it records
    every packet sent to it."""

    def __init__(self, *packets, interval=60_000):
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.incoming.put_nowait(json.dumps({"op": 10, "d": {"heartbeat_interval": interval}}))
        for packet in packets:
            self.incoming.put_nowait(
                packet if isinstance(packet, Exception | type(None)) else json.dumps(packet)
            )
        self.sent = []
        self.closed = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def recv(self):
        return await self.incoming.get()

    async def close(self, code=1000):
        self.closed = code
        self.incoming.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.incoming.get()
        if item is None:
            raise StopAsyncIteration
        if isinstance(item, Exception):
            raise item
        return item


class REST:
    def __init__(self):
        self.calls = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn.discordapp.com":
            return httpx.Response(200, content=b"%PDF-1.4")
        path = request.url.path.removeprefix("/api/v10")
        auth = request.headers.get("authorization")
        if request.headers.get("content-type", "").startswith("multipart/"):
            body = {"multipart": request.content}
        else:
            body = json.loads(request.content or b"null")
        self.calls.append((request.method, path, body, auth))
        if path.startswith("/interactions/"):
            return httpx.Response(204)
        if auth != f"Bot {TOKEN}":
            return httpx.Response(401, json={"message": "401: Unauthorized"})
        if path == "/users/@me":
            return httpx.Response(200, json={"id": "900", "username": "jarvis", "bot": True})
        if path == "/gateway/bot":
            return httpx.Response(200, json={"url": "wss://gateway.discord.test"})
        if request.method == "POST" and path.endswith("/messages"):
            return httpx.Response(200, json={"id": f"m{len(self.calls)}"})
        return httpx.Response(204)

    def posted(self):
        return [
            b
            for method, path, b, _a in self.calls
            if method == "POST" and path.endswith("/messages")
        ]


def dispatch(kind, data, seq):
    return {"op": 0, "t": kind, "s": seq, "d": data}


def dm(text, user="200", channel="300", **extra):
    return {
        "id": "m1",
        "channel_id": channel,
        "author": {"id": user, "username": "ann", "global_name": "Ann"},
        "content": text,
        "timestamp": "2026-09-29T10:00:00+00:00",
        **extra,
    }


READY = dispatch(
    "READY",
    {"session_id": "S1", "resume_gateway_url": "wss://resume.discord.test", "user": {"id": "900"}},
    1,
)


@pytest.fixture
def world(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setattr(dc, "_time", lambda _stamp: 0.0)  # "now": never taken as stale
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    discord = router.adapters["discord"]
    rest = REST()
    discord.transport = httpx.MockTransport(rest)
    router.vault.set("channel-discord", "token", TOKEN)
    discord.connected()
    hub.set_feature_prefs({"channels_discord_on": True})
    return hub, router, discord, rest


async def test_the_token_is_checked(world):
    hub, router, discord, rest = world
    assert await discord.verify({"token": TOKEN}) == {"id": "900", "name": "@jarvis"}
    with pytest.raises(ValueError, match="doesn't look like"):
        await discord.verify({"token": "nope"})
    with pytest.raises(ValueError, match="didn't accept"):
        await discord.verify({"token": "A" * 24 + ".BBBBBB." + "C" * 30})


async def test_it_identifies_answers_heartbeats_and_resumes_then_stops_on_a_refused_token(world):
    hub, router, discord, rest = world
    await hub.start()
    router.state.owners["discord"] = Owner("200", "300", "Ann")
    first = Gateway(
        READY,
        {"op": 1, "d": None},  # Discord asking for a heartbeat now
        dispatch("MESSAGE_CREATE", dm("what's on tomorrow?"), 2),
        dispatch("MESSAGE_CREATE", dm("my own echo", user="900"), 3),
        dispatch("MESSAGE_CREATE", dm("in a server", guild_id="G1"), 4),
        {"op": 7, "d": None},  # reconnect and resume
    )
    second = Gateway(dispatch("RESUMED", {}, 5), Closed(4004))
    sockets = [first, second]
    opened = []

    def connect(url):
        opened.append(url)
        return sockets.pop(0)

    discord.connect = connect
    await discord.run()
    await settle(router)
    identify = first.sent[0]
    assert identify["op"] == 2 and identify["d"]["intents"] == dc.INTENTS == 4096
    assert identify["d"]["token"] == TOKEN
    assert {"op": 1, "d": 1} in first.sent  # the heartbeat carries the last sequence seen
    assert second.sent[0] == {"op": 6, "d": {"token": TOKEN, "session_id": "S1", "seq": 4}}
    assert opened == [
        "wss://gateway.discord.test/?v=10&encoding=json",
        "wss://resume.discord.test/?v=10&encoding=json",
    ]
    assert hub.commands == 1 and hub.client.said[-1] == "what's on tomorrow?"
    reply = rest.posted()[-1]
    assert reply == {"content": "Two meetings tomorrow.", "allowed_mentions": {"parse": []}}
    assert discord.halted and "refused the bot token" in discord.error


async def test_a_refused_intent_stops_it(world):
    hub, router, discord, rest = world
    discord.connect = lambda url: Gateway(Closed(4014))
    await discord.run()
    assert discord.halted and "intent" in discord.error


async def test_a_silent_connection_is_dropped_and_resumed(world, monkeypatch):
    hub, router, discord, rest = world
    monkeypatch.setattr(dc.random, "random", lambda: 0.0)
    first = Gateway(READY, interval=20)  # heartbeats every 20 ms, never acknowledged
    second = Gateway(Closed(4004))
    sockets = [first, second]
    discord.connect = lambda url: sockets.pop(0)
    await discord.run()
    assert first.closed == 4000 and second.sent[0]["op"] == 6


async def test_a_session_discord_forgot_starts_afresh(world, monkeypatch):
    hub, router, discord, rest = world
    naps = []

    async def nap(seconds):
        naps.append(seconds)

    monkeypatch.setattr(dc.asyncio, "sleep", nap)
    first = Gateway(READY, {"op": 9, "d": False})
    second = Gateway(Closed(4004))
    sockets = [first, second]
    discord.connect = lambda url: sockets.pop(0)
    await discord.run()
    assert second.sent[0]["op"] == 2  # identified again, not resumed


async def test_a_button_answers_a_card_and_the_press_is_acknowledged(world):
    hub, router, discord, rest = world
    router.state.owners["discord"] = Owner("200", "300", "Ann")
    hub.set_feature_prefs({"channels_discord_approvals": False})  # the card below stands in
    asked = asyncio.create_task(hub.request_approval("Open the page?", ""))
    await asyncio.sleep(0)
    approval_id = next(iter(hub.approvals))
    router.cards[approval_id] = Card(approval_id, [("discord", "300", {"id": "m5", "text": "x"})])
    await discord._dispatch(
        "INTERACTION_CREATE",
        {
            "id": "I1",
            "token": "itok",
            "type": 3,
            "channel_id": "300",
            "user": {"id": "200"},
            "message": {"id": "m5"},
            "data": {"custom_id": f"a:{approval_id}:allow"},
        },
    )
    assert await asked == "allow"
    await settle(router)
    callbacks = [(b, a) for m, p, b, a in rest.calls if p == "/interactions/I1/itok/callback"]
    assert len(callbacks) == 1  # answered once, and without the bot's token
    body, auth = callbacks[0]
    assert auth is None and body["type"] == 4 and body["data"]["flags"] == 64
    assert ("PATCH", "/channels/300/messages/m5") in [(m, p) for m, p, _b, _a in rest.calls]


async def test_a_card_has_buttons_that_ping_no_one(world):
    hub, router, discord, rest = world
    card = {
        "id": "abcdef123456",
        "question": "Tell @everyone the plan?",
        "detail": "```\nrm -rf /\n```",
        "choices": [
            {"id": "allow", "label": "Yes"},
            {"id": "always", "label": "Yes, and don't ask again"},
            {"id": "deny", "label": "No"},
        ],
    }
    ref = await discord.send_card("300", card, "en")
    body = rest.posted()[-1]
    assert body["allowed_mentions"] == {"parse": []}
    assert body["content"].count("```") == 2
    ids = [b["custom_id"] for b in body["components"][0]["components"]]
    assert ids == [
        "a:abcdef123456:allow",
        "a:abcdef123456:always",
        "a:abcdef123456:deny",
        "a:abcdef123456:why",
    ]
    await discord.close_card("300", ref, "You chose: Yes.")
    method, path, patch, _auth = rest.calls[-1]
    assert (method, path) == ("PATCH", f"/channels/300/messages/{ref['id']}") and patch[
        "components"
    ] == []


async def test_attachments_come_only_from_discords_cdn(world):
    hub, router, discord, rest = world
    msg = discord._message(
        dm(
            "",
            flags=dc.VOICE_MESSAGE,
            attachments=[
                {
                    "filename": "voice-message.ogg",
                    "content_type": "audio/ogg",
                    "url": "https://cdn.discordapp.com/a/v.ogg",
                    "duration_secs": 3.2,
                },
                {
                    "filename": "x.pdf",
                    "content_type": "application/pdf",
                    "url": "https://evil.example/x.pdf",
                },
            ],
        )
    )
    assert [m.kind for m in msg.media] == ["voice", "voice"]
    assert msg.media[0].seconds == 3.2
    assert await msg.media[0].fetch() == b"%PDF-1.4"
    with pytest.raises(dc.DiscordError):
        await msg.media[1].fetch()


async def test_a_forwarded_message_is_marked_as_someone_elses(world):
    hub, router, discord, rest = world
    msg = discord._message(
        dm(
            "",
            message_reference={"type": 1, "message_id": "9"},
            message_snapshots=[{"message": {"content": "pay me"}}],
        )
    )
    assert msg.forwarded and msg.text == "pay me" and msg.reply_to == ""


async def test_long_replies_are_cut_at_2000(world):
    hub, router, discord, rest = world
    await discord.send_text("300", "word " * 1500, title="Eden Code #3 in alpha")
    bodies = [b["content"] for b in rest.posted()]
    assert len(bodies) >= 4 and all(dc.utf16_len(b) <= 2000 for b in bodies)
    assert bodies[0].startswith("**Eden Code #3 in alpha**\n")
