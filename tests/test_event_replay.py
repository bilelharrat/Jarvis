"""Numbered window events (hub.Event.seq, server.socket): a window that reconnects says the
last event it had, and gets the snapshot, then the transcript events it missed; from
another backend, or too long ago, the snapshot alone."""

from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import hub as hub_module
from jarvis.hub import Hub
from jarvis.server import create_app

BASE = "http://127.0.0.1:8123"
WS = "ws://127.0.0.1:8123/ws"


def make(settings, quiet_speaker, isolated):
    return Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )


def test_events_are_numbered_and_only_transcripts_are_kept(settings, quiet_speaker, isolated):
    hub = make(settings, quiet_speaker, isolated)
    start = hub.seq
    hub.emit("task_log", id=1, entry={"n": 1})
    hub.emit("state", value="idle")
    hub.emit("task_log", id=1, entry={"n": 2})
    assert hub.seq == start + 3
    assert [n for n, _e in hub.events_since(start, hub.seq)] == [start + 1, start + 3]
    assert hub.events_since(start + 3, hub.seq) == []


def test_too_long_ago_is_the_snapshot_alone(settings, quiet_speaker, isolated, monkeypatch):
    hub = make(settings, quiet_speaker, isolated)
    hub._recent = hub_module.deque(maxlen=2)
    start = hub.seq
    for n in range(3):
        hub.emit("task_log", id=1, entry={"n": n})
    assert hub.events_since(start, hub.seq) is None


def test_a_reconnecting_window_gets_what_it_missed(settings, quiet_speaker, isolated):
    hub = make(settings, quiet_speaker, isolated)
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as client:
        with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
            hello = ws.receive_json()
            assert hello["seq"] == hub.seq and hello["replay"] is False
            last = hello["seq"]
        # Away: a session went on.
        hub.emit("task_log", id=7, entry={"n": 1, "text": "while you were away"})
        hub.emit("state", value="idle")
        url = f"{WS}?token=s3cret&since={last}&hub={hub.instance_id}"
        with client.websocket_connect(url, headers={"origin": BASE}) as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and hello["replay"] is True
            missed = ws.receive_json()
            assert missed["type"] == "task_log" and missed["entry"]["text"] == "while you were away"
            assert missed["seq"] == last + 1
        other = f"{WS}?token=s3cret&since={last}&hub=another"
        with client.websocket_connect(other, headers={"origin": BASE}) as ws:
            assert ws.receive_json()["replay"] is False
