"""The see-the-screen, click and type tools, with the Mac faked: nothing is captured, no
event is posted and no script runs."""

from __future__ import annotations

import json

import pytest

from jarvis import computer


@pytest.fixture
def mac(monkeypatch):
    """The tools by name, with the mouse, keys and osascript recorded instead of done."""
    done: dict = {"mouse": [], "scroll": [], "scripts": [], "found": {"found": False}}
    monkeypatch.setattr(computer, "SETTLE", 0)
    monkeypatch.setattr(
        computer, "_post_mouse", lambda kind, x, y, *a: done["mouse"].append((kind, x, y, *a))
    )
    monkeypatch.setattr(computer, "_post_scroll", lambda dy, dx=0: done["scroll"].append(dy))

    async def run(*cmd, **_k):
        done["scripts"].append(cmd)
        return json.dumps(done["found"])

    monkeypatch.setattr(computer, "run_command", run)
    monkeypatch.setattr(computer, "create_sdk_mcp_server", lambda **k: k["tools"])
    screen = computer.Screen()
    screen.points = lambda: (1512.0, 982.0)
    screen.scale, screen.size = 1512 / 1280, (1280, 831)
    done["screen"] = screen
    done["tools"] = {t.name: t.handler for t in computer.build_server(screen)}
    return done


async def test_claude_points_in_pixels_and_gemini_on_a_grid(mac):
    screen, click = mac["screen"], mac["tools"]["click"]
    await click({"x": 640, "y": 400})
    assert mac["mouse"][-1][1:3] == pytest.approx((756, 472.5), abs=0.1)
    assert "1280x831 px" in screen.how_to_point(1280, 831)
    screen.grid = True  # Gemini answering: the middle of the screen is 500,500
    await click({"x": 500, "y": 500})
    assert mac["mouse"][-1][1:3] == pytest.approx((756, 490.8), abs=0.1)
    await click({"x": 1200, "y": -5})  # off the grid: its edge
    assert mac["mouse"][-1][1:3] == pytest.approx((1512, 0), abs=0.1)
    assert "0-1000 grid" in screen.how_to_point(1280, 831)


async def test_press_button_presses_by_name(mac):
    press = mac["tools"]["press_button"]
    mac["found"] = {"found": True, "name": "downloads", "app": "Finder"}
    out = await press({"name": "Downloads"})
    assert out["content"][0]["text"] == "Pressed “downloads” in Finder."
    assert mac["scripts"][-1][-2:] == ("Downloads", "click") and not mac["mouse"]
    # A right click, or a thing with no press action, is a real click on its middle.
    mac["found"] = {"found": True, "name": "file.txt", "app": "Finder", "x": 40, "y": 60}
    await press({"name": "file.txt", "how": "right click"})
    assert mac["mouse"] == [("click", 40.0, 60.0, "right", 1)]
    mac["found"] = {"found": False, "app": "Mail"}
    missing = await press({"name": "Archive"})
    assert missing["is_error"] and "No button" in missing["content"][0]["text"]


async def test_scroll_goes_where_it_is_pointed(mac):
    scroll = mac["tools"]["scroll"]
    mac["screen"].grid = True
    await scroll({"amount": -5.0, "x": 250, "y": 500})  # Gemini's numbers can be floats
    assert mac["mouse"][-1][0] == "move" and mac["mouse"][-1][1] == pytest.approx(378)
    assert mac["scroll"] == [-5]
    await scroll({"amount": 3})
    assert mac["scroll"] == [-5, 3] and len(mac["mouse"]) == 1
    bad = await scroll({"amount": "lots"})
    assert bad["is_error"]
