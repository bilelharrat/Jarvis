"""JARVIS's hands on a Windows PC: apps, web pages, media, volume, the time and the battery.

The same tool names as mac_tools.py (the server is also called "mac" so every rule written
about open_app or open_url holds here too), done with what Windows has: the Start menu's own
list of apps, the default browser, the media keys. What the Mac has and Windows doesn't
(Notes, Shortcuts, Messages and Mail) is not here; email is features/winmail.py and the calendar is wincal.py.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .mac_tools import (
    SERVER_NAME,
    ToolFailure,
    _guarded,
    edit_event,
    find_free_slots,
    list_events,
    make_create_event,
    remove_event,
)

AUTO_ALLOWED = [
    "open_app",
    "system_status",
    "media_control",
    "set_volume",
    "snap_window",
    "list_events",
    "find_free_slots",
]
NEEDS_CONFIRMATION = ["create_event", "edit_event", "remove_event"]
APPS_SECONDS = 600  # the Start menu's list is read again after this
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

GET_APPS = "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"


@dataclass
class StartApp:
    name: str
    app_id: str


_apps: tuple[float, list[StartApp]] | None = None


def start_apps(force: bool = False) -> list[StartApp]:
    """Every app in the Start menu (classic programs and Store apps) as Windows lists them."""
    global _apps
    if _apps and not force and time.monotonic() - _apps[0] < APPS_SECONDS:
        return _apps[1]
    try:
        out = subprocess.run(  # noqa: S603
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", GET_APPS],
            capture_output=True, text=True, timeout=30, check=False, creationflags=NO_WINDOW, encoding="utf-8", errors="replace",
        ).stdout.strip()  # fmt: skip
        raw = json.loads(out or "[]")
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise ToolFailure("I couldn't read the list of apps.") from exc
    if isinstance(raw, dict):
        raw = [raw]
    found = [
        StartApp(str(a.get("Name") or ""), str(a.get("AppID") or ""))
        for a in raw
        if isinstance(a, dict) and a.get("Name") and a.get("AppID")
    ]
    _apps = (time.monotonic(), found)
    return found


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def match_app(wanted: str, apps: list[StartApp]) -> StartApp | list[StartApp] | None:
    """The app a spoken name means: an exact name, else one that starts with it, else one
    with all its words. A list when more than one fits equally; None when none does."""
    want = _norm(wanted)
    if not want:
        return None
    for fits in (
        lambda n: n == want,
        lambda n: n.startswith(want + " ") or n.startswith(want),
        lambda n: all(w in n.split() for w in want.split()),
        lambda n: want in n,
    ):
        hits = [a for a in apps if fits(_norm(a.name))]
        if len(hits) == 1:
            return hits[0]
        if hits:
            names = {_norm(a.name) for a in hits}
            return hits[0] if len(names) == 1 else sorted(hits, key=lambda a: len(a.name))
    return None


def launch(app: StartApp) -> None:
    subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{app.app_id}"], creationflags=NO_WINDOW)  # noqa: S603


@tool(
    "open_app",
    "Open or bring forward an app on this PC by name, e.g. Outlook, Notepad or Calculator.",
    {"name": str},
)
@_guarded
async def open_app(args):
    name = args["name"].strip()
    if not name or "/" in name or "\\" in name:
        raise ValueError("Give an application name, not a path.")
    try:
        apps = await asyncio.to_thread(start_apps)
    except ToolFailure:
        apps = []
    found = match_app(name, apps)
    if isinstance(found, list):
        shown = ", ".join(a.name for a in found[:5])
        raise ToolFailure(f"Several apps fit “{name}”: {shown}. Which one?")
    if found is not None:
        await asyncio.to_thread(launch, found)
        return f"Opened {found.name}."
    program = shutil.which(name) or shutil.which(f"{name}.exe")
    if program:
        subprocess.Popen([program], creationflags=NO_WINDOW)  # noqa: S603
        return f"Opened {name}."
    raise ToolFailure(f"I couldn't find an app called {name} on this PC.")


@tool("open_url", "Open a web page in the default browser.", {"url": str})
@_guarded
async def open_url(args):
    url = args["url"].strip()
    if not re.match(r"^(https?://|mailto:)", url, re.I):
        raise ValueError("Give a web address that starts with http or https.")
    await asyncio.to_thread(webbrowser.open, url)
    return f"Opened {url}."


@tool("system_status", "Current local date and time, and battery level.", {})
@_guarded
async def system_status(_args):
    now = datetime.now().strftime("%A %d %B %Y, %H:%M")
    try:
        import psutil

        battery = psutil.sensors_battery()
        if battery is None:
            level = "no battery (plugged in)"
        else:
            level = f"{round(battery.percent)}%" + (", charging" if battery.power_plugged else "")
    except Exception:  # noqa: BLE001
        level = "unknown"
    return f"Local time: {now}. Battery: {level}."


MEDIA_KEYS = {
    "play": "playpause",
    "pause": "playpause",
    "toggle": "playpause",
    "next": "nexttrack",
    "previous": "previoustrack",
}


@tool(
    "media_control",
    "Control whatever is playing (Spotify, a browser, the Media app) with the PC's media keys. action: play, pause, toggle, next, previous. Play and pause both toggle.",
    {"action": str},
)
@_guarded
async def media_control(args):
    key = MEDIA_KEYS.get(args["action"].strip().lower())
    if key is None:
        raise ValueError(f"action must be one of {', '.join(MEDIA_KEYS)}")
    from . import winhands

    await asyncio.to_thread(winhands.media_key, key)
    return f"Sent {args['action']} to the media player."


@tool("set_volume", "Set the PC's output volume, 0 to 100.", {"level": int})
@_guarded
async def set_volume(args):
    level = max(0, min(100, int(args["level"])))
    from . import winhands

    def run() -> None:
        winhands.media_key("volumedown", 50)  # to silence (each press is 2%)
        if level:
            winhands.media_key("volumeup", round(level / 2))

    await asyncio.to_thread(run)
    return f"Volume set to about {level}."


SNAP_KEYS = {"left": "win+left", "right": "win+right", "full": "win+up"}


@tool(
    "snap_window",
    "Snap the window in front to the left half, the right half, or all of the screen. position: left, right or full.",
    {
        "type": "object",
        "properties": {"app": {"type": "string"}, "position": {"type": "string"}},
        "required": ["position"],
    },
)
@_guarded
async def snap_window(args):
    from . import winhands

    position = str(args.get("position", "")).strip().lower()
    if position not in SNAP_KEYS:
        raise ValueError(f"position must be one of {', '.join(SNAP_KEYS)}")
    app = str(args.get("app", "")).strip()
    if app:  # bring it forward first
        windows = await asyncio.to_thread(winhands.list_windows)
        hit = next(
            (
                w
                for w in windows
                if app.lower() in w["title"].lower() or app.lower() in (w["app"] or "").lower()
            ),
            None,
        )
        if hit is None:
            raise ToolFailure(f"No open window matches {app}.")
        await asyncio.to_thread(winhands.focus_window, hit["handle"])
    await asyncio.to_thread(winhands.post_keys, SNAP_KEYS[position])
    return (
        "The window is on the " + position + "."
        if position != "full"
        else "The window fills the screen."
    )


def build_server(default_calendar: str = "") -> Any:
    return create_sdk_mcp_server(
        name=SERVER_NAME,
        version="0.1.0",
        tools=[
            open_app,
            open_url,
            system_status,
            media_control,
            set_volume,
            snap_window,
            # The calendar (wincal.py answers calendar_kit's commands on a PC): the same tools as on a Mac.
            list_events,
            find_free_slots,
            make_create_event(default_calendar),
            edit_event,
            remove_event,
        ],
    )
