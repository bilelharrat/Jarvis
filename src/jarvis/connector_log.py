"""What JARVIS did in the owner's connected accounts: one line for every connector tool call
its brain makes (Notion, GitHub, Google Calendar…): when, the service, the tool, whether it
only reads or changes something, and how it went (done, failed, or declined at the card).
Never what was sent or what came back.

A JSON line per call in a file beside prefs.json (connector_activity.jsonl), readable by the
owner alone, at most KEEP of them and none older than KEEP_DAYS: a damaged line is skipped,
never a reason to lose the rest, and only the file's tail is read (a damaged file of any size
never slows the start). Settings › Tools & Accounts shows the latest.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

KEEP = 2000
KEEP_DAYS = 90
SHOWN = 200  # kept in memory for the window
OUTCOMES = ("done", "failed", "declined")
READ_LIMIT = 2 * 1024 * 1024  # bytes read from the end of the file: KEEP lines fit many times
LINE_LIMIT = 2000  # characters: no line this log writes is longer


def _entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    fields = {k: raw.get(k) for k in ("at", "service", "tool", "kind", "outcome")}
    if not all(isinstance(v, str) and 0 < len(v) <= 200 for v in fields.values()):
        return None
    if fields["kind"] not in ("read", "write") or fields["outcome"] not in OUTCOMES:
        return None
    return fields


class ConnectorLog:
    def __init__(self, path: Path, clock=datetime.now) -> None:
        self.path = path
        self.clock = clock
        self.lines = 0
        self.items: deque[dict[str, Any]] = deque(maxlen=SHOWN)
        self._load()

    def _read(self) -> list[dict[str, Any]]:
        try:
            with self.path.open("rb") as fh:
                size = fh.seek(0, os.SEEK_END)
                fh.seek(max(0, size - READ_LIMIT))
                raw = fh.read().decode("utf-8", errors="replace")
        except OSError:
            return []
        lines = raw.splitlines()
        if size > READ_LIMIT:
            lines = lines[1:]  # the first may start part way through a line
        found = []
        for line in lines:
            if len(line) > LINE_LIMIT:
                continue
            try:
                entry = _entry(json.loads(line))
            except (ValueError, RecursionError):  # not JSON, or nested past reason
                continue
            if entry is not None:
                found.append(entry)
        return found

    def _load(self) -> None:
        found = self._read()
        self.lines = len(found)
        self.items.extend(found[-SHOWN:])

    def add(self, service: str, tool: str, kind: str, outcome: str) -> dict[str, Any]:
        """Note one call (the service's display name and the tool's name only)."""
        entry = {
            "at": self.clock().isoformat(timespec="seconds"),
            "service": str(service)[:80] or "?",
            "tool": str(tool)[:120] or "?",
            "kind": "read" if kind == "read" else "write",
            "outcome": outcome if outcome in OUTCOMES else "done",
        }
        self.items.append(entry)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self.lines += 1
            if self.lines > KEEP * 2:
                self.compact()
        except OSError as exc:
            log.warning("connector activity: couldn't write (%s)", exc)
        return entry

    def compact(self) -> None:
        """Keep the last KEEP lines from the last KEEP_DAYS, written whole in one swap."""
        cutoff = (self.clock() - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
        kept = [e for e in self._read() if e["at"] >= cutoff][-KEEP:]
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.writelines(json.dumps(e, ensure_ascii=False) + "\n" for e in kept)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError:
            Path(tmp).unlink(missing_ok=True)
            raise
        self.lines = len(kept)

    def recent(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(self.items)[-limit:][::-1]
