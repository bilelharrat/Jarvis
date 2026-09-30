"""The macOS permissions JARVIS needs, their live status (tcc.py, a helper run apart from
the backend) and the System Settings pane that grants each."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import Awaitable, Callable
from typing import Any

from .tcc import AUTOMATION_APPS

log = logging.getLogger("jarvis")

# What each is for, as Setup and the checkup show it. The order is Setup's.
PERMISSIONS: list[dict[str, str]] = [
    {"id": "microphone", "title": "Microphone", "why": "To hear you."},
    {"id": "calendars", "title": "Calendars", "why": "To see and plan your day."},
    {"id": "contacts", "title": "Contacts", "why": "To know who's who when you name someone."},
    {"id": "location", "title": "Location", "why": "For local weather and travel times."},
    {
        "id": "automation",
        "title": "Automation",
        "why": "To work with Mail, Calendar, Notes and Music for you.",
    },
    {
        "id": "screen",
        "title": "Screen Recording",
        "why": "To look at your screen when you ask what's on it.",
    },
    {
        "id": "accessibility",
        "title": "Accessibility",
        "why": "To click, type and control apps when you ask.",
    },
    {
        "id": "full_disk",
        "title": "Full Disk Access",
        "why": "To read your texts and email when you ask about them.",
    },
]
PANES = {
    "microphone": "Privacy_Microphone",
    "calendars": "Privacy_Calendars",
    "contacts": "Privacy_Contacts",
    "location": "Privacy_LocationServices",
    "automation": "Privacy_Automation",
    "screen": "Privacy_ScreenCapture",
    "accessibility": "Privacy_Accessibility",
    "full_disk": "Privacy_AllFiles",
}
APP_NAMES = {
    "com.apple.mail": "Mail",
    "com.apple.iCal": "Calendar",
    "com.apple.Notes": "Notes",
    "com.apple.Music": "Music",
}
STATES = (
    "granted",
    "denied",
    "not_asked",
    "restricted",
    "limited",
    "off",
    "not_running",
    "unknown",
)
LABELS = {
    "granted": "Allowed",
    "denied": "Not allowed",
    "not_asked": "Not asked yet",
    "restricted": "Restricted on this Mac",
    "limited": "Only partly allowed",
    "off": "Not allowed yet",
    "not_running": "Open the app to check",
    "unknown": "Couldn't tell",
}
HELPER_SECONDS = 25.0  # the first run loads the frameworks from disk: seconds, once

Runner = Callable[..., Awaitable[tuple[int, str, str]]]


def settings_url(pane: str) -> str | None:
    """The System Settings address of a permission's pane (x-apple.systempreferences)."""
    anchor = PANES.get(pane)
    return f"x-apple.systempreferences:com.apple.preference.security?{anchor}" if anchor else None


async def run_process(*args: str, timeout: float = 20.0, env: dict[str, str] | None = None):
    """(exit code, stdout, stderr) of a short command, killed past timeout."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _clean(value: Any) -> str:
    return value if value in STATES else "unknown"


async def statuses(run: Runner = run_process) -> dict[str, Any]:
    """Every permission's status from the helper; all "unknown" (with why) when it can't
    say. Never raises."""
    try:
        code, out, _err = await run(
            sys.executable,
            "-m",
            "jarvis.features.ops.tcc",
            *AUTOMATION_APPS,
            timeout=HELPER_SECONDS,
        )
        data = json.loads(out.strip().splitlines()[-1]) if code == 0 and out.strip() else None
    except (OSError, TimeoutError, ValueError, IndexError) as exc:
        log.warning("permissions: the check didn't answer (%s)", type(exc).__name__)
        data = None
    if not isinstance(data, dict):
        return {
            **{p["id"]: "unknown" for p in PERMISSIONS if p["id"] != "automation"},
            "automation": {app: "unknown" for app in AUTOMATION_APPS},
            "error": "The permissions couldn't be checked just now.",
        }
    raw_apps = data.get("automation") if isinstance(data.get("automation"), dict) else {}
    return {
        **{p["id"]: _clean(data.get(p["id"])) for p in PERMISSIONS if p["id"] != "automation"},
        "automation": {app: _clean(raw_apps.get(app)) for app in AUTOMATION_APPS},
    }


def automation_state(apps: dict[str, str]) -> str:
    """One answer for the Automation row: the worst of its apps. An app that isn't open
    can't be told, so it decides only when no app could be."""
    values = set(apps.values())
    for state in ("denied", "restricted", "not_asked", "unknown"):
        if state in values:
            return state
    return "granted" if "granted" in values else "not_running"


def rows(found: dict[str, Any]) -> list[dict[str, Any]]:
    """The permissions as Setup and the checkup list them."""
    out: list[dict[str, Any]] = []
    for item in PERMISSIONS:
        pid = item["id"]
        if pid == "automation":
            apps = found.get("automation") if isinstance(found.get("automation"), dict) else {}
            state = automation_state(apps)
            detail = [
                {"app": APP_NAMES.get(app, app), "state": _clean(v), "label": LABELS[_clean(v)]}
                for app, v in apps.items()
            ]
        else:
            state, detail = _clean(found.get(pid)), []
        out.append(
            {
                "id": pid,
                "title": item["title"],
                "why": item["why"],
                "state": state,
                "label": LABELS[state],
                "hint": hint(pid, state),
                "apps": detail,
                "pane": pid,
            }
        )
    return out


# Where each is turned on, as the window says it (fixed sentences: each has its Chinese).
TURN_ON = {
    "microphone": "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Microphone.",
    "calendars": "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Calendars.",
    "contacts": "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Contacts.",
    "location": "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Location Services.",
    "automation": (
        "Turn on each app under J.A.R.V.I.S. in System Settings › Privacy & Security › Automation."
    ),
    "screen": (
        "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Screen Recording, "
        "then restart Jarvis."
    ),
    "accessibility": (
        "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Accessibility."
    ),
    "full_disk": (
        "Turn on J.A.R.V.I.S. in System Settings › Privacy & Security › Full Disk Access."
    ),
}
ASK_LATER = "macOS asks the first time Jarvis needs it, or you can allow it now in System Settings."
RESTRICTED = "Something that manages this Mac (a profile or Screen Time) keeps it off."
LOCATION_OFF = "Location Services are off for the whole Mac: turn them on in System Settings."
OPEN_APPS = "Open Mail, Calendar, Notes and Music once, then check again."
LIMITED = {
    "calendars": "Jarvis can add events but not read them: allow full access in System Settings.",
    "contacts": "Jarvis sees only some contacts: allow all of them in System Settings.",
}


def hint(pid: str, state: str) -> str:
    """What to do about one that isn't allowed, in a sentence ("" when it is)."""
    if state == "granted":
        return ""
    if state == "not_running":
        return OPEN_APPS
    if state == "restricted":
        return RESTRICTED
    if state == "limited":
        return LIMITED.get(pid, TURN_ON.get(pid, ""))
    if pid == "location" and state == "off":
        return LOCATION_OFF
    if state == "not_asked":
        return ASK_LATER
    return TURN_ON.get(pid, "")
