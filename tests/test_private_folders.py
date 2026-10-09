"""Local-only mode (private_folders.py, features/private_mode.py): a folder the owner marks
private is never read into a request to Claude. Each reader is tried on a file in one and must
refuse it, saying why; the same reader still reads a file beside it that isn't private."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis import (
    attachments,
    computer,
    eden_files,
    fileindex,
    knowledge,
    pdfpages,
    picture_files,
    private_folders,
    reports,
)
from jarvis import documents as docs
from jarvis.features import private_mode
from jarvis.knowledge import KnowledgeBase, Note

SECRET = "Student 4471 scored 38 out of 100."


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A home folder with Documents/Grades (private) and Documents/Notes (not)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    grades = tmp_path / "Documents" / "Grades"
    notes = tmp_path / "Documents" / "Notes"
    grades.mkdir(parents=True)
    notes.mkdir(parents=True)
    (grades / "marks.md").write_text(f"# Marks\n{SECRET}\n")
    (grades / "scan.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    (notes / "plan.md").write_text("# Plan\nTeach recursion on Monday.\n")
    private_folders.configure(lambda: [str(grades)])
    return SimpleNamespace(root=tmp_path, grades=grades, notes=notes)


def words(result) -> str:
    return result["content"][0]["text"]


def refused(result) -> bool:
    return (
        bool(result.get("is_error")) and "private" in words(result) and SECRET not in words(result)
    )


# ── the list itself ──


def test_a_folder_is_private_with_everything_under_it_whatever_the_case(home):
    assert private_folders.is_private(home.grades / "marks.md")
    assert private_folders.is_private(home.grades / "deeper" / "x.docx")
    assert private_folders.is_private(str(home.grades).upper() + os.sep + "marks.md")
    assert not private_folders.is_private(home.notes / "plan.md")
    assert not private_folders.is_private(
        home.root / "Documents" / "Grades2" / "x.md"
    )  # a neighbour, not inside
    why = private_folders.refusal(home.grades / "marks.md")
    assert "marks.md" in why and "private" in why and "local only" in why
    with pytest.raises(private_folders.PrivateError):
        private_folders.check(home.grades / "marks.md")


def test_a_link_into_a_private_folder_is_private_too(home):
    link = home.notes / "shortcut.md"
    link.symlink_to(home.grades / "marks.md")
    assert private_folders.is_private(link)
    assert not private_folders.is_private(link, follow=False)  # (a walk checks links itself)


def test_the_setting_keeps_whole_paths_only():
    assert private_folders.clean(["/a/b", "/a/b", "~/x"]) == ["/a/b", str(Path("~/x").expanduser())]
    assert private_folders.clean(["relative/folder"]) is None
    assert private_folders.clean("not a list") is None
    assert private_folders.clean([3]) is None


def test_the_helper_programs_read_the_copy_on_disk(home):
    private_folders.save_copy([str(home.grades)])
    private_folders.configure(None)  # as in the second brain's rebuild, a program of its own
    assert json.loads(private_folders.PATH.read_text())["folders"] == [str(home.grades)]
    assert private_folders.is_private(home.grades / "marks.md")
    assert private_folders.mentioned_in(f"cat '{home.grades}/marks.md'") == str(home.grades)
    assert private_folders.mentioned_in("cat ~/Documents/Grades/marks.md") == str(home.grades)
    assert private_folders.mentioned_in("ls ~/Documents/Notes") == ""


# ── every reader refuses ──


@pytest.fixture
def computer_tools(monkeypatch):
    monkeypatch.setattr(computer, "create_sdk_mcp_server", lambda **k: k["tools"])
    return {t.name: t.handler for t in computer.build_server(computer.Screen())}


async def test_read_file_refuses_and_says_why_but_reads_the_rest(home, computer_tools):
    read = computer_tools["read_file"]
    assert refused(await read({"path": str(home.grades / "marks.md")}))
    assert refused(await read({"path": str(home.grades / "scan.png")}))  # a picture too
    assert "recursion" in words(await read({"path": str(home.notes / "plan.md")}))


async def test_find_files_on_a_pc_leaves_private_folders_out(home, computer_tools, monkeypatch):
    monkeypatch.setattr(computer, "IS_WIN", True)
    monkeypatch.setattr(
        computer,
        "_walk_find",
        lambda q, c: [str(home.grades / "marks.md"), str(home.notes / "plan.md")],
    )
    found = words(await computer_tools["find_files"]({"query": "md"}))
    assert "plan.md" in found and "marks.md" not in found


def test_the_walk_behind_find_files_never_enters_a_private_folder(home):
    names = computer._walk_find("md", True)
    assert any(p.endswith("plan.md") for p in names)
    assert not any("Grades" in p for p in names)


def test_read_document_refuses(home):
    store = docs.DocumentStore(
        home.root / "state" / "documents.json", extract=lambda p: p.read_text()
    )
    tools = {t.name: t.handler for t in docs.build_tools(store)}
    out = asyncio.run(tools["read_document"]({"path": str(home.grades / "marks.md")}))
    assert refused(out)
    assert "recursion" in words(
        asyncio.run(tools["read_document"]({"path": str(home.notes / "plan.md")}))
    )


def test_the_readers_underneath_give_nothing(home):
    assert knowledge.read_document(home.grades / "marks.md") == ""
    assert "recursion" in knowledge.read_document(home.notes / "plan.md")
    assert picture_files.result(home.grades / "scan.png") is None
    assert pdfpages.scanned_result(home.grades / "scan.pdf", 1, "scan.pdf", "read_file") is None


def test_the_second_brain_never_indexes_a_private_folder(home):
    notes = knowledge.collect_folder(home.root / "Documents")
    assert [n.title for n in notes] and all("Grades" not in n.ref for n in notes)
    assert knowledge.collect_folder(home.grades) == []
    # Notes made before the folder was private are never shown from the index again.
    kb = KnowledgeBase(home.root / "brain" / "index.json")
    kb.build(
        {
            "files": [
                Note(
                    f"file:{home.grades / 'marks.md'}",
                    "files",
                    "Marks",
                    SECRET,
                    str(home.grades / "marks.md"),
                ),
                Note(
                    f"file:{home.notes / 'plan.md'}",
                    "files",
                    "Plan",
                    "Teach recursion scored",
                    str(home.notes / "plan.md"),
                ),
            ]
        }
    )
    hits = kb.search("scored")
    assert [h["title"] for h in hits] == ["Plan"]
    assert kb.get(f"file:{home.grades / 'marks.md'}") is None


def test_the_file_index_keeps_private_folders_out_and_hides_what_it_had(home):
    index = fileindex.FileIndex(home.root / "files.db", [home.root / "Documents"], home=home.root)
    private_folders.configure(lambda: [])
    index.refresh()
    assert any("Grades" in h.path for h in index.search("scored"))  # indexed while not private
    private_folders.configure(lambda: [str(home.grades)])
    tools = {t.name: t.handler for t in fileindex.build_tools(index)}
    out = words(asyncio.run(tools["find_my_files"]({"query": "scored"})))
    assert "marks" not in out.lower()
    fresh = fileindex.FileIndex(home.root / "files2.db", [home.root / "Documents"], home=home.root)
    fresh.refresh()
    assert not any("Grades" in h.path for h in fresh.search("scored"))
    assert any("plan" in h.name.lower() for h in fresh.search("recursion"))


def test_a_private_file_is_never_attached_to_an_email(home):
    target = home.grades / "marks.md"
    found, why = attachments.check([str(target)], made=[], words=f"attach {target}")
    assert found == [] and "private" in why
    plan = home.notes / "plan.md"
    found, why = attachments.check([str(plan)], made=[], words=f"attach {plan}")
    assert found == [plan.resolve()] and why == ""


def test_eden_never_sees_a_private_folder(home):
    roots = [home.root.resolve()]
    assert not eden_files.allowed((home.grades / "marks.md").resolve(), roots, home.root.resolve())
    assert eden_files.allowed((home.notes / "plan.md").resolve(), roots, home.root.resolve())


async def test_the_reports_reader_refuses(home):
    files = fileindex.FileIndex(home.root / "files.db", [home.root / "Documents"], home=home.root)
    hub = SimpleNamespace(kb=KnowledgeBase(home.root / "kb.json"), files=files, note_text=str)
    tools = {t.name: t.handler for t in reports._own_material_tools(hub)}
    assert refused(await tools["read_file"]({"path": str(home.grades / "marks.md")}))
    assert "recursion" in words(await tools["read_file"]({"path": str(home.notes / "plan.md")}))


async def test_eden_code_is_denied_a_private_folder_in_every_mode(home, settings):
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
    from conftest import FakeClient

    from jarvis.tasks import TaskManager

    async def approve(*_a, **_k):
        return "allow"

    tm = TaskManager(settings, approve, lambda *a, **k: None, FakeClient)
    (settings.projects_dir / "proj").mkdir()
    task = tm.start("", "proj")
    task.mode = "auto"  # Bypass permissions: still no
    can = tm.policy_for(task)
    for name, tool_input in (
        ("Read", {"file_path": str(home.grades / "marks.md")}),
        ("Grep", {"pattern": "scored", "path": str(home.grades)}),
        ("Bash", {"command": f"cat {home.grades}/marks.md"}),
        (
            "Edit",
            {"file_path": str(home.grades / "marks.md"), "old_string": "a", "new_string": "b"},
        ),
    ):
        out = await can(name, tool_input, None)
        assert isinstance(out, PermissionResultDeny), name
        assert "private" in out.message
    assert isinstance(await can("Bash", {"command": "ls"}, None), PermissionResultAllow)
    with pytest.raises(ValueError, match="private"):
        tm.resolve_dir(str(home.grades))


# ── the feature: by voice ──


def feature_hub(tmp_path, answer=True):
    features: dict = {}
    servers: dict = {}
    asked: list = []

    async def gate(action, question):
        asked.append((action, question))
        return answer

    hub = SimpleNamespace(
        prefs=SimpleNamespace(feature=lambda key: features.get(key, [])),
        set_feature_prefs=lambda changes: features.update(
            {k: private_folders.clean(v) for k, v in changes.items()}
        ),
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        feature_gate=gate,
        poll=False,
    )
    private_mode.install(hub)
    return hub, servers, asked, features


async def test_marking_listing_and_unmarking_a_folder_by_voice(home, monkeypatch):
    hub, servers, asked, features = feature_hub(home.root)
    build, kw = servers["private"]
    assert "private" in kw["prompt"] and set(kw["labels"]) == {
        "keep_folder_private",
        "stop_keeping_private",
        "private_folders",
    }
    monkeypatch.setattr(private_mode, "create_sdk_mcp_server", lambda **k: k["tools"])
    tools = {t.name: t.handler for t in build()}
    out = words(await tools["keep_folder_private"]({"folder": "Documents/Grades"}))
    assert "Grades is private now" in out and "1 private folder in all" in out
    assert features["private_folders"] == [str(home.grades.resolve())]
    assert json.loads(private_folders.PATH.read_text())["folders"] == [str(home.grades.resolve())]
    assert private_folders.is_private(home.grades / "marks.md")
    assert "already kept private" in words(
        await tools["keep_folder_private"]({"folder": str(home.grades)})
    )
    assert (await tools["keep_folder_private"]({"folder": "Documents/Nowhere"}))["is_error"]
    assert "1 private folder (local only)" in words(await tools["private_folders"]({}))
    out = await tools["stop_keeping_private"]({"folder": "Grades"})
    assert (
        asked and asked[0][0] == "stop_keeping_private" and "isn't private any more" in words(out)
    )
    assert not private_folders.is_private(home.grades / "marks.md")


async def test_unmarking_needs_the_owners_yes(home, monkeypatch):
    hub, servers, asked, features = feature_hub(home.root, answer=False)
    monkeypatch.setattr(private_mode, "create_sdk_mcp_server", lambda **k: k["tools"])
    tools = {t.name: t.handler for t in servers["private"][0]()}
    await tools["keep_folder_private"]({"folder": str(home.grades)})
    out = await tools["stop_keeping_private"]({"folder": str(home.grades)})
    assert out["is_error"] and "stays private" in words(out)
    assert private_folders.is_private(home.grades / "marks.md")
