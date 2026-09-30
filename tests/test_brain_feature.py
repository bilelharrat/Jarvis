"""The second brain feature on the hub (jarvis.features.brain): its settings, what the rebuild
is given, the galaxy's search command, and search by meaning's switch (the only moment
Apple's model files are fetched). Everything with a temp folder and fakes."""

import asyncio
import json
from datetime import datetime, timedelta

import pytest
from conftest import FakeClient

from jarvis import embeddings, swift_helper
from jarvis.features import brain as feature
from jarvis.hub import Hub
from jarvis.knowledge import Note


@pytest.fixture(autouse=True)
def _no_real_helpers(monkeypatch, tmp_path):
    """No test here builds or runs a real Swift helper, or writes into Application Support:
    a helper is "built" into the temp folder unless a test says otherwise."""
    monkeypatch.setattr(swift_helper, "binary_for", lambda name: tmp_path / "bin" / name)
    monkeypatch.setattr(swift_helper, "ensure", lambda name: None)


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    made = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    events = []
    made.emit = lambda kind, **data: events.append((kind, data))
    made.events = events
    return made


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


def days_ago(n):
    return (datetime.now() - timedelta(days=n)).isoformat(timespec="seconds")


NOTES = {
    "notes": [
        Note(
            "notes:1",
            "notes",
            "Board prep",
            "Revenue slides for the board meeting.",
            "1",
            modified=days_ago(2),
        ),
        Note("notes:2", "notes", "Groceries", "Milk, eggs and bread.", "2", modified=days_ago(300)),
    ],
    "mail": [
        Note(
            "mail:1",
            "mail",
            "Board dinner",
            "Dinner after the board meeting.",
            "m1",
            modified=days_ago(1),
        )
    ],
    "safari": [
        Note(
            "safari:A1",
            "safari",
            "Board decks",
            "Board deck examples https://ex.com",
            "https://ex.com",
        )
    ],
    "conversations": [
        Note("conversation:s:1", "conversations", "Taxes", "You: remind me about taxes", "s")
    ],
    "images": [Note("image:/x.png", "images", "shot", "Text in the image", "/nowhere/x.png")],
    "reminders": [Note("reminder:r1", "reminders", "Dentist", "Reminder: Dentist", "r1")],
}


def test_the_feature_installs_its_settings_hooks_commands_and_tools(hub):
    assert "brain" in hub.features
    assert isinstance(hub.brain_extension, feature.BrainExtension)
    assert isinstance(hub.kb.semantic, embeddings.SemanticSearch)
    # Off until the owner turns it on: it may download Apple's model files.
    assert hub.prefs.feature("brain_semantic") is False
    for kind in (
        "brain_search",
        "brain_semantic",
        "brain_semantic_status",
    ):
        assert kind in hub._commands


def test_the_rebuild_is_told_whether_to_make_vectors(hub):
    assert hub.brain_extension.build_args() == {"more": {"semantic": False}}
    hub.set_feature_prefs({"brain_semantic": True})
    assert hub.brain_extension.build_args() == {"more": {"semantic": True}}


async def test_a_rebuild_passes_them_to_the_rebuild_process(hub, monkeypatch):
    seen = []

    async def spawn(*argv, **_kw):
        seen.append(json.loads(argv[-1]))
        raise OSError("not in tests")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    await hub.rebuild_brain(only={"vectors"})
    assert seen[0]["only"] == ["vectors"] and seen[0]["more"] == {"semantic": False}


async def test_the_galaxys_search_returns_filtered_results_to_the_window(hub):
    hub.kb.build(NOTES)
    await hub._handle({"type": "brain_search", "q": "board meeting", "seq": "w1:3"})
    await feature_task(hub)
    [result] = emitted(hub, "brain_results")
    assert result["seq"] == "w1:3" and result["q"] == "board meeting"
    assert {i["id"] for i in result["items"]} >= {"notes:1", "mail:1"}
    assert set(result["items"][0]) == set(feature.RESULT_KEYS)
    await hub._handle(
        {"type": "brain_search", "q": "board", "sources": ["mail", 5, None], "seq": 2}
    )
    await feature_task(hub)
    assert [i["id"] for i in emitted(hub, "brain_results")[-1]["items"]] == ["mail:1"]
    week = (datetime.now() - timedelta(days=7)).date().isoformat()
    await hub._handle({"type": "brain_search", "q": "board", "since": week, "k": "lots"})
    await feature_task(hub)
    assert {i["id"] for i in emitted(hub, "brain_results")[-1]["items"]} == {"notes:1", "mail:1"}
    await hub._handle({"type": "brain_search", "q": "x" * 5000, "sources": "notes"})
    await feature_task(hub)
    assert len(emitted(hub, "brain_results")[-1]["q"]) == 400


async def test_turning_search_by_meaning_on_fetches_the_model_only_then_and_makes_vectors(
    hub, monkeypatch, tmp_path
):
    calls, rebuilt = [], []
    states = iter(
        [
            {
                "models": [
                    {"language": "en", "available": False},
                    {"language": "zh-Hans", "available": False},
                ]
            },
            {
                "models": [
                    {"language": "en", "available": True},
                    {"language": "zh-Hans", "available": True},
                ]
            },
        ]
    )
    monkeypatch.setattr(swift_helper, "ensure", lambda name: tmp_path / name)
    monkeypatch.setattr(
        embeddings, "helper_status", lambda binary: calls.append("status") or next(states)
    )
    monkeypatch.setattr(embeddings, "request_assets", lambda binary: calls.append("assets") or [])

    async def rebuild(only=None):
        rebuilt.append(only)

    hub.rebuild_brain = rebuild
    await hub._handle({"type": "brain_semantic", "on": True})
    await feature_task(hub)
    assert calls == ["status", "assets", "status"] and rebuilt == [{"vectors"}]
    states_seen = [e["state"] for e in emitted(hub, "brain_semantic")]
    assert "preparing" in states_seen and "downloading" in states_seen
    assert hub.prefs.feature("brain_semantic") is True
    # Off: nothing more is fetched, the vectors leave memory.
    forgot = []
    monkeypatch.setattr(hub.kb.semantic, "forget", lambda: forgot.append(True))
    await hub._handle({"type": "brain_semantic", "on": False})
    assert forgot == [True] and emitted(hub, "brain_semantic")[-1]["state"] == "off"


async def feature_task(hub):
    for _ in range(50):
        await asyncio.sleep(0)
        pending = [t for t in hub._background if not t.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


async def test_search_by_meaning_says_why_it_cant_start(hub, monkeypatch, tmp_path):
    monkeypatch.setattr(swift_helper, "ensure", lambda name: None)
    await hub._handle({"type": "brain_semantic", "on": True})
    await feature_task(hub)
    assert emitted(hub, "brain_semantic")[-1]["state"] == "error"
    monkeypatch.setattr(swift_helper, "ensure", lambda name: tmp_path / name)
    monkeypatch.setattr(embeddings, "helper_status", lambda b: {"models": [{"available": False}]})
    monkeypatch.setattr(embeddings, "request_assets", lambda b: [{"result": "notAvailable"}])
    await hub._handle({"type": "brain_semantic", "on": False})
    await hub._handle({"type": "brain_semantic", "on": True})
    await feature_task(hub)
    last = emitted(hub, "brain_semantic")[-1]
    assert last["state"] == "unavailable" and last["detail"] == "no-assets"


async def test_its_status_counts_the_vectors_and_notices_when_theyre_behind(hub):
    await hub._handle({"type": "brain_semantic_status"})
    assert emitted(hub, "brain_semantic")[-1]["state"] == "off"
    hub.set_feature_prefs({"brain_semantic": True})
    hub.kb.build(NOTES)
    path = embeddings.vectors_path(hub.kb.store)
    vf = embeddings.VectorFile.empty(hub.kb.built_at, 7)
    vf.wanted = 7
    vf.write(path)
    await hub._handle({"type": "brain_semantic_status"})
    status = emitted(hub, "brain_semantic")[-1]
    assert status["state"] == "ready" and status["wanted"] == 7 and status["vectors"] == 0
    embeddings.VectorFile.empty("an older build", 7).write(path)
    await hub._handle({"type": "brain_semantic_status"})
    assert emitted(hub, "brain_semantic")[-1]["state"] == "waiting"
    bad = embeddings.VectorFile.empty(hub.kb.built_at, 7)
    bad.error = "no-assets"
    bad.write(path)
    await hub._handle({"type": "brain_semantic_status"})
    assert emitted(hub, "brain_semantic")[-1]["state"] == "unavailable"


def test_the_query_helper_is_never_built_inside_a_search(hub, monkeypatch, tmp_path):
    built = []
    monkeypatch.setattr(swift_helper, "binary_for", lambda name: tmp_path / "missing-helper")
    monkeypatch.setattr(swift_helper, "ensure", lambda name: built.append(name))
    control = feature.SemanticControl(hub)
    assert control.query_embedder() is None
    assert control._building.acquire(timeout=30)  # the background build has finished
    control._building.release()
    assert built == [embeddings.HELPER]  # in the background, once
    (tmp_path / "missing-helper").write_text("x")
    assert isinstance(control.query_embedder(), embeddings.HelperEmbedder)


def test_galaxy_stars_carry_the_day_they_were_last_changed(hub):
    hub.kb.build(NOTES)
    nodes = {n["id"]: n for n in hub.kb.galaxy()["nodes"]}
    today = int((datetime.now() - datetime(1970, 1, 1)).total_seconds() // 86400)
    assert nodes["mail:1"]["t"] in (today - 1, today - 2) and nodes["safari:A1"]["t"] is None
