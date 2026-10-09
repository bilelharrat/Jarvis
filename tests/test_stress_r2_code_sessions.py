"""Round 2 of the stress pass on the Eden Code backend (tasks.py, session_store,
features/code_sessions, worktrees and features/code_isolation, code_handoff, code_bestof
and the composer's ! commands): each test is a break the stress harness
(scripts/stress_r2_code_sessions.py) found, cut down to a fast, deterministic case that
fails until the defect is fixed. No real Claude: the fakes of test_tasks and
code_session_fakes; real git in temp repositories."""

import asyncio
import gc
import json
import threading
import time
import tracemalloc
import uuid
from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from claude_agent_sdk import AssistantMessage, ToolUseBlock, UserMessage
from code_session_fakes import Stream, end_all
from code_session_fakes import make_hub as make_sessions_hub
from code_session_fakes import until as soon
from test_code_changes import make_repo, numbered
from test_tasks import res, stream_manager, until

from jarvis import worktrees
from jarvis.features import code_sessions as code_sessions_mod
from jarvis.handoff import Handoff, Machine
from jarvis.session_store import STORE_LIMIT, SessionStore
from jarvis.tasks import MAX_QUEUED, ClaudeTask

# ── fixtures ──


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "my projects é"  # a space and an accent, as the owner's may have
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def waited(condition, seconds=60.0):
    """Whether condition() comes true within seconds (a real git worktree add can take a
    while on a busy Mac; it returns as soon as it holds)."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


async def busy_but_not_begun(settings, tmp_path):
    """A session whose message is sent but whose turn Claude Code hasn't begun: busy (so
    steerable), not steer-ready."""
    (tmp_path / "p").mkdir()
    tm, events = stream_manager(settings)
    task = tm.start("", "p")
    assert await until(lambda: task.status == "waiting")
    client = task.client
    client.held = []  # its next turn waits for release()
    tm.send(task.id, "first")
    assert await until(lambda: task.busy and client.queries == ["first"])
    assert task.steerable and not task.steer_ready
    return tm, task, client


# ── steering ──


async def test_steered_messages_sent_before_the_step_begins_keep_their_order(settings, tmp_path):
    tm, task, client = await busy_but_not_begun(settings, tmp_path)
    try:
        for text in ("A", "B", "C"):
            tm.send(task.id, text, steer=True)
        await asyncio.sleep(0.05)
        client.release()
        assert await until(lambda: len(client.queries) == 4)
        assert client.queries == ["first", "A", "B", "C"]
    finally:
        await tm.close()


async def test_steering_never_takes_a_sessions_waiting_messages_past_the_cap(settings, tmp_path):
    tm, task, client = await busy_but_not_begun(settings, tmp_path)
    try:
        for i in range(MAX_QUEUED + 30):  # Claude Code hasn't begun the step: they wait
            tm.send(task.id, f"early {i}", steer=True)
        await asyncio.sleep(0.05)
        assert task.inbox.qsize() <= MAX_QUEUED
        task.inbox._items.clear()
        # Now it has begun the step: steers go straight into it, and come back to the queue
        # if the connection goes before Claude Code takes them up.
        tm._on_task_message(task, UserMessage(content="first", uuid="u-1"))
        assert task.steer_ready
        for i in range(MAX_QUEUED + 30):
            tm.send(task.id, f"late {i}", steer=True)
        await asyncio.sleep(0.05)
        tm._connection_gone(task)
        assert task.inbox.qsize() <= MAX_QUEUED
    finally:
        await tm.close()


async def test_a_steer_dropped_at_an_interrupt_never_leaves_the_session_working_forever(
    settings, tmp_path
):
    (tmp_path / "p").mkdir()
    tm, _ = stream_manager(settings)
    task = tm.start("", "p")
    try:
        assert await until(lambda: task.status == "waiting")
        client = task.client
        client.held = []  # (its turn's messages are put on the stream by hand below)
        tm.send(task.id, "first")
        assert await until(lambda: task.busy and client.queries == ["first"])
        stream = client._stream()
        stream.put_nowait(UserMessage(content="first", uuid="u-1"))  # the turn begins
        assert await until(lambda: task.current == "user")
        tm.send(task.id, "and the docs", steer=True)  # into the running step
        assert await until(lambda: task.steered == 1 and len(client.queries) == 2)  # (written)
        # Interrupted before Claude Code took it up: the turn ends without it (tasks.py's
        # own note: a steered message can be dropped at an interrupt).
        client.held = None
        stream.put_nowait(res("", 0.1, reason="aborted_tools"))
        assert await until(lambda: not task.busy)
        tm.send(task.id, "next one")  # its turn is replayed, answered and ends
        assert await until(lambda: len(client.queries) == 3)
        assert await until(lambda: not task.busy), "still Working after its turn ended"
        tm.send(task.id, "third")
        assert await until(lambda: "third" in client.queries), "the queue never moves again"
    finally:
        await tm.close()


# ── what a session keeps of what Claude Code says ──


async def test_a_to_do_lists_items_are_bounded_like_every_other_transcript_field(
    settings, tmp_path
):
    (tmp_path / "p").mkdir()
    tm, events = stream_manager(settings)
    task = tm.start("", "p")
    assert await until(lambda: task.status == "waiting")
    huge = "x" * 100_000
    todos = [{"content": huge, "status": "pending", "activeForm": huge} for _ in range(30)]
    tm._on_task_message(
        task,
        AssistantMessage(
            content=[ToolUseBlock(id="t1", name="TodoWrite", input={"todos": todos})], model="m"
        ),
    )
    tm._emit_changed()
    entry = [d["entry"] for kind, d in events if kind == "task_log"][-1]
    listed = [d for kind, d in events if kind == "tasks"][-1]
    try:
        assert len(json.dumps(entry)) < 100_000, "a to-do entry weighs megabytes"
        assert len(json.dumps(listed)) < 100_000, "the windows' list weighs megabytes"
    finally:
        await tm.close()


async def test_an_agent_steps_description_is_bounded_in_the_sessions_list(settings, tmp_path):
    (tmp_path / "p").mkdir()
    tm, events = stream_manager(settings)
    task = tm.start("", "p")
    assert await until(lambda: task.status == "waiting")
    step = ToolUseBlock(
        id="a1", name="Agent", input={"description": "d" * 1_000_000, "prompt": "look"}
    )
    tm._on_task_message(task, AssistantMessage(content=[step], model="m"))
    try:
        assert len(task.public()["last_action"]) <= 2000
    finally:
        await tm.close()


# ── kept sessions across a restart ──


def _kept(folder, records):
    store = SessionStore(folder)
    store.save({r["key"]: r for r in records}, {r["key"] for r in records})


async def test_more_open_sessions_than_the_lists_limit_are_all_kept_across_a_restart(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    cwd = str((tmp_path / "proj").resolve())
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    records = []
    for i in range(STORE_LIMIT + 5):  # never ended: each restart brings them back resting
        when = (datetime(2026, 1, 1) + timedelta(minutes=i)).isoformat(timespec="seconds")
        records.append(
            {
                "key": uuid.uuid4().hex[:16],
                "id": i + 1,
                "cwd": cwd,
                "session_id": f"sid-{i}",
                "title": f"session {i}",
                "created": when,
                "updated": when,
                "draft": "half a thought" if i < 3 else "",
            }
        )
    _kept(folder, records)
    hub = make_sessions_hub(settings, quiet_speaker, isolated)
    assert await hub.code_sessions.restore() == STORE_LIMIT + 5
    await hub.code_sessions.flush(final=True)  # the app quits
    await end_all(hub)

    again = make_sessions_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    listed = {t.title for t in again.tasks.tasks.values()}
    kept = {h["title"] for h in again.code_sessions.more_history()}
    lost = [r["title"] for r in records if r["title"] not in listed | kept]
    await end_all(again)
    assert not lost, f"kept sessions deleted from disk: {lost}"


async def test_kept_sessions_let_go_from_the_list_cost_little_memory(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    (tmp_path / "proj").mkdir()
    cwd = str((tmp_path / "proj").resolve())
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    records = []
    for i in range(100):  # ended long ago, each with a long session's permission audit
        when = (datetime(2026, 1, 1) + timedelta(minutes=i)).isoformat(timespec="seconds")
        audit = [
            {
                "at": when,
                "tool": "Edit",
                "what": f"src/app/module_{n}.py\n- old line {n}\n+ new line {n}" * 6,
                "decision": "auto",
                "why": "inside the project",
            }
            for n in range(500)
        ]
        records.append(
            {
                "key": uuid.uuid4().hex[:16],
                "id": i + 1,
                "cwd": cwd,
                "session_id": f"sid-{i}",
                "title": f"session {i}",
                "ended": True,
                "status": "stopped",
                "audit": audit,
                "created": when,
                "updated": when,
            }
        )
    _kept(folder, records)
    del records
    # Every ended one let go from the list (none of the newest MAX_ENDED shown), so what's
    # held is theirs alone.
    monkeypatch.setattr(code_sessions_mod, "MAX_ENDED", 0)
    hub = make_sessions_hub(settings, quiet_speaker, isolated)
    gc.collect()
    tracemalloc.start()
    try:
        await hub.code_sessions.restore()
        gc.collect()
        held, _peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    dormant = len(hub.code_sessions.dormant)
    await end_all(hub)
    assert dormant == 100
    # What a session let go from the list is needed for: its line in the history (and
    # reading it back whole if it's reopened), not its whole audit, in memory twice.
    assert held / dormant < 20_000, f"{held / dormant / 1e3:.0f} KB held per kept session"


async def test_a_session_waiting_out_claudes_limit_still_waits_after_a_restart(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_sessions_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    task = hub.tasks.start("migrate the database", "proj")
    assert await soon(lambda: task.status == "waiting" and task.session_id == "s")
    hub.code_limit.hold(task, time.time() + 3600)  # Claude's limit: it resets in an hour
    assert hub.tasks.send(task.id, "and then the docs")  # waits with it
    await hub.code_sessions.flush(final=True)  # the app restarts (an update, say)
    await end_all(hub)
    hub.code_limit.forget()

    Stream.instances = []
    again = make_sessions_hub(settings, quiet_speaker, isolated)
    await again.code_sessions.restore()
    [back] = again.tasks.tasks.values()
    await again._handle({"type": "code_session_open", "id": back.id})
    await asyncio.sleep(0.3)
    sent = [q for client in Stream.instances for q in client.queries]
    await end_all(again)
    again.code_limit.forget()
    # Still an hour before Claude's limit resets: nothing goes to Claude yet.
    assert not sent, f"sent to Claude during its usage limit: {sent}"
    assert back.hold_until > time.time()


# ── isolated copies ──


async def test_isolated_copies_stay_within_their_cap_when_sessions_start_together(
    hub, projects, monkeypatch
):
    monkeypatch.setattr(worktrees, "MAX_COPIES", 2)
    make_repo(projects / "proj ü", {"a.py": numbered(5)})
    started = [hub.tasks.start("", "proj ü", isolate=True, title=f"job {i}") for i in range(5)]
    assert await waited(lambda: all(t.client is not None for t in started))
    copies = hub.code_desk.store().copies
    assert len(copies) <= worktrees.MAX_COPIES, f"{len(copies)} copies past a cap of 2"


async def test_the_sweeper_never_removes_the_copy_a_session_just_started_in(
    hub, projects, monkeypatch
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_desk
    entered, go_on = threading.Event(), threading.Event()
    real_adopt = worktrees.adopt

    def slow_adopt(store, root):  # the sweep, under way in its thread, as a copy is made
        entered.set()
        go_on.wait(30)
        return real_adopt(store, root)

    monkeypatch.setattr(worktrees, "adopt", slow_adopt)
    sweep = asyncio.ensure_future(desk.sweep())
    try:
        assert await waited(entered.is_set, 10)
        task = hub.tasks.start("", "proj", isolate=True, title="fresh work")
        assert await waited(lambda: task.workspace and task.client is not None)
        folder = task.cwd
    finally:
        go_on.set()
        await sweep
    assert folder.is_dir(), "the sweeper deleted the folder a live session works in"
    assert desk.store().find(task.workspace["slug"]) is not None


# ── hand-offs ──


async def test_two_quick_messages_to_a_handed_off_session_start_one_run_with_both(
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
    # Its run on the other machine has ended: the next message starts it there again.
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
        remote_session="r-1",
    )
    desk.handoffs = [rec]
    runs, writes = [], []

    async def start(rec, machine, first, resume=""):
        await asyncio.sleep(0.05)  # ssh takes a moment
        runs.append(first)  # (the start script writes a fresh inbox, then starts the run)
        rec.state = "working"
        return ""

    async def write(rec, lines):
        writes.append(lines)
        return True

    desk._start, desk._write = start, write
    desk._follow = lambda rec: None
    desk.save = desk.publish = lambda: None
    assert tm.send(task.id, "first message") and tm.send(task.id, "second message")
    assert await soon(lambda: len(runs) + len(writes) >= 2)
    await asyncio.sleep(0.1)
    sent = " ".join(line for batch in runs + writes for line in batch)
    assert len(runs) == 1, f"{len(runs)} runs started there; each later one replaces the last"
    assert "first message" in sent and "second message" in sent


# ── output the backend only keeps the end of ──


async def test_a_bang_commands_huge_output_is_never_held_whole(hub, tmp_path, monkeypatch):
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    command = "head -c 40000000 /dev/zero | tr '\\0' a"  # 40 MB; only the last 20,000 kept
    tracemalloc.start()
    try:
        await hub.task_bash({"directory": "proj", "command": command, "ref": "b1"})
        _now, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    data = [d for kind, d in hub.events if kind == "task_bash"][-1]
    assert data["code"] == 0 and len(data["output"]) <= 20_001
    assert peak < 10_000_000, f"{peak / 1e6:.0f} MB held for 40 MB of output"


async def test_best_of_tests_huge_output_is_never_held_whole(tmp_path):
    from jarvis.features.code_bestof import TEST_OUTPUT, run_tests

    tracemalloc.start()
    try:
        ran = await run_tests("head -c 40000000 /dev/zero | tr '\\0' a", tmp_path)
        _now, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert ran["code"] == 0 and len(ran["tail"]) <= TEST_OUTPUT
    assert peak < 10_000_000, f"{peak / 1e6:.0f} MB held for 40 MB of output"
