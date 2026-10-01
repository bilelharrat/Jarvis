"""Voice control of the window itself, saving the conversation, and the request queue."""

import asyncio

import pytest
from conftest import strip_note

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
        ("switch to stark glass", "look", "glass", True),
        ("change to the glass look", "look", "glass", True),
        ("light mode", "tone", "light", True),
        ("switch to white mode", "tone", "light", True),
        ("turn on light mode", "tone", "light", True),
        ("use the dark theme", "tone", "dark", True),
        ("go back to dark mode", "tone", "dark", True),
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
        "go dark",
        "switch to light",
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
    assert await hub._instant_window("r2", "switch to stark glass")
    assert hub.prefs.look == "glass"


async def test_light_and_dark_mode_by_voice_are_stark_glass_tones(hub):
    hub.emit = lambda *_a, **_k: None
    assert await hub._instant_window("r1", "switch to the HUD")
    assert await hub._instant_window("r2", "light mode")
    assert (hub.prefs.look, hub.prefs.glass_tone) == ("glass", "light")
    assert await hub._instant_window("r3", "switch to dark mode")
    assert (hub.prefs.look, hub.prefs.glass_tone) == ("glass", "dark")


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


async def test_requests_wait_their_turn_and_can_be_taken_back(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    asked = []

    async def fake_run(rid, query, images=None):
        asked.append(strip_note(query))

    hub._run_query = fake_run
    await hub._lock.acquire()  # something is being answered
    first = asyncio.create_task(hub.ask("what's the weather"))
    second = asyncio.create_task(hub.ask("and tomorrow"))
    await asyncio.sleep(0.01)
    queued = [d["items"] for k, d in sent if k == "ask_queue"][-1]
    assert [q["text"] for q in queued] == ["what's the weather", "and tomorrow"]
    await hub.handle({"type": "unqueue", "id": queued[1]["id"]})  # take the second back
    hub._lock.release()
    await asyncio.wait_for(asyncio.gather(first, second), 5)
    assert asked == ["what's the weather"]
    assert [d["items"] for k, d in sent if k == "ask_queue"][-1] == []


async def test_bang_runs_in_the_project_and_hash_saves_a_memory(hub, tmp_path, monkeypatch):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    await hub.task_bash({"directory": "proj", "command": "echo hello; exit 3", "ref": "b1"})
    kind, data = sent[-1]
    assert kind == "task_bash" and data["ref"] == "b1"
    assert data["output"].strip() == "hello" and data["code"] == 3
    hub.task_memory({"directory": "proj", "text": "  always use   pnpm "})
    hub.task_memory({"directory": "proj", "text": "tests live in tests/"})
    assert (project / "CLAUDE.md").read_text() == "- always use pnpm\n- tests live in tests/\n"
    assert sent[-1] == (
        "task_memory",
        {"ok": True, "text": "tests live in tests/", "path": str(project / "CLAUDE.md")},
    )


def test_awake_only_while_jarvis_code_works(hub, monkeypatch):
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(hub.workbench, "set_awake", lambda on: calls.append(on) or on)
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    hub.tasks.tasks = {1: SimpleNamespace(kind="code", busy=True)}
    hub.prefs.code_keep_awake = True
    hub._sync_awake()
    assert calls[-1] is True and sent[-1] == ("awake", {"on": True, "active": True})
    hub.tasks.tasks[1].busy = False
    hub._sync_awake()
    assert calls[-1] is False
    count = len(sent)
    hub._sync_awake()  # nothing changed: nothing said
    assert len(sent) == count


def test_open_project_file_stays_inside_the_project(hub, tmp_path, monkeypatch):
    from jarvis import hub as hub_module

    opened = []
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda args, **_k: opened.append(args))
    project = tmp_path / "proj"
    project.mkdir()
    (project / "report.html").write_text("<p>hi</p>")
    (project / ".env").write_text("SECRET=1")
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    hub.open_project_file({"directory": "proj", "path": "report.html"})
    hub.open_project_file({"directory": "proj", "path": "../../etc/hosts"})
    hub.open_project_file({"directory": "proj", "path": ".env"})
    assert opened == [["open", str((project / "report.html").resolve())]]


async def test_with_queueing_off_a_new_request_interrupts(hub):
    stopped = []

    async def fake_stop():
        stopped.append(True)
        hub._lock.release()  # the running answer ends

    asked = []

    async def fake_run(rid, query, images=None):
        asked.append(strip_note(query))

    hub.emit = lambda *_a, **_k: None
    hub._run_query = fake_run
    hub.stop = fake_stop
    hub.prefs.queue_requests = False
    await hub._lock.acquire()  # something is being answered
    await asyncio.wait_for(hub.ask("actually, what's the weather"), 5)
    assert stopped and asked == ["actually, what's the weather"] and not hub.waiting
