"""Routines on the richer schedules: made by voice (with the card in the owner's language),
run by the routine clock, kept in routines.json beside the old kinds, and an older file
read exactly as before."""

import json
from datetime import datetime

import pytest

from jarvis.routines import Routine, RoutineStore, build_tools

TUE = datetime(2026, 9, 29, 10, 7)  # a Tuesday


def tools_for(store, answers=None, asked=None):
    answers = [True] * 5 if answers is None else answers

    async def confirm(question):
        if asked is not None:
            asked.append(question)
        return answers.pop(0)

    return {t.name: t.handler for t in build_tools(store, confirm)}


async def test_every_30_minutes_from_9_to_6_by_voice(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    asked = []
    tools = tools_for(store, asked=asked)
    out = await tools["create_routine"](
        {
            "name": "Build",
            "prompt": "Check the build",
            "schedule": "interval",
            "every_minutes": 30,
            "from_time": "09:00",
            "until_time": "18:00",
            "days": [0, 1, 2, 3, 4],
        }
    )
    assert not out.get("is_error"), out
    assert asked == ["Add a routine, every 30 minutes, 9 AM to 6 PM, weekdays: Check the build?"]
    [routine] = store.items
    assert routine.kind == "interval" and routine.time == "00:00" and routine.days == []
    assert routine.spec == {"every": 30, "start": "09:00", "end": "18:00", "days": [0, 1, 2, 3, 4]}
    assert out["content"][0]["text"] == "Added “Build”, every 30 minutes, 9 AM to 6 PM, weekdays."


async def test_the_card_asks_in_chinese_when_the_owner_speaks_it(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    store.language = lambda: "zh"
    asked = []
    tools = tools_for(store, asked=asked)
    await tools["create_routine"](
        {
            "name": "月报",
            "prompt": "整理本月的开支",
            "schedule": "monthly",
            "time": "17:00",
            "month_day": -1,
        }
    )
    await tools["create_routine"](
        {"name": "天气", "prompt": "告诉我天气", "schedule": "daily", "time": "07:00"}
    )
    assert asked == [
        "要添加例行任务吗？每月最后一天下午5点：整理本月的开支",
        "要添加例行任务吗？每天早上7点：告诉我天气",
    ]


async def test_monthly_and_cron_by_voice_and_bad_ones_refused(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    tools = tools_for(store)
    base = {"name": "Review", "prompt": "Review the month"}
    ok = await tools["create_routine"](
        {**base, "schedule": "monthly", "time": "09:00", "nth": 1, "weekday": 0}
    )
    assert ok["content"][0]["text"] == "Added “Review”, monthly on the first Monday at 9 AM."
    ok = await tools["create_routine"](
        {**base, "schedule": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"}
    )
    assert ok["content"][0]["text"] == "Added “Review”, weekdays at 9 AM (Asia/Shanghai)."
    for bad in (
        {"schedule": "interval", "every_minutes": 1},
        {"schedule": "interval"},
        {"schedule": "monthly", "time": "09:00", "month_day": 40},
        {"schedule": "monthly", "month_day": 3},  # no time of day
        {"schedule": "cron", "cron": "every day"},
        {"schedule": "cron", "cron": "0 9 * * *", "timezone": "Moon/Base"},
        {"schedule": "fortnightly", "time": "09:00"},
    ):
        out = await tools["create_routine"]({**base, **bad})
        assert out.get("is_error"), bad
    assert len(store.items) == 2


def test_the_clock_runs_each_new_kind_once_per_occurrence(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    store.items = [
        Routine(
            "i", "Inbox", "Check my inbox", "interval", "00:00",
            spec={"every": 15, "start": "09:00", "end": "17:00", "days": []},
        ),
        Routine("m", "Rent", "Remind me about rent", "monthly", "09:00", spec={"day": 29}),
        Routine("c", "Standup", "Prep standup", "cron", "00:00", spec={"cron": "0 10 * * 2", "tz": ""}),
    ]  # fmt: skip
    ran = [r.id for r in store.take_due(TUE)]
    assert sorted(ran) == ["c", "i", "m"]  # 10:00 inbox and standup, rent at 9 today
    assert store.take_due(TUE.replace(minute=10)) == []  # nothing new yet
    assert [r.id for r in store.take_due(TUE.replace(minute=15))] == ["i"]
    # Asleep from 10:20 till 12:40: the latest missed one runs once, not all nine.
    assert [r.id for r in store.take_due(TUE.replace(hour=12, minute=40))] == ["i"]
    again = RoutineStore(tmp_path / "routines.json")
    assert {r.id: r.last_run for r in again.items} == {
        "i": "2026-09-29T12:30",
        "m": "2026-09-29T09:00",
        "c": "2026-09-29T10:00",
    }


def test_a_new_routine_doesnt_run_for_a_time_that_already_passed(tmp_path, monkeypatch):
    store = RoutineStore(tmp_path / "routines.json")
    routine = store.add(
        "Inbox", "Check my inbox", "interval", "", spec={"every": 30, "start": "00:00"}
    )
    assert routine.last_run  # this half hour's occurrence counts as run
    assert store.take_due(datetime.now()) == []


def test_public_says_when_in_both_languages_and_when_next(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    routine = Routine(
        "m", "Rent", "Pay rent", "monthly", "09:00", spec={"nth": -1, "weekday": 4}, last_run=""
    )
    daily = Routine("d", "Brief", "Brief me", "daily", "07:00")
    paused = Routine("p", "Old", "Old one", "weekly", "16:00", [0, 4], enabled=False)
    store.items = [routine, daily, paused]
    items = {r["id"]: r for r in store.public()}
    assert items["m"]["when"] == "monthly on the last Friday at 9 AM"
    assert items["m"]["when_zh"] == "每月最后一个周五上午9点"
    assert items["m"]["next_run"] > datetime.now().isoformat(timespec="minutes")
    assert items["d"]["when_zh"] == "每天早上7点"
    assert items["p"]["when_zh"] == "每周一、周五下午4点" and items["p"]["next_run"] == ""
    assert Routine("o", "Once", "x", "once", "01:00", date="2026-10-01").describe("zh") == (
        "仅一次，2026-10-01 凌晨1点"
    )


def test_next_run_of_the_old_kinds():
    assert Routine("d", "B", "b", "daily", "07:00").next_run(TUE) == datetime(2026, 9, 30, 7, 0)
    weekdays = Routine("w", "B", "b", "weekdays", "09:00")
    assert weekdays.next_run(datetime(2026, 10, 2, 10, 0)) == datetime(2026, 10, 5, 9, 0)
    weekly = Routine("k", "B", "b", "weekly", "16:00", [4])
    assert weekly.next_run(TUE) == datetime(2026, 10, 2, 16, 0)
    once = Routine("o", "B", "b", "once", "01:00", date="2026-09-29")
    assert once.next_run(TUE) is None  # already past
    assert once.next_run(datetime(2026, 9, 28, 23, 0)) == datetime(2026, 9, 29, 1, 0)


# ── the file: older files, other builds, damage ──

OLD_FILE = [
    {
        "id": "g",
        "name": "Brief",
        "prompt": "Brief me",
        "kind": "daily",
        "time": "07:00",
        "days": [],
        "date": "",
        "enabled": True,
        "last_run": "2026-09-28T07:00",
    }
]


def test_an_older_file_loads_and_runs_as_before_and_gains_the_new_fields(tmp_path):
    path = tmp_path / "routines.json"
    path.write_text(json.dumps(OLD_FILE))
    store = RoutineStore(path)
    [routine] = store.items
    assert routine.spec == {} and routine.describe() == "every day at 7 AM"
    assert [r.id for r in store.take_due(datetime(2026, 9, 29, 7, 1))] == ["g"]
    saved = json.loads(path.read_text())[0]
    assert saved["spec"] == {} and saved["last_run"] == "2026-09-29T07:00"
    # What an older build reads of it (it keeps only the fields it knows): the same routine.
    old_fields = set(OLD_FILE[0])
    assert {k: v for k, v in saved.items() if k in old_fields} == {
        **OLD_FILE[0],
        "last_run": "2026-09-29T07:00",
    }


def test_a_new_kind_row_is_kept_whole_by_the_store(tmp_path):
    path = tmp_path / "routines.json"
    row = {
        **OLD_FILE[0],
        "id": "c",
        "kind": "cron",
        "time": "00:00",
        "spec": {"cron": "0 9 * * 1-5", "tz": "America/New_York"},
    }
    path.write_text(json.dumps([OLD_FILE[0], row]))
    store = RoutineStore(path)
    assert [r.id for r in store.items] == ["g", "c"]
    store.save()
    assert json.loads(path.read_text())[1]["spec"] == row["spec"]


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "interval", "spec": {"every": 1}},
        {"kind": "interval", "spec": "every 30"},
        {"kind": "interval", "spec": None},
        {"kind": "monthly", "spec": {"day": 99}},
        {"kind": "cron", "spec": {"cron": "never"}},
        {"kind": "cron", "spec": {"cron": "0 9 * * *", "tz": "Nowhere/Land"}},
    ],
)
def test_a_routine_with_a_schedule_that_cant_be_read_is_kept_aside(tmp_path, bad):
    path = tmp_path / "routines.json"
    row = {**OLD_FILE[0], "id": "b", **bad}
    path.write_text(json.dumps([OLD_FILE[0], row]))
    store = RoutineStore(path)
    store.public()
    assert [r.id for r in store.items] == ["g"]
    assert [r.id for r in store.take_due(datetime(2026, 9, 29, 7, 1))] == ["g"]
    assert row in json.loads(path.read_text())  # never lost


def test_an_old_kind_with_a_stray_spec_is_cleaned(tmp_path):
    path = tmp_path / "routines.json"
    path.write_text(json.dumps([{**OLD_FILE[0], "spec": {"junk": [1, 2]}}]))
    assert RoutineStore(path).items[0].spec == {}


# ── the hub: the feature asks in the owner's language, the window gets the routines ──


async def test_the_feature_wires_the_card_language_and_the_state(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    assert hub.routines.language() == "en"
    hub.prefs.language = "zh"
    assert hub.routines.language() == "zh"
    hub.routines.add("Rent", "Pay rent", "monthly", "09:00", spec={"day": 1})
    q = hub.subscribe()
    await hub._handle({"type": "automation_state"})
    event = q.get_nowait()
    assert event["type"] == "automation" and event["language"] == "zh"
    assert [r["when_zh"] for r in event["routines"]] == ["每月1日上午9点"]
