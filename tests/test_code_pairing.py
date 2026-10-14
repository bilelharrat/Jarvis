"""Pairing mode (pairsync.py and features/code_pairing.py): an isolated copy mirrored both
ways into the owner's own folder; conflicts never overwrite either side; files that run by
themselves wait for the owner before they reach the folder their editor opens. Real git
and real files in temp folders; fake Claude Code sessions."""

import json
import os

import pytest
from test_code_changes import make_repo
from test_code_isolation import answer, copy_of, hub, isolated_session, projects, until

from jarvis import pairsync
from jarvis.pairsync import Pair, Syncer

__all__ = ["hub", "projects"]  # (the fixtures, used by name)


def pair_of(tmp_path, files):
    copy = make_repo(tmp_path / "copy", files)
    folder = tmp_path / "mine"
    folder.mkdir()
    return copy, folder, Syncer(Pair("s-1", str(copy), str(folder)))


def bump(path, text):
    """Write a file so its stat surely changes (mtime has a coarse grain on some disks)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))


# ── the sync ──


def test_the_copy_is_mirrored_and_edits_flow_both_ways(tmp_path):
    copy, folder, sync = pair_of(
        tmp_path,
        {"a.py": "a = 1\n", "src/b.py": "b = 1\n", ".gitignore": "build/\n*.log\n"},
    )
    (copy / "new.py").write_text("new\n")  # not committed yet, but not ignored either
    (copy / "debug.log").write_text("noise\n")  # ignored: never mirrored
    done = sync.sync()
    assert sorted(done.to_folder) == [".gitignore", "a.py", "new.py", "src/b.py"]
    assert (folder / "src" / "b.py").read_text() == "b = 1\n" and not (
        folder / "debug.log"
    ).exists()
    # The owner edits in their editor: it comes into the copy.
    bump(folder / "a.py", "a = 2  # mine\n")
    done = sync.sync()
    assert done.to_copy == ["a.py"] and (copy / "a.py").read_text() == "a = 2  # mine\n"
    # The session edits: it goes to the folder.
    bump(copy / "src" / "b.py", "b = 2  # Eden\n")
    assert sync.sync().to_folder == ["src/b.py"]
    assert (folder / "src" / "b.py").read_text() == "b = 2  # Eden\n"
    # A new file of the owner's comes in; build output their editor made (ignored) doesn't.
    bump(folder / "c.py", "c\n")
    bump(folder / "build" / "out.js", "x\n")
    done = sync.sync()
    assert done.to_copy == ["c.py"] and not (copy / "build").exists()
    # Deleting on one side deletes on the other.
    (folder / "c.py").unlink()
    assert sync.sync().to_copy == ["c.py"] and not (copy / "c.py").exists()
    (copy / "new.py").unlink()
    assert sync.sync().to_folder == ["new.py"] and not (folder / "new.py").exists()
    assert not sync.sync().anything  # settled


def test_a_file_changed_on_both_sides_is_a_conflict_and_neither_is_overwritten(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a = 1\n"})
    sync.sync()
    bump(copy / "a.py", "a = 'eden'\n")
    bump(folder / "a.py", "a = 'mine'\n")
    done = sync.sync()
    assert done.conflicts == ["a.py"] and sync.pair.public()["conflicts"] == ["a.py"]
    assert (copy / "a.py").read_text() == "a = 'eden'\n"
    assert (folder / "a.py").read_text() == "a = 'mine'\n"
    bump(copy / "a.py", "a = 'eden again'\n")  # out of the sync until it's settled
    assert not sync.sync().to_folder and (folder / "a.py").read_text() == "a = 'mine'\n"
    assert sync.keep("a.py", "folder")  # Keep mine
    assert (copy / "a.py").read_text() == "a = 'mine'\n" and not sync.pair.conflicts
    bump(copy / "a.py", "a = 3\n")
    assert sync.sync().to_folder == ["a.py"]  # synced again


def test_both_sides_made_the_same_settles_a_conflict(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a = 1\n"})
    sync.sync()
    bump(copy / "a.py", "x\n")
    bump(folder / "a.py", "y\n")
    sync.sync()
    bump(folder / "a.py", "x\n")
    assert sync.sync().resolved == ["a.py"] and not sync.pair.conflicts


def test_files_that_run_by_themselves_wait_for_the_owner(tmp_path):
    copy, folder, sync = pair_of(
        tmp_path,
        {
            "a.py": "a\n",
            ".vscode/tasks.json": '{"tasks": []}',
            ".jarvis/launch.json": "{}",
            "package.json": json.dumps({"name": "x", "husky": {"hooks": {"pre-commit": "x"}}}),
            ".pre-commit-config.yaml": "repos: []\n",
        },
    )
    done = sync.sync()
    assert done.to_folder == ["a.py"]
    assert sorted(done.held) == [
        ".jarvis/launch.json", ".pre-commit-config.yaml", ".vscode/tasks.json", "package.json",
    ]  # fmt: skip
    assert not (folder / ".vscode").exists() and not (folder / "package.json").exists()
    # A package.json whose hooks don't change is an ordinary file.
    bump(copy / "package.json", json.dumps({"name": "y", "husky": {"hooks": {"pre-commit": "x"}}}))
    assert sync.release(["package.json"]) == ["package.json"]
    bump(copy / "package.json", json.dumps({"name": "z", "husky": {"hooks": {"pre-commit": "x"}}}))
    assert sync.sync().to_folder == ["package.json"]
    bump(copy / "package.json", json.dumps({"name": "z", "husky": {"hooks": {"pre-commit": "rm"}}}))
    assert sync.sync().held == ["package.json"]
    # The owner brings the rest over; the owner's own edits to them go to the copy as any do.
    assert len(sync.release()) == 4 and (folder / ".vscode" / "tasks.json").is_file()
    bump(folder / ".vscode" / "tasks.json", '{"tasks": ["mine"]}')
    assert sync.sync().to_copy == [".vscode/tasks.json"]


def test_links_and_git_internals_are_never_mirrored(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    secret = tmp_path / "secret.txt"
    secret.write_text("key\n")
    (folder / "link.txt").symlink_to(secret)
    (folder / ".git").mkdir()
    (folder / ".git" / "config").write_text("[core]\n")
    sync.sync()
    assert not (copy / "link.txt").exists()
    assert (copy / ".git" / "config").read_text() != "[core]\n"  # (the copy's own git, untouched)


def test_a_kept_pairing_reads_back_and_odd_records_are_skipped():
    pair = Pair("s", "/c", "/f", base={"a": "1"}, conflicts={"b": {"copy": "1", "folder": "2"}})
    back = Pair.from_json(json.loads(json.dumps(pair.to_json())))
    assert back == pair
    assert Pair.from_json({"slug": "s"}) is None and Pair.from_json([1]) is None


# ── the feature ──


@pytest.fixture
def home(tmp_path, monkeypatch):
    """The home folder is the test's own (the projects and the copies are inside it)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


async def test_pairing_a_session_mirrors_its_copy_and_tells_it_about_owner_edits(
    hub, projects, home
):
    make_repo(projects / "proj", {"a.py": "a = 1\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    mine = home / "pair"
    said = await pairing.turn_on(task, str(mine))
    assert said.startswith("Pairing on:") and (mine / "a.py").read_text() == "a = 1\n"
    assert json.loads((mine / pairsync.MARKER).read_text())["slug"] == task.workspace["slug"]
    bump(mine / "a.py", "a = 2\n")
    await pairing.tick(pairing.pairs()[task.workspace["slug"]])
    assert (task.cwd / "a.py").read_text() == "a = 2\n"
    assert any(
        "Your edits came in from the pairing folder: a.py." in e["text"] for e in task.transcript
    )
    shown = [d for k, d in hub.events if k == "code_pair" and d["id"] == task.id]
    assert shown[-1]["on"] is True and shown[-1]["folder"] == str(mine.resolve())
    # Off: the sync stops, the folder stays; on again picks up where it left off.
    assert (await pairing.turn_off(task)).startswith("Pairing off.")
    bump(task.cwd / "a.py", "a = 3\n")
    assert (mine / "a.py").read_text() == "a = 2\n"
    await pairing.turn_on(task, "")
    assert (mine / "a.py").read_text() == "a = 3\n"
    # Landing the copy ends the pairing; the folder is the owner's and stays.
    answer(hub, "land")
    await hub.code_desk.land(task.workspace["slug"])
    assert await until(lambda: task.workspace["slug"] not in pairing.pairs(), seconds=10)
    assert (mine / "a.py").read_text() == "a = 3\n"


async def test_the_default_folder_and_the_folders_it_refuses(hub, projects, home):
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    copy = copy_of(hub, task)
    full = home / "full"
    full.mkdir()
    (full / "x.txt").write_text("mine\n")
    assert "isn't empty" in await pairing.turn_on(task, str(full))
    assert (full / "x.txt").read_text() == "mine\n"
    assert "inside your home folder" in await pairing.turn_on(task, "/tmp/somewhere")
    assert "can't be a pairing folder" in await pairing.turn_on(task, str(copy.cwd / "sub"))
    assert "can't be a pairing folder" in await pairing.turn_on(task, str(projects / "proj" / "x"))
    assert "inside your home folder" in await pairing.turn_on(task, str(home))
    assert "inside your home folder" in await pairing.turn_on(task, "relative/path")
    said = await pairing.turn_on(task, "")
    assert said.startswith("Pairing on:") and "Eden Pairing" in said
    assert (home / "Eden Pairing" / f"proj-{copy.slug}" / "a.py").is_file()
    pairing.stop_loop(copy.slug)


async def test_a_session_without_a_copy_is_told_what_pairing_needs(hub, projects, home):
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = hub.tasks.start("", "proj", isolate=False)
    assert "isolated copy" in await hub.code_pairing.turn_on(task, "")


async def test_conflicts_are_kept_by_the_owners_choice_from_the_window(hub, projects, home):
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    mine = home / "p"
    await pairing.turn_on(task, str(mine))
    pair = pairing.pairs()[task.workspace["slug"]]
    bump(task.cwd / "a.py", "eden\n")
    bump(mine / "a.py", "mine\n")
    await pairing.tick(pair)
    assert pair.conflicts and any(
        "changed on both sides" in d["text"] for k, d in hub.events if k == "caption"
    )
    assert await pairing.keep(task, "a.py", "eden") == "Kept it."
    assert (mine / "a.py").read_text() == "eden\n" and not pair.conflicts
    pairing.stop_loop(pair.slug)
