import asyncio
import json
import shlex
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from jarvis.connectors import (
    CATALOG_BY_ID,
    REDIRECT_URI,
    CallbackServer,
    Connection,
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


# ── a sign-in that ran out: never the browser unasked ──

SERVICE_URL = "https://mcp.example.test/mcp"
ORIGIN = "https://mcp.example.test"


class OAuthService:
    """An MCP server behind OAuth (as Notion's is), faked at the HTTP level: it takes only
    the access token "fresh", refreshes only the refresh token "r1", and hands out a token
    for any sign-in code."""

    def __init__(self):
        self.refreshed: list[str] = []

    def __call__(self, request):
        import httpx2

        path = request.url.path
        if path.startswith("/.well-known/oauth-protected-resource"):
            return httpx2.Response(200, json={"resource": SERVICE_URL, "authorization_servers": [ORIGIN]})  # fmt: skip
        if path.startswith(("/.well-known/oauth-authorization-server", "/.well-known/openid")):
            return httpx2.Response(200, json={
                "issuer": ORIGIN, "authorization_endpoint": f"{ORIGIN}/authorize",
                "token_endpoint": f"{ORIGIN}/token", "registration_endpoint": f"{ORIGIN}/register",
                "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
            })  # fmt: skip
        if path == "/register":
            return httpx2.Response(201, json={"client_id": "jarvis", "redirect_uris": [REDIRECT_URI], "token_endpoint_auth_method": "none"})  # fmt: skip
        if path == "/token":
            form = parse_qs(request.content.decode())
            grant = form.get("grant_type", [""])[0]
            if grant == "refresh_token":
                self.refreshed.append(form.get("refresh_token", [""])[0])
            if grant == "authorization_code" or form.get("refresh_token") == ["r1"]:
                return httpx2.Response(200, json={"access_token": "fresh", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "r2"})  # fmt: skip
            return httpx2.Response(400, json={"error": "invalid_grant"})
        if path != "/mcp":
            return httpx2.Response(404)
        if request.headers.get("authorization") != "Bearer fresh":
            where = f"{ORIGIN}/.well-known/oauth-protected-resource/mcp"
            return httpx2.Response(401, headers={"WWW-Authenticate": f'Bearer resource_metadata="{where}"'})  # fmt: skip
        if request.method != "POST":
            return httpx2.Response(405)
        message = json.loads(request.content)
        if "id" not in message:  # a notification
            return httpx2.Response(202)
        result = {
            "initialize": {"protocolVersion": message.get("params", {}).get("protocolVersion"),
                           "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}},
            "tools/list": {"tools": [{"name": "search", "inputSchema": {"type": "object"}}]},
        }.get(message["method"], {})  # fmt: skip
        return httpx2.Response(200, json={"jsonrpc": "2.0", "id": message["id"], "result": result})


@pytest.fixture
def oauth_service(monkeypatch):
    import httpx2
    import mcp.shared._httpx_utils as httpx_utils

    service = OAuthService()

    def client(headers=None, timeout=None, auth=None):
        return httpx2.AsyncClient(
            transport=httpx2.MockTransport(service), headers=headers, auth=auth
        )

    monkeypatch.setattr(httpx_utils, "create_mcp_http_client", client)
    return service


def oauth_manager(tmp_path, tokens, expires_at=None):
    """A manager with one saved OAuth connection, as after a restart, and the pages it
    opened in the browser."""
    opened: list[str] = []
    manager = ConnectorManager(
        lambda kind, **d: None,
        lambda *_a: "deny",
        vault=MemoryVault(),
        store=tmp_path / "connections.json",
        open_url=opened.append,
    )
    manager.callback = CallbackServer(port=47897)  # not the running app's
    manager.connections["svc"] = Connection(
        id="svc", name="Service", kind="http", url=SERVICE_URL, auth="oauth"
    )
    manager.vault.set("svc", "oauth_tokens", json.dumps({"token_type": "Bearer", **tokens}))
    manager.vault.set("svc", "oauth_client", json.dumps({"client_id": "jarvis", "redirect_uris": [REDIRECT_URI], "token_endpoint_auth_method": "none"}))  # fmt: skip
    if expires_at is not None:
        manager.vault.set("svc", "oauth_expires_at", str(expires_at))
    return manager, opened


async def settled(manager, conn_id="svc"):
    live = manager.live[conn_id]
    await asyncio.wait_for(live.ready.wait(), 10)
    return live


async def test_at_launch_a_sign_in_that_ran_out_says_so_and_never_opens_the_browser(
    tmp_path, oauth_service
):
    manager, opened = oauth_manager(tmp_path, {"access_token": "stale", "refresh_token": "old"})
    await manager.start_all()
    live = await settled(manager)
    assert opened == [] and manager.signing_in == {}
    assert live.status == "error" and "sign in again" in live.error
    assert oauth_service.refreshed == ["old"]  # the refresh was tried first
    await manager.close()


async def test_try_again_opens_the_sign_in_page_and_connects(tmp_path, oauth_service):
    manager, opened = oauth_manager(tmp_path, {"access_token": "stale"})
    await manager.start_all()
    assert (await settled(manager)).status == "error" and opened == []
    await manager.reconnect("svc")  # the user pressed Try again
    for _ in range(200):
        if opened:
            break
        await asyncio.sleep(0.02)
    assert opened and opened[0].startswith(f"{ORIGIN}/authorize")
    state = parse_qs(urlparse(opened[0]).query)["state"][0]
    await asyncio.sleep(0.1)  # the callback listener is up
    async with httpx.AsyncClient() as client:
        await client.get(f"http://127.0.0.1:47897/callback?code=abc&state={state}")
    live = await settled(manager)
    assert live.status == "connected", live.error
    assert [t.name for t in live.tools] == ["search"] and live.asked is False
    await manager.close()


async def test_at_launch_a_stored_token_is_refreshed_first_not_signed_in_again(
    tmp_path, oauth_service
):
    # Saved by an older build: no expiry on record, so the refresh token is tried first.
    manager, opened = oauth_manager(tmp_path, {"access_token": "stale", "refresh_token": "r1"})
    await manager.start_all()
    live = await settled(manager)
    assert live.status == "connected", live.error
    assert opened == [] and oauth_service.refreshed == ["r1"]
    saved = json.loads(manager.vault.get("svc", "oauth_tokens"))
    assert saved["access_token"] == "fresh" and saved["refresh_token"] == "r2"
    assert float(manager.vault.get("svc", "oauth_expires_at")) > time.time() + 3000
    await manager.close()


async def test_a_token_still_good_is_used_as_it_is(tmp_path, oauth_service):
    manager, opened = oauth_manager(
        tmp_path, {"access_token": "fresh", "refresh_token": "r1"}, expires_at=time.time() + 600
    )
    await manager.start_all()
    assert (await settled(manager)).status == "connected"
    assert opened == [] and oauth_service.refreshed == []
    await manager.close()
    manager.vault.forget("svc")
    assert manager.vault.get("svc", "oauth_expires_at") is None
