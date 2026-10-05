"""Isolated copies (worktrees.py and features/code_isolation.py): a session in a git
worktree of its own, made on request, offered when another session is working in the
folder, found again on resume; landed (fast-forward, merge commit, conflicts), discarded
with a recovery ref and brought back; and the sweeper, which removes only spent copies.
Real git in temp repositories; fake Claude Code sessions."""

import asyncio
import subprocess
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest
from test_code_changes import Session, git, make_repo, numbered

from jarvis import code_changes, worktrees


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def answer(hub, *choices):
    """Answer each card as it goes up, in order; the cards are kept on hub.cards."""
    hub.cards = []
    queue = list(choices)

    def sink(card):
        hub.cards.append(card)
        if queue:
            hub.resolve(card["id"], queue.pop(0))

    hub.add_approval_sink(sink)


async def until(condition, seconds=60.0):
    """Whether condition() comes true within seconds. A session's copy is a real git
    worktree: a Mac busy with other test runs can take many seconds; it returns as soon as
    the condition holds."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


async def isolated_session(hub, name="proj", prompt=""):
    task = hub.tasks.start(prompt, name, isolate=True, title="fix the login")
    # (A real git worktree add: on a Mac busy with other test runs it can take seconds.)
    made = await until(lambda: task.workspace and task.client is not None, seconds=120.0)
    assert made, task.transcript
    return task


def copy_of(hub, task):
    return hub.code_desk.store().find(task.workspace["slug"])


# ── making one ──


async def test_an_isolated_session_runs_in_its_own_copy_on_its_own_branch(hub, projects, tmp_path):
    repo = make_repo(projects / "proj", {"a.py": numbered(20)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    root = tmp_path / "worktrees"
    assert task.cwd == copy.cwd and root in task.cwd.parents
    assert task.cwd.name == "proj"  # labels, grouping and approvals still name the project
    assert copy.branch.startswith("jarvis/fix-the-login-") and copy.into == "main"
    assert root.stat().st_mode & 0o777 == 0o700  # only the owner opens the copies (and their .env)
    assert copy.base == git(repo, "rev-parse", "HEAD").strip()
    assert task.workspace == {
        "slug": copy.slug,
        "branch": copy.branch,
        "base": copy.base,
        "into": "main",
    }
    assert task.public()["workspace"] == {"slug": copy.slug, "branch": copy.branch, "into": "main"}
    # Its edits happen in the copy; the main folder doesn't change.
    (task.cwd / "a.py").write_text("changed\n")
    assert (repo / "a.py").read_text() == numbered(20)
    assert any("isolated copy on jarvis/" in e["text"] for e in task.transcript)
    # The folder is one a session may run in, as a project folder is; nothing else there is.
    assert hub.tasks.resolve_dir(str(task.cwd)) == task.cwd.resolve()
    with pytest.raises(ValueError):
        hub.tasks.resolve_dir(str(root / "proj"))


async def test_a_folder_that_cant_be_copied_says_why_and_the_session_still_works(hub, projects):
    (projects / "plain").mkdir()
    task = hub.tasks.start("", "plain", isolate=True)
    assert await until(lambda: task.client is not None)
    assert not task.workspace and task.cwd == (projects / "plain").resolve()
    assert any("isn't a git repository" in e["text"] for e in task.transcript)


async def test_the_default_setting_and_the_offer_when_another_session_is_working(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    shared = hub.tasks.start("", "proj")
    assert await until(lambda: shared.client is not None)
    assert not shared.workspace  # off by default
    shared.busy = True  # at work in the folder
    answer(hub, "share", "isolate")
    second = hub.tasks.start("", "proj")
    assert await until(lambda: second.client is not None)
    assert not second.workspace and "Another session is working in proj" in hub.cards[0]["question"]
    third = hub.tasks.start("", "proj")
    assert await until(lambda: third.client is not None and third.workspace)
    shared.busy = False
    hub.set_feature_prefs({"code_isolate_default": True})
    fourth = hub.tasks.start("", "proj")
    assert await until(lambda: fourth.client is not None and fourth.workspace)
    assert len(hub.cards) == 2  # the default needs no card
    fifth = hub.tasks.start("", "proj", isolate=False)  # the switch, turned off
    assert await until(lambda: fifth.client is not None)
    assert not fifth.workspace


async def test_a_resumed_session_goes_back_into_its_copy(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub, prompt="look around")
    assert await until(lambda: task.session_id == "s")  # its first turn is over
    copy = copy_of(hub, task)
    hub.code_desk.note_sessions()
    assert copy.sessions == ["s"]
    task.handle.cancel()
    await until(lambda: task.handle.done())
    del hub.tasks.tasks[task.id]  # (after a restart, it's not on the list)
    again = hub.tasks.start("", "proj", resume="s")
    assert await until(lambda: again.client is not None)
    assert again.cwd == copy.cwd and again.workspace["slug"] == copy.slug
    assert again.client.options.cwd == str(copy.cwd)


# ── landing ──


async def test_landing_fast_forwards_the_branch_and_removes_the_copy(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    s = Session(hub.tasks, task.cwd, task=task)
    s.turn("u-1")
    s.edit(task.cwd / "a.py", "line 3\n", "line three\n")
    (task.cwd / "new.py").write_text("print('new')\n")
    answer(hub, "land")
    said = await hub.code_desk.land(copy.slug)
    assert said == f"Landed {copy.branch} in main (fast-forward)."
    assert "line three" in (repo / "a.py").read_text() and (repo / "new.py").exists()
    assert git(repo, "log", "-1", "--format=%s").strip() == "Jarvis Code: fix the login"
    assert git(repo, "status", "--porcelain") == ""
    assert not Path(copy.checkout).exists() and not copy.folder.exists()
    assert git(repo, "branch", "--list", copy.branch).strip() == ""
    assert hub.code_desk.store().copies == []
    assert await until(lambda: task.handle.done())  # its session ended with it
    card = hub.cards[0]
    assert card["question"] == f"Land {copy.branch} in main?"
    assert "2 files changed, +2 −1" in card["detail"]


async def test_landing_after_main_moved_on_makes_a_merge_commit(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20), "b.py": "b\n"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text(numbered(20).replace("line 2\n", "copy's line\n"))
    (repo / "b.py").write_text("main's b\n")
    git(repo, "commit", "-qam", "meanwhile on main")
    tip = git(repo, "rev-parse", "HEAD").strip()
    answer(hub, "land")
    assert (await hub.code_desk.land(copy.slug)).endswith("(a merge commit).")
    parents = git(repo, "log", "-1", "--format=%P").split()
    assert parents[0] == tip and len(parents) == 2  # main's history comes first
    assert (
        "copy's line" in (repo / "a.py").read_text() and (repo / "b.py").read_text() == "main's b\n"
    )


async def test_a_conflict_changes_nothing_and_goes_back_to_the_session(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text(numbered(20).replace("line 5\n", "the copy's\n"))
    (repo / "a.py").write_text(numbered(20).replace("line 5\n", "main's\n"))
    git(repo, "commit", "-qam", "main's version")
    tip = git(repo, "rev-parse", "HEAD").strip()
    answer(hub, "land")
    said = await hub.code_desk.land(copy.slug)
    assert said == f"Landing {copy.branch} in main hits conflicts in a.py."
    assert git(repo, "rev-parse", "HEAD").strip() == tip and "main's" in (repo / "a.py").read_text()
    assert Path(copy.checkout).exists() and hub.code_desk.conflicts[copy.slug] == ["a.py"]
    assert await hub.code_desk.resolve(copy.slug) == "Sent the conflicts to the session."
    assert await until(lambda: task.client.queries)
    assert (
        "hits conflicts in a.py" in task.client.said[-1]
        and "git merge main" in task.client.said[-1]
    )


async def test_landing_never_overwrites_uncommitted_work_in_the_main_folder(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text(numbered(20).replace("line 5\n", "the copy's\n"))
    (repo / "a.py").write_text(numbered(20).replace("line 18\n", "owner, uncommitted\n"))
    answer(hub, "land")
    said = await hub.code_desk.land(copy.slug)
    assert "uncommitted changes in a.py" in said
    assert "owner, uncommitted" in (repo / "a.py").read_text()
    assert Path(copy.checkout).exists()  # nothing was removed


async def test_landing_asks_first_and_shows_secrets_it_would_commit(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "config.py").write_text('AWS = "AKIAIOSFODNN7EXAMPLF"\n')
    answer(hub, "deny")
    assert await hub.code_desk.land(copy.slug) == "Not landed."
    card = hub.cards[0]
    assert [c["label"] for c in card["choices"]] == ["Land anyway", "Don't land"]
    assert "AWS access key in config.py line 1 (AKIA…LF)" in card["detail"]
    assert "AKIAIOSFODNN7EXAMPLF" not in card["detail"]
    assert Path(copy.checkout).exists() and git(repo, "log", "--oneline").count("\n") == 1


async def test_a_busy_session_is_never_landed_or_discarded_under_it(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub)
    task.busy = True
    slug = task.workspace["slug"]
    assert (await hub.code_desk.land(slug)).startswith("It's still working")
    assert (await hub.code_desk.discard(slug)).startswith("It's still working")
    task.busy = False


# ── discarding, and bringing back ──


async def test_discarding_keeps_everything_for_thirty_days_and_restore_brings_it_back(
    hub, projects
):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text("x = 2\n")  # uncommitted
    (task.cwd / "notes.md").write_text("todo\n")  # untracked
    answer(hub, "discard")
    said = await hub.code_desk.discard(copy.slug)
    assert said == f"Discarded {copy.branch}; its work is kept for 30 days."
    ref = f"refs/jarvis/trash/{copy.slug}"
    assert git(repo, "show", f"{ref}:a.py") == "x = 2\n"
    assert git(repo, "show", f"{ref}:notes.md") == "todo\n"
    assert not Path(copy.checkout).exists() and git(repo, "branch", "--list", copy.branch) == ""
    assert (repo / "a.py").read_text() == "x = 1\n"
    assert await until(lambda: task.handle.done())
    assert "kept for 30 days" in hub.cards[0]["detail"]
    said = await hub.code_desk.restore(copy.slug)
    back = hub.code_desk.store().copies[0]
    assert said == f"Brought it back as {back.branch}." and back.branch != copy.branch
    assert (back.cwd / "a.py").read_text() == "x = 2\n" and (back.cwd / "notes.md").exists()
    assert git(repo, "for-each-ref", "refs/jarvis/trash/") == ""
    assert hub.code_desk.store().trash == []


async def test_keeping_it_after_all_changes_nothing(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    task = await isolated_session(hub)
    answer(hub, "deny")
    assert await hub.code_desk.discard(task.workspace["slug"]) == "Kept."
    assert task.cwd.exists() and not task.handle.done()


# ── the sweeper ──


async def test_the_sweeper_removes_only_spent_copies_and_lists_the_rest(hub, projects, tmp_path):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    desk = hub.code_desk
    store = desk.store()
    root = desk.root
    spent, _ = worktrees.create(repo, root, "spent", taken=store.slugs())
    worked, _ = worktrees.create(repo, root, "worked", taken=store.slugs())
    committed, _ = worktrees.create(repo, root, "committed", taken=store.slugs())
    store.copies += [spent, worked, committed]
    (worked.cwd / "a.py").write_text("x = 2\n")
    (committed.cwd / "b.py").write_text("b\n")
    git(committed.cwd, "add", "-A")
    git(committed.cwd, "commit", "-qm", "unlanded")
    live = await isolated_session(hub)  # a copy with a session in it: never touched
    (live.cwd / "a.py").write_text("x = 3\n")
    # A copy on disk the list lost, with work in it.
    lost = root / "proj" / "lost-0a0a" / "proj"
    git(repo, "worktree", "add", "-q", "-b", "jarvis/lost-0a0a", str(lost))
    (lost / "a.py").write_text("lost work\n")
    # Recovery refs: one past thirty days, on the list and off it.
    old = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "update-ref", "refs/jarvis/trash/ancient", old)
    store.trash.append(
        {"slug": "ancient", "repo": str(repo), "ref": "refs/jarvis/trash/ancient", "at": 1.0}
    )
    env = {**subprocess.os.environ, "GIT_COMMITTER_DATE": "2001-01-01T00:00:00"}
    tree = git(repo, "rev-parse", "HEAD^{tree}").strip()
    stale = subprocess.run(
        ["git", "-C", str(repo), "commit-tree", tree, "-m", "old"],
        env=env,
        capture_output=True,
        text=True,
    ).stdout.strip()
    git(repo, "update-ref", "refs/jarvis/trash/forgotten", stale)
    heads_up = []
    hub.add_notify_sink(heads_up.append)
    report = await desk.sweep()
    assert report.removed == [spent.slug] and not Path(spent.checkout).exists()
    assert sorted(report.leftovers) == sorted([worked.slug, committed.slug, "lost-0a0a"])
    assert report.adopted == ["lost-0a0a"]
    assert sorted(report.expired) == ["ancient", "forgotten"]
    assert git(repo, "for-each-ref", "refs/jarvis/trash/") == ""
    assert Path(worked.checkout).exists() and (worked.cwd / "a.py").read_text() == "x = 2\n"
    assert (lost / "a.py").read_text() == "lost work\n" and (
        live.cwd / "a.py"
    ).read_text() == "x = 3\n"
    assert (
        len(heads_up) == 1 and "3 isolated copies have work that isn't landed" in heads_up[0].text
    )
    await desk.sweep()
    assert len(heads_up) == 1  # said once, not every day
    copies = [d for k, d in hub.events if k == "code_copies"][-1]["copies"]
    listed = {c["slug"]: c for c in copies}
    assert listed[worked.slug]["leftover"] and listed[worked.slug]["state"]["dirty"] == 1
    assert (
        listed[committed.slug]["state"]["ahead"] == 1
        and not listed[live.workspace["slug"]]["leftover"]
    )


async def test_the_sweeper_keeps_a_spent_copy_a_session_is_resumed_in_while_it_runs(
    hub, projects, monkeypatch
):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    desk = hub.code_desk
    store = desk.store()
    spent, _ = worktrees.create(repo, desk.root, "spent", taken=store.slugs())
    store.copies.append(spent)
    looking, go_on = threading.Event(), threading.Event()
    real_state = worktrees.state

    def slow_state(copy):  # the sweep has found it spent, with no session in it…
        found = real_state(copy)
        looking.set()
        go_on.wait(30)
        return found

    monkeypatch.setattr(worktrees, "state", slow_state)
    sweep = asyncio.ensure_future(desk.sweep())
    try:
        assert await until(looking.is_set, 10)
        # …when the owner opens a session in it from the Copies pane.
        task = hub.tasks.start("", str(spent.cwd), title="spent")
        assert await until(lambda: task.workspace and task.client is not None)
    finally:
        go_on.set()
        report = await sweep
    assert report.removed == [] and spent.cwd.is_dir() and store.find(spent.slug) is spent
    assert not desk.going


async def test_no_session_is_moved_into_a_copy_while_the_sweeper_removes_it(
    hub, projects, monkeypatch
):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    desk = hub.code_desk
    store = desk.store()
    spent, _ = worktrees.create(repo, desk.root, "spent", taken=store.slugs())
    store.copies.append(spent)
    removing, go_on = threading.Event(), threading.Event()
    real_remove = worktrees.remove

    def slow_remove(copy, root, force=True):
        removing.set()
        go_on.wait(30)
        return real_remove(copy, root, force)

    monkeypatch.setattr(worktrees, "remove", slow_remove)
    sweep = asyncio.ensure_future(desk.sweep())
    try:
        assert await until(removing.is_set, 10)
        task = hub.tasks.start("", str(spent.cwd), title="spent")
        await asyncio.sleep(0.2)
        assert not task.workspace  # it waits for the sweep to be done
    finally:
        go_on.set()
        report = await sweep
    assert report.removed == [spent.slug] and not spent.cwd.exists()
    assert await until(lambda: task.id in desk.prepared and task.client is not None, 10)
    assert not task.workspace and spent.slug not in desk.bound.values()


async def test_work_written_after_the_sweeper_looked_keeps_the_copy(hub, projects, monkeypatch):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    desk = hub.code_desk
    store = desk.store()
    written, _ = worktrees.create(repo, desk.root, "written", taken=store.slugs())
    committed, _ = worktrees.create(repo, desk.root, "committed", taken=store.slugs())
    store.copies += [written, committed]
    real_state = worktrees.state

    def then_worked(copy):  # found spent; then something is written, or committed, in it
        found = real_state(copy)
        if (copy.cwd / "notes.md").exists():
            return found  # (looked at again for the Copies pane)
        (copy.cwd / "notes.md").write_text("half a plan\n")
        if copy is committed:
            git(copy.cwd, "add", "-A")
            git(copy.cwd, "commit", "-qm", "a plan")
        return found

    monkeypatch.setattr(worktrees, "state", then_worked)
    report = await desk.sweep()
    assert report.removed == [] and sorted(report.leftovers) == sorted(
        [written.slug, committed.slug]
    )
    assert (written.cwd / "notes.md").read_text() == "half a plan\n"
    assert git(repo, "log", "-1", "--format=%s", committed.branch).strip() == "a plan"
    assert store.find(written.slug) is written and store.find(committed.slug) is committed


def test_a_copy_being_made_is_never_taken_in_as_one_the_list_lost(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "proj", {"a.py": "x = 1\n"})
    root = tmp_path / "worktrees"
    store = worktrees.CopyStore(tmp_path / "code_copies.json")
    copy, _ = worktrees.create(repo, root, "new work", taken=set(), making=store.making)
    # Made, and not on the list yet: the feature puts it there once create returns.
    assert copy.slug in store.making
    assert worktrees.adopt(store, root) == [] and store.copies == []
    # One whose session went away while it was made never goes on the list that way: in
    # time it's taken in as a copy the list lost.
    monkeypatch.setattr(worktrees, "MAKING_SECONDS", 0)
    assert worktrees.adopt(store, root) == [copy.slug] and copy.slug not in store.making
    # One that couldn't be made isn't left as being made.
    monkeypatch.setattr(worktrees, "slug_for", lambda title, taken: "taken-0000")
    (root / "proj" / "taken-0000").mkdir(parents=True)
    making = {}
    with pytest.raises(worktrees.CopyError):
        worktrees.create(repo, root, "x", taken=set(), making=making)
    assert making == {}


# ── what a copy starts with ──


async def test_env_files_are_copied_only_with_the_projects_opt_in_and_only_when_ignored(
    hub, projects
):
    repo = make_repo(projects / "proj", {".gitignore": ".env\n", "a.py": "x\n"})
    (repo / ".env").write_text("TOKEN=abc\n")
    (repo / ".envrc").write_text("export X=1\n")  # direnv runs it: never copied
    task = await isolated_session(hub)
    assert not (task.cwd / ".env").exists()  # no opt-in
    hub.set_feature_prefs({"code_iso_env": ["proj"]})
    second = await isolated_session(hub)
    assert (second.cwd / ".env").read_text() == "TOKEN=abc\n"
    assert not (second.cwd / ".envrc").exists()
    assert git(second.cwd, "status", "--porcelain") == ""
    assert any("Copied .env" in e["text"] for e in second.transcript)


def test_dependencies_are_linked_where_git_ignores_the_link(tmp_path):
    root = tmp_path / "worktrees"
    plain = make_repo(tmp_path / "plain", {".gitignore": "node_modules\n.venv\n", "a.py": "x\n"})
    (plain / "node_modules" / "left-pad").mkdir(parents=True)
    (plain / ".venv" / "bin").mkdir(parents=True)
    copy, notes = worktrees.create(plain, root, "deps", taken=set(), link_deps=True)
    assert (copy.cwd / "node_modules").resolve() == (plain / "node_modules").resolve()
    assert (copy.cwd / ".venv").is_symlink()
    assert git(copy.cwd, "status", "--porcelain") == ""
    assert notes == [
        "Linked node_modules from the main folder (shared with it).",
        "Linked .venv from the main folder (shared with it).",
    ]
    slashed = make_repo(
        tmp_path / "slashed", {".gitignore": "node_modules/\n.venv/\n", "a.py": "x\n"}
    )
    (slashed / "node_modules").mkdir()
    (slashed / ".venv").mkdir()
    copy, notes = worktrees.create(slashed, root, "deps", taken=set(), link_deps=True)
    assert not (copy.cwd / "node_modules").exists()  # git would see a link there as a file
    assert (copy.folder / "node_modules").resolve() == (slashed / "node_modules").resolve()
    assert not (copy.cwd / ".venv").exists()
    assert notes[-1] == ".venv isn't linked: git would see the link as a new file."
    assert git(copy.cwd, "status", "--porcelain") == ""


def test_a_damaged_list_is_never_saved_over_and_odd_records_are_skipped(tmp_path):
    path = tmp_path / "code_copies.json"
    path.write_text(
        '{"copies": [{"slug": "ok-1234", "project": "p", "repo": "/r", "prefix": "", '
        '"checkout": "/r2", "branch": "jarvis/ok-1234", "base": "abc", "into": "main"}, '
        '{"slug": "../../evil", "project": "p", "repo": "/r", "prefix": "", "checkout": "/x", '
        '"branch": "b", "base": "c", "into": "m"}, 7, {"slug": "nope"}], "trash": [1, {"slug": "t"}]}'
    )
    store = worktrees.CopyStore(path)
    assert [c.slug for c in store.copies] == ["ok-1234"] and store.trash == []


def test_state_counts_whats_in_a_copy(tmp_path):
    repo = make_repo(tmp_path / "r", {"a.py": numbered(10)})
    copy, _ = worktrees.create(repo, tmp_path / "w", "s", taken=set())
    first = worktrees.state(copy)
    assert first.spent and first.exists and first.dirty == 0
    (copy.cwd / "a.py").write_text(numbered(10).replace("line 1\n", "one\n"))
    (copy.cwd / "c.py").write_text("c\n")
    git(copy.cwd, "mv", "a.py", "b.py")
    found = worktrees.state(copy)
    assert found.dirty == 2 and not found.spent  # a rename is one entry, not two
    assert worktrees.commit_all(copy, "work") == ""
    after = worktrees.state(copy)
    assert after.dirty == 0 and after.ahead == 1 and not after.merged and not after.spent
    assert code_changes.head_commit(Path(copy.checkout)) != copy.base
    assert time.time() - copy.created < 60


async def test_cards_and_captions_are_in_chinese_when_the_owner_speaks_chinese(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    hub.set_prefs({"language": "zh"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    (task.cwd / "a.py").write_text("x = 2\n")
    answer(hub, "deny")
    said = await hub.code_desk.land(copy.slug)
    card = hub.cards[0]
    assert card["question"] == f"要把 {copy.branch} 合并进 main 吗？"
    assert card["detail"].startswith("改动了 1 个文件，+1 −1。")
    assert [c["label"] for c in card["choices"]] == ["合并", "暂不"]
    assert said == "Not landed."  # (what the window shows goes through caption())
    hub.code_desk.caption(said)
    assert ("caption", {"text": "没有合并。"}) in hub.events


def test_a_feature_adds_its_sentences_to_the_translations_without_replacing_the_cores():
    from jarvis import lang

    assert lang.translate("Landed jarvis/fix-1a2b in main (fast-forward).", "zh") == (
        "已把 jarvis/fix-1a2b 合并进 main（快进）。"
    )
    assert lang.translate("Discard the isolated copy jarvis/x-0000?", "zh") == (
        "要丢弃独立副本 jarvis/x-0000 吗？"
    )
    core = lang.ZH_TEXTS["Opening {app}."]
    lang.add_texts(
        {"Opening {app}.": "别的", "A brand new sentence only here.": "只在这里的新句子。"}
    )
    assert lang.ZH_TEXTS["Opening {app}."] == core
    assert lang.translate("A brand new sentence only here.", "zh") == "只在这里的新句子。"
    lang.ZH_TEXTS.pop("A brand new sentence only here.")
