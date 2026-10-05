"""Jarvis Code's Health pane (features/code_health): the engine's version and the Claude
sign-in from the checkup's own check (never the real engine in a test), a session's
connection, and Reconnect."""

import asyncio
import json

import pytest
from code_session_fakes import make_hub, until

from jarvis.features.ops import desk_for
from jarvis.tasks import ClaudeTask


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def engine(hub, logged_in=True, plan="max"):
    """The checkup's engine, faked: what it's asked and what it says."""
    asked = []

    async def run(*args, timeout=20.0, env=None):
        asked.append(args[1:])
        if args[1:] == ("--version",):
            return 0, "2.1.3 (Claude Code)\n", ""
        status = {"loggedIn": logged_in, "authMethod": "claude.ai", "subscriptionType": plan}
        return 0, json.dumps(status) + "\n", ""

    desk = desk_for(hub)
    desk.run = run
    desk.probe_extra = {
        "claude_cli": lambda: "/app/.venv/lib/claude_agent_sdk/_bundled/claude",
        "login_command": lambda cli: "claude auth login",
    }
    return asked


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def answer(seen, n=1):
    assert await until(lambda: sum(k == "cw_health" for k, _ in seen) >= n)
    return [d for k, d in seen if k == "cw_health"][n - 1]


async def test_the_engine_the_sign_in_and_the_session_s_connection(hub, tmp_path):
    asked = engine(hub)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, model="claude-fable-5")
    task.status, task.busy = "running", True
    hub.tasks.tasks[7] = task
    seen = record(hub)
    await hub.handle({"type": "cw_health", "id": 7})
    got = await answer(seen)
    assert got["engine"] == {
        "version": "2.1.3",
        "path": "/app/.venv/lib/claude_agent_sdk/_bundled/claude",
        "bundled": True,
    }
    assert got["signin"]["state"] == "ok" and got["signin"]["summary"] == "Signed in"
    assert got["signin"]["plan"] == "Max" and got["signin"]["command"] == ""
    assert got["session"] == {
        "id": 7, "status": "running", "connected": False, "busy": True,
        "model": "claude-fable-5", "error": "", "fell_back": False,
    }  # fmt: skip
    # Kept a minute: asked again, the engine isn't; asked fresh, it is.
    n = len(asked)
    await hub.handle({"type": "cw_health", "id": 7})
    await answer(seen, 2)
    assert len(asked) == n
    await hub.handle({"type": "cw_health", "id": 7, "fresh": True})
    await answer(seen, 3)
    assert len(asked) == 2 * n


async def test_asks_while_a_look_is_under_way_share_it(hub):
    """The pane opened, then another session shown (or two windows): the asks that come
    while the engine is being looked at share that look, rather than each starting the
    engine (and its sign-in check) again. A fresh ask still looks again for itself."""
    asked = engine(hub)
    desk = desk_for(hub)
    quick = desk.run

    async def slow(*args, **kw):
        await asyncio.sleep(0.05)  # (the real engine takes a second or two)
        return await quick(*args, **kw)

    desk.run = slow
    seen = record(hub)
    for _ in range(3):
        await hub.handle({"type": "cw_health"})
    first = await answer(seen, 3)
    assert asked == [("--version",), ("auth", "status", "--json")]  # one look for the three
    assert [d["engine"] for k, d in seen if k == "cw_health"] == [first["engine"]] * 3
    await hub.handle({"type": "cw_health"})
    await hub.handle({"type": "cw_health", "fresh": True})
    await answer(seen, 5)
    assert len(asked) == 4  # (the first from what was kept; the fresh one looked again)


async def test_not_signed_in_gives_the_command_that_signs_in(hub):
    engine(hub, logged_in=False)
    seen = record(hub)
    await hub.handle({"type": "cw_health"})
    got = await answer(seen)
    assert got["signin"]["state"] == "problem" and got["signin"]["command"] == "claude auth login"
    assert got["session"] is None


async def test_reconnect_starts_an_ended_session_again_and_reopens_a_live_one(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    seen = record(hub)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path / "proj")
    task.status, task.result = "failed", "Claude Code exited with code 1"
    hub.tasks.tasks[7] = task
    await hub.handle({"type": "cw_reconnect", "id": 7})
    assert ("caption", {"text": "Starting this session again."}) in seen
    assert task.handle is not None and task.status != "failed"
    assert await until(lambda: task.client is not None)  # (the fake engine connected)
    await hub.handle({"type": "cw_reconnect", "id": 7})
    assert ("caption", {"text": "Reconnecting this session."}) in seen
    assert task.reopen
    await hub.handle({"type": "cw_reconnect", "id": 99})
    assert ("caption", {"text": "There's no such session."}) in seen
    hub.tasks.cancel(7)
    await asyncio.sleep(0)
