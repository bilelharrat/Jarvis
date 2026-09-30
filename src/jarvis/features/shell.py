"""The Mac app's shell, backend side (app/features/shell.js and web/features/shell.js are the
other two parts).

- "Pause heads-ups for an hour" in the menu bar: {"type": "shell_pause", "minutes": 60}
  keeps heads-ups from showing until then, as Heads-ups off in Settings would (a
  conversation held for the user, a call or a voicemail still shows); minutes 0 resumes.
- The app's settings kept with the others: whether JARVIS shows in the menu bar, and the
  global shortcuts for Talk (⌥Space) and What's this? (⌥⇧Space), as Electron accelerators
  (checked as app/features/shell-lib.js's checkAccelerator checks them).
- "Wake the Mac for my briefing and routines" in Settings: {"type": "shell_wake",
  "action": "status" | "set" | "clear"}. Status reads the schedule (pmset -g sched);
  set makes the Mac wake (or power on) every day 5 minutes before the briefing or the
  wake-up call, and clear takes the daily schedule away, each only on the owner's click
  and with their password in macOS's own prompt (osascript's "with administrator
  privileges"). Each answers with a "shell_wake" event.

Cost: no model calls.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import string
import time
from typing import Any

from .. import lang
from ..prefs import register_feature_pref

log = logging.getLogger(__name__)

PAUSE_KEY = "shell_pause_until"  # seconds since 1970 (0: not paused)
MENU_BAR_KEY = "shell_menu_bar"
ASK_SHORTCUT_KEY = "shell_shortcut_ask"
WHATS_THIS_SHORTCUT_KEY = "shell_shortcut_whats_this"
PAUSE_MAX_MINUTES = 12 * 60
# What shows even with heads-ups off (Hub.notify): a pause holds back what the switch would.
# (Hub.notify's own list: a timer, an alarm or a reminder the owner set, their routines.)
ALWAYS_SHOWN = (
    "meeting",
    "delegate",
    "call",
    "voicemail",
    "timer",
    "alarm",
    "reminder",
    "routine",
)


def _clean_until(value: Any) -> float | None:
    """When a pause ends: 0, or a time no further off than the longest pause (a hand edit
    can't silence heads-ups for good)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if not math.isfinite(value) or value < 0:
        return None
    if value > time.time() + PAUSE_MAX_MINUTES * 60 + 60:
        return None
    return value


_MODIFIERS = ("Command", "Control", "Alt", "Shift")  # in the one order accelerators are spelled
_FKEYS = {f"F{n}" for n in range(1, 25)}
_KEYS = (
    set(string.ascii_uppercase)
    | set(string.digits)
    | _FKEYS
    | {"Space", "Return", "Tab", "Backspace", "Delete", "Up", "Down", "Left", "Right"}
    | {"Home", "End", "PageUp", "PageDown", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"}
)
# macOS keeps these for itself (the app's RESERVED, in shell-lib.js).
RESERVED = {
    "Control+Space",
    "Command+Control+Space",
    "Command+Alt+Space",
    "Command+Tab",
    "Command+Shift+Tab",
    "Command+Shift+3",
    "Command+Shift+4",
    "Command+Shift+5",
    "Command+Control+Q",
    "Command+Shift+Q",
    "Control+Up",
    "Control+Down",
    "Control+Left",
    "Control+Right",
}


def clean_accelerator(value: Any) -> str | None:
    """A global shortcut as an Electron accelerator, spelled the one way ("Alt+Shift+Space"),
    or None: it needs ⌃ or ⌥, or ⌘ with another modifier (⌘ alone would take the key from
    every app), except a function key; and none of macOS's own."""
    if not isinstance(value, str) or not value or len(value) > 60:
        return None
    *mods, key = value.split("+")
    if key not in _KEYS or len(set(mods)) != len(mods) or any(m not in _MODIFIERS for m in mods):
        return None
    ordered = [m for m in _MODIFIERS if m in mods]
    accelerator = "+".join([*ordered, key])
    strong = "Control" in ordered or "Alt" in ordered or ("Command" in ordered and len(ordered) > 1)
    if (key not in _FKEYS and not strong) or accelerator in RESERVED:
        return None
    return accelerator


# How approval cards name the words of a jarvis:// link sent from the request box
# (hub.LINK_WORDS): someone else's words, read like outside content.
lang.add_texts({"a request a link wrote": "链接写下的请求"})

register_feature_pref(PAUSE_KEY, 0.0, _clean_until)
register_feature_pref(MENU_BAR_KEY, True)
register_feature_pref(ASK_SHORTCUT_KEY, "Alt+Space", clean_accelerator)
register_feature_pref(WHATS_THIS_SHORTCUT_KEY, "Alt+Shift+Space", clean_accelerator)


def paused(hub: Any) -> bool:
    # Cleaned again here: the settings file is read before feature modules register their
    # checks, so a hand-edited value reaches this as it was written.
    return time.time() < (_clean_until(hub.prefs.feature(PAUSE_KEY)) or 0.0)


def pause_heads_ups(hub: Any, msg: dict[str, Any]) -> None:
    try:
        minutes = int(msg.get("minutes", 60))
    except (TypeError, ValueError, OverflowError):
        return
    minutes = max(0, min(PAUSE_MAX_MINUTES, minutes))
    hub.set_feature_prefs({PAUSE_KEY: time.time() + minutes * 60 if minutes else 0.0})


# ── waking the Mac for the morning briefing ──

PMSET = "/usr/bin/pmset"
OSASCRIPT = "/usr/bin/osascript"
WAKE_LEAD_MINUTES = 5
PASSWORD_WAIT = 300  # seconds macOS's password prompt may stay up
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_REPEATING = re.compile(r"^\s*repeating power events", re.IGNORECASE)
_WAKE_ENTRY = re.compile(r"^(wakepoweron|wakeorpoweron|wake|poweron)\b", re.IGNORECASE)
_AT = re.compile(r"\bat\s+(\d{1,2}):(\d{2})\s*([AP]M)\b\s*(.*)$", re.IGNORECASE)
# The text of macOS's password prompt: why it's asking (in the user's language).
_PROMPTS = {
    "en": {
        "set": "J.A.R.V.I.S. wants to wake this Mac every day at {time}, {lead} minutes "
        "before your {what}.",
        "clear": "J.A.R.V.I.S. wants to stop waking this Mac every day.",
        "briefing": "morning briefing",
        "wake_call": "wake-up call",
    },
    "zh": {
        "set": "J.A.R.V.I.S. 想每天 {time} 唤醒这台 Mac，比{what}早 {lead} 分钟。",
        "clear": "J.A.R.V.I.S. 想停止每天唤醒这台 Mac。",
        "briefing": "晨间简报",
        "wake_call": "叫醒电话",
    },
}


def _minutes(hhmm: Any) -> int | None:
    match = _HHMM.match(hhmm) if isinstance(hhmm, str) else None
    return int(match.group(1)) * 60 + int(match.group(2)) if match else None


def wake_time(prefs: Any) -> tuple[str, str]:
    """When to wake the Mac ("HH:MM") and what for: 5 minutes before the earlier of the
    morning briefing and the wake-up call that are on (the briefing's time when neither
    is), so JARVIS is up and listening when it's time."""
    wanted = []
    if prefs.briefing_enabled:
        wanted.append((prefs.briefing_time, "briefing"))
    if prefs.wake_call:
        wanted.append((prefs.wake_call_time, "wake_call"))
    if not wanted:
        wanted.append((prefs.briefing_time, "briefing"))
    times = [(m, what) for t, what in wanted if (m := _minutes(t)) is not None]
    at, what = min(times) if times else (8 * 60, "briefing")
    at = (at - WAKE_LEAD_MINUTES) % (24 * 60)
    return f"{at // 60:02d}:{at % 60:02d}", what


def parse_schedule(text: str) -> dict[str, Any]:
    """pmset -g sched's repeating events: the daily wake (a wake or power-on: its line, its
    time in minutes, its days) and anything else repeating (a nightly shutdown, say)."""
    wake: dict[str, Any] | None = None
    others: list[str] = []
    inside = False
    for line in (text or "").splitlines()[:200]:
        if _REPEATING.match(line):
            inside = True
            continue
        if not inside or not line.strip():
            continue
        if not line[:1].isspace():  # the next section
            inside = False
            continue
        entry = " ".join(line.split())[:120]
        if wake is None and _WAKE_ENTRY.match(entry):
            at = _AT.search(entry)
            minutes = None
            if at:
                hour = int(at.group(1)) % 12 + (12 if at.group(3).upper() == "PM" else 0)
                minutes = hour * 60 + int(at.group(2))
            wake = {"entry": entry, "minutes": minutes, "days": at.group(4).strip() if at else ""}
        else:
            others.append(entry)
    return {"wake": wake, "others": others[:4]}


def _quoted(text: str) -> str:
    """Text as an AppleScript string literal."""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def admin_script(action: str, hhmm: str, prompt: str) -> str:
    """The AppleScript that runs pmset as root, after the owner's password in macOS's own
    prompt. Its command is only ever one of these two, the time checked: nothing else can
    get into it."""
    if action == "set":
        if _minutes(hhmm) is None:
            raise ValueError(f"not a time: {hhmm!r}")
        command = f"{PMSET} repeat wakeorpoweron MTWRFSU {hhmm}:00"
    elif action == "clear":
        command = f"{PMSET} repeat cancel"
    else:
        raise ValueError(f"not an action: {action!r}")
    return (
        f"do shell script {_quoted(command)} with prompt {_quoted(prompt)} "
        "with administrator privileges"
    )


def _pmset_here() -> bool:
    return os.path.exists(PMSET)


async def _run(*argv: str, timeout: float) -> tuple[int, str, str]:
    """A short helper process (pmset, osascript): its exit code and output. The tests put
    their own in its place: nothing here ever runs one for real there."""
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", "timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


class WakeDesk:
    """Settings' "Wake the Mac…" buttons: what's scheduled now (read-only), and the daily
    wake set or taken away, one change at a time, never without the owner's click and
    password. Each command runs in the background: the password prompt can stay up for
    minutes, and the window's other commands carry on meanwhile."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.busy = False
        self._tasks: set[asyncio.Task] = set()

    def command(self, msg: dict[str, Any]) -> None:
        action = msg.get("action")
        if action not in ("status", "set", "clear") or (self.busy and action != "status"):
            return
        if action != "status":
            self.busy = True  # at once: a second click can't start another prompt
        task = asyncio.get_running_loop().create_task(self._carry_out(action))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _carry_out(self, action: str) -> None:
        note = ""
        if action != "status":
            self._emit({"busy": True})
            try:
                note = await self._change(action)
            finally:
                self.busy = False
        await self._status(note)

    async def _change(self, action: str) -> str:
        if not _pmset_here():
            return "unavailable"
        hhmm, what = wake_time(self.hub.prefs)
        words = _PROMPTS.get(self.hub.prefs.language, _PROMPTS["en"])
        prompt = words[action].format(time=hhmm, lead=WAKE_LEAD_MINUTES, what=words[what])
        code, _out, err = await _run(
            OSASCRIPT, "-e", admin_script(action, hhmm, prompt), timeout=PASSWORD_WAIT
        )
        if code == 0:
            log.info("wake schedule: %s", action)
            return ""
        if "-128" in err:  # the owner pressed Cancel
            return "cancelled"
        log.warning("wake schedule: %s failed: %s", action, err.strip()[:200])
        return "failed"

    async def _status(self, note: str = "") -> None:
        schedule: dict[str, Any] = {"wake": None, "others": []}
        if _pmset_here():
            code, out, _err = await _run(PMSET, "-g", "sched", timeout=15)
            if code == 0:
                schedule = parse_schedule(out)
            elif not note:
                note = "failed"
        elif not note:
            note = "unavailable"
        hhmm, what = wake_time(self.hub.prefs)
        wake = schedule["wake"]
        self._emit(
            {
                "time": hhmm,
                "reason": what,
                "scheduled": wake,
                "matches": bool(wake)
                and wake["minutes"] == _minutes(hhmm)
                and wake["days"] == "every day",
                "others": schedule["others"],
                "note": note,
            }
        )

    def _emit(self, fields: dict[str, Any]) -> None:
        self.hub.emit("shell_wake", **{"busy": self.busy, **fields})


def install(hub: Any) -> None:
    # What breaks through quiet hours (a VIP's urgent message, a severe weather warning)
    # breaks through a pause too: a pause is quiet hours.
    hub.add_notify_gate(
        lambda alert: (
            alert.kind in ALWAYS_SHOWN
            or getattr(alert, "breakthrough", False) is True
            or not paused(hub)
        )
    )
    hub.register_command("shell_pause", lambda msg: pause_heads_ups(hub, msg))
    hub.register_command("shell_wake", WakeDesk(hub).command)
