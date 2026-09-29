import asyncio
import shlex
import sys
from pathlib import Path

import httpx
import pytest

from jarvis.connectors import (
    CATALOG_BY_ID,
    REDIRECT_URI,
    CallbackServer,
    ConnectorManager,
    KeychainTokenStorage,
    MemoryVault,
    server_name,
)

DEMO = Path(__file__).parent / "fixtures" / "demo_mcp_server.py"


def make_manager(tmp_path, answers=()):
    asked, events = [], []

    async def approve(question, detail, choices):
        asked.append((question, detail, [c for c, _ in choices]))
        return answers[len(asked) - 1]

    manager = ConnectorManager(
        lambda kind, **d: events.append((kind, d)),
        approve,
        vault=MemoryVault(),
        store=tmp_path / "connections.json",
        open_url=lambda url: None,
    )
    return manager, asked, events


async def wait_connected(manager, conn_id, timeout=20):
    live = manager.live[conn_id]
    await asyncio.wait_for(live.ready.wait(), timeout)
    assert live.status == "connected", live.error
    return live


async def test_custom_stdio_server_end_to_end(tmp_path):
    manager, asked, _ = make_manager(tmp_path, answers=["always", "deny"])
    conn = await manager.add_custom("Demo notes", shlex.join([sys.executable, str(DEMO)]))
    live = await wait_connected(manager, conn.id)
    assert {t.name for t in live.tools} == {"list_notes", "add_note"}

    servers, allowed = manager.build_servers()
    name = server_name(conn.id)
    assert name in servers
    assert f"mcp__{name}__list_notes" in allowed  # read-only runs unasked
    assert f"mcp__{name}__add_note" not in allowed

    result = await live.call("add_note", {"text": "buy milk"})
    assert result["content"][0]["text"] == "Added: buy milk"

    # Changing tools ask; "Always allow this" sticks.
    assert await manager.gate(f"mcp__{name}__add_note", {"text": "x"}) is True
    assert asked[0][2] == ["allow", "always", "deny"]
    assert await manager.gate(f"mcp__{name}__add_note", {"text": "y"}) is True
    assert len(asked) == 1
    assert await manager.gate("mcp__mac__open_app", {}) is None  # not a connector tool

    manager.set_policy(conn.id, "read_only")
    servers, _ = manager.build_servers()
    assert servers  # still there, but only with the read-only tool
    await manager.disconnect(conn.id)
    assert conn.id not in manager.connections
    assert manager.build_servers() == ({}, [])


async def test_connections_persist_without_secrets(tmp_path):
    manager, _, _ = make_manager(tmp_path)
    await manager.connect("github", token="ghp_example_token")
    stored = (tmp_path / "connections.json").read_text()
    assert "github" in stored and "ghp_example_token" not in stored
    assert manager.vault.get("github", "token") == "ghp_example_token"
    await manager.close()
    again, _, _ = make_manager(tmp_path)
    assert again.connections["github"].url == CATALOG_BY_ID["github"].url


async def test_token_services_need_a_token(tmp_path):
    manager, _, _ = make_manager(tmp_path)
    with pytest.raises(ValueError):
        await manager.connect("github", token="  ")
    with pytest.raises(ValueError):
        await manager.connect("gmail")  # needs the user's own OAuth client
    with pytest.raises(ValueError):
        await manager.add_custom("x", "http://example.com/mcp")  # plain http off-machine


async def test_own_app_client_goes_to_the_vault(tmp_path):
    manager, _, _ = make_manager(tmp_path)
    await manager.connect("gmail", client_id="123.apps.googleusercontent.com", client_secret="s3")
    info = await KeychainTokenStorage(manager.vault, "gmail").get_client_info()
    assert info.client_id.startswith("123")
    assert [str(u) for u in info.redirect_uris] == [REDIRECT_URI]
    assert "gmail.readonly" in info.scope
    await manager.close()


async def test_callback_server_catches_the_code():
    server = CallbackServer(port=47899)
    waiting = asyncio.create_task(server.wait_for_code(timeout=10))
    await asyncio.sleep(0.2)
    async with httpx.AsyncClient() as client:
        page = await client.get("http://127.0.0.1:47899/callback?code=abc&state=xyz")
    assert page.status_code == 200 and "Signed in" in page.text
    assert await waiting == ("abc", "xyz")
