"""The calendar through Apple's EventKit: every calendar account, repeating events
included, without opening the Calendar app (the AppleScript route needs Calendar open,
takes seconds, and misses repeats).

EventKit answers on the main run loop, so like maps.py this runs as a short helper:

    python -m jarvis.calendar_kit events <hours-back> <hours-ahead>

It prints one JSON object: {"events": [...]} or {"error": "..."}. macOS asks once for
calendar access on behalf of the J.A.R.V.I.S. app.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime
from typing import Any

NO_ACCESS = (
    "Calendar access is off for J.A.R.V.I.S. (System Settings > Privacy & Security > Calendars)."
)


def _authorized(store) -> bool:
    import EventKit
    from Foundation import NSDate, NSRunLoop

    status = EventKit.EKEventStore.authorizationStatusForEntityType_(EventKit.EKEntityTypeEvent)
    if status == 3:  # full access
        return True
    if status != 0:  # restricted, denied, or write-only
        return False
    done: dict[str, Any] = {}

    def answered(granted, _error):
        done["granted"] = bool(granted)

    if hasattr(store, "requestFullAccessToEventsWithCompletion_"):
        store.requestFullAccessToEventsWithCompletion_(answered)
    else:
        store.requestAccessToEntityType_completion_(EventKit.EKEntityTypeEvent, answered)
    end = time.time() + 60  # the user is reading the permission prompt
    while "granted" not in done and time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))
    return done.get("granted", False)


def events(hours_back: float, hours_ahead: float) -> dict[str, Any]:
    import EventKit
    from Foundation import NSDate

    store = EventKit.EKEventStore.alloc().init()
    if not _authorized(store):
        return {"error": NO_ACCESS}
    start = NSDate.dateWithTimeIntervalSinceNow_(-hours_back * 3600)
    end = NSDate.dateWithTimeIntervalSinceNow_(hours_ahead * 3600)
    predicate = store.predicateForEventsWithStartDate_endDate_calendars_(start, end, None)
    out = []
    for event in store.eventsMatchingPredicate_(predicate) or []:
        begin = datetime.fromtimestamp(event.startDate().timeIntervalSince1970())
        finish = datetime.fromtimestamp(event.endDate().timeIntervalSince1970())
        status = event.status() if hasattr(event, "status") else 0
        if status == 3:  # cancelled
            continue
        # Who else is in it (names, or their addresses): the file index finds what the
        # owner has for a meeting by its title and by these people.
        attendees = []
        for person in (event.attendees() if hasattr(event, "attendees") else None) or []:
            try:
                if person.isCurrentUser():
                    continue  # the owner is in every meeting: their name would match everything
                url = person.URL()
                attendees.append(
                    str(person.name() or "") or (str(url.absoluteString()) if url else "")
                )
            except Exception:  # an odd participant record: skip it
                continue
        out.append(
            {
                "attendees": [a for a in attendees if a][:10],
                "title": str(event.title() or "Untitled"),
                "begin": begin.isoformat(timespec="minutes"),
                "end": finish.isoformat(timespec="minutes"),
                "all_day": bool(event.isAllDay()),
                "location": str(event.location() or ""),
                "calendar": str(event.calendar().title() if event.calendar() else ""),
                "id": str(event.calendarItemExternalIdentifier() or event.eventIdentifier() or ""),
            }
        )
    out.sort(key=lambda e: e["begin"])
    return {"events": out}


_lock: asyncio.Lock | None = None
_lock_loop: Any = None
_denied_until = 0.0
DENIED_RETRY = 120  # after "no access", don't ask the helper again for a while


async def fetch(hours_back: float = 0, hours_ahead: float = 24, timeout: float = 70) -> dict:
    """Run the helper from the app. {"events": [...]} or {"error": ...}. One at a time:
    while macOS shows the access prompt, a second helper would only wait on it too."""
    global _lock, _lock_loop, _denied_until
    if _lock is None or _lock_loop is not asyncio.get_running_loop():
        _lock, _lock_loop = asyncio.Lock(), asyncio.get_running_loop()
    async with _lock:
        if time.monotonic() < _denied_until:
            return {"error": NO_ACCESS}
        found = await _fetch(hours_back, hours_ahead, timeout)
        if found.get("error") == NO_ACCESS:
            _denied_until = time.monotonic() + DENIED_RETRY
        return found


async def _fetch(hours_back: float, hours_ahead: float, timeout: float) -> dict:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "jarvis.calendar_kit",
        "events",
        str(hours_back),
        str(hours_ahead),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()  # reap it
        return {"error": "The calendar took too long to answer."}
    try:
        return json.loads(out.decode().strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "The calendar helper failed."}


def parse(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Helper output with real datetimes, as mac_tools.fetch_events returns them."""
    parsed = []
    for e in events:
        try:
            parsed.append(
                {
                    **e,
                    "begin": datetime.fromisoformat(e["begin"]),
                    "end": datetime.fromisoformat(e["end"]),
                }
            )
        except (KeyError, ValueError):
            continue
    return parsed


def main() -> None:
    if len(sys.argv) >= 4 and sys.argv[1] == "events":
        result = events(float(sys.argv[2]), float(sys.argv[3]))
    else:
        result = {"error": "usage: events <hours-back> <hours-ahead>"}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
