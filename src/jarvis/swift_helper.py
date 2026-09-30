"""Small Swift helpers for Apple frameworks Python can't reach (NaturalLanguage's language
models, Vision's text recognition): each lives in native/<name>.swift, is built with swiftc
the first time it's needed and cached in Application Support/Jarvis/bin by its source's
hash, as speech.ensure_player builds the voice player. A helper that can't be built (no
swiftc, a compile error) is None, said once in the log; what needs it falls back.

The app people download has no swiftc: it carries every helper prebuilt (app/scripts/dist)
and says where in JARVIS_HELPERS_DIR. prebuilt() is the one lookup all the helpers' builders
ask first (this module, speech, codelook, hands_guard, audio).
"""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
import os
import select
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

NATIVE = Path(__file__).parent / "native"
BUILD_SECONDS = 300
HELPERS_ENV = "JARVIS_HELPERS_DIR"  # the packaged app's prebuilt helpers (app/main.js sets it)

_lock = threading.Lock()
_failed: set[str] = set()  # sources that didn't build this run: not tried again, said once


def prebuilt(name: str, source: Path) -> Path | None:
    """The packaged app's own build of helper `name`: JARVIS_HELPERS_DIR holds `name` and
    `name.sha256`, the SHA-256 of the source it was built from. It's used while that is
    still this source's hash and the file is a program; otherwise None (no folder, no such
    helper, another source, not executable), and the caller builds with swiftc as before.
    Whether it runs on this Mac (one built for a newer macOS doesn't) is for the caller to
    find out: each already treats a helper that fails to run as unavailable."""
    folder = os.environ.get(HELPERS_ENV, "").strip()
    if not folder:
        return None
    binary = Path(folder) / name
    try:
        recorded = (Path(folder) / f"{name}.sha256").read_text("ascii").split()
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
    except (OSError, ValueError):
        return None
    if recorded[:1] != [digest] or not binary.is_file() or not os.access(binary, os.X_OK):
        return None
    return binary


def binary_for(name: str, bin_dir: Path | None = None) -> Path | None:
    """Where helper `name` is (or will be) once built from its source now; None without it."""
    source = NATIVE / f"{name}.swift"
    found = prebuilt(name, source)
    if found is not None:
        return found
    try:
        digest = hashlib.sha256(source.read_bytes()).hexdigest()[:10]
    except OSError:
        return None
    if bin_dir is None:
        from .prefs import APP_SUPPORT

        bin_dir = APP_SUPPORT / "bin"
    return bin_dir / f"{name}-{digest}"


def ensure(name: str, bin_dir: Path | None = None) -> Path | None:
    """Helper `name`, built if it isn't yet (a few seconds with swiftc). Built under a
    temporary name and renamed into place in one step, so a build cut short (the app quit
    mid-swiftc) never leaves a half-written helper that looks done."""
    binary = binary_for(name, bin_dir)
    if binary is None:
        return None
    if binary.exists():
        return binary
    with _lock:
        if binary.exists():
            return binary
        if str(binary) in _failed:
            return None
        binary.parent.mkdir(parents=True, exist_ok=True)
        partial = binary.with_name(f"{binary.name}.{os.getpid()}.{threading.get_ident()}.part")
        try:
            subprocess.run(
                ["swiftc", "-O", "-o", str(partial), str(NATIVE / f"{name}.swift")],
                check=True,
                capture_output=True,
                timeout=BUILD_SECONDS,
            )
            partial.replace(binary)
        except (OSError, subprocess.SubprocessError) as exc:
            _failed.add(str(binary))
            detail = getattr(exc, "stderr", b"") or b""
            log.warning(
                "couldn't build the %s helper (%s) %s",
                name,
                type(exc).__name__,
                detail.decode(errors="replace")[-300:] if isinstance(detail, bytes) else "",
            )
            return None
        finally:
            partial.unlink(missing_ok=True)
    return binary


class LineProcess:
    """A helper kept running that answers JSON lines: each request carries an "id", each
    answer the same id. One caller at a time; a helper that dies or stalls is started
    afresh on the next call."""

    def __init__(self, argv: list[str], timeout: float = 60.0) -> None:
        self.argv = [str(a) for a in argv]
        self.timeout = timeout
        self._proc: subprocess.Popen[bytes] | None = None
        self._buf = b""
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def _start(self) -> subprocess.Popen[bytes]:
        self._buf = b""
        self._proc = subprocess.Popen(  # noqa: S603 - our own helper, built from our source
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return self._proc

    def ask(self, items: list[dict[str, Any]], timeout: float | None = None) -> list[Any]:
        """Each item's answer, in order (None for one that got none)."""
        if not items:
            return []
        deadline = time.monotonic() + (timeout or self.timeout)
        with self._lock:
            proc = self._proc if self._proc and self._proc.poll() is None else self._start()
            ids = [next(self._ids) for _ in items]
            payload = "".join(
                json.dumps({**item, "id": i}) + "\n" for i, item in zip(ids, items, strict=True)
            )
            try:
                assert proc.stdin is not None
                proc.stdin.write(payload.encode("utf-8", "replace"))
                proc.stdin.flush()
                answers = self._read(proc, len(ids), deadline)
            except BaseException:
                self._stop()  # a stuck or dead helper: a fresh one next time
                raise
        by_id = {a.get("id"): a for a in answers if isinstance(a, dict)}
        return [by_id.get(i) for i in ids]

    def _read(self, proc: subprocess.Popen[bytes], count: int, deadline: float) -> list[Any]:
        assert proc.stdout is not None
        fd = proc.stdout.fileno()
        lines: list[Any] = []
        while True:
            while b"\n" in self._buf and len(lines) < count:
                line, self._buf = self._buf.split(b"\n", 1)
                try:
                    lines.append(json.loads(line))
                except ValueError:
                    continue
            if len(lines) >= count:
                return lines
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"{Path(self.argv[0]).name} didn't answer in time")
            ready, _, _ = select.select([fd], [], [], left)
            if not ready:
                raise TimeoutError(f"{Path(self.argv[0]).name} didn't answer in time")
            data = os.read(fd, 1 << 16)
            if not data:
                raise OSError(f"{Path(self.argv[0]).name} stopped")
            self._buf += data

    def _stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.kill()
            proc.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            pass
        for stream in (proc.stdin, proc.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    def close(self) -> None:
        with self._lock:
            self._stop()
