"""OpenTelemetry for Eden Code, by hand: spans and events as OTLP/HTTP JSON, sent with
urllib to the collector the owner names (no OpenTelemetry SDK: it would be a heavy new
dependency for a few hundred lines of JSON).

What's sent, following OpenTelemetry's GenAI semantic conventions where they fit:

- A trace for each turn: its root span "invoke_agent Eden Code" (gen_ai.operation.name,
  gen_ai.agent.name, gen_ai.provider.name, gen_ai.conversation.id = Claude Code's session
  id, gen_ai.request.model / gen_ai.response.model, gen_ai.usage.input_tokens and
  output_tokens, the cache's tokens, and the turn's cost as eden_code.cost_usd).
- Under it, a span for each step ("execute_tool <tool>": gen_ai.tool.name,
  gen_ai.tool.call.id, gen_ai.tool.type), failed ones with error status; a subagent is an
  "invoke_agent <agent>" span, its own steps events on it (a subagent's steps carry no
  timing of their own).
- An event (an OTLP log record) when a session is first seen, and at the end of each turn,
  with the same figures as the turn's span.

Never sent: file contents, a step's input or output, paths, commands, keys (prefs, the
Keychain, the environment). The owner's prompts and Claude's replies only when they opt in
(code_otel_prompts), and then with secrets blanked out (code_export.redact_secrets) and cut
at PROMPT_CHARS. The resource names the service and its version, never the Mac or the user.

The endpoint: an OTLP/HTTP base address (http://localhost:4318, as
OTEL_EXPORTER_OTLP_ENDPOINT has it: /v1/traces and /v1/logs are added) or a signal's own
address (…/v1/traces: the other one is worked out from it). https anywhere; plain http
only to this Mac or the local network. Headers (a vendor's API key) come only from the
standard OTEL_EXPORTER_OTLP_HEADERS environment variable, read when sending, never kept.

Nothing here calls a model.
"""

from __future__ import annotations

import ipaddress
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .code_export import redact_secrets

SCOPE = "jarvis.code_otel"
SCOPE_VERSION = "1"
PROMPT_CHARS = 8000
TIMEOUT = 10
BATCH_MAX = 500  # spans (or events) in one request
BUFFER_MAX = 5000  # kept waiting while the collector can't be reached; the oldest go first

INTERNAL, CLIENT = 1, 3  # SpanKind
STATUS_UNSET, STATUS_OK, STATUS_ERROR = 0, 1, 2


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


def now_ns() -> int:
    return time.time_ns()


def value(v: Any) -> dict[str, Any]:
    """An OTLP AnyValue (ints as strings, as proto3's JSON has 64-bit ones)."""
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, list | tuple):
        return {"arrayValue": {"values": [value(x) for x in v]}}
    return {"stringValue": str(v)}


def attributes(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"key": k, "value": value(v)} for k, v in attrs.items() if v is not None and v != ""]


@dataclass
class Span:
    name: str
    trace_id: str
    span_id: str = field(default_factory=new_span_id)
    parent_id: str = ""
    kind: int = INTERNAL
    start: int = field(default_factory=now_ns)
    end: int = 0
    attrs: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    status: int = STATUS_UNSET
    message: str = ""

    def event(self, name: str, attrs: dict[str, Any] | None = None) -> None:
        if len(self.events) < 200:
            self.events.append(
                {"timeUnixNano": str(now_ns()), "name": name, "attributes": attributes(attrs or {})}
            )

    def finish(self, error: str = "") -> Span:
        self.end = self.end or now_ns()
        if error:
            self.status, self.message = STATUS_ERROR, error[:200]
            self.attrs.setdefault("error.type", error[:100])
        return self

    def otlp(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "traceId": self.trace_id,
            "spanId": self.span_id,
            "name": self.name,
            "kind": self.kind,
            "startTimeUnixNano": str(self.start),
            "endTimeUnixNano": str(self.end or now_ns()),
            "attributes": attributes(self.attrs),
        }
        if self.parent_id:
            out["parentSpanId"] = self.parent_id
        if self.events:
            out["events"] = self.events
        if self.status:
            out["status"] = {
                "code": self.status,
                **({"message": self.message} if self.message else {}),
            }
        return out


def log_record(
    name: str, attrs: dict[str, Any], trace_id: str = "", span_id: str = ""
) -> dict[str, Any]:
    """An event, as OTLP logs carry them (eventName, and event.name for older collectors)."""
    at = str(now_ns())
    out: dict[str, Any] = {
        "timeUnixNano": at,
        "observedTimeUnixNano": at,
        "severityNumber": 9,
        "severityText": "INFO",
        "eventName": name,
        "body": {"stringValue": name},
        "attributes": attributes({"event.name": name, **attrs}),
    }
    if trace_id:
        out["traceId"] = trace_id
    if span_id:
        out["spanId"] = span_id
    return out


def resource(version: str) -> dict[str, Any]:
    return {
        "attributes": attributes(
            {
                "service.name": "eden-code",
                "service.version": version,
                "telemetry.sdk.name": "jarvis.code_otel",
                "telemetry.sdk.language": "python",
                "telemetry.sdk.version": SCOPE_VERSION,
            }
        )
    }


def traces_body(spans: list[Span], version: str) -> dict[str, Any]:
    return {
        "resourceSpans": [
            {
                "resource": resource(version),
                "scopeSpans": [
                    {
                        "scope": {"name": SCOPE, "version": SCOPE_VERSION},
                        "spans": [s.otlp() for s in spans],
                    }
                ],
            }
        ]
    }


def logs_body(records: list[dict[str, Any]], version: str) -> dict[str, Any]:
    return {
        "resourceLogs": [
            {
                "resource": resource(version),
                "scopeLogs": [
                    {"scope": {"name": SCOPE, "version": SCOPE_VERSION}, "logRecords": records}
                ],
            }
        ]
    }


# ── where it goes ──


def _local_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if host in ("localhost",) or host.endswith((".localhost", ".local")):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def endpoints(given: str) -> tuple[str, str] | None:
    """(traces address, logs address) for the owner's endpoint, or None for one that can't
    be: not http(s), credentials in it, or plain http beyond this Mac and its network."""
    text = (given or "").strip()
    if not text or len(text) > 500 or any(c.isspace() for c in text):
        return None
    try:
        url = urllib.parse.urlsplit(text)
        _ = url.port  # (a port that isn't one raises here)
    except ValueError:
        return None
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        return None
    if url.scheme == "http" and not _local_host(url.hostname):
        return None
    path = url.path.rstrip("/")
    for signal in ("/v1/traces", "/v1/logs"):
        if path.endswith(signal):
            path = path[: -len(signal)]
            break
    base = urllib.parse.urlunsplit((url.scheme, url.netloc, path, "", ""))
    return f"{base}/v1/traces", f"{base}/v1/logs"


def env_headers() -> dict[str, str]:
    """OTEL_EXPORTER_OTLP_HEADERS ("k=v,k2=v2", values URL-encoded), as the spec has it."""
    out: dict[str, str] = {}
    for part in os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "").split(","):
        key, sep, val = part.partition("=")
        key = key.strip()
        if sep and key and all(c.isalnum() or c in "-_" for c in key):
            out[key] = urllib.parse.unquote(val.strip())
    return out


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect is refused: the owner named where their data goes, and only there."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirects)


def post(url: str, body: dict[str, Any], opener: Any = None) -> None:
    """One OTLP/HTTP JSON request; raises OSError (urllib's errors among them) when the
    collector didn't take it. Never follows a redirect."""
    data = json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", **env_headers()},
    )
    with (opener or _OPENER.open)(request, timeout=TIMEOUT) as answer:
        status = getattr(answer, "status", 200)
        if not 200 <= int(status) < 300:
            raise OSError(f"the collector answered {status}")


def prompt_text(text: str) -> str:
    """The owner's words or Claude's, as sent when they opted in: secrets blanked, cut."""
    return redact_secrets(str(text or ""))[:PROMPT_CHARS]


def messages_attr(role: str, text: str) -> str:
    """gen_ai.input.messages / gen_ai.output.messages, as the conventions' JSON has them."""
    return json.dumps(
        [{"role": role, "parts": [{"type": "text", "content": prompt_text(text)}]}],
        ensure_ascii=False,
    )


def provider_of(model: str) -> str:
    """gen_ai.provider.name for a model id (anthropic for Claude's; the rest by name)."""
    m = (model or "").lower()
    for word, name in (
        ("claude", "anthropic"),
        ("gpt", "openai"),
        ("o3", "openai"),
        ("o4", "openai"),
        ("gemini", "gcp.gemini"),
        ("mistral", "mistral_ai"),
        ("deepseek", "deepseek"),
        ("grok", "x_ai"),
    ):
        if word in m:
            return name
    return "anthropic" if not m or m in ("opus", "sonnet", "haiku", "fable") else "other"
