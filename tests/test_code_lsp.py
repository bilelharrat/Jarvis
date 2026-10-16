"""Language servers for Eden Code's sessions (lsp.py, code_lsp_mcp.py, features/code_lsp.py):
the protocol's framing and positions, finding a server (never a project's own copy, never
installing one), the session tools against a fake server speaking JSON-RPC over stdio
(tests/fake_lsp_server.py), the rename as a plan of Edit calls, live diagnostics into the
Problems pane, and every way a server stops: its session ending, idle, too big, too many,
crashing, talking nonsense, hanging, ignoring exit."""

import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from code_session_fakes import make_hub, until

from jarvis import code_lsp_mcp as clm
from jarvis import lsp
from jarvis.features import code_lsp as fcl
from jarvis.tasks import ClaudeTask

FAKE = Path(__file__).with_name("fake_lsp_server.py")

APP = '''def send(name):
    """Send one."""
    return name


def send_all(names):
    return [send(n) for n in names]  # é 😀 send
'''
USE = """from app import send

def main():
    send("x")
    send("y")
"""


def env():
    return dict(os.environ)


def fake_spec(*flags, record=None, sid="python"):
    command = (sys.executable, str(FAKE), *flags)
    if record is not None:
        command += ("--record", str(record))
    return lsp.Spec(sid, "Python", {".py": "python"}, (command,), "pipx install basedpyright")


def manager(*flags, record=None, **kw):
    return lsp.Manager(env=env, specs=(fake_spec(*flags, record=record),), **kw)


def received(record):
    if not record.exists():
        return []
    return [json.loads(line) for line in record.read_text().splitlines()]


def methods(record):
    return [m.get("method") for m in received(record)]


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "app.py").write_text(APP)
    (root / "use.py").write_text(USE)
    return root.resolve()


async def call(mgr, root, name, user=None, **args):
    return await clm.run_tool(mgr, root, name, args, user)


# ── positions, framing ──


def test_lines_count_utf16_columns_and_every_line_ending():
    lines = lsp.Lines("a😀b\r\nsecond\rthird\nlast")
    assert len(lines) == 4 and lines.line(1) == "second" and lines.line(3) == "last"
    assert lines.offset(0, 3) == 2  # the emoji is two UTF-16 units: b is at column 3
    assert lines.position(2) == (0, 3)
    assert lines.offset(1, 99) == lines.ends[1]  # a column past the end is the line's end
    assert lines.offset(9, 0) == len(lines.text)
    assert lsp.utf16_len("é😀") == 3 and lsp.index_of_utf16("é😀x", 3) == 2


async def test_messages_are_framed_and_nonsense_or_a_huge_one_is_refused():
    reader = asyncio.StreamReader()
    reader.feed_data(lsp.frame({"jsonrpc": "2.0", "id": 1, "result": "é"}) * 2)
    reader.feed_eof()
    assert (await lsp.read_message(reader))["result"] == "é"
    assert (await lsp.read_message(reader))["id"] == 1
    assert await lsp.read_message(reader) is None
    noisy = asyncio.StreamReader()
    noisy.feed_data(b"hello from the server\r\n\r\n{}")
    with pytest.raises(lsp.ProtocolError):
        await lsp.read_message(noisy)
    huge = asyncio.StreamReader()
    huge.feed_data(b"Content-Length: 99999999999\r\n\r\n")
    with pytest.raises(lsp.ProtocolError, match="MB"):
        await lsp.read_message(huge)
    cut = asyncio.StreamReader()
    cut.feed_data(b"Content-Length: 10\r\n\r\n{}")
    cut.feed_eof()
    with pytest.raises(lsp.ProtocolError, match="middle"):
        await lsp.read_message(cut)


def test_uris_round_trip_with_spaces_and_accents(tmp_path):
    path = (tmp_path / "a folder é" / "x.py").resolve()
    assert lsp.path_of(lsp.uri_of(path)) == path
    assert lsp.path_of("untitled:Untitled-1") is None


# ── finding a server ──


def _exe(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def test_a_missing_server_says_how_to_install_it_and_nothing_is_installed(project, monkeypatch):
    monkeypatch.setattr(lsp, "EXTRA_DIRS", ())
    spec = lsp.SPECS[0]
    argv, why = lsp.find_command(spec, project, {"PATH": "/nonexistent"})
    assert argv is None
    assert "never installs" in why and "pipx install basedpyright" in why


def test_a_project_s_own_copy_is_named_but_never_started(project, tmp_path, monkeypatch):
    monkeypatch.setattr(lsp, "EXTRA_DIRS", ())
    _exe(project / "node_modules" / ".bin" / "typescript-language-server")
    ts = lsp.spec_for("x.ts")[0]
    # Even on the PATH, a copy inside the project isn't used.
    argv, why = lsp.find_command(ts, project, {"PATH": str(project / "node_modules" / ".bin")})
    assert argv is None and "node_modules/.bin/typescript-language-server" in why
    assert "outside the project" in why
    mine = _exe(tmp_path / "bin" / "typescript-language-server")
    argv, why = lsp.find_command(ts, project, {"PATH": str(mine.parent)})
    assert argv == [str(mine), "--stdio"] and why == ""


def test_the_usual_tool_folders_are_looked_in_beyond_the_path(project, tmp_path, monkeypatch):
    gopls = _exe(tmp_path / "go" / "bin" / "gopls")
    monkeypatch.setattr(lsp, "EXTRA_DIRS", (str(gopls.parent),))
    argv, _ = lsp.find_command(lsp.spec_for("main.go")[0], project, {"PATH": "relative/bin"})
    assert argv == [str(gopls)]


def test_each_language_has_its_server_and_rust_runs_no_project_code():
    assert lsp.spec_for("a.py")[0].id == "python" and lsp.spec_for("A.TSX")[1] == "typescriptreact"
    assert lsp.spec_for("x.swift")[0].commands[-1] == ("xcrun:sourcekit-lsp",)
    assert lsp.spec_for("main.go")[0].id == "go" and lsp.spec_for("lib.rs")[0].id == "rust"
    assert lsp.spec_for("a.mm")[1] == "objective-cpp" and lsp.spec_for("README.md") is None
    rust = lsp.spec_for("lib.rs")[0].init_options
    assert rust["cargo"]["buildScripts"]["enable"] is False and rust["procMacro"]["enable"] is False


async def test_a_file_no_server_knows_says_which_languages_there_are(project):
    (project / "notes.md").write_text("hi\n")
    text, error = await call(manager(), project, "hover_info", file="notes.md", line=1, symbol="hi")
    assert error and "no language server for .md" in text and "Python" in text


async def test_none_installed_is_said_as_an_error_with_the_install_line(project, monkeypatch):
    monkeypatch.setattr(lsp, "EXTRA_DIRS", ())
    mgr = lsp.Manager(env=lambda: {"PATH": "/nonexistent"})
    text, error = await call(mgr, project, "find_references", file="app.py", line=1, symbol="send")
    assert error and "pipx install basedpyright" in text
    listed, error = await call(mgr, project, "language_servers")
    assert not error and "Python: not installed. To install: pipx install basedpyright" in listed


# ── the tools, against the fake server ──


async def test_definition_references_and_hover_across_files(project, tmp_path):
    record = tmp_path / "rec.jsonl"
    mgr = manager(record=record)
    try:
        text, error = await call(
            mgr, project, "go_to_definition", file="use.py", line=4, symbol="send"
        )
        assert not error, text
        assert "app.py:1:5" in text and "def send(name):" in text
        text, error = await call(
            mgr, project, "find_references", file="app.py", line=1, symbol="send"
        )
        assert not error, text
        assert "6 references to `send` in 2 files" in text
        # Columns in characters: the emoji counts once, though the protocol counts it twice.
        assert "  7:44  return [send(n) for n in names]" in text
        assert "use.py\n  1:17" in text
        text, _ = await call(
            mgr, project, "find_references", file="app.py", line=1, symbol="send",
            include_declaration=False,
        )  # fmt: skip
        assert "5 references" in text
        text, error = await call(mgr, project, "hover_info", file="use.py", line=4, symbol="send")
        assert not error and "def send(...)" in text and "A fake symbol." in text
        typed, _ = await call(
            mgr, project, "go_to_definition", file="use.py", line=4, symbol="send", kind="type"
        )
        assert typed.startswith("Its type is defined at")
        # Asked of the client after initialized, as real servers do: both answered.
        answers = [m for m in received(record) if "result" in m and "method" not in m]
        assert {"id": 1001, "jsonrpc": "2.0", "result": [None]} in answers
        assert any(m["id"] == 1002 and m["result"] is None for m in answers)
        assert methods(record)[:2] == ["initialize", "initialized"]
    finally:
        await mgr.close()


async def test_a_place_is_a_line_and_a_name_and_mistakes_are_said(project):
    mgr = manager()
    try:
        text, error = await call(mgr, project, "hover_info", file="app.py", line=99, symbol="send")
        assert error and "has 8 lines" in text  # (the protocol counts the empty last one)
        text, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="nope")
        assert error and "isn't on line 1" in text and "def send(name):" in text
        text, error = await call(mgr, project, "hover_info", file="app.py", line=1)
        assert error and "Which symbol" in text
        text, error = await call(
            mgr, project, "hover_info", file="../outside.py", line=1, symbol="x"
        )
        assert error and "outside the project" in text
        text, error = await call(mgr, project, "hover_info", file="", line=1)
        assert error and "Which file" in text
        # The second `send` on line 7 (by its column), not the first.
        text, _ = await call(
            mgr, project, "go_to_definition", file="app.py", line=7, symbol="send", column=44
        )
        assert "app.py:1:5" in text
        text, error = await call(mgr, project, "no_such_tool", file="app.py", line=1, symbol="send")
        assert error and "No tool named" in text
    finally:
        await mgr.close()


def _apply_plan(text):
    """Make a rename plan's Edit calls as Claude Code's Edit tool would."""
    calls = json.loads(text[text.index("\n[") :])
    for c in calls:
        path = Path(c["file_path"])
        body = path.read_text()
        if c.get("replace_all"):
            body = body.replace(c["old_string"], c["new_string"])
        else:
            assert body.count(c["old_string"]) == 1, c  # Edit refuses one that isn't unique
            body = body.replace(c["old_string"], c["new_string"])
        path.write_text(body)
    return calls


async def test_a_rename_is_a_plan_of_edit_calls_that_changes_nothing_itself(project):
    mgr = manager()
    before = {p.name: p.read_text() for p in project.iterdir()}
    try:
        text, error = await call(
            mgr, project, "rename_symbol", file="app.py", line=1, symbol="send", new_name="post"
        )
        assert not error, text
        assert "Nothing has been changed yet" in text and "Edit tool" in text
        assert {p.name: p.read_text() for p in project.iterdir()} == before  # nothing written
        calls = _apply_plan(text)
        # use.py has `send` only as the symbol: one replace_all. app.py also has send_all,
        # so its edits are lines unique in the file.
        by_file = {Path(c["file_path"]).name: c for c in calls if c.get("replace_all")}
        assert set(by_file) == {"use.py"}
        assert (project / "use.py").read_text() == USE.replace("send", "post")
        app = (project / "app.py").read_text()
        assert "def post(name):" in app and "def send_all(names):" in app
        assert "return [post(n) for n in names]  # é 😀 post" in app
        text, error = await call(
            mgr, project, "rename_symbol", file="app.py", line=1, symbol="def", new_name="x"
        )
        assert error and "can't be renamed" in text
        text, error = await call(
            mgr,
            project,
            "rename_symbol",
            file="app.py",
            line=1,
            symbol="post",
            new_name="two words",
        )
        assert error and "one word" in text
    finally:
        await mgr.close()


def test_a_repeated_line_is_widened_until_its_edit_is_unique(tmp_path):
    path = tmp_path / "x.py"
    text = "a = 1\nprint(old)\nb = 2\nprint(old)\nold_too = old\n"
    path.write_text(text)
    lines = lsp.Lines(text)

    def at(line, col, n=3):
        return {
            "range": {
                "start": {"line": line, "character": col},
                "end": {"line": line, "character": col + n},
            },
            "newText": "new",
        }

    calls = clm.plan_file(path, text, [at(1, 6), at(3, 6), at(4, 10)], "old", "new")
    assert all(text.count(c["old_string"]) == 1 for c in calls)
    out = text
    for c in calls:
        out = out.replace(c["old_string"], c["new_string"])
    assert out == "a = 1\nprint(new)\nb = 2\nprint(new)\nold_too = new\n"
    assert len(lines) == 6
    overlapping = [at(1, 6), at(1, 7)]
    with pytest.raises(clm.ToolError, match="overlap"):
        clm.plan_file(path, text, overlapping, "old", "new")


async def test_a_rename_s_file_operations_and_outside_files_are_named_not_planned(
    project, tmp_path
):
    mgr = manager("--document-changes")
    outside = tmp_path / "lib.py"
    outside.write_text("def send(): pass\n")
    try:
        text, error = await call(
            mgr, project, "rename_symbol", file="use.py", line=1, symbol="send", new_name="post"
        )
        assert not error, text
        assert "file operations, not in the plan" in text and "file:///old.py" in text
        calls = json.loads(text[text.index("\n[") :])
        assert {Path(c["file_path"]).name for c in calls} == {"app.py", "use.py"}
        change = {"changes": {lsp.uri_of(outside): [{"range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 8}}, "newText": "post"}]}}  # fmt: skip
        planned = clm.plan_text(project, change, "send", "post")
        assert "Left out, outside the project" in planned and str(outside) in planned
        assert json.loads(planned[planned.index("\n[") :]) == []
    finally:
        await mgr.close()


async def test_the_server_s_own_edits_are_refused(project, tmp_path):
    record = tmp_path / "rec.jsonl"
    mgr = manager("--apply-edit", record=record)
    try:
        await call(
            mgr, project, "rename_symbol", file="use.py", line=1, symbol="send", new_name="p"
        )
        assert await until(
            lambda: any(m.get("result", {}) and m["result"].get("applied") is False
                        for m in received(record) if isinstance(m.get("result"), dict))
        )  # fmt: skip
        assert (project / "use.py").read_text() == USE
    finally:
        await mgr.close()


async def test_diagnostics_see_the_file_as_it_is_now(project, tmp_path):
    record = tmp_path / "rec.jsonl"
    mgr = manager(record=record)
    try:
        text, error = await call(mgr, project, "diagnostics", file="app.py")
        assert not error and text == "app.py: no problems (python)."
        (project / "app.py").write_text(APP + "x = undefined_name  # TODO\n")
        text, error = await call(mgr, project, "diagnostics", file="app.py")
        assert not error
        assert "app.py: 1 error, 1 warning" in text
        assert "8:5 error [fake-rule] (fakepy) `undefined_name` is not defined" in text
        assert "textDocument/didChange" in methods(record)
        everything, _ = await call(mgr, project, "diagnostics")
        assert everything.startswith("2 problems") and "app.py: 1 error" in everything
        # A file changed on disk is sent again before any request, not only the one asked.
        (project / "app.py").write_text(APP)
        await call(mgr, project, "hover_info", file="use.py", line=4, symbol="send")
        everything, _ = await call(mgr, project, "diagnostics")
        assert "No problems" in everything
    finally:
        await mgr.close()


async def test_diagnostics_are_asked_for_when_the_server_answers_that(project, tmp_path):
    record = tmp_path / "rec.jsonl"
    mgr = manager("--pull", record=record)
    (project / "app.py").write_text(APP + "undefined_name\n")
    try:
        text, error = await call(mgr, project, "diagnostics", file="app.py", wait_seconds=0)
        assert not error and "1 error" in text
        assert "textDocument/diagnostic" in methods(record)
    finally:
        await mgr.close()


async def test_without_a_server_running_diagnostics_asks_for_a_file(project):
    text, error = await call(manager(), project, "diagnostics")
    assert not error and "name a file" in text


# ── the failures a server can have ──


async def test_a_busy_server_is_asked_again(project):
    mgr = manager("--busy", "2")
    try:
        text, error = await call(
            mgr, project, "find_references", file="app.py", line=1, symbol="send"
        )
        assert not error and "6 references" in text
    finally:
        await mgr.close()


async def test_a_request_that_takes_too_long_is_given_up_and_the_server_still_answers(
    project, monkeypatch, tmp_path
):
    monkeypatch.setattr(lsp, "REQUEST_SECONDS", 0.5)
    record = tmp_path / "rec.jsonl"
    mgr = manager("--slow", "textDocument/hover", record=record)
    try:
        text, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
        assert error and "took more than" in text
        assert await until(lambda: "$/cancelRequest" in methods(record))
        text, error = await call(
            mgr, project, "go_to_definition", file="use.py", line=4, symbol="send"
        )
        assert not error and "app.py:1:5" in text
    finally:
        await mgr.close()


async def test_a_server_that_crashes_says_why_and_is_held_off_after_a_few(project, monkeypatch):
    mgr = manager("--die-after-init")
    first, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
    assert error and "something broke" in first, first
    for _ in range(lsp.RESTARTS_MAX):
        text, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
        assert error
    assert "stopped starting it for now" in text
    await mgr.close()


async def test_a_server_that_talks_nonsense_is_stopped(project):
    mgr = manager("--noise")
    try:
        server, _ = await mgr.server(project, project / "app.py")
        assert await until(lambda: not server.alive, tries=600)
        assert "isn't the protocol" in server.why
        text, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
        # (started again, and it talks nonsense again: stopped again, said)
        assert error or "def send" in text
    finally:
        await mgr.close()


async def test_a_server_that_ignores_exit_is_stopped_the_hard_way(project):
    mgr = manager("--ignore-exit")
    server, _ = await mgr.server(project, project / "app.py")
    pid = server.pid
    await mgr.close()
    assert server.proc.returncode is not None and not mgr.servers
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


async def test_only_so_many_files_are_open_in_a_server(project, monkeypatch, tmp_path):
    monkeypatch.setattr(lsp, "OPEN_MAX", 1)
    record = tmp_path / "rec.jsonl"
    mgr = manager(record=record)
    try:
        await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
        await call(mgr, project, "hover_info", file="use.py", line=4, symbol="send")
        server = mgr.running(project)[0]
        assert list(server.docs) == [lsp.uri_of(project / "use.py")]
        assert "textDocument/didClose" in methods(record)
        big = project / "big.py"
        big.write_text("x = 1\n" * 10)
        monkeypatch.setattr(lsp, "FILE_MAX", 20)
        text, error = await call(mgr, project, "hover_info", file="big.py", line=1, symbol="x")
        assert error and "too big" in text
    finally:
        await mgr.close()


# ── when servers stop ──


async def test_a_server_stops_when_the_last_session_using_it_ends(project, tmp_path):
    record = tmp_path / "rec.jsonl"
    mgr = manager(record=record)
    await call(mgr, project, "hover_info", user=1, file="app.py", line=1, symbol="send")
    await call(mgr, project, "hover_info", user=2, file="app.py", line=1, symbol="send")
    [server] = mgr.running(project)
    assert server.users == {1, 2}
    await mgr.release(1)
    assert server.alive
    await mgr.release(2)
    assert not server.alive and server.proc.returncode is not None and not mgr.servers
    assert methods(record)[-2:] == ["shutdown", "exit"]


async def test_idle_and_oversized_servers_stop_and_too_big_is_held_off(project, monkeypatch):
    mgr = manager(idle_seconds=0.0)
    server, _ = await mgr.server(project, project / "app.py")
    await asyncio.sleep(0.01)
    await mgr.sweep()
    assert not server.alive and "wasn't used" in server.why
    mgr = manager(memory_mb=10)
    server, _ = await mgr.server(project, project / "app.py")
    assert server.memory_mb() > 0  # (psutil sees the real process)
    monkeypatch.setattr(lsp.Server, "memory_mb", lambda self: 5000.0)
    await mgr.sweep()
    assert not server.alive
    text, error = await call(mgr, project, "hover_info", file="app.py", line=1, symbol="send")
    assert error and "5,000 MB" in text and "more than the 10 MB" in text
    listed, _ = await call(mgr, project, "language_servers")
    assert "held off" in listed
    await mgr.close()


async def test_past_the_limit_the_least_recently_used_server_stops(project, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    (other / "x.py").write_text("def send():\n    pass\n")
    mgr = manager(servers_max=1)
    first, _ = await mgr.server(project, project / "app.py")
    second, _ = await mgr.server(other, other / "x.py")
    assert not first.alive and second.alive and "at most 1" in first.why
    await mgr.close()
    assert not second.alive


# ── the stdio server, for ACP agents ──


async def test_the_stdio_server_answers_the_tools_with_servers_of_its_own(project):
    server = clm.LspToolServer(project, manager())
    try:
        hello = await server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )
        assert hello["result"]["serverInfo"]["name"] == "eden_code_lsp"
        listed = await server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert [t["name"] for t in listed["result"]["tools"]] == clm.NAMES
        answer = await server.handle(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "go_to_definition",
                    "arguments": {"file": "use.py", "line": 4, "symbol": "send"},
                },
            }
        )
        assert "app.py:1:5" in answer["result"]["content"][0]["text"]
        assert not answer["result"]["isError"]
    finally:
        await server.manager.close()


async def test_the_command_an_acp_agent_starts_serves_the_tools(project):
    spec = fcl.LspDesk(SimpleNamespace(prefs=None)).stdio_server(project)
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "language_servers", "arguments": {}}},
    ]  # fmt: skip
    proc = await asyncio.create_subprocess_exec(
        spec["command"],
        *spec["args"],
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")},
    )
    out, err = await asyncio.wait_for(
        proc.communicate("".join(json.dumps(m) + "\n" for m in lines).encode()), 60
    )
    answers = {m["id"]: m for m in map(json.loads, out.decode().splitlines())}
    assert answers[1]["result"]["serverInfo"]["name"] == "eden_code_lsp", err.decode()
    assert "Language servers for this project" in answers[2]["result"]["content"][0]["text"]


# ── in the app ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def options():
    return SimpleNamespace(mcp_servers={}, allowed_tools=["TodoWrite"])


def fake_desk(hub, *flags, record=None):
    desk = hub.code_lsp
    desk.manager = lsp.Manager(
        env=env,
        specs=(fake_spec(*flags, record=record),),
        on_diagnostics=desk._published,
        on_change=desk._server_changed,
    )
    return desk


def seen_by(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


def test_a_claude_session_gets_the_tools_in_process_and_an_acp_one_a_command(hub, project):
    desk = hub.code_lsp
    claude = ClaudeTask(id=1, prompt="", cwd=project)
    opts = options()
    desk.extend(claude, opts)
    assert opts.mcp_servers[fcl.SERVER]["type"] == "sdk"
    assert set(fcl.TOOLS) <= set(opts.allowed_tools)
    assert "mcp__eden_code_lsp__rename_symbol" in fcl.TOOLS
    other = ClaudeTask(id=2, prompt="", cwd=project, model_ref="acp:codex")
    opts = options()
    desk.extend(other, opts)
    spec = opts.mcp_servers[fcl.SERVER]
    assert spec["type"] == "stdio" and spec["command"] == sys.executable
    assert spec["args"][-1] == str(project) and opts.allowed_tools == ["TodoWrite"]
    hub.prefs.feature = lambda key: False if key == fcl.PREF else None  # the setting off
    opts = options()
    desk.extend(claude, opts)
    assert opts.mcp_servers == {}


async def test_the_session_s_tools_run_as_that_session(hub, project):
    desk = fake_desk(hub)
    task = ClaudeTask(id=7, prompt="", cwd=project)
    tools = {t.name: t for t in desk.tools(task)}
    assert set(tools) == set(clm.NAMES)
    answer = await tools["find_references"].handler({"file": "app.py", "line": 1, "symbol": "send"})
    assert "6 references" in answer["content"][0]["text"] and "is_error" not in answer
    assert desk.manager.running(project)[0].users == {7}
    bad = await tools["hover_info"].handler({"file": "nope.py", "line": 1})
    assert bad["is_error"]
    await desk.manager.close()


async def test_an_edit_s_file_shows_its_live_problems_in_the_pane(hub, project):
    desk = fake_desk(hub)
    seen = seen_by(hub)
    task = ClaudeTask(id=3, prompt="", cwd=project)
    hub.tasks.tasks[task.id] = task
    task.pending_edits["tool-1"] = str(project / "app.py")
    desk.on_task_event(
        "task_log", {"id": 3, "entry": {"role": "tool", "tool": "Edit", "tool_id": "tool-1"}}
    )
    (project / "app.py").write_text(APP + "x = undefined_name\n")
    desk.on_task_event("task_log_update", {"id": 3, "tool_id": "tool-1", "status": "done"})

    def problems():
        found = [d for k, d in seen if k == "lsp_problems" and d["problems"]]
        return found[-1] if found else None

    assert await until(lambda: problems() is not None, tries=2000)
    state = problems()
    assert state["path"] == str(project) and state["errors"] == 1 and state["live"]
    [p] = state["problems"]
    assert (p["file"], p["line"], p["severity"], p["source"]) == ("app.py", 8, "error", "fakepy")
    assert [s["status"] for s in state["servers"]] == ["ready"]
    # A turn's end sends the open files again: a fix made with Bash clears it.
    (project / "app.py").write_text(APP)
    seen.clear()
    desk.on_task_event("task_finished", {"id": 3, "task_kind": "code", "files": []})
    assert await until(
        lambda: any(k == "lsp_problems" and not d["problems"] for k, d in seen), tries=2000
    )
    # The session ends: its server stops.
    [server] = desk.manager.running(project)
    desk.on_task_event("tasks", {"items": [{"id": 3, "kind": "code", "status": "stopped"}]})
    assert await until(lambda: not server.alive, tries=2000)


async def test_live_problems_off_starts_no_server_for_an_edit(hub, project):
    desk = fake_desk(hub)
    hub.prefs.feature = lambda key: False if key == fcl.PREF_LIVE else True
    task = ClaudeTask(id=4, prompt="", cwd=project)
    hub.tasks.tasks[task.id] = task
    task.pending_edits["t"] = str(project / "app.py")
    desk.on_task_event(
        "task_log", {"id": 4, "entry": {"role": "tool", "tool": "Edit", "tool_id": "t"}}
    )
    desk.on_task_event("task_log_update", {"id": 4, "tool_id": "t", "status": "done"})
    await desk.after_edit(4, str(project / "app.py"))
    assert desk.manager.servers == {}


async def test_the_pane_asks_for_the_state_and_sends_the_fix(hub, project, monkeypatch):
    desk = fake_desk(hub)
    task = ClaudeTask(id=5, prompt="", cwd=project)
    hub.tasks.tasks[task.id] = task
    seen = seen_by(hub)
    await desk.cmd_state({"id": 5})
    [(kind, state)] = seen
    assert kind == "lsp_problems" and state["id"] == 5 and state["problems"] == []
    assert [(s["id"], s["status"]) for s in state["servers"]] == [("python", "installed")]
    seen.clear()
    await desk.cmd_fix({"id": 5})
    assert seen == [("cv_error", {"text": "The language servers have no problems to fix."})]
    (project / "app.py").write_text(APP + "undefined_name\n")
    await desk.after_edit(5, "app.py")
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda tid, text: sent.append((tid, text)) or True)
    await desk.cmd_fix({"id": 5})
    assert sent and sent[0][0] == 5 and "app.py:8:1 error [fake-rule] (fakepy)" in sent[0][1]
    assert "<checker-output>" in sent[0][1]
    await desk.manager.close()


def test_a_project_s_languages_are_found_without_reading_its_dependencies(tmp_path):
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "a.ts").write_text("")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.go").write_text("")
    (tmp_path / "lib.py").write_text("")
    assert fcl.project_languages(tmp_path) == ["python", "go"]


async def test_an_empty_answer_says_what_the_server_needs_when_it_says(project):
    spec = fake_spec()
    spec.hint = "Build the project once, then ask again."
    mgr = lsp.Manager(env=env, specs=(spec,))
    try:
        text, error = await call(
            mgr, project, "go_to_definition", file="app.py", line=6, symbol="names"
        )
        assert not error and text.endswith(
            "found no definition for `names`. Build the project once, then ask again."
        )
    finally:
        await mgr.close()
