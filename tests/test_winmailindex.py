"""The index of a PC's email (winmailindex.py): the owner's accounts read, over a real IMAP
connection to the test server, into the shape of Mail's own index; and that index read by the
real heads-up engine (interrupts.py) the way it reads Mail's."""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from mailserver import TestMail, make_raw, when

from jarvis import mailbox, winmailindex
from jarvis.interrupts import Interrupter
from jarvis.mailbox import Account
from jarvis.mailkit import _mailbox_kind


@pytest.fixture
def server():
    s = TestMail()
    try:
        yield s
    finally:
        s.close()


def account_for(server, address="ann@test.example", **kw) -> Account:
    base = dict(
        id=address, address=address, name="Ann Test",
        imap_host="127.0.0.1", imap_port=server.imap_port, imap_security="none",
        smtp_host="127.0.0.1", smtp_port=server.smtp_port, smtp_security="none",
    )  # fmt: skip
    base.update(kw)
    return Account(**base)


def sync(index, account, *, sent=True, now=None):
    with mailbox.Imap(account, "app-password") as imap:
        return index.sync(account, imap, sent=sent, now=now)


def rows(index, sql="SELECT * FROM messages ORDER BY ROWID"):
    conn = sqlite3.connect(index.path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql)]
    finally:
        conn.close()


def mail(
    subject, body="Please look at this.", *, sender="Bea Lopez <bea@x.example>", age=0.0, **kw
):
    return make_raw(sender, "ann@test.example", subject, body, date=when(age), **kw)


@pytest.fixture
def index(tmp_path):
    return winmailindex.Index(tmp_path / "mail_index.sqlite")


def test_what_is_waiting_the_first_time_is_old_news_stored_as_read(server, index):
    for n in range(3):
        server.store.add("INBOX", mail(f"Old {n}", age=0.01))
    assert sync(index, account_for(server)) == 0
    found = rows(index)
    assert len(found) == 3 and all(r["read"] == 1 for r in found)
    assert index.ready()


def test_new_mail_is_unread_and_carries_a_preview_without_the_quoted_thread(server, index):
    sync(index, account_for(server))
    server.store.add(
        "INBOX",
        mail(
            "Lunch Friday",
            "Are you free at noon?\r\n\r\nOn Mon, Bea wrote:\r\n> earlier text",
            extra="List-Unsubscribe: <mailto:off@x.example>",
        ),
    )
    assert sync(index, account_for(server)) == 1
    (row,) = rows(index)
    assert row["read"] == 0 and row["unsubscribe_type"] == 1 and row["list_id_hash"] == 1
    got = rows(
        index,
        """SELECT a.address, a.comment, s.subject, su.summary, g.message_id_header FROM messages m
           JOIN addresses a ON m.sender = a.ROWID JOIN subjects s ON m.subject = s.ROWID
           JOIN summaries su ON m.summary = su.ROWID
           JOIN message_global_data g ON m.global_message_id = g.ROWID""",
    )[0]
    assert (got["address"], got["comment"], got["subject"]) == (
        "bea@x.example",
        "Bea Lopez",
        "Lunch Friday",
    )
    assert got["summary"] == "Are you free at noon?" and got["message_id_header"].startswith("<")


def test_a_passes_second_look_adds_nothing_twice(server, index):
    sync(index, account_for(server))
    server.store.add("INBOX", mail("Once"))
    assert sync(index, account_for(server)) == 1
    assert sync(index, account_for(server)) == 0
    assert len(rows(index)) == 1


def test_mail_that_turns_up_long_after_it_was_sent_is_old_news(server, index):
    sync(index, account_for(server))
    server.store.add("INBOX", mail("From last week", age=7))
    assert sync(index, account_for(server)) == 0
    assert rows(index)[0]["read"] == 1


def test_what_the_owner_read_elsewhere_is_no_longer_news(server, index):
    sync(index, account_for(server))
    uid = server.store.add("INBOX", mail("Read on the phone"))
    assert sync(index, account_for(server)) == 1 and rows(index)[0]["read"] == 0
    server.store.message("INBOX", uid)["flags"].add("\\Seen")
    sync(index, account_for(server))
    assert rows(index)[0]["read"] == 1


def test_the_sent_folder_tells_who_the_owner_writes_to(server, index):
    server.store.add(
        "Sent",
        make_raw(
            "Ann Test <ann@test.example>",
            "Prof. Cy Dane <cy@u.example>, plain@z.example",
            "Draft chapter",
            "I will send the draft on Friday.",
            date=when(1),
        ),
    )
    sync(index, account_for(server))
    names = index.names(own=["ann@test.example"])
    assert names == {"cy@u.example": "Prof. Cy Dane", "plain@z.example": "plain@z.example"}
    sent = rows(
        index, "SELECT m.read, su.summary FROM messages m JOIN summaries su ON m.summary = su.ROWID"
    )
    assert sent[0]["summary"] == "I will send the draft on Friday."


def test_sent_mail_can_be_left_for_a_later_pass(server, index):
    server.store.add("Sent", mail("Sent one"))
    sync(index, account_for(server), sent=False)
    assert index.names() == {}


def test_an_address_that_spells_sent_does_not_turn_the_inbox_into_the_sent_folder(server, index):
    odd = account_for(server, "consent@inbox.example")
    server.store.users["consent@inbox.example"] = "app-password"
    server.store.add("INBOX", mail("Hello"))
    sync(index, odd)
    kinds = {_mailbox_kind(r["url"]) for r in rows(index, "SELECT url FROM mailboxes")}
    assert kinds == {"inbox", "sent"}
    assert winmailindex.box_url(odd, "inbox").endswith("/INBOX")
    assert winmailindex.box_url(odd, "sent").endswith("/Sent")
    assert "sent" not in winmailindex.box_url(odd, "inbox").lower()
    assert "inbox" not in winmailindex.box_url(odd, "sent").lower()


def test_an_account_that_is_removed_takes_its_mail_with_it(server, index):
    server.store.add("Sent", mail("Mine"))
    sync(index, account_for(server))
    assert rows(index) and index.names()
    index.forget(account_for(server))
    assert rows(index) == [] and index.names() == {}


def test_mail_older_than_the_index_keeps_is_dropped_and_row_numbers_are_not_reused(server, index):
    sync(index, account_for(server))
    server.store.add("INBOX", mail("Recent"))
    sync(index, account_for(server))
    first = rows(index)[0]["ROWID"]
    later = datetime.now(UTC) + timedelta(days=winmailindex.KEEP_DAYS + 5)
    sync(index, account_for(server), now=later)
    assert rows(index) == []
    server.store.add("INBOX", mail("After", age=-0.0))
    sync(index, account_for(server), now=later + timedelta(minutes=1))
    assert all(r["ROWID"] > first for r in rows(index))


def test_the_index_is_not_ready_until_it_has_mail(tmp_path):
    assert not winmailindex.Index(tmp_path / "none.sqlite").ready()


# ── the real heads-up engine reading it ──


def watcher(index, alerts, **kw):
    return Interrupter(
        alerts.append,
        state_path=index.path.with_name("interrupts.json"),
        chat_db=None,
        mail_db=index.path,
        vips=lambda: ["bea@x.example"],
        mode=lambda: "all",
        **kw,
    )


def test_the_heads_up_engine_tells_the_owner_of_a_vips_new_email_and_not_of_old_mail(server, index):
    server.store.add("INBOX", mail("Old news", age=0.01))
    sync(index, account_for(server))
    alerts: list = []
    watch = watcher(index, alerts)

    async def go():
        assert await watch.poll() == []  # the first look: what is there is old news
        server.store.add("INBOX", mail("Urgent: the exam room changed", "Please call me back now."))
        assert sync(index, account_for(server)) == 1
        return await watch.poll()

    told = asyncio.run(go())
    assert len(told) == 1 and len(alerts) == 1
    assert "Bea" in alerts[0].text or "bea@x.example" in alerts[0].text
    assert watch.access["mail"] == "watching"


def test_email_from_people_the_owner_has_written_to_counts_as_known(server, index):
    server.store.add("Sent", mail("Hi Cy", sender="Ann Test <ann@test.example>"))
    sync(index, account_for(server))
    names = index.names(own=["ann@test.example"])
    assert "bea@x.example" not in names
    server.store.add(
        "Sent",
        make_raw(
            "Ann Test <ann@test.example>",
            "Bea Lopez <bea@x.example>",
            "Re: plan",
            "ok",
            date=when(0.5),
        ),
    )
    sync(index, account_for(server))
    assert index.names(own=["ann@test.example"])["bea@x.example"] == "Bea Lopez"


def test_a_server_that_asks_for_everything_each_time_still_gives_no_duplicates(server, index):
    """(The incremental search is a request: a server may answer with more.)"""
    sync(index, account_for(server))
    for n in range(3):
        server.store.add("INBOX", mail(f"Message {n}"))
        sync(index, account_for(server))
    assert [r["uid"] for r in rows(index)] == sorted({r["uid"] for r in rows(index)})
    assert len(rows(index)) == 3


# ── an Outlook-shaped mailbox (everything but mailbox.Imap) is asked for all, not the newer ──


class SearchOnly:
    """Answers only the IMAP-like questions: select, search, fetch, special."""

    def __init__(self, account, inbox):
        self.account, self.inbox, self.asked = account, inbox, []

    def select(self, folder="INBOX", readonly=True):
        self.folder = folder
        return len(self.inbox)

    def search(self, *criteria):
        self.asked.append(criteria)
        if "UNSEEN" in criteria:
            return sorted(u for u, m in self.inbox.items() if m["unread"])
        return sorted(self.inbox)

    def fetch(self, uids, what):
        return {
            u: {
                "flags": [] if self.inbox[u]["unread"] else ["\\seen"],
                "data": self.inbox[u]["raw"],
            }
            for u in uids
            if u in self.inbox
        }

    def special(self, use):
        return ""


class OutlookLike(SearchOnly):
    """Like winoutlook_mail.OutlookMailbox: it can say its newest messages and which are unread cheaply."""

    def newest(self, count):
        self.asked.append(("newest", count))
        return sorted(self.inbox)[-count:]

    def still_unread(self, numbers):
        self.asked.append(("still_unread", tuple(numbers)))
        return [n for n in numbers if self.inbox.get(n, {}).get("unread")]


def test_an_outlook_shaped_mailbox_is_asked_cheap_questions(index):
    acct = Account(id="outlook", address="ann@u.example", kind="outlook")
    box = OutlookLike(acct, {1: {"unread": True, "raw": mail("Old", age=0.02)}})
    assert index.sync(acct, box) == 0
    box.inbox[2] = {"unread": True, "raw": mail("New")}
    assert index.sync(acct, box) == 1
    assert [r["read"] for r in rows(index)] == [1, 0]
    assert ("newest", winmailindex.INBOX_LOOK) in box.asked
    assert not any(c[0] in ("ALL", "UNSEEN") or "UID" in c for c in box.asked)
    box.inbox[2]["unread"] = False  # read in Outlook
    index.sync(acct, box)
    assert ("still_unread", (2,)) in box.asked
    assert [r["read"] for r in rows(index)] == [1, 1]
    assert all(_mailbox_kind(r["url"]) == "inbox" for r in rows(index, "SELECT url FROM mailboxes"))
    assert rows(index, "SELECT url FROM mailboxes")[0]["url"].startswith("outlook://")


def test_a_mailbox_that_only_searches_is_read_by_searching(index):
    acct = Account(id="o2", address="o2@u.example", kind="outlook")
    box = SearchOnly(acct, {1: {"unread": True, "raw": mail("Old", age=0.02)}})
    assert index.sync(acct, box) == 0
    box.inbox[2] = {"unread": True, "raw": mail("New")}
    assert index.sync(acct, box) == 1
    assert ("ALL",) in box.asked and ("UNSEEN",) in box.asked
    assert [r["read"] for r in rows(index)] == [1, 0]


def test_the_backoff_leaves_a_failed_account_alone_for_a_while():
    now = [0.0]
    wait = winmailindex.Backoff(clock=lambda: now[0])
    assert not wait.waiting("a")
    wait.failed("a", 10)
    assert wait.waiting("a")
    now[0] = 601
    assert not wait.waiting("a")
    wait.failed("a", 1)
    wait.ok("a")
    assert not wait.waiting("a")


def test_a_message_nobody_can_parse_is_skipped_not_fatal(index, monkeypatch):
    acct = Account(id="o", address="o@u.example", kind="outlook")
    box = OutlookLike(acct, {1: {"unread": True, "raw": mail("Old", age=0.02)}})
    index.sync(acct, box)
    box.inbox[2] = {"unread": True, "raw": mail("Bad")}
    box.inbox[3] = {"unread": True, "raw": mail("Good")}
    real = mailbox.parse_full

    def picky(account, folder, uid, flags, raw):
        if uid == 2:
            raise ValueError("no")
        return real(account, folder, uid, flags, raw)

    monkeypatch.setattr(mailbox, "parse_full", picky)
    assert index.sync(acct, box) == 1
    assert [r["uid"] for r in rows(index)] == [1, 3]


def test_mail_too_old_to_keep_is_never_stored_nor_asked_for_again(index):
    acct = Account(id="o3", address="o3@u.example", kind="outlook")
    box = OutlookLike(
        acct,
        {
            1: {"unread": False, "raw": mail("Ancient", age=90)},
            2: {"unread": False, "raw": mail("Older still", age=100)},
        },
    )
    fetched = []
    real = box.fetch
    box.fetch = lambda uids, what: fetched.append(tuple(uids)) or real(uids, what)
    index.sync(acct, box)
    assert rows(index) == [] and fetched == [(1, 2)]  # (looked at once, and let go)
    index.sync(acct, box)
    index.sync(acct, box)
    assert fetched == [(1, 2)]
    box.inbox[3] = {"unread": True, "raw": mail("Arrived just now")}
    assert index.sync(acct, box) == 1  # and what comes after is still seen
    assert [r["uid"] for r in rows(index)] == [3]


def test_pruning_leaves_nothing_behind_that_only_the_dropped_mail_used(server, index):
    sync(index, account_for(server))
    server.store.add("INBOX", mail("Soon gone"))
    server.store.add(
        "Sent",
        make_raw("Ann <ann@test.example>", "Cy <cy@u.example>", "Gone too", "x", date=when(1)),
    )
    sync(index, account_for(server))
    for table in (
        "messages",
        "subjects",
        "summaries",
        "message_global_data",
        "recipients",
        "addresses",
    ):
        assert rows(index, f"SELECT * FROM {table}"), table  # (all there while the mail is)
    later = datetime.now(UTC) + timedelta(days=winmailindex.KEEP_DAYS + 5)
    sync(index, account_for(server), now=later)
    for table in (
        "messages",
        "subjects",
        "summaries",
        "message_global_data",
        "recipients",
        "addresses",
    ):
        assert rows(index, f"SELECT * FROM {table}") == [], table


def test_mail_that_was_there_before_the_first_look_is_never_news_even_if_it_only_now_comes_into_view(
    index,
):
    acct = Account(id="o4", address="o4@u.example", kind="outlook")
    box = OutlookLike(acct, {1: {"unread": True, "raw": mail("Seen at the first look", age=0.01)}})
    assert index.sync(acct, box) == 0
    # (pushed into view later, by others being filed away: it has a new, higher number, but it is hours old)
    box.inbox[7] = {"unread": True, "raw": mail("Was always there", age=0.2)}
    assert index.sync(acct, box) == 0
    assert {r["uid"]: r["read"] for r in rows(index)} == {1: 1, 7: 1}
    box.inbox[8] = {"unread": True, "raw": mail("Just came")}
    assert index.sync(acct, box) == 1  # and what comes after the first look still is news


def test_a_message_sent_just_before_the_first_look_and_delivered_after_it_is_still_news(index):
    acct = Account(id="o5", address="o5@u.example", kind="outlook")
    box = OutlookLike(acct, {1: {"unread": False, "raw": mail("Old", age=1)}})
    index.sync(acct, box)
    box.inbox[2] = {"unread": True, "raw": mail("Sent a minute before, delivered now", age=0.0007)}
    assert index.sync(acct, box) == 1


class ByAge(OutlookLike):
    """Numbers that say nothing of age (Outlook's: the first look goes newest first), the mailbox giving them in
    the order of age."""

    def newest(self, count):
        self.asked.append(("newest", count))
        return [10, 3, 5, 4][-count:]  # oldest first: 10 is the oldest, 4 the newest


def test_the_newest_are_taken_by_age_not_by_number(index, monkeypatch):
    monkeypatch.setattr(winmailindex, "INBOX_LOOK", 2)
    acct = Account(id="o6", address="o6@u.example", kind="outlook")
    inbox = {n: {"unread": False, "raw": mail(f"M{n}", age=0.01)} for n in (10, 3, 5, 4)}
    box = ByAge(acct, inbox)
    index.sync(acct, box)
    assert sorted(r["uid"] for r in rows(index)) == [
        4,
        5,
    ]  # the two newest, though 10 is the biggest number
