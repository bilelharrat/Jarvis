"""The wake words the owner keeps (Settings › Listening › Wake words).

"Jarvis" is always one unless the owner removes it. A persona brings its own name ("Friday"
for FRIDAY, "TARS" for TARS; in Chinese also 星期五 and 塔斯), and the owner can add others
and remove any of them, as long as one is left. What's kept is only the changes, so a
persona's name follows the persona: {"added": [...], "removed": [...]} in prefs.features.

wake.py applies them (wake.configure): "Jarvis" anywhere in a sentence, the others only
when called ("Friday, what's on today?", "Hey Friday").
"""

from __future__ import annotations

import re
from typing import Any

from . import personas, wake
from .lang import _CJK_CHARS, has_cjk, is_zh, to_simplified
from .textclean import clean_text

# The persona's own name, in English and in Chinese (lang.ZH_PERSONAS). The owner's own
# personas (personas.py) join these as they're registered: _own_personas.
PERSONA_NAMES = {"tars": ("TARS", "塔斯"), "friday": ("Friday", "星期五")}
BUILT_IN_NAMES = dict(PERSONA_NAMES)
MAX_WORDS = 8
EMPTY: dict[str, list[str]] = {"added": [], "removed": []}

_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9'’-]{1,19}")
_CJK_ONLY = re.compile(f"[{_CJK_CHARS}]{{2,8}}")
# Words that already mean something said on their own: never a name to wake it.
_TAKEN = (
    {w for phrase in wake.STOP_PHRASES | wake.YES | wake.NO for w in phrase.split()}
    | wake.GREETINGS
    | wake.FILLERS
    | {"jarvis's", "code", "the", "a", "an", "and", "or", "i", "you", "me", "it"}
)


def fold(word: str) -> str:
    """How two wake words are compared: case and Traditional/Simplified don't matter."""
    return to_simplified(word).casefold()


def clean_word(value: Any) -> str | None:
    """A wake word as typed in Settings, or None: one Latin word of 2-20 letters (digits,
    an apostrophe or a hyphen allowed after the first) or 2-8 Chinese characters, and
    not a word that already means something ("stop", "yes", "hey")."""
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", clean_text(value)).strip().strip("\"'“”‘’,.!?，。！？")
    if _LATIN.fullmatch(text):
        return None if text.lower().replace("’", "'") in _TAKEN else text
    simplified = to_simplified(text)
    return simplified if _CJK_ONLY.fullmatch(simplified) else None


def clean_pref(value: Any) -> dict[str, list[str]] | None:
    """prefs.features["wake_words"] read back: {"added": [...], "removed": [...]}, each a
    list of clean, distinct words; None when it isn't that shape."""
    if not isinstance(value, dict):
        return None
    kept: dict[str, list[str]] = {}
    for field in ("added", "removed"):
        items = value.get(field, [])
        if not isinstance(items, list):
            return None
        words: dict[str, str] = {}
        for item in items[:40]:
            word = clean_word(item)
            if word is not None:
                words.setdefault(fold(word), word)
        kept[field] = list(words.values())[:20]
    return kept


def defaults(persona: str, language: str = "en") -> list[str]:
    """What wakes it before the owner changes anything: "Jarvis", and the persona's own
    name (and, in Chinese, the name in Chinese)."""
    english, chinese = PERSONA_NAMES.get(persona, ("", ""))
    names = ["Jarvis"] + ([english] if english else [])
    if chinese and is_zh(language):
        names.append(chinese)
    return names


def effective(persona: str, language: str, pref: Any) -> list[str]:
    """The wake words in use: the defaults and what was added, less what was removed.
    Never empty (a file edited down to nothing still answers to "Jarvis")."""
    changes = clean_pref(pref) or EMPTY
    removed = {fold(w) for w in changes["removed"]}
    words: dict[str, str] = {}
    for word in defaults(persona, language) + changes["added"]:
        if fold(word) not in removed:
            words.setdefault(fold(word), word)
    return list(words.values())[:MAX_WORDS] or ["Jarvis"]


def of(prefs: Any) -> list[str]:
    """The wake words in use for these settings."""
    return effective(
        getattr(prefs, "persona", "jarvis"),
        getattr(prefs, "language", "en"),
        prefs.feature("wake_words") if hasattr(prefs, "feature") else None,
    )


def add(prefs: Any, word: Any) -> tuple[dict[str, list[str]] | None, str]:
    """The changes with `word` added, and "" (or None and why not, in words to show)."""
    clean = clean_word(word)
    if clean is None:
        return None, (
            "A wake word is one word (2 to 20 letters) or 2 to 8 Chinese characters, and not "
            "one I already answer to, like “stop” or “yes”."
        )
    current = of(prefs)
    changes = clean_pref(prefs.feature("wake_words")) or {"added": [], "removed": []}
    if any(fold(w) == fold(clean) for w in current):
        return changes, ""
    if len(current) >= MAX_WORDS:
        return None, f"That's {MAX_WORDS} wake words already; remove one first."
    removed = [w for w in changes["removed"] if fold(w) != fold(clean)]
    persona = getattr(prefs, "persona", "jarvis")
    back = any(fold(w) == fold(clean) for w in defaults(persona, getattr(prefs, "language", "en")))
    added = changes["added"] if back else [*changes["added"], clean]
    return {"added": added, "removed": removed}, ""


def remove(prefs: Any, word: Any) -> tuple[dict[str, list[str]] | None, str]:
    """The changes with `word` removed, and "" (or None and why not)."""
    target = fold(str(word or ""))
    current = of(prefs)
    if not any(fold(w) == target for w in current):
        return clean_pref(prefs.feature("wake_words")) or {"added": [], "removed": []}, ""
    if len(current) <= 1:
        return None, "Keep at least one wake word, or hands-free can’t be woken."
    changes = clean_pref(prefs.feature("wake_words")) or {"added": [], "removed": []}
    added = [w for w in changes["added"] if fold(w) != target]
    persona, language = getattr(prefs, "persona", "jarvis"), getattr(prefs, "language", "en")
    was_default = any(fold(w) == target for w in defaults(persona, language))
    removed = changes["removed"] + ([str(word).strip()] if was_default else [])
    return {"added": added, "removed": removed}, ""


def _own_personas(items: list[Any]) -> None:
    """The owner's own personas answer to their names too, as TARS and Friday do: each
    one's name, in English and in Chinese, when it can be a wake word at all (clean_word:
    one word, not one that already means something). Dropped ones stop answering."""
    for ident in [k for k in PERSONA_NAMES if k not in BUILT_IN_NAMES]:
        del PERSONA_NAMES[ident]
    for persona in items:
        ident = getattr(persona, "id", "")
        if not ident or ident in BUILT_IN_NAMES or ident == "jarvis":
            continue
        name = clean_word(getattr(persona, "name", "")) or ""
        zh_name = clean_word(getattr(persona, "zh_name", "")) or ""
        english = name if name and not has_cjk(name) else ""
        chinese = zh_name if has_cjk(zh_name) else (name if has_cjk(name) else "")
        if english or chinese:
            PERSONA_NAMES[ident] = (english, chinese)


personas.add_listener(_own_personas)
