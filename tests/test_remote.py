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
