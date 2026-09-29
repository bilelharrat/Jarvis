"""Phone calls: the owner's own number through their Twilio account (never anyone else's on
JARVIS's own say-so), capped so nothing runs up a bill; others ring from the iPhone."""

import asyncio
from types import SimpleNamespace
from urllib.parse import parse_qs

import pytest

from jarvis import phone
from jarvis.phone import Phone, PhoneError, clean_number, twiml

SID = "AC" + "0123456789abcdef" * 2
TOKEN = "fedcba9876543210" * 2


@pytest.mark.parametrize(
    ("said", "number"),
    [
        ("(415) 555-0100", "+14155550100"),
        ("1 415 555 0100", "+14155550100"),
        ("+44 20 7946 0958", "+442079460958"),
        ("", ""),
        ("call me maybe", None),
        ("12345", None),
    ],
)
def test_numbers_are_cleaned(said, number):
    assert clean_number(said) == number


def test_the_script_is_escaped_paused_and_fits_twilio():
    xml = twiml("Good morning <Robert> & co.\n\nThree meetings today.")
    assert "Good morning &lt;Robert&gt; &amp; co." in xml and xml.count('<Pause length="1"/>') == 2
    long = twiml("\n".join(["A sentence that goes on for a while."] * 400))
    assert len(long) <= phone.TWIML_LIMIT + 200 and long.endswith("</Response>")


def prefs(**kw):
    base = {"phone_me": "+14155550199", "phone_from": "+14155550100"}
    return SimpleNamespace(**{**base, **kw})


class Twilio:
    def __init__(self):
        self.calls = []

    def __call__(self, url, form, sid, token, timeout=15):
        self.calls.append((url, form, sid, token))
        return {"sid": "CA123"}


def made(p=None, clock=None):
    twilio = Twilio()
    ph = Phone(lambda: p or prefs(), post=twilio, clock=clock or (lambda: 1000.0))
    return ph, twilio


async def test_it_calls_only_the_owners_number_with_the_message():
    ph, twilio = made()
    ph.save_credentials(SID, TOKEN)
    assert await ph.call_me("Good morning.\n\nTwo meetings.") == "CA123"
    url, form, sid, token = twilio.calls[0]
    assert url.endswith(f"/Accounts/{SID}/Calls.json") and (sid, token) == (SID, TOKEN)
    assert form["To"] == "+14155550199" and form["From"] == "+14155550100"
    assert "Two meetings." in form["Twiml"]


async def test_nothing_happens_until_it_is_set_up():
    ph, twilio = made(prefs(phone_me=""))
    ph.save_credentials(SID, TOKEN)
    with pytest.raises(PhoneError, match="aren't set up"):
        await ph.call_me("hi")
    ph2, twilio2 = made()
    with pytest.raises(PhoneError, match="aren't set up"):  # no credentials
        await ph2.call_me("hi")
    assert not twilio.calls and not twilio2.calls


def test_credentials_are_checked_and_kept_out_of_the_status():
    ph, _ = made()
    with pytest.raises(PhoneError):
        ph.save_credentials("not a sid", TOKEN)
    with pytest.raises(PhoneError):
        ph.save_credentials(SID, "short")
    ph.save_credentials(SID, TOKEN)
    status = ph.status()
    assert status["signed_in"] and status["ready"] and TOKEN not in str(status)
    assert status["sid_hint"] == f"{SID[:4]}…{SID[-4:]}"
    ph.keychain.clear()
    assert not ph.status()["signed_in"]


async def test_calls_are_capped_per_hour_and_day():
    now = [1000.0]
    ph, twilio = made(clock=lambda: now[0])
    ph.save_credentials(SID, TOKEN)
    for _ in range(phone.CALLS_PER_HOUR):
        await ph.call_me("hi")
    with pytest.raises(PhoneError, match="this hour"):
        await ph.call_me("hi")
    for _ in range(3):
        now[0] += 3601
        for _ in range(phone.CALLS_PER_HOUR):
            if len(twilio.calls) < phone.CALLS_PER_DAY:
                await ph.call_me("hi")
    with pytest.raises(PhoneError, match="today"):
        await ph.call_me("hi")
    assert len(twilio.calls) == phone.CALLS_PER_DAY


async def test_someone_else_rings_from_the_iphone_after_a_yes():
    ran, asked, answers = [], [], [True, False]

    async def run(*args, timeout=30):
        ran.append(args)
        return ""

    async def confirm(question):
        asked.append(question)
        return answers.pop(0)

    async def lookup(_query):
        return [
            {
                "name": "Ann Lee",
                "phones": [{"label": "mobile", "value": "(415) 555-0123"}],
                "emails": [],
            }
        ]

    ph = Phone(lambda: prefs(), run=run)
    _call_me, call_someone = phone.build_tools(ph, confirm, lookup)
    done = await call_someone.handler({"to": "Ann Lee"})
    assert asked == ["Call Ann Lee (+14155550123) from your iPhone?"]
    assert (
        ran == [("open", "tel://+14155550123")] and "Calling Ann Lee" in done["content"][0]["text"]
    )
    declined = await call_someone.handler({"to": "+1 415 555 0100"})
    assert declined.get("is_error") and len(ran) == 1  # a no rings no one
    with pytest.raises(PhoneError):
        await ph.dial("not a number")


async def test_call_me_tool_reports_why_it_cant(settings):
    ph = Phone(lambda: prefs(phone_me=""))

    async def confirm(_q):
        return True

    call_me, _ = phone.build_tools(ph, confirm)
    said = await call_me.handler({"message": "hi"})
    assert said.get("is_error") and "aren't set up" in said["content"][0]["text"]


async def test_the_hub_saves_credentials_and_never_echoes_the_token(
    settings, quiet_speaker, isolated
):
    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "phone_credentials", "sid": SID, "token": TOKEN})
    events = [e for e in drain(q) if e["type"] == "phone_status"]
    assert events and events[-1]["signed_in"] and events[-1]["note"] == "Saved in your Keychain."
    assert TOKEN not in str(events)
    await hub._handle({"type": "phone_forget"})
    assert not [e for e in drain(q) if e["type"] == "phone_status"][-1]["signed_in"]


def test_the_wake_up_call_is_due_once_near_its_time(settings, quiet_speaker, isolated):
    from datetime import datetime

    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.wake_call, hub.prefs.wake_call_time = True, "07:00"
    assert not hub.wake_call_due(datetime(2026, 9, 30, 6, 59))
    assert hub.wake_call_due(datetime(2026, 9, 30, 7, 5))
    assert not hub.wake_call_due(datetime(2026, 9, 30, 9, 0))  # too late to wake anyone
    hub.prefs.last_wake_call = "2026-09-30"
    assert not hub.wake_call_due(datetime(2026, 9, 30, 7, 5))
    hub.prefs.wake_call = False
    assert not hub.wake_call_due(datetime(2026, 10, 1, 7, 5))


def test_prefs_take_numbers_and_times_but_not_the_date():
    from jarvis.prefs import Prefs

    p = Prefs()
    changed = p.update(
        {
            "phone_me": "(415) 555-0199",
            "wake_call_time": "06:30",
            "last_wake_call": "2026-01-01",
            "phone_from": "nope",
        }
    )
    assert p.phone_me == "+14155550199" and p.wake_call_time == "06:30"
    assert p.last_wake_call == "" and p.phone_from == "" and "phone_from" not in changed
    assert "last_wake_call" not in p.public()


def test_form_encoding_round_trips():
    # What _post sends is ordinary form data (Twilio's REST API).
    from urllib.parse import urlencode

    body = urlencode({"To": "+1", "Twiml": "<Response/>"})
    assert parse_qs(body)["Twiml"] == ["<Response/>"]
    assert asyncio.iscoroutinefunction(Phone.call_me)
