"""Reminders on a PC (jarvis.winreminders): the same commands and rows reminders_desk and reminders_kit get
from EventKit on a Mac, a to-do list that says each reminder aloud at its time. Temp folders only."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from jarvis import reminders_desk, reminders_kit, winreminders
from jarvis.reminders_desk import _run as real_run  # (before the suite's fixture replaces it)

NOW = datetime(2026, 10, 8, 9, 0)


@pytest.fixture
def clock():
    return [NOW]


@pytest.fixture
def desk(tmp_path, clock):
    return winreminders.Reminders(tmp_path / "Reminders" / "reminders.json", now=lambda: clock[0])


def spec(**more):
    return {"title": "Call the dean", "list": "", "due": "", "notes": "", "priority": 0} | more


def test_a_reminder_is_added_listed_ticked_off_and_deleted(desk, clock):
    added = desk.add(spec(due="2026-10-09T15:00", notes="About the budget", priority=1))["added"]
    assert (
        added["title"] == "Call the dean"
        and added["list"] == "Reminders"
        and added["completed"] is False
    )
    assert (
        added["due"] == "2026-10-09T15:00"
        and added["priority"] == 1
        and added["notes"] == "About the budget"
    )
    assert set(added) == {
        "id",
        "title",
        "notes",
        "list",
        "due",
        "completed",
        "completed_at",
        "created",
        "modified",
        "priority",
        "url",
    }  # fmt: skip  (the rows EventKit's helper gives)
    opened = desk.open_items()
    assert [r["title"] for r in opened["reminders"]] == ["Call the dean"]
    assert opened["lists"] == [{"title": "Reminders", "default": True, "writable": True}]
    clock[0] += timedelta(hours=1)
    done = desk.complete(added["id"])["completed"]
    assert done["completed"] is True and done["completed_at"] == "2026-10-08T10:00:00"
    assert desk.open_items()["reminders"] == []
    assert desk.delete(added["id"])["deleted"]["title"] == "Call the dean"
    assert desk.delete(added["id"]) == {"error": winreminders.NOT_THERE}
    assert desk.complete("nope") == {"error": winreminders.NOT_THERE}


def test_the_open_ones_come_soonest_due_first_and_a_list_is_made_the_first_time_it_is_named(desk):
    desk.add(spec(title="Later", due="2026-10-20"))
    desk.add(spec(title="Sooner", due="2026-10-09T08:00"))
    desk.add(spec(title="Milk", list="shopping"))
    desk.add(spec(title="Eggs", list="Shopping"))  # the same list, whatever the case
    opened = desk.open_items()
    assert [r["title"] for r in opened["reminders"]] == [
        "Sooner",
        "Later",
        "Eggs",
        "Milk",
    ]  # (no date: by title)
    assert [x["title"] for x in opened["lists"]] == ["Reminders", "shopping"]
    assert {r["list"] for r in opened["reminders"] if r["title"] in ("Milk", "Eggs")} == {
        "shopping"
    }


def test_what_the_second_brain_reads_is_the_open_ones_and_those_done_this_month(desk, clock):
    old = desk.add(spec(title="Old"))["added"]["id"]
    desk.complete(old)
    clock[0] += timedelta(days=31)
    fresh = desk.add(spec(title="Fresh"))["added"]["id"]
    desk.complete(fresh)
    desk.add(spec(title="Open"))
    titles = [r["title"] for r in desk.kept()["reminders"]]
    assert titles == ["Open", "Fresh"]  # (open first; "Old" was done more than 30 days ago)


def test_a_timed_reminder_is_said_once_at_its_time(desk, clock):
    desk.add(spec(title="Call the dean", due="2026-10-08T15:00"))
    desk.add(
        spec(title="Pick up the paper", due="2026-10-08")
    )  # a day, no time: never said at a time
    assert desk.due_now() == []  # not yet
    clock[0] = datetime(2026, 10, 8, 15, 0, 20)
    said = desk.due_now()
    assert [r["title"] for r in said] == ["Call the dean"]
    assert desk.due_now() == []  # once
    clock[0] += timedelta(hours=1)
    assert desk.due_now() == []


def test_one_far_too_late_is_left_to_the_briefing_not_said_out_of_the_blue(desk, clock):
    desk.add(spec(title="Yesterday's", due="2026-10-06T09:00"))
    assert desk.due_now() == []  # (the app was closed for two days)
    assert [r["title"] for r in desk.open_items()["reminders"]] == [
        "Yesterday's"
    ]  # still open, and overdue


def test_a_reminder_ticked_off_before_its_time_is_never_said(desk, clock):
    made = desk.add(spec(due="2026-10-08T15:00"))["added"]
    desk.complete(made["id"])
    clock[0] = datetime(2026, 10, 8, 15, 5)
    assert desk.due_now() == []


def test_a_reminder_moved_to_a_new_time_after_it_was_said_is_said_again(desk, clock):
    made = desk.add(spec(due="2026-10-08T09:00"))["added"]
    clock[0] = datetime(2026, 10, 8, 9, 1)
    assert [r["id"] for r in desk.due_now()] == [made["id"]]
    data = desk._load()
    data["reminders"][0]["due"] = "2026-10-08T17:00"
    desk._save(data)
    clock[0] = datetime(2026, 10, 8, 17, 1)
    assert [r["id"] for r in desk.due_now()] == [made["id"]]


def test_the_commands_answer_as_the_event_kit_helpers_do(desk):
    made = winreminders.run(["add", json.dumps(spec(title="Milk"))], desk)["added"]
    assert winreminders.run(["open"], desk)["reminders"][0]["id"] == made["id"]
    assert winreminders.run(["open", "--no-ask"], desk)["reminders"][0]["title"] == "Milk"
    assert winreminders.run(["list"], desk)["reminders"][0]["title"] == "Milk"
    assert "completed" in winreminders.run(["complete", made["id"]], desk)
    assert "deleted" in winreminders.run(["delete", made["id"]], desk)
    assert "usage" in winreminders.run(["frobnicate"], desk)["error"]
    assert winreminders.run(["add", json.dumps({"notes": "no title"})], desk) == {
        "error": "a reminder needs a title"
    }


def test_a_damaged_file_is_said_in_words_not_a_traceback(tmp_path):
    folder = tmp_path / "Reminders"
    folder.mkdir()
    (folder / "reminders.json").write_text("{not json")
    result = winreminders.run(
        ["open"], winreminders.Reminders(folder / "reminders.json", now=lambda: NOW)
    )
    assert "error" in result or result["reminders"] == []


async def test_reminders_desk_asks_winreminders_on_a_pc(tmp_path, monkeypatch):
    """What the tools, the briefing and the phone call: the same functions as on a Mac, answered here."""
    monkeypatch.setattr(reminders_desk, "_run", real_run)
    monkeypatch.setattr(reminders_desk, "ON_A_PC", True)
    monkeypatch.setattr(winreminders, "folder", lambda: tmp_path / "Reminders")
    made = await reminders_desk.add_reminder(
        reminders_desk.clean_new({"title": "Call the dean", "list": "Work"})
    )
    assert made["added"]["list"] == "Work"
    found = await reminders_desk.fetch_open(ask=False)
    assert [r["title"] for r in found["reminders"]] == ["Call the dean"]
    assert [x["title"] for x in found["lists"]] == ["Reminders", "Work"]
    assert "completed" in await reminders_desk.complete_reminder(made["added"]["id"])
    assert (await reminders_desk.fetch_open())["reminders"] == []
    assert "deleted" in await reminders_desk.delete_reminder(made["added"]["id"])
    assert reminders_kit.keep([]) == []
