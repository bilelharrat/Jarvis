"""Numbered window events (hub.Event.seq, server.socket): a window that reconnects says the
last event it had, and gets the snapshot, then the transcript events it missed; from
another backend, or too long ago, the snapshot alone."""

import math

from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import hub as hub_module
from jarvis.hub import Event, Hub
from jarvis.server import create_app, numbered

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


def test_a_search_answer_keeps_the_seq_the_window_asked_with(settings, quiet_speaker, isolated):
    """A search's answer names the window's request by its own seq (the window drops one
    whose seq isn't the one it asked with); numbering events must not write over it. Every
    other event still gets its number."""
    hub = make(settings, quiet_speaker, isolated)
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as client:
        for _ in range(10):  # the backend has been up a while: its numbers are past 7
            hub.emit("state", value="idle")
        with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
            hello = ws.receive_json()
            assert hello["seq"] >= 10
            ws.send_json({"type": "conversation_list", "q": "", "seq": "7"})
            answer = ws.receive_json()
            assert answer["type"] == "conversation_list" and answer["seq"] == "7"
            hub.emit("brain_results", seq="w1:3", q="lisbon", items=[])
            assert ws.receive_json()["seq"] == "w1:3"
            hub.emit("state", value="idle")
            plain = ws.receive_json()
            assert plain == {"type": "state", "value": "idle", "seq": plain["seq"]}
            assert plain["seq"] > hello["seq"]


def js_after(value, last):
    """value > last, as the window's JavaScript compares an event's seq with the newest it
    had (app.js heard(), code-store.js take())."""
    if isinstance(value, str) and isinstance(last, str):
        return value > last

    def number(v):
        if isinstance(v, (int, float)):
            return v
        try:
            return float(v) if v.strip() else 0
        except ValueError:
            return math.nan

    return number(value) > number(last)


def window_last(events):
    """The seq a window names reconnecting, after hearing these events."""
    last = 0
    for ev in events:
        if ev["type"] == "hello":
            last = int(ev["seq"])
        elif js_after(ev.get("seq"), last):
            last = ev["seq"]
    return last


def test_a_window_counted_past_the_backend_still_gets_what_it_missed(
    settings, quiet_speaker, isolated
):
    """A window that outlived a backend counts its searches past the new one's numbers. The
    answer to one must not carry that count as its seq: the window would keep it as the
    newest number it had, ask on reconnecting for the events after it, and lose the
    transcript events it missed."""
    hub = make(settings, quiet_speaker, isolated)
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as client:
        with client.websocket_connect(f"{WS}?token=s3cret", headers={"origin": BASE}) as ws:
            heard = [ws.receive_json()]
            ask = str(heard[0]["seq"] + 100)  # the window's 100th search since the last backend
            ws.send_json({"type": "conversation_list", "q": "", "seq": ask})
            heard.append(ws.receive_json())
            assert heard[-1]["type"] == "conversation_list"
            number = heard[-1]["seq"]  # its number, not the window's count
            assert isinstance(number, int) and heard[0]["seq"] < number < int(ask)
            hub.emit("task_log", id=7, entry={"n": 1, "text": "seen"})
            heard.append(ws.receive_json())
        last = window_last(heard)
        assert last == heard[-1]["seq"] > number
        # Away: the session went on.
        hub.emit("task_log", id=7, entry={"n": 2, "text": "while you were away"})
        url = f"{WS}?token=s3cret&since={last}&hub={hub.instance_id}"
        with client.websocket_connect(url, headers={"origin": BASE}) as ws:
            assert ws.receive_json()["replay"] is True
            missed = ws.receive_json()
            assert missed["type"] == "task_log" and missed["entry"]["text"] == "while you were away"


def test_a_seq_of_its_own_goes_only_where_the_window_cant_count_past_it():
    def event(n, seq):
        e = Event({"type": "conversation_list", "seq": seq})
        e.seq = n
        return e

    # At or below the newest number the window has (49), or never read as a number: kept.
    for own in ("7", "49", "007", "", "w1:3", "w1:121", "12abc:9", 12, 49):
        assert numbered(event(50, own), 49)["seq"] == own, own
    # What the window could read as a later number goes with the event's own number.
    for own in ("50", "121", " 121 ", "1e3", "0x100", "Infinity", "9" * 40, 50, 49.5, True):
        assert numbered(event(50, own), 49)["seq"] == 50, own
    assert numbered(event(50, "7"))["seq"] == 50  # (heard unknown: nothing counts as below)
    # Every other event gets its number; one without (a galaxy) goes as it is.
    plain = Event({"type": "state", "value": "idle"})
    plain.seq = 51
    assert numbered(plain, 49) == {"type": "state", "value": "idle", "seq": 51}
    galaxy = {"type": "galaxy", "seq": "999"}
    assert numbered(galaxy, 49) is galaxy


def test_a_window_naming_a_number_never_reached_gets_the_snapshot_alone(
    settings, quiet_speaker, isolated
):
    """A window's newest number past this backend's own is wrong, whatever made it so: which
    events it has can't be known, so it isn't told it's up to date (it asks for the whole
    transcripts instead)."""
    hub = make(settings, quiet_speaker, isolated)
    hub.emit("task_log", id=7, entry={"n": 1})
    assert hub.events_since(hub.seq, hub.seq) == []
    assert hub.events_since(hub.seq + 1, hub.seq) is None
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as client:
        url = f"{WS}?token=s3cret&since={hub.seq + 70}&hub={hub.instance_id}"
        with client.websocket_connect(url, headers={"origin": BASE}) as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and hello["replay"] is False
