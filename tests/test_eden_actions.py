"""Undo for what apps did through Jarvis (jarvis.eden_actions, around jarvis.mcp_endpoint's
calls): what's kept for each change (and only for one that was done), the action log's
line with nothing private in it, actions_list for Eden's Activity timeline, and action_undo,
which puts things back only on the owner's yes on a card. A fake calendar and a fake Mail;
the memory is the `isolated` fixture's temp store."""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta

import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import eden_actions
from jarvis.eden_actions import EdenActions, actions_for
from jarvis.hub import Hub
from jarvis.mcp_endpoint import Endpoint, build_app

SESSION = "4ct10nss3ss10n01"
DENTIST = {
    "id": "ev-1",
    "title": "Dentist",
    "begin": "2026-10-07T10:00:00",
    "end": "2026-10-07T10:45:00",
    "all_day": False,
    "calendar": "Home",
    "location": "High St",
    "attendees": [],
    "repeats": False,
}


class FakeCalendar:
    """calendar_kit's few calls undo needs, over a list of rows."""

    def __init__(self, rows=()):
        self.rows = [dict(r) for r in rows]
        self.calls = []

    async def events_at(self, start):
        return {"events": [r for r in self.rows if r["begin"][:16] == start[:16]]}

    def choose(self, rows, title, calendar=""):
        return [
            r
            for r in rows
            if r["title"].lower() == title.lower() and (not calendar or r["calendar"] == calendar)
        ]

    def when(self, start):
        return datetime.fromisoformat(start), len(start) == 10

    async def remove_at(self, start, event_id, calendar, future):
        self.calls.append(("remove", start, event_id, calendar, future))
        self.rows = [r for r in self.rows if r["id"] != event_id]
        return {"removed": {}}

    async def edit_at(self, start, event_id, calendar, future, changes):
        self.calls.append(("edit", start, event_id, calendar, future, changes))
        return {"edited": {}}

    async def add_event(self, event):
        self.calls.append(("add", event["title"], event["begin"]))
        return {"added": {}}


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    return hub


def endpoint_for(hub, calendar=None):
    endpoint = Endpoint(hub, hub.feature_path("mcp"))
    endpoint.token = "the-token"
    actions_for(endpoint).calendar = calendar or FakeCalendar()
    return endpoint


async def with_card(hub, call, choice):
    cards = []
    hub.add_approval_sink(cards.append)

    async def answer():
        for _ in range(500):
            await asyncio.sleep(0)
            if hub.approvals:
                card = next(iter(hub.approvals.values()))
                assert hub.resolve(card["id"], choice)
                return
        raise AssertionError("no card went up")

    (text, error), _ = await asyncio.gather(call, answer())
    return json.loads(text), error, cards


async def listed(endpoint, app="Eden", **args):
    text, error = await endpoint.call("actions_list", args, app)
    assert not error, text
    return json.loads(text)["items"]


async def done_change(actions, tool, args, answer, app="Eden"):
    """A change as mcp_endpoint.call runs it: looked at before, then its answer weighed."""
    before = await actions.before(tool, args)
    await actions.after(tool, args, app, json.dumps(answer), False, before)


# ── the calendar ──


async def test_a_created_event_is_kept_and_its_undo_removes_it_on_a_yes(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    cal = FakeCalendar()
    endpoint = endpoint_for(hub, cal)
    actions = actions_for(endpoint)
    args = {"title": "Dentist", "start": "2026-10-07T10:00", "confirm": True}
    before = await actions.before("calendar_create", args)
    cal.rows.append(dict(DENTIST))  # Jarvis added it (on the owner's own card)
    await actions.after(
        "calendar_create",
        args,
        "Eden",
        json.dumps({"done": True, "status": "added"}),
        False,
        before,
    )
    [item] = await listed(endpoint)
    assert item["label"] == "Added “Dentist” to your calendar" and item["kind"] == "calendar"
    assert item["detail"] == "Wed 7 Oct, 10:00 · Home" and item["undo"] == {
        "possible": True,
        "why": "",
    }
    assert item["source"] == "eden" and item["app"] == "Eden" and item["undone"] == ""
    # The action log has a line with nothing private in it.
    logged = actions._action_log().search(source="eden")
    assert [e["label"] for e in logged] == ["Eden added an event"] and logged[0]["ref"] == item[
        "id"
    ]
    log_text = "".join(p.read_text() for p in hub.feature_path("action_log").glob("*.jsonl"))
    assert "Dentist" not in log_text
    # What's kept to undo it is the owner's alone.
    kept = hub.feature_path("eden_actions") / f"{item['id']}.json"
    assert oct(os.stat(kept).st_mode & 0o777) == "0o600"
    assert oct(os.stat(kept.parent).st_mode & 0o777) == "0o700"
    # Undo: no without confirm; a no on the card changes nothing; a yes removes it.
    text, error = await endpoint.call("action_undo", {"id": item["id"]}, "Eden")
    assert error and "confirm: true" in text
    answer, error, [card] = await with_card(
        hub, endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden"), "deny"
    )
    assert answer["status"] == "declined" and cal.calls == []
    assert card["question"] == "Undo this: Added “Dentist” to your calendar?"
    assert "“Dentist” comes off your calendar again." in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Undo", "Keep it"]
    answer, error, _ = await with_card(
        hub, endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden"), "allow"
    )
    assert not error and answer["status"] == "undone"
    assert cal.calls == [("remove", "2026-10-07T10:00", "ev-1", "Home", False)]
    [item] = await listed(endpoint)
    assert item["undone"]  # the timeline shows it undone, not a line of its own
    text, error = await endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden")
    assert error and "undone already" in json.loads(text)["text"]


async def test_a_changed_event_goes_back_from_its_snapshot(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    cal = FakeCalendar([DENTIST])
    endpoint = endpoint_for(hub, cal)
    actions = actions_for(endpoint)
    args = {
        "title": "Dentist",
        "start": "2026-10-07T10:00",
        "new_start": "2026-10-08T14:30",
        "new_title": "Dentist (moved)",
        "confirm": True,
    }
    await done_change(actions, "calendar_update", args, {"done": True, "status": "changed"})
    [item] = await listed(endpoint)
    assert item["label"] == "Changed “Dentist” on your calendar" and item["undo"]["possible"]
    answer, _, [card] = await with_card(
        hub, endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden"), "allow"
    )
    assert answer["status"] == "undone"
    assert "goes back to how it was (Wed 7 Oct, 10:00 · Home)" in card["detail"]
    assert cal.calls == [
        (
            "edit",
            "2026-10-08T14:30",
            "ev-1",
            "Home",
            False,
            {
                "title": "Dentist",
                "location": "High St",
                "start": "2026-10-07T10:00",
                "duration_minutes": 45,
            },
        )
    ]


async def test_notes_link_and_alerts_go_back_only_when_the_change_touched_them(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    row = DENTIST | {"notes": "Bring the card.", "url": "https://dent.example/x", "alerts": [10]}
    cal = FakeCalendar([row])
    endpoint = endpoint_for(hub, cal)
    actions = actions_for(endpoint)
    args = {
        "title": "Dentist",
        "start": "2026-10-07T10:00",
        "new_notes": "",
        "new_alerts": [60, 0],
        "confirm": True,
    }
    await done_change(actions, "calendar_update", args, {"done": True, "status": "changed"})
    [item] = await listed(endpoint)
    kept = json.loads((hub.feature_path("eden_actions") / f"{item['id']}.json").read_text())
    # the snapshot keeps the old notes (to put them back), not the link it didn't touch
    assert "url" not in json.dumps(kept["state"]["event"]) and "notes" not in kept["state"]["event"]
    await with_card(
        hub, endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden"), "allow"
    )
    [(_, _, _, _, _, changes)] = cal.calls
    assert changes["notes"] == "Bring the card." and changes["alerts"] == [10]
    assert "url" not in changes


async def test_a_removed_event_comes_back_but_a_series_cant(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    weekly = {
        **DENTIST,
        "id": "ev-2",
        "title": "Standup",
        "begin": "2026-10-07T09:00:00",
        "repeats": True,
    }
    cal = FakeCalendar([DENTIST, weekly])
    endpoint = endpoint_for(hub, cal)
    actions = actions_for(endpoint)
    one = {"title": "Dentist", "start": "2026-10-07T10:00", "confirm": True}
    series = {"title": "Standup", "start": "2026-10-07T09:00", "future": True, "confirm": True}
    await done_change(actions, "calendar_delete", one, {"done": True, "status": "removed"})
    await done_change(actions, "calendar_delete", series, {"done": True, "status": "removed"})
    standup, dentist = await listed(endpoint)
    assert standup["undo"] == {
        "possible": False,
        "why": "It was a repeating series and every later one went: a series can't be put back.",
    }
    text, error = await endpoint.call("action_undo", {"id": standup["id"], "confirm": True}, "Eden")
    assert error and "series" in json.loads(text)["text"] and cal.calls == []  # no card either
    answer, _, _ = await with_card(
        hub, endpoint.call("action_undo", {"id": dentist["id"], "confirm": True}, "Eden"), "allow"
    )
    assert answer["status"] == "undone" and cal.calls == [("add", "Dentist", "2026-10-07T10:00:00")]


async def test_a_change_not_done_is_not_an_action(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub, FakeCalendar([DENTIST]))
    actions = actions_for(endpoint)
    args = {"title": "Dentist", "start": "2026-10-07T10:00", "confirm": True}
    await done_change(actions, "calendar_delete", args, {"done": False, "status": "declined"})
    await done_change(
        actions, "mail_send", {"to": ["ann@example.com"]}, {"sent": False, "status": "declined"}
    )
    before = await actions.before("calendar_delete", args)
    await actions.after("calendar_delete", args, "Eden", "That didn't work.", True, before)
    assert await listed(endpoint) == []


# ── mail ──


async def test_a_sent_email_says_plainly_it_cant_be_undone(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    actions = actions_for(endpoint)
    args = {
        "to": ["ann@example.com"],
        "subject": "Q4 numbers",
        "body": "Attached.",
        "confirm": True,
    }
    await done_change(actions, "mail_send", args, {"sent": True, "status": "sent"})
    [item] = await listed(endpoint)
    assert item["label"] == "Sent “Q4 numbers” to ann@example.com"
    assert item["undo"] == {"possible": False, "why": "A sent email can't be unsent."}
    cards = []
    hub.add_approval_sink(cards.append)
    text, error = await endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden")
    assert error and json.loads(text)["text"] == "A sent email can't be unsent." and cards == []


async def test_a_mail_draft_is_closed_unsaved_when_its_still_open(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    actions = actions_for(endpoint)
    scripts = []

    async def applescript(script, *args, timeout=30):
        scripts.append(args)
        return "closed" if len(scripts) == 1 else "found 0"

    actions.applescript = applescript
    args = {"to": ["Ann"], "subject": "Lunch?", "body": "Thursday?"}
    await done_change(actions, "mail_draft", args, {"ok": True, "text": "Draft is open"})
    await done_change(
        actions, "mail_draft", {**args, "subject": "Later"}, {"ok": True, "text": "ok"}
    )
    later, lunch = await listed(endpoint)
    assert lunch["label"] == "Opened a draft to Ann in Mail: “Lunch?”" and lunch["undo"]["possible"]
    answer, _, _ = await with_card(
        hub, endpoint.call("action_undo", {"id": lunch["id"], "confirm": True}, "Eden"), "allow"
    )
    assert answer["status"] == "undone" and scripts == [("Lunch?",)]
    answer, error, _ = await with_card(
        hub, endpoint.call("action_undo", {"id": later["id"], "confirm": True}, "Eden"), "allow"
    )
    assert error and answer["status"] == "failed" and "isn't open in Mail" in answer["text"]


# ── memory, through the endpoint itself ──


async def test_a_forgotten_fact_comes_back_and_a_toggle_switches_back(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    ann = hub.memory.add("Ann Lee is the owner's co-founder.", source="said", origin="Ann")
    coffee = hub.memory.add("Takes coffee black.", category="preferences")
    answer, _, _ = await with_card(
        hub, endpoint.call("memory_delete", {"id": ann.id, "confirm": True}, "Eden"), "allow"
    )
    assert answer["status"] == "removed" and hub.memory.get(ann.id) is None
    answer, _, _ = await with_card(
        hub,
        endpoint.call("memory_toggle", {"id": coffee.id, "on": False, "confirm": True}, "Eden"),
        "allow",
    )
    assert hub.memory.get(coffee.id).off
    toggled, forgot = await listed(endpoint)
    assert forgot["label"] == "Forgot “Ann Lee is the owner's co-founder.”"
    assert toggled["label"] == "Switched off “Takes coffee black.”"
    for item in (forgot, toggled):
        answer, _, _ = await with_card(
            hub, endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden"), "allow"
        )
        assert answer["status"] == "undone", answer
    back = hub.memory.get(ann.id)
    assert back.text == "Ann Lee is the owner's co-founder." and back.origin == "Ann"
    assert not hub.memory.get(coffee.id).off


# ── the timeline ──


async def test_the_list_is_per_app_and_old_ones_are_too_old(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub, FakeCalendar([DENTIST]))
    actions = actions_for(endpoint)
    args = {"title": "Dentist", "start": "2026-10-07T10:00", "confirm": True}
    await done_change(actions, "calendar_delete", args, {"done": True, "status": "removed"})
    await done_change(
        actions, "mail_send", {"to": ["a@b.co"], "subject": "Hi"}, {"sent": True}, app="Claude Code"
    )
    assert [i["app"] for i in await listed(endpoint)] == ["Eden"]
    assert [i["app"] for i in await listed(endpoint, app="Claude Code")] == ["Claude Code"]
    assert len(await listed(endpoint, source="all")) == 2
    today = datetime.now().date().isoformat()
    assert (
        len(await listed(endpoint, day=today)) == 1
        and await listed(endpoint, day="2020-01-01") == []
    )
    # Past KEEP_DAYS what undoes it is deleted; the timeline still has the line.
    [item] = await listed(endpoint)
    kept = hub.feature_path("eden_actions") / f"{item['id']}.json"
    old = time.time() - (eden_actions.KEEP_DAYS + 1) * 86400
    os.utime(kept, (old, old))
    assert actions.prune() == 1 and not kept.exists()
    [item] = await listed(endpoint)
    assert item["undo"] == {"possible": False, "why": eden_actions.TOO_OLD}
    assert item["label"] == "Eden removed an event"
    text, error = await endpoint.call("action_undo", {"id": item["id"], "confirm": True}, "Eden")
    assert error and "Too old" in json.loads(text)["text"]
    for bad in ({"limit": 0}, {"day": "Friday"}, {"source": 3}):
        assert (await endpoint.call("actions_list", bad, "Eden"))[1], bad


def test_over_the_socket(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    client = TestClient(build_app(endpoint_for(hub)))
    out = client.post(
        "/call",
        json={"tool": "actions_list", "arguments": {}},
        headers={
            "Authorization": "Bearer the-token",
            "X-Jarvis-Session": SESSION,
            "X-Jarvis-Client": "Eden",
        },
    ).json()
    assert not out["is_error"] and json.loads(out["text"]) == {
        "version": 1,
        "note": eden_actions.NOTE,
        "items": [],
        "more": False,
    }


@pytest.mark.parametrize(
    "app, slug", [("Eden", "eden"), ("Claude Code", "claude-code"), ("", "app")]
)
def test_source_slugs(app, slug):
    assert eden_actions.source_of(app) == slug


def test_records_never_load_from_a_path(tmp_path):
    actions = EdenActions(
        hub=None, folder=tmp_path, clock=lambda: datetime(2026, 10, 6) + timedelta()
    )
    for bad in ("../x", "ea-zz", "ea-0123456789ab/../../x", 5, None):
        assert actions.get(bad) is None
