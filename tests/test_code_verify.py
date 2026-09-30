"""Jarvis Code checks its work (features/code_verify.py), wired into a real hub: the
Preview pane's commands, a session's dev server tools (asked like any other step, the
command shown on the card), and a session's servers stopping with it."""

import asyncio
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

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
    cv = hub.code_verify
    # Never the owner's login shell in a test.
    cv.servers.env = cv.tests.env = cv.diags.env = plain_env
    yield hub
    await cv.close()


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


async def until(condition, seconds=90.0):
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


def tool_wrapper(project, name, target):
    """The project's own copy of a tool (its .venv/bin), running the one given."""
    path = project / ".venv" / "bin" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/sh\nexec "{target}" "$@"\n')
    path.chmod(0o755)


def sent_messages(hub, monkeypatch):
    sent = []
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text)) or True
    )
    return sent


async def wait_for(q, kind, check=lambda ev: True, seconds=120.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while not q.empty():
            ev = q.get_nowait()
            if ev["type"] == kind and check(ev):
                return ev
        await asyncio.sleep(0.05)
    raise AssertionError(f"no {kind}")


async def test_the_tests_pane_runs_the_projects_tests_and_sends_the_failures(
    hub, project, monkeypatch
):
    (project / "tests").mkdir()
    (project / "tests" / "test_math.py").write_text(
        "def test_add():\n    assert 1 + 1 == 2\n\n\ndef test_sub():\n    assert 3 - 1 == 1\n"
    )
    tool_wrapper(project, "python", sys.executable)
    task = ClaudeTask(id=4, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[4] = task
    sent = sent_messages(hub, monkeypatch)
    q = hub.subscribe()
    await hub._handle({"type": "cv_tests", "action": "state", "id": 4})
    state = await wait_for(q, "cv_tests")
    [suite] = state["suites"]
    assert suite["id"] == "pytest" and suite["command"] == ".venv/bin/python -m pytest"
    assert state["files"][suite["key"]] == ["tests/test_math.py"]
    await hub._handle({"type": "cv_tests", "action": "fix", "id": 4})
    assert (await wait_for(q, "cv_error"))["text"] == "There are no failures to fix."
    await hub._handle({"type": "cv_tests", "action": "run", "id": 4, "suite": suite["key"]})
    done = await wait_for(q, "cv_tests_run", lambda ev: ev["run"]["status"] != "running")
    assert done["run"]["status"] == "failed" and done["run"]["summary"] == "1 passed · 1 failed"
    await hub._handle({"type": "cv_tests", "action": "fix", "id": 4})
    [(task_id, text)] = sent
    assert task_id == 4 and "test_sub (tests/test_math.py:" in text and "<test-output>" in text
    # One test again, by the node id its result gave.
    target = done["run"]["tree"][0]["cases"][0]["target"]
    await hub._handle(
        {"type": "cv_tests", "action": "run", "id": 4, "suite": suite["key"], "test": target}
    )
    one = await wait_for(q, "cv_tests_run", lambda ev: ev["run"]["status"] != "running")
    assert one["run"]["target"] == {"test": "tests/test_math.py::test_sub"}


async def test_the_problems_pane_runs_the_projects_checkers_and_sends_them(
    hub, project, monkeypatch
):
    (project / "pyproject.toml").write_text("[tool.ruff]\n")
    (project / "app.py").write_text("import os\n")
    tool_wrapper(project, "ruff", str(Path(sys.executable).parent / "ruff"))
    task = ClaudeTask(id=8, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[8] = task
    sent = sent_messages(hub, monkeypatch)
    q = hub.subscribe()
    await hub._handle({"type": "cv_problems", "action": "state", "id": 8})
    state = await wait_for(q, "cv_problems_state")
    assert [c["id"] for c in state["checkers"]] == ["ruff"] and state["after_turn"] is False
    await hub._handle({"type": "cv_problems", "action": "run", "id": 8})
    done = await wait_for(q, "cv_problems", lambda ev: ev["check"]["status"] == "done")
    [problem] = done["check"]["problems"]
    assert (problem["file"], problem["line"], problem["code"]) == ("app.py", 1, "F401")
    await hub._handle({"type": "cv_problems", "action": "fix", "id": 8})
    [(task_id, text)] = sent
    assert task_id == 8 and "app.py:1:8 warning [F401] (ruff)" in text
    await hub._handle({"type": "cv_session", "id": 8, "problems": True})
    assert hub.code_verify.session(8).problems is True
    # A project with nothing to check says so.
    (project / "pyproject.toml").write_text("")
    await hub._handle({"type": "cv_problems", "action": "run", "id": 8})
    assert "no checkers set up" in (await wait_for(q, "cv_error"))["text"]


# ── the check after a turn ──

JPEG_B64 = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 32).decode()


def noisy_server(project):
    """A dev server that prints an error before the edit, and another once `broke` exists."""
    script = project / "noisy.py"
    script.write_text(
        "import os, time\n"
        "print('Error: an old one, before the edit', flush=True)\n"
        "said = False\n"
        "while True:\n"
        "    if os.path.exists('broke') and not said:\n"
        "        print('[vite] Internal server error: Failed to resolve import', flush=True)\n"
        "        said = True\n"
        "    time.sleep(0.05)\n"
    )
    return {
        "name": "web",
        "runtimeExecutable": sys.executable,
        "runtimeArgs": [str(script)],
        "url": "http://localhost:5173/",
    }


async def a_session_with_a_server(hub, project):
    launch(project, [noisy_server(project)])
    task = ClaudeTask(id=3, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[3] = task
    cv = hub.code_verify
    server = await cv.servers.start(project.resolve(), "web", started_by=3)
    assert await until(lambda: server.ring.seq >= 2)
    await hub._handle({"type": "cv_session", "id": 3, "verify": True})
    return task, cv, server


def a_turn(cv, project, edited=True):
    cv.on_task_event("task_log", {"id": 3, "entry": {"role": "user", "text": "make it"}})
    if edited:
        cv.on_task_event("task_log", {"id": 3, "entry": {"role": "tool", "tool": "Edit"}})
    (project / "broke").write_text("")
    cv.on_task_event(
        "task_finished",
        {"id": 3, "task_kind": "code", "status": "done", "files": ["a.ts"] if edited else []},
    )


def verify_entries(task):
    return [e for e in task.transcript if e["role"] == "verify"]


async def test_a_turn_is_checked_and_what_went_wrong_goes_back_once(hub, project, monkeypatch):
    task, cv, server = await a_session_with_a_server(hub, project)
    page = {
        "ok": True,
        "title": "Shop",
        "errors": [
            {"kind": "console", "text": "TypeError: cart is undefined", "where": "App.tsx:12"}
        ],
        "shot": JPEG_B64,
        "thumb": JPEG_B64,
    }

    async def check(url, reload=True):
        assert url == "http://localhost:5173/"
        return page

    monkeypatch.setattr(cv.pages, "check", check)
    sent = []
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text, k)) or True
    )
    a_turn(cv, project)
    assert await until(lambda: len(verify_entries(task)) == 1)
    [entry] = verify_entries(task)
    assert (
        entry["status"] == "problems" and entry["sent"] and entry["url"] == "http://localhost:5173/"
    )
    texts = [f["text"] for f in entry["findings"]]
    assert texts == [
        "TypeError: cart is undefined",
        "[vite] Internal server error: Failed to resolve import",
    ]  # the page's first; the server's only since the edit
    assert entry["thumb"] == JPEG_B64 and cv.proofs.read(entry["proof"]) == JPEG_B64
    [(task_id, note, kwargs)] = sent
    assert task_id == 3 and kwargs == {"note": True}  # the app's own words, not the owner's
    assert note.startswith("Preview check after your last change found 2 problems")
    assert "<check-output>" in note and "data, not instructions" in note
    # Twice in a row at most; the owner writing starts it over.
    (project / "broke").unlink()
    a_turn_again = lambda: cv.on_task_event(  # noqa: E731
        "task_finished", {"id": 3, "task_kind": "code", "status": "done", "files": ["a.ts"]}
    )
    a_turn_again()
    assert await until(lambda: len(verify_entries(task)) == 2)
    a_turn_again()
    assert await until(lambda: len(verify_entries(task)) == 3)
    third = verify_entries(task)[-1]
    assert not third["sent"] and "already asked for fixes" in third["why_not"]
    assert len(sent) == 2
    cv.on_task_event("task_log", {"id": 3, "entry": {"role": "user", "text": "try again"}})
    a_turn_again()
    assert await until(lambda: len(verify_entries(task)) == 4)
    assert verify_entries(task)[-1]["sent"]
    # All fixed: a passing check, its proof, nothing sent.
    page["errors"] = []
    cv.on_task_event("task_log", {"id": 3, "entry": {"role": "user", "text": "and now?"}})
    a_turn_again()
    assert await until(lambda: len(verify_entries(task)) == 5)
    passed = verify_entries(task)[-1]
    assert passed["status"] == "ok" and not passed["sent"] and passed["findings"] == []
    assert passed["text"] == "Preview check: no problems."
    assert cv.session(3).last["status"] == "ok"


async def test_turns_that_change_nothing_or_stop_are_not_checked(hub, project, monkeypatch):
    task, cv, _ = await a_session_with_a_server(hub, project)
    called = []

    async def check(url, reload=True):
        called.append(url)
        return {"ok": True, "errors": []}

    monkeypatch.setattr(cv.pages, "check", check)
    a_turn(cv, project, edited=False)
    cv.on_task_event(
        "task_finished", {"id": 3, "task_kind": "code", "status": "stopped", "files": ["a"]}
    )
    await asyncio.sleep(0.3)
    assert called == [] and verify_entries(task) == []
    await hub._handle({"type": "cv_session", "id": 3, "verify": False})
    cv.on_task_event(
        "task_finished", {"id": 3, "task_kind": "code", "status": "done", "files": ["a"]}
    )
    await asyncio.sleep(0.3)
    assert called == []


async def test_the_page_check_is_the_app_windows_round_trip(hub, project, monkeypatch):
    task, cv, _ = await a_session_with_a_server(hub, project)
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: True)
    q = hub.subscribe()
    # No app window: the page isn't checked, and the entry says why; the server still is.
    a_turn(cv, project)
    assert await until(lambda: len(verify_entries(task)) == 1)
    first = verify_entries(task)[0]
    assert "isn't open" in first["page_error"] and first["findings"][0]["kind"] == "server"
    # The app window: asked, and its answer taken.
    hub.browser_available = True
    cv.on_task_event("task_log", {"id": 3, "entry": {"role": "user", "text": "again"}})
    cv.on_task_event(
        "task_finished", {"id": 3, "task_kind": "code", "status": "done", "files": ["a"]}
    )
    asked = await wait_for(q, "cv_page_check")
    assert asked["url"] == "http://localhost:5173/" and asked["reload"] is True
    await hub._handle(
        {
            "type": "cv_page_result",
            "id": asked["id"],
            "result": {"ok": True, "title": "Shop", "errors": []},
        }
    )
    assert await until(lambda: len(verify_entries(task)) == 2)
    assert verify_entries(task)[-1]["title"] == "Shop"


async def test_other_features_add_what_they_see_of_the_page(hub, project, monkeypatch):
    task, cv, _ = await a_session_with_a_server(hub, project)

    async def check(url, reload=True):
        return {"ok": True, "errors": []}

    async def console(session, url):
        assert session is task and url == "http://localhost:5173/"
        return ["Warning: each child in a list should have a unique key"]

    async def broken(session, url):
        raise RuntimeError("no")

    monkeypatch.setattr(cv.pages, "check", check)
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: True)
    cv.add_error_source(broken)  # never stops the check
    cv.add_error_source(console)
    a_turn(cv, project)
    assert await until(lambda: len(verify_entries(task)) == 1)
    kinds = [(f["kind"], f["text"]) for f in verify_entries(task)[0]["findings"]]
    assert ("source", "Warning: each child in a list should have a unique key") in kinds


async def test_nothing_to_check_is_said_once_and_the_owner_can_check_now(hub, project, monkeypatch):
    task = ClaudeTask(id=3, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[3] = task
    cv = hub.code_verify
    await hub._handle({"type": "cv_session", "id": 3, "verify": True})
    for _ in range(2):
        a_turn(cv, project)
        await asyncio.sleep(0.3)
    [entry] = verify_entries(task)
    assert entry["status"] == "skipped" and "no dev server set up" in entry["page_error"]
    assert entry["text"] == "Nothing to check yet."
    await hub._handle({"type": "cv_check", "id": 3})  # the owner's own: always answered
    assert await until(lambda: len(verify_entries(task)) == 2)
    assert verify_entries(task)[-1]["by_owner"]


async def test_the_owner_can_ask_for_a_fix_and_see_the_full_picture(hub, project, monkeypatch):
    task, cv, _ = await a_session_with_a_server(hub, project)

    async def check(url, reload=True):
        return {
            "ok": True,
            "errors": [{"kind": "console", "text": "TypeError: x"}],
            "shot": JPEG_B64,
        }

    monkeypatch.setattr(cv.pages, "check", check)
    sent = []
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((text, k)) or True
    )
    await hub._handle({"type": "cv_check", "id": 3})
    assert await until(lambda: len(verify_entries(task)) == 1)
    entry = verify_entries(task)[0]
    assert (
        entry["by_owner"] and not entry["sent"] and sent == []
    )  # checked by the owner: nothing sent
    await hub._handle({"type": "cv_fix_check", "id": 3, "n": entry["n"]})
    [(text, kwargs)] = sent
    assert kwargs == {} and "TypeError: x" in text  # as the owner's own message
    q = hub.subscribe()
    await hub._handle({"type": "cv_proof", "proof": entry["proof"]})
    [proof] = events(q, "cv_proof")
    assert proof["jpeg"] == JPEG_B64 and not proof["missing"]
    await hub._handle({"type": "cv_proof", "proof": "../../secret"})
    assert events(q, "cv_proof")[0]["missing"]


async def test_new_sessions_check_their_work_when_the_owner_says_so(hub, project):
    hub.set_feature_prefs({"code_verify_new_sessions": True})
    assert hub.code_verify.session(41).verify is True
    hub.set_feature_prefs({"code_verify_new_sessions": False})
    assert hub.code_verify.session(42).verify is False
    assert hub.code_verify.session(41).verify is True  # a session's own switch stays


# ── a session's extra hands: the iOS Simulator, Xcode's tools ──


async def test_a_session_gets_the_simulators_fast_tools_and_they_follow_its_mode(hub, project):
    task = ClaudeTask(id=12, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[12] = task
    options = hub.tasks.options_for(task)
    assert "jarvis_ios" in options.mcp_servers
    assert {"mcp__jarvis_ios__sim_look", "mcp__jarvis_ios__sim_logs"} <= set(options.allowed_tools)
    assert "mcp__jarvis_ios__sim_tap" not in options.allowed_tools
    assert "xcode" not in options.mcp_servers  # only when the owner turns it on
    asked = []

    async def approve(question, detail, choices, context=None):
        asked.append((question, detail))
        return "allow"

    hub.tasks.approve = approve
    policy = hub.tasks.policy_for(task)
    await policy("mcp__jarvis_ios__sim_tap", {"x": 10, "y": 20}, ToolPermissionContext())
    assert asked == [
        (
            "Jarvis Code in shop wants to use the iOS Simulator",
            "tap at 10, 20 of the latest picture",
        )
    ]


async def test_xcodes_tools_are_the_owners_to_turn_on_for_an_xcode_project(
    hub, project, monkeypatch
):
    task = ClaudeTask(id=13, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[13] = task
    reopened = []
    monkeypatch.setattr(
        hub.tasks, "reopen", lambda task_id, note: reopened.append((task_id, note)) or True
    )
    q = hub.subscribe()
    await hub._handle({"type": "cv_session", "id": 13, "xcode": True})
    assert "no Xcode workspace or project" in events(q, "cv_error")[0]["text"] and reopened == []
    (project / "Shop.xcodeproj").mkdir()
    before = hub.tasks._options_key(task)
    await hub._handle({"type": "cv_session", "id": 13, "xcode": True})
    [state] = events(q, "cv_session")
    assert state["xcode"] and state["xcode_project"]
    assert reopened and reopened[0][0] == 13 and "Xcode must be open" in reopened[0][1]
    assert hub.tasks._options_key(task) != before  # a new connection gets it
    options = hub.tasks.options_for(task)
    assert options.mcp_servers["xcode"] == {
        "type": "stdio",
        "command": "/usr/bin/xcrun",
        "args": ["mcpbridge"],
    }
    assert not any(name.startswith("mcp__xcode") for name in options.allowed_tools)  # it asks
    await hub._handle({"type": "cv_session", "id": 13, "xcode": False})
    assert "xcode" not in hub.tasks.options_for(task).mcp_servers
    assert reopened[-1][1] == "Xcode's tools are off for this session."


async def test_steps_that_run_the_projects_own_commands_always_ask(hub, project):
    """Claude Code's Auto mode would judge dev_server_start by its name: it always asks."""
    task = ClaudeTask(id=14, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[14] = task
    options = hub.tasks.options_for(task)
    matcher = next(m for m in options.hooks["PreToolUse"] if "dev_server_start" in m.matcher)
    for name in ("mcp__jarvis_dev__dev_server_start", "mcp__jarvis_ios__sim_build_run"):
        assert re.fullmatch(matcher.matcher, name)
        out = await matcher.hooks[0]({"tool_name": name, "tool_input": {}}, "t", None)
        assert out["hookSpecificOutput"]["permissionDecision"] == "ask", name
    assert await matcher.hooks[0]({"tool_name": "mcp__jarvis_dev__dev_servers"}, "t", None) == {}


# ── a session's use of the Mac ──


async def test_the_mac_is_a_sessions_only_when_the_owner_says_so(hub, project, monkeypatch):
    task = ClaudeTask(id=21, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[21] = task
    assert "jarvis_mac" not in hub.tasks.options_for(task).mcp_servers  # off by default
    reopened = []
    monkeypatch.setattr(hub.tasks, "reopen", lambda task_id, note: reopened.append(note) or True)
    before = hub.tasks._options_key(task)
    await hub._handle({"type": "cv_session", "id": 21, "mac": True})
    assert reopened and reopened[0].startswith("This session may use the Mac now")
    assert hub.tasks._options_key(task) != before
    options = hub.tasks.options_for(task)
    assert "jarvis_mac" in options.mcp_servers
    assert {"mcp__jarvis_mac__read_file", "mcp__jarvis_mac__find_files"} <= set(
        options.disallowed_tools
    )
    assert not any(t.startswith("mcp__jarvis_mac") for t in options.allowed_tools)
    matcher = next(m for m in options.hooks["PreToolUse"] if m.matcher == "mcp__jarvis_mac__.*")
    hook = matcher.hooks[0]
    ask = await hook({"tool_name": "mcp__jarvis_mac__see_screen", "tool_input": {}}, "t", None)
    assert ask["hookSpecificOutput"]["permissionDecision"] == "ask"
    # Its cards say what each step does, in the session's own permission prompt.
    asked = []

    async def approve(question, detail, choices, context=None):
        asked.append((question, detail))
        return "deny"

    hub.tasks.approve = approve
    policy = hub.tasks.policy_for(task)
    await policy("mcp__jarvis_mac__type_text", {"text": "hello"}, ToolPermissionContext())
    assert asked == [("Jarvis Code in shop wants to type on your Mac", "type: hello")]
    task.mode = "auto"  # Bypass: the owner turned this on for the session, so it goes ahead
    assert isinstance(
        await policy("mcp__jarvis_mac__type_text", {"text": "hi"}, ToolPermissionContext()),
        PermissionResultAllow,
    )
    # Turned off: refused at once, even before the connection reopens without it.
    await hub._handle({"type": "cv_session", "id": 21, "mac": False})
    deny = await hook({"tool_name": "mcp__jarvis_mac__see_screen", "tool_input": {}}, "t", None)
    assert deny["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "jarvis_mac" not in hub.tasks.options_for(task).mcp_servers
    assert reopened[-1] == "This session no longer uses the Mac."
