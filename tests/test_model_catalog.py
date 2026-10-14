"""Eden Code's models in step with Eden chat's (askeden.com): Eden Code's model pickers offer
exactly the models Eden chat offers, in its order, by its names, under its headings (Fable,
which Eden chat doesn't offer, and the models askeden.com retired, left out; Gemini 4 Argon
as providers.ARGON_ON says), each running the way it would (Claude on the sign-in, GPT-6.1
and Kimi through the OpenAI-compatible relay, Gemini through the Gemini relay) on the owner's
own key; one with no key for it yet stays listed, saying what it needs. The prices are the
router bundle's, checked against Eden chat's in tests/web/model-catalog.test.mjs. The list
Eden chat offers is pinned in tests/fixtures/eden_chat_models.json (from site/wrangler.toml's
EDEN_MODELS, site/src/eden/chat.js and its router bundle)."""

import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from code_session_fakes import make_hub

from jarvis import gemini_proxy, openai_relay, providers
from jarvis.connectors import MemoryVault
from jarvis.features import code_models
from jarvis.prefs import MODELS
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
def test_every_eden_chat_model_is_in_eden_codes_list_by_the_same_id_and_name(chat):
    if chat["provider"] == "anthropic":
        # Claude: a built-in model (the sign-in, or an Anthropic key).
        assert chat["id"] in MODELS.values(), f"{chat['id']} isn't one of Eden Code's Claude models"
    else:
        assert chat["id"] in CATALOG, (
            f"{chat['id']} ({chat['name']}) is missing from providers.CATALOG"
        )
        label, kind, host = CATALOG[chat["id"]]
        assert label == chat["name"]
        assert (kind, host) == HOW[chat["provider"]]
    listed = {m: (name, group) for m, name, group in providers.EDEN_CHAT_MODELS}
    assert listed[chat["id"]] == (chat["name"], chat["provider"])


def test_the_catalog_has_nothing_eden_chat_doesnt_offer_and_leaves_out_what_it_retired():
    offered = {m["id"] for m in CHAT_MODELS}
    assert set(CATALOG) <= offered
    assert [m for m, _, _ in providers.EDEN_CHAT_MODELS] == [m["id"] for m in CHAT_MODELS]
    assert providers.EDEN_CHAT_GROUPS == EDEN_CHAT["groups"]
    for gone in (*EDEN_CHAT["retired"], *EDEN_CHAT["not_offered"]):
        assert gone not in CATALOG
        assert gone not in {m for m, _, _ in providers.EDEN_CHAT_MODELS}


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


def test_the_owners_own_label_wins_and_a_taken_name_falls_back_to_the_id(tmp_path):
    store = store_at(tmp_path)
    pid = store.add_provider("gemini", "", GOOGLE_KEY)["id"]
    for entry in list(store.models_of(pid)):  # (the key came with Eden chat's Gemini models)
        store.remove_model(entry.id)
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


# ── the pickers: Eden chat's list, nothing else ──


def listed(store):
    return [(m["model"], m["label"], m["group"]) for m in store.picker() if m["eden"]]


def offered():
    return [
        (m["id"], m["name"], EDEN_CHAT["groups"][m["provider"]])
        for m in CHAT_MODELS
        if not m.get("off")
    ]


def test_the_picker_is_eden_chats_list_in_its_order_by_its_names_with_no_key_added(tmp_path):
    store = store_at(tmp_path)
    assert listed(store) == offered()
    shown = store.picker()
    assert [m["ref"] for m in shown if m["builtin"]] == ["opus", "sonnet"]
    # Fable 5.1 (not Eden chat's) and the retired Haiku 4.5, GPT-6 Sol… aren't offered.
    models = {m["model"] for m in shown}
    assert MODELS["fable"] not in models and MODELS["haiku"] not in models
    assert not models & set(EDEN_CHAT["retired"])
    # The window gets it beside every model a session can be on (Haiku, Fable: old sessions).
    public = store.public()
    assert public["picker"] == shown
    assert {MODELS["haiku"], MODELS["fable"]} <= {m["model"] for m in public["models"]}


def test_argon_follows_the_flag(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    assert providers.ARGON_ON is not any(
        m.get("off") for m in CHAT_MODELS if m["id"] == providers.ARGON
    )
    assert (providers.ARGON in [m[0] for m in listed(store)]) is providers.ARGON_ON
    monkeypatch.setattr(providers, "ARGON_ON", False)
    assert providers.ARGON not in [m[0] for m in listed(store)]
    pid = store.add_provider("gemini", "", GOOGLE_KEY)["id"]
    assert providers.ARGON not in [e.model for e in store.models_of(pid)]  # nor added
    monkeypatch.setattr(providers, "ARGON_ON", True)  # Eden chat turns it back on: so does this
    assert providers.ARGON in [m[0] for m in listed(store)]
    assert providers.ARGON in [e.model for e in store.models_of(pid)] or store.sync_eden_chat()


def test_a_model_with_no_key_yet_says_what_it_needs_and_runs_nothing(tmp_path):
    store = store_at(tmp_path)
    keyless = [m for m in store.picker() if m.get("needs_key")]
    assert [m["model"] for m in keyless] == [
        m["id"] for m in CHAT_MODELS if m["provider"] != "anthropic"
    ]
    gpt = next(m for m in keyless if m["model"] == "gpt-6.1-sol")
    assert gpt["ref"] == "eden:gpt-6.1-sol" and gpt["key_kind"] == "openai"
    assert gpt["key_url"] == "https://api.openai.com" and gpt["key_group"] == "openai"
    assert "an OpenAI API key" in gpt["reason"] and gpt["from_eden_chat"] is False
    kimi = next(m for m in keyless if m["model"] == "kimi-k3")
    assert (kimi["key_kind"], kimi["key_url"]) == ("openai", "https://api.moonshot.ai/v1")
    assert not store.known("eden:gpt-6.1-sol")
    with pytest.raises(ValueError, match="needs an OpenAI API key"):
        store.session_config("eden:gpt-6.1-sol", {})
    # Eden chat on this Mac has that key (code_models found it): the picker offers it.
    store.chat_keys = {"openai": True}
    assert next(m for m in store.picker() if m["model"] == "gpt-6.1-sol")["from_eden_chat"]


@pytest.mark.parametrize(
    ("kind", "url", "key", "models"),
    [
        ("gemini", None, GOOGLE_KEY, ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite"]),
        ("openai", "https://api.openai.com", OPENAI_KEY, ["gpt-6.1-sol"]),
        ("openai", "https://api.moonshot.ai/v1", MOONSHOT_KEY, ["kimi-k3"]),
        ("custom", "https://api.moonshot.ai/anthropic", MOONSHOT_KEY, ["kimi-k3"]),
    ],
)  # fmt: skip
def test_a_key_added_brings_eden_chats_models_on_it_by_their_names(
    tmp_path, kind, url, key, models
):
    store = store_at(tmp_path)
    pid = store.add_provider(kind, "", key, url)["id"]
    on = {e.model: e.label for e in store.models_of(pid)}
    names = {m["id"]: m["name"] for m in CHAT_MODELS}
    assert {m: on.get(m) for m in models} == {m: names[m] for m in models}
    shown = {m["model"]: m for m in store.picker() if m["eden"]}
    for model in models:
        assert shown[model]["ref"].startswith("custom:") and not shown[model].get("needs_key")
        assert store.resolve("eden:" + model) == shown[model]["ref"]  # picked keyless: runs now
    # Ollama on this Mac, or OpenRouter, isn't OpenAI or Moonshot: nothing of Eden chat's on it.
    other = store.add_provider("openai", "", "local", "http://localhost:11434")["id"]
    assert store.models_of(other) == []


def test_keys_already_in_eden_codes_store_get_eden_chats_models_once(tmp_path):
    """The owner's store as it was (a Gemini key with two models, a Moonshot key as a Custom
    endpoint with Kimi K3): the next start puts Eden chat's missing models on them, once; one
    the owner then removes stays removed."""
    path = tmp_path / "providers.json"
    store = ProviderStore(path, vault := MemoryVault())
    gemini = store.add_provider("gemini", "", GOOGLE_KEY)["id"]
    for e in list(store.models_of(gemini)):
        store.remove_model(e.id)
    store.add_model(gemini, "gemini-3.8-flash")
    data = json.loads(path.read_text())
    data.pop("eden_chat")  # a file from before this list
    path.write_text(json.dumps(data))
    again = ProviderStore(path, vault)
    assert sorted(e.model for e in again.models_of(gemini)) == sorted(
        ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.5-flash-lite"]
    )
    assert json.loads(path.read_text())["eden_chat"] == providers.eden_chat_stamp()
    again.remove_model(next(e.id for e in again.models_of(gemini) if e.model == providers.ARGON))
    third = ProviderStore(path, vault)
    assert providers.ARGON not in [e.model for e in third.models_of(gemini)]
    argon = next(m for m in third.picker() if m["model"] == providers.ARGON)
    assert argon["needs_key"]  # still listed: the list matches Eden chat's


@pytest.mark.parametrize(
    "chat", [m for m in CHAT_MODELS if m["provider"] != "anthropic"], ids=lambda m: m["id"]
)
def test_each_listed_model_runs_through_its_relay_with_no_key_in_the_session(
    tmp_path, monkeypatch, chat
):
    monkeypatch.setattr(gemini_proxy.PROXY, "port", 45679)
    monkeypatch.setattr(openai_relay.PROXY, "port", 45678)
    store = store_at(tmp_path)
    kind, host = HOW[chat["provider"]]
    key = {"gemini": GOOGLE_KEY, "openai": OPENAI_KEY, "kimi": MOONSHOT_KEY}[chat["provider"]]
    store.add_provider(kind, "", key, f"https://{host}" if host else None)
    entry = next(m for m in store.picker() if m["model"] == chat["id"])
    config = store.session_config(entry["ref"], {})
    assert config["model"] == chat["id"] and config["claude"] is False
    settings = json.loads(config["settings"])
    relay = urlsplit(settings["env"]["ANTHROPIC_BASE_URL"])
    assert relay.hostname == "127.0.0.1"
    assert relay.port == (45679 if kind == "gemini" else 45678)
    # The key is in none of it: the session gets a pass, which the relay swaps for it.
    assert key not in json.dumps(config)
    assert all(v == "" for v in config["env"].values())


async def test_picking_a_keyless_model_in_a_session_says_what_it_needs(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setattr(openai_relay.PROXY, "port", 45678)
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    cfg = hub._model_config("eden:gpt-6.1-sol")
    assert cfg["ref"] == "" and cfg["model"] is None  # the default, as for a model that's gone
    assert any(k == "error" and "OpenAI API key" in d["text"] for k, d in seen)
    hub.providers.add_provider("openai", "", OPENAI_KEY, "https://api.openai.com")
    cfg = hub._model_config("eden:gpt-6.1-sol")
    assert cfg["model"] == "gpt-6.1-sol" and cfg["ref"].startswith("custom:")


class FakeChatKeys(code_models.EdenChatKeys):
    def __init__(self, keys):
        self.keys = keys
        self.read_vars = []

    def has(self, var):
        return var in self.keys

    def read(self, var):
        self.read_vars.append(var)
        return self.keys.get(var, "")


async def test_eden_chats_own_key_on_this_mac_is_offered_then_used_in_one_click(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)

    async def no_relay():
        return None

    monkeypatch.setattr(hub, "_relay_if_needed", no_relay)
    fake = FakeChatKeys({"OPENAI_API_KEY": OPENAI_KEY})
    hub.code_models.keys = fake
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub.code_models.on_keys({})
    assert fake.read_vars == []  # looked up, never read, until the owner says so
    picker = next(d for k, d in seen if k == "providers")["picker"]
    gpt = next(m for m in picker if m["model"] == "gpt-6.1-sol")
    assert gpt["needs_key"] and gpt["from_eden_chat"]
    assert not next(m for m in picker if m["model"] == "kimi-k3")["from_eden_chat"]
    assert OPENAI_KEY not in json.dumps(seen)
    seen.clear()
    await hub.code_models.on_use({"group": "openai"})
    assert fake.read_vars == ["OPENAI_API_KEY"]
    provider = next(p for p in hub.providers.providers.values() if p.kind == "openai")
    assert provider.base_url == "https://api.openai.com"
    gpt = next(m for m in hub.providers.picker() if m["model"] == "gpt-6.1-sol")
    assert gpt["ref"].startswith("custom:") and not gpt.get("needs_key")
    assert OPENAI_KEY not in json.dumps(seen)  # the window never sees it
    # No key there after all: said, and nothing added.
    seen.clear()
    await hub.code_models.on_use({"group": "kimi"})
    assert any(k == "providers_error" and "Moonshot" in d["text"] for k, d in seen)
    assert not any(
        p.base_url.startswith("https://api.moonshot.ai") for p in hub.providers.providers.values()
    )


def test_the_real_lookup_never_touches_the_keychain_in_tests(monkeypatch):
    ran = []
    monkeypatch.setattr(code_models.subprocess, "run", lambda *a, **k: ran.append(a))
    keys = code_models.EdenChatKeys()
    assert keys.has("OPENAI_API_KEY") is False and keys.read("OPENAI_API_KEY") == ""
    assert ran == []
