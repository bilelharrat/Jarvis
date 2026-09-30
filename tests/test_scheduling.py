"""The calendar with people and conversations: whole events through EventKit (notes,
alerts, repeats, all-day, a link) with a card that shows them, invitations with a card
that shows who, finding a time across people (free/busy through a connector), a
conversation's agreed time booked only after a yes, and one gentle nudge after a silence.
EventKit, Calendar's scripts, Contacts and connectors are all fakes here."""

import asyncio
import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from conftest import FakeClient
from test_delegate import NOW, SAM, World, engine_for, move, start

from jarvis import brain, calendar_kit, delegate, lang, mac_tools
from jarvis.features import scheduling
from jarvis.hub import Hub


@pytest.fixture(autouse=True)
def tuesday(monkeypatch):
    monkeypatch.setattr(mac_tools, "_today", lambda: date(2026, 9, 29))  # a Tuesday


# ── what create_event takes ──


def test_a_whole_event_is_checked_and_made_plain():
    spec = mac_tools.clean_event(
        {
            "title": "  Standup ",
            "start": "2026-10-01T09:30",
            "duration_minutes": 15,
            "notes": "Agenda:\n- blockers",
            "url": "https://meet.google.com/abc-defg-hij",
            "alerts": [10, 0, 10],
            "repeat": "weekdays",
            "repeat_until": "2026-12-31",
            "calendar": "Work",
        }
    )
    assert spec == {
        "title": "Standup",
        "start": "2026-10-01T09:30",
        "end": "2026-10-01T09:45",
        "all_day": False,
        "minutes": 15,
        "days": 1,
        "location": "https://meet.google.com/abc-defg-hij",  # a video link: Calendar can join
        "notes": "Agenda:\n- blockers",
        "url": "https://meet.google.com/abc-defg-hij",
        "video": True,
        "alerts": [0, 10],
        "repeat": {
            "frequency": "weekly",
            "every": 1,
            "days": [0, 1, 2, 3, 4],
            "until": "2026-12-31",
            "count": 0,
            "weekdays": True,
        },
        "calendar": "Work",
    }
    day = mac_tools.clean_event({"title": "Offsite", "start": "2026-10-05", "days": 3})
    assert (day["all_day"], day["start"], day["end"]) == (
        True,
        "2026-10-05T00:00",
        "2026-10-08T00:00",
    )
    ended = mac_tools.clean_event(
        {"title": "Call", "start": "2026-10-01T09:00", "end": "2026-10-01T09:45"}
    )
    assert ended["minutes"] == 45
    weekly = mac_tools.clean_event(
        {
            "title": "Gym",
            "start": "2026-10-01T07:00",
            "repeat": "weekly",
            "repeat_every": 2,
            "repeat_days": ["Mon", "thursday"],
            "repeat_count": 10,
        }  # fmt: skip
    )
    assert weekly["repeat"]["days"] == [0, 3] and weekly["repeat"]["count"] == 10


@pytest.mark.parametrize(
    ("args", "why"),
    [
        ({"title": "", "start": "2026-10-01T09:00"}, "needs a title"),
        ({"title": "x", "start": "Thu 9:00"}, "isn't a time"),
        ({"title": "x", "start": "2026-10-01T09:00", "url": "javascript:alert(1)"}, "https://"),
        ({"title": "x", "start": "2026-10-01T09:00", "url": "https://a:b@evil.com"}, "https://"),
        ({"title": "x", "start": "2026-10-01T09:00", "alerts": [1, 2, 3, 4]}, "At most 3"),
        ({"title": "x", "start": "2026-10-01T09:00", "end": "2026-10-01T08:00"}, "after the start"),
        ({"title": "x", "start": "2026-10-01T09:00", "repeat": "hourly"}, "repeat must be"),
        (
            {
                "title": "x",
                "start": "2026-10-01T09:00",
                "repeat": "weekly",
                "repeat_days": ["Funday"],
            },
            "isn't a day",
        ),
        (
            {
                "title": "x",
                "start": "2026-10-01T09:00",
                "repeat": "daily",
                "repeat_until": "2026-12-01",
                "repeat_count": 3,
            },  # fmt: skip
            "not both",
        ),
        (
            {
                "title": "x",
                "start": "2026-10-01T09:00",
                "repeat": "daily",
                "repeat_until": "2026-09-01",
            },
            "can't end before",
        ),
    ],
)
def test_what_calendar_cant_hold_is_said_before_any_card(args, why):
    with pytest.raises(ValueError, match=why):
        mac_tools.clean_event(args)


def test_the_card_says_the_event_as_it_is_heard_with_a_line_for_each_extra():
    question, why = mac_tools.creation_question(
        {
            "title": "Standup",
            "start": "2026-10-01T09:30",
            "duration_minutes": 15,
            "alerts": [10, 1440],
            "repeat": "weekly",
            "repeat_days": ["mon", "wed"],
            "repeat_until": "2026-12-31",
            "notes": "Bring the numbers",
            "calendar": "Work",
        }  # fmt: skip
    )
    assert not why
    head, rest = question.split("\n\n")
    assert head == "Add “Standup” to your calendar, Thursday 1 October at 9:30 AM, for 15 minutes?"
    assert rest.split("\n") == [
        "It repeats every week on Monday and Wednesday.",
        "Until 31 December 2026.",
        "Alerts: 10 minutes before, 1 day before.",
        "Notes: Bring the numbers",
        "On the Work calendar.",
    ]
    assert mac_tools.creation_question(
        {"title": "Lunch", "start": "2026-09-30T12:00", "location": "Café"}
    ) == (
        "Add “Lunch” to your calendar, tomorrow at 12:00 PM, for 60 minutes, at Café?",
        "",
    )
    question, _ = mac_tools.creation_question({"title": "Trip", "start": "2026-10-05", "days": 3})
    assert question == "Add the all-day “Trip” to your calendar, Monday 5 October, for 3 days?"
    assert mac_tools.creation_question({"title": "x", "start": "soon"})[0] == ""


def test_the_card_in_chinese():
    question, _ = mac_tools.creation_question(
        {
            "title": "站会",
            "start": "2026-09-30T09:00",
            "duration_minutes": 15,
            "alerts": [0, 60],
            "repeat": "weekly",
            "repeat_days": ["tue"],
            "repeat_count": 5,
        },  # fmt: skip
        "zh",
    )
    assert lang.translate(question, "zh").split("\n") == [
        "要把“站会”加到日历吗？时间：明天上午9:00，时长15分钟。",
        "",
        "每周的周二重复。",
        "共5次。",
        "提醒：开始时、提前1小时。",
    ]


async def test_the_permission_policy_shows_the_card_or_says_why_not():
    asked = []

    async def confirm(question):
        asked.append(question)
        return True

    policy = brain.make_permission_policy(confirm)
    ctx = ToolPermissionContext()
    bad = await policy("mcp__mac__create_event", {"title": "Dentist", "start": "Thu 9"}, ctx)
    assert isinstance(bad, PermissionResultDeny) and "isn't a time" in bad.message
    assert asked == []
    good = await policy(
        "mcp__mac__create_event",
        {"title": "Dentist", "start": "2026-10-01T09:00", "alerts": [30]},
        ctx,
    )
    assert isinstance(good, PermissionResultAllow)
    assert asked == [
        "Add “Dentist” to your calendar, Thursday 1 October at 9:00 AM, for 60 minutes?\n\n"
        "Alerts: 30 minutes before."
    ]


# ── EventKit ──


class FakeEK:
    """Enough of EventKit for calendar_kit.create: one store, a Work and a read-only
    Holidays calendar, and the event as it's filled in."""

    EKEntityTypeEvent = 0
    EKSpanThisEvent = 0

    def __init__(self, access=3):
        ek = self
        self.access = access
        self.saved = []

        class Cal:
            def __init__(self, title, writable=True):
                self._title, self._writable = title, writable

            def title(self):
                return self._title

            def allowsContentModifications(self):
                return self._writable

        self.work, self.holidays = Cal("Work"), Cal("Holidays", writable=False)

        class Store:
            @staticmethod
            def authorizationStatusForEntityType_(_kind):
                return ek.access

            @classmethod
            def alloc(cls):
                return cls()

            def init(self):
                return self

            def calendarsForEntityType_(self, _kind):
                return [ek.work, ek.holidays]

            def defaultCalendarForNewEvents(self):
                return ek.work

            def saveEvent_span_commit_error_(self, event, span, commit, error):
                ek.saved.append(event)
                return True, None

        class Stamp:
            def __init__(self, seconds):
                self.seconds = seconds

            def timeIntervalSince1970(self):
                return self.seconds

        class Event:
            def __init__(self):
                self.values = {"alarms": [], "rules": []}

            @classmethod
            def eventWithEventStore_(cls, _store):
                return cls()

            def __getattr__(self, name):
                if name.startswith("set") and name.endswith("_"):
                    key = name[3:-1]
                    return lambda value: self.values.__setitem__(key, value)
                raise AttributeError(name)

            def addAlarm_(self, alarm):
                self.values["alarms"].append(alarm)

            def addRecurrenceRule_(self, rule):
                self.values["rules"].append(rule)

            def status(self):
                return 0

            def startDate(self):
                return self.values["StartDate"]

            def endDate(self):
                return self.values["EndDate"]

            def attendees(self):
                return []

            def title(self):
                return self.values["Title"]

            def isAllDay(self):
                return self.values["AllDay"]

            def location(self):
                return self.values.get("Location", "")

            def calendar(self):
                return self.values["Calendar"]

            def calendarItemExternalIdentifier(self):
                return "EV-1"

            def eventIdentifier(self):
                return "EV-1"

            def organizer(self):
                return None

            def hasRecurrenceRules(self):
                return bool(self.values["rules"])

        class Rule:
            @classmethod
            def alloc(cls):
                return cls()

            def initRecurrenceWithFrequency_interval_daysOfTheWeek_daysOfTheMonth_monthsOfTheYear_weeksOfTheYear_daysOfTheYear_setPositions_end_(
                self, freq, every, days, *rest
            ):
                self.freq, self.every, self.days, self.end = freq, every, days, rest[-1]
                return self

        self.EKEventStore, self.EKEvent, self.EKRecurrenceRule = Store, Event, Rule
        self.EKAlarm = SimpleNamespace(alarmWithRelativeOffset_=lambda s: ("alarm", s))
        self.EKRecurrenceDayOfWeek = SimpleNamespace(dayOfWeek_=lambda n: ("day", n))
        self.EKRecurrenceEnd = SimpleNamespace(
            recurrenceEndWithEndDate_=lambda d: ("until", d.seconds),
            recurrenceEndWithOccurrenceCount_=lambda n: ("count", n),
        )
        self.foundation = SimpleNamespace(
            NSDate=SimpleNamespace(dateWithTimeIntervalSince1970_=Stamp),
            NSURL=SimpleNamespace(URLWithString_=lambda u: ("url", u)),
        )


def test_eventkit_gets_every_part_of_the_event():
    ek = FakeEK()
    spec = mac_tools.clean_event(
        {
            "title": "Gym",
            "start": "2026-10-01T07:00",
            "duration_minutes": 45,
            "notes": "Legs",
            "url": "https://gym.example.com/class",
            "alerts": [15],
            "repeat": "weekly",
            "repeat_days": ["mon", "thu"],
            "repeat_count": 8,
            "calendar": "work",
        }  # fmt: skip
    )
    done = calendar_kit.create(spec, ek, ek.foundation)
    assert done["created"]["title"] == "Gym" and done["created"]["calendar"] == "Work"
    event = ek.saved[0].values
    assert event["Notes"] == "Legs" and event["URL"] == ("url", "https://gym.example.com/class")
    assert event["alarms"] == [("alarm", -900.0)]
    rule = event["rules"][0]
    assert (rule.freq, rule.every, rule.days, rule.end) == (
        1,
        1,
        [("day", 2), ("day", 5)],
        ("count", 8),
    )
    start = datetime(2026, 10, 1, 7, 0).timestamp()
    assert event["StartDate"].seconds == start and event["EndDate"].seconds == start + 45 * 60


def test_an_all_day_event_ends_on_its_last_day():
    ek = FakeEK()
    spec = mac_tools.clean_event({"title": "Offsite", "start": "2026-10-01", "days": 2})
    assert calendar_kit.create(spec, ek, ek.foundation)["created"]["title"] == "Offsite"
    event = ek.saved[0].values
    assert event["AllDay"] is True
    assert event["StartDate"].seconds == datetime(2026, 10, 1).timestamp()
    assert event["EndDate"].seconds == datetime(2026, 10, 2, 23, 59, 59).timestamp()
    assert (
        mac_tools.event_created(spec, "Work")
        == "Added the all-day “Offsite” on 2026-10-01 for 2 days to the Work calendar."
    )


def test_eventkit_refuses_what_it_cant_do():
    spec = mac_tools.clean_event(
        {"title": "x", "start": "2026-10-01T07:00", "calendar": "Holidays"}
    )
    ek = FakeEK()
    assert "can't be changed" in calendar_kit.create(spec, ek, ek.foundation)["error"]
    spec["calendar"] = "Nope"
    assert "no calendar called Nope" in calendar_kit.create(spec, ek, ek.foundation)["error"]
    denied = FakeEK(access=2)
    assert calendar_kit.create(spec, denied, denied.foundation) == {"error": calendar_kit.NO_ACCESS}


async def test_create_event_uses_eventkit_and_falls_back_for_a_plain_event(monkeypatch):
    made, scripts = [], []

    async def create_at(spec):
        made.append(spec)
        return {"created": {"calendar": "Work"}}

    async def run(script, *args, **_kw):
        scripts.append(args)
        return "Home"

    monkeypatch.setattr(calendar_kit, "create_at", create_at)
    monkeypatch.setattr(mac_tools, "run_applescript", run)
    tool = mac_tools.make_create_event("")
    out = await tool.handler({"title": "Lunch", "start": "2026-10-01T12:00", "alerts": [5]})
    assert out["content"][0]["text"] == "Added “Lunch” on 2026-10-01 12:00 to the Work calendar."
    assert made[0]["alerts"] == [5] and scripts == []

    async def no_access(spec):
        return {"error": calendar_kit.NO_ACCESS}

    monkeypatch.setattr(calendar_kit, "create_at", no_access)
    out = await tool.handler({"title": "Lunch", "start": "2026-10-01T12:00"})
    assert out["content"][0]["text"] == "Added “Lunch” on 2026-10-01 12:00 to the Home calendar."
    out = await tool.handler({"title": "Lunch", "start": "2026-10-01T12:00", "repeat": "daily"})
    assert out["is_error"] and "only add a plain timed event" in out["content"][0]["text"]


# ── invitations ──

ANN = {"name": "Ann Lee", "phones": [], "emails": [{"label": "work", "value": "ann@x.com"}]}
BOB = {"name": "Bob Ray", "phones": [], "emails": [{"label": "home", "value": "bob@y.com"}]}


async def lookup(query):
    return [p for p in (ANN, BOB) if query.lower().split()[0] in p["name"].lower()]


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub._say = lambda _text: None
    return hub


async def card_on(hub):
    for _ in range(300):
        if hub.approvals:
            return next(iter(hub.approvals.values()))
        await asyncio.sleep(0.01)
    raise AssertionError("no card went up")


COFFEE = {
    "title": "Coffee",
    "begin": "2026-10-01T15:00",
    "end": "2026-10-01T15:30",
    "all_day": False,
    "calendar": "Work",
    "id": "UID-7",
    "mine": True,
    "attendees": ["bob@y.com"],
}


async def test_an_invite_shows_who_gets_it_and_calendar_adds_them(
    settings, quiet_speaker, isolated
):
    ran = []

    async def event_at(_args):
        return {"event": dict(COFFEE)}

    async def run(script, *args, **_kw):
        ran.append((script, args))
        return ""

    hub = make_hub(settings, quiet_speaker, isolated)
    s = scheduling.Scheduler(hub, run=run, lookup=lookup, event_at=event_at)
    pending = asyncio.create_task(
        s.invite({"title": "Coffee", "start": "2026-10-01T15:00", "invitees": ["Ann", "Bob"]})
    )
    card = await card_on(hub)
    assert card["question"] == "Send the invite for “Coffee” to Ann Lee?"  # Bob's in it already
    assert card["detail"] == (
        "“Coffee”, Thursday 1 October at 3:00 PM (Work calendar)\n\nInvitees:\n"
        "Ann Lee <ann@x.com>\n\nCalendar sends each of them an invitation from your account."
    )
    assert [c["label"] for c in card["choices"]] == ["Send the invite", "Don't send"]
    assert ran == []
    hub.resolve(card["id"], "allow")
    out = await pending
    assert (
        out["content"][0]["text"] == "Invited Ann Lee to “Coffee”; Calendar sends the invitations."
    )
    assert ran == [
        (
            scheduling.INVITE_SCRIPT,
            ("Work", "UID-7", "Coffee", "2026", "10", "1", "15", "0", "ann@x.com"),
        )
    ]


async def test_no_invite_for_someone_elses_event_or_after_a_no(settings, quiet_speaker, isolated):
    ran = []

    async def theirs(_args):
        return {"event": {**COFFEE, "mine": False}}

    async def run(script, *args, **_kw):
        ran.append(args)
        return ""

    hub = make_hub(settings, quiet_speaker, isolated)
    s = scheduling.Scheduler(hub, run=run, lookup=lookup, event_at=theirs)
    out = await s.invite({"title": "Coffee", "start": "2026-10-01T15:00", "invitees": ["Ann"]})
    assert out["is_error"] and "someone else's invitation" in out["content"][0]["text"]

    async def mine(_args):
        return {"event": dict(COFFEE)}

    s.event_at = mine
    pending = asyncio.create_task(s.invite({"title": "Coffee", "start": "x", "invitees": ["Ann"]}))
    hub.resolve((await card_on(hub))["id"], "deny")
    assert (await pending)["is_error"] and ran == []


# ── a time for everyone ──


def gcal_tool(schema):
    return SimpleNamespace(name="query_free_busy", input_schema=schema)


GOOGLE_SCHEMA = {
    "type": "object",
    "properties": {
        "timeMin": {"type": "string"},
        "timeMax": {"type": "string"},
        "items": {"type": "array", "items": {"type": "object"}},
    },
}


def test_free_busy_arguments_follow_the_tools_own_schema():
    start, end = datetime(2026, 10, 1, 9, 0).astimezone(), datetime(2026, 10, 2, 9, 0).astimezone()
    args = scheduling.freebusy_args(GOOGLE_SCHEMA, ["ann@x.com"], start, end)
    assert args["items"] == [{"id": "ann@x.com"}] and args["timeMin"].endswith("Z")
    flat = {
        "properties": {
            "start_time": {},
            "end_time": {},
            "emails": {"type": "array", "items": {"type": "string"}},
        }
    }
    assert scheduling.freebusy_args(flat, ["a@x", "b@y"], start, end)["emails"] == ["a@x", "b@y"]
    assert scheduling.freebusy_args({"properties": {"query": {}}}, ["a@x"], start, end) is None


def test_busy_times_are_read_from_googles_answer():
    answer = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "calendars": {
                            "ann@x.com": {
                                "busy": [
                                    {"start": "2026-10-01T16:00:00Z", "end": "2026-10-01T17:00:00Z"}
                                ]
                            },
                            "bob@y.com": {"errors": [{"reason": "notFound"}], "busy": []},
                        }
                    }  # fmt: skip
                ),
            }
        ]
    }
    busy = scheduling.busy_from(answer, ["ann@x.com", "bob@y.com"])
    assert busy["bob@y.com"] is None
    begin, end = busy["ann@x.com"][0]
    assert (end - begin) == timedelta(hours=1) and begin.tzinfo is None
    assert scheduling.busy_from({"content": [{"type": "text", "text": "no json"}]}, ["a@x"]) == {}


async def test_a_meeting_time_leaves_out_everyones_busy_times(settings, quiet_speaker, isolated):
    calls = []
    today = datetime(2026, 9, 29, 8, 0)
    ann_busy = (today.replace(hour=9).astimezone(), today.replace(hour=12).astimezone())

    class Live:
        status = "connected"
        tools = [gcal_tool(GOOGLE_SCHEMA)]

        async def call(self, name, args):
            calls.append((name, args))
            text = json.dumps({"calendars": {"ann@x.com": {"busy": [
                {"start": ann_busy[0].isoformat(), "end": ann_busy[1].isoformat()}]}}})  # fmt: skip
            return {"content": [{"type": "text", "text": text}]}

    async def events(offset, days):
        return [
            {
                "begin": today.replace(hour=13),
                "end": today.replace(hour=17),
                "all_day": False,
                "title": "x",
            }
        ]

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.connectors.live["gcal"] = Live()
    s = scheduling.Scheduler(hub, events=events, lookup=lookup, now=lambda: today)
    out = await s.meeting_time(
        {"people": ["Ann", "Zed"], "duration_minutes": 60, "within_days": 1, "limit": 2}
    )
    text = out["content"][0]["text"]
    assert text.startswith(
        "Times when you and Ann Lee are free for 60 minutes:\n- Tue 29 Sep, 12:00 PM – 1:00 PM"
    )
    assert "I couldn't see Zed's calendar: offer Zed these times and ask" in text
    assert calls[0][0] == "query_free_busy" and calls[0][1]["items"] == [{"id": "ann@x.com"}]


async def test_without_a_connector_only_the_owners_calendar_counts(
    settings, quiet_speaker, isolated
):
    async def events(offset, days):
        return []

    hub = make_hub(settings, quiet_speaker, isolated)
    s = scheduling.Scheduler(
        hub, events=events, lookup=lookup, now=lambda: datetime(2026, 9, 29, 8, 0)
    )
    out = await s.meeting_time({"people": ["Ann"], "within_days": 1, "limit": 1})
    text = out["content"][0]["text"]
    assert text.startswith("Times when you are free for 30 minutes:")
    assert "I can only see your own calendars" in text and "offer Ann Lee these times" in text


# ── a conversation's agreed time ──


def test_an_agreed_meeting_is_read_strictly():
    assert delegate.clean_meeting(
        {"start": "2026-10-02T15:00", "minutes": 45, "title": "Lunch"}
    ) == {
        "start": "2026-10-02T15:00",
        "minutes": 45,
        "title": "Lunch",
        "place": "",
    }
    assert delegate.clean_meeting({"start": "2026-10-02"}) is None  # a day isn't a time
    assert delegate.clean_meeting({"start": "2026-10-02T15:00", "minutes": 9999}) is None
    assert delegate.clean_meeting({"start": "2026-09-01T15:00"}, now=NOW) is None  # past
    assert delegate.clean_meeting("Thursday") is None
    assert "meeting" in delegate.system_text(delegate.new_delegation(**SAM, goal="Lunch", now=NOW))


async def test_an_agreed_time_is_handed_on_once_after_the_reply_goes(tmp_path):
    agreed = []
    meeting = {
        "start": "2026-10-02T12:30",
        "minutes": 60,
        "title": "Lunch with Sam",
        "place": "Noma",
    }
    world = World(drafts=[move("Hi Sam, it's Jarvis, Robert's assistant. Lunch Friday?"),
                          {**move("Friday 12:30 at Noma it is."), "meeting": meeting},
                          {**move(None), "meeting": meeting}])  # fmt: skip
    engine = engine_for(tmp_path, world)
    engine.on_agreed = lambda d: agreed.append(dict(d.meeting))
    d, _ = await start(engine)
    world.they_say("Friday 12:30 at Noma works")
    await engine.step()
    assert agreed == [meeting] and d.meeting == meeting and d.booked == ""
    world.they_say("See you then")
    await engine.step()
    assert len(agreed) == 1  # the same time again isn't asked twice
    assert "agreed Fri 2 Oct 12:30" in delegate.summary_line(d)
    engine.note_booking(d.id, "booked")
    reloaded = delegate.DelegationStore(tmp_path / "delegations.json").items[0]
    assert reloaded.meeting == meeting and reloaded.booked == "booked"


async def test_a_held_reply_books_nothing(tmp_path):
    agreed = []
    meeting = {"start": "2026-10-02T12:30", "minutes": 30}
    world = World(
        drafts=[
            move("Hi Sam, it's Jarvis, Robert's assistant."),
            {**move("Deal, 12:30."), "meeting": meeting},
        ]
    )
    engine = engine_for(tmp_path, world)
    engine.on_agreed = lambda d: agreed.append(d.meeting)
    await start(engine)
    world.approve = False  # the owner holds the confirmation back
    world.they_say("12:30 Friday?")
    await engine.step()
    assert agreed == []


async def test_booking_asks_first_and_notes_what_the_owner_said(settings, quiet_speaker, isolated):
    made, alerts = [], []

    async def create(spec):
        made.append(spec)
        return {"created": {"calendar": "Work"}}

    async def events(offset, days):
        return [{"begin": datetime(2026, 10, 2, 12, 0), "end": datetime(2026, 10, 2, 13, 0),
                 "all_day": False, "title": "Dentist"}]  # fmt: skip

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: alerts.append(alert.text)
    d = delegate.new_delegation(**SAM, goal="Lunch", now=NOW)
    d.meeting = {
        "start": "2026-10-02T12:30",
        "minutes": 60,
        "title": "Lunch with Sam",
        "place": "Noma",
    }
    d.transcript = [{"from": "them", "text": "Friday 12:30 works", "at": "2026-09-29T14:05"}]
    hub.delegate.store.add(d)
    s = scheduling.Scheduler(hub, create=create, events=events, now=lambda: NOW)
    hub.delegate.on_agreed = s.agreed
    s.agreed(d)
    card = await card_on(hub)
    assert (
        card["question"] == "Book “Lunch with Sam”, Friday 2 October at 12:30 PM, for 60 minutes?"
    )
    assert "Sam Lee wrote: “Friday 12:30 works”" in card["detail"]
    assert "It overlaps “Dentist” (12:00 PM–1:00 PM)." in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Book", "Don't book"] and made == []
    assert d.booked == "asked"
    hub.resolve(card["id"], "allow")
    await asyncio.gather(*s._booking)
    assert made[0]["title"] == "Lunch with Sam" and made[0]["location"] == "Noma"
    assert made[0]["notes"] == "Arranged by Jarvis with Sam Lee by iMessage."
    assert d.booked == "booked" and alerts == [
        "Booked “Lunch with Sam”, Friday 2 October at 12:30 PM."
    ]

    s.agreed(d)
    hub.resolve((await card_on(hub))["id"], "deny")
    await asyncio.gather(*s._booking)
    assert d.booked == "declined" and len(made) == 1


# ── one gentle nudge ──


async def test_one_nudge_after_a_silence_and_none_after_a_no(tmp_path):
    world = World(drafts=[move("Hi Sam, it's Jarvis, Robert's assistant. Lunch next week?")])
    engine = engine_for(tmp_path, world)
    d, _ = await start(engine, expires_hours=240)
    world.clock += timedelta(hours=23)
    await engine.step()
    assert len(world.delivered) == 1  # not yet: 24 hours by default
    world.clock += timedelta(hours=2)
    outcomes = await engine.step()
    assert outcomes == {d.id: "nudged"}
    assert (
        world.delivered[-1][2] == delegate.NUDGES["en"] and world.cards[-1] == delegate.NUDGES["en"]
    )
    assert d.messages_sent == 2 and not d.nudging
    world.clock += timedelta(days=2)
    await engine.step()
    assert len(world.delivered) == 2  # one nudge per silence, and a nudge isn't nudged
    world.they_say("Sorry, busy week! Thursday?")
    world.drafts = [move("Thursday works. Noon?")]
    await engine.step()
    world.clock += timedelta(hours=25)
    world.approve = False
    await engine.step()
    assert len(world.delivered) == 3 and d.status == "active"  # the owner said no: that's all
    world.clock += timedelta(hours=25)
    await engine.step()
    assert len(world.cards) == 4  # never asked again for the same silence


async def test_no_nudge_when_turned_off_and_a_chinese_one_for_a_chinese_talk(tmp_path):
    world = World(drafts=[move("你好，我是Robert的助手。下周一起吃午饭吗？")])
    engine = engine_for(tmp_path, world)
    engine.nudge_hours = lambda: 0
    await start(engine)
    world.clock += timedelta(days=2)
    await engine.step()
    assert len(world.delivered) == 1
    engine.nudge_hours = lambda: 12
    await engine.step()
    assert world.delivered[-1][2] == delegate.NUDGES["zh"]


async def test_a_nudge_due_at_night_waits_for_the_morning(tmp_path):
    world = World(drafts=[move("Hi Sam, it's Jarvis, Robert's assistant. Lunch next week?")])
    engine = engine_for(tmp_path, world)
    engine.nudge_hours = lambda: 12
    d, _ = await start(engine, expires_hours=240)  # sent at 2 PM
    world.clock += timedelta(hours=12)  # 2 AM: due, but not at this hour
    await engine.step()
    assert len(world.delivered) == 1
    world.clock += timedelta(hours=7)  # 9 AM
    assert await engine.step() == {d.id: "nudged"}
    assert world.delivered[-1][2] == delegate.NUDGES["en"]


def test_a_nudges_card_says_it_is_a_follow_up():
    d = delegate.new_delegation(**SAM, goal="Lunch", now=NOW)
    d.transcript = [{"from": "me", "text": "Lunch?", "at": "2026-09-29T14:00"}]
    d.nudging = True
    question, detail, spoken = delegate.send_card(d, SAM["handle"], delegate.NUDGES["en"])
    assert question == "Send Sam Lee a follow-up?"
    assert detail == f"To Sam Lee ({SAM['handle']}):\n“{delegate.NUDGES['en']}”"
    assert spoken.startswith("Sam Lee hasn't answered. Here's a follow-up:")
    zh = delegate.send_card(d, SAM["handle"], delegate.NUDGES["zh"], "zh")
    assert zh[0] == "要给Sam Lee发一条跟进消息吗？"


async def test_the_feature_wires_the_engine_and_the_setting(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert hub.delegate.on_agreed == hub.scheduler.agreed
    assert hub.delegate.nudge_hours() == 24
    hub.set_feature_prefs({"delegate_nudge_hours": 48})
    assert hub.delegate.nudge_hours() == 48
    hub.set_feature_prefs({"delegate_nudge_hours": 500})  # out of range: kept as it was
    assert hub.delegate.nudge_hours() == 48
    assert "calendar" in hub._feature_servers() and "send_invite" in hub._feature_prompt()
