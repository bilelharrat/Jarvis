"""The HUD's Defense panel: shields and link as macOS reports them."""

import asyncio
from types import SimpleNamespace

from jarvis.defense import NetMeter, latency_ms, read_link, read_shields

REPORTS = {
    "socketfilterfw": "Firewall is disabled. (State = 0)",
    "fdesetup": "FileVault is On.",
    "spctl": "assessments enabled",
    "csrutil": "System Integrity Protection status: enabled.",
    "tmutil": "tmutil: No destinations configured.",
}


def fake_run(replies):
    def run(*args):
        for key, out in replies.items():
            if key in args[0] or key in args:
                return out
        return ""

    return run


def test_shields_as_macos_reports_them():
    shields = {s["name"]: s for s in read_shields(fake_run(REPORTS))}
    assert shields["Firewall"]["on"] is False and shields["FileVault"]["on"] is True
    assert shields["Gatekeeper"]["on"] and shields["SIP"]["on"] and shields["Backup"]["on"] is False
    unknown = read_shields(lambda *a: "")
    assert all(s["on"] is None and s["detail"] == "Unknown" for s in unknown)


def test_the_link_carrying_traffic():
    replies = {
        "route": "   route to: default\n  interface: en0\n",
        "networksetup": "Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0",
        "ipconfig": "192.168.1.20",
    }
    link = read_link(fake_run(replies))
    assert link == {"kind": "Wi-Fi", "device": "en0", "address": "192.168.1.20", "name": ""}
    assert read_link(lambda *a: "")["kind"] == "Offline"


def test_net_meter_rates():
    counts = iter(
        [
            SimpleNamespace(bytes_recv=1000, bytes_sent=100),
            SimpleNamespace(bytes_recv=3000, bytes_sent=600),
        ]
    )
    meter = NetMeter(counters=lambda: next(counts))
    assert meter.read() == {"down": 0.0, "up": 0.0}
    second = meter.read()
    assert second["down"] > 0 and second["up"] > 0


async def test_latency_to_a_local_listener():
    server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        assert (await latency_ms(("127.0.0.1", port))) is not None
    finally:
        server.close()
    assert await latency_ms(("127.0.0.1", 1), timeout=0.5) is None  # nothing listens on port 1
