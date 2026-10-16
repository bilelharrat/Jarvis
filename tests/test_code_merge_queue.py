"""The merge queue (features/code_merge_queue.py): isolated copies and pull requests landed
one at a time, in risk order, each brought onto the newest tip and tested first; a conflict
or failing tests sent back to the owning session (or marked for the owner); the turn holds
of code_isolation's landing kept from the first step to the last; pause, reorder, remove.

Real git in temp repositories (a pull request's origin is a local bare repository behind
url.insteadOf, as in test_code_stack); GitHub is tests/github_fakes.py; the project's tests
are a stand-in. No model is called."""

import subprocess
from dataclasses import replace
from pathlib import Path

import pytest
from github_fakes import FakeGitHub
from test_code_changes import git, make_repo

from jarvis import code_prs, github, worktrees
from jarvis.features import code_merge_queue as mq
from jarvis.tasks import ClaudeTask


@pytest.fixture(autouse=True)
def _no_real_gh(monkeypatch):
    monkeypatch.setattr(github.shutil, "which", lambda _name: None)


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
    hub.cards, hub.answers, hub.alerts = [], [], []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    hub.add_notify_sink(lambda alert: hub.alerts.append(alert))
    hub.fake = FakeGitHub()
    hub.code_pr._client = github.Client(lambda: "tok", transport=hub.fake.transport())
    hub.tested = []

    async def tests_pass(folder):
        hub.tested.append((Path(folder), dict(hub.code_desk.landing)))
        return {"status": "passed", "summary": "1 passed"}

    hub.code_mq.run_tests = tests_pass
    yield hub
    await hub.code_pr.client.aclose()


def copy_with(hub, repo, title, files):
    """An isolated copy of repo (no session in it), with files written in it, uncommitted."""
    desk = hub.code_desk
    store = desk.store()
    copy, _notes = worktrees.create(
        repo, desk.root, title, taken=store.slugs(), making=store.making
    )
    store.copies.append(copy)
    store.making.pop(copy.slug, None)
    for name, text in files.items():
        (Path(copy.checkout) / name).parent.mkdir(parents=True, exist_ok=True)
        (Path(copy.checkout) / name).write_text(text)
    return copy


async def queue(hub, kind, ref):
    hub.answers.append("queue")
    return await hub.code_mq.add(kind, ref)


def items(hub):
    return hub.code_mq.items


# ── the order ──


def test_risk_puts_small_safe_changes_first_and_test_changes_later():
    small, _ = mq.risk_of(["src/a.py"], 3, 1)
    tests, why = mq.risk_of(["src/a.py", "tests/test_a.py"], 3, 1)
    lock, why_lock = mq.risk_of(["package-lock.json"], 3, 1)
    big, _ = mq.risk_of([f"src/f{i}.py" for i in range(12)], 400, 90)
    assert small < big < tests and small < lock
    assert "touches tests" in why and "touches dependencies or CI" in why_lock
    queued = [{"state": "queued", "risk": 1.0}, {"state": "queued", "risk": 30.0, "moved": True},
              {"state": "queued", "risk": 30.0}]  # fmt: skip
    # Before the first riskier one the owner didn't place by hand.
    assert mq.insert_at(queued, 5.0) == 2
    assert mq.insert_at(queued, 0.5) == 0
    assert mq.insert_at(queued, 99.0) == 3


async def test_two_copies_land_in_risk_order_each_rebased_and_tested_first(hub, projects):
    repo = make_repo(
        projects / "app", {"a.py": "a = 1\n", "b.py": "b = 1\n", "tests/test_a.py": "x\n"}
    )
    risky = copy_with(hub, repo, "touch tests", {"a.py": "a = 2\n", "tests/test_a.py": "y\n"})
    small = copy_with(hub, repo, "small fix", {"b.py": "b = 2\n"})
    assert (await queue(hub, "copy", risky.slug)).startswith("Queued")
    said = await queue(hub, "copy", small.slug)
    assert said == "Queued small fix."
    assert hub.cards[-1]["question"] == "Land small fix in order?"
    assert (
        "place 1 of 2" in hub.cards[-1]["detail"]
    )  # (smaller: ahead of the one that touches tests)
    assert [i["ref"] for i in items(hub)] == [small.slug, risky.slug]
    assert await queue(hub, "copy", small.slug) == "It's already in the queue."

    await hub.code_mq.tick()
    assert [i["ref"] for i in items(hub)] == [risky.slug]
    assert (repo / "b.py").read_text() == "b = 2\n" and (repo / "a.py").read_text() == "a = 1\n"
    await hub.code_mq.tick()
    assert items(hub) == []
    assert (repo / "a.py").read_text() == "a = 2\n" and (repo / "b.py").read_text() == "b = 2\n"
    # Each tested in its own copy, with its turns held (landing) while it was.
    assert [f for f, _ in hub.tested] == [small.cwd, risky.cwd]
    assert all(
        slug in held for (_f, held), slug in zip(hub.tested, [small.slug, risky.slug], strict=True)
    )
    # The second was rebased onto the first: a straight line, no merge commit.
    assert git(repo, "rev-list", "--merges", "main").strip() == ""
    assert [d["state"] for d in hub.code_mq.done] == ["landed", "landed"]
    assert hub.code_desk.landing == {}


async def test_a_conflict_goes_back_to_the_session_and_comes_back_once_fixed(
    hub, projects, monkeypatch
):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n"})
    first = copy_with(hub, repo, "first", {"a.py": "a = 2\n"})
    second = copy_with(hub, repo, "second", {"a.py": "a = 3\n"})
    second.sessions = ["sess-2"]
    started = []

    def start(prompt, directory, **kw):
        started.append((prompt, directory, kw))
        return ClaudeTask(id=50, prompt=prompt, cwd=Path(directory))

    monkeypatch.setattr(hub.tasks, "start", start)
    await queue(hub, "copy", first.slug)
    await queue(hub, "copy", second.slug)
    await hub.code_mq.tick()
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "fixing" and item["conflicts"] == ["a.py"]
    assert "sent to its session" in item["note"]
    # The session that owns it is opened again with the conflict as its task.
    [(prompt, directory, kw)] = started
    assert "hits conflicts in a.py" in prompt and kw["resume"] == "sess-2"
    assert directory == str(second.cwd)
    assert (repo / "a.py").read_text() == "a = 2\n"  # nothing of the second landed
    # Its checkout is as it was (the rebase aborted), its work committed on its branch.
    assert git(Path(second.checkout), "status", "--porcelain").strip() == ""
    assert any("merge queue" in a.text for a in hub.alerts)
    # Not taken again until its branch moves: then it is, and lands.
    await hub.code_mq.tick()
    assert item["state"] == "fixing"
    git(Path(second.checkout), "merge", "-q", "main", "-X", "ours", "-m", "resolve")
    await hub.code_mq.tick()
    assert items(hub) == [] and (repo / "a.py").read_text() == "a = 3\n"


async def test_conflicts_go_to_the_owner_when_set_or_when_nobody_owns_the_copy(hub, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n"})
    first = copy_with(hub, repo, "first", {"a.py": "a = 2\n"})
    second = copy_with(hub, repo, "second", {"a.py": "a = 3\n"})  # (no session ever ran in it)
    third = copy_with(hub, repo, "third", {"a.py": "a = 4\n"})
    third.sessions = ["s3"]
    await queue(hub, "copy", first.slug)
    await queue(hub, "copy", second.slug)
    await hub.code_mq.tick()
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "owner" and "over to you" in item["note"]
    assert events_of(hub, "code_mq")[-1]["attention"] == 1
    # The setting: the owner always.
    hub.set_feature_prefs({mq.PREF_CONFLICTS: "owner"})
    hub.code_mq.act(item["id"], "remove")
    await queue(hub, "copy", third.slug)
    await hub.code_mq.tick()
    assert items(hub)[0]["state"] == "owner"


async def test_failing_tests_keep_it_from_landing(hub, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n"})
    copy = copy_with(hub, repo, "broken", {"a.py": "a = (\n"})

    async def tests_fail(folder):
        return {"status": "failed", "summary": "1 failed", "fix_message": "test_a failed"}

    hub.code_mq.run_tests = tests_fail
    await queue(hub, "copy", copy.slug)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "owner" and "tests fail" in item["note"]
    assert (repo / "a.py").read_text() == "a = 1\n"
    assert hub.code_desk.landing == {}  # (its turns go again)


async def test_pause_reorder_and_remove(hub, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n", "b.py": "b = 1\n"})
    one = copy_with(hub, repo, "one", {"a.py": "a = 2\n"})
    two = copy_with(hub, repo, "two", {"b.py": "b = 2\n", "c.py": "c\n"})
    await queue(hub, "copy", one.slug)
    await queue(hub, "copy", two.slug)
    q = hub.code_mq
    q.pause_project(items(hub)[0]["repo"], True)
    await q.tick()
    assert len(items(hub)) == 2  # (paused: nothing lands)
    second = items(hub)[1]
    q.act(second["id"], "up")
    assert items(hub)[0] is second and second["moved"]
    q.act(second["id"], "pause")
    q.pause_project(second["repo"], False)
    await q.tick()
    assert [i["ref"] for i in items(hub)] == [two.slug]  # (the paused one waits; the next goes)
    q.act(second["id"], "resume")
    assert q.act(second["id"], "remove") == "Removed from the queue."
    assert items(hub) == []


async def test_a_copy_landed_from_the_copies_pane_leaves_the_queue(hub, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n"})
    copy = copy_with(hub, repo, "one", {"a.py": "a = 2\n"})
    await queue(hub, "copy", copy.slug)
    hub.code_mq.pause_project(items(hub)[0]["repo"], True)
    assert (await hub.code_desk.land_now(copy)).startswith("Landed")
    assert items(hub) == []


def events_of(hub, kind):
    return [d for k, d in hub.events if k == kind]


# ── pull requests ──

GITHUB_URL = "https://github.com/acme/app.git"


def pr_project(tmp_path, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n", "b.py": "b = 1\n"})
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(repo, "remote", "add", "origin", GITHUB_URL)
    git(repo, "config", f"url.{bare}.insteadOf", GITHUB_URL)
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature")
    (repo / "a.py").write_text("a = 2\n")
    git(repo, "commit", "-qam", "Feature")
    git(repo, "push", "-q", "origin", "feature")
    git(repo, "switch", "-q", "main")
    return repo, bare


def pull_record(hub, repo, number, sha):
    rec = code_prs.PullRecord(repo="acme/app", number=number, url=f"https://github.com/acme/app/pull/{number}",
                              title="Feature", branch="feature", base="main", remote="origin",
                              folder=str(repo), project="app", head_sha=sha, checks="passed",
                              mergeable="clean", session_id="s-1")  # fmt: skip
    hub.code_pr.store().items.append(rec)
    return rec


def advance_main(tmp_path, bare, name="b.py", text="b = 2\n"):
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(bare), str(other)], check=True)
    git(other, "config", "user.email", "o@example.com")
    git(other, "config", "user.name", "o")
    (other / name).write_text(text)
    git(other, "commit", "-qam", "Moved main")
    git(other, "push", "-q", "origin", "main")


async def test_a_pull_request_is_rebased_pushed_with_a_lease_checked_then_merged(
    hub, tmp_path, projects
):
    repo, bare = pr_project(tmp_path, projects)
    head = git(bare, "rev-parse", "feature").strip()
    number = hub.fake.add_pull("acme/app", "feature", sha=head)["number"]
    rec = pull_record(hub, repo, number, head)
    advance_main(tmp_path, bare)
    said = await queue(hub, "pr", rec.key)
    assert said.startswith("Queued #") and "force-pushed (with a lease)" in hub.cards[-1]["detail"]
    await hub.code_mq.tick()
    [item] = items(hub)
    new = git(bare, "rev-parse", "feature").strip()
    assert (
        new != head
        and git(bare, "rev-parse", f"{new}^").strip() == git(bare, "rev-parse", "main").strip()
    )
    assert item["state"] == "checks" and rec.head_sha == new and rec.checks == "pending"
    assert git(repo, "rev-parse", "feature").strip() == new  # (the local branch followed)
    await hub.code_mq.tick()
    assert hub.fake.merged == [] and item["state"] == "checks"  # (its checks run on GitHub)
    hub.fake.pulls[("acme/app", number)]["head"]["sha"] = new  # (GitHub sees the push)
    rec.checks = "passed"
    await hub.code_mq.tick()
    assert items(hub) == [] and rec.state == "merged"
    assert hub.fake.merged and hub.fake.merged[-1]["sha"] == new


async def test_a_pull_request_that_conflicts_goes_to_its_session(
    hub, tmp_path, projects, monkeypatch
):
    repo, bare = pr_project(tmp_path, projects)
    head = git(bare, "rev-parse", "feature").strip()
    number = hub.fake.add_pull("acme/app", "feature", sha=head)["number"]
    rec = pull_record(hub, repo, number, head)
    advance_main(tmp_path, bare, "a.py", "a = 9\n")
    asked = []

    async def resolve(r, manual=False):
        asked.append((r.key, manual))
        return ""

    monkeypatch.setattr(hub.code_pr, "resolve", resolve)
    task = ClaudeTask(id=1, prompt="feature", cwd=repo, title="Feature", session_id="s-1")
    hub.tasks.tasks[task.id] = task
    await queue(hub, "pr", rec.key)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert (
        item["state"] == "fixing" and item["conflicts"] == ["a.py"] and asked == [(rec.key, True)]
    )
    assert git(bare, "rev-parse", "feature").strip() == head  # (nothing pushed)
    # A pull request a GitHub issue started goes to the owner instead.
    item["state"], rec.issue = "queued", 12
    await hub.code_mq.tick()
    assert item["state"] == "owner"


async def test_the_window_commands_reach_the_queue(hub, projects):
    repo = make_repo(projects / "app", {"a.py": "a = 1\n"})
    copy = copy_with(hub, repo, "one", {"a.py": "a = 2\n"})
    hub.answers.append("queue")
    hub.code_mq.cmd_add({"kind": "copy", "slug": copy.slug})
    for _ in range(200):
        if items(hub):
            break
        import asyncio

        await asyncio.sleep(0.01)
    [item] = items(hub)
    hub.code_mq.cmd_item({"id": item["id"], "action": "pause"})
    assert item["state"] == "paused"
    hub.code_mq.cmd_state({})
    [state] = events_of(hub, "code_mq")[-1]["queues"]
    assert state["project"] == "app" and state["items"][0]["state"] == "paused"
