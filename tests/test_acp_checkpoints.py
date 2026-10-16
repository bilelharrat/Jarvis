"""Eden's own file checkpoints for other agents over ACP (acp_checkpoints.py): a snapshot is a
commit object under a hidden ref, made without touching the owner's index, branches or stash;
a rewind puts back only the files asked for, as they were, and leaves the rest alone."""

import subprocess

import pytest

from jarvis import acp_checkpoints as ck


def git(repo, *args):
    return subprocess.run(
        ["git", "-c", "user.name=T", "-c", "user.email=t@t", *args],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout  # fmt: skip


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    git(root, "init", "-q")
    (root / "a.txt").write_text("one\n")
    (root / ".gitignore").write_text("secret.env\nbuild/\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "first")
    return root


def test_a_snapshot_touches_nothing_of_the_owner_s(repo):
    (repo / "staged.txt").write_text("staged\n")
    git(repo, "add", "staged.txt")
    (repo / "loose.txt").write_text("untracked\n")
    index_before = (repo / ".git" / "index").read_bytes()
    status_before = git(repo, "status", "--porcelain")
    head = git(repo, "rev-parse", "HEAD")
    commit = ck.snapshot(repo, "Eden Code: test")
    ck.keep(repo, ck.ref_for("u1", "before"), commit)
    assert (repo / ".git" / "index").read_bytes() == index_before
    assert git(repo, "status", "--porcelain") == status_before
    assert git(repo, "rev-parse", "HEAD") == head
    assert git(repo, "stash", "list") == ""  # (never the shared stash)
    files = git(repo, "ls-tree", "-r", "--name-only", commit).split()
    assert {"a.txt", "staged.txt", "loose.txt"} <= set(files)
    assert ck.find(repo, ck.ref_for("u1", "before")) == commit
    assert "Eden Code" not in git(repo, "log", "--format=%an")  # (not on any branch)


def test_ignored_files_are_neither_kept_nor_put_back(repo):
    (repo / "secret.env").write_text("KEY=1\n")
    before = ck.snapshot(repo, "b")
    assert "secret.env" not in git(repo, "ls-tree", "-r", "--name-only", before)
    (repo / "secret.env").write_text("KEY=2\n")
    (repo / "a.txt").write_text("two\n")
    after = ck.snapshot(repo, "a")
    assert ck.changed(repo, before, after) == [str(repo / "a.txt")]
    # Named anyway (an agent's Edit step on it): never removed for not being kept.
    assert ck.restore(repo, before, [str(repo / "secret.env"), str(repo / "a.txt")]) == ["a.txt"]
    assert (repo / "secret.env").read_text() == "KEY=2\n"


def test_changed_and_restore_put_back_exactly_the_turn_s_files(repo):
    (repo / "mine.txt").write_text("the owner's own\n")
    (repo / "gone.txt").write_text("keep me\n")
    before = ck.snapshot(repo, "before")
    (repo / "a.txt").write_text("changed by the agent\n")
    (repo / "sub").mkdir()
    (repo / "sub" / "new.txt").write_text("new\n")
    (repo / "gone.txt").unlink()
    after = ck.snapshot(repo, "after")
    changed = sorted(ck.changed(repo, before, after))
    assert changed == sorted(str(repo / p) for p in ("a.txt", "gone.txt", "sub/new.txt"))
    (repo / "mine.txt").write_text("the owner changed it since\n")
    put = ck.restore(repo, before, changed)
    assert put == ["a.txt", "gone.txt", "sub/new.txt"]
    assert (repo / "a.txt").read_text() == "one\n"
    assert (repo / "gone.txt").read_text() == "keep me\n"
    assert not (repo / "sub").exists()  # (the folder it left empty goes too)
    assert (repo / "mine.txt").read_text() == "the owner changed it since\n"  # left alone


def test_a_rewind_never_writes_outside_the_project(repo, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("safe\n")
    (repo / "link").symlink_to(tmp_path)
    before = ck.snapshot(repo, "b")
    assert (
        ck.restore(
            repo, before, [str(outside), "../outside.txt", "link/outside.txt", ".git/config"]
        )
        == []
    )
    assert outside.read_text() == "safe\n"


def test_old_turns_snapshots_go_and_a_folder_outside_git_has_none(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(ck, "KEPT", 2)
    for n in range(4):
        (repo / "a.txt").write_text(f"{n}\n")
        ck.keep(repo, ck.ref_for(f"u{n}", "before"), ck.snapshot(repo, str(n)))
    refs = git(repo, "for-each-ref", "--format=%(refname)", ck.REF_ROOT).split()
    assert len(refs) == 2
    ck.drop(repo, refs)
    assert git(repo, "for-each-ref", ck.REF_ROOT) == ""
    plain = tmp_path / "plain"
    plain.mkdir()
    assert ck.repo_top(plain) is None
    with pytest.raises(ck.CheckpointError, match="isn't in a git repository"):
        ck.snapshot(plain, "x")
    assert ck.find(plain, ck.ref_for("u", "before")) == ""


def test_a_repo_with_no_commit_yet_still_has_snapshots(tmp_path):
    root = tmp_path / "fresh"
    root.mkdir()
    git(root, "init", "-q")
    (root / "a.txt").write_text("x\n")
    before = ck.snapshot(root, "b")
    (root / "a.txt").write_text("y\n")
    ck.restore(root, before, ck.changed(root, before, ck.snapshot(root, "a")))
    assert (root / "a.txt").read_text() == "x\n"


def test_a_session_in_one_folder_of_a_repo_snapshots_only_that_folder(repo):
    (repo / "app").mkdir()
    (repo / "app" / "x.txt").write_text("x\n")
    (repo / "other.txt").write_text("not the session's\n")
    before = ck.snapshot(repo / "app", "b")
    assert "other.txt" not in git(
        repo, "ls-tree", "-r", "--name-only", before
    )  # (untracked, outside)
    (repo / "app" / "x.txt").write_text("y\n")
    (repo / "a.txt").write_text("changed outside the folder\n")
    after = ck.snapshot(repo / "app", "a")
    assert ck.changed(repo / "app", before, after) == [str(repo / "app" / "x.txt")]
