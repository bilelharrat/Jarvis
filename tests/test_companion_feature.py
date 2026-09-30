"""The companion's feature module (jarvis.features.companion, jarvis.companion): pairing
by QR code, the Settings view, the log of what phones did, and the plain HTTP switch.
Servers here listen on loopback ports the system picks, never 8765, never announced."""

import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.testclient import TestClient
from test_hub import drain, make_hub

from jarvis import companion as companion_mod
from jarvis import prefs, qr, remote
from jarvis.companion import AuditLog, Companion


def loopback(hub):
    """The hub's companion server on 127.0.0.1, a free port, and no Bonjour."""
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    return hub


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return loopback(make_hub(settings, quiet_speaker, isolated=isolated))


def test_the_feature_installs_on_every_hub(hub):
    assert "companion" in hub.features
    assert isinstance(hub.remote.extension, Companion)
    for kind in ("companion", "companion_pairing", "companion_new_certificate"):
        assert kind in hub._commands
    assert remote.PLAIN_PREF in prefs.FEATURE_PREFS
    assert hub.prefs.feature(remote.PLAIN_PREF) is False  # off until the owner turns it on


def test_the_plain_http_switch_takes_only_a_yes_or_no(hub):
    hub.set_feature_prefs({remote.PLAIN_PREF: "yes"})
    assert hub.remote.plain_allowed() is False
    hub.set_feature_prefs({remote.PLAIN_PREF: True})
    assert hub.remote.plain_allowed() is True
    assert hub.remote.public()["plain_http"] is True
    hub.set_feature_prefs({remote.PLAIN_PREF: False})
    assert hub.remote.plain_allowed() is False


async def test_pairing_shows_a_qr_code_with_the_certificate(hub, monkeypatch):
    monkeypatch.setattr(remote, "local_host_name", lambda: "Test-Mac")
    monkeypatch.setattr(remote, "computer_name", lambda: "Bilel’s MacBook Pro")
    q = hub.subscribe()
    await hub._handle({"type": "companion_pairing"})
    assert "No pairing code" in drain(q)[-1]["error"]  # nothing to show yet

    assert await hub.remote.start()
    try:
        await hub._handle({"type": "remote_pair"})  # the built-in Pair a phone
        code = hub.remote.devices.code
        await hub._handle({"type": "companion_pairing"})
        shown = [e for e in drain(q) if e["type"] == "companion_pairing"][-1]
        url = hub.remote.extension.pairing_url(code)
        assert shown["qr"] == qr.rows(qr.encode(url))
        assert shown["short"] == hub.remote.identity.short and 290 <= shown["seconds"] <= 300
        parts = urlsplit(url)
        assert parts.scheme == "jarvis-pair"
        assert parts.netloc == f"Test-Mac.local:{hub.remote.port}"
        query = parse_qs(parts.query)
        assert query == {
            "code": [code],
            "fp": [hub.remote.identity.fingerprint],
            "name": ["Bilel’s MacBook Pro"],
        }
        assert "name=Bilel%E2%80%99s%20MacBook%20Pro" in url  # every character escaped
    finally:
        await hub.remote.stop()


async def test_with_no_local_name_the_code_carries_the_address(hub, monkeypatch):
    monkeypatch.setattr(remote, "local_host_name", lambda: "")
    monkeypatch.setattr(remote, "lan_address", lambda: "192.168.1.20")
    assert await hub.remote.start()
    try:
        url = hub.remote.extension.pairing_url("123456")
        assert url.startswith(f"jarvis-pair://192.168.1.20:{hub.remote.port}?code=123456&fp=")
    finally:
        await hub.remote.stop()


async def test_settings_show_the_certificate_the_phones_and_their_activity(hub):
    assert await hub.remote.start()
    try:
        client = TestClient(
            remote.create_remote_app(hub, hub.remote.devices, extension=hub.remote.extension)
        )
        token = client.post(
            "/api/pair", json={"code": hub.remote.devices.start_pairing(), "device_name": "iPhone"}
        ).json()["token"]
        auth = {"Authorization": f"Bearer {token}"}
        assert client.post("/api/command", json={"type": "stop"}, headers=auth).json() == {
            "ok": True
        }
        q = hub.subscribe()
        await hub._handle({"type": "companion"})
        status = [e for e in drain(q) if e["type"] == "companion"][-1]
        assert status["running"] and status["tls"]["fingerprint"] == hub.remote.identity.fingerprint
        assert [d["name"] for d in status["devices"]] == ["iPhone"]
        assert [(a["action"], a["label"]) for a in status["audit"]] == [
            ("paired", "Paired"),
            ("stop", "Stopped Jarvis"),
        ]
        assert all(a["name"] == "iPhone" for a in status["audit"])
    finally:
        await hub.remote.stop()
        await hub.remote.extension.flush()


async def test_a_new_certificate_unpairs_every_phone(hub):
    assert await hub.remote.start()
    old = hub.remote.identity.fingerprint
    hub.remote.devices.pair(hub.remote.devices.start_pairing(), "iPhone")
    q = hub.subscribe()
    try:
        await hub._handle({"type": "companion_new_certificate"})
        assert hub.remote.running and hub.remote.identity.fingerprint != old
        assert hub.remote.devices.items == []
        events = drain(q)
        assert any(e["type"] == "remote" for e in events)
        status = [e for e in events if e["type"] == "companion"][-1]
        assert status["tls"]["fingerprint"] == hub.remote.identity.fingerprint
    finally:
        await hub.remote.stop()


async def test_the_activity_log_is_kept_bounded_and_read_defensively(tmp_path, monkeypatch):
    monkeypatch.setattr(companion_mod, "AUDIT_KEEP", 5)
    path = tmp_path / "companion-audit.json"
    log = AuditLog(path)
    for i in range(8):
        log.add("d1", "iPhone", "asked", f"#{i}")
    await log.saver.flush()
    saved = json.loads(path.read_text())
    assert [row["detail"] for row in saved] == ["#3", "#4", "#5", "#6", "#7"]
    assert AuditLog(path).recent()[-1]["label"] == "Asked Jarvis"

    odd = tmp_path / "odd.json"
    odd.write_text('[{"action": "paired", "at": 5}, "junk", {"no": "action"}]')
    assert [r["action"] for r in AuditLog(odd).items] == ["paired"]
    damaged = tmp_path / "damaged.json"
    damaged.write_text("{not json")
    assert AuditLog(damaged).items == []  # set aside, never a crash
    assert list(tmp_path.glob("damaged.json.bad-*"))


async def test_answers_from_the_phone_are_logged_without_their_words(hub):
    client = TestClient(
        remote.create_remote_app(hub, hub.remote.devices, extension=hub.remote.extension)
    )
    token = client.post(
        "/api/pair", json={"code": hub.remote.devices.start_pairing(), "name": "iPhone"}
    ).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    asked = asyncio.create_task(hub.request_approval("Send this to Ann?", "Dinner at 8"))
    await asyncio.sleep(0)
    card = next(iter(hub.approvals.values()))
    reply = client.post(
        "/api/approve",
        json={"id": card["id"], "choice": "deny", "feedback": "make it 9 instead"},
        headers=auth,
    )
    assert reply.json() == {"ok": True}
    assert await asked == "deny:make it 9 instead"  # the reason reaches the card
    await hub.remote.extension.flush()
    saved = hub.feature_path("companion-audit.json").read_text()
    assert "said_no_because" in saved
    assert "make it 9" not in saved and "Dinner" not in saved and "Ann" not in saved
