"""Eden Code's debugger feature (features/code_debugger): the session's tools against a fake
debug adapter (tests/fake_dap.py, never a real debugger), what asks and what doesn't, the
limits on paths and attaching, the owner taking over in the Debug pane, and the setting."""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from code_session_fakes import make_hub, until

from jarvis import code_dap, tasks
from jarvis.code_dap import Adapter
from jarvis.features import code_debugger
from jarvis.tasks import ClaudeTask

FAKE = str(Path(__file__).with_name("fake_dap.py"))


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "prog.py").write_text("".join(f"x{i} = {i}\n" for i in range(1, 11)))
    return root


def desk_with_fake(hub, mode="", missing=()):
    desk = hub.code_debugger
    desk.env_override = {**os.environ, "FAKE_DAP_MODE": mode}

    def adapters(_root):
        return [
            Adapter(
                "python",
                "debugpy",
                ("python",),
                None if "python" in missing else [sys.executable, FAKE],
                install="Install it with: python3 -m pip install debugpy",
            ),
            Adapter(
                "node",
                "js-debug",
                ("javascript", "node"),
                None,
                transport="tcp",
                install="js-debug isn't here.",
            ),
            Adapter(
                "lldb",
                "lldb-dap",
                ("swift", "c"),
                None if "lldb" in missing else [sys.executable, FAKE],
            ),
        ]

    desk.adapters_override = adapters
    return desk


def session(hub, project, id_=7):
    task = ClaudeTask(id=id_, prompt="", cwd=project)
    task.status = "running"
    hub.tasks.tasks[id_] = task
    return task


def tools_of(desk, task):
    return {t.name: t for t in desk.tools(task)}


def text(result):
    return result["content"][0]["text"]


def record(hub):
    seen = []
    real = hub.emit

    def emit(kind, **data):
        seen.append((kind, data))
        real(kind, **data)

    hub.emit = emit
    return seen


async def test_a_session_gets_the_tools_with_only_the_reading_and_moving_ones_unasked(hub, project):
    desk = desk_with_fake(hub)
    task = session(hub, project)
    opts = SimpleNamespace(mcp_servers={"own": {}}, allowed_tools=["TodoWrite"])
    desk.extend(task, opts)
    assert set(opts.mcp_servers) == {"own", code_debugger.SERVER}
    assert f"mcp__{code_debugger.SERVER}__debug_continue" in opts.allowed_tools
    for asked in ("debug_launch", "debug_attach", "debug_evaluate"):
        name = f"mcp__{code_debugger.SERVER}__{asked}"
        assert name not in opts.allowed_tools
        assert name in tasks.FEATURE_TOOLS  # (its own words on the card)
    detail = tasks.approval_detail(
        f"mcp__{code_debugger.SERVER}__debug_launch",
        {"language": "python", "module": "pytest", "args": ["tests/a.py", "-x"]},
        project,
    )
    assert "python debugger: -m pytest tests/a.py -x" in detail
    # off: no tools; an ACP session: none
    hub.prefs.features[code_debugger.PREF] = False
    opts = SimpleNamespace(mcp_servers={}, allowed_tools=[])
    desk.extend(task, opts)
    assert opts.mcp_servers == {} and opts.allowed_tools == []
    hub.prefs.features[code_debugger.PREF] = True
    task.model_ref = "acp:codex"
    desk.extend(task, opts)
    assert opts.mcp_servers == {}


async def test_the_agent_debugs_a_program_from_a_breakpoint_to_its_end(hub, project):
    desk = desk_with_fake(hub)
    task = session(hub, project)
    t = tools_of(desk, task)
    seen = record(hub)
    got = await t["debug_launch"].handler(
        {
            "language": "python",
            "program": "prog.py",
            "breakpoints": [{"file": "prog.py", "line": 3}],
        }
    )
    assert "is_error" not in got, text(got)
    words = text(got)
    assert "Started debugpy" in words and "Stopped: breakpoint" in words and "prog.py:3" in words
    assert ">    3 x3 = 3" in words and "line = 3" in words
    status = text(await t["debug_status"].handler({}))
    assert "You have it." in status and "Stopped: breakpoint" in status
    assert "#1000 main" in text(await t["debug_stack"].handler({}))
    variables = text(await t["debug_variables"].handler({}))
    assert (
        "Locals:" in variables
        and "data = {'k': 'v'}  (dict)  [ref 101]" in variables
        and "Globals: [ref 200]" in variables
    )
    assert "'k' = 'v'" in text(await t["debug_variables"].handler({"ref": 101}))
    assert text(await t["debug_evaluate"].handler({"expression": "x3"})).startswith("x3 -> 3")
    bad = await t["debug_evaluate"].handler({"expression": "boom"})
    assert bad["is_error"] and "NameError" in text(bad)
    set_ = text(await t["debug_breakpoints"].handler({"file": "prog.py", "lines": [6, 99]}))
    assert "prog.py:6" in set_ and "prog.py:99 (not set: no code there)" in set_
    step = text(await t["debug_step"].handler({"kind": "over"}))
    assert "Stopped: step" in step and "prog.py:4" in step
    on = text(await t["debug_continue"].handler({}))
    assert "prog.py:6" in on
    end = text(await t["debug_continue"].handler({}))
    assert "The program ended (exit code 0)." in end and "done" in end
    assert await until(
        lambda: any(k == "dbg_state" and d["run"] and d["run"]["state"] == "ended" for k, d in seen)
    )
    stopped = text(await t["debug_stop"].handler({}))
    assert stopped == "Stopped."
    assert desk.runs[7].proc.returncode is not None


async def test_paths_must_be_inside_the_project(hub, project, tmp_path):
    desk = desk_with_fake(hub)
    t = tools_of(desk, session(hub, project))
    (tmp_path / "outside.py").write_text("x = 1\n")
    got = await t["debug_launch"].handler(
        {"language": "python", "program": str(tmp_path / "outside.py")}
    )
    assert got["is_error"] and "isn't a file inside this project" in text(got)
    got = await t["debug_launch"].handler(
        {
            "language": "python",
            "program": "prog.py",
            "breakpoints": [{"file": "../outside.py", "line": 1}],
        }
    )
    assert got["is_error"] and "inside this project" in text(got)
    got = await t["debug_launch"].handler({"language": "swift", "module": "x"})
    assert got["is_error"] and "module is for Python" in text(got)
    assert desk.runs == {}


async def test_a_missing_debugger_is_explained_and_never_installed(hub, project):
    desk = desk_with_fake(hub, missing=("python",))
    t = tools_of(desk, session(hub, project))
    listing = text(await t["debug_adapters"].handler({}))
    assert (
        "debugpy (python): not installed. Install it with: python3 -m pip install debugpy"
        in listing
    )
    assert "lldb-dap (swift, c): ready" in listing
    got = await t["debug_launch"].handler({"language": "python", "program": "prog.py"})
    assert (
        got["is_error"]
        and "isn't installed here" in text(got)
        and "don't install it yourself" in text(got)
    )
    got = await t["debug_launch"].handler({"language": "cobol", "program": "prog.py"})
    assert got["is_error"] and "No debugger for 'cobol'" in text(got)


async def test_attaching_to_a_process_it_didnt_start_asks_the_owner(hub, project):
    desk = desk_with_fake(hub)
    t = tools_of(desk, session(hub, project))
    asked = []

    async def no(question, detail="", choices=None, context=None, spoken=""):
        asked.append((question, detail, context))
        return "deny"

    hub.request_approval = no
    got = await t["debug_attach"].handler({"language": "python", "pid": 999999})
    assert got["is_error"] and "said no" in text(got)
    assert "process 999999" in asked[0][0] and asked[0][2]["tap_only"] is True
    assert desk.runs == {}
    got = await t["debug_attach"].handler({"language": "python", "port": 5678, "host": "10.0.0.2"})
    assert got["is_error"] and "only on this computer" in text(got)
    # one this debugger launched (its pid, as the adapter said) is attached unasked
    await t["debug_launch"].handler(
        {"language": "python", "program": "prog.py", "stop_on_entry": True}
    )
    pid = next(iter(desk.runs[7].pids))
    other = tools_of(desk, session(hub, project, id_=8))
    asked.clear()
    got = await other["debug_attach"].handler({"language": "c", "pid": pid})
    assert "is_error" not in got, text(got)
    assert asked == [] and desk.runs[8].request_kind == "attach"
    for run in list(desk.runs.values()):
        await run.stop()


async def test_the_owner_takes_over_in_the_pane_and_hands_it_back(hub, project):
    desk = desk_with_fake(hub)
    task = session(hub, project)
    t = tools_of(desk, task)
    seen = record(hub)
    await t["debug_launch"].handler(
        {"language": "python", "program": "prog.py", "stop_on_entry": True}
    )
    await hub.handle({"type": "dbg_state", "id": 7})
    assert await until(lambda: any(k == "dbg_state" and d.get("adapters") for k, d in seen))
    state = [d for k, d in seen if k == "dbg_state" and d.get("adapters")][-1]
    assert (
        state["on"] is True
        and state["run"]["state"] == "stopped"
        and state["run"]["control"] == "agent"
    )
    assert {a["id"] for a in state["adapters"]} == {"python", "node", "lldb"}
    await hub.handle({"type": "dbg_do", "id": 7, "action": "take"})
    assert await until(lambda: desk.runs[7].control == "user")
    blocked = await t["debug_step"].handler({"kind": "over"})
    assert blocked["is_error"] and "taken over" in text(blocked)
    assert "The user has it in the Debug pane." in text(await t["debug_status"].handler({}))
    # the owner steps, opens a variable, evaluates, sets a breakpoint
    await hub.handle({"type": "dbg_do", "id": 7, "action": "next"})
    assert await until(lambda: desk.runs[7].frames and desk.runs[7].frames[0]["line"] == 2)
    await hub.handle({"type": "dbg_do", "id": 7, "action": "frame", "frame": 1000})
    assert await until(lambda: desk.runs[7].scopes and desk.runs[7].scopes[0]["variables"])
    await hub.handle({"type": "dbg_do", "id": 7, "action": "expand", "ref": 101})
    assert await until(lambda: any(k == "dbg_vars" and d["ref"] == 101 for k, d in seen))
    await hub.handle({"type": "dbg_do", "id": 7, "action": "evaluate", "expression": "x1"})
    assert await until(
        lambda: any(k == "dbg_eval" and d.get("result") == "x1 -> 2" for k, d in seen)
    )
    await hub.handle(
        {"type": "dbg_do", "id": 7, "action": "breakpoint", "file": "prog.py", "line": 5}
    )
    assert await until(lambda: str(project / "prog.py") in desk.runs[7].breakpoints)
    await hub.handle({"type": "dbg_do", "id": 7, "action": "release"})
    assert await until(lambda: desk.runs[7].control == "agent")
    on = text(await t["debug_continue"].handler({}))
    assert "prog.py:5" in on
    await hub.handle({"type": "dbg_do", "id": 7, "action": "bogus"})
    assert await until(
        lambda: any(k == "dbg_error" and "Unknown debugger action" in d["error"] for k, d in seen)
    )
    await hub.handle({"type": "dbg_do", "id": 7, "action": "stop"})
    assert await until(lambda: desk.runs[7].state == "ended")


async def test_the_owner_starts_a_run_of_their_own_in_the_pane(hub, project):
    desk = desk_with_fake(hub)
    session(hub, project)
    await hub.handle(
        {
            "type": "dbg_do",
            "id": 7,
            "action": "launch",
            "language": "python",
            "program": "prog.py",
            "args": "--fast 'two words'",
            "stop_on_entry": True,
        }
    )
    assert await until(lambda: 7 in desk.runs and desk.runs[7].state == "stopped", tries=1000)
    run = desk.runs[7]
    assert run.driver == "user" and run.control == "user"
    await run.stop()


async def test_off_the_pane_cant_start_a_run_and_a_gone_session_takes_its_run(hub, project):
    desk = desk_with_fake(hub)
    task = session(hub, project)
    seen = record(hub)
    hub.prefs.features[code_debugger.PREF] = False
    await hub.handle(
        {"type": "dbg_do", "id": 7, "action": "launch", "language": "python", "program": "prog.py"}
    )
    assert await until(
        lambda: any(k == "dbg_error" and "debugger is off" in d["error"] for k, d in seen)
    )
    hub.prefs.features[code_debugger.PREF] = True
    t = tools_of(desk, task)
    await t["debug_launch"].handler(
        {"language": "python", "program": "prog.py", "stop_on_entry": True}
    )
    run = desk.runs[7]
    task.status = "stopped"
    desk.tasks_changed({})
    assert 7 not in desk.runs
    assert await until(lambda: run.state == "ended" and run.proc.returncode is not None, tries=1000)


async def test_a_new_launch_ends_the_sessions_earlier_run_and_runs_are_capped(
    hub, project, monkeypatch
):
    desk = desk_with_fake(hub)
    t = tools_of(desk, session(hub, project))
    await t["debug_launch"].handler(
        {"language": "python", "program": "prog.py", "stop_on_entry": True}
    )
    first = desk.runs[7]
    await t["debug_launch"].handler(
        {"language": "python", "program": "prog.py", "stop_on_entry": True}
    )
    assert first.state == "ended" and "new run" in first.reason and desk.runs[7] is not first
    monkeypatch.setattr(code_debugger, "RUNS_MAX", 1)
    other = tools_of(desk, session(hub, project, id_=8))
    got = await other["debug_launch"].handler({"language": "python", "program": "prog.py"})
    assert got["is_error"] and "1 debug runs are going already" in text(got)
    await desk.runs[7].stop()


async def test_no_run_says_how_to_start_one(hub, project):
    desk = desk_with_fake(hub)
    t = tools_of(desk, session(hub, project))
    got = await t["debug_continue"].handler({})
    assert got["is_error"] and "start one with debug_launch" in text(got)


def test_the_setting_is_registered_on_by_default():
    from jarvis import prefs

    assert prefs.FEATURE_PREFS[code_debugger.PREF][0] is True
    assert code_dap.STEPS_MAX > 0 and code_dap.WAIT_MAX >= code_dap.WAIT_SECONDS
