"""Habits into routines (jarvis.features.proactive.habits): "Make it a routine" on a habit
card, or said while one is up, puts up the routine's own card and adds it on yes; the habit
is then never suggested again. No model, no real clock: the suggester's is pinned."""

from datetime import datetime, timedelta

import pytest
from conftest import FakeClient

from jarvis import suggestions
from jarvis.features.proactive import feature_of
from jarvis.features.proactive import habits as h
from jarvis.hub import Hub

NOW = datetime(2026, 9, 30, 7, 50)  # a Wednesday, just before the usual 8 o'clock


def asked_on(days, hour=8, minute=0, text="what's the weather"):
    return [
        {
            "k": suggestions.request_key(text),
            "t": text,
            "at": (NOW - timedelta(days=d))
            .replace(hour=hour, minute=minute)
            .isoformat(timespec="minutes"),
        }
        for d in days
    ]


@pytest.fixture
async def rig(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    suggester = hub.suggester
    suggester._now = lambda: NOW
    suggester.history = asked_on([1, 2, 5, 6, 7])  # Tue, Mon, Fri, Thu, Wed: weekdays at 8
    [card] = await suggester.tick()
    asked, events = [], []

    async def confirm(question):
        asked.append(question)
        return answer["yes"]

    answer = {"yes": True}
    hub.confirm = confirm
    hub.add_event_sink(("caption", "proactive"), events.append)
    return hub, feature_of(hub).habits, card, asked, answer, events


def test_a_habits_days_and_time_make_its_schedule():
    habit = lambda days, minutes: suggestions.Habit("k", "x", minutes, days, 3)  # noqa: E731
    assert h.schedule_of(habit("weekdays", 7 * 60 + 58)) == ("weekdays", [], "08:00")
    assert h.schedule_of(habit("weekends", 9 * 60 + 31)) == ("weekly", [5, 6], "09:30")
    assert h.schedule_of(habit("4", 17 * 60 + 2)) == ("weekly", [4], "17:00")
    assert h.schedule_of(habit("daily", 23 * 60 + 58)) == ("daily", [], "00:00")


async def test_the_card_makes_it_a_routine_and_it_is_never_suggested_again(rig):
    hub, part, card, asked, _answer, events = rig
    assert card.suggestion == "habit" and card.key in hub.suggester.open
    await part.command({"type": "habit_routine", "key": card.key})
    assert asked == ["Add a routine, weekdays at 8 AM: what's the weather?"]
    [routine] = hub.routines.items
    assert (routine.name, routine.prompt, routine.kind, routine.time) == (
        "what's the weather",
        "what's the weather",
        "weekdays",
        "08:00",
    )
    assert [e["text"] for e in events if e["type"] == "caption"] == [
        "Added the routine “what's the weather”, weekdays at 8 AM."
    ]
    assert [e["habit"] for e in events if "habit" in e] == [{"key": card.key, "done": True}]
    assert card.key not in hub.suggester.open
    assert hub.suggester.topics[card.topic]["never"] is True
    assert hub.suggester._habits(NOW + timedelta(days=1)) == [] or all(
        not hub.suggester._allowed(s, NOW + timedelta(days=1))
        for s in hub.suggester._habits(NOW + timedelta(days=1))
    )
    assert "I won't suggest “what's the weather” again." in hub.suggester.explain()


async def test_no_on_the_card_adds_nothing_and_the_suggestion_stays(rig):
    hub, part, card, asked, answer, events = rig
    answer["yes"] = False
    await part.command({"key": card.key})
    assert hub.routines.items == [] and card.key in hub.suggester.open
    assert [e["habit"] for e in events if "habit" in e] == [{"key": card.key, "done": False}]
    assert [e["text"] for e in events if e["type"] == "caption"] == ["The routine wasn't added."]
    await part.command({"key": "habit:gone"})
    assert [e["text"] for e in events if e["type"] == "caption"][-1] == (
        "That habit card isn't up any more."
    )


async def test_said_while_the_card_is_up(rig):
    hub, part, card, asked, _answer, _events = rig
    assert await part.instant("what's a routine?") is None
    reply = await part.instant("OK, make it a routine")
    assert reply == "Added the routine “what's the weather”, weekdays at 8 AM." and asked
    assert await part.instant("make it a routine") is None  # no card up: Claude hears it
    assert h.said_make_routine("把它设为例行任务") and h.said_make_routine(
        "Turn this into a routine."
    )
    assert not h.said_make_routine("make it a routine that runs at 9 and emails Ann the report")
