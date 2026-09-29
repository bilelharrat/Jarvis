import asyncio

import pytest
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
    for _ in range(4):
        with pytest.raises(PermissionError):
            devices.pair("000000", "Guess")
    good = devices.start_pairing()
    with pytest.raises(PermissionError, match="Too many"):
        devices.pair(good, "Late")  # locked out even with the right code
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

    def resolve(self, approval_id, choice):
        self.resolved.append((approval_id, choice))
        return True

    async def handle(self, msg):
        self.handled.append(msg)


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
    assert client.get("/api/state", headers=auth).json() == {"state": "idle"}
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
        reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
        writer.write(b"GET /api/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        await writer.drain()
        status = await asyncio.wait_for(reader.readline(), 5)
        writer.close()
        assert b" 401 " in status  # up, and still wants a paired device
    finally:
        await server.stop()
    assert not server.running
