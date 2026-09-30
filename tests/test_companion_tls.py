"""HTTPS for the phone companion: the Mac's own certificate (jarvis.companion_tls), served
on an ephemeral loopback port, pinned by fingerprint the way the app pins it; plain HTTP
only behind the owner's switch; pairing refused when the phone pinned another
certificate."""

import asyncio
import hashlib
import json
import os
import ssl
from datetime import UTC, datetime

import pytest
from companion_support import WrongCertificate, exchange, get, open_pinned, post

from jarvis import companion_tls, remote
from jarvis.remote import Devices


class Prefs:
    def __init__(self, plain=False):
        self.values = {remote.PLAIN_PREF: plain}

    def feature(self, key):
        return self.values.get(key)


class FakeHub:
    def __init__(self, plain=False):
        self.prefs = Prefs(plain)
        self.emitted = []
        self.speaker = None

    def emit(self, kind, **data):
        self.emitted.append((kind, data))

    def remote_state(self):
        return {"state": "idle"}


def server_for(tmp_path, hub=None):
    return remote.RemoteServer(hub or FakeHub(), Devices(tmp_path / "devices.json"), 0, "127.0.0.1")


def status(reply: bytes) -> int:
    return int(reply.split(b"\r\n", 1)[0].split()[1])


def payload(reply: bytes) -> dict:
    return json.loads(reply.split(b"\r\n\r\n", 1)[1])


# ── the certificate ──


def test_a_certificate_is_made_once_and_kept(tmp_path):
    from cryptography import x509
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID

    made = companion_tls.load_or_create(tmp_path, ["Test-Mac.local", "192.168.1.20"])
    path = tmp_path / companion_tls.FILE_NAME
    assert path.stat().st_mode & 0o777 == 0o600  # the key is the owner's alone
    raw = path.read_bytes()
    assert b"PRIVATE KEY" in raw and b"CERTIFICATE" in raw
    cert = x509.load_pem_x509_certificate(raw)
    der = cert.public_bytes(
        encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.DER
    )
    assert made.fingerprint == hashlib.sha256(der).hexdigest()
    assert len(made.fingerprint) == 64 and made.fingerprint == made.fingerprint.lower()
    assert made.short == " ".join(made.fingerprint[i : i + 4] for i in range(0, 16, 4))
    assert isinstance(cert.public_key(), ec.EllipticCurvePublicKey)
    assert cert.public_key().curve.name == "secp256r1"
    names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "Test-Mac.local" in names.get_values_for_type(x509.DNSName)
    assert [str(ip) for ip in names.get_values_for_type(x509.IPAddress)] == [
        "192.168.1.20",
        "127.0.0.1",
    ]
    usage = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    assert ExtendedKeyUsageOID.SERVER_AUTH in usage
    days = (cert.not_valid_after_utc - cert.not_valid_before_utc).days
    assert days <= 825  # Apple's platforms refuse longer-lived TLS certificates
    assert made.not_after > datetime.now(UTC)

    again = companion_tls.load_or_create(tmp_path)
    assert again.fingerprint == made.fingerprint  # kept until the owner asks for a new one


def test_a_damaged_certificate_is_kept_aside_and_replaced(tmp_path):
    first = companion_tls.load_or_create(tmp_path)
    path = tmp_path / companion_tls.FILE_NAME
    path.write_bytes(path.read_bytes()[:100])  # cut short
    second = companion_tls.load_or_create(tmp_path)
    assert second.fingerprint != first.fingerprint
    assert list(tmp_path.glob(f"{companion_tls.FILE_NAME}.bad-*"))


def test_a_key_that_is_not_the_certificates_is_not_used(tmp_path):
    first = companion_tls.load_or_create(tmp_path / "a")
    other = companion_tls.load_or_create(tmp_path / "b")
    raw_a = (tmp_path / "a" / companion_tls.FILE_NAME).read_bytes()
    raw_b = (tmp_path / "b" / companion_tls.FILE_NAME).read_bytes()
    key_a = raw_a[: raw_a.index(b"-----BEGIN CERTIFICATE")]
    cert_b = raw_b[raw_b.index(b"-----BEGIN CERTIFICATE") :]
    (tmp_path / "a" / companion_tls.FILE_NAME).write_bytes(key_a + cert_b)
    fresh = companion_tls.load_or_create(tmp_path / "a")
    assert fresh.fingerprint not in (first.fingerprint, other.fingerprint)


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads anything")
def test_a_certificate_that_cant_be_read_is_left_alone(tmp_path):
    companion_tls.load_or_create(tmp_path)
    path = tmp_path / companion_tls.FILE_NAME
    before = path.read_bytes()
    path.chmod(0)
    try:
        with pytest.raises(OSError):
            companion_tls.load_or_create(tmp_path)
    finally:
        path.chmod(0o600)
    assert path.read_bytes() == before  # never saved over


def test_fingerprints_compare_however_they_are_written():
    fp = "ab" * 32
    assert companion_tls.matches("AB" * 32, fp)
    assert companion_tls.matches(":".join(["ab"] * 32), fp)
    assert companion_tls.matches(" ".join(["abab"] * 16), fp)
    assert not companion_tls.matches("ab" * 31, fp)  # too short: never a match
    assert not companion_tls.matches("", fp)
    assert not companion_tls.matches("cd" * 32, fp)
    assert companion_tls.short_fingerprint("A1B2C3D4E5F60718" + "0" * 48) == "a1b2 c3d4 e5f6 0718"


# ── serving it ──


async def test_the_server_presents_the_pinned_certificate(tmp_path):
    server = server_for(tmp_path)
    assert await server.start()
    try:
        fingerprint = server.identity.fingerprint
        assert status(await exchange(server.port, fingerprint, get("/api/state"))) == 401
        with pytest.raises(WrongCertificate):
            await open_pinned(server.port, "0" * 64)
        # The certificate as the only thing trusted works too (no CA, no host name).
        pem = (tmp_path / companion_tls.FILE_NAME).read_text()
        cert_pem = pem[pem.index("-----BEGIN CERTIFICATE") :]
        context = ssl.create_default_context(cadata=cert_pem)
        context.check_hostname = False
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", server.port, ssl=context, server_hostname="localhost"
        )
        assert writer.get_extra_info("ssl_object").selected_alpn_protocol() in (None, "http/1.1")
        writer.close()
        info = server.public()["tls"]
        assert info["fingerprint"] == fingerprint and info["short"] == server.identity.short
    finally:
        await server.stop()


async def test_the_certificate_survives_a_restart(tmp_path):
    server = server_for(tmp_path)
    assert await server.start()
    first = server.identity.fingerprint
    await server.stop()
    assert await server.start()
    try:
        assert server.identity.fingerprint == first
        assert status(await exchange(server.port, first, get("/api/state"))) == 401
    finally:
        await server.stop()


async def _plain(port: int, raw: bytes) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(raw)
    await writer.drain()
    try:
        return await asyncio.wait_for(reader.read(), 3)
    finally:
        writer.close()


async def test_plain_http_is_refused_unless_the_owner_allows_it(tmp_path):
    hub = FakeHub(plain=False)
    server = server_for(tmp_path, hub)
    assert await server.start()
    try:
        refused = await _plain(server.port, get("/api/state", "some-token"))
        assert status(refused) == 426 and "secure connection" in payload(refused)["error"]
        asked = await _plain(server.port, post("/api/ask", b'{"text": "hi"}' * 500))
        assert status(asked) == 426  # the body it never read doesn't lose the answer
        page = await _plain(server.port, get("/?from=home"))
        assert status(page) == 308 and b"Location: https://mac/?from=home\r\n" in page
        assert server.public()["plain_http"] is False
        hub.prefs.values[remote.PLAIN_PREF] = True  # Settings: for the old app, with a warning
        assert status(await _plain(server.port, get("/api/state"))) == 401
        assert server.public()["plain_http"] is True
        # TLS still works beside it.
        reply = await exchange(server.port, server.identity.fingerprint, get("/api/state"))
        assert status(reply) == 401
    finally:
        await server.stop()


async def test_connections_that_say_nothing_are_capped_and_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(remote, "OPENING_PER_ADDRESS", 2)
    monkeypatch.setattr(remote, "REQUEST_SECONDS", 0.4)
    server = server_for(tmp_path)
    assert await server.start()
    try:
        held = [await asyncio.open_connection("127.0.0.1", server.port) for _ in range(2)]
        await asyncio.sleep(0.05)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
        assert await asyncio.wait_for(reader.read(), 1) == b""  # over the cap: closed at once
        writer.close()
        for r, w in held:  # silent past the deadline: closed too
            assert await asyncio.wait_for(r.read(), 2) == b""
            w.close()
        # And the owner's phone still gets in.
        reply = await exchange(server.port, server.identity.fingerprint, get("/api/state"))
        assert status(reply) == 401
    finally:
        await server.stop()


async def test_a_handshake_that_never_finishes_is_dropped(tmp_path, monkeypatch):
    monkeypatch.setattr(remote, "HANDSHAKE_SECONDS", 0.3)
    server = server_for(tmp_path)
    assert await server.start()
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", server.port)
        writer.write(b"\x16\x03\x01")  # the start of a ClientHello, and nothing more
        await writer.drain()
        assert await asyncio.wait_for(reader.read(), 3) == b""
        writer.close()
    finally:
        await server.stop()


# ── pairing ──


async def test_pairing_checks_the_certificate_the_phone_pinned(tmp_path, monkeypatch):
    monkeypatch.setattr(remote, "computer_name", lambda: "Bilel’s MacBook Pro")
    server = server_for(tmp_path)
    assert await server.start()
    fingerprint = server.identity.fingerprint
    try:
        code = server.devices.start_pairing()
        wrong = json.dumps({"code": code, "device_name": "iPhone", "fingerprint": "0" * 64})
        reply = await exchange(server.port, fingerprint, post("/api/pair", wrong.encode()))
        assert status(reply) == 409 and payload(reply) == {"error": "fingerprint"}
        assert server.devices.items == []  # and the code is still good
        right = json.dumps({"code": code, "device_name": "iPhone", "fingerprint": fingerprint})
        reply = await exchange(server.port, fingerprint, post("/api/pair", right.encode()))
        assert status(reply) == 200
        body = payload(reply)
        assert body["fingerprint"] == fingerprint and body["mac_name"] == "Bilel’s MacBook Pro"
        assert server.devices.check(body["token"]).name == "iPhone"
        reply = await exchange(
            server.port, fingerprint, get("/api/state", body["token"])
        )  # and the token works
        assert status(reply) == 200 and payload(reply)["tls"] is True
    finally:
        await server.stop()


async def test_the_web_page_pairs_without_a_fingerprint(tmp_path):
    server = server_for(tmp_path)
    assert await server.start()
    try:
        code = server.devices.start_pairing()
        legacy = json.dumps({"code": code, "name": "Safari"}).encode()
        reply = await exchange(server.port, server.identity.fingerprint, post("/api/pair", legacy))
        assert status(reply) == 200 and server.devices.items[0].name == "Safari"
    finally:
        await server.stop()


async def test_a_new_certificate_unpairs_every_phone(tmp_path):
    server = server_for(tmp_path)
    assert await server.start()
    old = server.identity.fingerprint
    server.devices.pair(server.devices.start_pairing(), "iPhone")
    try:
        await server.new_identity()
        assert server.running and server.identity.fingerprint != old
        assert server.devices.items == []
        reply = await exchange(server.port, server.identity.fingerprint, get("/api/state"))
        assert status(reply) == 401
    finally:
        await server.stop()


async def test_no_certificate_means_the_companion_stays_off(tmp_path, monkeypatch):
    def broken(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(companion_tls, "load_or_create", broken)
    hub = FakeHub()
    server = server_for(tmp_path, hub)
    assert await server.start() is False
    assert not server.running and "secure connection" in server.error
    assert any(kind == "error" for kind, _ in hub.emitted)


# ── limits ──


def test_each_device_has_a_budget_of_calls(tmp_path):
    from starlette.testclient import TestClient

    devices = Devices(tmp_path / "devices.json")
    token = devices.pair(devices.start_pairing(), "iPhone")
    other = devices.pair(devices.start_pairing(), "iPad")
    clock = [100.0]
    gate = remote.Gate(devices, remote.Limiter({"read": (60, 3), "act": (60, 3)}, lambda: clock[0]))
    client = TestClient(remote.create_remote_app(FakeHub(), devices, gate=gate))
    auth = {"Authorization": f"Bearer {token}"}
    assert [client.get("/api/state", headers=auth).status_code for _ in range(4)] == [
        200,
        200,
        200,
        429,
    ]
    refused = client.get("/api/state", headers=auth)
    assert refused.headers["retry-after"] == "1" and "Too many" in refused.json()["error"]
    # Another phone's budget is its own.
    assert client.get("/api/state", headers={"Authorization": f"Bearer {other}"}).status_code == 200
    clock[0] += 1.0  # a second later: one more call
    assert client.get("/api/state", headers=auth).status_code == 200
    assert client.get("/api/state", headers=auth).status_code == 429
