"""The screen and the AI model, and where the focus went (J.A.R.V.I.S. Daredevil).

While screen-reader mode is on:

- Screen contents reach the AI model only after the owner says so. a11y_screen_share is "ask"
  (the default: the first time a screen tool is used a card asks "Let Claude see your
  screen?": just this time, yes from now on, or no; a plain "yes" is just this time), "on"
  or "off". The screen tools (SCREEN_TOOLS: a screenshot, the window read as text, what has the focus, the windows open,
  the page in the browser) are stopped before they run while it isn't allowed, and the picture
  of the screen a question about it would carry (hub.ask, Settings › "Screen aware") goes only
  when it is "on". "Share my screen with Claude" and "stop sharing my screen" change it.
- Each screen read says it was sent ("Sent the screen to Claude.").
- Before a window that looks like banking, health or email is read, a spoken notice: "This
  screen has private information, reading it aloud."
- After an action that can change which app or window is in front (a click, keys, opening,
  bringing a window forward, an instant "open Safari"), a short line says where the focus is
  now ("Now in Outlook: Inbox."), when it changed. a11y_say_focus turns that off.

The lines go through hub.accessibility.say: the screen reader through the window, or JARVIS's
voice when the screen reader doesn't read the replies. With the mode off, nothing here acts.

Claude cost policy: no model call; a card and short lines only.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from typing import Any

from claude_agent_sdk import HookMatcher

from .. import osplat
from ..prefs import register_feature_pref
from .accessibility_reading import tool_short_name

log = logging.getLogger("jarvis")

SHARE = ("ask", "on", "off")
register_feature_pref("a11y_screen_share", "ask", lambda v: v if v in SHARE else None)
register_feature_pref("a11y_say_focus", True)

# The computer server's tools that send what is on the screen to the model.
SCREEN_TOOLS = frozenset(
    f"mcp__computer__{name}"
    for name in ("see_screen", "read_window", "whats_focused", "list_windows", "browser_page")
)
# Tools after which a different app or window may be in front, by their own name.
FOCUS_CHANGERS = frozenset(
    {"click", "press_button", "press_keys", "type_text", "focus_window", "open_app", "quit_app",
     "snap_window", "open_url", "browser_open", "open_document", "open_file"}
)  # fmt: skip

# What a private window's title or app name has in it.
PRIVATE = re.compile(
    r"\b(?:bank(?:ing)?|online banking|paypal|venmo|wise|revolut|monzo|chase|barclays|hsbc|lloyds|"
    r"natwest|santander|wells fargo|citi(?:bank)?|credit card|statement|balance|payments?|"
    r"invoice|tax|mortgage|loan|brokerage|crypto|wallet|"
    r"health|patient|mychart|clinic|hospital|doctor|gp|nhs|medical|medicine|medication|"
    r"pharmacy|prescription|lab results?|insurance|"
    r"mail|e-?mail|inbox|outlook|thunderbird|gmail|yahoo mail|proton ?mail|message)\b",
    re.I,
)

ASK_QUESTION = "Let Claude see your screen?"
ASK_DETAIL = (
    "To read or describe what is on your screen, its contents go to Claude, the AI model "
    "Jarvis uses. Just this time, yes from now on, or no. You can change it in Settings, "
    "Accessibility, or say “stop sharing my screen”."
)
ASK_SPOKEN = (
    "To do that I need to send what's on your screen to Claude, the AI model. "
    "Is that all right just this time, from now on, or no?"
)
DENIED = (
    "The owner hasn't let the screen's contents go to the AI model. Don't look at the screen "
    "another way. Tell them in one sentence, and that they can say “share my screen with "
    "Claude” or turn it on in Settings, Accessibility."
)
SENT = "Sent the screen to Claude."
PRIVATE_NOTICE = "This screen has private information, reading it aloud."

_ON = re.compile(
    r"^(?:please\s+)?(?:share\s+my\s+screen\s+with\s+(?:claude|the\s+ai)|let\s+(?:claude|the\s+ai|jarvis)\s+see\s+my\s+screen|"
    r"(?:allow|turn\s+on)\s+screen\s+(?:sharing|reading))\W*$",
    re.I,
)
_OFF = re.compile(
    r"^(?:please\s+)?(?:stop\s+sharing\s+my\s+screen|don'?t\s+(?:send|share)\s+my\s+screen|"
    r"(?:turn\s+off|stop)\s+screen\s+(?:sharing|reading)|(?:claude|the\s+ai)\s+(?:may|can)\s*not\s+see\s+my\s+screen)\W*$",
    re.I,
)


def front_window() -> dict[str, str]:
    """The app and window in front: {"app", "title"} ({} when it can't be told)."""
    try:
        if osplat.IS_WIN:
            from .. import winhands

            info = winhands.foreground_window()
            return {"app": str(info.get("app") or ""), "title": str(info.get("title") or "")}
        if osplat.IS_MAC:
            from ..hub import frontmost_app

            app = frontmost_app()
            if app == "their Mac":
                return {}
            title = subprocess.run(
                ["osascript", "-e", 'tell application "System Events" to get name of front window '
                 "of (first application process whose frontmost is true)"],
                capture_output=True, text=True, timeout=2,
            ).stdout.strip()  # fmt: skip
            return {"app": app, "title": title}
    except Exception:  # noqa: BLE001 - no answer is an answer: nothing is said
        return {}
    return {}


def app_name(app: str) -> str:
    """ "OUTLOOK.EXE" -> "Outlook"; "msedge.exe" -> "Edge"."""
    name = re.sub(r"\.exe$", "", str(app or ""), flags=re.I)
    known = {"msedge": "Edge", "chrome": "Chrome", "firefox": "Firefox", "winword": "Word",
             "excel": "Excel", "powerpnt": "PowerPoint", "explorer": "File Explorer",
             "outlook": "Outlook", "olk": "Outlook", "notepad": "Notepad", "acrord32": "Acrobat"}  # fmt: skip
    if name.lower() in known:
        return known[name.lower()]
    return name[:1].upper() + name[1:] if name.islower() else name


def where(front: dict[str, str]) -> str:
    """ "Outlook: Inbox - ann@example.com" as said."""
    app, title = app_name(front.get("app", "")), " ".join(str(front.get("title") or "").split())
    if title and app and app.lower() not in title.lower():
        return f"{app}: {title}"
    return title or app


def looks_private(front: dict[str, str]) -> bool:
    return bool(PRIVATE.search(f"{front.get('app', '')} {front.get('title', '')}"))


def _deny(why: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": why,
        }
    }


class ScreenGuard:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.front = front_window  # (tests give their own)
        self.last: tuple[str, str] | None = None  # where the focus was last seen

    def _a11y(self) -> Any:
        return getattr(self.hub, "accessibility", None)

    def on(self) -> bool:
        a11y = self._a11y()
        return a11y is not None and a11y.effective()

    def say(self, text: str, important: bool = False) -> None:
        a11y = self._a11y()
        if a11y is not None:
            a11y.say(text, important)

    # ── may the screen go to the model ──

    def shared_without_asking(self) -> bool:
        """For what goes without a card (the picture with a question about the screen): only
        when the owner said yes from now on. Always, with the mode off."""
        return not self.on() or self.hub.prefs.feature("a11y_screen_share") == "on"

    async def allowed(self) -> bool:
        """Whether the screen may go to the model now: asks the first time."""
        if not self.on():
            return True
        share = self.hub.prefs.feature("a11y_screen_share")
        if share in ("on", "off"):
            return share == "on"
        say = getattr(self.hub, "_say", None)
        if callable(say):
            say(ASK_SPOKEN)
        choice = await self.hub.request_approval(
            ASK_QUESTION,
            ASK_DETAIL,
            [("once", "Just this time"), ("always", "Yes, from now on"), ("deny", "No")],
        )
        if choice == "always":
            self.hub.set_feature_prefs({"a11y_screen_share": "on"})
        elif choice == "deny":
            self.hub.set_feature_prefs({"a11y_screen_share": "off"})
        log.info("screen to the model: %s", choice)
        return choice in ("always", "once")

    async def before_read(self) -> bool:
        """Before a screen read: allowed? And the notice when the window in front looks private."""
        if not await self.allowed():
            return False
        if self.on():
            front = await asyncio.to_thread(self.front)
            if front:
                self.last = (front.get("app", ""), front.get("title", ""))
                if looks_private(front):
                    self.say(PRIVATE_NOTICE, important=True)
        return True

    def after_read(self) -> None:
        self.say(SENT)

    # ── where the focus went ──

    async def focus_moved(self) -> None:
        """After something that can bring another window forward: where the focus is, when it
        changed."""
        if not self.on() or not self.hub.prefs.feature("a11y_say_focus"):
            return
        front = await asyncio.to_thread(self.front)
        if not front:
            return
        now = (front.get("app", ""), front.get("title", ""))
        if now == self.last:
            return
        self.last = now
        place = where(front)
        if place:
            self.say(f"Now in {place}.")

    # ── the conversation ──

    def on_connect(self, options: Any, _resume: str) -> None:
        hooks = {kind: list(matchers) for kind, matchers in (options.hooks or {}).items()}
        hooks.setdefault("PreToolUse", []).append(
            HookMatcher(matcher=None, hooks=[self._before], timeout=600)
        )
        hooks.setdefault("PostToolUse", []).append(HookMatcher(matcher=None, hooks=[self._after]))
        options.hooks = hooks

    async def _before(self, data: Any, _tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        if str(data.get("tool_name") or "") not in SCREEN_TOOLS:
            return {}
        if not await self.before_read():
            return _deny(DENIED)
        return {}

    async def _after(self, data: Any, _tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        name = str(data.get("tool_name") or "")
        if name in SCREEN_TOOLS and self.on():
            self.after_read()
        elif tool_short_name(name) in FOCUS_CHANGERS:
            await self.focus_moved()
        return {}

    def tool_event(self, event: dict[str, Any]) -> Any:
        """The hub's own instant control ("open Safari", "press command T"): done, then where."""
        if event.get("status") == "done" and str(event.get("id") or "").startswith(
            ("mac-", "win-")
        ):
            return self.focus_moved()
        return None

    # ── said at once ──

    async def instant(self, words: str) -> str | None:
        text = " ".join(str(words or "").split())
        if _ON.match(text):
            self.hub.set_feature_prefs({"a11y_screen_share": "on"})
            return "From now on, when you ask about your screen, what's on it goes to Claude, and I'll say each time."
        if _OFF.match(text):
            self.hub.set_feature_prefs({"a11y_screen_share": "off"})
            return "Your screen won't be sent to Claude. Say “share my screen with Claude” to allow it again."
        return None


def install(hub: Any) -> None:
    guard = ScreenGuard(hub)
    hub.screen_guard = guard
    hub.screen_consent = guard.shared_without_asking
    hub.add_connect_hook(guard.on_connect)
    hub.add_event_sink(("tool",), guard.tool_event)
    hub.register_instant(guard.instant)
