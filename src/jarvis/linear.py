"""Linear for Eden Code: its GraphQL API (over httpx), for the tickets that start sessions
(features/code_triggers.py), and the check that a webhook really came from Linear.

Who Eden is in Linear: the owner's API key (a personal key of the Linear user that stands
for Eden, pasted in Eden Code settings, kept in the Keychain and read here through the
connectors vault, never written anywhere else). A ticket assigned to that user starts a
session; so does the label the owner names.

A webhook is Linear's when its Linear-Signature header is the hex HMAC-SHA256 of the body
with the webhook's signing secret (also in the Keychain), and its webhookTimestamp is
within a minute: a body replayed later, or signed with anything else, isn't.

Nothing here calls a model, and nothing is sent anywhere but api.linear.app.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import time
from collections.abc import Callable
from typing import Any

import httpx

API = "https://api.linear.app/graphql"
TIMEOUT = 20.0
FRESH = 60.0  # seconds a webhook's timestamp may be old
USER_AGENT = "Eden-Code"


class LinearError(Exception):
    """Why a call didn't work, in words for the owner."""


def verify(secret: str, body: bytes, signature: str) -> bool:
    """Whether the body was signed with the webhook's secret (hex HMAC-SHA256)."""
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    # As bytes: a header with a byte past ASCII (Starlette gives it as Latin-1) is simply
    # wrong, where compare_digest on text raises TypeError for it.
    offered = signature.strip().lower().encode("utf-8", "replace")
    return hmac.compare_digest(expected.encode(), offered)


def fresh(stamp_ms: Any, now: float | None = None) -> bool:
    """Whether a webhook's webhookTimestamp (milliseconds) is within FRESH of now."""
    try:
        stamp = float(stamp_ms) / 1000.0
    except (TypeError, ValueError):
        return False
    return abs((time.time() if now is None else now) - stamp) <= FRESH


class Client:
    """One Linear workspace's API. key() reads the API key (blocking; called in a thread).
    transport: the tests' httpx.MockTransport."""

    def __init__(
        self, key: Callable[[], str], *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._key = key
        self._transport = transport
        self._http: httpx.AsyncClient | None = None
        self._viewer = ""

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

    async def query(self, text: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        key = await asyncio.to_thread(self._key)
        if not key:
            raise LinearError("Paste a Linear API key in Eden Code settings first.")
        try:
            response = await self.http().post(
                API,
                json={"query": text, "variables": variables or {}},
                headers={"Authorization": key, "Content-Type": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise LinearError(f"Couldn't reach Linear: {str(exc)[:200]}") from exc
        if response.status_code in (401, 403):
            raise LinearError("Linear turned the API key down: paste a fresh one.")
        if response.status_code >= 400:
            raise LinearError(f"Linear had a problem ({response.status_code}).")
        try:
            data = response.json()
        except ValueError as exc:
            raise LinearError("Linear's answer wasn't JSON.") from exc
        if data.get("errors"):
            first = data["errors"][0] if isinstance(data["errors"], list) else {}
            message = str((first or {}).get("message") or "an error")[:200]
            raise LinearError(f"Linear said no: {message}")
        return data.get("data") or {}

    async def viewer(self) -> str:
        """The API key's own user id: the user a ticket is assigned to for Eden (asked once)."""
        if not self._viewer:
            found = await self.query("query { viewer { id } }")
            self._viewer = str(((found.get("viewer") or {}).get("id")) or "")
        return self._viewer

    async def comment(self, issue_id: str, body: str) -> None:
        """A comment on the ticket (Markdown)."""
        await self.query(
            "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
            {"input": {"issueId": issue_id, "body": body[:10_000]}},
        )

    # ── Eden's agents (features/code_linear_agents.py) ──

    async def issue_states(self, issue_id: str) -> list[dict[str, str]]:
        """The workflow states of a ticket's team: [{id, name, type}] (type: backlog,
        unstarted, started, completed, canceled, triage)."""
        found = await self.query(
            "query($id: String!) { issue(id: $id) { team { states { nodes { id name type } } } } }",
            {"id": issue_id},
        )
        nodes = (((found.get("issue") or {}).get("team") or {}).get("states") or {}).get("nodes")
        return [
            {"id": str(n.get("id") or ""), "name": str(n.get("name") or ""), "type": str(n.get("type") or "")}
            for n in nodes if isinstance(n, dict) and n.get("id")
        ] if isinstance(nodes, list) else []  # fmt: skip

    async def set_state(self, issue_id: str, state_id: str) -> None:
        """A ticket moved to a workflow state."""
        await self.query(
            "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
            {"id": issue_id, "input": {"stateId": state_id}},
        )

    async def activity(self, session_id: str, kind: str, body: str) -> None:
        """An activity in an agent session (Linear's agent API, with an app's own token):
        kind thought | elicitation | response | error, its body Markdown."""
        await self.query(
            "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
            {"input": {"agentSessionId": session_id, "content": {"type": kind, "body": body[:5000]}}},
        )


def pick_state(states: list[dict[str, str]], names: tuple[str, ...], kind: str = "") -> str:
    """The id of the state a ticket goes to: the first named one there (case aside), else
    the first of that type, else ""."""
    by_name = {s["name"].strip().lower(): s["id"] for s in states}
    for name in names:
        if name.lower() in by_name:
            return by_name[name.lower()]
    return next((s["id"] for s in states if kind and s["type"] == kind), "")
