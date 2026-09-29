"""The calendar through Apple's EventKit: every calendar account, repeating events
included, without opening the Calendar app (the AppleScript route needs Calendar open,
takes seconds, and misses repeats).

EventKit answers on the main run loop, so like maps.py this runs as a short helper:

    python -m jarvis.calendar_kit events <hours-back> <hours-ahead>
    python -m jarvis.calendar_kit at <start>
    python -m jarvis.calendar_kit remove <start> <id> <calendar> <future: 0|1>

It prints one JSON object: {"events": [...]}, {"removed": {...}} or {"error": "..."}.
macOS asks once for calendar access on behalf of the J.A.R.V.I.S. app. `at` lists what
starts at a time; which of those a request means is decided here in the app (choose), and
`remove` deletes exactly that one, by its id, start and calendar.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime, timedelta
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
    out = [_row(event) for event in store.eventsMatchingPredicate_(predicate) or []]
    out = [row for row in out if row is not None]
    out.sort(key=lambda e: e["begin"])
    return {"events": out}


def _person(person) -> str:
    url = person.URL()
    return str(person.name() or "") or (str(url.absoluteString()) if url else "")


def _row(event, details: bool = False) -> dict[str, Any] | None:
    """One event as the app reads it; None for a cancelled one. details adds what a card
    about changing it needs: can its calendar be changed, does it repeat, who organized it."""
    status = event.status() if hasattr(event, "status") else 0
    if status == 3:  # cancelled
        return None
    begin = datetime.fromtimestamp(event.startDate().timeIntervalSince1970())
    finish = datetime.fromtimestamp(event.endDate().timeIntervalSince1970())
    # Who else is in it (names, or their addresses): the file index finds what the
    # owner has for a meeting by its title and by these people.
    attendees = []
    for person in (event.attendees() if hasattr(event, "attendees") else None) or []:
        try:
            if person.isCurrentUser():
                continue  # the owner is in every meeting: their name would match everything
            attendees.append(_person(person))
        except Exception:  # an odd participant record: skip it
            continue
    calendar = event.calendar()
    row = {
        "attendees": [a for a in attendees if a][:10],
        "title": str(event.title() or "Untitled"),
        "begin": begin.isoformat(timespec="minutes"),
        "end": finish.isoformat(timespec="minutes"),
        "all_day": bool(event.isAllDay()),
        "location": str(event.location() or ""),
        "calendar": str(calendar.title() if calendar else ""),
        "id": _event_id(event),
    }
    if details:
        organizer = event.organizer() if hasattr(event, "organizer") else None
        try:
            mine = organizer is None or bool(organizer.isCurrentUser())
            by = "" if organizer is None else _person(organizer)
        except Exception:
            mine, by = True, ""
        row |= {
            "writable": bool(calendar and calendar.allowsContentModifications()),
            "repeats": bool(event.hasRecurrenceRules()),
            "mine": mine,  # the owner's own event, or one they were invited to
            "organizer": by,
        }
    return row


def _event_id(event) -> str:
    return str(event.calendarItemExternalIdentifier() or event.eventIdentifier() or "")


def when(start: str) -> tuple[datetime, bool]:
    """A start as the tools give it: 2026-09-30T15:00 (local time) for a timed event, or
    2026-09-30 for a day (an all-day event). ValueError for anything else."""
    text = str(start).strip()
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.replace(second=0, microsecond=0), len(text) == 10


def _starting(store, start: str) -> list:
    """The events that start at that minute (or, for a day or a midnight, all-day events
    on that day), each with its EventKit object."""
    import EventKit  # noqa: F401 - loads the framework the store belongs to
    from Foundation import NSDate

    moment, day_only = when(start)
    midnight = moment.hour == 0 and moment.minute == 0
    begin = moment.replace(hour=0, minute=0) if day_only else moment
    end = begin + (timedelta(days=1) if day_only or midnight else timedelta(minutes=1))
    predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
        NSDate.dateWithTimeIntervalSince1970_(begin.timestamp()),
        NSDate.dateWithTimeIntervalSince1970_(end.timestamp()),
        None,
    )
    found = []
    for event in store.eventsMatchingPredicate_(predicate) or []:
        row = _row(event, details=True)
        if row is None:
            continue
        starts = datetime.fromisoformat(row["begin"])
        if row["all_day"]:
            if (day_only or midnight) and starts.date() == moment.date():
                found.append((row, event))
        elif not day_only and starts == moment:
            found.append((row, event))
    return found


def at(start: str) -> dict[str, Any]:
    import EventKit

    store = EventKit.EKEventStore.alloc().init()
    if not _authorized(store):
        return {"error": NO_ACCESS}
    return {"events": [row for row, _event in _starting(store, start)]}


def remove(start: str, event_id: str, calendar: str, future: bool) -> dict[str, Any]:
    """Delete the one event with this id, start and calendar: for a repeating one, that
    occurrence, or it and every later one when future."""
    import EventKit

    store = EventKit.EKEventStore.alloc().init()
    if not _authorized(store):
        return {"error": NO_ACCESS}
    hits = [
        (row, event)
        for row, event in _starting(store, start)
        if event_id in (row["id"], str(event.eventIdentifier() or ""))
        and row["calendar"] == calendar
    ]
    if len(hits) != 1:
        return {"error": "That event isn't on the calendar any more (or changed just now)."}
    row, event = hits[0]
    if not row["writable"]:
        return {"error": f"The {row['calendar']} calendar can't be changed from here."}
    span = EventKit.EKSpanFutureEvents if future and row["repeats"] else EventKit.EKSpanThisEvent
    ok, error = store.removeEvent_span_commit_error_(event, span, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Calendar didn't remove it ({why})."}
    return {"removed": row, "span": "future" if span == EventKit.EKSpanFutureEvents else "this"}


def choose(rows: list[dict[str, Any]], title: str, calendar: str = "") -> list[dict[str, Any]]:
    """Of the events starting at the time asked for, the ones a request means: the title
    exactly (ignoring case and spacing), else those whose title holds the words asked for
    or is held by them ("dentist" for "Dentist appointment"). A calendar named narrows it.
    Several back means ask which; it never picks one of them itself."""

    def plain(text: Any) -> str:
        return " ".join(str(text).casefold().split())

    want, where = plain(title), plain(calendar)
    rows = [r for r in rows if not where or plain(r.get("calendar", "")) == where]
    exact = [r for r in rows if plain(r.get("title", "")) == want]
    if exact or not want:
        return exact
    return [r for r in rows if want in plain(r["title"]) or plain(r["title"]) in want]


_lock: asyncio.Lock | None = None
_lock_loop: Any = None
_denied_until = 0.0
DENIED_RETRY = 120  # after "no access", don't ask the helper again for a while


async def fetch(hours_back: float = 0, hours_ahead: float = 24, timeout: float = 70) -> dict:
    """Run the helper from the app. {"events": [...]} or {"error": ...}."""
    return await _helper("events", str(hours_back), str(hours_ahead), timeout=timeout)


async def events_at(start: str) -> dict:
    """What starts at that time (see at()): {"events": [...]} or {"error": ...}."""
    try:
        when(start)
    except ValueError:
        return {"error": f"“{start}” isn't a time: give it like 2026-09-30T15:00."}
    return await _helper("at", start)


async def remove_at(start: str, event_id: str, calendar: str, future: bool) -> dict:
    """{"removed": {...}, "span": "this"|"future"} or {"error": ...} (see remove())."""
    return await _helper("remove", start, event_id, calendar, "1" if future else "0")


async def _helper(*argv: str, timeout: float = 70) -> dict:
    """One helper at a time: while macOS shows the access prompt, a second would only
    wait on it too."""
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


async def _run(argv: tuple[str, ...], timeout: float) -> dict:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "jarvis.calendar_kit",
        *argv,
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
    args = sys.argv[1:]
    try:
        if len(args) == 3 and args[0] == "events":
            result = events(float(args[1]), float(args[2]))
        elif len(args) == 2 and args[0] == "at":
            result = at(args[1])
        elif len(args) == 5 and args[0] == "remove":
            result = remove(args[1], args[2], args[3], args[4] == "1")
        else:
            result = {
                "error": "usage: events <back> <ahead> | at <start> | remove <start> <id> <calendar> <0|1>"
            }
    except ValueError as exc:  # a start that isn't one
        result = {"error": str(exc)}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
