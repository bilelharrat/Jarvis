# ruff: noqa: F811  (the fixtures hub and projects come from test_code_triggers)
"""Coverage the round-1 audit found missing (H9): claude_signin's cached settings made again
once the proxy moved or forgot their pass, and the Linear/Slack door's size cap on a
declared and on a streamed body."""

from test_code_triggers import configure, hub, knock, projects, ticket  # noqa: F401
from trigger_fakes import linear_body

from jarvis import claude_signin, key_proxy
from jarvis.connectors import MemoryVault
from jarvis.features import code_triggers
from jarvis.providers import ProviderStore

ANT_KEY = "sk-ant-api03-" + "Zx9_Yw8-Vu7" * 8 + "AA"


def test_a_cached_pass_the_proxy_forgot_or_a_moved_proxy_makes_new_settings(tmp_path, monkeypatch):
    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    pid = store.add_provider("anthropic", "", ANT_KEY, None)["id"]
    provider = store.providers[pid]
    monkeypatch.setattr(key_proxy.PROXY, "_thread", type("T", (), {"is_alive": lambda self: True})())
    monkeypatch.setattr(key_proxy.PROXY, "port", 45001)
    claude_signin._CACHE.pop(pid, None)
    try:
        first = claude_signin.settings_for(provider, store)
        assert claude_signin.settings_for(provider, store) == first  # (kept while it's good)
        old = key_proxy.pass_in(first)
        key_proxy.GRANTS.revoke(old)  # forgotten (idle a week, or the cap)
        second = claude_signin.settings_for(provider, store)
        assert second != first and key_proxy.GRANTS.alive(key_proxy.pass_in(second))
        monkeypatch.setattr(key_proxy.PROXY, "port", 45002)  # the proxy started again elsewhere
        third = claude_signin.settings_for(provider, store)
        assert third != second and claude_signin._CACHE[pid][0] == "http://127.0.0.1:45002"
        claude_signin.forget(pid)
        assert pid not in claude_signin._CACHE
        assert not key_proxy.GRANTS.alive(key_proxy.pass_in(third))
    finally:
        claude_signin._CACHE.pop(pid, None)


async def test_the_doors_size_cap_holds_declared_or_streamed(hub):
    configure(hub, "linear")
    body, headers = linear_body(**ticket())
    declared = {**headers, "content-length": str(code_triggers.MAX_BYTES + 1)}
    assert (await knock(hub, "linear", body, declared))[0] == 413
    huge = b"x" * (code_triggers.MAX_BYTES + 10)
    assert (await knock(hub, "linear", huge, headers))[0] == 413
    assert (await knock(hub, "linear", body, headers))[0] == 200
