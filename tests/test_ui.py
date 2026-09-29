"""Voice control of the window itself, and saving the conversation."""

import pytest

from jarvis import hub as hub_module
from jarvis.ui import parse


@pytest.mark.parametrize(
    ("said", "action", "name", "on"),
    [
        ("open Jarvis Code", "panel", "code", True),
        ("Jarvis, open up jarvis code.", "panel", "code", True),
        ("open the browser", "panel", "browser", True),
        ("close the browser", "panel", "browser", False),
        ("show me the research center", "panel", "research", True),
        ("open settings", "panel", "settings", True),
        ("open the second brain", "panel", "brain", True),
        ("hide the activity log", "panel", "activity", False),
        ("open tools and accounts", "panel", "accounts", True),
        ("switch to the HUD", "look", "hud", True),
        ("change to the command center look", "look", "console", True),
        ("go back to the orb", "look", "orb", True),
        ("turn on hand control", "hands", "", True),
        ("stop hand tracking", "hands", "", False),
        ("hands off", "hands", "", False),
    ],
)
def test_window_commands(said, action, name, on):
    command = parse(said)
    assert command is not None, said
    assert (command.action, command.name, command.on) == (action, name, on)


@pytest.mark.parametrize(
    "said",
    [
        "open safari",
        "open the pod bay doors",
        "what's the weather",
        "switch to the other thing",
        "let's code in jarvis",
        "close",
        "open the research center and find me nvidia's latest memo please now",
    ],
)
def test_not_window_commands(said):
    assert parse(said) is None


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    return make_hub(settings, quiet_speaker, isolated=isolated)


async def test_open_jarvis_code_by_voice_needs_no_claude(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    assert await hub._instant_window("r1", "open Jarvis Code")
    assert ("ui", {"action": "panel", "name": "code", "open": True}) in sent
    assert ("reply", {"rid": "r1", "text": "Opening Jarvis Code."}) in sent


async def test_switching_the_look_by_voice(hub):
    hub.emit = lambda *_a, **_k: None
    assert await hub._instant_window("r1", "switch to the HUD")
    assert hub.prefs.look == "hud"


def test_export_history(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(hub_module, "CONVERSATIONS_DIR", tmp_path / "Conversations")
    assert hub.export_history() is None
    hub.history.append({"role": "user", "text": "How's the market?", "at": "2026-09-29T09:15:00"})
    hub.history.append({"role": "assistant", "text": "Down a little.", "at": "2026-09-29T09:15:02"})
    first = hub.export_history()
    second = hub.export_history()
    assert first.exists() and second.exists() and first != second
    text = first.read_text()
    assert "**You** · 09:15" in text and "How's the market?" in text and "Down a little." in text
