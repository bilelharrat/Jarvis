"""Git hosts beyond GitHub for Eden Code: GitLab (gitlab.com, or the owner's own), Bitbucket
Cloud and Azure DevOps for pull requests and their checks, and Jira as an issue tracker.

Which host a project is on: its git remote (the one github.remote_for picks: the branch's
upstream remote, else origin, else the only one), in any form git writes:
- github.com: github.parse_remote's, unchanged (a github.RepoRef);
- GitLab: gitlab.com, a host whose name starts with "gitlab." (gitlab.acme.dev), or one
  the owner named in settings (code_hosts_gitlab); a project in groups and subgroups too
  (gitlab.com/acme/web/app);
- Bitbucket: bitbucket.org (https://user@bitbucket.org/team/app.git, git@bitbucket.org:…);
- Azure DevOps: dev.azure.com/org/project/_git/repo, org.visualstudio.com/project/_git/repo
  and their ssh forms (git@ssh.dev.azure.com:v3/org/project/repo).
Anything else is no host Eden Code knows, and the pull request pane says so.

Each host's client (gitlab.py, bitbucket.py, azure.py) answers the pull request desk in
GitHub's shapes (base.py), so features/code_pr.py asks Hosts.client_for(ref) for the
right one and does the rest as it does for GitHub. Jira is jira.py's, used by
features/code_hosts.py.

Tokens: pasted in Eden Code settings › Git hosts and Jira, kept in the Keychain (the
connectors vault, under "code-hosts"), never in a file, a window or a log; else the
host's CLI's when it's installed and signed in (glab, az). A self-hosted GitLab has a
token of its own (gitlab_token:<host>): a gitlab.com token is never sent to another
server, nor one GitLab's to another's.

Nothing here calls a model.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import httpx

from .. import github
from .azure import AzureClient
from .base import NAMES, VAULT, HostRef, RestClient, cli_ready, cli_token, kind_of, vault_get
from .bitbucket import BitbucketClient
from .gitlab import GitLabClient
from .jira import JiraClient

__all__ = [
    "NAMES", "VAULT", "AzureClient", "BitbucketClient", "GitLabClient", "HostRef", "Hosts",
    "JiraClient", "RestClient", "kind_of", "parse_remote", "ref_from", "repo_for",
]  # fmt: skip

KINDS = ("gitlab", "bitbucket", "azure")
_PART = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$")
_AZURE_PART = re.compile(r"^[^/\\\x00-\x1f]{1,128}$")  # (a project's name may have spaces)
_SCHEMES = ("https", "http", "ssh", "git", "git+ssh", "ssh+git")
_HOST = re.compile(r"^[a-z0-9][a-z0-9.-]{0,252}$")


def clean_host(text: Any) -> str:
    """A host as the owner's list keeps it (gitlab.acme.dev), from whatever was pasted;
    "" when it isn't one."""
    raw = str(text or "").strip().lower()
    raw = re.sub(r"^[a-z+]+://", "", raw).split("/", 1)[0].split("@")[-1].split(":", 1)[0]
    return raw if _HOST.match(raw) and "." in raw else ""


def _split(url: str) -> tuple[str, str] | None:
    """(host, path) of a remote's address, in any form git writes."""
    raw = (url or "").strip()
    if not raw or any(c.isspace() for c in raw):
        return None
    if "://" in raw:
        parts = urlsplit(raw)
        if parts.scheme not in _SCHEMES:
            return None
        return (parts.hostname or "").lower().rstrip("."), parts.path
    found = github._SCP.match(raw)
    if found is None:
        return None
    return found.group(1).lower().rstrip("."), found.group(2)


def _gitlab_host(host: str, extra: tuple[str, ...]) -> str:
    """The GitLab a host is ("" when it isn't one): gitlab.com and its ssh aliases
    (gitlab.com-work), a gitlab.* host, or one of the owner's own."""
    if host in extra:
        return host
    if host in ("gitlab.com", "www.gitlab.com", "altssh.gitlab.com") or re.fullmatch(
        r"gitlab\.com-[\w-]+", host
    ):
        return "gitlab.com"
    return host if host.startswith("gitlab.") and host.count(".") >= 2 else ""


def _parts(path: str) -> list[str]:
    return [unquote(p) for p in path.strip("/").split("/") if p]


def _strip_git(name: str) -> str:
    return name[:-4] if name.endswith(".git") else name


def parse_remote(url: str, gitlab_hosts: tuple[str, ...] = ()) -> github.RepoRef | None:
    """The repository a remote's address names: a github.RepoRef for github.com, a
    HostRef for GitLab, Bitbucket and Azure DevOps, None for anything else."""
    found = github.parse_remote(url)
    if found is not None:
        return found
    split = _split(url)
    if split is None:
        return None
    host, path = split
    pieces = _parts(path)
    if not pieces:
        return None
    extra = tuple(h.lower() for h in gitlab_hosts)
    lab = _gitlab_host(host, extra)
    if lab:
        pieces[-1] = _strip_git(pieces[-1])
        if len(pieces) < 2 or len(pieces) > 8 or "-" in pieces:
            return None
        if not all(_PART.match(p) for p in pieces):
            return None
        return HostRef("/".join(pieces[:-1]), pieces[-1], kind="gitlab", host=lab)
    if host in ("bitbucket.org", "www.bitbucket.org", "altssh.bitbucket.org") or re.fullmatch(
        r"bitbucket\.org-[\w-]+", host
    ):
        if len(pieces) != 2:
            return None
        workspace, name = pieces[0], _strip_git(pieces[1])
        if not (_PART.match(workspace) and _PART.match(name)):
            return None
        return HostRef(workspace, name, kind="bitbucket", host="bitbucket.org")
    return _azure(host, pieces)


def _azure(host: str, pieces: list[str]) -> HostRef | None:
    org = project = name = ""
    if host in ("ssh.dev.azure.com", "vs-ssh.visualstudio.com"):
        if len(pieces) != 4 or pieces[0] != "v3":
            return None
        org, project, name = pieces[1], pieces[2], pieces[3]
        host = "dev.azure.com" if host == "ssh.dev.azure.com" else f"{org.lower()}.visualstudio.com"
    elif host == "dev.azure.com":
        if "_git" not in pieces or pieces.index("_git") not in (1, 2):
            return None
        at = pieces.index("_git")
        org = pieces[0]
        project = pieces[1] if at == 2 else ""
        name = pieces[at + 1] if len(pieces) == at + 2 else ""
    elif host.endswith(".visualstudio.com") and host.count(".") == 2:
        org = host.split(".", 1)[0]
        rest = pieces[1:] if pieces and pieces[0].lower() == "defaultcollection" else pieces
        if "_git" not in rest or len(rest) != rest.index("_git") + 2:
            return None
        at = rest.index("_git")
        project = rest[0] if at == 1 else ""
        name = rest[at + 1]
    else:
        return None
    name = _strip_git(name)
    project = project or name  # (a repository named for its project: org/_git/repo)
    if not (org and name and all(_AZURE_PART.match(p) for p in (org, project, name))):
        return None
    if not _PART.match(org):
        return None
    return HostRef(f"{org}/{project}", name, kind="azure", host=host)


def ref_from(tag: str, full: str) -> github.RepoRef:
    """The repository a PullRecord names: its host's tag ("" for GitHub) and owner/name."""
    owner, _, name = full.rpartition("/")
    if not tag:
        return github.RepoRef(*full.split("/", 1))
    kind, _, host = tag.partition(":")
    return HostRef(owner, name, kind=kind, host=host)


def repo_for(folder: Path, gitlab_hosts: tuple[str, ...] = ()) -> tuple[str, github.RepoRef | None]:
    """The folder's remote and the repository it is on any host (None when it's on none
    Eden Code knows). Runs git: call off the loop."""
    name, url = github.remote_for(folder)
    return name, parse_remote(url, gitlab_hosts) if url else None


def token_key(kind: str, host: str) -> str:
    """Where a host's token is kept in the Keychain (base.VAULT): one for gitlab.com,
    Bitbucket, Azure DevOps and Jira each; one for each GitLab of the owner's own."""
    if kind == "gitlab" and host != "gitlab.com":
        return f"gitlab_token:{host}"
    return f"{kind}_token"


def host_token(vault: Any, kind: str, host: str) -> str:
    """A host's token: the one pasted for it, else its CLI's. Blocking."""
    return vault_get(vault, token_key(kind, host)) or cli_token(kind, host)


class Hosts:
    """The clients of one hub's hosts, one for each host, made the first time it's asked.
    vault(): the connectors vault; transports: the tests' MockTransports by kind."""

    def __init__(
        self,
        vault: Callable[[], Any],
        *,
        language: Callable[[], str] = lambda: "en",
        transports: dict[str, httpx.AsyncBaseTransport] | None = None,
    ) -> None:
        self._vault = vault
        self.language = language
        self.transports = transports or {}
        self.clients: dict[str, RestClient] = {}

    def client_for(self, ref: HostRef) -> RestClient:
        made = self.clients.get(ref.tag)
        if made is None:
            make = {"gitlab": GitLabClient, "bitbucket": BitbucketClient, "azure": AzureClient}[ref.kind]
            kind, host = ref.kind, ref.host
            made = make(
                lambda: host_token(self._vault(), kind, host),
                host=host,
                transport=self.transports.get(kind),
                language=self.language,
            )
            self.clients[ref.tag] = made
        return made

    def jira(self, site: str, email: str) -> JiraClient:
        key = f"jira:{site}:{email}"
        made = self.clients.get(key)
        if made is None:
            made = JiraClient(
                lambda: vault_get(self._vault(), "jira_token"),
                site=site,
                email=email,
                transport=self.transports.get("jira"),
                language=self.language,
            )
            self.clients[key] = made
        return made  # type: ignore[return-value]

    def forget(self) -> None:
        """A token changed: each client reads its token again at its next call."""
        for client in self.clients.values():
            client._token = None
            client._login = ""

    async def aclose(self) -> None:
        for client in self.clients.values():
            await client.aclose()


def cli_state() -> dict[str, bool]:
    """Which host CLIs are installed (glab, az). Blocking (a PATH look)."""
    return {kind: cli_ready(kind) for kind in ("gitlab", "azure")}

