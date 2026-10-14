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
  Keychain at all, nor ever holds a value. The backend reads the values, once the owner has
  let the command go on its card, and makes a socket for that one run (Handoffs.offer) in a
  folder only the owner can open, named by a random nonce. The first process to connect
  (gone as a name the moment it has) gets the run: the backend starts the very command on
  the owner's card itself, with the values in its environment, and sends back only what it
  prints, scrubbed, and its exit status. Unused, the socket goes after a minute; re-running
  secret_run with a nonce already used, or one guessed, gets nothing. The folder and
  secret_run's command line are the owner's, so a session's own commands can find the
  name, and the run goes ahead only when the process that connected is that very command
  (handoff_check: JARVIS's Python running secret_run with this socket and the command on
  the owner's card, started from this backend); and since the values never travel to it,
  even a process the session made to look just like it (arguments can be rewritten) gets
  only the scrubbed output secret_run would have had. (Round 2 wrote the values into a
  named pipe for secret_run to read, which such a process could read first: R2-4.)

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
import re
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

from . import secret_run

log = logging.getLogger(__name__)

TOKEN_PREFIX = "eden-run-"
GRANT_IDLE = 7 * 24 * 3600.0  # seconds a pass may sit unused before it's forgotten
MAX_GRANTS = 4096  # passes kept at once; past it, the one unused longest goes (a live run's last)
MAX_BODY = 64 * 1024 * 1024  # bytes of a request Claude Code sends (pictures and all)
MAX_PATH = 8 * 1024  # characters of a request's path
REQUEST_SECONDS = 120.0  # for a run to send one whole request (an answer may take longer)
PROXY_CONNECTIONS = 256  # open at once, every run together
HEADER_BYTES = 64 * 1024  # a request's line and headers, at most
HANDOFF_SECONDS = 60.0  # seconds a command's run waits for its secret_run to connect
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
        # Another provider's credential headers, and where a request says it came from: a
        # run's own, never sent on (only the key put back in the pass's place goes).
        "x-goog-api-key",
        "api-key",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "forwarded",
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
        # The passes a live run is on (replace_pass: a session's, the conversation's): past
        # MAX_GRANTS the one unused longest goes, but never one of these while there's
        # another to let go (round 3, E16: a session left open a day, unused, lost its pass
        # to a burst of new ones, and its next request failed until it reconnected).
        self._held: set[str] = set()

    def mint(self, route: str, resolve: Resolve) -> str:
        token = TOKEN_PREFIX + secrets.token_hex(24)
        with self._lock:
            self._grants[token] = Grant(route, resolve, self.clock())
            while len(self._grants) > MAX_GRANTS:
                self._evict()
        return token

    def _evict(self) -> None:
        """The pass unused longest, gone; a held one only when every pass is (caller holds
        the lock)."""
        for token in self._grants:
            if token not in self._held:
                del self._grants[token]
                return
        token, _grant = self._grants.popitem(last=False)
        self._held.discard(token)

    def hold(self, token: str, held: bool = True) -> None:
        """A live run is on this pass (or, held False, no longer)."""
        with self._lock:
            if held and token in self._grants:
                self._held.add(token)
            else:
                self._held.discard(token)

    def _live(self, token: str) -> Grant | None:
        """The pass, while it's still good (caller holds the lock)."""
        grant = self._grants.get(token)
        if grant is None:
            return None
        if self.clock() - grant.used > GRANT_IDLE:
            del self._grants[token]
            self._held.discard(token)
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
            self._held.discard(token)

    def clear(self) -> None:
        with self._lock:
            self._grants.clear()
            self._held.clear()


def is_token(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(TOKEN_PREFIX) and len(value) < 128


_PASS = re.compile(re.escape(TOKEN_PREFIX) + r"[0-9a-f]{48}")


def pass_in(settings: Any) -> str:
    """The pass a run's settings (their apiKeyHelper) print, or "" (none: a built-in
    model). For revoking a session's pass when it reconnects with a new one."""
    found = _PASS.search(settings) if isinstance(settings, str) else None
    return found.group(0) if found else ""


def replace_pass(owner: dict[Any, str], key: Any, settings: Any) -> None:
    """A run's new settings: the pass its previous ones printed, if another, revoked (a
    session reconnects with a new pass at every reconnect; the old one was never used
    again, and enough of them pushed live sessions' passes out of the MAX_GRANTS kept)."""
    new = pass_in(settings)
    old = owner.pop(key, "")
    if old and old != new:
        GRANTS.revoke(old)
    if new:
        owner[key] = new
        GRANTS.hold(new)  # (a live run's: the last to go past MAX_GRANTS)


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
        400: "invalid_request_error",
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
                "This run's pass for its key isn't good any more (Eden restarted, or the key "
                "was removed). Start the session again.",
            )
        path = request.path_params.get("path", "")
        parts = path.replace("\\", "/").split("/")
        if not path.startswith("v1/") or any(part in (".", "..") for part in parts):
            return refuse(404, "Only the Messages API goes through here.")
        # Decoded already: a control character, or a # or ? that was %23 or %3F (which
        # would end the path on the way out and turn the rest into a fragment or a query),
        # or a path past reason, isn't a Messages API path.
        whole = str(request.scope.get("path") or "")  # (a route's $ lets a last \n by)
        if len(whole) > MAX_PATH or any(
            c in "#?" or ord(c) < 0x20 or ord(c) == 0x7F for c in whole
        ):
            return refuse(400, "That isn't a path the Messages API has.")
        declared = request.headers.get("content-length") or "0"
        if not declared.isdigit():
            return refuse(400, "That request's length isn't a number.")
        if int(declared) > MAX_BODY:
            return refuse(413, "That request is too big.")
        body = bytearray()
        async for piece in request.stream():  # (a chunked body has no length to check first)
            body += piece
            if len(body) > MAX_BODY:
                return refuse(413, "That request is too big.")
        body = bytes(body)
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
            built = http.build_request(request.method, url, headers=headers, content=body)
        except (httpx.InvalidURL, ValueError, UnicodeError):
            return refuse(400, "That isn't a path the Messages API has.")
        try:
            upstream = await http.send(built, stream=True)
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
        self._sock: socket.socket | None = None
        self._lock = threading.Lock()

    @property
    def address(self) -> str:
        """Where the proxy listens, while it does ("" once its thread has ended: a run
        given a dead address would only fail; ensure() starts it again)."""
        thread = self._thread
        alive = thread is not None and thread.is_alive()
        return f"http://127.0.0.1:{self.port}" if self.port and alive else ""

    def ensure(self) -> str:
        """The proxy listening (started the first time), and its address. The socket is
        bound and listening before this returns, so a run started at once is answered."""
        with self._lock:
            if self.port and self._thread is not None and self._thread.is_alive():
                return self.address
            import uvicorn

            if self._sock is not None:  # (the last one's thread ended: its socket goes too)
                with contextlib.suppress(OSError):
                    self._sock.close()
                self._sock = None
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            sock.listen(128)
            from .hook_listener import guarded_protocol

            config = uvicorn.Config(
                build_app(self.grants),
                log_level="warning",
                lifespan="off",
                access_log=False,
                # A deadline for each whole request (a half-sent one used to be held open for
                # good), a cap on connections and on a request's headers.
                http=guarded_protocol(lambda: PROXY_CONNECTIONS, lambda: REQUEST_SECONDS),
                h11_max_incomplete_event_size=HEADER_BYTES,
            )
            server = uvicorn.Server(config)

            def serve() -> None:
                try:
                    server.run(sockets=[sock])
                except BaseException:  # (said, never silent: the next ensure() starts again)
                    log.exception("the key proxy stopped")
                finally:
                    with contextlib.suppress(OSError):
                        sock.close()

            thread = threading.Thread(target=serve, name="key-proxy", daemon=True)
            thread.start()
            self._server, self._thread, self._sock = server, thread, sock
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


# ── a command's secrets, used by the backend for it ──

SOCKET_PATH_MAX = 100  # characters of a socket's path a Mac takes (104, less a margin)
REQUEST_SECONDS_RUN = 10.0  # for secret_run to say where it runs, once connected
KILL_GRACE = 2.0  # seconds a command has to end after its secret_run went, before KILL


def peer_pid(sock: socket.socket) -> int | None:
    """The process at the other end of a connected Unix socket; None when the system won't
    say (then no one is known, and the run doesn't go ahead)."""
    try:
        if sys.platform == "darwin":
            got = sock.getsockopt(0, 2, 4)  # SOL_LOCAL, LOCAL_PEERPID
            return int.from_bytes(got, sys.byteorder) or None
        if hasattr(socket, "SO_PEERCRED"):
            import struct

            got = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            return struct.unpack("3i", got)[0] or None
    except OSError:
        return None
    return None


class Handoffs:
    """Eden Code commands that use the owner's secrets, each run by the backend itself: a
    socket each, made when the owner has let the command go, taken by the first process to
    connect (that command's secret_run) and gone at once. The values are in no file, in no
    pipe, on no command line and in no environment but the command's own, which this
    process starts: what crosses the socket is the command's output, scrubbed."""

    def __init__(self, folder: Path | None = None, wait: float = HANDOFF_SECONDS) -> None:
        self._folder = folder
        self.wait = wait
        self._lock = threading.Lock()
        self._short: Path | None = None

    def folder(self) -> Path:
        with self._lock:
            if self._folder is None:
                self._folder = Path(tempfile.mkdtemp(prefix="eden-handoff-"))  # 0700
            self._folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            with contextlib.suppress(OSError):
                os.chmod(self._folder, 0o700)
            return self._folder

    def _socket_folder(self) -> Path:
        """The folder, or, when its path is too long for a socket's (a Mac takes 104
        characters), one of the same kind under /tmp."""
        folder = self.folder()
        if len(str(folder)) + 34 <= SOCKET_PATH_MAX:
            return folder
        with self._lock:
            if self._short is None or not self._short.is_dir():
                self._short = Path(tempfile.mkdtemp(prefix="eden-h-", dir="/tmp"))  # 0700
            return self._short

    def offer(
        self,
        values: dict[str, str],
        missing: list[str] | None = None,
        expect: Callable[[str], list[str]] | None = None,
        run_path: str | None = None,
        command: list[str] | None = None,
    ) -> str:
        """The run's socket, ready for one process: when it connects (and only when it is the
        process expect(path) names: its exact arguments, the command the owner let go through
        secret_run with this socket; without expect, any first one, as the tests' own), the
        backend runs command (its argv: the shell, its flags, -c and the owner's line) with
        the values in its environment, and the PATH run_path (the session's; else this
        process's own, never the connecting one's)."""
        if not hasattr(socket, "AF_UNIX") or not command:
            raise OSError("Secrets reach commands through a Unix socket, which this system lacks.")
        path = self._socket_folder() / secrets.token_hex(16)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(path))
            os.chmod(path, 0o600)
            listener.listen(1)
        except OSError:
            listener.close()
            with contextlib.suppress(OSError):
                os.unlink(path)
            raise
        wanted = expect(str(path)) if expect is not None else None
        given = {k: v for k, v in values.items() if isinstance(v, str) and v}
        threading.Thread(
            target=self._serve,
            args=(listener, path, given, list(missing or []), wanted, run_path, list(command)),
            name="secret-run",
            daemon=True,
        ).start()
        return str(path)

    @staticmethod
    def peer_is(conn: socket.socket, wanted: list[str]) -> str:
        """Nothing ("") when the process that connected is the command wanted names; else why
        not (for the log: no values)."""
        from . import handoff_check

        pid = peer_pid(conn)
        if pid is None:
            return "this system won't say who connected"
        return handoff_check.is_expected(pid, wanted, root=os.getpid())

    def _serve(
        self,
        listener: socket.socket,
        path: Path,
        values: dict[str, str],
        missing: list[str],
        wanted: list[str] | None,
        run_path: str | None,
        command: list[str],
    ) -> None:
        listener.settimeout(self.wait)
        try:
            conn, _ = listener.accept()
        except OSError:  # (no one came in time)
            conn = None
        finally:
            # Taken or not, the name goes now: no second process, no one late.
            listener.close()
            with contextlib.suppress(OSError):
                os.unlink(path)
        if conn is None:
            return
        with conn:
            if wanted is not None:
                why = self.peer_is(conn, wanted)
                if why:
                    log.warning("a command's secrets weren't used for it: %s", why)
                    return
            asked = self._request(conn)
            if asked is None:
                return
            self._run(conn, asked, values, missing, run_path, command)

    @staticmethod
    def _request(conn: socket.socket) -> dict[str, Any] | None:
        """What secret_run said: {"cwd": its folder, "env": its environment}; None for
        anything else."""
        conn.settimeout(REQUEST_SECONDS_RUN)
        data = b""
        try:
            while not data.endswith(b"\n"):
                chunk = conn.recv(65536)
                if not chunk:
                    return None
                data += chunk
                if len(data) > secret_run.REQUEST_MAX:
                    return None
            asked = json.loads(data.decode("utf-8", "surrogateescape"))
        except (OSError, ValueError):
            return None
        if not isinstance(asked, dict):
            return None
        env = asked.get("env")
        cwd = asked.get("cwd")
        if not isinstance(env, dict) or not isinstance(cwd, str) or not os.path.isdir(cwd):
            return None
        asked["env"] = {k: v for k, v in env.items() if isinstance(k, str) and isinstance(v, str)}
        return asked

    @staticmethod
    def _run(
        conn: socket.socket,
        asked: dict[str, Any],
        values: dict[str, str],
        missing: list[str],
        run_path: str | None,
        command: list[str],
    ) -> None:
        """The command, run here with the values, its output scrubbed on its way back; it's
        stopped when its secret_run goes (Claude Code's own time limit, a stop)."""
        import signal
        import subprocess

        frame, sent = secret_run.frame, threading.Lock()

        def send(kind: bytes, data: bytes) -> bool:
            try:
                with sent:
                    conn.sendall(frame(kind, data))
                return True
            except OSError:
                return False

        env = secret_run.clean_env(asked["env"], run_path or os.environ.get("PATH", ""))
        placeholders: dict[str, str] = {}
        for name, value in values.items():
            if name.isidentifier():
                env[name] = value
                placeholders[value] = f"${name}"
        for name in missing:
            if isinstance(name, str) and name.isidentifier():
                env.pop(name, None)
                send(
                    secret_run.ERR,
                    f"(Eden: no value is saved for ${name} any more; it's empty here.)\n".encode(),
                )
        conn.settimeout(None)
        try:
            proc = subprocess.Popen(
                command,
                cwd=asked["cwd"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,  # (its whole group goes, should secret_run go)
            )
        except OSError as exc:
            send(secret_run.ERR, f"Eden couldn't start the command: {exc.strerror}\n".encode())
            send(secret_run.EXIT, b"127")
            return

        def pump(source: Any, kind: bytes) -> None:
            scrubber = secret_run.Scrubber(placeholders)
            try:
                while True:
                    chunk = os.read(source.fileno(), secret_run.CHUNK)
                    if not chunk:
                        break
                    out = scrubber.feed(chunk)
                    if out and not send(kind, out):
                        break
                rest = scrubber.end()
                if rest:
                    send(kind, rest)
            except (OSError, ValueError):
                pass

        def stop() -> None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                with contextlib.suppress(OSError):
                    os.killpg(proc.pid, sig)
                try:
                    proc.wait(timeout=KILL_GRACE)
                    return
                except subprocess.TimeoutExpired:
                    continue

        def watch() -> None:
            # secret_run sends nothing more: the end of its side is it gone.
            try:
                while conn.recv(4096):
                    pass
            except OSError:
                pass
            if proc.poll() is None:
                stop()

        pumps = [
            threading.Thread(target=pump, args=(proc.stdout, secret_run.OUT), daemon=True),
            threading.Thread(target=pump, args=(proc.stderr, secret_run.ERR), daemon=True),
        ]
        threading.Thread(target=watch, name="secret-run-watch", daemon=True).start()
        for one in pumps:
            one.start()
        code = proc.wait()
        for one in pumps:
            one.join()
        send(secret_run.EXIT, str(code if code >= 0 else 128 - code).encode())


HANDOFFS = Handoffs()
