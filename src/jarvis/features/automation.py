"""Automation: routines on richer schedules (every N minutes in a window, monthly, cron),
said and shown in the owner's language; timers, alarms and reminders to the second.

install(hub) only registers: nothing here reads a file, starts a thread or touches the
network until a loop runs or a command arrives.

Window commands: automation_state (-> the "automation" event: the routines, the timers,
the language), automation_timer {action: stop|snooze|cancel, id}.
Settings (prefs.features): alarm_phone (an alarm set to ring the phone may call it).
Tools (server "automation"): set_timer, set_alarm, set_reminder, list_timers, cancel_timer,
snooze_timer, stop_timer. Loop: "timers".

Claude cost: none. Timers, alarms and reminders never call a model.
"""

from __future__ import annotations

import logging
import weakref
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import hub as hub_module
from .. import lang, prefs
from .. import timers as timer_kit

log = logging.getLogger("jarvis")

SERVER_NAME = "automation"

prefs.register_feature_pref("alarm_phone", False)

# Did the owner's own words this turn ask for it? (hub.feature_gate; each pattern also
# takes the Chinese.) Anything else, from a routine or an email, asks with a card.
_ZH = lang._ASK_LEAD_ZH
_TIMER_WORDS_ZH = r"(?:计时器|定时器|倒计时|闹钟|闹铃|提醒)"
ASKED = {
    "timer_set": (
        r"(?:set|start|make|create|put\s+on|give\s+me|run|add)\s+(?:me\s+)?(?:up\s+)?"
        r"(?:(?:an?|the|my|another)\s+)?(?:[\w'-]+\s+){0,4}?(?:timer|countdown|alarm|reminder)s?\b"
        r"|(?:wake|get)\s+me\s+(?:up\s+)?(?:at|in|by|tomorrow|tonight|before|around)\b"
        r"|remind\s+me\b"
        r"|(?:an?\s+)?(?:[\w'-]+\s+){0,3}?(?:timer|alarm)\s+(?:for|at|in)\s"
        rf"|{_ZH}(?:(?:定|设|设置|开|来|加)(?:一个|个|一下)?[^，,。]{{0,12}}?{_TIMER_WORDS_ZH}"
        r"|[^，,。]{0,12}?(?:提醒我|叫醒我|叫我起床)|[^，,。]{1,12}?(?:后|以后|之后)叫我)"
    ),
    "timer_change": (
        r"(?:cancel|stop|delete|remove|clear|kill|end|dismiss|turn\s+off|switch\s+off"
        r"|shut\s+off|silence|snooze|reset)\s+(?:[\w'-]+\s+){0,5}?"
        r"(?:timers?|alarms?|reminders?|it|that|them|all\s+of\s+them|everything)\b"
        r"|snooze\b"
        rf"|{_ZH}(?:(?:取消|删掉|删除|关掉|关闭|停掉|停止|关了|停了|去掉|清除|推迟|延后)"
        rf"[^，,。]{{0,12}}?{_TIMER_WORDS_ZH}"
        rf"|把[^，,。]{{0,12}}?{_TIMER_WORDS_ZH}[^，,。]{{0,4}}?"
        r"(?:关掉|关了|关上|停掉|停了|取消|删掉|删了|去掉|推迟)"
        r"|贪睡|再睡一会|稍后再响|晚点再叫我|等会儿再叫我)"
    ),
}
hub_module.FEATURE_ASKED.update({a: hub_module._asks(p) for a, p in ASKED.items()})

# The window's words for what the brain did (the Activity drawer), and its instructions.
LABELS = {
    "set_timer": "Set a timer",
    "set_alarm": "Set an alarm",
    "set_reminder": "Set a reminder",
    "list_timers": "Checked your timers",
    "cancel_timer": "Cancelled a timer",
    "snooze_timer": "Snoozed",
    "stop_timer": "Stopped the ringing",
}
PROMPT = (
    "\n- Timers, alarms and reminders: set_timer counts down to the second ('pasta timer for "
    "9 minutes'); set_alarm rings at a time of day until stopped or snoozed, and calls the "
    "user's phone too when they ask for that; set_reminder says something once ('in 10 "
    "minutes', 'at 3pm') or again every N minutes until a time ('every 20 minutes to "
    "stretch until 6pm'). list_timers, cancel_timer, snooze_timer and stop_timer manage them."
    "\n- Routines can also run every N minutes within a time window (schedule interval), "
    "monthly (a day of the month, its last day, or its Nth weekday) or on a cron schedule "
    "in a time zone."
)
# Their results are the owner's own timers and JARVIS's words: nothing another person wrote.
QUIET = tuple(LABELS)

# The cards that ask, when it wasn't the owner's own words this turn.
ZH = {
    "Set a timer for {span}?": "要设一个{span}的计时器吗？",
    "Set an alarm for {time}?": "要设一个{time}的闹钟吗？",
    "Remind you: {label}?": "要提醒你：{label}吗？",
    "Cancel {names}?": "要取消{names}吗？",
    "Snooze {names}?": "要推迟{names}吗？",
    "Stop {names}?": "要停掉{names}吗？",
}
for _english, _chinese in ZH.items():
    lang.ZH_TEXTS.setdefault(_english, _chinese)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


class Automation:
    """One hub's automation: its timers, what the window is sent, its commands and tools."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.timers = timer_kit.Timers(
            hub.feature_path("timers.json"),
            lambda alert, busy: hub.notify(alert, speak_if_busy=busy),
            language=lambda: hub.prefs.language,
            call=hub.phone.call_me,
            phone_on=lambda: bool(hub.prefs.feature("alarm_phone")),
            stops=lambda: hub._stops,
            on_change=self.send_timers,
            spawn=hub._spawn,
        )

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def say(self, template: str, **values: Any) -> str:
        return timer_kit.say(template, self.language(), **values)

    # ── the window ──

    def state(self) -> dict[str, Any]:
        return {
            "language": self.hub.prefs.language,
            "routines": self.hub.routines.public(),
            "timers": self.timers.public(),
        }

    def send_state(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("automation", **self.state())

    def send_timers(self) -> None:
        self.hub.emit("automation", timers=self.timers.public())

    def timer_command(self, msg: dict[str, Any]) -> None:
        """Stop, Snooze and Cancel in Settings or on a ringing card: the owner's own tap."""
        action, key = msg.get("action"), str(msg.get("id") or "")
        if not key:
            return
        if action == "stop":
            self.timers.stop(key)
        elif action == "snooze":
            self.timers.snooze(key, msg.get("minutes") or timer_kit.SNOOZE_MINUTES)
        elif action == "cancel":
            found = [t for t in self.timers.store.items if t.id == key]
            ringing = self.timers.stop(key)
            if found:
                self.timers.cancel(found)
            elif not ringing:
                self.send_timers()

    # ── the brain's tools ──

    async def _ok(self, action: str, question: str) -> bool:
        return await self.hub.feature_gate(action, question)

    def build_server(self):
        return create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=self.tools())

    def tools(self) -> list:
        timers, hub = self.timers, self.hub

        @tool(
            "set_timer",
            "Start a countdown timer: 'set a timer for 12 minutes', 'a 90-second timer', "
            "'pasta timer for 9 minutes'. seconds: how long (1 second to 24 hours). label: "
            "what it's for in the user's words ('pasta'), or empty. It rings when it's done.",
            {
                "type": "object",
                "properties": {"seconds": {"type": "integer"}, "label": {"type": "string"}},
                "required": ["seconds"],
            },
        )
        async def set_timer(args):
            now = timers.now()
            try:
                timer = timer_kit.new_timer(args.get("seconds"), args.get("label", ""), now)
            except ValueError as exc:
                return _text(str(exc), error=True)
            length = timer_kit.span(timer.seconds, self.language())
            if not await self._ok("timer_set", self.say("Set a timer for {span}?", span=length)):
                return _text("The user said no. No timer was set.", error=True)
            try:
                timers.add(timer)
            except (ValueError, OSError) as exc:
                return _text(f"I couldn't set it: {exc}", error=True)
            return _text(
                f"Timer set for {timer_kit.span(timer.seconds)} (it goes off at "
                f"{timer_kit.clock(timer.due_at)})."
            )

        @tool(
            "set_alarm",
            "Set an alarm for a time of day: 'wake me at 6:30', 'an alarm at 7:15 tomorrow'. "
            "time: 24-hour HH:MM (or HH:MM:SS); it's the next time that comes unless date "
            "(YYYY-MM-DD) says which day. label: what it's for ('wake up', 'leave for the "
            "airport') or empty. call_phone: true only when the user asks to be rung on their "
            "phone too. It rings until it's stopped or snoozed.",
            {
                "type": "object",
                "properties": {
                    "time": {"type": "string"},
                    "date": {"type": "string"},
                    "label": {"type": "string"},
                    "call_phone": {"type": "boolean"},
                },
                "required": ["time"],
            },
        )
        async def set_alarm(args):
            now = timers.now()
            try:
                timer = timer_kit.new_alarm(
                    args.get("time"),
                    args.get("label", ""),
                    now,
                    str(args.get("date") or ""),
                    phone=args.get("call_phone") is True,
                )
            except ValueError as exc:
                return _text(str(exc), error=True)
            at = timer_kit.clock(timer.due_at, self.language())
            if not await self._ok("timer_set", self.say("Set an alarm for {time}?", time=at)):
                return _text("The user said no. No alarm was set.", error=True)
            try:
                timers.add(timer)
            except (ValueError, OSError) as exc:
                return _text(f"I couldn't set it: {exc}", error=True)
            day = "today" if timer.due_at.date() == now.date() else timer.due_at.strftime("%A")
            phone = ""
            if timer.phone:
                phone = (
                    " It will ring their phone too."
                    if hub.prefs.feature("alarm_phone")
                    else " Ringing their phone is off: they can turn it on in Settings ›"
                    " Timers & reminders."
                )
            return _text(f"Alarm set for {timer_kit.clock(timer.due_at)} {day}.{phone}")

        @tool(
            "set_reminder",
            "Remind the user of something, once ('in 10 minutes, check the oven', 'at 3pm, "
            "call Ann') or again and again ('every 20 minutes to stretch until 6pm'). text: "
            "what to remind them of, in their words ('stretch', 'call Ann'). The first time: "
            "in_minutes, or at (24-hour HH:MM); every_minutes repeats it, until (HH:MM) stops "
            "it. It's said and shown as a card.",
            {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "in_minutes": {"type": "number"},
                    "at": {"type": "string"},
                    "every_minutes": {"type": "number"},
                    "until": {"type": "string"},
                },
                "required": ["text"],
            },
        )
        async def set_reminder(args):
            now = timers.now()
            try:
                timer = timer_kit.new_reminder(
                    args.get("text", ""),
                    now,
                    in_minutes=args.get("in_minutes"),
                    at=args.get("at"),
                    every_minutes=args.get("every_minutes"),
                    until=args.get("until"),
                )
            except ValueError as exc:
                return _text(str(exc), error=True)
            if not await self._ok("timer_set", self.say("Remind you: {label}?", label=timer.label)):
                return _text("The user said no. No reminder was set.", error=True)
            try:
                timers.add(timer)
            except (ValueError, OSError) as exc:
                return _text(f"I couldn't set it: {exc}", error=True)
            return _text(f"Reminder set: {timer.describe(now)}.")

        @tool(
            "list_timers",
            "The timers, alarms and reminders that are set (with the time left) and whatever "
            "is ringing now.",
            {},
        )
        async def list_timers(_args):
            return _text(timers.describe())

        def picked(which: str) -> list:
            which = str(which or "").strip()
            if which.lower() in ("all", "everything", "all of them", "全部", "所有"):
                return list(timers.store.items)
            return timers.store.find(which)

        def names(items: list) -> str:
            return ", ".join(t.label or t.kind for t in items[:5]) + ("…" if len(items) > 5 else "")

        @tool(
            "cancel_timer",
            "Cancel timers, alarms or reminders before they go off (or silence one ringing). "
            "which: an id from list_timers, a label ('pasta'), a kind ('the alarm', "
            "'reminders') or 'all'.",
            {"which": str},
        )
        async def cancel_timer(args):
            items = picked(args.get("which", ""))
            ringing = [t for t, _task in timers.ringing.values()]
            if not items and not ringing:
                return _text("Nothing like that is set.", error=True)
            if len(items) > 1 and str(args.get("which", "")).strip().lower() not in (
                "all", "everything", "all of them", "全部", "所有", "alarms", "timers", "reminders"
            ):  # fmt: skip
                return _text(
                    "Several match: "
                    + "; ".join(t.describe(timers.now()) for t in items)
                    + ". Ask which one, or cancel by id.",
                    error=True,
                )
            chosen = items or ringing
            if not await self._ok("timer_change", self.say("Cancel {names}?", names=names(chosen))):
                return _text("The user said no. Nothing was cancelled.", error=True)
            timers.stop(args.get("which", ""))
            gone = timers.cancel(items)
            return _text(f"Cancelled: {names(gone or chosen)}.")

        @tool(
            "snooze_timer",
            "Snooze what's ringing (or rang in the last few minutes): it goes off again in "
            "minutes (9 unless the user says). which: a label or kind, or empty for whatever "
            "is ringing.",
            {
                "type": "object",
                "properties": {"which": {"type": "string"}, "minutes": {"type": "integer"}},
            },
        )
        async def snooze_timer(args):
            which = str(args.get("which") or "")
            waiting = [t for t, _task in timers.ringing.values()] + [
                t for t, _at in timers.recent.values()
            ]
            if not any(not which or timer_kit._picks(t, which) for t in waiting):
                return _text("Nothing is ringing, or rang in the last few minutes.", error=True)
            question = self.say("Snooze {names}?", names=names(waiting))
            if not await self._ok("timer_change", question):
                return _text("The user said no.", error=True)
            snoozed = timers.snooze(which, args.get("minutes") or timer_kit.SNOOZE_MINUTES)
            if not snoozed:
                return _text("Nothing is ringing, or rang in the last few minutes.", error=True)
            at = timer_kit.clock(snoozed[0].due_at)
            return _text(f"Snoozed: {names(snoozed)}, until {at}.")

        @tool(
            "stop_timer",
            "Stop what's ringing now (it's done). which: a label or kind, or empty for all of it.",
            {"type": "object", "properties": {"which": {"type": "string"}}},
        )
        async def stop_timer(args):
            which = str(args.get("which") or "")
            ringing = [
                t for t, _task in timers.ringing.values() if not which or timer_kit._picks(t, which)
            ]
            if not ringing:
                return _text("Nothing is ringing.", error=True)
            if not await self._ok("timer_change", self.say("Stop {names}?", names=names(ringing))):
                return _text("The user said no.", error=True)
            stopped = timers.stop(which)
            return _text(f"Stopped: {names(stopped)}.")

        return [
            set_timer,
            set_alarm,
            set_reminder,
            list_timers,
            cancel_timer,
            snooze_timer,
            stop_timer,
        ]


_FEATURES: weakref.WeakKeyDictionary[Any, Automation] = weakref.WeakKeyDictionary()


def feature_of(hub: Any) -> Automation | None:
    """This hub's automation (for the tests and the other automation modules)."""
    return _FEATURES.get(hub)


def install(hub: Any) -> None:
    feature = Automation(hub)
    _FEATURES[hub] = feature
    # The card that adds a routine asks in the language the owner speaks.
    hub.routines.language = lambda: hub.prefs.language
    hub.register_server(
        SERVER_NAME, feature.build_server, prompt=PROMPT, labels=LABELS, quiet=QUIET
    )
    hub.register_command("automation_state", feature.send_state)
    hub.register_command("automation_timer", feature.timer_command)
    hub.register_loop("timers", feature.timers.run)
