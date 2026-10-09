"""The iPhone and Watch companion: JARVIS from your pocket.

Off by default. When the user turns it on, a second, separate server listens on the
network (port 8765) with a small phone-sized page (add it to the Home Screen) and a JSON
API that an Apple Watch Shortcut can call. The Mac window's own server stays bound to
127.0.0.1 and is never reachable from here.

A device gets in only by pairing: the Mac shows a one-time six-digit code (five minutes,
five wrong tries and pairing locks for five minutes), which the phone trades for its own
long random token. Only a hash of the token is stored, and each device can be removed.
The API is a short allowlist: ask, stop, answer a pending approval, a few app commands
and the current state (jarvis.companion adds Eden Code, push and the rest). Requests from
the phone run as silent turns, so the Mac doesn't talk to an empty room. Every call is
rate-limited per device, and every body capped.

Traffic is HTTPS, with the Mac's own certificate (companion_tls): the phone pins its
fingerprint when it pairs. Plain HTTP, for the web page and app of old, is refused unless
the owner turns it back on in Settings (off by default, with a warning).
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import hashlib
import io
import json
import logging
import os
import re
import secrets
import socket
import ssl
import subprocess
import threading
import time
import unicodedata
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import h11
import uvicorn
from starlette.applications import Starlette
from starlette.requests import ClientDisconnect, Request
from starlette.responses import FileResponse, HTMLResponse, Response
from starlette.responses import JSONResponse as PlainJSONResponse
from starlette.routing import Route
from uvicorn.protocols.http.h11_impl import H11Protocol

from . import companion_tls, packaged
from .prefs import APP_SUPPORT

log = logging.getLogger("jarvis")

PORT = 8765
HOST = "0.0.0.0"  # noqa: S104 - the point: reachable from the user's phone
WEB_DIR = Path(__file__).parent / "web"
CODE_SECONDS = 300
MAX_FAILURES = 5
LOCKOUT_SECONDS = 300
ASK_TIMEOUT = 120
COMMANDS = {"stop", "briefing", "meeting_start", "meeting_stop", "routine_run"}
MAX_BODY = 20_000  # bytes: every request body is small JSON
BODY_SECONDS = 10.0  # a body that trickles in slower than this is dropped
MAX_GLOBAL_FAILURES = 30  # wrong guesses at one code from every address: then it's spent
MAX_DEVICES = 20  # the oldest unused one goes when a new phone pairs past this
SAY_AT_ONCE = 2  # voice clips made for phones at the same time
MAX_CONNECTIONS = 64  # open at once, every address together
PER_ADDRESS = 16  # open at once from one address (Safari and URLSession use about 6)
REQUEST_SECONDS = 10.0  # to send one whole request, headers and body
SERVICE_TYPE = "_jarvis._tcp"  # what the iPhone and Watch apps browse for (Info.plist too)
HANDSHAKE_SECONDS = 10.0  # to finish a TLS handshake once the connection is open
OPENING_AT_ONCE = 64  # connections still being told apart or shaking hands, all together
OPENING_PER_ADDRESS = 8  # ... from one address
# Uploads (a shared file, a photo) take longer to send than a request of a few kilobytes:
# these paths get this long, once their token checks out (the rest are refused at once).
UPLOAD_PATHS = frozenset(
    {"/api/share", "/api/photo", "/api/code/send", "/api/code/new", "/api/projects/file"}
)
UPLOAD_SECONDS = 180.0
PLAIN_PREF = "companion_plain_http"  # Settings: plain HTTP for the old app and web page too
# Calls a device may make: (a minute's worth, the most at once). A device over its budget
# gets 429 with Retry-After; one phone's runaway loop never slows the others.
RATES = {
    "read": (240, 60),  # state, sessions, lists: the app polls while it's open
    "ask": (20, 5),  # requests that start a turn (ask, a photo, a shared note)
    "act": (60, 20),  # approvals, commands, Eden Code messages, routines
    "say": (30, 10),  # voice clips
    "report": (60, 20),  # push and Live Activity tokens, location, health
    "upload": (10, 3),  # shared files and photos
}


class JSONResponse(PlainJSONResponse):
    """The companion's JSON answers (every companion module's), whatever a kept value holds.
    Half of a surrogate pair (a title cut in the middle of an emoji by the window, a client's
    malformed escape, kept escaped in a store) can't be written as UTF-8: /api/state,
    /api/code/sessions or /api/projects answered 500 for as long as one was kept. It becomes
    U+FFFD, as it does in the window's events (server.event_text)."""

    def render(self, content: Any) -> bytes:
        try:
            return super().render(content)
        except UnicodeEncodeError:
            text = json.dumps(
                content, ensure_ascii=False, allow_nan=False, indent=None, separators=(",", ":")
            )
            return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode()


@dataclass
class Device:
    id: str
    name: str
    token_hash: str
    paired: str
    last_seen: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "paired": self.paired,
            "last_seen": self.last_seen,
        }


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Devices:
    """The paired phones and watches. Each record is read on its own: one this build can't
    use (another build's, a hand edit) is kept in the file as it was but never trusted, and
    fields it doesn't know are written back as they came, so no device is unpaired by it."""

    def __init__(self, path: Path | None = None) -> None:
        from . import jsonstore

        self.path = path or APP_SUPPORT / "devices.json"
        self.items: list[Device] = []
        self.broken: list[Any] = []  # records it can't use: kept, never matched
        self.extra: dict[str, dict[str, Any]] = {}  # fields another build added, by id
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self.code: str | None = None
        self.code_expires = 0.0
        # Wrong codes per address: someone else on the network can't lock the owner out.
        self.failures: dict[str, deque[float]] = {}
        self.all_failures: deque[float] = deque()  # and a cap for many addresses at once
        # When a phone was last seen is written in a thread (seen()): one write at a time,
        # and a list taken earlier never lands over one written since (a phone just paired
        # or removed stays so on disk).
        self._write_lock = threading.Lock()
        self._taken = 0  # lists taken to save, numbered
        self._written = 0  # the newest of them on disk
        try:
            rows = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("devices: %s can't be read (%s); leaving it be", self.path.name, exc)
            rows = None
        read: list[tuple[Device, Any]] = []
        for row in rows or []:
            device = self._read(row)
            if device is not None:
                read.append((device, row))
            elif jsonstore.shallow(row):
                self.broken.append(row)
        # More than it pairs (a hand edit, another build): the newest are paired, and the
        # rest kept in the file as they were.
        self.broken += [row for _device, row in read[:-MAX_DEVICES] if jsonstore.shallow(row)]
        self.items = [device for device, _row in read[-MAX_DEVICES:]]
        self._index()

    def _read(self, row: Any) -> Device | None:
        """One record, or None when it can't be trusted as a device."""
        from .textclean import clean_text

        known = Device.__dataclass_fields__
        if not isinstance(row, dict):
            return None
        try:
            device = Device(**{k: v for k, v in row.items() if k in known})
        except TypeError:  # a field it needs is missing
            return None
        if not all(isinstance(getattr(device, k), str) for k in known) or not device.token_hash:
            return None
        device.name = " ".join(clean_text(device.name).split())[:40] or "Phone"
        extra = {k: v for k, v in row.items() if k not in known}
        if extra and all(isinstance(k, str) for k in extra):
            from . import jsonstore

            if jsonstore.shallow(extra):
                self.extra[device.id] = extra
        return device

    def _index(self) -> None:
        self._by_hash = {d.token_hash: d for d in self.items}

    def save(self, *, keep_copy: bool = True) -> None:
        """keep_copy False: a device just removed doesn't stay in the backup copy, so it can
        never be brought back from it."""
        from . import jsonstore

        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        self._write(*self._taken_rows(), keep_copy)

    def _taken_rows(self) -> tuple[list[Any], int]:
        """The file's rows as they are now (taken on the event loop), and their number."""
        rows = [{**self.extra.get(d.id, {}), **asdict(d)} for d in self.items] + self.broken
        self._taken += 1
        return rows, self._taken

    def _write(self, rows: list[Any], number: int, keep_copy: bool = True) -> None:
        """Rows onto the disk (any thread); left out when newer ones are there already."""
        from . import jsonstore

        with self._write_lock:
            if number <= self._written:
                return
            jsonstore.save_json(self.path, rows, backup=keep_copy)
            self._written = number

    def start_pairing(self) -> str:
        self.code = f"{secrets.randbelow(10**6):06d}"
        self.code_expires = time.monotonic() + CODE_SECONDS
        self.all_failures.clear()  # a new code, a new budget of guesses
        return self.code

    def locked(self, host: str = "") -> bool:
        """Too many wrong codes from this address lately: someone else on the network
        guessing never locks the owner's phone out."""
        now = time.monotonic()
        for times in self.failures.values():
            while times and now - times[0] > LOCKOUT_SECONDS:
                times.popleft()
        self.failures = {h: t for h, t in self.failures.items() if t}
        return len(self.failures.get(host, ())) >= MAX_FAILURES

    def pair(self, code: str, name: str, host: str = "") -> str:
        if self.locked(host):
            raise PermissionError("Too many wrong codes. Wait five minutes.")
        live = self.code is not None and time.monotonic() < self.code_expires
        # A Chinese keyboard's full-width digits are the code's own; compared as bytes, since
        # compare_digest refuses text that isn't ASCII (a 500, and no wrong guess counted).
        given = unicodedata.normalize("NFKC", str(code)).strip().encode(errors="replace")
        if not live or not secrets.compare_digest(given, (self.code or "").encode()):
            if live:  # with no code on screen there's nothing to guess, so nothing to count
                now = time.monotonic()
                if len(self.failures) < 1000 or host in self.failures:
                    self.failures.setdefault(host, deque()).append(now)
                self.all_failures.append(now)
                if len(self.all_failures) >= MAX_GLOBAL_FAILURES:
                    self.code = None  # guessed at from many addresses: this code is spent
            raise PermissionError(
                "That code isn't right, or it expired. Make a new one on the Mac."
            )
        from .textclean import clean_text

        self.code = None  # one pairing per code
        token = secrets.token_urlsafe(32)
        device = Device(
            uuid.uuid4().hex[:8],
            " ".join(clean_text(name).split())[:40] or "Phone",
            _hash(token),
            datetime.now().isoformat(timespec="seconds"),
        )
        before = list(self.items)
        self.items.append(device)
        while len(self.items) > MAX_DEVICES:  # the phone used longest ago makes room
            self.items.remove(min(self.items, key=lambda d: d.last_seen or d.paired))
        self._index()
        try:
            self.save(keep_copy=len(self.items) > len(before))  # one made room: no copy of it
        except OSError:  # not saved, not paired: its token would stop working at a restart
            self.items = before
            self._index()
            raise
        return token

    def check(self, token: str) -> Device | None:
        """The paired device with this token (looked up by its hash, never compared as
        plain text)."""
        if not token or len(token) > 200:
            return None
        return self._by_hash.get(_hash(token))

    def seen(self, device: Device) -> None:
        now = datetime.now().isoformat(timespec="minutes")
        if device.last_seen != now:
            device.last_seen = now
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is None or self.unreadable:
                # Only when it was last seen: never worth a failure.
                with contextlib.suppress(OSError):
                    self.save()
                return
            # In a thread: the request that saw it never waits on the disk (a save flushes
            # the drive's cache, which a busy disk can take a good while over).
            loop.run_in_executor(None, self._write_quietly, *self._taken_rows())

    def _write_quietly(self, rows: list[Any], number: int) -> None:
        with contextlib.suppress(OSError):  # only when it was last seen: never worth a failure
            self._write(rows, number)

    def remove(self, device_id: str) -> bool:
        """Unpaired at once, even when the file can't be saved (the error says so)."""
        before = len(self.items)
        self.items = [d for d in self.items if d.id != device_id]
        if len(self.items) != before:
            self.extra.pop(device_id, None)
            self._index()
            self.save(keep_copy=False)
            return True
        return False

    def public(self) -> list[dict[str, Any]]:
        return [d.public() for d in self.items]


def lan_address() -> str:
    """This Mac's address on the local network ("" when it has none)."""
    with contextlib.suppress(OSError):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("10.255.255.255", 1))  # picks the LAN interface; sends nothing
            return str(probe.getsockname()[0])
        finally:
            probe.close()
    return ""


def addresses(port: int = PORT, scheme: str = "https") -> list[str]:
    """URLs a phone on the same network (or tailnet) can use."""
    urls = []
    host = socket.gethostname()
    if host:
        host = host if host.endswith(".local") else f"{host}.local"
        urls.append(f"{scheme}://{host}:{port}")
    if ip := lan_address():
        urls.append(f"{scheme}://{ip}:{port}")
    return urls


class Limiter:
    """Each device's budget of calls, per kind (RATES): a bucket that refills steadily."""

    def __init__(self, rates: dict[str, tuple[int, int]] | None = None, clock=time.monotonic):
        self.rates = rates or RATES
        self.clock = clock
        self._buckets: dict[tuple[str, str], tuple[float, float]] = {}

    def wait(self, device_id: str, kind: str) -> float:
        """0 when the call may go ahead (and it's counted); else seconds until it may."""
        per_minute, most = self.rates.get(kind) or self.rates.get("act") or RATES["act"]
        now = self.clock()
        tokens, at = self._buckets.get((device_id, kind), (float(most), now))
        tokens = min(float(most), tokens + (now - at) * per_minute / 60)
        if tokens >= 1:
            self._buckets[(device_id, kind)] = (tokens - 1, now)
            if len(self._buckets) > 1000:  # devices long removed: their buckets go
                self._buckets = {k: v for k, v in self._buckets.items() if now - v[1] < 600}
            return 0.0
        self._buckets[(device_id, kind)] = (tokens, now)
        return (1 - tokens) * 60 / per_minute


class Gate:
    """What every /api call goes through: the device's own token (401 otherwise), its
    rate limit for this kind of call (429), and a cap on its body (413), read only after
    the token checks out, except for pairing, whose small body is read first."""

    def __init__(self, devices: Devices, limiter: Limiter | None = None) -> None:
        self.devices = devices
        self.limiter = limiter or Limiter()

    def device(self, request: Request) -> Device | None:
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.lower().startswith("bearer ") else ""
        device = self.devices.check(token)
        if device is not None:
            self.devices.seen(device)
        return device

    def admit(self, request: Request, kind: str) -> tuple[Device | None, Response | None]:
        """(the device, None) when the call may go ahead; else (None, the refusal)."""
        device = self.device(request)
        if device is None:
            return None, self.denied(request)
        wait = self.limiter.wait(device.id, kind)
        if wait:
            return None, JSONResponse(
                {"error": "Too many requests. Try again in a moment."},
                status_code=429,
                headers={"Retry-After": str(max(1, round(wait)))},
            )
        return device, None

    @staticmethod
    def denied(request: Request | None = None) -> JSONResponse:
        # A refused upload's body isn't read: the connection closes instead.
        close = request is not None and request.method == "POST"
        return JSONResponse(
            {"error": "Pair this device first."},
            status_code=401,
            headers={"Connection": "close"} if close else None,
        )

    @staticmethod
    def too_big() -> JSONResponse:
        # Connection: close, or uvicorn keeps reading (and dropping) the rest of a body
        # we refused, for as long as the sender keeps it coming.
        return JSONResponse(
            {"error": "That request is too big or too slow."},
            status_code=413,
            headers={"Connection": "close"},
        )

    @staticmethod
    def busy() -> JSONResponse:
        return JSONResponse({"error": "Jarvis is busy. Try again in a moment."}, status_code=429)

    @staticmethod
    async def _read_capped(request: Request, cap: int) -> bytes | None:
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > cap:
                return None
        return bytes(raw)

    async def json(
        self, request: Request, cap: int = MAX_BODY, seconds: float | None = None
    ) -> dict[str, Any] | None:
        """The request's JSON object, read at most cap bytes and seconds long (BODY_SECONDS
        unless said: an upload has UPLOAD_SECONDS). None: too big or too slow; {} for
        anything that isn't a JSON object."""
        seconds = BODY_SECONDS if seconds is None else seconds
        try:
            if int(request.headers.get("content-length") or 0) > cap:
                return None
            raw = await asyncio.wait_for(self._read_capped(request, cap), seconds)
        except (ValueError, TimeoutError, ClientDisconnect):
            return None
        if raw is None:
            return None
        try:
            data = json.loads(raw or b"{}")
        except (ValueError, RecursionError):
            return {}
        return data if isinstance(data, dict) else {}


def create_remote_app(
    hub: Any,
    devices: Devices,
    *,
    identity: companion_tls.Identity | None = None,
    mac_name: str = "",
    extension: Any = None,
    gate: Gate | None = None,
) -> Starlette:
    """The companion's routes. identity: the certificate the server presents (pairing
    checks the phone pinned it). extension (jarvis.companion.Companion): more routes, more
    in the state, and a record of what each phone did."""
    gate = gate or Gate(devices)
    asking: dict[str, int] = {}  # device id -> its request still being answered
    saying = asyncio.Semaphore(SAY_AT_ONCE)

    def record(device: Device, action: str, detail: str = "") -> None:
        if extension is not None:
            with contextlib.suppress(Exception):  # a record that fails never fails the call
                extension.record(device, action, detail)

    def asset(name: str, media_type: str):
        """Only the companion's own files are served here, nothing else from the app."""

        async def serve(_request):
            return FileResponse(
                WEB_DIR / name, media_type=media_type, headers={"Cache-Control": "no-cache"}
            )

        return serve

    async def page(_request):
        html = (WEB_DIR / "remote.html").read_text()
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def manifest(_request):
        return JSONResponse(
            {
                "name": "J.A.R.V.I.S.",
                "short_name": "JARVIS",
                "start_url": "/",
                "display": "standalone",
                "background_color": "#060b16",
                "theme_color": "#060b16",
                "icons": [{"src": "/icon.png", "sizes": "512x512", "type": "image/png"}],
            },
            media_type="application/manifest+json",
        )

    async def icon(_request):
        path = packaged.app_dir() / "build" / "icon-1024.png"
        if path.is_file():
            return FileResponse(path, media_type="image/png")
        return Response(status_code=404)

    async def pair(request: Request):
        data = await gate.json(request)
        if data is None:
            return gate.too_big()
        # The certificate the phone pinned must be this server's: otherwise something in
        # between answered for it. Checked before the code, which stays unspent.
        pinned = str(data.get("fingerprint") or "")
        if (
            identity is not None
            and pinned
            and not companion_tls.matches(pinned, identity.fingerprint)
        ):
            return JSONResponse({"error": "fingerprint"}, status_code=409)
        host = request.client.host if request.client else ""
        name = str(data.get("device_name") or data.get("name") or "")
        try:
            token = devices.pair(str(data.get("code", "")), name, host)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        hub.emit("devices", items=devices.public(), paired=True)
        device = devices.check(token)
        if device is not None:
            record(device, "paired")
        reply: dict[str, Any] = {"token": token}
        if identity is not None:
            reply.update(fingerprint=identity.fingerprint, mac_name=mac_name)
        return JSONResponse(reply)

    async def state(request: Request):
        device, refused = gate.admit(request, "read")
        if device is None:
            return refused
        data = hub.remote_state()
        data["tls"] = request.url.scheme == "https"
        if extension is not None:
            data.update(await extension.state(device))
        return JSONResponse(data)

    async def ask(request: Request):
        device, refused = gate.admit(request, "ask")
        if device is None:
            return refused
        data = await gate.json(request)
        if data is None:
            return gate.too_big()
        text = str(data.get("text", "")).strip()[:4000]
        if not text:
            return JSONResponse({"error": "Say something."}, status_code=400)
        if asking.get(device.id):
            return JSONResponse({"error": "Still on your last request."}, status_code=429)
        asking[device.id] = 1
        record(device, "asked")
        try:
            reply = await hub.remote_ask(text, ASK_TIMEOUT)
        finally:
            asking.pop(device.id, None)
        if reply.pop("busy", False):  # the phones already have REMOTE_TURNS going
            return gate.busy()
        return JSONResponse(reply)

    async def approve(request: Request):
        device, refused = gate.admit(request, "act")
        if device is None:
            return refused
        data = await gate.json(request)
        if data is None:
            return gate.too_big()
        choice = str(data.get("choice", ""))
        feedback = " ".join(str(data.get("feedback") or "").split())[:2000]
        ok = hub.resolve(str(data.get("id", "")), choice, feedback)
        if ok:
            if choice == "deny":
                record(device, "said_no_because" if feedback else "said_no")
            else:
                record(device, "said_yes" if choice in ("allow", "yes") else "answered")
        return JSONResponse({"ok": ok})

    async def command(request: Request):
        device, refused = gate.admit(request, "act")
        if device is None:
            return refused
        data = await gate.json(request)
        if data is None:
            return gate.too_big()
        kind = str(data.get("type", ""))
        if kind not in COMMANDS:
            return JSONResponse({"error": "Not available from the phone."}, status_code=400)
        if not await hub.remote_command(
            {k: v for k, v in data.items() if isinstance(v, (str, int, bool))}
        ):
            return gate.busy()
        record(device, kind)
        return JSONResponse({"ok": True})

    async def say(request: Request):
        """The reply in JARVIS's own voice, for the phone to play."""
        device, refused = gate.admit(request, "say")
        if device is None:
            return refused
        data = await gate.json(request)
        if data is None:
            return gate.too_big()
        text = str(data.get("text", "")).strip()[:1500]
        if not text:
            return Response(status_code=400)
        if saying.locked():  # a voice clip costs a process or a paid call: a few at a time
            return Response(status_code=429)
        async with saying:
            clip = await hub.speaker.synthesize(text)
        if clip is None:
            return Response(status_code=503)
        return Response(wav_bytes(*clip), media_type="audio/wav")

    routes = [
        Route("/", page),
        Route("/manifest.webmanifest", manifest),
        Route("/icon.png", icon),
        Route("/api/pair", pair, methods=["POST"]),
        Route("/api/state", state),
        Route("/api/ask", ask, methods=["POST"]),
        Route("/api/approve", approve, methods=["POST"]),
        Route("/api/command", command, methods=["POST"]),
        Route("/api/say", say, methods=["POST"]),
        Route("/remote.js", asset("remote.js", "text/javascript")),
        Route("/remote.css", asset("remote.css", "text/css")),
    ]
    if extension is not None:
        routes += extension.routes(gate)
    return Starlette(routes=routes)


class GuardedH11(H11Protocol):
    """uvicorn's HTTP/1.1 with limits for a port the whole network can reach: a few
    connections per address, and a deadline for sending each whole request (uvicorn
    itself only times out the quiet gap between requests). A connection over the limit
    is closed at once, so it holds no request slot the owner's phone would need."""

    _deadline: asyncio.TimerHandle | None = None

    def connection_made(self, transport: Any) -> None:
        super().connection_made(transport)
        host = self.client[0] if self.client else ""
        same = sum(
            1 for c in self.connections if getattr(c, "client", None) and c.client[0] == host
        )
        if len(self.connections) > MAX_CONNECTIONS or same > PER_ADDRESS:
            transport.close()
            return
        self._arm()

    def _arm(self, seconds: float | None = None) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
        self._deadline = self.loop.call_later(seconds or REQUEST_SECONDS, self._too_slow)

    def handle_events(self) -> None:
        scope = self.scope
        super().handle_events()
        # A new request for an upload: the time to send its body is longer. (A device
        # whose token doesn't check out is answered, and cut off, before that matters.)
        if self.scope is not scope and self.scope and self.scope.get("path") in UPLOAD_PATHS:
            if not self.transport.is_closing():
                self._arm(UPLOAD_SECONDS)

    def _too_slow(self) -> None:
        self._deadline = None
        if self.conn.their_state in (h11.DONE, h11.MUST_CLOSE, h11.CLOSED):
            return  # the request is all in; its answer may take a while (/api/ask)
        if not self.transport.is_closing():
            self.transport.close()

    def on_response_complete(self) -> None:
        super().on_response_complete()
        if not self.transport.is_closing():
            self._arm()  # the next request on this connection gets the same time

    def connection_lost(self, exc: Exception | None) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
            self._deadline = None
        super().connection_lost(exc)


def local_host_name() -> str:
    """The Mac's Bonjour name ("Bilels-MacBook-Pro"), for a pairing address that survives
    a new IP from the router."""
    try:
        out = subprocess.run(
            ["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    return out if re.fullmatch(r"[A-Za-z0-9-]{1,63}", out) else ""


def computer_name() -> str:
    """The Mac's name as the owner set it ("Bilel's MacBook Pro"), for the phone to show;
    JARVIS_DEVICE_NAME names a Jarvis that isn't on a Mac (the cloud one: "Jarvis Cloud")."""
    named = os.environ.get("JARVIS_DEVICE_NAME", "").strip()
    if named:
        return named[:63]
    try:
        out = subprocess.run(
            ["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=3
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        out = ""
    from .textclean import clean_text

    return " ".join(clean_text(out or socket.gethostname()).split())[:63]


def txt_record(pairs: dict[str, str]) -> bytes:
    """A DNS TXT record: each key=value as a length-prefixed string."""
    out = b""
    for key, value in pairs.items():
        item = f"{key}={value}".encode()[:255]
        out += bytes([len(item)]) + item
    return out


class Advertiser:
    """Bonjour for the companion apps: while the companion server listens, this Mac shows
    up in their pairing list as _jarvis._tcp, with its .local name in the TXT record.
    It goes through the system's DNS-SD API, so the advertisement ends with the
    registration, or with this process however it ends (no helper left behind)."""

    def __init__(self, register: Callable[..., Any] | None = None) -> None:
        self._register = register  # tests: (name, type, port, txt) -> handle, and .stop(handle)
        self._ref: Any = None
        self._lib: Any = None

    def start(
        self, port: int, host: str | None = None, extra: dict[str, str] | None = None
    ) -> bool:
        """extra: more of the TXT record (tls=1, fp=<short fingerprint>: hints for the
        pairing list, never trusted by the app)."""
        if self._ref is not None:
            return True
        host = local_host_name() if host is None else host
        name = f"J.A.R.V.I.S. on {host}" if host else "J.A.R.V.I.S."
        txt = txt_record({**({"host": f"{host}.local"} if host else {}), **(extra or {})})
        try:
            if self._register is not None:
                self._ref = self._register(name, SERVICE_TYPE, port, txt)
            else:
                self._ref = self._dns_sd_register(name, port, txt)
        except (OSError, AttributeError, ValueError) as exc:
            log.warning("couldn't advertise the companion over Bonjour: %s", exc)
            self._ref = None
        return self._ref is not None

    def _dns_sd_register(self, name: str, port: int, txt: bytes) -> Any:
        lib = self._lib or ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        self._lib = lib
        lib.DNSServiceRegister.restype = ctypes.c_int32
        lib.DNSServiceRegister.argtypes = [
            ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint32, ctypes.c_uint32,
            ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
            ctypes.c_uint16, ctypes.c_uint16, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]  # fmt: skip
        ref = ctypes.c_void_p()
        err = lib.DNSServiceRegister(
            ctypes.byref(ref), 0, 0, name.encode(), SERVICE_TYPE.encode(), None, None,
            socket.htons(port), len(txt), txt or None, None, None,
        )  # fmt: skip
        if err != 0 or not ref.value:
            raise OSError(f"DNSServiceRegister returned {err}")
        return ref

    def stop(self) -> None:
        ref, self._ref = self._ref, None
        if ref is None:
            return
        try:
            if self._register is not None:
                self._register.stop(ref)
            elif self._lib is not None:
                self._lib.DNSServiceRefDeallocate.argtypes = [ctypes.c_void_p]
                self._lib.DNSServiceRefDeallocate(ref)
        except (OSError, AttributeError) as exc:
            log.warning("couldn't stop the Bonjour advertisement: %s", exc)

    @property
    def active(self) -> bool:
        return self._ref is not None


def wav_bytes(audio: Any, rate: int) -> bytes:
    import wave

    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Doorway:
    """The companion's socket, answered here rather than by asyncio's server: each new
    connection's first byte says what it speaks (a TLS handshake starts with 0x16). TLS
    goes on to the handshake, with a deadline; plain HTTP only while the owner has turned
    it back on (PLAIN_PREF), else the connection is closed unanswered. Connections still
    being told apart or shaking hands are capped, per address and in all."""

    def __init__(
        self,
        sock: socket.socket,
        factory: Callable[[], asyncio.Protocol],
        context: ssl.SSLContext,
        plain_allowed: Callable[[], bool],
    ) -> None:
        self.sock = sock
        self.factory = factory
        self.context = context
        self.plain_allowed = plain_allowed
        self._accepting: asyncio.Task | None = None
        self._opening: set[asyncio.Task] = set()
        self._per_address: dict[str, int] = {}

    def start(self) -> None:
        self._accepting = asyncio.get_running_loop().create_task(self._accept())

    async def _accept(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                conn, address = await loop.sock_accept(self.sock)
            except OSError as exc:  # out of file descriptors; one reset while it waited
                log.warning("companion server: accept failed (%s)", exc)
                await asyncio.sleep(0.2)
                continue
            host = str(address[0]) if isinstance(address, tuple) and address else ""
            if (
                len(self._opening) >= OPENING_AT_ONCE
                or self._per_address.get(host, 0) >= OPENING_PER_ADDRESS
            ):
                conn.close()
                continue
            self._per_address[host] = self._per_address.get(host, 0) + 1
            task = loop.create_task(self._open(conn, host))
            self._opening.add(task)
            task.add_done_callback(self._opening.discard)

    async def _open(self, conn: socket.socket, host: str) -> None:
        loop = asyncio.get_running_loop()
        try:
            first = await self._first_byte(loop, conn)
            if first == b"\x16":
                context: ssl.SSLContext | None = self.context
            elif first and self._plain():
                context = None
            else:
                if first:
                    await self._refuse_plain(loop, conn)
                conn.close()
                return
            await loop.connect_accepted_socket(
                self.factory,
                sock=conn,
                ssl=context,
                ssl_handshake_timeout=HANDSHAKE_SECONDS if context else None,
            )
        except OSError:  # a failed handshake, a reset: that connection is done
            conn.close()
        except asyncio.CancelledError:
            conn.close()
            raise
        finally:
            left = self._per_address.get(host, 1) - 1
            if left > 0:
                self._per_address[host] = left
            else:
                self._per_address.pop(host, None)

    @staticmethod
    async def _refuse_plain(loop: asyncio.AbstractEventLoop, conn: socket.socket) -> None:
        """Plain HTTP with the switch off gets a short answer, never the API: the web page
        moves to https (its address, as the browser gave it), and anything else is told
        to update the app or turn plain HTTP on in Settings."""
        head = b""
        with contextlib.suppress(OSError, TimeoutError):
            deadline = loop.time() + 2
            while b"\r\n\r\n" not in head and len(head) < 8192:
                chunk = await asyncio.wait_for(
                    loop.sock_recv(conn, 8192), max(0.0, deadline - loop.time())
                )
                if not chunk:
                    break
                head += chunk
        lines = head.split(b"\r\n")
        parts = lines[0].split(b" ") if lines else []
        method, path = (parts[0], parts[1]) if len(parts) >= 2 else (b"", b"")
        host = next((line[5:].strip() for line in lines[1:] if line[:5].lower() == b"host:"), b"")
        page = method == b"GET" and not path.startswith(b"/api/")
        if page and re.fullmatch(rb"[A-Za-z0-9.\-]{1,253}(:\d{1,5})?", host) and path[:1] == b"/":
            location = (
                b"https://" + host + (path if re.fullmatch(rb"/[\x21-\x7e]*", path) else b"/")
            )
            reply = (
                b"HTTP/1.1 308 Permanent Redirect\r\nLocation: " + location
                + b"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )  # fmt: skip
        else:
            body = json.dumps(
                {
                    "error": "Jarvis on the Mac now needs a secure connection. Update the app, "
                    "or turn on plain HTTP in Jarvis's Settings."
                }
            ).encode()
            reply = (
                b"HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\n"
                b"Content-Length: " + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n" + body
            )  # fmt: skip
        with contextlib.suppress(OSError, TimeoutError):
            await asyncio.wait_for(loop.sock_sendall(conn, reply), 2)
            # Closed with a body still unread, the socket would reset and the reply could
            # be lost: say we're done, then let what's left of the request drain away.
            conn.shutdown(socket.SHUT_WR)
            drained, deadline = 0, loop.time() + 1
            while drained < 65536:
                chunk = await asyncio.wait_for(
                    loop.sock_recv(conn, 16384), max(0.0, deadline - loop.time())
                )
                if not chunk:
                    break
                drained += len(chunk)

    def _plain(self) -> bool:
        try:
            return bool(self.plain_allowed())
        except Exception:  # can't tell: TLS only
            return False

    @staticmethod
    async def _first_byte(loop: asyncio.AbstractEventLoop, conn: socket.socket) -> bytes:
        """The connection's first byte, left in place for whoever reads it next. b"" when
        it closes, or says nothing within REQUEST_SECONDS."""
        deadline = loop.time() + REQUEST_SECONDS
        fd = conn.fileno()
        while True:
            ready = loop.create_future()
            loop.add_reader(fd, lambda f=ready: f.done() or f.set_result(None))
            try:
                await asyncio.wait_for(ready, max(0.0, deadline - loop.time()))
            except TimeoutError:
                return b""
            finally:
                loop.remove_reader(fd)
            try:
                return conn.recv(1, socket.MSG_PEEK)
            except (BlockingIOError, InterruptedError):
                continue  # woken with nothing to read after all

    def close(self) -> None:
        for task in [self._accepting, *self._opening]:
            if task is not None:
                task.cancel()

    async def wait_closed(self) -> None:
        tasks = [t for t in [self._accepting, *self._opening] if t is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class _Uvicorn(uvicorn.Server):
    """uvicorn, taking its connections from a Doorway. The main server owns Ctrl-C and
    SIGTERM."""

    def __init__(
        self, config: Any, context: ssl.SSLContext, plain_allowed: Callable[[], bool]
    ) -> None:
        super().__init__(config)
        self._context = context
        self._plain_allowed = plain_allowed

    @contextlib.contextmanager
    def capture_signals(self):
        yield

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await self.lifespan.startup()
        config = self.config

        def protocol() -> asyncio.Protocol:
            return config.http_protocol_class(
                config=config, server_state=self.server_state, app_state=self.lifespan.state
            )

        self.servers = []  # type: ignore[assignment]  # doorways: close() and wait_closed()
        for sock in sockets or []:
            doorway = Doorway(sock, protocol, self._context, self._plain_allowed)
            doorway.start()
            self.servers.append(doorway)  # type: ignore[arg-type]
        self.started = True


class RemoteServer:
    """Starts and stops the companion server inside the app's event loop.

    It binds its own socket and hands it to uvicorn: left to itself, uvicorn meets a busy
    port with sys.exit(), and that SystemExit, escaping the event loop, took the whole app
    down, at every launch once the companion had been switched on. Now a busy port (or
    any other failure to start) switches the companion back off and says why.

    It serves HTTPS with the certificate kept beside devices.json (and prefs.json):
    made the first time, kept until the owner asks for a new one."""

    def __init__(
        self,
        hub: Any,
        devices: Devices | None = None,
        port: int = PORT,
        host: str = HOST,
        advertiser: Advertiser | None = None,
    ) -> None:
        self.hub = hub
        self.devices = devices or Devices()
        self.port = port  # 0: any free port (the one taken is kept here)
        self.host = host
        # Only a server the phone can reach is worth announcing (tests listen on loopback).
        self.advertiser = advertiser or (Advertiser() if host == HOST else None)
        self.extension: Any = None  # jarvis.companion.Companion, when its feature installed
        self.identity: companion_tls.Identity | None = None
        self.host_name = ""  # the Mac's Bonjour name, for the pairing QR code
        self.mac_name = ""  # its name as the owner set it
        self._server: Any = None
        self._task: asyncio.Task | None = None
        self.error = ""

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def folder(self) -> Path:
        """Where the certificate is kept: beside devices.json (and prefs.json)."""
        return self.devices.path.parent

    def plain_allowed(self) -> bool:
        """Whether plain HTTP is let in too (Settings; off unless the owner turned it on)."""
        prefs = getattr(self.hub, "prefs", None)
        feature = getattr(prefs, "feature", None)
        try:
            return callable(feature) and feature(PLAIN_PREF) is True
        except Exception:
            return False

    def _names(self) -> None:
        """The Mac's names, and its certificate (made the first time). Blocking."""
        self.host_name = local_host_name()
        self.mac_name = computer_name()
        hosts = [f"{self.host_name}.local"] if self.host_name else []
        hosts += [ip for ip in (lan_address(),) if ip]
        self.identity = companion_tls.load_or_create(self.folder, hosts)

    async def start(self) -> bool:
        """True once it's listening. On failure it's off: error says why, the setting is
        switched back off and the window hears of it."""
        if self.running:
            return True
        try:
            sock = self._bind()
        except OSError as exc:
            log.warning("companion server can't bind port %d: %s", self.port, exc)
            self._failed(
                f"Port {self.port} is in use by another app, so the phone companion is off. "
                "Quit that app, then turn the companion on again."
            )
            return False
        try:
            await asyncio.to_thread(self._names)
            assert self.identity is not None
            context = companion_tls.server_context(self.identity)
        except (OSError, ValueError, ssl.SSLError) as exc:
            sock.close()
            log.warning("companion server has no certificate: %s", exc)
            self._failed(
                "The phone companion couldn't set up its secure connection, so it's off. "
                "Try turning it on again."
            )
            return False
        config = uvicorn.Config(
            create_remote_app(
                self.hub,
                self.devices,
                identity=self.identity,
                mac_name=self.mac_name,
                extension=self.extension,
            ),
            log_level="warning",
            lifespan="off",
            http=GuardedH11,
            timeout_keep_alive=5,
            h11_max_incomplete_event_size=16 * 1024,
        )
        self._server = _Uvicorn(config, context, self.plain_allowed)
        self._task = asyncio.create_task(self._serve(self._server, sock))
        await asyncio.sleep(0.3)
        if self._task.done():
            task, self._server, self._task = self._task, None, None
            if not task.cancelled() and task.exception() is not None:
                log.warning("companion server failed: %r", task.exception())
            self._failed(
                "The phone companion couldn't start, so it's off. Try turning it on again."
            )
            return False
        self.error = ""
        log.info("companion server listening on port %d (https)", self.port)
        if self.advertiser is not None:
            self.advertiser.start(
                self.port, self.host_name, {"tls": "1", "fp": self.identity.short}
            )
        # So a paired phone can open JARVIS once it's quit (only the app's own backend).
        from . import companion_wake

        with contextlib.suppress(OSError, subprocess.SubprocessError):
            await asyncio.to_thread(companion_wake.install, None, self.folder)
        return True

    def _bind(self) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((self.host, self.port))
            sock.listen(128)
            sock.setblocking(False)
        except OSError:
            sock.close()
            raise
        self.port = sock.getsockname()[1]
        return sock

    @staticmethod
    async def _serve(server: Any, sock: socket.socket) -> None:
        try:
            await server.serve(sockets=[sock])
        except SystemExit as exc:  # uvicorn's way of saying it can't start; the app lives on
            log.warning("companion server stopped (exit %s)", exc.code)
        finally:
            sock.close()

    def _failed(self, message: str) -> None:
        self.error = message
        log.warning("companion server didn't start: %s", message)
        prefs = getattr(self.hub, "prefs", None)
        if getattr(prefs, "remote_enabled", False):
            self.hub.set_prefs({"remote_enabled": False})  # no retrying it at every launch
        self.hub.emit("error", text=message)
        self.hub.emit("remote", **self.public())

    async def stop(self) -> None:
        if self.advertiser is not None:
            self.advertiser.stop()
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._task, 5)
        self._server = self._task = None

    async def new_identity(self) -> None:
        """A new certificate (Settings): every phone pinned the old one, so each is
        unpaired and pairs again. The server, if it's on, restarts with it."""
        was_running = self.running
        await self.stop()
        await asyncio.to_thread(companion_tls.remove, self.folder)
        self.identity = None
        for device in list(self.devices.items):
            self.devices.remove(device.id)
        if was_running:
            await self.start()
        else:
            await asyncio.to_thread(self._names)

    def public(self) -> dict[str, Any]:
        identity = self.identity
        return {
            "running": self.running,
            "error": self.error,
            "urls": addresses(self.port) if self.running else [],
            "devices": self.devices.public(),
            "tls": {
                "fingerprint": identity.fingerprint,
                "short": identity.short,
                "expires": identity.not_after.isoformat(timespec="seconds"),
            }
            if identity is not None
            else None,
            "plain_http": self.plain_allowed(),
        }
