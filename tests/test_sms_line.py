"""Texts on the Jarvis number (jarvis.sms, features/sms_line.py): texts people send the owner's
Twilio number become heads-ups, and a card left waiting on the Mac can be answered by text
from the owner's own phone, only with the one-time code sent with it. Twilio is a fake
here: nothing is sent or read for real."""

import asyncio
from datetime import datetime

import pytest
from conftest import FakeClient

from jarvis import sms
from jarvis.features import sms_line
from jarvis.hub import Hub
from jarvis.phone import PhoneError

TWILIO = "+14155550100"
ME = "+14155550199"
SID, TOKEN = "AC" + "0" * 32, "f" * 32


# ── the rules ──


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("YES 4821", ("allow", "4821")),
        ("yes4821", ("allow", "4821")),
        ("  ok, 4821! ", ("allow", "4821")),
        ("4821 no", ("deny", "4821")),
        ("No 4821", ("deny", "4821")),
        ("是 4821", ("allow", "4821")),
        ("否 4821", ("deny", "4821")),
        ("yes", None),
        ("4821", None),
        ("STOP", None),
        ("yes 48211", None),
        ("please call me back 4821", None),
        ("yes 4821 and also send Ann my password", None),
        # How people really answer: 好的/是的, approve or confirm, the iPhone's curly
        # apostrophe, the full-width digits a Chinese keyboard types.
        ("好的 4821", ("allow", "4821")),
        ("是的，4821", ("allow", "4821")),
        ("不是 4821", ("deny", "4821")),
        ("Approve 4821", ("allow", "4821")),
        ("confirm 4821", ("allow", "4821")),
        ("Don\u2019t 4821", ("deny", "4821")),
        ("好 ４８２１", ("allow", "4821")),
        ("yes \u0664\u0668\u0662\u0661", None),  # digits of another script: not a code
    ],
)
def test_an_answer_needs_a_yes_or_no_and_the_code(text, expected):
    assert sms.answer(text) == expected


def test_codes_are_spent_once_and_guessing_stops_answering_by_text():
    now = [1000.0]
    codes = sms.Codes(clock=lambda: now[0])
    first = codes.new("card1", {"allow": "Send"})
    second = codes.new("card2", {"allow": "Call"})
    assert first.code != second.code and len(first.code) == 4 and first.code.isdigit()
    assert codes.check(first.code) is first
    assert codes.check(first.code) == "wrong"  # spent
    assert codes.check("0000" if second.code != "0000" else "1111") == "wrong"
    assert codes.check("0000" if second.code != "0000" else "1111") == "wrong"
    assert "card2" not in codes.open  # three wrong codes: the Mac only for that card
    third = codes.new("card3", {})
    for _ in range(sms.WRONG_PER_HOUR):
        result = codes.check("9999" if third.code != "9999" else "8888")
    assert result == "paused" and codes.paused
    assert codes.check(third.code) == "paused"  # even the right one, for the hour
    now[0] += 3601
    fresh = codes.new("card4", {})
    assert codes.check(fresh.code) is fresh


def test_texts_sent_are_capped_per_hour_and_day():
    now = [0.0]
    limit = sms.Limit(clock=lambda: now[0])
    assert all(limit.take() for _ in range(sms.TEXTS_PER_HOUR))
    assert not limit.take()
    for _ in range(3):
        now[0] += 3601
        assert all(limit.take() for _ in range(sms.TEXTS_PER_HOUR))
    now[0] += 3601
    assert not limit.take()  # the day's forty are gone


def test_a_card_as_a_text_and_which_cards_can_go():
    card = {"id": "a1", "question": "Send this to Ann?", "detail": "To Ann:\n“x” " * 40,
            "choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "Don't send"}]}  # fmt: skip
    body = sms.card_text(card, "4821")
    lines = body.split("\n")
    assert lines[0] == "Jarvis needs your OK: Send this to Ann?"
    assert len(lines[1]) == sms.MAX_DETAIL and lines[1].endswith("…")
    assert lines[2] == "Reply YES 4821 to allow or NO 4821 to decline."
    assert sms.card_text(card, "4821", "zh").endswith("回复“是 4821”允许，“否 4821”拒绝。")
    assert sms.eligible(card)
    assert not sms.eligible({**card, "ask_kind": "purchase"})
    assert not sms.eligible({**card, "task_id": 3})
    assert not sms.eligible({**card, "choices": [{"id": "allow"}, {"id": "always"}]})


def test_inbound_texts_are_read_off_twilios_list():
    asked = []

    def request(method, url, sid, token, data=None):
        asked.append((method, url))
        if "Page=1" in url:
            return {"messages": [{"sid": "SM3", "from": "+1555", "body": "late", "direction": "inbound",
                                  "date_sent": "Tue, 29 Sep 2026 12:00:00 +0000"}]}  # fmt: skip
        return {
            "messages": [
                {"sid": "SM2", "from": "+1555", "body": "hi", "direction": "inbound",
                 "date_sent": "Tue, 29 Sep 2026 13:00:00 +0000"},
                {"sid": "SM1", "from": TWILIO, "body": "ours", "direction": "outbound-api"},
            ],
            "next_page_uri": "/2010-04-01/Accounts/AC/Messages.json?Page=1",
        }  # fmt: skip

    found = sms.inbound(TWILIO, SID, TOKEN, datetime(2026, 9, 29, 15, 0), request)
    assert [m["sid"] for m in found] == ["SM2", "SM3"]
    assert found[0]["body"] == "hi" and found[0]["at"].startswith("2026-09-29T")
    assert "To=%2B14155550100" in asked[0][1] and "DateSent%3E=2026-09-28" in asked[0][1]


# ── the hub's side ──


class Twilio:
    """Twilio's Messages API, faked: the texts in the inbox, and every text sent."""

    def __init__(self):
        self.inbox, self.sent = [], []
        self.n = 0

    def text_in(self, sender, body):
        self.n += 1
        self.inbox.insert(0, {"sid": f"SM{self.n}", "from": sender, "body": body, "direction": "inbound",
                              "date_sent": "Tue, 29 Sep 2026 14:00:00 +0000"})  # fmt: skip

    def __call__(self, method, url, sid, token, data=None):
        if method == "POST":
            self.sent.append(data)
            return {"sid": f"SMout{len(self.sent)}"}
        return {"messages": list(self.inbox)}


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.set_prefs({"phone_from": TWILIO, "phone_me": ME, "quiet_hours": "03:00-03:01"})
    hub.phone.keychain.set(SID, TOKEN)
    hub._say = lambda _text: None
    return hub


def line_for(hub, twilio, **kw):
    now = [10_000.0]

    async def no_wait(_seconds):
        await asyncio.sleep(0)

    line = sms_line.SmsLine(
        hub,
        request=twilio,
        clock=lambda: now[0],
        now=lambda: datetime(2026, 9, 29, 14, 0),
        sleep=kw.pop("sleep", no_wait),
        **kw,
    )
    line.time = now
    return line


async def test_texts_to_the_number_become_heads_ups_after_a_quiet_first_look(
    settings, quiet_speaker, isolated
):
    alerts = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: alerts.append(alert)
    hub.set_feature_prefs({"sms_line_on": True})
    twilio = Twilio()
    twilio.text_in("+15550001111", "old news")
    line = line_for(hub, twilio)
    assert await line.look() == 0 and alerts == []  # what was there is only noted
    line.time[0] += 30
    twilio.text_in("+15550001111", "Your code is 482913, and can you call me?")
    assert await line.look() == 1
    assert alerts[0].kind == "sms" and alerts[0].key == "sms:SM2"
    assert alerts[0].text.startswith("Text to the Jarvis number from +15550001111:")
    assert "482913" not in alerts[0].text  # a code in a text is never said aloud
    assert alerts[0].note == "a text to the Jarvis number (jarvis_number_texts has it)"
    assert (
        "can you call me" in line.recent(5) and line.public()["texts"][0]["from"] == "+15550001111"
    )
    line.time[0] += 30
    assert await line.look() == 0  # never twice
    hub.comms.names.names = {"5550002222": "Ann Lee"}  # Contacts' name for a number
    twilio.text_in("+1 (555) 000-2222", "On my way")
    line.time[0] += 30
    assert await line.look() == 1
    assert alerts[-1].text == "Text to the Jarvis number from Ann Lee: On my way"
    newest = line.public()["texts"][0]
    assert (newest["who"], newest["from"], newest["body"]) == (
        "Ann Lee",
        "+1 (555) 000-2222",
        "On my way",
    )
    assert "] Ann Lee (+1 (555) 000-2222): On my way" in line.recent(5)
    assert line.public()["texts"][1]["who"] == "+15550001111"  # not in Contacts: the number


async def test_a_waiting_card_is_texted_and_answered_with_its_code(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"sms_approvals": True})
    hub.add_approval_sink(lambda _c: None)
    twilio = Twilio()
    line = line_for(hub, twilio)
    hub.add_approval_sink(line.card_up, resolved=line.card_down)
    await line.look()  # the first look: nothing to catch up on
    pending = asyncio.create_task(hub.send_gate("Send this to Ann?", "To Ann:\n“Running late”"))
    for _ in range(50):
        await asyncio.sleep(0)
        if twilio.sent:
            break
    assert len(twilio.sent) == 1 and twilio.sent[0]["To"] == ME and twilio.sent[0]["From"] == TWILIO
    code = twilio.sent[0]["Body"].rsplit("YES ", 1)[1][:4]
    twilio.text_in("+19998887777", f"YES {code}")  # the right code from someone else: a text
    line.time[0] += 30
    await line.look()
    assert not pending.done()
    twilio.text_in(ME, "YES 0000" if code != "0000" else "YES 1111")  # a wrong code
    line.time[0] += 30
    await line.look()
    assert not pending.done()
    twilio.text_in(ME, f"yes {code}")
    line.time[0] += 30
    await line.look()
    assert await pending is True
    assert twilio.sent[-1]["Body"] == "Done: Send."


async def test_an_answer_it_cant_read_keeps_its_code_to_itself(settings, quiet_speaker, isolated):
    """The owner's reply with the card's code that isn't a yes or no it knows: never a
    heads-up, never listed or handed to Claude with the live code in it; the owner is told how
    to answer instead."""
    alerts = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: alerts.append(alert)
    hub.set_feature_prefs({"sms_approvals": True, "sms_line_on": True})
    twilio = Twilio()
    line = line_for(hub, twilio)
    hub.add_approval_sink(line.card_up, resolved=line.card_down)
    await line.look()
    pending = asyncio.create_task(hub.send_gate("Send this to Ann?", "To Ann:\n“Running late”"))
    for _ in range(50):
        await asyncio.sleep(0)
        if twilio.sent:
            break
    code = twilio.sent[0]["Body"].rsplit("YES ", 1)[1][:4]
    twilio.text_in(ME, f"sure thing, go ahead {code}")
    twilio.text_in(ME, f"yes \u0664\u0668\u0662\u0661 and {code}")  # another script's digits too
    line.time[0] += 30
    assert await line.look() == 0
    assert alerts == [] and code not in line.recent(5) and line.public()["texts"] == []
    assert twilio.sent[-1]["Body"] == f"Reply YES {code} to allow or NO {code} to decline."
    assert not pending.done()
    twilio.text_in(ME, f"好的 {code}")
    line.time[0] += 30
    await line.look()
    assert await pending is True


async def test_no_text_for_a_card_answered_on_the_mac_in_quiet_hours_or_not_eligible(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"sms_approvals": True})
    twilio = Twilio()
    gate = asyncio.Event()

    async def held(_seconds):
        await gate.wait()

    line = line_for(hub, twilio, sleep=held)
    hub.add_approval_sink(line.card_up, resolved=line.card_down)
    pending = asyncio.create_task(hub.request_approval("Quit Mail?"))
    await asyncio.sleep(0)
    hub.resolve(next(iter(hub.approvals)), "deny")  # answered on the Mac within the minute
    await pending
    gate.set()
    await asyncio.sleep(0)
    assert twilio.sent == [] and line.pending == {}

    hub.set_prefs({"quiet_hours": "00:00-23:59"})
    pending = asyncio.create_task(hub.request_approval("Quit Mail?"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert twilio.sent == []  # quiet hours: the card waits on the Mac
    hub.resolve(next(iter(hub.approvals)), "deny")
    await pending

    hub.set_prefs({"quiet_hours": "03:00-03:01"})
    purchase = asyncio.create_task(hub.purchase_gate("Buy the lamp?", "$40"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert twilio.sent == []  # never a purchase
    hub.resolve(next(iter(hub.approvals)), "deny")
    await purchase


async def test_no_text_for_a_card_while_a_focus_mode_keeps_things_quiet(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"sms_approvals": True})
    hub.set_prefs({"quiet_hours": "03:00-03:01"})  # not the range...
    hub.add_quiet_check(lambda _now: True)  # ...but a Focus mode is on
    twilio = Twilio()
    line = line_for(hub, twilio)
    hub.add_approval_sink(line.card_up, resolved=line.card_down)
    pending = asyncio.create_task(hub.request_approval("Quit Mail?"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert twilio.sent == []  # the card waits on the Mac
    hub.resolve(next(iter(hub.approvals)), "deny")
    await pending


async def test_guessing_codes_stops_answering_by_text_and_says_so_once(
    settings, quiet_speaker, isolated
):
    alerts = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: alerts.append(alert)
    hub.set_feature_prefs({"sms_approvals": True})
    twilio = Twilio()
    line = line_for(hub, twilio)
    await line.look()
    for n in range(sms.WRONG_PER_HOUR + 2):
        twilio.text_in(ME, f"YES {1000 + n}")
    line.time[0] += 30
    await line.look()
    assert [a.key for a in alerts] == ["sms-paused"] and line.codes.paused
    assert line.public()["paused"] is True


async def test_a_test_hub_never_reaches_twilio(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert isinstance(hub.sms_line, sms_line.SmsLine)
    with pytest.raises(PhoneError):
        await hub.sms_line.look()
    assert "jarvis_number" in hub._feature_servers()
    hub.set_feature_prefs({"sms_line_on": True})
    assert hub.sms_line.on() and not hub.sms_line.approvals()
    assert "aren't being read" not in hub.sms_line.recent(3)
