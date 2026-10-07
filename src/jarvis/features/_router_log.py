"""The Model Router's usage event log (features.code_router_events): one JSON object per line
in model_router_events.jsonl, beside prefs.json.

- Append-only. Lines are queued and written off the event loop (asyncio.to_thread), a batch
  at a time, so the send path never waits on the disk; what's still queued when the app
  quits is written then (flush_now).
- Rotated at ROTATE_BYTES: the file becomes .1, .1 becomes .2 (KEEP_FILES files in all).
- Retention: lines older than RETENTION_DAYS are dropped (prune: a rotated file whose newest
  line is that old goes; the current file is rewritten without its old lines).
- Readable by the owner alone (0600). A torn or foreign line is skipped when read.

Privacy: the log never holds prompt text. Callers write hashes, lengths, the task profile's
numbers, model ids and outcomes (see code_router_events).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

ROTATE_BYTES = 5 * 1024 * 1024
KEEP_FILES = 3  # the current file and two rotated ones
RETENTION_DAYS = 90
MAX_QUEUED = 2000  # lines waiting for the disk; past this the oldest go (a disk that hangs)
MAX_LINE = 64 * 1024  # a line longer than this is a bug somewhere: not written


def iso(at: float | None = None) -> str:
    """A timestamp as the log writes it (UTC, seconds)."""
    moment = datetime.fromtimestamp(time.time() if at is None else at, UTC)
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def epoch_of(value: Any) -> float | None:
    """The log's ISO timestamp as epoch seconds, None when it isn't one."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.timestamp()


class EventLog:
    def __init__(
        self,
        path: Path,
        *,
        rotate_bytes: int = ROTATE_BYTES,
        keep: int = KEEP_FILES,
        days: float = RETENTION_DAYS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = Path(path)
        self.rotate_bytes = rotate_bytes
        self.keep = max(1, keep)
        self.days = days
        self.clock = clock
        self._lock = threading.Lock()  # one writer at a time (the flush thread, prune, quit)
        self._queue: list[str] = []
        self._flushing: asyncio.Task | None = None
        self.written = 0  # lines written by this run (the learner's trigger counts its own)

    # ── files ──

    def files(self) -> list[Path]:
        """The log's files that exist, oldest first (…, .2, .1, the current one)."""
        out = [self.path.with_name(f"{self.path.name}.{n}") for n in range(self.keep - 1, 0, -1)]
        out.append(self.path)
        return [p for p in out if p.is_file()]

    # ── writing ──

    def append(self, record: dict[str, Any]) -> None:
        """Queue one record; it's written off the event loop (or at once without one)."""
        try:
            line = json.dumps(record, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError):
            log.warning("model router log: a record that isn't JSON was left out")
            return
        if len(line) > MAX_LINE:
            log.warning("model router log: a %d-byte record was left out", len(line))
            return
        self._queue.append(line)
        if len(self._queue) > MAX_QUEUED:
            del self._queue[: len(self._queue) - MAX_QUEUED]
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self.flush_now()
            return
        if self._flushing is None or self._flushing.done():
            self._flushing = loop.create_task(self._flush_soon())

    async def _flush_soon(self) -> None:
        while self._queue:
            lines, self._queue = self._queue, []
            try:
                await asyncio.to_thread(self._write, lines)
            except Exception:
                log.exception("model router log: couldn't write %d line(s)", len(lines))

    async def flush(self) -> None:
        """Everything queued, written (tests; the learner before it reads)."""
        while self._flushing is not None and not self._flushing.done():
            await asyncio.shield(self._flushing)
        if self._queue:
            await self._flush_soon()

    def flush_now(self) -> None:
        """Write what's queued here and now (the app quitting; no event loop)."""
        lines, self._queue = self._queue, []
        if lines:
            try:
                self._write(lines)
            except Exception:
                log.exception("model router log: couldn't write %d line(s)", len(lines))

    def _write(self, lines: list[str]) -> None:
        data = "".join(f"{line}\n" for line in lines).encode("utf-8")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(FileNotFoundError):
                if self.path.stat().st_size + len(data) > self.rotate_bytes:
                    self._rotate()
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, data)
            finally:
                os.close(fd)
            self.written += len(lines)

    def _rotate(self) -> None:
        """current -> .1 -> .2 …, the oldest dropped (under the lock)."""
        names = [self.path] + [
            self.path.with_name(f"{self.path.name}.{n}") for n in range(1, self.keep)
        ]
        with contextlib.suppress(FileNotFoundError):
            names[-1].unlink()
        for older, newer in zip(reversed(names[1:]), reversed(names[:-1]), strict=True):
            with contextlib.suppress(FileNotFoundError):
                newer.rename(older)

    # ── reading ──

    def read(self, since: float | None = None) -> Iterator[dict[str, Any]]:
        """Every record, oldest first (since: only those at or after that epoch second).
        Torn, foreign and unreadable lines are skipped."""
        for path in self.files():
            try:
                handle = path.open("rb")
            except OSError:
                continue
            with handle:
                for raw in handle:
                    try:
                        record = json.loads(raw)
                    except (ValueError, RecursionError):
                        continue
                    if not isinstance(record, dict):
                        continue
                    if since is not None:
                        at = epoch_of(record.get("ts"))
                        if at is None or at < since:
                            continue
                    yield record

    # ── retention ──

    def prune(self) -> int:
        """Drop what's older than the retention period: whole rotated files whose newest
        line is that old, and the current file's old lines. How many files changed."""
        cutoff = self.clock() - self.days * 86400
        changed = 0
        with self._lock:
            for path in self.files():
                newest, oldest = _ends(path)
                if newest is not None and newest < cutoff and path != self.path:
                    with contextlib.suppress(OSError):
                        path.unlink()
                        changed += 1
                elif path == self.path and oldest is not None and oldest < cutoff:
                    if _rewrite_since(path, cutoff):
                        changed += 1
        return changed


def _ends(path: Path) -> tuple[float | None, float | None]:
    """(newest, oldest) timestamp of a log file's lines (by its first and last lines)."""
    try:
        with path.open("rb") as handle:
            first = handle.readline()
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            tail = handle.read().splitlines()
    except OSError:
        return None, None

    def stamp(raw: bytes) -> float | None:
        try:
            record = json.loads(raw)
        except (ValueError, RecursionError):
            return None
        return epoch_of(record.get("ts")) if isinstance(record, dict) else None

    newest = next((s for s in (stamp(r) for r in reversed(tail)) if s is not None), None)
    return newest, stamp(first)


def _rewrite_since(path: Path, cutoff: float) -> bool:
    """The file without its lines older than cutoff (a torn line goes too), swapped in whole."""
    tmp = path.with_name(f".{path.name}.prune")
    try:
        with (
            path.open("rb") as src,
            os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as dst,
        ):
            for raw in src:
                try:
                    record = json.loads(raw)
                except (ValueError, RecursionError):
                    continue
                at = epoch_of(record.get("ts")) if isinstance(record, dict) else None
                if at is not None and at >= cutoff:
                    dst.write(raw if raw.endswith(b"\n") else raw + b"\n")
        os.replace(tmp, path)
        return True
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()
        return False
