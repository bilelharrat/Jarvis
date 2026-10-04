import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis.hub import Hub
from jarvis.server import create_app

BASE = "http://127.0.0.1:8123"  # where the window loads it from
WS = "ws://127.0.0.1:8123/ws"  # and its socket


@pytest.fixture
def client(settings, quiet_speaker, isolated):
    class Client(FakeClient):
        script = CALENDAR_TURN

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,  # never the user's real prefs, memory or routines
    )
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        yield c


def test_page_and_health_are_served(client):
    assert client.get("/health").json() == {"ok": True, "busy": False}
    assert "Talk to Jarvis" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_health_says_when_a_restart_would_cut_something_off(settings, quiet_speaker, isolated):
    # The app's quiet updates wait while JARVIS has something going.
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        assert c.get("/health").json()["busy"] is False
        hub.meeting = object()  # meeting notes running
        assert c.get("/health").json()["busy"] is True
        hub.meeting = None
        hub.state = "speaking"
        assert c.get("/health").json()["busy"] is True
        hub.state = "idle"
        hub.busy = lambda: (_ for _ in ()).throw(RuntimeError("broken"))
        assert c.get("/health").json()["busy"] is True  # unsure counts as busy


def test_window_modules_are_revalidated(client):
    # gestures.js is imported by hands.js without a version stamp
    assert client.get("/static/gestures.js").headers["cache-control"] == "no-cache"


def test_the_page_opens_in_the_look_the_owner_chose(client):
    """A look chosen in Settings is kept, and the next window (a reopened app) is drawn in
    it from the first paint, not the default until the socket catches up."""
    assert 'data-look="orb" data-glass-tone="auto"' in client.get("/").text  # the default
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "set_prefs", "changes": {"look": "obsidian"}})
        while ws.receive_json()["type"] != "prefs":
            pass
    assert 'data-look="orb" data-skin="obsidian"' in client.get("/").text
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["prefs"]["look"] == "obsidian"
        ws.send_json({"type": "set_prefs", "changes": {"look": "console"}})
        while ws.receive_json()["type"] != "prefs":
            pass
    assert (
        '<body data-state="idle" data-look="console" data-glass-tone="auto">'
        in client.get("/").text
    )


def test_body_look_keeps_to_known_looks():
    from jarvis.server import BODY, body_look

    page = f"<html>{BODY}</html>"
    assert 'data-skin="glass" data-glass-tone="auto"' in body_look(page, "glass", "auto")
    assert body_look(page, "hud") == body_look(page, "orb")  # never an unknown one
    assert 'data-glass-tone="dark"' in body_look(page, "glass", "<script>")


def test_socket_needs_the_token(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"{WS}?token=wrong", headers={"origin": BASE}) as ws:
            ws.receive_json()


def test_socket_rejects_other_origins(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"{WS}?token=s3cret", headers={"origin": "https://evil.example"}
        ) as ws:
            ws.receive_json()


def test_socket_hello_and_ask(client):
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["state"] == "idle"
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        seen = []
        while not seen or seen[-1]["type"] != "turn_done":
            seen.append(ws.receive_json())
        assert any(e["type"] == "reply" and e["text"] == "Two meetings tomorrow." for e in seen)


def test_a_bad_frame_or_a_failing_command_keeps_the_socket_open(client):
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_text("this isn't JSON")
        ws.send_json({"type": "task_cancel", "id": "not a number"})  # its handler raises
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        seen = []
        while not seen or seen[-1]["type"] != "turn_done":
            seen.append(ws.receive_json())
        assert any(e["type"] == "reply" and e["text"] == "Two meetings tomorrow." for e in seen)


def test_a_hello_that_fails_leaves_no_queue_behind(client):
    hub = client.app.state.hub if hasattr(client.app.state, "hub") else None
    app_hub = hub or next(
        c.cell_contents
        for route in client.app.routes
        if getattr(route, "path", "") == "/ws"
        for c in (route.endpoint.__closure__ or ())
        if isinstance(c.cell_contents, Hub)
    )

    def broken():
        raise RuntimeError("snapshot failed")

    app_hub.snapshot = broken
    try:
        with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
            ws.receive_json()
    except Exception:
        pass
    assert not app_hub._subscribers


def test_odd_values_never_stop_a_windows_events():
    import json as _json

    from jarvis.server import event_text

    text = event_text(
        {"type": "files", "name": "bad\udc80name", "cpu": float("nan"), "at": object()}
    )
    event = _json.loads(text)
    assert event["type"] == "files" and event["cpu"] is None and "name" in event["name"]


def test_a_token_with_other_characters_is_just_a_wrong_token(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(f"{WS}?token=%C3%A9t%C3%A9", headers={"origin": BASE}) as ws:
            ws.receive_json()
    assert refused.value.code == 4403  # not a 500 with a traceback


def test_a_rebound_host_is_refused_even_with_the_token(client):
    rebound = {"host": "attacker.test:8123", "origin": "http://attacker.test:8123"}
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(f"{WS}?token=s3cret", headers=rebound) as ws:
            ws.receive_json()
    assert refused.value.code == 4403


def test_odd_commands_never_close_the_socket(client):
    with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["type"] == "hello"
        for odd in ({"type": []}, {"type": {}}, {}, {"type": 7}, {"type": None}, [1, 2], "x"):
            ws.send_json(odd)
        ws.send_text("[" * 10_000 + "]" * 10_000)  # nested past Python's recursion limit
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        seen = []
        while not seen or seen[-1]["type"] != "turn_done":
            seen.append(ws.receive_json())
        assert any(e["type"] == "reply" and e["text"] == "Two meetings tomorrow." for e in seen)


async def test_a_command_failing_in_a_loop_is_logged_once_a_minute(
    settings, quiet_speaker, isolated, caplog, monkeypatch
):
    hub = Hub(settings, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)

    async def broken(_msg):
        raise KeyError("id")

    monkeypatch.setattr(hub, "_handle", broken)
    with caplog.at_level("ERROR", logger="jarvis"):
        for _ in range(50):
            await hub.handle({"type": "task_cancel"})
    assert len([r for r in caplog.records if "task_cancel" in r.getMessage()]) == 1
    assert hub._command_failures["task_cancel"][1] == 49


async def test_background_tasks_that_finish_are_not_logged_as_failed_commands(
    settings, quiet_speaker, isolated, caplog
):
    import asyncio

    hub = Hub(settings, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)

    async def fine():
        return None

    async def broken():
        raise ValueError("kaput")

    with caplog.at_level("ERROR", logger="jarvis"):
        done = [hub._spawn(fine()) for _ in range(10)]
        done.append(hub._spawn(broken()))
        await asyncio.gather(*done, return_exceptions=True)
        await asyncio.sleep(0)
    assert not [r for r in caplog.records if "window command" in r.getMessage()]
    failed = [r for r in caplog.records if "background task" in r.getMessage()]
    assert len(failed) == 1 and "kaput" in caplog.text
    assert not hub._command_failures
