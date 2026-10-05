"""The Changes pane's views (code_changes.view_for) do less for the same answer: the checkout
and HEAD come from one git call, the session and turn views no longer make the branch's view
(a dozen gits and a whole diff, after every step) when they have no files of their own for
it to number, and they read only the untracked files the session's edits touched. Each view
is checked against the views as they were made before, in real temp repositories."""

from pathlib import Path

import pytest
from conftest import FakeClient
from test_code_changes import Session, git, make_repo, numbered

from jarvis import code_changes as cc
from jarvis.tasks import ClaudeTask, TaskManager


@pytest.fixture
def tm(settings):
    async def approve(*_a, **_k):
        return "allow"

    return TaskManager(settings, approve, lambda *a, **k: None, client_factory=FakeClient)


@pytest.fixture
def calls(monkeypatch):
    """Every git code_changes starts, by its subcommand."""
    seen: list[str] = []
    real = cc.git

    def counting(cwd, *args, **kw):
        words = list(args)
        while words[:1] == ["-c"]:  # (the settings a call runs with)
            words = words[2:]
        seen.append(" ".join(words))
        return real(cwd, *args, **kw)

    monkeypatch.setattr(cc, "git", counting)
    return seen


# ── the views as they were made before ──


def old_session_view(cwd, marks, *, base="", scoped=True):
    repo = cc.repo_of(cwd)
    if repo is None:
        return None
    base = base or cc.head_commit(repo.top) or cc.EMPTY_TREE
    files = cc.diff_files(repo, base)
    if scoped:
        files = cc.scope(files, marks, repo.top)
    files = cc.spoken_order(files)
    return cc.View(repo, base, files, cc.number(files))


def old_view_for(cwd, marks, turn, which, *, base="", scoped=True, branch_into=""):
    session = old_session_view(cwd, marks, base=base, scoped=scoped)
    if session is None:
        return None
    branch = (
        cc.branch_view(session.repo, branch_into)
        if which == "branch" or not session.files
        else None
    )
    numbers = session.numbers if session.files or branch is None else branch.numbers
    if which == "session":
        return cc.View(session.repo, session.base, session.files, numbers)
    if which == "turn":
        files = cc.scope(session.files, turn, session.repo.top)
        return cc.View(session.repo, session.base, files, numbers)
    branch = branch or cc.branch_view(session.repo, branch_into)
    return cc.View(branch.repo, branch.base, branch.files, numbers)


def old_task_view(task, which="session"):
    ws = task.workspace or {}
    return old_view_for(
        task.cwd,
        list(task.edit_marks),
        cc.turn_marks(task),
        which,
        base=ws.get("base", ""),
        scoped=not ws,
        branch_into=ws.get("into", ""),
    )


def seen_as(view):
    """Everything a caller can tell of a view: its checkout, base, files, hunks, their
    numbers (numbered, by_number, public), and what a window is sent."""
    if view is None:
        return None
    return (
        view.repo,
        view.base,
        [(f.path, f.status, [h.id for h in f.hunks]) for f in view.files],
        [(n, f.path, h.id) for n, f, h in view.numbered()],
        cc.public(view),
    )


def same_as_before(task):
    for which in ("session", "turn", "branch", "elsewhere"):
        assert seen_as(cc.task_view(task, which)) == seen_as(old_task_view(task, which)), which


# ── one git for the checkout and HEAD ──


def test_the_checkout_and_head_come_from_one_git(tmp_path, calls):
    repo = make_repo(tmp_path / "p", {"a.py": "x\n", "sub/b.py": "y\n"})
    head = git(repo, "rev-parse", "HEAD").strip()
    for cwd, prefix in ((repo, ""), (repo / "sub", "sub/")):
        calls.clear()
        found, at = cc._repo_and_head(cwd)
        assert (found, at) == (cc.Repo(repo.resolve(), prefix), head)
        assert found == cc.repo_of(cwd) and at == cc.head_commit(found.top)
        assert len(calls) == 3  # (one here, then repo_of's and head_commit's to compare)


def test_no_commits_and_no_checkout_answer_as_before(tmp_path, calls):
    empty = tmp_path / "empty"
    empty.mkdir()
    git(empty, "init", "-q", "-b", "main")
    calls.clear()
    found, at = cc._repo_and_head(empty)
    assert found == cc.repo_of(empty) == cc.Repo(empty.resolve(), "") and at is None
    view = cc.session_view(empty, [], scoped=False)
    assert view.base == cc.EMPTY_TREE  # (HEAD read again, as before: none yet)
    assert seen_as(view) == seen_as(old_session_view(empty, [], scoped=False))
    plain = tmp_path / "plain"
    plain.mkdir()
    assert cc._repo_and_head(plain) == (None, None)
    assert cc.session_view(plain, []) is None and cc.view_for(plain, [], [], "branch") is None


def test_a_session_view_starts_three_gits_not_four(tm, tmp_path, calls):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20)})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 4\n", "line four\n")
    calls.clear()
    view = cc.task_view(s.task)
    assert [c.split()[0] for c in calls] == ["rev-parse", "diff", "ls-files"]
    calls.clear()
    before = old_task_view(s.task)
    assert len(calls) == 4
    assert seen_as(view) == seen_as(before)


# ── no branch view for the session and turn views ──


def test_a_session_with_nothing_of_its_own_makes_no_branch_view(tm, tmp_path, calls):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20)})
    (repo / "a.py").write_text(numbered(20).replace("line 7\n", "the owner's\n"))
    s = Session(tm, repo)
    s.turn("u-1")  # nothing edited yet: what changed is the owner's
    for which in ("session", "turn"):
        calls.clear()
        view = cc.task_view(s.task, which)
        assert view.files == [] and view.numbered() == []
        assert len(calls) == 3, calls
    calls.clear()
    old_task_view(s.task, "session")
    assert len(calls) == 10  # the session's 4, then the branch's 6 (its default branch,
    # HEAD, where it forked, its diff and its untracked files)
    branch = cc.task_view(s.task, "branch")  # (its own view: the owner's change, numbered)
    assert [(n, f.path) for n, f, _h in branch.numbered()] == [(1, "a.py")]
    same_as_before(s.task)


def test_every_view_is_as_before(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40), "b.py": numbered(10, "b")})
    git(repo, "checkout", "-q", "-b", "feature")
    s = Session(tm, repo)
    same_as_before(s.task)  # nothing yet
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    (repo / "b.py").write_text(numbered(10, "b").replace("b 3\n", "the owner's\n"))
    same_as_before(s.task)  # its own edit and the owner's
    s.turn("u-2")
    s.edit(repo / "a.py", "line 30\n", "line thirty\n")
    same_as_before(s.task)  # a turn of its own
    git(repo, "commit", "-qam", "its work")
    same_as_before(s.task)  # committed: nothing of its own against HEAD, the branch's numbered
    (repo / "new.py").write_text("print('hi')\n")
    same_as_before(s.task)  # an untracked file of someone else's


def test_an_isolated_copy_and_a_subfolder_are_as_before(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20), "app/c.py": numbered(20, "c")})
    base = git(repo, "rev-parse", "HEAD").strip()
    (repo / "a.py").write_text(numbered(20).replace("line 2\n", "committed\n"))
    git(repo, "commit", "-qam", "on the branch")
    task = ClaudeTask(id=1, prompt="x", cwd=repo)
    task.workspace = {"slug": "s", "branch": "jarvis/s", "base": base, "into": "main"}
    same_as_before(task)
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 15\n", "by a command\n"))
    same_as_before(task)
    sub = Session(tm, repo / "app", 2)
    sub.turn("u-1")
    sub.edit(repo / "app" / "c.py", "c 4\n", "c four\n")
    same_as_before(sub.task)


# ── the untracked files a session's view reads ──


def test_a_session_view_reads_only_its_own_untracked_files(tm, tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20)})
    for i in range(30):  # someone else's new files, not ignored
        (repo / f"notes{i}.txt").write_text(numbered(400, f"note {i}"))
    s = Session(tm, repo)
    s.turn("u-1")
    s.write(repo / "fresh.py", "print('hi')\n")
    s.edit(repo / "a.py", "line 3\n", "line three\n")
    read: list[str] = []
    real = Path.read_bytes

    def reading(self):
        read.append(self.name)
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", reading)
    for which in ("session", "turn"):
        read.clear()
        view = cc.task_view(s.task, which)
        assert sorted(f.path for f in view.files) == ["a.py", "fresh.py"]
        assert read == ["fresh.py"]  # (it read all 31 before)
    read.clear()
    branch = cc.task_view(s.task, "branch")  # everyone's: all of them, as before
    assert len(branch.files) == 32 and sorted(read)[:2] == ["fresh.py", "fresh.py"]
    assert len(read) == 1 + 31  # (the session's view it's numbered by, then the branch's)
    same_as_before(s.task)
