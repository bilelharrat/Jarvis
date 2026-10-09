"""Reading calendar feeds: the .ics "subscribe" links of Outlook.com / Microsoft 365, Google
Calendar and D2L Brightspace (the Windows calendar shows them next to the PC's own).

- parse(text) turns the text of a feed into IcsEvent rows, one per VEVENT, in file order. Times are
  this machine's own wall clock: a meeting written in New York, in UTC or in an Outlook zone name
  ("Eastern Standard Time") is moved to where the person is, and an all-day event is plain
  midnights with no zone to move. Nothing raises on bad input: an event that can't be understood
  (no DTSTART, a date that isn't one) is left out, and garbage gives [].
- occurrences(events, start, end) is what really happens in a window: a repeating event (RRULE,
  RDATE, EXDATE) becomes one row per repeat, a moved or cancelled repeat (a VEVENT with the same
  UID and a RECURRENCE-ID) is honoured, and an event marked cancelled never shows.

Repeats are worked out on the wall clock of the event's own zone, as every calendar does, and only
then moved to this machine's clock: a 9:00 meeting in New York stays 9:00 in New York when the
clocks change there, even though that moves it on the clock here. A time written with no zone is
"floating" and stays as written. A zone the feed defines itself (a VTIMEZONE of its own, not a
known name) counts as that zone's standard offset all year, a rough answer, and its repeats are
worked out on this machine's clock because the event keeps no zone name to work them out in.

What can't be worked out honestly is left alone rather than guessed: a rule that repeats hourly or
finer, or that has BYHOUR, BYMINUTE, BYSECOND, BYWEEKNO or BYYEARDAY (or anything this module
doesn't know), gives only the event's first time. Standard library only; zone names come from
zoneinfo (the tzdata package on a PC).
"""

from __future__ import annotations

import calendar
import hashlib
import heapq
import re
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta, timezone, tzinfo
from functools import lru_cache
from typing import NamedTuple
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_NOTES = 4000  # characters of an event's description kept as its notes
MAX_LINK = 2000  # characters of a web address kept
MAX_PEOPLE = 500  # attendees kept for one event
MAX_STEPS = 50_000  # periods (days, weeks, months, years) looked at for one repeat rule
MAX_DEPTH = 8  # BEGIN lines nested deeper than this are ignored (a real feed is three deep)
MARGIN = timedelta(days=2)  # slack when a window is read on another zone's clock
MIDNIGHT = time(0)

# The online-meeting sites whose addresses count as "the call" of an event.
MEETING_HOSTS = (
    "zoom.us",
    "meet.google.com",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com",
    "whereby.com",
    "chime.aws",
    "facetime.apple.com",
)

# How Outlook and Exchange name time zones (Windows' names), as the IANA zone Windows itself maps
# each to (the CLDR "windowsZones" primary choice). Looked up ignoring case.
WINDOWS_ZONES = {
    "Afghanistan Standard Time": "Asia/Kabul",
    "Alaskan Standard Time": "America/Anchorage",
    "Aleutian Standard Time": "America/Adak",
    "Altai Standard Time": "Asia/Barnaul",
    "Arab Standard Time": "Asia/Riyadh",
    "Arabian Standard Time": "Asia/Dubai",
    "Arabic Standard Time": "Asia/Baghdad",
    "Argentina Standard Time": "America/Argentina/Buenos_Aires",
    "Armenian Standard Time": "Asia/Yerevan",
    "Astrakhan Standard Time": "Europe/Astrakhan",
    "Atlantic Standard Time": "America/Halifax",
    "AUS Central Standard Time": "Australia/Darwin",
    "Aus Central W. Standard Time": "Australia/Eucla",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "Azerbaijan Standard Time": "Asia/Baku",
    "Azores Standard Time": "Atlantic/Azores",
    "Bahia Standard Time": "America/Bahia",
    "Bangladesh Standard Time": "Asia/Dhaka",
    "Belarus Standard Time": "Europe/Minsk",
    "Bougainville Standard Time": "Pacific/Bougainville",
    "Canada Central Standard Time": "America/Regina",
    "Cape Verde Standard Time": "Atlantic/Cape_Verde",
    "Caucasus Standard Time": "Asia/Yerevan",
    "Cen. Australia Standard Time": "Australia/Adelaide",
    "Central America Standard Time": "America/Guatemala",
    "Central Asia Standard Time": "Asia/Bishkek",
    "Central Brazilian Standard Time": "America/Cuiaba",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "Central Pacific Standard Time": "Pacific/Guadalcanal",
    "Central Standard Time": "America/Chicago",
    "Central Standard Time (Mexico)": "America/Mexico_City",
    "Chatham Islands Standard Time": "Pacific/Chatham",
    "China Standard Time": "Asia/Shanghai",
    "Coordinated Universal Time": "UTC",
    "Cuba Standard Time": "America/Havana",
    "Dateline Standard Time": "Etc/GMT+12",
    "E. Africa Standard Time": "Africa/Nairobi",
    "E. Australia Standard Time": "Australia/Brisbane",
    "E. Europe Standard Time": "Europe/Chisinau",
    "E. South America Standard Time": "America/Sao_Paulo",
    "Easter Island Standard Time": "Pacific/Easter",
    "Eastern Standard Time": "America/New_York",
    "Eastern Standard Time (Mexico)": "America/Cancun",
    "Egypt Standard Time": "Africa/Cairo",
    "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
    "Fiji Standard Time": "Pacific/Fiji",
    "FLE Standard Time": "Europe/Kyiv",
    "Georgian Standard Time": "Asia/Tbilisi",
    "GMT Standard Time": "Europe/London",
    "Greenland Standard Time": "America/Nuuk",
    "Greenwich Standard Time": "Atlantic/Reykjavik",
    "GTB Standard Time": "Europe/Bucharest",
    "Haiti Standard Time": "America/Port-au-Prince",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "India Standard Time": "Asia/Kolkata",
    "Iran Standard Time": "Asia/Tehran",
    "Israel Standard Time": "Asia/Jerusalem",
    "Jordan Standard Time": "Asia/Amman",
    "Kaliningrad Standard Time": "Europe/Kaliningrad",
    "Kamchatka Standard Time": "Asia/Kamchatka",
    "Korea Standard Time": "Asia/Seoul",
    "Libya Standard Time": "Africa/Tripoli",
    "Line Islands Standard Time": "Pacific/Kiritimati",
    "Lord Howe Standard Time": "Australia/Lord_Howe",
    "Magadan Standard Time": "Asia/Magadan",
    "Magallanes Standard Time": "America/Punta_Arenas",
    "Marquesas Standard Time": "Pacific/Marquesas",
    "Mauritius Standard Time": "Indian/Mauritius",
    "Mexico Standard Time": "America/Mexico_City",
    "Mexico Standard Time 2": "America/Mazatlan",
    "Middle East Standard Time": "Asia/Beirut",
    "Montevideo Standard Time": "America/Montevideo",
    "Morocco Standard Time": "Africa/Casablanca",
    "Mountain Standard Time": "America/Denver",
    "Mountain Standard Time (Mexico)": "America/Mazatlan",
    "Myanmar Standard Time": "Asia/Yangon",
    "N. Central Asia Standard Time": "Asia/Novosibirsk",
    "Namibia Standard Time": "Africa/Windhoek",
    "Nepal Standard Time": "Asia/Kathmandu",
    "New Zealand Standard Time": "Pacific/Auckland",
    "Newfoundland Standard Time": "America/St_Johns",
    "Norfolk Standard Time": "Pacific/Norfolk",
    "North Asia East Standard Time": "Asia/Irkutsk",
    "North Asia Standard Time": "Asia/Krasnoyarsk",
    "North Korea Standard Time": "Asia/Pyongyang",
    "Omsk Standard Time": "Asia/Omsk",
    "Pacific SA Standard Time": "America/Santiago",
    "Pacific Standard Time": "America/Los_Angeles",
    "Pacific Standard Time (Mexico)": "America/Tijuana",
    "Pakistan Standard Time": "Asia/Karachi",
    "Paraguay Standard Time": "America/Asuncion",
    "Qyzylorda Standard Time": "Asia/Qyzylorda",
    "Romance Standard Time": "Europe/Paris",
    "Russia Time Zone 10": "Asia/Srednekolymsk",
    "Russia Time Zone 11": "Asia/Kamchatka",
    "Russia Time Zone 3": "Europe/Samara",
    "Russian Standard Time": "Europe/Moscow",
    "SA Eastern Standard Time": "America/Cayenne",
    "SA Pacific Standard Time": "America/Bogota",
    "SA Western Standard Time": "America/La_Paz",
    "Saint Pierre Standard Time": "America/Miquelon",
    "Sakhalin Standard Time": "Asia/Sakhalin",
    "Samoa Standard Time": "Pacific/Apia",
    "Sao Tome Standard Time": "Africa/Sao_Tome",
    "Saratov Standard Time": "Europe/Saratov",
    "SE Asia Standard Time": "Asia/Bangkok",
    "Singapore Standard Time": "Asia/Singapore",
    "South Africa Standard Time": "Africa/Johannesburg",
    "South Sudan Standard Time": "Africa/Juba",
    "Sri Lanka Standard Time": "Asia/Colombo",
    "Sudan Standard Time": "Africa/Khartoum",
    "Syria Standard Time": "Asia/Damascus",
    "Taipei Standard Time": "Asia/Taipei",
    "Tasmania Standard Time": "Australia/Hobart",
    "Tocantins Standard Time": "America/Araguaina",
    "Tokyo Standard Time": "Asia/Tokyo",
    "Tomsk Standard Time": "Asia/Tomsk",
    "Tonga Standard Time": "Pacific/Tongatapu",
    "Transbaikal Standard Time": "Asia/Chita",
    "Turkey Standard Time": "Europe/Istanbul",
    "Turks And Caicos Standard Time": "America/Grand_Turk",
    "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
    "US Eastern Standard Time": "America/Indiana/Indianapolis",
    "US Mountain Standard Time": "America/Phoenix",
    "UTC": "UTC",
    "UTC+12": "Etc/GMT-12",
    "UTC+13": "Etc/GMT-13",
    "UTC-02": "Etc/GMT+2",
    "UTC-08": "Etc/GMT+8",
    "UTC-09": "Etc/GMT+9",
    "UTC-11": "Etc/GMT+11",
    "Venezuela Standard Time": "America/Caracas",
    "Vladivostok Standard Time": "Asia/Vladivostok",
    "Volgograd Standard Time": "Europe/Volgograd",
    "W. Australia Standard Time": "Australia/Perth",
    "W. Central Africa Standard Time": "Africa/Lagos",
    "W. Europe Standard Time": "Europe/Berlin",
    "W. Mongolia Standard Time": "Asia/Hovd",
    "West Asia Standard Time": "Asia/Tashkent",
    "West Bank Standard Time": "Asia/Hebron",
    "West Pacific Standard Time": "Pacific/Port_Moresby",
    "Yakutsk Standard Time": "Asia/Yakutsk",
    "Yukon Standard Time": "America/Whitehorse",
    "tzone://Microsoft/Utc": "UTC",  # (what Exchange writes for plain UTC)
}
_WINDOWS_ZONES_FOLDED = {name.casefold(): zone for name, zone in WINDOWS_ZONES.items()}

# What a guest's answer (PARTSTAT) means; no answer at all is "needs action", as the standard says.
_ANSWERS = {
    "ACCEPTED": "accepted",
    "DECLINED": "declined",
    "TENTATIVE": "tentative",
    "NEEDS-ACTION": "pending",
}
_WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


@dataclass(frozen=True)
class IcsEvent:
    """One event of a feed, or (from occurrences) one time a repeating event happens."""

    uid: str
    title: str  # SUMMARY ("Untitled" when none)
    # Times are naive, on this machine's own wall clock. All-day: midnight of the first day, and
    # the midnight after the last day. No end given: the start (all-day: a day later).
    start: datetime
    end: datetime
    all_day: bool
    location: str
    notes: str  # DESCRIPTION, unescaped, at most MAX_NOTES characters
    url: str  # the URL property, only when it is http(s)
    organizer_name: str
    organizer_email: str
    # (name, email, answer): the answer is accepted, declined, tentative, pending or unknown
    attendees: tuple[tuple[str, str, str], ...]
    alerts: tuple[int, ...]  # minutes before the start, sorted and unique
    status: str  # "" | "confirmed" | "tentative" | "cancelled"
    zone: str  # the IANA name of the zone it was written in, "" when none or not known
    link: str  # the first online-meeting address in it ("" if none)
    rrule: str  # the raw RRULE ("" if none)
    rdates: tuple[datetime, ...]  # extra times it happens (naive, this machine's clock)
    exdates: tuple[datetime, ...]  # times it doesn't happen
    recurrence_id: datetime | None  # the time this one replaces in a repeating event, else None


# ── lines and blocks ──


class _Line(NamedTuple):
    name: str
    params: dict[str, str]
    value: str


class _Block:
    """One BEGIN … END block: its own lines, and the blocks inside it."""

    __slots__ = ("children", "lines", "name", "order")

    def __init__(self, name: str, order: int = 0):
        self.name = name
        self.order = order
        self.lines: list[_Line] = []
        self.children: list[_Block] = []

    def value(self, name: str) -> str:
        """The value of its first line with this name, or ""."""
        return next((line.value.strip() for line in self.lines if line.name == name), "")


def _unfold(text: str) -> list[str]:
    """The lines of a document with the folding undone: a line that starts with a space or a tab
    carries on the one before (CRLF, LF or a lone CR all end a line)."""
    lines: list[str] = []
    pieces: list[str] = []
    for raw in text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and pieces:
            pieces.append(raw[1:])
            continue
        if pieces:
            lines.append("".join(pieces))
        pieces = [raw] if raw else []
    if pieces:
        lines.append("".join(pieces))
    return lines


def _split_outside_quotes(text: str, separator: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    quoted = False
    for char in text:
        if char == '"':
            quoted = not quoted
        if char == separator and not quoted:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def _content_line(raw: str) -> _Line | None:
    """One unfolded line as its name, parameters and value. The first colon outside quotes ends
    the name and parameters; a ":" ";" or "," inside quotes (CN="Smith, Ann") separates nothing."""
    colon = raw.find(":")
    if colon > 0 and '"' in raw[:colon]:
        quoted = False
        colon = -1
        for index, char in enumerate(raw):
            if char == '"':
                quoted = not quoted
            elif char == ":" and not quoted:
                colon = index
                break
    if colon < 1:
        return None
    head, value = raw[:colon], raw[colon + 1 :]
    segments = _split_outside_quotes(head, ";") if '"' in head else head.split(";")
    name = segments[0].strip().upper()
    if not name:
        return None
    params: dict[str, str] = {}
    for segment in segments[1:]:
        key, equals, text = segment.partition("=")
        if not equals:
            continue
        text = text.strip()
        if len(text) >= 2 and text[0] == text[-1] == '"':
            text = text[1:-1]
        params[key.strip().upper()] = text
    return _Line(name, params, value)


def _blocks(lines: list[str]) -> tuple[list[_Block], list[_Block]]:
    """The finished VEVENT blocks (in file order) and VTIMEZONE blocks of a document. A block that
    is never closed (a feed cut short) is dropped: half an event would be a wrong one."""
    stack = [_Block("")]
    events: list[_Block] = []
    zones: list[_Block] = []
    opened = 0
    for raw in lines:
        line = _content_line(raw)
        if line is None:
            continue
        if line.name == "BEGIN":
            if len(stack) < MAX_DEPTH:
                opened += 1
                block = _Block(line.value.strip().upper(), opened)
                stack[-1].children.append(block)
                stack.append(block)
        elif line.name == "END":
            wanted = line.value.strip().upper()
            for depth in range(len(stack) - 1, 0, -1):
                if stack[depth].name == wanted:
                    block = stack[depth]
                    del stack[depth:]
                    if wanted == "VEVENT":
                        events.append(block)
                    elif wanted == "VTIMEZONE":
                        zones.append(block)
                    break
        else:
            stack[-1].lines.append(line)
    events.sort(key=lambda block: block.order)
    return events, zones


_ESCAPED = re.compile(r"\\([nN,;\\])")
_CARET = re.compile(r"\^([n'^])")


def _unescape(text: str) -> str:
    """A TEXT value with its escapes undone (\\n, \\, \\; and \\\\). Anything else after a
    backslash is left as written: a Windows path pasted into a description stays a path."""
    return _ESCAPED.sub(lambda found: "\n" if found.group(1) in "nN" else found.group(1), text)


def _parameter_text(text: str) -> str:
    """A parameter value with the ^ escapes of RFC 6868 undone (Apple writes a quote in a
    name as ^')."""
    return _CARET.sub(lambda found: {"n": " ", "'": '"', "^": "^"}[found.group(1)], text).strip()


# ── times and zones ──

_STAMP = re.compile(r"(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?", re.IGNORECASE)
_OFFSET = re.compile(r"([+-])(\d{2})(\d{2})(\d{2})?")
_DURATION = re.compile(
    r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", re.IGNORECASE
)


def _stamp(text: str) -> tuple[datetime, bool, bool] | None:
    """A DATE or DATE-TIME value (20261008, 20261008T090000, 20261008T090000Z) as (the clock
    reading, whether it was only a date, whether it ended in Z), or None when it isn't one."""
    found = _STAMP.fullmatch(text.strip())
    if found is None:
        return None
    year, month, day, hour, minute, second, zulu = found.groups()
    try:
        reading = datetime(
            int(year),
            int(month),
            int(day),
            int(hour or 0),
            int(minute or 0),
            min(int(second or 0), 59),
        )
    except ValueError:
        return None
    return reading, hour is None, zulu is not None


def _duration(text: str) -> timedelta | None:
    """A DURATION value (PT1H30M, P1D, P1W, -PT15M, even Google's -P0DT0H30M0S), or None."""
    found = _DURATION.fullmatch(text.strip())
    if found is None:
        return None
    sign, weeks, days, hours, minutes, seconds = found.groups()
    if not any((weeks, days, hours, minutes, seconds)):  # "P" or "PT" alone
        return None
    try:
        length = timedelta(
            weeks=int(weeks or 0),
            days=int(days or 0),
            hours=int(hours or 0),
            minutes=int(minutes or 0),
            seconds=int(seconds or 0),
        )
    except OverflowError:
        return None
    return -length if sign == "-" else length


def _local(moment: datetime) -> datetime:
    """A time with a zone as this machine's own wall clock reads it (naive). When the clock read
    that time twice (the hour that repeats when clocks go back) and this is the second go,
    `fold` is 1. That changes nothing about how the time compares, but it keeps the exact moment,
    so .timestamp() is right and so is turning it back into the clock of another zone."""
    try:
        aware = moment.astimezone()
        local = aware.replace(tzinfo=None)
        if local.astimezone().utcoffset() != aware.utcoffset():
            local = local.replace(fold=1)
        return local
    except (OverflowError, OSError, ValueError):
        # Windows can't ask its clock about years before 1970 or after 3000: use today's offset.
        shift = datetime.now().astimezone().utcoffset() or timedelta(0)
        return moment.astimezone(UTC).replace(tzinfo=None) + shift


def _on_local_clock(reading: datetime, zone: tzinfo | None) -> datetime:
    """A clock reading in a zone (None: floating, already this machine's clock) on this machine's."""
    return reading if zone is None else _local(reading.replace(tzinfo=zone))


def _wall(local: datetime, zone: tzinfo | None) -> datetime:
    """This machine's clock reading as the clock of a zone reads at that moment (the way back)."""
    if zone is None:
        return local
    try:
        return local.astimezone().astimezone(zone).replace(tzinfo=None)
    except (OverflowError, OSError, ValueError):
        return local


@lru_cache(maxsize=256)
def _named_zone(name: str) -> ZoneInfo | None:
    """The IANA zone with this name, or None (including when this machine has no zone data)."""
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):  # a name that isn't a zone or a path
        return None


def _event_zone(name: str) -> tzinfo | None:
    return UTC if name == "UTC" else _named_zone(name)


def _utc_offset(text: str) -> timedelta | None:
    found = _OFFSET.fullmatch(text.strip())
    if found is None:
        return None
    sign, hours, minutes, seconds = found.groups()
    offset = timedelta(hours=int(hours), minutes=int(minutes), seconds=int(seconds or 0))
    if offset >= timedelta(days=1):
        return None
    return -offset if sign == "-" else offset


def _standard_offset(block: _Block) -> timedelta | None:
    """What a VTIMEZONE says the offset is outside daylight saving: that of its newest STANDARD
    part (of its newest DAYLIGHT part when it has no other). One fixed offset is a rough answer
    for a zone that changes with the seasons, but it is the answer the feed itself gives."""
    for kind in ("STANDARD", "DAYLIGHT"):
        best: tuple[datetime, timedelta] | None = None
        for part in block.children:
            offset = _utc_offset(part.value("TZOFFSETTO")) if part.name == kind else None
            if offset is None:
                continue
            began = _stamp(part.value("DTSTART"))
            when = began[0] if began else datetime.min
            if best is None or when >= best[0]:
                best = (when, offset)
        if best is not None:
            return best[1]
    return None


class _Zones:
    """The zones the times of one document can be read in: an IANA name, an Outlook (Windows)
    name, or else a zone the document defines itself (VTIMEZONE) as a fixed offset. A zone that
    is none of these is not known, and its times are read as floating."""

    def __init__(self, definitions: list[_Block]):
        self._offsets: dict[str, timedelta] = {}
        for block in definitions:
            offset = _standard_offset(block)
            if offset is not None and block.value("TZID"):
                self._offsets.setdefault(block.value("TZID").casefold(), offset)
        self._found: dict[str, tuple[tzinfo | None, str]] = {}

    def find(self, tzid: str) -> tuple[tzinfo | None, str]:
        """(the zone, its IANA name or "" when it is a bare offset); (None, "") if not known."""
        tzid = tzid.strip()
        if tzid not in self._found:
            self._found[tzid] = self._look(tzid)
        return self._found[tzid]

    def _look(self, tzid: str) -> tuple[tzinfo | None, str]:
        if tzid.upper() in ("UTC", "GMT", "Z", "ETC/UTC"):
            return UTC, "UTC"
        tries = [tzid, _WINDOWS_ZONES_FOLDED.get(tzid.casefold(), "")]
        if tzid.startswith("/"):  # Mozilla's and Evolution's "/mozilla.org/20070129_1/Europe/Paris"
            parts = tzid.strip("/").split("/")
            tries += ["/".join(parts[-2:]), "/".join(parts[-3:])]
        for name in tries:
            zone = _named_zone(name)
            if zone is not None:
                return zone, name
        offset = self._offsets.get(tzid.casefold())
        if offset is not None:
            return timezone(offset), ""
        return None, ""


@dataclass(frozen=True)
class _Moment:
    """A time as the feed wrote it: the clock reading, and the zone it is read in (None for a
    date and for a floating time, which are read on this machine's own clock)."""

    wall: datetime
    zone: tzinfo | None
    name: str  # the zone's IANA name, "" when it has none
    day_only: bool = False

    @property
    def local(self) -> datetime:
        return _on_local_clock(self.wall, self.zone)


def _moment(
    value: str, params: dict[str, str], zones: _Zones, beside: _Moment | None
) -> _Moment | None:
    """A DTSTART-style value with its parameters, or None when it isn't a date or a time. A time
    written with no zone beside one that has a zone (a DTEND next to a DTSTART;TZID=…, say) is
    read in that zone: it can only have meant the same clock."""
    found = _stamp(value)
    if found is None:
        return None
    reading, day_only, zulu = found
    if day_only:
        return _Moment(reading, None, "", True)
    if zulu:
        return _Moment(reading, UTC, "UTC")
    tzid = params.get("TZID", "")
    if tzid:
        zone, name = zones.find(tzid)
        return _Moment(reading, zone, name)
    if beside is not None and not beside.day_only:
        return _Moment(reading, beside.zone, beside.name)
    return _Moment(reading, None, "")


def _times(
    lines: list[_Line], zones: _Zones, beside: _Moment, day_only: bool
) -> tuple[datetime, ...]:
    """The times in RDATE or EXDATE lines (each may list several; a PERIOD counts by its start)
    on this machine's clock. For an all-day event they are days, whatever way they are written."""
    found: list[datetime] = []
    for line in lines:
        for piece in line.value.split(","):
            moment = _moment(piece.split("/")[0], line.params, zones, beside)
            if moment is not None:
                found.append(_clock_of(moment, day_only))
    return tuple(found)


def _clock_of(moment: _Moment, day_only: bool) -> datetime:
    if day_only:
        return datetime.combine(moment.wall.date(), MIDNIGHT)
    return moment.local


# ── repeat rules ──

_BYDAY = re.compile(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)", re.IGNORECASE)


@dataclass(frozen=True)
class _Rule:
    """The parts of an RRULE this module works out. `days` is BYDAY as (which one in the month or
    year, or 0 for every one; weekday with Monday 0). `until` is a date (that whole day is in), a
    clock reading (a naive datetime), or a moment (a datetime in UTC, for an UNTIL ending in Z)."""

    frequency: str  # DAILY | WEEKLY | MONTHLY | YEARLY
    interval: int
    count: int | None
    until: date | datetime | None
    days: tuple[tuple[int, int], ...]
    month_days: tuple[int, ...]
    months: tuple[int, ...]
    positions: tuple[int, ...]
    week_start: int

    @property
    def weekdays(self) -> frozenset[int]:
        return frozenset(weekday for _, weekday in self.days)


def _numbers(text: str, biggest: int) -> tuple[int, ...] | None:
    """A comma-separated list of non-zero whole numbers, none bigger than `biggest` either way
    ("" is an empty list), or None when it is not one."""
    if not text.strip():
        return ()
    try:
        numbers = tuple(int(item) for item in text.split(","))
    except ValueError:
        return None
    return numbers if all(0 < abs(number) <= biggest for number in numbers) else None


def _parse_rule(text: str) -> _Rule | None:
    """An RRULE value as a _Rule, or None when it holds anything this module can't honestly work
    out (hourly or finer, BYHOUR, BYMINUTE, BYSECOND, BYWEEKNO, BYYEARDAY, a calendar other than
    the usual one, or a part that makes no sense): such an event is given as its first time only."""
    parts: dict[str, str] = {}
    for piece in text.split(";"):
        key, _, value = piece.partition("=")
        if key.strip():
            parts[key.strip().upper()] = value.strip()
    frequency = parts.pop("FREQ", "").upper()
    if frequency not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        return None
    try:
        interval = int(parts.pop("INTERVAL", "1"))
        count = int(parts.pop("COUNT")) if "COUNT" in parts else None
    except ValueError:
        return None
    if interval < 1 or (count is not None and count < 1):
        return None
    until: date | datetime | None = None
    if "UNTIL" in parts:
        stamp = _stamp(parts.pop("UNTIL"))
        if stamp is None:
            return None
        reading, day_only, zulu = stamp
        until = reading.date() if day_only else reading.replace(tzinfo=UTC) if zulu else reading
    days: list[tuple[int, int]] = []
    for item in parts.pop("BYDAY", "").split(","):
        if not item.strip():
            continue
        found = _BYDAY.fullmatch(item.strip())
        if found is None or abs(int(found.group(1) or 0)) > 53:
            return None
        days.append((int(found.group(1) or 0), _WEEKDAYS[found.group(2).upper()]))
    month_days = _numbers(parts.pop("BYMONTHDAY", ""), 31)
    months = _numbers(parts.pop("BYMONTH", ""), 12)
    positions = _numbers(parts.pop("BYSETPOS", ""), 366)
    week_start = _WEEKDAYS.get(parts.pop("WKST", "MO").upper())
    if month_days is None or months is None or positions is None or week_start is None:
        return None
    if any(month < 0 for month in months):
        return None
    if frequency == "WEEKLY" and month_days:  # the standard forbids it, so it means nothing
        return None
    if any(not key.startswith("X-") for key in parts):  # a part this module doesn't know
        return None
    return _Rule(
        frequency,
        interval,
        count,
        until,
        tuple(days),
        month_days,
        tuple(sorted(set(months))),
        positions,
        week_start,
    )


def _days_in(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _week_start(day: date, first_weekday: int) -> date:
    return day - timedelta(days=(day.weekday() - first_weekday) % 7)


def _on_month_day(day: date, month_days: tuple[int, ...]) -> bool:
    """Whether `day` is one of BYMONTHDAY's (a negative number counts from the end of the month)."""
    return day.day in month_days or day.day - _days_in(day.year, day.month) - 1 in month_days


def _allowed(rule: _Rule, day: date) -> bool:
    """Whether a day passes the parts of a DAILY rule, which can only narrow it down."""
    if rule.months and day.month not in rule.months:
        return False
    if rule.month_days and not _on_month_day(day, rule.month_days):
        return False
    return not rule.days or day.weekday() in rule.weekdays


def _weekdays_between(entries: tuple[tuple[int, int], ...], first: date, last: date) -> list[date]:
    """The days from `first` to `last` that BYDAY names: every such weekday, or just the first,
    second… (or last, last but one…) of it in that stretch when a number comes with it."""
    found: set[date] = set()
    for which, weekday in entries:
        head = first + timedelta(days=(weekday - first.weekday()) % 7)
        if head > last:
            continue
        count = (last - head).days // 7 + 1
        if which == 0:
            found.update(head + timedelta(days=7 * index) for index in range(count))
        elif 0 < which <= count:
            found.add(head + timedelta(days=7 * (which - 1)))
        elif -count <= which < 0:
            found.add(head + timedelta(days=7 * (count + which)))
    return sorted(found)


def _month_days(rule: _Rule, year: int, month: int, usual_day: int) -> list[date]:
    """The days of one month a MONTHLY rule (or a month of a YEARLY one) picks."""
    size = _days_in(year, month)
    if rule.month_days:
        numbers = sorted({n if n > 0 else size + 1 + n for n in rule.month_days})
        days = [date(year, month, n) for n in numbers if 1 <= n <= size]
        if rule.days:  # with days of the month given, BYDAY only narrows them
            days = [day for day in days if day.weekday() in rule.weekdays]
        return days
    if rule.days:
        return _weekdays_between(rule.days, date(year, month, 1), date(year, month, size))
    return [date(year, month, usual_day)] if usual_day <= size else []


def _year_days(rule: _Rule, year: int, usual: date) -> list[date]:
    """The days of one year a YEARLY rule picks."""
    if rule.month_days:
        days: list[date] = []
        for month in rule.months or range(1, 13):
            days += _month_days(rule, year, month, usual.day)
        return days
    if rule.days:
        if not rule.months:  # "the 20th Monday" is of the year
            return _weekdays_between(rule.days, date(year, 1, 1), date(year, 12, 31))
        days = []
        for month in rule.months:  # with months, "the 4th Thursday" is of each month
            first, last = date(year, month, 1), date(year, month, _days_in(year, month))
            days += _weekdays_between(rule.days, first, last)
        return days
    return [
        date(year, month, usual.day)
        for month in rule.months or (usual.month,)
        if usual.day <= _days_in(year, month)
    ]


def _periods_between(rule: _Rule, first: date, day: date) -> int:
    """How many periods (days, weeks, months or years, by the frequency) `day` is after `first`."""
    if rule.frequency == "DAILY":
        return (day - first).days
    if rule.frequency == "WEEKLY":
        return (_week_start(day, rule.week_start) - _week_start(first, rule.week_start)).days // 7
    if rule.frequency == "MONTHLY":
        return (day.year - first.year) * 12 + day.month - first.month
    return day.year - first.year


def _period(rule: _Rule, first: date, offset: int) -> tuple[date, list[date]]:
    """The period `offset` periods after the one `first` is in: the day it begins and the days
    in it that the rule picks (BYSETPOS applied), oldest first."""
    if rule.frequency == "DAILY":
        began = first + timedelta(days=offset)
        days = [began] if _allowed(rule, began) else []
    elif rule.frequency == "WEEKLY":
        began = _week_start(first, rule.week_start) + timedelta(weeks=offset)
        wanted = rule.weekdays or {first.weekday()}
        ordered = sorted(wanted, key=lambda weekday: (weekday - rule.week_start) % 7)
        days = [began + timedelta(days=(weekday - rule.week_start) % 7) for weekday in ordered]
        days = [day for day in days if not rule.months or day.month in rule.months]
    elif rule.frequency == "MONTHLY":
        year, month = divmod(first.year * 12 + first.month - 1 + offset, 12)
        began = date(year, month + 1, 1)
        wanted_month = not rule.months or month + 1 in rule.months
        days = _month_days(rule, year, month + 1, first.day) if wanted_month else []
    else:
        year = first.year + offset
        began = date(year, 1, 1)
        days = sorted(set(_year_days(rule, year, first)))
    if rule.positions:
        chosen = {days[p - 1] if p > 0 else days[p] for p in rule.positions if abs(p) <= len(days)}
        days = sorted(chosen)
    return began, days


def _after_until(rule: _Rule, wall: datetime, zone: tzinfo | None, day_only: bool) -> bool:
    """Whether a repeat is later than the rule's UNTIL (which is itself still included). A date
    takes in its whole day; a time in Z is compared as a moment, so a New York meeting at 9:00 on
    the last day is in when UNTIL is 13:00Z that day (during daylight saving)."""
    until = rule.until
    if until is None:
        return False
    if not isinstance(until, datetime):  # a date
        return wall.date() > until
    if until.tzinfo is None or day_only:  # (an all-day repeat has no zone to be moved out of)
        return wall > until.replace(tzinfo=None)
    try:
        moment = wall.replace(tzinfo=zone) if zone is not None else wall
        return moment.astimezone(UTC) > until
    except (OverflowError, OSError, ValueError):
        return wall > until.replace(tzinfo=None)


def _expand(
    rule: _Rule, first: datetime, low: datetime, high: datetime, zone: tzinfo | None, day_only: bool
) -> Iterator[datetime]:
    """The clock readings (in the event's own zone) at which a rule repeats, oldest first: `first`
    (the standard makes DTSTART the first time whether or not the rule would pick it), then each
    repeat, up to `high`. Without COUNT it starts near `low` instead of at `first`, so a daily
    event started in 2015 costs nothing to ask about in 2026; COUNT counts from the start."""
    yield first
    made = 1
    if rule.count == 1:
        return
    # (a repeat that lands in an hour the zone's clock reads twice is the first time round)
    day, clock = first.date(), first.time().replace(fold=0)
    step = 0
    if rule.count is None:
        step = max(0, _periods_between(rule, day, low.date()) // rule.interval - 1)
    for _ in range(MAX_STEPS):
        try:
            began, days = _period(rule, day, step * rule.interval)
        except (OverflowError, ValueError):  # past the last year there is
            return
        if datetime.combine(began, clock) > high:
            return
        for picked in days:
            wall = datetime.combine(picked, clock)
            if wall <= first:
                continue
            if wall > high or _after_until(rule, wall, zone, day_only):
                return
            yield wall
            made += 1
            if made == rule.count:
                return
        step += 1


# ── reading a feed ──


def _person(line: _Line) -> tuple[str, str, str]:
    """(name, address, answer) of an ATTENDEE or ORGANIZER line."""
    value = line.value.strip()
    if value[:7].lower() == "mailto:":
        email = value[7:].split("?")[0].strip()
    elif "@" in value and ":" not in value:  # a bare address, which isn't to the letter
        email = value
    else:
        email = line.params.get("EMAIL", "").strip()
    name = _parameter_text(line.params.get("CN", ""))
    answer = line.params.get("PARTSTAT", "NEEDS-ACTION").strip().upper()
    return name, email, _ANSWERS.get(answer, "unknown")


def _alert_minutes(alarm: _Block) -> int | None:
    """Minutes before the start that a VALARM goes off, or None for one at a fixed time or
    counted from the end (or after the start)."""
    for line in alarm.lines:
        if line.name != "TRIGGER":
            continue
        if line.params.get("VALUE", "").upper() == "DATE-TIME":
            return None
        if line.params.get("RELATED", "START").upper() != "START":
            return None
        before = _duration(line.value)
        if before is None or before > timedelta(0):
            return None
        return round(-before.total_seconds() / 60)
    return None


_ADDRESS = re.compile(r"https?://[^\s<>\"'()\[\]{}|\\^`]+", re.IGNORECASE)


def _meeting_link(*texts: str) -> str:
    """The first online-meeting address (a Zoom, Meet, Teams, Webex, Whereby, Chime or FaceTime
    one) in these texts, in the order given. The site is checked on the address's host, so
    "https://zoom.us.example.com" and "https://example.com/?zoom.us" don't pass."""
    for text in texts:
        for found in _ADDRESS.findall(text):
            found = found.rstrip(".,;:!?")
            try:
                host = urlsplit(found).hostname or ""
            except ValueError:
                continue
            if any(host == site or host.endswith("." + site) for site in MEETING_HOSTS):
                return found[:MAX_LINK]
    return ""


def _event(block: _Block, zones: _Zones) -> IcsEvent | None:
    """One VEVENT as an IcsEvent, or None when it can't be understood."""
    by_name: dict[str, list[_Line]] = {}
    for line in block.lines:
        by_name.setdefault(line.name, []).append(line)

    def raw(name: str) -> str:
        return by_name[name][0].value.strip() if name in by_name else ""

    def text(name: str) -> str:
        return _unescape(by_name[name][0].value).strip() if name in by_name else ""

    if "DTSTART" not in by_name:
        return None
    first = by_name["DTSTART"][0]
    begins = _moment(first.value, first.params, zones, None)
    if begins is None:
        return None
    ends = None
    if "DTEND" in by_name:  # a DTEND that isn't a time is ignored, not a reason to lose the event
        last = by_name["DTEND"][0]
        ends = _moment(last.value, last.params, zones, begins)
    length = _duration(raw("DURATION")) if "DURATION" in by_name else None
    if length is not None and length < timedelta(0):
        length = None

    # Outlook sometimes writes an all-day event as midnight to midnight in a zone, with a flag.
    flagged = any(
        raw(name).upper() == "TRUE"
        for name in ("X-MICROSOFT-CDO-ALLDAYEVENT", "X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT")
    )
    day_only = begins.day_only or (flagged and begins.wall.time() == MIDNIGHT)
    if day_only:
        start = datetime.combine(begins.wall.date(), MIDNIGHT)
        if ends is not None:
            stop = ends.wall
        else:
            stop = start + (length or timedelta(0))
        end = datetime.combine(stop.date(), MIDNIGHT)
        if stop.time() != MIDNIGHT:  # an end part-way through a day takes in all of it
            end += timedelta(days=1)
        if end <= start:
            end = start + timedelta(days=1)
        zone = ""
    else:
        start = begins.local
        if ends is not None:
            end = ends.local
        elif length is not None:
            end = replace(begins, wall=begins.wall + length).local
        else:
            end = start
        end = max(end, start)
        zone = begins.name

    recurrence_id = None
    if "RECURRENCE-ID" in by_name:  # one we can't place would only double up its repeat
        line = by_name["RECURRENCE-ID"][0]
        replaced = _moment(line.value, line.params, zones, begins)
        if replaced is None:
            return None
        recurrence_id = _clock_of(replaced, day_only)

    title = text("SUMMARY") or "Untitled"
    location = text("LOCATION")
    description = text("DESCRIPTION")
    address = raw("URL")
    rrule = raw("RRULE")
    uid = (
        text("UID")
        or "ics-"
        + hashlib.sha1(
            f"{title}|{first.value}|{rrule}".encode(), usedforsecurity=False
        ).hexdigest()[:16]
    )
    status = text("STATUS").lower().replace("canceled", "cancelled")
    organizer_name = organizer_email = ""
    if "ORGANIZER" in by_name:
        organizer_name, organizer_email, _ = _person(by_name["ORGANIZER"][0])
    guests = tuple(_person(line) for line in by_name.get("ATTENDEE", [])[:MAX_PEOPLE])
    alerts = {
        minutes
        for alarm in block.children
        if alarm.name == "VALARM" and (minutes := _alert_minutes(alarm)) is not None
    }
    return IcsEvent(
        uid=uid,
        title=title,
        start=start,
        end=end,
        all_day=day_only,
        location=location,
        notes=description[:MAX_NOTES],
        url=address[:MAX_LINK] if address.lower().startswith(("http://", "https://")) else "",
        organizer_name=organizer_name,
        organizer_email=organizer_email,
        attendees=tuple(person for person in guests if person[0] or person[1]),
        alerts=tuple(sorted(alerts)),
        status=status if status in ("confirmed", "tentative", "cancelled") else "",
        zone=zone,
        link=_meeting_link(
            address,
            location,
            raw("X-MICROSOFT-SKYPETEAMSMEETINGURL"),
            raw("X-GOOGLE-CONFERENCE"),
            description,
        ),
        rrule=rrule,
        rdates=_times(by_name.get("RDATE", []), zones, begins, day_only),
        exdates=_times(by_name.get("EXDATE", []), zones, begins, day_only),
        recurrence_id=recurrence_id,
    )


def parse(text: str) -> list[IcsEvent]:
    """Every VEVENT in an iCalendar document, in file order. Never raises on bad input: a VEVENT
    that can't be understood (no DTSTART, a date that isn't one) is skipped; garbage in gives []."""
    if isinstance(text, bytes | bytearray):
        text = bytes(text).decode("utf-8", "replace")
    if not isinstance(text, str):
        return []
    blocks, definitions = _blocks(_unfold(text))
    zones = _Zones(definitions)
    events: list[IcsEvent] = []
    for block in blocks:
        try:
            event = _event(block, zones)
        except Exception:  # an odd event: leave it out, keep the rest
            continue
        if event is not None:
            events.append(event)
    return events


# ── what happens in a window ──


def _naive(moment: datetime) -> datetime:
    return moment if moment.tzinfo is None else _local(moment)


def _overlaps(begin: datetime, finish: datetime, start: datetime, end: datetime) -> bool:
    """Whether something from `begin` to `finish` overlaps the window [start, end). Something
    with no length is a moment, and counts when it falls inside."""
    if finish <= begin:
        return start <= begin < end
    return begin < end and finish > start


def _repeats(
    event: IcsEvent,
    start: datetime,
    end: datetime,
    replaced: set[tuple[str, datetime]],
    limit: int,
) -> Iterator[tuple[datetime, datetime]]:
    """(start, end) of each time a repeating event happens in the window, oldest first, at most
    `limit`. Times the event is excused from (EXDATE) or that another VEVENT replaces are left
    out."""
    length = max(event.end - event.start, timedelta(0))
    rule = _parse_rule(event.rrule) if event.rrule else None
    starts: Iterator[datetime]
    if rule is None:  # no rule, or one that can't be worked out honestly: just the first time
        starts = iter((event.start,))
    else:
        zone = None if event.all_day else _event_zone(event.zone)
        low = _wall(start - length, zone) - MARGIN
        high = _wall(end, zone) + MARGIN
        starts = (
            _on_local_clock(wall, zone)
            for wall in _expand(rule, _wall(event.start, zone), low, high, zone, event.all_day)
            if wall >= low
        )
    excused = set(event.exdates)
    last = None
    given = 0
    for begin in heapq.merge(starts, sorted(event.rdates)):
        if begin == last:  # an RDATE that is also one of the rule's
            continue
        last = begin
        if begin in excused or (event.uid, begin) in replaced:
            continue
        finish = begin + length
        if _overlaps(begin, finish, start, end):
            yield begin, finish
            given += 1
            if given >= limit:
                return


def occurrences(
    events: list[IcsEvent], start: datetime, end: datetime, limit: int = 3000
) -> list[IcsEvent]:
    """One IcsEvent per occurrence that overlaps [start, end) (naive local times), sorted by start
    then title. Non-repeating events are returned as they are. A repeating one yields copies with
    start/end moved (same length) and rrule/rdates/exdates/recurrence_id emptied. Cancelled events
    (status "cancelled") and cancelled/overridden occurrences are never returned. RECURRENCE-ID
    overrides replace the occurrence they name (the override's own times and fields win); an
    override that is cancelled removes it. Stop at `limit` results (the earliest ones)."""
    start, end = _naive(start), _naive(end)
    if limit < 1 or end <= start:
        return []
    replaced = {(e.uid, e.recurrence_id) for e in events if e.recurrence_id is not None}
    found: list[tuple[datetime, str, IcsEvent, datetime | None]] = []
    for event in events:
        if event.status == "cancelled":
            continue
        try:
            if not event.rrule and not event.rdates:
                moved = event.recurrence_id is None and (event.uid, event.start) in replaced
                if not moved and _overlaps(event.start, event.end, start, end):
                    found.append((event.start, event.title, event, None))
                continue
            for begin, finish in _repeats(event, start, end, replaced, limit):
                found.append((begin, event.title, event, finish))
        except (OverflowError, OSError, ValueError):  # a date at the very edge of the calendar
            continue
    found.sort(key=lambda row: (row[0], row[1]))
    return [
        event
        if finish is None
        else replace(
            event, start=begin, end=finish, rrule="", rdates=(), exdates=(), recurrence_id=None
        )
        for begin, _, event, finish in found[:limit]
    ]
