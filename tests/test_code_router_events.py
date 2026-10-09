"""Model Router's learning loop and extras in Eden Code (features/code_router_events, and
code_router's fallback and effort): the event log (route records with no prompt text,
updates with what the turn used and the signals, rotation and retention), the owner's acts
as signals, Shadow mode, the window's state (quota, budget, context, learned overrides),
spend, Reset/Freeze and the learner, per-project defaults, the automatic fallback, and
other providers' models at the routed effort. No model is ever called."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from code_session_fakes import make_hub

from jarvis.codeusage import Window
from jarvis.features import _router_log, code_router, code_router_events
from jarvis.features._router_log import EventLog
from jarvis.features.code_router_events import (
    clean_info,
    clean_projects,
    prompt_hash,
    verdict_of,
)
from jarvis.tasks import ClaudeTask

KEY = "sk-or-v1-" + "0123456789abcdef" * 4
SECRET_PROMPT = "please refactor the scheduler in the zebra-unicorn project to use a heap"
INFO = {
    "profile": {
        "complexity": "complex",
        "score": 0.71,
        "weights": {"coding": 0.6, "reasoning": 0.4},
        "inputTokens": 900,
        "outputTokens": 1200,
        "signals": ["zebra-unicorn"],  # (an analyzer label with prompt words: never kept)
    },
    "rating": {"used": True, "by": "gemini-3.6-flash", "complexity": "complex", "reason": "zebra"},
    "settings": {"efficiency": 50, "performance": 50, "classifier": "always", "level": 3},
    "pick": {"model": "claude-sonnet-5-5", "effort": "low", "quality": 82.1, "costUSD": 0.012},
    "best": {"model": "claude-opus-5-5", "effort": "max", "quality": 88.0, "costUSD": 0.2},
    "alternatives": [{"model": "gpt-6-luna", "effort": "medium", "quality": 80, "costUSD": 0.004}],
    "extras": {"sessionTokens": 42000, "agenticCallsPerTurn": 8, "sticky": True},
}
ROUTE = {
    "ref": "sonnet",
    "effort": "low",
    "model": "claude-sonnet-5-5",
    "info": INFO,
    "fallbacks": [{"ref": "opus", "model": "claude-opus-5-5", "effort": "high"}],
}


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def sent_to_sessions(hub):
    calls = []
    hub.tasks.send = lambda task_id, text, images=None, **kw: calls.append(
        (task_id, text, hub.tasks.tasks[task_id].model, hub.tasks.tasks[task_id].effort, kw)
    )
    return calls


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


def session(hub, tmp_path, **fields):
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    task.model, task.model_ref = "claude-opus-5-5", "opus"
    for k, v in fields.items():
        setattr(task, k, v)
    hub.tasks.tasks[7] = task
    return task


async def records(hub):
    events = hub.code_router_events
    await events.log.flush()
    return list(events.log.read())


def result(cost=0.5, is_error=False, reason=None, usage=None, **more):
    return ResultMessage(
        subtype="success", duration_ms=1500, duration_api_ms=1200, is_error=is_error,
        num_turns=6, session_id="s", total_cost_usd=cost, result="done",
        usage=usage or {"input_tokens": 1000, "output_tokens": 300,
                        "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 500},
        terminal_reason=reason, **more,
    )  # fmt: skip


async def routed_turn(hub, task, text=SECRET_PROMPT, route=ROUTE, cost=0.25):
    """A routed message: sent, its user entry, and its turn's end (with the turn line)."""
    await hub.handle({"type": "task_send", "id": task.id, "text": text, "route": route})
    events = hub.code_router_events
    assert await until(lambda: task.id in events.tracks and events.tracks[task.id].pending)
    hub.tasks._log(task, "user", text)
    hub.tasks._log(task, "turn", "", seconds=2, tokens=10800, cost=cost)
    events.on_message(task, result())
    return events.tracks[task.id].last


# ── the log file ──


def test_the_log_rotates_keeps_three_files_and_skips_torn_lines(tmp_path):
    log = EventLog(tmp_path / "e.jsonl", rotate_bytes=400)
    for i in range(30):
        log.append({"v": 1, "ts": _router_log.iso(), "n": i, "pad": "x" * 40})
    files = log.files()
    assert [p.name for p in files] == ["e.jsonl.2", "e.jsonl.1", "e.jsonl"]
    assert all(p.stat().st_size <= 400 for p in files)
    assert oct(files[-1].stat().st_mode & 0o777) == "0o600"
    with files[-1].open("a") as f:
        f.write('{"torn": \n[1, 2]\n')
    got = [r["n"] for r in log.read()]
    assert got == sorted(got) and got[-1] == 29 and len(got) < 30  # (the oldest rotated away)


def test_retention_drops_old_lines_and_old_files(tmp_path):
    now = time.time()
    log = EventLog(tmp_path / "e.jsonl", days=90, clock=lambda: now)
    old, new = _router_log.iso(now - 100 * 86400), _router_log.iso(now - 86400)
    (tmp_path / "e.jsonl.1").write_text(json.dumps({"ts": old, "n": 0}) + "\n")
    (tmp_path / "e.jsonl").write_text(
        json.dumps({"ts": old, "n": 1}) + "\n" + json.dumps({"ts": new, "n": 2}) + "\n"
    )
    assert log.prune() == 2
    assert [r["n"] for r in log.read()] == [2] and not (tmp_path / "e.jsonl.1").exists()
    assert [r["n"] for r in log.read(since=now - 2 * 86400)] == [2]


async def test_writes_go_off_the_event_loop_and_all_land(tmp_path):
    log = EventLog(tmp_path / "e.jsonl")
    for i in range(500):
        log.append({"v": 1, "ts": _router_log.iso(), "n": i})
    log.append({"bad": float("nan")})  # (not JSON: left out, nothing else lost)
    await log.flush()
    assert [r["n"] for r in log.read()] == list(range(500))


# ── a routed message, logged ──


async def test_a_routed_message_is_logged_without_its_words(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    turn = await routed_turn(hub, task)
    assert calls and calls[0][2] == "claude-sonnet-5-5" and calls[0][3] == "low"
    lines = await records(hub)
    raw = hub.feature_path(code_router_events.EVENTS_FILE).read_text()
    assert "zebra" not in raw and "scheduler" not in raw  # no prompt text, no labels
    route, update = lines[0], lines[-1]
    assert route["v"] == 1 and route["msg"] == turn.msg and len(route["session"]) == 16
    assert route["prompt"] == {
        "hash": prompt_hash(SECRET_PROMPT),
        "chars": len(SECRET_PROMPT),
        "profile": {
            "complexity": "complex",
            "score": 0.71,
            "weights": {"coding": 0.6, "reasoning": 0.4},
            "inputTokens": 900,
            "outputTokens": 1200,
        },
    }
    assert route["rating"] == {"used": True, "by": "gemini-3.6-flash", "complexity": "complex"}
    assert route["pick"]["model"] == "claude-sonnet-5-5" and route["settings"]["shadow"] is False
    assert route["applied"] == {"model": "claude-sonnet-5-5", "effort": "low"}
    assert route["alternatives"][0]["model"] == "gpt-6-luna" and route["best"]["quality"] == 88
    assert route["route"]["source"] == "chip" and len(route["project"]) == 12
    assert route["route"].get("waitedMs", 0) < 1000  # (held only while the session moved)
    assert update["kind"] == "update" and update["msg"] == turn.msg
    actual = update["actual"]
    assert actual["inputTokens"] == 10500 and actual["outputTokens"] == 300
    assert actual["calls"] == 6 and actual["latencyMs"] == 1500
    assert actual["costUSD"] == 0 and actual["notionalUSD"] == 0.25  # Claude: the plan
    assert update["signals"] == {"completed": True}


async def test_an_unrouted_message_in_between_isnt_counted_for_the_routed_one(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    turn = await routed_turn(hub, task)
    events = hub.code_router_events
    hub.tasks._log(task, "user", "something typed by voice, never routed")
    events.on_message(task, result())
    assert turn.actual["turns"] == 1  # (only its own turn)
    assert events.tracks[7].current is None


async def test_a_steer_stays_in_the_routed_turn(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    events = hub.code_router_events
    await hub.handle({"type": "task_send", "id": 7, "text": SECRET_PROMPT, "route": ROUTE})
    assert await until(lambda: events.tracks.get(7) and events.tracks[7].pending)
    hub.tasks._log(task, "user", SECRET_PROMPT)
    turn = events.tracks[7].current
    hub.tasks._log(task, "user", "also keep the old API working")  # (into the running step)
    assert events.tracks[7].current is turn
    events.on_message(task, result())
    assert turn.actual["turns"] == 1 and events.tracks[7].last is turn


async def test_the_turns_signals_tests_interrupts_errors(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    events = hub.code_router_events
    await hub.handle(
        {"type": "task_send", "id": 7, "text": "fix the failing tests", "route": ROUTE}
    )
    assert await until(lambda: events.tracks.get(7) and events.tracks[7].pending)
    hub.tasks._log(task, "user", "fix the failing tests")
    hub.tasks._log(task, "tool", "Running npm test", tool="Bash", tool_id="t1", detail="$ npm test")
    hub.tasks.emit("task_log_update", id=7, tool_id="t1", status="failed", output="2 failed")
    hub.tasks._log(task, "tool", "Running npm test", tool="Bash", tool_id="t2")
    hub.tasks.emit("task_log_update", id=7, tool_id="t2", status="done", output="9 passed")
    events.on_message(task, result())
    turn = events.tracks[7].last
    assert turn.signals["testsPassed"] is True and turn.signals["completed"] is True
    # A second message, stopped by the owner: interrupted.
    await hub.handle(
        {"type": "task_send", "id": 7, "text": "and the docs too please", "route": ROUTE}
    )
    assert await until(lambda: events.tracks[7].pending)
    hub.tasks._log(task, "user", "and the docs too please")
    events.on_message(task, result(reason="aborted_streaming"))
    second = events.tracks[7].last
    assert second is not turn and second.signals["interrupted"] is True
    assert second.signals["completed"] is False
    # One that failed at the provider: an error, not a quality signal.
    await hub.handle(
        {"type": "task_send", "id": 7, "text": "third message here ok", "route": ROUTE}
    )
    assert await until(lambda: events.tracks[7].pending)
    hub.tasks._log(task, "user", "third message here ok")
    events.on_message(task, result(is_error=True, api_error_status=529))
    assert events.tracks[7].last.signals["error"] == "529"


async def test_the_owners_acts_after_a_routed_message_are_signals(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    turn = await routed_turn(hub, task)
    # Picked from the menu (the router was routing): an override.
    await hub._handle({"type": "task_model", "id": 7, "ref": "opus"})
    assert turn.signals["override"] == {"to": "claude-opus-5-5", "by": "menu"}
    assert task.model_ref == "opus"  # (and the menu's own handler still ran)
    await hub.handle({"type": "task_effort", "id": 7, "effort": "max"})
    assert turn.signals["effortChanged"] == "max" and task.effort == "max"
    # The owner's next words: pushback, and mostly the same words again (a retry).
    hub.tasks._log(task, "user", "no, " + SECRET_PROMPT)
    assert turn.signals["negativeFollowup"] is True and turn.signals["retry"] is True
    assert turn.signals["retryKind"] == "rephrase"
    # Undo: that round's changes taken back.
    await hub._handle({"type": "task_undo", "id": 7})
    assert turn.signals["reverted"] is True and turn.signals["revertKind"] == "undo"
    written = [r for r in await records(hub) if r.get("kind") == "update" and "signals" in r]
    merged = {}
    for r in written:
        merged.update(r["signals"])
    assert merged["override"]["to"] == "claude-opus-5-5" and merged["negativeFollowup"] is True
    assert "no, " not in json.dumps(written)  # (the owner's words are never kept)


async def test_thanks_and_a_rewind_with_new_words(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    turn = await routed_turn(hub, task)
    hub.code_router_events._on_meta({"id": 7, "n": turn.n, "uuid": "u-1"})
    hub.tasks._log(task, "user", "perfect, works now. Next: the docs")
    assert turn.signals == {"completed": True, "positiveFollowup": True}
    hub.code_router_events.on_command(
        "code_rewind", {"id": 7, "uuid": "u-1", "text": "do it differently", "files": True}
    )
    assert turn.signals["retry"] is True and turn.signals["retryKind"] == "rewind"
    assert turn.signals["reverted"] is True and turn.signals["revertKind"] == "rewind"


def test_pushback_and_thanks_in_english_and_chinese():
    for text in ("No, that's wrong", "that's not what I asked", "still failing", "不对，重来"):
        assert verdict_of(text) == -1, text
    for text in ("Thanks!", "perfect", "works now, ship it", "谢谢"):
        assert verdict_of(text) == 1, text
    for text in ("No problem, now add the docs", "add a test", "note: x", "nothing else"):
        assert verdict_of(text) == 0, text


async def test_feedback_on_the_latest_message_or_on_a_draft(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    events = hub.code_router_events
    turn = await routed_turn(hub, task)
    await hub.handle({"type": "model_router_feedback", "kind": "thumbs-down", "id": 7})
    assert turn.signals["thumbs"] == "down"
    await hub.handle(
        {"type": "model_router_feedback", "kind": "wrong-pick", "id": 7, "prompt": SECRET_PROMPT,
         "chosen": "claude-opus-5-5"}
    )  # fmt: skip
    assert turn.signals["override"] == {"to": "claude-opus-5-5", "by": "feedback"}
    assert turn.signals["wrongPick"] is True
    # A draft that never went: a feedback line, the prompt hashed.
    draft = "a draft about the zebra-unicorn migration plan"
    feedback = {"type": "model_router_feedback", "kind": "wrong-pick", "id": 7, "prompt": draft,
                "pick": {"model": "gpt-6-luna", "effort": "low"}, "chosen": "claude-opus-5-5"}  # fmt: skip
    await hub.handle(feedback)
    line = [r for r in await records(hub) if r.get("kind") == "feedback"][-1]
    assert line["prompt"] == {"hash": prompt_hash(draft), "chars": len(draft)}
    assert (
        line["pick"] == {"model": "gpt-6-luna", "effort": "low"} and line["signal"] == "wrong-pick"
    )
    # Only with "Learn from my prompts" on: an excerpt, the owner's secrets redacted.
    hub.set_feature_prefs({"code_router_settings": {"learnFromPrompts": True}})
    hub.tasks.redactors.append(lambda _t, text: text.replace("zebra-unicorn", "$PROJECT"))
    await hub.handle(feedback)
    line = [r for r in await records(hub) if r.get("kind") == "feedback"][-1]
    assert line["prompt"]["excerpt"] == "a draft about the $PROJECT migration plan"
    await hub.handle({"type": "model_router_feedback", "kind": "nonsense", "id": 7})
    assert events.tracks[7].last is turn


def test_the_windows_numbers_are_cleaned():
    info = clean_info(
        {**INFO, "pick": {"model": "bad model id!", "quality": "x"}, "extras": {"quota": 3}}
    )
    assert "pick" not in info and info["extras"] == {"quota": 1.0}
    assert "signals" not in info["profile"] and "reason" not in info["rating"]
    assert clean_info("nope") == {}
    assert clean_info({"profile": {"weights": {"a b": 1}}}) == {}  # (a key that isn't a word)
    assert clean_projects({"abcdefabcdef": {"efficiency": 80.4, "performance": 20}, "x": {}}) == {
        "abcdefabcdef": {"efficiency": 80, "performance": 20}
    }
    assert clean_projects("x") is None


# ── Shadow mode ──


async def test_shadow_mode_logs_the_pick_and_moves_nothing(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle(
        {"type": "task_send", "id": 7, "text": "rename x", "route": {**ROUTE, "shadow": True}}
    )
    assert await until(lambda: calls)
    assert task.model_ref == "opus" and calls[0][2] == "claude-opus-5-5"
    (route,) = await records(hub)
    assert route["settings"]["shadow"] is True
    assert route["pick"]["model"] == "claude-sonnet-5-5"
    assert route["applied"]["model"] == "claude-opus-5-5"  # the session's own
    # Switching after a Shadow message is implicit, not an override of the router.
    hub.tasks._log(task, "user", "rename x")
    await hub._handle({"type": "task_model", "id": 7, "ref": "haiku"})
    turn = hub.code_router_events.tracks[7].last
    assert turn.signals == {"switchedAfter": True, "switchedTo": "claude-haiku-4-5"}
    assert 7 not in hub.code_router.routes  # (and no fallback from a route it didn't take)


# ── the window's state ──


async def test_the_state_has_quota_budget_context_and_the_learned_overrides(hub, tmp_path):
    task = session(hub, tmp_path)
    events = hub.code_router_events
    later = time.time() + 3600
    hub.usage.limits = {
        "five_hour": {"utilization": 0.62, "resets_at": later, "status": "allowed"},
        "seven_day": {"utilization": 0.4, "resets_at": later, "status": "allowed"},
        "seven_day_opus": {"utilization": 0.99, "resets_at": later},  # (not a window it weighs)
    }
    state = events.state()
    assert state["quota"] == {"five_hour": 0.62, "seven_day": 0.4, "used": 0.62}
    # Claude Code's own report, newer and higher, and a window that has reset since.
    hub.code_usage.usage.windows["seven_day"] = Window("seven_day", "allowed", 0.9, later, 0)
    hub.usage.limits["five_hour"]["resets_at"] = time.time() - 5
    assert events.state()["quota"] == {"seven_day": 0.9, "used": 0.9}
    hub.code_usage.usage.windows["five_hour"] = Window("five_hour", "rejected", None, later, 0)
    assert events.state()["quota"]["used"] == 1.0
    # The session's context: the latest reply's input tokens.
    usage = {
        "input_tokens": 12,
        "cache_read_input_tokens": 41000,
        "cache_creation_input_tokens": 988,
    }
    events.on_message(task, AssistantMessage(content=[TextBlock("hi")], model="m", usage=usage))
    session_state = events.state()["sessions"]["7"]
    assert session_state["contextTokens"] == 42000 and len(session_state["project"]) == 12
    assert events.state()["agenticCallsPerTurn"] == 8
    hub.set_feature_prefs({"code_router_agentic_calls": 5})
    assert events.state()["agenticCallsPerTurn"] == 5
    # Learned overrides: passed on with learning on, none with it off.
    learned = {"v": 1, "updated": "2026-10-06T03:40:00Z", "frozen": False,
               "overrides": {"gpt-6.1-sol": {"capabilities": {"coding": 91}}},
               "report": [{"model": "gpt-6.1-sol", "dim": "coding", "from": 84, "to": 91,
                           "n": 12, "why": "12 graded turns"}]}  # fmt: skip
    hub.feature_path("learned.json").write_text(json.dumps(learned))
    assert events.state()["learned"]["overrides"] == learned["overrides"]
    hub.set_feature_prefs({"code_router_settings": {"learn": False}})
    assert events.state()["learned"] == {
        "on": False, "frozen": False, "updated": "2026-10-06T03:40:00Z", "overrides": {},
    }  # fmt: skip
    emitted = []
    hub.emit = lambda kind, **data: emitted.append((kind, data))
    await hub.handle({"type": "model_router_state_get"})
    assert emitted[-1][0] == "model_router_state" and "quota" in emitted[-1][1]


async def test_budget_pressure_and_this_months_spend(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    events = hub.code_router_events
    # Another provider's model, priced at the router's prices (the window sends them).
    provider = hub.providers.add_provider("openrouter", "", KEY)
    ref = hub.providers.add_model(provider["id"], "gpt-6-luna")["ref"]
    await hub.handle(
        {
            "type": "model_router_prices",
            "prices": {"gpt-6-luna": {"in": 1.0, "out": 10.0}, "x y": {}},
        }
    )
    assert events.prices == {"gpt-6-luna": {"in": 1.0, "out": 10.0}}
    await events.load_month()
    luna = {"ref": ref, "model": "gpt-6-luna", "info": INFO}
    await hub.handle({"type": "task_send", "id": 7, "text": "a luna message here", "route": luna})
    assert await until(lambda: events.tracks.get(7) and events.tracks[7].pending)
    assert task.model == "gpt-6-luna"
    hub.tasks._log(task, "user", "a luna message here")
    usage = {"input_tokens": 1_000_000, "output_tokens": 100_000}
    events.on_message(task, result(usage=usage))
    assert events.tracks[7].last.actual["costUSD"] == 2.0  # 1M in at $1 + 100k out at $10
    assert events.month_spent() == 2.0
    hub.set_feature_prefs({"code_router_budget": 2.2})
    budget = events.state()["budget"]
    assert budget["fraction"] == pytest.approx(0.9091, abs=1e-3)
    assert budget["boost"] == pytest.approx(21.8, abs=0.1)  # 40 points × (91% − 80%) / 20%
    hub.set_feature_prefs({"code_router_budget": 100.0})
    assert events.state()["budget"]["boost"] == 0
    emitted = []
    hub.emit = lambda kind, **data: emitted.append((kind, data))
    await hub._handle({"type": "model_router_call", "rid": "c1", "op": "spend"})
    kind, data = emitted[-1]
    assert kind == "model_router_reply" and data["ok"] and data["rid"] == "c1"
    spend = data["data"]
    assert spend["totalUSD"] == 2.0 and spend["byModel"] == [
        {"model": "gpt-6-luna", "calls": 1, "usd": 2.0, "notionalUSD": 2.0}
    ]
    assert spend["savedVsBestUSD"] == pytest.approx(0.188) and spend["budgetUSD"] == 100.0
    assert spend["periodStart"].endswith("Z") and spend["messages"] == 1
    await hub._handle({"type": "model_router_call", "rid": "c2", "op": "budget", "usd": "x"})
    assert emitted[-1][1]["ok"] is False
    await hub._handle({"type": "model_router_call", "rid": "c3", "op": "budget", "usd": 30})
    assert hub.prefs.feature("code_router_budget") == 30


# ── learned.json: reset, freeze, the learner ──


async def test_reset_and_freeze(hub, tmp_path):
    events = hub.code_router_events
    path = hub.feature_path("learned.json")
    path.write_text(json.dumps({"v": 1, "overrides": {"m": {"capabilities": {}}}, "report": []}))
    emitted = []
    hub.emit = lambda kind, **data: emitted.append((kind, data))
    await hub._handle({"type": "model_router_call", "rid": "f", "op": "freeze", "frozen": True})
    assert json.loads(path.read_text())["frozen"] is True and events.learned()["frozen"] is True
    await hub._handle({"type": "model_router_call", "rid": "l", "op": "learned"})
    reply = next(d for k, d in emitted if k == "model_router_reply" and d["rid"] == "l")
    assert reply["data"]["frozen"] is True and reply["data"]["changes"] == []
    ran = []

    async def learner(ev):
        ran.append(1)
        return ""

    events.learner = learner
    events._load_state()["learn"] = {"new": 999}
    events.maybe_learn()
    await asyncio.sleep(0.05)
    assert ran == []  # (frozen: nothing new is learned)
    await hub._handle({"type": "model_router_call", "rid": "r", "op": "reset"})
    assert not path.exists() and events.learned() == {}
    assert events._load_state()["since"].endswith("Z")
    events._load_state()["learn"] = {"new": code_router_events.LEARN_EVERY}
    events.maybe_learn()
    assert await until(lambda: ran == [1])
    assert await until(lambda: events._load_state()["learn"].get("new") == 0)


async def test_the_learner_runs_the_model_router_cli(hub, tmp_path, monkeypatch):
    """A stand-in model-router-learn (a Node script, as the repo's bin names it): what it's
    given and what comes of it."""
    if not code_router_events._node():
        pytest.skip("no node")
    home = tmp_path / "Model Router"
    (home / "dist").mkdir(parents=True)
    (home / "package.json").write_text(json.dumps({"bin": {"model-router-learn": "dist/learn.js"}}))
    (home / "dist" / "learn.js").write_text(
        "const fs = require('fs');\n"
        "const args = process.argv.slice(2);\n"
        "const out = args[args.indexOf('--out') + 1];\n"
        "const files = args.slice(0, args.indexOf('--out'));\n"
        "const n = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean)).length;\n"
        "fs.writeFileSync(out, JSON.stringify({ v: 1, updated: args[args.indexOf('--now') + 1],\n"
        "  overrides: { 'gpt-6.1-sol': { capabilities: { coding: 90 } } },\n"
        "  report: [{ model: 'gpt-6.1-sol', dim: 'coding', from: 84, to: 90, n, why: 'seen' }] }));\n"
    )
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(home))
    assert code_router_events.learner_script() == home / "dist" / "learn.js"
    events = hub.code_router_events
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    await routed_turn(hub, task)
    note = await events.run_learner()
    assert note == ""
    learned = events.learned()
    assert learned["overrides"] == {"gpt-6.1-sol": {"capabilities": {"coding": 90}}}
    assert learned["report"][0]["n"] == 2  # (the route record and its update)
    assert learned["frozen"] is False and events.state()["learner"]["installed"] is True
    # Not built: said, nothing changes.
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(tmp_path / "nowhere"))
    assert await events.run_learner() == "not installed"
    assert events.learned()["overrides"]


# ── per-project defaults ──


async def test_per_project_defaults_are_kept_clean(hub):
    hub.set_feature_prefs(
        {"code_router_projects": {"0123456789ab": {"efficiency": 90, "performance": 10}}}
    )
    assert hub.prefs.feature("code_router_projects") == {
        "0123456789ab": {"efficiency": 90, "performance": 10}
    }
    hub.set_feature_prefs({"code_router_projects": {"../etc": {"efficiency": 1}}})
    assert hub.prefs.feature("code_router_projects") == {}
    hub.set_feature_prefs({"code_router_budget": -5})
    assert hub.prefs.feature("code_router_budget") == 0.0  # (the old value stays)


# ── D10: the automatic fallback ──


async def test_a_routed_model_that_fails_hands_the_session_to_the_next_pick(hub, tmp_path):
    hub.set_feature_prefs({"code_router_on": True})
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    events = hub.code_router_events
    turn = await routed_turn(hub, task)
    assert task.model_ref == "sonnet"
    hub.tasks._claude_down(task, "rate_limit", "You've hit your limit")
    assert task.handover is True  # the turn's end is a handover, not a failure
    assert await until(lambda: task.model_ref == "opus" and len(calls) == 2)
    assert calls[-1][4].get("note") is True  # it carries on from where it stopped
    assert turn.signals["fellBack"] == {
        "from": "claude-sonnet-5-5", "to": "claude-opus-5-5", "why": "rate_limit",
    }  # fmt: skip
    # Once per routed message: the next failure goes to the hub's own fallback.
    seen = []
    task.falling_back = task.handover = False
    hub.code_router.routes[7]["ref"] = "opus"
    inner = hub.code_router.claude_down(lambda t, why, said="": seen.append(why) or False)
    assert inner(task, "rate_limit", "") is False and seen == ["rate_limit"]
    assert events.tracks[7].last is turn
    # The router's next pick is the model it fell back to: it stays there (the hub would
    # otherwise take it back to Sonnet once Claude is back).
    assert task.fell_back_from
    stay = {"ref": "opus", "model": "claude-opus-5-5"}
    await hub.handle({"type": "task_send", "id": 7, "text": "carry on", "route": stay})
    assert await until(lambda: len(calls) == 3)
    assert task.fell_back_from == {} and task.model_ref == "opus"


async def test_no_fallback_when_not_routed_off_or_for_a_sign_in_problem(hub, tmp_path):
    task = session(hub, tmp_path)
    sent_to_sessions(hub)
    await routed_turn(hub, task)
    seen = []
    down = hub.code_router.claude_down(lambda t, why, said="": seen.append(why) or False)
    assert down(task, "rate_limit", "") is False  # the router is off now
    hub.set_feature_prefs({"code_router_on": True})
    assert down(task, "authentication_failed", "") is False  # (sign-in: not the router's)
    hub.set_feature_prefs({"code_router_auto_fallback": False})
    assert down(task, "overloaded", "") is False
    hub.set_feature_prefs({"code_router_auto_fallback": True})
    hub.set_prefs({"fallback_code": False})
    assert down(task, "overloaded", "") is False
    assert seen == ["rate_limit", "authentication_failed", "overloaded", "overloaded"]
    assert task.model_ref == "sonnet"


# ── D11: other providers' models at the routed effort; latency ──


async def test_another_providers_model_takes_the_routed_effort(hub, tmp_path):
    await hub.start()
    provider = hub.providers.add_provider("openrouter", "", KEY)
    ref = hub.providers.add_model(provider["id"], "openai/gpt-6-luna")["ref"]
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    route = {"ref": ref, "effort": "low", "model": "gpt-6-luna"}
    await hub.handle({"type": "task_send", "id": 7, "text": "a", "route": route})
    assert await until(lambda: calls)
    assert task.model_ref == ref and task.effort == "low"
    await hub.handle({"type": "task_send", "id": 7, "text": "b", "route": {**route, "effort": "x"}})
    assert await until(lambda: len(calls) == 2)
    assert task.effort == "low"  # (not an effort a session takes: left as it was)


def test_a_message_waits_four_seconds_at_most():
    assert code_router.ROUTE_WAIT_SECONDS == 4.0


async def test_a_new_session_is_logged_once_it_exists(hub, tmp_path):
    await hub.start()
    (tmp_path / "proj").mkdir()
    route = {"ref": "haiku", "effort": "medium", "model": "claude-haiku-4-5", "info": INFO}
    await hub.handle(
        {"type": "task_new", "directory": "proj", "prompt": "hi there", "route": route}
    )
    assert await until(lambda: hub.tasks.tasks)
    task = list(hub.tasks.tasks.values())[-1]
    assert task.effort == "medium"
    (record,) = [r for r in await records(hub) if r.get("kind") is None]
    assert record["route"]["source"] == "chip" and record["route"]["new"] is True
    assert record["applied"]["model"] == "claude-haiku-4-5"
    assert hub.code_router.routes[task.id]["ref"] == "haiku"
    task.handle.cancel()


def test_the_event_log_lives_beside_prefs(hub):
    path = hub.feature_path(code_router_events.EVENTS_FILE)
    assert path.parent == Path(hub.prefs_store.path).parent and path.name.endswith(".jsonl")
    assert os.sep in str(path) and sys.platform  # (a real folder: the test's own)


async def test_a_whole_routed_turn_through_a_session(hub, tmp_path):
    """A new session on its routed model, its turn run by Claude Code (a stand-in), and
    what the log has once it's over: the route, then what the turn used."""
    await hub.start()
    (tmp_path / "proj").mkdir()
    route = {**ROUTE, "ref": "haiku", "effort": "medium", "model": "claude-haiku-4-5"}
    await hub.handle(
        {"type": "task_new", "directory": "proj", "prompt": SECRET_PROMPT, "route": route}
    )
    assert await until(lambda: hub.tasks.tasks)
    task = list(hub.tasks.tasks.values())[-1]
    events = hub.code_router_events
    assert await until(lambda: events.tracks.get(task.id) and events.tracks[task.id].last)
    turn = events.tracks[task.id].last
    assert await until(lambda: turn.signals.get("completed") is True)
    lines = await records(hub)
    assert [r.get("kind") for r in lines] == [None, "update"]
    assert lines[1]["actual"]["turns"] == 1 and lines[1]["actual"]["model"] == "claude-haiku-4-5"
    assert "zebra" not in json.dumps(lines)
    task.handle.cancel()
