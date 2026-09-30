"""What the chat channels keep between runs: channels.json, beside the settings.

Who each chat is paired with, the bot each token belongs to, where Telegram's updates got
to, and a short audit log: who wrote, when, and what kind of thing it was. Never a token (those are in the Keychain)
and never what anyone wrote. A damaged file is set aside and its last good copy read; one
that can't be read just now is left alone and nothing is saved over it, and every chat
counts as unpaired until it can be."""

from __future__ import annotations

import logging
import re
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import jsonstore

log = logging.getLogger("jarvis")

VERSION = 1
AUDIT_KEEP = 200
PAIRED = ("telegram",)
_ID = re.compile(r"^[\w.:@+-]{1,80}$")


def _id(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    return text if _ID.fullmatch(text) else ""


def _text(value: Any, limit: int) -> str:
    from ..textclean import clean_text

    return " ".join(clean_text(value if isinstance(value, str) else "").split())[:limit]


@dataclass
class Owner:
    """The account a chat is paired with: its user id, the direct chat with the bot, how
    it's shown, since when, and its workspace (where the app has one)."""

    user: str
    chat: str
    name: str = ""
    since: str = ""
    team: str = ""


def _owner(raw: Any) -> Owner | None:
    if not isinstance(raw, dict):
        return None
    user, chat = _id(raw.get("user")), _id(raw.get("chat"))
    if not user or not chat:
        return None
    return Owner(
        user,
        chat,
        _text(raw.get("name"), 80),
        _text(raw.get("since"), 25),
        _id(raw.get("team")),
    )


class ChannelState:
    def __init__(self, path: Path, clock=datetime.now) -> None:
        self.path = path
        self.clock = clock
        self.owners: dict[str, Owner] = {}
        self.bots: dict[str, dict[str, str]] = {}  # the bot each token belongs to: id, name
        self.offsets: dict[str, int] = {}  # telegram: the next update to fetch
        self.audit: deque[dict[str, str]] = deque(maxlen=AUDIT_KEEP)
        self.unreadable = ""
        self.dirty = False
        self._load()

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("channels: %s can't be read (%s); leaving it be", self.path.name, exc)
            return
        if not isinstance(data, dict):
            return
        owners = data.get("owners")
        for name in PAIRED:
            owner = _owner(owners.get(name)) if isinstance(owners, dict) else None
            if owner is not None:
                self.owners[name] = owner
        bots = data.get("bots")
        for name in PAIRED:
            raw = bots.get(name) if isinstance(bots, dict) else None
            if isinstance(raw, dict) and _id(raw.get("id")):
                self.bots[name] = {"id": _id(raw.get("id")), "name": _text(raw.get("name"), 80)}
        offsets = data.get("offsets")
        if isinstance(offsets, dict):
            value = offsets.get("telegram")
            if type(value) is int and 0 <= value < 2**53:
                self.offsets["telegram"] = value
        audit = data.get("audit")
        for item in (audit if isinstance(audit, list) else [])[-AUDIT_KEEP:]:
            if isinstance(item, dict):
                entry = {k: _text(item.get(k), 40) for k in ("at", "channel", "who", "kind")}
                if entry["at"] and entry["channel"] and entry["kind"]:
                    self.audit.append(entry)

    def snapshot(self) -> dict[str, Any]:
        """Everything to save, as plain data (taken on the event loop, written elsewhere)."""
        return {
            "version": VERSION,
            "owners": {k: asdict(v) for k, v in self.owners.items()},
            "bots": {k: dict(v) for k, v in self.bots.items()},
            "offsets": dict(self.offsets),
            "audit": list(self.audit),
        }

    def write(self, snapshot: dict[str, Any]) -> None:
        """Save a snapshot (any thread). OSError when it can't be written."""
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, snapshot, indent=1)

    def save(self) -> None:
        self.write(self.snapshot())
        self.dirty = False

    def log(self, channel: str, who: str, kind: str) -> dict[str, str]:
        """One line of the audit log: who (you, someone else), when, what kind."""
        entry = {
            "at": self.clock().isoformat(timespec="seconds"),
            "channel": channel,
            "who": who,
            "kind": kind,
        }
        self.audit.append(entry)
        self.dirty = True
        return entry
