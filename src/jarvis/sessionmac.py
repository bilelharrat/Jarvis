"""The Mac for a Jarvis Code session, when the owner lets it ("Let this session use the
Mac"): computer.py's own tools, see_screen, click, press_button, type_text, press_keys and
scroll, as one of the session's MCP servers.

- Off unless the owner turns it on, for one session at a time, and never kept past a
  restart. Turning it on or off reopens the session's connection between steps.
- A hook before every call checks the switch again, so turning it off stops the session at
  once, and the Mac is looked at (see_screen) only while it's on.
- Every call follows the session's permission mode: Manual, Accept edits and Auto ask each
  time (Auto's own safety check never lets these by unasked), Plan allows no clicking or
  typing, and Bypass goes ahead only because the owner turned this on for the session.
- Never the J.A.R.V.I.S. window itself: a click or scroll there, or keys and presses while
  it's in front, are refused (its approval cards are the owner's to answer).
- computer.py's file and browser readers stay out of sessions (they read beyond the
  project); the session's own tools read its project.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import subprocess
from collections.abc import Callable
from typing import Any

from claude_agent_sdk import HookMatcher

from . import computer

log = logging.getLogger("jarvis")

SERVER = "jarvis_mac"
TOOLS = ("see_screen", "click", "press_button", "type_text", "press_keys", "scroll")
HIDDEN = ("find_files", "read_file", "browser_page")
CONTROL = frozenset({"click", "press_button", "type_text", "press_keys", "scroll"})
OWN_NAMES = frozenset({"J.A.R.V.I.S.", "Jarvis", "JARVIS"})


def tool_name(tool: str) -> str:
    return f"mcp__{SERVER}__{tool}"


def build(screen: computer.Screen | None = None) -> Any:
    """computer.py's server, as it builds it (its guards included), for one session."""
    return computer.build_server(screen or computer.Screen())


def disallowed() -> list[str]:
    return [tool_name(t) for t in HIDDEN]


# ── is it JARVIS's own window? ──


def _own_pids() -> set[int]:
    """This process and the ones that started it (uv, the app): the app's windows are its
    main process's."""
    import psutil

    pids = {os.getpid()}
    with contextlib.suppress(Exception):
        pids |= {p.pid for p in psutil.Process().parents()}
    return pids


def window_owner_at(x: float, y: float) -> tuple[int, str] | None:
    """The app whose window is on top at a point of the screen (in points)."""
    import Quartz

    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    for info in Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []:
        if float(info.get("kCGWindowAlpha", 1) or 0) <= 0:
            continue
        b = info.get("kCGWindowBounds") or {}
        left, top = float(b.get("X", 0)), float(b.get("Y", 0))
        if left <= x < left + float(b.get("Width", 0)) and top <= y < top + float(
            b.get("Height", 0)
        ):
            return int(info.get("kCGWindowOwnerPID", 0)), str(info.get("kCGWindowOwnerName", ""))
    return None


def front_app() -> tuple[int, str] | None:
    """The app in front (lsappinfo asks the window server each time)."""
    try:
        front = subprocess.run(
            ["lsappinfo", "front"], capture_output=True, text=True, timeout=3, check=False
        ).stdout.strip()
        info = subprocess.run(
            ["lsappinfo", "info", "-only", "pid", "-only", "name", front],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    pid = re.search(r'"pid"\s*=\s*(\d+)', info)
    name = re.search(r'"LSDisplayName"\s*=\s*"([^"]*)"', info) or re.search(
        r'"name"\s*=\s*"([^"]*)"', info
    )
    if pid is None:
        return None
    return int(pid.group(1)), name.group(1) if name else ""


def is_own(owner: tuple[int, str] | None, own: set[int] | None = None) -> bool:
    if owner is None:
        return False
    pid, name = owner
    return name in OWN_NAMES or pid in (own if own is not None else _own_pids())


# ── the hook before each call ──


def _decision(kind: str, why: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": kind,
            "permissionDecisionReason": why,
        }
    }


def refusal(tool: str, tool_input: dict[str, Any], screen: computer.Screen) -> str:
    """Why a call would drive the J.A.R.V.I.S. window ("" when it wouldn't). Blocking:
    run it in a thread."""
    try:
        if tool == "click" or (tool == "scroll" and tool_input.get("x") is not None):
            x, y = screen.to_points(float(tool_input.get("x", 0)), float(tool_input.get("y", 0)))
            owner = window_owner_at(x, y)
        elif tool == "scroll":
            owner = window_owner_at(*computer.mouse_position())
        elif tool in ("press_button", "type_text", "press_keys"):
            owner = front_app()
        else:
            return ""
    except (TypeError, ValueError):
        return ""
    except Exception:  # no Quartz (a test, a broken install): nothing to go on
        log.warning("couldn't tell which window a session's click would land on", exc_info=True)
        return ""
    if is_own(owner):
        return "That's the J.A.R.V.I.S. window: a session never drives it (its cards are the owner's to answer)."
    return ""


def pre_tool_hook(
    allowed: Callable[[], bool],
    mode: Callable[[], str],
    screen: computer.Screen,
    guard: Callable[[str, dict[str, Any], computer.Screen], str] = refusal,
) -> HookMatcher:
    """What runs before each of the session's Mac tools: the switch, Plan mode, JARVIS's own
    window, and then the session's permission prompt, every time."""

    async def hook(
        input_data: dict[str, Any], _tool_use_id: str | None, _context: Any
    ) -> dict[str, Any]:
        name = str(input_data.get("tool_name") or "")
        if not name.startswith(f"mcp__{SERVER}__"):
            return {}
        tool = name.rsplit("__", 1)[-1]
        if not allowed():
            return _decision("deny", "The owner turned off this session's use of the Mac.")
        if tool not in TOOLS:
            return _decision("deny", "That tool isn't for sessions.")
        if mode() == "plan" and tool in CONTROL:
            return _decision(
                "deny", "Plan mode: no clicking or typing on the Mac until the plan is approved."
            )
        tool_input = (
            input_data.get("tool_input") if isinstance(input_data.get("tool_input"), dict) else {}
        )
        why = await asyncio.to_thread(guard, tool, tool_input, screen)
        if why:
            return _decision("deny", why)
        # Asked through the session's own policy every time: Claude Code's Auto mode would
        # otherwise judge these by itself. (Bypass: the policy lets it go, as the owner chose.)
        return _decision("ask", "Operating the Mac")

    return HookMatcher(matcher=f"mcp__{SERVER}__.*", hooks=[hook])


# ── the approval cards ──


def _detail(tool: str) -> Callable[[dict[str, Any], Any], str]:
    def detail(tool_input: dict[str, Any], _cwd: Any) -> str:
        match tool:
            case "click":
                clicks = int(tool_input.get("clicks") or 1)
                how = (
                    f"{'double-' if clicks == 2 else ''}{tool_input.get('button') or 'left'} click"
                )
                return f"{how} at {tool_input.get('x')}, {tool_input.get('y')} of the latest screenshot"
            case "press_button":
                return f"press “{str(tool_input.get('name', ''))[:200]}” in the app in front"
            case "type_text":
                return f"type: {str(tool_input.get('text', ''))[:600]}"
            case "press_keys":
                return f"press {str(tool_input.get('keys', ''))[:80]}"
            case "scroll":
                return f"scroll {tool_input.get('amount')} lines"
            case _:
                return "a screenshot of the whole screen"

    return detail


FEATURE_TOOLS: dict[str, tuple[str, Callable[[dict[str, Any], Any], str]]] = {
    tool_name("see_screen"): ("look at your screen", _detail("see_screen")),
    tool_name("click"): ("click on your Mac", _detail("click")),
    tool_name("press_button"): ("press a button on your Mac", _detail("press_button")),
    tool_name("type_text"): ("type on your Mac", _detail("type_text")),
    tool_name("press_keys"): ("press keys on your Mac", _detail("press_keys")),
    tool_name("scroll"): ("scroll on your Mac", _detail("scroll")),
}
