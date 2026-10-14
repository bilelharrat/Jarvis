"""Eden Code's Share live (features/code_share.py): a read-only live view of one session
for a teammate, by a link with a random token, served by the phone companion's server
(remote.py); revoked, expired, counted; everything redacted; and phase 2's suggestions,
which reach the owner as cards and never the session. Real git in a temp repository, a
fake Claude Code, and Starlette's test client in place of a browser."""

import asyncio
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from test_code_changes import make_repo

from jarvis.features import code_share
from jarvis.remote import Devices, create_remote_app

KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0" * 2
AWS = "AKIA" + "ABCDEFGHIJKLMNOP"


class Quiet(FakeClient):
    script = CALENDAR_TURN


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects, tmp_path):
    from test_hub import Transcriber

    from jarvis.hub import Hub

    hub = Hub(
        replace(settings, projects_dir=projects),
        client_factory=Quiet,
        speaker=quiet_speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    # The companion "on": its server isn't started here, the test client stands in for it.
    hub.remote._task = SimpleNamespace(done=lambda: False)
    hub.remote.host_name, hub.remote.port = "studio", 8765
    yield hub
    hub.remote._task = None
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def client_for(hub, tmp_path):
    return TestClient(
        create_remote_app(hub, Devices(tmp_path / "devices.json")),
        raise_server_exceptions=True,
        base_url="https://testserver",
    )


def latest(hub, kind="code_share"):
    found = [d for k, d in hub.events if k == kind]
    return found[-1] if found else None


async def session(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n", ".env": "K=1\n"})
    # In an isolated copy: everything in it is the session's (in a shared folder, only what
    # its own edits wrote would be).
    task = hub.tasks.start("", "proj", mode="ask", title="Fix the login", isolate=True)
    deadline = time.monotonic() + 60
    while not task.workspace and time.monotonic() < deadline:
        await asyncio.sleep(0.02)
    assert task.workspace
    repo = task.cwd
    home = str(Path.home())
    hub.tasks._log(task, "user", "please fix it")
    hub.tasks._log(task, "assistant", f"I used {KEY} from {home}/secret/place")
    hub.tasks._log(task, "thinking", "private thoughts")
    hub.tasks._log(task, "tool", "Read a.py", tool="Read", status="done", output=f"key {AWS}")
    (repo / "a.py").write_text(f"x = 2\naws = '{AWS}'\n")
    (repo / ".env").write_text("K=2\n")
    return task, repo


def share_url(hub):
    shares = latest(hub)["shares"]
    assert shares, latest(hub)
    return shares[-1]["url"]


async def test_a_share_needs_a_session_and_the_companion_on(hub, projects):
    shares = hub.code_share
    assert shares.start({"id": 999}) == "Open a session to share it."
    task, _ = await session(hub, projects)
    hub.remote._task = None
    assert shares.start({"id": task.id}).startswith("Turn on the phone companion in Settings")
    hub.remote._task = SimpleNamespace(done=lambda: False)
    assert shares.start({"id": task.id, "comments": True}) == (
        "Turn on suggestions from viewers in the Share pane first."
    )
    assert shares.shares == {}


async def test_a_viewer_sees_the_session_redacted_and_read_only(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id, "minutes": 15})
    url = share_url(hub)
    assert url.startswith("https://studio.local:8765/share/")
    token = url.rsplit("/", 1)[1]
    assert len(token) >= 30
    share = next(iter(hub.code_share.shares.values()))
    assert 14 * 60 < share.expires - time.time() <= 15 * 60
    client = client_for(hub, tmp_path)
    page = client.get(f"/share/{token}")
    assert page.status_code == 200 and "/share.js" in page.text
    assert page.headers["referrer-policy"] == "no-referrer"
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert client.get("/share.js").status_code == 200
    reply = client.get(f"/share/{token}/state", params={"v": "viewer-one", "since": 0})
    assert reply.status_code == 200
    data = reply.json()
    assert data["title"] == "Fix the login" and data["project"] == "proj"
    text = reply.text
    assert KEY not in text and AWS not in text and str(Path.home()) not in text
    assert "private thoughts" not in text  # the thinking is never shared
    roles = [e["role"] for e in data["entries"]]
    assert "thinking" not in roles and roles[-3:] == ["user", "assistant", "tool"]
    tool = next(e for e in data["entries"] if e["role"] == "tool")
    assert tool["tool"] == "Read" and AWS not in tool["output"]
    files = {f["path"]: f for f in data["changes"]["files"]}
    assert files[".env"]["withheld"] and files[".env"]["hunks"] == []
    lines = [t for h in files["a.py"]["hunks"] for _, t in h["lines"]]
    assert code_share.WITHHELD in lines and "x = 2" in lines
    # The same changes aren't sent again to a viewer that has them.
    again = client.get(
        f"/share/{token}/state",
        params={"v": "viewer-one", "since": data["entries"][-1]["n"], "ck": data["changes_key"]},
    ).json()
    assert again["changes"] is None and again["entries"] == []
    # The owner sees one viewer; a second one makes two.
    assert latest(hub)["shares"][0]["viewers"] == 1
    client.get(f"/share/{token}/state", params={"v": "viewer-two"})
    assert latest(hub)["shares"][0]["viewers"] == 2
    # Nothing to act with: no comments (phase 2 is off), no other method, no other path.
    said = client.post(f"/share/{token}/comment", json={"v": "viewer-one", "text": "hi"})
    assert said.status_code == 403
    assert client.post(f"/share/{token}/state").status_code == 405
    assert client.get(f"/share/{token}/approve").status_code == 404
    assert task.inbox.empty()
    # A viewer without its id, and an unknown token.
    assert client.get(f"/share/{token}/state").status_code == 400
    assert (
        client.get("/share/" + "x" * 32 + "/state", params={"v": "viewer-one"}).status_code == 404
    )
    gone = client.get("/share/" + "x" * 32)
    assert gone.status_code == 404 and "isn’t live" in gone.text


async def test_revoked_and_expired_shares_stop_at_once(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    client = client_for(hub, tmp_path)
    hub.code_share.cmd_start({"id": task.id})
    first = share_url(hub).rsplit("/", 1)[1]
    hub.code_share.cmd_start({"id": task.id, "minutes": 99999})  # an odd time: the default
    second_share = latest(hub)["shares"][-1]
    second = second_share["url"].rsplit("/", 1)[1]
    assert 59 * 60 < second_share["expires"] - time.time() <= 60 * 60
    assert client.get(f"/share/{first}/state", params={"v": "viewer-one"}).status_code == 200
    hub.code_share.cmd_revoke({"share": latest(hub)["shares"][0]["share"]})
    assert client.get(f"/share/{first}/state", params={"v": "viewer-one"}).status_code == 404
    assert len(latest(hub)["shares"]) == 1
    hub.code_share.shares[second_share["share"]].expires = time.time() - 1
    assert client.get(f"/share/{second}/state", params={"v": "viewer-one"}).status_code == 404
    hub.code_share.cmd_state({})
    assert latest(hub)["shares"] == []


async def test_viewers_are_capped_and_rate_limited(hub, projects, tmp_path, monkeypatch):
    task, _ = await session(hub, projects)
    monkeypatch.setattr(code_share, "MAX_VIEWERS", 1)
    hub.code_share.cmd_start({"id": task.id})
    token = share_url(hub).rsplit("/", 1)[1]
    client = client_for(hub, tmp_path)
    assert client.get(f"/share/{token}/state", params={"v": "viewer-one"}).status_code == 200
    assert client.get(f"/share/{token}/state", params={"v": "viewer-two"}).status_code == 429
    share = next(iter(hub.code_share.shares.values()))
    share.viewers["viewer-one"] = time.monotonic() - code_share.VIEWER_SECONDS - 1  # gone quiet
    assert client.get(f"/share/{token}/state", params={"v": "viewer-two"}).status_code == 200
    codes = {
        client.get(f"/share/{token}/state", params={"v": "viewer-two"}).status_code
        for _ in range(code_share.RATES["view"][1] + 2)
    }
    assert 429 in codes


async def test_suggestions_come_to_the_owner_as_cards_never_to_the_session(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({code_share.PREF_COMMENTS: True})
    hub.code_share.cmd_start({"id": task.id, "comments": True})
    token = share_url(hub).rsplit("/", 1)[1]
    client = client_for(hub, tmp_path)
    state = client.get(f"/share/{token}/state", params={"v": "viewer-one"}).json()
    assert state["comments"] is True
    before = len(task.transcript)
    reply = client.post(
        f"/share/{token}/comment",
        json={"v": "viewer-one", "name": " Alex‮ ", "text": "  try the cache first  "},
    )
    assert reply.status_code == 200
    event = latest(hub, "code_share_comment")
    assert event["id"] == task.id
    assert event["comment"]["name"] == "Alex" and event["comment"]["text"] == "try the cache first"
    assert latest(hub)["shares"][0]["comments"][0]["text"] == "try the cache first"
    assert latest(hub, "caption")["text"] == "Alex left a suggestion on Fix the login."
    assert task.inbox.empty() and len(task.transcript) == before  # never sent to the session
    assert (
        client.post(f"/share/{token}/comment", json={"v": "viewer-one", "text": " "}).status_code
        == 400
    )
    # The owner dismisses it; with the switch off, no more come in.
    hub.code_share.cmd_dismiss({"share": latest(hub)["shares"][0]["share"],
                                "comment": event["comment"]["id"]})  # fmt: skip
    assert latest(hub)["shares"][0]["comments"] == []
    hub.set_feature_prefs({code_share.PREF_COMMENTS: False})
    off = client.post(f"/share/{token}/comment", json={"v": "viewer-one", "text": "again"})
    assert off.status_code == 403


def test_the_companion_app_serves_other_features_pages_only_when_given(tmp_path):
    from test_remote import FakeHub

    plain = TestClient(create_remote_app(FakeHub(), Devices(tmp_path / "d.json")))
    assert plain.get("/share/" + "x" * 32).status_code == 404
    hub = FakeHub()
    hub.remote_routes = "not a list"  # (a stand-in hub's odd attribute is ignored)
    assert (
        TestClient(create_remote_app(hub, Devices(tmp_path / "e.json"))).get("/").status_code == 200
    )
