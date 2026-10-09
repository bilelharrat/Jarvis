"""Spoken punctuation, for a person who dictates and listens instead of looking: a blind or
low-vision professor with a screen reader can't glance at the page to see where the comma landed.

- from_speech(text, language) turns the punctuation a person says into the marks themselves, spaced
  and capitalised the way they are written: "Dear Ann comma new paragraph thanks for the notes
  period" becomes "Dear Ann,\\n\\nThanks for the notes." The recogniser often writes a comma or a
  full stop of its own beside the word it heard ("Dear Ann, comma, new paragraph, thanks, period");
  that one is dropped, so the mark is written once. A word that is also an ordinary word (a grace
  period, a dash of salt) stays a word when the words around it say so; a mark word at the very end,
  or right before another mark word, is always a mark.
- to_speech(text, level, language) makes a text ready for a voice to say its punctuation aloud, at
  the level the listener picks, like a screen reader's: "none" is the text as it is, "some" says
  what ends and divides sentences ("Hello comma world period"), "all" says every mark, symbols too
  ("example dot com", "3 point 5"). Decimals, times, thousands, web and e-mail addresses and the
  abbreviations everyone knows (Dr. e.g. U.S.) are not taken for ends of sentences.
- describe(text, language) says how a text is punctuated: how many sentences, how many of each mark.

English, and Chinese (a language that starts with "zh"). Anything else is treated as English.

Nothing here raises: text that can't be understood comes back as it was. The same rules are written
a second time, step for step, in web/features/punctuation.js (the window dictates and reads aloud
with them too), and tests/punctuation_cases.json holds the answers both must give, byte for byte.
That is why text is walked one character (code point) at a time and what counts as a space, a
letter or a digit is spelled out below, instead of leaning on regular-expression extras that
Python and JavaScript don't share. (What is a letter, a number or a mark, and what a letter's
capital is, come from each side's own Unicode tables, which can be releases apart: a character or a
capital added after Unicode 15 may be treated differently on the two sides.) Standard library only.
"""

from __future__ import annotations

import re
import unicodedata
from typing import NamedTuple

LEVELS = ("none", "some", "all")

# ── what a character is ──

# What separates words on a line, and what ends a line. Written out because \s means a slightly
# different set in Python and in JavaScript.
HSPACE = frozenset(
    chr(c)
    for c in (0x20, 0x09, 0x0B, 0x0C, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x202F, 0x205F, 0x3000)
)  # space, tab, VT, FF, no-break space, Ogham, the en/em/thin spaces, ideographic space
LINE_ENDS = frozenset(chr(c) for c in (0x0A, 0x0D, 0x2028, 0x2029))  # LF, CR, LS, PS
BLANKS = HSPACE | LINE_ENDS
BLANK_CHARS = "".join(sorted(BLANKS))
DIGITS = frozenset("0123456789")
# Marks that keep the two word characters around them in one word: don't, e-mail, snake_case,
# example.com, 3.5, a.m, and/or, me@home. (A mark word inside one of these is not a mark.)
JOINERS = frozenset("'’-_.@/\\")

_LOWER = {c: c + 32 for c in range(65, 91)}
_KINDS: dict[str, str] = {}
_KINDS_KEPT = 4096  # (a text of a thousand different scripts must not grow the table for good)


def _lower(text: str) -> str:
    """Lower case for ASCII letters only. The words that mean a mark are English, and the case of
    any other letter is none of their business (and one place two languages could disagree)."""
    return text.translate(_LOWER)


def _kind(c: str) -> str:
    """ "L" for a letter, "N" for a number, "M" for a mark that sits on a letter (an accent), "o"
    for everything else (and for no character at all)."""
    kind = _KINDS.get(c)
    if kind is None:
        kind = unicodedata.category(c)[0] if len(c) == 1 else "o"
        if kind not in ("L", "N", "M"):
            kind = "o"
        if len(_KINDS) < _KINDS_KEPT:
            _KINDS[c] = kind
    return kind


def _is_upper(c: str) -> bool:
    return c != c.lower()


def _capitalised(word: str) -> str:
    """The word with its first letter in capitals, and nothing else changed: "thanks" is "Thanks"
    and "NASA" stays. A letter whose capital is more than one letter (ß) is left, and so is a word
    that already has a capital inside (iPhone, eBay): that is how it was meant to be written."""
    first = word[0]
    capital = first.upper()
    if capital == first or len(capital) != 1:
        return word
    for c in word[1:]:
        if _is_upper(c):
            return word
    return capital + word[1:]


# ── the words that mean a mark (English) ──

SPACE, HUG, NUMBER_ONLY = 0, 1, 2  # leaves a space beside it; hugs the word there; hugs a number

# The words said, the mark, how the mark sits against the word before it and the word after it, and
# whether the next word starts a sentence. The one place the spoken words of English are kept.
_SPOKEN = (
    (("comma",), ",", HUG, SPACE, False),
    (("period", "full stop"), ".", HUG, SPACE, True),
    (("question mark",), "?", HUG, SPACE, True),
    (("exclamation mark", "exclamation point"), "!", HUG, SPACE, True),
    (("colon",), ":", HUG, SPACE, False),
    (("semicolon", "semi colon"), ";", HUG, SPACE, False),
    (("dash", "em dash"), "—", SPACE, SPACE, False),
    (("hyphen",), "-", HUG, HUG, False),
    (("ellipsis", "dot dot dot"), "…", HUG, SPACE, False),
    (("open parenthesis", "open paren", "left paren", "open bracket"), "(", SPACE, HUG, False),
    (("close parenthesis", "close paren", "right paren", "close bracket"), ")", HUG, SPACE, False),
    (("open quote", "begin quote"), '"', SPACE, HUG, False),
    (("close quote", "end quote", "unquote"), '"', HUG, SPACE, False),
    (("apostrophe",), "'", HUG, HUG, False),
    (("new line", "newline"), "\n", HUG, HUG, True),
    (("new paragraph",), "\n\n", HUG, HUG, True),
    (("at sign",), "@", HUG, HUG, False),
    (("ampersand",), "&", SPACE, SPACE, False),
    (("slash",), "/", HUG, HUG, False),
    (("percent sign",), "%", NUMBER_ONLY, SPACE, False),
    (("dollar sign",), "$", SPACE, HUG, False),
)


class _Mark(NamedTuple):
    text: str  # what is written
    before: int  # SPACE, HUG or NUMBER_ONLY: how it sits against the word before it
    after: int  # SPACE or HUG: how it sits against the word after it
    starts: bool  # whether the next word starts a sentence


_MARKS = {words: _Mark(*row[1:]) for row in _SPOKEN for words in row[0]}
_FIRST_WORDS = frozenset(words.split(" ")[0] for words in _MARKS)
_LONGEST_PHRASE = max(len(words.split(" ")) for words in _MARKS)

# Words that are also ordinary words. One of these is a mark only when nothing around it says it is
# the ordinary word (see BEFORE_ORDINARY, and "of" after it). A phrase goes by its last word: "em
# dash", "semi colon" and "open quote" are as ambiguous as "dash", "colon" and "quote".
AMBIGUOUS = frozenset({"period", "colon", "dash", "quote", "slash", "comma"})
# After one of these an ambiguous word is the ordinary word: "a dash of salt", "that quote", "a
# grace period", "the trial period". (Not a mark when it's last in the text or right before
# another mark word: there it's always a mark.)
BEFORE_ORDINARY = frozenset(
    (
        "a an the this that these those one each every same any another my your his her its our "
        "their no some per time grace trial waiting cooling probationary school class exam billing "
        "reporting reading long short whole entire ice dark middle early late first last next "
        "previous final key"
    ).split(" ")
)
# What the recogniser writes beside a word it also heard as a mark; the mark is written once.
# (A "?" or "!" it wrote is kept, unless the spoken word names that same mark.)
DROP = frozenset(",.")
_NO_SPACE_BEFORE = frozenset(",.;:!?)]}…”’»")  # (text beside a mark)
_NO_SPACE_AFTER = frozenset("([{“‘«¿¡")

# The words that mean a mark (Chinese): one per first character, so the first character finds it.
# The mark, and which more of the recogniser's own marks go with it (the same mark, said twice).
_SPOKEN_ZH = {
    "新段落": ("\n\n", ""),
    "结束引号": ("”", ""),
    "闭引号": ("”", ""),
    "开引号": ("“", ""),
    "感叹号": ("！", "！!"),
    "省略号": ("……", ""),
    "左括号": ("（", ""),
    "右括号": ("）", ""),
    "逗号": ("，", ""),
    "句号": ("。", ""),
    "问号": ("？", "？?"),
    "冒号": ("：", ""),
    "分号": ("；", ""),
    "顿号": ("、", ""),
    "换行": ("\n", ""),
}
_ZH_BY_FIRST = {words[0]: (words, *row) for words, row in _SPOKEN_ZH.items()}
_ZH_DROP = "，。,."


# ── dictating: spoken marks become marks ──


def _tokens(text: str) -> list[tuple[str, str]]:
    """The text in pieces that keep every character: ("w", a word), ("h", spaces on a line), ("n",
    a line end) and ("o", any other single character)."""
    chars = list(text)
    count = len(chars)
    tokens: list[tuple[str, str]] = []
    i = 0
    while i < count:
        c = chars[i]
        if c in HSPACE:
            j = i + 1
            while j < count and chars[j] in HSPACE:
                j += 1
            tokens.append(("h", "".join(chars[i:j])))
            i = j
        elif c in LINE_ENDS:
            tokens.append(("n", c))
            i += 1
        elif _kind(c) in ("L", "N"):
            j = i + 1
            while j < count:
                d = chars[j]
                if _kind(d) != "o":
                    j += 1
                elif d in JOINERS and j + 1 < count and _kind(chars[j + 1]) in ("L", "N"):
                    j += 2
                else:
                    break
            tokens.append(("w", "".join(chars[i:j])))
            i = j
        else:
            tokens.append(("o", c))
            i += 1
    return tokens


def _find(tokens: list[tuple[str, str]]) -> list[tuple[int, int, str]]:
    """Where mark words are said: (first token, last token, the words), longest phrase first."""
    count = len(tokens)
    found: list[tuple[int, int, str]] = []
    i = 0
    while i < count:
        if tokens[i][0] != "w" or _lower(tokens[i][1]) not in _FIRST_WORDS:
            i += 1
            continue
        words: list[str] = []
        best = None
        j = i
        while len(words) < _LONGEST_PHRASE:
            words.append(_lower(tokens[j][1]))
            phrase = " ".join(words)
            if phrase in _MARKS:
                best = (j, phrase)
            if j + 2 < count and tokens[j + 1][0] == "h" and tokens[j + 2][0] == "w":
                j += 2
            else:
                break
        if best is None:
            i += 1
        else:
            found.append((i, best[0], best[1]))
            i = best[0] + 1
    return found


def _only_noise(tokens: list[tuple[str, str]], first: int, stop: int, lines: bool) -> bool:
    """Whether the tokens from first up to stop are only spaces (and line ends, if lines) and a
    comma or full stop the recogniser wrote: nothing between that matters."""
    for k in range(first, stop):
        kind, text = tokens[k]
        if kind == "h" or (kind == "n" and lines) or (kind == "o" and text in DROP):
            continue
        return False
    return True


def _stays_a_word(
    tokens: list[tuple[str, str]],
    found: list[tuple[int, int, str]],
    k: int,
    first_word: int,
    last_end: int,
) -> bool:
    """Whether the ambiguous word found[k] is the ordinary word and not a mark: it comes after one
    of BEFORE_ORDINARY, or before "of", unless it is the first word, right after a line end or
    after another mark (that one ended at last_end). Last in the text, or right before another
    mark word, it is always a mark."""
    start, end, _ = found[k]
    count = len(tokens)
    if k + 1 < len(found) and _only_noise(tokens, end + 1, found[k + 1][0], False):
        return False
    if _only_noise(tokens, end + 1, count, True):
        return False
    if (
        start >= 2
        and tokens[start - 1][0] == "h"
        and tokens[start - 2][0] == "w"
        and _lower(tokens[start - 2][1]) in BEFORE_ORDINARY
    ):
        return True
    before_of = (
        end + 2 < count
        and tokens[end + 1][0] == "h"
        and tokens[end + 2][0] == "w"
        and _lower(tokens[end + 2][1]) == "of"
    )
    if not before_of:
        return False
    p = start - 1
    while p >= 0 and tokens[p][0] == "h":
        p -= 1
    leading = (
        start == first_word
        or (p >= 0 and tokens[p][0] == "n")
        or (last_end >= 0 and _only_noise(tokens, last_end + 1, start, False))
    )
    return not leading


def _decide(
    tokens: list[tuple[str, str]], found: list[tuple[int, int, str]]
) -> list[tuple[int, int, str]]:
    """Which of the words found are marks (the rest stay ordinary words)."""
    first_word = 0
    while tokens[first_word][0] != "w":
        first_word += 1
    marks: list[tuple[int, int, str]] = []
    last_end = -1
    for k, (start, end, phrase) in enumerate(found):
        ambiguous = phrase.split(" ")[-1] in AMBIGUOUS
        if ambiguous and _stays_a_word(tokens, found, k, first_word, last_end):
            continue
        marks.append((start, end, phrase))
        last_end = end
    return marks


def _plan(
    tokens: list[tuple[str, str]],
) -> tuple[dict[int, tuple[int, _Mark]], set[int]]:
    """What to do with the marks said: {first token of a mark: (its last token, the mark)}, and the
    tokens to drop: the comma or full stop the recogniser wrote beside a mark (a "?" or "!" too,
    when the mark is that same one)."""
    count = len(tokens)
    at: dict[int, tuple[int, _Mark]] = {}
    removed: set[int] = set()
    found = _find(tokens)
    if not found:
        return at, removed
    for start, end, phrase in _decide(tokens, found):
        mark = _MARKS[phrase]
        same = mark.text if mark.text in ("?", "!") else ""
        j = start - 1
        while j >= 0 and tokens[j][0] == "h":
            j -= 1
        if j >= 0 and tokens[j][0] == "o" and (tokens[j][1] in DROP or tokens[j][1] == same):
            removed.add(j)
        j = end + 1
        while j < count and tokens[j][0] == "h":
            j += 1
        if j < count and tokens[j][0] == "o" and (tokens[j][1] in DROP or tokens[j][1] == same):
            removed.add(j)
        at[start] = (end, mark)
    return at, removed


def _space_after(last: tuple) -> bool:
    """Whether a space follows the thing just written (a mark, or a piece of the text)."""
    kind = last[0]
    if kind == "m":
        return last[1].after == SPACE
    if kind == "n":
        return False
    return kind == "w" or last[1] not in _NO_SPACE_AFTER


def _space_before(kind: str, text: str) -> bool:
    """Whether a space comes before a piece of the text that follows a mark."""
    if kind == "n":
        return False
    return kind == "w" or text not in _NO_SPACE_BEFORE


def _lay_out(
    tokens: list[tuple[str, str]], at: dict[int, tuple[int, _Mark]], removed: set[int]
) -> str:
    """The text written out: each mark spaced the way it is written (the spaces the text had beside
    it are replaced, all others kept), the recogniser's own marks gone, and the first letter of
    each sentence, line and the text in capitals."""
    count = len(tokens)
    out: list[str] = []
    capital = True  # the next word starts a sentence
    last: tuple | None = None  # what was written last: ("m", mark) or (kind, text); None at first
    gap = ""  # the spaces seen since
    i = 0
    while i < count:
        if i in removed:
            i += 1
            continue
        if i in at:
            end, mark = at[i]
            space = ""
            if last is not None:
                number = last[0] == "w" and last[1][-1] in DIGITS
                loose = mark.before == SPACE or (mark.before == NUMBER_ONLY and not number)
                space = " " if loose and _space_after(last) else ""
            out.append(space + mark.text)
            if mark.starts:
                capital = True
            last = ("m", mark)
            gap = ""
            i = end + 1
            continue
        kind, piece = tokens[i]
        i += 1
        if kind == "h":
            gap += piece
            continue
        if last is not None and last[0] == "m":
            out.append(" " if last[1].after == SPACE and _space_before(kind, piece) else "")
        else:
            out.append(gap)
        if kind == "w":
            if capital:
                piece = _capitalised(piece)
                capital = False
        elif kind == "n":
            capital = True
        out.append(piece)
        last = (kind, piece)
        gap = ""
    if last is None or last[0] != "m":
        out.append(gap)
    return "".join(out)


def _dictated_en(text: str) -> str:
    """English: the marks said become marks, and the text around them is laid out as written."""
    tokens = _tokens(text)
    at, removed = _plan(tokens)
    return _lay_out(tokens, at, removed)


def _dictated_zh(text: str) -> str:
    """Chinese: the words are replaced where they stand (no spaces are involved), and a comma or
    full stop the recogniser wrote beside one goes. Everything else is left alone."""
    out: list[str] = []
    start = 0  # where the plain text since the last mark begins
    i = 0
    count = len(text)
    while i < count:
        row = _ZH_BY_FIRST.get(text[i])
        if row is None or not text.startswith(row[0], i):
            i += 1
            continue
        words, mark, same = row
        drop = _ZH_DROP + same
        before = text[start:i]
        kept = before.rstrip(" \t")
        if kept and kept[-1] in drop:
            before = kept[:-1]
        out.append(before)
        out.append(mark)
        i += len(words)
        start = i
        j = i
        while j < count and text[j] in " \t":
            j += 1
        if j < count and text[j] in drop:
            i = start = j + 1
    if not out:
        return text
    out.append(text[start:])
    return "".join(out)


def _tongue(language: object) -> str:
    """ "zh" for a language that starts with zh (zh-CN, zh_TW), else "en"."""
    return "zh" if _lower(str(language)).startswith("zh") else "en"


def _dictated(text: str, language: object) -> str:
    """from_speech without the safety net (the tests call it, to see a failure)."""
    return _dictated_zh(text) if _tongue(language) == "zh" else _dictated_en(text)


def from_speech(text: str, language: str = "en") -> str:
    """Dictated text with the spoken punctuation turned into marks, spaced and capitalised the way
    it is written. Anything that is not text comes back as it was."""
    if not isinstance(text, str) or not text:
        return text
    try:
        return _dictated(text, language)
    except Exception:  # an odd character must never stop a person from typing
        return text


# ── listening: marks become words ──

# What each mark is called when it is said, in each language.
_NAMES = {
    "en": {
        "comma": "comma",
        "period": "period",
        "dot": "dot",
        "point": "point",
        "question": "question mark",
        "exclaim": "exclamation mark",
        "colon": "colon",
        "semicolon": "semicolon",
        "open_paren": "open parenthesis",
        "close_paren": "close parenthesis",
        "open_quote": "open quote",
        "close_quote": "close quote",
        "dash": "dash",
        "hyphen": "hyphen",
        "apostrophe": "apostrophe",
        "ellipsis": "ellipsis",
        "newline": "new line",
        "paragraph": "new paragraph",
        "slash": "slash",
        "backslash": "backslash",
        "at": "at",
        "hash": "hash",
        "ampersand": "ampersand",
        "asterisk": "asterisk",
        "underscore": "underscore",
        "equals": "equals",
        "plus": "plus",
        "percent": "percent",
        "dollar": "dollar",
        "tilde": "tilde",
        "caret": "caret",
        "bar": "bar",
        "less": "less than",
        "greater": "greater than",
        "open_bracket": "open bracket",
        "close_bracket": "close bracket",
        "open_brace": "open brace",
        "close_brace": "close brace",
    },
    "zh": {
        "comma": "逗号",
        "period": "句号",
        "dot": "点",
        "point": "小数点",
        "question": "问号",
        "exclaim": "感叹号",
        "colon": "冒号",
        "semicolon": "分号",
        "enum": "顿号",
        "open_paren": "左括号",
        "close_paren": "右括号",
        "open_quote": "开引号",
        "close_quote": "结束引号",
        "dash": "破折号",
        "hyphen": "连字符",
        "apostrophe": "撇号",
        "ellipsis": "省略号",
        "newline": "换行",
        "paragraph": "新段落",
        "slash": "斜杠",
        "backslash": "反斜杠",
        "at": "艾特",
        "hash": "井号",
        "ampersand": "和号",
        "asterisk": "星号",
        "underscore": "下划线",
        "equals": "等号",
        "plus": "加号",
        "percent": "百分号",
        "dollar": "美元符号",
        "tilde": "波浪号",
        "caret": "脱字符",
        "bar": "竖线",
        "less": "小于号",
        "greater": "大于号",
        "open_bracket": "左方括号",
        "close_bracket": "右方括号",
        "open_brace": "左花括号",
        "close_brace": "右花括号",
    },
}
# The marks only level "all" says.
_SYMBOLS = {
    "/": "slash",
    "\\": "backslash",
    "@": "at",
    "#": "hash",
    "&": "ampersand",
    "*": "asterisk",
    "_": "underscore",
    "=": "equals",
    "+": "plus",
    "%": "percent",
    "$": "dollar",
    "~": "tilde",
    "^": "caret",
    "|": "bar",
    "<": "less",
    ">": "greater",
    "[": "open_bracket",
    "]": "close_bracket",
    "{": "open_brace",
    "}": "close_brace",
}
# Chinese marks (and whether each ends a sentence); only a Chinese text has them to say.
_FULL = {
    "，": ("comma", False),
    "。": ("period", True),
    "？": ("question", True),
    "！": ("exclaim", True),
    "：": ("colon", False),
    "；": ("semicolon", False),
    "、": ("enum", False),
    "（": ("open_paren", False),
    "）": ("close_paren", False),
}
# "didn't" and "dogs'" have this in them; the curly ones too.
APOSTROPHES = frozenset("'‘’")
# The characters that may close a sentence after its last mark: ."), ?'
SENTENCE_TAIL = frozenset("\"”’')]}»")
_OPENING = frozenset("([{")
_WATCH_EN = (BLANKS - {" "}) | frozenset(".,?!:;()\"“”-–—…'‘’") | frozenset(_SYMBOLS)
_WATCH_ZH = _WATCH_EN | frozenset(_FULL)

# The abbreviations whose full stop is not the end of a sentence, in lower case with the stop.
# (e.g. i.e. a.m. p.m. U.S. and any run of single letters, like J.R.R., are known without this.)
ABBREVIATIONS = frozenset(
    "dr. mr. mrs. ms. prof. st. jr. sr. vs. etc. e.g. i.e. inc. ltd. co. no. a.m. p.m. u.s. "
    "al. cf. ph.d. pp. vol. dept. approx.".split(" ")
)
CAPITAL_ONLY = frozenset({"no"})  # "No. 5" is an abbreviation; "I said no." is a sentence
_LONGEST_ABBREVIATION = 8  # letters and dots before the stop; a longer run is a word or an address


def _initials(word: str) -> bool:
    """Single letters with dots between: U.S, e.g, a.m, J.R.R (the last stop is not in the word)."""
    if len(word) < 3 or len(word) % 2 == 0:
        return False
    for k, c in enumerate(word):
        if k % 2:
            if c != ".":
                return False
        elif _kind(c) != "L":
            return False
    return True


def _abbreviation(chars: list[str], i: int) -> bool:
    """Whether the full stop at chars[i] closes an abbreviation or a single capital initial."""
    j = i
    while j > 0 and (chars[j - 1] == "." or _kind(chars[j - 1]) in ("L", "M")):
        j -= 1
        if i - j > _LONGEST_ABBREVIATION:
            return False
    if j == i or (j > 0 and chars[j - 1] in DIGITS):  # nothing before it, or part of "5A."
        return False
    word = "".join(chars[j:i])
    low = _lower(word)
    if low + "." in ABBREVIATIONS:
        return low not in CAPITAL_ONLY or _is_upper(chars[j])
    if len(word) == 1:
        return _is_upper(word)
    return _initials(word)


def _ends(chars: list[str], j: int) -> bool:
    """Whether a sentence could end at chars[j - 1]: only closing marks, then a space or the end."""
    count = len(chars)
    while j < count and chars[j] in SENTENCE_TAIL:
        j += 1
    return j >= count or chars[j] in BLANKS


def _speak(text: str, level: str, lang: str) -> list:
    """The text as a list: pieces that stay as they are (a character, or a few), and (name, ends)
    for each mark to be said (ends: it closes a sentence). Spaces and line ends are looked at only
    here; the white space of the text is trimmed, a run of it is one space, a line end is a mark."""
    chars = list(text.strip(BLANK_CHARS))
    count = len(chars)
    names = _NAMES[lang]
    everything = level == "all"
    watch = _WATCH_ZH if lang == "zh" else _WATCH_EN
    items: list = []
    add = items.append
    i = 0
    while i < count:
        c = chars[i]
        if c not in watch:
            add(c)
            i += 1
            continue
        before = chars[i - 1] if i else ""
        after = chars[i + 1] if i + 1 < count else ""
        step = 1
        if c in BLANKS:
            j = i + 1
            while j < count and chars[j] in BLANKS:
                j += 1
            breaks = 0
            for k in range(i, j):
                if chars[k] in LINE_ENDS and not (
                    chars[k] == "\r" and k + 1 < j and chars[k + 1] == "\n"
                ):
                    breaks += 1
            if breaks == 0:
                add(" ")
            else:
                add((names["newline" if breaks == 1 else "paragraph"], False))
            step = j - i
        elif c == ".":
            run = 1
            while i + run < count and chars[i + run] == ".":
                run += 1
            if run >= 3:
                if everything:
                    add((names["ellipsis"], _ends(chars, i + run)))
                else:
                    add("." * run)
                step = run
            elif before in DIGITS and after in DIGITS:
                add((names["point"], False) if everything else c)
            elif before != "." and _ends(chars, i + 1) and not _abbreviation(chars, i):
                add((names["period"], True))
            else:
                add((names["dot"], False) if everything else c)
        elif c == ",":
            add(c if before in DIGITS and after in DIGITS else (names["comma"], False))
        elif c == "?":
            add((names["question"], _ends(chars, i + 1)))
        elif c == "!":
            add((names["exclaim"], _ends(chars, i + 1)))
        elif c == ":":
            if everything or _ends(chars, i + 1):
                add((names["colon"], False))
            else:
                add(c)
        elif c == ";":
            add((names["semicolon"], False))
        elif c == "(":
            add((names["open_paren"], False))
        elif c == ")":
            add((names["close_paren"], False))
        elif c == '"':
            opening = before == "" or before in BLANKS or before in _OPENING
            add((names["open_quote" if opening else "close_quote"], False))
        elif c == "“":
            add((names["open_quote"], False))
        elif c == "”":
            add((names["close_quote"], False))
        elif c in ("–", "—"):
            add((names["dash"], False))
        elif c == "-":
            if (before == "" or before in BLANKS) and (after == "" or after in BLANKS):
                add((names["dash"], False))
            elif everything and _kind(before) != "o" and _kind(after) != "o":
                add((names["hyphen"], False))
            else:
                add(c)
        elif c == "…":
            run = 1
            while i + run < count and chars[i + run] == "…":
                run += 1
            if everything:
                add((names["ellipsis"], _ends(chars, i + run)))
            else:
                add(c * run)
            step = run
        elif c in APOSTROPHES:
            inside = _kind(before) != "o" and _kind(after) != "o"
            add(c if inside or not everything else (names["apostrophe"], False))
        elif c in _SYMBOLS:
            add((names[_SYMBOLS[c]], False) if everything else c)
        else:  # a Chinese mark (only in a Chinese text)
            key, ends = _FULL[c]
            add((names[key], ends))
        i += step
    return items


def _said(items: list) -> str:
    """The items as one line: each mark's name between single spaces, spaces collapsed, trimmed."""
    parts = [item if type(item) is str else f" {item[0]} " for item in items]
    return re.sub(" {2,}", " ", "".join(parts)).strip(" ")


def _level(level: object) -> str:
    """ "none", "some" or "all"; anything else (a typo, a missing setting) is "some"."""
    word = _lower(level) if isinstance(level, str) else ""
    return word if word in LEVELS else "some"


def to_speech(text: str, level: str = "some", language: str = "en") -> str:
    """Text made ready for a voice to say its punctuation aloud. level "none" gives the text back
    unchanged; "some" says the marks that end and divide sentences; "all" says every mark."""
    if not isinstance(text, str):
        return text
    level = _level(level)
    if level == "none":
        return text
    try:
        return _said(_speak(text, level, _tongue(language)))
    except Exception:  # (a voice that fails to read is worse than one that reads it plain)
        return text


# ── describing ──


def _plural(name: str, count: int) -> str:
    """ "1 comma", "2 commas", "3 open parentheses", "1 at sign"."""
    if name in _SIGNS:
        name += " sign"
    if count == 1:
        return f"1 {name}"
    return f"{count} {_PLURALS.get(name, name + 's')}"


_SIGNS = frozenset({"at", "dollar", "percent", "equals", "plus", "less than", "greater than"})
_PLURALS = {
    "dash": "dashes",
    "hash": "hashes",
    "slash": "slashes",
    "backslash": "backslashes",
    "ellipsis": "ellipses",
    "open parenthesis": "open parentheses",
    "close parenthesis": "close parentheses",
}


def _and(parts: list[str], joiner: str, comma: str) -> str:
    """ "a", "a and b", "a, b and c"."""
    if len(parts) == 1:
        return parts[0]
    return comma.join(parts[:-1]) + joiner + parts[-1]


def _summary(counts: dict[str, int], sentences: int, lang: str) -> str:
    """The sentence a voice says about a text's punctuation, the marks that are most used first."""
    names = sorted(counts, key=lambda name: (-counts[name], name))
    if lang == "zh":
        if not names:
            return "没有标点。"
        parts = [f"{counts[name]} 个{name}" for name in names]
        return f"{sentences} 句话。{_and(parts, '和 ', '，')}。"
    if not names:
        return "No punctuation."
    parts = [_plural(name, counts[name]) for name in names]
    noun = "sentence" if sentences == 1 else "sentences"
    return f"{sentences} {noun}. {_and(parts, ' and ', ', ')}."


def _described(text: str, language: object) -> dict:
    """describe without the safety net (the tests call it, to see a failure)."""
    lang = _tongue(language)
    items = _speak(text, "all", lang)
    if not items:
        empty = "没有可描述的内容。" if lang == "zh" else "There's nothing to describe."
        return {"summary": empty, "spoken": "", "counts": {}, "sentences": 0}
    names = _NAMES[lang]
    layout = (names["newline"], names["paragraph"])  # (where a line ends is not punctuation)
    counts: dict[str, int] = {}
    sentences = 0
    for item in items:
        if type(item) is str:
            continue
        name, ends = item
        if ends:
            sentences += 1
        if name not in layout:
            counts[name] = counts.get(name, 0) + 1
    sentences = sentences or 1
    return {
        "summary": _summary(counts, sentences, lang),
        "spoken": _said(items),
        "counts": counts,
        "sentences": sentences,
    }


def describe(text: str, language: str = "en") -> dict:
    """How a text is punctuated: {"summary": a sentence a voice can say, "spoken": the text with
    every mark said, "counts": {name: how many} for the marks there are, "sentences": how many}."""
    try:
        return _described(text if isinstance(text, str) else "", language)
    except Exception:
        empty = "There's nothing to describe."
        return {"summary": empty, "spoken": "", "counts": {}, "sentences": 0}
