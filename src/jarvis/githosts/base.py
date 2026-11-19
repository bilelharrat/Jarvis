"""What every git host's client shares: which repository a remote is (HostRef), whose
token it uses (the Keychain, through the connectors vault, else the host's own CLI when
it's installed and signed in), and the plumbing of a REST call (the token reused a while,
rate limits kept and waited out, an answer turned into words for the owner).

The clients (gitlab.py, bitbucket.py, azure.py) speak to Eden Code's pull request desk
(features/code_pr.py) in GitHub's shapes: the same method names as github.Client, and
answers shaped like GitHub's (a merge request is a pull request with a number, html_url,
head {ref, sha}, base {ref, sha}, mergeable_state; a pipeline's jobs are check runs). So
the desk's watching, fixing failing checks, review comments, @jarvis, conflicts and
merging when green work for every host without a second copy of any of it, and a host's
quirks stay in its own module. Errors are github.GitHubError (RateLimited, NotConnected)
in the host's own name, for the same reason.

Nothing here calls a model, and nothing is sent anywhere but the host's own API.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import shutil
import subprocess
import time
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

from .. import github, lang

TIMEOUT = 20.0
USER_AGENT = "Eden-Code"
TOKEN_FRESH = 300.0  # seconds a token read from the Keychain (or a CLI) is reused
SECONDARY_WAIT = 60.0  # a limit that doesn't say how long: this long
LOW = 25  # calls left below which background polling waits for the reset
LOG_TAIL = 96_000  # characters of a job's log kept (its end, where a failure is)
VAULT = "code-hosts"  # the connectors vault's id for these hosts' tokens

# The kinds of host, and their names as the owner reads them.
NAMES = {
    "github": "GitHub",
    "gitlab": "GitLab",
    "bitbucket": "Bitbucket",
    "azure": "Azure DevOps",
    "jira": "Jira",
}

ZH = {
    "Add a {name} token in Eden Code settings › Git hosts and Jira first: I use it for pull requests.": "请先在 Eden Code 设置 › Git 托管与 Jira 里添加 {name} 令牌：我用它处理拉取请求。",
    "{name} turned the token down. Paste a fresh one in Eden Code settings › Git hosts and Jira.": "{name} 拒绝了这个令牌。请在 Eden Code 设置 › Git 托管与 Jira 里粘贴一个新的。",
    "The {name} token isn't allowed to do that in {repo}. Give it access to the repository (code, pull requests and pipelines).": "这个 {name} 令牌无权在 {repo} 里这样做。请给它这个仓库的权限（代码、拉取请求和流水线）。",
    "{name} can't find {repo}, or the token can't see it.": "{name} 找不到 {repo}，或者令牌看不到它。",
    "{name}'s rate limit is used up until {time}.": "{name} 的调用额度已用完，要到 {time} 才恢复。",
    "Couldn't reach {name}: {error}": "连不上 {name}：{error}",
    "{name} said no: {error}": "{name} 拒绝了：{error}",
    "{name} had a problem ({status}). Try again in a moment.": "{name} 出了问题（{status}）。请稍后再试。",
}
lang.add_texts(ZH)


@dataclass(frozen=True)
class HostRef(github.RepoRef):
    """A repository on a host other than github.com. owner may hold slashes: a GitLab
    project's groups and subgroups ("acme/web/app"), an Azure DevOps organisation and
    project ("acme/Shop"). full is owner/name, as a PullRecord's repo keeps it; tag is the
    kind and host, as its host does ("gitlab:gitlab.com")."""

    kind: str = "gitlab"
    host: str = "gitlab.com"

    @property
    def tag(self) -> str:
        return f"{self.kind}:{self.host}"

    @property
    def label(self) -> str:
        return NAMES.get(self.kind, self.kind)

    @property
    def url(self) -> str:
        if self.kind == "azure":
            org, _, project = self.owner.partition("/")
            if self.host == "dev.azure.com":
                return f"https://dev.azure.com/{org}/{project}/_git/{self.name}"
            return f"https://{self.host}/{project}/_git/{self.name}"
        return f"https://{self.host}/{self.full}"

    def pull_url(self, number: int) -> str:
        """Where a pull request (merge request) is read on the web."""
        if self.kind == "gitlab":
            return f"{self.url}/-/merge_requests/{number}"
        if self.kind == "bitbucket":
            return f"{self.url}/pull-requests/{number}"
        return f"{self.url}/pullrequest/{number}"


def kind_of(ref: Any) -> str:
    """github, gitlab, bitbucket or azure: the host a repository is on."""
    return ref.kind if isinstance(ref, HostRef) else "github"


# ── whose token ──


def _cli(args: list[str]) -> str:
    """What a host's CLI prints (its first line), or "" when it isn't installed, isn't
    signed in, or takes too long. Blocking."""
    exe = shutil.which(args[0])
    if not exe:
        return ""
    try:
        done = subprocess.run(
            [exe, *args[1:]], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    out = done.stdout.strip().splitlines() if done.returncode == 0 else []
    token = out[0].strip() if out else ""
    return token if re.fullmatch(r"[\w.~+/=:-]{16,4096}", token) else ""


def cli_token(kind: str, host: str) -> str:
    """The host's own CLI's token when it's installed and signed in: glab's for GitLab,
    an Azure CLI sign-in's for Azure DevOps (a short-lived Entra token, sent as Bearer).
    Bitbucket and Jira have no CLI of their own. Blocking."""
    if kind == "gitlab":
        return _cli(["glab", "config", "get", "token", "--host", host])
    if kind == "azure":
        found = _cli([
            "az", "account", "get-access-token", "--resource",
            "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "-o", "tsv",
        ])  # fmt: skip
        return f"Bearer {found}" if found else ""
    return ""


def cli_ready(kind: str) -> bool:
    """Whether the host's CLI is installed (whether it's signed in is cli_token's)."""
    exe = {"gitlab": "glab", "azure": "az"}.get(kind)
    return bool(exe and shutil.which(exe))


def vault_get(vault: Any, key: str) -> str:
    """One of these hosts' secrets from the Keychain; "" when unset or unreadable (a
    locked Keychain is as if not set). Blocking."""
    if vault is None:
        return ""
    try:
        return (vault.get(VAULT, key) or "").strip()
    except Exception:
        return ""


def _clock(epoch: float) -> str:
    return time.strftime("%-I:%M %p", time.localtime(epoch)).replace(":00 ", " ")


# ── a REST client ──


class RestClient:
    """One host's API: the token (read in a thread, reused TOKEN_FRESH seconds, read again
    at once after the host turns it down), rate limits (a used-up one stops every call
    until it resets, without asking the host meanwhile), and the host's answers turned
    into github.GitHubError in the owner's words. transport: the tests' MockTransport."""

    kind = ""
    api = ""

    def __init__(
        self,
        token: Callable[[], str],
        *,
        host: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        language: Callable[[], str] = lambda: "en",
    ) -> None:
        self._token_source = token
        self.host = host
        self._transport = transport
        self.clock = clock
        self.language = language
        self._http: httpx.AsyncClient | None = None
        self._token: tuple[str, float] | None = None
        self.remaining: int | None = None
        self.reset_at = 0.0
        self.limited_until = 0.0
        self._login = ""

    @property
    def name(self) -> str:
        return NAMES.get(self.kind, self.kind)

    @property
    def connect_text(self) -> str:
        return self.tr(
            f"Add a {self.name} token in Eden Code settings › Git hosts and Jira first: I use "
            "it for pull requests."
        )

    def tr(self, text: str) -> str:
        return lang.translate(text, self.language())

    async def token(self) -> str:
        now = self.clock()
        if self._token is not None and now - self._token[1] < TOKEN_FRESH:
            return self._token[0]
        found = await asyncio.to_thread(self._token_source)
        self._token = (found or "", now)
        return self._token[0]

    async def connected(self) -> bool:
        return bool(await self.token())

    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                transport=self._transport,
                timeout=TIMEOUT,
                follow_redirects=False,
                headers={"User-Agent": USER_AGENT},
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            with contextlib.suppress(Exception):
                await self._http.aclose()
            self._http = None

    def low(self) -> bool:
        if self.clock() < self.limited_until:
            return True
        return self.remaining is not None and self.remaining < LOW and self.clock() < self.reset_at

    def wait_seconds(self) -> float:
        until = self.limited_until if self.clock() < self.limited_until else 0.0
        if not until and self.low():
            until = self.reset_at
        return max(0.0, until - self.clock())

    def auth(self, token: str) -> dict[str, str]:
        """The Authorization header for a token (a host's own scheme may differ)."""
        return {"Authorization": token if token.startswith("Bearer ") else f"Bearer {token}"}

    def _limited(self, until: float) -> github.RateLimited:
        self.limited_until = max(self.limited_until, until)
        text = f"{self.name}'s rate limit is used up until {_clock(self.limited_until)}."
        return github.RateLimited(self.tr(text), self.limited_until)

    def _note_limits(self, response: httpx.Response) -> None:
        heads = response.headers
        with contextlib.suppress(TypeError, ValueError):
            if "ratelimit-remaining" in heads:
                self.remaining = int(heads["ratelimit-remaining"])
        with contextlib.suppress(TypeError, ValueError):
            if "ratelimit-reset" in heads:
                self.reset_at = float(heads["ratelimit-reset"])

    @staticmethod
    def said(response: httpx.Response) -> str:
        """What the host's error answer says, in its own words (each host's shape)."""
        try:
            body = response.json()
        except ValueError:
            return response.text[:300] if response.text else ""
        if not isinstance(body, dict):
            return ""
        for key in ("message", "error", "error_description", "errorMessages"):
            value = body.get(key)
            if isinstance(value, dict):
                value = value.get("message") or value.get("detail") or ""
            if isinstance(value, list):
                value = "; ".join(str(v) for v in value[:3])
            if value:
                return str(value)[:300]
        return ""

    def problem(self, response: httpx.Response, repo: str) -> github.GitHubError:
        status = response.status_code
        message = self.said(response)
        if status == 429:
            wait = response.headers.get("retry-after", "").strip()
            return self._limited(self.clock() + (int(wait) if wait.isdigit() else SECONDARY_WAIT))
        if status == 401:
            self._token = None  # read it again next time: it may have been replaced
            text = (
                f"{self.name} turned the token down. Paste a fresh one in Eden Code settings › "
                "Git hosts and Jira."
            )
            return github.GitHubError(self.tr(text), status)
        where = repo or "that repository"
        if status == 403:
            text = (
                f"The {self.name} token isn't allowed to do that in {where}. Give it access to "
                "the repository (code, pull requests and pipelines)."
            )
            return github.GitHubError(self.tr(text), status)
        if status == 404:
            text = f"{self.name} can't find {where}, or the token can't see it."
            return github.GitHubError(self.tr(text), status)
        if 400 <= status < 500:
            said = (message or f"HTTP {status}")[:300]
            return github.GitHubError(self.tr(f"{self.name} said no: {said}"), status)
        return github.GitHubError(
            self.tr(f"{self.name} had a problem ({status}). Try again in a moment."), status
        )

    async def send(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
        repo: str = "",
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """One call's answer (an error raised as GitHubError). url: a path on the API or
        an address on it."""
        if self.clock() < self.limited_until:
            raise self._limited(self.limited_until)
        token = await self.token()
        if not token:
            raise github.NotConnected(self.connect_text)
        if not url.startswith("https://"):
            url = f"{self.api}{url}"
        try:
            response = await self.http().request(
                method, url, params=params, json=body, headers={**self.auth(token), **(headers or {})}
            )
        except httpx.HTTPError as exc:
            reason = str(exc) or type(exc).__name__
            raise github.GitHubError(self.tr(f"Couldn't reach {self.name}: {reason[:200]}")) from exc
        self._note_limits(response)
        if response.status_code >= 400:
            raise self.problem(response, repo)
        return response

    async def request(self, method: str, url: str, **kw: Any) -> Any:
        """One call's JSON (None for an empty answer, or one that isn't JSON)."""
        response = await self.send(method, url, **kw)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    async def text(self, url: str, *, repo: str = "") -> str:
        """A plain-text answer (a job's log): its end, LOG_TAIL characters at most."""
        response = await self.send("GET", url, repo=repo, headers={"Accept": "text/plain"})
        return response.text[-LOG_TAIL:] if response.content else ""

    # ── what the desk asks of every host, with GitHub's defaults ──

    async def annotations(self, _ref: Any, _check_id: int) -> list[dict[str, Any]]:
        return []

    async def statuses(self, _ref: Any, _sha: str) -> list[dict[str, Any]]:
        return []

    async def reviews(self, _ref: Any, _number: int) -> list[dict[str, Any]]:
        return []

    async def deployments(self, _ref: Any, _sha: str) -> list[dict[str, Any]]:
        return []

    async def deployment_statuses(self, _ref: Any, _deployment: int) -> list[dict[str, Any]]:
        return []

    def public(self) -> dict[str, Any]:
        return {"kind": self.kind, "name": self.name, "host": self.host}


def number(value: Any) -> int:
    """A whole number from an answer, 0 for anything else."""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def stable_id(text: str) -> int:
    """A positive whole number for an id a host gives as text (Bitbucket's {uuid}s), the
    same every time, so comments are seen once and a check's log found again."""
    return zlib.crc32(text.encode("utf-8", "replace")) or 1
