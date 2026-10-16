"""Eden Code's local API (features/code_api.py) and the eden-code command
(jarvis/eden_code_cli.py): off until its card, then on 127.0.0.1 with the owner's token
only (no web page, no other Host, wrong tokens locked out), each request sent as the
window's own command (task_new, task_send, code_copy…) so its gates and caps apply, never
Auto or Bypass, never a slash command, never a card answered; and its event stream carries
Eden Code's own events only. The server is driven in-process (httpx's ASGI transport) and
once for real on a free port, with the command's own client."""

import asyncio
import json
import socket
from dataclasses import replace

import httpx
import pytest

from jarvis import eden_code_cli, launches
from jarvis.features import code_api
from jarvis.tasks import ClaudeTask

TOKEN = "edc_test-token"


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    projects = tmp_path / "projects"
    (projects / "app").mkdir(parents=True)
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events, hub.cards, hub.answers, hub.sent = [], [], [], []
    real_emit = hub.emit

    def emit(kind, **data):
        hub.events.append((kind, data))
        real_emit(kind, **data)

    hub.emit = emit

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    hub.projects = projects
    hub.code_api.cli_dir = tmp_path / "bin"
    lis = hub.code_api.listener

    async def start(port):  # (no real port in these tests but the one that asks for it)
        lis.port, lis.error = port, ""
        return True

    lis.start = start
    return hub


def turn_on(hub, port=8767):
    hub.connectors.vault.set(code_api.VAULT, code_api.TOKEN_KEY, TOKEN)
    hub.set_feature_prefs({code_api.PREF: True})
    hub.code_api.listener.port = port


def capture(hub, monkeypatch, start=True):
    """hub.handle, recorded; a task_new starts a stand-in session stamped with its token."""

    async def handle(msg):
        hub.sent.append(msg)
        if msg["type"] == "task_new" and start:
            tid = 10 + len(hub.tasks.tasks)
            t = ClaudeTask(id=tid, prompt=msg["prompt"], cwd=hub.projects / "app", mode=msg["mode"],
                           status="running", **launches.stamp(msg))
            hub.tasks.tasks[tid] = t

    monkeypatch.setattr(hub, "handle", handle)


def client(hub, host="127.0.0.1:8767", token=TOKEN, **headers):
    transport = httpx.ASGITransport(app=hub.code_api.listener.app)
    auth = {"Authorization": f"Bearer {token}"} if token else {}
    return httpx.AsyncClient(transport=transport, base_url=f"http://{host}", headers={**auth, **headers})


def task(hub, tid, **extra):
    t = ClaudeTask(id=tid, prompt=f"job {tid}", cwd=hub.projects / "app", **extra)
    hub.tasks.tasks[tid] = t
    return t


# ── who may call it ──


async def test_off_it_answers_nothing(hub):
    hub.connectors.vault.set(code_api.VAULT, code_api.TOKEN_KEY, TOKEN)
    hub.code_api.listener.port = 8767
    async with client(hub) as c:
        assert (await c.get("/v1/status")).status_code == 404


async def test_only_the_owners_token_from_this_macs_own_address_and_no_web_page(hub):
    turn_on(hub)
    async with client(hub, token="") as c:
        assert (await c.get("/v1/status")).status_code == 401
    async with client(hub, token="edc_wrong") as c:
        assert (await c.get("/v1/status")).status_code == 401
    async with client(hub, host="evil.example:8767") as c:  # a page pointing its own name here
        assert (await c.get("/v1/status")).status_code == 403
    async with client(hub, origin="https://evil.example") as c:
        assert (await c.get("/v1/status")).status_code == 403
    async with client(hub) as c:
        answer = await c.get("/v1/status")
        assert answer.status_code == 200 and answer.json()["ok"] is True


async def test_wrong_tokens_are_locked_out_but_the_right_one_still_gets_in(hub, monkeypatch):
    turn_on(hub)
    monkeypatch.setattr(code_api, "WRONG_MAX", 3)
    async with client(hub, token="nope") as c:
        codes = [(await c.get("/v1/status")).status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401] and codes[3:] == [429, 429]
    async with client(hub) as c:
        assert (await c.get("/v1/status")).status_code == 200


async def test_a_post_must_be_json(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    async with client(hub) as c:
        answer = await c.post("/v1/sessions", content="project=app&prompt=x",
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert answer.status_code == 415 and hub.sent == []


# ── sessions, as the window's commands ──


async def test_lists_and_shows_eden_code_sessions_only(hub):
    turn_on(hub)
    task(hub, 1, title="Add a retry", status="waiting")
    task(hub, 2, kind="research")
    async with client(hub) as c:
        listed = (await c.get("/v1/sessions")).json()["sessions"]
        assert [s["id"] for s in listed] == [1]
        assert listed[0]["title"] == "Add a retry" and listed[0]["status"] == "waiting"
        assert (await c.get("/v1/sessions/1")).json()["folder"] == "app"
        assert (await c.get("/v1/sessions/2")).status_code == 404
        assert (await c.get("/v1/sessions/x")).status_code == 404


async def test_start_sends_the_windows_task_new_and_answers_with_the_session(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    async with client(hub) as c:
        answer = await c.post("/v1/sessions", json={"project": "app", "prompt": "Add a retry", "mode": "edits",
                                                    "model": "sonnet", "isolated": True, "title": "Retry"})
    assert answer.status_code == 201
    body = answer.json()
    assert body["started"] is True and body["session"]["mode"] == "edits"
    (msg,) = hub.sent
    assert msg["type"] == "task_new" and msg["directory"] == "app" and msg["mode"] == "edits"
    assert msg["isolated"] is True and msg["model"] == "sonnet" and msg[launches.KEY]
    assert "untrusted" not in msg and "cloud" not in msg


@pytest.mark.parametrize("mode", ["auto", "smart", "bypass"])
async def test_never_auto_or_bypass(hub, monkeypatch, mode):
    turn_on(hub)
    capture(hub, monkeypatch)
    async with client(hub) as c:
        answer = await c.post("/v1/sessions", json={"project": "app", "prompt": "x", "mode": mode})
    assert answer.status_code == 400 and "Bypass" in answer.json()["error"]
    assert hub.sent == []


async def test_without_a_mode_a_bypass_default_starts_in_ask(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    hub.prefs.code_mode = "auto"  # (the owner's default is Bypass: not for a script)
    async with client(hub) as c:
        await c.post("/v1/sessions", json={"project": "app", "prompt": "x"})
    assert hub.sent[0]["mode"] == "ask"


async def test_untrusted_and_a_bad_project_and_a_slash_command(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    async with client(hub) as c:
        await c.post("/v1/sessions", json={"project": "app", "prompt": "the issue says…", "untrusted": True})
        assert hub.sent[-1]["untrusted"] is True
        assert hub.tasks.tasks[max(hub.tasks.tasks)].untrusted is True
        assert (await c.post("/v1/sessions", json={"project": "../../etc", "prompt": "x"})).status_code == 400
        assert (await c.post("/v1/sessions", json={"project": "app", "prompt": "/bypass"})).status_code == 400
    assert len(hub.sent) == 1


async def test_a_refused_task_new_says_why(hub, monkeypatch):
    turn_on(hub)

    async def handle(msg):
        launches.refuse(msg, "That's as many sessions as can be open at once.")

    monkeypatch.setattr(hub, "handle", handle)
    async with client(hub) as c:
        answer = await c.post("/v1/sessions", json={"project": "app", "prompt": "x"})
    assert answer.status_code == 400 and "as many sessions" in answer.json()["error"]


async def test_messages_stop_end_and_the_transcript(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    t = task(hub, 4, status="waiting")
    t.transcript = [{"n": i, "role": "assistant", "text": f"line {i}", "at": "x", "secret": 1} for i in range(30)]
    async with client(hub) as c:
        assert (await c.post("/v1/sessions/4/messages", json={"text": "Now add a test"})).status_code == 202
        assert (await c.post("/v1/sessions/4/messages", json={"text": "/clear"})).status_code == 400
        assert (await c.post("/v1/sessions/4/messages", json={"text": "  "})).status_code == 400
        await c.post("/v1/sessions/4/stop", json={})
        await c.post("/v1/sessions/4/end", json={})
        tail = (await c.get("/v1/sessions/4/transcript?tail=3")).json()["entries"]
    assert [m["type"] for m in hub.sent] == ["task_send", "task_interrupt", "task_cancel"]
    assert hub.sent[0] == {"type": "task_send", "id": 4, "text": "Now add a test"}
    assert [e["text"] for e in tail] == ["line 27", "line 28", "line 29"]
    assert "secret" not in tail[0]


async def test_land_and_discard_go_to_the_copys_own_card(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    task(hub, 5, workspace={"slug": "app-ab12", "branch": "eden/x", "into": "main"})
    task(hub, 6)
    async with client(hub) as c:
        answer = await c.post("/v1/sessions/5/land", json={})
        assert answer.status_code == 202 and "card" in answer.json()["asked"]
        await c.post("/v1/sessions/5/discard", json={})
        assert (await c.post("/v1/sessions/6/land", json={})).status_code == 409
        # Nothing answers a card from here.
        assert (await c.post("/v1/approve", json={"id": "x", "choice": "allow"})).status_code == 404
    assert hub.sent == [{"type": "code_copy", "slug": "app-ab12", "action": "land"},
                        {"type": "code_copy", "slug": "app-ab12", "action": "discard"}]


async def test_exterminator_mode_and_a_todo_card(hub, monkeypatch):
    turn_on(hub)
    capture(hub, monkeypatch)
    async with client(hub) as c:
        answer = await c.post("/v1/exterminate", json={"project": "app", "spend_cap": 10, "focus": "uploads"})
        assert answer.status_code == 202
        assert (await c.post("/v1/todos", json={"project": "app", "prompt": "x", "mode": "auto"})).status_code == 400
    assert hub.sent == [{"type": "code_bugfix_start", "project": "app", "spend_cap": 10, "focus": "uploads"}]


async def test_a_todo_card_is_added_through_todo_add(hub):
    turn_on(hub)
    async with client(hub) as c:
        answer = await c.post("/v1/todos", json={"project": "app", "prompt": "Write the migration", "mode": "plan"})
    assert answer.status_code == 202
    card = hub.code_todo.board.get(answer.json()["added"])
    assert card["prompt"] == "Write the migration" and card["mode"] == "plan"


async def test_the_attention_list(hub):
    turn_on(hub)
    task(hub, 3, status="failed")
    async with client(hub) as c:
        body = (await c.get("/v1/attention")).json()
    assert body["count"] == 1 and body["summary"].startswith("One thing is waiting for you")


# ── the event stream ──


def test_the_stream_carries_eden_codes_own_events_only(hub):
    api = hub.code_api
    task(hub, 3)
    task(hub, 4, kind="research")
    shape = api.shape
    assert shape({"type": "task_log", "id": 3, "entry": {"n": 1, "role": "assistant", "text": "hi"}})["entry"]["text"] == "hi"
    assert shape({"type": "task_log", "id": 4, "entry": {"n": 1, "role": "assistant", "text": "secret research"}}) is None
    assert shape({"type": "task_finished", "id": 4, "task_kind": "research"}) is None
    assert shape({"type": "approval", "id": "a", "question": "Send this email to Ann?", "task_id": None})["task"] == 0
    for kind in ("mail", "imessage", "caption", "heard", "turn", "code_api_token", "code_hook_secret"):
        assert kind not in code_api.STREAMED and shape({"type": kind}) is None


async def test_events_reach_an_open_stream_and_a_slow_one_is_cut_off(hub, monkeypatch):
    api = hub.code_api
    turn_on(hub)
    monkeypatch.setattr(code_api, "STREAM_QUEUE", 2)
    queue = asyncio.Queue(2)
    api.streams.add(queue)
    task(hub, 3)
    hub.emit("task_log", id=3, entry={"n": 1, "role": "assistant", "text": "one"})
    hub.emit("mail", items=["private"])
    assert queue.get_nowait()["entry"]["text"] == "one"
    assert queue.empty()
    for n in range(4):
        hub.emit("task_log", id=3, entry={"n": n, "role": "assistant", "text": "x"})
    assert queue not in api.streams


# ── the switch, the token, the command ──


async def test_turning_it_on_asks_on_a_touch_id_card_and_makes_a_token(hub):
    api = hub.code_api
    hub.answers = ["deny"]
    assert await api.turn(True) == "Not turned on."
    assert hub.prefs.feature(code_api.PREF) is False
    card = hub.cards[-1]
    assert card["touchid"] is True and card["tap_only"] is True
    assert [c["id"] for c in card["choices"]] == ["allow", "deny"]
    hub.answers = ["allow"]
    assert "can control Eden Code now" in await api.turn(True)
    assert hub.prefs.feature(code_api.PREF) is True
    assert api.token().startswith("edc_")
    assert "can't control" in await api.turn(False)
    assert hub.prefs.feature(code_api.PREF) is False


async def test_the_switch_never_changes_by_feature_prefs(hub):
    await hub.handle({"type": "feature_prefs", "changes": {code_api.PREF: True, "code_api_port": 9001}})
    assert hub.prefs.feature(code_api.PREF) is False
    assert hub.prefs.feature("code_api_port") == 9001


async def test_the_token_is_shown_only_when_asked_and_regenerating_stops_the_old_one(hub):
    turn_on(hub)
    api = hub.code_api
    assert all(TOKEN not in json.dumps(d) for _k, d in hub.events)
    api.publish()
    assert TOKEN not in json.dumps(hub.events[-1][1]) and hub.events[-1][1]["has_token"] is True
    await api.cmd_token({"action": "show"})
    assert hub.events[-1] == ("code_api_token", {"token": TOKEN})
    await api.cmd_token({"action": "regenerate"})
    assert api.token() != TOKEN
    async with client(hub) as c:
        assert (await c.get("/v1/status")).status_code == 401


def test_the_command_is_installed_and_never_over_someone_elses(hub, tmp_path):
    api = hub.code_api
    said = api.install_cli()
    path = api.cli_path()
    assert "Installed" in said and path.stat().st_mode & 0o111
    text = path.read_text()
    assert code_api.CLI_MARK in text and "-m jarvis.eden_code_cli" in text
    assert api.cli_state()["installed"] is True
    path.write_text("#!/bin/sh\necho mine\n")
    assert "left alone" in api.install_cli()
    assert path.read_text() == "#!/bin/sh\necho mine\n"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_for_real_on_a_port_with_the_commands_own_client(hub):
    del hub.code_api.listener.start  # (the real one, this once)
    port = free_port()
    hub.connectors.vault.set(code_api.VAULT, code_api.TOKEN_KEY, TOKEN)
    hub.set_feature_prefs({code_api.PREF: True, code_api.PREF_PORT: port})
    api = hub.code_api
    task(hub, 2, title="Fix the login", status="waiting")
    try:
        await api.sync()
        assert api.listener.running and api.listener.port == port
        found = json.loads(api.discovery_path().read_text())
        assert found["url"] == f"http://127.0.0.1:{port}" and TOKEN not in json.dumps(found)
        assert eden_code_cli.find_url({}, api.discovery_path().parent) == f"http://127.0.0.1:{port}"
        cli = eden_code_cli.Client(f"http://127.0.0.1:{port}", TOKEN, timeout=10)
        listed = await asyncio.to_thread(cli.call, "GET", "/v1/sessions")
        assert [s["title"] for s in listed["sessions"]] == ["Fix the login"]
        wrong = eden_code_cli.Client(f"http://127.0.0.1:{port}", "nope", timeout=10)
        with pytest.raises(eden_code_cli.Said) as said:
            await asyncio.to_thread(wrong.call, "GET", "/v1/status")
        assert said.value.status == 401
        hub.set_feature_prefs({code_api.PREF: False})
        await api.sync()
        assert not api.listener.running and not api.discovery_path().exists()
    finally:
        await api.close()
