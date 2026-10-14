"""Eden Code's best of N (features/code_bestof.py): one request run by two or three
sessions, each in its own isolated copy on its own model; their results compared (what
each changed, the owner's test command in each copy, a judgment from a fake Claude), and
"Keep this one" landing one copy and discarding the rest. Real git in temp repositories;
fake Claude Code sessions, each writing a file in its own folder."""

import asyncio
import json
import shlex
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import CALENDAR_TURN, FakeClient
from test_code_changes import git, make_repo

from jarvis import bestof_merge, code_ai, code_changes, worktrees
from jarvis.features import code_acp, code_bestof
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


# ── Merge best parts (bestof_merge.py) ──

BASE = (
    "def add(a, b):\n    return a + b\n"
    + "".join(f"# {i}\n" for i in range(12))
    + ("def sub(a, b):\n    return a - b\n")
)


class Edits(FakeClient):
    """A Claude Code that edits both functions of a.py its own way (by its model's name),
    and Opus also writes a new file: two attempts with hunks to mix."""

    script = CALENDAR_TURN

    async def query(self, text):
        who = "sonnet" if "sonnet" in self.options.model else "opus"
        path = Path(self.options.cwd, "a.py")
        body = path.read_text()
        body = body.replace("return a + b", f"return a + b  # {who}")
        body = body.replace("return a - b", f"return a - b  # {who}")
        path.write_text(body)
        if who == "opus":
            Path(self.options.cwd, "notes.txt").write_text("from opus\n")
        await super().query(text)


def ids_in(prompt):
    """The judge's listing: {id: the hunk's lines}."""
    found = {}
    for block in prompt.split("### [")[1:]:
        hunk_id, rest = block.split("]", 1)
        found[hunk_id] = rest
    return found


@pytest.fixture
async def merging(hub, projects):
    hub.tasks.client_factory = Edits
    repo = make_repo(projects / "proj", {"a.py": BASE})
    hub.code_bestof.ai = None
    return repo


async def test_merge_best_parts_mixes_hunks_tests_them_and_lands_after_review(
    hub, projects, merging
):
    repo = merging
    asked = []

    async def judge(prompt, **kw):
        asked.append((prompt, kw))
        if kw["kind"] == "judge":
            return "Both are fine."
        hunks = ids_in(prompt)
        pick = lambda word, fn: next(  # noqa: E731
            i for i, body in hunks.items() if f"{fn} # {word}" in body.replace("  ", " ")
        )
        new_file = next(i for i, body in hunks.items() if "notes.txt" in body)
        plan = {
            "hunks": [
                {"id": pick("sonnet", "a + b"), "why": "Sonnet's add is clearer."},
                {"id": pick("opus", "a - b"), "why": "Opus's sub."},
                {"id": pick("sonnet", "a - b"), "why": "clashes with the one before"},
                {"id": "9.9", "why": "not there"},
                {"id": new_file, "why": "keeps the notes"},
            ],
            "summary": "Sonnet's add, Opus's sub and its notes.",
        }
        return "Here you go:\n```json\n" + json.dumps(plan) + "\n```"

    hub.code_bestof.ai = judge
    hub.code_bestof.start(
        {
            "directory": "proj",
            "prompt": "tag both functions",
            "variants": [{"model": "sonnet"}, {"model": "opus"}],
            "tests": "grep -q sonnet a.py && grep -q opus a.py && echo mixed",
        }
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)
    # Not before they're done, and only for a group that's there.
    assert await hub.code_bestof.merge("nope") == "That comparison isn't there any more."
    assert await hub.code_bestof.merge(group["group"]) == ""
    merge = latest(hub)["merge"]
    assert merge["status"] == "ready", merge
    prompt, kw = asked[-1]
    assert kw["kind"] == "merge" and code_ai.model_for("merge") == "claude-haiku-4-5"
    assert kw["system"] == bestof_merge.SYSTEM
    assert "<request>\ntag both functions\n</request>" in prompt
    assert [(h["file"], h["label"], h["why"]) for h in merge["hunks"]] == [
        ("a.py", "Opus 5.5", "Opus's sub."),
        ("a.py", "Sonnet 5.5", "Sonnet's add is clearer."),
        ("notes.txt", "Opus 5.5", "keeps the notes"),
    ]
    assert len(merge["clashes"]) == 1 and merge["unknown"] == ["9.9"]
    assert merge["summary"] == "Sonnet's add, Opus's sub and its notes."
    assert merge["test"] == {"code": 0, "tail": "mixed\n"}
    # In a copy of its own, with a session there for the Changes pane (nothing sent to it).
    copy = hub.code_desk.store().find(merge["slug"])
    assert copy is not None and copy.group == group["group"] and copy.label == "Merged"
    text = (copy.cwd / "a.py").read_text()
    assert "a + b  # sonnet" in text and "a - b  # opus" in text
    assert (copy.cwd / "notes.txt").read_text() == "from opus\n"
    review = hub.tasks.tasks[merge["task_id"]]
    assert review.mode == "ask" and review.prompt == ""
    assert await until(lambda: review.workspace.get("slug") == copy.slug)
    assert "Merged 3 changes from 2 attempts" in review.transcript[0]["text"]
    view = code_changes.task_view(review, "session")
    assert sum(len(f.hunks) for f in view.files) == 3  # reviewed by hunk, as any session's
    assert not (repo / "notes.txt").exists()
    # Keep the merge: it lands, and every attempt's copy is discarded.
    hub.answers = ["keep"]
    said = await hub.code_bestof.keep(group["group"], 0)
    assert said.startswith("Kept the merge. Landed jarvis/merged-")
    card = hub.cards[-1]
    assert card["question"] == "Keep the merge and land it in main?"
    assert "3 changes from 2 attempts" in card["detail"]
    assert (repo / "a.py").read_text() == text and (repo / "notes.txt").exists()
    assert hub.code_desk.store().copies == [] and len(hub.code_desk.store().trash) == 2
    assert latest(hub)["status"] == "kept" and latest(hub)["kept"] == 0


async def test_a_merge_that_picks_nothing_or_is_over_its_cap_says_so(hub, projects, merging):
    answers = ["not json at all"]

    async def judge(prompt, **kw):
        return "fine" if kw["kind"] == "judge" else answers.pop(0)

    hub.code_bestof.ai = judge
    hub.code_bestof.start(
        {"directory": "proj", "prompt": "go", "variants": [{"model": "sonnet"}, {"model": "opus"}]}
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)["group"]
    await hub.code_bestof.merge(group)
    merge = latest(hub)["merge"]
    assert merge["status"] == "failed" and merge["error"] == "The judge picked nothing to merge."
    assert len(hub.code_desk.store().copies) == 2  # no copy made for nothing
    assert await hub.code_bestof.keep(group, 0) == "There's no merge to keep."
    code_ai.budget_for(hub).counts["merge"] = code_ai.POLICY["merge"][1]
    await hub.code_bestof.merge(group)
    assert latest(hub)["merge"]["error"] == "That's today's 10 merges; pick one to keep instead."
    assert answers == []  # past the cap, nothing is called


async def test_keeping_one_attempt_discards_the_merge_too(hub, projects, merging):
    async def judge(prompt, **kw):
        if kw["kind"] == "judge":
            return "ok"
        return json.dumps({"hunks": [{"id": next(iter(ids_in(prompt)))}]})

    hub.code_bestof.ai = judge
    hub.code_bestof.start(
        {"directory": "proj", "prompt": "go", "variants": [{"model": "sonnet"}, {"model": "opus"}]}
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)["group"]
    await hub.code_bestof.merge(group)
    assert latest(hub)["merge"]["status"] == "ready"
    assert len(hub.code_desk.store().copies) == 3
    hub.answers = ["keep"]
    said = await hub.code_bestof.keep(group, 2)
    assert said.startswith("Kept Opus 5.5.")
    assert "The other 2 copies are discarded" in hub.cards[-1]["detail"]
    assert hub.code_desk.store().copies == [] and len(hub.code_desk.store().trash) == 2


async def merged_group(hub):
    async def judge(prompt, **kw):
        if kw["kind"] == "judge":
            return "ok"
        return json.dumps({"hunks": [{"id": next(iter(ids_in(prompt)))}]})

    hub.code_bestof.ai = judge
    hub.code_bestof.start(
        {"directory": "proj", "prompt": "go", "variants": [{"model": "sonnet"}, {"model": "opus"}]}
    )
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    return latest(hub)["group"]


async def test_nothing_is_kept_while_a_merge_is_being_made(hub, projects, merging):
    """C7: Keep while merging would leave the merge's copy and session behind, unlisted;
    a merge begun while the Keep card was up stops the keep too."""
    group_id = await merged_group(hub)
    group = hub.code_bestof.groups[group_id]
    group.merge = {"status": "merging"}
    assert await hub.code_bestof.keep(group_id, 1) == "Wait for the merge to finish, then keep one."
    group.merge = None

    def merge_begins(card):
        group.merge = {"status": "merging"}
        hub.resolve(card["id"], "keep")

    hub.add_approval_sink(merge_begins)
    assert await hub.code_bestof.keep(group_id, 1) == "Wait for the merge to finish, then keep one."
    assert len(hub.code_desk.store().copies) == 2 and group.status != "kept"


async def test_merging_again_asks_before_the_last_merges_copy_goes(hub, projects, merging):
    group_id = await merged_group(hub)
    await hub.code_bestof.merge(group_id)
    first = latest(hub)["merge"]["slug"]
    branch = hub.code_desk.store().find(first).branch
    hub.answers = ["deny"]
    assert await hub.code_bestof.merge(group_id) == "Not merged again."
    assert hub.cards[-1]["question"] == "Merge again?" and branch in hub.cards[-1]["detail"]
    assert hub.code_desk.store().find(first) is not None
    hub.answers = ["merge"]
    assert await hub.code_bestof.merge(group_id) == ""
    assert hub.code_desk.store().find(first) is None
    assert latest(hub)["merge"]["status"] == "ready" and latest(hub)["merge"]["slug"] != first


async def test_a_merge_that_fails_after_its_copy_is_made_leaves_no_copy(
    hub, projects, merging, monkeypatch
):
    """C8: anything going wrong once the merge's copy exists discards it."""
    group_id = await merged_group(hub)

    def boom(*_a, **_k):
        raise RuntimeError("no session")

    monkeypatch.setattr(hub.code_bestof, "_review_session", boom)
    await hub.code_bestof.merge(group_id)
    merge = latest(hub)["merge"]
    assert merge["status"] == "failed" and merge["error"] == "no session"
    assert len(hub.code_desk.store().copies) == 2  # (the two attempts' only)


async def test_a_keep_without_a_number_never_means_the_merge(hub):
    kept = []

    async def keep(group, n):
        kept.append(n)
        return ""

    hub.code_bestof.keep = keep
    await hub.code_bestof._keep({"group": "b1"})
    await hub.code_bestof._keep({"group": "b1", "n": 0})
    assert kept == [0]


async def test_a_group_can_mix_another_agent_and_the_routers_pick(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    best = hub.code_bestof
    variants = [{"model": "acp:nobody"}, {"model": "sonnet"}]
    assert best.start({"directory": "proj", "prompt": "go", "variants": variants}) == (
        "That agent isn't set up any more: add it again in Other agents."
    )
    assert hub.tasks.tasks == {}  # nothing started for a group that can't all run
    hub.code_acp._book = code_acp.AgentBook(None)
    agent = hub.code_acp.book.add("Codex", "codex-acp")
    started = []
    real = hub.tasks.start

    def start(*args, **kw):
        started.append(kw)
        return real(*args, **kw)

    hub.tasks.start = start
    hub.code_bestof.ai = None
    said = best.start(
        {
            "directory": "proj",
            "prompt": "go",
            "variants": [
                {"model": f"acp:{agent['id']}", "effort": "high"},
                {"model": "sonnet", "effort": "low", "routed": True},
            ],
        }
    )
    assert said == ""
    group = latest(hub)
    assert [v["label"] for v in group["variants"]] == ["Codex", "Router: Sonnet 5.5 · low"]
    assert started[0]["model"] == "acp:codex" and started[0]["effort"] == ""
    assert started[0]["isolate"] is True and started[1]["model_ref"] == "sonnet"
    for task in list(hub.tasks.tasks.values()):
        hub.tasks.cancel(task.id)


async def test_without_the_acp_labs_module_another_agent_says_how_to_turn_it_on(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    del hub.code_acp
    said = hub.code_bestof.start(
        {
            "directory": "proj",
            "prompt": "go",
            "variants": [{"model": "acp:codex"}, {"model": "sonnet"}],
        }
    )
    assert said.startswith("Turn on Other agents (ACP) in Settings")


def test_the_merge_plan_keeps_known_hunks_once_and_leaves_out_clashes():
    from jarvis.code_changes import FileDiff, Hunk

    def entry(entry_id, n, path, old_start, lines, status="M"):
        h = Hunk(old_start, sum(t in " -" for t, _ in lines), old_start, 0, "", lines)
        f = FileDiff(path, status=status, hunks=[h])
        return bestof_merge.Entry(entry_id, n, f"#{n}", f, h, path)

    entries = {
        "1.1": entry("1.1", 1, "a.py", 1, [(" ", "a"), ("-", "b"), ("+", "B"), (" ", "c")]),
        # 2.1 rewrites the line 1.1 does: they clash
        "2.1": entry("2.1", 2, "a.py", 1, [(" ", "a"), ("-", "b"), ("+", "b2"), (" ", "c")]),
        # 2.2 adds a line right after line 2: it touches 1.1's change too
        "2.2": entry("2.2", 2, "a.py", 2, [(" ", "b"), ("+", "new"), (" ", "c")]),
        "2.3": entry("2.3", 2, "a.py", 20, [(" ", "t"), ("-", "u"), ("+", "U")]),
        "1.2": entry("1.2", 1, "n.txt", 0, [("+", "x")], status="?"),
        "2.4": entry("2.4", 2, "n.txt", 0, [("+", "y")], status="?"),
    }
    answer = json.dumps(
        {
            "hunks": [
                {"id": "[1.1]", "why": "w" * 500},
                "2.1",
                {"id": "2.2"},
                {"id": "2.3", "why": "far away"},
                {"id": "1.1"},
                {"id": "1.2"},
                {"id": "2.4"},
                {"id": "7.7"},
                42,
            ],
            "summary": "  a   plan ",
        }
    )
    plan = bestof_merge.read_plan(answer, entries)
    assert [p.entry.id for p in plan.picks] == ["1.1", "2.3", "1.2"]
    assert len(plan.picks[0].why) == bestof_merge.WHY_CHARS
    assert plan.clashes == [("2.1", "1.1"), ("2.2", "1.1"), ("2.4", "1.2")]
    assert plan.unknown == ["7.7"] and plan.summary == "a plan"
    assert bestof_merge.read_plan("no plan here", entries).picks == []
    assert bestof_merge.read_plan('{"hunks": "1.1"}', entries).picks == []


def test_credentials_binary_files_and_renames_are_left_out_of_the_merge(tmp_path):
    repo = make_repo(tmp_path / "r", {"a.py": "x = 1\n", "old.py": "y = 2\n", ".env": "K=1\n"})
    (repo / "a.py").write_text("x = 2\n")
    (repo / ".env").write_text("K=2\n")
    (repo / "pic.bin").write_bytes(b"\0\1\2")
    git(repo, "mv", "old.py", "new.py")
    view = code_changes.session_view(repo, [], scoped=False)
    entries, left_out = bestof_merge.catalogue([bestof_merge.Candidate(1, "Sonnet", view)])
    assert [e.shown for e in entries.values()] == ["a.py"]
    assert sorted(left_out) == [
        ".env (Sonnet) holds credentials",
        "new.py (Sonnet) was renamed",
        "pic.bin (Sonnet) is a binary file",
    ]
