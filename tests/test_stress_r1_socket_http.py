"""Stress round 1, the window's socket and the HTTP routes: hostile tokens, hosts and
origins, path tricks, replay edges, and window commands with odd values in them."""

import json
import logging

import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis.hub import Hub
from jarvis.server import create_app

BASE = "http://127.0.0.1:8123"
WS = "ws://127.0.0.1:8123/ws"


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    class Client(FakeClient):
        script = CALENDAR_TURN

    return Hub(
        settings,
        client_factory=Client,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )


@pytest.fixture
def client(hub):
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        yield c


def _deep(levels):
    value = "x"
    for _ in range(levels):
        value = {"a": [value]}
    return value


def _until(ws, kind):
    while (event := ws.receive_json())["type"] != kind:
        pass
    return event


def _close_code(client, url, headers):
    try:
        with client.websocket_connect(url, headers=headers) as ws:
            ws.receive_json()
    except WebSocketDisconnect as exc:
        return exc.code
    return None


def test_a_setting_nested_absurdly_deep_never_stops_saves_or_new_windows(client, hub, isolated):
    """One frame with a setting a few hundred levels deep (feature_prefs keeps any plain JSON
    for a key no feature registers) made every later prefs save fail (dataclasses.asdict
    recursed past the limit) and every new window's hello with it: the settings changed
    after it were lost, and the window couldn't reconnect until the backend restarted."""
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json(
            {"type": "feature_prefs", "changes": {"x_deep": _deep(300), "x_plain": [1, {"b": 2}]}}
        )
        ws.send_json({"type": "set_prefs", "changes": {"watchlist": _deep(300), "humor": 42}})
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})  # after those, in order
        _until(ws, "turn_done")
    assert hub.prefs.humor == 42
    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["humor"] == 42  # kept, not lost to a save that couldn't run
    assert saved["features"]["x_plain"] == [1, {"b": 2}]  # the sane one in the same change
    assert "x_deep" not in saved["features"]
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["type"] == "hello"  # a new window still opens
        # All the feature settings at once (set_prefs replaces them): the deep one left out.
        features = {"x_plain": [2], "y_deep": _deep(300)}
        ws.send_json({"type": "set_prefs", "changes": {"features": features}})
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        _until(ws, "turn_done")
    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["features"] == {"x_plain": [2]}


async def test_odd_numbers_and_attachments_in_commands_log_no_traceback(hub, caplog):
    """A session id, queued item or terminal size that isn't a number (null, words,
    infinity, a list) and attachments that aren't a list were tracebacks in the log; now
    they name nothing, and the command does nothing (or asks without pictures)."""
    odd = [None, "seven", float("inf"), float("nan"), [], {}, 10**30]
    with caplog.at_level(logging.ERROR, logger="jarvis"):
        for value in odd:
            for kind in ("task_cancel", "task_rename", "task_unqueue", "task_steer", "task_mode"):
                await hub.handle({"type": kind, "id": value, "item": value})
            await hub.handle({"type": "goal_priorities", "ids": value})
            await hub.handle({"type": "term_resize", "term": "none", "cols": value})
        await hub.handle({"type": "ask", "text": "what's on tomorrow?", "images": 7})
        await hub.handle({"type": "ask", "text": "and the day after?", "images": {"a": 1}})
    assert not [r for r in caplog.records if r.exc_info], caplog.text
    assert not hub._command_failures
    assert hub._attachments({"images": 7}) is None
    assert hub._attachments({"images": [{"data": "abc", "name": "a.png"}]})[0]["name"] == "a.png"


def test_settings_nested_past_the_limit_are_left_out_and_the_rest_apply():
    from jarvis.hub import PREFS_DEPTH, _nested_past, _settable

    assert not _nested_past({"a": [1, {"b": "c"}]})
    assert not _nested_past(_deep(PREFS_DEPTH // 2 - 1))
    assert _nested_past(_deep(PREFS_DEPTH))
    kept = _settable({"humor": 5, "watchlist": _deep(50), "features": {"ok": 1, "no": _deep(50)}})
    assert kept == {"humor": 5, "features": {"ok": 1}}
    assert _settable("not a dict") == "not a dict"  # prefs.update refuses that on its own


def test_a_hand_edited_setting_nested_absurdly_deep_is_left_out_when_prefs_load(tmp_path):
    """The same guard on the way in from the file: a prefs.json with a feature setting a few
    hundred deep loads without it, and saves and reads back after."""
    import dataclasses
    import json

    from jarvis.prefs import PrefsStore

    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({"humor": 40, "features": {"ok": [1, 2], "deep": _deep(300)}}))
    store = PrefsStore(path)
    assert store.prefs.features == {"ok": [1, 2]}
    dataclasses.asdict(store.prefs)  # what save and every window's hello go through
    store.prefs.humor = 41
    store.save()
    assert PrefsStore(path).prefs.humor == 41


def test_the_socket_refuses_every_odd_token_host_and_origin(client):
    """Each is closed with 4403 before the socket opens: no 500, no hello."""
    good = {"origin": BASE}
    refused = {
        "empty token": (f"{WS}?token=", good),
        "no token": (WS, good),
        "long token": (f"{WS}?token={'a' * 60_000}", good),
        "a NUL after it": (f"{WS}?token=s3cret%00", good),
        "a lone surrogate": (f"{WS}?token=%ED%A0%80", good),
        "no origin": (f"{WS}?token=s3cret", {}),
        "origin null": (f"{WS}?token=s3cret", {"origin": "null"}),
        "https origin": (f"{WS}?token=s3cret", {"origin": "https://127.0.0.1:8123"}),
        "another loopback name": (f"{WS}?token=s3cret", {"origin": "http://localhost:8123"}),
        "a trailing slash": (f"{WS}?token=s3cret", {"origin": BASE + "/"}),
        "a rebound name": (
            f"{WS}?token=s3cret",
            {"host": "evil.test:8123", "origin": "http://evil.test:8123"},
        ),
        "capitals": (
            f"{WS}?token=s3cret",
            {"host": "LOCALHOST:8123", "origin": "http://LOCALHOST:8123"},
        ),
        "no port": (f"{WS}?token=s3cret", {"host": "127.0.0.1", "origin": "http://127.0.0.1"}),
        "the wrong one last": (f"{WS}?token=s3cret&token=wrong", good),
    }
    for name, (url, headers) in refused.items():
        assert _close_code(client, url, headers) == 4403, name


def test_static_files_never_reach_outside_their_folder(client):
    for path in (
        "/static/../server.py",
        "/static/%2e%2e/server.py",
        "/static/%2E%2E%2Fserver.py",
        "/static/%252e%252e/server.py",
        "/static/..%5cserver.py",
        "/static//etc/passwd",
        "/static/%2Fetc%2Fpasswd",
        "/static/features/%2e%2e/%2e%2e/hub.py",
        "/static/app.js%00.png",
        "/static/" + "a" * 5000,
        "/vision/%2e%2e/%2e%2e/package.json",
        "/xterm/xterm/../../../package.json",
        "/f/widgets/../../server.py",
    ):
        response = client.get(path)
        assert response.status_code == 404, path
        assert "Traceback" not in response.text and "def " not in response.text


def test_hooks_refuse_web_pages_rebinding_and_floods_without_reading_the_body(client):
    local = {"host": "127.0.0.1:8123"}
    page = {**local, "origin": "http://evil.test"}
    assert client.post("/hooks/x", headers=page).status_code == 403
    assert client.post("/hooks/x", headers={"host": "evil.test"}).status_code == 403
    huge = client.post("/hooks/nope", headers=local, content=b"x" * 2_000_000)
    assert huge.status_code == 401 and huge.json() == {"error": "unauthorized"}
    binary = client.post("/hooks/x", headers={**local, "x-jarvis-token": b"\xff\xfe"})
    assert binary.status_code == 401
    for _ in range(25):
        last = client.post("/hooks/x", headers=local)
    assert last.status_code == 429  # wrong tokens past the limit: every hook refuses a while
    assert client.get("/hooks/x").status_code == 405


@pytest.mark.parametrize(
    ("since", "replayed"),
    [("-1", False), ("-99999999999", False), ("x", False), ("1e5", False), ("", False),
     ("9" * 5000, False), ("0", True), ("99999999999999999999", True)],
)  # fmt: skip
def test_replay_takes_any_since_and_only_from_its_own_backend(client, hub, since, replayed):
    for backend, expect in ((hub.instance_id, replayed), ("another", False), ("", False)):
        url = f"{WS}?token=s3cret&since={since}&hub={backend}"
        with client.websocket_connect(url, headers={"origin": BASE}) as ws:
            hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["replay"] is expect
