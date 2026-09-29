"""The app's core: one Claude session, the voice loop, approvals and live status.

Windows talk to the hub over a WebSocket (server.py). The hub broadcasts events to
every connected window and takes commands back through `handle()`.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid
from collections import deque
from collections.abc import Callable
from datetime import datetime
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from . import mac_tools
from .brain import build_options
from .config import Settings
from .speech import Speaker
from .tasks import TaskManager

TOOL_LABELS = {
    "open_app": "Opened an app",
    "open_url": "Opened a web page",
    "snap_window": "Arranged a window",
    "quit_app": "Quit an app",
    "system_status": "Checked the time and battery",
    "media_control": "Controlled music",
    "now_playing": "Checked what's playing",
    "set_volume": "Changed the volume",
    "create_note": "Saved a note",
    "list_shortcuts": "Listed Shortcuts",
    "run_shortcut": "Ran a Shortcut",
    "list_emails": "Read your inbox",
    "draft_email": "Drafted an email",
    "list_events": "Checked your calendar",
    "create_event": "Added a calendar event",
    "run_claude_code": "Started Claude Code",
    "claude_task_status": "Checked Claude Code tasks",
    "WebSearch": "Searched the web",
    "WebFetch": "Read a web page",
    "firm_search": "Searched the research desk",
    "list_companies": "Listed BSH companies",
    "company_profile": "Opened a company profile",
    "decisions": "Checked the decision ledger",
    "portfolio_dashboard": "Checked the portfolio",
    "signal_score": "Checked a signal score",
    "transcript": "Read a transcript",
    "reference_calls": "Read reference calls",
}

APPROVAL_TIMEOUT = 300


def tool_label(name: str) -> str:
    short = name.split("__")[-1]
    return TOOL_LABELS.get(short, short.replace("_", " ").capitalize())


class Hub:
    def __init__(
        self,
        settings: Settings,
        *,
        client_factory: Callable[..., Any] = ClaudeSDKClient,
        speaker: Speaker | None = None,
        transcriber: Any = None,
        recorder: Callable[..., Any] | None = None,
        poll: bool = True,
    ) -> None:
        self.settings = settings
        self.client_factory = client_factory
        self.speaker = speaker or Speaker(settings.voice, settings.speech_rate)
        self.transcriber = transcriber
        self.recorder = recorder
        self.poll = poll
        self.state = "idle"
        self.status: dict[str, Any] = {}
        self.turn: dict[str, Any] = {}
        self.activity: deque[dict[str, Any]] = deque(maxlen=60)
        self.approvals: dict[str, dict[str, Any]] = {}
        self._futures: dict[str, asyncio.Future] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()
        self._tools: dict[str, dict[str, Any]] = {}
        self._background: set[asyncio.Task] = set()
        self._stopping = False
        self.tasks = TaskManager(settings, self.request_approval, self.emit)
        self.client: Any = None

    # ── lifecycle ──

    async def start(self) -> None:
        if self.transcriber is None:
            from .listen import Transcriber

            self.transcriber = Transcriber(self.settings.whisper_model)
            self.transcriber.warm_up()
        await self._connect()
        if self.poll:
            self._spawn(self._poll_status())

    async def _connect(self) -> None:
        options = build_options(self.settings, self.confirm, self.tasks.build_server())
        self.client = self.client_factory(options=options)
        await self.client.connect()

    async def close(self) -> None:
        for task in list(self._background):
            task.cancel()
        await self.tasks.close()
        self.speaker.stop()
        if self.client is not None:
            with contextlib.suppress(Exception):
                await self.client.disconnect()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    # ── events ──

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def emit(self, kind: str, **data: Any) -> None:
        event = {"type": kind, **data}
        for queue in self._subscribers:
            queue.put_nowait(event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "model": self.settings.model,
            "state": self.state,
            "muted": self.speaker.muted,
            "status": self.status,
            "turn": self.turn,
            "activity": list(self.activity),
            "approvals": list(self.approvals.values()),
            "tasks": self.tasks.public(),
        }

    def set_state(self, state: str) -> None:
        if state != self.state:
            self.state = state
            self.emit("state", value=state)

    # ── approvals ──

    async def request_approval(
        self, question: str, detail: str = "", choices: list[tuple[str, str]] | None = None
    ) -> str:
        choices = choices or [("allow", "Allow"), ("deny", "Not now")]
        approval_id = uuid.uuid4().hex[:12]
        approval = {
            "id": approval_id,
            "question": question,
            "detail": detail,
            "choices": [{"id": c, "label": label} for c, label in choices],
        }
        future = asyncio.get_running_loop().create_future()
        self.approvals[approval_id] = approval
        self._futures[approval_id] = future
        self.emit("approval", **approval)
        try:
            return await asyncio.wait_for(future, APPROVAL_TIMEOUT)
        except TimeoutError:
            return choices[-1][0]
        finally:
            self.approvals.pop(approval_id, None)
            self._futures.pop(approval_id, None)
            self.emit("approval_resolved", id=approval_id)

    def resolve(self, approval_id: str, choice: str) -> bool:
        future = self._futures.get(approval_id)
        valid = {c["id"] for c in self.approvals.get(approval_id, {}).get("choices", [])}
        if future is None or future.done() or choice not in valid:
            return False
        future.set_result(choice)
        return True

    async def confirm(self, question: str) -> bool:
        """The chat's permission gate: speak the question, wait for a tap."""
        self._spawn(self.speaker.say(question))
        return await self.request_approval(question) == "allow"

    # ── conversation ──

    async def ask(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        async with self._lock:
            self._stopping = False
            rid = uuid.uuid4().hex[:8]
            self.turn = {"rid": rid, "user": text, "reply": ""}
            self.emit("turn", rid=rid, user=text)
            self.set_state("thinking")
            try:
                await self.client.query(text)
                async for message in self.client.receive_response():
                    await self._on_message(rid, message)
            except Exception as exc:  # CLI died, network, auth
                self.emit("error", text=f"Something went wrong: {exc}")
            finally:
                self.set_state("idle")
                self.emit("turn_done", rid=rid)

    async def _on_message(self, rid: str, message: Any) -> None:
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock) and block.text.strip():
                    reply = f"{self.turn['reply']} {block.text.strip()}".strip()
                    self.turn["reply"] = reply
                    self.emit("reply", rid=rid, text=reply)
                    if not self._stopping:
                        self.set_state("speaking")
                        await self.speaker.say(block.text)
                        self.set_state("thinking")
                elif isinstance(block, ToolUseBlock):
                    self._tool_started(block)
        elif isinstance(message, UserMessage) and isinstance(message.content, list):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    self._tool_finished(block.tool_use_id, ok=not block.is_error)
        elif isinstance(message, ResultMessage) and message.is_error and not self._stopping:
            detail = "; ".join(message.errors or []) or message.subtype
            self.emit("error", text=f"Claude stopped: {detail}")

    def _tool_started(self, block: ToolUseBlock) -> None:
        item = {
            "id": block.id,
            "label": tool_label(block.name),
            "status": "running",
            "at": datetime.now().isoformat(timespec="seconds"),
            "_t": time.monotonic(),
        }
        self._tools[block.id] = item
        self._publish_tool(item)

    def _tool_finished(self, tool_id: str, ok: bool) -> None:
        item = self._tools.pop(tool_id, None)
        if item is None:
            return
        item["status"] = "done" if ok else "failed"
        item["ms"] = int((time.monotonic() - item["_t"]) * 1000)
        self._publish_tool(item)
        self.activity.appendleft({k: v for k, v in item.items() if not k.startswith("_")})

    def _publish_tool(self, item: dict[str, Any]) -> None:
        self.emit("tool", **{k: v for k, v in item.items() if not k.startswith("_")})

    async def listen(self) -> None:
        if self._lock.locked() or self.state == "listening":
            return
        self.set_state("listening")
        loop = asyncio.get_running_loop()
        last = 0.0

        def on_level(rms: float) -> None:
            nonlocal last
            now = time.monotonic()
            if now - last >= 0.08:
                last = now
                level = round(min(rms * 12, 1.0), 3)
                loop.call_soon_threadsafe(lambda: self.emit("level", value=level))

        try:
            recorder = self.recorder
            if recorder is None:
                from .listen import record_utterance as recorder
            audio = await asyncio.to_thread(recorder, self.settings.silence_seconds, on_level)
            if audio is None:
                self.emit("heard", text="")
                return
            self.set_state("transcribing")
            text = await asyncio.to_thread(self.transcriber.transcribe, audio)
        except Exception as exc:  # no microphone, permission denied
            self.emit("error", text=f"I couldn't use the microphone: {exc}")
            return
        finally:
            if self.state in ("listening", "transcribing"):
                self.set_state("idle")
        self.emit("heard", text=text)
        if text:
            await self.ask(text)

    async def stop(self) -> None:
        self._stopping = True
        self.speaker.stop()
        if self._lock.locked() and self.client is not None:
            with contextlib.suppress(Exception):
                await self.client.interrupt()

    async def reset(self) -> None:
        await self.stop()
        async with self._lock:
            with contextlib.suppress(Exception):
                await self.client.disconnect()
            await self._connect()
            self.turn = {}
            self.emit("turn", rid="", user="")

    # ── commands from windows ──

    async def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "ask":
            self._spawn(self.ask(str(msg.get("text", ""))[:4000]))
        elif kind == "listen":
            self._spawn(self.listen())
        elif kind == "stop":
            await self.stop()
        elif kind == "approve":
            self.resolve(str(msg.get("id")), str(msg.get("choice")))
        elif kind == "mute":
            self.speaker.muted = bool(msg.get("value"))
            if self.speaker.muted:
                self.speaker.stop()
            self.emit("muted", value=self.speaker.muted)
        elif kind == "reset":
            self._spawn(self.reset())
        elif kind == "task_cancel":
            self.tasks.cancel(int(msg.get("id", 0)))
        elif kind == "refresh":
            self._spawn(self._refresh_status(calendar=True))

    # ── live status ──

    async def _poll_status(self) -> None:
        tick = 0
        while True:
            await self._refresh_status(calendar=tick % 10 == 0)
            tick += 1
            await asyncio.sleep(30)

    async def _refresh_status(self, calendar: bool) -> None:
        status = dict(self.status)
        status["battery"] = battery()
        if calendar:
            status["next_event"] = await next_event()
        if status != self.status:
            self.status = status
            self.emit("status", **status)


def battery() -> dict[str, Any] | None:
    import psutil

    info = psutil.sensors_battery()
    if info is None:
        return None
    return {"percent": round(info.percent), "plugged": bool(info.power_plugged)}


async def next_event(now: datetime | None = None) -> dict[str, Any] | None:
    """The next timed event today or tomorrow, read only while Calendar is open."""
    if not mac_tools.app_running("Calendar"):
        return None
    now = now or datetime.now()
    try:
        events = await mac_tools.fetch_events(0, 2)
    except mac_tools.ToolFailure:
        return None
    upcoming = [e for e in events if not e["all_day"] and e["begin"] >= now]
    if not upcoming:
        return None
    e = upcoming[0]
    return {"title": e["title"], "begin": e["begin"].isoformat(timespec="minutes")}
