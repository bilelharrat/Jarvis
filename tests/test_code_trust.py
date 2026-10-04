"""Jarvis Code's three trust guarantees, end to end: a chat is still there after a restart,
with the same id (the window's selection holds) and its history loads even when the first
read fails; Steer shows for the whole of a busy turn, before it's open and across a
reconnect; and no chat is ever lost, however many end."""

import json

from code_session_fakes import CONVERSATION, Stream, end_all, make_hub, until

import jarvis.tasks as tasks_module

# ── restart: the chat is there, with its id, and loads ──


async def test_a_chat_keeps_its_id_across_a_restart_and_its_history_loads_after_a_failed_read(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    warm = hub.tasks.start("warm up", "proj", isolate=False)  # (takes id 1: the next is 2)
    assert await until(lambda: warm.status == "waiting" and warm.session_id)
    warm.session_id = "s-warm"  # (the fake gives every conversation the same id)
    task = hub.tasks.start("fix the login", "proj", isolate=False)
    assert await until(lambda: task.status == "waiting" and task.session_id)
    old_id = task.id
    await hub.code_sessions.flush(final=True)
    await end_all(hub)

    reads = {"n": 0}

    def flaky(sid, directory):
        reads["n"] += 1
        if reads["n"] == 1:
            raise OSError("the disk was busy")
        return CONVERSATION

    monkeypatch.setattr(tasks_module, "get_session_messages", flaky)
    monkeypatch.setattr(tasks_module, "cached_history", lambda *a: None)
    monkeypatch.setattr(tasks_module, "session_history_tail", lambda *a: None)
    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    back = again.tasks.tasks.get(old_id)
    assert back is not None and back.prompt == "fix the login"  # same id: still selected
    await again._handle({"type": "code_session_open", "id": back.id})
    assert back.history_read and reads["n"] >= 2
    assert [e["text"] for e in back.transcript if e["role"] == "user"][:1] == ["add a retry"]
    fresh = again.tasks.start("new one", "proj", isolate=False)
    assert fresh.id not in (1, old_id)  # new ids start past the kept ones'
    await end_all(again)


# ── Steer: visible for the whole busy turn ──


async def test_steer_shows_while_busy_and_a_steer_before_it_is_open_goes_first(settings, tmp_path):
    async def approve(*_a, **_k):
        return "deny"

    tm = tasks_module.TaskManager(settings, approve, lambda kind, **d: None, Stream)
    task = tasks_module.ClaudeTask(id=1, prompt="long job", cwd=tmp_path)
    tm.tasks[1] = task
    task.busy = True  # starting: Claude Code not open yet
    assert task.steerable and task.public()["steerable"]
    await tm._steer(task, "use the v2 api", [])
    assert task.inbox._items[0]["text"] == "use the v2 api" and task.steered == 0
    task.current, task.client = "claude", object()  # a turn Claude Code began itself
    assert task.steerable and task.steer_ready
    task.ending = True  # End pressed: nothing more goes in
    assert not task.steerable
    task.ending, task.busy = False, False
    assert not task.steerable


# ── no chat is ever lost ──


async def test_twenty_one_and_more_ended_chats_none_vanish(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    cs = hub.code_sessions
    await cs.restore()
    count = tasks_module.MAX_ENDED + 5
    ids = []
    for n in range(count):
        t = hub.tasks.start(f"job {n}", "proj", isolate=False)
        assert await until(lambda t=t: t.status == "waiting" and t.session_id)
        t.session_id = f"s-{n}"  # (the fake gives every conversation the same id)
        hub.tasks.cancel(t.id)
        await until(lambda t=t: t.handle.done())
        ids.append(t.id)
        cs._save_now()
        await until(lambda: not cs._saving)
    assert len([t for t in hub.tasks.tasks.values() if t.kind == "code"]) <= tasks_module.MAX_ENDED
    await cs.flush(final=True)
    files = [f for f in (tmp_path / "code_sessions").glob("*.json") if f.stem != "remembered"]
    assert len(files) == count  # every one kept on disk
    kept = {h["session_id"] for h in cs.more_history()}
    listed = {t.session_id for t in hub.tasks.tasks.values()}
    assert {f"s-{n}" for n in range(count)} <= kept | listed  # each findable
    await end_all(hub)

    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    history = {h["session_id"] for h in again.tasks.recent_sessions()}
    listed = {t.session_id for t in again.tasks.tasks.values()}
    assert {f"s-{n}" for n in range(count)} <= history | listed
    # The oldest, reopened from the history: back with its own id and settings.
    task = again.tasks.start("", "proj", resume="s-0")
    assert task.id == ids[0] and task.prompt == "job 0"
    saved = json.loads(next((tmp_path / "code_sessions").glob("*.json")).read_text())
    assert "id" in saved
    await end_all(again)
