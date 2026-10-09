"""What the Mac pushes to the paired phones, and when (push.py sends it).

What goes, as each phone chooses in Settings:
- approvals: every card waiting on a yes, JARVIS's and Eden Code's. A card with a "no"
  among its answers carries the Lock Screen actions (Allow, Not now, No, because…); a
  purchase, a plan or a question from Eden Code opens the app to answer instead.
- heads-ups: urgent ones only (the default), all of them, or none.
- Eden Code: a session that finished after working a minute or more, or stopped.
- conversations JARVIS holds for the owner: one that's now waiting on them.
- calls: how a call JARVIS made went, and calls to the Jarvis number.

When: only while the owner is away from the Mac (no keyboard or mouse for two minutes,
or the screen locked), unless Settings says always. In quiet hours only urgent heads-ups
and VIPs make a sound; everything else arrives silently.

What a push says: the Mac's own short words, who and what kind of thing. Never the text
of a message, an email or a call, never a draft or a command, never a session's prompt.

How often: at most 20 pushes a minute to one phone, and the same push twice within a
minute goes once.

Claude cost policy: nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import lang, push
from .proactive import in_quiet_hours, quiet_hours_now

log = logging.getLogger("jarvis")

WHEN_PREF = "companion_push_when"  # "away" (the default) or "always"
AWAY_SECONDS = 120  # no keyboard or mouse this long: the owner has stepped away
PUSH_RATE = (20, 10)  # pushes a minute to one phone, and the most at once
REPEAT_SECONDS = 60  # the same push again this soon isn't sent
# Heads-ups whose words are JARVIS's own about the owner's calendar, weather and Mac (or
# their own request): shown as they are. Any other kind shows only a fixed line.
OWN_WORDS = frozenset({"leave", "soon", "battery", "rain", "weather", "task", "learned", "call"})

TEXTS = {
    "en": {
        "answer": "Answer here or on your Mac.",
        "code_question": "Eden Code has a question",
        "in_folder": "In {folder}",
        "code_done": "Eden Code finished",
        "code_stopped": "Eden Code stopped",
        "conversation": "Conversation with {who}",
        "needs_you": "It needs you before it goes on.",
        "message": "New message",
        "message_urgent": "Urgent message",
        "mail": "New email",
        "mail_urgent": "Urgent email",
        "meeting": "Your meeting notes are ready.",
        "files": "Files for this meeting are ready on your Mac.",
        "from": "From {who}",
        "call_number": "A call to the Jarvis number.",
        "jarvis": "Jarvis",
        "heads_up": "Something new on your Mac.",
        "test": "Push notifications from this Mac work.",
    },
    "zh": {
        "answer": "在这里或在 Mac 上回答。",
        "code_question": "Eden Code 有个问题",
        "in_folder": "在 {folder} 中",
        "code_done": "Eden Code 已完成",
        "code_stopped": "Eden Code 已停止",
        "conversation": "与{who}的对话",
        "needs_you": "需要你回复后才能继续。",
        "message": "新消息",
        "message_urgent": "紧急消息",
        "mail": "新邮件",
        "mail_urgent": "紧急邮件",
        "meeting": "会议记录已整理好。",
        "files": "这场会议的文件已在 Mac 上准备好。",
        "from": "来自{who}",
        "call_number": "有人拨打了 Jarvis 号码。",
        "jarvis": "Jarvis",
        "heads_up": "Mac 上有新提醒。",
        "test": "这台 Mac 的推送通知工作正常。",
    },
}


async def owner_away() -> bool:
    """Whether the owner has stepped away from the Mac: no keyboard or mouse for
    AWAY_SECONDS, or the screen locked. Can't tell: away (the push goes)."""
    try:
        idle, locked = await asyncio.to_thread(_idle)
    except Exception:
        return True
    return locked or idle >= AWAY_SECONDS


def _idle() -> tuple[float, bool]:
    import Quartz

    idle = Quartz.CGEventSourceSecondsSinceLastEventType(
        Quartz.kCGEventSourceStateCombinedSessionState, Quartz.kCGAnyInputEventType
    )
    session = Quartz.CGSessionCopyCurrentDictionary() or {}
    return float(idle), bool(session.get("CGSSessionScreenIsLocked"))


@dataclass
class Note:
    """One thing to tell the phones."""

    kind: str  # approval | code_approval | code_needs_you | headsup | code_done | delegation | call
    ident: str  # the approval's or alert's id
    title: str
    body: str
    setting: str  # which of a phone's settings lets it through
    category: str = "JARVIS_HEADSUP"
    thread: str = ""
    collapse: str = ""
    task_id: int | None = None
    choices: list[dict[str, str]] = field(default_factory=list)
    urgent: bool = False  # makes a sound even in quiet hours
    level: str = "active"
    ttl: int = 3600  # seconds Apple may keep trying while the phone is out of reach

    def payload(self, quiet: bool, now: float) -> dict[str, Any]:
        level, sound = self.level, True
        if quiet and not self.urgent:
            level, sound = "passive", False
        jarvis: dict[str, Any] = {"kind": self.kind, "id": self.ident, "at": int(now)}
        if self.task_id is not None:
            jarvis["task_id"] = self.task_id
        if self.choices:
            jarvis["choices"] = self.choices
        return push.alert(
            self.title,
            self.body,
            category=self.category,
            thread=self.thread,
            sound=sound,
            level=level,
            jarvis=jarvis,
        )


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def collapse_id(key: str) -> str:
    """Apple's collapse ids are at most 64 bytes: a digest of the key."""
    return "h-" + hashlib.sha256(key.encode()).hexdigest()[:24]


class Notifier:
    """Hears the hub (approval cards, heads-ups, Eden Code's sessions ending) and pushes
    to each phone what it asked for."""

    def __init__(
        self,
        companion: Any,
        sender: push.Sender,
        away: Callable[[], Awaitable[bool]] = owner_away,
        clock: Callable[[], float] = time.time,
    ) -> None:
        from .remote import Limiter

        self.companion = companion
        self.hub = companion.hub
        self.sender = sender
        self.away = away
        self.clock = clock
        self._limits = Limiter({"push": PUSH_RATE})
        self._sent: dict[tuple[str, str], tuple[float, str]] = {}
        self._away: tuple[float, bool] | None = None
        self._delegations: dict[str, str] | None = None

    # ── words ──

    def lang(self) -> str:
        return "zh" if lang.is_zh(getattr(self.hub.prefs, "language", "en")) else "en"

    def t(self, key: str, **values: Any) -> str:
        return TEXTS[self.lang()][key].format(**values)

    def translated(self, text: str) -> str:
        return lang.translate(text, self.lang())

    # ── the hub's sinks ──

    def approval(self, card: dict[str, Any]) -> None:
        note = self.approval_note(card)
        if note is not None:
            self._spawn(self.deliver(note))

    def alert(self, alert: Any) -> None:
        if alert.kind == "delegate":
            for note in self.delegation_notes():
                self._spawn(self.deliver(note))
            return
        note = self.alert_note(alert)
        if note is not None:
            self._spawn(self.deliver(note))

    def task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "task_finished":
            note = self.code_note(data)
            if note is not None:
                self._spawn(self.deliver(note))

    def _spawn(self, coro: Any) -> None:
        try:
            asyncio.get_running_loop()
        except RuntimeError:  # heard with no event loop (a test's plain call; the app calls
            coro.close()  # on its loop): nothing can be pushed from here, so it never starts
            return
        spawn = getattr(self.hub, "_spawn", None)
        if spawn is not None:
            spawn(coro)
        else:  # pragma: no cover - every hub has it
            asyncio.get_running_loop().create_task(coro)

    # ── what each says ──

    def _focused(self, task_id: Any) -> bool:
        """The session being voice-coded at the Mac speaks for itself: no push."""
        voicecode = getattr(self.hub, "voicecode", None)
        return task_id is not None and getattr(voicecode, "focus", None) == task_id

    def approval_note(self, card: dict[str, Any]) -> Note | None:
        choices = [
            {"id": _line(c.get("id"), 40), "label": _line(c.get("label"), 60)}
            for c in (card.get("choices") or [])[:6]
            if isinstance(c, dict)
        ]
        ids = [c["id"] for c in choices]
        task_id = card.get("task_id")
        code = isinstance(task_id, int) and not isinstance(task_id, bool) and task_id > 0
        if code and self._focused(task_id):
            return None
        ask_kind = card.get("ask_kind")
        actionable = "deny" in ids and any(i != "deny" for i in ids) and ask_kind != "purchase"
        if code and ask_kind == "question":  # Claude's own question: its words stay on the Mac
            title = self.t("code_question")
            task = self.hub.tasks.tasks.get(task_id)
            body = self.t("in_folder", folder=task.cwd.name) if task is not None else ""
        else:
            title, body = _line(card.get("question"), 110), self.t("answer")
        if code:
            kind = "code_approval" if actionable else "code_needs_you"
            category = "JARVIS_CODE_APPROVAL" if actionable else "JARVIS_HEADSUP"
        else:
            kind = "approval"
            category = "JARVIS_APPROVAL" if actionable else "JARVIS_HEADSUP"
        from .hub import APPROVAL_TIMEOUT

        ident = _line(card.get("id"), 40)
        return Note(
            kind=kind,
            ident=ident,
            title=title,
            body=body,
            setting="approvals",
            category=category,
            thread=f"code-{task_id}" if code else "approvals",
            collapse=f"a-{ident}",
            task_id=task_id if code else None,
            choices=choices,
            level="time-sensitive",
            ttl=APPROVAL_TIMEOUT,  # a card unanswered this long has gone: so has its push
        )

    def alert_note(self, alert: Any) -> Note | None:
        key, kind = str(alert.key), str(alert.kind)
        if key.startswith(("code:", "code-ok:")):
            return None  # Eden Code's own events and cards say these
        urgent = bool(getattr(alert, "urgent", False))
        vip = bool(getattr(alert, "vip", False) or getattr(alert, "breakthrough", False))
        title = self.translated(_line(alert.title, 110))
        if kind in ("message", "mail"):  # who it's from, never what it says
            body = self.t(f"{kind}_urgent" if urgent else kind)
        elif kind == "voicemail":
            who = self._caller(key)
            body = self.t("from", who=who) if who else self.t("call_number")
        elif kind == "meeting":
            body = self.t("meeting")
        elif kind == "files":
            body = self.t("files")
        elif kind in OWN_WORDS:
            body = self.translated(_line(alert.text, 240))
        else:
            title, body = self.t("jarvis"), self.t("heads_up")
        calls = kind in ("call", "voicemail")
        pressing = urgent or vip or kind == "leave"
        return Note(
            kind="call" if calls else "headsup",
            ident=_line(key, 80),
            title=title,
            body=body,
            setting="calls" if calls else ("headsups_urgent" if pressing else "headsups"),
            thread=kind,
            collapse=collapse_id(key),
            urgent=urgent or vip,
            level="time-sensitive" if pressing else "active",
            ttl=6 * 3600 if calls else 3600,
        )

    def _caller(self, key: str) -> str:
        """Who called the Jarvis number, from the call log (the owner's Contacts name, or
        the number): never what they said."""
        tail = key.partition(":")[2]
        answering = getattr(self.hub, "answering", None)
        calls = getattr(getattr(answering, "log", None), "calls", None) or []
        call = next((c for c in calls if tail and str(c.id).endswith(tail)), None)
        return _line(call.who(), 60) if call is not None else ""

    def code_note(self, data: dict[str, Any]) -> Note | None:
        task_id, status = data.get("id"), data.get("status")
        if data.get("task_kind") != "code" or status == "stopped" or not isinstance(task_id, int):
            return None  # stopped or closed by the owner: nothing to tell them
        from .hub import CODE_ANNOUNCE_SECONDS

        done = status == "done"
        if done and (data.get("elapsed") or 0) < CODE_ANNOUNCE_SECONDS:
            return None  # a quick back-and-forth isn't news (the Mac doesn't say it either)
        if self._focused(task_id):
            return None
        return Note(
            kind="code_done",
            ident=f"code:{task_id}",
            title=self.t("code_done" if done else "code_stopped"),
            body=self.t("in_folder", folder=_line(data.get("folder"), 60)),
            setting="code",
            thread=f"code-{task_id}",
            collapse=f"code-{task_id}",
            task_id=task_id,
            ttl=6 * 3600,
        )

    def delegation_notes(self) -> list[Note]:
        """A note for each conversation that has just started waiting on the owner."""
        items = list(getattr(getattr(self.hub, "delegations", None), "items", None) or [])
        before, self._delegations = self._delegations, {d.id: d.status for d in items}
        if before is None:
            before = {}
        return [
            Note(
                kind="delegation",
                ident=d.id,
                title=self.t("conversation", who=_line(d.contact, 40)),
                body=self.t("needs_you"),
                setting="delegations",
                thread=f"dlg-{d.id}",
                collapse=f"dlg-{d.id}",
                ttl=6 * 3600,
            )
            for d in items
            if d.status == "waiting_owner" and before.get(d.id) != "waiting_owner"
        ]

    def settle_delegations(self) -> None:
        """What's waiting now is known (at start): only a change after it is news."""
        items = list(getattr(getattr(self.hub, "delegations", None), "items", None) or [])
        self._delegations = {d.id: d.status for d in items}

    # ── sending ──

    @staticmethod
    def wants(settings: dict[str, Any], setting: str) -> bool:
        if setting == "headsups_urgent":
            return settings.get("headsups") in ("urgent", "all")
        if setting == "headsups":
            return settings.get("headsups") == "all"
        return settings.get(setting) is True

    async def owner_is_away(self) -> bool:
        if self.hub.prefs.feature(WHEN_PREF) == "always":
            return True
        now = time.monotonic()
        if self._away is not None and now - self._away[0] < 5:
            return self._away[1]
        away = await self.away()
        self._away = (now, away)
        return away

    def _repeat(self, device_id: str, note: Note, now: float) -> bool:
        digest = hashlib.sha256(f"{note.title}\n{note.body}".encode()).hexdigest()
        key = (device_id, note.collapse or note.ident)
        last = self._sent.get(key)
        if last is not None and now - last[0] < REPEAT_SECONDS and last[1] == digest:
            return True
        self._sent[key] = (now, digest)
        if len(self._sent) > 2000:
            self._sent = {k: v for k, v in self._sent.items() if now - v[0] < REPEAT_SECONDS}
        return False

    async def deliver(self, note: Note, *, test: bool = False, only: str = "") -> dict[str, str]:
        """Push this to every phone that wants it (test: to each registered phone, or
        only this one, whatever it wants and wherever the owner is). What happened, by
        device id: "sent", or why not."""
        creds = await self.sender.route()  # the owner's key, or their Jarvis account
        if creds is None:
            return {}
        if not test and not await self.owner_is_away():
            return {}
        now = self.clock()
        quiet = not test and quiet_hours_now(self.hub, datetime.now(), in_quiet_hours)
        payload = note.payload(quiet, now)
        store = self.companion.store
        jobs: dict[str, Awaitable[push.Result]] = {}
        outcome: dict[str, str] = {}
        for device in list(self.hub.remote.devices.items):
            if only and device.id != only:
                continue
            record = store.known(device.id)
            registration = record and record["push"]
            if not registration:
                continue
            if not test and not self.wants(record["settings"], note.setting):
                continue
            if not creds.allows(registration["bundle_id"]):
                outcome[device.id] = "not this app"
                continue
            if not test and (
                self._repeat(device.id, note, now) or self._limits.wait(device.id, "push")
            ):
                outcome[device.id] = "held back"
                continue
            jobs[device.id] = self.sender.send(
                push.Push(
                    device_token=registration["token"],
                    environment=registration["environment"],
                    topic=registration["bundle_id"],
                    payload=payload,
                    push_type="alert",
                    priority=5 if payload["aps"]["interruption-level"] == "passive" else 10,
                    collapse_id=note.collapse,
                    expiration=0 if test else int(now) + note.ttl,
                )
            )
        if not jobs:
            return outcome
        results = await asyncio.gather(*jobs.values())
        changed = False
        for device_id, result in zip(jobs, results, strict=True):
            if result.ok:
                outcome[device_id] = "sent"
            elif result.gone:
                store.unregister(device_id, "gone")
                outcome[device_id] = "gone"
                changed = True
            else:
                outcome[device_id] = result.reason or f"status {result.status}"
                changed = changed or result.bad_key
        if changed:
            self.companion.emit_status()
        return outcome

    async def test(self, only: str = "") -> dict[str, str]:
        note = Note(
            kind="headsup",
            ident="test",
            title=self.t("jarvis"),
            body=self.t("test"),
            setting="headsups",
            collapse="test",
        )
        return await self.deliver(note, test=True, only=only)
