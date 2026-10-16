"""Sentry and Datadog for Eden Code's production alerts (features/code_alerts.py): their
APIs (over httpx), the checks that a webhook really came from them, and the stack trace an
alert is about, read and mapped onto the project's own files.

Who Eden is there: the owner's tokens, pasted in Eden Code settings, kept in the Keychain
(the connectors vault) and read here through a function, never written anywhere else.
Sentry: an internal integration's auth token (scopes event:read and event:write, so it
can read an issue's latest event and comment on it), and the integration's client secret
for its webhooks. Datadog: an API key and an application key (events read and write), and a
secret the owner makes up and puts in the webhook's custom header.

A Sentry webhook is Sentry's when its Sentry-Hook-Signature header is the hex HMAC-SHA256 of
the body with the client secret, and its Sentry-Hook-Timestamp is within FRESH seconds.
Datadog doesn't sign its webhooks: one is Datadog's when its X-Eden-Secret header (the
custom header the owner set on the webhook) is that secret, and the date in its payload
(the template's $DATE) is within DATADOG_FRESH. Either way the feature's own door adds the
hook's random token, a size cap, a rate limit, a lockout, and each delivery once.

Where they're asked: Sentry at the owner's base address (https://sentry.io, a region's, or
their own server's; https only), Datadog at one of its own sites (DATADOG_SITES, nothing
else: the keys never go anywhere the owner didn't pick from that list).

Stack frames: Sentry's from its event's exception entries; Datadog's read out of the
alert's text (Python, JavaScript, Java and Kotlin, Go and Ruby traces). Innermost first.
Each frame's file is matched to the project's own files (git ls-files) by the longest tail
of its path that names exactly one of them, so /srv/app/src/billing/charge.py, webpack:///
./src/App.tsx and app:///main.js find src/billing/charge.py, src/App.tsx and main.js.

Nothing here calls a model; nothing is sent anywhere but the owner's Sentry and Datadog.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlsplit

import httpx

SENTRY_BASE = "https://sentry.io"
DATADOG_SITES = (
    "datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu",
    "ap1.datadoghq.com", "ddog-gov.com",
)  # fmt: skip
FRESH = 300.0  # seconds a Sentry webhook's timestamp may be off
DATADOG_FRESH = 900.0  # a Datadog payload's $DATE (it sends a little later than it happened)
SECRET_MIN = 16  # characters of the Datadog header's secret, at least
TIMEOUT = 20.0
FRAMES_MAX = 40
USER_AGENT = "Eden-Code"
_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AlertError(Exception):
    """Why a call didn't work, in words for the owner."""


# ── is it really them ──


def sentry_verify(secret: str, body: bytes, signature: str) -> bool:
    """Whether the body was signed with the integration's client secret (hex HMAC-SHA256)."""
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    offered = str(signature).strip().lower().encode("utf-8", "replace")
    return hmac.compare_digest(expected.encode(), offered)


def sentry_fresh(stamp: Any, now: float | None = None) -> bool:
    """Whether Sentry-Hook-Timestamp (seconds) is within FRESH of now."""
    try:
        when = float(str(stamp).strip())
    except (TypeError, ValueError):
        return False
    return abs((time.time() if now is None else now) - when) <= FRESH


def datadog_verify(secret: str, offered: str) -> bool:
    """Whether the webhook's X-Eden-Secret header is the owner's secret (long enough)."""
    if not secret or len(secret) < SECRET_MIN or not offered:
        return False
    return hmac.compare_digest(secret.encode(), str(offered).strip().encode("utf-8", "replace"))


def datadog_fresh(date: Any, now: float | None = None) -> bool:
    """Whether a payload's date ($DATE: epoch milliseconds, or seconds) is recent."""
    try:
        when = float(str(date).strip())
    except (TypeError, ValueError):
        return False
    if when > 1e11:  # milliseconds
        when /= 1000.0
    return abs((time.time() if now is None else now) - when) <= DATADOG_FRESH


def sentry_base(text: Any) -> str:
    """The owner's Sentry address, as https://host[:port] ("" when it isn't one)."""
    raw = str(text or "").strip().rstrip("/") or SENTRY_BASE
    try:
        parts = urlsplit(raw)
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    if (
        parts.scheme != "https" or parts.username or parts.password or not _HOST.match(host)
        or parts.path not in ("", "/") or parts.query or parts.fragment
    ):  # fmt: skip
        return ""
    return f"https://{host}" + (f":{parts.port}" if parts.port else "")


def datadog_site(text: Any) -> str:
    site = str(text or "").strip().lower() or DATADOG_SITES[0]
    return site if site in DATADOG_SITES else ""


def plain_id(value: Any) -> str:
    """An id from a payload, kept only when it's plainly one (it goes into an API path)."""
    text = str(value if value is not None else "").strip()
    return text if _ID.match(text) else ""


# ── stack frames ──


@dataclass(frozen=True)
class Frame:
    file: str  # as the service reported it
    line: int = 0
    function: str = ""
    in_app: bool = True
    mapped: str = ""  # the project's own file it is, when one matched

    def public(self) -> dict[str, Any]:
        return {"file": self.file, "line": self.line, "function": self.function,
                "in_app": self.in_app, "mapped": self.mapped}  # fmt: skip


def _int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def sentry_frames(event: Any) -> tuple[str, str, list[Frame]]:
    """(exception type, its message, frames innermost first) from a Sentry event."""
    if not isinstance(event, dict):
        return "", "", []
    values: list[Any] = []
    for entry in event.get("entries") or []:
        if isinstance(entry, dict) and entry.get("type") == "exception":
            data = entry.get("data") if isinstance(entry.get("data"), dict) else {}
            values = data.get("values") if isinstance(data.get("values"), list) else []
    if not values and isinstance(event.get("exception"), dict):  # (a webhook's own event)
        found = event["exception"].get("values")
        values = found if isinstance(found, list) else []
    values = [v for v in values if isinstance(v, dict)]
    if not values:
        return "", "", []
    last = values[-1]  # (the exception raised last; the ones before it caused it)
    trace = last.get("stacktrace") if isinstance(last.get("stacktrace"), dict) else {}
    frames: list[Frame] = []
    for raw in reversed(trace.get("frames") or []):
        if not isinstance(raw, dict):
            continue
        file = str(raw.get("filename") or raw.get("abs_path") or raw.get("absPath")
                   or raw.get("module") or "")[:300]  # fmt: skip
        if not file:
            continue
        frames.append(Frame(file, _int(raw.get("lineNo") or raw.get("lineno")),
                            str(raw.get("function") or "")[:120],
                            raw.get("inApp", raw.get("in_app")) is not False))  # fmt: skip
        if len(frames) >= FRAMES_MAX:
            break
    return str(last.get("type") or "")[:120], str(last.get("value") or "")[:1000], frames


_PY = re.compile(r'File "([^"\n]{1,300})", line (\d{1,7}), in ([^\s\n]{1,120})')
_JS = re.compile(
    r"\bat (?:([^\s()]{1,120}) \()?((?:[a-z]+:/{2,3}|node:)?[^\s():]{1,300}):(\d{1,7}):\d{1,7}\)?"
)
_JAVA = re.compile(
    r"\bat ([\w$.<>]{1,200})\(([\w$.-]{1,120}\.(?:java|kt|scala|groovy)):(\d{1,7})\)"
)
_GO = re.compile(r"^\s*((?:/|\./)?[\w./-]{1,300}\.go):(\d{1,7})", re.MULTILINE)
_RB = re.compile(r"([\w./-]{1,300}\.rb):(\d{1,7}):in [`'](\S{1,120})'")


def text_frames(text: str) -> list[Frame]:
    """Frames read out of a trace in plain text (a Datadog alert's message), innermost
    first. Python lists them outermost first; the others innermost first."""
    text = str(text or "")[:40_000]
    found = [Frame(f, int(n), fn) for f, n, fn in _PY.findall(text)]
    if found:
        return list(reversed(found))[:FRAMES_MAX]
    found = [Frame(f, int(n), fn) for fn, f, n in _JAVA.findall(text)]
    found = found or [Frame(f, int(n), fn) for fn, f, n in _JS.findall(text)]
    found = found or [Frame(f, int(n), fn) for f, n, fn in _RB.findall(text)]
    found = found or [Frame(f, int(n)) for f, n in _GO.findall(text)]
    for i, frame in enumerate(found):
        lowered = frame.file.lower()
        if "node_modules" in lowered or lowered.startswith(("node:", "internal/")):
            found[i] = replace(frame, in_app=False)
    return found[:FRAMES_MAX]


def _tail(path: str) -> list[str]:
    """A frame's path as its parts, with the scheme, ~, ./ and the like taken off."""
    path = re.sub(r"^[a-z][a-z0-9+.-]*:/{2,3}", "", path.strip(), flags=re.IGNORECASE)
    path = path.replace("\\", "/").split("?", 1)[0]
    return [p for p in path.split("/") if p and p not in (".", "~")]


def map_frames(frames: list[Frame], files: list[str]) -> list[Frame]:
    """Each frame with the project's own file it is (the longest tail of its path that
    names exactly one file; a frame in a vendored or installed package matches nothing
    and is left as it came)."""
    by_name: dict[str, list[str]] = {}
    for f in files:
        by_name.setdefault(f.rsplit("/", 1)[-1], []).append(f)
    out = []
    for frame in frames:
        parts = _tail(frame.file)
        mapped = ""
        lowered = frame.file.lower()
        vendored = any(
            v in lowered for v in ("site-packages", "node_modules", "/gems/", "dist-packages")
        )
        if parts and not vendored:
            candidates = by_name.get(parts[-1], [])
            for n in range(len(parts), 0, -1):
                tail = "/".join(parts[-n:])
                hits = [c for c in candidates if c == tail or c.endswith("/" + tail)]
                if len(hits) == 1:
                    mapped = hits[0]
                    break
        out.append(replace(frame, mapped=mapped))
    return out


def fingerprint(service: str, project: str, kind: str, frames: list[Frame], fallback: str) -> str:
    """What makes two alerts the same problem: the exception's type and the innermost
    frame in the project's own code (its file and function), in this project. Without such
    a frame, the service's own grouping (fallback: Sentry's issue, Datadog's monitor)."""
    top = next((f for f in frames if f.mapped and f.in_app), None)
    if top is None:
        return f"{service}:{project}:{fallback}"
    key = f"{project}|{kind}|{top.mapped}|{top.function}"
    return f"{service}:" + hashlib.sha256(key.encode()).hexdigest()[:24]


def trace_text(frames: list[Frame]) -> str:
    """The frames for a session to read: the project's own file and line first, where one
    matched, then what the service said."""
    rows = []
    for f in frames[:FRAMES_MAX]:
        where = f"{f.mapped}:{f.line}" if f.mapped else f"{f.file}:{f.line}"
        said = f" (reported as {f.file})" if f.mapped and f.mapped != f.file else ""
        lib = "" if f.in_app else " [library]"
        rows.append(f"{where} in {f.function or '?'}{said}{lib}")
    return "\n".join(rows)


# ── the APIs ──


class _Http:
    def __init__(self, transport: httpx.AsyncBaseTransport | None) -> None:
        self._transport = transport
        self._http: httpx.AsyncClient | None = None

    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                transport=self._transport, timeout=TIMEOUT, follow_redirects=False,
                headers={"User-Agent": USER_AGENT},
            )  # fmt: skip
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            with contextlib.suppress(Exception):
                await self._http.aclose()
            self._http = None


def _answer(name: str, response: httpx.Response) -> Any:
    if response.status_code in (401, 403):
        raise AlertError(f"{name} turned the token down: paste a fresh one in Eden Code settings.")
    if response.status_code == 404:
        raise AlertError(f"{name} doesn't have that (or the token can't see it).")
    if response.status_code >= 400:
        raise AlertError(f"{name} had a problem ({response.status_code}).")
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as exc:
        raise AlertError(f"{name}'s answer wasn't JSON.") from exc


class Sentry(_Http):
    """The owner's Sentry. token() and base() are read for each call (token: blocking, in a
    thread). transport: the tests' httpx.MockTransport."""

    def __init__(self, token: Callable[[], str], base: Callable[[], str], *,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:  # fmt: skip
        super().__init__(transport)
        self._token, self._base = token, base

    async def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        token = await asyncio.to_thread(self._token)
        if not token:
            raise AlertError("Paste a Sentry auth token in Eden Code settings first.")
        base = sentry_base(self._base())
        if not base:
            raise AlertError("Sentry's address in Eden Code settings isn't an https one.")
        try:
            response = await self.http().request(
                method, f"{base}/api/0{path}", json=body,
                headers={"Authorization": f"Bearer {token}"},
            )  # fmt: skip
        except httpx.HTTPError as exc:
            raise AlertError(f"Couldn't reach Sentry: {str(exc)[:200]}") from exc
        return _answer("Sentry", response)

    async def issue(self, org: str, issue_id: str) -> dict[str, Any]:
        found = await self.call("GET", f"/organizations/{org}/issues/{issue_id}/")
        return found if isinstance(found, dict) else {}

    async def latest_event(self, org: str, issue_id: str) -> dict[str, Any]:
        found = await self.call("GET", f"/organizations/{org}/issues/{issue_id}/events/latest/")
        return found if isinstance(found, dict) else {}

    async def comment(self, issue_id: str, text: str) -> None:
        """A comment on the issue (its activity), in the integration's name."""
        await self.call("POST", f"/issues/{issue_id}/comments/", {"text": text[:5000]})


class Datadog(_Http):
    """The owner's Datadog. keys() gives (API key, application key) (blocking, in a
    thread); site() one of DATADOG_SITES."""

    def __init__(self, keys: Callable[[], tuple[str, str]], site: Callable[[], str], *,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:  # fmt: skip
        super().__init__(transport)
        self._keys, self._site = keys, site

    async def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        api, app = await asyncio.to_thread(self._keys)
        if not (api and app):
            raise AlertError(
                "Paste a Datadog API key and application key in Eden Code settings first."
            )
        site = datadog_site(self._site())
        if not site:
            raise AlertError("Pick your Datadog site in Eden Code settings.")
        try:
            response = await self.http().request(
                method, f"https://api.{site}/api/v1{path}", json=body,
                headers={"DD-API-KEY": api, "DD-APPLICATION-KEY": app},
            )  # fmt: skip
        except httpx.HTTPError as exc:
            raise AlertError(f"Couldn't reach Datadog: {str(exc)[:200]}") from exc
        return _answer("Datadog", response)

    async def event(self, event_id: str) -> dict[str, Any]:
        found = await self.call("GET", f"/events/{event_id}")
        event = found.get("event") if isinstance(found, dict) else None
        return event if isinstance(event, dict) else {}

    async def comment(self, event_id: str, aggregation: str, title: str, text: str) -> None:
        """An event under the alert's own (its related_event_id, and its aggregation key, so
        Datadog's event stream shows it with the alert)."""
        body: dict[str, Any] = {"title": title[:100], "text": text[:4000], "alert_type": "info",
                                "tags": ["source:eden-code"]}  # fmt: skip
        if event_id.isdigit():
            body["related_event_id"] = int(event_id)
        if aggregation:
            body["aggregation_key"] = aggregation[:100]
        await self.call("POST", "/events", body)
