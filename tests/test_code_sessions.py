"""Jarvis Code sessions across a restart (features.code_sessions): kept with how they were
set, back resting (no Claude Code started) and resumed lazily; a damaged file; rewinding a
reopened session and rewinding the conversation in place; edit and resend."""

import asyncio
import json
import os

import pytest
from code_session_fakes import CONVERSATION, Stream, end_all, events_of, make_hub, until

import jarvis.tasks as tasks_module


@pytest.fixture
def history(monkeypatch):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)


# ── kept across a restart ──


async def test_open_sessions_come_back_resting_as_they_were_set(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    (tmp_path / "extra").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    cs = hub.code_sessions
    assert await cs.restore() == 0 and cs.armed
    tm = hub.tasks
    task = tm.start(
        "fix the login",
        "proj",
        mode="edits",
        effort="max",
        ultracode=True,
        add_dirs=[str(tmp_path / "extra")],
    )
    assert await until(lambda: task.status == "waiting" and task.session_id == "s")
    tm.set_mcp(task.id, "github", False)  # (reopens it, between turns)
    assert await until(lambda: len(Stream.instances) == 2 and task.client is Stream.instances[1])
    tm._audit(task, "Bash", {"command": "ls"}, "auto", "a read-only command")
    await hub._handle({"type": "code_meta_set", "id": task.id, "pinned": True, "group": "Backend"})
    await hub._handle({"type": "code_draft", "id": task.id, "text": "half a thought"})
    task.client.hold = True
    tm.send(task.id, "second")
    assert await until(lambda: task.busy)
    tm.send(task.id, "third")  # waits behind the step
    await cs.flush(final=True)  # the app quits: saved as it was before anything stopped
    await end_all(hub)
    files = [f for f in (tmp_path / "code_sessions").glob("*.json") if f.stem != "remembered"]
    assert len(files) == 1
    saved = json.loads(files[0].read_text())
    assert saved["cwd"] == str((tmp_path / "proj").resolve()) and saved["was_working"]
    assert oct(os.stat(files[0]).st_mode & 0o777) == "0o600"

    Stream.instances = []
    again = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(again)
    assert await again.code_sessions.restore() == 1
    [back] = again.tasks.tasks.values()
    assert back.status == "resting" and back.handle is None and Stream.instances == []
    assert (back.mode, back.effort, back.ultracode) == ("edits", "max", True)
    assert back.add_dirs == [str((tmp_path / "extra").resolve())]
    assert back.disabled_mcp == {"github"} and back.session_id == "s"
    assert [i["text"] for i in back.inbox._items] == ["second", "third"]  # in order
    assert back.audit[-1]["why"] == "a read-only command"
    assert "restarted while this session was working" in back.transcript[-1]["text"]
    meta = [e for e in seen() if e["type"] == "code_meta"][-1]["items"][str(back.id)]
    assert meta["pinned"] and meta["group"] == "Backend" and meta["draft"] == "half a thought"
    assert meta["resting"] and not meta["history"]
    item = again.tasks.public()[0]
    assert item["status"] == "resting" and item["queued"] == 2


async def test_a_resting_session_reads_its_history_when_opened_and_resumes_on_a_message(
    settings, quiet_speaker, isolated, tmp_path, history
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    task = hub.tasks.start("add a retry", "proj", mode="plan", effort="low")
    assert await until(lambda: task.status == "waiting")
    await hub.code_sessions.flush(final=True)
    await end_all(hub)

    Stream.instances = []
    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    [back] = again.tasks.tasks.values()
    await again._handle({"type": "code_session_open", "id": back.id})
    # Its conversation is back, with the points to rewind to, and still no Claude Code.
    assert [e["text"] for e in back.transcript if e["role"] == "user"][:2] == [
        "add a retry",
        "now the tests",
    ]
    assert back.checkpoints == ["u-1", "u-2"] and Stream.instances == []
    assert back.checkpoint_files == {"u-1": {"/p/net.py"}, "u-2": {"/p/test_net.py"}}
    assert back.status == "resting"
    assert again.tasks.send(back.id, "carry on")
    assert await until(lambda: back.status == "waiting" and Stream.instances)
    opts = Stream.instances[0].options
    assert opts.resume == "s" and opts.permission_mode == "plan" and opts.effort == "low"
    assert Stream.instances[0].queries == ["carry on"]
    await end_all(again)


async def test_ended_sessions_come_back_ended_and_a_resting_one_can_be_ended(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    done = hub.tasks.start("one", "proj")
    # Sharing the folder on purpose: no isolated copy offered for a second session there.
    open_one = hub.tasks.start("two", "proj", isolate=False)
    assert await until(lambda: done.status == "waiting" and open_one.status == "waiting")
    open_one.session_id = "s-two"  # (the fake gives every conversation the same id)
    hub.tasks.cancel(done.id)
    await asyncio.gather(done.handle, return_exceptions=True)
    await hub.code_sessions.flush(final=True)
    await end_all(hub)

    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    by_prompt = {t.prompt: t for t in again.tasks.tasks.values()}
    assert by_prompt["one"].status == "stopped" and by_prompt["two"].status == "resting"
    assert again.tasks.cancel(by_prompt["two"].id)  # End on a resting one: nothing runs
    assert by_prompt["two"].status == "stopped"


async def test_a_damaged_or_unreadable_session_file_never_stops_the_rest(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    proj = str((tmp_path / "proj").resolve())
    (folder / "aaaaaaaaaaaaaaaa.json").write_text("{not json")
    (folder / "bbbbbbbbbbbbbbbb.json").write_text(
        json.dumps({"cwd": proj, "session_id": "s-ok", "mode": "yolo", "effort": 7,
                    "queue": [{"text": "hi"}, "junk", {"text": ""}], "audit": "no",
                    "cost_usd": float("nan"), "commands": -3, "pinned": "yes"})
    )  # fmt: skip
    (folder / "cccccccccccccccc.json").write_text(json.dumps({"cwd": "relative/path"}))
    locked = folder / "dddddddddddddddd.json"
    locked.write_text(json.dumps({"cwd": proj, "session_id": "s-locked"}))
    locked.chmod(0)
    try:
        hub = make_hub(settings, quiet_speaker, isolated)
        assert await hub.code_sessions.restore() == 1
        [back] = hub.tasks.tasks.values()
        assert back.session_id == "s-ok" and back.mode == "ask" and back.effort == ""
        assert [i["text"] for i in back.inbox._items] == ["hi"] and back.audit == []
        assert back.cost_usd is None and back.commands == 0
        assert list(folder.glob("aaaaaaaaaaaaaaaa.json.bad-*"))  # kept aside, not thrown away
        await hub.code_sessions.flush(final=True)
        locked.chmod(0o600)
        assert json.loads(locked.read_text())["session_id"] == "s-locked"  # never saved over
    finally:
        locked.chmod(0o600)


async def test_nothing_is_saved_before_the_kept_sessions_are_read_back(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    kept = folder / "eeeeeeeeeeeeeeee.json"
    kept.write_text(json.dumps({"cwd": str((tmp_path / "proj").resolve()), "session_id": "old"}))
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("new", "proj")
    assert await until(lambda: task.status == "waiting")
    await hub.code_sessions.flush(final=True)  # not armed: it would have dropped the old one
    assert kept.exists()
    await end_all(hub)


async def test_a_resumed_past_session_starts_as_it_last_ran(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    task = hub.tasks.start("one", "proj", mode="edits", effort="max")
    assert await until(lambda: task.status == "waiting")
    hub.tasks.set_mode(task.id, "auto")  # Bypass is never brought back by itself
    await hub.code_sessions.flush(final=True)
    await end_all(hub)
    hub.tasks.tasks.clear()
    assert hub.tasks.defaults_for("proj", "s") == {"effort": "max", "ultracode": False}
    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    again.tasks.tasks.clear()  # as if it had been pruned from the list
    await again._handle({"type": "task_new", "directory": "proj", "session_id": "s", "prompt": ""})
    [resumed] = again.tasks.tasks.values()
    assert resumed.effort == "max" and resumed.mode == "ask"
    await end_all(again)


# ── rewinding ──


async def test_the_conversation_rewinds_in_place_and_goes_on_from_there(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    tm = hub.tasks
    task = tm.start("one", "proj")
    assert await until(lambda: task.status == "waiting" and task.result == "reply 1")
    tm.send(task.id, "two")
    assert await until(lambda: task.checkpoints == ["u-1", "u-2"] and task.status == "waiting")
    await hub._handle({"type": "code_rewind", "id": task.id, "uuid": "u-2", "text": "two, better"})
    rewound = [e for e in seen() if e["type"] == "code_rewound"][-1]
    assert rewound["ok"] and "Rewound the conversation" in rewound["text"]
    assert [e["text"] for e in task.transcript if e["role"] == "user"][-1] != "two"
    # Reopened in the same session, at the entry before "two", then the new words sent.
    assert await until(
        lambda: len(Stream.instances) == 2 and task.status == "waiting" and task.result
    )
    opts = Stream.instances[1].options
    assert opts.resume == "s" and opts.resume_session_at == "a-1" and not opts.fork_session
    assert Stream.instances[1].queries == ["two, better"]
    assert await until(lambda: task.resume_at == "")  # later reconnects carry on from there
    assert tm.options_for(task).resume_session_at is None
    users = [e["text"] for e in task.transcript if e["role"] == "user"]
    assert users == ["one", "two, better"]
    await end_all(hub)


async def test_rewinding_before_the_first_message_starts_afresh_and_files_can_go_back_too(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting" and task.checkpoints == ["u-1"])
    ok, reply = await hub.code_sessions.rewind_in_place(task, "u-1", files=True)
    assert ok and "files are as they were" in reply
    assert task.client.rewound == ["u-1"] and task.session_id == "" and task.checkpoints == []
    assert await until(lambda: len(Stream.instances) == 2 and Stream.instances[1].connected)
    assert Stream.instances[1].options.resume is None  # a new conversation
    ok, reply = await hub.code_sessions.rewind_in_place(task, "u-9", files=False)
    assert not ok and reply.startswith("There's no conversation")
    await end_all(hub)


async def test_a_busy_session_is_not_rewound_and_a_resend_can_fork(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    tm = hub.tasks
    task = tm.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "two")
    assert await until(lambda: task.checkpoints == ["u-1", "u-2"] and task.status == "waiting")
    task.client.hold = True
    tm.send(task.id, "three")
    assert await until(lambda: task.busy)
    ok, reply = await hub.code_sessions.rewind_in_place(task, "u-2", files=False)
    assert not ok and "still working" in reply
    task.client.release()
    assert await until(lambda: not task.busy)
    await hub._handle(
        {"type": "code_rewind", "id": task.id, "uuid": "u-2", "text": "two again", "fork": True}
    )
    fork = max(tm.tasks.values(), key=lambda t: t.id)
    assert fork is not task and fork.fork and fork.resume_at == "a-1"
    assert any(e["type"] == "show_session" and e["id"] == fork.id for e in seen())
    assert await until(lambda: any(c.queries == ["two again"] for c in Stream.instances))
    assert [e["text"] for e in task.transcript if e["role"] == "user"] == ["one", "two", "three"]
    await end_all(hub)


async def test_a_rewind_in_place_outlasts_a_restart(
    settings, quiet_speaker, isolated, tmp_path, history
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    task = hub.tasks.start("", "proj", resume="s")
    assert await until(lambda: task.client is not None and task.history_read)
    ok, _ = await hub.code_sessions.rewind_in_place(task, "u-2", files=False)
    assert ok and task.resume_at == "a-2"
    await hub.code_sessions.flush(final=True)
    await end_all(hub)

    Stream.instances = []
    again = make_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    [back] = again.tasks.tasks.values()
    await again._handle({"type": "code_session_open", "id": back.id})
    # Read back up to the point only; the next connection resumes there.
    assert [e["text"] for e in back.transcript if e["role"] == "user"] == ["add a retry"]
    assert again.tasks.options_for(back).resume_session_at == "a-2"


async def test_a_session_whose_folder_is_gone_is_kept_a_while_not_dropped(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    gone = folder / "ffffffffffffffff.json"
    stale = folder / "eeeeeeeeeeeeeeee.json"
    away = str(tmp_path / "unplugged-disk" / "proj")
    gone.write_text(
        json.dumps({"cwd": away, "session_id": "s-away", "updated": "2099-01-01T00:00:00"})
    )
    stale.write_text(
        json.dumps({"cwd": away, "session_id": "s-old", "updated": "2001-01-01T00:00:00"})
    )
    hub = make_hub(settings, quiet_speaker, isolated)
    assert await hub.code_sessions.restore() == 0
    task = hub.tasks.start("new", "proj")
    assert await until(lambda: task.status == "waiting")
    await hub.code_sessions.flush(final=True)
    assert gone.exists() and not stale.exists()  # kept for when it's back; an old one let go
    await end_all(hub)
