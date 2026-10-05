"""Apple Reminders through EventKit, to work with them: what's open, adding one, ticking one
off, deleting one. (reminders_kit.py reads them for the second brain and never changes
anything.)

EventKit answers on the main run loop, so like calendar_kit this runs as a short helper:

    python -m jarvis.reminders_desk open [--no-ask]
    python -m jarvis.reminders_desk add <json: title, list, due, notes, priority>
    python -m jarvis.reminders_desk complete <id>
    python -m jarvis.reminders_desk delete <id>

Each prints one JSON object: {"reminders": [...], "lists": [...]}, {"added": {...}},
{"completed": {...}}, {"deleted": {...}} or {"error": "..."}. macOS asks once for Reminders
access on behalf of the J.A.R.V.I.S. app; with --no-ask (the briefing's own look, which the
owner didn't ask for) a Mac that hasn't been asked yet is left unasked. Which reminder a
request means is decided here in the app (choose); the helper changes exactly that one, by
its id.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from .reminders_kit import NO_ACCESS

if TYPE_CHECKING:  # only for the lock's annotation (see _run)
    import asyncio

NOT_ASKED = "not asked"  # --no-ask on a Mac that hasn't answered the access question yet
MAX_TITLE = 200
MAX_NOTES = 1000
MAX_OPEN = 500  # open reminders read at once, soonest due first
FETCH_SECONDS = 60
PRIORITIES = {"": 0, "none": 0, "high": 1, "medium": 5, "low": 9}
_DUE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$")


# ── in the helper process ──


def _store(ask: bool = True):
    """The EventKit store, or None without access (left unasked when ask is False)."""
    import EventKit

    from .reminders_kit import _authorized

    store = EventKit.EKEventStore.alloc().init()
    if not ask:
        status = EventKit.EKEventStore.authorizationStatusForEntityType_(
            EventKit.EKEntityTypeReminder
        )
        if status == 0:
            return NOT_ASKED
        return store if status == 3 else None
    return store if _authorized(store) else None


def _lists(store) -> list[dict[str, Any]]:
    import EventKit

    default = store.defaultCalendarForNewReminders()
    default_id = str(default.calendarIdentifier()) if default is not None else ""
    out = []
    for calendar in store.calendarsForEntityType_(EventKit.EKEntityTypeReminder) or []:
        out.append(
            {
                "title": str(calendar.title() or ""),
                "default": str(calendar.calendarIdentifier()) == default_id,
                "writable": bool(calendar.allowsContentModifications()),
            }
        )
    return out


def open_items(ask: bool = True) -> dict[str, Any]:
    from Foundation import NSDate, NSRunLoop

    from .reminders_kit import row

    store = _store(ask)
    if isinstance(store, str):
        return {"error": NOT_ASKED}
    if store is None:
        return {"error": NO_ACCESS}
    done: dict[str, Any] = {}

    def fetched(reminders):
        done["items"] = list(reminders or [])

    predicate = store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(
        None, None, None
    )
    store.fetchRemindersMatchingPredicate_completion_(predicate, fetched)
    end = time.time() + FETCH_SECONDS
    while "items" not in done and time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))
    if "items" not in done:
        return {"error": "Reminders took too long to answer."}
    rows = []
    for reminder in done["items"]:
        try:
            rows.append(row(reminder))
        except Exception:  # an odd record: skip it
            continue
    rows.sort(key=lambda r: (r.get("due") or "9999", r.get("title") or ""))
    return {"reminders": rows[:MAX_OPEN], "lists": _lists(store)}


def _components(due: str):
    """A due date (2026-10-01) or date and time (2026-10-01T15:00) as NSDateComponents."""
    from Foundation import NSDateComponents

    moment = datetime.fromisoformat(due)
    parts = NSDateComponents.alloc().init()
    parts.setYear_(moment.year)
    parts.setMonth_(moment.month)
    parts.setDay_(moment.day)
    if "T" in due:
        parts.setHour_(moment.hour)
        parts.setMinute_(moment.minute)
    return parts


def add(spec: dict[str, Any]) -> dict[str, Any]:
    import EventKit
    from Foundation import NSDate

    from .reminders_kit import row

    store = _store()
    if store is None:
        return {"error": NO_ACCESS}
    wanted = str(spec.get("list") or "").strip().casefold()
    calendar = store.defaultCalendarForNewReminders()
    if wanted:
        found = [
            c
            for c in store.calendarsForEntityType_(EventKit.EKEntityTypeReminder) or []
            if str(c.title() or "").strip().casefold() == wanted
        ]
        if not found:
            return {"error": f"There's no Reminders list called “{spec.get('list')}”."}
        calendar = found[0]
    if calendar is None:
        return {"error": "Reminders has no list to add to."}
    if not calendar.allowsContentModifications():
        return {"error": f"The {calendar.title()} list can't be changed from here."}
    reminder = EventKit.EKReminder.reminderWithEventStore_(store)
    reminder.setTitle_(spec["title"])
    reminder.setCalendar_(calendar)
    if spec.get("notes"):
        reminder.setNotes_(spec["notes"])
    if spec.get("priority"):
        reminder.setPriority_(int(spec["priority"]))
    due = str(spec.get("due") or "")
    if due:
        reminder.setDueDateComponents_(_components(due))
        if "T" in due:  # a time: Reminders itself says it then, on the Mac and the phone
            at = datetime.fromisoformat(due).timestamp()
            alarm = EventKit.EKAlarm.alarmWithAbsoluteDate_(
                NSDate.dateWithTimeIntervalSince1970_(at)
            )
            reminder.addAlarm_(alarm)
    ok, error = store.saveReminder_commit_error_(reminder, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Reminders didn't save it ({why})."}
    return {"added": row(reminder)}


def _one(store, reminder_id: str):
    import EventKit

    item = store.calendarItemWithIdentifier_(reminder_id)
    if item is None or not isinstance(item, EventKit.EKReminder):
        return None
    return item


def complete(reminder_id: str) -> dict[str, Any]:
    from .reminders_kit import row

    store = _store()
    if store is None:
        return {"error": NO_ACCESS}
    reminder = _one(store, reminder_id)
    if reminder is None:
        return {"error": "That reminder isn't there any more (or changed just now)."}
    reminder.setCompleted_(True)
    ok, error = store.saveReminder_commit_error_(reminder, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Reminders didn't save it ({why})."}
    return {"completed": row(reminder)}


def delete(reminder_id: str) -> dict[str, Any]:
    from .reminders_kit import row

    store = _store()
    if store is None:
        return {"error": NO_ACCESS}
    reminder = _one(store, reminder_id)
    if reminder is None:
        return {"error": "That reminder isn't there any more (or changed just now)."}
    gone = row(reminder)
    calendar = reminder.calendar()
    if calendar is not None and not calendar.allowsContentModifications():
        return {"error": f"The {calendar.title()} list can't be changed from here."}
    ok, error = store.removeReminder_commit_error_(reminder, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Reminders didn't delete it ({why})."}
    return {"deleted": gone}


def main() -> None:
    args = sys.argv[1:]
    try:
        if args[:1] == ["open"] and args[1:] in ([], ["--no-ask"]):
            result = open_items(ask=args[1:] != ["--no-ask"])
        elif len(args) == 2 and args[0] == "add":
            result = add(clean_new(json.loads(args[1])))
        elif len(args) == 2 and args[0] == "complete":
            result = complete(args[1])
        elif len(args) == 2 and args[0] == "delete":
            result = delete(args[1])
        else:
            result = {"error": "usage: open [--no-ask] | add <json> | complete <id> | delete <id>"}
    except ValueError as exc:  # a reminder that can't be made as asked
        result = {"error": str(exc)}
    except Exception as exc:  # EventKit missing or failing: said, never a traceback
        result = {"error": f"Reminders couldn't be reached ({type(exc).__name__})."}
    print(json.dumps(result), flush=True)


# ── in the app ──


def clean_new(spec: Any, today: date | None = None) -> dict[str, Any]:
    """A reminder to add, checked: a title (one line), a list's name, a due date
    (YYYY-MM-DD) or date and time (YYYY-MM-DDTHH:MM), notes and a priority. ValueError
    says what's wrong."""
    from .textclean import clean_text

    if not isinstance(spec, dict):
        raise ValueError("a reminder needs a title")
    title = " ".join(clean_text(str(spec.get("title") or "")).split())[:MAX_TITLE]
    if not title:
        raise ValueError("a reminder needs a title")
    listed = " ".join(clean_text(str(spec.get("list") or "")).split())[:80]
    notes = clean_text(str(spec.get("notes") or "")).strip()[:MAX_NOTES]
    due = str(spec.get("due") or "").strip()
    if due:
        if not _DUE.match(due):
            raise ValueError("due must be YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time")
        try:
            moment = datetime.fromisoformat(due)
        except ValueError:
            raise ValueError("due isn't a real date") from None
        if moment.date() < (today or date.today()) - timedelta(days=1):
            raise ValueError("that date has passed")
    priority = spec.get("priority", 0)
    if isinstance(priority, str):
        if priority.strip().lower() not in PRIORITIES:
            raise ValueError("priority is high, medium or low")
        priority = PRIORITIES[priority.strip().lower()]
    if priority not in (0, 1, 5, 9):
        raise ValueError("priority is high, medium or low")
    return {"title": title, "list": listed, "due": due, "notes": notes, "priority": priority}


def choose(rows: list[dict[str, Any]], words: str, listed: str = "") -> list[dict[str, Any]]:
    """Of the open reminders, the ones a request means: its id, else the title exactly
    (ignoring case and spacing), else those whose title holds the words asked for or is
    held by them ("milk" for "Buy milk"). A list named narrows it. Several back means ask
    which; it never picks one of them itself."""

    def plain(text: Any) -> str:
        return " ".join(str(text or "").casefold().split())

    want, where = plain(words), plain(listed)
    rows = [r for r in rows if not where or plain(r.get("list")) == where]
    by_id = [r for r in rows if r.get("id") and r["id"] == str(words).strip()]
    if by_id or not want:
        return by_id
    exact = [r for r in rows if plain(r.get("title")) == want]
    if exact:
        return exact

    def holds(text: str, part: str) -> bool:  # whole words ("rent" is never in "parent")
        return bool(part) and bool(re.search(rf"(?<![a-z0-9]){re.escape(part)}(?![a-z0-9])", text))

    return [
        r
        for r in rows
        if (title := plain(r.get("title"))) and (holds(title, want) or holds(want, title))
    ]


def due_at(row: dict[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(row.get("due") or ""))
    except ValueError:
        return None


def timed(row: dict[str, Any]) -> bool:
    return "T" in str(row.get("due") or "")


def _clock(when: datetime) -> str:
    return when.strftime("%-I:%M %p").replace(":00 ", " ")


def due_words(row: dict[str, Any], now: datetime) -> str:
    """When a reminder is due, the way it's said: "due today at 3 PM", "overdue since
    Tuesday", "due tomorrow", "due Friday 2 October"."""
    at = due_at(row)
    if at is None:
        return ""
    days = (at.date() - now.date()).days
    at_time = f" at {_clock(at)}" if timed(row) else ""
    late = at < now if timed(row) else days < 0
    if late:
        if days == 0:
            return f"overdue since {_clock(at)}"
        if days == -1:
            return "overdue since yesterday"
        return f"overdue since {at:%A}" if days > -7 else f"overdue since {at:%-d %B}"
    if days == 0:
        return f"due today{at_time}"
    if days == 1:
        return f"due tomorrow{at_time}"
    if days < 7:
        return f"due {at:%A}{at_time}"
    return f"due {at:%A %-d %B}{at_time}"


def listing(rows: list[dict[str, Any]], lists: list[dict[str, Any]], now: datetime) -> str:
    """For Claude: each open reminder with its list, when it's due and its id, soonest due
    first; then the lists. Their titles are the owner's (or a shared list's) words."""
    lines = []
    for r in rows[:60]:
        when = due_words(r, now)
        lines.append(
            f"- [{r.get('list') or 'Reminders'}] {r.get('title')}"
            + (f" ({when})" if when else "")
            + (" [high priority]" if r.get("priority") == 1 else "")
            + f" · id {r.get('id')}"
        )
    if len(rows) > 60:
        lines.append(f"({len(rows) - 60} more not listed.)")
    names = [
        f"{x['title']}{' (default)' if x.get('default') else ''}" for x in lists if x.get("title")
    ]
    head = "Open reminders, soonest due first:" if lines else "No open reminders."
    tail = f"Lists: {', '.join(names)}." if names else ""
    return "\n".join([head, *lines, tail]).strip()


def due_soon(rows: list[dict[str, Any]], now: datetime, days: int = 0) -> list[dict[str, Any]]:
    """Open reminders overdue or due by the end of the day `days` from today."""
    until = now.date() + timedelta(days=days)
    soon = [r for r in rows if (at := due_at(r)) is not None and at.date() <= until]
    return sorted(soon, key=lambda r: str(r.get("due")))


# The helper, from the app: one at a time (a second would only wait on macOS's question).
_lock: asyncio.Lock | None = None
_lock_loop: Any = None
_denied_until = 0.0
DENIED_RETRY = 120  # after "no access", don't ask the helper again for a while


async def fetch_open(ask: bool = True) -> dict[str, Any]:
    """{"reminders": [...], "lists": [...]} or {"error": ...}; ask False never puts up
    macOS's access question ({"error": NOT_ASKED} instead)."""
    return await _helper("open", *(() if ask else ("--no-ask",)))


async def add_reminder(spec: dict[str, Any]) -> dict[str, Any]:
    """{"added": row} or {"error": ...} (spec: clean_new's)."""
    return await _helper("add", json.dumps(spec))


async def complete_reminder(reminder_id: str) -> dict[str, Any]:
    return await _helper("complete", reminder_id)


async def delete_reminder(reminder_id: str) -> dict[str, Any]:
    return await _helper("delete", reminder_id)


async def _helper(*argv: str, timeout: float = 70) -> dict[str, Any]:
    import asyncio  # (here, not at the top: see _run)

    global _lock, _lock_loop, _denied_until
    if _lock is None or _lock_loop is not asyncio.get_running_loop():
        _lock, _lock_loop = asyncio.Lock(), asyncio.get_running_loop()
    async with _lock:
        if time.monotonic() < _denied_until:
            return {"error": NO_ACCESS}
        found = await _run(argv, timeout)
        if found.get("error") == NO_ACCESS:
            _denied_until = time.monotonic() + DENIED_RETRY
        return found


async def _run(argv: tuple[str, ...], timeout: float) -> dict[str, Any]:
    # asyncio is imported here, not at the top: the helper process this module also runs as
    # never needs it, and it was most of the helper's own import time (~13 ms a start).
    import asyncio

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "jarvis.reminders_desk",
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()  # reap it
        return {"error": "Reminders took too long to answer."}
    try:
        found = json.loads(out.decode().strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "The Reminders helper failed."}
    return found if isinstance(found, dict) else {"error": "The Reminders helper failed."}


if __name__ == "__main__":
    main()
