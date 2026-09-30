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


class Companion:
    """The companion's state and its hooks into remote.py and the window."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.audit = AuditLog(hub.feature_path("companion-audit.json"))

    # ── remote.py's hooks ──

    def routes(self, gate: Any) -> list[Any]:
        """More of the API: none yet beyond remote.py's own."""
        return []

    def state(self, device: Any) -> dict[str, Any]:
        """More for /api/state."""
        return {}

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
        remote = self.hub.remote
        public = remote.public()
        return {
            "running": public["running"],
            "tls": public["tls"],
            "plain_http": public["plain_http"],
            "host": f"{remote.host_name}.local" if remote.host_name else "",
            "devices": [self._device_status(d) for d in remote.devices.items],
            "audit": self.audit.recent(),
        }

    def _device_status(self, device: Any) -> dict[str, Any]:
        return {**device.public()}

    def emit_status(self) -> None:
        self.hub.emit("companion", **self.status())

    async def new_certificate(self) -> None:
        """A new certificate: every phone pairs again (Settings asks first)."""
        await self.hub.remote.new_identity()
        self.hub.emit("remote", **self.hub.remote.public())
        self.emit_status()

    # ── window commands ──

    async def command(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "companion":
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

    async def flush(self) -> None:
        """Every save that's due, done (tests; the app at quit)."""
        await self.audit.saver.flush()
