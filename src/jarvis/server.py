"""Local server for the JARVIS app window: static UI plus one WebSocket per window.

It binds to 127.0.0.1 only. The socket drives your Mac, so it also demands the launch
token and an Origin header from this same server: a web page in your browser can reach
localhost, but it can't guess the token or fake the origin.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
import secrets
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from . import packaged
from .hub import Hub

log = logging.getLogger("jarvis")
# Frames one window's burst may carry before the others get a turn: a single read can hold
# thousands of small commands, and handling them all in one step starves every pump.
YIELD_EVERY = 32


class FreshStaticFiles(StaticFiles):
    """The window's own scripts, revalidated on every load so a module another module
    imports (which can't carry a ?v= stamp) is never a stale copy."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


WEB_DIR = Path(__file__).parent / "web"
VISION_DIR = packaged.app_dir() / "node_modules" / "@mediapipe" / "tasks-vision"
XTERM_DIR = packaged.app_dir() / "node_modules" / "@xterm"
HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/"
    "float16/latest/hand_landmarker.task"
)


def zh_strings(web_dir: Path = WEB_DIR) -> dict[str, Any]:
    """The window's Chinese: i18n-zh.json with each feature's web/i18n/*.json merged in, in
    name order (strings: a later file's wins; patterns: all of them, base file first). A
    fragment that can't be read is skipped, never the whole translation."""
    merged: dict[str, Any] = {"strings": {}, "patterns": []}
    files = [web_dir / "i18n-zh.json", *sorted((web_dir / "i18n").glob("*.json"))]
    for path in files:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            if path.name != "i18n-zh.json" or path.exists():
                log.warning("i18n: skipped %s", path.name)
            continue
        if not isinstance(data, dict):
            continue
        strings, patterns = data.get("strings"), data.get("patterns")
        if isinstance(strings, dict):
            merged["strings"].update(
                {k: v for k, v in strings.items() if isinstance(k, str) and isinstance(v, str)}
            )
        if isinstance(patterns, list):
            merged["patterns"] += [p for p in patterns if isinstance(p, list) and len(p) == 2]
    return merged


def feature_assets(web_dir: Path = WEB_DIR) -> dict[str, list[str]]:
    """The feature modules' window files (web/features/*.js and *.css), in name order, each
    stamped with its modification time so an edit is never hidden by the cache."""
    found: dict[str, list[str]] = {"scripts": [], "styles": []}
    folder = web_dir / "features"
    for kind, suffix in (("scripts", ".js"), ("styles", ".css")):
        for path in sorted(folder.glob(f"*{suffix}")):
            try:
                stamp = int(path.stat().st_mtime)
            except OSError:
                continue
            found[kind].append(f"/static/features/{path.name}?v={stamp}")
    return found


def create_app(hub: Hub, token: str) -> Starlette:
    async def index(_request):
        # Stamp script and stylesheet links with a version so an update is never hidden by
        # the window's cache.
        version = str(int(max(f.stat().st_mtime for f in WEB_DIR.iterdir() if f.is_file())))
        html = (WEB_DIR / "index.html").read_text()
        html = re.sub(r'(/static/[\w-]+\.(?:js|css))"', rf'\1?v={version}"', html)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    async def health(_request):
        # busy: whether a restart now would cut something off (the app updates quietly only
        # when it's false).
        try:
            busy = bool(hub.busy())
        except Exception:
            busy = True
        return JSONResponse({"ok": True, "busy": busy})

    async def zh_json(_request):
        return JSONResponse(zh_strings(), headers={"Cache-Control": "no-cache"})

    async def features_json(_request):
        return JSONResponse(feature_assets(), headers={"Cache-Control": "no-store"})

    async def inbound_hook(request):
        """POST /hooks/<name>: the owner's local tools telling JARVIS something (the
        automation feature checks the hook's token, size and rate; never a web page's)."""
        status, body = await hub.inbound_hook(request.path_params["name"], request)
        return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})

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

    async def send_event(ws: WebSocket, event: dict[str, Any]) -> None:
        await ws.send_text(event_text(event))

    async def socket(ws: WebSocket) -> None:
        offered = ws.query_params.get("token", "")
        origin = ws.headers.get("origin", "")
        host = ws.headers.get("host", "")
        # This machine's own address only: a page that points its own name at 127.0.0.1
        # sends that name as the Host (and the Origin to match it).
        port = (ws.scope.get("server") or ("", 0))[1]
        loopback = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        # Compared as bytes: a token with other characters in it is just a wrong token.
        if (
            not secrets.compare_digest(offered.encode(errors="replace"), token.encode())
            or host not in loopback
            or origin != f"http://{host}"
        ):
            await ws.close(code=4403)
            return
        await ws.accept()
        queue = hub.subscribe()
        sender: asyncio.Task | None = None

        async def pump() -> None:
            unsendable: set[str] = set()
            try:
                while (event := await queue.get()) is not None:
                    try:
                        text = event_text(event)
                    except Exception:  # no JSON can carry it (a tuple key, absurd nesting)
                        kind = str(event.get("type"))
                        if kind not in unsendable:  # said once per kind, not per event
                            unsendable.add(kind)
                            log.exception("window event %r can't be sent; skipped", kind)
                        continue
                    await ws.send_text(text)
                code = 4408  # fell too far behind: it reconnects to a fresh snapshot
            except Exception:  # the socket failed under it: never a window left deaf
                code = 1011
            with contextlib.suppress(Exception):
                await ws.close(code=code)

        try:
            await send_event(ws, hub.snapshot())
            sender = asyncio.create_task(pump())
            frames = 0
            while True:
                frames += 1
                if frames % YIELD_EVERY == 0:
                    await asyncio.sleep(0)  # a burst from one read: let the pumps run too
                try:
                    msg = await ws.receive_json()
                except (ValueError, KeyError, TypeError, RecursionError):
                    continue  # a frame that isn't JSON, or is nested absurdly deep: skip it
                if isinstance(msg, dict) and isinstance(msg.get("type"), str):
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
            Route("/static/i18n-zh.json", zh_json),
            Route("/features.json", features_json),
            Route("/hooks/{name}", inbound_hook, methods=["POST"]),
            Route("/models/hand_landmarker.task", hand_model),
            *getattr(hub, "routes", ()),  # the feature modules' own (hub.register_route)
            WebSocketRoute("/ws", socket),
            Mount("/static", FreshStaticFiles(directory=WEB_DIR)),
            Mount("/vision", StaticFiles(directory=VISION_DIR, check_dir=False)),
            Mount("/xterm", StaticFiles(directory=XTERM_DIR, check_dir=False)),
        ],
        lifespan=lifespan,
    )


def _finite(value: Any) -> Any:
    """The same data with NaN and infinities as null: the browser's JSON can't read them."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def event_text(event: dict[str, Any]) -> str:
    """An event as the window reads it, whatever is in it: an odd value (a lone surrogate
    from a file name, a NaN from a sensor, an object) never stops a window's events."""
    try:
        text = json.dumps(
            event, ensure_ascii=False, separators=(",", ":"), default=str, allow_nan=False
        )
    except ValueError:  # NaN or infinity somewhere
        text = json.dumps(_finite(event), ensure_ascii=False, separators=(",", ":"), default=str)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:  # half of a surrogate pair: becomes U+FFFD (as fileindex does)
        text = text.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    return text


# How long a starting backend waits for the data folder when another backend holds it:
# enough for the one of a Jarvis that was just quit or updated to finish quitting.
FOLDER_WAIT_S = 20.0


def serve(port: int, token: str) -> None:
    import logging
    import logging.handlers
    import sys

    from . import jsonstore
    from .prefs import APP_SUPPORT

    # One backend per Mac: two on the same files would save over each other's changes,
    # hand out the same invoice numbers and answer the same conversations twice. The lock
    # is held while this process lives, and the system lets go of it however it ends.
    try:
        instance = jsonstore.claim_folder(APP_SUPPORT, wait=FOLDER_WAIT_S)
    except jsonstore.FolderTaken as exc:
        print(
            f"JARVIS can't start: {exc.strerror} ({APP_SUPPORT}). Quit that one first.",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(75) from None  # EX_TEMPFAIL: the app says so and tries again later

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

    # Feature modules' work that must come before any store reads its file (a restored
    # backup put in place), while this process holds the folder.
    from . import features
    from .config import load_settings

    features.prepare_all(APP_SUPPORT)
    from . import launcher_watch

    launcher_watch.start()  # the app quits or crashes: this backend goes too, lock and all
    app = create_app(Hub(load_settings()), token)
    print(f"JARVIS listening on http://127.0.0.1:{port}/?token={token}", flush=True)
    # Frames up to 64 MiB: a message with its attachments (the composer caps them at 24 MB).
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", ws_max_size=64 * 1024 * 1024)
    if instance is not None:  # held until the server has stopped
        instance.close()
