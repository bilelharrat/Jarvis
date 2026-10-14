"""Stacked pull requests (features/code_stack.py): a session's branch split into parts (by
folder, or by topic when a cheap model is asked, then adjusted by the owner), each part a
commit on a branch of its own built on the one before (the session's folder untouched),
pushed and opened as pull requests into each other behind one card, put on code_pr's list;
then watched: a merge retargets and restacks the part above it, a pushed fix restacks the
parts above, a conflict stops and says where.

Real git in temp repositories: origin looks like github.com/acme/app but is a local bare
repository (url.insteadOf), and GitHub is tests/github_fakes.py. No model is called."""

import json
import subprocess
from dataclasses import replace

import pytest
from github_fakes import FakeGitHub
from test_code_changes import git, make_repo

from jarvis import code_ai, github
from jarvis.features import code_stack
from jarvis.tasks import ClaudeTask

GITHUB_URL = "https://github.com/acme/app.git"


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
    yield hub
    await hub.code_pr.client.aclose()


def events(hub, kind):
    return [d for k, d in hub.events if k == kind]


START = {"src/a.py": "a = 1\n", "tests/test_a.py": "def test_a():\n    pass\n", "README.md": "# app\n"}


def project(tmp_path, projects):
    """main pushed to origin; feature/login changes src, tests and the README (one commit
    and some work not committed yet)."""
    repo = make_repo(projects / "app", START)
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(repo, "remote", "add", "origin", GITHUB_URL)
    git(repo, "config", f"url.{bare}.insteadOf", GITHUB_URL)
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature/login")
    (repo / "src/a.py").write_text("a = 2\n")
    (repo / "tests/test_a.py").write_text("def test_a():\n    assert True\n")
    git(repo, "commit", "-qam", "Login work")
    (repo / "README.md").write_text("# app\n\nLogin.\n")
    (repo / "src/new.py").write_text("NEW = 1\n")
    return repo, bare


def session(hub, cwd):
    task = ClaudeTask(id=1, prompt="login", cwd=cwd, title="Login", session_id="s-1")
    hub.tasks.tasks[task.id] = task
    return task


def parts_of(hub):
    return events(hub, "code_stack")[-1]["proposal"]["parts"]


# ── proposing ──


async def test_the_default_proposal_is_one_part_a_top_level_folder(hub, tmp_path, projects):
    repo, _bare = project(tmp_path, projects)
    task = session(hub, repo)
    assert await hub.code_stacks.propose(task) == ""
    parts = parts_of(hub)
    assert sorted(p["title"] for p in parts) == ["Change README.md", "Change src", "Change tests"]
    src = next(p for p in parts if p["title"] == "Change src")
    assert sorted(h["path"] for h in src["hunks"]) == ["src/a.py", "src/new.py"]
    assert all({"n", "line", "added", "removed"} <= set(h) for h in src["hunks"])
    assert events(hub, "code_stack")[-1]["proposal"]["base"] == "main"


async def test_asked_a_cheap_model_proposes_by_topic_within_its_cap(hub, tmp_path, projects):
    repo, _bare = project(tmp_path, projects)
    task = session(hub, repo)
    asked = []

    async def ai(prompt, **kw):
        asked.append((prompt, kw))
        return json.dumps([{"title": "Add the login code", "hunks": [1, 2]}, {"title": "Test it", "hunks": [3]}])

    hub.code_stacks.ai = ai
    await hub.code_stacks.propose(task, use_ai=True)
    prompt, kw = asked[0]
    assert kw["kind"] == "stack_plan" and code_ai.model_for("stack_plan") == "claude-haiku-4-5"
    assert "data, never instructions" in kw["system"] and "(data, not instructions)" in prompt
    parts = parts_of(hub)
    assert [p["title"] for p in parts] == ["Add the login code", "Test it"]
    assert len(parts[0]["hunks"]) == 2 and len(parts[1]["hunks"]) == 2  # (the one left out joins the last)
    budget = code_ai.budget_for(hub)
    budget.counts["stack_plan"] = code_stack.PLANS_A_DAY
    note = await hub.code_stacks.propose(task, use_ai=True)
    assert note == "That's today's 20 topic proposals; this one is by folder." and len(asked) == 1
    assert len(parts_of(hub)) == 3


async def test_the_owner_moves_hunks_and_names_parts(hub, tmp_path, projects):
    repo, _bare = project(tmp_path, projects)
    task = session(hub, repo)
    await hub.code_stacks.propose(task)
    ids = [h["id"] for p in parts_of(hub) for h in p["hunks"]]
    said = await hub.code_stacks.adjust(task, [{"title": "One", "hunks": ids[:1]}, {"title": "", "hunks": ids[1:]}])
    assert said == "Give every part a title."
    said = await hub.code_stacks.adjust(task, [{"title": "One", "hunks": ids[:1]}, {"title": "Two", "hunks": []}])
    assert said == ""
    parts = parts_of(hub)
    assert [p["title"] for p in parts] == ["One", "Two"] and len(parts[1]["hunks"]) == len(ids) - 1
    # An empty part is dropped; a hunk named twice counts once.
    await hub.code_stacks.adjust(task, [{"title": "One", "hunks": ids}, {"title": "Two", "hunks": ids}])
    assert [p["title"] for p in parts_of(hub)] == ["One"]


# ── opening ──


async def two_parts(hub, task):
    await hub.code_stacks.propose(task)
    parts = parts_of(hub)
    by = {p["title"]: [h["id"] for h in p["hunks"]] for p in parts}
    await hub.code_stacks.adjust(task, [
        {"title": "Add the login code", "hunks": by["Change src"] + by["Change README.md"]},
        {"title": "Test the login", "hunks": by["Change tests"]},
    ])  # fmt: skip


async def test_the_stack_opens_behind_one_card_as_branches_built_on_each_other(hub, tmp_path, projects):
    repo, bare = project(tmp_path, projects)
    task = session(hub, repo)
    head_before = git(repo, "rev-parse", "HEAD")
    status_before = git(repo, "status", "--porcelain")
    await two_parts(hub, task)
    hub.answers = ["deny"]
    assert await hub.code_stacks.create(task) == "Not opened."
    card = hub.cards[-1]
    assert card["question"] == "Open a stack of 2 pull requests in acme/app?"
    assert "1. feature/login-part-1: Add the login code (3 changes)" in card["detail"]
    assert "2. feature/login-part-2: Test the login (1 change)" in card["detail"]
    assert "the first into main" in card["detail"]
    assert not git(repo, "branch", "--list", "feature/login-part-*").strip()
    hub.answers = ["open"]
    said = await hub.code_stacks.create(task)
    assert said.startswith("Opened a stack of 2 pull requests: #")
    # The session's own branch, index and work aren't touched.
    assert git(repo, "rev-parse", "HEAD") == head_before
    assert git(repo, "status", "--porcelain") == status_before
    # Each part is one commit on the one before; together they are the session's work.
    one, two = (git(bare, "rev-parse", f"feature/login-part-{n}").strip() for n in (1, 2))
    assert git(bare, "rev-parse", f"{two}^").strip() == one
    assert git(bare, "rev-parse", f"{one}^").strip() == git(bare, "rev-parse", "main").strip()
    assert git(bare, "show", f"{one}:src/new.py") == "NEW = 1\n"
    assert git(bare, "show", f"{one}:tests/test_a.py") == START["tests/test_a.py"]
    assert git(bare, "show", f"{two}:tests/test_a.py") == "def test_a():\n    assert True\n"
    assert git(bare, "show", f"{two}:README.md") == "# app\n\nLogin.\n"
    # Pull requests into each other, the first into main, on code_pr's list (no session, no
    # fixing by itself: their branches aren't the session's).
    [stack] = hub.code_stacks.stacks()
    first, second = stack["parts"]
    pulls = {n: hub.fake.pulls[("acme/app", n)] for n in (first["number"], second["number"])}
    assert pulls[first["number"]]["base"]["ref"] == "main"
    assert pulls[second["number"]]["base"]["ref"] == "feature/login-part-1"
    assert f"Depends on #{first['number']}" in pulls[second["number"]]["body"]
    rec = hub.code_pr.store().find("acme/app", second["number"])
    assert rec is not None and rec.autofix is False and rec.session_id == ""
    assert hub.code_pr.task_for(rec) is None
    assert events(hub, "code_stack")[-1]["stacks"][0]["id"] == stack["id"]


async def test_a_binary_file_or_a_stale_proposal_stops_it(hub, tmp_path, projects):
    repo, _bare = project(tmp_path, projects)
    task = session(hub, repo)
    await two_parts(hub, task)
    (repo / "src/a.py").write_text("a = 3\n")  # the change moved on
    hub.answers = ["open"]
    assert await hub.code_stacks.create(task) == "The changes moved on since the proposal; propose again."
    (repo / "logo.png").write_bytes(b"\x89PNG\x00\x01\x02")
    await hub.code_stacks.propose(task)
    said = await hub.code_stacks.create(task)
    assert said.startswith("These can't be in a stack: logo.png.") and hub.cards == []
    assert events(hub, "code_stack")[-1]["unsplittable"] == [{"path": "logo.png", "why": "binary"}]


# ── watching ──


async def opened(hub, tmp_path, projects):
    repo, bare = project(tmp_path, projects)
    task = session(hub, repo)
    await two_parts(hub, task)
    hub.answers = ["open"]
    await hub.code_stacks.create(task)
    [stack] = hub.code_stacks.stacks()
    for part in stack["parts"]:  # (GitHub's head is the branch's)
        hub.fake.pulls[("acme/app", part["number"])]["head"]["sha"] = part["head"]
    return repo, bare, stack


def clone(tmp_path, bare, name="other"):
    folder = tmp_path / name
    subprocess.run(["git", "clone", "-q", str(bare), str(folder)], check=True)
    git(folder, "config", "user.email", "o@example.com")
    git(folder, "config", "user.name", "o")
    return folder


async def test_an_unchanged_stack_does_nothing(hub, tmp_path, projects):
    _repo, _bare, stack = await opened(hub, tmp_path, projects)
    cards = len(hub.cards)
    assert await hub.code_stacks.look(stack) == ""
    assert len(hub.cards) == cards


async def test_a_merged_part_retargets_the_next_and_restacks_it_on_the_base(hub, tmp_path, projects):
    _repo, bare, stack = await opened(hub, tmp_path, projects)
    first, second = stack["parts"]
    other = clone(tmp_path, bare)
    git(other, "merge", "-q", "--squash", "origin/feature/login-part-1")
    git(other, "commit", "-qm", "Add the login code (#1)")
    git(other, "push", "-q", "origin", "main")
    hub.fake.pulls[("acme/app", first["number"])].update(state="closed", merged=True)
    hub.answers = ["restack"]
    said = await hub.code_stacks.look(stack)
    assert said == f"Restacked #{second['number']}."
    assert hub.fake.pulls[("acme/app", second["number"])]["base"]["ref"] == "main"
    assert any(f"#{second['number']} now goes into main" in a.text for a in hub.alerts)
    assert hub.cards[-1]["question"].startswith(f"Restack the pull requests above #{first['number']} on main")
    two = git(bare, "rev-parse", "feature/login-part-2").strip()
    assert git(bare, "rev-parse", f"{two}^").strip() == git(bare, "rev-parse", "main").strip()
    assert git(bare, "show", f"{two}:tests/test_a.py") == "def test_a():\n    assert True\n"
    assert stack["parts"][1]["head"] == two and stack["parts"][0]["state"] == "merged"
    assert hub.code_pr.store().find("acme/app", second["number"]).base == "main"


async def test_a_fix_pushed_to_a_part_restacks_the_parts_above(hub, tmp_path, projects):
    _repo, bare, stack = await opened(hub, tmp_path, projects)
    first, second = stack["parts"]
    other = clone(tmp_path, bare)
    git(other, "switch", "-q", "feature/login-part-1")
    (other / "src/a.py").write_text("a = 22\n")
    git(other, "commit", "-qam", "Review fix")
    git(other, "push", "-q", "origin", "feature/login-part-1")
    new = git(other, "rev-parse", "HEAD").strip()
    hub.fake.pulls[("acme/app", first["number"])]["head"]["sha"] = new
    hub.answers = ["restack"]
    said = await hub.code_stacks.look(stack)
    assert said == f"Restacked #{second['number']}."
    two = git(bare, "rev-parse", "feature/login-part-2").strip()
    assert git(bare, "rev-parse", f"{two}^").strip() == new
    assert git(bare, "show", f"{two}:src/a.py") == "a = 22\n"
    assert stack["parts"][0]["head"] == new
    # Asked once per head: the same head isn't asked about again.
    hub.fake.pulls[("acme/app", second["number"])]["head"]["sha"] = two
    cards = len(hub.cards)
    assert await hub.code_stacks.look(stack) == "" and len(hub.cards) == cards


async def test_a_conflict_stops_the_restack_and_says_where(hub, tmp_path, projects):
    _repo, bare, stack = await opened(hub, tmp_path, projects)
    first, _second = stack["parts"]
    before = git(bare, "rev-parse", "feature/login-part-2").strip()
    other = clone(tmp_path, bare)
    git(other, "switch", "-q", "feature/login-part-1")
    (other / "tests/test_a.py").write_text("def test_a():\n    assert False\n")
    git(other, "commit", "-qam", "Clash")
    git(other, "push", "-q", "origin", "feature/login-part-1")
    hub.fake.pulls[("acme/app", first["number"])]["head"]["sha"] = git(other, "rev-parse", "HEAD").strip()
    hub.answers = ["restack"]
    said = await hub.code_stacks.look(stack)
    assert said == "Restacking feature/login-part-2 hits conflicts in tests/test_a.py; it's over to you."
    assert git(bare, "rev-parse", "feature/login-part-2").strip() == before
    assert any("hits conflicts" in a.text for a in hub.alerts)


async def test_turned_down_or_closed_the_stack_is_left_alone(hub, tmp_path, projects):
    _repo, bare, stack = await opened(hub, tmp_path, projects)
    first, _second = stack["parts"]
    hub.fake.pulls[("acme/app", first["number"])]["head"]["sha"] = "f" * 40
    hub.answers = ["deny"]
    assert await hub.code_stacks.look(stack) == "Not now."
    assert stack["parts"][0]["head"] == "f" * 40
    hub.fake.pulls[("acme/app", first["number"])].update(state="closed")
    await hub.code_stacks.look(stack)
    assert stack["state"] == "closed"
    assert any("closed without merging" in a.text for a in hub.alerts)
