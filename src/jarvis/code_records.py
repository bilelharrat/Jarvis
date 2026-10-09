"""Claude Code's own record of an Eden Code session: the JSONL file it keeps for each
conversation (~/.claude/projects/<folder>/<session id>.jsonl). Read here, never written.

- Pictures (RecordMedia): the images one of the owner's messages carried (found by the
  message's id) or a step returned (a screenshot, found by the step's tool id), for the
  transcript's thumbnails. The file is indexed once, as the byte offset of each line that
  holds a picture, and after that only what was added to it is read; a picture itself is
  read back from its line when a window asks for it, so none is kept in memory.
- When each message was written (timestamps), for a full export (code_export).
- A reopened session's newest messages (newest_messages), read from the end of its record
  so they show at once: a long session's record is hundreds of megabytes, most of it
  pictures and tool output, and reading it whole takes seconds.

Nothing here calls a model.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_agent_sdk.types import SessionMessage

from .tasks import image_count

log = logging.getLogger("jarvis")

# How a picture looks in a line of the record (compact JSON, as Claude Code writes it; the
# spaced form in case a record was rewritten by something else).
_IMAGE_MARKS = (b'"type":"image"', b'"type": "image"')
IMAGE_MAX = 8_000_000  # characters of base64: a picture bigger than this isn't sent back
REPLY_MAX = 16_000_000  # characters of base64 in one answer to a window, all pictures in it
KEYS_MAX = 24  # entries one request may ask pictures for
FILES_KEPT = 16  # records whose index is kept (the sessions open lately)
_TIMESTAMP = re.compile(rb'"timestamp"\s*:\s*"([^"]{10,40})"')
_UUID = re.compile(rb'"uuid"\s*:\s*"([0-9a-fA-F-]{36})"')
# A picture's base64 in a line of the record, left out before a long line is parsed: it is
# most of a record's bytes, and a transcript only counts pictures (image_count).
_BASE64 = re.compile(rb'"data"\s*:\s*"[A-Za-z0-9+/=]{256,}"')
LONG_LINE = 64_000  # bytes: a line this long may carry pictures worth leaving out
# The lines the SDK's get_session_messages builds a conversation from.
_ENTRY_TYPES = frozenset({"user", "assistant", "progress", "system", "attachment"})
TAIL_CHUNK = 1 << 20  # bytes read from the end at first; each read further back is twice that
TAIL_MAX = 48 << 20  # read this far back and still short: newest_messages gives up


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


def timestamps(path: Path | None) -> dict[str, str]:
    """When each message of a record was written, by its uuid (for an export's times),
    read without parsing the lines (a picture can make one megabytes long)."""
    found: dict[str, str] = {}
    if path is None:
        return found

    def last(pattern: re.Pattern[bytes], text: bytes) -> bytes | None:
        # The entry's own fields come after its message (which may quote a uuid of its own).
        match = None
        for match in pattern.finditer(text):  # noqa: B007 - the last one is wanted
            pass
        return match.group(1) if match is not None else None

    try:
        with path.open("rb") as f:
            for line in f:
                uuid, when = last(_UUID, line[-4096:]), last(_TIMESTAMP, line[-4096:])
                if uuid is None or when is None:
                    uuid, when = last(_UUID, line), last(_TIMESTAMP, line)
                if uuid is not None and when is not None:
                    found[uuid.decode()] = when.decode(errors="replace")
    except OSError:
        return {}
    return found


def _record_line(raw: bytes) -> dict[str, Any] | None:
    """One line of the record as the SDK keeps it (a conversation's line with its uuid), or
    None; a long one without its pictures' base64."""
    raw = raw.strip()
    if not raw:
        return None
    if len(raw) > LONG_LINE:
        raw = _BASE64.sub(b'"data":""', raw)
    try:
        entry = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(entry, dict) or entry.get("type") not in _ENTRY_TYPES:
        return None
    return entry if isinstance(entry.get("uuid"), str) else None


def _visible(entry: dict[str, Any]) -> bool:
    """A message of the conversation itself (as the SDK's get_session_messages keeps them):
    no meta note, no subagent's side conversation."""
    return (
        entry.get("type") in ("user", "assistant")
        and not entry.get("isMeta")
        and not entry.get("isSidechain")
        and not entry.get("teamName")
    )


def newest_messages(
    path: Path, enough: Callable[[list[SessionMessage]], bool]
) -> tuple[list[SessionMessage], bool] | None:
    """A session's newest messages, the end of what get_session_messages would list, read
    from the end of its record back only as far as needed: its conversation followed back
    (parentUuid) from its newest message until enough(messages) says so, or to its start.
    Says whether it got to the start (the messages are then all of it). None when the
    record can't be read, holds no conversation, or TAIL_MAX of it wasn't enough.

    The newest message is chosen as the SDK chooses it: of the lines nothing follows on
    from, each one's nearest message, the last written that isn't a meta note or a side
    conversation's (so a rewind's abandoned line, or a meta note at the very end, can leave
    it further back). A line's followers are written after it, so those of every line read
    from the end are already read."""
    seen: dict[str, dict[str, Any]] = {}  # uuid -> its line (the last one, as the SDK keeps)
    back: dict[str, int] = {}  # uuid -> how far back it was written (0: the last line)
    parents: set[str] = set()  # the lines something follows on from
    ends: list[dict[str, Any]] = []  # ... and those nothing does, newest first
    chain: list[dict[str, Any]] = []  # the conversation, newest first
    walked: set[str] = set()
    start = False  # at the conversation's start (or its first message missing from the file)

    def newest() -> dict[str, Any] | None:
        best = None
        for end in ends:
            entry, steps = end, set()
            while entry is not None and entry["uuid"] not in steps:
                steps.add(entry["uuid"])
                if entry.get("type") in ("user", "assistant"):
                    if _visible(entry) and (
                        best is None or back[entry["uuid"]] < back[best["uuid"]]
                    ):
                        best = entry
                    break
                parent = entry.get("parentUuid")
                entry = seen.get(parent) if parent else None
        return best  # (one found further back later would be older than any found here)

    def walk() -> None:
        nonlocal start
        entry = chain[-1] if chain else None
        while entry is not None:
            parent = entry.get("parentUuid")
            if not parent or parent in walked:
                start = True
                return
            entry = seen.get(parent)
            if entry is not None:
                walked.add(parent)
                chain.append(entry)

    try:
        with path.open("rb") as f:
            end = pos = f.seek(0, os.SEEK_END)
            carry, chunk = b"", TAIL_CHUNK
            while pos > 0 and not start:
                if end - pos >= TAIL_MAX:
                    return None
                begin = max(0, pos - chunk)
                f.seek(begin)
                lines = (f.read(pos - begin) + carry).split(b"\n")
                pos, chunk = begin, min(chunk * 2, 16 << 20)
                carry = lines.pop(0) if pos > 0 else b""  # (the end of a line further back)
                for raw in reversed(lines):
                    entry = _record_line(raw)
                    if entry is None:
                        continue
                    uuid = entry["uuid"]
                    if uuid not in seen:
                        seen[uuid], back[uuid] = entry, len(back)
                        if uuid not in parents:
                            ends.append(entry)
                    if entry.get("parentUuid"):
                        parents.add(entry["parentUuid"])
                if not chain and (leaf := newest()) is not None:
                    chain.append(leaf)
                    walked.add(leaf["uuid"])
                walk()
                messages = _messages(chain)
                if not start and messages and enough(messages):
                    return messages, False
    except OSError:
        return None
    messages = _messages(chain)
    return (messages, True) if messages else None


def _messages(chain: list[dict[str, Any]]) -> list[SessionMessage]:
    return [
        SessionMessage(
            type="user" if e.get("type") == "user" else "assistant",
            uuid=e.get("uuid", ""),
            session_id=e.get("sessionId", ""),
            message=e.get("message"),
        )
        for e in reversed(chain)
        if _visible(e)
    ]
