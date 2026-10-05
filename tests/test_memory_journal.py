"""Daily notes: the day's requests and actions kept as they happen, a Markdown note each
evening (or at first use the next day) with a capped summary, the owner's own edits never
written over, nothing in incognito, and the notes in the second brain's journal source."""

import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from memory_fakes import FakeAI, desk_of, drain, make_hub, said, tools

from jarvis import brain_sources, journal
from jarvis.journal import DayLog, Journal, compose


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


@pytest.fixture
def desk(hub):
    return desk_of(hub)


def at(day, hour, minute=0):
    return datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute)


def activity(day, *labels):
    return [
        {
            "id": f"t{i}",
            "label": label,
            "status": "done",
            "at": at(day, 9, i).isoformat(timespec="seconds"),
        }
        for i, label in enumerate(labels)
    ][::-1]  # newest first, as the hub keeps them


async def test_the_day_is_written_up_in_the_evening(hub, desk):
    today = date.today()
    q = hub.subscribe()
    await desk.heard("what's on my calendar today?")
    await desk.heard("my wifi password is hunter22, remind me")  # blanked out
    hub.activity.extendleft(
        reversed(activity(today, "Checked the calendar", "Checked the calendar", "Sent a message"))
    )
    await desk.log_actions(datetime.now())
    events = [
        {
            "title": "Standup",
            "begin": at(today, 10),
            "end": at(today, 10, 30),
            "attendees": ["Ann Lee"],
        },
        {"title": "Yesterday's thing", "begin": at(today - timedelta(days=1), 10), "end": None},
    ]

    async def calendar(back, ahead):
        assert back >= 0 and ahead >= 0
        return events

    desk.calendar = calendar
    hub.routines.items.append(
        SimpleNamespace(
            name="Morning briefing", last_run=at(today, 7).isoformat(timespec="minutes")
        )
    )
    desk.ai = FakeAI(json.dumps({"summary": "You checked your calendar and had standup with Ann."}))
    assert await desk.daily_note(at(today, 20, 59)) is None  # not its time yet
    path = await desk.daily_note(at(today, 21, 5))
    assert path == desk.journal.folder / f"{today.isoformat()}.md"
    text = path.read_text()
    assert text.startswith(f"# {journal.title(today)}\n\nYou checked your calendar")
    assert "## What you asked\n- " in text and "what's on my calendar today?" in text
    assert "hunter22" not in text and "[redacted]" in text
    assert "- 09:00 Checked the calendar ×2\n- 09:02 Sent a message" in text
    assert (
        "## Meetings\n- 10:00–10:30 Standup · Ann Lee" in text and "Yesterday's thing" not in text
    )
    assert "## Routines that ran\n- 07:00 Morning briefing" in text
    assert text.rstrip().endswith(journal.FOOTER)
    [call] = desk.ai.calls
    assert call["kind"] == "journal" and "<log>" in call["prompt"] and "English" in call["system"]
    assert await desk.daily_note(at(today, 21, 30)) is None  # written once
    assert any(e["type"] == "memory_state" and e["journal"]["notes"] for e in drain(q))


async def test_yesterdays_note_is_written_at_first_use_today(hub, desk):
    today = date.today()
    yesterday = today - timedelta(days=1)
    desk.daylog.request("book a table for Friday", when=at(yesterday, 18))
    path = await desk.daily_note(at(today, 8))
    assert path is not None and path.name == f"{yesterday.isoformat()}.md"
    assert "book a table for Friday" in path.read_text()
    assert not desk.journal.is_written(today.isoformat())


async def test_a_note_written_early_is_finished_at_its_time(hub, desk):
    today = date.today()
    yesterday = today - timedelta(days=1)
    desk.daylog.request("morning request", when=at(today, 9))
    path = await desk.write_note(today, at(today, 15))  # "Write today's note now" at 3 PM
    assert "morning request" in path.read_text()
    desk.daylog.request("evening request", when=at(today, 19))
    assert await desk.daily_note(at(today, 20)) is None  # not its time yet
    assert await desk.daily_note(at(today, 21, 5)) == path
    assert "morning request" in path.read_text() and "evening request" in path.read_text()
    desk._tried.clear()
    assert await desk.daily_note(at(today, 21, 40)) is None  # finished: written once
    # Yesterday's, written early and never finished (the Mac was asleep at nine): at first use.
    desk.daylog.request("lunch booking", when=at(yesterday, 12))
    early = await desk.write_note(yesterday, at(yesterday, 13))
    desk.daylog.request("late call", when=at(yesterday, 22))
    assert not desk.journal.is_complete(yesterday.isoformat())
    desk._tried.clear()
    assert await desk.daily_note(at(today, 8)) == early
    assert "lunch booking" in early.read_text() and "late call" in early.read_text()
    assert desk.journal.is_complete(yesterday.isoformat())


async def test_a_note_the_owner_changed_is_never_written_over(hub, desk):
    today = date.today()
    desk.daylog.request("hello there", when=at(today, 9))
    path = await desk.write_note(today)
    first = path.read_text()
    assert await desk.write_note(today) == path  # ours, unchanged: written again
    path.write_text(first + "\nMy own thoughts.\n")
    assert await desk.write_note(today) is None
    assert path.read_text().endswith("My own thoughts.\n")
    q = hub.subscribe()
    await desk.cmd_journal_write({})
    [toast] = [e for e in drain(q) if e["type"] == "toast"]
    assert "yours now" in toast["text"]


async def test_without_a_summary_the_note_is_still_written(hub, desk):
    desk.budget.day.counts["journal"] = 3  # the day's calls are used up
    desk.daylog.request("what's the time in Tokyo", when=at(date.today(), 9))
    path = await desk.write_note(date.today())
    assert path is not None and desk.ai.calls == []
    assert path.read_text().split("\n\n")[1].startswith("## What you asked")


async def test_a_quiet_day_leaves_no_note(hub, desk):
    assert await desk.write_note(date.today()) is None
    assert not desk.journal.folder.exists() or not list(desk.journal.folder.iterdir())
    q = hub.subscribe()
    await desk.cmd_journal_write({})
    assert "Nothing happened today" in [e for e in drain(q) if e["type"] == "toast"][0]["text"]


async def test_incognito_and_the_setting_keep_it_all_out(hub, desk):
    hub.incognito = True
    await desk.heard("anything at all")
    hub.activity.appendleft(activity(date.today(), "Checked the calendar")[0])
    await desk.log_actions(datetime.now())
    assert desk.daylog.day(date.today().isoformat()) == {"requests": [], "actions": []}
    assert await desk.daily_note(at(date.today(), 22)) is None
    hub.incognito = False
    hub.set_feature_prefs({"memory_journal": False})
    await desk.heard("anything at all")
    assert await desk.daily_note(at(date.today(), 22)) is None


async def test_what_ran_in_incognito_never_reaches_the_log(hub, desk):
    def done(ident, label, began):
        return {"id": ident, "label": label, "status": "done", "at": began.isoformat()}

    def logged():
        days = desk.daylog.days
        return [a[1] for d in sorted(days) for a in days[d]["actions"]], [
            r[1] for d in sorted(days) for r in days[d]["requests"]
        ]

    now = datetime.now().replace(microsecond=0)
    hub.activity.appendleft(done("a", "Checked the calendar", now - timedelta(minutes=9)))
    await desk.log_actions(now)
    hub.incognito = True
    await desk.heard("look up that clinic for me")
    hub.activity.appendleft(done("b", "Searched the web", now - timedelta(minutes=5)))
    await desk.log_actions(now)
    hub.incognito = False
    # Began in incognito, listed once it ended: after incognito went off.
    hub.activity.appendleft(done("c", "Read a page", now - timedelta(minutes=4)))
    await desk.log_actions(now)
    hub.activity.appendleft(done("d", "Played music", datetime.now() + timedelta(seconds=1)))
    await desk.log_actions(now)
    assert logged() == (["Checked the calendar", "Played music"], [])
    q = hub.subscribe()
    hub.incognito = True
    await desk.cmd_journal_write({})
    [toast] = [e for e in drain(q) if e["type"] == "toast"]
    assert "Incognito" in toast["text"] and not desk.journal.folder.exists()


async def test_the_conversations_action_log_is_used_when_there_is_one(hub, desk):
    today = date.today()
    seen = []

    class ActionLog:
        def for_day(self, day):
            seen.append(day)
            return [
                {
                    "at": at(today, 11, 5).isoformat(),
                    "label": "Moved the dentist",
                    "status": "done",
                },
                {
                    "at": at(today, 11, 6).isoformat(),
                    "summary": "Sent Ann a text",
                    "status": "denied",
                },
                "junk",
            ]

    hub.action_log = ActionLog()
    assert desk.actions_for(today) == [
        ["11:05:00", "Moved the dentist", "done"],
        ["11:06:00", "Sent Ann a text", "failed"],
    ]
    assert seen == [today]


async def test_the_days_actions_come_from_the_conversations_own_action_log(hub, desk):
    today = date.today()
    assert hub.action_log is hub.actions  # the conversation feature's log, as memory reads it
    hub.actions.log.add(
        [
            {"t": at(today, 9, 30).isoformat(), "tool": "mcp__mac__create_event",
             "label": "Added lunch with Ann", "summary": "Calendar", "outcome": "done"},
            {"t": at(today, 9, 31).isoformat(), "tool": "mcp__mail__send",
             "label": "Sending an email", "summary": "", "outcome": "failed"},
        ]
    )  # fmt: skip
    assert desk.actions_for(today) == [
        ["09:30:00", "Added lunch with Ann", "done"],
        ["09:31:00", "Sending an email", "failed"],
    ]


async def test_a_note_in_chinese_has_chinese_headings(hub, desk):
    hub.prefs.language = "zh"  # not set_prefs: that readies the Mac's voice for real
    desk.daylog.request("今天的日程是什么", when=at(date.today(), 9))
    desk.ai = FakeAI(json.dumps({"summary": "你查看了日程。"}))
    path = await desk.write_note(date.today())
    text = path.read_text()
    assert "## 你问了什么" in text and "星期" in text.splitlines()[0]
    assert "Simplified Chinese" in desk.ai.calls[0]["system"]


async def test_the_daily_note_tool_reads_a_day(hub, desk):
    today = date.today()
    desk.daylog.request("hello there", when=at(today, 9))
    await desk.write_note(today)
    out = said(await tools(desk)["daily_note"]({"date": ""}))
    assert out.startswith(f'<daily_note date="{today.isoformat()}">') and "hello there" in out
    assert "There's no note" in said(await tools(desk)["daily_note"]({"date": "2020-01-01"}))
    assert (await tools(desk)["daily_note"]({"date": "yesterday"}))["is_error"]


async def test_opening_a_note_only_opens_one_that_is_there(hub, desk):
    today = date.today()
    desk.daylog.request("hello there", when=at(today, 9))
    path = await desk.write_note(today)
    desk.cmd_journal_open({"day": today.isoformat()})
    desk.cmd_journal_open({"day": "../../etc/passwd"})
    desk.cmd_journal_open({"day": "2020-01-01"})
    assert desk.opened == [path]


# ── the day's log ──


def test_the_log_keeps_a_few_days_and_reads_damage_defensively(tmp_path):
    path = tmp_path / "journal_log.json"
    old = (date.today() - timedelta(days=10)).isoformat()
    path.write_text(
        json.dumps(
            {
                "days": {
                    old: {"requests": [["09:00", "old"]], "actions": []},
                    date.today().isoformat(): {
                        "requests": [["09:00", "kept"], ["bad"], [1, 2]],
                        "actions": "nope",
                    },
                    "not-a-day": {},
                },
                "seen": ["a", 5],
            }
        )
    )
    log = DayLog(path)
    assert list(log.days) == [date.today().isoformat()]
    assert log.day(date.today().isoformat()) == {"requests": [["09:00", "kept"]], "actions": []}
    assert log.seen == ["a"]


def test_activity_is_logged_once_each_on_its_own_day(tmp_path):
    log = DayLog(tmp_path / "journal_log.json")
    today = date.today()
    items = activity(today, "Checked the calendar", "Opened a web page")
    items.append(
        {"id": "x", "label": "Still going", "status": "running", "at": at(today, 9).isoformat()}
    )
    assert log.actions_from(items) == 2
    assert log.actions_from(items) == 0  # already logged
    log.flush()
    again = DayLog(log.path)
    assert [a[1] for a in again.day(today.isoformat())["actions"]] == [
        "Checked the calendar",
        "Opened a web page",
    ]


def test_the_log_is_copied_before_a_thread_writes_it(tmp_path):
    log = DayLog(tmp_path / "journal_log.json")
    log.request("what's on today?", at(date.today(), 9))
    payload = log.payload()
    assert log.payload() is None  # nothing new since
    log.request("and tomorrow?", at(date.today(), 10))  # while the copy is being written
    log.write(payload)
    assert [r[1] for r in payload["days"][date.today().isoformat()]["requests"]] == [
        "what's on today?"
    ]
    log.flush()
    assert [r[1] for r in DayLog(log.path).day(date.today().isoformat())["requests"]] == [
        "what's on today?",
        "and tomorrow?",
    ]


def test_an_older_copy_of_the_log_never_lands_over_a_newer_one(tmp_path):
    """A thread's save still under way as a newer copy is saved (the app quitting): the
    older one, finishing last, never goes over it; the file is the log's own shape."""
    today = date.today().isoformat()
    log = DayLog(tmp_path / "journal_log.json")
    log.request("what's on today?", at(date.today(), 9))
    older = log.payload()
    log.request("and tomorrow?", at(date.today(), 10))
    log.flush()  # the newer copy
    log.write(older)  # the thread's, last
    assert [r[1] for r in DayLog(log.path).day(today)["requests"]] == [
        "what's on today?",
        "and tomorrow?",
    ]
    asked = [["09:00", "what's on today?"], ["10:00", "and tomorrow?"]]
    assert json.loads(log.path.read_text()) == {
        "days": {today: {"requests": asked, "actions": []}},
        "seen": [],
    }
    assert not log.dirty


async def test_what_the_days_log_took_in_is_kept_when_the_app_quits(hub, desk, monkeypatch):
    """The loop saves the day's log at each look, a minute apart; the app quitting stops it
    between two: what was asked and done since the last look is saved as it stops, so the
    evening's note still has it."""
    import asyncio

    from jarvis.features import memory as feature

    monkeypatch.setattr(feature, "START_AFTER", 0)
    monkeypatch.setattr(feature, "TICK", 3600)
    today = date.today().isoformat()
    path = desk.daylog.path
    await desk.heard("what's on my calendar today?")
    task = asyncio.create_task(desk.loop())
    for _ in range(500):  # the first look saves what it has
        await asyncio.sleep(0.01)
        if path.exists() and DayLog(path).day(today)["requests"]:
            break
    await desk.heard("and the weather tomorrow?")  # after that look
    hub.activity.appendleft(
        {
            "id": "t9",
            "label": "Checked the weather",
            "status": "done",
            "at": datetime.now().isoformat(timespec="seconds"),
        }
    )
    assert len(DayLog(path).day(today)["requests"]) == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    kept = DayLog(path).day(today)
    assert [r[1] for r in kept["requests"]] == [
        "what's on my calendar today?",
        "and the weather tomorrow?",
    ]
    assert [a[1] for a in kept["actions"]] == ["Checked the weather"]


async def test_a_loop_that_never_heard_anything_saves_no_log(hub, desk, monkeypatch):
    import asyncio

    from jarvis.features import memory as feature

    monkeypatch.setattr(feature, "START_AFTER", 3600)
    task = asyncio.create_task(desk.loop())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "daylog" not in desk._stores
    assert not hub.feature_path("journal_log.json").exists()


def test_a_log_that_couldnt_be_saved_is_tried_again(tmp_path, monkeypatch):
    log = DayLog(tmp_path / "journal_log.json")
    log.request("hello there", at(date.today(), 9))

    def full_disk(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(journal.jsonstore, "save_json", full_disk)
    log.flush()
    monkeypatch.undo()
    assert log.dirty
    log.flush()
    assert DayLog(log.path).day(date.today().isoformat())["requests"][0][1] == "hello there"


def test_compose_leaves_out_empty_sections():
    text = compose(date(2026, 9, 29), requests=[["09:00", "hi"]])
    assert text == (
        "# Tuesday 29 September 2026\n\n## What you asked\n- 09:00 hi\n\n" + journal.FOOTER + "\n"
    )


def test_the_journal_lists_recent_notes_and_whose_they_are(tmp_path):
    notes = Journal(tmp_path / "Journal", tmp_path / "journal_state.json")
    notes.write("2026-09-28", "ours\n")
    (tmp_path / "Journal" / "2026-09-27.md").write_text("the owner's own\n")
    (tmp_path / "Journal" / "notes.md").write_text("not a daily note\n")
    listed = notes.recent()
    assert [(n["day"], n["mine"]) for n in listed] == [("2026-09-28", True), ("2026-09-27", False)]
    assert Journal(tmp_path / "Journal", tmp_path / "journal_state.json").written == notes.written


def test_the_days_are_the_ones_recent_lists_without_reading_a_note(tmp_path, monkeypatch):
    """days(): the wiki reads the notes itself, so it's given recent()'s days (the newest n,
    one that can't be looked at left out) without each note read to tell whose it is."""
    notes = Journal(tmp_path / "Journal", tmp_path / "journal_state.json")
    for day in ("2026-09-25", "2026-09-26", "2026-09-28"):
        notes.write(day, f"ours, {day}\n")
    (tmp_path / "Journal" / "2026-09-27.md").write_text("the owner's own\n")
    (tmp_path / "Journal" / "notes.md").write_text("not a daily note\n")
    (tmp_path / "Journal" / "2026-09-29.md").symlink_to(tmp_path / "gone.md")  # can't be read
    for n in (0, 1, 2, 3, 14):
        assert notes.days(n) == [note["day"] for note in notes.recent(n)]
    assert notes.days() == ["2026-09-28", "2026-09-27", "2026-09-26", "2026-09-25"]
    looked = []
    monkeypatch.setattr(Journal, "owners", lambda self, day: looked.append(day))
    notes.days(14)
    assert looked == []
    assert Journal(tmp_path / "nowhere", tmp_path / "state.json").days() == []


# ── the second brain reads them ──


def test_the_second_brain_reads_the_journal(tmp_path, monkeypatch):
    folder = tmp_path / "Journal"
    folder.mkdir()
    (folder / "2026-09-28.md").write_text(
        "# Monday\n\n## What you asked\n- 09:00 book the dentist\n"
    )
    monkeypatch.setattr(journal, "JOURNAL_DIR", folder)
    base = {"store": str(tmp_path / "brain" / "index.json"), "folders": []}
    assert "journal" not in brain_sources.extra_sources({**base, "more": {"journal": False}})
    found = brain_sources.extra_sources({**base, "more": {"journal": True}})
    [note] = found["journal"]()
    assert note.source == "journal" and "book the dentist" in note.text
    assert brain_sources.SWITCHES["journal"] == ("brain_journal", True)
