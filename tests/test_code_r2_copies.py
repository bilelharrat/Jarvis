# ruff: noqa: F811  (the fixtures are shared with test_code_pr / test_code_bestof)
"""Round-2 sweep fixes (askeden/docs/bug-sweep/r2-eden-code-git.md, CB2-1…CB2-17): isolated
copies are never removed unless all of their work is provably kept or landed; Land refuses
a copy half way through a merge, off its branch, or holding a repository of its own; nothing
starts in a copy while it's landed or discarded; and the Changes view, Git panel and pull
request follow-ups smaller fixes. Real git in temp repositories; fake sessions and GitHub."""

import asyncio
import os
import stat
import subprocess
import threading
import time
import unicodedata
from pathlib import Path

import pytest
from test_code_changes import git, make_repo, numbered
from test_code_isolation import copy_of, isolated_session, until
from test_code_pr import (  # noqa: F401  (fixtures)
    _no_real_gh,
    github_project,
    hub,
    projects,
    sends,
    session,
    watched,
)

from jarvis import code_changes, worktrees
from jarvis.features import code_git


def new_copy(repo: Path, root: Path, title: str = "fix it") -> worktrees.Copy:
    root.mkdir(exist_ok=True)
    copy, _notes = worktrees.create(repo, root, title, taken=set())
    return copy


def refs(repo: Path) -> list[str]:
    return git(repo, "for-each-ref", "--format=%(refname)").split()


def events(hub, kind):
    return [d for k, d in hub.events if k == kind]


# ── CB2-1: Discard keeps everything, or discards nothing ──


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
def test_a_file_git_cant_read_stops_the_discard_and_nothing_is_lost(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("precious uncommitted work\n")
    (co / "new_module.py").write_text("x = 'never committed'\n")
    (co / "locked.bin").write_text("no read")
    os.chmod(co / "locked.bin", 0)
    try:
        with pytest.raises(worktrees.CopyError) as said:
            worktrees.discard(copy, tmp_path / "wt")
    finally:
        os.chmod(co / "locked.bin", 0o644)
    assert str(said.value).startswith(worktrees.KEEP_FAILED) and "locked.bin" in str(said.value)
    assert (co / "a.txt").read_text() == "precious uncommitted work\n"
    assert (co / "new_module.py").exists()
    assert not [r for r in refs(repo) if r.startswith(worktrees.TRASH_PREFIX)]
    # Readable again: discarded, and the recovery ref holds all of it.
    item = worktrees.discard(copy, tmp_path / "wt")
    assert git(repo, "show", f"{item['ref']}:a.txt") == "precious uncommitted work\n"
    assert "never committed" in git(repo, "show", f"{item['ref']}:new_module.py")
    assert not co.exists()


def test_a_repository_inside_the_copy_stops_the_discard(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    for with_commit in (False, True):
        copy = new_copy(repo, tmp_path / "wt", f"nested {with_commit}")
        co = Path(copy.checkout)
        (co / "a.txt").write_text("outer work\n")
        nested = co / "vendor" / "lib"
        nested.mkdir(parents=True)
        git(nested, "init", "-q", "-b", "main")
        (nested / "lib.py").write_text("work inside a nested repo\n")
        if with_commit:
            git(nested, "add", "-A")
            git(nested, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "c")
        with pytest.raises(worktrees.CopyError, match="vendor/lib is a git repository"):
            worktrees.discard(copy, tmp_path / "wt")
        assert (nested / "lib.py").exists() and (co / "a.txt").read_text() == "outer work\n"
        worktrees.remove(copy, tmp_path / "wt")


def test_files_written_while_the_snapshot_is_made_are_kept_or_nothing_is_discarded(
    tmp_path, monkeypatch
):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("work\n")
    real = worktrees.git
    adds = []

    def racing(cwd, *args, **kw):
        done = real(cwd, *args, **kw)
        if args[:2] == ("add", "-A"):
            adds.append(1)
            if len(adds) == 1:  # a tool writes a file just after the first add
                (co / "late.log").write_text("written meanwhile\n")
        return done

    monkeypatch.setattr(worktrees, "git", racing)
    item = worktrees.discard(copy, tmp_path / "wt")
    assert len(adds) == 2  # tried again, and the second time it was all there
    assert git(repo, "show", f"{item['ref']}:late.log") == "written meanwhile\n"
    assert git(repo, "show", f"{item['ref']}:a.txt") == "work\n"
    # Something that keeps writing: refused after a few tries, the copy kept as it is.
    copy = new_copy(repo, tmp_path / "wt", "churn")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("more work\n")
    n = iter(range(100))

    def churning(cwd, *args, **kw):
        done = real(cwd, *args, **kw)
        if args[:2] == ("add", "-A"):
            (co / f"tmp{next(n)}.log").write_text("x\n")
        return done

    monkeypatch.setattr(worktrees, "git", churning)
    with pytest.raises(worktrees.CopyError, match="kept changing"):
        worktrees.discard(copy, tmp_path / "wt")
    assert (co / "a.txt").read_text() == "more work\n"


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
async def test_discard_says_its_kept_only_once_it_is(hub, projects):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text("work\n")
    (task.cwd / "secret.bin").write_text("x")
    os.chmod(task.cwd / "secret.bin", 0)
    try:
        said = await hub.code_desk.discard_now(copy)
    finally:
        os.chmod(task.cwd / "secret.bin", 0o644)
    assert said.startswith("Couldn't keep a recovery copy, so nothing was discarded:")
    assert "secret.bin" in said and "kept for 30 days" not in said
    assert copy in hub.code_desk.store().copies and (task.cwd / "a.py").read_text() == "work\n"
    assert hub.code_desk.store().trash == []


# ── CB2-2: never land a half-done merge ──


def test_land_refuses_a_copy_mid_merge_or_mid_rebase_with_conflicts(tmp_path):
    for how in ("merge", "rebase"):
        repo = make_repo(tmp_path / how, {"a.txt": "1\n2\n3\n"})
        copy = new_copy(repo, tmp_path / "wt", how)
        co = Path(copy.checkout)
        (co / "a.txt").write_text("1\ncopy\n3\n")
        git(co, "commit", "-qam", "copy work")
        (repo / "a.txt").write_text("1\nmain\n3\n")
        git(repo, "commit", "-qam", "main work")
        subprocess.run(["git", "-C", str(co), how, "main"], capture_output=True)
        main_before = git(repo, "rev-parse", "main")
        copy_before = git(repo, "rev-parse", copy.branch)
        landed = worktrees.land(copy, "Eden Code: t")
        assert not landed.ok and "a.txt" in landed.message, landed.message
        assert "Resolve in session" in landed.message
        assert git(repo, "rev-parse", "main") == main_before
        assert git(repo, "rev-parse", copy.branch) == copy_before  # nothing committed in it
        assert "<<<<<<<" not in (repo / "a.txt").read_text()


def test_land_refuses_conflict_markers_marked_resolved_but_not_a_markdown_underline(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n2\n3\n", "README.md": "x\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("1\n<<<<<<< HEAD\ncopy\n=======\nmain\n>>>>>>> main\n3\n")
    git(co, "add", "a.txt")
    landed = worktrees.land(copy, "Eden Code: t")
    assert not landed.ok
    assert landed.message == "Conflict markers are left in a.txt; resolve them, then land."
    (co / "a.txt").write_text("1\ncopy\n3\n")
    (co / "README.md").write_text("Title\n=======\n")
    assert worktrees.land(copy, "Eden Code: t").ok
    assert (repo / "README.md").read_text() == "Title\n=======\n"


# ── CB2-3: nothing starts in a copy while it's landed; nothing written meanwhile is lost ──


def slow_hook(repo: Path, seconds: float, writes: str = "", running: Path | None = None) -> None:
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.parent.mkdir(parents=True, exist_ok=True)
    body = (f"touch '{running}'\n" if running else "") + f"sleep {seconds}\n"
    body += f"echo late > {writes}\n" if writes else ""
    hook.write_text(f"#!/bin/sh\n{body}exit 0\n")
    hook.chmod(hook.stat().st_mode | stat.S_IEXEC)


async def test_a_message_sent_while_landing_is_refused_and_nothing_written_is_lost(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(10)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    await until(lambda: not task.busy, 30)
    (task.cwd / "a.py").write_text("landed work\n")
    running = projects / "hook-running"
    slow_hook(repo, 1.5, running=running)
    landing = asyncio.ensure_future(hub.code_desk.land_now(copy))
    await until(running.exists, 60)  # committing now: its work was added
    assert copy.slug in hub.code_desk.held
    accepted = hub.tasks.send(task.id, "also add late.py")
    assert accepted is False
    assert any("being landed" in e["text"] for e in task.transcript)
    # Something in the copy writes while the commit runs (a dev server, a watcher).
    (task.cwd / "late.py").write_text("written during the landing\n")
    said = await landing
    assert "changed while it was being committed" in said and "late.py" in said
    assert (task.cwd / "late.py").exists() and copy in hub.code_desk.store().copies
    assert copy.slug not in hub.code_desk.held
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.unlink()
    said = await hub.code_desk.land_now(copy)  # landed again: all of it
    assert said.startswith("Landed"), said
    assert (repo / "late.py").read_text() == "written during the landing\n"
    assert not copy.cwd.exists()


def test_a_copy_changed_after_landing_is_kept_not_removed(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("work\n")
    assert worktrees.land(copy, "Eden Code: t").ok
    (co / "after.txt").write_text("written after the commit\n")
    with pytest.raises(worktrees.CopyError, match="after.txt changed in the copy"):
        worktrees.remove_landed(copy, tmp_path / "wt")
    assert (co / "after.txt").exists()
    (co / "after.txt").unlink()
    assert worktrees.remove_landed(copy, tmp_path / "wt") == "" and not co.exists()


def test_a_hook_that_writes_files_stops_the_landing(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("work\n")
    slow_hook(repo, 0, writes="hook-output.txt")
    before = git(repo, "rev-parse", "main")
    landed = worktrees.land(copy, "Eden Code: t")
    assert not landed.ok and "hook-output.txt" in landed.message
    assert git(repo, "rev-parse", "main") == before


# ── CB2-4: a copy off its branch ──


def test_land_refuses_a_copy_switched_to_another_branch_or_detached(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    git(co, "switch", "-q", "-c", "side")
    (co / "a.txt").write_text("side work\n")
    landed = worktrees.land(copy, "Eden Code: t")
    assert not landed.ok and landed.message.startswith(f"The copy is on side, not {copy.branch}")
    assert (co / "a.txt").read_text() == "side work\n"
    git(co, "switch", "-q", copy.branch)
    git(co, "checkout", "-q", "--detach")
    git(co, "commit", "-qam", "detached work")
    detached = git(co, "rev-parse", "HEAD").strip()
    landed = worktrees.land(copy, "Eden Code: t")
    assert not landed.ok and "HEAD is detached" in landed.message
    # And a landed copy whose HEAD isn't in the branch it landed in is never removed.
    with pytest.raises(worktrees.CopyError, match="commits that aren't in main"):
        worktrees.remove_landed(copy, tmp_path / "wt")
    assert git(co, "rev-parse", "HEAD").strip() == detached


async def test_the_git_panel_wont_switch_an_isolated_copys_branch(hub, projects):
    make_repo(projects / "proj", {"a.py": "x\n"})
    task = await isolated_session(hub)
    await until(lambda: not task.busy, 30)
    said = await hub.code_git.branch({"id": task.id, "name": "side", "create": True})
    assert said.startswith("This session works in an isolated copy")
    assert git(task.cwd, "symbolic-ref", "--short", "HEAD").strip() == task.workspace["branch"]


# ── CB2-5: a git repository of its own inside a copy ──


def test_land_refuses_a_nested_clone_and_a_committed_link_to_one(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    nested = co / "vendor" / "lib"
    nested.mkdir(parents=True)
    git(nested, "init", "-q", "-b", "main")
    (nested / "lib.py").write_text("v1\n")
    git(nested, "add", "-A")
    git(nested, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "c")
    landed = worktrees.land(copy, "x")
    assert not landed.ok and "vendor/lib is a git repository of its own" in landed.message
    assert "160000" not in git(repo, "ls-tree", "-r", "main")
    # Committed in the copy as a link (git add warns, nothing more): still refused.
    subprocess.run(["git", "-C", str(co), "add", "vendor/lib"], capture_output=True)
    git(co, "commit", "-qm", "vendor it")
    landed = worktrees.land(copy, "x")
    assert not landed.ok and "vendor/lib" in landed.message
    assert "160000" not in git(repo, "ls-tree", "-r", "main")


# ── CB2-6: reads never take index.lock ──


def test_the_git_panel_and_changes_view_never_rewrite_the_index(tmp_path):
    repo = make_repo(tmp_path / "proj", {f"f{i}.txt": "x\n" for i in range(5)})
    index = repo / ".git" / "index"
    past = time.time() - 100
    os.utime(index, (past, past))
    os.utime(repo / "f1.txt", None)  # stat-dirty: git status would refresh the index
    assert code_changes._ENV["GIT_OPTIONAL_LOCKS"] == "0"
    found = code_git.state(repo)
    assert found["repo"] and found["unstaged"] == []
    assert index.stat().st_mtime == pytest.approx(past, abs=1)
    # Nor does the Changes view's git diff (its own auto-refresh of the index).
    (repo / "f2.txt").write_text("changed\n")
    view = code_changes.session_view(repo, [], scoped=False)
    assert [f.path for f in view.files] == ["f2.txt"]  # (f1, only touched, isn't a change)
    assert index.stat().st_mtime == pytest.approx(past, abs=1)
    # With the owner's index.lock held, the panel's status still answers.
    (repo / ".git" / "index.lock").write_text("")
    assert code_git.state(repo)["repo"] and (repo / ".git" / "index.lock").exists()


# ── CB2-8: huge tracked files are listed, never diffed ──


def test_a_huge_tracked_file_is_listed_not_diffed(tmp_path, monkeypatch):
    monkeypatch.setattr(code_changes, "PATCH_BYTES", 50_000)
    big = "".join(f"line {i:07d} of a big text file\n" for i in range(4000))  # 140 KB
    repo = make_repo(tmp_path / "proj", {"big.txt": big, "a.txt": "1\n", "gone.txt": big})
    (repo / "big.txt").write_text(big.upper())
    (repo / "a.txt").write_text("2\n")
    (repo / "gone.txt").write_text("cut down\n")  # big before, small now: still big
    view = code_changes.session_view(repo, [], scoped=False)
    by = {f.path: f for f in view.files}
    assert by["big.txt"].big and by["big.txt"].binary and not by["big.txt"].hunks
    assert by["gone.txt"].big and not by["gone.txt"].hunks
    assert not by["a.txt"].big and by["a.txt"].added == 1
    shown = code_changes.public(view)
    assert {f["path"]: f["big"] for f in shown["files"]} == {
        "big.txt": True, "gone.txt": True, "a.txt": False
    }  # fmt: skip
    git(repo, "add", "-A")
    staged = code_git.files_public(repo, ["big.txt", "a.txt"], True)
    assert staged["big.txt"]["big"] and staged["big.txt"]["hunks"] == []
    assert staged["a.txt"]["added"] == 1


# ── CB2-10: two undos in one file at once ──


def test_two_undos_in_one_file_at_once_both_take_effect(tmp_path, monkeypatch):
    body = numbered(60)
    repo = make_repo(tmp_path / "p", {"a.txt": body})
    new = body.replace("line 5\n", "CHANGED 5\n").replace("line 50\n", "CHANGED 50\n")
    (repo / "a.txt").write_text(new)
    v1 = code_changes.session_view(repo, [], scoped=False)
    v2 = code_changes.session_view(repo, [], scoped=False)
    real = code_changes.git
    both = threading.Barrier(2)
    guard = threading.Lock()
    running = {"now": 0, "most": 0}

    def applying(cwd, *args, **kw):
        if args[:2] != ("apply", "-R") or "--check" in args or "--cached" in args:
            return real(cwd, *args, **kw)
        try:  # the two undos' rewrites of the file, started together if they can be
            both.wait(timeout=1.0)
        except threading.BrokenBarrierError:
            pass
        with guard:
            running["now"] += 1
            running["most"] = max(running["most"], running["now"])
        time.sleep(0.05)
        try:
            return real(cwd, *args, **kw)
        finally:
            with guard:
                running["now"] -= 1

    monkeypatch.setattr(code_changes, "git", applying)
    said = [None, None]

    def run(k, view, h):
        said[k] = code_changes.undo_hunk(view.repo, view.files[0], h)

    a = threading.Thread(target=run, args=(0, v1, v1.files[0].hunks[0]))
    b = threading.Thread(target=run, args=(1, v2, v2.files[0].hunks[1]))
    a.start(), b.start()
    a.join(), b.join()
    assert running["most"] == 1  # one rewrite of the file at a time
    assert said == ["", ""] and (repo / "a.txt").read_text() == body


# ── CB2-11 and CB2-16: a session's own changes, whatever the spelling ──


def test_a_decomposed_file_name_is_still_the_sessions_own(tmp_path):
    repo = make_repo(tmp_path / "proj", {"x.txt": "x\n"})
    nfd = unicodedata.normalize("NFD", "résumé.txt")
    (repo / nfd).write_text("a\nb\nc\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "s")
    (repo / nfd).write_text("a\nB changed by session\nc\n")
    mark = code_changes.EditMark(
        str(repo / nfd), "", frozenset({"B changed by session"}), frozenset({"b"})
    )
    view = code_changes.session_view(repo, [mark], scoped=True)
    assert [unicodedata.normalize("NFC", f.path) for f in view.files] == ["résumé.txt"]
    new = unicodedata.normalize("NFD", "nouveaú.py")
    (repo / new).write_text("x = 1\n")
    wrote = code_changes.EditMark(str(repo / new), "", frozenset({"x = 1"}), frozenset(), True)
    view = code_changes.session_view(repo, [wrote], scoped=True)
    assert [unicodedata.normalize("NFC", f.path) for f in view.files] == ["nouveaú.py"]


def test_a_latin1_line_the_session_edited_is_its_own(tmp_path):
    repo = make_repo(tmp_path / "proj", {"x.txt": "x\n"})
    (repo / "l.txt").write_bytes("".join(f"caf\xe9 {i}\n" for i in range(1, 9)).encode("latin-1"))
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "s")
    data = (repo / "l.txt").read_bytes().replace("caf\xe9 4\n".encode("latin-1"), b"tea 4\n")
    (repo / "l.txt").write_bytes(data)
    for took in ("café 4", "caf� 4"):  # as the session read it, either way
        mark = code_changes.EditMark(
            str(repo / "l.txt"), "", frozenset({"tea 4"}) - {"tea 4"}, frozenset({took})
        )
        view = code_changes.session_view(repo, [mark], scoped=True)
        assert [f.path for f in view.files] == ["l.txt"], took


# ── CB2-12 and CB2-13: the Git panel ──


async def test_a_busy_session_in_a_subfolder_blocks_a_branch_switch(hub, projects):
    repo = make_repo(projects / "proj", {"sub/a.py": "x\n"})
    git(repo, "branch", "other")
    task = session(hub, (repo / "sub").resolve(), id=5)
    task.kind, task.busy = "code", True
    said = await hub.code_git.branch({"directory": "proj", "name": "other"})
    assert said.startswith("A session is working in this folder")
    assert git(repo, "symbolic-ref", "--short", "HEAD").strip() == "main"


def test_the_panel_says_a_rebase_is_under_way_and_land_says_main_is_mid_merge(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n2\n3\n", "b.txt": "b\n"})
    git(repo, "switch", "-q", "-c", "topic")
    (repo / "a.txt").write_text("1\ntopic\n3\n")
    git(repo, "commit", "-qam", "t")
    git(repo, "switch", "-q", "main")
    (repo / "a.txt").write_text("1\nmain\n3\n")
    git(repo, "commit", "-qam", "m")
    git(repo, "switch", "-q", "topic")
    subprocess.run(["git", "-C", str(repo), "rebase", "main"], capture_output=True)
    found = code_git.state(repo)
    assert found["rebasing"] and not found["merging"] and not found["cherry_picking"]
    git(repo, "rebase", "--abort")
    git(repo, "switch", "-q", "main")
    copy = new_copy(repo, tmp_path / "wt")
    (Path(copy.checkout) / "b.txt").write_text("copy\n")
    subprocess.run(["git", "-C", str(repo), "merge", "topic"], capture_output=True)
    landed = worktrees.land(copy, "x")
    assert landed.message == "main is in the middle of a merge; finish it, then land."
    assert code_git.state(repo)["merging"]


# ── CB2-14: Land's secret scan has an upper bound and says when it's only partly done ──


async def test_lands_secret_scan_is_bounded_and_says_so(hub, projects, monkeypatch):
    from jarvis.features import code_isolation

    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    await until(lambda: not task.busy, 30)
    for i in range(3):
        (task.cwd / f"n{i}.py").write_text(f"n = {i}\n")
    monkeypatch.setattr(code_isolation, "SCAN_SECONDS", 0.0)
    hub.answers = ["deny"]
    assert await hub.code_desk.land(copy.slug) == "Not landed."
    card = hub.cards[-1]
    assert "Only part of the work was checked for secrets (0 of 3 files)" in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Land anyway", "Don't land"]


# ── CB2-15: a recovery ref is dated when it was discarded ──


def test_a_discard_with_nothing_new_is_dated_now_and_comes_back_as_it_was(tmp_path):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    copy = new_copy(repo, tmp_path / "wt")
    co = Path(copy.checkout)
    (co / "a.txt").write_text("old work\n")
    old = {"GIT_COMMITTER_DATE": "2026-01-01T00:00:00", "GIT_AUTHOR_DATE": "2026-01-01T00:00:00"}
    subprocess.run(["git", "-C", str(co), "commit", "-qam", "old"], check=True,
                   env={**os.environ, **old})  # fmt: skip
    head = git(co, "rev-parse", "HEAD").strip()
    item = worktrees.discard(copy, tmp_path / "wt")
    when = int(git(repo, "log", "-1", "--format=%ct", item["ref"]).strip())
    assert when > time.time() - 600  # (the sweeper goes by this once reflogs are gone)
    back = worktrees.restore(item, tmp_path / "wt", set())
    assert git(Path(back.checkout), "rev-parse", "HEAD").strip() == head


# ── CB2-9 and CB2-17: pull request follow-ups ──


async def test_a_follow_up_on_another_branch_is_never_pushed(hub, tmp_path, projects):
    repo, _bare = github_project(tmp_path, projects)
    git(repo, "push", "-q", "-u", "origin", "feature/login")
    task = session(hub, repo)
    rec = watched(hub, repo, followup="fix")
    git(repo, "switch", "-q", "-c", "unrelated-work")
    (repo / "b.py").write_text("y = 'the fix, on the wrong branch'\n")
    git(repo, "commit", "-qam", "fix")
    said = await hub.code_pr.after_follow_up(rec, task)
    assert "is on unrelated-work, not the pull request's branch feature/login" in said
    assert hub.cards == []  # no push card
    assert any("unrelated-work" in a.text for a in hub.alerts)


async def test_a_fix_that_made_no_commit_says_so_whatever_githubs_head_is(
    hub, tmp_path, projects, monkeypatch
):
    repo, _bare = github_project(tmp_path, projects)
    git(repo, "push", "-q", "-u", "origin", "feature/login")
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo)  # GitHub's head ("head1") isn't the folder's HEAD
    await hub.code_pr.poll(rec)
    hub.fake.run("head1", "tests", conclusion="failure")
    await hub.code_pr.poll(rec)
    assert len(sent) == 1 and rec.fix_attempts == 1
    before = len(hub.alerts)
    await hub.code_pr.after_follow_up(rec, task)  # the turn ended with no new commit
    assert any("made no new commit" in a.text for a in hub.alerts[before:])


async def test_refresh_while_a_push_card_is_up_says_why_it_waits(hub, tmp_path, projects):
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    async with hub.code_pr.lock(rec.key):
        hub.code_pr.cmd_refresh({"id": task.id})
        await asyncio.sleep(0)
    captions = [e["text"] for e in events(hub, "caption")]
    assert "Pull request #7 waits on your answer to its push card first." in captions


# ── latency: one diff per Git panel refresh, however many files are open ──


async def test_open_files_are_shown_again_from_one_diff(hub, projects, monkeypatch):
    repo = make_repo(projects / "proj", {"a.py": "a\n", "b.py": "b\n", "c.py": "c\n"})
    for name in ("a.py", "b.py", "c.py"):
        (repo / name).write_text(name.upper() + "\n")
    calls = []
    real = code_changes.diff_files
    monkeypatch.setattr(
        code_changes, "diff_files", lambda *a, **k: calls.append(1) or real(*a, **k)
    )
    await hub.code_git.file(
        {"directory": "proj", "path": "a.py", "paths": ["a.py", "b.py", "c.py"], "staged": False}
    )
    shown = events(hub, "code_git_file")
    assert len(calls) == 1 and [e["path"] for e in shown] == ["a.py", "b.py", "c.py"]
    assert all(e["file"]["added"] == 1 for e in shown)
