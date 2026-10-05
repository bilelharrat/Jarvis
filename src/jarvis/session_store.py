"""Jarvis Code sessions kept across a restart (features.code_sessions).

Each session the list shows is a small JSON file of its own (<key>.json in the folder the
feature keeps beside prefs.json): where it runs, its Claude Code conversation, how it's set
(mode, model, effort, ultracode, folders, plugins, connectors), what's queued for it, the
unsent draft, its latest permission decisions, how it's filed in the sidebar and its goal.
Pictures and files attached to a queued message stay in memory: only the words are kept.
A session waiting out Claude's usage limit keeps until when (and since when) it waits.

Everything read back is checked field by field: a file edited by hand or cut short never
stops the app from starting. A damaged file is set aside (jsonstore) and its last good copy
used; one that can't be read at all is left alone and never saved over.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore

log = logging.getLogger("jarvis")

STORE_LIMIT = 60  # sessions kept: the open ones and the ended ones the list shows
# Every session ever listed is kept (a chat is never lost): past STORE_LIMIT the ended ones
# are "let go" from the list but kept on disk, in the history, to reopen as they were.
KEEP_LIMIT = 2000
AUDIT_KEEP = 500  # permission decisions kept per session
QUEUE_KEEP = 50  # messages waiting (tasks.MAX_QUEUED)
TEXT_LIMIT = 20_000  # a queued message or a draft (the window's own limit for a message)
FILES_KEEP = 500
REMEMBERED_LIMIT = 200  # sessions whose settings are kept for a resume from the history
KEY = re.compile(r"[a-f0-9]{8,32}")
_MODES = ("plan", "ask", "edits", "smart", "auto")
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_ENDED = ("stopped", "failed")
_CONNECTOR = re.compile(r"[\w.\-]{1,64}")


class SessionStore:
    """The kept sessions in a folder, one file each. Saves write only what changed since the
    last save and let go of the files of sessions no longer listed; one save at a time."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        # key -> a digest of the JSON last written or read (thousands of kept sessions, each
        # up to hundreds of KB: only enough to tell an unchanged one)
        self.written: dict[str, bytes] = {}
        self.unreadable: set[str] = set()  # keys whose file couldn't be read: never saved over
        self.remembered_unreadable = ""  # why remembered.json can't be read: never saved over
        self._lock = threading.Lock()

    def load(self) -> list[dict[str, Any]]:
        """Every kept session, oldest first (at most KEEP_LIMIT, the newest)."""
        try:
            paths = sorted(self.folder.glob("*.json"))
        except OSError:
            return []
        records: list[dict[str, Any]] = []
        # Taken as read only once all are: a reading stopped half way never has the next
        # save let go of the files it got through (as no longer listed).
        written: dict[str, bytes] = {}
        for path in paths[: KEEP_LIMIT * 2]:
            key = path.stem
            if not KEY.fullmatch(key):
                continue
            try:
                data = jsonstore.load_json(path, dict)
            except jsonstore.Unreadable as exc:
                log.warning("Jarvis Code: session %s can't be read (%s)", key, exc.strerror)
                self.unreadable.add(key)
                continue
            record = clean_record(data, key)
            if record is None:
                continue
            written[key] = _digest(record)
            records.append(record)
        self.written.update(written)
        records.sort(key=lambda r: (r["created"], r["key"]))
        return records[-KEEP_LIMIT:]

    def save(self, changed: dict[str, dict[str, Any]], keep: set[str]) -> None:
        """Write the sessions that changed, and forget the ones not in keep (no longer
        listed). Blocking: the feature runs it in a thread."""
        with self._lock:
            for key, record in changed.items():
                if key in self.unreadable or not KEY.fullmatch(key) or key not in keep:
                    continue
                digest = _digest(record)
                if self.written.get(key) == digest:
                    continue
                jsonstore.save_json(self.folder / f"{key}.json", record, indent=None)
                self.written[key] = digest
            for key in [k for k in self.written if k not in keep]:
                for path in (self.folder / f"{key}.json", self.folder / f"{key}.json.bak"):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as exc:
                        log.warning("Jarvis Code: couldn't let go of session %s (%s)", key, exc)
                del self.written[key]

    def read(self, key: str) -> dict[str, Any] | None:
        """One kept session read back whole (one let go from the list, reopened), or None
        when there's none to use."""
        if not KEY.fullmatch(key) or key in self.unreadable:
            return None
        try:
            data = jsonstore.load_json(self.folder / f"{key}.json", dict)
        except jsonstore.Unreadable as exc:
            log.warning("Jarvis Code: session %s can't be read (%s)", key, exc.strerror)
            return None
        return clean_record(data, key)

    def load_remembered(self) -> dict[str, dict[str, Any]]:
        """How sessions were set, by Claude Code session id, oldest first (resumed from the
        history, one starts that way again)."""
        try:
            data = jsonstore.load_json(self.folder / "remembered.json", dict) or {}
        except jsonstore.Unreadable as exc:
            self.remembered_unreadable = exc.strerror or "it can't be read"
            return {}
        kept: dict[str, dict[str, Any]] = {}
        for session_id, fields in list(data.items())[-REMEMBERED_LIMIT:]:
            if (
                not isinstance(session_id, str)
                or len(session_id) > 100
                or not isinstance(fields, dict)
            ):
                continue
            own: dict[str, Any] = {}
            if fields.get("mode") in _MODES and fields["mode"] != "auto":
                own["mode"] = fields["mode"]
            if isinstance(fields.get("model"), str) and 0 < len(fields["model"]) <= 200:
                own["model"] = fields["model"]
            if fields.get("effort") in _EFFORTS:
                own["effort"] = fields["effort"]
            if isinstance(fields.get("ultracode"), bool):
                own["ultracode"] = fields["ultracode"]
            for key in ("add_dirs", "plugins"):
                paths = [p for p in _strings(fields.get(key), 10) if p.startswith("/")]
                if paths:
                    own[key] = paths
            kept[session_id] = own
        return kept

    def save_remembered(self, remembered: dict[str, dict[str, Any]]) -> None:
        path = self.folder / "remembered.json"
        if self.remembered_unreadable:
            raise jsonstore.refusal(path, self.remembered_unreadable)
        with self._lock:
            jsonstore.save_json(path, remembered, indent=None)


def _digest(record: dict[str, Any]) -> bytes:
    text = json.dumps(record, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.blake2b(text.encode("utf-8", "surrogatepass"), digest_size=16).digest()


# ── reading a record back: every field checked, anything odd left at its default ──


def _str(value: Any, limit: int, default: str = "") -> str:
    return value[:limit] if isinstance(value, str) else default


def _bool(value: Any) -> bool:
    return value is True


def _strings(value: Any, limit: int, each: int = 1000) -> list[str]:
    if not isinstance(value, list):
        return []
    return [v[:each] for v in value[:limit] if isinstance(v, str) and v]


def _amount(value: Any) -> float | None:
    """A finite number, or None (a whole number past what a float holds is no amount)."""
    if not isinstance(value, int | float) or isinstance(value, bool):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    return value if math.isfinite(value) else None


def _moment(value: Any) -> float:
    """A time (seconds since the epoch), or 0 for none."""
    amount = _amount(value)
    return amount if amount is not None and amount > 0 else 0.0


def _when(value: Any) -> str:
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).isoformat(timespec="seconds")
        except ValueError:
            pass
    return ""


def clean_record(data: Any, key: str) -> dict[str, Any] | None:
    """A kept session as the feature may use it, or None when there's nothing to use (no
    folder). Unknown fields are dropped; a wrong one is its default."""
    if not isinstance(data, dict):
        return None
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd.startswith("/") or "\x00" in cwd or len(cwd) > 1000:
        return None
    cost = _amount(data.get("cost_usd"))
    commands = data.get("commands")
    queue = []
    for item in data.get("queue") if isinstance(data.get("queue"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip():
            queue.append({"text": item["text"][:TEXT_LIMIT], "plain": _bool(item.get("plain"))})
    audit = []
    for item in data.get("audit") if isinstance(data.get("audit"), list) else []:
        if isinstance(item, dict):
            audit.append(
                {
                    k: _str(item.get(k), 600)
                    for k in ("at", "tool", "what", "decision", "why")
                    if isinstance(item.get(k), str)
                }
            )
    todos = []
    for item in data.get("todos") if isinstance(data.get("todos"), list) else []:
        if isinstance(item, dict):
            todos.append({k: _str(item.get(k), 500) for k in ("content", "status", "active")})
    status = data.get("status") if data.get("status") in _ENDED else ""
    created = _when(data.get("created")) or datetime.now().isoformat(timespec="seconds")
    sid = data.get("id")  # its id in the window, the same after a restart
    return {
        "key": key,
        "id": sid if isinstance(sid, int) and not isinstance(sid, bool) and 0 < sid < 2**31 else 0,
        "cwd": cwd,
        "session_id": _str(data.get("session_id"), 100),
        "title": _str(data.get("title"), 100),
        "prompt": _str(data.get("prompt"), 500),
        "mode": data.get("mode") if data.get("mode") in _MODES else "ask",
        "model": _str(data.get("model"), 200),
        "model_label": _str(data.get("model_label"), 100),
        "model_ref": _str(data.get("model_ref"), 200),
        "effort": data.get("effort") if data.get("effort") in _EFFORTS else "",
        "ultracode": _bool(data.get("ultracode")),
        "add_dirs": [d for d in _strings(data.get("add_dirs"), 10) if d.startswith("/")],
        "plugins": [d for d in _strings(data.get("plugins"), 10) if d.startswith("/")],
        "disabled_mcp": [
            n for n in _strings(data.get("disabled_mcp"), 50, 64) if _CONNECTOR.fullmatch(n)
        ],
        "queue": queue[:QUEUE_KEEP],
        "dropped": data["dropped"]
        if isinstance(data.get("dropped"), int) and 0 <= data["dropped"] <= 1000
        else 0,
        "draft": _str(data.get("draft"), TEXT_LIMIT),
        "audit": audit[-AUDIT_KEEP:],
        "ended": _bool(data.get("ended")) and bool(status),
        "status": status,
        "was_working": _bool(data.get("was_working")),
        "last_action": _str(data.get("last_action"), 200),
        "result": _str(data.get("result"), 2000),
        "plan": _str(data.get("plan"), 4000),
        "todos": todos[:30],
        "cost_usd": round(max(0.0, float(cost)), 6) if cost is not None else None,
        "files_changed": _strings(data.get("files_changed"), FILES_KEEP),
        "commands": commands
        if isinstance(commands, int) and not isinstance(commands, bool) and commands >= 0
        else 0,
        "fork": _bool(data.get("fork")),
        "resume_at": _str(data.get("resume_at"), 100),
        # Waiting out Claude's usage limit (features.code_limit): until when, since when.
        "hold_until": _moment(data.get("hold_until")),
        "held_since": _moment(data.get("held_since")),
        "created": created,
        "updated": _when(data.get("updated")) or created,
        "pinned": _bool(data.get("pinned")),
        "archived": _bool(data.get("archived")),
        "group": " ".join(_str(data.get("group"), 40).split()),
        "goal": data.get("goal") if isinstance(data.get("goal"), dict) else None,
    }
