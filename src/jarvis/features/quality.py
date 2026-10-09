"""Jarvis's own quality numbers, kept and shown in the Health pane, so they can be held to:

- how fast Jarvis answers: from the end of the owner's words (listening ends) to Jarvis's
  first spoken word (speaking), the median and the slowest one in ten of the last
  LATENCY_KEEP answers; and, hands-free, from the moment the request with "Jarvis" in it
  was heard (hub.add_wake_sink) to the first spoken word;
- crash-free days: a day the backend ended without quitting cleanly (a marker left from the
  last run, found at startup) counts as a crash on that day; the rest of the days since
  counting began are crash-free;
- lost chats, which should stay zero: Eden Code's kept chats as the last run knew them,
  any of which is missing from disk at startup;
- heads-ups a day: what Jarvis interrupted with, lately (fewer, better ones is the aim),
  and per kind how often the owner opened its card or dismissed it. A kind that's nearly
  always dismissed (QUIET_AFTER shown, QUIET_SHARE of them dismissed, almost none opened)
  is quieted (a notify gate) and listed in the Health pane, where one click brings it back
  (quality_unquiet {kind}); what's urgent (a call, a conversation, a session's) never is.

Kept in quality.json beside the settings. No Claude calls; nothing leaves the Mac.
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import json
import os
import statistics
import threading
import time
import weakref
from datetime import date, timedelta
from typing import Any

from .. import jsonstore

LATENCY_KEEP = 200
SLOW_LIMIT = 60.0  # seconds: past this the wait wasn't for an answer
SAVE_EVERY = 600.0
DAYS_SHOWN = 30
QUIET_AFTER = 10  # heads-ups of a kind shown before it can be quieted
QUIET_SHARE = 0.7  # of those dismissed
OPENED_FEW = 0.1  # and at most this share opened
NEVER_QUIET = {"delegate", "call", "voicemail", "task", "meeting", "leave"}


class Quality:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.path = hub.feature_path("quality.json")
        self.marker = hub.feature_path("quality.running")
        self.sessions_dir = hub.feature_path("code_sessions")
        data = {}
        with contextlib.suppress(jsonstore.Unreadable):
            data = jsonstore.load_json(self.path, dict) or {}
        self.latency: list[float] = [float(x) for x in data.get("latency", [])][-LATENCY_KEEP:]
        self.wake: list[float] = [float(x) for x in data.get("wake", [])][-LATENCY_KEEP:]
        self.woke_at: float | None = None
        self.days: dict[str, dict[str, int]] = dict(data.get("days", {}))
        self.since: str = data.get("since") or date.today().isoformat()
        self.lost: int = int(data.get("lost", 0))
        self.known: list[str] = list(data.get("chat_keys", []))
        # kind -> {"shown", "opened", "dismissed"}, and the kinds quieted / brought back
        self.kinds: dict[str, dict[str, int]] = dict(data.get("kinds", {}))
        self.quiet: list[str] = list(data.get("quiet", []))
        self.unquiet: list[str] = list(data.get("unquiet", []))
        self.heard_at: float | None = None
        # What this run last wrote (as JSON) and the file it made: a save of the same, to
        # the same file, is skipped.
        self._saved_text = ""
        self._saved_stamp: tuple[int, int, int] | None = None
        self._save_lock = threading.Lock()

    def _day(self) -> dict[str, int]:
        return self.days.setdefault(date.today().isoformat(), {"crashes": 0, "headsups": 0})

    # ── at startup and at a clean quit ──

    def started(self) -> None:
        if self.marker.exists():  # the last run never quit cleanly
            self._day()["crashes"] += 1
        with contextlib.suppress(OSError):
            self.marker.write_text(str(time.time()))
        if self.known:
            now = set(self.chat_keys())
            lost = len([k for k in self.known if k not in now])
            self.lost += lost
        self.save()  # (only once there's something: a crash, a chat, a number)

    def quit_cleanly(self) -> None:
        self.save()
        with contextlib.suppress(OSError):
            self.marker.unlink()

    def chat_keys(self) -> list[str]:
        try:
            return sorted(
                p.stem for p in self.sessions_dir.glob("*.json") if p.stem != "remembered"
            )
        except OSError:
            return []

    def save(self) -> None:
        if not (self.latency or self.days or self.lost or self.kinds or self.chat_keys()):
            return  # nothing measured yet
        self.known = self.chat_keys()
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        self.days = {d: v for d, v in self.days.items() if d >= cutoff}
        data = {
            "latency": self.latency,
            "wake": self.wake,
            "days": self.days,
            "since": self.since,
            "lost": self.lost,
            "chat_keys": self.known,
            "kinds": self.kinds,
            "quiet": self.quiet,
            "unquiet": self.unquiet,
        }
        # The keeper's save every ten minutes, with nothing new since the last one (an idle
        # Mac, a night): the file already holds it, so it isn't flushed to the disk again.
        text = json.dumps(data)
        with self._save_lock:  # (the keeper saves in a thread): the file noted is its own
            saved = self._saved_stamp
            if text == self._saved_text and saved is not None and _stamp(self.path) == saved:
                return
            with contextlib.suppress(OSError):
                jsonstore.save_json(self.path, data)
                self._saved_text, self._saved_stamp = text, _stamp(self.path)

    async def keeper(self) -> None:
        while True:
            await asyncio.sleep(SAVE_EVERY)
            await asyncio.to_thread(self.save)

    # ── what's heard ──

    def state(self, event: dict[str, Any]) -> None:
        value = event.get("value")
        if value in ("transcribing", "thinking") and self.heard_at is None:
            self.heard_at = time.monotonic()  # the owner's words have ended
        if value == "speaking" and self.woke_at is not None:
            waited = time.monotonic() - self.woke_at
            self.woke_at = None
            if 0 <= waited <= SLOW_LIMIT:
                self.wake.append(round(waited, 2))
                del self.wake[:-LATENCY_KEEP]
        if value == "speaking" and self.heard_at is not None:
            waited = time.monotonic() - self.heard_at
            self.heard_at = None
            if 0 <= waited <= SLOW_LIMIT:
                self.latency.append(round(waited, 2))
                del self.latency[:-LATENCY_KEEP]
        elif value in ("idle", "listening"):
            self.heard_at = None
            if value == "idle":
                self.woke_at = None  # (answered without a word)

    def woke(self, _heard: str, _command: str) -> None:
        """hub.add_wake_sink: a hands-free request with Jarvis's name in it was heard."""
        self.woke_at = time.monotonic()

    def headsup(self, alert: Any) -> None:
        self._day()["headsups"] += 1
        kind = str(getattr(alert, "kind", "") or "")
        if kind:
            self.kinds.setdefault(kind, {"shown": 0, "opened": 0, "dismissed": 0})["shown"] += 1

    def reaction(self, kind: str, action: str) -> None:
        """The window: a heads-up's card was opened or dismissed."""
        if action not in ("opened", "dismissed") or not kind:
            return
        counts = self.kinds.setdefault(kind, {"shown": 0, "opened": 0, "dismissed": 0})
        counts[action] += 1
        self._tune(kind)

    def _tune(self, kind: str) -> None:
        c = self.kinds.get(kind) or {}
        shown = max(c.get("shown", 0), c.get("opened", 0) + c.get("dismissed", 0))
        if kind in NEVER_QUIET or kind in self.quiet or kind in self.unquiet or shown < QUIET_AFTER:
            return
        if (
            c.get("dismissed", 0) >= QUIET_SHARE * shown
            and c.get("opened", 0) <= OPENED_FEW * shown
        ):
            self.quiet.append(kind)
            self.save()

    def gate(self, alert: Any) -> bool:
        """hub.add_notify_gate: False holds back a quieted kind."""
        return str(getattr(alert, "kind", "") or "") not in self.quiet

    def unquiet_kind(self, kind: str) -> None:
        if kind in self.quiet:
            self.quiet.remove(kind)
        if kind not in self.unquiet:
            self.unquiet.append(kind)  # (the owner's say: never quieted again by itself)
        self.kinds.pop(kind, None)
        self.save()

    # ── the Health pane ──

    def public(self) -> dict[str, Any]:
        today = date.today()
        start = max(date.fromisoformat(self.since), today - timedelta(days=DAYS_SHOWN - 1))
        days = (today - start).days + 1
        crashed = sum(
            1 for d, v in self.days.items() if d >= start.isoformat() and v.get("crashes")
        )
        recent = [
            v.get("headsups", 0)
            for d, v in self.days.items()
            if d >= (today - timedelta(days=6)).isoformat()
        ]
        lat = sorted(self.latency)
        wake = sorted(self.wake)
        return {
            "answer_median": round(statistics.median(lat), 2) if lat else None,
            "answer_p90": lat[min(len(lat) - 1, int(len(lat) * 0.9))] if lat else None,
            "answers": len(lat),
            "wake_median": round(statistics.median(wake), 2) if wake else None,
            "wake_answers": len(wake),
            "crash_free_days": days - crashed,
            "days": days,
            "lost_chats": self.lost,
            "chats_kept": len(self.known),
            "headsups_per_day": round(sum(recent) / max(1, len(recent)), 1) if recent else 0,
            "useful": {
                k: {
                    "shown": v.get("shown", 0),
                    "opened": v.get("opened", 0),
                    "dismissed": v.get("dismissed", 0),
                }
                for k, v in sorted(self.kinds.items())
            },
            "quiet": list(self.quiet),
        }


def _stamp(path: Any) -> tuple[int, int, int] | None:
    """Which file is at path, and as last written: a save swaps in a new one (a new inode),
    an edit changes its size or time. None when there's none."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return info.st_ino, info.st_size, info.st_mtime_ns


def install(hub: Any) -> None:
    desk = Quality(hub)
    hub.quality = desk
    desk.started()
    mine = weakref.ref(desk)  # (never what keeps a hub alive)
    atexit.register(lambda: (d := mine()) is not None and d.quit_cleanly())
    hub.add_event_sink(("state",), desk.state)
    hub.add_notify_sink(desk.headsup)
    hub.add_wake_sink(desk.woke)
    hub.register_loop("quality_keeper", desk.keeper)
    hub.add_notify_gate(desk.gate)
    hub.register_command(
        "quality_unquiet", lambda msg: desk.unquiet_kind(str(msg.get("kind") or ""))
    )
