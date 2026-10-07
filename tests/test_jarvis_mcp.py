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
        "calendar_create",
        "calendar_update",
        "calendar_delete",
        "notify_me",
        "mail_accounts",
        "mail_search",
        "mail_read",
        "mail_draft",
        "mail_send",
        "memory_list",
        "memory_update",
        "memory_delete",
        "memory_toggle",
        "commitments",
        "meetings_list",
        "meeting_read",
        "commitment_add",
        "browser_task",
        "browser_task_status",
        "browser_task_stop",
        "browser_view",
        "actions_list",
        "action_undo",
        "files_search",
        "file_read",
        "file_summarize",
        "screen_context",
        "knowledge_add_folder",
        "knowledge_list",
        "knowledge_search",
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
    assert (
        cards[0]["question"]
        == "Let Claude Desktop use your second brain, memory, calendar and email?"
    )
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
    assert cards[-1]["question"] == "允许 Claude Code 使用你的第二大脑、记忆、日历和邮件吗？"
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
        assert len(listed["result"]["tools"]) == len(mcp_endpoint.TOOLS)
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
    settings, quiet_speaker, isolated, short_folder, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    desk.endpoint.folder = short_folder
    pretend_apps(desk, short_folder.parent, monkeypatch)
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


# ── approve once per app, remembered ──


async def answer_card(hub, choice):
    for _ in range(200):
        await asyncio.sleep(0)
        if hub.approvals:
            card = next(iter(hub.approvals.values()))
            assert hub.resolve(card["id"], choice)
            return card
    raise AssertionError("no card went up")


async def test_always_allow_remembers_the_app_across_sessions_and_restarts(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    allowed, card = await asyncio.gather(
        endpoint.session_ok(SESSION, "Claude Code"), answer_card(hub, "always")
    )
    assert allowed and card["mcp_app"] == "Claude Code"
    assert [c["id"] for c in card["choices"]] == ["always", "allow", "deny"]
    assert [c["label"] for c in card["choices"]] == ["Always allow", "Allow this time", "Not now"]
    assert hub.prefs.feature("mcp_trusted") == ["Claude Code"]
    restarted = endpoint_for(hub)  # a new run: no sessions in memory, the pref kept
    assert await restarted.session_ok("b" * 16, "Claude Code") and not hub.approvals
    assert restarted.public()["trusted"] == ["Claude Code"]
    # "Allow this time" is this session only
    once, _ = await asyncio.gather(
        restarted.session_ok("c" * 16, "Claude Desktop"), answer_card(hub, "allow")
    )
    assert once and hub.prefs.feature("mcp_trusted") == ["Claude Code"]
    # Forgotten from Settings: it asks again
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.jarvis_mcp.endpoint = restarted
    await hub._handle({"type": "mcp_forget", "app": "Claude Code"})
    assert hub.prefs.feature("mcp_trusted") == [] and events[-1][1]["trusted"] == []
    denied, _ = await asyncio.gather(
        restarted.session_ok("d" * 16, "Claude Code"), answer_card(hub, "deny")
    )
    assert denied is False
    # Asking off still means never asking
    hub.set_feature_prefs({"mcp_ask": False})
    assert await restarted.session_ok("e" * 16, "Someone else") and not hub.approvals


def test_remembered_apps_are_kept_clean():
    from jarvis.prefs import FEATURE_PREFS

    cleaner = FEATURE_PREFS["mcp_trusted"][1]
    assert cleaner(["claude-code", "Claude Code", "  ", 3, "x\ny"]) == ["Claude Code", "xy"]
    assert cleaner("Claude Code") is None


# ── one-click connect ──


def pretend_apps(desk, root, monkeypatch, code_cli=True, desktop=True):
    """Both apps' settings in a temp folder: never the owner's real files."""
    support = root / "Claude"
    if desktop:
        support.mkdir(parents=True, exist_ok=True)
    desk.desktop_path = support / "claude_desktop_config.json"
    desk.desktop_apps = ()
    desk.code_state = root / ".claude.json"
    desk.apps = {}
    monkeypatch.setattr(
        jarvis_mcp.codemcp, "cli_path", lambda: "/pretend/claude" if code_cli else None
    )

    async def no_cli(args, cwd, timeout=0):  # a test that didn't set one up never runs the CLI
        raise AssertionError(f"claude {args} ran")

    monkeypatch.setattr(jarvis_mcp.codemcp, "run_cli", no_cli)


async def test_connect_claude_desktop_keeps_everything_else(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    pretend_apps(desk, tmp_path, monkeypatch)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    path = desk.desktop_path
    original = {
        "globalShortcut": "Alt+Space",
        "mcpServers": {"files": {"command": "npx", "args": ["fs"]}},
    }
    path.write_text(json.dumps(original))
    await hub._handle({"type": "mcp_state"})
    assert events[-1][1]["apps"]["desktop"]["status"] == "off"
    await hub._handle({"type": "mcp_connect", "app": "desktop"})
    saved = json.loads(path.read_text())
    assert (
        saved["globalShortcut"] == "Alt+Space" and saved["mcpServers"]["files"]["command"] == "npx"
    )
    command = jarvis_mcp.jarvis_command()
    assert saved["mcpServers"]["jarvis"] == {"command": command[0], "args": command[1:]}
    desktop = events[-1][1]["apps"]["desktop"]
    assert desktop["status"] == "connected" and "Restart Claude Desktop" in desktop["message"]
    backup = path.with_name(path.name + ".bak")
    assert json.loads(backup.read_text()) == original
    await hub._handle({"type": "mcp_disconnect", "app": "desktop"})
    assert json.loads(path.read_text()) == original
    assert json.loads(backup.read_text()) == original  # the first copy, kept
    assert events[-1][1]["apps"]["desktop"]["status"] == "off"
    assert [
        p.name for p in tmp_path.joinpath("Claude").iterdir() if p.name.startswith(".jarvis-")
    ] == []


async def test_a_desktop_config_that_isnt_json_is_left_alone(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    pretend_apps(desk, tmp_path, monkeypatch)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    desk.desktop_path.write_text('{"mcpServers": {')
    await hub._handle({"type": "mcp_connect", "app": "desktop"})
    assert desk.desktop_path.read_text() == '{"mcpServers": {'
    assert "isn't valid JSON" in events[-1][1]["apps"]["desktop"]["message"]
    assert not desk.desktop_path.with_name("claude_desktop_config.json.bak").exists()
    # No file yet: made with just Jarvis
    desk.desktop_path.unlink()
    await hub._handle({"type": "mcp_connect", "app": "desktop"})
    assert list(json.loads(desk.desktop_path.read_text())["mcpServers"]) == ["jarvis"]


async def test_connect_claude_code_through_its_own_cli(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    pretend_apps(desk, tmp_path, monkeypatch)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    ran = []
    command = jarvis_mcp.jarvis_command()

    async def cli(args, cwd, timeout=0):  # what the real CLI does to ~/.claude.json
        ran.append(args)
        state = json.loads(desk.code_state.read_text()) if desk.code_state.exists() else {}
        servers = state.setdefault("mcpServers", {})
        if args[:2] == ["mcp", "add"]:
            servers[args[4]] = {"type": "stdio", "command": args[6], "args": args[7:], "env": {}}
        else:
            servers.pop(args[4], None)
        desk.code_state.write_text(json.dumps(state))
        return 0, "done"

    monkeypatch.setattr(jarvis_mcp.codemcp, "run_cli", cli)
    desk.code_state.write_text(
        json.dumps({"mcpServers": {"jarvis": {"command": "/old/jarvis", "args": ["mcp"]}}})
    )
    await hub._handle({"type": "mcp_state"})
    assert events[-1][1]["apps"]["code"]["status"] == "other"
    await hub._handle({"type": "mcp_connect", "app": "code"})
    assert ran == [
        ["mcp", "remove", "--scope", "user", "jarvis"],
        ["mcp", "add", "--scope", "user", "jarvis", "--", *command],
    ]
    assert events[-1][1]["apps"]["code"]["status"] == "connected"
    ran.clear()
    await hub._handle({"type": "mcp_connect", "app": "code"})  # already there: nothing runs
    assert ran == []
    await hub._handle({"type": "mcp_disconnect", "app": "code"})
    assert ran == [["mcp", "remove", "--scope", "user", "jarvis"]]
    assert events[-1][1]["apps"]["code"]["status"] == "off"

    async def fails(args, cwd, timeout=0):
        return 1, "claude: something went wrong"

    monkeypatch.setattr(jarvis_mcp.codemcp, "run_cli", fails)
    await hub._handle({"type": "mcp_connect", "app": "code"})
    assert events[-1][1]["apps"]["code"] == {
        "status": "off",
        "message": "claude: something went wrong",
    }


async def test_an_app_not_installed_says_so(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.jarvis_mcp
    pretend_apps(desk, tmp_path, monkeypatch, code_cli=False, desktop=False)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await hub._handle({"type": "mcp_state"})
    apps = events[-1][1]["apps"]
    assert apps["code"]["status"] == "missing" and apps["desktop"]["status"] == "missing"
