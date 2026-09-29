"""The iPhone and Watch companion: JARVIS from your pocket.

Off by default. When the user turns it on, a second, separate server listens on the
network (port 8765) with a small phone-sized page (add it to the Home Screen) and a JSON
API that an Apple Watch Shortcut can call. The Mac window's own server stays bound to
127.0.0.1 and is never reachable from here.

A device gets in only by pairing: the Mac shows a one-time six-digit code (five minutes,
five wrong tries and pairing locks for five minutes), which the phone trades for its own
long random token. Only a hash of the token is stored, and each device can be removed.
The API is a short allowlist: ask, stop, answer a pending approval, a few app commands
and the current state. Requests from the phone run as silent turns, so the Mac doesn't
talk to an empty room.

Traffic is plain HTTP, so on shared Wi-Fi prefer Tailscale (encrypted), which also works
away from home.
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import hashlib
import io
import json
import logging
import re
import secrets
import socket
import subprocess
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import h11
from starlette.applications import Starlette
from starlette.requests import ClientDisconnect, Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route
from uvicorn.protocols.http.h11_impl import H11Protocol

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
        rows = [{**self.extra.get(d.id, {}), **asdict(d)} for d in self.items] + self.broken
        jsonstore.save_json(self.path, rows, backup=keep_copy)

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
        if not live or not secrets.compare_digest(str(code).strip(), self.code or ""):
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
            with contextlib.suppress(OSError):  # only when it was last seen: never worth a failure
                self.save()

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


def addresses(port: int = PORT) -> list[str]:
    """URLs a phone on the same network (or tailnet) can use."""
    urls = []
    host = socket.gethostname()
    if host:
        host = host if host.endswith(".local") else f"{host}.local"
        urls.append(f"http://{host}:{port}")
    with contextlib.suppress(OSError):
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))  # picks the LAN interface; sends nothing
        urls.append(f"http://{probe.getsockname()[0]}:{port}")
        probe.close()
    return urls


def create_remote_app(hub: Any, devices: Devices) -> Starlette:
    def device_for(request: Request) -> Device | None:
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.lower().startswith("bearer ") else ""
        device = devices.check(token)
        if device is not None:
            devices.seen(device)
        return device

    def denied() -> JSONResponse:
        return JSONResponse({"error": "Pair this device first."}, status_code=401)

    async def read_capped(request: Request) -> bytes | None:
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > MAX_BODY:
                return None
        return bytes(raw)

    async def body(request: Request) -> dict[str, Any] | None:
        """The request's JSON object, read at most MAX_BODY bytes and BODY_SECONDS long
        (before any token check, so no one on the network can make it hold more).
        None: too big or too slow; {} for anything that isn't a JSON object."""
        try:
            if int(request.headers.get("content-length") or 0) > MAX_BODY:
                return None
            raw = await asyncio.wait_for(read_capped(request), BODY_SECONDS)
        except (ValueError, TimeoutError, ClientDisconnect):
            return None
        if raw is None:
            return None
        try:
            data = json.loads(raw or b"{}")
        except (ValueError, RecursionError):
            return {}
        return data if isinstance(data, dict) else {}

    def too_big() -> JSONResponse:
        # Connection: close, or uvicorn keeps reading (and dropping) the rest of a body
        # we refused, for as long as the sender keeps it coming.
        return JSONResponse(
            {"error": "That request is too big or too slow."},
            status_code=413,
            headers={"Connection": "close"},
        )

    def busy() -> JSONResponse:
        return JSONResponse({"error": "Jarvis is busy. Try again in a moment."}, status_code=429)

    asking: dict[str, int] = {}  # device id -> its request still being answered
    saying = asyncio.Semaphore(SAY_AT_ONCE)

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
        path = Path(__file__).resolve().parents[2] / "app" / "build" / "icon-1024.png"
        if path.is_file():
            return FileResponse(path, media_type="image/png")
        return Response(status_code=404)

    async def pair(request: Request):
        data = await body(request)
        if data is None:
            return too_big()
        host = request.client.host if request.client else ""
        try:
            token = devices.pair(str(data.get("code", "")), str(data.get("name", "")), host)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        hub.emit("devices", items=devices.public(), paired=True)
        return JSONResponse({"token": token})

    async def state(request: Request):
        if device_for(request) is None:
            return denied()
        return JSONResponse(hub.remote_state())

    async def ask(request: Request):
        device = device_for(request)
        if device is None:
            return denied()
        data = await body(request)
        if data is None:
            return too_big()
        text = str(data.get("text", "")).strip()[:4000]
        if not text:
            return JSONResponse({"error": "Say something."}, status_code=400)
        if asking.get(device.id):
            return JSONResponse({"error": "Still on your last request."}, status_code=429)
        asking[device.id] = 1
        try:
            reply = await hub.remote_ask(text, ASK_TIMEOUT)
        finally:
            asking.pop(device.id, None)
        if reply.pop("busy", False):  # the phones already have REMOTE_TURNS going
            return busy()
        return JSONResponse(reply)

    async def approve(request: Request):
        if device_for(request) is None:
            return denied()
        data = await body(request)
        if data is None:
            return too_big()
        ok = hub.resolve(str(data.get("id", "")), str(data.get("choice", "")))
        return JSONResponse({"ok": ok})

    async def command(request: Request):
        if device_for(request) is None:
            return denied()
        data = await body(request)
        if data is None:
            return too_big()
        kind = str(data.get("type", ""))
        if kind not in COMMANDS:
            return JSONResponse({"error": "Not available from the phone."}, status_code=400)
        if not await hub.remote_command(
            {k: v for k, v in data.items() if isinstance(v, (str, int, bool))}
        ):
            return busy()
        return JSONResponse({"ok": True})

    async def say(request: Request):
        """The reply in JARVIS's own voice, for the phone to play."""
        if device_for(request) is None:
            return denied()
        data = await body(request)
        if data is None:
            return too_big()
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

    return Starlette(
        routes=[
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
    )


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

    def _arm(self) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
        self._deadline = self.loop.call_later(REQUEST_SECONDS, self._too_slow)

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

    def start(self, port: int) -> bool:
        if self._ref is not None:
            return True
        host = local_host_name()
        name = f"J.A.R.V.I.S. on {host}" if host else "J.A.R.V.I.S."
        txt = txt_record({"host": f"{host}.local"} if host else {})
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


class RemoteServer:
    """Starts and stops the companion server inside the app's event loop.

    It binds its own socket and hands it to uvicorn: left to itself, uvicorn meets a busy
    port with sys.exit(), and that SystemExit, escaping the event loop, took the whole app
    down, at every launch once the companion had been switched on. Now a busy port (or
    any other failure to start) switches the companion back off and says why."""

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
        self._server: Any = None
        self._task: asyncio.Task | None = None
        self.error = ""

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> bool:
        """True once it's listening. On failure it's off: error says why, the setting is
        switched back off and the window hears of it."""
        if self.running:
            return True
        import uvicorn

        class Quiet(uvicorn.Server):
            @contextlib.contextmanager
            def capture_signals(self):  # the main server owns Ctrl-C and SIGTERM
                yield

        try:
            sock = self._bind()
        except OSError as exc:
            log.warning("companion server can't bind port %d: %s", self.port, exc)
            self._failed(
                f"Port {self.port} is in use by another app, so the phone companion is off. "
                "Quit that app, then turn the companion on again."
            )
            return False
        config = uvicorn.Config(
            create_remote_app(self.hub, self.devices),
            log_level="warning",
            lifespan="off",
            http=GuardedH11,
            timeout_keep_alive=5,
            h11_max_incomplete_event_size=16 * 1024,
        )
        self._server = Quiet(config)
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
        log.info("companion server listening on port %d", self.port)
        if self.advertiser is not None:
            self.advertiser.start(self.port)
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

    def public(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "error": self.error,
            "urls": addresses(self.port) if self.running else [],
            "devices": self.devices.public(),
        }
