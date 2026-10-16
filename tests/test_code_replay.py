"""Eden Code's step-by-step replay (code_replay, features/code_replay): a past session's
steps from Claude Code's record, each edit's diff, the files at each of the owner's
messages from Claude Code's checkpoints, and carrying on from a step: a fork of the
conversation, or a new session in an isolated copy with the files as they were then."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from claude_agent_sdk.types import SessionMessage
from code_session_fakes import make_hub, until

from jarvis import code_records, code_replay, tasks
from jarvis.code_export import entries_from
from jarvis.features.code_replay import put_back
from jarvis.tasks import ClaudeTask, _history_said

SID = "0f5d8c1e-7a41-4b8e-9d6b-2f1a3c4e5b6d"
U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"
KEY = "sk-ant-api03-" + "A1b2C3d4" * 6


def msg(kind, uuid, content):
    return SessionMessage(
        type=kind, uuid=uuid, session_id=SID, message={"role": kind, "content": content}
    )


def conversation(root):
    a = str(root / "a.py")
    return [
        msg("user", U1, f"rename foo to bar, my key is {KEY}"),
        msg("assistant", "a1", [{"type": "thinking", "thinking": "Find foo first."},
                                {"type": "tool_use", "id": "t1", "name": "Edit",
                                 "input": {"file_path": a, "old_string": "def foo():", "new_string": "def bar():"}},
                                {"type": "tool_use", "id": "t2", "name": "Task",
                                 "input": {"description": "check callers", "subagent_type": "Explore", "prompt": "find foo"}}]),
        msg("user", "r1", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                           {"type": "tool_result", "tool_use_id": "t2", "content": "none left", "is_error": False}]),
        msg("assistant", "a2", [{"type": "text", "text": "Renamed it."}]),
        msg("user", U2, "now add b.py"),
        msg("assistant", "a3", [{"type": "tool_use", "id": "t3", "name": "Write",
                                 "input": {"file_path": str(root / "b.py"), "content": "print('b')\n"}}]),
        msg("user", "r2", [{"type": "tool_result", "tool_use_id": "t3", "content": "written"}]),
        msg("assistant", "a4", [{"type": "text", "text": "Added b.py."}]),
    ]  # fmt: skip


def test_steps_number_every_entry_with_its_turn_and_an_edit_s_own_diff(tmp_path):
    steps = code_replay.steps_from(entries_from(conversation(tmp_path), _history_said))
    assert [s["kind"] for s in steps] == [
        "user", "thinking", "tool", "agent", "assistant", "user", "tool", "assistant",
    ]  # fmt: skip
    assert [s["n"] for s in steps] == list(range(8))
    assert {s["turn"] for s in steps[:5]} == {U1} and {s["turn"] for s in steps[5:]} == {U2}
    edit = steps[2]
    assert edit["path"].endswith("a.py") and edit["output"] == "ok"
    assert "-def foo():" in edit["diff"] and "+def bar():" in edit["diff"]
    assert "old_string" not in edit["input"] and "file_path" in edit["input"]  # (the diff has it)
    assert steps[3]["agent"] == "Explore" and steps[3]["title"] == "Agent: check callers"
    assert "+print('b')" in steps[6]["diff"]


def test_long_steps_are_cut_and_there_are_never_more_than_the_cap():
    entries = [{"kind": "assistant", "text": "x" * 10_000}] * (code_replay.STEPS_MAX + 5)
    steps = code_replay.steps_from(entries)
    assert len(steps) == code_replay.STEPS_MAX
    assert len(steps[0]["text"]) < 4100 and "more characters" in steps[0]["text"]


def write_record(root, claude):
    """A record with two checkpoints, and Claude Code's copies of a.py at each."""
    folder = claude / "projects" / "p"
    folder.mkdir(parents=True)
    record = folder / f"{SID}.jsonl"
    a, b = str(root / "a.py"), str(root / "b.py")

    def snap(uid, files, update=False):
        backups = {p: {"backupFileName": n, "version": 1, "backupTime": "t"} for p, n in files.items()}
        return json.dumps({"type": "file-history-snapshot", "messageId": uid,
                           "snapshot": {"messageId": uid, "trackedFileBackups": backups},
                           "isSnapshotUpdate": update})  # fmt: skip

    lines = [
        snap(U1, {}),
        json.dumps({"type": "user", "uuid": U1, "sessionId": SID, "message": {"role": "user", "content": "x"}}),
        snap(U1, {a: "aaaa1111@v1"}, update=True),  # (the turn adds what it changes)
        snap(U2, {a: "aaaa1111@v2"}),
        snap(U2, {b: None}, update=True),  # b.py wasn't there yet
    ]
    record.write_text("\n".join(lines) + "\n")
    copies = claude / "file-history" / SID
    copies.mkdir(parents=True)
    (copies / "aaaa1111@v1").write_text("def foo():\n    pass\n")
    (copies / "aaaa1111@v2").write_text("def bar():\n    pass\n")
    return record


def test_checkpoints_hold_each_file_as_it_was_at_each_message(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    record = write_record(tmp_path, tmp_path / "claude")
    snaps, sessions = code_replay.snapshots(record)
    assert list(snaps) == [U1, U2] and sessions == [SID]
    a, b = str(tmp_path / "a.py"), str(tmp_path / "b.py")
    # At the first message b.py hadn't been changed yet: as before its first change (absent).
    assert code_replay.state_at(snaps, U1) == {a: "aaaa1111@v1", b: None}
    assert code_replay.state_at(snaps, U2) == {a: "aaaa1111@v2", b: None}
    assert code_replay.state_at(snaps, "nope") == {}
    dirs = code_replay.history_dirs(sessions)
    assert code_replay.read_copy(dirs, "aaaa1111@v1") == b"def foo():\n    pass\n"
    for bad in ("../../etc/passwd", "aaaa1111", None, "a/b@v1"):
        assert code_replay.read_copy(dirs, bad) is None
    assert code_replay.snapshots(None) == ({}, [])


def test_put_back_writes_only_inside_the_copy_and_removes_files_not_there_then(tmp_path):
    project, copy = tmp_path / "proj", tmp_path / "copy"
    project.mkdir()
    (copy / "sub").mkdir(parents=True)
    (copy / "new.py").write_text("made later")
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    (copy / "link.py").symlink_to(outside)
    files = [
        (str(project / "sub" / "a.py"), b"old a"),
        (str(project / "new.py"), None),
        (str(tmp_path / "elsewhere.py"), b"no"),
        (str(project / "link.py"), b"through a link"),
        (str(project / ".." / "outside.txt"), b"escape"),
    ]
    done, skipped = put_back(files, [project], copy)
    assert (done, skipped) == (2, 3)
    assert (copy / "sub" / "a.py").read_bytes() == b"old a" and not (copy / "new.py").exists()
    assert outside.read_text() == "keep" and not (copy / "elsewhere.py").exists()


def test_the_summary_says_what_was_asked_and_done_with_secrets_blanked(tmp_path):
    steps = code_replay.steps_from(entries_from(conversation(tmp_path), _history_said))
    text = code_replay.summary("Rename", steps, 4, ["a.py"])
    assert "step 5 of 8" in text and "rename foo to bar" in text and "Renamed it." in text
    assert "Files it had changed: a.py." in text and KEY not in text
    assert "now add b.py" not in text  # (after the point)


# ── through the hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    claude = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))  # (never the owner's records)
    project = tmp_path / "proj"
    (project / ".git").mkdir(parents=True)
    (project / "a.py").write_text("def bar():\n    pass\n")
    (project / "b.py").write_text("print('b')\n")
    record = write_record(project, claude)
    monkeypatch.setattr(
        tasks,
        "get_session_messages",
        lambda sid, directory: conversation(project) if sid == SID else [],
    )
    monkeypatch.setattr(code_records, "record_path", lambda sid, cwd: record if sid == SID else None)
    made = make_hub(settings, quiet_speaker, isolated)
    task = ClaudeTask(id=7, prompt="rename", cwd=project, session_id=SID, title="Rename foo")
    task.history_read = True
    made.tasks.tasks[7] = task
    return made


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def answer(seen, kind, n=1):
    assert await until(lambda: sum(k == kind for k, _ in seen) >= n, 1200)
    return [d for k, d in seen if k == kind][-1]


async def test_a_session_replays_step_by_step_with_its_checkpoints_and_files(hub, tmp_path):
    seen = record(hub)
    await hub.handle({"type": "cw_replay", "id": 7, "ref": "r1"})
    got = await answer(seen, "cw_replay")
    assert got["ref"] == "r1" and got["copy"] is True and len(got["steps"]) == 8
    assert "text" not in got["steps"][0] and got["steps"][2]["path"] == "a.py"  # (headings only)
    assert [c["uuid"] for c in got["checkpoints"]] == [U1, U2]
    first = got["checkpoints"][0]
    assert first["n"] == 0 and first["changed"] == ["a.py"]
    assert [f["name"] for f in first["files"]] == ["a.py", "b.py"]

    await hub.handle({"type": "cw_replay_step", "id": 7, "n": 2, "ref": "s1"})
    step = (await answer(seen, "cw_replay_step"))["step"]
    assert "+def bar():" in step["diff"] and step["path"] == "a.py"

    a = str(tmp_path / "proj" / "a.py")
    await hub.handle({"type": "cw_replay_file", "id": 7, "uuid": U1, "path": a, "ref": "f1"})
    change = await answer(seen, "cw_replay_file")
    assert change["before"].startswith("def foo") and change["after"].startswith("def bar")
    assert "-def foo():" in change["diff"] and not change["after_is_now"]
    b = str(tmp_path / "proj" / "b.py")
    await hub.handle({"type": "cw_replay_file", "id": 7, "uuid": U2, "path": b, "ref": "f2"})
    made = await answer(seen, "cw_replay_file", 2)
    assert made["missing_before"] and made["after_is_now"] and "+print('b')" in made["diff"]
    # Only a file a checkpoint names is ever read.
    secret = tmp_path / "secret.txt"
    secret.write_text("nope")
    await hub.handle(
        {"type": "cw_replay_file", "id": 7, "uuid": U1, "path": str(secret), "ref": "f3"}
    )
    assert "isn't one this session changed" in (await answer(seen, "cw_replay_file", 3))["error"]


async def test_no_session_or_a_step_not_read_says_so(hub):
    seen = record(hub)
    await hub.handle({"type": "cw_replay", "id": 99, "ref": "r"})
    assert (await answer(seen, "cw_replay"))["error"] == "Open a session to replay it."
    await hub.handle({"type": "cw_replay_step", "id": 7, "n": 0, "ref": "s"})
    assert "replay the session again" in (await answer(seen, "cw_replay_step"))["error"]
    await hub.handle({"type": "cw_replay_fork", "id": 7, "n": 0, "ref": "k"})
    assert "replay the session again" in (await answer(seen, "cw_replay_fork"))["error"]


async def test_fork_from_a_step_forks_the_conversation_from_the_end_of_its_turn(hub, monkeypatch):
    seen = record(hub)
    asked = []

    def fork(task_id, uuid=""):
        asked.append((task_id, uuid))
        return SimpleNamespace(id=8)

    monkeypatch.setattr(hub.tasks, "fork", fork)
    await hub.handle({"type": "cw_replay", "id": 7, "ref": "r"})
    await answer(seen, "cw_replay")
    await hub.handle({"type": "cw_replay_fork", "id": 7, "n": 2, "ref": "k1"})
    assert (await answer(seen, "cw_replay_fork"))["session"] == 8
    await hub.handle({"type": "cw_replay_fork", "id": 7, "n": 6, "ref": "k2"})
    await answer(seen, "cw_replay_fork", 2)
    # Step 3's turn ends where the owner's next message begins; the last turn: all of it.
    assert asked == [(7, U2), (7, "")]
    assert ("show_session", {"id": 8}) in seen


async def test_a_new_session_from_a_step_gets_the_files_as_they_were_and_a_summary(
    hub, monkeypatch, tmp_path
):
    seen = record(hub)
    fresh = ClaudeTask(id=9, prompt="", cwd=tmp_path / "proj")
    monkeypatch.setattr(hub.tasks, "start_like", lambda task_id, prompt="": fresh)
    await hub.handle({"type": "cw_replay", "id": 7, "ref": "r"})
    await answer(seen, "cw_replay")
    await hub.handle({"type": "cw_replay_fork", "id": 7, "n": 4, "files": True, "ref": "k"})
    done = await answer(seen, "cw_replay_fork")
    assert done["ok"] and done["session"] == 9 and done["files"] == 2
    assert fresh.isolate is True and fresh.title == "Rename foo (from step 5)"
    draft = hub.code_sessions._meta_of(fresh)["draft"]
    assert "rename foo to bar" in draft and KEY not in draft
    # Its copy is made: a.py goes back to before the second message; b.py wasn't there then.
    copy = tmp_path / "copy"
    copy.mkdir()
    (copy / "b.py").write_text("print('b')\n")
    tm_log = []
    monkeypatch.setattr(hub.tasks, "_log", lambda task, role, text, **kw: tm_log.append(text))
    assert hub.code_replay.on_new_copy in hub.code_desk.on_new_copy
    await hub.code_replay.on_new_copy(fresh, SimpleNamespace(cwd=copy))
    assert (copy / "a.py").read_text() == "def bar():\n    pass\n" and not (copy / "b.py").exists()
    assert "2 put back" in tm_log[-1] and "last commit" in tm_log[-1]
    # A project that isn't a git one: no copy to put files in, said so.
    (tmp_path / "proj" / ".git").rmdir()
    await hub.handle({"type": "cw_replay_fork", "id": 7, "n": 4, "files": True, "ref": "k2"})
    assert "needs a git project" in (await answer(seen, "cw_replay_fork", 2))["error"]
    assert Path(tmp_path / "proj" / "a.py").read_text().startswith("def bar")  # (untouched)
