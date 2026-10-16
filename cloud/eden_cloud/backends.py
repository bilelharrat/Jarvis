"""Where a run's container or VM comes from: one isolated machine per run, pluggable.

Every backend does the same three things, and nothing else: start the runner image with the
run's environment (its id, the address it calls back on, its one-run token, and the user's
Anthropic key), stop it (which deletes it, and with it the run's workspace: nothing of a run is
kept on the machine), and say whether it's still alive. The runner talks to the service over
HTTPS for everything else (runner/eden_runner.py), so a backend needs no shared disk, no
volume and no way into the machine: that's what makes Fly Machines, Cloud Run and Fargate
interchangeable with local Docker.

- docker: local Docker, for development. Hardened as far as plain Docker goes: non-root,
  no capabilities, no new privileges, read-only root, the workspace on a tmpfs, CPU, memory
  and process caps, and --rm. The key goes in by an --env-file (0600, in a private folder,
  deleted as soon as the container is started), never on the command line.
- fly: Fly Machines (one machine per run, auto-destroyed when it exits). Written to the
  Machines API; not tried against Fly (no account chosen yet).
- gcp, aws: stubs that say what they'd use (Cloud Run jobs; ECS RunTask on Fargate), for
  when the owner picks a provider.
- fake: in-process, for the tests.

Cost policy: no model is called here. The machines are the owner's bill (per second on Fly,
Cloud Run and Fargate), which is why the service caps minutes per run and per day.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class BackendNotReady(Exception):
    """The backend can't start runs as configured (its words say what's missing)."""


@dataclass
class Launch:
    run_id: str
    image: str
    env: dict[str, str] = field(repr=False)  # holds the user's key: never logged
    cpus: float = 2.0
    memory_mb: int = 4096
    max_minutes: int = 30

    @property
    def name(self) -> str:
        return f"eden-run-{self.run_id}"

    def checked_env(self) -> dict[str, str]:
        for key, value in self.env.items():
            if not ENV_KEY.match(key) or "\n" in value or "\r" in value or "\0" in value:
                raise ValueError(f"bad environment entry {key!r}")
        return self.env


class Backend:
    name = ""

    async def start(self, launch: Launch) -> str:
        raise NotImplementedError

    async def stop(self, handle: str) -> None:
        raise NotImplementedError

    async def alive(self, handle: str) -> bool | None:
        """True running, False gone (or ended), None couldn't tell (try again later)."""
        raise NotImplementedError

    async def aclose(self) -> None:
        return None


# ── local Docker ──

Runner = Callable[[list[str]], Awaitable[tuple[int, str, str]]]


async def run_command(args: list[str]) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


class DockerBackend(Backend):
    name = "docker"

    def __init__(self, docker: str = "docker", run: Runner = run_command) -> None:
        self.docker = docker
        self.run = run

    def args(self, launch: Launch, env_file: str) -> list[str]:
        if not NAME.match(launch.name):
            raise ValueError("bad run name")
        cpus = f"{launch.cpus:g}"
        memory = f"{launch.memory_mb}m"
        return [
            self.docker, "run", "-d", "--rm",
            "--name", launch.name,
            "--label", "eden-cloud=run",
            "--env-file", env_file,
            "--user", "1000:1000",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,size=1g",
            "--tmpfs", "/work:rw,exec,nosuid,size=8g,uid=1000,gid=1000",
            "--tmpfs", "/home/runner:rw,nosuid,size=512m,uid=1000,gid=1000",
            "--cpus", cpus,
            "--memory", memory,
            "--memory-swap", memory,
            "--pids-limit", "1024",
            "--add-host", "host.docker.internal:host-gateway",
            launch.image,
        ]  # fmt: skip

    async def start(self, launch: Launch) -> str:
        if shutil.which(self.docker) is None and self.run is run_command:
            raise BackendNotReady("Docker isn't installed here.")
        env = launch.checked_env()
        folder = tempfile.mkdtemp(prefix="eden-cloud-env-")
        os.chmod(folder, 0o700)
        env_file = str(Path(folder) / "env")
        try:
            fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.writelines(f"{k}={v}\n" for k, v in env.items())
            code, out, err = await self.run(self.args(launch, env_file))
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        if code != 0:
            raise BackendNotReady(f"docker run failed: {err.strip()[-300:]}")
        return launch.name

    async def stop(self, handle: str) -> None:
        if NAME.match(handle):
            await self.run([self.docker, "rm", "-f", handle])

    async def alive(self, handle: str) -> bool | None:
        if not NAME.match(handle):
            return False
        code, out, err = await self.run(
            [self.docker, "inspect", "-f", "{{.State.Running}}", handle]
        )
        if code != 0:
            return False if "No such" in err or "no such" in err else None
        return out.strip() == "true"


# ── Fly Machines ──


class FlyBackend(Backend):
    """One Fly Machine per run, in the owner's Fly app, auto-destroyed when the runner exits.
    The machine's env holds the key: anyone with that app's Fly token can read machine
    configs, so the token stays the service's alone (an owner step)."""

    name = "fly"
    API = "https://api.machines.dev/v1"

    def __init__(self, app: str, token: str, region: str = "", transport: Any = None) -> None:
        if not app or not token:
            raise BackendNotReady("Set EDEN_CLOUD_FLY_APP and EDEN_CLOUD_FLY_TOKEN first.")
        self.app, self.region = app, region
        self.http = httpx.AsyncClient(
            base_url=self.API,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
            transport=transport,
        )

    def body(self, launch: Launch) -> dict[str, Any]:
        config: dict[str, Any] = {
            "image": launch.image,
            "env": launch.checked_env(),
            "guest": {
                "cpu_kind": "shared",
                "cpus": max(1, int(round(launch.cpus))),
                "memory_mb": launch.memory_mb,
            },
            "auto_destroy": True,
            "restart": {"policy": "no"},
            "metadata": {"eden-cloud": "run"},
        }
        body: dict[str, Any] = {"name": launch.name, "config": config}
        if self.region:
            body["region"] = self.region
        return body

    async def start(self, launch: Launch) -> str:
        response = await self.http.post(f"/apps/{self.app}/machines", json=self.body(launch))
        if response.status_code >= 300:
            raise BackendNotReady(f"Fly said {response.status_code}: {response.text[:300]}")
        machine = str((response.json() or {}).get("id") or "")
        if not re.match(r"^[0-9a-z]{6,40}$", machine):
            raise BackendNotReady("Fly didn't say which machine it made.")
        return machine

    async def stop(self, handle: str) -> None:
        if re.match(r"^[0-9a-z]{6,40}$", handle):
            await self.http.delete(f"/apps/{self.app}/machines/{handle}", params={"force": "true"})

    async def alive(self, handle: str) -> bool | None:
        try:
            response = await self.http.get(f"/apps/{self.app}/machines/{handle}")
        except httpx.HTTPError:
            return None
        if response.status_code == 404:
            return False
        if response.status_code >= 300:
            return None
        state = str((response.json() or {}).get("state") or "")
        return state in ("created", "starting", "started", "replacing")

    async def aclose(self) -> None:
        await self.http.aclose()


# ── not built yet ──


class GcpBackend(Backend):
    """Google Cloud: a Cloud Run job (the runner image), one execution per run with
    overrides for its env and task timeout (max_minutes); the key would better go in by
    Secret Manager than in the overrides. Not built: the owner hasn't chosen a provider."""

    name = "gcp"

    def __init__(self, **_kw: Any) -> None:
        raise BackendNotReady(
            "Google Cloud isn't built yet: a Cloud Run job per run (jobs.run with overrides)."
        )


class AwsBackend(Backend):
    """AWS: ECS RunTask on Fargate (the runner image as the task definition), containerOverrides
    for the env, a stopTask for cancel and the time limit. Not built: no provider chosen yet."""

    name = "aws"

    def __init__(self, **_kw: Any) -> None:
        raise BackendNotReady("AWS isn't built yet: ECS RunTask on Fargate per run.")


# ── the tests' ──


class FakeBackend(Backend):
    """Runs nothing: on_start(launch) is called (it may start a simulated runner), and the
    machine is alive until stopped or marked gone."""

    name = "fake"

    def __init__(self, on_start: Callable[[Launch], Any] | None = None) -> None:
        self.on_start = on_start
        self.started: list[Launch] = []
        self.stopped: list[str] = []
        self.live: dict[str, bool] = {}
        self.fail = ""

    async def start(self, launch: Launch) -> str:
        if self.fail:
            raise BackendNotReady(self.fail)
        self.started.append(launch)
        self.live[launch.name] = True
        if self.on_start is not None:
            result = self.on_start(launch)
            if asyncio.iscoroutine(result):
                await result
        return launch.name

    async def stop(self, handle: str) -> None:
        self.stopped.append(handle)
        self.live[handle] = False

    async def alive(self, handle: str) -> bool | None:
        return self.live.get(handle, False)


def make(settings: Any) -> Backend:
    kind = settings.backend
    if kind == "docker":
        return DockerBackend()
    if kind == "fly":
        return FlyBackend(settings.fly_app, settings.fly_token, settings.fly_region)
    if kind == "gcp":
        return GcpBackend()
    if kind == "aws":
        return AwsBackend()
    if kind == "fake":
        return FakeBackend()
    raise BackendNotReady(f"No backend called {kind!r}.")


async def stop_quietly(backend: Backend, handle: str) -> None:
    if handle:
        with contextlib.suppress(Exception):
            await backend.stop(handle)
