"""What's kept of JARVIS's own conversation between runs (conversation.json, beside
prefs.json): which conversation is the current one, and for each recent one what it has read
(the turn gate's record, so a conversation carried on after a restart is weighed as it was),
what it has cost and its title (its first request, a line). The words themselves are Claude
Code's own record of the session, in its folder for the brain's working folder.

Read defensively: a damaged or hand-edited file never stops the app starting (jsonstore keeps
it aside and reads the last good copy), and a record that doesn't fit is left out.
"""

from __future__ import annotations

import logging
import math
import re
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
    value = float(value)
    return round(value, 6) if math.isfinite(value) and value >= 0 else 0.0


class ConversationState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.current = ""
        self.sessions: dict[str, dict[str, Any]] = {}
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
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
        self._bound()

    def _bound(self) -> None:
        if len(self.sessions) <= KEEP:
            return
        newest = sorted(self.sessions, key=lambda s: self.sessions[s]["at"], reverse=True)
        keep = set(newest[:KEEP]) | ({self.current} if self.current else set())
        self.sessions = {s: v for s, v in self.sessions.items() if s in keep}

    def snapshot(self) -> dict[str, Any]:
        """What's saved, copied: a save in a thread never reads what the loop is changing."""
        return {
            "current": self.current,
            "sessions": {
                sid: {
                    **entry,
                    "reads": dict(entry["reads"], what=list(entry["reads"]["what"]))
                    if entry.get("reads")
                    else None,
                }
                for sid, entry in self.sessions.items()
            },
        }

    def save(self, data: dict[str, Any] | None = None) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, data if data is not None else self.snapshot())

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
