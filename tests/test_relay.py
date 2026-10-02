"""The encrypted relay (jarvis.relay): the control line, a phone's stream joined to the
companion server and its bytes copied both ways, closing together, the backoff, a sign-out,
and the keeper that starts and stops it. A fake askeden.com relay (a websockets server) and
a TCP echo server stand in, both on 127.0.0.1 with ports of their own (never 8765)."""

import asyncio
import json
import os
from http import HTTPStatus
from types import SimpleNamespace

import pytest
from account_fakes import TOKEN
from websockets.asyncio.server import serve

from jarvis import relay as relay_mod
from jarvis.relay import MAX_FRAME, Keeper, Relay


class FakeRelay:
    """askeden.com's relay: one control line, and the accept side of each stream."""

    def __init__(self, refuse=None):
        self.refuse = refuse  # an HTTP status for every upgrade
        self.listen = None
        self.listening = asyncio.Event()
        self.heard = []  # text frames on the control line
        self.accepted = asyncio.Queue()
        self.paths = []
        self.auth = []

    def process_request(self, connection, request):
        if self.refuse:
            return connection.respond(self.refuse, "no\n")
        return None

    async def handler(self, ws):
        path = ws.request.path
        self.paths.append(path)
        self.auth.append(ws.request.headers.get("Authorization"))
        if path == "/listen":
            self.listen = ws
            self.listening.set()
            async for message in ws:
                self.heard.append(message)
        else:
            await self.accepted.put(ws)
            await ws.wait_closed()


@pytest.fixture
async def fake_relay():
    fake = FakeRelay()
    server = await serve(fake.handler, "127.0.0.1", 0, process_request=fake.process_request)
    port = server.sockets[0].getsockname()[1]
    fake.base = f"ws://127.0.0.1:{port}"
    yield fake
    server.close()
    await server.wait_closed()


class Echo:
    """The companion server: says back what it hears (or closes after the first chunk)."""

    def __init__(self, close_after_first=False):
        self.close_after_first = close_after_first
        self.closed = asyncio.Event()
        self.connections = 0

    async def handle(self, reader, writer):
        self.connections += 1
        try:
            while chunk := await reader.read(70_000):
                writer.write(chunk)
                await writer.drain()
                if self.close_after_first:
                    break
        finally:
            writer.close()
            await writer.wait_closed()
            self.closed.set()


@pytest.fixture
async def echo():
    made = Echo()
    server = await asyncio.start_server(made.handle, "127.0.0.1", 0)
    made.port = server.sockets[0].getsockname()[1]
    yield made
    server.close()
    await server.wait_closed()


def account():
    async def forget():
        stub.linked = False
        stub.forgot = True

    stub = SimpleNamespace(token=TOKEN, linked=True, forgot=False, forget=forget)
    return stub


async def until(check, seconds=5.0):
    for _ in range(int(seconds * 100)):
        if check():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("it never happened")


async def stop(task):
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_a_phones_stream_reaches_the_companion_and_its_bytes_go_both_ways(fake_relay, echo):
    relay = Relay(account(), lambda: echo.port, base=fake_relay.base)
    task = asyncio.create_task(relay.run())
    await asyncio.wait_for(fake_relay.listening.wait(), 5)
    await until(lambda: relay.state == "listening")
    await fake_relay.listen.send(json.dumps({"type": "open", "stream": "s1", "from": "0011"}))
    phone = await asyncio.wait_for(fake_relay.accepted.get(), 5)
    assert fake_relay.paths == ["/listen", "/accept?stream=s1"]
    assert fake_relay.auth == [f"Bearer {TOKEN}"] * 2
    payload = os.urandom(150_000)
    for at in range(0, len(payload), 50_000):
        await phone.send(payload[at : at + 50_000])
    back, frames = b"", []
    while len(back) < len(payload):
        frame = await asyncio.wait_for(phone.recv(), 5)
        frames.append(len(frame))
        back += frame
    assert back == payload and max(frames) <= MAX_FRAME
    await phone.close()  # the phone's side closes: so does the companion's
    await asyncio.wait_for(echo.closed.wait(), 5)
    assert relay.opened == 1
    await stop(task)
    assert relay.state == "off"


async def test_the_companion_closing_closes_the_phones_stream(fake_relay, echo):
    echo.close_after_first = True
    relay = Relay(account(), lambda: echo.port, base=fake_relay.base)
    task = asyncio.create_task(relay.run())
    await asyncio.wait_for(fake_relay.listening.wait(), 5)
    await fake_relay.listen.send(json.dumps({"type": "open", "stream": "s2"}))
    phone = await asyncio.wait_for(fake_relay.accepted.get(), 5)
    await phone.send(b"\x16\x03\x01 hello")
    assert await asyncio.wait_for(phone.recv(), 5) == b"\x16\x03\x01 hello"
    await asyncio.wait_for(phone.wait_closed(), 5)
    await stop(task)


async def test_pings_are_answered_and_frames_it_doesnt_know_are_left_alone(fake_relay, echo):
    relay = Relay(account(), lambda: echo.port, base=fake_relay.base)
    task = asyncio.create_task(relay.run())
    await asyncio.wait_for(fake_relay.listening.wait(), 5)
    await fake_relay.listen.send(json.dumps({"type": "ping"}))
    await fake_relay.listen.send(json.dumps({"type": "news", "stream": "x"}))
    await fake_relay.listen.send("not json")
    await fake_relay.listen.send(json.dumps({"type": "open", "stream": "../bad stream"}))
    await until(lambda: fake_relay.heard)
    await asyncio.sleep(0.05)
    assert [json.loads(m) for m in fake_relay.heard] == [{"type": "pong"}]
    assert relay.opened == 0 and relay.state == "listening"
    await stop(task)


async def test_with_the_companion_off_a_stream_opens_nothing(fake_relay):
    relay = Relay(account(), lambda: None, base=fake_relay.base)
    task = asyncio.create_task(relay.run())
    await asyncio.wait_for(fake_relay.listening.wait(), 5)
    await fake_relay.listen.send(json.dumps({"type": "open", "stream": "s3"}))
    await asyncio.sleep(0.05)
    assert fake_relay.accepted.empty() and relay.opened == 0
    await stop(task)


async def test_signed_out_the_relay_forgets_the_account_and_stops(fake_relay):
    fake_relay.refuse = HTTPStatus.UNAUTHORIZED
    stub = account()
    relay = Relay(stub, lambda: 1, base=fake_relay.base)
    await asyncio.wait_for(relay.run(), 5)
    assert stub.forgot and relay.state == "off"


async def test_it_reconnects_after_1_2_4_up_to_60_seconds():
    waited = []
    stub = account()

    class Refused:
        def __init__(self, *_a, **_k):
            pass

        async def __aenter__(self):
            raise OSError("refused")

        async def __aexit__(self, *_exc):
            return False

    async def sleep(seconds):
        waited.append(seconds)
        if len(waited) == 9:
            stub.linked = False

    relay = Relay(stub, lambda: 1, base="ws://127.0.0.1:9", connect=Refused, sleep=sleep)
    await relay.run()
    assert waited == [1, 2, 4, 8, 16, 32, 60, 60, 60]


async def test_a_line_that_held_a_while_starts_the_backoff_over():
    waited = []
    stub = account()
    now = [0.0]

    class Brief:
        def __init__(self, *_a, **_k):
            pass

        async def __aenter__(self):
            now[0] += 45  # it stayed up 45 seconds before dropping
            raise OSError("dropped")

        async def __aexit__(self, *_exc):
            return False

    async def sleep(seconds):
        waited.append(seconds)
        if len(waited) == 3:
            stub.linked = False

    relay = Relay(stub, lambda: 1, connect=Brief, sleep=sleep, clock=lambda: now[0])
    await relay.run()
    assert waited == [1, 1, 1]


async def test_the_keeper_runs_the_relay_only_while_its_wanted(monkeypatch):
    runs = []

    class Stub:
        async def run(self):
            runs.append("up")
            try:
                await asyncio.sleep(3600)
            finally:
                runs.append("down")

    wanted = [False]
    keeper = Keeper(Stub(), lambda: wanted[0])
    await keeper.check()
    assert not keeper.running
    wanted[0] = True
    await keeper.check()
    await asyncio.sleep(0)
    assert keeper.running and runs == ["up"]
    await keeper.check()  # still wanted: the same one
    wanted[0] = False
    await keeper.check()
    assert not keeper.running and runs == ["up", "down"]


async def test_the_app_wants_the_relay_while_linked_switched_on_and_the_companion_runs(
    settings, quiet_speaker, isolated
):
    from test_hub import make_hub

    from jarvis.account import RELAY_PREF

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    desk = hub.account_desk
    assert not desk.relay_wanted()
    await hub.account._keep(TOKEN, None)
    assert not desk.relay_wanted()  # the companion is off
    assert await hub.remote.start()
    try:
        assert desk.relay_wanted() and desk._port() == hub.remote.port != 0
        hub.set_feature_prefs({RELAY_PREF: False})
        assert not desk.relay_wanted()
    finally:
        await hub.remote.stop()


def test_the_relays_address_is_askedens():
    assert relay_mod.WS_BASE == "wss://askeden.com/api/relay"
