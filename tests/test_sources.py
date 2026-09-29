import json
import sqlite3
from datetime import datetime, timedelta

import numpy as np
import pytest

from jarvis import sources
from jarvis.knowledge import layout


def attributed(text: str) -> bytes:
    raw = text.encode()
    length = bytes([len(raw)]) if len(raw) < 0x81 else b"\x81" + len(raw).to_bytes(2, "little")
    return (
        b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+"
        + length
        + raw
        + b"\x86\x84"
    )


def test_decode_attributed_body_short_and_long():
    assert sources.decode_attributed_body(attributed("See you at 7")) == "See you at 7"
    long = "x" * 300
    assert sources.decode_attributed_body(attributed(long)) == long
    assert sources.decode_attributed_body(None) == ""


def make_chat_db(path, now):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB,
                              is_from_me INTEGER, date INTEGER, handle_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT, chat_identifier TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        INSERT INTO handle VALUES (1, '+1 (415) 555-0123');
        INSERT INTO chat VALUES (1, '', '+14155550123');
        """
    )

    def apple(dt):
        return int((dt.timestamp() - sources.APPLE_EPOCH_UNIX) * 1e9)

    rows = [
        (1, "Dinner at 7?", None, 0, apple(now - timedelta(hours=3)), 1),
        (2, None, attributed("Yes, see you there"), 1, apple(now - timedelta(hours=2)), 1),
        (3, "old news", None, 0, apple(now - timedelta(days=30)), 1),
    ]
    db.executemany("INSERT INTO message VALUES (?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO chat_message_join VALUES (1, ?)", [(1,), (2,), (3,)])
    db.commit()
    db.close()


def test_collect_messages_last_week_grouped_with_names(tmp_path):
    # Yesterday at noon: both texts land on one day whatever time the test runs (just after
    # midnight, "3 hours ago" and "2 hours ago" were two different days).
    now = (datetime.now() - timedelta(days=1)).replace(hour=12, minute=0, second=0, microsecond=0)
    make_chat_db(tmp_path / "chat.db", now)
    notes = sources.collect_messages(tmp_path / "chat.db", names={"4155550123": "Sam Rivera"})
    assert len(notes) == 1
    note = notes[0]
    assert note.source == "messages" and note.title.startswith("Texts with Sam Rivera")
    assert "Sam Rivera: Dinner at 7?" in note.text and "Me: Yes, see you there" in note.text
    assert "old news" not in note.text


def test_collect_messages_without_access_explains(tmp_path):
    with pytest.raises(PermissionError, match="Full Disk Access"):
        sources.collect_messages(tmp_path / "missing.db", names={})


def test_collect_photos_newest_first():
    payload = json.dumps(
        [
            {
                "id": "A",
                "file": "IMG_1.HEIC",
                "title": "",
                "caption": "",
                "keywords": [],
                "date": "2026-01-02T10:00:00Z",
                "place": None,
            },
            {
                "id": "B",
                "file": "IMG_2.HEIC",
                "title": "Lisbon sunset",
                "caption": "From the castle",
                "keywords": ["travel"],
                "date": "2026-05-02T19:00:00Z",
                "place": [38.7139, -9.1334],
            },
        ]
    )
    notes = sources.collect_photos(run=lambda _s, *a: payload, limit=1)
    assert [n.id for n in notes] == ["photo:B"]
    assert (
        "Lisbon sunset" in notes[0].text
        and "travel" in notes[0].text
        and "38.7139" in notes[0].text
    )


def test_collect_mail_titles_and_body():
    payload = json.dumps(
        [
            {
                "id": "abc@mail",
                "sender": '"Ann Lee" <ann@x.com>',
                "subject": "Board deck",
                "date": "2026-09-27T15:30:00Z",
                "body": "Draft attached.\n\n\n\nThanks",
            }
        ]
    )
    notes = sources.collect_mail(run=lambda _s, *a: payload)
    assert notes[0].title == "Board deck — Ann Lee"
    assert notes[0].group == "Ann Lee" and "Draft attached." in notes[0].text


def test_a_sender_is_named_in_linear_time():
    import time

    # Split, not matched: the pattern it was took 1.3 s for a name of 1,500 spaces (cubic).
    started = time.perf_counter()
    assert sources._short_sender(" " * 2000 + "x") == "x"
    assert sources._short_sender(" " * 2000 + "Ann <ann@x.com>") == "Ann"
    assert time.perf_counter() - started < 0.01
    assert sources._short_sender('"Ann Lee" <ann@x.com>') == "Ann Lee"
    assert sources._short_sender("Ann Lee<ann@x.com>") == "Ann Lee"
    assert sources._short_sender(" ann@x.com ") == "ann@x.com"
    assert sources._short_sender("<ann@x.com>") == "<ann@x.com>"


def test_layout_spreads_wordless_notes_and_labels_clusters():
    texts = [f"sourdough bread starter flour bake {i}" for i in range(20)]
    texts += [f"marathon running training tempo long run {i}" for i in range(20)]
    texts += ["" for _ in range(30)]  # photos with no words
    srcs = ["notes"] * 40 + ["photos"] * 30
    pos, edges, clusters = layout(texts, srcs)
    d = np.sqrt(((pos[:, None] - pos[None]) ** 2).sum(-1))
    np.fill_diagonal(d, 9)
    assert d.min() > 0.005  # nobody sits on top of anybody
    labels = " ".join(c["label"] for c in clusters)
    assert "sourdough" in labels or "bread" in labels or "flour" in labels
    assert "Photos" in labels


def make_mail_index(path, now):
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER, subject INTEGER, summary INTEGER,
                               date_received INTEGER, mailbox INTEGER, deleted INTEGER, global_message_id INTEGER);
        CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
        CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
        CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
        CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
        CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id_header TEXT);
        INSERT INTO addresses VALUES (1, 'ann@zainar.com', 'Ann Lee');
        INSERT INTO subjects VALUES (1, 'Board deck for Thursday'), (2, 'Old news'), (3, 'Weekly digest');
        INSERT INTO summaries VALUES (1, 'Draft attached, please review before Thursday.');
        INSERT INTO mailboxes VALUES (1, 'imap://bilel@askeden.com/INBOX'), (2, 'imap://bilel@askeden.com/Sent%20Messages');
        INSERT INTO message_global_data VALUES (1, '<abc123@zainar.com>');
        """
    )
    recent = int((now - timedelta(hours=5)).timestamp())
    old = int((now - timedelta(days=20)).timestamp())
    db.executemany(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)",
        [
            (1, 1, 1, 1, recent, 1, 0, 1),
            (2, 1, 2, None, old, 1, 0, None),
            (3, 1, 3, None, recent, 2, 0, None),
        ],
    )
    db.commit()
    db.close()


def test_mail_index_reads_last_week_of_inbox(tmp_path):
    make_mail_index(tmp_path / "Envelope Index", datetime.now())
    notes = sources.collect_mail_index(tmp_path / "Envelope Index")
    assert [n.title for n in notes] == [
        "Board deck for Thursday — Ann Lee"
    ]  # not sent mail, not old mail
    assert notes[0].ref == "abc123@zainar.com" and "please review" in notes[0].text


def test_mail_index_without_access_asks_for_it(tmp_path):
    with pytest.raises(PermissionError, match="Email needs Full Disk Access"):
        sources.collect_mail_index(tmp_path / "missing")


def test_empty_photos_library_explains():
    with pytest.raises(RuntimeError, match="iCloud Photos"):
        sources.collect_photos(run=lambda *_a: "[]")


def test_mail_index_looks_only_at_the_newest_rows(tmp_path, monkeypatch):
    make_mail_index(tmp_path / "Envelope Index", datetime.now())
    db = sqlite3.connect(tmp_path / "Envelope Index")
    recent = int((datetime.now() - timedelta(hours=1)).timestamp())
    db.executemany(
        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)",
        [(i, 1, 2, None, recent, 1, 0, None) for i in range(10, 510)],
    )
    db.commit()
    db.close()
    monkeypatch.setattr(sources, "RECENT_ROWS", 100)
    notes = sources.collect_mail_index(tmp_path / "Envelope Index", limit=1000)
    assert len(notes) == 100  # rows 410-509: the old board-deck row 1 is out of range
