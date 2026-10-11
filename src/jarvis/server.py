"""Local server for the JARVIS app window: static UI plus one WebSocket per window.

It binds to 127.0.0.1 only. The socket drives your Mac, so it also demands the launch
token and an Origin header from this same server: a web page in your browser can reach
localhost, but it can't guess the token or fake the origin.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import gzip
import json
import logging
import math
import re
import secrets
import string
import threading
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from . import osplat, packaged
from .hub import CALLER, Hub, _text_size
from .prefs import GLASS_TONES, LOOKS


def end_children(grace: float = 1.0) -> int:
    """At the end of a stop: every process this one started that's still running (a
    Eden Code process still exiting, a helper) is asked to end, then made to after `grace`
    seconds, so none is left running on its own. How many there were."""
    try:
        import psutil

        children = psutil.Process().children(recursive=True)
    except Exception:  # psutil missing, or not ours to look at
        return 0
    for child in children:
        with contextlib.suppress(Exception):
            child.terminate()
    with contextlib.suppress(Exception):
        _gone, alive = psutil.wait_procs(children, timeout=grace)
        for child in alive:
            with contextlib.suppress(Exception):
                child.kill()
    return len(children)


# How the backend is served. Frames up to 64 MiB: a message with its attachments (the
# composer caps them at 24 MB). On a stop (the app quitting sends SIGTERM) open connections
# get SHUTDOWN_GRACE seconds, then the shutdown goes on without them: the app only hides its
# window while it waits for the backend, so the window's socket stayed open and the
# backend's shutdown didn't even begin until the app gave up waiting (5 s) and closed it.
SHUTDOWN_GRACE = 1.0
SERVE_OPTIONS: dict[str, Any] = {
    "log_level": "warning",
    "ws_max_size": 64 * 1024 * 1024,
    "timeout_graceful_shutdown": SHUTDOWN_GRACE,
}

log = logging.getLogger("jarvis")
# Frames one window's burst may carry before the others get a turn: a single read can hold
# thousands of small commands, and handling them all in one step starves every pump.
YIELD_EVERY = 32


# Text the windows load (scripts, styles, strings), sent gzipped to a browser that takes it:
# Eden Code's page was 2.5 MB of files, 0.8 MB this way. Each file is compressed once per
# version, off the event loop, and kept (GZIP_KEPT versions); the rest go as they are.
GZIP_TYPES = frozenset({".js", ".mjs", ".css", ".json", ".html", ".svg", ".map", ".txt"})
GZIP_MIN = 1024
GZIP_MAX = 8 * 1024 * 1024
GZIP_KEPT = 1024


@functools.lru_cache(maxsize=GZIP_KEPT)
def _gzipped(path: str, _mtime_ns: int, _size: int) -> bytes:
    """A file's bytes gzipped (a new modification time or size is a new entry)."""
    with open(path, "rb") as f:
        return gzip.compress(f.read(), compresslevel=6, mtime=0)


def _takes_gzip(request) -> bool:
    return "gzip" in request.headers.get("accept-encoding", "").lower()


async def _page_reply(request, body: str, media_type: str, headers: dict[str, str]) -> Response:
    """A made-per-load answer (the page, 80 KB; the feature list), gzipped in a thread for a
    browser that takes it."""
    data = body.encode()
    if len(data) < GZIP_MIN or not _takes_gzip(request):
        return Response(data, media_type=media_type, headers=headers)
    packed = await asyncio.to_thread(gzip.compress, data, 6, mtime=0)
    return Response(
        packed,
        media_type=media_type,
        headers={**headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
    )


class GzipStaticFiles(StaticFiles):
    """StaticFiles that sends text gzipped when the browser accepts it. The ETag, Cache-Control
    and 304 answers are the plain file's, as before; a range request gets the plain file."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if (
            not isinstance(response, FileResponse)
            or response.status_code != 200
            or scope.get("method") != "GET"
            or response.stat_result is None
            or Path(str(response.path)).suffix.lower() not in GZIP_TYPES
            or not GZIP_MIN <= response.stat_result.st_size <= GZIP_MAX
        ):
            return response
        headers = dict(scope.get("headers") or [])
        if b"range" in headers or b"gzip" not in headers.get(b"accept-encoding", b"").lower():
            return response
        st = response.stat_result
        try:
            body = await asyncio.to_thread(_gzipped, str(response.path), st.st_mtime_ns, st.st_size)
        except OSError:  # gone or unreadable since it was looked up: as StaticFiles would say
            return response
        kept = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        kept["Content-Encoding"] = "gzip"
        kept["Vary"] = "Accept-Encoding"
        return Response(body, status_code=200, headers=kept)


class VendorFiles:
    """app/node_modules' files (the terminal, hand tracking). Where they aren't installed (a fresh
    clone before `npm install` in app/), every request answered 500 with a traceback in the log:
    now a 404 that says so, and one line in the log. Checked per request, so an install made while
    the app runs is served at once (CH18)."""

    def __init__(self, directory: Path, what: str) -> None:
        self.directory = directory
        self.what = what
        self.files = GzipStaticFiles(directory=directory, check_dir=False)
        self.told = False

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http" and not self.directory.is_dir():
            if not self.told:
                self.told = True
                log.warning(
                    "%s isn't installed (%s): run npm install in app/", self.what, self.directory
                )
            response = Response(
                f"{self.what} isn't installed: run npm install in app/", status_code=404
            )
            await response(scope, receive, send)
            return
        await self.files(scope, receive, send)


class FreshStaticFiles(GzipStaticFiles):
    """The window's own scripts. One asked for with its ?v= stamp (the page's and
    /features.json's: the file's modification time, so an edit is a new address) is kept by the
    window as it is: each split view pane, and every load after the first, takes it from the
    cache without asking again. Any other (a module another module imports, which can't carry
    a stamp) is revalidated on every load so it's never a stale copy."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        stamped = re.search(rb"(?:^|&)v=\d", scope.get("query_string") or b"") is not None
        kept = stamped and response.status_code in (200, 304)
        response.headers["Cache-Control"] = "max-age=31536000, immutable" if kept else "no-cache"
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


def feature_assets(web_dir: Path = WEB_DIR, skip: set[str] | None = None) -> dict[str, list[str]]:
    """The feature modules' window files (web/features/*.js and *.css), in name order, each
    stamped with its modification time so an edit is never hidden by the cache. skip: the
    stems of Labs features that are off."""
    found: dict[str, list[str]] = {"scripts": [], "styles": []}
    folder = web_dir / "features"
    for kind, suffix in (("scripts", ".js"), ("styles", ".css")):
        for path in sorted(folder.glob(f"*{suffix}")):
            if skip and path.stem in skip:
                continue
            try:
                # (in ms: two saves in one second are two addresses). A module that loads its
                # own files later (code-split.js: code-split/window.js and .css) passes its
                # stamp on to them: it's the newest of them all, so an edit to one is a new
                # address for each.
                own = path.parent / path.stem
                parts = [p for p in own.iterdir() if p.is_file()] if own.is_dir() else []
                stamp = max(p.stat().st_mtime_ns for p in [path, *parts]) // 1_000_000
            except OSError:
                continue
            found[kind].append(f"/static/features/{path.name}?v={stamp}")
    return found


SKINS = ("glass", "obsidian")  # the orb's elements in another material (app.js applyLook)
BODY = '<body data-state="idle" data-look="orb">'


def body_look(html: str, look: str, glass_tone: str = "dark") -> str:
    """The saved look on <body> from the first paint, so the window opens in the look the
    owner chose instead of flashing the default until the socket says otherwise. app.js
    reads it at once (the tone, which can follow the Mac's appearance) and keeps it after."""
    if look not in LOOKS:
        look = "orb"
    if glass_tone not in GLASS_TONES:
        glass_tone = "dark"
    attrs = f'data-look="orb" data-skin="{look}"' if look in SKINS else f'data-look="{look}"'
    return html.replace(BODY, f'<body data-state="idle" {attrs} data-glass-tone="{glass_tone}">', 1)


# The apps whose windows open on this server: J.A.R.V.I.S.'s own, and Eden Code's
# (app/main.js loads it as /?app=code and names it on the socket as ws?app=eden-code).
APPS = {"jarvis", "eden-code"}


# Feature modules (web/features/<stem>.js and .css) only Eden's own window uses: the voice
# assistant's settings and cards. Eden Code's window doesn't load them (/features.json?app=code).
EDEN_ONLY_FEATURES = frozenset(
    {
        "oura", "stocks", "whatsapp", "invoicing", "orders", "calls", "meeting_agent", "realtime",
        "voice_id", "voice_offline", "video_gen", "calendars", "conversation_heard", "scheduling",
        "widgets", "pictures", "study-mode", "wiki",
        # The assistant's own, never shown in Eden Code (CH2 page weight): its pop-up and hotkey rows,
        # texts to its number, mail accounts on a PC, personas and their voices, its conversation
        # (and managing past ones) and its chat projects. Eden Code's Settings hides their groups even
        # from search (settings-nav.js JARVIS_ONLY); its own panes, deck and sheet render the same.
        "eden-hotkey", "eden-pop", "sms_line", "mail-accounts", "personas", "personas-voices",
        "conversation", "convo-manage", "chat-projects",
    }
)  # fmt: skip
# Web fonts from Google (Eden's window): Eden Code's, in Ask Eden's look, uses the system's.
_WEB_FONTS = re.compile(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts\.googleapis\.com[^"]*">\n?')


def eden_code_page(html: str) -> str:
    """The page as Eden Code's window shows it: the same page and modules, marked so app.js
    and eden-code.css show Eden Code alone, in Ask Eden's look, from the first paint."""
    html = re.sub(r"<title>[^<]*</title>", "<title>Eden Code</title>", html, count=1)
    html = _WEB_FONTS.sub("", html)
    # The second brain's stars are never shown there: app.js stands in for galaxy.js (15 KB).
    html = re.sub(r'<script src="/static/galaxy\.js(?:\?v=\d+)?"></script>\n?', "", html, count=1)
    return re.sub(r"<body ", '<body data-app="eden-code" class="eden-code" ', html, count=1)


HIGH_CONTRAST = ("yellow", "white", "yellow-bg", "yellow-blue")


def edition_colors(hub: Any) -> str:
    """The colour pairing J.A.R.V.I.S. Daredevil's page opens in: the owner's choice, else yellow on black; none
    when screen-reader mode or the colours are switched off."""
    try:
        mode = hub.prefs.feature("a11y_mode")
        colors = hub.prefs.feature("a11y_colors")
    except Exception:
        return "yellow"
    if mode == "off" or colors == "off":
        return ""
    return colors if colors in HIGH_CONTRAST else "yellow"


def daredevil_page(html: str, colors: str = "yellow") -> str:
    """The page as J.A.R.V.I.S. Daredevil's window shows it: named for the edition, marked so accessibility.js
    turns screen-reader mode on, and in its colours from the first paint (not after the scripts have run)."""
    html = re.sub(r"<title>[^<]*</title>", "<title>J.A.R.V.I.S. Daredevil</title>", html, count=1)
    if colors in HIGH_CONTRAST:
        html = html.replace('<html lang="en">', f'<html lang="en" data-contrast="{colors}">', 1)
    return re.sub(r"<body ", '<body data-edition="daredevil" ', html, count=1)


def create_app(hub: Hub, token: str) -> Starlette:
    async def index(request):
        # Stamp script and stylesheet links with a version so an update is never hidden by
        # the window's cache.
        newest = max(f.stat().st_mtime_ns for f in WEB_DIR.iterdir() if f.is_file())
        version = str(newest // 1_000_000)
        html = (WEB_DIR / "index.html").read_text()
        html = re.sub(r'(/static/[\w-]+\.(?:js|css))"', rf'\1?v={version}"', html)
        if request.query_params.get("app") == "code":  # Eden Code wears Ask Eden's look only
            html = eden_code_page(body_look(html, "orb", "dark"))
        else:
            html = body_look(html, hub.prefs.look, hub.prefs.glass_tone)
            if request.query_params.get("edition") == "daredevil":  # J.A.R.V.I.S. Daredevil's window
                html = daredevil_page(html, edition_colors(hub))
        return await _page_reply(request, html, "text/html", {"Cache-Control": "no-store"})

    async def health(_request):
        # busy: whether a restart now would cut something off (the app updates quietly only
        # when it's false).
        try:
            busy = bool(hub.busy())
        except Exception:
            busy = True
        # apps: which apps have windows on it, so the app that started it can warn before a quit
        # takes the other one's sessions down with it (app/main.js).
        apps = sorted(a for a, n in getattr(hub, "app_windows", {}).items() if n)
        return JSONResponse({"ok": True, "busy": busy, "apps": apps})

    async def favicon(_request):
        # Nothing to show (the windows are the app's), but an answer, not a 404, each load.
        return Response(status_code=204, headers={"Cache-Control": "max-age=86400"})

    async def zh_json(_request):
        # Some 85 files read, merged and written out again (15 ms or so): in a thread, so
        # a window opening in Chinese never holds up the other windows' events.
        return await asyncio.to_thread(
            lambda: JSONResponse(zh_strings(), headers={"Cache-Control": "no-cache"})
        )

    async def features_json(request):
        from .features import _labs

        skip = set(_labs.web_skipped(getattr(hub, "prefs", None)) or ())
        if request.query_params.get("app") == "code":  # Eden Code's window: its modules only
            skip |= EDEN_ONLY_FEATURES
        return await asyncio.to_thread(
            lambda: JSONResponse(feature_assets(skip=skip), headers={"Cache-Control": "no-store"})
        )

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
        app = ws.query_params.get("app", "")
        app = app if app in APPS else ""
        if app and hasattr(hub, "window_joined"):
            hub.window_joined(app)
        queue = hub.subscribe()
        with contextlib.suppress(AttributeError):  # (a test's hub may hand out a plain queue)
            queue.app = app  # Eden Code's window isn't sent the HUD's events (hub.HUD_ONLY)
        CALLER.set(queue)  # what this window's commands answer goes to it alone (emit_to_caller)
        at = getattr(hub, "seq", 0)  # what this window's queue starts after
        sender: asyncio.Task | None = None
        # A window that reconnects says the last event it had (and from which backend):
        # after the snapshot it gets the session events it missed, when they're all kept.
        try:
            since = int(ws.query_params.get("since", "-1"))
        except ValueError:
            since = -1
        missed = None
        if since >= 0 and ws.query_params.get("hub") == getattr(hub, "instance_id", object()):
            missed = hub.events_since(since, at)

        async def pump() -> None:
            unsendable: set[str] = set()
            heard = at  # the newest number this window has: what it names on reconnecting
            try:
                while (event := await queue.get()) is not None:
                    try:
                        sent = numbered(event, heard)
                        text = await window_text(event, sent)
                    except Exception:  # no JSON can carry it (a tuple key, absurd nesting)
                        kind = str(event.get("type"))
                        if kind not in unsendable:  # said once per kind, not per event
                            unsendable.add(kind)
                            log.exception("window event %r can't be sent; skipped", kind)
                        continue
                    await ws.send_text(text)
                    if sent is not event:  # it went with its number
                        heard = max(heard, sent["seq"])
                code = 4408  # fell too far behind: it reconnects to a fresh snapshot
            except Exception:  # the socket failed under it: never a window left deaf
                code = 1011
            with contextlib.suppress(Exception):
                await ws.close(code=code)

        try:
            hello = hub.snapshot(app) if app == "eden-code" else hub.snapshot()
            await send_event(ws, {**hello, "seq": at, "replay": missed is not None})
            for n, event in missed or []:
                await send_event(ws, {**event, "seq": n})
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
            if app and hasattr(hub, "window_left"):
                hub.window_left(app)
            with contextlib.suppress(Exception):  # already closed by the other side, mostly
                await ws.close()

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        await hub.start()
        try:
            yield
        finally:
            await hub.close()

    app = Starlette(
        routes=[
            Route("/", index),
            Route("/health", health),
            Route("/favicon.ico", favicon),
            Route("/static/i18n-zh.json", zh_json),
            Route("/features.json", features_json),
            Route("/hooks/{name}", inbound_hook, methods=["POST"]),
            Route("/models/hand_landmarker.task", hand_model),
            *getattr(hub, "routes", ()),  # the feature modules' own (hub.register_route)
            WebSocketRoute("/ws", socket),
            Mount("/static", FreshStaticFiles(directory=WEB_DIR)),
            Mount("/vision", VendorFiles(VISION_DIR, "Hand tracking")),
            Mount("/xterm", VendorFiles(XTERM_DIR, "The terminal")),
        ],
        lifespan=lifespan,
    )
    # For a feature's route that only the app itself may call (features/eden_pop.py: the app's
    # main process sends this token in a header; a web page can't know it).
    app.state.launch_token = token
    return app


def _finite(value: Any) -> Any:
    """The same data with NaN and infinities as null: the browser's JSON can't read them."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def numbered(event: dict[str, Any], heard: int = 0) -> dict[str, Any]:
    """The event with its number (hub.Event.seq), as the window gets it; heard is the newest
    number the window has. One that carries a seq of its own keeps it when the window can't
    take it for a later number than heard: a search's answer (brain_results, wiki_results,
    action_log, conversation_list) names the window's request by it, and the window drops
    an answer whose seq isn't the one it asked with. (None of those is replayed on a
    reconnect.) Its own seq goes no further: the window keeps the highest seq it hears and
    names it reconnecting, and its own counter ("121") can be past this backend's numbers,
    for a window that outlived the last one. It would then be told of nothing after 121 and
    lose the transcript events it missed: that answer goes with its number instead."""
    seq = getattr(event, "seq", 0)
    if not seq or ("seq" in event and not _later_than(event["seq"], heard)):
        return event
    return {**event, "seq": seq}


# What JavaScript may read as a number (" 0x1F ", "1e3", "-Infinity"): letters, digits,
# signs, points and spaces. A seq with anything else in it (the brain's "w1:3") is none.
_NUMBERISH = frozenset(string.ascii_letters + string.digits + "+-.\ufeff")


def _later_than(value: Any, heard: int) -> bool:
    """Whether the window could take value, an event's own seq, for a number after heard. It
    compares each seq with the newest it had by JavaScript's > (app.js heard(),
    code-store.js take()), which reads the string "121" as 121. Anything this can't be sure
    of counts as later."""
    if isinstance(value, str):
        if not value or (value.isascii() and value.isdigit()):
            return int(value or 0) > heard
        return all(c in _NUMBERISH or c.isspace() for c in value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return not value <= heard  # (NaN too)
    return True


# An event this big (a long session's transcript: up to 400 entries of 100,000 characters)
# is made into JSON in a thread, not on the event loop, and once for every window (CA2-9).
BIG_EVENT = 200_000


async def window_text(event: dict[str, Any], sent: dict[str, Any]) -> str:
    """event_text(sent): a big one made off the event loop and kept on the event, so each
    window showing it doesn't make it again (sent is the event with its number, the same for
    every window, or the event itself)."""
    numbered_ = sent is not event
    kept = getattr(event, "text", None)
    if kept is not None and kept[0] == numbered_:
        return kept[1]
    if _text_size(event) < BIG_EVENT:
        return event_text(sent)
    text = await asyncio.to_thread(event_text, sent)
    with contextlib.suppress(AttributeError):  # (a plain dict: a test's)
        event.text = (numbered_, text)
    return text


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


def thread_lock_for_progress_bars() -> None:
    """tqdm (the progress bars of a voice model's download) makes a multiprocessing lock
    the first time it draws one: a named semaphore that nothing unlinks, so every quit
    after a download warned of "leaked semaphore objects". One process draws them here, so
    a thread lock does the same job."""
    try:
        from tqdm import tqdm
    except ImportError:  # no tqdm: nothing draws progress bars
        return
    tqdm.set_lock(threading.RLock())


def listening_line(port: int, token: str, *, by_app: bool) -> str:
    """What serve prints once it's up. Run by the app, the line lands in its backend.log and on
    its problem screen, and the app has the token already: it is never printed then (whoever
    has it can drive the sessions). From a terminal, the URL to open, token and all."""
    if by_app:
        return f"Eden listening on http://127.0.0.1:{port}/ (token kept by the app)"
    return f"Eden listening on http://127.0.0.1:{port}/?token={token}"


def serve(port: int, token: str) -> None:
    import logging
    import logging.handlers
    import os
    import sys

    from . import jsonstore
    from .launcher_watch import LAUNCHER_PID
    from .prefs import APP_SUPPORT

    # One backend per Mac: two on the same files would save over each other's changes,
    # hand out the same invoice numbers and answer the same conversations twice. The lock
    # is held while this process lives, and the system lets go of it however it ends.
    try:
        instance = jsonstore.claim_folder(APP_SUPPORT, wait=FOLDER_WAIT_S)
    except jsonstore.FolderTaken as exc:
        print(
            f"Eden can't start: {exc.strerror} ({APP_SUPPORT}). Quit that one first.",
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

    import uvicorn

    # Room for sockets and files: the window server, the phone companion, voice, the
    # file index and the Claude sessions share one process, and launchd's default soft
    # limit (256 open files) is easy to reach under load.
    if not osplat.IS_WIN:  # (Windows has no per-process file limit to raise)
        import resource

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
    to_stderr = list(logging.getLogger().handlers)
    # And a file of its own, so no line depends on where stderr happens to point.
    log_file = osplat.logs_dir() / "jarvis.log"
    with contextlib.suppress(OSError):
        log_file.parent.mkdir(parents=True, exist_ok=True)
        to_file = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=2_000_000, backupCount=2, encoding="utf-8"
        )
        to_file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger().addHandler(to_file)
        if os.environ.get(LAUNCHER_PID):
            # Run by the app, stderr is its backend.log, and jarvis.log has every line: only
            # warnings and worse go there too, so the day's routine lines never push out the
            # starts, crashes and tracebacks it's kept for (the app caps it at 5 MB).
            for handler in to_stderr:
                handler.setLevel(logging.WARNING)
    for noisy in ("pypdf", "fontTools", "httpx", "httpx2", "mcp"):
        logging.getLogger(noisy).setLevel(logging.ERROR)
    thread_lock_for_progress_bars()

    # Feature modules' work that must come before any store reads its file (a restored
    # backup put in place), while this process holds the folder.
    from . import features
    from .config import load_settings

    features.prepare_all(APP_SUPPORT)
    from . import launcher_watch

    launcher_watch.start()  # the app quits or crashes: this backend goes too, lock and all
    app = create_app(Hub(load_settings()), token)
    print(listening_line(port, token, by_app=bool(os.environ.get(LAUNCHER_PID))), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, **SERVE_OPTIONS)
    left = end_children()  # nothing it started outlives it (hub.close left it behind)
    if left:
        log.info("stopping: ended %d process%s still running", left, "" if left == 1 else "es")
    if instance is not None:  # held until the server has stopped
        instance.close()
