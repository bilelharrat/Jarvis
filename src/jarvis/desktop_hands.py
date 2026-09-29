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
import time
from collections import deque
from collections.abc import Callable
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

NOT_PERMITTED = (
    "To steer the Mac with your hands, allow J.A.R.V.I.S. in System Settings › Privacy & "
    "Security › Accessibility, then turn hand control of the Mac on again."
)
FAILED = "Hand control of the Mac stopped: the Mac refused a mouse event."

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
    few times a second (watch() does that)."""

    def __init__(
        self,
        poster: Poster | None = None,
        clock: Callable[[], float] = time.monotonic,
        span: str = "all",
    ) -> None:
        self.poster: Poster = poster or QuartzPoster()
        self.clock = clock
        self.span = span
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

    # ── lifecycle ──

    def start(self) -> dict[str, Any]:
        self.stopped = False
        try:
            ok = self.poster.permitted()
        except Exception:
            log.exception("couldn't check the Accessibility permission")
            ok = False
        if not ok:
            self.active = False
            with contextlib.suppress(Exception):
                self.poster.request()
            return {"state": "blocked", "text": NOT_PERMITTED}
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
        count = max(1, min(3, int(msg.get("count", 1))))  # checked before anything is posted
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

    async def watch(self, emit: Callable[[dict[str, Any]], None], interval: float = 0.25) -> None:
        """check() every `interval` for as long as JARVIS runs."""
        while True:
            await asyncio.sleep(interval)
            try:
                event = self.check()
            except Exception:
                log.exception("desktop hands watchdog failed")
                event = None
            if event:
                emit(event)
