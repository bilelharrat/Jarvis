"""Local server for the JARVIS app window: static UI plus one WebSocket per window.

It binds to 127.0.0.1 only. The socket drives your Mac, so it also demands the launch
token and an Origin header from this same server: a web page in your browser can reach
localhost, but it can't guess the token or fake the origin.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
from pathlib import Path

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from .hub import Hub

WEB_DIR = Path(__file__).parent / "web"


def create_app(hub: Hub, token: str) -> Starlette:
    async def index(_request):
        return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})

    async def health(_request):
        return JSONResponse({"ok": True})

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
            WebSocketRoute("/ws", socket),
            Mount("/static", StaticFiles(directory=WEB_DIR)),
        ],
        lifespan=lifespan,
    )


def serve(port: int, token: str) -> None:
    import uvicorn

    from .config import load_settings

    app = create_app(Hub(load_settings()), token)
    print(f"JARVIS listening on http://127.0.0.1:{port}/?token={token}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
