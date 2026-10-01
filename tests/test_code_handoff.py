"""Hand-off (handoff.py, features/code_handoff.py): a Jarvis Code session continued on another
machine over SSH. No real SSH: a fake ssh runs each command with sh in a folder standing in
for the remote's home, and a fake claude there speaks stream-json (asking for permission
over stdio when its --help says it can). Real git, in temp repositories."""

import asyncio
import json
import os
import signal
import stat
import sys
import textwrap
from dataclasses import replace
from pathlib import Path

import pytest
from test_code_changes import git, make_repo, numbered

from jarvis import handoff
from jarvis.handoff import Handoff, Machine

FAKE_SSH = """#!{python}
import os, sys
args = sys.argv[1:]
i = 0
while i < len(args) and args[i].startswith("-"):
    i += 2 if args[i] == "-o" else 1
alias, command = args[i], " ".join(args[i + 1:])
home = os.path.join({root!r}, alias)
if not os.path.isdir(home):
    sys.stderr.write("ssh: Could not resolve hostname %s: nodename nor servname provided\\n" % alias)
    sys.exit(255)
if os.path.exists(os.path.join(home, ".down")):
    sys.stderr.write("ssh: connect to host %s port 22: Operation timed out\\n" % alias)
    sys.exit(255)
os.chdir(home)
env = {{"HOME": home, "PATH": os.path.join(home, "bin") + ":/usr/bin:/bin", "LC_ALL": "C"}}
os.execve("/bin/sh", ["sh", "-c", command], env)
"""

FAKE_CLAUDE = """#!{python}
import json, os, sys
args = sys.argv[1:]
home = os.environ["HOME"]
if "--version" in args:
    print("2.1.0 (Claude Code)")
    sys.exit(0)
if "--help" in args:
    print("Usage: claude [options] [prompt]")
    if not os.path.exists(os.path.join(home, ".no-perms")):
        print("  --permission-prompt-tool <tool>  MCP tool to handle permission prompts")
    sys.exit(0)
with open(os.path.join(home, "claude-args.jsonl"), "a") as f:
    f.write(json.dumps(args) + "\\n")
asks = "--permission-prompt-tool" in args
session = args[args.index("--resume") + 1] if "--resume" in args else "remote-session-1"

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)

cost, n, started = 0.0, 0, False
while True:
    msg = read()
    if msg.get("type") == "control_request":
        out({{"type": "control_response", "response": {{"subtype": "success",
             "request_id": msg["request_id"], "response": {{}}}}}})
        continue
    if msg.get("type") != "user":
        continue
    text = msg["message"]["content"]
    with open(os.path.join(home, "prompts.jsonl"), "a") as f:
        f.write(json.dumps(text) + "\\n")
    if not started:
        out({{"type": "system", "subtype": "init", "session_id": session, "cwd": os.getcwd(),
             "model": "claude-test"}})
        started = True
    n += 1
    for word in text.split():
        if not word.startswith("WRITE:"):
            continue
        path = os.path.join(os.getcwd(), word[6:])
        given = {{"file_path": path, "content": "made there\\n"}}
        tid = "tool%d" % n
        out({{"type": "assistant", "parent_tool_use_id": None, "message": {{"content": [
            {{"type": "tool_use", "id": tid, "name": "Write", "input": given}}]}}}})
        allowed = True
        if asks:
            rid = "perm%d" % n
            out({{"type": "control_request", "request_id": rid, "request": {{
                "subtype": "can_use_tool", "tool_name": "Write", "input": given}}}})
            while True:
                m = read()
                if m.get("type") == "control_response" and m["response"]["request_id"] == rid:
                    allowed = m["response"]["response"]["behavior"] == "allow"
                    break
        if allowed:
            with open(path, "w") as f:
                f.write("made there\\n")
        out({{"type": "user", "parent_tool_use_id": None, "message": {{"content": [
            {{"type": "tool_result", "tool_use_id": tid, "content": "ok" if allowed else "no",
              "is_error": not allowed}}]}}}})
    out({{"type": "assistant", "parent_tool_use_id": None, "message": {{"content": [
        {{"type": "text", "text": "Done with turn %d there." % n}}]}}}})
    cost += 0.25
    out({{"type": "result", "subtype": "success", "is_error": False, "duration_ms": 1500,
         "total_cost_usd": cost, "usage": {{"input_tokens": 1000, "output_tokens": 200}},
         "session_id": session}})
"""

# A tmux that only knows what the runner asks of it: a detached session for one command.
FAKE_TMUX = """#!/bin/sh
case "$1" in
  new-session) shift 4; echo "$@" >> "$HOME/tmux.log"; nohup "$@" >/dev/null 2>&1 </dev/null & ;;
  kill-session) exit 1 ;;
esac
"""


def executable(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


@pytest.fixture
def remotes(tmp_path):
    """Remote homes: studio (claude that asks), quiet (claude that can't ask, and tmux),
    bare (no claude); ghost is in the SSH config but nowhere."""
    root = tmp_path / "remotes"
    py = sys.executable
    for name in ("studio", "quiet", "bare"):
        (root / name / "bin").mkdir(parents=True)
    for name in ("studio", "quiet"):
        executable(root / name / "bin" / "claude", FAKE_CLAUDE.format(python=py))
    (root / "quiet" / ".no-perms").write_text("")
    executable(root / "quiet" / "bin" / "tmux", FAKE_TMUX)
    yield root
    for pid_file in root.glob("*/.jarvis-handoff/*/claude.pid"):  # nothing outlives the test
        try:
            os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)
        except (ValueError, OSError):
            pass


@pytest.fixture
def ssh(tmp_path, remotes):
    return executable(
        tmp_path / "fake-ssh", FAKE_SSH.format(python=sys.executable, root=str(remotes))
    )


@pytest.fixture
def ssh_config(tmp_path):
    extra = tmp_path / "ssh" / "conf.d" / "work"
    extra.parent.mkdir(parents=True)
    extra.write_text("Host bare\n  HostName bare.local\n")
    config = tmp_path / "ssh" / "config"
    config.write_text(
        textwrap.dedent(
            """\
            # mine
            Host studio quiet
              User me
            Host ghost
            Host *.internal !nope
              ForwardAgent no
            Include conf.d/*
            """
        )
    )
    return config


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects, ssh, ssh_config):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.code_handoff.ssh = str(ssh)
    hub.code_handoff.ssh_config = ssh_config
    yield hub
    desk = hub.code_handoff
    for follower in list(desk._followers.values()):
        follower.cancel()
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    pending = [*handles, *desk._followers.values()]
    if pending:
        await asyncio.wait(pending, timeout=5)


def answer(hub, *choices):
    hub.cards = []
    queue = list(choices)

    def sink(card):
        hub.cards.append(card)
        if queue:
            hub.resolve(card["id"], queue.pop(0))

    hub.add_approval_sink(sink)


async def until(condition, seconds=20.0):
    for _ in range(int(seconds / 0.02)):
        if condition():
            return True
        await asyncio.sleep(0.02)
    return False


async def isolated_session(hub, name="proj"):
    task = hub.tasks.start("", name, isolate=True, title="fix the login")
    made = await until(lambda: task.workspace and task.client is not None, seconds=60)
    assert made, task.transcript
    task.session_id = "local-session-1"
    return task


def said(task):
    return [e["text"] for e in task.transcript]


# ── the owner's SSH config ──


def test_the_ssh_config_names_its_hosts_and_the_ones_it_includes(ssh_config):
    assert handoff.config_hosts(ssh_config) == ["studio", "quiet", "ghost", "bare"]
    assert handoff.config_hosts(ssh_config.parent / "missing") == []


def test_a_host_alias_is_never_an_option_or_a_command():
    for bad in ("-oProxyCommand=x", "a b", "a;b", "", "$(x)"):
        with pytest.raises(ValueError):
            handoff.ssh_argv("ssh", bad, "true")
    argv = handoff.ssh_argv("ssh", "studio", "echo 'hi'")
    assert argv[:3] == ["ssh", "-o", "BatchMode=yes"] and argv[-2] == "studio"
    assert argv[-1] == "sh -c 'echo '\"'\"'hi'\"'\"''"


def test_the_remote_mode_is_never_bypass():
    assert handoff.remote_mode("auto", True)[0] == "default"
    assert handoff.remote_mode("edits", True) == ("acceptEdits", "")
    assert handoff.remote_mode("plan", True) == ("plan", "")
    assert handoff.remote_mode("ask", False)[0] == "acceptEdits"
    assert "can't ask you" in handoff.remote_mode("ask", False)[1]
    script = handoff.runner("/x/claude", "default", True, "opus", "abc-123")
    assert "--permission-prompt-tool stdio" in script and "--resume abc-123" in script
    assert "bypass" not in script.lower() and "dangerously" not in script
    assert "--resume" not in handoff.runner("/x/claude", "plan", False, resume="bad id;rm")


# ── machines ──


async def test_adding_a_machine_checks_ssh_git_and_claude(hub, remotes):
    desk = hub.code_handoff
    assert "isn't a host in your SSH config" in await desk.add_machine("elsewhere")
    assert await desk.add_machine("studio") == "studio is ready."
    studio = desk.machine("studio")
    assert studio.ok and studio.permissions and not studio.tmux
    assert studio.claude == str(remotes / "studio" / "bin" / "claude")
    assert studio.claude_version.startswith("2.1.0") and studio.git.startswith("git version")
    assert await desk.add_machine("studio") == "studio is already on the list."
    await desk.add_machine("quiet")
    quiet = desk.machine("quiet")
    assert quiet.ok and quiet.tmux and not quiet.permissions
    assert "needs the Claude Code CLI on bare" in await desk.add_machine("bare")
    assert "ghost can't be found" in await desk.add_machine("ghost")
    (remotes / "studio" / ".down").write_text("")
    assert await desk.test_machine("studio") == "studio isn't reachable right now."
    kind, data = [e for e in hub.events if e[0] == "code_handoffs"][-1]
    assert [m["alias"] for m in data["machines"]] == ["studio", "quiet", "bare", "ghost"]
    assert data["hosts"] == []  # every host in the config is added
    # Kept: only aliases and what the check found, never a key.
    kept = json.loads(desk.path.read_text())
    assert set(kept["machines"][0]) == set(Machine("x").public())
    assert desk.remove_machine("bare") == "Removed bare." and desk.machine("bare") is None


# ── handing off, streaming back, bringing back ──


async def test_a_session_moves_there_asks_here_and_comes_back_ready_to_land(
    hub, projects, remotes, tmp_path
):
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", str(origin))
    repo = make_repo(projects / "proj", {"a.py": numbered(5)})
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "origin", "main")
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    (task.cwd / "a.py").write_text("changed here\n")  # uncommitted: committed before it goes
    task.transcript.append({"role": "user", "text": "make the login faster"})
    answer(hub, "go", "allow", "allow", "back")

    said_back = await desk.hand_off(task, "studio", "WRITE:there.txt and carry on")
    assert said_back == (
        "Handed off to studio: it carries on there, and its permission requests come here."
    )
    card = hub.cards[0]
    assert card["question"] == "Continue this session on studio?"
    assert "Its 1 uncommitted files are committed first" in card["detail"]
    assert "JARVIS's spending limits can't meter them" in card["detail"]
    assert card["task_id"] == task.id
    rec = desk.of_task(task)
    assert rec.how == "push" and rec.keeper == "nohup" and rec.asks and rec.mode == "default"
    assert task.handle.done() and task.client is None  # its connection here closed
    # The branch went to the project's remote, and the machine fetched it from there.
    assert git(origin, "rev-parse", f"refs/heads/{rec.branch}").strip() == rec.base
    checkout = remotes / "studio" / ".jarvis-handoff" / rec.id / "repo"
    assert (checkout / "a.py").read_text() == "changed here\n"
    assert oct((checkout.parent).stat().st_mode & 0o777) == "0o700"

    # Its permission request came here as a card; allowed, the step ran there.
    assert await until(lambda: rec.turns >= 1), said(task)
    assert hub.cards[1]["question"] == "Allow this step on studio?"
    assert "Writing there.txt" in hub.cards[1]["detail"]
    assert (checkout / "there.txt").read_text() == "made there\n"
    tool = next(e for e in task.transcript if e.get("tool") == "Write")
    assert tool["status"] == "done" and tool["text"] == "Writing there.txt"
    assert "Done with turn 1 there." in said(task) and rec.cost == 0.25
    assert task.cost_usd is None  # shown, never counted against JARVIS's limits
    assert not task.busy and task.status == "waiting"
    assert any(kind == "task_finished" for kind, _ in hub.events)
    args = json.loads((remotes / "studio" / "claude-args.jsonl").read_text().splitlines()[0])
    assert (
        "--permission-prompt-tool" in args
        and args[args.index("--permission-mode") + 1] == "default"
    )
    first = json.loads((remotes / "studio" / "prompts.jsonl").read_text().splitlines()[0])
    assert "make the login faster" in first and first.rstrip().endswith(
        "WRITE:there.txt and carry on"
    )

    # The owner's next message goes there too, not to a Claude Code here.
    assert hub.tasks.send(task.id, "WRITE:second.txt")
    assert await until(lambda: rec.turns >= 2), said(task)
    assert task.handle.done() and (checkout / "second.txt").exists()
    assert rec.cost == 0.5

    # Brought back: stopped there, committed, fetched into the copy here.
    reply = await desk.bring_back(rec)
    assert reply == "Brought back from studio: 1 commit in its isolated copy, ready to land."
    assert hub.cards[-1]["question"] == f"Bring {rec.branch} back from studio?"
    assert (task.cwd / "there.txt").read_text() == "made there\n"
    assert (task.cwd / "second.txt").exists()
    assert git(task.cwd, "log", "-1", "--format=%s").strip() == "Jarvis Code: work on studio"
    assert desk.of_task(task) is None and task.status == "closed"
    assert await until(lambda: (checkout.parent / "exit.code").exists())
    # Its next message here says what happened there.
    note = hub.tasks.turn_note(task)
    assert "carried on on studio" in note and "Done with turn 2 there." in note
    assert "carried on" not in hub.tasks.turn_note(task)  # once


async def test_without_a_shared_remote_it_goes_as_a_bundle_and_a_cli_that_cant_ask_accepts_edits(
    hub, projects, remotes
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("quiet")
    task = await isolated_session(hub)
    task.mode = "auto"  # Bypass here: never there
    answer(hub, "go")
    reply = await desk.hand_off(task, "quiet", "WRITE:made.txt")
    assert reply == "Handed off to quiet: it carries on there in Accept edits."
    assert "can't ask you from this Mac" in hub.cards[0]["detail"]
    assert "over SSH, with the project's history" in hub.cards[0]["detail"]
    rec = desk.of_task(task)
    assert rec.how == "bundle" and rec.keeper == "tmux" and rec.mode == "acceptEdits"
    assert await until(lambda: rec.turns >= 1), said(task)
    assert len(hub.cards) == 1  # nothing asked: Accept edits there
    args = json.loads((remotes / "quiet" / "claude-args.jsonl").read_text().splitlines()[0])
    assert "--permission-prompt-tool" not in args and "acceptEdits" in args
    assert not list((remotes / "quiet" / ".jarvis-handoff").glob("*/handoff.bundle"))
    assert any("can't ask you from this Mac" in t for t in said(task))


async def test_a_dropped_connection_reconnects_and_reads_on_from_where_it_was(
    hub, projects, remotes
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    answer(hub, "go")
    await desk.hand_off(task, "studio", "hello")
    rec = desk.of_task(task)
    assert await until(lambda: rec.turns >= 1)
    seen = rec.seen
    # The connection drops: the follower's ssh is gone, and the machine is unreachable.
    (remotes / "studio" / ".down").write_text("")
    desk._followers[rec.id].cancel()
    desk._followers.pop(rec.id)
    desk._follow(rec)
    await asyncio.sleep(0.3)
    # Meanwhile it keeps working there (the owner's message reached it before the drop).
    folder = remotes / "studio" / ".jarvis-handoff" / rec.id
    with (folder / "inbox.jsonl").open("a") as inbox:
        inbox.write(handoff.user_line("again") + "\n")
    assert await until(lambda: "Lost the connection to studio" in " ".join(said(task)))
    assert await until(lambda: len((folder / "out.jsonl").read_text().splitlines()) >= seen + 2)
    (remotes / "studio" / ".down").unlink()
    assert await until(lambda: rec.turns >= 2, seconds=30), said(task)
    assert "Reconnected to studio." in said(task)
    assert said(task).count("Done with turn 1 there.") == 1  # nothing read twice


async def test_after_a_restart_it_reattaches_and_asks_again_what_nobody_answered(
    hub, projects, remotes
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    answer(hub, "go")  # the hand-off; its permission card is never answered
    await desk.hand_off(task, "studio", "WRITE:x.txt")
    rec = desk.of_task(task)
    assert await until(lambda: rec.pending)
    # JARVIS quits before the card is answered: a new desk reads the kept list.
    for follower in desk._followers.values():
        follower.cancel()
    for asked in [a for asks in desk._asks.values() for a in asks.values()]:
        asked.cancel()
    from jarvis.features.code_handoff import Desk

    again = Desk(hub)
    again.ssh, again.ssh_config = desk.ssh, desk.ssh_config
    again.booted = rec.started + 1  # a later launch: session numbers mean nothing now
    again.load()
    kept = again.handoffs[0]
    assert kept.pending and kept.pending[0]["tool"] == "Write" and kept.seen > 0
    assert again.task_of(kept) is task  # found again by its Claude Code session
    answer(hub, "allow")
    again._follow(kept)
    await again._resend(kept)
    assert await until(lambda: kept.turns >= 1), said(task)
    folder = remotes / "studio" / ".jarvis-handoff" / kept.id
    assert (folder / "repo" / "x.txt").exists()
    for follower in again._followers.values():
        follower.cancel()
    await asyncio.wait(list(again._followers.values()), timeout=5)


async def test_stop_and_a_message_starts_it_there_again_on_the_same_conversation(
    hub, projects, remotes
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    answer(hub, "go")
    await desk.hand_off(task, "studio", "hello")
    rec = desk.of_task(task)
    assert await until(lambda: rec.turns >= 1)
    assert await desk.stop(rec) == "Stopped it on studio."
    assert rec.state == "stopped" and task.status == "waiting"
    assert hub.tasks.send(task.id, "and now this")
    assert await until(lambda: rec.turns >= 2), said(task)
    lines = (remotes / "studio" / "claude-args.jsonl").read_text().splitlines()
    assert "--resume" in json.loads(lines[-1]) and "remote-session-1" in json.loads(lines[-1])


async def test_what_cant_be_handed_off_says_why(hub, projects, remotes):
    (projects / "plain").mkdir()
    desk = hub.code_handoff
    await desk.add_machine("studio")
    shared = hub.tasks.start("", "plain")
    assert await until(lambda: shared.client is not None)
    assert "isolated copy" in await desk.hand_off(shared, "studio")
    assert "Add elsewhere in Jarvis Code settings" in await desk.hand_off(shared, "elsewhere")
    make_repo(projects / "proj", {"a.py": numbered(5)})
    task = await isolated_session(hub)
    task.busy = True
    assert "middle of a step" in await desk.hand_off(task, "studio")
    task.busy = False
    answer(hub, "deny")
    assert await desk.hand_off(task, "studio") == "Not handed off."
    assert desk.of_task(task) is None and not (remotes / "studio" / ".jarvis-handoff").exists()
    assert await desk.bring_back(None) == "That session isn't on another machine."


def test_the_records_survive_a_bad_file(tmp_path):
    raw = {"id": "x", "alias": "studio", "slug": "x", "project": "p", "branch": "b", "base": "c"}
    assert handoff.from_raw(Handoff, raw | {"unknown": 1}).alias == "studio"
    assert handoff.from_raw(Handoff, "nope") is None
    assert handoff.from_raw(Handoff, {"id": "x"}) is None


def test_every_sentence_has_chinese():
    from jarvis import lang
    from jarvis.features import code_handoff

    plain = [english for english in code_handoff.ZH if "{" not in english]
    assert len(plain) > 20 and [e for e in plain if lang.translate(e, "zh") == e] == []
    built = [
        "Continue this session on studio?",
        "Handed off to studio: it carries on there in Accept edits.",
        "Lost the connection to studio. It keeps running there; reconnecting…",
        "Brought back from studio: 3 commits in its isolated copy, ready to land.",
        "studio can't be found: check its HostName in your SSH config.",
    ]
    for sentence in built:
        assert lang.translate(sentence, "zh") != sentence, sentence


async def test_its_voice_tools_are_there_and_pick_the_session_in_focus(hub, projects):
    from jarvis.features import code_handoff

    assert hub._feature_servers()[code_handoff.SERVER] is not None
    desk = hub.code_handoff
    assert desk.spoken_task(None) is None
    make_repo(projects / "proj", {"a.py": numbered(5)})
    first = await isolated_session(hub)
    second = await isolated_session(hub)
    assert desk.spoken_task(None) is second  # the latest
    hub.voicecode.focus = first.id
    assert desk.spoken_task(None) is first and desk.spoken_task(second.id) is second
