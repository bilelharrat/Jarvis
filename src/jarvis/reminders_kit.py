"""Apple Reminders through EventKit, read only, for the second brain: every open reminder
and the ones completed in the last COMPLETED_DAYS, from every list and account, without
opening the Reminders app.

EventKit answers on the main run loop, so like calendar_kit this runs as a short helper:

    python -m jarvis.reminders_kit list

It prints one JSON object: {"reminders": [...]} or {"error": "..."}. macOS asks once for
Reminders access on behalf of the J.A.R.V.I.S. app; the rebuild only runs it once the owner
has turned Reminders on under Second brain. Nothing is ever changed.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta
from typing import Any

NO_ACCESS = (
    "Reminders access is off for J.A.R.V.I.S. (System Settings > Privacy & Security > Reminders)."
)
COMPLETED_DAYS = 30
MAX_REMINDERS = 3000
FETCH_SECONDS = 60


def _authorized(store) -> bool:
    import EventKit
    from Foundation import NSDate, NSRunLoop

    kind = EventKit.EKEntityTypeReminder
    status = EventKit.EKEventStore.authorizationStatusForEntityType_(kind)
    if status == 3:  # full access
        return True
    if status != 0:  # restricted or denied
        return False
    done: dict[str, Any] = {}

    def answered(granted, _error):
        done["granted"] = bool(granted)

    if hasattr(store, "requestFullAccessToRemindersWithCompletion_"):
        store.requestFullAccessToRemindersWithCompletion_(answered)
    else:
        store.requestAccessToEntityType_completion_(kind, answered)
    end = time.time() + 60  # the owner is reading the permission prompt
    while "granted" not in done and time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))
    return done.get("granted", False)


def _when(nsdate) -> str:
    if nsdate is None:
        return ""
    return datetime.fromtimestamp(nsdate.timeIntervalSince1970()).isoformat(timespec="minutes")


def _due(components) -> str:
    """A reminder's due date: a day, or a day and time when it has one."""
    if components is None:
        return ""
    from Foundation import NSCalendar

    date = NSCalendar.currentCalendar().dateFromComponents_(components)
    if date is None:
        return ""
    moment = datetime.fromtimestamp(date.timeIntervalSince1970())
    timed = components.hour() not in (None, sys.maxsize) and 0 <= components.hour() < 24
    return moment.isoformat(timespec="minutes") if timed else moment.date().isoformat()


def row(reminder) -> dict[str, Any]:
    calendar = reminder.calendar()
    url = reminder.URL() if hasattr(reminder, "URL") else None
    return {
        "id": str(reminder.calendarItemIdentifier() or ""),
        "title": str(reminder.title() or ""),
        "notes": str(reminder.notes() or "")[:4000],
        "list": str(calendar.title() if calendar is not None else ""),
        "due": _due(reminder.dueDateComponents()),
        "completed": bool(reminder.isCompleted()),
        "completed_at": _when(reminder.completionDate()),
        "created": _when(reminder.creationDate()),
        "modified": _when(reminder.lastModifiedDate()),
        "priority": int(reminder.priority() or 0),
        "url": str(url.absoluteString()) if url is not None else "",
    }


def keep(rows: list[dict[str, Any]], now: datetime | None = None) -> list[dict[str, Any]]:
    """Open reminders, and the ones completed in the last COMPLETED_DAYS; soonest due first,
    then the newest; MAX_REMINDERS at most."""
    cutoff = ((now or datetime.now()) - timedelta(days=COMPLETED_DAYS)).isoformat()
    kept = [
        r
        for r in rows
        if r.get("title") and (not r.get("completed") or str(r.get("completed_at")) >= cutoff)
    ]
    kept.sort(key=lambda r: (bool(r.get("completed")), r.get("due") or "9999", r.get("title")))
    return kept[:MAX_REMINDERS]


def fetch() -> dict[str, Any]:
    import EventKit
    from Foundation import NSDate, NSRunLoop

    store = EventKit.EKEventStore.alloc().init()
    if not _authorized(store):
        return {"error": NO_ACCESS}
    done: dict[str, Any] = {}

    def fetched(reminders):
        done["items"] = list(reminders or [])

    store.fetchRemindersMatchingPredicate_completion_(
        store.predicateForRemindersInCalendars_(None), fetched
    )
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
    return {"reminders": keep(rows)}


def main() -> None:
    args = sys.argv[1:]
    if args == ["list"]:
        try:
            result = fetch()
        except Exception as exc:  # EventKit missing or failing: said, never a traceback
            result = {"error": f"Reminders couldn't be read ({type(exc).__name__})."}
    else:
        result = {"error": "usage: list"}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
