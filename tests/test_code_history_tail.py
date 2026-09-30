"""A reopened Jarvis Code session's history, shown at once: its newest entries read from the
end of Claude Code's record (code_records.newest_messages), the same as reading it whole
(tasks.session_history, through the SDK) shows them; the whole read kept until the record
changes; and a session opening with the newest entries first, then the whole."""

import asyncio
import json
import os
import threading

import pytest
from claude_agent_sdk._internal.sessions import _sanitize_path
from test_tasks import stream_manager

from jarvis import code_records, tasks
from jarvis.tasks import ClaudeTask, session_history, session_history_tail

SID = "7c1e2f3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b"
KEEP = 12  # (TRANSCRIPT_KEEP, made small: the boundaries are what's tested)


@pytest.fixture
def record(tmp_path, monkeypatch):
    """Where Claude Code keeps SID's record for the project tmp_path/proj (never the owner's)."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setattr(tasks, "TRANSCRIPT_KEEP", KEEP)
    tasks._history_cache.clear()
    project = tmp_path / "proj"
    project.mkdir()
    folder = tmp_path / "claude" / "projects" / _sanitize_path(os.path.realpath(project))
    folder.mkdir(parents=True)
    return project, folder / f"{SID}.jsonl"


def line(kind, uuid, parent, content, **extra):
    return {"parentUuid": parent, "isSidechain": False, "type": kind, "uuid": uuid,
            "message": {"role": kind, "content": content}, "sessionId": SID, **extra}  # fmt: skip


def write(path, lines):
    with path.open("a") as f:
        for item in lines:
            f.write(json.dumps(item, separators=(",", ":")) + "\n")


def turns(count, parent=None, tag="", picture=""):
    """count rounds of: the owner asks, Claude runs a step (its result a round later, so a
    step and its result can fall either side of where reading stops), and answers."""
    out, last = [], parent
    for n in range(count):
        u, a, r, s = (f"{tag}{kind}{n:04d}" for kind in ("u", "a", "r", "s"))
        out.append(line("user", u, last, f"question {n}"))
        out.append(line("assistant", a, u, [
            {"type": "thinking", "thinking": f"thinking {n}"},
            {"type": "tool_use", "id": f"{tag}t{n}", "name": "Bash", "input": {"command": f"echo {n}"}},
        ]))  # fmt: skip
        result = [{"type": "text", "text": f"out {n}"}]
        if picture:
            result.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": picture}})  # fmt: skip
        out.append(line("user", r, a, [
            {"type": "tool_result", "tool_use_id": f"{tag}t{n}", "content": result, "is_error": n % 3 == 0},
        ]))  # fmt: skip
        out.append(line("assistant", s, r, [{"type": "text", "text": f"answer {n}"}]))
        out.append({"type": "system", "subtype": "turn_duration", "uuid": f"{tag}d{n:04d}", "parentUuid": s})  # fmt: skip
        last = f"{tag}d{n:04d}"
    return out


def same_as_whole(project, whole=None):
    tail = session_history_tail(SID, project)
    tasks._history_cache.clear()
    full = session_history(SID, project)
    assert tail is not None and full["entries"]
    for key in ("entries", "fork_points", "last_uuid"):
        assert tail[key] == full[key], key
    if whole is not None:
        assert tail["whole"] is whole
    if tail["whole"]:  # all of it: nothing more for the whole read to add
        assert tail["checkpoints"] == full["checkpoints"]
        assert tail["checkpoint_files"] == full["checkpoint_files"]
    return tail, full


@pytest.mark.parametrize("chunk", [97, 1 << 20])  # (lines cut across reads, and not)
@pytest.mark.parametrize("rounds", [1, 2, 3, 4, 7])  # 4 entries a round: either side of KEEP
def test_the_newest_entries_read_from_the_end_are_those_read_whole(
    record, monkeypatch, chunk, rounds
):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", chunk)
    write(path, turns(rounds))
    tail, full = same_as_whole(project)
    assert len(full["entries"]) == min(4 * rounds, KEEP)
    assert tail["whole"] or 4 * rounds > KEEP  # (a short one is always read to its start)


def test_a_long_conversation_is_read_from_the_end_only_as_far_as_it_shows(record, monkeypatch):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", 97)
    write(path, turns(40))
    tail, _full = same_as_whole(project, whole=False)
    assert tail["entries"][0]["text"] == "question 37"  # (the newest KEEP: 3 rounds)
    assert tail["fork_points"] == {f"u{n:04d}": f"s{n - 1:04d}" for n in (37, 38, 39)}


def test_a_rewinds_abandoned_line_and_a_meta_note_at_the_end_are_read_as_the_sdk_reads_them(
    record, monkeypatch
):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", 64)
    first = turns(5)
    write(path, first)
    # Rewound to the third round: a new line from there, written after the old one.
    write(path, turns(4, parent="d0002", tag="b"))
    tail, _full = same_as_whole(project)
    assert tail["last_uuid"] == "bs0003"
    # A meta note at the very end: the SDK takes the newest line without one, the old one.
    write(path, [line("user", "meta1", "bd0003", "Caveat: local command output", isMeta=True)])
    tail, _full = same_as_whole(project)
    assert tail["last_uuid"] == "s0004"
    # A subagent's side conversation written last doesn't count either.
    write(path, [line("assistant", "side1", None, [{"type": "text", "text": "sub"}], isSidechain=True)])  # fmt: skip
    tail, _full = same_as_whole(project)
    assert tail["last_uuid"] == "s0004"


def test_a_long_line_is_read_without_its_pictures_and_still_counts_them(record, monkeypatch):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", 4096)
    write(path, turns(8, picture="QUJD" * 20_000))  # (80 KB a picture: past LONG_LINE)
    tail, full = same_as_whole(project, whole=False)
    steps = [e for e in tail["entries"] if e["role"] == "tool"]
    assert steps and all(e["images"] == 1 for e in steps)


def test_a_record_too_long_to_read_from_the_end_is_read_whole(record, monkeypatch):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", 64)
    monkeypatch.setattr(code_records, "TAIL_MAX", 256)
    write(path, turns(7))
    assert session_history_tail(SID, project) is None
    assert session_history(SID, project)["entries"]
    assert session_history_tail("not-a-session", project) is None
    path.unlink()
    assert session_history_tail(SID, project) is None


def test_a_record_is_read_whole_once_until_it_changes(record, monkeypatch):
    project, path = record
    write(path, turns(3))
    reads = []
    real = tasks.get_session_messages
    monkeypatch.setattr(tasks, "get_session_messages", lambda *a, **k: reads.append(1) or real(*a, **k))  # fmt: skip
    first = session_history(SID, project)
    first["entries"][0]["text"] = "changed by its caller"
    first["fork_points"].clear()
    again = session_history(SID, project)
    assert len(reads) == 1
    assert again["entries"][0]["text"] == "question 0" and again["fork_points"]["u0001"] == "s0000"
    assert again == session_history(SID, project) and len(reads) == 1
    assert session_history(SID, project, until="s0001")["last_uuid"] == "s0001"  # (its own)
    assert len(reads) == 2
    write(path, [line("user", "u9999", "d0002", "one more")])
    assert session_history(SID, project)["entries"][-1]["text"] == "one more"
    assert len(reads) == 3


async def test_a_session_opens_with_its_newest_entries_then_the_whole(
    settings, record, monkeypatch
):
    project, path = record
    monkeypatch.setattr(code_records, "TAIL_CHUNK", 64)
    write(path, turns(12))
    tm, events = stream_manager(settings)
    task = ClaudeTask(id=1, prompt="", cwd=project, session_id=SID)
    tm.tasks[1] = task
    task.transcript.append({"role": "system", "text": "said before it was read", "n": 1})
    gate, reading = threading.Event(), threading.Event()
    real = tasks.session_history

    def slow(*args):
        reading.set()
        gate.wait(5)
        return real(*args)

    monkeypatch.setattr(tasks, "session_history", slow)
    opening = asyncio.create_task(tm._read_history(task))
    assert await asyncio.to_thread(reading.wait, 5)
    shown = [d["entries"] for k, d in events if k == "task_transcript"]
    assert len(shown) == 1 and shown[0][-1]["text"] == "said before it was read"
    assert [e["n"] for e in shown[0]] == list(range(1, KEEP + 1))
    assert tm.transcript(1) == shown[0]  # (a window asking meanwhile gets the same)
    assert task.transcript == [{"role": "system", "text": "said before it was read", "n": 1}]
    gate.set()
    await opening
    # Read whole, it's what was shown: not sent again.
    assert task.transcript == shown[0] and tm.transcript(1) == shown[0]
    assert len([k for k, _ in events if k == "task_transcript"]) == 1
    assert task.checkpoints == [f"u{n:04d}" for n in range(12)]
    assert task.history_preview is None


async def test_what_was_shown_first_is_corrected_by_the_whole_read(settings, record, monkeypatch):
    project, path = record
    write(path, turns(6))
    tm, events = stream_manager(settings)
    task = ClaudeTask(id=1, prompt="", cwd=project, session_id=SID)
    tm.tasks[1] = task
    shown = {**session_history_tail(SID, project), "whole": False}
    shown["entries"][-1]["text"] = "not what the whole read says"
    tasks._history_cache.clear()  # (that read was whole, and kept)
    monkeypatch.setattr(tasks, "session_history_tail", lambda *a: shown)
    await tm._read_history(task)
    sent = [d["entries"] for k, d in events if k == "task_transcript"]
    assert len(sent) == 2 and sent[0][-1]["text"] == "not what the whole read says"
    assert sent[1][-1]["text"] == "answer 5" and task.transcript == sent[1]


async def test_a_short_session_is_read_once(settings, record, monkeypatch):
    project, path = record
    write(path, turns(2))
    tm, events = stream_manager(settings)
    task = ClaudeTask(id=1, prompt="", cwd=project, session_id=SID)
    tm.tasks[1] = task
    monkeypatch.setattr(tasks, "get_session_messages", lambda *a, **k: pytest.fail("read twice"))
    await tm._read_history(task)
    sent = [d["entries"] for k, d in events if k == "task_transcript"]
    assert len(sent) == 1 and len(sent[0]) == 8 and task.fork_points["u0001"] == "s0000"
    # Reopened while its record is as it was: from what was kept, still not read again.
    again = ClaudeTask(id=2, prompt="", cwd=project, session_id=SID)
    tm.tasks[2] = again
    await tm._read_history(again)
    assert again.transcript == task.transcript
