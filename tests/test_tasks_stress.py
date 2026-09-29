"""Jarvis Code under a second stress sweep: many sessions at once, bursts of queue, steer
and interrupt, rewind and fork at their edges, very long and non-ASCII transcripts, mode
and model switches mid-run, and what a fork, an undo and a slash command carry over."""

import asyncio

from claude_agent_sdk import AssistantMessage, TextBlock, UserMessage
from test_tasks import StreamClient, res, stream_manager, until

from jarvis import tasks as tasks_mod
from jarvis.tasks import ClaudeTask, _session_title


async def _open(tm, name="proj", prompt="", **kw):
    task = tm.start(prompt, name, **kw)
    assert await until(lambda: task.status == "waiting", tries=600)
    return task


async def test_thirty_sessions_with_queues_each_get_their_own_replies(settings, tmp_path):
    for i in range(30):
        (tmp_path / f"p{i}").mkdir()
    tm, events = stream_manager(settings)
    started = [tm.start(f"first {i}", f"p{i}") for i in range(30)]
    for i, task in enumerate(started):
        for k in range(4):
            assert tm.send(task.id, f"s{i} m{k}")
    assert await until(
        lambda: all(not t.busy and t.inbox.empty() and t.status == "waiting" for t in started),
        tries=3000,
    )
    for i, task in enumerate(started):
        said = [e["text"] for e in task.transcript if e["role"] == "user"]
        assert said == [f"first {i}", *(f"s{i} m{k}" for k in range(4))]
        assert len(task.checkpoints) == 5
        assert task.cost_usd == 0.5  # five turns at 0.1 each, one connection's running total
    finished = [d for k, d in events if k == "task_finished"]
    assert {d["id"] for d in finished} == {t.id for t in started}
    for task in started:
        tm.cancel(task.id)
    await asyncio.gather(*(t.handle for t in started), return_exceptions=True)


async def test_rapid_queue_unqueue_interrupt_bursts_lose_and_duplicate_nothing(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm)
    client = task.client
    client.held = []  # every step is long: it ends on release()
    tm.send(task.id, "long job")
    assert await until(lambda: task.busy)
    ids = []
    for k in range(40):
        tm.send(task.id, f"q{k}", steer=False)
        ids.append(task.inbox.public()[-1]["id"] if task.inbox.qsize() <= 20 else None)
    for item_id in ids[::2]:
        if item_id is not None:
            tm.unqueue(task.id, item_id)
    for _ in range(5):
        await tm.interrupt(task.id)
    client.release()
    client.held = None
    assert await until(lambda: task.inbox.empty() and not task.busy, tries=2000)
    said = [e["text"] for e in task.transcript if e["role"] == "user"]
    expected = ["long job", *(f"q{k}" for k in range(40) if k % 2 or k >= 20)]
    assert said == expected  # in order, each once
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_a_full_queue_says_no_and_keeps_order(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm)
    task.client.held = []
    tm.send(task.id, "long job")
    assert await until(lambda: task.busy)
    results = [tm.send(task.id, f"q{k}", steer=False) for k in range(tasks_mod.MAX_QUEUED + 5)]
    assert results.count(False) == 5 and all(results[: tasks_mod.MAX_QUEUED])
    assert task.inbox.qsize() == tasks_mod.MAX_QUEUED
    assert len(task.inbox.public()) == tasks_mod.QUEUE_SHOWN
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_a_long_session_keeps_its_bounds(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm)
    for batch in range(6):  # (a queue holds MAX_QUEUED at most)
        for k in range(50):
            assert tm.send(task.id, f"m{batch * 50 + k}")
        assert await until(lambda: task.inbox.empty() and not task.busy, tries=3000)
    assert len(task.transcript) == 400  # the kept entries
    assert len(task.checkpoints) == 50 and task.checkpoints[-1] == "u-300"
    assert len(task.fork_points) <= 200
    assert abs(task.cost_usd - 30.0) < 1e-6
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_rewind_edges(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, prompt="one")
    for text in ("two", "three"):
        tm.send(task.id, text)
    assert await until(lambda: len(task.checkpoints) == 3 and not task.busy)
    assert task.checkpoints == ["u-1", "u-2", "u-3"]
    assert "too far back" in await tm.rewind_to(task.id, "u-nope")
    assert (await tm.rewind_to(task.id, "u-2")).startswith("Rewound")
    assert task.checkpoints == ["u-1"] and task.client.rewound == ["u-2"]
    assert "too far back" in await tm.rewind_to(task.id, "u-3")  # already undone
    assert (await tm.rewind_to(task.id, "u-1")).startswith("Rewound")
    assert task.checkpoints == []
    assert "nothing to undo" in await tm.undo(task.id)
    assert await tm.rewind_to(999, "u-1") == "That session is gone."
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_rewind_while_busy_refuses_and_changes_nothing(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, prompt="one")
    task.client.held = []
    tm.send(task.id, "two")
    assert await until(lambda: task.busy)
    assert "still working" in await tm.rewind_to(task.id, "u-1")
    assert "still working" in (await tm.undo(task.id)).lower()
    assert task.checkpoints == ["u-1"] and not getattr(task.client, "rewound", [])
    task.client.release()
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_undo_reopens_a_closed_session_as_rewind_does(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks_mod, "IDLE_CLOSE_SECONDS", 0.2)
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = tm.start("change a.py", "proj")
    assert await until(lambda: task.checkpoints == ["u-1"])
    assert await until(lambda: task.status == "closed" and task.client is None, tries=600)
    monkeypatch.setattr(tasks_mod, "IDLE_CLOSE_SECONDS", 60)
    reply = await tm.undo(task.id)
    assert reply.startswith("Undone"), reply
    assert StreamClient.instances[-1].rewound == ["u-1"] and task.checkpoints == []
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_undo_forgets_only_the_last_rounds_files(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, prompt="one")
    task.files_changed = {"early.py", "late.py"}
    task.turn_files = {"late.py"}
    task.checkpoint_files = {"u-1": {"late.py"}}
    assert (await tm.undo(task.id)).startswith("Undone")
    assert task.files_changed == {"early.py"}
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_a_fork_keeps_the_sessions_model_folders_connectors_and_ultracode(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    extra = tmp_path / "proj-docs"
    extra.mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(
        tm,
        prompt="one",
        model="gemini-3-pro",
        model_label="Gemini 3 Pro",
        model_ref="custom:g",
        env={"ANTHROPIC_API_KEY": ""},
        provider_settings='{"apiKeyHelper": "x"}',
        ultracode=True,
        add_dirs=[str(extra)],
        effort="high",
    )
    tm.set_mcp(task.id, "github", False)
    fork = tm.fork(task.id)
    assert fork is not None
    for name in (
        "model",
        "model_label",
        "model_ref",
        "env",
        "provider_settings",
        "ultracode",
        "add_dirs",
        "plugins",
        "disabled_mcp",
        "effort",
        "mode",
    ):
        assert getattr(fork, name) == getattr(task, name), name
    assert fork.env is not task.env and fork.add_dirs is not task.add_dirs  # copies
    fork.add_dirs.append("/elsewhere")
    assert task.add_dirs == [str(extra.resolve())]
    for t in (task, fork):
        tm.cancel(t.id)
    await asyncio.gather(task.handle, fork.handle, return_exceptions=True)


async def test_fork_from_the_first_message_is_a_clean_slate_and_later_ones_resume_at(
    settings, tmp_path
):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, prompt="one")
    tm.send(task.id, "two")
    assert await until(lambda: len(task.checkpoints) == 2 and not task.busy)
    first = tm.fork(task.id, "u-1")
    assert first.session_id == "" and not first.fork and first.resume_at == ""
    second = tm.fork(task.id, "u-2")
    assert second.fork and second.session_id == "s" and second.resume_at == "a-1"
    assert tm.fork(task.id, "u-nope") is None
    assert tm.fork(12345) is None
    for t in (task, first, second):
        tm.cancel(t.id)
    await asyncio.gather(task.handle, first.handle, second.handle, return_exceptions=True)


async def test_a_mode_burst_mid_step_sends_only_where_it_ended(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, prompt="one", model="claude-opus-5-5")
    task.client.held = []
    tm.send(task.id, "two")
    assert await until(lambda: task.busy)
    for mode in ("plan", "ask", "edits", "plan", "smart", "auto", "plan") * 5:
        assert tm.set_mode(task.id, mode)
    assert await until(lambda: not task.applying_mode)
    modes = task.client.modes
    assert modes[-1] == "plan" and len(modes) <= 3, modes
    assert task.mode == "plan" and not task.allow_edits
    task.client.release()
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_unicode_titles_messages_and_exports(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks_mod, "EXPORT_DIR", tmp_path / "export")
    (tmp_path / "项目").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm, name="项目")
    tm.send(task.id, "修复登录 bug 🐛，然后运行测试。第二句话。")
    assert await until(lambda: len(task.checkpoints) == 1 and not task.busy)
    assert task.title == "修复登录 bug 🐛，然后运行测试。第二句话。"[:80]
    assert tm.rename(task.id, "  重命名 \n 🚀  ")
    assert task.title == "重命名 🚀"
    path = tm.export(task.id)
    body = path.read_text()
    assert "# 重命名 🚀" in body and "> 修复登录 bug 🐛" in body
    assert path.name.endswith(" Session.md")  # no ASCII to name it by
    again = tm.export(task.id)
    assert again != path and path.exists()  # a second export never overwrites the first
    assert _session_title("🐛 " * 20).endswith("…")
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_interrupt_between_turns_and_on_a_gone_session_is_a_no(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm)
    assert not await tm.interrupt(task.id)  # nothing running
    assert not await tm.interrupt(4242)
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)
    assert not await tm.interrupt(task.id)


async def test_resume_twice_is_one_session(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    first = tm.start("", "proj", resume="abc")
    again = tm.start("hello", "proj", resume="abc")
    third = tm.start("", "proj", resume="abc")
    assert first is again is third and len(tm.tasks) == 1
    assert await until(lambda: any(e["text"] == "hello" for e in first.transcript))
    tm.cancel(first.id)
    await asyncio.gather(first.handle, return_exceptions=True)


async def test_turns_it_starts_itself_during_a_burst_keep_the_user_turns_straight(
    settings, tmp_path
):
    (tmp_path / "proj").mkdir()
    tm, events = stream_manager(settings)
    task = await _open(tm)
    client = task.client
    for k in range(10):
        tm.send(task.id, f"m{k}")
        client.inject(f"bg {k}")
    assert await until(lambda: task.inbox.empty() and not task.busy, tries=2000)
    user = [e["text"] for e in task.transcript if e["role"] == "user"]
    assert user == [f"m{k}" for k in range(10)]
    assert not task.injected and task.turns_pending == 0 and task.current == ""
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_an_odd_message_never_ends_the_session(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = stream_manager(settings)
    task = await _open(tm)
    stream = task.client._stream()
    stream.put_nowait(object())
    stream.put_nowait(UserMessage(content=[], uuid=None))
    stream.put_nowait(AssistantMessage(content=[TextBlock(text="   ")], model="m"))
    stream.put_nowait(res("", None))
    await asyncio.sleep(0.05)
    assert task.handle is not None and not task.handle.done()
    tm.send(task.id, "still there?")
    assert await until(lambda: task.result.startswith("reply"))
    tm.cancel(task.id)
    await asyncio.gather(task.handle, return_exceptions=True)


def test_session_task_public_is_json_safe():
    import json

    task = ClaudeTask(id=1, prompt="x" * 10_000, cwd=__import__("pathlib").Path("/tmp"))
    task.files_changed = {f"f{i}.py" for i in range(500)}
    data = task.public()
    json.dumps(data)
    assert len(data["files_changed"]) == 50 and len(data["prompt"]) == 500


async def test_a_rewind_forgets_the_files_only_the_rewound_rounds_changed(settings, tmp_path):
    from claude_agent_sdk import ToolResultBlock, ToolUseBlock
    from conftest import FakeClient

    tm, _ = stream_manager(settings)
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path)
    tm.tasks[1] = task
    task.client = FakeClient()

    def round_(uid, *paths):
        tm._on_task_message(task, UserMessage(content="go", uuid=uid))
        for i, path in enumerate(paths):
            tool_id = f"{uid}-{i}"
            block = ToolUseBlock(id=tool_id, name="Edit", input={"file_path": path})
            tm._on_task_message(task, AssistantMessage(content=[block], model="m"))
            ok = ToolResultBlock(tool_use_id=tool_id, content="ok", is_error=False)
            tm._on_task_message(task, UserMessage(content=[ok]))
        tm._on_task_message(task, res("", 0.1))

    round_("u-1", "a.py")
    round_("u-2", "a.py", "b.py")
    round_("u-3", "c.py")
    assert task.files_changed == {"a.py", "b.py", "c.py"}
    assert (await tm.rewind_to(1, "u-2")).startswith("Rewound")
    assert task.files_changed == {"a.py"}  # still changed by the first round
    assert set(task.checkpoint_files) == {"u-1"}
    assert (await tm.undo(1)).startswith("Undone")
    assert task.files_changed == set() and task.checkpoint_files == {}


async def test_clear_starts_a_fresh_conversation_set_up_as_the_session_was(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    (tmp_path / "proj").mkdir()
    extra = tmp_path / "docs"
    extra.mkdir()
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    task = hub.tasks.start(
        "",
        "proj",
        mode="edits",
        model="claude-sonnet-5-5",
        model_label="Sonnet 5.5",
        model_ref="sonnet",
        effort="low",
        ultracode=True,
        add_dirs=[str(extra)],
    )
    hub.tasks.set_mcp(task.id, "github", False)
    await hub._code_command(task, "/clear")
    fresh = max(hub.tasks.tasks.values(), key=lambda t: t.id)
    assert fresh is not task and fresh.session_id == "" and not fresh.fork
    for name in ("cwd", "mode", "model", "model_label", "model_ref", "effort", "ultracode"):
        assert getattr(fresh, name) == getattr(task, name), name
    assert fresh.add_dirs == [str(extra.resolve())] and fresh.disabled_mcp == {"github"}
    opts = hub.tasks.options_for(fresh)
    assert opts.model == "claude-sonnet-5-5" and opts.effort == "low" and opts.resume is None
    assert not [e for e in fresh.transcript if e["role"] == "system"]  # no "Added…" notes
    assert hub.tasks.start_like(9999) is None
    for t in (task, fresh):
        t.handle.cancel()
