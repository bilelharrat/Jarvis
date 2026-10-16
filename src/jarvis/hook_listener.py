"""A small door of its own for webhooks from the internet: 127.0.0.1 on a fixed port.

Linear and Slack (features/code_triggers.py) can't reach this Mac; the owner runs a tunnel
(cloudflared, ngrok…) that carries their deliveries here. Pointed at the window's main
server, a tunnel had two problems: that server's port is new on every launch (a tunnel
can't follow it), and the tunnel then carried everything that server answers (the pages,
the /f/ links, the WebSocket) to anyone on the internet who has its address. This one is
on a port the owner chooses (code_triggers_port, 8766 unless they say otherwise) and
answers only:

- POST /hooks/<name>, for the names it was given (eden-linear, eden-slack): handed to
  hub.inbound_hook, so the feature's own door checks its token, signature, timestamp,
  Origin, size, rate, lockout and each delivery once, exactly as before. The request is
  marked as having come through here (VIA, in its ASGI scope: nothing a client sends can
  put it there), which is how the main server's copy of these routes tells the two apart.
- GET /health: {"ok": true}, and nothing about the app.

Anything else is a 404, whatever its method. No Server or Date header says what answers.

Connections: everything comes from 127.0.0.1 (the tunnel, or a program on this Mac), so a
limit per address would be one limit for all. Instead each connection has REQUEST_SECONDS
to send a whole request (remote.GuardedH11's deadline: uvicorn itself only times out the
quiet gap between requests), at most CONNECTIONS are open at once (one more is closed at
once, holding no slot), and a request's headers are capped. A few dozen sockets left open
and silent, or one sending a byte a second, used to hold every slot for good: the real
Linear's delivery got a 503.

A taken port is never swapped for another: the tunnel and the addresses pasted into Linear
and Slack name this one. start() says why it couldn't listen (error), and the feature
shows that in its settings and logs it. Before binding, a connection to the port is tried:
on macOS another app's listener on 0.0.0.0 doesn't stop a bind to 127.0.0.1 with
SO_REUSEADDR (which a quick restart needs), and would quietly share the port.

It runs in the app's own event loop (as mcp_endpoint's server does, with the app's signals
left alone), so the feature's door runs where it always did; no thread of its own.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import logging
import socket
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger("jarvis")

VIA = "jarvis.hook_listener"  # the ASGI scope key a request that came through here has
LISTENING = object()  # its value: only this module has it
CONNECTIONS = 128  # open at once
REQUEST_SECONDS = 10.0  # to send one whole request, headers and body
HEADER_BYTES = 16 * 1024  # a request's line and headers, at most


def guarded_protocol(
    connections: Callable[[], int] = lambda: CONNECTIONS,
    seconds: Callable[[], float] = lambda: REQUEST_SECONDS,
) -> Any:
    """remote.GuardedH11 for a server only this Mac reaches (here, and the key proxy): a
    deadline for each whole request and a cap on open connections, without its per-address
    one (every address is 127.0.0.1). The limits are read as each connection comes."""
    from uvicorn.protocols.http.h11_impl import H11Protocol

    from .remote import GuardedH11

    class LocalH11(GuardedH11):
        def connection_made(self, transport: Any) -> None:
            H11Protocol.connection_made(self, transport)
            if len(self.connections) > connections():
                transport.close()
                return
            self._arm(seconds())

        def handle_events(self) -> None:
            H11Protocol.handle_events(self)

        def on_response_complete(self) -> None:
            H11Protocol.on_response_complete(self)
            if not self.transport.is_closing():
                self._arm(seconds())

    return LocalH11


def _protocol() -> Any:
    return guarded_protocol(lambda: CONNECTIONS, lambda: REQUEST_SECONDS)


def _taken(port: int) -> bool:
    """Whether something already answers on 127.0.0.1:port."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.3)
    try:
        return probe.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False
    finally:
        probe.close()


def bind(port: int) -> socket.socket:
    """A listening socket on 127.0.0.1:port; OSError (EADDRINUSE when another app has it)."""
    if _taken(port):
        raise OSError(errno.EADDRINUSE, "in use")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        sock.listen(64)
    except OSError:
        sock.close()
        raise
    sock.setblocking(False)
    return sock


def build_app(names: frozenset[str], dispatch: Callable[[str, Any], Awaitable[Any]]) -> Any:
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    headers = {"Cache-Control": "no-store"}

    def missing() -> JSONResponse:
        return JSONResponse({"error": "not found"}, status_code=404, headers=headers)

    async def hook(request):
        name = request.path_params["name"]
        if name not in names:
            return missing()
        request.scope[VIA] = LISTENING
        status, body = await dispatch(name, request)
        return JSONResponse(body, status_code=status, headers=headers)

    async def health(_request):
        return JSONResponse({"ok": True}, headers=headers)

    async def anything_else(_request):
        return missing()

    every = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    return Starlette(
        routes=[
            Route("/hooks/{name}", hook, methods=["POST"]),
            Route("/health", health, methods=["GET"]),
            Route("/{path:path}", anything_else, methods=every),
        ]
    )


def came_through(request: Any) -> bool:
    """Whether a request reached its door through a HookListener."""
    return (getattr(request, "scope", None) or {}).get(VIA) is LISTENING


class HookListener:
    """The server; start(port) and stop() from the app's loop, close_now() from anywhere."""

    def __init__(
        self,
        names: tuple[str, ...],
        dispatch: Callable[[str, Any], Awaitable[Any]],
        app: Any = None,
    ):
        """app: an ASGI app of the caller's own to serve in place of the hooks' doors (the
        local API of features/code_api.py), with the same port rules, deadlines and caps."""
        self.names = frozenset(names)
        self.dispatch = dispatch
        self.app = app
        self.port = 0  # the port it listens on (0 while it doesn't)
        self.error = ""  # why it couldn't, in words for the owner
        self._server: Any = None
        self._task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self, port: int) -> bool:
        """Listen on 127.0.0.1:port (stopping first on another port). False, with error
        said, when it can't: never on another port."""
        if self.running and self.port == port:
            return True
        await self.stop()
        try:
            sock = bind(port)
        except OSError as exc:
            if exc.errno in (errno.EADDRINUSE, errno.EACCES):
                self.error = (
                    f"Port {port} on this Mac is taken by another app, so Linear and Slack "
                    "can't reach Eden. Quit that app, or choose another port here (and point "
                    "the tunnel at it)."
                )
            else:
                self.error = f"Eden couldn't listen on port {port} ({exc.strerror or exc})."
            log.warning("webhook listener: %s", self.error)
            return False
        import uvicorn

        from .mcp_endpoint import quiet_server

        config = uvicorn.Config(
            self.app if self.app is not None else build_app(self.names, self.dispatch),
            log_level="warning",
            lifespan="off",
            access_log=False,
            proxy_headers=False,
            server_header=False,
            date_header=False,
            http=_protocol(),
            limit_concurrency=CONNECTIONS * 2,  # (connections and requests under way together)
            h11_max_incomplete_event_size=HEADER_BYTES,
            timeout_keep_alive=5,
            timeout_graceful_shutdown=2,
        )
        self._server = quiet_server(config)
        self._task = asyncio.create_task(self._server.serve(sockets=[sock]))
        for _ in range(250):
            if self._server.started or self._task.done():
                break
            await asyncio.sleep(0.02)
        if not self._server.started:
            self.error = f"Eden couldn't listen on port {port}."
            log.warning("webhook listener: %s", self.error)
            await self.stop()
            sock.close()
            return False
        self.port, self.error = port, ""
        log.info("webhook listener on 127.0.0.1:%d", port)
        return True

    async def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)
        self._server = self._task = None
        self.port = 0

    def close_now(self) -> None:
        """The app is quitting (a quit hook, not awaited): stop listening at once; the
        server's task ends with the loop."""
        server = self._server
        if server is None:
            return
        server.should_exit = True
        for each in getattr(server, "servers", []) or []:
            with contextlib.suppress(Exception):
                each.close()
        self.port = 0
