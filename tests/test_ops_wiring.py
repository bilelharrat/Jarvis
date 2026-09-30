"""The ops feature on a real hub (jarvis.features.ops): Setup on a fresh install, the
checkup from the window and by voice, the safe fixes, the security review's tightens,
backups, restores staged for the next start, and the diagnostics file. Every command it
runs is a fake here, and every folder a temp one."""

import asyncio
import json
import os
import stat
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from conftest import FakeClient

from jarvis import brain, prefs
from jarvis.features import ops
from jarvis.features.ops import backup, desk
from jarvis.hub import Hub, tool_label

NOW = datetime(2026, 9, 29, 20, 15, 12)

TCC = {
    "microphone": "granted",
    "calendars": "granted",
    "contacts": "not_asked",
    "location": "granted",
    "screen": "off",
    "accessibility": "granted",
    "full_disk": "granted",
    "automation": {
        "com.apple.mail": "granted",
        "com.apple.iCal": "granted",
        "com.apple.Notes": "not_running",
        "com.apple.Music": "not_running",
    },
}


class FakeRun:
    """Every command the desk would run, answered here and written down."""

    def __init__(self):
        self.calls = []
        self.tcc = dict(TCC)
        self.signed_in = True
        self.lsof = (1, "")

    async def __call__(self, *args, timeout=20.0, env=None):
        self.calls.append(args)
        if args[1:3] == ("-m", "jarvis.features.ops.tcc"):
            return 0, json.dumps(self.tcc), ""
        if args[-1] == "--version":
            return 0, "2.1.284 (Claude Code)\n", ""
        if args[1:3] == ("auth", "status"):
            status = {"loggedIn": self.signed_in, "authMethod": "claude.ai"}
            if self.signed_in:
                status |= {"subscriptionType": "max", "email": "ann@example.com"}
            return (0 if self.signed_in else 1), json.dumps(status), ""
        if args[0] == "xcode-select":
            return 0, "/Applications/Xcode.app/Contents/Developer\n", ""
        if args[0] == "xcrun":
            return 0, "/usr/bin/swiftc\n", ""
        if args[0] == "lsof":
            return self.lsof[0], self.lsof[1], ""
        if args[0] == "open":
            return 0, "", ""
        raise AssertionError(f"unexpected command {args}")


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def desk_(hub, tmp_path):
    ops_desk = ops.desk_for(hub)
    ops_desk.run = FakeRun()
    ops_desk.clock = lambda: NOW
    ops_desk.probe_extra = {
        "processes": lambda: [],
        "children": lambda pid: set(),
        "whisper_cached": lambda name: True,
        "claude_cli": lambda: "/fake/claude",
        "disk_free": lambda path: 80 * 1024**3,
        "login_command": lambda cli: "claude auth login",
    }
    return ops_desk


def drain(queue):
    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


class Watch:
    """A window's events, kept until a test takes them (background work answers later)."""

    def __init__(self, hub):
        self.queue = hub.subscribe()
        self.seen = []

    def empty(self):
        self.seen += drain(self.queue)
        return not self.seen

    def get_nowait(self):
        self.seen += drain(self.queue)
        return self.seen.pop(0)

    async def next(self, kind, timeout=5.0):
        """The first event of this kind (waiting for it); the others stay."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            self.seen += drain(self.queue)
            for i, event in enumerate(self.seen):
                if event["type"] == kind:
                    return self.seen.pop(i)
            if loop.time() > deadline:
                raise AssertionError(f"no {kind} event; saw {[e['type'] for e in self.seen]}")
            await asyncio.sleep(0.01)

    async def until(self, kind, done, timeout=5.0):
        """Events of this kind up to the first for which done(event) is true."""
        out = []
        while True:
            out.append(await self.next(kind, timeout))
            if done(out[-1]):
                return out


def test_the_feature_installs_its_commands_server_and_loop(hub):
    assert "ops" in hub.features
    assert {"ops_state", "ops_doctor", "ops_backup", "ops_restore", "ops_tighten"} <= set(
        hub._commands
    )
    assert "ops" in hub._feature_servers()
    assert "run_checkup" in hub._feature_prompt()
    assert "做个体检" in hub._feature_prompt()  # the Chinese twin
    assert tool_label("mcp__ops__run_checkup") == "Ran a checkup"
    assert brain.result_kind("mcp__ops__run_checkup") == "none"  # JARVIS's own words
    assert any(name == "ops_daily_backup" for name, _f in hub._loops)
    assert hub.prefs.feature("ops_backup_daily") is True
    assert hub.prefs.feature("ops_backup_knowledge") is False
    assert hub.prefs.feature("ops_setup_state") == ""


async def test_setup_shows_by_itself_only_on_a_fresh_install(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    monkeypatch.setitem(desk.STARTUP, "folder", None)
    monkeypatch.setitem(desk.STARTUP, "fresh", False)
    ops.prepare(tmp_path)  # no prefs.json in the folder: a fresh install
    assert desk.STARTUP == {"folder": str(tmp_path), "fresh": True}
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    queue = Watch(hub)
    await hub._handle({"type": "ops_state"})
    state = await queue.next("ops_state")
    assert state["setup"] == {"state": "pending", "show": True}
    # Kept: quitting half way through shows it again next time.
    saved = json.loads((tmp_path / "prefs.json").read_text())
    assert saved["features"]["ops_setup_state"] == "pending"
    await hub._handle({"type": "ops_setup", "state": "skipped"})
    state = await queue.next("ops_state")
    assert state["setup"] == {"state": "skipped", "show": False}


async def test_an_existing_install_never_gets_setup_by_itself(hub, desk_, tmp_path, monkeypatch):
    (tmp_path / "prefs.json").write_text("{}")
    monkeypatch.setitem(desk.STARTUP, "folder", None)
    ops.prepare(tmp_path)
    assert desk.STARTUP["fresh"] is False
    queue = Watch(hub)
    await hub._handle({"type": "ops_state"})
    state = await queue.next("ops_state")
    assert state["setup"] == {"state": "", "show": False}
    assert state["app"] is False and state["restored"] is None


async def test_setups_permission_list_and_claude_sign_in(hub, desk_):
    desk_.run.signed_in = False
    queue = Watch(hub)
    await hub._handle({"type": "ops_permissions"})
    await hub._handle({"type": "ops_permissions"})  # asked again meanwhile: one check
    await hub._handle({"type": "ops_claude"})
    found = await queue.next("ops_permissions")
    claude = await queue.next("ops_claude")
    rows = {r["id"]: r for r in found["rows"]}
    assert [r["id"] for r in found["rows"]] == [
        "microphone",
        "calendars",
        "contacts",
        "location",
        "automation",
        "screen",
        "accessibility",
        "full_disk",
    ]
    assert rows["contacts"]["label"] == "Not asked yet"
    assert rows["screen"]["state"] == "off" and "Screen Recording" in rows["screen"]["hint"]
    assert rows["automation"]["state"] == "granted"  # the apps that could be told are allowed
    assert [a["app"] for a in rows["automation"]["apps"]] == ["Mail", "Calendar", "Notes", "Music"]
    assert claude["state"] == "problem" and claude["command"] == "claude auth login"
    assert "ann@example.com" not in json.dumps(claude)
    assert sum(1 for call in desk_.run.calls if "jarvis.features.ops.tcc" in call) == 1


async def test_open_system_settings_goes_only_to_a_privacy_pane(hub, desk_):
    await hub._handle({"type": "ops_open_settings", "pane": "screen"})
    await hub._handle({"type": "ops_open_settings", "pane": "; rm -rf ~"})
    await asyncio.sleep(0.05)
    assert desk_.run.calls == [
        ("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    ]


async def test_the_voice_test_speaks_unless_muted(hub, desk_, monkeypatch):
    said = []
    monkeypatch.setattr(hub, "say", lambda text, follow_up=True: said.append((text, follow_up)))
    queue = Watch(hub)
    hub.speaker.muted = False
    await hub._handle({"type": "ops_voice_test"})
    assert said == [(desk.VOICE_SAMPLE, False)]
    hub.speaker.muted = True
    await hub._handle({"type": "ops_voice_test"})
    assert said == [(desk.VOICE_SAMPLE, False)]
    assert [(await queue.next("ops_voice"))["muted"] for _ in range(2)] == [False, True]


async def test_the_microphone_test_hears_and_shows_what_it_heard(hub, desk_):
    import numpy as np

    class Stt:
        def transcribe(self, audio):
            return " Testing one two "

    def recorder(silence, on_level):
        on_level(0.05)
        return np.zeros(16000, dtype=np.float32)

    hub.recorder, hub.transcriber = recorder, Stt()
    queue = Watch(hub)
    hub.prefs.hands_free = True
    await hub._handle({"type": "ops_mic_test"})
    assert (await queue.next("ops_mic"))["state"] == "hands_free"
    hub.prefs.hands_free = False
    await hub._handle({"type": "ops_mic_test"})
    seen = await queue.until("ops_mic", lambda e: e["state"] in ("heard", "error"))
    states = [e["state"] for e in seen]
    assert states[0] == "listening" and states[-1] == "heard"
    assert seen[-1]["text"] == "Testing one two"


async def test_the_checkup_from_the_window(hub, desk_, tmp_path):
    (tmp_path / "memory.json.bad-20260901-101010").write_text("{torn")
    logs = desk_.logs
    logs.mkdir(parents=True)
    (logs / "jarvis.log").write_text(
        "2026-09-29 19:30:00,001 ERROR token=abc123secretvalue failed for ann@example.com\n"
        "2026-09-29 18:00:00,001 ERROR too old to count\n"
        "2026-09-29 20:00:00,001 INFO fine\n"
    )
    queue = Watch(hub)
    await hub._handle({"type": "ops_doctor"})
    result = await queue.next("ops_doctor")
    checks = {c["id"]: c for c in result["checks"]}
    assert checks["claude"]["state"] == "ok" and checks["claude"]["meta"] == "Max · 2.1.284"
    assert checks["perm:screen"]["state"] == "problem" and checks["perm:screen"]["pane"] == "screen"
    assert checks["perm:contacts"]["state"] == "warn"
    assert checks["logs"]["summary"] == "1 in the last hour"
    assert checks["logs"]["details"] == [
        "2026-09-29 19:30:00,001 ERROR token=[hidden] failed for [email]"
    ]
    assert checks["damaged"]["state"] == "warn" and checks["damaged"]["fix"]["id"] == "tidy_damaged"
    assert checks["port"]["summary"] == "Not in use"
    assert checks["backups"]["summary"] == "No backup yet"
    assert checks["swiftc"]["state"] == "ok" and checks["disk"]["summary"] == "80 GB free"
    assert result["worst"] == "problem"
    ran = [c[0] if "tcc" not in " ".join(c) else "tcc" for c in desk_.run.calls]
    assert sorted(ran) == sorted(
        ["tcc", "/fake/claude", "/fake/claude", "xcode-select", "xcrun", "lsof"]
    )


async def test_the_checkup_by_voice_is_one_quiet_tool_with_a_short_summary(hub, desk_):
    (logs := desk_.logs).mkdir(parents=True)
    (logs / "jarvis.log").write_text(
        "2026-09-29 20:00:00,001 ERROR api_key=sk-abcdefghijklmnop1234\n"
    )
    (tool,) = desk_.tools()
    assert tool.name == "run_checkup"
    queue = Watch(hub)
    said = (await tool.handler({}))["content"][0]["text"]
    assert said.startswith("Checkup done:") and "Screen Recording: Not allowed yet" in said
    assert "Settings › Health & safety" in said
    assert "sk-" not in said and "api_key" not in said  # counts only, never a log line
    assert [e["type"] for e in drain(queue) if e["type"] == "ops_doctor"] == ["ops_doctor"]


async def test_two_checkups_asked_at_once_run_once(hub, desk_):
    first = asyncio.create_task(desk_.doctor(source="voice"))
    second = asyncio.create_task(desk_.doctor(source="voice"))
    a, b = await asyncio.gather(first, second)
    assert a is b
    assert sum(1 for c in desk_.run.calls if c[0] == "lsof") == 1


async def test_a_port_held_by_another_app_is_named_without_binding_it(hub, desk_):
    desk_.run.lsof = (0, "p4242\ncnode\n")
    hub.prefs.remote_enabled = True
    result = await desk_.doctor(source="voice")
    port = next(c for c in result["checks"] if c["id"] == "port")
    assert port["state"] == "problem" and port["meta"] == "node (4242)"


async def test_fixes_ask_nothing_of_the_hub_they_dont_need(hub, desk_, monkeypatch, tmp_path):
    rebuilt, reconnected = [], []

    async def rebuild_brain(only=None):
        rebuilt.append(only)

    async def reconnect(cid):
        reconnected.append(cid)

    monkeypatch.setattr(hub, "rebuild_brain", rebuild_brain)
    monkeypatch.setattr(hub.connectors, "reconnect", reconnect)
    monkeypatch.setattr(
        hub.connectors,
        "public",
        lambda: {
            "connections": [
                {"id": "notion", "status": "error"},
                {"id": "gh", "status": "connected"},
            ]
        },
    )
    queue = Watch(hub)
    for fix in ("rebuild_knowledge", "restart_connectors", "not_a_fix"):
        await hub._handle({"type": "ops_fix", "fix": fix})
    fixed = [await queue.next("ops_fixed"), await queue.next("ops_fixed")]
    assert {f["fix"] for f in fixed} == {"rebuild_knowledge", "restart_connectors"}
    assert all(f["ok"] for f in fixed)
    assert rebuilt == [None] and reconnected == ["notion"]


async def test_damaged_copies_are_put_away_after_a_backup_never_deleted(hub, desk_, tmp_path):
    (tmp_path / "memory.json").write_text('{"facts": []}')
    (tmp_path / "memory.json.bad-20260901-101010").write_text("{torn")
    (tmp_path / "brain").mkdir(exist_ok=True)
    (tmp_path / "brain" / "index.json.bad-20260902-111111").write_text("{torn")
    queue = Watch(hub)
    await hub._handle({"type": "ops_fix", "fix": "tidy_damaged"})
    fixed = await queue.next("ops_fixed")
    assert fixed["ok"] and fixed["text"] == "Moved 2 damaged copies to Damaged files."
    kept = tmp_path / "Damaged files" / "2026-09-29 at 20.15.12"
    assert sorted(os.listdir(kept)) == [
        "brain - index.json.bad-20260902-111111",
        "memory.json.bad-20260901-101010",
    ]
    made = backup.list_backups([desk_.backup_folder()])
    assert [b["kind"] for b in made] == ["fix"]


async def test_the_security_review_and_its_tightens(hub, desk_, tmp_path, monkeypatch):
    hub.prefs.control_always = True
    hub.prefs.screen_aware = False
    hub.prefs.code_mode = "auto"
    hub.prefs.pay_limit_day = 900.0
    (tmp_path / "memory.json").write_text("{}")
    os.chmod(tmp_path / "memory.json", 0o644)
    queue = Watch(hub)
    await hub._handle({"type": "ops_security"})
    review = await queue.next("ops_security")
    found = {f["id"]: f for f in review["findings"]}
    assert found["control"]["state"] == "notice"
    assert found["code"]["state"] == "risk" and found["code"]["summary"] == (
        "New sessions start in Bypass"
    )
    assert found["purchases"]["actions"][-1]["id"] == "pay_defaults"
    assert found["data_folder"]["state"] == "risk"
    assert "memory.json" in [i["label"] for i in found["data_folder"]["items"]]
    assert found["companion"]["state"] == "ok"

    for action in ("control_ask", "code_default_manual", "pay_defaults", "make_private"):
        await hub._handle({"type": "ops_tighten", "action": action})
        done = await queue.next("ops_tightened")
        assert done["ok"], done
    assert hub.prefs.control_always is False
    assert hub.prefs.code_mode == "ask"
    assert hub.prefs.pay_limit_day == 500.0 and hub.prefs.pay_limit_purchase == 250.0
    assert stat.S_IMODE(os.stat(tmp_path / "memory.json").st_mode) == 0o600
    # Nothing left to tighten: said, and nothing changes.
    await hub._handle({"type": "ops_tighten", "action": "code_default_manual"})
    done = await queue.next("ops_tightened")
    assert not done["ok"] and done["text"] == "Nothing to change."
    await hub._handle({"type": "ops_tighten", "action": "loosen_everything"})
    done = await queue.next("ops_tightened")
    assert not done["ok"]


async def test_backups_from_the_window_live_in_documents_never_the_real_home(hub, desk_, tmp_path):
    (tmp_path / "memory.json").write_text('{"facts": ["x"]}')
    hub.set_prefs({"humor": 55})  # prefs.json is there too
    queue = Watch(hub)
    await hub._handle({"type": "ops_backup"})
    done = await queue.next("ops_backup_done")
    assert done["ok"] and done["backup"]["kind"] == "manual"
    where = Path(done["backup"]["path"])
    assert where.parent == desk_.home / "Documents" / "Jarvis" / "Backups"
    assert desk_.home == tmp_path.parent / f"{tmp_path.name}-home"  # never the real home
    assert "prefs.json" in [
        r["path"] for r in json.loads(zipfile.ZipFile(where).read("manifest.json"))["files"]
    ]
    listed = await queue.next("ops_backups")
    assert listed["items"][0]["name"] == where.name and listed["daily"] is True

    await hub._handle({"type": "ops_backup_verify", "path": str(where)})
    checked = await queue.next("ops_verified")
    assert checked["ok"] and checked["files"] == 2

    (tmp_path / "memory.json").write_text('{"facts": ["changed"]}')
    await hub._handle({"type": "ops_restore_preview", "path": str(where)})
    seen = await queue.next("ops_restore_preview")
    assert seen["ok"] and seen["replace"] == ["memory.json"]

    await hub._handle({"type": "ops_restore", "path": str(where)})
    staged = await queue.next("ops_restore_staged")
    assert staged["ok"] and staged["pending"]["files"] == 2
    assert staged["safety"]["kind"] == "safety"
    # Nothing the running app has open changed; the next start puts it in place.
    assert json.loads((tmp_path / "memory.json").read_text()) == {"facts": ["changed"]}
    assert backup.pending(tmp_path)["backup"] == where.name
    await hub._handle({"type": "ops_restore_cancel"})
    await queue.next("ops_backups")
    assert backup.pending(tmp_path) is None


async def test_a_chosen_folder_and_a_zip_path_from_anywhere_else_are_checked(hub, desk_, tmp_path):
    hub.set_feature_prefs({"ops_backup_folder": "relative/path"})
    assert hub.prefs.feature("ops_backup_folder") == ""  # refused: stays the default
    chosen = tmp_path / "External" / "Jarvis"
    hub.set_feature_prefs({"ops_backup_folder": str(chosen)})
    assert desk_.backup_folder() == chosen
    queue = Watch(hub)
    await hub._handle({"type": "ops_backup_verify", "path": "relative.zip"})
    await hub._handle({"type": "ops_restore", "path": "/etc/passwd"})
    await asyncio.sleep(0.05)
    assert not [e for e in drain(queue) if e["type"] in ("ops_verified", "ops_restore_staged")]


async def test_the_daily_backup_keeps_seven_and_says_once_when_it_fails(hub, desk_, tmp_path):
    (tmp_path / "memory.json").write_text("{}")
    folder = desk_.backup_folder()
    for day in range(8):
        desk_.clock = lambda day=day: NOW + timedelta(days=day)
        assert await desk_.daily_if_due() is not None
        assert await desk_.daily_if_due() is None  # already made today
    assert sum(1 for b in backup.list_backups([folder]) if b["kind"] == "daily") == 7
    hub.set_feature_prefs({"ops_backup_daily": False})
    desk_.clock = lambda: NOW + timedelta(days=30)
    assert await desk_.daily_if_due() is None

    hub.set_feature_prefs({"ops_backup_daily": True})
    (tmp_path / "blocker").write_text("x")
    hub.set_feature_prefs({"ops_backup_folder": str(tmp_path / "blocker")})
    queue = Watch(hub)
    assert await desk_.daily_if_due() is None
    assert await desk_.daily_if_due() is None
    alerts = [e for e in drain(queue) if e["type"] == "alert"]
    assert len(alerts) == 1 and alerts[0]["text"].startswith("Today's backup didn't work")


async def test_a_diagnostics_file_masks_secrets_and_holds_no_data(hub, desk_, tmp_path):
    logs = desk_.logs
    logs.mkdir(parents=True)
    (logs / "backend.log").write_text(
        f"JARVIS listening on http://127.0.0.1:5000/?token=Zx9yabcDEF1234567890abcdef\n"
        f"call from +1 510 555 0100 in {desk_.home}/Documents\n"
    )
    (tmp_path / "memory.json").write_text('{"facts": ["my secret plans"]}')
    queue = Watch(hub)
    await hub._handle({"type": "ops_diagnostics", "megabytes": 1})
    made = await queue.next("ops_diagnostics")
    assert made["ok"], made
    path = Path(made["path"])
    assert path.parent == desk_.home / "Documents" / "Jarvis" / "Diagnostics"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        body = zf.read("logs/backend.log").decode()
        everything = "".join(zf.read(n).decode() for n in names)
    assert {"README.txt", "versions.json", "checkup.json", "security.json"} <= names
    assert "Zx9y" not in body and "[hidden]" in body and "[phone]" in body
    assert "~/Documents" in body
    assert "my secret plans" not in everything and "ann@example.com" not in everything


async def test_reveal_shows_only_backups_and_diagnostics_in_finder(hub, desk_, tmp_path):
    (tmp_path / "memory.json").write_text("{}")
    made = await desk_.make_backup("manual")
    await hub._handle({"type": "ops_reveal", "path": made["path"]})
    await hub._handle({"type": "ops_reveal", "path": str(tmp_path / "memory.json")})
    await hub._handle({"type": "ops_reveal", "path": "/etc/hosts"})
    assert [c for c in desk_.run.calls if c[0] == "open"] == [("open", "-R", made["path"])]


def test_the_feature_prefs_are_cleaned():
    assert prefs.clean_feature_values({"ops_setup_state": "hacked"}) == {}
    assert prefs.clean_feature_values({"ops_setup_state": "done"}) == {"ops_setup_state": "done"}
    assert prefs.clean_feature_values({"ops_backup_daily": "yes"}) == {}
    assert prefs.clean_feature_values({"ops_backup_folder": "~/Backups"})[
        "ops_backup_folder"
    ].endswith("/Backups")
    assert prefs.clean_feature_values({"ops_backup_folder": "/a/../etc"}) == {}


def test_serve_puts_a_staged_restore_in_place_before_the_hub_reads_anything(tmp_path, monkeypatch):
    """The whole restart: serve() holds the data folder, the ops feature's prepare() moves
    the staged backup into place, and only then is the hub (and every store) made."""
    import logging

    from jarvis import config, prefs, server

    data = tmp_path / "Jarvis"
    data.mkdir()
    (data / "memory.json").write_text('{"facts": ["from the backup"]}')
    made = backup.create(data, tmp_path / "Backups", clock=lambda: NOW)
    (data / "memory.json").write_text('{"facts": ["changed since"]}')
    backup.stage(Path(made["path"]), data)
    monkeypatch.setenv("HOME", str(tmp_path))  # its log file goes here, never the owner's
    monkeypatch.setattr(prefs, "APP_SUPPORT", data)
    monkeypatch.setattr(config, "load_settings", lambda *_a, **_k: config.Settings())
    seen = []

    class Stop(Exception):
        pass

    def hub(_settings):
        seen.append(json.loads((data / "memory.json").read_text()))
        raise Stop

    monkeypatch.setattr(server, "Hub", hub)
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    try:
        with pytest.raises(Stop):
            server.serve(0, "token")
    finally:
        for extra in [h for h in root.handlers if h not in handlers]:
            root.removeHandler(extra)
            extra.close()
        root.setLevel(level)
    assert seen == [{"facts": ["from the backup"]}]
    told = backup.take_result(data)
    assert told["ok"] and told["files"] == 1
