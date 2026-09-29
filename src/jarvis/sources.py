"""More second-brain sources: this Mac's files, Photos, the last week of email and texts.

Each collector returns Notes and raises a readable error when macOS permission is
missing. Everything is read locally; it only reaches Claude when JARVIS searches the
second brain to answer you.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from .knowledge import Note, collect_folder

HOME = Path.home()
COMPUTER_FOLDERS = [HOME / "Documents", HOME / "Desktop", HOME / "Downloads"]
CHAT_DB = HOME / "Library" / "Messages" / "chat.db"
APPLE_EPOCH = datetime(2001, 1, 1)
APPLE_EPOCH_UNIX = 978307200
RECENT_DAYS = 7
MAX_PHOTOS = 2500

FULL_DISK_ACCESS = (
    "Texts need Full Disk Access: System Settings > Privacy & Security > Full Disk Access, "
    "then turn on J.A.R.V.I.S. and restart it."
)


def _jxa(script: str, timeout: int = 600) -> str:
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", "-"],
        input=script,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        message = proc.stderr.strip()
        if "-1743" in message or "Not authorized" in message:
            message = "macOS blocked access. Allow it in System Settings > Privacy & Security > Automation."
        raise RuntimeError(message or "The app didn't answer")
    return proc.stdout


# ── computer files ──


def collect_computer(folders: list[Path] | None = None, per_folder: int = 600) -> list[Note]:
    """The newest documents in Documents, Desktop and Downloads."""
    notes: list[Note] = []
    for folder in folders or COMPUTER_FOLDERS:
        notes.extend(collect_folder(folder, source="computer", limit=per_folder, newest_first=True))
    return notes


# ── Photos ──

PHOTOS_JXA = """
const Photos = Application('Photos');
const items = Photos.mediaItems;
const ids = items.id(), files = items.filename(), names = items.name(), notes = items.description(),
      keys = items.keywords(), dates = items.date(), places = items.location();
const out = [];
for (let i = 0; i < ids.length; i++) {
  out.push({id: ids[i], file: files[i] || '', title: names[i] || '', caption: notes[i] || '',
            keywords: keys[i] || [], date: dates[i] ? dates[i].toISOString() : '',
            place: places[i] || null});
}
JSON.stringify(out);
"""


def collect_photos(run=_jxa, limit: int = MAX_PHOTOS) -> list[Note]:
    items = json.loads(run(PHOTOS_JXA) or "[]")
    if not items:
        raise RuntimeError(
            "The Photos app on this Mac has no photos. To include your phone's photos, turn on "
            "iCloud Photos in Photos > Settings > iCloud."
        )
    items.sort(key=lambda p: p.get("date") or "", reverse=True)
    notes = []
    for p in items[:limit]:
        when = _parse_iso(p.get("date"))
        day = when.strftime("%A %d %B %Y") if when else "an unknown date"
        title = p.get("title") or p.get("caption") or f"Photo from {day}"
        parts = [f"Photo {p.get('file') or ''} taken {day}."]
        if p.get("title"):
            parts.append(f"Title: {p['title']}.")
        if p.get("caption"):
            parts.append(f"Caption: {p['caption']}.")
        if p.get("keywords"):
            parts.append("Keywords: " + ", ".join(p["keywords"]) + ".")
        place = p.get("place")
        if (
            isinstance(place, list)
            and len(place) == 2
            and all(isinstance(v, (int, float)) for v in place)
        ):
            parts.append(f"Location {place[0]:.4f}, {place[1]:.4f}.")
        notes.append(
            Note(
                id=f"photo:{p['id']}",
                source="photos",
                title=title[:120],
                text=" ".join(parts),
                ref=p["id"],
                group=when.strftime("%B %Y") if when else "Photos",
                modified=p.get("date") or "",
            )
        )
    return notes


# ── recent email ──

MAIL_JXA = """
const Mail = Application('Mail');
const cutoff = Date.now() - %d * 86400000;
const msgs = Mail.inbox.messages;
// One Apple Event per property for the whole inbox is far faster than 'whose' filtering.
const dates = msgs.dateReceived();
const picks = [];
for (let i = 0; i < dates.length; i++) if (dates[i] && dates[i].getTime() > cutoff) picks.push(i);
picks.sort((a, b) => dates[b] - dates[a]);
const out = [];
for (const i of picks.slice(0, %d)) {
  const m = msgs[i];
  let body = '';
  try { body = m.content().slice(0, 3000); } catch (e) {}
  out.push({id: m.messageId(), sender: m.sender(), subject: m.subject(),
            date: dates[i].toISOString(), body: body});
}
JSON.stringify(out);
"""
MAX_MAIL = 150


MAIL_DIR = HOME / "Library" / "Mail"


def mail_index() -> Path | None:
    """Mail's own SQLite index of every message (newest Mail data version first)."""
    try:
        versions = sorted(MAIL_DIR.glob("V*/MailData/Envelope Index"), reverse=True)
    except PermissionError:
        return None
    return versions[0] if versions else None


def collect_mail_index(
    db: Path | None = None, days: int = RECENT_DAYS, limit: int = 400
) -> list[Note]:
    """The last week of inbox mail from Mail's index: seconds instead of minutes of
    scripting, across every account. Needs Full Disk Access, like texts."""
    db = db or mail_index()
    if db is None or not os.access(db, os.R_OK):
        raise PermissionError(FULL_DISK_ACCESS.replace("Texts need", "Email needs"))
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
        summary_join = (
            "LEFT JOIN summaries su ON m.summary = su.ROWID"
            if "summaries" in tables and "summary" in cols
            else ""
        )
        summary_col = "su.summary" if summary_join else "''"
        header_join, header_col = "", "''"
        if "message_global_data" in tables and "global_message_id" in cols:
            gcols = {r[1] for r in conn.execute("PRAGMA table_info(message_global_data)")}
            if "message_id_header" in gcols:
                header_join = "LEFT JOIN message_global_data g ON m.global_message_id = g.ROWID"
                header_col = "g.message_id_header"
        deleted = "AND m.deleted = 0" if "deleted" in cols else ""
        cutoff = int((datetime.now() - timedelta(days=days)).timestamp())
        rows = conn.execute(
            f"""
            SELECT m.ROWID, a.address, a.comment, s.subject, {summary_col}, m.date_received,
                   mb.url, {header_col}
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
            {summary_join} {header_join}
            WHERE m.date_received > ? {deleted}
              AND lower(mb.url) LIKE '%inbox%'
            ORDER BY m.date_received DESC
            LIMIT ?
            """,
            (cutoff, limit),
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        raise RuntimeError(f"Couldn't read Mail's index: {exc}") from exc
    finally:
        conn.close()
    notes = []
    for rowid, address, name, subject, summary, received, _url, header in rows:
        when = datetime.fromtimestamp(received) if received else None
        who = (name or address or "Unknown sender").strip()
        subject = subject or "(no subject)"
        body = re.sub(r"\s+", " ", summary or "").strip()
        notes.append(
            Note(
                id=f"mail:{header or rowid}",
                source="mail",
                title=f"{subject} — {who}"[:140],
                text=(
                    f"Email from {who} <{address or ''}>"
                    + (f", {when:%A %d %B %Y %H:%M}" if when else "")
                    + f". Subject: {subject}.\n\n{body}"
                ),
                ref=(header or "").strip("<>"),
                group=who[:40],
                modified=when.isoformat(timespec="seconds") if when else "",
            )
        )
    return notes


def collect_mail_fast() -> list[Note]:
    """Mail's index when Full Disk Access allows it; otherwise ask for it."""
    return collect_mail_index()


def collect_mail(run=_jxa, days: int = RECENT_DAYS) -> list[Note]:
    items = json.loads(run(MAIL_JXA % (days, MAX_MAIL)) or "[]")
    notes = []
    for m in items:
        when = _parse_iso(m.get("date"))
        sender = m.get("sender") or "Unknown sender"
        subject = m.get("subject") or "(no subject)"
        body = re.sub(r"\n{3,}", "\n\n", (m.get("body") or "").strip())
        notes.append(
            Note(
                id=f"mail:{m['id']}",
                source="mail",
                title=f"{subject} — {_short_sender(sender)}"[:140],
                text=f"Email from {sender}, {when:%A %d %B %Y %H:%M}. Subject: {subject}.\n\n{body}"
                if when
                else f"Email from {sender}. Subject: {subject}.\n\n{body}",
                ref=m["id"],
                group=_short_sender(sender),
                modified=m.get("date") or "",
            )
        )
    return notes


def _short_sender(sender: str) -> str:
    match = re.match(r'\s*"?([^"<]+?)"?\s*<', sender)
    return (match.group(1) if match else sender).strip()[:40]


# ── recent texts ──

CONTACTS_JXA = """
const people = Application('Contacts').people;
const names = people.name(), phones = people.phones.value(), emails = people.emails.value();
const out = [];
for (let i = 0; i < names.length; i++) out.push([names[i], phones[i] || [], emails[i] || []]);
JSON.stringify(out);
"""


def contact_names(run=_jxa) -> dict[str, str]:
    """Phone numbers (last ten digits) and emails -> contact names. Empty if blocked."""
    try:
        people = json.loads(run(CONTACTS_JXA, 120) or "[]")
    except Exception:  # Contacts access declined: fall back to numbers
        return {}
    names: dict[str, str] = {}
    for name, phones, emails in people:
        for phone in phones:
            digits = re.sub(r"\D", "", phone)[-10:]
            if digits:
                names[digits] = name
        for email in emails:
            names[email.lower()] = name
    return names


def decode_attributed_body(blob: bytes | None) -> str:
    """Message text from the typedstream blob newer macOS stores instead of `text`."""
    if not blob:
        return ""
    start = blob.find(b"NSString")
    if start < 0:
        return ""
    marker = blob.find(b"+", start)
    if marker < 0 or marker + 1 >= len(blob):
        return ""
    length, offset = blob[marker + 1], marker + 2
    if length == 0x81:
        length, offset = int.from_bytes(blob[marker + 2 : marker + 4], "little"), marker + 4
    elif length == 0x82:
        length, offset = int.from_bytes(blob[marker + 2 : marker + 5], "little"), marker + 5
    return blob[offset : offset + length].decode("utf-8", "replace")


def collect_messages(
    db: Path = CHAT_DB, days: int = RECENT_DAYS, names: dict[str, str] | None = None
) -> list[Note]:
    """The last week of iMessage and SMS, one note per conversation per day."""
    if not os.access(db, os.R_OK):
        raise PermissionError(FULL_DISK_ACCESS)
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except sqlite3.OperationalError as exc:
        raise PermissionError(FULL_DISK_ACCESS) from exc
    cutoff = int((datetime.now() - timedelta(days=days) - APPLE_EPOCH).total_seconds() * 1e9)
    try:
        rows = conn.execute(
            """
            SELECT m.text, m.attributedBody, m.is_from_me, m.date, h.id,
                   c.display_name, c.chat_identifier, c.ROWID
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            LEFT JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE m.date > ?
            ORDER BY m.date
            """,
            (cutoff,),
        ).fetchall()
    except sqlite3.DatabaseError as exc:
        raise PermissionError(FULL_DISK_ACCESS) from exc
    finally:
        conn.close()
    names = contact_names() if names is None else names
    threads: dict[tuple, list[str]] = defaultdict(list)
    labels: dict[tuple, str] = {}
    for text, body, from_me, date, handle, display, identifier, chat_id in rows:
        message = (text or decode_attributed_body(body)).replace("￼", "").strip()
        if not message:
            continue
        when = datetime.fromtimestamp(date / 1e9 + APPLE_EPOCH_UNIX)  # stored in UTC seconds
        who = _name_for(handle or identifier or "", names)
        key = (chat_id or who, when.date())
        labels[key] = display or who
        threads[key].append(f"{when:%H:%M} {'Me' if from_me else who}: {message}")
    notes = []
    for (chat, day), lines in threads.items():
        label = labels[(chat, day)]
        notes.append(
            Note(
                id=f"texts:{chat}:{day.isoformat()}",
                source="messages",
                title=f"Texts with {label} · {day:%a %d %b}",
                text="\n".join(lines)[:20000],
                ref=str(chat),
                group=label,
                modified=day.isoformat(),
            )
        )
    return notes


def _name_for(handle: str, names: dict[str, str]) -> str:
    if "@" in handle:
        return names.get(handle.lower(), handle)
    digits = re.sub(r"\D", "", handle)[-10:]
    return names.get(digits, handle)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return (
            datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
        )
    except ValueError:
        return None
