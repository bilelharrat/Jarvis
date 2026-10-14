"""An Eden Code session asks the owner for a secret (features/code_secrets.py, secret_run.py),
wired into a real hub with a Keychain kept in memory: the masked card's answer goes to the
vault, Claude gets only $SECRET_…, its commands get the value through secret_run (which scrubs
it from their output), a step that would show Claude a file holding it is refused, and
everything the session records is scrubbed. No real Keychain, no model."""

import asyncio
import io
import logging
import os
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


async def test_a_command_naming_the_secret_asks_in_every_mode_and_gets_it_through_a_pipe_once(
    hub, task
):
    await given(hub, task)
    task.mode = "auto"  # Bypass: the policy lets it go without a card, but a secret asks
    cards = []

    async def approve(title, detail, choices, context=None):
        cards.append((title, detail, [c for c, _ in choices]))
        return tasks.ALLOW

    hub.tasks.approve = approve
    options = hub.tasks.options_for(task)
    assert code_secrets.SERVER in options.mcp_servers
    assert code_secrets.ASK_TOOL in options.allowed_tools
    context = ToolPermissionContext(signal=None, suggestions=[])
    command = 'curl -H "Authorization: Bearer $SECRET_STRIPE_KEY" http://localhost:4242/'
    result = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(result, PermissionResultAllow)
    [(title, detail, choices)] = cards
    assert "$SECRET_STRIPE_KEY" in title and VALUE not in title + detail
    assert choices == [tasks.ALLOW, tasks.DENY]
    wrapped = result.updated_input["command"]
    assert VALUE not in wrapped
    argv = shlex.split(wrapped)
    assert argv[:2] == [sys.executable, "-I"] and argv[2].endswith("secret_run.py")
    assert argv[4] == "--" and argv[-1] == command and argv[-2] == "-c"
    # Nothing on the line can fetch a secret: no Keychain service, no account, only a socket
    # made for this run, which is gone once taken, and runs the command only for that very
    # secret_run (this test's process, connecting first, gets nothing run: tests/
    # test_secret_handoff.py has the command itself running).
    assert SERVICE not in wrapped and "code-secret:" not in wrapped
    pipe = argv[3]
    first = secret_run.connect(pipe)
    assert first is not None
    first.sendall(secret_run.request())
    assert first.recv(4096) == b""
    first.close()
    assert secret_run.connect(pipe) is None
    # One that doesn't name it runs as it is, with no card.
    plain = await options.can_use_tool("Bash", {"command": "ls"}, context)
    assert isinstance(plain, PermissionResultAllow) and not plain.updated_input
    assert len(cards) == 1
    # The owner's no on that card is a no, Bypass or not.

    async def deny(*_a, **_k):
        return "deny"

    hub.tasks.approve = deny
    options = hub.tasks.options_for(task)
    refused = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(refused, PermissionResultDeny)
    # The policy's own card counts: asked once there, not twice.
    task.mode = "ask"
    hub.tasks.approve = approve
    options = hub.tasks.options_for(task)
    again = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(again, PermissionResultAllow) and len(cards) == 2
    assert shlex.split(again.updated_input["command"])[-1] == command
    # And the policy's no stays a no.
    task.mode = "plan"
    hub.tasks.approve = deny
    options = hub.tasks.options_for(task)
    assert isinstance(
        await options.can_use_tool("Bash", {"command": command}, context), PermissionResultDeny
    )


async def test_a_secret_commands_output_goes_to_the_owner_and_claude_gets_how_it_went(hub, task):
    """S3-2: scrubbing is a best effort (`fold -w4` walks a value past it), so none of what a
    secret command prints is Claude's: the owner gets it (scrubbed) as a transcript entry no
    model reads, Claude's tool output says where it went and how it ended. S3-1: the card
    says where it runs and with whose PATH."""
    import subprocess

    from jarvis import handoff_check

    if handoff_check._libproc() is None and not os.path.isdir("/proc/self/fd"):
        pytest.skip("no way on this system to see who connected")
    await given(hub, task)
    task.mode = "auto"
    cards = []

    async def approve(title, detail, choices, context=None):
        cards.append(detail)
        return tasks.ALLOW

    hub.tasks.approve = approve
    options = hub.tasks.options_for(task)
    context = ToolPermissionContext(signal=None, suggestions=[])
    command = 'echo "k=$SECRET_STRIPE_KEY"; printf %s "$SECRET_STRIPE_KEY" | fold -w4; exit 4'
    result = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(result, PermissionResultAllow)
    [detail] = cards
    assert "comes to you only" in detail and f"runs in {task.cwd}" in detail
    assert "your own PATH" in detail and "Careful" not in detail
    done = await asyncio.to_thread(
        subprocess.run, shlex.split(result.updated_input["command"]), capture_output=True,
        timeout=30, cwd=task.cwd,
    )  # fmt: skip
    assert done.returncode == 4
    claude_sees = done.stdout + done.stderr
    assert b"k=" not in claude_sees and VALUE[:4].encode() not in claude_sees
    assert b"went to the owner only" in done.stdout and b"status 4" in done.stdout
    assert await until(lambda: any(e["role"] == "secret-output" for e in task.transcript))
    [shown] = [e for e in task.transcript if e["role"] == "secret-output"]
    assert shown["text"].startswith("k=$SECRET_STRIPE_KEY\n") and VALUE not in shown["text"]
    assert shown["status"] == 4 and shown["command"] == command
    # (fold's pieces are the owner's to see: in the owner's transcript, never Claude's)
    assert "pass" in shown["text"]


async def test_the_card_warns_when_the_command_runs_files_the_session_wrote(hub, task):
    await given(hub, task)
    task.mode = "auto"
    task.files_changed = {str(task.cwd / "tools" / "send.py"), str(task.cwd / "notes.md")}
    cards = []

    async def approve(title, detail, choices, context=None):
        cards.append(detail)
        return tasks.ALLOW

    hub.tasks.approve = approve
    options = hub.tasks.options_for(task)
    context = ToolPermissionContext(signal=None, suggestions=[])
    command = 'python3 tools/send.py --key "$SECRET_STRIPE_KEY"'
    assert isinstance(
        await options.can_use_tool("Bash", {"command": command}, context), PermissionResultAllow
    )
    [detail] = cards
    assert "Careful: it runs files this session wrote (tools/send.py)" in detail
    assert "notes.md" not in detail
    assert code_secrets.written_named(task, 'curl -H "x: $SECRET_STRIPE_KEY" example.com') == []
    # Even when the session's own card already let it by (ask mode), the warning gets its card.
    task.mode = "ask"
    options = hub.tasks.options_for(task)
    cards.clear()
    assert isinstance(
        await options.can_use_tool("Bash", {"command": command}, context), PermissionResultAllow
    )
    assert len(cards) == 2 and "Careful" in cards[-1]


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


def test_secret_run_gives_the_command_its_value_and_scrubs_its_output(tmp_path):
    """The backend runs the command with the value in its environment; what it prints goes
    to the owner, scrubbed (S3-2), secret_run prints how it went and exits with the
    command's status."""
    from jarvis.key_proxy import Handoffs

    line = 'echo "out:$SECRET_X"; echo "err:$SECRET_X" >&2; echo "gone:[$SECRET_GONE]"; exit 3'
    offers = Handoffs(folder=tmp_path / "handoff", wait=5)
    owner = []
    sock = offers.offer({"SECRET_X": VALUE}, ["SECRET_GONE"], command=["/bin/sh", "-c", line],
                        on_output=lambda text, status: owner.append((text, status)))  # fmt: skip
    stdout, stderr = io.BytesIO(), io.BytesIO()
    code = secret_run.run([sock, "--", "/bin/sh", "-c", line], stdout=stdout, stderr=stderr)
    assert code == 3
    assert b"out:" not in stdout.getvalue() and b"err:" not in stderr.getvalue()
    assert b"3 lines" in stdout.getvalue() and b"status 3" in stdout.getvalue()
    assert b"no value is saved for $SECRET_GONE" in stderr.getvalue()
    [(text, status)] = owner
    assert status == 3
    assert sorted(text.splitlines()) == ["err:$SECRET_X", "gone:[]", "out:$SECRET_X"]
    assert VALUE.encode() not in stdout.getvalue() + stderr.getvalue()
    assert VALUE not in text
    assert secret_run.run(["p", "--"], stdout=stdout, stderr=stderr) == 2
    # Nothing offered (a socket used already, or none): the command doesn't run at all.
    ran = io.BytesIO()
    assert secret_run.run(["p", "--", "/bin/sh", "-c", "echo ran"], connect_to=lambda _p: None, stdout=ran, stderr=io.BytesIO()) == 2  # fmt: skip
    assert ran.getvalue() == b""


def test_secret_run_reads_no_keychain_and_a_socket_is_used_once_for_real(tmp_path):
    """The program a session's commands go through holds no way to ask for a secret: it
    imports no keyring, takes no service or account, never holds a value, and the socket it
    connects to (made by the backend for one run) runs the command once."""
    source = open(secret_run.__file__, encoding="utf-8").read()
    assert "keyring" not in source and "Keychain entry" not in source
    from jarvis.key_proxy import Handoffs

    offers = Handoffs(folder=tmp_path / "handoff", wait=5)
    line = 'echo "[$SECRET_X]" | base64; echo "$SECRET_X" | rev'
    owner = []
    pipe = offers.offer({"SECRET_X": VALUE}, ["SECRET_GONE"], command=["/bin/sh", "-c", line],
                        on_output=lambda text, status: owner.append(text))  # fmt: skip
    assert oct((tmp_path / "handoff").stat().st_mode & 0o777) == "0o700"
    assert oct(os.stat(os.path.dirname(pipe)).st_mode & 0o777) == "0o700"
    stdout, stderr = io.BytesIO(), io.BytesIO()
    code = secret_run.run([pipe, "--", "/bin/sh", "-c", line], stdout=stdout, stderr=stderr)
    assert code == 0
    [out] = owner
    assert VALUE not in out and VALUE[::-1] not in out
    assert out.count("$SECRET_X") == 2
    # Used once: the same socket again gets nothing, and the command doesn't run.
    again = io.BytesIO()
    assert secret_run.run([pipe, "--", "/bin/sh", "-c", "echo ran"], stdout=again, stderr=io.BytesIO()) == 2  # fmt: skip
    assert again.getvalue() == b""
    # A socket no command connects to goes by itself.
    unread = Handoffs(folder=tmp_path / "late", wait=0.2)
    left = unread.offer({"SECRET_X": VALUE}, command=["/bin/sh", "-c", "true"])
    assert until_gone(left)


def until_gone(path, seconds=3.0):
    import os

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not os.path.exists(path):
            return True
        time.sleep(0.02)
    return False


def test_secret_run_scrubs_the_shapes_a_value_is_easily_turned_into():
    import base64
    from urllib.parse import quote

    secret = "s3cr3t-Value_9/+x"
    shown = [
        base64.b64encode(secret.encode()),
        base64.b64encode(b"admin:" + secret.encode()),  # curl -v -u admin:… prints this
        base64.b64encode(b"ab" + secret.encode() + b"\n"),
        base64.urlsafe_b64encode(secret.encode()).rstrip(b"="),
        secret.encode().hex().encode(),
        secret.encode().hex().upper().encode(),
        quote(secret, safe="").encode(),
        secret[::-1].encode(),
        secret[2:12].encode(),  # a run of 8 or more of its characters
        secret[-9:].encode(),
    ]
    for form in shown:
        out = secret_run.scrub({secret: "$SECRET_V"}, "x " + form.decode() + " y")
        assert "$SECRET_V" in out, form
        assert form.decode() not in out, form
    # Words around it, and runs shorter than 8 of its characters, stay as they are.
    assert secret_run.scrub({secret: "$SECRET_V"}, "the s3cr3t- part") == "the s3cr3t- part"
    # Split between reads, the shapes are caught too.
    scrub = secret_run.Scrubber({secret: "$SECRET_V"})
    coded = base64.b64encode(secret.encode())
    out = scrub.feed(b"a " + coded[:5]) + scrub.feed(coded[5:] + b" b") + scrub.end()
    assert coded not in out and out.startswith(b"a $SECRET_V") and out.endswith(b" b")


def _old_names_for(sec, task):
    """names_for as it was before the folder was looked up once a pass: the reference the
    faster one must agree with."""
    out = {
        name: f"code-secret:{code_secrets.project_scope(task.cwd)}:{name}"
        for name in list(sec.index()["projects"].get(str(task.cwd.resolve()), []))
    }
    scope = sec.sessions.get(task.id)
    for name in sec.session_names.get(task.id, ()):
        out[name] = f"code-secret:{scope}:{name}"
    return out


def _old_values_for(sec, task):
    out = {}
    for name in _old_names_for(sec, task):
        found = sec.value(sec.scope_of(task, name), name)
        if found and len(found) >= code_secrets.VALUE_MIN:
            out[found] = f"${name}"
    return out


def test_live_words_with_no_secret_anywhere_never_look_up_the_folder(hub, task, monkeypatch):
    """The redaction pass runs on every piece of every session's live words: with no secret
    given anywhere it mustn't touch the disk (it resolved the folder each time, most of the
    cost of a streaming session's events)."""
    looked = []
    real = code_secrets._folder
    monkeypatch.setattr(code_secrets, "_folder", lambda cwd: looked.append(cwd) or real(cwd))
    sec = hub.code_secrets
    for _ in range(200):
        assert sec.redact(task, f"plain words {VALUE}") == f"plain words {VALUE}"
    assert sec.names_for(task) == {} and sec.values_for(task) == {}
    assert sec.project_names(task.cwd) == []
    assert looked == []
    hub.tasks._stream(task, "text", "hello")
    hub.tasks._flush_stream(task)
    assert looked == []


async def test_one_pass_looks_up_the_folder_once_and_agrees_with_the_old_lookup(
    hub, task, monkeypatch
):
    sec = hub.code_secrets
    await given(hub, task, name="npm token", scope="project", value=OTHER)
    await given(hub, task, name="aws key", scope="project", value="aws-" + "k" * 12)
    await given(hub, task)  # SECRET_STRIPE_KEY, the session's own
    # The same name kept for the session too: its own wins, in the project's place.
    sec.save(task, "SECRET_AWS_KEY", "own-" + "a" * 12, "session")
    other = ClaudeTask(id=7, prompt="y", cwd=task.cwd)  # same project, none of its own
    elsewhere = ClaudeTask(id=8, prompt="z", cwd=task.cwd.parent)  # another folder
    hub.tasks.tasks[7], hub.tasks.tasks[8] = other, elsewhere
    for t in (task, other, elsewhere):
        assert sec.names_for(t) == _old_names_for(sec, t)
        assert list(sec.names_for(t)) == list(_old_names_for(sec, t))  # (same order)
        assert sec.values_for(t) == _old_values_for(sec, t)
    assert sec.values_for(task) == {
        OTHER: "$SECRET_NPM_TOKEN",
        "own-" + "a" * 12: "$SECRET_AWS_KEY",
        VALUE: "$SECRET_STRIPE_KEY",
    }
    looked = []
    real = code_secrets._folder
    monkeypatch.setattr(code_secrets, "_folder", lambda cwd: looked.append(cwd) or real(cwd))
    text = f"a {OTHER} b {VALUE} c own-{'a' * 12} d aws-{'k' * 12}"
    assert sec.redact(task, text) == (
        f"a $SECRET_NPM_TOKEN b $SECRET_STRIPE_KEY c $SECRET_AWS_KEY d aws-{'k' * 12}"
    )
    assert len(looked) == 1  # (it was six: twice, then twice for each project name)
    assert sec.redact(other, text) == (
        f"a $SECRET_NPM_TOKEN b {VALUE} c own-{'a' * 12} d $SECRET_AWS_KEY"
    )
    assert sec.redact(elsewhere, text) == text


async def test_a_folder_is_checked_for_secrets_with_one_lookup_of_them(hub, task, monkeypatch):
    await given(hub, task)
    sec = hub.code_secrets
    for i in range(40):
        (task.cwd / f"f{i}.txt").write_text(f"nothing here {i}\n")
    (task.cwd / "zz.env").write_text(f"KEY={VALUE}\n")
    calls = []
    real = sec.values_for
    monkeypatch.setattr(sec, "values_for", lambda t: calls.append(t) or real(t))
    assert sec.folder_holds_secret(task, task.cwd) == "$SECRET_STRIPE_KEY"
    assert len(calls) == 1
    assert sec.holds_secret(task, task.cwd / "f1.txt") == ""
    assert sec.holds_secret(task, task.cwd / "zz.env") == "$SECRET_STRIPE_KEY"
    assert sec.holds_secret(task, task.cwd / "missing.txt") == ""


async def test_a_container_session_s_command_never_gets_a_secret(hub, task, monkeypatch):
    """S3-8: the backend's run with the values is on the Mac, so a container session's
    command had them empty (or, with the container's rewrite lost, ran on the Mac itself):
    in a session whose commands go into its copy's container, a command naming a secret is
    refused, by the hook (a deny wins over the container's rewrite) and by the policy."""
    await given(hub, task)
    task.mode = "auto"

    async def approve(*_a, **_k):
        return tasks.ALLOW

    hub.tasks.approve = approve
    monkeypatch.setattr(
        hub.code_setup, "container_of", lambda t: {"name": "edc-shop"} if t is task else None
    )
    hook = hub.code_secrets.hook(task).hooks[0]
    command = 'curl -H "Authorization: Bearer $SECRET_STRIPE_KEY" https://api.example.com/'
    said = await hook({"tool_name": "Bash", "tool_input": {"command": command}}, "t", None)
    assert said["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "container" in said["hookSpecificOutput"]["permissionDecisionReason"]
    options = hub.tasks.options_for(task)
    context = ToolPermissionContext(signal=None, suggestions=[])
    refused = await options.can_use_tool("Bash", {"command": command}, context)
    assert isinstance(refused, PermissionResultDeny) and "container" in refused.message
    # One that names no secret goes on as before (into the container, by code_setup's hook).
    plain = await options.can_use_tool("Bash", {"command": "ls"}, context)
    assert isinstance(plain, PermissionResultAllow)
