"""The iPhone's contacts and calendar, for Jarvis on the Mac. Each is off on the phone until
the owner turns it on in the app's Settings (iOS asks its permission then), and the phone
tells the Mac which ones are on (POST /api/sensors).

Contacts are asked, never collected: when the Mac's own Contacts have no one by a name,
the phone_contact tool puts the name up for the phone ("phone_asks" in /api/state, which
the app reads while it's open, and a silent push that wakes it when it isn't). The phone
looks the name up on itself and answers (POST /api/contacts/answer) with at most five
people: name, organisation, job title, phone numbers and email addresses. Nothing else,
and never the address book. An answer is kept in memory ten minutes, so asking again
about the same person doesn't wake the phone again.

The calendar is the next 14 days of the phone's events (POST /api/calendar), for owners
whose calendars live only on the phone: sent every 30 minutes while it's on, and when the
phone_calendar tool asks for a fresh copy (the same ask, of kind "calendar"). The Mac keeps
the latest copy only, in companion.json (readable by the owner alone), and forgets it when
the phone turns the calendar off.

What goes to the phone is a name the owner asked about; what comes back is checked and
capped. Contact details and event titles are the owner's own data, partly written by other
people (an invitation's title): the tools' results are private, as the Mac's own calendar.

Claude cost policy: nothing here calls a model. phone_contact and phone_calendar are tools
of the main conversation, called when the owner asks.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from datetime import datetime, timedelta
from typing import Any

log = logging.getLogger("jarvis")

SENSORS = ("contacts", "calendar")
ASK_WAIT = 20.0  # seconds a tool waits for the phone to answer
ASK_KEEP = 120.0  # an ask not answered is offered to the phone this long
ANSWER_KEEP = 600.0  # a phone's answer about a name, reused this long
ASKS_AT_ONCE = 8
PEOPLE = 5  # people in one answer
DETAILS = 5  # phone numbers, and emails, per person
NAME_CHARS = 100
CALENDAR_DAYS = 14
CALENDAR_EVENTS = 500
CALENDAR_BODY = 512 * 1024  # bytes: 500 events, each well under 1 KB
CALENDAR_EVERY = 30 * 60  # the phone sends it this often while it's on
CALENDAR_STALE = 3 * CALENDAR_EVERY  # older than this, the tool asks for a fresh copy


def _line(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit] if isinstance(value, str) else ""


def clean_name(value: Any) -> str:
    """A name to look up, as the owner said it."""
    return _line(value, NAME_CHARS)


def clean_people(raw: Any) -> list[dict[str, Any]] | str:
    """The people a phone found, checked: at most five, each with a name and only the
    fields asked for; or what's wrong."""
    if not isinstance(raw, list) or len(raw) > PEOPLE * 4:
        return "people"
    people: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            return "people"
        name = _line(item.get("name"), NAME_CHARS)
        if not name:
            return "people"
        person: dict[str, Any] = {"name": name}
        for key, limit in (("organization", 120), ("job_title", 120)):
            if text := _line(item.get(key), limit):
                person[key] = text
        for key, limit in (("phones", 40), ("emails", 120)):
            values = item.get(key)
            if values is None:
                continue
            if not isinstance(values, list):
                return key
            kept = []
            for entry in values[: DETAILS * 2]:
                if not isinstance(entry, dict):
                    return key
                value = _line(entry.get("value"), limit)
                if value:
                    kept.append({"label": _line(entry.get("label"), 30), "value": value})
            if kept:
                person[key] = kept[:DETAILS]
        people.append(person)
    return people[:PEOPLE]


def _when(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when.astimezone() if when.tzinfo else when


def clean_calendar(data: dict[str, Any], now: datetime) -> dict[str, Any] | str:
    """The phone's next two weeks, checked: events overlapping now .. 15 days ahead (a
    phone's clock can be a little ahead), each with a title, a start and an end."""
    raw = data.get("events")
    if not isinstance(raw, list) or len(raw) > CALENDAR_EVENTS:
        return "events"
    start = now - timedelta(days=1)
    end = now + timedelta(days=CALENDAR_DAYS + 1)
    events: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            return "events"
        begins, ends = _when(item.get("start")), _when(item.get("end"))
        if begins is None or ends is None or ends < begins:
            return "events"
        begins, ends = begins.replace(tzinfo=None), ends.replace(tzinfo=None)
        if ends < start or begins > end:
            continue  # outside the two weeks: not kept
        event: dict[str, Any] = {
            "title": _line(item.get("title"), 200) or "Busy",
            "start": begins.isoformat(timespec="minutes"),
            "end": ends.isoformat(timespec="minutes"),
            "all_day": item.get("all_day") is True,
        }
        for key, limit in (("location", 200), ("calendar", 60)):
            if text := _line(item.get(key), limit):
                event[key] = text
        events.append(event)
    events.sort(key=lambda e: (e["start"], e["title"]))
    return {"synced_at": now.isoformat(timespec="seconds"), "events": events}


class Ask:
    """One question up for the phones: a name to look up, or "send the calendar now"."""

    def __init__(self, kind: str, name: str, devices: set[str], now: float) -> None:
        self.id = secrets.token_urlsafe(9)
        self.kind = kind
        self.name = name
        self.devices = devices
        self.at = now
        self.done = asyncio.Event()
        self.answer: Any = None

    def public(self) -> dict[str, str]:
        out = {"id": self.id, "kind": self.kind}
        if self.name:
            out["name"] = self.name
        return out


class PhoneSensors:
    """Which phone has which sensor on, the asks up for them, and the phone's calendar."""

    def __init__(self, companion: Any, clock: Any = time.time) -> None:
        self.companion = companion
        self.clock = clock
        self.asks: dict[str, Ask] = {}
        self.answers: dict[str, tuple[float, list[dict[str, Any]]]] = {}  # memory only
        self.wait = ASK_WAIT

    # ── which sensors are on ──

    def _paired(self) -> set[str]:
        return {d.id for d in self.companion.hub.remote.devices.items}

    def flags(self) -> dict[str, dict[str, bool]]:
        raw = self.companion.store.extra("sensors")
        paired = self._paired()
        out: dict[str, dict[str, bool]] = {}
        for device_id, row in raw.items() if isinstance(raw, dict) else []:
            if device_id in paired and isinstance(row, dict):
                out[device_id] = {k: row.get(k) is True for k in SENSORS}
        return out

    def set_flags(self, device_id: str, changes: dict[str, Any]) -> dict[str, bool]:
        flags = self.flags()
        row = {**flags.get(device_id, dict.fromkeys(SENSORS, False))}
        for key in SENSORS:
            if isinstance(changes.get(key), bool):
                row[key] = changes[key]
        flags[device_id] = row
        self.companion.store.set_extra("sensors", flags)
        if not row["calendar"]:
            self.forget_calendar(device_id)
        if not row["contacts"]:
            self.answers.clear()  # what it said stays on the phone now
        return row

    def phones(self, sensor: str) -> list[str]:
        return [d for d, row in self.flags().items() if row.get(sensor)]

    # ── asks ──

    def _prune(self) -> None:
        now = self.clock()
        for ask_id in [i for i, a in self.asks.items() if now - a.at > ASK_KEEP]:
            del self.asks[ask_id]
        for key in [k for k, (at, _) in self.answers.items() if now - at > ANSWER_KEEP]:
            del self.answers[key]

    def asks_for(self, device_id: str) -> list[dict[str, str]]:
        """What /api/state offers this phone (only what its sensors that are on answer)."""
        self._prune()
        return [
            a.public() for a in self.asks.values() if device_id in a.devices and not a.done.is_set()
        ]

    async def ask(self, kind: str, name: str = "") -> Any:
        """Put this up for the phones with that sensor on, wake them, and wait a little for
        the first answer. None: no phone has it on; "timeout": none answered in time."""
        devices = set(self.phones("contacts" if kind == "contact" else "calendar"))
        if not devices:
            return None
        self._prune()
        same = next(
            (a for a in self.asks.values() if a.kind == kind and a.name.lower() == name.lower()),
            None,
        )
        if same is None:
            while len(self.asks) >= ASKS_AT_ONCE:
                del self.asks[next(iter(self.asks))]
            same = Ask(kind, name, devices, self.clock())
            self.asks[same.id] = same
            await self.wake(devices)
        try:
            await asyncio.wait_for(same.done.wait(), self.wait)
        except TimeoutError:
            return "timeout"
        return same.answer

    def answer(self, device_id: str, ask_id: str, answer: Any) -> bool:
        ask = self.asks.get(ask_id)
        if ask is None or device_id not in ask.devices:
            return False
        del self.asks[ask_id]
        ask.answer = answer
        ask.done.set()
        if ask.kind == "contact":
            self.answers[ask.name.lower()] = (self.clock(), answer)
        return True

    def calendar_synced(self) -> None:
        """A fresh calendar came: every ask for one is answered by it."""
        for ask_id in [i for i, a in self.asks.items() if a.kind == "calendar"]:
            ask = self.asks.pop(ask_id)
            ask.answer = True
            ask.done.set()

    async def wake(self, devices: set[str]) -> None:
        """A silent push to each of these phones that has push: "look at /api/state". It
        says nothing else (the name stays off Apple's servers); Apple may hold it back, and
        then the app answers when it's next opened."""
        from . import push

        companion = self.companion
        try:
            creds = await companion.keys.get()
        except Exception:
            creds = None
        if creds is None:
            return
        jobs = []
        for device_id in devices:
            record = companion.store.known(device_id)
            registration = record and record["push"]
            if not registration or not creds.allows(registration["bundle_id"]):
                continue
            jobs.append(
                companion.sender.send(
                    push.Push(
                        device_token=registration["token"],
                        environment=registration["environment"],
                        topic=registration["bundle_id"],
                        payload={"aps": {"content-available": 1}, "jarvis": {"kind": "asks"}},
                        push_type="background",
                        priority=5,  # Apple's rule for a silent push
                        expiration=int(self.clock() + ASK_KEEP),
                    )
                )
            )
        for result in await asyncio.gather(*jobs, return_exceptions=True):
            if isinstance(result, BaseException) or not result.ok:
                log.info("companion: a phone couldn't be woken for an ask")

    # ── contacts ──

    async def contact_text(self, name: str) -> str:
        name = clean_name(name)
        if not name:
            return "Say whose name to look up."
        self._prune()
        cached = self.answers.get(name.lower())
        people = cached[1] if cached else await self.ask("contact", name)
        if people is None:
            return (
                "No iPhone has contact lookups turned on (J.A.R.V.I.S. app > Settings > Contacts)."
            )
        if people == "timeout":
            return (
                "The iPhone didn't answer in time: it may be asleep or out of reach. Opening "
                "the J.A.R.V.I.S. app on it lets it answer."
            )
        if not people:
            return f"No one called {name} in the iPhone's contacts either."
        lines = []
        for p in people:
            about = ", ".join(x for x in (p.get("job_title"), p.get("organization")) if x)
            phones = ", ".join(f"{x['label'] or 'phone'} {x['value']}" for x in p.get("phones", []))
            emails = ", ".join(x["value"] for x in p.get("emails", []))
            lines.append(
                f"{p['name']}"
                + (f" ({about})" if about else "")
                + f": {phones or 'no phone'}; {emails or 'no email'}"
            )
        return "From the owner's iPhone contacts:\n" + "\n".join(lines)

    # ── the calendar ──

    def calendar(self) -> dict[str, Any] | None:
        raw = self.companion.store.extra("calendar")
        if not isinstance(raw, dict) or raw.get("device") not in self._paired():
            return None
        synced = _when(raw.get("synced_at"))
        if synced is None:
            return None
        clean = clean_calendar(raw, synced.replace(tzinfo=None))
        return {**clean, "device": raw["device"]} if isinstance(clean, dict) else None

    def set_calendar(self, device_id: str, calendar: dict[str, Any]) -> None:
        self.companion.store.set_extra("calendar", {**calendar, "device": device_id})
        self.calendar_synced()

    def forget_calendar(self, device_id: str) -> None:
        raw = self.companion.store.extra("calendar")
        if isinstance(raw, dict) and raw.get("device") == device_id:
            self.companion.store.set_extra("calendar", None)

    async def calendar_text(self, days: int = 7, fresh: bool = False) -> str:
        days = max(1, min(CALENDAR_DAYS, days))
        kept = self.calendar()
        now = datetime.now()
        age = (now - datetime.fromisoformat(kept["synced_at"])).total_seconds() if kept else None
        note = ""
        if fresh or age is None or age > CALENDAR_STALE:
            got = await self.ask("calendar")
            if got is None and kept is None:
                return (
                    "No iPhone has its calendar turned on for Jarvis (J.A.R.V.I.S. app > "
                    "Settings > Calendar)."
                )
            kept = self.calendar() or kept
            if got == "timeout":
                note = " (the iPhone didn't send a fresh copy in time)"
        if kept is None:
            return "The iPhone hasn't sent its calendar yet. Opening the J.A.R.V.I.S. app on it sends it."
        until = (now + timedelta(days=days)).isoformat(timespec="minutes")
        start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="minutes")
        events = [e for e in kept["events"] if e["end"] >= start and e["start"] <= until]
        synced = datetime.fromisoformat(kept["synced_at"]).strftime("%a %H:%M")
        head = f"The owner's iPhone calendars, next {days} days (synced {synced}{note})"
        if not events:
            return head + ": nothing."
        lines = []
        for e in events:
            begins = datetime.fromisoformat(e["start"])
            if e["all_day"]:
                when = begins.strftime("%a %d %b") + ", all day"
            else:
                when = begins.strftime("%a %d %b %H:%M") + "–" + e["end"][11:16]
            extra = "".join(
                f" {mark} {e[key]}"
                for key, mark in (("location", "@"), ("calendar", "·"))
                if key in e
            )
            lines.append(f"{when}: {e['title']}{extra}")
        return head + ":\n" + "\n".join(lines)
