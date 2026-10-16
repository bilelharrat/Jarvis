"""Eden Code's cost forecast and quota-aware plan (codeforecast, features.code_forecast): what
a message is likely to cost and take of Claude's windows, from similar earlier turns in the
project (kept as numbers and salted word hashes, never words); the plan for the to-do cards
(run now, wait for a reset, a cheaper model, another provider, overnight) that the routing
queue follows; the routing queue out of Labs; and the first-run card's daily cap
(features.code_usage). Statistics only, and fakes only: no model is ever asked."""

import json
import os
import time
from datetime import datetime

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import codeforecast
from jarvis.codeforecast import History, Room, kind_of, price_ratio, quantile, schedule, tokens
from jarvis.features import _labs, code_queue
from jarvis.features.code_router_events import project_hash
from jarvis.features.code_usage import suggested_cap

P = "a1b2c3d4e5f6"  # a project's hash


def _history(tmp_path=None, clock=None):
    return History(tmp_path / "code_forecast.json" if tmp_path else None, clock=clock or time.time)


def _seed(h, project=P, model="claude-sonnet-5-5", n=6, text="fix the flaky login test", cost=0.4):
    for i in range(n):
        h.add(f"{project}:{model}:{text}:{i}", project, model, text, 2, cost + i * 0.02, 1000, 60)


# ── the statistics ──


def test_words_and_kinds_are_read_as_the_forecast_compares_them():
    assert tokens("Fix the flaky test in auth/login.py, please") == [
        "fix",
        "flaky",
        "test",
        "auth/login.py",
    ]
    assert tokens("修复登录") == ["修复", "复登", "登录"]
    assert kind_of("Fix the crash on save") == "fix"
    assert kind_of("add a dark mode toggle") == "build"
    assert kind_of("why does this loop twice?") == "explain"
    assert kind_of("write unit tests for the parser") == "test"
    assert kind_of("hello") == "other"
    assert quantile([(1, 1), (2, 1), (3, 1), (10, 1)], 0.5) == 2
    assert quantile([(1, 1), (10, 9)], 0.5) == 10  # (weighted)
    assert quantile([], 0.5) == 0.0


def test_prices_compare_by_claude_s_tiers_or_the_router_s_price_list():
    assert price_ratio("claude-opus-5-5", "claude-sonnet-5-5") == pytest.approx(5 / 3)
    assert price_ratio("claude-haiku-4-5", "claude-opus-5-5") == pytest.approx(1 / 5)
    assert price_ratio("gpt-6.1", "claude-sonnet-5-5") is None  # (no price for it)
    prices = {"gpt-6.1": {"in": 2.0, "out": 8.0}, "claude-sonnet-5-5": {"in": 3.0, "out": 15.0}}
    assert price_ratio("gpt-6.1", "claude-sonnet-5-5", prices) == pytest.approx(2.9 / 4.8)
    assert price_ratio("x", "x") == 1.0


def test_no_prompt_text_is_ever_written_and_the_salt_stays(tmp_path):
    h = _history(tmp_path)
    assert h.add("s1:4", P, "claude-sonnet-5-5", "rotate the secret webhook token", 0, 0.3)
    assert not h.add("s1:4", P, "claude-sonnet-5-5", "rotate the secret webhook token", 0, 0.3)
    assert not h.add(
        "s1:5", P, "claude-sonnet-5-5", "   ", 0, 0.3
    )  # (no prompt: nothing to be like)
    h.flush()
    h._write(h._data())
    raw = (tmp_path / "code_forecast.json").read_text()
    for word in ("rotate", "secret", "webhook", "token"):
        assert word not in raw
    assert oct(os.stat(tmp_path / "code_forecast.json").st_mode & 0o777) == "0o600"
    again = _history(tmp_path)
    assert again.salt == h.salt and len(again.turns) == 1
    assert again.turns[0].words == h.words("rotate the secret webhook token")
    assert not again.add("s1:4", P, "claude-sonnet-5-5", "rotate the secret webhook token", 0, 0.3)


def test_a_damaged_file_is_set_aside_and_never_stops_a_forecast(tmp_path):
    (tmp_path / "code_forecast.json").write_text("{not json")
    h = _history(tmp_path)
    assert h.forecast(P, "anything", "claude-sonnet-5-5") == {"n": 0, "model": "claude-sonnet-5-5"}
    (tmp_path / "code_forecast.json").write_text(
        json.dumps({"version": 1, "turns": [{"at": "x"}, 5]})
    )
    assert _history(tmp_path).turns == []


def test_a_forecast_comes_from_similar_turns_in_the_project():
    h = _history()
    _seed(h, text="fix the flaky login test", cost=0.4)
    _seed(h, text="write the release notes for the docs site", cost=3.0)
    f = h.forecast(P, "fix the flaky signup test", "claude-sonnet-5-5", depth=2)
    assert f["n"] >= 6 and f["scope"] == "project"
    assert 0.4 <= f["low"] <= f["mid"] <= f["high"] < 1.0  # (like the login fixes, not the docs)
    assert f["confidence"] in ("good", "fair")
    assert f["windows"] == {}  # (no window rate learned yet: the cost only)
    # The same work asked of Opus: priced up by the tiers.
    opus = h.forecast(P, "fix the flaky signup test", "claude-opus-5-5", depth=2)
    assert opus["mid"] == pytest.approx(f["mid"] * 5 / 3, rel=0.01)
    # A project with too few turns of its own: every project's, said so.
    other = h.forecast("ffffffffffff", "fix the flaky signup test", "claude-sonnet-5-5")
    assert other["scope"] == "all" and other["n"]
    # A model that can't be compared with any turn kept: nothing to go by.
    assert h.forecast(P, "fix it", "gpt-6.1")["n"] == 0


def test_nothing_alike_gives_the_project_s_recent_turns_said_to_be_rough():
    h = _history()
    _seed(h, n=4, text="alpha beta gamma delta", cost=1.0)
    for t in h.turns:
        t.depth, t.chars, t.kind = 300, 9000, "docs"  # (nothing like the question)
    f = h.forecast(P, "zzz", "claude-sonnet-5-5")
    assert f["scope"] == "recent" and f["confidence"] == "rough" and f["mid"] >= 1.0


def test_a_window_s_rate_is_learned_from_its_readings_against_eden_s_spending():
    clock = [1000.0]
    h = _history(clock=lambda: clock[0])
    resets = 99_000.0
    h.hear("five_hour", 0.10, resets)
    assert h.rate("five_hour") is None
    for used in (0.14, 0.18, 0.22):  # each $1 of Eden Code's spending: 4% of the window
        h.count(1.0)
        clock[0] += 600
        h.hear("five_hour", used, resets)
    assert h.rate("five_hour") == pytest.approx(0.04, rel=0.01)
    h.hear("five_hour", 0.22, resets)  # (the same reading again: nothing new)
    h.count(1.0)
    h.hear("five_hour", 0.01, 120_000.0)  # (a new window: never paired with the old one)
    assert h.rate("five_hour") == pytest.approx(0.04, rel=0.01)
    _seed(h, cost=0.5)
    f = h.forecast(P, "fix the flaky login test", "claude-sonnet-5-5", depth=2)
    assert f["windows"]["five_hour"]["mid"] == pytest.approx(f["mid"] * 0.04, rel=0.01)
    assert "seven_day" not in f["windows"]
    assert h.forecast(P, "fix the flaky login test", "gpt-6.1")["n"] == 0


# ── the plan ──


def _f(mid, five=None, week=None):
    out = {"n": 8, "low": mid * 0.7, "mid": mid, "high": mid * 1.4, "windows": {}}
    if five is not None:
        out["windows"]["five_hour"] = {"low": five * 0.7, "mid": five, "high": five * 1.4}
    if week is not None:
        out["windows"]["seven_day"] = {"low": week * 0.7, "mid": week, "high": week * 1.4}
    return out


def _item(cid, f, ref="sonnet", fixed=False, cheaper=(), other=None):
    return {"id": cid, "ref": ref, "claude": True, "fixed": fixed, "forecast": f,
            "cheaper": list(cheaper), "other": other}  # fmt: skip


NOON = datetime(2026, 10, 16, 12, 0).timestamp()
NIGHT = datetime(2026, 10, 16, 2, 0).timestamp()


def test_cards_that_fit_run_now_and_take_their_share_from_the_ones_after():
    room = Room(five=0.5, five_resets=NOON + 3600)
    plan = schedule([_item(c, _f(0.5, 0.1)) for c in "abcde"], room, NOON)
    # 14% each at the high end, 10% taken each: a to d fit (d: 80% + 14%); e would pass 95%.
    assert [plan[c]["action"] for c in "abcde"] == ["now", "now", "now", "now", "wait"]
    assert plan["e"]["reason"] == "five" and plan["e"]["until"] == NOON + 3600
    assert plan["a"]["reason"] == "fits"
    # Nothing to go by: in its turn.
    assert schedule([_item("x", {"n": 0})], Room(five=0.5), NOON)["x"]["reason"] == "no_data"


def test_a_card_that_doesn_t_fit_goes_cheaper_or_to_another_provider_else_waits():
    room = Room(five=0.9, five_resets=NOON + 3600)
    haiku = ("haiku", True, _f(0.1, 0.02))
    gemini = ("custom:gem", _f(0.1))
    plan = schedule([_item("a", _f(0.6, 0.1), cheaper=[haiku])], room, NOON)
    assert plan["a"]["action"] == "cheaper" and plan["a"]["ref"] == "haiku"
    assert room.five == pytest.approx(0.92)  # (Haiku's share taken)
    room = Room(five=0.9, five_resets=NOON + 3600)
    plan = schedule([_item("a", _f(0.6, 0.1), other=gemini)], room, NOON)
    assert plan["a"]["action"] == "other" and plan["a"]["ref"] == "custom:gem"
    room = Room(five=0.9, five_resets=NOON + 3600)
    plan = schedule(
        [_item("a", _f(0.6, 0.1), fixed=True, cheaper=[haiku], other=gemini)], room, NOON
    )
    assert plan["a"]["action"] == "wait"  # (the owner's own pick: never changed)


def test_a_used_up_window_holds_every_claude_card_forecast_or_not():
    room = Room(five=1.0, five_resets=NOON + 600, week=0.3)
    plan = schedule(
        [
            _item("a", {"n": 0}),
            _item("b", _f(0.1, 0.01), cheaper=[("haiku", True, _f(0.01, 0.001))]),
        ],
        room,
        NOON,
    )
    assert plan["a"]["action"] == plan["b"]["action"] == "wait"
    assert plan["a"]["until"] == NOON + 600
    week = Room(five=0.2, week=0.99, week_resets=NOON + 86400 * 3)
    plan = schedule([_item("a", _f(0.2, 0.01, 0.001))], week, NOON)
    assert plan["a"]["action"] == "wait" and plan["a"]["reason"] == "week"


def test_a_big_card_waits_for_the_night_by_day_and_runs_at_night():
    big = _f(4.0, 0.3)
    plan = schedule([_item("a", big), _item("b", _f(0.2, 0.02))], Room(five=0.1), NOON)
    assert plan["a"]["action"] == "overnight" and plan["b"]["action"] == "now"
    assert datetime.fromtimestamp(plan["a"]["until"]).hour == codeforecast.NIGHT_FROM
    assert plan["a"]["until"] > NOON
    assert schedule([_item("a", big)], Room(five=0.1), NIGHT)["a"]["action"] == "now"
    assert (
        schedule([_item("a", big)], Room(five=0.1), NOON, overnight=False)["a"]["action"] == "now"
    )
    # With no window rate known, a big one is by its dollars.
    assert schedule([_item("a", _f(6.0))], Room(), NOON)["a"]["action"] == "overnight"


def test_money_a_day_s_cap_waits_for_tomorrow_the_queue_s_ceiling_runs_and_stops_there():
    tomorrow = NOON + 12 * 3600
    plan = schedule(
        [_item("a", _f(2.0))], Room(money=1.0, money_why="day", money_back=tomorrow), NOON
    )
    assert plan["a"]["action"] == "wait" and plan["a"]["until"] == tomorrow
    plan = schedule([_item("a", _f(2.0), cheaper=[("haiku", True, _f(0.4))])],
                    Room(money=1.0, money_why="day", money_back=tomorrow), NOON)  # fmt: skip
    assert plan["a"]["action"] == "cheaper"
    plan = schedule([_item("a", _f(2.0))], Room(money=1.0, money_why="ceiling"), NOON)
    assert plan["a"]["action"] == "now" and plan["a"]["reason"] == "tight"


# ── in a hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    return make_hub(settings, quiet_speaker, isolated)


async def test_a_session_s_turns_are_kept_and_a_forecast_is_asked_for_from_the_window(
    hub, tmp_path
):
    seen = events_of(hub)
    task = hub.tasks.start("fix the flaky login test", "proj")
    assert await until(lambda: task.status == "waiting" and task.cost_usd)
    for _ in range(3):
        hub.tasks.send(task.id, "fix the flaky login test again")
        before = task.cost_usd
        assert await until(lambda b=before: task.cost_usd > b and not task.busy)
    history = hub.code_forecast.history
    assert len(history.turns) == 4 and history.spent == pytest.approx(0.4)
    assert [t.depth for t in history.turns] == [0, 1, 2, 3]
    assert {t.project for t in history.turns} == {project_hash(str(tmp_path / "proj"))}
    await hub._handle(
        {"type": "cf_forecast", "rid": "r1", "id": task.id, "text": "fix the flaky login test"}
    )
    (answer,) = [e for e in seen() if e["type"] == "cf_forecast"]
    assert answer["rid"] == "r1" and answer["n"] == 4
    assert answer["low"] == pytest.approx(0.1) and answer["high"] == pytest.approx(0.1)
    assert answer["label"] and "now" in answer
    # A new session's folder; an empty box; the forecast off in Settings.
    await hub._handle(
        {"type": "cf_forecast", "rid": "r2", "directory": "proj", "text": "fix the login test"}
    )
    await hub._handle({"type": "cf_forecast", "rid": "r3", "directory": "proj", "text": "  "})
    hub.set_feature_prefs({"code_forecast_show": False})
    await hub._handle({"type": "cf_forecast", "rid": "r4", "id": task.id, "text": "fix it"})
    answers = {e["rid"]: e for e in seen() if e["type"] == "cf_forecast"}
    assert answers["r2"]["n"] == 4 and answers["r3"]["n"] == 0 and answers["r4"]["off"] is True
    await end_all(hub)


async def test_sessions_open_before_are_read_back_once(hub, tmp_path):
    task = hub.tasks.start("add a dark mode toggle", "proj")
    assert await until(lambda: task.status == "waiting" and task.cost_usd)
    hub.code_forecast._history = None  # (as at the first forecast after a restart)
    history = hub.code_forecast.history
    assert len(history.turns) == 1 and history.turns[0].kind == "build"
    hub.code_forecast.read_back()
    assert len(history.turns) == 1  # (the same turn isn't kept twice)
    await end_all(hub)


async def test_the_board_carries_each_waiting_card_s_plan(hub, tmp_path):
    seen = events_of(hub)
    await hub._handle({"type": "todo_add", "directory": "proj", "prompt": "fix the flaky test"})
    (card,) = hub.code_todo.board.cards
    state = [e for e in seen() if e["type"] == "todo_state"][-1]
    plan = state["plans"][card["id"]]
    assert plan["action"] == "now" and plan["reason"] == "no_data"
    assert plan["why"] == "Runs in its turn: there's no similar work here yet to forecast from."
    # Claude's 5-hour limit used up: the card waits for its reset, and says until when.
    hub.usage.limits = {"five_hour": {"utilization": 1.0, "status": "rejected",
                                      "resets_at": time.time() + 3600, "seen": time.time()}}  # fmt: skip
    plan = hub.code_forecast.plan(card["folder"])[card["id"]]
    assert plan["action"] == "wait" and plan["reason"] == "five"
    assert (
        plan["why"].startswith("Waits for Claude's 5-hour limit to reset (")
        and "used up" in plan["why"]
    )


async def test_the_queue_follows_the_plan_a_waiting_card_keeps_its_place(
    hub, monkeypatch, tmp_path
):
    from test_code_queue import add, stub_sessions

    started, _sent, finish = stub_sessions(hub, monkeypatch, tmp_path)
    first, second = await add(hub, "a big refactor", "a small fix")
    plans = {
        first["id"]: {"action": "wait", "until": time.time() + 3600, "why": "Waits for the reset."},
        second["id"]: {"action": "cheaper", "ref": "haiku", "why": "Goes to Haiku."},
    }
    monkeypatch.setattr(hub.code_forecast, "plan", lambda folder: dict(plans))
    await hub._handle({"type": "todo_queue_run", "directory": "proj"})
    assert await until(lambda: started)
    assert started == [(second["id"], "haiku")]  # (the second, on the plan's cheaper model)
    assert first["state"] == "queued"
    assert second["attempts"][0]["why"] == "cheaper"
    finish(second, files=())
    assert await until(lambda: second["state"] == "done")
    run = hub.code_queue.runs[first["folder"]]
    assert run.on and run.note == "Waits for the reset."  # (the first waits, in its place)
    plans[first["id"]] = {"action": "now", "why": "Runs now."}  # (the reset came)
    hub.code_queue.pump(first["folder"])
    assert await until(lambda: len(started) == 2)
    assert started[1] == (first["id"], "")


async def test_without_a_plan_the_queue_goes_in_order(hub, monkeypatch, tmp_path):
    from test_code_queue import add, stub_sessions

    started, _sent, _finish = stub_sessions(hub, monkeypatch, tmp_path)
    monkeypatch.setattr(
        hub.code_forecast, "plan", lambda folder: (_ for _ in ()).throw(RuntimeError)
    )
    first, _second = await add(hub, "one", "two")
    await hub._handle({"type": "todo_queue_run", "directory": "proj"})
    assert await until(lambda: started)
    assert started[0][0] == first["id"]


def test_the_routing_queue_is_out_of_labs(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    assert "code_queue" not in _labs.LABS
    assert "code_queue" not in _labs.skipped(None)
    assert _labs._clean(["code_queue", "code_acp"]) == ["code_acp"]  # (an old choice: dropped)
    labs_js = (
        __import__("pathlib").Path(code_queue.__file__).parent.parent / "web/features/labs.js"
    ).read_text()
    assert "'code_queue'" not in labs_js


# ── the first-run card's daily cap ──


def test_the_proposed_daily_cap_is_half_again_the_busiest_day_at_a_round_amount():
    assert suggested_cap([]) == 20.0
    assert suggested_cap([{"total": 0.0}] * 14) == 20.0
    assert suggested_cap([{"total": 3.0}, {"total": 12.0}]) == 20.0  # (18 → 20)
    assert suggested_cap([{"total": 31.0}]) == 50.0  # (46.5 → 50)
    assert suggested_cap([{"total": 2.0}]) == 5.0
    assert suggested_cap([{"total": 5000.0}]) == 1000.0


async def test_the_meter_proposes_a_daily_cap_until_it_s_answered(hub):
    assert hub.code_usage.public()["offer"] == {"show": True, "cap": 20.0, "spent": False}
    hub.set_feature_prefs({"code_budget_offer": "maybe"})  # (not an answer: refused)
    assert hub.code_usage.public()["offer"]["show"] is True
    hub.set_feature_prefs({"code_budget_offer": "no"})
    assert hub.code_usage.public()["offer"]["show"] is False
    hub.set_feature_prefs({"code_budget_offer": ""})
    hub.set_feature_prefs({"code_budget_day": 15})
    assert hub.code_usage.public()["offer"]["show"] is False  # (a daily cap is set)
