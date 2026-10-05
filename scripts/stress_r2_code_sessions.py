"""Stress the Jarvis Code backend's sessions, heavier than the tests (opt-in, not part of
pytest's run; nothing here reaches the network, a model or the owner's data):

    uv run python scripts/stress_r2_code_sessions.py           # every stage
    uv run python scripts/stress_r2_code_sessions.py starts    # one of: starts steer fuzz
                                                               # stream persist history
                                                               # copies bang

It runs its stages under pytest with the test suite's own fixtures (tests/conftest.py: temp
stores, no Keychain, a fake Claude Code), each in temp folders removed at the end, and
prints what it measured:

- starts: 10 sessions started at once against the real 3-a-second spawn limit, then 100
  (the limit sped up): how many Claude Codes were open at once, and how many lists of
  sessions (and megabytes) went to the windows.
- steer: follow-ups steered before Claude Code begins the step (their order), and a
  runaway of steers against the 50-message queue cap.
- fuzz: thousands of interleaved sends, steers, interrupts, ends, rewinds, forks, effort
  and mode switches, unqueues and reconnects on a dozen sessions: messages lost, sent
  twice, or left stuck behind a session that never stops working.
- stream: 50 sessions streaming 100,000 live words at once, and a session taking in a
  hundred 5 MB tool results: the event loop's lag and the events sent.
- persist: 60 to 2,000 kept sessions (each with a long permission audit) read back at
  startup: time, memory held, disk; and more open sessions than the list keeps.
- history: Claude Code records of 10,000 and 50,000 lines read back (the newest entries
  first, then whole): time and peak memory.
- copies: isolated copies (git worktrees) of a project whose path has spaces and accents:
  8 made at once, a burst past the copies' cap, the sweeper running while a session's copy
  is made, a copy that fails half way, then all landed or discarded.
- bang: "!" commands and best-of-N test runs printing 10 to 100 MB: peak memory.

Each stage watches the event loop's lag (a ticker measuring its own delays), the
process's memory, open file descriptors, threads and asyncio tasks.
"""

from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import random
import re
import sys
import threading
import time
import tracemalloc
import uuid
from collections import Counter
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

import psutil
import pytest

ROOT = Path(__file__).resolve().parents[1]


# ── measuring ──


class Lag:
    """The event loop's worst and typical lag while a stage runs: a ticker that sleeps
    EVERY and notes how late it woke."""

    EVERY = 0.005

    def __init__(self) -> None:
        self.late: list[float] = []
        self._task: asyncio.Task | None = None

    async def _tick(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            at = loop.time()
            await asyncio.sleep(self.EVERY)
            self.late.append(max(0.0, loop.time() - at - self.EVERY))

    def __enter__(self) -> Lag:
        self._task = asyncio.get_running_loop().create_task(self._tick())
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._task is not None:
            self._task.cancel()

    def said(self) -> str:
        if not self.late:
            return "lag n/a"
        worst = max(self.late)
        p95 = sorted(self.late)[int(len(self.late) * 0.95) - 1] if len(self.late) > 20 else worst
        return f"lag worst {worst * 1000:.0f} ms, p95 {p95 * 1000:.1f} ms"


def vitals() -> dict[str, float]:
    me = psutil.Process()
    try:
        tasks = len(asyncio.all_tasks())
    except RuntimeError:
        tasks = 0
    return {
        "rss_mb": me.memory_info().rss / 1e6,
        "fds": me.num_fds(),
        "threads": threading.active_count(),
        "tasks": tasks,
    }


def show(name: str, before: dict[str, float], extra: str = "") -> None:
    after = vitals()
    print(
        f"  {name:<44} rss {after['rss_mb']:.0f} MB ({after['rss_mb'] - before['rss_mb']:+.0f}),"
        f" fds {after['fds']:.0f} ({after['fds'] - before['fds']:+.0f}),"
        f" threads {after['threads']:.0f}, tasks {after['tasks']:.0f}  {extra}"
    )


def manager(settings, client):
    from jarvis.tasks import TaskManager

    events: list = []

    async def approve(*_a, **_k):
        return "deny"

    return TaskManager(
        settings, approve, lambda kind, **d: events.append((kind, d)), client
    ), events


async def until(condition, seconds: float = 30.0) -> bool:
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.005)
    return True


# ── starts: many sessions at once ──


@pytest.mark.starts
async def test_starts(settings, tmp_path, monkeypatch):
    from test_tasks import StreamClient

    from jarvis import tasks as tasks_mod

    print("\nstarts")

    class Counting(StreamClient):
        live = peak = 0
        at: list[float] = []

        async def connect(self):
            Counting.at.append(time.monotonic())
            Counting.live += 1
            Counting.peak = max(Counting.peak, Counting.live)
            self.connected = True

        async def disconnect(self):
            Counting.live -= 1
            self.connected = False

    (tmp_path / "p").mkdir()
    for n, window in ((10, None), (100, 0.01), (200, 0.01)):
        if window is not None:
            monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", window)
        Counting.live = Counting.peak = 0
        Counting.at = []
        before = vitals()
        tm, events = manager(settings, Counting)
        with Lag() as lag:
            began = time.monotonic()
            started = [tm.start(f"job {i}", "p") for i in range(n)]
            await until(lambda s=started: all(t.status == "waiting" for t in s), 120)
            took = time.monotonic() - began
        busiest = max(
            sum(1 for b in Counting.at if a <= b < a + 1.0) for a in Counting.at
        )  # Claude Codes started in any one second
        lists = [d for kind, d in events if kind == "tasks"]
        weight = sum(len(json.dumps(d)) for d in lists) / 1e6
        show(
            f"{n} at once (spawn window {window or 'real'})",
            before,
            f"{took:.1f}s, peak open {Counting.peak}, most started in 1 s {busiest}, "
            f"{len(lists)} lists ({weight:.1f} MB), {lag.said()}",
        )
        await tm.close()


# ── steer: follow-ups into the running step ──


@pytest.mark.steer
async def test_steer(settings, tmp_path):
    from test_tasks import StreamClient

    from jarvis.tasks import MAX_QUEUED

    print("\nsteer")
    (tmp_path / "p").mkdir()
    for burst in (3, 50, 500):
        tm, _ = manager(settings, StreamClient)
        task = tm.start("", "p")
        await until(lambda t=task: t.status == "waiting")
        client = task.client
        client.held = []
        tm.send(task.id, "first")
        await until(lambda c=client, t=task: t.busy and c.queries == ["first"])
        before = vitals()
        for i in range(burst):
            tm.send(task.id, f"s{i}", steer=True)
        await asyncio.sleep(0.05)
        waiting = [i["text"] for i in task.inbox._items]
        in_order = waiting == [f"s{i}" for i in range(burst)]
        show(
            f"{burst} steers before the step begins",
            before,
            f"queued {len(waiting)} (cap {MAX_QUEUED}), in order: {in_order}",
        )
        await tm.close()


# ── fuzz: everything at once on a dozen sessions ──

TAG = re.compile(r"\bm(\d+)\b")


@pytest.mark.fuzz
async def test_fuzz(settings, tmp_path, monkeypatch, caplog):
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, UserMessage
    from conftest import FakeClient, strip_note

    from jarvis import tasks as tasks_mod

    print("\nfuzz")

    def result(total, reason=None):
        return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                             is_error=False, num_turns=1, session_id="s",
                             total_cost_usd=total, result="ok", terminal_reason=reason)  # fmt: skip

    class Live(FakeClient):
        """A Claude Code whose turns take a little while: what it's sent mid-turn it takes
        up within the turn (steering), and an interrupt ends the turn, dropping what it
        hadn't taken up yet."""

        taken: Counter = Counter()
        made: list = []
        rng = random.Random(1)

        def __init__(self, options=None):
            super().__init__(options)
            self.total, self.pending, self.turn = 0.0, [], None
            Live.made.append(self)

        async def query(self, text):
            self.queries.append(text)
            self.pending.append(text)
            if self.turn is None or self.turn.done():
                self.turn = asyncio.ensure_future(self._run())

        async def _run(self):
            while self.pending:
                text = self.pending.pop(0)
                for m in TAG.findall(strip_note(str(text))):
                    Live.taken[m] += 1
                self._stream().put_nowait(UserMessage(content=str(text), uuid=str(uuid.uuid4())))
                await asyncio.sleep(Live.rng.random() * 0.01)
            self._stream().put_nowait(AssistantMessage(content=[TextBlock(text="ok")], model="m"))
            self.total += 0.01
            self._stream().put_nowait(result(self.total))

        async def interrupt(self):
            if self.turn is not None and not self.turn.done():
                self.turn.cancel()
                self.pending.clear()
                self.total += 0.01
                self._stream().put_nowait(result(self.total, "aborted_tools"))

        async def disconnect(self):
            if self.turn is not None:
                self.turn.cancel()
            self.connected = False

    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", 0.01)
    monkeypatch.setattr(tasks_mod, "REOPEN_QUIET", 0.02)
    (tmp_path / "p").mkdir()
    for seed, steps in ((7, 3000), (11, 6000)):
        Live.taken, Live.made = Counter(), []
        tm, _ = manager(settings, Live)
        rng = random.Random(seed)
        for _ in range(4):
            tm.start("", "p")
        sent: dict[str, int] = {}
        unqueued: set[str] = set()
        n = 0
        before = vitals()
        with Lag() as lag:
            for _ in range(steps):
                t = rng.choice(list(tm.tasks.values()))
                op = rng.random()
                if op < 0.45:
                    n += 1
                    if tm.send(t.id, f"msg m{n}", steer=rng.random() < 0.4):
                        sent[str(n)] = t.id
                elif op < 0.52:
                    await tm.interrupt(t.id)
                elif op < 0.56:
                    tm.cancel(t.id)
                elif op < 0.60 and t.checkpoints:
                    asyncio.ensure_future(tm.rewind_to(t.id, rng.choice(t.checkpoints)))
                elif op < 0.62 and len(tm.tasks) < 12:
                    tm.fork(t.id)
                elif op < 0.66:
                    tm.set_effort(t.id, rng.choice(tasks_mod.EFFORTS))
                elif op < 0.70:
                    tm.set_mode(t.id, rng.choice(["ask", "edits", "plan"]))
                elif op < 0.74 and t.inbox.qsize():
                    item = rng.choice(list(t.inbox._items))
                    if rng.random() < 0.5:
                        if tm.unqueue(t.id, item["id"]):
                            unqueued.update(TAG.findall(item["text"]))
                    else:
                        tm.steer_queued(t.id, item["id"])
                elif op < 0.76:
                    tm.reconnect(t.id)
                await asyncio.sleep(rng.random() * 0.004)
            for _ in range(400):  # settle: what's left waiting opens its session again
                for t in tm.tasks.values():
                    if not t.inbox.empty() and (t.handle is None or t.handle.done()):
                        tm.reconnect(t.id)
                await asyncio.sleep(0.01)
                if all(not t.busy and t.inbox.empty() for t in tm.tasks.values()):
                    break
        stuck = [t.id for t in tm.tasks.values() if t.busy and t.client is not None]
        held = {
            m
            for t in tm.tasks.values()
            for i in [*t.inbox._items, *t.steered_items, *([t.in_flight] if t.in_flight else [])]
            for m in TAG.findall(i["text"])
        }
        twice = sum(1 for c in Live.taken.values() if c > 1)
        lost = [m for m in sent if not Live.taken[m] and m not in held | unqueued]
        warned = [r for r in caplog.records if r.levelno >= logging.WARNING]
        show(
            f"seed {seed}, {steps} operations",
            before,
            f"sent {len(sent)}, taken twice {twice}, never taken {len(lost)}, "
            f"stuck working {len(stuck)}, warnings {len(warned)}, {lag.said()}",
        )
        caplog.clear()
        await tm.close()


# ── stream: live words and big tool results ──


@pytest.mark.stream
async def test_stream(settings, tmp_path, monkeypatch):
    from claude_agent_sdk import (
        AssistantMessage,
        StreamEvent,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )
    from test_tasks import StreamClient

    from jarvis import tasks as tasks_mod

    print("\nstream")
    monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", 0.01)
    (tmp_path / "p").mkdir()
    tm, events = manager(settings, StreamClient)
    sessions = [tm.start("", "p") for _ in range(50)]
    await until(lambda: all(t.status == "waiting" for t in sessions))
    for t in sessions:
        t.client.held = []
        tm.send(t.id, "go")
    await until(lambda: all(t.busy for t in sessions))
    events.clear()
    before = vitals()
    delta = {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "word " * 4}}
    with Lag() as lag:
        began = time.monotonic()
        for i in range(2000):
            for t in sessions:
                t.client._stream().put_nowait(StreamEvent(uuid="x", session_id="s", event=delta))
            if i % 50 == 0:
                await asyncio.sleep(0)
        await asyncio.sleep(0.3)
    kinds = Counter(kind for kind, _ in events)
    show(
        "50 sessions x 2,000 live words",
        before,
        f"{time.monotonic() - began:.1f}s, events {dict(kinds)}, {lag.said()}",
    )
    task, big = sessions[0], "y" * 5_000_000
    before = vitals()
    with Lag() as lag:
        for n in range(100):
            step = ToolUseBlock(id=f"b{n}", name="Bash", input={"command": "cat big.log"})
            tm._on_task_message(task, AssistantMessage(content=[step], model="m"))
            out = ToolResultBlock(tool_use_id=f"b{n}", content=[{"type": "text", "text": big}])
            tm._on_task_message(task, UserMessage(content=[out]))
            await asyncio.sleep(0)
    weight = len(json.dumps(task.transcript)) / 1e3
    show("100 tool results of 5 MB", before, f"transcript {weight:.0f} KB, {lag.said()}")
    await tm.close()


# ── persist: kept sessions read back at startup ──


def _kept_records(cwd: str, n: int, ended: bool, audit: int) -> list[dict]:
    out = []
    for i in range(n):
        when = (datetime(2026, 1, 1) + timedelta(minutes=i)).isoformat(timespec="seconds")
        out.append(
            {
                "key": uuid.uuid4().hex[:16],
                "id": i + 1,
                "cwd": cwd,
                "session_id": f"sid-{i}",
                "title": f"session {i}",
                "prompt": "fix the flaky login test and add retries",
                "ended": ended,
                "status": "stopped" if ended else "",
                "audit": [
                    {
                        "at": when,
                        "tool": "Edit",
                        "what": f"src/app/module_{k}.py\n- old line {k}\n+ new line {k}" * 6,
                        "decision": "auto",
                        "why": "inside the project",
                    }
                    for k in range(audit)
                ],
                "files_changed": [f"/Users/me/proj/src/f{k}.py" for k in range(120)],
                "created": when,
                "updated": when,
            }
        )
    return out


@pytest.mark.persist
async def test_persist(settings, quiet_speaker, isolated, tmp_path):
    from code_session_fakes import end_all, make_hub

    from jarvis.session_store import STORE_LIMIT, SessionStore

    print("\npersist")
    (tmp_path / "proj").mkdir()
    cwd = str((tmp_path / "proj").resolve())
    folder = tmp_path / "code_sessions"
    for n, audit in ((60, 200), (500, 200), (2000, 300)):  # (at most ~260 MB on disk)
        folder.mkdir(exist_ok=True)
        records = _kept_records(cwd, n, ended=True, audit=audit)
        SessionStore(folder).save({r["key"]: r for r in records}, {r["key"] for r in records})
        del records
        disk = sum(f.stat().st_size for f in folder.glob("*.json")) / 1e6
        hub = make_hub(settings, quiet_speaker, isolated)
        gc.collect()
        before = vitals()
        tracemalloc.start()
        began = time.monotonic()
        await hub.code_sessions.restore()
        took = time.monotonic() - began
        gc.collect()
        held, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        show(
            f"{n} kept, {audit}-entry audits",
            before,
            f"disk {disk:.0f} MB, read back in {took:.1f}s, held {held / 1e6:.0f} MB "
            f"(peak {peak / 1e6:.0f} MB), dormant {len(hub.code_sessions.dormant)}",
        )
        await end_all(hub)
        for f in folder.glob("*"):
            f.unlink()
    open_ones = _kept_records(cwd, STORE_LIMIT + 10, ended=False, audit=0)
    SessionStore(folder).save({r["key"]: r for r in open_ones}, {r["key"] for r in open_ones})
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.code_sessions.restore()
    await hub.code_sessions.flush(final=True)
    await end_all(hub)
    left = len([f for f in folder.glob("*.json") if f.stem != "remembered"])
    print(f"  {STORE_LIMIT + 10} open sessions saved once: {left} files left on disk")


# ── history: long Claude Code records ──


@pytest.mark.history
async def test_history(tmp_path, monkeypatch):
    from claude_agent_sdk._internal.sessions import _canonicalize_path, _sanitize_path

    from jarvis import tasks as tasks_mod

    print("\nhistory")
    config = tmp_path / "claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))  # never the owner's ~/.claude
    cwd = (tmp_path / "proj").resolve()
    cwd.mkdir()
    folder = config / "projects" / _sanitize_path(_canonicalize_path(str(cwd)))
    folder.mkdir(parents=True)
    for turns, out in ((2500, 1000), (12500, 1000), (12500, 4000)):
        sid = str(uuid.uuid4())
        path = folder / f"{sid}.jsonl"
        parent = None
        with path.open("w") as f:
            for n in range(turns):
                for kind, message in (
                    ("user", {"role": "user", "content": f"step {n}"}),
                    ("assistant", {"role": "assistant", "content": [
                        {"type": "tool_use", "id": f"t{n}", "name": "Bash",
                         "input": {"command": f"run {n}"}}]}),
                    ("user", {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": f"t{n}", "content": "o" * out}]}),
                    ("assistant", {"role": "assistant", "content": [
                        {"type": "text", "text": f"done {n}"}]}),
                ):  # fmt: skip
                    line = str(uuid.uuid4())
                    entry = {"type": kind, "uuid": line, "parentUuid": parent, "sessionId": sid,
                             "timestamp": "2026-10-01T00:00:00Z", "message": message}  # fmt: skip
                    f.write(json.dumps(entry) + "\n")
                    parent = line
        size = path.stat().st_size / 1e6
        tasks_mod._history_cache.clear()
        before = vitals()
        tracemalloc.start()
        began = time.monotonic()
        tail = tasks_mod.session_history_tail(sid, cwd)
        tail_took = time.monotonic() - began
        _now, tail_peak = tracemalloc.get_traced_memory()
        tracemalloc.reset_peak()
        began = time.monotonic()
        whole = tasks_mod.session_history(sid, cwd)
        whole_took = time.monotonic() - began
        _now, whole_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        weight = len(json.dumps(whole["entries"])) / 1e3
        show(
            f"{turns * 4} lines ({size:.0f} MB)",
            before,
            f"newest {len(tail['entries']) if tail else 0} in {tail_took:.2f}s "
            f"(peak {tail_peak / 1e6:.0f} MB), whole in {whole_took:.2f}s "
            f"(peak {whole_peak / 1e6:.0f} MB), transcript event {weight:.0f} KB",
        )
        path.unlink()


# ── copies: isolated worktrees ──


@pytest.mark.copies
async def test_copies(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    from test_code_changes import make_repo, numbered
    from test_hub import make_hub

    from jarvis import worktrees

    print("\ncopies")
    projects = tmp_path / "my projects é"
    projects.mkdir()
    make_repo(projects / "proj ü", {"a.py": numbered(50), "b/c.py": numbered(20)})
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.emit = lambda *_a, **_k: None
    hub.add_approval_sink(lambda card: hub.resolve(card["id"], card["choices"][0]["id"]))
    desk = hub.code_desk
    before = vitals()
    with Lag() as lag:
        began = time.monotonic()
        eight = [hub.tasks.start("", "proj ü", isolate=True, title=f"job {i}") for i in range(8)]
        await until(lambda: all(t.client is not None for t in eight), 120)
        took = time.monotonic() - began
    slugs = {t.workspace.get("slug") for t in eight}
    show("8 isolated sessions at once", before, f"{took:.1f}s, {len(slugs)} copies, {lag.said()}")

    monkeypatch.setattr(worktrees, "MAX_COPIES", 12)
    burst = [hub.tasks.start("", "proj ü", isolate=True, title=f"more {i}") for i in range(10)]
    await until(lambda: all(t.client is not None for t in burst), 120)
    print(f"  10 more with a cap of 12 (8 made): {len(desk.store().copies)} copies listed")
    monkeypatch.setattr(worktrees, "MAX_COPIES", 100)  # (room again for what follows)

    entered, go_on = threading.Event(), threading.Event()
    real_adopt = worktrees.adopt

    def slow_adopt(store, root):
        entered.set()
        go_on.wait(30)
        return real_adopt(store, root)

    monkeypatch.setattr(worktrees, "adopt", slow_adopt)
    sweep = asyncio.ensure_future(desk.sweep())
    await until(entered.is_set)
    fresh = hub.tasks.start("", "proj ü", isolate=True, title="during the sweep")
    await until(lambda: fresh.workspace and fresh.client is not None, 60)
    go_on.set()
    await sweep
    monkeypatch.setattr(worktrees, "adopt", real_adopt)
    print(
        f"  a copy made while the sweeper ran (in a copy: {bool(fresh.workspace)}): "
        f"its folder still there: {fresh.cwd.is_dir()}"
    )

    real_git = worktrees.git

    def failing(cwd, *args, **kwargs):
        if args[:2] == ("worktree", "add"):
            return worktrees.code_changes.Git(128, "", "fatal: disk full (simulated)")
        return real_git(cwd, *args, **kwargs)

    monkeypatch.setattr(worktrees, "git", failing)
    half = hub.tasks.start("", "proj ü", isolate=True, title="half made")
    await until(lambda: half.client is not None, 60)
    monkeypatch.setattr(worktrees, "git", real_git)
    left = sorted(p.name for p in (tmp_path / "worktrees" / "proj ü").iterdir())
    print(
        f"  a copy that fails half way: runs in the folder itself: {not half.workspace}, "
        f"folders left: {len(left)} for {len(desk.store().copies)} copies"
    )

    everyone = [*eight, *burst, fresh]
    for t in everyone:
        if t.workspace and t.cwd.is_dir():  # (the sweeper may have taken one away)
            (t.cwd / f"note-{t.id}.txt").write_text(f"work of {t.id}\n")
    for t in everyone:
        hub.tasks.cancel(t.id)
    await asyncio.gather(*(t.handle for t in everyone if t.handle), return_exceptions=True)
    before = vitals()
    began = time.monotonic()
    copies = list(desk.store().copies)
    said = await asyncio.gather(
        *(desk.land(c.slug) if i % 2 else desk.discard(c.slug) for i, c in enumerate(copies))
    )
    landed = sum(1 for s in said if s.startswith("Landed"))
    show(
        f"{len(copies)} copies landed or discarded at once",
        before,
        f"{time.monotonic() - began:.1f}s, landed {landed}, "
        f"discarded {sum(1 for s in said if s.startswith('Discarded'))}, "
        f"left listed {len(desk.store().copies)}",
    )


# ── bang: output kept only at its end ──


@pytest.mark.bang
async def test_bang(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    from test_hub import make_hub

    from jarvis.features.code_bestof import run_tests

    print("\nbang")
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.emit = lambda *_a, **_k: None
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    for mb in (10, 40, 100):
        command = f"head -c {mb * 1_000_000} /dev/zero | tr '\\0' a"
        for name, run in (
            ("! command", lambda c=command: hub.task_bash({"directory": "p", "command": c})),
            ("best-of test run", lambda c=command: run_tests(c, project)),
        ):
            before = vitals()
            tracemalloc.start()
            with Lag() as lag:
                began = time.monotonic()
                await run()
                took = time.monotonic() - began
            _now, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            show(
                f"{name}, {mb} MB of output",
                before,
                f"{took:.1f}s, peak held {peak / 1e6:.0f} MB, {lag.said()}",
            )


def main() -> int:
    stages = sys.argv[1:] or [
        "starts", "steer", "fuzz", "stream", "persist", "history", "copies", "bang",
    ]  # fmt: skip
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT / "tests"))
    return pytest.main(
        [
            __file__,
            "-p",
            "conftest",
            "-p",
            "no:cacheprovider",
            "-o",
            "asyncio_mode=auto",
            "-W",
            "ignore::pytest.PytestUnknownMarkWarning",
            "-s",
            "-q",
            "--rootdir",
            str(ROOT),
            "-m",
            " or ".join(stages),
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main())
