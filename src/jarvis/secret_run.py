"""Runs one Eden Code command with the owner's secrets in its environment, for the owner's
eyes (features/code_secrets.py puts this in front of a session's commands).

    python -I secret_run.py <socket> -- <shell> -c <command>

This program never holds a value. Once the owner has let the command go, the backend makes
a socket for that one run (key_proxy.Handoffs), named by a random nonce in a folder only the
owner can open. This connects to it and says "go", nothing more; the backend then starts the
command itself, the exact one on the owner's card (what follows -- here is only for the line
to say what it runs), with the values in its environment, in the session's project folder
with the session's own environment (the owner's login shell's, and the session's own
settings: never anything this program or whoever connects says, S3-1), and sends back how it
went and its exit status. So whoever reaches the socket first, this program or another of
the session's processes made to look just like it, gets only what this would have had. The
values themselves never travel through anything a session's process can open. Run again
with a socket already used, or a name guessed, it gets nothing: the command runs once.

What the command prints, on stdout and stderr, goes to the owner only: the backend scrubs it
(each value replaced by $NAME, and so are the shapes a value is easily turned into: base64,
hex, URL-encoding, reversed, and any run of 8 or more of its characters, of those shapes too)
and puts it in the session's transcript for the owner, never in what Claude reads. Claude's
tool output is one line (owner_only): that the output went to the owner, how long it was,
and the exit status, which is the command's too. (Round 3, S3-2: until then the scrubbed
output was Claude's, and scrubbing is only ever a best effort: `fold -w4`, `od -c`, `sed
's/./& /g'` or a slice walk a value past any list of shapes.)

What would run code of its own before or instead of the command is taken out of its
environment (clean_env): a shell's startup files and settings (BASH_ENV, ENV, ZDOTDIR,
SHELLOPTS, BASHOPTS, PROMPT_COMMAND, PS4), bash's exported functions (BASH_FUNC_*), and what
loads code into a program (DYLD_*, LD_*). The shell itself runs with no startup files (wrap's
`bash --norc --noprofile` or `zsh -f`). The rest is the owner's own, as a terminal of theirs
has it: their PATH and their dotfiles (~/.gitconfig, ~/.npmrc) are what the command uses, as
the owner's card says.

Run with JARVIS's own Python in isolated mode (-I: no PYTHON* variables, no project folder on
the import path). It imports only the standard library.
"""

from __future__ import annotations

import socket
import struct
import sys
from typing import BinaryIO

CHUNK = 4096
CONNECT_SECONDS = 30  # how long the backend may take to answer the run's socket
GO = b"go\n"  # all this program says to the backend (S3-1)
OWNER_KEEP = 8000  # characters of a command's output kept for the owner's transcript (its end)
# One frame of what the backend sends back: its kind, the length of what follows, that.
FRAME = struct.Struct(">cI")
OUT, ERR, EXIT = b"o", b"e", b"x"
FRAGMENT = 8  # a run of this many of a value's characters (or a shape's) counts as it
HELD_MAX = 1 << 20  # bytes held back at most, waiting to see whether a match goes on
# What runs code of its own in the command's shell, or loads it into a program (see above).
STARTUP = ("BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "PS4")
STARTUP_PREFIXES = ("BASH_FUNC_", "DYLD_", "LD_")


def clean_env(environ: dict[str, str], path: object = None) -> dict[str, str]:
    """The command's environment: this one without what runs or loads code of its own, and
    with the backend's PATH when it sent one."""
    env = {
        k: v for k, v in environ.items() if k not in STARTUP and not k.startswith(STARTUP_PREFIXES)
    }
    if isinstance(path, str) and path:
        env["PATH"] = path
    return env


def shapes(value: str) -> list[bytes]:
    """The value and what it's easily turned into: base64 (standard and URL-safe, padded or
    not, and at each of the three places a value can start in a longer text being encoded,
    as `user:pass` is in a Basic header), hex (lower and upper case), URL-encoded, and
    reversed."""
    import base64
    import binascii
    from urllib.parse import quote, quote_plus

    raw = value.encode()
    out = {raw, raw[::-1], quote(value, safe="").encode(), quote_plus(value).encode()}
    hexed = binascii.hexlify(raw)
    out |= {hexed, hexed.upper()}
    for lead in range(3):
        for encode in (base64.b64encode, base64.urlsafe_b64encode):
            coded = encode(b"\0" * lead + raw)
            if lead:  # the groups that hold the padding or what comes after are not the value's
                coded = coded[4:]
                coded = coded[: len(coded) - 4] if len(coded) > 4 else b""
            out |= {coded, coded.rstrip(b"=")}
    return [shape for shape in out if len(shape) >= 4]


class Scrubber:
    """Bytes in, the same bytes out with every value (in any of its shapes, or a long enough
    run of one) replaced by its placeholder. What might still be the start of a match is
    held back until more comes (a value split between two reads is still caught), and given
    back at the end."""

    def __init__(self, values: dict[str, str]) -> None:
        pairs: dict[bytes, bytes] = {}
        grams: dict[bytes, bytes] = {}
        for value, placeholder in values.items():
            if not value:
                continue
            for shape in shapes(value):
                pairs.setdefault(shape, placeholder.encode())
                for at in range(len(shape) - FRAGMENT + 1):
                    grams.setdefault(shape[at : at + FRAGMENT], placeholder.encode())
        self.pairs = sorted(pairs.items(), key=lambda vp: len(vp[0]), reverse=True)
        self.grams = grams
        self.keep = max((len(v) for v, _ in self.pairs), default=1) - 1
        self.held = b""

    def _found(self, data: bytes) -> list[tuple[int, int, bytes]]:
        """(start, end, placeholder) of every match, overlapping ones joined."""
        spans: list[tuple[int, int, bytes]] = []
        for shape, placeholder in self.pairs:
            at = data.find(shape)
            while at >= 0:
                spans.append((at, at + len(shape), placeholder))
                at = data.find(shape, at + 1)
        if self.grams and len(data) >= FRAGMENT:
            grams = self.grams
            for at in range(len(data) - FRAGMENT + 1):
                placeholder = grams.get(data[at : at + FRAGMENT])
                if placeholder is not None:
                    spans.append((at, at + FRAGMENT, placeholder))
        spans.sort()
        joined: list[tuple[int, int, bytes]] = []
        for start, end, placeholder in spans:
            if joined and start <= joined[-1][1]:
                last = joined[-1]
                joined[-1] = (last[0], max(last[1], end), last[2])
            else:
                joined.append((start, end, placeholder))
        return joined

    @staticmethod
    def _replaced(data: bytes, spans: list[tuple[int, int, bytes]]) -> bytes:
        out, at = [], 0
        for start, end, placeholder in spans:
            out += [data[at:start], placeholder]
            at = end
        out.append(data[at:])
        return b"".join(out)

    def feed(self, data: bytes) -> bytes:
        data = self.held + data
        if not self.pairs:
            self.held = b""
            return data
        spans = self._found(data)
        # Hold back the tail a value might still be starting in, and any match that reaches
        # it (it may go on in what comes next), unless that's grown past reason.
        cut = max(len(data) - self.keep, 0)
        for start, end, _placeholder in spans:
            if end > cut and start < cut or end >= len(data):
                cut = min(cut, start)
        if len(data) - cut > HELD_MAX:
            cut = len(data) - self.keep
        self.held = data[cut:]
        return self._replaced(data[:cut], [s for s in spans if s[1] <= cut])

    def end(self) -> bytes:
        rest, self.held = self.held, b""
        return self._replaced(rest, self._found(rest)) if self.pairs else rest


def scrub(values: dict[str, str], text: str) -> str:
    """A whole text, scrubbed as a command's output is (for what a session records)."""
    scrubber = Scrubber(values)
    data = text.encode("utf-8", "surrogatepass")
    return (scrubber.feed(data) + scrubber.end()).decode("utf-8", "replace")


def parse(argv: list[str]) -> tuple[str, list[str]]:
    """(the run's socket, the command's argv) from this program's arguments."""
    if "--" not in argv or len(argv) < 3:
        raise ValueError("usage: secret_run.py SOCKET -- SHELL -c COMMAND")
    cut = argv.index("--")
    if cut != 1:
        raise ValueError("usage: secret_run.py SOCKET -- SHELL -c COMMAND")
    pipe, command = argv[0], argv[cut + 1 :]
    if not pipe or not command:
        raise ValueError("no command")
    return pipe, command


def frame(kind: bytes, data: bytes) -> bytes:
    return FRAME.pack(kind, len(data)) + data


def request() -> bytes:
    """What this program tells the backend: "go". Where the command runs and with what
    environment are the session's, which the backend has (S3-1)."""
    return GO


class OwnerOutput:
    """What a secret command printed (both streams, as they came), already scrubbed, for the
    owner: its end kept (OWNER_KEEP characters' worth), and how much there was in all."""

    def __init__(self) -> None:
        import threading

        self._lock = threading.Lock()
        self._kept = b""
        self.size = 0
        self.lines = 0

    def add(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self.size += len(data)
            self.lines += data.count(b"\n")
            self._kept = (self._kept + data)[-OWNER_KEEP * 4 :]

    def text(self) -> str:
        with self._lock:
            kept, size = self._kept, self.size
        text = kept.decode("utf-8", "replace")[-OWNER_KEEP:]
        if size > len(kept):
            text = "(only its end is kept here)\n" + text
        return text


def owner_only(names: list[str], printed: OwnerOutput, status: int) -> bytes:
    """Claude's whole tool output for a secret command: that what it printed went to the
    owner, how much, and how it ended. Nothing of the output itself (S3-2)."""
    used = ", ".join(names) or "the owner's secret"
    size = (
        "it printed nothing"
        if not printed.size
        else f"it printed {printed.lines or 1} line{'s' if (printed.lines or 1) != 1 else ''}"
        f" ({printed.size} bytes)"
    )
    return (
        f"(This command used {used}, so what it printed went to the owner only, in their "
        f"transcript, not to you: {size}, and it exited with status {status}. If you need "
        "something from it, ask the owner, or run a command that doesn't use the secret.)\n"
    ).encode()


def connect(path: str) -> socket.socket | None:
    """The run's socket, connected; None when it's gone, used already, or not one at all."""
    if not hasattr(socket, "AF_UNIX"):
        return None
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(CONNECT_SECONDS)
    try:
        sock.connect(path)
    except OSError:
        sock.close()
        return None
    return sock


def _exact(sock: socket.socket, size: int) -> bytes | None:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def run(
    argv: list[str],
    connect_to=connect,
    stdout: BinaryIO | None = None,
    stderr: BinaryIO | None = None,
) -> int:
    out = stdout or sys.stdout.buffer
    err = stderr or sys.stderr.buffer
    try:
        path, _command = parse(argv)
    except ValueError as exc:
        err.write(f"Eden couldn't run the command: {exc}\n".encode())
        return 2
    sock = connect_to(path)
    code = None
    if sock is not None:
        try:
            sock.sendall(request())
            sock.settimeout(None)  # (the command takes as long as it takes)
            while True:
                head = _exact(sock, FRAME.size)
                if head is None:
                    break
                kind, size = FRAME.unpack(head)
                data = _exact(sock, size) if size else b""
                if data is None:
                    break
                if kind == EXIT:
                    code = int(data.decode() or "1")
                    break
                sink = out if kind == OUT else err
                sink.write(data)
                sink.flush()
        except (OSError, ValueError):
            pass
        finally:
            sock.close()
    if code is None:
        err.write(
            b"Eden couldn't hand this command its secrets (each is given once, to the command "
            b"the owner let go); it didn't run, or didn't finish.\n"
        )
        return 2
    return code


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
