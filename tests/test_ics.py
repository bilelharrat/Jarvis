"""Reading calendar feeds (jarvis.ics): the .ics text of an Outlook.com / Microsoft 365, Google
Calendar or D2L Brightspace "subscribe" link as events, and repeating events as the times they
happen in a window.

A time a feed writes in a zone comes out on the machine's own clock, so these tests build what they
expect with at(zone, ...), which does the same conversion with zoneinfo and so means the same on
any machine. A few tests pin the machine's zone (where the system lets a program do that) to check
the numbers themselves. The repeat rules are mostly tried on floating times, which no zone can
move, and many are the examples in RFC 5545 itself.
"""

from __future__ import annotations

import calendar
import dataclasses
import random
import time
from datetime import UTC, date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from jarvis import ics

try:
    ZoneInfo("America/New_York")
    HAVE_ZONES = True
except ZoneInfoNotFoundError:  # a machine with no time zone data (a PC gets it from tzdata)
    HAVE_ZONES = False
needs_zones = pytest.mark.skipif(not HAVE_ZONES, reason="no time zone data on this machine")


def at(zone: str, *clock: int) -> datetime:
    """A clock reading in a zone, as this machine's own clock reads it."""
    return datetime(*clock, tzinfo=ZoneInfo(zone)).astimezone().replace(tzinfo=None)


def utc(*clock: int) -> datetime:
    """A moment in UTC, as this machine's own clock reads it."""
    return datetime(*clock, tzinfo=UTC).astimezone().replace(tzinfo=None)


def lines(*parts: str) -> str:
    return "\n".join(parts)


def feed(*events: str, head: str = "") -> str:
    """A calendar document (with CRLF line ends, as feeds have) holding these events, each a
    string of lines."""
    body = "".join(f"BEGIN:VEVENT\n{event}\nEND:VEVENT\n" for event in events)
    text = f"BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n{head}{body}END:VCALENDAR\n"
    return text.replace("\n", "\r\n")


def one(*parts: str, head: str = "") -> ics.IcsEvent:
    """The only event of a feed made from these lines."""
    (found,) = ics.parse(feed(lines(*parts), head=head))
    return found


def times(*parts: str, start: datetime, end: datetime, extra: tuple[str, ...] = (), **kw):
    """The start of each time an event (and any `extra` events) happens in the window."""
    found = ics.parse(feed(lines(*parts), *extra))
    return [e.start for e in ics.occurrences(found, start, end, **kw)]


def days(*dates: tuple[int, int, int], hour: int = 9) -> list[datetime]:
    return [datetime(y, m, d, hour) for y, m, d in dates]


def rfc_days(text: str) -> list[datetime]:
    """Days written the way the standard writes them ("19970902 19970903"), each at 9:00."""
    return [datetime(int(d[:4]), int(d[4:6]), int(d[6:]), 9) for d in text.split()]


WIDE = (datetime(1990, 1, 1), datetime(2040, 1, 1))


@pytest.fixture
def machine_zone(monkeypatch):
    """Set this machine's time zone for a test: machine_zone("Asia/Tokyo") (and back after). Only
    where the system lets a program do that; a PC doesn't."""
    if not hasattr(time, "tzset") or not HAVE_ZONES:
        pytest.skip("this machine can't change its time zone while running")

    def use(name: str) -> None:
        monkeypatch.setenv("TZ", name)
        time.tzset()

    yield use
    monkeypatch.undo()
    time.tzset()


# ── the shape other code relies on ──


def test_an_event_has_exactly_the_agreed_fields_and_cannot_be_changed():
    names = [field.name for field in dataclasses.fields(ics.IcsEvent)]
    assert names == [
        "uid",
        "title",
        "start",
        "end",
        "all_day",
        "location",
        "notes",
        "url",
        "organizer_name",
        "organizer_email",
        "attendees",
        "alerts",
        "status",
        "zone",
        "link",
        "rrule",
        "rdates",
        "exdates",
        "recurrence_id",
    ]
    event = one("UID:a", "DTSTART:20261008T090000")
    with pytest.raises(dataclasses.FrozenInstanceError):
        event.title = "changed"  # type: ignore[misc]


def test_an_event_made_by_hand_works_the_same_as_one_read_from_a_feed():
    read = one("UID:a", "DTSTART:20261005T090000", "DTEND:20261005T100000", "SUMMARY:Call")
    by_hand = dataclasses.replace(read, rrule="FREQ=DAILY;COUNT=2")
    out = ics.occurrences([by_hand], datetime(2026, 10, 1), datetime(2026, 11, 1))
    assert [(e.start, e.end) for e in out] == [
        (datetime(2026, 10, 5, 9), datetime(2026, 10, 5, 10)),
        (datetime(2026, 10, 6, 9), datetime(2026, 10, 6, 10)),
    ]


# ── lines, folding, escapes ──


def test_folded_lines_are_joined_and_text_is_unescaped():
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261008T090000\r\n"
        "SUMMARY:Budget review\\, Q4\\; part \r\n 2 of 3\r\n"
        "DESCRIPTION:Line one\\nLine two\\NLine three\\, with a comma\\; and a back\\\\slash. A lo\r\n"
        " ng word is cut mid\r\n\t-word here.\r\n"
        "LOCATION:Room\r\n  12\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    (event,) = ics.parse(text)
    assert event.title == "Budget review, Q4; part 2 of 3"
    assert event.notes == (
        "Line one\nLine two\nLine three, with a comma; and a back\\slash. "
        "A long word is cut mid-word here."
    )
    assert event.location == "Room 12"


@pytest.mark.parametrize("newline", ["\r\n", "\n", "\r"])
def test_any_kind_of_line_end_works_and_a_byte_order_mark_is_ignored(newline):
    text = (
        "\ufeffBEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20261008T090000\n"
        "SUMMARY:Folded\n  title\nEND:VEVENT\nEND:VCALENDAR"
    )
    (event,) = ics.parse(text.replace("\n", newline))
    assert event.title == "Folded title"


def test_only_the_four_escapes_of_the_standard_are_undone():
    """A backslash before anything else is left alone, so a Windows path pasted into a
    description stays a path (but \\n, \\N, \\, \\; and \\\\ are the standard's, wherever they are)."""
    event = one("DTSTART:20261008T090000", r"DESCRIPTION:Saved in C:\Users\ann\files and a \x")
    assert event.notes == r"Saved in C:\Users\ann\files and a \x"


def test_a_quoted_parameter_may_hold_colons_semicolons_and_commas():
    event = one(
        "DTSTART:20261008T090000",
        'ATTENDEE;CN="Smith, Ann; PhD: Esq";PARTSTAT=ACCEPTED:mailto:ann@example.com',
        'ORGANIZER;CN="Boss, The:Big";SENT-BY="mailto:pa@example.com":mailto:boss@example.com',
    )
    assert event.attendees == (("Smith, Ann; PhD: Esq", "ann@example.com", "accepted"),)
    assert (event.organizer_name, event.organizer_email) == ("Boss, The:Big", "boss@example.com")


def test_a_quote_in_a_name_written_the_apple_way_comes_back_as_a_quote():
    event = one("DTSTART:20261008T090000", "ATTENDEE;CN=Ann ^'Annie^' Lee:mailto:ann@example.com")
    assert event.attendees[0][0] == 'Ann "Annie" Lee'


@needs_zones
def test_names_of_properties_and_parameters_do_not_care_about_case():
    event = one("dtstart;tzid=Eastern Standard Time:20261008T090000", "summary:Lower case")
    assert event.title == "Lower case"
    assert event.start == at("America/New_York", 2026, 10, 8, 9)


# ── times and zones ──


def test_an_all_day_event_is_dates_with_the_end_the_day_after_the_last_day():
    event = one("UID:a", "DTSTART;VALUE=DATE:20261008", "DTEND;VALUE=DATE:20261010", "SUMMARY:Trip")
    assert event.all_day and event.zone == ""
    assert event.start == datetime(2026, 10, 8) and event.end == datetime(2026, 10, 10)


@pytest.mark.parametrize(
    "extra, last",
    [
        ((), datetime(2026, 10, 9)),  # no end at all: one day
        (("DTEND;VALUE=DATE:20261008",), datetime(2026, 10, 9)),  # an end that is the start
        (("DURATION:P1D",), datetime(2026, 10, 9)),
        (("DURATION:P3D",), datetime(2026, 10, 11)),
        (("DURATION:P1W",), datetime(2026, 10, 15)),
        (("DURATION:PT36H",), datetime(2026, 10, 10)),  # part of a day takes in the whole day
    ],
)
def test_an_all_day_event_without_a_proper_end_still_lasts_whole_days(extra, last):
    event = one("DTSTART;VALUE=DATE:20261008", *extra)
    assert event.all_day and event.start == datetime(2026, 10, 8) and event.end == last


def test_a_floating_time_stays_as_written_and_has_no_zone():
    event = one("DTSTART:20261008T090000", "DTEND:20261008T103000")
    assert (event.start, event.end) == (datetime(2026, 10, 8, 9), datetime(2026, 10, 8, 10, 30))
    assert not event.all_day and event.zone == ""


def test_a_time_in_utc_is_moved_to_this_machines_clock():
    event = one("DTSTART:20261008T130000Z", "DTEND:20261008T140000Z")
    assert event.start == utc(2026, 10, 8, 13) and event.end == utc(2026, 10, 8, 14)
    assert event.zone == "UTC"


@needs_zones
def test_a_time_in_an_iana_zone_is_moved_to_this_machines_clock():
    event = one(
        "DTSTART;TZID=America/New_York:20261008T090000",
        "DTEND;TZID=America/New_York:20261008T100000",
    )
    assert event.start == at("America/New_York", 2026, 10, 8, 9)
    assert event.end == at("America/New_York", 2026, 10, 8, 10)
    assert event.zone == "America/New_York"


@needs_zones
@pytest.mark.parametrize(
    "windows_name, iana",
    [
        ("Eastern Standard Time", "America/New_York"),
        ("Pacific Standard Time", "America/Los_Angeles"),
        ("Central Standard Time", "America/Chicago"),
        ("Mountain Standard Time", "America/Denver"),
        ("GMT Standard Time", "Europe/London"),
        ("W. Europe Standard Time", "Europe/Berlin"),
        ("Romance Standard Time", "Europe/Paris"),
        ("India Standard Time", "Asia/Kolkata"),
        ("AUS Eastern Standard Time", "Australia/Sydney"),
        ("Newfoundland Standard Time", "America/St_Johns"),
        ("UTC", "UTC"),
    ],
)
def test_the_zone_names_outlook_writes_are_understood(windows_name, iana):
    event = one(f"DTSTART;TZID={windows_name}:20261008T090000")
    assert event.zone == iana
    assert event.start == at(iana, 2026, 10, 8, 9)


@needs_zones
def test_a_windows_zone_name_is_found_whatever_its_case_and_when_quoted():
    for tzid in ("eastern standard time", '"Eastern Standard Time"', "EASTERN STANDARD TIME"):
        event = one(f"DTSTART;TZID={tzid}:20261008T090000")
        assert event.zone == "America/New_York"


@needs_zones
def test_an_old_style_zone_id_with_a_path_in_front_is_still_a_zone():
    event = one("DTSTART;TZID=/mozilla.org/20070129_1/Europe/Paris:20261008T090000")
    assert event.zone == "Europe/Paris" and event.start == at("Europe/Paris", 2026, 10, 8, 9)


def test_the_zone_names_outlook_is_known_to_write_are_all_in_the_table():
    wanted = """Eastern Standard Time, Pacific Standard Time, Central Standard Time, Mountain
    Standard Time, GMT Standard Time, W. Europe Standard Time, Romance Standard Time, Central Europe
    Standard Time, E. Europe Standard Time, GTB Standard Time, Arabian Standard Time, Arab Standard
    Time, Egypt Standard Time, Middle East Standard Time, India Standard Time, China Standard Time,
    Tokyo Standard Time, AUS Eastern Standard Time, UTC, Greenwich Standard Time, Alaskan Standard
    Time, Hawaiian Standard Time, Atlantic Standard Time, Newfoundland Standard Time, Canada Central
    Standard Time, US Mountain Standard Time, SA Pacific Standard Time, E. South America Standard
    Time, South Africa Standard Time, Russian Standard Time, Turkey Standard Time, Israel Standard
    Time, Singapore Standard Time, Korea Standard Time, New Zealand Standard Time"""
    for name in " ".join(wanted.split()).split(", "):
        assert name in ics.WINDOWS_ZONES, name


@needs_zones
def test_every_zone_in_the_windows_table_is_a_real_zone():
    for windows_name, iana in ics.WINDOWS_ZONES.items():
        assert ZoneInfo(iana), windows_name


@needs_zones
@pytest.mark.parametrize(
    "windows_name, hours",
    [
        ("Eastern Standard Time", -5),
        ("Central Standard Time", -6),
        ("Mountain Standard Time", -7),
        ("Pacific Standard Time", -8),
        ("Alaskan Standard Time", -9),
        ("Hawaiian Standard Time", -10),
        ("Atlantic Standard Time", -4),
        ("Newfoundland Standard Time", -3.5),
        ("Canada Central Standard Time", -6),
        ("US Mountain Standard Time", -7),
        ("SA Pacific Standard Time", -5),
        ("E. South America Standard Time", -3),
        ("UTC", 0),
        ("GMT Standard Time", 0),
        ("Greenwich Standard Time", 0),
        ("W. Europe Standard Time", 1),
        ("Romance Standard Time", 1),
        ("Central Europe Standard Time", 1),
        ("E. Europe Standard Time", 2),
        ("GTB Standard Time", 2),
        ("Egypt Standard Time", 2),
        ("Middle East Standard Time", 2),
        ("Israel Standard Time", 2),
        ("South Africa Standard Time", 2),
        ("Russian Standard Time", 3),
        ("Turkey Standard Time", 3),
        ("Arab Standard Time", 3),
        ("Arabian Standard Time", 4),
        ("India Standard Time", 5.5),
        ("China Standard Time", 8),
        ("Singapore Standard Time", 8),
        ("Tokyo Standard Time", 9),
        ("Korea Standard Time", 9),
        ("AUS Eastern Standard Time", 11),  # (daylight saving time, in January)
        ("New Zealand Standard Time", 13),  # (likewise)
    ],
)
def test_each_windows_zone_name_has_the_offset_windows_shows_for_it_in_january(windows_name, hours):
    zone = ZoneInfo(ics.WINDOWS_ZONES[windows_name])
    assert datetime(2026, 1, 15, 12, tzinfo=zone).utcoffset() == timedelta(hours=hours)


def zone_definition(name: str, *parts: tuple[str, str, str]) -> str:
    """A VTIMEZONE: its name, and each part as (STANDARD or DAYLIGHT, start, offset it changes to)."""
    blocks = [
        lines(f"BEGIN:{kind}", f"DTSTART:{began}", f"TZOFFSETTO:{offset}", f"END:{kind}")
        for kind, began, offset in parts
    ]
    return lines("BEGIN:VTIMEZONE", f"TZID:{name}", *blocks, "END:VTIMEZONE", "")


def test_gmt_and_utc_written_as_zone_ids_are_utc():
    for tzid in ("UTC", "GMT", "Etc/UTC", "utc"):
        event = one(f"DTSTART;TZID={tzid}:20261008T090000")
        assert event.zone == "UTC" and event.start == utc(2026, 10, 8, 9)


def test_a_zone_the_document_defines_itself_counts_as_its_standard_offset():
    head = zone_definition(
        "Customized Time Zone",
        ("DAYLIGHT", "16010101T020000", "-0400"),
        ("STANDARD", "16010101T020000", "-0500"),
    )
    event = one("DTSTART;TZID=Customized Time Zone:20260115T090000", head=head)
    fixed = timezone(timedelta(hours=-5))
    assert event.start == datetime(2026, 1, 15, 9, tzinfo=fixed).astimezone().replace(tzinfo=None)
    assert event.zone == ""  # (a bare offset is no IANA zone)


def test_of_several_standard_parts_the_newest_one_gives_the_offset():
    head = zone_definition(
        "Somewhere",
        ("STANDARD", "20070101T000000", "+0530"),
        ("STANDARD", "19900101T000000", "+0100"),
    )
    event = one("DTSTART;TZID=Somewhere:20261008T090000", head=head)
    fixed = timezone(timedelta(hours=5.5))
    assert event.start == datetime(2026, 10, 8, 9, tzinfo=fixed).astimezone().replace(tzinfo=None)


def test_a_zone_with_only_daylight_parts_gives_that_offset():
    head = zone_definition("Only Summer", ("DAYLIGHT", "20070101T000000", "+0200"))
    event = one("DTSTART;TZID=Only Summer:20261008T090000", head=head)
    fixed = timezone(timedelta(hours=2))
    assert event.start == datetime(2026, 10, 8, 9, tzinfo=fixed).astimezone().replace(tzinfo=None)


def test_a_zone_nobody_knows_makes_the_time_floating():
    for tzid in (
        "(UTC-05:00) Eastern Time (US & Canada)",
        "Mars/Olympus_Mons",
        "Customized Time Zone",
    ):
        event = one(f'DTSTART;TZID="{tzid}":20261008T090000')
        assert event.start == datetime(2026, 10, 8, 9) and event.zone == ""


def test_a_zone_name_cannot_make_the_program_read_a_file():
    for tzid in ("../../etc/passwd", "/etc/passwd", "America", "zone.tab", "\0"):
        event = one(f"DTSTART;TZID={tzid}:20261008T090000")
        assert event.start == datetime(2026, 10, 8, 9) and event.zone == ""


@needs_zones
def test_an_end_written_without_a_zone_beside_a_start_with_one_means_the_same_zone():
    event = one("DTSTART;TZID=America/New_York:20261008T090000", "DTEND:20261008T100000")
    assert event.end - event.start == timedelta(hours=1)


@needs_zones
def test_the_end_may_be_in_a_different_zone_from_the_start():
    event = one(
        "DTSTART;TZID=America/New_York:20261008T090000",
        "DTEND;TZID=Europe/London:20261008T150000",  # 10:00 in New York
    )
    assert event.end - event.start == timedelta(hours=1)


@pytest.mark.parametrize(
    "extra, length",
    [
        (("DTEND:20261008T103000",), timedelta(minutes=90)),
        (("DURATION:PT1H30M",), timedelta(minutes=90)),
        (("DURATION:PT45M",), timedelta(minutes=45)),
        (("DURATION:P1D",), timedelta(days=1)),
        (("DURATION:P1W",), timedelta(weeks=1)),
        (("DURATION:PT0S",), timedelta(0)),
        ((), timedelta(0)),  # nothing says: it is a moment
        (("DTEND:20261008T080000",), timedelta(0)),  # an end before the start is no length
        (("DTEND:not a time",), timedelta(0)),  # an end that is not one is ignored
        (("DURATION:-PT1H",), timedelta(0)),
        (("DURATION:soon",), timedelta(0)),
    ],
)
def test_how_long_a_timed_event_lasts(extra, length):
    event = one("DTSTART:20261008T090000", *extra)
    assert event.end - event.start == length


@needs_zones
@pytest.mark.parametrize(
    "flag", ["X-MICROSOFT-CDO-ALLDAYEVENT:TRUE", "X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT:TRUE"]
)
def test_outlooks_all_day_flag_makes_midnight_to_midnight_in_a_zone_a_real_all_day_event(flag):
    event = one(
        "DTSTART;TZID=Eastern Standard Time:20261009T000000",
        "DTEND;TZID=Eastern Standard Time:20261011T000000",
        flag,
    )
    assert event.all_day and event.zone == ""
    assert (event.start, event.end) == (datetime(2026, 10, 9), datetime(2026, 10, 11))


def test_the_all_day_flag_is_ignored_for_an_event_that_does_not_start_at_midnight():
    event = one(
        "DTSTART:20261009T090000", "DTEND:20261009T100000", "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"
    )
    assert not event.all_day and event.start == datetime(2026, 10, 9, 9)


# ── people, status, alerts, links ──


def test_attendees_and_the_organizer_are_read_with_their_answers():
    event = one(
        "UID:a",
        "DTSTART:20261008T090000",
        "ORGANIZER;CN=Bob Boss:mailto:bob@example.com",
        "ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ann@example.com",
        "ATTENDEE;CN=Dee;PARTSTAT=DECLINED:MAILTO:Dee@Example.com",
        "ATTENDEE;CN=Tom;PARTSTAT=TENTATIVE:mailto:tom@example.com",
        "ATTENDEE;CN=Pat;PARTSTAT=NEEDS-ACTION:mailto:pat@example.com",
        "ATTENDEE;CN=Del;PARTSTAT=DELEGATED:mailto:del@example.com",
        "ATTENDEE;CN=Eve:mailto:eve@example.com",  # no answer given: "needs action", by the standard
        "ATTENDEE;CN=Odd;PARTSTAT=IN-PROCESS:mailto:odd@example.com",
        "ATTENDEE:mailto:nameless@example.com",
        "ATTENDEE;CN=Room 4;EMAIL=room4@example.com:urn:uuid:1234",
        "ATTENDEE;CN=No Address:https://example.com/people/1",
        "ATTENDEE:ann.again@example.com",
        "ATTENDEE:urn:uuid:nobody",  # nothing to show for this one
    )
    assert (event.organizer_name, event.organizer_email) == ("Bob Boss", "bob@example.com")
    assert event.attendees == (
        ("Ann", "ann@example.com", "accepted"),
        ("Dee", "Dee@Example.com", "declined"),
        ("Tom", "tom@example.com", "tentative"),
        ("Pat", "pat@example.com", "pending"),
        ("Del", "del@example.com", "unknown"),
        ("Eve", "eve@example.com", "pending"),
        ("Odd", "odd@example.com", "unknown"),
        ("", "nameless@example.com", "pending"),
        ("Room 4", "room4@example.com", "pending"),
        ("No Address", "", "pending"),
        ("", "ann.again@example.com", "pending"),
    )


def test_an_address_may_carry_a_query_and_a_huge_guest_list_is_cut_short():
    event = one("DTSTART:20261008T090000", "ATTENDEE;CN=Ann:mailto:ann@example.com?subject=Hi")
    assert event.attendees == (("Ann", "ann@example.com", "pending"),)
    guests = [f"ATTENDEE;CN=Guest {n}:mailto:g{n}@example.com" for n in range(ics.MAX_PEOPLE + 100)]
    big = one("DTSTART:20261008T090000", *guests)
    assert len(big.attendees) == ics.MAX_PEOPLE and big.attendees[0][0] == "Guest 0"


def test_an_event_with_no_people_has_none_listed():
    event = one("DTSTART:20261008T090000")
    assert event.attendees == () and event.organizer_name == event.organizer_email == ""


def test_status_is_lower_case_and_only_the_three_known_ones():
    for given, shown in [
        ("CONFIRMED", "confirmed"),
        ("TENTATIVE", "tentative"),
        ("CANCELLED", "cancelled"),
        ("CANCELED", "cancelled"),
        ("Confirmed", "confirmed"),
        ("FREE", ""),
        ("", ""),
    ]:
        assert one("DTSTART:20261008T090000", f"STATUS:{given}").status == shown
    assert one("DTSTART:20261008T090000").status == ""


def alarm(*parts: str) -> str:
    return lines("BEGIN:VALARM", *parts, "END:VALARM")


@pytest.mark.parametrize(
    "trigger, minutes",
    [
        ("TRIGGER:-PT15M", 15),
        ("TRIGGER:-PT1H", 60),
        ("TRIGGER:-P1D", 1440),
        ("TRIGGER:-PT0S", 0),
        ("TRIGGER:PT0S", 0),
        ("TRIGGER:-P1W", 10080),
        ("TRIGGER:-PT1H30M", 90),
        ("TRIGGER:-P0DT0H30M0S", 30),  # the way Google writes half an hour
        ("TRIGGER;VALUE=DURATION:-PT5M", 5),
        ("TRIGGER;RELATED=START:-PT10M", 10),
        ("TRIGGER:-P1DT2H", 1560),
    ],
)
def test_an_alert_before_the_start_is_minutes_before_the_start(trigger, minutes):
    event = one("DTSTART:20261008T090000", alarm("ACTION:DISPLAY", trigger))
    assert event.alerts == (minutes,)


@pytest.mark.parametrize(
    "trigger",
    [
        "TRIGGER:PT15M",  # after the start
        "TRIGGER;RELATED=END:-PT5M",  # counted from the end
        "TRIGGER;VALUE=DATE-TIME:20261008T080000Z",  # a fixed time
        "TRIGGER:20261008T080000Z",
        "TRIGGER:soon",
    ],
)
def test_alerts_that_are_not_before_the_start_are_ignored(trigger):
    assert one("DTSTART:20261008T090000", alarm(trigger)).alerts == ()


def test_alerts_are_sorted_and_unique_and_do_not_leak_into_the_event():
    event = one(
        "DTSTART:20261008T090000",
        "SUMMARY:Real title",
        alarm("TRIGGER:-PT1H", "DESCRIPTION:Alarm text"),
        alarm("TRIGGER:-PT15M"),
        alarm("TRIGGER:-PT15M"),
    )
    assert event.alerts == (15, 60) and event.title == "Real title" and event.notes == ""


TEAMS = (
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0"
    "?context=%7b%22Tid%22%3a%22t%22%2c%22Oid%22%3a%22o%22%7d"
)


def test_a_teams_link_in_the_description_is_found_as_outlook_writes_it():
    description = (
        "DESCRIPTION:Agenda: budget\\n\\n________________________________________________\\n"
        f"Microsoft Teams meeting\\nJoin on your computer or mobile app\\n<{TEAMS}>\\n"
        "Click here to join the meeting<https://teams.microsoft.com/meetingOptions/?x=1>\\n"
    )
    event = one("DTSTART:20261008T090000", "LOCATION:Microsoft Teams Meeting", description)
    assert event.link == TEAMS


def test_a_link_far_down_a_long_description_is_still_found():
    padding = "Lots of words. " * 600  # more than the notes keep
    event = one(
        "DTSTART:20261008T090000",
        f"DESCRIPTION:{padding}Join: https://us02web.zoom.us/j/123?pwd=a.",
    )
    assert len(event.notes) == ics.MAX_NOTES
    assert event.link == "https://us02web.zoom.us/j/123?pwd=a"


@pytest.mark.parametrize(
    "site",
    [
        "https://zoom.us/j/1",
        "https://us02web.zoom.us/j/1",
        "https://meet.google.com/abc-defg-hij",
        "https://teams.microsoft.com/l/meetup-join/x",
        "https://teams.live.com/meet/9",
        "https://acme.webex.com/meet/ann",
        "https://whereby.com/room",
        "https://chime.aws/1234567890",
        "https://facetime.apple.com/join#v=1",
    ],
)
def test_every_kind_of_meeting_address_is_recognised(site):
    assert one("DTSTART:20261008T090000", f"DESCRIPTION:Join at {site} please").link == site


@pytest.mark.parametrize(
    "site",
    [
        "https://zoom.us.example.com/j/1",
        "https://example.com/?next=zoom.us/j/1",
        "https://notzoom.us/j/1",
        "https://zoom.us@example.com/j/1",
        "https://example.com/meet.google.com/abc",
        "https://example.com/",
        "ftp://zoom.us/j/1",
    ],
)
def test_an_address_that_only_mentions_a_meeting_site_is_not_a_meeting_link(site):
    assert one("DTSTART:20261008T090000", f"DESCRIPTION:See {site}").link == ""


def test_the_link_comes_from_the_url_then_the_place_then_the_vendor_fields_then_the_notes():
    sources = [
        ("URL:https://zoom.us/j/1", "https://zoom.us/j/1"),
        ("LOCATION:https://meet.google.com/loc-loc-loc", "https://meet.google.com/loc-loc-loc"),
        (
            "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/skype",
            "https://teams.microsoft.com/l/skype",
        ),
        (
            "X-GOOGLE-CONFERENCE:https://meet.google.com/goo-goo-goo",
            "https://meet.google.com/goo-goo-goo",
        ),
        ("DESCRIPTION:https://whereby.com/notes", "https://whereby.com/notes"),
    ]
    for first in range(len(sources)):
        given = [line for line, _ in sources[first:]]
        assert one("DTSTART:20261008T090000", *reversed(given)).link == sources[first][1]


def test_the_url_property_is_kept_only_when_it_is_a_web_address():
    assert one("DTSTART:20261008T090000", "URL:https://example.com/a?b=1").url == (
        "https://example.com/a?b=1"
    )
    assert one("DTSTART:20261008T090000", "URL:HTTP://example.com/").url == "HTTP://example.com/"
    for bad in (
        "mailto:ann@example.com",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "example.com",
    ):
        assert one("DTSTART:20261008T090000", f"URL:{bad}").url == ""


def test_title_notes_and_identity_have_sensible_defaults_and_limits():
    plain = one("DTSTART:20261008T090000")
    assert plain.title == "Untitled" and plain.location == plain.notes == plain.link == ""
    assert one("DTSTART:20261008T090000", "SUMMARY:   ").title == "Untitled"
    long = one("DTSTART:20261008T090000", "DESCRIPTION:" + "x" * 9000)
    assert len(long.notes) == ics.MAX_NOTES == 4000


def test_an_event_with_no_uid_gets_a_steady_one_of_its_own():
    text = feed("DTSTART:20261008T090000\nSUMMARY:One", "DTSTART:20261008T090000\nSUMMARY:Two")
    first, second = ics.parse(text)
    again = ics.parse(text)
    assert first.uid and second.uid and first.uid != second.uid
    assert [e.uid for e in again] == [first.uid, second.uid]


# ── bad input ──


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   \n\n",
        "hello world",
        "BEGIN:VCALENDAR",
        "BEGIN:VCALENDAR\nEND:VCALENDAR",
        "\x00\x01\x02 binary \xff\xfe",
        "BEGIN:VEVENT\nSUMMARY:No start\nEND:VEVENT",
        "BEGIN:VEVENT\nDTSTART:20261340T000000\nEND:VEVENT",
        "BEGIN:VEVENT\nDTSTART:tomorrow\nEND:VEVENT",
        "BEGIN:VEVENT\nDTSTART:20261008T256100\nEND:VEVENT",
        "BEGIN:VEVENT\nDTSTART:20261008T090000\nSUMMARY:Never closed",
        "BEGIN:VTODO\nDTSTART:20261008T090000\nSUMMARY:A task\nEND:VTODO",
        "BEGIN:VEVENT\nRECURRENCE-ID:what\nDTSTART:20261008T090000\nEND:VEVENT",
        "END:VEVENT\nEND:VEVENT\nBEGIN:\nBEGIN\n:\n::\n;;;:\n",
        "BEGIN:VEVENT\n" * 5000,
    ],
)
def test_garbage_gives_no_events_and_never_raises(text):
    assert ics.parse(text) == []


def test_not_text_at_all_gives_no_events():
    assert ics.parse(None) == [] and ics.parse(42) == [] and ics.parse([]) == []  # type: ignore[arg-type]


def test_bytes_are_read_as_utf8():
    text = feed("UID:a\nDTSTART:20261008T090000\nSUMMARY:Café ☕")
    assert ics.parse(text.encode())[0].title == "Café ☕"  # type: ignore[arg-type]
    assert ics.parse(b"\xff\xfe\x00 not a calendar") == []  # type: ignore[arg-type]


def test_one_bad_event_does_not_hide_the_others_and_order_is_the_files():
    text = feed(
        "UID:first\nDTSTART:20261008T090000\nSUMMARY:One",
        "UID:broken\nDTSTART:never\nSUMMARY:Two",
        "UID:nostart\nSUMMARY:Three",
        "UID:last\nDTSTART;VALUE=DATE:20261001\nSUMMARY:Four",
    )
    assert [(e.uid, e.title) for e in ics.parse(text)] == [("first", "One"), ("last", "Four")]


def test_a_feed_cut_short_loses_only_the_event_that_was_cut():
    text = feed("UID:a\nDTSTART:20261008T090000", "UID:b\nDTSTART:20261009T090000")
    cut = text[: text.rindex("END:VEVENT")]
    assert [e.uid for e in ics.parse(cut)] == ["a"]


def test_a_document_nested_absurdly_deep_is_quick_and_harmless():
    inner = "BEGIN:VEVENT\nDTSTART:20261008T090000\nEND:VEVENT\n"
    began = time.perf_counter()
    ics.parse("BEGIN:X\n" * 100_000 + inner + "END:X\n" * 100_000)
    # (ends that match nothing would each look through everything that is open)
    ics.parse("BEGIN:X\n" * 20_000 + inner + "END:Y\n" * 20_000)
    assert time.perf_counter() - began < 5


def test_a_wrong_end_line_cannot_close_the_wrong_block_into_an_event():
    text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261008T090000\nEND:VALARM\nEND:VCALENDAR\n"
    assert ics.parse(text) == []


def test_mangled_feeds_never_raise():
    """Cut, nibbled and shuffled copies of a realistic feed: whatever they hold, no exception."""
    series = lines(
        "UID:a",
        "DTSTART;TZID=Eastern Standard Time:20261008T090000",
        "DTEND;TZID=Eastern Standard Time:20261008T100000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=20",
        "EXDATE;TZID=Eastern Standard Time:20261012T090000",
        "SUMMARY;LANGUAGE=en-us:Standup",
        'ATTENDEE;CN="A, B";PARTSTAT=ACCEPTED:mailto:a@b.com',
        alarm("TRIGGER:-PT15M"),
    )
    moved = lines(
        "UID:a",
        "RECURRENCE-ID;TZID=Eastern Standard Time:20261012T090000",
        "DTSTART:20261013T140000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Moved",
    )
    leap = "UID:c\nDTSTART;VALUE=DATE:20261008\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"
    good = feed(series, moved, leap)
    rng = random.Random(2026)
    window = (datetime(2026, 1, 1), datetime(2028, 1, 1))
    for _ in range(300):
        text = list(good)
        for _ in range(rng.randrange(1, 12)):
            if not text:
                break
            kind = rng.randrange(3)
            spot = rng.randrange(len(text))
            if kind == 0:
                del text[spot : spot + rng.randrange(1, 40)]
            elif kind == 1:
                text[spot] = rng.choice(';:="\\,\n\r -/0Z')
            else:
                text.insert(spot, rng.choice([";", ":", "\n", "BEGIN:VEVENT\n", "END:VEVENT\n"]))
        mangled = "".join(text)
        if rng.random() < 0.3:
            mangled = mangled[: rng.randrange(len(mangled) + 1)]
        ics.occurrences(ics.parse(mangled), *window)


# ── asking what happens in a window ──


def test_a_plain_event_is_returned_as_it_is_when_it_overlaps_the_window():
    found = ics.parse(feed("UID:a\nDTSTART:20261008T090000\nDTEND:20261008T100000\nSUMMARY:Call"))
    (out,) = ics.occurrences(found, datetime(2026, 10, 8), datetime(2026, 10, 9))
    assert out is found[0]


@pytest.mark.parametrize(
    "window, shown",
    [
        ((datetime(2026, 10, 8, 9), datetime(2026, 10, 8, 10)), True),  # exactly its time
        ((datetime(2026, 10, 8, 9, 59), datetime(2026, 10, 8, 12)), True),  # catches its end
        ((datetime(2026, 10, 8, 8), datetime(2026, 10, 8, 9, 1)), True),  # catches its start
        ((datetime(2026, 10, 8, 10), datetime(2026, 10, 8, 12)), False),  # starts as it ends
        ((datetime(2026, 10, 8, 7), datetime(2026, 10, 8, 9)), False),  # ends as it starts
        ((datetime(2026, 10, 9), datetime(2026, 10, 10)), False),
        ((datetime(2026, 10, 8, 9, 30), datetime(2026, 10, 8, 9, 30)), False),  # an empty window
        ((datetime(2026, 10, 9), datetime(2026, 10, 8)), False),  # a backwards one
    ],
)
def test_overlap_with_the_window_counts_the_start_and_not_the_end(window, shown):
    found = ics.parse(feed("UID:a\nDTSTART:20261008T090000\nDTEND:20261008T100000"))
    assert bool(ics.occurrences(found, *window)) is shown


def test_a_moment_with_no_length_is_in_a_window_that_holds_it():
    found = ics.parse(feed("UID:d2l\nDTSTART:20261008T095900\nDTEND:20261008T095900\nSUMMARY:Due"))
    assert ics.occurrences(found, datetime(2026, 10, 8, 9, 59), datetime(2026, 10, 8, 10))
    assert ics.occurrences(found, datetime(2026, 10, 8, 9, 59), datetime(2026, 10, 8, 9, 59, 1))
    assert not ics.occurrences(found, datetime(2026, 10, 8, 9, 59, 1), datetime(2026, 10, 8, 10))
    assert not ics.occurrences(found, datetime(2026, 10, 8, 10), datetime(2026, 10, 8, 11))
    assert not ics.occurrences(found, datetime(2026, 10, 8, 9), datetime(2026, 10, 8, 9, 59))


def test_a_several_day_event_that_began_before_the_window_is_in_it():
    found = ics.parse(feed("UID:a\nDTSTART;VALUE=DATE:20261005\nDTEND;VALUE=DATE:20261010"))
    assert len(ics.occurrences(found, datetime(2026, 10, 9), datetime(2026, 10, 10))) == 1
    assert ics.occurrences(found, datetime(2026, 10, 10), datetime(2026, 10, 11)) == []


def test_results_are_sorted_by_start_then_title():
    found = ics.parse(
        feed(
            "UID:1\nDTSTART:20261008T110000\nSUMMARY:Late",
            "UID:2\nDTSTART:20261008T090000\nSUMMARY:Beta",
            "UID:3\nDTSTART:20261008T090000\nSUMMARY:Alpha",
            "UID:4\nDTSTART;VALUE=DATE:20261008\nSUMMARY:All day",
        )
    )
    out = ics.occurrences(found, datetime(2026, 10, 8), datetime(2026, 10, 9))
    assert [e.title for e in out] == ["All day", "Alpha", "Beta", "Late"]


def test_a_cancelled_event_is_never_returned_even_when_it_repeats():
    found = ics.parse(
        feed(
            "UID:1\nDTSTART:20261008T090000\nSTATUS:CANCELLED\nSUMMARY:Gone",
            "UID:2\nDTSTART:20261008T090000\nSTATUS:CANCELLED\nRRULE:FREQ=DAILY\nSUMMARY:Gone too",
            "UID:3\nDTSTART:20261008T090000\nSTATUS:TENTATIVE\nSUMMARY:Maybe",
        )
    )
    assert [e.title for e in ics.occurrences(found, *WIDE)] == ["Maybe"]


def test_a_window_with_a_zone_is_read_on_this_machines_clock():
    found = ics.parse(feed("UID:a\nDTSTART:20261008T130000Z"))
    inside = (datetime(2026, 10, 8, 12, tzinfo=UTC), datetime(2026, 10, 8, 14, tzinfo=UTC))
    outside = (datetime(2026, 10, 8, 14, tzinfo=UTC), datetime(2026, 10, 8, 16, tzinfo=UTC))
    assert len(ics.occurrences(found, *inside)) == 1
    assert ics.occurrences(found, *outside) == []


# ── repeating events ──


def test_a_repeat_is_a_copy_the_same_length_with_nothing_left_to_repeat():
    found = ics.parse(
        feed(
            "UID:a\nDTSTART:20261005T090000\nDTEND:20261005T103000\nSUMMARY:Standup\n"
            "LOCATION:Room 1\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261007T090000\n"
            "RDATE:20261020T090000"
        )
    )
    out = ics.occurrences(found, *WIDE)
    assert [(e.start, e.end) for e in out] == [
        (datetime(2026, 10, 5, 9), datetime(2026, 10, 5, 10, 30)),
        (datetime(2026, 10, 6, 9), datetime(2026, 10, 6, 10, 30)),
        (datetime(2026, 10, 20, 9), datetime(2026, 10, 20, 10, 30)),
    ]
    for each in out:
        assert (each.rrule, each.rdates, each.exdates, each.recurrence_id) == ("", (), (), None)
        assert (each.uid, each.title, each.location) == ("a", "Standup", "Room 1")
    assert found[0].rrule == "FREQ=DAILY;COUNT=3"  # the event itself is not touched


def test_weekly_on_monday_wednesday_and_friday_every_other_week():
    got = times(
        "DTSTART:20261005T090000",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 11, 10),
    )
    assert got == days(
        (2026, 10, 5),
        (2026, 10, 7),
        (2026, 10, 9),
        (2026, 10, 19),
        (2026, 10, 21),
        (2026, 10, 23),
        (2026, 11, 2),
        (2026, 11, 4),
        (2026, 11, 6),
    )


@pytest.mark.parametrize(
    "week_starts_on, expected",
    [
        # RFC 5545: the same rule gives different days when the week begins on another day.
        ("MO", "19970805 19970810 19970819 19970824"),
        ("SU", "19970805 19970817 19970819 19970831"),
    ],
)
def test_the_day_a_week_starts_on_matters_when_weeks_are_skipped(week_starts_on, expected):
    got = times(
        "DTSTART:19970805T090000",
        f"RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST={week_starts_on}",
        start=datetime(1997, 8, 1),
        end=datetime(1997, 12, 1),
    )
    assert got == rfc_days(expected)


def test_a_week_starts_on_monday_unless_the_rule_says_otherwise():
    got = times(
        "DTSTART:19970805T090000",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU",
        start=datetime(1997, 8, 1),
        end=datetime(1997, 12, 1),
    )
    assert got == rfc_days("19970805 19970810 19970819 19970824")


def test_monthly_on_the_31st_skips_the_months_that_have_no_31st():
    expected = days(
        (2026, 1, 31),
        (2026, 3, 31),
        (2026, 5, 31),
        (2026, 7, 31),
        (2026, 8, 31),
        (2026, 10, 31),
        (2026, 12, 31),
        (2027, 1, 31),
    )
    window = {"start": datetime(2026, 1, 1), "end": datetime(2027, 2, 15)}
    spelled_out = times("DTSTART:20260131T090000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31", **window)
    assert spelled_out == expected
    assert times("DTSTART:20260131T090000", "RRULE:FREQ=MONTHLY", **window) == expected


def test_monthly_on_the_second_tuesday():
    got = times(
        "DTSTART:20261013T090000",
        "RRULE:FREQ=MONTHLY;BYDAY=2TU",
        start=datetime(2026, 10, 1),
        end=datetime(2027, 4, 1),
    )
    assert got == days(
        (2026, 10, 13), (2026, 11, 10), (2026, 12, 8), (2027, 1, 12), (2027, 2, 9), (2027, 3, 9)
    )


def test_monthly_on_the_last_friday():
    got = times(
        "DTSTART:20261030T090000",
        "RRULE:FREQ=MONTHLY;BYDAY=-1FR",
        start=datetime(2026, 10, 1),
        end=datetime(2027, 4, 1),
    )
    assert got == days(
        (2026, 10, 30), (2026, 11, 27), (2026, 12, 25), (2027, 1, 29), (2027, 2, 26), (2027, 3, 26)
    )


def test_the_last_weekday_of_every_month():
    got = times(
        "DTSTART:20261030T090000",
        "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        start=datetime(2026, 10, 1),
        end=datetime(2027, 4, 1),
    )
    assert got == days(
        (2026, 10, 30), (2026, 11, 30), (2026, 12, 31), (2027, 1, 29), (2027, 2, 26), (2027, 3, 31)
    )


def test_the_last_day_of_the_month_counted_from_the_end():
    got = times(
        "DTSTART:20260131T090000",
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1",
        start=datetime(2026, 1, 1),
        end=datetime(2026, 6, 1),
    )
    assert got == days((2026, 1, 31), (2026, 2, 28), (2026, 3, 31), (2026, 4, 30), (2026, 5, 31))


def test_every_other_month_and_every_third_month():
    window = {"start": datetime(2026, 1, 1), "end": datetime(2027, 1, 1)}
    every_other = times("DTSTART:20260115T090000", "RRULE:FREQ=MONTHLY;INTERVAL=2", **window)
    assert every_other == days(
        (2026, 1, 15), (2026, 3, 15), (2026, 5, 15), (2026, 7, 15), (2026, 9, 15), (2026, 11, 15)
    )
    every_third = times("DTSTART:20260115T090000", "RRULE:FREQ=MONTHLY;INTERVAL=3", **window)
    assert every_third == days((2026, 1, 15), (2026, 4, 15), (2026, 7, 15), (2026, 10, 15))


def test_yearly_on_february_29th_only_happens_in_leap_years():
    got = times(
        "DTSTART:20240229T090000",
        "RRULE:FREQ=YEARLY",
        start=datetime(2024, 1, 1),
        end=datetime(2033, 1, 1),
    )
    assert got == days((2024, 2, 29), (2028, 2, 29), (2032, 2, 29))


def test_yearly_is_the_same_day_each_year_and_in_chosen_months():
    window = {"start": datetime(2026, 1, 1), "end": datetime(2029, 1, 1)}
    plain = times("DTSTART:20260704T090000", "RRULE:FREQ=YEARLY", **window)
    assert plain == days((2026, 7, 4), (2027, 7, 4), (2028, 7, 4))
    chosen = times("DTSTART:20260310T090000", "RRULE:FREQ=YEARLY;BYMONTH=3,9", **window)
    assert chosen == days(
        (2026, 3, 10), (2026, 9, 10), (2027, 3, 10), (2027, 9, 10), (2028, 3, 10), (2028, 9, 10)
    )


def test_yearly_on_the_fourth_thursday_of_november():
    got = times(
        "DTSTART:20261126T090000",
        "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
        start=datetime(2026, 1, 1),
        end=datetime(2030, 1, 1),
    )
    assert got == days((2026, 11, 26), (2027, 11, 25), (2028, 11, 23), (2029, 11, 22))


def test_yearly_on_a_numbered_weekday_of_the_year_when_no_month_is_given():
    got = times(
        "DTSTART:19970519T090000",
        "RRULE:FREQ=YEARLY;BYDAY=20MO",
        start=datetime(1997, 1, 1),
        end=datetime(2000, 1, 1),
    )
    assert got == days((1997, 5, 19), (1998, 5, 18), (1999, 5, 17))


def test_every_weekday_and_nothing_at_weekends():
    got = times(
        "DTSTART:20261005T090000",
        "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=10",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days(
        (2026, 10, 5),
        (2026, 10, 6),
        (2026, 10, 7),
        (2026, 10, 8),
        (2026, 10, 9),
        (2026, 10, 12),
        (2026, 10, 13),
        (2026, 10, 14),
        (2026, 10, 15),
        (2026, 10, 16),
    )


def test_every_day_that_is_the_first_or_the_last_of_its_month():
    got = times(
        "DTSTART:20261001T090000",
        "RRULE:FREQ=DAILY;BYMONTHDAY=-1,1;COUNT=6",
        start=datetime(2026, 9, 1),
        end=datetime(2027, 6, 1),
    )
    assert got == days(
        (2026, 10, 1), (2026, 10, 31), (2026, 11, 1), (2026, 11, 30), (2026, 12, 1), (2026, 12, 31)
    )


def test_every_friday_but_only_in_the_months_named():
    got = times(
        "DTSTART:20261002T090000",
        "RRULE:FREQ=WEEKLY;BYDAY=FR;BYMONTH=10,12",
        start=datetime(2026, 9, 1),
        end=datetime(2027, 3, 1),
    )
    assert got == days(
        (2026, 10, 2),
        (2026, 10, 9),
        (2026, 10, 16),
        (2026, 10, 23),
        (2026, 10, 30),
        (2026, 12, 4),
        (2026, 12, 11),
        (2026, 12, 18),
        (2026, 12, 25),
    )


def test_a_count_of_one_is_just_the_start():
    got = times(
        "DTSTART:20261005T090000",
        "RRULE:FREQ=DAILY;COUNT=1",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days((2026, 10, 5))


def test_a_start_that_does_not_fit_its_own_rule_is_still_the_first_time():
    got = times(
        "DTSTART:20261007T090000",  # a Wednesday
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days((2026, 10, 7), (2026, 10, 12), (2026, 10, 19))


def test_a_count_includes_the_times_before_the_window_and_the_excused_ones():
    base = ("DTSTART:20261005T090000", "RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20261007T090000")
    everything = times(*base, start=datetime(2026, 10, 1), end=datetime(2026, 11, 1))
    assert everything == days((2026, 10, 5), (2026, 10, 6), (2026, 10, 8), (2026, 10, 9))
    later = times(*base, start=datetime(2026, 10, 8), end=datetime(2026, 11, 1))
    assert later == days((2026, 10, 8), (2026, 10, 9))  # not five more: the count began on the 5th
    assert times(*base, start=datetime(2026, 10, 10), end=datetime(2026, 11, 1)) == []


@pytest.mark.parametrize(
    "until, last_day",
    [
        ("20261008", 8),  # a date takes in the whole day
        ("20261008T090000", 8),  # a time that is exactly one of them is in
        ("20261008T085959", 7),
        ("20261007", 7),
    ],
)
def test_until_is_the_last_day_or_time_that_still_counts(until, last_day):
    got = times(
        "DTSTART:20261005T090000",
        f"RRULE:FREQ=DAILY;UNTIL={until}",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 11, 1),
    )
    assert got == days(*[(2026, 10, d) for d in range(5, last_day + 1)])


@needs_zones
@pytest.mark.parametrize("until, last_day", [("20261008T130000Z", 8), ("20261008T125959Z", 7)])
def test_an_until_in_utc_is_compared_as_a_moment_not_as_a_clock_reading(until, last_day):
    """9:00 in New York on 8 October is 13:00Z (daylight saving), whatever zone this machine is in."""
    got = times(
        "DTSTART;TZID=America/New_York:20261005T090000",
        f"RRULE:FREQ=DAILY;UNTIL={until}",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 11, 1),
    )
    assert got == [at("America/New_York", 2026, 10, d, 9) for d in range(5, last_day + 1)]


def test_a_long_repeating_event_that_began_before_the_window_is_in_it():
    """Each lasts five days: the window opens on the fourth day of the third one."""
    found = ics.parse(
        feed(
            "UID:a\nDTSTART;VALUE=DATE:20261001\nDTEND;VALUE=DATE:20261006\n"
            "RRULE:FREQ=WEEKLY;COUNT=4"
        )
    )
    out = ics.occurrences(found, datetime(2026, 10, 18), datetime(2026, 10, 19))
    assert [(e.start, e.end) for e in out] == [(datetime(2026, 10, 15), datetime(2026, 10, 20))]


@needs_zones
def test_the_same_for_a_long_repeating_event_in_a_zone():
    found = ics.parse(
        feed(
            "UID:a\nDTSTART;TZID=America/New_York:20261001T090000\n"
            "DTEND;TZID=America/New_York:20261006T090000\nRRULE:FREQ=WEEKLY;COUNT=4"
        )
    )
    window = (at("America/New_York", 2026, 10, 18), at("America/New_York", 2026, 10, 19))
    out = ics.occurrences(found, *window)
    assert [e.start for e in out] == [at("America/New_York", 2026, 10, 15, 9)]


def test_extra_dates_are_added_and_not_doubled_and_excused_ones_are_removed():
    got = times(
        "DTSTART:20261005T090000",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "RDATE:20261008T090000,20261012T090000",  # the 12th is already one of the rule's
        "RDATE;VALUE=PERIOD:20261030T090000/20261030T100000",
        "EXDATE:20261019T090000",
        "EXDATE:20261008T090000",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days((2026, 10, 5), (2026, 10, 12), (2026, 10, 30))


def test_an_event_with_only_extra_dates_happens_on_its_start_and_those_dates():
    got = times(
        "DTSTART:20261005T090000",
        "RDATE:20261008T090000",
        "RDATE:20261003T090000",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days((2026, 10, 3), (2026, 10, 5), (2026, 10, 8))


def test_an_all_day_event_repeats_on_dates_and_keeps_its_length():
    found = ics.parse(
        feed(
            "UID:a\nDTSTART;VALUE=DATE:20261008\nDTEND;VALUE=DATE:20261010\n"
            "RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;VALUE=DATE:20261015"
        )
    )
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2026, 12, 1))
    assert [(e.start, e.end) for e in out] == [
        (datetime(2026, 10, 8), datetime(2026, 10, 10)),
        (datetime(2026, 10, 22), datetime(2026, 10, 24)),
        (datetime(2026, 10, 29), datetime(2026, 10, 31)),
    ]
    assert all(e.all_day for e in out)


@needs_zones
def test_outlooks_flagged_all_day_series_stays_on_its_dates_whatever_the_zone():
    found = ics.parse(
        feed(
            lines(
                "UID:a",
                "DTSTART;TZID=Eastern Standard Time:20261009T000000",
                "DTEND;TZID=Eastern Standard Time:20261010T000000",
                "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
                "RRULE:FREQ=DAILY;COUNT=4",
                "EXDATE;TZID=Eastern Standard Time:20261010T000000",
            )
        )
    )
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2026, 11, 1))
    assert [e.start for e in out] == [datetime(2026, 10, d) for d in (9, 11, 12)]


# ── the examples in RFC 5545 (3.8.5.3) ──

JANUARIES = " ".join(f"{y}01{d:02d}" for y in (1998, 1999, 2000) for d in range(1, 32))

RFC = [
    ("daily 10 times", "19970902", "FREQ=DAILY;COUNT=10", "19970902 19970903 19970904 19970905 "
     "19970906 19970907 19970908 19970909 19970910 19970911"),
    ("every other day", "19970902", "FREQ=DAILY;INTERVAL=2;COUNT=5",
     "19970902 19970904 19970906 19970908 19970910"),
    ("every 10 days", "19970902", "FREQ=DAILY;INTERVAL=10;COUNT=5",
     "19970902 19970912 19970922 19971002 19971012"),
    ("every Tuesday", "19970902", "FREQ=WEEKLY;COUNT=4", "19970902 19970909 19970916 19970923"),
    ("Tuesday and Thursday for five weeks", "19970902",
     "FREQ=WEEKLY;UNTIL=19971007T000000;WKST=SU;BYDAY=TU,TH",
     "19970902 19970904 19970909 19970911 19970916 19970918 19970923 19970925 19970930 19971002"),
    ("every other week on Monday, Wednesday and Friday", "19970901",
     "FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000;WKST=SU;BYDAY=MO,WE,FR",
     "19970901 19970903 19970905 19970915 19970917 19970919 19970929 19971001 19971003 19971013 "
     "19971015 19971017 19971027 19971029 19971031 19971110 19971112 19971114 19971124 19971126 "
     "19971128 19971208 19971210 19971212 19971222"),
    ("every other week on Tuesday and Thursday, 8 times", "19970902",
     "FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH",
     "19970902 19970904 19970916 19970918 19970930 19971002 19971014 19971016"),
    ("the first Friday of the month, 10 times", "19970905", "FREQ=MONTHLY;COUNT=10;BYDAY=1FR",
     "19970905 19971003 19971107 19971205 19980102 19980206 19980306 19980403 19980501 19980605"),
    ("the first and last Sunday of every other month", "19970907",
     "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU",
     "19970907 19970928 19971102 19971130 19980104 19980125 19980301 19980329 19980503 19980531"),
    ("the second to last Monday, 6 months", "19970922", "FREQ=MONTHLY;COUNT=6;BYDAY=-2MO",
     "19970922 19971020 19971117 19971222 19980119 19980216"),
    ("the third to last day of the month", "19970928", "FREQ=MONTHLY;COUNT=6;BYMONTHDAY=-3",
     "19970928 19971029 19971128 19971229 19980129 19980226"),
    ("the 2nd and 15th of the month", "19970902", "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15",
     "19970902 19970915 19971002 19971015 19971102 19971115 19971202 19971215 19980102 19980115"),
    ("the first and last day of the month", "19970930", "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1",
     "19970930 19971001 19971031 19971101 19971130 19971201 19971231 19980101 19980131 19980201"),
    ("days 10 to 15 every 18 months", "19970910",
     "FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15",
     "19970910 19970911 19970912 19970913 19970914 19970915 19990310 19990311 19990312 19990313"),
    ("the 15th and 30th: an invalid date (30 February) is ignored", "20070115",
     "FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5", "20070115 20070130 20070215 20070315 20070330"),
    ("June and July for 10 occurrences", "19970610", "FREQ=YEARLY;COUNT=10;BYMONTH=6,7",
     "19970610 19970710 19980610 19980710 19990610 19990710 20000610 20000710 20010610 20010710"),
    ("January, February and March every other year", "19970310",
     "FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3",
     "19970310 19990110 19990210 19990310 20010110 20010210 20010310 20030110 20030210 20030310"),
    ("every Thursday in March", "19970313", "FREQ=YEARLY;BYMONTH=3;BYDAY=TH;COUNT=11",
     "19970313 19970320 19970327 19980305 19980312 19980319 19980326 19990304 19990311 19990318 "
     "19990325"),
    ("every Thursday in June, July and August", "19970605",
     "FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8;COUNT=13",
     "19970605 19970612 19970619 19970626 19970703 19970710 19970717 19970724 19970731 19970807 "
     "19970814 19970821 19970828"),
    ("the first Saturday that follows the first Sunday of the month", "19970913",
     "FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13;COUNT=10",
     "19970913 19971011 19971108 19971213 19980110 19980207 19980307 19980411 19980509 19980613"),
    ("US presidential election day", "19961105",
     "FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8;COUNT=3",
     "19961105 20001107 20041102"),
    ("the third of Tuesday, Wednesday or Thursday of the month", "19970904",
     "FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3", "19970904 19971007 19971106"),
    ("the second to last weekday of the month", "19970929",
     "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2;COUNT=6",
     "19970929 19971030 19971127 19971230 19980129 19980226"),
    ("every day in January, for 3 years", "19980101",
     "FREQ=YEARLY;UNTIL=20000131;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA", JANUARIES),
    ("every day in January, the daily way", "19980101",
     "FREQ=DAILY;UNTIL=20000131T235959;BYMONTH=1", JANUARIES),
]  # fmt: skip


@pytest.mark.parametrize("what, start, rule, expected", RFC, ids=[row[0] for row in RFC])
def test_the_examples_in_the_standard(what, start, rule, expected):
    got = times(
        f"DTSTART:{start}T090000",
        f"RRULE:{rule}",
        start=datetime(1996, 1, 1),
        end=datetime(2010, 1, 1),
    )
    assert got == rfc_days(expected)


def test_friday_the_13th_with_the_start_excused_as_in_the_standard():
    got = times(
        "DTSTART:19970902T090000",
        "RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
        "EXDATE:19970902T090000",
        start=datetime(1997, 1, 1),
        end=datetime(2001, 1, 1),
    )
    assert got == rfc_days("19980213 19980313 19981113 19990813 20001013")


# ── moved and cancelled repeats ──

SERIES = lines(
    "UID:series",
    "DTSTART:20261005T090000",
    "DTEND:20261005T100000",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Standup",
    "LOCATION:Room 1",
)


def test_a_moved_repeat_replaces_the_one_it_names_and_its_own_details_win():
    moved = lines(
        "UID:series",
        "RECURRENCE-ID:20261012T090000",
        "DTSTART:20261013T140000",
        "DTEND:20261013T150000",
        "SUMMARY:Standup (moved)",
        "LOCATION:Room 2",
    )
    found = ics.parse(feed(SERIES, moved))
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2026, 11, 7))
    assert [(e.start, e.title, e.location) for e in out] == [
        (datetime(2026, 10, 5, 9), "Standup", "Room 1"),
        (datetime(2026, 10, 13, 14), "Standup (moved)", "Room 2"),
        (datetime(2026, 10, 19, 9), "Standup", "Room 1"),
        (datetime(2026, 10, 26, 9), "Standup", "Room 1"),
        (datetime(2026, 11, 2, 9), "Standup", "Room 1"),
    ]
    assert out[1].end == datetime(2026, 10, 13, 15)


def test_a_cancelled_repeat_is_removed_and_is_not_itself_returned():
    cancelled = lines(
        "UID:series",
        "RECURRENCE-ID:20261019T090000",
        "DTSTART:20261019T090000",
        "STATUS:CANCELLED",
        "SUMMARY:Standup",
    )
    got = times(SERIES, start=datetime(2026, 10, 1), end=datetime(2026, 11, 7), extra=(cancelled,))
    assert got == days((2026, 10, 5), (2026, 10, 12), (2026, 10, 26), (2026, 11, 2))


def test_a_repeat_moved_into_the_window_shows_though_the_one_it_replaced_is_outside():
    moved = lines(
        "UID:series", "RECURRENCE-ID:20261012T090000", "DTSTART:20261021T140000", "SUMMARY:Later"
    )
    got = times(SERIES, start=datetime(2026, 10, 21), end=datetime(2026, 10, 22), extra=(moved,))
    assert got == [datetime(2026, 10, 21, 14)]


def test_a_repeat_moved_out_of_the_window_no_longer_shows_in_it():
    moved = lines(
        "UID:series", "RECURRENCE-ID:20261012T090000", "DTSTART:20261021T140000", "SUMMARY:Later"
    )
    got = times(SERIES, start=datetime(2026, 10, 12), end=datetime(2026, 10, 13), extra=(moved,))
    assert got == []


def test_a_change_to_one_series_does_not_touch_another_with_a_different_uid():
    other = lines("UID:other", "DTSTART:20261005T150000", "RRULE:FREQ=WEEKLY", "SUMMARY:Other")
    cancelled = lines(
        "UID:series", "RECURRENCE-ID:20261012T090000", "DTSTART:20261012T090000", "STATUS:CANCELLED"
    )
    found = ics.parse(feed(SERIES, other, cancelled))
    out = ics.occurrences(found, datetime(2026, 10, 12), datetime(2026, 10, 13))
    assert [(e.uid, e.start) for e in out] == [("other", datetime(2026, 10, 12, 15))]


def test_a_changed_repeat_whose_series_is_not_in_the_feed_still_shows():
    lone = lines(
        "UID:gone", "RECURRENCE-ID:20261012T090000", "DTSTART:20261013T140000", "SUMMARY:Alone"
    )
    out = ics.occurrences(ics.parse(feed(lone)), *WIDE)
    assert [(e.title, e.start) for e in out] == [("Alone", datetime(2026, 10, 13, 14))]
    assert out[0].recurrence_id == datetime(2026, 10, 12, 9)


def test_a_changed_repeat_also_replaces_a_one_off_event_with_the_same_id():
    once = lines("UID:x", "DTSTART:20261005T090000", "SUMMARY:Original")
    moved = lines(
        "UID:x", "RECURRENCE-ID:20261005T090000", "DTSTART:20261006T100000", "SUMMARY:Moved"
    )
    found = ics.parse(feed(once, moved))
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2026, 11, 1))
    assert [(e.title, e.start) for e in out] == [("Moved", datetime(2026, 10, 6, 10))]


@needs_zones
def test_a_moved_repeat_is_matched_though_its_id_is_written_in_another_zone():
    series = lines(
        "UID:s",
        "DTSTART;TZID=America/New_York:20261005T090000",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "SUMMARY:Standup",
    )
    cancelled = lines(
        "UID:s", "RECURRENCE-ID:20261012T130000Z", "DTSTART:20261012T130000Z", "STATUS:CANCELLED"
    )  # 13:00Z is 9:00 in New York
    got = times(series, start=datetime(2026, 10, 1), end=datetime(2026, 11, 1), extra=(cancelled,))
    assert got == [at("America/New_York", 2026, 10, d, 9) for d in (5, 19)]


# ── zones and clock changes ──


@needs_zones
def test_a_daily_nine_oclock_in_new_york_stays_nine_oclock_there_across_the_clock_change():
    got = times(
        "DTSTART;TZID=America/New_York:20260306T090000",
        "RRULE:FREQ=DAILY;COUNT=5",
        start=datetime(2026, 3, 1),
        end=datetime(2026, 3, 20),
    )
    assert got == [at("America/New_York", 2026, 3, d, 9) for d in (6, 7, 8, 9, 10)]


@needs_zones
def test_the_same_in_autumn_when_the_clocks_go_back():
    got = times(
        "DTSTART;TZID=America/New_York:20261030T090000",
        "RRULE:FREQ=DAILY;COUNT=5",
        start=datetime(2026, 10, 25),
        end=datetime(2026, 11, 10),
    )
    nine = [(2026, 10, 30), (2026, 10, 31), (2026, 11, 1), (2026, 11, 2), (2026, 11, 3)]
    assert got == [at("America/New_York", *day, 9) for day in nine]


@needs_zones
def test_a_weekly_meeting_in_london_follows_london_time_through_both_changes():
    got = times(
        "DTSTART;TZID=Europe/London:20260320T100000",
        "RRULE:FREQ=WEEKLY;COUNT=40",
        start=datetime(2026, 3, 1),
        end=datetime(2027, 1, 1),
    )
    first = datetime(2026, 3, 20)
    weeks = [first + timedelta(weeks=n) for n in range(40)]
    assert got == [at("Europe/London", d.year, d.month, d.day, 10) for d in weeks]


def test_a_clock_change_on_this_machine_does_not_move_a_floating_series(machine_zone):
    machine_zone("America/New_York")
    got = times(
        "DTSTART:20261030T090000",
        "RRULE:FREQ=DAILY;COUNT=5",
        start=datetime(2026, 10, 25),
        end=datetime(2026, 11, 10),
    )
    assert got == days((2026, 10, 30), (2026, 10, 31), (2026, 11, 1), (2026, 11, 2), (2026, 11, 3))


def test_on_a_machine_in_utc_the_new_york_meeting_moves_an_hour_when_new_york_changes(machine_zone):
    machine_zone("UTC")
    got = times(
        "DTSTART;TZID=America/New_York:20260306T090000",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        start=datetime(2026, 3, 1),
        end=datetime(2026, 4, 1),
    )
    assert got == [datetime(2026, 3, 6, 14), datetime(2026, 3, 13, 13), datetime(2026, 3, 20, 13)]


def test_the_window_is_read_on_this_machines_clock_not_the_events(machine_zone):
    machine_zone("Asia/Tokyo")
    # 20:00 in New York (daylight saving) is 09:00 the next morning in Tokyo.
    rows = ("DTSTART;TZID=America/New_York:20261005T200000", "RRULE:FREQ=DAILY;COUNT=3")
    tokyo_morning = times(*rows, start=datetime(2026, 10, 6), end=datetime(2026, 10, 7))
    assert tokyo_morning == [datetime(2026, 10, 6, 9)]
    assert times(*rows, start=datetime(2026, 10, 5), end=datetime(2026, 10, 6)) == []
    everything = times(*rows, start=datetime(2026, 10, 1), end=datetime(2026, 11, 1))
    assert everything == days((2026, 10, 6), (2026, 10, 7), (2026, 10, 8))


def test_times_in_utc_and_zones_land_on_the_right_local_clock(machine_zone):
    machine_zone("Asia/Kolkata")
    assert one("DTSTART:20261008T130000Z").start == datetime(2026, 10, 8, 18, 30)
    eastern = one("DTSTART;TZID=Eastern Standard Time:20261008T090000")
    assert eastern.start == datetime(2026, 10, 8, 18, 30)
    london = one("DTSTART;TZID=Europe/London:20261008T090000")
    assert london.start == datetime(2026, 10, 8, 13, 30)


def test_a_series_that_starts_in_the_hour_this_machines_clock_reads_twice_is_not_shifted(
    machine_zone,
):
    """09:00 in London on 3 November 2030 is 01:00 in Los Angeles, the second time round that
    night (the clocks there went back at 02:00 PDT). Reading that start back as the first
    01:00 would move every repeat of the series an hour."""
    machine_zone("America/Los_Angeles")
    found = ics.parse(
        feed("UID:a\nDTSTART;TZID=Europe/London:20301103T090000\nRRULE:FREQ=WEEKLY;COUNT=3")
    )
    assert found[0].start == datetime(2030, 11, 3, 1)
    out = ics.occurrences(found, datetime(2030, 11, 1), datetime(2030, 12, 1))
    assert [e.start for e in out] == [datetime(2030, 11, d, 1) for d in (3, 10, 17)]
    assert out[0].start.timestamp() == datetime(2030, 11, 3, 9, tzinfo=UTC).timestamp()


def test_asking_this_machines_clock_about_a_year_it_cannot_answer_still_gives_a_time():
    """Windows can't convert times before 1970 (or after 3000); the answer then uses the offset
    of today rather than raising."""

    class NoClock(datetime):
        def astimezone(self, tz=None):
            if tz is None:
                raise OSError(22, "Invalid argument")
            return super().astimezone(tz)

    moment = NoClock(1960, 5, 1, 12, tzinfo=UTC)
    today = datetime.now().astimezone().utcoffset()
    assert ics._local(moment) == datetime(1960, 5, 1, 12) + today


# ── speed and limits ──


def test_a_daily_event_started_in_2015_is_quick_to_ask_about_in_2026():
    found = ics.parse(feed("UID:a\nDTSTART:20150101T090000\nRRULE:FREQ=DAILY\nSUMMARY:Old"))
    began = time.perf_counter()
    out = ics.occurrences(found, datetime(2026, 10, 8), datetime(2026, 10, 11))
    assert time.perf_counter() - began < 1
    assert [e.start for e in out] == days((2026, 10, 8), (2026, 10, 9), (2026, 10, 10))


@pytest.mark.parametrize(
    "rule",
    [
        "FREQ=DAILY",
        "FREQ=DAILY;INTERVAL=3",
        "FREQ=WEEKLY;BYDAY=MO,TH",
        "FREQ=MONTHLY;BYDAY=2TU",
        "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
        "FREQ=DAILY;COUNT=20000",
        "FREQ=WEEKLY;COUNT=5000",
        "FREQ=DAILY;UNTIL=20991231",
    ],
)
def test_rules_started_long_ago_all_answer_quickly(rule):
    found = ics.parse(feed(f"UID:a\nDTSTART:20150101T090000\nRRULE:{rule}"))
    began = time.perf_counter()
    ics.occurrences(found, datetime(2026, 10, 8), datetime(2026, 11, 8))
    assert time.perf_counter() - began < 1


def every(start: datetime, step: timedelta, first: datetime, last: datetime):
    """The moments start, start + step, start + 2 step... that fall in [first, last)."""
    skipped = max(0, (first - start) // step)
    moment = start + skipped * step
    while moment < last:
        if moment >= first:
            yield moment
        moment += step


def month_number(day: datetime) -> int:
    return day.year * 12 + day.month - 1


# A series that began so long ago that stepping through it one period at a time would run out
# of steps (50,000) before reaching today: it has to be jumped to, and land on the right phase.
LONG_AGO = [
    ("FREQ=DAILY", datetime(1850, 1, 1, 9), lambda d: True),
    (
        "FREQ=DAILY;INTERVAL=3",
        datetime(1850, 1, 1, 9),
        lambda d: (d - datetime(1850, 1, 1, 9)).days % 3 == 0,
    ),
    (
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
        datetime(1850, 1, 7, 9),  # a Monday
        lambda d: ((d - datetime(1850, 1, 7, 9)).days // 7) % 2 == 0 and d.weekday() in (0, 3),
    ),
    (
        "FREQ=WEEKLY;INTERVAL=3;BYDAY=SU,WE;WKST=SU",
        datetime(1850, 1, 6, 9),  # a Sunday, so the weeks run Sunday to Saturday from there
        lambda d: ((d - datetime(1850, 1, 6, 9)).days // 7) % 3 == 0 and d.weekday() in (6, 2),
    ),
    (
        "FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=15",
        datetime(1850, 1, 15, 9),
        lambda d: (month_number(d) - month_number(datetime(1850, 1, 1))) % 5 == 0 and d.day == 15,
    ),
    (
        "FREQ=YEARLY;INTERVAL=7",
        datetime(1850, 3, 10, 9),
        lambda d: (d.year - 1850) % 7 == 0 and (d.month, d.day) == (3, 10),
    ),
]


@pytest.mark.parametrize("rule, began, fits", LONG_AGO, ids=[row[0] for row in LONG_AGO])
@pytest.mark.parametrize("year", [2026, 2027, 2028, 2032, 2036, 2200])
def test_a_series_that_began_in_1850_is_jumped_to_and_keeps_its_phase(rule, began, fits, year):
    found = ics.parse(feed(f"UID:a\nDTSTART:{began:%Y%m%dT%H%M%S}\nRRULE:{rule}"))
    first, last = datetime(year, 1, 1), datetime(year + 1, 1, 1)
    started = time.perf_counter()
    out = ics.occurrences(found, first, last)
    assert time.perf_counter() - started < 1
    every_day = every(datetime(year, 1, 1, 9), timedelta(days=1), first, last)
    assert [e.start for e in out] == [day for day in every_day if fits(day)]


def test_a_count_that_is_never_reached_does_not_walk_for_ever_to_a_far_window():
    """Counting has to start at the start, so a window a millennium away would take a million
    steps; it gives up after 50,000 and finds nothing, quickly."""
    found = ics.parse(feed("UID:a\nDTSTART:20260101T090000\nRRULE:FREQ=DAILY;COUNT=100000000"))
    began = time.perf_counter()
    out = ics.occurrences(found, datetime(9900, 1, 1), datetime(9900, 1, 10))
    assert time.perf_counter() - began < 3
    assert out == []


@pytest.mark.parametrize("last_year", [2090, 9000])
@pytest.mark.parametrize(
    "rule", ["FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31;COUNT=9"]
)
def test_a_rule_that_never_matches_anything_ends_instead_of_looping_for_ever(rule, last_year):
    found = ics.parse(feed(f"UID:a\nDTSTART:20260101T090000\nRRULE:{rule}"))
    began = time.perf_counter()
    out = ics.occurrences(found, datetime(2026, 1, 1), datetime(last_year, 1, 1))
    assert time.perf_counter() - began < 5
    assert [e.start for e in out] == [datetime(2026, 1, 1, 9)]  # (only the start itself)


def test_the_limit_keeps_the_earliest_results():
    found = ics.parse(feed("UID:a\nDTSTART:20261001T090000\nRRULE:FREQ=DAILY\nSUMMARY:Daily"))
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2030, 1, 1), limit=5)
    assert [e.start for e in out] == [datetime(2026, 10, d, 9) for d in range(1, 6)]
    assert len(ics.occurrences(found, datetime(2026, 10, 1), datetime(2040, 1, 1))) == 3000
    assert ics.occurrences(found, datetime(2026, 10, 1), datetime(2030, 1, 1), limit=0) == []


def test_the_limit_is_taken_across_events_by_time_not_by_which_came_first_in_the_file():
    found = ics.parse(
        feed(
            "UID:late\nDTSTART:20261020T090000\nRRULE:FREQ=DAILY\nSUMMARY:Late",
            "UID:early\nDTSTART:20261001T090000\nRRULE:FREQ=DAILY\nSUMMARY:Early",
            "UID:one\nDTSTART:20261003T120000\nSUMMARY:Single",
        )
    )
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2027, 1, 1), limit=6)
    assert [(e.title, e.start.day) for e in out] == [
        ("Early", 1),
        ("Early", 2),
        ("Early", 3),
        ("Single", 3),
        ("Early", 4),
        ("Early", 5),
    ]


def test_a_huge_window_costs_no_more_than_the_limit():
    found = ics.parse(feed("UID:a\nDTSTART:20260101T090000\nRRULE:FREQ=DAILY"))
    began = time.perf_counter()
    out = ics.occurrences(found, datetime(1990, 1, 1), datetime(9000, 1, 1), limit=10)
    assert time.perf_counter() - began < 1
    assert [e.start for e in out] == [datetime(2026, 1, d, 9) for d in range(1, 11)]


def test_a_whole_big_feed_is_read_and_asked_about_quickly():
    parts = []
    for n in range(2000):
        repeat = "RRULE:FREQ=WEEKLY;BYDAY=MO,WE" if n % 4 == 0 else "X-NOTE:none"
        parts.append(
            lines(
                f"UID:e{n}",
                "DTSTART;TZID=Eastern Standard Time:20261008T090000",
                "DTEND;TZID=Eastern Standard Time:20261008T100000",
                f"SUMMARY:Event {n}",
                "DESCRIPTION:" + "Join: https://teams.microsoft.com/l/meetup-join/x\\n" * 30,
                repeat,
            )
        )
    text = feed(*parts)
    began = time.perf_counter()
    found = ics.parse(text)
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2027, 4, 1))
    assert len(found) == 2000 and len(out) == 3000
    assert time.perf_counter() - began < 10


# ── what is left alone rather than guessed ──


@pytest.mark.parametrize(
    "rule",
    [
        "FREQ=HOURLY;COUNT=5",
        "FREQ=MINUTELY",
        "FREQ=SECONDLY",
        "FREQ=DAILY;BYHOUR=9,17",
        "FREQ=DAILY;BYMINUTE=30",
        "FREQ=WEEKLY;BYSECOND=5",
        "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
        "FREQ=YEARLY;BYYEARDAY=1,100,200",
        "FREQ=MONTHLY;RSCALE=HEBREW",
        "FREQ=MONTHLY;SKIP=FORWARD",
        "FREQ=WEEKLY;BYMONTHDAY=15",  # the standard forbids this one
    ],
)
def test_a_rule_that_cannot_be_worked_out_honestly_gives_only_the_first_time(rule):
    found = ics.parse(feed(f"UID:a\nDTSTART:20261005T090000\nDTEND:20261005T100000\nRRULE:{rule}"))
    out = ics.occurrences(found, datetime(2026, 1, 1), datetime(2030, 1, 1))
    assert [(e.start, e.end, e.rrule) for e in out] == [
        (datetime(2026, 10, 5, 9), datetime(2026, 10, 5, 10), "")
    ]


@pytest.mark.parametrize(
    "rule",
    [
        "",
        "NONSENSE",
        "FREQ=FORTNIGHTLY",
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=DAILY;INTERVAL=two",
        "FREQ=DAILY;COUNT=0",
        "FREQ=DAILY;COUNT=many",
        "FREQ=DAILY;UNTIL=someday",
        "FREQ=WEEKLY;BYDAY=XX",
        "FREQ=WEEKLY;BYDAY=99MO",
        "FREQ=MONTHLY;BYMONTHDAY=0",
        "FREQ=MONTHLY;BYMONTHDAY=32",
        "FREQ=YEARLY;BYMONTH=13",
        "FREQ=YEARLY;BYMONTH=-1",
        "FREQ=WEEKLY;WKST=XX",
        "FREQ=MONTHLY;BYSETPOS=0",
        "=;=;;",
    ],
)
def test_a_broken_rule_never_raises_and_gives_only_the_first_time(rule):
    found = ics.parse(feed(f"UID:a\nDTSTART:20261005T090000\nRRULE:{rule}"))
    out = ics.occurrences(found, datetime(2026, 1, 1), datetime(2030, 1, 1))
    assert [e.start for e in out] == [datetime(2026, 10, 5, 9)]


def test_the_rule_is_kept_raw_on_the_event_and_unknown_extension_parts_are_ignored():
    event = one("DTSTART:20261005T090000", "RRULE:FREQ=WEEKLY;X-NOTE=hello;COUNT=3")
    assert event.rrule == "FREQ=WEEKLY;X-NOTE=hello;COUNT=3"
    out = ics.occurrences([event], datetime(2026, 1, 1), datetime(2030, 1, 1))
    assert [e.start for e in out] == days((2026, 10, 5), (2026, 10, 12), (2026, 10, 19))


def test_rules_in_lower_case_work():
    got = times(
        "DTSTART:20261005T090000",
        "RRULE:freq=weekly;byday=mo,we;count=3",
        start=datetime(2026, 10, 1),
        end=datetime(2026, 12, 1),
    )
    assert got == days((2026, 10, 5), (2026, 10, 7), (2026, 10, 12))


def test_the_rdates_exdates_and_recurrence_id_are_on_this_machines_clock():
    event = one(
        "DTSTART:20261005T090000",
        "RRULE:FREQ=DAILY",
        "RDATE:20261031T090000Z",
        "EXDATE:20261006T090000,20261007T090000",
        "EXDATE;VALUE=DATE:20261008",
        "RECURRENCE-ID:20261001T090000Z",
    )
    assert event.rdates == (utc(2026, 10, 31, 9),)
    assert event.exdates == (
        datetime(2026, 10, 6, 9),
        datetime(2026, 10, 7, 9),
        datetime(2026, 10, 8),
    )
    assert event.recurrence_id == utc(2026, 10, 1, 9)


# ── against a slow, day-by-day reading of the standard ──

WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


@dataclasses.dataclass
class Plan:
    """A repeat rule as these tests draw it at random, before it is written out as an RRULE.
    `days` is BYDAY as (which one in the month or year, 0 for every one; weekday, Monday 0)."""

    frequency: str
    interval: int = 1
    count: int | None = None
    until: date | datetime | None = None
    days: tuple[tuple[int, int], ...] = ()
    month_days: tuple[int, ...] = ()
    months: tuple[int, ...] = ()
    positions: tuple[int, ...] = ()
    week_start: int = 0

    def text(self) -> str:
        parts = [f"FREQ={self.frequency}", f"INTERVAL={self.interval}"]
        if self.count is not None:
            parts.append(f"COUNT={self.count}")
        if isinstance(self.until, datetime):
            parts.append(f"UNTIL={self.until:%Y%m%dT%H%M%S}")
        elif self.until is not None:
            parts.append(f"UNTIL={self.until:%Y%m%d}")
        if self.days:
            parts.append("BYDAY=" + ",".join(f"{w or ''}{WEEKDAY_CODES[d]}" for w, d in self.days))
        for name, numbers in [
            ("BYMONTHDAY", self.month_days),
            ("BYMONTH", self.months),
            ("BYSETPOS", self.positions),
        ]:
            if numbers:
                parts.append(f"{name}=" + ",".join(map(str, numbers)))
        parts.append(f"WKST={WEEKDAY_CODES[self.week_start]}")
        return ";".join(parts)


def random_plan(rng: random.Random) -> Plan:
    frequency = rng.choice(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
    plan = Plan(frequency, rng.choice([1, 1, 1, 2, 3, 4, 5, 7, 12]), week_start=rng.randrange(7))
    # (the standard allows days of the month with every frequency but weekly)
    if frequency != "WEEKLY" and rng.random() < 0.3:
        plan.month_days = tuple(rng.sample([*range(1, 32), *range(-31, 0)], rng.choice([1, 2, 3])))
    if rng.random() < 0.6:
        numbered = frequency in ("MONTHLY", "YEARLY") and not plan.month_days
        whichs = [1, 2, 3, 4, -1, -2] + ([20, -10] if frequency == "YEARLY" else [])
        plan.days = tuple(
            (rng.choice(whichs) if numbered and rng.random() < 0.6 else 0, weekday)
            for weekday in rng.sample(range(7), rng.choice([1, 2, 3, 5]))
        )
    if rng.random() < 0.35:
        plan.months = tuple(sorted(rng.sample(range(1, 13), rng.choice([1, 1, 2, 3, 6]))))
    if (plan.days or plan.month_days or plan.months) and rng.random() < 0.25:
        plan.positions = tuple(rng.sample([-3, -2, -1, 1, 2, 3, 4], rng.choice([1, 2])))
    kind = rng.random()
    if kind < 0.35:
        plan.count = rng.choice([1, 2, 3, 5, 10, 30, 100, 400])
    elif kind < 0.6:
        end = datetime(2020, 1, 1) + timedelta(days=rng.randrange(4000))
        plan.until = end.date() if rng.random() < 0.5 else end.replace(hour=rng.choice([0, 9, 23]))
    return plan


def slow_repeats(plan: Plan, first: datetime, last_day: date) -> list[datetime]:
    """When the rule repeats up to `last_day`, found the slow way: each day is tried against each
    part of the rule on its own, days are grouped into periods, BYSETPOS picks within a period,
    and only every interval-th period counts. The start itself is always the first time, as the
    standard says, whether or not the rule picks it."""
    begin, frequency = first.date(), plan.frequency

    def period(day: date) -> int:
        """Which day, week, month or year a day is in, as a counting number."""
        if frequency == "DAILY":
            return day.toordinal()
        if frequency == "WEEKLY":
            return (day - timedelta(days=(day.weekday() - plan.week_start) % 7)).toordinal() // 7
        return day.year * 12 + day.month if frequency == "MONTHLY" else day.year

    def numbered(which: int, day: date, size: int) -> bool:
        """Whether `day` is the which-th of its weekday in its month (or year), from the end if
        which is negative; 0, and any ordinal where the standard has none, means every one."""
        if which == 0 or frequency in ("DAILY", "WEEKLY") or plan.month_days:
            return True
        if frequency == "MONTHLY" or plan.months:
            top, bottom = date(day.year, day.month, 1), date(day.year, day.month, size)
        else:
            top, bottom = date(day.year, 1, 1), date(day.year, 12, 31)
        return which in ((day - top).days // 7 + 1, -((bottom - day).days // 7 + 1))

    def fits(day: date) -> bool:
        size = calendar.monthrange(day.year, day.month)[1]
        if plan.months and day.month not in plan.months:
            return False
        if plan.month_days and not {day.day, day.day - size - 1} & set(plan.month_days):
            return False
        if plan.days:
            return any(day.weekday() == w and numbered(n, day, size) for n, w in plan.days)
        if not plan.month_days:  # nothing says which day: the start's own
            if frequency == "WEEKLY":
                return day.weekday() == begin.weekday()
            if frequency == "MONTHLY":
                return day.day == begin.day
            if frequency == "YEARLY":
                return day.day == begin.day and (bool(plan.months) or day.month == begin.month)
        return True

    periods: dict[int, list[date]] = {}
    day = begin - timedelta(days=370)  # (a period is never longer than a year)
    while day <= last_day:
        if period(day) >= period(begin) and fits(day):
            periods.setdefault(period(day), []).append(day)
        day += timedelta(days=1)
    found = [first]
    for index, picked in sorted(periods.items()):
        if (index - period(begin)) % plan.interval:
            continue
        if plan.positions:
            by_position = [
                picked[p - 1 if p > 0 else p] for p in plan.positions if abs(p) <= len(picked)
            ]
            picked = sorted(set(by_position))
        found += [m for d in picked if (m := datetime.combine(d, first.time())) > first]

    def too_late(moment: datetime) -> bool:
        if plan.until is None or moment == first:
            return False
        if isinstance(plan.until, datetime):
            return moment > plan.until
        return moment.date() > plan.until  # (a date takes in its whole day)

    out: list[datetime] = []
    for moment in sorted(set(found)):
        if too_late(moment):
            break
        out.append(moment)
        if plan.count is not None and len(out) >= plan.count:
            break
    return out


def test_random_rules_agree_with_a_slow_day_by_day_reading_of_the_standard():
    rng = random.Random(5545)
    for _ in range(250):
        plan = random_plan(rng)
        first = datetime(2020, 1, 1, 9) + timedelta(days=rng.randrange(4000))
        opens = first + timedelta(days=rng.choice([-10, 0, 5, 40, 400, 1000, 1500]))
        closes = opens + timedelta(days=rng.choice([1, 20, 200, 700]))
        got = times(
            f"DTSTART:{first:%Y%m%dT%H%M%S}",
            f"RRULE:{plan.text()}",
            start=opens,
            end=closes,
            limit=100_000,
        )
        slow = slow_repeats(plan, first, closes.date() + timedelta(days=400))
        want = [moment for moment in slow if opens <= moment < closes]
        assert got == want, f"{plan.text()} from {first}, between {opens} and {closes}"


# ── whole feeds, as the three services write them ──

BRIGHTSPACE = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//D2L Corporation//Brightspace//EN
CALSCALE:GREGORIAN
X-WR-CALNAME:Brightspace - Intro to Computing
BEGIN:VEVENT
UID:d2l-due-6789@school.example.edu
DTSTAMP:20261001T120000Z
DTSTART:20261009T035900Z
DTEND:20261009T035900Z
SUMMARY:Assignment 3 - Due
DESCRIPTION:Submit through the dropbox.\\nLate work loses 10%.
URL:https://school.brightspace.com/d2l/lms/dropbox/user/folder_submit.d2l?db=1
END:VEVENT
BEGIN:VEVENT
UID:d2l-break@school.example.edu
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
SUMMARY:Reading day
END:VEVENT
END:VCALENDAR
"""

GOOGLE = """BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Team
X-WR-TIMEZONE:America/New_York
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261005T090000
DTEND;TZID=America/New_York:20261005T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=America/New_York:20261026T090000
DTSTAMP:20261001T000000Z
ORGANIZER;CN=Bob Boss:mailto:bob@example.com
UID:standup@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Ann Lee;X-NUM-GUESTS=0:mailto:ann@example.com
SEQUENCE:2
STATUS:CONFIRMED
SUMMARY:Standup
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H30M0S
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261014T110000
DTEND;TZID=America/New_York:20261014T113000
RECURRENCE-ID;TZID=America/New_York:20261012T090000
UID:standup@google.com
STATUS:CONFIRMED
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261019T090000
DTEND;TZID=America/New_York:20261019T093000
RECURRENCE-ID;TZID=America/New_York:20261019T090000
UID:standup@google.com
STATUS:CANCELLED
SUMMARY:Standup
END:VEVENT
END:VCALENDAR
"""

OUTLOOK = (
    "BEGIN:VCALENDAR\r\nPRODID:Microsoft Exchange Server 2010\r\nVERSION:2.0\r\n"
    "BEGIN:VTIMEZONE\r\nTZID:Eastern Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T020000\r\n"
    "TZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11\r\n"
    "END:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:-0500\r\n"
    "TZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3\r\nEND:DAYLIGHT\r\n"
    "END:VTIMEZONE\r\n"
    "BEGIN:VEVENT\r\nCLASS:PUBLIC\r\nDESCRIPTION:Weekly planning\\n\\n________________\\n"
    "Microsoft Teams meeting\\nJoin on your computer or mobile app\\n<"
    + TEAMS
    + ">\\nOr call in\\n\r\n"
    "DTEND;TZID=Eastern Standard Time:20261008T100000\r\n"
    "DTSTAMP:20261001T000000Z\r\nDTSTART;TZID=Eastern Standard Time:20261008T090000\r\n"
    "LOCATION:Microsoft Teams Meeting\r\nPRIORITY:5\r\nSEQUENCE:0\r\n"
    "SUMMARY;LANGUAGE=en-us:Weekly planning\r\nTRANSP:OPAQUE\r\nUID:0400000082200E00074C5B7101A82E00\r\n"
    "X-ALT-DESC;FMTTYPE=text/html:<html><body>Weekly planning</body></html>\r\n"
    "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TH\r\n"
    "X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE\r\nX-MICROSOFT-CDO-IMPORTANCE:1\r\n"
    "BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n"
    "END:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:holiday-1\r\nDTSTART;VALUE=DATE:20261126\r\nDTEND;VALUE=DATE:20261127\r\n"
    "SUMMARY:Thanksgiving\r\nX-MICROSOFT-CDO-ALLDAYEVENT:TRUE\r\nX-MICROSOFT-CDO-BUSYSTATUS:FREE\r\n"
    "END:VEVENT\r\nEND:VCALENDAR\r\n"
)


def test_a_brightspace_feed():
    due, reading_day = ics.parse(BRIGHTSPACE)
    assert due.title == "Assignment 3 - Due" and due.uid == "d2l-due-6789@school.example.edu"
    assert due.start == due.end == utc(2026, 10, 9, 3, 59) and not due.all_day
    assert due.notes == "Submit through the dropbox.\nLate work loses 10%."
    assert due.url.startswith("https://school.brightspace.com/d2l/")
    assert due.link == "" and due.rrule == "" and due.zone == "UTC"
    assert reading_day.all_day and reading_day.title == "Reading day"
    assert (reading_day.start, reading_day.end) == (datetime(2026, 10, 12), datetime(2026, 10, 13))
    around = ics.occurrences([due, reading_day], utc(2026, 10, 9, 3, 58), utc(2026, 10, 9, 4, 0))
    assert around == [due]


@needs_zones
def test_a_google_feed_with_a_moved_a_cancelled_and_an_excused_repeat():
    found = ics.parse(GOOGLE)
    master = found[0]
    assert master.uid == "standup@google.com" and master.status == "confirmed"
    assert master.link == "https://meet.google.com/abc-defg-hij" and master.alerts == (30,)
    assert master.organizer_email == "bob@example.com"
    assert master.attendees == (("Ann Lee", "ann@example.com", "accepted"),)
    assert master.zone == "America/New_York" and master.rrule == "FREQ=WEEKLY;BYDAY=MO"
    assert found[1].recurrence_id == at("America/New_York", 2026, 10, 12, 9)
    assert found[2].status == "cancelled"
    out = ics.occurrences(found, datetime(2026, 10, 1), datetime(2026, 11, 12))
    assert [(e.title, e.start) for e in out] == [
        ("Standup", at("America/New_York", 2026, 10, 5, 9)),
        ("Standup (moved)", at("America/New_York", 2026, 10, 14, 11)),
        ("Standup", at("America/New_York", 2026, 11, 2, 9)),
        ("Standup", at("America/New_York", 2026, 11, 9, 9)),
    ]


@needs_zones
def test_an_outlook_feed_with_teams_a_weekly_meeting_and_a_holiday():
    meeting, holiday = ics.parse(OUTLOOK)
    assert meeting.title == "Weekly planning" and meeting.zone == "America/New_York"
    assert meeting.start == at("America/New_York", 2026, 10, 8, 9)
    assert meeting.end - meeting.start == timedelta(hours=1)
    assert meeting.link == TEAMS and meeting.location == "Microsoft Teams Meeting"
    assert meeting.alerts == (15,) and meeting.rrule == "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH"
    assert holiday.all_day and holiday.start == datetime(2026, 11, 26)
    # Thanksgiving week: the holiday, and the Thursday meeting (but not the Thursdays either side).
    out = ics.occurrences([meeting, holiday], datetime(2026, 11, 22), datetime(2026, 11, 30))
    assert [(e.title, e.start) for e in out] == sorted(
        [
            ("Thanksgiving", datetime(2026, 11, 26)),
            ("Weekly planning", at("America/New_York", 2026, 11, 26, 9)),
        ],
        key=lambda row: row[1],
    )
