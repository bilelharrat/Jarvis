"""Jarvis Code: when Claude's usage limit is reached, wait for it to reset and carry on
there, instead of moving the session to the fallback model.

The setting (Jarvis Code settings › While it works): "When Claude's usage limit is
reached": switch to the fallback model (as before, the default) or wait for it to reset.

Waiting: the turn Claude couldn't answer ends quietly (as a move to the fallback does),
the session says until when it waits, and its queue is held (TaskManager: hold_until):
messages the owner sends meanwhile wait there, shown as queued, with a countdown in the
session's header. When the limit resets (the time Claude Code gave with its limit, or half
an hour later when it gave none, and then again), the session is told to carry on from
where it stopped, and the queued messages follow. The owner can try Claude again at once,
or move it to the fallback model after all, from the header.

Only Claude's usage limit waits: an outage, an overload or a sign-in problem still goes to
the fallback, and a session on another provider's model isn't Claude's to wait for.
JARVIS's own conversation keeps the fallback either way.

Window commands: code_limit {id, action: now | fallback}.
Settings (prefs.features): code_limit_wait (bool, False).

No Claude calls of its own: waiting costs nothing, and carrying on is the session's next
turn, which it would have taken anyway.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import datetime
from typing import Any

from .. import lang, prefs
from ..proactive import Alert

PREF = "code_limit_wait"
prefs.register_feature_pref(PREF, False)
RETRY = 30 * 60.0  # Claude Code gave no reset time: try again this much later
LONGEST = 7 * 24 * 3600.0  # a weekly limit, at most
EARLY = 1.0  # the wait ends this much before the hold, so the note goes first
RESET = "Claude's limit has reset: carrying on."
NOW = "Trying Claude again now."

CARRY_ON = (
    "[Note from the app: Claude's usage limit stopped this session at {at}. It has reset "
    "now: whatever the conversation above already did is done, so don't redo it.]\n\n"
    "Carry on with my last request from where it was left."
)

ZH = {
    "Claude's usage limit is reached: this session waits until {time} and carries on then. Messages you send meanwhile wait too.": "已达到 Claude 的用量上限：这个会话会等到{time}，然后接着做。这期间你发的消息也会等着。",
    "Claude's usage limit is reached: Jarvis Code waits until {time} and carries on then.": "已达到 Claude 的用量上限：Jarvis Code 会等到{time}，然后接着做。",
    "Claude's limit has reset: carrying on.": "Claude 的用量上限已重置：接着做。",
    "Trying Claude again now.": "现在再试一次 Claude。",
    "This session isn't waiting for Claude.": "这个会话没有在等 Claude。",
    "There's no fallback model to move it to.": "没有可以换过去的备用模型。",
    "Claude's usage limit": "Claude 的用量上限",
}
lang.add_texts(ZH)


def _clock(epoch: float, zh: bool = False) -> str:
    """When the limit resets, for people: "5:00 PM" today, "Thu 5:00 PM" this week, "Oct 3,
    5:00 PM" later (a weekly limit); in Chinese 下午5点, 周四下午5点, 10月3日下午5点."""
    when, today = datetime.fromtimestamp(epoch), datetime.now().date()
    days = (when.date() - today).days
    if zh:
        noon = "AM" if when.hour < 12 else "PM"
        at = lang.clock_zh(when.hour % 12 or 12, when.minute, noon, spoken=False)
        if days == 0:
            return at
        if 0 < days < 7:
            return f"周{'一二三四五六日'[when.weekday()]}{at}"
        return f"{when.month}月{when.day}日{at}"
    hour = f"{when.hour % 12 or 12}:{when.minute:02d} {'AM' if when.hour < 12 else 'PM'}"
    if days == 0:
        return hour
    if 0 < days < 7:
        return f"{when:%a} {hour}"
    return f"{when:%b} {when.day}, {hour}"


class LimitWait:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waits: dict[int, asyncio.Task] = {}
        self.since: dict[int, float] = {}  # session -> when Claude's limit stopped it
        self._told: set[int] = set()  # reset times a heads-up was given for

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def say(self, template: str, **values: Any) -> str:
        """One of ZH's sentences in the owner's language, its slots as they are."""
        return lang.tr(template, self.hub.language, **values)

    def wanted(self) -> bool:
        return bool(self.hub.prefs.feature(PREF))

    def claude_down(self, inner: Any) -> Any:
        """TaskManager.on_claude_down, wrapped: Claude's usage limit, with waiting on, is
        waited out; everything else goes on to the fallback as before."""

        def down(task: Any, why: str, said: str = "") -> bool:
            if (
                why != "rate_limit"
                or task.kind != "code"
                or not self.wanted()
                or str(task.model_ref).startswith("custom:")  # another provider's limit
            ):
                return inner(task, why, said) if inner is not None else False
            self.hub._claude_couldnt()
            now = time.time()
            back = float(getattr(self.hub, "_claude_back_at", 0.0) or 0.0)
            until = back if back > now else now + RETRY
            self.hold(task, min(until, now + LONGEST))
            return True  # the turn's end is a handover, not a failure

        return down

    def hold(self, task: Any, until: float) -> None:
        task.hold_until = until
        self.since[task.id] = time.time()
        at = _clock(until, lang.is_zh(self.hub.language))
        self.hub.tasks._log(
            task,
            "system",
            self.say(
                "Claude's usage limit is reached: this session waits until {time} and carries "
                "on then. Messages you send meanwhile wait too.",
                time=at,
            ),
        )
        old = self.waits.pop(task.id, None)
        if old is not None:
            old.cancel()
        self.waits[task.id] = self.hub._spawn(self._wait(task, until))
        self.hub.tasks._changed()
        marker = round(until / 60)
        if marker not in self._told:
            self._told.add(marker)
            text = self.say(
                "Claude's usage limit is reached: Jarvis Code waits until {time} and carries on "
                "then.",
                time=at,
            )
            self.hub.notify(
                Alert(f"code-limit:{marker}", "task", self.tr("Claude's usage limit"), text),
                speak=False,
            )

    async def _wait(self, task: Any, until: float) -> None:
        await asyncio.sleep(max(0.0, until - time.time() - EARLY))
        if task.hold_until == until:
            self.waits.pop(task.id, None)
            self.release(task)

    def release(self, task: Any, fallback: bool = False, said: str = RESET) -> str:
        """The wait is over: carry on on Claude (the note goes before anything queued), or
        on the fallback model. With no fallback to go to, it keeps waiting as it was."""
        if fallback and task.status != "stopped":
            if not self.hub._code_claude_down(task, "rate_limit", ""):
                return "There's no fallback model to move it to."
        wait = self.waits.pop(task.id, None)
        if wait is not None and wait is not asyncio.current_task():
            wait.cancel()
        task.hold_until = 0.0
        task.falling_back = False  # the next limit is heard again
        since = self.since.pop(task.id, time.time())
        if task.status == "stopped":
            # Ended meanwhile (by the owner, or its run's cap): it doesn't carry on by itself.
            # What the owner sent it since goes, as they'd expect.
            if not task.inbox.empty() and task.session_id:
                with contextlib.suppress(ValueError):
                    self.hub.tasks.start("", str(task.cwd), resume=task.session_id)
            self.hub.tasks._changed()
            return ""
        if fallback:  # (the hub moves it there and has it carry on)
            self.hub.tasks._changed()
            return ""
        self.hub.tasks._log(task, "system", self.tr(said))
        self.hub.tasks.send(task.id, CARRY_ON.format(at=_clock(since)), note=True)  # (for Claude)
        self.hub.tasks._changed()
        return ""

    def cmd(self, msg: dict[str, Any]) -> None:
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError):
            task = None
        if task is None or task.hold_until <= 0:
            self.hub.emit("caption", text=self.tr("This session isn't waiting for Claude."))
            return
        if msg.get("action") == "fallback":
            said = self.release(task, fallback=True)
        else:
            said = self.release(task, said=NOW) or NOW
        if said:
            self.hub.emit("caption", text=self.tr(said))

    def forget(self) -> None:
        for wait in self.waits.values():
            with contextlib.suppress(Exception):
                wait.cancel()
        self.waits.clear()


def install(hub: Any) -> None:
    waiting = LimitWait(hub)
    hub.code_limit = waiting  # (for the tests)
    hub.tasks.on_claude_down = waiting.claude_down(hub.tasks.on_claude_down)
    hub.register_command("code_limit", waiting.cmd)
