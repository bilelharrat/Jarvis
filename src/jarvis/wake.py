"""Hands-free rules: spotting "Jarvis", spoken stop commands, and JARVIS hearing itself."""

from __future__ import annotations

import difflib
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
# "Hey Jarvis" and friends. After one of these, looser sound-alikes count too: Whisper
# often writes "Hey Travis" or "Hey Harvis" for "Hey Jarvis".
GREETINGS = {"hey", "hi", "okay", "ok", "yo", "hello", "a", "hay", "heh"}


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _is_wake_token(token: str) -> bool:
    if token in WAKE_WORDS:
        return True
    # Near-misses Whisper produces for accents and distance: "jervis", "jarimvis", "jarenvist".
    if not (5 <= len(token) <= 10) or token[0] not in "jgc":
        return False
    return difflib.SequenceMatcher(None, token, "jarvis").ratio() >= 0.76


def _is_greeted_wake(token: str) -> bool:
    """A near-miss of "jarvis" that only counts right after a greeting."""
    return 4 <= len(token) <= 9 and difflib.SequenceMatcher(None, token, "jarvis").ratio() >= 0.6


def find_wake(text: str) -> tuple[bool, str]:
    """(woke, command). "Jarvis" can be anywhere: "Jarvis, what's next?" and "What's the
    weather, Jarvis?" both wake it; the command is the rest of the sentence. Whisper
    sometimes splits the name ("Jari ves"), so adjacent word pairs are checked too."""
    raw = text.strip()
    pieces = [p for p in re.split(r"(\s+)", raw)]
    tokens = [(i, "".join(_WORD.findall(p.lower())).replace("'", "")) for i, p in enumerate(pieces)]
    tokens = [(i, t) for i, t in tokens if t]
    for n, (i, token) in enumerate(tokens):
        span = None
        greeted = n > 0 and tokens[n - 1][1] in GREETINGS
        if _is_wake_token(token) or (greeted and _is_greeted_wake(token)):
            span = (i, i)
        elif n + 1 < len(tokens) and _is_wake_token(token + tokens[n + 1][1]):
            span = (i, tokens[n + 1][0])
        if span is None:
            continue
        before = "".join(pieces[: span[0]]).strip(" ,.!?;:-")
        after = "".join(pieces[span[1] + 1 :]).strip(" ,.!?;:-")
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


YES = {
    "yes",
    "yeah",
    "yep",
    "yup",
    "sure",
    "ok",
    "okay",
    "confirm",
    "confirmed",
    "correct",
    "go ahead",
    "do it",
    "send it",
    "send",
    "yes please",
    "go for it",
    "run it",
    "allow",
    "approve",
    "approved",
    "absolutely",
    "definitely",
    "of course",
    "affirmative",
}
NO = {
    "no",
    "nope",
    "nah",
    "cancel",
    "don't",
    "dont",
    "do not",
    "don't send",
    "don't send it",
    "never mind",
    "nevermind",
    "negative",
    "stop",
    "deny",
    "not now",
    "no thanks",
    "hold on",
    "wait",
    "abort",
}


def yes_no(text: str) -> bool | None:
    """A short spoken answer to a question JARVIS just asked: True, False, or None."""
    w = [t.replace("’", "'") for t in words(text) if not _is_wake_token(t)]
    if not w or len(w) > 5:
        return None
    for size in (3, 2, 1):  # "no, don't send it" is a no, though it contains "send it"
        lead = " ".join(w[:size])
        if lead in NO:
            return False
        if lead in YES:
            return True
    return None


def is_echo(heard: str, speaking: str, threshold: float = 0.6) -> bool:
    """True when what the mic heard is mostly JARVIS's own voice from the speakers."""
    heard_words = [w for w in words(heard) if len(w) > 2]
    if not heard_words or not speaking:
        return False
    spoken = set(words(speaking))
    overlap = sum(1 for w in heard_words if w in spoken) / len(heard_words)
    return overlap >= threshold
