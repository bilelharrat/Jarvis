"""AGENTS.md beside CLAUDE.md (code_memory.write_shared, features/code_memory,
features/code_lessons, features/code_agents_md): what Eden writes into a project goes into its
own section of both files, the same in each and nothing else touched, and a session with
another agent (Codex, Gemini, OpenCode over ACP) gets the project's AGENTS.md as its notes."""

import json
import os
import shlex
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import code_memory
from jarvis.code_memory import EDEN_BEGIN, EDEN_END, section_of, sync_shared, write_shared
from jarvis.features import code_lessons as cl
from jarvis.features.code_agents_md import reads_agents_md
from jarvis.tasks import ClaudeTask

FAKE = [sys.executable, str(Path(__file__).parent / "acp_fake_agent.py")]
LONG = 4000


def eden_part(path: Path) -> str:
    text = path.read_text()
    return text[text.index(EDEN_BEGIN) : text.index(EDEN_END) + len(EDEN_END)]


def test_eden_s_section_is_the_same_in_both_files_and_nothing_else_is_touched(tmp_path):
    claude = tmp_path / "CLAUDE.md"
    claude.write_text("# Our project\n\nUse pnpm. The team's own words.\n")
    assert write_shared(tmp_path) == []  # nothing to write: nothing made
    assert not (tmp_path / "AGENTS.md").exists()
    written = write_shared(tmp_path, note="tests live in tests/")
    assert written == [claude, tmp_path / "AGENTS.md"]
    assert claude.read_text().startswith("# Our project\n\nUse pnpm. The team's own words.\n\n")
    assert eden_part(claude) == eden_part(tmp_path / "AGENTS.md")
    write_shared(tmp_path, note="tests live in tests/")  # the same again: not twice
    write_shared(tmp_path, lessons=["Never mock the database"])
    assert section_of(claude.read_text()) == (["tests live in tests/"], ["Never mock the database"])
    # The owner edits AGENTS.md's section by hand (and adds their own text after it): the
    # one edited last is what both get, and their text stays where they put it.
    agents = tmp_path / "AGENTS.md"
    agents.write_text(
        agents.read_text().replace("- tests live in tests/\n", "- tests are in spec/\n")
        + "\nTheir own line after it.\n"
    )
    os.utime(agents, ns=(claude.stat().st_mtime_ns + 10**9,) * 2)
    assert sync_shared(tmp_path) is True
    assert section_of(claude.read_text())[0] == ["tests are in spec/"]
    assert agents.read_text().endswith("Their own line after it.\n")
    assert claude.read_text().count(EDEN_BEGIN) == 1
    assert sync_shared(tmp_path) is False  # in step: nothing written


def test_links_are_never_written_through_and_odd_bytes_are_kept(tmp_path):
    # CLAUDE.md -> AGENTS.md (one file for both): written once, as AGENTS.md; the link stays.
    (tmp_path / "AGENTS.md").write_text("# Agents\n")
    (tmp_path / "CLAUDE.md").symlink_to("AGENTS.md")
    assert write_shared(tmp_path, note="one file") == [tmp_path / "AGENTS.md"]
    assert (tmp_path / "CLAUDE.md").is_symlink()
    assert (tmp_path / "AGENTS.md").read_text().count(EDEN_BEGIN) == 1
    # A link out of the project is left alone; the other file still gets the section.
    other = tmp_path / "other"
    other.mkdir()
    (tmp_path / "elsewhere.md").write_text("theirs\n")
    (other / "AGENTS.md").symlink_to(tmp_path / "elsewhere.md")
    (other / "CLAUDE.md").write_bytes(b"caf\xe9\n")
    assert write_shared(other, note="x") == [other / "CLAUDE.md"]
    assert (tmp_path / "elsewhere.md").read_text() == "theirs\n"
    assert (other / "CLAUDE.md").read_bytes().startswith(b"caf\xe9\n")


async def test_a_note_for_the_project_goes_to_claude_md_and_agents_md(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "CLAUDE.md").write_text("# Mine\n")
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=proj)
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub.handle({"type": "task_memory", "id": 7, "text": "always use pnpm"})
    (ask,) = [d for k, d in seen if k == "cw_memory_ask"]
    await hub.handle({"type": "cw_memory_save", "ref": ask["ref"], "target": "project"})
    assert await until(lambda: any(k == "task_memory" for k, _ in seen))
    (done,) = [d for k, d in seen if k == "task_memory"]
    assert done["ok"] and done["path"] == str(proj / "CLAUDE.md")
    assert done["also"] == [str(proj / "AGENTS.md")]
    assert (proj / "CLAUDE.md").read_text().startswith("# Mine\n")
    for name in ("CLAUDE.md", "AGENTS.md"):
        assert section_of((proj / name).read_text()) == (["always use pnpm"], [])


class Memory:
    def __init__(self):
        self.facts = []

    def add(self, text, **kw):
        self.facts.append(SimpleNamespace(text=text, origin=kw["origin"]))


def test_a_project_s_lessons_are_written_into_both_files_and_everywhere_ones_never(tmp_path):
    web = tmp_path / "web"
    web.mkdir()
    task = SimpleNamespace(id=1, kind="code", cwd=web, workspace={})
    on = {"code_lessons": True, "code_lessons_in_repo": True}
    hub = SimpleNamespace(
        memory=Memory(),
        prefs=SimpleNamespace(feature=lambda key: on.get(key)),
        tasks=SimpleNamespace(tasks={1: task}),
    )
    desk = cl.Lessons(hub)
    desk.learn(task, cl.lesson_in("From now on always write the changelog entry"))
    assert not (web / "CLAUDE.md").exists()  # the owner's own rule: not the repository's
    desk.learn(task, cl.lesson_in("no, don't mock the database in these tests"))
    for name in ("CLAUDE.md", "AGENTS.md"):
        assert section_of((web / name).read_text()) == (
            [],
            ["Don't mock the database in these tests"],
        )
    on["code_lessons_in_repo"] = False  # the setting off: the files are left as they are
    desk.learn(task, cl.lesson_in("no, use pnpm instead of npm here"))
    assert "pnpm" not in (web / "AGENTS.md").read_text()
    assert len(hub.memory.facts) == 3


def test_which_agents_read_agents_md_themselves():
    assert reads_agents_md(["codex-acp"])
    assert reads_agents_md(["/opt/homebrew/bin/opencode", "acp"])
    assert reads_agents_md(["npx", "@zed-industries/codex-acp"])  # (a scoped package)
    assert reads_agents_md(["npx", "codex-acp"])
    assert not reads_agents_md(["gemini", "--experimental-acp"])
    assert not reads_agents_md([])


async def test_an_acp_session_gets_the_project_s_agents_md_with_its_first_message(
    settings, quiet_speaker, isolated, tmp_path
):
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "CLAUDE.md").write_text("# Notes\nRun make check before saying it's done.\n")
    write_shared(proj, note="the API lives in api/")
    # Eden's section edited in CLAUDE.md since: brought into step before the agent reads it.
    claude = proj / "CLAUDE.md"
    claude.write_text(claude.read_text().replace("the API lives in api/", "the API is in srv/"))
    os.utime(claude, ns=((proj / "AGENTS.md").stat().st_mtime_ns + 10**9,) * 2)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.code_acp.env = {"FAKE_ACP_LOG": str(tmp_path / "agent.log")}
    hub.code_acp.book.add("Fake", shlex.join(FAKE))  # (not an agent that reads AGENTS.md)
    seen = events_of(hub)
    await hub._handle({"type": "acp_start", "agent": "fake", "directory": "proj"})
    [started] = [e for e in seen() if e["type"] == "acp_started"]
    task = hub.tasks.tasks[started["id"]]

    def prompts():
        out = []
        for line in (tmp_path / "agent.log").read_text().splitlines():
            msg = json.loads(line)
            if msg.get("method") == "session/prompt":
                out.append(msg["params"]["prompt"][0]["text"])
        return out

    for words in ("say hello", "say hello again"):
        turns = len([e for e in task.transcript if e["role"] == "turn"])
        hub.tasks.send(task.id, words)
        assert await until(
            lambda t=turns: len([e for e in task.transcript if e["role"] == "turn"]) > t, LONG
        )
    first, second = prompts()
    assert "from its AGENTS.md" in first and "the API is in srv/" in first
    assert first.endswith("say hello")
    assert second == "say hello again"  # the first message only
    assert section_of((proj / "AGENTS.md").read_text())[0] == ["the API is in srv/"]
    assert [e["text"] for e in task.transcript if e["role"] == "user"][0] == "say hello"
    await end_all(hub)


async def test_a_claude_session_hears_agents_md_only_where_there_is_no_claude_md(
    settings, quiet_speaker, isolated, tmp_path
):
    codex_only = tmp_path / "codexy"
    codex_only.mkdir()
    (codex_only / "AGENTS.md").write_text("Use uv, never pip.\n")
    both = tmp_path / "both"
    both.mkdir()
    (both / "AGENTS.md").write_text("Agents' notes.\n")
    (both / "CLAUDE.md").write_text("Claude's notes.\n")
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    a = hub.tasks.start("fix the build", str(codex_only))
    assert await until(lambda: Stream.instances and Stream.instances[-1].queries)
    assert "Use uv, never pip." in Stream.instances[-1].queries[0]
    b = hub.tasks.start("fix the build", str(both))
    assert await until(lambda: len(Stream.instances) > 1 and Stream.instances[-1].queries)
    assert "Agents' notes." not in Stream.instances[-1].queries[0]  # Claude Code reads CLAUDE.md
    assert a.id != b.id
    await end_all(hub)


@pytest.mark.parametrize("name", ["AGENTS.md", "CLAUDE.md"])
def test_project_notes_prefer_agents_md_and_are_capped(tmp_path, name):
    (tmp_path / name).write_text("x" * 50)
    found, text = code_memory.project_notes(tmp_path, 20)
    assert found == name and text.startswith("x" * 20) and "left out" in text
