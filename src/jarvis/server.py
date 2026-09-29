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
from starlette.websockets import WebSocket, WebSocketDisconnect

from .hub import Hub

WEB_DIR = Path(__file__).parent / "web"
VISION_DIR = (
    Path(__file__).resolve().parents[2] / "app" / "node_modules" / "@mediapipe" / "tasks-vision"
)
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
        await ws.send_json(hub.snapshot())

        async def pump() -> None:
            while True:
                await ws.send_json(await queue.get())

        sender = asyncio.create_task(pump())
        try:
            while True:
                msg = await ws.receive_json()
                if isinstance(msg, dict):
                    await hub.handle(msg)
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            sender.cancel()
            hub.unsubscribe(queue)

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
            Mount("/static", StaticFiles(directory=WEB_DIR)),
            Mount("/vision", StaticFiles(directory=VISION_DIR, check_dir=False)),
        ],
        lifespan=lifespan,
    )


def serve(port: int, token: str) -> None:
    import logging

    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("pypdf", "fontTools", "httpx", "httpx2", "mcp"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    from .config import load_settings

    app = create_app(Hub(load_settings()), token)
    print(f"JARVIS listening on http://127.0.0.1:{port}/?token={token}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
