"""Eden Code's memory files (code_memory, features/code_memory): a "# note" goes to the
CLAUDE.md the owner picks (the project's, its CLAUDE.local.md, or ~/.claude/CLAUDE.md), and
the Files pane edits the owner's own one too."""

import asyncio
import os

import pytest
from code_session_fakes import make_hub

from jarvis import code_memory
from jarvis.code_memory import append_note, choices
from jarvis.tasks import ClaudeTask


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A home of the test's own: the owner's real ~/.claude is never touched."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    return home


def test_a_note_is_a_line_of_its_own_and_never_written_through_a_link(tmp_path):
    path = tmp_path / "CLAUDE.md"
    append_note(path, "use pnpm")
    assert path.read_text() == "- use pnpm\n"
    path.write_bytes(b"# Notes\nno newline at the end")
    append_note(path, "tests in tests/")
    assert path.read_text() == "# Notes\nno newline at the end\n- tests in tests/\n"
    latin = tmp_path / "latin.md"
    latin.write_bytes("caf\xe9\n".encode("latin-1"))
    append_note(latin, "ok")
    assert latin.read_bytes() == b"caf\xe9\n- ok\n"
    (tmp_path / "elsewhere.md").write_text("theirs\n")
    link = tmp_path / "linked.md"
    link.symlink_to(tmp_path / "elsewhere.md")
    with pytest.raises(OSError):
        append_note(link, "never")
    assert (tmp_path / "elsewhere.md").read_text() == "theirs\n"


def test_the_owners_own_memory_follows_claude_code_s_config_folder(tmp_path, home, monkeypatch):
    assert code_memory.user_dir() == home / ".claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "config"))
    assert code_memory.path_for("user", tmp_path) == tmp_path / "config" / "CLAUDE.md"


def test_where_notes_can_go(tmp_path, home):
    (tmp_path / "CLAUDE.md").write_text("x")
    assert choices(tmp_path) == [
        {"target": "project", "path": "CLAUDE.md", "exists": True},
        {"target": "local", "path": "CLAUDE.local.md", "exists": False},
        {"target": "user", "path": "~/.claude/CLAUDE.md", "exists": False},
    ]
    assert code_memory.path_for("user", tmp_path) == home / ".claude" / "CLAUDE.md"


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def until(check, seconds=10.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


async def test_a_note_waits_for_where_it_goes_and_the_choice_is_kept(hub, tmp_path, home):
    proj = tmp_path / "proj"
    proj.mkdir()
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=proj)
    seen = record(hub)
    await hub.handle({"type": "task_memory", "id": 7, "text": "  always   use pnpm "})
    (ask,) = [d for k, d in seen if k == "cw_memory_ask"]
    assert ask["text"] == "always use pnpm" and ask["id"] == 7 and ask["last"] == "project"
    assert [c["target"] for c in ask["choices"]] == ["project", "local", "user"]
    assert not (proj / "CLAUDE.md").exists()  # nothing written before the answer
    await hub.handle({"type": "cw_memory_save", "ref": ask["ref"], "target": "local"})
    assert await until(lambda: any(k == "task_memory" for k, _ in seen))
    (done,) = [d for k, d in seen if k == "task_memory"]
    assert done == {
        "ok": True,
        "text": "always use pnpm",
        "path": str(proj / "CLAUDE.local.md"),
        "target": "local",
    }
    assert (proj / "CLAUDE.local.md").read_text() == "- always use pnpm\n"
    assert hub.prefs.feature("code_memory_target") == "local"
    # The next note asks with that choice first; the owner's own file is made when needed.
    await hub.handle({"type": "task_memory", "id": 7, "text": "answer briefly"})
    ask2 = [d for k, d in seen if k == "cw_memory_ask"][-1]
    assert ask2["last"] == "local"
    await hub.handle({"type": "cw_memory_save", "ref": ask2["ref"], "target": "user"})
    assert await until(lambda: (home / ".claude" / "CLAUDE.md").exists())
    assert (home / ".claude" / "CLAUDE.md").read_text() == "- answer briefly\n"
    # Declined, or answered twice: nothing more is written.
    await hub.handle({"type": "task_memory", "id": 7, "text": "never mind"})
    ask3 = [d for k, d in seen if k == "cw_memory_ask"][-1]
    await hub.handle({"type": "cw_memory_save", "ref": ask3["ref"], "target": None})
    await hub.handle({"type": "cw_memory_save", "ref": ask3["ref"], "target": "project"})
    await hub.handle({"type": "cw_memory_save", "ref": ask2["ref"], "target": "project"})
    await asyncio.sleep(0.1)
    assert not (proj / "CLAUDE.md").exists()


async def test_a_note_with_nowhere_to_go_says_so(hub, tmp_path):
    seen = record(hub)
    await hub.handle({"type": "task_memory", "id": 99, "text": "use pnpm"})
    await hub.handle({"type": "task_memory", "id": 99, "text": "   "})
    assert [d for k, d in seen if k == "task_memory"] == [
        {"ok": False, "text": "use pnpm", "path": ""},
        {"ok": False, "text": "", "path": ""},
    ]


async def test_the_owners_own_memory_file_is_edited_in_the_files_pane_and_nothing_else_there(
    hub, tmp_path, home
):
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text("{}")
    seen = record(hub)
    await hub.handle({"type": "cw_file_read", "memory": "user", "path": "CLAUDE.md", "ref": "u1"})
    assert await until(lambda: any(k == "cw_file" for k, _ in seen))
    (missing,) = [d for k, d in seen if k == "cw_file"]
    assert missing["missing"] and missing["ref"] == "u1"
    await hub.handle(
        {
            "type": "cw_file_save",
            "memory": "user",
            "path": "CLAUDE.md",
            "text": "# Me\n",
            "base": None,
            "create": True,
            "ref": "u1",
        }
    )
    assert await until(lambda: any(k == "cw_file_saved" for k, _ in seen))
    assert (home / ".claude" / "CLAUDE.md").read_text() == "# Me\n"
    for path in ("settings.json", "../.ssh/id_rsa", ""):
        await hub.handle(
            {"type": "cw_file_read", "memory": "user", "path": path, "ref": f"x{path}"}
        )
    assert await until(lambda: sum(k == "cw_file" for k, _ in seen) == 4)
    others = [d for k, d in seen if k == "cw_file"][1:]
    assert all(d.get("error") and "text" not in d for d in others)
    assert os.path.exists(home / ".claude" / "settings.json")
