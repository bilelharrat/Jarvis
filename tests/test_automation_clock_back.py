"""Routines, the heads-up watcher and the trigger engine when the wall clock moves back (a
wrong clock put right, flying west) and once routines are deleted: what still holds a run
back, what is looked at again, and what is let go (and what never is: the debounces and
caps of routines in a file that can't be read). Temp folders and fakes only."""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

from jarvis import jsonstore, routines
from jarvis.features.automation import Automation
from jarvis.proactive import ETA_EVERY, Watcher
from jarvis.routines import RoutineStore
from jarvis.triggers import TriggerEngine

# ── routines ──


def test_an_interval_routine_runs_at_its_next_slot_after_flying_west(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    tidy = store.add("Tidy", "tidy up", "interval", "", spec={"every": 30})
    tidy.last_run = "2026-10-06T12:00"  # the noon slot, in New York
    ran = store.take_due(datetime(2026, 10, 6, 9, 5))  # 3 hours back, in San Francisco
    assert [r.name for r in ran] == ["Tidy"]
    assert tidy.last_run == "2026-10-06T09:00"
    assert store.take_due(datetime(2026, 10, 6, 9, 20)) == []  # and then every half hour
    assert [r.name for r in store.take_due(datetime(2026, 10, 6, 9, 31))] == ["Tidy"]


def test_a_daily_routine_never_runs_twice_on_one_date_when_the_clock_moves_back(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    brief = store.add("Brief", "brief me", "daily", "07:00")
    brief.last_run = ""
    assert [r.name for r in store.take_due(datetime(2026, 10, 6, 7, 1))] == ["Brief"]
    # Five hours back (Hawaii from New York): 7:00 comes round again on the same date.
    for minute in range(0, 6 * 60, 15):
        assert store.take_due(datetime(2026, 10, 6, 3, 0) + timedelta(minutes=minute)) == []
    assert [r.name for r in store.take_due(datetime(2026, 10, 7, 7, 1))] == ["Brief"]


def test_a_last_run_a_little_ahead_still_counts_as_run(tmp_path):
    """Within the trigger engine's slack (an hour back, as daylight saving time ends) a run
    still holds its slot back: only one further ahead than any clock skew is ignored."""
    store = RoutineStore(tmp_path / "routines.json")
    tidy = store.add("Tidy", "tidy up", "interval", "", spec={"every": 30})
    tidy.last_run = "2026-11-01T01:30"
    assert store.take_due(datetime(2026, 11, 1, 1, 5)) == []


# ── the heads-up watcher ──


def none() -> None:
    return None


def _meeting(begin: datetime, location: str = "") -> dict:
    return {
        "id": "e1",
        "title": "Board review",
        "begin": begin,
        "end": begin + timedelta(hours=1),
        "location": location,
        "all_day": False,
    }


async def test_the_calendar_is_read_within_five_real_minutes_whatever_the_wall_clock_does(
    monkeypatch,
):
    """The wall clock moved back by less than the time since the last read: it never goes
    behind that read, but five minutes still pass on the monotonic clock."""
    real = time.monotonic
    elapsed = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: real() + elapsed[0])
    reads = []

    async def events():
        reads.append(1)
        return []

    async def no_eta(_place):
        return None

    w = Watcher(lambda _a: None, events=events, eta=no_eta, battery=none, weather=none)
    start = datetime(2026, 10, 6, 12, 0)
    await w.tick(start)
    elapsed[0] += 240
    await w.tick(start + timedelta(minutes=2))  # four minutes on, the clock put two back
    assert len(reads) == 1
    elapsed[0] += 60
    await w.tick(start + timedelta(minutes=3))  # five real minutes since the read
    assert len(reads) == 2


async def test_a_travel_time_is_looked_up_again_after_the_clock_moves_back(monkeypatch):
    real = time.monotonic
    elapsed = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: real() + elapsed[0])
    asked = []

    async def events():
        return [_meeting(datetime(2026, 10, 6, 13, 0), "1 Market St")]

    async def eta(where):
        asked.append(where)
        return 20

    w = Watcher(lambda _a: None, events=events, eta=eta, battery=none, weather=none)
    await w.tick(datetime(2026, 10, 6, 12, 0))  # the clock an hour fast…
    assert len(asked) == 1
    elapsed[0] += 60
    await w.tick(datetime(2026, 10, 6, 11, 1))  # …and put right a minute later
    assert len(asked) == 2  # the lookup "at noon" is the wrong clock's: looked up again
    assert all(at <= datetime(2026, 10, 6, 11, 1) for at, _mono, _m in w._etas.values())
    elapsed[0] += ETA_EVERY / 2
    await w.tick(datetime(2026, 10, 6, 11, 6))
    assert len(asked) == 2  # and then reused for its ten minutes, as before


# ── the trigger engine ──


def _event_routine(rid: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=rid, kind="event", enabled=True, spec={"trigger": {"type": "wake"}, "debounce": 60}
    )


async def test_the_engine_keeps_what_it_knows_while_the_routines_cant_be_read(tmp_path):
    items = [_event_routine("a"), _event_routine("b")]
    readable = [True]
    engine = TriggerEngine(
        lambda: items if readable[0] else [],
        lambda _r, _c: None,
        tmp_path / "t.json",
        known=lambda: {r.id for r in items} if readable[0] else None,
    )
    now = datetime(2026, 10, 6, 9, 0)
    for routine in items:
        assert engine._allowed(routine, now)
    readable[0] = False  # routines.json can't be read: no routine is known to be gone
    await engine.tick(now + timedelta(minutes=1))
    assert set(engine.state["last"]) == set(engine.state["counts"]) == {"a", "b"}
    readable[0] = True
    assert not engine._allowed(items[0], now + timedelta(minutes=2))  # still debounced
    items.pop()  # "b" deleted; "a" stays, paused
    items[0].enabled = False
    await engine.tick(now + timedelta(minutes=3))
    assert set(engine.state["last"]) == set(engine.state["counts"]) == {"a"}


def _store(folder, monkeypatch=None) -> RoutineStore:
    """A routines file with one routine this build runs and one only a newer build can
    (kept in the file as it was); with monkeypatch, read again as a file that can't be."""
    folder.mkdir(exist_ok=True)
    path = folder / "routines.json"
    RoutineStore(path).add("Brief", "brief me", "daily", "07:00")
    raw = json.loads(path.read_text())
    raw.append({"id": "later", "name": "From a newer build", "kind": "lunar", "time": "07:00"})
    path.write_text(json.dumps(raw))
    if monkeypatch is not None:

        def unreadable(*_a, **_k):
            raise jsonstore.Unreadable(13, "Permission denied")

        monkeypatch.setattr(routines.jsonstore, "load_json", unreadable)
    return RoutineStore(path)


def test_routines_another_build_made_are_known_and_an_unreadable_file_knows_none(
    tmp_path, monkeypatch
):
    store = _store(tmp_path / "ok")
    assert [r.name for r in store.items] == ["Brief"] and len(store.broken) == 1
    feature = SimpleNamespace(hub=SimpleNamespace(routines=store))
    assert Automation._routine_ids(feature) == {store.items[0].id, "later"}
    feature.hub.routines = _store(tmp_path / "damaged", monkeypatch)
    assert feature.hub.routines.unreadable
    assert Automation._routine_ids(feature) is None


def test_the_run_history_is_kept_while_the_routines_cant_be_read():
    forgot = []
    feature = SimpleNamespace(
        _routine_ids=lambda: None,
        history=SimpleNamespace(forget=forgot.append),
        hub=SimpleNamespace(emit=lambda *_a, **_k: None),
        state=dict,
    )
    Automation.send_state(feature)
    assert forgot == []
    feature._routine_ids = lambda: {"a"}
    Automation.send_state(feature)
    assert forgot == [{"a"}]
