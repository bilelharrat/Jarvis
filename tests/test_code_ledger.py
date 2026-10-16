"""Eden Code's productivity ledger (features/code_ledger): each week's changes landed,
reverted, rewound and discarded, review minutes, cost per landed change and what was spent
on changes taken back, the Model Router's alternative by its own estimates, a week that
cost more than it saved (only with the owner's own rate and minutes), and the exports. No
model is called."""

import asyncio
import csv
import io
from datetime import date, datetime, timedelta

import pytest
from code_session_fakes import make_hub

from jarvis import tasks
from jarvis.features import code_ledger
from jarvis.features._router_log import iso
from jarvis.features.code_ledger import to_csv, to_markdown, week_of, weekly


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


MONDAY = datetime(2026, 10, 5, 10, 0).timestamp()  # a Monday, local time
DAY = 86400


def turn(key, at, cost=0.5, files=1, **over):
    rec = {
        "v": 1, "kind": "turn", "ts": iso(at), "turn": key, "session": "s", "project": "p",
        "engine": "2.1.294", "model": "claude-opus-5-5", "reads": 2, "edits": 1, "blind": 0,
        "creates": 0, "files": files, "tests": None, "interrupted": False, "error": False,
        "cost": cost, "seconds": 10,
    }  # fmt: skip
    rec.update(over)
    return rec


def outcome(key, at, what, **extra):
    return {"v": 1, "kind": "outcome", "ts": iso(at), "turn": key, "what": what, **extra}


def week_one():
    """Four changes and a turn that changed nothing: one landed, one reverted, one rewound
    with its files, one discarded with its copy; 30 review minutes."""
    at = MONDAY
    return [
        turn("a", at, cost=1.0),
        turn("b", at + 60, cost=2.0),
        outcome("b", at + 120, "reverted", how="undo"),
        turn("c", at + 180, cost=1.0),
        outcome("c", at + 240, "rewound", files=True),
        turn("d", at + 300, cost=1.0),
        outcome("d", at + 360, "discarded"),
        turn("e", at + 400, cost=0.5, files=0),
        {"v": 1, "kind": "review", "ts": iso(at + 500), "seconds": 1200, "pane": "diff"},
        {"v": 1, "kind": "review", "ts": iso(at + 900), "seconds": 600, "pane": "pr"},
    ]


def week_two():
    at = MONDAY + 7 * DAY
    return [turn(f"w2-{i}", at + i * 60, cost=0.25) for i in range(4)]


def router_records():
    at = MONDAY + DAY
    return [
        {"v": 1, "ts": iso(at), "msg": "m1", "settings": {"shadow": True},
         "pick": {"model": "claude-sonnet-5-5", "costUSD": 0.1},
         "best": {"model": "claude-opus-5-5", "costUSD": 0.9}},
        {"v": 1, "kind": "update", "ts": iso(at + 5), "msg": "m1", "actual": {"notionalUSD": 0.2}},
        {"v": 1, "kind": "update", "ts": iso(at + 9), "msg": "m1", "actual": {"notionalUSD": 0.6}},
        {"v": 1, "ts": iso(at + 60), "msg": "m2", "settings": {"shadow": False},
         "pick": {"model": "claude-sonnet-5-5", "costUSD": 0.05},
         "best": {"model": "claude-opus-5-5", "costUSD": 0.5}},
        {"v": 1, "kind": "update", "ts": iso(at + 70), "msg": "m2", "actual": {"costUSD": 0.04}},
        {"v": 1, "ts": iso(at + 90), "msg": "m3", "settings": {}},  # never ran: not counted
    ]  # fmt: skip


def test_a_week_of_changes_honestly_counted():
    now = MONDAY + 9 * DAY
    ledger = weekly(week_one() + week_two(), router_records(), now, weeks=4)
    newest, older = ledger["weeks"]
    assert newest["week"] == (week_of(MONDAY) + timedelta(days=7)).isoformat()
    assert older["week"] == date(2026, 10, 5).isoformat()
    assert (older["turns"], older["changes"], older["landed"]) == (5, 4, 1)
    assert (older["reverted"], older["rewound"], older["discarded"], older["undone"]) == (
        1,
        1,
        1,
        3,
    )
    assert older["review_minutes"] == 30.0
    assert older["cost_usd"] == 5.5 and older["cost_per_landed"] == 5.5
    assert older["wasted_usd"] == 4.0
    # The router: two messages that ran; its alternative by its own estimates (the pick in
    # Shadow mode, the best-quality option when it routed).
    assert older["routed"] == 2 and older["routed_usd"] == pytest.approx(0.64)
    assert older["alternative_usd"] == pytest.approx(0.6)
    # No rate given: never called a win; more taken back than kept says so.
    assert older["verdict"] == "mostly_undone" and older["value_usd"] is None
    assert newest["verdict"] == "unweighed" and newest["landed"] == 4
    assert ledger["totals"]["landed"] == 5 and ledger["totals"]["cost_usd"] == 6.5


def test_a_week_that_cost_more_than_it_saved():
    now = MONDAY + 9 * DAY
    ledger = weekly(week_one() + week_two(), [], now, weeks=4, rate=60.0, minutes=10.0)
    newest, older = ledger["weeks"]
    # One landed change saves 10 minutes ($10); it cost $5.50 and 30 review minutes ($30).
    assert older["value_usd"] == 10.0 and older["net_usd"] == pytest.approx(-25.5)
    assert older["verdict"] == "cost_more"
    # Four landed changes ($40) for $1 and no review: paid off.
    assert newest["net_usd"] == 39.0 and newest["verdict"] == "paid_off"


def test_old_weeks_are_left_out():
    now = MONDAY + 60 * DAY
    assert weekly(week_one(), [], now, weeks=4)["weeks"] == []


def test_the_exports():
    now = MONDAY + 9 * DAY
    ledger = weekly(week_one() + week_two(), router_records(), now, weeks=4, rate=60, minutes=10)
    rows = list(csv.reader(io.StringIO(to_csv(ledger))))
    assert rows[0][0] == "Week of" and rows[-1][0] == "Total" and len(rows) == 4
    assert "Cost more than it saved" in rows[2]
    page = to_markdown(ledger, date(2026, 10, 16))
    assert page.startswith("# Eden Code productivity ledger")
    assert (
        "| **Total** |" in page and "Cost more than it saved" in page and "$60.00 an hour" in page
    )


async def test_the_pane_and_the_export_through_the_hub(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks, "EXPORT_DIR", tmp_path / "exports")
    now = datetime.now().timestamp()
    radar = hub.code_radar
    for rec in [turn("x", now - 60, cost=0.3), turn("y", now - 30, cost=0.1)]:
        radar.log.append(rec)
    hub.set_feature_prefs({code_ledger.PREF_RATE: 80.0, code_ledger.PREF_MINUTES: 15})
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub._handle({"type": "cw_ledger"})
    assert await until(lambda: any(k == "cw_ledger" for k, _ in seen))
    got = next(d for k, d in seen if k == "cw_ledger")
    assert got["rate"] == 80.0 and got["minutes"] == 15.0 and got["on"] is True
    assert got["weeks"][0]["landed"] == 2 and got["weeks"][0]["verdict"] == "paid_off"
    assert got["verdicts"]["cost_more"] == "Cost more than it saved"
    await hub._handle({"type": "cw_ledger_export", "format": "md"})
    assert await until(lambda: any(k == "cw_ledger_export" for k, _ in seen))
    done = next(d for k, d in seen if k == "cw_ledger_export")
    assert done["ok"] and done["name"].endswith(".md")
    assert (tmp_path / "exports" / done["name"]).read_text().startswith("# Eden Code")


async def test_nothing_to_export_and_bad_numbers(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks, "EXPORT_DIR", tmp_path / "exports")
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub._handle({"type": "cw_ledger_export", "format": "csv"})
    assert await until(lambda: any(k == "cw_ledger_export" for k, _ in seen))
    assert "nothing to export" in next(d for k, d in seen if k == "cw_ledger_export")["error"]
    hub.set_feature_prefs({code_ledger.PREF_RATE: -5, code_ledger.PREF_MINUTES: 99999})
    assert hub.prefs.feature(code_ledger.PREF_RATE) == 0.0
    assert hub.prefs.feature(code_ledger.PREF_MINUTES) == code_ledger.MINUTES_MAX


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False
