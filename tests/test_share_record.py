"""One backend for every Eden app: the record it writes about itself (share_record.py), the
app that started it letting go while another app's window is on it (/share/release and
launcher_watch.Linger), and a newer app taking the data over (/share/shutdown)."""

from __future__ import annotations

import json
import os
import stat

import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import launcher_watch, share_record
from jarvis.hub import Hub
from jarvis.launcher_watch import STOP_GRACE, Linger, Watch
from jarvis.server import create_app

BASE = "http://127.0.0.1:8123"
WS = "ws://127.0.0.1:8123/ws"
AUTH = {"authorization": "Bearer s3cret"}


# ── the record ──


def test_the_backend_says_where_it_is_for_the_owner_alone(tmp_path):
    env = {"JARVIS_LAUNCHER_PID": "4242", "JARVIS_LAUNCHER_APP": "eden-code"}
    record = share_record.publish(
        tmp_path, port=61234, token="t0ken", profile="code", environ=env, now=1000.0
    )
    path = tmp_path / share_record.FILE
    assert stat.S_IMODE(path.stat().st_mode) == 0o600  # the token is in it: nobody else reads it
    on_disk = json.loads(path.read_text())
    assert on_disk == record
    assert on_disk["protocol"] == share_record.PROTOCOL
    assert on_disk["pid"] == os.getpid()  # the process holding the lock, never uv above it
    assert (on_disk["port"], on_disk["token"], on_disk["profile"]) == (61234, "t0ken", "code")
    assert (on_disk["app"], on_disk["launcher"], on_disk["started"]) == (
        "eden-code",
        4242,
        1_000_000,
    )
    assert on_disk["version"]
    assert not list(tmp_path.glob("*.tmp"))  # written through a temporary file, left none


def test_a_terminal_backend_says_so(tmp_path):
    record = share_record.publish(tmp_path, port=1, token="t", profile="full", environ={})
    assert (record["app"], record["launcher"], record["profile"]) == ("terminal", 0, "full")
    bad = share_record.publish(
        tmp_path, port=1, token="t", profile="odd", environ={"JARVIS_LAUNCHER_PID": "x"}
    )
    assert (bad["launcher"], bad["profile"]) == (0, "full")


def test_only_its_own_record_is_changed_or_taken_away(tmp_path):
    share_record.publish(tmp_path, port=1, token="t", profile="code", environ={})
    assert share_record.update(tmp_path, profile="full")
    assert share_record.read(tmp_path)["profile"] == "full"

    other = {**share_record.read(tmp_path), "pid": os.getpid() + 1}
    (tmp_path / share_record.FILE).write_text(json.dumps(other))
    assert not share_record.update(tmp_path, profile="code")
    assert not share_record.withdraw(tmp_path)  # another backend's: left alone
    assert share_record.read(tmp_path)["pid"] == os.getpid() + 1


def test_a_restart_on_purpose_keeps_the_record(tmp_path):
    """The app marks it restarting (backend-share.js markRestarting) before stopping it: the
    other app waits for the new one instead of starting its own."""
    share_record.publish(tmp_path, port=1, token="t", profile="full", environ={})
    share_record.update(tmp_path, restarting=123)
    assert not share_record.withdraw(tmp_path)
    assert share_record.read(tmp_path)
    share_record.publish(tmp_path, port=1, token="t", profile="full", environ={})
    assert share_record.withdraw(tmp_path)
    assert share_record.read(tmp_path) is None
    assert not share_record.withdraw(tmp_path)  # none: nothing to do


def test_a_broken_record_reads_as_none(tmp_path):
    (tmp_path / share_record.FILE).write_text("{not json")
    assert share_record.read(tmp_path) is None
    (tmp_path / share_record.FILE).write_text("[1, 2]")
    assert share_record.read(tmp_path) is None


# ── staying for the other apps' windows ──


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_linger_stops_only_after_the_last_window_has_been_gone_a_while():
    clock, windows, calls = Clock(), [1], []
    linger = Linger(
        lambda: windows[0],
        lambda: calls.append("stop"),
        lambda: calls.append("force"),
        clock=clock,
        grace=15,
    )
    assert linger.check() == ""  # Eden Secretary's window is still here
    windows[0] = 0
    assert linger.check() == ""  # gone a moment (a reload): not yet
    clock.t = 10
    windows[0] = 1
    assert linger.check() == ""  # back: the count starts again
    windows[0] = 0
    clock.t = 11
    linger.check()
    clock.t = 25
    assert linger.check() == ""
    clock.t = 26
    assert linger.check() == "stop" and calls == ["stop"]
    clock.t = 26 + STOP_GRACE
    assert linger.check() == "force" and calls == ["stop", "force"]


def test_a_count_that_fails_counts_as_none():
    clock, calls = Clock(), []
    linger = Linger(lambda: 1 / 0, lambda: calls.append("stop"), lambda: None, clock=clock, grace=1)
    linger.check()
    clock.t = 2
    assert linger.check() == "stop"


def test_a_released_backend_no_longer_follows_its_app():
    calls = []
    watch = Watch(lambda: False, lambda: calls.append("stop"), lambda: calls.append("force"))
    watch.released = True
    assert watch.check() == "" and calls == []


def test_release_stops_the_launcher_watch_and_starts_one_linger(monkeypatch):
    monkeypatch.setattr(launcher_watch, "_linger", None)
    watch = Watch(lambda: True, lambda: None, lambda: None)
    monkeypatch.setattr(launcher_watch, "_watch", watch)
    started = []
    monkeypatch.setattr(
        launcher_watch.threading,
        "Thread",
        lambda **kw: type("T", (), {"start": lambda s: started.append(kw["name"])})(),
    )
    first = launcher_watch.release(lambda: 1)
    assert watch.released and started == ["linger-watch"]
    assert launcher_watch.release(lambda: 2) is first and started == ["linger-watch"]


# ── the server's side ──


@pytest.fixture
def shared(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )
    folder = tmp_path / "data"
    share_record.publish(folder, port=8123, token="s3cret", profile="code", environ={})
    hub.profile = "code"
    calls = {"release": [], "stop": [], "detach": []}
    app = create_app(
        hub,
        "s3cret",
        share_folder=folder,
        release=lambda count: calls["release"].append(count),
        stop=lambda: calls["stop"].append(True),
        detach=lambda: calls["detach"].append(True),
    )
    with TestClient(app, base_url=BASE) as c:
        c.hub, c.folder, c.calls = hub, folder, calls
        yield c


def test_release_without_another_app_lets_the_app_stop_it(shared):
    assert shared.post("/share/release", json={"app": "eden-code"}, headers=AUTH).json() == {
        "ok": True,
        "staying": False,
    }
    assert shared.calls["release"] == [] and shared.calls["detach"] == []


def test_release_with_another_app_s_window_keeps_it_up(shared):
    with shared.websocket_connect(f"{WS}?token=s3cret&app=eden-code", headers={"origin": BASE}):
        with shared.websocket_connect(f"{WS}?token=s3cret&app=jarvis", headers={"origin": BASE}):
            # Eden Code (which started it) is quitting; Eden Secretary's window stays.
            answer = shared.post("/share/release", json={"app": "eden-code"}, headers=AUTH).json()
            assert answer == {"ok": True, "staying": True, "windows": 1}
            [count] = shared.calls["release"]
            assert count() == 2  # every app's windows keep it up from now on
            assert shared.calls["detach"] == [True]
            record = share_record.read(shared.folder)
            assert record["launcher"] == 0 and record["released"] > 0
            assert record["profile"] == "full"  # the Secretary window woke it, in place


def test_only_the_app_with_the_token_may_release_or_stop_it(shared):
    assert shared.post("/share/release", json={"app": "x"}).status_code == 403
    bad = {"authorization": "Bearer nope"}
    assert shared.post("/share/release", json={"app": "x"}, headers=bad).status_code == 403
    assert shared.post("/share/shutdown", headers=bad).status_code == 403
    # a web page in a browser (it sends an Origin) never can, token or not
    page = {**AUTH, "origin": "http://evil.example"}
    assert shared.post("/share/shutdown", headers=page).status_code == 403
    assert shared.calls["stop"] == [] and not getattr(shared.hub, "handed_over", False)


def test_a_newer_app_asks_it_to_hand_over(shared):
    import time

    assert shared.post("/share/shutdown", headers=AUTH).json() == {"ok": True}
    assert shared.hub.handed_over is True
    assert share_record.read(shared.folder)["handover"] > 0
    for _ in range(50):  # stopped a moment later, once the answer has gone
        if shared.calls["stop"]:
            break
        time.sleep(0.02)
    assert shared.calls["stop"] == [True]


def test_health_names_the_protocol(shared):
    assert shared.get("/health").json()["protocol"] == share_record.PROTOCOL
