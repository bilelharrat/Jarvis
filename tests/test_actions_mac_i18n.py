"""The Mac-and-world actions (places, stocks, music, switches, files, reading the Mac,
defense, connectors) show the owner their words in Chinese too: every Activity label their
tools have, every card they put up (its Chinese spoken through lang, and shown through the
window's strings), and every sentence their window scripts show, has its Chinese in the
window's strings (web/i18n/actions-mac.json over i18n-zh.json)."""

from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest

from jarvis import lang
from jarvis.server import WEB_DIR, zh_strings

FEATURES = [
    "places",
    "stocks",
    "mac_music",
    "mac_switches",
    "mac_files",
    "mac_reading",
    "mac_defense",
]
SCRIPTS = ["stocks.js", "mac-actions.js"]
# What a {slot} or ${…} stands for when a sentence is tried against the window's patterns.
SAMPLE = "2"
# Literals in the scripts that aren't the window's words: event and command names, CSS, ids.
NOT_SHOWN = re.compile(r"^(?:[a-z_\-.#:\[\]=\"' ]+|[A-Z][a-z]+[A-Z]\w*)$")


def chinese(merged: dict, text: str) -> str | None:
    if text in merged["strings"]:
        return merged["strings"][text]
    for pattern, replacement in merged["patterns"]:
        if re.search(pattern, text):
            return re.sub(pattern, replacement, text)
    return None


@pytest.fixture(scope="module")
def merged():
    return zh_strings()


def _module(name: str):
    return importlib.import_module(f"jarvis.features.{name}")


@pytest.mark.parametrize("name", FEATURES)
def test_every_activity_label_has_its_chinese(merged, name):
    missing = [label for label in _module(name).LABELS.values() if chinese(merged, label) is None]
    assert missing == []


@pytest.mark.parametrize("name", FEATURES)
def test_every_card_is_spoken_and_shown_in_chinese(merged, name):
    module = _module(name)
    for english, zh in getattr(module, "TEXTS", {}).items():
        sample = re.sub(r"\{\w+\}", "2", english)
        assert lang.translate(sample, "zh") != sample, english  # spoken (lang.add_texts)
        assert lang.has_cjk(zh)
        assert chinese(merged, sample) is not None, english  # the card's question, shown
    for english in getattr(module, "DETAIL_TEXTS", {}):
        sample = re.sub(r"\{\w+\}", "2", english)
        assert lang.has_cjk(lang.translate(sample, "zh")), english  # mac_gate translates it


def _shown(merged: dict, text: str) -> str | None:
    """What the window shows for text: its string, or the first pattern that matches it
    with its $1… filled in (as the window's translator does)."""
    if text in merged["strings"]:
        return merged["strings"][text]
    for pattern, replacement in merged["patterns"]:
        if re.search(pattern, text):
            return re.sub(pattern, re.sub(r"\$(\d)", r"\\\1", replacement), text)
    return None


@pytest.mark.parametrize("name", FEATURES)
def test_a_card_shows_what_is_said(merged, name):
    """The window's Chinese for a card's question is the one spoken (no other feature's
    pattern gets to it first), spaces aside; and its buttons have their Chinese."""
    module = _module(name)
    for english, zh in getattr(module, "TEXTS", {}).items():
        shown = _shown(merged, re.sub(r"\{\w+\}", "2", english))
        said = re.sub(r"\{\w+\}", "2", zh)
        assert shown is not None and "".join(shown.split()) == "".join(said.split()), english
    for choices in (v for k, v in vars(module).items() if k.endswith("_CHOICES")):
        assert all(chinese(merged, label) is not None for label in choices), choices


def _literals(source: str) -> set[str]:
    """The strings a window script shows: quoted literals that read as words."""
    found: set[str] = set()
    for quote, body in re.findall(r"(['`])((?:\\.|(?!\1).)*)\1", source):
        text = re.sub(r"\$\{[^}]*\}", SAMPLE, body) if quote == "`" else body
        text = text.replace("\\'", "'")
        worded = re.match(r"^[A-Z0-9]", text) and re.search(
            r"(?:^|\s)[a-z]{2,}\b|^[A-Z][a-z]+$", text
        )
        if not worded or NOT_SHOWN.match(text):
            continue
        found.add(text)
    return found


@pytest.mark.parametrize("script", SCRIPTS)
def test_every_window_sentence_has_its_chinese(merged, script):
    source = (WEB_DIR / "features" / script).read_text()
    missing = sorted(t for t in _literals(source) if chinese(merged, t) is None)
    assert missing == []


def test_the_scripts_are_the_ones_listed():
    ours = {"stocks.js", "mac-actions.js"}
    present = {p.name for p in Path(WEB_DIR / "features").glob("*.js")} & ours
    assert present == set(SCRIPTS)
