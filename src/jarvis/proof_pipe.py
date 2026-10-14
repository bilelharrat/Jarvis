"""The app's own line to the backend it started, for Touch ID's proofs (audit S30, round 1 A1).

The Touch ID proof (features/code_touchid.py check_proof) used to be signed under the launch
token, and the page has that token (its URL, backend.json): a script in the window could sign
its own "yes". Now the key is one only the app's main process and this backend know. The app
(app/main.js startBackend, app/proof-pipe.js) starts the backend with JARVIS_PROOF_PIPE=1 and
its stdin a pipe, and writes one line on it at once: "<key> <tag>", both fresh random hex for
this backend. The key is never in the environment, a URL, a file or the log, so nothing the
backend starts, and nothing that reads the backend's files, can learn it: take() moves the pipe
off fd 0 at once (to a descriptor children don't inherit; fd 0 becomes /dev/null) before
anything else is started.

The pipe stays open, for the window of the other app on this backend (backend-share.js: a
second app that shares a backend didn't start it, so it has no key). That window asks the
backend (code_touchid_ask), the backend asks its own app on stdout in a line that starts with
the tag ("<tag> ask <kind> <lang>"), that app shows its own Touch ID sheet (or its own dialog)
and answers on the pipe: "proof <kind> <proof>" (made with makeProof under the key) or
"no <kind>". The tag only keeps stray output (a child that inherited stdout) from being read
as an ask; an ask can only ever bring up the owner's own sheet.

Round 2 (R2-16): the asks went out on stdout, which the app also writes to backend.log, so the
tag was in the log. With JARVIS_PROOF_PIPE=3 the app gives the backend a pipe of its own on fd
3 for them (the Mac's app: app/proof-pipe.js STDIO), taken off fd 3 at once as stdin's is; the
log never sees an ask. "1" (the asks on stdout) stays for an app that can't give fd 3 (Windows).

A backend run by hand (no JARVIS_PROOF_PIPE) has no key: no proof holds, so from its window
Bypass and risky steps stay as they were while Touch ID is on (the gate says what's needed).
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import stat
import sys
import threading
from collections.abc import Callable
from typing import Any

log = logging.getLogger("jarvis")

ENV = "JARVIS_PROOF_PIPE"
ASKS_FD = 3  # with ENV "3": the asks go to the app on this pipe, not stdout (R2-16)
FIRST_LINE_S = 10.0  # the app writes its line as it starts the backend
_HELLO = re.compile(r"^([0-9a-f]{64}) ([0-9a-f]{32})$")
_KIND = re.compile(r"^[a-z-]{1,32}$")


class Pipe:
    """The key and tag the app gave, the pipe's further lines, and a way to ask the app."""

    def __init__(
        self, key: str, tag: str, lines: Any = None, write: Callable[[bytes], Any] | None = None
    ) -> None:
        self.key = key
        self.tag = tag
        self._lines = lines  # the rest of the pipe (a binary file), read by listen()
        self._write = write or (lambda data: os.write(sys.__stdout__.fileno(), data))
        self._listening = False

    def ask(self, kind: str, language: str) -> bool:
        """Asks the app that started this backend for the owner's yes to kind. False when
        it can't be asked (the kind isn't one, stdout is gone)."""
        if not _KIND.match(str(kind)):
            return False
        words = "zh" if language == "zh" else "en"
        try:
            self._write(f"{self.tag} ask {kind} {words}\n".encode())  # one write: one line
        except (OSError, ValueError, AttributeError):
            return False
        return True

    def listen(self, on_line: Callable[[str], Any]) -> None:
        """Passes each further line from the app to on_line (on a thread of its own), once."""
        if self._listening or self._lines is None:
            return
        self._listening = True

        def read() -> None:
            with contextlib.suppress(OSError, ValueError):
                for raw in self._lines:
                    line = raw.decode("utf-8", "replace").strip()
                    if line and len(line) < 400:
                        on_line(line)

        threading.Thread(target=read, name="proof-pipe", daemon=True).start()


def parse_answer(line: str) -> tuple[str, str] | None:
    """(kind, proof) for "proof <kind> <proof>", (kind, "") for "no <kind>", else None."""
    parts = str(line).split(" ")
    if len(parts) == 3 and parts[0] == "proof" and _KIND.match(parts[1]):
        return parts[1], parts[2]
    if len(parts) == 2 and parts[0] == "no" and _KIND.match(parts[1]):
        return parts[1], ""
    return None


def take(environ: Any = None, stdin_fd: int = 0, asks_fd: int = ASKS_FD) -> Pipe | None:
    """The app's pipe, taken off stdin_fd before anything is started (and, with ENV "3", the
    asks' own pipe off asks_fd); None without one."""
    environ = os.environ if environ is None else environ
    how = str(environ.pop(ENV, "") or "")
    if how not in ("1", "3"):
        return None
    write = None
    if how == "3":
        try:
            if not stat.S_ISFIFO(os.fstat(asks_fd).st_mode):
                raise OSError("fd 3 isn't the app's pipe")  # (never write asks to a file)
            out = os.dup(asks_fd)  # (not inherited, as stdin's)
            os.close(asks_fd)
        except OSError:
            log.warning("Touch ID: the app's ask pipe couldn't be taken; no asks this run")
            out = -1

        def write(data: bytes) -> None:
            if out < 0:
                raise OSError("no ask pipe")
            os.write(out, data)

    try:
        fd = os.dup(stdin_fd)  # (not inherited: os.dup's are never)
        nul = os.open(os.devnull, os.O_RDONLY)
        os.dup2(nul, stdin_fd)
        os.close(nul)
    except OSError:
        log.warning("Touch ID: the app's pipe couldn't be taken; no proofs this run")
        return None
    lines = os.fdopen(fd, "rb", buffering=0)
    first: list[bytes] = []
    reader = threading.Thread(target=lambda: first.append(lines.readline()), daemon=True)
    reader.start()
    reader.join(FIRST_LINE_S)
    m = _HELLO.match(first[0].decode("ascii", "replace").strip()) if first else None
    if m is None:
        log.warning("Touch ID: the app's pipe said nothing usable; no proofs this run")
        return None
    return Pipe(m.group(1), m.group(2), lines, write)
