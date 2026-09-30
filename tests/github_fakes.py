"""A GitHub of the tests' own, behind httpx.MockTransport: repositories, pull requests,
checks, statuses, reviews, comments, issues and their events, merges and job logs, kept in
dicts. Nothing ever leaves the machine; every request is recorded."""

import json
import re
from typing import Any

import httpx

API = "https://api.github.com"
LOGS = "https://results.example-logs.test"


class FakeGitHub:
    def __init__(self, login: str = "octo-owner") -> None:
        self.login = login
        self.repos: dict[str, dict[str, Any]] = {
            "acme/app": {
                "full_name": "acme/app",
                "default_branch": "main",
                "allow_squash_merge": True,
                "allow_merge_commit": True,
                "allow_rebase_merge": False,
                "html_url": "https://github.com/acme/app",
            }
        }
        self.pulls: dict[tuple[str, int], dict[str, Any]] = {}
        self.next_number = 7
        self.runs: dict[str, list[dict[str, Any]]] = {}  # sha -> check runs
        self.statuses: dict[str, list[dict[str, Any]]] = {}  # sha -> statuses
        self.reviews: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self.review_comments: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self.issue_comments: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self.issues: dict[tuple[str, int], dict[str, Any]] = {}
        self.events: dict[str, list[dict[str, Any]]] = {}  # repo -> newest first
        self.logs: dict[int, str] = {}  # job id -> its log
        self.requests: list[httpx.Request] = []
        self.fail: dict[tuple[str, str], tuple[int, dict[str, Any], dict[str, str]]] = {}
        self.merged: list[dict[str, Any]] = []
        self.remaining = 4999
        self.ids = iter(range(1000, 10**6))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    # ── making things ──

    def add_pull(self, repo: str, head: str, base: str = "main", sha: str = "abc123", **extra):
        number = self.next_number
        self.next_number += 1
        self.pulls[(repo, number)] = {
            "number": number,
            "title": extra.pop("title", f"PR {number}"),
            "body": "",
            "state": "open",
            "draft": False,
            "merged": False,
            "mergeable": True,
            "mergeable_state": "clean",
            "html_url": f"https://github.com/{repo}/pull/{number}",
            "head": {"ref": head, "sha": sha},
            "base": {"ref": base, "sha": "base000"},
            "user": {"login": self.login},
            **extra,
        }
        return self.pulls[(repo, number)]

    def run(self, sha: str, name: str, status: str = "completed", conclusion: str | None = "success",
            actions: bool = True, run_id: int | None = None, title: str = "") -> dict[str, Any]:  # fmt: skip
        entry = {
            "id": run_id if run_id is not None else next(self.ids),
            "name": name,
            "status": status,
            "conclusion": conclusion if status == "completed" else None,
            "html_url": f"https://github.com/acme/app/runs/{name}",
            "app": {"slug": "github-actions" if actions else "circleci"},
            "output": {"title": title},
        }
        self.runs.setdefault(sha, [])
        self.runs[sha] = [r for r in self.runs[sha] if r["name"] != name] + [entry]
        return entry

    def comment(self, repo: str, number: int, body: str, login: str, *, review: bool = False,
                association: str = "COLLABORATOR", path: str = "", line: int = 0) -> dict[str, Any]:  # fmt: skip
        entry = {
            "id": next(self.ids),
            "body": body,
            "user": {"login": login},
            "author_association": association,
            "created_at": "2026-09-29T10:00:00Z",
            "html_url": f"https://github.com/{repo}/pull/{number}#c",
        }
        if review:
            entry.update({"path": path, "line": line or None, "original_line": line or None})
            self.review_comments.setdefault((repo, number), []).append(entry)
        else:
            self.issue_comments.setdefault((repo, number), []).append(entry)
        return entry

    # ── answering ──

    def reply(self, status: int, data: Any = None, headers: dict[str, str] | None = None):
        head = {
            "x-ratelimit-remaining": str(self.remaining),
            "x-ratelimit-reset": "4102444800",
            **(headers or {}),
        }
        if data is None:
            return httpx.Response(status, headers=head)
        return httpx.Response(status, json=data, headers=head)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = request.url
        if str(url).startswith(LOGS):
            job = int(url.path.rsplit("/", 1)[-1])
            text = self.logs.get(job, "")
            return httpx.Response(200, text=text)
        path = url.path
        method = request.method
        if (method, path) in self.fail:
            status, data, headers = self.fail[(method, path)]
            return self.reply(status, data, headers)
        if path == "/user":
            return self.reply(200, {"login": self.login})
        m = re.match(r"^/repos/([^/]+/[^/]+)(/.*)?$", path)
        if not m:
            return self.reply(404, {"message": "Not Found"})
        repo, rest = m.group(1), m.group(2) or ""
        if repo not in self.repos:
            return self.reply(404, {"message": "Not Found"})
        if rest == "" and method == "GET":
            return self.reply(200, self.repos[repo])
        if rest == "/pulls" and method == "GET":
            head = url.params.get("head", "")
            state = url.params.get("state", "open")
            found = [
                p for (r, _n), p in self.pulls.items()
                if r == repo and (not head or f"{repo.split('/')[0]}:{p['head']['ref']}" == head)
                and (state == "all" or p["state"] == state)
            ]  # fmt: skip
            return self.reply(200, sorted(found, key=lambda p: -p["number"]))
        if rest == "/pulls" and method == "POST":
            body = json.loads(request.content)
            for (r, _n), p in self.pulls.items():
                if r == repo and p["head"]["ref"] == body["head"] and p["state"] == "open":
                    return self.reply(422, {"message": "Validation Failed", "errors": [
                        {"message": f"A pull request already exists for acme:{body['head']}."}]})  # fmt: skip
            pull = self.add_pull(repo, body["head"], body["base"], sha="head1",
                                 title=body["title"], body=body["body"], draft=body.get("draft", False))  # fmt: skip
            return self.reply(201, pull)
        m = re.match(r"^/pulls/(\d+)(/.*)?$", rest)
        if m:
            number, tail = int(m.group(1)), m.group(2) or ""
            pull = self.pulls.get((repo, number))
            if pull is None:
                return self.reply(404, {"message": "Not Found"})
            if tail == "" and method == "GET":
                return self.reply(200, pull)
            if tail == "/reviews":
                return self.reply(200, self.reviews.get((repo, number), []))
            if tail == "/comments":
                return self.reply(200, self.review_comments.get((repo, number), []))
            if tail == "/merge" and method == "PUT":
                body = json.loads(request.content)
                if body.get("sha") != pull["head"]["sha"]:
                    return self.reply(
                        409,
                        {"message": "Head branch was modified. Review and try the merge again."},
                    )
                pull.update(state="closed", merged=True)
                self.merged.append({"number": number, **body})
                return self.reply(
                    200,
                    {
                        "merged": True,
                        "sha": "merged1",
                        "message": "Pull Request successfully merged",
                    },
                )
        m = re.match(r"^/commits/([^/]+)/(check-runs|status)$", rest)
        if m:
            sha, what = m.group(1), m.group(2)
            if what == "check-runs":
                runs = self.runs.get(sha, [])
                return self.reply(200, {"total_count": len(runs), "check_runs": runs})
            statuses = self.statuses.get(sha, [])
            return self.reply(200, {"state": "pending", "statuses": statuses})
        m = re.match(r"^/issues/(\d+)(/comments)?$", rest)
        if m:
            number = int(m.group(1))
            if m.group(2):
                return self.reply(200, self.issue_comments.get((repo, number), []))
            issue = self.issues.get((repo, number))
            return self.reply(200, issue) if issue else self.reply(404, {"message": "Not Found"})
        if rest == "/issues/events":
            return self.reply(200, self.events.get(repo, []))
        m = re.match(r"^/actions/jobs/(\d+)/logs$", rest)
        if m:
            job = int(m.group(1))
            if job not in self.logs:
                return self.reply(404, {"message": "Not Found"})
            return httpx.Response(302, headers={"location": f"{LOGS}/logs/{job}"})
        m = re.match(r"^/check-runs/(\d+)/annotations$", rest)
        if m:
            return self.reply(200, [])
        return self.reply(404, {"message": "Not Found"})

    def sent(self, method: str = "", path: str = "") -> list[httpx.Request]:
        return [
            r for r in self.requests
            if (not method or r.method == method) and (not path or r.url.path == path)
        ]  # fmt: skip
