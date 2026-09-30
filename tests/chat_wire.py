"""Local fake chat services on real sockets, for the Slack and Discord adapters.

The adapters talk to them exactly as to the real thing: their own httpx client sends real
HTTP/1.1 requests (their https:// addresses redirected to a plain local port by Redirect),
and the real websockets client opens a real TLS WebSocket to a local server (with a
certificate made for the test). Nothing leaves 127.0.0.1.

A WebSocket connection is handed to the test as a Conn, which the test drives: send
frames, read what the adapter sent, close it with a code."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import ssl
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from jarvis import companion_tls


class Redirect(httpx.AsyncBaseTransport):
    """An adapter's https:// requests, sent over a real connection to the local fake (the
    host it meant is kept in x-original-host)."""

    def __init__(self, port: int) -> None:
        self.port = port
        self.inner = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request.headers["x-original-host"] = request.url.host
        request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=self.port)
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):  # the test's own loop keeps Ctrl-C
        yield


class Seen:
    """One HTTP request as the fake server read it."""

    def __init__(self, method: str, host: str, path: str, headers: dict[str, str], body: bytes):
        self.method, self.host, self.path, self.headers, self.body = (
            method,
            host,
            path,
            headers,
            body,
        )

    def json(self) -> Any:
        return json.loads(self.body or b"{}")


Handler = Callable[[Seen], Awaitable[Response]]


class HTTPFake:
    """A chat app's HTTP API on a local port: every request is recorded, then answered by
    handle(seen)."""

    def __init__(self, handle: Handler) -> None:
        self.handle = handle
        self.seen: list[Seen] = []

        async def endpoint(request: Request) -> Response:
            seen = Seen(
                request.method,
                request.headers.get("x-original-host", ""),
                request.url.path,
                {k.lower(): v for k, v in request.headers.items()},
                await request.body(),
            )
            self.seen.append(seen)
            return await self.handle(seen)

        methods = ["GET", "POST", "PATCH", "PUT", "DELETE"]
        self.app = Starlette(routes=[Route("/{path:path}", endpoint, methods=methods)])

    async def __aenter__(self) -> HTTPFake:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(64)
        sock.setblocking(False)
        self.port = sock.getsockname()[1]
        self.server = _Server(uvicorn.Config(self.app, log_level="warning", lifespan="off"))
        self.task = asyncio.create_task(self.server.serve(sockets=[sock]))
        while not self.server.started:
            if self.task.done():
                self.task.result()
            await asyncio.sleep(0.01)
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.server.should_exit = True
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.task, 10)

    def calls(self, path_end: str) -> list[Seen]:
        return [s for s in self.seen if s.path.endswith(path_end)]


class Conn:
    """One WebSocket connection the adapter opened: what it sent (decoded JSON) arrives in
    .got; the test sends frames and closes it when it likes. auto(msg) may answer a message
    at once (a heartbeat's ack) and returns True when it did."""

    def __init__(self, ws: Any, path: str) -> None:
        self.ws, self.path = ws, path
        self.got: asyncio.Queue = asyncio.Queue()
        self.log: list[Any] = []
        self.auto: Callable[[Conn, Any], Awaitable[bool]] | None = None
        self.done = asyncio.Event()

    async def send(self, frame: Any) -> None:
        await self.ws.send(json.dumps(frame) if not isinstance(frame, str) else frame)

    async def recv(self, timeout: float = 10) -> Any:
        return await asyncio.wait_for(self.got.get(), timeout)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        with contextlib.suppress(Exception):
            await self.ws.close(code, reason)
        self.done.set()

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                self.log.append(msg)
                if self.auto is not None and await self.auto(self, msg):
                    continue
                self.got.put_nowait(msg)
        except Exception:
            pass
        finally:
            self.done.set()


class WSFake:
    """A TLS WebSocket server on a local port: each connection is handed to the test as a
    Conn (in .accepted), and kept open until the test or the adapter closes it."""

    def __init__(self, folder: Path) -> None:
        identity = companion_tls.create(folder, ["127.0.0.1"])
        self.server_ssl = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.server_ssl.load_cert_chain(str(identity.path))
        # The adapter's client trusts this certificate alone (made for the test).
        self.client_ssl = ssl.create_default_context(cafile=str(identity.path))
        self.accepted: asyncio.Queue[Conn] = asyncio.Queue()
        self.count = 0
        self.on_connect: Callable[[Conn], Awaitable[None]] | None = None

    async def _handler(self, ws: Any) -> None:
        self.count += 1
        conn = Conn(ws, ws.request.path if ws.request else "")
        reader = asyncio.create_task(conn._read())
        if self.on_connect is not None:
            await self.on_connect(conn)
        self.accepted.put_nowait(conn)
        await conn.done.wait()
        reader.cancel()
        with contextlib.suppress(BaseException):
            await reader

    async def __aenter__(self) -> WSFake:
        self.server = await serve(self._handler, "127.0.0.1", 0, ssl=self.server_ssl)
        self.port = next(iter(self.server.sockets)).getsockname()[1]
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.server.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.server.wait_closed(), 10)

    def url(self, path: str = "") -> str:
        return f"wss://127.0.0.1:{self.port}{path}"

    def dial(self, max_size: int) -> Callable[[str], Any]:
        """What the adapter uses to connect: the real websockets client, trusting the test's
        certificate."""
        return lambda url: connect(url, ssl=self.client_ssl, max_size=max_size, open_timeout=5)

    async def next(self, timeout: float = 10) -> Conn:
        return await asyncio.wait_for(self.accepted.get(), timeout)


async def until(check: Callable[[], Any], timeout: float = 10, what: str = "") -> Any:
    """Poll until check() is truthy (its value), or fail after timeout seconds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = check()
        if value:
            return value
        if loop.time() > deadline:
            raise AssertionError(f"timed out waiting for {what or check}")
        await asyncio.sleep(0.02)


class Sleeps:
    """asyncio for an adapter's module, with the sleeps its run() loop takes (its waits
    before reconnecting) written down and, while fast is on, cut to nothing: the backoff
    builds without the wait. Every other sleep (a heartbeat's, a 429's) is asyncio's own,
    as is everything else."""

    def __init__(self, callers: tuple[str, ...] = ("run", "_wait")) -> None:
        self.callers = callers
        self.seen: list[float] = []
        self.fast = True

    def __getattr__(self, name: str) -> Any:
        return getattr(asyncio, name)

    async def sleep(self, seconds: float, result: Any = None) -> Any:
        if sys._getframe(1).f_code.co_name not in self.callers:
            return await asyncio.sleep(seconds, result)
        self.seen.append(seconds)
        return await asyncio.sleep(0 if self.fast else seconds, result)
