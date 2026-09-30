"""OpenAI-compatible models behind Claude Code: a local server that speaks Anthropic's
Messages API on one side and OpenAI's Chat Completions API on the other, so JARVIS and Jarvis
Code can run on Ollama or LM Studio on this Mac, or on OpenRouter's, OpenAI's or any other
server that speaks OpenAI's API, with their tools and streamed words.

It listens on 127.0.0.1 only. Each provider has its own path on it (/p/<provider id>), which
a session's ANTHROPIC_BASE_URL names (providers.session_pins). The key never lives here: each
request carries it (Claude Code gets it from the Keychain through the provider's
apiKeyHelper), and it goes on only to the address sealed with that very key in the Keychain
(ProviderStore.relay_target): a request whose key doesn't match goes nowhere. So the relay is
no open proxy: a local program can reach only the providers the owner added, and only with
a key it already has.

What's translated:
- the system prompt, user and assistant turns, text, pictures (as data: URLs, for models
  that see), text documents, tool calls and their results (a result's pictures follow it in
  a user message: tool messages take only text);
- tools, as OpenAI function tools with their JSON Schemas, and tool_choice;
- streaming, as Anthropic's server-sent events (message_start, content blocks, text and
  input_json deltas, message_delta with the stop reason and usage, message_stop). A tool
  call's arguments are gathered and sent whole once they're complete, checked as JSON;
- errors, as Anthropic error JSON; a server that isn't running says so plainly, and isn't
  retried over and over (a 400, which Claude Code shows rather than retries). One that stops
  with an error part-way, breaks off, or isn't a model server at all (a web page at that
  address) ends the stream with Anthropic's error event, never as a quiet, cut-off answer
  taken as done; a whole reply that isn't JSON is a 400 too.

Cost: none of its own. It carries requests a session makes; what the provider charges is
the provider's (a model on this Mac costs nothing).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import secrets
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlsplit

import httpx

from .gemini_proxy import TOOL_HABITS, clean_schema

log = logging.getLogger(__name__)

DEFAULT_MAX_TOKENS = 8192
MAX_BODY = 64 * 1024 * 1024  # bytes of a request Claude Code sends (pictures and all)
REPLY_LIMIT = 16 * 1024 * 1024  # bytes of a whole (non-streamed) reply read back
FINISH = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "content_filter": "refusal",
}
Resolver = Callable[[str, str], str | None]  # (provider id, key) -> its sealed address


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(b.get("text", ""))
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _image_part(block: dict[str, Any]) -> dict[str, Any] | None:
    source = block.get("source") or {}
    if source.get("type") == "base64" and source.get("data"):
        kind = source.get("media_type") or "image/png"
        return {"type": "image_url", "image_url": {"url": f"data:{kind};base64,{source['data']}"}}
    if source.get("type") == "url" and source.get("url"):
        return {"type": "image_url", "image_url": {"url": str(source["url"])}}
    return None


def _document_part(block: dict[str, Any]) -> dict[str, Any]:
    source = block.get("source") or {}
    if source.get("type") == "text" and source.get("data"):
        title = f"{block['title']}\n\n" if block.get("title") else ""
        return {"type": "text", "text": f"{title}{source['data']}"}
    return {"type": "text", "text": "[A document was attached here that this model can't read.]"}


def _user_content(parts: list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    """Plain text when that's all there is (every server takes it), else the parts."""
    if all(p.get("type") == "text" for p in parts):
        return "\n\n".join(p["text"] for p in parts)
    return parts


def to_openai(body: dict[str, Any]) -> dict[str, Any]:
    """An Anthropic Messages request as an OpenAI Chat Completions request."""
    messages: list[dict[str, Any]] = []
    system = body.get("system")
    system_text = system if isinstance(system, str) else _text_of(system)
    tools = [
        t
        for t in body.get("tools") or []
        if isinstance(t, dict) and t.get("name") and "input_schema" in t
    ]
    if tools:
        system_text = (system_text or "") + TOOL_HABITS
    if system_text:
        messages.append({"role": "system", "content": system_text})
    for message in body.get("messages") or []:
        if not isinstance(message, dict):
            continue
        blocks = message.get("content")
        if isinstance(blocks, str):
            blocks = [{"type": "text", "text": blocks}]
        blocks = [b for b in blocks or [] if isinstance(b, dict)]
        if message.get("role") == "assistant":
            text = "".join(str(b.get("text", "")) for b in blocks if b.get("type") == "text")
            calls = [
                {
                    "id": str(b.get("id") or _new_id("call")),
                    "type": "function",
                    "function": {
                        "name": str(b.get("name", "")),
                        "arguments": json.dumps(b.get("input") or {}),
                    },
                }
                for b in blocks
                if b.get("type") == "tool_use"
            ]
            # Thinking blocks are Claude's own: nothing to send.
            if not text and not calls:
                continue
            turn: dict[str, Any] = {"role": "assistant", "content": text or None}
            if calls:
                turn["tool_calls"] = calls
            messages.append(turn)
            continue
        parts: list[dict[str, Any]] = []
        after: list[dict[str, Any]] = []  # a tool result's pictures, sent after the results
        for block in blocks:
            kind = block.get("type")
            if kind == "tool_result":
                result = block.get("content")
                text = _text_of(result) or ("(no output)" if not block.get("is_error") else "")
                if block.get("is_error"):
                    text = f"Error: {text or 'the tool failed.'}"
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": str(block.get("tool_use_id", "")),
                        "content": text,
                    }
                )
                for inner in result if isinstance(result, list) else []:
                    if isinstance(inner, dict) and inner.get("type") == "image":
                        part = _image_part(inner)
                        if part:
                            after.append(part)
            elif kind == "text" and block.get("text"):
                parts.append({"type": "text", "text": str(block["text"])})
            elif kind == "image":
                part = _image_part(block)
                if part:
                    parts.append(part)
            elif kind == "document":
                parts.append(_document_part(block))
        if after:
            after.insert(0, {"type": "text", "text": "The pictures the tool returned:"})
            messages.append({"role": "user", "content": after})
        if parts:
            messages.append({"role": "user", "content": _user_content(parts)})
    out: dict[str, Any] = {
        "model": str(body.get("model") or ""),
        "messages": messages,
        "max_tokens": int(body.get("max_tokens") or DEFAULT_MAX_TOKENS),
        "stream": bool(body.get("stream")),
    }
    if out["stream"]:
        out["stream_options"] = {"include_usage": True}
    if tools:
        out["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": str(t.get("description") or "")[:4000],
                    "parameters": clean_schema(t.get("input_schema") or {"type": "object"}),
                },
            }
            for t in tools
        ]
        choice = body.get("tool_choice") if isinstance(body.get("tool_choice"), dict) else {}
        way = choice.get("type", "auto")
        if way == "tool" and choice.get("name"):
            out["tool_choice"] = {"type": "function", "function": {"name": choice["name"]}}
        else:
            out["tool_choice"] = {"any": "required", "none": "none"}.get(way, "auto")
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p")):
        if body.get(src) is not None:
            out[dst] = body[src]
    if body.get("stop_sequences"):
        out["stop"] = list(body["stop_sequences"])[:4]
    return out


def _json_object(text: str) -> dict[str, Any]:
    """A tool call's gathered arguments as an object; {} when they aren't one (a model that
    wrote half a call, or none)."""
    try:
        value = json.loads(text) if text.strip() else {}
    except (ValueError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


class Stream:
    """OpenAI's streamed chunks in, Anthropic's server-sent events out."""

    def __init__(self, model: str, input_tokens: int = 0) -> None:
        self.model = model
        self.index = -1
        self.open_text = False
        self.calls: dict[int, dict[str, Any]] = {}  # OpenAI's index -> {id, name, args}
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

    def _text(self, text: str) -> str:
        out = [self._flush_calls()]
        if not self.open_text:
            self.index += 1
            self.open_text = True
            self.blocks.append({"type": "text", "text": ""})
            out.append(
                self.event(
                    "content_block_start",
                    {"index": self.index, "content_block": {"type": "text", "text": ""}},
                )
            )
        self.blocks[-1]["text"] += text
        out.append(
            self.event(
                "content_block_delta",
                {"index": self.index, "delta": {"type": "text_delta", "text": text}},
            )
        )
        return "".join(out)

    def _call(self, position: int, delta: dict[str, Any]) -> None:
        raw = delta.get("index")
        key = raw if isinstance(raw, int) and not isinstance(raw, bool) else position
        call = self.calls.setdefault(key, {"id": "", "name": "", "args": ""})
        if delta.get("id"):
            call["id"] = str(delta["id"])
        function = delta.get("function") if isinstance(delta.get("function"), dict) else {}
        if function.get("name") and not call["name"]:
            call["name"] = str(function["name"])
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            call["args"] += arguments
        elif isinstance(arguments, dict):  # a server that sends the object itself
            call["args"] = json.dumps(arguments)

    def _flush_calls(self) -> str:
        """The tool calls gathered so far, each as a whole content block."""
        if not self.calls:
            return ""
        out = [self._close_text()]
        for key in sorted(self.calls):
            call = self.calls[key]
            if not call["name"]:
                continue  # a fragment with no function behind it
            self.index += 1
            self.used_tools = True
            call_id = call["id"] or _new_id("toolu")
            args = _json_object(call["args"])
            self.blocks.append(
                {"type": "tool_use", "id": call_id, "name": call["name"], "input": args}
            )
            out.append(
                self.event(
                    "content_block_start",
                    {
                        "index": self.index,
                        "content_block": {
                            "type": "tool_use",
                            "id": call_id,
                            "name": call["name"],
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
                        "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)},
                    },
                )
            )
            out.append(self.event("content_block_stop", {"index": self.index}))
        self.calls = {}
        return "".join(out)

    def _usage(self, usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
        if isinstance(prompt, int) and not isinstance(prompt, bool):
            self.input_tokens = prompt
        if isinstance(completion, int) and not isinstance(completion, bool):
            self.output_tokens = completion

    def chunk(self, data: dict[str, Any]) -> str:
        """One streamed chunk: its words go out at once; tool calls wait to be whole."""
        out: list[str] = []
        self._usage(data.get("usage"))
        choices = data.get("choices") if isinstance(data.get("choices"), list) else []
        for choice in choices[:1]:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
            # reasoning / reasoning_content: the model's own thinking, not part of the reply
            content = delta.get("content")
            if isinstance(content, str) and content:
                out.append(self._text(content))
            calls = delta.get("tool_calls")
            if isinstance(calls, list):
                if calls:
                    out.append(self._close_text())
                for position, call in enumerate(calls):
                    if isinstance(call, dict):
                        self._call(position, call)
            if choice.get("finish_reason"):
                self.finish = str(choice["finish_reason"])
        return "".join(out)

    def whole(self, data: dict[str, Any]) -> None:
        """A non-streamed reply, read into the same blocks."""
        self._usage(data.get("usage"))
        choices = data.get("choices") if isinstance(data.get("choices"), list) else []
        for choice in choices[:1]:
            message = choice.get("message") if isinstance(choice, dict) else None
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            text = content if isinstance(content, str) else _text_of(content)
            if text:
                self._text(text)
            for position, call in enumerate(message.get("tool_calls") or []):
                if isinstance(call, dict):
                    self._call(position, call)
            if choice.get("finish_reason"):
                self.finish = str(choice["finish_reason"])
        self._flush_calls()
        self._close_text()

    @staticmethod
    def failed(message: str, kind: str = "invalid_request_error") -> str:
        """Anthropic's error event: the stream ends in it, and Claude Code reports it."""
        return (
            f"event: error\ndata: "
            f"{json.dumps({'type': 'error', 'error': {'type': kind, 'message': message}})}\n\n"
        )

    def stop_reason(self) -> str:
        return "tool_use" if self.used_tools else FINISH.get(self.finish, "end_turn")

    def end(self) -> str:
        return (
            self._flush_calls()
            + self._close_text()
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
        413: "request_too_large",
        429: "rate_limit_error",
    }.get(status, "api_error")
    if status >= 500:
        status, kind = 529, "overloaded_error"
    elif status not in (400, 401, 403, 404, 413, 429):
        status = 400
    return status, {"type": "error", "error": {"type": kind, "message": message}}


def _where(upstream: str) -> str:
    return urlsplit(upstream).netloc or upstream


def _local(upstream: str) -> bool:
    from .providers import is_local

    return is_local(urlsplit(upstream).hostname or "")


def _unreachable(upstream: str) -> str:
    if _local(upstream):
        return (
            f"Nothing is answering at {_where(upstream)} on this Mac. Is the model's server "
            "(Ollama, LM Studio…) running?"
        )
    return f"I couldn't reach {_where(upstream)}. Check the address and the internet connection."


def _said(body: bytes, key: str) -> str:
    """A short line from an error reply, with the key never repeated."""
    text = body.decode("utf-8", "replace")
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        data = None
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            text = str(error.get("message") or "")
        elif isinstance(error, str):
            text = error
        else:
            text = str(data.get("message") or data.get("detail") or "")
    elif text.lstrip().startswith("<"):
        return ""
    text = " ".join(text.split())[:300]
    if key and len(key) >= 8 and key[-8:] in text:
        return ""
    return text


class OpenAIRelay:
    """The translation and the calls to the provider; the HTTP server around it is below."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(600, connect=15), follow_redirects=False
        )

    async def _open(
        self, upstream: str, key: str, payload: dict[str, Any], stream: bool
    ) -> httpx.Response:
        """POST it, and once more without what an older server refused (stream_options),
        or with max_completion_tokens for a model that only takes that."""
        url = f"{upstream.rstrip('/')}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": "Jarvis",
        }
        attempts = 0
        while True:
            request = self.client.build_request("POST", url, json=payload, headers=headers)
            response = await self.client.send(request, stream=True)
            attempts += 1
            if response.status_code != 400 or attempts >= 3:
                return response
            said = (await response.aread()).decode("utf-8", "replace")
            response._jarvis_body = said  # type: ignore[attr-defined]
            if "stream_options" in said and "stream_options" in payload:
                payload = {k: v for k, v in payload.items() if k != "stream_options"}
            elif "max_completion_tokens" in said and "max_tokens" in payload:
                payload = {**payload, "max_completion_tokens": payload["max_tokens"]}
                del payload["max_tokens"]
            else:
                return response
            await response.aclose()

    async def messages(
        self, upstream: str, key: str, body: dict[str, Any]
    ) -> tuple[int, dict[str, Any] | None, AsyncIterator[str] | None]:
        """(status, json, None) for an error or a whole reply; (200, None, events) to stream."""
        payload = to_openai(body)
        stream = bool(payload["stream"])
        model = payload["model"]
        try:
            response = await self._open(upstream, key, payload, stream)
        except httpx.ConnectError:
            return (*anthropic_error(400, _unreachable(upstream)), None)
        except httpx.TimeoutException:
            return (*anthropic_error(529, f"{_where(upstream)} didn't answer in time."), None)
        except httpx.HTTPError as exc:
            return (*anthropic_error(529, f"Couldn't reach {_where(upstream)} ({exc})."), None)
        if response.status_code >= 400:
            body_text = getattr(response, "_jarvis_body", None)
            raw = body_text.encode() if body_text is not None else await response.aread()
            await response.aclose()
            said = _said(raw, key)
            where = _where(upstream)
            text = f"{where} answered {response.status_code}" + (f": {said}" if said else ".")
            return (*anthropic_error(response.status_code, text), None)
        converter = Stream(model)
        if not stream:
            try:
                raw = b""
                async for piece in response.aiter_bytes():
                    raw += piece
                    if len(raw) > REPLY_LIMIT:
                        return (*anthropic_error(529, "The model's reply was far too long."), None)
            finally:
                await response.aclose()
            try:
                data = json.loads(raw)
            except (ValueError, RecursionError):  # a web page, say: retrying won't help
                return (*anthropic_error(400, f"{_where(upstream)} didn't answer in JSON."), None)
            converter.whole(data if isinstance(data, dict) else {})
            return 200, converter.message(), None

        async def events() -> AsyncIterator[str]:
            yield converter.start()
            where, heard, failed = _where(upstream), False, ""
            try:
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    heard = True
                    text = line[5:].strip()
                    if text == "[DONE]":
                        break
                    try:
                        data = json.loads(text)
                    except (ValueError, RecursionError):
                        continue
                    if isinstance(data, dict) and isinstance(data.get("error"), dict | str):
                        error = data["error"]
                        said = error.get("message") if isinstance(error, dict) else error
                        said = _said(json.dumps({"error": str(said or "")}).encode(), key)
                        log.warning("openai relay: the stream carried an error")
                        failed = f"{where} stopped with an error" + (f": {said}" if said else ".")
                        break
                    piece = converter.chunk(data) if isinstance(data, dict) else ""
                    if piece:
                        yield piece
            except httpx.HTTPError as exc:
                log.warning("openai relay: the stream broke: %s", exc)
                failed = f"{where}'s answer broke off part-way; try again."
                yield Stream.failed(failed, "api_error")
                return
            finally:
                await response.aclose()
            if not failed and not heard:
                failed = f"{where} answered, but isn't a model server (no streamed reply came)."
            if failed:
                yield Stream.failed(failed)
                return
            yield converter.end()

        return 200, None, events()


def count_tokens(body: dict[str, Any]) -> int:
    """An estimate, as the Gemini relay makes it: four characters a token."""
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


def build_app(relay: OpenAIRelay, resolve: Callable[[], Resolver | None]):
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, StreamingResponse
    from starlette.routing import Route

    def refuse(status: int, message: str) -> JSONResponse:
        code, body = anthropic_error(status, message)
        return JSONResponse(body, status_code=code)

    async def target(request: Request) -> tuple[str, str] | JSONResponse:
        if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
            return refuse(403, "Only this Mac.")
        pid = request.path_params.get("pid", "")
        key = _key_from(request.headers)
        if not key:
            return refuse(401, "No key came with the request.")
        finder = resolve()
        upstream = finder(pid, key) if finder is not None and pid else None
        if not upstream:
            return refuse(401, "That key doesn't belong to a provider added in Settings › Models.")
        return upstream, key

    async def messages(request: Request):
        found = await target(request)
        if isinstance(found, JSONResponse):
            return found
        upstream, key = found
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return refuse(413, "That request is too big.")
        try:
            body = await request.json()
        except (ValueError, RecursionError):
            return refuse(400, "That isn't JSON.")
        if not isinstance(body, dict):
            return refuse(400, "That isn't a Messages request.")
        status, data, events = await relay.messages(upstream, key, body)
        if events is None:
            return JSONResponse(data, status_code=status)
        return StreamingResponse(
            events, media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
        )

    async def tokens(request: Request):
        found = await target(request)
        if isinstance(found, JSONResponse):
            return found
        try:
            body = await request.json()
        except (ValueError, RecursionError):
            body = {}
        return JSONResponse({"input_tokens": count_tokens(body if isinstance(body, dict) else {})})

    return Starlette(
        routes=[
            Route("/p/{pid}/v1/messages", messages, methods=["POST"]),
            Route("/p/{pid}/v1/messages/count_tokens", tokens, methods=["POST"]),
        ]
    )


class OpenAIProxy:
    """The server, started once (on a free port on 127.0.0.1) and shared by every session."""

    def __init__(self) -> None:
        self.relay: OpenAIRelay | None = None
        self.resolve: Resolver | None = None
        self.port = 0
        self._server: Any = None
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def address(self) -> str:
        return f"http://127.0.0.1:{self.port}" if self.port else ""

    def base_for(self, provider_id: str) -> str:
        """What a session's ANTHROPIC_BASE_URL is for this provider ("" while not running)."""
        return f"{self.address}/p/{provider_id}" if self.port else ""

    async def start(self, resolve: Resolver) -> str:
        async with self._lock:
            self.resolve = resolve  # the latest store's: a test's, or the app's one
            if self.port:
                return self.address
            import uvicorn

            self.relay = OpenAIRelay()
            config = uvicorn.Config(
                build_app(self.relay, lambda: self.resolve),
                host="127.0.0.1",
                port=0,
                log_level="warning",
                lifespan="off",
            )
            self._server = uvicorn.Server(config)
            self._task = asyncio.create_task(self._server.serve())
            for _ in range(250):
                if self._server.started and self._server.servers:
                    break
                if self._task.done():
                    break
                await asyncio.sleep(0.02)
            sockets = self._server.servers[0].sockets if self._server.servers else []
            self.port = sockets[0].getsockname()[1] if sockets else 0
            log.info("openai relay on %s", self.address or "nothing (it didn't start)")
            return self.address

    async def close(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)
        if self.relay is not None:
            with contextlib.suppress(Exception):
                await self.relay.client.aclose()
        self.port = 0
        self._server = self._task = self.relay = None


PROXY = OpenAIProxy()


async def ready(store: Any, ref: str | None = None) -> None:
    """The relay listening, when a session will need it: any OpenAI-compatible provider
    added (ref None), or the model ref about to be used being one. A port refused is logged:
    that provider's sessions then say the relay isn't running, nothing else waits."""
    providers = getattr(store, "providers", {}) or {}
    if ref is None:
        needed = any(getattr(p, "kind", "") == "openai" for p in providers.values())
    else:
        needed = store.kind_of(ref) == "openai"
    if not needed:
        return
    try:
        await PROXY.start(store.relay_target)
    except Exception as exc:
        log.warning("openai relay didn't start: %s", exc)


def key_digest(key: str) -> str:
    """How the relay's cache knows a key again, without keeping it."""
    return hashlib.sha256(key.encode("utf-8", "replace")).hexdigest()[:32]
