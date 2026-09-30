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
    """Cards going up and answers going out (through a worker thread) have happened."""
    for _ in range(10):
        await asyncio.sleep(0.01)


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


# ── 3. the live call on the Mac ──


async def test_the_panel_shows_the_live_transcript_and_what_the_call_is_waiting_on(tmp_path):
    d, hub, live, call, _talk = await live_call(
        tmp_path,
        turns=[
            {"who": "them", "text": "Dr. Lee's office."},
            {"who": "jarvis", "text": "Hi, this is Jarvis, an AI assistant calling for Bilel."},
            {"who": "note", "text": "Silence: nothing was said."},
        ],
        ask={"q": "Is Tuesday at 3 OK?", "at": 0, "n": 1},
    )
    await live.look()
    await settle()
    [(kind, event)] = [e for e in hub.emitted if e[0] == "call_live"][-1:]
    [shown] = event["calls"]
    assert shown["id"] == call.id and shown["who"] == "(415) 555-0188"
    assert shown["status"] == "asking" and shown["asking"] == "Is Tuesday at 3 OK?"
    assert [t["who"] for t in shown["turns"]] == ["them", "jarvis"]  # the Function's notes stay out
    assert shown["can_take_over"] is True and shown["yours"] is False
    d.desk.log.calls[0].status = "done"  # over
    await live.look()
    assert hub.emitted[-1] == ("call_live", {"calls": []})


async def test_tell_it_joins_the_next_turn_and_an_answer_brings_the_card_down(tmp_path):
    d, hub, live, call, talk_id = await live_call(tmp_path)
    await live.look()
    await live.command({"type": "call_tell", "id": call.id, "text": "Ask about a refund too."})
    assert hub.emitted[-1] == ("call_note", {"id": call.id, "note": "Passed on."})
    assert d.twilio.tells[talk_id]["notes"][-1]["kind"] == "tell"
    d.twilio.talks[talk_id]["ask"] = {"q": "Tuesday?", "at": 0, "n": 1}
    await live.look()
    await settle()
    assert hub.approvals
    await live.command({"type": "call_answer", "id": call.id, "choice": "answer", "text": "Yes"})
    await settle()
    assert hub.approvals == {}
    assert d.twilio.tells[talk_id]["notes"][-1] == {"n": 1_000_001, "kind": "answer", "text": "Yes"}
    await live.command({"type": "call_tell", "id": "CA-gone", "text": "Hello?"})
    assert hub.emitted[-1] == ("call_note", {"id": "CA-gone", "note": "That call is over."})


async def test_hang_up_ends_the_call_and_says_so_afterwards(tmp_path):
    d, hub, live, call, _talk = await live_call(tmp_path)
    d.twilio.statuses[call.id] = "in-progress"
    await live.command({"type": "call_hangup", "id": call.id})
    assert d.twilio.updates == [(call.id, {"Status": "completed"})]
    d.twilio.statuses[call.id] = "completed"
    [done] = await d.desk.check()
    assert done.status == "partial" and done.words == "You hung up the call."


async def test_take_over_puts_the_owner_s_own_phone_through(tmp_path):
    d, hub, live, call, talk_id = await live_call(tmp_path)
    d.twilio.statuses[call.id] = "in-progress"
    await live.look()
    await live.command({"type": "call_takeover", "id": call.id})
    assert hub.emitted[-1][1]["note"] == (
        "Putting you through to (415) 555-0188. Your phone will ring."
    )
    [(sid, data)] = d.twilio.updates
    twiml = data["Twiml"]
    assert sid == call.id
    assert "putting you through to Bilel now.</Say>" in twiml
    assert '<Dial callerId="+16504182384" timeout="25"' in twiml
    assert f"step=back&amp;t={talk_id}" in twiml
    assert "<Number>+14155550199</Number>" in twiml
    assert live.public()[0]["yours"] is True
    assert live.activity(f"voicemail:{call.id[-8:]}") == ("(415) 555-0188", "yours", False)


async def test_take_over_needs_the_owner_s_number(tmp_path):
    d, hub, live, call, _talk = await live_call(tmp_path)
    d.p.phone_me = ""
    await live.command({"type": "call_takeover", "id": call.id})
    assert "Add your own number under Settings › Phone" in hub.emitted[-1][1]["note"]
    assert d.twilio.updates == []


async def test_the_phone_s_live_activity_shows_when_the_call_needs_the_owner(tmp_path):
    d, hub, live, call, talk_id = await live_call(tmp_path)
    await live.look()
    assert live.activity(f"call:voicemail:{call.id[-8:]}") == ("(415) 555-0188", "calling", False)
    d.twilio.talks[talk_id]["ask"] = {"q": "Tuesday?", "at": 0, "n": 1}
    await live.look()
    assert live.activity(call.id[-8:]) == ("(415) 555-0188", "asking", True)
    assert live.activity("voicemail:someone") is None
    from jarvis.companion_live import Live

    hub.prefs, hub.live_calls = d.p, live
    fake = type("Companion", (), {"hub": hub})()
    state, over = Live(fake, sender=None, clock=lambda: 0).state_for(
        f"call:voicemail:{call.id[-8:]}", 0, 10
    )
    assert (state["title"], state["status"], state["needsYou"], over) == (
        "(415) 555-0188",
        "Needs you",
        True,
        False,
    )
    assert "Tuesday" not in str(state)  # never what was said


async def test_a_call_going_out_starts_the_phone_s_live_activity_quietly(tmp_path):
    d = talking(Desk(tmp_path, answers=[True]))
    hub = FakeHub(d.desk)
    d.desk.placed = calls.LiveCalls(hub).placed
    await d.desk.errand("+14155550188", "Ask if they're open Sunday.")
    [alert] = hub.alerts
    assert alert.key == f"voicemail:{d.desk.log.calls[0].id[-8:]}"
    assert (alert.title, alert.text) == ("Call for you", "Calling (415) 555-0188 now.")


async def test_jarvis_passes_on_the_owner_s_words_and_asks_when_they_did_not_say_to(tmp_path):
    d, hub, live, call, talk_id = await live_call(tmp_path)
    await live.look()
    asked = []

    async def ask_user(question, detail=""):
        asked.append((question, detail))
        return False

    hub._ask_user = ask_user
    hub._turn_text = "tell them Tuesday at 3 works"
    said = await calls_tool(live)({"text": "Tuesday at 3 works."})
    assert said["content"][0]["text"] == "Passed on." and asked == []
    assert d.twilio.tells[talk_id]["notes"][-1]["text"] == "Tuesday at 3 works."
    hub._turn_text = "what's the weather"
    said = await calls_tool(live)({"text": "Share the card."})
    assert said.get("is_error") and asked == [
        ("Pass this to the call with (415) 555-0188?", "“Share the card.”")
    ]


def calls_tool(live):
    """tell_call's handler, as the brain would run it."""
    captured = {}
    original = calls.create_sdk_mcp_server

    def grab(name, version, tools):
        captured["tools"] = tools
        return original(name=name, version=version, tools=tools)

    calls.create_sdk_mcp_server = grab
    try:
        live.build_server()
    finally:
        calls.create_sdk_mcp_server = original
    [tool] = captured["tools"]
    return tool.handler


# ── 5. afterwards ──


async def finished(tmp_path, outcome, agreed=None, answers=(True,)):
    d = talking(Desk(tmp_path, answers=[True]))
    hub = FakeHub(d.desk)
    live = calls.LiveCalls(hub)
    added = []

    async def add_reminder(spec):
        added.append(spec)
        return {"added": {"title": spec["title"]}}

    live.add_reminder = add_reminder
    d.desk.agreed = live.agreed
    await d.desk.errand(
        "+14155550188", "Move my dentist appointment to next week.", limits={"commit": True}
    )
    call = d.desk.log.calls[0]
    mission = d.twilio.talks[call.talk]
    mission["outcome"] = outcome
    if agreed is not None:
        mission["agreed"] = agreed
    d.twilio.statuses[call.id] = "completed"
    [done] = await d.desk.check()
    return d, hub, done, added


async def answer_cards(hub, *choices):
    for choice in choices:
        await settle()
        [card] = hub.approvals.values()
        hub.resolve(card["id"], choice)
    await settle()


async def test_the_heads_up_says_what_came_of_it_and_what_is_left(tmp_path):
    d, hub, done, _added = await finished(
        tmp_path,
        {
            "status": "done",
            "start": "",
            "details": "Moved to Tuesday October 6th at 3 PM with Dr. Lee.",
            "next": "Bring the new insurance card",
        },
        agreed=[{"what": "Dentist with Dr. Lee", "amount": 0, "start": "2026-10-06T15:00:00"}],
    )
    assert d.heard[-1][1] == (
        "The call to (415) 555-0188 is done: Moved to Tuesday October 6th at 3 PM with Dr. "
        "Lee. Next: Bring the new insurance card."
    )
    assert done.next == "Bring the new insurance card"


async def test_a_time_agreed_goes_in_the_calendar_and_what_is_left_in_reminders_each_on_a_yes(
    tmp_path,
):
    d, hub, _done, added = await finished(
        tmp_path,
        {"status": "done", "start": "", "details": "Moved.", "next": "Bring the insurance card"},
        agreed=[{"what": "Dentist with Dr. Lee", "amount": 0, "start": "2026-10-06T15:00:00"}],
    )
    await settle()
    [card] = hub.approvals.values()
    assert card["question"] == "Add “Dentist with Dr. Lee” to your calendar?"
    assert "Tuesday, October 6th, at 3 PM" in card["detail"]
    await answer_cards(hub, "allow")
    assert "Dentist with Dr. Lee" in d.scripts[-1]
    [card] = hub.approvals.values()
    assert card["question"] == "Add a reminder for what's left?"
    await answer_cards(hub, "allow")
    assert added[0]["title"] == "Bring the insurance card"
    assert [a.text for a in hub.alerts] == [
        "Added “Dentist with Dr. Lee” to your Work calendar.",
        "Added it to Reminders.",
    ]


async def test_nothing_goes_anywhere_on_a_no(tmp_path):
    d, hub, _done, added = await finished(
        tmp_path,
        {"status": "done", "start": "", "details": "Moved.", "next": "Call the office Friday"},
        agreed=[{"what": "Dentist", "amount": 0, "start": "2026-10-06T15:00:00"}],
    )
    await answer_cards(hub, "deny", "deny")
    assert d.scripts == [] and added == [] and hub.approvals == {}


async def test_an_untimed_agreement_or_none_puts_up_no_calendar_card(tmp_path):
    _d, hub, _done, _added = await finished(
        tmp_path,
        {"status": "done", "start": "", "details": "Cancelled the plan.", "next": ""},
        agreed=[{"what": "Cancel the plan", "amount": 0, "start": ""}],
    )
    await settle()
    assert hub.approvals == {}
