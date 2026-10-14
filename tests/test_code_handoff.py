"""Hand-off (handoff.py, features/code_handoff.py): an Eden Code session continued on another
machine over SSH. No real SSH: a fake ssh runs each command with sh in a folder standing in
for the remote's home, and a fake claude there speaks stream-json (asking for permission
over stdio when its --help says it can). Real git, in temp repositories."""

import asyncio
import json
import os
import shlex
import signal
import stat
import subprocess
import sys
import textwrap
import time
from dataclasses import replace
from pathlib import Path

import pytest
import proc_reaper
from test_code_changes import git, make_repo, numbered

from jarvis import handoff
from jarvis.handoff import Handoff, Machine

FAKE_SSH = """\
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

FAKE_CLAUDE = """\
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


def python_executable(path: Path, code: str) -> Path:
    """An executable that runs code with this Python. A sh line that execs it, never a
    '#!<python>' line: the kernel cuts a shebang at its first space, and this Python's path
    may have one (this repository's folder does)."""
    run = f'exec {shlex.quote(sys.executable)} -c {shlex.quote(code)} "$@"\n'
    return executable(path, "#!/bin/sh\n" + run)


@pytest.fixture
def remotes(tmp_path):
    """Remote homes: studio (claude that asks), quiet (claude that can't ask, and tmux),
    bare (no claude); ghost is in the SSH config but nowhere. Their folder has a space in it,
    so every script run there copes with a home that has one."""
    root = tmp_path / "remote homes"
    for name in ("studio", "quiet", "bare"):
        (root / name / "bin").mkdir(parents=True)
    for name in ("studio", "quiet"):
        python_executable(root / name / "bin" / "claude", FAKE_CLAUDE.format())
    (root / "quiet" / ".no-perms").write_text("")
    executable(root / "quiet" / "bin" / "tmux", FAKE_TMUX)
    yield root
    # Nothing outlives the test. Not by claude.pid alone: a run whose run.sh hadn't written
    # it yet (or one started by the fake tmux a moment after) left `sh run.sh`, its
    # `tail -f` and the fake claude running for good, 68 of them by 2026-10-13. Every
    # process naming this test's folder goes, and what it started, for as long as more
    # keep appearing (up to 5 s).
    proc_reaper.reap(root)


@pytest.fixture(autouse=True)
def _nothing_outlives_the_test(tmp_path):
    """The check behind remotes' teardown: once a test is done, no process names its
    folder (one that does is killed here too, so a failure never leaks either)."""
    yield
    left = proc_reaper.reap(tmp_path)
    assert not left, f"still running after the test: {left}"


@pytest.fixture
def ssh(tmp_path, remotes, monkeypatch):
    # A command there starts a Python or three (this ssh; a claude's --version and --help), and
    # on a busy Mac that can outlast the wait meant for a real ssh: what these tests prove
    # isn't how long Jarvis waits.
    monkeypatch.setattr(handoff, "CHECK_SECONDS", 120.0)
    monkeypatch.setattr(handoff, "WRITE_SECONDS", 120.0)
    return python_executable(tmp_path / "fake ssh" / "ssh", FAKE_SSH.format(root=str(remotes)))


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


async def until(condition, seconds=90.0):
    # Generous: a step there starts a Python or two, which on a busy Mac takes seconds.
    for _ in range(int(seconds / 0.02)):
        if condition():
            return True
        await asyncio.sleep(0.02)
    return False


async def isolated_session(hub, name="proj"):
    task = hub.tasks.start("", name, isolate=True, title="fix the login")
    made = await until(lambda: task.workspace and task.client is not None)
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


def wait_for(condition, seconds=90.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return condition()


def test_a_run_that_quits_late_leaves_the_one_started_after_it_running(tmp_path):
    """Stopped, a CLI that takes a while to quit can end after a message has started it there
    again: its exit code isn't the newer run's, which still reads as running, and still says
    how it ended itself. The remote's scripts run here with sh, in a home with a space."""
    home = tmp_path / "a home"
    rec = Handoff(id="late", alias="studio", slug="late", project="p", branch="b", base="c")
    folder = home / handoff.ROOT / rec.id
    (folder / "repo").mkdir(parents=True)
    # Reads what it's sent until it's told to stop, then quits only once let-go is there.
    let_go = home / "let-go"
    fake = (
        "#!/bin/sh\n"
        "trap 'while [ ! -f \"$HOME/let-go\" ]; do sleep 0.1; done; exit 143' TERM\n"
        'touch "$HOME/listening.$$"\n'
        "while read -r line; do :; done\n"
    )
    run_sh = handoff.runner(str(executable(home / "claude", fake)), "default", False)
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "LC_ALL": "C"}

    def there(script, given=b""):
        done = subprocess.run(
            ["sh", "-c", script], input=given, env=env, capture_output=True, timeout=60
        )
        return done.stdout.decode().strip()

    def started(before=""):
        pid = folder / "claude.pid"
        assert wait_for(lambda: pid.exists() and pid.read_text().strip() not in ("", before))
        return pid.read_text().strip()

    def alive(pid):
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            return False
        return True

    there(handoff.start_script(rec, run_sh), handoff.inbox_bytes(["{}"]))
    first = started()
    ps = ["ps", "-o", "ppid=", "-p", first]
    runner = subprocess.run(ps, capture_output=True, text=True).stdout.strip()
    second = ""
    try:
        assert wait_for(lambda: (home / f"listening.{first}").exists())
        os.kill(int(first), signal.SIGTERM)  # stopped, and the stop's wait for it ran out
        there(handoff.start_script(rec, run_sh), handoff.inbox_bytes(["{}"]))  # a message
        second = started(first)
        let_go.write_text("")  # the first quits now, with the newer one under way
        assert wait_for(lambda: not alive(first) and not alive(runner))  # and is over
        assert there(handoff.status_script(rec)) == "running"
        assert not (folder / "exit.code").exists() and (folder / "in.fifo").exists()
        os.kill(int(second), signal.SIGKILL)
        assert wait_for(lambda: (folder / "exit.code").exists())
        assert (folder / "exit.code").read_text().strip() == "137"
    finally:
        for pid in (first, second):
            if pid and alive(pid):
                os.kill(int(pid), signal.SIGKILL)


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
    # Off the PATH of a non-interactive shell, it's found where the installer puts it (in a
    # home whose path has a space).
    installed = python_executable(remotes / "bare" / ".local" / "bin" / "claude", "print('2.1.0')")
    assert await desk.test_machine("bare") == "bare is ready."
    assert desk.machine("bare").claude == str(installed)
    installed.unlink()
    assert "needs the Claude Code CLI on bare" in await desk.test_machine("bare")
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
    assert task.cost_usd is None  # shown, never counted against Jarvis's limits
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
    assert git(task.cwd, "log", "-1", "--format=%s").strip() == "Eden Code: work on studio"
    assert desk.of_task(task) is None and task.status == "closed"
    assert await until(lambda: (checkout.parent / "exit.code").exists())
    # Its next message here says what happened there.
    note = hub.tasks.turn_note(task)
    assert "carried on on studio" in note and "Done with turn 2 there." in note
    # S5: what came from there (its reply, its commits' messages) is marked as its words.
    from jarvis.features.code_handoff import UNTRUSTED_NOTE

    assert note.index(UNTRUSTED_NOTE) < note.index("Done with turn 2 there.")
    assert "</from-studio>" in note
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
    hub, projects, remotes, monkeypatch
):
    from jarvis.features import code_handoff

    # A try every 2 s: the reconnecting waits double (to a minute) while the machine is away,
    # and on a busy Mac its turn there can keep it away long enough to push the next try past
    # the wait below. When it reconnects isn't what this proves; that it does, and reads on.
    monkeypatch.setattr(code_handoff, "RETRY_MAX", 2.0)
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
    assert await until(lambda: rec.turns >= 2), said(task)
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
    # Jarvis quits before the card is answered: a new desk reads the kept list.
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
    hub, projects, remotes, monkeypatch
):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    answer(hub, "go")
    await desk.hand_off(task, "studio", "hello")
    rec = desk.of_task(task)
    assert await until(lambda: rec.turns >= 1)
    # Its reader hears the run end before the stop's answer comes back: that end is the stop.
    run = handoff.run

    async def answered_late(ssh, alias, script, **kwargs):
        done = await run(ssh, alias, script, **kwargs)
        if script == handoff.stop_script(rec):
            await until(lambda: desk._followers[rec.id].done())
        return done

    monkeypatch.setattr(handoff, "run", answered_late)
    assert await desk.stop(rec) == "Stopped it on studio."
    assert rec.state == "stopped" and task.status == "waiting"
    assert not [t for t in said(task) if "ended (exit" in t], said(task)
    assert hub.tasks.send(task.id, "and now this")
    assert await until(lambda: rec.turns >= 2), said(task)
    lines = (remotes / "studio" / "claude-args.jsonl").read_text().splitlines()
    assert "--resume" in json.loads(lines[-1]) and "remote-session-1" in json.loads(lines[-1])


async def test_the_stopped_runs_end_heard_late_never_ends_the_run_after_it(hub, projects, remotes):
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    answer(hub, "go")
    await desk.hand_off(task, "studio", "hello")
    rec = desk.of_task(task)
    assert await until(lambda: rec.turns >= 1)
    assert await desk.stop(rec) == "Stopped it on studio."
    # Its reader hasn't passed on the stopped run's end yet (a slow connection, a busy Mac),
    # and does only once a message has started it there again.
    late = asyncio.Event()

    async def still_reading():
        await late.wait()
        await desk._ended(rec, "143")  # what reading that run's JARVIS-EXIT does

    desk._followers.pop(rec.id).cancel()
    desk._followers[rec.id] = hub._spawn(still_reading())
    assert hub.tasks.send(task.id, "and now this")
    assert await until(lambda: rec.state == "working")  # started there again
    late.set()
    assert await until(lambda: rec.turns >= 2), said(task)
    assert rec.live and not [t for t in said(task) if "ended (exit" in t]


async def test_what_cant_be_handed_off_says_why(hub, projects, remotes):
    (projects / "plain").mkdir()
    desk = hub.code_handoff
    await desk.add_machine("studio")
    shared = hub.tasks.start("", "plain")
    assert await until(lambda: shared.client is not None)
    assert "isolated copy" in await desk.hand_off(shared, "studio")
    assert "Add elsewhere in Eden Code settings" in await desk.hand_off(shared, "elsewhere")
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


# ── what can go wrong, and doesn't lose work ──


async def handed_off(hub, alias="studio", first="hello"):
    """A session handed off to alias with its first turn there done."""
    desk = hub.code_handoff
    await desk.add_machine(alias)
    task = await isolated_session(hub)
    answer(hub, "go")
    assert (await desk.hand_off(task, alias, first)).startswith("Handed off"), said(task)
    rec = desk.of_task(task)
    assert await until(lambda: rec.turns >= 1), said(task)
    return desk, task, rec


def remote_folder(remotes, rec, alias="studio"):
    return remotes / alias / ".jarvis-handoff" / rec.id


def test_remote_addresses_and_ids_are_never_read_as_options():
    """S27: every address goes after "--", one with a leading "-" isn't used, and a model or
    session id with one never reaches the CLI."""
    rec = Handoff(id="x", alias="studio", slug="x", project="p", branch="b", base="c")
    script = handoff.setup_script(rec, "'https://example.com/r.git'", "--upload-pack=touch /x")
    assert "git fetch -q -- 'https://example.com/r.git'" in script
    assert "upload-pack" not in script  # never made its origin
    assert "git remote add -- origin" in handoff.setup_script(rec, "src", "https://e.com/r")
    assert not handoff.remote_url_ok("--upload-pack=x") and handoff.remote_url_ok("git@h:r")
    runner = handoff.runner("/x/claude", "default", True, "-oops", "-resume-me")
    assert "-oops" not in runner and "-resume-me" not in runner


async def test_a_secret_in_the_summary_is_on_the_card_before_it_goes(hub, projects, remotes):
    """S27: the summary it starts from there (the owner's words, its replies) is scanned
    too: a token pasted in the conversation is on the card, even for a preapproved move."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0" * 2
    task.transcript.append({"role": "user", "text": f"use this token: {token}"})
    answer(hub, "deny")
    assert await desk.hand_off(task, "studio", preapproved=True) == "Not handed off."
    detail = hub.cards[0]["detail"]
    assert "Possible secrets" in detail and "the session's summary" in detail
    assert token not in detail
    assert not (remotes / "studio" / ".jarvis-handoff").exists()


async def test_a_second_hand_off_never_replaces_one_not_brought_back(hub, projects, remotes):
    """W10: stopped there, its record is the only way back to its work: a new hand-off of
    the same copy is refused until it's brought back or forgotten."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk, task, rec = await handed_off(hub)
    assert await desk.stop(rec) == "Stopped it on studio."
    answer(hub, "go")
    said_now = await desk.hand_off(task, "studio")
    assert said_now == (
        "It's still on studio from an earlier hand-off: bring that back, or forget it, first."
    )
    assert desk.handoffs == [rec]


def test_the_setup_there_never_throws_away_commits_that_didnt_come_back(tmp_path):
    """W10: the checkout there has commits on the branch that the one sent lacks (an earlier
    hand-off's, never brought back): setup refuses (exit 10) and they stay."""
    source = make_repo(tmp_path / "here", {"a.py": numbered(3)})
    git(source, "checkout", "-q", "-b", "feature")
    home = tmp_path / "a home"
    rec = Handoff(id="ahead", alias="studio", slug="ahead", project="p", branch="feature",
                  base=git(source, "rev-parse", "HEAD").strip())  # fmt: skip
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "LC_ALL": "C"}

    def setup():
        script = handoff.setup_script(rec, shlex.quote(str(source)))
        return subprocess.run(["sh", "-c", script], env=env, capture_output=True, timeout=60)

    assert setup().returncode == 0  # the first time: checked out
    there = home / handoff.ROOT / rec.id / "repo"
    (there / "b.py").write_text("work there\n")
    git(there, "-c", "user.email=x@y", "-c", "user.name=x", "add", "-A")
    git(there, "-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "-m", "there")
    kept = git(there, "rev-parse", "HEAD").strip()
    done = setup()
    assert done.returncode == handoff.SETUP_AHEAD, done.stderr
    assert git(there, "rev-parse", "HEAD").strip() == kept
    # Sent again with that commit in it (brought back and handed off again): it goes ahead.
    git(source, "fetch", "-q", str(there), "feature")
    git(source, "merge", "-q", "--ff-only", "FETCH_HEAD")
    assert setup().returncode == 0


async def test_a_permission_answer_that_didnt_get_there_keeps_going(hub, monkeypatch):
    """W11: its reader still connected, nothing would reconnect and resend it: the answer
    is tried again, backing off, until it's there."""
    from jarvis.features import code_handoff

    monkeypatch.setattr(code_handoff, "ANSWER_RETRY", 0.01)
    monkeypatch.setattr(code_handoff, "RETRY_MAX", 0.02)
    desk = hub.code_handoff
    desk.load()
    rec = Handoff(id="ans", alias="studio", slug="ans", project="p", branch="b", base="c",
                  state="working")  # fmt: skip
    item = {"request_id": "perm1", "tool": "Write", "input": {}, "answer": "{}"}
    rec.pending.append(item)
    desk.handoffs.append(rec)
    tries = []

    async def flaky(rec_, lines):
        tries.append(lines)
        return len(tries) > 5

    monkeypatch.setattr(desk, "_write", flaky)
    await asyncio.wait_for(desk._send_answer(rec, item), 10)
    assert len(tries) == 6 and rec.pending == []


async def test_a_second_hand_off_to_the_same_machine_never_replays_the_first(
    hub, projects, remotes
):
    """W13: the folder there is the same; the old run's out.jsonl is emptied, so its
    messages, cards and cost aren't read again as the new run's."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk, task, rec = await handed_off(hub)
    answer(hub, "back")
    assert (await desk.bring_back(rec)).startswith("Brought back")
    answer(hub, "go")
    assert (await desk.hand_off(task, "studio", "again")).startswith("Handed off")
    again = desk.of_task(task)
    assert await until(lambda: said(task).count("Done with turn 1 there.") >= 2), said(task)
    assert await until(lambda: again.turns >= 1)
    await asyncio.sleep(1.5)  # anything replayed would be read by now
    assert said(task).count("Done with turn 1 there.") == 2
    assert again.turns == 1 and again.cost == 0.25


async def test_a_message_to_a_run_that_died_there_starts_the_next_one(hub, projects, remotes):
    """W14: the run there is over but its reader hasn't heard: the message isn't written
    into an inbox nobody reads, it starts the next run (on the same conversation)."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk, task, rec = await handed_off(hub)
    desk._followers.pop(rec.id).cancel()  # its reader hasn't heard the end yet
    folder = remote_folder(remotes, rec)
    os.kill(int((folder / "claude.pid").read_text()), signal.SIGKILL)
    assert await until(lambda: (folder / "exit.code").exists())
    assert rec.live
    assert hub.tasks.send(task.id, "are you there")
    assert await until(lambda: rec.turns >= 2, 60), said(task)
    prompts = (remotes / "studio" / "prompts.jsonl").read_text()
    assert "are you there" in prompts


async def test_an_unreadable_kept_file_is_never_saved_over(hub, tmp_path, monkeypatch):
    """W15: one file that can't be read now (permissions, a disk error) would have been
    replaced by an empty list, and every hand-off in it lost."""
    from jarvis import jsonstore
    from jarvis.features.code_handoff import Desk

    desk = Desk(hub)
    desk.path.parent.mkdir(parents=True, exist_ok=True)
    desk.path.write_text('{"machines": [{"alias": "studio"}], "handoffs": []}')

    def unreadable(*_args, **_kwargs):
        raise jsonstore.Unreadable("can't read it now")

    monkeypatch.setattr(jsonstore, "load_json", unreadable)
    desk.load()
    desk.machines.append(Machine(alias="quiet"))
    desk.save()
    assert json.loads(desk.path.read_text())["machines"] == [{"alias": "studio"}]


async def test_bring_backs_park_under_refs_of_their_own_and_never_merge_risky_files(
    hub, projects, tmp_path
):
    """W16: one parked (the copy moved on) is never fetched over by the next. S5: one that
    changes a file that can run code here (Claude Code's settings, hook configs) isn't
    merged: it's parked and named."""
    from jarvis.features import code_handoff

    make_repo(projects / "proj", {"a.py": numbered(5), "package.json": '{"name": "p"}\n'})
    desk = hub.code_handoff
    task = await isolated_session(hub)
    copy = hub.code_desk.store().find(task.workspace["slug"])
    checkout = Path(copy.checkout)
    base = git(checkout, "rev-parse", "HEAD").strip()
    there = tmp_path / "there"
    git(tmp_path, "clone", "-q", "-b", copy.branch, str(checkout), str(there))
    rec = Handoff(id=code_handoff._record_id(copy.slug), alias="studio", slug=copy.slug,
                  project="proj", branch=copy.branch, base=base)  # fmt: skip

    def work(name, text):
        (there / name).parent.mkdir(parents=True, exist_ok=True)
        (there / name).write_text(text)
        git(there, "-c", "user.email=x@y", "-c", "user.name=x", "add", "-A")
        git(there, "-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "-m", name)
        done = subprocess.run(
            ["git", "-C", str(there), "bundle", "create", "-", f"refs/heads/{copy.branch}",
             f"^{base}"], capture_output=True, check=True,
        )  # fmt: skip
        return git(there, "rev-parse", "HEAD").strip(), done.stdout

    def parked():
        refs = git(checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/jarvis/")
        return dict(line.split() for line in refs.splitlines())

    # The copy moves on here meanwhile: neither bring-back can fast-forward.
    (checkout / "here.txt").write_text("here\n")
    git(checkout, "add", "-A")
    git(checkout, "commit", "-q", "-m", "here")
    first, data = work("b.py", "one\n")
    assert desk._take_bundle(rec, copy, data).startswith("Brought back as refs/jarvis/handoff/")
    second, data = work("c.py", "two\n")
    assert desk._take_bundle(rec, copy, data).startswith("Brought back as refs/jarvis/handoff/")
    assert sorted(parked().values()) == sorted([first, second])  # the first is still there

    # A copy that could fast-forward, but what came back changes what runs code here.
    for ref in parked():
        git(checkout, "update-ref", "-d", ref)
    git(checkout, "reset", "-q", "--hard", base)
    head = git(checkout, "rev-parse", "HEAD").strip()
    hooked, data = work(".claude/settings.json", '{"hooks": {}}\n')
    said_back = desk._take_bundle(rec, copy, data)
    assert "not merged" in said_back and ".claude/settings.json" in said_back
    assert git(checkout, "rev-parse", "HEAD").strip() == head
    assert list(parked().values()) == [hooked]
    assert code_handoff.risky_paths(["src/CLAUDE.md", ".mcp.json", "a/.githooks/pre-commit"]) == [
        "src/CLAUDE.md", ".mcp.json", "a/.githooks/pre-commit"
    ]  # fmt: skip
    assert code_handoff.risky_paths(["src/a.py", "docs/claude.txt"]) == []
    for ref in parked():
        git(checkout, "update-ref", "-d", ref)
    git(there, "reset", "-q", "--hard", base)
    _, data = work("package.json", '{"name": "p",\n "husky": {"hooks": {"pre-commit": "x"}}}\n')
    assert "package.json" in desk._take_bundle(rec, copy, data)
    git(there, "reset", "-q", "--hard", base)
    plain, data = work("d.py", "fine\n")
    assert isinstance(desk._take_bundle(rec, copy, data), list)
    assert git(checkout, "rev-parse", "HEAD").strip() == plain  # merged


async def test_a_session_started_in_the_cloud_is_found_again_after_a_restart(
    hub, projects, remotes
):
    """W17, confirmed: a session started with the Cloud switch never had a turn here, so
    it has no Claude Code session id; it wasn't kept, and its hand-off couldn't find it
    after a restart. It's kept now, and found again by its isolated copy."""
    from jarvis.features.code_handoff import Desk

    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    task.session_id = ""  # as the Cloud switch starts it: no turn here
    answer(hub, "go")
    assert (await desk.hand_off(task, "studio", "hello", preapproved=True)).startswith("Handed off")
    rec = desk.of_task(task)
    assert rec is not None and rec.session_id == ""
    assert hub.code_sessions._worth_keeping(task)  # kept across the restart
    for follower in desk._followers.values():
        follower.cancel()
    # The restart: the kept session comes back with a new number, in the copy's folder,
    # without its workspace (that's bound when it next starts).
    del hub.tasks.tasks[task.id]
    task.id, task.workspace = 900, {}
    hub.tasks.tasks[task.id] = task
    again = Desk(hub)
    again.ssh, again.ssh_config = desk.ssh, desk.ssh_config
    again.booted = rec.started + 1
    again.load()
    assert again.task_of(again.handoffs[0]) is task


async def test_a_start_that_fails_stops_whatever_it_started_there(
    hub, projects, remotes, monkeypatch
):
    """W18: the start's answer timed out after it had started it there: it's stopped, not
    left editing and billing with nobody reading."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    run = handoff.run

    async def no_answer(ssh, alias, script, **kwargs):
        done = await run(ssh, alias, script, **kwargs)
        if "run.sh" in script and "nohup" in script:
            return handoff.Done(124, b"", "no answer from studio in 60 s")
        return done

    monkeypatch.setattr(handoff, "run", no_answer)
    answer(hub, "go")
    said_now = await desk.hand_off(task, "studio", "hello")
    assert said_now.startswith("Couldn't start Claude Code on studio")
    folder = next((remotes / "studio" / ".jarvis-handoff").iterdir())
    assert await until(lambda: (folder / "exit.code").exists(), 30)
    assert desk.of_task(task) is None


async def test_the_reader_skips_a_huge_line_and_survives_anything(hub, projects, remotes):
    """W20: a line over the stream's limit, or anything else going wrong, ended the reader
    for good, and the session showed "Working" forever."""
    make_repo(projects / "proj", {"a.py": numbered(5)})
    desk = hub.code_handoff
    await desk.add_machine("studio")
    task = await isolated_session(hub)
    rec = Handoff(id="huge", alias="studio", slug="huge", project="proj", branch="b",
                  base="c", session_id=task.session_id, task_id=task.id, started=time.time(),
                  state="working")  # fmt: skip
    desk.handoffs.append(rec)
    folder = remote_folder(remotes, rec)
    folder.mkdir(parents=True)

    def text(words):
        return json.dumps({"type": "assistant", "parent_tool_use_id": None,
                           "message": {"content": [{"type": "text", "text": words}]}})  # fmt: skip

    with (folder / "out.jsonl").open("w") as out:
        out.write(text("before the big one") + "\n")
        out.write('{"type": "user", "pad": "' + "x" * (33 * 1024 * 1024) + '"}\n')
        out.write(text("after the big one") + "\n")
    (folder / "exit.code").write_text("0\n")
    assert await asyncio.wait_for(desk._read(rec), 120)
    assert rec.seen == 3
    assert "before the big one" in said(task) and "after the big one" in said(task)

    calls = []

    async def odd(rec_):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("something odd")
        return True

    desk._read = odd
    await asyncio.wait_for(desk._follow_loop(rec), 30)
    assert len(calls) == 2  # it read on after the error
