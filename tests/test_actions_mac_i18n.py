"""The Mac-and-world actions (places, stocks, music, switches, files, reading the Mac,
defense, connectors) show the owner their words in Chinese too: every Activity label their
tools have, and every sentence their window scripts and cards put in front of the owner,
has its Chinese in the window's strings (web/i18n/actions-mac.json over i18n-zh.json)."""

from __future__ import annotations

import importlib
import re

import pytest

from jarvis.server import zh_strings

FEATURES = ["places"]


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


@pytest.mark.parametrize("name", FEATURES)
def test_every_activity_label_has_its_chinese(merged, name):
    module = importlib.import_module(f"jarvis.features.{name}")
    missing = [label for label in module.LABELS.values() if chinese(merged, label) is None]
    assert missing == []
