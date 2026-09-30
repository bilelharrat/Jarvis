"""Promises the owner made: only their own sent texts and mail are read, only ones that
sound like a promise go to a capped model, what they quote is cut, reminders go out the
evening before and the morning it's due (each once), and they're listed, done or
dismissed by voice and in Settings."""

import json
from datetime import date, datetime, timedelta

import pytest
from memory_fakes import FakeAI, desk_of, drain, make_chat_db, make_hub, make_mail_db, said, tools

from jarvis import commitments
from jarvis.commitments import CommitmentStore


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


@pytest.fixture
def desk(hub):
    return desk_of(hub)


def sent_world(desk, tmp_path):
    now = datetime.now()
    make_chat_db(
        tmp_path / "chat.db",
        [
            ("I'll send you the deck by Friday", 1, now - timedelta(hours=3), 1, 1, 0),
            ("sounds good", 1, now - timedelta(hours=2), 1, 1, 0),
            ("I'll bring the wine", 0, now - timedelta(hours=2), 1, 1, 0),  # theirs: never read
            ("Liked “deck”", 1, now - timedelta(hours=1), 1, 1, 2001),  # a tapback
            ("I will book the restaurant tonight", 1, now - timedelta(hours=1), 3, 2, 0),
        ],
    )
    make_mail_db(
        tmp_path / "Envelope Index",
        [
            (
                "imap://x/Sent%20Messages",
                "me@x.com",
                "Re: numbers",
                "I will get you the numbers tomorrow.\n\nOn Tue, Sep 29 Ann wrote:\n> I'll pay you back",
                now - timedelta(hours=4),
                ["ann@bsh.com"],
            ),
            (
                "imap://x/INBOX",
                "ann@bsh.com",
                "I'll call you",
                "I'll call you later",
                now,
                ["me@x.com"],
            ),
        ],
    )
    desk.chat_db = tmp_path / "chat.db"
    desk.mail_db = lambda: tmp_path / "Envelope Index"
    desk.hub.interrupts._names = {"4155550142": "Ann Lee"}


async def test_promises_are_found_in_what_the_owner_sent(hub, desk, tmp_path):
    sent_world(desk, tmp_path)
    friday = (date.today() + timedelta(days=3)).isoformat()
    desk.ai = FakeAI(
        json.dumps(
            {
                "promises": [
                    {"n": 1, "text": "Send Ann the deck", "due": friday},
                    {"n": 3, "text": "Get Ann the numbers", "due": "someday"},
                    {"n": 9, "text": "Out of range"},
                ]
            }
        )
    )
    assert await desk.scan_promises(datetime.now()) == 0  # off until the owner turns it on
    hub.set_feature_prefs({"memory_commitments": True})
    q = hub.subscribe()
    assert await desk.scan_promises(datetime.now()) == 2
    [call] = desk.ai.calls
    assert call["kind"] == "commitments"
    assert "I'll send you the deck by Friday" in call["prompt"]
    assert "I will book the restaurant tonight" in call["prompt"]
    assert "I will get you the numbers tomorrow" in call["prompt"]
    for never in ("sounds good", "bring the wine", "Liked", "pay you back", "call you later"):
        assert never not in call["prompt"]
    deck, numbers = desk.promises.items
    assert (deck.text, deck.to, deck.due, deck.source) == (
        "Send Ann the deck",
        "Ann Lee",
        friday,
        "message",
    )
    assert (numbers.to, numbers.due, numbers.source) == ("ann@bsh.com", "", "mail")
    assert desk.promises.marks == {"message": 5, "mail": 1}
    assert any(e["type"] == "memory_state" for e in drain(q))
    desk._last_scan = 0.0
    assert await desk.scan_promises(datetime.now()) == 0 and len(desk.ai.calls) == 1  # all read


async def test_a_scan_that_couldnt_ask_reads_them_again_later(hub, desk, tmp_path):
    sent_world(desk, tmp_path)
    hub.set_feature_prefs({"memory_commitments": True})
    desk.ai = FakeAI(RuntimeError("offline"))
    assert await desk.scan_promises(datetime.now()) == 0
    assert desk.promises.marks == {}  # not moved on
    desk.ai = FakeAI(json.dumps({"promises": [{"n": 1, "text": "Send Ann the deck"}]}))
    assert await desk.scan_promises(datetime.now(), force=True) == 1


async def test_what_one_call_had_no_room_for_is_read_at_the_next_scan(
    hub, desk, tmp_path, monkeypatch
):
    monkeypatch.setattr(commitments, "MAX_ASKED", 2)
    now = datetime.now()
    make_chat_db(
        tmp_path / "chat.db",
        [
            ("I'll send the deck", 1, now - timedelta(hours=5), 1, 1, 0),
            ("ok", 1, now - timedelta(hours=4), 1, 1, 0),
            ("I'll call the bank", 1, now - timedelta(hours=3), 1, 1, 0),
            ("I'll book the flights", 1, now - timedelta(hours=2), 1, 1, 0),
            ("I will pay the invoice", 1, now - timedelta(hours=1), 1, 1, 0),
        ],
    )
    desk.chat_db = tmp_path / "chat.db"
    hub.set_feature_prefs({"memory_commitments": True})
    desk.ai = FakeAI('{"promises": []}', '{"promises": []}')
    await desk.scan_promises(now)
    first = desk.ai.calls[0]["prompt"]
    assert "send the deck" in first and "call the bank" in first and "flights" not in first
    assert desk.promises.marks == {"message": 3}  # up to the first it had no room for
    await desk.scan_promises(now, force=True)
    second = desk.ai.calls[1]["prompt"]
    assert "book the flights" in second and "pay the invoice" in second
    assert "deck" not in second and desk.promises.marks == {"message": 5}


async def test_reminders_the_evening_before_and_the_morning_its_due(hub, desk):
    due = date.today() + timedelta(days=1)
    item = desk.promises.add(
        "Send Ann the deck",
        to="Ann Lee",
        due=due.isoformat(),
        sent=(datetime.now() - timedelta(days=2)).isoformat(timespec="seconds"),
    )
    q = hub.subscribe()
    evening = datetime.combine(due - timedelta(days=1), datetime.min.time()).replace(
        hour=18, minute=5
    )
    await desk.remind_promises(evening.replace(hour=17))
    assert not [e for e in drain(q) if e["type"] == "alert"]
    await desk.remind_promises(evening)
    [alert] = [e for e in drain(q) if e["type"] == "alert"]
    assert (alert["alert_kind"], alert["title"], alert["text"]) == (
        "commitment",
        "Promised to Ann Lee",
        "Due tomorrow: Send Ann the deck",
    )
    await desk.remind_promises(evening + timedelta(hours=2))
    assert not [e for e in drain(q) if e["type"] == "alert"]  # once
    morning = datetime.combine(due, datetime.min.time()).replace(hour=9, minute=1)
    await desk.remind_promises(morning)
    [alert] = [e for e in drain(q) if e["type"] == "alert"]
    assert alert["text"] == "Due today: Send Ann the deck"
    assert CommitmentStore(desk.promises.path).items[0].reminded == ["eve", "due"]
    assert "Promises due today" not in desk.briefing_note()  # tomorrow's, not today's
    assert item.status == "open"


async def test_a_promise_made_the_evening_before_gets_only_the_mornings_reminder(desk):
    due = date.today() + timedelta(days=1)
    evening = datetime.combine(due - timedelta(days=1), datetime.min.time())
    desk.promises.add(
        "Call the bank", due=due.isoformat(), sent=evening.replace(hour=19).isoformat()
    )
    late = evening.replace(hour=20)
    assert desk.promises.due_reminders(late) == []


async def test_voice_lists_adds_and_marks_them(hub, desk):
    hub._turn_text = "I promised Ann the deck by Friday, keep track of it"
    out = await tools(desk)["add_promise"](
        {"text": "Send Ann the deck", "to": "Ann Lee", "due": "2020-01-01"}
    )
    assert not out.get("is_error")
    [item] = desk.promises.items
    assert item.due == "" and item.quote.startswith("I promised Ann")  # a past day isn't kept
    again = await tools(desk)["add_promise"]({"text": "send ann the deck", "to": "Ann Lee"})
    assert "already on the list" in said(again)
    assert "Send Ann the deck (to Ann Lee)" in said(await tools(desk)["list_promises"]({}))
    hub._turn_text = "I've sent it, mark the promise done"
    out = await tools(desk)["mark_promise"]({"what": "deck", "status": "done"})
    assert "Marked done" in said(out) and desk.promises.items[0].status == "done"
    assert said(await tools(desk)["list_promises"]({})) == "No open promises."
    assert "done" in said(await tools(desk)["list_promises"]({"include_closed": True}))
    hub.incognito = True  # nothing from an incognito conversation is kept
    hub._turn_text = "I promised Bob the photos, keep track of it"
    out = await tools(desk)["add_promise"]({"text": "Send Bob the photos", "to": "Bob"})
    assert out["is_error"] and "Incognito" in said(out) and len(desk.promises.items) == 1


async def test_the_window_marks_and_adds(hub, desk):
    await hub.handle({"type": "memory_promise_add", "text": "Pay Bob back", "to": "Bob", "due": ""})
    [item] = desk.promises.items
    await hub.handle({"type": "memory_promise", "id": item.id, "status": "dismissed"})
    assert desk.promises.items[0].status == "dismissed"
    await hub.handle({"type": "memory_promise", "id": item.id, "status": "exploded"})
    assert desk.promises.items[0].status == "dismissed"
    q = hub.subscribe()
    await desk.cmd_promise_scan({})
    assert "Promise tracking is off" in [e for e in drain(q) if e["type"] == "toast"][0]["text"]


def test_the_briefing_hears_whats_due_and_overdue(tmp_path, hub, desk):
    today = date.today()
    desk.promises.add("Send Ann the deck", due=today.isoformat(), today=today)
    desk.promises.add("Call the bank", due=(today - timedelta(days=1)).isoformat(), today=today)
    note = desk.briefing_note()
    assert "Promises due today: Send Ann the deck." in note
    assert "Overdue promises: Call the bank." in note


def test_a_damaged_promises_file_keeps_what_it_can(tmp_path):
    path = tmp_path / "commitments.json"
    path.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "id": "a",
                        "text": "Send the deck",
                        "status": "weird",
                        "due": "nope",
                        "reminded": ["eve", 3],
                    },
                    {"id": "b"},
                    "junk",
                ],
                "marks": {"message": 7, "mail": -1, "other": 3},
            }
        )
    )
    store = CommitmentStore(path)
    [item] = store.items
    assert (item.status, item.due, item.reminded) == ("open", "", ["eve"])
    assert store.marks == {"message": 7}


@pytest.mark.parametrize("sent", ["2026-09-29T09:00:00Z", "2026-09-29T09:00:00-07:00"])
def test_a_promise_sent_at_a_zoned_time_still_gets_its_evening_reminder(tmp_path, sent):
    """When it was promised, with a zone (another build's, or a hand edit): read as this
    Mac's clock, so the evening before still reminds, for it and every promise after it."""
    path = tmp_path / "commitments.json"
    rows = [
        {"id": "a", "text": "Send Ann the deck", "due": "2026-10-02", "sent": sent},
        {"id": "b", "text": "Call Bob back", "due": "2026-10-02", "sent": "2026-09-29T10:00:00"},
    ]
    path.write_text(json.dumps({"items": rows}))
    store = CommitmentStore(path)
    evening = datetime(2026, 10, 1, 18, 30)
    assert [(c.id, kind) for c, kind in store.due_reminders(evening)] == [
        ("a", "eve"),
        ("b", "eve"),
    ]


def test_only_promise_like_words_go_anywhere():
    sent = [
        commitments.Sent("message", 1, "Ann", "", text, datetime.now())
        for text in (
            "I'll send it Friday",
            "ok",
            "Thanks!",
            "我明天发给你",
            "Will send the contract by EOD",
            "see you",
        )
    ]
    assert [s.text for s in commitments.promising(sent)] == [
        "I'll send it Friday",
        "我明天发给你",
        "Will send the contract by EOD",
    ]
