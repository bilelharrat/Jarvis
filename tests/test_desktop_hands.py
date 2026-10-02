"""Hand control of the whole Mac, with a recording poster: nothing here moves the real
cursor or posts a real event."""

import asyncio
import math
import types

import pytest

from jarvis import desktop_hands as dh
from jarvis.desktop_hands import DesktopHands, QuartzPoster, place

MAIN = (0.0, 0.0, 1440.0, 900.0)


class FakePoster:
    def __init__(self, displays=None, permitted=True, follow=True):
        self._displays = displays or [MAIN]
        self._permitted = permitted
        self.follow = follow  # the cursor goes where the events put it, as on a real Mac
        self.at = (700.0, 450.0)
        self.events = []
        self.requested = 0
        self.fail_on = None

    def permitted(self):
        return self._permitted

    def request(self):
        self.requested += 1

    def displays(self):
        return list(self._displays)

    def cursor(self):
        return self.at

    def mouse(self, kind, x, y, button, clicks):
        if self.fail_on == kind:
            raise RuntimeError("refused")
        self.events.append((kind, round(x, 1), round(y, 1), button, clicks))
        if self.follow:
            self.at = (x, y)

    def scroll(self, dx, dy):
        if self.fail_on == "scroll":
            raise RuntimeError("refused")
        self.events.append(("scroll", dx, dy))

    def kinds(self):
        return [e[0] for e in self.events]


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t

    def tick(self, s=1 / 30):
        self.t += s


def rig(**kw):
    poster = FakePoster(**{k: v for k, v in kw.items() if k in ("displays", "permitted", "follow")})
    clock = Clock()
    hands = DesktopHands(poster, clock=clock, span=kw.get("span", "all"))
    return hands, poster, clock


def send(hands, clock, op, **fields):
    out = hands.handle({"type": "desktop_hand", "op": op, **fields})
    clock.tick()
    return out


# ── starting, and the Accessibility permission ──


def test_start_reports_active_and_nothing_is_posted_before_it():
    hands, poster, clock = rig()
    assert hands.handle({"op": "click", "x": 0.5, "y": 0.5}) == {"state": "active"}  # a lazy start
    assert poster.kinds() == ["move", "down", "up"]
    hands, poster, clock = rig()
    assert send(hands, clock, "start") == {"state": "active"}
    assert poster.events == []


def test_without_accessibility_nothing_is_posted_and_the_window_is_told():
    hands, poster, clock = rig(permitted=False)
    event = send(hands, clock, "start")
    assert event["state"] == "blocked" and "Accessibility" in event["text"]
    # a switch left on for an earlier build of the app is refused too: the text says what to do
    assert "earlier build" in event["text"]
    assert poster.requested == 1, "macOS is asked to show its prompt"
    for op, fields in [
        ("move", {"x": 0.2, "y": 0.2}),
        ("click", {"x": 0.2, "y": 0.2}),
        ("scroll", {"dy": 0.1}),
    ]:
        send(hands, clock, op, **fields)
    assert poster.events == []


def test_after_the_window_stops_it_nothing_more_is_posted_until_it_starts_again():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    assert send(hands, clock, "stop") == {"state": "off"}
    send(hands, clock, "move", x=0.1, y=0.1)
    send(hands, clock, "click", x=0.1, y=0.1)
    assert poster.events == []
    send(hands, clock, "start")
    send(hands, clock, "move", x=0.1, y=0.1)
    assert poster.kinds() == ["move"]


# ── mapping onto the displays ──


def test_positions_map_onto_the_main_display_and_clamp():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "move", x=0.5, y=0.5)
    send(hands, clock, "move", x=0, y=0)
    send(hands, clock, "move", x=7, y=-3)  # clamped to the screen
    assert [e[1:3] for e in poster.events] == [(720.0, 450.0), (0.0, 0.0), (1439.0, 0.0)]


def test_two_displays_span_both_and_never_aim_into_the_gap():
    side = (1440.0, -200.0, 1920.0, 1080.0)  # taller, to the right, raised
    both = [MAIN, side]
    assert place(0.0, 0.5, both) == (0.0, 350.0)  # the middle of the pair's height: -200..900
    x, y = place(0.9, 0.5, both)
    assert 1440 <= x < 3360 and -200 <= y < 880, "on the second display"
    # Above the main display, beside the raised one: no screen there, so onto the main one.
    assert place(0.1, 0.0, both) == (pytest.approx(336.0), 0.0)
    x, y = place(0.9, 0.5, both, span="main")
    assert x == pytest.approx(1296.0) and y == 450.0


def test_no_display_list_still_lands_somewhere_sane():
    assert place(0.5, 0.5, []) == (720.0, 450.0)


# ── clicks, drags, scrolls ──


def test_a_click_moves_there_then_presses_and_lets_go_with_its_click_count():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "click", x=0.25, y=0.5, button="left", count=1)
    send(hands, clock, "click", x=0.25, y=0.5, button="left", count=2)
    assert poster.events == [
        ("move", 360.0, 450.0, "left", 0),
        ("down", 360.0, 450.0, "left", 1),
        ("up", 360.0, 450.0, "left", 1),
        ("move", 360.0, 450.0, "left", 0),
        ("down", 360.0, 450.0, "left", 2),
        ("up", 360.0, 450.0, "left", 2),
    ]
    assert hands.held is None


def test_a_right_click():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "click", x=0.5, y=0.5, button="right")
    assert [(e[0], e[3]) for e in poster.events] == [
        ("move", "right"),
        ("down", "right"),
        ("up", "right"),
    ]


def test_press_move_release_is_a_drag():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.1, y=0.1, button="left")
    for i in range(1, 4):
        send(hands, clock, "move", x=0.1 + i * 0.1, y=0.1)
    send(hands, clock, "release", x=0.4, y=0.1, button="left")
    assert poster.kinds() == ["move", "down", "drag", "drag", "drag", "up"]
    assert poster.events[-1][1] == pytest.approx(576.0)
    assert hands.held is None


def test_a_press_while_another_is_held_lets_go_of_the_first():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.1, y=0.1)
    send(hands, clock, "click", x=0.5, y=0.5)
    assert poster.kinds() == ["move", "down", "up", "move", "down", "up"]
    assert poster.events[2][1:3] == (144.0, 90.0), "let go where it was held"


def test_scroll_follows_the_hand_in_points_and_carries_the_remainder():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "move", x=0.5, y=0.5)
    send(hands, clock, "scroll", dx=0, dy=-0.1)  # content up a tenth of the screen
    send(hands, clock, "scroll", dx=0.001, dy=0.0005)  # under a point each: waits
    send(hands, clock, "scroll", dx=0.001, dy=0.0005)
    scrolls = [e for e in poster.events if e[0] == "scroll"]
    assert scrolls[0] == ("scroll", 0, -90)
    # 1.44 pt across and 0.45 down each time: whole points go, the rest waits for more.
    assert scrolls[1:] == [("scroll", 1, 0), ("scroll", 1, 0)]
    assert hands.scroll_acc[0] == pytest.approx(0.88) and hands.scroll_acc[1] == pytest.approx(0.9)
    send(hands, clock, "scroll", dx=0, dy=1)
    assert poster.events[-1] == ("scroll", 0, dh.MAX_SCROLL_PT), "a huge one is capped"


def test_scrolls_faster_than_the_rate_are_added_up():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    for _ in range(5):
        hands.handle({"op": "scroll", "dx": 0, "dy": 0.01})
        clock.tick(0.002)
    clock.tick(0.02)
    hands.handle({"op": "scroll", "dx": 0, "dy": 0.01})
    scrolls = [e for e in poster.events if e[0] == "scroll"]
    assert len(scrolls) == 2
    assert sum(e[2] for e in scrolls) == 54


# ── rate limits ──


def test_moves_are_rate_limited_and_the_last_one_still_lands():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    for i in range(20):
        hands.handle({"op": "move", "x": 0.3 + i * 0.01, "y": 0.5})
        clock.tick(0.001)  # a burst: 20 moves in 20 ms
    moves = [e for e in poster.events if e[0] == "move"]
    assert 2 <= len(moves) <= 4
    clock.tick(0.05)
    hands.check()
    assert poster.events[-1][1] == pytest.approx(0.49 * 1440), (
        "the watchdog posts the held-back move"
    )


def test_a_move_to_where_the_cursor_already_is_posts_nothing():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    for _ in range(5):
        send(hands, clock, "move", x=0.5, y=0.5)
    assert poster.kinds() == ["move"]


def test_clicks_are_capped_per_second():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    for _ in range(30):
        hands.handle({"op": "click", "x": 0.5, "y": 0.5})
        clock.tick(0.01)
    assert poster.kinds().count("down") == dh.MAX_BUTTONS_PER_S
    clock.tick(1.1)
    hands.handle({"op": "click", "x": 0.5, "y": 0.5})
    assert poster.kinds().count("down") == dh.MAX_BUTTONS_PER_S + 1


# ── safety: never leave a button down ──


def test_stop_lets_go_of_a_held_button():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    send(hands, clock, "stop")
    assert poster.kinds()[-1] == "up" and hands.held is None


def test_cancel_lets_go_and_keeps_steering():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    send(hands, clock, "cancel")
    assert poster.kinds()[-1] == "up"
    send(hands, clock, "move", x=0.2, y=0.2)
    assert poster.events[-1][0] == "move"


def test_the_window_leaving_lets_go_and_a_reconnect_steers_again():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    hands.disconnect()
    assert poster.kinds()[-1] == "up" and not hands.active
    assert send(hands, clock, "move", x=0.2, y=0.2) == {"state": "active"}
    assert poster.events[-1][0] == "move"


def test_the_watchdog_lets_go_when_the_window_goes_quiet():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    clock.tick(0.5)
    assert hands.check() is None and hands.held == "left", "a short gap is fine"
    clock.tick(0.6)
    event = hands.check()
    assert event["state"] == "released"
    assert poster.kinds()[-1] == "up" and hands.held is None
    assert hands.check() is None, "once"


def test_the_watchdog_lets_go_of_a_hold_that_goes_on_too_long():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    for i in range(int(dh.MAX_HOLD * 30) + 5):
        hands.handle({"op": "move", "x": 0.5 + (i % 2) * 0.01, "y": 0.5})
        clock.tick()
        hands.check()
    assert hands.held is None and poster.kinds()[-1] in ("up", "move")
    assert poster.kinds().count("up") == 1


def test_a_refused_event_mid_drag_lets_go_and_stops():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    poster.fail_on = "drag"
    event = send(hands, clock, "move", x=0.6, y=0.5)
    assert event["state"] == "error"
    assert poster.kinds()[-1] == "up" and hands.held is None and not hands.active


def test_letting_go_never_raises_even_when_the_mac_refuses():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    poster.fail_on = "up"
    hands.release_all()  # logged, not raised
    assert hands.held is None
    assert send(hands, clock, "stop") == {"state": "off"}


def test_async_watch_emits_the_watchdog_events():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    clock.tick(5)
    seen = []

    async def run():
        task = asyncio.create_task(hands.watch(seen.append, interval=0.001))
        for _ in range(50):
            await asyncio.sleep(0.002)
            if seen:
                break
        task.cancel()

    asyncio.run(run())
    assert seen and seen[0]["state"] == "released"


# ── the real mouse wins ──


def test_moving_the_real_mouse_makes_the_hands_yield_then_take_back_over():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "move", x=0.5, y=0.5)
    poster.at = (100.0, 100.0)  # someone used the trackpad
    before = len(poster.events)
    send(hands, clock, "move", x=0.6, y=0.5)
    send(hands, clock, "click", x=0.6, y=0.5)
    poster.at = (120.0, 110.0)  # still using it
    clock.tick(1.0)
    send(hands, clock, "move", x=0.6, y=0.5)
    assert len(poster.events) == before, "no moves, no clicks while the mouse is in use"
    clock.tick(dh.YIELD_S + 0.1)  # the mouse has been still
    send(hands, clock, "move", x=0.6, y=0.5)
    assert poster.events[-1][:3] == ("move", 864.0, 450.0)


def test_a_drag_in_progress_does_not_yield():
    hands, poster, clock = rig(follow=False)  # the cursor never seems to follow
    send(hands, clock, "start")
    send(hands, clock, "press", x=0.5, y=0.5)
    send(hands, clock, "move", x=0.6, y=0.5)
    send(hands, clock, "release", x=0.6, y=0.5)
    assert poster.kinds() == ["move", "down", "drag", "up"]


# ── messages from a window are data ──


@pytest.mark.parametrize(
    "msg",
    [
        {"op": "move", "x": float("nan"), "y": 0.5},
        {"op": "move", "x": "left", "y": 0.5},
        {"op": "move"},
        {"op": "click", "x": 0.5, "y": 0.5, "button": "middle"},
        {"op": "click", "x": 0.5, "y": 0.5, "count": "many"},
        {"op": "scroll", "dx": float("inf"), "dy": 0},
        {"op": "launch_missiles"},
        {"op": None},
        {},
    ],
)
def test_malformed_messages_post_nothing_and_never_raise(msg):
    hands, poster, clock = rig()
    send(hands, clock, "start")
    hands.handle(msg)
    assert poster.events == []


def test_click_count_is_kept_between_one_and_three():
    hands, poster, clock = rig()
    send(hands, clock, "start")
    send(hands, clock, "click", x=0.5, y=0.5, count=9)
    send(hands, clock, "click", x=0.5, y=0.5, count=0)
    assert [e[4] for e in poster.events if e[0] == "down"] == [3, 1]


# ── the Quartz poster, against a stand-in Quartz (never the real one) ──


def test_quartz_poster_builds_the_right_events(monkeypatch):
    posted = []
    q = types.SimpleNamespace(
        kCGEventMouseMoved="moved",
        kCGEventLeftMouseDragged="ldrag",
        kCGEventRightMouseDragged="rdrag",
        kCGEventLeftMouseDown="ldown",
        kCGEventLeftMouseUp="lup",
        kCGEventRightMouseDown="rdown",
        kCGEventRightMouseUp="rup",
        kCGMouseButtonLeft=0,
        kCGMouseButtonRight=1,
        kCGMouseEventClickState="clickstate",
        kCGHIDEventTap="hid",
        kCGScrollEventUnitPixel="px",
        CGEventCreateMouseEvent=lambda src, kind, pos, btn: {"kind": kind, "pos": pos, "btn": btn},
        CGEventSetIntegerValueField=lambda ev, field, v: ev.__setitem__(field, v),
        CGEventPost=lambda tap, ev: posted.append(ev),
        CGEventCreateScrollWheelEvent=lambda src, unit, n, dy, dx: {"scroll": (unit, n, dy, dx)},
        CGPreflightPostEventAccess=lambda: False,
        CGMainDisplayID=lambda: 7,
        CGGetActiveDisplayList=lambda n, a, b: (0, (3, 7), 2),
        CGDisplayBounds=lambda d: types.SimpleNamespace(
            origin=types.SimpleNamespace(x=0 if d == 7 else 1440, y=0),
            size=types.SimpleNamespace(width=1440, height=900),
        ),
    )
    monkeypatch.setattr(QuartzPoster, "_q", staticmethod(lambda: q))
    p = QuartzPoster()
    p.mouse("down", 10, 20, "left", 2)
    p.mouse("drag", 11, 21, "right", 1)
    p.mouse("move", 12, 22, "left", 0)
    p.scroll(3, -40)
    assert posted == [
        {"kind": "ldown", "pos": (10, 20), "btn": 0, "clickstate": 2},
        {"kind": "rdrag", "pos": (11, 21), "btn": 1, "clickstate": 1},
        {"kind": "moved", "pos": (12, 22), "btn": 0},
        {"scroll": ("px", 2, -40, 3)},
    ]
    assert p.permitted() is False
    assert p.displays() == [(0.0, 0.0, 1440.0, 900.0), (1440.0, 0.0, 1440.0, 900.0)], "main first"


def test_importing_the_module_does_not_touch_quartz():
    assert not hasattr(dh, "Quartz")
    assert math.isfinite(dh.MOVE_INTERVAL)


def test_switching_accessibility_on_meanwhile_is_noticed():
    hands, poster, clock = rig(permitted=False)
    assert send(hands, clock, "start")["state"] == "blocked"
    clock.tick(dh.RECHECK_S)
    assert hands.check() is None  # still off
    poster._permitted = True  # the owner flips the switch in System Settings
    clock.tick(dh.RECHECK_S)
    assert hands.check() == {"state": "allowed"}
    clock.tick(dh.RECHECK_S)
    assert hands.check() is None, "said once"
    assert send(hands, clock, "start") == {"state": "active"}


def test_the_recheck_gives_up_after_a_while():
    hands, poster, clock = rig(permitted=False)
    send(hands, clock, "start")
    clock.tick(dh.RECHECK_FOR_S + 1)
    hands.check()
    poster._permitted = True
    clock.tick(dh.RECHECK_S)
    assert hands.check() is None
