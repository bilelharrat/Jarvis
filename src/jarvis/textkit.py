"""Messages: group chats by name, files sent with a text, and whether a text got there.

Group chats and delivery come from Messages' own database (~/Library/Messages/chat.db,
read-only: Full Disk Access, as the interrupter reads it); without it, the group chats come
from Messages itself by script. Sending goes through Messages by script, values passed in
through `on run argv`.

Nothing here decides whether something may be sent: messaging.py shows the owner the card
first.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

READ_SECONDS = 5.0
LOCK_SECONDS = 2.0
GROUP_STYLE = 43  # chat.style of a group conversation (45: one person)


@dataclass
class Group:
    """A group conversation in Messages: its id for scripts, its name, who's in it."""

    guid: str
    name: str
    handles: list[str] = field(default_factory=list)


def _open(db: Path) -> sqlite3.Connection:
    if not os.access(db, os.R_OK):
        raise PermissionError("no access")
    conn = sqlite3.connect(
        f"{Path(db).absolute().as_uri()}?mode=ro", uri=True, timeout=LOCK_SECONDS
    )
    deadline = time.monotonic() + READ_SECONDS
    conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
    return conn


def _plain(text: str) -> str:
    return " ".join(str(text or "").casefold().split())


def groups_from_db(db: Path) -> list[Group]:
    """Every named group conversation, newest first. PermissionError without access."""
    conn = _open(db)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(chat)")}
        if "guid" not in cols:
            return []
        style = "c.style = ?" if "style" in cols else "c.chat_identifier LIKE 'chat%' AND ? > 0"
        rows = conn.execute(
            f"""SELECT c.ROWID, c.guid, c.display_name FROM chat c
                WHERE {style} AND COALESCE(c.display_name, '') <> ''
                ORDER BY c.ROWID DESC LIMIT 500""",
            (GROUP_STYLE,),
        ).fetchall()
        found = []
        for chat_id, guid, name in rows:
            handles = [
                str(r[0])
                for r in conn.execute(
                    """SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
                       WHERE j.chat_id = ? LIMIT 40""",
                    (chat_id,),
                )
                if r[0]
            ]
            found.append(Group(str(guid), " ".join(str(name).split())[:120], handles))
        return found
    except sqlite3.DatabaseError as exc:
        raise PermissionError(str(exc)) from exc
    finally:
        conn.close()


# Messages' own list of chats: for a Mac without Full Disk Access for the app.
GROUPS_JXA = """
const Messages = Application('Messages');
const out = [];
for (const c of Messages.chats()) {
  let name = '';
  try { name = c.name() || ''; } catch (e) {}
  if (!name) continue;
  let people = [];
  try { people = c.participants().map((p) => p.handle() || p.name() || ''); } catch (e) {}
  if (people.length < 2) continue;
  out.push({id: c.id(), name: name, handles: people.slice(0, 40)});
}
JSON.stringify(out);
"""


def parse_groups(raw: str) -> list[Group]:
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        return []
    found = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict) and item.get("id") and item.get("name"):
            handles = [str(h) for h in item.get("handles") or [] if str(h).strip()]
            found.append(Group(str(item["id"]), " ".join(str(item["name"]).split())[:120], handles))
    return found


def match_groups(groups: list[Group], name: str) -> list[Group]:
    """The group chats a spoken name means: the name exactly (ignoring case and spacing),
    else those whose name holds the words asked for. Several back means ask which."""
    want = _plain(name)
    if not want:
        return []
    exact = [g for g in groups if _plain(g.name) == want]
    if exact:
        return exact
    words = want.split()
    return [g for g in groups if all(w in _plain(g.name) for w in words)]


# argv: the chat's id, the text ("" for none), then files (one path a line).
SEND_GROUP_SCRIPT = """on run argv
    set chatId to item 1 of argv
    set msg to item 2 of argv
    set fileList to paragraphs of (item 3 of argv)
    tell application "Messages"
        set theChat to chat id chatId
        if msg is not "" then send msg to theChat
        repeat with f in fileList
            if (contents of f) is not "" then send (POSIX file (contents of f)) to theChat
        end repeat
    end tell
end run"""

# argv: the person's handle, the text ("" for none), then files (one path a line).
SEND_FILES_SCRIPT = """on run argv
    set target to item 1 of argv
    set msg to item 2 of argv
    set fileList to paragraphs of (item 3 of argv)
    tell application "Messages"
        try
            set svc to 1st account whose service type = iMessage
            set buddy to participant target of svc
        on error
            set svc to 1st account whose service type = SMS
            set buddy to participant target of svc
        end try
        if msg is not "" then send msg to buddy
        repeat with f in fileList
            if (contents of f) is not "" then send (POSIX file (contents of f)) to buddy
        end repeat
    end tell
end run"""


# ── did it get there? ──


def newest_row(db: Path) -> int:
    """The newest message's row, before a send: what comes after is the send's."""
    try:
        conn = _open(db)
    except (PermissionError, sqlite3.Error):
        return -1
    try:
        return int(conn.execute("SELECT max(ROWID) FROM message").fetchone()[0] or 0)
    except sqlite3.DatabaseError:
        return -1
    finally:
        conn.close()


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def sent_status(db: Path, after: int, *, handle: str = "", chat: str = "") -> dict[str, Any] | None:
    """What Messages recorded of the owner's own messages sent after row `after` to this
    person (handle) or group (chat guid): {"rows": n, "delivered": bool, "sent": bool,
    "error": code}. None when it can't be told (no access) or nothing is there yet."""
    if after < 0:
        return None
    try:
        conn = _open(db)
    except (PermissionError, sqlite3.Error):
        return None
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(message)")}
        delivered = "m.is_delivered" if "is_delivered" in cols else "0"
        is_sent = "m.is_sent" if "is_sent" in cols else "1"
        error = "m.error" if "error" in cols else "0"
        if chat:
            rows = conn.execute(
                f"""SELECT {delivered}, {is_sent}, {error} FROM message m
                    JOIN chat_message_join j ON j.message_id = m.ROWID
                    JOIN chat c ON c.ROWID = j.chat_id
                    WHERE m.ROWID > ? AND m.is_from_me = 1 AND c.guid = ?
                    ORDER BY m.ROWID LIMIT 20""",
                (after, chat),
            ).fetchall()
        else:
            key = handle.strip().lower()
            if "@" in key:
                match, value = "lower(h.id) = ?", key
            else:
                digits = _digits(key)[-10:]
                if len(digits) < 7:
                    return None
                match, value = "h.id LIKE ?", f"%{digits}"
            rows = conn.execute(
                f"""SELECT {delivered}, {is_sent}, {error} FROM message m
                    JOIN handle h ON m.handle_id = h.ROWID
                    WHERE m.ROWID > ? AND m.is_from_me = 1 AND {match}
                    ORDER BY m.ROWID LIMIT 20""",
                (after, value),
            ).fetchall()
    except sqlite3.DatabaseError:
        return None
    finally:
        conn.close()
    if not rows:
        return None
    errors = [int(r[2] or 0) for r in rows if int(r[2] or 0)]
    return {
        "rows": len(rows),
        "delivered": all(bool(r[0]) for r in rows),
        "sent": all(bool(r[1]) for r in rows),
        "error": errors[0] if errors else 0,
    }
