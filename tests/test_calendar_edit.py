"""JARVIS changes calendar events: the one event asked for, only after a yes on a card that
shows each change as old → new, in the language the user speaks."""

from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext

from jarvis import brain, calendar_kit, lang, mac_tools
from jarvis.config import Settings

CTX = ToolPermissionContext()


def row(title="Dentist", begin="2026-09-30T15:00", calendar="Home", **extra):
    return {
        "title": title,
        "begin": begin,
        "end": begin[:11] + "16:00",
        "all_day": False,
        "location": "",
        "calendar": calendar,
        "id": f"id-{title}-{calendar}",
        "attendees": [],
        "writable": True,
        "repeats": False,
        "mine": True,
        "organizer": "",
        **extra,
    }


@pytest.fixture
def calendar(monkeypatch):
    state = {"events": [], "edited": [], "error": ""}

    async def events_at(start):
        if state["error"]:
            return {"error": state["error"]}
        return {"events": [e for e in state["events"] if e["begin"].startswith(start)]}

    async def edit_at(start, event_id, cal, future, changes):
        state["edited"].append((start, event_id, cal, future, changes))
        base = next(e for e in state["events"] if e["id"] == event_id)
        after = dict(base)
        if "title" in changes:
            after["title"] = changes["title"]
        if "start" in changes:
            after["begin"] = (
                changes["start"] if "T" in changes["start"] else changes["start"] + "T00:00"
            )
        return {"edited": after, "was": base, "span": "future" if future else "this"}

    monkeypatch.setattr(calendar_kit, "events_at", events_at)
    monkeypatch.setattr(calendar_kit, "edit_at", edit_at)
    monkeypatch.setattr(mac_tools, "_today", lambda: date(2026, 9, 29))  # a Tuesday
    return state


def test_the_changes_are_read_and_validated():
    assert mac_tools._event_changes({"new_start": "tomorrow at 3"})[1]  # not a time
    assert mac_tools._event_changes({"new_duration_minutes": 0})[1]  # out of range
    assert mac_tools._event_changes({"new_duration_minutes": 5000})[1]
    assert mac_tools._event_changes({"new_duration_minutes": "soon"})[1]  # not a number
    assert mac_tools._event_changes({})[1]  # nothing to change
    changes, why = mac_tools._event_changes(
        {"new_title": "  Lunch  ", "new_duration_minutes": 45, "new_start": "2026-09-30T16:00"}
    )
    assert why == "" and changes == {
        "title": "Lunch",
        "duration_minutes": 45,
        "start": "2026-09-30T16:00",
    }


def test_notes_link_and_alerts_are_checked_as_a_new_events_are():
    changes, why = mac_tools._event_changes(
        {"new_notes": "  Bring\x00 the card.  ", "new_url": "", "new_alerts": [60, 0, 60]}
    )
    assert why == "" and changes == {"notes": "Bring the card.", "url": "", "alerts": [0, 60]}
    assert mac_tools._event_changes({"new_alerts": []})[0] == {"alerts": []}  # removes them
    assert mac_tools._event_changes({"new_notes": "x" * 5000})[0]["notes"] == "x" * 2000
    for bad in (
        {"new_url": "http://plain.example"},
        {"new_url": "javascript:alert(1)"},
        {"new_alerts": [10, 20, 30, 40]},
        {"new_alerts": [-5]},
        {"new_alerts": [99999999]},
    ):
        assert mac_tools._event_changes(bad)[1], bad
    assert mac_tools.alert_words([0, 10, 60, 1440]) == (
        "when it starts, 10 minutes before, 1 hour before, 1 day before"
    )
    assert mac_tools.alert_words([]) == "none"


async def test_the_card_shows_notes_link_and_alerts(calendar):
    calendar["events"] = [row()]
    q, why = await mac_tools.edit_question(
        {
            "title": "dentist",
            "start": "2026-09-30T15:00",
            "new_notes": "Bring   the card.",
            "new_url": "https://dent.example/booking",
            "new_alerts": [30],
        }
    )
    assert why == ""
    assert "Notes → “Bring the card.”" in q
    assert "Link → https://dent.example/booking" in q
    assert "Alerts → 30 minutes before" in q
    q, _ = await mac_tools.edit_question(
        {
            "title": "dentist",
            "start": "2026-09-30T15:00",
            "new_notes": "",
            "new_url": "",
            "new_alerts": [],
        }
    )
    assert "Clear the notes" in q and "Clear the link" in q and "Alerts → none" in q


class FakeAlarm:
    def __init__(self, offset=None, absolute=None):
        self.offset, self.absolute = offset, absolute

    def relativeOffset(self):  # noqa: N802 - EventKit's names
        return self.offset

    def absoluteDate(self):  # noqa: N802
        return self.absolute


class FakeLink:
    def __init__(self, text):
        self.text = text

    def absoluteString(self):  # noqa: N802
        return self.text


class FakeEvent:
    """An EKEvent's few calls edit() and _row() make, over plain state."""

    def __init__(self, begin, end, all_day=False):
        self.begin, self.end, self.all_day = begin, end, all_day
        self.note, self.link = "Old notes", FakeLink("https://old.example")
        self.alarm_list = [FakeAlarm(-600.0), FakeAlarm(absolute=1.0)]
        self.saved = 0

    def __getattr__(self, name):  # anything else edit/_row asks: a quiet default
        defaults = {
            "status": 0,
            "attendees": [],
            "organizer": None,
            "location": "",
            "title": "Trip",
            "hasRecurrenceRules": False,
            "calendarItemExternalIdentifier": "ext-1",
            "eventIdentifier": "ev-1",
            "calendar": None,
        }
        if name in defaults:
            return lambda: defaults[name]
        raise AttributeError(name)

    def startDate(self):  # noqa: N802
        return SimpleNamespace(timeIntervalSince1970=self.begin.timestamp)

    def endDate(self):  # noqa: N802
        return SimpleNamespace(timeIntervalSince1970=self.end.timestamp)

    def isAllDay(self):  # noqa: N802
        return self.all_day

    def setStartDate_(self, seconds):  # noqa: N802
        self.begin = datetime.fromtimestamp(seconds)

    def setEndDate_(self, seconds):  # noqa: N802
        self.end = datetime.fromtimestamp(seconds)

    def notes(self):
        return self.note

    def setNotes_(self, text):  # noqa: N802
        self.note = text

    def URL(self):  # noqa: N802
        return self.link

    def setURL_(self, link):  # noqa: N802
        self.link = link

    def alarms(self):
        return list(self.alarm_list)

    def removeAlarm_(self, alarm):  # noqa: N802
        self.alarm_list.remove(alarm)

    def addAlarm_(self, alarm):  # noqa: N802
        self.alarm_list.append(alarm)


def fake_frameworks(event):
    class Store:
        def init(self):
            return self

        def saveEvent_span_commit_error_(self, _event, _span, _commit, _error):  # noqa: N802
            event.saved += 1
            return True, None

    ek = SimpleNamespace(
        EKEventStore=SimpleNamespace(
            alloc=Store, authorizationStatusForEntityType_=lambda _kind: 3
        ),
        EKEntityTypeEvent=0,
        EKSpanThisEvent=0,
        EKSpanFutureEvents=1,
        EKAlarm=SimpleNamespace(alarmWithRelativeOffset_=lambda offset: FakeAlarm(offset)),
    )
    foundation = SimpleNamespace(
        NSDate=SimpleNamespace(dateWithTimeIntervalSince1970_=lambda seconds: seconds),
        NSURL=SimpleNamespace(URLWithString_=FakeLink),
    )
    return ek, foundation


def edit_fake(monkeypatch, event, changes, all_day=False):
    found = calendar_kit._row(event, details=True)
    found |= {"writable": True, "calendar": "Home", "id": "ext-1"}
    monkeypatch.setattr(calendar_kit, "_starting", lambda _store, _start: [(found, event)])
    ek, foundation = fake_frameworks(event)
    return calendar_kit.edit("2026-10-10", "ext-1", "Home", False, changes, ek, foundation)


def test_edit_changes_notes_link_and_alerts_and_the_row_carries_them(monkeypatch):
    event = FakeEvent(datetime(2026, 10, 10, 9, 0), datetime(2026, 10, 10, 10, 0))
    before = calendar_kit._row(event, details=True)
    assert before["notes"] == "Old notes" and before["url"] == "https://old.example"
    assert before["alerts"] == [10]  # the alert at a fixed time isn't one of these
    done = edit_fake(
        monkeypatch, event, {"notes": "New", "url": "https://new.example", "alerts": [0, 30]}
    )
    assert "error" not in done and event.saved == 1
    assert event.note == "New" and event.link.text == "https://new.example"
    assert sorted(-a.offset / 60 for a in event.alarm_list) == [0, 30]
    assert done["was"]["notes"] == "Old notes" and done["edited"]["alerts"] == [0, 30]
    done = edit_fake(monkeypatch, event, {"notes": "", "url": "", "alerts": []})
    assert event.note is None and event.link is None and event.alarm_list == []


def test_moving_an_all_day_event_keeps_how_many_days_it_spans(monkeypatch):
    # EventKit ends an all-day event on its last day: three days, 10–12 October
    event = FakeEvent(datetime(2026, 10, 10), datetime(2026, 10, 12, 23, 59, 59), all_day=True)
    done = edit_fake(monkeypatch, event, {"start": "2026-10-14"})
    assert "error" not in done
    assert event.begin == datetime(2026, 10, 14)
    assert event.end.date() == date(2026, 10, 16)  # still three days (it was cut to one)


async def test_the_card_shows_each_change(calendar):
    calendar["events"] = [row()]
    q, why = await mac_tools.edit_question(
        {
            "title": "dentist",
            "start": "2026-09-30T15:00",
            "new_start": "2026-09-30T16:00",
            "new_location": "Main St",
        }
    )
    assert why == ""
    assert q.startswith("Change “Dentist”, tomorrow at 3:00 PM, on the Home calendar?")
    assert "Time → tomorrow at 4:00 PM" in q and "Location → “Main St”" in q


async def test_a_repeating_event_says_how_much_changes(calendar):
    calendar["events"] = [row("Standup", repeats=True)]
    args = {"title": "Standup", "start": "2026-09-30T15:00", "new_start": "2026-09-30T16:00"}
    assert "only this one changes" in (await mac_tools.edit_question(args))[0]
    assert "every later one change" in (await mac_tools.edit_question({**args, "future": True}))[0]


async def test_a_meeting_says_the_others_will_see_it(calendar):
    calendar["events"] = [row("Planning", attendees=["Ann Lee", "Ben Chu"])]
    q, _ = await mac_tools.edit_question(
        {"title": "Planning", "start": "2026-09-30T15:00", "new_title": "Planning sync"}
    )
    assert q.endswith("Others are in it (Ann Lee, Ben Chu): they'll see the change.")


async def test_the_card_says_the_times_in_chinese(calendar):
    calendar["events"] = [row("Dentist", calendar="Work", repeats=True)]
    q, _ = await mac_tools.edit_question(
        {"title": "Dentist", "start": "2026-09-30T15:00", "new_start": "2026-09-30T16:00"}, "zh"
    )
    zh = lang.translate(q, "zh")
    assert zh.startswith("要修改“Work”日历中的“Dentist”吗？时间：明天下午3:00。")
    assert "时间 → 明天下午4:00" in zh and "只修改这一次" in zh


@pytest.mark.parametrize(
    ("events", "args", "said"),
    [
        ([], {"title": "Dentist", "new_title": "X"}, "Nothing called “Dentist”"),
        (
            [row("Review", calendar="Work"), row("Review")],
            {"title": "Review", "new_title": "X"},
            "More than one event",
        ),
        (
            [row("Holiday", writable=False, calendar="US Holidays")],
            {"title": "Holiday", "new_title": "X"},
            "can't be changed",
        ),
        ([row("Dentist")], {"title": "Dentist"}, "Say what to change"),
    ],
    ids=["none", "several", "read-only", "no-change"],
)
async def test_no_card_without_one_event_and_a_real_change(calendar, events, args, said):
    calendar["events"] = events
    q, why = await mac_tools.edit_question({**args, "start": "2026-09-30T15:00"})
    assert q == "" and said in why


async def test_the_policy_asks_with_that_card_and_denies_an_empty_change(calendar):
    calendar["events"] = [row("Dentist")]
    asked = []

    async def yes(q):
        asked.append(q)
        return True

    args = {"title": "Dentist", "start": "2026-09-30T15:00", "new_start": "2026-09-30T16:00"}
    assert isinstance(
        await brain.make_permission_policy(yes)("mcp__mac__edit_event", args, CTX),
        PermissionResultAllow,
    )
    assert asked[0].startswith("Change “Dentist”")

    async def never(_q):
        raise AssertionError("no card when there's nothing to change")

    empty = await brain.make_permission_policy(never)(
        "mcp__mac__edit_event", {"title": "Dentist", "start": "2026-09-30T15:00"}, CTX
    )
    assert isinstance(empty, PermissionResultDeny) and "Nothing was changed" in empty.message


async def test_the_tool_applies_exactly_the_changes(calendar):
    calendar["events"] = [row("Standup", calendar="Work", repeats=True)]
    out = await mac_tools.edit_event.handler(
        {
            "title": "Standup",
            "start": "2026-09-30T15:00",
            "new_start": "2026-09-30T16:00",
            "new_title": "Standup sync",
            "future": True,
        }
    )
    assert out["content"][0]["text"].startswith(
        "Changed “Standup sync” — now 2026-09-30 16:00 on the Work calendar and every later one."
    )
    start, eid, cal, future, changes = calendar["edited"][-1]
    assert (start, eid, cal, future) == ("2026-09-30T15:00", "id-Standup-Work", "Work", True)
    assert changes == {"title": "Standup sync", "start": "2026-09-30T16:00"}


async def test_a_save_the_calendar_refuses_is_said(calendar, monkeypatch):
    calendar["events"] = [row()]

    async def refused(*_a):
        return {"error": "Calendar didn't save it (the server is offline)."}

    monkeypatch.setattr(calendar_kit, "edit_at", refused)
    out = await mac_tools.edit_event.handler(
        {"title": "Dentist", "start": "2026-09-30T15:00", "new_title": "X"}
    )
    assert out.get("is_error") and "server is offline" in out["content"][0]["text"]


def test_changing_is_never_allowed_without_asking(tmp_path):
    async def never(_q):
        raise AssertionError("should not ask")

    opts = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert "mcp__mac__edit_event" not in opts.allowed_tools
    assert "changing or removing calendar events" in opts.system_prompt
