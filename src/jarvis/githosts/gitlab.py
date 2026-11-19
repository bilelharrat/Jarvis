"""GitLab for Eden Code (gitlab.com, or a GitLab of the owner's own): merge requests,
their pipelines, discussions and merging, through GitLab's REST API (v4), and issues to
pick up. Answers come back in GitHub's shapes (base.py says why).

What maps to what:
- a merge request is a pull request: its iid is the number, source and target branches
  head and base, Draft: in front of the title is draft; detailed_merge_status says
  mergeable_state (mergeable is clean, a conflict is dirty, needs a rebase is behind,
  anything else blocked);
- the latest pipeline on a commit is its checks: each job one check run (its log readable,
  as an Actions job's is), a failing job that's allowed to fail neutral, a manual one
  skipped. A commit without a pipeline shows its commit statuses (another CI's) instead;
- a discussion's diff notes are review comments (file and line), its other notes the
  conversation; GitLab's own system notes ("added 1 commit") are left out; an approval is
  a review that approved;
- who may write: a project member at Developer or above (30).

Merging: once, at the commit the checks passed on (sha), squashed if the owner picked
squash and the project allows it. GitLab's "can't be merged now" (405, 406) is a refusal
for now, not a method the project forbids, so merging when green stays on.

Who Eden is on GitLab: the token pasted in Eden Code settings (read_api and api scopes),
else glab's when the GitLab CLI is installed and signed in (base.cli_token).

Nothing here calls a model, and nothing is sent anywhere but the GitLab named by the
remote.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .. import github
from .base import HostRef, RestClient, number, stable_id

PER_PAGE = 100
ROLE_FRESH = 600.0
LEVELS = {"read": 10, "triage": 20, "write": 30, "maintain": 40, "admin": 50}
DONE = ("success", "failed", "canceled", "skipped", "manual")
CONCLUSIONS = {"success": "success", "failed": "failure", "canceled": "cancelled",
               "skipped": "skipped", "manual": "skipped"}  # fmt: skip
MERGEABLE = {
    "mergeable": "clean",
    "conflict": "dirty",
    "need_rebase": "behind",
    "checking": "unknown",
    "unchecked": "unknown",
    "preparing": "unknown",
    "draft_status": "draft",
}


def _pid(ref: HostRef) -> str:
    return quote(ref.full, safe="")


def _draft(mr: dict[str, Any]) -> bool:
    return bool(mr.get("draft") or mr.get("work_in_progress"))


def pull_from(mr: dict[str, Any]) -> dict[str, Any]:
    """A merge request in a GitHub pull request's shape."""
    state = str(mr.get("state") or "")
    detail = str(mr.get("detailed_merge_status") or mr.get("merge_status") or "")
    conflicts = bool(mr.get("has_conflicts")) or detail == "conflict"
    refs = mr.get("diff_refs") if isinstance(mr.get("diff_refs"), dict) else {}
    author = mr.get("author") if isinstance(mr.get("author"), dict) else {}
    return {
        "number": number(mr.get("iid")),
        "title": str(mr.get("title") or ""),
        "body": str(mr.get("description") or ""),
        "html_url": str(mr.get("web_url") or ""),
        "state": "open" if state in ("opened", "locked") else "closed",
        "merged": state == "merged",
        "draft": _draft(mr),
        "head": {"ref": str(mr.get("source_branch") or ""), "sha": str(mr.get("sha") or "")},
        "base": {"ref": str(mr.get("target_branch") or ""), "sha": str(refs.get("base_sha") or "")},
        "mergeable_state": "dirty" if conflicts else MERGEABLE.get(detail, "blocked" if detail else ""),
        "mergeable": False if conflicts else None,
        "user": {"login": str(author.get("username") or "")},
    }  # fmt: skip


def run_from(job: dict[str, Any]) -> dict[str, Any]:
    """A pipeline job in a GitHub check run's shape."""
    status = str(job.get("status") or "")
    conclusion = CONCLUSIONS.get(status)
    if status == "failed" and job.get("allow_failure"):
        conclusion = "neutral"
    reason = str(job.get("failure_reason") or "").replace("_", " ")
    return {
        "id": number(job.get("id")),
        "name": str(job.get("name") or "job"),
        "status": "completed" if status in DONE else "in_progress",
        "conclusion": conclusion,
        "html_url": str(job.get("web_url") or ""),
        "app": {"slug": "gitlab-ci"},
        "output": {"title": reason},
    }


def status_run(row: dict[str, Any]) -> dict[str, Any]:
    """Another CI's commit status in a check run's shape (no log to read)."""
    status = str(row.get("status") or "")
    return run_from({**row, "status": status, "web_url": row.get("target_url")}) | {
        "id": 0,
        "app": {"slug": ""},
        "output": {"title": str(row.get("description") or "")},
    }


def note_from(note: dict[str, Any], web_url: str) -> dict[str, Any]:
    """A note in a GitHub comment's shape. Its author's say is asked (may) before anything
    of theirs goes to a session: COLLABORATOR here only means "ask"."""
    author = note.get("author") if isinstance(note.get("author"), dict) else {}
    position = note.get("position") if isinstance(note.get("position"), dict) else {}
    nid = number(note.get("id"))
    return {
        "id": nid,
        "user": {"login": str(author.get("username") or "")},
        "author_association": "COLLABORATOR",
        "path": str(position.get("new_path") or position.get("old_path") or ""),
        "line": number(position.get("new_line") or position.get("old_line")),
        "body": str(note.get("body") or ""),
        "html_url": f"{web_url}#note_{nid}" if web_url else "",
        "created_at": str(note.get("created_at") or ""),
    }


def issue_from(issue: dict[str, Any]) -> dict[str, Any]:
    """A GitLab issue in a GitHub issue's shape."""
    author = issue.get("author") if isinstance(issue.get("author"), dict) else {}
    return {
        "number": number(issue.get("iid")),
        "title": str(issue.get("title") or ""),
        "body": str(issue.get("description") or ""),
        "html_url": str(issue.get("web_url") or ""),
        "state": "open" if issue.get("state") == "opened" else "closed",
        "labels": [{"name": str(n)} for n in issue.get("labels") or [] if isinstance(n, str)],
        "user": {"login": str(author.get("username") or "")},
    }


class GitLabClient(RestClient):
    kind = "gitlab"

    def __init__(self, token: Any, *, host: str = "gitlab.com", **kw: Any) -> None:
        super().__init__(token, host=host, **kw)
        self.api = f"https://{host}/api/v4"
        self._roles: dict[tuple[str, str], tuple[int, float]] = {}
        self._web: dict[tuple[str, int], str] = {}  # a merge request's web address

    async def paged(self, path: str, params: dict[str, Any] | None = None, *, repo: str = "",
                    limit: int = 300) -> list[Any]:  # fmt: skip
        """Every page of a list (GitLab's x-next-page), up to limit items."""
        items: list[Any] = []
        query = {"per_page": PER_PAGE, **(params or {})}
        for _ in range(10):
            response = await self.send("GET", path, params=query, repo=repo)
            try:
                page = response.json()
            except ValueError:
                page = []
            items.extend(page if isinstance(page, list) else [])
            following = response.headers.get("x-next-page", "").strip()
            if len(items) >= limit or not following.isdigit():
                break
            query = {**query, "page": int(following)}
        return items[:limit]

    # ── who ──

    async def login(self) -> str:
        if not self._login:
            me = await self.request("GET", "/user")
            self._login = str((me or {}).get("username") or "")
        return self._login

    async def level(self, ref: HostRef, login: str) -> int:
        """A user's access level in the project (inherited from its groups too), 0 when
        they aren't a member. Kept ROLE_FRESH seconds."""
        key = (ref.full.lower(), login.lower())
        kept = self._roles.get(key)
        if kept is not None and self.clock() - kept[1] < ROLE_FRESH:
            return kept[0]
        rows = await self.request(
            "GET", f"/projects/{_pid(ref)}/members/all", params={"query": login, "per_page": 20},
            repo=ref.full,
        )  # fmt: skip
        found = next(
            (r for r in rows or [] if isinstance(r, dict)
             and str(r.get("username") or "").lower() == login.lower()), {},
        )  # fmt: skip
        level = number(found.get("access_level"))
        self._roles[key] = (level, self.clock())
        return level

    async def may(self, ref: HostRef, login: str, least: str) -> bool:
        """Whether login has at least that role (GitHub's names: write is Developer).
        False when GitLab can't say: never a guess."""
        if not login:
            return False
        try:
            return await self.level(ref, login) >= LEVELS.get(least, 30)
        except github.RateLimited:
            raise
        except github.GitHubError:
            return False

    # ── the project and its merge requests ──

    async def repo(self, ref: HostRef) -> dict[str, Any]:
        found = await self.request("GET", f"/projects/{_pid(ref)}", repo=ref.full) or {}
        squash = str(found.get("squash_option") or "default_off")
        return {
            "full_name": ref.full,
            "default_branch": str(found.get("default_branch") or ""),
            "html_url": str(found.get("web_url") or ref.url),
            "allow_squash_merge": squash != "never",
            "allow_merge_commit": squash != "always",
            "allow_rebase_merge": False,
        }

    def _keep(self, ref: HostRef, pull: dict[str, Any]) -> dict[str, Any]:
        if pull.get("number") and pull.get("html_url"):
            self._web[(ref.full, pull["number"])] = pull["html_url"]
        return pull

    async def pulls_for(self, ref: HostRef, branch: str, state: str = "open") -> list[dict]:
        found = await self.request(
            "GET", f"/projects/{_pid(ref)}/merge_requests",
            params={"source_branch": branch, "state": "opened" if state == "open" else state,
                    "order_by": "created_at", "sort": "desc", "per_page": 10},
            repo=ref.full,
        )  # fmt: skip
        return [self._keep(ref, pull_from(m)) for m in found or [] if isinstance(m, dict)]

    async def create_pull(
        self, ref: HostRef, *, title: str, head: str, base: str, body: str, draft: bool = False
    ) -> dict[str, Any]:
        data = {
            "source_branch": head,
            "target_branch": base,
            "title": f"Draft: {title}" if draft and not title.lower().startswith("draft:") else title,
            "description": body[:1_000_000],
            "remove_source_branch": False,
        }
        try:
            made = await self.request(
                "POST", f"/projects/{_pid(ref)}/merge_requests", body=data, repo=ref.full
            )
        except github.GitHubError as exc:
            if exc.status == 409 and "already exists" in str(exc).lower():
                # (GitHub's answer for the same thing is a 422 that says so: the desk links it)
                raise github.GitHubError(str(exc), 422) from exc
            raise
        return self._keep(ref, pull_from(made or {}))

    async def update_pull(self, ref: HostRef, number_: int, *, body: str) -> dict[str, Any]:
        found = await self.request(
            "PUT", f"/projects/{_pid(ref)}/merge_requests/{number_}", body={"description": body},
            repo=ref.full,
        )  # fmt: skip
        return pull_from(found or {})

    async def retarget(self, ref: HostRef, number_: int, base: str) -> dict[str, Any]:
        found = await self.request(
            "PUT", f"/projects/{_pid(ref)}/merge_requests/{number_}",
            body={"target_branch": base}, repo=ref.full,
        )  # fmt: skip
        return pull_from(found or {})

    async def pull(self, ref: HostRef, number_: int) -> dict[str, Any]:
        found = await self.request(
            "GET", f"/projects/{_pid(ref)}/merge_requests/{number_}", repo=ref.full
        )
        return self._keep(ref, pull_from(found or {}))

    async def check_runs(self, ref: HostRef, sha: str) -> list[dict[str, Any]]:
        """The jobs of the commit's latest pipeline (or, with none, its commit statuses)."""
        if not sha:
            return []
        pipelines = await self.request(
            "GET", f"/projects/{_pid(ref)}/pipelines",
            params={"sha": sha, "order_by": "id", "sort": "desc", "per_page": 1}, repo=ref.full,
        )  # fmt: skip
        latest = next((p for p in pipelines or [] if isinstance(p, dict)), None)
        if latest is None:
            rows = await self.paged(
                f"/projects/{_pid(ref)}/repository/commits/{sha}/statuses", repo=ref.full
            )
            return [status_run(r) for r in rows if isinstance(r, dict)]
        jobs = await self.paged(
            f"/projects/{_pid(ref)}/pipelines/{number(latest.get('id'))}/jobs", repo=ref.full
        )
        return [run_from(j) for j in jobs if isinstance(j, dict)]

    async def job_log(self, ref: HostRef, job_id: int) -> str:
        return await self.text(f"/projects/{_pid(ref)}/jobs/{int(job_id)}/trace", repo=ref.full)

    async def _notes(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        found = await self.paged(
            f"/projects/{_pid(ref)}/merge_requests/{number_}/discussions", repo=ref.full
        )
        notes = []
        for discussion in found:
            inside = discussion.get("notes") if isinstance(discussion, dict) else None
            for note in inside if isinstance(inside, list) else []:
                if isinstance(note, dict) and not note.get("system"):
                    notes.append(note)
        return notes

    async def review_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        web = self._web.get((ref.full, number_), ref.pull_url(number_))
        return [note_from(n, web) for n in await self._notes(ref, number_)
                if n.get("type") == "DiffNote"]  # fmt: skip

    async def issue_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        web = self._web.get((ref.full, number_), ref.pull_url(number_))
        return [note_from(n, web) for n in await self._notes(ref, number_)
                if n.get("type") != "DiffNote"]  # fmt: skip

    async def reviews(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        """Approvals, as reviews that approved (an approval says nothing more)."""
        try:
            found = await self.request(
                "GET", f"/projects/{_pid(ref)}/merge_requests/{number_}/approvals", repo=ref.full
            )
        except github.RateLimited:
            raise
        except github.GitHubError:
            return []  # (approvals are a paid tier on some GitLabs)
        rows = []
        for item in (found or {}).get("approved_by") or []:
            user = (item or {}).get("user") if isinstance(item, dict) else None
            login = str((user or {}).get("username") or "")
            if login:
                rows.append({"id": stable_id(f"approval:{number_}:{login}"),
                             "user": {"login": login}, "state": "APPROVED", "body": "",
                             "author_association": "COLLABORATOR", "submitted_at": ""})  # fmt: skip
        return rows

    async def comment(self, ref: HostRef, number_: int, body: str) -> dict[str, Any]:
        made = await self.request(
            "POST", f"/projects/{_pid(ref)}/merge_requests/{number_}/notes",
            body={"body": body[:60_000]}, repo=ref.full,
        )  # fmt: skip
        web = self._web.get((ref.full, number_), ref.pull_url(number_))
        return note_from(made or {}, web)

    async def merge(
        self, ref: HostRef, number_: int, *, method: str, sha: str, title: str = ""
    ) -> dict[str, Any]:
        data: dict[str, Any] = {"sha": sha, "squash": method == "squash"}
        if title and method == "squash":
            data["squash_commit_message"] = title[:250]
        try:
            return await self.request(
                "PUT", f"/projects/{_pid(ref)}/merge_requests/{number_}/merge", body=data,
                repo=ref.full,
            ) or {}  # fmt: skip
        except github.GitHubError as exc:
            if exc.status in (405, 406):
                # Not mergeable yet (approvals, a pipeline, a rebase): not a method GitLab
                # forbids, so merging when green isn't switched off for it.
                raise github.GitHubError(str(exc), 409) from exc
            raise

    # ── issues ──

    async def open_issues(self, ref: HostRef, label: str = "") -> list[dict[str, Any]]:
        params: dict[str, Any] = {"state": "opened", "order_by": "updated_at", "per_page": 30}
        if label:
            params["labels"] = label
        found = await self.request(
            "GET", f"/projects/{_pid(ref)}/issues", params=params, repo=ref.full
        )
        return [issue_from(i) for i in found or [] if isinstance(i, dict)]

    async def issue(self, ref: HostRef, number_: int) -> dict[str, Any]:
        found = await self.request("GET", f"/projects/{_pid(ref)}/issues/{number_}", repo=ref.full)
        return issue_from(found or {})

