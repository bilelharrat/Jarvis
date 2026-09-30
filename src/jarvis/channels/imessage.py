"""iMessage: the owner texts JARVIS from their iPhone, in one conversation picked in
Settings. Two ways to set it up:

- Note to self. Messages on this Mac is signed in with the owner's own Apple ID, and they
  text their own number or email. Their messages show up here as their own, and so do
  JARVIS's replies, sent from this Mac: so every reply starts with "Jarvis:", and JARVIS
  remembers what it sent (a fingerprint of each message, then its row and GUID once it
  shows up in the database) and never reads it back as the owner's. A note to self doesn't
  make the phone buzz.
- Jarvis's own Apple ID. A second Apple ID is signed in to Messages on this Mac and the
  owner texts that. Only messages from the owner's handles count; JARVIS's replies come
  from its own ID, and the phone buzzes for them.

Any other conversation (a group, or a chat with someone else on the owner's own Apple ID)
works only with a prefix: a message counts when the owner starts it with "Jarvis," (or
贾维斯), and replies go to everyone in it.

chat.db is read read-only (Full Disk Access): only the chosen conversation's new rows, and
only when the database has changed. Replies go through Messages by AppleScript, the text
passed as an argument, never as part of the script. Approval cards are answered with yes,
no or "no, because …" in the same conversation.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sqlite3
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .base import Channel, Inbound, Media, clip, plain_text, split_text
from .words import NEEDS_OK, hint_for, say

log = logging.getLogger("jarvis")

TAG = "Jarvis:"  # every message JARVIS sends here starts with it
CHECK_EVERY = 1.5  # seconds between looks at whether the database changed
REREAD_EVERY = 30.0  # and a read every so often regardless
LIMIT = 3000
MAX_ROWS = 50
PENDING_TRIES = 20  # an attachment still downloading is looked for this many times more
SENT_SECONDS = 24 * 3600  # a fingerprint of what JARVIS sent is kept this long
DEDUPE_SECONDS = 20.0  # a note to self's second copy of the same message is dropped
MAX_ATTACHMENT = 60_000_000
DETAIL = 600

SEND_TO_CHAT = """on run argv
    set chatId to item 1 of argv
    set msg to item 2 of argv
    tell application "Messages"
        send msg to chat id chatId
    end tell
end run"""
SEND_FILE_TO_CHAT = """on run argv
    set chatId to item 1 of argv
    set theFile to POSIX file (item 2 of argv)
    tell application "Messages"
        send theFile to chat id chatId
    end tell
end run"""

_PREFIX = re.compile(
    r"^\s*(?:(?:hey|ok|okay)[\s,，]+)?(?:jarvis|贾维斯)(?:(?![:：])[\s,，!！.。、]+|$)",
    re.IGNORECASE,
)
_AUDIO = (".caf", ".m4a", ".amr", ".aac", ".mp3", ".wav", ".opus", ".ogg")
_IMAGES = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff")


def fingerprint(text: str) -> str:
    return hashlib.sha256(" ".join(str(text).split()).lower().encode("utf-8")).hexdigest()[:24]


def _open(db: Path) -> sqlite3.Connection:
    if not os.access(db, os.R_OK):
        raise PermissionError("Full Disk Access")
    try:
        conn = sqlite3.connect(f"{Path(db).absolute().as_uri()}?mode=ro", uri=True, timeout=2)
    except sqlite3.OperationalError as exc:
        raise PermissionError("Full Disk Access") from exc
    deadline = time.monotonic() + 5
    conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def identity(db: Path) -> str:
    """The database file itself: a new file in its place starts the reading over."""
    try:
        st = os.stat(db)
    except OSError:
        return ""
    born = getattr(st, "st_birthtime", None)
    return f"{st.st_ino}:{born!r}" if born is not None else str(st.st_ino)


def changed_stamp(db: Path) -> tuple[Any, ...]:
    """What changes when Messages writes: the database and its write-ahead log."""
    out: list[Any] = []
    for path in (db, Path(f"{db}-wal")):
        try:
            st = os.stat(path)
            out += [st.st_mtime_ns, st.st_size]
        except OSError:
            out += [0, 0]
    return tuple(out)


def newest_row(db: Path) -> int:
    conn = _open(db)
    try:
        return int(conn.execute("SELECT max(ROWID) FROM message").fetchone()[0] or 0)
    finally:
        conn.close()


@dataclass
class Attachment:
    path: Path
    name: str
    media_type: str
    size: int


@dataclass
class Row:
    rowid: int
    guid: str
    text: str
    from_me: bool
    handle: str
    at: float  # epoch seconds
    audio: bool = False
    has_files: bool = False
    files: list[Attachment] = field(default_factory=list)


def _apple_seconds(value: Any) -> float:
    from ..sources import APPLE_EPOCH_UNIX

    try:
        stamp = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    if stamp <= 0:
        return 0.0
    return (stamp / 1e9 if stamp > 1e12 else stamp) + APPLE_EPOCH_UNIX


def _attachments(conn: sqlite3.Connection, rowid: int) -> list[Attachment]:
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"attachment", "message_attachment_join"} <= tables:
        return []
    cols = _columns(conn, "attachment")
    mime = "a.mime_type" if "mime_type" in cols else "NULL"
    name = "a.transfer_name" if "transfer_name" in cols else "NULL"
    size = "a.total_bytes" if "total_bytes" in cols else "0"
    out = []
    for filename, media_type, transfer, total in conn.execute(
        f"""SELECT a.filename, {mime}, {name}, {size} FROM message_attachment_join maj
            JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?""",
        (rowid,),
    ):
        if not filename:
            continue
        path = Path(os.path.expanduser(str(filename)))
        out.append(
            Attachment(path, str(transfer or path.name), str(media_type or ""), int(total or 0))
        )
    return out


def read_rows(db: Path, identifier: str, after: int, limit: int = MAX_ROWS) -> list[Row]:
    """The chosen conversation's messages after row `after`, oldest first."""
    from ..sources import decode_attributed_body

    conn = _open(db)
    try:
        cols = _columns(conn, "message")
        chats = [
            r[0]
            for r in conn.execute("SELECT ROWID FROM chat WHERE chat_identifier = ?", (identifier,))
        ]
        if not chats:
            return []
        pick = {
            "guid": "m.guid" if "guid" in cols else "''",
            "body": "m.attributedBody" if "attributedBody" in cols else "NULL",
            "reaction": "COALESCE(m.associated_message_type, 0)"
            if "associated_message_type" in cols
            else "0",
            "item": "COALESCE(m.item_type, 0)" if "item_type" in cols else "0",
            "files": "COALESCE(m.cache_has_attachments, 0)"
            if "cache_has_attachments" in cols
            else "0",
            "audio": "COALESCE(m.is_audio_message, 0)" if "is_audio_message" in cols else "0",
        }
        marks = ",".join("?" * len(chats))
        rows = conn.execute(
            f"""SELECT DISTINCT m.ROWID, {pick["guid"]}, m.text, {pick["body"]}, m.is_from_me,
                       m.date, h.id, {pick["reaction"]}, {pick["item"]}, {pick["files"]},
                       {pick["audio"]}
                FROM chat_message_join cmj
                JOIN message m ON m.ROWID = cmj.message_id
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE cmj.chat_id IN ({marks}) AND m.ROWID > ?
                ORDER BY m.ROWID LIMIT ?""",
            (*chats, after, limit),
        ).fetchall()
        out: list[Row] = []
        for rowid, guid, text, body, from_me, date, handle, reaction, item, files, audio in rows:
            if reaction or item:
                out.append(Row(int(rowid), str(guid or ""), "", bool(from_me), "", 0.0))
                continue  # a tapback or a system note: skipped, but read past
            words = (text or decode_attributed_body(body) or "").replace("￼", "").strip()
            row = Row(
                int(rowid),
                str(guid or ""),
                words,
                bool(from_me),
                str(handle or "").strip(),
                _apple_seconds(date),
                audio=bool(audio),
                has_files=bool(files),
            )
            if row.has_files:
                row.files = _attachments(conn, row.rowid)
            out.append(row)
        return out
    except sqlite3.DatabaseError as exc:
        raise OSError(f"chat.db: {exc}") from exc
    finally:
        conn.close()


def attachments_of(db: Path, rowid: int) -> list[Attachment]:
    conn = _open(db)
    try:
        return _attachments(conn, rowid)
    except sqlite3.DatabaseError as exc:
        raise OSError(f"chat.db: {exc}") from exc
    finally:
        conn.close()


def _same_handle(a: str, b: str) -> bool:
    a, b = a.strip().lower(), b.strip().lower()
    if not a or not b:
        return False
    if "@" in a or "@" in b:
        return a == b
    da, db_ = re.sub(r"\D", "", a), re.sub(r"\D", "", b)
    return bool(da) and da[-10:] == db_[-10:]


def list_chats(db: Path, limit: int = 30) -> list[dict[str, Any]]:
    """The recent conversations, newest first, for picking one in Settings: who's in each,
    and whether it's a note to self (the chat is with the handle this Mac writes from)."""
    conn = _open(db)
    try:
        cols = _columns(conn, "chat")
        style = "c.style" if "style" in cols else "NULL"
        addressed = "c.last_addressed_handle" if "last_addressed_handle" in cols else "''"
        name = "c.display_name" if "display_name" in cols else "''"
        rows = conn.execute(
            f"""SELECT c.ROWID, c.guid, c.chat_identifier, {name}, {style}, {addressed},
                       MAX(cmj.message_id) AS last
                FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
                GROUP BY c.ROWID ORDER BY last DESC LIMIT ?""",
            (limit * 3,),
        ).fetchall()
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        seen: dict[str, dict[str, Any]] = {}
        for rowid, guid, identifier, title, kind, own, last in rows:
            identifier = str(identifier or "")
            if not identifier or not guid:
                continue
            handles: list[str] = []
            if "chat_handle_join" in tables:
                handles = [
                    str(h[0])
                    for h in conn.execute(
                        """SELECT h.id FROM chat_handle_join chj JOIN handle h
                           ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?""",
                        (rowid,),
                    )
                    if h[0]
                ]
            group = kind == 43 or identifier.startswith("chat")
            entry = seen.get(identifier)
            if entry is None:
                when = conn.execute("SELECT date FROM message WHERE ROWID = ?", (last,)).fetchone()
                seen[identifier] = {
                    "id": identifier,
                    "guid": str(guid),
                    "name": str(title or "") or identifier,
                    "group": group,
                    "self": not group and _same_handle(identifier, str(own or "")),
                    "handles": handles[:12],
                    "last": _apple_seconds(when[0]) if when else 0.0,
                }
            else:
                entry["handles"] = list(dict.fromkeys(entry["handles"] + handles))[:12]
            if len(seen) >= limit:
                break
        return list(seen.values())
    except sqlite3.DatabaseError as exc:
        raise OSError(f"chat.db: {exc}") from exc
    finally:
        conn.close()


def _unavailable(*_args: Any, **_kw: Any) -> Awaitable[str]:
    async def refuse() -> str:
        from ..mac_tools import ToolFailure

        raise ToolFailure("Messages isn't used by a hub that doesn't poll")

    return refuse()


class IMessage(Channel):
    name = "imessage"
    title = "iMessage"
    limit = LIMIT
    buttons = False
    pairs = False
    max_file = 100_000_000

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        from ..sources import CHAT_DB

        self.db: Path = router.hub.feature_path("chat.db") if router.offline else CHAT_DB
        self.attachments_root: Path = (
            router.hub.feature_path("Attachments")
            if router.offline
            else Path.home() / "Library" / "Messages"
        )
        if router.offline:
            self.run_script: Callable[..., Awaitable[str]] = _unavailable
        else:
            from ..mac_tools import run_applescript

            self.run_script = run_applescript
        self.own_rows: deque[int] = deque(maxlen=500)  # rows JARVIS sent, once seen
        self.own_guids: deque[str] = deque(maxlen=500)
        self.recent_owner: deque[tuple[str, float]] = deque(maxlen=50)
        self.pending: dict[int, tuple[Row, int]] = {}

    # ── set-up ──

    @property
    def config(self) -> dict[str, Any]:
        return self.router.state.imessage

    def ready(self) -> bool:
        return bool(self.config.get("chat"))

    def home_chat(self) -> str | None:
        chat = self.config.get("chat")
        return chat["guid"] if chat else None

    def save_secrets(self, secrets_: dict[str, str]) -> None:
        pass  # nothing secret: the conversation is picked, not pasted

    def forget_secrets(self) -> None:
        pass

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        raise ValueError("iMessage is set up by picking a conversation.")

    async def recent_chats(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(list_chats, self.db)

    async def configure(self, msg: dict[str, Any]) -> None:
        """The conversation picked in Settings, how Messages is signed in here, whose
        handles count, and whether a message must start with the name."""
        identifier = str(msg.get("chat") or "")
        try:
            chats = await self.recent_chats()
        except PermissionError:
            raise ValueError(
                "Jarvis needs Full Disk Access to read Messages. Turn it on in System Settings "
                "› Privacy & Security › Full Disk Access."
            ) from None
        except OSError:
            raise ValueError("Couldn't read Messages just now. Try again.") from None
        chat = next((c for c in chats if c["id"] == identifier), None)
        if chat is None:
            raise ValueError("Pick a conversation from the list.")
        account = "jarvis" if msg.get("account") == "jarvis" else "mine"
        known = {h.lower() for h in chat["handles"]} | {identifier.lower()}
        wanted = msg.get("handles")
        handles = [
            h
            for h in (str(v).strip().lower() for v in (wanted if isinstance(wanted, list) else []))
            if h in known
        ]
        if not handles and not chat["group"]:
            handles = sorted(known)
        if account == "jarvis" and not handles:
            raise ValueError("Tick the addresses that are yours.")
        shared = chat["group"] or (account == "mine" and not chat["self"])
        self.router.state.imessage = {
            "chat": {
                "id": identifier,
                "guid": chat["guid"],
                "name": chat["name"],
                "group": chat["group"],
                "self": chat["self"],
            },
            "handles": handles[:20],
            "account": account,
            "prefix": bool(msg.get("prefix")) or shared,
        }
        try:
            newest = await asyncio.to_thread(newest_row, self.db)
        except (PermissionError, OSError, sqlite3.Error):
            newest = 0
        self.router.state.mark = {"row": newest, "db": identity(self.db)}  # from now on
        self.pending.clear()
        self.halted = False

    def public(self) -> dict[str, Any]:
        cfg = self.config
        chat = cfg.get("chat") or {}
        return {
            "chat": {k: chat.get(k) for k in ("id", "name", "group", "self")} if chat else None,
            "handles": list(cfg.get("handles") or []),
            "account": cfg.get("account", "mine"),
            "prefix": bool(cfg.get("prefix")),
            "how": "Jarvis,",
        }

    # ── reading ──

    async def run(self) -> None:
        stamp: tuple[Any, ...] | None = None
        read_at = 0.0
        while True:
            now = time.monotonic()
            current = await asyncio.to_thread(changed_stamp, self.db)
            if current != stamp or now - read_at >= REREAD_EVERY or self.pending:
                try:
                    full = await self.poll_once()
                except PermissionError:
                    self.set_state(
                        "error",
                        "Jarvis needs Full Disk Access to read Messages (System Settings › "
                        "Privacy & Security › Full Disk Access).",
                    )
                    await asyncio.sleep(60)
                    continue
                except (OSError, sqlite3.Error) as exc:
                    log.info("imessage: couldn't read chat.db (%s)", type(exc).__name__)
                    self.set_state("reconnecting", "Couldn't read Messages just now. Trying again.")
                    await asyncio.sleep(5)
                    continue
                stamp, read_at = (None if full else current), now  # a full read: read on
                self.set_state("listening")
            await asyncio.sleep(CHECK_EVERY)

    async def poll_once(self) -> bool:
        """Read the new rows and hand the owner's messages on; True when the read was full
        (more may be waiting)."""
        cfg = self.config
        chat = cfg.get("chat")
        if not chat:
            return False
        state = self.router.state
        db_id = await asyncio.to_thread(identity, self.db)
        mark = state.mark
        if not mark or mark.get("db") != db_id:
            newest = await asyncio.to_thread(newest_row, self.db)
            state.mark = {"row": newest, "db": db_id}  # a first look (or a new file): from now
            self.router.save_soon()
            return False
        rows = await asyncio.to_thread(read_rows, self.db, chat["id"], int(mark["row"]))
        for row in rows:
            state.mark["row"] = max(int(state.mark["row"]), row.rowid)
            await self._take(row)
        if rows:
            self.router.save_soon()
        await self._retry_pending()
        return len(rows) >= MAX_ROWS

    async def _retry_pending(self) -> None:
        for rowid, (row, tries) in list(self.pending.items()):
            try:
                row.files = await asyncio.to_thread(attachments_of, self.db, rowid)
            except (PermissionError, OSError):
                continue
            if self._files_ready(row) or tries <= 1:
                del self.pending[rowid]
                await self._hand_on(row, self._text_of(row))
            else:
                self.pending[rowid] = (row, tries - 1)

    def _files_ready(self, row: Row) -> bool:
        return all(self._safe_path(a.path) is not None and a.path.is_file() for a in row.files)

    def _safe_path(self, path: Path) -> Path | None:
        """An attachment Messages keeps (under ~/Library/Messages), never anything else."""
        try:
            real = path.resolve()
            root = self.attachments_root.resolve()
        except (OSError, RuntimeError):
            return None
        return real if root in real.parents else None

    def whose(self, row: Row) -> str:
        """owner, own (JARVIS's), or other."""
        cfg = self.config
        if row.rowid in self.own_rows or (row.guid and row.guid in self.own_guids):
            return "own"
        if row.text and self._sent_recently(fingerprint(row.text)):
            return self._own(row)
        if row.text.startswith(TAG) and (row.from_me or cfg.get("chat", {}).get("self")):
            return self._own(row)  # a reply of JARVIS's whose fingerprint was lost
        mine = cfg.get("account") != "jarvis"
        if row.from_me:
            return "owner" if mine else "own"  # Jarvis's own Apple ID: anything sent is its own
        handles = cfg.get("handles") or []
        if row.handle and any(_same_handle(row.handle, h) for h in handles):
            if mine and not cfg.get("chat", {}).get("self"):
                return "other"  # on the owner's Apple ID their messages are the sent ones
            return "owner"
        return "other"

    def _own(self, row: Row) -> str:
        self.own_rows.append(row.rowid)
        if row.guid:
            self.own_guids.append(row.guid)
        return "own"

    def _sent_recently(self, mark: str) -> bool:
        cutoff = time.time() - SENT_SECONDS
        return any(h == mark and t >= cutoff for h, t in self.router.state.sent)

    def _text_of(self, row: Row) -> str | None:
        """The owner's words for JARVIS, without the name in front where it's needed; None
        when it doesn't count (no prefix where one is needed)."""
        text = row.text
        if self.config.get("prefix"):
            m = _PREFIX.match(text)
            if m is None:
                return None
            text = text[m.end() :].strip()
        return text

    async def _take(self, row: Row) -> None:
        if not row.text and not row.has_files:
            return
        if self.whose(row) != "owner":
            return
        text = self._text_of(row)
        if text is None:
            return
        mark = fingerprint(f"{text}|{','.join(a.name for a in row.files)}")
        now = time.time()
        if any(h == mark and now - t < DEDUPE_SECONDS for h, t in self.recent_owner):
            return  # the second copy of a note to self
        self.recent_owner.append((mark, now))
        if row.has_files and not self._files_ready(row):
            self.pending[row.rowid] = (row, PENDING_TRIES)  # still coming down from iCloud
            if len(self.pending) > 20:
                self.pending.pop(next(iter(self.pending)))
            return
        await self._hand_on(row, text)

    async def _hand_on(self, row: Row, text: str | None) -> None:
        if text is None:
            return
        media: list[Media] = []
        for item in row.files[:6]:
            path = self._safe_path(item.path)
            if path is None:
                continue
            suffix = path.suffix.lower()
            if row.audio or item.media_type.startswith("audio/") or suffix in _AUDIO:
                kind = "voice"
            elif item.media_type.startswith("image/") or suffix in _IMAGES:
                kind = "image"
            else:
                kind = "file"
            media.append(
                Media(
                    kind,
                    item.name,
                    item.media_type or _guess(suffix),
                    self._reader(path),
                    size=item.size,
                    path=path,
                )
            )
        await self.router.receive(
            Inbound(
                channel=self.name,
                chat=self.home_chat() or "",
                sender="me" if row.from_me else row.handle,
                name=row.handle or "me",
                text=text,
                at=row.at,
                media=media,
                owner=True,
            )
        )

    @staticmethod
    def _reader(path: Path) -> Callable[[], Awaitable[bytes]]:
        async def read() -> bytes:
            def load() -> bytes:
                if path.stat().st_size > MAX_ATTACHMENT:
                    raise OSError("too big")
                return path.read_bytes()

            return await asyncio.to_thread(load)

        return read

    # ── sending ──

    def remember(self, message: str) -> None:
        """What JARVIS is about to send: never to be read back as the owner's."""
        self.router.state.sent.append((fingerprint(message), time.time()))
        self.router.save_soon()

    async def _send(self, chat: str, message: str) -> None:
        from ..mac_tools import ToolFailure
        from ..messaging import SEND_IMESSAGE_SCRIPT
        from ..textclean import argv_text

        message = argv_text(message)
        self.remember(message)
        info = self.config.get("chat") or {}
        if info.get("group") or not info.get("id"):
            await self.run_script(SEND_TO_CHAT, chat, message)
            return
        # One-to-one: to its handle, the way messaging.py's Send does; the chat itself if
        # Messages won't take that.
        try:
            await self.run_script(SEND_IMESSAGE_SCRIPT, info["id"], message)
        except ToolFailure:
            await self.run_script(SEND_TO_CHAT, chat, message)

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        body = plain_text(text) if markup else text
        if title:
            body = f"{title}\n{body}"
        for chunk in split_text(body, LIMIT - len(TAG) - 1):
            await self._send(chat, f"{TAG} {chunk}")

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        lines = [f"{say(NEEDS_OK, lang)}: {clip(str(card.get('question', '')), 300)}"]
        detail = str(card.get("detail") or "").strip()
        if detail:
            lines.append(detail if len(detail) <= DETAIL else detail[:DETAIL] + "…")
        lines.append(hint_for(card, lang))
        await self.send_text(chat, "\n".join(lines), markup=False)
        return {"id": "", "at": time.time()}

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        if caption:
            await self.send_text(chat, caption, markup=False)
        await self.run_script(SEND_FILE_TO_CHAT, chat, str(path))


def _guess(suffix: str) -> str:
    import mimetypes

    return mimetypes.types_map.get(suffix, "")
