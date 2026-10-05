"""What's kept of JARVIS's own conversation between runs (conversation.json, beside
prefs.json): which conversation is the current one, and for each recent one what it has read
(the turn gate's record, so a conversation carried on after a restart is weighed as it was),
what it has cost and its title (its first request, a line), and where each branch came from
(a rewind or a fork of another conversation: its parent), with a branch made but not yet
spoken in (the source carried on up to a point, until Claude Code gives it its own id). The words themselves are Claude
Code's own record of the session, in its folder for the brain's working folder.

Read defensively: a damaged or hand-edited file never stops the app starting (jsonstore keeps
it aside and reads the last good copy), and a record that doesn't fit is left out.
"""

from __future__ import annotations

import logging
import math
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

log = logging.getLogger("jarvis")

KEEP = 300  # conversations whose reads and cost are kept, newest first
READS_KEPT = 40  # what the gates name as read, per conversation (as the hub keeps it)
TITLE_CHARS = 100
SESSION_ID = re.compile(r"[A-Za-z0-9][\w-]{0,79}")
RELATIONS = ("fork", "rewind")  # how a conversation came from its parent
# A conversation whose reads aren't known (one from before this record was kept, or a
# damaged file) counts as having read private data and pages: carrying it on never opens
# the gates wider than they were.
UNKNOWN_READS: dict[str, Any] = {
    "private": True,
    "web": True,
    "what": ["what it read before it was reopened"],
}


def valid_id(value: Any) -> str:
    """A session id as Claude Code gives them, or ""."""
    text = str(value or "").strip()
    return text if SESSION_ID.fullmatch(text) else ""


def clean_reads(raw: Any) -> dict[str, Any] | None:
    """The hub's record of what a conversation has read ({private, web, what}), or None."""
    if not isinstance(raw, dict):
        return None
    what = raw.get("what")
    names = (
        [clean_text(w).strip()[:160] for w in what if isinstance(w, str)]
        if isinstance(what, list)
        else []
    )
    return {
        "private": raw.get("private") is True,
        "web": raw.get("web") is True,
        "what": [w for w in names if w][-READS_KEPT:],
    }


def title_line(value: Any) -> str:
    """A conversation's title: one line of its first request, short."""
    return " ".join(clean_text(value).split())[:TITLE_CHARS] if isinstance(value, str) else ""


def _cost(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    try:
        value = float(value)
    except OverflowError:  # a whole number past what a float holds (a hand edit)
        return 0.0
    return round(value, 6) if math.isfinite(value) and value >= 0 else 0.0


def clean_branch(raw: Any) -> dict[str, Any] | None:
    """A branch not yet spoken in: {source, at (the message it carries on after; "" for
    all of it), relation, fresh (from before the first message: a new conversation)}."""
    if not isinstance(raw, dict) or raw.get("relation") not in RELATIONS:
        return None
    source = valid_id(raw.get("source"))
    if not source:
        return None
    return {
        "source": source,
        "at": valid_id(raw.get("at")),
        "relation": raw["relation"],
        "fresh": raw.get("fresh") is True,
    }


class Snapshot(dict):
    """ConversationState as snapshot() took it: a dict as before (and equal to one), with
    its number (which snapshot it was), so an older one is never saved over a newer."""

    __slots__ = ("taken",)

    def __init__(self, taken: int, **fields: Any) -> None:
        super().__init__(fields)
        self.taken = taken


class ConversationState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.current = ""
        self.branch: dict[str, Any] | None = None
        self.sessions: dict[str, dict[str, Any]] = {}
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self._taken = 0  # snapshots taken, numbered
        self._written = 0  # the number of the one on disk
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("conversation: %s can't be read (%s)", self.path.name, exc)
            return
        if not isinstance(data, dict):
            return
        self.current = valid_id(data.get("current"))
        self.branch = clean_branch(data.get("branch"))
        sessions = data.get("sessions")
        for sid, raw in sessions.items() if isinstance(sessions, dict) else []:
            sid = valid_id(sid)
            if not sid or not isinstance(raw, dict):
                continue
            at = raw.get("at")
            self.sessions[sid] = {
                "reads": clean_reads(raw.get("reads")),
                "cost": _cost(raw.get("cost")),
                "at": at[:25] if isinstance(at, str) else "",
                "title": title_line(raw.get("title")),
            }
            parent = valid_id(raw.get("parent"))
            if parent and parent != sid and raw.get("relation") in RELATIONS:
                self.sessions[sid].update(parent=parent, relation=raw["relation"])
        self._bound()

    def _bound(self) -> None:
        if len(self.sessions) <= KEEP:
            return
        newest = sorted(self.sessions, key=lambda s: self.sessions[s]["at"], reverse=True)
        keep = set(newest[:KEEP]) | ({self.current} if self.current else set())
        self.sessions = {s: v for s, v in self.sessions.items() if s in keep}

    def snapshot(self) -> dict[str, Any]:
        """What's saved, copied: a save in a thread never reads what the loop is changing."""
        self._taken += 1
        return Snapshot(
            self._taken,
            current=self.current,
            branch=dict(self.branch) if self.branch else None,
            sessions={
                sid: {
                    **entry,
                    "reads": dict(entry["reads"], what=list(entry["reads"]["what"]))
                    if entry.get("reads")
                    else None,
                }
                for sid, entry in self.sessions.items()
            },
        )

    def save(self, data: dict[str, Any] | None = None) -> None:
        """Write a snapshot (a fresh one when none is given). Saves run in threads (a turn's,
        a rename's) and can finish in either order: one older than what's already on disk
        is left out, so the file never goes back to before a change it had."""
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        if data is None:
            data = self.snapshot()
        taken = getattr(data, "taken", 0)
        with self._lock:
            if taken and taken < self._written:
                return
            jsonstore.save_json(self.path, data)
            self._written = max(self._written, taken)

    def turn_over(
        self, session_id: str, reads: dict[str, Any], cost: float, title: str = ""
    ) -> None:
        """A turn of this conversation ended: it's the current one, with what it has read
        so far and this turn's cost added. title: its first request, kept once."""
        sid = valid_id(session_id)
        if not sid:
            return
        entry = self.sessions.setdefault(sid, {"reads": None, "cost": 0.0, "at": "", "title": ""})
        entry["reads"] = clean_reads(reads)
        entry["cost"] = _cost(entry["cost"] + max(0.0, cost))
        entry["at"] = datetime.now().isoformat(timespec="seconds")
        if not entry.get("title"):
            entry["title"] = title_line(title)
        self.current = sid
        self._bound()

    def relate(self, session_id: str, parent: str, relation: str) -> None:
        """A branch spoke for the first time: where it came from, kept with it."""
        sid, parent = valid_id(session_id), valid_id(parent)
        if not sid or not parent or sid == parent or relation not in RELATIONS:
            return
        entry = self.sessions.setdefault(sid, {"reads": None, "cost": 0.0, "at": "", "title": ""})
        entry["parent"], entry["relation"] = parent, relation

    def relation_of(self, session_id: str) -> tuple[str, str]:
        """(parent, relation) of a branch; ("", "") for one that isn't."""
        entry = self.sessions.get(valid_id(session_id)) or {}
        return entry.get("parent") or "", entry.get("relation") or ""

    def rewound(self) -> set[str]:
        """The conversations a rewind went on from (the version from before it)."""
        return {
            e["parent"]
            for e in self.sessions.values()
            if e.get("relation") == "rewind" and e.get("parent")
        }

    def titles(self) -> dict[str, str]:
        return {sid: e["title"] for sid, e in self.sessions.items() if e.get("title")}

    def reads_of(self, session_id: str) -> dict[str, Any]:
        """What that conversation has read, as the hub keeps it: UNKNOWN_READS when there's
        no record of it."""
        entry = self.sessions.get(valid_id(session_id)) or {}
        reads = entry.get("reads")
        return clean_reads(reads) or clean_reads(UNKNOWN_READS) or {}

    def cost_of(self, session_id: str) -> float:
        return float((self.sessions.get(valid_id(session_id)) or {}).get("cost") or 0.0)
