"""Local server for the JARVIS app window: static UI plus one WebSocket per window.

It binds to 127.0.0.1 only. The socket drives your Mac, so it also demands the launch
token and an Origin header from this same server: a web page in your browser can reach
localhost, but it can't guess the token or fake the origin.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import secrets
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from .hub import Hub


class FreshStaticFiles(StaticFiles):
    """The window's own scripts, revalidated on every load so a module another module
    imports (which can't carry a ?v= stamp) is never a stale copy."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


WEB_DIR = Path(__file__).parent / "web"
VISION_DIR = (
    Path(__file__).resolve().parents[2] / "app" / "node_modules" / "@mediapipe" / "tasks-vision"
)
XTERM_DIR = Path(__file__).resolve().parents[2] / "app" / "node_modules" / "@xterm"
HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/"
    "float16/latest/hand_landmarker.task"
)


def create_app(hub: Hub, token: str) -> Starlette:
    async def index(_request):
        # Stamp script and stylesheet links with a version so an update is never hidden by
        # the window's cache.
        version = str(int(max(f.stat().st_mtime for f in WEB_DIR.iterdir() if f.is_file())))
        html = (WEB_DIR / "index.html").read_text()
        html = re.sub(r'(/static/[\w-]+\.(?:js|css))"', rf'\1?v={version}"', html)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def health(_request):
        return JSONResponse({"ok": True})

    async def hand_model(_request):
        """MediaPipe's hand model, fetched once from Google's model store and cached."""
        from .prefs import APP_SUPPORT

        path = APP_SUPPORT / "models" / "hand_landmarker.task"
        if not path.exists():
            import httpx

            path.parent.mkdir(parents=True, exist_ok=True)
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                response = await client.get(HAND_MODEL_URL)
                response.raise_for_status()
            tmp = path.with_suffix(".part")
            tmp.write_bytes(response.content)
            tmp.replace(path)
        return FileResponse(path, media_type="application/octet-stream")

    async def socket(ws: WebSocket) -> None:
        offered = ws.query_params.get("token", "")
        origin = ws.headers.get("origin", "")
        host = ws.headers.get("host", "")
        if not secrets.compare_digest(offered, token) or origin != f"http://{host}":
            await ws.close(code=4403)
            return
        await ws.accept()
        queue = hub.subscribe()
        sender: asyncio.Task | None = None

        async def pump() -> None:
            while (event := await queue.get()) is not None:
                await ws.send_json(event)
            # Fell too far behind: close, and the window reconnects to a fresh snapshot.
            with contextlib.suppress(Exception):
                await ws.close(code=4408)

        try:
            await ws.send_json(hub.snapshot())
            sender = asyncio.create_task(pump())
            while True:
                try:
                    msg = await ws.receive_json()
                except (ValueError, KeyError, TypeError):  # a frame that isn't JSON: skip it
                    continue
                if isinstance(msg, dict):
                    # Never raises; slow commands run in the background (Hub.handle).
                    await hub.handle(msg)
        except Exception:  # disconnected, or the socket failed: the window is gone either way
            pass
        finally:
            if sender is not None:
                sender.cancel()
            hub.unsubscribe(queue)
            with contextlib.suppress(Exception):  # already closed by the other side, mostly
                await ws.close()

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        await hub.start()
        try:
            yield
        finally:
            await hub.close()

    return Starlette(
        routes=[
            Route("/", index),
            Route("/health", health),
            Route("/models/hand_landmarker.task", hand_model),
            WebSocketRoute("/ws", socket),
            Mount("/static", FreshStaticFiles(directory=WEB_DIR)),
            Mount("/vision", StaticFiles(directory=VISION_DIR, check_dir=False)),
            Mount("/xterm", StaticFiles(directory=XTERM_DIR, check_dir=False)),
        ],
        lifespan=lifespan,
    )


def serve(port: int, token: str) -> None:
    import logging
    import logging.handlers

    # PortAudio first, while nothing else runs: importing sounddevice starts it with the
    # whole process's stderr pointed at /dev/null for a moment. Done later, on the
    # microphone's thread, that swallowed log lines from every other thread and gave
    # /dev/null for stderr to any process started meanwhile.
    with contextlib.suppress(Exception):  # no PortAudio: the microphone says so later
        import sounddevice  # noqa: F401

    import resource

    import uvicorn

    # Room for sockets and files: the window server, the phone companion, voice, the
    # file index and the Claude sessions share one process, and launchd's default soft
    # limit (256 open files) is easy to reach under load.
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    want = 4096 if hard == resource.RLIM_INFINITY else min(4096, hard)
    if soft < want:
        with contextlib.suppress(ValueError, OSError):
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    # And a file of its own, so no line depends on where stderr happens to point.
    log_file = Path.home() / "Library" / "Logs" / "Jarvis" / "jarvis.log"
    with contextlib.suppress(OSError):
        log_file.parent.mkdir(parents=True, exist_ok=True)
        to_file = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=2_000_000, backupCount=2, encoding="utf-8"
        )
        to_file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger().addHandler(to_file)
    for noisy in ("pypdf", "fontTools", "httpx", "httpx2", "mcp"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    from .config import load_settings

    app = create_app(Hub(load_settings()), token)
    print(f"JARVIS listening on http://127.0.0.1:{port}/?token={token}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
