"""The owner's own words asking for a feature's action, in English and in Chinese.

The core's actions keep their words in hub.FEATURE_ASKED and lang.FEATURE_ASKED_ZH (tables
of the core's actions alone, each with its twin); a feature keeps its own here and reads them
the same way: a clause of what the owner said or typed this turn that opens with the request
(after lead-ins such as "please", "can you", 好的 or 麻烦你), not a word somewhere in it. A
routine's or the briefing's request, and anything a page or a message said, never counts.

(Not a feature itself: the loader skips modules whose names start with "_".)
"""

from __future__ import annotations

from typing import Any

from .. import hub as hub_module
from .. import lang


class Asked:
    """One action's words: pattern and pattern_zh are regular expressions for the request
    itself, matched at the start of a clause."""

    def __init__(self, pattern: str, pattern_zh: str) -> None:
        self.pattern = hub_module._asks(pattern)
        self.pattern_zh = lang._asks_zh(pattern_zh)

    def said(self, text: str, language: str = "en") -> bool:
        """These words ask for it: in English always, in Chinese when that's the language
        (as the hub reads the core's)."""
        if hub_module.user_asked(self.pattern, text or ""):
            return True
        return lang.is_zh(language) and lang.user_asked_zh(self.pattern_zh, text or "")

    def by_owner(self, hub: Any) -> bool:
        """The owner's own words this turn asked for it."""
        return self.said(hub._turn_text, hub.language)
