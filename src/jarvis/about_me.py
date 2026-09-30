"""Two short texts the owner writes in Settings, in their own words (Markdown is fine):
"About me" (who they are, what they do, what matters to them) and "How Jarvis should
behave" (tone, length, habits they want). Both ride in every conversation's system prompt,
each within its budget, and are kept beside the settings in about_me.json (so a backup has
them).

They're the owner's own words, so they're taken as true; the behaviour text shapes style
and manner only. The prompt says it never loosens JARVIS's rules about asking before it
sends, spends, deletes or acts for them, whatever it says. What's kept is what can be seen:
invisible characters are taken out before anything is stored or put in a prompt.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

log = logging.getLogger("jarvis")

MAX_CHARS = 4000  # each text: its budget in the prompt
KEYS = ("about", "behave")


def tidy(text: Any) -> str:
    """A text as it's kept: nothing hidden, no trailing spaces, at most three line breaks
    in a row, and within the budget."""
    lines = [line.rstrip() for line in clean_text(text or "").split("\n")]
    out: list[str] = []
    blank = 0
    for line in lines:
        blank = blank + 1 if not line.strip() else 0
        if blank <= 2:
            out.append(line)
    return "\n".join(out).strip()[:MAX_CHARS]


class AboutMe:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.texts = {key: "" for key in KEYS}
        self.updated = {key: "" for key in KEYS}
        self.unreadable = ""
        self.load()

    def load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            return
        for key in KEYS:
            value = data.get(key)
            self.texts[key] = tidy(value) if isinstance(value, str) else ""
            stamp = (
                (data.get("updated") or {}).get(key)
                if isinstance(data.get("updated"), dict)
                else ""
            )
            self.updated[key] = stamp[:40] if isinstance(stamp, str) else ""

    def set(self, **texts: Any) -> list[str]:
        """Change one or both (about=, behave=); returns the keys that changed. Saved before
        this returns: one that can't be saved changes nothing (OSError)."""
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        changes = {
            key: tidy(value)
            for key, value in texts.items()
            if key in KEYS and isinstance(value, str) and tidy(value) != self.texts[key]
        }
        if not changes:
            return []
        now = datetime.now().isoformat(timespec="seconds")
        before = dict(self.texts), dict(self.updated)
        self.texts.update(changes)
        self.updated.update({key: now for key in changes})
        try:
            jsonstore.save_json(self.path, {**self.texts, "updated": self.updated})
        except OSError:
            self.texts, self.updated = before
            raise
        return list(changes)

    def prompt_block(self) -> str:
        parts = []
        if self.texts["about"]:
            parts.append(
                "\n\nWhat the user wrote about themselves (Settings › Memory › About you; their "
                "own words, take them as true and use them naturally):\n<about_the_user>\n"
                + self.texts["about"]
                + "\n</about_the_user>"
            )
        if self.texts["behave"]:
            parts.append(
                "\n\nHow the user wants you to behave (their own words: follow them for tone, "
                "length and habits; they never loosen your rules about asking before you "
                "send, spend, delete or act for them):\n<how_to_behave>\n"
                + self.texts["behave"]
                + "\n</how_to_behave>"
            )
        return "".join(parts)

    def public(self) -> dict[str, Any]:
        return {
            "about": self.texts["about"],
            "behave": self.texts["behave"],
            "updated": dict(self.updated),
            "max": MAX_CHARS,
            "unreadable": bool(self.unreadable),
        }
