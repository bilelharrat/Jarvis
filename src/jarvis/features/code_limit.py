"""Eden Code: when Claude's usage limit is reached, wait for it to reset and carry on
there, instead of moving the session to the fallback model.

The settings (Eden Code settings › While it works): "When Claude's usage limit is
reached": ask the first time (the default), switch to the fallback model, or wait for it to
reset; and "Unattended and queued runs wait for the limit" (on).

The defaults (2026-10-16; before, every session switched to the fallback): a run nobody is
watching (an unattended run, an automation's, a to-do card or the routing queue's) waits,
since nobody is there to choose and moving its code to another model unasked is the silent
switch owners object to. A session the owner is at waits too the first time, with a card
that asks which they'd like from then on (wait, or the fallback); the answer is kept. With
no fallback model set up there's nothing to ask: it waits.

Waiting: the turn Claude couldn't answer ends quietly (as a move to the fallback does),
the session says until when it waits, and its queue is held (TaskManager: hold_until):
messages the owner sends meanwhile wait there, shown as queued, with a countdown in the
session's header. When the limit resets (the time Claude Code gave with this session's
own limit, or half an hour later when it gave none, and then again, RETRIES times in a row
at most before it goes to the fallback), the session is told to carry on from where it
stopped, and the queued messages follow. The owner can try Claude again at once,
or move it to the fallback model after all, from the header. The wait outlasts a restart
(code_sessions keeps until when it waits): the session comes back waiting, and carries on
when the limit resets, at once if it reset while the app was closed.

Only Claude's usage limit waits: an outage, an overload or a sign-in problem still goes to
the fallback, and a session on another provider's model isn't Claude's to wait for.
JARVIS's own conversation keeps the fallback either way.

Window commands: code_limit {id, action: now | fallback}.
Settings (prefs.features): code_limit_wait (True: wait; False: the fallback; "ask", the
default: wait and ask the first time), code_limit_wait_unwatched (bool, True).

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
from ..hub import _epoch, _msg_int
from ..proactive import Alert

PREF = "code_limit_wait"
ASK = "ask"  # not chosen yet: wait, and ask the first time a limit stops a watched session
PREF_UNWATCHED = "code_limit_wait_unwatched"


def _wait_choice(value: Any) -> Any:
    return value if isinstance(value, bool) or value == ASK else None


prefs.register_feature_pref(PREF, ASK, _wait_choice)
prefs.register_feature_pref(PREF_UNWATCHED, True)
RETRY = 30 * 60.0  # Claude Code gave no reset time: try again this much later
LONGEST = 7 * 24 * 3600.0  # a weekly limit, at most
# Waits with no reset time given, one after another (each limit again soon after carrying
# on), before it stops waiting and leaves the session to the fallback: 3 hours of tries.
RETRIES = 6
EARLY = 1.0  # the wait ends this much before the hold, so the note goes first
# The longest the wait sleeps at once: asyncio's clock stops while the Mac sleeps, so a
# wait slept whole would carry on as late as the Mac slept. It looks at the clock again.
LOOK_AGAIN = 60.0
RESET = "Claude's limit has reset: carrying on."
NOW = "Trying Claude again now."
LEFT = "On {name} now: it no longer waits for Claude's usage limit."

CARRY_ON = (
    "[Note from the app: Claude's usage limit stopped this session at {at}. It has reset "
    "now: whatever the conversation above already did is done, so don't redo it.]\n\n"
    "Carry on with my last request from where it was left."
)

ZH = {
    "Claude's usage limit is reached: this session waits until {time} and carries on then. Messages you send meanwhile wait too.": "已达到 Claude 的用量上限：这个会话会等到{time}，然后接着做。这期间你发的消息也会等着。",
    "Claude's usage limit is reached: Eden Code waits until {time} and carries on then.": "已达到 Claude 的用量上限：Eden Code 会等到{time}，然后接着做。",
    "Claude's limit has reset: carrying on.": "Claude 的用量上限已重置：接着做。",
    "Trying Claude again now.": "现在再试一次 Claude。",
    "On {name} now: it no longer waits for Claude's usage limit.": "现在用的是{name}：不再等 Claude 的用量上限。",
    "another model": "另一个模型",
    "This session isn't waiting for Claude.": "这个会话没有在等 Claude。",
    "There's no fallback model to move it to.": "没有可以换过去的备用模型。",
    "Claude's usage limit": "Claude 的用量上限",
    "Claude's usage limit is reached. Wait for it to reset, or switch to {name}?": "已达到 Claude 的用量上限。等它重置，还是换成{name}？",
    "Waiting keeps this session on Claude and carries on when the limit resets ({time}); anything you send meanwhile waits too. Your answer is kept for next time (Eden Code settings › While it works).": "等待会让这个会话留在 Claude 上，在用量上限重置时（{time}）接着做；这期间你发的消息也会等着。你的选择会记住，下次照做（Eden Code 设置 › 工作时）。",
    "Wait for it": "等它重置",
    "Switch to {name}": "换成{name}",
    "Ask me next time": "下次再问我",
    "Back after the restart: it still waits for Claude's usage limit to reset, until {time}, and carries on then.": "重启后回来了：它仍在等 Claude 的用量上限重置，等到{time}，然后接着做。",
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


def _runs_card(todo: Any, task_id: int) -> bool:
    """Whether the to-do board (code_todo: its cards, the routing queue's among them) has a
    running card on this session; a card keeps its session's number as "task"."""
    cards = getattr(getattr(todo, "board", None), "cards", None) or []
    return any(
        isinstance(c, dict) and c.get("task") == task_id and c.get("state") == "running"
        for c in cards
    )


class LimitWait:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waits: dict[int, asyncio.Task] = {}
        self.since: dict[int, float] = {}  # session -> when Claude's limit stopped it
        self._told: set[int] = set()  # reset times a heads-up was given for
        # session -> the waits in a row with no reset time given, and when the last ended
        self.tries: dict[int, tuple[int, float]] = {}

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def say(self, template: str, **values: Any) -> str:
        """One of ZH's sentences in the owner's language, its slots as they are."""
        return lang.tr(template, self.hub.language, **values)

    def wanted(self, task: Any = None) -> bool:
        """Whether Claude's usage limit is waited out (for this session: an unattended or
        queued one waits with PREF_UNWATCHED on, whatever PREF says), rather than left to the
        fallback. Not chosen yet (ASK) counts as waiting: the first limit asks, meanwhile."""
        if task is not None and self.unwatched(task):
            if self.hub.prefs.feature(PREF_UNWATCHED) is not False:
                return True
        value = self.hub.prefs.feature(PREF)
        return value is True or value == ASK

    def chosen(self, task: Any) -> bool:
        """Waiting was chosen for this session (the owner's "wait", or an unattended or queued
        run with PREF_UNWATCHED on), not merely the default's ask: Model Router's own
        fallback within one provider goes first unless it was (code_router)."""
        if self.unwatched(task) and self.hub.prefs.feature(PREF_UNWATCHED) is not False:
            return True
        return self.hub.prefs.feature(PREF) is True

    def unwatched(self, task: Any) -> bool:
        """A run nobody is at: an unattended run's or an automation's (code_runs), or a
        to-do card's, started from the board or the routing queue (code_todo)."""
        runs = getattr(getattr(self.hub, "code_runs", None), "active", None)
        if isinstance(runs, dict) and task.id in runs:
            return True
        with contextlib.suppress(Exception):
            return _runs_card(getattr(self.hub, "code_todo", None), task.id)
        return False

    def asking(self, task: Any) -> bool:
        """The owner hasn't chosen yet and is at this session: the first limit asks."""
        return self.hub.prefs.feature(PREF) == ASK and not self.unwatched(task)

    def has_fallback(self) -> bool:
        hub = self.hub
        with contextlib.suppress(Exception):
            return bool(getattr(hub.prefs, "fallback_code", True) and hub._fallback_ref())
        return False

    async def ask(self, task: Any, until: float) -> None:
        """The first limit with nothing chosen: a card, wait or the fallback, kept for next
        time. No answer (or "Ask me next time") keeps it waiting and asks again next time."""
        hub = self.hub
        name = hub.providers.describe(hub._fallback_ref()) or self.tr("another model")
        at = _clock(until, lang.is_zh(hub.language))
        choice = await hub.request_approval(
            self.say(
                "Claude's usage limit is reached. Wait for it to reset, or switch to {name}?",
                name=name,
            ),
            self.say(
                "Waiting keeps this session on Claude and carries on when the limit resets "
                "({time}); anything you send meanwhile waits too. Your answer is kept for next "
                "time (Eden Code settings › While it works).",
                time=at,
            ),
            [
                ("wait", self.tr("Wait for it")),
                ("fallback", self.say("Switch to {name}", name=name)),
                ("later", self.tr("Ask me next time")),
            ],
        )
        if choice == "wait":
            hub.set_feature_prefs({PREF: True})
        elif choice == "fallback":
            hub.set_feature_prefs({PREF: False})
            if task.hold_until > 0:
                self.release(task, fallback=True)

    def claude_down(self, inner: Any) -> Any:
        """TaskManager.on_claude_down, wrapped: Claude's usage limit, with waiting on, is
        waited out; everything else goes on to the fallback as before."""

        def down(task: Any, why: str, said: str = "") -> bool:
            if (
                why != "rate_limit"
                or task.kind != "code"
                or not self.wanted(task)
                or str(task.model_ref).startswith("custom:")  # another provider's limit
            ):
                return inner(task, why, said) if inner is not None else False
            ask = self.asking(task) and self.has_fallback()
            now = time.time()
            back = self.reset_of(task)
            if back <= now:
                # No reset time: try again in a while, though not for ever. A limit that
                # comes again soon after each try is a wait in a row; after RETRIES of them
                # the session goes to the fallback, as with the setting off.
                count, ended = self.tries.get(task.id, (0, 0.0))
                count = count + 1 if now - ended < RETRY else 1
                if count > RETRIES:
                    self.tries.pop(task.id, None)
                    return inner(task, why, said) if inner is not None else False
                self.tries[task.id] = (count, now)
            else:
                self.tries.pop(task.id, None)
            self.hub._claude_couldnt()
            until = min(back if back > now else now + RETRY, now + LONGEST)
            self.hold(task, until)
            if ask:
                self.hub._spawn(self.ask(task, until))
            return True  # the turn's end is a handover, not a failure

        return down

    @staticmethod
    def reset_of(task: Any) -> float:
        """When the limit that stopped this session resets: the time Claude Code gave with
        its own connection's report (a weekly Opus limit never holds a Sonnet session for
        days, as the app's latest report from any session could), 0 when it gave none."""
        info = getattr(task, "rate_limit", None)
        if info is None or getattr(info, "status", "") != "rejected":
            return 0.0
        return _epoch(getattr(info, "resets_at", None))

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
                "Claude's usage limit is reached: Eden Code waits until {time} and carries on "
                "then.",
                time=at,
            )
            self.hub.notify(
                Alert(f"code-limit:{marker}", "task", self.tr("Claude's usage limit"), text),
                speak=False,
            )

    def resume(self, task: Any, until: float, since: float) -> None:
        """A session that was waiting when the app quit, brought back (code_sessions): it
        waits on, quietly (it was said, and the heads-up given, then), and carries on when
        the limit resets: at once, if it already has."""
        now = time.time()
        until = min(until, now + LONGEST)
        task.hold_until = until
        self.since[task.id] = since if 0 < since <= now else now
        if until > now:
            self.hub.tasks._log(
                task,
                "system",
                self.say(
                    "Back after the restart: it still waits for Claude's usage limit to reset, "
                    "until {time}, and carries on then.",
                    time=_clock(until, lang.is_zh(self.hub.language)),
                ),
            )
        old = self.waits.pop(task.id, None)
        if old is not None:
            old.cancel()
        self.waits[task.id] = self.hub._spawn(self._wait(task, until))

    async def _wait(self, task: Any, until: float) -> None:
        while (left := until - time.time() - EARLY) > 0:
            await asyncio.sleep(min(left, LOOK_AGAIN))
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
        if task.id in self.tries:  # (a limit again soon after this is a wait in a row)
            self.tries[task.id] = (self.tries[task.id][0], time.time())
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

    def leave(self, task: Any, name: str = "") -> None:
        """The waiting session moved to another provider's model (picked from the menu, or
        by Model Router): Claude's limit isn't its to wait out any more. The wait ends now,
        with no "Claude's limit has reset" note for a model that never had the limit, and
        the messages queued meanwhile go on to the model it's on now."""
        if task.hold_until <= 0:
            return
        wait = self.waits.pop(task.id, None)
        if wait is not None and wait is not asyncio.current_task():
            wait.cancel()
        task.hold_until = 0.0
        task.falling_back = False
        self.since.pop(task.id, None)
        self.hub.tasks._log(
            task,
            "system",
            self.say(LEFT, name=name or self.tr("another model")),
        )
        task.stirred.set()  # (an open session waiting out the limit takes them up now)
        tm = self.hub.tasks
        idle = task.handle is None or task.handle.done()
        if idle and not task.inbox.empty() and task.status != "stopped":
            task.status, task.restarts = "running", 0
            task.handle = asyncio.create_task(tm._session(task))
        tm._changed()

    def cmd(self, msg: dict[str, Any]) -> None:
        task = self.hub.tasks.tasks.get(_msg_int(msg, "id"))  # (not a number: none)
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
