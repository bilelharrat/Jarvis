"""The Mac's defenses to ask about and hear about (defense.py's new parts and the mac_defense
feature), with fdesetup, softwareupdate, lsof and friends faked: nothing is run."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest
from conftest import FakeClient

from jarvis import defense
from jarvis.features import mac_defense as feature
from jarvis.hub import Hub

UPDATES = """Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Tahoe 27.1-27B42
\tTitle: macOS Tahoe 27.1, Version: 27.1, Size: 3196738KiB, Recommended: YES, Action: restart,
* Label: Command Line Tools for Xcode-27.1
\tTitle: Command Line Tools for Xcode, Version: 27.1, Size: 717613KiB, Recommended: YES,
"""
LSOF = """COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    612  robert    4u  IPv4 0x1234567890abcdef      0t0  TCP *:49152 (LISTEN)
rapportd    612  robert    5u  IPv6 0x1234567890abcdee      0t0  TCP *:49152 (LISTEN)
Python    12345  robert    8u  IPv4 0x1234567890abcded      0t0  TCP 127.0.0.1:8765 (LISTEN)
Control\\x20C  700  robert    9u  IPv6 0x1234567890abcdec      0t0  TCP [::1]:7000 (LISTEN)
"""


def test_updates_are_read_from_softwareupdate():
    found = defense.parse_updates(UPDATES)
    assert found[0] == {
        "label": "macOS Tahoe 27.1-27B42",
        "title": "macOS Tahoe 27.1",
        "version": "27.1",
        "size": "3196738KiB",
        "recommended": True,
        "restart": True,
    }
    assert found[1]["title"] == "Command Line Tools for Xcode" and "restart" not in found[1]
    assert defense.read_updates(lambda *a: "No new software available.") == {"updates": []}
    assert "error" in defense.read_updates(lambda *a: "")


def test_listening_ports_one_per_program_and_port():
    rows = defense.parse_listening(LSOF)
    assert [(r["command"], r["port"], r["exposed"]) for r in rows] == [
        ("rapportd", 49152, True),
        ("Control C", 7000, False),
        ("Python", 8765, False),
    ]
    assert rows[0]["addresses"] == ["*"]


def test_a_shield_turning_off_is_noticed_once_known():
    shields = [
        {"name": "Firewall", "on": False, "detail": "Off"},
        {"name": "FileVault", "on": True, "detail": ""},
        {"name": "SIP", "on": None, "detail": "Unknown"},
        {"name": "Backup", "on": False, "detail": ""},
    ]
    now = defense.shield_states(shields)
    assert now == {"Firewall": False, "FileVault": True}  # unknown and Time Machine aside
    assert defense.turned_off({"Firewall": True, "FileVault": True}, now) == ["Firewall"]
    assert defense.turned_off({}, now) == []  # nothing known before: nothing turned off


def test_a_shield_is_off_only_when_macos_says_off():
    """Anything but macOS's own words for on or off (an error, a daemon that didn't answer,
    wording a macOS update changed) is unknown: never a false "FileVault just turned off"."""
    said = {
        "socketfilterfw": "Firewall is enabled. (State = 1)",
        "fdesetup": "FileVault is On.",
        "spctl": "assessments enabled",
        "csrutil": "System Integrity Protection status: enabled.",
        "tmutil": "Name: Backups\nKind: Local",
    }

    def run(*args):
        return said[args[0].rsplit("/", 1)[-1]]

    assert [s["on"] for s in defense.read_shields(run)] == [True] * 5
    said.update(
        socketfilterfw="Firewall is disabled. (State = 0)",
        fdesetup="FileVault is Off.",
        spctl="assessments disabled",
        csrutil="System Integrity Protection status: disabled.",
        tmutil="No destinations configured.",
    )
    assert [s["on"] for s in defense.read_shields(run)] == [False] * 5
    said.update(
        socketfilterfw="socketfilterfw: an error occurred",
        fdesetup="Error: Unable to get FileVault status (-69594)",
        spctl="spctl: XPC error: connection interrupted",
        csrutil="csrutil: failed to read the status",
        tmutil="tmutil: destinationinfo requires Full Disk Access privileges.",
    )
    shields = defense.read_shields(run)
    assert [s["on"] for s in shields] == [None] * 5
    assert {s["detail"] for s in shields} == {"Unknown"}
    assert (
        defense.turned_off({"FileVault": True, "Gatekeeper": True}, defense.shield_states(shields))
        == []
    )


# ── the feature ──


def shield_list(**on):
    return [
        {"name": n, "on": on.get(n, True), "detail": "x"}
        for n in ("Firewall", "FileVault", "Gatekeeper", "SIP", "Backup")
    ]


@pytest.fixture
def desk(settings, quiet_speaker, isolated, monkeypatch):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    desk = hub.defense_watch
    desk.now_shields = shield_list()
    desk.shields = lambda: desk.now_shields
    desk.link = lambda: {"kind": "Wi-Fi", "name": "Home"}
    desk.listening = lambda: defense.parse_listening(LSOF)
    desk.update_runs = 0

    def updates():
        desk.update_runs += 1
        return {"updates": defense.parse_updates(UPDATES)}

    desk.updates = updates
    desk.clock = lambda: datetime(2026, 9, 30, 9, 0)
    hub.prefs.proactive = True
    desk.heard = []
    hub.add_notify_sink(desk.heard.append)
    desk.tools = {t.name: t.handler for t in feature.build_server(desk)}
    return desk


async def test_a_heads_up_when_filevault_turns_off(desk):
    assert await desk.check_shields() == []  # first look: what's on is remembered
    desk.now_shields = shield_list(FileVault=False)
    assert await desk.check_shields() == ["FileVault"]
    assert [(a.key, a.kind, a.title) for a in desk.heard] == [
        ("shield:FileVault:2026-09-30", "security", "FileVault is off")
    ]
    assert await desk.check_shields() == []  # said once
    saved = json.loads(desk.path.read_text())
    assert saved["shields"]["FileVault"] is False


async def test_one_turned_off_while_jarvis_was_closed_is_said_at_the_next_start(
    desk, settings, quiet_speaker, isolated
):
    await desk.check_shields()  # remembered: all on
    later = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    heard = []
    later.add_notify_sink(heard.append)
    later.prefs.proactive = True
    later.defense_watch.shields = lambda: shield_list(Gatekeeper=False)
    assert await later.defense_watch.check_shields() == ["Gatekeeper"]
    assert heard and heard[0].text.startswith("Gatekeeper just turned off")


async def test_the_setting_and_chinese(desk):
    await desk.check_shields()
    desk.hub.set_feature_prefs({feature.ALERTS_PREF: False})
    desk.now_shields = shield_list(Firewall=False)
    await desk.check_shields()
    assert desk.heard == []  # off in Settings: noticed, not said
    desk.hub.set_feature_prefs({feature.ALERTS_PREF: True})
    desk.hub.prefs.language = "zh"
    desk.now_shields = shield_list(Firewall=True)
    await desk.check_shields()
    desk.now_shields = shield_list(Firewall=False)
    await desk.check_shields()
    assert desk.heard[0].title == "防火墙已关闭"


async def test_updates_are_checked_once_a_day_and_go_in_the_briefing(desk):
    await desk.check_updates()
    await desk.check_updates()
    assert desk.update_runs == 1
    assert desk.briefing() == (
        "macOS updates waiting: macOS Tahoe 27.1 (restarts the Mac), Command Line Tools for Xcode."
    )
    desk.clock = lambda: datetime(2026, 9, 30, 9, 0) + timedelta(hours=25)
    await desk.check_updates()
    assert desk.update_runs == 2
    assert desk.briefing() in desk.hub._briefing_extra()


async def test_checks_at_the_same_time_ask_softwareupdate_once(desk):
    import asyncio
    import time

    def slow():
        desk.update_runs += 1
        time.sleep(0.2)  # softwareupdate takes its time
        return {"updates": []}

    desk.updates = slow
    await asyncio.gather(desk.check_updates(), desk.check_updates(force=True), desk.check_updates())
    assert desk.update_runs == 1


async def test_security_status_says_it_all(desk):
    text = (await desk.tools["security_status"]({"refresh_updates": True}))["content"][0]["text"]
    lines = text.splitlines()
    assert lines[:3] == ["Defenses:", "- Firewall: on (x)", "- FileVault: on (x)"]
    assert "Network: Wi-Fi “Home”" in lines
    assert "- macOS Tahoe 27.1, version 27.1, restarts the Mac, recommended" in lines
    assert (
        "Listening for connections (this user's programs): 1 reachable from the network, "
        "2 only from this Mac." in lines
    )
    assert "- rapportd (pid 612) on port 49152: network" in lines
    assert desk.update_runs == 1


async def test_a_failed_update_check_is_said_not_raised(desk):
    desk.updates = lambda: {"error": "softwareupdate didn't answer"}
    text = (await desk.tools["security_status"]({}))["content"][0]["text"]
    assert "couldn't check (softwareupdate didn't answer)" in text


@pytest.mark.parametrize(
    "blob",
    [b"null", b"[1, 2]", b'{"shields": 5, "updates": {"a": 1}, "updates_at": 3}', b"\xff\xfe{",
     b"[" * 100_000 + b"]" * 100_000, b""],
    ids=["null", "a-list", "wrong-shapes", "not-utf-8", "nested-past-reason", "empty"],
)  # fmt: skip
async def test_no_state_file_can_stop_it(settings, quiet_speaker, isolated, blob):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.feature_path("defense_watch.json").write_bytes(blob)
    desk = hub.defense_watch
    desk.shields = lambda: shield_list()
    assert desk.state["shields"] == {} and desk.briefing() == ""
    assert await desk.check_shields() == []


def test_a_damaged_state_file_starts_fresh(settings, quiet_speaker, isolated, tmp_path):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    path = hub.feature_path("defense_watch.json")
    path.write_text(
        json.dumps(
            {"shields": {"FileVault": "yes", "Firewall": True, "Nope": True}, "updates": ["x"]}
        )
    )
    fresh = feature.Defense(hub)
    assert fresh.state["shields"] == {"Firewall": True} and fresh.state["updates"] == []
