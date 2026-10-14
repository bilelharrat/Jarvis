"""A Linear and a Slack of the tests' own, behind httpx.MockTransport: Linear's GraphQL
(viewer, commentCreate) and Slack's chat.postMessage, kept in lists, and helpers that sign
a webhook body as each service does. Nothing ever leaves the machine; every request is
recorded."""

import hashlib
import hmac
import json
import time
from itertools import count
from typing import Any
from urllib.parse import urlencode

import httpx

LINEAR_SECRET = "lin_wh_test_secret"
SLACK_SECRET = "slack_test_signing_secret"


class FakeLinear:
    def __init__(self, viewer: str = "eden-user") -> None:
        self.viewer = viewer
        self.comments: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []
        self.keys: list[str] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.keys.append(request.headers.get("authorization", ""))
        body = json.loads(request.content)
        if "viewer" in body["query"]:
            return httpx.Response(200, json={"data": {"viewer": {"id": self.viewer}}})
        if "commentCreate" in body["query"]:
            self.comments.append(body["variables"]["input"])
            return httpx.Response(200, json={"data": {"commentCreate": {"success": True}}})
        return httpx.Response(200, json={"errors": [{"message": "unknown query"}]})


class FakeSlack:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.ts = count(1)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat.postMessage"):
            body = json.loads(request.content)
            ts = f"1700000000.{next(self.ts):06d}"
            self.posts.append({**body, "ts": ts, "auth": request.headers.get("authorization", "")})
            return httpx.Response(200, json={"ok": True, "ts": ts})
        return httpx.Response(200, json={"ok": False, "error": "unknown_method"})


def linear_body(**payload: Any) -> tuple[bytes, dict[str, str]]:
    """A Linear webhook's body (fresh) and its signature header."""
    payload.setdefault("webhookTimestamp", int(time.time() * 1000))
    body = json.dumps(payload).encode()
    sig = hmac.new(LINEAR_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return body, {"linear-signature": sig, "content-type": "application/json"}


def slack_body(payload: dict[str, Any] | None = None, form: dict[str, str] | None = None,
               stamp: float | None = None) -> tuple[bytes, dict[str, str]]:  # fmt: skip
    """A Slack request's body (JSON, or a slash command's form) and its signed headers."""
    body = urlencode(form).encode() if form is not None else json.dumps(payload).encode()
    ts = str(int(stamp if stamp is not None else time.time()))
    sig = "v0=" + hmac.new(SLACK_SECRET.encode(), b"v0:" + ts.encode() + b":" + body, hashlib.sha256).hexdigest()
    kind = "application/x-www-form-urlencoded" if form is not None else "application/json"
    return body, {"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": kind}
