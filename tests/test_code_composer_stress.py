"""The Jarvis Code composer's commands at their edges, through the hub: ! commands and #
memories that can't run or be saved still answer the window, and slash commands parse
the way they're typed (case, spacing, new lines, nothing after the slash)."""

import asyncio
import os

import pytest


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    return make_hub(settings, quiet_speaker, isolated=isolated)


def _record(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    return sent


async def test_a_bang_command_that_cannot_start_still_answers(hub, tmp_path, monkeypatch):
    sent = _record(hub)
    gone = tmp_path / "gone"  # the project folder went away after it was picked
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: gone)
    await hub.task_bash({"directory": "gone", "command": "ls", "ref": "b9"})
    kind, data = sent[-1]
    assert kind == "task_bash" and data["ref"] == "b9" and data["code"] == -1
    assert data["output"]


async def test_bang_output_is_unicode_safe_and_bounded(hub, tmp_path, monkeypatch):
    sent = _record(hub)
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    command = "printf '\\xff\\xfe 修复 🐛\\n'; python3 -c \"print('x' * 50000)\""
    await hub.task_bash({"directory": "proj", "command": command, "ref": "b1"})
    data = sent[-1][1]
    assert data["code"] == 0 and data["output"].startswith("…")
    assert len(data["output"]) <= 20_001


async def test_a_memory_that_cannot_be_saved_says_so(hub, tmp_path, monkeypatch):
    sent = _record(hub)
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    # A CLAUDE.md that isn't UTF-8 is added to all the same, its bytes untouched.
    (project / "CLAUDE.md").write_bytes(b"caf\xe9 notes")
    hub.task_memory({"directory": "proj", "text": "use pnpm"})
    assert sent[-1][1]["ok"] is True
    assert (project / "CLAUDE.md").read_bytes() == b"caf\xe9 notes\n- use pnpm\n"
    # One that can't be written: the window hears it wasn't saved.
    (project / "CLAUDE.md").chmod(0o400)
    try:
        if os.access(project / "CLAUDE.md", os.W_OK):
            pytest.skip("running as a user who can write anything")
        hub.task_memory({"directory": "proj", "text": "tests in tests/"})
        assert sent[-1] == ("task_memory", {"ok": False, "text": "tests in tests/", "path": ""})
    finally:
        (project / "CLAUDE.md").chmod(0o600)


async def test_a_memory_never_follows_a_link_out_of_the_project(hub, tmp_path, monkeypatch):
    sent = _record(hub)
    project = tmp_path / "proj"
    project.mkdir()
    outside = tmp_path / "elsewhere.md"
    outside.write_text("mine\n")
    (project / "CLAUDE.md").symlink_to(outside)
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    hub.task_memory({"directory": "proj", "text": "use pnpm"})
    assert sent[-1][1]["ok"] is False
    assert outside.read_text() == "mine\n"


@pytest.mark.parametrize("text", ["/", "/   ", "/\n"])
async def test_a_bare_slash_is_not_sent_to_claude(hub, tmp_path, text):
    (tmp_path / "proj").mkdir()
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, t, **_k: sent.append(t) or True
    await hub.handle({"type": "code_command", "id": task.id, "text": text})
    await asyncio.sleep(0.01)
    assert sent == []
    task.handle.cancel()


async def test_slash_commands_parse_case_spacing_and_new_lines(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, t, **_k: sent.append(t) or True
    await hub._code_command(task, "/PLAN")
    assert task.mode == "plan"
    await hub._code_command(task, "/Manual")
    assert task.mode == "ask"
    await hub._code_command(task, "/plan\nfix the login flow")  # Shift+Enter after the name
    assert task.mode == "plan" and sent[-1] == "fix the login flow"
    await hub._code_command(task, "/compact   keep the API notes")
    assert sent[-1] == "/compact   keep the API notes"  # Claude Code's own, as typed
    await hub._code_command(task, "/review-pr 12")
    assert sent[-1] == "/review-pr 12"
    task.handle.cancel()


async def test_agents_hooks_and_todos_answer_in_the_transcript(hub, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # never the owner's ~/.claude
    project = tmp_path / "proj"
    (project / ".claude/agents").mkdir(parents=True)
    (project / ".claude/agents/tester.md").write_text("---\ndescription: Runs tests\n---\n")
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, t, **_k: sent.append(t) or True
    for command in ("/agents", "/hooks", "/todos"):
        await hub._code_command(task, command)
    notes = [e["text"] for e in task.transcript if e["role"] == "note"]
    assert notes[0] == "Subagents:\n- tester (project): Runs tests"
    assert notes[1].startswith("No hooks")
    assert len(notes) == 3 and sent == []  # none of them went to Claude
    task.handle.cancel()
