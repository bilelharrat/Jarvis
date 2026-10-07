"""JARVIS's action log (action_log.py): every tool call, per day, kept 90 days, with a short
summary that says nothing private, searchable newest first, and bounded however busy a day."""

import json
import stat
from datetime import date, datetime, timedelta

from jarvis import action_log
from jarvis.action_log import ActionLog, summary


def entry(t, label="Opened an app", tool="open_app", summary="Safari", outcome="done"):
    return {"t": t, "tool": tool, "label": label, "summary": summary, "outcome": outcome}


def test_a_summary_holds_only_safe_words():
    assert summary("mcp__mac__open_app", {"name": "Safari"}) == "Safari"
    assert (
        summary("mcp__mac__run_shortcut", {"name": "Movie mode", "input": "secret"}) == "Movie mode"
    )
    # A site's host, never its path or query (which can carry what was read).
    assert summary("WebFetch", {"url": "https://www.nytimes.com/2026/a?token=abc"}) == "nytimes.com"
    assert summary("mcp__browser__browser_open", {"url": "javascript:alert(1)"}) == ""
    assert (
        summary(
            "mcp__claude__run_claude_code", {"directory": "/Users/me/code/jarvis", "task": "fix it"}
        )
        == "jarvis"
    )
    # Messages, emails, searches, notes, events: nothing but the label.
    for name, args in [
        ("mcp__messages__send_message", {"to": "Ann", "text": "the code is 1234"}),
        ("mcp__messages__send_email", {"to": "a@b.c", "subject": "Taxes", "body": "…"}),
        ("WebSearch", {"query": "symptoms of"}),
        ("mcp__mac__create_event", {"title": "Therapy", "start": "2026-09-30T15:00"}),
        ("mcp__memory__remember", {"fact": "Ann is pregnant"}),
    ]:
        assert summary(name, args) == "", name
    assert summary("mcp__mac__media_control", {"action": "pause; rm -rf"}) == ""
    assert summary("mcp__jarvis__set_hands_free", {"enabled": True}) == "on"


def test_entries_are_kept_per_day_and_read_back(tmp_path):
    log = ActionLog(tmp_path / "action_log")
    assert (
        log.add(
            [
                entry("2026-09-29T08:15:02"),
                entry(
                    "2026-09-30T09:00:00", label="Read your inbox", tool="list_emails", summary=""
                ),
            ]
        )
        == 2
    )
    assert log.days() == [date(2026, 9, 30), date(2026, 9, 29)]
    assert log.day(date(2026, 9, 29)) == [entry("2026-09-29T08:15:02")]
    mode = stat.S_IMODE((tmp_path / "action_log" / "2026-09-29.jsonl").stat().st_mode)
    assert mode == 0o600  # the owner's alone
    assert stat.S_IMODE((tmp_path / "action_log").stat().st_mode) == 0o700


def test_a_torn_or_odd_line_is_skipped_never_an_error(tmp_path):
    folder = tmp_path / "action_log"
    folder.mkdir()
    (folder / "2026-09-29.jsonl").write_text(
        json.dumps(entry("2026-09-29T08:00:00"))
        + "\n{torn\n"
        + json.dumps({"t": "not a time"})
        + "\n"
        + json.dumps({"t": "2026-09-29T09:00:00", "label": 5, "outcome": "exploded"})
        + "\n"
    )
    (folder / "notes.txt").write_text("not a day")
    log = ActionLog(folder)
    assert log.days() == [date(2026, 9, 29)]
    assert log.day(date(2026, 9, 29)) == [
        entry("2026-09-29T08:00:00"),
        {
            "t": "2026-09-29T09:00:00",
            "tool": "",
            "label": "Used a tool",
            "summary": "",
            "outcome": "done",
        },
    ]


def test_a_line_nested_past_reason_is_skipped_too(tmp_path):
    """A hand edit nested deeper than JSON can be read is a line that can't be read: skipped,
    so the day, and every search through it, still reads."""
    folder = tmp_path / "action_log"
    folder.mkdir()
    (folder / "2026-09-29.jsonl").write_text(
        "[" * 100_000 + "]" * 100_000 + "\n" + json.dumps(entry("2026-09-29T08:00:00")) + "\n"
    )
    log = ActionLog(folder)
    assert log.day(date(2026, 9, 29)) == [entry("2026-09-29T08:00:00")]
    assert log.search("Safari") == [entry("2026-09-29T08:00:00")]


def test_search_finds_every_word_newest_first_and_pages_back(tmp_path):
    log = ActionLog(tmp_path)
    log.add(
        [
            entry(
                "2026-09-28T10:00:00",
                label="Added a calendar event",
                tool="create_event",
                summary="",
            ),
            entry("2026-09-29T11:00:00"),
            entry("2026-09-29T12:00:00", summary="Notes"),
            entry(
                "2026-09-30T08:00:00",
                label="Checked the weather",
                tool="weather_report",
                summary="",
            ),
        ]
    )
    assert [e["t"] for e in log.search("opened")] == ["2026-09-29T12:00:00", "2026-09-29T11:00:00"]
    assert [e["t"] for e in log.search("app safari")] == ["2026-09-29T11:00:00"]
    assert [e["t"] for e in log.search("CALENDAR")] == ["2026-09-28T10:00:00"]
    assert len(log.search("")) == 4
    page = log.search("", limit=2)
    assert [e["t"] for e in page] == ["2026-09-30T08:00:00", "2026-09-29T12:00:00"]
    more = log.search("", before=page[-1]["t"], limit=2)
    assert [e["t"] for e in more] == ["2026-09-29T11:00:00", "2026-09-28T10:00:00"]


def test_a_day_is_bounded_and_old_days_go(tmp_path, monkeypatch):
    monkeypatch.setattr(action_log, "DAY_MAX", 3)
    log = ActionLog(tmp_path, clock=lambda: datetime(2026, 9, 30, 12))
    assert log.add([entry(f"2026-09-30T08:00:0{n}") for n in range(5)]) == 3
    assert log.add([entry("2026-09-30T09:00:00")]) == 0
    assert len(log.day(date(2026, 9, 30))) == 3
    old = date(2026, 9, 30) - timedelta(days=action_log.LOG_DAYS)
    kept = date(2026, 9, 30) - timedelta(days=action_log.LOG_DAYS - 1)
    log.add([entry(f"{old.isoformat()}T08:00:00"), entry(f"{kept.isoformat()}T08:00:00")])
    assert log.prune() == 1
    assert old not in log.days() and kept in log.days()
