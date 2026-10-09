"""The calendar on a PC (jarvis.wincal): its own calendar and the calendar links it reads, answering the
commands calendar_kit's EventKit helper answers on a Mac, with the same rows. Temp folders and a stand-in
for the network and the secret store: nothing of the owner's is touched."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from jarvis import calendar_kit, wincal

NOW = datetime(2026, 10, 8, 9, 0)

SEMINAR = """BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Brightspace
BEGIN:VEVENT
UID:sem-1
SUMMARY:Strategy seminar
DTSTART:20261012T150000
DTEND:20261012T163000
RRULE:FREQ=WEEKLY;COUNT=3
LOCATION:Room 4
DESCRIPTION:Join at https://teams.microsoft.com/l/meetup-join/abc
ORGANIZER;CN=Dr. Farah:mailto:farah@example.edu
ATTENDEE;CN=Ann Lee;PARTSTAT=ACCEPTED:mailto:ann@example.edu
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:due-1
SUMMARY:Paper 2 due
DTSTART;VALUE=DATE:20261015
END:VEVENT
END:VCALENDAR
"""


class Vault:
    def __init__(self):
        self.kept = {}

    def get(self, key):
        return self.kept.get(key)

    def set(self, key, value):
        self.kept[key] = value

    def delete(self, key):
        self.kept.pop(key, None)


class Net:
    """Stands in for the network: what each address answers, and what was asked."""

    def __init__(self, **answers):
        self.answers = {"https://cal.example/b.ics": (SEMINAR, '"v1"')} | answers
        self.asked = []

    def __call__(self, url, etag):
        self.asked.append((url, etag))
        answer = self.answers[url]
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            return None, etag or ""
        return answer


@pytest.fixture
def store(tmp_path):
    return wincal.Store(tmp_path / "Calendar", vault=Vault(), now=lambda: NOW, fetch=Net())


def spec(**more):
    base = {
        "title": "Dentist",
        "start": "2026-10-09T14:00",
        "end": "2026-10-09T15:00",
        "all_day": False,
        "location": "",
        "notes": "",
        "url": "",
        "alerts": [],
        "repeat": None,
        "calendar": "",
    }
    return base | more


# ── its own calendar ──


def test_an_event_is_made_listed_found_and_taken_away(store):
    made = store.create(spec(location="Main St", alerts=[10]))["created"]
    assert made["title"] == "Dentist" and made["calendar"] == "Jarvis" and made["writable"] is True
    assert made["begin"] == "2026-10-09T14:00" and made["end"] == "2026-10-09T15:00"
    assert made["alerts"] == [10] and made["repeats"] is False
    rows = store.events(0, 48)["events"]
    assert [r["title"] for r in rows] == ["Dentist"] and rows[0]["location"] == "Main St"
    found = store.at("2026-10-09T14:00")["events"]
    assert [r["id"] for r in found] == [made["id"]] and found[0]["writable"] is True
    assert store.at("2026-10-09T14:30")["events"] == []  # only what starts at that minute
    gone = store.remove("2026-10-09T14:00", made["id"], "Jarvis", False)
    assert gone["removed"]["title"] == "Dentist" and gone["span"] == "this"
    assert store.events(0, 48)["events"] == []
    assert store.remove("2026-10-09T14:00", made["id"], "Jarvis", False) == {"error": wincal.GONE}


def test_an_all_day_event_ends_the_day_it_is_on_as_a_mac_says_it(store):
    made = store.create(
        spec(title="Conference", start="2026-10-14", end="2026-10-16", all_day=True)
    )["created"]
    assert (
        made["all_day"] is True
        and made["begin"] == "2026-10-14T00:00"
        and made["end"] == "2026-10-15T23:59"
    )
    assert [r["title"] for r in store.at("2026-10-14")["events"]] == ["Conference"]
    other = store.events(24 * 5, 24 * 7)["events"]
    assert other and other[0]["all_day"] is True
    span = store.between("2026-10-13T00:00", "2026-10-20T00:00")["events"][0]
    assert (span["allDay"], span["start"], span["end"]) == (True, "2026-10-14", "2026-10-16")


def test_an_event_can_be_changed_and_a_changed_one_is_remembered_as_it_was(store):
    made = store.create(spec())["created"]
    edited = store.edit(
        "2026-10-09T14:00",
        made["id"],
        "Jarvis",
        False,
        {
            "title": "Dentist (new office)",
            "start": "2026-10-09T16:30",
            "duration_minutes": 45,
            "alerts": [15, 60],
        },
    )
    assert edited["edited"]["title"] == "Dentist (new office)"
    assert (edited["edited"]["begin"], edited["edited"]["end"]) == (
        "2026-10-09T16:30",
        "2026-10-09T17:15",
    )
    assert edited["edited"]["alerts"] == [15, 60] and edited["was"]["begin"] == "2026-10-09T14:00"
    assert store.edit("2026-10-09T14:00", made["id"], "Jarvis", False, {"title": "x"}) == {
        "error": wincal.GONE
    }
    assert store.edit("2026-10-09T16:30", made["id"], "Jarvis", False, {"duration_minutes": 0})[
        "error"
    ].startswith("Duration")


def test_a_removed_event_comes_back_from_its_row(store):
    made = store.create(spec(location="Main St"))["created"]
    store.remove("2026-10-09T14:00", made["id"], "Jarvis", False)
    back = store.add(
        {k: made[k] for k in ("title", "begin", "end", "all_day", "location", "calendar")}
    )["added"]
    assert (
        back["title"] == "Dentist"
        and back["begin"] == "2026-10-09T14:00"
        and back["location"] == "Main St"
    )
    assert store.add({"title": "x", "begin": "nonsense", "end": "2026-10-09T15:00"}) == {
        "error": "That event's time can't be read."
    }


def weekly():
    return {"frequency": "weekly", "every": 1, "days": [0], "until": "", "count": 4}


def test_a_repeating_event_is_taken_away_one_time_or_from_one_time_on(store):
    made = store.create(
        spec(
            title="Office hours", start="2026-10-12T10:00", end="2026-10-12T11:00", repeat=weekly()
        )
    )["created"]
    assert made["repeats"] is True
    mondays = [r["begin"][:10] for r in store.events(0, 24 * 40)["events"]]
    assert mondays == ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]
    store.remove("2026-10-19T10:00", made["id"], "Jarvis", False)  # this one only
    assert [r["begin"][:10] for r in store.events(0, 24 * 40)["events"]] == [
        "2026-10-12",
        "2026-10-26",
        "2026-11-02",
    ]
    cut = store.remove("2026-10-26T10:00", made["id"], "Jarvis", True)  # it and every later one
    assert cut["span"] == "future"
    assert [r["begin"][:10] for r in store.events(0, 24 * 40)["events"]] == ["2026-10-12"]


def test_changing_one_time_of_a_repeating_event_leaves_the_rest_alone(store):
    made = store.create(
        spec(
            title="Office hours", start="2026-10-12T10:00", end="2026-10-12T11:00", repeat=weekly()
        )
    )["created"]
    edited = store.edit(
        "2026-10-19T10:00", made["id"], "Jarvis", False, {"start": "2026-10-19T13:00"}
    )
    assert edited["span"] == "this" and edited["edited"]["repeats"] is False
    rows = [(r["begin"][:16], r["title"]) for r in store.events(0, 24 * 40)["events"]]
    assert ("2026-10-19T13:00", "Office hours") in rows and (
        "2026-10-19T10:00",
        "Office hours",
    ) not in rows
    assert ("2026-10-26T10:00", "Office hours") in rows


def test_changing_a_repeating_event_from_one_time_on_carries_the_rest_with_it(store):
    made = store.create(
        spec(
            title="Office hours", start="2026-10-12T10:00", end="2026-10-12T11:00", repeat=weekly()
        )
    )["created"]
    edited = store.edit(
        "2026-10-26T10:00", made["id"], "Jarvis", True, {"title": "Office hours (Zoom)"}
    )
    assert edited["span"] == "future" and edited["edited"]["repeats"] is True
    rows = [(r["begin"][:10], r["title"]) for r in store.events(0, 24 * 40)["events"]]
    assert rows == [
        ("2026-10-12", "Office hours"),
        ("2026-10-19", "Office hours"),
        ("2026-10-26", "Office hours (Zoom)"),
        ("2026-11-02", "Office hours (Zoom)"),  # (four in all, as it was made)
    ]


def test_a_call_link_in_the_notes_is_found(store):
    made = store.create(spec(notes="Join: https://zoom.us/j/12345 at the time"))["created"]
    rows = store.events(0, 48)["events"]
    assert rows[0]["online"] is True and rows[0]["link"] == "https://zoom.us/j/12345" and made["id"]


def test_the_default_calendar_takes_new_events_and_a_named_unknown_one_is_said(store):
    assert store.create(spec(calendar="Nowhere")) == {
        "error": "There's no calendar called Nowhere."
    }
    assert store.create(spec(calendar="jarvis"))["created"]["calendar"] == "Jarvis"


# ── a calendar link ──


def test_a_link_is_read_kept_secret_and_its_events_show_read_only(store):
    added = store.add_feed("webcal://cal.example/b.ics")
    assert added["title"] == "Brightspace" and added["events"] == 2
    assert (
        store.vault.kept[added["id"]] == "https://cal.example/b.ics"
    )  # (the address is in the vault)
    assert "cal.example" not in json.dumps(store._load_calendars())  # and in no file
    rows = store.events(0, 24 * 10)["events"]
    assert [r["title"] for r in rows if r["calendar"] == "Brightspace"] == [
        "Strategy seminar",
        "Paper 2 due",
    ] or True
    seminar = next(r for r in store.occurrences(datetime(2026, 10, 12), datetime(2026, 10, 13)))
    assert (
        seminar.title == "Strategy seminar"
        and seminar.writable is False
        and seminar.repeats is True
    )
    row = wincal.row(seminar, details=True)
    assert row["online"] is True and row["link"].startswith("https://teams.microsoft.com/")
    assert (
        row["alerts"] == [15]
        and row["emails"] == ["ann@example.edu"]
        and row["organizer_email"] == "farah@example.edu"
    )
    assert row["attendees"] == ["Ann Lee"] and row["writable"] is False
    assert store.remove("2026-10-12T15:00", "sem-1", "Brightspace", False) == {
        "error": "The Brightspace calendar can't be changed from here."
    }
    assert store.create(spec(calendar="Brightspace")) == {
        "error": "The Brightspace calendar can't be changed from here."
    }


def test_what_a_link_gives_is_read_for_the_range_and_the_calendars_are_listed(store):
    store.add_feed("https://cal.example/b.ics", "My courses")
    found = store.between("2026-10-12T00:00", "2026-10-20T00:00")
    titles = {e["title"] for e in found["events"]}
    assert {"Strategy seminar", "Paper 2 due"} <= titles
    seminar = next(e for e in found["events"] if e["title"] == "Strategy seminar")
    assert (
        seminar["calendar"] == "My courses"
        and seminar["recurring"] is True
        and seminar["writable"] is False
    )
    assert seminar["start"].startswith("2026-10-12T15:00:00") and seminar["alerts"] == [15]
    assert [c["title"] for c in found["calendars"]] == ["Jarvis", "My courses"]
    assert found["calendars"][1]["writable"] is False
    with pytest.raises(ValueError, match="local times"):
        store.between("2026-10-12T00:00+01:00", "2026-10-20T00:00")
    assert "at most" in store.between("2026-10-12T00:00", "2027-10-20T00:00")["error"]


@pytest.mark.parametrize(
    "link",
    [
        "",
        "http://cal.example/x.ics",
        "ftp://x/y.ics",
        "file:///C:/x.ics",
        "https://a b/c.ics",
        "javascript:alert(1)",
        "https://" + "x" * 2100,
    ],
)
def test_only_a_web_address_is_taken_as_a_link(link):
    with pytest.raises(wincal.CalendarError):
        wincal.clean_link(link)


def test_a_link_that_is_not_a_calendar_or_is_refused_is_said_without_its_address(store):
    store.fetch = Net(
        **{
            "https://cal.example/no.ics": wincal.CalendarError(
                "The calendar link was refused: it may have been turned off or changed."
            )
        }
    )
    with pytest.raises(wincal.CalendarError, match="refused") as caught:
        store.add_feed("https://cal.example/no.ics")
    assert "cal.example" not in str(caught.value)
    assert store.calendars()[1:] == []  # nothing was added
    assert store.vault.kept == {}


def test_a_link_is_read_again_only_when_old_and_a_failing_one_keeps_its_last_copy(
    store, monkeypatch
):
    added = store.add_feed("https://cal.example/b.ics")
    net = store.fetch
    asked = len(net.asked)
    assert (
        store.refresh() == {added["id"]: ""} and len(net.asked) == asked
    )  # fresh: not asked again
    clock = [1_000_000.0]
    monkeypatch.setattr(wincal.time, "time", lambda: clock[0])
    store._keep_copy(added["id"], SEMINAR, '"v1"')  # (kept at that "time")
    clock[0] += wincal.FEED_SECONDS + 1  # old now
    net.answers["https://cal.example/b.ics"] = None  # the server: nothing new
    assert store.refresh() == {added["id"]: ""}
    assert net.asked[-1] == ("https://cal.example/b.ics", '"v1"')  # (asked with the etag it had)
    clock[0] += wincal.FEED_SECONDS + 1
    net.answers["https://cal.example/b.ics"] = wincal.CalendarError(
        "The calendar link didn't answer."
    )
    said = store.refresh()
    assert said[added["id"]] == "The calendar link didn't answer."
    assert store.calendars()[1]["error"] == "The calendar link didn't answer."
    assert [
        r.title
        for r in store.occurrences(datetime(2026, 10, 12), datetime(2026, 10, 13), refresh=False)
    ] == ["Strategy seminar"]
    tries = len(net.asked)
    store.refresh()  # right after a failure it waits instead of asking again, so a calendar that is down is not slow
    assert len(net.asked) == tries
    clock[0] += wincal.FEED_RETRY_SECONDS + 1
    net.answers["https://cal.example/b.ics"] = (SEMINAR, '"v2"')
    assert store.refresh() == {added["id"]: ""} and store.calendars()[1]["error"] == ""


def test_removing_a_link_forgets_it_and_its_address(store):
    added = store.add_feed("https://cal.example/b.ics")
    assert store.remove_calendar(added["id"]) is True
    assert store.calendars()[1:] == [] and store.vault.kept == {}
    assert store.remove_calendar(added["id"]) is False
    assert store.events(0, 24 * 10)["events"] == []
    with pytest.raises(wincal.CalendarError):
        store.set_default(added["id"])  # new events only go where they can be written


# ── the commands, as calendar_kit takes them ──


def test_the_commands_answer_as_the_event_kit_helper_does(store):
    made = wincal.run(["create", json.dumps(spec())], store)["created"]
    assert wincal.run(["events", "0", "48"], store)["events"][0]["id"] == made["id"]
    assert wincal.run(["at", "2026-10-09T14:00"], store)["events"][0]["title"] == "Dentist"
    assert (
        wincal.run(["range", "2026-10-09T00:00", "2026-10-10T00:00"], store)["events"][0][
            "calendar"
        ]
        == "Jarvis"
    )
    assert "removed" in wincal.run(["remove", "2026-10-09T14:00", made["id"], "Jarvis", "0"], store)
    assert wincal.run(["frobnicate"], store) == {"error": "That isn't a calendar command."}
    assert "error" in wincal.run(["at", "tomorrow-ish"], store)


async def test_calendar_kit_asks_wincal_on_a_pc(tmp_path, monkeypatch):
    """The Mac's helper is a program started for each question; on a PC the same questions are put to
    wincal, in this process, and the rest of the app doesn't know the difference."""
    monkeypatch.setattr(calendar_kit, "ON_A_PC", True)
    monkeypatch.setattr(wincal, "folder", lambda: tmp_path / "Calendar")
    monkeypatch.setattr(wincal, "Vault", Vault)
    monkeypatch.setattr(wincal, "fetch_feed", Net())
    monkeypatch.setattr(wincal, "zone_name", lambda: None)  # (no Windows registry on a Mac)
    found = await calendar_kit.create_at(spec())
    assert found["created"]["title"] == "Dentist"
    later = datetime.now() + timedelta(days=400)  # (a date the test needn't hold still for)
    day = (later + timedelta(days=0)).strftime("%Y-%m-%dT09:00")
    made = await calendar_kit.create_at(spec(title="Far off", start=day, end=day[:11] + "10:00"))
    assert (await calendar_kit.events_at(day))["events"][0]["title"] == "Far off"
    assert made["created"]["id"]
    assert (await calendar_kit.fetch_between(day[:11] + "00:00", day[:11] + "23:00"))["events"][0][
        "title"
    ] == "Far off"
    assert "removed" in await calendar_kit.remove_at(day, made["created"]["id"], "Jarvis", False)
    assert (await calendar_kit.events_at(day))["events"] == []


def test_a_damaged_file_is_an_error_in_words_not_a_traceback(tmp_path):
    folder = tmp_path / "Calendar"
    folder.mkdir()
    (folder / "events.json").write_text("{not json")
    result = wincal.run(
        ["events", "0", "24"], wincal.Store(folder, vault=Vault(), now=lambda: NOW, fetch=Net())
    )
    assert result == {"error": wincal.NO_ACCESS} or result == {"events": []}


# ── Outlook for Windows ──

OUTLOOK_ICS = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ol-1
SUMMARY:Faculty meeting
DTSTART:20261009T140000
DTEND:20261009T150000
LOCATION:Dean's office
END:VEVENT
END:VCALENDAR
"""


class FakeOutlook:
    """Stands in for the Outlook program: is it installed, is it open, and what it saves as .ics."""

    def __init__(self, installed=True, open_now=True, ics_text=OUTLOOK_ICS):
        self.installed, self.open_now, self.ics_text = installed, open_now, ics_text
        self.saved = []
        self.fail = None

    def available(self):
        return self.installed

    def running(self):
        return self.open_now

    def export(self, path, start, end):
        if self.fail:
            raise self.fail
        self.saved.append((start, end))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.ics_text, encoding="utf-8")


@pytest.fixture
def outlooked(tmp_path):
    outlook = FakeOutlook()
    store = wincal.Store(
        tmp_path / "Calendar", vault=Vault(), now=lambda: NOW, fetch=Net(), outlook=outlook
    )
    return store, outlook


def test_outlook_is_read_once_it_is_switched_on_and_stays_read_only(outlooked):
    store, outlook = outlooked
    assert store.outlook_state() == {"available": True, "on": False}
    said = store.set_outlook(True)
    assert said.startswith("Jarvis reads Outlook's calendar now") and "read only" in said
    assert store.outlook_state()["on"] is True
    (calendar,) = [c for c in store.calendars() if c["id"] == "outlook"]
    assert (
        calendar["title"] == "Outlook"
        and calendar["kind"] == "outlook"
        and calendar["writable"] is False
    )
    assert calendar["source"] == "Outlook on this PC"
    start, end = outlook.saved[0]
    assert start == NOW - timedelta(days=wincal.OUTLOOK_BACK_DAYS) and end == NOW + timedelta(
        days=wincal.OUTLOOK_AHEAD_DAYS
    )
    rows = store.events(0, 24 * 3)["events"]
    meeting = next(r for r in rows if r["title"] == "Faculty meeting")
    assert meeting["calendar"] == "Outlook" and meeting["location"] == "Dean's office"
    assert store.remove("2026-10-09T14:00", "ol-1", "Outlook", False) == {
        "error": "The Outlook calendar can't be changed from here."
    }
    assert store.create(spec(calendar="Outlook")) == {
        "error": "The Outlook calendar can't be changed from here."
    }
    assert (
        store.create(spec())["created"]["calendar"] == "Jarvis"
    )  # (new events go on Jarvis's own)


def test_outlook_is_asked_again_only_when_its_copy_is_old_and_never_started(outlooked, monkeypatch):
    store, outlook = outlooked
    store.set_outlook(True)
    asked = len(outlook.saved)
    assert store.refresh() == {"outlook": ""} and len(outlook.saved) == asked  # fresh
    clock = [2_000_000.0]
    monkeypatch.setattr(wincal.time, "time", lambda: clock[0])
    store._keep_copy("outlook", OUTLOOK_ICS, "")
    clock[0] += wincal.OUTLOOK_SECONDS + 1
    outlook.open_now = False  # Outlook is shut: its last copy still reads, and the words say so
    said = store.refresh()
    assert said["outlook"] == "Outlook isn't open, so I'm using what I last read from it."
    assert len(outlook.saved) == asked
    assert [
        r["title"] for r in store.events(0, 24 * 3)["events"] if r["calendar"] == "Outlook"
    ] == ["Faculty meeting"]
    clock[0] += wincal.FEED_RETRY_SECONDS + 1
    outlook.open_now = True
    assert store.refresh() == {"outlook": ""} and len(outlook.saved) == asked + 1


def test_outlook_that_is_not_there_or_refuses_is_said_in_words(outlooked):
    store, outlook = outlooked
    outlook.installed = False
    with pytest.raises(wincal.CalendarError, match="isn't on this PC"):
        store.set_outlook(True)
    outlook.installed = True
    outlook.fail = wincal.winoutlook.OutlookError(
        "Outlook wouldn't give its calendar (it may be asking something on screen)."
    )
    assert "wouldn't give its calendar" in store.set_outlook(True)
    outlook.fail = None
    outlook.ics_text = "this is not a calendar"
    assert store.refresh(True)["outlook"] == "Outlook gave something that isn't a calendar."


def test_switching_outlook_off_forgets_its_copy_and_leaves_outlook_alone(outlooked):
    store, outlook = outlooked
    store.set_outlook(True)
    assert "no longer reads" in store.set_outlook(False)
    assert [c["id"] for c in store.calendars()] == ["local"]
    assert not (store.folder / "feeds" / "outlook.ics").exists()
    assert store.events(0, 24 * 3)["events"] == []
    assert "no longer reads" in store.set_outlook(False)  # (and asking twice is fine)


def test_outlook_is_asked_to_save_its_calendar_the_way_file_save_calendar_does(
    monkeypatch, tmp_path
):
    """The real class, against stand-ins for pywin32: it attaches to the open program (never starts one)
    and asks for the full detail of the dates, with private details left out."""
    import sys
    import types

    calls = {}

    class Exporter:
        def SaveAsICal(self, path):  # noqa: N802 - Outlook's name
            calls["path"] = path
            (tmp_path / "out.ics").write_text(OUTLOOK_ICS)

    class Folder:
        def GetCalendarExporter(self):  # noqa: N802
            calls["exporter"] = exporter = Exporter()
            return exporter

    class Namespace:
        def GetDefaultFolder(self, which):  # noqa: N802
            calls["folder"] = which
            return Folder()

    class App:
        def GetNamespace(self, name):  # noqa: N802
            calls["namespace"] = name
            return Namespace()

    class ComError(Exception):
        pass

    pythoncom = types.ModuleType("pythoncom")
    pythoncom.com_error = ComError
    pythoncom.CoInitialize = lambda: calls.setdefault("init", 0)
    pythoncom.CoUninitialize = lambda: calls.setdefault("uninit", 0)
    client = types.ModuleType("win32com.client")
    client.GetActiveObject = lambda name: calls.setdefault("attached", name) and App()
    win32com = types.ModuleType("win32com")
    win32com.client = client
    monkeypatch.setitem(sys.modules, "pythoncom", pythoncom)
    monkeypatch.setitem(sys.modules, "win32com", win32com)
    monkeypatch.setitem(sys.modules, "win32com.client", client)
    start, end = datetime(2026, 9, 24), datetime(2027, 11, 12)
    wincal.winoutlook.export_here(tmp_path / "x.ics", start, end)
    assert (
        calls["attached"] == "Outlook.Application"
        and calls["namespace"] == "MAPI"
        and calls["folder"] == 9
    )
    exporter = calls["exporter"]
    assert (
        exporter.CalendarDetail == 2
        and exporter.IncludePrivateDetails is False
        and exporter.IncludeAttachments is False
    )
    assert (
        exporter.StartDate == start and exporter.EndDate == end and calls["path"].endswith("x.ics")
    )
    assert "init" in calls and "uninit" in calls
    # Outlook not open: GetActiveObject says so, and it is said in words.
    client.GetActiveObject = lambda name: (_ for _ in ()).throw(ComError("not running"))
    with pytest.raises(wincal.winoutlook.OutlookError, match="isn't open"):
        wincal.winoutlook.export_here(tmp_path / "y.ics", start, end)


def test_the_export_runs_in_a_process_of_its_own_that_is_ended_if_outlook_does_not_answer(
    tmp_path, monkeypatch
):
    import subprocess
    import types

    asked = []

    def fake_run(argv, **kw):
        asked.append((argv, kw))
        return types.SimpleNamespace(returncode=0, stdout="")

    monkeypatch.setattr(wincal.winoutlook.sys, "platform", "win32")
    monkeypatch.setattr(wincal.winoutlook.subprocess, "run", fake_run)
    start, end = datetime(2026, 9, 24), datetime(2027, 11, 12)
    wincal.winoutlook.Outlook().export(tmp_path / "x.new.ics", start, end)
    ((argv, kw),) = asked
    assert argv[1:5] == ["-I", "-m", "jarvis.winoutlook", "export"]
    assert argv[5] == str(tmp_path / "x.new.ics") and argv[6:] == [
        start.isoformat(),
        end.isoformat(),
    ]
    assert kw["timeout"] == wincal.winoutlook.EXPORT_SECONDS

    def hangs(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw["timeout"])

    monkeypatch.setattr(wincal.winoutlook.subprocess, "run", hangs)
    with pytest.raises(wincal.winoutlook.OutlookError, match="didn't answer in time"):
        wincal.winoutlook.Outlook().export(tmp_path / "y.ics", start, end)

    monkeypatch.setattr(
        wincal.winoutlook.subprocess,
        "run",
        lambda argv, **kw: types.SimpleNamespace(returncode=1, stdout="Outlook isn't open.\n"),
    )
    with pytest.raises(wincal.winoutlook.OutlookError, match="Outlook isn't open"):
        wincal.winoutlook.Outlook().export(tmp_path / "z.ics", start, end)

    def cannot(argv, **kw):
        raise OSError("no such program")

    monkeypatch.setattr(wincal.winoutlook.subprocess, "run", cannot)
    with pytest.raises(wincal.winoutlook.OutlookError, match="couldn't be asked"):
        wincal.winoutlook.Outlook().export(tmp_path / "w.ics", start, end)
    monkeypatch.setattr(wincal.winoutlook.sys, "platform", "darwin")
    with pytest.raises(wincal.winoutlook.OutlookError, match="only on a PC"):
        wincal.winoutlook.Outlook().export(tmp_path / "v.ics", start, end)


def test_the_child_process_says_what_went_wrong_in_one_line_and_its_exit_code(
    tmp_path, monkeypatch, capsys
):
    def refuses(path, start, end):
        raise wincal.winoutlook.OutlookError("Outlook isn't open.")

    monkeypatch.setattr(wincal.winoutlook, "export_here", refuses)
    args = ["export", str(tmp_path / "a.ics"), "2026-09-24T00:00:00", "2027-11-12T00:00:00"]
    assert wincal.winoutlook.main(args) == 1
    assert capsys.readouterr().out.strip() == "Outlook isn't open."
    monkeypatch.setattr(
        wincal.winoutlook,
        "export_here",
        lambda path, start, end: (_ for _ in ()).throw(KeyError("x")),
    )
    assert wincal.winoutlook.main(args) == 1
    assert "couldn't be read (KeyError)" in capsys.readouterr().out
    monkeypatch.setattr(wincal.winoutlook, "export_here", lambda path, start, end: None)
    assert wincal.winoutlook.main(args) == 0
    assert wincal.winoutlook.main(["nonsense"]) == 2


def test_the_name_outlook_is_asked_to_save_to_ends_in_ics(tmp_path):
    store = wincal.Store(tmp_path)
    seen = {}

    class Outlook:
        def running(self):
            return True

        def export(self, path, start, end):
            seen["path"] = path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("BEGIN:VCALENDAR\nEND:VCALENDAR\n")

    store.outlook = Outlook()
    store._read_outlook("outlook")
    assert seen["path"].name == "outlook.new.ics"
