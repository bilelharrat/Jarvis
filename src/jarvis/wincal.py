"""The calendar on a PC, where there is no Calendar app for JARVIS to ask: its own calendar, and the
calendars people already keep, read from their "subscribe" links.

- "Jarvis": a calendar of JARVIS's own (events.json beside the app's data), the one new events go on
  unless another writable calendar is chosen. Events can repeat, have alerts, a place, notes and a link.
- A calendar link (an .ics address): Outlook.com and Microsoft 365 "publish" it, Google Calendar calls
  it the secret address in iCal format, D2L Brightspace gives it under Calendar > Subscribe. It is read
  at most every quarter of an hour (and when asked), kept on disk so the last good copy still reads when
  the network doesn't, and never written to. The address is a key to that calendar, so it is kept in the
  system's secret store (Windows Credential Manager), never in a file, a log or a card.

It speaks calendar_kit's language (events, at, remove, edit, create, add, range): the same commands
and the same rows the EventKit helper gives on a Mac, so everything that reads the calendar (the
briefing, meeting prep, the file index, Eden's calendar, the tools) reads this one the same way.
Times are the computer's own wall clock; an all-day event ends the midnight after its last day here,
and (as EventKit does) at 23:59 of its last day in a row.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sys
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import calendar_kit, ics, jsonstore, osplat, winoutlook

log = logging.getLogger("jarvis")

LOCAL = "local"
LOCAL_TITLE = "Jarvis"
FEED_SECONDS = 15 * 60  # a link is read again after this
FEED_RETRY_SECONDS = 5 * 60  # a link that failed is tried again after this (sooner when asked)
FEED_BYTES = 8_000_000  # the most one calendar link may send
FEED_TIMEOUT = 15
MAX_FEEDS = 12
OUTLOOK = "outlook"  # the id of Outlook's calendar, kept beside the links (it is read like one)
OUTLOOK_SECONDS = 10 * 60  # Outlook's calendar is read again after this
OUTLOOK_BACK_DAYS = 14
OUTLOOK_AHEAD_DAYS = 400
MAX_LOCAL = 5000
SERVICE = "jarvis-calendar"
COLORS = ("#1A73E8", "#188038", "#D93025", "#F9AB00", "#9334E6", "#E8710A", "#12B5CB", "#5F6368")
NO_ACCESS = "The calendar couldn't be read."
GONE = "That event isn't on the calendar any more (or changed just now)."


class CalendarError(ValueError):
    """What can't be done, in words for the owner."""


@dataclass
class Occurrence:
    """One event at one time, as the app reads it (before it is made into a row)."""

    calendar_id: str
    calendar: str
    id: str
    title: str
    start: datetime
    end: datetime  # all-day: the midnight after the last day
    all_day: bool = False
    location: str = ""
    notes: str = ""
    url: str = ""
    alerts: list[int] = field(default_factory=list)
    attendees: list[tuple[str, str, str]] = field(default_factory=list)
    organizer_name: str = ""
    organizer_email: str = ""
    link: str = ""
    repeats: bool = False
    writable: bool = False
    zone: str = ""

    def finish(self) -> datetime:
        """The last moment shown for it: EventKit ends an all-day event at 23:59:59 of its last day."""
        return self.end - timedelta(seconds=1) if self.all_day else self.end


# ── times ──


def _iso(moment: datetime) -> str:
    return moment.replace(microsecond=0, second=0).isoformat(timespec="minutes")


def _when(text: Any) -> datetime:
    return datetime.fromisoformat(str(text))


def _plain(text: Any) -> str:
    return " ".join(str(text or "").casefold().split())


# ── the files ──


class Store:
    """The calendars and the events, in a folder. Every call reads its files afresh (they are small, and
    another process may have changed them); a link's copy is read from the network only when it is old."""

    def __init__(
        self,
        folder: Path,
        vault: Any = None,
        now: Any = datetime.now,
        fetch: Any = None,
        outlook: Any = None,
    ) -> None:
        self.folder = folder
        self.now = now
        self.vault = vault or Vault()
        self.fetch = fetch or fetch_feed
        self.outlook = outlook or winoutlook.Outlook()

    # the calendars

    @property
    def _calendars_file(self) -> Path:
        return self.folder / "calendars.json"

    @property
    def _events_file(self) -> Path:
        return self.folder / "events.json"

    def _load_calendars(self) -> dict[str, Any]:
        data = jsonstore.load_json(self._calendars_file, dict) or {}
        feeds = [f for f in data.get("feeds") or [] if isinstance(f, dict) and f.get("id")]
        return {"feeds": feeds, "default": str(data.get("default") or LOCAL)}

    def _save_calendars(self, data: dict[str, Any]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        jsonstore.save_json(self._calendars_file, data)

    def calendars(self) -> list[dict[str, Any]]:
        """Every calendar: Jarvis's own, then each link, as {id, title, color, writable, source, ...}."""
        data = self._load_calendars()
        out = [
            {
                "id": LOCAL,
                "title": LOCAL_TITLE,
                "color": COLORS[0],
                "writable": True,
                "source": "This PC",
                "kind": "local",
                "default": data["default"] in (LOCAL, ""),
                "error": "",
                "checked": "",
            }
        ]
        for feed in data["feeds"]:
            out.append(
                {
                    "id": feed["id"],
                    "title": str(feed.get("title") or "Calendar"),
                    "color": str(feed.get("color") or COLORS[1]),
                    "writable": False,
                    "source": "Outlook on this PC"
                    if feed.get("kind") == "outlook"
                    else "Calendar link",
                    "kind": "outlook" if feed.get("kind") == "outlook" else "feed",
                    "default": False,
                    "error": str(feed.get("error") or ""),
                    "checked": str(feed.get("checked") or ""),
                }
            )
        return out

    def add_feed(self, url: str, title: str = "") -> dict[str, Any]:
        """Take a calendar link: read it once now (so a wrong one is said at once), keep its address
        in the secret store, and add it. CalendarError says what's wrong with it."""
        address = clean_link(url)
        data = self._load_calendars()
        if len(data["feeds"]) >= MAX_FEEDS:
            raise CalendarError(f"That's as many calendar links as I keep ({MAX_FEEDS}).")
        text, _etag = self.fetch(address, None)
        if text is None:
            raise CalendarError("That link didn't give a calendar.")
        found = ics.parse(text)
        name = " ".join(str(title or "").split())[:60] or _calendar_name(text) or "Calendar"
        feed_id = "feed-" + uuid.uuid4().hex[:8]
        self.vault.set(feed_id, address)
        feed = {
            "id": feed_id,
            "title": name,
            "color": COLORS[(len(data["feeds"]) + 1) % len(COLORS)],
            "checked": self.now().isoformat(timespec="seconds"),
            "error": "",
            "events": len(found),
        }
        data["feeds"].append(feed)
        self._save_calendars(data)
        self._keep_copy(feed_id, text, "")
        return {**feed, "events": len(found)}

    def remove_calendar(self, calendar_id: str) -> bool:
        data = self._load_calendars()
        kept = [f for f in data["feeds"] if f["id"] != calendar_id]
        if len(kept) == len(data["feeds"]):
            return False
        data["feeds"] = kept
        if data["default"] == calendar_id:
            data["default"] = LOCAL
        self._save_calendars(data)
        with contextlib.suppress(Exception):
            self.vault.delete(calendar_id)
        for suffix in (".ics", ".json"):
            with contextlib.suppress(OSError):
                (self.folder / "feeds" / f"{calendar_id}{suffix}").unlink()
        return True

    def outlook_state(self) -> dict[str, Any]:
        """Whether Outlook for Windows is on this PC, and whether Jarvis reads its calendar."""
        on = any(f.get("kind") == "outlook" for f in self._load_calendars()["feeds"])
        return {"available": bool(self.outlook.available()), "on": on}

    def set_outlook(self, on: bool) -> str:
        """Read (or stop reading) the calendar in Outlook for Windows. The words for the owner."""
        data = self._load_calendars()
        has = any(f.get("kind") == "outlook" for f in data["feeds"])
        if not on:
            if has:
                self.remove_calendar(OUTLOOK)
            return "Jarvis no longer reads Outlook's calendar. Nothing was changed in Outlook."
        if not self.outlook.available():
            raise CalendarError(
                "Outlook for Windows isn't on this PC (the new Outlook can't be read this way)."
            )
        if not has:
            data["feeds"].append(
                {
                    "id": OUTLOOK,
                    "kind": "outlook",
                    "title": "Outlook",
                    "color": COLORS[2],
                    "checked": "",
                    "error": "",
                }
            )
            self._save_calendars(data)
        said = self.refresh(True).get(OUTLOOK, "")
        if said:
            return f"Jarvis will read Outlook's calendar. {said}"
        return "Jarvis reads Outlook's calendar now, and again every few minutes while Outlook is open. It is read only."

    def set_default(self, calendar_id: str) -> None:
        if calendar_id != LOCAL:
            raise CalendarError(
                "New events can only go on Jarvis's own calendar: a calendar link is read-only."
            )
        data = self._load_calendars()
        data["default"] = LOCAL
        self._save_calendars(data)

    # the links' copies

    def _copy(self, feed_id: str) -> tuple[Path, Path]:
        return self.folder / "feeds" / f"{feed_id}.ics", self.folder / "feeds" / f"{feed_id}.json"

    def _keep_copy(self, feed_id: str, text: str, etag: str) -> None:
        body, meta = self._copy(feed_id)
        body.parent.mkdir(parents=True, exist_ok=True)
        body.write_text(text, encoding="utf-8")
        jsonstore.save_json(meta, {"fetched": time.time(), "etag": etag})

    def _read_outlook(self, feed_id: str) -> None:
        """Outlook's calendar as an .ics file, saved by Outlook itself while it is open."""
        body, _meta = self._copy(feed_id)
        if not self.outlook.running():
            raise CalendarError(
                "Outlook isn't open, so I'm using what I last read from it."
                if body.is_file()
                else "Outlook isn't open: open it, and Jarvis will read its calendar."
            )
        now = self.now()
        fresh = body.with_name(
            f"{feed_id}.new.ics"
        )  # (ends in .ics: what Outlook expects of a calendar file)
        self.outlook.export(
            fresh, now - timedelta(days=OUTLOOK_BACK_DAYS), now + timedelta(days=OUTLOOK_AHEAD_DAYS)
        )
        text = fresh.read_text(encoding="utf-8", errors="replace")
        with contextlib.suppress(OSError):
            fresh.unlink()
        if "BEGIN:VCALENDAR" not in text.upper():
            raise CalendarError("Outlook gave something that isn't a calendar.")
        self._keep_copy(feed_id, text, "")

    def refresh(self, force: bool = False) -> dict[str, str]:
        """Read again each link whose copy is old (all of them when forced): {id: "" or what went
        wrong}. A link that fails keeps its last good copy, which still reads."""
        data = self._load_calendars()
        said: dict[str, str] = {}
        changed = False
        for feed in data["feeds"]:
            body, meta = self._copy(feed["id"])
            info = jsonstore.load_json(meta, dict) or {}
            ttl = OUTLOOK_SECONDS if feed.get("kind") == "outlook" else FEED_SECONDS
            fresh = body.is_file() and time.time() - float(info.get("fetched") or 0) < ttl
            failed = time.time() - float(info.get("failed_at") or 0) < FEED_RETRY_SECONDS
            if (fresh or failed) and not force:  # (after a failure it waits, so a calendar that is
                said[feed["id"]] = str(feed.get("error") or "")  # down doesn't slow every question)
                continue
            try:
                if feed.get("kind") == "outlook":
                    self._read_outlook(feed["id"])
                else:
                    address = self.vault.get(feed["id"])
                    if not address:
                        raise CalendarError("The link for this calendar was lost; add it again.")
                    text, etag = self.fetch(address, None if force else info.get("etag"))
                    if text is None:  # nothing new (the server said so)
                        jsonstore.save_json(meta, {**info, "fetched": time.time()})
                    else:
                        self._keep_copy(feed["id"], text, etag or "")
                problem = ""
            except (CalendarError, winoutlook.OutlookError) as exc:
                problem = str(exc)
            except Exception as exc:  # the network, a full disk: the last copy still reads
                log.info("calendar link %s: %s", feed["id"], type(exc).__name__)
                problem = "The calendar link didn't answer."
            if problem:
                with contextlib.suppress(OSError):
                    jsonstore.save_json(meta, {**info, "failed_at": time.time()})
            if problem != feed.get("error"):
                feed["error"] = problem
                changed = True
            if not problem:
                feed["checked"] = self.now().isoformat(timespec="seconds")
                changed = True
            said[feed["id"]] = problem
        if changed:
            self._save_calendars(data)
        return said

    # the events

    def _load_events(self) -> list[dict[str, Any]]:
        rows = jsonstore.load_json(self._events_file, dict) or {}
        return [r for r in rows.get("events") or [] if isinstance(r, dict) and r.get("id")]

    def _save_events(self, rows: list[dict[str, Any]]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        jsonstore.save_json(self._events_file, {"events": rows[-MAX_LOCAL:]})

    def _local_occurrences(self, start: datetime, end: datetime) -> list[Occurrence]:
        out: list[Occurrence] = []
        for row in self._load_events():
            try:
                event = _ics_of(row)
                for one in ics.occurrences([event], start, end):
                    out.append(
                        Occurrence(
                            LOCAL,
                            LOCAL_TITLE,
                            row["id"],
                            row["title"],
                            one.start,
                            one.end,
                            bool(row.get("all_day")),
                            str(row.get("location") or ""),
                            str(row.get("notes") or ""),
                            str(row.get("url") or ""),
                            [int(a) for a in row.get("alerts") or []],
                            link=calendar_kit.call_link(
                                row.get("url"), row.get("location"), row.get("notes")
                            ),
                            repeats=bool(row.get("repeat")),
                            writable=True,
                        )
                    )
            except (ValueError, KeyError, TypeError):
                continue  # one row that can't be read isn't the whole calendar
        return out

    def _feed_occurrences(self, start: datetime, end: datetime) -> list[Occurrence]:
        out: list[Occurrence] = []
        for feed in self._load_calendars()["feeds"]:
            body, _meta = self._copy(feed["id"])
            try:
                text = body.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            events = ics.parse(text)
            repeating = {e.uid for e in events if e.rrule or e.rdates}
            for one in ics.occurrences(events, start, end):
                out.append(
                    Occurrence(
                        feed["id"],
                        str(feed.get("title") or "Calendar"),
                        one.uid,
                        one.title,
                        one.start,
                        one.end,
                        one.all_day,
                        one.location,
                        one.notes,
                        one.url,
                        list(one.alerts),
                        list(one.attendees),
                        one.organizer_name,
                        one.organizer_email,
                        one.link,
                        repeats=one.uid in repeating,
                        writable=False,
                        zone=one.zone,
                    )
                )
        return out

    def occurrences(self, start: datetime, end: datetime, refresh: bool = True) -> list[Occurrence]:
        """Every event of every calendar that is on between start and end, soonest first."""
        if refresh:
            with contextlib.suppress(Exception):
                self.refresh()
        found = [*self._local_occurrences(start, end), *self._feed_occurrences(start, end)]
        found = [o for o in found if _overlaps(o, start, end)]
        found.sort(key=lambda o: (o.start, not o.all_day, o.title.casefold()))
        return found

    # what calendar_kit does

    def events(self, hours_back: float, hours_ahead: float) -> dict[str, Any]:
        now = self.now()
        rows = [
            row(o)
            for o in self.occurrences(
                now - timedelta(hours=hours_back), now + timedelta(hours=hours_ahead)
            )
        ]
        return {"events": rows}

    def _starting(self, start_text: str) -> list[Occurrence]:
        """What starts at that minute (or, for a day or a midnight, the all-day events that day)."""
        moment, day_only = calendar_kit.when(start_text)
        midnight = moment.hour == 0 and moment.minute == 0
        begin = moment.replace(hour=0, minute=0) if day_only else moment
        end = begin + (timedelta(days=1) if day_only or midnight else timedelta(minutes=1))
        found = []
        for o in self.occurrences(begin, end, refresh=False):
            if o.all_day:
                if (day_only or midnight) and o.start.date() == moment.date():
                    found.append(o)
            elif not day_only and o.start == moment:
                found.append(o)
        return found

    def at(self, start: str) -> dict[str, Any]:
        return {"events": [row(o, details=True) for o in self._starting(start)]}

    def _one(self, start: str, event_id: str, calendar: str) -> Occurrence | None:
        hits = [o for o in self._starting(start) if o.id == event_id and o.calendar == calendar]
        return hits[0] if len(hits) == 1 else None

    def remove(self, start: str, event_id: str, calendar: str, future: bool) -> dict[str, Any]:
        found = self._one(start, event_id, calendar)
        if found is None:
            return {"error": GONE}
        if not found.writable:
            return {"error": f"The {found.calendar} calendar can't be changed from here."}
        rows = self._load_events()
        mine = next((r for r in rows if r["id"] == found.id), None)
        if mine is None:
            return {"error": GONE}
        gone = row(found, details=True)
        if mine.get("repeat") and not future:
            mine.setdefault("exdates", []).append(_iso(found.start))
            span = "this"
        elif mine.get("repeat") and _iso(found.start) != _iso(_when(mine["start"])):
            mine["repeat"] = {
                **mine["repeat"],
                "until": (found.start.date() - timedelta(days=1)).isoformat(),
                "count": 0,
            }
            span = "future"
        else:
            rows.remove(mine)
            span = "future" if mine.get("repeat") else "this"
        self._save_events(rows)
        return {"removed": gone, "span": span}

    def create(self, spec: dict[str, Any]) -> dict[str, Any]:
        wanted = _plain(spec.get("calendar"))
        calendars = self.calendars()
        if wanted:
            target = next((c for c in calendars if _plain(c["title"]) == wanted), None)
            if target is None:
                return {"error": f"There's no calendar called {spec['calendar']}."}
        else:
            default = self._load_calendars()["default"]
            target = next((c for c in calendars if c["id"] == default), calendars[0])
        if not target["writable"]:
            return {"error": f"The {target['title']} calendar can't be changed from here."}
        start, end = _when(spec["start"]), _when(spec["end"])
        record = {
            "id": uuid.uuid4().hex,
            "title": str(spec["title"]),
            "start": _iso(start),
            "end": _iso(end),
            "all_day": bool(spec.get("all_day")),
            "location": str(spec.get("location") or ""),
            "notes": str(spec.get("notes") or ""),
            "url": str(spec.get("url") or ""),
            "alerts": [int(a) for a in spec.get("alerts") or []],
            "repeat": _repeat_of(spec.get("repeat")),
            "exdates": [],
            "created": self.now().isoformat(timespec="seconds"),
        }
        rows = self._load_events()
        if len(rows) >= MAX_LOCAL:
            return {"error": "The calendar is full; remove some old events first."}
        rows.append(record)
        self._save_events(rows)
        made = next(
            (
                o
                for o in self._local_occurrences(start, start + timedelta(minutes=1))
                if o.id == record["id"]
            ),
            None,
        )
        if made is None:  # (a start in a repeating rule's gap can't happen: the first is the start)
            made = _single(record)
        return {"created": row(made, details=True)}

    def add(self, event: dict[str, Any]) -> dict[str, Any]:
        """Put an event back from a row (how "undo that" restores a removed one): a one-off."""
        title = str(event.get("title") or "").strip()
        try:
            begin, end = _when(event.get("begin")), _when(event.get("end"))
        except ValueError:
            return {"error": "That event's time can't be read."}
        if not title or end < begin:
            return {"error": "That event can't be put back."}
        all_day = bool(event.get("all_day"))
        if all_day:
            end = (
                (end + timedelta(seconds=1)).replace(second=0, microsecond=0)
                if end.hour == 23
                else end
            )
        wanted = str(event.get("calendar") or "")
        writable = next(
            (c for c in self.calendars() if c["writable"] and c["title"] == wanted), None
        )
        spec = {
            "title": title,
            "start": _iso(begin),
            "end": _iso(end),
            "all_day": all_day,
            "location": str(event.get("location") or ""),
            "calendar": writable["title"] if writable else "",
        }
        made = self.create(spec)
        return {"added": made["created"]} if "created" in made else made

    def edit(
        self, start: str, event_id: str, calendar: str, future: bool, changes: dict[str, Any]
    ) -> dict[str, Any]:
        found = self._one(start, event_id, calendar)
        if found is None:
            return {"error": GONE}
        if not found.writable:
            return {"error": f"The {found.calendar} calendar can't be changed from here."}
        rows = self._load_events()
        mine = next((r for r in rows if r["id"] == found.id), None)
        if mine is None:
            return {"error": GONE}
        before = row(found, details=True)
        title = str(changes["title"]).strip() if changes.get("title") is not None else found.title
        new = {
            "title": title or found.title,
            "location": str(changes["location"])
            if changes.get("location") is not None
            else found.location,
            "notes": str(changes["notes"]) if changes.get("notes") is not None else found.notes,
            "url": str(changes["url"]) if changes.get("url") is not None else found.url,
            "alerts": [int(a) for a in changes["alerts"]]
            if changes.get("alerts") is not None
            else list(found.alerts),
        }
        begin, finish = found.start, found.end
        if changes.get("start") or changes.get("duration_minutes") is not None:
            if found.all_day or (changes.get("start") and calendar_kit.when(changes["start"])[1]):
                moved = (
                    calendar_kit.when(changes["start"])[0].replace(hour=0, minute=0)
                    if changes.get("start")
                    else begin
                )
                days = max(1, (finish - begin).days) if found.all_day else 1
                begin, finish = moved, moved + timedelta(days=days)
                new["all_day"] = True
            else:
                if changes.get("start"):
                    begin = calendar_kit.when(changes["start"])[0]
                length = finish - found.start
                if changes.get("duration_minutes") is not None:
                    minutes = int(changes["duration_minutes"])
                    if not 1 <= minutes <= 24 * 60:
                        return {"error": "Duration must be between 1 minute and 24 hours."}
                    length = timedelta(minutes=minutes)
                finish = begin + length
        new.setdefault("all_day", found.all_day)
        repeating = bool(mine.get("repeat"))
        if not repeating:
            mine.update({**new, "start": _iso(begin), "end": _iso(finish)})
            self._save_events(rows)
            edited_id, span = mine["id"], "this"
        else:
            # A repeating event: this one (it leaves the series and stands alone), or it and every
            # later one (the series ends before it and a new one carries on from it).
            if future:
                original = dict(mine["repeat"])
                done = len(ics.occurrences([_ics_of(mine)], _when(mine["start"]), found.start))
                if _iso(found.start) == _iso(_when(mine["start"])):
                    rows.remove(mine)
                else:  # the series ends the day before this one
                    cut = (found.start.date() - timedelta(days=1)).isoformat()
                    mine["repeat"] = {**original, "until": cut, "count": 0}
                carried = dict(original)
                if original.get("count"):
                    carried["count"] = max(1, int(original["count"]) - done)
                carry = {
                    **mine,
                    **new,
                    "id": uuid.uuid4().hex,
                    "start": _iso(begin),
                    "end": _iso(finish),
                    "exdates": [],
                }
                carry["repeat"] = _repeat_of(carried)
                rows.append(carry)
                edited_id, span = carry["id"], "future"
            else:
                mine.setdefault("exdates", []).append(_iso(found.start))
                single = {
                    **{k: v for k, v in mine.items() if k not in ("repeat", "exdates")},
                    **new,
                }
                single.update(
                    {
                        "id": uuid.uuid4().hex,
                        "start": _iso(begin),
                        "end": _iso(finish),
                        "repeat": None,
                        "exdates": [],
                    }
                )
                rows.append(single)
                edited_id, span = single["id"], "this"
            self._save_events(rows)
        edited = next(
            (
                o
                for o in self._local_occurrences(begin, begin + timedelta(minutes=1))
                if o.id == edited_id
            ),
            None,
        )
        if edited is None:
            edited = replace(found, title=new["title"], start=begin, end=finish)
        return {"edited": row(edited, details=True), "was": before, "span": span}

    def between(self, start: str, end: str) -> dict[str, Any]:
        first, last = datetime.fromisoformat(start), datetime.fromisoformat(end)
        if first.tzinfo is not None or last.tzinfo is not None:
            raise ValueError("Give the span in local times, without an offset.")
        if not timedelta(0) < last - first <= timedelta(days=calendar_kit.RANGE_DAYS):
            return {
                "error": f"The span must end after it starts, at most {calendar_kit.RANGE_DAYS} days on."
            }
        found = self.occurrences(first, last)
        return {
            "events": [json_row(o) for o in found],
            "calendars": [
                {
                    "id": c["id"],
                    "title": c["title"],
                    "color": c["color"],
                    "writable": c["writable"],
                    "source": c["source"],
                }
                for c in self.calendars()
            ],
            "timeZone": zone_name(),
        }


# ── rows, as calendar_kit makes them ──


def row(o: Occurrence, details: bool = False) -> dict[str, Any]:
    """One event as the app reads it (calendar_kit._row's keys)."""
    attendees = [n or e for n, e, _s in o.attendees if n or e][:10]
    emails = [e for _n, e, _s in o.attendees if e][:20]
    out = {
        "attendees": attendees,
        "title": o.title or "Untitled",
        "begin": _iso(o.start),
        "end": _iso(o.finish()),
        "all_day": o.all_day,
        "location": o.location,
        "calendar": o.calendar,
        "id": o.id,
        "reply": "",
        "emails": emails,
        "organizer_email": o.organizer_email,
        "online": bool(o.link),
        "link": o.link,
    }
    if details:
        out |= {
            "writable": o.writable,
            "repeats": o.repeats,
            "mine": True,
            "organizer": o.organizer_name or o.organizer_email,
            "notes": o.notes,
            "url": o.url if o.url.lower().startswith(("https://", "http://")) else "",
            "alerts": sorted(set(o.alerts)),
        }
    return out


def json_row(o: Occurrence) -> dict[str, Any]:
    """One event as other apps read it (calendar_kit.json_event's keys)."""
    start, end = calendar_kit.iso_span(o.start.timestamp(), o.finish().timestamp(), o.all_day, None)
    url = o.url if o.url.lower().startswith(("https://", "http://")) else ""
    return {
        "id": o.id,
        "calendarId": o.calendar_id,
        "calendar": o.calendar,
        "title": o.title or "Untitled",
        "start": start,
        "end": end,
        "allDay": o.all_day,
        "timeZone": o.zone or None,
        "location": o.location,
        "notes": o.notes[: calendar_kit.MAX_EVENT_NOTES],
        "url": (url or o.link)[:2000],
        "eventUrl": url[:2000],
        "alerts": sorted(set(o.alerts)),
        "attendees": [
            {"name": n, "email": e, "status": s}
            for n, e, s in o.attendees[: calendar_kit.MAX_PEOPLE]
        ],
        "recurring": o.repeats,
        "writable": o.writable,
    }


def zone_name() -> str | None:
    """The computer's time zone by its IANA name, when it can be told (Windows keeps the Windows
    name for it, which ics.py knows how to turn into one)."""
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\TimeZoneInformation"
        ) as key:
            name = winreg.QueryValueEx(key, "TimeZoneKeyName")[0]
    except OSError:
        return None
    return getattr(ics, "WINDOWS_ZONES", {}).get(str(name))


def _overlaps(o: Occurrence, start: datetime, end: datetime) -> bool:
    if o.end <= o.start:  # an event with no length is where it starts
        return start <= o.start < end
    return o.start < end and o.end > start


def _single(record: dict[str, Any]) -> Occurrence:
    return Occurrence(
        LOCAL,
        LOCAL_TITLE,
        record["id"],
        record["title"],
        _when(record["start"]),
        _when(record["end"]),
        bool(record.get("all_day")),
        str(record.get("location") or ""),
        str(record.get("notes") or ""),
        str(record.get("url") or ""),
        [int(a) for a in record.get("alerts") or []],
        link=calendar_kit.call_link(record.get("url"), record.get("location"), record.get("notes")),
        repeats=bool(record.get("repeat")),
        writable=True,
    )


# ── a repeat, as ics.py reads it ──

_DAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
_FREQ = {"daily": "DAILY", "weekly": "WEEKLY", "monthly": "MONTHLY", "yearly": "YEARLY"}


def _repeat_of(rule: Any) -> dict[str, Any] | None:
    """A repeat as it is kept: only what's needed to say it again (clean_event's, trimmed)."""
    if not isinstance(rule, dict) or rule.get("frequency") not in _FREQ:
        return None
    return {
        "frequency": rule["frequency"],
        "every": max(1, int(rule.get("every") or 1)),
        "days": [int(d) for d in rule.get("days") or [] if 0 <= int(d) <= 6],
        "until": str(rule.get("until") or ""),
        "count": int(rule.get("count") or 0),
    }


def rrule_of(rule: dict[str, Any], start: datetime) -> str:
    parts = [f"FREQ={_FREQ[rule['frequency']]}"]
    if rule.get("every", 1) > 1:
        parts.append(f"INTERVAL={rule['every']}")
    if rule["frequency"] == "weekly":
        days = rule.get("days") or [start.weekday()]
        parts.append("BYDAY=" + ",".join(_DAYS[d] for d in days))
    if rule.get("count"):
        parts.append(f"COUNT={rule['count']}")
    elif rule.get("until"):
        parts.append("UNTIL=" + rule["until"].replace("-", "") + "T235959")
    return ";".join(parts)


def _ics_of(record: dict[str, Any]) -> ics.IcsEvent:
    start, end = _when(record["start"]), _when(record["end"])
    rule = record.get("repeat")
    return ics.IcsEvent(
        uid=record["id"],
        title=str(record.get("title") or "Untitled"),
        start=start,
        end=end,
        all_day=bool(record.get("all_day")),
        location="",
        notes="",
        url="",
        organizer_name="",
        organizer_email="",
        attendees=(),
        alerts=(),
        status="",
        zone="",
        link="",
        rrule=rrule_of(rule, start) if rule else "",
        rdates=(),
        exdates=tuple(_when(x) for x in record.get("exdates") or []),
        recurrence_id=None,
    )


def _repeating(text: str, uid: str) -> bool:
    return any(e.uid == uid and (e.rrule or e.rdates) for e in ics.parse(text))


def _calendar_name(text: str) -> str:
    found = re.search(r"^X-WR-CALNAME[^:]*:(.+)$", text, re.MULTILINE | re.IGNORECASE)
    return found.group(1).strip().replace("\\,", ",")[:60] if found else ""


# ── a calendar link ──


def clean_link(url: str) -> str:
    """A calendar link made plain: webcal:// is https://, nothing but a web address gets through."""
    address = str(url or "").strip()
    if address.lower().startswith("webcal://"):
        address = "https://" + address[9:]
    elif address.lower().startswith("webcals://"):
        address = "https://" + address[10:]
    if (
        not address.lower().startswith("https://")
        or len(address) > 2000
        or any(c.isspace() for c in address)
    ):
        raise CalendarError(
            "A calendar link is a web address that starts with https:// (or webcal://)."
        )
    return address


def fetch_feed(url: str, etag: str | None) -> tuple[str | None, str]:
    """A calendar link's text and its etag; (None, etag) when the server says it hasn't changed.
    CalendarError says what's wrong, without the address (it is a key to the calendar)."""
    import httpx

    headers = {"User-Agent": "JARVIS calendar reader", "Accept": "text/calendar, text/plain, */*"}
    if etag:
        headers["If-None-Match"] = etag
    try:
        with httpx.Client(timeout=FEED_TIMEOUT, follow_redirects=True, max_redirects=5) as client:
            with client.stream("GET", url, headers=headers) as response:
                if response.status_code == 304:
                    return None, etag or ""
                if response.status_code in (401, 403):
                    raise CalendarError(
                        "The calendar link was refused: it may have been turned off or changed."
                    )
                if response.status_code == 404:
                    raise CalendarError("The calendar link isn't there any more.")
                if response.status_code >= 400:
                    raise CalendarError(f"The calendar's server said {response.status_code}.")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > FEED_BYTES:
                        raise CalendarError("That calendar is too big to read.")
                    chunks.append(chunk)
                new_etag = response.headers.get("etag", "")
    except httpx.HTTPError as exc:
        raise CalendarError("The calendar link didn't answer.") from exc
    text = b"".join(chunks).decode("utf-8", "replace")
    if "BEGIN:VCALENDAR" not in text[:2000].upper() and "BEGIN:VEVENT" not in text.upper():
        raise CalendarError("That link isn't a calendar (it should give an .ics file).")
    return text, new_etag


class Vault:
    """Calendar links, in the system's secret store (keyring)."""

    def get(self, key: str) -> str | None:
        import keyring

        return keyring.get_password(SERVICE, key)

    def set(self, key: str, value: str) -> None:
        import keyring

        keyring.set_password(SERVICE, key, value)

    def delete(self, key: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError

        with contextlib.suppress(PasswordDeleteError):
            keyring.delete_password(SERVICE, key)


# ── the commands, as calendar_kit.main takes them ──


def folder() -> Path:
    return osplat.app_support() / "Calendar"


def run(argv: list[str], store: Store | None = None) -> dict[str, Any]:
    """One calendar_kit command (its argv, without the program), answered as it answers."""
    store = store or Store(folder())
    args = list(argv)
    try:
        if len(args) == 3 and args[0] == "events":
            return store.events(float(args[1]), float(args[2]))
        if len(args) == 2 and args[0] == "at":
            return store.at(args[1])
        if len(args) == 5 and args[0] == "remove":
            return store.remove(args[1], args[2], args[3], args[4] == "1")
        if len(args) == 6 and args[0] == "edit":
            return store.edit(args[1], args[2], args[3], args[4] == "1", json.loads(args[5]))
        if len(args) == 2 and args[0] == "create":
            spec = json.loads(args[1])
            return store.create(spec) if isinstance(spec, dict) else {"error": "Bad event."}
        if len(args) == 2 and args[0] == "add":
            event = json.loads(args[1])
            return store.add(event) if isinstance(event, dict) else {"error": "not an event"}
        if len(args) == 3 and args[0] == "range":
            return store.between(args[1], args[2])
        return {"error": "That isn't a calendar command."}
    except (ValueError, KeyError) as exc:
        return {"error": str(exc)}
    except Exception as exc:  # a damaged file, a full disk: said, never a traceback
        log.warning("calendar: %s", type(exc).__name__)
        return {"error": NO_ACCESS}
