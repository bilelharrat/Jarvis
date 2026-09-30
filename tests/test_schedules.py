"""Richer routine schedules (jarvis.schedules): every N minutes within a window, monthly
(a day, the last day, the Nth weekday) and cron with a time zone. Fixed clocks only."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from jarvis import schedules as s

TUE = datetime(2026, 9, 29, 10, 7)  # a Tuesday
LA = ZoneInfo("America/Los_Angeles")


def interval(**spec):
    return s.clean_interval(spec)


# ── every N minutes ──


def test_every_n_minutes_within_a_window_on_weekdays():
    spec = interval(every=30, start="9:00", end="18:00", days=[0, 1, 2, 3, 4])
    assert spec == {"every": 30, "start": "09:00", "end": "18:00", "days": [0, 1, 2, 3, 4]}
    assert s.latest("interval", spec, "", TUE) == datetime(2026, 9, 29, 10, 0)
    assert s.next_after("interval", spec, "", TUE) == datetime(2026, 9, 29, 10, 30)
    # Before the window: nothing today yet; the latest was yesterday's last one (18:00).
    early = datetime(2026, 9, 29, 8, 0)
    assert s.latest("interval", spec, "", early) == datetime(2026, 9, 28, 18, 0)
    assert s.next_after("interval", spec, "", early) == datetime(2026, 9, 29, 9, 0)
    # After it: the day's last one, then tomorrow's first.
    late = datetime(2026, 9, 29, 20, 0)
    assert s.latest("interval", spec, "", late) == datetime(2026, 9, 29, 18, 0)
    assert s.next_after("interval", spec, "", late) == datetime(2026, 9, 30, 9, 0)
    # Friday evening: the next is Monday morning.
    friday = datetime(2026, 10, 2, 19, 0)
    assert s.next_after("interval", spec, "", friday) == datetime(2026, 10, 5, 9, 0)


def test_every_hour_all_day_and_a_window_past_midnight():
    hourly = interval(every=60)
    assert hourly == {"every": 60, "start": "00:00", "end": "", "days": []}
    assert s.latest("interval", hourly, "", TUE) == datetime(2026, 9, 29, 10, 0)
    assert s.next_after("interval", hourly, "", datetime(2026, 9, 29, 23, 30)) == datetime(
        2026, 9, 30, 0, 0
    )
    night = interval(every=60, start="22:00", end="02:00")
    one_am = datetime(2026, 9, 29, 1, 30)
    assert s.latest("interval", night, "", one_am) == datetime(2026, 9, 29, 1, 0)
    assert s.next_after("interval", night, "", one_am) == datetime(2026, 9, 29, 2, 0)
    assert s.next_after("interval", night, "", datetime(2026, 9, 29, 2, 30)) == datetime(
        2026, 9, 29, 22, 0
    )


def test_an_interval_that_doesnt_divide_the_window_stops_inside_it():
    spec = interval(every=45, start="09:00", end="10:00")
    assert s.next_after("interval", spec, "", datetime(2026, 9, 29, 9, 50)) == datetime(
        2026, 9, 30, 9, 0
    )
    assert s.latest("interval", spec, "", datetime(2026, 9, 29, 11, 0)) == datetime(
        2026, 9, 29, 9, 45
    )


@pytest.mark.parametrize(
    "bad",
    [
        {"every": 2},  # more often than a routine should run
        {"every": 1441},
        {"every": "often"},
        {"every": True},
        {"every": 30, "start": "9am"},
        {"every": 30, "end": "25:00"},
        {"every": 30, "days": [7]},
        {"every": 30, "days": "weekdays"},
        {"every": 30, "days": [None]},
        {},
        "every 30",
    ],
)
def test_bad_intervals_are_refused(bad):
    with pytest.raises(ValueError):
        s.clean_interval(bad)


def test_all_seven_days_is_every_day():
    assert interval(every=30, days=[6, 5, 4, 3, 2, 1, 0])["days"] == []
    assert interval(every=30, start="09:00", end="09:00")["end"] == ""  # a whole day


# ── monthly ──


def test_monthly_on_a_day_clamped_to_short_months_and_on_the_last_day():
    first = s.clean_monthly({"day": 1})
    assert s.latest("monthly", first, "09:00", TUE) == datetime(2026, 9, 1, 9, 0)
    assert s.next_after("monthly", first, "09:00", TUE) == datetime(2026, 10, 1, 9, 0)
    thirty_first = s.clean_monthly({"day": 31})
    assert s.next_after("monthly", thirty_first, "09:00", TUE) == datetime(2026, 9, 30, 9, 0)
    feb = datetime(2027, 2, 1)
    assert s.next_after("monthly", thirty_first, "09:00", feb) == datetime(2027, 2, 28, 9, 0)
    last = s.clean_monthly({"day": -1})
    assert s.next_after("monthly", last, "17:00", datetime(2028, 2, 3)) == datetime(
        2028, 2, 29, 17, 0
    )


def test_monthly_on_the_nth_or_last_weekday():
    first_monday = s.clean_monthly({"nth": 1, "weekday": 0})
    assert s.next_after("monthly", first_monday, "09:00", TUE) == datetime(2026, 10, 5, 9, 0)
    assert s.latest("monthly", first_monday, "09:00", TUE) == datetime(2026, 9, 7, 9, 0)
    last_friday = s.clean_monthly({"nth": -1, "weekday": 4})
    assert s.latest("monthly", last_friday, "16:00", TUE) == datetime(2026, 9, 25, 16, 0)
    assert s.next_after("monthly", last_friday, "16:00", TUE) == datetime(2026, 10, 30, 16, 0)
    # A fifth Thursday only in the months that have one.
    fifth_thursday = s.clean_monthly({"nth": 5, "weekday": 3})
    assert s.next_after("monthly", fifth_thursday, "09:00", TUE) == datetime(2026, 10, 29, 9, 0)
    assert s.next_after("monthly", fifth_thursday, "09:00", datetime(2026, 11, 1)) == datetime(
        2026, 12, 31, 9, 0
    )


@pytest.mark.parametrize(
    "bad",
    [{"day": 0}, {"day": 32}, {"day": -2}, {"nth": 6, "weekday": 0}, {"nth": 1, "weekday": 7}],
)
def test_bad_monthly_schedules_are_refused(bad):
    with pytest.raises(ValueError):
        s.clean_monthly(bad)
    with pytest.raises(ValueError):
        s.clean_monthly({"nth": 1})  # a weekday is needed too


# ── cron ──


def test_cron_fields_steps_lists_names_and_macros():
    cron = s.parse_cron("*/15 9-17 * * mon-fri")
    assert cron.minutes == (0, 15, 30, 45) and cron.hours == tuple(range(9, 18))
    assert s.parse_cron("0 0 1 jan,jul *").months == frozenset({1, 7})
    assert s.parse_cron("0 12 * * 7").dows == frozenset({0})  # 7 is Sunday too
    assert s.parse_cron("5/20 * * * *").minutes == (5, 25, 45)
    assert s.parse_cron("@hourly") == s.parse_cron("0 * * * *")
    assert s.parse_cron("@weekly") == s.parse_cron("0 0 * * 0")


@pytest.mark.parametrize(
    "bad",
    ["", "0 9 * *", "0 9 * * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *",
     "0 0 5-1 * *", "*/0 * * * *", "0 0 30 2 *", "@sometimes", "a b c d e", "0 0 * * 8"],
)  # fmt: skip
def test_bad_cron_expressions_say_why(bad):
    with pytest.raises(ValueError, match="cron"):
        s.parse_cron(bad)


def test_cron_day_of_month_or_week_as_cron_reads_them():
    # Neither starts with *: either day counts (the 13th, and every Friday).
    either = s.parse_cron("0 9 13 * 5")
    assert either.day_matches(datetime(2026, 10, 13).date())  # a Tuesday the 13th
    assert either.day_matches(datetime(2026, 10, 2).date())  # a Friday
    assert not either.day_matches(datetime(2026, 10, 1).date())
    # One starts with *: both must match (every other day, and only on Mondays).
    both = s.parse_cron("0 9 */2 * 1")
    assert both.day_matches(datetime(2026, 10, 5).date())  # Monday the 5th
    assert not both.day_matches(datetime(2026, 10, 12).date())  # Monday, but the 12th


def test_cron_in_another_time_zone_runs_at_its_time_here():
    spec = s.clean_cron({"cron": "0 9 * * 1-5", "tz": "America/New_York"})
    # 9 AM in New York is 6 AM here in Los Angeles.
    assert s.latest("cron", spec, "", TUE, LA) == datetime(2026, 9, 29, 6, 0)
    assert s.next_after("cron", spec, "", TUE, LA) == datetime(2026, 9, 30, 6, 0)
    fri = datetime(2026, 10, 2, 7, 0)
    assert s.next_after("cron", spec, "", fri, LA) == datetime(2026, 10, 5, 6, 0)
    # A time zone that moves its clocks on another date: Europe went back a week before
    # the US did in 2026, so 9 AM in Berlin is an hour later here for that week.
    berlin = s.clean_cron({"cron": "0 9 * * *", "tz": "Europe/Berlin"})
    assert s.next_after("cron", berlin, "", datetime(2026, 10, 19, 23, 0), LA) == datetime(
        2026, 10, 20, 0, 0
    )
    assert s.next_after("cron", berlin, "", datetime(2026, 10, 27), LA) == datetime(
        2026, 10, 27, 1, 0
    )


def test_cron_latest_and_next_search_minute_by_minute():
    spec = s.clean_cron({"cron": "*/15 * * * *", "tz": ""})
    assert s.latest("cron", spec, "", TUE) == datetime(2026, 9, 29, 10, 0)
    assert s.next_after("cron", spec, "", TUE) == datetime(2026, 9, 29, 10, 15)
    exact = datetime(2026, 9, 29, 10, 15)
    assert s.latest("cron", spec, "", exact) == exact  # due at, not only before
    assert s.next_after("cron", spec, "", exact) == datetime(2026, 9, 29, 10, 30)
    leap = s.clean_cron({"cron": "0 8 29 2 *", "tz": ""})
    assert s.next_after("cron", leap, "", TUE) == datetime(2028, 2, 29, 8, 0)
    assert s.latest("cron", leap, "", TUE) is None  # over a year back: not looked for


def test_bad_time_zones_are_refused():
    for bad in ("Mars/Olympus", "../etc", "x" * 80, "New York"):
        with pytest.raises(ValueError):
            s.clean_cron({"cron": "0 9 * * *", "tz": bad})


# ── in words ──


@pytest.mark.parametrize(
    ("kind", "spec", "at", "en", "zh"),
    [
        ("interval", {"every": 30, "start": "09:00", "end": "18:00", "days": [0, 1, 2, 3, 4]},
         "00:00", "every 30 minutes, 9 AM to 6 PM, weekdays", "工作日上午9点到晚上6点之间每30分钟"),
        ("interval", {"every": 60}, "00:00", "every hour", "每小时"),
        ("interval", {"every": 120, "days": [5, 6]}, "00:00", "every 2 hours, weekends", "周末每2小时"),
        ("interval", {"every": 20, "start": "13:30", "days": [0, 4]}, "00:00",
         "every 20 minutes, 1:30 PM to midnight, Mondays and Fridays",
         "每周一、周五下午1:30到午夜之间每20分钟"),
        ("monthly", {"day": 1}, "09:00", "monthly on the 1st at 9 AM", "每月1日上午9点"),
        ("monthly", {"day": 22}, "09:30", "monthly on the 22nd at 9:30 AM", "每月22日上午9:30"),
        ("monthly", {"day": -1}, "17:00", "monthly on the last day at 5 PM", "每月最后一天下午5点"),
        ("monthly", {"nth": 1, "weekday": 0}, "09:00", "monthly on the first Monday at 9 AM",
         "每月第一个周一上午9点"),
        ("monthly", {"nth": -1, "weekday": 4}, "16:00", "monthly on the last Friday at 4 PM",
         "每月最后一个周五下午4点"),
        ("cron", {"cron": "0 9 * * 1-5", "tz": "America/New_York"}, "00:00",
         "weekdays at 9 AM (America/New_York)", "工作日上午9点（America/New_York）"),
        ("cron", {"cron": "30 7 * * sat,sun", "tz": ""}, "00:00", "weekends at 7:30 AM", "周末早上7:30"),
        ("cron", {"cron": "0 0 * * *", "tz": ""}, "00:00", "every day at 12 AM", "每天凌晨12点"),
        ("cron", {"cron": "*/15 * * * *", "tz": ""}, "00:00", "every 15 minutes", "每15分钟"),
        ("cron", {"cron": "0 */2 * * *", "tz": ""}, "00:00", "every 2 hours", "每2小时"),
        ("cron", {"cron": "0 9 13 * 5", "tz": ""}, "00:00", "on the cron schedule “0 9 13 * 5”",
         "按 cron “0 9 13 * 5”"),
        ("cron", {"cron": "0 9 1-31 * 1", "tz": ""}, "00:00", "every day at 9 AM", "每天上午9点"),
    ],
)  # fmt: skip
def test_schedules_in_words(kind, spec, at, en, zh):
    spec = s.clean(kind, spec)
    assert s.describe(kind, spec, at) == en
    assert s.describe(kind, spec, at, "zh") == zh


def test_unknown_kinds():
    with pytest.raises(ValueError):
        s.clean("hourly", {})
    assert s.latest("daily", {}, "07:00", TUE) is None
    assert s.describe("daily", {}, "07:00") == ""
