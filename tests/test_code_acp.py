"""Other agents over ACP (acp, features.code_acp), with a fake agent script (never a real one:
tests/acp_fake_agent.py): JSON-RPC both ways, a turn's words, thinking, steps and plan in an
ordinary Eden Code session, the agent's permission requests answered by Jarvis's policy
(a card, Bypass, the owner's rules), Stop, an agent that stops or wants a sign-in, a resumed
session, and the agents kept."""

import json
import os
import shlex
import sys
from pathlib import Path

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import acp
from jarvis.acp import AcpClient, AcpConnection, AcpError, tool_of
from jarvis.features.code_acp import AgentBook

FAKE = [sys.executable, str(Path(__file__).parent / "acp_fake_agent.py")]
LONG = 4000  # tries of until(): a fresh process on a busy Mac takes a moment


def test_an_agent_s_tool_calls_are_steps_jarvis_s_policy_knows():
    assert tool_of(
        {"kind": "execute", "title": "ls", "rawInput": {"command": ["git", "push", "-f"]}}
    ) == (
        "Bash",
        {"command": "git push -f", "description": "ls"},
    )
    assert tool_of({"kind": "execute", "title": "npm   test"})[1]["command"] == "npm test"
    assert tool_of({"kind": "edit", "locations": [{"path": "/p/a.py", "line": 3}]}) == (
        "Edit",
        {"file_path": "/p/a.py"},
    )
    assert tool_of({"kind": "read", "rawInput": {"path": "b.py"}}) == (
        "Read",
        {"file_path": "b.py"},
    )
    assert (
        tool_of({"kind": "fetch", "rawInput": {"url": "https://x.com"}})[1]["url"]
        == "https://x.com"
    )
    assert tool_of({"kind": "search", "title": "TODO", "locations": [{"path": "/p"}]}) == (
        "Grep",
        {"pattern": "TODO", "path": "/p"},
    )
    name, shown = tool_of({"kind": "delete", "locations": [{"path": "/p/x"}]})
    assert name == "Delete" and shown == {"file_path": "/p/x"}
    assert tool_of({"title": "do a thing", "rawInput": {"a": 1}}) == (
        "AgentTool",
        {"title": "do a thing", "input": '{"a": 1}'},
    )


async def test_the_agent_s_permission_requests_fail_closed():
    # No path isn't the project root, every location is weighed, and allow_always (the agent
    # never asking again, past the policy) is never picked.
    from types import SimpleNamespace

    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    weighed = []

    async def policy(name, tool_input, _context):
        weighed.append((name, tool_input))
        inside = str(tool_input.get("file_path") or tool_input.get("path") or "").startswith("/p/")
        if name in ("Read", "Edit", "Grep") and inside:
            return PermissionResultAllow()
        return PermissionResultDeny(message="no")

    client = AcpClient(FAKE, "Fake", SimpleNamespace(can_use_tool=policy))
    options = [
        {"optionId": "always", "kind": "allow_always"},
        {"optionId": "yes", "kind": "allow_once"},
        {"optionId": "no", "kind": "reject_once"},
    ]

    async def ask(call, offered=options):
        out = await client._permission({"toolCall": call, "options": offered})
        return out["outcome"].get("optionId", out["outcome"]["outcome"])

    assert await ask({"kind": "edit", "locations": [{"path": "/p/a.py"}]}) == "yes"
    assert await ask({"kind": "read", "title": "read something"}) == "no"
    assert weighed[-1][0] == "AgentTool" and "didn't say which file" in weighed[-1][1]["title"]
    weighed.clear()
    two = {"kind": "edit", "locations": [{"path": "/p/a.py"}, {"path": "/etc/hosts"}]}
    assert await ask(two) == "no"
    assert [w[1]["file_path"] for w in weighed] == ["/p/a.py", "/etc/hosts"]
    only_always = [o for o in options if o["kind"] != "allow_once"]
    assert await ask({"kind": "read", "locations": [{"path": "/p/a.py"}]}, only_always) == (
        "cancelled"
    )


def test_the_agents_are_kept_and_read_defensively(tmp_path):
    path = tmp_path / "code_acp.json"
    book = AgentBook(path)
    one = book.add("Codex", "codex-acp --flag 'with space'")
    two = book.add("Codex", "codex-acp")
    assert (one["id"], two["id"]) == ("codex", "codex-2")
    assert one["command"] == ["codex-acp", "--flag", "with space"]
    for name, command, why in [("", "x", "name"), ("X", "", "command"), ("X", "a 'open", "quote")]:
        with pytest.raises(ValueError, match=why):
            book.add(name, command)
    assert list(AgentBook(path).agents) == ["codex", "codex-2"]
    assert book.remove("codex-2") and not book.remove("codex-2")
    path.write_text(json.dumps({"agents": [{"id": "Bad Id", "name": "x", "command": ["x"]},
                                           {"id": "ok", "name": "OK", "command": ["run", 3]},
                                           {"id": "fine", "name": "Fine", "command": ["fine", "acp"]}, "junk"]}))  # fmt: skip
    assert list(AgentBook(path).agents) == ["fine"]


async def test_json_rpc_goes_both_ways_and_an_agent_that_stops_says_why(tmp_path):
    heard, asked = [], []

    async def answer(method, params):
        asked.append(method)
        raise AcpError("not here", -32601)

    conn = AcpConnection(FAKE, tmp_path, lambda m, p: heard.append((m, p)), answer)
    await conn.start()
    hello = await conn.request("initialize", {"protocolVersion": 1}, 30)
    assert hello["protocolVersion"] == 1 and hello["agentCapabilities"]["loadSession"]
    with pytest.raises(AcpError) as missing:
        await conn.request("nothing/here", {}, 30)
    assert missing.value.code == -32601
    assert (await conn.request("session/new", {"cwd": str(tmp_path), "mcpServers": []}, 30)) == {
        "sessionId": "sess-1"
    }
    done = await conn.request(
        "session/prompt",
        {"sessionId": "sess-1", "prompt": [{"type": "text", "text": "noisy hello"}]},
        30,
    )
    assert done == {"stopReason": "end_turn"}  # (a line that isn't JSON is passed over)
    assert [p["update"]["sessionUpdate"] for m, p in heard] == [
        "agent_thought_chunk",
        "agent_message_chunk",
        "agent_message_chunk",
    ]
    with pytest.raises(AcpError, match="The agent stopped: fake agent: something broke"):
        await conn.request(
            "session/prompt",
            {"sessionId": "sess-1", "prompt": [{"type": "text", "text": "crash"}]},
            30,
        )
    assert conn.closed
    await conn.close()


# ── in a session ──


def _hub(settings, quiet_speaker, isolated, tmp_path, log="agent.log", **env):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.code_acp.env = {"FAKE_ACP_LOG": str(tmp_path / log), **env}
    hub.code_acp.book.add("Fake", shlex.join(FAKE))
    return hub


async def _start(hub, mode="ask"):
    seen = events_of(hub)
    await hub._handle({"type": "acp_start", "agent": "fake", "directory": "proj", "mode": mode})
    [started] = [e for e in seen() if e["type"] == "acp_started"]
    return hub.tasks.tasks[started["id"]]


def _said(task, role="assistant"):
    return [e["text"] for e in task.transcript if e["role"] == role]


async def _turn(hub, task, text):
    turns = len([e for e in task.transcript if e["role"] == "turn"])
    hub.tasks.send(task.id, text)
    assert await until(
        lambda: len([e for e in task.transcript if e["role"] == "turn"]) > turns, LONG
    )


async def test_a_session_with_another_agent_is_an_ordinary_jarvis_code_session(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    assert task.model_label == "Fake" and task.model == "acp:fake"
    await _turn(hub, task, "say hello and make a plan")
    assert _said(task) == ["Hello there."] and _said(task, "thinking") == ["Thinking…"]
    assert [t["content"] for t in task.todos] == ["Read the code", "Fix the bug", "Run the tests"]
    assert _said(task, "user") == ["say hello and make a plan"]
    assert Stream.instances == []  # never Claude Code
    assert task.status == "waiting" and not task.busy
    await end_all(hub)


async def test_its_steps_are_answered_by_jarvis_s_policy(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    hub.tasks.send(task.id, "run the install")
    assert await until(lambda: hub.approvals, LONG)
    [card] = hub.approvals.values()
    assert card["detail"] == "$ npm install left-pad" and card["task_id"] == task.id
    hub.resolve(card["id"], "allow")
    assert await until(lambda: "Installed." in _said(task), LONG)
    [step] = [e for e in task.transcript if e["role"] == "tool"]
    assert step["tool"] == "Bash" and step.get("status") == "done"
    hub.tasks.send(task.id, "run it again")
    assert await until(lambda: hub.approvals, LONG)
    hub.resolve(next(iter(hub.approvals)), "deny")
    assert await until(lambda: "Not allowed (selected)." in _said(task), LONG)
    hub.tasks.set_mode(task.id, "auto")  # Bypass: it runs, unasked
    await _turn(hub, task, "run once more")
    assert _said(task)[-1] == "Installed." and task.audit[-1]["decision"] == "bypass"
    hub.code_rules.book.add(
        str(task.cwd.resolve()), "deny", "Bash(npm install:*)"
    )  # the owner's rule wins
    await _turn(hub, task, "run the last time")
    assert (
        _said(task)[-1] == "Not allowed (selected)."
        and task.audit[-1]["why"] == "your rule: Bash(npm install:*)"
    )
    await end_all(hub)


async def test_stop_cancels_the_agent_s_turn(settings, quiet_speaker, isolated, tmp_path):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    hub.tasks.send(task.id, "wait for it")
    assert await until(
        lambda: (
            task.busy
            and any(e["text"] == "Working" for e in task.transcript)
            or task.busy
            and task.client
        ),
        LONG,
    )
    assert await until(lambda: "session/prompt" in (tmp_path / "agent.log").read_text(), LONG)
    assert await hub.tasks.interrupt(task.id)
    assert await until(lambda: not task.busy, LONG)
    sent = [json.loads(line) for line in (tmp_path / "agent.log").read_text().splitlines()]
    assert "session/cancel" in [m.get("method") for m in sent]
    await _turn(hub, task, "hello again")  # the session goes on
    assert _said(task)[-1] == "Hello there."
    await end_all(hub)


async def test_an_agent_that_stops_or_wants_a_sign_in_says_so(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    hub.tasks.send(task.id, "crash now")
    assert await until(
        lambda: task.status in ("closed", "failed", "stopped") and not task.busy, LONG
    )
    assert any(
        "The agent stopped: fake agent: something broke" in e["text"] for e in task.transcript
    )
    locked = _hub(settings, quiet_speaker, isolated, tmp_path, "locked.log", FAKE_ACP_AUTH="1")
    task = await _start(locked)
    locked.tasks.send(task.id, "hello")
    assert await until(lambda: task.status == "failed", LONG)
    assert (
        "Fake needs you to sign in: run it once in Terminal, then try again."
        in task.transcript[-1]["text"]
    )
    await end_all(hub)
    await end_all(locked)


async def test_a_reopened_session_takes_up_the_agent_s_own_session(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    await _turn(hub, task, "hello")
    assert task.session_id == "sess-1"
    (tmp_path / "extra").mkdir()
    assert hub.tasks.add_dir(task.id, str(tmp_path / "extra")) == ""  # (a new connection for it)
    await _turn(hub, task, "hello once more")
    sent = [json.loads(line) for line in (tmp_path / "agent.log").read_text().splitlines()]
    loads = [m for m in sent if m.get("method") == "session/load"]
    assert loads and loads[0]["params"]["sessionId"] == "sess-1"
    assert "an old message" not in [e["text"] for e in task.transcript]  # (its replayed history)
    await end_all(hub)


async def test_the_pane_s_commands_add_start_and_remove_agents(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    last = lambda: [e for e in seen() if e["type"] == "acp_state"][-1]  # noqa: E731
    await hub._handle({"type": "acp_add", "name": "", "command": "x"})
    assert "name" in last()["error"]
    await hub._handle({"type": "acp_add", "name": "Gemini", "command": "gemini --experimental-acp"})
    assert last()["agents"] == [
        {"id": "gemini", "name": "Gemini", "command": "gemini --experimental-acp"}
    ]
    await hub._handle({"type": "acp_start", "agent": "nobody", "directory": "proj"})
    assert "isn't set up" in last()["error"]
    await hub._handle({"type": "acp_remove", "agent": "gemini"})
    assert last()["agents"] == []
    assert json.loads(hub.feature_path("code_acp.json").read_text()) == {"agents": []}


async def test_claude_s_spending_limits_and_sandbox_leave_another_agent_alone(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    hub.set_feature_prefs({"code_budget_day": 0.01, "code_sandbox_bypass": True})
    hub.code_usage.usage.add("/somewhere", 5.0)  # the day's Claude limit is spent
    task = await _start(hub, mode="auto")
    await _turn(hub, task, "hello")  # never held: it spends nothing on Claude
    assert not task.gated and _said(task) == ["Hello there."]
    assert not hub.code_sandbox.wanted(task)  # Claude Code's sandbox can't reach it
    assert hub.tasks.rule_check(task, "Bash", {"command": "npm install"}) is None
    await end_all(hub)


async def test_lines_no_client_can_use_are_passed_over_and_the_turn_still_ends(
    tmp_path, monkeypatch
):
    """A misbehaving agent's garbled output (a response whose id is a list, JSON nested too
    deep to read, a line past the limit) is skipped like a log line: the session goes on."""
    monkeypatch.setattr(acp, "LINE_LIMIT", 64 * 1024)
    heard = []

    async def answer(method, params):
        raise AcpError("not here", -32601)

    env = {**os.environ, "FAKE_ACP_LONG": str(200 * 1024)}
    conn = AcpConnection(FAKE, tmp_path, lambda m, p: heard.append(m), answer, env=env)
    await conn.start()
    await conn.request("initialize", {"protocolVersion": 1}, 30)
    await conn.request("session/new", {"cwd": str(tmp_path), "mcpServers": []}, 30)
    done = await conn.request(
        "session/prompt",
        {"sessionId": "sess-1", "prompt": [{"type": "text", "text": "garbled hello"}]},
        30,
    )
    assert done == {"stopReason": "end_turn"} and not conn.closed
    assert heard.count("session/update") == 3  # its words all came through
    await conn.close()


# ── what Eden gives an agent's session: Rewind, usage, receipts ──


def _git_proj(tmp_path):
    import subprocess

    proj = tmp_path / "proj"
    proj.mkdir(exist_ok=True)
    run = lambda *a: subprocess.run(  # noqa: E731
        ["git", "-c", "user.name=T", "-c", "user.email=t@t", *a], cwd=proj, check=True,
        capture_output=True,
    )  # fmt: skip
    run("init", "-q")
    (proj / "a.txt").write_text("one\n")
    (proj / "gone.txt").write_text("keep me\n")
    run("add", "-A")
    run("commit", "-qm", "first")
    return proj


def _receipts(task):
    return [e["receipt"] for e in task.transcript if e.get("receipt")]


async def test_rewind_and_undo_put_an_agent_s_files_back(
    settings, quiet_speaker, isolated, tmp_path
):
    proj = _git_proj(tmp_path)
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub, mode="auto")
    await _turn(hub, task, "hello")  # a turn that changed nothing
    await _turn(hub, task, "write the files")  # changed with no step said (a shell's)
    assert (proj / "new.txt").exists() and not (proj / "gone.txt").exists()
    changed = {str(proj.resolve() / f) for f in ("a.txt", "new.txt", "gone.txt")}
    assert {str(Path(p).resolve()) for p in task.files_changed} == changed
    [point] = [c for c in task.checkpoints if task.checkpoint_files.get(c)]
    (proj / "mine.txt").write_text("the owner's own\n")
    assert await hub.tasks.rewind_to(task.id, point) == (
        "Rewound: the files are back as they were before that message."
    )
    assert (proj / "a.txt").read_text() == "one\n" and (
        proj / "gone.txt"
    ).read_text() == "keep me\n"
    assert not (proj / "new.txt").exists() and (proj / "mine.txt").exists()
    assert not task.files_changed
    await _turn(hub, task, "write again")
    assert "a line from the agent" in (proj / "a.txt").read_text()
    sent = [json.loads(line) for line in (tmp_path / "agent.log").read_text().splitlines()]
    [told] = [m for m in sent if m.get("method") == "session/prompt"][-1]["params"]["prompt"]
    assert told["text"].startswith("(Eden Code: the owner rewound") and told["text"].endswith(
        "write again"
    )
    assert [e["text"] for e in task.transcript if e["role"] == "user"][-1] == "write again"
    assert (
        await hub.tasks.undo(task.id)
        == "Undone: the files are back as they were before that change."
    )
    assert (proj / "a.txt").read_text() == "one\n" and not (proj / "new.txt").exists()
    refs = subprocess_out(proj, "for-each-ref", "refs/eden/acp/")
    assert "/before" in refs  # (the first turns' snapshots stay; the undone ones went)
    assert subprocess_out(proj, "stash", "list") == ""
    await end_all(hub)


def subprocess_out(where, *args):
    import subprocess

    return subprocess.run(["git", *args], cwd=where, capture_output=True, text=True).stdout


async def test_an_agent_s_session_outside_git_says_why_it_can_t_rewind(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub, mode="auto")
    await _turn(hub, task, "hello")
    reply = await hub.tasks.rewind_to(task.id, task.checkpoints[-1])
    assert reply.startswith("Couldn't rewind: there's no snapshot from before that message")
    await end_all(hub)


async def test_an_agent_s_usage_is_counted_apart_from_claude_s_and_on_its_receipt(
    settings, quiet_speaker, isolated, tmp_path
):
    _git_proj(tmp_path)
    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    claude_before = json.dumps(hub.usage.summary(), sort_keys=True)
    task = await _start(hub, mode="auto")
    await _turn(hub, task, "write with usage")
    [turn] = [e for e in task.transcript if e["role"] == "turn"]
    assert turn["tokens"] == 1000 + 200 + 300 and turn["cost"] == 0  # (never Claude's cost)
    assert await until(lambda: _receipts(task), LONG)
    [receipt] = _receipts(task)
    assert receipt["usage"] == {"name": "Fake", "tokens": 1200, "input": 1000, "output": 200,
                                "estimated": False, "cost": 0.25}  # fmt: skip
    assert receipt["file_count"] == 3
    proof = [e["text"] for e in task.transcript if e.get("receipt")][0]
    assert "Fake used 1.2k tokens ($0.25)" in proof
    await _turn(hub, task, "usage again, and write")  # the session's cost so far: $0.50
    await _turn(hub, task, "hello")  # nothing said: an estimate
    agents = hub.code_usage.public()["agents"]
    mine = agents["sessions"][str(task.id)]
    assert mine["turns"] == 3 and mine["cost"] == 0.5 and mine["cost_said"]
    assert 0 < mine["estimated"] < mine["tokens"]
    [today] = agents["today"]
    assert today["id"] == "fake" and today["name"] == "Fake" and today["cost"] == 0.5
    assert hub.code_acp.usage.last[task.id]["estimated"] is True
    assert json.dumps(hub.usage.summary(), sort_keys=True) == claude_before  # Claude's untouched
    assert not hub.code_usage.usage.today()  # ... and its meter too
    kept = json.loads(hub.feature_path("code_acp_usage.json").read_text())
    assert kept["days"][hub.code_acp.usage.today()]["fake"]["turns"] == 3
    await end_all(hub)


def test_an_agent_s_reported_and_estimated_usage():
    client = AcpClient(["x"], "Fake", None)
    client.chars_in, client.chars_out = 41, 8
    assert client.turn_usage() == {"input": 11, "output": 2, "cached": 0, "tokens": 13,
                                   "estimated": True, "cost_total": None, "context": None}  # fmt: skip
    client._take_usage({"input_tokens": 5, "output_tokens": 7, "junk": "x", "totalTokens": -1})
    client._usage_update({"used": 10, "size": 100, "cost": {"amount": 0.5, "currency": "usd"}})
    client._usage_update({"cost": {"amount": 9, "currency": "EUR"}})  # (dollars only)
    got = client.turn_usage()
    assert (got["input"], got["output"], got["tokens"], got["estimated"]) == (5, 7, 12, False)
    assert got["cost_total"] == 0.5 and got["context"] == [10, 100]
