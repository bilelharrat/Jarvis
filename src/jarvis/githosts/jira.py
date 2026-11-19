"""Jira for Eden Code, as an issue tracker: the issues the owner's search finds (to pick
one up), an issue's text, a link from it to the pull request that works on it, a comment,
and moving it along its workflow (In Progress when a session starts on it, In Review once
its pull request is open), through Jira's REST API.

Jira Cloud (a site on atlassian.net) speaks API 3: descriptions and comments are
Atlassian Document Format, read here as plain text and written as one plain paragraph.
Jira Data Center and Server speak API 2, in plain text. A link to the pull request is a
remote link with the pull request's address as its global id, so making it again changes
nothing.

Who Eden is in Jira: on Cloud, the owner's email and an API token (id.atlassian.com ›
Security › API tokens), sent as Basic; on Data Center, a personal access token, sent as
Bearer. The token is pasted in Eden Code settings and kept in the Keychain; the site and
email are settings.

Nothing here calls a model, and nothing is sent anywhere but the owner's Jira site.
"""

from __future__ import annotations

import base64
import re
from typing import Any

from .base import RestClient

FIELDS = "summary,status,labels,assignee,reporter,description,issuetype,priority,updated"
KEY = re.compile(r"\b([A-Z][A-Z0-9_]{1,9}-[1-9]\d{0,6})\b")
SITE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,200}\.[a-z]{2,}(?::\d{2,5})?$")
BODY_MAX = 12_000


def clean_site(text: Any) -> str:
    """A Jira site as it's kept: its host (acme.atlassian.net), from whatever was pasted
    (https://acme.atlassian.net/jira/…); "" when it isn't one."""
    raw = str(text or "").strip().lower()
    raw = re.sub(r"^https?://", "", raw).split("/", 1)[0]
    return raw if SITE.match(raw) else ""


def keys_in(*texts: str, branch: str = "") -> list[str]:
    """The Jira issue keys (ABC-123) a title or description names, and a branch name's
    (branches are often written in lower case: abc-123-fix-login), in order."""
    found: list[str] = []
    for text in (branch.upper(), *texts):
        for key in KEY.findall(str(text or "")):
            if key not in found:
                found.append(key)
    return found


def adf_text(node: Any) -> str:
    """Atlassian Document Format as plain text (paragraphs on their own lines)."""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        return str(node.get("text") or "")
    if kind == "hardBreak":
        return "\n"
    if kind in ("mention", "emoji"):
        return str((node.get("attrs") or {}).get("text") or "")
    inner = adf_text(node.get("content") or [])
    if kind in ("paragraph", "heading", "codeBlock", "blockquote", "rule"):
        return inner.rstrip() + "\n"
    if kind == "listItem":
        return "- " + inner.strip() + "\n"
    return inner


def adf(text: str) -> dict[str, Any]:
    """Plain text as a one-paragraph-a-line document (API 3's comment body)."""
    lines = [line for line in str(text or "").splitlines()] or [""]
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": line}] if line else []}
            for line in lines
        ],
    }


def pick_transition(rows: list[dict[str, Any]], names: tuple[str, ...], category: str) -> str:
    """The id of the transition to take: the first whose own name or its status's name is
    one of names (case aside), else the first into a status of that category
    (indeterminate: under way; done), else ""."""
    wanted = [n.strip().lower() for n in names if n and n.strip()]
    for name in wanted:
        for row in rows:
            to = row.get("to") if isinstance(row.get("to"), dict) else {}
            if name in (str(row.get("name") or "").lower(), str(to.get("name") or "").lower()):
                return str(row.get("id") or "")
    for row in rows:
        to = row.get("to") if isinstance(row.get("to"), dict) else {}
        if category and ((to.get("statusCategory") or {}).get("key") == category):
            return str(row.get("id") or "")
    return ""


class JiraClient(RestClient):
    kind = "jira"

    def __init__(self, token: Any, *, site: str, email: str = "", **kw: Any) -> None:
        super().__init__(token, host=site, **kw)
        self.email = email.strip()
        self.cloud = site.endswith(".atlassian.net")
        self.api = f"https://{site}/rest/api/{3 if self.cloud else 2}"

    @property
    def connect_text(self) -> str:
        return self.tr("Add a Jira site and token in Eden Code settings › Git hosts and Jira first.")

    def auth(self, token: str) -> dict[str, str]:
        if self.email and not token.startswith("Bearer "):
            raw = base64.b64encode(f"{self.email}:{token}".encode()).decode("ascii")
            return {"Authorization": f"Basic {raw}"}
        return {"Authorization": token if token.startswith("Bearer ") else f"Bearer {token}"}

    def issue_from(self, raw: dict[str, Any]) -> dict[str, Any]:
        fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
        description = fields.get("description")
        body = adf_text(description) if isinstance(description, dict) else str(description or "")
        key = str(raw.get("key") or "")

        def who(part: Any) -> str:
            part = part if isinstance(part, dict) else {}
            return str(part.get("displayName") or part.get("name") or "")

        return {
            "key": key,
            "title": str(fields.get("summary") or ""),
            "body": body.strip()[:BODY_MAX],
            "url": f"https://{self.host}/browse/{key}" if key else "",
            "status": str((fields.get("status") or {}).get("name") or ""),
            "type": str((fields.get("issuetype") or {}).get("name") or ""),
            "labels": [str(n) for n in fields.get("labels") or [] if isinstance(n, str)][:20],
            "assignee": who(fields.get("assignee")),
            "reporter": who(fields.get("reporter")),
            "updated": str(fields.get("updated") or ""),
        }

    async def myself(self) -> str:
        """The token's own Jira user (an account id on Cloud, a user name on Data Center)."""
        if not self._login:
            me = await self.request("GET", "/myself") or {}
            self._login = str(me.get("accountId") or me.get("name") or "")
        return self._login

    async def search(self, jql: str, limit: int = 30) -> list[dict[str, Any]]:
        """The issues a JQL search finds (the newest updated first, at most limit)."""
        path = "/search/jql" if self.cloud else "/search"
        found = await self.request(
            "GET", path, params={"jql": jql[:2000], "fields": FIELDS, "maxResults": min(limit, 50)},
            repo=self.host,
        )  # fmt: skip
        rows = (found or {}).get("issues") if isinstance(found, dict) else None
        return [self.issue_from(r) for r in rows or [] if isinstance(r, dict)]

    async def issue(self, key: str) -> dict[str, Any]:
        found = await self.request("GET", f"/issue/{key}", params={"fields": FIELDS}, repo=key)
        return self.issue_from(found or {})

    async def comment(self, key: str, text: str) -> None:
        body: Any = adf(text[:30_000]) if self.cloud else text[:30_000]
        await self.request("POST", f"/issue/{key}/comment", body={"body": body}, repo=key)

    async def link(self, key: str, url: str, title: str) -> None:
        """A link on the issue to the pull request (made once: its address is its id)."""
        await self.request(
            "POST", f"/issue/{key}/remotelink",
            body={"globalId": url, "object": {"url": url, "title": title[:250]}}, repo=key,
        )  # fmt: skip

    async def transitions(self, key: str) -> list[dict[str, Any]]:
        found = await self.request("GET", f"/issue/{key}/transitions", repo=key)
        rows = (found or {}).get("transitions") if isinstance(found, dict) else None
        return [r for r in rows or [] if isinstance(r, dict)]

    async def move(self, key: str, names: tuple[str, ...], category: str) -> str:
        """Move the issue to the first of these statuses its workflow offers now (else one
        of that category). The status's name, or "" when there's no such move."""
        rows = await self.transitions(key)
        chosen = pick_transition(rows, names, category)
        if not chosen:
            return ""
        await self.request(
            "POST", f"/issue/{key}/transitions", body={"transition": {"id": chosen}}, repo=key
        )
        row = next((r for r in rows if str(r.get("id")) == chosen), {})
        return str((row.get("to") or {}).get("name") or row.get("name") or "")
