from datetime import datetime

import pytest

from jarvis import mac_tools


@pytest.fixture
def calls(monkeypatch):
    class Calls(list):
        fake = None

    seen = Calls()

    async def fake_run_command(*args, stdin=None, timeout=30):
        seen.append((args, stdin))
        return fake_run_command.result

    fake_run_command.result = ""
    monkeypatch.setattr(mac_tools, "run_command", fake_run_command)
    seen.fake = fake_run_command
    return seen


async def test_applescript_values_travel_as_argv_not_script_text(calls):
    title = 'Q3 "review"; do shell script "rm -rf ~"'
    await mac_tools.create_note.handler({"title": title, "body": "hi"})
    args, script = calls[0]
    assert args[:2] == ("osascript", "-")
    assert args[2] == title
    assert "rm -rf" not in script


async def test_open_url_rejects_non_web_schemes(calls):
    result = await mac_tools.open_url.handler({"url": "file:///etc/passwd"})
    assert result["is_error"]
    assert calls == []


async def test_open_app_rejects_paths(calls):
    result = await mac_tools.open_app.handler({"name": "/tmp/evil.app"})
    assert result["is_error"]


async def test_draft_email_to_someone_not_in_contacts_opens_nothing(calls):
    """A name is looked up in Contacts; someone who isn't there is said, and no draft opens."""
    result = await mac_tools.draft_email.handler({"to": "Sam", "subject": "x", "body": "y"})
    assert result["is_error"]
    assert "no one called Sam" in result["content"][0]["text"]
    assert [args[:3] for args, _stdin in calls] == [("osascript", "-l", "JavaScript")]
    assert all(args[1] != "-" for args, _stdin in calls)  # only Contacts: no Mail script ran


async def test_draft_email_by_contact_name_with_copies(calls):
    """draft_email takes a contact's name, and copies: the draft opens in Mail with their
    addresses, for the owner to read over and send."""
    import json

    from jarvis import mailkit

    people = {
        "Ann": [
            {"name": "Ann Lee", "phones": [], "emails": [{"label": "work", "value": "ann@x.com"}]}
        ],
        "Bob": [
            {"name": "Bob Ray", "phones": [], "emails": [{"label": "home", "value": "bob@y.com"}]}
        ],
    }

    async def run_command(*args, stdin=None, timeout=30):
        calls.append((args, stdin))
        if args[:2] == ("osascript", "-l"):
            return json.dumps(people.get(args[-1], []))
        return ""

    mac_tools.run_command = run_command  # the fixture's monkeypatch puts the real one back
    result = await mac_tools.draft_email.handler(
        {"to": "Ann", "subject": "Deck", "body": "Draft attached soon.", "cc": ["Bob"]}
    )
    assert (
        result["content"][0]["text"]
        == "Draft to Ann Lee is open in Mail for you to review and send."
    )
    args, script = calls[-1]
    assert script == mailkit.DRAFT_SCRIPT
    assert args[2:] == ("ann@x.com", "bob@y.com", "", "Deck", "Draft attached soon.", "")


async def test_tool_failures_become_error_results(monkeypatch):
    async def boom(*_a, **_k):
        raise mac_tools.ToolFailure("Not authorized to send Apple events")

    monkeypatch.setattr(mac_tools, "run_command", boom)

    # EventKit is tried first; on a Mac that has granted calendar access it would answer with the
    # owner's real events and never reach the AppleScript path this test is about.
    async def no_eventkit(*_a, **_k):
        return {"error": "no calendar access"}

    from jarvis import calendar_kit

    monkeypatch.setattr(calendar_kit, "fetch", no_eventkit)
    result = await mac_tools.list_events.handler({})
    assert result["is_error"]
    assert "Not authorized" in result["content"][0]["text"]


async def test_media_tools_find_the_player_off_the_event_loop(calls, monkeypatch):
    """Which player is open is two pgreps: they run in a worker thread, never on the loop,
    and the tools say the same as before."""
    import threading

    asked_on = []

    def player(found):
        def active():
            asked_on.append(threading.current_thread() is threading.main_thread())
            return found

        return active

    monkeypatch.setattr(mac_tools, "_active_player", player("Spotify"))
    result = await mac_tools.media_control.handler({"action": "pause"})
    assert result["content"][0]["text"] == "Spotify: pause."
    assert calls[-1][1] == 'tell application "Spotify" to pause'
    monkeypatch.setattr(mac_tools, "_active_player", player(None))
    result = await mac_tools.media_control.handler({"action": "next"})
    assert calls[-1][1] == 'tell application "Music" to next track'
    assert (await mac_tools.now_playing.handler({}))["content"][0]["text"] == (
        "No music app is open."
    )
    monkeypatch.setattr(mac_tools, "_active_player", player("Music"))
    calls.fake.result = "So What by Miles Davis"
    out = await mac_tools.now_playing.handler({})
    assert out["content"][0]["text"] == "Music is playing So What by Miles Davis."
    assert asked_on == [False, False, False, False]


async def test_list_emails_formats_rows(calls):
    calls.fake.result = "Ann <a@x.com>\tLunch?\tMonday\tfalse\nBob\tInvoice\tTuesday\ttrue"
    result = await mac_tools.list_emails.handler({"count": 2})
    text = result["content"][0]["text"]
    assert "Ann <a@x.com> — Lunch? (Monday) [unread]" in text
    assert "Bob — Invoice (Tuesday)" in text and "Tuesday) [unread]" not in text


def test_format_events_sorts_and_labels():
    start = datetime(2026, 9, 28)
    raw = "50400\t54000\tfalse\tWork\tDesign review\n0\t86400\ttrue\tHome\tBirthday\n"
    assert mac_tools.format_events(raw, start) == (
        "- Mon 28 Sep (all day): Birthday [Home]\n- Mon 28 Sep 14:00–15:00: Design review [Work]"
    )


def test_event_args_splits_iso_time():
    argv = mac_tools.event_args("", "Call", "2026-09-29T14:30", 45, "Zoom")
    assert argv == ["", "Call", "2026", "9", "29", "14", "30", "45", "Zoom"]
    with pytest.raises(ValueError):
        mac_tools.event_args("", "Call", "2026-09-29T14:30", 0, "")


def test_midnight_offsets():
    assert mac_tools.midnight(1, now=datetime(2026, 9, 28, 17, 5)) == datetime(2026, 9, 29)


def test_parse_events_structured():
    start = datetime(2026, 9, 28)
    events = mac_tools.parse_events("3600\t7200\tfalse\tWork\tStandup\n", start)
    assert events == [
        {
            "begin": datetime(2026, 9, 28, 1),
            "end": datetime(2026, 9, 28, 2),
            "all_day": False,
            "calendar": "Work",
            "title": "Standup",
        }
    ]


TWO_DISPLAYS = [
    {"index": 1, "x": 0, "y": 0, "w": 1512, "h": 982, "main": True, "visible": (0, 38, 1512, 944)},
    {"index": 2, "x": 1512, "y": -200, "w": 2560, "h": 1440, "main": False,
     "visible": (1512, -175, 2560, 1415)},
]  # fmt: skip


async def test_snap_window_validates_position(calls, monkeypatch):
    from jarvis import mac_reading

    monkeypatch.setattr(mac_reading, "displays", lambda: TWO_DISPLAYS[:1])
    bad = await mac_tools.snap_window.handler({"app": "Safari", "position": "diagonal"})
    assert bad["is_error"] and calls == []
    calls.fake.result = "100,80,900,700"
    ok = await mac_tools.snap_window.handler({"app": "Safari", "position": "left"})
    assert not ok.get("is_error")
    assert calls[0][0][2:] == ("Safari",)  # where its window is
    assert calls[1][0][2:] == ("0", "38", "756", "944")  # the left half, under the menu bar


async def test_snap_window_keeps_a_window_on_its_own_display(calls, monkeypatch):
    from jarvis import mac_reading

    monkeypatch.setattr(mac_reading, "displays", lambda: TWO_DISPLAYS)
    calls.fake.result = "1600,100,800,600"  # on the second display
    out = await mac_tools.snap_window.handler({"app": "Safari", "position": "right"})
    assert calls[-1][0][2:] == ("2792", "-175", "1280", "1415")
    assert out["content"][0]["text"] == "Safari is on the right on display 2."
    await mac_tools.snap_window.handler({"app": "Safari", "position": "full", "display": 1})
    assert calls[-1][0][2:] == ("0", "38", "1512", "944")
    bad = await mac_tools.snap_window.handler({"app": "Safari", "position": "full", "display": 3})
    assert bad["is_error"] and "no display 3" in bad["content"][0]["text"]


def test_a_running_app_is_found_by_its_process_name_on_a_pc(monkeypatch):
    class Process:
        def __init__(self, name):
            self.info = {"name": name}

    monkeypatch.setattr(mac_tools.osplat, "IS_WIN", True)
    import psutil

    monkeypatch.setattr(
        psutil, "process_iter", lambda attrs=None: iter([Process("Spotify.exe"), Process(None)])
    )
    assert mac_tools.app_running("Spotify") and mac_tools.app_running("spotify")
    assert not mac_tools.app_running("Calendar")


def test_without_pgrep_nothing_is_running(monkeypatch):
    monkeypatch.setattr(mac_tools.osplat, "IS_WIN", False)

    def missing(*_a, **_k):
        raise FileNotFoundError("pgrep")

    monkeypatch.setattr(mac_tools.subprocess, "run", missing)
    assert mac_tools.app_running("Calendar") is False
