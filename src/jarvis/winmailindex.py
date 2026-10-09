"""The owner's email on a PC, kept in the shape of Apple Mail's own index (its Envelope Index), so
every part of JARVIS that reads that index works the same without a Mac: the heads-up for email
that matters (and "what did I miss"), who the owner writes to, the promises noticed in what they
sent, the order and appointment emails.

A pass (features/winmail.py runs one every minute) asks each account (the owner's IMAP accounts,
and the Outlook program) for its newest inbox and sent mail and writes what is new into one
SQLite file, with the tables those readers use: messages, addresses, subjects, summaries,
mailboxes, recipients and message_global_data. It stays on this PC. An email's words are kept only as
the short preview that Mail keeps too, and mail older than KEEP_DAYS is dropped from it.

Mail that is already waiting the first time an account is read, or that arrives late, is old news:
it is stored as read, so only email that arrives while JARVIS is running can interrupt anyone.
"""

from __future__ import annotations

import email.utils
import hashlib
import logging
import re
import sqlite3
import time
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from . import mailbox
from .mailbox import Account

log = logging.getLogger("jarvis")

INBOX_LOOK = 40  # the newest inbox messages looked at on a pass
SENT_LOOK = 40  # and the newest sent ones (who the owner writes to; what they promised)
PREVIEW_CHARS = 600  # of a body: about what Mail's own index keeps
FRESH_HOURS = 36  # mail older than this, turning up now, is old news and never a heads-up
LOOK_MARGIN = (
    900  # seconds: mail dated this long before a mailbox was first looked at was there already
)
# (a little less than that is not told apart from mail sent just before and delivered just after)
KEEP_DAYS = 60
PEEK = "(UID FLAGS BODY.PEEK[]<0.60000>)"  # the start of a message: its headers and the first of its text
RECENT_ROWS = 50_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT UNIQUE, seen_uid INTEGER, first_seen INTEGER);
CREATE TABLE IF NOT EXISTS addresses (ROWID INTEGER PRIMARY KEY, address TEXT UNIQUE, comment TEXT);
CREATE TABLE IF NOT EXISTS subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
CREATE TABLE IF NOT EXISTS summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
CREATE TABLE IF NOT EXISTS message_global_data (ROWID INTEGER PRIMARY KEY, message_id_header TEXT);
CREATE TABLE IF NOT EXISTS messages (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    sender INTEGER, subject INTEGER, summary INTEGER, global_message_id INTEGER,
    date_received INTEGER, date_sent INTEGER, mailbox INTEGER,
    read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    list_id_hash INTEGER DEFAULT 0, unsubscribe_type INTEGER DEFAULT 0,
    subject_prefix TEXT DEFAULT '',
    uid INTEGER, ref TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS messages_box ON messages (mailbox, uid);
CREATE INDEX IF NOT EXISTS messages_date ON messages (date_received);
CREATE TABLE IF NOT EXISTS recipients (message INTEGER, address INTEGER, position INTEGER);
CREATE INDEX IF NOT EXISTS recipients_message ON recipients (message);
"""


def box_url(account: Account, kind: str) -> str:
    """The mailbox's name in the index, as Mail names its own: "imap://<8 hex>/INBOX" or ".../Sent"
    (the readers go by the last part). Hex can't spell "sent" or "inbox", so an address
    (consent@…) can't make one mailbox look like the other."""
    token = hashlib.sha1(account.id.encode("utf-8")).hexdigest()[:8]
    scheme = "outlook" if account.kind == "outlook" else "imap"
    return f"{scheme}://{token}/{'INBOX' if kind == 'inbox' else 'Sent'}"


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _stamp(when: datetime | None, now: datetime) -> int:
    """A message's time as the index keeps it (seconds); never later than now."""
    if when is None:
        return int(now.timestamp())
    return int(min(when.timestamp(), now.timestamp()))


class Index:
    """The SQLite file, and the passes that keep it up to date."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    # ── the file ──

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=15)
        conn.executescript(SCHEMA)
        return conn

    def ready(self) -> bool:
        """Whether there is an index with mail in it: what the readers are pointed at."""
        if not self.path.is_file():
            return False
        try:
            conn = sqlite3.connect(f"{self.path.absolute().as_uri()}?mode=ro", uri=True, timeout=5)
        except sqlite3.Error:
            return False
        try:
            return bool(conn.execute("SELECT 1 FROM mailboxes LIMIT 1").fetchone())
        except sqlite3.Error:
            return False
        finally:
            conn.close()

    # ── one account ──

    def sync(
        self, account: Account, imap: Any, *, sent: bool = True, now: datetime | None = None
    ) -> int:
        """Read an account's newest inbox (and sent) mail into the index. imap: the open
        mailbox (mailbox.Imap, or the Outlook one). How many inbox emails are new and unread."""
        now = now or datetime.now(UTC)
        conn = self.connect()
        try:
            fresh = self._folder(conn, account, imap, "INBOX", "inbox", INBOX_LOOK, now)
            if sent:
                try:
                    folder = imap.special("sent")
                except mailbox.MailError:
                    folder = ""
                if folder:
                    self._folder(conn, account, imap, folder, "sent", SENT_LOOK, now)
            self._prune(conn, now)
            conn.commit()
            return fresh
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _box(
        self, conn: sqlite3.Connection, account: Account, kind: str, now: datetime
    ) -> tuple[int, bool, int]:
        """The mailbox's row, whether it was only just made (this is the first look at it), and when it was
        first looked at (mail from before then is old news for good)."""
        url = box_url(account, kind)
        row = conn.execute(
            "SELECT ROWID, first_seen FROM mailboxes WHERE url = ?", (url,)
        ).fetchone()
        if row:
            return int(row[0]), False, int(row[1] or 0)
        born = int(now.timestamp())
        made = conn.execute(
            "INSERT INTO mailboxes (url, first_seen) VALUES (?, ?)", (url, born)
        ).lastrowid
        return int(made or 0), True, born

    def _folder(
        self,
        conn: sqlite3.Connection,
        account: Account,
        imap: Any,
        folder: str,
        kind: str,
        look: int,
        now: datetime,
    ) -> int:
        box, first, born = self._box(conn, account, kind, now)
        # How far this mailbox has been read: the newest message kept, or looked at and too old to keep.
        top = max(
            (
                n
                for n in (
                    conn.execute(
                        "SELECT max(uid) FROM messages WHERE mailbox = ?", (box,)
                    ).fetchone()[0],
                    conn.execute(
                        "SELECT seen_uid FROM mailboxes WHERE ROWID = ?", (box,)
                    ).fetchone()[0],
                )
                if n is not None
            ),
            default=None,
        )
        imap.select(folder)
        if not isinstance(
            imap, mailbox.Imap
        ):  # Outlook: its newest, not a search through all of it
            uids = imap.newest(look) if hasattr(imap, "newest") else imap.search("ALL")
        elif top is None:
            uids = imap.search("ALL")
        else:  # a server with a big mailbox isn't asked for all of it every minute
            uids = [u for u in imap.search("UID", f"{int(top) + 1}:*") if u > int(top)]
        # (in the order of age as the mailbox gives it: oldest first; a server's numbers go up with age, Outlook's
        # don't, so the newest `look` are taken by place and the highest number is looked for)
        uids = list(dict.fromkeys(uids))[-look:]
        if uids and (top is None or max(uids) > top):
            conn.execute("UPDATE mailboxes SET seen_uid = ? WHERE ROWID = ?", (max(uids), box))
        if top is not None:  # (what was looked at before is not looked at again)
            uids = [u for u in uids if u > top]
        known = {
            int(r[0])
            for r in conn.execute(
                f"SELECT uid FROM messages WHERE mailbox = ? AND uid IN ({','.join('?' * len(uids))})",
                (box, *uids),
            )
        }
        new = [u for u in uids if u not in known]
        fresh = 0
        if new:
            fresh = self._add(conn, account, imap, folder, kind, box, new, first, born, now)
        if kind == "inbox":
            self._read_states(conn, imap, box)
        return fresh

    def _add(
        self,
        conn: sqlite3.Connection,
        account: Account,
        imap: Any,
        folder: str,
        kind: str,
        box: int,
        uids: list[int],
        first: bool,
        born: int,
        now: datetime,
    ) -> int:
        """Rows for these new messages. The ones that matter get their start read too (the
        text to be judged, or promises to be found); old news only its headers."""
        headers = imap.fetch(uids, mailbox.HEADER_FIELDS)
        wanted: list[int] = []
        quiet: set[int] = set()
        cutoff = now - timedelta(days=KEEP_DAYS)
        for uid in uids:
            got = headers.get(uid)
            if not got:
                continue
            summary = mailbox.summarize(account, folder, uid, got["flags"], got["data"])
            if summary.date is not None and summary.date < cutoff:
                continue  # (older than the index keeps: it would only be dropped again)
            # Old news: it was there when the mailbox was first looked at (a message that only now comes into
            # view, pushed up by others being moved away, is not new), or it is long since sent.
            old = first or (
                summary.date is not None
                and (
                    now - summary.date > timedelta(hours=FRESH_HOURS)
                    or summary.date.timestamp() <= born - LOOK_MARGIN
                )
            )
            if old:
                quiet.add(uid)
            if kind == "sent" or not old:
                wanted.append(uid)
        bodies = imap.fetch(wanted, PEEK) if wanted else {}
        fresh = 0
        for uid in sorted(uids):
            got = bodies.get(uid) or headers.get(uid)
            if not got or uid not in wanted and uid not in quiet:
                continue  # (nothing came for it, or it was too old to keep)
            try:
                full = mailbox.parse_full(account, folder, uid, got["flags"], got["data"])
            except Exception:  # noqa: BLE001 - a message nobody can parse isn't worth a pass
                log.debug("mail index: couldn't read a message", exc_info=True)
                continue
            s = full.summary
            body = _squash(full.body)[:PREVIEW_CHARS]  # (what's new in it, not the thread under it)
            is_quiet = uid in quiet
            unread = s.unread and not is_quiet and kind == "inbox"
            received = _stamp(s.date, now)
            sender = self._address(conn, s.address or s.sender, s.sender if s.address else "")
            cur = conn.execute(
                """INSERT OR IGNORE INTO messages
                   (sender, subject, summary, global_message_id, date_received, date_sent, mailbox,
                    read, flagged, list_id_hash, unsubscribe_type, uid, ref)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sender,
                    self._insert(conn, "subjects", "subject", s.subject or ""),
                    self._insert(conn, "summaries", "summary", body),
                    self._insert(conn, "message_global_data", "message_id_header", full.message_id),
                    received,
                    received,
                    box,
                    0 if unread else 1,
                    1 if s.flagged else 0,
                    1 if full.list_unsubscribe else 0,
                    1 if full.list_unsubscribe else 0,
                    uid,
                    f"{account.id}|{kind}|{uid}",
                ),
            )
            if not cur.rowcount:
                continue
            if kind == "sent":
                self._recipients(conn, int(cur.lastrowid or 0), full.to)
            elif unread:
                fresh += 1
        return fresh

    @staticmethod
    def _insert(conn: sqlite3.Connection, table: str, column: str, value: str) -> int:
        return int(
            conn.execute(f"INSERT INTO {table} ({column}) VALUES (?)", (value or "",)).lastrowid
            or 0
        )

    @staticmethod
    def _address(conn: sqlite3.Connection, address: str, name: str = "") -> int:
        """The row for an address (lowered), with the name it was last given."""
        key = (address or "").strip().lower()
        row = conn.execute(
            "SELECT ROWID, comment FROM addresses WHERE address = ?", (key,)
        ).fetchone()
        if row:
            if name and not row[1]:
                conn.execute("UPDATE addresses SET comment = ? WHERE ROWID = ?", (name, row[0]))
            return int(row[0])
        return int(
            conn.execute(
                "INSERT INTO addresses (address, comment) VALUES (?, ?)", (key, name or "")
            ).lastrowid
            or 0
        )

    def _recipients(self, conn: sqlite3.Connection, message: int, to: Iterable[str]) -> None:
        for position, (name, address) in enumerate(email.utils.getaddresses(list(to))[:10]):
            if address:
                conn.execute(
                    "INSERT INTO recipients (message, address, position) VALUES (?,?,?)",
                    (message, self._address(conn, address, name), position),
                )

    def _read_states(self, conn: sqlite3.Connection, imap: Any, box: int) -> None:
        """What the owner has read since (on their phone, in Outlook) is no longer news."""
        waiting = [
            int(r[0])
            for r in conn.execute("SELECT uid FROM messages WHERE mailbox = ? AND read = 0", (box,))
        ]
        if not waiting:
            return
        try:  # (Outlook is asked about just these; a server for all that is unread)
            unseen = set(
                imap.still_unread(waiting)
                if hasattr(imap, "still_unread")
                else imap.search("UNSEEN")
            )
        except mailbox.MailError:
            return
        gone = [u for u in waiting if u not in unseen]
        for start in range(0, len(gone), 500):
            part = gone[start : start + 500]
            conn.execute(
                f"UPDATE messages SET read = 1 WHERE mailbox = ? AND uid IN ({','.join('?' * len(part))})",
                (box, *part),
            )

    def _prune(self, conn: sqlite3.Connection, now: datetime) -> None:
        """Mail older than KEEP_DAYS goes (the row numbers carry on: they are never reused)."""
        gone = conn.execute(
            "DELETE FROM messages WHERE date_received < ?",
            (int((now - timedelta(days=KEEP_DAYS)).timestamp()),),
        ).rowcount
        if gone > 0:  # what only they used goes too
            conn.execute("DELETE FROM recipients WHERE message NOT IN (SELECT ROWID FROM messages)")
            for table, column in (
                ("subjects", "subject"),
                ("summaries", "summary"),
                ("message_global_data", "global_message_id"),
            ):
                conn.execute(
                    f"DELETE FROM {table} WHERE ROWID NOT IN "
                    f"(SELECT {column} FROM messages WHERE {column} IS NOT NULL)"
                )
            conn.execute(
                "DELETE FROM addresses WHERE ROWID NOT IN (SELECT sender FROM messages "
                "WHERE sender IS NOT NULL) AND ROWID NOT IN (SELECT address FROM recipients)"
            )

    # ── what the rest of JARVIS asks ──

    def forget(self, account: Account) -> None:
        """An account that was removed: its mail leaves the index too."""
        conn = self.connect()
        try:
            for kind in ("inbox", "sent"):
                row = conn.execute(
                    "SELECT ROWID FROM mailboxes WHERE url = ?", (box_url(account, kind),)
                ).fetchone()
                if row:
                    conn.execute(
                        "DELETE FROM recipients WHERE message IN "
                        "(SELECT ROWID FROM messages WHERE mailbox = ?)",
                        (row[0],),
                    )
                    conn.execute("DELETE FROM messages WHERE mailbox = ?", (row[0],))
                    conn.execute("DELETE FROM mailboxes WHERE ROWID = ?", (row[0],))
            conn.commit()
        finally:
            conn.close()

    def names(self, own: Iterable[str] = ()) -> dict[str, str]:
        """People the owner has written to: address -> the name they gave (or the address).
        These are the owner's own correspondents, who count as known where a Mac would
        use its Contacts. own: the owner's addresses, left out."""
        if not self.path.is_file():
            return {}
        skip = {a.lower() for a in own}
        try:
            conn = sqlite3.connect(f"{self.path.absolute().as_uri()}?mode=ro", uri=True, timeout=5)
        except sqlite3.Error:
            return {}
        try:
            rows = conn.execute(
                """SELECT a.address, a.comment FROM recipients r
                   JOIN addresses a ON r.address = a.ROWID
                   JOIN messages m ON r.message = m.ROWID
                   JOIN mailboxes b ON m.mailbox = b.ROWID
                   WHERE lower(b.url) LIKE '%/sent' ORDER BY m.date_received"""
            ).fetchall()
        except sqlite3.Error:
            return {}
        finally:
            conn.close()
        found: dict[str, str] = {}
        for address, name in rows:
            address = (address or "").strip().lower()
            if address and address not in skip:
                found[address] = (name or "").strip() or found.get(address) or address
        return found


class Backoff:
    """Accounts that failed are left alone for a while (a wrong password isn't tried every minute)."""

    def __init__(self, clock=time.monotonic) -> None:
        self._until: dict[str, float] = {}
        self._clock = clock

    def waiting(self, account_id: str) -> bool:
        return self._clock() < self._until.get(account_id, 0.0)

    def failed(self, account_id: str, minutes: float) -> None:
        self._until[account_id] = self._clock() + minutes * 60

    def ok(self, account_id: str) -> None:
        self._until.pop(account_id, None)
