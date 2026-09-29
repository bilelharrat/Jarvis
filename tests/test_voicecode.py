import asyncio

from claude_agent_sdk import (
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
    UserMessage,
)
from test_tasks import manager

from jarvis import voicecode as vc
from jarvis.tasks import PLAN_APPROVE_EDITS, PLAN_KEEP, ClaudeTask


def kinds(*utterances):
    return [vc.parse(u).kind for u in utterances]


def test_session_commands_are_recognised_and_the_rest_goes_to_claude():
    assert (
        kinds("Jarvis, plan mode", "switch to accept edits", "full auto", "ask me first")
        == ["mode"] * 4
    )
    assert [vc.parse(u).arg for u in ("plan mode", "auto edits", "full auto", "ask first")] == [
        "plan",
        "edits",
        "auto",
        "ask",
    ]
    assert kinds("stop", "hold on", "undo that", "revert your last change", "compact") == [
        "interrupt",
        "interrupt",
        "undo",
        "undo",
        "compact",
    ]
    assert kinds("what did you change?", "what's the diff", "read me the plan", "status") == [
        "changes",
        "changes",
        "plan",
        "status",
    ]
    assert kinds("how much context is left", "what's this cost so far", "use sonnet") == [
        "context",
        "cost",
        "model",
    ]
    assert kinds("commit that", "push it", "open a pull request", "run the tests") == ["git"] * 4
    assert kinds("new session", "exit code mode", "that's all for now") == [
        "new_session",
        "exit",
        "exit",
    ]
    assert vc.parse("explain the second change").arg == 1
    assert vc.parse("walk me through the last change").arg == -1
    # Real requests, even ones containing command words, go to Claude Code whole.
    for request in (
        "add a retry around the query in hub dot py",
        "stop the server from logging tokens",
        "why did you change the undo logic",
        "write tests for the plan parser",
    ):
        intent = vc.parse(request)
        assert intent.kind == "send" and intent.text == request
    plan = vc.parse("let's plan the database migration")
    assert (plan.kind, plan.arg, plan.text) == ("mode", "plan", "let's plan the database migration")


def test_choosing_by_voice():
    labels = ["Go, auto-accept edits", "Go, ask before edits", "Keep planning"]
    assert vc.pick_choice("option two", labels) == 1
    assert vc.pick_choice("the last one", labels) == 2
    assert vc.pick_choice("keep planning", labels) == 2
    assert vc.pick_choice("go ask before edits", labels) == 1
    assert vc.pick_choice("what time is it", labels) is None
    assert vc.pick_choice("postgres", ["SQLite", "Postgres", "Skip"]) == 1


def test_replies_plans_and_approvals_become_speech():
    reply = "Fixed it. The retry wraps `query()`.\n\n```python\nretry()\n```\n\nI also added a test. And docs. And more."
    spoken = vc.speakable(reply)
    assert "retry()" not in spoken and spoken.endswith("The rest is on screen.")
    plan = "## Plan\n1. Add a retry to `ask`\n2. Log failures\n3. Test the reconnect path"
    assert vc.plan_speech(plan) == (
        "The plan has 3 steps. One: Add a retry to ask. Two: Log failures. Three: Test the reconnect path."
    )
    bash = {"tool": "Bash", "detail": "$ uv run pytest -q", "choices": [], "question": "q"}
    assert vc.approval_speech(bash) == "It wants to run uv run pytest -q. OK?"
    edit = {"tool": "Edit", "detail": "src/jarvis/hub.py\n- a\n+ b", "choices": []}
    assert vc.approval_speech(edit) == "It wants to edit hub dot py. OK?"
    q = {
        "ask_kind": "question",
        "question": "Which database?",
        "choices": [
            {"id": "opt0", "label": "SQLite"},
            {"id": "opt1", "label": "Postgres"},
            {"id": "skip", "label": "Skip"},
        ],
    }
    assert vc.approval_speech(q) == "Which database? Options: 1, SQLite; 2, Postgres."


async def test_plan_approval_sets_how_much_it_may_do(settings, tmp_path):
    tm, asked, events = manager(settings, answers=[PLAN_APPROVE_EDITS, PLAN_KEEP])
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path, mode="plan")
    policy = tm.policy_for(task)
    ctx = ToolPermissionContext()
    go = await policy("ExitPlanMode", {"plan": "1. Do A\n2. Do B"}, ctx)
    assert isinstance(go, PermissionResultAllow) and task.mode == "edits" and task.allow_edits
    assert task.plan == "1. Do A\n2. Do B" and asked[0][2] == [
        "plan_edits",
        "plan_ask",
        "plan_keep",
    ]
    assert ("task_plan", {"id": 1, "plan": task.plan}) in events
    keep = await policy("ExitPlanMode", {"plan": "1. Do A"}, ctx)
    assert isinstance(keep, PermissionResultDeny) and "keep planning" in keep.message


async def test_claudes_questions_get_answered(settings, tmp_path):
    tm, asked, _ = manager(settings, answers=["opt1"])
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    question = {
        "questions": [
            {
                "question": "Which database?",
                "header": "DB",
                "options": [
                    {"label": "SQLite", "description": "simple"},
                    {"label": "Postgres", "description": "scales"},
                ],
                "multiSelect": False,
            }
        ]
    }
    out = await tm.policy_for(task)("AskUserQuestion", question, ToolPermissionContext())
    assert out.updated_input["answers"] == {"Which database?": "Postgres"}
    assert asked[0][2] == ["opt0", "opt1", "skip"]  # an unanswered question times out to Skip


async def test_modes_reach_claude_code_and_undo_rewinds(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _, _ = manager(settings)
    task = tm.start("", "proj")
    for _ in range(50):
        if task.client is not None:
            break
        await asyncio.sleep(0.01)
    tm.set_mode(task.id, "plan")
    await asyncio.sleep(0.01)
    assert task.client.modes == ["plan"]
    tm.set_mode(task.id, "edits")
    await asyncio.sleep(0.01)
    assert task.client.modes == ["plan", "default"]
    assert "nothing to undo" in await tm.undo(task.id)
    tm._on_task_message(task, UserMessage(content="add a retry", uuid="u-1"))
    assert await tm.undo(task.id) == "Undone: the files are back as they were before that change."
    assert task.client.rewound == ["u-1"]
    assert (await tm.context_usage(task.id))["percent"] == 42
    assert (
        await tm.set_model(task.id, "claude-sonnet-5-5")
        and task.client.model == "claude-sonnet-5-5"
    )
    tm.cancel(task.id)


async def test_voice_focus_routes_speech_to_the_session(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    reply = await hub.voice_code("proj")
    assert reply.startswith("Voice coding in proj") and hub.voicecode.focus is not None
    task = hub.voicecode.task
    sent = []
    hub.tasks.send = lambda task_id, text: sent.append(text) or True
    hub._armed_until = __import__("time").monotonic() + 5
    await hub.on_heard("add a retry around the query")
    assert sent == ["add a retry around the query"] and hub.client.queries == []
    await hub.on_heard("Jarvis plan mode")
    assert task.mode == "plan" and said[-1].startswith("Plan mode")
    await hub.on_heard("Jarvis what changed")
    assert said[-1] == "No file changes yet in this session."
    await hub.on_heard("random chatter with no wake word")  # not armed: ignored
    assert len(sent) == 1
    task.result = "Added the retry and a test for it."
    task.files_changed = {"/p/hub.py", "/p/test_hub.py"}
    hub._task_event("task_finished", id=task.id, task_kind="code", status="done")
    assert said[-1] == "Added the retry and a test for it. 2 files changed."
    await hub.on_heard("Jarvis exit code mode")
    assert hub.voicecode.focus is None
    tm_task = hub.tasks.tasks[task.id]
    tm_task.handle.cancel()


async def test_focused_approvals_are_spoken_and_answered_by_choice(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    await hub.voice_code("proj")
    task = hub.voicecode.task
    pending = asyncio.create_task(
        hub._task_approval(
            "Claude Code in proj has a plan",
            "1. Add retry\n2. Test it",
            [
                ("plan_edits", "Go, auto-accept edits"),
                ("plan_ask", "Go, ask before edits"),
                ("plan_keep", "Keep planning"),
            ],
            {"task_id": task.id, "tool": "ExitPlanMode", "ask_kind": "plan"},
        )
    )
    await asyncio.sleep(0)
    assert said[-1].startswith("The plan has 2 steps.")
    hub._spoke_until = 0
    await hub.on_heard("go, ask before edits")
    assert await pending == "plan_ask"
    task.handle.cancel()
