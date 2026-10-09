"""Spoken punctuation (punctuation.py): dictating marks, hearing them, describing a text.

Every case in tests/punctuation_cases.json is checked here, and the window's JavaScript
(web/features/punctuation.js) checks the very same file (tests/web/punctuation.test.mjs): that is
what proves the two give identical answers. The rest are things that must hold for any text.
"""

from __future__ import annotations

import json
import random
import re
import time
from pathlib import Path

import pytest

from jarvis import punctuation

CASES = json.loads((Path(__file__).parent / "punctuation_cases.json").read_text(encoding="utf-8"))
NBSP = "\xa0"
ZWJ = chr(0x200D)


def ids(group: str) -> list[str]:
    """Test names that say which case it is: its number and the start of its text."""
    return [f"{n:03d}-{ascii(case['in'])[:48]}" for n, case in enumerate(CASES[group])]


def ask(function, case, *keys):
    """Call function with the case's text and whichever of its settings the case has (so the
    defaults are tried too)."""
    return function(case["in"], *[case[key] for key in keys if key in case])


@pytest.mark.parametrize("case", CASES["from_speech"], ids=ids("from_speech"))
def test_dictated_text_gets_its_marks(case):
    assert ask(punctuation.from_speech, case, "language") == case["out"]


@pytest.mark.parametrize("case", CASES["to_speech"], ids=ids("to_speech"))
def test_text_is_made_ready_for_a_voice(case):
    assert ask(punctuation.to_speech, case, "level", "language") == case["out"]


@pytest.mark.parametrize("case", CASES["describe"], ids=ids("describe"))
def test_a_text_is_described(case):
    assert ask(punctuation.describe, case, "language") == case["out"]


def test_the_cases_are_enough_and_cover_every_spoken_word_and_abbreviation():
    assert len(CASES["from_speech"]) >= 60
    assert len(CASES["to_speech"]) >= 50
    assert len(CASES["describe"]) >= 12
    english = " \n".join(case["in"] for case in CASES["from_speech"] if "language" not in case)
    for row in punctuation._SPOKEN:
        for words in row[0]:
            pattern = rf"(?<![A-Za-z]){re.escape(words)}(?![A-Za-z])"
            assert re.search(pattern, english, re.IGNORECASE), f"no case says {words!r}"
    chinese = "\n".join(case["in"] for case in CASES["from_speech"] if "language" in case)
    for words in punctuation._SPOKEN_ZH:
        assert words in chinese, f"no case says {words!r}"
    heard = "\n".join(case["in"] for case in CASES["to_speech"] if "language" not in case)
    abbreviations = (
        "Dr. Mr. Mrs. Ms. Prof. St. Jr. Sr. vs. etc. e.g. i.e. Inc. Ltd. Co. No. a.m. p.m. U.S."
    )
    for abbreviation in abbreviations.split(" "):
        assert abbreviation in heard, f"no case has {abbreviation!r}"
    for level in punctuation.LEVELS:
        assert any(case["level"] == level for case in CASES["to_speech"])
    assert any(case.get("language") == "zh" for case in CASES["to_speech"])
    assert any(case.get("language") == "zh" for case in CASES["describe"])


def test_the_levels():
    assert punctuation.LEVELS == ("none", "some", "all")


def test_the_defaults_are_english_and_some():
    assert punctuation.from_speech("hi comma you") == "Hi, you"
    assert punctuation.to_speech("Hi, you.") == "Hi comma you period"
    assert punctuation.describe("Hi, you.")["counts"] == {"comma": 1, "period": 1}


# ── the language and the level ──


@pytest.mark.parametrize("language", ["zh", "zh-CN", "zh_TW", "ZH", "Zh-Hans"])
def test_a_language_that_starts_with_zh_is_chinese(language):
    assert punctuation.from_speech("你好逗号世界", language) == "你好，世界"
    assert punctuation.to_speech("你好，世界", "some", language) == "你好 逗号 世界"


@pytest.mark.parametrize("language", ["en", "en-US", "fr", "", None, 5, "auto"])
def test_anything_else_is_english(language):
    assert punctuation.from_speech("hi comma you", language) == "Hi, you"
    assert punctuation.from_speech("你好逗号世界", language) == "你好逗号世界"
    assert punctuation.to_speech("Hi, you.", "some", language) == "Hi comma you period"


@pytest.mark.parametrize("level", ["ALL", "All", "all"])
def test_the_level_may_be_in_any_case(level):
    assert punctuation.to_speech("a-b", level) == "a hyphen b"


@pytest.mark.parametrize("level", ["loud", "", " all", None, 3, ["all"]])
def test_a_level_that_is_not_one_is_some(level):
    assert punctuation.to_speech("Hi, a-b.", level) == "Hi comma a-b period"


# ── anything at all ──


@pytest.mark.parametrize("odd", [None, 5, 2.5, b"bytes", ["a", "b"], {"a": 1}, object])
def test_what_is_not_text_comes_back_as_it_was(odd):
    assert punctuation.from_speech(odd) is odd
    assert punctuation.to_speech(odd) is odd
    assert punctuation.to_speech(odd, "none") is odd
    assert punctuation.describe(odd) == {
        "summary": "There's nothing to describe.",
        "spoken": "",
        "counts": {},
        "sentences": 0,
    }


def test_a_failure_inside_never_reaches_the_caller(monkeypatch):
    def boom(*_args):
        raise RuntimeError("something nobody thought of")

    monkeypatch.setattr(punctuation, "_dictated", boom)
    monkeypatch.setattr(punctuation, "_speak", boom)
    monkeypatch.setattr(punctuation, "_described", boom)
    assert punctuation.from_speech("hi comma you") == "hi comma you"
    assert punctuation.to_speech("Hi, you.") == "Hi, you."
    assert punctuation.describe("Hi, you.") == {
        "summary": "There's nothing to describe.",
        "spoken": "",
        "counts": {},
        "sentences": 0,
    }


def random_text(rng: random.Random, size: int) -> str:
    """Pieces of the kind that make trouble: mark words, marks, every kind of space, other
    scripts, emoji, accents, joiners, control characters, a lone surrogate, any code point."""
    words = [
        "comma", "period", "full stop", "question mark", "exclamation mark", "colon", "semicolon",
        "semi colon", "dash", "em dash", "hyphen", "ellipsis", "dot dot dot", "open paren",
        "close paren", "open quote", "close quote", "end quote", "unquote", "apostrophe",
        "new line", "newline", "new paragraph", "at sign", "ampersand", "slash", "percent sign",
        "dollar sign", "the", "a", "of", "grace", "hello", "World", "NASA", "iPhone", "3.5", "Dr.",
        "e.g.", "U.S.", "No.", "no.", "Ph.D.", "p.m.", "et al.", "5A.", "x--y", "3:30", "don't",
        "https://x.com/a?b=1", "a@b.com", "你好", "逗号", "句号", "新段落", "左括号", "结束引号",
        "开引号", "问号", "ß", "café", "école", "😀", ZWJ, chr(0x301), chr(0xFE0F), "\x00",
        "ǆ", "İ", "ﬁ", chr(0xD800),
    ]  # fmt: skip
    marks = list(",.?!:;()\"'“”‘’-–—…/\\@#&*_=+%$~^|<>[]{}`，。？！：；、（）") + [
        "……", "...", "..", "«", "»", "¿",
    ]  # fmt: skip
    spaces = [
        " ", " ", " ", "  ", "\t", "\n", "\n\n", "\r\n", "\r", NBSP, chr(0x2028), chr(0x2029),
        chr(0x3000), chr(0x200B), chr(0xFEFF), "\x0b", "\x85", "",
    ]  # fmt: skip
    parts = []
    for _ in range(size):
        roll = rng.random()
        if roll < 0.45:
            parts.append(rng.choice(words))
        elif roll < 0.7:
            parts.append(rng.choice(marks))
        elif roll < 0.93:
            parts.append(rng.choice(spaces))
        else:
            parts.append(chr(rng.choice([rng.randrange(32, 127), rng.randrange(128, 0xD800),
                                         rng.randrange(0xE000, 0x11000)])))  # fmt: skip
    return "".join(parts)


def test_nothing_raises_on_a_few_thousand_odd_texts():
    rng = random.Random(20261008)
    for _ in range(3000):
        text = random_text(rng, rng.randrange(0, 40))
        for language in ("en", "zh"):
            assert isinstance(punctuation._dictated(text, language), str)
            assert isinstance(punctuation._described(text, language), dict)
            for level in ("some", "all"):
                said = punctuation._said(punctuation._speak(text, level, language))
                assert isinstance(said, str)
                assert "\n" not in said and "\r" not in said
                assert "  " not in said and said == said.strip(" ")
        assert isinstance(punctuation.from_speech(text), str)
        assert isinstance(punctuation.to_speech(text, "all"), str)
        assert isinstance(punctuation.describe(text), dict)


def test_level_none_gives_the_text_back():
    rng = random.Random(7)
    for _ in range(1500):
        text = random_text(rng, rng.randrange(0, 30))
        assert punctuation.to_speech(text, "none") == text
        assert punctuation.to_speech(text, "none", "zh") == text


MARKLESS_WORDS = [
    "hello", "World", "NASA", "iPhone", "ok", "3.5", "Dr.", "e.g.", "U.S.", "école", "ça", "ß",
    "ﬁsh", "你好", "😀", "x", "don't", "well-known", "a@b.com", "periods", "commas", "dashboard",
]  # fmt: skip
MARKLESS_PIECES = list(",.?!:;()\"'-—…/&%$") + [" ", " ", "  ", "\t", "\n", "\r\n", NBSP]


def markless_text(rng: random.Random) -> str:
    """A text with no mark word in it (so nothing in it is said as punctuation)."""
    size = rng.randrange(0, 25)
    return "".join(
        rng.choice(MARKLESS_WORDS) if rng.random() < 0.5 else rng.choice(MARKLESS_PIECES)
        for _ in range(size)
    )


def test_text_with_no_mark_words_only_gets_a_capital_and_is_then_left_alone():
    rng = random.Random(99)
    for _ in range(1500):
        text = markless_text(rng)
        once = punctuation.from_speech(text)
        assert punctuation.from_speech(once) == once  # idempotent
        assert once.lower() == text.lower()  # every other character is kept
        assert len(once) == len(text)


def test_chinese_text_with_no_mark_word_is_left_exactly_alone():
    rng = random.Random(3)
    for _ in range(500):
        text = markless_text(rng)
        assert punctuation.from_speech(text, "zh") == text


def test_describe_says_what_to_speech_says():
    rng = random.Random(11)
    for _ in range(800):
        text = random_text(rng, rng.randrange(0, 30))
        for language in ("en", "zh"):
            described = punctuation.describe(text, language)
            assert described["spoken"] == punctuation.to_speech(text, "all", language)
            assert set(described) == {"summary", "spoken", "counts", "sentences"}
            assert all(isinstance(n, int) and n > 0 for n in described["counts"].values())
            blank = text.strip(punctuation.BLANK_CHARS) == ""
            assert (described["sentences"] == 0) == blank


ROUND_TRIPS = [
    "Hello, world.",
    "Is it ready? Yes! Go (now) \u2014 please.",
    "Dear Ann: thanks; bye.",
    'He said "hello" and left.',
    "One.\n\nTwo.\nThree.",
    "Dear Ann,\n\nThanks for the notes.",
    "Wait… what?",
    "Meet Dr. Smith at 3:30 p.m.",
    "A well-known fact.",
]


@pytest.mark.parametrize("text", ROUND_TRIPS, ids=[ascii(text)[:40] for text in ROUND_TRIPS])
def test_what_a_listener_hears_a_dictator_can_say_back(text):
    heard = punctuation.to_speech(text, "some")
    assert punctuation.from_speech(heard) == text


def test_a_mark_word_is_a_whole_word_only():
    for word in ("commas", "periodic", "dashboard", "colonel", "slashes", "newlines", "comma2"):
        assert punctuation.from_speech(f"hello {word} there") == f"Hello {word} there"


def test_a_mark_word_inside_an_address_or_a_hyphenated_word_stays_a_word():
    for text in ("my.period.tracker", "comma-separated", "read/slash/write", "a@period.com"):
        assert punctuation.from_speech(text) == text[0].upper() + text[1:]


def test_the_recognisers_question_mark_is_kept_unless_the_spoken_word_names_it():
    assert punctuation.from_speech("really? period") == "Really?."
    assert punctuation.from_speech("really? question mark") == "Really?"
    assert punctuation.from_speech("really! question mark") == "Really!?"
    assert punctuation.from_speech("really! exclamation mark") == "Really!"


def test_the_words_that_make_a_mark_word_ordinary_are_kept_in_constants():
    assert punctuation.AMBIGUOUS == {"period", "colon", "dash", "quote", "slash", "comma"}
    listed = (
        "a an the this that these those one each every same any another my your his her its our "
        "their no some per time grace trial waiting cooling probationary school class exam billing "
        "reporting reading long short whole entire ice dark middle early late first last next "
        "previous final key"
    )
    assert punctuation.BEFORE_ORDINARY == frozenset(listed.split(" "))
    for word in listed.split(" "):
        text = f"we had {word} period today"  # (no "of" after it: only the word before decides)
        assert punctuation.from_speech(text) == "We had " + text[7:]


def test_a_mark_word_that_ends_the_text_is_always_a_mark_even_after_a_grace_word():
    assert punctuation.from_speech("extend the grace period") == "Extend the grace."
    assert punctuation.from_speech("a long period.  ") == "A long."  # (the recogniser's stop goes)
    # ... and one right before another mark word too (the full stop starts a sentence)
    assert punctuation.from_speech("a grace period comma and more") == "A grace., And more"


# ── how long it takes ──


def took(function, *args) -> float:
    start = time.perf_counter()
    function(*args)
    return time.perf_counter() - start


def test_a_long_text_takes_a_fraction_of_a_second():
    chunk = (
        "Dear Ann comma thanks for the notes period new paragraph see the U.S. (p. 3.5) at 3:30 "
    )
    text = (chunk * (200_000 // len(chunk) + 1))[:200_000]
    assert len(text) == 200_000
    assert took(punctuation.from_speech, text) < 1.0
    assert took(punctuation.to_speech, text, "some") < 1.0
    assert took(punctuation.to_speech, text, "all") < 1.0
    assert took(punctuation.describe, text) < 1.0
    assert took(punctuation.from_speech, "你好逗号世界句号" * 25_000, "zh") < 1.0
    assert took(punctuation.to_speech, "你好，世界。" * 33_000, "all", "zh") < 1.0


@pytest.mark.parametrize(
    "text",
    [
        " " * 200_000 + "a",
        "." * 200_000,
        "a." * 100_000,
        "." + ")" * 200_000,
        "?" * 200_000,
        "period " * 30_000,
        "a" * 200_000,
        "period" + ",." * 100_000,
        "a\n" * 100_000,
        "A. " * 60_000,
        "…" * 100_000,
        "'" * 100_000,
        "Dr.U.S.A.e.g.i.e." * 12_000,
    ],
    ids=lambda text: ascii(text[:12]),
)
def test_awkward_long_texts_are_no_slower(text):
    for function, args in (
        (punctuation.from_speech, ()),
        (punctuation.to_speech, ("some",)),
        (punctuation.to_speech, ("all",)),
        (punctuation.describe, ()),
    ):
        assert took(function, text, *args) < 1.0
