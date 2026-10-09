"""Email without Mail.app: reading, searching, drafting and sending through the owner's own
mail servers (IMAP to read, SMTP to send), on any computer.

This is what J.A.R.V.I.S. uses on Windows, where there is no Mail.app to script, and it works
the same on a Mac for an account Mail doesn't have. Gmail, iCloud, Yahoo, Fastmail, AOL, Zoho
and any provider with IMAP are set up from the address alone (the servers are known); the
owner types the account's app password once in Settings, and it goes to the system's secret
store (Windows Credential Manager, the macOS Keychain) through keyring, never to a file, a
log or a reply. Mail goes straight from this computer to the provider: nothing passes
through askeden.com.

What comes back is other people's words: callers treat every message as data, never as
instructions (mailtools.py says so in the tool descriptions, and wraps what it reads).

Everything here is synchronous and meant for a worker thread. Nothing here decides whether
something may be sent: the tools that call it show the owner a card first.
"""

from __future__ import annotations

import contextlib
import email
import email.policy
import email.utils
import html
import imaplib
import logging
import mimetypes
import re
import smtplib
import ssl
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage, Message
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

log = logging.getLogger("jarvis")

SERVICE = "Jarvis mail"  # the secret store's name for the app passwords
TIMEOUT = 25  # seconds for a server to answer
MAX_LIST = 30
MAX_BODY = 60_000  # characters of a message kept for reading
MAX_ATTACHMENT = 25_000_000  # bytes of one attachment that will be opened to be read
MAX_ADDRESSES = 100


class MailError(RuntimeError):
    """Something to tell the owner, in words (never a password, never mail)."""


# ── servers ──

SECURITY = ("ssl", "starttls", "none")


@dataclass
class Account:
    id: str  # the address, lowered: how the tools name the account
    address: str
    name: str = ""  # the name on what's sent ("Bilel Harrat")
    label: str = ""  # the owner's own word for it ("work")
    username: str = ""  # "" is the address
    imap_host: str = ""
    imap_port: int = 993
    imap_security: str = "ssl"
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_security: str = "ssl"
    gmail: bool = False  # Gmail's search language and its own copy in Sent
    saves_sent: bool = False  # the server keeps a copy of what's sent by itself
    kind: str = "imap"  # "outlook": the Outlook program on this PC (winoutlook_mail.py), no servers, no password

    def login(self) -> str:
        return self.username or self.address

    def public(self) -> dict[str, Any]:
        return asdict(self)


# Servers by domain: (name, imap, smtp, flags, what the owner needs to know).
PRESETS: dict[str, dict[str, Any]] = {
    "gmail.com": {
        "name": "Gmail", "imap": ("imap.gmail.com", 993, "ssl"), "smtp": ("smtp.gmail.com", 465, "ssl"),
        "gmail": True, "saves_sent": True,
        "help": "Gmail needs an app password, not your usual one. Turn on 2-Step Verification in your Google Account, then open myaccount.google.com/apppasswords and make one for Jarvis.",
    },
    "icloud.com": {
        "name": "iCloud Mail", "imap": ("imap.mail.me.com", 993, "ssl"), "smtp": ("smtp.mail.me.com", 587, "starttls"),
        "help": "iCloud needs an app-specific password: sign in at account.apple.com, open Sign-In and Security, then App-Specific Passwords.",
    },
    "yahoo.com": {
        "name": "Yahoo Mail", "imap": ("imap.mail.yahoo.com", 993, "ssl"), "smtp": ("smtp.mail.yahoo.com", 465, "ssl"),
        "help": "Yahoo needs an app password: Account Security, then Generate app password.",
    },
    "outlook.com": {
        "name": "Outlook.com", "imap": ("outlook.office365.com", 993, "ssl"), "smtp": ("smtp-mail.outlook.com", 587, "starttls"),
        "saves_sent": True,
        "help": "Outlook.com and Hotmail need an app password too (Microsoft account, Security, Advanced security options, App passwords, after turning on two-step verification). Microsoft is moving mail apps to a newer sign-in that this app does not have yet, so it may refuse: if the check is refused, use another account for now.",
    },
    "aol.com": {
        "name": "AOL Mail", "imap": ("imap.aol.com", 993, "ssl"), "smtp": ("smtp.aol.com", 465, "ssl"),
        "help": "AOL needs an app password from its Account Security page.",
    },
    "fastmail.com": {
        "name": "Fastmail", "imap": ("imap.fastmail.com", 993, "ssl"), "smtp": ("smtp.fastmail.com", 465, "ssl"),
        "help": "Fastmail needs an app password: Settings, Privacy and Security, App Passwords.",
    },
    "zoho.com": {
        "name": "Zoho Mail", "imap": ("imap.zoho.com", 993, "ssl"), "smtp": ("smtp.zoho.com", 465, "ssl"),
        "help": "Zoho needs an application-specific password from its security page.",
    },
    "gmx.com": {
        "name": "GMX", "imap": ("imap.gmx.com", 993, "ssl"), "smtp": ("mail.gmx.com", 587, "starttls"),
        "help": "GMX needs IMAP switched on in its settings.",
    },
    "proton.me": {
        "name": "Proton Mail", "imap": ("127.0.0.1", 1143, "starttls"), "smtp": ("127.0.0.1", 1025, "starttls"),
        "help": "Proton Mail works through its Bridge app on this computer. Use the username and password Bridge shows, not your Proton password.",
    },
}  # fmt: skip
ALIASES = {
    "googlemail.com": "gmail.com", "me.com": "icloud.com", "mac.com": "icloud.com",
    "ymail.com": "yahoo.com", "rocketmail.com": "yahoo.com", "yahoo.co.uk": "yahoo.com",
    "hotmail.com": "outlook.com", "live.com": "outlook.com", "msn.com": "outlook.com",
    "outlook.co.uk": "outlook.com", "hotmail.co.uk": "outlook.com", "gmx.net": "gmx.com",
    "protonmail.com": "proton.me", "pm.me": "proton.me", "fastmail.fm": "fastmail.com",
}  # fmt: skip

_ADDRESS = re.compile(r"^[A-Za-z0-9_.+'%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$")


def is_address(text: str) -> bool:
    return bool(_ADDRESS.match((text or "").strip()))


def preset_for(address: str) -> dict[str, Any] | None:
    domain = address.rsplit("@", 1)[-1].lower().strip()
    return PRESETS.get(ALIASES.get(domain, domain))


def account_from(
    address: str, *, name: str = "", label: str = "", username: str = "", **servers: Any
) -> Account:
    """An account for an address: the provider's servers when they're known, else the usual
    guess (imap.<domain>, smtp.<domain>), and whatever the owner gave in `servers` on top."""
    address = address.strip()
    if not is_address(address):
        raise MailError("That doesn't look like an email address. Give it as name@example.com.")
    domain = address.rsplit("@", 1)[-1].lower()
    preset = preset_for(address)
    if preset:
        imap, smtp = preset["imap"], preset["smtp"]
    else:
        imap, smtp = (f"imap.{domain}", 993, "ssl"), (f"smtp.{domain}", 465, "ssl")
    account = Account(
        id=address.lower(),
        address=address,
        name=name.strip(),
        label=label.strip(),
        username=username.strip() if username.strip().lower() != address.lower() else "",
        imap_host=imap[0], imap_port=imap[1], imap_security=imap[2],
        smtp_host=smtp[0], smtp_port=smtp[1], smtp_security=smtp[2],
        gmail=bool(preset and preset.get("gmail")),
        saves_sent=bool(preset and preset.get("saves_sent")),
    )  # fmt: skip
    for key, value in servers.items():
        if key in Account.__dataclass_fields__ and value not in (None, ""):
            setattr(account, key, value)
    check(account)
    return account


def check(account: Account) -> None:
    """MailError when the account's settings can't work."""
    if account.kind == "outlook":  # (the Outlook program: nothing to dial)
        return
    for what, host, port, security in (
        ("incoming", account.imap_host, account.imap_port, account.imap_security),
        ("outgoing", account.smtp_host, account.smtp_port, account.smtp_security),
    ):
        if not host or not re.fullmatch(r"[A-Za-z0-9.-]+", host):
            raise MailError(f"The {what} mail server's name isn't right.")
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise MailError(f"The {what} mail server's port isn't right.")
        if security not in SECURITY:
            raise MailError(f"The {what} mail server's security must be ssl, starttls or none.")
        if security == "none" and host not in ("127.0.0.1", "localhost", "::1"):
            raise MailError(
                f"The {what} mail server must use a secure connection; a password never goes in the clear."
            )


# ── the accounts, and their passwords ──


class Vault:
    """App passwords, in the system's secret store (keyring)."""

    def get(self, account_id: str) -> str | None:
        import keyring

        return keyring.get_password(SERVICE, account_id)

    def set(self, account_id: str, password: str) -> None:
        import keyring

        keyring.set_password(SERVICE, account_id, password)

    def delete(self, account_id: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError

        with contextlib.suppress(PasswordDeleteError):
            keyring.delete_password(SERVICE, account_id)


class Accounts:
    """The owner's mail accounts (a JSON file without secrets; passwords are in the vault)."""

    def __init__(self, path: Path, vault: Vault | None = None) -> None:
        self.path = path
        self.vault = vault or Vault()
        self._lock = threading.Lock()

    def _read(self) -> list[Account]:
        from . import jsonstore

        data, _how = jsonstore.read_json(self.path, list)
        out = []
        for item in data or []:
            if isinstance(item, dict):
                with contextlib.suppress(TypeError, MailError):
                    account = Account(
                        **{k: v for k, v in item.items() if k in Account.__dataclass_fields__}
                    )
                    check(account)
                    out.append(account)
        return out

    def _write(self, accounts: list[Account]) -> None:
        from . import jsonstore

        jsonstore.save_json(self.path, [a.public() for a in accounts])

    def all(self) -> list[Account]:
        with self._lock:
            return self._read()

    def find(self, wanted: str = "") -> Account | None:
        """The account a word names (its address, or its label); the only one when none is
        named. None when there's none, or the word fits more than one or none."""
        accounts = self.all()
        wanted = (wanted or "").strip().lower()
        if not wanted:
            return accounts[0] if len(accounts) == 1 else None
        exact = [a for a in accounts if wanted in (a.id, a.label.lower(), a.name.lower())]
        if len(exact) == 1:
            return exact[0]
        near = [a for a in accounts if wanted in a.id or (a.label and wanted in a.label.lower())]
        return near[0] if len(near) == 1 else None

    def save(self, account: Account, password: str | None = None) -> None:
        check(account)
        with self._lock:
            accounts = [a for a in self._read() if a.id != account.id]
            accounts.append(account)
            self._write(accounts)
        if password:
            self.vault.set(account.id, password)

    def remove(self, account_id: str) -> bool:
        with self._lock:
            accounts = self._read()
            kept = [a for a in accounts if a.id != account_id]
            if len(kept) == len(accounts):
                return False
            self._write(kept)
        self.vault.delete(account_id)
        return True

    def password(self, account: Account) -> str:
        if account.kind == "outlook":
            return ""  # (Outlook is signed in already: there is no password of ours)
        try:
            secret = self.vault.get(account.id)
        except Exception as exc:  # noqa: BLE001 - a locked or missing store
            raise MailError(
                "I couldn't read the saved password. Open Settings, Email accounts, and enter it again."
            ) from exc
        if not secret:
            raise MailError(
                f"There's no saved password for {account.address}. Open Settings, Email accounts, and enter it."
            )
        return secret


def open_mailbox(account: Account, password: str, ids_path: Path | None = None) -> Any:
    """The way into an account's mail: an IMAP connection, or the Outlook program for an Outlook account.
    Either is used as `with open_mailbox(...) as box:` and answers the same questions."""
    if account.kind == "outlook":
        from .winoutlook_mail import OutlookMailbox

        return OutlookMailbox(account, ids_path)
    return Imap(account, password)


# ── turning what a server says into words ──


def friendly(account: Account, exc: BaseException, host: str = "") -> MailError:
    """A MailError in plain words for whatever the network or the server did. host: the
    server that was being talked to (the incoming one unless said)."""
    if isinstance(exc, MailError):
        return exc
    host = host or account.imap_host
    text = str(exc)
    low = text.lower()
    if isinstance(exc, imaplib.IMAP4.error | smtplib.SMTPAuthenticationError) and any(
        w in low for w in ("auth", "login", "credential", "password", "invalid", "535", "534")
    ):
        extra = ""
        preset = preset_for(account.address)
        if preset and preset.get("help"):
            extra = f" {preset['help']}"
        return MailError(f"{account.address} refused the password.{extra}")
    # (smtplib's errors are OSErrors too: what they say comes before the network's trouble)
    if isinstance(exc, smtplib.SMTPRecipientsRefused | smtplib.SMTPSenderRefused):
        return MailError("The mail server refused one of the addresses.")
    if isinstance(exc, smtplib.SMTPConnectError | smtplib.SMTPServerDisconnected):
        return MailError(
            f"I couldn't reach {host}. Check the internet connection and the server name."
        )
    if isinstance(exc, smtplib.SMTPException | imaplib.IMAP4.error):
        return MailError(f"{account.address}'s mail server said: {_scrub(text)[:200]}")
    if isinstance(exc, TimeoutError):
        return MailError(f"{host} didn't answer in time. Check the internet connection.")
    if isinstance(exc, ssl.SSLError):
        return MailError(
            f"The connection to {host} wasn't secure, so I stopped. Check the server settings."
        )
    if isinstance(exc, OSError):
        return MailError(
            f"I couldn't reach {host}. Check the internet connection and the server name."
        )
    return MailError("Something went wrong with the mail server.")


def _scrub(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ── IMAP ──


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def encode_id(account_id: str, folder: str, uid: int | str) -> str:
    """How a message is named to the model: account/folder/uid, nothing else to remember."""
    return f"{account_id}/{quote(folder, safe='')}/{uid}"


def decode_id(message_id: str) -> tuple[str, str, int]:
    parts = str(message_id).strip().strip("<>").split("/")
    if len(parts) != 3 or not parts[2].isdigit():
        raise MailError("That isn't an email id. Use the id a list or a search gave.")
    return parts[0].lower(), unquote(parts[1]), int(parts[2])


class Imap:
    """One signed-in IMAP connection (use as a context manager)."""

    def __init__(self, account: Account, password: str, timeout: float = TIMEOUT) -> None:
        self.account, self.password, self.timeout = account, password, timeout
        self.conn: imaplib.IMAP4 | None = None
        self.selected = ""

    def __enter__(self) -> Imap:
        a = self.account
        try:
            if a.imap_security == "ssl":
                self.conn = imaplib.IMAP4_SSL(
                    a.imap_host,
                    a.imap_port,
                    timeout=self.timeout,
                    ssl_context=ssl.create_default_context(),
                )
            else:
                self.conn = imaplib.IMAP4(a.imap_host, a.imap_port, timeout=self.timeout)
                if a.imap_security == "starttls":
                    self.conn.starttls(ssl_context=ssl.create_default_context())
            self.conn.login(a.login(), self.password)
        except Exception as exc:  # noqa: BLE001
            self.close()
            raise friendly(a, exc) from None
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def close(self) -> None:
        conn, self.conn = self.conn, None
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.logout()

    # a UID command, with the server's trouble turned into a MailError
    def _do(self, *args: Any):
        assert self.conn is not None
        try:
            typ, data = self.conn.uid(*args)
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        if typ != "OK":
            raise MailError(
                f"{self.account.address}'s mail server refused that ({_scrub(b' '.join(d for d in data if isinstance(d, bytes)).decode(errors='replace'))[:120]})."
            )
        return data

    def folders(self) -> list[dict[str, Any]]:
        """Every folder: {name, flags}."""
        assert self.conn is not None
        try:
            typ, data = self.conn.list()
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        out = []
        for raw in data or []:
            if not isinstance(raw, bytes):
                continue
            m = re.match(rb'\((?P<flags>[^)]*)\)\s+(?:"(?P<sep>[^"]*)"|NIL)\s+(?P<name>.+)$', raw)
            if not m:
                continue
            name = m.group("name").strip()
            if name.startswith(b'"') and name.endswith(b'"'):
                name = name[1:-1].replace(b'\\"', b'"').replace(b"\\\\", b"\\")
            out.append(
                {
                    "name": decode_utf7(name.decode("ascii", errors="replace")),
                    "flags": m.group("flags").decode().lower().split(),
                }
            )
        return out

    def special(self, use: str) -> str:
        """The folder that serves as sent, drafts, archive, trash or junk: by its server-given
        role when it has one, else by the usual names. "" when there is none."""
        names = {
            "sent": ("\\sent",), "drafts": ("\\drafts",), "archive": ("\\archive", "\\all"),
            "trash": ("\\trash",), "junk": ("\\junk",),
        }[use]  # fmt: skip
        usual = {
            "sent": ("Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "INBOX.Sent"),
            "drafts": ("Drafts", "[Gmail]/Drafts", "INBOX.Drafts"),
            "archive": ("Archive", "Archives", "[Gmail]/All Mail", "All Mail", "INBOX.Archive"),
            "trash": ("Trash", "Deleted Items", "[Gmail]/Trash", "INBOX.Trash"),
            "junk": ("Junk", "Spam", "[Gmail]/Spam", "Junk E-mail"),
        }[use]  # fmt: skip
        folders = self.folders()
        for f in folders:
            if any(role in f["flags"] for role in names):
                return f["name"]
        have = {f["name"].lower(): f["name"] for f in folders}
        for guess in usual:
            if guess.lower() in have:
                return have[guess.lower()]
        return ""

    def select(self, folder: str = "INBOX", readonly: bool = True) -> int:
        """Open a folder; its number of messages."""
        assert self.conn is not None
        try:
            typ, data = self.conn.select(_quote(encode_utf7(folder)), readonly=readonly)
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        if typ != "OK":
            raise MailError(f"There's no folder called {folder}.")
        self.selected = folder
        try:
            return int(data[0])
        except (TypeError, ValueError, IndexError):
            return 0

    def search(self, *criteria: str) -> list[int]:
        """UIDs matching, oldest first."""
        data = (
            self._do("SEARCH", *criteria) if self._ascii(criteria) else self._search_utf8(criteria)
        )
        return sorted(int(x) for x in (data[0] or b"").split())

    @staticmethod
    def _ascii(criteria: tuple[str, ...]) -> bool:
        return all(c.isascii() for c in criteria)

    def _search_utf8(self, criteria: tuple[str, ...]) -> list[bytes]:
        assert self.conn is not None
        try:
            typ, data = self.conn.uid(
                "SEARCH",
                "CHARSET",
                "UTF-8",
                *[c.encode("utf-8") if not c.isascii() else c for c in criteria],
            )
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        if typ != "OK":
            raise MailError("The mail server couldn't search for that.")
        return data

    def fetch(self, uids: list[int], what: str) -> dict[int, dict[str, Any]]:
        """{uid: {"flags": [...], "data": bytes}} for each message, `what` being the FETCH
        items (e.g. "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")."""
        if not uids:
            return {}
        out: dict[int, dict[str, Any]] = {}
        for start in range(0, len(uids), 100):
            chunk = uids[start : start + 100]
            data = self._do("FETCH", ",".join(str(u) for u in chunk), what)
            current: dict[str, Any] | None = None

            def done(item: dict[str, Any] | None) -> None:
                if item is not None and item["uid"] is not None:
                    out[item["uid"]] = {"flags": item["flags"], "data": item["data"]}

            # A message arrives as a tuple (what came before its text, the text) and then the
            # rest of its line; servers differ in where UID and FLAGS sit around the text.
            for part in data:
                if isinstance(part, tuple) and len(part) >= 2:
                    done(current)
                    current = {"uid": None, "flags": [], "data": part[1]}
                    _facts(part[0], current)
                elif isinstance(part, bytes) and current is not None:
                    _facts(part, current)
            done(current)
        return out

    def store(self, uid: int, flag: str, on: bool) -> None:
        self._do("STORE", str(uid), "+FLAGS" if on else "-FLAGS", f"({flag})")

    def move(self, uid: int, folder: str) -> None:
        """Move a message to another folder (copy, then remove the original)."""
        self._do("COPY", str(uid), _quote(encode_utf7(folder)))
        self.store(uid, "\\Deleted", True)
        assert self.conn is not None
        with contextlib.suppress(Exception):
            self.conn.expunge()

    def append(self, folder: str, raw: bytes, flags: str = "") -> None:
        assert self.conn is not None
        try:
            typ, _ = self.conn.append(
                _quote(encode_utf7(folder)),
                flags and f"({flags})",
                imaplib.Time2Internaldate(time.time()),
                raw,
            )
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        if typ != "OK":
            raise MailError(f"I couldn't save it in {folder}.")

    def unseen(self, folder: str = "INBOX") -> int:
        assert self.conn is not None
        try:
            typ, data = self.conn.status(_quote(encode_utf7(folder)), "(UNSEEN)")
        except Exception as exc:  # noqa: BLE001
            raise friendly(self.account, exc) from None
        m = re.search(rb"UNSEEN (\d+)", data[0] if data and data[0] else b"")
        return int(m.group(1)) if typ == "OK" and m else 0


def _facts(line: bytes, into: dict[str, Any]) -> None:
    """The UID and FLAGS a FETCH line carries, if it has them."""
    um = re.search(rb"UID (\d+)", line)
    if um and into["uid"] is None:
        into["uid"] = int(um.group(1))
    fm = re.search(rb"FLAGS \(([^)]*)\)", line)
    if fm:
        into["flags"] = [f.lower() for f in fm.group(1).decode("ascii", errors="replace").split()]


# Folder names on the wire are modified UTF-7 (RFC 3501); almost always plain ASCII.
def decode_utf7(text: str) -> str:
    if "&" not in text:
        return text

    def one(m: re.Match[str]) -> str:
        body = m.group(1)
        if not body:
            return "&"
        raw = body.replace(",", "/")
        raw += "=" * (-len(raw) % 4)
        import base64

        try:
            return base64.b64decode(raw).decode("utf-16-be")
        except Exception:  # noqa: BLE001
            return m.group(0)

    return re.sub(r"&([^-]*)-", one, text)


def encode_utf7(text: str) -> str:
    if text.isascii() and "&" not in text:
        return text
    import base64

    out, buf = [], ""

    def flush() -> None:
        nonlocal buf
        if buf:
            enc = base64.b64encode(buf.encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
            out.append(f"&{enc}-")
            buf = ""

    for ch in text:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf += ch
    flush()
    return "".join(out)


# ── messages ──


@dataclass
class Summary:
    id: str
    account: str
    folder: str
    uid: int
    sender: str  # "Ann Lee" or the address
    address: str
    subject: str
    date: datetime | None
    unread: bool = False
    flagged: bool = False
    recipient: str = ""  # who it was sent to (the first), for the Sent folder
    folder_kind: str = ""  # "sent" for what the owner wrote


def _header(msg: Message, name: str) -> str:
    value = msg.get(name)
    return _scrub(str(value)) if value is not None else ""


def parse_date(value: str) -> datetime | None:
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def summarize(
    account: Account, folder: str, uid: int, flags: list[str], header_bytes: bytes
) -> Summary:
    msg = email.message_from_bytes(header_bytes, policy=email.policy.default)
    name, address = email.utils.parseaddr(_header(msg, "From"))
    first_to = next(iter(email.utils.getaddresses([_header(msg, "To")])), ("", ""))
    return Summary(
        id=encode_id(account.id, folder, uid),
        account=account.id,
        folder=folder,
        uid=uid,
        sender=_scrub(name) or address or "Unknown sender",
        address=address,
        subject=_header(msg, "Subject") or "(no subject)",
        date=parse_date(_header(msg, "Date")),
        unread="\\seen" not in flags,
        flagged="\\flagged" in flags,
        recipient=_scrub(first_to[0]) or first_to[1],
    )


HEADER_FIELDS = "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])"


def list_messages(
    imap: Imap, folder: str = "INBOX", count: int = 10, unread_only: bool = False
) -> list[Summary]:
    """The newest messages in a folder, newest first."""
    imap.select(folder)
    uids = imap.search("UNSEEN" if unread_only else "ALL")
    chosen = uids[-max(1, min(MAX_LIST, count)) :]
    return sorted(
        (
            summarize(imap.account, folder, u, got["flags"], got["data"])
            for u, got in imap.fetch(chosen, HEADER_FIELDS).items()
        ),
        key=lambda s: s.date or datetime.min.replace(tzinfo=UTC),
        reverse=True,
    )


def find_messages(
    imap: Imap,
    *,
    person: str = "",
    subject: str = "",
    text: str = "",
    days: int = 365,
    limit: int = 5,
    sent: bool = False,
    unread_only: bool = False,
) -> list[Summary]:
    """Messages by who, what subject or what words, newest first. sent: from the Sent folder
    (to that person) instead of the inbox."""
    folder = (imap.special("sent") if sent else "INBOX") or "INBOX"
    imap.select(folder)
    since = (datetime.now() - timedelta(days=max(1, days))).strftime("%d-%b-%Y")
    if imap.account.gmail and not sent:
        q = []
        if person:
            q.append(f"from:{_gm(person)}")
        if subject:
            q.append(f"subject:{_gm(subject)}")
        if text:
            q.append(_gm(text))
        if unread_only:
            q.append("is:unread")
        q.append(f"after:{(datetime.now() - timedelta(days=max(1, days))).strftime('%Y/%m/%d')}")
        uids = imap.search("X-GM-RAW", _quote(" ".join(q)))
    else:
        crit: list[str] = ["SINCE", since]
        if person:
            crit += ["TO" if sent else "FROM", _quote(person)]
        if subject:
            crit += ["SUBJECT", _quote(subject)]
        if text:
            crit += ["TEXT", _quote(text)]
        if unread_only:
            crit.append("UNSEEN")
        uids = imap.search(*crit)
    chosen = uids[-max(1, min(MAX_LIST, limit)) :]
    found = [
        summarize(imap.account, folder, u, got["flags"], got["data"])
        for u, got in imap.fetch(chosen, HEADER_FIELDS).items()
    ]
    if sent:
        for item in found:
            item.folder_kind = "sent"
    return sorted(found, key=lambda s: s.date or datetime.min.replace(tzinfo=UTC), reverse=True)


def _gm(word: str) -> str:
    word = word.replace('"', "")
    return f'"{word}"' if " " in word else word


# ── reading one ──


class _Text(HTMLParser):
    """HTML to the words a person would read: block ends are line ends, links keep their
    words, nothing hidden is read (display none, zero-size text and the like are where
    instructions for an assistant hide)."""

    BLOCKS = {
        "p",
        "div",
        "br",
        "tr",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "table",
        "ul",
        "ol",
        "blockquote",
        "section",
        "article",
        "header",
        "footer",
        "hr",
    }
    SKIP = {"script", "style", "head", "title", "template", "noscript", "svg"}
    HIDDEN = re.compile(
        r"display\s*:\s*none|visibility\s*:\s*hidden|(?<![-\w])font-size\s*:\s*0(?![.\d%])|(?<![-\w])opacity\s*:\s*0(?![.\d])|max-height\s*:\s*0(?![.\d])|mso-hide\s*:\s*all|width\s*:\s*0(?:px)?\s*;\s*height\s*:\s*0",
        re.I,
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.stack: list[tuple[str, bool]] = []  # (tag, hides what's inside)
        self.href = ""
        self.link_words = 0

    def _hidden(self) -> bool:
        return any(h for _t, h in self.stack)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        void = tag in {"br", "hr", "img", "meta", "link", "input"}
        hides = (
            tag in self.SKIP
            or "hidden" in a
            or a.get("aria-hidden") == "true"
            or bool(self.HIDDEN.search(a.get("style", "")))
        )
        if not void:
            self.stack.append((tag, hides))
        if self._hidden() or (void and hides):
            return
        if tag in self.BLOCKS:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")
        if tag == "a":
            self.href, self.link_words = a.get("href", ""), 0
        if tag == "img" and a.get("alt"):
            self.parts.append(f"[image: {a['alt'].strip()}]")

    def handle_endtag(self, tag: str) -> None:
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                hidden_before = any(h for _t, h in self.stack[:i])
                del self.stack[i:]
                if hidden_before:
                    return
                break
        if self._hidden():
            return
        if tag in self.BLOCKS:
            self.parts.append("\n")
        if tag == "a":
            if self.href.startswith(("http://", "https://")) and not self.link_words:
                host = re.sub(r"^https?://(?:www\.)?", "", self.href).split("/")[0]
                self.parts.append(f"[link to {host}]")
            self.href = ""

    def handle_data(self, data: str) -> None:
        if self._hidden():
            return
        if data.strip():
            self.link_words += 1
        self.parts.append(data)


def html_to_text(source: str) -> str:
    parser = _Text()
    try:
        parser.feed(source)
        parser.close()
    except Exception:  # noqa: BLE001 - broken HTML: what was read so far
        pass
    text = html.unescape("".join(parser.parts))
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


QUOTE_START = re.compile(
    r"^(?:On .{5,200}wrote:|Le .{5,200}a écrit\s*:|Am .{5,200}schrieb .{0,80}:|-{2,}\s*Original Message\s*-{2,}|From: .+\nSent: .+|_{20,}|El .{5,200}escribió:)\s*$",
    re.I | re.M,
)


def without_quotes(text: str) -> tuple[str, bool]:
    """The new part of a message, without the thread quoted under it; and whether any was
    left out."""
    m = QUOTE_START.search(text)
    head = text[: m.start()] if m else text
    lines = head.split("\n")
    kept = [line for line in lines if not line.lstrip().startswith(">")]
    return "\n".join(kept).strip(), bool(m) or len(kept) != len(lines)


@dataclass
class Full:
    summary: Summary
    to: list[str] = field(default_factory=list)
    cc: list[str] = field(default_factory=list)
    reply_to: str = ""
    message_id: str = ""
    references: str = ""
    body: str = ""
    quoted_left_out: bool = False
    attachments: list[tuple[str, int]] = field(default_factory=list)
    raw_text: str = ""
    list_unsubscribe: str = ""


def parse_full(account: Account, folder: str, uid: int, flags: list[str], raw: bytes) -> Full:
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    s = summarize(account, folder, uid, flags, raw.split(b"\r\n\r\n", 1)[0] + b"\r\n\r\n")
    text = ""
    try:
        part = msg.get_body(preferencelist=("plain", "html"))
        if part is not None:
            content = part.get_content()
            text = html_to_text(content) if part.get_content_type() == "text/html" else str(content)
    except Exception:  # noqa: BLE001 - a part with a charset nobody knows
        text = ""
    attachments = []
    for part in msg.iter_attachments():
        name = part.get_filename() or part.get_content_type()
        try:
            size = len(part.get_payload(decode=True) or b"")
            said = part.get(
                "X-Attachment-Size"
            )  # (Outlook's: the part is a stand-in, the size is its)
            if said and str(said).strip().isdigit():
                size = int(str(said).strip())
        except Exception:  # noqa: BLE001
            size = 0
        attachments.append((_scrub(str(name)), size))
    new, left_out = without_quotes(text.replace("\r\n", "\n"))
    return Full(
        summary=s,
        to=[
            email.utils.formataddr(p)
            for p in email.utils.getaddresses([_header(msg, "To")])
            if p[1]
        ],
        cc=[
            email.utils.formataddr(p)
            for p in email.utils.getaddresses([_header(msg, "Cc")])
            if p[1]
        ],
        reply_to=_header(msg, "Reply-To"),
        message_id=_header(msg, "Message-ID"),
        references=_header(msg, "References"),
        body=(new or text.strip())[:MAX_BODY],
        quoted_left_out=left_out and bool(new),
        attachments=attachments,
        raw_text=text.strip()[:MAX_BODY],
        list_unsubscribe=_header(msg, "List-Unsubscribe"),
    )


@dataclass
class Attached:
    """One attachment of an email, opened: its file name and its bytes."""

    name: str
    data: bytes


def pick_attachment(names: list[str], which: str = "") -> int:
    """The (0-based) place of the attachment a request means: its number in the list (from 1), its
    file name or a part of it, or the only one when none is named. MailError, in words, otherwise."""
    if not names:
        raise MailError("That email has no attachments.")
    which = (which or "").strip().strip("\"'")
    shown = ", ".join(f"{i}. {n}" for i, n in enumerate(names, 1))
    if not which:
        if len(names) == 1:
            return 0
        raise MailError(f"It has {len(names)} attachments: {shown}. Which one?")
    if which.isdigit():
        if 1 <= int(which) <= len(names):
            return int(which) - 1
        raise MailError(f"There is no attachment number {which}. They are: {shown}.")
    low = which.lower()
    exact = [i for i, n in enumerate(names) if n.lower() == low]
    near = exact or [i for i, n in enumerate(names) if low in n.lower()]
    if len(near) == 1:
        return near[0]
    if not near:
        raise MailError(f"None of its attachments is called {which}. They are: {shown}.")
    raise MailError(f"More than one attachment fits {which}: {shown}. Which one?")


def attachment_of(imap: Any, folder: str, uid: int, which: str = "") -> Attached:
    """One attachment of an email, opened (see pick_attachment for how it is named)."""
    asker = getattr(imap, "attachment", None)
    if asker is not None:  # (the Outlook program saves it itself)
        return asker(uid, which)
    imap.select(folder)
    got = imap.fetch([uid], "(UID FLAGS BODY.PEEK[])").get(uid)
    if not got:
        raise MailError("That email isn't there any more.")
    msg = email.message_from_bytes(got["data"], policy=email.policy.default)
    parts = list(msg.iter_attachments())
    names = [_scrub(str(part.get_filename() or part.get_content_type())) for part in parts]
    index = pick_attachment(names, which)
    data = parts[index].get_payload(decode=True) or b""
    if len(data) > MAX_ATTACHMENT:
        raise MailError(f"{names[index]} is too big for me to open ({len(data) // 1_000_000} MB).")
    return Attached(names[index], bytes(data))


def read_message(imap: Imap, folder: str, uid: int) -> Full:
    imap.select(folder)
    got = imap.fetch([uid], "(UID FLAGS BODY.PEEK[])").get(uid)
    if not got:
        raise MailError("That email isn't there any more.")
    return parse_full(imap.account, folder, uid, got["flags"], got["data"])


# ── when, as it is said ──


def when(date: datetime | None, now: datetime | None = None) -> str:
    """ "today 3:05 PM", "yesterday 9:12 AM", "Monday 4:30 PM", "Oct 3"."""
    if date is None:
        return "no date"
    local = date.astimezone()
    now = (now or datetime.now()).astimezone()
    days = (now.date() - local.date()).days
    clock = local.strftime("%I:%M %p").lstrip("0")
    if days == 0:
        return f"today {clock}"
    if days == 1:
        return f"yesterday {clock}"
    if 1 < days < 7:
        return f"{local.strftime('%A')} {clock}"
    return local.strftime("%b %d").replace(" 0", " ") + (
        "" if local.year == now.year else f" {local.year}"
    )


# ── sending ──


def build_message(
    account: Account,
    to: list[str],
    subject: str,
    body: str,
    *,
    cc: list[str] | None = None,
    reply_to_message: Full | None = None,
    attachments: list[Path] | None = None,
) -> EmailMessage:
    """The message exactly as approved. Bcc recipients are not in it (send passes them to
    the server separately)."""
    msg = EmailMessage(policy=email.policy.SMTP)
    msg["From"] = (
        email.utils.formataddr((account.name, account.address)) if account.name else account.address
    )
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=account.address.rsplit("@", 1)[-1])
    if reply_to_message is not None and reply_to_message.message_id:
        msg["In-Reply-To"] = reply_to_message.message_id
        msg["References"] = (
            reply_to_message.references + " " + reply_to_message.message_id
        ).strip()
    msg.set_content(body)
    for path in attachments or []:
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        maintype, _, subtype = ctype.partition("/")
        msg.add_attachment(
            path.read_bytes(),
            maintype=maintype,
            subtype=subtype or "octet-stream",
            filename=path.name,
        )
    return msg


def send_message(account: Account, password: str, msg: EmailMessage, recipients: list[str]) -> None:
    """Hand the message to the account's outgoing server."""
    if not recipients:
        raise MailError("There's nobody to send it to.")
    a = account
    try:
        if a.smtp_security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                a.smtp_host, a.smtp_port, timeout=TIMEOUT, context=ssl.create_default_context()
            )
        else:
            server = smtplib.SMTP(a.smtp_host, a.smtp_port, timeout=TIMEOUT)
        with server:
            if a.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
            server.login(a.login(), password)
            server.send_message(msg, from_addr=a.address, to_addrs=recipients)
    except Exception as exc:  # noqa: BLE001
        raise friendly(a, exc, a.smtp_host) from None


def check_smtp(account: Account, password: str) -> None:
    """Sign in to the outgoing server and leave, to see that sending will work."""
    a = account
    try:
        if a.smtp_security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                a.smtp_host, a.smtp_port, timeout=TIMEOUT, context=ssl.create_default_context()
            )
        else:
            server = smtplib.SMTP(a.smtp_host, a.smtp_port, timeout=TIMEOUT)
        with server:
            if a.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
            server.login(a.login(), password)
    except Exception as exc:  # noqa: BLE001
        raise friendly(a, exc, a.smtp_host) from None


def quote_original(original: Full) -> str:
    """The text a reply quotes under it."""
    who = original.summary.sender
    when_ = (
        original.summary.date.astimezone().strftime("%a, %b %d, %Y at %I:%M %p")
        if original.summary.date
        else "an earlier date"
    )
    lines = original.raw_text.split("\n")[:60]
    return f"\n\nOn {when_}, {who} wrote:\n" + "\n".join(f"> {line}" for line in lines)


_THREAD_PREFIX = re.compile(
    r"^\s*(?:(?:re|aw|sv|antw|fw|fwd|wg|tr|rv)\s*(?:\[\d+\])?\s*[:：]\s*|\[[^\]]{1,40}\]\s*)+",
    re.IGNORECASE,
)


def thread_subject(subject: str) -> str:
    """A subject without its "Re:", "Fwd:", "AW:" and list tags in front: what every email of
    its thread shares."""
    return " ".join(_THREAD_PREFIX.sub("", _scrub(subject or "")).split())


def thread_of(imap: Any, folder: str, uid: int, days: int = 365, limit: int = 30) -> list[Full]:
    """The emails of one email's thread, in the inbox and the sent mail, oldest first: the ones
    whose subject is its subject without the Re: and Fwd: in front, each read in full (its new
    words only: what each quotes of the earlier ones is left out). Each folder gives its
    newest `limit` of them."""
    first = read_message(imap, folder, uid)
    root = thread_subject(first.summary.subject)
    found: dict[str, Full] = {}

    def keep(full: Full) -> None:
        key = full.message_id or f"{full.summary.folder}:{full.summary.uid}"
        found.setdefault(key, full)

    keep(first)
    if root and root != "(no subject)":
        for sent in (False, True):
            try:
                hits = find_messages(imap, subject=root, days=days, limit=limit, sent=sent)
            except MailError:
                if sent:
                    continue  # (an account with no sent folder still has its inbox's)
                raise
            for hit in hits:
                if thread_subject(hit.subject).casefold() != root.casefold():
                    continue  # a subject that only contains its words
                full = read_message(imap, hit.folder, hit.uid)
                full.summary.folder_kind = hit.folder_kind
                keep(full)
    return sorted(
        found.values(),
        key=lambda f: f.summary.date or datetime.min.replace(tzinfo=UTC),
    )


def reply_subject(subject: str) -> str:
    subject = _scrub(subject) or "(no subject)"
    if re.match(r"^(?:re|aw|sv|antw)\s*[:：]", subject, re.IGNORECASE):
        return subject
    return f"Re: {subject}"


def reply_recipients(
    account: Account, original: Full, everyone: bool
) -> tuple[list[str], list[str]]:
    """(to, cc) for a reply: the sender (or their Reply-To); with everyone, the others on it
    too, and never the owner."""
    mine = {account.address.lower()}
    first = original.reply_to or email.utils.formataddr(
        (original.summary.sender if original.summary.address else "", original.summary.address)
    )
    to = [email.utils.formataddr(p) for p in email.utils.getaddresses([first])]
    cc: list[str] = []
    if everyone:
        seen = {p[1].lower() for p in email.utils.getaddresses(to)} | mine
        for item in [*original.to, *original.cc]:
            for name, address in email.utils.getaddresses([item]):
                if address and address.lower() not in seen:
                    seen.add(address.lower())
                    cc.append(email.utils.formataddr((name, address)))
    return to, cc


def save_draft(imap: Imap, msg: EmailMessage) -> str:
    folder = imap.special("drafts") or "Drafts"
    imap.append(folder, msg.as_bytes(), "\\Draft")
    return folder


def keep_sent_copy(imap: Imap, msg: EmailMessage) -> None:
    """A copy of what was sent in the Sent folder, for the servers that don't make one."""
    folder = imap.special("sent")
    if folder:
        imap.append(folder, msg.as_bytes(), "\\Seen")


# ── who the owner writes to ──


class AddressBook:
    """People the owner has mail with, learned from what they read and send: {address: name,
    count}. Local, a JSON file, no contacts app needed."""

    LIMIT = 1500

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict[str, Any]]:
        from . import jsonstore

        data, _how = jsonstore.read_json(self.path, dict)
        return data if isinstance(data, dict) else {}

    def remember(self, pairs: list[tuple[str, str]]) -> None:
        pairs = [(n.strip(), a.strip().lower()) for n, a in pairs if is_address(a)]
        if not pairs:
            return
        from . import jsonstore

        with self._lock:
            book = self._read()
            for name, address in pairs:
                entry = book.setdefault(address, {"name": "", "count": 0})
                if name and name.lower() != address:
                    entry["name"] = name
                entry["count"] = int(entry.get("count", 0)) + 1
                entry["at"] = time.time()
            if len(book) > self.LIMIT:
                keep = sorted(book.items(), key=lambda kv: kv[1].get("at", 0), reverse=True)[
                    : self.LIMIT
                ]
                book = dict(keep)
            jsonstore.save_json(self.path, book)

    def find(self, query: str) -> list[dict[str, Any]]:
        """People whose name or address matches every word of the query, most-written first:
        [{name, emails: [{label, value}], phones: []}] (the shape Contacts gives)."""
        words = [w for w in re.split(r"\s+", query.lower().strip()) if w]
        if not words:
            return []
        hits = []
        for address, entry in self._read().items():
            hay = f"{entry.get('name', '')} {address}".lower()
            if all(w in hay for w in words):
                hits.append((int(entry.get("count", 0)), address, entry.get("name", "")))
        hits.sort(reverse=True)
        return [
            {"name": name or address, "emails": [{"label": "", "value": address}], "phones": []}
            for _c, address, name in hits[:8]
        ]


def ids_in(values: Any) -> list[str]:
    if isinstance(values, str):
        values = [values]
    return [str(v).strip() for v in (values or []) if str(v).strip()][:MAX_ADDRESSES]
