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


async def test_an_id_in_digits_no_number_reads_names_no_session(hub, tmp_path, monkeypatch):
    """Digits Python can't read as a number ("①", "²") name no session: the folder the
    message names is used, never a traceback that leaves the window waiting."""
    sent = _record(hub)
    project = tmp_path / "proj"
    project.mkdir()
    monkeypatch.setattr(hub.tasks, "resolve_dir", lambda _d: project)
    for odd in ("①", "²"):
        hub.task_memory({"id": odd, "directory": "proj", "text": f"note {odd}"})
        assert sent[-1][1]["ok"] is True
    assert (project / "CLAUDE.md").read_text() == "- note ①\n- note ²\n"


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


async def test_an_export_that_cannot_be_saved_says_so(hub, tmp_path, monkeypatch):
    from jarvis import tasks as tasks_mod

    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the folder should be")
    monkeypatch.setattr(tasks_mod, "EXPORT_DIR", blocked / "Jarvis Code")
    (tmp_path / "proj").mkdir()
    task = hub.tasks.start("", "proj")
    sent = _record(hub)
    await hub.handle({"type": "task_export", "id": task.id})
    captions = [d["text"] for k, d in sent if k == "caption"]
    assert captions and captions[-1].startswith("Couldn't save the transcript")
    task.handle.cancel()


async def test_revert_undoes_only_the_sessions_own_edits_and_never_deletes_a_new_file(
    hub, tmp_path
):
    """The Changes pane's Revert once put the whole file back to the last commit, taking the
    owner's and other sessions' edits in it along. It undoes this session's hunks only."""
    import subprocess

    from claude_agent_sdk import AssistantMessage, ToolResultBlock, ToolUseBlock, UserMessage

    project = tmp_path / "proj"
    project.mkdir()

    def git(*args):
        subprocess.run(["git", "-C", str(project), *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    (project / "a.py").write_text("".join(f"x{i} = {i}\n" for i in range(30)))
    (project / "b.py").write_text("y = 1\n")
    git("add", ".")
    git("commit", "-qm", "one")
    task = hub.tasks.start("", "proj")

    def session_edits(tool, tool_input, apply):  # as Claude Code's Edit/Write reach the session
        hub.tasks._on_task_message(
            task,
            AssistantMessage(
                content=[ToolUseBlock(id=tool, name=tool.split("-")[0], input=tool_input)],
                model="m",
            ),
        )
        apply()
        hub.tasks._on_task_message(
            task,
            UserMessage(content=[ToolResultBlock(tool_use_id=tool, content="ok", is_error=False)]),
        )

    a = project / "a.py"
    hub.tasks._on_task_message(task, UserMessage(content="fix it", uuid="u-1"))
    session_edits(
        "Edit-1",
        {"file_path": str(a), "old_string": "x2 = 2\n", "new_string": "x2 = 'two'\n"},
        lambda: a.write_text(a.read_text().replace("x2 = 2\n", "x2 = 'two'\n")),
    )
    session_edits(
        "Write-2",
        {"file_path": str(project / "new.py"), "content": "z = 1\n"},
        lambda: (project / "new.py").write_text("z = 1\n"),
    )
    a.write_text(a.read_text().replace("x25 = 25\n", "x25 = 'owner'\n"))  # the owner's own edit
    (project / "b.py").write_text("y = 2\n")
    sent = _record(hub)
    await hub.handle({"type": "task_revert", "id": task.id, "path": "a.py"})
    assert "x2 = 2\n" in a.read_text() and "x25 = 'owner'\n" in a.read_text()
    assert (project / "b.py").read_text() == "y = 2\n"  # only the file asked for
    assert ("caption", {"text": "Undid this session's 1 change in a.py."}) in sent
    files = [d["files"] for k, d in sent if k == "task_diff"][-1]
    assert sorted(f["path"] for f in files) == ["a.py", "b.py", "new.py"]  # the owner's stay
    for path in ("new.py", "../outside.py", "b.py", ""):
        await hub.handle({"type": "task_revert", "id": task.id, "path": path})
    captions = [d["text"] for k, d in sent if k == "caption"][-4:]
    assert captions[0].startswith("new.py is a new file") and (project / "new.py").exists()
    assert captions[1].endswith("has no changes to revert.")
    assert captions[2].startswith("None of the changes in b.py are this session's")
    assert captions[3] == "That file has no changes to revert."
    assert (project / "b.py").read_text() == "y = 2\n"
    task.handle.cancel()
