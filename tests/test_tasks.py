import asyncio

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    TextBlock,
    ToolPermissionContext,
    ToolUseBlock,
    UserMessage,
)
from conftest import FakeClient, result

from jarvis.tasks import ALLOW_EDITS, DENY, ClaudeTask, TaskManager, approval_detail


def manager(settings, answers=(), script=()):
    asked, events = [], []

    async def approve(question, detail, choices, context=None):
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
    assert asked[1][2] == ["allow", "always", "deny"]  # "always" remembers `rm` here


async def test_session_answers_then_waits_for_more(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    script = [
        AssistantMessage(
            content=[ToolUseBlock(id="1", name="Read", input={"file_path": "/x/spend.py"})],
            model="m",
        ),
        AssistantMessage(content=[TextBlock(text="Fixed the flaky test.")], model="m"),
        result(text="Fixed the flaky test.", cost=0.42),
    ]
    tm, _, events = manager(settings, script=script)
    task = tm.start("fix the flaky test", "proj")
    for _ in range(100):
        await asyncio.sleep(0.01)
        if task.status == "waiting":
            break
    assert task.status == "waiting" and task.session_id == "s"
    assert task.result == "Fixed the flaky test." and task.cost_usd == 0.42
    roles = [e["role"] for e in tm.transcript(task.id)]
    assert roles == ["user", "tool", "assistant", "turn"]
    assert any(k == "task_finished" for k, _ in events)
    # A follow-up goes to the same open session.
    assert tm.send(task.id, "now run the whole suite")
    for _ in range(100):
        await asyncio.sleep(0.01)
        if len(tm.transcript(task.id)) >= 6:
            break
    assert [e["text"] for e in tm.transcript(task.id) if e["role"] == "user"] == [
        "fix the flaky test",
        "now run the whole suite",
    ]
    opts = tm.options_for(task)
    assert opts.cwd == str((tmp_path / "proj").resolve())
    assert opts.setting_sources == ["project"] and opts.resume == "s"
    tm.cancel(task.id)
    with pytest.raises(asyncio.CancelledError):
        await task.handle


async def test_modes_change_what_asks(settings, tmp_path):
    tm, asked, _ = manager(settings, answers=[DENY])
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    tm.tasks[1] = task
    policy = tm.policy_for(task)
    ctx = ToolPermissionContext()
    tm.set_mode(1, "edits")
    assert isinstance(await policy("Edit", {"file_path": "a"}, ctx), PermissionResultAllow)
    assert isinstance(await policy("Bash", {"command": "ls"}, ctx), PermissionResultDeny)
    assert len(asked) == 1
    tm.set_mode(1, "auto")
    assert isinstance(await policy("Bash", {"command": "make"}, ctx), PermissionResultAllow)
    assert len(asked) == 1
    assert not tm.set_mode(1, "yolo")


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


async def test_dont_ask_again_is_remembered_per_project(settings, tmp_path):
    from jarvis.tasks import ALWAYS, RuleStore, command_rule

    assert command_rule("git commit -am 'x'") == "git commit"
    assert command_rule("pytest -q") == "pytest"
    assert command_rule("npm --prefix app test") == "npm"
    store = RuleStore(tmp_path / "rules.json")
    tm, asked, _ = manager(settings, answers=[ALWAYS, "deny:use the Makefile instead"])
    tm.rules = store
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    policy = tm.policy_for(task)
    ctx = ToolPermissionContext()
    assert isinstance(
        await policy("Bash", {"command": "git commit -m one"}, ctx), PermissionResultAllow
    )
    assert isinstance(
        await policy("Bash", {"command": "git commit -m two"}, ctx), PermissionResultAllow
    )
    assert len(asked) == 1  # remembered
    assert RuleStore(tmp_path / "rules.json").for_project(tmp_path) == ["git commit"]
    denied = await policy("Bash", {"command": "git push --force"}, ctx)
    assert (
        isinstance(denied, PermissionResultDeny)
        and denied.message == "The user said no: use the Makefile instead"
    )


async def test_streaming_thinking_todos_agents_and_background(settings, tmp_path):
    from claude_agent_sdk import StreamEvent, TaskStartedMessage, TaskUpdatedMessage, ThinkingBlock

    tm, _, events = manager(settings)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    tm._on_task_message(
        task,
        StreamEvent(
            uuid="u",
            session_id="s",
            event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hel"}},
        ),
    )
    assert ("task_stream", {"id": 1, "part": "text", "text": "Hel"}) in events
    tm._on_task_message(
        task,
        AssistantMessage(
            content=[ThinkingBlock(thinking="Consider the retry.", signature="s")], model="m"
        ),
    )
    todo = ToolUseBlock(
        id="t",
        name="TodoWrite",
        input={
            "todos": [
                {"content": "Add retry", "status": "in_progress", "activeForm": "Adding retry"}
            ]
        },
    )
    agent = ToolUseBlock(
        id="a",
        name="Task",
        input={
            "description": "Find callers",
            "prompt": "grep for query",
            "subagent_type": "Explore",
        },
    )
    tm._on_task_message(task, AssistantMessage(content=[todo, agent], model="m"))
    sub = AssistantMessage(
        content=[ToolUseBlock(id="g", name="Grep", input={"pattern": "query"})],
        model="m",
        parent_tool_use_id="a",
    )
    tm._on_task_message(task, sub)
    roles = [e["role"] for e in task.transcript]
    assert roles == ["thinking", "todos", "tool", "subtool"]
    assert task.todos == [
        {"content": "Add retry", "status": "in_progress", "active": "Adding retry"}
    ]
    assert task.transcript[2]["tool"] == "Agent" and task.transcript[3]["parent"] == "a"
    tm._on_task_message(
        task,
        TaskStartedMessage(
            subtype="task_started",
            data={},
            task_id="bg1",
            description="npm run dev",
            uuid="x",
            session_id="s",
        ),
    )
    assert task.public()["background"][0]["description"] == "npm run dev"
    tm._on_task_message(
        task,
        TaskUpdatedMessage(
            subtype="task_updated",
            data={},
            task_id="bg1",
            patch={},
            status="killed",
            session_id="s",
            uuid="y",
        ),
    )
    assert task.public()["background"] == []


async def test_rewind_fork_rename_export_and_effort(settings, tmp_path, monkeypatch):
    from jarvis import tasks as tasks_module

    (tmp_path / "proj").mkdir()
    monkeypatch.setattr(tasks_module, "EXPORT_DIR", tmp_path / "exports")
    tm, _, _ = manager(settings)
    task = tm.start("", "proj")
    for _ in range(50):
        if task.client is not None:
            break
        await asyncio.sleep(0.01)
    tm._log(task, "user", "add a retry")
    tm._on_task_message(task, UserMessage(content="add a retry", uuid="u-1"))
    assert task.transcript[-1]["uuid"] == "u-1"
    tm._log(task, "user", "now the tests")
    tm._on_task_message(task, UserMessage(content="now the tests", uuid="u-2"))
    assert (
        await tm.rewind_to(task.id, "u-1")
        == "Rewound: the files are back as they were before that message."
    )
    assert task.client.rewound == ["u-1"] and task.checkpoints == []
    task.session_id = "sess"
    fork = tm.fork(task.id, "u-2")
    assert fork.fork and fork.resume_at == "u-2" and fork.session_id == "sess"
    opts = tm.options_for(fork)
    assert opts.fork_session and opts.resume_session_at == "u-2" and opts.resume == "sess"
    assert tm.rename(task.id, "Retry work") and task.title == "Retry work"
    path = tm.export(task.id)
    assert path.read_text().startswith("# Retry work") and "> add a retry" in path.read_text()
    assert tm.set_effort(task.id, "max") and tm.options_for(task).effort == "max"
    assert not tm.set_effort(task.id, "extreme")
    for t in tm.tasks.values():
        t.handle.cancel()


async def test_pictures_go_to_claude_with_the_message():
    from jarvis.tasks import _with_images

    msgs = [
        m
        async for m in _with_images(
            "what's wrong here?", [{"media_type": "image/png", "data": "AAAA"}]
        )
    ]
    content = msgs[0]["message"]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["data"] == "AAAA"
    assert content[1] == {"type": "text", "text": "what's wrong here?"}


def test_sessions_are_named_after_their_first_request():
    from jarvis.tasks import _session_title

    assert (
        _session_title("add a retry around the query in hub.py and test it")
        == "Add a retry around the query in hub.py and…"
    )
    assert _session_title("Fix the build. Then deploy it.") == "Fix the build."
