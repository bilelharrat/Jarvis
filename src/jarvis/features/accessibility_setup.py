"""The first-run walkthrough of J.A.R.V.I.S. Daredevil, done by keyboard or by voice.

The first time the window opens in screen-reader mode (a11y_setup_done is false) it shows a
short dialog (web/features/accessibility_setup.js), one step at a time, each announced: the
speaking speed, colours and text size, who reads the replies (the screen reader or JARVIS's
voice), the keys (Talk, Stop talking, the screen-reader keys), adding an email account (it
opens Settings › Email accounts), and a trusted person. Finishing or skipping it sets
a11y_setup_done; "run setup again" (or Alt+Shift+W, or the button in Settings › Accessibility)
opens it again.

By voice: while the dialog is open the window says so ("a11y_setup" {open, step}), and these
words are answered at once, without Claude: "next", "back", "skip", "finish", "say that
again", "play a sample", and the choices themselves ("yellow on black", "larger text", "my
screen reader", "Jarvis's voice"). "Talk faster" and "slower" are the voice feature's own
words, and work here too. Events: "a11y_setup_cmd" ({action: open | next | back | finish |
repeat}) to the window.

Claude cost policy: no model call; every word of the walkthrough is answered on this computer.
"""

from __future__ import annotations

import re
import time
from typing import Any

OPEN_FOR = 1800.0  # seconds a dialog that never said it closed counts as open

_AGAIN = re.compile(
    r"^(?:please\s+)?(?:(?:run|start|open|do|redo|repeat|restart)\s+(?:the\s+)?(?:accessibility\s+|daredevil\s+|first[- ]run\s+)?"
    r"(?:setup|set-up|walkthrough)(?:\s+again)?|(?:setup|walkthrough)\s+again|set\s+(?:me|jarvis|it)\s+up\s+again)\W*$",
    re.I,
)
_MOVES = [
    (re.compile(r"^(?:next|continue|go\s+on|ok(?:ay)?|skip(?:\s+(?:this|it|this\s+step))?|not\s+now)\W*$", re.I), "next"),
    (re.compile(r"^(?:back|go\s+back|previous)\W*$", re.I), "back"),
    (re.compile(r"^(?:finish|done|i'?m\s+done|close(?:\s+setup)?|exit(?:\s+setup)?|skip\s+(?:the\s+)?setup|stop\s+(?:the\s+)?setup)\W*$", re.I), "finish"),
    (re.compile(r"^(?:repeat(?:\s+that)?|say\s+(?:that|it)\s+again|again|what\s+was\s+that)\W*$", re.I), "repeat"),
]  # fmt: skip
_SAMPLE = re.compile(
    r"^(?:play\s+a\s+sample|(?:let\s+me\s+)?hear\s+(?:a\s+sample|it|you)|how\s+do\s+you\s+sound|say\s+something|test(?:\s+(?:the\s+)?voice)?)\W*$",
    re.I,
)
_CHOICES = [
    (r"yellow\s+on\s+black", "a11y_colors", "yellow", "Colours: yellow on black."),
    (r"white\s+on\s+black", "a11y_colors", "white", "Colours: white on black."),
    (r"black\s+on\s+yellow", "a11y_colors", "yellow-bg", "Colours: black on yellow."),
    (r"yellow\s+on\s+blue", "a11y_colors", "yellow-blue", "Colours: yellow on blue."),
    (r"(?:colou?rs?\s+off|no\s+(?:special\s+)?colou?rs?|normal\s+colou?rs?)", "a11y_colors", "off", "Colours: the window's own."),
    (r"normal\s+(?:text|size|text\s+size)", "a11y_text_size", "normal", "Text size: normal."),
    (r"large\s+(?:text|size)|large", "a11y_text_size", "large", "Text size: large."),
    (r"larger\s+(?:text|size)|larger|bigger(?:\s+text)?", "a11y_text_size", "larger", "Text size: larger."),
    (r"largest\s+(?:text|size)|largest|biggest(?:\s+text)?", "a11y_text_size", "largest", "Text size: largest."),
    (r"(?:my\s+)?screen\s+reader(?:\s+reads(?:\s+them)?)?|nvda|jaws|narrator", "a11y_voice", "reader", "Your screen reader reads the replies."),
    (r"(?:jarvis'?s?|your|your\s+own)\s+voice|you\s+read\s+them", "a11y_voice", "jarvis", "I'll read the replies in my own voice."),
]  # fmt: skip
CHOICES = [
    (re.compile(rf"^(?:please\s+)?(?:use\s+)?(?:{words})\W*$", re.I), key, value, said)
    for words, key, value, said in _CHOICES
]


class Setup:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.opened_at = 0.0
        self.step = ""

    def is_open(self) -> bool:
        return bool(self.opened_at) and time.monotonic() - self.opened_at < OPEN_FOR

    def state(self, msg: dict[str, Any]) -> None:
        """The window: the dialog opened, moved to a step, or closed (done: finished or skipped)."""
        if msg.get("open"):
            self.opened_at = self.opened_at or time.monotonic()
            self.step = str(msg.get("step") or "")[:40]
        else:
            self.opened_at, self.step = 0.0, ""
        if msg.get("done"):
            self.hub.set_feature_prefs({"a11y_setup_done": True})
        if msg.get("sample"):
            self.sample()

    def sample(self) -> None:
        voice = getattr(self.hub, "voice_feature", None)
        speed = voice.speaking.speed() if voice is not None else 100
        self.hub.say(
            f"This is how I sound at {speed} percent. Say faster or slower to change it.",
            follow_up=False,
        )

    async def instant(self, words: str) -> str | None:
        text = " ".join(str(words or "").split())
        if _AGAIN.match(text):
            self.hub.emit("a11y_setup_cmd", action="open")
            return "Opening the setup."
        if not self.is_open():
            return None
        for pattern, action in _MOVES:
            if pattern.match(text):
                self.hub.emit("a11y_setup_cmd", action=action)
                return ""  # (the window says the next step itself)
        if _SAMPLE.match(text):
            self.sample()
            return ""
        for pattern, key, value, said in CHOICES:
            if pattern.match(text):
                self.hub.set_feature_prefs({key: value})
                return said
        return None


def install(hub: Any) -> None:
    setup = Setup(hub)
    hub.a11y_setup = setup
    hub.register_command("a11y_setup", setup.state)
    hub.register_instant(setup.instant)
