"""Eden Code's evals, the parts with no hub (codeevals.py): which files are tests, the check a
case gets, configurations as the window sends them, the forecast, the scores, and the git
behind an attempt (a detached worktree, its diff, the landed tests copied in). Real git in
temp repositories; nothing here runs a session or calls a model."""

import json
import os
import stat
import subprocess

from test_code_changes import git, make_repo

from jarvis import codeevals
from jarvis.codeevals import Case, Config


def case(**kw):
    base = dict(id="e1", project="proj", folder="/p", repo="/p", prefix="", base="a" * 40, prompt="fix it")
    return Case(**{**base, **kw})


def test_test_files_are_found_by_their_paths():
    files = [
        "src/calc.py", "tests/test_calc.py", "pkg/test_util.py", "go/x_test.go",
        "web/app.test.mjs", "web/a.spec.ts", "src/__tests__/b.js", "README.md", "testing.py",
    ]  # fmt: skip
    assert codeevals.test_files(files) == [
        "tests/test_calc.py", "pkg/test_util.py", "go/x_test.go", "web/app.test.mjs",
        "web/a.spec.ts", "src/__tests__/b.js",
    ]  # fmt: skip


def test_a_cases_check_uses_the_projects_own_runner(tmp_path):
    assert codeevals.check_command(tmp_path, ["tests/test_a.py"], "", "") == "python3 -m pytest -q tests/test_a.py"
    (tmp_path / "uv.lock").write_text("")
    assert codeevals.check_command(tmp_path, ["tests/test_a.py"], "", "") == "uv run python -m pytest -q tests/test_a.py"
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").write_text("")
    assert codeevals.check_command(tmp_path, ["tests/test_a.py"], "", "").startswith(".venv/bin/python -m pytest")
    # inside a sub-project, its paths are its own
    assert codeevals.check_command(tmp_path, ["app/tests/test_b.py"], "app/", "").endswith(" tests/test_b.py")
    assert codeevals.check_command(tmp_path, ["t/a.test.mjs"], "", "") == "node --test t/a.test.mjs"
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest"}}))
    assert codeevals.check_command(tmp_path, ["t/a.test.ts"], "", "") == "npx vitest run t/a.test.ts"
    # no tests in the change: the project's test command, else none
    assert codeevals.check_command(tmp_path, [], "", " npm test ") == "npm test"
    assert codeevals.check_command(tmp_path, [], "", "") == ""
    # a quoted path never becomes two words
    assert codeevals.check_command(tmp_path, ["tests/test it.py"], "", "").endswith("'tests/test it.py'")


def test_configurations_are_checked_and_named(tmp_path):
    cfg = codeevals.config_from({"model": "sonnet", "label": "Sonnet 5.5", "effort": "high"}, 1)
    assert isinstance(cfg, Config) and cfg.id == "c1" and cfg.name() == "Sonnet 5.5 · high"
    lean = codeevals.config_from({"model": "opus", "label": "Opus 5.5", "prompt": "lean", "rules": "off"}, 2)
    assert lean.name() == "Opus 5.5 · lean prompt · rules off"
    assert codeevals.config_from({"router": True, "effort": "max"}, 3).name() == "Model Router"
    for bad in ({"effort": "huge"}, {"prompt": "short"}, {"rules": "maybe"}, "opus", None):
        assert codeevals.config_from(bad, 1) == "That configuration isn't one Eden can run."
    # an engine is a Claude Code program, never any program a message names
    sh = tmp_path / "bin" / "sh"
    sh.parent.mkdir()
    sh.write_text("#!/bin/sh\n")
    sh.chmod(0o755)
    assert codeevals.config_from({"engine": str(sh)}, 1) == "That engine isn't a Claude Code engine Eden can run."
    claude = tmp_path / "2.1.3" / "claude"
    claude.parent.mkdir()
    claude.write_text("#!/bin/sh\n")
    assert not codeevals.engine_ok(str(claude))  # (it can't run)
    claude.chmod(claude.stat().st_mode | stat.S_IXUSR)
    pinned = codeevals.config_from({"engine": str(claude), "engine_version": "2.1.3"}, 1)
    assert pinned.engine == str(claude) and pinned.name().endswith("engine 2.1.3")
    assert not codeevals.engine_ok("claude")  # (not a path)
    assert pinned.signature() != codeevals.config_from({}, 1).signature()


def test_the_forecast_prefers_what_it_measured_then_the_landed_cost_then_a_guess():
    sonnet = Config("c1", model="sonnet", model_id="claude-sonnet-5-5")
    opus = Config("c2", model="opus", model_id="claude-opus-5-5", effort="max")
    measured = case(id="e1")
    landed = case(id="e2", model="claude-sonnet-5-5", cost=0.30)
    unknown = case(id="e3")
    history = {("e1", sonnet.signature()): {"cost": 0.12, "seconds": 50.0}}
    assert codeevals.estimate(measured, sonnet, history) == (0.12, 50.0, "measured")
    usd, _s, basis = codeevals.estimate(landed, opus, history)
    assert basis == "scaled" and round(usd, 4) == round(0.30 * 5 / 3 * 1.6, 4)
    assert codeevals.estimate(unknown, sonnet, history)[2] == "guess"
    found = codeevals.forecast([measured, landed, unknown], [sonnet, opus], history, 2, 1.0)
    assert found["attempts"] == 6 and found["basis"] == {"measured": 1, "scaled": 2, "guess": 3}
    assert found["rough"] and found["over_ceiling"] and found["usd"] > 1.0
    assert set(found["per_config"]) == {"c1", "c2"}
    # all measured: not rough
    only = codeevals.forecast([measured], [sonnet], history, 1, 10.0)
    assert not only["rough"] and only["usd"] == 0.12 and not only["over_ceiling"]


def test_history_comes_from_earlier_runs_latest_first():
    cfg = Config("c1", model="sonnet", model_id="claude-sonnet-5-5")
    runs = [
        {"started": 2, "configs": [{"id": "c1", "signature": cfg.signature()}],
         "results": [{"case": "e1", "config": "c1", "status": "passed", "cost_usd": 0.5, "seconds": 9}]},
        {"started": 1, "configs": [{"id": "c1", "signature": cfg.signature()}],
         "results": [{"case": "e1", "config": "c1", "status": "failed", "cost_usd": 0.1, "seconds": 3},
                     {"case": "e2", "config": "c1", "status": "skipped", "cost_usd": 0}]},
    ]  # fmt: skip
    assert codeevals.history_from(runs) == {("e1", cfg.signature()): {"cost": 0.5, "seconds": 9.0}}


def test_scores_side_by_side():
    configs = [{"id": "c1", "label": "Opus 5.5"}, {"id": "c2", "label": "Sonnet 5.5"}]
    results = [
        {"config": "c1", "status": "passed", "cost_usd": 1.0, "seconds": 100, "added": 10, "removed": 2},
        {"config": "c1", "status": "passed", "cost_usd": 0.5, "seconds": 60, "added": 4, "removed": 0},
        {"config": "c2", "status": "failed", "cost_usd": 0.2, "seconds": 30, "added": 50, "removed": 9},
        {"config": "c2", "status": "skipped", "cost_usd": 0.0},
    ]
    s = codeevals.summarize(configs, results)
    assert s["c1"] == {"label": "Opus 5.5", "total": 2, "passed": 2, "failed": 0, "errors": 0, "skipped": 0,
                       "pass_rate": 1.0, "cost_usd": 1.5, "cost_per_pass": 0.75, "seconds_median": 80.0,
                       "diff_lines_median": 8}  # fmt: skip
    assert s["c2"]["passed"] == 0 and s["c2"]["cost_per_pass"] is None and s["c2"]["skipped"] == 1
    assert s["c2"]["seconds_median"] == 30.0 and s["c2"]["pass_rate"] == 0.0


def test_calibration_verdicts():
    assert codeevals.calibration_verdict(None) == ""
    assert codeevals.calibration_verdict({"base": 1, "landed": 0}) == "ok"
    assert codeevals.calibration_verdict({"base": 0, "landed": 0}) == "passes_at_start"
    assert codeevals.calibration_verdict({"base": 1, "landed": 2}) == "fails_landed"


def test_a_kept_case_is_read_defensively():
    good = case().__dict__
    assert codeevals.case_from(good).id == "e1"
    assert codeevals.case_from({**good, "base": "not a sha"}) is None
    assert codeevals.case_from({**good, "prompt": ""}) is None
    assert codeevals.case_from("x") is None
    kept = codeevals.case_from({**good, "test_files": ["ok/test_a.py", "../up.py", "/abs.py", 3], "extra": 1})
    assert kept.test_files == ["ok/test_a.py"]
    assert case().public()["base"] == "a" * 12


def test_the_landed_head_of_a_fast_forward_and_of_a_merge(tmp_path):
    repo = make_repo(tmp_path / "r", {"a.txt": "1\n"})
    git(repo, "checkout", "-qb", "jarvis/x")
    (repo / "a.txt").write_text("2\n")
    git(repo, "commit", "-qam", "work")
    work = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "-q", "--ff-only", "jarvis/x")
    assert codeevals.landed_head(str(repo), "jarvis/x", "main") == work
    # a merge commit as worktrees.land writes one: its second parent is the copy's work
    git(repo, "checkout", "-qb", "jarvis/y")
    (repo / "b.txt").write_text("y\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "y")
    y = git(repo, "rev-parse", "HEAD").strip()
    git(repo, "checkout", "-q", "main")
    (repo / "c.txt").write_text("c\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "other")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge jarvis/y: y", "jarvis/y")
    assert codeevals.landed_head(str(repo), "jarvis/y", "main") == y
    assert codeevals.landed_head(str(repo), "jarvis/y", "gone") == ""


def test_an_attempts_worktree_is_detached_measured_and_gets_the_landed_tests(tmp_path):
    repo = make_repo(tmp_path / "r", {"calc.py": "def add(a, b):\n    return 0\n"})
    base = git(repo, "rev-parse", "HEAD").strip()
    (repo / "calc.py").write_text("def add(a, b):\n    return a + b\n")
    (repo / "tests").mkdir()
    (repo / "tests" / "check_add.py").write_text("from calc import add\nassert add(1, 2) == 3\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "fix add")
    landed = git(repo, "rev-parse", "HEAD").strip()
    assert codeevals.resolve_commit(str(repo), "HEAD") == landed
    assert codeevals.resolve_commit(str(repo), "--all") == ""
    assert codeevals.first_parent(str(repo), landed) == base
    files = codeevals.changed_files(str(repo), base, landed, "")
    assert files == ["calc.py", "tests/check_add.py"]
    branches = git(repo, "branch", "--list")
    where = tmp_path / "attempts" / "one" / "r"
    assert codeevals.make_checkout(str(repo), base, where) == ""
    assert git(repo, "branch", "--list") == branches  # (no branch made in the owner's repository)
    assert (where / "calc.py").read_text().endswith("return 0\n")
    (where / "calc.py").write_text("def add(a, b):\n    return a + b\n")
    (where / "new.py").write_text("x = 1\ny = 2\n")
    assert codeevals.diff_stats(where, base) == {"files": 2, "added": 3, "removed": 1}
    assert codeevals.overlay_tests(where, landed, ["tests/check_add.py", "tests/gone.py"]) == ""
    env = {**os.environ, "PYTHONPATH": "."}
    ran = subprocess.run(["python3", "tests/check_add.py"], cwd=where, env=env, capture_output=True)
    assert ran.returncode == 0
    codeevals.remove_checkout(str(repo), where)
    assert not where.exists()
    assert len(git(repo, "worktree", "list").splitlines()) == 1


def test_a_run_record_is_in_the_shared_format():
    cfg = Config("c1", model="sonnet", label="Sonnet 5.5", model_id="claude-sonnet-5-5")
    record = codeevals.run_record("r1", "proj", "/x/proj", [cfg], 10.0)
    assert record["format"] == "eden-code-evals/1" and codeevals.readable_run(record)
    assert record["project_hash"] == codeevals.project_hash("/x/proj") and len(record["project_hash"]) == 12
    assert record["configs"][0]["label"] == "Sonnet 5.5" and record["configs"][0]["signature"]
    assert not codeevals.readable_run({**record, "format": "other"})
    json.dumps(record)  # (plain JSON)
