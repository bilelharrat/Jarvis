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
    # Never ending on a word that answers it ("…OK?"), which it could hear back as a yes.
    assert vc.approval_speech(bash) == "It wants to run uv run pytest -q. Should it?"
    edit = {"tool": "Edit", "detail": "src/jarvis/hub.py\n- a\n+ b", "choices": []}
    assert vc.approval_speech(edit) == "It wants to edit hub dot py. Should it?"
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
    files = ["/p/hub.py", "/p/test_hub.py"]  # what this turn changed
    hub._task_event("task_finished", id=task.id, task_kind="code", status="done", files=files)
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


def test_stage_three_commands():
    assert kinds("repeat that", "say that again", "read the rest") == ["repeat", "repeat", "rest"]
    assert vc.parse("switch to the bsh research center project").arg == "bsh research center"
    assert vc.parse("resume the retry refactor session").arg == "retry refactor"
    assert vc.parse("reopen yesterday's billing work").kind == "resume"
    assert kinds("what branch am I on", "show me") == ["branch", "show"]
    # Everyday requests aren't mistaken for these.
    for request in (
        "pick up the pace on the tests",
        "open the config and bump the timeout",
        "show me how the parser handles tabs",
    ):
        assert vc.parse(request).kind == "send", request


async def test_replies_can_be_repeated_and_read_on(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    hub.prefs.code_sentences = 2
    await hub.voice_code("proj")
    task = hub.voicecode.task
    s = [
        "I added the retry around the query.",
        "It backs off twice before giving up.",
        "The tests pass again now.",
        "I also updated the README section.",
        "The config gained a new timeout value.",
        "There is one new test for the backoff.",
        "Nothing else changed in the project.",
    ]
    task.result = " ".join(s)
    hub._task_event("task_finished", id=task.id, task_kind="code", status="done")
    assert said[-1] == f"{s[0]} {s[1]} The rest is on screen."
    await hub.voicecode.handle("repeat that")
    assert said[-1] == f"{s[0]} {s[1]} The rest is on screen."
    await hub.voicecode.handle("read the rest")
    assert said[-1] == " ".join(s[2:6]) + " There's more; say read the rest."
    await hub.voicecode.handle("read the rest")
    assert said[-1] == s[6]
    task.handle.cancel()


async def test_stop_while_narrating_also_stops_claude(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.say = lambda text, follow_up=True: None
    await hub.voice_code("proj")
    task = hub.voicecode.task
    task.busy = True
    interrupted = []

    async def interrupt(task_id):
        interrupted.append(task_id)
        return True

    hub.tasks.interrupt = interrupt
    hub.state = "speaking"
    await hub.on_heard("stop")
    assert interrupted == [task.id]
    task.handle.cancel()


async def test_failures_are_mentioned_and_narration_can_be_off(
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
    hub.voicecode._narrated = 0
    hub._task_event("task_log", id=task.id, entry={"role": "tool", "text": "Editing hub.py"})
    assert said[-1] == "Editing hub dot py."
    hub.voicecode._narrated = 0
    hub._task_event("task_log_update", id=task.id, tool_id="t", status="failed", output="boom")
    assert said[-1] == "That step failed; it's looking into it."
    hub.prefs.code_narrate = False
    hub.voicecode._narrated = 0
    hub._task_event("task_log", id=task.id, entry={"role": "tool", "text": "Editing app.js"})
    assert said[-1] == "That step failed; it's looking into it."
    task.handle.cancel()


async def test_resume_a_past_session_by_name(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.say = lambda text, follow_up=True: None
    await hub.voice_code("proj")
    first = hub.voicecode.task
    hub.tasks.past_sessions = lambda directory, limit=20: [
        {
            "session_id": "s-billing",
            "title": "Billing export fix",
            "first_prompt": "fix the csv export",
            "last_modified": "",
            "branch": "",
        },
        {
            "session_id": "s-retry",
            "title": "Retry refactor for the query",
            "first_prompt": "add retries",
            "last_modified": "",
            "branch": "",
        },
    ]
    reply = await hub.resume_by_voice(first, "retry refactor")
    assert reply.startswith("Back in Retry refactor") and hub.voicecode.task.session_id == "s-retry"
    assert "couldn't tell" in await hub.resume_by_voice(first, "quantum widgets")
    for t in hub.tasks.tasks.values():
        t.handle.cancel()


async def test_typed_slash_commands_answer_in_the_transcript(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    spoken = []
    hub.say = lambda text, follow_up=True: spoken.append(text)
    task = hub.tasks.start("", "proj")
    q = hub.subscribe()
    await hub.handle({"type": "code_command", "id": task.id, "text": "/plan"})
    await asyncio.sleep(0.01)  # typed commands run in the background: they may be slow
    assert task.mode == "plan"
    await hub.handle({"type": "code_command", "id": task.id, "text": "/diff"})
    await asyncio.sleep(0.2)
    from test_hub import drain

    notes = [
        e["entry"]["text"]
        for e in drain(q)
        if e["type"] == "task_log" and e["entry"]["role"] == "note"
    ]
    assert notes == [vc.MODE_NAMES["plan"], "No file changes yet in this session."]
    assert spoken == []  # typed commands answer on screen, not out loud
    sent = []
    hub.tasks.send = lambda task_id, text: sent.append(text) or True
    await hub.handle({"type": "code_command", "id": task.id, "text": "/review-pr 12"})
    await asyncio.sleep(0.01)
    assert sent == ["/review-pr 12"]  # the project's own commands pass through to Claude Code
    await hub.handle({"type": "voicecode_start", "directory": "proj"})
    await asyncio.sleep(0.05)
    assert hub.voicecode.focus == task.id
    task.handle.cancel()


def test_voice_for_the_new_session_features():
    assert [vc.parse(u).arg for u in ("think harder", "ultrathink", "think less")] == [
        "up",
        "max",
        "low",
    ]
    assert kinds("fork this", "what's on the todo list", "export the transcript") == [
        "fork",
        "todos",
        "export",
    ]
    assert vc.parse("rename this session to retry work").arg == "retry work"
    assert vc.parse("rewind to before the tests").arg == "the tests"
    assert (
        vc.todo_speech(
            [
                {"content": "Add retry", "status": "completed", "active": ""},
                {"content": "Write test", "status": "in_progress", "active": "Writing the test"},
                {"content": "Update docs", "status": "pending", "active": ""},
            ]
        )
        == "1 of 3 done. Now: Writing the test. Still to do: Update docs."
    )


async def test_always_and_no_with_feedback_by_voice(settings, quiet_speaker, isolated):
    import asyncio

    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    choices = [
        ("allow", "Yes"),
        ("always", "Yes, and don't ask again for git commit commands"),
        ("deny", "No, and tell Claude what to do differently"),
    ]

    async def asked(question, detail):  # put out loud, so a spoken answer counts
        hub._say(question)
        return await hub.request_approval(question, detail, choices, {"task_id": 1, "tool": "Bash"})

    first = asyncio.create_task(asked("Commit it with git?", "$ git commit"))
    await asyncio.sleep(0)
    hub._spoke_until = 0
    await hub.on_heard("yes, always allow that")
    assert await first == "always"
    second = asyncio.create_task(asked("Build it with make?", "$ make"))
    await asyncio.sleep(0)
    await hub.on_heard("no, use the Makefile target instead")
    assert await second == "deny:use the Makefile target instead"


BASH = {
    "question": "Jarvis Code in proj wants to run a command",
    "tool": "Bash",
    "task_id": 1,
    "choices": [
        {"id": "allow", "label": "Yes"},
        {"id": "always", "label": "Yes, and don't ask again for npm test commands in proj"},
        {"id": "deny", "label": "No, and tell Claude what to do differently"},
    ],
}
EDIT = {
    **BASH,
    "tool": "Edit",
    "choices": [
        {"id": "allow", "label": "Yes"},
        {"id": "allow_edits", "label": "Yes, allow all edits this session"},
        {"id": "deny", "label": "No, and tell Claude what to do differently"},
    ],
}
PLAN = {
    "question": "Jarvis Code in proj has a plan",
    "ask_kind": "plan",
    "task_id": 1,
    "choices": [
        {"id": "plan_edits", "label": "Go, auto-accept edits"},
        {"id": "plan_ask", "label": "Go, ask before edits"},
        {"id": "plan_keep", "label": "Keep planning"},
    ],
}


def test_hesitations_and_refusals_never_approve():
    answer = vc.voice_answer
    for waiting in ("hold on a second", "wait a second", "give me a second", "one sec",
                    "hmm, give me a second", "one moment", "yes, but wait"):  # fmt: skip
        assert answer(waiting, BASH) == (vc.HOLD, ""), waiting
    assert answer("no, wait one second", BASH) == ("deny", "")
    assert answer("no, make it two spaces", EDIT) == ("deny", "make it two spaces")
    assert answer("No, you always do that, use make clean", BASH) == (
        "deny",
        "you always do that, use make clean",
    )
    assert answer("no, one more thing", EDIT)[0] == "deny"
    assert answer("yes, but ask me every time", BASH) == ("allow", "")
    assert answer("yes, but use make instead", BASH) == ("deny", "use make instead")
    assert answer("don't forget to add tests", BASH) is None  # a request, not an answer
    # "always" and "all edits" only when said plainly; never by a number or with a no.
    assert answer("option two", BASH) == (vc.REASK, "")
    assert answer("the second one", EDIT) == (vc.REASK, "")
    assert answer("yes, always", BASH) == ("always", "")
    assert answer("Don't ask me again", BASH) == ("always", "")
    assert answer("yes, allow all edits", EDIT) == ("allow_edits", "")
    assert answer("option one", BASH) == ("allow", "")
    assert answer("sure", EDIT) == ("allow", "")


def test_a_question_is_not_answered_by_its_own_opening_word():
    send = {
        "question": "Send this to Ben?",
        "choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "Don't send"}],
    }
    assert vc.voice_answer("Send this to Ben?", send) is None  # its own voice, heard back
    assert vc.voice_answer("send", send) is None
    assert vc.voice_answer("yes, send it", send) == ("allow", "")
    assert vc.voice_answer("don't send it", send) == ("deny", "")
    shortcut = {
        "question": "Run the shortcut “Unlock Front Door”?",
        "choices": [
            {"id": "allow", "label": "Run"},
            {"id": "always", "label": "Always"},
            {"id": "deny", "label": "Not now"},
        ],
    }
    assert vc.voice_answer("Run the shortcut Unlock Front Door?", shortcut) is None
    assert vc.voice_answer("always", shortcut) == ("always", "")


def test_plans_by_voice():
    answer = vc.voice_answer
    for go in ("go", "yes", "sure", "go ahead", "go, ask before edits"):
        assert answer(go, PLAN) == ("plan_ask", ""), go  # a plain go still asks before edits
    assert answer("go with auto-edits", PLAN) == ("plan_edits", "")
    assert answer("keep planning", PLAN) == ("plan_keep", "")
    assert answer("no, split step two into two steps", PLAN) == (
        "plan_keep",
        "split step two into two steps",
    )
    assert answer("option one", PLAN) == (vc.REASK, "")  # never auto-edits by number
    assert answer("the last one", PLAN) == ("plan_keep", "")
    assert "Say go, go with auto-edits, or keep planning." in vc.approval_speech(
        {**PLAN, "detail": "1. Add a cache"}
    )


def test_the_last_option_is_the_last_one_said_not_skip():
    q = {
        "ask_kind": "question",
        "question": "Which database?",
        "choices": [
            {"id": "opt0", "label": "SQLite"},
            {"id": "opt1", "label": "Postgres"},
            {"id": "skip", "label": "Skip"},
        ],
    }
    assert vc.voice_answer("the last one", q) == ("opt1", "")
    assert vc.voice_answer("option 2", q) == ("opt1", "")
    assert vc.voice_answer("option three", q) == (vc.REASK, "")
    assert vc.voice_answer("skip it", q) == ("skip", "")
    assert vc.voice_answer("yes", q) == (vc.REASK, "")  # "yes" doesn't answer "which one?"
    assert vc.voice_answer("not postgres", q) == (vc.REASK, "")


def test_everyday_coding_requests_are_never_session_commands():
    for request in (
        "rename the parse function to parse input",
        "compact the json output",
        "use haiku for the summaries",
        "make the pr template shorter",
        "what is the plan for caching",
        "increase the context window size",
        "what does the cost function return",
        "open the src folder",
        "resume the upload after a failure",
        "what is the first change we should make to the parser",
        "don't ask me to confirm the delete, just refactor it",
        "go back to when the user clicks save",
    ):
        intent = vc.parse(request)
        assert intent.kind == "send" and intent.text == request, request
    assert vc.parse("rename this session to retry work").arg == "retry work"
    assert vc.parse("compact the conversation").kind == "compact"
    assert vc.parse("what is the plan").kind == "plan"
    assert vc.parse("explain the 2nd change").arg == 1


async def test_a_mode_with_a_request_says_the_mode_it_set(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said, sent = [], []
    hub.say = lambda text, follow_up=True: said.append(text)
    hub.acknowledge = lambda: None
    await hub.voice_code("proj")
    task = hub.voicecode.task
    hub.tasks.send = lambda task_id, text: sent.append(text) or True
    await hub.voicecode.handle("full auto and fix the tests")
    assert task.mode == "auto" and said[-1] == "Full auto. On it." and sent == ["fix the tests"]
    await hub.voicecode.handle("accept edits, then add a retry")
    assert task.mode == "edits" and said[-1] == "Auto-edits. On it." and sent[-1] == "add a retry"
    task.handle.cancel()


async def test_typed_slash_commands_keep_what_follows_them(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    task = hub.tasks.start("", "proj")
    sent, models = [], []
    hub.tasks.send = lambda task_id, text: sent.append(text) or True

    async def set_model(task_id, model):
        models.append(model)
        return True

    hub.tasks.set_model = set_model
    await hub._code_command(task, "/plan fix the login flow")
    assert task.mode == "plan" and sent[-1] == "fix the login flow"
    await hub._code_command(task, "/commit Fix the retry")
    assert "Fix the retry" in sent[-1]
    await hub._code_command(task, "/test tests/test_hub.py")
    assert "tests/test_hub.py" in sent[-1]
    await hub._code_command(task, "/model claude-sonnet-5-5")
    assert models == ["claude-sonnet-5-5"] and not sent[-1].startswith("use ")
    task.handle.cancel()


async def test_rewinding_by_voice_asks_first(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.say = lambda text, follow_up=True: None
    await hub.voice_code("proj")
    task = hub.voicecode.task
    for n, text in enumerate(["add the tests", "fix the tests", "rename things"], 1):
        hub.tasks._log(task, "user", text)
        task.transcript[-1]["uuid"] = f"u-{n}"
    rewound = []

    async def rewind_to(task_id, uuid):
        rewound.append(uuid)
        return "Rewound."

    hub.tasks.rewind_to = rewind_to
    await hub.voicecode.handle("rewind to before the tests")
    await asyncio.sleep(0)
    assert rewound == [] and hub.approvals  # nothing happens until the user says yes
    approval = next(iter(hub.approvals.values()))
    assert "fix the tests" in approval["question"]  # the latest match, not the earliest
    hub.resolve(approval["id"], "allow")
    await asyncio.sleep(0.01)
    assert rewound == ["u-2"]
    task.handle.cancel()


async def test_a_turn_without_words_doesnt_repeat_the_last_reply(
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
    task.result = "Added the retry."
    hub._task_event("task_finished", id=task.id, task_kind="code", status="done", files=[])
    task.result = ""  # the next turn only ran commands
    hub._task_event("task_finished", id=task.id, task_kind="code", status="done", files=[])
    assert said[-2:] == ["Added the retry.", "Done."]
    task.handle.cancel()
