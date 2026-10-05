"""Jarvis Code's kept sessions, hand-off messages and isolated copies at their limits: every
listed session keeps its file whatever the mix of open and ended ones, a message waiting
behind a hand-off's start never goes there once the session is back, and a copy that can't
be made never holds a place under the cap. No real Claude; real git in temp repositories."""

import asyncio
import time
import uuid
from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from code_session_fakes import end_all
from code_session_fakes import make_hub as make_sessions_hub
from code_session_fakes import until as soon
from test_code_changes import make_repo, numbered

from jarvis import worktrees
from jarvis.handoff import Handoff, Machine
from jarvis.session_store import SessionStore
from jarvis.tasks import MAX_ENDED, ClaudeTask


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def waited(condition, seconds=60.0):
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


# ── kept sessions ──


async def test_listed_ended_sessions_beside_many_open_ones_keep_their_files(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    cwd = str((tmp_path / "proj").resolve())
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    records = []
    # 45 open ones and the MAX_ENDED ended ones the list shows: all of them listed.
    for i in range(45 + MAX_ENDED):
        when = (datetime(2026, 1, 1) + timedelta(minutes=i)).isoformat(timespec="seconds")
        ended = i < MAX_ENDED  # the oldest ended
        records.append(
            {
                "key": uuid.uuid4().hex[:16],
                "id": i + 1,
                "cwd": cwd,
                "session_id": f"sid-{i}",
                "title": f"session {i}",
                "ended": ended,
                "status": "stopped" if ended else "",
                "created": when,
                "updated": when,
            }
        )
    SessionStore(folder).save({r["key"]: r for r in records}, {r["key"] for r in records})
    hub = make_sessions_hub(settings, quiet_speaker, isolated)
    assert await hub.code_sessions.restore() == len(records)
    await hub.code_sessions.flush(final=True)
    await end_all(hub)
    on_disk = {path.stem for path in folder.glob("*.json")}
    assert {r["key"] for r in records} <= on_disk, "a listed session's file was deleted"

    again = make_sessions_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    listed = {t.title for t in again.tasks.tasks.values()}
    kept = {h["title"] for h in again.code_sessions.more_history()}
    await end_all(again)
    assert {r["title"] for r in records} <= listed | kept


# ── hand-offs ──


async def test_a_message_waiting_behind_a_start_never_goes_there_once_the_session_is_back(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_sessions_hub(settings, quiet_speaker, isolated)
    desk, tm = hub.code_handoff, hub.tasks
    task = ClaudeTask(
        id=tm.new_id(), prompt="", cwd=(tmp_path / "proj").resolve(), session_id="s-1"
    )
    task.status = "waiting"
    tm.tasks[task.id] = task
    desk._loaded = True
    desk.machines = [Machine(alias="studio", ok=True, claude="claude")]
    rec = Handoff(
        id="copy-1",
        alias="studio",
        slug="copy-1",
        project="proj",
        branch="jarvis/copy-1",
        base="abc",
        session_id="s-1",
        task_id=task.id,
        started=time.time(),
        state="ended",
    )
    desk.handoffs = [rec]
    runs, writes = [], []
    go_on = asyncio.Event()

    async def start(rec, machine, first, resume=""):
        runs.append(first)
        await go_on.wait()  # ssh takes a while
        rec.state = "working"
        return ""

    async def write(rec, lines):
        writes.append(lines)
        return True

    desk._start, desk._write = start, write
    desk._follow = lambda rec: None
    desk.save = desk.publish = lambda: None
    assert tm.send(task.id, "first message")
    assert await soon(lambda: len(runs) == 1)
    assert tm.send(task.id, "second message")  # waits for the start
    await asyncio.sleep(0.05)
    assert not writes and len(runs) == 1
    desk.handoffs.remove(rec)  # brought back meanwhile (bring_back_now)
    go_on.set()
    assert await soon(lambda: any("came back from studio" in e["text"] for e in task.transcript))
    assert not writes and len(runs) == 1


# ── isolated copies ──


async def test_a_copy_that_cant_be_made_never_holds_a_place_under_the_cap(
    hub, projects, monkeypatch
):
    monkeypatch.setattr(worktrees, "MAX_COPIES", 1)
    (projects / "plain").mkdir()  # not a git repository: no copy
    make_repo(projects / "repo", {"a.py": numbered(5)})
    shared = hub.tasks.start("", "plain", isolate=True, title="no copy")
    assert await waited(lambda: shared.client is not None)
    assert not shared.workspace and hub.code_desk.making == 0
    task = hub.tasks.start("", "repo", isolate=True, title="its own copy")
    assert await waited(lambda: task.client is not None)
    assert task.workspace and len(hub.code_desk.store().copies) == 1
    assert hub.code_desk.making == 0
