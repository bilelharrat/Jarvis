"""Shortcuts as JARVIS's reach into the house: HomeKit scenes, lights, locks, Focus modes.

Shortcuts the user marks as instant run without a confirmation, and saying one's name
("Jarvis, movie mode", "Jarvis, lights off") runs it straight away, without a round trip
to Claude: the fastest thing JARVIS does.
"""

from __future__ import annotations

import logging
import re
import time

from . import mac_tools

log = logging.getLogger("jarvis")

REFRESH_SECONDS = 600
# Words that frame a request without naming the shortcut: "please run the movie mode".
_FILLER = {
    "please",
    "run",
    "start",
    "activate",
    "trigger",
    "do",
    "the",
    "my",
    "shortcut",
    "scene",
    "turn",
    "switch",
    "set",
    "now",
    "can",
    "you",
    "could",
    "would",
    "for",
    "me",
}


def _tokens(text: str) -> frozenset[str]:
    out = set()
    for word in re.findall(r"[a-z0-9']+", text.lower().replace("’", "'")):
        if word in _FILLER:
            continue
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]  # "lights" and "light" are the same request
        out.add(word)
    return frozenset(out)


def match_shortcut(text: str, names: list[str]) -> str | None:
    """The shortcut this utterance names exactly (ignoring filler words), if any."""
    said = _tokens(text)
    if not said:
        return None
    hits = [name for name in names if _tokens(name) == said]
    return hits[0] if len(hits) == 1 else None


class Shortcuts:
    """The Mac's shortcut names, refreshed now and then in the background."""

    def __init__(self) -> None:
        self.names: list[str] = []
        self._at = 0.0

    async def refresh(self, force: bool = False) -> list[str]:
        if not force and self.names and time.monotonic() - self._at < REFRESH_SECONDS:
            return self.names
        try:
            out = await mac_tools.run_command("shortcuts", "list", timeout=20)
        except mac_tools.ToolFailure as exc:
            log.info("couldn't list shortcuts: %s", exc)
            return self.names
        self.names = sorted({line.strip() for line in out.splitlines() if line.strip()})
        self._at = time.monotonic()
        return self.names

    async def run(self, name: str) -> str:
        return await mac_tools.run_command("shortcuts", "run", name, timeout=120)
