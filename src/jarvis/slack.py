"""Slack for Eden Code: its Web API (over httpx), for the messages that start sessions
(features/code_triggers.py) and the replies in their threads, and the check that a request
really came from Slack.

Who Eden is in Slack: the owner's Slack app, its bot token (xoxb-…, pasted in Eden Code
settings, kept in the Keychain and read here through the connectors vault, never written
anywhere else). An @Eden mention in a channel the owner allowed, or /eden there, starts a
session; Eden replies in the message's thread.

A request is Slack's when its X-Slack-Signature is "v0=" and the hex HMAC-SHA256, with the
app's signing secret (also in the Keychain), of "v0:<X-Slack-Request-Timestamp>:<body>",
and that timestamp is within five minutes: a request replayed later isn't.

Nothing here calls a model, and nothing is sent anywhere but slack.com.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import math
import time
from collections.abc import Callable
from typing import Any

import httpx

API = "https://slack.com/api"
TIMEOUT = 20.0
FRESH = 300.0  # seconds a request's timestamp may be old
USER_AGENT = "Eden-Code"


class SlackError(Exception):
    """Why a call didn't work, in words for the owner."""


def verify(secret: str, body: bytes, stamp: str, signature: str, now: float | None = None) -> bool:
    """Whether Slack signed this request (and lately)."""
    if not secret or not signature or not stamp:
        return False
    try:
        when = float(stamp)
    except ValueError:
        return False
    # (NaN is never more than FRESH from now, so it would never go stale: a number only)
    if not math.isfinite(when) or abs((time.time() if now is None else now) - when) > FRESH:
        return False
    base = b"v0:" + stamp.encode("utf-8", "replace") + b":" + body
    expected = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    # As bytes: a header with a byte past ASCII is simply wrong (TypeError on text).
    return hmac.compare_digest(expected.encode(), signature.strip().encode("utf-8", "replace"))


class Client:
    """One Slack app's Web API. token() reads the bot token (blocking; called in a thread).
    transport: the tests' httpx.MockTransport."""

    def __init__(
        self, token: Callable[[], str], *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._token = token
        self._transport = transport
        self._http: httpx.AsyncClient | None = None

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

    async def call(self, method: str, data: dict[str, Any]) -> dict[str, Any]:
        token = await asyncio.to_thread(self._token)
        if not token:
            raise SlackError("Paste the Slack app's bot token in Eden Code settings first.")
        try:
            response = await self.http().post(
                f"{API}/{method}",
                json=data,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
            )
        except httpx.HTTPError as exc:
            raise SlackError(f"Couldn't reach Slack: {str(exc)[:200]}") from exc
        if response.status_code >= 400:
            raise SlackError(f"Slack had a problem ({response.status_code}).")
        try:
            found = response.json()
        except ValueError as exc:
            raise SlackError("Slack's answer wasn't JSON.") from exc
        if not found.get("ok"):
            raise SlackError(f"Slack said no: {str(found.get('error') or 'an error')[:200]}")
        return found

    async def post(self, channel: str, text: str, thread_ts: str = "") -> str:
        """A message in the channel (in a thread when thread_ts is given): its ts."""
        data: dict[str, Any] = {"channel": channel, "text": text[:3000], "unfurl_links": False}
        if thread_ts:
            data["thread_ts"] = thread_ts
        found = await self.call("chat.postMessage", data)
        return str(found.get("ts") or "")
