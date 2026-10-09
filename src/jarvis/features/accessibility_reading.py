"""Speech for long reading, apart from conversation (J.A.R.V.I.S. Daredevil).

Someone who listens all day often wants a document, an email or a report read faster (or
slower) than the back and forth of a conversation, and in a different amount: the whole text,
a short summary first, or only the key points. Settings › Accessibility keeps both:

- a11y_read_speed: the voice's speed while it reads long text, in percent (0: the same as in
  conversation, Settings › Speaking). When one of the reading tools (READING_TOOLS) returns
  long text (LONG_CHARS or more) in a turn, the voice switches to this speed for the rest of
  that reply, and back when the turn is over. Never saved as the speaking speed, and never
  while the owner's screen reader reads the replies (it has its own speed).
- a11y_read_verbosity: how much of it Claude reads ("full", "summary", "highlights"), in the
  note every request carries while the mode is on (features/accessibility.py).

Said at once, without Claude: "reading speed 150 percent", "read documents at 180 percent",
"reading speed same as talking".

Claude cost policy: no model call; one more sentence rides on the accessibility note.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from claude_agent_sdk import HookMatcher

log = logging.getLogger("jarvis")

# Tools that bring back something to read aloud, by their own name (any server).
READING_TOOLS = frozenset(
    {
        "read_email",
        "read_attachment",
        "read_document",
        "open_document",
        "read_file",
        "read_report",
        "read_note",
        "read_with_punctuation",
        "open_paper",
        "get_paper",
        "browser_read",
        "browser_tab_text",
        "research_read",
        "wiki_page",
    }
)
LONG_CHARS = 1200  # a result this long is reading, not an answer

_SPEED = re.compile(
    r"^(?:please\s+)?(?:set\s+(?:the\s+|my\s+)?)?(?:reading\s+speed(?:\s+to)?|read\s+(?:documents|emails|long\s+texts?|things)\s+at)\s+"
    r"(\d{2,3})\s*(?:%|percent)\W*$",
    re.I,
)
_SAME = re.compile(
    r"^(?:please\s+)?(?:set\s+(?:the\s+|my\s+)?)?reading\s+speed\s+(?:to\s+)?(?:the\s+)?same\s+as\s+(?:talking|conversation|speaking)\W*$",
    re.I,
)


def tool_short_name(name: str) -> str:
    """mcp__mail__read_email -> read_email."""
    return str(name or "").rsplit("__", 1)[-1]


def result_length(response: Any) -> int:
    """How much text a tool gave back, whatever shape the result has."""
    if isinstance(response, str):
        return len(response)
    if isinstance(response, dict):
        content = response.get("content")
        if content is not None:
            return result_length(content)
        return len(str(response.get("text") or ""))
    if isinstance(response, list):
        return sum(
            len(str(item.get("text") or "")) if isinstance(item, dict) else len(str(item))
            for item in response
        )
    return 0


class Reading:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.holding = False

    def wanted(self) -> int | None:
        """The reading speed to switch to now, or None (off, the screen reader reads, as fast as
        conversation)."""
        a11y = getattr(self.hub, "accessibility", None)
        if a11y is None or not a11y.effective() or a11y.reader_speaks():
            return None
        speed = self.hub.prefs.feature("a11y_read_speed")
        return int(speed) if speed else None

    def _speaking(self) -> Any:
        voice = getattr(self.hub, "voice_feature", None)
        return getattr(voice, "speaking", None)

    async def hold(self) -> bool:
        """Long text came back: the voice reads at the reading speed until the turn ends."""
        speed, speaking = self.wanted(), self._speaking()
        if speed is None or speaking is None:
            return False
        self.holding = True
        if speaking.held != speed:
            speaking.held = speed
            await speaking.apply(refresh=False)
            log.info("reading at %d percent", speed)
        return True

    async def release(self, _event: Any = None) -> None:
        speaking = self._speaking()
        if not self.holding or speaking is None:
            return
        self.holding = False
        speaking.held = None
        await speaking.apply(refresh=False)

    # ── the conversation ──

    def on_connect(self, options: Any, _resume: str) -> None:
        hooks = {kind: list(matchers) for kind, matchers in (options.hooks or {}).items()}
        hooks.setdefault("PostToolUse", []).append(HookMatcher(matcher=None, hooks=[self._after]))
        options.hooks = hooks

    async def _after(self, data: Any, _tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        if tool_short_name(str(data.get("tool_name") or "")) not in READING_TOOLS:
            return {}
        if result_length(data.get("tool_response")) >= LONG_CHARS:
            await self.hold()
        return {}

    # ── said at once ──

    async def instant(self, words: str) -> str | None:
        text = " ".join(str(words or "").split())
        if _SAME.match(text):
            self.hub.set_feature_prefs({"a11y_read_speed": 0})
            return "Long texts are now read at the same speed as conversation."
        m = _SPEED.match(text)
        if not m:
            return None
        self.hub.set_feature_prefs({"a11y_read_speed": int(m.group(1))})
        return f"Long texts are now read at {self.hub.prefs.feature('a11y_read_speed')} percent."


def install(hub: Any) -> None:
    reading = Reading(hub)
    hub.a11y_reading = reading
    hub.add_connect_hook(reading.on_connect)
    hub.add_event_sink(("turn_done",), reading.release)
    hub.register_instant(reading.instant)
