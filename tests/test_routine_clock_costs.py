"""The routine clock looks every half minute whether a routine is due; a cron schedule that
comes round once a year (or on 29 February) was looked for up to 400 days back each time.
Only the clock's grace matters there, so it looks no further back than that, with the same
answers (schedules.latest's since)."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from jarvis import routines, schedules
from jarvis.routines import GRACE, Routine

CRONS = [
    "*/15 9-17 * * 1-5",
    "0 9 1 1 *",
    "0 9 29 2 *",
    "30 2 * * *",  # inside the hour a clock change skips or repeats
    "0 0 * * 0",
    "59 23 31 12 *",
    "0 */2 * * *",
    "15 1 8-14 * 2",
]
ZONES = ["", "America/New_York", "Europe/London", "Pacific/Auckland"]
LOCAL = ZoneInfo("America/Los_Angeles")
# Around the clock changes of 2026 (the US, Europe, New Zealand) and a new year.
AROUND = [
    datetime(2026, 3, 7),
    datetime(2026, 3, 28),
    datetime(2026, 4, 4),
    datetime(2026, 10, 24),
    datetime(2026, 10, 31),
    datetime(2026, 12, 31),
]


def in_grace(when, now):
    return when if when is not None and now - when <= GRACE else None


def test_the_clock_gets_the_same_answers_looking_back_only_its_grace():
    for expression in CRONS:
        for zone in ZONES:
            spec = schedules.clean_cron({"cron": expression, "tz": zone})
            for start in AROUND:
                for step in range(0, 48 * 60, 97):
                    now = start + timedelta(minutes=step, seconds=13)
                    full = schedules.latest("cron", spec, "", now, LOCAL)
                    bounded = schedules.latest("cron", spec, "", now, LOCAL, since=now - GRACE)
                    assert in_grace(bounded, now) == in_grace(full, now), (expression, zone, now)


def test_a_yearly_schedule_is_no_longer_looked_for_a_year_back(monkeypatch):
    looked = []
    real = schedules.Cron.day_matches

    def counting(self, day):
        looked.append(day)
        return real(self, day)

    monkeypatch.setattr(schedules.Cron, "day_matches", counting)
    routine = Routine("r1", "New year", "x", "cron", "", spec={"cron": "0 9 1 1 *", "tz": ""})
    now = datetime(2026, 10, 5, 10, 0)
    assert routine.due(now) is None
    assert len(looked) <= 3  # 278 days before
    looked.clear()
    assert routine.latest(now) == datetime(2026, 1, 1, 9, 0)  # the whole answer, unasked
    assert len(looked) > 200


def test_a_cron_routine_is_still_due_in_its_grace_and_only_once():
    routine = Routine("r1", "Standup", "x", "cron", "", spec={"cron": "0 9 * * 1-5", "tz": ""})
    monday_nine = datetime(2026, 10, 5, 9, 0)
    assert routine.due(monday_nine - timedelta(minutes=1)) is None  # Friday's is long gone
    assert routine.due(monday_nine + timedelta(hours=2, minutes=59)) == monday_nine
    routine.last_run = monday_nine.isoformat(timespec="minutes")
    assert routine.due(monday_nine + timedelta(hours=1)) is None
    assert routine.due(monday_nine + timedelta(hours=3, minutes=1)) is None
    assert routines.GRACE == timedelta(hours=3)


def test_an_expression_is_read_once_and_a_wrong_one_says_why_every_time():
    first = schedules.parse_cron("0 9 * * 1-5")
    assert schedules.parse_cron("  0 9 * *  1-5 ") is first  # the same, however it's spaced
    assert schedules.parse_cron("@DAILY") == schedules.parse_cron("0 0 * * *")
    for _ in range(2):
        with pytest.raises(ValueError, match="never happen together"):
            schedules.parse_cron("0 9 31 2 *")
