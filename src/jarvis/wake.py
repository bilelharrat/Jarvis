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
# "Hey Jarvis" and friends. When one of these opens the utterance, a few names Whisper
# writes for "Jarvis" count too ("Hey Travis", "Okay Marvis"); on their own, or later in
# a sentence ("…a Paris trip", "Hi Harris"), they're just words.
GREETINGS = {"hey", "hi", "okay", "ok", "yo", "hello", "hay"}
GREETED_MISHEARINGS = {
    "travis", "harvis", "marvis", "garvis", "carvis", "darvis", "charvis", "jarbis", "jarviss",
}  # fmt: skip
# "Jarvis Code", the coding panel, is a name JARVIS says itself: never a wake word.
_PANEL = {"code", "codes"}

# An extra wake phrase besides the name, forgiving of how Whisper writes it ("wake up
# daddy's home", "wake up, daddy is home", "wakeup daddys home"). It needs the whole
# phrase, so a plain "daddy's home" on its own never wakes it.
_WAKE_PHRASE = re.compile(
    r"\bwake\s*up\b[\s,.!:-]*(?:it'?s\s+)?daddy'?s?\b[\s,]*(?:is\s+)?(?:home|back)\b",
    re.IGNORECASE,
)


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower().replace("’", "'"))


def _is_wake_token(token: str) -> bool:
    if token in WAKE_WORDS:
        return True
    # Near-misses Whisper produces for accents and distance: "jervis", "jarimvis", "jarenvist".
    if not (5 <= len(token) <= 10) or token[0] not in "jgc":
        return False
    return difflib.SequenceMatcher(None, token, "jarvis").ratio() >= 0.76


def find_wake(text: str) -> tuple[bool, str]:
    """(woke, command). "Jarvis" can be anywhere: "Jarvis, what's next?" and "What's the
    weather, Jarvis?" both wake it; the command is the rest of the sentence. Whisper
    sometimes splits the name ("Jari ves"), so adjacent word pairs are checked too."""
    raw = text.strip()
    phrase = _WAKE_PHRASE.search(raw)
    if phrase:  # "wake up daddy's home" wakes it, and anything else said counts as the command
        before = raw[: phrase.start()].strip(" ,.!?;:-")
        after = raw[phrase.end() :].strip(" ,.!?;:-")
        return True, f"{before} {after}".strip()
    pieces = [p for p in re.split(r"(\s+)", raw)]
    tokens = [(i, "".join(_WORD.findall(p.lower())).replace("'", "")) for i, p in enumerate(pieces)]
    tokens = [(i, t) for i, t in tokens if t]
    for n, (i, token) in enumerate(tokens):
        span = None
        greeted = n == 1 and tokens[0][1] in GREETINGS
        if _is_wake_token(token) or (greeted and token in GREETED_MISHEARINGS):
            span, next_token = (i, i), n + 1
        elif n + 1 < len(tokens) and _is_wake_token(token + tokens[n + 1][1]):
            span, next_token = (i, tokens[n + 1][0]), n + 2
        if span is None:
            continue
        # The word after the name, by index: gathering all the rest for each name made
        # "Jarvis Code, Jarvis Code, …" quadratic.
        following = tokens[next_token][1] if next_token < len(tokens) else ""
        if following in _PANEL and not re.search(r"\W$", pieces[span[1]]):
            continue  # "Jarvis Code finished in…": the panel's name, likely its own voice
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


# Sounds that open an answer without being one: "Okay, no, don't send it" is a no.
FILLERS = {"okay", "ok", "so", "um", "umm", "uh", "uhh", "er", "erm", "well", "hmm", "oh", "ah"}
# A wait isn't a no, and "yes, but wait" isn't a yes: the question stays open.
HESITATIONS = {"wait", "hold on", "hang on"}


def yes_no(text: str) -> bool | None:
    """A short spoken answer to a question JARVIS just asked: True, False, or None when
    it's neither or unclear. A no anywhere wins ("Sure, actually no", "OK, cancel")."""
    w = [t for t in words(text) if not _is_wake_token(t)]
    while len(w) > 1 and w[0] in FILLERS:
        w = w[1:]
    if not w or len(w) > 5:
        return None
    waiting = False
    for k in range(len(w)):
        for size in (3, 2, 1):
            phrase = " ".join(w[k : k + size]) if k + size <= len(w) else ""
            if phrase in HESITATIONS:
                waiting = True
            elif phrase in NO and not (
                phrase == "no" and w[k + 1 : k + 2] in (["problem"], ["worries"], ["doubt"])
            ):
                return False
    if waiting:
        return None
    for size in (3, 2, 1):
        if " ".join(w[:size]) in YES:
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
