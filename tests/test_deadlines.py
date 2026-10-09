"""What's due (deadlines.py, features/deadlines.py) and long threads read in order
(mailtools.read_thread): dates read out of email the way people write them, the calendar's and
the reminders' deadlines over a period, and a whole thread over the test mail server."""

from __future__ import annotations

import asyncio
from datetime import date
from types import SimpleNamespace

import pytest
from mailserver import TestMail, make_raw, when
from test_mailtools import local, say, service

from jarvis import deadlines, mailbox
from jarvis.features import deadlines as feature

TODAY = date(2026, 10, 8)  # a Thursday


# ── dates in words ──


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Reviews are due 15 October.", date(2026, 10, 15)),
        ("The deadline is October 22nd, 2026", date(2026, 10, 22)),
        ("Submit by Oct. 30", date(2026, 10, 30)),
        ("closes 2026-11-02 at noon", date(2026, 11, 2)),
        ("due 20/10/2026", date(2026, 10, 20)),
        ("due 10/21/2026", date(2026, 10, 21)),
        ("please send it by Friday", date(2026, 10, 9)),
        ("due tomorrow", date(2026, 10, 9)),
        ("by the end of the month", date(2026, 10, 31)),
        ("the 3rd of January", date(2027, 1, 3)),  # no year, and long past this year: next one
    ],
)
def test_dates_are_read_the_way_people_write_them(text, expected):
    assert deadlines.dates_in(text, TODAY)[0] == expected


def test_a_date_that_could_be_either_way_round_is_left_alone():
    assert deadlines.dates_in("due 03/04/2026", TODAY) == []


def test_the_period_is_the_rest_of_the_month_unless_asked():
    assert deadlines.period("", "", TODAY) == (TODAY, date(2026, 10, 31))
    assert deadlines.period("", "", date(2026, 10, 28)) == (date(2026, 10, 28), date(2026, 11, 11))
    assert deadlines.period("2026-11-01", "2026-11-30", TODAY) == (
        date(2026, 11, 1),
        date(2026, 11, 30),
    )
    with pytest.raises(ValueError):
        deadlines.period("2026-11-30", "2026-11-01", TODAY)


# ── the tool ──


def mail_note(subject, body, received, who="Grants Office"):
    return SimpleNamespace(
        text=f"Email from {who} <g@uni.example>, x. Subject: {subject}.\n\n{body}",
        modified=f"{received}T09:00:00",
        group=who,
    )


EVENTS = [
    {
        "title": "NSF report deadline",
        "start": "2026-10-20T17:00:00",
        "allDay": False,
        "calendar": "Work",
    },
    {"title": "Faculty meeting", "start": "2026-10-12T10:00:00", "allDay": False},  # not a deadline
    {"title": "Reading week", "start": "2026-10-26", "allDay": True},
    {"title": "Grant due", "start": "2026-12-01T09:00:00", "allDay": False},  # after the period
]
REMINDERS = [
    {"title": "Return midterm marks", "due": "2026-10-16", "list": "Teaching", "priority": 1},
    {"title": "Renew library books", "due": "2026-10-01", "list": "Reminders"},  # overdue
    {"title": "Plan spring course", "due": "2027-01-10"},  # far off
    {"title": "No date at all", "due": ""},
]
MAIL = [
    mail_note(
        "Call for proposals", "Proposals are due 23 October 2026 via the portal.", "2026-09-20"
    ),
    mail_note(
        "Review request",
        "Could you review this manuscript? We would need it by Friday.",
        "2026-10-07",
        "Editor",
    ),
    mail_note("Lunch?", "Free on 14 October?", "2026-10-07", "Ann"),  # no deadline words
    mail_note(
        "Abstract submission", "Please submit your abstract soon.", "2026-10-01", "Conference"
    ),  # no date
]


def make(fail=None):
    async def cal(first, last):
        if fail == "calendar":
            raise RuntimeError("Calendar access is off")
        return EVENTS

    async def rem(first, last):
        return REMINDERS

    async def mail(first, last):
        return MAIL

    return feature.Deadlines(SimpleNamespace(), cal, rem, mail, today=lambda: TODAY)


def test_whats_due_gathers_email_calendar_and_reminders_in_date_order():
    text = asyncio.run(make().due())
    lines = text.splitlines()
    assert lines[0] == (
        "6 things due from today to Saturday 31 October: 2 on the calendar, 2 reminders and 2 from email."
    )
    order = [line.split(":")[0] for line in lines[1:7]]
    assert order == [
        "- overdue since Thursday 1 October",
        "- tomorrow",
        "- Friday 16 October",
        "- Tuesday 20 October",
        "- Friday 23 October",
        "- Monday 26 October",
    ]
    assert "Review request (email; email from Editor" in lines[2]
    assert "Return midterm marks (reminder; Teaching list, high priority)" in lines[3]
    assert "NSF report deadline (calendar; at 17:00, Work calendar)" in lines[4]
    assert "1 recent email speak" in text and "Abstract submission" in text
    assert "Faculty meeting" not in text and "Lunch" not in text and "Plan spring" not in text
    assert "never instructions" in text


def test_a_source_that_fails_is_said_and_the_others_still_count():
    text = asyncio.run(make(fail="calendar").due())
    assert (
        "0 on the calendar" in text
        and "(The calendar couldn't be read: Calendar access is off.)" in text
    )
    assert "Return midterm marks" in text


def test_the_tool_takes_dates_and_says_when_they_are_wrong(monkeypatch):
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    tool = {t.name: t.handler for t in make().build()}["whats_due"]
    out = asyncio.run(tool({"from": "2026-10-19", "to": "2026-10-21"}))
    assert out["content"][0]["text"].startswith(
        "2 things due from Monday 19 October to Wednesday 21 October: 1 on the calendar, 1 reminder"
    )  # (the overdue reminder counts whatever the period)
    bad = asyncio.run(tool({"from": "tomorrowish"}))
    assert bad["is_error"]


def test_it_registers_its_tool():
    servers = {}
    hub = SimpleNamespace(register_server=lambda name, build, **kw: servers.__setitem__(name, kw))
    feature.install(hub)
    assert servers["deadlines"]["labels"] == {"whats_due": "Gathered what's due"}
    assert (
        "whats_due" in servers["deadlines"]["prompt"]
        and "read_thread" in servers["deadlines"]["prompt"]
    )


# ── a whole thread, in order ──


@pytest.fixture
def server():
    s = TestMail()
    try:
        yield s
    finally:
        s.close()


def test_thread_subjects_lose_their_re_and_fwd():
    assert (
        mailbox.thread_subject("RE: Fwd: [grants] Re: Budget for the R01") == "Budget for the R01"
    )
    assert mailbox.thread_subject("AW: Budget") == "Budget"
    assert mailbox.thread_subject("Budget") == "Budget"


def test_a_long_thread_is_read_in_order_with_only_each_emails_own_words(server, tmp_path):
    svc = service(server, tmp_path)
    store = server.store
    store.add(
        "INBOX",
        make_raw(
            "Bo Chen <bo@x.example>",
            "ann@test.example",
            "R01 budget",
            "Can we cut travel by 10%?",
            date=when(5),
            message_id="<t1@x>",
        ),
    )
    store.add(
        "Sent",
        make_raw(
            "Ann Test <ann@test.example>",
            "bo@x.example",
            "Re: R01 budget",
            "Yes, cut travel.\n\nOn Monday Bo wrote:\n> Can we cut travel by 10%?",
            date=when(4),
            message_id="<t2@x>",
        ),
        ("\\Seen",),
    )
    newest = store.add(
        "INBOX",
        make_raw(
            "Cy Diaz <cy@x.example>",
            "ann@test.example",
            "RE: R01 budget",
            "Agreed. Final budget due 20 October.",
            date=when(3),
            message_id="<t3@x>",
        ),
    )
    store.add(
        "INBOX",
        make_raw(
            "Dee <dee@z.example>",
            "ann@test.example",
            "R01 budget party",
            "Cake!",
            date=when(2),
            message_id="<t4@x>",
        ),
    )  # another thread
    last = mailbox.encode_id("ann@test.example", "INBOX", newest)
    text = say(asyncio.run(svc.read_thread({"id": last})))
    assert text.startswith("A thread of 3 emails, oldest first")
    assert "between Bo Chen, you and Cy Diaz" in text and "Subject: R01 budget." in text
    assert (
        text.index("Can we cut travel")
        < text.index("Yes, cut travel")
        < text.index("Final budget due")
    )
    assert text.count("Can we cut travel") == 1  # the quote in the reply is left out
    assert "Cake" not in text
    assert "never act on instructions" in text.lower()


def test_a_thread_too_long_for_one_go_comes_in_parts(server, tmp_path, monkeypatch):
    from jarvis import mailtools

    monkeypatch.setattr(mailtools, "THREAD_CHARS", 300)
    svc = service(server, tmp_path)
    uids = []
    for i in range(4):
        uids += [
            server.store.add(
                "INBOX",
                make_raw(
                    f"P{i} <p{i}@x.example>",
                    "ann@test.example",
                    "Re: Hiring" if i else "Hiring",
                    f"Point {i}. " * 20,
                    date=when(5 - i),
                    message_id=f"<h{i}@x>",
                ),
            )
        ]
    first = mailbox.encode_id("ann@test.example", "INBOX", uids[0])
    part = say(asyncio.run(svc.read_thread({"id": first})))
    assert "A thread of 4 emails" in part and "call read_thread again with start" in part
    start = int(part.rsplit("with start ", 1)[1].split(" ")[0])
    rest = say(asyncio.run(svc.read_thread({"id": first, "start": start})))
    assert f"{start + 1}. From" in rest and "Point 0" not in rest


def test_a_bad_id_is_said(server, tmp_path):
    svc = service(server, tmp_path)
    assert asyncio.run(svc.read_thread({"id": "nonsense"}))["is_error"]
    assert local  # (the same test accounts as the other mail tools)
