"""Eden on the web reaching Eden on this Mac (docs/accounts.md, "Eden web relay").

askeden.com's Eden runs Claude by itself, but Jarvis (notes, memory, calendar, mail), Code
mode and its projects live here. While the Mac is linked and the switch is on (Settings ›
Account; on unless turned off), the Mac holds one WebSocket to askeden.com
(wss://askeden.com/api/relay/web, the device token in its Authorization header). When the
owner's signed-in browser asks hosted Eden for one of those, askeden.com sends the request
down it as frames; the Mac checks it and passes it to Eden's own server on this Mac
(model-router-ui, http://127.0.0.1:5174), then streams the answer back, server-sent events
as they come. The browser never reaches the Mac itself.

What the Mac checks, whatever askeden.com already did:
- the route: only ALLOWED (Jarvis, its status, Code mode, its projects and changes, the
  morning brief, privacy mode's private turns on a local model). Never
  API keys, adding a project folder, the router dashboard or anything else on that server;
- the asking device: a `web` device (a browser signed in to Eden) of this same account, from
  GET /api/account's device list;
- the body: at most MAX_BODY; Jarvis tools only from JARVIS_TOOLS; Code mode never in
  bypassPermissions from the web.

Frames (askeden.com's side is site/src/accounts/webrelay.js): text frames are JSON, {t: req |
end | cancel | ack} from askeden.com and {t: res | end | error} back; binary frames are the
stream's 16-character id and then up to 64 KiB of body. The Mac keeps at most WINDOW bytes of
an answer unacknowledged, so a slow browser slows the Mac rather than askeden.com's memory.

Nothing that passes is kept or logged (not the bodies, not the queries); the token is never
logged. The line reconnects after 1, 2, 4 … 60 seconds whenever it drops; a 401 means the Mac
was signed out of the account.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

log = logging.getLogger("jarvis")

WS_BASE = "wss://askeden.com/api/relay"
LOCAL = "http://127.0.0.1:5174"  # Eden's server on this Mac (model-router-ui)
LOCAL_ENV = "JARVIS_EDEN_LOCAL_URL"  # another loopback port, for a test copy of Eden
EDEN_LINK_PREF = "account_eden_link"  # Settings: Eden on the web reaches this Mac (on by default)

ID_BYTES = 16
MAX_FRAME = 64 * 1024  # a binary frame's body, each way
MAX_CONTROL = 16 * 1024  # a text frame
MAX_BODY = 10 * 1024 * 1024  # a request's body
MAX_STREAMS = 16  # requests at once (askeden.com's limit per account)
WINDOW = 256 * 1024  # answer bytes sent ahead of askeden.com's acks
BODY_SECONDS = 60.0  # for a request's body to arrive in full
FRESH_SECONDS = 30.0  # the device list is asked again for one unknown browser at most this often
FRESH_GAP = 2.0  # and for any at most this often
BACKOFF_MOST = 60.0
BACKOFF_MISSING = 600.0  # askeden.com without the web relay yet: look again every 10 minutes
STEADY_SECONDS = 30.0
OPEN_SECONDS = 15.0
LOCAL_TIMEOUT = httpx.Timeout(connect=5.0, read=15 * 60.0, write=30.0, pool=10.0)

# The routes Eden on the web may use here: (method, path). The same list as askeden.com's
# MAC_ROUTES; both have to agree for anything to pass.
ALLOWED = frozenset(
    {
        ("GET", "/api/chat/jarvis/status"),
        ("POST", "/api/chat/jarvis"),
        ("GET", "/api/chat/projects"),
        ("POST", "/api/chat/code"),
        ("POST", "/api/chat/code/steer"),
        ("GET", "/api/chat/code/changes"),
        ("POST", "/api/chat/brief"),  # the morning brief and meeting prep: reads only
        # Meetings' action items (a read and a model call), the Activity timeline (a read) and
        # its Undo: only Jarvis's own actions from the web, each on the owner's card (_check).
        ("POST", "/api/chat/meetings/actions"),
        ("GET", "/api/chat/actions"),
        ("POST", "/api/chat/actions/undo"),
        # A chat turn that uses the Mac (Eden's src/chat/mac.ts): its files and project knowledge,
        # read only, through Jarvis's tools below (each behind Jarvis's own cards).
        ("POST", "/api/chat/mac/send"),
        # Privacy mode (Eden's src/chat/local-provider.ts): a private turn, answered only by a
        # local model here, never a cloud one; any other send is refused (_check). The local
        # models it may use, for the page's picker.
        ("POST", "/api/chat/send"),
        ("GET", "/api/chat/local"),
    }
)
QUERIES = {"/api/chat/code/changes": {"project"}}  # the only route with a query, and its keys
# Jarvis's tools Eden's page uses (docs/chat-api.md). A new tool isn't reachable from the web
# until it's added here. Sends and calendar changes still need confirm: true (Eden's server)
# and the owner's card in Jarvis.
JARVIS_TOOLS = frozenset(
    {
        "search_notes",
        "read_note",
        "recall",
        "calendar",
        "calendar_create",
        "calendar_update",
        "calendar_delete",
        "notify_me",
        "mail_accounts",
        "mail_search",
        "mail_read",
        "mail_draft",
        "mail_send",
        # Memory in Eden: listing is free; each change still needs confirm: true and the
        # owner's card in Jarvis (mcp_endpoint's memory_update / delete / toggle).
        "memory_list",
        "memory_update",
        "memory_delete",
        "memory_toggle",
        "commitments",
        # Meetings, browser tasks and undo (eden_meetings, eden_browser, eden_actions): reads
        # are free; a promise kept, a browser task started and an undo each wait on the
        # owner's card in Jarvis (and need confirm: true where they change something).
        "meetings_list",
        "meeting_read",
        "commitment_add",
        "browser_task",
        "browser_task_status",
        "browser_task_stop",
        "actions_list",
        "action_undo",
        # "Use my Mac" (eden_files, eden_screen, eden_knowledge): all read only; files ask once
        # per app on a card, the screen on every look; indexing writes only Jarvis's own index.
        "files_search",
        "file_read",
        "file_summarize",
        "screen_context",
        "knowledge_add_folder",
        "knowledge_list",
        "knowledge_search",
    }
)
BRIEF_KINDS = frozenset({"brief", "events", "prep"})  # POST /api/chat/brief's kinds: all reads
_ID = re.compile(r"[0-9a-f]{16}")
_DEVICE = re.compile(r"[0-9a-f]{16}")
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}

Connect = Callable[..., Any]


def _connect() -> Connect:
    from websockets.asyncio.client import connect

    return connect


def local_url(env: dict[str, str] | None = None) -> str:
    """Eden's server: LOCAL, or JARVIS_EDEN_LOCAL_URL when that is a loopback http address."""
    wanted = (env if env is not None else os.environ).get(LOCAL_ENV, "").strip()
    if wanted:
        parts = urlsplit(wanted)
        if parts.scheme == "http" and parts.hostname in _LOOPBACK and not parts.path.strip("/"):
            return wanted.rstrip("/")
        log.warning("eden link: %s isn't a loopback http address; using %s", LOCAL_ENV, LOCAL)
    return LOCAL


def route_of(method: str, target: str) -> tuple[str, str] | None:
    """(method, path) when the request is one Eden on the web may make here; None if not."""
    if not isinstance(method, str) or not isinstance(target, str) or len(target) > 4096:
        return None
    if not target.startswith("/") or target.startswith("//"):
        return None
    parts = urlsplit(target)
    path = parts.path
    if (
        parts.scheme
        or parts.netloc
        or parts.fragment
        or "%" in path
        or "\\" in path
        or ".." in path
    ):
        return None
    if (method, path) not in ALLOWED:
        return None
    if parts.query:
        keys = QUERIES.get(path)
        if not keys:
            return None
        try:
            query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            return None
        if not set(query) <= keys or any(len(v) != 1 for v in query.values()):
            return None
    return method, path


def frame(stream_id: str, payload: bytes) -> bytes:
    return stream_id.encode("ascii") + payload


def unframe(data: bytes) -> tuple[str, bytes] | None:
    if len(data) < ID_BYTES:
        return None
    try:
        stream_id = data[:ID_BYTES].decode("ascii")
    except UnicodeDecodeError:
        return None
    return (stream_id, bytes(data[ID_BYTES:])) if _ID.fullmatch(stream_id) else None


class Refused(Exception):
    """A request the Mac won't pass on: its status, words for the page, a code."""

    def __init__(self, status: int, message: str, code: str) -> None:
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


@dataclass
class Incoming:
    id: str
    method: str
    path: str
    target: str
    browser: str
    headers: dict[str, str]
    began: float
    body: bytearray = field(default_factory=bytearray)
    refused: bool = False
    task: asyncio.Task | None = None
    inflight: int = 0
    acked: asyncio.Event = field(default_factory=asyncio.Event)


class EdenLink:
    """The web channel to askeden.com and the requests it brings. account: jarvis.account's
    Account (linked, its token, its device list). base, local, transport, connect, sleep,
    clock: tests point it at fakes. bypass(): whether Code mode may run in bypassPermissions
    from the web (never, unless a test says so)."""

    def __init__(
        self,
        account: Any,
        *,
        base: str = WS_BASE,
        local: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        connect: Connect | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        bypass: Callable[[], bool] = lambda: False,
    ) -> None:
        self.account = account
        self.base = base.rstrip("/")
        self.local = (local or local_url()).rstrip("/")
        self.transport = transport
        self.connect = connect or _connect()
        self.sleep = sleep
        self.clock = clock
        self.bypass = bypass
        self.state = "off"  # off | connecting | open | waiting (to reconnect)
        self.error = ""  # why the line last failed, in words (Settings); "" once it's open
        self.on_change: list[Callable[[], Any]] = []  # Settings › Account redraws
        self.served = 0  # requests passed to Eden since it started (Settings, tests)
        self.streams: dict[str, Incoming] = {}
        self._ws: Any = None
        self._send_lock = asyncio.Lock()
        self._client: httpx.AsyncClient | None = None
        self._fresh_at = -FRESH_SECONDS  # when the device list was last asked for fresh
        self._unknown: dict[str, float] = {}  # browser id → when it was last looked up fresh

    # ── the line ──

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.account.token}"}

    def _set(self, state: str, error: str | None = None) -> None:
        """The line's state (and why it failed): Settings hears of each change."""
        error = self.error if error is None else error
        if (state, error) == (self.state, self.error):
            return
        self.state, self.error = state, error
        for heard in list(self.on_change):
            with contextlib.suppress(Exception):
                heard()

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "error": self.error}

    async def run(self) -> None:
        """The web channel, until cancelled or signed out."""
        from websockets.exceptions import InvalidStatus, WebSocketException

        delay = 1.0
        try:
            while self.account.linked:
                began = self.clock()
                self._set("connecting")
                most = BACKOFF_MOST
                try:
                    async with self.connect(
                        f"{self.base}/web",
                        additional_headers=self._headers(),
                        compression=None,
                        open_timeout=OPEN_SECONDS,
                        max_size=MAX_FRAME + ID_BYTES + 1024,
                    ) as ws:
                        self._set("open", "")
                        log.info("eden link: Eden on the web can reach this Mac")
                        await self.serve(ws)
                    log.info("eden link: the line closed")
                    self.error = "askeden.com closed the line."
                except InvalidStatus as exc:
                    status = exc.response.status_code
                    if status == 401:
                        log.info("eden link: signed out of the account; stopping")
                        self.error = "This Mac was signed out of the account."
                        await self.account.forget()
                        return
                    if status in (403, 404, 426):
                        most = BACKOFF_MISSING  # askeden.com doesn't take it (yet)
                        self.error = "askeden.com doesn’t take this Mac’s link yet."
                    else:
                        self.error = f"askeden.com answered {status}."
                    log.info("eden link: askeden.com said %s", status)
                except (OSError, TimeoutError, WebSocketException) as exc:
                    log.info("eden link: the line dropped (%s)", type(exc).__name__)
                    self.error = "Couldn’t reach askeden.com."
                except Exception:
                    log.exception("eden link: the line failed")
                    self.error = "The link to askeden.com failed."
                self._set("waiting")
                if self.clock() - began >= STEADY_SECONDS:
                    delay = 1.0
                await self.sleep(delay if most == BACKOFF_MOST else most)
                delay = min(BACKOFF_MOST, delay * 2)
        finally:
            self._set("off")
            await self.aclose()

    async def serve(self, ws: Any) -> None:
        """Every frame on one open line; what it brought ends with it."""
        self._ws = ws
        try:
            async for message in ws:
                await self.heard(message)
        finally:
            self._ws = None
            await self.drop_all()

    async def drop_all(self) -> None:
        streams, self.streams = list(self.streams.values()), {}
        tasks = [s.task for s in streams if s.task is not None]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def aclose(self) -> None:
        await self.drop_all()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _send(self, message: str | bytes) -> None:
        ws = self._ws
        if ws is None:
            raise ConnectionError("the line is closed")
        async with self._send_lock:
            await ws.send(message)

    async def _say(self, **message: Any) -> None:
        with contextlib.suppress(Exception):
            await self._send(json.dumps(message))

    async def _refuse(self, stream_id: str, status: int, words: str, code: str) -> None:
        await self._say(t="error", id=stream_id, status=status, error=words, code=code)

    # ── frames ──

    async def heard(self, message: str | bytes) -> None:
        if isinstance(message, bytes | bytearray | memoryview):
            got = unframe(bytes(message))
            if got is None:
                return
            stream = self.streams.get(got[0])
            if stream is None or stream.task is not None or stream.refused:
                return
            stream.body.extend(got[1])
            if len(stream.body) > MAX_BODY:
                stream.refused = True
                stream.body = bytearray()
                await self._refuse(
                    stream.id, 413, "That request is too big for your Mac.", "too_big"
                )
            return
        if len(message) > MAX_CONTROL:
            return
        try:
            m = json.loads(message)
        except ValueError:
            return
        if not isinstance(m, dict):
            return
        kind, stream_id = m.get("t"), m.get("id")
        if not isinstance(stream_id, str) or not _ID.fullmatch(stream_id):
            return
        if kind == "req":
            await self._opened(stream_id, m)
        elif kind == "end":
            stream = self.streams.get(stream_id)
            if stream is None or stream.task is not None:
                return
            if stream.refused:
                self.streams.pop(stream_id, None)
                return
            stream.task = asyncio.get_running_loop().create_task(self._serve_one(stream))
        elif kind == "cancel":
            stream = self.streams.pop(stream_id, None)
            if stream is not None and stream.task is not None:
                stream.task.cancel()
        elif kind == "ack":
            stream = self.streams.get(stream_id)
            n = m.get("n")
            if stream is not None and isinstance(n, int) and n > 0:
                stream.inflight = max(0, stream.inflight - n)
                stream.acked.set()

    async def _opened(self, stream_id: str, m: dict[str, Any]) -> None:
        now = self.clock()
        # A body that never finished arriving doesn't hold a place for ever.
        for old in [
            s for s in self.streams.values() if s.task is None and now - s.began > BODY_SECONDS
        ]:
            self.streams.pop(old.id, None)
        if stream_id in self.streams:
            return
        method, target, browser = m.get("method"), m.get("path"), m.get("from")
        route = (
            route_of(method, target)
            if isinstance(method, str) and isinstance(target, str)
            else None
        )
        if len(self.streams) >= MAX_STREAMS:
            await self._refuse(
                stream_id, 429, "Your Mac is answering too many requests at once.", "slow_down"
            )
            refused = True
        elif route is None:
            await self._refuse(
                stream_id, 403, "Eden on the web can’t ask your Mac for that.", "not_allowed"
            )
            refused = True
        elif not isinstance(browser, str) or not _DEVICE.fullmatch(browser):
            await self._refuse(
                stream_id, 403, "That request didn’t say which browser asked.", "forbidden"
            )
            refused = True
        elif isinstance(m.get("size"), int) and m["size"] > MAX_BODY:
            await self._refuse(stream_id, 413, "That request is too big for your Mac.", "too_big")
            refused = True
        else:
            refused = False
        headers = m.get("headers") if isinstance(m.get("headers"), dict) else {}
        self.streams[stream_id] = Incoming(
            id=stream_id,
            method=route[0] if route else "",
            path=route[1] if route else "",
            target=target if route else "",
            browser=browser if isinstance(browser, str) else "",
            headers={
                k: v
                for k, v in headers.items()
                if k in ("content-type", "accept") and isinstance(v, str) and len(v) <= 200
            },
            began=now,
            refused=refused,
        )

    # ── one request ──

    async def _serve_one(self, stream: Incoming) -> None:
        answered = False
        try:
            await self._check(stream)
            client = self._http()
            headers = {"X-Jarvis-Chat": "1", **stream.headers}
            body = bytes(stream.body) if stream.method == "POST" else None
            stream.body = bytearray()
            self.served += 1
            async with client.stream(
                stream.method, stream.target, content=body, headers=headers
            ) as response:
                await self._send(
                    json.dumps(
                        {
                            "t": "res",
                            "id": stream.id,
                            "status": response.status_code,
                            "headers": {"content-type": response.headers.get("content-type", "")},
                        }
                    )
                )
                answered = True
                # Decoded (content-encoding isn't passed on), as it arrives.
                async for chunk in response.aiter_bytes():
                    for at in range(0, len(chunk), MAX_FRAME):
                        piece = chunk[at : at + MAX_FRAME]
                        while stream.inflight + len(piece) > WINDOW and stream.inflight > 0:
                            stream.acked.clear()
                            await stream.acked.wait()
                        stream.inflight += len(piece)
                        await self._send(frame(stream.id, piece))
            await self._say(t="end", id=stream.id)
            log.info("eden link: %s %s → %s", stream.method, stream.path, response.status_code)
        except Refused as exc:
            log.info("eden link: refused %s %s (%s)", stream.method, stream.path, exc.code)
            await self._refuse(stream.id, exc.status, exc.message, exc.code)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            await self._refuse(
                stream.id,
                502,
                "Eden isn’t running on your Mac. Open it there (model-router-ui) and try again.",
                "eden_off",
            )
        except httpx.HTTPError as exc:
            log.info(
                "eden link: %s %s broke off (%s)", stream.method, stream.path, type(exc).__name__
            )
            words = (
                "Eden on your Mac stopped answering."
                if answered
                else "Eden on your Mac didn’t answer."
            )
            await self._refuse(stream.id, 502, words, "mac_error")
        except asyncio.CancelledError:
            log.info("eden link: %s %s stopped", stream.method, stream.path)
            raise
        except ConnectionError:
            pass  # the line closed: askeden.com ends it there
        except Exception:
            log.exception("eden link: %s %s failed", stream.method, stream.path)
            await self._refuse(
                stream.id, 502, "Eden on your Mac couldn’t answer that.", "mac_error"
            )
        finally:
            if self.streams.get(stream.id) is stream:
                del self.streams[stream.id]

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.local,
                transport=self.transport,
                timeout=LOCAL_TIMEOUT,
                limits=httpx.Limits(max_connections=MAX_STREAMS + 4),
            )
        return self._client

    async def _check(self, stream: Incoming) -> None:
        if not await self.browser_ok(stream.browser):
            raise Refused(
                403, "Only browsers signed in to this account may use this Mac.", "forbidden"
            )
        if stream.method != "POST":
            return
        try:
            body = json.loads(bytes(stream.body) or b"{}")
        except ValueError:
            raise Refused(400, "Send a JSON object.", "bad_request") from None
        if not isinstance(body, dict):
            raise Refused(400, "Send a JSON object.", "bad_request")
        if stream.path == "/api/chat/jarvis" and body.get("tool") not in JARVIS_TOOLS:
            raise Refused(403, "Eden on the web can’t use that Jarvis tool.", "not_allowed")
        if stream.path == "/api/chat/actions/undo" and not str(body.get("id") or "").startswith(
            "ea-"
        ):
            # Only what Jarvis did (its card asks the owner); Eden's own Google changes are
            # undone from Eden on the Mac, where its review step is.
            raise Refused(403, "Undo that from Eden on your Mac.", "not_allowed")
        if stream.path == "/api/chat/send" and body.get("privacy") is not True:
            # askeden.com answers its own turns; only privacy mode's come here.
            raise Refused(403, "From the web, your Mac answers private chats only.", "not_allowed")
        if stream.path == "/api/chat/brief" and body.get("kind", "brief") not in BRIEF_KINDS:
            raise Refused(400, "The brief is brief, events or prep.", "bad_request")
        if (
            stream.path == "/api/chat/code"
            and body.get("mode") == "bypassPermissions"
            and not self.bypass()
        ):
            raise Refused(
                403,
                "From the web, Code mode asks before it acts: bypassing permissions works only on your Mac.",
                "not_allowed",
            )

    async def browser_ok(self, device_id: str) -> bool:
        """Whether this is a browser (`web` device) signed in to this Mac's own account: the
        account's device list (kept a minute), asked again for one not in it (a browser that
        just signed in), at most every FRESH_SECONDS for that one and FRESH_GAP for any."""
        if not _DEVICE.fullmatch(device_id or ""):
            return False
        if _is_browser(await self.account.status(), device_id):
            return True
        now = self.clock()
        if (
            now - self._fresh_at < FRESH_GAP
            or now - self._unknown.get(device_id, -FRESH_SECONDS) < FRESH_SECONDS
        ):
            return False
        self._fresh_at = self._unknown[device_id] = now
        if len(self._unknown) > 64:
            self._unknown = {k: t for k, t in self._unknown.items() if now - t < FRESH_SECONDS}
        return _is_browser(await self.account.status(fresh=True), device_id)


def _is_browser(info: Any, device_id: str) -> bool:
    devices = info.get("devices") if isinstance(info, dict) else None
    if not isinstance(devices, list):
        return False
    return any(
        isinstance(d, dict) and d.get("id") == device_id and d.get("kind") == "web" for d in devices
    )
