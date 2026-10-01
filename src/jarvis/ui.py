"""Voice control of the J.A.R.V.I.S. window itself: open and close its panels, change the
look, turn hand control on and off.

"Jarvis, open Jarvis Code", "close the browser", "switch to the HUD", "turn on hand
control" run at once without asking Claude; Claude has the same as tools for anything
said less directly.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

SERVER_NAME = "window"

# What people call each panel -> the window's name for it.
PANELS = {
    "simulator": "simulator",
    "ios simulator": "simulator",
    "the simulator": "simulator",
    "iphone simulator": "simulator",
    "jarvis code": "code",
    "the code panel": "code",
    "code panel": "code",
    "coding panel": "code",
    "browser": "browser",
    "web browser": "browser",
    "the browser": "browser",
    "research center": "research",
    "research centre": "research",
    "bsh research center": "research",
    "market breakdown": "research",
    "settings": "settings",
    "preferences": "settings",
    "second brain": "brain",
    "knowledge galaxy": "brain",
    "galaxy": "brain",
    "brain": "brain",
    "activity": "activity",
    "activity log": "activity",
    "tools and accounts": "accounts",
    "accounts": "accounts",
    "connectors": "accounts",
}
PANEL_NAMES = {
    "simulator": "the iOS Simulator",
    "code": "Jarvis Code",
    "browser": "the browser",
    "research": "the Research Center",
    "settings": "Settings",
    "brain": "the second brain",
    "activity": "the activity log",
    "accounts": "Tools & Accounts",
}
LOOKS = {
    "orb": "orb",
    "ambient orb": "orb",
    "the orb": "orb",
    "hud": "hud",
    "stark hud": "hud",
    "heads up display": "hud",
    "heads-up display": "hud",
    "command center": "console",
    "command centre": "console",
    "console": "console",
    "glass": "glass",
    "stark glass": "glass",
    "the glass look": "glass",
    "glass look": "glass",
    "all glass": "glass",
}
LOOK_NAMES = {
    "orb": "the Ambient Orb",
    "hud": "the Stark HUD",
    "console": "the Command Center",
    "glass": "Stark Glass",
}


@dataclass(frozen=True)
class Command:
    action: str  # panel | look | hands
    name: str = ""  # the panel or look
    on: bool = True  # open/close, hands on/off
    reply: str = ""


_OPEN = r"(?:open(?:\s+up)?|show(?:\s+me)?|bring\s+up|pull\s+up|launch|go\s+to|take\s+me\s+to)"
_CLOSE = r"(?:close|hide|dismiss|exit|leave|shut)"
_SUFFIX = r"(?:\s+(?:panel|window|page|view|pane|screen))?"
_LOOK = re.compile(
    r"^(?:(?:switch|change|go|flip)\s+(?:back\s+)?to|use)\s+(?:the\s+)?(?P<look>[a-z\- ]+?)"
    r"(?:\s+(?:look|view|mode|layout|theme|design))?$"
)
_HANDS = re.compile(
    r"^(?:(?:turn|switch)\s+(?P<a>on|off)\s+(?:the\s+|my\s+)?hand(?:s|\s+control|\s+tracking)?"
    r"|(?P<b>start|stop|enable|disable)\s+(?:the\s+|my\s+)?hand(?:s|\s+control|\s+tracking)?"
    r"|hand(?:s|\s+control|\s+tracking)\s+(?P<c>on|off))$"
)


def _normal(text: str) -> str:
    t = re.sub(r"\s+", " ", text.lower()).strip().strip(".!?,;: ")
    t = re.sub(r"^(?:(?:ok(?:ay)?|so|and|now|hey|jarvis)[,\s]+)+", "", t)
    t = re.sub(r"^(?:please|can you|could you|would you)\s+", "", t)
    return re.sub(r"\s+(?:please|for me)$", "", t).strip()


def _panel(words: str) -> str | None:
    key = re.sub(r"^(?:the|my)\s+", "", words.strip())
    return PANELS.get(key) or PANELS.get(re.sub(_SUFFIX + "$", "", key))


def parse(text: str) -> Command | None:
    """A direct command for the window, or None."""
    t = _normal(text)
    if not t or len(t.split()) > 7:
        return None
    if m := re.fullmatch(_OPEN + r"\s+(?P<p>.+?)" + _SUFFIX, t):
        panel = _panel(m.group("p"))
        if panel:
            return Command("panel", panel, True, f"Opening {PANEL_NAMES[panel]}.")
    if m := re.fullmatch(_CLOSE + r"\s+(?P<p>.+?)" + _SUFFIX, t):
        panel = _panel(m.group("p"))
        if panel:
            return Command("panel", panel, False, f"Closed {PANEL_NAMES[panel]}.")
    if m := _LOOK.match(t):
        look = LOOKS.get(m.group("look").strip())
        if look:
            return Command("look", look, True, f"Switched to {LOOK_NAMES[look]}.")
    if m := _HANDS.match(t):
        word = m.group("a") or m.group("b") or m.group("c")
        on = word in ("on", "start", "enable")
        return Command("hands", "", on, "Hand control on." if on else "Hand control off.")
    return None


Apply = Callable[[Command], Any]


def build_server(apply: Apply):
    def _text(text: str) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": text}]}

    @tool(
        "show_panel",
        "Open or close a part of the J.A.R.V.I.S. window: Jarvis Code (the coding panel), "
        "the browser, the Research Center, Settings, the second brain (knowledge galaxy), "
        "the activity log, or Tools & Accounts. open: false closes it.",
        {
            "type": "object",
            "properties": {"panel": {"type": "string"}, "open": {"type": "boolean"}},
            "required": ["panel"],
        },
    )
    async def show_panel(args):
        panel = _panel(str(args.get("panel", "")).lower()) or str(args.get("panel", "")).lower()
        if panel not in PANEL_NAMES:
            return _text(
                f"No panel called {args.get('panel')}. Panels: {', '.join(PANEL_NAMES.values())}."
            )
        opening = args.get("open", True) is not False
        await apply(Command("panel", panel, opening))
        return _text(f"{'Opened' if opening else 'Closed'} {PANEL_NAMES[panel]}.")

    @tool(
        "set_look",
        "Change how J.A.R.V.I.S. looks: orb (the Ambient Orb), hud (the Stark HUD), console "
        "(the Command Center) or glass (Stark Glass).",
        {"look": str},
    )
    async def set_look(args):
        look = LOOKS.get(str(args.get("look", "")).lower().strip())
        if not look:
            return _text("Looks: orb, hud, console, glass.")
        await apply(Command("look", look))
        return _text(f"Switched to {LOOK_NAMES[look]}.")

    @tool(
        "hand_control",
        "Turn hand control (the camera tracks the user's hands to steer the app) on or off.",
        {"on": bool},
    )
    async def hand_control(args):
        on = bool(args.get("on", True))
        await apply(Command("hands", "", on))
        return _text("Hand control on." if on else "Hand control off.")

    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=[show_panel, set_look, hand_control]
    )


PROMPT = (
    "\n- The window itself: show_panel opens or closes Jarvis Code, the browser, the "
    "Research Center, Settings, the second brain, the activity log or Tools & Accounts; "
    "set_look changes the look; hand_control turns hand tracking on or off. When the user "
    "says 'open Jarvis Code' or 'open the browser', they mean these panels."
)
