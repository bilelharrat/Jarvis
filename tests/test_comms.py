"""Email and texts in full (messaging.Extras, attachments.py, mailkit.py, textkit.py and
features/comms.py): copies, files, the account, replies in a thread, group chats, delivery,
finding email and tidying the inbox. Every send still shows its card first, and nothing
here touches the real Mac: scripts, Mail's index and Messages' database are fakes."""

import asyncio
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import FakeClient

from jarvis import attachments, mac_tools, mailkit, messaging, textkit
from jarvis.features import comms as comms_feature
from jarvis.hub import Hub

ANN = {"name": "Ann Lee", "phones": [], "emails": [{"label": "work", "value": "ann@x.com"}]}
BOB = {"name": "Bob Ray", "phones": [{"label": "iPhone", "value": "+1 415 555 0101"}],
       "emails": [{"label": "home", "value": "bob@y.com"}]}  # fmt: skip
CAT = {"name": "Cat Oh", "phones": [], "emails": [{"label": "work", "value": "cat@z.com"}]}


async def lookup(query):
    q = query.lower()
    return [p for p in (ANN, BOB, CAT) if q.split()[0] in p["name"].lower()]


class Recorder:
    """approve() and run() for build_tools, recording what was asked and what ran."""

    def __init__(self, answers=None):
        self.asked, self.ran = [], []
        self.answers = list(answers or [])

    async def approve(self, question, detail, spoken):
        self.asked.append((question, detail, spoken))
        return self.answers.pop(0) if self.answers else True

    async def run(self, script, *args, **_kw):
        self.ran.append((script, args))
        return ""


def fake_extras(**overrides):
    async def attach(values, for_email):
        return [Path(v) for v in values], ""

    async def accounts():
        return [
            {"name": "iCloud", "full": "Robert Doe", "emails": ["me@icloud.com"]},
            {"name": "Work", "full": "Robert Doe", "emails": ["robert@work.com"]},
        ]

    async def find_email(_message_id):
        return {"found": True, "sender": "Ann Lee <ann@x.com>", "replyTo": "",
                "subject": "Q3 plan", "to": [{"name": "Me", "address": "robert@work.com"},
                                             {"name": "Cat Oh", "address": "cat@z.com"}],
                "cc": [{"name": "", "address": "dan@w.com"}]}  # fmt: skip

    async def groups():
        return [
            textkit.Group("iMessage;+;chat1", "Family", ["+14155550101", "mom@x.com"]),
            textkit.Group("iMessage;+;chat2", "Family Trip 2026", ["+14155550101"]),
            textkit.Group("iMessage;+;chat3", "Book club", ["+14155550199"]),
        ]

    async def names(handles):
        return {h: {"+14155550101": "Bob Ray", "mom@x.com": "Mom"}.get(h, "") for h in handles}

    async def baseline():
        return 41

    delivered_calls = []

    async def delivered(after, handle, chat, who):
        delivered_calls.append((after, handle, chat, who))
        return f"Delivered to {who}.", False

    extras = messaging.Extras(
        attach=attach,
        accounts=accounts,
        find_email=find_email,
        groups=groups,
        names=names,
        baseline=baseline,
        delivered=delivered,
    )
    for key, value in overrides.items():
        setattr(extras, key, value)
    extras.delivered_calls = delivered_calls
    return extras


def tools_for(rec, extras):
    return {t.name: t.handler for t in messaging.build_tools(rec.approve, lookup, rec.run, extras)}


# ── email: copies, files, the account ──


async def test_copies_files_and_account_are_on_the_card_and_in_the_send(tmp_path):
    plan = tmp_path / "plan.pdf"
    plan.write_bytes(b"x" * 1500)
    rec = Recorder()
    tools = tools_for(rec, fake_extras())
    out = await tools["send_email"](
        {
            "to": "Ann",
            "subject": "Plan",
            "body": "Here it is.",
            "cc": ["Bob"],
            "bcc": ["cat@z.com"],
            "attachments": [str(plan)],
            "from": "work",
        }  # fmt: skip
    )
    assert out["content"][0]["text"] == "Emailed Ann Lee and 2 more."
    question, detail, spoken = rec.asked[0]
    assert question == "Email Ann Lee about Plan?"  # everyone else is on the card and said
    assert detail == (
        "From: robert@work.com\nTo Ann Lee <ann@x.com>\nCc: Bob Ray <bob@y.com>\n"
        "Bcc: cat@z.com\nSubject: Plan\nAttached: plan.pdf (1 KB)\n\nHere it is."
    )
    assert spoken.split("\n") == [
        "It also goes to Bob Ray and cat@z.com.",
        "With the attachment plan.pdf.",
        "From your Work account.",
        "Here's your email to Ann Lee, subject: Plan. Here it is. Do you want this email sent?",
    ]
    script, args = rec.ran[0]
    assert script == mailkit.SEND_SCRIPT
    assert args == ("ann@x.com", "bob@y.com", "cat@z.com", "Plan", "Here it is.",
                    "Robert Doe <robert@work.com>", str(plan))  # fmt: skip


async def test_a_plain_email_goes_the_way_it_always_did():
    rec = Recorder()
    tools = tools_for(rec, fake_extras())
    out = await tools["send_email"]({"to": "Ann", "subject": "Hi", "body": "Lunch?"})
    assert out["content"][0]["text"] == "Emailed Ann Lee."
    assert rec.asked[0][:2] == (
        "Email Ann Lee about Hi?",
        "To Ann Lee <ann@x.com>\nSubject: Hi\n\nLunch?",
    )
    assert rec.ran == [(messaging.SEND_EMAIL_SCRIPT, ("ann@x.com", "Hi", "Lunch?"))]


async def test_a_no_on_the_card_sends_nothing_and_a_bad_copy_asks_nothing():
    rec = Recorder(answers=[False])
    tools = tools_for(rec, fake_extras())
    out = await tools["send_email"]({"to": "Ann", "subject": "s", "body": "b", "cc": ["Bob"]})
    assert out["is_error"] and rec.ran == []
    out = await tools["send_email"]({"to": "Ann", "subject": "s", "body": "b", "cc": ["Zed"]})
    assert out["is_error"] and "no one called Zed" in out["content"][0]["text"]
    assert len(rec.asked) == 1  # the unknown copy never reached a card


async def test_too_many_people_or_an_unknown_account_is_refused_before_a_card():
    rec = Recorder()
    tools = tools_for(rec, fake_extras())
    many = [f"p{i}@x.com" for i in range(10)]
    out = await tools["send_email"]({"to": "Ann", "subject": "s", "body": "b", "cc": many})
    assert out["is_error"] and "more than 10" in out["content"][0]["text"]
    out = await tools["send_email"]({"to": "Ann", "subject": "s", "body": "b", "from": "gmail"})
    assert out["is_error"] and "No Mail account matches gmail" in out["content"][0]["text"]
    assert rec.asked == [] and rec.ran == []


async def test_a_file_that_may_not_go_stops_the_send_before_the_card():
    async def refuse(values, for_email):
        return [], "I can only attach files I made for you, or ones you name yourself."

    rec = Recorder()
    tools = tools_for(rec, fake_extras(attach=refuse))
    out = await tools["send_email"](
        {"to": "Ann", "subject": "s", "body": "b", "attachments": ["~/.ssh/id_rsa"]}
    )
    assert out["is_error"] and "only attach files I made" in out["content"][0]["text"]
    out = await tools["send_message"]({"to": "Bob", "text": "hi", "attachments": ["x.pdf"]})
    assert out["is_error"] and rec.asked == [] and rec.ran == []


# ── replies ──


async def test_reply_all_keeps_the_thread_and_leaves_the_owner_out():
    rec = Recorder()
    tools = tools_for(rec, fake_extras())
    out = await tools["reply_email"](
        {"message_id": "<abc123@x.com>", "body": "Works for me.", "reply_all": True}
    )
    assert out["content"][0]["text"] == "Replied to Ann Lee and 2 more."
    question, detail, spoken = rec.asked[0]
    assert question == "Reply to Ann Lee about Re: Q3 plan?"
    assert detail == (
        "Reply to Ann Lee <ann@x.com>\nCc: Cat Oh <cat@z.com>, dan@w.com\n"
        "Subject: Re: Q3 plan\n\nWorks for me."
    )
    assert spoken.endswith("Do you want this reply sent?")
    script, args = rec.ran[0]
    assert script == mailkit.REPLY_SCRIPT
    assert args == ("abc123@x.com", "ann@x.com", "cat@z.com\ndan@w.com", "", "Re: Q3 plan",
                    "Works for me.", "", "")  # fmt: skip


async def test_a_reply_goes_to_reply_to_and_keeps_a_re_it_already_has():
    async def find_email(_mid):
        return {"found": True, "sender": "News <news@shop.com>",
                "replyTo": "Help Desk <help@shop.com>", "subject": "RE: your order",
                "to": [], "cc": []}  # fmt: skip

    rec = Recorder()
    tools = tools_for(rec, fake_extras(find_email=find_email))
    await tools["reply_email"]({"message_id": "m1@shop.com", "body": "Thanks."})
    assert rec.asked[0][0] == "Reply to Help Desk about RE: your order?"
    assert rec.ran[0][1][1] == "help@shop.com"


async def test_a_reply_needs_an_email_it_can_find():
    async def gone(_mid):
        return "That email isn't in the inbox (it may have been moved or deleted)."

    rec = Recorder()
    tools = tools_for(rec, fake_extras(find_email=gone))
    out = await tools["reply_email"]({"message_id": "m1@x.com", "body": "Hi."})
    assert out["is_error"] and "isn't in the inbox" in out["content"][0]["text"]
    out = await tools["reply_email"]({"message_id": "not an id", "body": "Hi."})
    assert out["is_error"] and "email's id" in out["content"][0]["text"]
    assert rec.asked == []


# ── texts: groups, files, delivery ──


async def test_a_group_chat_by_name_shows_who_is_in_it():
    rec = Recorder()
    extras = fake_extras()
    tools = tools_for(rec, extras)
    out = await tools["send_group_message"]({"group": "family", "text": "Dinner at 7"})
    assert out["content"][0]["text"] == "Delivered to the group Family."
    question, detail, spoken = rec.asked[0]
    assert question == "Message the group “Family”?"
    assert detail == "To the group “Family” (Bob Ray, Mom):\n“Dinner at 7”"
    assert (
        spoken
        == "Here's your message to the group Family. Dinner at 7. Do you want this message sent?"
    )
    assert rec.ran == [(textkit.SEND_GROUP_SCRIPT, ("iMessage;+;chat1", "Dinner at 7", ""))]
    assert extras.delivered_calls == [(41, "", "iMessage;+;chat1", "the group Family")]


async def test_a_group_name_that_fits_several_or_none_asks():
    rec = Recorder()
    tools = tools_for(rec, fake_extras())
    out = await tools["send_group_message"]({"group": "fam", "text": "hi"})
    assert out["is_error"] and "Several group chats match fam" in out["content"][0]["text"]
    out = await tools["send_group_message"]({"group": "work", "text": "hi"})
    assert out["is_error"] and "No group chat called work" in out["content"][0]["text"]
    assert "Book club" in out["content"][0]["text"] and rec.asked == []


async def test_a_text_with_a_file_and_a_failed_delivery(tmp_path):
    pdf = tmp_path / "invoice.pdf"
    pdf.write_bytes(b"%PDF")

    async def failed(after, handle, chat, who):
        return f"Messages couldn't deliver it to {who} (error 22).", True

    rec = Recorder()
    tools = tools_for(rec, fake_extras(delivered=failed))
    out = await tools["send_message"](
        {"to": "Bob", "text": "Here you go", "attachments": [str(pdf)]}
    )
    assert out["is_error"] and "error 22" in out["content"][0]["text"]
    question, detail, spoken = rec.asked[0]
    assert detail == "To Bob Ray (+1 415 555 0101):\n“Here you go”\nAttached: invoice.pdf (1 KB)"
    assert spoken.split("\n")[0] == "With the attachment invoice.pdf."
    assert rec.ran == [(textkit.SEND_FILES_SCRIPT, ("+1 415 555 0101", "Here you go", str(pdf)))]


# ── the attachment rule ──


def made(path, title):
    return SimpleNamespace(path=path, title=title)


def test_files_jarvis_made_or_the_owner_named_may_go_and_nothing_else(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    memo = tmp_path / "Documents" / "JARVIS" / "Q3 memo.docx"
    budget = tmp_path / "Desktop" / "Budget_2026.xlsx"
    secret = tmp_path / "Desktop" / "notes.txt"
    key = tmp_path / ".ssh" / "id_rsa"
    for f in (memo, budget, secret, key):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
    ours = [made(memo, "Q3 memo")]
    ok, why = attachments.check([str(memo)], made=ours, words="email it to Ann")
    assert ok == [memo.resolve()] and not why
    ok, why = attachments.check(["Q3 memo"], made=ours, words="")  # a made file by title
    assert ok == [memo.resolve()]
    ok, why = attachments.check([str(budget)], made=ours, words="send Ann the budget 2026 sheet")
    assert ok == [budget.resolve()]
    ok, why = attachments.check([str(secret)], made=ours, words="send Ann the budget")
    assert not ok and "You didn't name notes.txt" in why
    ok, why = attachments.check([str(key)], made=ours, words="attach id_rsa")
    assert not ok and "holds credentials" in why
    ok, why = attachments.check([str(tmp_path / "nope.pdf")], made=ours, words="")
    assert not ok and "There's no file" in why


def test_sizes_and_counts_are_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    big = tmp_path / "big.mov"
    big.write_bytes(b"x" * 2000)
    ours = [made(big, "big")]
    ok, why = attachments.check([str(big)], made=ours, words="", each=1000, total=5000)
    assert not ok and "at most 1 KB" in why
    ok, why = attachments.check([str(big)] * 11, made=ours, words="")
    assert not ok and "at most 10" in why


def test_a_name_is_named_only_as_a_whole_word():
    path = Path("/Users/me/Desktop/plan.pdf")
    assert attachments.named_in("attach plan.pdf please", path)
    assert attachments.named_in("send the plan", path)
    assert not attachments.named_in("send the planning doc", path)
    assert not attachments.named_in("", path)
    assert not attachments.named_in("send a file", Path("/Users/me/a.pdf"))  # too short


# ── Mail's index ──


class EnvelopeIndex:
    """A synthetic Envelope Index with the tables search reads: an inbox, Sent, Trash."""

    def __init__(self, path):
        self.path = path
        db = sqlite3.connect(path)
        db.executescript(
            """
            CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, sender INTEGER,
                subject INTEGER, summary INTEGER, date_received INTEGER, mailbox INTEGER,
                deleted INTEGER DEFAULT 0, read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0,
                subject_prefix TEXT, global_message_id INTEGER);
            CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
            CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
            CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
            CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
            CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER, type INTEGER,
                address INTEGER, position INTEGER);
            CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER,
                message_id_header TEXT);
            INSERT INTO mailboxes VALUES (1, 'imap://UUID-1/INBOX'),
                (2, 'imap://UUID-1/Sent%20Messages'), (3, 'imap://UUID-1/Deleted%20Messages'),
                (4, 'imap://UUID-1/Archive');
            """
        )
        db.commit()
        db.close()

    def add(self, address, name, subject, *, days_ago=1, mailbox=1, summary="", to=(), read=1):
        db = sqlite3.connect(self.path)
        try:
            cur = db.cursor()
            cur.execute("INSERT INTO addresses (address, comment) VALUES (?, ?)", (address, name))
            sender = cur.lastrowid
            cur.execute("INSERT INTO subjects (subject) VALUES (?)", (subject,))
            subject_id = cur.lastrowid
            cur.execute("INSERT INTO summaries (summary) VALUES (?)", (summary,))
            summary_id = cur.lastrowid
            n = cur.execute("SELECT count(*) FROM message_global_data").fetchone()[0] + 1
            cur.execute(
                "INSERT INTO message_global_data (message_id, message_id_header) VALUES (?, ?)",
                (n, f"<m{n}@mail.test>"),
            )
            global_id = cur.lastrowid
            when = int((datetime.now() - timedelta(days=days_ago)).timestamp())
            cur.execute(
                """INSERT INTO messages (sender, subject, summary, date_received, mailbox, read,
                   subject_prefix, global_message_id) VALUES (?,?,?,?,?,?,?,?)""",
                (sender, subject_id, summary_id, when, mailbox, read, "", global_id),
            )
            rowid = cur.lastrowid
            for i, (addr, nm) in enumerate(to):
                cur.execute("INSERT INTO addresses (address, comment) VALUES (?, ?)", (addr, nm))
                cur.execute(
                    "INSERT INTO recipients (message, type, address, position) VALUES (?,0,?,?)",
                    (rowid, cur.lastrowid, i),
                )
            db.commit()
            return f"m{n}@mail.test"
        finally:
            db.close()


def test_search_by_person_subject_and_sent_mail(tmp_path):
    index = EnvelopeIndex(tmp_path / "Envelope Index")
    index.add("ann@x.com", "Ann Lee", "Q3 plan", days_ago=3, summary="Old draft")
    newest = index.add(
        "ann@x.com", "Ann Lee", "Re: Q3 plan", days_ago=1, summary="Looks good", read=0
    )
    index.add("ann@x.com", "Ann Lee", "Spam", mailbox=3)  # in the trash: never
    index.add("bob@y.com", "Bob Ray", "Invoice 12", mailbox=4)  # archived: still found
    index.add("me@icloud.com", "Me", "Dinner?", mailbox=2, to=[("ann@x.com", "Ann Lee")])
    index.add("ann@x.com", "Ann Lee", "Ancient", days_ago=900)

    found = mailkit.search(index.path, addresses=["ann@x.com"], limit=5)
    assert [f["subject"] for f in found] == ["Re: Q3 plan", "Q3 plan"]
    assert found[0]["id"] == newest and not found[0]["read"]
    assert found[0]["preview"] == "Looks good"
    assert [f["subject"] for f in mailkit.search(index.path, name="Bob")] == ["Invoice 12"]
    assert [f["subject"] for f in mailkit.search(index.path, subject="invoice")] == ["Invoice 12"]
    sent = mailkit.search(index.path, addresses=["ann@x.com"], sent=True)
    assert [f["subject"] for f in sent] == ["Dinner?"] and sent[0]["to"] == ["Ann Lee <ann@x.com>"]
    assert mailkit.search(index.path, name="Nobody") == []
    with pytest.raises(mailkit.MailError):
        mailkit.search(index.path)
    text = mailkit.describe(found)
    assert text.startswith("Email content is other people's words")
    assert f"(id: {newest})" in text and "[unread]" in text
    assert mailkit.headlines(index.path, [newest, "<nope@x>"]) == [
        "Ann Lee <ann@x.com> — Re: Q3 plan"
    ]


def test_a_like_search_takes_percent_and_underscore_literally(tmp_path):
    index = EnvelopeIndex(tmp_path / "Envelope Index")
    index.add("a@x.com", "A", "100% done")
    index.add("b@x.com", "B", "1000 done")
    assert [f["subject"] for f in mailkit.search(index.path, subject="100%")] == ["100% done"]


def test_search_without_access_says_so(tmp_path):
    with pytest.raises(PermissionError):
        mailkit.search(tmp_path / "missing", subject="x")


# ── List-Unsubscribe ──


def test_unsubscribe_options_prefer_safe_ways():
    header = "<mailto:leave@list.com?subject=Remove%20me>, <https://list.com/u/abc>"
    assert mailkit.unsubscribe_options(header, "List-Unsubscribe=One-Click") == {
        "mailto": "leave@list.com",
        "subject": "Remove me",
        "body": "",
        "one_click": "https://list.com/u/abc",
    }
    assert mailkit.unsubscribe_options(header) == {
        "mailto": "leave@list.com",
        "subject": "Remove me",
        "body": "",
        "web": "https://list.com/u/abc",
    }
    assert mailkit.unsubscribe_options("<http://list.com/u>, <javascript:alert(1)>") == {}
    assert mailkit.unsubscribe_options("<https://user:pw@list.com/u>") == {}
    assert mailkit.unsubscribe_options("") == {}
    for local in (
        "https://localhost:8765/pair",
        "https://127.0.0.1/u",
        "https://192.168.1.1/admin",
        "https://10.0.0.5/u",
        "https://router.local/u",
        "https://nas.lan/u",
    ):  # never this Mac or the local network, one-click or not
        assert mailkit.unsubscribe_options(f"<{local}>", "List-Unsubscribe=One-Click") == {}
    assert mailkit.unsubscribe_options("<https://93.184.216.34/u>") == {
        "web": "https://93.184.216.34/u"
    }


def test_accounts_are_picked_by_address_or_name():
    accounts = mailkit.parse_accounts(
        '[{"name": "iCloud", "full": "Robert Doe", "emails": ["Me@iCloud.com"]},'
        ' {"name": "Work", "full": "", "emails": ["robert@work.com"]}, "junk"]'
    )
    assert mailkit.pick_account(accounts, "me@icloud.com") == (
        "Robert Doe <me@icloud.com>",
        "me@icloud.com",
    )
    assert mailkit.pick_account(accounts, "work") == ("robert@work.com", "robert@work.com")
    assert "No Mail account matches" in mailkit.pick_account(accounts, "gmail")
    assert mailkit.pick_account([], "x") == "Mail has no accounts I can send from."


def test_message_ids_and_senders_are_read_carefully():
    assert mailkit.clean_id(" <abc@x.com> ") == "abc@x.com"
    assert mailkit.clean_id("has space@x") == "" and mailkit.clean_id("") == ""
    assert mailkit.split_sender('"Ann Lee" <Ann@X.com>') == ("Ann Lee", "ann@x.com")
    assert mailkit.split_sender("ann@x.com") == ("", "ann@x.com")


# ── Messages' database ──


class Chats:
    """A synthetic chat.db: chats with guids and members, and the owner's sent messages."""

    def __init__(self, path):
        self.path = path
        db = sqlite3.connect(path)
        db.executescript(
            """
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT,
                is_from_me INTEGER DEFAULT 0, handle_id INTEGER, is_delivered INTEGER DEFAULT 0,
                is_sent INTEGER DEFAULT 0, error INTEGER DEFAULT 0, date INTEGER DEFAULT 0);
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT,
                chat_identifier TEXT, style INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            INSERT INTO handle VALUES (1, '+14155550101'), (2, 'mom@x.com');
            INSERT INTO chat VALUES (1, 'iMessage;+;chat9', 'Family', 'chat9', 43),
                (2, 'iMessage;-;+14155550101', '', '+14155550101', 45);
            INSERT INTO chat_handle_join VALUES (1, 1), (1, 2), (2, 1);
            """
        )
        db.commit()
        db.close()

    def sent(self, *, chat=None, handle=1, delivered=0, is_sent=1, error=0):
        db = sqlite3.connect(self.path)
        try:
            cur = db.execute(
                "INSERT INTO message (text, is_from_me, handle_id, is_delivered, is_sent, error)"
                " VALUES ('hi', 1, ?, ?, ?, ?)",
                (0 if chat else handle, delivered, is_sent, error),
            )
            if chat:
                db.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat, cur.lastrowid))
            db.commit()
            return cur.lastrowid
        finally:
            db.close()

    def update(self, rowid, **values):
        db = sqlite3.connect(self.path)
        try:
            for key, value in values.items():
                db.execute(f"UPDATE message SET {key} = ? WHERE ROWID = ?", (value, rowid))
            db.commit()
        finally:
            db.close()


def test_groups_and_delivery_come_from_messages_own_record(tmp_path):
    chats = Chats(tmp_path / "chat.db")
    groups = textkit.groups_from_db(chats.path)
    assert [(g.guid, g.name, g.handles) for g in groups] == [
        ("iMessage;+;chat9", "Family", ["+14155550101", "mom@x.com"])
    ]
    before = textkit.newest_row(chats.path)
    assert textkit.sent_status(chats.path, before, handle="+1 (415) 555-0101") is None
    row = chats.sent(handle=1)
    status = textkit.sent_status(chats.path, before, handle="+1 (415) 555-0101")
    assert status == {"rows": 1, "delivered": False, "sent": True, "error": 0}
    chats.update(row, is_delivered=1)
    assert textkit.sent_status(chats.path, before, handle="4155550101")["delivered"]
    group_row = chats.sent(chat=1, error=22)
    status = textkit.sent_status(chats.path, row, chat="iMessage;+;chat9")
    assert status["error"] == 22 and group_row > row
    assert textkit.sent_status(tmp_path / "none.db", 0, handle="x") is None
    assert textkit.newest_row(tmp_path / "none.db") == -1


def test_group_names_match_whole_then_by_words():
    groups = [
        textkit.Group("a", "Family", []),
        textkit.Group("b", "Family Trip", []),
        textkit.Group("c", "Book Club", []),
    ]
    assert [g.guid for g in textkit.match_groups(groups, "  FAMILY ")] == ["a"]
    assert [g.guid for g in textkit.match_groups(groups, "trip family")] == ["b"]
    assert textkit.match_groups(groups, "") == []
    assert [
        g.name for g in textkit.parse_groups('[{"id": "x", "name": "Crew", "handles": ["a"]}, 3]')
    ] == ["Crew"]


# ── the hub's side (features/comms.py) ──


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


async def card_on(hub):
    """The approval card that's up, once it is (a tool may read a file first)."""
    for _ in range(200):
        if hub.approvals:
            return next(iter(hub.approvals.values()))
        await asyncio.sleep(0.01)
    raise AssertionError("no card went up")


def comms_for(hub, tmp_path, **kw):
    kw.setdefault("chat_db", tmp_path / "chat.db")
    kw.setdefault("made", lambda: [])
    kw.setdefault("notify", lambda _alert: None)
    return comms_feature.Comms(hub, **kw)


async def test_the_feature_takes_the_messages_servers_place(
    settings, quiet_speaker, isolated, monkeypatch
):
    built = []

    def spy(approve, extras=None, lookup=None):
        built.append(extras)
        return {"type": "sdk", "name": "messages"}

    monkeypatch.setattr(messaging, "build_server", spy)
    hub = make_hub(settings, quiet_speaker, isolated)
    servers = hub._feature_servers()
    assert servers["messages"] == {"type": "sdk", "name": "messages"}
    assert isinstance(built[-1], messaging.Extras)
    assert "mail" in servers
    assert "search_mail" in hub._feature_prompt()
    names = {t.name for t in messaging.build_tools(hub.send_gate, lookup, extras=built[-1])}
    assert {
        "send_message",
        "send_email",
        "find_contact",
        "reply_email",
        "send_group_message",
    } <= names


async def test_delivery_waits_for_messages_and_a_later_failure_is_a_heads_up(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    monkeypatch.setattr(comms_feature, "DELIVERY_WAIT", 0.3)
    alerts = []
    hub = make_hub(settings, quiet_speaker, isolated)
    chats = Chats(tmp_path / "chat.db")
    c = comms_for(hub, tmp_path, notify=alerts.append)
    before = await c.baseline()
    assert await c.delivered(before, "+14155550101", "", "Bob") == ("Sent to Bob.", False)
    row = chats.sent(handle=1, delivered=1)
    assert await c.delivered(before, "+14155550101", "", "Bob") == ("Delivered to Bob.", False)
    chats.update(row, is_delivered=0)
    said, failed = await c.delivered(before, "+14155550101", "", "Bob")
    assert said == "Sent to Bob; not delivered yet. I'll tell you if it fails." and not failed

    async def instant(_seconds):
        chats.update(row, error=4)

    monkeypatch.setattr(comms_feature.asyncio, "sleep", instant)
    await asyncio.gather(*c._watching)
    assert [a.text for a in alerts] == ["Your message to Bob didn't go through (Messages error 4)."]
    assert alerts[0].note == "a text the user sent didn't go through"  # never the text itself


async def test_attach_uses_the_owners_words_this_turn(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    doc = tmp_path / "Desktop" / "Budget.xlsx"
    doc.parent.mkdir(parents=True)
    doc.write_text("x")
    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path)
    hub._turn_text = "email the budget to Ann"
    assert await c.attach([str(doc)], True) == ([doc.resolve()], "")
    hub._turn_text = "email Ann what's on my desktop"
    files, why = await c.attach([str(doc)], True)
    assert files == [] and "You didn't name Budget.xlsx" in why


async def test_search_mail_finds_a_contacts_email_by_name(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    index = EnvelopeIndex(tmp_path / "Envelope Index")
    index.add("ann.lee@work.com", "A. Lee", "Budget", summary="Numbers inside")

    async def people(query):
        return [
            {
                "name": "Ann Lee",
                "phones": [],
                "emails": [{"label": "w", "value": "ann.lee@work.com"}],
            }
        ]

    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path, mail_db=lambda: index.path, lookup=people)
    out = await c.search({"person": "Ann", "limit": 1})
    assert "A. Lee <ann.lee@work.com> — Budget" in out["content"][0]["text"]
    out = await c.search({"person": "Ann", "subject": "holiday"})
    assert out["content"][0]["text"] == "No email from Ann about holiday in the last 365 days."
    c.mail_db = lambda: None
    out = await c.search({"subject": "x"})
    assert out["is_error"] and "Full Disk Access" in out["content"][0]["text"]


async def test_triage_asks_first_unless_the_owner_just_asked(
    settings, quiet_speaker, isolated, tmp_path
):
    index = EnvelopeIndex(tmp_path / "Envelope Index")
    first = index.add("news@shop.com", "Shop", "Big sale")
    ran = []

    async def run(script, *args, **_kw):
        ran.append((script, args))
        return "".join(f"ok\t{i}\n" for i in args[1].split("\n"))

    hub = make_hub(settings, quiet_speaker, isolated)
    hub._say = lambda _text: None
    c = comms_for(hub, tmp_path, run=run, mail_db=lambda: index.path)
    hub._turn_text = "archive the shop email"
    out = await c.triage({"message_ids": [first], "action": "archive"})
    assert out["content"][0]["text"] == "Archived 1 email." and not hub.approvals
    assert ran == [(mailkit.TRIAGE_SCRIPT, ("archive", first))]

    hub._turn_text = "what's in my inbox?"
    pending = asyncio.create_task(c.triage({"message_ids": [first], "action": "mark_read"}))
    card = await card_on(hub)
    assert card["question"] == "Mark this email as read?"
    assert card["detail"] == "Shop <news@shop.com> — Big sale"
    assert [c["label"] for c in card["choices"]] == ["Mark as read", "Not now"]
    hub.resolve(card["id"], "deny")
    out = await pending
    assert out["is_error"] and len(ran) == 1


async def test_triage_reports_what_it_could_not_do(settings, quiet_speaker, isolated, tmp_path):
    async def run(script, *args, **_kw):
        return "ok\ta@x\nmissing\tb@x\nerror\tc@x\tits account has no Archive mailbox\n"

    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path, run=run)
    hub._turn_text = "archive these three"
    out = await c.triage({"message_ids": ["a@x", "b@x", "c@x"], "action": "archive"})
    assert out["content"][0]["text"] == (
        "Archived 1 email. 1 weren't in the inbox any more. 1 couldn't be changed "
        "(its account has no Archive mailbox)."
    )


async def test_unsubscribe_shows_how_first_and_only_then_acts(
    settings, quiet_speaker, isolated, tmp_path
):
    posted, ran = [], []

    async def jxa(script, *argv, **_kw):
        if script == mailkit.FIND_JXA:
            import json

            return json.dumps(
                {
                    "found": True,
                    "sender": "Deals <deals@shop.com>",
                    "subject": "Sale",
                    "to": [{"address": "robert@work.com"}],
                    "cc": [],
                    "unsubscribe": "<mailto:out@shop.com>, <https://shop.com/u/1>",
                    "post": "List-Unsubscribe=One-Click",
                }  # fmt: skip
            )
        return '[{"name": "Work", "full": "Robert Doe", "emails": ["robert@work.com"]}]'

    async def run(script, *args, **_kw):
        ran.append((script, args))
        return ""

    hub = make_hub(settings, quiet_speaker, isolated)
    hub._say = lambda _text: None
    c = comms_for(hub, tmp_path, jxa=jxa, run=run, post=lambda url: posted.append(url) or 200)
    pending = asyncio.create_task(c.unsubscribe({"message_id": "<x1@shop.com>"}))
    card = await card_on(hub)
    assert card["question"] == "Unsubscribe from Deals?"
    assert "one-click unsubscribe request to shop.com:\nhttps://shop.com/u/1" in card["detail"]
    assert posted == []  # nothing before the yes
    hub.resolve(card["id"], "allow")
    out = await pending
    assert out["content"][0]["text"] == "Unsubscribed from Deals: the list accepted the request."
    assert posted == ["https://shop.com/u/1"] and ran == []


async def test_unsubscribe_by_email_goes_from_the_account_it_came_to(
    settings, quiet_speaker, isolated, tmp_path
):
    ran = []

    async def jxa(script, *argv, **_kw):
        if script == mailkit.FIND_JXA:
            import json

            return json.dumps(
                {
                    "found": True,
                    "sender": "List <l@x.com>",
                    "subject": "News",
                    "to": [{"address": "robert@work.com"}],
                    "cc": [],
                    "unsubscribe": "<mailto:out@x.com?subject=stop>",
                    "post": "",
                }  # fmt: skip
            )
        return '[{"name": "Work", "full": "Robert Doe", "emails": ["robert@work.com"]}]'

    async def run(script, *args, **_kw):
        ran.append((script, args))
        return ""

    hub = make_hub(settings, quiet_speaker, isolated)
    hub._say = lambda _text: None
    c = comms_for(hub, tmp_path, jxa=jxa, run=run)
    pending = asyncio.create_task(c.unsubscribe({"message_id": "n1@x.com"}))
    card = await card_on(hub)
    assert "I'll email out@x.com from your account, subject “stop”." in card["detail"]
    hub.resolve(card["id"], "allow")
    assert (await pending)["content"][0]["text"] == "Emailed the unsubscribe request for List."
    assert ran == [(mailkit.SEND_SCRIPT, ("out@x.com", "", "", "stop", "unsubscribe",
                                          "Robert Doe <robert@work.com>", ""))]  # fmt: skip


async def test_a_test_hub_never_runs_a_real_script(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert isinstance(hub.comms, comms_feature.Comms)
    with pytest.raises(mac_tools.ToolFailure):
        await hub.comms.run('tell application "Mail" to quit')
    assert hub.comms.mail_db() is None
    assert await hub.comms.find_email("x@y") == "Mail couldn't look that email up: not on this hub"


async def test_group_chats_come_from_messages_itself_without_full_disk_access(
    settings, quiet_speaker, isolated, tmp_path
):
    async def jxa(script, *argv, **_kw):
        assert script == textkit.GROUPS_JXA
        return '[{"id": "iMessage;+;chat5", "name": "Crew", "handles": ["+14155550101", "a@b.c"]}]'

    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path, jxa=jxa, contact_names=lambda: {"4155550101": "Bob Ray"})
    groups = await c.groups()  # no chat.db here: Messages' own list
    assert [(g.guid, g.name) for g in groups] == [("iMessage;+;chat5", "Crew")]
    assert await c.group_names(groups[0].handles) == {"+14155550101": "Bob Ray"}


async def test_mail_accounts_are_asked_for_once_in_a_while(
    settings, quiet_speaker, isolated, tmp_path
):
    asked = []

    async def jxa(script, *argv, **_kw):
        asked.append(script)
        return '[{"name": "iCloud", "full": "", "emails": ["me@icloud.com"]}]'

    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path, jxa=jxa)
    assert (await c.accounts())[0]["emails"] == ["me@icloud.com"]
    await c.accounts()
    assert asked == [mailkit.ACCOUNTS_JXA]


def test_every_card_and_label_has_its_chinese():
    """What the window shows of email and texts, and the Activity drawer's labels, have
    Chinese in the merged window strings (web/i18n/comms.json over i18n-zh.json)."""
    import re

    from jarvis.server import zh_strings

    merged = zh_strings()

    def chinese(text):
        if text in merged["strings"]:
            return merged["strings"][text]
        for pattern, replacement in merged["patterns"]:
            if re.match(pattern, text):
                return re.sub(pattern, replacement.replace("$", "\\"), text)
        return None

    shown = [
        "Reply to Ann Lee about Re: Q3 plan?",
        "Message the group “Family”?",
        "Email Ann Lee about Plan?",
        "Archive this email?",
        "Archive 3 emails?",
        "Flag 2 emails?",
        "Unflag this email?",
        "Mark 4 emails as read?",
        "Mark this email as unread?",
        "Unsubscribe from Deals?",
        "Archive",
        "Mark as read",
        "Unsubscribe",
        "Keep it",
        "Your message to Bob didn't go through (Messages error 4).",
        *comms_feature.LABELS.values(),
    ]
    missing = [text for text in shown if not chinese(text)]
    assert missing == []
    assert chinese("Message the group “Family”?") == "要给群聊“Family”发这条消息吗？"


def test_a_spoken_card_reads_in_chinese_line_by_line():
    from jarvis import lang

    spoken = (
        "It also goes to Bob Ray.\nWith 2 attachments.\nFrom your Work account.\n"
        "Here's your reply to Ann Lee, subject: Re: Plan. Looks good. Do you want this reply sent?"
    )
    assert lang.translate(spoken, "zh").split("\n") == [
        "这封邮件也会发给Bob Ray。",
        "附带2个附件。",
        "从你的“Work”账户发出。",
        "这是你给Ann Lee的回复，主题：Re: Plan. Looks good. 要发送这条回复吗？",
    ]
    group = "Here's your message to the group Family. Dinner at 7. Do you want this message sent?"
    assert (
        lang.translate(group, "zh") == "这是你发到群聊Family的消息：Dinner at 7. 要发送这条消息吗？"
    )


async def test_without_messages_record_a_send_never_waits(
    settings, quiet_speaker, isolated, tmp_path
):
    import time as clock

    hub = make_hub(settings, quiet_speaker, isolated)
    c = comms_for(hub, tmp_path / "nowhere")  # no chat.db: no Full Disk Access
    assert await c.baseline() == -1
    started = clock.monotonic()
    assert await c.delivered(-1, "+14155550101", "", "Bob") == ("Sent to Bob.", False)
    assert clock.monotonic() - started < 1.0


# ── what the scripts are handed ──


async def test_a_message_id_or_a_name_that_starts_with_a_dash_is_data_to_the_script(monkeypatch):
    """osascript takes an argument after "-e script" that starts with "-e" as more script to
    run (osascript -l JavaScript -e 'function run(a){…}' '-efunction run(){…}' runs the
    second), and a Message-ID is the sender's to write: so every argument goes after "--",
    where osascript hands it to the script as argv whatever it looks like."""
    ran = []

    async def run_command(*args, stdin=None, timeout=30):
        ran.append(args)
        return "[]"

    monkeypatch.setattr(mac_tools, "run_command", run_command)
    evil = "-ea=Application.currentApplication();a.includeStandardAdditions=true;a.doShellScript('id')//@x"
    assert mailkit.clean_id(f"<{evil}>") == evil  # a Message-ID may start with a dash
    await comms_feature._jxa(mailkit.FIND_JXA, evil, "1")
    await messaging.find_contacts("-eMARKER")
    for args in ran:
        script = args.index("-e") + 1
        assert args[script + 1] == "--" and args[script + 2].startswith("-e"), args
    assert [a[-2:] for a in ran] == [(evil, "1"), ("--", "-eMARKER")]
