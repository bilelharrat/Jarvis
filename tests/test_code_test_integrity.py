"""Test-integrity receipts (features/code_test_integrity.py): before a receipt may say the
tests passed, the turn's changes to its tests are read for a test weakened, and a quick
mutation pass (off by default) shows how many small changes to its lines the tests catch."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace as NS

from jarvis import code_changes, prefs
from jarvis import codesupervisor as cs
from jarvis.features import code_test_integrity as ti


def change(path, added=(), removed=(), **kw):
    return ti.FileChange(path, list(added), list(removed), **kw)


def kinds(found):
    return [f.kind for f in found]


# ── the static check ──


def test_assertions_taken_out_or_commented_out_are_found():
    found = ti.inspect(
        [change("tests/test_signup.py", removed=["assert r.status == 422", "assert body['error']"])]
    )
    assert kinds(found) == ["assert_removed"]
    assert found[0].text.startswith("2 assertions taken out of tests/test_signup.py")
    commented = ti.inspect(
        [
            change(
                "test/signup.test.js",
                ["// assert.equal(r.status, 422);"],
                ["assert.equal(r.status, 422);"],
            )
        ]
    )
    assert kinds(commented) == ["assert_removed"]


def test_an_assertion_made_looser_is_found_but_a_stricter_one_isnt():
    looser = ti.inspect([change("tests/test_a.py", ["assert total"], ["assert total == 42"])])
    assert kinds(looser) == ["assert_loosened"]
    assert "`assert total == 42` became `assert total`" in looser[0].text
    js = ti.inspect([change("src/a.test.ts", ["expect(x).toBeDefined();"], ["expect(x).toBe(5);"])])
    assert kinds(js) == ["assert_loosened"]
    stricter = ti.inspect([change("tests/test_a.py", ["assert total == 42"], ["assert total"])])
    assert stricter == []
    # A test renamed, an assertion rewritten as strongly: nothing.
    same = ti.inspect(
        [
            change(
                "tests/test_a.py",
                ["def test_totals_add_up():", "assert add(2, 2) == 4"],
                ["def test_sum():", "assert add(1, 1) == 2"],
            )
        ]
    )
    assert same == []


def test_skips_only_and_swallowed_failures_are_found():
    found = ti.inspect(
        [
            change(
                "tests/test_a.py",
                [
                    "@pytest.mark.skip(reason='flaky')",
                    "except AssertionError:",
                    "pytest.xfail('later')",
                ],
            ),
            change(
                "web/a.spec.js", ["it.only('signs up', async () => {", "xit('refuses', () => {"]
            ),
            change("a_test.go", ['t.Skip("later")']),
            change("tests/test_b.py", ["# @pytest.mark.skip"]),  # (a comment: nothing)
        ]
    )
    assert kinds(found) == [
        "skip_added",
        "swallowed",
        "skip_added",
        "only_added",
        "skip_added",
        "skip_added",
    ]
    assert "the other tests stop running" in found[3].text


def test_tests_deleted_by_edit_or_by_rm_are_found(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_kept.py").write_text("x")
    found = ti.inspect(
        [
            change("tests/test_a.py", removed=["def test_refuses_long_email():", "assert x == 1"]),
            change("tests/test_gone.py", deleted=True),
        ],
        commands=[
            "rm -f tests/test_old.py && pytest",
            "rm tests/test_kept.py.bak",  # (not a test file)
            "git rm -r __tests__/",
            "rm -rf /tmp/test",  # (outside the project)
            "rm tests/test_kept.py",  # (still there: the rm failed)
        ],
        cwd=tmp_path,
    )
    assert kinds(found) == [
        "assert_removed",
        "test_removed",
        "file_deleted",
        "file_deleted",
        "file_deleted",
    ]
    texts = [f.text for f in found]
    assert "tests/test_gone.py was deleted" in texts
    assert "tests/test_old.py was deleted" in texts
    assert "the tests folder __tests__ was deleted" in texts


def test_a_test_command_that_can_no_longer_fail_is_found():
    found = ti.inspect(
        [
            change("package.json", ['"test": "node --test || true",', '"build": "tsc || true",']),
            change(
                ".github/workflows/ci.yml", ["continue-on-error: true", "run: npm test || exit 0"]
            ),
            change("Makefile", ["\tpytest -q; true"]),
            change("src/app.py", ["x = a or True"]),  # (code, not a command)
        ],
        runs=[
            NS(command="pytest -q || true"),
            NS(command="pytest -q || true"),
            NS(command="pytest"),
        ],
    )
    assert kinds(found) == ["cannot_fail"] * 4 + ["run_cannot_fail"]
    assert "a CI step in .github/workflows/ci.yml no longer fails the build" in found[1].text
    assert found[-1].text == "its test run couldn't fail (`pytest -q || true`)"


def test_a_mock_of_the_code_under_test_is_found_but_not_of_what_it_calls():
    source = change("app/signup.py", ["if len(email) > 254:"], functions={"validate_email"})
    found = ti.inspect(
        [
            source,
            change(
                "tests/test_signup.py",
                [
                    "monkeypatch.setattr(signup, 'validate_email', lambda e: True)",
                    "mocker.patch('app.signup.send_welcome')",  # (a collaborator: fine)
                ],
            ),
        ]
    )
    assert kinds(found) == ["mock_unit"]
    assert "now mocks validate_email, the code this turn changed" in found[0].text
    whole = ti.inspect(
        [
            change("src/signup.js", ["return email.length <= 254;"]),
            change("src/signup.test.js", ["jest.mock('./signup');"]),
        ]
    )
    assert kinds(whole) == ["mock_unit"] and "mocks signup" in whole[0].text


def test_the_receipt_lines_say_it_in_words():
    weak = [ti.Finding("assert_removed", "t.py", "1 assertion taken out of t.py (`assert x`)")]
    assert ti.lines_of(weak, None, True) == [
        {"tone": "bad", "text": "A test was weakened: 1 assertion taken out of t.py (`assert x`)"}
    ]
    assert ti.lines_of([], None, True) == [{"tone": "ok", "text": "No test was weakened"}]
    assert ti.lines_of([], None, False) == []
    good = {"status": "done", "caught": 7, "tried": 9, "total": 9, "survived": []}
    assert ti.lines_of([], good, False)[0] == {
        "tone": "ok",
        "text": "Tests constrain this change: 7 of 9 mutants caught",
    }
    bad = {
        "status": "done",
        "caught": 1,
        "tried": 4,
        "total": 6,
        "out_of_time": True,
        "survived": [{"file": "a.py", "line": 3, "change": "== → !="}],
    }
    assert ti.lines_of([], bad, False)[0]["text"] == (
        "Tests barely constrain this change: 1 of 4 mutants caught (== → != on a.py line 3 "
        "went unnoticed); 2 more not tried in time"
    )
    assert ti.lines_of([], {"status": "skipped", "why": "its tests failed"}, False) == [
        {"tone": "none", "text": "Mutation pass skipped: its tests failed"}
    ]


def test_its_settings_check_by_default_and_mutate_only_when_asked():
    assert prefs.FEATURE_PREFS[ti.PREF_CHECK][0] is True
    assert prefs.FEATURE_PREFS[ti.PREF_MUTANTS][0] is False


# ── the turn's changes, from its edits ──


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


def test_gather_reads_the_turns_edits_and_a_whole_file_write_against_the_last_commit(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    (tmp_path / "tests").mkdir()
    test = tmp_path / "tests" / "test_a.py"
    test.write_text("def test_a():\n    assert f(1) == 2\n    assert f(2) == 3\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "start")
    test.write_text("def test_a():\n    assert f(1)\n")  # (a Write rewrote it)
    src = tmp_path / "a.py"
    src.write_text("def f(x):\n    if x > 0:\n        return x + 1\n    return 0\n")
    marks = [
        code_changes.EditMark(
            str(test), "u1", frozenset({"def test_a():", "assert f(1)"}), frozenset(), True
        ),
        code_changes.EditMark(
            str(src), "u1", frozenset({"if x > 0:", "return x + 1"}), frozenset({"return x"})
        ),
    ]
    changes = {c.path: c for c in ti.gather(tmp_path, marks)}
    assert changes["tests/test_a.py"].removed == ["assert f(1) == 2", "assert f(2) == 3"]
    assert changes["tests/test_a.py"].added == ["assert f(1)"]
    assert changes["a.py"].changed_lines == [2, 3] and changes["a.py"].functions == {"f"}
    found = ti.inspect(list(changes.values()))
    assert kinds(found) == ["assert_removed"]  # (two out, one weaker in: net one taken out)


# ── mutants ──


def test_mutants_are_made_in_code_never_in_strings_or_comments():
    got = dict(
        (label, after)
        for after, label in ti.mutants_of_line("    if a == b and n >= 10:  # == here", True)
    )
    assert got["== → !="] == "    if a != b and n >= 10:  # == here"
    assert got[">= → <"] == "    if a == b and n < 10:  # == here"
    assert got["and → or"] == "    if a == b or n >= 10:  # == here"
    assert got["10 → 11"] == "    if a == b and n >= 11:  # == here"
    assert ti.mutants_of_line("    msg = 'a == b and true'", True) == []
    assert ti.mutants_of_line("import os", True) == []
    assert ti.mutants_of_line("    log.info('x %s', a == b)", True) == []
    js = dict(
        (label, after) for after, label in ti.mutants_of_line("  return ok && n === 0;", False)
    )
    assert (
        js["=== → !=="] == "  return ok && n !== 0;" and js["&& → ||"] == "  return ok || n === 0;"
    )
    assert "== → !=" not in js  # (=== isn't touched as ==)
    assert js["0 → 1"] == "  return ok && n === 1;"


def test_the_mutants_are_spread_over_the_changed_lines_and_bounded():
    text = 'def f(a, b):\n    """a == b and docs"""\n    if a < b:\n        return True\n    return a == 1\n'
    c = change("m.py", text=text, changed_lines=[2, 3, 4, 5])
    plan = ti.plan_mutants([c], limit=4)
    assert [(m.line, m.change) for m in plan] == [
        (3, "< → >="),
        (4, "True → False"),
        (5, "== → !="),
        (5, "1 → 0"),
    ]
    assert len(ti.plan_mutants([c], limit=2)) == 2
    assert ti.plan_mutants([change("tests/test_m.py", text=text, changed_lines=[3])]) == []


def _pytest_project(root: Path, tested: bool) -> Path:
    project = root / "proj"
    (project / "tests").mkdir(parents=True)
    (project / "calc.py").write_text(
        "def clamp(n, low, high):\n"
        "    if n < low:\n"
        "        return low\n"
        "    if n > high:\n"
        "        return high\n"
        "    return n\n"
    )
    body = (
        "def test_clamp():\n"
        "    assert clamp(-5, 0, 10) == 0\n"
        "    assert clamp(15, 0, 10) == 10\n"
        "    assert clamp(5, 0, 10) == 5\n"
        "    assert clamp(0, 0, 10) == 0\n"
        "    assert clamp(10, 0, 10) == 10\n"
        if tested
        else "def test_clamp():\n    assert clamp(5, 0, 10) is not None\n"
    )
    (project / "tests" / "test_calc.py").write_text("from calc import clamp\n\n\n" + body)
    # The project's own Python, as a .venv beside it (the copy links it, never copies it).
    os.symlink(Path(sys.executable).parent.parent, project / ".venv")
    return project


def _calc_change(project: Path) -> ti.FileChange:
    return change(
        "calc.py",
        ["if n < low:", "if n > high:"],
        text=(project / "calc.py").read_text(),
        changed_lines=[2, 4],
    )


def test_a_mutation_pass_in_a_scratch_copy_counts_what_the_tests_catch(tmp_path):
    env = dict(os.environ)
    good = _pytest_project(tmp_path / "good", tested=True)
    before = (good / "calc.py").read_text()
    result = asyncio.run(
        ti.mutation_pass(good, [_calc_change(good)], ["tests/test_calc.py"], env=env)
    )
    assert result["status"] == "done", result
    assert (result["caught"], result["tried"]) == (2, 2)
    assert (good / "calc.py").read_text() == before  # (the owner's file never changed)
    weak = _pytest_project(tmp_path / "weak", tested=False)
    result = asyncio.run(ti.mutation_pass(weak, [_calc_change(weak)], [], env=env))
    assert (result["caught"], result["tried"]) == (0, 2)
    assert result["survived"][0] == {"file": "calc.py", "line": 2, "change": "< → >="}


def test_a_mutation_pass_tries_nothing_when_the_tests_dont_pass_first(tmp_path):
    project = _pytest_project(tmp_path, tested=True)
    # Only the relevant tests run: one broken elsewhere doesn't stop the pass...
    (project / "tests" / "test_other.py").write_text("def test_other():\n    assert False\n")
    result = asyncio.run(
        ti.mutation_pass(project, [_calc_change(project)], [], env=dict(os.environ))
    )
    assert result["status"] == "done"
    # ... but a relevant one that fails as the code stands does: no mutant is tried.
    with (project / "tests" / "test_calc.py").open("a") as f:
        f.write("\n\ndef test_broken():\n    assert clamp(1, 0, 10) == 2\n")
    result = asyncio.run(
        ti.mutation_pass(project, [_calc_change(project)], [], env=dict(os.environ))
    )
    assert result["status"] == "skipped" and "didn't pass in a scratch copy" in result["why"]


# ── the desk, between the turn's events and its receipt ──


class FakePrefs:
    def __init__(self, **values):
        self.values = values

    def feature(self, key):
        return self.values.get(key, prefs.FEATURE_PREFS[key][0])


def test_the_desk_keeps_each_turns_own_edits_and_shell_steps(tmp_path):
    (tmp_path / "tests").mkdir()
    test = tmp_path / "tests" / "test_a.py"
    test.write_text("def test_a():\n    pass\n")
    earlier = code_changes.EditMark(
        str(test), "u0", frozenset({"x = 1"}), frozenset({"assert old"})
    )
    task = NS(id=3, kind="code", cwd=tmp_path, edit_marks=[earlier], checkpoints=["u0"])
    hub = NS(prefs=FakePrefs(), tasks=NS(tasks={3: task}))
    desk = ti.Integrity(hub)
    desk.task_event("task_log", {"id": 3, "entry": {"role": "user", "text": "go"}})
    task.checkpoints.append("u1")
    task.edit_marks.append(
        code_changes.EditMark(str(test), "u1", frozenset({"pass"}), frozenset({"assert a() == 1"}))
    )
    desk.task_event(
        "task_log",
        {"id": 3, "entry": {"role": "tool", "tool": "Bash", "detail": "$ rm tests/test_b.py"}},
    )
    desk.task_event("task_finished", {"id": 3, "task_kind": "code", "status": "done"})
    record = desk.turns[3]
    assert [m.checkpoint for m in record.marks] == ["u1"] and record.commands == [
        "rm tests/test_b.py"
    ]
    part = asyncio.run(desk.part(task, [cs.TestRun("pytest", True, 0, 4)], {"state": "passed"}))
    assert part["status"] == "weakened"
    assert [f["kind"] for f in part["findings"]] == ["assert_removed", "file_deleted"]
    assert part["lines"][0]["text"].startswith(
        "A test was weakened: 1 assertion taken out of tests/test_a.py"
    )
    assert part["mutants"] is None  # (off by default)
    assert 3 not in desk.turns  # (each record is one receipt's)


def test_the_desk_says_nothing_when_its_settings_are_off_and_why_it_skipped(tmp_path):
    src = tmp_path / "a.py"
    src.write_text("def f(x):\n    return x > 1\n")
    task = NS(id=4, kind="code", cwd=tmp_path, edit_marks=[], checkpoints=[])
    off = ti.Integrity(NS(prefs=FakePrefs(code_test_integrity=False), tasks=NS(tasks={4: task})))
    off.task_event("task_log", {"id": 4, "entry": {"role": "user"}})
    task.edit_marks.append(
        code_changes.EditMark(str(src), "", frozenset({"return x > 1"}), frozenset())
    )
    off.task_event("task_finished", {"id": 4, "task_kind": "code", "status": "done"})
    assert asyncio.run(off.part(task, [], None)) is None
    on = ti.Integrity(NS(prefs=FakePrefs(code_mutation_pass=True), tasks=NS(tasks={4: task})))
    on.turns[4] = ti.TurnRecord(list(task.edit_marks), [], tmp_path)
    part = asyncio.run(on.part(task, [cs.TestRun("pytest", False, 1, 2)], {"state": "failed"}))
    assert part["lines"] == [{"tone": "none", "text": "Mutation pass skipped: its tests failed"}]


async def test_a_turn_that_weakened_a_test_gets_a_receipt_that_says_so(tmp_path):
    """The features as the hub installs them (receipts, then integrity, by name), the turn's
    events through their sinks in order, the receipt written by the spawned writer."""
    from jarvis.features import code_receipts as cr

    (tmp_path / "tests").mkdir()
    test = tmp_path / "tests" / "test_a.py"
    test.write_text("def test_a():\n    assert f() is not None\n")
    task = NS(id=7, kind="code", cwd=tmp_path, edit_marks=[], checkpoints=["u1"])
    logged, sinks, spawned = [], [], []
    journal = cs.Journal()
    hub = NS(
        prefs=FakePrefs(),
        tasks=NS(
            tasks={7: task},
            _log=lambda t, role, text, **kw: logged.append((text, kw)),
            _changed_soon=lambda: None,
        ),
        code_voice=NS(journal=journal),
        add_task_sink=sinks.append,
        add_event_sink=lambda kinds, sink: None,
        _spawn=lambda coro: spawned.append(asyncio.ensure_future(coro)),
    )
    sinks.append(journal.event)
    cr.install(hub)
    ti.install(hub)

    def emit(kind, **data):
        for sink in sinks:
            sink(kind, data)

    emit("task_log", id=7, entry={"role": "user", "text": "make the tests pass"})
    task.edit_marks.append(
        code_changes.EditMark(
            str(test), "u1", frozenset({"assert f() is not None"}), frozenset({"assert f() == 3"})
        )
    )
    emit(
        "task_log",
        id=7,
        entry={"role": "tool", "tool": "Bash", "tool_id": "b1", "detail": "$ pytest -q"},
    )
    emit("task_log_update", id=7, tool_id="b1", status="done", output="1 passed in 0.01s")
    emit("task_finished", id=7, task_kind="code", status="done", files=[str(test)], result="")
    receipt = await asyncio.wait_for(spawned[0], 10)
    assert receipt["tests"]["state"] == "passed" and receipt["tests"]["trusted"] is False
    assert receipt["risk"] == "high" and receipt["why"] == "a test was weakened"
    assert receipt["integrity"]["findings"][0]["kind"] == "assert_loosened"
    assert (
        "tests passed (1), but a test was weakened · A test was weakened: 1 assertion in tests/test_a.py made looser"
        in logged[0][0]
    )
