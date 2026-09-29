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
import hashlib
import io
import json
import logging
import secrets
import socket
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Route

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
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "devices.json"
        self.items: list[Device] = []
        self.code: str | None = None
        self.code_expires = 0.0
        self.failures: deque[float] = deque()
        try:
            self.items = [Device(**d) for d in json.loads(self.path.read_text())]
        except (OSError, ValueError, TypeError):
            self.items = []

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(d) for d in self.items], indent=2))
        tmp.chmod(0o600)
        tmp.replace(self.path)

    def start_pairing(self) -> str:
        self.code = f"{secrets.randbelow(10**6):06d}"
        self.code_expires = time.monotonic() + CODE_SECONDS
        return self.code

    def locked(self) -> bool:
        now = time.monotonic()
        while self.failures and now - self.failures[0] > LOCKOUT_SECONDS:
            self.failures.popleft()
        return len(self.failures) >= MAX_FAILURES

    def pair(self, code: str, name: str) -> str:
        if self.locked():
            raise PermissionError("Too many wrong codes. Wait five minutes.")
        live = self.code is not None and time.monotonic() < self.code_expires
        if not live or not secrets.compare_digest(str(code).strip(), self.code or ""):
            self.failures.append(time.monotonic())
            raise PermissionError(
                "That code isn't right, or it expired. Make a new one on the Mac."
            )
        self.code = None  # one pairing per code
        token = secrets.token_urlsafe(32)
        device = Device(
            uuid.uuid4().hex[:8],
            " ".join(str(name).split())[:40] or "Phone",
            _hash(token),
            datetime.now().isoformat(timespec="seconds"),
        )
        self.items.append(device)
        self.save()
        return token

    def check(self, token: str) -> Device | None:
        if not token:
            return None
        wanted = _hash(token)
        for device in self.items:
            if secrets.compare_digest(device.token_hash, wanted):
                return device
        return None

    def seen(self, device: Device) -> None:
        now = datetime.now().isoformat(timespec="minutes")
        if device.last_seen != now:
            device.last_seen = now
            self.save()

    def remove(self, device_id: str) -> bool:
        before = len(self.items)
        self.items = [d for d in self.items if d.id != device_id]
        if len(self.items) != before:
            self.save()
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

    async def body(request: Request) -> dict[str, Any]:
        raw = await request.body()
        if len(raw) > 20_000:
            return {}
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

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
        try:
            token = devices.pair(str(data.get("code", "")), str(data.get("name", "")))
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=403)
        hub.emit("devices", items=devices.public(), paired=True)
        return JSONResponse({"token": token})

    async def state(request: Request):
        if device_for(request) is None:
            return denied()
        return JSONResponse(hub.remote_state())

    async def ask(request: Request):
        if device_for(request) is None:
            return denied()
        text = str((await body(request)).get("text", "")).strip()[:4000]
        if not text:
            return JSONResponse({"error": "Say something."}, status_code=400)
        reply = await hub.remote_ask(text, ASK_TIMEOUT)
        return JSONResponse(reply)

    async def approve(request: Request):
        if device_for(request) is None:
            return denied()
        data = await body(request)
        ok = hub.resolve(str(data.get("id", "")), str(data.get("choice", "")))
        return JSONResponse({"ok": ok})

    async def command(request: Request):
        if device_for(request) is None:
            return denied()
        data = await body(request)
        kind = str(data.get("type", ""))
        if kind not in COMMANDS:
            return JSONResponse({"error": "Not available from the phone."}, status_code=400)
        await hub.handle({k: v for k, v in data.items() if isinstance(v, (str, int, bool))})
        return JSONResponse({"ok": True})

    async def say(request: Request):
        """The reply in JARVIS's own voice, for the phone to play."""
        if device_for(request) is None:
            return denied()
        text = str((await body(request)).get("text", "")).strip()[:1500]
        if not text:
            return Response(status_code=400)
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
        self, hub: Any, devices: Devices | None = None, port: int = PORT, host: str = HOST
    ) -> None:
        self.hub = hub
        self.devices = devices or Devices()
        self.port = port  # 0: any free port (the one taken is kept here)
        self.host = host
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
            create_remote_app(self.hub, self.devices), log_level="warning", lifespan="off"
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
