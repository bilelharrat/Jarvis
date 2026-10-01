"""A Jarvis Code session asks the owner for a secret (features/code_secrets.py, secret_run.py),
wired into a real hub with a Keychain kept in memory: the masked card's answer goes to the
vault, Claude gets only $SECRET_…, its commands get the value through secret_run (which scrubs
it from their output), a step that would show Claude a file holding it is refused, and
everything the session records is scrubbed. No real Keychain, no model."""

import asyncio
import io
import logging
import shlex
import sys
import time

import pytest
from claude_agent_sdk import (
    PermissionResultAllow,
    PermissionResultDeny,
    ToolPermissionContext,
    ToolResultBlock,
)
from conftest import FakeClient

from jarvis import secret_run, tasks
from jarvis.connectors import SERVICE
from jarvis.features import code_secrets
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

# Made up, in no real key's format.
VALUE = "-".join(["pass", "word", "4242", "xyz"])
OTHER = "".join(["hunter", "-", "two", "-", "77"])


@pytest.fixture
async def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    yield hub


@pytest.fixture
def task(hub, settings):
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    task = ClaudeTask(id=6, prompt="x", cwd=folder.resolve())
    hub.tasks.tasks[6] = task
    return task


def tools_of(hub, task):
    return {t.name: t.handler for t in hub.code_secrets.tools(task)}


def events(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev["type"] == kind:
            out.append(ev)
    return out


async def until(condition, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.02)
    return False


async def given(hub, task, name="stripe key", scope="session", value=VALUE):
    """Claude asks, the owner answers on the card: the tool's answer."""
    ask = asyncio.ensure_future(
        tools_of(hub, task)["ask_secret"]({"name": name, "why": "To test payments."})
    )
    assert await until(
        lambda: any(e["role"] == "secret" and e["state"] == "waiting" for e in task.transcript)
    )
    card = [e for e in task.transcript if e["role"] == "secret"][-1]
    await hub._handle(
        {"type": "sec_answer", "ask": card["ask"], "value": value + "\n", "scope": scope}
    )
    return await asyncio.wait_for(ask, 5), card


def text_of(result):
    return result["content"][0]["text"]


def test_a_secrets_name_is_a_placeholder_claude_can_use():
    assert code_secrets.clean_name("stripe key") == "SECRET_STRIPE_KEY"
    assert code_secrets.clean_name("$SECRET_STRIPE_KEY") == "SECRET_STRIPE_KEY"
    assert code_secrets.clean_name("npm-token") == "SECRET_NPM_TOKEN"
    assert code_secrets.clean_name("!!!") == ""
    assert code_secrets.named_in('curl -H "x: ${SECRET_A}" $SECRET_B_2 $HOME') == {
        "SECRET_A",
        "SECRET_B_2",
    }


async def test_the_owner_gives_a_secret_and_claude_gets_only_its_placeholder(hub, task, caplog):
    caplog.set_level(logging.DEBUG)
    q = hub.subscribe()
    result, card = await given(hub, task)
    said = text_of(result)
    assert "$SECRET_STRIPE_KEY" in said and VALUE not in said
    assert card["name"] == "SECRET_STRIPE_KEY" and card["why"] == "To test payments."
    assert card["state"] == "given" and card["scope"] == "session"
    [state] = events(q, "sec_state")
    assert state == {
        "type": "sec_state",
        "id": 6,
        "ask": card["ask"],
        "state": "given",
        "scope": "session",
    }
    sec = hub.code_secrets
    scope = sec.sessions[6]
    assert sec.vault.get(f"code-secret:{scope}", "SECRET_STRIPE_KEY") == VALUE  # newline gone
    assert sec.names_for(task) == {"SECRET_STRIPE_KEY": f"code-secret:{scope}:SECRET_STRIPE_KEY"}
    # Nowhere else: not in an event, not in the index file, not in the log.
    assert VALUE not in caplog.text
    assert VALUE not in sec.path.read_text()
    # Asked again: already there.
    again = await tools_of(hub, task)["ask_secret"]({"name": "stripe key", "why": ""})
    assert "already set" in text_of(again)
    listing = await tools_of(hub, task)["secrets"]({})
    assert text_of(listing) == "Secrets you can use in commands: $SECRET_STRIPE_KEY"


async def test_declined_too_short_and_stale_answers(hub, task):
    q = hub.subscribe()
    ask = asyncio.ensure_future(tools_of(hub, task)["ask_secret"]({"name": "pw", "why": ""}))
    assert await until(lambda: any(e["role"] == "secret" for e in task.transcript))
    card = task.transcript[-1]
    await hub._handle({"type": "sec_answer", "ask": card["ask"], "value": "abc"})
    assert "too short" in events(q, "sec_error")[0]["text"]
    assert not ask.done()
    await hub._handle({"type": "sec_answer", "ask": card["ask"], "decline": True})
    assert "declined" in text_of(await asyncio.wait_for(ask, 5))
    assert card["state"] == "declined"
    await hub._handle({"type": "sec_answer", "ask": card["ask"], "value": VALUE})
    assert "isn't waiting" in events(q, "sec_error")[0]["text"]
    assert hub.code_secrets.names_for(task) == {}


async def test_a_command_naming_the_secret_runs_through_secret_run_after_the_policy(hub, task):
    await given(hub, task)
    task.mode = "auto"  # Bypass: the policy lets it go without a card
    options = hub.tasks.options_for(task)
    assert code_secrets.SERVER in options.mcp_servers
    assert code_secrets.ASK_TOOL in options.allowed_tools
    context = ToolPermissionContext(signal=None, suggestions=[])
    command = 'curl -H "Authorization: Bearer $SECRET_STRIPE_KEY" http://localhost:4242/'
    result = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(result, PermissionResultAllow)
    wrapped = result.updated_input["command"]
    assert VALUE not in wrapped
    argv = shlex.split(wrapped)
    assert argv[:3] == [sys.executable, "-I", secret_run.__file__] or argv[2].endswith(
        "secret_run.py"
    )
    assert argv[3] == SERVICE and argv[-1] == command and argv[-2] == "-c"
    assert (
        argv[4] == f"SECRET_STRIPE_KEY=code-secret:{hub.code_secrets.sessions[6]}:SECRET_STRIPE_KEY"
    )
    # One that doesn't name it runs as it is.
    plain = await options.can_use_tool("Bash", {"command": "ls"}, context)
    assert isinstance(plain, PermissionResultAllow) and not plain.updated_input
    # The policy's no stays a no.
    task.mode = "plan"

    async def deny(*_a, **_k):
        return "deny"

    hub.tasks.approve = deny
    options = hub.tasks.options_for(task)
    refused = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(refused, PermissionResultDeny)


async def test_the_hook_sends_such_commands_to_the_policy_and_keeps_files_with_secrets_away(
    hub, task
):
    await given(hub, task)
    hook = hub.code_secrets.hook(task).hooks[0]
    asks = await hook(
        {"tool_name": "Bash", "tool_input": {"command": "echo $SECRET_STRIPE_KEY"}}, "t", None
    )
    assert asks["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert (
        await hook(
            {"tool_name": "Bash", "tool_input": {"command": "echo $SECRET_OTHER"}}, "t", None
        )
        == {}
    )
    (task.cwd / ".env").write_text(f"STRIPE={VALUE}\n")
    (task.cwd / "app.py").write_text("print('hi')\n")
    denied = await hook({"tool_name": "Read", "tool_input": {"file_path": ".env"}}, "t", None)
    out = denied["hookSpecificOutput"]
    assert (
        out["permissionDecision"] == "deny"
        and "$SECRET_STRIPE_KEY" in out["permissionDecisionReason"]
    )
    assert VALUE not in out["permissionDecisionReason"]
    assert (
        await hook(
            {"tool_name": "Read", "tool_input": {"file_path": str(task.cwd / "app.py")}}, "t", None
        )
        == {}
    )
    edit = await hook(
        {"tool_name": "Edit", "tool_input": {"file_path": str(task.cwd / ".env")}}, "t", None
    )
    assert edit["hookSpecificOutput"]["permissionDecision"] == "deny"
    grep = await hook(
        {"tool_name": "Grep", "tool_input": {"pattern": "STRIPE", "output_mode": "content"}},
        "t",
        None,
    )
    assert grep["hookSpecificOutput"]["permissionDecision"] == "deny"
    names_only = {"pattern": "STRIPE", "output_mode": "files_with_matches"}
    assert await hook({"tool_name": "Grep", "tool_input": names_only}, "t", None) == {}


async def test_everything_the_session_records_is_scrubbed(hub, task, tmp_path, monkeypatch):
    await given(hub, task)
    q = hub.subscribe()
    hub.tasks._log(task, "assistant", f"The key is {VALUE}.", detail=f"x {VALUE}")
    entry = task.transcript[-1]
    assert (
        entry["text"] == "The key is $SECRET_STRIPE_KEY."
        and entry["detail"] == "x $SECRET_STRIPE_KEY"
    )
    hub.tasks.add_entry(task.id, "verify", "Checks", findings=[{"text": f"Error: bad key {VALUE}"}])
    assert task.transcript[-1]["findings"] == [{"text": "Error: bad key $SECRET_STRIPE_KEY"}]
    hub.tasks._log(task, "tool", "Run a command", tool="Bash", tool_id="t9", status="running")
    task.tool_ids["t9"] = None
    hub.tasks._tool_result(
        task, ToolResultBlock(tool_use_id="t9", content=f"token={VALUE}", is_error=False)
    )
    assert task.transcript[-1]["output"] == "token=$SECRET_STRIPE_KEY"
    update = events(q, "task_log_update")[-1]
    assert update["output"] == "token=$SECRET_STRIPE_KEY"
    hub.tasks._stream(task, "text", f"says {VALUE}")
    hub.tasks._flush_stream(task)
    assert VALUE not in str(events(q, "task_stream"))
    monkeypatch.setattr(tasks, "EXPORT_DIR", tmp_path / "exports")
    task.transcript.append({"n": 99, "role": "assistant", "text": f"kept before: {VALUE}"})
    exported = hub.tasks.export(task.id).read_text()
    assert VALUE not in exported and "$SECRET_STRIPE_KEY" in exported


async def test_a_project_secret_is_kept_for_the_project_and_removed_by_name(hub, task, settings):
    await given(hub, task, name="npm token", scope="project", value=OTHER)
    sec = hub.code_secrets
    other = ClaudeTask(id=7, prompt="y", cwd=task.cwd)
    hub.tasks.tasks[7] = other
    assert "SECRET_NPM_TOKEN" in sec.names_for(other)  # every session in the project
    assert sec.redact(other, f"x {OTHER}") == "x $SECRET_NPM_TOKEN"
    q = hub.subscribe()
    await hub._handle({"type": "sec_list", "id": 7})
    [listing] = events(q, "sec_list")
    assert listing["projects"] == ["SECRET_NPM_TOKEN"] and listing["session"] == []
    assert OTHER not in str(listing)
    await hub._handle(
        {"type": "sec_remove", "id": 7, "name": "SECRET_NPM_TOKEN", "scope": "project"}
    )
    assert sec.names_for(other) == {}
    assert (
        sec.vault.get(f"code-secret:{code_secrets.project_scope(task.cwd)}", "SECRET_NPM_TOKEN")
        is None
    )


async def test_a_sessions_own_secrets_go_when_it_ends_and_leftovers_are_swept(hub, task):
    await given(hub, task)
    sec = hub.code_secrets
    scope = sec.sessions[6]
    hub.tasks.emit("tasks", items=[{"id": 6, "kind": "code", "status": "stopped"}])
    assert sec.vault.get(f"code-secret:{scope}", "SECRET_STRIPE_KEY") is None
    assert sec.names_for(task) == {} and scope not in sec.index()["sessions"]
    # A run that quit first left one: the next start's sweep takes it out.
    sec.vault.set("code-secret:s-left", "SECRET_X", VALUE)
    sec.index()["sessions"]["s-left"] = ["SECRET_X"]
    assert sec.sweep() == 1
    assert sec.vault.get("code-secret:s-left", "SECRET_X") is None and sec.index()["sessions"] == {}


def test_secret_run_scrubs_values_split_between_reads():
    scrub = secret_run.Scrubber({VALUE: "$SECRET_X"})
    out = b"".join(
        scrub.feed(part) for part in [b"a=pass-wo", b"rd-42", b"42-xyz;b=", b"pass-word-4242-xyz"]
    )
    out += scrub.end()
    assert out == b"a=$SECRET_X;b=$SECRET_X"
    assert secret_run.Scrubber({}).feed(b"plain") == b"plain"


def test_secret_run_gives_the_command_its_value_and_scrubs_its_output():
    stdout, stderr = io.BytesIO(), io.BytesIO()
    seen = []

    def read(service, account):
        seen.append((service, account))
        return VALUE if account == "acct-1" else None

    code = secret_run.run(
        [
            "svc",
            "SECRET_X=acct-1",
            "SECRET_GONE=acct-2",
            "--",
            "/bin/sh",
            "-c",
            'echo "out:$SECRET_X"; echo "err:$SECRET_X" >&2; echo "gone:[$SECRET_GONE]"; exit 3',
        ],
        read=read,
        stdout=stdout,
        stderr=stderr,
    )
    assert code == 3
    assert seen == [("svc", "acct-1"), ("svc", "acct-2")]
    assert stdout.getvalue() == b"out:$SECRET_X\ngone:[]\n"
    assert (
        b"err:$SECRET_X" in stderr.getvalue()
        and b"no value is saved for $SECRET_GONE" in stderr.getvalue()
    )
    assert VALUE.encode() not in stdout.getvalue() + stderr.getvalue()
    assert secret_run.run(["svc", "--"], read=read, stdout=stdout, stderr=stderr) == 2
