"""Eden Code's diffs and test results said for the ear in screen-reader mode (code_speech.py,
features/code_spoken.py): files by function or section, never line numbers, and the tests with
the failing ones named. A real git repository in a temp folder; no model, no network."""

from __future__ import annotations

import asyncio
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from claude_agent_sdk import ToolResultBlock, ToolUseBlock

from jarvis import code_speech, codetests, diffspeak
from jarvis.features import code_spoken

APP = """import os


def greet(name):
    return "hi " + name


class Store:
    def load(self):
        return 1

    def save(self):
        return 2
"""
README = "# Demo\n\nIntro.\n\n## Install\n\nRun it.\n\n## Usage\n\nCall greet.\n"


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "demo"
    root.mkdir()
    (root / "app.py").write_text(APP)
    (root / "README.md").write_text(README)
    git(root, "init", "-q")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "start")
    (root / "app.py").write_text(
        APP.replace('"hi " + name', '"hello " + name').replace("return 2", "return 3")
        + "\n\ndef farewell(name):\n    return 'bye ' + name\n"
    )
    (root / "README.md").write_text(README.replace("Run it.", "Run it with uv."))
    (root / "notes.txt").write_text("new\n")
    return root


# ── where a change is ──


def test_a_line_is_placed_in_the_function_section_or_class_around_it():
    lines = APP.splitlines()
    assert code_speech.enclosing(lines, 5, ".py") == ("function", "greet")
    assert code_speech.enclosing(lines, 13, ".py") == ("function", "save")
    assert code_speech.enclosing(lines, 1, ".py") is None
    md = README.splitlines()
    assert code_speech.enclosing(md, 7, ".md") == ("section", "Install")
    js = [
        "export async function load(a) {",
        "  return a;",
        "}",
        "const save = async (b) => {",
        "  go(b);",
        "};",
    ]
    assert code_speech.enclosing(js, 2, ".js") == ("function", "load")
    assert code_speech.enclosing(js, 5, ".js") == ("function", "save")


def test_a_turns_changes_are_said_by_function_and_section_never_by_line(repo):
    changes = diffspeak.collect(repo, None)
    words = code_speech.changes_words(repo, changes)
    assert words.startswith("3 files changed.")
    assert "app.py: changed the functions greet and save, added farewell." in words
    assert "README.md: changed the section Install." in words
    assert "New file notes.txt." in words
    assert "line" not in words.lower().replace("lines", "")  # no line numbers anywhere
    assert code_speech.changes_words(repo, None).startswith("This project isn't in git")
    assert code_speech.changes_words(repo, []) == "No files changed."


# ── test runs ──


PYTEST = """....F..F
=========================== short test summary info ============================
FAILED tests/test_app.py::test_greet - AssertionError: assert 'hello x' == 'hi x'
FAILED tests/test_store.py::TestStore::test_save[2] - assert 3 == 2
========================= 2 failed, 6 passed, 1 skipped in 0.41s =========================
"""
JEST = """FAIL src/app.test.js
  ● greet › says hello

Tests:       1 failed, 1 skipped, 9 passed, 11 total
"""
VITEST = """ FAIL  src/app.test.ts > greet > says hello
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
"""
NODE = "not ok 2 - greets in Chinese\n# tests 5\n# pass 4\n# fail 1\n"
CARGO = "test tests::adds ... ok\ntest tests::saves ... FAILED\n\ntest result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured\n"
GO = "=== RUN   TestGreet\n--- FAIL: TestGreet (0.00s)\n=== RUN   TestSave\n--- PASS: TestSave (0.00s)\nFAIL\n"
DOTNET = "  Failed Demo.Tests.Greets [12 ms]\nFailed!  - Failed:     1, Passed:    10, Skipped:     0, Total:    11\n"


@pytest.mark.parametrize(
    ("output", "words"),
    [
        (
            PYTEST,
            "Tests: 6 passed, 2 failed, 1 skipped. Failing: test_greet in test_app.py and test_save in test_store.py.",
        ),
        (JEST, "Tests: 9 passed, 1 failed, 1 skipped. Failing: greet, says hello."),
        (VITEST, "Tests: 4 passed, 1 failed. Failing: says hello in app.test.ts."),
        (NODE, "Tests: 4 passed, 1 failed. Failing: greets in Chinese."),
        (CARGO, "Tests: 7 passed, 1 failed. Failing: tests::saves."),
        (GO, "Tests: 1 passed, 1 failed. Failing: TestGreet."),
        (DOTNET, "Tests: 10 passed, 1 failed. Failing: Demo.Tests.Greets."),
        ("===== 12 passed in 1.02s =====\n", "Tests: 12 passed."),
    ],
)
def test_each_runners_output_is_said_with_the_failing_names(output, words):
    assert code_speech.read_test_output(output).words() == words


def test_output_that_isnt_a_test_run_is_left_alone():
    assert code_speech.read_test_output("Compiling…\nDone in 2s") is None
    assert code_speech.runs_tests("uv run pytest tests/test_app.py -q")
    assert code_speech.runs_tests("npm test")
    assert not code_speech.runs_tests("git status")


# ── the feature ──


class Notified:
    def __init__(self):
        self.alerts = []

    def __call__(self, alert, **_kw):
        self.alerts.append(alert)


def make(repo, mode_on=True):
    task = SimpleNamespace(
        id=7, kind="code", cwd=repo, turn_files={str(repo / "app.py"), str(repo / "README.md")},
        files_changed={str(repo / "app.py"), str(repo / "README.md"), str(repo / "notes.txt")},
        turn_started=time.monotonic() - 1,
    )  # fmt: skip
    notify = Notified()
    servers, sinks = {}, []
    spawned = []
    hub = SimpleNamespace(
        accessibility=SimpleNamespace(effective=lambda: mode_on),
        tasks=SimpleNamespace(tasks={7: task}, message_sinks=[]),
        notify=notify,
        add_task_sink=sinks.append,
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        prefs=SimpleNamespace(language="en"),
        _spawn=lambda coro: spawned.append(coro),
    )
    code_spoken.install(hub)
    return hub, task, notify, servers, sinks, spawned


def finished(status="done"):
    return {"id": 7, "task_kind": "code", "status": status, "folder": "demo"}


def run_tests_in_session(hub, task, output):
    sink = hub.tasks.message_sinks[0]
    sink(
        task,
        SimpleNamespace(
            content=[ToolUseBlock(id="t1", name="Bash", input={"command": "uv run pytest -q"})]
        ),
    )
    sink(
        task,
        SimpleNamespace(
            content=[
                ToolResultBlock(
                    tool_use_id="t1", content=[{"type": "text", "text": output}], is_error=True
                )
            ]
        ),
    )


def test_in_screen_reader_mode_a_turns_end_says_the_changes_and_the_tests(repo):
    hub, task, notify, _servers, sinks, spawned = make(repo)
    run_tests_in_session(hub, task, PYTEST)
    sinks[0]("task_finished", finished())
    [coro] = spawned
    asyncio.run(coro)
    [alert] = notify.alerts
    assert alert.title == "Eden Code changes"
    assert alert.text.startswith("Eden Code finished in demo. 2 files changed.")
    assert "changed the functions greet and save, added farewell" in alert.text
    assert "notes.txt" not in alert.text  # not this turn's
    assert alert.text.endswith("Failing: test_greet in test_app.py and test_save in test_store.py.")


def test_out_of_screen_reader_mode_or_when_stopped_it_says_nothing(repo):
    hub, _task, _notify, _servers, sinks, spawned = make(repo, mode_on=False)
    sinks[0]("task_finished", finished())
    assert spawned == []
    hub, _task, _notify, _servers, sinks, spawned = make(repo)
    sinks[0]("task_finished", finished("stopped"))
    sinks[0]("task_finished", {**finished(), "task_kind": "research"})
    assert spawned == []


def test_a_turn_that_changed_nothing_and_ran_nothing_says_nothing(repo):
    hub, task, notify, _servers, sinks, spawned = make(repo)
    task.turn_files = set()
    sinks[0]("task_finished", finished())
    asyncio.run(spawned[0])
    assert notify.alerts == []


def test_the_tests_pane_run_counts_when_the_session_ran_none(repo):
    hub, task, notify, _servers, sinks, spawned = make(repo)
    results = codetests.Results(
        [
            codetests.Case("tests/test_app.py", "test_greet", "failed"),
            codetests.Case("tests/test_app.py", "test_ok", "passed"),
        ]
    )
    run = SimpleNamespace(results=results, finished=time.time())
    hub.code_verify = SimpleNamespace(tests=SimpleNamespace(latest=lambda project: run))
    assert hub.code_spoken.test_words(task, task.turn_started) == (
        "Tests: 1 passed, 1 failed. Failing: test_greet in test_app.py."
    )
    run.finished = time.time() - 3600  # before this turn
    assert hub.code_spoken.test_words(task, task.turn_started) == ""


def test_spoken_changes_on_request_covers_the_whole_session(repo, monkeypatch):
    hub, task, _notify, servers, _sinks, _spawned = make(repo, mode_on=False)
    build, kw = servers["code_spoken"]
    assert kw["labels"] == {"spoken_changes": "Said what Eden Code changed"}
    monkeypatch.setattr(code_spoken, "create_sdk_mcp_server", lambda **k: k["tools"])
    [tool] = build()
    text = asyncio.run(tool.handler({}))["content"][0]["text"]
    assert text.startswith("3 files changed.") and "New file notes.txt." in text
    assert asyncio.run(tool.handler({"session": 99}))["is_error"]
    assert Path(task.cwd).name == "demo"
