"""Routines that start on events instead of a clock: a calendar event starting or ending
(N minutes before or after it, matching its title), an email arriving from someone or about
something, a text from a contact, the battery running low or the Mac being plugged in or
unplugged, arriving at or leaving a place, the Mac waking or being unlocked, a Jarvis Code
session finishing. Email rules ("when an email from X arrives, do Y") are routines on the
mail trigger.

Where each comes from:
- the calendar: EventKit, looked at every few minutes, only while a routine waits on it;
- email and texts: the interrupter's own reading of Mail and Messages (interrupts.py hands
  every new one over, robots included); there's no second look at the databases;
- the battery: psutil, every half minute;
- places: the phone's arrive and leave (the hub event "phone_location" with event and
  region), else this Mac's own location with a coarse radius around the place;
- waking: the wall clock jumping ahead of the monotonic one while the Mac slept; unlocking:
  the login session's lock state (Quartz), polled every few seconds only while a routine
  waits on it;
- Jarvis Code: the hub's "task_finished" event.

Each trigger has a debounce (it doesn't fire again within N minutes) and a daily cap, and a
routine that fires during meeting notes waits for them to end. What someone else wrote (an
email, a text) goes to the routine's reader, never to the routine as it came.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore
from .jobs import Cause
from .textclean import clean_text

log = logging.getLogger("jarvis")

KIND = "event"  # the routine kind that runs on a trigger
TYPES = ("calendar", "mail", "text", "battery", "place", "wake", "session")
DEBOUNCE = {
    "calendar": 0,
    "mail": 5,
    "text": 5,
    "battery": 60,
    "place": 30,
    "wake": 30,
    "session": 5,
}
CAP = 20  # runs a day, unless the routine says otherwise
MAX_CAP = 200
MAX_DEBOUNCE = 24 * 60
CALENDAR_GRACE = timedelta(minutes=10)  # a calendar trigger missed by more than this is skipped
CALENDAR_EVERY = 300.0  # seconds between looks at the calendar
CALENDAR_HOURS = (2, 6)  # hours back and ahead it looks
BATTERY_EVERY = 30.0
SLEPT = 60.0  # the wall clock ran this much further than the monotonic one: the Mac slept
PHONE_FIRST = 2 * 3600  # while the phone reports places, the Mac's own location isn't used
RADIUS = 300  # meters around a place, by default
INBOX_KEPT = 200  # new messages waiting to be matched
DEFERRED_KEPT = 20  # runs waiting for meeting notes to end
FIRED_KEPT_DAYS = 2


# ── what a trigger is ──


def _words(value: Any, limit: int) -> str:
    return " ".join(clean_text(str(value or "")).split())[:limit]


def _int(value: Any, what: str, lo: int, hi: int, default: int) -> int:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError(f"{what} must be a number")
    try:
        number = int(float(str(value)))
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number") from None
    if not lo <= number <= hi:
        raise ValueError(f"{what} must be {lo} to {hi}")
    return number


def _float(value: Any, lo: float, hi: float) -> float | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and lo <= number <= hi else None


def clean_trigger(raw: Any) -> dict[str, Any]:
    """A trigger as kept; ValueError says what's wrong."""
    if not isinstance(raw, dict):
        raise ValueError("an event routine needs a trigger")
    kind = str(raw.get("type") or "").strip().lower()
    if kind not in TYPES:
        raise ValueError(f"the trigger type must be one of {', '.join(TYPES)}")
    if kind == "calendar":
        edge = str(raw.get("edge") or "start").strip().lower()
        if edge not in ("start", "end"):
            raise ValueError("a calendar trigger is on an event's start or end")
        minutes = _int(raw.get("minutes"), "minutes", -240, 240, 0)
        return {
            "type": kind,
            "edge": edge,
            "minutes": minutes,
            "title": _words(raw.get("title"), 80),
        }
    if kind == "mail":
        sender, subject = _words(raw.get("from"), 120), _words(raw.get("subject"), 120)
        if not (sender or subject):
            raise ValueError("an email trigger needs who it's from, or what its subject has")
        return {"type": kind, "from": sender, "subject": subject}
    if kind == "text":
        sender = _words(raw.get("from"), 120)
        if not sender:
            raise ValueError("a text trigger needs who it's from")
        return {"type": kind, "from": sender}
    if kind == "battery":
        state = str(raw.get("state") or "low").strip().lower()
        if state not in ("low", "charging", "unplugged"):
            raise ValueError("a battery trigger is low, charging or unplugged")
        out: dict[str, Any] = {"type": kind, "state": state}
        if state == "low":
            out["below"] = _int(raw.get("below"), "the battery level", 5, 95, 20)
        return out
    if kind == "place":
        event = str(raw.get("event") or "arrive").strip().lower()
        if event not in ("arrive", "leave"):
            raise ValueError("a place trigger is on arriving or leaving")
        place = _words(raw.get("place"), 60)
        lat, lon = _float(raw.get("lat"), -90, 90), _float(raw.get("lon"), -180, 180)
        if lat is None or lon is None:
            lat = lon = None
        if not place and lat is None:
            raise ValueError("a place trigger needs the place's name (home, work) or where it is")
        out = {
            "type": kind,
            "event": event,
            "place": place,
            "radius": _int(raw.get("radius"), "the radius", 100, 5000, RADIUS),
        }
        if lat is not None:
            out.update(lat=round(lat, 6), lon=round(lon, 6))
        return out
    if kind == "wake":
        what = str(raw.get("what") or "wake").strip().lower()
        if what not in ("wake", "unlock"):
            raise ValueError("a Mac trigger is on it waking or being unlocked")
        return {"type": kind, "what": what}
    status = str(raw.get("status") or "any").strip().lower()
    if status not in ("any", "done", "failed"):
        raise ValueError("a Jarvis Code trigger is on a session being done, failing, or either")
    return {"type": kind, "folder": _words(raw.get("folder"), 80), "status": status}


def clean_spec(raw: Any) -> dict[str, Any]:
    """An event routine's spec: {"trigger": {...}, "debounce": minutes, "cap": runs a day}."""
    if not isinstance(raw, dict):
        raise ValueError("an event routine needs a trigger")
    trigger = clean_trigger(raw.get("trigger"))
    debounce = _int(raw.get("debounce"), "the debounce", 0, MAX_DEBOUNCE, DEBOUNCE[trigger["type"]])
    cap = _int(raw.get("cap"), "the daily cap", 1, MAX_CAP, CAP)
    return {"trigger": trigger, "debounce": debounce, "cap": cap}


def describe(spec: dict[str, Any], lang: str = "en") -> str:
    """When it runs, in words: "when an email from Ann arrives", "10 minutes before
    “Standup” starts" (and the Chinese)."""
    t = spec.get("trigger") or {}
    zh = lang == "zh"
    kind = t.get("type")
    if kind == "calendar":
        title, minutes, edge = t.get("title"), t.get("minutes", 0), t.get("edge", "start")
        if zh:
            what = f"“{title}”" if title else "日程"
            verb = "开始" if edge == "start" else "结束"
            if minutes < 0:
                return f"{what}{verb}前{-minutes}分钟"
            return f"{what}{verb}后{minutes}分钟" if minutes else f"{what}{verb}时"
        what = f"“{title}”" if title else "an event"
        verb = "starts" if edge == "start" else "ends"
        if minutes < 0:
            return f"{-minutes} minutes before {what} {verb}"
        if minutes > 0:
            return f"{minutes} minutes after {what} {verb}"
        return f"when {what} {verb}"
    if kind == "mail":
        sender, subject = t.get("from"), t.get("subject")
        if zh:
            about = f"主题含“{subject}”的" if subject else ""
            return f"收到{sender or ''}{'的' if sender else ''}{about}邮件时"
        who = f" from {sender}" if sender else ""
        about = f" about “{subject}”" if subject else ""
        return f"when an email{who}{about} arrives"
    if kind == "text":
        return f"收到{t.get('from')}的短信时" if zh else f"when a text from {t.get('from')} arrives"
    if kind == "battery":
        state = t.get("state")
        if state == "low":
            below = t.get("below", 20)
            return f"电量低于百分之{below}时" if zh else f"when the battery drops below {below}%"
        if state == "charging":
            return "Mac 接上电源时" if zh else "when the Mac is plugged in"
        return "Mac 拔掉电源时" if zh else "when the Mac is unplugged"
    if kind == "place":
        place = t.get("place") or ("那里" if zh else "there")
        arrive = t.get("event") == "arrive"
        if zh:
            where = {"home": "家", "work": "公司"}.get(place.lower(), place)
            return f"到{where}时" if arrive else f"离开{where}时"
        if not arrive:
            return f"when you leave {place.lower() if place.lower() in ('home', 'work') else place}"
        if place.lower() == "home":
            return "when you get home"
        if place.lower() == "work":
            return "when you get to work"
        return f"when you arrive at {place}"
    if kind == "wake":
        if t.get("what") == "unlock":
            return "Mac 解锁时" if zh else "when the Mac is unlocked"
        return "Mac 唤醒时" if zh else "when the Mac wakes"
    if kind == "session":
        folder, status = t.get("folder"), t.get("status", "any")
        if zh:
            where = f"{folder}里的" if folder else ""
            end = {"done": "完成", "failed": "失败"}.get(status, "结束")
            return f"{where}Jarvis Code 会话{end}时"
        where = f" in {folder}" if folder else ""
        end = {"done": "finishes its work", "failed": "fails"}.get(status, "finishes")
        return f"when a Jarvis Code session{where} {end}"
    return ""


# ── matching ──


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def sender_matches(wanted: str, handle: str, contact: str) -> bool:
    """The owner's word for someone against a message's sender: their Contacts name or
    address (never the name an email's sender gave themselves), or the number's last
    digits."""
    wanted = wanted.casefold().strip()
    if not wanted:
        return True
    if wanted in (contact or "").casefold() or wanted in (handle or "").casefold():
        return True
    digits = _digits(wanted)
    return len(digits) >= 7 and _digits(handle).endswith(digits[-10:])


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Meters between two points on the Earth (haversine)."""
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def screen_locked() -> bool | None:
    """Whether the login session's screen is locked (None: can't tell)."""
    try:
        import Quartz

        info = Quartz.CGSessionCopyCurrentDictionary()
    except Exception:
        return None
    if info is None:
        return None
    return bool(info.get("CGSSessionScreenIsLocked", False))


def _clock(when: datetime) -> str:
    return when.strftime("%-I:%M %p").replace(":00 ", " ")


# ── the engine ──

Fire = Callable[[Any, Cause], Any]


class TriggerEngine:
    """Watches for each event routine's trigger and fires it (fire(routine, cause)) within
    its debounce and daily cap. Everything it looks at comes in as callables, so tests
    drive it with fakes and a fake clock.

    routines(): the routines. events(): the calendar around now (calendar_kit's shape).
    battery(): {"percent", "plugged"} or None. locked(): the screen's lock state or None.
    busy(): meeting notes running (a run waits). on_event(name, data): the script hooks
    hear arrive, leave, wake, unlock. unlock_wanted(): something besides a routine (a
    script hook) waits on unlocking, so the lock state is polled."""

    def __init__(
        self,
        routines: Callable[[], list[Any]],
        fire: Fire,
        state_path: Path,
        *,
        now: Callable[[], datetime] = datetime.now,
        events: Callable[[], Awaitable[list[dict[str, Any]]]] | None = None,
        battery: Callable[[], dict[str, Any] | None] = lambda: None,
        locked: Callable[[], bool | None] = lambda: None,
        busy: Callable[[], bool] = lambda: False,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
        on_event: Callable[[str, dict[str, Any]], Any] = lambda _n, _d: None,
        unlock_wanted: Callable[[], bool] = lambda: False,
    ) -> None:
        self.routines = routines
        self.fire = fire
        self.path = state_path
        self.now = now
        self.events_fn = events
        self.battery_fn = battery
        self.locked_fn = locked
        self.busy = busy
        self.wall, self.mono = wall, mono
        self.on_event = on_event
        self.unlock_wanted = unlock_wanted
        self._state: dict[str, Any] | None = None
        self._inbox: deque[dict[str, Any]] = deque(maxlen=INBOX_KEPT)
        self.deferred: list[tuple[str, Cause]] = []
        self._events: list[dict[str, Any]] = []
        self._events_at: float | None = None
        self._battery: dict[str, Any] | None = None
        self._battery_at: float | None = None
        self._locked: bool | None = None
        self._clocks: tuple[float, float] | None = None
        self._inside: dict[str, bool] = {}  # routine id -> the Mac inside its place
        self._phone_at = float("-inf")  # when the phone last reported arriving or leaving
        self._dirty = False

    # ── what it remembers: fired calendar keys, last fires, the day's counts ──

    @property
    def state(self) -> dict[str, Any]:
        if self._state is None:
            try:
                data = jsonstore.load_json(self.path, dict) or {}
            except jsonstore.Unreadable:
                data = {}
            fired = data.get("fired") if isinstance(data.get("fired"), dict) else {}
            last = data.get("last") if isinstance(data.get("last"), dict) else {}
            counts = data.get("counts") if isinstance(data.get("counts"), dict) else {}
            self._state = {
                "fired": {k: v for k, v in fired.items() if isinstance(v, str)},
                "last": {k: v for k, v in last.items() if isinstance(v, str)},
                "counts": {
                    k: v
                    for k, v in counts.items()
                    if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int)
                },
            }
        return self._state

    def save(self) -> None:
        if not self._dirty:
            return
        try:
            jsonstore.save_json(self.path, self.state)
            self._dirty = False
        except OSError as exc:
            log.info("triggers: couldn't save (%s)", exc)

    def _waiting(self, kind: str) -> list[tuple[Any, dict[str, Any]]]:
        """The enabled event routines waiting on this kind of trigger, with their trigger."""
        out = []
        for routine in self.routines():
            if routine.kind != KIND or not routine.enabled:
                continue
            trigger = (routine.spec or {}).get("trigger") or {}
            if trigger.get("type") == kind:
                out.append((routine, trigger))
        return out

    def _allowed(self, routine: Any, now: datetime) -> bool:
        """Within its debounce and its daily cap (and counted, when it is)."""
        state = self.state
        spec = routine.spec or {}
        last = state["last"].get(routine.id)
        debounce = int(spec.get("debounce", 0) or 0)
        if last and debounce:
            try:
                if now - datetime.fromisoformat(last) < timedelta(minutes=debounce):
                    return False
            except ValueError:
                pass
        day = now.date().isoformat()
        count = state["counts"].get(routine.id)
        used = count[1] if count and count[0] == day else 0
        if used >= int(spec.get("cap", CAP) or CAP):
            return False
        state["last"][routine.id] = now.isoformat(timespec="seconds")
        state["counts"][routine.id] = [day, used + 1]
        self._dirty = True
        return True

    def _go(self, routine: Any, cause: Cause, now: datetime) -> bool:
        if not self._allowed(routine, now):
            return False
        if self.busy():  # meeting notes: it runs when they end
            self.deferred.append((routine.id, cause))
            del self.deferred[:-DEFERRED_KEPT]
            return True
        try:
            self.fire(routine, cause)
        except Exception:
            log.exception("triggers: a routine couldn't start")
        return True

    # ── the clock's look, every few seconds ──

    async def tick(self, now: datetime | None = None) -> None:
        now = now or self.now()
        for check in (self._flush, self._messages, self._wake, self._unlock, self._battery_check):
            try:
                result = check(now)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                log.exception("triggers: a check failed")
        try:
            await self._calendar(now)
        except Exception:
            log.exception("triggers: the calendar check failed")
        self.save()

    def _flush(self, now: datetime) -> None:
        if not self.deferred or self.busy():
            return
        waiting, self.deferred = self.deferred, []
        by_id = {r.id: r for r in self.routines()}
        for routine_id, cause in waiting:
            routine = by_id.get(routine_id)
            if routine is not None and routine.enabled:
                self.fire(routine, cause)

    # ── email and texts, from the interrupter ──

    def on_messages(self, items: list[Any]) -> None:
        """interrupts.Interrupter's observer: every new text and email, as read (it runs
        under the interrupter's lock, so they're only noted here)."""
        for item in items:
            try:
                self._inbox.append(
                    {
                        "source": str(item.source),
                        "handle": str(item.handle or ""),
                        "contact": str(item.contact or ""),
                        "name": str(item.name or ""),
                        "text": str(item.text or ""),
                        "preview": str(getattr(item, "preview", "") or ""),
                        "group": getattr(item, "group", None),
                    }
                )
            except Exception:
                log.exception("triggers: couldn't note a message")

    def _messages(self, now: datetime) -> None:
        if not self._inbox:
            return
        items, self._inbox = list(self._inbox), deque(maxlen=INBOX_KEPT)
        mail = self._waiting("mail")
        texts = self._waiting("text")
        for item in items:
            if item["source"] == "mail":
                for routine, t in mail:
                    if not sender_matches(t.get("from", ""), item["handle"], item["contact"]):
                        continue
                    if t.get("subject") and t["subject"].casefold() not in item["text"].casefold():
                        continue
                    who = item["contact"] or item["handle"] or "someone"
                    self._go(
                        routine,
                        Cause(
                            "trigger",
                            f"Email from {who}",
                            content=f"From: {who}\nSubject: {item['text']}\n\n{item['preview']}",
                            source=f"an email from {who}",
                        ),
                        now,
                    )
            elif item["source"] == "message":
                for routine, t in texts:
                    if not sender_matches(t.get("from", ""), item["handle"], item["contact"]):
                        continue
                    who = item["contact"] or item["handle"] or "someone"
                    self._go(
                        routine,
                        Cause(
                            "trigger",
                            f"Text from {who}",
                            content=item["text"],
                            source=f"a text from {who}",
                        ),
                        now,
                    )

    # ── the Mac: waking, unlocking, the battery ──

    def _wake(self, now: datetime) -> None:
        wall, mono = self.wall(), self.mono()
        before, self._clocks = self._clocks, (wall, mono)
        if before is None or (wall - before[0]) - (mono - before[1]) < SLEPT:
            return
        self._mac_event("wake", "The Mac woke up", now)

    async def _unlock(self, now: datetime) -> None:
        routine = any(t.get("what") == "unlock" for _r, t in self._waiting("wake"))
        if not routine and not self.unlock_wanted():
            self._locked = None  # a fresh start when something waits on it again
            return
        locked = await asyncio.to_thread(self.locked_fn)
        before, self._locked = self._locked, locked
        if before is True and locked is False:
            self._mac_event("unlock", "The Mac was unlocked", now)

    def _mac_event(self, what: str, label: str, now: datetime) -> None:
        self._hook(what, {"at": now.isoformat(timespec="seconds")})
        for routine, t in self._waiting("wake"):
            if t.get("what") == what:
                self._go(routine, Cause("trigger", label), now)

    def _battery_check(self, now: datetime) -> None:
        stamp = self.mono()
        if self._battery_at is not None and stamp - self._battery_at < BATTERY_EVERY:
            return
        self._battery_at = stamp
        info = self.battery_fn()
        before, self._battery = self._battery, info
        if not info or not before:
            return  # the first reading only sets where things stand
        pct, plugged = info.get("percent", 100), bool(info.get("plugged"))
        was_pct, was_plugged = before.get("percent", 100), bool(before.get("plugged"))
        for routine, t in self._waiting("battery"):
            state = t.get("state")
            if state == "charging" and plugged and not was_plugged:
                self._go(routine, Cause("trigger", "The Mac was plugged in"), now)
            elif state == "unplugged" and was_plugged and not plugged:
                self._go(routine, Cause("trigger", "The Mac was unplugged"), now)
            elif state == "low":
                below = t.get("below", 20)
                crossed = pct <= below and not plugged and (was_pct > below or was_plugged)
                if crossed:
                    self._go(routine, Cause("trigger", f"The battery is at {pct}%"), now)

    # ── the calendar ──

    async def _calendar(self, now: datetime) -> None:
        waiting = self._waiting("calendar")
        if not waiting or self.events_fn is None:
            return
        stamp = self.mono()
        if self._events_at is None or stamp - self._events_at >= CALENDAR_EVERY:
            self._events_at = stamp
            try:
                self._events = await self.events_fn()
            except Exception as exc:  # no calendar access yet
                log.info("triggers: no calendar (%s)", type(exc).__name__)
                self._events = []
        fired = self.state["fired"]
        for routine, t in waiting:
            for event in self._events:
                if event.get("all_day"):
                    continue
                title = str(event.get("title") or "")
                if t.get("title") and t["title"].casefold() not in title.casefold():
                    continue
                edge = event.get("begin") if t.get("edge") == "start" else event.get("end")
                if not isinstance(edge, datetime):
                    continue
                if edge.tzinfo is not None:
                    edge = edge.astimezone().replace(tzinfo=None)
                at = edge + timedelta(minutes=t.get("minutes", 0))
                if not at <= now < at + CALENDAR_GRACE:
                    continue
                key = f"{routine.id}:{event.get('id') or title}:{t.get('edge')}:{edge:%Y%m%d%H%M}"
                if key in fired:
                    continue
                fired[key] = now.isoformat(timespec="seconds")
                self._dirty = True
                verb = "starts" if t.get("edge") == "start" else "ends"
                self._go(
                    routine,
                    Cause(
                        "trigger",
                        f"“{title}” {verb}",
                        context=f"“{title}” {verb} at {_clock(edge)}",
                    ),
                    now,
                )
        cutoff = (now - timedelta(days=FIRED_KEPT_DAYS)).isoformat()
        for key in [k for k, v in fired.items() if v < cutoff]:
            del fired[key]
            self._dirty = True

    # ── places ──

    def on_phone_location(self, data: dict[str, Any], now: datetime | None = None) -> None:
        """The phone's report (the hub event "phone_location"): arriving at or leaving a
        region it watches ("home", "work"), with where it is."""
        now = now or self.now()
        event = str(data.get("event") or "").lower()
        if event not in ("arrive", "leave"):
            return
        self._phone_at = self.mono()
        region = str(data.get("region") or "").strip()
        lat, lon = _float(data.get("lat"), -90, 90), _float(data.get("lon"), -180, 180)
        self._hook(
            event,
            {
                "place": region,
                "lat": lat,
                "lon": lon,
                "source": "phone",
                "at": now.isoformat(timespec="seconds"),
            },
        )
        for routine, t in self._waiting("place"):
            if t.get("event") != event:
                continue
            named = bool(region) and region.casefold() == str(t.get("place") or "").casefold()
            near = (
                lat is not None
                and lon is not None
                and "lat" in t
                and distance_m(lat, lon, t["lat"], t["lon"]) <= t.get("radius", RADIUS)
            )
            if named or near:
                self._go(routine, Cause("trigger", self._place_label(event, t)), now)

    def on_mac_location(self, fix: dict[str, Any] | None, now: datetime | None = None) -> None:
        """This Mac's own location (the hub event "location"): arriving or leaving a place
        with coordinates, by a coarse radius, while the phone isn't reporting places."""
        now = now or self.now()
        if not fix or self.mono() - self._phone_at < PHONE_FIRST:
            return
        lat, lon = _float(fix.get("lat"), -90, 90), _float(fix.get("lon"), -180, 180)
        if lat is None or lon is None:
            return
        for routine, t in self._waiting("place"):
            if "lat" not in t:
                continue
            inside = distance_m(lat, lon, t["lat"], t["lon"]) <= t.get("radius", RADIUS)
            before = self._inside.get(routine.id)
            self._inside[routine.id] = inside
            if before is None or before == inside:
                continue  # the first fix only says where the Mac is
            event = "arrive" if inside else "leave"
            if t.get("event") == event:
                self._hook(
                    event,
                    {
                        "place": t.get("place", ""),
                        "lat": lat,
                        "lon": lon,
                        "source": "mac",
                        "at": now.isoformat(timespec="seconds"),
                    },
                )
                self._go(routine, Cause("trigger", self._place_label(event, t)), now)

    @staticmethod
    def _place_label(event: str, trigger: dict[str, Any]) -> str:
        place = trigger.get("place") or "the place"
        return f"Arrived at {place}" if event == "arrive" else f"Left {place}"

    # ── Jarvis Code ──

    def on_session(self, data: dict[str, Any], now: datetime | None = None) -> None:
        """The hub's "task_finished": a Jarvis Code session done or failed (never one the
        owner stopped)."""
        now = now or self.now()
        if data.get("task_kind") != "code" or data.get("status") not in ("done", "failed"):
            return
        folder = str(data.get("folder") or "")
        status = str(data.get("status"))
        for routine, t in self._waiting("session"):
            if t.get("folder") and t["folder"].casefold() != folder.casefold():
                continue
            if t.get("status", "any") not in ("any", status):
                continue
            said = " ".join(str(data.get("result") or "").split())[:300]
            verb = "finished" if status == "done" else "failed"
            context = f"Jarvis Code session {data.get('id')} in {folder} {verb}."
            if said:
                context += f" Its last words: “{said}”"
            self._go(
                routine, Cause("trigger", f"Jarvis Code {verb} in {folder}", context=context), now
            )

    def _hook(self, name: str, data: dict[str, Any]) -> None:
        try:
            self.on_event(name, data)
        except Exception:
            log.exception("triggers: on_event failed")

    async def run(self, every: float = 5.0) -> None:
        """The loop (a feature loop): a look every few seconds."""
        while True:
            await self.tick()
            await asyncio.sleep(every)
