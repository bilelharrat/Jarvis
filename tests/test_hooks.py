"""Script hooks (jarvis.hooks): the owner's own scripts run on events, each only after a yes
that's remembered by the script's SHA-256 (a changed script asks again), with the event as
JSON on standard input and never interpolated, a small environment, a timeout, and only a
file inside the hooks folder, the owner's and writable by no one else."""

import asyncio
import json
import os

import pytest

from jarvis import hooks as hk

SCRIPT = '#!/bin/sh\ncat > "$0.seen"\necho ran\n'


def write(folder, event, name, body=SCRIPT, mode=0o700):
    path = folder / event / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(mode)
    return path


class Rig:
    def __init__(self, tmp_path, answers=None):
        self.folder = tmp_path / "hooks"
        self.folder.mkdir()
        self.asked: list[str] = []
        self.answers = list(answers or [])
        self.ran: list[tuple] = []
        self.clock = [0.0]

        async def ask(question, detail):
            self.asked.append(question)
            return self.answers.pop(0) if self.answers else None

        async def run(path, payload, cwd, env):
            self.ran.append((path.name, json.loads(payload), env))
            return "ok", "done"

        self.hooks = hk.ScriptHooks(
            self.folder, tmp_path / "hooks.json", ask, run=run, mono=lambda: self.clock[0]
        )


def test_only_a_script_of_the_owners_that_no_one_else_can_change(tmp_path):
    rig = Rig(tmp_path)
    good = write(rig.folder, "arrive", "lights.sh")
    write(rig.folder, "arrive", "notexec.sh", mode=0o600)
    write(rig.folder, "arrive", "shared.sh", mode=0o777)
    (rig.folder / "arrive" / "a-folder").mkdir()
    outside = tmp_path / "elsewhere.sh"
    outside.write_text(SCRIPT)
    outside.chmod(0o700)
    (rig.folder / "arrive" / "link.sh").symlink_to(outside)
    write(rig.folder, "arrive", ".hidden.sh")
    write(rig.folder, "arrive", "README.txt", mode=0o600)
    found = {s.path.name: s.problem for s in rig.hooks.scripts("arrive")}
    assert found == {
        "a-folder": "it isn't a file",
        "lights.sh": "",
        "link.sh": "it points outside the hooks folder",
        "notexec.sh": "it isn't executable (chmod +x)",
        "shared.sh": "others can change it (chmod go-w)",
    }
    [ok] = [s for s in rig.hooks.scripts("arrive") if not s.problem]
    assert ok.digest == hk.sha256(good) and ok.rel == "arrive/lights.sh"


async def test_the_first_run_asks_and_the_yes_is_remembered_by_its_hash(tmp_path):
    rig = Rig(tmp_path, answers=[True])
    path = write(rig.folder, "arrive", "lights.sh")
    ran = await rig.hooks.fire("arrive", {"place": "home"})
    assert ran == ["arrive/lights.sh"]
    assert rig.asked == ["Run your script “lights.sh” when “arrive” happens?"]
    name, payload, env = rig.ran[0]
    assert payload["event"] == "arrive" and payload["place"] == "home" and "at" in payload
    assert set(env) == {"PATH", "HOME", "LANG", "JARVIS_EVENT"} and env["JARVIS_EVENT"] == "arrive"
    assert await rig.hooks.fire("arrive", {"place": "home"}) == ["arrive/lights.sh"]
    assert len(rig.asked) == 1  # remembered
    path.write_text(SCRIPT + "echo more\n")  # changed: asks again
    assert await rig.hooks.fire("arrive", {}) == []  # nobody answered this time
    assert len(rig.asked) == 2 and rig.hooks.public()["scripts"][0]["state"] == "changed"
    saved = json.loads((tmp_path / "hooks.json").read_text())
    assert saved["allowed"]["arrive/lights.sh"] != hk.sha256(path)


async def test_a_no_is_remembered_until_the_script_changes(tmp_path):
    rig = Rig(tmp_path, answers=[False, True])
    path = write(rig.folder, "wake", "hello.sh")
    assert await rig.hooks.fire("wake", {}) == []
    assert await rig.hooks.fire("wake", {}) == []
    assert len(rig.asked) == 1 and rig.hooks.public()["scripts"][0]["state"] == "denied"
    path.write_text(SCRIPT + "# fixed\n")
    assert await rig.hooks.fire("wake", {}) == ["wake/hello.sh"]
    assert len(rig.asked) == 2


async def test_one_card_at_a_time_for_a_script(tmp_path):
    rig = Rig(tmp_path)
    write(rig.folder, "heads-up", "log.sh")
    gate = asyncio.Event()

    async def slow_ask(question, detail):
        rig.asked.append(question)
        await gate.wait()
        return True

    rig.hooks.ask = slow_ask
    first = asyncio.create_task(rig.hooks.fire("heads-up", {"text": "a"}))
    await asyncio.sleep(0.01)
    assert await rig.hooks.fire("heads-up", {"text": "b"}) == []  # its card is up already
    gate.set()
    assert await first == ["heads-up/log.sh"]
    assert len(rig.asked) == 1


async def test_settings_allow_ahead_of_time_and_list_what_it_found(tmp_path):
    rig = Rig(tmp_path)
    write(rig.folder, "timer", "flash.sh")
    write(rig.folder, "leave", "bad.sh", mode=0o600)
    assert rig.hooks.decide("timer/flash.sh", True)
    assert not rig.hooks.decide("leave/bad.sh", True)  # it can't run anyway
    assert not rig.hooks.decide("timer/nope.sh", True)
    assert (
        await rig.hooks.fire("timer", {"kind": "timer"}) == ["timer/flash.sh"] and rig.asked == []
    )
    state = rig.hooks.public()
    assert {s["path"]: s["state"] for s in state["scripts"]} == {
        "leave/bad.sh": "problem",
        "timer/flash.sh": "allowed",
    }
    assert state["runs"][0]["path"] == "timer/flash.sh" and state["runs"][0]["status"] == "ok"


async def test_a_storm_of_events_runs_a_script_at_most_so_often(tmp_path):
    rig = Rig(tmp_path)
    write(rig.folder, "heads-up", "log.sh")
    rig.hooks.decide("heads-up/log.sh", True)
    for _ in range(hk.PER_HOUR + 5):
        await rig.hooks.fire("heads-up", {})
    assert len(rig.ran) == hk.PER_HOUR
    rig.clock[0] += 3600
    assert await rig.hooks.fire("heads-up", {}) == ["heads-up/log.sh"]


def test_the_folder_is_made_on_demand_with_a_readme(tmp_path):
    rig = Rig(tmp_path)
    folder = rig.hooks.ensure_folder()
    assert sorted(p.name for p in folder.iterdir() if p.is_dir()) == sorted(hk.EVENTS)
    assert "JSON on standard input" in (folder / "README.txt").read_text()
    assert rig.hooks.scripts() == []  # the README isn't a script


async def test_unknown_events_run_nothing(tmp_path):
    rig = Rig(tmp_path, answers=[True])
    write(rig.folder, "arrive", "lights.sh")
    assert await rig.hooks.fire("reboot", {}) == [] and rig.asked == []


# ── a real run, in a temp folder ──


@pytest.mark.skipif(not os.path.exists("/bin/sh"), reason="needs /bin/sh")
async def test_a_real_script_gets_the_json_on_stdin_never_in_a_shell_line(tmp_path):
    folder = tmp_path / "hooks" / "arrive"
    folder.mkdir(parents=True)
    script = folder / "echo.sh"
    script.write_text('#!/bin/sh\necho "args:$#"\ncat\nenv | sort\n')
    script.chmod(0o700)
    payload = json.dumps({"event": "arrive", "place": "$(touch pwned); `touch pwned2`"}).encode()
    status, out = await hk.run_script(
        script,
        payload,
        folder,
        {"PATH": hk.PATH, "HOME": str(tmp_path), "LANG": "en_US.UTF-8", "JARVIS_EVENT": "arrive"},
    )
    assert status == "ok"
    assert out.startswith("args:0\n") and '"place": "$(touch pwned); `touch pwned2`"' in out
    assert not (folder / "pwned").exists() and not (folder / "pwned2").exists()
    env_lines = {
        line.split("=", 1)[0]
        for line in out.splitlines()
        if "=" in line and not line.startswith("{")
    }
    assert {"PATH", "HOME", "LANG", "JARVIS_EVENT"} <= env_lines
    assert not any(k.startswith(("ANTHROPIC", "TWILIO", "JARVIS_TOKEN")) for k in env_lines)


@pytest.mark.skipif(not os.path.exists("/bin/sh"), reason="needs /bin/sh")
async def test_a_real_script_that_fails_or_hangs(tmp_path):
    folder = tmp_path / "hooks"
    folder.mkdir()
    bad = folder / "bad.sh"
    bad.write_text("#!/bin/sh\necho oops\nexit 3\n")
    bad.chmod(0o700)
    assert await hk.run_script(bad, b"{}", folder, {"PATH": hk.PATH}) == ("exit 3", "oops")
    slow = folder / "slow.sh"
    slow.write_text("#!/bin/sh\nsleep 30 &\nsleep 30\n")
    slow.chmod(0o700)
    status, _out = await hk.run_script(slow, b"{}", folder, {"PATH": hk.PATH}, timeout=0.3)
    assert status == "timed out"
    loud = folder / "loud.sh"
    loud.write_text("#!/bin/sh\nyes | head -c 200000\n")
    loud.chmod(0o700)
    status, out = await hk.run_script(loud, b"", folder, {"PATH": hk.PATH})
    assert status == "ok" and len(out) <= hk.OUTPUT_READ


# ── on a real hub: which events run the scripts, and Settings ──


@pytest.fixture
def wired(settings, quiet_speaker, isolated, monkeypatch):
    from test_hub import make_hub

    from jarvis.features import automation

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    feature = automation.feature_of(hub)
    ran = []

    async def run(path, payload, cwd, env):
        ran.append((path.parent.name, json.loads(payload)))
        return "ok", ""

    feature.scripts.run = run
    opened = []
    monkeypatch.setattr(automation, "reveal", opened.append)
    return hub, feature, ran, opened


async def settle(ran, n):
    for _ in range(100):
        if len(ran) >= n:
            return
        await asyncio.sleep(0.01)


async def test_each_event_runs_its_scripts(wired):
    from jarvis import timers as tk
    from jarvis.jobs import Run
    from jarvis.proactive import Alert

    hub, feature, ran, _opened = wired
    folder = feature.scripts.folder
    for event in ("heads-up", "routine-finished", "session-done", "timer", "webhook", "arrive"):
        write(folder, event, "log.sh")
        assert feature.scripts.decide(f"{event}/log.sh", True)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain around 4 PM."), speak=False)
    feature._routine_finished(
        SimpleRoutine(), Run(at="now", cause="Scheduled", status="ok", output="Done.")
    )
    hub.emit(
        "task_finished", task_kind="code", id=2, status="done", folder="jarvis", result="All green"
    )
    hub.emit("task_finished", task_kind="code", id=3, status="stopped", folder="jarvis")  # not news
    feature.timers.on_rang(tk.new_timer(60, "tea", __import__("datetime").datetime.now()))
    feature.engine._hook("arrive", {"place": "home", "source": "phone"})
    hub.client_factory = __import__("test_jobs").scripted("A build failed.")
    await feature.webhooks.add("ci")
    await feature._webhook_call(feature.webhooks.find("ci"), "build 7 failed")
    await settle(ran, 8)  # the webhook's own heads-up runs the heads-up script too
    got = {event: data for event, data in ran}
    assert set(got) == {
        "heads-up",
        "routine-finished",
        "session-done",
        "timer",
        "arrive",
        "webhook",
    }
    assert got["webhook"] == {**got["webhook"], "hook": "ci", "text": "build 7 failed"}
    heads = [(d["kind"], d["text"]) for e, d in ran if e == "heads-up"]
    assert ("rain", "Rain around 4 PM.") in heads and ("webhook", "A build failed.") in heads
    assert (
        got["routine-finished"]["routine"]["name"] == "Brief"
        and got["routine-finished"]["output"] == "Done."
    )
    assert got["session-done"] == {
        **got["session-done"],
        "session": 2,
        "status": "done",
        "result": "All green",
    }
    assert got["timer"]["label"] == "tea" and got["arrive"]["place"] == "home"
    assert len([e for e, _d in ran if e == "session-done"]) == 1


class SimpleRoutine:
    id, name = "r1", "Brief"


async def test_no_hooks_folder_means_nothing_runs_or_is_looked_at_often(wired):
    from jarvis.proactive import Alert

    hub, feature, ran, _opened = wired
    looked = []
    real = feature.scripts.scripts
    feature.scripts.scripts = lambda event=None: looked.append(event) or real(event)
    for n in range(20):
        hub.notify(Alert(f"rain:{n}", "rain", "Rain", "Rain."), speak=False)
    await asyncio.sleep(0.05)
    assert ran == [] and looked == []  # no folder: no task, no scan


async def test_the_first_run_asks_on_a_card_and_nobody_answering_asks_again_later(
    wired, monkeypatch
):
    from jarvis import jobs

    hub, feature, ran, _opened = wired
    write(feature.scripts.folder, "wake", "hello.sh")
    cards = []
    hub.add_approval_sink(cards.append)
    monkeypatch.setattr(jobs, "APPROVAL_WAIT", 0.05)
    assert await feature.scripts.fire("wake", {}) == []
    assert cards[0]["question"] == "Run your script “hello.sh” when “wake” happens?"
    assert [c["label"] for c in cards[0]["choices"]] == ["Run it", "Don't"]
    assert feature.scripts.public()["scripts"][0]["state"] == "new"  # not remembered
    hub.add_approval_sink(lambda a: hub.resolve(a["id"], "allow"))
    assert await feature.scripts.fire("wake", {}) == ["wake/hello.sh"]
    assert ran and feature.scripts.public()["scripts"][0]["state"] == "allowed"


async def test_settings_open_the_folder_allow_and_refuse(wired):
    hub, feature, _ran, opened = wired
    q = hub.subscribe()
    await hub._handle({"type": "automation_scripts", "action": "open"})
    assert opened == [feature.scripts.folder] and (feature.scripts.folder / "arrive").is_dir()
    write(feature.scripts.folder, "arrive", "lights.sh")
    await hub._handle({"type": "automation_scripts", "action": "scan"})
    await hub._handle({"type": "automation_scripts", "action": "allow", "path": "arrive/lights.sh"})
    await hub._handle({"type": "automation_scripts", "action": "deny", "path": "arrive/lights.sh"})
    states = []
    while not q.empty():
        event = q.get_nowait()
        if event["type"] == "automation" and "scripts" in event:
            states.append([s["state"] for s in event["scripts"]["scripts"]])
    assert states[-3:] == [["new"], ["allowed"], ["denied"]]
