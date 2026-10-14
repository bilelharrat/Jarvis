"""Eden Code's models in step with Eden chat's (askeden.com): every model Eden chat offers
that a Claude Code session can run is in Eden Code's catalog, by the same id and name, and
runs the way it would (Claude on the sign-in, GPT-6 and Kimi through the OpenAI-compatible
relay, Gemini through the Gemini relay). The prices are the router bundle's, checked against
Eden chat's in tests/web/model-catalog.test.mjs. The list Eden chat offers is pinned in
tests/fixtures/eden_chat_models.json (from site/src/eden/chat.js and its router bundle)."""

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from jarvis import gemini_proxy, openai_relay, providers
from jarvis.connectors import MemoryVault
from jarvis.prefs import MODEL_NAMES, MODELS
from jarvis.providers import CATALOG, KINDS, ProviderStore

EDEN_CHAT = json.loads((Path(__file__).parent / "fixtures" / "eden_chat_models.json").read_text())
CHAT_MODELS = EDEN_CHAT["models"]
GOOGLE_KEY = "AIza" + "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"  # made up, in Google's shape
OPENAI_KEY = "sk-proj-" + "a1B2c3D4e5F6" * 4
MOONSHOT_KEY = "sk-" + "m00nsh0tK1m1" * 4
# How Eden Code runs each of Eden chat's providers: (kind, host; "" for the kind's own).
HOW = {
    "openai": ("openai", "api.openai.com"),
    "kimi": ("openai", "api.moonshot.ai"),
    "gemini": ("gemini", ""),
}


def store_at(tmp_path):
    return ProviderStore(tmp_path / "providers.json", MemoryVault())


@pytest.mark.parametrize("chat", CHAT_MODELS, ids=lambda m: m["id"])
def test_every_eden_chat_model_is_in_eden_codes_catalog_by_the_same_id_and_name(chat):
    if chat["provider"] == "anthropic":
        # Claude: a built-in model (the sign-in, or an Anthropic key), shown under "Claude",
        # so its name in the menu is the router's without the word Claude.
        ref = next((r for r, model in MODELS.items() if model == chat["id"]), None)
        assert ref, f"{chat['id']} isn't one of Eden Code's Claude models"
        assert "Claude " + MODEL_NAMES[ref] == chat["name"]
        return
    assert chat["id"] in CATALOG, f"{chat['id']} ({chat['name']}) is missing from providers.CATALOG"
    label, kind, host = CATALOG[chat["id"]]
    assert label == chat["name"]
    assert (kind, host) == HOW[chat["provider"]]


def test_the_catalog_has_nothing_eden_chat_doesnt_offer_and_leaves_out_what_it_retired():
    offered = {m["id"] for m in CHAT_MODELS}
    assert set(CATALOG) <= offered
    for retired in EDEN_CHAT["retired"]:
        assert retired not in CATALOG and retired not in MODELS.values()


def test_a_gemini_key_suggests_every_gemini_model_eden_chat_offers():
    gemini = {m["id"] for m in CHAT_MODELS if m["provider"] == "gemini"}
    assert gemini <= set(KINDS["gemini"].suggested)


@pytest.mark.parametrize(
    ("url", "provider"),
    [("https://api.openai.com", "openai"), ("https://api.moonshot.ai/v1", "kimi")],
)
def test_an_openai_compatible_provider_at_openais_or_moonshots_address_suggests_eden_chats_models(
    tmp_path, url, provider
):
    store = store_at(tmp_path)
    key = OPENAI_KEY if provider == "openai" else MOONSHOT_KEY
    pid = store.add_provider("openai", "", key, url)["id"]
    shown = next(p for p in store.public()["providers"] if p["id"] == pid)
    want = [m["id"] for m in CHAT_MODELS if m["provider"] == provider]
    assert shown["suggested"] == want
    # Ollama on this Mac keeps its own suggestions.
    local = store.add_provider("openai", "", "local", "http://localhost:11434")["id"]
    shown = next(p for p in store.public()["providers"] if p["id"] == local)
    assert shown["suggested"] == list(KINDS["openai"].suggested)


@pytest.mark.parametrize(
    "chat", [m for m in CHAT_MODELS if m["provider"] != "anthropic"], ids=lambda m: m["id"]
)
def test_an_added_model_gets_eden_chats_name_and_runs_through_its_relay(
    tmp_path, monkeypatch, chat
):
    monkeypatch.setattr(gemini_proxy.PROXY, "port", 45679)
    monkeypatch.setattr(openai_relay.PROXY, "port", 45678)
    store = store_at(tmp_path)
    kind, host = HOW[chat["provider"]]
    if kind == "gemini":
        pid = store.add_provider("gemini", "", GOOGLE_KEY)["id"]
    else:
        key = OPENAI_KEY if chat["provider"] == "openai" else MOONSHOT_KEY
        pid = store.add_provider("openai", "", key, f"https://{host}")["id"]
    added = store.add_model(pid, chat["id"])
    assert added["label"] == chat["name"] and added["model"] == chat["id"]
    config = store.session_config(added["ref"], {})
    assert config["model"] == chat["id"] and config["claude"] is False
    env = json.loads(config["settings"])["env"]
    assert env["ANTHROPIC_MODEL"] == chat["id"]
    relay = urlsplit(env["ANTHROPIC_BASE_URL"])
    assert relay.hostname == "127.0.0.1"
    assert relay.port == (45679 if kind == "gemini" else 45678)


def test_the_owners_own_label_wins_and_a_taken_name_falls_back_to_the_id(tmp_path):
    store = store_at(tmp_path)
    pid = store.add_provider("gemini", "", GOOGLE_KEY)["id"]
    assert store.add_model(pid, "gemini-3.8-flash", "Fast one")["label"] == "Fast one"
    other = store.add_model(pid, "gemini-3.7-flash", "Gemini 3.5 Flash-Lite")
    assert other["label"] == "Gemini 3.5 Flash-Lite"
    # The catalog's name is taken by another model on the list: shown by its id instead.
    assert store.add_model(pid, "gemini-3.5-flash-lite")["label"] == "gemini-3.5-flash-lite"


def test_another_providers_same_id_gets_no_catalog_name(tmp_path):
    """OpenRouter's or a custom endpoint's "gpt-6-sol" is whatever that provider means by it."""
    store = store_at(tmp_path)
    pid = store.add_provider("openrouter", "", "sk-or-v1-" + "0123456789abcdef" * 4)["id"]
    assert store.add_model(pid, "gpt-6-sol")["label"] == "gpt-6-sol"
    assert providers.catalog_label("gpt-6-sol", "openrouter") == ""
    assert providers.catalog_label("gemini-3.8-flash", "openai") == ""
