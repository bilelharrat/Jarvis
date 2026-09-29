"""Hands-free rules: spotting "Jarvis", spoken stop commands, and JARVIS hearing itself."""

from __future__ import annotations

import re

# What Whisper tends to write when someone says "Jarvis".
WAKE_WORDS = {"jarvis", "jarvis's", "jervis", "javis", "jarvus", "jarvas", "jarves", "jarvi"}
STOP_PHRASES = {
    "stop",
    "wait",
    "hold on",
    "hang on",
    "quiet",
    "be quiet",
    "shush",
    "enough",
    "cancel",
    "never mind",
    "nevermind",
    "shut up",
    "pause",
    "that's enough",
    "okay stop",
    "ok stop",
}

_WORD = re.compile(r"[a-z']+")


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def find_wake(text: str) -> tuple[bool, str]:
    """(woke, command). "Jarvis" can be anywhere: "Jarvis, what's next?" and "What's the
    weather, Jarvis?" both wake it; the command is the rest of the sentence."""
    raw = text.strip()
    pieces = re.split(r"(\s+)", raw)
    for i, piece in enumerate(pieces):
        token = "".join(_WORD.findall(piece.lower()))
        if token not in WAKE_WORDS:
            continue
        before = "".join(pieces[:i]).strip(" ,.!?;:-")
        after = "".join(pieces[i + 1 :]).strip(" ,.!?;:-")
        before = re.sub(r"^(?:hey|hi|okay|ok|yo|hello)\b[\s,]*", "", before, flags=re.I).strip()
        if len(words(after)) >= 2 or not before:
            return True, after
        return True, f"{before} {after}".strip() if after else before
    return False, ""


def is_stop(text: str) -> bool:
    w = words(text)
    if not w or len(w) > 4:
        return False
    phrase = " ".join(w)
    return phrase in STOP_PHRASES or any(phrase.startswith(p + " ") for p in STOP_PHRASES)


def is_echo(heard: str, speaking: str, threshold: float = 0.6) -> bool:
    """True when what the mic heard is mostly JARVIS's own voice from the speakers."""
    heard_words = [w for w in words(heard) if len(w) > 2]
    if not heard_words or not speaking:
        return False
    spoken = set(words(speaking))
    overlap = sum(1 for w in heard_words if w in spoken) / len(heard_words)
    return overlap >= threshold
