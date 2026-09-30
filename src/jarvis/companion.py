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
import time
from collections.abc import Callable
from datetime import datetime
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
}


class Saver:
    """Saves a store's file off the event loop, one save at a time: a burst of changes is
    one save, of the state after the last of them. With no event loop running (a test
    calling in directly), it saves at once."""

    def __init__(self, path: Path, snapshot: Callable[[], Any], name: str) -> None:
        self.path = path
        self.snapshot = snapshot
        self.name = name
        self._task: asyncio.Task | None = None
        self._again = False
        self.error = ""

    def soon(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._write(self.snapshot())
            return
        if self._task is not None and not self._task.done():
            self._again = True
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        while True:
            self._again = False
            data = self.snapshot()  # taken here, on the loop: never read mid-change
            await asyncio.to_thread(self._write, data)
            if not self._again:
                return

    def _write(self, data: Any) -> None:
        try:
            jsonstore.save_json(self.path, data)
            self.error = ""
        except OSError as exc:  # a full disk: kept in memory, saved with the next change
            if not self.error:
                log.warning("companion: couldn't save %s (%s)", self.name, exc)
            self.error = exc.strerror or str(exc)

    async def flush(self) -> None:
        while self._task is not None and not self._task.done():
            await asyncio.shield(self._task)


class AuditLog:
    """What each phone did, newest last: when, which device, what kind of action and a
    short detail of the app's own words (a routine's name, a session's number), never
    what was asked or said."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._items: list[dict[str, str]] | None = None
        self.saver = Saver(path, lambda: list(self.items), "the phone log")

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
    from .push import valid_token

    out: dict[str, dict[str, Any]] = {}
    for key, item in raw.items() if isinstance(raw, dict) else []:
        if not (isinstance(key, str) and isinstance(item, dict)):
            continue
        kind, _, ident = key.partition(":")
        token, at = item.get("token"), item.get("at")
        if kind in LIVE_KINDS and ident and valid_token(token):
            if isinstance(at, (int, float)) and not isinstance(at, bool):
                out[key] = {"token": token, "at": float(at)}
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

    def follow(self, device_id: str, activity: str, token: str, now: float) -> None:
        live = self.device(device_id)["live"]
        live.pop(activity, None)
        live[activity] = {"token": token, "at": now}
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

    # ── remote.py's hooks ──

    def routes(self, gate: Any) -> list[Any]:
        """The rest of the API (companion_api)."""
        from . import companion_api

        return companion_api.routes(self, gate)

    async def state(self, device: Any) -> dict[str, Any]:
        """More for /api/state."""
        record = self.store.known(device.id)
        return {
            "push": {
                "enabled": await self.keys.get() is not None,
                "registered": bool(record and record["push"]),
            },
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
