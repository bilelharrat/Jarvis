"""What can be done with a reply in the main chat, as in the Claude, ChatGPT and Gemini apps
(the window's features/rich-chat.js draws the buttons under it):

- Read Aloud says the reply again in JARVIS's voice (window command chat_say {text}).
- Good Response and Bad Response are feedback (chat_feedback {good, note}). A bad one's note,
  what was wrong, is remembered as a preference ("When answering: …"), so the mistake isn't
  made again; a good one is only counted.
- Copy is the window's own, and Try Again needs nothing here: it asks "Give me a different
  answer.", which the conversation_branch feature answers again in a new branch, the first
  answer kept.

Nothing is remembered while the conversation is incognito.

Claude cost policy: no model is called here.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("jarvis")

SAY_MAX = 4000  # characters read aloud at once
NOTE_MAX = 500


def lesson(note: str) -> str:
    """The memory a bad response's note becomes: one line, prefixed so it reads as a rule."""
    words = " ".join(str(note or "").split())[:NOTE_MAX].rstrip(".")
    return f"When answering: {words}." if words else ""


class ChatActions:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.good = 0

    def say(self, msg: dict[str, Any]) -> None:
        text = " ".join(str(msg.get("text") or "").split())[:SAY_MAX]
        if not text:
            return
        speak = getattr(self.hub, "_speak", None)
        if callable(speak):
            speak(text)

    def feedback(self, msg: dict[str, Any]) -> None:
        hub = self.hub
        if msg.get("good") is True:
            self.good += 1
            hub.emit("toast", title="Jarvis", text="Thanks. Noted.")
            return
        rule = lesson(str(msg.get("note") or ""))
        if not rule:
            hub.emit("toast", title="Jarvis", text="Thanks. Noted.")
            return
        if getattr(hub, "incognito", False):
            hub.emit(
                "toast", title="Jarvis", text="Noted, but not kept: this conversation is incognito."
            )
            return
        try:
            hub.memory.add(rule, category="preferences", source="said")  # the owner told it
        except ValueError as exc:
            hub.emit("error", text=str(exc))
            return
        changed = getattr(hub, "_memory_changed", None)
        if callable(changed):
            changed()
        hub.emit("toast", title="Jarvis", text="Got it. Jarvis won’t do that again.")

    def install(self) -> None:
        self.hub.chat_actions = self
        self.hub.register_command("chat_say", self.say)
        self.hub.register_command("chat_feedback", self.feedback)


def install(hub: Any) -> None:
    ChatActions(hub).install()
