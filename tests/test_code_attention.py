"""Eden Code's Needs attention inbox (features/code_attention.py): one list of everything
waiting on the owner, read from what the other features keep (approval cards, sessions that
finished and haven't been seen, failed sessions, stopped Exterminator Mode and unattended
runs, the queue's failed cards, pairing conflicts), its spoken summary for voice and the
screen reader, and the window telling it a reply was seen."""

import asyncio
import time
from dataclasses import replace

import pytest

from jarvis.features import code_attention
from jarvis.features.code_bugfix import BugRun
from jarvis.features.code_unattended import Run
from jarvis.pairsync import Pair
from jarvis.tasks import ClaudeTask


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    projects = tmp_path / "projects"
    (projects / "app").mkdir(parents=True)
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.projects = projects
    return hub


def task(hub, tid, status="waiting", **extra):
    t = ClaudeTask(id=tid, prompt=f"job {tid}", cwd=hub.projects / "app", status=status, **extra)
    hub.tasks.tasks[tid] = t
    return t


def kinds(hub):
    return [i["kind"] for i in hub.code_attention.collect()]


def test_nothing_waiting_says_so(hub):
    assert hub.code_attention.collect() == []
    assert hub.code_attention.summary() == "Nothing is waiting for you."


def test_an_approval_card_for_a_session_is_listed_first_with_its_choices(hub):
    task(hub, 3, status="running", title="Add a retry")
    task(hub, 4, status="failed", result="Traceback: boom")
    hub.approvals["a1"] = {
        "id": "a1",
        "question": "Run npm install?",
        "detail": "$ npm install",
        "task_id": 3,
        "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Not now"}],
    }
    items = hub.code_attention.collect()
    assert [i["kind"] for i in items] == ["approval", "failed"]
    first = items[0]
    assert first["task"] == 3 and first["approval"] == "a1"
    assert first["said"] == "Session 3 (Add a retry) asks: Run npm install?"
    assert [c["id"] for c in first["choices"]] == ["allow", "deny"]
    assert items[1]["text"] == "Traceback: boom"  # (a session asking isn't listed twice)


def test_a_finished_session_waits_for_a_reply_until_a_window_has_seen_it(hub):
    task(hub, 5, status="waiting", result="Done: added the retry.")
    att = hub.code_attention
    assert kinds(hub) == []  # (finished before this launch heard it: nothing new)
    att.on_task("task_finished", {"id": 5, "task_kind": "code", "status": "done"})
    assert kinds(hub) == ["reply"]
    assert att.collect()[0]["said"] == "Session 5 (job 5) finished and waits for your reply"
    att.cmd_seen({"ids": [5, "x", 99]})
    assert kinds(hub) == []
    # A research task's ending is not Eden Code's.
    att.on_task("task_finished", {"id": 6, "task_kind": "research", "status": "done"})
    assert 6 not in att.unseen


def test_stopped_runs_failed_cards_and_conflicts_are_listed(hub):
    task(hub, 7, status="waiting")
    bug = hub.code_bugfix
    bug.load()
    bug.runs.append(BugRun(id="b1", project="app", state="stopped", why="spend", ended=time.time()))
    bug.runs.append(
        BugRun(id="b2", project="app", state="stopped", why="owner")
    )  # (the owner's own stop)
    bug.runs.append(
        BugRun(id="b3", project="app", state="done", landed="Landed.")
    )  # (landed: over)
    runs = hub.code_runs
    runs.load()
    runs.runs.append(
        Run(
            "r1",
            "Nightly tests",
            "p",
            "app",
            "edits",
            [],
            5.0,
            2.0,
            state="stopped",
            why="time",
            started=time.time(),
            ended=time.time(),
        )
    )
    runs.runs.append(
        Run("r2", "Fine", "p", "app", "edits", [], 5.0, 2.0, state="done", why="finished")
    )
    hub.code_todo.board.cards.append(
        {
            "id": "c1",
            "folder": str(hub.projects / "app"),
            "title": "Write the migration",
            "prompt": "x",
            "state": "failed",
        }
    )
    hub.code_pairing.pairs()["app-1"] = Pair(
        "app-1", "/tmp/copy", "/tmp/pair", conflicts={"a.py": {}, "b.py": {}}
    )
    items = hub.code_attention.collect()
    assert [i["kind"] for i in items] == ["conflict", "exterminator", "run", "queue"]
    said = [i["said"] for i in items]
    assert said[0] == "2 files changed on both sides in app-1's pairing folder"
    assert said[1] == "Exterminator Mode in app stopped: it reached its spending cap"
    assert said[2] == "The run without you in app stopped: it ran out of time"
    assert said[3] == "The queue's card Write the migration failed"
    assert (
        items[1]["pane"] == "bugfix"
        and items[2]["pane"] == "unattended"
        and items[3]["pane"] == "board"
    )


def test_the_summary_names_three_and_counts_the_rest(hub):
    for tid in range(1, 6):
        task(hub, tid, status="failed")
    summary = hub.code_attention.summary()
    assert summary.startswith(
        "5 things are waiting for you: Session 5 (job 5) stopped with an error;"
    )
    assert summary.endswith(", and 2 more.")
    task(hub, 9, status="waiting")
    for tid in range(1, 6):
        del hub.tasks.tasks[tid]
    hub.code_attention.on_task("task_finished", {"id": 9, "task_kind": "code"})
    assert (
        hub.code_attention.summary()
        == "One thing is waiting for you: Session 9 (job 9) finished and waits for your reply."
    )


async def test_the_summary_in_chinese(hub):
    hub.set_prefs({"language": "zh"})
    task(hub, 2, status="failed")
    assert hub.code_attention.summary().startswith("有一件事在等你：")


async def test_a_change_publishes_the_list_once_for_a_burst(hub, monkeypatch):
    monkeypatch.setattr(code_attention, "PUBLISH_DELAY", 0.01)
    att = hub.code_attention
    task(hub, 4, status="failed")
    for _ in range(5):
        att.soon()
    await asyncio.sleep(0.05)
    sent = [d for k, d in hub.events if k == "code_attention"]
    assert len(sent) == 1 and sent[0]["count"] == 1 and sent[0]["items"][0]["kind"] == "failed"
    att.soon()
    await asyncio.sleep(0.05)
    assert len([k for k, _ in hub.events if k == "code_attention"]) == 1  # (nothing changed)
    att.cmd_state({})  # the window asking: always answered
    assert len([k for k, _ in hub.events if k == "code_attention"]) == 2


def test_a_source_that_fails_leaves_the_rest(hub, monkeypatch):
    task(hub, 4, status="failed")
    monkeypatch.setattr(hub.code_attention, "_bugfix", lambda: 1 / 0)
    assert kinds(hub) == ["failed"]


@pytest.mark.parametrize(
    "words",
    [
        "What's waiting?",
        "what needs me",
        "Eden, what's waiting for me?",
        "anything waiting",
        "what needs my attention",
        "有什么在等我",
    ],
)
async def test_whats_waiting_is_answered_at_once(hub, words):
    task(hub, 4, status="failed")
    said = await hub.code_attention.instant(words)
    assert said.startswith("One thing is waiting for you")


async def test_other_words_are_not_its(hub):
    assert await hub.code_attention.instant("what's the weather") is None
    assert await hub.code_attention.voice_hook("run the tests", None) is False


async def test_voice_coding_hears_it_too(hub, monkeypatch):
    said = []
    monkeypatch.setattr(hub, "say", lambda text, follow_up=True: said.append(text))
    assert await hub.code_attention.voice_hook("what's waiting", None) is True
    assert said == ["Nothing is waiting for you."]
