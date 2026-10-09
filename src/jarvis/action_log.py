"""JARVIS's action log: every tool call of its own conversation, kept on this Mac per day
(action_log/<YYYY-MM-DD>.jsonl beside prefs.json) for LOG_DAYS days, and searchable.

Each entry is when, the tool, its label (as the Activity drawer says it), a short summary
with nothing private in it, and how it ended (done, failed, stopped). The summary is only
ever a few words from a fixed set of the tool's own arguments: an app's or a shortcut's
name, a site's host, an Eden Code project's folder, a model or a setting. Never a message,
an email, a note, a file's contents, a search or anyone's name.

A day's file only grows (a line per call), at most DAY_MAX lines a day, so a runaway loop
can't fill the disk; files older than LOG_DAYS are deleted. Lines that can't be read (a torn
write, a hand edit) are skipped, never an error. The reads and writes are small but they're
files: callers run them in a thread.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from .brain import url_host
from .textclean import clean_text

log = logging.getLogger("jarvis")

LOG_DAYS = 90
DAY_MAX = 5000  # entries a day, at most
SUMMARY_CHARS = 60
LABEL_CHARS = 60
SEARCH_LIMIT = 200
OUTCOMES = ("done", "failed", "stopped")
_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")


def _line(value: Any, limit: int) -> str:
    text = " ".join(clean_text(value).split()) if isinstance(value, str) else ""
    return text[:limit]


def _name(value: Any) -> str:
    return _line(value, 40)


def _host(value: Any) -> str:
    host = url_host(str(value or "")) or ""
    return host.removeprefix("www.")[:60]


def _folder(value: Any) -> str:
    text = str(value or "").strip().rstrip("/")
    return _name(text.rsplit("/", 1)[-1]) if text else ""


def _word(value: Any) -> str:
    if isinstance(value, bool):
        return "on" if value else "off"
    if not isinstance(value, str | int | float):
        return ""
    text = str(value).strip()
    return text[:20] if re.fullmatch(r"[\w .-]{1,20}", text) else ""


def _tool(value: Any) -> str:
    text = value if isinstance(value, str) else ""
    return text[:60] if re.fullmatch(r"[\w-]{1,60}", text) else ""


# The arguments a tool's summary may show, and how each is made safe. Anything not listed
# (a message, an email, a search, a note, a file, a calendar event, a person) isn't shown.
SAFE_ARGS: dict[str, tuple[tuple[str, Any], ...]] = {
    "open_app": (("name", _name),),
    "quit_app": (("name", _name),),
    "snap_window": (("app", _name), ("position", _word)),
    "media_control": (("action", _word),),
    "set_volume": (("level", _word),),
    "run_shortcut": (("name", _name),),
    "open_url": (("url", _host),),
    "browser_open": (("url", _host),),
    "WebFetch": (("url", _host),),
    "switch_model": (("model", _word),),
    "set_personality": (("persona", _word), ("humor", _word)),
    "set_hands_free": (("enabled", _word),),
    "run_claude_code": (("directory", _folder),),
    "resume_claude_session": (("directory", _folder),),
    "voice_code": (("directory", _folder),),
    "set_look": (("look", _word),),
    "show_panel": (("panel", _word),),
    "set_interruptions": (("mode", _word),),
}


def short_name(tool_name: str) -> str:
    return str(tool_name or "").split("__")[-1]


def summary(tool_name: str, tool_input: Any) -> str:
    """A few words about a call that say nothing private (see SAFE_ARGS)."""
    args = tool_input if isinstance(tool_input, dict) else {}
    parts = []
    for key, clean in SAFE_ARGS.get(short_name(tool_name), ()):
        value = clean(args.get(key)) if key in args else ""
        if value:
            parts.append(value)
    return ", ".join(parts)[:SUMMARY_CHARS]


def clean_entry(raw: Any) -> dict[str, str] | None:
    """An entry as it's kept and shown, or None when it can't be one. An app's action over
    Jarvis's MCP endpoint (eden_actions) also carries its source (the app, as a slug: "eden")
    and a ref (the id of what's kept to undo it); JARVIS's own entries have neither."""
    if not isinstance(raw, dict):
        return None
    at = raw.get("t")
    try:
        when = datetime.fromisoformat(str(at))
    except (TypeError, ValueError):
        return None
    outcome = raw.get("outcome") if raw.get("outcome") in OUTCOMES else "done"
    entry = {
        "t": when.replace(tzinfo=None).isoformat(timespec="seconds"),
        "tool": _tool(raw.get("tool")),
        "label": _line(raw.get("label"), LABEL_CHARS) or "Used a tool",
        "summary": _line(raw.get("summary"), SUMMARY_CHARS),
        "outcome": outcome,
    }
    for key, shape in (("source", _SOURCE), ("ref", _REF)):
        value = raw.get(key)
        if isinstance(value, str) and shape.fullmatch(value):
            entry[key] = value
    return entry


_SOURCE = re.compile(r"[a-z0-9-]{1,30}")
_REF = re.compile(r"[\w-]{1,40}")


class ActionLog:
    def __init__(self, folder: Path, clock: Any = datetime.now) -> None:
        self.folder = folder
        self.clock = clock
        self._counts: dict[date, int] = {}  # lines in each day's file, once counted

    def _file(self, day: date) -> Path:
        return self.folder / f"{day.isoformat()}.jsonl"

    def days(self) -> list[date]:
        """The days with a log, newest first."""
        try:
            names = os.listdir(self.folder)
        except OSError:
            return []
        found = []
        for name in names:
            match = _DAY_FILE.match(name)
            if match:
                try:
                    found.append(date.fromisoformat(match.group(1)))
                except ValueError:
                    continue
        return sorted(found, reverse=True)

    def add(self, entries: list[dict[str, Any]]) -> int:
        """Append entries (each with its own time) to their days' files; how many were kept.
        A day already at DAY_MAX keeps no more."""
        kept = 0
        by_day: dict[date, list[str]] = {}
        for raw in entries:
            entry = clean_entry(raw)
            if entry is not None:
                by_day.setdefault(datetime.fromisoformat(entry["t"]).date(), []).append(
                    json.dumps(entry, ensure_ascii=False)
                )
        if not by_day:
            return 0
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        for day, lines in by_day.items():
            path = self._file(day)
            if day not in self._counts:
                self._counts[day] = _count_lines(path)
            room = max(0, DAY_MAX - self._counts[day])
            if not room:
                continue
            # Readable by the owner alone, made so as it's created (never a umask change,
            # which would reach every thread's files).
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with open(fd, "a", encoding="utf-8") as out:
                out.write("".join(line + "\n" for line in lines[:room]))
            self._counts[day] += min(room, len(lines))
            kept += min(room, len(lines))
        return kept

    def day(self, day: date) -> list[dict[str, str]]:
        """A day's entries, oldest first."""
        try:
            text = self._file(day).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []
        out = []
        for line in text.splitlines():
            try:
                entry = clean_entry(json.loads(line))
            except ValueError:
                continue
            if entry is not None:
                out.append(entry)
        return out

    def search(
        self, query: str = "", before: str = "", limit: int = SEARCH_LIMIT, source: str = ""
    ) -> list[dict]:
        """Entries whose label, summary or tool hold every word of query (any case), newest
        first, older than before (an entry's "t") when given; at most limit. source: only
        that app's ("eden"), "" for every entry."""
        words = str(query or "").casefold().split()
        found: list[dict[str, str]] = []
        for day in self.days():
            if before and day.isoformat() > before[:10]:
                continue
            for entry in reversed(self.day(day)):
                if before and entry["t"] >= before:
                    continue
                if source and entry.get("source") != source:
                    continue
                text = f"{entry['label']} {entry['summary']} {entry['tool']}".casefold()
                if all(w in text for w in words):
                    found.append(entry)
                    if len(found) >= limit:
                        return found
        return found

    def prune(self) -> int:
        """Delete the days older than LOG_DAYS; how many went."""
        oldest = self.clock().date() - timedelta(days=LOG_DAYS - 1)
        gone = 0
        for day in self.days():
            if day < oldest:
                try:
                    self._file(day).unlink()
                    gone += 1
                except OSError:
                    continue
        return gone


def _count_lines(path: Path) -> int:
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0
