"""Eden Code's debugger, its protocol side (code_dap.py): the DAP wire, a run against a fake
adapter over stdio and over TCP (tests/fake_dap.py, never a real debugger), its limits, and
how the adapters are found and explained when they're missing."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

from jarvis import code_dap
from jarvis.code_dap import Adapter, DapClient, DapError, DebugSession

FAKE = str(Path(__file__).with_name("fake_dap.py"))


def fake_adapter(transport="stdio", id_="python"):
    return Adapter(id_, "fake-dap", ("python",), [sys.executable, FAKE], transport=transport)


def program(tmp_path, lines=10):
    path = tmp_path / "prog.py"
    path.write_text("".join(f"x{i} = {i}\n" for i in range(1, lines + 1)))
    return path


def session(tmp_path, mode="", transport="stdio", **kw):
    env = {**os.environ, "FAKE_DAP_MODE": mode}
    return DebugSession(fake_adapter(transport), tmp_path, env, **kw)


# ── the wire ──


async def test_messages_round_trip_through_the_framing():
    reader = asyncio.StreamReader()
    reader.feed_data(code_dap.encode({"type": "event", "event": "x", "body": {"a": "é"}}))
    reader.feed_data(b"\r\n" + code_dap.encode({"type": "response"}))
    reader.feed_eof()
    assert await code_dap.read_message(reader) == {
        "type": "event",
        "event": "x",
        "body": {"a": "é"},
    }
    assert await code_dap.read_message(reader) == {"type": "response"}
    assert await code_dap.read_message(reader) is None


async def test_a_message_too_long_or_not_json_is_refused():
    reader = asyncio.StreamReader()
    reader.feed_data(b"Content-Length: %d\r\n\r\n" % (code_dap.MESSAGE_MAX + 1))
    with pytest.raises(DapError):
        await code_dap.read_message(reader)
    reader = asyncio.StreamReader()
    reader.feed_data(b"Content-Length: 3\r\n\r\n{x}")
    with pytest.raises(DapError):
        await code_dap.read_message(reader)


class Pipe:
    """A writer whose bytes another reader gets (the client's requests, read back)."""

    def __init__(self):
        self.out = asyncio.StreamReader()

    def write(self, data):
        self.out.feed_data(data)

    async def drain(self):
        pass

    def close(self):
        self.out.feed_eof()


async def test_a_refused_request_raises_with_the_adapters_words_and_an_unanswered_one_times_out():
    adapter_says = asyncio.StreamReader()
    pipe = Pipe()
    client = DapClient(adapter_says, pipe)
    client.start()
    task = asyncio.ensure_future(client.request("evaluate", {"expression": "x"}))
    sent = await code_dap.read_message(pipe.out)
    assert sent["command"] == "evaluate" and sent["arguments"] == {"expression": "x"}
    adapter_says.feed_data(
        code_dap.encode(
            {
                "type": "response",
                "request_seq": sent["seq"],
                "success": False,
                "command": "evaluate",
                "body": {"error": {"format": "no {name} here", "variables": {"name": "x"}}},
            }
        )
    )
    with pytest.raises(DapError, match="no x here"):
        await task
    with pytest.raises(DapError, match="didn't answer threads"):
        await client.request("threads", timeout=0.05)
    adapter_says.feed_eof()
    await asyncio.sleep(0.01)
    assert client.closed
    with pytest.raises(DapError):
        await client.request("threads")
    await client.close()


async def test_reverse_requests_other_than_start_debugging_are_refused():
    adapter_says = asyncio.StreamReader()
    pipe = Pipe()
    client = DapClient(adapter_says, pipe)
    client.start()
    adapter_says.feed_data(
        code_dap.encode({"seq": 1, "type": "request", "command": "runInTerminal", "arguments": {}})
    )
    answer = await code_dap.read_message(pipe.out)
    assert (
        answer["type"] == "response" and answer["request_seq"] == 1 and answer["success"] is False
    )
    assert "debug console" in answer["message"]
    await client.close()


# ── a run against the fake adapter ──


async def test_launch_stops_at_a_breakpoint_with_its_stack_source_and_locals(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path)
    changes = []
    s.on_change = lambda: changes.append(s.state)
    bps = {str(prog): [code_dap.Breakpoint(4), code_dap.Breakpoint(40)]}
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), cwd=str(tmp_path)), bps)
    try:
        report = await s.wait(5)
        assert report["state"] == "stopped" and report["reason"] == "breakpoint"
        assert report["frames"][0]["line"] == 4 and report["frames"][0]["file"] == str(prog)
        assert any(line.startswith(">    4 x4 = 4") for line in report["source"])
        assert report["scopes"][0]["variables"][0] == {
            "name": "line",
            "value": "4",
            "type": "int",
            "ref": 0,
        }
        assert report["scopes"][1]["variables"] == []  # (expensive: not loaded unasked)
        assert [b.verified for b in s.breakpoints[str(prog)]] == [True, False]
        assert s.breakpoints[str(prog)][1].message == "no code there"
        assert s.pids  # the debuggee's process, as the adapter told it
        text = code_dap.report_text(report, tmp_path)
        assert (
            "Stopped: breakpoint" in text
            and "#1000 main at prog.py:4" in text
            and "line = 4" in text
        )
        # a step, then the end
        step = await s.resume("next")
        assert step["state"] == "stopped" and step["frames"][0]["line"] == 5
        children = await s.variables(101)
        assert children[0]["value"] == "'v'"
        assert (await s.evaluate("x4"))["result"] == "x4 -> 5"
        with pytest.raises(DapError, match="NameError"):
            await s.evaluate("boom")
        end = await s.resume("continue")
        assert end["state"] == "ended" and "exit code 0" in s.reason
        assert "done" in end["output"]
        assert "stopped" in changes
    finally:
        await s.stop()
    assert s.state == "ended" and s.proc.returncode is not None


async def test_values_and_lists_are_capped(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path)
    await s.launch(
        code_dap.launch_config(s.adapter, program=str(prog), cwd=str(tmp_path), stop_on_entry=True)
    )
    try:
        await s.wait(5)
        many = await s.variables(200)
        assert len(many) == code_dap.VARS_MAX
        assert len(many[0]["value"]) == code_dap.VALUE_MAX and many[0]["value"].endswith("…")
    finally:
        await s.stop()
    assert "disconnect terminate=True" in s.output


async def test_stepping_has_a_limit(tmp_path):
    prog = program(tmp_path, lines=50)
    s = session(tmp_path, steps_max=2)
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    try:
        await s.wait(5)
        await s.resume("next")
        await s.resume("next")
        with pytest.raises(DapError, match="used its 2 continues and steps"):
            await s.resume("next")
    finally:
        await s.stop()


async def test_a_step_needs_a_stopped_program_and_reading_does_too(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path, mode="forever")
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    try:
        await s.wait(5)
        running = await s.resume("continue", wait=0.2)
        assert running == {"state": "running", "note": "Still running after 0.2s."}
        assert "Running. Still running" in code_dap.report_text(running)
        with pytest.raises(DapError, match="isn't stopped"):
            await s.resume("next")
        with pytest.raises(DapError, match="isn't stopped"):
            await s.stack()
        paused = await s.pause()
        assert paused["state"] == "stopped" and paused["reason"] == "pause"
    finally:
        await s.stop()


async def test_an_exception_stop_says_what_was_raised(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path, mode="exception")
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    try:
        await s.wait(5)
        report = await s.resume("continue")
        assert report["reason"] == "exception" and "ZeroDivisionError" in report["exception"]
        assert "Exception: ZeroDivisionError" in code_dap.report_text(report)
    finally:
        await s.stop()


async def test_an_adapter_that_never_gets_ready_times_out_and_is_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr(code_dap, "START_SECONDS", 0.5)
    prog = program(tmp_path)
    s = session(tmp_path, mode="hang")
    with pytest.raises(DapError, match="didn't get ready"):
        await s.launch(code_dap.launch_config(s.adapter, program=str(prog)))
    assert s.state == "ended"
    assert s.proc.returncode is not None


async def test_a_missing_adapter_says_how_to_install_it(tmp_path):
    missing = Adapter("python", "debugpy", ("python",), None, install="pip install debugpy")
    s = DebugSession(missing, tmp_path, dict(os.environ))
    with pytest.raises(DapError, match="debugpy isn't installed. pip install debugpy"):
        await s.launch({})


async def test_the_whole_run_has_a_time_limit(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path, seconds_max=0.6)
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    for _ in range(60):
        if s.state == "ended":
            break
        await asyncio.sleep(0.05)
    assert s.state == "ended" and "the debugger's limit" in s.reason


async def test_run_in_terminal_is_refused_and_the_program_still_runs(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path, mode="terminal")
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    try:
        await s.wait(5)
        for _ in range(40):
            if any("runInTerminal" in line for line in s.output):
                break
            await asyncio.sleep(0.02)
        assert any(line.startswith("runInTerminal: False") for line in s.output)
    finally:
        await s.stop()


async def test_breakpoints_set_while_running_reach_the_adapter(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path)
    await s.launch(code_dap.launch_config(s.adapter, program=str(prog), stop_on_entry=True))
    try:
        await s.wait(5)
        set_ = await s.set_breakpoints(str(prog), [(7, "x > 1")])
        assert set_[0].verified is True and set_[0].condition == "x > 1"
        report = await s.resume("continue")
        assert report["frames"][0]["line"] == 7
        assert await s.set_breakpoints(str(prog), []) == []
        assert str(prog) not in s.breakpoints
        snap = s.snapshot()
        assert (
            snap["state"] == "stopped"
            and snap["frames"][0]["line"] == 7
            and snap["control"] == "agent"
        )
    finally:
        await s.stop()


async def test_an_attached_process_is_left_running_and_a_launched_one_is_not(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path)
    await s.attach(
        {"request": "attach", "program": str(prog), "stopOnEntry": True, "processId": 4242}
    )
    assert s.target == "process 4242"
    await s.wait(5)
    await s.stop()
    # (the fake prints the disconnect's terminateDebuggee before it answers)
    assert "disconnect terminate=False" in s.output


async def test_tcp_adapter_with_a_child_session_as_js_debug_has(tmp_path):
    prog = program(tmp_path)
    s = session(tmp_path, mode="child", transport="tcp")
    await s.launch(
        code_dap.launch_config(fake_adapter("tcp", "node"), program=str(prog), stop_on_entry=True)
    )
    try:
        for _ in range(100):
            if s.child is not None and s.state == "stopped":
                break
            await asyncio.sleep(0.03)
        assert s.child is not None and s.port
        report = await s.wait(5)
        assert report["state"] == "stopped" and report["reason"] == "entry"
        step = await s.resume("next")
        assert step["frames"][0]["line"] == 2
    finally:
        await s.stop()
    assert s.state == "ended"


# ── the adapters ──


def test_adapters_found_and_missing_ones_explained(tmp_path, monkeypatch):
    venv = tmp_path / ".venv" / "bin"
    venv.mkdir(parents=True)
    (venv / "python3").write_text("")
    monkeypatch.setattr(code_dap, "_quiet", lambda argv, env, timeout=10.0: (1, ""))
    monkeypatch.setattr(code_dap, "lldb_dap", lambda env: None)
    monkeypatch.setattr(code_dap, "js_debug_server", lambda env: None)
    code_dap._detected.clear()
    found = {a.id: a for a in code_dap.find_adapters(tmp_path, {"PATH": ""})}
    assert found["python"].runtime == str(venv / "python3")
    assert not found["python"].available and "-m pip install debugpy" in found["python"].install
    assert not found["node"].available and "Node.js isn't installed" in found["node"].install
    assert not found["lldb"].available and "lldb-dap" in found["lldb"].install
    assert found["python"].public()["install"]
    code_dap._detected.clear()
    monkeypatch.setattr(code_dap, "_quiet", lambda argv, env, timeout=10.0: (0, ""))
    py = {a.id: a for a in code_dap.find_adapters(tmp_path, {"PATH": ""})}["python"]
    assert (
        py.command == [str(venv / "python3"), "-m", "debugpy.adapter"]
        and py.public()["install"] == ""
    )
    code_dap._detected.clear()


def test_language_names_pick_their_adapter():
    adapters = [
        Adapter("python", "debugpy", ("python",), None),
        Adapter("node", "js-debug", ("javascript", "typescript", "node"), None),
        Adapter("lldb", "lldb-dap", ("swift", "c", "cpp"), None),
    ]
    assert code_dap.adapter_for("Python", adapters).id == "python"
    assert code_dap.adapter_for("ts", adapters).id == "node"
    assert code_dap.adapter_for("c++", adapters).id == "lldb"
    assert code_dap.adapter_for("swift", adapters).id == "lldb"
    assert code_dap.adapter_for("cobol", adapters) is None


def test_launch_and_attach_configs():
    py = Adapter("python", "debugpy", ("python",), ["p"], runtime="/v/python")
    cfg = code_dap.launch_config(py, module="pytest", args=["-x", 3], cwd="/p")
    assert (
        cfg["module"] == "pytest" and cfg["args"] == ["-x", "3"] and cfg["python"] == ["/v/python"]
    )
    assert "program" not in cfg and cfg["console"] == "internalConsole"
    node = Adapter("node", "js-debug", ("node",), ["n"], runtime="/bin/node")
    assert code_dap.launch_config(node, program="a.js")["type"] == "pwa-node"
    assert code_dap.attach_config(py, port=5678)["connect"] == {"host": "127.0.0.1", "port": 5678}
    lldb = Adapter("lldb", "lldb-dap", ("c",), ["l"])
    assert code_dap.attach_config(lldb, pid=7) == {"name": "Eden Code", "pid": 7}
    with pytest.raises(DapError):
        code_dap.attach_config(lldb, port=1)
