"""Hands-free rules: spotting "Jarvis", spoken stop commands, and JARVIS hearing itself."""

from __future__ import annotations

import difflib
import re
from collections.abc import Callable, Iterable

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


# ── the names that wake it (Settings › Listening › Wake words) ──
# "Jarvis", with every rule in this file, unless the owner removed it; and any other names
# they keep (a persona's own name is one by default: "Friday"). Another name may be a word
# anyone says ("Friday", 星期五), so it wakes only as a call: first, then a pause and the
# request ("Friday, what's on today?"), or after a greeting ("Hey Friday"). Said on its
# own ("Friday.") it's an answer to someone, and mid-sentence it's just a word. The voice
# feature sets where the names come from (configure); without it, it's only "Jarvis".
_names_source: Callable[[], Iterable[str]] | None = None
_names_cache: tuple[tuple[str, ...], tuple[bool, tuple[str, ...], tuple[str, ...]]] | None = None
_extra_sources: dict[str, Callable[[], Iterable[str]]] = {}
# Greetings that make the next word a call ("Hey Friday"). Not "okay": "Okay, Friday works."
CALL_GREETINGS = {"hey", "hi", "hello", "yo", "hay"}
_CALL_PAUSE = re.compile(r"[,.!?;:—–-][\"'”’)]*$")  # "Friday," "Friday." "Friday—"


def add_names(key: str, source: Callable[[], Iterable[str]] | None) -> None:
    """More names that wake it, besides the configured ones, under a key that a later call
    replaces (None takes them away): the agents feature's, each agent's persona answering
    to its name whichever agent is in use. Read at each check."""
    global _names_cache
    if source is None:
        _extra_sources.pop(key, None)
    else:
        _extra_sources[key] = source
    _names_cache = None


def configure(source: Callable[[], Iterable[str]] | None) -> None:
    """Where the wake words come from (called for each check, so a change in Settings or
    of persona applies at once); None: just "Jarvis"."""
    global _names_source, _names_cache
    _names_source, _names_cache = source, None


def wake_names() -> tuple[str, ...]:
    """The wake words in use, as the owner wrote them ("Jarvis", "Friday", "星期五")."""
    names: tuple[str, ...] = ()
    if _names_source is not None:
        try:
            names = tuple(str(n) for n in _names_source() if str(n).strip())
        except Exception:  # a settings file that can't be read: the name it always had
            names = ()
    names = names or ("Jarvis",)
    for source in list(_extra_sources.values()):
        try:
            more = tuple(str(n) for n in source() if str(n).strip())
        except Exception:  # another feature's trouble never costs the owner their own names
            more = ()
        seen = {n.casefold() for n in names}
        names += tuple(n for n in more if n.casefold() not in seen)
    return names


def _key(name: str) -> str:
    """A Latin name as it's matched: lowercase letters and digits ("TARS" -> "tars")."""
    return "".join(_WORD.findall(name.lower().replace("’", "'"))).replace("'", "")


def _names() -> tuple[bool, tuple[str, ...], tuple[str, ...]]:
    """(whether "Jarvis" wakes it, the other Latin names' keys, the other names as written)."""
    global _names_cache
    names = wake_names()
    if _names_cache is not None and _names_cache[0] == names:
        return _names_cache[1]
    jarvis = any(_key(n) == "jarvis" for n in names)
    others = tuple(n.strip() for n in names if _key(n) != "jarvis" or not n.isascii())
    latin = tuple(dict.fromkeys(_key(n) for n in others if n.isascii() and len(_key(n)) >= 2))
    _names_cache = (names, (jarvis, latin, others))
    return _names_cache[1]


def jarvis_on() -> bool:
    """Whether "Jarvis" is one of the wake words (it is unless the owner removed it)."""
    return _names()[0]


def other_names() -> tuple[str, ...]:
    """The wake words besides "Jarvis", as written (Latin and Chinese)."""
    return _names()[2]


def _near(token: str, name: str) -> bool:
    """A word Whisper wrote for a name: the name itself, or (for a name of five letters or
    more) a near-miss starting with the same letter ("Fryday" for "Friday"). A short name
    has to be heard exactly: one letter off "TARS" is "bars", "cars" or "stars"."""
    if token == name:
        return True
    if len(name) <= 4 or not token or token[0] != name[0] or abs(len(token) - len(name)) > 2:
        return False
    return difflib.SequenceMatcher(None, token, name).ratio() >= (0.8 if len(name) <= 6 else 0.76)


def is_other_name(token: str) -> bool:
    """Whether a word is one of the other wake words (fuzzily, as _near hears them)."""
    key = _key(token)
    return bool(key) and any(_near(key, name) for name in _names()[1])


def _find_named(raw: str) -> tuple[bool, str]:
    """The other names, called: "Hey Friday", "Hey Friday, what's on", or "Friday, what's
    on today?" (the name first, a pause, then the request). (woke, command)."""
    latin = _names()[1]
    if not latin:
        return False, ""
    # The name is the first or second word: only the start is split (the rest stays one
    # piece), so a long announcement costs no more than a short one.
    pieces = re.split(r"(\s+)", raw, maxsplit=6)
    tokens = [(i, "".join(_WORD.findall(p.lower())).replace("'", "")) for i, p in enumerate(pieces)]
    tokens = [(i, t) for i, t in tokens if t]
    greeted = len(tokens) > 1 and tokens[0][1] in CALL_GREETINGS
    if not tokens or len(tokens) <= int(greeted):
        return False, ""
    at, token = tokens[int(greeted)]
    if not any(_near(token, name) for name in latin):
        return False, ""
    after = "".join(pieces[at + 1 :]).strip(" ,.!?;:-—–")
    if greeted or (_CALL_PAUSE.search(pieces[at]) and words(after)):
        return True, after
    return False, ""


def _is_wake_token(token: str) -> bool:
    """A word that calls it: "Jarvis" (as Whisper writes it) or another wake word. Taken out
    of answers ("Friday, yes" is a yes) and of what a code session is told."""
    return _is_jarvis_token(token) or is_other_name(token)


def _is_jarvis_token(token: str) -> bool:
    if token in WAKE_WORDS:
        return True
    # Near-misses Whisper produces for accents and distance: "jervis", "jarimvis", "jarenvist".
    if not (5 <= len(token) <= 10) or token[0] not in "jgc":
        return False
    return difflib.SequenceMatcher(None, token, "jarvis").ratio() >= 0.76


def is_homecoming(text: str) -> bool:
    """Whether it was "wake up, daddy's home" that woke it: that one gets a welcome."""
    return bool(_WAKE_PHRASE.search(text or ""))


def find_wake(text: str) -> tuple[bool, str]:
    """(woke, command). "Jarvis" can be anywhere: "Jarvis, what's next?" and "What's the
    weather, Jarvis?" both wake it; the command is the rest of the sentence. Whisper
    sometimes splits the name ("Jari ves"), so adjacent word pairs are checked too. The
    other wake words wake it as calls (_find_named); "Jarvis" only while it's one of them."""
    raw = text.strip()
    phrase = _WAKE_PHRASE.search(raw)
    if phrase:  # "wake up daddy's home" wakes it, and anything else said counts as the command
        before = raw[: phrase.start()].strip(" ,.!?;:-")
        after = raw[phrase.end() :].strip(" ,.!?;:-")
        return True, f"{before} {after}".strip()
    if jarvis_on():
        woke = find_jarvis(raw)
        if woke[0]:
            return woke
    return _find_named(raw)


def find_jarvis(text: str) -> tuple[bool, str]:
    """find_wake for the name "Jarvis" alone (whether or not it's a wake word now)."""
    raw = text.strip()
    pieces = [p for p in re.split(r"(\s+)", raw)]
    tokens = [(i, "".join(_WORD.findall(p.lower())).replace("'", "")) for i, p in enumerate(pieces)]
    tokens = [(i, t) for i, t in tokens if t]
    for n, (i, token) in enumerate(tokens):
        span = None
        greeted = n == 1 and tokens[0][1] in GREETINGS
        if _is_jarvis_token(token) or (greeted and token in GREETED_MISHEARINGS):
            span, next_token = (i, i), n + 1
        elif n + 1 < len(tokens) and _is_jarvis_token(token + tokens[n + 1][1]):
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
