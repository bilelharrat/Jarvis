"""JARVIS's key proxy (key_proxy.py): a Claude Code run gets a pass made for it, never a key
nor a command that reads one, and the proxy (or a relay) puts the key in the pass's place on
the way to the address the key was sealed with, and nowhere else. No real Keychain (a vault
kept in memory), no network (a stand-in transport), no model."""

import json
import shlex
import subprocess
import sys

import httpx
import pytest
from starlette.testclient import TestClient

from jarvis import key_proxy, openai_relay
from jarvis.connectors import SERVICE, MemoryVault
from jarvis.gemini_proxy import build_app as gemini_app
from jarvis.key_proxy import DIRECT, GEMINI, Grants, build_app
from jarvis.providers import ProviderStore

OR_KEY = "sk-or-v1-" + "0123456789abcdef" * 4
ANT_KEY = "sk-ant-api03-" + "Zx9_Yw8-Vu7" * 8 + "AA"
GOOGLE_KEY = "AIza" + "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"


def store_with(tmp_path, kind="openrouter", key=OR_KEY, url=None):
    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    pid = store.add_provider(kind, "", key, url)["id"]
    return store, pid


def upstream_seen():
    """A stand-in for the provider: what it was sent, and a streamed answer."""
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream", "request-id": "req_1"},
            stream=httpx.ByteStream(b"event: message_start\ndata: {}\n\n"),
        )

    return seen, lambda: httpx.AsyncClient(transport=httpx.MockTransport(answer))


def test_a_pass_goes_to_the_sealed_address_with_the_key_in_its_place(tmp_path):
    store, pid = store_with(tmp_path)
    grants = Grants()
    token = grants.mint(DIRECT, lambda: store.grant_target(pid))
    seen, factory = upstream_seen()
    client = TestClient(build_app(grants, factory), client=("127.0.0.1", 5000))
    done = client.post(
        "/v1/messages?beta=true",
        content=b'{"model":"openai/gpt-5"}',
        headers={
            "x-api-key": token,
            "authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "cookie": "planted=1",
        },
    )
    assert done.status_code == 200 and done.content.startswith(b"event: message_start")
    assert done.headers["request-id"] == "req_1"
    [sent] = seen
    assert str(sent.url) == "https://openrouter.ai/api/v1/messages?beta=true"
    assert sent.headers["x-api-key"] == OR_KEY
    assert sent.headers["authorization"] == f"Bearer {OR_KEY}"
    assert sent.headers["anthropic-version"] == "2023-06-01"
    assert "cookie" not in sent.headers and token not in json.dumps(dict(sent.headers))
    assert sent.content == b'{"model":"openai/gpt-5"}'
    # The key only where the pass came: a request with just x-api-key gets just that.
    client.post("/v1/messages", content=b"{}", headers={"x-api-key": token})
    assert "authorization" not in seen[-1].headers and seen[-1].headers["x-api-key"] == OR_KEY


def test_the_proxy_spends_no_pass_it_didnt_make_and_goes_nowhere_but_the_messages_api(tmp_path):
    store, pid = store_with(tmp_path)
    grants = Grants()
    token = grants.mint(DIRECT, lambda: store.grant_target(pid))
    seen, factory = upstream_seen()
    client = TestClient(build_app(grants, factory), client=("127.0.0.1", 5000))
    for headers in (
        {},
        {"x-api-key": OR_KEY},  # the key itself is no pass: nothing is sent anywhere with it
        {"x-api-key": key_proxy.TOKEN_PREFIX + "guessed"},
    ):
        assert client.post("/v1/messages", content=b"{}", headers=headers).status_code == 401
    assert client.get("/api/oauth/profile", headers={"x-api-key": token}).status_code == 404
    # Nor out of it by way of dots (an address's own path, like OpenRouter's /api, stays).
    for sly in ("/v1/%2E%2E/oauth/profile", "/v1/%2e%2e/%2e%2e/admin", "/v1/.%2E/x"):
        assert client.get(sly, headers={"x-api-key": token}).status_code == 404, sly
    far = TestClient(build_app(grants, factory), client=("10.0.0.2", 5000))
    assert far.post("/v1/messages", content=b"{}", headers={"x-api-key": token}).status_code == 403
    # A Gemini provider's pass is spent by the Gemini relay, never here.
    gemini = grants.mint(GEMINI, lambda: ("https://generativelanguage.googleapis.com", "k"))
    assert (
        client.post("/v1/messages", content=b"{}", headers={"x-api-key": gemini}).status_code == 401
    )
    assert seen == []
    # The provider removed: its passes stand for nothing.
    store.remove_provider(pid)
    assert (
        client.post("/v1/messages", content=b"{}", headers={"x-api-key": token}).status_code == 401
    )
    assert seen == []


def test_the_sealed_address_wins_over_an_edited_file_and_a_new_key_counts_at_once(tmp_path):
    store, pid = store_with(tmp_path, "custom", "sk-lite-7f3a9c2e4b1d", "https://llm.example.com")
    assert store.grant_target(pid) == ("https://llm.example.com", "sk-lite-7f3a9c2e4b1d")
    store.replace_key(pid, "sk-lite-second-key-99")
    assert store.grant_target(pid) == ("https://llm.example.com", "sk-lite-second-key-99")
    raw = json.loads(store.path.read_text())
    raw["providers"][0]["base_url"] = "https://evil.example.com"
    store.path.write_text(json.dumps(raw))
    assert ProviderStore(store.path, store.vault).grant_target(pid) is None


def test_passes_are_forgotten_unused_or_past_the_cap_and_each_run_gets_its_own(monkeypatch):
    now = [1000.0]
    grants = Grants(clock=lambda: now[0])
    target = ("https://api.anthropic.com", ANT_KEY)
    one, two = grants.mint(DIRECT, lambda: target), grants.mint(DIRECT, lambda: target)
    assert one != two and key_proxy.is_token(one)
    now[0] += key_proxy.GRANT_IDLE - 1
    assert grants.target(one, DIRECT) == target  # used: a week from now, again
    now[0] += 2
    assert grants.target(two, DIRECT) is None and not grants.alive(two)
    assert grants.alive(one)
    grants.revoke(one)
    assert grants.target(one, DIRECT) is None
    monkeypatch.setattr(key_proxy, "MAX_GRANTS", 3)
    made = [grants.mint(DIRECT, lambda: target) for _ in range(4)]
    assert not grants.alive(made[0]) and all(grants.alive(t) for t in made[1:])

    # A key that can't be read (a locked Keychain) sends nothing.
    def locked():
        raise RuntimeError("locked")

    assert grants.target(grants.mint(DIRECT, locked), DIRECT) is None


def test_the_relays_swap_a_pass_only_for_their_own_provider(tmp_path):
    store, pid = store_with(tmp_path, "openai", "local", "http://localhost:11434")
    calls = []

    class Relay:
        async def messages(self, upstream, key, body):
            calls.append((upstream, key))
            return 200, {"type": "message", "content": []}, None

    token = store.grant_for(store.providers[pid])
    client = TestClient(
        openai_relay.build_app(Relay(), lambda: store.relay_target), client=("127.0.0.1", 5000)
    )
    ok = client.post(f"/p/{pid}/v1/messages", json={"messages": []}, headers={"x-api-key": token})
    assert ok.status_code == 200 and calls == [("http://localhost:11434", "local")]
    # Another provider's pass, or the proxy's own, is no pass here.
    other, opid = store_with(tmp_path / "o", "openai", "local2", "http://localhost:1234")
    elsewhere = other.grant_for(other.providers[opid])
    direct = key_proxy.GRANTS.mint(DIRECT, lambda: ("https://openrouter.ai/api", OR_KEY))
    for wrong in (elsewhere, direct):
        refused = client.post(f"/p/{pid}/v1/messages", json={}, headers={"x-api-key": wrong})
        assert refused.status_code == 401
    assert len(calls) == 1

    class Gemini:
        async def messages(self, key, body):
            calls.append(("gemini", key))
            return 200, {"type": "message", "content": []}, None

    gstore, gid = store_with(tmp_path / "g", "gemini", GOOGLE_KEY)
    gpass = gstore.grant_for(gstore.providers[gid])
    google = TestClient(gemini_app(Gemini()), client=("127.0.0.1", 5000))
    assert google.post("/v1/messages", json={}, headers={"x-api-key": gpass}).status_code == 200
    assert calls[-1] == ("gemini", GOOGLE_KEY)
    # An Anthropic key's pass never reaches Google.
    assert google.post("/v1/messages", json={}, headers={"x-api-key": direct}).status_code == 401
    assert calls[-1] == ("gemini", GOOGLE_KEY) and len(calls) == 2


@pytest.mark.parametrize("kind", ["openrouter", "anthropic", "gemini", "openai"])
def test_a_sessions_settings_hold_nothing_that_can_fetch_a_secret(tmp_path, kind, monkeypatch):
    """The whole of what a run is given (its settings, on its command line, and its env):
    no key, no Keychain service or entry, no Python or keyring that could read one. Run as
    Claude Code runs it, its helper prints the pass and nothing else."""
    from jarvis import gemini_proxy

    monkeypatch.setattr(gemini_proxy.PROXY, "port", 45679)
    monkeypatch.setattr(openai_relay.PROXY, "port", 45678)
    keys = {
        "openrouter": OR_KEY,
        "anthropic": ANT_KEY,
        "gemini": GOOGLE_KEY,
        "openai": "sk-local-123456",
    }
    url = "http://localhost:11434" if kind == "openai" else None
    store, pid = store_with(tmp_path, kind, keys[kind], url)
    ref = store.add_model(pid, "some-model")["ref"]
    config = store.session_config(ref, {})
    carried = json.dumps(config)
    for reader in (keys[kind], SERVICE, f"provider:{pid}", "keyring", sys.executable, " -I "):
        assert reader not in carried, reader
    helper = json.loads(config["settings"])["apiKeyHelper"]
    done = subprocess.run(["/bin/sh", "-c", helper], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0 and key_proxy.is_token(done.stdout)
    assert shlex.split(helper) == ["printf", "%s", done.stdout]


def test_the_proxy_runs_on_its_own_and_answers_at_once():
    """Started from plain code (claude_signin's settings are made outside the loop): bound
    and listening before ensure() returns, in a thread of its own; a request without a
    pass goes nowhere."""
    proxy = key_proxy.KeyProxy(Grants())
    try:
        address = proxy.ensure()
        assert address.startswith("http://127.0.0.1:") and proxy.ensure() == address
        answer = httpx.post(f"{address}/v1/messages", content=b"{}", timeout=10, trust_env=False)
        assert answer.status_code == 401
        assert answer.json()["error"]["type"] == "authentication_error"
    finally:
        proxy.close()
    assert proxy.address == ""
