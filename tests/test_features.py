"""Feature modules (jarvis.features): what they register on the hub reaches the brain, the
window's commands, heads-ups and approvals; their settings, Chinese strings and window files
load beside the core ones; and a broken one never takes the rest down."""

import asyncio
import json
import types

from conftest import FakeClient

from jarvis import brain, features, prefs
from jarvis.hub import Hub, tool_label
from jarvis.proactive import Alert
from jarvis.server import feature_assets, zh_strings


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def test_install_all_skips_a_feature_that_fails(monkeypatch):
    seen = []
    good = types.SimpleNamespace(__name__="jarvis.features.good", install=seen.append)

    def explode(_hub):
        raise RuntimeError("broken feature")

    bad = types.SimpleNamespace(__name__="jarvis.features.bad", install=explode)
    plain = types.SimpleNamespace(__name__="jarvis.features.plain")  # no install(): skipped
    monkeypatch.setattr(features, "modules", lambda: [bad, plain, good])
    hub = object()
    assert features.install_all(hub) == ["good"]
    assert seen == [hub]


def test_prepare_runs_before_the_hub_and_a_broken_one_never_stops_the_start(monkeypatch, tmp_path):
    seen = []

    def explode(_folder):
        raise RuntimeError("broken")

    good = types.SimpleNamespace(__name__="jarvis.features.good", prepare=seen.append)
    bad = types.SimpleNamespace(__name__="jarvis.features.bad", prepare=explode)
    monkeypatch.setattr(features, "modules", lambda: [bad, good])
    assert features.prepare_all(tmp_path) == ["good"]
    assert seen == [tmp_path]


def test_a_registered_server_reaches_the_brain(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    built = object()
    hub.register_server(
        "weatherx",
        lambda: built,
        prompt="\n- Weather X: the forecast anywhere.",
        labels={"forecast_anywhere": "Looking up a forecast"},
        quiet=("forecast_anywhere",),
        web=("read_forecast_page",),
    )
    assert hub._feature_servers()["weatherx"] is built
    assert "Weather X: the forecast anywhere." in hub._feature_prompt()
    assert tool_label("mcp__weatherx__forecast_anywhere") == "Looking up a forecast"
    assert brain.result_kind("mcp__weatherx__forecast_anywhere") == "none"
    assert brain.result_kind("mcp__weatherx__read_forecast_page") == "web"
    assert brain.result_kind("mcp__weatherx__something_else") == "private"


def test_a_server_that_fails_to_build_is_left_out(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)

    def broken():
        raise RuntimeError("no")

    hub.register_server("broken_feature", broken)
    servers = hub._feature_servers()
    assert "broken_feature" not in servers
    assert "memory" in servers or len(servers) > 5  # the core ones are all still there


async def test_commands_reach_their_feature(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    got = []

    async def later(msg):
        await asyncio.sleep(0)
        got.append(("async", msg["n"]))

    hub.register_command("feature_ping", lambda msg: got.append(("sync", msg["n"])))
    hub.register_command("feature_later", later)
    await hub._handle({"type": "feature_ping", "n": 1})
    await hub._handle({"type": "feature_later", "n": 2})
    await hub._handle({"type": "set_prefs", "changes": {}})  # the built-in ones still work
    assert got == [("sync", 1), ("async", 2)]


async def test_sinks_hear_heads_ups_and_approvals(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    alerts, cards, done = [], [], []

    def failing(_alert):
        raise RuntimeError("a broken sink")

    hub.add_notify_sink(failing)  # never stops the others, or the heads-up
    hub.add_notify_sink(alerts.append)
    hub.add_approval_sink(cards.append, resolved=done.append)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
    assert [a.key for a in alerts] == ["rain:1"]

    asked = asyncio.create_task(hub.request_approval("Send it?", "to Ann"))
    await asyncio.sleep(0)
    assert cards and cards[0]["question"] == "Send it?"
    assert {c["id"] for c in cards[0]["choices"]} == {"allow", "deny"}
    assert hub.resolve(cards[0]["id"], "allow")
    assert await asked == "allow"
    assert done == [cards[0]["id"]]


async def test_a_feature_loop_that_fails_is_logged_not_raised(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)

    async def dies():
        raise RuntimeError("loop broke")

    await hub._feature_loop("dies", dies)  # returns; the hub carries on


def test_feature_path_is_beside_prefs(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert hub.feature_path("channels.json") == tmp_path / "channels.json"


def test_feature_prefs_are_cleaned_merged_and_kept(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setattr(prefs, "FEATURE_PREFS", dict(prefs.FEATURE_PREFS))
    prefs.register_feature_pref("demo_on", False)
    prefs.register_feature_pref("demo_minutes", 15, lambda v: max(1, min(120, int(v))))
    prefs.register_feature_pref("demo_ratio", 0.5)
    hub = make_hub(settings, quiet_speaker, isolated)
    assert hub.prefs.feature("demo_on") is False
    assert hub.prefs.feature("demo_minutes") == 15
    assert hub.prefs.feature("unknown_key") is None

    hub.set_feature_prefs({"demo_on": True, "demo_minutes": "500", "demo_ratio": 1})
    assert hub.prefs.feature("demo_on") is True
    assert hub.prefs.feature("demo_minutes") == 120
    assert hub.prefs.feature("demo_ratio") == 1.0
    # A value its feature won't take leaves the old one; the others are untouched.
    hub.set_feature_prefs({"demo_on": "yes", "demo_minutes": "lots"})
    assert hub.prefs.feature("demo_on") is True
    assert hub.prefs.feature("demo_minutes") == 120
    assert hub.prefs.public()["features"]["demo_ratio"] == 1.0

    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["features"]["demo_minutes"] == 120
    reread = prefs.PrefsStore(isolated["prefs_store"].path).prefs
    assert reread.feature("demo_on") is True


def test_feature_values_refuse_odd_shapes(monkeypatch):
    monkeypatch.setattr(prefs, "FEATURE_PREFS", {})
    assert prefs.clean_feature_values("nope") is None
    kept = prefs.clean_feature_values(
        {"": 1, "k" * 65: 1, 7: 1, "big": "x" * 70_000, "nan": float("nan"), "ok": [1, "a"]}
    )
    assert kept == {"ok": [1, "a"]}


def test_zh_strings_merge_the_feature_fragments(tmp_path):
    (tmp_path / "i18n").mkdir()
    (tmp_path / "i18n-zh.json").write_text(
        json.dumps({"strings": {"Close": "关闭", "Open": "打开"}, "patterns": [["^a$", "甲"]]})
    )
    (tmp_path / "i18n" / "b.json").write_text(
        json.dumps({"strings": {"Open": "开启", "Push": "推送"}, "patterns": [["^b$", "乙"]]})
    )
    (tmp_path / "i18n" / "a.json").write_text("{not json")  # skipped, not fatal
    (tmp_path / "i18n" / "c.json").write_text(json.dumps({"strings": {"n": 5}, "patterns": [1]}))
    merged = zh_strings(tmp_path)
    assert merged["strings"] == {"Close": "关闭", "Open": "开启", "Push": "推送"}
    assert merged["patterns"] == [["^a$", "甲"], ["^b$", "乙"]]


def test_the_real_zh_strings_still_load():
    merged = zh_strings()
    assert len(merged["strings"]) > 500 and merged["patterns"]


def test_feature_assets_list_scripts_and_styles_in_order(tmp_path):
    assert feature_assets(tmp_path) == {"scripts": [], "styles": []}  # no folder: none
    folder = tmp_path / "features"
    folder.mkdir()
    for name in ("b.js", "a.js", "a.css", "notes.txt"):
        (folder / name).write_text("")
    found = feature_assets(tmp_path)
    assert [s.split("?")[0] for s in found["scripts"]] == [
        "/static/features/a.js",
        "/static/features/b.js",
    ]
    assert [s.split("?")[0] for s in found["styles"]] == ["/static/features/a.css"]
    assert all("?v=" in s for s in found["scripts"] + found["styles"])
