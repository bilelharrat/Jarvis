"""English text -> Kokoro phonemes, in pure Python (the offline voice, local_voice.py).

Kokoro was trained on the phonemes of misaki, its author's G2P library. misaki's own
lexicons (us_/gb_gold.json and _silver.json, downloaded with the model) hold those
phonemes word by word, in Kokoro's exact symbols, so no espeak and no new Python
dependency is needed. What misaki adds on top, the parts used here are rebuilt:

- normalize(): numbers, money, times, ordinals, years, percentages and common
  abbreviations as words ("$42.50" -> "forty-two dollars and fifty cents").
- Lexicon.word(): the lexicon's entry (gold before silver; the part-of-speech variants
  of a heteronym picked from the word before it: "to read" / "have read"), then -s, -'s,
  -ed and -ing on a known stem, two known words run together, and acronyms said letter by
  letter.
- phonemize(): a sentence's phonemes, or None when a word is still unknown. The caller
  then lets the Mac voice say that sentence: a word guessed from its spelling would be
  mispronounced, and a wrong name is worse than a different voice for one sentence.

English only: Kokoro's Chinese needs a Chinese G2P (jieba, pypinyin) this app doesn't
have, so Chinese stays on the Mac voice.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# Kokoro-82M's phoneme vocabulary (its config.json "vocab"): symbol -> token id.
VOCAB: dict[str, int] = {
    ";": 1, ":": 2, ",": 3, ".": 4, "!": 5, "?": 6, "—": 9, "…": 10, '"': 11, "(": 12,
    ")": 13, "“": 14, "”": 15, " ": 16, "̃": 17, "ʣ": 18, "ʥ": 19, "ʦ": 20, "ʨ": 21,
    "ᵝ": 22, "ꭧ": 23, "A": 24, "I": 25, "O": 31, "Q": 33, "S": 35, "T": 36, "W": 39,
    "Y": 41, "ᵊ": 42, "a": 43, "b": 44, "c": 45, "d": 46, "e": 47, "f": 48, "h": 50,
    "i": 51, "j": 52, "k": 53, "l": 54, "m": 55, "n": 56, "o": 57, "p": 58, "q": 59,
    "r": 60, "s": 61, "t": 62, "u": 63, "v": 64, "w": 65, "x": 66, "y": 67, "z": 68,
    "ɑ": 69, "ɐ": 70, "ɒ": 71, "æ": 72, "β": 75, "ɔ": 76, "ɕ": 77, "ç": 78, "ɖ": 80,
    "ð": 81, "ʤ": 82, "ə": 83, "ɚ": 85, "ɛ": 86, "ɜ": 87, "ɟ": 90, "ɡ": 92, "ɥ": 99,
    "ɨ": 101, "ɪ": 102, "ʝ": 103, "ɯ": 110, "ɰ": 111, "ŋ": 112, "ɳ": 113, "ɲ": 114,
    "ɴ": 115, "ø": 116, "ɸ": 118, "θ": 119, "œ": 120, "ɹ": 123, "ɾ": 125, "ɻ": 126,
    "ʁ": 128, "ɽ": 129, "ʂ": 130, "ʃ": 131, "ʈ": 132, "ʧ": 133, "ʊ": 135, "ʋ": 136,
    "ʌ": 138, "ɣ": 139, "ɤ": 140, "χ": 142, "ʎ": 143, "ʒ": 147, "ʔ": 148, "ˈ": 156,
    "ˌ": 157, "ː": 158, "ʰ": 162, "ʲ": 164, "↓": 169, "→": 171, "↗": 172, "↘": 173,
    "ᵻ": 177,
}  # fmt: skip
MAX_TOKENS = 510  # the model's context, less its two padding tokens

# ── numbers as words ──

_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen "
    "fourteen fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_SCALES = ((10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand"))
_ORDINAL = {
    "one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
    "nine": "ninth", "twelve": "twelfth",
}  # fmt: skip


def number_words(n: int) -> str:
    """1234 -> "one thousand two hundred thirty-four"."""
    if n < 0:
        return "minus " + number_words(-n)
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return f"{_ONES[hundreds]} hundred" + (f" {number_words(rest)}" if rest else "")
    for size, name in _SCALES:
        if n >= size:
            high, rest = divmod(n, size)
            return f"{number_words(high)} {name}" + (f" {number_words(rest)}" if rest else "")
    return str(n)  # pragma: no cover


def ordinal_words(n: int) -> str:
    """21 -> "twenty-first"."""
    words = number_words(n)
    head, _, last = words.rpartition(" ")
    pre, dash, unit = last.rpartition("-")
    if unit in _ORDINAL:
        unit = _ORDINAL[unit]
    elif unit.endswith("y"):
        unit = unit[:-1] + "ieth"
    else:
        unit += "th"
    last = f"{pre}{dash}{unit}"
    return f"{head} {last}" if head else last


def year_words(n: int) -> str:
    """1990 -> "nineteen ninety", 2005 -> "two thousand five", 2026 -> "twenty twenty-six"."""
    if 2000 <= n <= 2009:
        return number_words(n)
    high, low = divmod(n, 100)
    if low == 0:
        return f"{number_words(high)} hundred"
    return f"{number_words(high)} {'oh ' if low < 10 else ''}{number_words(low)}"


def _digits(text: str) -> str:
    return " ".join(_ONES[int(d)] for d in text)


_ABBREVIATIONS = {
    "Mr.": "Mister", "Mrs.": "Missus", "Ms.": "Miz", "Dr.": "Doctor", "Prof.": "Professor",
    "St.": "Saint", "Jr.": "Junior", "Sr.": "Senior", "vs.": "versus", "etc.": "et cetera",
    "e.g.": "for example", "i.e.": "that is", "approx.": "approximately", "No.": "number",
    "Jan.": "January", "Feb.": "February", "Mar.": "March", "Apr.": "April",
    "Aug.": "August", "Sep.": "September", "Sept.": "September", "Oct.": "October",
    "Nov.": "November", "Dec.": "December", "Mon.": "Monday", "Tue.": "Tuesday",
    "Wed.": "Wednesday", "Thu.": "Thursday", "Fri.": "Friday", "Sat.": "Saturday",
    "Sun.": "Sunday", "a.m.": "AM", "p.m.": "PM",
}  # fmt: skip
_ABBREVIATION = re.compile(
    r"(?<![\w.])(" + "|".join(re.escape(a) for a in _ABBREVIATIONS) + r")(?!\w)"
)
_CURRENCY = {"$": ("dollar", "cent"), "£": ("pound", "penny"), "€": ("euro", "cent")}
_MONEY = re.compile(
    r"([$£€])(\d[\d,]*)(?:\.(\d{1,2}))?(?:\s*(thousand|million|billion|trillion|[kKmMbB])\b)?"
)
_TIME = re.compile(r"\b(\d{1,2}):(\d{2})(?:\s*([aApP])\.?[mM]\b)?(?!\d)")
_AMPM = re.compile(r"\b(\d{1,2})\s*([aApP])\.?[mM]\b")
_ORDINAL_NUM = re.compile(r"\b(\d+)(st|nd|rd|th)\b", re.IGNORECASE)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*%")
_DECIMAL = re.compile(r"(?<![\d.])(\d+)\.(\d+)(?![\d.])")
_YEAR = re.compile(r"(?<![\d,.$£€])\b(1[1-9]\d\d|20\d\d)\b(?!,\d|\.\d)")
_THOUSANDS = re.compile(r"\b\d{1,3}(?:,\d{3})+\b")
_NUMBER = re.compile(r"\d+")
_NEGATIVE = re.compile(r"(?<![\w])-(\d)")
_SCALE_WORD = {"k": "thousand", "m": "million", "b": "billion"}


def _money(m: re.Match[str]) -> str:
    unit, small = _CURRENCY[m.group(1)]
    whole = int(m.group(2).replace(",", "") or 0)
    cents = int((m.group(3) or "0").ljust(2, "0"))
    scale = m.group(4)
    if scale:
        scale = _SCALE_WORD.get(scale.lower(), scale.lower())
        amount = number_words(whole) + (f" point {_digits(m.group(3))}" if m.group(3) else "")
        return f"{amount} {scale} {unit}s"
    said = f"{number_words(whole)} {unit}{'' if whole == 1 else 's'}"
    if cents:
        if small == "penny":
            smalls = "penny" if cents == 1 else "pence"
        else:
            smalls = small + ("" if cents == 1 else "s")
        said = (f"{said} and " if whole else "") + f"{number_words(cents)} {smalls}"
    return said


def _time(m: re.Match[str]) -> str:
    hour, minute = int(m.group(1)), int(m.group(2))
    if hour > 24 or minute > 59:
        return m.group(0)
    if minute == 0:
        said = f"{number_words(hour)} o'clock" if not m.group(3) else number_words(hour)
    elif minute < 10:
        said = f"{number_words(hour)} oh {number_words(minute)}"
    else:
        said = f"{number_words(hour)} {number_words(minute)}"
    return said + (f" {m.group(3).upper()}M" if m.group(3) else "")


def _whole(m: re.Match[str]) -> str:
    digits = m.group(0)
    return number_words(int(digits)) if len(digits) <= 15 else _digits(digits)


def normalize(text: str) -> str:
    """Numbers, money, times and abbreviations as words."""
    text = text.replace("’", "'").replace("‘", "'")
    text = _ABBREVIATION.sub(lambda m: _ABBREVIATIONS[m.group(1)], text)
    text = _MONEY.sub(_money, text)
    text = _TIME.sub(_time, text)
    text = _AMPM.sub(lambda m: f"{number_words(int(m.group(1)))} {m.group(2).upper()}M", text)
    text = _ORDINAL_NUM.sub(lambda m: ordinal_words(int(m.group(1))), text)
    text = _PERCENT.sub(lambda m: f"{m.group(1)} percent", text)
    text = _YEAR.sub(lambda m: year_words(int(m.group(1))), text)
    text = _THOUSANDS.sub(lambda m: m.group(0).replace(",", ""), text)
    text = _DECIMAL.sub(
        lambda m: f"{number_words(int(m.group(1)))} point {_digits(m.group(2))}", text
    )
    text = _NEGATIVE.sub(r"minus \1", text)
    text = _NUMBER.sub(_whole, text)
    text = text.replace("&", " and ").replace("+", " plus ").replace("@", " at ")
    return re.sub(r"\s+", " ", text).strip()


# ── the lexicon ──

_TOKEN = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*'?|[.,!?;:—…]|(?<=\s)-(?=\s)")
_VOWEL_START = re.compile(r"^[ˈˌ]?[aeiouæɑɐɒɔəɛɜɪʊʌAIOQWYᵊᵻ]")
_POSSESSIVE = ("my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those")
_BEFORE_NOUN = {"the", "a", "an", *_POSSESSIVE}
_BEFORE_VERB = {"to", "will", "would", "can", "could", "should", "must", "might", "may", "shall",
                "i", "you", "we", "they", "don't", "didn't", "won't", "please", "let's"}  # fmt: skip
_BEFORE_PARTICIPLE = {"have", "has", "had", "was", "were", "been", "be", "is", "are", "being"}
_VOICELESS = set("ptkfθ")
_SIBILANT = set("szʃʒʧʤ")


class Lexicon:
    """misaki's gold and silver lexicons for one accent ("us" or "gb")."""

    def __init__(self, gold: dict[str, Any], silver: dict[str, Any], british: bool = False):
        self.gold, self.silver, self.british = gold, silver, british

    @classmethod
    def load(cls, gold: Path, silver: Path, british: bool = False) -> Lexicon:
        """Read the downloaded lexicons (ValueError when one isn't a JSON object)."""
        tables = []
        for path in (gold, silver):
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError(f"{Path(path).name} isn't a lexicon")
            tables.append(data)
        return cls(tables[0], tables[1], british)

    def _entry(self, word: str, prev: str) -> str | None:
        for form in dict.fromkeys((word, word.lower(), word.capitalize())):
            for table in (self.gold, self.silver):
                found = table.get(form)
                if isinstance(found, dict):
                    found = self._variant(found, prev)
                if isinstance(found, str) and found:
                    return found
        return None

    @staticmethod
    def _variant(entry: dict[str, Any], prev: str) -> str | None:
        """A heteronym's pronunciation, from the word before it."""
        wanted: tuple[str, ...] = ()
        if prev in _BEFORE_PARTICIPLE:
            wanted = ("VBN", "VBD")
        elif prev in _BEFORE_VERB:
            wanted = ("VERB", "VB", "VBP")
        elif prev in _BEFORE_NOUN:
            wanted = ("NOUN", "NN")
        for key in (*wanted, "DEFAULT"):
            if isinstance(entry.get(key), str) and entry[key]:
                return entry[key]
        return next((v for v in entry.values() if isinstance(v, str) and v), None)

    def _suffix(self, stem: str, kind: str) -> str:
        last = stem.rstrip("ˈˌ")[-1:] if stem else ""
        schwa = "ɪ" if self.british else "ᵻ"
        if kind == "s":
            return stem + (f"{schwa}z" if last in _SIBILANT else "s" if last in _VOICELESS else "z")
        if kind == "ed":
            if last in ("t", "d"):
                return stem + f"{schwa}d"
            return stem + ("t" if last in _VOICELESS | {"s", "ʃ", "ʧ"} else "d")
        return stem + "ɪŋ"

    def _stemmed(self, word: str, prev: str) -> str | None:
        low = word.lower()
        tries: list[tuple[str, str]] = []
        if low.endswith("'s"):
            tries.append((word[:-2], "s"))
        elif low.endswith("s'"):
            tries.append((word[:-1], "s"))
        elif low.endswith("ies") and len(low) > 4:
            tries.append((word[:-3] + "y", "s"))
        elif low.endswith("es") and len(low) > 3:
            tries += [(word[:-2], "s"), (word[:-1], "s")]
        elif low.endswith("s") and not low.endswith("ss") and len(low) > 2:
            tries.append((word[:-1], "s"))
        if low.endswith("ed") and len(low) > 3:
            tries += [(word[:-2], "ed"), (word[:-1], "ed")]
            if len(low) > 4 and low[-3] == low[-4]:
                tries.append((word[:-3], "ed"))
            if low.endswith("ied"):
                tries.append((word[:-3] + "y", "ed"))
        if low.endswith("ing") and len(low) > 4:
            tries += [(word[:-3], "ing"), (word[:-3] + "e", "ing")]
            if len(low) > 5 and low[-4] == low[-5]:
                tries.append((word[:-4], "ing"))
        for stem, kind in tries:
            found = self._entry(stem, prev)
            if found:
                return self._suffix(found, kind)
        return None

    def _compound(self, word: str) -> str | None:
        """Two known words run together ("voiceprint", "dashboards")."""
        for cut in range(3, len(word) - 2):
            head, tail = word[:cut], word[cut:]
            first = self._entry(head, "")
            second = self._entry(tail, "") or self._stemmed(tail, "")
            if first and second:
                return first + second.replace("ˈ", "ˌ")
        return None

    def _letters(self, word: str) -> str | None:
        said = [self._entry(letter.upper(), "") for letter in word]
        if not all(said):
            return None
        return " ".join(str(s) for s in said)

    def word(self, word: str, prev: str = "", following: str = "") -> str | None:
        """A word's phonemes, or None when it's unknown. following: the next word's
        phonemes ("" when a pause or the end comes next)."""
        low = word.lower()
        if low == "a":
            return "ɐ" if following else "ˈA"  # "a cat", but "plan A."
        if low == "an" and following:
            return "ən"
        if low == "the":
            return "ði" if _VOWEL_START.match(following) else "ðə"
        if word == "I":
            return "ˈI"
        found = self._entry(word, prev)
        if found:
            return found
        if word.isupper() and 1 < len(word) <= 6:
            spelled = self._letters(word)
            if spelled:
                return spelled
        found = self._stemmed(word, prev) or (self._compound(word) if len(word) >= 6 else None)
        if found:
            return found
        if "'" in word:  # an unusual contraction or possessive: its first part
            head = word.split("'")[0]
            return self._entry(head, prev) if head else None
        return None


def tokens(text: str) -> list[str]:
    return _TOKEN.findall(text)


def phonemize(text: str, lexicon: Lexicon) -> tuple[str | None, list[str]]:
    """A sentence's phonemes and the words that weren't known. The phonemes are None when
    any word is unknown (the Mac voice says that sentence instead)."""
    words = tokens(normalize(text))
    looked: list[str | None] = [None] * len(words)
    following = ""  # the next word's phonemes, "" after a pause (read right to left)
    for i in range(len(words) - 1, -1, -1):
        word = words[i]
        if not word[0].isalpha():
            following = ""
            continue
        prev = next((w for w in reversed(words[:i]) if w[0].isalpha()), "")
        looked[i] = lexicon.word(word, prev.lower(), following)
        following = looked[i] or ""
    unknown = [w for w, found in zip(words, looked, strict=True) if w[0].isalpha() and not found]
    if unknown:
        return None, unknown
    said: list[str] = []
    for word, found in zip(words, looked, strict=True):
        if found:
            said.append(found)
        elif said:  # punctuation: on the word before it
            said[-1] += "—" if word == "-" else word
    return " ".join(said).strip(), []


def token_ids(phonemes: str) -> list[int]:
    """The model's tokens for phonemes (symbols it doesn't know dropped)."""
    return [VOCAB[c] for c in phonemes if c in VOCAB]


def chunks(phonemes: str, limit: int = 400) -> list[str]:
    """A long sentence's phonemes in pieces the model takes, cut after punctuation where
    it can, else at a space."""
    out: list[str] = []
    rest = phonemes.strip()
    while len(token_ids(rest)) > limit:
        window = rest[:limit]
        cut = max(window.rfind(p) for p in ",;:—…")
        cut = cut + 1 if cut > limit // 3 else window.rfind(" ")
        if cut <= 0:
            cut = limit
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out
