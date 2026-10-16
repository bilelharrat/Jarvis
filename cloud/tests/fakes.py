"""Shared fakes: a signed askeden token, a fake Claude Code CLI, a git repo, and a runner that
runs in a thread against the app in this event loop."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import threading
import time
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ACCOUNT = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
DEV = "dev-token-for-tests-0123456789abcdef"
KEY = "sk-ant-test-0123456789abcdefghijklmnop"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Signer:
    def __init__(self) -> None:
        self.private = Ed25519PrivateKey.generate()
        raw = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.public = base64.b64encode(raw).decode()

    def token(self, **claims) -> str:
        now = int(time.time())
        body = {
            "iss": "askeden.com",
            "aud": "eden-cloud",
            "sub": ACCOUNT,
            "dev": "abcdef0123456789",
            "kind": "mac",
            "plan": "plus",
            "iat": now,
            "exp": now + 600,
            "jti": "0" * 16,
        }
        body.update(claims)
        head = b64url(json.dumps({"alg": "EdDSA", "typ": "JWT"}).encode())
        payload = b64url(json.dumps(body).encode())
        sig = b64url(self.private.sign(f"{head}.{payload}".encode()))
        return f"{head}.{payload}.{sig}"


FAKE_CLAUDE = r"""#!/usr/bin/env python3
import json, sys, pathlib, os
args = sys.argv[1:]
assert "--max-budget-usd" in args and "--permission-mode" in args
assert "EDEN_RUN_TOKEN" not in os.environ
assert os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant-")
mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
def say(obj): print(json.dumps(obj), flush=True)
say({{"type": "system", "subtype": "init", "session_id": "s1", "cwd": os.getcwd(), "model": "claude-test"}})
say({{"type": "assistant", "message": {{"content": [{{"type": "text", "text": "Adding hello.txt"}},
    {{"type": "tool_use", "id": "t1", "name": "Write", "input": {{"file_path": "hello.txt", "content": "hi"}}}}]}}}})
pathlib.Path("hello.txt").write_text("hi\n")
if mode == "risky":
    pathlib.Path(".mcp.json").write_text("{{}}")
say({{"type": "user", "message": {{"content": [{{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}]}}}})
if mode == "spend":
    say({{"type": "result", "subtype": "success", "total_cost_usd": 99.0, "usage": {{}}, "duration_ms": 10}})
    import time; time.sleep(30)
say({{"type": "result", "subtype": "success", "total_cost_usd": 0.12, "usage": {{"input_tokens": 10, "output_tokens": 5}}, "duration_ms": 1200}})
"""


def fake_claude(folder: Path) -> Path:
    path = folder / "claude"
    path.write_text(FAKE_CLAUDE.format())
    path.chmod(0o755)
    return path


def git(cwd, *args):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "T",
        "GIT_AUTHOR_EMAIL": "t@x",
        "GIT_COMMITTER_NAME": "T",
        "GIT_COMMITTER_EMAIL": "t@x",
    }
    return (
        subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, check=True)
        .stdout.decode()
        .strip()
    )


def repo_with_bundle(folder: Path, branch="feature") -> tuple[Path, str, bytes]:
    repo = folder / "src"
    repo.mkdir()
    git(repo, "init", "-q", "-b", branch)
    (repo / "README.md").write_text("hello\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "first")
    head = git(repo, "rev-parse", "HEAD")
    bundle = folder / "src.bundle"
    git(repo, "bundle", "create", str(bundle), f"refs/heads/{branch}")
    return repo, head, bundle.read_bytes()


def thread_http(client: httpx.AsyncClient, loop: asyncio.AbstractEventLoop):
    """The runner's http(), from its thread, through the app in the test's loop."""

    def http(method, url, body, headers):
        path = url.split("://", 1)[-1].split("/", 1)[1]
        future = asyncio.run_coroutine_threadsafe(
            client.request(method, "/" + path, content=body, headers=headers), loop
        )
        response = future.result(timeout=60)
        return response.status_code, response.content

    return http


def start_runner(launch, client, loop, work: Path, claude: Path, extra=None):
    import eden_runner

    env = {**launch.env, "EDEN_CLAUDE_BIN": str(claude), **(extra or {})}
    done = {}

    def go():
        done["code"] = eden_runner.main(env=env, http=thread_http(client, loop), work=work)

    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    return thread, done
