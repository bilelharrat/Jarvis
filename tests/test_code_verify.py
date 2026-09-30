"""Jarvis Code checks its work (features/code_verify.py), wired into a real hub: the
Preview pane's commands, a session's dev server tools (asked like any other step, the
command shown on the card), and a session's servers stopping with it."""

import asyncio
import json
import os
import sys
import time

import pytest
from claude_agent_sdk import PermissionResultAllow, ToolPermissionContext
from conftest import FakeClient

from jarvis import tasks
from jarvis.features import code_verify
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask


def plain_env():
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "")}


@pytest.fixture
async def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.code_verify.servers.env = plain_env  # never the owner's login shell in a test
    yield hub
    await hub.code_verify.servers.close()


@pytest.fixture
def project(settings):
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    return folder


def launch(project, configs):
    path = project / ".claude" / "launch.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": "0.0.1", "configurations": configs}))


def events(queue, kind=None):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if kind is None or ev["type"] == kind:
            out.append(ev)
    return out


async def until(condition, seconds=10.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.05)
    return False


def sleeper(project):
    script = project / "serve.py"
    script.write_text(
        "import time\nprint('Server listening on port 7070', flush=True)\n"
        "print('Error: the database is down', flush=True)\ntime.sleep(600)\n"
    )
    return {"name": "api", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]}


def handlers(cv, task):
    server = cv.session_servers(task)[code_verify.DEV]
    return {t.name: t.handler for t in code_verify.dev_tools(cv, task)}, server


async def test_the_preview_pane_shows_configs_suggestions_and_saves_one(hub, project):
    (project / "package.json").write_text(json.dumps({"scripts": {"dev": "vite"}}))
    q = hub.subscribe()
    await hub._handle({"type": "cv_state", "directory": "shop"})
    [state] = events(q, "cv_state")
    assert state["project"] == "shop" and state["configs"] == []
    assert [s["name"] for s in state["suggestions"]] == ["dev"]
    assert state["suggestions"][0]["command"] == "npm run dev"
    await hub._handle({"type": "cv_save", "directory": "shop", "name": "dev"})
    [state] = events(q, "cv_state")
    assert [c["name"] for c in state["configs"]] == ["dev"] and state["suggestions"] == []
    saved = json.loads((project / ".claude" / "launch.json").read_text())
    assert saved["configurations"][0]["runtimeArgs"] == ["run", "dev"]
    # One that isn't a suggestion (the window can't make one up) is refused.
    await hub._handle({"type": "cv_save", "directory": "shop", "name": "rm -rf"})
    assert events(q, "cv_error")[0]["text"] == "That suggestion isn't there anymore."


async def test_a_project_outside_the_projects_folder_is_refused(hub):
    q = hub.subscribe()
    await hub._handle({"type": "cv_state", "directory": "/etc"})
    assert events(q, "cv_error")


async def test_the_owner_starts_and_stops_a_server_from_the_pane(hub, project):
    launch(project, [sleeper(project)])
    q = hub.subscribe()
    await hub._handle({"type": "cv_server", "action": "start", "directory": "shop", "name": "api"})
    cv = hub.code_verify
    key = f"{project.resolve()}::api"
    assert await until(lambda: key in cv.servers.servers and cv.servers.servers[key].alive)
    server = cv.servers.servers[key]
    assert server.started_by is None  # the owner's own: no session stops it
    await hub._handle({"type": "cv_logs", "key": key, "since": 0})
    assert await until(lambda: any(e["type"] == "cv_logs" for e in list(q._items)))
    [logs] = events(q, "cv_logs")
    assert logs["lines"][0][1].startswith("$ ")
    await hub._handle({"type": "cv_server", "action": "stop", "key": key})
    assert await until(lambda: not server.alive)
    assert any(ev["type"] == "devservers" for ev in events(q))


async def test_a_session_gets_dev_server_tools_that_look_freely_and_ask_to_start(hub, project):
    launch(project, [sleeper(project)])
    task = ClaudeTask(id=5, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[5] = task
    options = hub.tasks.options_for(task)
    assert code_verify.DEV in options.mcp_servers
    assert set(code_verify.READ_ONLY) <= set(options.allowed_tools)
    assert f"mcp__{code_verify.DEV}__dev_server_start" not in options.allowed_tools

    asked = []

    async def approve(question, detail, choices, context=None):
        asked.append((question, detail))
        return "allow"

    hub.tasks.approve = approve
    policy = hub.tasks.policy_for(task)
    decision = await policy(
        f"mcp__{code_verify.DEV}__dev_server_start", {"name": "api"}, ToolPermissionContext()
    )
    assert isinstance(decision, PermissionResultAllow)
    question, detail = asked[0]
    assert question == "Jarvis Code in shop wants to start a dev server"
    assert detail.startswith("api: $ ") and "serve.py" in detail and ".claude/launch.json" in detail
    # Bypass permissions: it goes ahead, as every other step does.
    task.mode = "auto"
    await policy(
        f"mcp__{code_verify.DEV}__dev_server_start", {"name": "api"}, ToolPermissionContext()
    )
    assert len(asked) == 1


async def test_the_session_tools_start_read_and_stop_a_server(hub, project, monkeypatch):
    monkeypatch.setattr(code_verify, "START_WAIT", 0.5)  # it never answers on its port
    launch(project, [sleeper(project)])
    task = ClaudeTask(id=6, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[6] = task
    tools, _ = handlers(hub.code_verify, task)
    listing = (await tools["dev_servers"]({}))["content"][0]["text"]
    assert "api:" in listing and "not started" in listing
    started = await tools["dev_server_start"]({"name": "api"})
    # It never answers on its port: said, not an error (its address, once it printed it).
    assert started["content"][0]["text"].startswith("api is starting (no answer yet)")
    assert not started.get("is_error")
    cv = hub.code_verify
    server = cv.servers.servers[f"{project.resolve()}::api"]
    assert server.started_by == 6
    assert await until(lambda: server.ring.seq >= 3)
    errors = (await tools["dev_server_logs"]({"name": "api", "errors_only": True}))["content"][0]
    assert "Error: the database is down" in errors["text"]
    assert "<dev-server-output>" in errors["text"]  # marked as the app's data
    assert (await tools["dev_server_start"]({"name": "nope"})).get("is_error")
    stopped = await tools["dev_server_stop"]({"name": "api"})
    assert stopped["content"][0]["text"] == "Stopped api."
    assert not server.alive


async def test_a_sessions_servers_stop_when_it_ends_the_owners_dont(hub, project):
    launch(project, [sleeper(project), {**sleeper(project), "name": "web"}])
    cv = hub.code_verify
    mine = await cv.servers.start(project.resolve(), "api", started_by=9)
    owners = await cv.servers.start(project.resolve(), "web", started_by=None)
    cv.on_task_event("tasks", {"items": [{"id": 9, "kind": "code", "status": "running"}]})
    await asyncio.sleep(0.1)
    assert mine.alive
    cv.on_task_event("tasks", {"items": [{"id": 9, "kind": "code", "status": "stopped"}]})
    assert await until(lambda: not mine.alive)
    assert mine.message == "Stopped with the session that started it."
    assert owners.alive
    # A session let go from the list counts as ended too.
    again = await cv.servers.start(project.resolve(), "api", started_by=10)
    cv.on_task_event("tasks", {"items": []})
    assert await until(lambda: not again.alive)


def test_a_failing_feature_hook_never_keeps_a_session_from_opening(hub, project):
    class Broken:
        def apply(self, task, options):
            raise RuntimeError("broken")

        def key(self, task):
            raise RuntimeError("broken")

    hub.tasks.option_hooks.append(Broken())
    task = ClaudeTask(id=3, prompt="x", cwd=project.resolve())
    options = hub.tasks.options_for(task)
    assert code_verify.DEV in options.mcp_servers
    assert hub.tasks._options_key(task)[-1][-1] is None


def test_feature_tools_word_their_cards(tmp_path):
    name = f"mcp__{code_verify.DEV}__dev_server_stop"
    assert tasks.FEATURE_TOOLS[name][0] == "stop a dev server"
    # No wording: the name and input, as for any other server's tool.
    assert (
        tasks.approval_detail(name, {"name": "web"}, tmp_path) == 'dev_server_stop {"name": "web"}'
    )

    def broken(_input, _cwd):
        raise RuntimeError("no")

    tasks.FEATURE_TOOLS["mcp__x__y"] = ("do y", broken)
    try:
        assert tasks.approval_detail("mcp__x__y", {}, tmp_path) == "y {}"
    finally:
        del tasks.FEATURE_TOOLS["mcp__x__y"]
