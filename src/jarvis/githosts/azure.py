"""Azure DevOps (Azure Repos and Pipelines) for Eden Code: pull requests, their builds and
statuses, comment threads and completing them, through the REST API (7.1). Answers come
back in GitHub's shapes (base.py says why).

What maps to what:
- a pull request is one (active is open, completed merged, abandoned closed); its source
  commit is the head, and mergeStatus says whether it can merge (conflicts is dirty);
- its checks: the newest build of each pipeline that ran for it (a build for the pull
  request's merge ref, on its head commit, or one on the branch itself at that commit),
  each a check run whose failing tasks' logs can be read; and the pull request's own
  statuses (other services') as statuses;
- a thread on a file is review comments, any other thread the conversation (Azure DevOps'
  own system comments are left out); a reviewer's vote is a review (10 and 5 approve, -10
  rejects);
- who may write: Azure DevOps has no plain way to ask what someone else may do, so only
  the token's own user's comments count by themselves; anyone else's are listed in the
  pane with a Send button.

Completing (merging) names the commit the checks passed on (lastMergeSourceCommit): Azure
DevOps refuses it if the branch has moved since.

Who Eden is on Azure DevOps: the personal access token pasted in Eden Code settings (Code
read and write, Build read), sent as Basic; else, with the Azure CLI installed and signed
in, a token az gives for Azure DevOps (base.cli_token), sent as Bearer.

Nothing here calls a model, and nothing is sent anywhere but the organisation's Azure
DevOps address (dev.azure.com, or its older visualstudio.com one).
"""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from .. import github
from .base import LOG_TAIL, HostRef, RestClient, number, stable_id

VERSION = "7.1"
STATES = {"active": "open", "completed": "closed", "abandoned": "closed"}
RESULTS = {"succeeded": "success", "partiallySucceeded": "neutral", "failed": "failure",
           "canceled": "cancelled"}  # fmt: skip
STATUS = {"succeeded": "success", "failed": "failure", "error": "failure",
          "pending": "pending", "notSet": "pending"}  # fmt: skip
STRATEGIES = {"squash": "squash", "merge": "noFastForward", "rebase": "rebase"}
LOGS_READ = 3  # failing tasks whose logs are read for one build


def _branch(ref_name: Any) -> str:
    text = str(ref_name or "")
    return text[len("refs/heads/") :] if text.startswith("refs/heads/") else text


def pull_from(pr: dict[str, Any], ref: HostRef) -> dict[str, Any]:
    """An Azure DevOps pull request in a GitHub pull request's shape."""
    n = number(pr.get("pullRequestId"))
    status = str(pr.get("status") or "")
    merge = str(pr.get("mergeStatus") or "")
    creator = pr.get("createdBy") if isinstance(pr.get("createdBy"), dict) else {}
    return {
        "number": n,
        "title": str(pr.get("title") or ""),
        "body": str(pr.get("description") or ""),
        "html_url": ref.pull_url(n) if n else "",
        "state": STATES.get(status, "open"),
        "merged": status == "completed",
        "draft": bool(pr.get("isDraft")),
        "head": {"ref": _branch(pr.get("sourceRefName")),
                 "sha": str((pr.get("lastMergeSourceCommit") or {}).get("commitId") or "")},
        "base": {"ref": _branch(pr.get("targetRefName")),
                 "sha": str((pr.get("lastMergeTargetCommit") or {}).get("commitId") or "")},
        "mergeable_state": {"succeeded": "clean", "conflicts": "dirty",
                            "rejectedByPolicy": "blocked"}.get(merge, "unknown" if merge else ""),
        "mergeable": False if merge == "conflicts" else None,
        "user": {"login": str(creator.get("uniqueName") or "")},
    }  # fmt: skip


def build_run(build: dict[str, Any]) -> dict[str, Any]:
    status = str(build.get("status") or "")
    return {
        "id": number(build.get("id")),
        "name": str((build.get("definition") or {}).get("name") or "build"),
        "status": "completed" if status == "completed" else "in_progress",
        "conclusion": RESULTS.get(str(build.get("result") or "")),
        "html_url": str(((build.get("_links") or {}).get("web") or {}).get("href") or ""),
        "app": {"slug": "azure-pipelines"},
        "output": {"title": str(build.get("buildNumber") or "")},
    }


class AzureClient(RestClient):
    kind = "azure"

    def __init__(self, token: Any, *, host: str = "dev.azure.com", **kw: Any) -> None:
        super().__init__(token, host=host, **kw)
        self._heads: dict[str, tuple[int, str]] = {}  # head sha -> (pull request, branch)
        self._reviewers: dict[tuple[str, int], list[dict[str, Any]]] = {}  # from the last read
        self._last: HostRef | None = None  # a repository asked about (its organisation: login)

    def auth(self, token: str) -> dict[str, str]:
        if token.startswith("Bearer "):
            return {"Authorization": token}
        raw = base64.b64encode(f":{token}".encode()).decode("ascii")
        return {"Authorization": f"Basic {raw}"}

    def base(self, ref: HostRef) -> str:
        org, _, project = ref.owner.partition("/")
        project = quote(project, safe="")
        if self.host == "dev.azure.com":
            return f"https://dev.azure.com/{quote(org, safe='')}/{project}/_apis"
        return f"https://{self.host}/{project}/_apis"

    def _git(self, ref: HostRef) -> str:
        return f"{self.base(ref)}/git/repositories/{quote(ref.name, safe='')}"

    async def call(self, method: str, url: str, ref: HostRef, *, params: dict[str, Any] | None = None,
                   body: Any = None) -> Any:  # fmt: skip
        self._last = ref
        return await self.request(
            method, url, params={"api-version": VERSION, **(params or {})}, body=body,
            repo=ref.full,
        )  # fmt: skip

    async def listed(self, url: str, ref: HostRef, params: dict[str, Any] | None = None) -> list:
        found = await self.call("GET", url, ref, params=params)
        rows = (found or {}).get("value") if isinstance(found, dict) else None
        return [r for r in rows or [] if isinstance(r, dict)]

    # ── who ──

    async def login(self, ref: HostRef | None = None) -> str:
        """The token's own user's sign-in name (as comments name their authors), asked of
        the organisation of the repository (or the last one asked about)."""
        ref = ref or self._last
        if not self._login and ref is not None:
            org = ref.owner.partition("/")[0]
            where = (f"https://dev.azure.com/{quote(org, safe='')}" if self.host == "dev.azure.com"
                     else f"https://{self.host}")  # fmt: skip
            found = await self.request("GET", f"{where}/_apis/connectionData", repo=ref.full) or {}
            user = found.get("authenticatedUser") if isinstance(found, dict) else {}
            account = ((user or {}).get("properties") or {}).get("Account") or {}
            self._login = str(account.get("$value") or "")
        return self._login

    async def may(self, ref: HostRef, login: str, least: str) -> bool:
        """Only the token's own user, for certain (base docstring above says why)."""
        if not login:
            return False
        try:
            return login.lower() == (await self.login(ref)).lower()
        except github.RateLimited:
            raise
        except github.GitHubError:
            return False

    # ── the repository and its pull requests ──

    async def repo(self, ref: HostRef) -> dict[str, Any]:
        found = await self.call("GET", self._git(ref), ref) or {}
        return {
            "full_name": ref.full,
            "default_branch": _branch(found.get("defaultBranch")),
            "html_url": ref.url,
            "allow_squash_merge": True,
            "allow_merge_commit": True,
            "allow_rebase_merge": True,
        }

    def _keep(self, pull: dict[str, Any]) -> dict[str, Any]:
        if pull["head"]["sha"] and pull["number"]:
            self._heads[pull["head"]["sha"]] = (pull["number"], pull["head"]["ref"])
            while len(self._heads) > 400:
                self._heads.pop(next(iter(self._heads)))
        return pull

    async def pulls_for(self, ref: HostRef, branch: str, state: str = "open") -> list[dict]:
        rows = await self.listed(
            f"{self._git(ref)}/pullrequests", ref,
            {"searchCriteria.sourceRefName": f"refs/heads/{branch}",
             "searchCriteria.status": "active" if state == "open" else "all", "$top": 10},
        )  # fmt: skip
        return [self._keep(pull_from(r, ref)) for r in rows]

    async def create_pull(
        self, ref: HostRef, *, title: str, head: str, base: str, body: str, draft: bool = False
    ) -> dict[str, Any]:
        data = {
            "sourceRefName": f"refs/heads/{head}",
            "targetRefName": f"refs/heads/{base}",
            "title": title,
            "description": body[:4000],  # (Azure DevOps' own limit)
            "isDraft": bool(draft),
        }
        try:
            made = await self.call("POST", f"{self._git(ref)}/pullrequests", ref, body=data)
        except github.GitHubError as exc:
            if exc.status == 409 and "already exists" in str(exc).lower():
                raise github.GitHubError(str(exc), 422) from exc
            raise
        return self._keep(pull_from(made or {}, ref))

    async def update_pull(self, ref: HostRef, number_: int, *, body: str) -> dict[str, Any]:
        found = await self.call(
            "PATCH", f"{self._git(ref)}/pullrequests/{number_}", ref, body={"description": body[:4000]}
        )
        return pull_from(found or {}, ref)

    async def retarget(self, ref: HostRef, number_: int, base: str) -> dict[str, Any]:
        found = await self.call(
            "PATCH", f"{self._git(ref)}/pullrequests/{number_}", ref,
            body={"targetRefName": f"refs/heads/{base}"},
        )  # fmt: skip
        return pull_from(found or {}, ref)

    async def pull(self, ref: HostRef, number_: int) -> dict[str, Any]:
        raw = await self.call("GET", f"{self._git(ref)}/pullrequests/{number_}", ref) or {}
        self._reviewers[(ref.full, number_)] = [
            r for r in raw.get("reviewers") or [] if isinstance(r, dict)
        ]
        return self._keep(pull_from(raw, ref))

    async def check_runs(self, ref: HostRef, sha: str) -> list[dict[str, Any]]:
        """The newest build of each pipeline that ran on the head commit: for the pull
        request (its merge ref) and on the branch itself."""
        if not sha:
            return []
        n, branch = self._heads.get(sha, (0, ""))
        builds: list[dict[str, Any]] = []
        if n:
            for b in await self.listed(
                f"{self.base(ref)}/build/builds", ref,
                {"branchName": f"refs/pull/{n}/merge", "queryOrder": "queueTimeDescending", "$top": 30},
            ):  # fmt: skip
                said = str((b.get("triggerInfo") or {}).get("pr.sourceSha") or "")
                if not said or said == sha:
                    builds.append(b)
        if branch:
            builds += [
                b for b in await self.listed(
                    f"{self.base(ref)}/build/builds", ref,
                    {"branchName": f"refs/heads/{branch}", "queryOrder": "queueTimeDescending", "$top": 30},
                ) if str(b.get("sourceVersion") or "") == sha
            ]  # fmt: skip
        newest: dict[str, dict[str, Any]] = {}
        for b in builds:  # (newest first: the first of each pipeline is its latest)
            newest.setdefault(str((b.get("definition") or {}).get("name") or b.get("id")), b)
        return [build_run(b) for b in newest.values()]

    async def statuses(self, ref: HostRef, sha: str) -> list[dict[str, Any]]:
        """The pull request's own statuses (other services'), the latest of each."""
        n, _branch_name = self._heads.get(sha, (0, ""))
        if not n:
            return []
        rows = await self.listed(f"{self._git(ref)}/pullrequests/{n}/statuses", ref)
        latest: dict[str, dict[str, Any]] = {}
        for row in sorted(rows, key=lambda r: number(r.get("id")), reverse=True):
            context = row.get("context") if isinstance(row.get("context"), dict) else {}
            name = "/".join(p for p in (context.get("genre"), context.get("name")) if p) or "status"
            state = str(row.get("state") or "")
            if name in latest or state == "notApplicable":
                continue
            latest[name] = {
                "context": name,
                "state": STATUS.get(state, "failure"),
                "target_url": str(row.get("targetUrl") or ""),
                "description": str(row.get("description") or ""),
            }
        return list(latest.values())

    async def job_log(self, ref: HostRef, job_id: int) -> str:
        """The failing tasks' logs of a build (the first LOGS_READ, their ends)."""
        found = await self.call("GET", f"{self.base(ref)}/build/builds/{int(job_id)}/timeline", ref)
        records = [r for r in (found or {}).get("records") or [] if isinstance(r, dict)]
        failed = [r for r in records if r.get("result") == "failed" and (r.get("log") or {}).get("id")]
        failed.sort(key=lambda r: r.get("type") != "Task")  # (a task's own log first)
        parts = []
        for record in failed[:LOGS_READ]:
            log_id = number((record.get("log") or {}).get("id"))
            response = await self.send(
                "GET", f"{self.base(ref)}/build/builds/{int(job_id)}/logs/{log_id}",
                params={"api-version": VERSION}, repo=ref.full, headers={"Accept": "text/plain"},
            )  # fmt: skip
            parts.append(f"── {record.get('name') or 'task'} ──\n{response.text[-LOG_TAIL // LOGS_READ:]}")
        return "\n".join(parts)

    async def _threads(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        rows = []
        for thread in await self.listed(f"{self._git(ref)}/pullrequests/{number_}/threads", ref):
            if thread.get("isDeleted"):
                continue
            context = thread.get("threadContext") if isinstance(thread.get("threadContext"), dict) else {}
            start = context.get("rightFileStart") if isinstance(context.get("rightFileStart"), dict) else {}
            tid = number(thread.get("id"))
            for c in thread.get("comments") or []:
                if not isinstance(c, dict) or c.get("isDeleted") or c.get("commentType") == "system":
                    continue
                author = c.get("author") if isinstance(c.get("author"), dict) else {}
                rows.append({
                    "id": tid * 1000 + number(c.get("id")),
                    "user": {"login": str(author.get("uniqueName") or "")},
                    "author_association": "COLLABORATOR",  # (only "ask": may() decides)
                    "path": str(context.get("filePath") or "").lstrip("/"),
                    "line": number(start.get("line")),
                    "body": str(c.get("content") or ""),
                    "html_url": f"{ref.pull_url(number_)}?discussionId={tid}",
                    "created_at": str(c.get("publishedDate") or ""),
                    "inline": bool(context.get("filePath")),
                })  # fmt: skip
        return rows

    async def review_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        return [c for c in await self._threads(ref, number_) if c["inline"]]

    async def issue_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        return [c for c in await self._threads(ref, number_) if not c["inline"]]

    async def reviews(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        rows = []
        for r in self._reviewers.get((ref.full, number_), []):
            vote = number(r.get("vote"))
            state = "APPROVED" if vote >= 5 else "CHANGES_REQUESTED" if vote <= -10 else ""
            login = str(r.get("uniqueName") or "")
            if state and login:
                rows.append({"id": stable_id(f"review:{number_}:{login}:{state}"),
                             "user": {"login": login}, "state": state, "body": "",
                             "author_association": "COLLABORATOR", "submitted_at": ""})  # fmt: skip
        return rows

    async def comment(self, ref: HostRef, number_: int, body: str) -> dict[str, Any]:
        made = await self.call(
            "POST", f"{self._git(ref)}/pullrequests/{number_}/threads", ref,
            body={"comments": [{"parentCommentId": 0, "content": body[:60_000], "commentType": 1}],
                  "status": "active"},
        )  # fmt: skip
        made = made if isinstance(made, dict) else {}
        first = next((c for c in made.get("comments") or [] if isinstance(c, dict)), {})
        # (its id as _threads gives it: the thread's and the comment's, so it's seen once)
        return {"id": number(made.get("id")) * 1000 + number(first.get("id") or 1),
                "html_url": ref.pull_url(number_)}  # fmt: skip

    async def merge(
        self, ref: HostRef, number_: int, *, method: str, sha: str, title: str = ""
    ) -> dict[str, Any]:
        options: dict[str, Any] = {"mergeStrategy": STRATEGIES.get(method, "squash")}
        if title:
            options["mergeCommitMessage"] = title[:250]
        return await self.call(
            "PATCH", f"{self._git(ref)}/pullrequests/{number_}", ref,
            body={"status": "completed", "lastMergeSourceCommit": {"commitId": sha},
                  "completionOptions": options},
        ) or {}  # fmt: skip
