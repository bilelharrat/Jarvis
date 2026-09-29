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


async def test_draft_email_needs_an_address(calls):
    result = await mac_tools.draft_email.handler({"to": "Sam", "subject": "x", "body": "y"})
    assert result["is_error"]
    assert calls == []


async def test_tool_failures_become_error_results(monkeypatch):
    async def boom(*_a, **_k):
        raise mac_tools.ToolFailure("Not authorized to send Apple events")

    monkeypatch.setattr(mac_tools, "run_command", boom)
    result = await mac_tools.list_events.handler({})
    assert result["is_error"]
    assert "Not authorized" in result["content"][0]["text"]


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


async def test_snap_window_validates_position(calls):
    bad = await mac_tools.snap_window.handler({"app": "Safari", "position": "diagonal"})
    assert bad["is_error"] and calls == []
    ok = await mac_tools.snap_window.handler({"app": "Safari", "position": "left"})
    assert not ok.get("is_error")
    assert calls[0][0][2:] == ("Safari", "left")
