"""More of Eden Code's terminals and "!" commands (code_terminals) and its checks
(features/code_verify): a "!" command cancelled when it shrugs off Ctrl-C, killed when the
app quits, cancelled after it ended, one that can't start; terminals that aren't there; the
Tests pane's watch and its errors; the check after a turn waiting for the watch's run."""

import asyncio
import base64
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from conftest import FakeClient
from test_code_verify import events, plain_env, sent_messages, tool_wrapper, wait_for

from jarvis import code_terminals
from jarvis.code_terminals import BangRun, Shell, Shells, WinBangRun
from jarvis.features import code_verify
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask


@pytest.fixture(autouse=True)
def zsh(monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/zsh")


async def until(check, seconds=30.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        await asyncio.sleep(0.02)
    return False


# ── terminals ──


def test_a_terminal_with_nothing_running_in_it_is_not_busy(tmp_path):
    """busy() is empty when the shell has no job (or can't be looked at)."""
    assert Shell("t1", tmp_path, "zsh 1", None).busy() == ""


def test_terminals_that_are_not_there_are_left_alone(tmp_path):
    """Closing an unknown terminal says no; output heard before its shell is set is dropped."""
    events_seen = []
    shells = Shells(lambda kind, **data: events_seen.append(kind))
    assert shells.close("t99") is False and shells.get("t99") is None
    shells._heard({}, "term_data", {"data": base64.b64encode(b"early").decode()})
    shells._heard({}, "term_exit", {})
    assert events_seen == []


# ── "!" commands ──


async def test_a_bang_command_that_cannot_start_raises_and_leaves_nothing_open(tmp_path):
    """A folder that isn't there: start() raises, and no terminal is left behind."""
    run = BangRun("b1", "echo hi", tmp_path / "gone", lambda *a, **k: None)
    with pytest.raises(OSError):
        run.start()
    assert run.master == -1 and run.proc is None and run.seconds == 0.0


async def test_cancelling_a_command_not_started_or_already_ended_does_nothing(tmp_path):
    """Cancel before start, or after the command ended, changes nothing and isn't 'cancelled'."""
    run = BangRun("b2", "printf 'done\\n'; exit 5", tmp_path, lambda *a, **k: None)
    await run.cancel()
    assert not run.cancelled
    run._flush()  # (nothing printed yet: nothing to send)
    run.start()
    assert await asyncio.wait_for(run.done, 30) == 5
    await run.cancel()
    assert not run.cancelled and run.code == 5 and run.output(100) == "done"
    run.kill()  # (ended: nothing to kill)
    assert run.code == 5


async def test_a_command_that_ignores_ctrl_c_and_terminate_is_killed(tmp_path, monkeypatch):
    """Cancel escalates to a kill for a command that traps SIGINT and SIGTERM, and still ends
    as cancelled (130)."""
    monkeypatch.setattr(code_terminals, "CANCEL_STEPS", (0.2, 0.2))
    run = BangRun(
        "b3", "trap '' INT TERM; echo ready; sleep 5; echo never", tmp_path, lambda *a, **k: None
    )
    run.start()
    assert await until(lambda: b"ready" in run.kept)
    started = time.monotonic()
    await run.cancel()
    code = await asyncio.wait_for(run.done, 15)
    assert run.cancelled and code == 130 and run.master == -1
    assert time.monotonic() - started < 4.5  # (not the sleep's 5 seconds)
    assert "never" not in run.output(1000)


async def test_the_app_quitting_kills_a_running_command(tmp_path):
    """kill() ends a running "!" command at once, without it counting as cancelled."""
    run = BangRun("b4", "echo up; sleep 5; echo never", tmp_path, lambda *a, **k: None)
    run.start()
    assert await until(lambda: b"up" in run.kept)
    started = time.monotonic()
    run.kill()
    code = await asyncio.wait_for(run.done, 15)
    assert code != 0 and not run.cancelled and time.monotonic() - started < 4.5
    assert "never" not in run.output(1000)


async def test_a_terminal_that_is_gone_ends_the_command(tmp_path, monkeypatch):
    """A read that finds nothing yet waits; one that fails (EIO: the terminal is gone)
    ends the run and lets go of the terminal. (sh: a login zsh whose terminal is closed
    under it takes its time to go.)"""
    monkeypatch.setenv("SHELL", "/bin/sh")
    run = BangRun("b5", "sleep 0.5; exit 4", tmp_path, lambda *a, **k: None)
    run.start()

    def nothing_yet(_fd, _n):
        raise BlockingIOError

    def gone(_fd, _n):
        raise OSError(5, "Input/output error")

    with monkeypatch.context() as m:
        m.setattr(code_terminals.os, "read", nothing_yet)
        run._readable()
        assert run.master >= 0 and not run.done.done()
        m.setattr(code_terminals.os, "read", gone)
        run._readable()
    assert run.master == -1
    code = await asyncio.wait_for(run.done, 15)
    assert code is not None and run.code == code


def test_a_shell_that_wont_be_reaped_is_killed_then_waited_for(monkeypatch):
    """_wait: past its time the process group is killed, then waited for once more; if even
    that fails, no code."""
    killed = []
    monkeypatch.setattr(
        code_terminals.osplat, "kill_group", lambda pid, *a, **k: killed.append((pid, k))
    )

    class Stuck:
        pid = 4242

        def __init__(self, then):
            self.then = then
            self.calls = 0

        def wait(self, timeout=None):
            self.calls += 1
            if self.calls == 1:
                raise subprocess.TimeoutExpired("sh", timeout)
            if isinstance(self.then, Exception):
                raise self.then
            return self.then

    assert code_terminals._wait(Stuck(-9)) == -9
    assert code_terminals._wait(Stuck(subprocess.TimeoutExpired("sh", 5))) is None
    assert killed == [(4242, {"force": True}), (4242, {"force": True})]


@pytest.fixture
def cmd_shell(tmp_path, monkeypatch):
    """A stand-in for Windows' cmd.exe: takes /d /s /c and runs the command in sh."""
    folder = tmp_path / "bin"
    folder.mkdir()
    cmd = folder / "cmd"
    cmd.write_text('#!/bin/sh\nshift 3\nexec /bin/sh -c "$1"\n')
    cmd.chmod(0o755)
    monkeypatch.setattr(code_terminals.osplat, "default_shell", lambda: str(cmd))


async def test_the_windows_bang_pipes_output_back_and_ends_with_its_code(tmp_path, cmd_shell):
    """WinBangRun (no pseudo-terminal): output read from a pipe streams to the window and the
    run ends with the command's code."""
    seen = []
    run = WinBangRun("w1", "printf 'one\\n'; printf 'two\\n'; exit 2", tmp_path,
                     lambda k, **d: seen.append((k, d)))  # fmt: skip
    run.start()
    assert await asyncio.wait_for(run.done, 30) == 2
    streamed = "".join(d["text"] for k, d in seen if k == "cw_bang_data")
    assert "one" in streamed and "two" in streamed
    assert run.output(100).splitlines() == ["one", "two"]
    await run.cancel()  # (ended: nothing to cancel)
    run.kill()
    assert not run.cancelled


async def test_the_windows_bang_is_cancelled_by_ending_its_process_tree(tmp_path, cmd_shell):
    """WinBangRun's Cancel ends the whole tree: cancelled, 130; kill() on a running one too."""
    run = WinBangRun("w2", "echo waiting; sleep 5; echo never", tmp_path, lambda *a, **k: None)
    await run.cancel()  # (not started: nothing)
    assert not run.cancelled
    run.start()
    assert await until(lambda: b"waiting" in run.kept)
    await run.cancel()
    assert run.cancelled and await asyncio.wait_for(run.done, 15) == 130
    assert "never" not in run.output(1000)
    other = WinBangRun("w3", "echo up; sleep 5", tmp_path, lambda *a, **k: None)
    other.start()
    assert await until(lambda: b"up" in other.kept)
    other.kill()
    assert await asyncio.wait_for(other.done, 15) is not None and not other.cancelled


# ── Eden Code's checks, through a real hub ──


@pytest.fixture
async def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    cv = hub.code_verify
    cv.servers.env = cv.tests.env = cv.diags.env = plain_env
    yield hub
    await cv.close()


@pytest.fixture
def project(settings):
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    return folder


def a_session(hub, project, task_id=4):
    task = ClaudeTask(id=task_id, prompt="x", cwd=project.resolve())
    hub.tasks.tasks[task_id] = task
    return task


def pytest_project(project):
    (project / "tests").mkdir()
    (project / "tests" / "test_math.py").write_text("def test_add():\n    assert 1 + 1 == 2\n")
    tool_wrapper(project, "python", sys.executable)


async def test_the_panes_refuse_a_folder_outside_the_projects(hub):
    """The Tests and Problems panes (like the Preview pane) say why for a folder that isn't a
    project, and start nothing."""
    q = hub.subscribe()
    await hub._handle({"type": "cv_state", "directory": "/etc"})
    [state] = events(q, "cv_state")  # (the Preview pane's own state, with why: U6)
    assert state["error"]
    for kind in ("cv_tests", "cv_problems"):
        await hub._handle({"type": kind, "directory": "/etc", "action": "run"})
        [error] = events(q, "cv_error")
        assert error["text"]
    assert not hub.code_verify._tasks


async def test_the_tests_watch_turns_on_and_off_and_refuses_an_unknown_runner(hub, project):
    """Watch on: the pane hears which suite is watched; off: no watch; a runner the project
    doesn't have is refused, for a run and a watch alike."""
    pytest_project(project)
    a_session(hub, project)
    cv = hub.code_verify
    q = hub.subscribe()
    await hub._handle({"type": "cv_tests", "action": "watch", "id": 4, "on": True})
    on = await wait_for(q, "cv_tests")
    [suite] = on["suites"]
    assert on["watch"] == {"suite": suite["key"], "target": {}}
    assert str(project.resolve()) in cv.tests.watching
    await hub._handle({"type": "cv_tests", "action": "watch", "id": 4, "on": False})
    off = await wait_for(q, "cv_tests")
    assert off["watch"] is None and not cv.tests.watching
    for action in ("watch", "run"):
        await hub._handle(
            {"type": "cv_tests", "action": action, "id": 4, "on": True, "suite": "jest:x:"}
        )
        error = await wait_for(q, "cv_error")
        assert error["text"] == "That test runner isn't in this project."
    assert not cv.tests.watching
    await hub._handle({"type": "cv_tests", "action": "stop", "id": 4})
    assert await until(lambda: not cv._tasks)


async def test_fixing_tests_or_problems_needs_a_session_and_something_to_fix(
    hub, project, monkeypatch
):
    """'Fix' from a pane opened by folder asks for a session; in a session with nothing
    failing, it says there's nothing to fix. Nothing is sent."""
    sent = sent_messages(hub, monkeypatch)
    q = hub.subscribe()
    await hub._handle({"type": "cv_tests", "action": "fix", "directory": "shop"})
    await hub._handle({"type": "cv_problems", "action": "fix", "directory": "shop"})
    texts = [e["text"] for e in events(q, "cv_error")]
    assert texts == [
        "Open a session to send it the failures.",
        "Open a session to send it the problems.",
    ]
    a_session(hub, project)
    await hub._handle({"type": "cv_problems", "action": "fix", "id": 4})
    assert [e["text"] for e in events(q, "cv_error")] == ["There are no problems to fix."]
    assert sent == []


async def test_a_project_with_no_checkers_says_so(hub, project):
    """Running the Problems pane's checks where none are set up says which ones it knows."""
    q = hub.subscribe()
    assert await hub.code_verify._problems_run(project.resolve(), slow=True) is None
    assert "no checkers set up" in events(q, "cv_error")[0]["text"]


async def test_check_now_and_fix_this_need_a_session_with_findings(hub, project, monkeypatch):
    """Check now without a session, a fix for a check that isn't there, and a fix the session
    can't take each say why; switches for a session that isn't there are ignored."""
    q = hub.subscribe()
    hub.code_verify.cmd_check({"id": 77})
    hub.code_verify.cmd_session({"id": 77, "verify": True})
    hub.code_verify.cmd_fix_check({"id": 77, "n": 1})  # (no session: nothing said)
    assert [e["text"] for e in events(q, "cv_error")] == ["Open a session to check its work."]
    assert 77 not in hub.code_verify.sessions
    task = a_session(hub, project)
    hub.code_verify.cmd_fix_check({"id": 4, "n": 1})
    assert [e["text"] for e in events(q, "cv_error")] == ["That check has nothing to fix."]
    task.transcript.append(
        {"role": "verify", "n": 2, "findings": [{"kind": "server", "text": "Error: down"}]}
    )
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: False)
    hub.code_verify.cmd_fix_check({"id": 4, "n": 2})
    assert [e["text"] for e in events(q, "cv_error")] == [
        "The session couldn't take another message just now."
    ]


async def test_a_check_already_under_way_is_not_started_twice(hub, project):
    """check_turn while that session's check runs does nothing (no second 'checking')."""
    task = a_session(hub, project)
    hub.code_verify.session(task.id).checking = True
    q = hub.subscribe()
    await hub.code_verify.check_turn(task, by_owner=True)
    assert events(q, "cv_verify") == []


async def test_server_commands_for_a_server_that_isnt_there(hub):
    """Stop and forget of an unknown server do nothing; restart says it isn't known; a start
    for a folder that isn't a project says why."""
    cv = hub.code_verify
    q = hub.subscribe()
    await cv.cmd_server({"action": "stop", "key": "nope"})
    await cv.cmd_server({"action": "forget", "key": "nope"})
    await cv.cmd_server({"action": "explode", "key": "nope"})
    assert events(q, "cv_error") == []
    await cv.cmd_server({"action": "restart", "key": "nope"})
    assert [e["text"] for e in events(q, "cv_error")] == ["That dev server isn't known."]
    await cv.cmd_server({"action": "start", "directory": "/etc", "name": "web"})
    assert events(q, "cv_error")
    assert not cv.servers.servers


async def test_an_unreadable_record_of_started_configs_means_asking_again(hub, project):
    """A damaged list of the launch configs the owner said yes to counts as none; a config
    that isn't there needs no card (the start says it's missing)."""
    cv = hub.code_verify
    cv._starts_path().write_text("{not json")
    assert cv._started_ok() == {}
    assert await cv.owner_may_start(project.resolve(), "nothing-by-that-name") is True


def run_of(started, status="running"):
    return SimpleNamespace(started=started, status=status, results=None)


async def test_a_turns_check_waits_for_the_watchs_run_of_its_changes(hub, project, monkeypatch):
    """_turn_tests: none without a watch; none when no run began after the turn; none when the
    run outlasts the wait; the run once it ends in time."""
    monkeypatch.setattr(code_verify, "TESTS_START", 0.3)
    monkeypatch.setattr(code_verify, "TESTS_WAIT", 0.6)
    cv = hub.code_verify
    task = a_session(hub, project)
    key = str(task.cwd)
    since = time.time()
    assert await cv._turn_tests(task, since) is None  # (no watch)
    cv.tests.watching[key] = {"suite": None}
    try:
        cv.tests.runs[key] = run_of(since - 60, "passed")  # an old run: not this turn's
        assert await cv._turn_tests(task, since) is None
        cv.tests.runs[key] = run_of(since + 1)  # this turn's, still running past the wait
        assert await cv._turn_tests(task, since) is None
        later = run_of(since + 1)
        cv.tests.runs.pop(key)

        async def begins_then_ends():
            await asyncio.sleep(0.1)
            cv.tests.runs[key] = later
            await asyncio.sleep(0.3)
            later.status = "failed"

        helper = asyncio.ensure_future(begins_then_ends())
        assert await cv._turn_tests(task, since) is later
        await helper
    finally:
        cv.tests.watching.pop(key, None)
        cv.tests.runs.pop(key, None)


def test_quitting_stops_every_checks_processes(hub, monkeypatch):
    """The exit handler shuts down each live CodeVerify; one that fails doesn't stop the rest."""
    cv = hub.code_verify
    stopped = []
    for part in (cv.servers, cv.tests, cv.diags):
        monkeypatch.setattr(part, "shutdown", lambda part=part: stopped.append(part))

    class Broken:
        def shutdown(self):
            raise RuntimeError("boom")

    broken = Broken()
    code_verify._ALL.add(broken)
    try:
        code_verify._stop_everything_at_exit()
    finally:
        code_verify._ALL.discard(broken)
    assert stopped == [cv.servers, cv.tests, cv.diags]
