"""The Touch ID proof (S30): the app's main process signs macOS's yes under the proof key it
gave the backend on its own pipe (app/features/touchid.js makeProof, app/proof-pipe.js,
proof_pipe.py), never the launch token the page has (round 1 A1); the backend checks it: its
kind, its time, its signature, and once only. The proofs here are made the same way as
touchid.js makes them (and one by touchid.js itself, H7). The gate: from the window, Bypass (a
session's, new sessions', a project's default, an ACP agent's), a risky step's yes and Touch
ID turned off each need one; the phone and Touch ID turned off keep their own way; the
backend's risky steps are the window's."""

import asyncio
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from code_session_fakes import make_hub, until

from jarvis import companion_code, proof_pipe
from jarvis.features import code_touchid
from jarvis.tasks import ClaudeTask

TOKEN = "ab" * 24  # the launch token: the page has it (its URL)
KEY = "5e" * 32  # the proof key: the app's main process and the backend alone


# The subject a proof here is for when a test names none: Bypass for session 7 (the gated
# fixture's), nothing for the kinds that name none. A risky step's names its card.
SUBJECTS = {"bypass": "7"}


def proof(
    kind="bypass",
    expires_ms=None,
    nonce="0123456789abcdef0123456789abcdef",
    token=TOKEN,
    now=1_800_000_000.0,
    subject=None,
):
    expires_ms = int((now + 120) * 1000) if expires_ms is None else expires_ms
    subject = SUBJECTS.get(kind, "") if subject is None else subject
    signed = f"eden-touchid|v2|{kind}|{subject}|{expires_ms}|{nonce}"
    mac = hmac.new(token.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return f"v2.{kind}.{subject}.{expires_ms}.{nonce}.{mac}"


def test_a_proof_from_the_main_process_holds_once_for_its_kind_until_it_expires():
    now = 1_800_000_000.0
    good = proof(nonce="a" * 32, now=now)
    assert code_touchid.check_proof(TOKEN, good, "bypass", "7", now=now)
    assert not code_touchid.check_proof(TOKEN, good, "bypass", "7", now=now), "once only"
    fresh = proof(nonce="b" * 32, now=now)
    assert not code_touchid.check_proof(TOKEN, fresh, "approve", "7", now=now), "another kind"
    assert not code_touchid.check_proof("cd" * 24, fresh, "bypass", "7", now=now), (
        "another backend's token"
    )
    assert not code_touchid.check_proof(TOKEN, fresh, "bypass", "7", now=now + 121), "expired"
    assert not code_touchid.check_proof(
        TOKEN,
        proof(nonce="c" * 32, expires_ms=int((now + 3600) * 1000), now=now),
        "bypass",
        "7",
        now=now,
    ), "too far ahead"
    assert not code_touchid.check_proof(TOKEN, fresh.replace("v2.", "v3."), "bypass", "7", now=now)
    assert not code_touchid.check_proof("", fresh, "bypass", "7", now=now)
    assert not code_touchid.check_proof(TOKEN, "yes", "bypass", "7", now=now)
    assert code_touchid.check_proof(TOKEN, fresh, "bypass", "7", now=now)


def test_a_proof_holds_only_for_the_card_or_session_it_was_signed_for():
    """Round 3, R2-12: a yes for one card was good for any card of its kind for two
    minutes (a second risky step that came up meanwhile took the first one's proof). Now
    the subject is signed in: another card, another session, or none, and it's no proof."""
    now = 1_800_000_000.0
    for_a1 = proof("approve", nonce="d" * 32, now=now, subject="a1")
    assert not code_touchid.check_proof(TOKEN, for_a1, "approve", "a2", now=now)
    assert not code_touchid.check_proof(TOKEN, for_a1, "approve", "", now=now)
    assert code_touchid.check_proof(TOKEN, for_a1, "approve", "a1", now=now)
    # The subject written on it can't be changed: the mac is over it.
    moved = proof("bypass", nonce="e" * 32, now=now, subject="7").replace(".7.", ".8.", 1)
    assert not code_touchid.check_proof(TOKEN, moved, "bypass", "8", now=now)
    # The old unbound v1 proofs are no proof at all.
    expires = int((now + 120) * 1000)
    signed = f"eden-touchid|v1|approve|{expires}|{'f' * 32}"
    mac = hmac.new(TOKEN.encode(), signed.encode(), hashlib.sha256).hexdigest()
    v1 = f"v1.approve.{expires}.{'f' * 32}.{mac}"
    assert not code_touchid.check_proof(TOKEN, v1, "approve", "", now=now)


# ── the backend's gate: the window's switches into Bypass and risky answers need a proof ──


NODE = "/usr/local/bin/node"


@pytest.fixture
def gated(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.launch_token = TOKEN  # (server.create_app gives it)
    hub.proof_pipe = proof_pipe.Pipe(KEY, "7a" * 16)  # (server.serve: the app's pipe)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    hub.tasks.tasks[7] = task
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return hub, task, seen


def fresh(kind, nonce, token=KEY, subject=None):
    return proof(kind, nonce=nonce, now=time.time(), token=token, subject=subject)


async def test_bypass_from_the_window_needs_the_proof_of_a_yes(gated):
    hub, task, seen = gated
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode != "auto"
    assert any(k == "error" and "fingerprint" in d["text"] for k, d in seen)
    # A proof of another kind, or one made up by the page, doesn't do.
    await hub.handle(
        {"type": "code_touchid_proof", "kind": "approve", "proof": fresh("approve", "1" * 32)}
    )
    await hub.handle({"type": "code_touchid_proof", "kind": "bypass", "proof": "v1.bypass.1.2.3"})
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode != "auto"
    await hub.handle(
        {"type": "code_touchid_proof", "kind": "bypass", "proof": fresh("bypass", "2" * 32)}
    )
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode == "auto"
    await hub.handle({"type": "task_mode", "id": 7, "mode": "ask"})  # out of it: never held up
    assert task.mode == "ask"
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})  # the proof was used once
    assert task.mode == "ask"


def started(hub):
    """The sessions' modes as tasks.start made them (the gate inside it had its say), none
    of them run (nothing to connect to)."""
    hub.tasks._session = lambda task: asyncio.sleep(0)
    return lambda: [t.mode for i, t in sorted(hub.tasks.tasks.items()) if i != 7]


async def test_new_sessions_in_bypass_need_it_too(gated, tmp_path):
    hub, _task, seen = gated
    modes = started(hub)
    (tmp_path / "proj").mkdir()
    msg = {"type": "task_new", "directory": "proj", "prompt": "", "mode": "auto"}
    await hub.handle(dict(msg))
    assert modes() == ["ask"]  # it starts all the same, in Manual
    assert "fingerprint" in [d["text"] for k, d in seen if k == "error"][-1]
    await hub.handle({"type": "code_defaults", "code_mode": "auto", "code_effort": "high"})
    assert hub.prefs.code_mode != "auto" and hub.prefs.code_effort == "high"
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "bypass-default",
            "proof": fresh("bypass-default", "3" * 32),
        }
    )
    await hub.handle({"type": "code_defaults", "code_mode": "auto"})
    assert hub.prefs.code_mode == "auto"
    # New sessions start in Bypass now (that needed the proof): naming it asks nothing more.
    await hub.handle(dict(msg))
    assert modes() == ["ask", "auto"]


async def phone(hub, command):
    """A window command as the phone sends it (companion_code.CodeDesk.run)."""
    asking = companion_code._ASKER.set(asyncio.Queue())
    commanding = companion_code._COMMAND.set(command["type"])
    try:
        await hub.handle(command)
    finally:
        companion_code._COMMAND.reset(commanding)
        companion_code._ASKER.reset(asking)


async def test_the_phone_and_touch_id_off_keep_their_own_way(gated):
    hub, task, seen = gated
    await phone(hub, {"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode == "auto", "the phone's own gate (S11: its Face ID) is its own"
    task.mode = "ask"
    # A /bypass typed on the phone skips the Face ID its mode menu asks: refused (R2-2).
    await phone(hub, {"type": "code_command", "id": 7, "text": "/bypass"})  # (in the background)
    assert await until(lambda: any(k == "error" and "Face ID" in d["text"] for k, d in seen))
    assert task.mode == "ask"
    hub.set_feature_prefs({"code_touchid": False})
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode == "auto", "the owner turned Touch ID off"


async def test_a_risky_step_allowed_from_the_window_needs_the_proof(gated):
    hub, _task, seen = gated
    loop = asyncio.get_running_loop()

    def card(approval_id, command):
        hub.approvals[approval_id] = {
            "id": approval_id,
            "question": "Eden Code in alpha wants to run a command",
            "detail": f"$ {command}",
            "tool": "Bash",
            "task_id": 7,
            "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
        }
        hub._futures[approval_id] = loop.create_future()
        return hub._futures[approval_id]

    plain = card("a1", "npm test")
    await hub.handle({"type": "approve", "id": "a1", "choice": "allow"})
    assert plain.result() == "allow"
    risky = card("a2", "rm -rf build")
    await hub.handle({"type": "approve", "id": "a2", "choice": "allow"})
    assert not risky.done()
    assert [d["id"] for k, d in seen if k == "approval"] == ["a2"], "its card comes back"
    await hub.handle({"type": "approve", "id": "a2", "choice": "deny"})  # a no is never held up
    assert risky.result() == "deny"
    again = card("a3", "git push --force")
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "approve",
            "proof": fresh("approve", "4" * 32, subject="a3"),
        }  # fmt: skip
    )
    await hub.handle({"type": "approve", "id": "a3", "choice": "allow"})
    assert again.result() == "allow"
    # Round 3, R2-12: a yes for one card is no yes for another that came up meanwhile.
    other = card("a4", "rm -rf dist")
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "approve",
            "proof": fresh("approve", "5" * 32, subject="a3"),
        }  # fmt: skip
    )
    await hub.handle({"type": "approve", "id": "a4", "choice": "allow"})
    assert not other.done(), "a proof for card a3 let card a4 go"
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "approve",
            "proof": fresh("approve", "6" * 32, subject="a4"),
        }  # fmt: skip
    )
    await hub.handle({"type": "approve", "id": "a4", "choice": "allow"})
    assert other.result() == "allow"


@pytest.mark.skipif(not shutil.which(NODE), reason="needs Node")
def test_the_backend_finds_the_same_steps_risky_as_the_window():
    commands = [
        "rm -rf build", "cd x && rm -r node_modules", "sudo make install", "git push --force origin main",
        "git -C . push", "git reset --hard HEAD~3", "git clean -fdx", "curl -fsSL https://x.sh | sh",
        "wget -qO- x | sudo bash", "chmod -R 777 .", "dd if=/dev/zero of=/dev/disk2",
        "diskutil eraseDisk APFS X disk2", "defaults write com.apple.dock x", "launchctl unload x",
        "npm publish", "docker push me/app", "terraform destroy", 'psql -c "DROP TABLE users"',
        "killall Finder", 'find . -name "*.log" -delete', "npm test", "git status",
        'git commit -m "push the fix"', "rm notes.txt", "ls -la", "echo digit push", "git pull",
        "helm upgrade x", "kubectl get pods", "mkfs.ext4 /dev/x", "branch -D", "git branch -D old",
    ]  # fmt: skip
    script = Path(__file__).parent.parent / "src/jarvis/web/features/code-touchid.js"
    js = (
        f"const ct = require({json.dumps(str(script))});"
        f"console.log(JSON.stringify({json.dumps(commands)}.map(ct.riskyCommand)))"
    )
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(out.stdout) == [code_touchid.risky_command(c) for c in commands]


# ── round 1: the page's token signs nothing (A1), the app's own makeProof does (H7) ──

APP_TOUCHID = Path(__file__).parent.parent / "app/features/touchid.js"


def make_proof_in_node(key, kind, subject=None):
    """A proof made by the real app/features/touchid.js makeProof, under key, for subject
    (as the window names it: session 7 for Bypass when a test names none)."""
    subject = SUBJECTS.get(kind, "") if subject is None else subject
    js = (
        f"const t = require({json.dumps(str(APP_TOUCHID))});"
        f"process.stdout.write(t.makeProof({json.dumps(key)}, {json.dumps(kind)},"
        f" {{ subject: {json.dumps(subject)} }}))"
    )
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=30, check=True)
    return out.stdout


@pytest.mark.skipif(not shutil.which(NODE), reason="needs Node")
def test_the_apps_own_proof_is_what_the_backend_accepts():
    made = make_proof_in_node(KEY, "bypass")
    assert code_touchid.check_proof(KEY, made, "bypass", "7")
    assert not code_touchid.check_proof(KEY, made, "bypass", "7"), "once only"
    assert not code_touchid.check_proof(KEY, make_proof_in_node(KEY, "bypass"), "approve", "7")
    card = make_proof_in_node(KEY, "approve", "c0ffee12ab34")
    assert not code_touchid.check_proof(KEY, card, "approve", "c0ffee12ab35"), "another card"
    assert code_touchid.check_proof(KEY, card, "approve", "c0ffee12ab34")


@pytest.mark.skipif(not shutil.which(NODE), reason="needs Node")
async def test_a_script_in_the_window_cant_sign_a_yes_with_the_pages_token(gated):
    """Everything the page holds: the launch token (its URL, backend.json) and the app's own
    signing code. A proof made from them isn't one the backend takes; only the pipe's key is."""
    hub, task, _seen = gated
    assert hub.launch_token != hub.proof_pipe.key
    for forged in (make_proof_in_node(TOKEN, "bypass"), fresh("bypass", "8" * 32, token=TOKEN)):
        await hub.handle({"type": "code_touchid_proof", "kind": "bypass", "proof": forged})
        await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
        assert task.mode != "auto"
    # A backend with no pipe (run by hand) has no key: nothing the page signs holds either.
    hub.proof_pipe = None
    await hub.handle(
        {"type": "code_touchid_proof", "kind": "bypass", "proof": fresh("bypass", "9" * 32)}
    )
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode != "auto"


def test_the_key_comes_on_stdin_and_nothing_the_backend_starts_can_read_it(tmp_path):
    """proof_pipe.take in a real process, its stdin a pipe as the app makes it: it reads the
    key, the environment never had it, and a process it starts finds stdin empty."""
    script = tmp_path / "backend.py"
    script.write_text(
        "import json, os, subprocess, sys\n"
        "from jarvis import proof_pipe\n"
        "pipe = proof_pipe.take()\n"
        "child = subprocess.run([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))'],"
        " capture_output=True, text=True)\n"
        "lines = []\n"
        "import threading\n"
        "done = threading.Event()\n"
        "pipe.listen(lambda line: (lines.append(line), done.set()))\n"
        "print(json.dumps({'key': pipe.key, 'tag': pipe.tag, 'env': os.environ.get('JARVIS_PROOF_PIPE'),"
        " 'child': child.stdout.strip()}), flush=True)\n"
        "done.wait(10)\n"
        "print(json.dumps(lines), flush=True)\n"
    )
    key, tag = "c3" * 32, "d4" * 16
    env = {**os.environ, "JARVIS_PROOF_PIPE": "1"}
    proc = subprocess.Popen(
        [sys.executable, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
    )
    try:
        proc.stdin.write(f"{key} {tag}\n".encode())
        proc.stdin.flush()
        first = json.loads(proc.stdout.readline())
        assert first == {"key": key, "tag": tag, "env": None, "child": "''"}
        proc.stdin.write(b"proof bypass v1.x\n")
        proc.stdin.flush()
        assert json.loads(proc.stdout.readline()) == ["proof bypass v1.x"]
    finally:
        proc.kill()
        proc.wait(10)
    assert proof_pipe.take({}) is None, "no pipe asked for: none taken"


async def test_the_other_apps_window_asks_through_the_app_that_started_the_backend(gated):
    hub, task, seen = gated
    asked = []
    hub.proof_pipe = proof_pipe.Pipe(KEY, "7a" * 16, write=asked.append)
    hub.proof_pipe.listen = lambda on_line: None  # (the lines come in by hand here)
    await hub.handle({"type": "code_touchid_ask", "kind": "bypass", "lang": "zh"})
    assert asked == [("7a" * 16 + " ask bypass zh\n").encode()]
    gate = hub.code_touchid
    gate.loop = None
    gate.heard("no bypass")
    assert seen[-1] == ("code_touchid_answer", {"proof_kind": "bypass", "ok": False})
    gate.heard(f"proof bypass {fresh('bypass', 'e' * 32, token=TOKEN)}")  # (signed wrong)
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode != "auto", "a proof from the pipe is still checked"
    gate.heard(f"proof bypass {fresh('bypass', 'f' * 32)}")
    assert seen[-1] == ("code_touchid_answer", {"proof_kind": "bypass", "ok": True})
    await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    assert task.mode == "auto"
    # The window names what the yes is for (R2-12): it goes into the ask, and so its proof.
    await hub.handle(
        {"type": "code_touchid_ask", "kind": "approve", "lang": "en", "subject": "c0ffee12ab34"}
    )
    assert asked[-1] == ("7a" * 16 + " ask approve en c0ffee12ab34\n").encode()
    await hub.handle({"type": "code_touchid_ask", "kind": "approve", "subject": "a b\nproof"})
    assert len(asked) == 2, "a subject that isn't one is never asked about"
    hub.proof_pipe = None
    await hub.handle({"type": "code_touchid_ask", "kind": "approve"})
    assert seen[-1] == (
        "code_touchid_answer",
        {"proof_kind": "approve", "ok": False, "unavailable": True},
    )
    assert proof_pipe.parse_answer("proof bypass x y") is None
    assert proof_pipe.parse_answer("yes bypass") is None


# ── round 1: the gate's other ways round (A2-A5) ──


async def test_a_card_the_backend_marks_for_touch_id_needs_the_proof_too(gated):
    """Exterminator Mode's landing card: no task_id, touchid true (A2): the backend agrees with the
    window that it's risky."""
    hub, _task, _seen = gated
    land = {"id": "b1", "tool": "code_bugfix_land", "touchid": True, "tap_only": True}
    assert code_touchid.risky(land, "allow") and not code_touchid.risky(land, "deny")
    assert not code_touchid.risky({**land, "touchid": "yes"}, "allow")
    hub.approvals["b1"] = {
        **land,
        "question": "Land Exterminator Mode’s fixes in main?",
        "choices": [{"id": "allow", "label": "Land"}, {"id": "deny", "label": "Not now"}],
    }
    hub._futures["b1"] = asyncio.get_running_loop().create_future()
    await hub.handle({"type": "approve", "id": "b1", "choice": "allow"})
    assert not hub._futures["b1"].done()
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "approve",
            "proof": fresh("approve", "a1" * 16, subject="b1"),
        }
    )
    await hub.handle({"type": "approve", "id": "b1", "choice": "allow"})
    assert hub._futures["b1"].result() == "allow"


@pytest.mark.skipif(not shutil.which(NODE), reason="needs Node")
def test_the_window_and_the_backend_agree_on_the_marked_card():
    script = Path(__file__).parent.parent / "src/jarvis/web/features/code-touchid.js"
    cards = [
        ({"tool": "code_bugfix_land", "touchid": True}, "allow"),
        ({"tool": "code_bugfix_land", "touchid": True}, "deny"),
        ({"tool": "code_bugfix_land", "touchid": "yes"}, "allow"),
        ({"tool": "Bash", "detail": "$ rm -rf x"}, "allow"),
    ]
    js = (
        f"const ct = require({json.dumps(str(script))});"
        f"console.log(JSON.stringify({json.dumps(cards)}.map(([a, c]) => ct.risky(a, c))))"
    )
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(out.stdout) == [code_touchid.risky(a, c) for a, c in cards]


async def test_turning_touch_id_off_from_the_window_needs_the_proof(gated):
    hub, _task, seen = gated
    await hub.handle({"type": "feature_prefs", "changes": {"code_touchid": False}})
    assert hub.prefs.feature("code_touchid") is not False
    assert "fingerprint" in [d["text"] for k, d in seen if k == "error"][-1]
    # Nor round it, by replacing every feature setting at once.
    features = {**hub.prefs.features, "code_touchid": False}
    await hub.handle({"type": "set_prefs", "changes": {"features": features}})
    assert hub.prefs.feature("code_touchid") is not False
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "touchid-off",
            "proof": fresh("touchid-off", "0a" * 16),
        }
    )
    await hub.handle({"type": "feature_prefs", "changes": {"code_touchid": False}})
    assert hub.prefs.feature("code_touchid") is False
    await hub.handle({"type": "feature_prefs", "changes": {"code_touchid": True}})  # on: free
    assert hub.prefs.feature("code_touchid") is True


async def test_settings_cant_set_new_sessions_to_bypass_without_the_proof(gated, tmp_path):
    """set_prefs' code_mode and a project's own default mode (A4): refused without a proof,
    so a new session that names no mode starts in Manual."""
    hub, _task, _seen = gated
    started = []
    hub.tasks.start = lambda *a, **kw: (
        started.append(kw["mode"]) or (_ for _ in ()).throw(ValueError("stop"))
    )
    await hub.handle({"type": "set_prefs", "changes": {"code_mode": "auto", "code_effort": "low"}})
    assert hub.prefs.code_mode != "auto" and hub.prefs.code_effort == "low"
    project = tmp_path / "proj"
    project.mkdir()
    defaults = {str(project): {"mode": "auto", "effort": "high"}}
    await hub.handle({"type": "feature_prefs", "changes": {"code_project_defaults": defaults}})
    assert hub.prefs.feature("code_project_defaults") == {str(project): {"effort": "high"}}
    await hub.handle({"type": "task_new", "directory": str(project), "prompt": ""})
    assert started == ["ask"]
    # With its proof, the project's default holds, and its new sessions start in Bypass.
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "bypass-default",
            "proof": fresh("bypass-default", "0b" * 16),
        }
    )
    await hub.handle({"type": "feature_prefs", "changes": {"code_project_defaults": defaults}})
    assert hub.prefs.feature("code_project_defaults")[str(project)]["mode"] == "auto"
    hub.code_touchid.default_proven = -1e9  # (long ago: an edit of another field asks nothing)
    await hub.handle({"type": "feature_prefs", "changes": {"code_project_defaults": defaults}})
    assert hub.prefs.feature("code_project_defaults")[str(project)]["mode"] == "auto"


async def test_the_composers_bypass_moves_into_its_project_with_one_yes(gated, tmp_path):
    hub, _task, _seen = gated
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "bypass",
            "proof": fresh("bypass", "0c" * 16, subject="new"),
        }
    )
    await hub.handle({"type": "code_defaults", "code_mode": "auto"})
    assert hub.prefs.code_mode == "auto"
    moved = {str(tmp_path): {"mode": "auto"}}  # (code-sessions.js movedDefaults, just after)
    await hub.handle({"type": "feature_prefs", "changes": {"code_project_defaults": moved}})
    assert hub.prefs.feature("code_project_defaults") == moved


async def test_an_acp_agent_in_bypass_needs_the_proof_too(gated, tmp_path):
    hub, _task, seen = gated
    hub.code_acp.book.add("Fake", "fake-acp")
    modes = started(hub)
    (tmp_path / "proj").mkdir()
    msg = {"type": "acp_start", "agent": "fake", "directory": "proj", "mode": "auto"}
    await hub.handle(dict(msg))
    assert modes() == ["ask"]
    assert any(k == "error" and "fingerprint" in d["text"] for k, d in seen)
    await hub.handle(
        {
            "type": "code_touchid_proof",
            "kind": "bypass",
            "proof": fresh("bypass", "0d" * 16, subject="new"),
        }
    )
    await hub.handle(dict(msg))
    assert modes() == ["ask", "auto"]
