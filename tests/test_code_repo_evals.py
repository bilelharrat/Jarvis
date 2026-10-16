"""Eden Code's evals for the owner's repository (features/code_repo_evals.py): cases from a
commit and from landed isolated copies, calibration, the forecast's card, a run of a suite on
two configurations in throwaway worktrees (scored on pass/fail, cost, time and diff size,
side by side, in the shared JSON format), the run's ceiling, its concurrency cap, Stop, and
an attempt's session options. Real git in temp repositories. Attempts run on a fake runner
(no session at all) or, once, as a real Eden Code session on a fake Claude Code: never a
real model."""

import asyncio
import json
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import CALENDAR_TURN, FakeClient
from test_code_changes import git, make_repo

from jarvis import codeevals
from jarvis.features import code_repo_evals
from jarvis.features.code_repo_evals import Job, _Options

FIXED = "def add(a, b):\n    return a + b\n"
WRONG = "def add(a, b):\n    return a - b\n"
CHECK = "PYTHONPATH=. python3 tests/check_add.py"


class Writes(FakeClient):
    """A Claude Code that, asked anything, fixes add() in its own folder."""

    script = CALENDAR_TURN

    async def query(self, text):
        Path(self.options.cwd, "calc.py").write_text(FIXED)
        await super().query(text)


class FakeRunner:
    """An attempt without a session: writes what the configuration's model would."""

    def __init__(self, answers=None, cost=0.25, delay=0.0):
        self.answers = answers or {}
        self.cost, self.delay = cost, delay
        self.calls, self.active, self.peak = [], 0, 0

    async def run(self, job):
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.calls.append(job)
        try:
            await asyncio.wait_for(job.stop.wait(), self.delay) if self.delay else None
        except TimeoutError:
            pass
        finally:
            self.active -= 1
        if job.stop.is_set():
            return {"status": "stopped", "cost": 0.0, "seconds": 0.0}
        text = self.answers.get(job.config.model)
        if text is not None:
            (job.cwd / "calc.py").write_text(text)
        return {"status": "done", "cost": self.cost, "seconds": 2.0, "model_id": job.config.model_id}


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
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


def last(hub, kind):
    found = [d for k, d in hub.events if k == kind]
    return found[-1] if found else None


def fixed_repo(projects):
    """proj: add() broken at the start; the landed commit fixes it and adds its test."""
    repo = make_repo(projects / "proj", {"calc.py": "def add(a, b):\n    return 0\n"})
    (repo / "calc.py").write_text(FIXED)
    (repo / "tests").mkdir()
    (repo / "tests" / "check_add.py").write_text("from calc import add\nassert add(1, 2) == 3\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "fix add")
    return repo


async def add_case(hub, **extra):
    evals = hub.code_evals
    said = await evals.add({"directory": "proj", "commit": "HEAD", "prompt": "Make add() add.", "command": CHECK, **extra})  # fmt: skip
    assert said == ""
    [case] = evals.cases("proj")
    assert await until(lambda: case.calibrated is not None and not evals.calibrating)
    return case


CONFIGS = [{"model": "opus", "label": "Opus 5.5"}, {"model": "sonnet", "label": "Sonnet 5.5", "effort": "low"}]


async def test_a_case_from_a_commit_is_calibrated(hub, projects):
    repo = fixed_repo(projects)
    evals = hub.code_evals
    assert await evals.add({"directory": "proj", "commit": "HEAD"}) == "Say what the task asked for."
    assert await evals.add({"directory": "proj", "commit": "nope", "prompt": "x"}) == "That isn't a commit in proj."
    case = await add_case(hub)
    assert case.base == git(repo, "rev-parse", "HEAD~1").strip() and case.landed
    assert case.test_files == ["tests/check_add.py"] and case.source == "commit"
    assert case.calibrated["base"] != 0 and case.calibrated["landed"] == 0
    assert case.public()["verdict"] == "ok"
    again = await evals.add({"directory": "proj", "commit": "HEAD", "prompt": "Same again.", "command": CHECK})
    assert again == "That task is an eval case already." and len(evals.cases("proj")) == 1
    assert len(git(repo, "worktree", "list").splitlines()) == 1  # (its worktrees are gone)
    state = last(hub, "code_evals")
    assert state["project"] == "proj" and state["cases"][0]["id"] == case.id
    # kept: a new hub's feature reads it back
    again = code_repo_evals.CodeEvals(hub)
    assert [c.id for c in again.cases("proj")] == [case.id]


async def test_a_case_without_tests_needs_a_check_command(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    (repo / "a.py").write_text("x = 2\n")
    git(repo, "commit", "-qam", "two")
    said = await hub.code_evals.add({"directory": "proj", "commit": "HEAD", "prompt": "Make x two."})
    assert said.startswith("Write a check command for it")
    hub.prefs.features["code_quick_tests"] = {"proj": "true"}  # (best of N's remembered command)
    assert await hub.code_evals.add({"directory": "proj", "commit": "HEAD", "prompt": "Make x two."}) == ""
    assert hub.code_evals.cases("proj")[0].command == "true"


async def test_a_run_asks_first_with_the_forecast_and_nothing_runs_on_not_now(hub, projects):
    fixed_repo(projects)
    case = await add_case(hub)
    runner = hub.code_evals.runner = FakeRunner()
    hub.answers = ["deny"]
    said = await hub.code_evals.start({"directory": "proj", "cases": [case.id], "configs": CONFIGS})
    assert said == "Not run." and runner.calls == [] and not hub.code_evals.runs
    [card] = hub.cards
    assert card["question"] == "Run 2 attempts on 2 configurations?"
    assert "(rough)" in card["detail"] and "$10.00 ceiling" in card["detail"]
    assert "Opus 5.5" in card["detail"] and "Sonnet 5.5 · low" in card["detail"]
    hub.code_evals.cmd_forecast({"directory": "proj", "cases": [case.id], "configs": CONFIGS})
    found = last(hub, "code_evals_forecast")
    assert found["attempts"] == 2 and found["rough"] and set(found["per_config"]) == {"c1", "c2"}


async def test_a_suite_runs_on_two_configurations_and_compares_them(hub, projects):
    repo = fixed_repo(projects)
    case = await add_case(hub)
    evals = hub.code_evals
    runner = evals.runner = FakeRunner({"opus": FIXED, "sonnet": WRONG})
    hub.answers = ["run"]
    assert await evals.start({"directory": "proj", "configs": CONFIGS}) == ""
    assert await until(lambda: not evals.runs)
    [record] = evals.results("proj")
    assert record["format"] == codeevals.FORMAT and record["status"] == "done"
    by = {r["config"]: r for r in record["results"]}
    assert by["c1"]["status"] == "passed" and by["c1"]["passed"] and by["c1"]["check_code"] == 0
    assert by["c2"]["status"] == "failed" and not by["c2"]["passed"]
    assert by["c1"]["files"] == 1 and by["c1"]["added"] == 1 and by["c1"]["removed"] == 1
    assert record["summary"]["c1"]["passed"] == 1 and record["summary"]["c2"]["passed"] == 0
    assert record["summary"]["c1"]["label"] == "Opus 5.5"
    assert record["spent_usd"] == 0.5 and record["cases"] == [case.id]
    # each attempt was in a worktree of its own at the case's start, now gone
    cwds = {j.cwd for j in runner.calls}
    assert len(cwds) == 2 and all(not c.exists() for c in cwds)
    assert all(c.name == "proj" for c in cwds)
    assert len(git(repo, "worktree", "list").splitlines()) == 1
    assert (repo / "calc.py").read_text() == FIXED  # (the owner's folder untouched)
    # the file other features read
    [path] = (evals.folder / "runs").glob("r*.json")
    assert json.loads(path.read_text())["summary"] == record["summary"]
    assert "Make add() add." not in path.read_text()  # (never prompt text)
    assert last(hub, "caption")["text"] == "Eval run done: Opus 5.5 1/1, Sonnet 5.5 · low 0/1"
    # a second forecast knows what they cost
    evals.cmd_forecast({"directory": "proj", "configs": CONFIGS})
    found = last(hub, "code_evals_forecast")
    assert not found["rough"] and found["usd"] == 0.5


async def test_the_run_stops_at_its_ceiling(hub, projects):
    fixed_repo(projects)
    await add_case(hub)
    evals = hub.code_evals
    hub.prefs.features["code_evals_ceiling"] = 0.6
    hub.prefs.features["code_evals_parallel"] = 1
    evals.runner = FakeRunner({"opus": FIXED, "sonnet": FIXED}, cost=0.58)
    hub.answers = ["run"]
    assert await evals.start({"directory": "proj", "configs": CONFIGS}) == ""
    assert await until(lambda: not evals.runs)
    [record] = evals.results("proj")
    statuses = [r["status"] for r in record["results"]]
    assert statuses == ["passed", "skipped"]
    assert record["results"][1]["error"] == "The run's ceiling was reached."
    assert evals.runner.calls[0].budget <= 0.6


async def test_attempts_at_once_are_capped_and_stop_stops_them(hub, projects):
    repo = fixed_repo(projects)
    evals = hub.code_evals
    await add_case(hub)
    (repo / "calc.py").write_text("def add(a, b):\n    return a + b + 0\n")
    git(repo, "commit", "-qam", "again")
    await add_case_again(hub)
    hub.prefs.features["code_evals_parallel"] = 2
    runner = evals.runner = FakeRunner({"opus": FIXED}, delay=30)
    hub.answers = ["run"]
    configs = [*CONFIGS, {"model": "haiku", "label": "Haiku 4.5"}]
    assert await evals.start({"directory": "proj", "configs": configs}) == ""
    assert await until(lambda: runner.active == 2)
    await asyncio.sleep(0.2)
    assert runner.peak == 2  # six attempts, two at a time
    # one run at a time per project
    hub.answers = ["run"]
    busy = await evals.start({"directory": "proj", "configs": CONFIGS})
    assert busy == "An eval run is going already in proj; stop it or wait for it."
    [run_id] = evals.runs
    evals.cmd_stop({"run": run_id})
    assert await until(lambda: not evals.runs, 30)
    [record] = evals.results("proj")
    assert record["status"] == "stopped" and len(record["results"]) == 6
    assert all(r["status"] == "skipped" for r in record["results"])
    assert len(runner.calls) == 2


async def add_case_again(hub):
    before = {c.id for c in hub.code_evals.cases("proj")}
    assert await hub.code_evals.add({"directory": "proj", "commit": "HEAD", "prompt": "Again.", "command": "true"}) == ""  # fmt: skip
    [new] = [c for c in hub.code_evals.cases("proj") if c.id not in before]
    assert await until(lambda: new.calibrated is not None)


async def test_a_router_configuration_needs_a_pick_for_every_case(hub, projects):
    fixed_repo(projects)
    case = await add_case(hub)
    evals = hub.code_evals
    routed = [{"router": True}]
    said = await evals.start({"directory": "proj", "configs": routed})
    assert said == "The Model Router had no pick for every case; try again in a moment."
    runner = evals.runner = FakeRunner({"": FIXED})
    hub.answers = ["run"]
    routes = {case.id: {"ref": "haiku", "effort": "low"}}
    assert await evals.start({"directory": "proj", "configs": routed, "routes": routes}) == ""
    assert await until(lambda: not evals.runs)
    assert runner.calls[0].route == {"ref": "haiku", "effort": "low"}


async def test_bad_suites_are_refused(hub, projects):
    fixed_repo(projects)
    evals = hub.code_evals
    assert await evals.start({"directory": "proj", "configs": CONFIGS}) == "Pick at least one case."
    await add_case(hub)
    assert await evals.start({"directory": "proj", "configs": []}) == "Pick one to four configurations."
    assert await evals.start({"directory": "proj", "configs": CONFIGS * 3}) == "Pick one to four configurations."
    assert await evals.start({"directory": "proj", "configs": [{"effort": "huge"}]}) == (
        "That configuration isn't one Eden can run."
    )
    assert await evals.start({"configs": CONFIGS}) == "Pick a project first."


async def test_an_attempts_session_gets_its_configurations_options(hub, tmp_path):
    evals = hub.code_evals
    claude = tmp_path / "2.1.0" / "claude"
    claude.parent.mkdir()
    claude.write_text("#!/bin/sh\n")
    claude.chmod(0o755)
    cfg = codeevals.config_from({"model": "sonnet", "engine": str(claude), "prompt": "lean", "rules": "off"}, 1)
    case = codeevals.Case("e1", "proj", "/p", "/p", "", "a" * 40, "x")
    job = Job(SimpleNamespace(), case, cfg, budget=1.25)
    task = SimpleNamespace(id=99)
    evals.by_task[99] = job
    options = SimpleNamespace(max_budget_usd=0.8, env={"A": "1"}, setting_sources=["user", "project"],
                              system_prompt={"type": "preset", "preset": "claude_code", "append": "Eden"},
                              cli_path=None)  # fmt: skip
    hook = _Options(evals)
    hook.apply(task, options)
    assert options.max_budget_usd == 0.8  # (a lower cap set before it is kept)
    assert options.cli_path == str(claude) and options.env["DISABLE_AUTOUPDATER"] == "1"
    assert options.setting_sources == []
    assert options.system_prompt == {"type": "preset", "preset": "claude_code"}
    assert hook.key(task) == (cfg.signature(), 1.25)
    assert evals.config_for(task)["rules"] == "off"
    # any other session: nothing
    other = SimpleNamespace(max_budget_usd=None, env={}, setting_sources=["user"], system_prompt="s", cli_path=None)
    hook.apply(SimpleNamespace(id=1), other)
    assert other.setting_sources == ["user"] and other.cli_path is None and hook.key(SimpleNamespace(id=1)) is None
    assert evals.config_for(SimpleNamespace(id=1)) is None
    # at a run's start, its hook goes after every other feature's
    evals._last_hook()
    assert isinstance(hub.tasks.option_hooks[-1], _Options)
    assert sum(isinstance(h, _Options) for h in hub.tasks.option_hooks) == 1


async def test_an_attempt_runs_as_a_real_session_on_a_fake_claude_code(hub, projects):
    """The real runner: an Eden Code session in the attempt's worktree (resolve_dir finds it
    there), its first turn, its cost, then the session ends and the check runs."""
    fixed_repo(projects)
    case = await add_case(hub)
    evals = hub.code_evals
    evals.runner.poll = 0.05
    hub.answers = ["run"]
    assert await evals.start({"directory": "proj", "configs": CONFIGS[:1]}) == ""
    assert await until(lambda: not evals.runs)
    [record] = evals.results("proj")
    [result] = record["results"]
    assert result["status"] == "passed", result
    assert result["case"] == case.id and result["files"] == 1
    [task] = [t for t in hub.tasks.tasks.values() if t.title.startswith("Eval: ")]
    assert task.status in ("stopped", "closed") and task.cwd.name == "proj"
    assert task.mode in ("auto", "smart") and not task.workspace
    assert evals.by_task == {} and evals.paths == {}


async def test_landed_isolated_work_becomes_a_candidate_then_a_case(hub, projects):
    repo = make_repo(projects / "proj", {"calc.py": "def add(a, b):\n    return 0\n"})
    task = hub.tasks.start("Make add() add, with a test.", "proj", isolate=True, title="fix add")
    assert await until(lambda: task.workspace and task.client is not None and not task.busy)
    copy = hub.code_desk.store().find(task.workspace["slug"])
    (copy.cwd / "tests").mkdir()
    (copy.cwd / "tests" / "check_add.py").write_text("from calc import add\nassert add(1, 2) == 3\n")
    task.cost_usd = 0.42
    evals = hub.code_evals
    ok, _said = await hub.code_desk.land_result(copy)
    assert ok
    assert await until(lambda: evals.candidates("proj"))
    [found] = evals.candidates("proj")
    assert found.prompt == "Make add() add, with a test." and found.base == copy.base
    assert found.landed == git(repo, "rev-parse", "main").strip()
    assert found.test_files == ["tests/check_add.py"] and found.cost == 0.42
    assert found.title == "fix add"
    # Add: its check is its own test, with the project's runner
    assert await evals.add({"candidate": found.id}) == ""
    [case] = evals.cases("proj")
    assert case.command == "python3 -m pytest -q tests/check_add.py"
    assert evals.candidates("proj") == []
    # with collecting off, nothing is kept
    hub.prefs.features["code_evals_collect"] = False
    task2 = hub.tasks.start("Another.", "proj", isolate=True, title="another")
    assert await until(lambda: task2.workspace and task2.client is not None and not task2.busy)
    copy2 = hub.code_desk.store().find(task2.workspace["slug"])
    (copy2.cwd / "b.py").write_text("b = 1\n")
    assert (await hub.code_desk.land_result(copy2))[0]
    await asyncio.sleep(0.3)
    assert evals.candidates("proj") == []
