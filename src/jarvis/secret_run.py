"""Runs one Eden Code command with the owner's secrets in its environment, and scrubs them
from what it prints (features/code_secrets.py puts this in front of a session's commands).

    python -I secret_run.py <keychain service> NAME=account ... -- <shell> -c <command>

Each NAME's value is read from the Keychain entry (service, account) and given to the command
as the environment variable NAME. Everything the command writes, on stdout and stderr, comes
back with each value replaced by $NAME, so neither the session's transcript nor the model ever
sees one. Its exit status is the command's.

Run with JARVIS's own Python in isolated mode (-I: no PYTHON* variables, no project folder on
the import path), the program the Keychain entries trust, so nothing is asked. It imports only
the standard library and keyring's macOS backend, and never prints a value, nor writes one
anywhere: not to a file, not to the command line, not to a log.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections.abc import Callable
from typing import BinaryIO

Reader = Callable[[str, str], "str | None"]
CHUNK = 4096


def read_keychain(service: str, account: str) -> str | None:
    from keyring.backends import macOS

    return macOS.Keyring().get_password(service, account)


class Scrubber:
    """Bytes in, the same bytes out with every value replaced by its placeholder. The last
    few bytes are held back until more come (a value split between two reads is still
    caught), and given back at the end."""

    def __init__(self, values: dict[str, str]) -> None:
        pairs = [(v.encode(), p.encode()) for v, p in values.items() if v]
        self.pairs = sorted(pairs, key=lambda vp: len(vp[0]), reverse=True)
        self.keep = max((len(v) for v, _ in self.pairs), default=1) - 1
        self.held = b""

    def _replace(self, data: bytes) -> bytes:
        for value, placeholder in self.pairs:
            data = data.replace(value, placeholder)
        return data

    def feed(self, data: bytes) -> bytes:
        data = self.held + data
        if not self.pairs:
            self.held = b""
            return data
        # Replace what's whole, then hold back the tail a value might still be starting in.
        data = self._replace(data)
        if self.keep <= 0 or len(data) <= self.keep:
            self.held, out = (data, b"") if self.keep > 0 else (b"", data)
            return out
        self.held = data[-self.keep :]
        return data[: -self.keep]

    def end(self) -> bytes:
        rest, self.held = self._replace(self.held), b""
        return rest


def parse(argv: list[str]) -> tuple[str, dict[str, str], list[str]]:
    """(service, {NAME: account}, the command's argv) from this program's arguments."""
    if "--" not in argv or len(argv) < 3:
        raise ValueError("usage: secret_run.py SERVICE NAME=account ... -- SHELL -c COMMAND")
    cut = argv.index("--")
    service, pairs, command = argv[0], argv[1:cut], argv[cut + 1 :]
    names: dict[str, str] = {}
    for pair in pairs:
        name, sep, account = pair.partition("=")
        if not sep or not name.isidentifier() or not account:
            raise ValueError(f"not NAME=account: {name}")
        names[name] = account
    if not command:
        raise ValueError("no command")
    return service, names, command


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
    read: Reader = read_keychain,
    stdout: BinaryIO | None = None,
    stderr: BinaryIO | None = None,
) -> int:
    out = stdout or sys.stdout.buffer
    err = stderr or sys.stderr.buffer
    try:
        service, names, command = parse(argv)
    except ValueError as exc:
        err.write(f"Jarvis couldn't run the command: {exc}\n".encode())
        return 2
    env = dict(os.environ)
    values: dict[str, str] = {}
    for name, account in names.items():
        try:
            value = read(service, account)
        except Exception:
            value = None
        if not value:
            err.write(
                f"(Jarvis: no value is saved for ${name} any more; it's empty here.)\n".encode()
            )
            env.pop(name, None)
            continue
        env[name] = value
        values[value] = f"${name}"
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
