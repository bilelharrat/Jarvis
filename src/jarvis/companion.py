"""The phone companion beyond remote.py's core: what the iPhone and Watch app do with the
Mac, and what Settings shows of it.

remote.py serves the companion (HTTPS, pairing, the first few calls); this adds to it
through three hooks it calls: routes() for more of the API, state() for more of
/api/state, and record() for the log of what each phone did. The log keeps who did what
kind of thing and when, never the words of a request or a message.

Installed by jarvis.features.companion. Nothing here reads a file, starts a thread or
touches the network until a phone or the window asks for something.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import jsonstore

log = logging.getLogger("jarvis")

AUDIT_KEEP = 300  # phone actions kept in the log, newest last
AUDIT_SHOWN = 60  # ... shown in Settings
ACTIONS = {
    # what the log says for each kind of action (and Settings shows, in Chinese too)
    "paired": "Paired",
    "asked": "Asked Jarvis",
    "said_yes": "Said yes",
    "said_no": "Said no",
    "said_no_because": "Said no, with a reason",
    "answered": "Answered a question",
    "stop": "Stopped Jarvis",
    "briefing": "Asked for the briefing",
    "meeting_start": "Started meeting notes",
    "meeting_stop": "Stopped meeting notes",
    "routine_run": "Ran a routine",
    "push_on": "Turned on notifications",
    "push_off": "Turned off notifications",
    "code_sent": "Messaged Jarvis Code",
    "code_stopped": "Stopped a Jarvis Code step",
    "delegation_stopped": "Stopped a conversation",
    "routine_changed": "Changed a routine",
    "routine_deleted": "Deleted a routine",
    "shared": "Shared something",
    "photo": "Asked about a photo",
    "health": "Sent health data",
    "sensors": "Changed what the iPhone shares",
    "contacts_answered": "Looked someone up in the iPhone's contacts",
    "calendar_synced": "Sent the iPhone's calendar",
    "arrive_home": "Arrived home",
    "leave_home": "Left home",
    "arrive_work": "Arrived at work",
    "leave_work": "Left work",
    "live": "Followed something on the Lock Screen",
    "memory_added": "Added to memory",
    "memory_forgot": "Forgot something in memory",
    "timer_cancelled": "Cancelled a timer",
    "reminder_added": "Added a reminder",
    "reminder_done": "Completed a reminder",
    "task_stopped": "Stopped a background task",
    "music": "Controlled the music",
    "shortcut_run": "Ran a shortcut",
    "switch_set": "Flipped a Mac switch",
    "prefs_changed": "Changed settings",
}
WORDS = {
    "en": {"photo_question": "What's in this photo?"},
    "zh": {"photo_question": "这张照片里有什么？"},
}
PROMPT = (
    "\n- iPhone health: phone_health has the owner's recent sleep, steps and workouts from "
    "their iPhone, when its app sends them. In a morning briefing, call it and mention last "
    "night's sleep and yesterday's steps in one short sentence if there are any; otherwise "
    "only when asked."
    "\n- iPhone contacts: when find_contact finds no one by a name (or the owner says the "
    "person is in their phone), phone_contact looks the name up in the owner's iPhone "
    "contacts, if they turned that on there. It asks the phone, which may take a few seconds."
    "\n- iPhone calendar: phone_calendar has the owner's iPhone calendars for the next 14 "
    "days, if they turned that on there. Use it when the Mac's calendar has nothing or "
    "the owner says their calendar is on their phone; say which calendar it came from only "
    "when it matters."
)
LABELS = {
    "phone_health": "Checked your health from your iPhone",
    "phone_contact": "Looked someone up on your iPhone",
    "phone_calendar": "Checked your iPhone's calendar",
}


_NOTHING = object()


class Saver:
    """Saves a store's file off the event loop: the state is copied where it changed (on
    the loop), and written by a thread of its own, one save at a time; a burst of
    changes while one is being written is one more save, of the latest copy."""

    def __init__(self, path: Path, snapshot: Callable[[], Any], name: str) -> None:
        self.path = path
        self.snapshot = snapshot
        self.name = name
        self.error = ""
        self._lock = threading.Lock()
        self._pending: Any = _NOTHING
        self._busy = False
        self._idle = threading.Event()
        self._idle.set()

    def soon(self) -> None:
        data = self.snapshot()  # copied here: never read while it changes
        with self._lock:
            self._pending = data
            if self._busy:
                return
            self._busy = True
            self._idle.clear()
        threading.Thread(target=self._drain, name=f"save {self.path.name}", daemon=True).start()

    def _drain(self) -> None:
        while True:
            with self._lock:
                data, self._pending = self._pending, _NOTHING
                if data is _NOTHING:
                    self._busy = False
                    self._idle.set()
                    return
            self._write(data)

    def _write(self, data: Any) -> None:
        try:
            jsonstore.save_json(self.path, data)
            self.error = ""
        except OSError as exc:  # a full disk: kept in memory, saved with the next change
            if not self.error:
                log.warning("companion: couldn't save %s (%s)", self.name, exc)
            self.error = exc.strerror or str(exc)

    async def flush(self) -> None:
        await asyncio.to_thread(self._idle.wait, 30)


class AuditLog:
    """What each phone did, newest last: when, which device, what kind of action and a
    short detail of the app's own words (a routine's name, a session's number), never
    what was asked or said."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._items: list[dict[str, str]] | None = None
        self.saver = Saver(path, lambda: [dict(i) for i in self.items], "the phone log")

    @property
    def items(self) -> list[dict[str, str]]:
        if self._items is None:
            try:
                rows = jsonstore.load_json(self.path, list) or []
            except jsonstore.Unreadable:
                rows = []
            self._items = [
                {k: str(r.get(k, ""))[:200] for k in ("at", "device", "name", "action", "detail")}
                for r in rows[-AUDIT_KEEP:]
                if isinstance(r, dict) and isinstance(r.get("action"), str)
            ]
        return self._items

    def add(self, device_id: str, name: str, action: str, detail: str = "") -> None:
        items = self.items
        items.append(
            {
                "at": datetime.now().isoformat(timespec="seconds"),
                "device": device_id[:40],
                "name": " ".join(str(name).split())[:40],
                "action": action[:40],
                "detail": " ".join(str(detail).split())[:120],
            }
        )
        del items[:-AUDIT_KEEP]
        self.saver.soon()

    def recent(self, limit: int = AUDIT_SHOWN) -> list[dict[str, str]]:
        return [{**item, "label": ACTIONS.get(item["action"], "")} for item in self.items[-limit:]]


HEADSUP_MODES = ("urgent", "all", "off")
DEFAULT_SETTINGS: dict[str, Any] = {
    # what each phone is sent (Settings, per phone)
    "approvals": True,  # cards waiting on a yes, JARVIS's and Jarvis Code's
    "headsups": "urgent",  # heads-ups: urgent only, all, or off
    "code": True,  # Jarvis Code finished or stopped
    "delegations": True,  # a conversation JARVIS holds for the owner needs them
    "calls": True,  # how a call went; calls to the Jarvis number
}
LIVE_KINDS = ("code", "delegation", "call", "video")
LIVE_ACTIVITY = re.compile(r"(code|delegation|call|video):[A-Za-z0-9_-]{1,64}")
LIVE_PER_DEVICE = 8  # Live Activities one phone can follow at once
LIVE_HOURS = 12  # after this, a Live Activity's token is let go (iOS ends them by then)


def clean_settings(raw: Any) -> dict[str, Any]:
    """A phone's push settings, each one its default unless it's a value it can be."""
    raw = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULT_SETTINGS)
    for key, default in DEFAULT_SETTINGS.items():
        value = raw.get(key)
        if isinstance(default, bool) and isinstance(value, bool):
            out[key] = value
        elif key == "headsups" and value in HEADSUP_MODES:
            out[key] = value
    return out


def _clean_push(raw: Any) -> dict[str, str] | None:
    from .push import HOSTS, valid_bundle, valid_token

    if not isinstance(raw, dict):
        return None
    token, env, bundle = raw.get("token"), raw.get("environment"), raw.get("bundle_id")
    if not valid_token(token) or env not in HOSTS or not valid_bundle(bundle):
        return None
    at = raw.get("at") if isinstance(raw.get("at"), str) else ""
    return {"token": token, "environment": env, "bundle_id": bundle, "at": at[:40]}


def _clean_live(raw: Any) -> dict[str, dict[str, Any]]:
    from .push import HOSTS, valid_bundle, valid_token

    out: dict[str, dict[str, Any]] = {}
    for key, item in raw.items() if isinstance(raw, dict) else []:
        if not (isinstance(key, str) and isinstance(item, dict)):
            continue
        if not LIVE_ACTIVITY.fullmatch(key):
            continue
        token, at = item.get("token"), item.get("at")
        if valid_token(token) and isinstance(at, (int, float)) and not isinstance(at, bool):
            out[key] = {"token": token, "at": float(at)}
            if item.get("environment") in HOSTS:
                out[key]["environment"] = item["environment"]
            if valid_bundle(item.get("bundle_id")):
                out[key]["bundle_id"] = item["bundle_id"]
    return dict(list(out.items())[-LIVE_PER_DEVICE:])


class CompanionStore:
    """What the companion keeps per paired phone: its push token (and whether Apple takes
    it), what it wants pushed, and the Live Activities it follows. In companion.json
    beside prefs.json, readable by the owner alone; read when first needed, each record
    on its own (one that can't be used is left out, never a reason to fail)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._devices: dict[str, dict[str, Any]] | None = None
        self._extra: dict[str, Any] = {}  # the rest of the file (health days: companion_api)
        self.saver = Saver(path, self._snapshot, "the phone settings")

    def _load(self) -> dict[str, dict[str, Any]]:
        if self._devices is None:
            try:
                data = jsonstore.load_json(self.path, dict) or {}
            except jsonstore.Unreadable:
                data = {}
            devices: dict[str, dict[str, Any]] = {}
            raw = data.get("devices")
            for device_id, row in raw.items() if isinstance(raw, dict) else []:
                if isinstance(device_id, str) and isinstance(row, dict) and len(device_id) <= 40:
                    devices[device_id] = {
                        "push": _clean_push(row.get("push")),
                        "error": str(row.get("error") or "")[:120],
                        "settings": clean_settings(row.get("settings")),
                        "live": _clean_live(row.get("live")),
                    }
            self._devices = devices
            self._extra = {k: v for k, v in data.items() if k not in ("devices", "version")}
        return self._devices

    def _snapshot(self) -> dict[str, Any]:
        devices = self._load()
        return {
            "version": 1,
            **self._extra,
            "devices": {
                k: {**v, "live": dict(v["live"]), "settings": dict(v["settings"])}
                for k, v in devices.items()
            },
        }

    def device(self, device_id: str) -> dict[str, Any]:
        devices = self._load()
        if device_id not in devices:
            devices[device_id] = {
                "push": None,
                "error": "",
                "settings": dict(DEFAULT_SETTINGS),
                "live": {},
            }
        return devices[device_id]

    def known(self, device_id: str) -> dict[str, Any] | None:
        return self._load().get(device_id)

    def prune(self, paired: set[str]) -> None:
        """Forget what's kept for phones no longer paired."""
        devices = self._load()
        gone = [d for d in devices if d not in paired]
        for device_id in gone:
            del devices[device_id]
        if gone:
            self.saver.soon()

    def items(self) -> dict[str, dict[str, Any]]:
        return self._load()

    def extra(self, key: str) -> Any:
        self._load()
        return self._extra.get(key)

    def set_extra(self, key: str, value: Any) -> None:
        self._load()
        self._extra[key] = value
        self.saver.soon()

    # push tokens

    def register(self, device_id: str, token: str, environment: str, bundle_id: str) -> None:
        record = self.device(device_id)
        record["push"] = {
            "token": token,
            "environment": environment,
            "bundle_id": bundle_id,
            "at": datetime.now().isoformat(timespec="seconds"),
        }
        record["error"] = ""
        self.saver.soon()

    def unregister(self, device_id: str, why: str = "") -> None:
        record = self.known(device_id)
        if record is not None:
            record["push"], record["error"], record["live"] = None, why[:120], {}
            self.saver.soon()

    def set_settings(self, device_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        record = self.device(device_id)
        record["settings"] = clean_settings({**record["settings"], **changes})
        self.saver.soon()
        return record["settings"]

    # Live Activities

    def follow(self, device_id: str, activity: str, token: str, now: float, **where: str) -> None:
        """where: the app's environment and bundle ID, when it says (else its push
        registration's)."""
        live = self.device(device_id)["live"]
        live.pop(activity, None)
        live[activity] = {"token": token, "at": now, **{k: v for k, v in where.items() if v}}
        while len(live) > LIVE_PER_DEVICE:
            del live[next(iter(live))]
        self.saver.soon()

    def unfollow(self, device_id: str, activity: str) -> None:
        record = self.known(device_id)
        if record is not None and record["live"].pop(activity, None) is not None:
            self.saver.soon()

    def following(self) -> list[tuple[str, str, dict[str, Any]]]:
        """(device id, activity, its record) for every Live Activity followed."""
        return [
            (device_id, activity, item)
            for device_id, record in self._load().items()
            for activity, item in list(record["live"].items())
        ]


class Companion:
    """The companion's state and its hooks into remote.py and the window."""

    def __init__(
        self,
        hub: Any,
        *,
        run: Any = None,
        away: Callable[[], Any] | None = None,
    ) -> None:
        """run: how curl is run for a push (tests fake it); away: whether the owner has
        stepped away from the Mac (tests fake it)."""
        from . import push
        from .companion_push import Notifier, owner_away

        self.hub = hub
        self.audit = AuditLog(hub.feature_path("companion-audit.json"))
        self.store = CompanionStore(hub.feature_path("companion.json"))
        self.keys = push.Keys(hub.connectors.vault)
        self.sender = push.Sender(self.keys, run=run)
        self.notifier = Notifier(self, self.sender, away=away or owner_away)
        from .companion_live import Live

        self.live = Live(self, self.sender)
        from .companion_sensors import PhoneSensors

        self.sensors = PhoneSensors(self)  # the phone's contacts and calendar
        self.location: dict[str, Any] | None = None  # the phone's latest fix (memory only)
        self.inbox_folder: Path | None = None  # tests: somewhere of their own

    def inbox(self) -> Path:
        """Where what's shared from the phone is saved."""
        return self.inbox_folder or Path.home() / "Documents" / "Jarvis" / "Inbox"

    def words(self, key: str) -> str:
        from . import lang

        return WORDS["zh" if lang.is_zh(getattr(self.hub.prefs, "language", "en")) else "en"][key]

    # ── the phone's location and health ──

    def set_location(self, device: Any, fix: dict[str, Any]) -> None:
        """The phone's latest fix, heard by the hub (phone_location). Only a region's
        comings and goings go in the log, never where the phone was."""
        self.location = dict(fix)
        self.hub.emit("phone_location", **fix)
        if fix.get("event") and fix.get("region"):
            self.record(device, f"{fix['event']}_{fix['region']}")

    def phone_fix(self) -> dict[str, float] | None:
        """Where trips start (hub.travel_fixes): the phone's fix while it's fresh and
        close enough, else None and the Mac's own is used."""
        from .companion_api import FIX_ACCURACY, FIX_SECONDS

        fix = self.location
        if not fix or time.time() - fix["at"] > FIX_SECONDS:
            return None
        if fix.get("accuracy") is not None and fix["accuracy"] > FIX_ACCURACY:
            return None
        return {"lat": fix["lat"], "lon": fix["lon"]}

    def health_days(self, today: date | None = None) -> dict[str, dict[str, Any]]:
        """The phone's health days kept (the last two weeks), each read defensively."""
        from .companion_api import clean_health

        today = today or date.today()
        raw = self.store.extra("health")
        days: dict[str, dict[str, Any]] = {}
        for day, record in raw.items() if isinstance(raw, dict) else []:
            if isinstance(record, dict):
                clean = clean_health({**record, "day": day}, today)
                if isinstance(clean, dict):
                    days[clean["day"]] = clean
        return dict(sorted(days.items()))

    def set_health(self, day: dict[str, Any]) -> None:
        from .companion_api import HEALTH_DAYS

        days = self.health_days()
        days[day["day"]] = {**days.get(day["day"], {}), **day}
        cutoff = (date.today() - timedelta(days=HEALTH_DAYS)).isoformat()
        self.store.set_extra(
            "health",
            {k: {f: v for f, v in d.items() if f != "day"} for k, d in days.items() if k > cutoff},
        )

    def health_text(self, today: date | None = None) -> str:
        """The phone's health, for Claude: last night's sleep, yesterday's steps and the
        days before, as the app sent them (the owner's own data: private)."""
        today = today or date.today()
        days = self.health_days(today)
        this, before = today.isoformat(), (today - timedelta(days=1)).isoformat()
        recent = {k: v for k, v in days.items() if k in (this, before)}
        if not recent:
            return "Nothing recent from the iPhone's Health app (the J.A.R.V.I.S. app sends it when the owner allows it)."
        parts = []
        night = days.get(this, {}).get("sleep_hours")
        if night is None:
            night = days.get(before, {}).get("sleep_hours")
        if night is not None:
            parts.append(f"last night's sleep: {night:g} hours")
        steps = days.get(before, {}).get("steps")
        if steps is not None:
            parts.append(f"yesterday's steps: {steps:,}")
        if (today_steps := days.get(this, {}).get("steps")) is not None:
            parts.append(f"steps so far today: {today_steps:,}")
        heart = days.get(this, {}).get("resting_hr") or days.get(before, {}).get("resting_hr")
        if heart:
            parts.append(f"resting heart rate: {heart} bpm")
        workouts = days.get(before, {}).get("workouts") or []
        if workouts:
            parts.append(
                "yesterday's workouts: "
                + ", ".join(f"{w['kind']} {w['minutes']} min" for w in workouts[:5])
            )
        earlier = [
            f"{k}: "
            + ", ".join(
                f"{v[f]:,} steps" if f == "steps" else f"{v[f]:g} h sleep"
                for f in ("steps", "sleep_hours")
                if f in v
            )
            for k, v in list(days.items())[-7:]
            if k not in (this, before) and ("steps" in v or "sleep_hours" in v)
        ]
        text = (
            "From the owner's iPhone (Apple Health): " + ("; ".join(parts) or "no totals yet") + "."
        )
        if earlier:
            text += " Earlier: " + "; ".join(earlier) + "."
        return text

    def build_server(self) -> Any:
        from claude_agent_sdk import create_sdk_mcp_server, tool

        @tool(
            "phone_health",
            "The owner's recent health from their iPhone (Apple Health, sent by the "
            "J.A.R.V.I.S. app): last night's sleep, yesterday's steps, resting heart rate "
            "and workouts. For the morning briefing, and questions about their sleep or "
            "activity.",
            {},
        )
        async def phone_health(_args: dict[str, Any]) -> dict[str, Any]:
            return {"content": [{"type": "text", "text": self.health_text()}]}

        @tool(
            "phone_contact",
            "Look someone up in the owner's iPhone contacts (asks the J.A.R.V.I.S. app on "
            "the phone, when the owner turned contact lookups on there): name, job, "
            "organisation, phone numbers and emails. Use after find_contact found no one.",
            {"name": str},
        )
        async def phone_contact(args: dict[str, Any]) -> dict[str, Any]:
            text = await self.sensors.contact_text(str(args.get("name") or ""))
            return {"content": [{"type": "text", "text": text}]}

        @tool(
            "phone_calendar",
            "The owner's iPhone calendars (sent by the J.A.R.V.I.S. app when they turned "
            "that on there): events for the next `days` days (1-14, default 7). fresh: ask "
            "the phone for a new copy first.",
            {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "minimum": 1, "maximum": 14},
                    "fresh": {"type": "boolean"},
                },
            },
        )
        async def phone_calendar(args: dict[str, Any]) -> dict[str, Any]:
            days = args.get("days")
            days = days if isinstance(days, int) and not isinstance(days, bool) else 7
            text = await self.sensors.calendar_text(days, fresh=args.get("fresh") is True)
            return {"content": [{"type": "text", "text": text}]}

        return create_sdk_mcp_server(
            name="companion",
            version="0.1.0",
            tools=[phone_health, phone_contact, phone_calendar],
        )

    # ── remote.py's hooks ──

    def routes(self, gate: Any) -> list[Any]:
        """The rest of the API (companion_api)."""
        from . import companion_api

        return companion_api.routes(self, gate)

    async def state(self, device: Any) -> dict[str, Any]:
        """More for /api/state: the cards up (each saying whose it is), Jarvis Code's
        sessions, the conversations JARVIS holds, and whether push works for this phone."""
        from .companion_api import SESSIONS_SHOWN, public_approval, session_status
        from .companion_more import features

        approvals = [public_approval(card) for card in list(self.hub.approvals.values())]
        waiting = {a["task_id"] for a in approvals if a.get("task_id")}
        tasks = sorted(
            (t for t in self.hub.tasks.tasks.values() if t.kind == "code"), key=lambda t: -t.id
        )[:SESSIONS_SHOWN]
        record = self.store.known(device.id)
        return {
            "approvals": approvals,
            "pending_approvals": len(approvals),
            "code_sessions": [
                {
                    "id": t.id,
                    "title": " ".join((t.title or t.prompt).split())[:120],
                    "project": t.cwd.name,
                    "status": session_status(t, t.id in waiting),
                }
                for t in tasks
            ],
            "delegations_active": sum(1 for d in self.hub.delegations.items if d.is_open),
            "push": {
                "enabled": await self.keys.get() is not None,
                "registered": bool(record and record["push"]),
            },
            "features": features(self.hub),  # the /api/... groups this Mac answers
            "phone_asks": self.sensors.asks_for(device.id),  # contacts, calendar: on demand
        }

    def record(self, device: Any, action: str, detail: str = "") -> None:
        self.audit.add(device.id, device.name, action, detail)
        self.hub.emit("companion_audit", items=self.audit.recent())

    # ── pairing ──

    def pairing_url(self, code: str) -> str:
        """jarvis-pair://<host>:<port>?code=…&fp=…&name=…: the Mac's .local name (its
        address when it has none), the code, the certificate the phone pins, and the Mac's
        name for the phone to show."""
        from .remote import lan_address

        remote = self.hub.remote
        identity = remote.identity
        if identity is None:
            raise ValueError("the companion isn't on")
        host = f"{remote.host_name}.local" if remote.host_name else (lan_address() or "")
        if not host:
            raise ValueError("this Mac has no address on the network")
        name = quote(remote.mac_name or remote.host_name or "Mac", safe="")
        return (
            f"jarvis-pair://{host}:{remote.port}?code={code}&fp={identity.fingerprint}&name={name}"
        )

    async def pairing(self) -> dict[str, Any]:
        """The QR code for the pairing code on screen now."""
        from . import qr

        devices = self.hub.remote.devices
        left = devices.code_expires - time.monotonic()
        if devices.code is None or left <= 0 or not self.hub.remote.running:
            return {"error": "No pairing code is up. Pair a phone for a new one."}
        try:
            url = self.pairing_url(devices.code)
        except ValueError as exc:
            return {"error": f"No QR code: {exc}."}
        matrix = await asyncio.to_thread(qr.encode, url)
        identity = self.hub.remote.identity
        return {
            "qr": qr.rows(matrix),
            "short": identity.short if identity else "",
            "seconds": max(0, round(left)),
        }

    # ── Settings ──

    def status(self) -> dict[str, Any]:
        from .companion_push import WHEN_PREF

        remote = self.hub.remote
        public = remote.public()
        self.store.prune({d.id for d in remote.devices.items})
        return {
            "running": public["running"],
            "tls": public["tls"],
            "plain_http": public["plain_http"],
            "host": f"{remote.host_name}.local" if remote.host_name else "",
            "push": self.keys.status(),
            "push_when": self.hub.prefs.feature(WHEN_PREF),
            "devices": [self._device_status(d) for d in remote.devices.items],
            "audit": self.audit.recent(),
        }

    def _device_status(self, device: Any) -> dict[str, Any]:
        record = self.store.known(device.id) or {}
        registration = record.get("push")
        return {
            **device.public(),
            "push": {
                "registered": bool(registration),
                "environment": registration["environment"] if registration else "",
                "since": registration["at"] if registration else "",
                "error": record.get("error", ""),
            },
            "settings": dict(record.get("settings") or DEFAULT_SETTINGS),
        }

    def emit_status(self) -> None:
        self.hub.emit("companion", **self.status())

    async def new_certificate(self) -> None:
        """A new certificate: every phone pairs again (Settings asks first)."""
        await self.hub.remote.new_identity()
        self.hub.emit("remote", **self.hub.remote.public())
        self.emit_status()

    async def save_key(self, msg: dict[str, Any]) -> None:
        """The push key as pasted in Settings, checked and put in the Keychain. Never
        sent back to the window, never logged."""
        from . import push

        try:
            creds = push.check(
                msg.get("key"), msg.get("key_id"), msg.get("team_id"), msg.get("bundle_id")
            )
            await self.keys.save(creds)
        except push.KeyProblem as exc:
            self.hub.emit("companion_push", error=str(exc))
            return
        except Exception:  # the Keychain refused (locked): nothing changed
            log.warning("push: the key couldn't be saved in the Keychain")
            self.hub.emit(
                "companion_push",
                error="The Keychain didn't take the key. If it's locked, unlock it and try again.",
            )
            return
        self.hub.emit("companion_push", saved=True)
        self.emit_status()

    # ── window commands ──

    async def command(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "companion":
            await self.keys.get()  # read from the Keychain once, off the event loop
            self.emit_status()
        elif kind == "companion_pairing":
            self.hub.emit("companion_pairing", **await self.pairing())
        elif kind == "companion_new_certificate":
            try:
                await self.new_certificate()
            except OSError as exc:  # the folder can't be written: the old one stays
                self.hub.emit(
                    "error", text=f"Couldn't make a new certificate: {exc.strerror or exc}"
                )
        elif kind == "companion_push_key":
            await self.save_key(msg)
        elif kind == "companion_push_forget":
            try:
                await self.keys.forget()
            except Exception:
                log.warning("push: the key couldn't be removed from the Keychain")
            self.emit_status()
        elif kind == "companion_push_test":
            results = await self.notifier.test(only=str(msg.get("id") or ""))
            self.hub.emit("companion_push_test", results=results)
            self.emit_status()
        elif kind == "companion_device":
            device_id = str(msg.get("id") or "")
            changes = msg.get("settings")
            if isinstance(changes, dict) and any(
                d.id == device_id for d in self.hub.remote.devices.items
            ):
                self.store.set_settings(device_id, changes)
            self.emit_status()

    async def flush(self) -> None:
        """Every save that's due, done (tests; the app at quit)."""
        await self.audit.saver.flush()
        await self.store.saver.flush()
