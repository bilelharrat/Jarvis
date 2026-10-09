"""The iOS Simulator panel: a live picture of a booted simulator that you tap, swipe, type
into and press the buttons of, as in Claude's desktop app.

Two halves:

- Controller (in the hub): lists and boots devices, runs simctl for apps, links and the
  pasteboard, and runs one Bridge process for the device being watched. Frames go to the
  window with flow control: at most MAX_IN_FLIGHT unanswered, and a window that's behind
  gets the newest frame, never a backlog (its queue would otherwise grow to the 32 MB
  cut-off at 30 frames a second).
- Bridge (`python -m jarvis.simulator bridge <udid>`): its own process, because it loads
  Apple's private simulator frameworks and a crash in them must not take the hub down.
  - Frames: the device's framebuffer IOSurface (CoreSimulator's display port), encoded to
    JPEG by Core Image on the GPU, only when the surface changed (its seed moved). About
    3 ms a frame, where `simctl io screenshot` takes 1.2-1.6 s.
  - Touches, buttons and keys: Xcode 27's CoreSimulator hands the legacy Indigo HID
    services to dtuhidd inside the simulator (SimDeviceLegacyHIDClient's messages are
    accepted and dropped), so they go to dtuhidd over XPC as CoreDevice's Indigo*Event
    messages, the way Xcode's DeviceHub sends them.
  - Rotation: a GraphicsServices orientation event to the simulator's PurpleWorkspacePort.
    The framebuffer stays portrait; frames are turned upright here and touches turned
    back (display_to_device).

The window speaks in fractions of the picture it shows (0-1 from its top left), so
nothing in the page needs to know the device's size or which way up it is.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import re
import struct
import sys
import threading
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

Emit = Callable[..., None]
# (args, stdin text) -> (exit code, stdout). Injectable so tests never touch simctl.
Runner = Callable[..., Awaitable[tuple[int, bytes]]]

UDID = re.compile(r"^[0-9A-Fa-f-]{36}$")
BUNDLE_ID = re.compile(r"^[A-Za-z0-9.\-]{3,155}$")
URL = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:\S+$")

MAX_IN_FLIGHT = 2  # frames sent to the window and not yet acknowledged
ACK_GRACE = 3.0  # s: a frame unanswered this long counts as lost (the window dropped it)
FRAME_POLL = 1 / 60  # s between looks at the framebuffer's seed
IDLE_WAIT = 1.0  # s at most a bridge with nothing to stream sleeps (a stream or quit wakes it)
FRAME_SIDE = (120, 2400)  # the pixel box a window may ask frames to fit
DEFAULT_BOX = (600, 1300)
JPEG_QUALITY = 0.72
FALLBACK_EVERY = 1.0  # s between `simctl io screenshot` frames when the bridge can't run
TEXT_LIMIT = 4000  # characters one sim_type may carry
KEY_GAP = 0.012  # s between synthesized key events: dtuhidd keeps order, iOS keeps up
READY_TIMEOUT = 20.0  # s for a bridge to load the frameworks and find the device

DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer"
CORESIMULATOR = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework"

# ── dtuhidd's messages (CoreDeviceUtilities.HIDXPCServiceEvent) ──

HID_SERVICE = "com.apple.coredevice.feature.remote.hid.digitizer"  # one connection takes all kinds
FEATURE = {
    "IndigoDigitizerEvent": "com.apple.coredevice.feature.remote.hid.digitizer",
    "IndigoButtonEvent": "com.apple.coredevice.feature.remote.hid.button",
    "IndigoKeyboardButtonEvent": "com.apple.coredevice.feature.remote.hid.keyboard",
}
DOWN, UP = 1, 2  # CoreDevice.HIDButtonState
PHASES = {"down": 0, "move": 1, "up": 2}  # CoreDevice.DigitizerEventType: start, position, end
# CoreDevice.DigitizerEdge, found by trying each: a swipe up from the bottom goes home only
# with its edge set (the left or right one in landscape), and screen-edge pans need it too.
EDGE_NONE, EDGE_LEFT, EDGE_RIGHT, EDGE_BOTTOM, EDGE_TOP = 0, 1, 2, 3, 4
EDGE_BAND = 0.025  # a touch starting this near an edge (of its width or height) is an edge swipe
MAIN_SCREEN = 0  # CoreDevice.DigitizerTarget.mainScreen

CONSUMER_PAGE = 0x0C  # HID usage page of the hardware buttons
BUTTONS = {
    "home": 0x40,  # Menu: also "go home" on Face ID iPhones
    "lock": 0x30,  # Power: the side button
    "volume_up": 0xE9,
    "volume_down": 0xEA,
}

# HID keyboard usages (page 7) for a US layout: character -> (usage, shift).
_KEYS: dict[str, tuple[int, bool]] = {}
for _i, _c in enumerate("abcdefghijklmnopqrstuvwxyz"):
    _KEYS[_c] = (4 + _i, False)
    _KEYS[_c.upper()] = (4 + _i, True)
for _i, (_c, _s) in enumerate(zip("1234567890", "!@#$%^&*()", strict=True)):
    _KEYS[_c] = (30 + _i, False)
    _KEYS[_s] = (30 + _i, True)
for _usage, _c, _s in [
    (45, "-", "_"), (46, "=", "+"), (47, "[", "{"), (48, "]", "}"), (49, "\\", "|"),
    (51, ";", ":"), (52, "'", '"'), (53, "`", "~"), (54, ",", "<"), (55, ".", ">"), (56, "/", "?"),
]:  # fmt: skip
    _KEYS[_c] = (_usage, False)
    _KEYS[_s] = (_usage, True)
_KEYS.update({"\n": (40, False), "\t": (43, False), " ": (44, False)})
SHIFT, COMMAND = 225, 227  # left shift, left GUI
KEY_V = 25
KEY_USAGES = range(4, 232)  # letters to right GUI: what the window may send as a raw key

# UIDeviceOrientation: 1 portrait, 2 upside down, 3 landscape left (turned
# counterclockwise, home on the right), 4 landscape right.
TURN_LEFT = {1: 3, 3: 2, 2: 4, 4: 1}
TURN_RIGHT = {v: k for k, v in TURN_LEFT.items()}
ORIENTATION_EVENT = 50 | 0x20000  # GSEventTypeDeviceOrientationChanged, sent from the host
PURPLE_MESSAGE_ID = 0x7B  # GSSendEvent's msgh_id


class UInt(int):
    """An unsigned integer in an XPC message: dtuhidd decodes its fields as UInt."""


def button_message(name: str, state: int) -> dict[str, Any]:
    return _hid_event(
        "IndigoButtonEvent",
        {"usagePage": UInt(CONSUMER_PAGE), "usageCode": UInt(BUTTONS[name]), "state": UInt(state)},
    )


def key_message(usage: int, state: int) -> dict[str, Any]:
    return _hid_event("IndigoKeyboardButtonEvent", {"usageCode": UInt(usage), "state": UInt(state)})


def digitizer_message(
    phase: str,
    x: float,
    y: float,
    second: tuple[float, float] | None = None,
    edge: int = EDGE_NONE,
) -> dict[str, Any]:
    """A finger (or two, for a pinch) at fractions of the portrait framebuffer."""
    payload: dict[str, Any] = {
        "pointOne": {"x": _unit(x), "y": _unit(y)},
        "eventType": UInt(PHASES[phase]),
        "edge": UInt(edge if 0 <= edge <= 4 else EDGE_NONE),
        "target": UInt(MAIN_SCREEN),
    }
    if second is not None:
        payload["pointTwo"] = {"x": _unit(second[0]), "y": _unit(second[1])}
    return _hid_event("IndigoDigitizerEvent", payload)


def _hid_event(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"messageType": kind, "featureIdentifier": FEATURE[kind], "payload": payload}


def _unit(v: float) -> float:
    return min(1.0, max(0.0, float(v)))


def keys_for_text(text: str) -> list[tuple[int, bool]] | None:
    """The key presses that type `text` on a US hardware keyboard, or None when some
    character has no key (accents, emoji, Chinese): those go by the pasteboard."""
    keys = []
    for ch in text.replace("\r\n", "\n").replace("\r", "\n"):
        key = _KEYS.get(ch)
        if key is None:
            return None
        keys.append(key)
    return keys


def edge_for(x: float, y: float) -> int:
    """The framebuffer edge a touch at (x, y) starts on, if any. Bottom wins in a corner:
    it's the home gesture."""
    if y >= 1 - EDGE_BAND:
        return EDGE_BOTTOM
    if x <= EDGE_BAND:
        return EDGE_LEFT
    if x >= 1 - EDGE_BAND:
        return EDGE_RIGHT
    if y <= EDGE_BAND:
        return EDGE_TOP
    return EDGE_NONE


def display_to_device(x: float, y: float, orientation: int) -> tuple[float, float]:
    """A point on the upright picture (fractions from its top left) on the portrait
    framebuffer the digitizer speaks in."""
    x, y = _unit(x), _unit(y)
    if orientation == 3:  # the picture is the framebuffer turned 90° counterclockwise
        return 1 - y, x
    if orientation == 4:  # turned 90° clockwise
        return y, 1 - x
    if orientation == 2:
        return 1 - x, 1 - y
    return x, y


def orientation_message(port: int, orientation: int) -> bytes:
    """GraphicsServices' wire format for a device orientation event (GSSendEvent): the
    mach header, the event record (type at 0x18, info size at 0x48), then its info."""
    msg = bytearray(0x50)
    struct.pack_into("<IIIIII", msg, 0, 0x13, len(msg), port, 0, 0, PURPLE_MESSAGE_ID)
    struct.pack_into("<I", msg, 0x18, ORIENTATION_EVENT)
    struct.pack_into("<I", msg, 0x48, 4)
    struct.pack_into("<I", msg, 0x4C, orientation)
    return bytes(msg)


def parse_devices(raw: str | bytes) -> list[dict[str, Any]]:
    """`simctl list devices -j` -> the iPhones and iPads, booted first."""
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return []
    devices = []
    for runtime, items in (data.get("devices") or {}).items():
        name, _, version = runtime.rsplit(".", 1)[-1].partition("-")  # iOS-27-0
        os_name = f"{name} {version.replace('-', '.')}".strip()
        for d in items or []:
            if not d.get("isAvailable") or not UDID.match(str(d.get("udid", ""))):
                continue
            kind = f"{d.get('deviceTypeIdentifier', '')} {d.get('name', '')}"
            if "iPhone" in kind or "iPad" in kind:
                devices.append(
                    {
                        "udid": d["udid"],
                        "name": d["name"],
                        "state": d.get("state", ""),
                        "os": os_name,
                    }
                )
    devices.sort(key=lambda d: (d["state"] != "Booted", d["name"], d["os"]))
    return devices[:40]


# The system apps on a simulator's home screen. listapps also lists helpers (SpringBoard,
# AssistiveTouch, wallpaper posters) that don't mark themselves hidden.
SYSTEM_APPS = frozenset(
    {
        "com.apple.mobilesafari", "com.apple.Preferences", "com.apple.mobileslideshow",
        "com.apple.Maps", "com.apple.mobilecal", "com.apple.reminders", "com.apple.news",
        "com.apple.Health", "com.apple.Passbook", "com.apple.MobileSMS", "com.apple.shortcuts",
        "com.apple.MobileAddressBook", "com.apple.DocumentsApp", "com.apple.Fitness",
        "com.apple.Passwords", "com.apple.Bridge",
    }
)  # fmt: skip


def parse_apps(raw: bytes) -> list[dict[str, str]]:
    """`simctl listapps` (an old-style plist) converted to JSON -> the launchable apps,
    the user's own first."""
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        return []
    apps = []
    for bundle, info in (data or {}).items():
        if not isinstance(info, dict) or not BUNDLE_ID.match(str(bundle)):
            continue
        name = str(info.get("CFBundleDisplayName") or info.get("CFBundleName") or bundle)
        kind = str(info.get("ApplicationType", ""))
        if kind != "User" and bundle not in SYSTEM_APPS:
            continue
        apps.append({"bundle": bundle, "name": name[:80], "user": kind == "User"})
    apps.sort(key=lambda a: (not a["user"], a["name"].lower()))
    return apps[:200]


def screenshot_path(name: str, when: datetime | None = None, folder: Path | None = None) -> Path:
    """Where a screenshot goes, named as Simulator names them."""
    when = when or datetime.now()
    safe = re.sub(r"[/:\\]", "-", name).strip() or "Simulator"
    stamp = when.strftime("%Y-%m-%d at %H.%M.%S")
    return (folder or Path.home() / "Desktop") / f"Simulator Screenshot - {safe} - {stamp}.png"


# ── the bridge's pipe: records of one kind byte, a 4-byte length, then the payload ──

JSON_RECORD, FRAME_RECORD = b"j", b"f"


def encode_record(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack(">I", len(payload)) + payload


class RecordReader:
    """Splits the bridge's output into records, however the pipe chunks it."""

    MAX = 32 * 1024 * 1024

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[tuple[bytes, bytes]]:
        self._buf += data
        out = []
        while len(self._buf) >= 5:
            (size,) = struct.unpack(">I", self._buf[1:5])
            if size > self.MAX:
                raise ValueError("record too large")
            if len(self._buf) < 5 + size:
                break
            out.append((bytes(self._buf[:1]), bytes(self._buf[5 : 5 + size])))
            del self._buf[: 5 + size]
        return out


# ── the hub's half ──


async def _run(*args: str, stdin: bytes | None = None, timeout: float = 60) -> tuple[int, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return 127, b""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, b""
    return proc.returncode or 0, out


async def _spawn_bridge(udid: str) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "jarvis.simulator",
        "bridge",
        udid,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )


class Stream:
    """One watched device: its bridge process, and the frames on their way to the window.
    Without a bridge (no Xcode 27 frameworks, a crash) it falls back to a view-only
    picture from `simctl io screenshot`, about once a second."""

    def __init__(
        self,
        udid: str,
        name: str,
        emit: Emit,
        run: Runner,
        spawn: Callable[[str], Awaitable[Any]],
    ) -> None:
        self.udid, self.name, self.emit, self._run, self._spawn = udid, name, emit, run, spawn
        self.proc: Any = None
        self.live = False  # the bridge is up: input works
        self.info: dict[str, Any] = {}
        self.box = DEFAULT_BOX
        self.seq = 0  # the last frame sent to the window
        self.acked = 0
        self.sent_at = 0.0
        # The newest frame, held while the window is behind.
        self.pending: dict[str, Any] | None = None
        self.closed = False
        self._tasks: list[asyncio.Task] = []
        self._ready = asyncio.Event()
        self._shots: list[asyncio.Future] = []

    async def start(self, box: tuple[int, int]) -> None:
        self.box = box
        self._status("starting")
        try:
            self.proc = await self._spawn(self.udid)
        except Exception:  # no python, no module: the view-only picture still works
            log.warning("simulator bridge didn't start", exc_info=True)
            self.proc = None
        if self.proc is not None:
            self._tasks.append(asyncio.create_task(self._read()))
            # Upright first: the bridge can't read which way up the device is, so it says.
            self.command({"op": "orient", "orientation": 1})
            self.command({"op": "stream", "on": True, "box": list(box), "quality": JPEG_QUALITY})
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._ready.wait(), READY_TIMEOUT)
        if not self.live and not self.closed:
            self._fallback("The live view couldn't start; showing a picture a second instead.")

    def _status(self, state: str, message: str = "") -> None:
        self.emit(
            "sim_status",
            udid=self.udid,
            name=self.name,
            state=state,
            input=self.live,
            message=message,
            **{k: self.info[k] for k in ("points", "pixels", "scale", "family") if k in self.info},
        )

    def command(self, op: dict[str, Any]) -> bool:
        """A line for the bridge. False when there's no bridge to take it."""
        proc = self.proc
        if proc is None or proc.stdin is None or proc.returncode is not None or self.closed:
            return False
        try:
            proc.stdin.write(json.dumps(op).encode() + b"\n")
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return False
        return True

    async def _read(self) -> None:
        reader = RecordReader()
        stdout = self.proc.stdout
        try:
            while True:
                data = await stdout.read(256 * 1024)
                if not data:
                    break
                for kind, payload in reader.feed(data):
                    if kind == FRAME_RECORD:
                        self._on_frame(payload)
                    elif kind == JSON_RECORD:
                        self._on_json(json.loads(payload))
        except (ValueError, OSError):
            log.warning("simulator bridge sent something unreadable", exc_info=True)
        finally:
            was_live, self.live = self.live, False
            for fut in self._shots:
                if not fut.done():
                    fut.set_result({"ok": False})
            if not self.closed:
                if was_live:
                    self._fallback("The live view stopped (the simulator shut down?).")
                self._ready.set()

    def _on_json(self, ev: dict[str, Any]) -> None:
        kind = ev.get("event")
        if kind == "ready":
            self.info = {k: ev[k] for k in ("points", "pixels", "scale", "family") if k in ev}
            self.live = bool(ev.get("input", True))
            self._status("live" if self.live else "view-only", str(ev.get("message", "")))
            self._ready.set()
        elif kind == "error":
            log.warning("simulator bridge: %s", ev.get("message"))
            self._status("error", str(ev.get("message", "")))
        elif kind == "shot":
            if self._shots:
                fut = self._shots.pop(0)
                if not fut.done():
                    fut.set_result(ev)

    def _on_frame(self, payload: bytes) -> None:
        # A frame record: 8 bytes of width, height, orientation, then the JPEG.
        w, h, orientation = struct.unpack(">HHI", payload[:8])
        self.offer(
            {
                "udid": self.udid,
                "jpeg": base64.b64encode(payload[8:]).decode(),
                "width": w,
                "height": h,
                "orientation": orientation,
            }
        )

    def offer(self, frame: dict[str, Any]) -> None:
        """Send now if the window keeps up, else hold only the newest."""
        now = time.monotonic()
        if self.seq - self.acked >= MAX_IN_FLIGHT and now - self.sent_at < ACK_GRACE:
            self.pending = frame
            return
        if self.seq - self.acked >= MAX_IN_FLIGHT:  # unanswered too long: those were lost
            self.acked = self.seq
        self.pending = None
        self.seq += 1
        self.sent_at = now
        self.emit("sim_frame", seq=self.seq, **frame)

    def ack(self, seq: int) -> None:
        if self.acked < seq <= self.seq:
            self.acked = seq
        if self.pending is not None and self.seq - self.acked < MAX_IN_FLIGHT:
            self.offer(self.pending)

    def set_box(self, box: tuple[int, int]) -> None:
        self.box = box
        self.command({"op": "stream", "on": True, "box": list(box), "quality": JPEG_QUALITY})

    async def screenshot(self, path: Path) -> bool:
        if self.live:
            fut = asyncio.get_running_loop().create_future()
            self._shots.append(fut)
            if self.command({"op": "shot", "path": str(path)}):
                with contextlib.suppress(TimeoutError):
                    result = await asyncio.wait_for(fut, 15)
                    if result.get("ok"):
                        return True
            with contextlib.suppress(ValueError):
                self._shots.remove(fut)
        code, _ = await self._run(
            "xcrun", "simctl", "io", self.udid, "screenshot", "--type=png", str(path), timeout=30
        )
        return code == 0 and path.exists()

    def _fallback(self, message: str) -> None:
        if self.closed or any(t.get_name() == "sim-fallback" for t in self._tasks if not t.done()):
            return
        self.live = False
        self._status("view-only", message)
        self._tasks.append(asyncio.create_task(self._poll(), name="sim-fallback"))

    async def _poll(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "frame.jpg"
            while not self.closed:
                code, _ = await self._run(
                    "xcrun", "simctl", "io", self.udid, "screenshot", "--type=jpeg", str(path),
                    timeout=20,
                )  # fmt: skip
                if code == 0 and path.exists():
                    data = path.read_bytes()
                    size = _jpeg_size(data)
                    self.offer(
                        {
                            "udid": self.udid,
                            "jpeg": base64.b64encode(data).decode(),
                            "width": size[0],
                            "height": size[1],
                            "orientation": 1,
                        }
                    )
                await asyncio.sleep(FALLBACK_EVERY)

    async def stop(self) -> None:
        if self.closed:
            return
        self.closed = True
        proc = self.proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(Exception):
                proc.stdin.write(b'{"op": "quit"}\n')
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except (TimeoutError, Exception):
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                with contextlib.suppress(Exception):
                    await proc.wait()
        for task in self._tasks:
            task.cancel()
        self._status("stopped")


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """A JPEG's width and height from its SOF marker (0, 0 when there isn't one)."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return w, h
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        i += 2 + length
    return 0, 0


class Controller:
    """The window's sim_* commands. One device streams at a time; touches, keys and
    buttons go to that one. Slow work (simctl) runs in the background so a slow boot never
    holds up a tap."""

    def __init__(
        self,
        emit: Emit,
        run: Runner | None = None,
        spawn: Callable[[str], Awaitable[Any]] | None = None,
        shots: Path | None = None,
    ) -> None:
        self.emit = emit
        self._run = run or _run
        self._spawn = spawn or _spawn_bridge
        self._shots = shots
        self.stream: Stream | None = None
        self._tasks: set[asyncio.Task] = set()
        self._devices: list[dict[str, Any]] = []
        self._switching = asyncio.Lock()  # one device change at a time

    def _background(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def devices(self) -> list[dict[str, Any]]:
        _, out = await self._run("xcrun", "simctl", "list", "devices", "-j", timeout=20)
        self._devices = parse_devices(out)
        return self._devices

    async def handle(self, kind: str, msg: dict[str, Any]) -> bool:
        """True when this was a simulator command (handled, or refused as malformed)."""
        handler = getattr(self, f"_on_{kind}", None) if kind.startswith("sim_") else None
        if handler is None:
            return False
        result = handler(msg)
        if asyncio.iscoroutine(result):
            self._background(self._logged(kind, result))
        return True

    async def _logged(self, kind: str, coro: Awaitable[Any]) -> None:
        try:
            await coro
        except Exception:
            log.exception("simulator command %s failed", kind)
            self.emit("sim_error", message="That didn't work on the simulator.")

    # ── devices ──

    async def _on_sim_list(self, _msg: dict[str, Any]) -> None:
        self.emit("sim_list", devices=await self.devices())

    async def _on_sim_boot(self, msg: dict[str, Any]) -> None:
        udid = str(msg.get("udid", ""))
        if not UDID.match(udid):
            return
        code, _ = await self._run("xcrun", "simctl", "boot", udid, timeout=120)
        await self._run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=180)
        self.emit("sim_list", devices=await self.devices())
        if code not in (0, 149):  # 149: already booted
            self.emit("sim_error", message="The simulator didn't boot.")

    # ── the live view ──

    async def _on_sim_stream(self, msg: dict[str, Any]) -> None:
        """Watch a device (udid), or stop watching (no udid)."""
        async with self._switching:
            await self._switch(msg)

    async def _switch(self, msg: dict[str, Any]) -> None:
        udid = str(msg.get("udid") or "")
        box = _clamp_box(msg.get("width"), msg.get("height"))
        current = self.stream
        if current is not None and current.udid == udid and not current.closed:
            current.set_box(box)
            return
        self.stream = None
        if current is not None:
            await current.stop()
        if not UDID.match(udid):
            return
        known = {d["udid"]: d for d in self._devices} or {
            d["udid"]: d for d in await self.devices()
        }
        name = known.get(udid, {}).get("name", "Simulator")
        stream = Stream(udid, name, self.emit, self._run, self._spawn)
        self.stream = stream
        await stream.start(box)

    def _on_sim_ack(self, msg: dict[str, Any]) -> None:
        if self.stream is not None:
            with contextlib.suppress(TypeError, ValueError, OverflowError):  # (infinity too)
                self.stream.ack(int(msg.get("seq", 0)))

    def _live(self) -> Stream | None:
        stream = self.stream
        return stream if stream is not None and stream.live and not stream.closed else None

    def _on_sim_touch(self, msg: dict[str, Any]) -> None:
        stream = self._live()
        phase = msg.get("phase")
        if stream is None or phase not in PHASES:
            return
        try:
            op = {"op": "touch", "phase": phase, "x": float(msg["x"]), "y": float(msg["y"])}
            if msg.get("x2") is not None:
                op["x2"], op["y2"] = float(msg["x2"]), float(msg["y2"])
        except (KeyError, TypeError, ValueError):
            return
        edge = msg.get("edge")
        if isinstance(edge, int) and 0 <= edge <= 4:
            op["edge"] = edge
        stream.command(op)

    def _on_sim_button(self, msg: dict[str, Any]) -> None:
        stream = self._live()
        name = msg.get("name")
        if stream is None:
            return
        if name == "app_switcher":  # a double press of Home
            stream.command({"op": "button", "name": "home", "state": "press", "times": 2})
        elif name in BUTTONS:
            state = msg.get("state") if msg.get("state") in ("down", "up") else "press"
            stream.command({"op": "button", "name": name, "state": state})

    def _on_sim_key(self, msg: dict[str, Any]) -> None:
        stream = self._live()
        usage = msg.get("usage")
        if stream is None or not isinstance(usage, int) or usage not in KEY_USAGES:
            return
        stream.command({"op": "key", "usage": usage, "state": "down" if msg.get("down") else "up"})

    async def _on_sim_type(self, msg: dict[str, Any]) -> None:
        """Text for the focused field: typed key by key when a US keyboard has every
        character, otherwise through the pasteboard and ⌘V."""
        stream = self._live()
        text = str(msg.get("text", ""))[:TEXT_LIMIT]
        if stream is None or not text:
            return
        keys = keys_for_text(text)
        if keys is not None:
            stream.command({"op": "type", "keys": keys})
            return
        code, _ = await self._run(
            "xcrun", "simctl", "pbcopy", stream.udid, stdin=text.encode(), timeout=15
        )
        if code == 0:
            stream.command({"op": "paste"})

    def _on_sim_rotate(self, msg: dict[str, Any]) -> None:
        stream = self._live()
        if stream is not None and msg.get("dir") in ("left", "right"):
            stream.command({"op": "rotate", "dir": msg["dir"]})

    async def _on_sim_screenshot(self, _msg: dict[str, Any]) -> None:
        stream = self.stream
        if stream is None or stream.closed:
            return
        path = screenshot_path(stream.name, folder=self._shots)
        ok = await stream.screenshot(path)
        if ok:
            self.emit("sim_shot", udid=stream.udid, path=str(path), name=path.name)
        else:
            self.emit("sim_error", message="The screenshot didn't save.")

    # ── apps and links ──

    async def _on_sim_open_url(self, msg: dict[str, Any]) -> None:
        stream = self.stream
        url = str(msg.get("url", "")).strip()
        if stream is None or not URL.match(url) or len(url) > 4000:
            if url:
                self.emit("sim_error", message="That isn't a link.")
            return
        code, _ = await self._run("xcrun", "simctl", "openurl", stream.udid, url, timeout=30)
        if code != 0:
            self.emit("sim_error", message="The simulator couldn't open that link.")

    async def _on_sim_apps(self, _msg: dict[str, Any]) -> None:
        stream = self.stream
        if stream is None:
            return
        code, raw = await self._run("xcrun", "simctl", "listapps", stream.udid, timeout=30)
        if code != 0:
            self.emit("sim_apps", udid=stream.udid, apps=[])
            return
        _, converted = await self._run(
            "plutil", "-convert", "json", "-o", "-", "-", stdin=raw, timeout=15
        )
        self.emit("sim_apps", udid=stream.udid, apps=parse_apps(converted))

    async def _on_sim_launch(self, msg: dict[str, Any]) -> None:
        stream = self.stream
        bundle = str(msg.get("bundle", ""))
        if stream is None or not BUNDLE_ID.match(bundle):
            return
        code, _ = await self._run("xcrun", "simctl", "launch", stream.udid, bundle, timeout=60)
        if code != 0:
            self.emit("sim_error", message="That app didn't launch.")

    async def _on_sim_install(self, msg: dict[str, Any]) -> None:
        """A built .app (a folder) from the Mac onto the watched device."""
        stream = self.stream
        path = Path(str(msg.get("path", ""))).expanduser()
        if stream is None or path.suffix != ".app" or not path.is_dir():
            self.emit("sim_error", message="Pick a built .app to install.")
            return
        code, _ = await self._run("xcrun", "simctl", "install", stream.udid, str(path), timeout=300)
        if code != 0:
            self.emit("sim_error", message="The app didn't install.")
        else:
            self.emit("sim_installed", udid=stream.udid, name=path.stem)

    def stop(self) -> None:
        """The window went away: stop streaming (no one is watching)."""
        stream, self.stream = self.stream, None
        if stream is not None:
            self._background(stream.stop())

    async def close(self) -> None:
        stream, self.stream = self.stream, None
        if stream is not None:
            await stream.stop()


def _clamp_box(width: Any, height: Any) -> tuple[int, int]:
    """The pixel box frames are scaled to fit: the picture's size in the window. A side
    that isn't a number (null, words, a list, infinity) is the default one."""
    box = []
    for value, default in ((width, DEFAULT_BOX[0]), (height, DEFAULT_BOX[1])):
        try:
            side = int(value)
        except (TypeError, ValueError, OverflowError):
            side = default
        box.append(max(FRAME_SIDE[0], min(FRAME_SIDE[1], side)))
    return box[0], box[1]


# ── the bridge process (Apple's frameworks, loaded only here) ──


class _Xpc:
    """The few libxpc calls dtuhidd needs, through ctypes."""

    def __init__(self) -> None:
        import ctypes

        self.ct = ctypes
        lib = ctypes.CDLL("/usr/lib/system/libxpc.dylib")
        v = ctypes.c_void_p
        sigs = {
            "xpc_endpoint_create_mach_port_4sim": (v, [ctypes.c_uint32]),
            "xpc_connection_create_from_endpoint": (v, [v]),
            "xpc_connection_enable_sim2host_4sim": (None, [v]),
            "xpc_connection_set_event_handler": (None, [v, v]),
            "xpc_connection_resume": (None, [v]),
            "xpc_connection_cancel": (None, [v]),
            "xpc_connection_send_message": (None, [v, v]),
            "xpc_dictionary_create": (v, [v, v, ctypes.c_size_t]),
            "xpc_dictionary_set_value": (None, [v, ctypes.c_char_p, v]),
            "xpc_uint64_create": (v, [ctypes.c_uint64]),
            "xpc_int64_create": (v, [ctypes.c_int64]),
            "xpc_double_create": (v, [ctypes.c_double]),
            "xpc_string_create": (v, [ctypes.c_char_p]),
            "xpc_bool_create": (v, [ctypes.c_bool]),
            "xpc_release": (None, [v]),
        }
        for name, (restype, argtypes) in sigs.items():
            fn = getattr(lib, name)
            fn.restype, fn.argtypes = restype, argtypes
        self.lib = lib

    def value(self, v: Any) -> int:
        lib = self.lib
        if isinstance(v, dict):
            d = lib.xpc_dictionary_create(None, None, 0)
            for k, item in v.items():
                child = self.value(item)
                lib.xpc_dictionary_set_value(d, k.encode(), child)
                lib.xpc_release(child)
            return d
        if isinstance(v, bool):
            return lib.xpc_bool_create(v)
        if isinstance(v, UInt):
            return lib.xpc_uint64_create(int(v))
        if isinstance(v, int):
            return lib.xpc_int64_create(v)
        if isinstance(v, float):
            return lib.xpc_double_create(v)
        return lib.xpc_string_create(str(v).encode())


class _Hid:
    """One XPC connection to dtuhidd inside the simulator. Its services start with the
    connection and are gone when it closes, so the bridge keeps it for as long as it
    runs, and reconnects after an interruption (dtuhidd restarted)."""

    def __init__(self, device: Any) -> None:
        import ctypes

        self.device = device
        self.xpc = _Xpc()
        self.conn: int | None = None
        self.lock = threading.Lock()
        handler = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)

        class Descriptor(ctypes.Structure):
            _fields_ = [("reserved", ctypes.c_ulong), ("size", ctypes.c_ulong)]

        class Block(ctypes.Structure):
            _fields_ = [
                ("isa", ctypes.c_void_p),
                ("flags", ctypes.c_int),
                ("reserved", ctypes.c_int),
                ("invoke", handler),
                ("descriptor", ctypes.POINTER(Descriptor)),
            ]

        # A global block (never copied or freed) calling back into Python: libxpc wants a
        # block for connection events, and errors are all we need from them.
        self._invoke = handler(self._on_event)
        self._descriptor = Descriptor(0, ctypes.sizeof(Block))
        isa = ctypes.c_void_p.in_dll(ctypes.CDLL(None), "_NSConcreteGlobalBlock")
        self._block = Block(
            ctypes.addressof(isa), 1 << 28, 0, self._invoke, ctypes.pointer(self._descriptor)
        )

    def _on_event(self, _block: Any, event: Any) -> None:
        # Only errors arrive on a client connection: interrupted or invalid. Reconnect on
        # the next send.
        with self.lock:
            self.conn = None

    def connect(self) -> None:
        port = self.device.lookup_error_(HID_SERVICE, None)
        if not port:
            raise RuntimeError("dtuhidd isn't running in this simulator (Xcode 27 or later?)")
        lib = self.xpc.lib
        endpoint = lib.xpc_endpoint_create_mach_port_4sim(port)
        conn = lib.xpc_connection_create_from_endpoint(endpoint)
        if not conn:
            raise RuntimeError("couldn't connect to dtuhidd")
        lib.xpc_connection_enable_sim2host_4sim(conn)
        lib.xpc_connection_set_event_handler(conn, self.xpc.ct.addressof(self._block))
        lib.xpc_connection_resume(conn)
        self.conn = conn

    def send(self, message: dict[str, Any]) -> None:
        with self.lock:
            if self.conn is None:
                self.connect()
            lib = self.xpc.lib
            obj = self.xpc.value(message)
            lib.xpc_connection_send_message(self.conn, obj)
            lib.xpc_release(obj)


class Bridge:
    def __init__(self, udid: str, out: Any) -> None:
        import objc
        from Foundation import NSUUID, NSBundle

        self.out = out
        self.out_lock = threading.Lock()
        if not NSBundle.bundleWithPath_(CORESIMULATOR).load():
            raise RuntimeError("CoreSimulator isn't installed")
        developer = os.environ.get("DEVELOPER_DIR") or _developer_dir()
        context = objc.lookUpClass("SimServiceContext").sharedServiceContextForDeveloperDir_error_(
            developer, None
        )
        device_set = context.defaultDeviceSetWithError_(None)
        uuid = NSUUID.alloc().initWithUUIDString_(udid)
        self.device = device_set.devicesByUDID().get(uuid) if uuid is not None else None
        if self.device is None:
            raise RuntimeError("no such simulator")
        kind = self.device.deviceType()
        size, scale = kind.mainScreenSize(), float(kind.mainScreenScale() or 1)
        self.pixels = (int(size.width), int(size.height))
        self.points = (round(size.width / scale), round(size.height / scale))
        self.scale = scale
        self.family = str(kind.productFamily() or "iPhone")
        self.orientation = 1
        self._edge = EDGE_NONE
        self.streaming = False
        self.box = DEFAULT_BOX
        self.quality = JPEG_QUALITY
        self.hid = _Hid(self.device)
        self._surface: Any = None
        self._surface_at = 0.0
        self._seed = -1
        self._force = True
        self._ci: Any = None
        self._space: Any = None
        self.quit = threading.Event()
        # Set by a stream turned on and by quit: the frame loop, with no stream to watch (a
        # Eden Code session's bridge, for input and pictures), waits on it instead of
        # looking sixty times a second for nothing.
        self.wake = threading.Event()

    # ── output ──

    def write(self, kind: bytes, payload: bytes) -> None:
        with self.out_lock:
            self.out.write(encode_record(kind, payload))
            self.out.flush()

    def say(self, **event: Any) -> None:
        self.write(JSON_RECORD, json.dumps(event).encode())

    # ── frames ──

    def surface(self) -> Any:
        """The framebuffer's IOSurface, looked up again every couple of seconds: it's
        replaced when the display changes (a reboot, a new screen size)."""
        now = time.monotonic()
        if self._surface is not None and now - self._surface_at < 2.0:
            return self._surface
        self._surface_at = now
        found = None
        for port in self.device.io().ioPorts() or []:
            descriptor = port.descriptor()
            if descriptor.respondsToSelector_("framebufferSurface"):
                surface = descriptor.framebufferSurface()
                if surface is not None:
                    found = surface
                    break
        if found is not None and found is not self._surface:
            self._force = True
        self._surface = found
        return found

    def _image(self, surface: Any) -> Any:
        """The framebuffer turned upright for the current orientation (Core Image's y
        axis points up, so a positive angle turns counterclockwise on screen)."""
        import math

        import Quartz

        image = Quartz.CIImage.imageWithIOSurface_(surface)
        angle = {1: 0.0, 3: math.pi / 2, 4: -math.pi / 2, 2: math.pi}.get(self.orientation, 0.0)
        if angle:
            image = image.imageByApplyingTransform_(Quartz.CGAffineTransformMakeRotation(angle))
            extent = image.extent()
            image = image.imageByApplyingTransform_(
                Quartz.CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)
            )
        return image

    def _context(self) -> Any:
        import Quartz

        if self._ci is None:
            self._ci = Quartz.CIContext.contextWithOptions_(None)
            self._space = Quartz.CGColorSpaceCreateWithName(Quartz.kCGColorSpaceSRGB)
        return self._ci

    def frame(self) -> bool:
        """Encode and send a frame if the screen changed since the last one."""
        import Quartz

        surface = self.surface()
        if surface is None:
            return False
        seed = int(surface.seed())
        if seed == self._seed and not self._force:
            return False
        self._seed, self._force = seed, False
        image = self._image(surface)
        extent = image.extent()
        factor = min(
            1.0,
            self.box[0] / (extent.size.width or 1),
            self.box[1] / (extent.size.height or 1),
        )
        if factor < 1.0:
            image = image.imageByApplyingTransform_(
                Quartz.CGAffineTransformMakeScale(factor, factor)
            )
        data = self._context().JPEGRepresentationOfImage_colorSpace_options_(
            image, self._space, {Quartz.kCGImageDestinationLossyCompressionQuality: self.quality}
        )
        if data is None:
            return False
        size = image.extent().size
        head = struct.pack(">HHI", round(size.width), round(size.height), self.orientation)
        self.write(FRAME_RECORD, head + bytes(data))
        return True

    def shot(self, path: str) -> bool:
        import Quartz

        surface = self.surface()
        if surface is None:
            return False
        ctx = self._context()
        data = ctx.PNGRepresentationOfImage_format_colorSpace_options_(
            self._image(surface), Quartz.kCIFormatRGBA8, self._space, None
        )
        if data is None:
            return False
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(bytes(data))
        return True

    # ── input ──

    def rotate(self, direction: str) -> None:
        turn = TURN_LEFT if direction == "left" else TURN_RIGHT
        self.orient(turn.get(self.orientation, 1))

    def orient(self, orientation: int) -> None:
        import ctypes

        if orientation not in TURN_LEFT:
            return
        port = self.device.lookup_error_("PurpleWorkspacePort", None)
        if not port:
            raise RuntimeError("the simulator has no PurpleWorkspacePort")
        msg = orientation_message(int(port), orientation)
        libc = ctypes.CDLL(None)
        libc.mach_msg.argtypes = [ctypes.c_char_p, ctypes.c_int] + [ctypes.c_uint32] * 5
        # MACH_SEND_MSG | MACH_SEND_TIMEOUT: never block the bridge on a stuck SpringBoard.
        result = libc.mach_msg(msg, 0x11, len(msg), 0, 0, 1000, 0)
        if result != 0:
            raise RuntimeError(f"mach_msg failed ({result:#x})")
        self.orientation = orientation
        self._force = True

    def handle(self, op: dict[str, Any]) -> None:
        name = op.get("op")
        if name == "touch":
            x, y = display_to_device(op["x"], op["y"], self.orientation)
            second = None
            if "x2" in op:
                second = display_to_device(op["x2"], op["y2"], self.orientation)
            if op["phase"] == "down":  # a gesture keeps the edge it started on
                self._edge = int(op["edge"]) if "edge" in op else edge_for(x, y)
            self.hid.send(digitizer_message(op["phase"], x, y, second, self._edge))
        elif name == "button":
            for i in range(int(op.get("times", 1))):
                if i:
                    time.sleep(0.12)
                if op.get("state") in ("press", "down"):
                    self.hid.send(button_message(op["name"], DOWN))
                if op.get("state") == "press":
                    time.sleep(0.06)
                if op.get("state") in ("press", "up"):
                    self.hid.send(button_message(op["name"], UP))
        elif name == "key":
            self.hid.send(key_message(int(op["usage"]), DOWN if op["state"] == "down" else UP))
        elif name == "type":
            for usage, shift in op.get("keys", []):
                self._press(int(usage), [SHIFT] if shift else [])
        elif name == "paste":
            self._press(KEY_V, [COMMAND])
        elif name == "rotate":
            self.rotate(str(op.get("dir")))
        elif name == "orient":
            self.orient(int(op.get("orientation", 1)))
        elif name == "stream":
            self.streaming = bool(op.get("on"))
            self.wake.set()
            box = op.get("box") or DEFAULT_BOX
            self.box = _clamp_box(box[0], box[1])
            self.quality = min(0.95, max(0.3, float(op.get("quality", JPEG_QUALITY))))
            self._force = True
        elif name == "shot":
            ok = False
            try:
                ok = self.shot(str(op["path"]))
            finally:
                self.say(event="shot", ok=ok, path=str(op.get("path", "")))
        elif name == "quit":
            self.quit.set()
            self.wake.set()

    def _press(self, usage: int, modifiers: list[int]) -> None:
        for m in modifiers:
            self.hid.send(key_message(m, DOWN))
        self.hid.send(key_message(usage, DOWN))
        time.sleep(KEY_GAP)
        self.hid.send(key_message(usage, UP))
        for m in reversed(modifiers):
            self.hid.send(key_message(m, UP))
        time.sleep(KEY_GAP)

    # ── the loop ──

    def commands(self, stdin: Any) -> None:
        """Commands from the hub, one JSON line each, in order."""
        for line in stdin:
            try:
                self.handle(json.loads(line))
            except Exception as exc:  # one bad command: say so, keep going
                self.say(event="error", message=f"{type(exc).__name__}: {exc}"[:300])
            if self.quit.is_set():
                break
        self.quit.set()
        self.wake.set()

    def run(self, stdin: Any) -> None:
        message, can_input = "", True
        try:
            self.hid.connect()
        except Exception as exc:
            can_input, message = False, str(exc)
        self.say(
            event="ready",
            input=can_input,
            message=message,
            points=list(self.points),
            pixels=list(self.pixels),
            scale=self.scale,
            family=self.family,
        )
        threading.Thread(target=self.commands, args=(stdin,), daemon=True).start()
        while not self.quit.is_set():
            if not self.streaming:
                # Nothing to send until a stream is asked for (or a quit): wait for that
                # rather than waking every FRAME_POLL to do nothing.
                self.wake.wait(IDLE_WAIT)
                self.wake.clear()
                continue
            sent = False
            try:
                sent = self.frame()
            except Exception as exc:
                self.say(event="error", message=f"frame: {exc}"[:300])
                self.quit.wait(1.0)
            self.quit.wait(0.0 if sent else FRAME_POLL)


def _developer_dir() -> str:
    import subprocess

    try:
        out = subprocess.run(
            ["xcode-select", "-p"], capture_output=True, text=True, timeout=10, check=False
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        out = ""
    return out or DEVELOPER_DIR


def bridge_main(udid: str) -> int:
    out = sys.stdout.buffer
    sys.stdout = sys.stderr  # stray prints must never corrupt the record stream
    try:
        bridge = Bridge(udid, out)
    except Exception as exc:
        out.write(
            encode_record(JSON_RECORD, json.dumps({"event": "error", "message": str(exc)}).encode())
        )
        out.flush()
        return 1
    bridge.run(sys.stdin)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "bridge" and UDID.match(sys.argv[2]):
        raise SystemExit(bridge_main(sys.argv[2]))
    print("usage: python -m jarvis.simulator bridge <udid>", file=sys.stderr)
    raise SystemExit(2)
