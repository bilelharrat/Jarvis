"""Eden Code: set up a cloud machine of the owner's own, from a template, in one click after
a plan they've read (cloud_templates.py has the templates; code_handoff.py and
code_cloud.py use the machine once it's made).

Cloud runs stay bring-your-own, on purpose: the machine is in the owner's account at a
provider they chose (or on this Mac), it runs their own Claude sign-in, and nothing of
theirs passes through anything Eden runs. What this adds is the setup, which used to be an
evening of reading docs:

- Templates for Google Cloud, AWS EC2, Hetzner, DigitalOcean, Fly.io Machines, and, free and
  on this Mac, Docker or OrbStack and a Tart VM. Each is the provider's own CLI (gcloud,
  aws, hcloud, doctl, flyctl, docker, tart), signed in with the owner's own login: Eden
  never asks for, sees or keeps a provider key. Settings › Machines says which CLIs are
  installed and signed in, and how to get or sign in to one that isn't.
- A plan before anything: picking a provider, size and region shows every command that
  would run, word for word, the first-boot script, and a cost estimate (an hour, a typical
  month, a month left on; list prices, marked as an estimate). AWS's create is run with
  --dry-run too (permissions and limits; it makes nothing). "Create" then puts up a card
  with the same plan and cost; only its yes runs anything.
- What it makes: the machine; a dedicated key on the Mac (~/.ssh/eden_cloud_ed25519, its
  private half never leaves the Mac); a Host block in ~/.ssh/eden-cloud.conf (Eden's own
  file, Included from ~/.ssh/config, which is otherwise left as it was); the machine added
  to Machines and, when no other is set, made the one Cloud runs use. The owner's last step
  is theirs: ssh to it once and sign Claude Code in to their own account.
- Cost caps: the machine's idle watchdog powers it off after the minutes set here with no
  Claude Code run and nobody connected (with the Mac shut too); while the Mac is on, the
  idle loop here stops (or, for providers that bill a machine while it's off and only when
  set, deletes) an Eden-made machine no hand-off has used for that long. Delete never
  touches a machine a hand-off's work is on (bring it back or forget it first).
- Wake on use: a stopped Eden-made machine a hand-off or a cloud start needs is started
  first (Settings can turn that off).
- Warm environments: "Save warm image" runs a project's own setup (.jarvis/setup.sh, the
  same text code_setup shows) in its checkout there, then saves the machine as an image;
  the next machine for that project starts from it, its dependencies already in. Fly's home
  volume stays between runs, so it's warm without one.

Window: code_provision_state {}, code_provision_check {provider},
code_provision_plan {provider, alias, region, size, project?}, code_provision_create {plan},
code_provision_start / _stop / _delete {alias}, code_provision_env_save {alias, project},
code_provision_env_forget {project, provider}.
Events: code_provision {providers, machines, envs, projects, key, busy},
code_provision_checked {provider, …}, code_provision_plan {…}.
Loop: code_provision_idle.

Cost policy: no model is called here. The machines are billed by their provider to the
owner's own account (the estimate says roughly what); Eden bills and meters none of it.
Tests never make anything: every CLI is faked.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import secrets
import shutil
import socket
import time
from pathlib import Path
from typing import Any

from .. import cloud_templates as ct
from .. import devcontainer, handoff, jsonstore
from ..packaged import owner_env
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

STORE = "code_provision"
jsonstore.register_store(STORE, 1)
PREF_IDLE = "code_provision_idle_minutes"
PREF_ACTION = "code_provision_idle_action"
PREF_WAKE = "code_provision_wake"
DEFAULT_IDLE = 30
IDLE_EVERY = 300.0  # seconds between the idle loop's looks
READY_WAIT = 900.0  # seconds for a new machine's first-boot setup to finish
READY_EVERY = 10.0
WAKE_WAIT = 300.0
CHECK_SECONDS = 20.0
PLANS_MAX = 20
INCLUDE = "Include ~/.ssh/eden-cloud.conf"


def _idle(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    n = int(value)
    return n if n == 0 or 10 <= n <= 1440 else None


register_feature_pref(PREF_IDLE, DEFAULT_IDLE, _idle)
register_feature_pref(PREF_ACTION, "stop", lambda v: v if v in ("stop", "delete") else None)
register_feature_pref(PREF_WAKE, True)


async def run_cli(argv: list[str], timeout: float, stdin_path: str = "") -> tuple[int, str, str]:
    """A CLI with the owner's own environment (their PATH and logins), its output and exit
    status. Never raises: missing, timed out or killed come back as a failure."""
    from .. import runproc

    handle = None
    try:
        if stdin_path:
            handle = open(stdin_path, "rb")  # noqa: SIM115 - closed below
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=handle or asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=owner_env(runproc.shell_env()),
            start_new_session=True,
        )
    except OSError as exc:
        if handle is not None:
            handle.close()
        return 127, "", str(exc)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        return 124, "", f"no answer in {timeout:.0f} s"
    finally:
        if handle is not None:
            handle.close()
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def spawn_cli(argv: list[str]) -> str:
    """Started and left running (a Tart VM's `tart run`): "" or why it couldn't start."""
    from .. import runproc

    try:
        await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=owner_env(runproc.shell_env()),
            start_new_session=True,
        )
    except OSError as exc:
        return str(exc)
    return ""


def find_cli(names: tuple[str, ...]) -> str:
    from .. import runproc

    path = runproc.shell_env().get("PATH") or os.environ.get("PATH", "")
    for name in names:
        found = shutil.which(name, path=path)
        if found:
            return found
    return ""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


# These cards make, delete or run things at a provider, or send a project to a machine off this
# Mac: marked for Touch ID, and only a tap on the Mac answers them (code_touchid.mac_only).
GATED_CARD = {"tool": "code_provision", "touchid": True, "tap_only": True}


class Provisioner:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.run = run_cli
        self.spawn = spawn_cli
        self.find_cli = find_cli
        self.free_port = free_port
        self.ssh_dir = Path("~/.ssh").expanduser()
        self.machines: list[dict[str, Any]] = []
        self.envs: list[dict[str, Any]] = []
        self.plans: dict[str, dict[str, Any]] = {}
        self.busy: dict[str, str] = {}  # alias -> what's being done to it
        self._loaded = False
        self._unreadable = False

    # ── kept ──

    @property
    def path(self) -> Path:
        return self.hub.feature_path("code_provision.json")

    @property
    def folder(self) -> Path:
        return self.hub.feature_path("code_provision")

    @property
    def key(self) -> Path:
        return self.ssh_dir / ct.KEY_NAME

    @property
    def conf(self) -> Path:
        return self.ssh_dir / "eden-cloud.conf"

    @property
    def known(self) -> Path:
        return self.ssh_dir / "eden-cloud.known_hosts"

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_store(self.path, STORE) or {}
        except jsonstore.Unreadable:
            log.warning("provision: %s can't be read; nothing is saved over it", self.path)
            self._unreadable = True
            data = {}
        self.machines = [
            m for m in data.get("machines") or []
            if isinstance(m, dict) and ct.NAME.match(str(m.get("alias") or ""))
            and m.get("provider") in ct.PROVIDERS
        ]  # fmt: skip
        self.envs = [
            e for e in data.get("envs") or []
            if isinstance(e, dict) and e.get("provider") in ct.PROVIDERS and e.get("image")
        ]  # fmt: skip

    def save(self) -> None:
        if self._unreadable:
            return
        try:
            jsonstore.save_store(self.path, STORE, {"machines": self.machines, "envs": self.envs})
        except OSError:
            log.warning("provision: couldn't save %s", self.path, exc_info=True)

    def record(self, alias: str) -> dict[str, Any] | None:
        self.load()
        return next((m for m in self.machines if m["alias"] == alias), None)

    def env_for(self, project: str, provider: str) -> dict[str, Any] | None:
        self.load()
        return next(
            (e for e in self.envs if e["project"] == project and e["provider"] == provider), None
        )

    def for_project(self, project: str) -> str:
        """The Eden-made machine kept for a project (its warm one), "" none: Cloud runs in
        that project go there."""
        self.load()
        desk = getattr(self.hub, "code_handoff", None)
        for m in self.machines:
            if m.get("project") == project and m.get("state") != "gone":
                if desk is None or desk.machine(m["alias"]) is not None:
                    return m["alias"]
        return ""

    def pref(self, key: str, default: Any) -> Any:
        value = self.hub.prefs.feature(key)
        return default if value is None else value

    def tr(self, text: str) -> str:
        desk = getattr(self.hub, "code_handoff", None)
        return desk.tr(text) if desk is not None else text

    # ── what the window sees ──

    def projects(self) -> list[str]:
        tm = getattr(self.hub, "tasks", None)
        try:
            return list(tm.projects()) if tm is not None and hasattr(tm, "projects") else []
        except OSError:
            return []

    def publish(self) -> None:
        self.load()
        self.hub.emit(
            "code_provision",
            providers=[
                p.public() | {"installed": bool(self.find_cli(p.clis))}
                for p in ct.PROVIDERS.values()
            ],
            machines=[m | {"busy": self.busy.get(m["alias"], "")} for m in self.machines],
            envs=list(self.envs),
            projects=self.projects(),
            key=self.key.with_suffix(".pub").is_file(),
            idle_minutes=self.pref(PREF_IDLE, DEFAULT_IDLE),
        )

    async def check_provider(self, provider_id: str) -> dict[str, Any]:
        """Installed? Signed in (and as whom)? Never makes or changes anything."""
        provider = ct.PROVIDERS.get(provider_id)
        if provider is None:
            return {"provider": provider_id, "problem": "Not a provider Eden has a template for."}
        cli = self.find_cli(provider.clis)
        out: dict[str, Any] = {"provider": provider.id, "installed": bool(cli), "signed_in": False}
        if not cli:
            out["problem"] = f"{provider.clis[0]} isn't installed. {provider.install}."
            return out
        code, said, err = await self.run([cli, *provider.signed_in[1:]], CHECK_SECONDS)
        said = said.strip()
        if code == 0 and said and said.lower() not in ("(unset)", "none"):
            out["signed_in"] = True
            out["account"] = said.splitlines()[0][:120] if provider.id != "aws" else ""
        else:
            out["problem"] = f"{provider.clis[0]} isn't signed in. {provider.login}."
        return out

    # ── the plan ──

    def _spec(self, msg: dict[str, Any]) -> tuple[ct.Spec, ct.Provider] | str:
        provider = ct.PROVIDERS.get(str(msg.get("provider") or ""))
        if provider is None:
            return "Pick a provider."
        project = str(msg.get("project") or "").strip()[:200]
        env = self.env_for(project, provider.id) if project else None
        spec = ct.Spec(
            provider=provider.id,
            alias=str(msg.get("alias") or "").strip(),
            region=str(msg.get("region") or provider.region).strip(),
            size=str(msg.get("size") or provider.sizes[0].id),
            image=str(env["image"]) if env else "",
            port=self.free_port() if provider.id == "docker" else 0,
        )
        if (
            env
            and env.get("region")
            and env["region"] != spec.region
            and provider.id in ("aws", "do")
        ):
            spec.image = ""  # (an AMI or snapshot is regional: the base image, then)
        why = ct.check(spec, provider)
        if why:
            return why
        if self.record(spec.alias) is not None:
            return f"Eden already made a machine called {spec.alias}."
        desk = getattr(self.hub, "code_handoff", None)
        if desk is not None and spec.alias in desk.config_hosts():
            return f"{spec.alias} is already a host in your SSH config: pick another name."
        return spec, provider

    def plan_text(self, plan: dict[str, Any]) -> str:
        lines = [
            f"{plan['provider_name']}: {plan['alias']}, {plan['size']} in {plan['region']}"
            + (f", from the warm image {plan['image']}" if plan.get("image") else ""),
            "",
            "Cost:",
            *(f"• {x}" for x in plan["estimate"]["lines"]),
            "",
            "Runs, with your own login:",
            *plan["steps"],
            "",
            "Then:",
            *(f"• {x}" for x in plan["finish"]),
        ]
        if plan["notes"]:
            lines += ["", *(f"• {x}" for x in plan["notes"])]
        return "\n".join(lines)

    async def plan(self, msg: dict[str, Any]) -> dict[str, Any]:
        """A dry run: what would run and what it would cost; nothing is made."""
        got = self._spec(msg)
        if isinstance(got, str):
            return {"problem": self.tr(got)}
        spec, provider = got
        checked = await self.check_provider(provider.id)
        size = provider.size(spec.size)
        assert size is not None
        idle = int(self.pref(PREF_IDLE, DEFAULT_IDLE))
        steps = ct.create_steps(spec, provider)
        keygen = not self.key.with_suffix(".pub").is_file()
        shown = [s.shown() for s in steps]
        if keygen:
            shown.insert(0, f"$ ssh-keygen -t ed25519 -N '' -C {ct.KEY_COMMENT} -f {self.key}")
        finish = [
            f"A Host block for {spec.alias} in {self.conf} (Included from ~/.ssh/config)",
            "Wait for its first-boot setup (git, tmux, Claude Code, the idle stop)",
            f"Add {spec.alias} to Machines",
            f"Your step: ssh {spec.alias}, run claude once and sign in to your Claude account",
        ]
        checks = []
        dry = ct.dry_run_step(spec, provider)
        if dry is not None and checked.get("signed_in"):
            cli = self.find_cli(provider.clis)
            code, out, err = await self.run([cli, *dry.argv[1:]], dry.timeout)
            ok = code == 0 or bool(re.search(dry.ok_if, out + err))
            checks.append({"label": dry.label, "ok": ok, "said": "" if ok else (err or out)[-400:]})
        plan_id = secrets.token_hex(6)
        plan = {
            "id": plan_id,
            "provider": provider.id,
            "provider_name": provider.name,
            "alias": spec.alias,
            "region": spec.region,
            "size": spec.size,
            "image": spec.image,
            "port": spec.port,
            "project": str(msg.get("project") or "").strip()[:200],
            "steps": shown,
            "finish": finish,
            "notes": list(provider.notes),
            "estimate": ct.estimate(provider, size, 0 if provider.bills_when_off else idle),
            "bootstrap": ct.bootstrap(
                "ssh-ed25519 " + "A" * 68 + " " + ct.KEY_COMMENT,
                0 if provider.bills_when_off else idle,
                "container" if provider.id in ("docker", "fly") else "vm",
            ).replace("A" * 68, "<your Eden key>"),
            "check": checked,
            "checks": checks,
            "problem": checked.get("problem", ""),
            "_spec": spec,
            "_keygen": keygen,
        }
        if len(self.plans) >= PLANS_MAX:
            self.plans.pop(next(iter(self.plans)))
        self.plans[plan_id] = plan
        return {k: v for k, v in plan.items() if not k.startswith("_")}

    # ── making it ──

    async def _steps(self, cli: str, steps: list[ct.Step], values: dict[str, str]) -> str:
        """Each step in turn, its captures into values: "" or what went wrong."""
        for step in steps:
            argv = ct.fill(step.argv, values)
            stdin = ct.fill([step.stdin_file], values)[0] if step.stdin_file else ""  # type: ignore[index]
            if argv is None or stdin is None:
                return f"{step.label}: something it needs wasn't found earlier."
            if argv[0] == step.argv[0] and argv[0] not in ("echo",):
                argv[0] = cli
            if step.spawn:
                said = await self.spawn(argv)
                if said:
                    return f"{step.label}: {said}"
                continue
            code, out, err = await self.run(argv, step.timeout, stdin)
            if code != 0 and not (step.ok_if and re.search(step.ok_if, out + err)):
                return f"{step.label} failed: {(err or out).strip()[-600:] or f'exit {code}'}"
            if step.capture and code == 0:
                got = ct.capture(step.capture, out)
                if not got:
                    return f"{step.label}: its answer didn't say what was needed."
                values.update(got)
        return ""

    async def _key(self) -> str:
        """The dedicated key, made on first use: its public line, or "" (couldn't)."""
        pub = self.key.with_suffix(".pub")
        if not pub.is_file():
            self.ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            code, _out, err = await self.run(
                [
                    "ssh-keygen",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-C",
                    ct.KEY_COMMENT,
                    "-f",
                    str(self.key),
                ],
                30.0,
            )
            if code != 0 or not pub.is_file():
                log.warning("provision: ssh-keygen failed: %s", err)
                return ""
        line = " ".join(pub.read_text(encoding="utf-8", errors="replace").split())
        return line if ct.PUBKEY.match(line) else ""

    async def create(self, plan_id: str) -> str:
        plan = self.plans.get(str(plan_id or ""))
        if plan is None:
            return "That plan has gone: plan it again."
        spec: ct.Spec = plan["_spec"]
        provider = ct.PROVIDERS[spec.provider]
        if self.record(spec.alias) is not None:
            return f"Eden already made a machine called {spec.alias}."
        cli = self.find_cli(provider.clis)
        if not cli:
            return f"{provider.clis[0]} isn't installed. {provider.install}."
        question = self.tr(f"Make {spec.alias} on {provider.name}?")
        estimate = plan["estimate"]
        if not provider.local:
            question = self.tr(
                f"Make {spec.alias} on {provider.name} (about ${estimate['hourly']:.3f} an hour)?"
            )
        choice = await self.hub.request_approval(
            question,
            self.tr(self.plan_text(plan)),
            [("go", self.tr("Create it")), ("deny", self.tr("Not now"))],
            context=GATED_CARD,
        )
        if choice != "go":
            return "Nothing was made."
        self.plans.pop(plan["id"], None)
        self.busy[spec.alias] = "Creating…"
        self.publish()
        try:
            return await self._create(spec, provider, cli, plan.get("project", ""))
        finally:
            self.busy.pop(spec.alias, None)
            self.publish()

    async def _create(self, spec: ct.Spec, provider: ct.Provider, cli: str, project: str) -> str:
        pubkey = await self._key()
        if not pubkey:
            return f"Couldn't make the Eden key at {self.key}: nothing was made."
        folder = self.folder / spec.alias
        folder.mkdir(parents=True, exist_ok=True)
        idle = 0 if provider.bills_when_off else int(self.pref(PREF_IDLE, DEFAULT_IDLE))
        script = folder / "bootstrap.sh"
        script.write_text(
            ct.bootstrap(pubkey, idle, "container" if provider.id in ("docker", "fly") else "vm"),
            encoding="utf-8",
        )
        script.chmod(0o644)  # (read inside a container as root; nothing secret in it)
        rec: dict[str, Any] = {
            "alias": spec.alias, "provider": provider.id, "region": spec.region,
            "size": spec.size, "image": spec.image, "port": spec.port, "id": "", "ip": "",
            "project": project, "state": "creating", "created": time.time(),
            "last_used": time.time(), "problem": "",
        }  # fmt: skip
        self.machines.append(rec)
        self.save()
        values = {
            "bootstrap": str(script),
            "pubkey_file": str(self.key.with_suffix(".pub")),
            "key_fingerprint": ct.do_fingerprint(pubkey),
            "port": str(spec.port),
        }
        failed = await self._steps(cli, ct.create_steps(spec, provider), values)
        rec["id"] = values.get("id", "")
        rec["ip"] = values.get("ip", "")
        if failed:
            rec["state"], rec["problem"] = "failed", failed
            self.save()
            return (
                f"{failed} Anything it made is still there: Delete in Settings › Machines "
                "removes it."
            )
        rec["state"] = "running"
        self.write_ssh(rec)
        ready = await self.wait_ready(spec.alias)
        if ready:
            rec["problem"] = ready
            self.save()
            return f"{spec.alias} was made, but {ready}"
        said = f"{spec.alias} is ready on {provider.name}."
        desk = getattr(self.hub, "code_handoff", None)
        if desk is not None:
            added = await desk.add_machine(spec.alias)
            if added and not added.endswith("is ready."):
                said = f"{spec.alias} was made. {added}"
        self._use_for_cloud(spec.alias)
        self.save()
        return said + f" Your step: ssh {spec.alias}, run claude once and sign in."

    def _use_for_cloud(self, alias: str) -> None:
        """Cloud runs use it when the machine Settings names isn't there."""
        desk = getattr(self.hub, "code_handoff", None)
        current = str(self.hub.prefs.feature("code_cloud_machine") or "")
        if desk is not None and current and desk.machine(current) is not None:
            return
        setter = getattr(self.hub, "set_feature_prefs", None)
        if setter is not None:
            setter({"code_cloud_machine": alias})

    async def wait_ready(self, alias: str, wait: float | None = None) -> str:
        """Until its first-boot setup is done: "" or why not."""
        wait = READY_WAIT if wait is None else wait
        ssh = handoff.ssh_binary()
        waited, said = 0.0, ""
        while True:
            code, _out, err = await self.run(
                [
                    ssh,
                    *handoff.SSH_OPTIONS,
                    alias,
                    handoff.remote_command(f"test -f {ct.READY_FILE}"),
                ],
                30.0,
            )
            if code == 0:
                return ""
            said = err.strip()[-300:]
            if waited >= wait:
                break
            await asyncio.sleep(READY_EVERY)
            waited += READY_EVERY
        return (
            f"its first-boot setup hadn't finished after {wait / 60:.0f} minutes"
            + (f" ({said})" if said else "")
            + ". Test it in Machines in a while."
        )

    # ── the SSH config ──

    def write_ssh(self, rec: dict[str, Any]) -> None:
        """Its Host block in Eden's own file (others there kept), and that file Included at
        the top of ~/.ssh/config (once; the rest of the owner's config untouched)."""
        provider = ct.PROVIDERS[rec["provider"]]
        spec = ct.Spec(rec["provider"], rec["alias"], rec.get("region", ""), rec.get("size", ""),
                       port=int(rec.get("port") or 0))  # fmt: skip
        block = ct.ssh_block(
            rec["alias"], ct.ssh_target(spec, provider, rec.get("ip", "")), str(self.key),
            str(self.known), provider.id,
        )  # fmt: skip
        blocks = self._blocks()
        blocks[rec["alias"]] = block
        self._write_blocks(blocks)
        config = self.ssh_dir / "config"
        text = config.read_text(encoding="utf-8", errors="replace") if config.is_file() else ""
        if not any(line.strip() == INCLUDE for line in text.splitlines()):
            # At the top: an Include after a Host line would only apply inside that host.
            head = f"# Eden Code's cloud machines (Eden writes only that file).\n{INCLUDE}\n\n"
            config.write_text(head + text, encoding="utf-8")
            config.chmod(0o600)
        self._forget_host_key(rec)

    def _blocks(self) -> dict[str, str]:
        if not self.conf.is_file():
            return {}
        out: dict[str, str] = {}
        current, lines = "", []
        for line in self.conf.read_text(encoding="utf-8", errors="replace").splitlines(True):
            if line.startswith("# Eden Code cloud machine") and lines and current:
                out[current] = "".join(lines)
                current, lines = "", []
            if line.startswith("Host "):
                current = line.split()[1]
            lines.append(line)
        if current:
            out[current] = "".join(lines)
        return out

    def _write_blocks(self, blocks: dict[str, str]) -> None:
        self.ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.conf.write_text(
            "\n".join(b.rstrip("\n") + "\n" for b in blocks.values()), encoding="utf-8"
        )
        self.conf.chmod(0o600)

    def _forget_host_key(self, rec: dict[str, Any]) -> None:
        """A machine started again (or a new one at an old address) has a key the known-hosts
        file would refuse: Eden's own file forgets that address (the owner's isn't touched)."""
        if not self.known.is_file():
            return
        host = (
            "[127.0.0.1]:" + str(rec.get("port"))
            if rec["provider"] == "docker"
            else rec.get("ip", "")
        )
        if not host:
            return
        kept = [
            line for line in self.known.read_text(encoding="utf-8", errors="replace").splitlines(True)
            if host not in line.split(" ", 1)[0].split(",")
        ]  # fmt: skip
        self.known.write_text("".join(kept), encoding="utf-8")

    def _remove_ssh(self, alias: str) -> None:
        blocks = self._blocks()
        if blocks.pop(alias, None) is not None:
            self._write_blocks(blocks)

    # ── start, stop, delete ──

    def _cli_for(self, rec: dict[str, Any]) -> str:
        return self.find_cli(ct.PROVIDERS[rec["provider"]].clis)

    async def status(self, rec: dict[str, Any]) -> str:
        cli = self._cli_for(rec)
        if not cli:
            return ""
        step = ct.status_step(rec)
        code, out, err = await self.run([cli, *step.argv[1:]], step.timeout)
        return ct.parse_status(rec["provider"], code, out, err, rec["alias"])

    async def start(self, alias: str) -> str:
        rec = self.record(alias)
        if rec is None:
            return f"{alias} isn't a machine Eden made."
        cli = self._cli_for(rec)
        if not cli:
            return f"{ct.PROVIDERS[rec['provider']].clis[0]} isn't installed."
        values = {"ip": rec.get("ip", "")}
        self.busy[alias] = "Starting…"
        self.publish()
        try:
            failed = await self._steps(cli, ct.start_steps(rec), values)
            if failed:
                rec["problem"] = failed
                self.save()
                return failed
            rec["ip"] = values.get("ip") or rec.get("ip", "")
            rec.update(state="running", last_used=time.time(), problem="")
            self.write_ssh(rec)
            self.save()
            ready = await self.wait_ready(alias, WAKE_WAIT)
            return f"{alias} is running." if not ready else f"{alias} started, but {ready}"
        finally:
            self.busy.pop(alias, None)
            self.publish()

    async def stop(self, alias: str, why: str = "") -> str:
        rec = self.record(alias)
        if rec is None:
            return f"{alias} isn't a machine Eden made."
        live = self._live_handoff(alias)
        if live and not why:
            return f"A session is working on {alias}: stop it or bring it back first."
        cli = self._cli_for(rec)
        if not cli:
            return f"{ct.PROVIDERS[rec['provider']].clis[0]} isn't installed."
        self.busy[alias] = "Stopping…"
        self.publish()
        try:
            failed = await self._steps(cli, ct.stop_steps(rec), {})
            if failed:
                return failed
            rec["state"] = "stopped"
            self.save()
            bills = ct.PROVIDERS[rec["provider"]].bills_when_off
            return (
                f"Stopped {alias}"
                + (why and f" ({why})")
                + (". Its provider still bills it while it's off." if bills else ".")
            )
        finally:
            self.busy.pop(alias, None)
            self.publish()

    def _live_handoff(self, alias: str) -> bool:
        desk = getattr(self.hub, "code_handoff", None)
        return bool(desk is not None and any(r.alias == alias and r.live for r in desk.handoffs))

    def _held(self, alias: str) -> bool:
        """A hand-off's work is on it (running, or not brought back): never deleted."""
        desk = getattr(self.hub, "code_handoff", None)
        return bool(desk is not None and any(r.alias == alias for r in desk.handoffs))

    async def delete(self, alias: str, asked: bool = True) -> str:
        rec = self.record(alias)
        if rec is None:
            return f"{alias} isn't a machine Eden made."
        if self._held(alias):
            return (
                f"A hand-off's work is on {alias}: bring it back (or forget it) in Machines "
                "first, so nothing is lost."
            )
        cli = self._cli_for(rec)
        if not cli:
            return f"{ct.PROVIDERS[rec['provider']].clis[0]} isn't installed."
        steps = ct.delete_steps(rec)
        if asked:
            detail = "\n".join(
                [
                    "Deletes, with your own login:",
                    *(s.shown() for s in steps),
                    "",
                    f"Also removes its Host block from {self.conf} and {alias} from Machines.",
                    "Anything on it that isn't in a warm image or brought back is gone.",
                ]
            )
            choice = await self.hub.request_approval(
                self.tr(f"Delete {alias}?"),
                self.tr(detail),
                [("go", self.tr("Delete it")), ("deny", self.tr("Keep it"))],
                context=GATED_CARD,
            )
            if choice != "go":
                return f"Kept {alias}."
        self.busy[alias] = "Deleting…"
        self.publish()
        try:
            failed = await self._steps(cli, steps, {})
            if failed and await self.status(rec) != "gone":
                rec["problem"] = failed
                self.save()
                return failed
            self.machines.remove(rec)
            self.save()
            self._remove_ssh(alias)
            desk = getattr(self.hub, "code_handoff", None)
            if desk is not None:
                desk.remove_machine(alias)
            with contextlib.suppress(OSError):
                shutil.rmtree(self.folder / alias)
            return f"Deleted {alias}."
        finally:
            self.busy.pop(alias, None)
            self.publish()

    # ── warm environments ──

    def _checkout_on(self, alias: str, project: str) -> str:
        """A hand-off checkout of the project on that machine (its folder there), or ""."""
        desk = getattr(self.hub, "code_handoff", None)
        if desk is None:
            return ""
        rec = next((r for r in desk.handoffs if r.alias == alias and r.project == project), None)
        return f"{rec.folder}/repo" if rec is not None else ""

    async def env_save(self, alias: str, project: str) -> str:
        rec = self.record(alias)
        project = str(project or "").strip()
        if rec is None:
            return f"{alias} isn't a machine Eden made."
        provider = ct.PROVIDERS[rec["provider"]]
        if not provider.images:
            return f"{provider.name} keeps its home volume between runs, so it's already warm."
        if not project:
            return "Pick the project the warm image is for."
        if self._live_handoff(alias):
            return f"A session is working on {alias}: wait for it, or bring it back, first."
        cli = self._cli_for(rec)
        if not cli:
            return f"{provider.clis[0]} isn't installed."
        tm = getattr(self.hub, "tasks", None)
        setup = None
        if tm is not None and hasattr(tm, "project_path"):
            setup, _why = devcontainer.read_setup(tm.project_path(project))
        checkout = self._checkout_on(alias, project) if setup is not None else ""
        name = ct.image_name(project, provider.id)
        steps = ct.image_steps(rec, name)
        restart = any(s.label.startswith(("Stop", "Power", "Shut")) for s in steps)
        detail = [f"A warm image of {alias} for {project}: the next machine for it starts from it."]
        if setup is not None and checkout:
            detail += [
                "",
                f"First runs the project's setup ({setup.source}) in its checkout there:",
                setup.text[:2000],
            ]
        elif setup is not None:
            detail += [
                "",
                f"The project's setup ({setup.source}) can't run first: no hand-off of it on {alias} yet.",
            ]
        detail += ["", "Then, with your own login:", *(s.shown() for s in steps)]
        if restart:
            detail.append(f"Then starts {alias} again.")
        old = self.env_for(project, provider.id)
        if old is not None:
            detail.append(
                f"Replaces the warm image {old['image']} (kept at the provider: delete it there)."
            )
        detail.append("A provider keeps an image for a small monthly storage charge.")
        choice = await self.hub.request_approval(
            self.tr(f"Save {alias} as the warm image for {project}?"),
            self.tr("\n".join(detail)),
            [("go", self.tr("Save it")), ("deny", self.tr("Not now"))],
            context=GATED_CARD,
        )
        if choice != "go":
            return "Nothing was saved."
        self.busy[alias] = "Saving the warm image…"
        self.publish()
        try:
            if setup is not None and checkout:
                folder = self.folder / alias
                folder.mkdir(parents=True, exist_ok=True)
                script = folder / "setup.sh"
                script.write_text(setup.text, encoding="utf-8")
                ssh = handoff.ssh_binary()
                code, out, err = await self.run(
                    [
                        ssh,
                        *handoff.SSH_OPTIONS,
                        alias,
                        handoff.remote_command(f"cd {checkout} && bash -s"),
                    ],
                    1800.0,
                    str(script),
                )
                if code != 0:
                    return f"The project's setup failed there, so no image was saved: {(err or out).strip()[-400:]}"
            values: dict[str, str] = {}
            failed = await self._steps(cli, steps, values)
            if restart:
                rec["state"] = "stopped"
                self.save()
            if failed:
                return failed
            env = {
                "project": project, "provider": provider.id, "region": rec.get("region", ""),
                "image": values["image"], "alias": alias, "made": time.time(),
                "setup": setup.fingerprint if setup is not None else "",
            }  # fmt: skip
            self.envs = [
                e
                for e in self.envs
                if not (e["project"] == project and e["provider"] == provider.id)
            ]
            self.envs.append(env)
            rec["project"] = project
            self.save()
            said = f"Saved {values['image']} as the warm image for {project}."
            if restart:
                said += " " + await self.start(alias)
            return said
        finally:
            self.busy.pop(alias, None)
            self.publish()

    async def env_forget(self, project: str, provider_id: str) -> str:
        env = self.env_for(project, provider_id)
        if env is None:
            return "There's no warm image for that."
        provider = ct.PROVIDERS[provider_id]
        steps = ct.image_delete_steps(env)
        choice = await self.hub.request_approval(
            self.tr(f"Delete the warm image for {project}?"),
            self.tr("\n".join(["Deletes, with your own login:", *(s.shown() for s in steps)])),
            [("go", self.tr("Delete it")), ("deny", self.tr("Keep it"))],
            context=GATED_CARD,
        )
        if choice != "go":
            return "Kept it."
        cli = self.find_cli(provider.clis)
        failed = (
            await self._steps(cli, steps, {}) if cli else f"{provider.clis[0]} isn't installed."
        )
        if failed:
            return failed
        self.envs.remove(env)
        self.save()
        self.publish()
        return f"Deleted the warm image for {project}."

    # ── idle and wake ──

    async def idle_once(self, now: float | None = None) -> list[str]:
        """Each running Eden-made machine no hand-off has used for the minutes set: stopped
        (or deleted, when set, if nothing of a hand-off's is on it). What it did."""
        self.load()
        now = time.time() if now is None else now
        minutes = int(self.pref(PREF_IDLE, DEFAULT_IDLE))
        action = self.pref(PREF_ACTION, "stop")
        said = []
        for rec in list(self.machines):
            alias = rec["alias"]
            if rec.get("state") != "running" or alias in self.busy:
                continue
            if self._live_handoff(alias):
                rec["last_used"] = now
                continue
            if not minutes or now - float(rec.get("last_used") or now) < minutes * 60:
                continue
            why = f"idle for {minutes} minutes"
            if action == "delete" and not self._held(alias):
                said.append(await self.delete(alias, asked=False))
            else:
                said.append(await self.stop(alias, why))
        if said:
            self.save()
        return said

    async def idle_loop(self) -> None:
        while True:
            await asyncio.sleep(IDLE_EVERY)
            try:
                for line in await self.idle_once():
                    self.hub.emit("toast", title=self.tr("Eden Code"), text=self.tr(line))
            except Exception:  # noqa: BLE001 - the loop must outlive one bad look
                log.warning("provision: idle look failed", exc_info=True)

    async def wake(self, alias: str) -> str:
        """A stopped Eden-made machine something needs, started: "" (ready, or not Eden's),
        else why it couldn't."""
        rec = self.record(alias)
        if rec is None or not self.pref(PREF_WAKE, True) or alias in self.busy:
            return ""
        state = await self.status(rec)
        if state == "running":
            rec["last_used"] = time.time()
            if rec.get("state") != "running":
                rec["state"] = "running"
                self.save()
            return ""
        if state != "stopped":
            return ""
        said = await self.start(alias)
        return "" if said.endswith("is running.") else said

    def wrap_desk(self) -> None:
        """The hand-offs' machine check wakes an Eden-made machine first."""
        desk = getattr(self.hub, "code_handoff", None)
        if desk is None or getattr(desk.check_machine, "_woken", False):
            return
        inner = desk.check_machine

        async def check_machine(alias: str) -> str:
            woke = await self.wake(alias)
            return woke or await inner(alias)

        check_machine._woken = True  # type: ignore[attr-defined]
        desk.check_machine = check_machine

    # ── window commands ──

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    async def cmd_check(self, msg: dict[str, Any]) -> None:
        self.hub.emit(
            "code_provision_checked", **(await self.check_provider(str(msg.get("provider") or "")))
        )

    async def cmd_plan(self, msg: dict[str, Any]) -> None:
        self.hub.emit("code_provision_plan", **(await self.plan(msg)))

    async def _toast(self, said: str) -> None:
        self.hub.emit("toast", title=self.tr("Eden Code"), text=self.tr(said))
        self.publish()

    async def cmd_create(self, msg: dict[str, Any]) -> None:
        await self._toast(await self.create(str(msg.get("plan") or "")))

    async def cmd_start(self, msg: dict[str, Any]) -> None:
        await self._toast(await self.start(str(msg.get("alias") or "")))

    async def cmd_stop(self, msg: dict[str, Any]) -> None:
        await self._toast(await self.stop(str(msg.get("alias") or "")))

    async def cmd_delete(self, msg: dict[str, Any]) -> None:
        await self._toast(await self.delete(str(msg.get("alias") or "")))

    async def cmd_env_save(self, msg: dict[str, Any]) -> None:
        await self._toast(
            await self.env_save(str(msg.get("alias") or ""), str(msg.get("project") or ""))
        )

    async def cmd_env_forget(self, msg: dict[str, Any]) -> None:
        await self._toast(
            await self.env_forget(str(msg.get("project") or ""), str(msg.get("provider") or ""))
        )


def install(hub: Any) -> None:
    prov = Provisioner(hub)
    hub.code_provision = prov
    prov.wrap_desk()  # (code_handoff installs before this module: name order)
    hub.register_command("code_provision_state", prov.cmd_state)
    hub.register_command("code_provision_check", prov.cmd_check, slow=True)
    hub.register_command("code_provision_plan", prov.cmd_plan, slow=True)
    hub.register_command("code_provision_create", prov.cmd_create, slow=True)
    hub.register_command("code_provision_start", prov.cmd_start, slow=True)
    hub.register_command("code_provision_stop", prov.cmd_stop, slow=True)
    hub.register_command("code_provision_delete", prov.cmd_delete, slow=True)
    hub.register_command("code_provision_env_save", prov.cmd_env_save, slow=True)
    hub.register_command("code_provision_env_forget", prov.cmd_env_forget, slow=True)
    hub.register_loop("code_provision_idle", prov.idle_loop)
