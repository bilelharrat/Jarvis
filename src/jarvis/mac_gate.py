"""When JARVIS's actions on the Mac ask first: the rules the feature modules share (places,
stocks, mac_music, mac_switches, mac_files, mac_defense).

Three kinds of action, from the safety rules every tool follows:

- operate(): changing the Mac itself (dark mode, Wi-Fi, Bluetooth, a Focus). It goes ahead
  unasked when the owner's own words this turn asked for exactly that, or when Settings ›
  Control my Mac without asking is on (as quitting an app goes ahead then) and nothing
  this conversation has read could have put the idea in: no mail, no page, no file. Any
  other time a card asks, and the question is said out loud.
- own_words(): a change to the owner's own things (a file moved, renamed or put in the
  Trash; the watchlist; a price alert). Unasked only when their own words this turn asked
  for exactly that; otherwise a card.
- Everything that sends something to a person keeps its Send card (hub.send_gate), always.

"Their own words" are what they typed or said this turn (hub._turn_text): a routine, the
briefing or a heads-up has none, so it always goes by the card or by the setting. A
request counts only when a clause opens with it ("turn off the Wi-Fi", "好的，关掉蓝牙"),
the way hub.user_asked reads it, never a trigger word somewhere in a sentence.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from . import lang

# Words in a file's name that say nothing about which file it is.
_FILLER = frozenset(
    "the a an of and to my for in on at copy final new old file files doc docs".split()
)


def _words(text: str) -> list[str]:
    """Lowercase words, a camelCase or snake_case name split up, plurals folded."""
    split = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", text or "")
    out = []
    for word in re.findall(r"[^\W_]+", split.lower()):
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]  # "screenshots" and "screenshot" are the same file
        out.append(word)
    return out


def names_file(said: str, path: str | Path) -> bool:
    """The owner's words name this file or folder: at least half the telling words of its
    name (and at least one), or all of a Chinese name. "Move the Q3 report" names
    "Q3 report.pdf"; "tidy my desktop" names none of the screenshots on it."""
    name = Path(str(path)).name
    stem = Path(name).stem if Path(name).suffix and len(Path(name).suffix) <= 6 else name
    said_words = set(_words(said))
    plain = "".join((said or "").lower().split())
    if not stem.isascii():
        cjk = "".join(stem.lower().split())
        if cjk and cjk in plain:
            return True
    telling = [w for w in dict.fromkeys(_words(stem)) if w not in _FILLER]
    if not telling:
        return False
    hits = sum(1 for w in telling if w in said_words or (not w.isascii() and w in plain))
    return hits >= 1 and hits * 2 >= len(telling)


class MacGate:
    """The hub's view of the current turn, for the rules above."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def said(self) -> str:
        """The owner's own words this turn ("" for a routine, the briefing, a heads-up)."""
        return str(getattr(self.hub, "_turn_text", "") or "")

    def asked(self, pattern: re.Pattern[str] | None, pattern_zh: re.Pattern[str] | None) -> bool:
        """A clause of the owner's own words this turn opens with this request."""
        from .hub import user_asked

        text = self.said()
        if not text:
            return False
        if pattern is not None and user_asked(pattern, text):
            return True
        return pattern_zh is not None and lang.user_asked_zh(pattern_zh, text)

    def has_read(self) -> bool:
        """This conversation has read the owner's data or a page: someone else's words
        may be in it."""
        reads = self.hub._gate_reads()
        return bool(reads.get("private") or reads.get("web"))

    async def ask(
        self,
        question: str,
        detail: str = "",
        spoken: str = "",
        choices: tuple[str, str] | None = None,
    ) -> bool:
        """A yes or no on a card, said out loud (in the owner's language: the hub translates
        the sentences lang knows)."""
        self.hub._say(spoken or question)
        options = [("allow", choices[0]), ("deny", choices[1])] if choices else None
        return await self.hub.request_approval(question, detail, options) == "allow"

    async def operate(
        self,
        asked: bool,
        question: str,
        detail: str = "",
        spoken: str = "",
        choices: tuple[str, str] | None = None,
    ) -> bool:
        if asked:
            return True
        if self.hub.prefs.control_always and not self.has_read():
            return True
        return await self.ask(question, detail, spoken, choices)

    async def own_words(
        self,
        asked: bool,
        question: str,
        detail: str = "",
        spoken: str = "",
        choices: tuple[str, str] | None = None,
    ) -> bool:
        if asked:
            return True
        return await self.ask(question, detail, spoken, choices)


# The start of a request, for patterns built here (hub._asks adds the lead-ins).
def asks(pattern: str) -> re.Pattern[str]:
    from .hub import _LEAD_IN

    return re.compile(_LEAD_IN + "(?:" + pattern + ")", re.IGNORECASE)


def asks_zh(pattern: str) -> re.Pattern[str]:
    return lang._asks_zh(pattern)
