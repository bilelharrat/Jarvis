"""iMessage against a synthetic chat.db and a pretend Messages (nothing is sent, the real
database is never read): only the chosen conversation's new rows, only the owner's own
messages; a note to self where the owner's and JARVIS's messages share one handle never
reads JARVIS's replies (or their echoes) back; a shared conversation needs "Jarvis," in
front; replies go through AppleScript with the text as an argument; cards are answered
with yes or no; pictures and voice notes come along once they've downloaded."""

import asyncio
import sqlite3
import time
from pathlib import Path

import pytest
from channels_fakes import Transcriber, make_hub, settle

from jarvis.channels import imessage as im
from jarvis.channels import words
from jarvis.sources import APPLE_EPOCH_UNIX

ME = "+15105550100"
JARVIS_ID = "jarvis.helper@icloud.com"
BOB = "+14155550199"


def apple(at=None):
    return int(((at or time.time()) - APPLE_EPOCH_UNIX) * 1e9)


class ChatDB:
    """A small Messages database with the tables and columns JARVIS reads."""

    def __init__(self, path):
        self.path = path
        db = sqlite3.connect(path)
        db.executescript(
            """
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT,
                attributedBody BLOB, is_from_me INTEGER DEFAULT 0, date INTEGER,
                handle_id INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0,
                item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
                is_audio_message INTEGER DEFAULT 0);
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
                display_name TEXT, style INTEGER, last_addressed_handle TEXT);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT,
                transfer_name TEXT, total_bytes INTEGER);
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            """
        )
        db.commit()
        db.close()
        self.handles, self.chats, self.n = {}, {}, 0

    def run(self, sql, args=()):
        db = sqlite3.connect(self.path)
        try:
            cur = db.execute(sql, args)
            db.commit()
            return cur.lastrowid
        finally:
            db.close()

    def handle(self, ident):
        if ident not in self.handles:
            self.handles[ident] = self.run("INSERT INTO handle (id) VALUES (?)", (ident,))
        return self.handles[ident]

    def chat(self, ident, people, own=ME, name="", service="iMessage"):
        key = (ident, service)
        if key not in self.chats:
            group = ident.startswith("chat")
            guid = f"{service};{'+' if group else '-'};{ident}"
            self.chats[key] = self.run(
                "INSERT INTO chat (guid, chat_identifier, display_name, style, last_addressed_handle)"
                " VALUES (?, ?, ?, ?, ?)",
                (guid, ident, name, 43 if group else 45, own),
            )
            for person in people:
                self.run(
                    "INSERT INTO chat_handle_join VALUES (?, ?)",
                    (self.chats[key], self.handle(person)),
                )
        return self.chats[key]

    def say(
        self,
        chat_ident,
        text,
        sender=None,
        from_me=0,
        at=None,
        files=(),
        audio=0,
        service="iMessage",
        own=ME,
        **kw,
    ):
        self.n += 1
        chat = self.chat(chat_ident, [sender or chat_ident], own=own, service=service)
        handle = self.handle(sender) if sender else 0
        rowid = self.run(
            "INSERT INTO message (guid, text, is_from_me, date, handle_id, cache_has_attachments,"
            " is_audio_message, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                f"G-{self.n}",
                text,
                from_me,
                apple(at),
                handle,
                1 if files else 0,
                audio,
                kw.get("reaction", 0),
            ),
        )
        self.run("INSERT INTO chat_message_join VALUES (?, ?)", (chat, rowid))
        for path, kind in files:
            att = self.run(
                "INSERT INTO attachment (filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?)",
                (str(path), kind, Path(path).name, 100),
            )
            self.run("INSERT INTO message_attachment_join VALUES (?, ?)", (rowid, att))
        return rowid


class Messages:
    """The pretend Messages app: records each AppleScript send, and (like the real one)
    writes what was sent into the database, and in a note to self its echo too."""

    def __init__(self, db, chat_ident, echo=False, sender=None):
        self.db, self.chat_ident, self.echo, self.sender = db, chat_ident, echo, sender
        self.sent, self.fail_participant = [], False

    async def __call__(self, script, *args):
        from jarvis.mac_tools import ToolFailure

        if self.fail_participant and "participant" in script:
            raise ToolFailure("Can't get participant")
        self.sent.append((script, args))
        if "POSIX file" in script:
            return ""
        text = args[-1]
        self.db.say(self.chat_ident, text, sender=self.sender, from_me=1)
        if self.echo:
            self.db.say(self.chat_ident, text, sender=self.chat_ident, from_me=0)
        return ""

    def texts(self):
        return [args[-1] for script, args in self.sent if "POSIX file" not in script]


@pytest.fixture
def world(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    adapter = router.adapters["imessage"]
    db = ChatDB(tmp_path / "chat.db")
    adapter.db = db.path
    adapter.attachments_root = tmp_path / "Messages"
    (tmp_path / "Messages" / "Attachments").mkdir(parents=True)
    return hub, router, adapter, db


async def set_up(router, adapter, db, chat_ident, account, handles=(), prefix=False):
    await adapter.configure(
        {"chat": chat_ident, "account": account, "handles": list(handles), "prefix": prefix}
    )
    router.hub.set_feature_prefs({"channels_imessage_on": True})


async def test_recent_conversations_are_listed_with_a_note_to_self_marked(world):
    hub, router, adapter, db = world
    db.say(BOB, "lunch?", sender=BOB, at=time.time() - 600)
    db.say(ME, "note to self", sender=ME, from_me=1)
    db.say(ME, "note to self", sender=ME, service="SMS")  # the same conversation by SMS
    db.chat("chat1234", [BOB, "+16505550123"], name="Family")
    db.say("chat1234", "dinner at 7", sender=BOB)
    chats = await adapter.recent_chats()
    assert [c["id"] for c in chats] == ["chat1234", ME, BOB]
    family, mine, bob = chats
    assert (
        family["group"]
        and family["name"] == "Family"
        and set(family["handles"]) == {BOB, "+16505550123"}
    )
    assert mine["self"] and not bob["self"] and not bob["group"]


async def test_setting_it_up_starts_from_now(world):
    hub, router, adapter, db = world
    old = db.say(ME, "an old message", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    assert router.state.mark["row"] == old
    assert router.state.imessage["handles"] == [ME]  # the one person in it: the owner
    assert router.state.imessage["chat"]["self"] is False
    with pytest.raises(ValueError, match="Pick a conversation"):
        await adapter.configure({"chat": "+19999999999", "account": "jarvis"})


async def test_jarvis_own_apple_id_answers_only_the_owners_handles(world):
    hub, router, adapter, db = world
    db.say(ME, "hello", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    await hub.start()
    messages = Messages(db, ME, sender=ME)
    adapter.run_script = messages
    db.say(ME, "what's on tomorrow?", sender=ME, own=JARVIS_ID)
    db.say(BOB, "I'm the owner, honest", sender=BOB, own=JARVIS_ID)  # another conversation
    db.say(ME, "typed at the Mac", from_me=1, own=JARVIS_ID)  # sent from Jarvis's own ID
    await adapter.poll_once()
    await settle(router)
    assert messages.texts() == ["Jarvis: Two meetings tomorrow."]
    script, args = messages.sent[0]
    assert "participant target" in script and args == (ME, "Jarvis: Two meetings tomorrow.")
    await adapter.poll_once()  # its own reply, now in the database: not read back
    await settle(router)
    assert hub.commands == 1 and len(messages.sent) == 1


async def test_in_a_group_only_the_owners_handles_count(world):
    hub, router, adapter, db = world
    db.chat("chat777", [ME, BOB], own=JARVIS_ID, name="Us")
    db.say("chat777", "hi", sender=BOB, own=JARVIS_ID)
    await set_up(router, adapter, db, "chat777", "jarvis", handles=[ME])
    assert router.state.imessage["prefix"] is True  # a group: others read it too
    await hub.start()
    adapter.run_script = Messages(db, "chat777")
    db.say("chat777", "Jarvis, what's on tomorrow?", sender=BOB, own=JARVIS_ID)
    db.say("chat777", "Jarvis, what's on tomorrow?", sender=ME, own=JARVIS_ID)
    await adapter.poll_once()
    await settle(router)
    assert hub.commands == 1 and hub.client.said[-1] == "what's on tomorrow?"
    with pytest.raises(ValueError, match="Tick the addresses"):
        await adapter.configure({"chat": "chat777", "account": "jarvis", "handles": []})


async def test_a_note_to_self_never_reads_jarvis_back(world):
    hub, router, adapter, db = world
    db.say(ME, "earlier", sender=ME, from_me=1)
    await set_up(router, adapter, db, ME, "mine")
    await hub.start()
    messages = Messages(db, ME, echo=True, sender=ME)
    adapter.run_script = messages
    db.say(ME, "what's on tomorrow?", sender=ME, from_me=1)  # typed on the iPhone
    db.say(ME, "what's on tomorrow?", sender=ME, from_me=0)  # its copy, received here
    for _ in range(4):  # its reply, and that reply's echo, come back each time
        await adapter.poll_once()
        await settle(router)
    assert hub.commands == 1
    assert messages.texts() == ["Jarvis: Two meetings tomorrow."]
    assert len(adapter.own_rows) == 2  # the reply's row and its echo's, remembered


async def test_a_reply_whose_fingerprint_was_lost_is_still_known_by_its_tag(world):
    hub, router, adapter, db = world
    db.say(ME, "earlier", sender=ME, from_me=1)
    await set_up(router, adapter, db, ME, "mine")
    router.state.sent.clear()
    row = db.say(ME, "Jarvis: an answer from before a restart", sender=ME, from_me=1)
    rows = im.read_rows(db.path, ME, row - 1)
    assert adapter.whose(rows[0]) == "own" and row in adapter.own_rows
    echo = db.say(ME, "Jarvis: an answer from before a restart", sender=ME)  # its echo copy
    assert adapter.whose(im.read_rows(db.path, ME, echo - 1)[0]) == "own"
    mine = db.say(ME, "Jarvis, and the weather?", sender=ME, from_me=1)  # the owner's
    assert adapter.whose(im.read_rows(db.path, ME, mine - 1)[0]) == "owner"


async def test_a_shared_conversation_needs_the_name_in_front(world):
    hub, router, adapter, db = world
    db.chat("chat1234", [BOB], name="Family")
    db.say("chat1234", "hi all", sender=BOB)
    await set_up(router, adapter, db, "chat1234", "mine")
    assert router.state.imessage["prefix"] is True  # forced: others read this conversation
    await hub.start()
    messages = Messages(db, "chat1234")
    adapter.run_script = messages
    db.say("chat1234", "what's for dinner?", from_me=1)  # the owner, to the family
    db.say("chat1234", "Jarvis, what's on tomorrow?", sender=BOB)  # not the owner
    db.say("chat1234", "Jarvis, what's on tomorrow?", from_me=1)
    db.say("chat1234", "贾维斯，明天有什么安排？", from_me=1)
    await adapter.poll_once()
    await settle(router)
    assert hub.client.said[-2:] == ["what's on tomorrow?", "明天有什么安排？"]
    assert hub.commands == 2


async def test_a_burst_bigger_than_one_read_is_read_on_at_once(world, monkeypatch):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    real = im.read_rows
    monkeypatch.setattr(im, "MAX_ROWS", 2)
    monkeypatch.setattr(im, "read_rows", lambda path, ident, after: real(path, ident, after, 2))
    seen = []

    async def receive(msg):
        seen.append(msg.text)

    router.receive = receive
    for n in range(3):
        db.say(ME, f"message {n}", sender=ME, own=JARVIS_ID)
    assert await adapter.poll_once() is True  # two read, more waiting
    assert await adapter.poll_once() is False
    assert seen == ["message 0", "message 1", "message 2"]


async def test_a_message_from_while_jarvis_was_off_is_not_acted_on(world):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    messages = Messages(db, ME, sender=ME)
    adapter.run_script = messages
    db.say(ME, "unlock the door", sender=ME, own=JARVIS_ID, at=time.time() - 3 * 3600)
    await adapter.poll_once()
    await settle(router)
    assert hub.commands == 0 and messages.texts()[0].startswith("Jarvis: You sent this at ")


async def test_a_card_is_answered_with_yes_in_the_conversation(world, monkeypatch):
    from jarvis.channels import router as routermod

    monkeypatch.setattr(routermod, "FORWARD_AFTER", 0.0)
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    messages = Messages(db, ME, sender=ME)
    adapter.run_script = messages
    asked = asyncio.create_task(hub.request_approval("Open the page?", "https://x.y"))
    for _ in range(100):
        if messages.sent:
            break
        await asyncio.sleep(0.01)
    text = messages.texts()[-1]
    assert text.startswith("Jarvis: Needs your OK: Open the page?") and words.HINT in text
    await adapter.poll_once()  # the card itself, back from the database: never an answer
    assert not asked.done()
    db.say(ME, "Yes", sender=ME, own=JARVIS_ID)
    await adapter.poll_once()
    await settle(router)
    assert await asked == "allow"
    assert messages.texts()[-1] == "Jarvis: You chose: Allow."


async def test_a_picture_waits_until_it_has_downloaded(world, tmp_path):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    await hub.start()
    adapter.run_script = Messages(db, ME, sender=ME)
    photo = adapter.attachments_root / "Attachments" / "IMG_1.png"
    db.say(ME, "what is this?", sender=ME, own=JARVIS_ID, files=[(photo, "image/png")])
    await adapter.poll_once()
    assert hub.commands == 0 and adapter.pending  # not down from iCloud yet
    photo.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    await adapter.poll_once()
    await settle(router)
    assert hub.commands == 1 and not adapter.pending
    assert hub._session_reads["private"]


async def test_an_attachment_outside_messages_folder_is_never_read(world, tmp_path):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    secret = tmp_path / "secret.txt"
    secret.write_text("not for anyone")
    row = db.say(ME, "", sender=ME, own=JARVIS_ID, files=[(secret, "text/plain")])
    got = []

    async def receive(msg):
        got.append(msg)

    router.receive = receive
    adapter.pending.clear()
    rows = im.read_rows(db.path, ME, row - 1)
    await adapter._hand_on(rows[0], "")
    assert got and got[0].media == []


async def test_a_voice_message_is_transcribed_on_the_mac(world, tmp_path):
    import io
    import wave

    hub, router, adapter, db = world
    hub.transcriber = Transcriber("remind me to call Ann")
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    await hub.start()
    messages = Messages(db, ME, sender=ME)
    adapter.run_script = messages
    clip = adapter.attachments_root / "Attachments" / "Audio Message.caf"
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x01" * 16000)
    clip.write_bytes(buf.getvalue())
    db.say(ME, "", sender=ME, own=JARVIS_ID, files=[(clip, "audio/x-caf")], audio=1)
    await adapter.poll_once()
    await settle(router)
    assert messages.texts()[0] == "Jarvis: Heard: “remind me to call Ann”"
    assert hub.client.said[-1] == "remind me to call Ann"


async def test_a_one_to_one_send_falls_back_to_the_chat(world):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    messages = Messages(db, ME, sender=ME)
    messages.fail_participant = True
    adapter.run_script = messages
    await adapter.send_text(f"iMessage;-;{ME}", "hello")
    script, args = messages.sent[0]
    assert "chat id chatId" in script and args == (f"iMessage;-;{ME}", "Jarvis: hello")


async def test_a_group_is_written_to_as_the_chat(world):
    hub, router, adapter, db = world
    db.chat("chat777", [ME, BOB], own=JARVIS_ID, name="Us")
    db.say("chat777", "hi", sender=BOB, own=JARVIS_ID)
    await set_up(router, adapter, db, "chat777", "jarvis", handles=[ME])
    messages = Messages(db, "chat777")
    adapter.run_script = messages
    await adapter.send_text("iMessage;+;chat777", "dinner's at 7")
    script, args = messages.sent[0]
    assert "chat id chatId" in script and args == ("iMessage;+;chat777", "Jarvis: dinner's at 7")


async def test_long_replies_are_cut_and_each_part_is_tagged(world):
    hub, router, adapter, db = world
    db.say(ME, "earlier", sender=ME, from_me=1)
    await set_up(router, adapter, db, ME, "mine")
    messages = Messages(db, ME, sender=ME)
    adapter.run_script = messages
    await adapter.send_text("g", "**Plan**\n" + "Step after step. " * 400)
    texts = messages.texts()
    assert len(texts) >= 3 and all(t.startswith("Jarvis: ") and len(t) <= im.LIMIT for t in texts)
    assert "**" not in texts[0] and texts[0].startswith("Jarvis: Plan")


async def test_no_full_disk_access_is_said(world, monkeypatch):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")

    def blocked(*_a):
        raise PermissionError("Full Disk Access")

    monkeypatch.setattr(im, "newest_row", blocked)
    monkeypatch.setattr(im, "read_rows", blocked)
    naps = []

    async def nap(seconds):
        naps.append(seconds)
        if seconds == 60:
            raise asyncio.CancelledError

    monkeypatch.setattr(im.asyncio, "sleep", nap)
    router.state.mark = {}
    with pytest.raises(asyncio.CancelledError):
        await adapter.run()
    assert adapter.state == "error" and "Full Disk Access" in adapter.error


async def test_a_new_database_file_starts_over_from_its_newest_row(world, tmp_path):
    hub, router, adapter, db = world
    db.say(ME, "hi", sender=ME, own=JARVIS_ID)
    await set_up(router, adapter, db, ME, "jarvis")
    router.state.mark["db"] = "another file"
    newest = db.say(ME, "sent before the swap", sender=ME, own=JARVIS_ID)
    await adapter.poll_once()
    assert router.state.mark["row"] == newest and hub.commands == 0


def test_a_hub_that_doesnt_poll_never_scripts_messages(settings, quiet_speaker, isolated):
    from jarvis.mac_tools import ToolFailure

    hub = make_hub(settings, quiet_speaker, isolated)
    adapter = hub.chat_channels.adapters["imessage"]
    assert adapter.db == hub.feature_path("chat.db")  # never the real Messages database

    async def attempt():
        with pytest.raises(ToolFailure):
            await adapter.run_script("anything", "x")

    asyncio.run(attempt())
