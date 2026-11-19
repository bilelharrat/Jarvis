"""Hand control of the whole Mac: the window's desktop gestures (gestures.js,
createDesktopGestures) as real mouse events.

The window sends {"type": "desktop_hand", "op": ...} messages with positions in 0..1 of
the screen from its top left; this maps them onto the displays and posts them with Quartz,
the way computer.py's click and scroll tools do. Posting needs the Accessibility
permission of the app running JARVIS.

Safety comes first, because a button left down on the real Mac drags whatever is under
the cursor until someone clicks:
- A held button is let go on stop, cancel, a window leaving, a posting error, a second
  without word from the window (the watchdog), and after a minute whatever happens.
- Nothing is posted before a start (a window's first move counts as one) or after a stop,
  and nothing at all without the Accessibility permission.
- Moves are rate-limited, clicks and presses capped per second, scrolls capped per event.
- Moving the real mouse or trackpad wins: the hands yield the cursor for a moment and
  click nothing meanwhile.

The events go through an injectable poster, so tests never move the real cursor.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import os
import plistlib
import subprocess
import time
from collections import deque
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

MOVE_INTERVAL = 1 / 120  # s: at most this often a cursor move is posted
SCROLL_INTERVAL = 1 / 60  # s: scroll deltas in between are added up
BUTTON_TIMEOUT = 1.0  # s without a message from the window while a button is held: let go
MAX_HOLD = 60.0  # s a button may be held at all
MAX_BUTTONS_PER_S = 8  # clicks and presses; a window stuck in a loop can't machine-gun clicks
MAX_SCROLL_PT = 600  # per posted scroll event, each way
YIELD_PT = 40.0  # the cursor this far from where the hands put it: someone moved the mouse
YIELD_S = 1.5  # the hands keep off the cursor this long after the mouse last moved
DISPLAYS_TTL = 5.0  # s between looks at the display arrangement
BUTTONS = ("left", "right")

# The app macOS asks about is the one that started this backend, and that isn't always Eden
# Secretary: the Eden apps share one backend, so it may be Eden Code's or Ask Eden's (or
# Terminal's, run from there). host_app() finds it; without it, Eden Secretary's are named.
DEFAULT_APP = ("Eden Secretary", "com.bshventures.jarvis")


def not_permitted(app: str = DEFAULT_APP[0], bundle_id: str = DEFAULT_APP[1]) -> str:
    """What to do when macOS won't let this backend post events. macOS keeps a permission for
    the build it was given to: after the app is rebuilt or signed differently the switch can
    still show on while the Mac refuses it, and switching it off and on doesn't renew it.
    Removing and adding it again does; so does resetting both services the grant can sit
    under (Accessibility, or PostEvent for an older one)."""
    text = (
        f"To steer the Mac with your hands, allow {app} in System Settings › Privacy & Security "
        f"› Accessibility, then turn hand control of the Mac on again. If it's already on there, "
        f"that was an earlier build of {app}: remove it with −, then add it again with +."
    )
    if bundle_id:
        text += (
            f" If it's still refused, run  tccutil reset Accessibility {bundle_id}; tccutil reset "
            f"PostEvent {bundle_id}  in Terminal, then turn hand control on again and allow {app} "
            "when the Mac asks."
        )
    return text


NOT_PERMITTED = not_permitted()


def _ps(pid: int) -> tuple[int, str] | None:
    """(parent pid, executable path) of a process, or None when ps can't say."""
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=,comm=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        ).stdout
        parent, path = out.strip().split(None, 1)
        return int(parent), path
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _app_identity(bundle: str) -> tuple[str, str]:
    """(name as System Settings lists it, bundle id) of an .app, from its Info.plist."""
    try:
        with open(Path(bundle) / "Contents" / "Info.plist", "rb") as f:
            info = plistlib.load(f)
    except (OSError, ValueError, plistlib.InvalidFileException):
        info = {}
    if not isinstance(info, dict):
        info = {}
    name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or Path(bundle).stem
    return str(name), str(info.get("CFBundleIdentifier") or "")


def host_app(
    env: Mapping[str, str] | None = None,
    ps: Callable[[int], tuple[int, str] | None] = _ps,
    identity: Callable[[str], tuple[str, str]] = _app_identity,
) -> tuple[str, str] | None:
    """The app macOS asks about this backend's Accessibility: the one that started it. The
    Eden apps' launcher says which (JARVIS_LAUNCHER_PID, app/main.js); otherwise it's the
    nearest app up the process tree from this backend (Terminal, run from there). The
    outermost .app counts, so an Electron helper's is its app's. (name, bundle id), or None."""
    env = os.environ if env is None else env
    launcher = str(env.get("JARVIS_LAUNCHER_PID", "")).strip()
    pid = int(launcher) if launcher.isdigit() else os.getpid()
    for _ in range(8):  # this backend, uv, a shell or two, the app
        if pid <= 1:
            return None
        found = ps(pid)
        if not found:
            return None
        parent, path = found
        head, dot_app, _rest = path.partition(".app/")
        if dot_app:
            return identity(head + ".app")
        pid = parent
    return None


FAILED = "Hand control of the Mac stopped: the Mac refused a mouse event."
RECHECK_S = 2.0  # after a refusal, how often the permission is looked at again
RECHECK_FOR_S = 600.0  # and for how long: switching it on in System Settings is noticed

Rect = tuple[float, float, float, float]  # x, y, width, height in global points


class Poster(Protocol):
    """Where the events go: Quartz for real, a recorder in tests."""

    def permitted(self) -> bool: ...
    def request(self) -> None: ...
    def displays(self) -> list[Rect]: ...  # the main display first
    def cursor(self) -> tuple[float, float] | None: ...
    def mouse(self, kind: str, x: float, y: float, button: str, clicks: int) -> None: ...
    def scroll(self, dx: int, dy: int) -> None: ...


class QuartzPoster:
    """The real thing. Quartz is imported on first use, so importing this module (and
    testing it) never touches the window server."""

    @staticmethod
    def _q():
        import Quartz

        return Quartz

    def permitted(self) -> bool:
        check = getattr(self._q(), "CGPreflightPostEventAccess", None)
        return bool(check()) if check else True

    def request(self) -> None:
        """Ask macOS to show its Accessibility prompt (once per app, the OS decides)."""
        ask = getattr(self._q(), "CGRequestPostEventAccess", None)
        if ask:
            ask()

    def displays(self) -> list[Rect]:
        q = self._q()
        main = q.CGMainDisplayID()
        err, ids, count = q.CGGetActiveDisplayList(16, None, None)
        ids = list(ids or [])[:count] if not err else []
        if main not in ids:
            ids.insert(0, main)
        ids.sort(key=lambda d: d != main)
        rects = []
        for d in ids:
            b = q.CGDisplayBounds(d)
            rects.append(
                (float(b.origin.x), float(b.origin.y), float(b.size.width), float(b.size.height))
            )
        return rects

    def cursor(self) -> tuple[float, float] | None:
        q = self._q()
        event = q.CGEventCreate(None)
        if event is None:
            return None
        p = q.CGEventGetLocation(event)
        return float(p.x), float(p.y)

    def mouse(self, kind: str, x: float, y: float, button: str, clicks: int) -> None:
        q = self._q()
        right = button == "right"
        kinds = {
            "move": q.kCGEventMouseMoved,
            "drag": q.kCGEventRightMouseDragged if right else q.kCGEventLeftMouseDragged,
            "down": q.kCGEventRightMouseDown if right else q.kCGEventLeftMouseDown,
            "up": q.kCGEventRightMouseUp if right else q.kCGEventLeftMouseUp,
        }
        btn = q.kCGMouseButtonRight if right else q.kCGMouseButtonLeft
        event = q.CGEventCreateMouseEvent(None, kinds[kind], (x, y), btn)
        if kind in ("down", "up", "drag"):
            q.CGEventSetIntegerValueField(event, q.kCGMouseEventClickState, clicks)
        q.CGEventPost(q.kCGHIDEventTap, event)

    def scroll(self, dx: int, dy: int) -> None:
        q = self._q()
        event = q.CGEventCreateScrollWheelEvent(None, q.kCGScrollEventUnitPixel, 2, dy, dx)
        q.CGEventPost(q.kCGHIDEventTap, event)


def _unit(value: Any) -> float:
    """A 0..1 screen fraction from the window; anything else is refused."""
    v = float(value)
    if not math.isfinite(v):
        raise ValueError("not a number")
    return min(1.0, max(0.0, v))


def _signed(value: Any, limit: float = 1.0) -> float:
    v = float(value)
    if not math.isfinite(v):
        raise ValueError("not a number")
    return min(limit, max(-limit, v))


def _count(value: Any) -> int:
    """A click's count, 1 to 3. Infinity is refused like words are (ValueError): a malformed
    message, not a refused mouse event that would stop hand control."""
    try:
        return max(1, min(3, int(value)))
    except OverflowError:
        raise ValueError("not a count") from None


def place(x: float, y: float, displays: list[Rect], span: str = "all") -> tuple[float, float]:
    """(x, y) in 0..1 as a point on the displays: across all of them ("all": their
    bounding box, then into the nearest display, so a gap between screens of different
    sizes is never aimed at) or the main one only ("main")."""
    if not displays:
        displays = [(0.0, 0.0, 1440.0, 900.0)]
    shown = displays[:1] if span == "main" else displays
    left = min(d[0] for d in shown)
    top = min(d[1] for d in shown)
    right = max(d[0] + d[2] for d in shown)
    bottom = max(d[1] + d[3] for d in shown)
    px, py = left + x * (right - left), top + y * (bottom - top)
    best, best_d = (px, py), math.inf
    for dx, dy, dw, dh in shown:
        cx = min(max(px, dx), dx + dw - 1)
        cy = min(max(py, dy), dy + dh - 1)
        d = math.hypot(px - cx, py - cy)
        if d < best_d:
            best, best_d = (cx, cy), d
    return best


class DesktopHands:
    """One window's hands on the Mac's cursor. handle() takes the window's messages and
    returns a status event for the window (or None); check() is the watchdog, called a
    few times a second while anything is held or waiting (watch() does that)."""

    def __init__(
        self,
        poster: Poster | None = None,
        clock: Callable[[], float] = time.monotonic,
        span: str = "all",
        find_host: Callable[[], tuple[str, str] | None] = host_app,
    ) -> None:
        self.poster: Poster = poster or QuartzPoster()
        self.clock = clock
        self.span = span
        self.find_host = find_host
        self.host: tuple[str, str] | None = None  # (name, bundle id) macOS asks about: watch()
        self.active = False
        self.stopped = False  # stopped by the window: only its start begins again
        self.held: str | None = None  # the button that's down
        self.held_since = 0.0
        self.pos: tuple[float, float] | None = None  # where the hands last put the cursor
        self.last_msg = -math.inf
        self.last_move = -math.inf
        self.pending: tuple[float, float] | None = None  # a move the rate limit held back
        self.scroll_acc = [0.0, 0.0]
        self.last_scroll = -math.inf
        self.presses: deque[float] = deque()
        self.yield_until = -math.inf
        self.yield_at: tuple[float, float] | None = None
        self._displays: list[Rect] = []
        self._displays_at = -math.inf
        self.blocked_at: float | None = None  # refused for want of Accessibility, since
        self.rechecked_at = -math.inf
        self._wake: asyncio.Event | None = None  # the watchdog, waiting for work (watch)

    # ── lifecycle ──

    def start(self) -> dict[str, Any]:
        self._poke()
        self.stopped = False
        try:
            ok = self.poster.permitted()
        except Exception:
            log.exception("couldn't check the Accessibility permission")
            ok = False
        if not ok:
            self.active = False
            app, bundle_id = self.host or DEFAULT_APP
            if self.blocked_at is None:
                log.info("hand control of the Mac: Accessibility not granted to %s yet", app)
                self.blocked_at = self.clock()
            with contextlib.suppress(Exception):
                self.poster.request()
            return {"state": "blocked", "text": not_permitted(app, bundle_id)}
        self.blocked_at = None
        self.active = True
        self.pos = None
        self.yield_until = -math.inf
        self._displays_at = -math.inf
        return {"state": "active"}

    def stop(self) -> dict[str, Any]:
        """The window turned it off: let go of everything and post nothing more."""
        self.release_all()
        self.active = False
        self.stopped = True
        return {"state": "off"}

    def disconnect(self) -> None:
        """The window went away: let go now. Its next move (after it reconnects) starts
        again, unless it had stopped."""
        self.release_all()
        self.active = False

    def release_all(self) -> None:
        """Let go of a held button. Never raises: this is the safety net."""
        self.pending = None
        self.scroll_acc = [0.0, 0.0]
        button, self.held = self.held, None
        if button is None:
            return
        x, y = self.pos or self._cursor_or_origin()
        try:
            self.poster.mouse("up", x, y, button, 1)
        except Exception:
            log.exception("couldn't let go of the %s button", button)

    def _cursor_or_origin(self) -> tuple[float, float]:
        with contextlib.suppress(Exception):
            p = self.poster.cursor()
            if p:
                return p
        return (0.0, 0.0)

    # ── messages ──

    def handle(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        self._poke()  # whatever it does, the watchdog looks again
        op = msg.get("op")
        now = self.clock()
        self.last_msg = now
        if op == "start":
            return self.start()
        if op == "stop":
            return self.stop()
        if op == "cancel":
            self.release_all()
            return None
        if op not in ("move", "press", "release", "click", "scroll", "alive"):
            return None
        event = None
        if not self.active:
            if self.stopped or op in ("release", "alive"):
                return None
            event = self.start()  # a window steering after a reconnect
            if not self.active:
                return event
        try:
            result = self._op(op, msg, now)
        except (TypeError, ValueError):
            return event  # a malformed message: that one only
        except Exception:
            log.exception("posting a %s failed", op)
            self.release_all()
            self.active = False
            return {"state": "error", "text": FAILED}
        return result or event

    def _op(self, op: str, msg: dict[str, Any], now: float) -> dict[str, Any] | None:
        if op == "alive":
            return None
        if op == "scroll":
            return self._scroll(_signed(msg.get("dx", 0)), _signed(msg.get("dy", 0)), now)
        if op == "release":
            if self.held is None:
                return None
            x, y = self._point(msg, now)
            button, self.held = self.held, None
            self.pos = (x, y)
            self.poster.mouse("up", x, y, button, 1)
            return None
        x, y = self._point(msg, now)
        if op == "move":
            return self._move(x, y, now)
        button = msg.get("button", "left")
        if button not in BUTTONS:
            raise ValueError("unknown button")
        count = _count(msg.get("count", 1))  # checked before anything is posted
        if self._yielding(now) or not self._may_press(now):
            return None
        if self.held is not None:
            self.release_all()
        self.pending = None
        self.pos = (x, y)
        self.poster.mouse("move", x, y, button, 0)
        if op == "press":
            self.poster.mouse("down", x, y, button, 1)
            self.held, self.held_since = button, now
            return None
        self.poster.mouse("down", x, y, button, count)
        self.poster.mouse("up", x, y, button, count)
        return None

    def _point(self, msg: dict[str, Any], now: float) -> tuple[float, float]:
        x, y = _unit(msg["x"]), _unit(msg["y"])
        if now - self._displays_at > DISPLAYS_TTL:
            try:
                self._displays = self.poster.displays() or self._displays
            except Exception:
                log.exception("couldn't read the display arrangement")
            self._displays_at = now
        return place(x, y, self._displays, self.span)

    def _move(self, x: float, y: float, now: float) -> dict[str, Any] | None:
        if self.held is None and self._yielding(now):
            return None
        if now - self.last_move < MOVE_INTERVAL:
            self.pending = (x, y)
            return None
        self._post_move(x, y, now)
        return None

    def _post_move(self, x: float, y: float, now: float) -> None:
        self.pending = None
        if self.held is None and self.pos == (x, y):
            return  # no change: nothing to post
        self.last_move = now
        self.pos = (x, y)
        if self.held is not None:
            self.poster.mouse("drag", x, y, self.held, 1)
        else:
            self.poster.mouse("move", x, y, "left", 0)

    def _scroll(self, dx: float, dy: float, now: float) -> dict[str, Any] | None:
        if self._yielding(now):
            return None
        # A fraction of the screen as points of the display the cursor is on.
        width, height = self._display_size()
        self.scroll_acc[0] += dx * width
        self.scroll_acc[1] += dy * height
        if now - self.last_scroll < SCROLL_INTERVAL:
            return None
        ix, iy = int(self.scroll_acc[0]), int(self.scroll_acc[1])  # the rest waits for more
        if not ix and not iy:
            return None
        self.scroll_acc = [self.scroll_acc[0] - ix, self.scroll_acc[1] - iy]
        self.last_scroll = now
        clamp = lambda v: max(-MAX_SCROLL_PT, min(MAX_SCROLL_PT, v))  # noqa: E731
        self.poster.scroll(clamp(ix), clamp(iy))
        return None

    def _display_size(self) -> tuple[float, float]:
        shown = self._displays or [(0.0, 0.0, 1440.0, 900.0)]
        if self.pos:
            for dx, dy, dw, dh in shown:
                if dx <= self.pos[0] < dx + dw and dy <= self.pos[1] < dy + dh:
                    return dw, dh
        return shown[0][2], shown[0][3]

    def _may_press(self, now: float) -> bool:
        while self.presses and now - self.presses[0] > 1.0:
            self.presses.popleft()
        if len(self.presses) >= MAX_BUTTONS_PER_S:
            return False
        self.presses.append(now)
        return True

    def _yielding(self, now: float) -> bool:
        """Whether someone is using the real mouse or trackpad: the cursor isn't where the
        hands put it. The hands keep off until it has been still for YIELD_S."""
        try:
            cur = self.poster.cursor()
        except Exception:
            cur = None
        if cur is None:
            return now < self.yield_until
        if now < self.yield_until:
            if self.yield_at is None or math.dist(cur, self.yield_at) > 2:
                self.yield_until = now + YIELD_S  # still moving
            self.yield_at = cur
            return True
        if self.yield_at is not None:  # the mouse has been still long enough
            self.yield_at = None
            self.pos = None
            return False
        if self.pos is not None and math.dist(cur, self.pos) > YIELD_PT:
            self.yield_until = now + YIELD_S
            self.yield_at = cur
            self.pending = None
            return True
        return False

    # ── the watchdog ──

    def check(self) -> dict[str, Any] | None:
        now = self.clock()
        if self.blocked_at is not None and now - self.rechecked_at >= RECHECK_S:
            # Switched on in System Settings meanwhile: say so, so the window carries on
            # without the owner turning hand control on again.
            self.rechecked_at = now
            if now - self.blocked_at > RECHECK_FOR_S:
                self.blocked_at = None
            else:
                try:
                    ok = self.poster.permitted()
                except Exception:
                    ok = False
                if ok:
                    self.blocked_at = None
                    log.info("hand control of the Mac: Accessibility granted")
                    return {"state": "allowed"}
        if self.held is not None and (
            now - self.last_msg > BUTTON_TIMEOUT or now - self.held_since > MAX_HOLD
        ):
            self.release_all()
            return {"state": "released", "text": "Let go of the mouse button."}
        if self.pending is not None and self.active and now - self.last_move >= MOVE_INTERVAL:
            x, y = self.pending
            try:
                self._move(x, y, now)
            except Exception:
                log.exception("posting a move failed")
                self.release_all()
                self.active = False
                return {"state": "error", "text": FAILED}
        return None

    def _resting(self) -> bool:
        """Nothing for check() to do: no button down, no move held back, no refusal to look
        at again. Only a message from the window (handle) changes that."""
        return (
            self.held is None
            and self.blocked_at is None
            and (self.pending is None or not self.active)
        )

    def _poke(self) -> None:
        if self._wake is not None:
            self._wake.set()

    async def watch(self, emit: Callable[[dict[str, Any]], None], interval: float = 0.25) -> None:
        """check() every `interval` for as long as JARVIS runs, while there's something to
        watch: at rest (hand control off, or nothing held) it waits for the window's next
        message instead of waking four times a second for nothing."""
        # Asked in a worker thread, like the permission below: finding the app asks ps.
        with contextlib.suppress(Exception):
            self.host = await asyncio.to_thread(self.find_host)
        with contextlib.suppress(Exception):  # one line at start: what the Mac allows this backend
            # Asked in a worker thread: the first look imports Quartz, a third of a second on
            # a busy Mac, and on the loop that held up everything else the hub was starting.
            granted = await asyncio.to_thread(self.poster.permitted)
            app, bundle_id = self.host or ("an app it couldn't find", "")
            log.info(
                "hand control of the Mac: Accessibility %s for this backend (pid %d, parent %d), "
                "which macOS asks about as %s%s",
                "granted" if granted else "NOT granted",
                os.getpid(),
                os.getppid(),
                app,
                f" ({bundle_id})" if bundle_id else "",
            )
        self._wake = asyncio.Event()
        while True:
            if self._resting():
                self._wake.clear()
                await self._wake.wait()
            await asyncio.sleep(interval)
            try:
                event = self.check()
            except Exception:
                log.exception("desktop hands watchdog failed")
                event = None
            if event:
                emit(event)
