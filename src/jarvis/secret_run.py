"""Runs one Eden Code command with the owner's secrets in its environment, and scrubs them
from what it prints (features/code_secrets.py puts this in front of a session's commands).

    python -I secret_run.py <pipe> -- <shell> -c <command>

The values come from the backend, never from the Keychain: once the owner has let the
command go, the backend reads them and offers them through a named pipe made for this one
command (key_proxy.Handoffs), named by a random nonce in a folder only the owner can open.
This reads it (the first reader gets the values; the name is gone as soon as it's opened)
and gives the command each value as the environment variable NAME. Run again with a pipe
already read, or a name guessed, it gets nothing: it holds no way to ask for a secret.

Everything the command writes, on stdout and stderr, comes back with each value replaced
by $NAME, and so are the shapes a value is easily turned into (base64, hex, URL-encoding,
reversed, and any run of 8 or more of its characters, of those shapes too), so neither the
session's transcript nor the model sees one by way of `base64`, `rev`, `cut` or `curl -v`.
Its exit status is the command's.

Run with JARVIS's own Python in isolated mode (-I: no PYTHON* variables, no project folder on
the import path). It imports only the standard library, and never prints a value, nor writes
one anywhere: not to a file, not to the command line, not to a log.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections.abc import Callable
from typing import BinaryIO

Fetch = Callable[[str], "dict | None"]  # the pipe's path -> {"values": {…}, "missing": […]}
CHUNK = 4096
FETCH_SECONDS = 30  # how long the backend may take to offer the values
FRAGMENT = 8  # a run of this many of a value's characters (or a shape's) counts as it
HELD_MAX = 1 << 20  # bytes held back at most, waiting to see whether a match goes on


def read_pipe(path: str) -> dict | None:
    """The values offered on this pipe, or None (gone, already read, not one at all)."""
    import json
    import signal
    import stat

    try:
        if not stat.S_ISFIFO(os.stat(path).st_mode):
            return None
    except OSError:
        return None

    def late(_signum: int, _frame: object) -> None:
        raise TimeoutError

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, late)
        signal.alarm(FETCH_SECONDS)
    try:
        with open(path, "rb") as pipe:  # (waits for the backend to open its end)
            data = pipe.read(4_000_000)
    except (OSError, TimeoutError):
        return None
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
    try:
        offered = json.loads(data)
    except ValueError:
        return None
    return offered if isinstance(offered, dict) else None


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
    """(the pipe's path, the command's argv) from this program's arguments."""
    if "--" not in argv or len(argv) < 3:
        raise ValueError("usage: secret_run.py PIPE -- SHELL -c COMMAND")
    cut = argv.index("--")
    if cut != 1:
        raise ValueError("usage: secret_run.py PIPE -- SHELL -c COMMAND")
    pipe, command = argv[0], argv[cut + 1 :]
    if not pipe or not command:
        raise ValueError("no command")
    return pipe, command


def _pump(source: BinaryIO, sink: BinaryIO, scrubber: Scrubber) -> None:
    try:
        while True:
            chunk = os.read(source.fileno(), CHUNK)
            if not chunk:
                break
            out = scrubber.feed(chunk)
            if out:
                sink.write(out)
                sink.flush()
        sink.write(scrubber.end())
        sink.flush()
    except (OSError, ValueError):
        pass


def run(
    argv: list[str],
    fetch: Fetch = read_pipe,
    stdout: BinaryIO | None = None,
    stderr: BinaryIO | None = None,
) -> int:
    out = stdout or sys.stdout.buffer
    err = stderr or sys.stderr.buffer
    try:
        pipe, command = parse(argv)
    except ValueError as exc:
        err.write(f"Jarvis couldn't run the command: {exc}\n".encode())
        return 2
    offered = fetch(pipe)
    given = offered.get("values") if isinstance(offered, dict) else None
    if not isinstance(given, dict):
        err.write(
            b"Jarvis couldn't hand this command its secrets (each is given once, to the command "
            b"the owner let go); it didn't run.\n"
        )
        return 2
    env = dict(os.environ)
    values: dict[str, str] = {}
    for name, value in given.items():
        if not (isinstance(name, str) and name.isidentifier() and isinstance(value, str) and value):
            continue
        env[name] = value
        values[value] = f"${name}"
    for name in offered.get("missing") or []:
        if isinstance(name, str) and name.isidentifier():
            err.write(
                f"(Jarvis: no value is saved for ${name} any more; it's empty here.)\n".encode()
            )
            env.pop(name, None)
    try:
        proc = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        err.write(f"Jarvis couldn't start the command: {exc.strerror}\n".encode())
        return 127
    assert proc.stdout is not None and proc.stderr is not None
    pumps = [
        threading.Thread(target=_pump, args=(proc.stdout, out, Scrubber(values)), daemon=True),
        threading.Thread(target=_pump, args=(proc.stderr, err, Scrubber(values)), daemon=True),
    ]
    for pump in pumps:
        pump.start()
    try:
        code = proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        code = proc.wait()
    for pump in pumps:
        pump.join()
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
