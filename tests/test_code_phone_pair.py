"""Pairing the Eden Code phone apps by QR code (features/code_phone_pair.py): the payload's
fixed format and escaping, that nothing but the short-lived code rides in it, and the window
command that shows it, reusing the companion's own pairing code (remote.Devices)."""

from __future__ import annotations

import time
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlsplit

import pytest
from test_companion_push import settle, setup  # noqa: F401 (the fixture)

from jarvis import remote
from jarvis.features import code_phone, code_phone_pair
from jarvis.features.code_phone_pair import pair_payload

FP = "ab" * 32


def parse(payload: str) -> tuple[str, str, list[tuple[str, str]]]:
    parts = urlsplit(payload)
    return parts.scheme, parts.netloc, parse_qsl(parts.query, keep_blank_values=True)


def test_the_payload_has_the_fixed_format_in_order():
    payload = pair_payload(
        code="042917",
        host="Studio.local",
        ip="192.168.1.20",
        port=8765,
        fingerprint=FP.upper(),
        name="Bilel's Mac Studio",
        ts="studio.tail1234.ts.net",
        relay=True,
    )
    assert payload == (
        "edencode://pair?v=1&code=042917&host=Studio.local&ip=192.168.1.20&port=8765"
        f"&fp={FP}&name=Bilel%27s%20Mac%20Studio&ts=studio.tail1234.ts.net&relay=1"
    )
    scheme, kind, items = parse(payload)
    assert (scheme, kind) == ("edencode", "pair")
    assert [k for k, _ in items] == ["v", "code", "host", "ip", "port", "fp", "name", "ts", "relay"]


def test_optional_parts_are_left_out_not_sent_empty():
    payload = pair_payload(code="000001", host="studio.local", port=8765, fingerprint=FP)
    assert payload == f"edencode://pair?v=1&code=000001&host=studio.local&port=8765&fp={FP}"
    # An address that isn't IPv4, or a Tailscale name that isn't a host name: left out.
    odd = pair_payload(
        code="000001", host="studio.local", port=8765, fingerprint=FP, ip="fe80::1", ts="a b"
    )
    assert "ip=" not in odd and "ts=" not in odd


def test_the_name_is_escaped_so_it_cant_add_a_parameter():
    payload = pair_payload(
        code="123456",
        host="studio.local",
        port=8765,
        fingerprint=FP,
        name="Mac&code=999999 #1 é+",
    )
    _, _, items = parse(payload)
    assert dict(items)["name"] == "Mac&code=999999 #1 é+"
    assert [v for k, v in items if k == "code"] == ["123456"]
    assert "#" not in payload and " " not in payload and "+" not in payload
    long = pair_payload(code="123456", host="h.local", port=1, fingerprint=FP, name="x" * 500)
    assert dict(parse(long)[2])["name"] == "x" * code_phone_pair.NAME_MOST


@pytest.mark.parametrize(
    "bad",
    [
        {"code": "12345"},
        {"code": "1234567"},
        {"code": "12a456"},
        {"code": "１２３４５６"},  # (full-width digits: not in the code's own form)
        {"host": ""},
        {"host": "evil host"},
        {"host": "a/b"},
        {"port": 0},
        {"port": 70000},
        {"port": True},
        {"fingerprint": "abc"},
        {"fingerprint": ""},
    ],
)
def test_anything_the_format_doesnt_allow_is_refused(bad):
    args = {"code": "123456", "host": "studio.local", "port": 8765, "fingerprint": FP, **bad}
    with pytest.raises(ValueError):
        pair_payload(**args)


def companion_up(hub, *, tailscale=""):
    hub.remote._task = SimpleNamespace(done=lambda: False)
    hub.remote.host_name, hub.remote.mac_name, hub.remote.port = "studio", "Studio", 8765
    hub.remote.identity = SimpleNamespace(fingerprint=FP, short="ABAB ABAB")
    hub.code_phone_pair.tailscale = lambda: tailscale


async def test_the_pane_shows_the_companions_own_code_and_it_pairs(setup, monkeypatch):  # noqa: F811
    hub = setup.hub
    companion_up(hub, tailscale="studio.tail1.ts.net")
    monkeypatch.setattr(remote, "lan_address", lambda: "10.0.0.7")
    events, codes = [], []
    hub.add_event_sink(("code_phone_pair",), events.append)
    hub.add_event_sink(("remote_code",), codes.append)
    # Peek with no code up: nothing made.
    await hub.handle({"type": "code_phone_pair", "peek": True})
    await settle(hub)
    assert events[-1]["code"] == "" and events[-1]["running"] and codes == []
    # Opened: a code made, the same one Settings › iPhone & Watch shows.
    await hub.handle({"type": "code_phone_pair"})
    await settle(hub)
    shown = events[-1]
    code = hub.remote.devices.code
    assert shown["code"] == code and codes[-1]["code"] == code
    assert 290 <= shown["seconds"] <= 300 and shown["qr"] and shown["error"] == ""
    assert shown["payload"] == (
        f"edencode://pair?v=1&code={code}&host=studio.local&ip=10.0.0.7&port=8765&fp={FP}"
        "&name=Studio&ts=studio.tail1.ts.net"
    )
    # No secret beyond the code: no device token, no account, nothing else.
    _, _, items = parse(shown["payload"])
    assert {k for k, _ in items} <= {"v", "code", "host", "ip", "port", "fp", "name", "ts", "relay"}
    # Asked again without fresh: the same code (a second window doesn't spend the first's).
    await hub.handle({"type": "code_phone_pair"})
    await settle(hub)
    assert events[-1]["code"] == code
    # Fresh: a new one, and the old one no longer pairs.
    await hub.handle({"type": "code_phone_pair", "fresh": True})
    await settle(hub)
    fresh = events[-1]["code"]
    assert fresh == hub.remote.devices.code
    if fresh != code:
        with pytest.raises(PermissionError):
            hub.remote.devices.pair(code, "old")
    hub.remote.devices.pair(fresh, "Pixel (Eden Code)")  # the app's POST /api/pair, in effect
    await hub.handle({"type": "code_phone_pair", "peek": True})
    await settle(hub)
    assert events[-1]["code"] == "" and events[-1]["paired"] == 1  # (one pairing per code)


async def test_an_expired_code_is_not_shown_and_the_relay_is_said(setup, monkeypatch):  # noqa: F811
    hub = setup.hub
    companion_up(hub)
    monkeypatch.setattr(remote, "lan_address", lambda: "")
    hub.account_desk = SimpleNamespace(relay_wanted=lambda: True)
    hub.prefs.features[code_phone.PREF] = True
    events = []
    hub.add_event_sink(("code_phone_pair",), events.append)
    hub.remote.devices.start_pairing()
    hub.remote.devices.code_expires = time.monotonic() - 1
    await hub.handle({"type": "code_phone_pair", "peek": True})
    await settle(hub)
    assert events[-1]["code"] == "" and events[-1]["on"] is True
    await hub.handle({"type": "code_phone_pair"})
    await settle(hub)
    payload = events[-1]["payload"]
    assert (
        payload.endswith("&name=Studio&relay=1") and "ip=" not in payload and "ts=" not in payload
    )


async def test_with_the_companion_off_it_says_where_to_turn_it_on(setup):  # noqa: F811
    hub = setup.hub
    events = []
    hub.add_event_sink(("code_phone_pair",), events.append)
    await hub.handle({"type": "code_phone_pair", "fresh": True})
    await settle(hub)
    assert events[-1]["running"] is False and "iPhone & Watch" in events[-1]["error"]
    assert hub.remote.devices.code is None and events[-1]["payload"] == ""


def test_tailscale_is_read_from_its_own_status(monkeypatch):
    monkeypatch.setattr(code_phone_pair.shutil, "which", lambda _n: "/usr/local/bin/tailscale")
    status = {"Self": {"DNSName": "studio.tail1.ts.net.", "TailscaleIPs": ["100.64.0.2"]}}

    def run(args, **_kw):
        assert args[1:] == ["status", "--json", "--peers=false"]
        import json

        return SimpleNamespace(stdout=json.dumps(status))

    monkeypatch.setattr(code_phone_pair.subprocess, "run", run)
    assert code_phone_pair._tailscale_lookup() == "studio.tail1.ts.net"
    status["Self"] = {"DNSName": "", "TailscaleIPs": ["fd7a::1", "100.64.0.2"]}
    assert code_phone_pair._tailscale_lookup() == "100.64.0.2"
    status["Self"] = {"Online": False, "DNSName": "x.ts.net"}
    assert code_phone_pair._tailscale_lookup() == ""
    monkeypatch.setattr(code_phone_pair.shutil, "which", lambda _n: None)
    monkeypatch.setattr(code_phone_pair.os.path, "exists", lambda _p: False)
    assert code_phone_pair._tailscale_lookup() == ""
