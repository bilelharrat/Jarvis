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

FEATURES = ["places", "stocks", "mac_music"]
SCRIPTS = ["stocks.js"]
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
    texts = getattr(_module(name), "TEXTS", {})
    for english, zh in texts.items():
        sample = re.sub(r"\{\w+\}", "2", english)
        assert lang.translate(sample, "zh") != sample, english  # spoken (lang.add_texts)
        assert lang.has_cjk(zh)
        assert chinese(merged, sample) is not None, english  # shown on the card


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
    ours = {"stocks.js"}
    present = {p.name for p in Path(WEB_DIR / "features").glob("*.js")} & ours
    assert present == set(SCRIPTS)
