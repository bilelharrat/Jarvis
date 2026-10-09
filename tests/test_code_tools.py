"""The browser and iOS Simulator tools an Eden Code session gets."""

from jarvis import code_tools
from jarvis.code_tools import browser_tools, build_servers, simulator_tools

UDID = "11111111-2222-3333-4444-555555555555"


class FakeWorkbench:
    def __init__(self, booted=True):
        self.booted = booted
        self.boots = []

    async def simulators(self):
        state = "Booted" if self.booted else "Shutdown"
        return [{"udid": UDID, "name": "iPhone 17e", "state": state, "os": "iOS 27.0"}]

    async def boot(self, udid):
        self.boots.append(udid)

    async def screenshot(self, udid):
        return "JPEG" if udid == UDID else ""


def handlers(tools):
    return {t.name: t.handler for t in tools}


async def test_browser_tools_drive_the_window_browser():
    calls = []

    async def call(action, args=None):
        calls.append((action, args))
        if action == "read":
            return {
                "title": "App",
                "url": "http://localhost:5173",
                "text": "Hello",
                "links": [],
                "fields": [],
            }
        return {"ok": True, "title": "App", "url": "http://localhost:5173"}

    b = handlers(browser_tools(call))
    await b["browser_open"]({"url": "http://localhost:5173"})
    out = await b["browser_read"]({})
    assert "Hello" in out["content"][0]["text"]
    # a session opens its own tab (owner "code" without a session id here)
    assert calls[0] == ("open", {"url": "http://localhost:5173", "newTab": True, "owner": "code"})


async def test_simulator_tools(tmp_path, monkeypatch):
    ran = []

    async def fake_simctl(*args, timeout=120):
        ran.append(args)
        return 0, ""

    monkeypatch.setattr(code_tools, "_simctl", fake_simctl)
    project = tmp_path / "App"
    app = project / "build" / "Demo.app"
    app.mkdir(parents=True)
    s = handlers(simulator_tools(FakeWorkbench(), lambda: project))
    assert "iPhone 17e" in (await s["sim_list"]({}))["content"][0]["text"]
    await s["sim_install"]({"app": "build/Demo.app"})
    assert ran[-1] == ("install", UDID, str(app.resolve()))
    outside = await s["sim_install"]({"app": "../../etc"})
    assert outside.get("is_error")
    await s["sim_launch"]({"bundle_id": "com.example.demo"})
    assert ran[-1] == ("launch", "--terminate-running-process", UDID, "com.example.demo")
    assert (await s["sim_launch"]({"bundle_id": "rm -rf /"})).get("is_error")
    assert (await s["sim_open_url"]({"url": "not a url"})).get("is_error")
    shot = await s["sim_screenshot"]({})
    assert shot["content"][0]["data"] == "JPEG"


async def test_without_a_booted_simulator(tmp_path):
    s = handlers(simulator_tools(FakeWorkbench(booted=False), lambda: tmp_path))
    assert (await s["sim_launch"]({"bundle_id": "com.example.demo"})).get("is_error")


def test_servers_and_read_only_names():
    async def call(*_a):
        return {}

    servers = build_servers(call, FakeWorkbench(), lambda: None)
    assert set(servers) == {code_tools.BROWSER, code_tools.SIMULATOR}
    assert all(name.startswith("mcp__jarvis_") for name in code_tools.READ_ONLY)
