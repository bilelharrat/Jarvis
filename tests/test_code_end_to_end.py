"""Eden Code end to end (the production plan's T10): one real hub and its TaskManager drive a
sample project the way the owner does, with only the outside world faked. Claude Code is a
fake client that really edits the files of the folder its session runs in (and answers with
the tool calls Claude Code would show); GitHub is tests/github_fakes.py; the other machine is
the hand-off tests' fake ssh with a fake claude in a temp "home"; git, the isolated copies,
the project's own pytest run and the landing are all real, in temp folders.

The story: a session starts in an isolated copy of a project that sits on a feature branch,
fixes a bug (a real edit in the copy, never in the main folder), the Tests pane runs the
project's tests there and they pass, the session is handed off to another machine that adds
a file, is brought back, and lands on the feature branch; a session in the main folder then
opens a pull request for that branch against GitHub's test double; and a routed message whose
model hits its rate limit falls back to the route's next pick and carries on. Nothing leaves
the machine: origin looks like github.com/acme/app but is a local bare repository, for this
Mac and for the other machine alike (url.insteadOf)."""

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from conftest import FakeClient, result, strip_note
from github_fakes import FakeGitHub
from test_code_changes import git, make_repo
from test_code_handoff import FAKE_CLAUDE, FAKE_SSH, python_executable

from jarvis import github, handoff

GITHUB_URL = "https://github.com/acme/app.git"

BUGGY = "def add(a, b):\n    return a - b\n"
FIXED = "def add(a, b):\n    return a + b\n"
TESTS = "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"


class Coder(FakeClient):
    """Claude Code as the session sees it, doing real work in its folder. A message with
    FIX in it edits calc.py there (the Edit tool's call, the file changed, its result); on a
    Sonnet model every turn hits the rate limit, as Claude Code reports it; anything else
    gets a short reply. Every connection is kept, with the model it was opened on."""

    connections: list = []

    def __init__(self, options=None):
        super().__init__(options)
        self.model = str(getattr(options, "model", "") or "")  # set_model switches it live
        self.asked = []  # (the model it was on, the message), for each message
        Coder.connections.append(self)

    async def query(self, text):
        self.queries.append(text)
        self.asked.append((self.model, text))
        n = sum(len(c.queries) for c in Coder.connections)
        out = self._stream()
        out.put_nowait(UserMessage(content=str(text), uuid=f"u-{n}"))
        if "sonnet" in self.model:
            words = "You've hit your limit · resets 5pm"
            out.put_nowait(
                AssistantMessage(
                    content=[TextBlock(text=words)], model=self.model, error="rate_limit"
                )
            )
            out.put_nowait(result(is_error=True, text=words, cost=0.0))
            return
        if "FIX" in str(text):
            path = Path(self.options.cwd) / "calc.py"
            edit = {"file_path": str(path), "old_string": "a - b", "new_string": "a + b"}
            out.put_nowait(
                AssistantMessage(
                    content=[ToolUseBlock(id=f"e-{n}", name="Edit", input=edit)],
                    model="m",
                    uuid=f"a-{n}",
                )
            )
            path.write_text(path.read_text().replace("a - b", "a + b"))
            out.put_nowait(
                UserMessage(content=[ToolResultBlock(tool_use_id=f"e-{n}", content="ok")])
            )
            reply = "Fixed add: it subtracted."
        else:
            reply = f"Carried on ({self.model or 'default'})."
        out.put_nowait(AssistantMessage(content=[TextBlock(text=reply)], model="m"))
        out.put_nowait(result(text=reply, cost=0.02))


@pytest.fixture(autouse=True)
def _no_real_gh(monkeypatch):
    monkeypatch.setattr(github.shutil, "which", lambda _name: None)


@pytest.fixture
def world(tmp_path, monkeypatch):
    """The project (on feature/adder, its origin a local bare repository standing in for
    github.com/acme/app), the other machine's home (its own git reaches the same bare
    repository by the same address), and the fake ssh that reaches it."""
    projects = tmp_path / "projects"
    repo = make_repo(
        projects / "app",
        {"calc.py": BUGGY, "tests/test_calc.py": TESTS, ".gitignore": ".venv/\n"},
    )
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(repo, "remote", "add", "origin", GITHUB_URL)
    git(repo, "config", f"url.{bare}.insteadOf", GITHUB_URL)
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "switch", "-q", "-c", "feature/adder")
    git(repo, "push", "-q", "-u", "origin", "feature/adder")
    remotes = tmp_path / "remote homes"
    studio = remotes / "studio"
    (studio / "bin").mkdir(parents=True)
    python_executable(studio / "bin" / "claude", FAKE_CLAUDE.format())
    (studio / ".gitconfig").write_text(
        f'[url "{bare}"]\n\tinsteadOf = {GITHUB_URL}\n'
        "[user]\n\tname = Studio\n\temail = studio@example.com\n"
    )
    ssh = python_executable(tmp_path / "fake ssh" / "ssh", FAKE_SSH.format(root=str(remotes)))
    ssh_config = tmp_path / "ssh" / "config"
    ssh_config.parent.mkdir()
    ssh_config.write_text("Host studio\n  User me\n")
    monkeypatch.setattr(handoff, "CHECK_SECONDS", 120.0)
    monkeypatch.setattr(handoff, "WRITE_SECONDS", 120.0)
    return {
        "projects": projects,
        "repo": repo,
        "bare": bare,
        "studio": studio,
        "ssh": ssh,
        "ssh_config": ssh_config,
    }


# The owner's answer to each card, by what it asks.
ANSWERS = (
    ("Land ", "land"),
    ("Continue this session on", "go"),
    ("Allow this step on", "allow"),
    ("Bring ", "back"),
    ("Push ", "push"),
)


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, world):
    from jarvis.hub import Hub

    Coder.connections = []
    hub = Hub(
        replace(settings, projects_dir=world["projects"]),
        client_factory=Coder,
        speaker=quiet_speaker,
        poll=False,
        **isolated,
    )
    hub.cards = []

    def owner(card):
        hub.cards.append(card)
        choice = next((a for q, a in ANSWERS if card["question"].startswith(q)), "deny")
        hub.resolve(card["id"], choice)

    hub.add_approval_sink(owner)
    hub.code_handoff.ssh = str(world["ssh"])
    hub.code_handoff.ssh_config = world["ssh_config"]
    hub.fake = FakeGitHub()
    hub.code_pr._client = github.Client(lambda: "tok", transport=hub.fake.transport())
    cv = hub.code_verify
    env = {"PATH": "/usr/bin:/bin", "HOME": str(world["projects"])}
    cv.servers.env = cv.tests.env = cv.diags.env = lambda: dict(env)
    yield hub
    desk = hub.code_handoff
    for follower in list(desk._followers.values()):
        follower.cancel()
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    pending = [*handles, *desk._followers.values()]
    if pending:
        await asyncio.wait(pending, timeout=5)
    await hub.code_pr.client.aclose()
    await cv.close()
    for pid_file in world["studio"].glob(".jarvis-handoff/*/claude.pid"):
        try:
            os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
        except (ValueError, OSError):
            pass


async def until(condition, seconds=120.0):
    """Whether condition() comes true in time. Real worktrees, a real pytest and a Python
    or two "over SSH" each take a moment on a busy Mac; it returns as soon as it holds."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.02)
    return True


async def event(queue, kind, check=lambda ev: True, seconds=120.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while not queue.empty():
            ev = queue.get_nowait()
            if ev.get("type") == kind and check(ev):
                return ev
        await asyncio.sleep(0.05)
    raise AssertionError(f"no {kind} event")


def said(task):
    return [e["text"] for e in task.transcript]


async def test_a_session_goes_from_a_bug_to_a_pull_request_and_survives_a_rate_limit(hub, world):
    """Start in an isolated copy, edit, test, hand off and bring back, land, open a pull
    request, and fall back from a rate-limited model: every step through the hub's own
    commands and the TaskManager, on a real repository."""
    repo, bare = world["repo"], world["bare"]
    events = hub.subscribe()

    # ── start: an isolated copy of the project, on a branch of its own ──
    task = hub.tasks.start("", "app", isolate=True, title="fix the adder")
    assert await until(lambda: task.workspace and task.client is not None), said(task)
    copy = hub.code_desk.store().find(task.workspace["slug"])
    assert copy.into == "feature/adder" and task.cwd != repo and (task.cwd / "calc.py").exists()

    # ── edit: Claude Code changes calc.py in the copy, never in the main folder ──
    assert hub.tasks.send(task.id, "FIX the adder, it subtracts")
    assert await until(lambda: "Fixed add: it subtracted." in said(task) and not task.busy)
    assert (task.cwd / "calc.py").read_text() == FIXED
    assert (repo / "calc.py").read_text() == BUGGY
    assert any(Path(f).name == "calc.py" for f in task.files_changed)
    assert task.checkpoints  # the message is a point it can be rewound to

    # ── test: the Tests pane runs the project's own pytest in the copy ──
    venv = task.cwd / ".venv" / "bin" / "python"  # (ignored by git: never landed)
    venv.parent.mkdir(parents=True)
    venv.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    venv.chmod(0o755)
    await hub._handle({"type": "cv_tests", "action": "state", "id": task.id})
    state = await event(events, "cv_tests")
    [suite] = state["suites"]
    assert suite["id"] == "pytest"
    await hub._handle({"type": "cv_tests", "action": "run", "id": task.id, "suite": suite["key"]})
    done = await event(events, "cv_tests_run", lambda ev: ev["run"]["status"] != "running")
    assert done["run"]["status"] == "passed" and done["run"]["summary"] == "1 passed"

    # ── hand off to the other machine, which adds a file, and bring it back ──
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task.transcript.append({"role": "user", "text": "add the changelog there"})
    handed = await desk.hand_off(task, "studio", "WRITE:CHANGELOG.md and carry on")
    assert handed.startswith("Handed off to studio"), said(task)
    rec = desk.of_task(task)
    assert rec.how == "push"  # it fetched the branch from origin (the bare repository)
    assert await until(lambda: rec.turns >= 1), said(task)
    assert "Done with turn 1 there." in said(task)
    back = await desk.bring_back(rec)
    assert back.startswith("Brought back from studio"), back
    assert (task.cwd / "CHANGELOG.md").read_text() == "made there\n"
    assert desk.of_task(task) is None

    # ── land on the feature branch: the main folder gets the fix and the machine's file ──
    landed = await hub.code_desk.land(copy.slug)
    assert landed.startswith(f"Landed {copy.branch} in feature/adder"), landed
    assert git(repo, "branch", "--show-current").strip() == "feature/adder"
    assert (repo / "calc.py").read_text() == FIXED
    assert (repo / "CHANGELOG.md").read_text() == "made there\n"
    assert not (repo / ".venv").exists() and git(repo, "status", "--porcelain") == ""
    assert hub.code_desk.store().find(copy.slug) is None
    assert await until(lambda: task.handle is None or task.handle.done())

    # ── a pull request for the branch, from a session in the main folder ──
    pr_session = hub.tasks.start("", "app", isolate=False, title="open the PR")
    assert await until(lambda: pr_session.client is not None), said(pr_session)
    assert pr_session.cwd == repo.resolve()
    opened = await hub.code_pr.open(
        pr_session, {"title": "Fix add", "body": "It subtracted.", "base": "main"}
    )
    assert opened == "Opened pull request #7.", opened
    [created] = hub.fake.sent("POST", "/repos/acme/app/pulls")
    assert json.loads(created.content)["head"] == "feature/adder"
    tip = git(repo, "rev-parse", "HEAD").strip()
    assert git(bare, "rev-parse", "feature/adder").strip() == tip  # pushed behind its card
    assert any(c["question"] == "Push feature/adder to origin?" for c in hub.cards)
    assert hub.code_pr.store().find("acme/app", 7) is not None

    # ── the Model Router: Sonnet is rate-limited, so the route's next pick carries on ──
    hub.set_feature_prefs({"code_router_on": True})
    route = {
        "ref": "sonnet",
        "model": "claude-sonnet-5-5",
        "fallbacks": [{"ref": "opus", "model": "claude-opus-5-5"}],
    }
    await hub.handle({"type": "task_send", "id": pr_session.id, "text": "tidy up", "route": route})
    assert await until(lambda: pr_session.model_ref == "opus" and not pr_session.busy), said(
        pr_session
    )
    assert await until(lambda: any(t.startswith("Carried on") for t in said(pr_session)))
    asked = [(model, strip_note(text)) for c in Coder.connections for model, text in c.asked]
    assert ("claude-sonnet-5-5", "tidy up") in asked  # the routed model got the message
    model, carry_on = asked[-1]
    assert model == "claude-opus-5-5" and carry_on.startswith("Carry on with my last request")
    assert "You've hit your limit · resets 5pm" in said(pr_session)
    assert any("moved to Opus 5.5 to carry on" in line for line in said(pr_session))
