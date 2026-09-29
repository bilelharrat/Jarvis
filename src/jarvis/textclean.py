"""Text from the user or the model, as it may be stored, shown on a card and read by Claude.

What the window and the approval cards can't show must not ride along where Claude reads
it: control characters (NUL…), invisible format characters (bidi overrides, zero widths,
the TAG letters that can spell out a whole hidden sentence), private-use, unassigned and
lone-surrogate code points, blank fillers, and runs of variation selectors (which can carry
hidden bytes). What people really write stays: line breaks and tabs, CJK and right-to-left
text, the joiner inside an emoji like 👩🏽\u200d💻 or between Persian or Hindi letters (nowhere else,
so "pass\u200dword" can't slip past a check), and one variation selector after a character (❤\ufe0f).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

_HIDDEN = frozenset({"Cc", "Cf", "Co", "Cs", "Cn"})
# Letters and marks that show nothing: the blank Hangul fillers, the combining grapheme
# joiner, Khmer's inherent vowels and Mongolian's free variation selectors.
_BLANK = frozenset("\u034f\u115f\u1160\u17b4\u17b5\u180b\u180c\u180d\u180f\u3164\uffa0")
_ZWNJ, _ZWJ = "\u200c", "\u200d"
_ASCII_HIDDEN = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_ARGV_BAD = re.compile("[\x00\ud800-\udfff]")


def clean_text(text: Any) -> str:
    """The text with everything that shows nothing taken out (see the module's note).
    Line breaks of every kind become \\n."""
    s = str(text).replace("\r\n", "\n").replace("\r", "\n")
    if s.isascii():  # most text: only the control characters can be hiding
        return _ASCII_HIDDEN.sub("", s)
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch in "\n\t":
            out.append(ch)
        elif ch in (_ZWJ, _ZWNJ):
            if _joins(out[-1] if out else "", s[i + 1] if i + 1 < len(s) else "", ch):
                out.append(ch)
        elif _selector(ch):
            if out and _takes_selector(out[-1], ch):
                out.append(ch)
        elif ch not in _BLANK and unicodedata.category(ch) not in _HIDDEN:
            out.append(ch)
    return "".join(out)


def argv_text(text: str) -> str:
    """Text that can ride on a command line (Claude Code gets its system prompt there): no
    NUL, and no half of a surrogate pair, which can't be encoded at all."""
    return _ARGV_BAD.sub("", text)


def _selector(ch: str) -> bool:
    return "\ufe00" <= ch <= "\ufe0f" or "\U000e0100" <= ch <= "\U000e01ef"


def _takes_selector(base: str, selector: str) -> bool:
    """One variation selector after a character (❤\ufe0f, 1\ufe0f⃣, 葛\U000e0100), never a run of them; the
    ideographic ones only after an ideograph."""
    if _selector(base) or base in (_ZWJ, _ZWNJ, "\n", "\t"):
        return False
    if selector >= "\U000e0100":
        return "\u3400" <= base <= "\u9fff" or "\uf900" <= base <= "\ufaff" or base >= "\U00020000"
    return True


def _joins(before: str, after: str, joiner: str) -> bool:
    """A joiner inside an emoji sequence (👩🏽\u200d💻, ❤\ufe0f\u200d🔥), or between two letters of a script
    written with joiners (Persian, Urdu, Hindi, Tamil…)."""
    if not before or not after:
        return False
    if joiner == _ZWJ and unicodedata.category(after) == "So":
        if before == "\ufe0f" or unicodedata.category(before) in ("So", "Sk"):
            return True
    return _joining_script(before) and _joining_script(after)


def _joining_script(ch: str) -> bool:
    """A letter or mark of the Arabic, Syriac or Indic scripts."""
    if not (
        "\u0600" <= ch <= "\u08ff"
        or "\u0900" <= ch <= "\u0dff"
        or "\ufb50" <= ch <= "\ufdff"
        or "\ufe70" <= ch <= "\ufefc"
    ):
        return False
    return unicodedata.category(ch)[0] in "LM"
