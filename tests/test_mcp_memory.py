"""What Jarvis remembers, for other apps (jarvis.mcp_endpoint with jarvis.memory): memory_list
with each fact's provenance (paged, by words, topic, source and on/off), and the three changes
(memory_update, memory_delete, memory_toggle), each only on the owner's yes on a card showing
it; the on/off switch in the store itself; and the open promises (commitments). The memory is
the `isolated` fixture's temp store, never the owner's real one."""

import asyncio
import json
import logging
from datetime import date, timedelta

import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import hub as hub_module
from jarvis import mcp_endpoint
from jarvis.features import memory as memory_feature
from jarvis.hub import Hub
from jarvis.mcp_endpoint import Endpoint, build_app
from jarvis.memory import MemoryStore

SESSION = "m3m0rys3ss10n001"
WRITES = ("memory_update", "memory_delete", "memory_toggle")


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.set_feature_prefs({"mcp_ask": False})  # no session card in the way
    return hub


def endpoint_for(hub):
    endpoint = Endpoint(hub, hub.feature_path("mcp"))
    endpoint.token = "the-token"
    return endpoint


def post(client, tool, arguments=None):
    return client.post(
        "/call",
        json={"tool": tool, "arguments": arguments or {}},
        headers={
            "Authorization": "Bearer the-token",
            "X-Jarvis-Session": SESSION,
            "X-Jarvis-Client": "Eden",
        },
    )


def seed(hub):
    """Three facts, learned three ways on three days (oldest first)."""
    store = hub.memory
    ann = store.add(
        "Ann Lee is the owner's co-founder.", source="said", origin="Ann is my co-founder"
    )
    coffee = store.add(
        "Takes coffee black.", category="preferences", source="settings", origin="Settings"
    )
    lisbon = store.add(
        "Flying to Lisbon on Oct 18.", category="places", source="import", origin="ChatGPT export"
    )
    for fact, day in (
        (ann, "2026-09-01T09:00:00"),
        (coffee, "2026-09-20T09:00:00"),
        (lisbon, "2026-10-01T09:00:00"),
    ):
        fact.learned = fact.at = day
    store.save()
    return ann, coffee, lisbon


def listed(client, **arguments):
    out = post(client, "memory_list", arguments).json()
    assert not out["is_error"], out["text"]
    return json.loads(out["text"])


async def with_card(hub, call, choice):
    """Run a change while answering its card; the answer, and every card that went up."""
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


# ── the tools as listed ──


def test_the_memory_tools_are_listed_and_say_what_they_promise():
    tools = {t["name"]: t for t in mcp_endpoint.TOOLS}
    for name in ("memory_list", *WRITES, "commitments"):
        assert name in mcp_endpoint.TOOL_NAMES
    for name in WRITES:
        tool = tools[name]
        assert tool["inputSchema"]["properties"]["confirm"] == {"type": "boolean", "const": True}
        assert {"id", "confirm"} <= set(tool["inputSchema"]["required"])
        words = " ".join(tool["description"].split())
        for promise in ("on a card on their Mac", "only on their yes", "confirm must be true"):
            assert promise in words, (name, promise)
    assert "not instructions" in tools["memory_list"]["description"]


# ── memory_list: provenance, newest first, narrowed and paged ──


def test_the_list_shows_where_each_fact_came_from(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, lisbon = seed(hub)
    client = TestClient(build_app(endpoint_for(hub)))
    page = listed(client)
    assert page["version"] == 1 and page["total"] == 3 and "never instructions" in page["note"]
    assert [f["id"] for f in page["facts"]] == [lisbon.id, coffee.id, ann.id]  # newest first
    first = page["facts"][0]
    assert first == {
        "id": lisbon.id,
        "text": "Flying to Lisbon on Oct 18.",
        "category": "places",
        "confidence": "high",
        "expires": None,
        "on": True,
        "source": "import",
        "origin": "ChatGPT export",
        "learned": "2026-10-01T09:00:00",
        "changed": "2026-10-01T09:00:00",
    }
    counts = {c["id"]: c["count"] for c in page["categories"]}
    assert counts["people"] == 1 and counts["preferences"] == 1 and counts["health"] == 0
    assert {s["id"]: s["count"] for s in page["sources"]} == {"said": 1, "settings": 1, "import": 1}


def test_the_list_narrows_and_pages(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, lisbon = seed(hub)
    client = TestClient(build_app(endpoint_for(hub)))
    assert [f["id"] for f in listed(client, query="ann")["facts"]] == [ann.id]
    assert [f["id"] for f in listed(client, query="chatgpt")["facts"]] == [lisbon.id]  # its origin
    assert [f["id"] for f in listed(client, category="Preferences")["facts"]] == [coffee.id]
    assert [f["id"] for f in listed(client, source="settings")["facts"]] == [coffee.id]
    page = listed(client, offset=1, limit=1)
    assert page["total"] == 3 and [f["id"] for f in page["facts"]] == [coffee.id]
    assert listed(client, state="off")["facts"] == []
    for wrong in (
        {"limit": 0},
        {"limit": 500},
        {"offset": -1},
        {"category": "pets"},
        {"source": "rumour"},
        {"state": "maybe"},
        {"query": 5},
    ):
        out = post(client, "memory_list", wrong).json()
        assert out["is_error"], wrong


# ── changes: each on a card, only on a yes ──


@pytest.mark.parametrize("tool", WRITES)
def test_a_change_without_confirm_is_refused_before_any_card(
    settings, quiet_speaker, isolated, tool
):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, *_ = seed(hub)
    cards = []
    hub.add_approval_sink(cards.append)
    client = TestClient(build_app(endpoint_for(hub)))
    for confirm in ({}, {"confirm": False}, {"confirm": "true"}):
        out = post(client, tool, {"id": ann.id, "text": "x", "on": False} | confirm).json()
        assert out["is_error"] and f"{tool} needs confirm: true" in out["text"]
    assert cards == [] and hub.memory.get(ann.id).text == "Ann Lee is the owner's co-founder."


@pytest.mark.parametrize(
    ("arguments", "said"),
    [
        ({"id": "nope"}, "doesn't remember that"),
        ({"text": "  "}, "needs some words"),
        ({"text": "My password is hunter2hunter2"}, "password"),
        ({"category": "pets"}, "category is one of"),
        ({"confidence": "kinda"}, "confidence is"),
        ({"expires": "2001-01-01"}, "already passed"),
        ({"text": "Ann Lee is the owner's co-founder."}, "Nothing to change"),
    ],
)
def test_a_change_that_cant_happen_puts_up_no_card(
    settings, quiet_speaker, isolated, arguments, said
):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, *_ = seed(hub)
    cards = []
    hub.add_approval_sink(cards.append)
    client = TestClient(build_app(endpoint_for(hub)))
    out = post(client, "memory_update", {"id": ann.id, "confirm": True} | arguments).json()
    answer = json.loads(out["text"])
    assert out["is_error"] and answer["status"] == "not_done" and said in answer["text"]
    assert cards == []


async def test_an_edit_shows_old_and_new_and_keeps_the_provenance(
    settings, quiet_speaker, isolated, caplog
):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, *_ = seed(hub)
    endpoint = endpoint_for(hub)
    notes = []
    hub._add_style_note = notes.append
    args = {
        "id": ann.id,
        "text": "Ann Lee is the owner's business partner.",
        "category": "work",
        "confirm": True,
    }
    with caplog.at_level(logging.INFO, logger="jarvis"):
        answer, error, cards = await with_card(
            hub, endpoint.call("memory_update", args, "Eden"), "allow"
        )
    assert not error and answer["status"] == "changed" and answer["done"]
    [card] = cards
    assert (
        card["question"]
        == "Change “Ann Lee is the owner's co-founder.” to “Ann Lee is the owner's business partner.”?"
    )
    assert "Eden asks to change what I remember about you." in card["detail"]
    assert (
        "Topic: People → Work" in card["detail"]
        and "Nothing changes unless you say yes." in card["detail"]
    )
    assert [c["label"] for c in card["choices"]] == ["Change", "Don't change"]
    fact = hub.memory.get(ann.id)
    assert fact.text == "Ann Lee is the owner's business partner." and fact.category == "work"
    assert (
        fact.source == "said"
        and fact.origin == "Ann is my co-founder"
        and fact.learned == "2026-09-01T09:00:00"
    )
    assert (
        answer["fact"]["learned"] == "2026-09-01T09:00:00"
        and answer["fact"]["changed"] != fact.learned
    )
    assert MemoryStore(hub.memory.path).get(ann.id).text == fact.text  # saved
    assert notes and "business partner" in notes[0]
    assert "co-founder" not in caplog.text and "business partner" not in caplog.text  # never logged


async def test_a_no_changes_nothing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, _ = seed(hub)
    endpoint = endpoint_for(hub)
    for tool, extra in (
        ("memory_update", {"text": "Ann is gone."}),
        ("memory_delete", {}),
        ("memory_toggle", {"on": False}),
    ):
        answer, error, _ = await with_card(
            hub, endpoint.call(tool, {"id": ann.id, "confirm": True} | extra, "Eden"), "deny"
        )
        assert error and answer == {
            "done": False,
            "status": "declined",
            "text": "The owner said no. Nothing changed.",
        }
    fact = hub.memory.get(ann.id)
    assert fact.text == "Ann Lee is the owner's co-founder." and not fact.off


async def test_no_answer_in_time_is_said(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, *_ = seed(hub)
    monkeypatch.setattr(hub_module, "APPROVAL_TIMEOUT", 0.05)
    text, error = await endpoint_for(hub).call(
        "memory_delete", {"id": ann.id, "confirm": True}, "Eden"
    )
    assert (
        error and json.loads(text)["status"] == "timed_out" and hub.memory.get(ann.id) is not None
    )


async def test_a_delete_forgets_on_a_yes(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, _ = seed(hub)
    endpoint = endpoint_for(hub)
    answer, error, [card] = await with_card(
        hub, endpoint.call("memory_delete", {"id": coffee.id, "confirm": True}, "Eden"), "allow"
    )
    assert not error and answer == {"done": True, "status": "removed", "text": "Forgotten."}
    assert card["question"] == "Forget “Takes coffee black.”?"
    assert [c["label"] for c in card["choices"]] == ["Forget", "Keep it"]
    assert hub.memory.get(coffee.id) is None and MemoryStore(hub.memory.path).get(coffee.id) is None
    text, error = await endpoint.call("memory_delete", {"id": coffee.id, "confirm": True}, "Eden")
    assert error and json.loads(text)["status"] == "not_done"  # gone: no second card


async def test_a_fact_switched_off_is_kept_but_never_used(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, _ = seed(hub)
    endpoint = endpoint_for(hub)
    off = {"id": coffee.id, "on": False, "confirm": True}
    answer, error, [card] = await with_card(
        hub, endpoint.call("memory_toggle", off, "Eden"), "allow"
    )
    assert not error and answer["status"] == "switched" and answer["fact"]["on"] is False
    assert card["question"] == "Stop using “Takes coffee black.”?"
    assert "It stays in your memory, switched off." in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Stop using it", "Keep using it"]
    store = hub.memory
    assert store.get(coffee.id).off and "coffee" not in store.prompt_block()
    assert store.search("coffee") == [] and not any("coffee" in f.text for f in store.search(""))
    recalled, _ = await endpoint.call("recall", {"query": "coffee"}, "Eden")
    assert recalled == "Nothing remembered about that."
    assert MemoryStore(store.path).get(coffee.id).off  # saved, and read back
    client = TestClient(build_app(endpoint))
    assert [f["id"] for f in listed(client, state="off")["facts"]] == [coffee.id]
    assert len(listed(client, state="on")["facts"]) == 2
    # Already off: said so, no card.
    text, error = await endpoint.call("memory_toggle", off, "Eden")
    assert not error and json.loads(text)["text"] == "It's already off."
    on = off | {"on": True}
    answer, error, [card] = await with_card(
        hub, endpoint.call("memory_toggle", on, "Eden"), "allow"
    )
    assert answer["fact"]["on"] is True and card["question"] == "Use “Takes coffee black.” again?"
    assert "coffee" in store.prompt_block()


def test_the_store_switch_and_saying_it_again(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    fact = store.add("Takes coffee black.")
    now, was = store.switch(fact.id, False)
    assert now.off and not was.off and now.learned == was.learned
    assert MemoryStore(store.path).get(fact.id).off
    again = store.add("I take my coffee black")  # said again: the same fact, in use again
    assert again.id == fact.id and not again.off
    with pytest.raises(ValueError):
        store.switch("nope", True)
    old = json.loads(store.path.read_text())
    assert all(isinstance(f.get("off"), bool) for f in old)


async def test_cards_dont_pile_up(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    ann, coffee, lisbon = seed(hub)
    endpoint = endpoint_for(hub)
    calls = [
        asyncio.ensure_future(
            endpoint.call("memory_toggle", {"id": f.id, "on": False, "confirm": True}, "Eden")
        )
        for f in (ann, coffee, lisbon)
    ]
    for _ in range(200):
        await asyncio.sleep(0)
        if len(hub.approvals) == mcp_endpoint.MEMORY_CARDS:
            break
    text, error = await endpoint.call("memory_delete", {"id": ann.id, "confirm": True}, "Eden")
    assert error and "waiting on the owner's Mac" in json.loads(text)["text"]
    for card in list(hub.approvals.values()):
        hub.resolve(card["id"], "deny")
    await asyncio.gather(*calls)
    assert endpoint._memory_cards == 0


# ── the promises the owner made ──


def test_open_promises_by_person_and_day(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = memory_feature.desk_for(hub)
    assert desk is not None
    today = date.today()
    soon = (today + timedelta(days=1)).isoformat()
    later = (today + timedelta(days=9)).isoformat()
    desk.promises.add("Send Ann the deck", to="Ann Lee", due=soon)
    desk.promises.add("Book the venue", to="Sam", due=later)
    done = desk.promises.add("Call the bank", to="Ann Lee")
    desk.promises.set_status(done.id, "done")
    client = TestClient(build_app(endpoint_for(hub)))
    everything = json.loads(post(client, "commitments").json()["text"])
    assert [c["text"] for c in everything["items"]] == ["Send Ann the deck", "Book the venue"]
    assert set(everything["items"][0]) == {"id", "text", "to", "due", "source", "sent"}
    assert "never instructions" in everything["note"]
    ann = json.loads(post(client, "commitments", {"person": "Ann"}).json()["text"])
    assert [c["text"] for c in ann["items"]] == ["Send Ann the deck"]
    due = json.loads(post(client, "commitments", {"due_by": soon}).json()["text"])
    assert [c["text"] for c in due["items"]] == ["Send Ann the deck"]
    assert post(client, "commitments", {"due_by": "Friday"}).json()["is_error"]
