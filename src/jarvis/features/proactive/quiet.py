"""Quiet hours that follow the Mac: a Focus mode, the weekend's own hours, and a snooze said
out loud.

- Focus (Settings › Speaking up › Follow Focus, on by default): while a Focus mode is on (Do
  Not Disturb, Sleep, Work…), it's quiet hours everywhere quiet hours count: heads-ups are
  cards, not words, suggestions and check-ins wait, routines run without a sound. macOS
  keeps the Focus state in ~/Library/DoNotDisturb/DB: Assertions.json holds one turned on
  by hand, ModeConfigurations.json each mode's name and schedule. Reading them needs Full
  Disk Access for J.A.R.V.I.S.; without it (or on a Mac without those files) Focus simply
  isn't followed, and Settings says why. The loop reads them in a thread every FOCUS_EVERY
  seconds; nothing reads them on the hub's loop.
- The weekend's own hours (quiet_weekend "HH:MM-HH:MM"; "" keeps the weekdays' hours every
  day): a night belongs to the morning it ends in, so Friday night keeps the weekend's
  hours and Sunday night the weekdays'.
- Snooze: "snooze everything for an hour", "pause heads-ups for 30 minutes", "don't disturb
  me until 3", "resume heads-ups" (and 暂停提醒一小时, 一个小时内别打扰我, 恢复提醒) pause
  heads-ups through the shell's pause (the menu bar's "Pause heads-ups for an hour", which
  holds them back), answered at once without Claude. A pause counts as quiet hours too. The
  brain's snooze_heads_ups does the same for other wordings, asking first unless the
  owner's own words asked for it.

Each says its piece through hub.add_quiet_check: Focus on and a pause say "quiet" (True);
the weekend's hours decide either way (True or False); otherwise the range in Settings.

Window: {"type": "proactive_state"} -> the "proactive" event's "quiet" part: {follow,
focus: {state: on|off|no_access|unavailable, name}, paused_until (epoch seconds), quiet
(now), why: focus|paused|weekend|range|""}.
Settings (prefs.features): quiet_weekend, quiet_focus.
Tools (server "quiet"): snooze_heads_ups. Loop: "focus".

Cost: no model calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ... import hub as hub_module
from ... import lang, prefs
from ...proactive import in_quiet_hours
from ...timers import clock

try:
    from .. import shell as shell_feature
except ImportError:  # a build without the shell's pause: no snooze to reuse
    shell_feature = None

log = logging.getLogger("jarvis")

SERVER_NAME = "quiet"
FOCUS_DIR = Path.home() / "Library" / "DoNotDisturb" / "DB"
FOCUS_EVERY = 20  # seconds between looks at the Focus state
SNOOZE_DEFAULT = 60  # minutes, when no length is said
SNOOZE_MAX = 12 * 60  # the shell's longest pause
ENABLED_TRIGGER = 2  # a Focus schedule's enabledSetting when it's switched on

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def clean_range(value: Any) -> str | None:
    """ "" (no hours of its own) or "HH:MM-HH:MM"; None for anything else."""
    if value == "":
        return ""
    if not isinstance(value, str):
        return None
    parts = value.split("-")
    ok = len(parts) == 2 and all(_HHMM.match(p) for p in parts)
    return value if ok else None


prefs.register_feature_pref("quiet_weekend", "", clean_range)
prefs.register_feature_pref("quiet_focus", True)

# JARVIS's own sentences, with their Chinese (lang.tr and lang.translate know them).
TEXTS = {
    "Heads-ups are paused until {time}.": "提醒已暂停，到{time}为止。",
    "Heads-ups are back on.": "提醒已恢复。",
    "Pause heads-ups until {time}?": "要暂停提醒到{time}吗？",
    "Turn heads-ups back on?": "要恢复提醒吗？",
}
lang.add_texts(TEXTS)

# Did the owner's own words this turn ask for a snooze? (hub.feature_gate; each pattern
# takes the Chinese too.) Anything else, from a routine or an email, asks with a card: a
# snooze can hide a heads-up that matters.
_ZH = lang._ASK_LEAD_ZH
ASKED = {
    "quiet_snooze": (
        r"(?:snooze|pause|mute|silence|hold(?:\s+off)?|resume|unsnooze|unpause|unmute)\s+"
        r"(?:[\w'-]+\s+){0,3}?(?:everything|heads[\s-]?ups?|notifications?|alerts?"
        r"|interruptions?)\b"
        r"|(?:be|keep)\s+quiet\b|don'?t\s+(?:disturb|bother|interrupt)\s+me\b"
        r"|do\s+not\s+(?:disturb|bother|interrupt)\s+me\b"
        r"|no\s+(?:more\s+)?(?:interruptions|heads[\s-]?ups)\b"
        rf"|{_ZH}(?:(?:暂停|静音|屏蔽|恢复)[^，,。]{{0,6}}?(?:提醒|通知|播报)"
        r"|[^，,。]{0,10}?(?:别|不要)(?:再)?(?:打扰|提醒|吵)我|安静)"
    ),
}
hub_module.FEATURE_ASKED.update({a: hub_module._asks(p) for a, p in ASKED.items()})


# ── Focus ──

_MODE_NAMES = {
    "com.apple.donotdisturb.mode.default": "Do Not Disturb",
    "com.apple.sleep.sleep-mode": "Sleep",
    "com.apple.focus.work": "Work",
    "com.apple.focus.personal-time": "Personal",
    "com.apple.donotdisturb.mode.driving": "Driving",
    "com.apple.focus.reduce-interruptions": "Reduce Interruptions",
}


def read_focus(folder: Path = FOCUS_DIR, now: datetime | None = None) -> dict[str, Any]:
    """The Focus state as macOS keeps it: {"state": "on", "name": "Work"}, {"state":
    "off"}, {"state": "no_access"} (Full Disk Access is off for J.A.R.V.I.S.) or {"state":
    "unavailable"} (no such files: an older macOS). Blocking: run it in a thread."""
    try:
        assertions = json.loads((folder / "Assertions.json").read_text())
    except PermissionError:
        return {"state": "no_access"}
    except (OSError, ValueError, UnicodeDecodeError):
        return {"state": "unavailable"}
    try:
        configs = json.loads((folder / "ModeConfigurations.json").read_text())
    except (OSError, ValueError, UnicodeDecodeError):
        configs = None  # names and schedules unknown: a Focus turned on by hand still counts
    return focus_state(assertions, configs, now or datetime.now())


def _items(data: Any) -> list[dict[str, Any]]:
    items = data.get("data") if isinstance(data, dict) else None
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _modes(configs: Any) -> dict[str, dict[str, Any]]:
    """Each Focus mode: {id: {"name", "triggers"}} (none when the file can't be read)."""
    modes: dict[str, dict[str, Any]] = {}
    for item in _items(configs):
        found = item.get("modeConfigurations")
        if not isinstance(found, dict):
            continue
        for mode_id, config in list(found.items())[:50]:
            if not isinstance(config, dict):
                continue
            mode = config.get("mode") if isinstance(config.get("mode"), dict) else {}
            triggers = config.get("triggers") if isinstance(config.get("triggers"), dict) else {}
            listed = triggers.get("triggers") if isinstance(triggers.get("triggers"), list) else []
            modes[str(mode_id)] = {
                "name": _name(mode.get("name"), str(mode_id)),
                "triggers": [t for t in listed if isinstance(t, dict)],
            }
    return modes


def _name(value: Any, mode_id: str) -> str:
    name = " ".join(str(value or "").split())[:40]
    return name or _MODE_NAMES.get(mode_id, "Focus")


def focus_state(assertions: Any, configs: Any, now: datetime) -> dict[str, Any]:
    """From the two files' contents: a mode turned on by hand (Assertions.json's records),
    else one whose schedule covers now, else off."""
    modes = _modes(configs)
    for item in _items(assertions):
        records = item.get("storeAssertionRecords")
        for record in records if isinstance(records, list) else []:
            if not isinstance(record, dict):
                continue
            details = record.get("assertionDetails")
            mode_id = ""
            if isinstance(details, dict):
                mode_id = str(details.get("assertionDetailsModeIdentifier") or "")
            known = modes.get(mode_id)
            return {"state": "on", "name": known["name"] if known else _name("", mode_id)}
    for mode in modes.values():
        if any(scheduled_now(trigger, now) for trigger in mode["triggers"]):
            return {"state": "on", "name": mode["name"]}
    return {"state": "off"}


def _int(value: Any, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    value = int(value)
    return value if low <= value <= high else None


def _day_bit(day: date) -> int:
    """A day in a Focus schedule's weekday mask: bit 0 is Sunday … bit 6 Saturday."""
    return 1 << ((day.weekday() + 1) % 7)


def scheduled_now(trigger: dict[str, Any], now: datetime) -> bool:
    """A Focus schedule (DNDModeConfigurationScheduleTrigger) that's switched on and covers
    now. A schedule past midnight belongs to the day it starts."""
    if "Schedule" not in str(trigger.get("class") or "Schedule"):
        return False
    if trigger.get("enabledSetting") != ENABLED_TRIGGER:
        return False
    hours = [_int(trigger.get(f"timePeriod{edge}TimeHour"), 0, 23) for edge in ("Start", "End")]
    minutes = [_int(trigger.get(f"timePeriod{edge}TimeMinute"), 0, 59) for edge in ("Start", "End")]
    if None in hours or None in minutes:
        return False
    start = hours[0] * 60 + minutes[0]  # type: ignore[operator]
    end = hours[1] * 60 + minutes[1]  # type: ignore[operator]
    mask = _int(trigger.get("timePeriodWeekdays", 127), 0, 127)
    days = 127 if mask is None or mask == 0 else mask
    minute = now.hour * 60 + now.minute
    today, yesterday = now.date(), now.date() - timedelta(days=1)
    if start == end:
        return False
    if start < end:
        return start <= minute < end and bool(days & _day_bit(today))
    if minute >= start:
        return bool(days & _day_bit(today))
    return minute < end and bool(days & _day_bit(yesterday))


# ── the weekend's own hours ──


def _span(spec: str) -> tuple[int, int] | None:
    if not clean_range(spec):
        return None
    start, end = (int(p[:2]) * 60 + int(p[3:]) for p in spec.split("-"))
    return start, end


def _weekend(day: date) -> bool:
    return day.weekday() >= 5


def weekend_quiet(now: datetime, weekdays: str, weekend: str) -> bool:
    """Quiet hours with the weekend's own: a night belongs to the morning it ends in, so
    Friday night keeps the weekend's hours and Sunday night the weekdays'. "00:00-00:00"
    is no quiet hours at all."""
    minute = now.hour * 60 + now.minute
    for spec, for_weekend in ((weekdays, False), (weekend, True)):
        span = _span(spec)
        if span is None or span[0] == span[1]:
            continue
        start, end = span
        if start < end:
            if start <= minute < end and _weekend(now.date()) == for_weekend:
                return True
            continue
        if minute >= start and _weekend(now.date() + timedelta(days=1)) == for_weekend:
            return True
        if minute < end and _weekend(now.date()) == for_weekend:
            return True
    return False


# ── the snooze, said ──

_LEAD = (
    r"^(?:(?:ok(?:ay)?|hey|so|and|now|please|jarvis)[,\s]+)*"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?"
)
_WHAT = (
    r"(?:all\s+(?:of\s+)?(?:the\s+|your\s+|my\s+)?|the\s+|your\s+|my\s+)?"
    r"(?:everything|heads[\s-]?ups?|notifications?|alerts?|interruptions?|announcements?)"
)
_FOR = r"(?:\s+(?P<how>for|until|till|til)\s+(?P<span>[\w\s:.-]+?))?"
_END = r"[\s.!,?]*$"
_SNOOZE = re.compile(
    _LEAD + r"(?:snooze|pause|mute|silence|hold(?:\s+off)?)\s+" + _WHAT + _FOR + _END,
    re.IGNORECASE,
)
_HUSH = re.compile(
    _LEAD + r"(?:be\s+quiet|keep\s+quiet|don'?t\s+(?:disturb|bother|interrupt)\s+me"
    r"|do\s+not\s+(?:disturb|bother|interrupt)\s+me|no\s+(?:more\s+)?(?:interruptions"
    r"|heads[\s-]?ups))\s+(?P<how>for|until|till|til)\s+(?P<span>[\w\s:.-]+?)" + _END,
    re.IGNORECASE,
)
_RESUME = re.compile(
    _LEAD + r"(?:(?:resume|unsnooze|unpause|unmute)\s+" + _WHAT + r"(?:\s+again)?"
    r"|turn\s+"
    + _WHAT
    + r"\s+back\s+on|turn\s+back\s+on\s+"
    + _WHAT
    + r"|you\s+can\s+(?:talk|speak)\s+(?:to\s+me\s+)?again)"
    + _END,
    re.IGNORECASE,
)
_ZH_NUM = r"[0-9一二两三四五六七八九十]+"
_ZH_SPAN = rf"(?:{_ZH_NUM}(?:个)?(?:半)?|半(?:个)?)(?:小时|钟头|分钟|分)"
_ZH_LEAD = r"^(?:贾维斯|jarvis)?[，,\s]*(?:请|麻烦|帮我|能不能|能|可以|可不可以)?(?:帮我)?"
_ZH_END = r"(?:吗|吧|啊|好吗|行吗)?[。！!？?，,\s]*$"
_SNOOZE_ZH = re.compile(
    _ZH_LEAD + r"(?:"
    rf"(?:暂停|静音|屏蔽|关掉|关闭)(?:一下)?(?:所有|全部)?(?:的)?(?:提醒|通知|播报){_ZH_SPAN}"
    rf"|{_ZH_SPAN}(?:内|之内|里|以内)?(?:别|不要)(?:再)?(?:打扰|提醒|吵)我"
    rf"|(?:别|不要)(?:再)?(?:打扰|提醒|吵)我{_ZH_SPAN}"
    rf"|安静{_ZH_SPAN}"
    rf"|(?:暂停|静音)(?:所有|全部)?(?:提醒|通知|播报)"
    r")" + _ZH_END,
    re.IGNORECASE,
)
_RESUME_ZH = re.compile(
    _ZH_LEAD + r"(?:恢复|重新开启|取消暂停)(?:所有|全部)?(?:的)?(?:提醒|通知|播报)" + _ZH_END,
    re.IGNORECASE,
)
_WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "forty-five": 45,
    "forty five": 45, "fifty": 50, "sixty": 60, "ninety": 90, "a couple of": 2,
    "a couple": 2, "couple of": 2, "a few": 3,
}  # fmt: skip


def _clock_minutes(text: str, now: datetime) -> int | None:
    """Minutes from now until a time of day said ("3", "3pm", "3:30 p.m.", "noon"): the
    next time it comes, within the longest pause."""
    text = text.strip().lower().replace(".", "")
    if text in ("noon", "midday"):
        hour, minute, half = 12, 0, "pm"
    elif text == "midnight":
        hour, minute, half = 0, 0, "am"
    else:
        m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\s?m|p\s?m)?", text)
        if not m or int(m.group(1)) > 23 or int(m.group(2) or 0) > 59:
            return None
        hour, minute = int(m.group(1)), int(m.group(2) or 0)
        half = (m.group(3) or "").replace(" ", "")
    if half:
        if hour > 12 or hour == 0:
            return None
        hour = hour % 12 + (12 if half == "pm" else 0)
    candidates = []
    base = now.replace(hour=hour % 24, minute=minute, second=0, microsecond=0)
    for shift in (0, 12, 24) if not half and hour <= 12 else (0, 24):
        at = base + timedelta(hours=shift)
        if at > now:
            candidates.append(at)
    if not candidates:
        return None
    minutes = round((min(candidates) - now).total_seconds() / 60)
    return minutes if 1 <= minutes <= SNOOZE_MAX else None


def _span_minutes(text: str) -> int | None:
    """ "an hour", "90 minutes", "half an hour", "an hour and a half", "2 hrs"."""
    text = " ".join(text.lower().split())
    if text in ("half an hour", "a half hour", "half hour", "half-hour"):
        return 30
    m = re.fullmatch(
        r"(?P<n>\d+(?:\.\d+)?|[a-z -]+?)\s*(?P<unit>hours?|hrs?|h|minutes?|mins?|m)"
        r"(?P<half>\s+and\s+a\s+half)?",
        text,
    )
    if not m:
        return None
    raw = m.group("n").strip()
    number = float(raw) if raw[0].isdigit() else _WORD_NUMBERS.get(raw)
    if number is None:
        return None
    hours = m.group("unit").startswith("h")
    minutes = number * 60 if hours else number
    if m.group("half"):
        minutes += 30 if hours else 0.5
    return round(minutes)


def _zh_minutes(span: str) -> int | None:
    """一个小时, 半小时, 一个半小时, 两个钟头, 30分钟, 三十分钟."""
    m = re.fullmatch(
        rf"(?P<n>{_ZH_NUM})?(?:个)?(?P<half>半)?(?:个)?(?P<unit>小时|钟头|分钟|分)", span
    )
    if not m:
        return None
    unit_hours = m.group("unit") in ("小时", "钟头")
    if m.group("n") is None:
        return 30 if m.group("half") and unit_hours else None
    number = lang._zh_int(m.group("n"))
    if number is None:
        return None
    minutes = number * 60 if unit_hours else number
    if m.group("half") and unit_hours:
        minutes += 30
    return minutes


def parse_snooze(text: str, now: datetime) -> int | None:
    """How long a snooze said out loud asks for, in minutes; 0 to resume; None when the
    words aren't a snooze (or the length can't be made out: Claude hears them instead)."""
    said = " ".join(str(text or "").split())
    if not said or len(said) > 120:
        return None
    if _RESUME.match(said) or _RESUME_ZH.match(said):
        return 0
    m = _SNOOZE.match(said) or _HUSH.match(said)
    if m:
        how, span = (m.group("how") or "").lower(), m.group("span")
        if not span:
            return SNOOZE_DEFAULT
        minutes = _clock_minutes(span, now) if how != "for" else _span_minutes(span)
        return minutes if minutes and 1 <= minutes <= SNOOZE_MAX else None
    simplified = lang.to_simplified(said)
    if _SNOOZE_ZH.match(simplified):
        span = re.search(_ZH_SPAN, simplified)
        minutes = _zh_minutes(span.group()) if span else SNOOZE_DEFAULT
        return minutes if minutes and 1 <= minutes <= SNOOZE_MAX else None
    return None


class Quiet:
    """One hub's quiet hours: its checks, the Focus state as last read, the snooze."""

    def __init__(self, hub: Any, folder: Path | None = None) -> None:
        self.hub = hub
        self.folder = folder or FOCUS_DIR  # where macOS keeps the Focus state (tests: temp)
        self.focus: dict[str, Any] = {"state": "unknown"}
        self._sent: dict[str, Any] = {}

    def install(self) -> None:
        hub = self.hub
        hub.add_quiet_check(self.check)
        hub.register_instant(self.instant)
        hub.register_server(
            SERVER_NAME,
            self.build_server,
            prompt=PROMPT,
            labels=LABELS,
            quiet=tuple(LABELS),
        )
        hub.register_loop("focus", self.loop)

    # ── settings ──

    def following(self) -> bool:
        return bool(self.hub.prefs.feature("quiet_focus"))

    def weekend(self) -> str:
        return clean_range(self.hub.prefs.feature("quiet_weekend")) or ""

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    # ── the checks ──

    def paused_until(self) -> float:
        if shell_feature is None:
            return 0.0
        until = shell_feature._clean_until(self.hub.prefs.feature(shell_feature.PAUSE_KEY))
        return until if until and until > time.time() else 0.0

    def check(self, now: datetime) -> bool | None:
        """hub.add_quiet_check: a Focus mode on or a pause says quiet; the weekend's own
        hours decide either way; otherwise no view."""
        if self.following() and self.focus.get("state") == "on":
            return True
        if self.paused_until():
            return True
        weekend = self.weekend()
        if weekend:
            return weekend_quiet(now, self.hub.prefs.quiet_hours, weekend)
        return None

    def why(self, now: datetime) -> str:
        if self.following() and self.focus.get("state") == "on":
            return "focus"
        if self.paused_until():
            return "paused"
        weekend = self.weekend()
        if weekend:
            return "weekend" if weekend_quiet(now, self.hub.prefs.quiet_hours, weekend) else ""
        return "range" if in_quiet_hours(now, self.hub.prefs.quiet_hours) else ""

    # ── the Focus loop ──

    async def loop(self) -> None:
        while True:
            try:
                await self.look()
            except Exception:  # one bad look never ends the loop
                log.exception("quiet: the Focus look failed")
            await asyncio.sleep(FOCUS_EVERY)

    async def look(self) -> dict[str, Any]:
        """Read the Focus state (in a thread) when it's followed; tell the windows when
        what they show changes."""
        if self.following():
            self.focus = await asyncio.to_thread(read_focus, self.folder)
        else:
            self.focus = {"state": "unknown"}
        self.send(only_if_changed=True)
        return self.focus

    # ── the snooze ──

    def snooze(self, minutes: int) -> str:
        """Pause heads-ups for this long (0: resume) through the shell's pause; what to
        say. Raises LookupError when this build has no pause."""
        if shell_feature is None:
            raise LookupError("no pause in this build")
        minutes = max(0, min(SNOOZE_MAX, int(minutes)))
        shell_feature.pause_heads_ups(self.hub, {"minutes": minutes})
        self.send()
        if not minutes:
            return lang.tr("Heads-ups are back on.", self.language())
        until = datetime.fromtimestamp(self.paused_until() or time.time() + minutes * 60)
        return lang.tr(
            "Heads-ups are paused until {time}.",
            self.language(),
            time=clock(until.replace(second=0), self.language()),
        )

    async def instant(self, text: str) -> str | None:
        """hub.register_instant: a snooze said out loud, done at once."""
        if shell_feature is None:
            return None
        minutes = parse_snooze(text, datetime.now())
        if minutes is None or (minutes == 0 and not self.paused_until()):
            return None  # not ours (a resume with nothing paused: Claude can explain)
        return self.snooze(minutes)

    # ── the window ──

    def state(self) -> dict[str, Any]:
        now = datetime.now()
        return {
            "follow": self.following(),
            "focus": dict(self.focus),
            "weekend": self.weekend(),
            "paused_until": self.paused_until(),
            "quiet": self.hub.quiet_now(now),
            "why": self.why(now),
            "snooze": shell_feature is not None,
        }

    def send(self, only_if_changed: bool = False) -> None:
        state = self.state()
        if only_if_changed and state == self._sent:
            return
        self._sent = state
        self.hub.emit("proactive", quiet=state)

    # ── the brain's tool ──

    def build_server(self):
        return create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=self.tools())

    def tools(self) -> list:
        @tool(
            "snooze_heads_ups",
            "Pause heads-ups (spoken alerts, suggestions, check-ins) for a while, or turn them "
            "back on: 'snooze everything until my meeting ends', 'no heads-ups for 45 "
            "minutes'. minutes: how long (1 to 720); 0 turns them back on. A timer, an alarm "
            "or a VIP's urgent message still gets through.",
            {"minutes": int},
        )
        async def snooze_heads_ups(args):
            if shell_feature is None:
                return _text("Snoozing isn't available in this build.", error=True)
            try:
                minutes = int(args.get("minutes", SNOOZE_DEFAULT))
            except (TypeError, ValueError):
                return _text("minutes must be a whole number (0 turns them back on).", True)
            minutes = max(0, min(SNOOZE_MAX, minutes))
            if minutes:
                until = datetime.now() + timedelta(minutes=minutes)
                question = lang.tr(
                    "Pause heads-ups until {time}?",
                    self.language(),
                    time=clock(until.replace(second=0), self.language()),
                )
            else:
                question = lang.tr("Turn heads-ups back on?", self.language())
            if not await self.hub.feature_gate("quiet_snooze", question):
                return _text("The user said no. Nothing changed.", error=True)
            return _text(self.snooze(minutes))

        return [snooze_heads_ups]


LABELS = {"snooze_heads_ups": "Snoozed heads-ups"}
PROMPT = (
    "\n- Quiet hours follow the user's Focus mode and their weekend hours by themselves. "
    "snooze_heads_ups pauses heads-ups for a while ('snooze everything until 3') or turns "
    "them back on."
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out
