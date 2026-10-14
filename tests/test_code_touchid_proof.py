"""The Touch ID proof (S30): the app's main process signs macOS's yes under the backend's token
(app/features/touchid.js makeProof); the backend checks it: its kind, its time, its signature,
and once only. The proofs here are made the same way as touchid.js makes them. The gate: from
the window, Bypass (a session's, new sessions') and a risky step's yes each need one; the
phone and Touch ID turned off keep their own way; the backend's risky steps are the window's."""

import asyncio
import hashlib
import hmac
import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from code_session_fakes import make_hub

from jarvis import companion_code
from jarvis.features import code_touchid
from jarvis.tasks import ClaudeTask

TOKEN = "ab" * 24


def proof(
    kind="bypass",
    expires_ms=None,
    nonce="0123456789abcdef0123456789abcdef",
    token=TOKEN,
    now=1_800_000_000.0,
):
    expires_ms = int((now + 120) * 1000) if expires_ms is None else expires_ms
    mac = hmac.new(
        token.encode(), f"eden-touchid|v1|{kind}|{expires_ms}|{nonce}".encode(), hashlib.sha256
    ).hexdigest()
    return f"v1.{kind}.{expires_ms}.{nonce}.{mac}"


def test_a_proof_from_the_main_process_holds_once_for_its_kind_until_it_expires():
    now = 1_800_000_000.0
    good = proof(nonce="a" * 32, now=now)
    assert code_touchid.check_proof(TOKEN, good, "bypass", now=now)
    assert not code_touchid.check_proof(TOKEN, good, "bypass", now=now), "once only"
    fresh = proof(nonce="b" * 32, now=now)
    assert not code_touchid.check_proof(TOKEN, fresh, "approve", now=now), "another kind"
    assert not code_touchid.check_proof("cd" * 24, fresh, "bypass", now=now), (
        "another backend's token"
    )
    assert not code_touchid.check_proof(TOKEN, fresh, "bypass", now=now + 121), "expired"
    assert not code_touchid.check_proof(
        TOKEN,
        proof(nonce="c" * 32, expires_ms=int((now + 3600) * 1000), now=now),
        "bypass",
        now=now,
    ), "too far ahead"
    assert not code_touchid.check_proof(TOKEN, fresh.replace("v1.", "v2."), "bypass", now=now)
    assert not code_touchid.check_proof("", fresh, "bypass", now=now)
    assert not code_touchid.check_proof(TOKEN, "yes", "bypass", now=now)
    assert code_touchid.check_proof(TOKEN, fresh, "bypass", now=now)


# ── the backend's gate: the window's switches into Bypass and risky answers need a proof ──


NODE = "/usr/local/bin/node"


@pytest.fixture
def gated(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.launch_token = TOKEN  # (server.create_app gives it)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    hub.tasks.tasks[7] = task
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return hub, task, seen


def fresh(kind, nonce):
    return proof(kind, nonce=nonce, now=time.time())


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


async def test_new_sessions_in_bypass_need_it_too(gated):
    hub, _task, seen = gated
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
    msg = {"type": "task_new", "directory": "nowhere", "prompt": "", "mode": "auto"}
    hub.tasks.start = lambda *a, **kw: (_ for _ in ()).throw(ValueError(kw["mode"]))
    await hub.handle(msg)
    assert msg["mode"] == "ask"  # it starts all the same, in Manual
    assert [d["text"] for k, d in seen if k == "error"][-1] == "ask"


async def test_the_phone_and_touch_id_off_keep_their_own_way(gated):
    hub, task, _seen = gated
    asking = companion_code._ASKER.set(asyncio.Queue())
    try:
        await hub.handle({"type": "task_mode", "id": 7, "mode": "auto"})
    finally:
        companion_code._ASKER.reset(asking)
    assert task.mode == "auto", "the phone's own gate (S11) is its own"
    task.mode = "ask"
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
        {"type": "code_touchid_proof", "kind": "approve", "proof": fresh("approve", "4" * 32)}
    )
    await hub.handle({"type": "approve", "id": "a3", "choice": "allow"})
    assert again.result() == "allow"


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
