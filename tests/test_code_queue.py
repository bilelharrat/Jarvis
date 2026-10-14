"""The background routing queue (features/code_queue.py): "Run my queue" starts a project's
to-do cards one or N at a time, each on the cheapest model whose past results in the project
passed Eden's checks (the Model Router's event log), else the router's pick, else the
default; a card whose checks fail moves up the ladder; the owner's caps and the queue's own
dollar ceiling hold. Fakes only: the tests' Claude Code, a stand-in for Eden's checks."""

import asyncio
import itertools
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis.features import code_queue
from jarvis.features._router_log import iso
from jarvis.features.code_queue import _Budget
from jarvis.features.code_router_events import project_hash


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    return make_hub(settings, quiet_speaker, isolated)


_MSGS = itertools.count()


class Checks:
    """code_verify as the queue sees it: each check's outcome, in order."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.sessions = {}
        self.ran = []

    def session(self, task_id):
        return self.sessions.setdefault(task_id, SimpleNamespace(checking=False, last=None))

    async def check_turn(self, task, by_owner=False):
        self.ran.append((task.id, by_owner))
        status = self.outcomes.pop(0)
        self.session(task.id).last = {"status": status, "at": time.time(), "text": "2 tests failed"}


def learned(hub, folder, rows):
    """Past routed messages in the project, as the router's event log keeps them."""
    log = hub.code_router_events.log
    for model, signals in rows:
        msg = f"m{next(_MSGS)}"  # (each message's own id, as the log's are)
        log.append({"v": 1, "ts": iso(), "session": "s", "msg": msg, "project": project_hash(folder),
                    "applied": {"model": model, "effort": ""}})  # fmt: skip
        log.append(
            {"v": 1, "kind": "update", "ts": iso(), "session": "s", "msg": msg, "signals": signals}
        )


async def add(hub, *prompts, **settings):
    for prompt in prompts:
        await hub._handle({"type": "todo_add", "directory": "proj", "prompt": prompt, **settings})
    return list(hub.code_todo.board.cards)


async def test_the_pick_is_the_cheapest_model_that_passed_here_else_the_router_s_else_the_default(
    hub, tmp_path
):
    folder = str(tmp_path / "proj")
    queue = hub.code_queue
    (card,) = await add(hub, "fix the flaky test")
    assert await queue.pick(folder, card) == ("", "default")
    card["route"] = {"ref": "sonnet", "model": "claude-sonnet-5-5"}
    assert await queue.pick(folder, card) == ("sonnet", "router")
    learned(hub, folder, [
        ("claude-haiku-4-5", {"verified": False}),  # Haiku: 1 of 3 passed here
        ("claude-haiku-4-5", {"verified": True}),
        ("claude-haiku-4-5", {"testsPassed": True, "reverted": True}),  # (undone: not a pass)
        ("claude-opus-5-5", {"verified": True}),
        ("claude-sonnet-5-5", {"testsPassed": True}),
        ("claude-sonnet-5-5", {"verified": True}),
        ("claude-sonnet-5-5", {"completed": True}),  # (says nothing of how it went)
    ])  # fmt: skip
    learned(hub, str(tmp_path / "elsewhere"), [("claude-haiku-4-5", {"verified": True})] * 5)
    assert await queue.learned(folder) == {
        "claude-haiku-4-5": (1, 2),
        "claude-opus-5-5": (1, 0),
        "claude-sonnet-5-5": (2, 0),
    }
    assert await queue.pick(folder, card) == ("sonnet", "learned")  # cheapest that passes here
    card["model"] = "opus"
    assert await queue.pick(folder, card) == ("opus", "card")  # the owner's own choice


async def test_run_my_queue_runs_the_cards_one_at_a_time_on_the_learned_model(hub, tmp_path):
    folder = str(tmp_path / "proj")
    learned(hub, folder, [("claude-haiku-4-5", {"verified": True})])
    seen = events_of(hub)
    first, second = await add(hub, "first job", "second job")
    queue, most = hub.code_queue, []
    changed = queue.changed

    def counted():  # (how many run at once, each time the queue's state changes)
        most.extend(len(queue.running(run)) for run in queue.runs.values())
        changed()

    queue.changed = counted
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "parallel": 1, "ceiling": 3})
    assert await until(lambda: first.get("task"), 2000)
    task = hub.tasks.tasks[first["task"]]
    assert task.model_ref == "haiku"
    assert {k: first["attempts"][0][k] for k in ("model", "why")} == {
        "model": "haiku",
        "why": "learned",
    }
    # Its turn ends with nothing changed: nothing to check, so done (not verified); the next goes.
    assert await until(lambda: first["state"] == "done", 2000)
    assert first["verified"] is None
    assert await until(lambda: second["state"] == "done", 2000)
    assert max(most) == 1  # one at a time
    assert hub.tasks.tasks[second["task"]].model_ref == "haiku"
    state = [e for e in seen() if e["type"] == "todo_state"][-1]
    assert state["queue"] is True
    assert state["queues"][folder]["on"] is False
    assert state["queues"][folder]["note"] == "All the cards have run."
    assert state["queues"][folder]["ceiling"] == 3.0
    # The queue logged each as a routed message of its own, for the learner.
    records = [
        r
        for r in hub.code_router_events.log.read()
        if (r.get("route") or {}).get("source") == "queue"
    ]
    assert len(records) == 2 and {r["applied"]["model"] for r in records} == {"claude-haiku-4-5"}
    await end_all(hub)


class Fake:
    """A session as the queue sees it, started by the to-do column's start (stubbed)."""

    def __init__(self, tid, cwd, ref="haiku"):
        self.id, self.kind, self.cwd, self.workspace = tid, "code", cwd, None
        self.model_ref, self.model = ref, code_queue.MODELS[ref]
        self.effort, self.transcript, self.session_id = "", [], ""
        self.cost_usd, self.cost_inherited = 0.0, 0.0


def stub_sessions(hub, monkeypatch, tmp_path, costs=()):
    started, sent, ids = [], [], iter(range(100, 200))
    costs = list(costs)

    async def start(card, model="", route=None):
        task = Fake(next(ids), tmp_path / "proj", model or "haiku")
        hub.tasks.tasks[task.id] = task
        card["task"] = task.id
        started.append((card["id"], model))
        return task

    async def move(task_id, ref):
        task = hub.tasks.tasks[task_id]
        task.model_ref, task.model = ref, code_queue.MODELS[ref]

    monkeypatch.setattr(hub.code_todo, "start", start)
    monkeypatch.setattr(hub, "_task_model", move)
    monkeypatch.setattr(
        hub.tasks, "send", lambda tid, text, *a, **k: sent.append((tid, text)) or True
    )

    def finish(card, status="done", files=("a.py",)):
        task = hub.tasks.tasks[card["task"]]
        if costs:
            task.cost_usd += costs.pop(0)
        hub.code_queue.on_task_event(
            "task_finished",
            {"id": task.id, "task_kind": "code", "status": status, "files": list(files)},
        )

    return started, sent, finish


async def test_failed_checks_move_the_card_up_the_ladder_and_teach_the_next_pick(
    hub, monkeypatch, tmp_path
):
    hub.code_verify = Checks(["problems", "ok"])
    started, sent, finish = stub_sessions(hub, monkeypatch, tmp_path)
    (card,) = await add(hub, "make the checkout faster")
    await hub._handle({"type": "todo_queue_run", "directory": "proj"})
    assert await until(lambda: started)
    task = hub.tasks.tasks[card["task"]]
    finish(card)  # Haiku's work: the checks find problems
    assert await until(lambda: sent)
    assert task.model_ref == "sonnet" and card["state"] == "running"
    ((tid, text),) = sent
    assert tid == task.id and "2 tests failed" in text and "Sonnet" in text
    finish(card)  # Sonnet's: the checks pass
    assert await until(lambda: card["state"] == "done")
    assert card["verified"] is True
    assert [(a["model"], a["outcome"]) for a in card["attempts"]] == [
        ("haiku", False),
        ("sonnet", True),
    ]
    assert hub.code_verify.ran == [(task.id, True), (task.id, True)]
    # What the checks said is in the router's log: in this project Sonnet passes, Haiku didn't.
    folder = str(tmp_path / "proj")
    assert await hub.code_queue.learned(folder) == {
        "claude-haiku-4-5": (0, 1),
        "claude-sonnet-5-5": (1, 0),
    }
    again = (await add(hub, "and the cart too"))[-1]
    assert await hub.code_queue.pick(folder, again) == ("sonnet", "learned")


async def test_past_the_top_of_the_ladder_or_a_named_model_the_card_fails(
    hub, monkeypatch, tmp_path
):
    hub.code_verify = Checks(["problems", "problems"])
    monkeypatch.setattr(
        hub.prefs, "feature", _with(hub.prefs.feature, code_queue_ladder=["haiku", "sonnet"])
    )
    started, sent, finish = stub_sessions(hub, monkeypatch, tmp_path)
    named, ladder = await add(hub, "the owner named Haiku", "the ladder")
    named["model"] = "haiku"
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "parallel": 2})
    assert await until(lambda: len(started) == 2)
    finish(named)
    assert await until(lambda: named["state"] == "failed")
    assert sent == []  # (never another model behind the owner's back)
    finish(ladder)
    assert await until(lambda: len(sent) == 1)
    finish(ladder, status="failed")  # Sonnet's turn failed outright: the top of this ladder
    assert await until(lambda: ladder["state"] == "failed")
    assert len(sent) == 1


def _with(feature, **values):
    return lambda key: values[key] if key in values else feature(key)


async def test_the_queue_s_ceiling_and_the_owner_s_caps_hold(hub, monkeypatch, tmp_path):
    hub.code_verify = Checks(["ok"] * 5)
    started, sent, finish = stub_sessions(hub, monkeypatch, tmp_path, costs=[4.0, 1.5])
    cards = await add(hub, "one", "two", "three")
    # Today's cap is used up: the queue waits, and says why.
    meter = hub.code_usage
    monkeypatch.setattr(hub.prefs, "feature", _with(hub.prefs.feature, code_budget_day=2.0))
    monkeypatch.setattr(meter.usage, "today", lambda: 2.0)
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "ceiling": 5})
    folder = str(tmp_path / "proj")
    assert started == []
    assert (
        hub.code_queue.public()[folder]["note"]
        == "Waiting: today's Eden Code spending limit is used up."
    )
    monkeypatch.setattr(meter.usage, "today", lambda: 0.0)  # a new day
    hub.code_queue.pump(folder)
    assert await until(lambda: len(started) == 1)
    # The session's own cap is its share of what's left of the ceiling.
    options = SimpleNamespace(max_budget_usd=None)
    _Budget(hub.code_queue).apply(hub.tasks.tasks[cards[0]["task"]], options)
    assert options.max_budget_usd == 5.0
    finish(cards[0])  # $4 spent
    assert await until(lambda: len(started) == 2)
    options = SimpleNamespace(max_budget_usd=3.0)  # (a lower cap of another feature's stays)
    _Budget(hub.code_queue).apply(hub.tasks.tasks[cards[1]["task"]], options)
    assert options.max_budget_usd == 1.0
    finish(cards[1])  # $5.50 in all: past the ceiling, nothing more starts
    assert await until(lambda: not hub.code_queue.runs[folder].on)
    await asyncio.sleep(0.05)
    assert len(started) == 2 and cards[2]["state"] == "todo"
    shown = hub.code_queue.public()[folder]
    assert (
        shown["note"] == "Stopped: the queue has spent its $5.00 ceiling." and shown["spent"] == 5.5
    )


async def test_stopping_the_queue_starts_nothing_more_and_a_stopped_card_says_so(
    hub, monkeypatch, tmp_path
):
    hub.code_verify = Checks([])
    started, _sent, finish = stub_sessions(hub, monkeypatch, tmp_path)
    first, second = await add(hub, "one", "two")
    await hub._handle({"type": "todo_queue_run", "directory": "proj"})
    assert await until(lambda: started)
    await hub._handle({"type": "todo_queue_stop", "directory": "proj"})
    assert second["state"] == "todo"
    finish(first, status="stopped")
    assert await until(lambda: first["state"] == "stopped")
    await asyncio.sleep(0.05)
    assert len(started) == 1
    assert Path(first["folder"]).name == "proj"


async def test_stop_then_run_again_keeps_the_running_card_in_the_queue_s_limits(
    hub, monkeypatch, tmp_path
):
    """Round 1's D8: a card still running when the queue is stopped and run again counts
    against the run's parallel limit and ceiling, not outside them."""
    hub.code_verify = Checks(["ok"] * 3)
    started, _sent, finish = stub_sessions(hub, monkeypatch, tmp_path, costs=[4.5])
    first, second = await add(hub, "one", "two")
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "parallel": 1, "ceiling": 5})
    assert await until(lambda: started)
    await hub._handle({"type": "todo_queue_stop", "directory": "proj"})
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "parallel": 1, "ceiling": 5})
    await asyncio.sleep(0.05)
    assert len(started) == 1 and second["state"] == "queued"  # (one at a time still)
    folder = str(tmp_path / "proj")
    assert first["run"] == hub.code_queue.runs[folder].id
    hub.tasks.tasks[first["task"]].cost_usd = 4.5
    options = SimpleNamespace(max_budget_usd=None)
    _Budget(hub.code_queue).apply(hub.tasks.tasks[first["task"]], options)
    assert options.max_budget_usd == 0.5  # (its spend is the queue's)


async def test_deleting_a_finished_card_keeps_its_spend_and_a_running_card_can_t_be_deleted(
    hub, monkeypatch, tmp_path
):
    """Round 1's break: tidying the board made room under the ceiling (a finished card's
    spend went with it), and deleting a running card freed its slot and its budget."""
    hub.code_verify = Checks(["ok"] * 5)
    started, _sent, finish = stub_sessions(hub, monkeypatch, tmp_path, costs=[0.1, 0.1, 0.1])
    one, two, three = await add(hub, "one", "two", "three")
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "ceiling": 0.15})
    assert await until(lambda: len(started) == 1)
    seen = events_of(hub)
    await hub._handle({"type": "todo_delete", "id": one["id"]})  # running: refused
    assert [e["text"] for e in seen() if e["type"] == "todo_error"] == ["That card is already running."]
    assert hub.code_todo.board.get(one["id"]) is not None
    finish(one)
    assert await until(lambda: len(started) == 2)
    await hub._handle({"type": "todo_delete", "id": one["id"]})  # finished: its $0.10 stays
    assert hub.code_queue.public()[str(tmp_path / "proj")]["spent"] >= 0.1
    finish(two)
    await asyncio.sleep(0.1)
    assert len(started) == 2 and three["state"] != "running"


@pytest.mark.parametrize("ceiling", [0, -5, 0.0001])
async def test_a_ceiling_under_five_cents_is_refused(hub, monkeypatch, tmp_path, ceiling):
    hub.code_verify = Checks([])
    started, _sent, _finish = stub_sessions(hub, monkeypatch, tmp_path)
    await add(hub, "one")
    seen = events_of(hub)
    await hub._handle({"type": "todo_queue_run", "directory": "proj", "ceiling": ceiling})
    await asyncio.sleep(0.05)
    assert not started
    assert [e["text"] for e in seen() if e["type"] == "todo_error"] == [
        "A queue's ceiling is at least $0.05."
    ]


async def test_a_400_digit_ceiling_is_the_default_not_a_crash(hub, monkeypatch, tmp_path):
    hub.code_verify = Checks([])
    stub_sessions(hub, monkeypatch, tmp_path)
    await add(hub, "one")
    hub.code_queue.cmd_run({"directory": "proj", "ceiling": 10**400})
    assert hub.code_queue.runs[str(tmp_path / "proj")].ceiling == code_queue.CEILING_DEFAULT
