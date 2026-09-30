"""The connector activity log (jarvis.connector_log, wired into connectors.py), the new catalog
entries and Google Calendar's write access. No connector is reached: the MCP session and the
approval are fakes."""

from __future__ import annotations

import json
import types
from datetime import datetime, timedelta

import pytest
from conftest import FakeClient

from jarvis import connector_log, connectors
from jarvis.connector_log import ConnectorLog
from jarvis.connectors import CATALOG_BY_ID, Connection, ConnectorManager, Live, MemoryVault
from jarvis.hub import Hub


def test_each_call_is_a_line_without_its_contents(tmp_path):
    log = ConnectorLog(tmp_path / "activity.jsonl", clock=lambda: datetime(2026, 9, 30, 9, 15))
    log.add("Notion", "notion-search", "read", "done")
    log.add("GitHub", "create_issue", "write", "declined")
    lines = [json.loads(line) for line in (tmp_path / "activity.jsonl").read_text().splitlines()]
    assert lines[0] == {
        "at": "2026-09-30T09:15:00",
        "service": "Notion",
        "tool": "notion-search",
        "kind": "read",
        "outcome": "done",
    }
    assert oct((tmp_path / "activity.jsonl").stat().st_mode & 0o777) == "0o600"
    assert [e["tool"] for e in log.recent()] == ["create_issue", "notion-search"]  # newest first
    assert [e["tool"] for e in ConnectorLog(tmp_path / "activity.jsonl").recent()] == [
        "create_issue",
        "notion-search",
    ]


def test_a_damaged_line_is_skipped_not_the_rest(tmp_path):
    path = tmp_path / "activity.jsonl"
    good = {
        "at": "2026-09-30T09:00:00",
        "service": "Linear",
        "tool": "list_issues",
        "kind": "read",
        "outcome": "done",
    }
    path.write_text(
        json.dumps(good) + "\n{torn\n" + json.dumps({**good, "kind": "delete"}) + "\n[1]\n"
    )
    assert ConnectorLog(path).recent() == [good]


def test_junk_of_any_size_never_stops_the_start(tmp_path, monkeypatch):
    path = tmp_path / "activity.jsonl"
    good = {
        "at": "2026-09-30T09:00:00",
        "service": "Linear",
        "tool": "list_issues",
        "kind": "read",
        "outcome": "done",
    }
    path.write_bytes(
        b"[" * 100_000 + b"]" * 100_000 + b"\n\xff\xfe{\n" + json.dumps(good).encode() + b"\n"
    )
    assert ConnectorLog(path).recent() == [good]
    monkeypatch.setattr(connector_log, "READ_LIMIT", 1000)  # only the tail is read
    path.write_text("x" * 5000 + "\n" + json.dumps(good) + "\n")
    assert ConnectorLog(path).recent() == [good]


def test_it_keeps_only_so_much(tmp_path, monkeypatch):
    monkeypatch.setattr(connector_log, "KEEP", 5)
    clock = [datetime(2026, 9, 1)]
    log = ConnectorLog(tmp_path / "activity.jsonl", clock=lambda: clock[0])
    log.add("Old", "t", "read", "done")
    clock[0] += timedelta(days=100)
    for n in range(12):
        log.add("Notion", f"t{n}", "read", "done")
    kept = [
        json.loads(line)["tool"] for line in (tmp_path / "activity.jsonl").read_text().splitlines()
    ]
    assert "t" not in kept and len(kept) <= 10  # compacted to the last 5, then 5 more at most
    assert kept[-1] == "t11"


class FakeSession:
    def __init__(self, error=False, boom=False):
        self.error, self.boom = error, boom

    async def call_tool(self, name, arguments):
        if self.boom:
            raise RuntimeError("connection reset")
        return types.SimpleNamespace(
            content=[types.SimpleNamespace(type="text", text="secret contents")],
            structured_content=None,
            is_error=self.error,
        )


def tool(name, read_only):
    return types.SimpleNamespace(
        name=name, title=None, annotations=types.SimpleNamespace(read_only_hint=read_only)
    )


@pytest.fixture
def manager(tmp_path):
    events = []
    answers = {"choice": "deny"}

    async def approve(question, detail, choices):
        return answers["choice"]

    m = ConnectorManager(
        lambda kind, **data: events.append((kind, data)),
        approve,
        vault=MemoryVault(),
        store=tmp_path / "connections.json",
    )
    conn = Connection(id="notion", name="Notion", kind="http", url="https://mcp.notion.com/mcp")
    m.connections["notion"] = conn
    live = Live(conn, m)
    live.tools = [tool("search", True), tool("create_page", False)]
    live.session = FakeSession()
    m.live["notion"] = live
    m.events, m.answers = events, answers
    return m


async def test_every_call_is_logged_read_or_change(manager):
    live = manager.live["notion"]
    await live.call("search", {"query": "board minutes"})
    await live.call("create_page", {"title": "private title"})
    live.session = FakeSession(error=True)
    await live.call("create_page", {})
    live.session = FakeSession(boom=True)
    await live.call("search", {})
    items = manager.activity.recent()
    assert [(e["tool"], e["kind"], e["outcome"]) for e in items] == [
        ("search", "read", "failed"),
        ("create_page", "write", "failed"),
        ("create_page", "write", "done"),
        ("search", "read", "done"),
    ]
    raw = manager.activity.path.read_text()
    assert "board minutes" not in raw and "private title" not in raw and "secret" not in raw
    assert manager.events[-1][0] == "connector_activity"


async def test_a_declined_call_is_logged_too(manager):
    allowed = await manager.gate("mcp__acct_notion__create_page", {"title": "x"})
    assert allowed is False
    assert manager.activity.recent()[0]["outcome"] == "declined"


def test_the_new_catalog_entries():
    assert CATALOG_BY_ID["slack"].url == "https://mcp.slack.com/mcp"
    assert (
        CATALOG_BY_ID["slack"].auth == "own_app"
        and connectors.REDIRECT_URI in CATALOG_BY_ID["slack"].help
    )
    assert CATALOG_BY_ID["figma"].url == "https://mcp.figma.com/mcp"
    assert "127.0.0.1:3845" in CATALOG_BY_ID["figma"].help


async def test_google_calendar_asks_for_write_access_and_old_sign_ins_are_told(
    manager, monkeypatch
):
    scope = CATALOG_BY_ID["gcal"].scope
    assert "calendar.events.readonly" not in scope and scope.endswith("/calendar.events")
    old = Connection(
        id="gcal",
        name="Google Calendar",
        kind="http",
        url=CATALOG_BY_ID["gcal"].url,
        auth="own_app",
        scope="https://www.googleapis.com/auth/calendar.events.readonly",
    )
    manager.connections["gcal"] = old
    shown = {c["id"]: c for c in manager.public()["connections"]}
    assert shown["gcal"]["rescope"] is True and shown["notion"]["rescope"] is False
    monkeypatch.setattr(manager, "_start", lambda conn: None)
    await manager.connect("gcal", client_id="id.apps.googleusercontent.com", client_secret="s")
    assert manager.connections["gcal"].scope == scope
    client = json.loads(manager.vault.get("gcal", "oauth_client"))
    assert client["scope"] == scope


async def test_the_window_asks_for_the_activity(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.connectors.activity.add("Notion", "search", "read", "done")
    events = hub.subscribe()
    await hub._handle({"type": "connector_activity"})
    ev = events.get_nowait()
    assert ev["type"] == "connector_activity" and ev["items"][0]["service"] == "Notion"
