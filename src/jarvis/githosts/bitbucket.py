"""Bitbucket Cloud for Eden Code: pull requests, Bitbucket Pipelines and other CI's commit
statuses, comments and merging, through Bitbucket's REST API (2.0). Answers come back in
GitHub's shapes (base.py says why).

What maps to what:
- a pull request is one (OPEN is open, MERGED merged, DECLINED and SUPERSEDED closed);
  Bitbucket gives its commits as short hashes, so a commit is matched by its start;
- the latest pipeline on the head commit is its checks, each step a check run (its log
  readable); another CI's commit statuses are checks too (the Pipelines' own status for
  the pipeline as a whole is left out: its steps say it);
- whether it can merge: Bitbucket says so only through the diff (a file in "merge
  conflict" is dirty); otherwise an open one is clean, and a merge it refuses says why;
- inline comments are review comments (file and line), the others the conversation; a
  participant who approved or asked for changes is a review;
- who may write: Bitbucket tells the token's own user their permission, and a workspace
  admin's token everyone's; when it can't say, nobody's comment goes to a session by
  itself (the pane lists them, with a Send button).

Bitbucket's merge takes no commit to merge at, so the head is read first and a merge is
refused if it has moved since the checks passed.

Who Eden is on Bitbucket: what's pasted in Eden Code settings, either username:app
password (or email:API token), sent as Basic, or a repository or workspace access token,
sent as Bearer. Bitbucket has no CLI to borrow one from.

Nothing here calls a model, and nothing is sent anywhere but api.bitbucket.org (and the
address it names for a step's log, fetched without the token).
"""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import quote

from .. import github
from .base import LOG_TAIL, HostRef, RestClient, number, stable_id

API = "https://api.bitbucket.org/2.0"
WEB = "https://bitbucket.org"
STATES = {"OPEN": "open", "MERGED": "closed", "DECLINED": "closed", "SUPERSEDED": "closed"}
RESULTS = {"SUCCESSFUL": "success", "FAILED": "failure", "ERROR": "failure",
           "STOPPED": "cancelled", "NOT_RUN": "skipped", "EXPIRED": "cancelled"}  # fmt: skip
STATUS = {"SUCCESSFUL": "success", "FAILED": "failure", "STOPPED": "cancelled"}
STRATEGIES = {"squash": "squash", "merge": "merge_commit", "rebase": "fast_forward"}
LEVELS = {"read": 1, "triage": 1, "write": 2, "maintain": 3, "admin": 3}
PERMS = {"read": 1, "write": 2, "admin": 3}


def same_commit(a: str, b: str) -> bool:
    """A short hash and a full one name the same commit (either way round)."""
    a, b = (a or "").lower(), (b or "").lower()
    return bool(a and b) and (a.startswith(b) or b.startswith(a)) and min(len(a), len(b)) >= 7


def _user(raw: Any) -> str:
    raw = raw if isinstance(raw, dict) else {}
    return str(raw.get("nickname") or raw.get("username") or raw.get("display_name") or "")


def pull_from(pr: dict[str, Any]) -> dict[str, Any]:
    """A Bitbucket pull request in a GitHub pull request's shape."""
    source = pr.get("source") if isinstance(pr.get("source"), dict) else {}
    target = pr.get("destination") if isinstance(pr.get("destination"), dict) else {}
    state = str(pr.get("state") or "")

    def side(part: dict[str, Any]) -> dict[str, str]:
        return {"ref": str((part.get("branch") or {}).get("name") or ""),
                "sha": str((part.get("commit") or {}).get("hash") or "")}  # fmt: skip

    return {
        "number": number(pr.get("id")),
        "title": str(pr.get("title") or ""),
        "body": str(pr.get("description") or ""),
        "html_url": str(((pr.get("links") or {}).get("html") or {}).get("href") or ""),
        "state": STATES.get(state, "open"),
        "merged": state == "MERGED",
        "draft": bool(pr.get("draft")),
        "head": side(source),
        "base": side(target),
        "mergeable_state": "clean" if state == "OPEN" and not pr.get("draft") else "",
        "mergeable": None,
        "user": {"login": _user(pr.get("author"))},
    }


def comment_from(raw: dict[str, Any]) -> dict[str, Any]:
    inline = raw.get("inline") if isinstance(raw.get("inline"), dict) else {}
    return {
        "id": number(raw.get("id")),
        "user": {"login": _user(raw.get("user"))},
        "author_association": "COLLABORATOR",  # (only "ask": may() decides)
        "path": str(inline.get("path") or ""),
        "line": number(inline.get("to") or inline.get("from")),
        "body": str((raw.get("content") or {}).get("raw") or ""),
        "html_url": str(((raw.get("links") or {}).get("html") or {}).get("href") or ""),
        "created_at": str(raw.get("created_on") or ""),
        "inline": bool(inline),
    }


class BitbucketClient(RestClient):
    kind = "bitbucket"
    api = API

    def __init__(self, token: Any, *, host: str = "bitbucket.org", **kw: Any) -> None:
        super().__init__(token, host=host, **kw)
        self._steps: dict[int, tuple[str, str]] = {}  # check id -> (pipeline, step) uuids
        self._participants: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self._roles: dict[tuple[str, str], int] = {}

    def auth(self, token: str) -> dict[str, str]:
        if token.startswith("Bearer "):
            return {"Authorization": token}
        if ":" in token:
            raw = base64.b64encode(token.encode("utf-8")).decode("ascii")
            return {"Authorization": f"Basic {raw}"}
        return {"Authorization": f"Bearer {token}"}

    async def values(self, path: str, params: dict[str, Any] | None = None, *, repo: str = "",
                     limit: int = 300) -> list[Any]:  # fmt: skip
        """Every page of a list (Bitbucket's "next"), up to limit items."""
        items: list[Any] = []
        url, query = path, {"pagelen": 50, **(params or {})}
        for _ in range(10):
            page = await self.request("GET", url, params=query, repo=repo)
            page = page if isinstance(page, dict) else {}
            items.extend(v for v in page.get("values") or [] if isinstance(v, dict))
            following = str(page.get("next") or "")
            if len(items) >= limit or not following.startswith(f"{API}/"):
                break
            url, query = following, None
        return items[:limit]

    def _repo(self, ref: HostRef) -> str:
        return f"/repositories/{ref.full}"

    # ── who ──

    async def login(self) -> str:
        if not self._login:
            self._login = _user(await self.request("GET", "/user"))
        return self._login

    async def may(self, ref: HostRef, login: str, least: str) -> bool:
        """Whether login has at least that permission. False when Bitbucket won't say."""
        if not login:
            return False
        key = (ref.full.lower(), login.lower())
        if key not in self._roles:
            try:
                self._roles[key] = await self._permission(ref, login)
            except github.RateLimited:
                raise
            except github.GitHubError:
                return False
        return self._roles[key] >= LEVELS.get(least, 2)

    async def _permission(self, ref: HostRef, login: str) -> int:
        if login == await self.login():
            rows = await self.values(
                "/user/permissions/repositories",
                {"q": f'repository.full_name="{ref.full}"'}, repo=ref.full,
            )  # fmt: skip
        else:
            workspace, _, slug = ref.full.partition("/")
            rows = await self.values(
                f"/workspaces/{workspace}/permissions/repositories/{slug}", repo=ref.full
            )
            rows = [r for r in rows if _user(r.get("user")).lower() == login.lower()]
        return max((PERMS.get(str(r.get("permission") or ""), 0) for r in rows), default=0)

    # ── the repository and its pull requests ──

    async def repo(self, ref: HostRef) -> dict[str, Any]:
        found = await self.request("GET", self._repo(ref), repo=ref.full) or {}
        return {
            "full_name": ref.full,
            "default_branch": str((found.get("mainbranch") or {}).get("name") or ""),
            "html_url": f"{WEB}/{ref.full}",
            "allow_squash_merge": True,
            "allow_merge_commit": True,
            "allow_rebase_merge": True,
        }

    async def pulls_for(self, ref: HostRef, branch: str, state: str = "open") -> list[dict]:
        safe = branch.replace("\\", "\\\\").replace('"', '\\"')
        query = f'source.branch.name="{safe}"'
        if state == "open":
            query += ' AND state="OPEN"'
        rows = await self.values(
            f"{self._repo(ref)}/pullrequests",
            {"q": query, "sort": "-created_on", "pagelen": 10}, repo=ref.full, limit=10,
        )  # fmt: skip
        return [pull_from(r) for r in rows]

    async def create_pull(
        self, ref: HostRef, *, title: str, head: str, base: str, body: str, draft: bool = False
    ) -> dict[str, Any]:
        data = {
            "title": title,
            "description": body[:60_000],
            "source": {"branch": {"name": head}},
            "destination": {"branch": {"name": base}},
            "draft": bool(draft),
        }
        try:
            made = await self.request(
                "POST", f"{self._repo(ref)}/pullrequests", body=data, repo=ref.full
            )
        except github.GitHubError as exc:
            if exc.status in (400, 409) and "already" in str(exc).lower():
                raise github.GitHubError(f"{exc} (already exists)", 422) from exc
            raise
        return pull_from(made or {})

    async def update_pull(self, ref: HostRef, number_: int, *, body: str) -> dict[str, Any]:
        found = await self.request(
            "PUT", f"{self._repo(ref)}/pullrequests/{number_}", body={"description": body},
            repo=ref.full,
        )  # fmt: skip
        return pull_from(found or {})

    async def retarget(self, ref: HostRef, number_: int, base: str) -> dict[str, Any]:
        found = await self.request(
            "PUT", f"{self._repo(ref)}/pullrequests/{number_}",
            body={"destination": {"branch": {"name": base}}}, repo=ref.full,
        )  # fmt: skip
        return pull_from(found or {})

    async def pull(self, ref: HostRef, number_: int) -> dict[str, Any]:
        raw = await self.request("GET", f"{self._repo(ref)}/pullrequests/{number_}", repo=ref.full)
        raw = raw if isinstance(raw, dict) else {}
        self._participants[(ref.full, number_)] = [
            p for p in raw.get("participants") or [] if isinstance(p, dict)
        ]
        found = pull_from(raw)
        if raw.get("state") == "OPEN" and await self._conflicted(ref, number_):
            found["mergeable_state"], found["mergeable"] = "dirty", False
        return found

    async def _conflicted(self, ref: HostRef, number_: int) -> bool:
        try:
            rows = await self.values(
                f"{self._repo(ref)}/pullrequests/{number_}/diffstat", repo=ref.full, limit=500
            )
        except github.RateLimited:
            raise
        except github.GitHubError:
            return False
        return any("conflict" in str(r.get("status") or "") for r in rows)

    async def check_runs(self, ref: HostRef, sha: str) -> list[dict[str, Any]]:
        """The steps of the head commit's latest pipeline, and other CI's statuses."""
        if not sha:
            return []
        runs: list[dict[str, Any]] = []
        pipelines = await self.values(
            f"{self._repo(ref)}/pipelines", {"sort": "-created_on", "pagelen": 30},
            repo=ref.full, limit=30,
        )  # fmt: skip
        latest = next(
            (p for p in pipelines
             if same_commit(str(((p.get("target") or {}).get("commit") or {}).get("hash") or ""), sha)),
            None,
        )  # fmt: skip
        if latest is not None:
            pipe = str(latest.get("uuid") or "")
            build = number(latest.get("build_number"))
            steps = f"{self._repo(ref)}/pipelines/{quote(pipe, safe='')}/steps"
            for step in await self.values(steps, repo=ref.full):
                runs.append(self._step_run(ref, pipe, build, step))
        statuses = await self.values(f"{self._repo(ref)}/commit/{sha}/statuses", repo=ref.full)
        for row in statuses:
            if "/pipelines/" in str(row.get("url") or "") and latest is not None:
                continue  # (the pipeline as a whole: its steps are above)
            state = str(row.get("state") or "")
            runs.append({
                "id": 0,
                "name": str(row.get("name") or row.get("key") or "status"),
                "status": "completed" if state in STATUS else "in_progress",
                "conclusion": STATUS.get(state),
                "html_url": str(row.get("url") or ""),
                "app": {"slug": ""},
                "output": {"title": str(row.get("description") or "")},
            })  # fmt: skip
        return runs

    def _step_run(self, ref: HostRef, pipe: str, build: int, step: dict[str, Any]) -> dict[str, Any]:
        uuid = str(step.get("uuid") or "")
        state = step.get("state") if isinstance(step.get("state"), dict) else {}
        result = state.get("result") if isinstance(state.get("result"), dict) else {}
        check_id = stable_id(f"{pipe}{uuid}")
        self._steps[check_id] = (pipe, uuid)
        return {
            "id": check_id,
            "name": str(step.get("name") or "step"),
            "status": "completed" if state.get("name") == "COMPLETED" else "in_progress",
            "conclusion": RESULTS.get(str(result.get("name") or "")),
            "html_url": f"{WEB}/{ref.full}/pipelines/results/{build}/steps/{uuid}",
            "app": {"slug": "bitbucket-pipelines"},
            "output": {"title": ""},
        }

    async def job_log(self, ref: HostRef, job_id: int) -> str:
        """A step's log (its end). Bitbucket may answer with a redirect to where the log is
        kept: followed once, without the token."""
        found = self._steps.get(int(job_id))
        if found is None:
            return ""
        pipe, step = found
        response = await self.send(
            "GET", f"{self._repo(ref)}/pipelines/{quote(pipe, safe='')}/steps/{quote(step, safe='')}/log",
            repo=ref.full,
        )
        where = response.headers.get("location", "") if response.is_redirect else ""
        if not where:
            return response.text[-LOG_TAIL:] if response.content else ""
        if not where.startswith("https://"):
            return ""
        try:
            moved = await self.http().get(where)
        except Exception:
            return ""
        return moved.text[-LOG_TAIL:] if moved.status_code < 400 else ""

    async def _comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        rows = await self.values(f"{self._repo(ref)}/pullrequests/{number_}/comments", repo=ref.full)
        return [comment_from(r) for r in rows if not r.get("deleted")]

    async def review_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        return [c for c in await self._comments(ref, number_) if c["inline"]]

    async def issue_comments(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        return [c for c in await self._comments(ref, number_) if not c["inline"]]

    async def reviews(self, ref: HostRef, number_: int) -> list[dict[str, Any]]:
        """Participants who approved or asked for changes (from the last pull read)."""
        rows = []
        for p in self._participants.get((ref.full, number_), []):
            login = _user(p.get("user"))
            state = "APPROVED" if p.get("approved") else str(p.get("state") or "").upper()
            if login and state in ("APPROVED", "CHANGES_REQUESTED"):
                rows.append({"id": stable_id(f"review:{number_}:{login}:{state}"),
                             "user": {"login": login}, "state": state, "body": "",
                             "author_association": "COLLABORATOR",
                             "submitted_at": str(p.get("participated_on") or "")})  # fmt: skip
        return rows

    async def comment(self, ref: HostRef, number_: int, body: str) -> dict[str, Any]:
        made = await self.request(
            "POST", f"{self._repo(ref)}/pullrequests/{number_}/comments",
            body={"content": {"raw": body[:60_000]}}, repo=ref.full,
        )  # fmt: skip
        return comment_from(made or {})

    async def merge(
        self, ref: HostRef, number_: int, *, method: str, sha: str, title: str = ""
    ) -> dict[str, Any]:
        now = await self.pull(ref, number_)
        if sha and not same_commit(now["head"]["sha"], sha):
            raise github.GitHubError(
                self.tr(f"{self.name} said no: the branch has new commits since its checks ran"),
                409,
            )
        data: dict[str, Any] = {"merge_strategy": STRATEGIES.get(method, "squash")}
        if title and method == "squash":
            data["message"] = title[:250]
        return await self.request(
            "POST", f"{self._repo(ref)}/pullrequests/{number_}/merge", body=data, repo=ref.full
        ) or {}  # fmt: skip
