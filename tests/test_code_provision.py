"""Eden Code's cloud machine setup (cloud_templates.py, features/code_provision.py): the
templates' commands, the cost estimate, the first-boot script, and the feature's plan, card,
create, start, stop, delete, warm images, idle stop and wake. Every CLI is faked: nothing is
ever made at a provider, and no ssh runs."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis import cloud_templates as ct
from jarvis.features import code_provision
from jarvis.features.code_provision import Provisioner

KEY = "ssh-ed25519 " + "A" * 68 + " eden-cloud"


# ── the templates ──


def spec(provider="gcp", **kw):
    p = ct.PROVIDERS[provider]
    base = dict(provider=provider, alias="eden-box", region=p.region, size=p.sizes[0].id)
    if provider == "docker":
        base["port"] = 52022
    base.update(kw)
    return ct.Spec(**base), p


@pytest.mark.parametrize("provider", list(ct.PROVIDERS))
def test_every_template_plans_and_captures_an_address(provider):
    s, p = spec(provider)
    assert ct.check(s, p) == ""
    steps = ct.create_steps(s, p)
    assert steps and all(step.argv[0] in (*p.clis, "echo") for step in steps)
    captured = {c.split(":")[0] for step in steps if (c := step.capture)}
    # Every plan learns how to reach the machine (docker: through this Mac's port).
    assert provider == "docker" or any("ip" in names for names in captured)
    for step in steps:
        assert step.shown().startswith("$ ")
        assert "{" not in step.shown().replace("{{", "").replace("{Key", "").replace("{Vol", "")
    # Stop, start, status and delete exist for each one.
    rec = {"provider": provider, "alias": "eden-box", "region": s.region, "id": "i-1"}
    assert ct.stop_steps(rec) and ct.start_steps(rec) and ct.delete_steps(rec)
    assert ct.status_step(rec).argv[0] in p.clis


def test_names_regions_and_sizes_are_checked():
    s, p = spec("gcp", alias="Bad Name")
    assert "lower-case" in ct.check(s, p)
    s, p = spec("gcp", region="--zone=x")
    assert "zone" in ct.check(s, p)
    s, p = spec("gcp", size="n2-huge")
    assert "sizes" in ct.check(s, p)
    s, p = spec("docker", port=0)
    assert "port" in ct.check(s, p)


def test_a_warm_image_replaces_the_base_image():
    s, p = spec("gcp", image="eden-app-gcp")
    create = ct.create_steps(s, p)[0].argv
    assert "--image" in create and "eden-app-gcp" in create and "--image-family" not in create
    s, p = spec("hetzner", image="12345")
    assert "12345" in ct.create_steps(s, p)[1].argv


def test_aws_dry_run_makes_nothing_and_others_have_none():
    s, p = spec("aws")
    dry = ct.dry_run_step(s, p)
    assert dry is not None and "--dry-run" in dry.argv and dry.ok_if == "DryRunOperation"
    assert ct.dry_run_step(*spec("gcp")) is None


def test_estimate_says_hour_month_and_that_it_is_an_estimate():
    p = ct.PROVIDERS["gcp"]
    e = ct.estimate(p, p.sizes[0], 30)
    assert e["hourly"] == p.sizes[0].hourly
    assert e["left_on_month"] > e["typical_month"] > e["stopped_month"] > 0
    assert any("estimate" in line for line in e["lines"])
    assert any("30 minutes idle" in line for line in e["lines"])
    hz = ct.PROVIDERS["hetzner"]
    e = ct.estimate(hz, hz.sizes[0], 0)
    assert e["typical_month"] == e["left_on_month"]  # (billed while off)
    assert any("while it's off" in line for line in e["lines"])
    local = ct.estimate(ct.PROVIDERS["docker"], ct.PROVIDERS["docker"].sizes[0], 30)
    assert local["hourly"] == 0 and local["lines"] == ["Free: it runs on this Mac."]


def test_bootstrap_user_key_tools_and_idle_stop():
    vm = ct.bootstrap(KEY, 30)
    assert "useradd -m -s /bin/bash eden" in vm
    assert KEY in vm and "claude.ai/install.sh" in vm
    assert "IDLE_MINUTES=30" in vm and "eden-idle.timer" in vm and "poweroff" in vm
    assert vm.rstrip().endswith("touch " + ct.READY_FILE)
    box = ct.bootstrap(KEY, 0, "container")
    assert "IDLE_MINUTES=0" in box and "kill -TERM 1" in box and "sshd -e" in box
    with pytest.raises(ValueError):
        ct.bootstrap("ssh-rsa AAAA'; rm -rf /", 30)


def test_capture_and_fill():
    assert ct.capture("ip:ipv4", "natIP 34.1.2.3\n") == {"ip": "34.1.2.3"}
    assert ct.capture(
        "id:json:Instances.0.InstanceId", json.dumps({"Instances": [{"InstanceId": "i-9"}]})
    ) == {"id": "i-9"}
    assert ct.capture("id,ip:words", "4242   164.90.1.2\n") == {"id": "4242", "ip": "164.90.1.2"}
    assert ct.capture("sg:text", "None\n") == {}
    assert ct.capture("id:regex:Machine ID: (\\w+)", "Machine ID: 3d8d\n") == {"id": "3d8d"}
    assert ct.fill(["x", "{ip}", "a{{.Status}}"], {"ip": "1.2.3.4"}) == [
        "x",
        "1.2.3.4",
        "a{{.Status}}",
    ]
    assert ct.fill(["{id}"], {}) is None


def test_status_words():
    assert ct.parse_status("gcp", 0, "TERMINATED\n") == "stopped"
    assert ct.parse_status("aws", 0, "terminated\n") == "gone"
    assert ct.parse_status("aws", 0, "running\n") == "running"
    assert ct.parse_status("do", 0, "off") == "stopped"
    assert ct.parse_status("hetzner", 1, "", "server not found") == "gone"
    assert ct.parse_status("fly", 0, "  State: stopped\n") == "stopped"
    rows = json.dumps([{"Name": "eden-box", "State": "running"}])
    assert ct.parse_status("tart", 0, rows, alias="eden-box") == "running"
    assert ct.parse_status("tart", 0, "[]", alias="eden-box") == "gone"
    assert ct.parse_status("gcp", 1, "", "permission denied") == ""


def test_ssh_block_and_image_names():
    block = ct.ssh_block(
        "eden-box", {"host": "1.2.3.4", "port": 22, "user": "eden"}, "/k", "/kh", "gcp"
    )
    assert "Host eden-box" in block and "HostName 1.2.3.4" in block and "Port" not in block
    local = ct.ssh_block(
        "eden-box", {"host": "127.0.0.1", "port": 52022, "user": "eden"}, "/k", "/kh", "docker"
    )
    assert "Port 52022" in local
    with pytest.raises(ValueError):
        ct.ssh_block(
            "eden-box",
            {"host": "evil\nProxyCommand x", "port": 22, "user": "eden"},
            "/k",
            "/kh",
            "gcp",
        )
    assert ct.image_name("My App!", "gcp") == "eden-my-app-gcp"
    assert ct.image_name("2fa", "aws") == "eden-p-2fa-aws"


def test_do_fingerprint_is_md5_pairs():
    fp = ct.do_fingerprint(KEY)
    assert len(fp.split(":")) == 16


# ── the feature ──


class Desk:
    def __init__(self):
        self.machines = []
        self.handoffs = []
        self.added = []
        self.removed = []
        self.checked = []

    def tr(self, text):
        return text

    def load(self):
        pass

    def config_hosts(self):
        return ["my-old-box"]

    def machine(self, alias):
        return next((m for m in self.machines if m.alias == alias), None)

    async def add_machine(self, alias):
        self.added.append(alias)
        self.machines.append(SimpleNamespace(alias=alias, ok=True, problem=""))
        return f"{alias} is ready."

    def remove_machine(self, alias):
        self.removed.append(alias)
        self.machines = [m for m in self.machines if m.alias != alias]
        return f"Removed {alias}."

    async def check_machine(self, alias):
        self.checked.append(alias)
        return ""


class Hub:
    def __init__(self, tmp, answer="go"):
        self.tmp = tmp
        self.answer = answer
        self.asked = []
        self.events = []
        self.features = {}
        self.prefs = SimpleNamespace(feature=lambda k: self.features.get(k))
        self.code_handoff = Desk()
        self.tasks = SimpleNamespace(
            projects=lambda: ["app"], project_path=lambda n: tmp / "projects" / n
        )
        self.commands, self.loops = {}, {}

    def feature_path(self, name):
        return self.tmp / "support" / name

    def emit(self, kind, **data):
        self.events.append((kind, data))

    async def request_approval(self, question, detail="", choices=None, context=None):
        self.asked.append((question, detail))
        return self.answer

    def set_feature_prefs(self, changes):
        self.features.update(changes)

    def register_command(self, kind, handler, slow=False):
        self.commands[kind] = handler

    def register_loop(self, name, factory):
        self.loops[name] = factory


class FakeCli:
    """Answers like each provider's CLI would, recording every command; makes nothing."""

    def __init__(self, prov):
        self.prov = prov
        self.calls = []
        self.fail = {}  # a word in the command -> (code, out, err)
        self.state = "RUNNING"

    async def __call__(self, argv, timeout, stdin=""):
        self.calls.append(argv)
        line = " ".join(argv)
        for word, answer in self.fail.items():
            if word in line:
                return answer
        if argv[0] == "ssh-keygen":
            path = Path(argv[argv.index("-f") + 1])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private")
            path.with_suffix(".pub").write_text(KEY + "\n")
            return 0, "", ""
        if (
            "natIP" in line
            or argv[1:3] == ["server", "ip"]
            or argv[:2] == ["tart", "ip"]
            or "PublicIpAddress" in line
        ):
            return 0, "34.9.8.7\n", ""
        if "value(status)" in line:
            return 0, self.state + "\n", ""
        if "run-instances" in line and "--dry-run" in line:
            return 254, "", "An error occurred (DryRunOperation): Request would have succeeded"
        if "run-instances" in line:
            return 0, json.dumps({"Instances": [{"InstanceId": "i-abc"}]}), ""
        if line.startswith("hcloud server create "):
            return 0, json.dumps({"server": {"id": 77}}), ""
        if "droplet create" in line:
            return 0, "4242 164.90.1.2\n", ""
        if "ips allocate-v4" in line:
            return 0, "VERSION IP\nv4 66.241.1.2\n", ""
        if "machine run" in line:
            return 0, "Machine ID: 3d8d9a1b2c3d4e\n", ""
        if "describe-security-groups" in line:
            return 0, "sg-1\n", ""
        if line.startswith("echo "):
            return 0, argv[1] + "\n", ""
        return 0, "ok\n", ""


@pytest.fixture
def setup(tmp_path):
    hub = Hub(tmp_path)
    prov = Provisioner(hub)
    prov.ssh_dir = tmp_path / "ssh"
    cli = FakeCli(prov)
    prov.run = cli
    prov.find_cli = lambda names: names[0]
    prov.free_port = lambda: 52022
    spawned = []

    async def spawn(argv):
        spawned.append(argv)
        return ""

    prov.spawn = spawn
    code_provision.READY_EVERY = 0.0
    return hub, prov, cli, spawned


def run(coro):
    return asyncio.run(coro)


def test_plan_is_a_dry_run_that_makes_nothing(setup):
    hub, prov, cli, _ = setup
    plan = run(prov.plan({"provider": "gcp", "alias": "eden-box", "size": "e2-medium"}))
    assert plan["problem"] == ""
    assert any("instances create eden-box" in s for s in plan["steps"])
    assert plan["steps"][0].startswith("$ ssh-keygen")  # (no Eden key yet)
    assert plan["estimate"]["hourly"] == ct.PROVIDERS["gcp"].size("e2-medium").hourly
    assert "<your Eden key>" in plan["bootstrap"]
    # Only the sign-in check ran: no create, no key made.
    assert all("create" not in " ".join(c) for c in cli.calls)
    assert not (prov.ssh_dir / ct.KEY_NAME).exists()
    assert hub.asked == []


def test_plan_refusals(setup):
    hub, prov, cli, _ = setup
    assert "provider" in run(prov.plan({"provider": "nope"}))["problem"]
    assert "already a host" in run(prov.plan({"provider": "gcp", "alias": "my-old-box"}))["problem"]
    prov.find_cli = lambda names: ""
    plan = run(prov.plan({"provider": "hetzner", "alias": "eden-box"}))
    assert "isn't installed" in plan["problem"] and "brew install hcloud" in plan["problem"]


def test_aws_plan_runs_its_dry_run(setup):
    hub, prov, cli, _ = setup
    cli.fail["get-caller-identity"] = (0, '{"Account": "1"}', "")
    plan = run(prov.plan({"provider": "aws", "alias": "eden-box"}))
    assert plan["checks"] and plan["checks"][0]["ok"] is True
    assert any("--dry-run" in c for c in cli.calls)
    assert not any("run-instances" in c and "--dry-run" not in c for c in cli.calls)


def test_create_asks_with_the_cost_then_makes_it(setup):
    hub, prov, cli, _ = setup
    plan = run(prov.plan({"provider": "gcp", "alias": "eden-box"}))
    said = run(prov.create(plan["id"]))
    question, detail = hub.asked[0]
    assert "an hour" in question and "Cost:" in detail and "instances create" in detail
    assert "ready on Google Cloud" in said and "sign in" in said
    rec = prov.record("eden-box")
    assert rec["state"] == "running" and rec["ip"] == "34.9.8.7"
    conf = (prov.ssh_dir / "eden-cloud.conf").read_text()
    assert "Host eden-box" in conf and "HostName 34.9.8.7" in conf
    assert (prov.ssh_dir / "config").read_text().startswith("# Eden Code")
    assert code_provision.INCLUDE in (prov.ssh_dir / "config").read_text()
    assert hub.code_handoff.added == ["eden-box"]
    assert hub.features["code_cloud_machine"] == "eden-box"
    boot = (hub.feature_path("code_provision") / "eden-box" / "bootstrap.sh").read_text()
    assert KEY in boot
    # The plan can't be run twice.
    assert "gone" in run(prov.create(plan["id"]))


def test_owner_config_is_kept_and_include_added_once(setup):
    hub, prov, cli, _ = setup
    prov.ssh_dir.mkdir(parents=True)
    (prov.ssh_dir / "config").write_text("Host mine\n  HostName 10.0.0.1\n")
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    run(prov.create(run(prov.plan({"provider": "hetzner", "alias": "eden-two"}))["id"]))
    text = (prov.ssh_dir / "config").read_text()
    assert text.count(code_provision.INCLUDE) == 1 and "Host mine\n  HostName 10.0.0.1" in text
    conf = (prov.ssh_dir / "eden-cloud.conf").read_text()
    assert "Host eden-box" in conf and "Host eden-two" in conf


def test_no_means_nothing_runs(setup):
    hub, prov, cli, _ = setup
    hub.answer = "deny"
    plan = run(prov.plan({"provider": "do", "alias": "eden-box"}))
    before = len(cli.calls)
    assert run(prov.create(plan["id"])) == "Nothing was made."
    assert len(cli.calls) == before and prov.record("eden-box") is None


def test_a_failed_create_is_kept_so_it_can_be_deleted(setup):
    hub, prov, cli, _ = setup
    cli.fail["instances create"] = (1, "", "ERROR: quota exceeded")
    said = run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    assert "quota exceeded" in said and "Delete" in said
    assert prov.record("eden-box")["state"] == "failed"
    assert hub.code_handoff.added == []


def test_docker_uses_a_local_port_and_tart_spawns_its_vm(setup):
    hub, prov, cli, spawned = setup
    run(prov.create(run(prov.plan({"provider": "docker", "alias": "eden-box"}))["id"]))
    conf = (prov.ssh_dir / "eden-cloud.conf").read_text()
    assert "HostName 127.0.0.1" in conf and "Port 52022" in conf
    assert any("127.0.0.1:52022:22" in c for c in cli.calls)
    run(prov.create(run(prov.plan({"provider": "tart", "alias": "eden-vm"}))["id"]))
    assert spawned and spawned[0][:2] == ["tart", "run"]
    assert any(c[:3] == ["tart", "exec", "-i"] for c in cli.calls)


def test_stop_start_and_address_refresh(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    assert run(prov.stop("eden-box")) == "Stopped eden-box."
    assert prov.record("eden-box")["state"] == "stopped"
    cli.fail["natIP"] = (0, "35.1.1.1\n", "")
    assert run(prov.start("eden-box")) == "eden-box is running."
    assert "HostName 35.1.1.1" in (prov.ssh_dir / "eden-cloud.conf").read_text()


def test_stop_refuses_while_a_session_works_there(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    hub.code_handoff.handoffs = [
        SimpleNamespace(alias="eden-box", live=True, project="app", folder='"$HOME/x"')
    ]
    assert "working" in run(prov.stop("eden-box"))


def test_delete_asks_and_never_touches_handoff_work(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    hub.code_handoff.handoffs = [
        SimpleNamespace(alias="eden-box", live=False, project="app", folder='"$HOME/x"')
    ]
    assert "bring it back" in run(prov.delete("eden-box"))
    hub.code_handoff.handoffs = []
    hub.asked.clear()
    assert run(prov.delete("eden-box")) == "Deleted eden-box."
    assert "Delete eden-box?" in hub.asked[0][0] and "instances delete" in hub.asked[0][1]
    assert prov.record("eden-box") is None
    assert "eden-box" not in (prov.ssh_dir / "eden-cloud.conf").read_text()
    assert hub.code_handoff.removed == ["eden-box"]


def test_idle_stops_and_delete_only_when_set_and_free(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    rec = prov.record("eden-box")
    now = rec["last_used"] + 29 * 60
    assert run(prov.idle_once(now)) == []
    said = run(prov.idle_once(rec["last_used"] + 31 * 60))
    assert said == ["Stopped eden-box (idle for 30 minutes)."]
    # Delete when idle, but a hand-off's work there keeps it (only stopped).
    hub.features[code_provision.PREF_ACTION] = "delete"
    rec["state"] = "running"
    hub.code_handoff.handoffs = [
        SimpleNamespace(alias="eden-box", live=False, project="app", folder="x")
    ]
    assert run(prov.idle_once(rec["last_used"] + 31 * 60))[0].startswith("Stopped")
    hub.code_handoff.handoffs = []
    rec["state"] = "running"
    hub.asked.clear()
    assert run(prov.idle_once(rec["last_used"] + 31 * 60)) == ["Deleted eden-box."]
    assert hub.asked == []  # (the owner set it: no card)
    # Off: never.
    hub.features[code_provision.PREF_IDLE] = 0
    assert run(prov.idle_once(10**12)) == []


def test_a_live_handoff_counts_as_use(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    rec = prov.record("eden-box")
    hub.code_handoff.handoffs = [
        SimpleNamespace(alias="eden-box", live=True, project="app", folder="x")
    ]
    later = rec["last_used"] + 3600
    assert run(prov.idle_once(later)) == []
    assert rec["last_used"] == later


def test_wake_starts_a_stopped_machine_before_the_check(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    prov.wrap_desk()
    prov.wrap_desk()  # (once only)
    cli.state = "TERMINATED"
    cli.calls.clear()
    assert run(hub.code_handoff.check_machine("eden-box")) == ""
    assert any(c[:4] == ["gcloud", "compute", "instances", "start"] for c in cli.calls)
    assert hub.code_handoff.checked == ["eden-box"]
    # Not one of Eden's: straight to the check. Wake off: never started.
    cli.calls.clear()
    run(hub.code_handoff.check_machine("my-old-box"))
    assert cli.calls == []
    hub.features[code_provision.PREF_WAKE] = False
    run(hub.code_handoff.check_machine("eden-box"))
    assert not any("start" in c for c in cli.calls)


def test_warm_image_runs_setup_then_new_machines_start_from_it(setup):
    hub, prov, cli, _ = setup
    project = hub.tmp / "projects" / "app" / ".jarvis"
    project.mkdir(parents=True)
    (project / "setup.sh").write_text("npm ci\n")
    run(prov.create(run(prov.plan({"provider": "gcp", "alias": "eden-box"}))["id"]))
    hub.code_handoff.handoffs = [
        SimpleNamespace(
            alias="eden-box", live=False, project="app", folder='"$HOME/.jarvis-handoff/h1"'
        )
    ]
    hub.asked.clear()
    said = run(prov.env_save("eden-box", "app"))
    assert "Saved eden-app-gcp" in said and "is running" in said
    assert "npm ci" in hub.asked[0][1] and "images create eden-app-gcp" in hub.asked[0][1]
    setup_call = next(c for c in cli.calls if c[0].endswith("ssh") and "bash -s" in c[-1])
    assert ".jarvis-handoff/h1" in setup_call[-1]
    assert prov.env_for("app", "gcp")["image"] == "eden-app-gcp"
    plan = run(prov.plan({"provider": "gcp", "alias": "eden-next", "project": "app"}))
    assert plan["image"] == "eden-app-gcp" and any(
        "--image eden-app-gcp" in s for s in plan["steps"]
    )
    # The project's machine is the one its Cloud runs use.
    assert prov.for_project("app") == "eden-box"
    # Forgetting it deletes the image, after a card.
    assert run(prov.env_forget("app", "gcp")) == "Deleted the warm image for app."
    assert prov.env_for("app", "gcp") is None


def test_fly_needs_no_image(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "fly", "alias": "eden-fly"}))["id"]))
    assert "already warm" in run(prov.env_save("eden-fly", "app"))


def test_kept_across_restarts_and_published(setup):
    hub, prov, cli, _ = setup
    run(prov.create(run(prov.plan({"provider": "hetzner", "alias": "eden-box"}))["id"]))
    again = Provisioner(hub)
    assert again.record("eden-box")["provider"] == "hetzner"
    again.find_cli = lambda names: "" if names[0] == "tart" else names[0]
    again.ssh_dir = prov.ssh_dir
    again.publish()
    kind, data = hub.events[-1]
    assert kind == "code_provision"
    tart = next(p for p in data["providers"] if p["id"] == "tart")
    assert tart["installed"] is False and data["key"] is True
    assert data["machines"][0]["alias"] == "eden-box"


def test_install_registers_commands_and_the_idle_loop(tmp_path):
    hub = Hub(tmp_path)
    code_provision.install(hub)
    assert {"code_provision_plan", "code_provision_create", "code_provision_delete",
            "code_provision_env_save"} <= set(hub.commands)  # fmt: skip
    assert "code_provision_idle" in hub.loops
    assert getattr(hub.code_handoff.check_machine, "_woken", False)


def test_idle_pref_is_cleaned():
    from jarvis.prefs import FEATURE_PREFS

    clean = FEATURE_PREFS[code_provision.PREF_IDLE][1]
    assert clean(0) == 0 and clean(45) == 45 and clean(5) is None and clean(True) is None
    assert FEATURE_PREFS[code_provision.PREF_ACTION][1]("wipe") is None


def test_cloud_runs_in_a_project_go_to_its_own_machine(setup):
    from jarvis.features.code_cloud import Cloud

    hub, prov, cli, _ = setup
    run(
        prov.create(
            run(prov.plan({"provider": "gcp", "alias": "eden-box", "project": "app"}))["id"]
        )
    )
    hub.code_handoff.machines.append(SimpleNamespace(alias="jarvis-cloud", ok=True, problem=""))
    hub.code_provision = prov
    cloud = Cloud(hub)
    hub.features["code_cloud_machine"] = "jarvis-cloud"
    assert cloud.alias("/Users/me/Projects/app") == "eden-box"
    assert cloud.alias("/Users/me/Projects/other") == "jarvis-cloud"
    assert cloud.alias() == "jarvis-cloud"
