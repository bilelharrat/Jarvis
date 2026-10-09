"""Eden Code's MCP manager (codemcp, features.code_mcp): servers read from every scope with
secrets masked, a project's shared ones waiting for approval, adding, removing and signing
in through Claude Code's CLI (faked here), and JARVIS's connectors shared into a session."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import codemcp
from jarvis.codemcp import approve, configured, server_config, shown_command, shown_url
from jarvis.connectors import Connection
from jarvis.features import code_mcp

TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"


def _config(tmp_path, folder):
    state = tmp_path / "home" / ".claude.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({
        "mcpServers": {"github": {"type": "stdio", "command": "npx", "args": ["-y", "server-github", "--token", TOKEN]}},
        "projects": {str(folder): {
            "mcpServers": {"docs": {"type": "http", "url": "https://user:pw@docs.example.com/mcp?key=secret"}},
            "disabledMcpjsonServers": ["refused"],
        }},
    }))  # fmt: skip
    (folder / ".mcp.json").write_text(json.dumps({"mcpServers": {
        "db": {"command": "node", "args": ["db.js", f"--api-key={TOKEN}"]},
        "refused": {"command": "curl", "args": ["x"]},
        "new": {"type": "sse", "url": "https://mcp.example.com/sse"},
        "": {"command": "x"}, "odd": "not a config",
    }}))  # fmt: skip
    (folder / ".claude").mkdir(exist_ok=True)
    (folder / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledMcpjsonServers": ["db"], "model": "sonnet"})
    )
    return state, tmp_path / "home" / ".claude" / "settings.json"


# ── the files ──


def test_servers_are_read_from_every_scope_and_secrets_never_show(tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir()
    state, settings = _config(tmp_path, folder)
    found = {s.name: s for s in configured(folder, state, settings)}
    assert {n: (s.scope, s.approved) for n, s in found.items()} == {
        "db": ("project", True),
        "refused": ("project", False),
        "new": ("project", None),  # waits for the owner's OK
        "docs": ("local", None),
        "github": ("user", None),
    }
    assert TOKEN not in found["github"].target
    assert found["github"].target.startswith("npx -y server-github --token 'ghp_…")
    assert TOKEN not in found["db"].target and "--api-key=ghp_" in found["db"].target
    assert found["docs"].target == "https://docs.example.com/mcp"  # no password, no query
    assert found["new"].kind == "sse"
    assert configured(tmp_path / "nowhere", tmp_path / "missing.json", settings) == []
    (tmp_path / "home" / ".claude.json").write_text("{damaged")
    assert [s.name for s in configured(folder, state, settings)] == ["db", "refused", "new"]


def test_the_shown_command_masks_what_looks_like_a_secret():
    assert shown_command("npx", ["-y", "srv"]) == "npx -y srv"
    shown = shown_command("srv", ["--password", "hunter2hunter2", "--AUTH_TOKEN=abc", TOKEN])
    assert "hunter2hunter2" not in shown and "--AUTH_TOKEN=abc" not in shown and TOKEN not in shown
    assert shown.startswith("srv --password ")
    assert (
        shown_url("not a url") == ""
        and shown_url("http://localhost:3000/mcp?x=1") == "http://localhost:3000/mcp"
    )


def test_a_new_server_is_a_command_or_an_address_and_never_a_secret():
    assert server_config("command", "npx -y 'my server'") == {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "my server"],
    }
    assert server_config("url", "https://mcp.example.com/mcp") == {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
    }
    assert server_config("url", "http://localhost:9000/sse", "sse")["type"] == "sse"
    for kind, target, why in [
        ("url", "ftp://x.com", "https://"), ("url", "https://me:pw@x.com/mcp", "sign-in"),
        ("command", "npx 'open", "quote"), ("command", "  ", "Type the command"),
    ]:  # fmt: skip
        with pytest.raises(ValueError, match=why):
            server_config(kind, target)


def test_approving_a_shared_server_keeps_the_rest_of_the_settings(tmp_path):
    approve(tmp_path, "db", True)
    path = tmp_path / ".claude" / "settings.local.json"
    assert json.loads(path.read_text()) == {"enabledMcpjsonServers": ["db"]}
    approve(tmp_path, "db", False)
    assert json.loads(path.read_text()) == {"disabledMcpjsonServers": ["db"]}
    path.write_text(json.dumps({"hooks": {}, "enabledMcpjsonServers": "all"}))
    with pytest.raises(OSError, match="can't change"):
        approve(tmp_path, "db", True)
    path.write_text("{not json")
    with pytest.raises(OSError, match="can't be read"):
        approve(tmp_path, "db", True)


# ── in a session ──


class McpStream(Stream):
    """A session that says how its MCP servers are doing, and reconnects one."""

    status: dict = {}

    def __init__(self, options=None):
        super().__init__(options)
        self.reconnected = []

    async def get_mcp_status(self):
        return McpStream.status

    async def reconnect_mcp_server(self, name):
        self.reconnected.append(name)


def _hub(settings, quiet_speaker, isolated, tmp_path):
    folder = tmp_path / "proj"
    folder.mkdir(exist_ok=True)
    Stream.instances = []
    McpStream.status = {}
    hub = make_hub(settings, quiet_speaker, isolated, client=McpStream)
    state, user = _config(tmp_path, folder.resolve())
    hub.code_mcp.state_path, hub.code_mcp.settings_path = state, user
    ran = []

    async def cli(args, cwd, timeout=codemcp.CLI_TIMEOUT):
        ran.append((args, cwd))
        return hub.cli_answer

    hub.cli_answer = (0, "ok")
    hub.code_mcp.run = cli
    return hub, ran


def _last(seen):
    return [e for e in seen() if e["type"] == "cm_state"][-1]


async def _ask(hub, seen, msg):
    """A pane command (it runs in the background) and the answer it brings."""
    before = len([e for e in seen() if e["type"] == "cm_state"])
    await hub._handle(msg)
    assert await until(lambda: len([e for e in seen() if e["type"] == "cm_state"]) > before)
    return _last(seen)


async def test_the_pane_lists_every_server_with_how_it_is_doing(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = _hub(settings, quiet_speaker, isolated, tmp_path)
    McpStream.status = {"mcpServers": [
        {"name": "github", "status": "connected", "tools": [{"name": "a"}, {"name": "b"}]},
        {"name": "docs", "status": "needs-auth"},
        {"name": "db", "status": "failed", "error": "spawn node ENOENT"},
        {"name": "refused", "status": "failed"},
        {"name": "jarvis_browser", "status": "connected", "tools": []},
    ]}  # fmt: skip
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    hub.tasks.set_mcp(task.id, "github", False)
    await _ask(hub, seen, {"type": "cm_state", "id": task.id})
    state = _last(seen)
    rows = {r["name"]: r for r in state["servers"]}
    assert (
        rows["github"]["tools"] == 2 and rows["github"]["off"] and rows["github"]["scope"] == "user"
    )
    assert rows["docs"]["status"] == "needs-auth" and rows["db"]["error"] == "spawn node ENOENT"
    assert rows["new"]["approved"] is None and rows["refused"]["approved"] is False
    assert len(state["servers"]) == len(rows)  # each once
    assert rows["jarvis_browser"]["scope"] == "other" and not rows["jarvis_browser"]["removable"]
    assert state["live"] and state["name"] == "proj" and state["connectors"] == []
    await end_all(hub)


async def test_adding_and_removing_go_through_claude_code_and_reopen_the_session(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, ran = _hub(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    await _ask(
        hub,
        seen,
        {"type": "cm_add", "id": task.id, "name": "bad name!", "kind": "command", "target": "x"},
    )
    assert "letters, digits" in _last(seen)["error"] and ran == []
    await _ask(
        hub,
        seen,
        {"type": "cm_add", "id": task.id, "name": "fs", "kind": "url", "target": "ftp://x"},
    )
    assert "https://" in _last(seen)["error"] and ran == []
    add = {"type": "cm_add", "id": task.id, "name": "fs", "scope": "project", "kind": "command",
           "target": "npx -y @modelcontextprotocol/server-filesystem ."}  # fmt: skip
    hub.cli_answer = (1, "some detail\nError: MCP server fs already exists in project config")
    await _ask(hub, seen, add)
    assert _last(seen)["error"] == (
        "Claude Code didn't add it: Error: MCP server fs already exists in project config"
    )
    hub.cli_answer = (0, "Added stdio MCP server fs")
    await _ask(hub, seen, add)
    args, cwd = ran[-1]
    assert args[:3] == ["mcp", "add-json", "fs"] and args[4:] == ["--scope", "project"]
    assert json.loads(args[3]) == {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    }
    assert cwd == task.cwd
    local = json.loads((task.cwd / ".claude" / "settings.local.json").read_text())
    assert "fs" in local["enabledMcpjsonServers"] and local["model"] == "sonnet"
    assert await until(lambda: len(Stream.instances) == 2, 600)  # reopened: it has it
    assert code_mcp.ADDED.format(name="fs") in [e["text"] for e in task.transcript]
    await _ask(hub, seen, {"type": "cm_remove", "id": task.id, "name": "github", "scope": "user"})
    assert ran[-1][0] == ["mcp", "remove", "github", "--scope", "user"]
    assert await until(lambda: len(Stream.instances) == 3, 600)
    await end_all(hub)


async def test_signing_in_runs_claude_code_s_own_sign_in_then_reconnects(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, ran = _hub(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    done = asyncio.Event()

    async def login(args, cwd, timeout=codemcp.CLI_TIMEOUT):
        ran.append((args, cwd, timeout))
        await done.wait()  # (the browser, meanwhile)
        return 0, "Authentication successful"

    hub.code_mcp.run = login
    await _ask(hub, seen, {"type": "cm_login", "id": task.id, "name": "docs"})
    assert _last(seen)["signing"] == ["docs"]
    await _ask(hub, seen, {"type": "cm_login", "id": task.id, "name": "docs"})  # once at a time
    assert (
        len(ran) == 1
        and ran[0][0] == ["mcp", "login", "docs"]
        and ran[0][2] == codemcp.LOGIN_TIMEOUT
    )
    done.set()
    assert await until(lambda: _last(seen)["signing"] == [] and _last(seen).get("note"))
    assert _last(seen)["note"] == "Signed in to docs." and Stream.instances[0].reconnected == [
        "docs"
    ]
    await _ask(hub, seen, {"type": "cm_reconnect", "id": task.id, "name": "db"})
    assert Stream.instances[0].reconnected == ["docs", "db"]
    await end_all(hub)


async def test_a_project_s_shared_server_runs_only_once_the_owner_approves_it(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = _hub(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    await _ask(hub, seen, {"type": "cm_approve", "id": task.id, "name": "new", "approve": True})
    rows = {r["name"]: r for r in _last(seen)["servers"]}
    assert rows["new"]["approved"] is True
    assert await until(lambda: len(Stream.instances) == 2, 600)
    await _ask(hub, seen, {"type": "cm_approve", "id": task.id, "name": "db", "approve": False})
    rows = {r["name"]: r for r in _last(seen)["servers"]}
    assert rows["db"]["approved"] is False
    assert [r["name"] for r in _last(seen)["servers"]].count("db") == 1
    await end_all(hub)


async def test_a_connector_shared_into_a_session_brings_its_tools(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = _hub(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    conn = Connection(
        id="github", name="GitHub", kind="http", url="https://api.githubcopilot.com/mcp/"
    )
    hub.connectors.connections["github"] = conn
    hub.connectors.live["github"] = SimpleNamespace(status="connected")
    server = object()
    hub.connectors.build_servers = lambda: (
        {"acct_github": server, "acct_other": object()},
        ["mcp__acct_github__get_issue", "mcp__acct_other__read"],
    )
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    assert "acct_github" not in (Stream.instances[0].options.mcp_servers or {})  # off by default
    await _ask(hub, seen, {"type": "cm_share", "id": task.id, "connector": "github", "on": True})
    assert _last(seen)["connectors"] == [
        {"id": "github", "name": "GitHub", "status": "connected", "on": True}
    ]
    assert await until(lambda: len(Stream.instances) == 2, 600)
    options = Stream.instances[1].options
    assert options.mcp_servers["acct_github"] is server and "acct_other" not in options.mcp_servers
    assert "mcp__acct_github__get_issue" in options.allowed_tools
    assert "mcp__acct_other__read" not in options.allowed_tools
    await _ask(hub, seen, {"type": "cm_share", "id": task.id, "connector": "github", "on": False})
    assert await until(lambda: len(Stream.instances) == 3, 600)
    assert "acct_github" not in (Stream.instances[2].options.mcp_servers or {})
    await end_all(hub)


def test_its_transcript_notes_have_chinese_in_the_window():
    import re

    from jarvis.server import zh_strings

    zh = zh_strings()
    notes = [code_mcp.ADDED, code_mcp.REMOVED, code_mcp.APPROVED, code_mcp.REFUSED,
             code_mcp.SHARED, code_mcp.UNSHARED, code_mcp.SIGNED_IN]  # fmt: skip
    for note in notes:
        text = note.format(name="my-server")
        assert text in zh["strings"] or any(re.fullmatch(p, text) for p, _ in zh["patterns"]), text
