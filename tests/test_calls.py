"""Calls Jarvis places for the owner about anything: the card the owner says yes to (the goal,
what may be shared, the most it may agree to, whether it may commit), asking the owner
during the call, the live call on the Mac, and what comes of it afterwards. Twilio and Sync
are faked (test_answering's Twilio); nothing is ever placed or sent."""

import asyncio

import pytest
from conftest import FakeClient
from test_answering import Desk

from jarvis import answering
from jarvis.features import calls
from jarvis.hub import Hub
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


# ── 2. asking the owner mid-call ──


class FakeHub:
    """What the live calls use of the hub: cards, heads-ups, speech and events."""

    def __init__(self, desk):
        self.answering = desk
        self.language = "en"
        self.approvals, self._futures = {}, {}
        self.emitted, self.said, self.alerts = [], [], []

    def emit(self, kind, **data):
        self.emitted.append((kind, data))

    def _say(self, text):
        self.said.append(text)

    def notify(self, alert, speak=True):
        self.alerts.append(alert)

    async def request_approval(self, question, detail, choices, context=None, spoken=""):
        approval_id = f"a{len(self._futures)}"
        future = asyncio.get_running_loop().create_future()
        self.approvals[approval_id] = {
            "id": approval_id,
            "question": question,
            "detail": detail,
            "choices": choices,
            "spoken": spoken,
            **(context or {}),
        }
        self._futures[approval_id] = future
        try:
            return await future
        finally:
            self.approvals.pop(approval_id, None)

    def resolve(self, approval_id, choice, feedback=""):
        future = self._futures.get(approval_id)
        if future is None or future.done():
            return False
        future.set_result(f"{choice}:{feedback}" if feedback else choice)
        return True


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def live_call(tmp_path, **mission):
    d = talking(Desk(tmp_path, answers=[True]))
    await d.desk.errand("+14155550188", "Move my dentist appointment to next week.")
    call = d.desk.log.calls[0]
    talk_id = call.talk
    d.twilio.talks[talk_id].update(mission)
    hub = FakeHub(d.desk)
    return d, hub, calls.LiveCalls(hub, clock=lambda: 1_000.0), call, talk_id


async def test_no_call_running_means_no_requests(tmp_path):
    d = talking(Desk(tmp_path))
    live = calls.LiveCalls(FakeHub(d.desk))
    sent = len(d.twilio.sent)
    assert await live.look() is False
    assert len(d.twilio.sent) == sent


async def test_a_question_on_the_call_asks_the_owner_at_once_and_the_answer_goes_in(tmp_path):
    d, hub, live, call, talk_id = await live_call(
        tmp_path,
        turns=[{"who": "them", "text": "Can we do Tuesday instead?"}],
        ask={"q": "Can we do Tuesday instead?", "at": 0, "n": 1},
    )
    assert await live.look() is True
    await settle()
    [card] = hub.approvals.values()
    assert card["question"] == "The call to (415) 555-0188 needs you"
    assert "They asked: “Can we do Tuesday instead?”" in card["detail"]
    assert card["ask_kind"] == "call_ask" and card["free_choices"] == ["answer"]
    assert [c[0] for c in card["choices"]] == ["allow", "deny", "later"]
    assert hub.said == [
        "The call to (415) 555-0188 needs you. They're asking: Can we do Tuesday instead?"
    ]
    await live.look()  # the same question: one card
    await settle()
    assert len(hub.approvals) == 1
    hub.resolve(card["id"], "answer", "Tuesday at 3 works, not earlier.")
    await settle()
    assert d.twilio.tells[talk_id] == {
        "notes": [{"n": 1_000_000, "kind": "answer", "text": "Tuesday at 3 works, not earlier."}]
    }


@pytest.mark.parametrize(
    ("choice", "feedback", "note"),
    [
        ("allow", "", {"kind": "answer", "text": "Yes."}),
        ("deny", "", {"kind": "answer", "text": "No."}),
        ("deny", "Not Tuesdays", {"kind": "answer", "text": "Not Tuesdays"}),
        ("later", "", {"kind": "later", "text": ""}),
    ],
)
async def test_the_card_s_buttons_answer_the_call(tmp_path, choice, feedback, note):
    d, hub, live, _call, talk_id = await live_call(tmp_path, ask={"q": "Tuesday?", "at": 0, "n": 1})
    await live.look()
    await settle()
    hub.resolve(next(iter(hub.approvals)), choice, feedback)
    await settle()
    [sent] = d.twilio.tells[talk_id]["notes"]
    assert {"kind": sent["kind"], "text": sent["text"]} == note


async def test_once_the_call_stops_waiting_the_card_comes_down_with_nothing_sent(tmp_path):
    d, hub, live, _call, talk_id = await live_call(tmp_path, ask={"q": "Tuesday?", "at": 0, "n": 1})
    await live.look()
    await settle()
    assert hub.approvals
    d.twilio.talks[talk_id]["ask"] = None  # the Function said you'd call back
    d.twilio.talks[talk_id]["done"] = True
    await live.look()
    await settle()
    assert hub.approvals == {} and talk_id not in d.twilio.tells


async def test_a_card_number_typed_as_the_answer_is_never_passed_on(tmp_path):
    d, hub, live, _call, talk_id = await live_call(tmp_path, ask={"q": "Card?", "at": 0, "n": 1})
    await live.look()
    await settle()
    hub.resolve(next(iter(hub.approvals)), "answer", "4111 1111 1111 1111")
    await settle()
    assert talk_id not in d.twilio.tells
    [alert] = hub.alerts
    assert "a full card number never goes on a call I make" in alert.text


def test_the_hub_follows_live_calls(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert isinstance(hub.live_calls, calls.LiveCalls)
    assert "calls_live" in [name for name, _factory in hub._loops]
