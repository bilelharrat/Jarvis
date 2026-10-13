"""Keys for Claude Code runs without a Keychain reader anywhere a session can see.

Every Claude Code process JARVIS starts (an Eden Code session, the conversation, a short
background call) runs as the owner, and so does every command it runs. Whatever such a
process is handed, its commands can find: its command line and its environment show in
`ps`. Until now a run on the owner's own key (or Eden Plus's device token) was handed an
apiKeyHelper, JARVIS's own Python with a few lines that read the Keychain entry; the entry
trusts that Python, so any command could run the same line and print the key, the token, or,
with another account name, any secret JARVIS keeps there. Eden Code's secrets went the same
way (secret_run.py, run with a service and account of its own choosing).

Now nothing a run is given reads the Keychain:

- A model key, or Eden Plus's token: the run's ANTHROPIC_BASE_URL is this proxy, on
  127.0.0.1, and its apiKeyHelper only prints a pass made for that run (Grants.mint; a
  random "eden-run-…" that is worth nothing anywhere else). The proxy swaps the pass for
  the real key as each request goes through, and sends it on only to the address the key
  was sealed with in the Keychain (ProviderStore.grant_target), only under /v1/ (the
  Messages API Claude Code speaks), never anywhere a request names. A Gemini or
  OpenAI-compatible provider's run talks to its relay as before, which swaps the pass the
  same way (swap()) and goes on to the address it always did. A pass is for one kind of
  way out: Gemini's can't be spent at OpenRouter, nor an Anthropic key's at Google's relay.
  A pass that sits unused for a week is forgotten, as is every pass when the backend stops.
- An Eden Code secret: the command runs through secret_run.py, which no longer reads the
  Keychain at all. The backend reads the values, once the owner has let the command go on
  its card, and offers them through a named pipe made for that one command (Handoffs.offer)
  in a folder only the owner can open, named by a random nonce. The first reader gets them
  and the pipe is gone the moment it's opened; unread, it goes after a minute. Re-running
  secret_run with a nonce already used, or one guessed, gets nothing.

What a pass still lets a command do, while the backend runs: send a request through the
proxy to the owner's own provider, as the run itself does. It can't take the key away, use
it from another machine, or point it anywhere else. What's beyond this file: the Keychain
entries themselves trust JARVIS's Python, a program any command can still start (see
docs/eden-code-production-plan.md, S1).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import shlex
import socket
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

TOKEN_PREFIX = "eden-run-"
GRANT_IDLE = 7 * 24 * 3600.0  # seconds a pass may sit unused before it's forgotten
MAX_GRANTS = 4096  # passes kept at once; past it, the one unused longest goes
MAX_BODY = 64 * 1024 * 1024  # bytes of a request Claude Code sends (pictures and all)
HANDOFF_SECONDS = 60.0  # seconds a command's secrets wait for it to start
DIRECT = "direct"  # the route of a pass this proxy spends itself
GEMINI = "gemini"  # spent by gemini_proxy
OPENAI = "openai:"  # spent by openai_relay, for one provider: "openai:<id>"
# A request's headers that stay behind: how this hop is carried, and every credential but
# the one put back in its place.
_DROPPED = frozenset(
    (
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "upgrade",
        "proxy-connection",
        "proxy-authorization",
        "x-api-key",
        "authorization",
        "cookie",
    )
)
_DROPPED_BACK = frozenset(("content-length", "connection", "keep-alive", "transfer-encoding"))

Target = tuple[str, str]  # (the address the key may go to, the key)
Resolve = Callable[[], "Target | None"]


# ── passes ──


@dataclass
class Grant:
    route: str
    resolve: Resolve
    used: float


class Grants:
    """The passes made for runs: each one stands for a key the backend looks up as a request
    comes (resolve), so a key replaced or removed in Settings counts at once. Shared by the
    event loop that makes them and the proxy's own thread that spends them."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self._lock = threading.Lock()
        self._grants: OrderedDict[str, Grant] = OrderedDict()

    def mint(self, route: str, resolve: Resolve) -> str:
        token = TOKEN_PREFIX + secrets.token_hex(24)
        with self._lock:
            self._grants[token] = Grant(route, resolve, self.clock())
            while len(self._grants) > MAX_GRANTS:
                self._grants.popitem(last=False)
        return token

    def _live(self, token: str) -> Grant | None:
        """The pass, while it's still good (caller holds the lock)."""
        grant = self._grants.get(token)
        if grant is None:
            return None
        if self.clock() - grant.used > GRANT_IDLE:
            del self._grants[token]
            return None
        return grant

    def alive(self, token: str) -> bool:
        with self._lock:
            return self._live(token) is not None

    def target(self, token: str, route: str) -> Target | None:
        """Where this pass's key may go and the key, for a request on this route; None for a
        pass unknown, gone stale, made for another way out, or whose key isn't there now."""
        if not is_token(token):
            return None
        with self._lock:
            grant = self._live(token)
            if grant is None or not secrets.compare_digest(grant.route, route):
                return None
            grant.used = self.clock()
            self._grants.move_to_end(token)
            resolve = grant.resolve
        try:
            found = resolve()
        except Exception:  # a locked Keychain, a provider gone: this request goes nowhere
            log.warning("a run's key couldn't be looked up", exc_info=False)
            return None
        if not found or not all(isinstance(part, str) and part for part in found):
            return None
        return found

    def revoke(self, token: str) -> None:
        with self._lock:
            self._grants.pop(token, None)

    def clear(self) -> None:
        with self._lock:
            self._grants.clear()


def is_token(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(TOKEN_PREFIX) and len(value) < 128


GRANTS = Grants()


def swap(value: str, route: str) -> str:
    """For a relay: the key a request's pass stands for on this route ("" when it stands for
    none, so the request goes nowhere). Anything that isn't a pass is given back as it came:
    a key a local program already has is its own business, as before."""
    if not is_token(value):
        return value
    found = GRANTS.target(value, route)
    return found[1] if found else ""


def token_helper(token: str, platform: str | None = None) -> str:
    """The apiKeyHelper of a run on a pass: a command that prints the pass and does nothing
    else (Claude Code runs it through /bin/sh on a Mac; through cmd or Git Bash on a PC,
    where it's a script file beside the app's data, run by JARVIS's Python, as before)."""
    if (platform or sys.platform) != "win32":
        return shlex.join(["printf", "%s", token])
    from .providers import helper_command

    return helper_command(sys.executable, _PRINT_CODE, token, platform="win32")


_PRINT_CODE = "import sys\nsys.stdout.write(sys.argv[1])\n"


def _token_from(headers: Any) -> str:
    key = headers.get("x-api-key") or ""
    auth = headers.get("authorization") or ""
    if not key and auth.lower().startswith("bearer "):
        key = auth[7:]
    return key.strip()


def _error(status: int, message: str) -> tuple[int, dict[str, Any]]:
    kind = {
        401: "authentication_error",
        403: "permission_error",
        404: "not_found_error",
        413: "request_too_large",
    }.get(status, "api_error")
    return status, {"type": "error", "error": {"type": kind, "message": message}}


def build_app(grants: Grants, client_factory: Callable[[], Any] | None = None):
    """The proxy: every request under /v1/ that carries a pass, sent on with the key in the
    pass's place to the address sealed with the key, and the answer streamed back as it
    comes. client_factory makes the HTTP client (on the proxy's own loop); tests give one
    with a stand-in transport."""
    import httpx
    from starlette.applications import Starlette
    from starlette.background import BackgroundTask
    from starlette.requests import Request
    from starlette.responses import JSONResponse, StreamingResponse
    from starlette.routing import Route

    made: dict[str, Any] = {}

    def client() -> Any:
        if "client" not in made:
            made["client"] = (
                client_factory()
                if client_factory is not None
                else httpx.AsyncClient(
                    timeout=httpx.Timeout(connect=15.0, read=600.0, write=60.0, pool=15.0),
                    follow_redirects=False,  # (the Mac's own proxy settings, as the run's were)
                )
            )
        return made["client"]

    def refuse(status: int, message: str) -> JSONResponse:
        code, body = _error(status, message)
        return JSONResponse(body, status_code=code)

    async def forward(request: Request):
        if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
            return refuse(403, "Only this Mac.")
        token = _token_from(request.headers)
        found = await asyncio.to_thread(grants.target, token, DIRECT) if token else None
        if found is None:
            return refuse(
                401,
                "This run's pass for its key isn't good any more (Jarvis restarted, or the key "
                "was removed). Start the session again.",
            )
        path = request.path_params.get("path", "")
        parts = path.replace("\\", "/").split("/")
        if not path.startswith("v1/") or any(part in (".", "..") for part in parts):
            return refuse(404, "Only the Messages API goes through here.")
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return refuse(413, "That request is too big.")
        body = await request.body()
        if len(body) > MAX_BODY:
            return refuse(413, "That request is too big.")
        base, key = found
        headers = {k: v for k, v in request.headers.items() if k.lower() not in _DROPPED}
        # The key goes where the pass came: Claude Code's own headers, as without a proxy.
        if request.headers.get("x-api-key"):
            headers["x-api-key"] = key
        if (request.headers.get("authorization") or "").lower().startswith("bearer "):
            headers["authorization"] = f"Bearer {key}"
        url = base.rstrip("/") + "/" + path
        if request.url.query:
            url += "?" + request.url.query
        http = client()
        try:
            upstream = await http.send(
                http.build_request(request.method, url, headers=headers, content=body),
                stream=True,
            )
        except httpx.HTTPError:
            where = httpx.URL(base).host or "the provider"
            return refuse(502, f"I couldn't reach {where}. Check the internet connection.")
        back = {k: v for k, v in upstream.headers.items() if k.lower() not in _DROPPED_BACK}
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            headers=back,
            background=BackgroundTask(upstream.aclose),
        )

    return Starlette(
        routes=[
            Route(
                "/{path:path}",
                forward,
                methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            )
        ]
    )


class KeyProxy:
    """The proxy's server: on a free port on 127.0.0.1, in a thread of its own with its own
    loop, so a run's settings can name its address from anywhere (claude_signin's are made
    in plain functions) and the conversation's loop never waits on a provider."""

    def __init__(self, grants: Grants | None = None) -> None:
        self.grants = grants or GRANTS
        self.port = 0
        self._server: Any = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    @property
    def address(self) -> str:
        return f"http://127.0.0.1:{self.port}" if self.port else ""

    def ensure(self) -> str:
        """The proxy listening (started the first time), and its address. The socket is
        bound and listening before this returns, so a run started at once is answered."""
        with self._lock:
            if self.port and self._thread is not None and self._thread.is_alive():
                return self.address
            import uvicorn

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            sock.listen(128)
            config = uvicorn.Config(
                build_app(self.grants),
                log_level="warning",
                lifespan="off",
                access_log=False,
            )
            server = uvicorn.Server(config)
            thread = threading.Thread(
                target=server.run, kwargs={"sockets": [sock]}, name="key-proxy", daemon=True
            )
            thread.start()
            self._server, self._thread = server, thread
            self.port = sock.getsockname()[1]
            log.info("key proxy on %s", self.address)
            return self.address

    def close(self) -> None:
        with self._lock:
            if self._server is not None:
                self._server.should_exit = True
            if self._thread is not None:
                self._thread.join(timeout=5)
            self._server = self._thread = None
            self.port = 0


PROXY = KeyProxy()


# ── a command's secrets, handed over once ──


class Handoffs:
    """Eden Code secrets on their way to one command: a named pipe each, made when the
    owner has let the command go, read by that command's secret_run and gone at once. The
    values are in no file (a pipe holds what's written only until it's read), on no command
    line and in no environment but the command's own."""

    def __init__(self, folder: Path | None = None, wait: float = HANDOFF_SECONDS) -> None:
        self._folder = folder
        self.wait = wait
        self._lock = threading.Lock()

    def folder(self) -> Path:
        with self._lock:
            if self._folder is None:
                self._folder = Path(tempfile.mkdtemp(prefix="eden-handoff-"))  # 0700
            self._folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            with contextlib.suppress(OSError):
                os.chmod(self._folder, 0o700)
            return self._folder

    def offer(self, values: dict[str, str], missing: list[str] | None = None) -> str:
        """The pipe's path, ready for one reader: the values follow when it opens it."""
        if not hasattr(os, "mkfifo"):
            raise OSError("Secrets reach commands through a named pipe, which this system lacks.")
        path = self.folder() / secrets.token_hex(16)
        os.mkfifo(path, 0o600)
        payload = json.dumps({"values": values, "missing": list(missing or [])}).encode()
        threading.Thread(
            target=self._give, args=(path, payload), name="secret-handoff", daemon=True
        ).start()
        return str(path)

    def _give(self, path: Path, payload: bytes) -> None:
        deadline = time.monotonic() + self.wait
        fd = -1
        try:
            while time.monotonic() < deadline:
                try:
                    fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
                    break
                except OSError:  # no reader yet (ENXIO)
                    time.sleep(0.005)
        finally:
            # Opened or not, the name goes now: no second reader, no one late.
            with contextlib.suppress(OSError):
                os.unlink(path)
        if fd < 0:
            return
        try:
            os.set_blocking(fd, True)
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                view = view[written:]
        except OSError:
            pass
        finally:
            os.close(fd)


HANDOFFS = Handoffs()
