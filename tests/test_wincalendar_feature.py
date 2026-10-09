"""Calendar and Reminders on a PC as the window and the clock meet them (features/wincalendar.py): the
calendars pane's commands, and each reminder said once at its time. A stand-in hub; temp folders."""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from jarvis import wincal, winreminders
from jarvis.features import wincalendar

NOW = datetime(2026, 10, 8, 9, 0)
FEED = "BEGIN:VCALENDAR\nX-WR-CALNAME:Brightspace\nBEGIN:VEVENT\nUID:a\nSUMMARY:Seminar\nDTSTART:20261012T150000\nDTEND:20261012T163000\nEND:VEVENT\nEND:VCALENDAR\n"


class Vault:
    def __init__(self):
        self.kept = {}

    def get(self, key):
        return self.kept.get(key)

    def set(self, key, value):
        self.kept[key] = value

    def delete(self, key):
        self.kept.pop(key, None)


class FakeOutlook:
    def __init__(self):
        self.installed, self.open_now = True, True

    def available(self):
        return self.installed

    def running(self):
        return self.open_now

    def export(self, path, start, end):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(FEED.replace("Seminar", "Faculty meeting"), encoding="utf-8")


class Hub:
    def __init__(self):
        self.events = []
        self.alerts = []
        self.prefs = SimpleNamespace(language="en")
        self.commands = {}
        self.loops = []

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def notify(self, alert, speak_if_busy=False):
        self.alerts.append(alert)

    def register_command(self, kind, handler, slow=False):
        self.commands[kind] = (handler, slow)

    def register_loop(self, name, factory):
        self.loops.append(name)

    def last(self, kind):
        return [d for k, d in self.events if k == kind][-1]


@pytest.fixture
def made(tmp_path):
    clock = [NOW]
    hub = Hub()
    answers = {"https://cal.example/b.ics": (FEED, '"1"')}

    def fetch(url, etag):
        if url not in answers:
            raise wincal.CalendarError("The calendar link didn't answer.")
        return answers[url]

    outlook = FakeOutlook()
    store = wincal.Store(
        tmp_path / "Calendar", vault=Vault(), now=lambda: clock[0], fetch=fetch, outlook=outlook
    )
    desk = winreminders.Reminders(tmp_path / "Reminders" / "reminders.json", now=lambda: clock[0])
    return SimpleNamespace(
        outlook=outlook,
        feature=wincalendar.WinCalendar(hub, store, desk),
        hub=hub,
        clock=clock,
        store=store,
        desk=desk,
    )


async def test_the_pane_is_told_the_calendars_and_a_link_is_added_and_taken_away(made):
    f, hub = made.feature, made.hub
    await f.status({})
    assert [c["title"] for c in hub.last("calendars")["calendars"]] == ["Jarvis"]
    await f.add_feed({"url": "https://cal.example/b.ics", "name": ""})
    said = hub.last("calendar_result")
    assert (
        said["ok"] is True
        and "Brightspace" in said["text"]
        and "1 event" in said["text"]
        and said["added"]
    )
    assert [c["title"] for c in hub.last("calendars")["calendars"]] == ["Jarvis", "Brightspace"]
    assert "cal.example" not in str(
        hub.events
    )  # (the link is a key: it never goes back to the window)
    feed_id = said["added"]
    await f.remove({"id": feed_id})
    assert hub.last("calendar_result")["removed"] is True
    assert [c["title"] for c in hub.last("calendars")["calendars"]] == ["Jarvis"]
    await f.remove({"id": feed_id})
    assert hub.last("calendar_result")["ok"] is False


async def test_a_link_that_does_not_work_is_said_in_words(made):
    f, hub = made.feature, made.hub
    await f.add_feed({"url": "http://insecure.example/x.ics"})
    assert (
        hub.last("calendar_result")["ok"] is False
        and "https://" in hub.last("calendar_result")["text"]
    )
    await f.add_feed({"url": "https://nowhere.example/x.ics"})
    assert hub.last("calendar_result") == {"ok": False, "text": "The calendar link didn't answer."}
    await f.default({"id": "feed-x"})
    assert hub.last("calendar_result")["ok"] is False


async def test_reading_again_says_how_it_went(made):
    f, hub = made.feature, made.hub
    await f.refresh({})
    assert hub.last("calendar_result") == {"ok": True, "text": "The calendars are up to date."}
    await f.add_feed({"url": "https://cal.example/b.ics"})
    await f.refresh({})
    assert hub.last("calendar_result")["ok"] is True


async def test_outlook_is_switched_on_and_off_from_the_page_and_the_page_is_told(made):
    f, hub = made.feature, made.hub
    await f.status({})
    assert hub.last("calendars")["outlook"] == {"available": True, "on": False}
    await f.outlook({"on": True})
    said = hub.last("calendar_result")
    assert said["ok"] is True and "reads Outlook's calendar now" in said["text"]
    assert hub.last("calendars")["outlook"] == {"available": True, "on": True}
    assert [c["id"] for c in hub.last("calendars")["calendars"]] == ["local", "outlook"]
    await f.outlook({"on": False})
    assert (
        hub.last("calendar_result")["ok"] is True
        and hub.last("calendars")["outlook"]["on"] is False
    )
    made.outlook.installed = False
    await f.outlook({"on": True})
    assert (
        hub.last("calendar_result")["ok"] is False
        and "isn't on this PC" in hub.last("calendar_result")["text"]
    )


def test_each_reminder_is_said_once_at_its_time_as_a_heads_up(made):
    f, hub, desk = made.feature, made.hub, made.desk
    desk.add(
        {
            "title": "Call the dean",
            "due": "2026-10-08T15:00",
            "list": "",
            "notes": "",
            "priority": 0,
        }
    )
    assert f.say_due() == 0 and hub.alerts == []
    made.clock[0] = datetime(2026, 10, 8, 15, 0, 5)
    assert f.say_due() == 1
    (alert,) = hub.alerts
    assert (
        alert.kind == "reminder"
        and alert.text == "Reminder: Call the dean."
        and alert.title == "Reminder"
    )
    assert f.say_due() == 0  # once
    made.clock[0] += timedelta(hours=2)
    assert f.say_due() == 0


def test_a_reminder_is_said_in_chinese_when_that_is_the_language(made):
    made.hub.prefs.language = "zh"
    made.desk.add(
        {"title": "打电话给院长", "due": "2026-10-08T09:00", "list": "", "notes": "", "priority": 0}
    )
    made.clock[0] = datetime(2026, 10, 8, 9, 1)
    assert made.feature.say_due() == 1
    assert made.hub.alerts[0].text == "提醒：打电话给院长。"


def test_it_does_nothing_on_a_mac_and_sets_itself_up_on_a_pc(monkeypatch):
    hub = Hub()
    wincalendar.install(hub)  # (this machine's own platform)
    if wincalendar.IS_WIN:
        assert {
            "calendars_status",
            "calendar_add_feed",
            "calendar_remove",
            "calendar_refresh",
            "calendar_default",
        } <= set(hub.commands)
        assert hub.commands["calendar_add_feed"][1] is True and hub.loops == ["reminders"]
    else:
        assert hub.commands == {} and hub.loops == []
    pc = Hub()
    monkeypatch.setattr(wincalendar, "IS_WIN", True)
    monkeypatch.setattr(
        wincal, "folder", lambda: pytest.importorskip("pathlib").Path("/nonexistent/never-made")
    )
    wincalendar.install(pc)
    assert {
        "calendars_status",
        "calendar_add_feed",
        "calendar_remove",
        "calendar_refresh",
        "calendar_default",
    } <= set(pc.commands)
    assert pc.loops == ["reminders"]
