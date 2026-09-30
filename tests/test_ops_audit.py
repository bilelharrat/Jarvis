"""The security review (jarvis.features.ops.audit): what JARVIS may do on its own, found
on a real hub, and tightens that only ever narrow it."""

import os
import stat
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import FakeClient

from jarvis import prefs
from jarvis.connectors import Connection
from jarvis.features.ops import audit
from jarvis.hub import Hub

NOW = datetime(2026, 9, 29, 20, 15, 12)


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def found(hub, folder, fid):
    return next(f for f in audit.review(hub, folder, NOW)["findings"] if f["id"] == fid)


def pair(hub, name, last_seen):
    devices = hub.remote.devices
    devices.start_pairing()
    devices.pair(devices.code, name)
    devices.items[-1].last_seen = last_seen
    return devices.items[-1].id


async def test_the_companion_off_on_plain_http_and_phones_not_seen_for_a_month(hub, tmp_path):
    assert found(hub, tmp_path, "companion")["summary"] == "Off"
    fresh = pair(hub, "Ann's iPhone", "2026-09-29T08:00")
    stale = pair(hub, "Old iPad", "2026-06-01T08:00")
    got = found(hub, tmp_path, "companion")
    assert got["state"] == "notice" and got["summary"] == "Off, with phones still paired"
    assert [i["label"] for i in got["items"]] == ["Ann's iPhone", "Old iPad"]
    assert [a["id"] for a in got["actions"]] == ["unpair_stale"]

    hub.prefs.remote_enabled = True
    got = found(hub, tmp_path, "companion")
    assert got["state"] == "risk" and got["summary"] == "On, without encryption"
    assert [a["id"] for a in got["actions"]] == ["companion_off", "unpair_stale"]

    assert await audit.tighten(hub, tmp_path, "unpair_stale", now=NOW) == "Unpaired 1 phone(s)."
    assert [d.id for d in hub.remote.devices.items] == [fresh] and stale not in str(
        hub.remote.devices.public()
    )
    with pytest.raises(audit.Refused):
        await audit.tighten(hub, tmp_path, "unpair_stale", now=NOW)


def test_tls_is_read_from_whatever_the_companion_feature_offers(hub):
    assert audit.companion_tls(hub) is False  # today's companion: plain HTTP
    hub.remote.tls = True
    assert audit.companion_tls(hub) is True
    del hub.remote.tls
    hub.remote.public = lambda: {"urls": ["https://mac.local:8765"]}
    assert audit.companion_tls(hub) is True
    assert audit.companion_tls(SimpleNamespace(prefs=hub.prefs)) is None


async def test_connectors_that_run_everything_and_actions_allowed_for_good(hub, tmp_path):
    manager = hub.connectors
    manager.connections["notion"] = Connection(
        id="notion", name="Notion", kind="http", policy="allow"
    )
    manager.connections["linear"] = Connection(
        id="linear", name="Linear", kind="http", always_allow=["create_issue"]
    )
    manager.connections["gh"] = Connection(id="gh", name="GitHub", kind="http")
    got = found(hub, tmp_path, "connectors")
    assert got["state"] == "risk" and got["summary"] == "1 runs everything without asking"
    by_id = {i["id"]: i for i in got["items"]}
    assert set(by_id) == {"notion", "linear"} and by_id["linear"]["note"] == "create issue"

    await audit.tighten(hub, tmp_path, "connector_ask", "notion")
    await audit.tighten(hub, tmp_path, "connector_forget", "linear")
    assert manager.connections["notion"].policy == "ask"
    assert manager.connections["linear"].always_allow == []
    assert found(hub, tmp_path, "connectors")["state"] == "ok"
    with pytest.raises(audit.Refused):
        await audit.tighten(hub, tmp_path, "connector_ask", "nobody")


async def test_jarvis_code_rules_and_bypass(hub, tmp_path):
    rules = hub.tasks.rules
    project = str(tmp_path / "app")
    rules.add(Path(project), "npm test")
    rules.add(Path(project), "git commit")
    task = SimpleNamespace(id=7, mode="auto", status="running", audit=[{"decision": "bypass"}] * 3)
    hub.tasks.tasks[7] = task
    switched = []

    def set_mode(task_id, mode):
        switched.append((task_id, mode))
        hub.tasks.tasks[task_id].mode = mode
        return True

    hub.tasks.set_mode = set_mode
    got = found(hub, tmp_path, "code")
    assert got["state"] == "risk" and got["summary"] == "1 session in Bypass now"
    assert got["note"] == "3 steps ran in Bypass in the sessions open now."
    assert got["items"][0]["note"] == "npm test, git commit"
    await audit.tighten(hub, tmp_path, "code_sessions_manual")
    await audit.tighten(hub, tmp_path, "code_rules", project)
    assert switched == [(7, "ask")] and rules.for_project(Path(project)) == []
    del hub.tasks.tasks[7]
    assert found(hub, tmp_path, "code")["state"] == "ok"


async def test_purchases_screen_and_control(hub, tmp_path):
    hub.prefs.pay_limit_purchase = 100.0  # already lower than the default: stays
    hub.prefs.pay_limit_transfer = 2000.0
    hub.prefs.screen_aware = True
    got = found(hub, tmp_path, "purchases")
    assert got["note"] == "100 USD a purchase, 2000 a transfer, 500 a day"
    await audit.tighten(hub, tmp_path, "pay_defaults")
    assert (hub.prefs.pay_limit_purchase, hub.prefs.pay_limit_transfer) == (100.0, 100.0)
    await audit.tighten(hub, tmp_path, "pay_off")
    await audit.tighten(hub, tmp_path, "screen_off")
    await audit.tighten(hub, tmp_path, "control_ask")
    await audit.tighten(hub, tmp_path, "companion_off")
    p = hub.prefs
    assert (p.pay_enabled, p.screen_aware, p.control_always, p.remote_enabled) == (
        False,
        False,
        False,
        False,
    )
    assert found(hub, tmp_path, "purchases")["summary"] == "Off"


def test_the_data_folder_scan_never_follows_a_link(tmp_path):
    data = tmp_path / "data"
    (data / "bin").mkdir(parents=True)
    os.chmod(data, 0o700)
    os.chmod(data / "bin", 0o755)
    (data / "bin" / "helper").write_text("#!/bin/sh")
    os.chmod(data / "bin" / "helper", 0o755)
    (data / "prefs.json").write_text("{}")
    os.chmod(data / "prefs.json", 0o600)
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    os.chmod(outside, 0o644)
    (data / "link").symlink_to(outside)
    loose = audit.loose_entries(data)
    assert [name for name, _mode, _dir in loose] == ["bin", "bin/helper"]
    assert audit.make_private(data) == 2
    assert stat.S_IMODE(os.stat(data / "bin" / "helper").st_mode) == 0o700  # still runs
    assert stat.S_IMODE(os.stat(data / "bin").st_mode) == 0o700
    assert stat.S_IMODE(os.stat(outside).st_mode) == 0o644  # never touched through the link
    assert audit.data_folder(data)["state"] == "ok"


async def test_other_features_channels_are_found_and_only_switched_off(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(prefs, "FEATURE_PREFS", dict(prefs.FEATURE_PREFS))
    assert audit.extras(hub) is None  # no such feature installed: not reported
    prefs.register_feature_pref("channels_telegram_enabled", False)
    prefs.register_feature_pref("channels_require_approval", True)
    prefs.register_feature_pref("webhooks_on", False)
    hub.set_feature_prefs({"channels_telegram_enabled": True, "webhooks_on": True})
    got = found(hub, tmp_path, "extras")
    assert got["summary"] == "2 switched on"
    assert [i["id"] for i in got["items"]] == ["channels_telegram_enabled", "webhooks_on"]
    await audit.tighten(hub, tmp_path, "extra_off", "webhooks_on")
    assert hub.prefs.feature("webhooks_on") is False
    # A safety switch is never flipped, nor anything that isn't an on switch.
    for key in ("channels_require_approval", "language", "remote_enabled"):
        with pytest.raises(audit.Refused):
            await audit.tighten(hub, tmp_path, "extra_off", key)
    assert hub.prefs.feature("channels_require_approval") is True


async def test_every_tighten_only_narrows(hub, tmp_path):
    """Whatever state things are in, no tighten ever switches something on or raises a
    limit."""
    hub.prefs.control_always = False
    hub.prefs.pay_enabled = False
    hub.prefs.pay_limit_day = 10.0
    for aid in ("control_ask", "pay_off", "pay_defaults", "screen_off", "companion_off"):
        with __import__("contextlib").suppress(audit.Refused):
            await audit.tighten(hub, tmp_path, aid)
    p = hub.prefs
    assert (p.control_always, p.pay_enabled, p.pay_limit_day, p.screen_aware) == (
        False,
        False,
        10.0,
        False,
    )
    assert p.remote_enabled is False
    with pytest.raises(audit.Refused):
        await audit.tighten(hub, tmp_path, "control_always_on")
