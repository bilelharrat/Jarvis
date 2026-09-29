"""JARVIS finds open times across the user's calendars. Read-only: it proposes windows;
booking still goes through create_event's card."""

from dataclasses import replace
from datetime import date, datetime, time, timedelta

from jarvis import brain, mac_tools
from jarvis.config import Settings


def ev(begin, end, all_day=False, title="Busy"):
    return {
        "begin": datetime.fromisoformat(begin),
        "end": datetime.fromisoformat(end),
        "all_day": all_day,
        "title": title,
    }


def test_free_windows_finds_the_gaps_within_working_hours():
    now = datetime(2026, 9, 29, 8, 0)  # before the 9-18 window
    end = datetime(2026, 9, 30, 0, 0)
    events = [
        ev("2026-09-29T10:00", "2026-09-29T11:00"),
        ev("2026-09-29T14:00", "2026-09-29T15:30"),
    ]
    assert mac_tools.free_windows(events, 30, now, end, 9, 18, now) == [
        (datetime(2026, 9, 29, 9, 0), datetime(2026, 9, 29, 10, 0)),
        (datetime(2026, 9, 29, 11, 0), datetime(2026, 9, 29, 14, 0)),
        (datetime(2026, 9, 29, 15, 30), datetime(2026, 9, 29, 18, 0)),
    ]


def test_free_windows_never_offers_a_time_in_the_past():
    now = datetime(2026, 9, 29, 13, 0)  # 1 PM
    assert mac_tools.free_windows([], 60, now, datetime(2026, 9, 30, 0, 0), 9, 18, now) == [
        (datetime(2026, 9, 29, 13, 0), datetime(2026, 9, 29, 18, 0))
    ]


def test_all_day_events_do_not_count_as_busy():
    now = datetime(2026, 9, 29, 8, 0)
    events = [ev("2026-09-29T00:00", "2026-09-30T00:00", all_day=True, title="Vacation")]
    assert mac_tools.free_windows(events, 60, now, datetime(2026, 9, 30, 0, 0), 9, 18, now) == [
        (datetime(2026, 9, 29, 9, 0), datetime(2026, 9, 29, 18, 0))
    ]


def test_a_gap_shorter_than_the_meeting_is_skipped():
    now = datetime(2026, 9, 29, 8, 0)
    events = [
        ev("2026-09-29T09:20", "2026-09-29T10:00"),
        ev("2026-09-29T10:15", "2026-09-29T18:00"),
    ]
    assert mac_tools.free_windows(events, 30, now, datetime(2026, 9, 30, 0, 0), 9, 18, now) == []


def test_free_windows_spans_several_days():
    now = datetime(2026, 9, 29, 8, 0)
    end = datetime(2026, 10, 1, 0, 0)
    events = [ev("2026-09-30T09:00", "2026-09-30T18:00")]  # the 30th is full
    w = mac_tools.free_windows(events, 120, now, end, 9, 18, now)
    assert (datetime(2026, 9, 29, 9, 0), datetime(2026, 9, 29, 18, 0)) in w
    assert all(s.date() != date(2026, 9, 30) for s, _ in w)  # nothing on the full day


async def test_find_free_slots_lists_windows_and_notes_all_day(monkeypatch):
    today = date.today()

    async def fake_fetch(_offset, _days):
        return [
            {
                "begin": datetime.combine(today + timedelta(days=1), time()),
                "end": datetime.combine(today + timedelta(days=2), time()),
                "all_day": True,
                "title": "Vacation",
            }
        ]

    monkeypatch.setattr(mac_tools, "fetch_events", fake_fetch)
    window = (datetime.combine(today, time(14, 0)), datetime.combine(today, time(16, 0)))
    monkeypatch.setattr(mac_tools, "free_windows", lambda *a, **k: [window])
    out = await mac_tools.find_free_slots.handler({"duration_minutes": 60})
    text = out["content"][0]["text"]
    assert text.startswith("Open windows for a 60-minute meeting:")
    assert "2:00 PM – 4:00 PM" in text
    assert "“Vacation”" in text and "all-day events not counted as busy" in text


async def test_find_free_slots_says_when_there_are_none(monkeypatch):
    async def fake_fetch(_offset, _days):
        return []

    monkeypatch.setattr(mac_tools, "fetch_events", fake_fetch)
    monkeypatch.setattr(mac_tools, "free_windows", lambda *a, **k: [])
    out = await mac_tools.find_free_slots.handler({"duration_minutes": 45, "within_days": 3})
    assert "No open 45-minute windows in the next 3 day(s)" in out["content"][0]["text"]


def test_finding_slots_is_read_only_and_never_asks(tmp_path):
    async def never(_q):
        raise AssertionError("should not ask")

    opts = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert "mcp__mac__find_free_slots" in opts.allowed_tools
    assert "find_free_slots" not in mac_tools.NEEDS_CONFIRMATION
