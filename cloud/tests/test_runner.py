"""The runner on its own: Claude Code's arguments, and a service that says stop."""

from __future__ import annotations

import json

import eden_runner
from fakes import fake_claude, repo_with_bundle


def test_claude_runs_bypassed_with_a_budget_and_the_model():
    args = eden_runner.claude_args(
        {"brief": "do it", "budget_usd": 3, "model": "claude-x"}, "claude"
    )
    assert args[:3] == ["claude", "-p", "do it"]
    assert args[args.index("--permission-mode") + 1] == "bypassPermissions"
    assert args[args.index("--max-budget-usd") + 1] == "3.00"
    assert args[args.index("--model") + 1] == "claude-x"
    assert "--model" not in eden_runner.claude_args({"brief": "x"}, "claude")


def test_a_stop_from_the_service_ends_it_and_says_so(tmp_path):
    _repo, head, bundle = repo_with_bundle(tmp_path)
    calls = []

    def http(method, url, body, headers):
        path = url.rsplit("/", 1)[1]
        calls.append((method, path))
        assert headers["Authorization"] == "Bearer ert1.token"
        if path == "job":
            job = {
                "id": "r",
                "title": "t",
                "brief": "b",
                "model": "",
                "budget_usd": 1,
                "max_minutes": 5,
                "source": {"kind": "bundle", "branch": "feature", "base": head, "url": ""},
            }
            return 200, json.dumps(job).encode()
        if path == "source":
            return 200, bundle
        if path == "events":
            return 200, b'{"seq": 1, "stop": true}'
        return 200, b"{}"

    work = tmp_path / "work"
    work.mkdir()
    env = {
        "EDEN_RUN_URL": "https://cloud",
        "EDEN_RUN_ID": "r",
        "EDEN_RUN_TOKEN": "ert1.token",
        "ANTHROPIC_API_KEY": "sk-ant-x",
        "EDEN_CLAUDE_BIN": str(fake_claude(tmp_path)),
    }
    assert eden_runner.main(env=env, http=http, work=work) == 1
    assert ("POST", "done") in calls and ("PUT", "result") in calls  # its work so far comes back
    assert not (work / "repo").exists()  # and its checkout is deleted


def test_a_service_that_refuses_ends_it(tmp_path):
    def http(method, url, body, headers):
        return 401, b'{"code": "signed_out"}'

    env = {"EDEN_RUN_URL": "https://cloud", "EDEN_RUN_ID": "r", "EDEN_RUN_TOKEN": "t"}
    assert eden_runner.main(env=env, http=http, work=tmp_path) == 1
