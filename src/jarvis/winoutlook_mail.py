"""Email in Outlook for Windows (the desktop program), through Outlook's own object model, so a person
whose mail lives in Microsoft 365 (a university's, an office's: where IMAP and app passwords are switched
off) can have it read to them and can dictate what goes out.

It answers the questions mailbox.py's helpers ask of an IMAP connection (folders, search, fetch, store,
move, append), from Outlook instead, so the mail tools above it (read, search, reply, send, tidy) are the
very ones every other account uses and nothing is said twice: the same cards, the same asking first.

- Only while Outlook is open: it attaches to the running program and never starts one (which could stop at
  a sign-in or a profile question nobody is there to answer).
- What goes out is made by Outlook itself, as a message the person wrote there: their signature, their
  font and size, the way Outlook lays out a reply (the original quoted below, the thread kept), and it is
  kept in their Sent Items by Outlook. So it looks like all their other mail.
- A message is named to the rest of the app by a number that stays the same from one question to the next
  (a small file of numbers and Outlook's own ids: outlook_ids.json beside the accounts).
- Classic Outlook only: the "new Outlook" is a web app with no way in; asked for here it is said in words.
"""

from __future__ import annotations

import contextlib
import email.policy
import email.utils
import gc
import html
import logging
import re
import sys
import tempfile
import time
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from . import jsonstore
from .mailbox import MAX_ATTACHMENT, Account, Attached, MailError, pick_attachment

log = logging.getLogger("jarvis")

ON_A_PC = sys.platform == "win32"  # (a test says it is, or isn't)

# Outlook's numbers for its own folders, and kinds of item.
FOLDER_INBOX, FOLDER_SENT, FOLDER_DRAFTS, FOLDER_TRASH, FOLDER_JUNK, FOLDER_CONTACTS = (
    6,
    5,
    16,
    3,
    23,
    10,
)
ITEM_MAIL, ITEM_MEETING = 43, 53
# What Outlook files as mail: an email, a bounce (report), and a meeting's request, cancellation and answers.
ITEM_CLASSES = (43, 46, 53, 54, 55, 56, 57)
BODY_PLAIN = 1  # (MailItem.BodyFormat: 1 plain text, 2 HTML, 3 rich text)
TRANSPORT_HEADERS = (
    "http://schemas.microsoft.com/mapi/proptag/0x007D001E"  # (the internet headers of a message)
)
# Properties Outlook keeps on a message and its people (MAPI tags, read through PropertyAccessor): the sender's
# and a recipient's plain address (no call to Exchange), and whether an attachment is only part of the layout
# (a logo in a signature).
PR_SENDER_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F"
PR_SMTP_ADDRESS = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F"
PR_ATTACH_HIDDEN = "http://schemas.microsoft.com/mapi/proptag/0x7FFE000B"
FLAG_MARKED = 2
SCAN = 3000  # the most messages looked through to find one (newest first, and no further back than asked)
TEXT_SCAN = 400  # the newest looked into (their words, which are slow to get) for a word
RESULTS = 500  # the most a search gives back
LISTING = 60  # ...and a plain listing (all, or the unread): the newest of these is all anyone reads
IDS_KEPT = 5000
HEADER_PEOPLE = 5  # of each kind (to, cc) looked up for a message listed, so one to everybody doesn't hold things up
# Outlook says it is busy (a dialog is open, it is starting up) with these: asking again a moment later works.
BUSY = {
    -2147418111,
    -2147417846,
}  # RPC_E_CALL_REJECTED 0x80010001, RPC_E_SERVERCALL_RETRYLATER 0x8001010A
BUSY_TRIES = 6
BUSY_PAUSE = 0.5
NOT_OPEN = "Outlook isn't open. Open it, and ask again."
WONT_WRITE = (
    "Outlook wouldn't let me write in that message just now (it may be busy or asking something on screen). "
    "Nothing was sent."
)
OFFLINE = (
    "Outlook is working offline, so it can't send. Turn off Work Offline (on Outlook's Send/Receive tab), "
    "then ask me again."
)
NEW_OUTLOOK = (
    "This computer's Outlook is the newer web-style one, which Jarvis can't read. "
    "The classic Outlook program is needed."
)

SENT_NAME, DRAFTS_NAME, TRASH_NAME, JUNK_NAME, ARCHIVE_NAME = (
    "Sent Items",
    "Drafts",
    "Deleted Items",
    "Junk Email",
    "Archive",
)


def _busy(exc: BaseException) -> bool:
    """Whether this is Outlook saying "not now, I'm busy" (not an answer about the thing asked)."""
    code = getattr(exc, "hresult", None)
    if code is None and getattr(exc, "args", None) and isinstance(exc.args[0], int):
        code = exc.args[0]
    return code in BUSY


def _retrying(call: Any, *args: Any) -> Any:
    """call(*args), asked again a moment later while Outlook says it is busy."""
    for tries in range(BUSY_TRIES):
        try:
            return call(*args)
        except Exception as exc:  # noqa: BLE001
            if not _busy(exc) or tries == BUSY_TRIES - 1:
                raise
            time.sleep(BUSY_PAUSE)
    return None  # (not reached)


def _prop(item: Any, name: str, default: Any = "") -> Any:
    for tries in range(BUSY_TRIES):
        try:
            value = getattr(item, name)
        except Exception as exc:  # noqa: BLE001 - a property this kind of item doesn't have
            if _busy(exc) and tries < BUSY_TRIES - 1:
                time.sleep(BUSY_PAUSE)
                continue
            return default
        return default if value is None else value
    return default


def _tag(item: Any, tag: str) -> Any:
    """A MAPI property of an item by its tag (None when it has none, or Outlook won't say)."""
    try:
        return item.PropertyAccessor.GetProperty(tag)
    except Exception:  # noqa: BLE001
        return None


def _local(value: Any) -> datetime | None:
    """An Outlook time (the PC's own clock) with the PC's time zone on it. None for no time: Outlook
    writes "none" as the year 4501, which Windows can't turn into a local time."""
    try:
        if int(value.year) >= 4000:
            return None
        return datetime(
            value.year, value.month, value.day, value.hour, value.minute, value.second
        ).astimezone()
    except (AttributeError, ValueError, OverflowError, OSError):
        return None


def recipient_smtp(recipient: Any) -> str:
    """The plain address of one of a message's people: Outlook keeps it on the recipient itself (a local
    read); its address book entry is asked only if that has none."""
    value = _tag(recipient, PR_SMTP_ADDRESS)
    if isinstance(value, str) and "@" in value:
        return value
    return smtp_of(_prop(recipient, "AddressEntry", recipient)) or str(_prop(recipient, "Address"))


def smtp_of(entry: Any) -> str:
    """The plain address of an Outlook sender or recipient: Exchange keeps its own kind of address
    (/O=EXCHANGELABS/…), so the person's real one is asked of it."""
    try:
        if str(_prop(entry, "Type", "")) == "SMTP" or "@" in str(_prop(entry, "Address", "")):
            return str(_prop(entry, "Address", ""))
        user = entry.GetExchangeUser()
        if user is not None:
            return str(user.PrimarySmtpAddress)
        lst = entry.GetExchangeDistributionList()
        if lst is not None:
            return str(lst.PrimarySmtpAddress)
    except Exception:  # noqa: BLE001
        pass
    return str(_prop(entry, "Address", ""))


class IdMap:
    """Numbers for Outlook's ids that stay the same: IMAP names a message by a number and the tools hold on
    to it between one question and the next."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        data = (jsonstore.load_json(path, dict) or {}) if path else {}
        self.next = int(data.get("next") or 1)
        self.ids: dict[str, int] = {
            k: int(v) for k, v in (data.get("ids") or {}).items() if isinstance(v, int)
        }
        self.by_number = {v: k for k, v in self.ids.items()}
        self._dirty = False

    def number(self, entry_id: str) -> int:
        found = self.ids.get(entry_id)
        if found is None:
            found = self.next
            self.next += 1
            self.ids[entry_id] = found
            self.by_number[found] = entry_id
            self._dirty = True
        return found

    def entry(self, number: int) -> str | None:
        return self.by_number.get(number)

    def save(self) -> None:
        if not self._dirty or self.path is None:
            return
        if len(self.ids) > IDS_KEPT:  # the oldest numbers go first
            keep = sorted(self.ids.items(), key=lambda kv: kv[1])[-IDS_KEPT:]
            self.ids = dict(keep)
            self.by_number = {v: k for k, v in self.ids.items()}
        with contextlib.suppress(OSError):
            self.path.parent.mkdir(parents=True, exist_ok=True)
            jsonstore.save_json(self.path, {"next": self.next, "ids": self.ids})
        self._dirty = False


def _connect(app: Any = None):
    """(application, namespace, pythoncom or None). MailError, in words, when Outlook isn't open."""
    if app is not None:
        return app, app.GetNamespace("MAPI"), None
    if not ON_A_PC:
        raise MailError("Outlook is only on a PC.")
    try:
        import pythoncom
        import win32com.client
    except ImportError as exc:
        raise MailError(
            "This computer can't talk to Outlook (a part of Jarvis is missing)."
        ) from exc
    pythoncom.CoInitialize()  # (COM is per thread, and this runs in a worker's)
    try:
        app = win32com.client.GetActiveObject("Outlook.Application")
        return app, _retrying(app.GetNamespace, "MAPI"), pythoncom
    except Exception as exc:  # noqa: BLE001
        with contextlib.suppress(Exception):
            pythoncom.CoUninitialize()
        raise MailError(NOT_OPEN) from exc


class OutlookMailbox:
    """What mailbox.Imap is to the helpers above, answered by the Outlook program."""

    def __init__(self, account: Account, ids_path: Path | None = None, app: Any = None) -> None:
        self.account = account
        self.ids = IdMap(ids_path)
        self._app = app
        self.ns: Any = None
        self._com: Any = None
        self.current: Any = None
        self.selected = "INBOX"

    def __enter__(self) -> OutlookMailbox:
        self.app, self.ns, self._com = _connect(self._app)
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self.ids.save()
        if self._com is not None:
            # Outlook's objects are let go of first: one released after COM is shut down on this thread can
            # crash it.
            self.app = self.ns = self.current = None
            gc.collect()
            with contextlib.suppress(Exception):
                self._com.CoUninitialize()
            self._com = None

    # ── folders ──

    def _default(self, which: int) -> Any:
        try:
            return self.ns.GetDefaultFolder(which)
        except Exception as exc:  # noqa: BLE001
            raise MailError("Outlook wouldn't open that folder.") from exc

    def _root(self) -> Any:
        return self._default(FOLDER_INBOX).Parent  # the mailbox's top

    def _find(self, parent: Any, name: str, depth: int = 3) -> Any:
        wanted = name.strip().lower()
        try:
            for folder in parent.Folders:
                if str(_prop(folder, "Name")).lower() == wanted:
                    return folder
            if depth > 1:
                for folder in parent.Folders:
                    found = self._find(folder, name, depth - 1)
                    if found is not None:
                        return found
        except Exception:  # noqa: BLE001
            return None
        return None

    def _folder(self, name: str) -> Any:
        key = (name or "INBOX").strip()
        low = key.lower()
        if low in ("inbox", "inbox/"):
            return self._default(FOLDER_INBOX)
        for names, which in (
            ((SENT_NAME.lower(), "sent", "sent mail"), FOLDER_SENT),
            ((DRAFTS_NAME.lower(),), FOLDER_DRAFTS),
            ((TRASH_NAME.lower(), "trash"), FOLDER_TRASH),
            ((JUNK_NAME.lower(), "junk", "spam"), FOLDER_JUNK),
        ):
            if low in names:
                return self._default(which)
        found = self._find(self._root(), key)
        if found is None:
            raise MailError(f"There's no folder called {name}.")
        return found

    def folders(self) -> list[dict[str, Any]]:
        out = [{"name": "INBOX", "flags": []}]
        for name, flag in (
            (SENT_NAME, "\\sent"),
            (DRAFTS_NAME, "\\drafts"),
            (TRASH_NAME, "\\trash"),
            (JUNK_NAME, "\\junk"),
        ):
            out.append({"name": name, "flags": [flag]})
        archive = self._find(self._root(), ARCHIVE_NAME, 1)
        if archive is not None:
            out.append({"name": str(_prop(archive, "Name", ARCHIVE_NAME)), "flags": ["\\archive"]})
        return out

    def special(self, use: str) -> str:
        if use == "archive":
            found = self._find(self._root(), ARCHIVE_NAME, 1)
            if found is None:
                try:  # a mailbox with no Archive folder gets one, so "archive that" works
                    found = self._root().Folders.Add(ARCHIVE_NAME)
                except Exception:  # noqa: BLE001
                    return ""
            return str(_prop(found, "Name", ARCHIVE_NAME))
        return {
            "sent": SENT_NAME,
            "drafts": DRAFTS_NAME,
            "trash": TRASH_NAME,
            "junk": JUNK_NAME,
        }.get(use, "")

    def select(self, folder: str = "INBOX", readonly: bool = True) -> int:
        self.current = self._folder(folder)
        self.selected = folder
        try:
            return int(self.current.Items.Count)
        except Exception:  # noqa: BLE001
            return 0

    def unseen(self, folder: str = "INBOX") -> int:
        try:
            return int(self._folder(folder).UnReadItemCount)
        except Exception:  # noqa: BLE001
            return 0

    # ── finding and reading ──

    def _walk(self, unread: bool = False, since: datetime | None = None) -> Any:
        """The folder's messages newest first, one at a time (none is held once it has been looked at: Exchange
        lets a program have only so many open at once). Stops at the first one older than `since`."""
        if self.current is None:
            self.select("INBOX")
        try:
            items = self.current.Items
            if unread:  # Outlook picks them out itself: a big inbox isn't walked through for them
                with contextlib.suppress(Exception):
                    items = _retrying(items.Restrict, "[UnRead] = True")
            _retrying(items.Sort, "[ReceivedTime]", True)
            item = _retrying(items.GetFirst)
            while item is not None:
                if _prop(item, "Class", 0) in ITEM_CLASSES:
                    if since is not None:
                        got = _local(_prop(item, "ReceivedTime", None))
                        if got is not None and got.replace(tzinfo=None) < since:
                            return  # (newest first: everything after this is older still)
                    yield item
                item = _retrying(items.GetNext)
        except Exception as exc:  # noqa: BLE001
            log.info("outlook mail: %s", type(exc).__name__)
            raise MailError("Outlook wouldn't give its mail just now (it may be busy).") from exc

    def _sender(self, item: Any) -> tuple[str, str]:
        name = str(_prop(item, "SenderName"))
        address = str(_prop(item, "SenderEmailAddress"))
        if str(_prop(item, "SenderEmailType")).upper() == "EX" or "@" not in address:
            kept = _tag(item, PR_SENDER_SMTP)  # (kept on the message: no call to Exchange)
            if isinstance(kept, str) and "@" in kept:
                address = kept
            else:
                sender = _prop(item, "Sender", None)
                if sender is not None:
                    address = smtp_of(sender) or address
        return name, address if "@" in address else ""

    def _people(self, item: Any) -> str:
        """Everyone a message went to, names and plain addresses (what a search for a recipient looks in: the
        message's To and CC hold only their names)."""
        found: list[str] = []
        try:
            for r in item.Recipients:
                found.append(f"{_prop(r, 'Name')} {recipient_smtp(r)}")
                if len(found) >= 40:
                    break
        except Exception:  # noqa: BLE001
            pass
        return " ".join(found)

    def _matches(
        self, item: Any, criteria: dict[str, Any], sender: tuple[str, str], people: Any = None
    ) -> bool:
        people = people or self._people
        if criteria.get("unseen") and not _prop(item, "UnRead", False):
            return False
        for key in ("from", "to", "subject"):
            want = criteria.get(key)
            if not want:
                continue
            if key == "from":
                hay = f"{sender[0]} {sender[1]}"
            elif key == "to":
                hay = (
                    f"{_prop(item, 'To')} {_prop(item, 'CC')} {people(item) if '@' in want else ''}"
                )
            else:
                hay = str(_prop(item, "Subject"))
            if want.lower() not in hay.lower():
                return False
        return True

    def search(self, *criteria: str) -> list[int]:
        """The numbers of the messages that fit (IMAP's few search words), OLDEST FIRST by when they came, so
        that the last few are the newest as they are on a server. (The numbers themselves say nothing of age:
        a message is numbered when first seen, and the first look goes newest first.)"""
        wanted: dict[str, Any] = {}
        words = list(criteria)
        i = 0
        while i < len(words):
            word = words[i].upper()
            if word == "UNSEEN":
                wanted["unseen"] = True
            elif word == "ALL":
                pass
            elif word in ("SINCE", "FROM", "TO", "SUBJECT", "TEXT", "UID") and i + 1 < len(words):
                value = words[i + 1].strip().strip('"')
                i += 1
                if word == "SINCE":
                    try:
                        wanted["since"] = datetime.strptime(value, "%d-%b-%Y")
                    except ValueError:
                        pass
                elif word == "UID":
                    wanted["uid"] = int(value) if value.isdigit() else -1
                else:
                    wanted[word.lower()] = value
            i += 1
        if "uid" in wanted:
            entry = self.ids.entry(wanted["uid"])
            return [wanted["uid"]] if entry and self._item(wanted["uid"]) is not None else []
        scan = TEXT_SCAN if wanted.get("text") else SCAN
        # A plain listing (no one asked for, no words) needs only the newest few.
        plain = not any(wanted.get(k) for k in ("from", "to", "subject", "text", "since"))
        cap = LISTING if plain else RESULTS
        # (a sender costs a call to Exchange: asked only when the search is about who it is from)
        needs_sender = bool(wanted.get("from") or wanted.get("text"))
        hits: list[int] = []
        seen = 0
        for item in self._walk(unread=bool(wanted.get("unseen")), since=wanted.get("since")):
            seen += 1
            if seen > scan:
                break
            sender = self._sender(item) if needs_sender else ("", "")
            if not self._matches(item, wanted, sender):
                continue
            if wanted.get("text") and wanted["text"].lower() not in (
                f"{_prop(item, 'Subject')} {_prop(item, 'Body')} {sender[0]}".lower()
            ):
                continue
            hits.append(self.ids.number(str(_prop(item, "EntryID"))))
            if len(hits) >= cap:
                break
        hits.reverse()  # (found newest first)
        return hits

    def attachment(self, number: int, which: str = "") -> Attached:
        """One attachment of a message, saved by Outlook itself and read back (see pick_attachment). The ones
        that are only part of the layout (a signature's logo) are not counted."""
        item = self._item(number)
        if item is None:
            raise MailError("That email isn't there any more.")
        files = self._files(item)
        names = [str(_prop(one, "FileName", "attachment")) for _place, one in files]
        found = files[pick_attachment(names, which)][1]
        name = str(_prop(found, "FileName", "attachment"))
        if int(_prop(found, "Size", 0) or 0) > MAX_ATTACHMENT:
            raise MailError(f"{name} is too big for me to open.")
        with tempfile.TemporaryDirectory(
            ignore_cleanup_errors=True
        ) as folder:  # (Windows may still hold it a moment)
            target = Path(folder) / "attachment"
            try:
                _retrying(found.SaveAsFile, str(target))
                return Attached(name, target.read_bytes())
            except Exception as exc:  # noqa: BLE001 - Outlook refused, or the file is gone
                raise MailError(f"Outlook wouldn't save {name} just now.") from exc

    def newest(self, count: int) -> list[int]:
        """The numbers of the newest messages in the selected folder, oldest first by when they came: nothing is
        read of them but their ids (what the index's pass asks every minute)."""
        found: list[int] = []
        for item in self._walk():
            found.append(self.ids.number(str(_prop(item, "EntryID"))))
            if len(found) >= count:
                break
        found.reverse()
        return found

    def still_unread(self, numbers: list[int]) -> list[int]:
        """Which of these messages are still unread (one that was moved or deleted is not)."""
        found = []
        for number in numbers:
            item = self._item(number)
            if item is not None and _prop(item, "UnRead", False):
                found.append(number)
        return found

    def _item(self, number: int) -> Any:
        entry = self.ids.entry(number)
        if not entry:
            return None
        try:
            return self.ns.GetItemFromID(entry)
        except Exception:  # noqa: BLE001 - moved or deleted since
            return None

    def _flags(self, item: Any) -> list[str]:
        flags = []
        if not _prop(item, "UnRead", False):
            flags.append("\\seen")
        if int(_prop(item, "FlagStatus", 0) or 0) == FLAG_MARKED:
            flags.append("\\flagged")
        return flags

    def _recipients(self, item: Any, kind: int, limit: int = 40) -> list[str]:
        out: list[str] = []
        try:
            for r in item.Recipients:
                if int(_prop(r, "Type", 0)) != kind:
                    continue
                address = recipient_smtp(r)
                name = str(_prop(r, "Name"))
                if "@" in address:
                    out.append(email.utils.formataddr((name if name != address else "", address)))
                if len(out) >= limit:
                    break
        except Exception:  # noqa: BLE001
            pass
        return out

    @staticmethod
    def _hidden(attachment: Any) -> bool:
        """An attachment that is only part of the layout (a logo in a signature), not a file sent."""
        return bool(_tag(attachment, PR_ATTACH_HIDDEN))

    def _files(self, item: Any) -> list[tuple[int, Any]]:
        """(its place in Outlook's list, it) for each file really attached, in order."""
        found: list[tuple[int, Any]] = []
        try:
            files = item.Attachments
            for index in range(1, min(int(files.Count), 60) + 1):
                one = files.Item(index)
                if not self._hidden(one):
                    found.append((index, one))
        except Exception:  # noqa: BLE001
            pass
        return found

    def _message(self, item: Any, number: int, full: bool) -> bytes:
        msg = EmailMessage(policy=email.policy.SMTP)
        name, address = self._sender(item)
        # (a sender whose address can't be told is "Name <>": a bare name would be taken for an address)
        msg["From"] = email.utils.formataddr((name, address)) or "Unknown sender <>"
        people = (
            40 if full else HEADER_PEOPLE
        )  # (a listing doesn't wait on every name of an all-staff mail)
        to = self._recipients(item, 1, people) or [str(_prop(item, "To"))]
        msg["To"] = ", ".join(x for x in to if x)
        cc = self._recipients(item, 2, people)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = str(_prop(item, "Subject")).replace("\r", " ").replace("\n", " ")
        when = _local(_prop(item, "ReceivedTime", None)) or _local(_prop(item, "SentOn", None))
        if when is not None:
            msg["Date"] = email.utils.format_datetime(when)
        msg["Message-ID"] = f"<outlook-{number}@outlook.local>"
        if not full:
            return msg.as_bytes()
        msg.set_content(str(_prop(item, "Body")) or "")
        try:  # a mailing list's mark, so a newsletter is known for one
            heads = str(item.PropertyAccessor.GetProperty(TRANSPORT_HEADERS))
            listed = re.search(r"(?im)^List-Unsubscribe:[ \t]*(\S[^\r\n]*)", heads)
            if listed:
                msg["List-Unsubscribe"] = listed.group(1).strip()
        except Exception:  # noqa: BLE001 - a message from this PC has no internet headers
            pass
        try:
            for _place, attachment in self._files(item)[:30]:
                msg.add_attachment(
                    b"x",
                    maintype="application",
                    subtype="octet-stream",
                    filename=str(_prop(attachment, "FileName", "attachment")),
                )
                msg.get_payload()[-1]["X-Attachment-Size"] = str(
                    int(_prop(attachment, "Size", 0) or 0)
                )
        except Exception:  # noqa: BLE001 - a message whose attachments won't list is still read
            pass
        return msg.as_bytes()

    def fetch(self, uids: list[int], what: str) -> dict[int, dict[str, Any]]:
        header_only = "HEADER.FIELDS" in what.upper()
        out: dict[int, dict[str, Any]] = {}
        for number in uids:
            item = self._item(number)
            if item is None:
                continue
            out[number] = {
                "flags": self._flags(item),
                "data": self._message(item, number, full=not header_only),
            }
        return out

    # ── changing ──

    def store(self, uid: int, flag: str, on: bool) -> None:
        item = self._item(uid)
        if item is None:
            return
        try:
            if flag.lower() == "\\seen":
                item.UnRead = not on
            elif flag.lower() == "\\flagged":
                item.FlagStatus = FLAG_MARKED if on else 0
            else:  # \Answered is Outlook's own doing (a reply sent from here marks it)
                return
            item.Save()
        except Exception as exc:  # noqa: BLE001
            raise MailError("Outlook wouldn't change that message.") from exc

    def move(self, uid: int, folder: str) -> None:
        item = self._item(uid)
        if item is None:
            raise MailError("That email isn't there any more.")
        try:
            item.Move(self._folder(folder))
        except MailError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise MailError("Outlook wouldn't move that message.") from exc

    def append(self, folder: str, raw: bytes, flags: str = "") -> None:
        """A draft is kept in Drafts (with the person's signature); a copy for Sent is not needed, because
        Outlook keeps what it sends."""
        if folder.lower() not in (DRAFTS_NAME.lower(), "drafts"):
            return
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        make_mail(self.app, msg, [], draft=True, address=self.account.address)


# ── a new message, or a reply, made by Outlook so it looks like all the person's others ──


def _paragraphs(text: str, span: str = "") -> str:
    """Plain words as the paragraphs Outlook writes: one per line, a blank line a gap. Letters outside plain ASCII
    are written as character references (Outlook keeps its HTML in the computer's own code page, which would
    turn them into question marks). span: the opening tag of the font Outlook puts on a new line, if it does."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    close = "</span>" if span else ""
    out = []
    for line in lines:
        if line.strip():
            words = html.escape(line).encode("ascii", "xmlcharrefreplace").decode("ascii")
            out.append(f"<p class=MsoNormal>{span}{words}{close}</p>")
        else:
            out.append("<p class=MsoNormal>&nbsp;</p>")
    return "".join(out)


_BODY_OPEN = re.compile(
    r"<body\b[^>]*>(\s*<div\b[^>]*class=\"?WordSection1\"?[^>]*>)?", re.IGNORECASE
)
_FIRST_LINE = re.compile(r"<p\b[^>]*class=\"?MsoNormal\"?[^>]*>", re.IGNORECASE)
_FONT_SPAN = re.compile(r"\s*(<span\b[^>]*\bstyle=(?:'[^']*'|\"[^\"]*\")[^>]*>)", re.IGNORECASE)


def _font_span(current: str) -> str:
    """The font the person writes in, as Outlook marks it on the empty first line of a new message: the opening
    tag of the span there, or "" when the line has none (then the page's own style, their default, applies)."""
    first = _FIRST_LINE.search(current)
    if not first:
        return ""
    found = _FONT_SPAN.match(current[first.end() : first.end() + 600])
    return found.group(1) if found else ""


def put_words_first(mail: Any, text: str) -> None:
    """The person's words at the top of a message Outlook has made, above whatever Outlook put there
    (their signature, the original in a reply), in the same font as everything Outlook writes. MailError when
    Outlook won't give the message to write in: it is never sent without its signature and thread."""
    try:
        if int(_prop(mail, "BodyFormat", 2) or 2) == BODY_PLAIN:
            mail.Body = text.rstrip() + "\r\n\r\n" + str(mail.Body or "")
            return
        current = str(mail.HTMLBody or "")
    except Exception as exc:  # noqa: BLE001
        raise MailError(WONT_WRITE) from exc
    if not current.strip():
        raise MailError(WONT_WRITE)
    words = _paragraphs(text, _font_span(current))
    found = _BODY_OPEN.search(current)
    if found:
        at = found.end()
        mail.HTMLBody = current[:at] + words + current[at:]
    else:
        mail.HTMLBody = f"<html><body>{words}</body></html>" + current


def _plain_body(msg: Any) -> str:
    part = msg.get_body(preferencelist=("plain", "html")) if hasattr(msg, "get_body") else None
    if part is None:
        return ""
    content = part.get_content()
    if part.get_content_type() == "text/html":
        content = re.sub(r"<[^>]+>", "", str(content))
    return str(content).strip()


def _addresses(value: Any) -> list[str]:
    return [a for _n, a in email.utils.getaddresses([str(value or "")]) if a]


def _use_account(ns: Any, mail: Any, address: str) -> None:
    """Send from the Outlook account that has this address (otherwise Outlook uses its default one)."""
    want = (address or "").lower()
    if not want:
        return
    with contextlib.suppress(Exception):
        for account in ns.Accounts:
            if str(_prop(account, "SmtpAddress")).lower() == want:
                mail.SendUsingAccount = account
                return


def make_mail(
    app: Any,
    msg: Any,
    recipients: list[str],
    draft: bool = False,
    original: Any = None,
    address: str = "",
) -> Any:
    """The message `msg` (the one approved) as an Outlook message: kept as a draft, or sent. original: the
    message being answered, so Outlook makes the reply (the person's reply layout, with the thread quoted by
    Outlook itself). address: the account to send from, for a new message (a reply goes from the one it came to)."""
    ns = _retrying(app.GetNamespace, "MAPI")
    if not draft and _prop(ns, "Offline", False):
        raise MailError(OFFLINE)
    keep: list[str] = []
    try:
        mail = _retrying(original.Reply) if original is not None else _retrying(app.CreateItem, 0)
        to, cc = _addresses(msg["To"]), _addresses(msg["Cc"])
        blind = [r for r in recipients if r.lower() not in {a.lower() for a in to + cc}]
        for field, value in (
            ("To", "; ".join(to)),
            ("CC", "; ".join(cc)),
            ("BCC", "; ".join(blind)),
            ("Subject", str(msg["Subject"] or "")),
        ):
            _retrying(setattr, mail, field, value)
        if original is None:
            _use_account(ns, mail, address)
        with contextlib.suppress(Exception):
            mail.GetInspector  # noqa: B018 - makes Outlook write the signature (it does when the window exists)
        put_words_first(mail, _plain_body(msg))
        folder = Path(tempfile.mkdtemp(prefix="jarvis-mail-"))
        for part in msg.iter_attachments():
            name = Path(part.get_filename() or "attachment").name
            target = folder / name
            target.write_bytes(part.get_payload(decode=True) or b"")
            _retrying(mail.Attachments.Add, str(target))
            keep.append(str(target))
        if draft:
            _retrying(mail.Save)
        else:
            _retrying(mail.Send)
    except MailError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.info("outlook send: %s", type(exc).__name__)
        raise MailError(
            "Outlook wouldn't send it (it may be asking something on screen, or be working offline)."
        ) from exc
    finally:
        for path in keep:
            with contextlib.suppress(OSError):
                Path(path).unlink()
    return mail


def send(
    account: Account,
    msg: Any,
    recipients: list[str],
    answered: tuple[str, int] | None = None,
    ids_path: Path | None = None,
    app: Any = None,
) -> None:
    """Hand the approved message to Outlook to send, as a reply when it answers one."""
    if not recipients:
        raise MailError("There's nobody to send it to.")
    box = OutlookMailbox(account, ids_path, app)
    with box:
        original = box._item(answered[1]) if answered else None
        make_mail(box.app, msg, recipients, original=original, address=account.address)


# ── who the person is, and who a name means ──


def identity(app: Any = None) -> tuple[str, str]:
    """(the person's name, the address Outlook sends from by default). MailError when it can't be told. The name
    is the person's (Outlook's current user), not the label of an account, which is often just its address."""
    box = OutlookMailbox(Account(id="outlook", address=""), None, app)
    with box:
        try:
            user = _prop(box.ns, "CurrentUser", None)
            name = str(_prop(user, "Name")) if user is not None else ""
            store = _prop(box.ns, "DefaultStore", None)
            store_id = str(_prop(store, "StoreID")) if store is not None else ""
            address = first = ""
            for account in box.ns.Accounts:
                smtp = str(_prop(account, "SmtpAddress"))
                if "@" not in smtp:
                    continue
                first = first or smtp
                with contextlib.suppress(Exception):
                    if store_id and str(account.DeliveryStore.StoreID) == store_id:
                        address = smtp  # (the account whose mail this reads: the default store's)
                        break
            address = address or first
            if "@" not in address and user is not None:
                address = smtp_of(_prop(user, "AddressEntry", user))
            if "@" not in address:
                raise MailError("Outlook wouldn't say which account it sends from.")
            return name or address, address
        except MailError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise MailError("Outlook wouldn't say which account it sends from.") from exc


def lookup(name: str, app: Any = None, limit: int = 8) -> list[tuple[str, str]]:
    """People Outlook knows by that name (the person's contacts, then the organisation's address
    list): [(name, address)]. Used when a name isn't an address the person has written to before."""
    box = OutlookMailbox(Account(id="outlook", address=""), None, app)
    found: list[tuple[str, str]] = []
    with box:
        try:
            recipient = box.ns.CreateRecipient(name)
            recipient.Resolve()
            if _prop(recipient, "Resolved", False):
                address = smtp_of(_prop(recipient, "AddressEntry", None))
                if "@" in address:
                    found.append((str(_prop(recipient, "Name", name)), address))
        except Exception:  # noqa: BLE001
            pass
        if not found:
            words = [w.lower() for w in name.split() if w]
            try:
                for contact in box.ns.GetDefaultFolder(FOLDER_CONTACTS).Items:
                    full = str(_prop(contact, "FullName"))
                    if words and all(w in full.lower() for w in words):
                        address = str(_prop(contact, "Email1Address"))
                        if "@" in address:
                            found.append((full, address))
                        if len(found) >= limit:
                            break
            except Exception:  # noqa: BLE001
                pass
    seen: set[str] = set()
    return [(n, a) for n, a in found if not (a.lower() in seen or seen.add(a.lower()))][:limit]


def installed() -> bool:
    """Whether the classic Outlook program is on this PC (it registers itself as Outlook.Application)."""
    if not ON_A_PC:
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Outlook.Application\CLSID"):
            return True
    except OSError:
        return False


def running() -> bool:
    try:
        import psutil

        return any(
            (p.info["name"] or "").lower() == "outlook.exe" for p in psutil.process_iter(["name"])
        )
    except Exception:  # noqa: BLE001
        return False
