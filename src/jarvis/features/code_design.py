"""Jarvis Code builds from a design: the owner drops a screenshot of a design into a session
with "build this" (or uses "Match a design…" in the More menu), the session builds it, and
then the page is compared with the design.

- The comparison: the app renders the dev server's page at the design's size (a hidden
  preview of its own, app/features/design-match.js), pictures it, and shrinks both pictures
  to one small size; design_diff scores them (a perceptual, SSIM-like comparison in numpy)
  and lays a heat-map over the page.
- The transcript entry (role "design"): the design and the page side by side, an overlay
  with a slider, the heat-map, the score and how it has moved since the first round.
- Refinement: the owner's "Refine" sends the session the comparison (the score, where it
  differs most, the page's picture), one round per press, up to the match's rounds.

Where the design is fetched from: GET /f/code-design/<token>, a random token per match, only
while the match lasts (the window hands it to the app). The pictures each round makes are kept
on disk, the newest previewcheck.PROOFS_KEPT, like the Preview check's.

Cost policy (Claude): this feature never calls a model itself. Each refinement round is one
more turn of the session (its own model, its own spending caps), sent only when the owner
presses Refine on that round's card: at most MAX_ROUNDS (the owner picks 1-5, default
DEFAULT_ROUNDS) per design. The comparisons cost nothing.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .. import design_diff, lang, previewcheck
from ..previewcheck import ProofStore

log = logging.getLogger("jarvis")

ROUTE = "/f/code-design"
DEFAULT_ROUNDS = 3
MAX_ROUNDS = 5
DESIGN_BYTES = 8_000_000  # the most a design picture may be
RENDER_WAIT = 60.0  # seconds for the app to render and picture the page
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
# The owner's words that hand a session a design to build ("build this", "做这个").
BUILD_THIS = re.compile(
    r"(?ix)^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?"
    r"(?:build|make|code|implement|recreate|create|replicate)\s+(?:me\s+)?(?:this|that|it)\b"
    r"|\bmatch\s+(?:this|the)\s+design\b"
    r"|^\s*(?:请)?(?:帮我)?(?:做|实现|还原|照着做|按这个做)(?:出)?(?:这个|这张图|这个设计)"
)
BUILD_PROMPT = (
    "Build this design as a page in this project, matching it as closely as you can: layout, "
    "spacing, sizes, colours and type. When it's built, make sure the project's dev server "
    "shows it, and say at which address."
)

lang.add_texts(
    {
        "Match a design": "匹配设计",
        "Design match": "设计匹配",
        "Open a session to match a design.": "请先打开一个会话，再匹配设计。",
        "That picture can't be used: PNG, JPEG, WebP or GIF, up to 8 MB.": "这张图片无法使用：须为 PNG、JPEG、WebP 或 GIF，最大 8 MB。",
        "This session has no design to match.": "这个会话没有要匹配的设计。",
        "That round is over: refine from the newest comparison.": "这一轮已结束：请从最新的对比继续优化。",
        "All the refinement rounds are used.": "优化轮次已经用完。",
        "The session couldn't take another message just now.": "会话现在无法接收新消息。",
        "No dev server is running: start one in the Preview pane, then compare.": "没有正在运行的开发服务器：请在预览面板中启动一个，然后再对比。",
        "The page is rendered in the J.A.R.V.I.S. app window, and it isn't open.": "页面在 J.A.R.V.I.S. 应用窗口中渲染，但它没有打开。",
        "The app window didn't answer in time.": "应用窗口没有及时响应。",
        "The comparison didn't work.": "对比没有成功。",
        "Comparing…": "正在对比…",
        "Wait for the session to finish its turn, then refine.": "请等会话完成这一轮，再继续优化。",
    }
)


@dataclass
class Match:
    """One design a session is building, and its comparisons so far."""

    task_id: int
    media_type: str
    data: str  # the design, base64
    name: str = ""
    rounds: int = DEFAULT_ROUNDS  # refinement rounds the owner allows
    token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    refined: int = 0  # refinement rounds sent
    compared: int = 0  # comparisons made
    scores: list[float] = field(default_factory=list)
    # The owner's message with the design hasn't begun its turn yet: the turn it begins is
    # the one that builds it (not one already running when it was sent).
    armed: bool = True
    waiting: bool = False  # a turn is building (or refining) it: compare when it ends
    comparing: bool = False
    design_proof: str = ""  # the design as the app pictured it, kept on disk
    design_thumb: str = ""
    size: tuple[int, int] = (0, 0)
    started: float = field(default_factory=time.time)

    def bytes(self) -> bytes:
        return base64.b64decode(self.data)


def clean_design(item: Any) -> tuple[str, str, str] | None:
    """(media type, base64, name) of a picture the window sent, or None."""
    if not isinstance(item, dict):
        return None
    media = str(item.get("media_type") or "").lower()
    data = item.get("data")
    if media not in IMAGE_TYPES or not isinstance(data, str) or not data:
        return None
    if len(data) > DESIGN_BYTES * 4 // 3 + 8:
        return None
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None
    magic = {
        "image/png": raw.startswith(b"\x89PNG"),
        "image/jpeg": raw.startswith(b"\xff\xd8"),
        "image/gif": raw.startswith(b"GIF8"),
        "image/webp": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }
    if not magic.get(media):
        return None
    return media, data, str(item.get("name") or "")[:200]


def wants_build(text: Any) -> bool:
    """The owner's message hands the session a design to build ("build this")."""
    return isinstance(text, str) and bool(BUILD_THIS.search(text.strip()[:400]))


def _rounds(value: Any) -> int:
    try:
        return max(1, min(MAX_ROUNDS, int(value)))
    except (TypeError, ValueError):
        return DEFAULT_ROUNDS


class DesignMatch:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.matches: dict[int, Match] = {}
        self.proofs = ProofStore(hub.feature_path("code-design-pictures"))
        self._calls: dict[str, asyncio.Future] = {}
        self._tasks: set[asyncio.Task] = set()

    # ── helpers ──

    def spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return task

    def error(self, text: str) -> None:
        self.hub.emit("dm_error", text=text)

    def code_task(self, task_id: Any) -> Any:
        with contextlib.suppress(TypeError, ValueError):
            task = self.hub.tasks.tasks.get(int(task_id or 0))
            if task is not None and task.kind == "code":
                return task
        return None

    def by_token(self, token: str) -> Match | None:
        for match in self.matches.values():
            if secrets.compare_digest(match.token, token):
                return match
        return None

    def begin(self, task_id: int, design: tuple[str, str, str], rounds: Any = None) -> Match:
        media, data, name = design
        match = Match(task_id, media, data, name, rounds=_rounds(rounds))
        self.matches[task_id] = match  # a new design replaces the session's last one
        self.hub.emit("dm_state", **self.state(match))
        return match

    def state(self, match: Match) -> dict[str, Any]:
        return {
            "id": match.task_id,
            "rounds": match.rounds,
            "refined": match.refined,
            "compared": match.compared,
            "scores": [round(s, 4) for s in match.scores],
            "waiting": match.waiting,
            "comparing": match.comparing,
        }

    # ── the window's commands ──

    def on_task_send(self, msg: dict[str, Any]) -> bool:
        """The owner's message to a session: with a picture and "build this", the picture is
        the design to match. The message itself goes on as it is (returns False)."""
        task = self.code_task(msg.get("id"))
        if task is None or not wants_build(msg.get("text")):
            return False
        for item in (msg.get("images") or [])[:6]:
            design = clean_design(item)
            if design is not None:
                self.begin(task.id, design, msg.get("design_rounds"))
                break
        return False

    def cmd_start(self, msg: dict[str, Any]) -> None:
        """ "Match a design…": the picture, sent to the session with the build request."""
        task = self.code_task(msg.get("id"))
        if task is None:
            self.error("Open a session to match a design.")
            return
        design = clean_design(msg.get("image"))
        if design is None:
            self.error("That picture can't be used: PNG, JPEG, WebP or GIF, up to 8 MB.")
            return
        words = str(msg.get("text") or "").strip()[:4000]
        text = f"{BUILD_PROMPT}\n\n{words}" if words else BUILD_PROMPT
        media, data, name = design
        if not self.hub.tasks.send(
            task.id, text, [{"media_type": media, "data": data, "name": name or "design"}]
        ):
            self.error("The session couldn't take another message just now.")
            return
        self.begin(task.id, design, msg.get("rounds"))

    def cmd_compare(self, msg: dict[str, Any]) -> None:
        """Compare now (the card's button): the same comparison, nothing sent."""
        task = self.code_task(msg.get("id"))
        match = self.matches.get(task.id) if task is not None else None
        if match is None:
            self.error("This session has no design to match.")
            return
        self.spawn(self.compare(task, match))

    def cmd_refine(self, msg: dict[str, Any]) -> None:
        """The owner's go-ahead for one more round: the comparison goes to the session."""
        task = self.code_task(msg.get("id"))
        match = self.matches.get(task.id) if task is not None else None
        if match is None or not match.scores:
            self.error("This session has no design to match.")
            return
        if msg.get("compared") != match.compared:
            self.error("That round is over: refine from the newest comparison.")
            return
        if match.refined >= match.rounds:
            self.error("All the refinement rounds are used.")
            return
        if task.busy or match.waiting or match.comparing:
            self.error("Wait for the session to finish its turn, then refine.")
            return
        entry = next(
            (
                e
                for e in reversed(task.transcript)
                if e.get("role") == "design" and e.get("compared") == match.compared
            ),
            None,
        )
        render = self.proofs.read(entry.get("render_proof", "")) if entry else None
        if entry is None or render is None:
            self.error("The comparison didn't work.")
            return
        result = design_diff.Comparison(
            score=float(entry["score"]),
            structure=float(entry["structure"]),
            colour=float(entry["colour"]),
            rows=0,
            cols=0,
            regions=[(str(n), float(v)) for n, v in entry.get("regions") or []],
        )
        note = design_diff.feedback(
            result, match.refined + 1, match.rounds, tuple(entry.get("size") or (0, 0))
        )
        images = [{"media_type": "image/jpeg", "data": render, "name": "page"}]
        if not self.hub.tasks.send(task.id, note, images, note=True):
            self.error("The session couldn't take another message just now.")
            return
        match.refined += 1
        match.armed, match.waiting = False, True
        self.hub.tasks.add_entry(
            task.id,
            "design",
            f"Design match: refinement round {match.refined} of {match.rounds} sent.",
            status="sent",
            refined=match.refined,
            rounds=match.rounds,
        )
        self.hub.emit("dm_state", **self.state(match))

    def cmd_stop(self, msg: dict[str, Any]) -> None:
        task = self.code_task(msg.get("id"))
        if task is not None and self.matches.pop(task.id, None) is not None:
            self.hub.emit("dm_state", id=task.id, stopped=True)

    def cmd_state(self, msg: dict[str, Any]) -> None:
        task = self.code_task(msg.get("id"))
        match = self.matches.get(task.id) if task is not None else None
        if match is not None:
            self.hub.emit("dm_state", **self.state(match))
        elif task is not None:
            self.hub.emit("dm_state", id=task.id, stopped=True)

    def cmd_image(self, msg: dict[str, Any]) -> None:
        proof = str(msg.get("proof") or "")
        jpeg = self.proofs.read(proof)
        self.hub.emit("dm_image", proof=proof, jpeg=jpeg or "", missing=jpeg is None)

    def cmd_render_result(self, msg: dict[str, Any]) -> None:
        future = self._calls.get(str(msg.get("call") or ""))
        if future is not None and not future.done():
            result = msg.get("result")
            future.set_result(result if isinstance(result, dict) else {"error": "nothing"})

    # ── the comparison ──

    async def render(self, match: Match, url: str) -> dict[str, Any]:
        """The app's picture of the page at the design's size, with both pictures shrunk to
        one size for the comparison (asked through the window, like the Preview check)."""
        if not self.hub.browser_available:
            return {
                "error": "The page is rendered in the J.A.R.V.I.S. app window, and it isn't open."
            }
        call = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self._calls[call] = future
        self.hub.emit(
            "dm_render", call=call, id=match.task_id, url=url, design=f"{ROUTE}/{match.token}"
        )
        try:
            return await asyncio.wait_for(future, RENDER_WAIT)
        except TimeoutError:
            return {"error": "The app window didn't answer in time."}
        finally:
            self._calls.pop(call, None)

    async def compare(self, task: Any, match: Match) -> None:
        if match.comparing:
            return
        match.comparing = True
        match.waiting = False
        self.hub.emit("dm_state", **self.state(match))
        try:
            await self._compare(task, match)
        finally:
            match.comparing = False
            self.hub.emit("dm_state", **self.state(match))

    async def _compare(self, task: Any, match: Match) -> None:
        cv = getattr(self.hub, "code_verify", None)
        server = cv.preview_server(task) if cv is not None else None
        if server is None or not server.address():
            self._problem(
                task,
                match,
                "No dev server is running: start one in the Preview pane, then compare.",
            )
            return
        url = server.address()
        result = await self.render(match, url)
        if result.get("error"):
            self._problem(task, match, str(result["error"])[:300], url)
            return
        try:
            design = design_diff.decode_rgb(result.get("a"), result.get("cw"), result.get("ch"))
            built = design_diff.decode_rgb(result.get("b"), result.get("cw"), result.get("ch"))
            comparison = await asyncio.to_thread(design_diff.compare, design, built)
        except ValueError:
            self._problem(task, match, "The comparison didn't work.", url)
            return
        if self.matches.get(task.id) is not match:
            return  # a new design (or Stop) since it began
        render_proof = self.proofs.save(result.get("shot"))
        if not match.design_proof or self.proofs.read(match.design_proof) is None:
            match.design_proof = self.proofs.save(result.get("design_shot"))
            match.design_thumb = previewcheck.thumb(result.get("design_thumb"))
        size = _size(result.get("size"))
        match.size = size
        match.compared += 1
        match.scores.append(comparison.score)
        detail = comparison.public()
        good = comparison.score >= design_diff.GOOD_ENOUGH
        text = (
            f"Design match: {design_diff.percent(comparison.score)} "
            f"(comparison {match.compared}, {match.refined} of {match.rounds} refinement rounds used)."
        )
        self.hub.tasks.add_entry(
            task.id,
            "design",
            text,
            status="compared",
            compared=match.compared,
            refined=match.refined,
            rounds=match.rounds,
            scores=[round(s, 4) for s in match.scores],
            url=url,
            size=list(size),
            design_proof=match.design_proof,
            design_thumb=match.design_thumb,
            render_proof=render_proof,
            render_thumb=previewcheck.thumb(result.get("thumb")),
            good=good,
            **detail,
        )

    def _problem(self, task: Any, match: Match, why: str, url: str = "") -> None:
        match.waiting = False
        self.hub.tasks.add_entry(
            task.id,
            "design",
            f"Design match: {why}",
            status="problem",
            why=why,
            url=url,
            compared=match.compared,
            refined=match.refined,
            rounds=match.rounds,
        )

    # ── what the sessions do ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "task_log" and (data.get("entry") or {}).get("role") == "user":
            match = self.matches.get(data.get("id"))
            if match is not None and match.armed:
                match.armed, match.waiting = False, True
                self.hub.emit("dm_state", **self.state(match))
        elif kind == "task_finished" and data.get("task_kind") == "code":
            match = self.matches.get(data.get("id"))
            task = self.code_task(data.get("id"))
            if match is None or task is None or not match.waiting:
                return
            if data.get("status") != "done":
                match.waiting = False  # stopped or failed: Compare now is the owner's
                self.hub.emit("dm_state", **self.state(match))
                return
            self.spawn(self.compare(task, match))
        elif kind == "tasks":
            live = {i.get("id") for i in data.get("items") or []}
            for task_id in list(self.matches):
                if task_id not in live:
                    del self.matches[task_id]

    # ── the design, for the app ──

    async def serve(self, request: Any) -> Any:
        from starlette.responses import PlainTextResponse, Response

        port = (request.scope.get("server") or ("", 0))[1]
        if request.headers.get("host", "") not in {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }:
            return PlainTextResponse("Not here.", status_code=403)
        match = self.by_token(str(request.path_params.get("token", "")))
        if match is None:
            return PlainTextResponse("Not here.", status_code=404)
        return Response(
            match.bytes(),
            media_type=match.media_type,
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


def _size(value: Any) -> tuple[int, int]:
    try:
        w, h = int(value[0]), int(value[1])
        return (w, h) if w > 0 and h > 0 else (0, 0)
    except (TypeError, ValueError, IndexError):
        return (0, 0)


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("Design match: background work failed", exc_info=task.exception())


def install(hub: Any) -> None:
    dm = DesignMatch(hub)
    hub.code_design = dm
    hub.add_task_sink(dm.on_task_event)  # (a failing sink is logged; the others still hear)
    hub.register_command("task_send", dm.on_task_send)
    hub.register_command("dm_start", dm.cmd_start)
    hub.register_command("dm_compare", dm.cmd_compare)
    hub.register_command("dm_refine", dm.cmd_refine)
    hub.register_command("dm_stop", dm.cmd_stop)
    hub.register_command("dm_state", dm.cmd_state)
    hub.register_command("dm_image", dm.cmd_image)
    hub.register_command("dm_render_result", dm.cmd_render_result)
    hub.register_route(f"{ROUTE}/{{token}}", dm.serve)
