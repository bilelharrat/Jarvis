"""JARVIS removes calendar events: the one event asked for, only after a yes on a card that
shows the event itself (its calendar, whether it repeats, who else may hear of it)."""

from datetime import date, datetime

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext

from jarvis import brain, calendar_kit, lang, mac_tools


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
    """The helper, faked: what starts when, and what was removed."""
    state = {"events": [], "removed": [], "error": ""}

    async def events_at(start):
        if state["error"]:
            return {"error": state["error"]}
        return {"events": [e for e in state["events"] if e["begin"].startswith(start)]}

    async def remove_at(start, event_id, cal, future):
        state["removed"].append((start, event_id, cal, future))
        return {"removed": {}, "span": "future" if future else "this"}

    monkeypatch.setattr(calendar_kit, "events_at", events_at)
    monkeypatch.setattr(calendar_kit, "remove_at", remove_at)
    monkeypatch.setattr(mac_tools, "_today", lambda: date(2026, 9, 29))  # a Tuesday
    return state


def test_the_title_asked_for_picks_the_event():
    rows = [row("Dentist appointment"), row("Standup", calendar="Work")]
    assert [r["title"] for r in calendar_kit.choose(rows, "  dentist   APPOINTMENT ")] == [
        "Dentist appointment"
    ]
    assert [r["title"] for r in calendar_kit.choose(rows, "dentist")] == ["Dentist appointment"]
    assert calendar_kit.choose(rows, "Lunch") == [] and calendar_kit.choose(rows, "") == []
    both = [row("Review", calendar="Work"), row("Review", calendar="Home")]
    assert len(calendar_kit.choose(both, "Review")) == 2  # never picks one itself
    assert [r["calendar"] for r in calendar_kit.choose(both, "Review", "work")] == ["Work"]
    # An exact title wins over a loose one ("Review" isn't "Review prep").
    assert [
        r["title"] for r in calendar_kit.choose([row("Review"), row("Review prep")], "review")
    ] == ["Review"]


def test_a_start_is_a_minute_or_a_day():
    assert calendar_kit.when("2026-09-30T15:00") == (datetime(2026, 9, 30, 15, 0), False)
    assert calendar_kit.when("2026-09-30T15:00:42") == (datetime(2026, 9, 30, 15, 0), False)
    assert calendar_kit.when("2026-09-30") == (datetime(2026, 9, 30), True)
    with pytest.raises(ValueError):
        calendar_kit.when("tomorrow at 3")


async def test_the_card_shows_the_event_itself(calendar):
    calendar["events"] = [row()]
    question, why = await mac_tools.removal_question(
        {"title": "dentist", "start": "2026-09-30T15:00"}
    )
    assert (
        why == "" and question == "Remove “Dentist”, tomorrow at 3:00 PM, from the Home calendar?"
    )


async def test_a_repeating_event_says_how_much_goes(calendar):
    calendar["events"] = [row("Standup", repeats=True)]
    args = {"title": "Standup", "start": "2026-09-30T15:00"}
    assert "only this one goes" in (await mac_tools.removal_question(args))[0]
    assert "every later one go" in (await mac_tools.removal_question({**args, "future": True}))[0]


async def test_a_meeting_says_who_may_hear_of_it(calendar):
    people = ["Ann Lee", "Ben Chu", "Cy Wu", "Di Ng", "Ed Fox"]
    calendar["events"] = [row("Planning", attendees=people)]
    question, _ = await mac_tools.removal_question(
        {"title": "Planning", "start": "2026-09-30T15:00"}
    )
    assert (
        "Others are in it (Ann Lee, Ben Chu, Cy Wu and 2 more): they may be told it's cancelled."
        in question
    )
    calendar["events"] = [
        row("Offsite", mine=False, organizer="Maya Park", attendees=["Maya Park"])
    ]
    question, _ = await mac_tools.removal_question(
        {"title": "Offsite", "start": "2026-09-30T15:00"}
    )
    assert question.endswith("It's Maya Park's invitation: they may be told you declined.")


async def test_an_all_day_event_is_named_by_its_day(calendar):
    calendar["events"] = [row("Holiday", begin="2026-10-02T00:00", all_day=True)]
    question, _ = await mac_tools.removal_question({"title": "Holiday", "start": "2026-10-02"})
    assert question == "Remove the all-day “Holiday”, Friday 2 October, from the Home calendar?"


@pytest.mark.parametrize(
    ("events", "args", "said"),
    [
        ([], {"title": "Dentist"}, "Nothing called “Dentist” starts at"),
        (
            [row("Review", calendar="Work"), row("Review")],
            {"title": "Review"},
            "More than one event",
        ),
        (
            [row("Holiday", writable=False, calendar="US Holidays")],
            {"title": "Holiday"},
            "can't be changed",
        ),
    ],
    ids=["none", "several", "read-only"],
)
async def test_no_card_when_there_isnt_one_event_to_remove(calendar, events, args, said):
    calendar["events"] = events
    question, why = await mac_tools.removal_question({**args, "start": "2026-09-30T15:00"})
    assert question == "" and said in why


async def test_the_policy_asks_with_that_card_and_says_why_when_it_cant(calendar):
    calendar["events"] = [row("Dentist")]
    asked = []

    async def yes(question):
        asked.append(question)
        return True

    ctx = ToolPermissionContext()
    policy = brain.make_permission_policy(yes)
    args = {"title": "Dentist", "start": "2026-09-30T15:00"}
    assert isinstance(await policy("mcp__mac__remove_event", args, ctx), PermissionResultAllow)
    assert asked == ["Remove “Dentist”, tomorrow at 3:00 PM, from the Home calendar?"]

    async def never(_question):
        raise AssertionError("no card without one event to remove")

    missing = await brain.make_permission_policy(never)(
        "mcp__mac__remove_event", {"title": "Lunch", "start": "2026-09-30T15:00"}, ctx
    )
    assert isinstance(missing, PermissionResultDeny) and "Nothing called “Lunch”" in missing.message
    calendar["error"] = calendar_kit.NO_ACCESS
    denied = await brain.make_permission_policy(never)("mcp__mac__remove_event", args, ctx)
    assert isinstance(denied, PermissionResultDeny) and "Calendar access is off" in denied.message


async def test_the_tool_removes_exactly_the_event_the_card_showed(calendar):
    calendar["events"] = [row("Review", calendar="Work"), row("Review prep", calendar="Home")]
    out = await mac_tools.remove_event.handler({"title": "Review", "start": "2026-09-30T15:00"})
    assert (
        out["content"][0]["text"] == "Removed “Review” (2026-09-30 15:00) from the Work calendar."
    )
    assert calendar["removed"] == [("2026-09-30T15:00", "id-Review-Work", "Work", False)]
    calendar["events"] = [row("Standup", repeats=True)]
    out = await mac_tools.remove_event.handler(
        {"title": "Standup", "start": "2026-09-30T15:00", "future": True}
    )
    assert "and every later one" in out["content"][0]["text"] and calendar["removed"][-1][3] is True


async def test_a_removal_the_calendar_refuses_is_said(calendar, monkeypatch):
    calendar["events"] = [row()]

    async def refused(*_a):
        return {"error": "Calendar didn't remove it (the server is offline)."}

    monkeypatch.setattr(calendar_kit, "remove_at", refused)
    out = await mac_tools.remove_event.handler({"title": "Dentist", "start": "2026-09-30T15:00"})
    assert out.get("is_error") and "server is offline" in out["content"][0]["text"]


def test_removing_is_never_allowed_without_asking(tmp_path):
    from dataclasses import replace

    from jarvis.config import Settings

    async def never(_question):
        raise AssertionError("should not ask")

    opts = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert "mcp__mac__remove_event" not in opts.allowed_tools
    assert "removing calendar events" in opts.system_prompt


async def test_the_card_is_said_in_chinese_too(calendar):
    calendar["events"] = [row("Dentist", calendar="Work", repeats=True, attendees=["Ann Lee"])]
    question, _ = await mac_tools.removal_question(
        {"title": "Dentist", "start": "2026-09-30T15:00"}, "zh"
    )
    zh = lang.translate(question, "zh")
    assert zh.startswith("要从“Work”日历删除“Dentist”吗？时间：明天下午3:00。")
    assert "只删除这一次" in zh and "（Ann Lee）" in zh


@pytest.mark.parametrize(
    ("begin", "all_day", "language", "said"),
    [
        ("2026-09-29T12:00", False, "en", "today at 12:00 PM"),
        ("2026-09-30T00:30", False, "en", "tomorrow at 12:30 AM"),
        ("2026-10-02T09:05", False, "en", "Friday 2 October at 9:05 AM"),
        ("2026-10-02T00:00", True, "en", "Friday 2 October"),
        ("2026-09-29T12:00", False, "zh", "今天下午12:00"),
        ("2026-09-30T00:30", False, "zh", "明天上午12:30"),
        ("2026-10-04T18:45", False, "zh", "10月4日（周日）下午6:45"),
        ("2026-10-02T00:00", True, "zh", "10月2日（周五）"),
    ],
)
def test_a_time_is_said_the_way_people_say_it(monkeypatch, begin, all_day, language, said):
    monkeypatch.setattr(mac_tools, "_today", lambda: date(2026, 9, 29))
    assert mac_tools.spoken_when(begin, all_day, language) == said
