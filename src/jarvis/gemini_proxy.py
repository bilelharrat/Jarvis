"""Gemini behind Claude Code: a local server that speaks Anthropic's Messages API on one side
and Google's Gemini API on the other, so JARVIS and Jarvis Code run on Gemini with every
tool, picture and streamed word they have on Claude.

It listens on 127.0.0.1 only. The key never lives here: each request carries it (Claude
Code gets it from the Keychain through the provider's apiKeyHelper) and it goes on to
Google and nowhere else. Two kinds of Google key work: a Gemini API key ("AIza…", Google AI
Studio) and a Vertex AI express-mode key ("AQ.…"); the endpoint that accepts a key is
remembered (by a hash of it, not the key).

What's translated:
- system prompt, user and assistant turns (consecutive turns of one role merged), text,
  pictures and PDFs (as inline data), tool calls and their results (pictures in results too);
- tools, as Gemini function declarations with their JSON Schemas, and tool_choice;
- streaming, as Anthropic's server-sent events (message_start, content blocks, text and
  input_json deltas, message_delta with the stop reason and usage, message_stop);
- Gemini's thought signatures, which Gemini 3 needs back with each tool call: kept here by
  tool-call id and put back on the call when Claude Code sends its history again;
- errors, as Anthropic error JSON with the matching status (429 stays a rate limit).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

import httpx

log = logging.getLogger(__name__)

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models"
VERTEX_EXPRESS = "https://aiplatform.googleapis.com/v1/publishers/google/models"
# Google's "-latest" names follow each family's newest model; numbered ones get retired
# (gemini-2.5-flash was, for new keys, in 2026).
SUGGESTED = (
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-flash-lite-latest",
    "gemini-3.8-flash",
    "gemini-3.1-pro-preview",
)


def successor(model: str) -> str | None:
    """Where a retired model's requests go: the newest of its family."""
    for family in ("flash-lite", "pro", "flash"):
        if f"-{family}" in model and not model.endswith("-latest"):
            return f"gemini-{family}-latest"
    return None


DEFAULT_MAX_TOKENS = 8192
FOREIGN_SIGNATURE = "skip_thought_signature_validator"
SIGNATURES_KEPT = 5000

# Added to the system prompt when tools come with a request: what Claude does with tools by
# habit, and Gemini does better when told (it tends to describe a step instead of taking
# it, stop after one call, or answer before checking what an action did).
TOOL_HABITS = """

How to work with your tools:
- When a request needs a tool, call it yourself now; don't describe what you would do or ask whether to do it. Keep calling tools until the request is completely done, then answer.
- Use exactly the parameter names each function declares.
- Operating a screen or a web page: after every action, check what happened (read the page or look at the screen again) before the next one. Prefer acting by name or visible text (press_button, browser_click with text) over coordinates. If something didn't work, try another way (another element, a keyboard shortcut, scrolling to find it, going back) instead of giving up.
- Report what actually happened, from what the tools returned."""

# Schema keywords Gemini's function declarations don't take.
_DROP_SCHEMA = {"$schema", "$id", "$defs", "definitions", "$ref", "$comment", "examples", "default"}


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def clean_schema(schema: Any) -> Any:
    """A tool's JSON Schema as Gemini takes it: without the keywords it rejects."""
    if isinstance(schema, dict):
        return {k: clean_schema(v) for k, v in schema.items() if k not in _DROP_SCHEMA}
    if isinstance(schema, list):
        return [clean_schema(v) for v in schema]
    return schema


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _media(block: dict[str, Any]) -> dict[str, Any] | None:
    source = block.get("source") or {}
    if source.get("type") == "base64" and source.get("data"):
        return {
            "inlineData": {
                "mimeType": source.get("media_type") or "application/octet-stream",
                "data": source["data"],
            }
        }
    if source.get("type") == "text" and source.get("data"):  # a plain-text document
        return {"text": str(source["data"])}
    return None


class Signatures:
    """Gemini's thought signatures by tool-call id, most recent kept."""

    def __init__(self, keep: int = SIGNATURES_KEPT) -> None:
        self.items: OrderedDict[str, str] = OrderedDict()
        self.keep = keep

    def put(self, call_id: str, signature: str) -> None:
        self.items[call_id] = signature
        self.items.move_to_end(call_id)
        while len(self.items) > self.keep:
            self.items.popitem(last=False)

    def get(self, call_id: str) -> str | None:
        return self.items.get(call_id)


def to_gemini(body: dict[str, Any], signatures: Signatures | None = None) -> dict[str, Any]:
    """An Anthropic Messages request as a Gemini generateContent request."""
    names: dict[str, str] = {}  # tool_use id -> tool name, for the results that answer them
    contents: list[dict[str, Any]] = []
    for message in body.get("messages") or []:
        role = "model" if message.get("role") == "assistant" else "user"
        blocks = message.get("content")
        if isinstance(blocks, str):
            blocks = [{"type": "text", "text": blocks}]
        parts: list[dict[str, Any]] = []
        for block in blocks or []:
            kind = block.get("type")
            if kind == "text" and block.get("text"):
                parts.append({"text": block["text"]})
            elif kind in ("image", "document"):
                part = _media(block)
                if part:
                    parts.append(part)
            elif kind == "tool_use":
                names[block.get("id", "")] = block.get("name", "")
                part: dict[str, Any] = {
                    "functionCall": {
                        "name": block.get("name", ""),
                        "args": block.get("input") or {},
                    }
                }
                signature = signatures.get(block.get("id", "")) if signatures else None
                # A call Gemini didn't make (Claude's, before the fallback took over, or one
                # whose signature has aged out) has none, and Gemini 3 turns the whole
                # request down without one: Google's stand-in for history from elsewhere.
                part["thoughtSignature"] = signature or FOREIGN_SIGNATURE
                parts.append(part)
            elif kind == "tool_result":
                result = block.get("content")
                text = _text_of(result)
                response: dict[str, Any] = {"content": text}
                if block.get("is_error"):
                    response = {"error": text or "The tool failed."}
                parts.append(
                    {
                        "functionResponse": {
                            "name": names.get(block.get("tool_use_id", ""), "tool"),
                            "response": response,
                        }
                    }
                )
                for inner in result if isinstance(result, list) else []:
                    if isinstance(inner, dict) and inner.get("type") == "image":
                        part = _media(inner)
                        if part:
                            parts.append(part)
            # thinking and redacted_thinking blocks are Claude's own: nothing to send
        if not parts:
            continue
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].extend(parts)
        else:
            contents.append({"role": role, "parts": parts})
    out: dict[str, Any] = {"contents": contents}
    system = body.get("system")
    system_text = _text_of(system) if not isinstance(system, str) else system
    tools = [t for t in body.get("tools") or [] if t.get("name") and "input_schema" in t]
    if tools:
        system_text = (system_text or "") + TOOL_HABITS
    if system_text:
        out["systemInstruction"] = {"parts": [{"text": system_text}]}
    if tools:
        out["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": t["name"],
                        "description": (t.get("description") or "")[:4000],
                        "parametersJsonSchema": clean_schema(
                            t.get("input_schema") or {"type": "object"}
                        ),
                    }
                    for t in tools
                ]
            }
        ]
        choice = body.get("tool_choice") or {}
        mode = {"auto": "AUTO", "any": "ANY", "tool": "ANY", "none": "NONE"}.get(
            choice.get("type", "auto"), "AUTO"
        )
        config: dict[str, Any] = {"mode": mode}
        if choice.get("type") == "tool" and choice.get("name"):
            config["allowedFunctionNames"] = [choice["name"]]
        out["toolConfig"] = {"functionCallingConfig": config}
    generation: dict[str, Any] = {
        "maxOutputTokens": int(body.get("max_tokens") or DEFAULT_MAX_TOKENS)
    }
    for src, dst in (("temperature", "temperature"), ("top_p", "topP"), ("top_k", "topK")):
        if body.get(src) is not None:
            generation[dst] = body[src]
    if body.get("stop_sequences"):
        generation["stopSequences"] = list(body["stop_sequences"])[:5]
    level = thinking_level(body)
    if level:
        generation["thinkingConfig"] = {"thinkingLevel": level}
    out["generationConfig"] = generation
    return out


def thinking_level(body: dict[str, Any]) -> str | None:
    """How hard Gemini 3 Flash thinks, from what the request asked of Claude: a session that
    thinks (Jarvis Code at high effort and up) gets Gemini's full thinking; one with thinking
    off (JARVIS's voice turns) thinks lightly, about three times faster to the first word.
    None leaves Gemini's default: Pro (thinking lightly, it leaks stray words into its reply
    and writes tool calls out as text instead of making them) and older models, which take
    no level."""
    model = str(body.get("model") or "").removeprefix("google/")
    if not model.startswith("gemini-") or re.match(r"gemini-[12]\b|gemini-[12]\.", model):
        return None
    if "flash" not in model:
        return None
    thinking = body.get("thinking") if isinstance(body.get("thinking"), dict) else {}
    effort = str((body.get("output_config") or {}).get("effort") or "").lower()
    if thinking.get("type") in ("enabled", "adaptive") or effort in ("high", "xhigh", "max"):
        return None
    return "low"


FINISH = {
    "STOP": "end_turn",
    "MAX_TOKENS": "max_tokens",
    "SAFETY": "refusal",
    "RECITATION": "refusal",
}


class Stream:
    """Gemini's streamed chunks in, Anthropic's server-sent events out."""

    def __init__(self, model: str, signatures: Signatures, input_tokens: int = 0) -> None:
        self.model = model
        self.signatures = signatures
        self.index = -1
        self.open_text = False
        self.used_tools = False
        self.finish = ""
        self.input_tokens = input_tokens
        self.output_tokens = 0
        self.blocks: list[dict[str, Any]] = []  # the whole message, for a non-streamed reply

    @staticmethod
    def event(kind: str, data: dict[str, Any]) -> str:
        return f"event: {kind}\ndata: {json.dumps({'type': kind, **data})}\n\n"

    def start(self) -> str:
        message = {
            "id": _new_id("msg"),
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": self.input_tokens, "output_tokens": 0},
        }
        return self.event("message_start", {"message": message})

    def _close_text(self) -> str:
        if not self.open_text:
            return ""
        self.open_text = False
        return self.event("content_block_stop", {"index": self.index})

    def chunk(self, data: dict[str, Any]) -> str:
        out = []
        usage = data.get("usageMetadata") or {}
        if usage:
            self.input_tokens = usage.get("promptTokenCount", self.input_tokens)
            self.output_tokens = usage.get("candidatesTokenCount", self.output_tokens) + usage.get(
                "thoughtsTokenCount", 0
            )
        for candidate in (data.get("candidates") or [])[:1]:
            for part in (candidate.get("content") or {}).get("parts") or []:
                if part.get("thought"):
                    continue  # Gemini's own reasoning: not part of the reply
                if "text" in part and part["text"]:
                    if not self.open_text:
                        self.index += 1
                        self.open_text = True
                        self.blocks.append({"type": "text", "text": ""})
                        out.append(
                            self.event(
                                "content_block_start",
                                {
                                    "index": self.index,
                                    "content_block": {"type": "text", "text": ""},
                                },
                            )
                        )
                    self.blocks[-1]["text"] += part["text"]
                    out.append(
                        self.event(
                            "content_block_delta",
                            {
                                "index": self.index,
                                "delta": {"type": "text_delta", "text": part["text"]},
                            },
                        )
                    )
                elif "functionCall" in part:
                    out.append(self._close_text())
                    call = part["functionCall"]
                    call_id = _new_id("toolu")
                    if part.get("thoughtSignature"):
                        self.signatures.put(call_id, part["thoughtSignature"])
                    self.index += 1
                    self.used_tools = True
                    args = call.get("args") or {}
                    self.blocks.append(
                        {
                            "type": "tool_use",
                            "id": call_id,
                            "name": call.get("name", ""),
                            "input": args,
                        }
                    )
                    out.append(
                        self.event(
                            "content_block_start",
                            {
                                "index": self.index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": call_id,
                                    "name": call.get("name", ""),
                                    "input": {},
                                },
                            },
                        )
                    )
                    out.append(
                        self.event(
                            "content_block_delta",
                            {
                                "index": self.index,
                                "delta": {
                                    "type": "input_json_delta",
                                    "partial_json": json.dumps(args),
                                },
                            },
                        )
                    )
                    out.append(self.event("content_block_stop", {"index": self.index}))
            if candidate.get("finishReason"):
                self.finish = candidate["finishReason"]
        return "".join(out)

    def stop_reason(self) -> str:
        return "tool_use" if self.used_tools else FINISH.get(self.finish, "end_turn")

    def end(self) -> str:
        return (
            self._close_text()
            + self.event(
                "message_delta",
                {
                    "delta": {"stop_reason": self.stop_reason(), "stop_sequence": None},
                    "usage": {"output_tokens": self.output_tokens},
                },
            )
            + self.event("message_stop", {})
        )

    def message(self) -> dict[str, Any]:
        return {
            "id": _new_id("msg"),
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": self.blocks,
            "stop_reason": self.stop_reason(),
            "stop_sequence": None,
            "usage": {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens},
        }


def anthropic_error(status: int, message: str) -> tuple[int, dict[str, Any]]:
    kind = {
        400: "invalid_request_error",
        401: "authentication_error",
        403: "permission_error",
        404: "not_found_error",
        429: "rate_limit_error",
    }.get(status, "api_error")
    if status >= 500:
        status, kind = 529, "overloaded_error"
    return status, {"type": "error", "error": {"type": kind, "message": message}}


class GeminiRelay:
    """The translation and the calls to Google; the HTTP server around it is below."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15))
        self.signatures = Signatures()
        self.endpoints: dict[str, str] = {}  # sha256(key)[:16] -> "gemini" | "vertex"

    def _urls(self, key: str, model: str, stream: bool) -> list[tuple[str, str, dict[str, str]]]:
        method = "streamGenerateContent?alt=sse" if stream else "generateContent"
        gemini = ("gemini", f"{GEMINI_API}/{model}:{method}", {"x-goog-api-key": key})
        vertex = ("vertex", f"{VERTEX_EXPRESS}/{model}:{method}", {"x-goog-api-key": key})
        known = self.endpoints.get(hashlib.sha256(key.encode()).hexdigest()[:16])
        if known == "vertex" or (known is None and key.startswith("AQ.")):
            return [vertex, gemini]
        return [gemini, vertex]

    async def _open(
        self, key: str, model: str, payload: dict[str, Any], stream: bool
    ) -> httpx.Response:
        """The first endpoint that takes this key; the one that did is remembered."""
        last: httpx.Response | None = None
        for name, url, headers in self._urls(key, model, stream):
            request = self.client.build_request(
                "POST", url, json=payload, headers={**headers, "Content-Type": "application/json"}
            )
            response = await self.client.send(request, stream=True)
            if response.status_code in (400, 401, 403, 404) and not last:
                body = (await response.aread()).decode(errors="replace")
                if (
                    "API_KEY_INVALID" in body
                    or "API key not valid" in body
                    or response.status_code in (401, 403)
                    or "not found" in body.lower()
                ):
                    last = response
                    last._jarvis_body = body  # type: ignore[attr-defined]
                    continue  # the other endpoint may take this key
                response._jarvis_body = body  # type: ignore[attr-defined]
                return response
            if response.status_code < 400:
                self.endpoints[hashlib.sha256(key.encode()).hexdigest()[:16]] = name
            return response
        assert last is not None
        return last

    @staticmethod
    async def _error_text(response: httpx.Response) -> str:
        body = getattr(response, "_jarvis_body", None)
        if body is None:
            body = (await response.aread()).decode(errors="replace")
        try:
            return json.loads(body).get("error", {}).get("message", "") or body[:300]
        except ValueError:
            return body[:300] or f"Gemini answered {response.status_code}."

    async def messages(
        self, key: str, body: dict[str, Any]
    ) -> tuple[int, dict[str, Any] | None, AsyncIterator[str] | None]:
        """(status, json, None) for an error or a whole reply; (200, None, events) to stream."""
        model = str(body.get("model") or SUGGESTED[0]).removeprefix("google/")
        payload = to_gemini(body, self.signatures)
        stream = bool(body.get("stream"))
        try:
            response = await self._open(key, model, payload, stream)
            newer = successor(model) if response.status_code == 404 else None
            if newer:
                text = await self._error_text(response)
                if "no longer available" in text or "not found" in text.lower():
                    log.info("gemini: %s is retired; using %s", model, newer)
                    await response.aclose()
                    model = newer
                    response = await self._open(key, model, payload, stream)
        except httpx.HTTPError as exc:
            return (*anthropic_error(529, f"Couldn't reach Gemini ({exc})."), None)
        if response.status_code >= 400:
            text = await self._error_text(response)
            await response.aclose()
            return (*anthropic_error(response.status_code, f"Gemini: {text}"), None)
        converter = Stream(model, self.signatures)
        if not stream:
            try:
                data = json.loads(await response.aread())
            finally:
                await response.aclose()
            converter.chunk(data)
            return 200, converter.message(), None

        async def events() -> AsyncIterator[str]:
            yield converter.start()
            try:
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    piece = converter.chunk(data)
                    if piece:
                        yield piece
            except httpx.HTTPError as exc:
                log.warning("gemini stream broke: %s", exc)
            finally:
                await response.aclose()
            yield converter.end()

        return 200, None, events()


def count_tokens(body: dict[str, Any]) -> int:
    """An estimate (Gemini has its own counter; four characters a token is close enough for
    Claude Code's context bookkeeping)."""
    return max(
        1,
        len(json.dumps(body.get("messages") or [])) // 4
        + len(json.dumps(body.get("system") or "")) // 4
        + len(json.dumps(body.get("tools") or [])) // 4,
    )


def _key_from(headers: Any) -> str:
    key = headers.get("x-api-key") or ""
    auth = headers.get("authorization") or ""
    if not key and auth.lower().startswith("bearer "):
        key = auth[7:]
    return key.strip()


def build_app(relay: GeminiRelay):
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, StreamingResponse
    from starlette.routing import Route

    async def messages(request: Request):
        if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
            return JSONResponse(anthropic_error(403, "Only this Mac.")[1], status_code=403)
        key = _key_from(request.headers)
        if not key:
            status, body = anthropic_error(401, "No Gemini key came with the request.")
            return JSONResponse(body, status_code=status)
        try:
            body = await request.json()
        except ValueError:
            status, err = anthropic_error(400, "That isn't JSON.")
            return JSONResponse(err, status_code=status)
        status, data, events = await relay.messages(key, body)
        if events is None:
            return JSONResponse(data, status_code=status)
        return StreamingResponse(
            events, media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
        )

    async def tokens(request: Request):
        try:
            body = await request.json()
        except ValueError:
            body = {}
        return JSONResponse({"input_tokens": count_tokens(body)})

    return Starlette(
        routes=[
            Route("/v1/messages", messages, methods=["POST"]),
            Route("/v1/messages/count_tokens", tokens, methods=["POST"]),
        ]
    )


class GeminiProxy:
    """The server, started once (on a free port on 127.0.0.1) and shared by every session."""

    def __init__(self) -> None:
        self.relay: GeminiRelay | None = None
        self.port = 0
        self._server: Any = None
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def address(self) -> str:
        return f"http://127.0.0.1:{self.port}" if self.port else ""

    async def start(self) -> str:
        async with self._lock:
            if self.port:
                return self.address
            import uvicorn

            self.relay = GeminiRelay()
            config = uvicorn.Config(
                build_app(self.relay), host="127.0.0.1", port=0, log_level="warning", lifespan="off"
            )
            self._server = uvicorn.Server(config)
            self._task = asyncio.create_task(self._server.serve())
            for _ in range(200):
                if self._server.started and self._server.servers:
                    break
                await asyncio.sleep(0.02)
            sockets = self._server.servers[0].sockets if self._server.servers else []
            self.port = sockets[0].getsockname()[1] if sockets else 0
            log.info("gemini relay on %s", self.address)
            return self.address

    async def close(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)
        if self.relay is not None:
            await self.relay.client.aclose()
        self.port = 0


PROXY = GeminiProxy()
