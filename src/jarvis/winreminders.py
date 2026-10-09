"""Reminders on a PC, where there is no Reminders app for JARVIS to ask: a to-do list of its own, with lists,
due dates and due times, notes and priorities, that says each reminder aloud when its time comes.

It speaks reminders_desk's language (open, add, complete, delete) and reminders_kit's (list), the same
commands and the same rows the EventKit helpers give on a Mac, so the tools, the briefing, the evening
wrap-up and the second brain read it the same way.

- A reminder with a date and a time ("2026-10-09T15:00") is said at that time, by due_now(), which the
  hub's loop asks every half minute: once, and not at all for one more than a day late (it is read out
  as overdue in the briefing instead). One with a date only is never said at a time of day; the briefing
  has it that morning.
- The file (reminders.json beside the app's data) is read afresh by each call.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore, osplat

log = logging.getLogger("jarvis")

DEFAULT_LIST = "Reminders"
MAX_REMINDERS = 3000
MAX_OPEN = 500
MAX_LISTS = 20
COMPLETED_DAYS = 30
LATE_HOURS = 24  # a timed reminder this late is not said any more: it is overdue
NOT_THERE = "That reminder isn't there any more (or changed just now)."


def folder() -> Path:
    return osplat.app_support() / "Reminders"


class Reminders:
    def __init__(self, path: Path | None = None, now: Any = datetime.now) -> None:
        self.path = path or folder() / "reminders.json"
        self.now = now

    # ── the file ──

    def _load(self) -> dict[str, Any]:
        data = jsonstore.load_json(self.path, dict) or {}
        rows = [r for r in data.get("reminders") or [] if isinstance(r, dict) and r.get("id")]
        lists = [str(x) for x in data.get("lists") or [] if isinstance(x, str) and x]
        alerted = data.get("alerted") if isinstance(data.get("alerted"), dict) else {}
        if DEFAULT_LIST not in lists:
            lists.insert(0, DEFAULT_LIST)
        return {"reminders": rows, "lists": lists, "alerted": alerted}

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        cutoff = (self.now() - timedelta(days=COMPLETED_DAYS * 3)).isoformat()
        kept = [
            r
            for r in data["reminders"]
            if not r.get("completed") or str(r.get("completed_at") or "") >= cutoff
        ]
        ids = {r["id"] for r in kept}
        data["alerted"] = {k: v for k, v in data["alerted"].items() if k in ids}
        jsonstore.save_json(self.path, {**data, "reminders": kept[-MAX_REMINDERS:]})

    # ── what reminders_desk and reminders_kit ask ──

    def open_items(self) -> dict[str, Any]:
        data = self._load()
        rows = [r for r in data["reminders"] if not r.get("completed")]
        rows.sort(key=lambda r: (r.get("due") or "9999", r.get("title") or ""))
        return {
            "reminders": rows[:MAX_OPEN],
            "lists": [
                {"title": name, "default": name == DEFAULT_LIST, "writable": True}
                for name in data["lists"]
            ],
        }

    def kept(self) -> dict[str, Any]:
        """Open reminders and the ones done lately (reminders_kit's list, for the second brain)."""
        from .reminders_kit import keep

        return {"reminders": keep(self._load()["reminders"], self.now())}

    def add(self, spec: dict[str, Any]) -> dict[str, Any]:
        data = self._load()
        if len([r for r in data["reminders"] if not r.get("completed")]) >= MAX_REMINDERS:
            return {"error": "There are too many open reminders; tick some off first."}
        wanted = str(spec.get("list") or "").strip()
        name = DEFAULT_LIST
        if wanted:
            name = next((x for x in data["lists"] if x.casefold() == wanted.casefold()), wanted)
            if name not in data["lists"]:  # a new list is made the first time something goes on it
                if len(data["lists"]) >= MAX_LISTS:
                    return {"error": "There are too many lists; use one of the ones there."}
                data["lists"].append(name)
        stamp = self.now().isoformat(timespec="seconds")
        item = {
            "id": str(uuid.uuid4()),
            "title": str(spec["title"]),
            "notes": str(spec.get("notes") or "")[:4000],
            "list": name,
            "due": str(spec.get("due") or ""),
            "completed": False,
            "completed_at": "",
            "created": stamp,
            "modified": stamp,
            "priority": int(spec.get("priority") or 0),
            "url": "",
        }
        data["reminders"].append(item)
        self._save(data)
        return {"added": item}

    def _find(self, data: dict[str, Any], reminder_id: str) -> dict[str, Any] | None:
        return next((r for r in data["reminders"] if r["id"] == reminder_id), None)

    def complete(self, reminder_id: str) -> dict[str, Any]:
        data = self._load()
        item = self._find(data, reminder_id)
        if item is None:
            return {"error": NOT_THERE}
        stamp = self.now().isoformat(timespec="seconds")
        item.update({"completed": True, "completed_at": stamp, "modified": stamp})
        self._save(data)
        return {"completed": item}

    def delete(self, reminder_id: str) -> dict[str, Any]:
        data = self._load()
        item = self._find(data, reminder_id)
        if item is None:
            return {"error": NOT_THERE}
        data["reminders"].remove(item)
        self._save(data)
        return {"deleted": item}

    # ── saying them at their time ──

    def due_now(self) -> list[dict[str, Any]]:
        """The timed reminders whose time has come and that have not been said yet (each is marked
        said, so it is said once). One more than LATE_HOURS late is marked and left to the briefing."""
        data = self._load()
        now = self.now()
        out: list[dict[str, Any]] = []
        changed = False
        for item in data["reminders"]:
            due = str(item.get("due") or "")
            if item.get("completed") or "T" not in due or data["alerted"].get(item["id"]) == due:
                continue
            try:
                at = datetime.fromisoformat(due)
            except ValueError:
                continue
            if at > now:
                continue
            data["alerted"][item["id"]] = due
            changed = True
            if now - at <= timedelta(hours=LATE_HOURS):
                out.append(item)
        if changed:
            self._save(data)
        return out


def run(argv: list[str], reminders: Reminders | None = None) -> dict[str, Any]:
    """One reminders_desk (or reminders_kit) command, answered as the EventKit helper answers it."""
    desk = reminders or Reminders()
    args = list(argv)
    try:
        if args[:1] == ["open"] and args[1:] in ([], ["--no-ask"]):
            return desk.open_items()
        if args == ["list"]:
            return desk.kept()
        if len(args) == 2 and args[0] == "add":
            spec = json.loads(args[1])
            return (
                desk.add(spec)
                if isinstance(spec, dict) and spec.get("title")
                else {"error": "a reminder needs a title"}
            )
        if len(args) == 2 and args[0] == "complete":
            return desk.complete(args[1])
        if len(args) == 2 and args[0] == "delete":
            return desk.delete(args[1])
        return {"error": "usage: open | list | add <json> | complete <id> | delete <id>"}
    except (ValueError, KeyError) as exc:
        return {"error": str(exc)}
    except Exception as exc:  # a damaged file, a full disk: said, never a traceback
        log.warning("reminders: %s", type(exc).__name__)
        return {"error": f"Reminders couldn't be reached ({type(exc).__name__})."}
