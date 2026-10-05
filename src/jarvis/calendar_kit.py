"""The calendar through Apple's EventKit: every calendar account, repeating events
included, without opening the Calendar app (the AppleScript route needs Calendar open,
takes seconds, and misses repeats).

EventKit answers on the main run loop, so like maps.py this runs as a short helper:

    python -m jarvis.calendar_kit events <hours-back> <hours-ahead>
    python -m jarvis.calendar_kit at <start>
    python -m jarvis.calendar_kit remove <start> <id> <calendar> <future: 0|1>
    python -m jarvis.calendar_kit create <event-json>
    python -m jarvis.calendar_kit add <event-json>

It prints one JSON object: {"events": [...]}, {"removed": {...}}, {"created": {...}} or
{"error": "..."}. create makes a whole event (notes, alerts, repeats, all-day, a link) from
the spec mac_tools.clean_event made; the owner has seen it on a card first.
macOS asks once for calendar access on behalf of the J.A.R.V.I.S. app. `at` lists what
starts at a time; which of those a request means is decided here in the app (choose), and
`remove` deletes exactly that one, by its id, start and calendar.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # only for the lock's annotation (see _run)
    import asyncio

NO_ACCESS = (
    "Calendar access is off for J.A.R.V.I.S. (System Settings > Privacy & Security > Calendars)."
)


def _authorized(store, EventKit: Any = None) -> bool:  # noqa: N803 - the framework's name
    if EventKit is None:
        import EventKit

    status = EventKit.EKEventStore.authorizationStatusForEntityType_(EventKit.EKEntityTypeEvent)
    if status == 3:  # full access
        return True
    if status != 0:  # restricted, denied, or write-only
        return False
    from Foundation import NSDate, NSRunLoop

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


# The owner's answer to an invitation (EKParticipantStatus), as rows carry it.
_REPLIES = {1: "pending", 2: "accepted", 3: "declined", 4: "tentative", 5: "delegated"}
# A call link in an event's link or notes: an online meeting.
_CALL_LINK = re.compile(
    r"(?:zoom\.us/|meet\.google\.com/|teams\.microsoft\.com/|teams\.live\.com/|webex\.com/"
    r"|whereby\.com/|facetime\.apple\.com/|chime\.aws/)",
    re.IGNORECASE,
)


def _mail(person) -> str:
    """A participant's address, when their link is a mailto: one ("" otherwise)."""
    url = person.URL()
    text = str(url.absoluteString()) if url else ""
    return text[7:][:254] if text.lower().startswith("mailto:") else ""


def _online(event) -> bool:
    """A call link in the event's link, notes or location."""
    link = event.URL() if hasattr(event, "URL") else None
    notes = event.notes() if hasattr(event, "notes") else None
    where = " ".join(
        (
            str(link.absoluteString()) if link else "",
            str(notes or "")[:4000],
            str(event.location() or ""),
        )
    )
    return bool(_CALL_LINK.search(where))


_URL = re.compile(r"https://[^\s<>\"'()\[\]{}|\\^`]+", re.IGNORECASE)


def call_link(*texts: str) -> str:
    """The first call link (a Zoom, Meet or Teams https address) in these texts, or ""."""
    for text in texts:
        for found in _URL.findall(str(text or "")[:20000]):
            if _CALL_LINK.search(found):
                return found.rstrip(".,;:!?>")[:2000]
    return ""


def _link(event) -> str:
    """The event's call link: its link field first, then its place and its notes."""
    link = event.URL() if hasattr(event, "URL") else None
    notes = event.notes() if hasattr(event, "notes") else None
    return call_link(
        str(link.absoluteString()) if link else "", str(event.location() or ""), str(notes or "")
    )


def _row(event, details: bool = False) -> dict[str, Any] | None:
    """One event as the app reads it; None for a cancelled one. details adds what a card
    about changing it needs: can its calendar be changed, does it repeat, who organized it."""
    status = event.status() if hasattr(event, "status") else 0
    if status == 3:  # cancelled
        return None
    begin = datetime.fromtimestamp(event.startDate().timeIntervalSince1970())
    finish = datetime.fromtimestamp(event.endDate().timeIntervalSince1970())
    # Who else is in it (names, or their addresses): the file index finds what the
    # owner has for a meeting by its title and by these people. The owner's own record
    # says how they answered, when it's an invitation.
    attendees, emails, reply = [], [], ""
    for person in (event.attendees() if hasattr(event, "attendees") else None) or []:
        try:
            if person.isCurrentUser():
                reply = _REPLIES.get(int(person.participantStatus()), "")
                continue  # the owner is in every meeting: their name would match everything
            attendees.append(_person(person))
            address = _mail(person)
            if address:
                emails.append(address)
        except Exception:  # an odd participant record: skip it
            continue
    organizer_email = ""
    try:
        organizer = event.organizer() if hasattr(event, "organizer") else None
        if organizer is not None and not organizer.isCurrentUser():
            organizer_email = _mail(organizer)
        online = _online(event)
        link = _link(event) if online else ""
    except Exception:  # an odd organizer or link: not known
        online, link = False, ""
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
        # For the proactive parts: an invitation's answer, whom to write to, a call link.
        "reply": reply,
        "emails": emails[:20],
        "organizer_email": organizer_email,
        "online": online,
        "link": link,  # the call's own address, for "join my next meeting"
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


def edit(
    start: str, event_id: str, calendar: str, future: bool, changes: dict[str, Any]
) -> dict[str, Any]:
    """Change the one event with this id, start and calendar. changes may hold any of title,
    location, start (a new time) and duration_minutes; for a repeating one, this occurrence,
    or it and every later one when future."""
    import EventKit
    from Foundation import NSDate

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
    before = dict(row)
    if changes.get("title") is not None and str(changes["title"]).strip():
        event.setTitle_(str(changes["title"]).strip())
    if changes.get("location") is not None:
        event.setLocation_(str(changes["location"]))
    if changes.get("start") or changes.get("duration_minutes") is not None:
        old_start = datetime.fromisoformat(row["begin"])
        old_end = datetime.fromisoformat(row["end"])
        new_start, day_only = when(changes["start"]) if changes.get("start") else (old_start, False)
        if row["all_day"] or day_only:  # keep it all-day; move the day
            midnight = new_start.replace(hour=0, minute=0)
            event.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(midnight.timestamp()))
            event.setEndDate_(
                NSDate.dateWithTimeIntervalSince1970_((midnight + timedelta(days=1)).timestamp())
            )
        else:
            if changes.get("duration_minutes") is not None:
                minutes = int(changes["duration_minutes"])
                if not 1 <= minutes <= 24 * 60:
                    return {"error": "Duration must be between 1 minute and 24 hours."}
                new_end = new_start + timedelta(minutes=minutes)
            else:
                new_end = new_start + (old_end - old_start)  # keep its length when only moved
            event.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(new_start.timestamp()))
            event.setEndDate_(NSDate.dateWithTimeIntervalSince1970_(new_end.timestamp()))
    span = EventKit.EKSpanFutureEvents if future and row["repeats"] else EventKit.EKSpanThisEvent
    ok, error = store.saveEvent_span_commit_error_(event, span, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Calendar didn't save it ({why})."}
    return {
        "edited": _row(event, details=True),
        "was": before,
        "span": "future" if span == EventKit.EKSpanFutureEvents else "this",
    }


# EventKit's recurrence frequencies, and its days of the week (1 is Sunday).
_FREQUENCY = {"daily": 0, "weekly": 1, "monthly": 2, "yearly": 3}


def _weekday(monday_first: int) -> int:
    return (monday_first + 1) % 7 + 1


def create(spec: dict[str, Any], ek: Any = None, foundation: Any = None) -> dict[str, Any]:
    """Add the event a spec describes (mac_tools.clean_event's): its calendar (the default
    for new events when none is named), times, all-day, place, notes, link, alerts and how
    it repeats. ek and foundation are EventKit and Foundation (tests pass fakes)."""
    if ek is None:
        import EventKit as ek
    if foundation is None:
        import Foundation as foundation
    NSDate, NSURL = foundation.NSDate, foundation.NSURL
    store = ek.EKEventStore.alloc().init()
    if not _authorized(store, ek):
        return {"error": NO_ACCESS}
    wanted = str(spec.get("calendar") or "").strip().casefold()
    if wanted:
        calendar = next(
            (
                c
                for c in store.calendarsForEntityType_(ek.EKEntityTypeEvent) or []
                if str(c.title()).casefold() == wanted
            ),
            None,
        )
        if calendar is None:
            return {"error": f"There's no calendar called {spec['calendar']}."}
    else:
        calendar = store.defaultCalendarForNewEvents()
        if calendar is None:
            return {"error": "There's no calendar to add it to."}
    if not calendar.allowsContentModifications():
        return {"error": f"The {calendar.title()} calendar can't be changed from here."}
    start = datetime.fromisoformat(spec["start"])
    end = datetime.fromisoformat(spec["end"])
    if spec.get("all_day"):  # its last day to the second, as EventKit keeps all-day events
        end -= timedelta(seconds=1)
    event = ek.EKEvent.eventWithEventStore_(store)
    event.setCalendar_(calendar)
    event.setTitle_(str(spec["title"]))
    event.setAllDay_(bool(spec.get("all_day")))
    event.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(start.timestamp()))
    event.setEndDate_(NSDate.dateWithTimeIntervalSince1970_(end.timestamp()))
    if spec.get("location"):
        event.setLocation_(str(spec["location"]))
    if spec.get("notes"):
        event.setNotes_(str(spec["notes"]))
    if spec.get("url"):
        event.setURL_(NSURL.URLWithString_(str(spec["url"])))
    for minutes in spec.get("alerts") or []:
        event.addAlarm_(ek.EKAlarm.alarmWithRelativeOffset_(-60.0 * int(minutes)))
    rule = spec.get("repeat")
    if rule:
        days = [ek.EKRecurrenceDayOfWeek.dayOfWeek_(_weekday(d)) for d in rule.get("days") or []]
        ending = None
        if rule.get("until"):
            last = datetime.fromisoformat(rule["until"]) + timedelta(days=1, seconds=-1)
            ending = ek.EKRecurrenceEnd.recurrenceEndWithEndDate_(
                NSDate.dateWithTimeIntervalSince1970_(last.timestamp())
            )
        elif rule.get("count"):
            ending = ek.EKRecurrenceEnd.recurrenceEndWithOccurrenceCount_(int(rule["count"]))
        made = ek.EKRecurrenceRule.alloc()
        made = made.initRecurrenceWithFrequency_interval_daysOfTheWeek_daysOfTheMonth_monthsOfTheYear_weeksOfTheYear_daysOfTheYear_setPositions_end_(
            _FREQUENCY[rule["frequency"]], int(rule.get("every") or 1), days or None,
            None, None, None, None, None, ending,
        )  # fmt: skip
        event.addRecurrenceRule_(made)
    ok, error = store.saveEvent_span_commit_error_(event, ek.EKSpanThisEvent, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Calendar didn't add it ({why})."}
    return {"created": _row(event, details=True)}


def add(event: dict[str, Any]) -> dict[str, Any]:
    """Put an event on the calendar from an event's fields as _row gives them (title,
    begin, end, all_day, location, calendar): how "undo that" puts back a removed one. A
    one-off, on its calendar when that can still be written to, else the default one; no
    one is invited."""
    import EventKit
    from Foundation import NSDate

    store = EventKit.EKEventStore.alloc().init()
    if not _authorized(store):
        return {"error": NO_ACCESS}
    title = str(event.get("title") or "").strip()
    try:
        begin = datetime.fromisoformat(str(event.get("begin")))
        end = datetime.fromisoformat(str(event.get("end")))
    except ValueError:
        return {"error": "That event's time can't be read."}
    if not title or end < begin:
        return {"error": "That event can't be put back."}
    calendar = None
    wanted = str(event.get("calendar") or "")
    for cal in store.calendarsForEntityType_(EventKit.EKEntityTypeEvent) or []:
        if str(cal.title()) == wanted and cal.allowsContentModifications():
            calendar = cal
            break
    calendar = calendar or store.defaultCalendarForNewEvents()
    if calendar is None:
        return {"error": "There's no calendar to put it on."}
    item = EventKit.EKEvent.eventWithEventStore_(store)
    item.setTitle_(title)
    item.setAllDay_(bool(event.get("all_day")))
    item.setStartDate_(NSDate.dateWithTimeIntervalSince1970_(begin.timestamp()))
    item.setEndDate_(NSDate.dateWithTimeIntervalSince1970_(end.timestamp()))
    if event.get("location"):
        item.setLocation_(str(event["location"]))
    item.setCalendar_(calendar)
    ok, error = store.saveEvent_span_commit_error_(item, EventKit.EKSpanThisEvent, True, None)
    if not ok:
        why = error.localizedDescription() if error is not None else "it said no"
        return {"error": f"Calendar didn't save it ({why})."}
    return {"added": _row(item)}


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


async def edit_at(start: str, event_id: str, calendar: str, future: bool, changes: dict) -> dict:
    """{"edited": {...}, "was": {...}, "span": "this"|"future"} or {"error": ...} (see edit())."""
    return await _helper(
        "edit", start, event_id, calendar, "1" if future else "0", json.dumps(changes)
    )


async def create_at(spec: dict[str, Any]) -> dict:
    """{"created": {...}} or {"error": ...} (see create())."""
    return await _helper("create", json.dumps(spec))


async def add_event(event: dict[str, Any]) -> dict:
    """{"added": {...}} or {"error": ...} (see add())."""
    keep = ("title", "begin", "end", "all_day", "location", "calendar")
    return await _helper("add", json.dumps({k: event.get(k) for k in keep}))


async def _helper(*argv: str, timeout: float = 70) -> dict:
    """One helper at a time: while macOS shows the access prompt, a second would only
    wait on it too."""
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


async def _run(argv: tuple[str, ...], timeout: float) -> dict:
    # asyncio is imported here, not at the top: the helper process this module also runs as
    # never needs it, and it was most of the helper's own import time (~13 ms a start).
    import asyncio

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
        elif len(args) == 6 and args[0] == "edit":
            result = edit(args[1], args[2], args[3], args[4] == "1", json.loads(args[5]))
        elif len(args) == 2 and args[0] == "create":
            spec = json.loads(args[1])
            result = create(spec) if isinstance(spec, dict) else {"error": "Bad event."}
        elif len(args) == 2 and args[0] == "add":
            event = json.loads(args[1])
            result = add(event) if isinstance(event, dict) else {"error": "not an event"}
        else:
            result = {
                "error": "usage: events <back> <ahead> | at <start> | "
                "remove <start> <id> <calendar> <0|1> | edit <start> <id> <calendar> <0|1> "
                "<changes-json> | create <event-json> | add <event-json>"
            }
    except (ValueError, KeyError) as exc:  # a start that isn't one, a spec that isn't
        result = {"error": str(exc)}
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
