"""Undo for JARVIS's own actions (undo.py, run by jarvis.features.actions): every call is
weighed as it runs (the hooks the feature adds at each connect, played here by a fake Claude
Code that calls them around each tool), and "undo that" puts back what the last one changed,
for half an hour: calendar events, memory, routines, documents (to the Trash), shortcuts
made instant. Messages and calls are said plainly to be past undoing. No real calendar,
Trash or Claude."""

import asyncio
from datetime import date

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from conftest import FakeClient
from conversation_support import answer_card

from jarvis import calendar_kit, undo
from jarvis.features.actions import asks_undo
from jarvis.hub import Hub
from jarvis.memory import MemoryStore
from jarvis.routines import RoutineStore


class Transcriber:
    def warm_up(self):
        pass


def result():
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        total_cost_usd=0.01,
        result="",
    )


class Claude(FakeClient):
    """Claude Code as the hooks see it: for each call in `calls` (name, args, effect,
    error), PreToolUse, the tool's effect on the Mac, then PostToolUse (or
    PostToolUseFailure), and the stream the hub reads."""

    calls: list = []

    async def _hooks(self, kind, name, args, tid):
        for matcher in (self.options.hooks or {}).get(kind, []):
            for hook in matcher.hooks:
                await hook({"tool_name": name, "tool_input": args}, tid, None)

    async def query(self, text):
        self.queries.append(text)
        stream = []
        for n, (name, args, effect, error) in enumerate(type(self).calls):
            tid = f"t{len(self.queries)}-{n}"
            await self._hooks("PreToolUse", name, args, tid)
            if effect is not None:
                done = effect()
                if asyncio.iscoroutine(done):
                    await done
            await self._hooks("PostToolUseFailure" if error else "PostToolUse", name, args, tid)
            stream.append(
                AssistantMessage(content=[ToolUseBlock(id=tid, name=name, input=args)], model="m")
            )
            stream.append(
                UserMessage(
                    content=[ToolResultBlock(tool_use_id=tid, content="ok", is_error=error)]
                )
            )
        stream += [AssistantMessage(content=[TextBlock(text="Done.")], model="m"), result()]
        self.script = stream


class Calendar:
    """The calendar undo reaches: rows as calendar_kit gives them, changed in memory."""

    def __init__(self):
        self.rows = []
        self.removed, self.edited, self.added = [], [], []
        self.choose, self.when = calendar_kit.choose, calendar_kit.when

    def row(self, title, begin, **extra):
        found = {
            "title": title,
            "begin": begin,
            "end": begin[:11] + "16:00",
            "all_day": False,
            "location": "",
            "calendar": "Home",
            "id": f"id-{title}",
            "attendees": [],
            "writable": True,
            "repeats": False,
            **extra,
        }
        self.rows.append(found)
        return found

    async def events_at(self, start):
        return {"events": [dict(r) for r in self.rows if r["begin"].startswith(start[:16])]}

    async def remove_at(self, start, event_id, calendar, future):
        self.removed.append((start, event_id, calendar, future))
        self.rows = [r for r in self.rows if r["id"] != event_id]
        return {"removed": {}}

    async def edit_at(self, start, event_id, calendar, future, changes):
        self.edited.append((start, event_id, calendar, future, changes))
        for r in self.rows:
            if r["id"] == event_id:
                r["title"], r["begin"] = changes["title"], changes["start"]
        return {"edited": {}}

    async def add_event(self, event):
        self.added.append(event)
        self.rows.append({**event, "id": "id-again"})
        return {"added": event}


def make_hub(settings, speaker, isolated):
    class Client(Claude):
        calls = []

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.events = events
    hub.claude = Client
    hub.calendar = Calendar()
    hub.actions.undo.calendar = hub.calendar
    hub.trashed = []
    hub.actions.undo.trash = hub.trashed.append
    return hub


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


async def settle(hub):
    await asyncio.sleep(0)
    await asyncio.wait_for(hub.actions.flush(), 60)


async def turn(hub, text, *calls):
    """A request whose calls (name, args, effect[, error]) run as Claude Code runs them."""
    hub.claude.calls = [(*c, False) if len(c) == 3 else c for c in calls]
    said = await hub.ask(text)
    await settle(hub)
    return said


async def test_undo_that_forgets_what_was_just_remembered(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "Remember that Ann's birthday is 3 May",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("Ann's birthday is 3 May.")),
    )
    assert [f.text for f in hub.memory.facts] == ["Ann's birthday is 3 May."]
    offer = emitted(hub, "undo_offer")[-1]
    assert offer["label"] == "Remembered “Ann's birthday is 3 May.”"
    said = await turn(hub, "Undo that")
    assert said == "Undone: I've forgotten that again."
    assert hub.memory.facts == [] and MemoryStore(tmp_path / "memory.json").facts == []
    assert emitted(hub, "undo_offer")[-1] == {"id": "", "label": ""}
    (kept,) = [e for e in hub.actions.log.day(date.today()) if e["tool"] == "undo"]
    assert kept["label"] == "Undid: Remembered “Ann's birthday is 3 May.”"
    assert (
        await turn(hub, "undo that") == "There's nothing of mine to undo from the last half hour."
    )


async def test_undo_that_again_undoes_the_one_before(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    for text in ["Ann's birthday is 3 May.", "Bo is my dog."]:
        await turn(
            hub, f"Remember {text}", ("mcp__memory__remember", {}, lambda t=text: hub.memory.add(t))
        )
    assert await turn(hub, "undo that") == "Undone: I've forgotten that again."
    assert [f.text for f in hub.memory.facts] == ["Ann's birthday is 3 May."]
    # Claude's own undo is never itself the thing to undo next.
    hub.claude.calls = [("mcp__actions__undo_action", {}, None, False)]
    await hub.ask("Put that back as it was")
    await settle(hub)
    assert await turn(hub, "undo that") == "Undone: I've forgotten that again."
    assert hub.memory.facts == []


async def test_a_forgotten_fact_comes_back_where_it_was(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    for text in ["Ann is my sister.", "I take my coffee black.", "Bo is my dog."]:
        hub.memory.add(text)
    await hub.start()
    await turn(
        hub,
        "Forget how I take my coffee",
        ("mcp__memory__forget", {}, lambda: hub.memory.forget("coffee")),
    )
    assert [f.text for f in hub.memory.facts] == ["Ann is my sister.", "Bo is my dog."]
    assert await turn(hub, "undo that") == "Undone: I remember it again."
    assert [f.text for f in hub.memory.facts] == [
        "Ann is my sister.",
        "I take my coffee black.",
        "Bo is my dog.",
    ]


async def test_routines_made_paused_and_deleted_come_back(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "Every weekday at 7 brief me",
        (
            "mcp__routines__create_routine",
            {},
            lambda: hub.routines.add("Morning", "Brief me", "weekdays", "07:00"),
        ),
    )
    (made,) = hub.routines.items
    assert await turn(hub, "undo that") == "Undone: the routine “Morning” is gone."
    assert hub.routines.items == [] and RoutineStore(tmp_path / "routines.json").items == []
    kept = hub.routines.add("Evening", "Wind down", "daily", "21:00")
    await turn(
        hub,
        "Pause the evening routine",
        ("mcp__routines__pause_routine", {}, lambda: hub.routines.set_enabled(kept.id, False)),
    )
    assert await turn(hub, "undo that") == "Undone: the routine “Evening” is on again."
    assert hub.routines.find(kept.id).enabled is True
    await turn(
        hub,
        "Delete the evening routine",
        ("mcp__routines__delete_routine", {}, lambda: hub.routines.remove(kept.id)),
    )
    assert await turn(hub, "undo that") == "Undone: the routine “Evening” is back."
    assert [r.name for r in RoutineStore(tmp_path / "routines.json").items] == ["Evening"]


async def test_a_saved_document_goes_to_the_trash_unless_it_changed_since(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    write = ("mcp__documents__write_document", {}, None)

    def save(title):
        return lambda: hub.documents.write(title, "# Plan\n\nThree steps.", "md")

    await turn(hub, "Write up the plan", (write[0], write[1], save("Plan")))
    (plan,) = [r for r in hub.documents.recent if r.title == "Plan"]
    assert await turn(hub, "undo that") == "Undone: “Plan” is in the Trash."
    assert [str(p) for p in hub.trashed] == [plan.path]
    assert all(r.path != plan.path for r in hub.documents.recent)
    await turn(hub, "Write up the budget", (write[0], write[1], save("Budget")))
    (budget,) = [r for r in hub.documents.recent if r.title == "Budget"]
    with open(budget.path, "a") as changed:
        changed.write("\nThe owner's own line.")
    said = await turn(hub, "undo that")
    assert said == "You've changed “Budget” since I saved it, so I've left it where it is."
    assert len(hub.trashed) == 1


async def test_calendar_changes_are_put_back_through_eventkit(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    cal = hub.calendar
    await hub.start()
    start = "2026-10-02T15:00"
    await turn(
        hub,
        "Add the dentist on Friday at 3",
        (
            "mcp__mac__create_event",
            {"title": "Dentist", "start": start},
            lambda: cal.row("Dentist", start),
        ),
    )
    assert await turn(hub, "undo that") == "Undone: “Dentist” is off your calendar again."
    assert cal.removed == [(start, "id-Dentist", "Home", False)] and cal.rows == []
    # Changed: its old title, time and length back.
    cal.row("Review", start, location="Room 4")

    def move():
        cal.rows[0].update(title="Design review", begin="2026-10-02T16:00")

    await turn(
        hub,
        "Move the review to 4 and call it design review",
        (
            "mcp__mac__edit_event",
            {"title": "Review", "start": start, "new_start": "2026-10-02T16:00"},
            move,
        ),
    )
    assert await turn(hub, "undo that") == "Undone: “Review” is back as it was."
    ((at, event_id, _cal, future, changes),) = cal.edited
    assert (at, event_id, future) == ("2026-10-02T16:00", "id-Review", False)
    assert changes == {
        "title": "Review",
        "location": "Room 4",
        "start": start,
        "duration_minutes": 60,
    }
    # Removed: back as a one-off, and nobody invited again.
    cal.rows = []
    lunch = cal.row("Lunch", start, attendees=["Ann"], repeats=True)
    await turn(
        hub,
        "Remove lunch on Friday",
        (
            "mcp__mac__remove_event",
            {"title": "Lunch", "start": start},
            lambda: cal.rows.remove(lunch),
        ),
    )
    said = await turn(hub, "undo that")
    assert said == (
        "Undone: “Lunch” is back on your calendar as a one-off. Those who were in it weren't "
        "invited again."
    )
    assert cal.added[0]["title"] == "Lunch" and cal.added[0]["begin"] == start


async def test_a_series_removed_for_good_is_said_to_be_past_putting_back(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    cal = hub.calendar
    await hub.start()
    start = "2026-10-02T09:00"
    standup = cal.row("Standup", start, repeats=True)
    await turn(
        hub,
        "Remove the standup and every one after it",
        (
            "mcp__mac__remove_event",
            {"title": "Standup", "start": start, "future": True},
            lambda: cal.rows.remove(standup),
        ),
    )
    said = await turn(hub, "undo that")
    assert said == (
        "“Standup” was a repeating series and every later one went; I can't put a series back."
    )
    assert cal.added == []


async def test_a_shortcut_made_instant_asks_first_again(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "Run movie mode",
        (
            "mcp__mac__run_shortcut",
            {"name": "Movie mode"},
            lambda: hub.set_prefs({"instant_shortcuts": ["Movie mode"]}),
        ),
    )
    said = await turn(hub, "undo that")
    assert said == (
        "Undone: the shortcut “Movie mode” asks first again. What it did when it ran can't be "
        "undone from here."
    )
    assert hub.prefs.instant_shortcuts == []


async def test_what_went_out_is_said_plainly_to_be_past_undoing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(hub, "Text Ann I'm late", ("mcp__messages__send_message", {"to": "Ann"}, None))
    said = await turn(hub, "undo that")
    assert said == "That message has already gone, so I can't take it back."
    await turn(hub, "Call Bo", ("mcp__phone__call_someone", {}, None))
    assert await turn(hub, "take that back") == (
        "That call has already been made; a call can't be undone."
    )


async def test_undo_that_means_the_last_thing_and_claude_can_name_an_older_one(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "Remember the gate code is on the fridge",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("The gate code is on the fridge.")),
    )
    await turn(hub, "Open Safari", ("mcp__mac__open_app", {"name": "Safari"}, None))
    said = await turn(hub, "undo that")
    assert said.startswith("I can't undo the last thing I did (")
    # Claude, asked in other words: the older one, by what it was, after a card.
    (_what, undo_action) = hub.actions.tools()
    asked = hub._spawn(undo_action.handler({"which": "the gate code fact"}))
    card = await answer_card(hub, "allow")
    assert card["question"] == "Undo this: Remembered “The gate code is on the fridge.”?"
    out = await asked
    assert out["content"][0]["text"] == "Undone: I've forgotten that again."
    assert hub.memory.facts == []
    out = await undo_action.handler({"which": "the dentist"})
    assert out["content"][0]["text"] == "I haven't done anything like that in the last half hour."
    # The owner's own words asked to undo it: no card.
    await turn(
        hub,
        "Remember the spare key is under the mat",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("The spare key is under the mat.")),
    )
    hub._turn_text = "Please undo the spare key one"
    out = await undo_action.handler({"which": "spare key"})
    assert out["content"][0]["text"] == "Undone: I've forgotten that again." and not hub.approvals
    hub.prefs.language = "zh"
    await turn(
        hub,
        "记住备用钥匙在门垫下面",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("The spare key is under the mat.")),
    )
    hub._turn_text = "撤销刚才记住的那条"
    out = await undo_action.handler({"which": ""})
    assert out["content"][0]["text"] == "已撤销：我已经重新忘掉了那条。" and not hub.approvals


async def test_looking_failing_and_half_an_hour_leave_nothing_to_undo(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(hub, "What's on today?", ("mcp__mac__list_events", {}, None))
    nothing = "There's nothing of mine to undo from the last half hour."
    assert await turn(hub, "undo that") == nothing
    await turn(
        hub,
        "Remember Ann is vegetarian",
        ("mcp__memory__remember", {}, None, True),  # it failed: nothing changed
    )
    assert await turn(hub, "undo that") == nothing
    await turn(
        hub,
        "Remember Ann is vegetarian",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("Ann is vegetarian.")),
    )
    later = undo.time.monotonic() + undo.UNDO_SECONDS + 1
    monkeypatch.setattr(hub.actions.undo, "clock", lambda: later)
    assert await turn(hub, "undo that") == nothing
    assert [f.text for f in hub.memory.facts] == ["Ann is vegetarian."]


async def test_the_undo_button_under_the_reply(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "Remember Bo's vet is Dr Ruiz",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("Bo's vet is Dr Ruiz.")),
    )
    offer = emitted(hub, "undo_offer")[-1]
    assert offer["id"] and offer["label"] == "Remembered “Bo's vet is Dr Ruiz.”"
    await turn(hub, "Open Safari", ("mcp__mac__open_app", {"name": "Safari"}, None))
    assert emitted(hub, "undo_offer")[-1] == {"id": "", "label": ""}  # that turn's own only
    await hub._handle({"type": "undo_action", "id": offer["id"]})
    await settle(hub)
    assert emitted(hub, "toast")[-1] == {
        "title": "Undo",
        "text": "Undone: I've forgotten that again.",
    }
    assert hub.memory.facts == []
    await hub._handle({"type": "undo_action", "id": "u999"})
    await settle(hub)
    assert emitted(hub, "toast")[-1]["text"] == (
        "There's nothing of mine to undo from the last half hour."
    )


async def test_in_chinese(settings, quiet_speaker, isolated):
    isolated["prefs_store"].prefs.language = "zh"
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await turn(
        hub,
        "记住安的生日是五月三号",
        ("mcp__memory__remember", {}, lambda: hub.memory.add("Ann's birthday is 3 May.")),
    )
    assert emitted(hub, "undo_offer")[-1]["label"] == "记住了“Ann's birthday is 3 May.”"
    assert await turn(hub, "撤销刚才的操作") == "已撤销：我已经重新忘掉了那条。"


async def test_the_hooks_ride_along_with_the_gates_own(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hooks = hub.client.options.hooks
    before = [h.__self__ for m in hooks["PreToolUse"] for h in m.hooks]
    # undo's, and the chats' check of what a group's request may use (channels.groups)
    assert [type(o).__name__ for o in before] == ["Actions", "Channels"]
    assert len(hooks["PostToolUse"]) == 2 and len(hooks["PostToolUseFailure"]) == 2


@pytest.mark.parametrize(
    "text, yes",
    [
        ("undo that", True),
        ("Jarvis, undo that.", True),
        ("Oops, undo the last thing you did", True),
        ("Could you undo what you just did?", True),
        ("undo", True),
        ("take that back", True),
        ("undo the calendar change", False),  # for Claude, which finds it
        ("how do I undo a commit?", False),
        ("undo my last git commit", False),
    ],
)
def test_undo_that_is_a_whole_request(text, yes):
    assert asks_undo(text, "en") is yes


def test_undo_that_in_chinese():
    for text in ["撤销", "撤销刚才的操作", "好的，把刚才那步撤销了", "撤回一下"]:
        assert asks_undo(text, "zh"), text
    for text in ["怎么撤销邮件？", "撤销订单要多久"]:
        assert not asks_undo(text, "zh"), text
    assert not asks_undo("撤销", "en")


async def test_a_removed_event_goes_back_through_the_helper(monkeypatch):
    asked = []

    async def helper(*argv, timeout=70):
        asked.append(argv)
        return {"added": {}}

    monkeypatch.setattr(calendar_kit, "_helper", helper)
    row = {"title": "Lunch", "begin": "2026-10-02T12:00", "end": "2026-10-02T13:00"}
    await calendar_kit.add_event({**row, "attendees": ["Ann"], "id": "x", "calendar": "Home"})
    ((command, event),) = asked
    assert command == "add"
    assert event == (
        '{"title": "Lunch", "begin": "2026-10-02T12:00", "end": "2026-10-02T13:00", '
        '"all_day": null, "location": null, "calendar": "Home"}'
    )


def test_the_helper_puts_an_event_back_from_its_fields(monkeypatch, capsys):
    added = []
    monkeypatch.setattr(calendar_kit, "add", lambda event: added.append(event) or {"added": event})
    monkeypatch.setattr(calendar_kit.sys, "argv", ["calendar_kit", "add", '{"title": "Lunch"}'])
    calendar_kit.main()
    assert added == [{"title": "Lunch"}]
    assert '"added"' in capsys.readouterr().out
    monkeypatch.setattr(calendar_kit.sys, "argv", ["calendar_kit", "add", "[1, 2]"])
    calendar_kit.main()
    assert added == [{"title": "Lunch"}] and "not an event" in capsys.readouterr().out
