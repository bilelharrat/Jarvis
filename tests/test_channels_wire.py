"""Slack and Discord over the wire: the adapters' own HTTP client and the real websockets
client against local fakes of Slack's Web API and Socket Mode, and of Discord's REST API and
Gateway (tests/chat_wire.py), on real sockets, TLS for the WebSockets. What's checked is the
exchange itself: acks and heartbeats as sent, identify and resume, a reply posted, a 429's
wait honoured, a button press answered, a refused token, and reconnecting after a drop
(at once when the service asks, after a pause otherwise, and promptly again once a
connection has been good). Nothing leaves 127.0.0.1."""

import asyncio
import json
import time
from datetime import UTC, datetime

import pytest
from channels_fakes import make_hub, settle
from chat_wire import HTTPFake, Redirect, Sleeps, WSFake, until
from starlette.responses import JSONResponse, Response

from jarvis.channels import discord as dc
from jarvis.channels import slack as sl
from jarvis.channels.store import Owner

# Made-up tokens in the services' shapes, built from parts so that no secret scanner takes
# them for real ones (a Slack app-level token, a Slack bot token, a Discord bot token).
APP = "-".join(["xa" + "pp", "1", "A0123456789", "1234567890123", "a" * 40])
BOT = "-".join(["xo" + "xb", "1234567890", "1234567890123", "b" * 24])
TOKEN = ".".join(["A" * 24, "B" * 6, "C" * 30])


# ── Slack ──


class SlackAPI:
    """Slack's Web API as the fake answers it: Socket Mode addresses on the fake socket
    server, messages kept, and 429s or refusals when a test asks for them."""

    def __init__(self, ws: WSFake) -> None:
        self.ws = ws
        self.opened = 0
        self.refuse = False
        self.limited = 0  # chat.postMessage answers 429 this many times first

    async def __call__(self, seen) -> Response:
        method = seen.path.rsplit("/", 1)[-1]
        token = seen.headers.get("authorization", "")[7:]
        if method == "apps.connections.open":
            if token != APP or self.refuse:
                return JSONResponse({"ok": False, "error": "invalid_auth"})
            self.opened += 1
            return JSONResponse({"ok": True, "url": self.ws.url(f"/link/{self.opened}")})
        if token != BOT:
            return JSONResponse({"ok": False, "error": "invalid_auth"})
        if method == "chat.postMessage" and self.limited:
            self.limited -= 1
            return JSONResponse(
                {"ok": False, "error": "ratelimited"}, status_code=429, headers={"Retry-After": "1"}
            )
        if method == "chat.postMessage":
            return JSONResponse({"ok": True, "ts": f"1700.{len(seen.body)}"})
        return JSONResponse({"ok": True})


def slack_dm(text, event_id, user="UANN", channel="D1"):
    return {
        "envelope_id": f"env-{event_id}",
        "type": "events_api",
        "payload": {
            "team_id": "T1",
            "event_id": event_id,
            "event": {
                "type": "message",
                "channel": channel,
                "channel_type": "im",
                "user": user,
                "text": text,
                "ts": f"{time.time():.6f}",
            },
        },
    }


@pytest.fixture
async def slack_world(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    slack = router.adapters["slack"]
    router.vault.set("channel-slack", "app_token", APP)
    router.vault.set("channel-slack", "bot_token", BOT)
    router.state.bots["slack"] = {"id": "UJARVIS", "name": "@jarvis"}
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    hub.set_feature_prefs({"channels_slack_on": True})
    async with WSFake(tmp_path) as ws:
        api = SlackAPI(ws)
        async with HTTPFake(api) as http:
            slack.transport = Redirect(http.port)
            slack.connected()
            slack.connect = ws.dial(4 * 1024 * 1024)
            runs = []

            def start():
                runs.append(asyncio.create_task(slack.run()))
                return runs[-1]

            yield hub, router, slack, api, http, ws, start
            for run in runs:
                run.cancel()
                await asyncio.gather(run, return_exceptions=True)
            await settle(router)


def posted(http):
    return [s.json() for s in http.calls("/chat.postMessage")]


async def test_slack_answers_the_owner_over_the_wire_and_acks_every_envelope(slack_world):
    hub, router, slack, api, http, ws, start = slack_world
    await hub.start()
    start()
    conn = await ws.next()
    assert conn.path == "/link/1"
    await conn.send({"type": "hello"})
    await until(lambda: slack.state == "listening", what="listening")
    await conn.send(slack_dm("what's on tomorrow?", "Ev1"))
    assert await conn.recv() == {"envelope_id": "env-Ev1"}  # acknowledged at once
    await conn.send(slack_dm("what's on tomorrow?", "Ev1"))  # Slack sending it again
    assert await conn.recv() == {"envelope_id": "env-Ev1"}  # acknowledged, not run twice
    await until(lambda: posted(http), what="the reply")
    await settle(router)
    assert hub.commands == 1
    [reply] = posted(http)
    assert reply == {
        "channel": "D1",
        "text": "Two meetings tomorrow.",
        "unfurl_links": False,
        "unfurl_media": False,
    }
    [call] = http.calls("/chat.postMessage")
    assert call.host == "slack.com" and call.headers["authorization"] == f"Bearer {BOT}"
    [opened] = http.calls("/apps.connections.open")
    assert opened.headers["authorization"] == f"Bearer {APP}"  # the app-level token, there only


async def test_slack_reconnects_at_once_when_it_asks_and_after_a_pause_when_the_socket_drops(
    slack_world, monkeypatch
):
    hub, router, slack, api, http, ws, start = slack_world
    sleeps = Sleeps()
    monkeypatch.setattr(sl, "asyncio", sleeps)
    start()
    first = await ws.next()
    await first.send({"type": "hello"})
    await until(lambda: slack.state == "listening", what="listening")
    await first.send({"type": "disconnect", "reason": "refresh_requested"})
    second = await ws.next()
    assert second.path == "/link/2" and api.opened == 2
    assert [s for s in sleeps.seen if s >= 1] == []  # Slack asked: a new socket at once
    await second.send({"type": "hello"})
    await until(lambda: slack.state == "listening", what="listening again")
    # Now sockets that close without a word, again and again: each retry waits longer, and
    # none is made in a burst.
    await second.close(1011)
    for _ in range(3):
        conn = await ws.next()
        await conn.close(1000)
    await ws.next()
    assert [s for s in sleeps.seen if s >= 1] == [1.0, 2.0, 4.0, 8.0]
    assert slack.state == "reconnecting"


async def test_slack_waits_out_a_rate_limit_and_sends_once(slack_world):
    hub, router, slack, api, http, ws, start = slack_world
    await hub.start()
    api.limited = 1
    start()
    conn = await ws.next()
    await conn.send({"type": "hello"})
    await conn.send(slack_dm("what's on tomorrow?", "Ev7"))
    assert await conn.recv() == {"envelope_id": "env-Ev7"}
    began = time.monotonic()
    await until(lambda: len(http.calls("/chat.postMessage")) == 2, 20, what="the retry")
    assert time.monotonic() - began >= 0.9  # Retry-After: 1 was honoured
    await settle(router)
    assert [p["text"] for p in posted(http)] == ["Two meetings tomorrow."] * 2  # the 429, then it
    assert len(http.calls("/chat.postMessage")) == 2


async def test_slack_stops_for_good_when_the_token_is_refused(slack_world):
    hub, router, slack, api, http, ws, start = slack_world
    api.refuse = True
    run = start()
    await asyncio.wait_for(run, 10)
    assert slack.halted and "refused the tokens" in slack.error and ws.count == 0


# ── Discord ──


class DiscordAPI:
    """Discord's REST API as the fake answers it: the Gateway's address, messages kept, a
    429 (with retry_after) when a test asks, and /gateway/bot failing a few times first."""

    def __init__(self, ws: WSFake) -> None:
        self.ws = ws
        self.limited = 0
        self.gateway_fails = 0

    async def __call__(self, seen) -> Response:
        if seen.headers.get("authorization", "") not in (f"Bot {TOKEN}", ""):
            return JSONResponse({"message": "401: Unauthorized", "code": 0}, status_code=401)
        if seen.path.endswith("/gateway/bot"):
            if self.gateway_fails:
                self.gateway_fails -= 1
                return JSONResponse({"message": "bad gateway"}, status_code=502)
            return JSONResponse({"url": self.ws.url()})
        if seen.path.endswith("/messages") and seen.method == "POST" and self.limited:
            self.limited -= 1
            return JSONResponse(
                {"message": "You are being rate limited.", "retry_after": 0.3, "global": False},
                status_code=429,
            )
        if seen.path.endswith("/messages") and seen.method == "POST":
            return JSONResponse({"id": f"m{len(seen.body)}"})
        if seen.path.endswith("/typing") or "/interactions/" in seen.path:
            return Response(status_code=204)
        return JSONResponse({})


async def heartbeat_acks(conn, msg) -> bool:
    if isinstance(msg, dict) and msg.get("op") == 1:
        await conn.send({"op": 11})
        return True
    return False


def dispatch(kind, data, seq):
    return {"op": 0, "t": kind, "s": seq, "d": data}


def discord_dm(text, user="200", channel="300"):
    return {
        "id": "m1",
        "channel_id": channel,
        "author": {"id": user, "username": "ann", "global_name": "Ann"},
        "content": text,
        "timestamp": datetime.now(UTC).isoformat(),
    }


async def hello(conn, interval_ms=45_000):
    await conn.send({"op": 10, "d": {"heartbeat_interval": interval_ms}})
    return await conn.recv()


def ready(ws, seq=1):
    return dispatch(
        "READY",
        {"session_id": "S1", "resume_gateway_url": ws.url(), "user": {"id": "900"}},
        seq,
    )


@pytest.fixture
async def discord_world(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    discord = router.adapters["discord"]
    router.vault.set("channel-discord", "token", TOKEN)
    router.state.owners["discord"] = Owner("200", "300", "Ann")
    hub.set_feature_prefs({"channels_discord_on": True})
    async with WSFake(tmp_path) as ws:
        api = DiscordAPI(ws)
        async with HTTPFake(api) as http:
            discord.transport = Redirect(http.port)
            discord.connected()
            discord.connect = ws.dial(8 * 1024 * 1024)
            runs = []

            def start():
                runs.append(asyncio.create_task(discord.run()))
                return runs[-1]

            yield hub, router, discord, api, http, ws, start
            for run in runs:
                run.cancel()
                await asyncio.gather(run, return_exceptions=True)
            await settle(router)


def sent_messages(http):
    return [s for s in http.calls("/messages") if s.method == "POST"]


async def test_discord_identifies_heartbeats_and_answers_the_owner_over_the_wire(
    discord_world,
):
    hub, router, discord, api, http, ws, start = discord_world
    await hub.start()
    start()
    conn = await ws.next()
    assert conn.path == "/?v=10&encoding=json"
    identify = await hello(conn, interval_ms=1000)
    assert identify["op"] == 2 and identify["d"]["token"] == TOKEN
    assert identify["d"]["intents"] == dc.INTENTS
    conn.auto = heartbeat_acks  # every heartbeat acknowledged, as Discord does
    await conn.send(ready(ws, seq=1))
    await until(lambda: discord.state == "listening", what="listening")
    # A heartbeat each second (the interval its hello gave), with the last sequence seen.
    await until(lambda: {"op": 1, "d": 1} in conn.log, what="a heartbeat")
    await conn.send(dispatch("MESSAGE_CREATE", discord_dm("what's on tomorrow?"), 2))
    await until(lambda: sent_messages(http), what="the reply")
    await settle(router)
    [reply] = sent_messages(http)
    assert reply.json() == {"content": "Two meetings tomorrow.", "allowed_mentions": {"parse": []}}
    assert reply.path == "/api/v10/channels/300/messages" and reply.host == "discord.com"
    assert reply.headers["authorization"] == f"Bot {TOKEN}"
    assert hub.commands == 1


async def test_discord_resumes_after_a_reconnect_and_waits_out_a_rate_limit(discord_world):
    hub, router, discord, api, http, ws, start = discord_world
    await hub.start()
    api.limited = 1
    start()
    first = await ws.next()
    await hello(first)
    await first.send(ready(ws, seq=1))
    await first.send({"op": 7, "d": None})  # Discord: reconnect and resume
    second = await ws.next()
    resume = await hello(second)
    assert resume == {"op": 6, "d": {"token": TOKEN, "session_id": "S1", "seq": 1}}
    await second.send(dispatch("RESUMED", {}, 3))
    await until(lambda: discord.state == "listening", what="resumed")
    await second.send(dispatch("MESSAGE_CREATE", discord_dm("what's on tomorrow?"), 4))
    began = time.monotonic()
    await until(lambda: len(sent_messages(http)) == 2, 20, what="the retried reply")
    assert time.monotonic() - began >= 0.25  # retry_after 0.3 was honoured
    await settle(router)
    assert len(sent_messages(http)) == 2 and hub.commands == 1  # the 429, then it, once
    assert len(http.calls("/gateway/bot")) == 1  # resumed where the session was: no new one


async def test_discord_stops_for_good_when_the_token_is_refused(discord_world):
    hub, router, discord, api, http, ws, start = discord_world
    run = start()
    conn = await ws.next()
    await hello(conn)
    await conn.close(4004, "Authentication failed")
    await asyncio.wait_for(run, 10)
    assert discord.halted and "refused the bot token" in discord.error


async def test_discord_reconnects_promptly_once_a_connection_has_been_good(
    discord_world, monkeypatch
):
    """Retries after failures wait longer each time; a connection that then works (READY)
    starts that over: the next drop is retried after the first wait, not the last one."""
    hub, router, discord, api, http, ws, start = discord_world
    sleeps = Sleeps()
    monkeypatch.setattr(dc, "asyncio", sleeps)
    api.gateway_fails = 3  # Discord unreachable for a while
    start()
    conn = await ws.next()
    assert [s for s in sleeps.seen if s >= 1] == [1.0, 2.0, 4.0]
    await hello(conn)
    conn.auto = heartbeat_acks
    await conn.send(ready(ws))
    await until(lambda: discord.state == "listening", what="listening")
    before = len(sleeps.seen)
    await conn.close(1011)  # dropped (a server error), not asked to resume
    await until(lambda: len(sleeps.seen) > before, what="the wait before retrying")
    assert sleeps.seen[before] == 1.0


async def test_discord_button_press_is_answered_over_the_wire(discord_world):
    hub, router, discord, api, http, ws, start = discord_world
    start()
    conn = await ws.next()
    await hello(conn)
    conn.auto = heartbeat_acks
    await conn.send(ready(ws))
    await until(lambda: discord.state == "listening", what="listening")
    press = {
        "type": 3,
        "id": "I1",
        "token": "itoken",
        "channel_id": "300",
        "user": {"id": "200", "username": "ann"},
        "data": {"custom_id": "a:abcdef12:allow"},
        "message": {"id": "m9"},
    }
    await conn.send(dispatch("INTERACTION_CREATE", press, 2))
    [callback] = await until(lambda: http.calls("/callback"), what="the interaction's answer")
    assert callback.path == "/api/v10/interactions/I1/itoken/callback"
    assert "authorization" not in callback.headers  # its own token is in the address
    assert json.loads(callback.body)["type"] == 4  # "that card is gone", to the owner alone
