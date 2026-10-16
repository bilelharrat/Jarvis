"""A Sentry and a Datadog of the tests' own, behind httpx.MockTransport: Sentry's issue,
its latest event and comments; Datadog's events, read and posted. Kept in dicts and lists,
with helpers that sign (or, for Datadog, header) a webhook as each service does. Nothing
ever leaves the machine; every request is recorded."""

import hashlib
import hmac
import json
import re
import time
from typing import Any

import httpx

SENTRY_SECRET = "sentry_client_secret_test"
DATADOG_SECRET = "datadog-header-secret-0123456789"


def sentry_event(frames: list[dict[str, Any]], kind: str = "ZeroDivisionError",
                 value: str = "division by zero") -> dict[str, Any]:  # fmt: skip
    """An event as Sentry's API gives it (frames oldest first, as Sentry lists them)."""
    return {
        "eventID": "ev1",
        "entries": [{"type": "exception", "data": {"values": [
            {"type": kind, "value": value, "stacktrace": {"frames": frames}}]}}],
    }  # fmt: skip


class FakeSentry:
    def __init__(self) -> None:
        self.issues: dict[str, dict[str, Any]] = {}
        self.events: dict[str, dict[str, Any]] = {}
        self.comments: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []
        self.down = False

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            return httpx.Response(500, json={"detail": "down"})
        path = request.url.path
        m = re.match(r"^/api/0/organizations/([^/]+)/issues/([^/]+)/events/latest/$", path)
        if m:
            found = self.events.get(m.group(2))
            return httpx.Response(200, json=found) if found else httpx.Response(404, json={})
        m = re.match(r"^/api/0/organizations/([^/]+)/issues/([^/]+)/$", path)
        if m:
            found = self.issues.get(m.group(2))
            return httpx.Response(200, json=found) if found else httpx.Response(404, json={})
        m = re.match(r"^/api/0/issues/([^/]+)/comments/$", path)
        if m and request.method == "POST":
            self.comments.append({"issue": m.group(1), **json.loads(request.content),
                                  "auth": request.headers.get("authorization", "")})  # fmt: skip
            return httpx.Response(201, json={"id": "c1"})
        return httpx.Response(404, json={"detail": "not found"})


class FakeDatadog:
    def __init__(self) -> None:
        self.events: dict[str, dict[str, Any]] = {}
        self.posted: list[dict[str, Any]] = []
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        m = re.match(r"^/api/v1/events/([^/]+)$", path)
        if m and request.method == "GET":
            found = self.events.get(m.group(1))
            return (
                httpx.Response(200, json={"event": found})
                if found
                else httpx.Response(404, json={})
            )
        if path == "/api/v1/events" and request.method == "POST":
            self.posted.append({**json.loads(request.content), "host": request.url.host,
                                "keys": (request.headers.get("dd-api-key"),
                                         request.headers.get("dd-application-key"))})  # fmt: skip
            return httpx.Response(202, json={"status": "ok"})
        return httpx.Response(404, json={"errors": ["not found"]})


def sentry_body(resource: str = "issue", stamp: float | None = None, **payload: Any):
    """A Sentry webhook's body and its signed headers."""
    body = json.dumps(payload).encode()
    sig = hmac.new(SENTRY_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return body, {
        "sentry-hook-signature": sig,
        "sentry-hook-timestamp": str(int(stamp if stamp is not None else time.time())),
        "sentry-hook-resource": resource,
        "content-type": "application/json",
    }


def datadog_body(secret: str = DATADOG_SECRET, **payload: Any):
    """A Datadog webhook's body (the template's fields) and its custom header."""
    payload.setdefault("date", int(time.time() * 1000))
    body = json.dumps(payload).encode()
    return body, {"x-eden-secret": secret, "content-type": "application/json"}
