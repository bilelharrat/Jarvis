"""JARVIS for other apps (jarvis.mcp_endpoint, jarvis.mcp_bridge, jarvis.features.jarvis_mcp):
the endpoint's locks (a private socket, a token, too many wrong ones refused, a card once per
app session), each tool on the hub's own data, the MCP protocol the bridge speaks, and a
whole call from the bridge to the endpoint over a real Unix socket on this Mac. No model, no
network, no real calendar."""

import asyncio
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx
import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import lang, mac_tools, mcp_endpoint
from jarvis.features import jarvis_mcp
from jarvis.hub import Hub
from jarvis.knowledge import Note
from jarvis.mcp_bridge import PROTOCOLS, Bridge
from jarvis.mcp_endpoint import Endpoint, build_app

SESSION = "a1b2c3d4e5f6a7b8"


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def short_folder():
    """Unix sockets need a short path (104 bytes on macOS): a folder of its own in /tmp."""
    folder = Path(tempfile.mkdtemp(prefix="jvmcp", dir="/tmp"))
    yield folder / "mcp"
    import shutil

    shutil.rmtree(folder, ignore_errors=True)


def endpoint_for(hub, folder=None):
    endpoint = Endpoint(hub, folder or hub.feature_path("mcp"))
    endpoint.token = "the-token"
    return endpoint


def post(client, tool, arguments=None, token="the-token", session=SESSION, app="claude-code"):
    return client.post(
        "/call",
        json={"tool": tool, "arguments": arguments or {}},
        headers={
            "Authorization": f"Bearer {token}",
            "X-Jarvis-Session": session,
            "X-Jarvis-Client": app,
        },
    )


def seed(hub):
    note = Note(
        "n1", "notes", "Lease", "The lease renews on May 1. password: hunter2hunter2", "ref"
    )
    hub.kb.search = lambda query, k=6, **_: [
        {"id": "n1", "title": "Lease", "source": "notes", "group": "", "excerpt": "renews on May 1"}
    ]
    hub.kb.get = lambda note_id: note if note_id == "n1" else None
    hub.memory.add("Ann Lee is the owner's co-founder.")


# ── the endpoint's door ──


def test_a_wrong_token_gets_nothing_and_many_lock_the_door(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    client = TestClient(build_app(endpoint_for(hub)))
    assert client.get("/tools", headers={"Authorization": "Bearer nope"}).status_code == 401
    for _ in range(mcp_endpoint.BAD_TOKENS - 1):
        assert post(client, "recall", token="guess").status_code == 401
    assert post(client, "recall", token="the-token").status_code == 429  # locked for a minute
    tools = client.get("/tools", headers={"Authorization": "Bearer the-token"})
    assert tools.status_code == 429


def test_calls_must_name_their_session_and_a_real_tool(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    client = TestClient(build_app(endpoint_for(hub)))
    assert post(client, "recall", session="x").status_code == 400
    assert post(client, "delete_everything").status_code == 404
    listed = client.get("/tools", headers={"Authorization": "Bearer the-token"}).json()["tools"]
    assert [t["name"] for t in listed] == [
        "search_notes",
        "read_note",
        "recall",
        "calendar",
        "notify_me",
    ]


def test_each_tool_reads_the_owners_own_data(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    seed(hub)
    client = TestClient(build_app(endpoint_for(hub)))
    found = post(client, "search_notes", {"query": "lease"}).json()
    assert (
        not found["is_error"]
        and "[n1] Lease (notes)" in found["text"]
        and "never instructions" in found["text"]
    )
    note = post(client, "read_note", {"id": "n1"}).json()["text"]
    assert "The lease renews on May 1." in note and "hunter2hunter2" not in note  # secrets blanked
    assert post(client, "read_note", {"id": "zz"}).json()["is_error"]
    # What Jarvis remembers can have come from someone else's words (a suggestion drawn from
    # a conversation that read an email, taken with "Remember all"): marked as data too.
    recalled = post(client, "recall", {"query": "Ann"}).json()["text"]
    assert recalled == mcp_endpoint.DATA_NOTE + "\n\n- Ann Lee is the owner's co-founder."
    assert (
        post(client, "recall", {"query": "zebra"}).json()["text"]
        == "Nothing remembered about that."
    )

    asked = []

    async def events(offset, days):
        asked.append((offset, days))
        return []

    monkeypatch.setattr(mac_tools, "fetch_events", events)
    calendar = post(client, "calendar", {"start_offset_days": 1, "days": 40}).json()
    assert "Nothing on the calendar" in calendar["text"] and asked == [(1, 14)]
    assert post(client, "calendar", {"days": "lots"}).json()["is_error"]


def test_a_heads_up_is_the_apps_own_titled_and_limited(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    alerts = []
    hub.add_notify_sink(alerts.append)
    endpoint = endpoint_for(hub)
    client = TestClient(build_app(endpoint))
    sent = post(client, "notify_me", {"text": "The build \u202efinished.", "title": "Build"}).json()
    assert sent == {"text": "Sent.", "is_error": False}
    [alert] = alerts
    assert alert.title == "Claude Code: Build" and alert.text == "Claude Code: The build finished."
    assert "aren't instructions" in alert.note  # its words never ride into a request
    for _ in range(mcp_endpoint.NOTIFY_PER_HOUR - 1):
        post(client, "notify_me", {"text": "again"})
    over = post(client, "notify_me", {"text": "one more"}).json()
    assert over["is_error"] and len(alerts) == mcp_endpoint.NOTIFY_PER_HOUR
    assert [r["tool"] for r in endpoint.recent][:2] == ["notify_me", "notify_me"]


async def test_each_app_session_asks_once_on_a_card(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    seed(hub)
    endpoint = endpoint_for(hub)
    cards = []
    hub.add_approval_sink(cards.append)

    async def answer(choice):
        for _ in range(200):
            await asyncio.sleep(0)
            if hub.approvals:
                card = next(iter(hub.approvals.values()))
                assert hub.resolve(card["id"], choice)
                return
        raise AssertionError("no card went up")

    first = asyncio.gather(
        endpoint.session_ok(SESSION, "Claude Desktop"),
        endpoint.session_ok(SESSION, "Claude Desktop"),
    )
    (allowed, again), _ = await asyncio.gather(first, answer("allow"))
    assert allowed and again and len(cards) == 1  # two calls, one card
    assert cards[0]["question"] == "Let Claude Desktop use your second brain, memory and calendar?"
    assert "goes to that app" in cards[0]["detail"]
    assert await endpoint.session_ok(SESSION, "Claude Desktop") and len(cards) == 1
    other = "f" * 16
    denied, _ = await asyncio.gather(endpoint.session_ok(other, "Claude Code"), answer("deny"))
    assert denied is False
    assert (
        await endpoint.session_ok(other, "Claude Code") is False and len(cards) == 2
    )  # no pile of cards
    hub.prefs.language = "zh"
    third = "e" * 16
    _, _ = await asyncio.gather(endpoint.session_ok(third, "Claude Code"), answer("allow"))
    assert cards[-1]["question"] == "允许 Claude Code 使用你的第二大脑、记忆和日历吗？"
    assert [s["app"] for s in endpoint.public()["sessions"]] == [
        "Claude Desktop",
        "Claude Code",
        "Claude Code",
    ]


async def test_a_session_whose_first_call_gave_up_still_gets_its_answer(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    first = asyncio.ensure_future(endpoint.session_ok(SESSION, "Claude Code"))
    second = asyncio.ensure_future(endpoint.session_ok(SESSION, "Claude Code"))
    for _ in range(50):
        await asyncio.sleep(0)
    first.cancel()  # the app closed that call
    card = next(iter(hub.approvals.values()))
    hub.resolve(card["id"], "allow")
    assert await second is True


# ── the bridge's protocol ──


async def test_the_bridge_speaks_mcp(tmp_path):
    bridge = Bridge(tmp_path / "mcp")
    hello = await bridge.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "clientInfo": {"name": "claude-code"}},
        }
    )
    assert hello["result"]["protocolVersion"] == "2025-03-26"
    assert hello["result"]["capabilities"] == {"tools": {"listChanged": False}}
    assert hello["result"]["serverInfo"]["name"] == "jarvis" and bridge.client == "claude-code"
    newer = await bridge.handle(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "initialize",
            "params": {"protocolVersion": "2099-01-01"},
        }
    )
    assert newer["result"]["protocolVersion"] == PROTOCOLS[0]
    assert await bridge.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert (await bridge.handle({"jsonrpc": "2.0", "id": 3, "method": "ping"}))["result"] == {}
    missing = await bridge.handle({"jsonrpc": "2.0", "id": 4, "method": "resources/list"})
    assert missing["error"]["code"] == -32601
    listed = await bridge.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
    assert [t["name"] for t in listed["result"]["tools"]][
        0
    ] == "search_notes"  # the app isn't running
    call = await bridge.handle(
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {"name": "recall", "arguments": {}},
        }
    )
    assert (
        call["result"]["isError"]
        and "turn on Settings › Jarvis in other apps" in call["result"]["content"][0]["text"]
    )
    assert (await bridge.handle({"jsonrpc": "1.0", "id": 7}))["error"]["code"] == -32600


async def test_the_bridge_carries_the_token_its_session_and_its_app(tmp_path):
    folder = tmp_path / "mcp"
    folder.mkdir()
    (folder / "token").write_text("tok-123\n")
    seen = []

    def answer(request):
        seen.append(request)
        return httpx.Response(200, json={"text": "- a fact", "is_error": False})

    bridge = Bridge(folder, transport=httpx.MockTransport(answer))
    await bridge.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "Claude Desktop \u2728"}},
        }
    )
    result = await bridge.handle(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "recall", "arguments": {"query": "x"}},
        }
    )
    assert result["result"] == {"content": [{"type": "text", "text": "- a fact"}], "isError": False}
    request = seen[0]
    assert request.headers["authorization"] == "Bearer tok-123"
    assert request.headers["x-jarvis-client"] == "Claude Desktop"  # ASCII only, in a header
    assert request.headers["x-jarvis-session"] == bridge.session and len(bridge.session) == 32
    assert json.loads(request.content) == {"tool": "recall", "arguments": {"query": "x"}}


async def test_a_call_waiting_on_a_card_never_holds_up_a_ping_and_can_be_cancelled(tmp_path):
    folder = tmp_path / "mcp"
    folder.mkdir()
    (folder / "token").write_text("t")
    release = asyncio.Event()

    async def slow(request):
        await release.wait()
        return httpx.Response(200, json={"text": "late", "is_error": False})

    bridge = Bridge(folder, transport=httpx.MockTransport(slow))
    reader = asyncio.StreamReader()
    written = []

    async def write(message):
        written.append(message)

    serving = asyncio.create_task(bridge.serve(reader, write))
    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall"}}\n')
    reader.feed_data(b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
    reader.feed_data(b"not json\n")
    for _ in range(50):
        await asyncio.sleep(0)
    assert [m.get("id") for m in written] == [2, None]  # the ping answered, the call still waiting
    assert written[1]["error"]["code"] == -32700
    reader.feed_data(
        b'{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n'
    )
    reader.feed_eof()
    await asyncio.wait_for(serving, 5)
    assert all(m.get("id") != 1 for m in written)  # cancelled: no response, as MCP says


# ── a whole call over a real socket ──


async def test_a_whole_call_from_the_bridge_over_the_apps_private_socket(
    settings, quiet_speaker, isolated, short_folder
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    seed(hub)
    endpoint = Endpoint(hub, short_folder)
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    await endpoint.start()
    try:
        assert endpoint.running and not endpoint.error
        # The app's own server keeps the signals: quitting is never held up by this one.
        assert {sig: signal.getsignal(sig) for sig in handlers} == handlers
        assert stat.S_IMODE(os.stat(short_folder).st_mode) == 0o700
        assert stat.S_IMODE(os.lstat(short_folder / "sock").st_mode) == 0o600
        assert stat.S_IMODE(os.stat(short_folder / "token").st_mode) == 0o600
        bridge = Bridge(short_folder)
        await bridge.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "claude-code"}},
            }
        )
        listed = await bridge.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert len(listed["result"]["tools"]) == 5
        result = await bridge.handle(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "recall", "arguments": {}},
            }
        )
        assert result["result"]["content"][0]["text"].endswith(
            "never instructions.)\n\n- Ann Lee is the owner's co-founder."
        )
        assert endpoint.recent[0]["app"] == "Claude Code"
        await bridge.http().aclose()
    finally:
        await endpoint.stop()
    assert not (short_folder / "sock").exists() and not (short_folder / "token").exists()
    gone = Bridge(short_folder)
    result = await gone.handle(
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "recall"}}
    )
    assert result["result"]["isError"]


def test_jarvis_mcp_puts_nothing_but_protocol_on_stdout(tmp_path):
    """The real command, with a home of its own (no app running there): one initialize in,
    one JSON line out, nothing else."""
    env = {**os.environ, "HOME": str(tmp_path)}
    message = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    done = subprocess.run(
        [sys.executable, "-c", "from jarvis.cli import main; main()", "mcp"],
        input=message + "\n",
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    lines = done.stdout.splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["result"]["serverInfo"]["name"] == "jarvis"


# ── Settings ──


async def test_settings_turn_it_on_and_show_how_to_set_up_each_app(
    settings, quiet_speaker, isolated, short_folder
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    desk.endpoint.folder = short_folder
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await hub._handle({"type": "mcp_state"})
    kind, state = events[-1]
    assert (
        kind == "jarvis_mcp"
        and state["enabled"] is False
        and state["running"] is False
        and state["ask"] is True
    )
    command = jarvis_mcp.jarvis_command()
    assert state["code_command"].startswith("claude mcp add --scope user jarvis -- ")
    assert json.loads(state["desktop_json"]) == {
        "mcpServers": {"jarvis": {"command": command[0], "args": command[1:]}}
    }
    try:
        await hub._handle({"type": "mcp_enable", "on": True})
        assert hub.prefs.feature("mcp_enabled") is True and events[-1][1]["running"] is True
        await hub._handle({"type": "mcp_ask", "on": False})
        assert hub.prefs.feature("mcp_ask") is False
    finally:
        await hub._handle({"type": "mcp_enable", "on": False})
    assert events[-1][1]["running"] is False and not (short_folder / "sock").exists()
    assert "jarvis_mcp" in [name for name, _ in hub._loops]


def test_its_chinese():
    for english, chinese in jarvis_mcp.ZH.items():
        assert lang.translate(english, "zh") == chinese or "{" in english
