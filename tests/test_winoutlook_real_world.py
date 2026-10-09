# ruff: noqa: F811 - the stand-in's fixtures are imported and then named as arguments
"""Outlook as it really behaves, where the stand-in of test_winoutlook_mail.py is too kind: the numbers a message is
given say nothing of its age, Outlook says "busy", a folder holds thousands of messages, people's plain
addresses live in MAPI properties, a new message begins with the person's own font, and sending can hang.
Each of these was a way for the first version to be wrong with a real Outlook (found by a review that read the
code against Microsoft's documentation); nothing here needs Outlook."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from test_winoutlook_mail import (  # noqa: F401 - the stand-in's pieces, and its fixtures
    Attachment,
    Compose,
    Entry,
    Items,
    Mail,
    Recipient,
    accessor_for,
    account,
    app,
    box_for,
    message,
)

from jarvis import mailbox, mailtools
from jarvis import winoutlook_mail as wom
from jarvis.mailbox import MailError

LONG_AGO = datetime.now() - timedelta(days=1)


def fill(app, count, *, days_each=1):
    """An inbox of `count` messages, Subject 0 the oldest and the last the newest."""
    inbox = app.ns.folders[6]
    inbox.messages.clear()
    now = datetime.now()
    for k in range(count):
        inbox.put(
            Mail(
                f"M{k}",
                f"Subject {k}",
                f"Person {k}",
                f"p{k}@x.example",
                now - timedelta(days=(count - k) * days_each),
                body=f"Words {k}",
            )
        )


# ── the numbers say nothing of age ──


def test_a_listing_gives_the_newest_even_though_the_first_look_numbers_them_newest_first(
    app, account, tmp_path
):
    fill(app, 40)
    with box_for(account, app, tmp_path) as box:
        listed = mailbox.list_messages(box, "INBOX", 5)
        assert [s.subject for s in listed] == [f"Subject {k}" for k in (39, 38, 37, 36, 35)]
        # (the same from a second look, when the numbers are all given)
        again = mailbox.list_messages(box, "INBOX", 5)
        assert [s.subject for s in again] == [s.subject for s in listed]
        everything = box.search("ALL")
        newest = box._item(everything[-1])
        assert newest.Subject == "Subject 39"  # (last is the newest, as on a server)
        assert box.newest(3) and box._item(box.newest(3)[-1]).Subject == "Subject 39"
        assert [box._item(n).Subject for n in box.newest(3)] == [
            "Subject 37",
            "Subject 38",
            "Subject 39",
        ]


def test_a_search_gives_the_newest_matches(app, account, tmp_path):
    fill(app, 40)
    with box_for(account, app, tmp_path) as box:
        mailbox.list_messages(box, "INBOX", 40)  # (every message is numbered, newest first)
        found = mailbox.find_messages(box, person="Person 3", limit=2, days=3650)
        assert [s.subject for s in found] == ["Subject 39", "Subject 38"]
        unread = mailbox.list_messages(box, "INBOX", 3, unread_only=True)
        assert [s.subject for s in unread] == ["Subject 39", "Subject 38", "Subject 37"]


def count_steps(monkeypatch):
    steps = []
    real = Items.GetNext

    def counting(self):
        steps.append(1)
        return real(self)

    monkeypatch.setattr(Items, "GetNext", counting)
    return steps


def test_a_plain_listing_walks_only_as_far_as_the_newest_few(app, account, tmp_path, monkeypatch):
    fill(app, 400)
    steps = count_steps(monkeypatch)
    with box_for(account, app, tmp_path) as box:
        assert len(box.search("ALL")) == wom.LISTING
    assert len(steps) <= wom.LISTING + 2  # (not the 400)


def test_a_search_by_date_stops_at_the_first_message_older_than_asked(
    app, account, tmp_path, monkeypatch
):
    fill(app, 300)  # one a day, for 300 days
    steps = count_steps(monkeypatch)
    since = (datetime.now() - timedelta(days=10)).strftime("%d-%b-%Y")
    with box_for(account, app, tmp_path) as box:
        found = box.search("SINCE", since, "SUBJECT", "Subject")
    assert 8 <= len(found) <= 11 and len(steps) <= 14  # (not 300)


def test_the_messages_are_looked_at_one_at_a_time_and_not_kept(app, account, tmp_path):
    fill(app, 30)
    with box_for(account, app, tmp_path) as box:
        box.select("INBOX")
        walk = box._walk()
        first = next(walk)
        assert first.Subject == "Subject 29"  # newest first
        walk.close()


def test_what_outlook_files_as_mail_includes_bounces_and_meeting_answers(app, account, tmp_path):
    class Bounce(Mail):
        Class = 46

    class Answer(Mail):
        Class = 55

    class Appointment(Mail):
        Class = 26  # an appointment is not mail

    inbox = app.ns.folders[6]
    inbox.put(Bounce("B1", "Undeliverable", "Mail Delivery", "mailer@x.example", datetime.now()))
    inbox.put(Answer("B2", "Declined: meeting", "Cy", "cy@x.example", datetime.now()))
    inbox.put(Appointment("B3", "An appointment", "Me", "me@x.example", datetime.now()))
    with box_for(account, app, tmp_path) as box:
        subjects = [s.subject for s in mailbox.list_messages(box, "INBOX", 20)]
    assert "Undeliverable" in subjects and "Declined: meeting" in subjects
    assert "An appointment" not in subjects


# ── Outlook is busy ──


class Busy(Exception):
    def __init__(self, code=-2147418111):  # RPC_E_CALL_REJECTED
        super().__init__(code, "Call was rejected by callee.")
        self.hresult = code


class Flaky:
    def __init__(self, fails, error=None):
        self.fails, self.error = fails, error

    @property
    def Subject(self):  # noqa: N802
        if self.fails:
            self.fails -= 1
            raise self.error or Busy()
        return "worth waiting for"


def test_a_property_outlook_is_too_busy_to_give_is_asked_again_a_moment_later(monkeypatch):
    slept = []
    monkeypatch.setattr(wom.time, "sleep", slept.append)
    assert wom._prop(Flaky(2), "Subject") == "worth waiting for" and len(slept) == 2
    slept.clear()
    # a different kind of trouble is an answer: the default, at once
    assert wom._prop(Flaky(1, KeyError("no")), "Subject", "x") == "x" and slept == []
    # busy for good: given up on after the tries
    assert wom._prop(Flaky(99), "Subject", "gave up") == "gave up"
    assert len(slept) == wom.BUSY_TRIES - 1


def test_a_call_outlook_rejects_is_made_again_and_other_errors_are_not(monkeypatch):
    slept = []
    monkeypatch.setattr(wom.time, "sleep", slept.append)
    calls = []

    def sometimes(value):
        calls.append(value)
        if len(calls) < 3:
            raise Busy(-2147417846)  # RPC_E_SERVERCALL_RETRYLATER
        return value * 2

    assert wom._retrying(sometimes, 21) == 42 and len(slept) == 2

    def broken():
        raise ValueError("a mistake")

    with pytest.raises(ValueError):
        wom._retrying(broken)
    assert wom._busy(Busy()) and not wom._busy(ValueError()) and wom._busy(Busy(-2147418111))


# ── people's plain addresses ──


class WithTags(Mail):
    """A message that keeps its sender's plain address as a MAPI property, as a received one does."""

    def __init__(self, *a, tags=None, **kw):
        super().__init__(*a, **kw)
        self.PropertyAccessor = accessor_for(tags or {})


def test_a_senders_address_comes_from_the_property_kept_on_the_message_not_from_exchange(
    app, account, tmp_path
):
    asked = []

    class Counting(Entry):
        def GetExchangeUser(self):  # noqa: N802
            asked.append(1)
            return super().GetExchangeUser()

    inbox = app.ns.folders[6]
    inbox.messages.clear()
    mail = inbox.put(
        WithTags(
            "T1",
            "From the directory",
            "Dean Ruiz",
            "",
            datetime.now(),
            exchange="never@asked.example",
            tags={wom.PR_SENDER_SMTP: "druiz@school.edu"},
        )
    )
    mail.Sender = Counting("/O=EXCHANGELABS/CN=Dean Ruiz", "EX", "Dean Ruiz", "never@asked.example")
    with box_for(account, app, tmp_path) as box:
        (listed,) = mailbox.list_messages(box, "INBOX", 5)
    assert listed.address == "druiz@school.edu" and listed.sender == "Dean Ruiz"
    assert asked == []  # (no call to Exchange for a person Outlook already holds the address of)


def test_a_recipients_address_is_the_property_kept_on_the_recipient(app, account, tmp_path):
    inbox = app.ns.folders[6]
    inbox.messages.clear()
    mail = inbox.put(Mail("R1", "To staff", "Cy", "cy@x.example", datetime.now()))
    one = Recipient("Prof. Lee", "/O=EXCHANGELABS/CN=Lee", 1, exchange="slow@lookup.example")
    one.PropertyAccessor = accessor_for({wom.PR_SMTP_ADDRESS: "lee@school.edu"})
    mail.Recipients = [one]
    with box_for(account, app, tmp_path) as box:
        (uid,) = box.search("ALL")
        full = mailbox.read_message(box, "INBOX", uid)
    assert full.to == ['"Prof. Lee" <lee@school.edu>']


def test_a_listing_asks_about_only_the_first_few_people_of_a_message_to_everybody(
    app, account, tmp_path
):
    inbox = app.ns.folders[6]
    inbox.messages.clear()
    mail = inbox.put(Mail("R2", "All staff", "Dean", "dean@x.example", datetime.now()))
    mail.Recipients = [Recipient(f"Person {n}", f"p{n}@x.example", 1) for n in range(300)]
    with box_for(account, app, tmp_path) as box:
        (uid,) = box.search("ALL")
        headers = box.fetch([uid], mailbox.HEADER_FIELDS)[uid]["data"].decode()
        whole = box.fetch([uid], "(UID FLAGS BODY.PEEK[])")[uid]["data"].decode()
    assert headers.count("@x.example") <= 2 * wom.HEADER_PEOPLE + 2  # (the sender and a few)
    assert whole.count("@x.example") > 30  # (reading the one email names its people)


def test_sent_mail_is_found_by_the_address_of_who_it_went_to(app, account, tmp_path):
    sent = app.ns.folders[5]
    mail = Mail("S1", "Draft chapter", "Ann Test", "ann@test.example", datetime.now(), to=())
    mail.To = "Prof. Cy Dane"  # (the message's To holds only names)
    mail.Recipients = [Recipient("Prof. Cy Dane", "cy@u.example", 1)]
    sent.put(mail)
    with box_for(account, app, tmp_path) as box:
        box.select("Sent Items")
        assert box.search("TO", "cy@u.example") and box.search("TO", "Dane")
        assert box.search("TO", "nobody@u.example") == []


# ── attachments that are only layout ──


def test_a_logo_in_a_signature_is_not_an_attachment(app, account, tmp_path):
    inbox = app.ns.folders[6]
    inbox.messages.clear()
    mail = inbox.put(Mail("A1", "With a logo", "Cy", "cy@x.example", datetime.now()))
    logo = Attachment("logo.png", 3000)
    logo.PropertyAccessor = accessor_for({wom.PR_ATTACH_HIDDEN: True})
    paper = Attachment("paper.pdf", 90000)
    paper.PropertyAccessor = accessor_for({wom.PR_ATTACH_HIDDEN: False})
    mail.Attachments.files[:] = [logo, paper]
    with box_for(account, app, tmp_path) as box:
        (uid,) = box.search("ALL")
        full = mailbox.read_message(box, "INBOX", uid)
        assert [name for name, _size in full.attachments] == ["paper.pdf"]
        assert mailbox.attachment_of(box, "INBOX", uid, "").name == "paper.pdf"  # (the only one)


# ── what is written ──


def test_letters_outside_plain_ascii_are_written_as_character_references(app, account, tmp_path):
    wom.send(
        account,
        message(body="Dear Dr. Żółć,\n\n日本語 and “quotes” — thanks."),
        ["bea@x.example"],
        None,
        None,
        app,
    )
    html = app.made[0].HTMLBody
    assert "&#379;&#243;&#322;&#263;" in html and "&#26085;&#26412;&#35486;" in html
    assert "Ż" not in html and "日" not in html and "&#8220;quotes&#8221;" in html


class Arial(Compose):
    """A new message of someone who writes in Arial: Outlook marks it on the empty first line."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.HTMLBody = self.HTMLBody.replace(
            "<p class=MsoNormal>&nbsp;</p>",
            "<p class=MsoNormal><span style='font-size:12.0pt;font-family:\"Arial\",sans-serif'>"
            "<o:p>&nbsp;</o:p></span></p>",
        ).replace("Bassam Farah, Ph.D.", "<span style='color:#1F497D'>Bassam Farah, Ph.D.</span>")


def test_the_words_are_in_the_font_the_person_writes_in_and_not_in_the_signatures_colour(
    app, account, tmp_path
):
    app.CreateItem = lambda kind: app.made.append(Arial()) or app.made[-1]
    wom.send(account, message(body="Noon works.\n\nSee you."), ["bea@x.example"], None, None, app)
    html = app.made[0].HTMLBody
    span = "<span style='font-size:12.0pt;font-family:\"Arial\",sans-serif'>"
    assert f"<p class=MsoNormal>{span}Noon works.</span></p>" in html
    assert f"<p class=MsoNormal>{span}See you.</span></p>" in html
    assert (
        html.count("color:#1F497D") == 1
    )  # (the signature's own, once: not copied onto the words)


class CantRead(Compose):
    @property
    def HTMLBody(self):  # noqa: N802
        raise OSError("Outlook is busy")

    @HTMLBody.setter
    def HTMLBody(self, value):  # noqa: N802
        pass


def test_a_message_outlook_will_not_give_is_not_sent_without_its_signature_and_thread(
    app, account, tmp_path
):
    bad = CantRead()
    app.CreateItem = lambda kind: app.made.append(bad) or bad
    with pytest.raises(MailError, match="Nothing was sent"):
        wom.send(account, message(), ["bea@x.example"], None, None, app)
    assert bad.sent is False
    empty = Compose()
    empty.HTMLBody = ""
    app.CreateItem = lambda kind: empty
    with pytest.raises(MailError, match="Nothing was sent"):
        wom.send(account, message(), ["bea@x.example"], None, None, app)
    assert empty.sent is False


def test_a_new_email_goes_from_the_account_with_the_address_it_was_set_up_with(
    app, account, tmp_path
):
    other = SimpleNamespace(SmtpAddress="ann.other@test.example", DisplayName="Other")
    mine = SimpleNamespace(SmtpAddress="Ann@Test.Example", DisplayName="Ann")
    app.ns.Accounts = [other, mine]
    wom.send(account, message(), ["bea@x.example"], None, None, app)
    assert app.made[0].SendUsingAccount is mine


def test_outlook_working_offline_is_said_and_nothing_is_made(app, account, tmp_path):
    app.ns.Offline = True
    with pytest.raises(MailError, match="working offline"):
        wom.send(account, message(), ["bea@x.example"], None, None, app)
    assert app.made == []
    app.ns.Offline = False
    wom.send(account, message(), ["bea@x.example"], None, None, app)
    assert app.made[0].sent is True


def test_a_draft_may_be_kept_while_outlook_is_offline(app, account, tmp_path):
    app.ns.Offline = True
    with box_for(account, app, tmp_path) as box:
        box.append("Drafts", message().as_bytes(), "\\Draft")
    assert app.made[0].saved is True


# ── whole replies, through the tools ──


class FakeVault:
    def __init__(self):
        self.items = {}

    def get(self, key):
        return self.items.get(key)

    def set(self, key, value):
        self.items[key] = value

    def delete(self, key):
        self.items.pop(key, None)


def tools_for(tmp_path, app, account):
    accounts = mailbox.Accounts(tmp_path / "mail.json", FakeVault())
    accounts.save(account)
    cards = []

    async def approve(question, detail, spoken, choices=("Send", "Don't send")):
        cards.append((question, detail))
        return True

    service = mailtools.MailService(
        accounts, mailbox.AddressBook(tmp_path / "people.json"), approve
    )
    return service, cards


def test_a_reply_through_the_tools_quotes_the_thread_once_and_only_outlook_does_it(
    app, account, tmp_path, monkeypatch
):
    monkeypatch.setattr(wom, "_connect", lambda _app=None: (app, app.ns, None))
    sent = []
    real = Mail.Reply
    Mail.Reply = lambda self: sent.append(Compose(quoted=self)) or sent[-1]
    try:
        service, cards = tools_for(tmp_path, app, account)
        with box_for(account, app, tmp_path) as box:
            uid = next(
                s.uid
                for s in mailbox.list_messages(box, "INBOX", 10)
                if s.subject == "Lunch Friday"
            )
        out = asyncio.run(
            service.reply_email(
                {"id": mailbox.encode_id(account.id, "INBOX", uid), "body": "Yes, noon works."}
            )
        )
    finally:
        Mail.Reply = real
    assert "Replied to Bea Lopez" in out["content"][0]["text"] and len(cards) == 1
    (reply,) = sent
    html = reply.HTMLBody
    assert reply.sent is True and reply.To == "bea@x.example"
    assert html.count("Are you free at noon?") == 1  # (Outlook's own quote, and not ours as well)
    assert "wrote:" not in html
    assert (
        html.index("Yes, noon works.") < html.index("Bassam Farah") < html.index("From: Bea Lopez")
    )


# ── when Outlook does not answer ──


def test_a_question_to_outlook_that_is_not_answered_is_given_up_on(
    app, account, tmp_path, monkeypatch
):
    import time

    class Stuck:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def search(self, *_):
            time.sleep(1.0)
            return []

        def select(self, *_a, **_k):
            return 0

        def unseen(self, *_):
            return 0

    monkeypatch.setattr(mailbox, "open_mailbox", lambda a, p, ids=None: Stuck())
    monkeypatch.setattr(mailtools, "OUTLOOK_SECONDS", 0.05)
    service, _cards = tools_for(tmp_path, app, account)
    out = asyncio.run(service.list_emails({}))
    assert out.get("is_error") and "isn't answering just now" in out["content"][0]["text"]


def test_a_send_that_outlook_holds_up_is_said_to_maybe_still_go(
    app, account, tmp_path, monkeypatch
):
    import time

    monkeypatch.setattr(wom, "send", lambda *a, **k: time.sleep(1.0))
    monkeypatch.setattr(mailtools, "SEND_SECONDS", 0.05)
    service, cards = tools_for(tmp_path, app, account)
    out = asyncio.run(
        service.send_email({"to": "bea@x.example", "subject": "Hi", "body": "Noon works."})
    )
    text = out["content"][0]["text"]
    assert (
        out.get("is_error") and "may still go" in text and "Sent Items" in text and len(cards) == 1
    )


# ── who the person is ──


def test_the_person_is_outlooks_current_user_and_the_address_is_the_default_stores(app):
    app.ns.CurrentUser = SimpleNamespace(Name="Bassam Farah, Ph.D.", AddressEntry=Entry("x@y.z"))
    app.ns.DefaultStore = SimpleNamespace(StoreID="STORE-2")
    app.ns.Accounts = [
        SimpleNamespace(
            SmtpAddress="old@home.example",
            DisplayName="old@home.example",
            DeliveryStore=SimpleNamespace(StoreID="STORE-1"),
        ),
        SimpleNamespace(
            SmtpAddress="bfarah@school.edu",
            DisplayName="bfarah@school.edu",
            DeliveryStore=SimpleNamespace(StoreID="STORE-2"),
        ),
    ]
    assert wom.identity(app) == ("Bassam Farah, Ph.D.", "bfarah@school.edu")


def test_a_person_with_no_account_listed_is_asked_of_their_address_entry(app):
    app.ns.Accounts = []
    app.ns.CurrentUser = SimpleNamespace(
        Name="Bassam Farah", AddressEntry=Entry("/O=X/CN=Bassam", "EX", "Bassam", "bf@school.edu")
    )
    assert wom.identity(app) == ("Bassam Farah", "bf@school.edu")
    app.ns.CurrentUser = SimpleNamespace(Name="Nobody", AddressEntry=Entry("not an address"))
    with pytest.raises(MailError, match="which account"):
        wom.identity(app)


# ── COM is shut down after Outlook's objects are let go ──


def test_outlooks_objects_are_let_go_of_before_com_is_shut_down(
    app, account, tmp_path, monkeypatch
):
    seen = {}

    class Com:
        def CoUninitialize(self):  # noqa: N802
            seen["app_when_shut_down"] = box.app
            seen["ns_when_shut_down"] = box.ns
            seen["current_when_shut_down"] = box.current

    monkeypatch.setattr(wom, "_connect", lambda _app=None: (app, app.ns, Com()))
    box = wom.OutlookMailbox(account, tmp_path / "ids.json")
    with box:
        box.select("INBOX")
        assert box.current is not None
    assert seen == {
        "app_when_shut_down": None,
        "ns_when_shut_down": None,
        "current_when_shut_down": None,
    }


def test_a_sender_whose_address_cannot_be_told_keeps_the_whole_name_and_no_address(
    app, account, tmp_path
):
    inbox = app.ns.folders[6]
    inbox.messages.clear()
    mail = inbox.put(Mail("U1", "From someone unlisted", "Ruiz, Dean", "", datetime.now()))
    mail.SenderEmailAddress, mail.SenderEmailType = "/O=EXCHANGELABS/CN=RUIZD", "EX"
    mail.Sender = Entry(
        "/O=EXCHANGELABS/CN=RUIZD", "EX", "Ruiz, Dean", None
    )  # (Exchange has no answer)
    with box_for(account, app, tmp_path) as box:
        (listed,) = mailbox.list_messages(box, "INBOX", 5)
    assert listed.sender == "Ruiz, Dean" and listed.address == ""  # (not "Ruiz", not an address)
