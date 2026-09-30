"""Calls Jarvis places for the owner about anything: the card the owner says yes to (the goal,
what may be shared, the most it may agree to, whether it may commit), asking the owner
during the call, the live call on the Mac, and what comes of it afterwards. Twilio and Sync
are faked (test_answering's Twilio); nothing is ever placed or sent."""

import pytest
from test_answering import Desk

from jarvis import answering
from jarvis.phone import PhoneError

KEY = "test-claude-key"  # not in a real key's format


def talking(d):
    d.on()
    d.key = KEY
    d.desk.log.line["talk_key"] = answering.fingerprint(KEY)
    return d


# ── 1. the card ──


async def test_the_card_shows_the_goal_what_may_be_shared_the_limits_and_the_rest_off_limits(
    tmp_path,
):
    d = talking(Desk(tmp_path, answers=[True]))
    said = await d.desk.errand(
        "+14155550188",
        "Cancel the internet plan and get the cancellation in writing.",
        {"What you may tell them": "Account 88123456, under Bilel Harrat."},
        limits={
            "commit": True,
            "max_amount": 25,
            "currency": "$",
            "earliest": "2026-10-02",
            "latest": "2026-10-31",
        },
    )
    assert said.startswith("Calling (415) 555-0188 now.")
    question, detail, _spoken = d.cards[0]
    assert question == "Call (415) 555-0188 for you?"
    assert "(415) 555-0188" in detail and "Cancel the internet plan" in detail
    assert "Account 88123456" in detail
    assert "Everything else about you is off limits." in detail
    assert "It may agree for you, up to $25 in total, for dates from 2026-10-02 to 2026-10-31." in (
        detail
    )
    assert "never gives card numbers, passwords, Social Security numbers or codes" in detail
    [mission] = d.twilio.talks.values()
    assert mission["limits"] == {
        "commit": True,
        "max_amount": 25.0,
        "currency": "$",
        "earliest": "2026-10-02",
        "latest": "2026-10-31",
    }


async def test_without_leave_to_commit_the_card_says_it_only_gathers_options(tmp_path):
    d = talking(Desk(tmp_path, answers=[True]))
    await d.desk.errand("+14155550188", "Find out what a cheaper plan would cost.")
    _q, detail, _s = d.cards[0]
    assert "It only finds out the options and reports back: it agrees to nothing." in detail
    [mission] = d.twilio.talks.values()
    assert mission["limits"]["commit"] is False and mission["limits"]["max_amount"] == 0


@pytest.mark.parametrize(
    ("details", "why"),
    [
        ({"Card": "4111 1111 1111 1111"}, "A full card number"),
        ({"Me": "SSN 123-45-6789"}, "A Social Security number"),
        ({"Login": "password: hunter22"}, "A password, PIN or code"),
    ],
)
async def test_secrets_never_go_on_the_card(tmp_path, details, why):
    d = talking(Desk(tmp_path, answers=[True]))
    with pytest.raises(PhoneError, match=why):
        await d.desk.errand("+14155550188", "Pay the bill.", details)
    assert d.cards == [] and d.twilio.placed == []


def test_limits_are_read_safely():
    assert answering.call_limits(None) == {
        "commit": False,
        "max_amount": 0.0,
        "currency": "$",
        "earliest": "",
        "latest": "",
    }
    assert answering.call_limits({"max_amount": "lots", "commit": "yes"})["commit"] is False
    assert answering.call_limits({"max_amount": -5})["max_amount"] == 0
    with pytest.raises(PhoneError, match="date like"):
        answering.call_limits({"earliest": "next week"})
    with pytest.raises(PhoneError, match="after the latest"):
        answering.call_limits({"earliest": "2026-10-09", "latest": "2026-10-01"})
    assert answering.sensitive("order 5512 3345, card ending 4242") == ""


async def test_a_reservation_may_commit_to_that_day_and_no_payment(tmp_path):
    d = talking(Desk(tmp_path, answers=[True]))
    await d.desk.reserve("Nobu", "+16505550110", "2026-10-02T19:30", 2)
    [mission] = d.twilio.talks.values()
    assert mission["limits"] == {
        "commit": True,
        "max_amount": 0.0,
        "currency": "$",
        "earliest": "2026-10-02",
        "latest": "2026-10-02",
    }
    assert "It may agree for you, for 2026-10-02 only, but to no payment." in d.cards[0][1]
