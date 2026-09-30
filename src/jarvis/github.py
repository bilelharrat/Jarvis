"""GitHub for Jarvis Code: its REST API (over httpx, HTTP/1.1), for pull requests, their
checks, reviews and comments, merging, and the issues that start sessions.

Which repository a project is: its git remote (the branch's upstream remote, else origin,
else its only one), in any of the forms git writes (https with or without a user and token
in it, ssh, scp-like git@github.com:owner/repo, git://). Only github.com: the connector's
token is a github.com token.

Who Jarvis is on GitHub: the token the GitHub connector keeps (Tools & Accounts pastes it
into the Keychain; it's read here through the connectors vault, never written anywhere),
or, with the GitHub CLI installed and signed in, `gh auth token`. With neither, every call
says so: connect GitHub in Tools & Accounts.

Rate limits: every answer's X-RateLimit headers are kept. A limit that's used up (the
hourly one, or a secondary limit's Retry-After) stops every call until it resets, without
asking GitHub again meanwhile; the watcher backs off before that (low()). Repeated reads
send the last answer's ETag, and GitHub's 304 for an unchanged answer costs nothing
against the limit.

A job's log is fetched from where GitHub redirects to (a signed address on another host),
without the token, and only its tail is kept.

Nothing here calls a model, and nothing is sent anywhere but api.github.com (and the log
host GitHub names).
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shutil
import subprocess
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import lang
from .code_changes import git

API = "https://api.github.com"
HOST = "github.com"
TIMEOUT = 20.0
USER_AGENT = "Jarvis-Code"
ETAGS_KEPT = 400  # answers kept for their ETag (one per address read)
LOW = 25  # calls left in the hour below which background polling waits for the reset
SECONDARY_WAIT = 60.0  # a secondary limit that doesn't say how long: this long
LOG_TAIL = 96_000  # bytes of a job's log kept (its end, where a failure is)
LOG_READ_MAX = 8_000_000  # bytes read at most looking for that end
TOKEN_FRESH = 300.0  # seconds a token read from the Keychain is reused
CONNECTOR = "github"  # the GitHub connector's id in Tools & Accounts

CONNECT = "Connect GitHub in Tools & Accounts first: I use its token for pull requests."

ZH = {
    CONNECT: "请先在“工具与账户”里连接 GitHub：我用它的令牌处理拉取请求。",
    "GitHub turned the token down. Reconnect GitHub in Tools & Accounts with a fresh token.": "GitHub 拒绝了这个令牌。请在“工具与账户”里用新令牌重新连接 GitHub。",
    "The GitHub token isn't allowed to do that in {repo}. Give it access to the repository (contents, pull requests, checks and actions) in its settings on GitHub.": "这个 GitHub 令牌无权在 {repo} 里这样做。请在 GitHub 的令牌设置里给它这个仓库的权限（内容、拉取请求、检查和 Actions）。",
    "GitHub can't find {repo}, or the token can't see it. Check the token's repository access in Tools & Accounts.": "GitHub 找不到 {repo}，或者令牌看不到它。请在“工具与账户”里检查令牌能访问哪些仓库。",
    "GitHub's rate limit is used up until {time}.": "GitHub 的调用额度已用完，要到 {time} 才恢复。",
    "Couldn't reach GitHub: {error}": "连不上 GitHub：{error}",
    "GitHub said no: {error}": "GitHub 拒绝了：{error}",
    "GitHub had a problem ({status}). Try again in a moment.": "GitHub 出了问题（{status}）。请稍后再试。",
}
lang.add_texts(ZH)


class GitHubError(Exception):
    """Why a call didn't work, in words for the owner (status: GitHub's, 0 when none)."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class NotConnected(GitHubError):
    """No token: GitHub isn't connected in Tools & Accounts (and no signed-in gh)."""


class RateLimited(GitHubError):
    """A rate limit is used up until reset_at (epoch seconds)."""

    def __init__(self, message: str, reset_at: float) -> None:
        super().__init__(message, 429)
        self.reset_at = reset_at


# ── which repository ──


@dataclass(frozen=True)
class RepoRef:
    owner: str
    name: str

    @property
    def full(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def url(self) -> str:
        return f"https://{HOST}/{self.full}"


_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_SCP = re.compile(r"^(?:[\w.+-]+@)?([\w.-]+):(?!//)(.+)$")  # git@github.com:owner/repo.git


def _github_host(host: str) -> bool:
    """github.com, or an ssh alias for it (github.com-work, github-personal): never
    another server that merely has github in its name (github.example.com)."""
    host = host.lower().rstrip(".")
    if host in ("github.com", "www.github.com", "ssh.github.com"):
        return True
    return "." not in host.replace("github.com", "") and host.startswith("github")


def parse_remote(url: str) -> RepoRef | None:
    """owner/repo from a remote's address, in any form git writes; None for anything that
    isn't a github.com repository."""
    raw = (url or "").strip()
    if not raw or any(c.isspace() for c in raw):
        return None
    if "://" in raw:
        parts = urlsplit(raw)
        if parts.scheme not in ("https", "http", "ssh", "git", "git+ssh", "ssh+git"):
            return None
        host, path = parts.hostname or "", parts.path
    else:
        found = _SCP.match(raw)
        if found is None:
            return None
        host, path = found.group(1), found.group(2)
    if not _github_host(host):
        return None
    pieces = [p for p in path.strip("/").split("/") if p]
    if len(pieces) != 2:
        return None
    owner, name = pieces
    if name.endswith(".git"):
        name = name[:-4]
    if not (_PART.match(owner) and _PART.match(name)) or name in (".", ".."):
        return None
    return RepoRef(owner, name)


def remote_for(folder: Path) -> tuple[str, str]:
    """(remote name, address) a folder's work goes to: the branch's upstream remote, else
    origin, else the only remote. ("", "") when there's none. The address is the one the
    remote was given (before any url.insteadOf rewriting, which only says how to reach
    it). Runs git: call off the loop."""
    upstream = git(folder, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    remotes = git(folder, "remote").out.split()
    name = upstream.out.strip().split("/", 1)[0] if upstream.ok else ""
    if name not in remotes:
        name = "origin" if "origin" in remotes else remotes[0] if len(remotes) == 1 else ""
    if not name:
        return "", ""
    found = git(folder, "config", "--get", f"remote.{name}.url")
    if not found.ok or not found.out.strip():
        found = git(folder, "remote", "get-url", name)
    return (name, found.out.strip()) if found.ok else ("", "")


def repo_for(folder: Path) -> tuple[str, RepoRef | None]:
    """The folder's remote and the github.com repository it is (None when it isn't one)."""
    name, url = remote_for(folder)
    return name, parse_remote(url) if url else None


# ── who Jarvis is ──


def gh_token() -> str:
    """The GitHub CLI's token when gh is installed and signed in, else "". Blocking."""
    exe = shutil.which("gh")
    if not exe:
        return ""
    try:
        done = subprocess.run(
            [exe, "auth", "token", "--hostname", HOST],
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    token = done.stdout.strip() if done.returncode == 0 else ""
    return token if re.fullmatch(r"[\w-]{20,255}", token) else ""


def token_from(vault: Any) -> str:
    """The GitHub connector's token (Tools & Accounts), else gh's; "" with neither.
    Blocking (the Keychain, or gh): call off the loop."""
    token = ""
    if vault is not None:
        try:
            token = vault.get(CONNECTOR, "token") or ""
        except Exception:  # a locked Keychain, keyring missing: as if not connected
            token = ""
    return token.strip() or gh_token()


# ── the API ──


def _clock(epoch: float) -> str:
    return time.strftime("%-I:%M %p", time.localtime(epoch)).replace(":00 ", " ")


class Client:
    """One GitHub account's API, shared by a hub's Jarvis Code features. token() reads the
    token (blocking; it's called in a thread and reused for TOKEN_FRESH seconds, and again
    at once after GitHub turns it down). transport: the tests' httpx.MockTransport."""

    def __init__(
        self,
        token: Callable[[], str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        language: Callable[[], str] = lambda: "en",
    ) -> None:
        self._token_source = token
        self._transport = transport
        self.clock = clock
        self.language = language
        self._http: httpx.AsyncClient | None = None
        self._token: tuple[str, float] | None = None  # (token, when read)
        self._etags: OrderedDict[str, tuple[str, Any]] = OrderedDict()
        self.remaining: int | None = None  # calls left this hour, as the last answer said
        self.reset_at = 0.0  # when the hourly limit resets
        self.limited_until = 0.0  # a used-up limit: nothing is asked before this
        self._login: str = ""

    # ── plumbing ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.language())

    async def token(self) -> str:
        now = self.clock()
        if self._token is not None and now - self._token[1] < TOKEN_FRESH:
            return self._token[0]
        found = await asyncio.to_thread(self._token_source)
        self._token = (found, now)
        return found

    async def connected(self) -> bool:
        return bool(await self.token())

    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                transport=self._transport,
                timeout=TIMEOUT,
                follow_redirects=False,
                headers={"User-Agent": USER_AGENT, "X-GitHub-Api-Version": "2022-11-28"},
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            with contextlib.suppress(Exception):
                await self._http.aclose()
            self._http = None

    def low(self) -> bool:
        """Few calls left this hour (or none): background polling should wait."""
        if self.clock() < self.limited_until:
            return True
        return self.remaining is not None and self.remaining < LOW and self.clock() < self.reset_at

    def wait_seconds(self) -> float:
        """How long background polling should wait for the limit (0: it needn't)."""
        until = self.limited_until if self.clock() < self.limited_until else 0.0
        if not until and self.low():
            until = self.reset_at
        return max(0.0, until - self.clock())

    def _limited(self, until: float) -> RateLimited:
        self.limited_until = max(self.limited_until, until)
        text = f"GitHub's rate limit is used up until {_clock(self.limited_until)}."
        return RateLimited(self.tr(text), self.limited_until)

    def _note_limits(self, response: httpx.Response) -> None:
        with contextlib.suppress(TypeError, ValueError, KeyError):
            self.remaining = int(response.headers["x-ratelimit-remaining"])
        with contextlib.suppress(TypeError, ValueError, KeyError):
            self.reset_at = float(response.headers["x-ratelimit-reset"])

    def _problem(self, response: httpx.Response, repo: str) -> GitHubError:
        status = response.status_code
        try:
            body = response.json()
        except ValueError:
            body = {}
        message = str(body.get("message") or "") if isinstance(body, dict) else ""
        errors = body.get("errors") if isinstance(body, dict) else None
        detail = ""
        if isinstance(errors, list) and errors:
            first = errors[0]
            detail = str(first.get("message") or "") if isinstance(first, dict) else str(first)
        if status in (403, 429):
            wait = response.headers.get("retry-after")
            if wait and wait.strip().isdigit():
                return self._limited(self.clock() + int(wait.strip()))
            if response.headers.get("x-ratelimit-remaining") == "0":
                return self._limited(self.reset_at or self.clock() + SECONDARY_WAIT)
            if "rate limit" in message.lower():
                return self._limited(self.clock() + SECONDARY_WAIT)
        if status == 401:
            self._token = None  # read it again next time: it may have been replaced
            text = "GitHub turned the token down. Reconnect GitHub in Tools & Accounts with a fresh token."
            return GitHubError(self.tr(text), status)
        where = repo or "that repository"
        if status == 403:
            text = (
                f"The GitHub token isn't allowed to do that in {where}. Give it access to the "
                "repository (contents, pull requests, checks and actions) in its settings on "
                "GitHub."
            )
            return GitHubError(self.tr(text), status)
        if status == 404:
            text = (
                f"GitHub can't find {where}, or the token can't see it. Check the token's "
                "repository access in Tools & Accounts."
            )
            return GitHubError(self.tr(text), status)
        if status in (409, 422) or 400 <= status < 500:
            said = (detail or message or f"HTTP {status}")[:300]
            return GitHubError(self.tr(f"GitHub said no: {said}"), status)
        return GitHubError(
            self.tr(f"GitHub had a problem ({status}). Try again in a moment."), status
        )

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        repo: str = "",
    ) -> Any:
        """One call: its JSON (None for an empty answer). A GET sends the last answer's
        ETag, and a 304 gives that answer back."""
        _response, data = await self._send(method, path, params=params, body=body, repo=repo)
        return data

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        repo: str = "",
        moved: bool = False,
    ) -> tuple[httpx.Response, Any]:
        """The answer, and its JSON (the kept one, for a 304). A repository that was
        renamed or moved answers a GET with a redirect to its new address on the API:
        followed once. A redirect anywhere else is the caller's (a job's log)."""
        if self.clock() < self.limited_until:
            raise self._limited(self.limited_until)
        token = await self.token()
        if not token:
            raise NotConnected(self.tr(CONNECT))
        url = path if path.startswith("https://") else f"{API}{path}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
        key = ""
        if method == "GET":
            key = str(httpx.URL(url, params=params or {}))
            kept = self._etags.get(key)
            if kept is not None:
                headers["If-None-Match"] = kept[0]
        try:
            response = await self.http().request(
                method, url, params=params, json=body, headers=headers
            )
        except httpx.HTTPError as exc:
            reason = str(exc) or type(exc).__name__
            raise GitHubError(self.tr(f"Couldn't reach GitHub: {reason[:200]}")) from exc
        self._note_limits(response)
        where = response.headers.get("location", "") if response.is_redirect else ""
        if where.startswith(f"{API}/") and method == "GET" and not moved:
            return await self._send(method, where, repo=repo, moved=True)
        if response.status_code == 304 and key in self._etags:
            self._etags.move_to_end(key)
            return response, self._etags[key][1]
        if response.status_code >= 400:
            raise self._problem(response, repo)
        data = None
        if response.status_code != 204 and response.content and not response.is_redirect:
            try:
                data = response.json()
            except ValueError:
                data = None
        if key and response.status_code == 200 and response.headers.get("etag"):
            self._etags[key] = (response.headers["etag"], data)
            self._etags.move_to_end(key)
            while len(self._etags) > ETAGS_KEPT:
                self._etags.popitem(last=False)
        return response, data

    async def paged(
        self, path: str, params: dict[str, Any] | None = None, *, limit: int = 300, repo: str = ""
    ) -> list[Any]:
        """Every page of a list (following Link: rel=next), up to limit items."""
        items: list[Any] = []
        url, query = path, {"per_page": 100, **(params or {})}
        for _ in range(20):
            response, page = await self._send("GET", url, params=query, repo=repo)
            if isinstance(page, dict):  # {"total_count": …, "check_runs": [...]}
                page = next((v for v in page.values() if isinstance(v, list)), [])
            items.extend(page if isinstance(page, list) else [])
            following = response.links.get("next", {}).get("url") if response.links else None
            if len(items) >= limit or not following or not following.startswith(API):
                break
            url, query = following, None
        return items[:limit]

    # ── who ──

    async def login(self) -> str:
        """The token's own GitHub login (asked once)."""
        if not self._login:
            me = await self.request("GET", "/user")
            self._login = str((me or {}).get("login") or "")
        return self._login

    # ── repositories and pull requests ──

    async def repo(self, ref: RepoRef) -> dict[str, Any]:
        return await self.request("GET", f"/repos/{ref.full}", repo=ref.full) or {}

    async def pulls_for(self, ref: RepoRef, branch: str, state: str = "open") -> list[dict]:
        """The pull requests from this repository's branch (newest first)."""
        found = await self.request(
            "GET",
            f"/repos/{ref.full}/pulls",
            params={"head": f"{ref.owner}:{branch}", "state": state, "per_page": 10},
            repo=ref.full,
        )
        return found if isinstance(found, list) else []

    async def create_pull(
        self, ref: RepoRef, *, title: str, head: str, base: str, body: str, draft: bool = False
    ) -> dict[str, Any]:
        data = {"title": title, "head": head, "base": base, "body": body, "draft": bool(draft)}
        return await self.request("POST", f"/repos/{ref.full}/pulls", body=data, repo=ref.full)

    async def pull(self, ref: RepoRef, number: int) -> dict[str, Any]:
        return await self.request("GET", f"/repos/{ref.full}/pulls/{number}", repo=ref.full) or {}

    async def check_runs(self, ref: RepoRef, sha: str) -> list[dict[str, Any]]:
        return await self.paged(
            f"/repos/{ref.full}/commits/{sha}/check-runs", {"filter": "latest"}, repo=ref.full
        )

    async def statuses(self, ref: RepoRef, sha: str) -> list[dict[str, Any]]:
        """The commit's latest status from each context (the older kind of check)."""
        found = await self.request(
            "GET",
            f"/repos/{ref.full}/commits/{sha}/status",
            params={"per_page": 100},
            repo=ref.full,
        )
        rows = (found or {}).get("statuses") if isinstance(found, dict) else None
        return rows if isinstance(rows, list) else []

    async def annotations(self, ref: RepoRef, check_id: int) -> list[dict[str, Any]]:
        return await self.paged(
            f"/repos/{ref.full}/check-runs/{check_id}/annotations", limit=50, repo=ref.full
        )

    async def reviews(self, ref: RepoRef, number: int) -> list[dict[str, Any]]:
        return await self.paged(f"/repos/{ref.full}/pulls/{number}/reviews", repo=ref.full)

    async def review_comments(self, ref: RepoRef, number: int) -> list[dict[str, Any]]:
        return await self.paged(
            f"/repos/{ref.full}/pulls/{number}/comments",
            {"sort": "created", "direction": "asc"},
            repo=ref.full,
        )

    async def issue_comments(self, ref: RepoRef, number: int) -> list[dict[str, Any]]:
        return await self.paged(f"/repos/{ref.full}/issues/{number}/comments", repo=ref.full)

    async def merge(
        self, ref: RepoRef, number: int, *, method: str, sha: str, title: str = ""
    ) -> dict[str, Any]:
        """Merge it (merge, squash or rebase), only if its head is still sha."""
        data: dict[str, Any] = {"merge_method": method, "sha": sha}
        if title and method == "squash":
            data["commit_title"] = title[:250]
        return await self.request(
            "PUT", f"/repos/{ref.full}/pulls/{number}/merge", body=data, repo=ref.full
        )

    async def issue(self, ref: RepoRef, number: int) -> dict[str, Any]:
        return await self.request("GET", f"/repos/{ref.full}/issues/{number}", repo=ref.full) or {}

    async def issue_events(self, ref: RepoRef) -> list[dict[str, Any]]:
        """The repository's latest issue events (labelled, closed…), newest first."""
        found = await self.request(
            "GET", f"/repos/{ref.full}/issues/events", params={"per_page": 50}, repo=ref.full
        )
        return found if isinstance(found, list) else []

    # ── logs ──

    async def job_log(self, ref: RepoRef, job_id: int) -> str:
        """The end of a GitHub Actions job's log (LOG_TAIL bytes at most). GitHub answers
        with a redirect to a signed address elsewhere, fetched without the token."""
        response, _data = await self._send(
            "GET", f"/repos/{ref.full}/actions/jobs/{job_id}/logs", repo=ref.full
        )
        where = response.headers.get("location", "")
        if not response.is_redirect or not where:
            return response.text[-LOG_TAIL:] if response.content else ""
        if not where.startswith("https://"):
            return ""
        return await self._tail(where)

    async def _tail(self, url: str) -> str:
        tail = bytearray()
        read = 0
        try:
            async with self.http().stream(
                "GET", url, headers={"Range": f"bytes=-{LOG_TAIL}"}
            ) as response:
                if response.status_code >= 400:
                    return ""
                async for chunk in response.aiter_bytes():
                    read += len(chunk)
                    tail.extend(chunk)
                    if len(tail) > LOG_TAIL * 2:
                        del tail[: len(tail) - LOG_TAIL]
                    if read >= LOG_READ_MAX:
                        break
        except httpx.HTTPError:
            return ""
        return bytes(tail[-LOG_TAIL:]).decode("utf-8", errors="replace")


# ── what the answers mean ──

FAILED = ("failure", "timed_out", "action_required", "startup_failure")
PASSED = ("success", "neutral", "skipped")


@dataclass
class Check:
    """One check on a commit: a check run (GitHub Actions or another app) or a status."""

    name: str
    state: str  # pending | passed | failed | cancelled
    url: str = ""
    check_id: int = 0  # a check run's id (for an Actions job, its job id too)
    actions: bool = False  # a GitHub Actions job: its log can be read
    summary: str = ""  # what the check itself said (its title, description)

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state,
            "url": self.url,
            "id": self.check_id,
            "log": self.actions,
            "summary": self.summary[:300],
        }


def checks_from(runs: list[dict[str, Any]], statuses: list[dict[str, Any]]) -> list[Check]:
    """A commit's checks, one per name (the latest run of each), in a stable order."""
    found: dict[str, Check] = {}
    for run in runs:
        if not isinstance(run, dict):
            continue
        name = str(run.get("name") or "check")[:120]
        status, conclusion = run.get("status"), run.get("conclusion")
        if status != "completed":
            state = "pending"
        elif conclusion in FAILED:
            state = "failed"
        elif conclusion in PASSED:
            state = "passed"
        else:
            state = "cancelled"  # cancelled, stale: not a failure of the code
        app = run.get("app") if isinstance(run.get("app"), dict) else {}
        output = run.get("output") if isinstance(run.get("output"), dict) else {}
        found[name] = Check(
            name,
            state,
            str(run.get("html_url") or run.get("details_url") or ""),
            int(run.get("id") or 0),
            app.get("slug") == "github-actions",
            str(output.get("title") or "")[:300],
        )
    for status in statuses:
        if not isinstance(status, dict):
            continue
        name = str(status.get("context") or "status")[:120]
        raw = status.get("state")
        state = {"success": "passed", "pending": "pending"}.get(str(raw), "failed")
        found.setdefault(
            name,
            Check(
                name,
                state,
                str(status.get("target_url") or ""),
                summary=str(status.get("description") or "")[:300],
            ),
        )
    return sorted(
        found.values(), key=lambda c: ({"failed": 0, "pending": 1}.get(c.state, 2), c.name)
    )


def overall(checks: list[Check]) -> str:
    """none (no checks), pending, failed or passed: what the commit's checks add up to."""
    if not checks:
        return "none"
    if any(c.state == "failed" for c in checks):
        return "failed"
    if any(c.state == "pending" for c in checks):
        return "pending"
    return "passed"


_STAMP = re.compile(r"^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_ERRORISH = re.compile(
    r"(?:##\[error\]|\berror\b|\bERROR\b|\bFAIL(?:ED|URE)?\b|\bfailed\b|✗|✕|×|"
    r"Traceback|AssertionError|Exception\b|panicked|exit code [1-9])",
    re.IGNORECASE,
)


def trim_log(text: str, limit: int = 6_000) -> str:
    """A job's log as a fix needs it: timestamps and colours out, the lines around the
    errors (and the very end) kept, at most limit characters."""
    lines = []
    for raw in text.splitlines():
        line = _ANSI.sub("", _STAMP.sub("", raw)).rstrip()
        if line.startswith(("##[group]", "##[endgroup]")) or not line.strip():
            continue
        lines.append(line[:400])
    keep: set[int] = set(range(max(0, len(lines) - 40), len(lines)))
    for i, line in enumerate(lines):
        if _ERRORISH.search(line):
            keep.update(range(max(0, i - 6), min(len(lines), i + 12)))
    out: list[str] = []
    last = -1
    for i in sorted(keep):
        if last >= 0 and i != last + 1:
            out.append("…")
        out.append(lines[i])
        last = i
    joined = "\n".join(out)
    if len(joined) > limit:
        joined = "…\n" + joined[-limit:]
    return joined


async def gather_limited(coros: list[Awaitable[Any]], limit: int = 4) -> list[Any]:
    """Run these a few at a time; each result, or its exception."""
    gate = asyncio.Semaphore(limit)

    async def one(coro: Awaitable[Any]) -> Any:
        async with gate:
            return await coro

    return await asyncio.gather(*(one(c) for c in coros), return_exceptions=True)
