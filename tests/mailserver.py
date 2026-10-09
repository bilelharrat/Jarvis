"""A small IMAP and SMTP server for tests: real sockets on 127.0.0.1, so the mail code is
exercised over the wire (imaplib and smtplib speaking to it), not against mocks.

It keeps mailboxes in memory and speaks the part of IMAP4rev1 the app uses: LOGIN, LIST,
SELECT/EXAMINE, STATUS, UID SEARCH / FETCH / STORE / COPY, EXPUNGE, APPEND and LOGOUT. SMTP is
EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA and QUIT. There is no TLS: the app only allows that
for the loopback address, which is where this listens.
"""

from __future__ import annotations

import base64
import re
import socketserver
import threading
import time
from email import message_from_bytes, policy
from email.utils import parsedate_to_datetime

CRLF = b"\r\n"


def make_raw(
    sender: str,
    to: str,
    subject: str,
    body: str,
    *,
    date: str = "Thu, 08 Oct 2026 15:05:00 +0000",
    message_id: str = "",
    extra: str = "",
    html: str = "",
) -> bytes:
    headers = [
        f"From: {sender}", f"To: {to}", f"Subject: {subject}", f"Date: {date}",
        f"Message-ID: {message_id or '<' + subject.replace(' ', '') + '@test>'}",
    ]  # fmt: skip
    if extra:
        headers.append(extra)
    if html:
        headers += ["MIME-Version: 1.0", 'Content-Type: multipart/alternative; boundary="b1"']
        text = f"--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n{html}\r\n--b1--\r\n"
    else:
        headers += ["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"]
        text = body
    return ("\r\n".join(headers) + "\r\n\r\n" + text).encode("utf-8")


class Mailstore:
    """Users and their folders."""

    def __init__(self) -> None:
        self.users = {"ann@test.example": "app-password"}
        self.folders: dict[str, list[dict]] = {
            "INBOX": [],
            "Sent": [],
            "Drafts": [],
            "Archive": [],
            "Trash": [],
        }
        self.roles = {
            "Sent": "\\Sent",
            "Drafts": "\\Drafts",
            "Archive": "\\Archive",
            "Trash": "\\Trash",
        }
        self.next_uid = 100
        self.sent: list[tuple[str, list[str], bytes]] = []  # what SMTP took
        self.lock = threading.Lock()
        self.gmail_queries: list[str] = []
        self.logins: list[str] = []

    def add(self, folder: str, raw: bytes, flags: tuple[str, ...] = ()) -> int:
        with self.lock:
            self.next_uid += 1
            self.folders.setdefault(folder, []).append(
                {"uid": self.next_uid, "flags": set(flags), "raw": raw}
            )
            return self.next_uid

    def message(self, folder: str, uid: int) -> dict | None:
        return next((m for m in self.folders.get(folder, []) if m["uid"] == uid), None)


class _Imap(socketserver.StreamRequestHandler):
    store: Mailstore

    def send(self, line: str | bytes) -> None:
        self.wfile.write((line.encode() if isinstance(line, str) else line) + CRLF)
        self.wfile.flush()

    def handle(self) -> None:
        self.store = self.server.store  # type: ignore[attr-defined]
        self.user = ""
        self.selected = ""
        self.send("* OK [CAPABILITY IMAP4rev1] test server ready")
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.rstrip(b"\r\n").decode("utf-8", errors="replace")
            if not line:
                continue
            tag, _, rest = line.partition(" ")
            command, _, args = rest.partition(" ")
            command = command.upper()
            try:
                if command == "LOGOUT":
                    self.send("* BYE bye")
                    self.send(f"{tag} OK done")
                    return
                getattr(self, f"do_{command.lower()}", self.do_unknown)(tag, args)
            except Exception as exc:  # noqa: BLE001 - a bug in the test server shows as BAD
                self.send(f"{tag} BAD {type(exc).__name__}: {exc}")

    # ── helpers ──

    @staticmethod
    def words(args: str) -> list[str]:
        """Quoted strings and bare words."""
        out = []
        for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|(\([^)]*\))|(\S+)', args):
            if m.group(1) is not None:
                out.append(re.sub(r"\\(.)", r"\1", m.group(1)))
            else:
                out.append(m.group(2) or m.group(3))
        return out

    def folder_of(self, name: str) -> str:
        return name

    def seq_of(self, uid: int) -> int:
        return next(
            i + 1 for i, m in enumerate(self.store.folders[self.selected]) if m["uid"] == uid
        )

    # ── commands ──

    def do_unknown(self, tag: str, _args: str) -> None:
        self.send(f"{tag} BAD unknown command")

    def do_capability(self, tag: str, _args: str) -> None:
        self.send("* CAPABILITY IMAP4rev1")
        self.send(f"{tag} OK done")

    def do_noop(self, tag: str, _args: str) -> None:
        self.send(f"{tag} OK done")

    def do_login(self, tag: str, args: str) -> None:
        user, password = self.words(args)[:2]
        self.store.logins.append(user)
        if self.store.users.get(user) == password:
            self.user = user
            self.send(f"{tag} OK LOGIN completed")
        else:
            self.send(f"{tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)")

    def do_list(self, tag: str, _args: str) -> None:
        for name in self.store.folders:
            flags = ["\\HasNoChildren"] + (
                [self.store.roles[name]] if name in self.store.roles else []
            )
            self.send(f'* LIST ({" ".join(flags)}) "/" "{name}"')
        self.send(f"{tag} OK LIST completed")

    def _select(self, tag: str, args: str, mode: str) -> None:
        name = self.words(args)[0]
        if name not in self.store.folders:
            self.send(f"{tag} NO no such folder")
            return
        self.selected = name
        self.send(f"* {len(self.store.folders[name])} EXISTS")
        self.send("* 0 RECENT")
        self.send("* OK [UIDVALIDITY 1] ok")
        self.send(f"{tag} OK [{mode}] SELECT completed")

    def do_select(self, tag: str, args: str) -> None:
        self._select(tag, args, "READ-WRITE")

    def do_examine(self, tag: str, args: str) -> None:
        self._select(tag, args, "READ-ONLY")

    def do_status(self, tag: str, args: str) -> None:
        name = self.words(args)[0]
        unseen = sum(1 for m in self.store.folders.get(name, []) if "\\Seen" not in m["flags"])
        self.send(f'* STATUS "{name}" (UNSEEN {unseen})')
        self.send(f"{tag} OK STATUS completed")

    def do_uid(self, tag: str, args: str) -> None:
        sub, _, rest = args.partition(" ")
        {
            "SEARCH": self.uid_search,
            "FETCH": self.uid_fetch,
            "STORE": self.uid_store,
            "COPY": self.uid_copy,
        }[sub.upper()](tag, rest)

    def uid_search(self, tag: str, args: str) -> None:
        words = self.words(args)
        if words[:2] and words[0].upper() == "CHARSET":
            words = words[2:]
        want = list(self.store.folders[self.selected])
        i = 0
        while i < len(words):
            key = words[i].upper()
            if key == "ALL":
                i += 1
            elif key == "UNSEEN":
                want = [m for m in want if "\\Seen" not in m["flags"]]
                i += 1
            elif key in ("FROM", "TO", "SUBJECT", "TEXT"):
                needle = words[i + 1].lower()
                header = {"FROM": "from", "TO": "to", "SUBJECT": "subject"}.get(key)
                want = [m for m in want if self._has(m, header, needle)]
                i += 2
            elif key == "SINCE":
                i += 2
            elif (
                key == "UID"
            ):  # (a set such as 101:*; like a real server, "n:*" always gives the last one)
                chosen = set(self._uids(words[i + 1]))
                last = want[-1:] if want else []
                want = [m for m in want if m["uid"] in chosen] or last
                i += 2
            elif key == "X-GM-RAW":
                self.store.gmail_queries.append(words[i + 1])
                for term in re.findall(r'(\w+):("[^"]*"|\S+)', words[i + 1]):
                    field, value = term[0], term[1].strip('"').lower()
                    if field in ("from", "to", "subject"):
                        want = [m for m in want if self._has(m, field, value)]
                    elif field == "is" and value == "unread":
                        want = [m for m in want if "\\Seen" not in m["flags"]]
                i += 2
            else:
                i += 1
        self.send("* SEARCH " + " ".join(str(m["uid"]) for m in want))
        self.send(f"{tag} OK SEARCH completed")

    @staticmethod
    def _has(message: dict, header: str | None, needle: str) -> bool:
        parsed = message_from_bytes(message["raw"], policy=policy.default)
        if header:
            return needle in str(parsed.get(header, "")).lower()
        return needle in message["raw"].decode("utf-8", errors="replace").lower()

    def _uids(self, spec: str) -> list[int]:
        out = []
        for part in spec.split(","):
            if ":" in part:
                a, b = part.split(":")
                lo, hi = int(a), int(b) if b != "*" else 10**9
                out += [m["uid"] for m in self.store.folders[self.selected] if lo <= m["uid"] <= hi]
            else:
                out.append(int(part))
        return out

    def uid_fetch(self, tag: str, args: str) -> None:
        spec, _, items = args.partition(" ")
        for uid in self._uids(spec):
            m = self.store.message(self.selected, uid)
            if m is None:
                continue
            flags = " ".join(sorted(m["flags"]))
            wanted = re.search(r"HEADER\.FIELDS \(([^)]*)\)", items)
            if wanted:
                names = {n.lower() for n in wanted.group(1).split()}
                head = m["raw"].split(b"\r\n\r\n", 1)[0].decode("utf-8", errors="replace")
                kept = [
                    line for line in head.split("\r\n") if line.split(":", 1)[0].lower() in names
                ]
                payload = ("\r\n".join(kept) + "\r\n\r\n").encode()
                label = f"BODY[HEADER.FIELDS ({wanted.group(1)})]"
            else:
                payload = m["raw"]
                label = "BODY[]"
            if "\\Seen" not in m["flags"] and "PEEK" not in items.upper() and not wanted:
                m["flags"].add("\\Seen")
            self.wfile.write(
                f"* {self.seq_of(uid)} FETCH (UID {uid} FLAGS ({flags}) {label} {{{len(payload)}}}".encode()
                + CRLF
                + payload
                + b")"
                + CRLF
            )
        self.wfile.flush()
        self.send(f"{tag} OK FETCH completed")

    def uid_store(self, tag: str, args: str) -> None:
        spec, op, flags = self.words(args)[:3]
        names = set(flags.strip("()").split())
        for uid in self._uids(spec):
            m = self.store.message(self.selected, uid)
            if m is None:
                continue
            if op.upper().startswith("+"):
                m["flags"] |= names
            elif op.upper().startswith("-"):
                m["flags"] -= names
            else:
                m["flags"] = names
            self.send(
                f"* {self.seq_of(uid)} FETCH (UID {uid} FLAGS ({' '.join(sorted(m['flags']))}))"
            )
        self.send(f"{tag} OK STORE completed")

    def uid_copy(self, tag: str, args: str) -> None:
        words = self.words(args)
        spec, target = words[0], words[1]
        if target not in self.store.folders:
            self.send(f"{tag} NO [TRYCREATE] no such folder")
            return
        for uid in self._uids(spec):
            m = self.store.message(self.selected, uid)
            if m is not None:
                self.store.add(target, m["raw"], tuple(m["flags"] - {"\\Deleted"}))
        self.send(f"{tag} OK COPY completed")

    def do_expunge(self, tag: str, _args: str) -> None:
        box = self.store.folders[self.selected]
        box[:] = [m for m in box if "\\Deleted" not in m["flags"]]
        self.send(f"{tag} OK EXPUNGE completed")

    def do_append(self, tag: str, args: str) -> None:
        size = int(re.search(r"\{(\d+)\}\s*$", args).group(1))  # type: ignore[union-attr]
        words = self.words(re.sub(r"\{\d+\}\s*$", "", args))
        folder = words[0]
        flags = tuple(f for w in words[1:] if w.startswith("(") for f in w.strip("()").split())
        self.send("+ go ahead")
        raw = self.rfile.read(size)
        self.rfile.readline()  # the line's end
        if folder not in self.store.folders:
            self.send(f"{tag} NO [TRYCREATE] no such folder")
            return
        self.store.add(folder, raw, flags)
        self.send(f"{tag} OK APPEND completed")


class _Smtp(socketserver.StreamRequestHandler):
    def send(self, line: str) -> None:
        self.wfile.write(line.encode() + CRLF)
        self.wfile.flush()

    def handle(self) -> None:
        store: Mailstore = self.server.store  # type: ignore[attr-defined]
        self.send("220 test smtp ready")
        sender, rcpts, authed = "", [], False
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.rstrip(b"\r\n").decode("utf-8", errors="replace")
            word = line.split(" ", 1)[0].upper()
            if word in ("EHLO", "HELO"):
                self.send("250-localhost")
                self.send("250-AUTH PLAIN LOGIN")
                self.send("250 8BITMIME")
            elif word == "AUTH":
                parts = line.split()
                if parts[1].upper() == "PLAIN":
                    token = parts[2] if len(parts) > 2 else self._ask("")
                    _, user, password = base64.b64decode(token).decode().split("\0")
                else:
                    user = base64.b64decode(self._ask("VXNlcm5hbWU6")).decode()
                    password = base64.b64decode(self._ask("UGFzc3dvcmQ6")).decode()
                if store.users.get(user) == password:
                    authed = True
                    self.send("235 2.7.0 Authentication successful")
                else:
                    self.send("535 5.7.8 Authentication credentials invalid")
            elif word == "MAIL":
                if not authed:
                    self.send("530 5.7.0 Authentication required")
                    continue
                sender = re.search(r"<([^>]*)>", line).group(1)  # type: ignore[union-attr]
                rcpts = []
                self.send("250 ok")
            elif word == "RCPT":
                address = re.search(r"<([^>]*)>", line).group(1)  # type: ignore[union-attr]
                if address.endswith("@refused.example"):
                    self.send("550 5.1.1 no such user")
                else:
                    rcpts.append(address)
                    self.send("250 ok")
            elif word == "DATA":
                self.send("354 go ahead")
                data = bytearray()
                while True:
                    chunk = self.rfile.readline()
                    if chunk in (b".\r\n", b""):
                        break
                    data += chunk[1:] if chunk.startswith(b"..") else chunk
                with store.lock:
                    store.sent.append((sender, list(rcpts), bytes(data)))
                self.send("250 2.0.0 queued")
            elif word == "RSET" or word == "NOOP":
                self.send("250 ok")
            elif word == "QUIT":
                self.send("221 bye")
                return
            else:
                self.send("502 not implemented")

    def _ask(self, prompt: str) -> str:
        self.send(f"334 {prompt}")
        return self.rfile.readline().rstrip(b"\r\n").decode()


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TestMail:
    """A running pair of servers over one Mailstore."""

    __test__ = False  # (not a pytest class)

    def __init__(self) -> None:
        self.store = Mailstore()
        self.imap = _Server(("127.0.0.1", 0), _Imap)
        self.smtp = _Server(("127.0.0.1", 0), _Smtp)
        for server in (self.imap, self.smtp):
            server.store = self.store  # type: ignore[attr-defined]
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @property
    def imap_port(self) -> int:
        return self.imap.server_address[1]

    @property
    def smtp_port(self) -> int:
        return self.smtp.server_address[1]

    def close(self) -> None:
        for server in (self.imap, self.smtp):
            server.shutdown()
            server.server_close()


def when(days_ago: float) -> str:
    """An RFC 2822 date this long ago."""
    from email.utils import formatdate

    return formatdate(time.time() - days_ago * 86400, localtime=False)


__all__ = ["TestMail", "make_raw", "when", "parsedate_to_datetime"]
