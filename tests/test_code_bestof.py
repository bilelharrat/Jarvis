"""Eden Code's best of N (features/code_bestof.py): one request run by two or three
sessions, each in its own isolated copy on its own model; their results compared (what
each changed, the owner's test command in each copy, a judgment from a fake Claude), and
"Keep this one" landing one copy and discarding the rest. Real git in temp repositories;
fake Claude Code sessions, each writing a file in its own folder."""

import asyncio
import shlex
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import CALENDAR_TURN, FakeClient
from test_code_changes import git, make_repo

from jarvis import code_ai, worktrees
from jarvis.features import code_bestof
from jarvis.tasks import Inbox


class Writes(FakeClient):
    """A Claude Code that, asked anything, writes which model it is into its own folder."""

    script = CALENDAR_TURN

    async def query(self, text):
        Path(self.options.cwd, "answer.txt").write_text(f"{self.options.model}\n")
        await super().query(text)


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import Transcriber

    from jarvis.hub import Hub

    hub = Hub(
        replace(settings, projects_dir=projects),
        client_factory=Writes,
        speaker=quiet_speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.code_bestof.poll = 0.05
    hub.cards, hub.answers = [], []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def until(condition, seconds=120.0):
    """Whether condition() comes true within seconds. Each variant is a real git copy and
    a test command: a Mac busy with other test runs can take a minute; it returns as soon as
    the condition holds."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


def latest(hub):
    found = [d for k, d in hub.events if k == "code_bestof"]
    return found[-1] if found else None


async def test_it_needs_a_request_two_variants_and_a_repository(hub, projects):
    (projects / "plain").mkdir()
    best = hub.code_bestof
    two = [{"model": "sonnet"}, {"model": "opus"}]
    assert (
        best.start({"directory": "plain", "prompt": "", "variants": two})
        == "Say what they should all do first."
    )
    assert (
        best.start({"directory": "plain", "prompt": "x", "variants": two[:1]})
        == "Pick two or three to compare."
    )
    assert best.start({"directory": "plain", "prompt": "x", "variants": two}) == (
        "plain isn't a git repository, so its variants can't each have a copy."
    )
    assert hub.tasks.tasks == {}


async def test_two_variants_run_in_their_own_copies_are_compared_and_one_is_kept(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    judged = []

    async def fake(prompt, **kw):
        judged.append((prompt, kw))
        return "Sonnet's answer is right; Opus's is too.\n\nBoth pass."

    hub.code_bestof.ai = fake
    said = hub.code_bestof.start(
        {
            "directory": "proj",
            "prompt": "write the answer",
            "variants": [
                {"model": "sonnet", "effort": "high"},
                {"model": "opus", "effort": "bogus"},
            ],
            "tests": "test -f answer.txt && echo checked",
        }
    )
    assert said == ""
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)
    assert [v["label"] for v in group["variants"]] == ["Sonnet 5.5 · high", "Opus 5.5"]
    tasks = [hub.tasks.tasks[v["task_id"]] for v in group["variants"]]
    assert all(t.workspace and t.mode == "edits" for t in tasks)  # each in its own copy
    assert tasks[0].cwd != tasks[1].cwd and not (repo / "answer.txt").exists()
    for v in group["variants"]:
        assert v["status"] == "done" and v["stats"] == {"files": 1, "added": 1, "removed": 0}
        assert v["test"] == {"code": 0, "tail": "checked\n"}
    assert group["judge"] == "Sonnet's answer is right; Opus's is too. Both pass."
    prompt, kw = judged[0]
    assert kw["kind"] == "judge" and code_ai.model_for("judge") == "claude-haiku-4-5"
    assert "<request>\nwrite the answer\n</request>" in prompt and "tests passed" in prompt
    assert "    1 + claude-sonnet-5-5" in prompt and "    1 + claude-opus-5-5" in prompt
    assert hub.prefs.feature("code_quick_tests") == {"proj": "test -f answer.txt && echo checked"}
    copies = hub.code_desk.store().copies
    assert {c.label for c in copies} == {"Sonnet 5.5 · high", "Opus 5.5"}
    # Keep the first: it lands, the other is discarded (kept as a recovery ref).
    hub.answers = ["keep"]
    said = await hub.code_bestof.keep(group["group"], 1)
    assert said.startswith("Kept Sonnet 5.5 · high. Landed jarvis/")
    card = hub.cards[-1]
    assert card["question"] == "Keep Sonnet 5.5 · high and land it in main?"
    assert "The other 1 copies are discarded" in card["detail"]
    assert (repo / "answer.txt").read_text() == "claude-sonnet-5-5\n"
    assert hub.code_desk.store().copies == [] and len(hub.code_desk.store().trash) == 1
    assert git(repo, "for-each-ref", "refs/jarvis/trash/").count("\n") == 1
    assert latest(hub)["status"] == "kept" and latest(hub)["kept"] == 1
    assert await hub.code_bestof.keep(group["group"], 2) == "That comparison isn't there any more."


async def test_a_failing_test_the_judges_cap_and_saying_not_now(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    judged = []

    async def fake(prompt, **kw):
        judged.append(prompt)
        return "never"

    hub.code_bestof.ai = fake
    code_ai.budget_for(hub).counts["judge"] = code_ai.POLICY["judge"][1]
    hub.code_bestof.start(
        {
            "directory": "proj",
            "prompt": "go",
            "variants": [
                {"model": "sonnet"},
                {"model": "haiku"},
                {"model": "opus"},
                {"model": "fable"},
            ],
            "tests": "exit 3",
        }
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)
    assert len(group["variants"]) == 3  # at most three
    assert all(v["test"]["code"] == 3 for v in group["variants"])
    assert group["judge"] == "That's today's 20 judgments; compare them yourself."
    assert judged == []  # past the cap, nothing is called
    hub.answers = ["deny"]
    assert await hub.code_bestof.keep(group["group"], 2) == ""
    assert len(hub.code_desk.store().copies) == 3 and not (repo / "answer.txt").exists()


async def test_a_variant_whose_copy_fails_is_stopped_rather_than_share_the_folder(
    hub, projects, monkeypatch
):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    real = worktrees.create
    made = []

    def flaky(*args, **kwargs):
        made.append(1)
        if len(made) == 2:
            raise worktrees.CopyError("The disk is full.")
        return real(*args, **kwargs)

    monkeypatch.setattr(worktrees, "create", flaky)

    async def fake(prompt, **kw):
        return "Only one got as far as an answer."

    hub.code_bestof.ai = fake
    hub.code_bestof.start(
        {"directory": "proj", "prompt": "go", "variants": [{"model": "sonnet"}, {"model": "opus"}]}
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    first, second = latest(hub)["variants"]
    assert first["status"] == "done" and second["status"] == "failed"
    assert await until(lambda: hub.tasks.tasks[second["task_id"]].handle.done())


async def test_the_test_command_is_stopped_when_it_runs_too_long(tmp_path, monkeypatch):
    monkeypatch.setattr(code_bestof, "TEST_SECONDS", 0.3)
    result = await code_bestof.run_tests("sleep 5", tmp_path)
    assert result == {"code": -1, "tail": "(stopped after 0.3 seconds)"}
    assert (await code_bestof.run_tests("printf 'x%.0s' $(seq 3000)", tmp_path))[
        "tail"
    ] == "x" * 2000


async def test_the_end_of_a_test_runs_output_keeps_whole_characters(tmp_path):
    # Read in pieces and only its end kept: a character of several bytes cut in two where
    # the kept bytes begin never shows as a broken one.
    for char in ("é", "中", "\U0001f600"):
        script = tmp_path / "say.py"
        script.write_text(f"import sys; sys.stdout.write({char!r} * 50_000 + 'end')")
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"
        result = await code_bestof.run_tests(command, tmp_path)
        assert result["code"] == 0
        assert result["tail"] == char * (code_bestof.TEST_OUTPUT - 3) + "end"


async def test_the_windows_hear_a_running_group_when_it_changes_not_at_every_look():
    """The variants work for minutes, looked at every poll: the group goes to the windows
    when something in it changed (each event redrew it in every window), and the same
    events as before otherwise, in the same order."""
    events = []

    def working(task_id, slug):
        return SimpleNamespace(
            id=task_id, status="running", transcript=[], busy=True, inbox=Inbox(),
            workspace={"slug": slug}, client=object(),
        )  # fmt: skip

    one, two = working(1, "a-1"), working(2, "b-2")
    hub = SimpleNamespace(
        tasks=SimpleNamespace(tasks={1: one, 2: two}),
        emit=lambda kind, **data: events.append((kind, data)),
    )
    best = code_bestof.BestOf(hub)
    best.poll = 0.01
    compared = []

    async def compare(group):
        compared.append(group.id)

    best.compare = compare
    group = code_bestof.Group(
        "g1", "proj", "do it", "",
        [code_bestof.Variant(1, "A", "", "", 1), code_bestof.Variant(2, "B", "", "", 2)],
    )  # fmt: skip
    watching = asyncio.ensure_future(best.watch(group))

    async def polls(n):
        for _ in range(n):
            await asyncio.sleep(best.poll)

    def done(task):
        task.busy, task.status = False, "waiting"
        task.transcript.append({"role": "turn"})

    await polls(5)
    done(one)
    await polls(5)
    done(two)
    await asyncio.wait_for(watching, 5)
    sent = [(d["status"], [(v["slug"], v["status"]) for v in d["variants"]]) for _, d in events]
    assert {k for k, _ in events} == {"code_bestof"}
    assert sent == [
        ("running", [("a-1", "working"), ("b-2", "working")]),
        ("running", [("a-1", "done"), ("b-2", "working")]),
        ("running", [("a-1", "done"), ("b-2", "done")]),
        ("comparing", [("a-1", "done"), ("b-2", "done")]),
    ]
    assert compared == ["g1"]


async def test_a_window_that_comes_back_mid_run_hears_the_group_again():
    """A window that missed events (cut off for falling behind, or its socket failed) comes
    back on a new connection, and code_bestof isn't replayed: at the next look it hears the
    group again, so its open pane doesn't show a finished variant still working until
    something else changes. Windows that stayed hear nothing twice."""
    heard = []  # what the window got
    window = {"queue": object()}

    def working(task_id, slug):
        return SimpleNamespace(
            id=task_id, status="running", transcript=[], busy=True, inbox=Inbox(),
            workspace={"slug": slug}, client=object(),
        )  # fmt: skip

    def emit(kind, **data):
        if window["queue"] is not None:
            heard.append((len(polled), [(v["slug"], v["status"]) for v in data["variants"]]))

    one, two = working(1, "a-1"), working(2, "b-2")
    hub = SimpleNamespace(
        tasks=SimpleNamespace(tasks={1: one, 2: two}), emit=emit, _subscribers={window["queue"]}
    )
    best = code_bestof.BestOf(hub)
    best.poll = 0.01
    polled = []

    async def compare(group):
        pass

    best.compare = compare
    group = code_bestof.Group(
        "g1", "proj", "do it", "",
        [code_bestof.Variant(1, "A", "", "", 1), code_bestof.Variant(2, "B", "", "", 2)],
    )  # fmt: skip
    watching = asyncio.ensure_future(best.watch(group))

    async def polls(n):
        for _ in range(n):
            await asyncio.sleep(best.poll)
            polled.append(1)

    def done(task):
        task.busy, task.status = False, "waiting"
        task.transcript.append({"role": "turn"})

    await polls(5)
    hub._subscribers.discard(window["queue"])  # the socket drops
    window["queue"] = None
    done(one)  # and the change happens while it's away
    await polls(5)
    window["queue"] = object()  # it reconnects: a new connection
    hub._subscribers.add(window["queue"])
    back = len(polled)
    await polls(10)
    assert not watching.done()  # two is still working
    since = [variants for at, variants in heard if at >= back]
    assert since == [[("a-1", "done"), ("b-2", "working")]]  # once, not at every look
    done(two)
    await asyncio.wait_for(watching, 5)
    assert heard[-1][1] == [("a-1", "done"), ("b-2", "done")]
