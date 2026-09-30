"""Timers, alarms and reminders, to the second: "set a timer for 12 minutes", "wake me at
6:30", "remind me every 20 minutes to stretch until 6pm", "what timers do I have?",
"cancel the pasta timer", "snooze".

A timer counts down from when it's set; an alarm goes off at a time of day; a reminder says
its words at a time, once or again every N minutes until a time. Each is said and shown as
a card (the automation feature hands it to hub.notify, so the phone and chats hear of it
too). A timer or an alarm rings (a sound every few seconds, for a minute at most) until it's
stopped or snoozed, and breaks through quiet hours: the owner set it. An alarm can also
ring the owner's phone, when they turned that on. A repeating reminder is a gentle card and
keeps to quiet hours.

One asyncio task waits for the next one to be due (asyncio's own timer, never a busy loop:
at most a minute's sleep at a time, so a Mac that slept is noticed), and every change wakes
it to look again. They're kept in timers.json beside the settings, so they survive a
restart: one that went off while JARVIS was closed is said as missed, and a repeating
reminder picks up at its next time instead of catching up.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore, lang
from .proactive import Alert
from .textclean import clean_text

log = logging.getLogger("jarvis")

KINDS = ("timer", "alarm", "reminder")
MAX_ITEMS = 50  # set at once: past that, one has to go first
MAX_TIMER = 24 * 3600  # seconds: longer than a day is an alarm or a routine
MIN_EVERY = 60  # a reminder repeats at most once a minute
MAX_EVERY = 24 * 3600
SNOOZE_MINUTES = 9
RING_SECONDS = {"timer": 30, "alarm": 60}  # rings this long at most, unless stopped
RING_EVERY = {"timer": 3.0, "alarm": 4.0}  # a sound this often while it rings
MISSED_SECONDS = 90  # later than this when it's noticed: said as missed, never rung
RECENT_SECONDS = 600  # one that rang this recently can still be snoozed
LONGEST_WAIT = 60.0  # the clock looks again at least this often (sleep, clock changes)
SOUNDS = {
    "timer": "/System/Library/Sounds/Glass.aiff",
    "alarm": "/System/Library/Sounds/Sosumi.aiff",
}
_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$")

# What JARVIS says, English and Chinese (registered with lang.ZH_TEXTS below; lang.tr fills
# them in, and a {time} slot is said the Chinese way).
ZH = {
    "Your {label} timer is done.": "你的{label}计时器时间到了。",
    "Your {minutes}-minute timer is done.": "你的{minutes}分钟计时器时间到了。",
    "Your {seconds}-second timer is done.": "你的{seconds}秒计时器时间到了。",
    "Your timer is done.": "计时器时间到了。",
    "It's {time}: {label}.": "现在是{time}：{label}。",
    "It's {time}.": "现在是{time}。",
    "Reminder: {label}.": "提醒：{label}。",
    "Your {label} timer went off at {time} while I was closed.": "你的{label}计时器在{time}响了，当时我没在运行。",
    "Your timer went off at {time} while I was closed.": "你的计时器在{time}响了，当时我没在运行。",
    "Your {time} alarm went off while I was closed: {label}.": "你{time}的闹钟响的时候我没在运行：{label}。",
    "Your {time} alarm went off while I was closed.": "你{time}的闹钟响的时候我没在运行。",
    "Timer": "计时器",
    "Alarm": "闹钟",
    "Reminder": "提醒",
}


def _register_zh() -> None:
    for english, chinese in ZH.items():
        lang.ZH_TEXTS.setdefault(english, chinese)


_register_zh()


def say(template: str, language: str = "en", **values: Any) -> str:
    return lang.tr(template, "zh" if lang.is_zh(language) else "en", **values)


def _clock(when: datetime) -> str:
    """7 AM, 6:30 AM, 6:30:15 AM: to the second only when it isn't on the minute."""
    if when.second:
        return when.strftime("%-I:%M:%S %p")
    return when.strftime("%-I:%M %p").replace(":00 ", " ")


def _clock_zh(when: datetime) -> str:
    """早上7点, 早上6:30, 早上6:30:15."""
    hour12 = when.hour % 12 or 12
    meridiem = "PM" if when.hour >= 12 else "AM"
    if not when.second:
        return lang.clock_zh(hour12, when.minute, meridiem, spoken=False)
    period = lang.clock_zh(hour12, 0, meridiem, spoken=False).removesuffix(f"{hour12}点")
    return f"{period}{hour12}:{when.minute:02d}:{when.second:02d}"


def clock(when: datetime, language: str = "en") -> str:
    return _clock_zh(when) if lang.is_zh(language) else _clock(when)


def _iso(when: datetime) -> str:
    return when.replace(microsecond=0).isoformat()


def _when(value: Any) -> datetime | None:
    try:
        when = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return None if when.tzinfo is not None else when


def span(seconds: float, language: str = "en") -> str:
    """4 minutes 12 seconds, 1 hour 5 minutes (2分钟12秒)."""
    total = max(0, round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if lang.is_zh(language):
        parts = [f"{hours}小时" if hours else "", f"{minutes}分钟" if minutes else ""]
        parts.append(f"{secs}秒" if secs or not (hours or minutes) else "")
        return "".join(parts)
    out = []
    for n, word in ((hours, "hour"), (minutes, "minute"), (secs, "second")):
        if n:
            out.append(f"{n} {word}{'s' if n != 1 else ''}")
    return " ".join(out[:2]) or "0 seconds"


# ── one timer ──


@dataclass
class Timer:
    id: str
    kind: str  # timer | alarm | reminder
    label: str  # the owner's words: "pasta", "leave for the airport", "stretch"
    due: str  # ISO, this Mac's time, to the second: when it goes off next
    created: str
    seconds: int = 0  # a timer's length as set ("your 12-minute timer")
    every: int = 0  # a repeating reminder: seconds between
    until: str = ""  # … and the time it stops repeating (ISO)
    phone: bool = False  # an alarm that may ring the owner's phone
    snoozed: int = 0

    @property
    def due_at(self) -> datetime:
        return datetime.fromisoformat(self.due)

    def public(self, now: datetime) -> dict[str, Any]:
        return {
            **asdict(self),
            "left": max(0, round((self.due_at - now).total_seconds())),
            "when": self.summary(now),
            "when_zh": self.summary(now, "zh"),
        }

    def summary(self, now: datetime, language: str = "en") -> str:
        """What Settings shows under its name: "Alarm · tomorrow 6:30 AM", "Every 20
        minutes until 6 PM · next 3:50 PM" (a timer's time left is counted by the window)."""
        zh = lang.is_zh(language)
        at = clock(self.due_at, language)
        days = (self.due_at.date() - now.date()).days
        if days == 1:
            at = f"明天{at}" if zh else f"tomorrow {at}"
        elif days > 1:
            day = (
                f"{self.due_at.month}月{self.due_at.day}日"
                if zh
                else self.due_at.strftime("%a %-d %b")
            )
            at = f"{day}{at}" if zh else f"{day}, {at}"
        if self.kind == "timer":
            if zh:
                return f"{span(self.seconds, language)}计时器" if self.seconds else "计时器"
            if self.seconds and self.seconds % 3600 == 0:
                return f"{self.seconds // 3600}-hour timer"
            if self.seconds and self.seconds % 60 == 0:
                return f"{self.seconds // 60}-minute timer"
            return f"Timer · {span(self.seconds)}" if self.seconds else "Timer"
        if self.kind == "alarm":
            return f"闹钟 · {at}" if zh else f"Alarm · {at}"
        if not self.every:
            return f"提醒 · {at}" if zh else f"Reminder · {at}"
        until = _when(self.until)
        if zh:
            end = f"，到{clock(until, language)}为止" if until else ""
            return f"每{span(self.every, language)}{end} · 下一次{at}"
        end = f" until {clock(until)}" if until else ""
        return f"Every {span(self.every)}{end} · next {at}"

    def describe(self, now: datetime, language: str = "en") -> str:
        """One line for list_timers: what, and when."""
        left = span((self.due_at - now).total_seconds(), language)
        if lang.is_zh(language):
            at = _clock_zh(self.due_at)
            if self.kind == "timer":
                return f"{self.label}计时器：还剩{left}（{self.id}）"
            if self.kind == "alarm":
                return f"闹钟 {at}{'：' + self.label if self.label else ''}（{self.id}）"
            repeat = ""
            if self.every:
                until = _when(self.until)
                repeat = f"，每{span(self.every, language)}" + (
                    f"，到{_clock_zh(until)}为止" if until else ""
                )
            return f"提醒：{self.label}{repeat}，下一次{at}（{self.id}）"
        at = _clock(self.due_at)
        if self.kind == "timer":
            if self.label:
                name = f"{self.label} timer"
            elif self.seconds >= 60 and not self.seconds % 60:
                name = f"{self.seconds // 60}-minute timer"
            else:
                name = "timer"
            return f"{name[:1].upper()}{name[1:]}: {left} left [{self.id}]"
        if self.kind == "alarm":
            return f"Alarm at {at}{': ' + self.label if self.label else ''} [{self.id}]"
        repeat = ""
        if self.every:
            until = _when(self.until)
            repeat = f", every {span(self.every)}" + (f" until {_clock(until)}" if until else "")
        return f"Reminder: {self.label}{repeat}, next at {at} [{self.id}]"


_FIELDS = frozenset(f.name for f in fields(Timer))


def _timer_from(raw: Any) -> Timer | None:
    """A timer from the file, or None for one that can't be used (it's kept in the file)."""
    try:
        timer = Timer(**{k: v for k, v in raw.items() if k in _FIELDS})
    except (AttributeError, TypeError):
        return None
    if not all(isinstance(v, str) for v in (timer.id, timer.kind, timer.label, timer.due)):
        return None
    if timer.kind not in KINDS or not timer.id or _when(timer.due) is None:
        return None
    timer.label = clean_text(timer.label).strip()[:120]
    timer.created = timer.created if isinstance(timer.created, str) else ""
    for name in ("seconds", "every", "snoozed"):
        value = getattr(timer, name)
        setattr(timer, name, value if type(value) is int and value >= 0 else 0)
    timer.until = timer.until if isinstance(timer.until, str) and _when(timer.until) else ""
    timer.phone = timer.phone is True
    return timer


class TimerStore:
    """timers.json. One that can't be read is left alone (nothing saved over it); a row
    that can't be used is kept in the file as it was."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.items: list[Timer] = []
        self.broken: list[Any] = []
        self.unreadable = ""
        try:
            data = jsonstore.load_json(path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            data = None
        for raw in data or []:
            timer = _timer_from(raw)
            if timer is not None:
                self.items.append(timer)
            elif jsonstore.shallow(raw):
                self.broken.append(raw)

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(t) for t in self.items] + self.broken)

    def add(self, timer: Timer) -> Timer:
        if len(self.items) >= MAX_ITEMS:
            raise ValueError(
                f"There are already {MAX_ITEMS} timers and reminders; cancel one first."
            )
        self.items.append(timer)
        try:
            self.save()
        except OSError:
            self.items.remove(timer)
            raise
        return timer

    def remove(self, timer: Timer) -> None:
        if timer in self.items:
            self.items.remove(timer)
            self.save()

    def find(self, key: str) -> list[Timer]:
        """The ones a word picks out: an id, else a label (exact, then containing it), else
        a kind ("the alarm"). Empty key: all of them."""
        key = " ".join(str(key or "").lower().split())
        key = re.sub(r"^(?:the|my|that|this)\s+", "", key)
        if not key:
            return list(self.items)
        exact = [t for t in self.items if t.id == key or t.label.lower() == key]
        if exact:
            return exact
        for kind in KINDS:
            if key in (kind, f"{kind}s"):
                return [t for t in self.items if t.kind == kind]
        words = re.sub(r"\s*\b(?:timers?|alarms?|reminders?)\b\s*", " ", key).strip()
        return [t for t in self.items if words and words in t.label.lower()]

    def next_due(self) -> datetime | None:
        return min((t.due_at for t in self.items), default=None)


# ── what the owner asks for, as a Timer ──


def new_timer(seconds: Any, label: str, now: datetime) -> Timer:
    try:
        seconds = int(float(seconds))
    except (TypeError, ValueError):
        raise ValueError("a timer needs its length in seconds") from None
    if not 1 <= seconds <= MAX_TIMER:
        raise ValueError("a timer runs from 1 second to 24 hours")
    label = clean_text(label or "").strip()[:120]
    return Timer(
        uuid.uuid4().hex[:6],
        "timer",
        label,
        _iso(now + timedelta(seconds=seconds)),
        _iso(now),
        seconds=seconds,
    )


def time_of_day(value: Any, now: datetime, day: str = "") -> datetime:
    """The next "6:30" (or "06:30:15") from now, or on a given day (YYYY-MM-DD)."""
    match = _HHMM.match(str(value or "").strip())
    if not match:
        raise ValueError("the time must be 24-hour HH:MM (or HH:MM:SS)")
    hour, minute, second = int(match.group(1)), int(match.group(2)), int(match.group(3) or 0)
    if day:
        try:
            base = datetime.fromisoformat(str(day))
        except ValueError:
            raise ValueError("the date must be YYYY-MM-DD") from None
        when = base.replace(hour=hour, minute=minute, second=second, microsecond=0)
        if when <= now:
            raise ValueError("that time has already passed")
        return when
    when = now.replace(hour=hour, minute=minute, second=second, microsecond=0)
    return when if when > now else when + timedelta(days=1)


def new_alarm(at: Any, label: str, now: datetime, day: str = "", phone: bool = False) -> Timer:
    when = time_of_day(at, now, day)
    if when - now > timedelta(days=366):
        raise ValueError("an alarm can be at most a year ahead")
    label = clean_text(label or "").strip()[:120]
    return Timer(uuid.uuid4().hex[:6], "alarm", label, _iso(when), _iso(now), phone=bool(phone))


def new_reminder(
    text: str,
    now: datetime,
    in_minutes: Any = None,
    at: Any = None,
    every_minutes: Any = None,
    until: Any = None,
) -> Timer:
    label = clean_text(text or "").strip()[:120]
    if not label:
        raise ValueError("a reminder needs what to remind you of")
    every = 0
    if every_minutes not in (None, "", 0):
        try:
            every = int(float(every_minutes) * 60)
        except (TypeError, ValueError):
            raise ValueError("every_minutes must be a number") from None
        if not MIN_EVERY <= every <= MAX_EVERY:
            raise ValueError("a reminder repeats every 1 minute to 24 hours")
    if at not in (None, ""):
        first = time_of_day(at, now)
    elif in_minutes not in (None, ""):
        try:
            first = now + timedelta(seconds=round(float(in_minutes) * 60))
        except (TypeError, ValueError):
            raise ValueError("in_minutes must be a number") from None
        if not now < first <= now + timedelta(days=366):
            raise ValueError("a reminder is at most a year ahead")
    elif every:
        first = now + timedelta(seconds=every)
    else:
        raise ValueError("say when: in_minutes, at (HH:MM), or every_minutes")
    end = ""
    if until not in (None, ""):
        if not every:
            raise ValueError("until is for a reminder that repeats")
        stop = time_of_day(until, now)
        if stop < first:
            raise ValueError("it would stop before it first reminds you")
        end = _iso(stop)
    return Timer(
        uuid.uuid4().hex[:6], "reminder", label, _iso(first), _iso(now), every=every, until=end
    )


# ── the clock ──


@dataclass
class Ring(Alert):
    """A timer's heads-up: breakthrough says it through quiet hours and meetings."""

    breakthrough: bool = False


Notify = Callable[[Alert, bool], Any]  # (alert, speak_if_busy)


def afplay(sound: str) -> None:
    """One sound, not waited for. Nothing to play (no such file, no afplay): nothing."""
    try:
        subprocess.Popen(["afplay", sound], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


class Timers:
    """The timers: the store (read on first use), the clock that fires them, and what's
    ringing now.

    notify(alert, speak_if_busy): a heads-up (hub.notify). play(sound): one sound. call(text):
    ring the owner's phone (an alarm, when phone_on() says they want that). stops(): the hub's
    stop count ("stop", a tap on the orb): a change silences what's ringing. on_change():
    tell the window. on_rang(timer): heard as each goes off. spawn(coro): run the ringing in
    the background (the hub's, so closing it stops them). now(): the clock (tests pass a
    fake)."""

    def __init__(
        self,
        path: Path,
        notify: Notify,
        *,
        now: Callable[[], datetime] = datetime.now,
        language: Callable[[], str] = lambda: "en",
        play: Callable[[str], Any] = afplay,
        call: Callable[[str], Awaitable[Any]] | None = None,
        phone_on: Callable[[], bool] = lambda: False,
        stops: Callable[[], int] = lambda: 0,
        on_change: Callable[[], Any] = lambda: None,
        on_rang: Callable[[Timer], Any] = lambda _t: None,
        spawn: Callable[[Any], asyncio.Task] | None = None,
    ) -> None:
        self.path = path
        self.notify = notify
        self.now = now
        self.language = language
        self.play = play
        self.call = call
        self.phone_on = phone_on
        self.stops = stops
        self.on_change = on_change
        self.on_rang = on_rang
        self.spawn = spawn or (lambda coro: asyncio.get_running_loop().create_task(coro))
        self._store: TimerStore | None = None
        self._wake = asyncio.Event()
        self.ringing: dict[str, tuple[Timer, asyncio.Task]] = {}
        self.recent: dict[str, tuple[Timer, datetime]] = {}  # rang lately: can be snoozed
        self._tasks: set[asyncio.Task] = set()

    @property
    def store(self) -> TimerStore:
        if self._store is None:
            self._store = TimerStore(self.path)
        return self._store

    def _changed(self) -> None:
        self._wake.set()
        try:
            self.on_change()
        except Exception:
            log.exception("timers: on_change failed")

    # ── changes ──

    def add(self, timer: Timer) -> Timer:
        self.store.add(timer)
        self._changed()
        return timer

    def cancel(self, timers: list[Timer]) -> list[Timer]:
        """Cancel these (and silence any of them ringing)."""
        gone = []
        for timer in timers:
            self._silence(timer.id)
            self.recent.pop(timer.id, None)
            if timer in self.store.items:
                self.store.items.remove(timer)
                gone.append(timer)
        if gone:
            self.store.save()
        self._changed()
        return gone

    def stop(self, key: str = "") -> list[Timer]:
        """Stop what's ringing (all of it, or the ones the key picks out)."""
        stopped = [t for t, _task in self.ringing.values() if not key or _picks(t, key)]
        for timer in stopped:
            self._silence(timer.id)
        if stopped:
            self._changed()
        return stopped

    def snooze(self, key: str = "", minutes: Any = SNOOZE_MINUTES) -> list[Timer]:
        """What's ringing (or rang in the last ten minutes) goes off again in a few minutes."""
        try:
            minutes = max(1, min(120, int(float(minutes or SNOOZE_MINUTES))))
        except (TypeError, ValueError):
            minutes = SNOOZE_MINUTES
        now = self.now()
        self._forget_old(now)
        candidates = [t for t, _task in self.ringing.values()]
        candidates += [t for t, _at in self.recent.values() if t.id not in self.ringing]
        chosen = [t for t in candidates if not key or _picks(t, key)]
        snoozed = []
        for timer in chosen:
            self._silence(timer.id)
            self.recent.pop(timer.id, None)
            timer.due = _iso(now + timedelta(minutes=minutes))
            timer.snoozed += 1
            if timer not in self.store.items:
                self.store.items.append(timer)
            snoozed.append(timer)
        if snoozed:
            self.store.save()
            self._changed()
        return snoozed

    def _forget_old(self, now: datetime) -> None:
        for key, (_timer, at) in list(self.recent.items()):
            if (now - at).total_seconds() > RECENT_SECONDS:
                del self.recent[key]

    # ── the clock ──

    async def run(self) -> None:
        """The loop (a feature loop): fire what's due, then wait for the next one, a change,
        or a minute, whichever comes first."""
        while True:
            try:
                self.fire_due(self.now())
                upcoming = self.store.next_due()
            except Exception:  # a bad row or a full disk never stops the clock
                log.exception("timers: check failed")
                upcoming = None
            wait = LONGEST_WAIT
            if upcoming is not None:
                wait = max(0.0, min(LONGEST_WAIT, (upcoming - self.now()).total_seconds()))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), wait)
            except TimeoutError:
                pass

    def fire_due(self, now: datetime) -> list[Timer]:
        """Every one due by now goes off: said, shown, rung; a repeating reminder moves on
        to its next time, the rest are done."""
        due = sorted(
            (t for t in self.store.items if t.due_at <= now + timedelta(milliseconds=50)),
            key=lambda t: t.due_at,
        )
        if not due:
            return []
        for timer in due:
            late = (now - timer.due_at).total_seconds() > MISSED_SECONDS
            if timer.kind == "reminder" and timer.every:
                self._advance(timer, now)
                if late:
                    continue  # missed while closed or asleep: it picks up at its next time
            else:
                self.store.items.remove(timer)
            self._fire(timer, now, late)
        try:
            self.store.save()
        except OSError as exc:
            log.warning("timers: couldn't save (%s)", exc)
        self._changed()
        return due

    def _advance(self, timer: Timer, now: datetime) -> None:
        step = timedelta(seconds=timer.every)
        nxt = timer.due_at + step
        if nxt <= now:  # skip what was missed: one reminder now, not a burst
            nxt += ((now - nxt) // step + 1) * step
        until = _when(timer.until)
        if until is not None and nxt > until:
            self.store.items.remove(timer)
        else:
            timer.due = _iso(nxt)

    def _fire(self, timer: Timer, now: datetime, late: bool) -> None:
        language = self.language()
        text = self._words(timer, late, language)
        titles = {"timer": "Timer", "alarm": "Alarm", "reminder": "Reminder"}
        title = say(titles[timer.kind], language)
        loud = timer.kind in ("timer", "alarm") and not late
        alert = Ring(
            f"{timer.kind}:{timer.id}:{now:%H%M%S}", timer.kind, title, text, breakthrough=loud
        )
        try:
            self.notify(alert, loud)
        except Exception:
            log.exception("timers: the heads-up failed")
        try:
            self.on_rang(timer)
        except Exception:
            log.exception("timers: on_rang failed")
        if not loud:
            return
        self.recent[timer.id] = (timer, now)
        task = self._start(self._ring(timer))
        if task is not None:
            self.ringing[timer.id] = (timer, task)
        if timer.kind == "alarm" and timer.phone and self.call is not None and self.phone_on():
            self._start(self._call(text))

    def _start(self, coro: Any) -> asyncio.Task | None:
        try:
            task = self.spawn(coro)
        except RuntimeError:  # no event loop (a sync caller): it's said and shown, not rung
            coro.close()
            return None
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _words(self, timer: Timer, late: bool, language: str) -> str:
        if timer.kind == "timer":
            if late:
                at = clock(timer.due_at, language)
                if timer.label:
                    return say(
                        "Your {label} timer went off at {time} while I was closed.",
                        language,
                        label=timer.label,
                        time=at,
                    )
                return say("Your timer went off at {time} while I was closed.", language, time=at)
            if timer.label:
                return say("Your {label} timer is done.", language, label=timer.label)
            if timer.seconds and timer.seconds % 60 == 0:
                return say(
                    "Your {minutes}-minute timer is done.", language, minutes=timer.seconds // 60
                )
            if timer.seconds and timer.seconds < 60:
                return say("Your {seconds}-second timer is done.", language, seconds=timer.seconds)
            return say("Your timer is done.", language)
        if timer.kind == "alarm":
            at = clock(timer.due_at, language)
            if late:
                if timer.label:
                    return say(
                        "Your {time} alarm went off while I was closed: {label}.",
                        language,
                        time=at,
                        label=timer.label,
                    )
                return say("Your {time} alarm went off while I was closed.", language, time=at)
            if timer.label:
                return say("It's {time}: {label}.", language, time=at, label=timer.label)
            return say("It's {time}.", language, time=at)
        return say("Reminder: {label}.", language, label=timer.label)

    async def _ring(self, timer: Timer) -> None:
        """A sound every few seconds until it's stopped, snoozed, or a minute has passed."""
        sound = SOUNDS.get(timer.kind, SOUNDS["timer"])
        every = RING_EVERY.get(timer.kind, 3.0)
        rounds = max(1, int(RING_SECONDS.get(timer.kind, 30) / every))
        stops = self.stops()
        try:
            for _ in range(rounds):
                if self.stops() != stops:
                    break  # "stop", or a tap on the orb
                try:
                    self.play(sound)
                except Exception:
                    log.exception("timers: couldn't play the sound")
                await asyncio.sleep(every)
        finally:
            entry = self.ringing.get(timer.id)
            if entry is not None and entry[1] is asyncio.current_task():
                del self.ringing[timer.id]
                self._changed()

    async def _call(self, text: str) -> None:
        try:
            await self.call(text)
        except Exception as exc:  # not set up, a limit, Twilio away: the alarm still rang here
            log.info("timers: couldn't ring the phone (%s)", type(exc).__name__)

    def _silence(self, key: str) -> None:
        entry = self.ringing.pop(key, None)
        if entry is not None:
            entry[1].cancel()

    def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()

    # ── what the window and the tools see ──

    def public(self) -> dict[str, Any]:
        """What Settings lists: what's set, soonest first, and what's ringing (a timer that
        went off is no longer set, but rings until it's stopped)."""
        now = self.now()
        ringing = [t for t, _task in self.ringing.values()]
        items = {t.id: t for t in [*ringing, *self.store.items]}.values()
        return {
            "items": [
                {**t.public(now), "ringing": t.id in self.ringing}
                for t in sorted(items, key=lambda t: t.due_at)
            ],
            "ringing": [t.id for t in ringing],
            "unreadable": self.store.unreadable,
        }

    def describe(self) -> str:
        now = self.now()
        language = self.language()
        items = sorted(self.store.items, key=lambda t: t.due_at)
        lines = [t.describe(now, language) for t in items]
        ringing = [t for t, _task in self.ringing.values()]
        if ringing:
            names = ", ".join(t.label or t.kind for t in ringing)
            lines.insert(0, f"Ringing now: {names}.")
        return "\n".join(lines) or "No timers, alarms or reminders."


def _picks(timer: Timer, key: str) -> bool:
    key = " ".join(str(key or "").lower().split())
    key = re.sub(r"^(?:the|my|that|this)\s+", "", key)
    if not key or key in (timer.kind, f"{timer.kind}s", timer.id):
        return True
    words = re.sub(r"\s*\b(?:timers?|alarms?|reminders?)\b\s*", " ", key).strip()
    return bool(words) and words in timer.label.lower()
