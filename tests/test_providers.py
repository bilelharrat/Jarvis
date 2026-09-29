"""Models & API keys: providers with Keychain-only keys, session config, checks, tools."""

import asyncio
import json
import os
import random
import re
import shlex
import string
import subprocess
import sys
import time
import types
from pathlib import Path

import httpx
import pytest

from jarvis import providers
from jarvis.connectors import SERVICE, MemoryVault, Vault
from jarvis.prefs import MODEL_NAMES, MODELS
from jarvis.providers import (
    CREDENTIAL_ENV,
    CUSTOM,
    DESTINATION_ENV,
    HELPER_CODE,
    KEY_ADVICE,
    MAX_MODELS,
    MAX_PROVIDERS,
    NAME_LIMIT,
    NETWORK_ENV,
    PROMPT,
    ROUTING_ENV,
    TIER_ENV,
    ProviderStore,
    build_server,
    build_tools,
    clean_base_url,
    clean_model_id,
    clean_name,
    keychain_helper,
    looks_like_key,
    mask,
)

OR_KEY = "sk-or-v1-" + "0123456789abcdef" * 4
ANT_KEY = "sk-ant-api03-" + "Zx9_Yw8-Vu7" * 8 + "AA"
LITE_KEY = "sk-lite-7f3a9c2e4b1d"
LONG_HOST = "https://llm-gateway.research-cluster.corp.example.com"


def make_store(tmp_path, vault=None, **options):
    return ProviderStore(
        tmp_path / "providers.json", vault if vault is not None else MemoryVault(), **options
    )


def saved(vault, pid):
    """A provider's Keychain entry: the key sealed with where it may go."""
    return json.loads(vault.get(f"provider:{pid}", "api_key"))


def edit_file(path, change):
    data = json.loads(path.read_text())
    change(data)
    path.write_text(json.dumps(data))


def block_saving(store, tmp_path):
    """Point the store at a path it can't write (its folder is a file)."""
    blocker = tmp_path / "blocker"
    blocker.write_text("")
    store.path = blocker / "providers.json"


def settings_of(config):
    return json.loads(config["settings"])


def router_client(routes, seen, **options):
    """A client whose requests go to routes ({url prefix: handler(request)}), never out."""

    def handler(request):
        seen.append(request)
        for prefix, reply in routes.items():
            if str(request.url).startswith(prefix):
                return reply(request)
        return httpx.Response(599)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), **options)


def answer(status=200, **kwargs):
    def reply(_request):
        return httpx.Response(status, **kwargs)

    return reply


class BrokenVault(MemoryVault):
    """A Keychain that won't take anything (locked, or access denied)."""

    def set(self, conn_id, key, value):
        raise RuntimeError("keychain locked")


class StuckVault(MemoryVault):
    """A Keychain that won't let go of anything."""

    def delete(self, conn_id, key):
        raise RuntimeError("keychain locked")


class LockedVault(MemoryVault):
    """A Keychain that won't be read."""

    def get(self, conn_id, key):
        raise RuntimeError("keychain locked")


# ── the list ──


def test_builtin_models_come_first_with_the_prefs_keys_as_refs(tmp_path):
    store = make_store(tmp_path)
    models = store.models()
    assert [m["ref"] for m in models] == list(MODELS)
    assert [m["model"] for m in models] == list(MODELS.values())
    assert [m["label"] for m in models] == [MODEL_NAMES[k] for k in MODELS]
    assert all(m["builtin"] and m["provider"] == "" for m in models)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    added = store.add_model(pid, "openai/gpt-5", "GPT-5")
    models = store.models()
    assert models[: len(MODELS)] == store.models()[: len(MODELS)]
    assert models[-1] == added
    assert added["ref"].startswith(CUSTOM) and added["builtin"] is False


def test_a_provider_key_lives_only_in_the_keychain(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    added = store.add_provider("openrouter", "", f"  Bearer {OR_KEY}\n")
    pid = added["id"]
    assert saved(vault, pid) == {
        "v": 1,
        "key": OR_KEY,
        "kind": "openrouter",
        "base_url": "https://openrouter.ai/api",
        "auth": "bearer",
    }
    assert added["key_hint"] == "sk-…cdef"
    assert (added["name"], added["base_url"], added["auth"]) == (
        "OpenRouter",
        "https://openrouter.ai/api",
        "bearer",
    )
    assert OR_KEY not in store.path.read_text()
    assert OR_KEY not in json.dumps(store.public())
    assert OR_KEY not in repr(store.providers) and OR_KEY not in repr(store.entries)


def test_the_list_survives_a_restart_with_the_same_refs(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "My router", OR_KEY)["id"]
    gpt = store.add_model(pid, "openai/gpt-5", "GPT-5")
    store.add_model(pid, "~anthropic/claude-opus-latest[1m]")
    again = make_store(tmp_path, vault)
    assert again.models() == store.models()
    assert again.session_config(gpt["ref"], {})["model"] == "openai/gpt-5"
    assert again.public()["providers"][0]["key_hint"] == "sk-…cdef"


@pytest.mark.parametrize(
    ("key", "shown"),
    [
        ("sk-or-v1-" + "a" * 60 + "WXYZ", "sk-…WXYZ"),
        ("litellm-master-key-9876", "…9876"),
        ("sk-short", "sk-••••"),
        ("tiny", "••••"),
    ],
)
def test_a_key_shows_as_a_public_prefix_and_its_last_four_at_most(key, shown):
    assert mask(key) == shown


@pytest.mark.parametrize(
    ("kind", "key", "base_url", "auth", "message"),
    [
        ("openai", OR_KEY, None, None, "Choose Anthropic API, OpenRouter or Custom"),
        ("openrouter", "   ", None, None, "Paste the API key first"),
        ("openrouter", "sk-or-v1 abc def", None, None, "spaces or unusual characters"),
        ("openrouter", "sk-or-v1-\x00abc", None, None, "spaces or unusual characters"),
        ("openrouter", "x" * 5000, None, None, "far too long"),
        ("custom", LITE_KEY, None, None, "Give the endpoint's address"),
        ("custom", LITE_KEY, "http://llm.example.com", None, "Use https"),
        ("custom", LITE_KEY, "https://llm.example.com", "cookie", "bearer token or as an x-api"),
    ],
)
def test_add_provider_refuses_bad_input(tmp_path, kind, key, base_url, auth, message):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    with pytest.raises(ValueError, match=message):
        store.add_provider(kind, "", key, base_url, auth=auth)
    assert store.providers == {} and vault.data == {} and not store.path.exists()


def test_names_are_unique_and_default_names_count_up(tmp_path):
    store = make_store(tmp_path)
    first = store.add_provider("openrouter", "", OR_KEY)
    second = store.add_provider("openrouter", "", OR_KEY)
    assert (first["name"], second["name"]) == ("OpenRouter", "OpenRouter 2")
    with pytest.raises(ValueError, match="already a provider called"):
        store.add_provider("openrouter", "openrouter 2", OR_KEY)
    local = store.add_provider("custom", "", LITE_KEY, "localhost:4000")
    assert (local["name"], local["base_url"]) == ("localhost:4000", "http://localhost:4000")
    named = store.add_provider("custom", "  My\tbox \n", LITE_KEY, "https://llm.example.com")
    assert named["name"] == "My box"


def test_providers_named_after_a_long_host_fit_and_survive_a_restart(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    a = store.add_provider("custom", "", LITE_KEY, f"{LONG_HOST}/team-a")
    b = store.add_provider("custom", "", LITE_KEY + "b", f"{LONG_HOST}/team-b")
    assert len(a["name"]) <= NAME_LIMIT and len(b["name"]) <= NAME_LIMIT
    assert a["name"].casefold() != b["name"].casefold() and b["name"].endswith(" 2")
    store.add_model(a["id"], "qwen3-coder")
    store.add_model(b["id"], "glm-4.6")
    again = make_store(tmp_path, vault)
    assert {p.id: p.name for p in again.providers.values()} == {
        a["id"]: a["name"],
        b["id"]: b["name"],
    }
    assert again.models() == store.models()
    assert saved(vault, b["id"])["key"] == LITE_KEY + "b"
    again.add_model(b["id"], "kimi-k2")  # a save after the restart loses nothing
    assert set(make_store(tmp_path, vault).providers) == {a["id"], b["id"]}


def test_a_host_that_looks_like_a_key_is_not_used_as_a_name(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    url = "https://a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.endpoints.example.cloud"
    added = store.add_provider("custom", "", LITE_KEY, url)
    assert added["name"] == "Custom endpoint" and added["base_url"] == url
    again = make_store(tmp_path, vault)
    assert [p.name for p in again.providers.values()] == ["Custom endpoint"]


def test_names_that_clash_or_hide_a_key_in_the_file_are_renamed_not_dropped(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    ids = [
        store.add_provider("custom", f"Box {n}", LITE_KEY, f"https://llm{n}.example.com")["id"]
        for n in range(4)
    ]
    long = "The team's shared gateway for the research cluster"
    names = ["Box", "box", f"Work {OR_KEY}", long]

    def rename(data):
        for provider, name in zip(data["providers"], names, strict=True):
            provider["name"] = name

    edit_file(store.path, rename)
    again = make_store(tmp_path, vault)
    assert list(again.providers) == ids  # nothing dropped, nothing stranded in the Keychain
    shown = [p.name for p in again.providers.values()]
    assert shown == ["Box", "box 2", "Custom endpoint", long[:NAME_LIMIT].strip()]
    again.add_model(ids[0], "qwen3-coder")  # the next save writes the names as shown
    assert OR_KEY not in store.path.read_text()


@pytest.mark.parametrize(
    ("given", "kept"),
    [
        ("https://llm.example.com/", "https://llm.example.com"),
        ("https://llm.example.com/v1", "https://llm.example.com"),
        ("https://gw.example.com/anthropic/v1/messages", "https://gw.example.com/anthropic"),
        ("HTTPS://LLM.Example.COM:8443/V1/", "https://llm.example.com:8443"),
        ("llm.example.com", "https://llm.example.com"),
        ("localhost:4000", "http://localhost:4000"),
        ("http://127.0.0.1:4000/v1", "http://127.0.0.1:4000"),
        ("http://0.0.0.0:4000", "http://127.0.0.1:4000"),
        ("http://[::1]:8080", "http://[::1]:8080"),
        (
            "https://gateway.ai.cloudflare.com/v1/" + "a1b2c3d4" * 4 + "/jarvis/anthropic",
            "https://gateway.ai.cloudflare.com/v1/" + "a1b2c3d4" * 4 + "/jarvis/anthropic",
        ),
    ],
)
def test_base_urls_are_tidied_for_claude_code(given, kept):
    assert clean_base_url(given) == kept


@pytest.mark.parametrize(
    ("given", "message"),
    [
        ("", "Give the endpoint's address"),
        ("http://llm.example.com", "Use https"),
        ("http://localhost.evil.com", "Use https"),
        ("http://127.0.0.1.nip.io", "Use https"),
        ("http://192.168.1.20:4000", "Use https"),
        ("ftp://llm.example.com", "should start with https"),
        ("https://user:pass@llm.example.com", "Leave the user name and password out"),
        ("https://llm.example.com/?key=abc", "shouldn't have a"),
        ("https://llm.example.com/#frag", "shouldn't have a"),
        ("https://llm example.com", "spaces or odd characters"),
        ("https://llm.example.com\n.evil", "spaces or odd characters"),
        ("https://llm.example.com:99999", "doesn't look like a web address"),
        ("https://[not-ipv6", "doesn't look like a web address"),
        ("https://exa$mple.com", "doesn't look like a web address"),
        ("javascript:alert(1)", "doesn't look like a web address"),
        ("https://llm.example.com/a;b", "odd characters in its path"),
        ("https://llm.example.com/sk-ant-api03-abc", "looks like an API key"),
        ("https://" + "a" * 300 + ".com", "spaces or odd characters"),
    ],
)
def test_unsafe_or_broken_addresses_are_refused(given, message):
    with pytest.raises(ValueError, match=message):
        clean_base_url(given)


def test_a_key_pasted_under_the_wrong_provider_is_refused(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    with pytest.raises(ValueError, match="That's an OpenRouter key"):
        store.add_provider("anthropic", "", OR_KEY)
    with pytest.raises(ValueError, match="shouldn't go to OpenRouter"):
        store.add_provider("openrouter", "", ANT_KEY)
    assert vault.data == {}
    # A custom endpoint may be a gateway that passes either kind on.
    store.add_provider("custom", "", ANT_KEY, "https://gw.example.com", auth="x-api-key")


@pytest.mark.parametrize(
    "secret",
    [
        OR_KEY,
        ANT_KEY,
        "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
        "ghp_" + "a1B2" * 9,
        "8f14e45fceea167a5a36dedd4bea2543",
    ],
)
def test_a_key_in_the_wrong_field_is_never_saved(tmp_path, secret):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    with pytest.raises(ValueError, match="looks like an API key") as caught:
        store.add_model(pid, secret)
    assert secret not in str(caught.value)
    with pytest.raises(ValueError, match="looks like an API key"):
        store.add_model(pid, "openai/gpt-5", label=secret)
    with pytest.raises(ValueError, match="looks like an API key"):
        store.add_provider("custom", secret, LITE_KEY, "https://llm.example.com")
    assert secret not in store.path.read_text()


@pytest.mark.parametrize(
    "hidden",
    [
        " " + ANT_KEY,
        "\n" + OR_KEY,
        "Work " + ANT_KEY,
        "Bearer " + OR_KEY,
        "key=" + ANT_KEY,
        "(" + LITE_KEY + ")",
        "My box xai-" + "Ab3dE" * 4,
        "gsk_" + "q" * 20,
    ],
)
def test_a_key_after_a_space_or_a_word_is_still_caught(tmp_path, hidden):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    for bad in (
        lambda: clean_name(hidden),
        lambda: store.add_model(pid, "openai/gpt-5", label=hidden),
        lambda: store.add_provider("custom", hidden, LITE_KEY, "https://llm.example.com"),
    ):
        with pytest.raises(ValueError, match="looks like an API key"):
            bad()
    with pytest.raises(ValueError, match="looks like an API key"):
        clean_model_id("openai/" + ANT_KEY)
    text = store.path.read_text()
    assert ANT_KEY[:20] not in text and LITE_KEY not in text


def test_realistic_keys_are_caught_wherever_they_start():
    """Random keys in each vendor's format, after a word, a space or a slash: none gets
    through (before, about one Anthropic key in twenty did after a word)."""
    rng = random.Random(1234)
    alphabet = string.ascii_letters + string.digits + "-_"

    def key(prefix, size):
        return prefix + "".join(rng.choice(alphabet) for _ in range(size))

    for _ in range(300):
        for secret in (key("sk-ant-api03-", 93) + "AA", key("sk-proj-", 156), key("sk-or-v1-", 64)):
            for hidden in (" " + secret, "Work " + secret, "openai/" + secret, "\t" + secret):
                assert looks_like_key(hidden), hidden


@pytest.mark.parametrize(
    "model",
    [
        "openai/gpt-5",
        "google/gemini-2.5-pro",
        "x-ai/grok-4",
        "deepseek/deepseek-r1:free",
        "~anthropic/claude-opus-latest[1m]",
        "claude-sonnet-4-5[1m]",
        "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
        "hf.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF:Q4_K_M",
        "claude-3-5-sonnet-v2@20241022",
        "meta-llama/llama-3.3-70b-instruct",
        "mistralai/mistral-large-2411",
        "qwen/qwq-32b",
        "moonshotai/kimi-k2-0905",
        "z-ai/glm-4.6",
        "openai/gpt-5-codex",
        "cognitivecomputations/dolphin-mistral-24b-venice-edition",
        "tngtech/deepseek-r1t2-chimera",
    ],
)
def test_model_ids_providers_use_are_accepted(model):
    assert clean_model_id(f"  {model} ") == model


@pytest.mark.parametrize(
    "model",
    [
        "",
        "gpt 5",
        "gpt-5\nrm -rf /",
        "../../etc/passwd",
        "-rf",
        "model;ls",
        "openai/gpt-5[1m][2m]",
        "a" * 300,
        "x/" + "ab-" * 100,
    ],
)
def test_odd_model_ids_are_refused(model):
    with pytest.raises(ValueError):
        clean_model_id(model)


def test_model_list_rules(tmp_path):
    store = make_store(tmp_path)
    router = store.add_provider("openrouter", "", OR_KEY)["id"]
    local = store.add_provider("custom", "Local", LITE_KEY, "http://localhost:4000")["id"]
    first = store.add_model(router, "openai/gpt-5")
    assert first["label"] == "openai/gpt-5" and first["name"] == "openai/gpt-5 · OpenRouter"
    with pytest.raises(ValueError, match="already on OpenRouter's list"):
        store.add_model(router, "openai/gpt-5", "Again")
    store.add_model(local, "openai/gpt-5")  # the same model behind another provider is fine
    with pytest.raises(ValueError, match="Add the provider first"):
        store.add_model("nope", "openai/gpt-5")
    for n in range(MAX_MODELS - 1):
        store.add_model(router, f"vendor/model-{n}")
    with pytest.raises(ValueError, match=f"has {MAX_MODELS} models already"):
        store.add_model(router, "vendor/one-too-many")
    assert len(store.models_of(router)) == MAX_MODELS
    assert len(make_store(tmp_path).models_of(router)) == MAX_MODELS


def test_there_is_a_limit_to_providers(tmp_path):
    store = make_store(tmp_path)
    for n in range(MAX_PROVIDERS):
        store.add_provider("openrouter", f"Router {n}", OR_KEY)
    with pytest.raises(ValueError, match=f"{MAX_PROVIDERS} providers already"):
        store.add_provider("openrouter", "One more", OR_KEY)


def test_limits_hold_for_a_file_edited_by_hand(tmp_path):
    path = tmp_path / "providers.json"
    many = [{"id": f"{n:012x}", "kind": "openrouter", "name": f"R{n}"} for n in range(30)]
    models = [
        {"id": f"{n + 1000:012x}", "provider": f"{0:012x}", "model": f"vendor/m-{n}"}
        for n in range(60)
    ]
    path.write_text(json.dumps({"providers": many, "models": models}))
    store = ProviderStore(path, MemoryVault())
    assert len(store.providers) == MAX_PROVIDERS
    assert len(store.models_of(f"{0:012x}")) == MAX_MODELS


def test_removing_a_provider_takes_its_key_and_models(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    keep = store.add_provider("custom", "Local", LITE_KEY, "http://localhost:4000")["id"]
    gone = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(gone, "openai/gpt-5")["ref"]
    store.add_model(keep, "llama3.1:8b")
    assert store.remove_provider(gone) is True
    assert vault.get(f"provider:{gone}", "api_key") is None
    assert saved(vault, keep)["key"] == LITE_KEY
    assert not store.known(ref)
    assert [m["model"] for m in store.models()[len(MODELS) :]] == ["llama3.1:8b"]
    assert "openai/gpt-5" not in store.path.read_text()
    assert store.remove_provider(gone) is False
    assert set(make_store(tmp_path, vault).providers) == {keep}


def test_a_provider_whose_key_cannot_be_removed_stays(tmp_path):
    vault = StuckVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    with pytest.raises(ValueError, match="left it in place"):
        store.remove_provider(pid)
    assert pid in store.providers and store.known(ref) and saved(vault, pid)["key"] == OR_KEY
    again = make_store(tmp_path, vault)  # the file still has it too: its key isn't stranded
    assert again.known(ref) and again.session_config(ref, {})["provider"] == pid


def test_remove_model_by_ref_or_id(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    a = store.add_model(pid, "openai/gpt-5")["ref"]
    b = store.add_model(pid, "x-ai/grok-4")["ref"]
    assert store.remove_model(a) is True
    assert store.remove_model(b.removeprefix(CUSTOM)) is True
    assert store.remove_model(a) is False and store.remove_model("") is False
    assert store.models_of(pid) == []


def test_an_anthropic_key_comes_with_the_claude_models(tmp_path):
    store = make_store(tmp_path)
    added = store.add_provider("anthropic", "", ANT_KEY)
    assert added["base_url"] == "https://api.anthropic.com" and added["auth"] == "x-api-key"
    assert [m["model"] for m in added["models"]] == list(MODELS.values())
    assert [m["name"] for m in added["models"]] == [
        f"{MODEL_NAMES[k]} · Anthropic API" for k in MODELS
    ]


def test_replacing_a_key_keeps_the_models(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    fresh = "sk-or-v1-" + "f" * 60 + "9999"
    shown = store.replace_key(pid, fresh)
    assert shown["key_hint"] == "sk-…9999" and saved(vault, pid)["key"] == fresh
    config = store.session_config(ref, {})
    assert fresh not in json.dumps(config)  # sessions read it from the Keychain themselves
    with pytest.raises(ValueError, match="shouldn't go to OpenRouter"):
        store.replace_key(pid, ANT_KEY)
    with pytest.raises(ValueError, match="no provider like that"):
        store.replace_key("nope", fresh)
    assert fresh not in store.path.read_text()


def test_find_provider_by_id_name_or_kind(tmp_path):
    store = make_store(tmp_path)
    personal = store.add_provider("openrouter", "Personal", OR_KEY)["id"]
    assert store.find_provider(personal).id == personal
    assert store.find_provider("  personal ").id == personal
    assert store.find_provider("OpenRouter").id == personal  # the only one of its kind
    store.add_provider("openrouter", "Work", OR_KEY)
    assert store.find_provider("openrouter") is None  # two of them: say which
    assert store.find_provider("") is None and store.find_provider("nobody") is None


def test_describe_and_known(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5", "GPT-5")["ref"]
    assert store.describe("opus") == "Opus 5.5" and store.describe(MODELS["haiku"]) == "Haiku 4.5"
    assert store.describe(ref) == "GPT-5 · OpenRouter"
    assert store.describe("custom:gone") == "custom:gone" and store.describe(None) == ""
    assert store.known("opus") and store.known(ref)
    assert not store.known("") and not store.known("custom:gone")
    assert not store.known(MODELS["opus"])  # a model id, not a ref


def test_public_is_what_the_panel_needs(tmp_path):
    store = make_store(tmp_path)
    state = store.public()
    kinds = {k["id"]: k for k in state["kinds"]}
    assert set(kinds) == {"anthropic", "openrouter", "custom"}
    assert kinds["custom"]["needs_base_url"]
    assert kinds["custom"]["auth_choices"] == ["bearer", "x-api-key"]
    assert not kinds["openrouter"]["needs_base_url"]
    assert "openai/gpt-5" in kinds["openrouter"]["suggested"]
    assert state["providers"] == []
    assert state["limits"] == {"providers": MAX_PROVIDERS, "models": MAX_MODELS}
    assert state["advice"] == KEY_ADVICE and "spending limit" in KEY_ADVICE
    json.dumps(state)  # plain JSON for the window


# ── labels ──


def test_a_label_cannot_pass_one_model_off_as_another(tmp_path):
    store = make_store(tmp_path)
    router = store.add_provider("openrouter", "", OR_KEY)["id"]
    other = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    store.add_model(router, "openai/gpt-5", "GPT-5")
    store.add_model(router, "openai/gpt-5-mini")
    for model, label in [
        ("openai/o1-pro", "GPT-5"),  # a label already shown on this provider
        ("openai/o1-pro", "gpt-5"),  # in any case
        ("openai/o1-pro", "openai/gpt-5-mini"),  # another model's id
        ("openai/o1-pro", "openai/gpt-6"),  # an id that isn't its own
        ("gpt-5", None),  # its own id, shown like a label already there
    ]:
        with pytest.raises(ValueError, match="would look like another model"):
            store.add_model(router, model, label)
    assert [e.model for e in store.models_of(router)] == ["openai/gpt-5", "openai/gpt-5-mini"]
    # Other providers' names follow every label, so those don't clash.
    assert store.add_model(other, "gpt-5", "GPT-5")["name"] == "GPT-5 · Box"
    assert store.add_model(router, "openai/o1-pro", "O1 Pro")["label"] == "O1 Pro"
    assert store.add_model(router, "openai/o3", "openai/o3")["label"] == "openai/o3"


def test_labels_edited_into_the_file_cannot_disguise_a_model(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    for model in ("openai/o1-pro", "openai/gpt-5", "openai/o3", "x-ai/grok-4"):
        store.add_model(pid, model)
    labels = {
        "openai/o1-pro": "GPT-5",
        "openai/gpt-5": "gpt-5",
        "openai/o3": "openai/gpt-5",
        "x-ai/grok-4": "Grok",
    }

    def disguise(data):
        for entry in data["models"]:
            entry["label"] = labels[entry["model"]]

    edit_file(store.path, disguise)
    again = make_store(tmp_path, vault)
    shown = {e.model: e.label for e in again.entries.values()}
    assert shown["openai/o3"] == "openai/o3" and shown["x-ai/grok-4"] == "Grok"
    names = [m["name"].casefold() for m in again.models()]
    assert len(names) == len(set(names))  # no two models look alike
    ids = {e.model.casefold() for e in again.entries.values()}
    assert all(e.label.casefold() not in ids - {e.model.casefold()} for e in again.entries.values())


# ── what the file can and can't do ──


def test_a_tampered_file_cannot_send_a_key_elsewhere(tmp_path):
    path = tmp_path / "providers.json"
    listed = [
        {
            "id": "aaaaaaaaaaaa",
            "kind": "openrouter",
            "name": "OpenRouter",
            "base_url": "https://evil.example",
            "auth": "x-api-key",
            "key_hint": "sk-…cdef",
        },
        {
            "id": "bbbbbbbbbbbb",
            "kind": "custom",
            "name": "Sneaky",
            "base_url": "http://evil.example",
        },
        {
            "id": "cccccccccccc",
            "kind": "custom",
            "name": "Local",
            "base_url": "http://localhost:4000",
            "auth": "x-api-key",
            "key_hint": "<script>",
        },
        {"id": "dddddddddddd", "kind": "martian", "name": "Mars"},
        {"id": "../../etc", "kind": "openrouter", "name": "Bad id"},
        {"id": "eeeeeeeeeeee", "kind": "openrouter", "name": "openrouter"},  # the name again
        "not a provider",
    ]
    models = [
        {
            "id": "111111111111",
            "provider": "aaaaaaaaaaaa",
            "model": "openai/gpt-5",
            "label": "GPT-5",
        },
        {"id": "222222222222", "provider": "aaaaaaaaaaaa", "model": "openai/gpt-5"},
        {"id": "333333333333", "provider": "bbbbbbbbbbbb", "model": "x-ai/grok-4"},
        {"id": "444444444444", "provider": "aaaaaaaaaaaa", "model": OR_KEY},
        {"id": "555555555555", "provider": "gone", "model": "x-ai/grok-4"},
    ]
    path.write_text(json.dumps({"providers": listed, "models": models}))
    store = ProviderStore(path, MemoryVault())
    assert set(store.providers) == {"aaaaaaaaaaaa", "cccccccccccc", "eeeeeeeeeeee"}
    router = store.providers["aaaaaaaaaaaa"]
    assert (router.base_url, router.auth, router.key_hint) == (
        "https://openrouter.ai/api",
        "bearer",
        "sk-…cdef",
    )
    assert store.providers["eeeeeeeeeeee"].name == "openrouter 2"  # renamed, not dropped
    local = store.providers["cccccccccccc"]
    assert (local.auth, local.key_hint) == ("x-api-key", "")
    assert [e.model for e in store.entries.values()] == ["openai/gpt-5"]


FLIPS = {
    "openrouter to a custom collector": (
        ("openrouter", "", OR_KEY, None, None),
        {"kind": "custom", "base_url": "https://collector.example", "auth": "bearer"},
    ),
    "openrouter to anthropic": (
        ("openrouter", "", OR_KEY, None, None),
        {"kind": "anthropic"},
    ),
    "anthropic to a custom collector": (
        ("anthropic", "", ANT_KEY, None, None),
        {"kind": "custom", "base_url": "https://collector.example", "auth": "x-api-key"},
    ),
    "a custom endpoint moved": (
        ("custom", "Box", LITE_KEY, "https://llm.example.com", None),
        {"base_url": "https://collector.example"},
    ),
    "a custom endpoint's header changed": (
        ("custom", "Box", LITE_KEY, "https://llm.example.com", "x-api-key"),
        {"auth": "bearer"},
    ),
}


@pytest.mark.parametrize("flip", list(FLIPS))
async def test_an_edited_kind_or_address_never_gets_the_key(tmp_path, flip):
    (kind, name, key, url, auth), change = FLIPS[flip]
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider(kind, name, key, url, auth=auth)["id"]
    ref = store.add_model(pid, "vendor/some-model")["ref"]
    edit_file(store.path, lambda data: data["providers"][0].update(change))
    again = make_store(tmp_path, vault)
    assert pid in again.providers and again.known(ref)  # it loads, and says what's wrong
    with pytest.raises(ValueError, match="doesn't match the key it was added with"):
        again.session_config(ref, {})
    seen = []
    async with router_client({"http": answer(json={"data": []})}, seen) as client:
        result = await again.check(pid, client)
        tool = {t.name: t.handler for t in build_tools(again, client=client)}
        out = await tool["check_ai_provider"]({"provider": pid})
    assert not result["ok"] and "haven't sent the key anywhere" in result["error"]
    assert out["is_error"] and seen == []  # nothing went out at all
    with pytest.raises(ValueError, match="doesn't match"):
        again.replace_key(pid, key)  # re-pasting can't bless the edited address either
    assert saved(vault, pid)["key"] == key


async def test_a_key_saved_by_an_older_version_is_not_used_until_pasted_again(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    vault.set(f"provider:{pid}", "api_key", OR_KEY)  # a bare key, as an early build saved it
    with pytest.raises(ValueError, match="older version of Jarvis"):
        store.session_config(ref, {})
    seen = []
    async with router_client({"https://": answer(json={"data": []})}, seen) as client:
        result = await store.check(pid, client)
    assert not result["ok"] and seen == []
    store.replace_key(pid, OR_KEY)
    assert saved(vault, pid)["kind"] == "openrouter"
    assert store.session_config(ref, {})["provider"] == pid


@pytest.mark.parametrize(
    "content",
    [b"", b"not json", b"[]", b'{"providers": 5, "models": "x"}', b"\xff\xfe", b"[" * 100_000],
)
def test_an_unreadable_file_means_an_empty_list(tmp_path, content):
    path = tmp_path / "providers.json"
    path.write_bytes(content)
    store = ProviderStore(path, MemoryVault())
    assert store.providers == {} and len(store.models()) == len(MODELS)


def test_a_locked_keychain_adds_nothing(tmp_path):
    store = make_store(tmp_path, BrokenVault())
    with pytest.raises(ValueError, match="couldn't save the key in the Keychain"):
        store.add_provider("openrouter", "", OR_KEY)
    assert store.providers == {} and not store.path.exists()


def test_a_failed_save_takes_the_key_back_out(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("")
    vault = MemoryVault()
    store = ProviderStore(blocker / "providers.json", vault)
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.add_provider("anthropic", "", ANT_KEY)
    assert store.providers == {} and store.entries == {} and vault.data == {}


def test_a_failed_save_takes_the_model_back_off(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    block_saving(store, tmp_path)
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.add_model(pid, "openai/gpt-5")
    assert store.models_of(pid) == []


def test_a_failed_save_leaves_everything_as_it_was(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    store.status[pid] = {"ok": True, "checked": "earlier", "count": 3, "error": ""}
    good = store.path
    block_saving(store, tmp_path)
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.remove_model(ref)
    assert store.known(ref)  # still on the list, as the error says
    fresh = "sk-or-v1-" + "f" * 60 + "9999"
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.replace_key(pid, fresh)
    assert saved(vault, pid)["key"] == OR_KEY and store.providers[pid].key_hint == "sk-…cdef"
    assert store.status[pid]["count"] == 3
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.remove_provider(pid)
    assert pid in store.providers and store.known(ref) and store.status[pid]["count"] == 3
    assert saved(vault, pid)["key"] == OR_KEY  # the key only goes once the list is saved
    store.path = good
    again = make_store(tmp_path, vault)
    assert again.known(ref) and again.session_config(ref, {})["provider"] == pid


def test_a_failed_save_of_a_new_key_when_there_was_none_leaves_none(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    vault.data.clear()  # the Keychain entry went missing
    block_saving(store, tmp_path)
    with pytest.raises(ValueError, match="couldn't save the model list"):
        store.replace_key(pid, OR_KEY)
    assert vault.data == {}


# ── sessions ──


def test_built_in_models_run_as_before(tmp_path):
    store = make_store(tmp_path)
    assert store.session_config("") == {
        "model": None,
        "env": {},
        "settings": None,
        "label": "",
        "provider": "",
        "claude": True,
    }
    assert store.session_config(None)["model"] is None
    for ref, model in MODELS.items():
        config = store.session_config(ref)
        assert (config["model"], config["env"], config["settings"], config["label"]) == (
            model,
            {},
            None,
            MODEL_NAMES[ref],
        )
    # TaskManager.model holds a model id: it passes through, on the owner's sign-in.
    config = store.session_config(MODELS["sonnet"])
    assert (config["model"], config["env"], config["label"]) == (
        MODELS["sonnet"],
        {},
        MODEL_NAMES["sonnet"],
    )
    assert store.session_config("claude-opus-4-1")["settings"] is None


def test_openrouter_sessions_follow_openrouters_recipe(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5", "GPT-5")["ref"]
    config = store.session_config(ref, {})
    pins = settings_of(config)["env"]
    assert (config["model"], config["label"]) == ("openai/gpt-5", "GPT-5 · OpenRouter")
    assert config["provider"] == pid and config["claude"] is False
    assert pins["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api"
    assert pins["ANTHROPIC_AUTH_TOKEN"] == "" and pins["ANTHROPIC_API_KEY"] == ""
    assert pins["ANTHROPIC_MODEL"] == "openai/gpt-5"
    assert all(pins[name] == "openai/gpt-5" for name in TIER_ENV)
    assert pins["ANTHROPIC_CUSTOM_HEADERS"] == "" and pins["CLAUDE_CODE_USE_BEDROCK"] == ""
    assert settings_of(config)["apiKeyHelper"] == keychain_helper(pid)


def test_an_anthropic_key_session_uses_the_key_instead_of_the_plan(tmp_path):
    store = make_store(tmp_path)
    added = store.add_provider("anthropic", "Work API", ANT_KEY)
    opus = next(m for m in added["models"] if m["model"] == MODELS["opus"])
    config = store.session_config(opus["ref"], {})
    pins = settings_of(config)["env"]
    assert config["model"] == MODELS["opus"] and config["claude"] is True
    assert pins["ANTHROPIC_BASE_URL"] == ""  # Claude Code's own address, api.anthropic.com
    assert all(pins[name] == "" for name in TIER_ENV)  # its own Claude tiers, on the key
    assert pins["CLAUDE_CODE_OAUTH_TOKEN"] == ""  # never the owner's own sign-in
    assert settings_of(config)["apiKeyHelper"] == keychain_helper(added["id"])


@pytest.mark.parametrize("auth", [None, "bearer", "x-api-key", "API-Key"])
def test_custom_endpoints_get_their_address(tmp_path, auth):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "LiteLLM", LITE_KEY, "http://localhost:4000/v1", auth=auth)
    ref = store.add_model(pid["id"], "qwen3-coder")["ref"]
    config = store.session_config(ref, {})
    pins = settings_of(config)["env"]
    assert pins["ANTHROPIC_BASE_URL"] == "http://localhost:4000"
    assert all(pins[name] == "qwen3-coder" for name in TIER_ENV)  # a local model stays local
    assert config["claude"] is False


@pytest.mark.parametrize(
    ("kind", "key", "url"),
    [
        ("openrouter", OR_KEY, None),
        ("anthropic", ANT_KEY, None),
        ("custom", LITE_KEY, "https://llm.example.com"),
    ],
)
def test_a_session_never_carries_the_key(tmp_path, kind, key, url):
    """Not in the environment (the session's shell would inherit it), not in the settings
    (they go on the command line): the helper reads it from the Keychain."""
    store = make_store(tmp_path)
    pid = store.add_provider(kind, "", key, url)["id"]
    ref = store.add_model(pid, "vendor/some-model")["ref"]
    config = store.session_config(ref, {"HTTPS_PROXY": "http://proxy.local:3128"})
    assert key not in json.dumps(config) and key[-12:] not in json.dumps(config)
    assert set(settings_of(config)) == {"apiKeyHelper", "env"}
    assert set(settings_of(config)["env"]) == set(ROUTING_ENV)
    assert config["env"] == dict.fromkeys(CREDENTIAL_ENV, "")


def test_the_environment_alone_never_points_a_session_at_the_provider(tmp_path):
    """Applied without the settings, a session stays on Claude Code's own address with
    the owner's sign-in (and fails on the unknown model): it never sends the owner's
    Claude sign-in to a third party."""
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    env = store.session_config(store.add_model(pid, "openai/gpt-5")["ref"], {})["env"]
    assert not set(env) & set(DESTINATION_ENV) - set(CREDENTIAL_ENV)
    assert not set(env) & set(NETWORK_ENV)
    assert set(env.values()) == {""}


# Every switch and address Claude Code 2.1.284 has for choosing where model requests go,
# and every credential it could send instead of the helper's key (from its own list of
# settings env it treats as sensitive).
CLI_2_1_284 = {
    "backends": [
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_GATEWAY",
    ],
    "addresses": [
        "ANTHROPIC_BASE_URL",
        "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
        "ANTHROPIC_FOUNDRY_BASE_URL",
        "ANTHROPIC_AWS_BASE_URL",
        "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
        "CLAUDE_CODE_API_BASE_URL",
        "ANTHROPIC_UNIX_SOCKET",
    ],
    "skip_auth": [
        "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
        "CLAUDE_CODE_SKIP_VERTEX_AUTH",
        "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
        "CLAUDE_CODE_SKIP_MANTLE_AUTH",
        "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
        "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
    ],
    "credentials": [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "ANTHROPIC_FOUNDRY_API_KEY",
        "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
        "ANTHROPIC_AWS_API_KEY",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",  # makes it ignore apiKeyHelper
        "CLAUDE_CODE_REMOTE",  # makes it send the claude.ai sign-in as the bearer
    ],
    "network": [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "NO_PROXY",
        "CLAUDE_CODE_HTTPS_PROXY",
        "CLAUDE_CODE_HTTP_PROXY",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_EXTRA_CA_CERTS",
        "CLAUDE_CODE_CERT_STORE",
    ],
}


@pytest.mark.parametrize("group", list(CLI_2_1_284))
def test_every_routing_name_claude_code_2_1_284_knows_is_pinned(group):
    missing = [name for name in CLI_2_1_284[group] if name not in ROUTING_ENV]
    assert missing == []


def _bundled_cli():
    import claude_agent_sdk

    return Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"


NOT_ROUTING = {  # CLAUDE_CODE_USE_* names that switch features, not where requests go
    "CLAUDE_CODE_USE_POWERSHELL_TOOL",
    "CLAUDE_CODE_USE_COWORK_PLUGINS",
    "CLAUDE_CODE_USE_CCR_V2",
    "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
}


@pytest.mark.skipif(not _bundled_cli().exists(), reason="the Agent SDK's bundled CLI is absent")
def test_the_bundled_cli_has_no_unpinned_backend_or_address():
    """Reads the bundled Claude Code for its backend switches, base addresses and
    skip-auth switches, and its own list of credential variables. A new one after an SDK
    upgrade fails here until it's pinned (or listed in NOT_ROUTING)."""
    from claude_agent_sdk._cli_version import __cli_version__

    data = _bundled_cli().read_bytes()
    found = {
        *re.findall(rb"CLAUDE_CODE_USE_[A-Z0-9_]+", data),
        *re.findall(rb"ANTHROPIC_[A-Z0-9_]*BASE_URL", data),
        *re.findall(rb"CLAUDE_CODE_SKIP_[A-Z0-9_]+_AUTH", data),
    }
    credentials = re.search(
        rb'\["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"(?:,"[A-Z0-9_]+")*\]', data
    )
    if credentials:
        found |= set(re.findall(rb'"([A-Z0-9_]+)"', credentials.group()))
    names = {name.decode() for name in found} - NOT_ROUTING
    assert "CLAUDE_CODE_USE_BEDROCK" in names  # the scan works on this build
    assert sorted(names - set(ROUTING_ENV)) == [], f"Claude Code {__cli_version__}"


def test_network_settings_follow_this_macs_own(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "http://localhost:4000")["id"]
    ref = store.add_model(pid, "qwen3-coder")["ref"]
    mac = {
        "HTTPS_PROXY": "http://proxy.corp:3128",
        "no_proxy": "localhost,127.0.0.1",
        "NODE_EXTRA_CA_CERTS": "/etc/corp-ca.pem",
        "http_proxy": "http://someone:hunter2@proxy.corp:3128",
    }
    config = store.session_config(ref, mac)
    pins = settings_of(config)["env"]
    assert pins["HTTPS_PROXY"] == "http://proxy.corp:3128"
    assert pins["no_proxy"] == "localhost,127.0.0.1"
    assert pins["NODE_EXTRA_CA_CERTS"] == "/etc/corp-ca.pem"
    assert pins["https_proxy"] == "" and pins["NODE_TLS_REJECT_UNAUTHORIZED"] == ""
    assert "http_proxy" not in pins and "hunter2" not in config["settings"]
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:1080")  # environ defaults to this Mac's
    assert settings_of(store.session_config(ref))["env"]["ALL_PROXY"] == "socks5://127.0.0.1:1080"


def test_the_key_helper_names_the_keychain_entry_the_vault_writes(monkeypatch):
    written = []
    fake = types.ModuleType("keyring")
    fake.set_password = lambda service, account, value: written.append((service, account))
    monkeypatch.setitem(sys.modules, "keyring", fake)
    Vault().set("provider:abc123def456", "api_key", "{}")
    command = shlex.split(keychain_helper("abc123def456", "/opt/py"))
    assert command == ["/opt/py", "-I", "-c", HELPER_CODE, *written[0]]
    assert written == [(SERVICE, "provider:abc123def456:api_key")]
    assert shlex.split(keychain_helper("abc123def456"))[0] == sys.executable


def run_helper(monkeypatch, capsys, stored=None, fail=False):
    """HELPER_CODE run here, on a stand-in for keyring's macOS backend."""
    asked = []

    class Keyring:
        def get_password(self, service, account):
            asked.append((service, account))
            if fail:
                raise RuntimeError("keychain locked")
            return stored

    macos = types.ModuleType("keyring.backends.macOS")
    macos.Keyring = Keyring
    backends = types.ModuleType("keyring.backends")
    backends.macOS = macos
    monkeypatch.setitem(sys.modules, "keyring", types.ModuleType("keyring"))
    monkeypatch.setitem(sys.modules, "keyring.backends", backends)
    monkeypatch.setitem(sys.modules, "keyring.backends.macOS", macos)
    monkeypatch.setattr(sys, "argv", ["-c", SERVICE, "provider:abc123def456:api_key"])
    code = compile(HELPER_CODE, "<apiKeyHelper>", "exec")
    try:
        exec(code, {"__name__": "__main__"})
        exit_message = None
    except SystemExit as stop:
        exit_message = stop.code
    out = capsys.readouterr()
    assert asked == [(SERVICE, "provider:abc123def456:api_key")]
    return out.out, exit_message


def test_the_key_helper_prints_only_the_key(tmp_path, monkeypatch, capsys):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    record = vault.get(f"provider:{pid}", "api_key")
    assert run_helper(monkeypatch, capsys, record) == (OR_KEY, None)
    for stored, fail in [
        (None, False),
        (OR_KEY, False),
        ("[1]", False),
        ("{}", False),
        (None, True),
    ]:
        out, message = run_helper(monkeypatch, capsys, stored, fail)
        assert out == "" and message.startswith("Jarvis ")  # to stderr, with exit status 1


def test_the_helper_command_survives_the_shell(tmp_path):
    """The command runs through /bin/sh as Claude Code runs it: an argument-printing stand-in
    for Python, in a folder with a space and a quote in its name, gets the exact code."""
    folder = tmp_path / "Jarvis's venv" / "bin"
    folder.mkdir(parents=True)
    fake = folder / "py thon"
    echo = "import json, sys; print(json.dumps(sys.argv[1:]))"
    fake.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -c {shlex.quote(echo)} "$@"\n')
    fake.chmod(0o755)
    command = keychain_helper("abc123def456", str(fake))
    done = subprocess.run(
        ["/bin/sh", "-c", command], capture_output=True, text=True, timeout=20, cwd=tmp_path
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == [
        "-I",
        "-c",
        HELPER_CODE,
        SERVICE,
        "provider:abc123def456:api_key",
    ]


def test_an_isolated_python_ignores_a_projects_own_modules(tmp_path):
    """The helper runs in the project's folder: isolated mode keeps a planted json.py or
    keyring package (and PYTHONPATH) off its import path."""
    (tmp_path / "json.py").write_text("raise SystemExit('planted json')\n")
    (tmp_path / "keyring").mkdir()
    (tmp_path / "keyring" / "__init__.py").write_text("raise SystemExit('planted keyring')\n")
    probe = "import json, keyring.backends.macOS as m; print(json.__file__); print(m.__file__)"
    done = subprocess.run(
        [sys.executable, "-I", "-c", probe],
        capture_output=True,
        text=True,
        timeout=20,
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(tmp_path), "PYTHONSTARTUP": str(tmp_path / "json.py")},
    )
    assert done.returncode == 0, done.stderr
    assert str(tmp_path) not in done.stdout and "planted" not in done.stdout + done.stderr


def test_a_helper_can_be_given(tmp_path):
    store = make_store(tmp_path, helper=lambda pid: f"printf %s test-{pid}")
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    assert settings_of(store.session_config(ref, {}))["apiKeyHelper"] == f"printf %s test-{pid}"


def test_session_config_errors_say_what_to_do(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    with pytest.raises(ValueError, match="isn't on the list any more"):
        store.session_config("custom:0123456789ab")
    with pytest.raises(ValueError, match="doesn't look like a model id"):
        store.session_config("rm -rf /")
    vault.delete(f"provider:{pid}", "api_key")  # the Keychain entry went missing
    with pytest.raises(ValueError, match="no key saved for OpenRouter"):
        store.session_config(ref)
    store.remove_model(ref)
    with pytest.raises(ValueError, match="isn't on the list any more"):
        store.session_config(ref)


def test_a_locked_keychain_is_explained_not_a_crash(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    locked = ProviderStore(store.path, LockedVault())
    with pytest.raises(ValueError, match="couldn't read OpenRouter's key from the Keychain"):
        locked.session_config(ref)
    with pytest.raises(ValueError, match="couldn't read the Keychain"):
        locked.replace_key(pid, OR_KEY)


# ── checking a key ──

ANTHROPIC_MODELS = {
    "data": [
        {"type": "model", "id": "claude-opus-5-5-20260801", "display_name": "Claude Opus 5.5"},
        {"type": "model", "id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5"},
        {"type": "model", "id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5"},
    ],
    "has_more": False,
}
OPENROUTER_MODELS = {
    "data": [
        {"id": "openai/gpt-5", "name": "OpenAI: GPT-5", "supported_parameters": ["tools"]},
        {"id": "deepseek/deepseek-r1", "name": "DeepSeek: R1", "supported_parameters": ["seed"]},
        {"id": "anthropic/claude-opus-4.5", "name": "Anthropic: Claude Opus 4.5"},
    ]
}


async def test_checking_an_anthropic_key_lists_its_models(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("anthropic", "", ANT_KEY)["id"]
    seen = []
    routes = {"https://api.anthropic.com/v1/models": answer(json=ANTHROPIC_MODELS)}
    async with router_client(routes, seen) as client:
        result = await store.check(pid, client)
    assert result["ok"] and result["error"] == ""
    assert result["note"] == "Anthropic API works: 3 models to choose from."
    assert result["models"][0] == {
        "id": "claude-opus-5-5-20260801",
        "name": "Claude Opus 5.5",
        "tools": None,
    }
    assert result["missing"] == [MODELS["fable"]]  # this key has no Fable, say
    (request,) = seen
    assert str(request.url) == "https://api.anthropic.com/v1/models?limit=1000"
    assert request.headers["x-api-key"] == ANT_KEY
    assert request.headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in request.headers
    status = store.public()["providers"][0]["status"]
    assert (status["ok"], status["count"], status["error"]) == (True, 3, "")


async def test_checking_openrouter_tries_the_key_then_lists_models(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    for model in ("openai/gpt-5:nitro", "~anthropic/claude-opus-latest[1m]", "openai/gpt5"):
        store.add_model(pid, model)
    seen = []
    routes = {
        "https://openrouter.ai/api/v1/key": answer(
            json={"data": {"label": "jarvis", "limit_remaining": 4.2, "is_free_tier": False}}
        ),
        "https://openrouter.ai/api/v1/models": answer(json=OPENROUTER_MODELS),
    }
    async with router_client(routes, seen) as client:
        result = await store.check(pid, client)
    assert result["ok"]
    assert result["note"] == (
        "OpenRouter works: 3 models to choose from. $4.20 of credit left on this key."
    )
    assert [(m["id"], m["tools"]) for m in result["models"]] == [
        ("openai/gpt-5", True),
        ("deepseek/deepseek-r1", False),
        ("anthropic/claude-opus-4.5", None),
    ]
    assert result["missing"] == ["openai/gpt5"]  # a typo; variants and ~aliases pass
    assert [str(r.url) for r in seen] == [
        "https://openrouter.ai/api/v1/key",
        "https://openrouter.ai/api/v1/models?limit=1000",
    ]
    assert all(r.headers["authorization"] == f"Bearer {OR_KEY}" for r in seen)
    assert all("x-api-key" not in r.headers and r.url.host == "openrouter.ai" for r in seen)


async def test_a_rejected_openrouter_key_stops_the_check(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    seen = []
    echoed = {"error": {"message": f"No auth credentials found for {OR_KEY}", "code": 401}}
    routes = {"https://openrouter.ai/api/v1/key": answer(401, json=echoed)}
    async with router_client(routes, seen) as client:
        result = await store.check(pid, client)
    assert not result["ok"] and result["models"] == []
    assert result["error"].startswith("OpenRouter turned the key down (401).")
    assert OR_KEY not in result["error"] and "sk-…cdef" in result["error"]
    assert len(seen) == 1  # the model list is never asked for with a bad key
    status = store.public()["providers"][0]["status"]
    assert status["ok"] is False and OR_KEY not in json.dumps(store.public())


@pytest.mark.parametrize(
    ("auth", "header", "value"),
    [("bearer", "authorization", f"Bearer {LITE_KEY}"), ("x-api-key", "x-api-key", LITE_KEY)],
)
async def test_checking_a_custom_endpoint_sends_the_key_its_way(tmp_path, auth, header, value):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "LiteLLM", LITE_KEY, "https://llm.example.com/v1", auth=auth)
    seen = []
    listed = {
        "object": "list",
        "data": [{"id": "qwen3-coder", "object": "model"}, {"id": "qwen3-coder"}, {"no": 1}, "x"],
    }
    async with router_client(
        {"https://llm.example.com/v1/models": answer(json=listed)}, seen
    ) as client:
        result = await store.check(pid["id"], client)
    assert result["ok"] and result["models"] == [
        {"id": "qwen3-coder", "name": "qwen3-coder", "tools": None}
    ]
    assert result["note"] == "LiteLLM works: 1 model to choose from."
    (request,) = seen
    assert request.headers[header] == value
    assert ("x-api-key" if header == "authorization" else "authorization") not in request.headers


@pytest.mark.parametrize(
    ("status", "words"),
    [
        (401, "LiteLLM turned the key down (401)."),
        (403, "LiteLLM turned the key down (403)."),
        (402, "LiteLLM says the account is out of credit (402)."),
        (404, "Nothing answered at https://llm.example.com/v1/models (404). Check the address."),
        (429, "LiteLLM is limiting requests right now (429)."),
        (500, "LiteLLM had a problem on its side (500)."),
        (418, "LiteLLM answered 418."),
    ],
)
async def test_http_errors_come_back_in_plain_words(tmp_path, status, words):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "LiteLLM", LITE_KEY, "https://llm.example.com")["id"]
    reply = answer(status, json={"error": {"message": f"bad key {LITE_KEY}"}})
    async with router_client({"https://llm.example.com": reply}, []) as client:
        result = await store.check(pid, client)
    assert not result["ok"] and result["error"].startswith(words)
    assert LITE_KEY not in result["error"] and result["error"].endswith("It said: bad key sk-…4b1d")


async def test_an_html_error_page_is_not_read_out(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    page = answer(502, text="<html><body>Bad gateway " + "x" * 9000 + "</body></html>")
    async with router_client({"https://llm.example.com": page}, []) as client:
        result = await store.check(pid, client)
    assert result["error"] == "Box had a problem on its side (502). Try again shortly."


@pytest.mark.parametrize("follow", [False, True])
async def test_a_redirect_is_never_followed_with_the_key(tmp_path, follow):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Gateway", LITE_KEY, "https://llm.example.com")["id"]
    seen = []
    moved = answer(302, headers={"Location": "https://evil.example/v1/models"})
    routes = {"https://llm.example.com": moved, "https://evil.example": answer(json={"data": []})}
    async with router_client(routes, seen, follow_redirects=follow) as client:
        result = await store.check(pid, client)
    assert not result["ok"] and "tried to send me to another address (302)" in result["error"]
    assert [r.url.host for r in seen] == ["llm.example.com"]


@pytest.mark.parametrize(
    ("base", "error", "words"),
    [
        ("https://llm.example.com", httpx.ConnectError, "I couldn't reach llm.example.com."),
        ("http://localhost:4000", httpx.ConnectError, "Nothing is answering at localhost:4000"),
        ("https://llm.example.com", httpx.ReadTimeout, "Box didn't answer within 15 seconds."),
        ("https://llm.example.com", httpx.RemoteProtocolError, "couldn't check Box (Remote"),
    ],
)
async def test_network_failures_are_explained(tmp_path, base, error, words):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, base)["id"]

    def fail(request):
        raise error(f"boom {LITE_KEY}", request=request)

    async with router_client({base: fail}, []) as client:
        result = await store.check(pid, client)
    assert not result["ok"] and words in result["error"] and LITE_KEY not in result["error"]


async def test_a_closed_client_is_a_failed_check_not_a_crash(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    client = router_client({}, [])
    await client.aclose()
    result = await store.check(pid, client)
    assert not result["ok"] and result["error"].startswith("I couldn't check Box")


@pytest.mark.parametrize(
    "body", [b"<html>hello</html>", b'{"models": "nope"}', b'"just a string"', b"{broken"]
)
async def test_replies_that_are_not_model_lists(tmp_path, body):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    async with router_client({"https://llm.example.com": answer(content=body)}, []) as client:
        result = await store.check(pid, client)
    assert result["error"] == "Box answered, but not with a list of models. Check the address."


DEEP = b"[" * 100_000 + b"]" * 100_000  # 200 KB, under MAX_BODY, far past Python's recursion


async def test_a_deeply_nested_reply_is_a_failed_check_not_a_crash(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    async with router_client({"https://llm.example.com": answer(content=DEEP)}, []) as client:
        result = await store.check(pid, client)
        tool = {t.name: t.handler for t in build_tools(store, client=client)}
        out = await tool["check_ai_provider"]({"provider": "Box"})
    assert result["error"] == "Box answered, but not with a list of models. Check the address."
    assert out["is_error"] and "not with a list of models" in out["content"][0]["text"]
    async with router_client({"https://llm.example.com": answer(401, content=DEEP)}, []) as client:
        result = await store.check(pid, client)
    assert result["error"] == "Box turned the key down (401). Check it, or paste a fresh key."


async def test_a_deeply_nested_openrouter_key_reply_is_not_a_crash(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    routes = {
        "https://openrouter.ai/api/v1/key": answer(content=DEEP),
        "https://openrouter.ai/api/v1/models": answer(json=OPENROUTER_MODELS),
    }
    async with router_client(routes, []) as client:
        result = await store.check(pid, client)
    assert result["ok"] and result["note"] == "OpenRouter works: 3 models to choose from."


async def test_a_trickling_reply_is_cut_off_at_the_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(providers, "CHECK_DEADLINE", 0.2)
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]

    async def trickle():
        yield b'{"data": ['
        while True:  # a byte at a time, each well inside the per-read timeout
            await asyncio.sleep(0.02)
            yield b" "

    reply = answer(content=trickle())
    started = time.monotonic()
    async with router_client({"https://llm.example.com": reply}, []) as client:
        result = await store.check(pid, client)
    assert time.monotonic() - started < 2
    assert result["error"] == "Box didn't answer within 0.2 seconds."
    assert store.status[pid]["ok"] is False


async def test_anything_unforeseen_is_a_failed_check(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]

    def broken(_payload):
        raise RuntimeError("surprise")

    monkeypatch.setattr(providers, "_parse_models", broken)
    async with router_client({"https://": answer(json={"data": []})}, []) as client:
        result = await store.check(pid, client)
    assert result == {
        "ok": False,
        "models": [],
        "error": "I couldn't check Box (RuntimeError).",
        "note": "",
        "missing": [],
    }

    async def exploding(*_args):
        raise MemoryError("worse")

    monkeypatch.setattr(providers, "_probe", exploding)
    result = await store.check(pid, router_client({}, []))
    assert result["error"] == "I couldn't check Box (MemoryError)."


async def test_a_huge_reply_is_cut_off(tmp_path, monkeypatch):
    monkeypatch.setattr(providers, "MAX_BODY", 1000)
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    body = json.dumps({"data": [{"id": f"m-{n}"} for n in range(500)]}).encode()
    async with router_client({"https://llm.example.com": answer(content=body)}, []) as client:
        result = await store.check(pid, client)
    assert result["error"] == "Box sent far more than a list of models; check the address."


async def test_a_long_model_list_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(providers, "MAX_LISTED", 5)
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    body = {"data": [{"id": f"m-{n}", "name": "\x1b[31m" + "n" * 500} for n in range(50)]}
    async with router_client({"https://llm.example.com": answer(json=body)}, []) as client:
        result = await store.check(pid, client)
    assert [m["id"] for m in result["models"]] == [f"m-{n}" for n in range(5)]
    assert all(len(m["name"]) <= 120 and "\x1b" not in m["name"] for m in result["models"])


async def test_checking_something_that_is_not_there(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    assert await store.check("nope") == {
        "ok": False,
        "models": [],
        "error": "There's no provider like that; it may have been removed.",
        "note": "",
        "missing": [],
    }
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    vault.data.clear()
    result = await store.check(pid)  # stops before any request: no client is even made
    assert not result["ok"] and "no key saved for OpenRouter" in result["error"]


async def test_a_check_brings_its_own_client_when_none_is_given(tmp_path, monkeypatch):
    seen = []
    listed = {"data": [{"id": "qwen3-coder"}]}
    monkeypatch.setattr(
        providers, "_default_client", lambda: router_client({"http": answer(json=listed)}, seen)
    )
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "", LITE_KEY, "http://127.0.0.1:4000")["id"]
    result = await store.check(pid)
    assert result["ok"] and [str(r.url) for r in seen] == [
        "http://127.0.0.1:4000/v1/models?limit=1000"
    ]


async def test_a_provider_removed_mid_check_leaves_no_status(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]

    def reply(_request):
        store.remove_provider(pid)
        return httpx.Response(200, json={"data": [{"id": "m"}]})

    async with router_client({"https://llm.example.com": reply}, []) as client:
        result = await store.check(pid, client)
    assert result["ok"] and pid not in store.status and store.providers == {}


async def test_a_check_of_an_old_key_never_stands_for_the_new_one(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    fresh = "sk-lite-" + "9" * 20
    arrived, release = asyncio.Event(), asyncio.Event()

    async def reply(request):
        if request.headers["authorization"] == f"Bearer {fresh}":
            return httpx.Response(200, json={"data": [{"id": "m"}]})
        arrived.set()
        await release.wait()  # the old key's check is slow, and turned down
        return httpx.Response(401, json={"error": {"message": "no"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(reply)) as client:
        old = asyncio.create_task(store.check(pid, client))
        await arrived.wait()
        store.replace_key(pid, fresh)
        new = await store.check(pid, client)
        release.set()
        stale = await old
    assert new["ok"] and store.status[pid]["ok"] is True
    assert (
        not stale["ok"]
        and stale["error"] == "Box's key changed while I was checking it; check again."
    )


@pytest.mark.parametrize(
    ("model", "offered"),
    [
        ("openai/gpt-5", False),  # only gpt-5-mini and -nano are listed
        ("openai/gpt", False),
        ("claude-opus-4", False),
        ("claude-opus-4-1", True),  # its dated name is listed
        ("claude-sonnet-4", True),  # -latest
        ("gpt-4o", True),  # OpenAI's dashed date
        ("claude-3-5-sonnet-v2", True),  # Vertex's @date
        ("openai/gpt-5-mini:free", True),
        ("openai/gpt-5-nano[1m]", True),
        ("~openai/anything", True),
    ],
)
def test_undated_names_count_but_longer_relatives_do_not(model, offered):
    listed = {
        "openai/gpt-5-mini",
        "openai/gpt-5-nano",
        "claude-opus-4-1-20250805",
        "claude-sonnet-4-latest",
        "gpt-4o-2024-08-06",
        "claude-3-5-sonnet-v2@20241022",
    }
    assert providers._offered(model, listed) is offered


# ── Claude's tools ──


async def test_the_list_tool_names_every_model_and_no_key(tmp_path):
    store = make_store(tmp_path)
    tools = {t.name: t.handler for t in build_tools(store)}
    text = (await tools["list_ai_models"]({}))["content"][0]["text"]
    assert "Opus 5.5 [opus]" in text and "Nothing else is added" in text
    pid = store.add_provider("openrouter", "Router", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5", "GPT-5")["ref"]
    plain = store.add_model(pid, "x-ai/grok-4")["ref"]
    store.add_provider("custom", "", LITE_KEY, "http://localhost:4000")
    text = (await tools["list_ai_models"]({}))["content"][0]["text"]
    assert f"Router (OpenRouter): GPT-5 (openai/gpt-5) [{ref}], x-ai/grok-4 [{plain}]" in text
    assert "localhost:4000 (Custom endpoint): no models added yet" in text
    assert OR_KEY not in text and LITE_KEY not in text and "…" not in text


async def test_adding_a_model_by_voice_goes_through_the_gate(tmp_path):
    store = make_store(tmp_path)
    store.add_provider("openrouter", "", OR_KEY)
    asked, changes = [], []

    async def gate(action, question):
        asked.append((action, question))
        return True

    tools = {t.name: t.handler for t in build_tools(store, gate, lambda: changes.append(1))}
    out = await tools["add_ai_model"](
        {"provider": "openrouter", "model": "x-ai/grok-4", "label": "Grok 4"}
    )
    assert out["content"][0]["text"].startswith("Added Grok 4 · OpenRouter (ref custom:")
    assert asked == [
        ("models", "Add x-ai/grok-4 (shown as “Grok 4”) from OpenRouter to Jarvis Code's models?")
    ]
    assert changes == [1] and store.models()[-1]["model"] == "x-ai/grok-4"


async def test_an_added_model_is_always_asked_about_by_its_real_id(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    store.add_model(pid, "openai/gpt-5", "GPT-5")
    asked = []

    async def gate(_action, question):
        asked.append(question)
        return True

    add = {t.name: t.handler for t in build_tools(store, gate)}["add_ai_model"]
    out = await add({"provider": "OpenRouter", "model": "openai/o1-pro", "label": "GPT-5"})
    assert out["is_error"] and "would look like another model" in out["content"][0]["text"]
    assert asked == []  # refused before anyone is asked
    await add({"provider": "OpenRouter", "model": "openai/o1-pro", "label": "Deep thinker"})
    assert asked == [
        "Add openai/o1-pro (shown as “Deep thinker”) from OpenRouter to Jarvis Code's models?"
    ]


async def test_the_add_tool_checks_before_it_asks(tmp_path):
    store = make_store(tmp_path)
    asked = []

    async def gate(action, question):
        asked.append(question)
        return False

    tools = {t.name: t.handler for t in build_tools(store, gate)}
    out = await tools["add_ai_model"]({"provider": "OpenRouter", "model": "openai/gpt-5"})
    assert out["is_error"] and "None are added yet" in out["content"][0]["text"]
    store.add_provider("openrouter", "", OR_KEY)
    out = await tools["add_ai_model"]({"provider": "OpenRouter", "model": OR_KEY})
    assert out["is_error"] and OR_KEY not in out["content"][0]["text"] and asked == []
    out = await tools["add_ai_model"]({"provider": "OpenRouter", "model": "openai/gpt-5"})
    assert out["is_error"] and asked == [
        "Add openai/gpt-5 from OpenRouter to Jarvis Code's models?"
    ]
    assert len(store.models()) == len(MODELS)
    out = await tools["add_ai_model"]({"provider": "Nobody", "model": "openai/gpt-5"})
    assert "The added providers are: OpenRouter." in out["content"][0]["text"]


async def test_the_remove_tool(tmp_path):
    store = make_store(tmp_path)
    router = store.add_provider("openrouter", "", OR_KEY)["id"]
    local = store.add_provider("custom", "Local", LITE_KEY, "http://localhost:4000")["id"]
    store.add_model(router, "openai/gpt-5", "GPT-5")
    store.add_model(local, "openai/gpt-5", "GPT-5")
    tools = {t.name: t.handler for t in build_tools(store)}
    out = await tools["remove_ai_model"]({"model": "Opus 5.5"})
    assert out["is_error"] and "always stay" in out["content"][0]["text"]
    out = await tools["remove_ai_model"]({"model": "gpt-6"})
    assert out["is_error"] and "isn't on the list" in out["content"][0]["text"]
    out = await tools["remove_ai_model"]({"model": "gpt-5"})  # both labels, any case
    assert out["is_error"] and "More than one matches" in out["content"][0]["text"]
    out = await tools["remove_ai_model"]({"model": "gpt-5 · local"})
    assert out["content"][0]["text"] == "Removed GPT-5 · Local."
    assert [e.provider for e in store.entries.values()] == [router]
    store.add_provider("anthropic", "", ANT_KEY)
    out = await tools["remove_ai_model"]({"model": "Opus 5.5"})  # an added one has that name
    assert out["content"][0]["text"] == "Removed Opus 5.5 · Anthropic API."


async def test_the_remove_tool_asks_first_by_the_real_id(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    store.add_model(pid, "openai/gpt-5", "Main")
    asked = []

    async def no(_action, question):
        asked.append(question)
        return False

    tools = {t.name: t.handler for t in build_tools(store, no)}
    out = await tools["remove_ai_model"]({"model": "Main"})
    assert out["is_error"] and len(store.models_of(pid)) == 1
    assert asked == [
        "Take openai/gpt-5 (shown as “Main”) from OpenRouter off Jarvis Code's models?"
    ]


async def test_the_check_tool_reports_in_words(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Local", LITE_KEY, "http://localhost:4000")["id"]
    store.add_model(pid, "qwen3-coder")
    store.add_model(pid, "glm-4.6")
    changes = []
    listed = answer(json={"data": [{"id": "qwen3-coder"}]})
    async with router_client({"http://localhost:4000": listed}, []) as client:
        tools = build_tools(store, on_change=lambda: changes.append(1), client=client)
        check = {t.name: t.handler for t in tools}["check_ai_provider"]
        out = await check({"provider": "local"})
        assert out["content"][0]["text"] == (
            "Local works: 1 model to choose from. It doesn't list: glm-4.6."
        )
        assert changes == [1]
        assert (await check({"provider": "nobody"}))["is_error"]
    failing = answer(401, json={"error": {"message": "no"}})
    async with router_client({"http://localhost:4000": failing}, []) as client:
        check = {t.name: t.handler for t in build_tools(store, client=client)}["check_ai_provider"]
        out = await check({"provider": "Local"})
    assert out["is_error"] and out["content"][0]["text"].startswith("Local turned the key down")


def test_the_server_and_prompt(tmp_path):
    server = build_server(make_store(tmp_path))
    assert server["type"] == "sdk" and server["name"] == "providers"
    assert "Settings › Models" in PROMPT and "never ask for one" in PROMPT


# ── more guards, and load ──


async def test_a_server_echoing_part_of_the_key_is_not_repeated(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    reply = answer(401, json={"error": {"message": f"Invalid key {LITE_KEY[:14]}..."}})
    async with router_client({"https://llm.example.com": reply}, []) as client:
        result = await store.check(pid, client)
    assert result["error"] == "Box turned the key down (401). Check it, or paste a fresh key."


@pytest.mark.parametrize(
    ("listed", "ok"),
    [({"data": [{"name": "no id"}, "junk", 7]}, False), ({"data": []}, True), ([], True)],
)
async def test_a_list_with_nothing_usable_is_not_a_model_list(tmp_path, listed, ok):
    store = make_store(tmp_path)
    pid = store.add_provider("custom", "Box", LITE_KEY, "https://llm.example.com")["id"]
    async with router_client({"https://llm.example.com": answer(json=listed)}, []) as client:
        result = await store.check(pid, client)
    assert result["ok"] is ok
    assert result["note"] == ("Box works: 0 models to choose from." if ok else "")


@pytest.mark.parametrize("left", ["NaN", "Infinity", "true", '"4.20"', "null"])
async def test_odd_credit_figures_say_nothing(tmp_path, left):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    key_info = answer(content=f'{{"data": {{"limit_remaining": {left}}}}}'.encode())
    routes = {
        "https://openrouter.ai/api/v1/key": key_info,
        "https://openrouter.ai/api/v1/models": answer(json=OPENROUTER_MODELS),
    }
    async with router_client(routes, []) as client:
        result = await store.check(pid, client)
    assert result["note"] == "OpenRouter works: 3 models to choose from."


async def test_the_add_tool_never_asks_about_a_model_already_there(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    store.add_model(pid, "openai/gpt-5")
    asked = []

    async def gate(_action, question):
        asked.append(question)
        return True

    add = {t.name: t.handler for t in build_tools(store, gate)}["add_ai_model"]
    out = await add({"provider": "OpenRouter", "model": "openai/gpt-5"})
    assert out["is_error"] and "already on OpenRouter's list" in out["content"][0]["text"]
    out = await add({"provider": "OpenRouter", "model": "openai/gpt-5.1", "label": OR_KEY})
    assert out["is_error"] and OR_KEY not in out["content"][0]["text"] and asked == []


async def test_the_remove_tool_reports_a_failed_save(tmp_path):
    store = make_store(tmp_path)
    pid = store.add_provider("openrouter", "", OR_KEY)["id"]
    ref = store.add_model(pid, "openai/gpt-5")["ref"]
    block_saving(store, tmp_path)
    remove = {t.name: t.handler for t in build_tools(store)}["remove_ai_model"]
    out = await remove({"model": "openai/gpt-5"})
    assert out["is_error"] and "couldn't save the model list" in out["content"][0]["text"]
    assert store.known(ref)  # "couldn't" means it's still there


async def test_many_checks_at_once(tmp_path):
    store = make_store(tmp_path)
    ids = [
        store.add_provider("custom", f"Box {n}", LITE_KEY, f"https://llm{n}.example.com")["id"]
        for n in range(MAX_PROVIDERS)
    ]

    async def slow(request):
        await asyncio.sleep(0.01)
        return httpx.Response(200, json={"data": [{"id": request.url.host}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
        results = await asyncio.gather(*(store.check(pid, client) for pid in ids * 3))
    assert all(r["ok"] for r in results)
    assert [r["models"][0]["id"] for r in results[:3]] == [f"llm{n}.example.com" for n in range(3)]
    assert all(store.status[pid]["count"] == 1 for pid in ids)


def test_heavy_churn_keeps_the_file_whole_and_free_of_keys(tmp_path):
    vault = MemoryVault()
    store = make_store(tmp_path, vault)
    keys = [f"sk-or-v1-{n:04d}" + "9f8e7d6c5b4a" * 5 for n in range(30)]
    for round_, key in enumerate(keys):  # every third one stays: ten in all
        pid = store.add_provider("openrouter", f"Router {round_}", key)["id"]
        for n in range(3):
            store.add_model(pid, f"vendor/model-{n}")
        if round_ % 3:
            store.remove_provider(pid)
    again = make_store(tmp_path, vault)
    text = again.path.read_text()
    assert not any(key in text for key in keys)
    assert len(again.providers) == 10 and len(again.entries) == 30
    assert set(vault.data) == {f"provider:{pid}:api_key" for pid in again.providers}
    assert again.models() == store.models()
    for n in range(MAX_PROVIDERS - 10):
        again.add_provider("custom", f"Box {n}", LITE_KEY, f"https://llm{n}.example.com")
    with pytest.raises(ValueError, match=f"{MAX_PROVIDERS} providers already"):
        again.add_provider("openrouter", "One too many", OR_KEY)
