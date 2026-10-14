"""Hand-offs and the cloud (features/code_handoff.py, features/code_cloud.py): the branches
the end-to-end tests in test_code_handoff.py and test_code_cloud.py don't reach. No SSH at
all: every script "run there" goes to a fake that answers as the remote would (or wouldn't),
and the few reads of a remote's output come from a tiny sh script that prints a file. Real
git, in temp repositories, wherever a branch is sent or brought back."""

from __future__ import annotations

import asyncio
import json
import shlex
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_code_changes import git, make_repo, numbered
from test_code_cloud import Hub as CloudHub

from jarvis import handoff, jsonstore, worktrees
from jarvis.features import code_cloud, code_handoff
from jarvis.features.code_cloud import Cloud
from jarvis.features.code_handoff import UNTRUSTED_NOTE, Desk
from jarvis.handoff import Done, Handoff, Machine
from jarvis.worktrees import Copy

UNREACHABLE = "ssh: connect to host studio port 22: Operation timed out"
PROBE_OK = Done(0, b"jarvis-probe\ngit: git version 2\nclaude: /x/claude\n", "")


# ── the fakes ──


def kind_of(script: str) -> str:
    """Which of the hand-off's remote scripts this is."""
    if script == "true":
        return "reach"
    for needle, kind in (
        ("for i in 1 2 3 4 5", "stop"),
        ("run.sh", "start"),
        ("bundle create -", "back"),
        ("git fetch -q --", "setup"),
        ("echo missing", "status"),
        ('cat > "$D/handoff.bundle"', "send"),
        ("ls-remote", "probe-remote"),
        ("cat >> inbox.jsonl", "write"),
        ("jarvis-probe", "probe"),
    ):
        if needle in script:
            return kind
    return "other"


class Remote:
    """handoff.run, faked: each kind of script gets the answer the test set (default: ok,
    nothing said), and every call is kept."""

    def __init__(self):
        self.rules = {}
        self.calls = []

    def on(self, kind, result):
        self.rules[kind] = result

    def kinds(self):
        return [c[0] for c in self.calls]

    async def __call__(self, ssh, alias, script, stdin=None, timeout=60.0):
        kind = kind_of(script)
        self.calls.append((kind, alias, script, stdin))
        result = self.rules.get(kind, Done(0, b"", ""))
        return result(script, stdin) if callable(result) else result


class Task(SimpleNamespace):
    pass


class Tasks:
    def __init__(self):
        self.tasks = {}
        self.next_id = 1
        self.events, self.finished, self.cancelled = [], [], []
        self.turn_note = None

    def add(self, **kw):
        task = Task(
            id=self.next_id, kind="code", session_id="", busy=False, status="waiting",
            workspace={}, title="fix the login", prompt="", transcript=[], tool_ids={},
            todos=[], commands=0, last_action="", result="", current="", mode="ask",
            handle=None, model="", env=None, provider_settings=None, files_changed=set(),
            cwd="/p", fork=False,
        )  # fmt: skip
        task.__dict__.update(kw)
        self.tasks[task.id] = task
        self.next_id += 1
        return task

    def _log(self, task, kind, text, **kw):
        task.transcript.append({"role": kind, "text": text, **kw})

    def _changed(self):
        pass

    def _changed_soon(self):
        pass

    def _by_session(self, session_id):
        return next(
            (t for t in self.tasks.values() if session_id and t.session_id == session_id), None
        )

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def _turn_finished(self, task, status):
        self.finished.append((task.id, status))

    def cancel(self, task_id):
        self.cancelled.append(task_id)


class Hub:
    """Just what the hand-off desk asks of a hub."""

    def __init__(self, root: Path):
        self.tasks = Tasks()
        self.events, self.cards, self.answers, self.said, self.spawned = [], [], [], [], []
        self.language = "en"
        self.root = root / "data"
        self.root.mkdir(parents=True, exist_ok=True)
        self.copies = {}
        store = SimpleNamespace(find=lambda slug: self.copies.get(slug))
        self.code_desk = SimpleNamespace(store=lambda: store)

    def feature_path(self, name):
        return self.root / name

    def emit(self, kind, **data):
        self.events.append((kind, data))

    async def request_approval(self, question, detail, choices, context=None):
        self.cards.append({"question": question, "detail": detail, "choices": choices,
                           "context": context})  # fmt: skip
        return self.answers.pop(0) if self.answers else "deny"

    def _spawn(self, coro):
        future = asyncio.ensure_future(coro)
        self.spawned.append(future)
        return future

    def _say(self, text):
        self.said.append(text)

    def captions(self):
        return [d["text"] for k, d in self.events if k == "caption"]


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A desk on a fake hub, its remote scripts answered by a fake (never a real ssh: the
    desk's own ssh path doesn't exist, so even a stray read fails at once)."""
    hub = Hub(tmp_path)
    desk = Desk(hub)
    desk.ssh = str(tmp_path / "no ssh here" / "ssh")
    desk.ssh_config = tmp_path / "ssh_config"
    hub.code_handoff = desk
    remote = Remote()
    remote.on("probe", PROBE_OK)  # reached, with git and Claude Code there
    monkeypatch.setattr(handoff, "run", remote)
    desk.load()
    return SimpleNamespace(hub=hub, desk=desk, remote=remote, tmp=tmp_path)


def add_machine(desk, alias="studio", asks=False):
    machine = Machine(alias=alias, ok=True, git="git version 2", claude="/x/claude",
                      permissions=asks)  # fmt: skip
    desk.machines.append(machine)
    return machine


def record(w, task=None, state="working", alias="studio", **kw):
    """A hand-off on the desk's list, its session task (if any)."""
    rec = Handoff(
        id=kw.pop("id", "s1"), alias=alias, slug=kw.pop("slug", "s1"), project="proj",
        branch=kw.pop("branch", "jarvis/s1"), base=kw.pop("base", "c0"),
        session_id=task.session_id if task else "", task_id=task.id if task else 0,
        started=w.desk.booted, state=state, title="fix the login", **kw,
    )  # fmt: skip
    w.desk.handoffs.append(rec)
    return rec


def session(w, **kw):
    kw.setdefault("session_id", "local-1")
    return w.hub.tasks.add(**kw)


def said(task):
    return [e["text"] for e in task.transcript]


def make_copy(w, slug="s1", files=None):
    """An isolated copy in a real git repository, on its own branch."""
    repo = make_repo(w.tmp / "proj", files or {"a.py": numbered(3)})
    git(repo, "checkout", "-q", "-b", f"jarvis/{slug}")
    base = git(repo, "rev-parse", "HEAD").strip()
    copy = Copy(slug=slug, project="proj", repo=str(repo), prefix="", checkout=str(repo),
                branch=f"jarvis/{slug}", base=base, into="main", title="fix")  # fmt: skip
    w.hub.copies[slug] = copy
    return copy


def head_says(copy):
    """The setup there answering as it does once checked out: the commit it's on."""
    return lambda script, stdin: Done(0, (git(copy.checkout, "rev-parse", "HEAD")).encode(), "")


def work_there(w, copy, files):
    """Commits made on the branch over there, as the bundle the back script prints."""
    there = w.tmp / "there"
    if not there.exists():
        git(w.tmp, "clone", "-q", "-b", copy.branch, copy.checkout, str(there))
    for name, text in files.items():
        (there / name).parent.mkdir(parents=True, exist_ok=True)
        (there / name).write_text(text)
        git(there, "-c", "user.email=x@y", "-c", "user.name=x", "add", "-A")
        git(there, "-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "-m",
            f"made {name}")  # fmt: skip
    done = subprocess.run(
        ["git", "-C", str(there), "bundle", "create", "-", f"refs/heads/{copy.branch}",
         f"^{copy.base}"], capture_output=True, check=True,
    )  # fmt: skip
    return done.stdout


# ── the kept list, and which session is which ──


def test_a_save_that_fails_is_logged_and_never_raises(world, monkeypatch):
    """A full disk while saving the hand-offs leaves the desk working, not crashed."""

    def full(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(jsonstore, "save_json", full)
    add_machine(world.desk)
    world.desk.save()
    assert not world.desk.path.exists()


def test_a_record_whose_session_is_gone_finds_no_task(world):
    """A hand-off kept for a Claude Code session this Mac no longer has belongs to no task."""
    rec = Handoff(id="x", alias="studio", slug="x", project="p", branch="b", base="c",
                  session_id="long-gone", task_id=1, started=0)  # fmt: skip
    world.hub.tasks.add(session_id="someone-else")
    assert world.desk.task_of(rec) is None


def test_a_cloud_started_session_is_found_by_its_copys_folder_and_others_are_skipped(world):
    """A record with no session id is matched by its isolated copy's folder; sessions with a
    Claude Code session of their own, and forks, are never taken for it."""
    world.hub.copies["s9"] = SimpleNamespace(cwd="/copies/s9")
    tm = world.hub.tasks
    tm.add(session_id="has-one", cwd="/copies/s9")
    tm.add(fork=True, cwd="/copies/s9")
    mine = tm.add(cwd="/copies/s9")
    rec = Handoff(id="s9", alias="studio", slug="s9", project="p", branch="b", base="c")
    assert world.desk.task_of(rec) is mine and rec.task_id == mine.id
    nowhere = Handoff(id="s8", alias="studio", slug="s8", project="p", branch="b", base="c")
    assert world.desk.task_of(nowhere) is None


# ── machines ──


async def test_machines_have_a_cap_and_unknown_or_busy_ones_say_so(world, monkeypatch):
    """The list stops at its cap; testing or checking a machine never added names it; one a
    session runs on can't be removed until it's back."""
    desk = world.desk
    desk.ssh_config.write_text("Host studio box\n")
    add_machine(desk)
    monkeypatch.setattr(handoff, "MACHINES_MAX", 1)
    assert await desk.add_machine("box") == "There are already 1 machines; remove one first."
    assert await desk.test_machine("box") == "Add box in Eden Code settings › Machines first."
    assert await desk.check_machine("box") == "Add box in Eden Code settings › Machines first."
    assert desk.remove_machine("box") == ""
    record(world, state="working")
    assert desk.remove_machine("studio") == (
        "studio is in use by a session handed off there: bring it back first."
    )
    assert desk.machine("studio") is not None


async def test_the_machine_window_commands_caption_what_happened(world):
    """Settings › Machines: the list is published, and add/test/remove answer in a caption
    (nothing when there is nothing to say)."""
    desk, hub = world.desk, world.hub
    desk.cmd_machines({})
    assert hub.events[-1][0] == "code_handoffs"
    await desk.cmd_add({"alias": "nowhere"})
    await desk.cmd_test({"alias": "nowhere"})
    desk.cmd_remove({"alias": "nowhere"})
    assert hub.captions() == [
        "nowhere isn't a host in your SSH config (~/.ssh/config).",
        "Add nowhere in Eden Code settings › Machines first.",
    ]


# ── before a hand-off: what can stop it ──


async def test_a_session_already_on_a_machine_or_being_handed_off_isnt_sent_again(world):
    """Already there, its copy gone, or a hand-off of the same copy under way: each is said,
    and nothing is run there."""
    desk = world.desk
    add_machine(desk)
    there = session(world, workspace={"slug": "s1"})
    record(world, there)
    assert await desk.ready(there, "studio") == "It's already on studio."
    lost = session(world, session_id="local-2", workspace={"slug": "gone"})
    assert await desk.ready(lost, "studio") == "That session's isolated copy isn't there any more."
    world.hub.copies["s2"] = SimpleNamespace(slug="s2")
    moving = session(world, session_id="local-3", workspace={"slug": "s2"})
    desk._busy.add("s2")
    assert await desk.ready(moving, "studio") == "It's already being handed off."
    assert world.remote.calls == []


async def test_an_unreachable_machine_stops_the_hand_off_before_its_card(world):
    """The machine is checked first: down, the session doesn't move and no card is shown."""
    desk = world.desk
    add_machine(desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    world.remote.on("reach", Done(255, b"", UNREACHABLE))
    assert await desk.hand_off(task, "studio") == "studio isn't reachable right now."
    assert world.hub.cards == [] and world.remote.kinds() == ["reach"]


async def test_a_copy_whose_folder_or_branch_moved_cant_be_handed_off(world):
    """The plan of what leaves the Mac needs the copy's folder, on its own branch."""
    desk = world.desk
    add_machine(desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    git(copy.checkout, "checkout", "-q", "main")
    assert await desk.ready(task, "studio", check=False) == (
        "The isolated copy isn't on its branch jarvis/s1 any more."
    )
    world.hub.copies["s1"] = Copy(**{**copy.__dict__, "checkout": str(world.tmp / "missing")})
    assert await desk.ready(task, "studio", check=False) == "The isolated copy's folder is missing."


def test_a_remote_address_with_a_password_or_an_option_in_it_never_goes_there(world):
    """The plan drops an origin with credentials in it, or one git could read as an option:
    the branch then goes as a bundle."""
    copy = make_copy(world)
    git(copy.checkout, "remote", "add", "origin", "https://me:hunter2@example.com/r.git")
    plan = world.desk._plan(copy)
    assert plan["url"] == "" and plan["remote"] == ""
    git(copy.checkout, "config", "remote.origin.url", "--upload-pack=touch /tmp/x")
    plan = world.desk._plan(copy)
    assert plan["url"] == "" and plan["remote"] == ""


async def test_a_hand_off_asked_by_voice_says_the_question_and_can_be_declined(world):
    """By voice the card's question is spoken; a no leaves the session here, untouched."""
    desk, hub = world.desk, world.hub
    add_machine(desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    hub.answers = ["deny"]
    assert await desk.hand_off(task, "studio", by_voice=True) == "Not handed off."
    assert hub.said == ["Continue this session on studio?"]
    assert hub.cards[0]["context"] == {"task_id": task.id, "tool": "handoff"}
    assert "setup" not in world.remote.kinds() and desk.handoffs == []


# ── handing off: each step that can fail, and the ways it succeeds ──


async def preapproved_hand_off(w, task):
    return await w.desk.hand_off(task, "studio", "carry on", preapproved=True)


async def test_work_that_cant_be_committed_keeps_the_session_here(world, monkeypatch):
    """A commit that fails (a hook, no git identity) moves nothing: the session closes here,
    told why."""
    add_machine(world.desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    monkeypatch.setattr(worktrees, "commit_all", lambda copy, message: "a hook said no")
    said_now = await preapproved_hand_off(world, task)
    assert said_now == "Couldn't commit its work: a hook said no"
    assert task.status == "closed" and said_now in said(task)
    assert world.desk.handoffs == [] and "send" not in world.remote.kinds()


async def test_a_bundle_that_cant_be_made_or_sent_keeps_the_session_here(world):
    """The branch has to get there: a bundle git can't write, or an SSH copy that drops,
    stops the hand-off with the reason in the owner's words."""
    desk = world.desk
    add_machine(desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    blocker = world.hub.feature_path("handoff") / "s1.bundle"
    blocker.mkdir(parents=True)  # a folder where the bundle would go: git can't write it
    said_now = await preapproved_hand_off(world, task)
    assert said_now.startswith("Couldn't make the bundle:"), said_now
    assert "send" not in world.remote.kinds() and task.status == "closed"

    blocker.rmdir()
    world.remote.on("send", Done(255, b"", UNREACHABLE))
    said_now = await preapproved_hand_off(world, task)
    assert said_now == "Couldn't send the branch to studio: studio isn't reachable right now."
    assert "setup" not in world.remote.kinds() and desk.handoffs == []
    assert not list(world.hub.feature_path("handoff").glob("*.bundle"))  # never left behind


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        (Done(handoff.SETUP_DIRTY, b"", "DIRTY"), "has uncommitted work from an earlier hand-off"),
        (Done(handoff.SETUP_AHEAD, b"", "AHEAD"), "has commits from an earlier hand-off"),
        (Done(9, b"", "fatal: checkout failed"), "Couldn't set up the checkout on studio: fatal"),
        (Done(0, b"0000 not the commit\n", ""), "Couldn't set up the checkout on studio: 0000"),
    ],
)
async def test_a_checkout_there_that_cant_be_set_up_keeps_the_session_here(world, answer, expected):
    """Leftover work there, an earlier hand-off's unreturned commits, a checkout that fails,
    or one that isn't on the commit sent: Claude Code is never started on it."""
    add_machine(world.desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    world.remote.on("setup", answer)
    said_now = await preapproved_hand_off(world, task)
    assert expected in said_now and task.status == "closed"
    assert "start" not in world.remote.kinds() and world.desk.handoffs == []


async def test_a_start_that_fails_and_whose_stop_fails_too_still_reports_the_start(world):
    """Claude Code didn't start there and the clean-up stop couldn't reach it either: the
    owner hears why it didn't start, and the session stays here."""
    add_machine(world.desk)
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    world.remote.on("setup", head_says(copy))
    world.remote.on("start", Done(1, b"", "tmux: server exited"))
    world.remote.on("stop", Done(255, b"", UNREACHABLE))
    said_now = await preapproved_hand_off(world, task)
    assert said_now == "Couldn't start Claude Code on studio: tmux: server exited"
    assert world.remote.kinds()[-2:] == ["start", "stop"] and world.desk.handoffs == []


async def test_a_push_that_fails_falls_back_to_a_bundle_and_the_session_carries_on_there(
    world, monkeypatch
):
    """The machine can fetch the project's remote but the push there fails: the branch goes
    as a bundle instead, Claude Code starts under tmux, and a CLI that can't ask runs in
    Accept edits (the session is told)."""
    desk = world.desk
    add_machine(desk, asks=False)
    copy = make_copy(world)
    git(copy.checkout, "remote", "add", "origin", str(world.tmp / "no-such-remote.git"))
    task = session(world, workspace={"slug": copy.slug})
    world.remote.on("setup", head_says(copy))
    world.remote.on("start", Done(0, b"tmux\n", ""))
    followed = []
    monkeypatch.setattr(desk, "_follow", followed.append)
    said_now = await preapproved_hand_off(world, task)
    assert said_now == "Handed off to studio: it carries on there in Accept edits."
    assert world.hub.cards == []  # preapproved, nothing found: no card
    kinds = world.remote.kinds()
    assert kinds.index("probe-remote") < kinds.index("send") < kinds.index("setup")
    rec = desk.of_task(task)
    assert rec.how == "bundle" and rec.keeper == "tmux" and rec.mode == "acceptEdits"
    assert followed == [rec] and task.busy and task.status == "running"
    assert task.last_action == "Working on studio"
    assert any("can't ask you from this Mac" in t for t in said(task))
    assert any(
        t.startswith("Continued on studio, on jarvis/s1 (sent over SSH)") for t in said(task)
    )
    kept = json.loads(desk.path.read_text())
    assert [h["id"] for h in kept["handoffs"]] == ["s1"]


async def test_a_cli_that_can_ask_sends_its_permission_requests_here(world, monkeypatch):
    """With a CLI that asks over stream-json, the hand-off says requests come here."""
    desk = world.desk
    add_machine(desk, asks=True)
    world.remote.on("probe", Done(0, b"jarvis-probe\ngit: git 2\nclaude: /x/claude\n"
                                     b"claude-permissions: yes\n", ""))  # fmt: skip
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    world.remote.on("setup", head_says(copy))
    world.remote.on("start", Done(0, b"nohup\n", ""))
    monkeypatch.setattr(desk, "_follow", lambda rec: None)
    said_now = await preapproved_hand_off(world, task)
    assert said_now == (
        "Handed off to studio: it carries on there, and its permission requests come here."
    )
    assert desk.of_task(task).keeper == "nohup"


# ── following what it says there ──


async def test_a_reader_already_running_is_never_doubled(world):
    """Asked to follow a hand-off it's already reading, the desk keeps the one reader."""
    rec = record(world)
    running = asyncio.get_running_loop().create_future()
    world.desk._followers[rec.id] = running
    world.desk._follow(rec)
    assert world.desk._followers[rec.id] is running and world.hub.spawned == []


async def test_a_record_brought_back_while_it_was_being_read_stops_the_reader(world):
    """The connection ended because it came back: there's nothing more to read."""
    rec = record(world)

    async def read_then_gone(r):
        world.desk.handoffs.remove(r)
        return False

    world.desk._read = read_then_gone
    assert await world.desk._follow_once(rec, 0) is True
    assert world.remote.calls == []


async def test_a_dropped_connection_that_cant_check_back_keeps_trying(world):
    """Lost, and the status check can't reach it either: the owner is told once, and the
    reader tries again later."""
    task = session(world)
    rec = record(world, task)

    async def dropped(_r):
        return False

    world.desk._read = dropped
    world.remote.on("status", Done(255, b"", UNREACHABLE))
    assert await world.desk._follow_once(rec, 0) is False
    assert await world.desk._follow_once(rec, 0) is False
    lost = [t for t in said(task) if t.startswith("Lost the connection to studio")]
    assert len(lost) == 1 and rec.id in world.desk._lost


async def test_a_folder_gone_there_ends_the_hand_off_as_failed(world):
    """Back in touch, but its folder there is gone: it's marked failed, the session stops
    working here, and its reader stops."""
    task = session(world, busy=True, status="running")
    rec = record(world, task)
    world.desk._lost.add(rec.id)

    async def dropped(_r):
        return False

    world.desk._read = dropped
    world.remote.on("status", Done(0, b"missing\n", ""))
    assert await world.desk._follow_once(rec, 0) is True
    assert rec.state == "failed" and rec.note == "Its folder on studio is gone."
    assert "Reconnected to studio." in said(task) and rec.note in said(task)
    assert not task.busy and task.last_action == "Ended on studio"
    # And the loop doesn't read a failed one again.
    await asyncio.wait_for(world.desk._follow_loop(rec), 5)


async def test_a_run_gone_without_an_exit_code_says_it_isnt_running(world):
    """No process and no exit code there (the machine restarted): the session is told it
    isn't running any more, and waits for a message to start it again."""
    task = session(world, busy=True)
    rec = record(world, task)

    async def dropped(_r):
        return False

    world.desk._read = dropped
    world.remote.on("status", Done(0, b"gone\n", ""))
    assert await world.desk._follow_once(rec, 0) is True
    assert rec.state == "ended"
    assert "Claude Code on studio isn't running any more." in said(task)


async def test_the_reader_with_no_ssh_to_run_gives_up_this_connection(world):
    """An ssh that can't even be started is a dropped connection, never a crash."""
    rec = record(world)
    assert await world.desk._read(rec) is False


async def test_the_reader_skips_beats_and_odd_lines_and_hears_the_end(world, monkeypatch):
    """What comes back over the connection: keep-alive beats are skipped, a line that isn't
    JSON is counted, the first real line after a drop says it reconnected, a line that
    breaks its handler doesn't stop the stream, and the run's exit code ends it."""
    from test_code_handoff import executable

    desk = world.desk
    task = session(world, busy=True)
    rec = record(world, task)
    desk._lost.add(rec.id)
    pending = asyncio.get_running_loop().create_future()
    desk._asks[rec.id] = {"perm1": pending}

    def text(words):
        return json.dumps({"type": "assistant", "parent_tool_use_id": None,
                           "message": {"content": [{"type": "text", "text": words}]}})  # fmt: skip

    out = world.tmp / "out.jsonl"
    out.write_text(
        "JARVIS-BEAT\n" "not json at all\n" + text("hello from there") + "\n"
        + text("boom") + "\n" + "JARVIS-EXIT 3\n"
    )  # fmt: skip
    desk.ssh = str(
        executable(world.tmp / "reader" / "ssh", f"#!/bin/sh\nexec cat {shlex.quote(str(out))}\n")
    )
    real = desk._assistant

    def fragile(rec_, task_, data):
        if data["message"]["content"][0]["text"] == "boom":
            raise RuntimeError("a line it can't take")
        real(rec_, task_, data)

    monkeypatch.setattr(desk, "_assistant", fragile)
    assert await asyncio.wait_for(desk._read(rec), 30) is True
    assert rec.seen == 3 and rec.state == "ended"
    assert "Reconnected to studio." in said(task) and "hello from there" in said(task)
    assert "Claude Code on studio ended (exit 3)." in said(task)
    assert pending.cancelled() and rec.id not in desk._lost
    assert json.loads(desk.path.read_text())["handoffs"][0]["seen"] == 3


def test_the_streamed_steps_show_up_in_the_session_as_they_would_here(world):
    """Thinking, to-dos, shell commands, sub-agents and their own sub-steps from there all
    land in the session's transcript; odd blocks are skipped."""
    desk = world.desk
    task = session(world)
    rec = record(world, task, state="idle", remote_cwd="/r")
    on = desk._on_line
    assert on(rec, "not json") is False
    on(rec, json.dumps({"type": "system", "subtype": "init", "session_id": "remote-9",
                        "cwd": "/r", "model": "claude-x"}))  # fmt: skip
    assert rec.remote_session == "remote-9" and rec.model == "claude-x"
    on(rec, json.dumps({"type": "assistant", "parent_tool_use_id": "toolu_parent", "message": {
        "content": ["junk", {"type": "tool_use", "id": "sub1", "name": "Read",
                             "input": {"file_path": "/r/a.py"}},
                    {"type": "text", "text": "a sub-agent's words stay inside"}]}}))  # fmt: skip
    on(rec, json.dumps({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [
        {"type": "thinking", "thinking": "  let me look  "},
        {"type": "tool_use", "id": "t1", "name": "TodoWrite",
         "input": {"todos": [{"content": "check it", "status": "pending", "activeForm": "x"}]}},
        {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "ls"}},
        {"type": "tool_use", "id": "t3", "name": "Agent",
         "input": {"description": "look around", "prompt": "find it", "subagent_type": "Explore"}},
    ]}}))  # fmt: skip
    roles = [e["role"] for e in task.transcript]
    assert roles == ["subtool", "thinking", "todos", "tool", "tool"]
    assert task.transcript[0]["parent"] == "toolu_parent"
    assert task.transcript[1]["text"] == "let me look"
    assert task.todos[0]["content"] == "check it" and task.commands == 1
    agent = task.transcript[-1]
    assert agent["tool"] == "Agent" and agent["agent"] == "Explore" and agent["detail"] == "find it"
    assert task.last_action == "Agent: look around"
    assert task.busy and task.status == "running" and rec.state == "working"
    # Tool results: a non-list is ignored, other blocks skipped, the Bash step marked done.
    on(rec, json.dumps({"type": "user", "message": {"content": "just words"}}))
    on(rec, json.dumps({"type": "user", "message": {"content": [
        {"type": "text", "text": "x"},
        {"type": "tool_result", "tool_use_id": "t2", "content": "a.py", "is_error": False}]}}))  # fmt: skip
    bash = next(e for e in task.transcript if e.get("tool_id") == "t2")
    assert bash["status"] == "done" and bash["output"] == "a.py"
    assert ("task_log_update", {"id": task.id, "tool_id": "t2", "status": "done",
                                "output": "a.py"}) in world.hub.tasks.events  # fmt: skip


def test_a_turn_there_that_ends_in_error_is_shown_and_its_odd_cost_ignored(world):
    """A result line with a cost that isn't a number keeps the cost so far; one that hit
    its turn limit says so in the session, and the turn is finished as failed."""
    task = session(world, busy=True)
    rec = record(world, task, run_cost=0.5, cost=0.5)
    assert world.desk._on_line(rec, json.dumps({
        "type": "result", "subtype": "error_max_turns", "is_error": True,
        "total_cost_usd": "lots", "duration_ms": 2000}))  # fmt: skip
    assert rec.cost == 0.5 and rec.run_cost == 0.5 and rec.turns == 1 and rec.state == "idle"
    assert "It stopped: that's the most steps one turn may take." in said(task)
    assert world.hub.tasks.finished == [(task.id, "failed")]
    assert not task.busy and task.last_action == "Waiting for you on studio"


async def test_lines_for_a_session_not_here_and_cancelled_requests_are_handled(world):
    """A hand-off whose session isn't on this Mac still reads (nothing is shown); a request
    there that's cancelled is dropped, its card withdrawn."""
    rec = record(world, None)
    line = {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}
    assert world.desk._on_line(rec, json.dumps(line)) is False
    world.desk._idle_task(rec, "nothing to idle")  # no session: nothing happens
    asked = asyncio.get_running_loop().create_future()
    world.desk._asks[rec.id] = {"perm1": asked}
    rec.pending = [{"request_id": "perm1", "tool": "Write", "input": {}}]
    world.desk._on_line(rec, json.dumps({"type": "control_cancel_request", "request_id": "perm1"}))
    assert rec.pending == [] and asked.cancelled()


# ── permission requests ──


async def test_a_request_already_being_asked_isnt_asked_twice(world):
    """The same request heard again (a reconnect re-reads it) keeps its one card."""
    rec = record(world)
    asking = asyncio.get_running_loop().create_future()
    world.desk._asks[rec.id] = {"perm1": asking}
    world.desk._ask(rec, {"request_id": "perm1", "tool": "Write", "input": {}})
    assert world.desk._asks[rec.id]["perm1"] is asking and world.hub.spawned == []


async def test_a_question_from_there_is_refused_with_a_way_to_ask_instead(world, monkeypatch):
    """AskUserQuestion can't come to the Mac: no card, and Claude Code there is told to ask
    in its reply instead."""
    rec = record(world, session(world))
    written = []

    async def write(r, lines, live_only=False):
        written.extend(lines)
        return True

    monkeypatch.setattr(world.desk, "_write", write)
    item = {"request_id": "q1", "tool": "AskUserQuestion", "input": {"questions": []}}
    rec.pending.append(item)
    await world.desk._ask_permission(rec, item)
    assert world.hub.cards == [] and rec.pending == []
    answer = json.loads(written[0])["response"]["response"]
    assert answer["behavior"] == "deny" and "ask the owner in your reply" in answer["message"]


async def test_a_plan_from_there_comes_as_an_approve_card(world, monkeypatch):
    """ExitPlanMode there asks here to approve its plan, shown as written."""
    task = session(world)
    rec = record(world, task)
    written = []

    async def write(r, lines, live_only=False):
        written.extend(lines)
        return True

    monkeypatch.setattr(world.desk, "_write", write)
    world.hub.answers = ["allow"]
    item = {"request_id": "p1", "tool": "ExitPlanMode", "input": {"plan": "1. do it"}}
    rec.pending.append(item)
    await world.desk._ask_permission(rec, item)
    card = world.hub.cards[0]
    assert card["question"] == "Approve the plan on studio?" and card["detail"] == "1. do it"
    assert [c for c, _ in card["choices"]] == ["allow", "deny"]
    assert card["context"] == {"tool": "ExitPlanMode", "task_id": task.id}
    assert json.loads(written[0])["response"]["response"]["behavior"] == "allow"


async def test_back_in_touch_answers_go_and_unanswered_requests_are_asked_again(world, monkeypatch):
    """After a reconnect: an answer that never got there is written now; a request nobody
    answered gets its card again."""
    rec = record(world)
    written = []

    async def write(r, lines, live_only=False):
        written.extend(lines)
        return True

    monkeypatch.setattr(world.desk, "_write", write)
    asked = []
    monkeypatch.setattr(world.desk, "_ask", lambda r, item: asked.append(item["request_id"]))
    rec.pending = [
        {"request_id": "a", "tool": "Write", "input": {}, "answer": "ANSWER-A"},
        {"request_id": "b", "tool": "Write", "input": {}},
    ]
    await world.desk._resend(rec)
    assert written == ["ANSWER-A"] and asked == ["b"]
    assert [p["request_id"] for p in rec.pending] == ["b"]


async def test_a_message_to_a_run_found_over_there_ends_it_here(world):
    """Written only into a live run, and the run there is over: it's taken as ended, its
    requests dropped and their cards withdrawn, nothing written."""
    rec = record(world)
    asked = asyncio.get_running_loop().create_future()
    world.desk._asks[rec.id] = {"perm1": asked}
    rec.pending = [{"request_id": "perm1", "tool": "Write", "input": {}}]
    world.remote.on("write", Done(handoff.WRITE_DEAD, b"", ""))
    assert await world.desk._write(rec, ["hi"], live_only=True) is False
    assert rec.state == "ended" and rec.pending == [] and asked.cancelled()


# ── the session's messages while it's there ──


async def test_messages_to_a_handed_off_session_go_there_or_say_why_not(world):
    """Pictures don't travel (said); an empty message isn't sent; a machine that can't be
    reached leaves the message unsent, said; a session not handed off is sent as usual."""
    hub, desk = world.hub, world.desk
    here = session(world, session_id="here-only")
    assert desk.route(here, "hello") is None
    task = session(world)
    rec = record(world, task, state="idle")
    assert desk.route(task, "   ") is False
    assert desk.route(task, "look at this", images=["x.png"]) is True
    await asyncio.gather(*hub.spawned)
    assert "Pictures don't go to studio; only the words were sent." in said(task)
    assert rec.state == "working" and task.busy and task.last_action == "Working on studio"
    world.remote.on("write", Done(255, b"", UNREACHABLE))
    desk.route(task, "again")
    await asyncio.gather(*hub.spawned)
    assert said(task)[-1] == (
        "Couldn't reach studio: the message wasn't sent. Try again when it's back."
    )


async def test_a_message_waiting_while_it_came_back_isnt_lost_silently(world):
    """Brought back while the message waited its turn: it isn't sent there, and the owner is
    told to send it again here."""
    task = session(world)
    rec = record(world, task)
    assert world.desk.route(task, "one more thing") is True
    world.desk.handoffs.remove(rec)  # the bring-back lands before the message goes
    await asyncio.gather(*world.hub.spawned)
    assert said(task)[-1] == (
        "It came back from studio before this message went there: send it again to carry on here."
    )
    assert world.remote.calls == []


async def test_a_message_after_the_run_ended_needs_its_machine_and_a_good_start(world):
    """A stopped hand-off starts again with the next message: not if its machine was
    removed, and a start that fails says why."""
    hub, desk = world.hub, world.desk
    task = session(world)
    record(world, task, state="stopped")
    desk.route(task, "carry on")
    await asyncio.gather(*hub.spawned)
    assert said(task)[-1] == (
        "studio isn't on your machines any more: bring the session back, or add it again."
    )
    add_machine(desk)
    world.remote.on("start", Done(1, b"", "no space left"))
    desk.route(task, "carry on")
    await asyncio.gather(*hub.spawned)
    assert said(task)[-1] == "Couldn't start Claude Code on studio: no space left"
    assert world.remote.kinds()[-2:] == ["start", "stop"]


async def test_interrupt_and_reconnect_go_to_the_machine_for_a_handed_off_session(
    world, monkeypatch
):
    """Interrupt writes an interrupt line there (nothing for a run that's over); reconnect
    reattaches the reader; a session not handed off goes to the usual handlers."""
    desk = world.desk
    calls = []

    async def inner_interrupt(task_id):
        calls.append(("interrupt", task_id))
        return True

    interrupt = desk.interrupt_wrapper(inner_interrupt)
    reconnect = desk.reconnect_wrapper(lambda task_id: calls.append(("reconnect", task_id)) or "x")
    here = session(world, session_id="here-only")
    assert await interrupt(here.id) is True and reconnect(here.id) == "x"
    assert calls == [("interrupt", here.id), ("reconnect", here.id)]
    task = session(world)
    rec = record(world, task, state="stopped")
    assert await interrupt(task.id) is False
    followed = []
    monkeypatch.setattr(desk, "_follow", followed.append)
    assert reconnect(task.id) == "reopened" and followed == []
    rec.state = "working"
    assert await interrupt(task.id) is True
    assert world.remote.kinds() == ["write"] and b"interrupt" in world.remote.calls[0][3]
    assert reconnect(task.id) == "reopened" and followed == [rec]


def test_the_turn_note_is_wrapped_once_and_adds_what_happened_there(world):
    """The note for the next message here joins any other feature's note, once."""
    tm, desk = world.hub.tasks, world.desk
    tm.turn_note = lambda task: "base note."
    desk._wrap_note()
    wrapped = tm.turn_note
    desk._wrap_note()
    assert tm.turn_note is wrapped
    task = session(world)
    desk._notes[task.id] = "it was away."
    assert tm.turn_note(task) == "base note. it was away."
    assert tm.turn_note(task) == "base note."


# ── bringing it back ──


async def test_a_hand_off_is_found_by_its_id_or_its_session(world):
    task = session(world)
    rec = record(world, task)
    assert world.desk.find({"handoff": rec.id}) is rec
    assert world.desk.find({"handoff": "nope"}) is None
    assert world.desk.find({"id": task.id}) is rec


async def test_bring_back_by_voice_asks_aloud_and_can_be_declined(world):
    """By voice the question is spoken; declined, nothing is stopped there."""
    task = session(world)
    rec = record(world, task)
    world.hub.answers = ["deny"]
    assert await world.desk.bring_back(rec, by_voice=True) == "Not brought back."
    assert world.hub.said == ["Bring jarvis/s1 back from studio?"]
    assert world.hub.cards[0]["context"] == {"task_id": task.id}
    assert world.remote.calls == [] and rec in world.desk.handoffs


async def test_bring_back_needs_the_copy_here_and_one_at_a_time(world):
    """No copy on this Mac to bring it into, or a bring-back already going: nothing runs."""
    rec = record(world)
    assert await world.desk.bring_back_now(rec) == (
        "The isolated copy it came from isn't on this Mac any more."
    )
    world.hub.copies["s1"] = SimpleNamespace(slug="s1")
    world.desk._busy.add(rec.id)
    assert await world.desk.bring_back_now(rec) == "It's already being handed off."
    assert world.remote.calls == []


async def test_bring_back_while_it_cant_be_stopped_there_leaves_it_running(world):
    """The machine can't be reached to stop it mid-turn: it stays handed off, still live,
    and the next bring-back can try again."""
    task = session(world, busy=True)
    rec = record(world, task)
    world.hub.copies["s1"] = SimpleNamespace(slug="s1")
    world.remote.on("stop", Done(255, b"", UNREACHABLE))
    assert await world.desk.bring_back_now(rec) == "studio isn't reachable right now."
    assert rec.live and rec in world.desk.handoffs and task.busy
    assert not world.desk._busy and not world.desk._stopping


async def test_bring_back_while_mid_turn_stops_its_reader_and_withdraws_its_cards(world):
    """Mid-turn there with a card waiting here: the stop cancels the reader and the card;
    a checkout that left its branch, or a commit that fails there, is said and kept."""
    task = session(world, busy=True)
    rec = record(world, task)
    world.hub.copies["s1"] = SimpleNamespace(slug="s1")
    loop = asyncio.get_running_loop()
    reader, card = loop.create_future(), loop.create_future()
    world.desk._followers[rec.id] = reader
    world.desk._asks[rec.id] = {"perm1": card}
    world.remote.on("back", Done(handoff.BACK_BRANCH, b"", ""))
    assert await world.desk.bring_back_now(rec) == (
        "On studio it isn't on jarvis/s1 any more: switch back there, then bring it back."
    )
    assert reader.cancelled() and card.cancelled() and rec.state == "stopped"
    assert rec in world.desk.handoffs
    world.remote.on("back", Done(4, b"", "error: git add failed"))
    assert await world.desk.bring_back_now(rec) == "Couldn't bring it back: error: git add failed"
    world.remote.on("back", Done(255, b"", UNREACHABLE))
    assert await world.desk.bring_back_now(rec) == (
        "Couldn't bring it back: ssh: connect to host studio port 22: Operation timed out"
    )


async def test_a_bundle_that_wont_fetch_changes_nothing_here(world):
    """What came back isn't a bundle git can read: the copy is untouched and the hand-off
    stays on the list to try again."""
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    rec = record(world, task, state="stopped", base=copy.base)
    head = git(copy.checkout, "rev-parse", "HEAD")
    world.remote.on("back", Done(0, b"this is not a bundle", ""))
    said_now = await world.desk.bring_back_now(rec)
    assert said_now.startswith("Couldn't bring it back:"), said_now
    assert git(copy.checkout, "rev-parse", "HEAD") == head and rec in world.desk.handoffs


async def test_several_commits_come_back_ready_to_land_with_their_words_marked(world):
    """Two commits there land in the copy; the next message here says so, the other
    machine's words fenced off as data."""
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug}, result="All done there.")
    rec = record(world, task, base=copy.base)
    data = work_there(world, copy, {"b.py": "one\n", "c.py": "two\n"})
    world.remote.on("back", Done(0, data, ""))
    reply = await world.desk.bring_back_now(rec)
    assert reply == "Brought back from studio: 2 commits in its isolated copy, ready to land."
    assert (Path(copy.checkout) / "c.py").read_text() == "two\n"
    assert world.desk.handoffs == [] and task.status == "closed"
    assert task.last_action == "Back from studio" and reply in said(task)
    note = world.hub.tasks.turn_note(task)
    assert note.index(UNTRUSTED_NOTE) < note.index("made c.py") < note.index("All done there.")


async def test_work_that_could_run_code_here_comes_back_parked_not_merged(world):
    """A change to Claude Code's settings there is parked under a ref of its own and named,
    and the copy's branch doesn't move."""
    copy = make_copy(world)
    task = session(world, workspace={"slug": copy.slug})
    rec = record(world, task, base=copy.base)
    data = work_there(world, copy, {".claude/settings.json": '{"hooks": {}}\n'})
    world.remote.on("back", Done(0, data, ""))
    reply = await world.desk.bring_back_now(rec)
    assert reply.startswith("Brought back as refs/jarvis/handoff/s1-")
    assert "not merged" in reply and ".claude/settings.json" in reply
    assert git(copy.checkout, "rev-parse", "HEAD").strip() == copy.base
    assert world.desk.handoffs == [] and reply in said(task)


def test_a_diff_that_cant_be_listed_counts_as_risky(world):
    """Not knowing what changed is never taken as nothing risky."""
    copy = make_copy(world)
    risky = Desk._risky_changes(Path(copy.checkout), "no-such-commit", "HEAD")
    assert risky == ["(couldn't list what it changed)"]


# ── stopping, forgetting, startup ──


async def test_stop_needs_a_live_run_and_a_machine_it_can_reach(world):
    rec = record(world, state="ended")
    assert await world.desk.stop(rec) == "It isn't running on studio."
    rec.state = "working"
    world.remote.on("stop", Done(255, b"", UNREACHABLE))
    assert await world.desk.stop(rec) == "studio isn't reachable right now."
    assert rec.state == "working" and not world.desk._stopping


def test_forget_drops_only_a_hand_off_that_isnt_running(world):
    """A live one must come back or stop first; a stopped one is forgotten, its session
    closed, the checkout there kept."""
    task = session(world)
    rec = record(world, task)
    assert world.desk.forget(None) == ""
    assert world.desk.forget(rec) == "Bring it back or stop it first."
    rec.state = "stopped"
    assert world.desk.forget(rec) == "Forgot it; the checkout on studio stays."
    assert world.desk.handoffs == [] and task.status == "closed"
    assert json.loads(world.desk.path.read_text())["handoffs"] == []


async def test_at_startup_running_hand_offs_are_read_again(world, monkeypatch):
    """Hand-offs live at the last quit get their reader back and their unanswered requests
    asked again; the session shows working or waiting as it was there. Ended ones aren't."""
    desk = world.desk
    real_sleep = asyncio.sleep

    async def no_wait(_seconds, *a, **k):
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    working_task = session(world, session_id="w")
    idle_task = session(world, session_id="i")
    working = record(world, working_task, id="w", slug="w")
    idle = record(world, idle_task, state="idle", id="i", slug="i")
    record(world, None, state="ended", id="e", slug="e")
    followed, resent = [], []
    monkeypatch.setattr(desk, "_follow", followed.append)

    async def resend(rec):
        resent.append(rec)

    monkeypatch.setattr(desk, "_resend", resend)
    await desk.watch()
    assert followed == [working, idle] and resent == [working, idle]
    assert working_task.busy and working_task.status == "running"
    assert working_task.last_action == "Working on studio"
    assert not idle_task.busy and idle_task.status == "waiting"
    assert idle_task.last_action == "Waiting for you on studio"
    assert world.hub.events[-1][0] == "code_handoffs"


async def test_the_hand_off_window_commands_caption_their_answers(world):
    """Continue on, bring back, stop and forget from the window answer in a caption."""
    desk = world.desk
    rec = record(world, None, state="stopped")
    await desk.cmd_handoff({"id": 99, "alias": "studio"})
    await desk.cmd_back({"handoff": "nope"})
    await desk.cmd_stop({"handoff": "nope"})
    desk.cmd_forget({"handoff": rec.id})
    assert world.hub.captions() == [
        "There's no Eden Code session to hand off.",
        "That session isn't on another machine.",
        "That session isn't on another machine.",
        "Forgot it; the checkout on studio stays.",
    ]


# ── the hand-off's voice tools ──


def handoff_tools(desk, monkeypatch):
    made = {}
    monkeypatch.setattr(
        code_handoff,
        "create_sdk_mcp_server",
        lambda name, tools: made.update({t.name: t for t in tools}),
    )
    desk.build_server()
    return {name: t.handler for name, t in made.items()}


def text_of(result):
    return result["content"][0]["text"]


async def test_continue_on_machine_by_voice_needs_a_machine_it_knows(world, monkeypatch):
    """No machines: say to add one. An unknown one: the machines are named. A known one with
    no session: said."""
    tools = handoff_tools(world.desk, monkeypatch)
    go = tools["continue_on_machine"]
    assert text_of(await go({"machine": "studio"})) == (
        "Add a machine in Eden Code settings › Machines first."
    )
    add_machine(world.desk)
    add_machine(world.desk, "box")
    assert text_of(await go({"machine": "laptop"})) == "Say which machine: studio, box."
    assert text_of(await go({"machine": "studio"})) == "There's no Eden Code session to hand off."


async def test_bring_back_by_voice_takes_the_only_hand_off_when_none_is_named(world, monkeypatch):
    """With one hand-off and no session said, that's the one: its card is asked aloud."""
    tools = handoff_tools(world.desk, monkeypatch)
    record(world, None)
    world.hub.answers = ["deny"]
    assert text_of(await tools["bring_back_from_machine"]({})) == "Not brought back."
    assert world.hub.said == ["Bring jarvis/s1 back from studio?"]


async def test_handoff_status_lists_machines_and_what_runs_on_them(world, monkeypatch):
    """The machines (ready or why not) and each hand-off's state and reported cost."""
    tools = handoff_tools(world.desk, monkeypatch)
    assert text_of(await tools["handoff_status"]({})) == "No machines yet."
    add_machine(world.desk)
    world.desk.machines.append(Machine(alias="box", problem="box isn't reachable right now."))
    world.desk.machines.append(Machine(alias="new"))
    task = session(world)
    record(world, task, cost=0.25)
    lines = text_of(await tools["handoff_status"]({})).splitlines()
    assert lines[:3] == ["studio: ready", "box: box isn't reachable right now.", "new: not checked"]
    assert lines[3].startswith(f"Session {task.id} (fix the login) on studio: working, $0.25")


# ── the cloud ──


def test_without_a_hand_off_desk_there_is_no_cloud_machine():
    """No hand-offs feature: no machine, and the window is told how to add one."""
    hub = CloudHub()
    hub.code_handoff = None
    cloud = Cloud(hub)
    assert cloud.alias() == "" and cloud.tr("same words") == "same words"
    cloud.state()
    assert hub.events[-1] == (
        "code_cloud",
        {"machine": "", "ready": False,
         "problem": "No cloud machine added in Eden Code settings › Machines."},
    )  # fmt: skip


def test_a_cloud_start_the_hub_didnt_make_a_session_for_does_nothing_more():
    """The hub's own new-session step made nothing (it refused): nothing goes to the cloud,
    and nothing waits for it (the hub's refusal names its launch token: launches.refuse)."""
    from jarvis import launches

    hub = CloudHub()

    async def made_nothing(msg):
        launches.refuse(msg, "That folder isn't one of your projects.")  # (as the hub does)
        return None

    hub._handle = made_nothing
    msg = {"type": "task_new", "cloud": True, "prompt": "Fix it", "directory": "/p"}
    assert asyncio.run(Cloud(hub).task_new(msg)) is None
    assert hub.spawned == [] and hub.code_handoff.handed == []


def test_a_project_the_owner_works_in_is_known_by_its_folder_or_its_name(tmp_path):
    """A name that resolves to a session's folder, or to one of the owner's projects, is
    known; one that doesn't resolve, or resolves elsewhere, isn't."""
    hub = CloudHub()
    tm = hub.tasks
    tm.add(cwd="/p")
    cloud = Cloud(hub)
    assert cloud.known_project("/p") and not cloud.known_project("proj")  # no resolver

    web = tmp_path / "web"
    web.mkdir()

    def resolve(name):
        if name == "bad":
            raise ValueError("no such project")
        return {"proj": Path("/p"), "web": web.resolve()}.get(name, tmp_path / "other")

    tm.resolve_dir = resolve
    tm.projects = lambda: ["web"]
    tm.project_path = lambda name: tmp_path / name
    assert not cloud.known_project("bad")
    assert cloud.known_project("proj")  # its folder is a session's
    assert cloud.known_project("web")  # one of the owner's projects
    assert not cloud.known_project("elsewhere")


def test_heading_out_needs_a_machine_and_isnt_run_twice_at_once():
    hub = CloudHub(machines=())
    hub.tasks.add(busy=True, workspace={"slug": "a"})
    assert (
        asyncio.run(Cloud(hub).away())
        == "Add a cloud machine in Eden Code settings › Machines first."
    )
    cloud = Cloud(CloudHub())
    cloud._moving = True
    assert asyncio.run(cloud.away()) == "Already moving them."


def test_heading_out_with_nothing_movable_names_each_and_why():
    """Every working session either can't go or was started by an issue: no card, each is
    named with its reason, nothing paused."""
    hub = CloudHub()
    tm = hub.tasks
    held = tm.add(busy=True, workspace={"slug": "a"}, title="Held")
    issue = tm.add(busy=True, workspace={"slug": "b"}, title="Issue 7")
    hub.code_handoff.why = {held.id: "The isolated copy's folder is missing."}
    hub.code_runs = SimpleNamespace(
        run_of=lambda task: SimpleNamespace(untrusted=task.id == issue.id)
    )
    said_now = asyncio.run(Cloud(hub).away())
    assert said_now == (
        "None of them can move right now. Held: The isolated copy's folder is missing. "
        "Issue 7: started by an issue"
    )
    assert hub.cards == [] and tm.interrupted == []


def test_heading_out_by_voice_says_the_question_and_a_session_that_wont_pause_stays(
    monkeypatch,
):
    """By voice the card is spoken. A session that's still busy after its interrupt isn't
    moved: it's named as not pausing in time."""
    monkeypatch.setattr(code_cloud, "IDLE_WAIT", 0.1)
    hub = CloudHub()
    stubborn = hub.tasks.add(busy=True, workspace={"slug": "a"}, title="Stubborn")

    async def ignores_it(task_id):
        hub.tasks.interrupted.append(task_id)
        return True

    hub.tasks.interrupt = ignores_it
    said_now = asyncio.run(Cloud(hub).away(by_voice=True))
    assert hub.said == ["Move 1 working session to jarvis-cloud?"]
    assert (
        said_now == "Moved 0 of 1 to jarvis-cloud: they keep working while the Mac sleeps. "
        "Not moved: Stubborn didn't pause in time."
    )
    assert hub.code_handoff.handed == [] and stubborn.busy


def test_the_away_command_answers_in_a_toast():
    hub = CloudHub()
    asyncio.run(Cloud(hub).cmd_away({}))
    kind, data = hub.events[-1]
    assert kind == "toast" and data["title"] == "Eden Code" and "nothing to move" in data["text"]


def cloud_tools(cloud, monkeypatch):
    made = {}
    monkeypatch.setattr(
        code_cloud,
        "create_sdk_mcp_server",
        lambda name, tools: made.update({t.name: t for t in tools}),
    )
    cloud.build_server()
    return {name: t.handler for name, t in made.items()}


def test_move_sessions_to_cloud_by_voice_runs_heading_out(monkeypatch):
    hub = CloudHub()
    tools = cloud_tools(Cloud(hub), monkeypatch)
    said_now = asyncio.run(tools["move_sessions_to_cloud"]({}))
    assert "nothing to move" in text_of(said_now)


def test_start_session_in_cloud_takes_the_latest_sessions_project_by_default(monkeypatch):
    """No project said: the latest Eden Code session's folder; and the start is never
    preapproved (the owner's card always asks)."""
    hub = CloudHub()
    hub.tasks.add(cwd="/p")
    hub.tasks.add(cwd="/q")
    cloud = Cloud(hub)
    started = []

    async def task_new(msg, asked=True):
        started.append((msg, asked))

    monkeypatch.setattr(cloud, "task_new", task_new)
    tools = cloud_tools(cloud, monkeypatch)
    said_now = text_of(asyncio.run(tools["start_session_in_cloud"]({"prompt": "Fix the tests"})))
    assert "A card asks the owner before it starts on jarvis-cloud" in said_now
    msg, asked = started[0]
    assert msg["directory"] == "/q" and msg["prompt"] == "Fix the tests" and asked is False


def test_start_session_in_cloud_needs_what_where_and_a_machine(monkeypatch):
    """No prompt, or no project and no session to take one from, or no cloud machine: each
    is said and nothing starts."""
    hub = CloudHub()
    start = cloud_tools(Cloud(hub), monkeypatch)["start_session_in_cloud"]
    assert text_of(asyncio.run(start({"prompt": "x"}))) == "Say what to do, and in which project."
    assert text_of(asyncio.run(start({"prompt": "  ", "project": "/p"}))) == (
        "Say what to do, and in which project."
    )
    hub = CloudHub(machines=())
    hub.tasks.add(cwd="/p")
    start = cloud_tools(Cloud(hub), monkeypatch)["start_session_in_cloud"]
    assert text_of(asyncio.run(start({"prompt": "x", "project": "/p"}))) == (
        "Add a cloud machine in Eden Code settings › Machines first."
    )
    assert len(hub.tasks.tasks) == 1 and hub.spawned == []
