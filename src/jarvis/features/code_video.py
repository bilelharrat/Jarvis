"""Video proof for Jarvis Code: after a turn that changed the page's files, a short recording
(up to MAX_SECONDS) of the dev server's page loading and being scrolled through, kept with the
turn like the Preview check's picture.

- Off by default, per project: Settings › Jarvis Code › Projects › "Video proof after UI
  changes" (code_project_defaults' "video_proof"). "Record a video proof" in the More menu
  records one now, for any session with a dev server running.
- The recording is the app's (app/features/video-proof.js, asked through the window like the
  Preview check): a hidden page of its own, its frames from the DevTools screencast, made into
  a WebM video by the browser's own recorder. Never the owner's screen.
- Kept on disk beside the app's other files, the newest VIDEOS_KEPT, each by a random id, and
  played from GET /f/code-video/<id> (the window's own server; an id nobody could guess).
- Its transcript entry (role "video"): a poster frame that plays the video when clicked.

Cost policy: no model is called, ever; a recording costs only the Mac's time (about twice
its length, while the video is made).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import re
import secrets
import uuid
from pathlib import Path
from typing import Any

from .. import code_projects, lang, previewcheck

log = logging.getLogger("jarvis")

ROUTE = "/f/code-video"
PROJECT_VIDEO = "video_proof"  # in code_project_defaults: a project's own switch
code_projects.EXTRA_DEFAULTS[PROJECT_VIDEO] = lambda v: v if isinstance(v, bool) else None
SECONDS = 8  # how long a recording is
MAX_SECONDS = 10
VIDEO_BYTES = 15_000_000  # the most one video may be
VIDEOS_KEPT = 30
RECORD_WAIT = 90.0  # seconds for the app to record and make the video
VIDEO_ID = re.compile(r"^[0-9a-f]{24}$")
WEBM_MAGIC = b"\x1a\x45\xdf\xa3"  # EBML: a WebM file
# What a page is made of: a turn that changed one of these changed the UI.
UI_FILES = re.compile(
    r"\.(?:html?|css|scss|sass|less|styl|jsx|tsx|vue|svelte|astro|mdx|js|mjs|ts|svg|erb|hbs"
    r"|ejs|njk|liquid|jinja2?|twig|php)$",
    re.IGNORECASE,
)

lang.add_texts(
    {
        "Video proof": "视频证明",
        "Video proof after UI changes": "界面改动后录制视频证明",
        "Record a video proof": "录制视频证明",
        "Open a session to record its page.": "请先打开一个会话，再录制它的页面。",
        "No dev server is running: start one in the Preview pane.": "没有正在运行的开发服务器：请在预览面板中启动一个。",
        "The video is recorded in the J.A.R.V.I.S. app window, and it isn't open.": "视频在 J.A.R.V.I.S. 应用窗口中录制，但它没有打开。",
        "The app window didn't answer in time.": "应用窗口没有及时响应。",
        "The video couldn't be kept.": "无法保存这段视频。",
        "Recording a video proof…": "正在录制视频证明…",
    }
)


class VideoStore:
    """The videos, on disk: the newest VIDEOS_KEPT, each by a random id."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def save(self, webm_b64: Any) -> str:
        if (
            not isinstance(webm_b64, str)
            or not webm_b64
            or len(webm_b64) > VIDEO_BYTES * 4 // 3 + 8
        ):
            return ""
        try:
            data = base64.b64decode(webm_b64, validate=True)
        except (binascii.Error, ValueError):
            return ""
        if not data.startswith(WEBM_MAGIC):
            return ""
        video = secrets.token_hex(12)
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder / f"{video}.webm").write_bytes(data)
            self._prune()
        except OSError:
            log.warning("couldn't keep a video proof", exc_info=True)
            return ""
        return video

    def path(self, video: Any) -> Path | None:
        if not isinstance(video, str) or not VIDEO_ID.match(video):
            return None
        path = self.folder / f"{video}.webm"
        return path if path.is_file() else None

    def _prune(self) -> None:
        files = sorted(self.folder.glob("*.webm"), key=lambda p: p.stat().st_mtime)
        for old in files[:-VIDEOS_KEPT]:
            with contextlib.suppress(OSError):
                old.unlink()


def changed_ui(files: Any) -> bool:
    """A turn's changed files include the page's own (markup, styles, scripts)."""
    return any(isinstance(f, str) and UI_FILES.search(f) for f in (files or []))


def project_default(hub: Any, task: Any, key: str) -> Any:
    """A session's project's own setting (code_project_defaults), None when it has none: by
    the project's folder, or for an isolated copy the folder it was copied from."""
    value = hub.prefs.feature("code_project_defaults")
    if not isinstance(value, dict) or not value or task is None:
        return None
    folders = [Path(task.cwd)]
    desk = getattr(hub, "code_desk", None)
    if desk is not None:
        with contextlib.suppress(Exception):
            copy = desk.store().by_path(task.cwd)
            if copy is not None:
                folders.append(Path(copy.repo) / copy.prefix)
    for folder in folders:
        with contextlib.suppress(OSError, RuntimeError):
            own = value.get(str(folder.resolve()))
            if isinstance(own, dict) and key in own:
                return own[key]
    return None


class VideoProof:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.videos = VideoStore(hub.feature_path("code-video-proofs"))
        self._calls: dict[str, asyncio.Future] = {}
        self._tasks: set[asyncio.Task] = set()
        self.recording: set[int] = set()

    def spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return task

    def enabled(self, task: Any) -> bool:
        return project_default(self.hub, task, PROJECT_VIDEO) is True

    def server_url(self, task: Any) -> str:
        cv = getattr(self.hub, "code_verify", None)
        server = cv.preview_server(task) if cv is not None else None
        return server.address() if server is not None else ""

    # ── what the sessions do ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind != "task_finished" or data.get("task_kind") != "code":
            return
        if data.get("status") != "done" or not changed_ui(data.get("files")):
            return
        task = self.hub.tasks.tasks.get(data.get("id"))
        if task is None or task.kind != "code" or not self.enabled(task):
            return
        if not self.server_url(task):
            return  # nothing to record (the Preview check says so, when it's on)
        self.spawn(self.record(task))

    # ── the recording ──

    async def ask_app(self, task: Any, url: str) -> dict[str, Any]:
        if not self.hub.browser_available:
            return {
                "error": "The video is recorded in the J.A.R.V.I.S. app window, and it isn't open."
            }
        call = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self._calls[call] = future
        self.hub.emit(
            "vp_capture", call=call, id=task.id, url=url, seconds=SECONDS, width=1280, height=800
        )
        try:
            return await asyncio.wait_for(future, RECORD_WAIT)
        except TimeoutError:
            return {"error": "The app window didn't answer in time."}
        finally:
            self._calls.pop(call, None)

    async def record(self, task: Any, by_owner: bool = False) -> None:
        if task.id in self.recording:
            return
        url = self.server_url(task)
        if not url:
            self.hub.emit(
                "vp_error", text="No dev server is running: start one in the Preview pane."
            )
            return
        self.recording.add(task.id)
        self.hub.emit("vp_state", id=task.id, recording=True)
        try:
            result = await self.ask_app(task, url)
            video = self.videos.save(result.get("webm")) if not result.get("error") else ""
            if not video:
                why = str(result.get("error") or "The video couldn't be kept.")[:300]
                self.hub.tasks.add_entry(
                    task.id,
                    "video",
                    f"Video proof: {why}",
                    status="problem",
                    why=why,
                    url=url,
                    by_owner=by_owner,
                )
                return
            try:
                seconds = max(0.0, min(float(MAX_SECONDS), float(result.get("seconds") or 0)))
            except (TypeError, ValueError):
                seconds = 0.0
            self.hub.tasks.add_entry(
                task.id,
                "video",
                f"Video proof: {seconds:g} s of {url}",
                status="ok",
                video=video,
                poster=previewcheck.thumb(result.get("poster")),
                seconds=seconds,
                url=url,
                by_owner=by_owner,
            )
        finally:
            self.recording.discard(task.id)
            self.hub.emit("vp_state", id=task.id, recording=False)

    # ── the window's commands ──

    def cmd_result(self, msg: dict[str, Any]) -> None:
        future = self._calls.get(str(msg.get("call") or ""))
        if future is not None and not future.done():
            result = msg.get("result")
            future.set_result(result if isinstance(result, dict) else {"error": "nothing"})

    def cmd_record(self, msg: dict[str, Any]) -> None:
        """ "Record a video proof" (the More menu): one now, whatever the project's switch."""
        task = None
        with contextlib.suppress(TypeError, ValueError):
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        if task is None or task.kind != "code":
            self.hub.emit("vp_error", text="Open a session to record its page.")
            return
        self.spawn(self.record(task, by_owner=True))

    def cmd_state(self, msg: dict[str, Any]) -> None:
        task = None
        with contextlib.suppress(TypeError, ValueError):
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        if task is not None and task.kind == "code":
            self.hub.emit(
                "vp_state",
                id=task.id,
                recording=task.id in self.recording,
                enabled=self.enabled(task),
            )

    async def serve(self, request: Any) -> Any:
        from starlette.responses import FileResponse, PlainTextResponse

        port = (request.scope.get("server") or ("", 0))[1]
        if request.headers.get("host", "") not in {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }:
            return PlainTextResponse("Not here.", status_code=403)
        path = self.videos.path(str(request.path_params.get("video", "")))
        if path is None:
            return PlainTextResponse("That video isn't kept anymore.", status_code=404)
        return FileResponse(
            path,
            media_type="video/webm",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Cross-Origin-Resource-Policy": "same-origin",
            },
        )

    async def close(self) -> None:
        for future in self._calls.values():
            if not future.done():
                future.set_result({"error": "The app window closed."})
        for task in list(self._tasks):
            task.cancel()


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("Video proof: background work failed", exc_info=task.exception())


def install(hub: Any) -> None:
    vp = VideoProof(hub)
    hub.code_video = vp
    hub.add_task_sink(vp.on_task_event)  # (a failing sink is logged; the others still hear)
    hub.register_command("vp_result", vp.cmd_result)
    hub.register_command("vp_record", vp.cmd_record)
    hub.register_command("vp_state", vp.cmd_state)
    hub.register_route(f"{ROUTE}/{{video}}", vp.serve)
