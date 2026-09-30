import asyncio

import pytest
from companion_support import exchange, get, open_pinned
from starlette.testclient import TestClient

from jarvis import remote
from jarvis.remote import Devices, create_remote_app


def test_pairing_codes_are_single_use_and_rate_limited(tmp_path):
    devices = Devices(tmp_path / "devices.json")
    code = devices.start_pairing()
    token = devices.pair(code, "iPhone")
    assert devices.check(token).name == "iPhone"
    assert token not in (tmp_path / "devices.json").read_text()  # only a hash is kept
    with pytest.raises(PermissionError):
        devices.pair(code, "Again")  # used up
    good = devices.start_pairing()
    for _ in range(5):
        with pytest.raises(PermissionError):
            devices.pair("000000", "Guess")
    with pytest.raises(PermissionError, match="Too many"):
        devices.pair(good, "Late")  # that address is locked out even with the right code
    assert devices.remove(devices.items[0].id) and devices.check(token) is None


def test_expired_codes_fail(tmp_path, monkeypatch):
    devices = Devices(tmp_path / "devices.json")
    code = devices.start_pairing()
    monkeypatch.setattr(remote.time, "monotonic", lambda: devices.code_expires + 1)
    with pytest.raises(PermissionError, match="expired"):
        devices.pair(code, "Slow")


class FakeHub:
    def __init__(self):
        self.handled, self.asked, self.resolved = [], [], []
        self.speaker = None

    def emit(self, *_a, **_k):
        pass

    def remote_state(self):
        return {"state": "idle"}

    async def remote_ask(self, text, timeout):
        self.asked.append(text)
        return {"reply": "Two meetings tomorrow.", "done": True, "approvals": []}

    def resolve(self, approval_id, choice, feedback=""):
        self.resolved.append((approval_id, choice, feedback))
        return True

    async def handle(self, msg):
        self.handled.append(msg)

    async def remote_command(self, msg):
        self.handled.append(msg)
        return True


def test_the_api_needs_a_paired_token_and_allows_only_a_few_commands(tmp_path):
    hub, devices = FakeHub(), Devices(tmp_path / "devices.json")
    client = TestClient(create_remote_app(hub, devices))
    assert "J.A.R.V.I.S." in client.get("/").text
    assert client.get("/remote.js").status_code == 200
    assert client.get("/static/app.js").status_code == 404  # nothing else from the app
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/ask", json={"text": "hi"}).status_code == 401
    bad = client.post("/api/pair", json={"code": "123456", "name": "x"})
    assert bad.status_code == 403
    token = client.post(
        "/api/pair", json={"code": devices.start_pairing(), "name": "iPhone"}
    ).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/state", headers=auth).json() == {"state": "idle", "tls": False}
    assert (
        client.post("/api/ask", json={"text": "what's on tomorrow"}, headers=auth).json()["reply"]
        == "Two meetings tomorrow."
    )
    assert client.post(
        "/api/approve", json={"id": "a1", "choice": "allow"}, headers=auth
    ).json() == {"ok": True}
    assert client.post("/api/command", json={"type": "stop"}, headers=auth).json() == {"ok": True}
    refused = client.post("/api/command", json={"type": "set_prefs", "changes": {}}, headers=auth)
    assert refused.status_code == 400 and hub.handled == [{"type": "stop"}]


async def test_phone_requests_are_silent_on_the_mac(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    spoken = []
    hub.speech.push = spoken.append
    result = await hub.remote_ask("what's on tomorrow?", timeout=5)
    assert result == {"reply": "Two meetings tomorrow.", "done": True, "approvals": []}
    assert spoken == []
    assert hub.remote.running is False  # off until the user turns it on
    await asyncio.sleep(0)


def _busy_port():
    """A throwaway listening socket on the loopback, like another app holding the port."""
    import socket

    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    return blocker, blocker.getsockname()[1]


async def test_a_busy_port_switches_the_companion_off_instead_of_killing_the_app(
    settings, quiet_speaker, isolated
):
    """uvicorn meets a busy port with sys.exit(); that SystemExit used to escape the event
    loop and kill the backend, and with the setting saved on, at every launch after."""
    from test_hub import drain, make_hub

    from jarvis.prefs import PrefsStore

    isolated["prefs_store"].prefs.remote_enabled = True  # switched on in an earlier run
    blocker, port = _busy_port()
    try:
        hub = make_hub(settings, quiet_speaker, isolated=isolated)
        hub.remote.host, hub.remote.port = "127.0.0.1", port
        q = hub.subscribe()
        await hub.start()  # the launch that used to die
        await asyncio.sleep(0.05)
        assert hub.remote.running is False
        assert hub.prefs.remote_enabled is False
        assert PrefsStore(isolated["prefs_store"].path).prefs.remote_enabled is False
        assert f"Port {port} is in use" in hub.remote.public()["error"]
        events = drain(q)
        assert any(e["type"] == "error" and "in use" in e["text"] for e in events)
        assert any(e["type"] == "prefs" and e["remote_enabled"] is False for e in events)

        hub.set_prefs({"remote_enabled": True})  # and turning it on from Settings
        await asyncio.sleep(0.1)
        assert hub.prefs.remote_enabled is False and not hub.remote.running
        assert any(e["type"] == "remote" and e["error"] for e in drain(q))
    finally:
        blocker.close()


async def test_uvicorn_exiting_never_takes_the_app_down(tmp_path, monkeypatch):
    import uvicorn

    async def exits(self, sockets=None):
        raise SystemExit(3)

    monkeypatch.setattr(uvicorn.Server, "serve", exits)
    server = remote.RemoteServer(FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")
    assert await server.start() is False
    assert not server.running and "couldn't start" in server.error


async def test_the_companion_serves_on_the_socket_it_bound(tmp_path):
    server = remote.RemoteServer(FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")
    assert await server.start() is True
    try:
        assert server.running and server.port and server.error == ""
        reply = await exchange(server.port, server.identity.fingerprint, get("/api/state"))
        assert b" 401 " in reply.split(b"\r\n")[0]  # up, over TLS, and wants a paired device
    finally:
        await server.stop()
    assert not server.running


def test_the_txt_record_is_length_prefixed():
    assert remote.txt_record({"host": "Mac.local"}) == b"\x0ehost=Mac.local"
    assert remote.txt_record({}) == b""


async def test_the_companion_is_announced_while_it_listens(tmp_path, monkeypatch):
    calls = []

    class Register:
        def __call__(self, name, kind, port, txt):
            calls.append(("start", name, kind, port, txt))
            return "handle"

        def stop(self, handle):
            calls.append(("stop", handle))

    monkeypatch.setattr(remote, "local_host_name", lambda: "Test-Mac")
    advertiser = remote.Advertiser(Register())
    server = remote.RemoteServer(
        FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1", advertiser=advertiser
    )
    assert await server.start()
    short = server.identity.short  # "a1b2 c3d4 e5f6 0718": a hint for the pairing list
    assert calls == [
        (
            "start",
            "J.A.R.V.I.S. on Test-Mac",
            "_jarvis._tcp",
            server.port,
            b"\x13host=Test-Mac.local\x05tls=1" + bytes([3 + len(short)]) + f"fp={short}".encode(),
        )
    ]
    assert advertiser.active
    await server.stop()
    assert calls[-1] == ("stop", "handle") and not advertiser.active


def test_loopback_servers_are_never_announced(tmp_path):
    server = remote.RemoteServer(FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")
    assert server.advertiser is None


def test_a_huge_or_odd_body_is_refused_before_it_is_read(tmp_path):
    client = TestClient(create_remote_app(FakeHub(), Devices(tmp_path / "devices.json")))
    big = client.post("/api/pair", content=b"x" * 50, headers={"content-length": "100000000"})
    assert big.status_code == 413
    streamed = client.post("/api/pair", content=iter([b"{" * 8_000] * 5))  # no length given
    assert streamed.status_code == 413
    nested = client.post("/api/pair", content=b"[" * 19_000)  # deep, and under the cap
    assert nested.status_code == 403  # read as no code, never a crash


def test_one_address_can_not_lock_the_owner_out(tmp_path):
    devices = Devices(tmp_path / "devices.json")
    code = devices.start_pairing()
    for _ in range(remote.MAX_FAILURES):
        with pytest.raises(PermissionError):
            devices.pair("000000", "Guess", "10.0.0.66")
    with pytest.raises(PermissionError, match="Too many"):
        devices.pair(code, "Them", "10.0.0.66")
    assert devices.check(devices.pair(code, "My iPhone", "10.0.0.5")).name == "My iPhone"


def test_wrong_codes_with_no_code_up_lock_no_one(tmp_path):
    devices = Devices(tmp_path / "devices.json")
    for i in range(remote.MAX_GLOBAL_FAILURES * 2):
        with pytest.raises(PermissionError):
            devices.pair("000000", "Guess", f"10.0.1.{i % 7}")
    assert devices.check(devices.pair(devices.start_pairing(), "Mine", "10.0.1.3")) is not None


def test_a_code_guessed_at_from_many_addresses_is_spent(tmp_path):
    devices = Devices(tmp_path / "devices.json")
    code = devices.start_pairing()
    for i in range(remote.MAX_GLOBAL_FAILURES):
        with pytest.raises(PermissionError):
            devices.pair("000000", "Guess", f"10.0.1.{i}")
    with pytest.raises(PermissionError):
        devices.pair(code, "Late", "10.0.0.5")  # spent, whoever types it
    assert devices.check(devices.pair(devices.start_pairing(), "Mine", "10.0.0.5")) is not None


def test_the_device_list_is_capped(tmp_path):
    devices = Devices(tmp_path / "devices.json")
    tokens = [
        devices.pair(devices.start_pairing(), f"Phone {i}") for i in range(remote.MAX_DEVICES + 3)
    ]
    assert len(devices.items) == remote.MAX_DEVICES
    assert devices.check(tokens[-1]) is not None


def test_a_phone_gets_one_request_at_a_time(tmp_path):
    class SlowHub(FakeHub):
        waiting = []

        async def remote_ask(self, text, timeout):
            self.asked.append(text)
            await asyncio.sleep(0.3)
            return {"reply": "Done.", "done": True, "approvals": []}

    hub, devices = SlowHub(), Devices(tmp_path / "devices.json")
    token = devices.pair(devices.start_pairing(), "iPhone")
    app = create_remote_app(hub, devices)
    import httpx

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://phone") as client:
            auth = {"authorization": f"Bearer {token}"}
            first = asyncio.create_task(client.post("/api/ask", json={"text": "one"}, headers=auth))
            await asyncio.sleep(0.05)
            second = await client.post("/api/ask", json={"text": "two"}, headers=auth)
            return (await first).status_code, second.status_code

    assert asyncio.run(run()) == (200, 429)
    assert hub.asked == ["one"]


def test_a_body_cut_off_midway_is_not_an_error(tmp_path):
    app = create_remote_app(FakeHub(), Devices(tmp_path / "devices.json"))
    sent = []

    async def run():
        messages = iter(
            [
                {"type": "http.request", "body": b'{"code": "12', "more_body": True},
                {"type": "http.disconnect"},
            ]
        )

        async def receive():
            return next(messages)

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http", "method": "POST", "path": "/api/pair", "raw_path": b"/api/pair",
            "query_string": b"", "headers": [], "client": ("10.0.0.9", 5000),
            "server": ("127.0.0.1", 8765), "scheme": "http", "http_version": "1.1",
        }  # fmt: skip
        await app(scope, receive, send)

    asyncio.run(run())
    status = [m["status"] for m in sent if m["type"] == "http.response.start"]
    assert status == [413]  # refused plainly, never a 500


async def test_a_request_that_never_finishes_is_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(remote, "REQUEST_SECONDS", 0.3)
    server = remote.RemoteServer(FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")
    assert await server.start()
    try:
        reader, writer = await open_pinned(server.port, server.identity.fingerprint)
        writer.write(b"GET /api/state HTTP/1.1\r\nHost: x\r\n")  # headers never finished
        await writer.drain()
        assert await asyncio.wait_for(reader.read(), 3) == b""  # the server hung up
        writer.close()
    finally:
        await server.stop()


async def test_one_address_gets_a_few_connections(tmp_path, monkeypatch):
    monkeypatch.setattr(remote, "PER_ADDRESS", 2)
    server = remote.RemoteServer(FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")
    assert await server.start()
    fingerprint = server.identity.fingerprint
    try:
        held = [await open_pinned(server.port, fingerprint) for _ in range(2)]
        reader, _w = await open_pinned(server.port, fingerprint)
        assert await asyncio.wait_for(reader.read(), 2) == b""  # the third is turned away
        for _, w in held:
            w.close()
        await asyncio.sleep(0.1)
        reply = await exchange(server.port, fingerprint, get("/api/state"))
        assert b" 401 " in reply.split(b"\r\n")[0]
    finally:
        await server.stop()


async def test_the_phone_can_not_queue_turns_without_end(
    settings, quiet_speaker, isolated, monkeypatch
):
    from test_hub import make_hub

    from jarvis import hub as hubmod

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    fast = hub.client.receive_response

    async def slow():
        await asyncio.sleep(0.2)
        async for m in fast():
            yield m

    monkeypatch.setattr(hub.client, "receive_response", slow)
    asks = await asyncio.gather(*[hub.remote_ask(f"q{i}", timeout=5) for i in range(10)])
    assert sum(bool(r.get("busy")) for r in asks) == 10 - hubmod.REMOTE_TURNS
    assert hub.commands == hubmod.REMOTE_TURNS
    started = [await hub.remote_command({"type": "briefing"}) for _ in range(5)]
    assert started.count(True) == hubmod.REMOTE_TURNS


async def test_stop_silences_every_voice_process(quiet_speaker):
    class Proc:
        returncode = None
        killed = False

        def kill(self):
            self.killed = True

    procs = [Proc(), Proc()]
    quiet_speaker._procs = set(procs)  # the Mac's own voice and a phone's clip
    quiet_speaker.stop()
    assert all(p.killed for p in procs)
