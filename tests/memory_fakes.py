"""Shared fakes for the memory feature's tests: a hub with its desk, a stand-in for the
feature's model calls, and synthetic Messages and Mail databases."""

import sqlite3

from conftest import FakeClient

from jarvis.features import memory as feature
from jarvis.hub import Hub
from jarvis.sources import APPLE_EPOCH_UNIX


class FakeAI:
    """code_ai.call as the desk calls it: records each call, answers from a script."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    async def __call__(self, prompt, *, kind, system):
        self.calls.append({"kind": kind, "system": system, "prompt": prompt})
        if not self.replies:
            return "{}"
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def said(out):
    return out["content"][0]["text"]


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def desk_of(hub):
    """The hub's memory desk, its model calls answered by a FakeAI."""
    found = feature.desk_for(hub)
    found.ai = FakeAI()
    return found


def tools(desk):
    return {t.name: t.handler for t in desk.tools()}


def make_chat_db(path, rows, handles=None):
    """rows: (text, is_from_me, datetime, handle_rowid, chat_rowid, tapback kind)."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB,
            is_from_me INTEGER, date INTEGER, handle_id INTEGER, associated_message_type INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        """
    )
    for rowid, handle in (
        handles or {1: "+14155550142", 2: "ann@bsh.com", 3: "+15105550100"}
    ).items():
        conn.execute("INSERT INTO handle VALUES (?, ?)", (rowid, handle))
    conn.execute("INSERT INTO chat VALUES (1, '+14155550142', '')")
    conn.execute("INSERT INTO chat VALUES (2, 'chat99', 'Launch crew')")
    for i, (text, mine, when, handle, chat, kind) in enumerate(rows, start=1):
        stamp = int((when.timestamp() - APPLE_EPOCH_UNIX) * 1e9)
        conn.execute(
            "INSERT INTO message VALUES (?, ?, NULL, ?, ?, ?, ?)",
            (i, text, mine, stamp, handle, kind),
        )
        conn.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat, i))
    conn.commit()
    conn.close()


def make_mail_db(path, rows):
    """rows: (mailbox url, sender address, subject, summary, datetime, [recipient addresses])."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
        CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
        CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
        CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
        CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER, subject INTEGER,
            summary INTEGER, date_received INTEGER, date_sent INTEGER, mailbox INTEGER,
            deleted INTEGER);
        CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message_id INTEGER,
            address_id INTEGER, type INTEGER, position INTEGER);
        """
    )
    boxes: dict[str, int] = {}
    addresses: dict[str, int] = {}

    def address(value):
        if value not in addresses:
            addresses[value] = len(addresses) + 1
            conn.execute("INSERT INTO addresses VALUES (?, ?, '')", (addresses[value], value))
        return addresses[value]

    for i, (box, sender, subject, summary, when, to) in enumerate(rows, start=1):
        if box not in boxes:
            boxes[box] = len(boxes) + 1
            conn.execute("INSERT INTO mailboxes VALUES (?, ?)", (boxes[box], box))
        conn.execute("INSERT INTO subjects VALUES (?, ?)", (i, subject))
        conn.execute("INSERT INTO summaries VALUES (?, ?)", (i, summary))
        stamp = int(when.timestamp())
        conn.execute(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
            (i, address(sender), i, i, stamp, stamp, boxes[box]),
        )
        for n, rcpt in enumerate(to):
            conn.execute(
                "INSERT INTO recipients (message_id, address_id, type, position) VALUES (?, ?, 0, ?)",
                (i, address(rcpt), n),
            )
    conn.commit()
    conn.close()
