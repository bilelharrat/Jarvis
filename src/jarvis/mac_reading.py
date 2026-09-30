"""Reading the Mac, never changing it: the displays and the part of each windows use, the
windows open, the controls of the app in front, and the text of the owner's own Safari or
Chrome page.

- Displays: Quartz's list (global points, top-left origin, as the mouse and the
  Accessibility interface count them), with AppKit's visible frame for each (the part
  under the menu bar and beside the Dock), main display first: screencapture's -D order.
  AppKit's list of screens is read in a short Python of its own: in this long-running
  process, with no AppKit run loop, it would keep the displays as they were at the start.
- Windows: Quartz's on-screen list, front to back (titles need Screen Recording).
- Controls and Chromium pages: the jarvis-axread helper (native/, built on first use with
  swiftc like the other helpers), read-only.
- Safari's page: its own AppleScript ("text of front document"), which needs no setting
  changed (unlike running JavaScript in it).
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
from collections.abc import Callable
from typing import Any

from . import mac_tools, swift_helper

log = logging.getLogger("jarvis")

HELPER = "jarvis-axread"
HELPER_SECONDS = 10.0
PAGE_LIMIT = 20_000
CONTROLS_LIMIT = 300
SAFARI = ("Safari", "com.apple.Safari")
CHROMIUM = {
    "chrome": ("Google Chrome", "com.google.Chrome"),
    "edge": ("Microsoft Edge", "com.microsoft.edgemac"),
    "brave": ("Brave Browser", "com.brave.Browser"),
    "arc": ("Arc", "company.thebrowser.Browser"),
}
SAFARI_PAGE = """tell application "Safari"
    if (count of documents) is 0 then return ""
    set d to front document
    return (URL of d) & linefeed & (name of d) & linefeed & (text of d)
end tell"""


class Unreadable(RuntimeError):
    """What can't be read, and why, in words."""


# ── displays and windows ──

Area = tuple[float, float, float, float]
# Each screen's number and visible frame, turned to global points (top-left origin: the
# first screen is the one with the menu bar, whose height sets where y starts).
VISIBLE_SCRIPT = """
import json
from AppKit import NSScreen
screens = NSScreen.screens() or []
top = float(screens[0].frame().size.height) if screens else 0.0
rows = []
for screen in screens:
    vf = screen.visibleFrame()
    rows.append([int(screen.deviceDescription()["NSScreenNumber"]), float(vf.origin.x),
                 top - float(vf.origin.y + vf.size.height), float(vf.size.width),
                 float(vf.size.height)])
print(json.dumps(rows))
"""
VISIBLE_SECONDS = 10.0


def parse_visible(out: str) -> dict[int, Area]:
    """VISIBLE_SCRIPT's answer: display number -> its visible (x, y, w, h)."""
    try:
        rows = json.loads((out or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {}
    found: dict[int, Area] = {}
    for row in rows if isinstance(rows, list) else []:
        if (
            isinstance(row, list)
            and len(row) == 5
            and all(isinstance(v, int | float) and not isinstance(v, bool) for v in row)
        ):
            found[int(row[0])] = (float(row[1]), float(row[2]), float(row[3]), float(row[4]))
    return found


def visible_frames() -> dict[int, Area]:
    """Each display's visible frame, from AppKit as it is now; {} when it can't be asked."""
    try:
        done = subprocess.run(  # noqa: S603 - this Python, a fixed script, nothing acts
            [sys.executable, "-c", VISIBLE_SCRIPT],
            capture_output=True,
            text=True,
            timeout=VISIBLE_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.info("displays: no visible frames (%s)", type(exc).__name__)
        return {}
    return parse_visible(done.stdout)


def _quartz_displays() -> list[dict[str, Any]]:
    """The active displays as the window server has them now: id, global bounds, main."""
    import Quartz

    _err, ids, count = Quartz.CGGetActiveDisplayList(16, None, None)
    if not count:  # every display asleep: the ones connected, where they'll wake
        _err, ids, count = Quartz.CGGetOnlineDisplayList(16, None, None)
    main = Quartz.CGMainDisplayID()
    rows = []
    for display in list(ids or [])[: count or 0]:
        b = Quartz.CGDisplayBounds(display)
        rows.append(
            {
                "id": int(display),
                "x": float(b.origin.x),
                "y": float(b.origin.y),
                "w": float(b.size.width),
                "h": float(b.size.height),
                "main": display == main,
            }
        )
    return rows


def displays(
    quartz: Callable[[], list[dict[str, Any]]] = _quartz_displays,
    visible: Callable[[], dict[int, Area]] = visible_frames,
) -> list[dict[str, Any]]:
    """Each display: index (screencapture's -D number), global bounds x, y, w, h, whether
    it's the main one, and visible: the (x, y, w, h) windows may fill (all of it when
    AppKit can't say)."""
    rows = sorted(quartz(), key=lambda r: not r["main"])  # the main one first, the rest in order
    areas = visible() if rows else {}
    for i, row in enumerate(rows, 1):
        row["index"] = i
        row["visible"] = areas.get(row["id"], (row["x"], row["y"], row["w"], row["h"]))
    return rows


def display_at(x: float, y: float, screens: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The display a point is on; the nearest one when it's on none."""
    if not screens:
        return None
    for s in screens:
        if s["x"] <= x < s["x"] + s["w"] and s["y"] <= y < s["y"] + s["h"]:
            return s

    def gap(s: dict[str, Any]) -> float:
        dx = max(s["x"] - x, 0, x - (s["x"] + s["w"]))
        dy = max(s["y"] - y, 0, y - (s["y"] + s["h"]))
        return dx * dx + dy * dy

    return min(screens, key=gap)


def snap_rect(position: str, area: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Where a window goes on a display's visible area: left or right half, or all of it."""
    x, y, w, h = (int(round(v)) for v in area)
    if position == "left":
        return x, y, w // 2, h
    if position == "right":
        return x + w // 2, y, w - w // 2, h
    return x, y, w, h


def windows(limit: int = 60) -> list[dict[str, Any]]:
    """The windows on screen, front to back: app, title (with Screen Recording), bounds."""
    import Quartz

    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    found = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []
    rows = []
    for info in found:
        if int(info.get(Quartz.kCGWindowLayer, 1)) != 0:
            continue  # the menu bar, the Dock, overlays
        bounds = info.get(Quartz.kCGWindowBounds) or {}
        w, h = float(bounds.get("Width", 0)), float(bounds.get("Height", 0))
        if w < 50 or h < 50:
            continue
        rows.append(
            {
                "app": str(info.get(Quartz.kCGWindowOwnerName) or ""),
                "title": str(info.get(Quartz.kCGWindowName) or ""),
                "x": float(bounds.get("X", 0)),
                "y": float(bounds.get("Y", 0)),
                "w": w,
                "h": h,
            }
        )
        if len(rows) >= limit:
            break
    return rows


# ── the Accessibility helper ──


async def run_helper(*argv: str) -> dict[str, Any]:
    """jarvis-axread's answer; Unreadable when it can't be built or doesn't answer."""
    binary = await asyncio.to_thread(swift_helper.ensure, HELPER)
    if binary is None:
        raise Unreadable(
            "The accessibility reader couldn't be built on this Mac (it needs Xcode's swiftc)."
        )
    proc = await asyncio.create_subprocess_exec(
        str(binary), *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), HELPER_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise Unreadable("The app took too long to answer.") from None
    try:
        found = json.loads(out.decode(errors="replace").strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise Unreadable("The accessibility reader gave no answer.") from None
    if not isinstance(found, dict):
        raise Unreadable("The accessibility reader gave no answer.")
    if not found.get("trusted", True):
        raise Unreadable(
            "Allow Accessibility for J.A.R.V.I.S. (System Settings > Privacy & Security > "
            "Accessibility) so I can read other apps."
        )
    return found


def describe_controls(found: dict[str, Any], limit: int = CONTROLS_LIMIT) -> str:
    """The helper's controls, one line each, indented by depth (at most four levels)."""
    head = f"{found.get('app') or 'The app in front'}"
    if found.get("window"):
        head += f" — window “{found['window']}”"
    lines = [head]
    menus = [m for m in found.get("menus") or [] if isinstance(m, str)]
    if menus:
        lines.append("Menus: " + ", ".join(menus))
    for row in (found.get("controls") or [])[:limit]:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role", "")).removeprefix("AX")
        name = (
            row.get("title") or row.get("description") or row.get("help") or row.get("placeholder")
        )
        bits = [role.lower()]
        if name:
            bits.append(f"“{name}”")
        if row.get("value") and row.get("value") != name:
            bits.append(f"= “{str(row['value'])[:120]}”")
        if row.get("enabled") is False:
            bits.append("(disabled)")
        if row.get("focused"):
            bits.append("(focused)")
        indent = "  " * min(4, max(0, int(row.get("depth") or 0) - 1))
        lines.append(f"{indent}- " + " ".join(bits))
    if found.get("truncated"):
        lines.append("(more controls than shown)")
    return "\n".join(lines)


# ── browser pages ──


async def safari_page(run=mac_tools.run_applescript) -> dict[str, Any]:
    raw = await run(SAFARI_PAGE, timeout=20)
    if not raw.strip():
        raise Unreadable("Safari has no page open.")
    url, _, rest = raw.partition("\n")
    title, _, text = rest.partition("\n")
    return {"app": "Safari", "url": url.strip(), "title": title.strip(), "text": text}


async def chromium_page(key: str, helper=run_helper) -> dict[str, Any]:
    name, bundle = CHROMIUM[key]
    found = await helper("webtext", bundle, str(PAGE_LIMIT))
    if not found.get("app"):
        raise Unreadable(f"{name} isn't open.")
    if not found.get("found"):
        raise Unreadable(f"{name} has no page open that I can read.")
    return {
        "app": str(found.get("app") or name),
        "url": str(found.get("url") or ""),
        "title": str(found.get("title") or ""),
        "text": str(found.get("text") or ""),
        "truncated": bool(found.get("truncated")),
    }


def browser_for(asked: str, front_bundle: str, running: set[str]) -> str:
    """Which browser's page to read: the one asked for; else the browser in front; else
    Safari or Chrome, whichever is open. "" when none is."""
    asked = asked.strip().lower().replace("google ", "").replace("microsoft ", "")
    if asked in ("safari", *CHROMIUM):
        return asked
    if front_bundle == SAFARI[1]:
        return "safari"
    for key, (_name, bundle) in CHROMIUM.items():
        if front_bundle == bundle:
            return key
    if SAFARI[0] in running:
        return "safari"
    for key, (name, _bundle) in CHROMIUM.items():
        if name in running:
            return key
    return ""
