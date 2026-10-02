"""Live Activities on the iPhone's Lock Screen and Dynamic Island, kept current by the Mac.

The app starts one for something it follows (a Jarvis Code session, a conversation JARVIS
holds for the owner, a phone call, a video being summarized) and registers its push token
(POST /api/live/register {activity: "<kind>:<id>", token}). From then on the Mac pushes
the activity's state as it changes: at once when it starts or stops needing the owner,
at most every LIVE_MIN_SECONDS for progress, and a last push with event "end" once it's
over (it stays on the Lock Screen a quarter of an hour more). A token Apple says is gone
is let go, and so is one older than LIVE_HOURS (iOS ends activities by then).

What's shown passes through Apple's servers, so it's who and what kind of thing: a
project's and a file's name at most, never a command, a message, a prompt or a draft.

Claude cost policy: nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Callable
from typing import Any

from . import lang, push

log = logging.getLogger("jarvis")

LIVE_MIN_SECONDS = 15  # progress pushed at most this often (needing you, and the end, at once)
TICK_SECONDS = 5.0  # a look at what's followed, unless something says to look sooner
CALL_SECONDS = 3600  # a call's activity with no outcome by then ends
TRIES = 3  # pushes to one activity that fail (other than a gone token) before it's let go

WORDS = {
    "en": {
        "working": "Working",
        "needs_you": "Needs you",
        "done": "Done",
        "failed": "Failed",
        "idle": "Ready",
        "resting": "Ended",
        "ended": "Ended",
        "active": "Talking",
        "waiting_owner": "Needs you",
        "stopped": "Stopped",
        "expired": "Ended",
        "calling": "Calling",
        "phone_call": "Phone call",
        "code": "Jarvis Code · {folder}",
        "code_gone": "Jarvis Code",
        "conversation": "Conversation with {who}",
        "conversation_gone": "Conversation",
        "messages": "{n} messages",
        "message": "1 message",
        "video_gone": "Video",
        "starting": "Starting",
        "fetching": "Fetching",
        "extracting": "Getting the sound",
        "transcribing": "Transcribing",
        "ready": "Ready",
        "cancelled": "Cancelled",
        "command": "Running a command",
        "searching": "Searching the code",
        "agent": "Working with an agent",
        "editing": "Editing {name}",
        "writing": "Writing {name}",
        "reading": "Reading {name}",
        "waiting": "Waiting for you",
    },
    "zh": {
        "working": "进行中",
        "needs_you": "需要你",
        "done": "已完成",
        "failed": "失败",
        "idle": "就绪",
        "resting": "已结束",
        "ended": "已结束",
        "active": "对话中",
        "waiting_owner": "需要你",
        "stopped": "已停止",
        "expired": "已结束",
        "calling": "通话中",
        "phone_call": "电话",
        "code": "Jarvis Code · {folder}",
        "code_gone": "Jarvis Code",
        "conversation": "与{who}的对话",
        "conversation_gone": "对话",
        "messages": "{n} 条消息",
        "message": "1 条消息",
        "video_gone": "视频",
        "starting": "正在开始",
        "fetching": "正在获取",
        "extracting": "正在提取声音",
        "transcribing": "正在转写",
        "ready": "就绪",
        "cancelled": "已取消",
        "command": "正在运行命令",
        "searching": "正在搜索代码",
        "agent": "正在与助手一起工作",
        "editing": "正在编辑 {name}",
        "writing": "正在写入 {name}",
        "reading": "正在读取 {name}",
        "waiting": "等你回复",
    },
}


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


class Live:
    """The Live Activities the phones follow, and the pushes that keep them current."""

    def __init__(self, companion: Any, sender: push.Sender, clock: Callable[[], float] = time.time):
        self.companion = companion
        self.hub = companion.hub
        self.sender = sender
        self.clock = clock
        self._last: dict[tuple[str, str], tuple[str, float, bool]] = {}  # digest, sent, needs
        self._calls: dict[str, str] = {}  # call id -> how it went
        self._failed: dict[tuple[str, str], int] = {}  # pushes that didn't go, in a row
        self._wake: asyncio.Event | None = None

    # ── words ──

    def w(self, key: str, **values: Any) -> str:
        words = WORDS["zh" if lang.is_zh(getattr(self.hub.prefs, "language", "en")) else "en"]
        return words.get(key, key).format(**values)

    def action(self, last: str) -> str:
        """A session's latest step, as the Lock Screen may show it: never a command's
        text, a search pattern or an agent's brief, which can hold anything."""
        for prefix, key in (
            ("Editing ", "editing"),
            ("Writing ", "writing"),
            ("Reading ", "reading"),
        ):
            if last.startswith(prefix):
                return self.w(key, name=_line(last[len(prefix) :], 60))
        if last.startswith("Running "):
            return self.w("command")
        if last.startswith("Searching for "):
            return self.w("searching")
        if last.startswith("Agent: "):
            return self.w("agent")
        if last in ("Waiting for you", "Asking you"):
            return self.w("waiting")
        return ""

    # ── being told ──

    def follow(self, device_id: str, activity: str, token: str, **where: str) -> None:
        self.companion.store.follow(device_id, activity, token, self.clock(), **where)
        self._last.pop((device_id, activity), None)  # a new token: its first state goes at once
        self.poke()

    def poke(self) -> None:
        """Look again soon (a card went up, a session or a conversation changed)."""
        if self._wake is not None:
            self._wake.set()

    def approval(self, _card: Any) -> None:
        self.poke()

    def resolved(self, _approval_id: str) -> None:
        self.poke()

    def task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind in ("tasks", "task_finished"):
            self.poke()

    def alert(self, alert: Any) -> None:
        """A call's outcome ends its activity (the call's id: the last 8 of its sid, as
        the call's own push names it)."""
        if alert.kind == "call":
            self._calls[str(alert.key).partition(":")[2]] = _line(alert.text, 200)
            if len(self._calls) > 50:
                del self._calls[next(iter(self._calls))]
        if alert.kind in ("call", "delegate"):
            self.poke()

    # ── what each shows ──

    def _state(
        self, title: str, status: str, detail: str, progress: float | None, needs: bool, now: float
    ) -> dict[str, Any]:
        state: dict[str, Any] = {
            "title": title[:80],
            "status": status[:40],
            "detail": detail[:120],
            "needsYou": needs,
            "updatedAt": int(now),
        }
        if progress is not None:
            state["progress"] = round(min(1.0, max(0.0, progress)), 3)
        return state

    def state_for(
        self, activity: str, followed_at: float, now: float
    ) -> tuple[dict[str, Any], bool]:
        """(the content state, whether it's over) for one activity."""
        kind, _, ident = activity.partition(":")
        if kind == "code":
            return self._code(ident, now)
        if kind == "delegation":
            return self._delegation(ident, now)
        if kind == "video":
            return self._video(ident, now)
        live = getattr(self.hub, "live_calls", None)
        found = live.activity(ident) if live is not None and ident not in self._calls else None
        if found is not None:  # a call JARVIS placed, running now (features/calls.py)
            who, state, needs = found
            status = self.w({"asking": "waiting_owner", "yours": "active"}.get(state, "calling"))
            return self._state(_line(who, 60), status, "", None, needs, now), False
        if ident in self._calls:  # a call
            return self._state(
                self.w("phone_call"), self.w("ended"), self._calls[ident], None, False, now
            ), True
        over = now - followed_at > CALL_SECONDS
        status = self.w("ended") if over else self.w("calling")
        return self._state(self.w("phone_call"), status, "", None, False, now), over

    def _code(self, ident: str, now: float) -> tuple[dict[str, Any], bool]:
        from .companion_api import session_status

        task = self.hub.tasks.tasks.get(int(ident)) if ident.isdigit() else None
        if task is None or task.kind != "code":
            return self._state(self.w("code_gone"), self.w("ended"), "", None, False, now), True
        needs = any(a.get("task_id") == task.id for a in list(self.hub.approvals.values()))
        status = session_status(task, needs)
        todos = [t for t in task.todos if isinstance(t, dict)]
        progress = (
            sum(t.get("status") == "completed" for t in todos) / len(todos) if todos else None
        )
        ended = task.status in ("closed", "stopped", "failed")
        return (
            self._state(
                self.w("code", folder=_line(task.cwd.name, 40)),
                self.w(status),
                self.action(str(task.last_action or "")) if not ended else "",
                progress,
                needs,
                now,
            ),
            ended,
        )

    def _delegation(self, ident: str, now: float) -> tuple[dict[str, Any], bool]:
        d = next((d for d in self.hub.delegations.items if d.id == ident), None)
        if d is None:
            return self._state(
                self.w("conversation_gone"), self.w("ended"), "", None, False, now
            ), True
        count = len(d.transcript)
        detail = self.w("message") if count == 1 else self.w("messages", n=count)
        needs = d.status == "waiting_owner"
        return (
            self._state(
                self.w("conversation", who=_line(d.contact, 40)),
                self.w(d.status),
                detail,
                None,
                needs,
                now,
            ),
            not d.is_open,
        )

    def _video(self, ident: str, now: float) -> tuple[dict[str, Any], bool]:
        job = self.hub.video.jobs.get(int(ident)) if ident.isdigit() else None
        if job is None:
            return self._state(self.w("video_gone"), self.w("ended"), "", None, False, now), True
        return (
            self._state(_line(job.title, 80), self.w(job.state), "", job.progress(), False, now),
            not job.active,
        )

    # ── pushing ──

    async def tick(self) -> list[tuple[str, str, str]]:
        """Push what changed. (device id, activity, "update" or "end") for each sent."""
        from .companion import LIVE_HOURS

        creds = await self.sender.route()  # the owner's key, or their Jarvis account
        if creds is None:
            return []
        now = self.clock()
        store = self.companion.store
        paired = {d.id for d in self.hub.remote.devices.items}
        jobs: list[tuple[tuple[str, str], str, bool, str, bool, Any]] = []
        for device_id, activity, item in store.following():
            if device_id not in paired:
                store.unfollow(device_id, activity)
                continue
            state, ended = self.state_for(activity, item["at"], now)
            if now - item["at"] > LIVE_HOURS * 3600:
                ended = True  # iOS has ended it by now: a last word, then let it go
            digest = hashlib.sha256(
                json.dumps(
                    {k: v for k, v in state.items() if k != "updatedAt"}, sort_keys=True
                ).encode()
            ).hexdigest()
            key = (device_id, activity)
            last = self._last.get(key)
            if last is not None and not ended:
                if last[0] == digest:
                    continue  # nothing new
                if state["needsYou"] == last[2] and now - last[1] < LIVE_MIN_SECONDS:
                    continue  # progress: it waits its turn
            record = store.known(device_id) or {}
            registration = record.get("push") or {}
            environment = item.get("environment") or registration.get("environment") or "production"
            bundle = item.get("bundle_id") or registration.get("bundle_id") or creds.bundle_id
            if not creds.allows(bundle):
                continue
            needs = bool(state["needsYou"])
            urgent = ended or last is None or needs != last[2]
            event = "end" if ended else "update"
            job = self.sender.send(
                push.Push(
                    device_token=item["token"],
                    environment=environment,
                    topic=f"{bundle}.push-type.liveactivity",
                    payload=push.live_update(state, event=event, now=now),
                    push_type="liveactivity",
                    priority=10 if urgent else 5,
                    expiration=int(now) + 3600,
                )
            )
            jobs.append((key, event, ended, digest, needs, job))
        if not jobs:
            return []
        results = await asyncio.gather(*(j[5] for j in jobs))
        sent = []
        for (key, event, ended, digest, needs, _job), result in zip(jobs, results, strict=True):
            failures = 0 if result.ok else self._failed.get(key, 0) + 1
            if result.ok:
                sent.append((*key, event))
                if not ended:
                    self._last[key] = (digest, now, needs)
            if (result.ok and ended) or result.gone or failures >= TRIES:
                store.unfollow(*key)  # over, its token no good any more, or Apple won't take it
                self._last.pop(key, None)
                self._failed.pop(key, None)
            elif failures:
                self._failed[key] = failures
            else:
                self._failed.pop(key, None)
        return sent

    async def loop(self) -> None:
        """Runs while the app does (a feature loop: never in tests)."""
        self._wake = asyncio.Event()
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("companion: Live Activity updates failed")
            try:
                await asyncio.wait_for(self._wake.wait(), TICK_SECONDS)
            except TimeoutError:
                pass
            self._wake.clear()
