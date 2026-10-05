"""The iOS Simulator pane's backend: dtuhidd messages, orientation math, the bridge's pipe,
flow control to the window, and the window's commands. No simulator, no simctl, no Apple
frameworks: processes and commands are fakes."""

import asyncio
import base64
import json
import struct
from datetime import datetime
from pathlib import Path

import pytest

from jarvis import simulator
from jarvis.simulator import (
    FRAME_RECORD,
    JSON_RECORD,
    Controller,
    RecordReader,
    Stream,
    UInt,
    button_message,
    digitizer_message,
    display_to_device,
    edge_for,
    encode_record,
    key_message,
    keys_for_text,
    orientation_message,
    parse_apps,
    parse_devices,
    screenshot_path,
)

UDID = "11111111-2222-3333-4444-555555555555"
OTHER = "66666666-7777-8888-9999-000000000000"
# The smallest JPEG header _jpeg_size reads: SOI, then an SOF0 of 8 x 4.
TINY_JPEG = bytes.fromhex("ffd8ffc0000b080004000801011100ffd9")


# ── dtuhidd messages ──


def test_button_message_is_a_consumer_page_press_with_unsigned_fields():
    msg = button_message("home", simulator.DOWN)
    assert msg["messageType"] == "IndigoButtonEvent"
    assert msg["featureIdentifier"] == "com.apple.coredevice.feature.remote.hid.button"
    assert msg["payload"] == {"usagePage": 0x0C, "usageCode": 0x40, "state": 1}
    assert all(isinstance(v, UInt) for v in msg["payload"].values())
    assert button_message("lock", simulator.UP)["payload"]["usageCode"] == 0x30


def test_key_message_carries_usage_and_state():
    msg = key_message(4, simulator.UP)
    assert msg["messageType"] == "IndigoKeyboardButtonEvent"
    assert msg["payload"] == {"usageCode": 4, "state": 2}


def test_digitizer_message_clamps_points_and_adds_a_second_finger_only_when_given():
    one = digitizer_message("down", 1.4, -0.2)
    assert one["payload"]["pointOne"] == {"x": 1.0, "y": 0.0}
    assert one["payload"]["eventType"] == 0 and "pointTwo" not in one["payload"]
    assert isinstance(one["payload"]["eventType"], UInt)
    two = digitizer_message("move", 0.3, 0.4, (0.7, 0.6), edge=simulator.EDGE_BOTTOM)
    assert two["payload"]["pointTwo"] == {"x": 0.7, "y": 0.6}
    assert two["payload"]["eventType"] == 1 and two["payload"]["edge"] == 3
    assert digitizer_message("up", 0, 0, edge=9)["payload"]["edge"] == simulator.EDGE_NONE


def test_keys_for_text_types_a_us_keyboard_and_refuses_what_it_cant():
    assert keys_for_text("aZ1!\n") == [(4, False), (29, True), (30, False), (30, True), (40, False)]
    assert keys_for_text("a-b_c") == [(4, False), (45, False), (5, False), (45, True), (6, False)]
    assert keys_for_text("\r\n") == [(40, False)]  # one Return, not two
    assert keys_for_text("café") is None
    assert keys_for_text("你好") is None


# ── which way up ──


@pytest.mark.parametrize(
    ("orientation", "display", "device"),
    [
        (1, (0.2, 0.3), (0.2, 0.3)),
        (3, (0.0, 0.0), (1.0, 0.0)),  # the picture's top left is the framebuffer's top right
        (3, (0.5, 1.0), (0.0, 0.5)),  # its bottom is the framebuffer's left edge
        (4, (0.0, 0.0), (0.0, 1.0)),
        (4, (0.5, 1.0), (1.0, 0.5)),
        (2, (0.2, 0.3), (0.8, 0.7)),
    ],
)
def test_display_to_device_turns_touches_back_to_the_framebuffer(orientation, display, device):
    x, y = display_to_device(*display, orientation)
    assert (x, y) == pytest.approx(device)


def test_edge_for_marks_the_home_gesture_and_screen_edges():
    assert edge_for(0.5, 0.99) == simulator.EDGE_BOTTOM
    assert edge_for(0.001, 0.999) == simulator.EDGE_BOTTOM  # a corner is the home gesture
    assert edge_for(0.01, 0.5) == simulator.EDGE_LEFT
    assert edge_for(0.99, 0.5) == simulator.EDGE_RIGHT
    assert edge_for(0.5, 0.01) == simulator.EDGE_TOP
    assert edge_for(0.5, 0.5) == simulator.EDGE_NONE


def test_orientation_message_is_graphicsservices_wire_format():
    msg = orientation_message(0x1234, 3)
    assert len(msg) == 0x50
    bits, size, port, local, voucher, msg_id = struct.unpack_from("<IIIIII", msg)
    assert (bits, size, port, local, voucher, msg_id) == (0x13, 0x50, 0x1234, 0, 0, 0x7B)
    assert struct.unpack_from("<I", msg, 0x18)[0] == 50 | 0x20000
    assert struct.unpack_from("<II", msg, 0x48) == (4, 3)


def test_turning_goes_round_both_ways():
    o = 1
    for _ in range(4):
        o = simulator.TURN_LEFT[o]
    assert o == 1
    assert simulator.TURN_RIGHT[simulator.TURN_LEFT[1]] == 1
    assert simulator.TURN_LEFT[1] == 3 and simulator.TURN_RIGHT[1] == 4


# ── simctl output ──


def test_parse_devices_keeps_available_iphones_and_ipads_booted_first():
    raw = json.dumps(
        {
            "devices": {
                "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                    {"udid": OTHER, "name": "iPhone 17", "state": "Shutdown", "isAvailable": True,
                     "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17"},
                    # Renamed, but still an iPhone by its device type.
                    {"udid": UDID, "name": "test phone", "state": "Booted", "isAvailable": True,
                     "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17e"},
                    {"udid": "A" * 8 + "-0000-0000-0000-" + "0" * 12, "name": "iPad Air",
                     "state": "Shutdown", "isAvailable": False},
                ],
                "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [
                    {"udid": "B" * 8 + "-0000-0000-0000-" + "0" * 12, "name": "Apple Watch",
                     "state": "Booted", "isAvailable": True},
                ],
            }
        }
    )  # fmt: skip
    devices = parse_devices(raw)
    assert [d["udid"] for d in devices] == [UDID, OTHER]
    assert devices[0] == {"udid": UDID, "name": "test phone", "state": "Booted", "os": "iOS 27.0"}
    assert parse_devices("not json") == []


def test_parse_apps_lists_the_users_apps_then_home_screen_ones():
    raw = json.dumps(
        {
            "com.apple.mobilesafari": {"ApplicationType": "System", "CFBundleDisplayName": "Safari"},
            "com.apple.springboard": {"ApplicationType": "System", "CFBundleDisplayName": "SpringBoard"},
            "com.example.zeta": {"ApplicationType": "User", "CFBundleName": "Zeta"},
            "com.example.alpha": {"ApplicationType": "User", "CFBundleDisplayName": "Alpha"},
            "bad id!": {"ApplicationType": "User"},
        }
    ).encode()  # fmt: skip
    apps = parse_apps(raw)
    assert [a["bundle"] for a in apps] == [
        "com.example.alpha",
        "com.example.zeta",
        "com.apple.mobilesafari",
    ]
    assert apps[0] == {"bundle": "com.example.alpha", "name": "Alpha", "user": True}
    assert parse_apps(b"") == []


def test_screenshot_path_names_it_as_simulator_does(tmp_path):
    when = datetime(2026, 9, 29, 12, 5, 9)
    path = screenshot_path("iPhone 17 / test", when, tmp_path)
    assert path == tmp_path / "Simulator Screenshot - iPhone 17 - test - 2026-09-29 at 12.05.09.png"


def test_jpeg_size_reads_the_frame_header():
    assert simulator._jpeg_size(TINY_JPEG) == (8, 4)
    assert simulator._jpeg_size(b"nope") == (0, 0)


def test_clamp_box_keeps_frames_sensible():
    assert simulator._clamp_box(10, 99999) == (120, 2400)
    assert simulator._clamp_box("x", None) == simulator.DEFAULT_BOX


@pytest.mark.parametrize("odd", [float("inf"), float("-inf"), float("nan"), [600], {"w": 1}])
def test_clamp_box_takes_the_default_for_a_side_that_isnt_a_number(odd):
    # A window's JSON can carry Infinity and NaN (Python's json reads them): no traceback.
    assert simulator._clamp_box(odd, 900) == (simulator.DEFAULT_BOX[0], 900)
    assert simulator._clamp_box(400, odd) == (400, simulator.DEFAULT_BOX[1])


# ── the bridge's pipe ──


def test_record_reader_splits_records_however_the_pipe_chunks_them():
    data = encode_record(JSON_RECORD, b'{"event":"ready"}') + encode_record(
        FRAME_RECORD, b"\x00" * 300
    )
    reader = RecordReader()
    got = []
    for i in range(0, len(data), 7):
        got += reader.feed(data[i : i + 7])
    assert got == [(JSON_RECORD, b'{"event":"ready"}'), (FRAME_RECORD, b"\x00" * 300)]


def test_record_reader_refuses_a_giant_record():
    with pytest.raises(ValueError):
        RecordReader().feed(b"f" + struct.pack(">I", RecordReader.MAX + 1))


# ── fakes ──


class FakeStdin:
    def __init__(self):
        self.lines = []

    def write(self, data):
        for line in data.decode().splitlines():
            self.lines.append(json.loads(line))


class FakeBridge:
    """Stands in for `python -m jarvis.simulator bridge`: records the commands, and the
    test feeds its output."""

    def __init__(self, ready=True, can_input=True):
        self.stdin = FakeStdin()
        self.stdout = asyncio.StreamReader()
        self.returncode = None
        if ready:
            self.say({"event": "ready", "input": can_input, "points": [402, 874],
                      "pixels": [1206, 2622], "scale": 3.0, "family": "iPhone"})  # fmt: skip

    def say(self, event):
        self.stdout.feed_data(encode_record(JSON_RECORD, json.dumps(event).encode()))

    def frame(self, jpeg=TINY_JPEG, w=8, h=4, orientation=1):
        self.stdout.feed_data(
            encode_record(FRAME_RECORD, struct.pack(">HHI", w, h, orientation) + jpeg)
        )

    def ops(self, name):
        return [line for line in self.stdin.lines if line.get("op") == name]

    async def wait(self):
        self.returncode = 0
        if not self.stdout.at_eof():
            self.stdout.feed_eof()
        return 0

    def kill(self):
        self.returncode = -9


class Recorder:
    def __init__(self):
        self.events = []

    def __call__(self, kind, **data):
        self.events.append((kind, data))

    def of(self, kind):
        return [d for k, d in self.events if k == kind]


class FakeRun:
    """simctl and plutil: answers by the command, remembers every call."""

    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    async def __call__(self, *args, stdin=None, timeout=60):
        self.calls.append((args, stdin))
        if "screenshot" in args:
            Path(args[-1]).write_bytes(TINY_JPEG)
            return 0, b""
        for key, answer in self.answers.items():
            if key in args:
                return answer
        if "list" in args:
            devices = {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                {"udid": UDID, "name": "iPhone 17", "state": "Booted", "isAvailable": True,
                 "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17"}]}}  # fmt: skip
            return 0, json.dumps(devices).encode()
        return 0, b""


async def settle(n=5):
    for _ in range(n):
        await asyncio.sleep(0)


async def watching(bridge=None, run=None, tmp_path=None):
    emit, run = Recorder(), run or FakeRun()
    bridge = bridge or FakeBridge()
    spawned = []

    async def spawn(udid):
        spawned.append(udid)
        return bridge

    ctl = Controller(emit, run=run, spawn=spawn, shots=tmp_path)
    await ctl.handle("sim_stream", {"udid": UDID, "width": 800, "height": 1200})
    for _ in range(50):
        await asyncio.sleep(0)
        states = emit.of("sim_status")
        if states and states[-1]["state"] != "starting":
            break
    return ctl, emit, bridge, run, spawned


# ── flow control ──


def test_stream_sends_at_most_two_frames_ahead_and_then_only_the_newest():
    emit = Recorder()
    stream = Stream(UDID, "iPhone", emit, FakeRun(), None)
    for i in range(5):
        stream.offer({"jpeg": str(i)})
    sent = emit.of("sim_frame")
    assert [f["jpeg"] for f in sent] == ["0", "1"]
    assert stream.pending == {"jpeg": "4"}  # 2 and 3 were overtaken, never queued
    stream.ack(1)
    assert [f["jpeg"] for f in emit.of("sim_frame")] == ["0", "1", "4"]
    assert [f["seq"] for f in emit.of("sim_frame")] == [1, 2, 3]
    assert stream.pending is None


def test_stream_treats_long_unanswered_frames_as_lost(monkeypatch):
    emit = Recorder()
    stream = Stream(UDID, "iPhone", emit, FakeRun(), None)
    clock = [100.0]
    monkeypatch.setattr(simulator.time, "monotonic", lambda: clock[0])
    stream.offer({"jpeg": "a"})
    stream.offer({"jpeg": "b"})
    stream.offer({"jpeg": "c"})
    assert len(emit.of("sim_frame")) == 2
    clock[0] += simulator.ACK_GRACE + 0.1
    stream.offer({"jpeg": "d"})
    assert [f["jpeg"] for f in emit.of("sim_frame")] == ["a", "b", "d"]


def test_stale_or_future_acks_change_nothing():
    stream = Stream(UDID, "iPhone", Recorder(), FakeRun(), None)
    stream.offer({"jpeg": "a"})
    stream.ack(7)
    stream.ack(-1)
    assert stream.acked == 0


# ── the controller ──


async def test_watching_starts_a_bridge_upright_and_streams_frames(tmp_path):
    ctl, emit, bridge, _run, spawned = await watching(tmp_path=tmp_path)
    assert spawned == [UDID]
    assert bridge.ops("orient") == [{"op": "orient", "orientation": 1}]
    assert bridge.ops("stream")[0]["box"] == [800, 1200]
    status = emit.of("sim_status")[-1]
    assert status["state"] == "live" and status["input"] is True
    assert status["name"] == "iPhone 17" and status["points"] == [402, 874]

    bridge.frame(orientation=3)
    await settle()
    frame = emit.of("sim_frame")[-1]
    assert frame["seq"] == 1 and frame["udid"] == UDID
    assert (frame["width"], frame["height"], frame["orientation"]) == (8, 4, 3)
    assert base64.b64decode(frame["jpeg"]) == TINY_JPEG
    await ctl.close()


async def test_input_goes_to_the_bridge_only_when_well_formed(tmp_path):
    ctl, _emit, bridge, _run, _ = await watching(tmp_path=tmp_path)
    await ctl.handle("sim_touch", {"phase": "down", "x": 0.25, "y": 0.5})
    await ctl.handle("sim_touch", {"phase": "move", "x": 0.3, "y": 0.5, "x2": 0.7, "y2": 0.5})
    await ctl.handle("sim_touch", {"phase": "hover", "x": 0.3, "y": 0.5})  # not a phase
    await ctl.handle("sim_touch", {"phase": "up", "x": "left"})  # not a number
    touches = bridge.ops("touch")
    assert touches == [
        {"op": "touch", "phase": "down", "x": 0.25, "y": 0.5},
        {"op": "touch", "phase": "move", "x": 0.3, "y": 0.5, "x2": 0.7, "y2": 0.5},
    ]
    await ctl.handle("sim_button", {"name": "home"})
    await ctl.handle("sim_button", {"name": "app_switcher"})
    await ctl.handle("sim_button", {"name": "self_destruct"})
    assert bridge.ops("button") == [
        {"op": "button", "name": "home", "state": "press"},
        {"op": "button", "name": "home", "state": "press", "times": 2},
    ]
    await ctl.handle("sim_key", {"usage": 4, "down": True})
    await ctl.handle("sim_key", {"usage": 4})
    await ctl.handle("sim_key", {"usage": 999, "down": True})
    assert bridge.ops("key") == [
        {"op": "key", "usage": 4, "state": "down"},
        {"op": "key", "usage": 4, "state": "up"},
    ]
    await ctl.handle("sim_rotate", {"dir": "left"})
    await ctl.handle("sim_rotate", {"dir": "sideways"})
    assert bridge.ops("rotate") == [{"op": "rotate", "dir": "left"}]
    await ctl.close()


async def test_typing_goes_key_by_key_or_through_the_pasteboard(tmp_path):
    ctl, _emit, bridge, run, _ = await watching(tmp_path=tmp_path)
    await ctl.handle("sim_type", {"text": "Hi!"})
    await settle()
    assert bridge.ops("type") == [{"op": "type", "keys": [[11, True], [12, False], [30, True]]}]
    await ctl.handle("sim_type", {"text": "Grüße 你好"})
    await settle()
    pbcopy = [c for c in run.calls if "pbcopy" in c[0]]
    assert pbcopy and pbcopy[0][0][-1] == UDID and pbcopy[0][1] == "Grüße 你好".encode()
    assert bridge.ops("paste") == [{"op": "paste"}]
    await ctl.close()


async def test_a_view_only_bridge_takes_no_input(tmp_path):
    ctl, emit, bridge, _run, _ = await watching(FakeBridge(can_input=False), tmp_path=tmp_path)
    assert emit.of("sim_status")[-1]["state"] == "view-only"
    await ctl.handle("sim_touch", {"phase": "down", "x": 0.5, "y": 0.5})
    await ctl.handle("sim_button", {"name": "home"})
    assert bridge.ops("touch") == [] and bridge.ops("button") == []
    await ctl.close()


async def test_without_a_bridge_it_falls_back_to_simctl_pictures(tmp_path, monkeypatch):
    monkeypatch.setattr(simulator, "READY_TIMEOUT", 0.05)
    emit, run = Recorder(), FakeRun()

    async def broken(_udid):
        raise OSError("no python")

    ctl = Controller(emit, run=run, spawn=broken, shots=tmp_path)
    await ctl.handle("sim_stream", {"udid": UDID})
    for _ in range(40):
        await asyncio.sleep(0.01)
        if emit.of("sim_frame"):
            break
    assert emit.of("sim_status")[-1]["state"] == "view-only"
    frame = emit.of("sim_frame")[0]
    assert (frame["width"], frame["height"]) == (8, 4)
    assert any("screenshot" in c[0] for c in run.calls)
    await ctl.close()


async def test_a_bridge_that_dies_leaves_a_view_only_picture(tmp_path):
    ctl, emit, bridge, _run, _ = await watching(tmp_path=tmp_path)
    bridge.stdout.feed_eof()  # the simulator shut down under it
    for _ in range(40):
        await asyncio.sleep(0.01)
        if emit.of("sim_status")[-1]["state"] == "view-only":
            break
    assert emit.of("sim_status")[-1]["state"] == "view-only"
    assert ctl._live() is None
    await ctl.close()


async def test_switching_devices_stops_the_old_bridge(tmp_path):
    ctl, emit, first, _run, spawned = await watching(tmp_path=tmp_path)
    second = FakeBridge()

    async def spawn(udid):
        spawned.append(udid)
        return second

    ctl._spawn = spawn
    await ctl.handle("sim_stream", {"udid": OTHER})
    for _ in range(50):
        await asyncio.sleep(0)
        if ctl.stream is not None and ctl.stream.udid == OTHER and ctl.stream.live:
            break
    assert spawned == [UDID, OTHER]
    assert first.returncode == 0  # asked to quit and waited for
    assert ctl.stream.udid == OTHER
    await ctl.handle("sim_stream", {"udid": ""})
    await settle(20)
    assert ctl.stream is None and second.returncode == 0
    assert emit.of("sim_status")[-1]["state"] == "stopped"


async def test_same_device_again_only_resizes(tmp_path):
    ctl, _emit, bridge, _run, spawned = await watching(tmp_path=tmp_path)
    await ctl.handle("sim_stream", {"udid": UDID, "width": 400, "height": 900})
    await settle()
    assert spawned == [UDID]
    assert bridge.ops("stream")[-1]["box"] == [400, 900]
    await ctl.close()


async def test_acks_reach_the_stream(tmp_path):
    ctl, emit, bridge, _run, _ = await watching(tmp_path=tmp_path)
    for _ in range(4):
        bridge.frame()
    await settle()
    assert len(emit.of("sim_frame")) == 2
    await ctl.handle("sim_ack", {"seq": 2})
    assert len(emit.of("sim_frame")) == 3
    await ctl.handle("sim_ack", {"seq": "x"})  # ignored, not an error
    await ctl.close()


async def test_odd_numbers_from_the_window_are_ignored_not_errors(tmp_path):
    ctl, emit, bridge, _run, spawned = await watching(tmp_path=tmp_path)
    for _ in range(3):
        bridge.frame()
    await settle()
    for seq in (float("inf"), float("-inf"), float("nan"), [1], None):
        assert await ctl.handle("sim_ack", {"seq": seq})  # handled: no traceback
    assert len(emit.of("sim_frame")) == 2  # none of them counted as an answer
    await ctl.handle("sim_stream", {"udid": UDID, "width": float("inf"), "height": 900})
    await settle()
    assert spawned == [UDID]  # the same device: only its box changed, to the default width
    assert bridge.ops("stream")[-1]["box"] == [simulator.DEFAULT_BOX[0], 900]
    assert not emit.of("sim_error")
    await ctl.close()


async def test_screenshot_through_the_bridge(tmp_path):
    ctl, emit, bridge, _run, _ = await watching(tmp_path=tmp_path)
    await ctl.handle("sim_screenshot", {})
    await settle()
    shot = bridge.ops("shot")[0]
    assert Path(shot["path"]).parent == tmp_path and shot["path"].endswith(".png")
    bridge.say({"event": "shot", "ok": True, "path": shot["path"]})
    for _ in range(20):
        await asyncio.sleep(0)
        if emit.of("sim_shot"):
            break
    assert emit.of("sim_shot")[0]["path"] == shot["path"]
    await ctl.close()


async def test_links_apps_and_launches(tmp_path):
    listapps = json.dumps({"com.example.app": {"ApplicationType": "User", "CFBundleName": "App"}})
    run = FakeRun({"listapps": (0, b"old-style plist"), "plutil": (0, listapps.encode())})
    ctl, emit, _bridge, run, _ = await watching(run=run, tmp_path=tmp_path)

    await ctl.handle("sim_open_url", {"url": "myapp://home"})
    await ctl.handle("sim_open_url", {"url": "not a link"})
    await ctl.handle("sim_launch", {"bundle": "com.example.app"})
    await ctl.handle("sim_launch", {"bundle": "rm -rf /"})
    await ctl.handle("sim_apps", {})
    await settle(20)
    commands = [c[0] for c in run.calls]
    assert ("xcrun", "simctl", "openurl", UDID, "myapp://home") in commands
    assert ("xcrun", "simctl", "launch", UDID, "com.example.app") in commands
    assert not any("rm -rf /" in c for c in commands)
    assert emit.of("sim_error")[0]["message"] == "That isn't a link."
    plutil = next(c for c in run.calls if c[0][0] == "plutil")
    assert plutil[1] == b"old-style plist"
    assert emit.of("sim_apps")[-1]["apps"] == [
        {"bundle": "com.example.app", "name": "App", "user": True}
    ]
    await ctl.close()


async def test_install_takes_only_a_built_app(tmp_path):
    ctl, emit, _bridge, run, _ = await watching(tmp_path=tmp_path)
    app = tmp_path / "Demo.app"
    app.mkdir()
    await ctl.handle("sim_install", {"path": str(app)})
    await ctl.handle("sim_install", {"path": str(tmp_path / "notes.txt")})
    await settle(20)
    assert ("xcrun", "simctl", "install", UDID, str(app)) in [c[0] for c in run.calls]
    assert emit.of("sim_installed")[0]["name"] == "Demo"
    assert emit.of("sim_error")[0]["message"] == "Pick a built .app to install."
    await ctl.close()


async def test_list_and_boot(tmp_path):
    emit, run = Recorder(), FakeRun()
    ctl = Controller(emit, run=run, spawn=None, shots=tmp_path)
    await ctl.handle("sim_list", {})
    await ctl.handle("sim_boot", {"udid": UDID})
    await ctl.handle("sim_boot", {"udid": "; reboot"})
    await settle(20)
    assert emit.of("sim_list")[0]["devices"][0]["udid"] == UDID
    boots = [c[0] for c in run.calls if "boot" in c[0]]
    assert boots == [("xcrun", "simctl", "boot", UDID)]
    assert not emit.of("sim_error")


async def test_other_commands_are_not_the_simulators():
    ctl = Controller(Recorder(), run=FakeRun(), spawn=None)
    assert await ctl.handle("term_open", {}) is False
    assert await ctl.handle("sim_nonsense", {}) is False
    # Nothing is watched, but it's still the simulator's command.
    assert await ctl.handle("sim_touch", {"phase": "down", "x": 0, "y": 0}) is True


async def test_stop_is_safe_with_nothing_watched():
    ctl = Controller(Recorder(), run=FakeRun(), spawn=None)
    ctl.stop()
    await ctl.close()


# ── the bridge's own dispatch, with the frameworks stubbed out ──


class FakeHid:
    def __init__(self):
        self.sent = []

    def send(self, message):
        self.sent.append(message)


def bare_bridge(orientation=1):
    bridge = simulator.Bridge.__new__(simulator.Bridge)
    bridge.hid = FakeHid()
    bridge.orientation = orientation
    bridge._edge = simulator.EDGE_NONE
    bridge._force = False
    bridge.quit = __import__("threading").Event()
    bridge.wake = __import__("threading").Event()
    return bridge


def test_bridge_touches_turn_with_the_device_and_keep_their_edge(monkeypatch):
    bridge = bare_bridge(orientation=3)
    bridge.handle({"op": "touch", "phase": "down", "x": 0.5, "y": 0.995})
    bridge.handle({"op": "touch", "phase": "move", "x": 0.5, "y": 0.5})
    first, second = (m["payload"] for m in bridge.hid.sent)
    # Landscape left: the picture's bottom edge is the framebuffer's left one.
    assert first["pointOne"]["x"] == pytest.approx(0.005) and first["edge"] == simulator.EDGE_LEFT
    assert second["edge"] == simulator.EDGE_LEFT  # the whole swipe, not just its start


def test_bridge_press_type_and_paste_send_matching_downs_and_ups(monkeypatch):
    monkeypatch.setattr(simulator.time, "sleep", lambda _s: None)
    bridge = bare_bridge()
    bridge.handle({"op": "button", "name": "home", "state": "press", "times": 2})
    states = [m["payload"]["state"] for m in bridge.hid.sent]
    assert states == [1, 2, 1, 2]
    bridge.hid.sent.clear()
    bridge.handle({"op": "type", "keys": [[4, True]]})
    assert [(m["payload"]["usageCode"], m["payload"]["state"]) for m in bridge.hid.sent] == [
        (simulator.SHIFT, 1), (4, 1), (4, 2), (simulator.SHIFT, 2)
    ]  # fmt: skip
    bridge.hid.sent.clear()
    bridge.handle({"op": "paste"})
    assert [m["payload"]["usageCode"] for m in bridge.hid.sent] == [
        simulator.COMMAND, simulator.KEY_V, simulator.KEY_V, simulator.COMMAND
    ]  # fmt: skip


def test_bridge_quit_command_sets_quit():
    bridge = bare_bridge()
    bridge.handle({"op": "quit"})
    assert bridge.quit.is_set()


def test_a_bridge_with_nothing_to_stream_waits_instead_of_polling(monkeypatch):
    """A Jarvis Code session's bridge (input and pictures, no frames) used to wake sixty
    times a second for nothing. It now sleeps until a stream or a quit; a stream asked for
    starts at once, and a quit (or the hub going away) still ends it at once."""
    import io
    import os
    import threading
    import time

    class Counted(threading.Event):
        def __init__(self):
            super().__init__()
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            return super().wait(timeout)

    monkeypatch.setattr(simulator, "IDLE_WAIT", 60.0)  # only a stream or a quit wakes it
    bridge = bare_bridge()
    bridge.quit, bridge.wake = Counted(), Counted()
    bridge.out, bridge.out_lock = io.BytesIO(), threading.Lock()
    bridge.points, bridge.pixels = (393, 852), (1179, 2556)
    bridge.scale, bridge.family = 3.0, "iPhone"
    bridge.streaming = False
    bridge.hid.connect = lambda: None
    looked = []
    bridge.frame = lambda: looked.append(time.monotonic()) and False
    read, write = os.pipe()
    stdin, hub = os.fdopen(read), os.fdopen(write, "w")
    loop = threading.Thread(target=bridge.run, args=(stdin,), daemon=True)
    loop.start()
    began = time.monotonic()
    while not bridge.wake.waits and time.monotonic() - began < 10:
        time.sleep(0.005)  # until the loop is waiting
    time.sleep(0.3)
    assert bridge.quit.waits == 0 and bridge.wake.waits == 1  # not ~18 looks
    assert not looked
    asked = time.monotonic()
    hub.write(json.dumps({"op": "stream", "on": True, "box": [600, 1300]}) + "\n")
    hub.flush()
    while not looked and time.monotonic() - asked < 10:
        time.sleep(0.005)
    assert looked  # woken by the stream, long before the minute's wait was up
    hub.write(json.dumps({"op": "stream", "on": False}) + "\n")
    hub.flush()
    time.sleep(0.1)
    hub.close()  # the hub went away: stdin ends, and the waiting loop with it
    loop.join(10)
    assert not loop.is_alive() and bridge.quit.is_set()
