"""An Eden Code session's iOS Simulator tools: input and pictures through the fast bridge
(the pane's when it streams the device, else one of their own), an xcodebuild build that
installs and launches, and the app's log. The simulator, its bridge and every command are
faked: nothing here touches a real simulator."""

import asyncio
import json
import struct
from pathlib import Path

from jarvis import codetests, simtools, simulator
from jarvis.simtools import SimHands

UDID = "11111111-2222-3333-4444-555555555555"


def jpeg(width, height):
    return b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", height, width) + b"\x00" * 20


class FakeController:
    def __init__(self, booted=True, stream=None):
        self.booted = booted
        self.stream = stream

    async def devices(self):
        state = "Booted" if self.booted else "Shutdown"
        return [{"udid": UDID, "name": "iPhone 17 Pro", "state": state, "os": "iOS 27.0"}]


class FakeStream:
    """The pane's own live stream of the device."""

    def __init__(self):
        self.udid, self.live, self.closed = UDID, True, False
        self.ops = []

    def command(self, op):
        self.ops.append(op)
        return True

    async def screenshot(self, path):
        Path(path).write_bytes(b"PNG")
        return True


class FakeBridgeProc:
    """The bridge process: records its commands, answers a picture, says it's ready."""

    def __init__(self, can_input=True):
        self.stdout = asyncio.StreamReader()
        self.stdin = self
        self.ops = []
        self.returncode = None
        self._say(
            {"event": "ready", "input": can_input, "message": "" if can_input else "no dtuhidd"}
        )

    def _say(self, event):
        self.stdout.feed_data(
            simulator.encode_record(simulator.JSON_RECORD, json.dumps(event).encode())
        )

    def write(self, data):
        op = json.loads(data)
        self.ops.append(op)
        if op["op"] == "shot":
            Path(op["path"]).write_bytes(b"PNG")
            self._say({"event": "shot", "ok": True, "path": op["path"]})
        elif op["op"] == "quit":
            self.returncode = 0
            self.stdout.feed_eof()

    async def wait(self):
        return 0

    def kill(self):
        self.returncode = -9


class Runs:
    """Every helper run, answered from a script."""

    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    async def __call__(self, *argv, cwd=None, timeout=60, stdin=None):
        self.calls.append((argv, stdin))
        if argv[0] == "sips":
            Path(argv[-1]).write_bytes(jpeg(512, 1100))
            return 0, ""
        for key, answer in self.answers.items():
            if key in " ".join(argv):
                return answer
        return 0, ""


def hands_with(controller=None, runs=None, can_input=True):
    spawned = []

    async def spawn(udid):
        proc = FakeBridgeProc(can_input)
        spawned.append(proc)
        return proc

    hands = SimHands(controller or FakeController(), run=runs or Runs(), spawn=spawn)
    return hands, spawned


def tools(hands, project=Path("/tmp")):
    return {t.name: t.handler for t in simtools.sim_tools(hands, lambda: project)}


async def test_a_look_is_a_fast_picture_and_taps_land_where_claude_saw(tmp_path):
    hands, spawned = hands_with()
    t = tools(hands)
    early = await t["sim_tap"]({"x": 10, "y": 10})
    assert early.get("is_error") and "Look first" in early["content"][0]["text"]
    look = await t["sim_look"]({})
    assert look["content"][0]["text"].startswith("iPhone 17 Pro (iOS 27.0): a 512x1100 px picture")
    assert look["content"][1]["mimeType"] == "image/jpeg"
    [bridge] = spawned
    assert bridge.ops[0]["op"] == "shot"  # from the framebuffer, not simctl
    await t["sim_tap"]({"x": 256, "y": 275})
    down, up = bridge.ops[-2:]
    assert down == {"op": "touch", "phase": "down", "x": 0.5, "y": 0.25}
    assert up["phase"] == "up" and (up["x"], up["y"]) == (0.5, 0.25)
    await t["sim_swipe"]({"x1": 256, "y1": 1000, "x2": 256, "y2": 100})
    phases = [op["phase"] for op in bridge.ops if op["op"] == "touch"][2:]
    assert (
        phases[0] == "down" and phases[-1] == "up" and phases.count("move") == simtools.SWIPE_STEPS
    )
    await hands.close()
    assert bridge.ops[-1] == {"op": "quit"}


async def test_the_panes_stream_is_used_when_it_shows_the_device():
    stream = FakeStream()
    hands, spawned = hands_with(FakeController(stream=stream))
    t = tools(hands)
    await t["sim_look"]({})
    await t["sim_button"]({"button": "app_switcher"})
    assert spawned == []  # one bridge: the pane's
    assert stream.ops == [{"op": "button", "name": "home", "state": "press", "times": 2}]
    assert (await t["sim_button"]({"button": "power off"})).get("is_error")


async def test_typing_by_keys_or_by_the_pasteboard():
    runs = Runs()
    hands, spawned = hands_with(runs=runs)
    t = tools(hands)
    await t["sim_type"]({"text": "Hi!"})
    [bridge] = spawned
    assert bridge.ops[-1]["op"] == "type" and len(bridge.ops[-1]["keys"]) == 3
    await t["sim_type"]({"text": "café 你好"})
    assert bridge.ops[-1] == {"op": "paste"}
    assert (("xcrun", "simctl", "pbcopy", UDID), "café 你好") in runs.calls


async def test_without_a_booted_simulator_or_input_it_says_so():
    hands, _ = hands_with(FakeController(booted=False))
    t = tools(hands)
    for name, args in (
        ("sim_look", {}),
        ("sim_button", {"button": "home"}),
        ("sim_type", {"text": "x"}),
    ):
        out = await t[name](args)
        assert out.get("is_error") and "No simulator is booted" in out["content"][0]["text"], name
    hands, _ = hands_with(can_input=False)
    out = await tools(hands)["sim_button"]({"button": "home"})
    assert out.get("is_error") and "isn't available here (no dtuhidd)" in out["content"][0]["text"]


SETTINGS = json.dumps(
    [
        {"target": "AppTests", "buildSettings": {"WRAPPER_EXTENSION": "xctest"}},
        {
            "target": "App",
            "buildSettings": {
                "WRAPPER_EXTENSION": "app",
                "TARGET_BUILD_DIR": "/Users/x/DerivedData/App/Build/Products/Debug-iphonesimulator",
                "FULL_PRODUCT_NAME": "App.app",
                "PRODUCT_BUNDLE_IDENTIFIER": "com.example.app",
            },
        },
    ]
)


async def test_build_and_run_builds_installs_and_launches(tmp_path):
    (tmp_path / "App.xcodeproj").mkdir()
    runs = Runs(
        {
            "-list -json": (0, '{"project": {"schemes": ["App", "AppTests"]}}'),
            "-showBuildSettings": (0, SETTINGS),
        }
    )
    hands, _ = hands_with(runs=runs)
    out = await tools(hands, tmp_path)["sim_build_run"]({})
    text = out["content"][0]["text"]
    assert not out.get("is_error"), text
    assert text == "Built App, installed App.app and launched com.example.app on iPhone 17 Pro."
    argvs = [" ".join(a) for a, _ in runs.calls]
    build = next(a for a in argvs if a.endswith(" build"))
    assert (
        f"-project App.xcodeproj -scheme App -configuration Debug -destination platform=iOS Simulator,id={UDID}"
        in build
    )
    assert any(a.startswith(f"xcrun simctl install {UDID} /Users/x/DerivedData") for a in argvs)
    assert argvs[-1] == f"xcrun simctl launch --terminate-running-process {UDID} com.example.app"


async def test_a_failed_build_says_its_errors(tmp_path):
    (tmp_path / "App.xcworkspace").mkdir()
    error = f"{tmp_path}/App/ContentView.swift:12:9: error: cannot find 'Foo' in scope"
    runs = Runs(
        {
            "-list -json": (0, '{"workspace": {"schemes": ["App"]}}'),
            " build": (65, f"{error}\n{error}\n** BUILD FAILED **"),
        }
    )
    hands, _ = hands_with(runs=runs)
    out = await tools(hands, tmp_path)["sim_build_run"]({})
    text = out["content"][0]["text"]
    assert out.get("is_error") and "App/ContentView.swift:12: cannot find 'Foo' in scope" in text
    assert text.count("cannot find") == 1 and "<build-output>" in text
    empty = tmp_path / "empty"
    empty.mkdir()
    out = await tools(hands, empty)["sim_build_run"]({})
    assert "no Xcode workspace or project" in out["content"][0]["text"]


def test_which_scheme_to_build():
    assert codetests.pick_scheme(["App"], "App.xcodeproj") == "App"
    assert codetests.pick_scheme(["Shop", "Admin", "ShopTests"], "Shop.xcworkspace") == "Shop"
    assert codetests.pick_scheme(["Client", "ClientTests"], "X.xcodeproj") == "Client"
    assert codetests.pick_scheme(["A", "B"], "X.xcodeproj") == ""
    assert codetests.pick_scheme(["A", "B"], "X.xcodeproj", "B") == "B"
    assert codetests.pick_scheme(["A", "B"], "X.xcodeproj", "C") == ""
    assert simtools.app_from_settings("junk") is None


async def test_the_apps_log_is_bounded_and_marked_as_its_data():
    listing = {"com.example.app": {"CFBundleExecutable": "Shop", "ApplicationType": "User"}}
    runs = Runs(
        {
            "listapps": (0, "old-style plist"),
            "plutil": (0, json.dumps(listing)),
            "log stream": (
                0,
                "Filtering the log data using ...\nTimestamp Ty Process\n2026 Df Shop[1] loaded 3 items\n",
            ),
        }
    )
    hands, _ = hands_with(runs=runs)
    out = await tools(hands)["sim_logs"]({"bundle_id": "com.example.app", "seconds": 99})
    text = out["content"][0]["text"]
    assert text == "com.example.app, 30 s:\n<app-log>\n2026 Df Shop[1] loaded 3 items\n</app-log>"
    stream = next(a for a, _ in runs.calls if "stream" in a)
    assert (
        stream[stream.index("--predicate") + 1]
        == 'subsystem BEGINSWITH "com.example.app" OR process == "Shop"'
    )
    assert stream[stream.index("--timeout") + 1] == "30s"
    assert (await tools(hands)["sim_logs"]({"bundle_id": "x; rm -rf /"})).get("is_error")
    assert simtools.log_predicate("com.a.b", 'evil" OR 1') == 'subsystem BEGINSWITH "com.a.b"'


def test_the_cards_say_what_each_step_does(tmp_path):
    (tmp_path / "Shop.xcodeproj").mkdir()
    cards = simtools.FEATURE_TOOLS
    verb, detail = cards["mcp__jarvis_ios__sim_tap"]
    assert verb == "use the iOS Simulator"
    assert (
        detail({"x": 120, "y": 480, "long": True}, tmp_path)
        == "tap at 120, 480 of the latest picture (held: a long press)"
    )
    verb, detail = cards["mcp__jarvis_ios__sim_build_run"]
    assert verb == "build and run the app in the iOS Simulator"
    assert detail({}, tmp_path).startswith(
        "xcodebuild Shop.xcodeproj, its app scheme: build for the booted simulator"
    )
    assert "mcp__jarvis_ios__sim_look" not in cards  # looking never asks
