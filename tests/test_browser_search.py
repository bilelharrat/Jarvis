"""Words opened as a search go to the engine the owner picked (features/browser_search.py)."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import FakeClient

from jarvis import browser_gate
from jarvis.features import browser_search
from jarvis.hub import Hub


@pytest.fixture
def hub(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setattr(browser_gate, "SEARCH_HOST", "www.google.com")  # put back after the test
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


async def test_words_go_to_the_engine_picked_and_only_a_known_one(hub):
    assert "browser_search" in hub.features
    assert browser_gate.address_host("best ramen near me") == "www.google.com"
    await hub._handle({"type": "browser_engine", "engine": "duckduckgo"})
    assert browser_gate.address_host("best ramen near me") == "duckduckgo.com"
    assert browser_gate.address_host("example.com/menu") == "example.com", (
        "an address is still an address"
    )
    for bad in ("altavista", "", None, "__class__"):
        await hub._handle({"type": "browser_engine", "engine": bad})
        assert browser_gate.SEARCH_HOST == "duckduckgo.com", bad
    await hub._handle({"type": "browser_engine", "engine": "kagi"})
    assert browser_gate.address_host("weather") == "kagi.com"


def test_the_engines_match_the_address_bar_s():
    engines = (Path(__file__).parent.parent / "app" / "url-input.js").read_text()
    for engine, host in browser_search.HOSTS.items():
        assert f"{engine}: {{ name:" in engines and f"https://{host}/" in engines, engine
