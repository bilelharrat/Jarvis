from datetime import datetime

import pytest

from jarvis.routines import Routine, RoutineStore, build_tools

MON_7 = datetime(2026, 9, 28, 7, 0)  # a Monday


def r(kind, time="07:00", days=None, date="", **kw):
    return Routine("x", "Brief", "Brief me", kind, time, days or [], date, **kw)


def test_schedules():
    assert r("daily").due(MON_7) == MON_7
    assert r("daily").due(MON_7.replace(hour=6, minute=59)) is None
    assert r("daily").due(MON_7.replace(hour=11)) is None  # more than 3 hours late: skip
    sat = datetime(2026, 10, 3, 7, 30)
    assert r("weekdays").due(sat) is None
    assert r("weekly", days=[5]).due(sat) == sat.replace(minute=0)
    assert r("once", date="2026-09-28").due(MON_7.replace(minute=20)) == MON_7
    assert r("daily", enabled=False).due(MON_7) is None
    assert r("weekly", days=[0, 4], time="16:00").describe() == "Mondays, Fridays at 4 PM"


def test_each_occurrence_runs_once_and_once_switches_off(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    store.items = [
        r("daily"),
        Routine("y", "Research", "Research X", "once", "07:00", [], "2026-09-28"),
    ]
    assert [x.name for x in store.take_due(MON_7)] == ["Brief", "Research"]
    assert store.take_due(MON_7.replace(minute=5)) == []
    again = RoutineStore(tmp_path / "routines.json")
    assert again.items[1].enabled is False
    assert [x.name for x in again.take_due(datetime(2026, 9, 29, 7, 1))] == ["Brief"]


def test_bad_schedules_are_refused(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    for kwargs in (
        {"kind": "hourly", "time": "07:00"},
        {"kind": "daily", "time": "7am"},
        {"kind": "weekly", "time": "07:00"},
        {"kind": "once", "time": "07:00", "date": "tomorrow"},
    ):
        with pytest.raises(ValueError):
            store.add("n", "p", **kwargs)


async def test_create_asks_first(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    answers = [False, True]
    asked = []

    async def confirm(question):
        asked.append(question)
        return answers.pop(0)

    tools = {t.name: t.handler for t in build_tools(store, confirm)}
    args = {
        "name": "Portfolio",
        "prompt": "How's the portfolio?",
        "schedule": "weekly",
        "time": "16:00",
        "days": [4],
    }
    assert (await tools["create_routine"](args))["is_error"]
    assert store.items == []
    out = await tools["create_routine"](args)
    assert out["content"][0]["text"] == "Added “Portfolio”, Fridays at 4 PM."
    assert asked[0] == "Add a routine, Fridays at 4 PM: How's the portfolio?"
    listed = await tools["list_routines"]({})
    assert "Portfolio: Fridays at 4 PM" in listed["content"][0]["text"]
    await tools["pause_routine"]({"routine": "portfolio", "enabled": False})
    assert store.items[0].enabled is False
    await tools["delete_routine"]({"routine": "Portfolio"})
    assert store.items == []


async def test_hub_runs_a_due_routine(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.run_routine(r("daily"))
    assert hub.client.queries[-1] == "Brief me"
    assert hub.history[0]["text"] == "Routine · Brief"
