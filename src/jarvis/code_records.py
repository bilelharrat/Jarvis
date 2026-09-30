"""Claude Code's own record of a Jarvis Code session: the JSONL file it keeps for each
conversation (~/.claude/projects/<folder>/<session id>.jsonl). Read here, never written.

- Pictures (RecordMedia): the images one of the owner's messages carried (found by the
  message's id) or a step returned (a screenshot, found by the step's tool id), for the
  transcript's thumbnails. The file is indexed once, as the byte offset of each line that
  holds a picture, and after that only what was added to it is read; a picture itself is
  read back from its line when a window asks for it, so none is kept in memory.

Nothing here calls a model.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tasks import image_count

log = logging.getLogger("jarvis")

# How a picture looks in a line of the record (compact JSON, as Claude Code writes it; the
# spaced form in case a record was rewritten by something else).
_IMAGE_MARKS = (b'"type":"image"', b'"type": "image"')
IMAGE_MAX = 8_000_000  # characters of base64: a picture bigger than this isn't sent back
REPLY_MAX = 16_000_000  # characters of base64 in one answer to a window, all pictures in it
KEYS_MAX = 24  # entries one request may ask pictures for
FILES_KEPT = 16  # records whose index is kept (the sessions open lately)


def record_path(session_id: str, cwd: Path | str) -> Path | None:
    """Where Claude Code keeps a session's record (its project folder, or one of that
    folder's git worktrees), or None when there's none yet."""
    if not session_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", session_id):
        return None
    try:
        from claude_agent_sdk._internal.sessions import _resolve_session_file_path
    except Exception:  # an SDK without it: no pictures, never a failure
        return None
    try:
        return _resolve_session_file_path(session_id, str(cwd))
    except Exception:
        log.warning("Couldn't find the record of session %s", session_id, exc_info=True)
        return None


def _blocks(entry: dict[str, Any]) -> list[dict[str, Any]]:
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def keys_of(entry: dict[str, Any]) -> list[str]:
    """The entries of the transcript a line of the record has pictures for: the owner's
    message itself (its uuid), and each step whose result is in it (its tool id)."""
    if entry.get("type") != "user":
        return []
    keys = []
    blocks = _blocks(entry)
    if any(b.get("type") == "image" for b in blocks) and entry.get("uuid"):
        keys.append(str(entry["uuid"]))
    for b in blocks:
        if (
            b.get("type") == "tool_result"
            and image_count(b.get("content"))
            and b.get("tool_use_id")
        ):
            keys.append(str(b["tool_use_id"]))
    return keys


def _picture(block: dict[str, Any]) -> dict[str, Any] | None:
    source = block.get("source")
    if not isinstance(source, dict) or source.get("type") != "base64":
        return None  # a picture by address: nothing to show without fetching it
    media_type = str(source.get("media_type") or "")
    data = source.get("data")
    if not media_type.startswith("image/") or not isinstance(data, str) or not data:
        return None
    if len(data) > IMAGE_MAX:
        return {"media_type": media_type, "too_big": True}
    return {"media_type": media_type, "data": data}


def pictures_in(entry: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """The pictures a line of the record holds for one transcript entry."""
    blocks = _blocks(entry)
    if str(entry.get("uuid") or "") == key:
        found = [b for b in blocks if b.get("type") == "image"]
    else:
        found = []
        for b in blocks:
            if b.get("type") == "tool_result" and str(b.get("tool_use_id") or "") == key:
                content = b.get("content")
                found += [c for c in content if isinstance(c, dict) and c.get("type") == "image"]
    return [p for p in map(_picture, found) if p is not None]


@dataclass
class _Index:
    inode: int = -1
    scanned: int = 0  # bytes of the record read so far (whole lines only)
    offsets: dict[str, list[int]] = field(default_factory=dict)  # key -> where its lines start


class RecordMedia:
    """The pictures in sessions' records, by transcript entry. Thread-safe: windows'
    requests are served off the event loop (asyncio.to_thread)."""

    def __init__(self, locate: Any = record_path) -> None:
        self.locate = locate
        self._indexes: OrderedDict[Path, _Index] = OrderedDict()
        self._lock = threading.Lock()

    def _index(self, path: Path) -> _Index:
        stat = path.stat()
        index = self._indexes.get(path)
        if index is None or index.inode != stat.st_ino or stat.st_size < index.scanned:
            index = _Index(inode=stat.st_ino)  # new, or replaced or cut short: from the top
        self._indexes[path] = index
        self._indexes.move_to_end(path)
        while len(self._indexes) > FILES_KEPT:
            self._indexes.popitem(last=False)
        if stat.st_size > index.scanned:
            with path.open("rb") as f:
                f.seek(index.scanned)
                at = index.scanned
                for line in f:
                    if not line.endswith(b"\n"):
                        break  # still being written: read again next time
                    if any(mark in line for mark in _IMAGE_MARKS):
                        with contextlib.suppress(ValueError):
                            entry = json.loads(line)
                            if isinstance(entry, dict):
                                for key in keys_of(entry):
                                    index.offsets.setdefault(key, []).append(at)
                    at += len(line)
                index.scanned = at
        return index

    def pictures(self, session_id: str, cwd: Path | str, keys: list[str]) -> dict[str, Any]:
        """{key: [{media_type, data} | {media_type, too_big}]} for the entries asked about
        that have pictures in the record (the ones it has no pictures for are left out),
        and within REPLY_MAX altogether (what doesn't fit is marked too_big)."""
        path = self.locate(session_id, cwd)
        if path is None:
            return {}
        wanted = [str(k) for k in keys if isinstance(k, str) and 0 < len(k) <= 100][:KEYS_MAX]
        out: dict[str, list[dict[str, Any]]] = {}
        budget = REPLY_MAX
        with self._lock:
            try:
                index = self._index(path)
            except OSError:
                return {}
            try:
                f = path.open("rb")
            except OSError:
                return {}
            with f:
                for key in dict.fromkeys(wanted):
                    for at in index.offsets.get(key, []):
                        f.seek(at)
                        try:
                            entry = json.loads(f.readline())
                        except ValueError:
                            continue
                        for picture in pictures_in(entry, key) if isinstance(entry, dict) else []:
                            size = len(picture.get("data", ""))
                            if size > budget:
                                picture = {"media_type": picture["media_type"], "too_big": True}
                                size = 0
                            budget -= size
                            out.setdefault(key, []).append(picture)
        return out
