"""The runner: what runs inside each Eden Cloud machine, once, for one run.

It knows only its environment: EDEN_RUN_URL (the service), EDEN_RUN_ID, EDEN_RUN_TOKEN (good
for this run, while it lives) and ANTHROPIC_API_KEY (the user's own). It

1. fetches its job (the brief, model, budget, time left and where the code is) from the
   service, then the code: the run's git bundle from the service, or a clone of a public
   https remote's branch;
2. runs Claude Code on the brief in that checkout (claude -p, stream-json, Bypass
   permissions: the machine is the sandbox, and nobody is there to answer a card), sending
   every line it prints back to the service, a batch a second;
3. commits whatever it changed (as "Eden Cloud"), and sends back the branch past the commit
   it started from as a git bundle, and the diff;
4. says it's done (its exit code), and exits; the service then deletes the machine.

The service can say stop (a cancel, the time limit, the budget) in its answer to any batch:
Claude Code is stopped then. Standard library only, so the image needs nothing but Python,
git and the Claude Code CLI. The run's token is not passed on to Claude Code's environment.

Cost policy: Claude Code calls Anthropic with the user's own key, capped by --max-budget-usd.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

Http = Callable[[str, str, bytes | None, dict[str, str]], tuple[int, bytes]]
BATCH_SECONDS = 1.0
BATCH_LINES = 200
DIFF_MAX = 20 << 20
IDENTITY = {
    "GIT_AUTHOR_NAME": "Eden Cloud",
    "GIT_AUTHOR_EMAIL": "cloud@askeden.com",
    "GIT_COMMITTER_NAME": "Eden Cloud",
    "GIT_COMMITTER_EMAIL": "cloud@askeden.com",
    "GIT_TERMINAL_PROMPT": "0",
}
NOTE = (
    "You are running in Eden Cloud: a fresh machine with this repository checked out, and no "
    "one watching to answer questions. Do the task as asked, check your work (run the tests "
    "if there are any), and finish with a short summary of what you changed and how you "
    "checked it. Don't push or open pull requests: when you finish, your changes are "
    "committed and sent back to the owner's Mac for review."
)


def urllib_http(
    method: str, url: str, body: bytes | None, headers: dict[str, str]
) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


class Api:
    def __init__(self, base: str, run_id: str, token: str, http: Http = urllib_http) -> None:
        self.base = base.rstrip("/") + f"/v1/runner/{run_id}"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.http = http

    def call(self, method: str, path: str, body: bytes | None = None, kind: str = "") -> bytes:
        headers = dict(self.headers)
        if kind:
            headers["Content-Type"] = kind
        for attempt in range(5):
            try:
                status, data = self.http(method, f"{self.base}/{path}", body, headers)
            except OSError:
                status, data = 0, b""
            if 200 <= status < 300:
                return data
            if status in (400, 401, 403, 404, 409, 413):
                raise RuntimeError(f"{path}: the service said {status}")
            time.sleep(min(10, 2**attempt))
        raise RuntimeError(f"{path}: the service couldn't be reached")

    def json(self, method: str, path: str, body: Any = None) -> Any:
        data = self.call(
            method, path, None if body is None else json.dumps(body).encode(), "application/json"
        )
        return json.loads(data or b"{}")


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    env = {**os.environ, **IDENTITY}
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *args],
        cwd=repo, env=env, capture_output=True, check=check, timeout=600,
    )  # fmt: skip


def fetch_code(job: dict[str, Any], api: Api, work: Path) -> tuple[Path, str]:
    """The checkout, on the job's branch, and the commit it starts from."""
    source = job["source"]
    repo = work / "repo"
    branch = source["branch"]
    if source["kind"] == "bundle":
        bundle = work / "source.bundle"
        bundle.write_bytes(api.call("GET", "source"))
        git(
            work, "clone", "-q", "--branch", branch, "--single-branch", "--", str(bundle), str(repo)
        )
        bundle.unlink()
    else:
        git(work, "clone", "-q", "--depth", "50", "--branch", branch, "--single-branch", "--",
            source["url"], str(repo))  # fmt: skip
    base = git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    if source.get("base") and source["base"] != base:
        if git(repo, "cat-file", "-e", source["base"] + "^{commit}", check=False).returncode:
            raise RuntimeError("The branch doesn't have the commit the run starts from.")
        git(repo, "checkout", "-q", "-B", branch, source["base"])
        base = source["base"]
    return repo, base


def claude_args(job: dict[str, Any], claude: str) -> list[str]:
    args = [
        claude, "-p", job["brief"],
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "bypassPermissions",
        "--max-budget-usd", f"{float(job.get('budget_usd') or 1):.2f}",
        "--append-system-prompt", NOTE,
    ]  # fmt: skip
    if job.get("model"):
        args += ["--model", job["model"]]
    return args


def run_claude(
    job: dict[str, Any], repo: Path, api: Api, claude: str, given: dict[str, str] | None = None
) -> int:
    merged = {**os.environ, **(given or {})}
    env = {k: v for k, v in merged.items() if k != "EDEN_RUN_TOKEN"}
    env.update(IDENTITY)
    env["IS_SANDBOX"] = "1"  # (Claude Code's own flag for running bypassed in a container)
    proc = subprocess.Popen(
        claude_args(job, claude),
        cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, bufsize=1, text=True, errors="replace",
    )  # fmt: skip
    lines: queue.Queue[str | None] = queue.Queue()

    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.put(line.rstrip("\n"))
        lines.put(None)

    threading.Thread(target=read, daemon=True).start()
    deadline = time.time() + max(1, int(job.get("max_minutes") or 30)) * 60
    batch: list[str] = []
    last = time.time()
    ended = False
    while not ended:
        try:
            line = lines.get(timeout=BATCH_SECONDS)
        except queue.Empty:
            line = ""
        if line is None:
            ended = True
        elif line:
            batch.append(line)
        if batch and (ended or len(batch) >= BATCH_LINES or time.time() - last >= BATCH_SECONDS):
            answer = send_lines(api, batch)
            batch, last = [], time.time()
            if answer.get("stop"):
                proc.kill()
                proc.wait()
                return -9
        if time.time() > deadline:
            proc.kill()
            proc.wait()
            return -14
    return proc.wait()


def send_lines(api: Api, batch: list[str]) -> dict[str, Any]:
    data = api.call("POST", "events", ("\n".join(batch) + "\n").encode(), "application/x-ndjson")
    return json.loads(data or b"{}")


def send_back(job: dict[str, Any], repo: Path, base: str, api: Api, work: Path) -> None:
    branch = job["source"]["branch"]
    if git(repo, "status", "--porcelain").stdout.strip():
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"Eden Cloud: {job.get('title') or 'run'}"[:200])
    head = git(repo, "rev-parse", "HEAD").stdout.decode().strip()
    if head == base:
        return
    bundle = work / "result.bundle"
    git(repo, "bundle", "create", str(bundle), f"refs/heads/{branch}", f"^{base}")
    api.call("PUT", "result", bundle.read_bytes(), "application/octet-stream")
    bundle.unlink()
    diff = git(repo, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, head).stdout
    api.call("PUT", "diff", diff[:DIFF_MAX], "text/plain")


def main(
    env: dict[str, str] | None = None,
    http: Http = urllib_http,
    work: Path | None = None,
) -> int:
    env = dict(os.environ if env is None else env)
    api = Api(env["EDEN_RUN_URL"], env["EDEN_RUN_ID"], env["EDEN_RUN_TOKEN"], http)
    work = Path(work or env.get("EDEN_RUN_WORK") or "/work")
    claude = env.get("EDEN_CLAUDE_BIN") or shutil.which("claude") or "claude"
    code, error = 1, ""
    try:
        job = api.json("GET", "job")
        repo, base = fetch_code(job, api, work)
        code = run_claude(job, repo, api, claude, env)
        if code == 0:
            send_back(job, repo, base, api, work)
        elif code == -14:
            error = "It ran out of time."
        else:
            # Its work so far still comes back, to look at: a stop isn't a loss.
            try:
                send_back(job, repo, base, api, work)
            except Exception:  # noqa: BLE001
                pass
            error = f"Claude Code ended with {code}."
    except subprocess.CalledProcessError as exc:
        error = f"git failed: {(exc.stderr or b'').decode(errors='replace').strip()[-300:]}"
    except Exception as exc:  # noqa: BLE001
        error = str(exc)[:500]
    try:
        api.json("POST", "done", {"exit_code": code, "error": error})
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(work / "repo", ignore_errors=True)
    return 0 if code == 0 and not error else 1


if __name__ == "__main__":
    sys.exit(main())
