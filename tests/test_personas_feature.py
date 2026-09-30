"""The owner's own personas in the app (jarvis.features.personas): kept before the settings
are read at startup, made and changed and removed from Settings, chosen with their humor,
known to Claude. The built-in three never change."""

import asyncio
import json

import pytest
from conftest import FakeClient

from jarvis import lang, personas, prefs
from jarvis.features import personas as feature
from jarvis.hub import EXTRA_QUIET_RESULTS, Hub
from jarvis.prefs import PrefsStore

ALFRED = {
    "name": "Alfred",
    "description": "A gentle old butler, patient and warm.",
    "zh_name": "阿尔弗雷德",
    "zh_description": "一位温和的老管家，耐心又亲切。",
    "humor": 30,
}


@pytest.fixture(autouse=True)
def _personas_put_back():
    """A test's personas never outlast it: the built-in three, as they were."""
    kept = [
        (table, dict(table))
        for table in (prefs.PERSONAS, lang.ZH_PERSONAS, personas.FIELDS, personas.KNOWN)
    ]
    listeners = list(personas.LISTENERS)
    yield
    for table, before in kept:
        table.clear()
        table.update(before)
    personas.LISTENERS[:] = listeners


class Transcriber:
    def warm_up(self):
        pass


def make_hub(settings, speaker, isolated):
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.events = events
    return hub


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


async def settle(hub):
    for _ in range(3):
        await asyncio.sleep(0)
    await asyncio.wait_for(asyncio.gather(*list(hub._background)), 60)


async def test_one_chosen_before_a_restart_is_still_chosen_after(tmp_path):
    (tmp_path / "personas.json").write_text(json.dumps([{**ALFRED, "id": "alfred"}]))
    (tmp_path / "prefs.json").write_text(json.dumps({"persona": "alfred", "hands_free": False}))
    assert PrefsStore(tmp_path / "prefs.json").prefs.persona == "jarvis"  # unknown: the default
    feature.prepare(tmp_path)  # at startup, before the settings are read
    assert PrefsStore(tmp_path / "prefs.json").prefs.persona == "alfred"
    assert lang.persona_for_prompt("alfred", "en") == ("Alfred", ALFRED["description"])


async def test_settings_make_change_and_remove_one(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub._handle({"type": "persona_save", "persona": ALFRED})
    await settle(hub)
    (listed,) = emitted(hub, "personas_custom")
    assert [p["id"] for p in listed["items"]] == ["alfred"] and listed["error"] == ""
    assert listed["max"] == personas.MAX_PERSONAS
    assert {"id": "alfred", "name": "Alfred"} in emitted(hub, "prefs")[-1]["personas"]
    assert json.loads((tmp_path / "personas.json").read_text())[0]["name"] == "Alfred"
    # Changed by its id, which never changes.
    await hub._handle(
        {"type": "persona_save", "persona": {**ALFRED, "id": "alfred", "name": "Jeeves"}}
    )
    await settle(hub)
    assert prefs.PERSONAS["alfred"][0] == "Jeeves"
    # What can't be kept says why, and keeps nothing.
    await hub._handle({"type": "persona_save", "persona": {**ALFRED, "name": " "}})
    await settle(hub)
    assert emitted(hub, "personas_custom")[-1]["error"] == "Give the persona a name."
    assert len(emitted(hub, "personas_custom")[-1]["items"]) == 1
    await hub._handle({"type": "persona_delete", "id": "alfred"})
    await settle(hub)
    assert "alfred" not in prefs.PERSONAS and emitted(hub, "personas_custom")[-1]["items"] == []
    await hub._handle({"type": "persona_delete", "id": "jarvis"})  # never a built-in one
    await settle(hub)
    assert "jarvis" in prefs.PERSONAS


async def test_choosing_one_brings_its_humor(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub._handle({"type": "persona_save", "persona": ALFRED})
    await settle(hub)
    await hub._handle({"type": "set_prefs", "changes": {"persona": "alfred"}})
    assert (hub.prefs.persona, hub.prefs.humor) == ("alfred", 30)
    await hub._handle({"type": "set_prefs", "changes": {"persona": "tars"}})
    assert (hub.prefs.persona, hub.prefs.humor) == ("tars", 30)  # a built-in keeps the humor
    await hub._handle({"type": "set_prefs", "changes": {"persona": "alfred", "humor": 75}})
    assert (hub.prefs.persona, hub.prefs.humor) == ("alfred", 75)  # the owner's own wins


async def test_the_one_in_use_changed_or_removed(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub._handle({"type": "persona_save", "persona": ALFRED})
    await settle(hub)
    await hub._handle({"type": "set_prefs", "changes": {"persona": "alfred"}})
    await hub._handle(
        {
            "type": "persona_save",
            "persona": {**ALFRED, "id": "alfred", "description": "A brisk, modern butler."},
        }
    )
    await settle(hub)
    assert "A brisk, modern butler." in hub._style_note  # Claude hears it at once
    await hub._handle({"type": "persona_delete", "id": "alfred"})
    await settle(hub)
    assert hub.prefs.persona == "jarvis"  # never left on one that's gone


async def test_claude_knows_them(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert feature.prompt() == ""  # none made: nothing said
    await hub._handle({"type": "persona_save", "persona": ALFRED})
    await settle(hub)
    assert "alfred (Alfred)" in feature.prompt() and "alfred (Alfred)" in hub._feature_prompt()
    assert "mcp__personas__list_personas" in EXTRA_QUIET_RESULTS  # JARVIS's own settings
    (list_personas,) = hub.personas.tools()
    out = (await list_personas.handler({}))["content"][0]["text"]
    lines = out.splitlines()
    assert lines[0] == "You are jarvis now."
    assert lines[1].startswith("jarvis: JARVIS. ")
    assert lines[-1] == (
        "alfred: Alfred (made by the user). A gentle old butler, patient and warm. "
        "Starts at humor 30 percent."
    )
