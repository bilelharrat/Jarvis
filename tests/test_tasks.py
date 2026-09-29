import asyncio

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
    ToolUseBlock,
)
from conftest import FakeClient, result

from jarvis.tasks import ALLOW_EDITS, DENY, ClaudeTask, TaskManager, approval_detail


def manager(settings, answers=(), script=()):
    asked, events = [], []

    async def approve(question, detail, choices):
        asked.append((question, detail, [c for c, _ in choices]))
        return answers[len(asked) - 1]

    class Client(FakeClient):
        pass

    Client.script = list(script)
    tm = TaskManager(settings, approve, lambda kind, **d: events.append((kind, d)), Client)
    return tm, asked, events


def test_resolve_dir_accepts_known_projects_only(settings, tmp_path):
    (tmp_path / "bsh-research-center").mkdir()
    tm, _, _ = manager(settings)
    assert tm.resolve_dir("bsh-research-center") == (tmp_path / "bsh-research-center").resolve()
    assert tm.projects() == ["bsh-research-center"]
    with pytest.raises(ValueError):
        tm.resolve_dir("nope")
    with pytest.raises(ValueError):
        tm.resolve_dir("/etc")  # outside the home folder


async def test_reads_run_freely_edits_and_commands_ask(settings, tmp_path):
    tm, asked, _ = manager(settings, answers=[ALLOW_EDITS, DENY])
    task = ClaudeTask(id=1, prompt="fix it", cwd=tmp_path)
    policy = tm.policy_for(task)
    ctx = ToolPermissionContext()

    assert isinstance(await policy("Read", {"file_path": "x"}, ctx), PermissionResultAllow)
    assert asked == []

    edit = {"file_path": str(tmp_path / "a.py"), "old_string": "x = 1", "new_string": "x = 2"}
    assert isinstance(await policy("Edit", edit, ctx), PermissionResultAllow)
    assert asked[0][2] == ["allow", "allow_edits", "deny"]
    assert "a.py\n- x = 1\n+ x = 2" == asked[0][1]

    # "Allow all edits" covers later edits, never commands.
    assert isinstance(
        await policy("Write", {"file_path": "b.py", "content": ""}, ctx), PermissionResultAllow
    )
    assert len(asked) == 1
    denied = await policy("Bash", {"command": "rm -rf build"}, ctx)
    assert isinstance(denied, PermissionResultDeny)
    assert asked[1][1] == "$ rm -rf build"
    assert asked[1][2] == ["allow", "deny"]


async def test_task_runs_to_completion(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    script = [
        AssistantMessage(
            content=[ToolUseBlock(id="1", name="Read", input={"file_path": "/x/spend.py"})],
            model="m",
        ),
        result(text="Fixed the flaky test.", cost=0.42),
    ]
    tm, _, events = manager(settings, script=script)
    task = tm.start("fix the flaky test", "proj")
    await task.handle
    assert task.status == "done"
    assert task.result == "Fixed the flaky test."
    assert task.cost_usd == 0.42
    finished = [d for k, d in events if k == "task_finished"]
    assert finished[0]["status"] == "done" and finished[0]["folder"] == "proj"
    opts = tm.options_for(task)
    assert opts.cwd == str((tmp_path / "proj").resolve())
    assert opts.setting_sources == ["project"]


async def test_cancel_stops_a_task(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class Slow(FakeClient):
        async def receive_response(self):
            await asyncio.sleep(10)
            yield result()

    tm, _, _ = manager(settings)
    tm.client_factory = Slow
    task = tm.start("long job", "proj")
    await asyncio.sleep(0)
    assert tm.cancel(task.id)
    with pytest.raises(asyncio.CancelledError):
        await task.handle
    assert task.status == "stopped"


def test_approval_detail_for_write_is_relative(tmp_path):
    detail = approval_detail(
        "Write", {"file_path": str(tmp_path / "src" / "a.py"), "content": "hi"}, tmp_path
    )
    assert detail.splitlines()[0] == "src/a.py (new contents)"
