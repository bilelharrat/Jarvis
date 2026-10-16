"""The backends without their clouds: Docker's command (faked), Fly's API calls (a mock
transport), and the stubs."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from eden_cloud import backends
from eden_cloud.backends import (
    AwsBackend,
    BackendNotReady,
    DockerBackend,
    FlyBackend,
    GcpBackend,
    Launch,
)
from eden_cloud.config import Settings
from fakes import KEY


def launch(**env):
    return Launch(
        run_id="0123456789abcdef",
        image="eden-cloud-runner:dev",
        env={"EDEN_RUN_ID": "0123456789abcdef", "ANTHROPIC_API_KEY": KEY, **env},
        cpus=2,
        memory_mb=2048,
    )


async def test_docker_runs_hardened_and_the_key_never_on_the_command_line():
    calls, files = [], []

    async def run(args):
        calls.append(args)
        if args[1] == "run":
            env_file = Path(args[args.index("--env-file") + 1])
            files.append(env_file)
            assert oct(env_file.stat().st_mode & 0o777) == "0o600"
            assert f"ANTHROPIC_API_KEY={KEY}" in env_file.read_text()
            return 0, "abc\n", ""
        if args[1] == "inspect":
            return 0, "true\n", ""
        return 0, "", ""

    docker = DockerBackend(run=run)
    handle = await docker.start(launch())
    assert handle == "eden-run-0123456789abcdef"
    args = calls[0]
    assert KEY not in " ".join(args)
    for flag in (
        "--rm",
        "--read-only",
        "--cap-drop",
        "no-new-privileges",
        "--pids-limit",
        "--memory-swap",
    ):
        assert flag in args
    assert args[args.index("--user") + 1] == "1000:1000"
    assert not files[0].exists() and not files[0].parent.exists()  # deleted once started
    assert await docker.alive(handle) is True
    await docker.stop(handle)
    assert calls[-1][1:3] == ["rm", "-f"]


async def test_docker_refuses_bad_names_and_env():
    async def run(args):
        return 0, "", ""

    docker = DockerBackend(run=run)
    with pytest.raises(ValueError):
        await docker.start(launch(EVIL="a\nANTHROPIC_BASE_URL=http://evil"))
    assert await docker.alive("../etc") is False


async def test_docker_failure_is_said():
    async def run(args):
        return 125, "", "Unable to find image"

    with pytest.raises(BackendNotReady, match="find image"):
        await DockerBackend(run=run).start(launch())


async def test_fly_machine_per_run_auto_destroyed():
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "e286de4f711e86", "state": "created"})
        if request.method == "GET":
            return httpx.Response(200, json={"state": "started"})
        return httpx.Response(200, json={"ok": True})

    fly = FlyBackend("eden-runs", "fly-token", "cdg", transport=httpx.MockTransport(handler))
    handle = await fly.start(launch())
    assert handle == "e286de4f711e86"
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/apps/eden-runs/machines"
    assert seen[0].headers["authorization"] == "Bearer fly-token"
    assert body["config"]["auto_destroy"] is True and body["config"]["restart"] == {"policy": "no"}
    assert body["region"] == "cdg" and body["config"]["guest"]["memory_mb"] == 2048
    assert await fly.alive(handle) is True
    await fly.stop(handle)
    assert seen[-1].method == "DELETE" and seen[-1].url.params["force"] == "true"
    await fly.aclose()


def test_unbuilt_providers_say_so():
    for cls in (GcpBackend, AwsBackend):
        with pytest.raises(BackendNotReady, match="isn't built yet"):
            cls()
    with pytest.raises(BackendNotReady):
        FlyBackend("", "")
    with pytest.raises(BackendNotReady):
        backends.make(Settings(backend="nonsense"))
    assert backends.make(Settings(backend="fake")).name == "fake"
