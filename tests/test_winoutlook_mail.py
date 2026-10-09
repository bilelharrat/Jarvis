"""Email in Outlook for Windows (jarvis.winoutlook_mail), against a stand-in for Outlook's object model:
the folders and messages it has, what it is asked, what it makes when it sends. No Outlook is needed, and
nothing is sent anywhere. (The real object model is Microsoft's: these checks are of what Jarvis asks of
it and does with the answers.)"""

from __future__ import annotations

import asyncio
import email.policy
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis import mailbox, mailtools
from jarvis import winoutlook_mail as wom
from jarvis.mailbox import Account, MailError

NOW = datetime(2026, 10, 8, 9, 0)


# ── a stand-in for Outlook ──


class Entry:
    def __init__(self, address, kind="SMTP", name="", exchange=None):
        self.Address, self.Type, self.Name, self._exchange = address, kind, name, exchange

    def GetExchangeUser(self):  # noqa: N802 - Outlook's name
        return SimpleNamespace(PrimarySmtpAddress=self._exchange) if self._exchange else None

    def GetExchangeDistributionList(self):  # noqa: N802
        return None


class Recipient:
    def __init__(self, name, address, kind=1, exchange=None, resolved=True):
        self.Name, self.Type, self.Address = name, kind, address
        self.AddressEntry = Entry(address, "EX" if exchange else "SMTP", name, exchange)
        self.Resolved = resolved

    def Resolve(self):  # noqa: N802
        return self.Resolved


class Accessor:
    """A message's, recipient's or attachment's MAPI properties, by tag (the ones it has; others are an error)."""

    def __init__(self, props):
        self.props = props

    def GetProperty(self, tag):  # noqa: N802 - Outlook's name
        if tag in self.props:
            return self.props[tag]
        raise OSError("that property isn't there")


def accessor_for(props):
    return Accessor(props)


class Attachment:
    def __init__(self, name, size, data=None):
        self.FileName, self.Size = name, size
        self.data = data if data is not None else b"contents of " + name.encode()

    def SaveAsFile(self, path):  # noqa: N802 - Outlook's name
        Path(path).write_bytes(self.data)


class Attachments:
    def __init__(self, files=()):
        self.files, self.added = list(files), []

    @property
    def Count(self):  # noqa: N802
        return len(self.files)

    def Item(self, i):  # noqa: N802
        return self.files[i - 1]

    def Add(self, path):  # noqa: N802
        self.added.append(path)
        self.contents = Path(path).read_bytes()  # (the file is there while it is added)


class Mail:
    """A message in a folder."""

    Class = 43

    def __init__(self, entry_id, subject, sender, address, when, *, unread=True, body="", flag=0,
                 exchange=None, to=(("Ann Test", "ann@test.example"),), cc=(), files=()):  # fmt: skip
        self.EntryID, self.Subject, self.SenderName = entry_id, subject, sender
        if exchange:
            self.SenderEmailAddress, self.SenderEmailType = "/O=EXCHANGELABS/CN=" + sender, "EX"
            self.Sender = Entry("/O=EXCHANGELABS/CN=" + sender, "EX", sender, exchange)
        else:
            self.SenderEmailAddress, self.SenderEmailType = address, "SMTP"
            self.Sender = Entry(address, "SMTP", sender)
        self.ReceivedTime, self.UnRead, self.Body, self.FlagStatus = when, unread, body, flag
        self.To = "; ".join(n for n, _a in to)
        self.CC = "; ".join(n for n, _a in cc)
        self.Recipients = [Recipient(n, a, 1) for n, a in to] + [Recipient(n, a, 2) for n, a in cc]
        self.Attachments = Attachments([Attachment(n, s) for n, s in files])
        self.saved = 0
        self.moved_to = None
        self.folder = None

    def Save(self):  # noqa: N802
        self.saved += 1

    def Move(self, folder):  # noqa: N802
        self.moved_to = folder
        self.EntryID += (
            "-moved"  # (a message that moves gets a new id in Outlook: the old one finds nothing)
        )
        if self.folder is not None:
            self.folder.messages.remove(self)
        folder.messages.append(self)
        self.folder = folder

    def Reply(self):  # noqa: N802
        return Compose(quoted=self, signature=True)

    def ReplyAll(self):  # noqa: N802
        return Compose(quoted=self, signature=True)


SIGNATURE = "<div><p class=MsoNormal>Bassam Farah, Ph.D.<br>Professor of Strategy</p></div>"


class Compose:
    """A new message or a reply as Outlook makes it: the person's signature already in it."""

    def __init__(self, quoted=None, signature=True, plain=False):
        self.To = self.CC = self.BCC = self.Subject = ""
        self.quoted, self.sent, self.saved, self.inspector = quoted, False, False, False
        self.BodyFormat = 1 if plain else 2
        self.Attachments = Attachments()
        original = f"<div>From: {quoted.SenderName}<br>{quoted.Body}</div>" if quoted else ""
        self.HTMLBody = (
            "<html><head><style>p.MsoNormal{font-family:Calibri;font-size:11pt}</style></head>"
            '<body lang=EN-US link="#0563C1"><div class=WordSection1>'
            f"<p class=MsoNormal>&nbsp;</p>{SIGNATURE if signature else ''}{original}</div></body></html>"
        )
        self.Body = f"\r\n\r\nBassam Farah\r\n{original}" if plain else ""

    @property
    def GetInspector(self):  # noqa: N802 - touching it is what makes Outlook write the signature
        self.inspector = True
        return object()

    def Save(self):  # noqa: N802
        self.saved = True

    def Send(self):  # noqa: N802
        self.sent = True


class Items:
    def __init__(self, messages):
        self.messages, self.pos = messages, 0

    @property
    def Count(self):  # noqa: N802
        return len(self.messages)

    def Sort(self, prop, descending=False):  # noqa: N802
        self.messages.sort(key=lambda m: m.ReceivedTime, reverse=bool(descending))

    def GetFirst(self):  # noqa: N802
        self.pos = 0
        return self.GetNext()

    def GetNext(self):  # noqa: N802
        if self.pos >= len(self.messages):
            return None
        self.pos += 1
        return self.messages[self.pos - 1]

    def Restrict(self, query):  # noqa: N802 - only the one filter this app asks
        assert query == "[UnRead] = True"
        return Items([m for m in self.messages if m.UnRead])

    def __iter__(self):
        return iter(list(self.messages))


class Folder:
    def __init__(self, name, parent=None):
        self.Name, self.Parent, self.messages, self.subfolders = name, parent, [], []

    @property
    def Items(self):  # noqa: N802
        return Items(self.messages)

    @property
    def UnReadItemCount(self):  # noqa: N802
        return sum(1 for m in self.messages if m.UnRead)

    @property
    def Folders(self):  # noqa: N802
        outer = self

        class Collection:
            def __iter__(self):
                return iter(list(outer.subfolders))

            def Add(self, name):  # noqa: N802
                made = Folder(name, outer)
                outer.subfolders.append(made)
                return made

        return Collection()

    def put(self, message):
        message.folder = self
        self.messages.append(message)
        return message


class Namespace:
    def __init__(self):
        self.root = Folder("ann@test.example")
        self.folders = {}
        for number, name in (
            (6, "Inbox"),
            (5, "Sent Items"),
            (16, "Drafts"),
            (3, "Deleted Items"),
            (23, "Junk Email"),
            (10, "Contacts"),
        ):
            self.folders[number] = Folder(name, self.root)
            self.root.subfolders.append(self.folders[number])
        self.Accounts = [SimpleNamespace(SmtpAddress="ann@test.example", DisplayName="Ann Test")]
        self.CurrentUser = SimpleNamespace(Name="Ann Test", AddressEntry=Entry("ann@test.example"))
        self.known = {}  # name -> Recipient the address list resolves

    def GetDefaultFolder(self, number):  # noqa: N802
        return self.folders[number]

    def GetItemFromID(self, entry_id):  # noqa: N802
        for folder in [*self.folders.values(), *self.root.subfolders]:
            for message in folder.messages:
                if message.EntryID == entry_id:
                    return message
        raise OSError("no such item")

    def CreateRecipient(self, name):  # noqa: N802
        return self.known.get(name.lower()) or Recipient(name, "", resolved=False)


class App:
    def __init__(self):
        self.ns = Namespace()
        self.made = []
        self.plain = False

    def GetNamespace(self, name):  # noqa: N802
        assert name == "MAPI"
        return self.ns

    def CreateItem(self, kind):  # noqa: N802
        assert kind == 0
        mail = Compose(plain=self.plain)
        self.made.append(mail)
        return mail


@pytest.fixture
def app():
    outlook = App()
    inbox = outlook.ns.folders[6]
    inbox.put(
        Mail(
            "E1",
            "Lunch Friday",
            "Bea Lopez",
            "bea@x.example",
            NOW - timedelta(hours=1),
            body="Are you free at noon?",
        )
    )
    inbox.put(
        Mail(
            "E2",
            "Invoice 42",
            "Cal",
            "cal@y.example",
            NOW - timedelta(days=2),
            unread=False,
            body="Please see attached.",
            files=(("invoice.pdf", 18000),),
        )
    )
    inbox.put(
        Mail(
            "E3",
            "Grant deadline",
            "Dean Ruiz",
            "",
            NOW - timedelta(days=1),
            body="Friday at 5.",
            exchange="druiz@school.edu",
            flag=2,
        )
    )
    return outlook


@pytest.fixture
def account():
    return Account(
        id="outlook",
        address="ann@test.example",
        name="Ann Test",
        label="Outlook",
        kind="outlook",
        saves_sent=True,
    )


def box_for(account, app, tmp_path):
    return wom.OutlookMailbox(account, tmp_path / "outlook_ids.json", app)


# ── reading ──


def test_the_inbox_is_listed_newest_first_with_who_what_when_and_what_is_unread(
    app, account, tmp_path
):
    with box_for(account, app, tmp_path) as box:
        listed = mailbox.list_messages(box, "INBOX", 10)
        assert [s.subject for s in listed] == ["Lunch Friday", "Grant deadline", "Invoice 42"]
        assert [s.unread for s in listed] == [True, True, False]
        assert [s.flagged for s in listed] == [False, True, False]
        assert listed[0].sender == "Bea Lopez" and listed[0].address == "bea@x.example"
        assert box.unseen() == 2


def test_an_exchange_senders_real_address_is_asked_of_exchange(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        deadline = next(
            s for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Grant deadline"
        )
    assert deadline.address == "druiz@school.edu" and deadline.sender == "Dean Ruiz"


def test_one_email_is_read_whole_with_its_people_and_its_attachments(app, account, tmp_path):
    app.ns.folders[6].messages[1].Recipients.append(Recipient("Bob Roy", "bob@z.example", 2))
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Invoice 42"
        )
        full = mailbox.read_message(box, "INBOX", uid)
    assert full.body == "Please see attached." and full.summary.subject == "Invoice 42"
    assert full.to == ["Ann Test <ann@test.example>"] and full.cc == ["Bob Roy <bob@z.example>"]
    assert full.attachments == [("invoice.pdf", 18000)]  # (the size is the real one)
    assert full.summary.unread is False


def test_a_search_finds_by_person_subject_and_words_and_by_what_is_unread(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        by_person = mailbox.find_messages(box, person="Bea")
        by_subject = mailbox.find_messages(box, subject="invoice")
        by_words = mailbox.find_messages(box, text="noon")
        unread = mailbox.find_messages(box, unread_only=True)
        old = mailbox.find_messages(box, days=1)
    assert [s.subject for s in by_person] == ["Lunch Friday"]
    assert [s.subject for s in by_subject] == ["Invoice 42"]
    assert [s.subject for s in by_words] == ["Lunch Friday"]
    assert sorted(s.subject for s in unread) == ["Grant deadline", "Lunch Friday"]
    assert [s.subject for s in old] == ["Lunch Friday"] or "Lunch Friday" in [
        s.subject for s in old
    ]


def test_a_message_keeps_its_number_from_one_question_to_the_next(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        first = {s.subject: s.uid for s in mailbox.list_messages(box, "INBOX", 10)}
    with box_for(account, app, tmp_path) as box:  # (another conversation turn, another connection)
        again = {s.subject: s.uid for s in mailbox.list_messages(box, "INBOX", 10)}
        assert (
            mailbox.read_message(box, "INBOX", first["Lunch Friday"]).summary.subject
            == "Lunch Friday"
        )
        assert box.search("UID", str(first["Invoice 42"])) == [first["Invoice 42"]]
        assert box.search("UID", "999") == []
    assert first == again


def test_a_message_that_was_moved_away_is_not_there_any_more(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        uid = mailbox.list_messages(box, "INBOX", 10)[0].uid
        app.ns.folders[6].messages[0].Move(app.ns.folders[3])
        with pytest.raises(MailError, match="isn't there any more"):
            mailbox.read_message(box, "INBOX", uid)


# ── tidying ──


def test_marking_flagging_and_archiving_change_the_message_in_outlook(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Lunch Friday"
        )
        box.select("INBOX", readonly=False)
        box.store(uid, "\\Seen", True)
        box.store(uid, "\\Flagged", True)
        box.store(uid, "\\Answered", True)  # (Outlook's own doing: nothing to change)
        message = app.ns.folders[6].messages[0]
        assert message.UnRead is False and message.FlagStatus == 2 and message.saved == 2
        box.store(uid, "\\Flagged", False)
        assert message.FlagStatus == 0
        target = box.special("archive")  # (a mailbox with no Archive folder gets one)
        assert target == "Archive" and [f.Name for f in app.ns.root.subfolders][-1] == "Archive"
        box.move(uid, target)
        assert message.moved_to.Name == "Archive" and message not in app.ns.folders[6].messages
        assert box.special("archive") == "Archive"  # (the same one next time, not another)


def test_the_special_folders_are_named_as_outlook_names_them(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        assert (box.special("sent"), box.special("drafts"), box.special("trash")) == (
            "Sent Items",
            "Drafts",
            "Deleted Items",
        )
        assert box.select("Sent Items") == 0 and box.select("INBOX") == 3
        with pytest.raises(MailError, match="no folder called Nowhere"):
            box.select("Nowhere")
        assert {f["name"] for f in box.folders()} >= {"INBOX", "Sent Items", "Drafts"}


# ── what goes out ──


def message(**more):
    msg = mailbox.build_message(
        Account(id="outlook", address="ann@test.example", name="Ann Test", kind="outlook"),
        more.pop("to", ["bea@x.example"]),
        more.pop("subject", "Lunch"),
        more.pop("body", "Noon works.\n\nSee you there."),
        **more,
    )
    return msg


def test_a_new_email_is_made_by_outlook_with_the_persons_own_signature_and_font(
    app, account, tmp_path
):
    msg = message(cc=["cal@y.example"])
    wom.send(
        account,
        msg,
        ["bea@x.example", "cal@y.example", "hidden@z.example"],
        None,
        tmp_path / "ids.json",
        app,
    )
    (mail,) = app.made
    assert mail.sent is True and mail.saved is False and mail.inspector is True
    assert (mail.To, mail.CC, mail.BCC) == ("bea@x.example", "cal@y.example", "hidden@z.example")
    assert mail.Subject == "Lunch"
    html = mail.HTMLBody
    assert html.index("Noon works.") < html.index(
        "Bassam Farah, Ph.D."
    )  # the words, then the signature
    assert (
        "<p class=MsoNormal>Noon works.</p><p class=MsoNormal>&nbsp;</p><p class=MsoNormal>See you there.</p>"
        in html
    )
    assert (
        "p.MsoNormal{font-family:Calibri" in html
    )  # (the person's own font is what the paragraphs use)
    assert html.count("<body") == 1 and html.startswith("<html>")


def test_what_is_written_is_made_safe_for_the_page(app, account, tmp_path):
    wom.send(account, message(body='5 < 6 & "ok" <b>x</b>'), ["bea@x.example"], None, None, app)
    html = app.made[0].HTMLBody
    assert "5 &lt; 6 &amp; &quot;ok&quot; &lt;b&gt;x&lt;/b&gt;" in html and "<b>x</b>" not in html


def test_a_reply_is_outlooks_own_reply_so_the_thread_and_the_quoted_original_are_kept(
    app, account, tmp_path
):
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Lunch Friday"
        )
    original = mailbox.read_message(box_for(account, app, tmp_path).__enter__(), "INBOX", uid)
    msg = mailbox.build_message(
        Account(id="outlook", address="ann@test.example", name="Ann Test", kind="outlook"),
        ["bea@x.example"], mailbox.reply_subject("Lunch Friday"), "Yes, noon.", reply_to_message=original,
    )  # fmt: skip
    sent = []
    original_reply = Mail.Reply
    Mail.Reply = lambda self: sent.append(Compose(quoted=self)) or sent[-1]
    try:
        wom.send(
            account, msg, ["bea@x.example"], ("INBOX", uid), tmp_path / "outlook_ids.json", app
        )
    finally:
        Mail.Reply = original_reply
    (reply,) = sent
    assert reply.sent is True and app.made == []  # (no new message: Outlook's reply is what went)
    assert reply.To == "bea@x.example" and reply.Subject == "Re: Lunch Friday"
    html = reply.HTMLBody
    assert (
        html.index("Yes, noon.") < html.index("Bassam Farah") < html.index("From: Bea Lopez")
    )  # words, signature, quote


def test_a_person_whose_outlook_writes_plain_text_gets_plain_text(app, account, tmp_path):
    app.plain = True
    wom.send(account, message(body="Noon works."), ["bea@x.example"], None, None, app)
    mail = app.made[0]
    assert mail.Body.startswith("Noon works.\r\n\r\n") and "Bassam Farah" in mail.Body


def test_files_that_go_with_an_email_are_added_and_then_not_left_on_the_disk(
    app, account, tmp_path
):
    notes = tmp_path / "notes.txt"
    notes.write_text("the notes")
    wom.send(account, message(attachments=[notes]), ["bea@x.example"], None, None, app)
    (mail,) = app.made
    (added,) = mail.Attachments.added
    assert Path(added).name == "notes.txt" and mail.Attachments.contents == b"the notes"
    assert not Path(added).exists()  # (the copy made for Outlook is gone; the original stays)
    assert notes.exists()


def test_a_draft_is_kept_for_the_person_to_finish_in_outlook_and_nothing_is_sent(
    app, account, tmp_path
):
    msg = message(subject="Draft")
    with box_for(account, app, tmp_path) as box:
        box.append("Drafts", msg.as_bytes(), "\\Draft")
        box.append(
            "Sent Items", msg.as_bytes(), "\\Seen"
        )  # (Outlook keeps sent mail itself: nothing to add)
    (mail,) = app.made
    assert (
        mail.saved is True
        and mail.sent is False
        and mail.Subject == "Draft"
        and "Noon works." in mail.HTMLBody
    )


def test_nobody_to_send_to_and_outlook_shut_are_said_in_words(app, account, monkeypatch):
    with pytest.raises(MailError, match="nobody to send it to"):
        wom.send(account, message(), [], None, None, app)
    monkeypatch.setattr(wom, "ON_A_PC", False)
    with pytest.raises(MailError, match="only on a PC"):
        wom.send(account, message(), ["bea@x.example"], None, None)
    monkeypatch.setattr(wom, "ON_A_PC", True)
    monkeypatch.setattr(
        wom, "_connect", lambda _app=None: (_ for _ in ()).throw(MailError(wom.NOT_OPEN))
    )
    with pytest.raises(MailError, match="Outlook isn't open"):
        wom.send(account, message(), ["bea@x.example"], None, None)


# ── who the person is, and who a name means ──


def test_the_default_account_and_names_in_the_address_list_are_found(app):
    assert wom.identity(app) == ("Ann Test", "ann@test.example")
    app.ns.known["dr. smith"] = Recipient(
        "Dr. Smith", "/O=EXCH/CN=SMITH", exchange="smith@school.edu"
    )
    assert wom.lookup("Dr. Smith", app) == [("Dr. Smith", "smith@school.edu")]
    assert wom.lookup("Nobody Here", app) == []
    contact = SimpleNamespace(FullName="Ana Ruiz Gomez", Email1Address="ana@home.example")
    app.ns.folders[10].messages.append(contact)
    assert wom.lookup("ana ruiz", app) == [("Ana Ruiz Gomez", "ana@home.example")]


# ── through the mail tools, as the owner would use them ──


class Cards:
    def __init__(self, answer=True):
        self.answer, self.shown = answer, []

    async def __call__(self, question, detail, spoken):
        self.shown.append((question, detail, spoken))
        return self.answer


@pytest.fixture
def served(app, account, tmp_path, monkeypatch):
    monkeypatch.setattr(wom, "_connect", lambda a=None: (app, app.GetNamespace("MAPI"), None))
    store = mailbox.Accounts(
        tmp_path / "mail.json",
        SimpleNamespace(get=lambda k: None, set=lambda k, v: None, delete=lambda k: None),
    )
    store.save(account)
    cards = Cards()
    service = mailtools.MailService(store, mailbox.AddressBook(tmp_path / "people.json"), cards)
    return SimpleNamespace(service=service, cards=cards, app=app, store=store)


def say(result):
    return result["content"][0]["text"]


def test_the_inbox_is_read_aloud_through_the_tools(served):
    out = asyncio.run(served.service.list_emails({}))
    text = say(out)
    assert "Lunch Friday" in text and "Bea Lopez" in text and "Grant deadline" in text


def test_an_email_dictated_is_asked_about_first_and_then_goes_out_through_outlook(served):
    served.cards.answer = False
    out = asyncio.run(
        served.service.send_email(
            {"to": "bea@x.example", "subject": "Lunch", "body": "Noon works."}
        )
    )
    assert "said no" in say(out).lower() or out.get("is_error")
    assert served.app.made == []  # (nothing went without the yes)
    assert served.cards.shown and "Noon works." in served.cards.shown[0][1]
    served.cards.answer = True
    asyncio.run(
        served.service.send_email(
            {"to": "bea@x.example", "subject": "Lunch", "body": "Noon works."}
        )
    )
    (mail,) = served.app.made
    assert mail.sent is True and mail.To == "bea@x.example" and "Noon works." in mail.HTMLBody
    assert "Bassam Farah" in mail.HTMLBody  # (their own signature, from Outlook)


def test_a_name_is_looked_up_in_outlooks_address_list_when_the_book_does_not_know_it(served):
    served.app.ns.known["dr. smith"] = Recipient(
        "Dr. Smith", "/O=EXCH/CN=SMITH", exchange="smith@school.edu"
    )
    served.service.directory = lambda name: wom.lookup(name, served.app)
    asyncio.run(
        served.service.send_email(
            {"to": "Dr. Smith", "subject": "Hello", "body": "Thanks for the paper."}
        )
    )
    (mail,) = served.app.made
    assert mail.To == "smith@school.edu"
    assert "Dr. Smith" in served.cards.shown[0][0] or "Dr. Smith" in served.cards.shown[0][1]


def test_archiving_through_the_tools_moves_it_in_outlook(served):
    asyncio.run(served.service.list_emails({}))
    summaries = asyncio.run(
        served.service._imap(
            served.store.all()[0], lambda box: mailbox.list_messages(box, "INBOX", 5)
        )
    )
    target = next(s for s in summaries if s.subject == "Lunch Friday")
    served.service.asked = lambda _action: True  # (the owner's own words asked for it: no card)
    out = asyncio.run(served.service.triage({"action": "archive", "message_ids": [target.id]}))
    assert "Archived" in say(out) or "archive" in say(out).lower()
    assert [
        m.Subject for m in served.app.ns.folders[6].messages if m.Subject == "Lunch Friday"
    ] == []


def test_the_policy_import_is_the_one_mail_uses():
    assert email.policy.SMTP is not None


def test_a_mailing_lists_mark_is_carried_so_a_newsletter_is_known_for_one(app, account, tmp_path):
    class Accessor:
        def GetProperty(self, name):  # noqa: N802
            assert name == wom.TRANSPORT_HEADERS
            return "Received: x\r\nList-Unsubscribe: <mailto:off@lists.example>\r\nSubject: y\r\n"

    message = app.ns.folders[6].messages[1]
    message.PropertyAccessor = Accessor()
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Invoice 42"
        )
        assert (
            mailbox.read_message(box, "INBOX", uid).list_unsubscribe == "<mailto:off@lists.example>"
        )
        del message.PropertyAccessor  # (a message with no internet headers is still read)
        assert mailbox.read_message(box, "INBOX", uid).list_unsubscribe == ""


def test_the_newest_messages_and_which_are_still_unread_are_cheap_to_ask(app, account, tmp_path):
    with box_for(account, app, tmp_path) as box:
        box.select("INBOX")
        everything = box.search("ALL")
        newest = box.newest(1)
        assert len(newest) == 1 and newest[0] == max(everything, key=lambda n: _received(box, n))
        unread = box.search("UNSEEN")
        assert box.still_unread(everything) == unread
        box.store(unread[0], "\\Seen", True)
        assert unread[0] not in box.still_unread(everything)
        assert box.still_unread([99999]) == []  # (a message that isn't there isn't unread)


def _received(box, number):
    return box._item(number).ReceivedTime


def test_a_search_asks_exchange_who_wrote_a_message_only_when_the_search_is_about_who(
    app, account, tmp_path, monkeypatch
):
    asked = []
    real = wom.smtp_of
    monkeypatch.setattr(wom, "smtp_of", lambda entry: asked.append(1) or real(entry))
    with box_for(account, app, tmp_path) as box:
        box.select("INBOX")
        box.search("ALL")
        box.search("UNSEEN")
        box.search("SUBJECT", "Invoice")
        assert asked == []
        box.search("FROM", "bea")
        assert asked  # (now it is needed)


def test_outlooks_no_time_is_no_time(app, account, tmp_path):
    never = datetime(4501, 1, 1)
    assert wom._local(never) is None and wom._local(None) is None
    message = app.ns.folders[6].messages[0]
    message.ReceivedTime = never  # (a draft, or something copied in, has no time it was received)
    message.SentOn = NOW - timedelta(hours=3)
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Lunch Friday"
        )
        got = mailbox.read_message(box, "INBOX", uid)
    assert got.summary.date is not None and got.summary.date.year == NOW.year


def test_an_attachment_is_saved_by_outlook_and_read_back_by_its_name_or_number(
    app, account, tmp_path
):
    message = app.ns.folders[6].messages[1]
    message.Attachments.files.append(Attachment("notes.txt", 12, b"Remember the exam."))
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Invoice 42"
        )
        by_name = mailbox.attachment_of(box, "INBOX", uid, "notes")
        assert (by_name.name, by_name.data) == ("notes.txt", b"Remember the exam.")
        by_number = mailbox.attachment_of(box, "INBOX", uid, "1")
        assert by_number.name == "invoice.pdf" and by_number.data == b"contents of invoice.pdf"
        with pytest.raises(mailbox.MailError, match="2 attachments: 1. invoice.pdf, 2. notes.txt"):
            mailbox.attachment_of(box, "INBOX", uid, "")
        with pytest.raises(mailbox.MailError, match="no attachment number 3"):
            mailbox.attachment_of(box, "INBOX", uid, "3")
        with pytest.raises(mailbox.MailError, match="isn't there any more"):
            mailbox.attachment_of(box, "INBOX", 99999, "1")
        # (one that is not the message's: it has none)
        first = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Lunch Friday"
        )
        with pytest.raises(mailbox.MailError, match="no attachments"):
            mailbox.attachment_of(box, "INBOX", first, "")


def test_an_attachment_too_big_to_open_is_not_saved(app, account, tmp_path):
    message = app.ns.folders[6].messages[1]
    message.Attachments.files[0].Size = mailbox.MAX_ATTACHMENT + 1
    with box_for(account, app, tmp_path) as box:
        uid = next(
            s.uid for s in mailbox.list_messages(box, "INBOX", 10) if s.subject == "Invoice 42"
        )
        with pytest.raises(mailbox.MailError, match="too big"):
            mailbox.attachment_of(box, "INBOX", uid, "")
