import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis.hub import Hub
from jarvis.server import create_app


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
    with TestClient(create_app(hub, "s3cret")) as c:
        yield c


def test_page_and_health_are_served(client):
    assert client.get("/health").json() == {"ok": True}
    assert "Talk to Jarvis" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_window_modules_are_revalidated(client):
    # gestures.js is imported by hands.js without a version stamp
    assert client.get("/static/gestures.js").headers["cache-control"] == "no-cache"


def test_socket_needs_the_token(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws?token=wrong", headers={"origin": "http://testserver"}
        ) as ws:
            ws.receive_json()


def test_socket_rejects_other_origins(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws?token=s3cret", headers={"origin": "https://evil.example"}
        ) as ws:
            ws.receive_json()


def test_socket_hello_and_ask(client):
    with client.websocket_connect(
        "/ws?token=s3cret", headers={"origin": "http://testserver"}
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["state"] == "idle"
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        seen = []
        while not seen or seen[-1]["type"] != "turn_done":
            seen.append(ws.receive_json())
        assert any(e["type"] == "reply" and e["text"] == "Two meetings tomorrow." for e in seen)
