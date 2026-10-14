"""Spec mode (features/code_spec.py): requirements → design → tasks in the repository, a card
between each step; then each task as a session of its own, checked against its acceptance
criteria (tests named after them, else a faked reviewer), tasks.md ticked; and the proof in
the receipt (code_receipts) and the pull request's body (code_pr).

Sessions, the test suite and the reviewer are fakes; GitHub is tests/github_fakes.py."""

import asyncio
from types import SimpleNamespace as NS

import pytest
import test_code_pr as pr
from test_code_pr import fake_ai, github_project, session

from jarvis import code_ai, codetests
from jarvis.features import code_receipts as cr
from jarvis.features import code_spec as cs
from jarvis.tasks import ClaudeTask

# test_code_pr's hub (cards answered from hub.answers, GitHub faked) and its folders.
_no_real_gh, hub, projects = pr._no_real_gh, pr.hub, pr.projects

REQUIREMENTS = """# Login spec

Short summary.

## R1: Sign in with email
As a user, I want to sign in, so that I see my things.
- R1.1 WHEN the email and password are right THEN the dashboard shows
- R1.2 WHEN the password is wrong THEN an error says so

## R2: Remember me
- R2.1 the session lasts a week
"""
TASKS = """# Tasks

- [ ] T1: The sign-in form and its errors (R1)
- [ ] T2: Remember me (R2)
"""


def test_the_files_are_read_as_the_format_says():
    reqs = cs.parse_requirements(REQUIREMENTS)
    assert [r.id for r in reqs] == ["R1", "R2"] and reqs[0].title == "Sign in with email"
    assert [c.id for c in reqs[0].criteria] == ["R1.1", "R1.2"]
    assert cs.testable(reqs[0].criteria[1]) and not cs.testable(reqs[1].criteria[0])
    tasks = cs.parse_tasks(TASKS)
    assert [(t.id, t.requirements, t.done) for t in tasks] == [
        ("T1", ["R1"], False),
        ("T2", ["R2"], False),
    ]
    ticked = cs.tick(TASKS, "T2")
    assert "- [x] T2: Remember me (R2)" in ticked and "- [ ] T1" in ticked
    assert cs.parse_tasks(ticked)[1].done
    assert cs.slug_of("Add a login page!", {"add-a-login-page"}) == "add-a-login-page-2"
    assert cs.named_after("test_r1_2_wrong_password_shows_an_error", "R1.2")
    assert cs.named_after("R1.2 when the password is wrong", "R1.2")
    assert not cs.named_after("test_r1_20_other", "R1.2")
    assert code_ai.model_for("spec_check") == "claude-haiku-4-5"


@pytest.fixture
def spec_hub(hub, projects, monkeypatch):
    folder = projects / "app"
    folder.mkdir()
    started, sent = [], []

    async def new_session(msg):
        task = ClaudeTask(
            id=100 + len(started), prompt=msg["prompt"], cwd=folder, title=msg["title"]
        )
        hub.tasks.tasks[task.id] = task
        started.append(msg)
        return task

    desk = hub.code_spec
    monkeypatch.setattr(desk, "new_session", new_session)
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text)) or True
    )
    hub.started, hub.sent, hub.folder = started, sent, folder
    resolve = hub.resolve  # an answer can be (choice, the owner's words), as a card's box sends
    monkeypatch.setattr(
        hub, "resolve", lambda i, a: resolve(i, *a) if isinstance(a, tuple) else resolve(i, a)
    )
    return hub


async def test_each_step_waits_for_the_owners_ok_and_change_something_sends_their_words(spec_hub):
    hub, desk = spec_hub, spec_hub.code_spec
    assert (
        await desk.start({"prompt": "Add a login page", "directory": "app", "mode": "plan"}) == ""
    )
    [spec] = desk.specs
    assert spec.slug == "add-a-login-page" and spec.mode == "edits"  # (plan mode can't write)
    first = hub.started[0]
    assert (
        first["isolated"] is False and "specs/add-a-login-page/requirements.md" in first["prompt"]
    )
    assert "WHEN <situation> THEN" in first["prompt"] and "Add a login page" in first["prompt"]

    spec.root.mkdir(parents=True)
    (spec.root / "requirements.md").write_text(REQUIREMENTS)
    hub.answers = [("deny", "make R2 say how long")]
    assert await desk.after_step(spec) == "revise"
    card = hub.cards[-1]
    assert (
        card["question"]
        == "Spec add-a-login-page: the requirements are written. Go on to the design?"
    )
    assert "2 requirements, 3 acceptance criteria" in card["detail"]
    assert "Not written WHEN … THEN …: R2.1" in card["detail"]
    assert spec.step == "requirements" and "make R2 say how long" in hub.sent[-1][1]

    hub.answers = ["ok"]
    assert await desk.after_step(spec) == "design"
    assert "specs/add-a-login-page/design.md" in hub.sent[-1][1]

    (spec.root / "design.md").write_text("# Design\nA form.\n")
    hub.answers = ["ok"]
    assert await desk.after_step(spec) == "tasks"
    (spec.root / "tasks.md").write_text(TASKS)
    hub.answers = ["run"]
    assert await desk.after_step(spec) == "running"
    assert [c["id"] for c in hub.cards[-1]["choices"]] == ["run", "deny", "stop"]  # (no board)
    task_msg = hub.started[-1]
    assert task_msg["title"].startswith("add-a-login-page T1")
    assert "R1.1 WHEN the email and password are right" in task_msg["prompt"]
    assert "r1_2" in task_msg["prompt"] and spec.runs == {"T1": 101} and spec.current == "T1"
    assert cs.Specs(hub).specs[0].runs == {"T1": 101}  # kept


async def test_a_step_nobody_wrote_asks_again_and_a_turn_end_brings_the_card(spec_hub):
    hub, desk = spec_hub, spec_hub.code_spec
    await desk.start({"prompt": "Dark mode", "directory": "app"})
    spec = desk.specs[0]
    hub.answers = ["again"]
    desk.task_event("task_finished", {"id": spec.session, "task_kind": "code", "status": "done"})
    for _ in range(50):
        if hub.cards:
            break
        await asyncio.sleep(0.01)
    assert "didn't write specs/dark-mode/requirements.md" in hub.cards[0]["question"]
    for _ in range(50):
        if hub.sent:
            break
        await asyncio.sleep(0.01)
    assert "requirements.md" in hub.sent[-1][1]


async def test_one_projects_card_never_holds_back_another_projects_spec_of_the_same_name(
    spec_hub, projects
):
    """REL-14: slugs are unique within a project only; a card up for app's "dark-mode"
    spec doesn't stop web's "dark-mode" spec from bringing its own."""
    hub, desk = spec_hub, spec_hub.code_spec
    (projects / "web").mkdir()
    await desk.start({"prompt": "Dark mode", "directory": "app"})
    await desk.start({"prompt": "Dark mode", "directory": "web"})
    app, web = desk.specs
    assert app.slug == web.slug and app.folder != web.folder
    hub.answers = []
    desk.task_event("task_finished", {"id": app.session, "task_kind": "code", "status": "done"})
    for _ in range(100):  # app's card is up, unanswered
        if hub.cards:
            break
        await asyncio.sleep(0.01)
    assert len(hub.cards) == 1
    desk.task_event("task_finished", {"id": web.session, "task_kind": "code", "status": "done"})
    for _ in range(100):
        if len(hub.cards) > 1:
            break
        await asyncio.sleep(0.01)
    assert len(hub.cards) == 2, "web's spec was held back by app's card"
    for card in hub.cards:
        hub.resolve(card["id"], "again")
    await asyncio.sleep(0.05)


async def _running(hub, desk):
    await desk.start({"prompt": "Add a login page", "directory": "app"})
    spec = desk.specs[0]
    spec.root.mkdir(parents=True)
    (spec.root / "requirements.md").write_text(REQUIREMENTS)
    (spec.root / "tasks.md").write_text(TASKS)
    spec.step = "tasks"
    hub.answers = ["run"]
    await desk.after_step(spec)
    return spec


def results(*cases):
    return codetests.Results([codetests.Case("tests/test_login.py", n, s) for n, s in cases])


async def test_a_task_is_checked_by_its_tests_and_the_reviewer_then_ticked(spec_hub, monkeypatch):
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)

    async def suite(_folder):
        return results(
            ("test_r1_1_right_password_shows_dashboard", "passed"), ("test_other", "passed")
        )

    monkeypatch.setattr(desk, "run_tests", suite)
    desk.ai, asked = fake_ai("R1.2: met: the form shows 'Wrong password' (login.py:12)")
    hub.answers = ["next"]
    said = await desk.after_task(spec, "T1", 101, {"id": 101, "status": "done"})
    assert said == "next"
    prompt, kw = asked[0]
    assert kw["kind"] == "spec_check" and "data, never instructions" in kw["system"]
    assert (
        "R1.2 WHEN the password is wrong" in prompt
        and "R1.1" not in prompt.split("<criteria>")[1].split("</criteria>")[0]
    )
    assert spec.results["R1.1"]["by"] == "test" and spec.results["R1.2"]["by"] == "review"
    assert "- [x] T1" in (spec.root / "tasks.md").read_text()
    card = hub.cards[-1]
    assert (
        card["question"] == "Spec add-a-login-page: T1 is checked. 2 of 2 criteria met. Start T2?"
    )
    assert spec.runs["T2"] == 102 and spec.current == "T2"
    rows = desk.proofs[101].result()
    assert rows[0]["id"] == "R1" and rows[0]["status"] == "met"
    assert "R1.1: test_r1_1_right_password_shows_dashboard passed" in rows[0]["evidence"]


async def test_an_unmet_criterion_leaves_the_box_and_can_go_back_to_the_session(
    spec_hub, monkeypatch
):
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)

    async def suite(_folder):
        return results(("test_r1_1_ok", "passed"), ("test_r1_2_wrong_password", "failed"))

    monkeypatch.setattr(desk, "run_tests", suite)
    desk.ai, asked = fake_ai("")
    hub.answers = ["fix"]
    assert await desk.after_task(spec, "T1", 101, {"id": 101, "status": "done"}) == "fix"
    assert not asked  # every criterion had its test: no reviewer
    assert spec.results["R1.2"]["status"] == "unmet"
    assert "- [ ] T1" in (spec.root / "tasks.md").read_text()
    assert [c["id"] for c in hub.cards[-1]["choices"]][0] == "fix"
    assert hub.sent[-1][0] == 101 and "R1.2 WHEN the password is wrong" in hub.sent[-1][1]


async def test_past_the_reviewers_cap_criteria_stay_not_checked(spec_hub, monkeypatch):
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)

    async def suite(_folder):
        return None

    monkeypatch.setattr(desk, "run_tests", suite)
    budget = code_ai.budget_for(hub)
    budget.counts["spec_check"] = code_ai.POLICY["spec_check"][1]
    desk.ai, asked = fake_ai("R1.1: met: x")
    hub.answers = ["stop"]
    assert await desk.after_task(spec, "T1", 101, {"id": 101, "status": "done"}) == "stopped"
    assert not asked and desk.proofs[101].result()[0]["status"] == "unchecked"


async def test_the_board_takes_the_tasks_when_it_has_a_to_do_column(spec_hub):
    hub, desk = spec_hub, spec_hub.code_spec
    cards = []
    hub.code_board = NS(add_backlog=lambda **kw: cards.append(kw))
    await desk.start({"prompt": "Add a login page", "directory": "app"})
    spec = desk.specs[0]
    spec.root.mkdir(parents=True)
    (spec.root / "requirements.md").write_text(REQUIREMENTS)
    (spec.root / "tasks.md").write_text(TASKS)
    spec.step = "tasks"
    hub.answers = ["board"]
    assert await desk.after_step(spec) == "board"
    assert [c["source"] for c in cards] == [
        {"spec": "add-a-login-page", "task": "T1"},
        {"spec": "add-a-login-page", "task": "T2"},
    ]
    assert len(hub.started) == 1  # only the spec's own session


# ── the proof ──


async def test_the_receipt_carries_requirements_met_with_the_video_and_screenshot(
    spec_hub, monkeypatch
):
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)

    async def suite(_folder):
        return results(("test_r1_1_a", "passed"), ("test_r1_2_b", "passed"))

    monkeypatch.setattr(desk, "run_tests", suite)
    hub.answers = ["stop"]
    receipts = hub.code_receipts
    monkeypatch.setattr(receipts, "checking", lambda _id: False)
    task = hub.tasks.tasks[101]
    writing = asyncio.ensure_future(
        receipts.write(task, {"files": ["login.py"], "status": "done"}, 0)
    )
    await desk.after_task(spec, "T1", 101, {"id": 101, "status": "done"})
    receipt = await asyncio.wait_for(writing, 2)
    [row] = receipt["requirements"]
    assert row["id"] == "R1" and row["status"] == "met"
    entry = [e for e in task.transcript if e.get("receipt")][-1]
    assert "requirements met 1 of 1" in entry["text"]

    # A receipt with the video proof and the check's page: both become evidence.
    rows = desk.attach_receipt(
        101,
        [],
        {"video": {"id": "a" * 24, "seconds": 6}, "check": {"url": "http://localhost:3000"}},
    )
    assert "video proof of T1 (6 s)" in rows[0]["evidence"]
    assert "screenshot of http://localhost:3000 after T1" in rows[0]["evidence"]


async def test_a_receipt_waits_for_the_spec_check_and_says_how_many_are_met():
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    logged = []
    task = NS(id=7)
    spec = NS(
        covers=lambda _id: True,
        proof_future=lambda _id: fut,
        attach_receipt=lambda _id, rows, receipt: rows,
    )
    hub = NS(
        code_spec=spec,
        tasks=NS(
            tasks={7: task},
            _log=lambda t, r, text, **kw: logged.append((text, kw)),
            _changed_soon=lambda: None,
        ),
    )
    writing = asyncio.ensure_future(
        cr.Receipts(hub).write(task, {"files": ["a.py"], "status": "done"}, 0)
    )
    await asyncio.sleep(0.01)
    assert not writing.done()
    fut.set_result([{"id": "R1", "status": "met"}, {"id": "R2", "status": "unmet"}])
    receipt = await asyncio.wait_for(writing, 2)
    assert receipt["requirements"][1]["status"] == "unmet"
    assert "requirements met 1 of 2" in logged[0][0]


async def test_the_pull_request_body_ends_with_the_proof_once(hub, tmp_path, projects, monkeypatch):
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    desk = hub.code_spec
    spec = cs.Spec(
        slug="login", directory="app", folder=str(repo), request="login", runs={"T1": task.id}
    )
    spec.root.mkdir(parents=True)
    (spec.root / "requirements.md").write_text(REQUIREMENTS)
    (spec.root / "tasks.md").write_text(TASKS)
    spec.results = {
        "R1.1": {"status": "met", "by": "test", "tests": ["test_r1_1_a"], "task": "T1"},
        "R1.2": {"status": "met", "by": "review", "why": "error shown", "task": "T1"},
    }
    spec.media = {"T1": {"video": "a" * 24, "seconds": 5}}
    desk.specs.append(spec)
    hub.code_pr.ai, _asked = fake_ai("Sign in\n\nAdds the login.")
    draft = (await hub.code_pr.draft(task))["draft"]
    body = draft["body"]
    assert body.startswith("Adds the login.") and cs.PROOF_MARK in body
    assert "## Requirements met (1 of 2)" in body
    assert "- [x] **R1** Sign in with email: met" in body
    assert "R1.1: test_r1_1_a passed" in body and "video proof of T1 (5 s)" in body
    assert "- [ ] **R2** Remember me: not checked" in body
    assert hub.code_pr.with_spec_proof(task, body) == body  # never twice

    hub.answers = ["push"]
    said = await hub.code_pr.open(
        task, {"title": "Sign in", "body": "Typed by the owner.", "base": "main"}
    )
    assert said == "Opened pull request #7."
    import json

    [created] = hub.fake.sent("POST", "/repos/acme/app/pulls")
    sent_body = json.loads(created.content)["body"]
    assert sent_body.startswith("Typed by the owner.") and "## Requirements met" in sent_body


async def test_a_task_with_the_check_on_waits_for_this_turns_check(spec_hub, monkeypatch):
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)

    async def suite(_folder):
        return results(("test_r1_1_a", "passed"), ("test_r1_2_b", "passed"))

    monkeypatch.setattr(desk, "run_tests", suite)
    checks = hub.code_verify.session(101)
    checks.verify, checks.last = True, {"url": "http://localhost:1/old", "status": "ok"}
    hub.answers = ["stop"]
    going = asyncio.ensure_future(
        desk.after_task(spec, "T1", 101, {"id": 101, "status": "done", "files": ["a.py"]})
    )
    await asyncio.sleep(0.01)
    assert not going.done()  # the earlier turn's check isn't this one's
    desk.verified(
        {"id": 101, "state": "done", "last": {"url": "http://localhost:3000", "status": "ok"}}
    )
    await asyncio.wait_for(going, 2)
    assert spec.media["T1"]["screenshot"] == "http://localhost:3000"


async def test_after_a_restart_old_session_ids_never_attach_a_spec_to_new_sessions(
    spec_hub, monkeypatch
):
    """Round 1's D1: session ids start at 1 again each launch, so a spec kept with T1 on
    session 101 must not take the next launch's session 101 for its task."""
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)
    assert spec.runs == {"T1": 101} and spec.step == "running"
    monkeypatch.setattr(hub.tasks, "launch", "the-next-launch")  # (the app restarted)
    again = cs.Specs(hub)
    [kept] = again.specs
    assert again.of_session(101) == (None, "") and again.of_session(kept.session) == (None, "")
    assert kept.step == "stopped" and kept.current == "" and set(kept.runs) == {"T1"}
    assert not again.covers(101)
    started = len(asyncio.all_tasks())
    again.task_event("task_finished", {"id": 101, "task_kind": "code", "status": "done"})
    assert len(asyncio.all_tasks()) == started  # no check of somebody else's session
    again.save()
    assert cs.Specs(hub).specs[0].runs == {"T1": 0}  # (stamped with this launch now)


async def test_two_turn_ends_of_one_task_ask_once_and_start_one_next_task(spec_hub, monkeypatch):
    """Round 1's D11: a task's session can end several turns; the cards their checks bring
    must not each start the next task (two sessions at once in one folder)."""
    hub, desk = spec_hub, spec_hub.code_spec
    spec = await _running(hub, desk)
    (spec.root / "tasks.md").write_text(TASKS + "- [ ] T3: Log out (R1)\n")

    async def suite(_folder):
        return results(("test_r1_1_ok", "passed"), ("test_r1_2_ok", "passed"))

    monkeypatch.setattr(desk, "run_tests", suite)
    desk.ai, _asked = fake_ai("")
    hub.answers = []
    ends = [
        asyncio.ensure_future(desk.after_task(spec, "T1", 101, {"id": 101, "status": "done"}))
        for _ in range(2)
    ]
    for _ in range(100):
        if hub.cards and hub.cards[-1]["question"].endswith("Start T2?"):
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    asked = [c for c in hub.cards if "T1 is checked" in c["question"]]
    for card in asked:
        hub.resolve(card["id"], "next")
    said = await asyncio.gather(*ends)
    assert len(asked) == 1, said
    assert spec.runs == {"T1": 101, "T2": 102} and spec.current == "T2"


def test_an_unreadable_specs_file_is_never_saved_over(tmp_path):
    import json
    import os

    kept = tmp_path / "code_specs.json"
    kept.write_text(json.dumps([{"slug": "KEEP-ME", "directory": "a", "folder": "/a", "request": "x"}]))
    os.chmod(kept, 0)
    hub = NS(feature_path=lambda name: tmp_path / name, emit=lambda *a, **k: None,
             tasks=NS(launch="l"))  # fmt: skip
    try:
        desk = cs.Specs(hub)
        assert desk.specs == []
        desk.save()
        desk.save()
    finally:
        for f in tmp_path.iterdir():
            os.chmod(f, 0o600)
    assert "KEEP-ME" in kept.read_text()


def test_a_spec_reads_only_plain_files_inside_its_project_and_only_so_much(tmp_path):
    """Round 1's break: a FIFO at tasks.md held the whole app (every publish reads it); a
    linked requirements.md was read from outside the project; a huge file was read whole."""
    import os

    proj = tmp_path / "proj"
    root = proj / "specs" / "s1"
    root.mkdir(parents=True)
    spec = cs.Spec(slug="s1", directory="proj", folder=str(proj), request="x")
    os.mkfifo(root / "tasks.md")
    assert spec.read("tasks.md") == ""  # (at once: never waits for a writer)
    outside = tmp_path / "secret.md"
    outside.write_text("## R1: SECRET\n")
    os.symlink(outside, root / "requirements.md")
    assert spec.read("requirements.md") == ""
    (root / "design.md").write_bytes(b"x" * (cs.READ_MAX * 3))
    assert len(spec.read("design.md")) == cs.READ_MAX
    other = tmp_path / "elsewhere"
    (other / "s2").mkdir(parents=True)
    (other / "s2" / "tasks.md").write_text(TASKS)
    (proj / "specs" / "s2").symlink_to(other / "s2")  # (its folder a link out)
    assert cs.Spec(slug="s2", directory="proj", folder=str(proj), request="x").read("tasks.md") == ""
