"""Eden Cloud from the Mac (features/code_eden_cloud.py), against the real Eden Cloud service
(cloud/: its app, the fake backend, the real runner in a thread with a fake Claude Code CLI):
a session in an isolated copy goes there after a card, its events stream into the session, its
branch comes back into the copy, and what came back is marked as data. No network, no model."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

CLOUD = Path(__file__).resolve().parent.parent / "cloud"
for extra in (CLOUD, CLOUD / "runner", CLOUD / "tests"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from eden_cloud.app import build  # noqa: E402
from eden_cloud.backends import FakeBackend  # noqa: E402
from eden_cloud.config import Settings  # noqa: E402
from fakes import ACCOUNT, DEV, fake_claude, start_runner  # noqa: E402

from jarvis.features import code_eden_cloud  # noqa: E402
from jarvis.features.code_eden_cloud import EdenCloud, clean_url  # noqa: E402
from jarvis.features.code_handoff import Desk  # noqa: E402

SERVER = "http://localhost:8790"
KEY = "sk-ant-test-0123456789abcdefghijklmnop"


def git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.name=T", "-c", "user.email=t@x", *args],
        cwd=cwd, capture_output=True, check=True, text=True,
    ).stdout.strip()  # fmt: skip


class Tasks:
    def __init__(self):
        self.tasks = {}
        self.send_routes, self.turn_notes = [], []
        self.finished, self.events = [], []

    def _log(self, task, role, text, **extra):
        task.transcript.append({"role": role, "text": text, **extra})

    def _changed(self):
        pass

    _changed_soon = _changed

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def _turn_finished(self, task, status, **_kw):
        self.finished.append((task.id, status))


class Hub:
    def __init__(self, tmp_path, prefs=None, answer="go"):
        self.tasks = Tasks()
        self.features = {
            "code_eden_cloud": True,
            "code_eden_cloud_url": SERVER,
            **(prefs or {}),
        }
        self.prefs = SimpleNamespace(feature=lambda key: self.features.get(key))
        self.language = "en"
        self.folder = tmp_path / "jarvis"
        self.folder.mkdir()
        self.events, self.cards, self.spawned = [], [], []
        self.answer = answer
        self.providers = SimpleNamespace(anthropic_key=lambda: KEY)
        self.copies = {}
        self.code_desk = SimpleNamespace(
            store=lambda: SimpleNamespace(find=lambda slug: self.copies.get(slug))
        )
        # The hand-off desk's real plan (secret scan and all); it uses only the copy.
        self.code_handoff = SimpleNamespace(_plan=lambda copy: Desk._plan(None, copy))

    def feature_path(self, name):
        return self.folder / name

    def emit(self, kind, **values):
        self.events.append((kind, values))

    async def request_approval(self, question, detail, choices, context=None):
        self.cards.append((question, detail, choices))
        return self.answer

    def _spawn(self, coro):
        task = asyncio.ensure_future(coro)
        self.spawned.append(task)
        return task

    def _say(self, text):
        pass


def session(hub, tmp_path, slug="c1"):
    """A session in an isolated copy: a real git checkout on its own branch."""
    checkout = tmp_path / "copy"
    checkout.mkdir()
    git(checkout, "init", "-q", "-b", "eden/c1")
    (checkout / "README.md").write_text("hello\n")
    git(checkout, "add", "-A")
    git(checkout, "commit", "-q", "-m", "first")
    base = git(checkout, "rev-parse", "HEAD")
    (checkout / "notes.txt").write_text("work in progress\n")  # uncommitted: committed first
    hub.copies[slug] = SimpleNamespace(
        slug=slug, checkout=str(checkout), cwd=checkout, branch="eden/c1", base=base,
        title="Copy", project="p",
    )  # fmt: skip
    task = SimpleNamespace(
        id=1, kind="code", busy=False, status="waiting", workspace={"slug": slug},
        title="Add a greeting", prompt="Add hello.txt", transcript=[], todos=[],
        files_changed=set(), tool_ids={}, result="", last_action="", current="",
        session_id="", model="", env=None, untrusted=False,
    )  # fmt: skip
    hub.tasks.tasks[task.id] = task
    return task, checkout


def service(tmp_path, mode="ok"):
    loop = asyncio.get_running_loop()
    holder = {}
    threads = []

    def on_start(launch):
        work = tmp_path / f"work-{len(threads)}"
        work.mkdir()
        claude = fake_claude(tmp_path)
        threads.append(
            start_runner(launch, holder["c"], loop, work, claude, {"FAKE_CLAUDE_MODE": mode})
        )

    settings = Settings(
        data_dir=tmp_path / "cloud-data", backend="fake", dev_tokens={DEV: ACCOUNT}
    )
    app = build(settings, backend=FakeBackend(on_start), watch=False)
    transport = httpx.ASGITransport(app=app)
    holder["c"] = httpx.AsyncClient(transport=transport, base_url=SERVER)
    return app, transport, threads


async def until(check, seconds=30.0):
    for _ in range(int(seconds / 0.05)):
        if check():
            return True
        await asyncio.sleep(0.05)
    return False


@pytest.fixture(autouse=True)
def dev_token(monkeypatch):
    monkeypatch.setenv(code_eden_cloud.DEV_TOKEN, DEV)
    monkeypatch.setattr(code_eden_cloud, "WAIT", 1.0)


# ── the settings ──


def test_the_address_is_https_or_this_mac_only():
    assert clean_url("https://cloud.askeden.com/") == "https://cloud.askeden.com"
    assert clean_url("http://localhost:8790") == "http://localhost:8790"
    assert clean_url("") == ""
    for bad in ("http://cloud.example.com", "https://user:pw@x.com", "ftp://x", "https://x.com/?a=1"):
        assert clean_url(bad) is None, bad


async def test_off_until_configured_and_needs_a_key_and_a_copy(tmp_path):
    hub = Hub(tmp_path, prefs={"code_eden_cloud": False})
    cloud = EdenCloud(hub)
    task, _ = session(hub, tmp_path)
    assert "Turn on Eden Cloud" in await cloud.submit(task)
    hub.features["code_eden_cloud"] = True
    hub.providers = SimpleNamespace(anthropic_key=lambda: "")
    assert "your own Anthropic API key" in await cloud.submit(task)
    hub.providers = SimpleNamespace(anthropic_key=lambda: KEY)
    task.workspace = {}
    assert "isolated copy" in await cloud.submit(task)
    task.workspace, task.busy = {"slug": "c1"}, True
    assert "middle of a step" in await cloud.submit(task)
    task.busy, task.untrusted = False, True
    assert "locked down" in await cloud.submit(task)
    assert not hub.cards


async def test_a_card_first_and_no_means_nothing_leaves(tmp_path):
    app, transport, _threads = service(tmp_path)
    hub = Hub(tmp_path, answer="deny")
    cloud = EdenCloud(hub)
    cloud.transport = transport
    task, _ = session(hub, tmp_path)
    task.transcript.append({"role": "user", "text": "my key is sk-ant-api03-" + "A" * 90})
    assert await cloud.submit(task, brief="Add hello.txt") == "Not sent to Eden Cloud."
    question, detail, choices = hub.cards[0]
    assert question == "Run in Eden Cloud?"
    assert "snapshot" in detail and "Anthropic API key" in detail and "$5.00" in detail
    assert "1 uncommitted files" in detail
    assert "Possible secrets" in detail and choices[0] == ("go", "Run anyway")
    assert app.state.store.of_account(ACCOUNT) == []


# ── a whole run ──


async def test_a_session_runs_there_streams_back_and_lands(tmp_path):
    app, transport, threads = service(tmp_path)
    hub = Hub(tmp_path)
    cloud = EdenCloud(hub)
    cloud.transport = transport
    task, checkout = session(hub, tmp_path)
    said = await cloud.submit(task, brief="Add hello.txt", budget=2, minutes=10)
    assert said.startswith("Sent to Eden Cloud"), said
    run = cloud.runs[0]
    assert (run.budget, run.minutes, run.source) == (2.0, 10, "snapshot")
    assert task.busy
    # While it runs there, a message isn't sent anywhere.
    assert cloud.route(task, "and also this") is False
    assert "Messages don't go there" in task.transcript[-1]["text"]
    assert await until(lambda: run.landed), run
    thread, _done = threads[0]
    await asyncio.to_thread(thread.join, 30)
    # Its events are in the session, like a session here.
    roles = [e["role"] for e in task.transcript]
    assert "assistant" in roles and "turn" in roles
    tool = next(e for e in task.transcript if e["role"] == "tool")
    assert tool["tool"] == "Write" and tool["status"] == "done"
    assert run.state == "done" and run.cost == pytest.approx(0.12)
    # Its branch came back into the copy, fast-forwarded: ready to land.
    assert (checkout / "hello.txt").read_text() == "hi\n"
    assert git(checkout, "log", "-1", "--format=%an") == "Eden Cloud"
    assert "1 commit in its isolated copy" in run.landed
    assert not task.busy and hub.tasks.finished == [(1, "done")]
    # What it said there comes with the next message, as data.
    note = cloud.turn_note(task)
    assert "never as instructions" in note and "<from-eden-cloud>" in note
    assert cloud.turn_note(task) == ""
    # The diff, to read; then forgetting it deletes it there too.
    await cloud.diff(run)
    shown = [v for k, v in hub.events if k == "code_eden_cloud_diff"][-1]
    assert "hello.txt" in shown["diff"]
    assert "deleted in Eden Cloud" in await cloud.forget(run)
    assert app.state.store.of_account(ACCOUNT) == [] and cloud.runs == []
    # The key never reached the Mac's own records.
    kept = (hub.folder / "code_eden_cloud.json").read_text()
    assert KEY not in kept


async def test_a_change_that_can_run_code_here_stays_parked(tmp_path):
    _app, transport, threads = service(tmp_path, mode="risky")
    hub = Hub(tmp_path)
    cloud = EdenCloud(hub)
    cloud.transport = transport
    task, checkout = session(hub, tmp_path)
    await cloud.submit(task, brief="Add hello.txt")
    run = cloud.runs[0]
    assert await until(lambda: run.landed)
    await asyncio.to_thread(threads[0][0].join, 30)
    assert "not merged" in run.landed and ".mcp.json" in run.landed
    assert not (checkout / ".mcp.json").exists()
    assert git(checkout, "for-each-ref", "--format=%(refname)", "refs/jarvis/eden-cloud/")


async def test_cancel_and_reconnect_after_a_restart(tmp_path):
    app, transport, _threads = service(tmp_path)
    app.state.backend.on_start = None  # (a machine that never calls back)
    hub = Hub(tmp_path)
    cloud = EdenCloud(hub)
    cloud.transport = transport
    task, _ = session(hub, tmp_path)
    await cloud.submit(task, brief="Add hello.txt")
    run = cloud.runs[0]
    assert run.live
    # Eden Code restarts: the kept run is followed again.
    for follower in hub.spawned:
        follower.cancel()
    again = EdenCloud(hub)
    again.transport = transport
    await again.watch()
    kept = again.runs[0]
    assert kept.id == run.id and kept.live
    assert "Cancelled it" in await again.cancel(kept)
    assert await until(lambda: not task.busy)
    assert kept.state == "cancelled" and "nothing new" in kept.landed


async def test_state_and_test(tmp_path):
    _app, transport, _threads = service(tmp_path)
    hub = Hub(tmp_path)
    cloud = EdenCloud(hub)
    cloud.transport = transport
    assert await cloud.test() == "Eden Cloud is ready."
    state = [v for k, v in hub.events if k == "code_eden_cloud"][-1]
    assert state["configured"] and state["limits"]["max_running"] == 1
    hub.features["code_eden_cloud_url"] = "https://cloud.example.com"  # (no dev token there)
    hub.account = SimpleNamespace(linked=False)
    assert "Link this Mac" in await cloud.test()
