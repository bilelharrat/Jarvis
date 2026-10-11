import re

import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jarvis.hub import Hub
from jarvis.server import create_app, feature_assets

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
    assert client.get("/health").json() == {"ok": True, "busy": False, "apps": []}
    assert "Talk to Eden" in client.get("/").text
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


def test_idle_sessions_never_hold_back_a_quiet_update(settings, quiet_speaker, isolated):
    """CH8: every open, idle Eden Code session is "waiting" ("Waiting for you"); only a
    running one, one with messages held back, or a card up makes the backend busy."""
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )
    sessions = [{"status": "waiting", "queued": 0} for _ in range(10)]
    hub.tasks.public = lambda: sessions
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        assert c.get("/health").json()["busy"] is False
        sessions.append({"status": "waiting", "queued": 2})  # on hold, messages waiting
        assert c.get("/health").json()["busy"] is True
        sessions[-1] = {"status": "running", "queued": 0}
        assert c.get("/health").json()["busy"] is True
        sessions[-1] = {"status": "done"}
        assert c.get("/health").json()["busy"] is False
        hub.approvals["a1"] = {"id": "a1", "question": "Run npm test?"}  # a card up
        assert c.get("/health").json()["busy"] is True
        hub.approvals.clear()
        assert c.get("/health").json()["busy"] is False
        # which apps' windows are on it (CH9: the owner app warns before its quit cuts them off)
        hub.app_windows.update({"eden-code": 2, "jarvis": 0})
        assert c.get("/health").json()["apps"] == ["eden-code"]


def test_window_modules_are_revalidated(client):
    # gestures.js is imported by hands.js without a version stamp
    assert client.get("/static/gestures.js").headers["cache-control"] == "no-cache"


def test_stamped_files_are_kept_by_the_window(client):
    # The page's and /features.json's ?v= stamp (each file's modification time) is a new address
    # after an edit, so a split view pane, or the next load, takes them from the cache.
    page = client.get("/?token=s3cret").text
    stamped = re.search(r'/static/app\.js\?v=(\d+)"', page)
    assert stamped and len(stamped.group(1)) >= 13  # (in ms)
    assert client.get(f"/static/app.js?v={stamped.group(1)}").headers["cache-control"] == (
        "max-age=31536000, immutable"
    )
    script = feature_assets()["scripts"][0]
    assert client.get(script).headers["cache-control"] == "max-age=31536000, immutable"
    # Anything else is still revalidated: no stamp, or a stamp that isn't one.
    assert client.get("/static/app.js").headers["cache-control"] == "no-cache"
    assert client.get("/static/app.js?vv=1").headers["cache-control"] == "no-cache"
    assert client.get("/static/nothing.js?v=1").status_code == 404


def test_the_chinese_and_the_feature_list_are_served_as_they_are_made(client, isolated):
    """Both are made in a thread (some 85 files read for the Chinese): the same answer."""
    from jarvis.features import _labs
    from jarvis.server import feature_assets, zh_strings

    zh = client.get("/static/i18n-zh.json")
    assert zh.status_code == 200 and zh.headers["cache-control"] == "no-cache"
    assert zh.json() == zh_strings() and zh.json()["strings"]
    listed = client.get("/features.json")
    assert listed.status_code == 200 and listed.headers["cache-control"] == "no-store"
    prefs = isolated["prefs_store"].prefs  # the hub's own
    assert listed.json() == feature_assets(skip=_labs.web_skipped(prefs))


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


def test_progress_bars_never_make_a_semaphore_that_no_quit_unlinks(monkeypatch, tmp_path):
    """A voice model's download draws tqdm progress bars; with a multiprocessing lock behind
    them every quit warned of leaked semaphores. The backend gives tqdm a thread lock."""
    import threading
    from multiprocessing import resource_tracker

    from tqdm import tqdm

    from jarvis.server import thread_lock_for_progress_bars

    made = []
    real = resource_tracker.register
    monkeypatch.setattr(
        resource_tracker, "register", lambda name, kind: made.append(kind) or real(name, kind)
    )
    monkeypatch.delattr(tqdm, "_lock", raising=False)  # as before any bar was drawn
    thread_lock_for_progress_bars()
    with open(tmp_path / "bars", "w") as out:
        for _ in tqdm(range(3), file=out):
            pass
    assert "semaphore" not in made
    assert isinstance(tqdm.get_lock(), type(threading.RLock()))


def test_missing_vendor_files_are_a_404_not_a_traceback(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path, caplog
):
    """CH18: without npm install in app/, /xterm/* answered 500 with a traceback each time."""
    import jarvis.server as server

    monkeypatch.setattr(server, "XTERM_DIR", tmp_path / "missing" / "@xterm")
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=object(),
        poll=False,
        **isolated,
    )
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        for _ in range(3):
            r = c.get("/xterm/xterm/lib/xterm.js")
            assert r.status_code == 404
            assert "npm install" in r.text
        told = [m for m in caplog.messages if "isn't installed" in m]
        assert len(told) == 1  # one line, not one per request
        # installed meanwhile: served at once
        lib = tmp_path / "missing" / "@xterm" / "xterm" / "lib"
        lib.mkdir(parents=True)
        (lib / "xterm.js").write_text("// xterm")
        assert c.get("/xterm/xterm/lib/xterm.js").text == "// xterm"
        assert c.get("/xterm/../package.json").status_code == 404


def test_text_is_sent_gzipped_to_a_browser_that_takes_it(client):
    # 2.5 MB of Eden Code's page was 0.8 MB this way; the ETag, the cache rules and the 304s
    # are the plain file's, and the bytes are the same once unpacked.
    from jarvis.server import WEB_DIR

    plain = (WEB_DIR / "app.js").read_bytes()
    zipped = client.get("/static/app.js", headers={"accept-encoding": "gzip"})
    assert zipped.headers["content-encoding"] == "gzip"
    assert zipped.headers["vary"] == "Accept-Encoding"
    assert int(zipped.headers["content-length"]) < len(plain) / 2
    assert zipped.content == plain  # (unpacked by the client)
    assert zipped.headers["cache-control"] == "no-cache"
    as_is = client.get("/static/app.js", headers={"accept-encoding": "identity"})
    assert "content-encoding" not in as_is.headers and as_is.content == plain
    assert as_is.headers["etag"] == zipped.headers["etag"]
    again = client.get(
        "/static/app.js",
        headers={"accept-encoding": "gzip", "if-none-match": zipped.headers["etag"]},
    )
    assert again.status_code == 304
    part = client.get("/static/app.js", headers={"accept-encoding": "gzip", "range": "bytes=0-9"})
    assert part.status_code == 206 and part.content == plain[:10]
    assert "content-encoding" not in part.headers
    page = client.get("/?token=s3cret").text
    stamp = re.search(r'/static/app\.js\?v=(\d+)"', page).group(1)
    kept = client.get(f"/static/app.js?v={stamp}", headers={"accept-encoding": "gzip"})
    assert kept.headers["content-encoding"] == "gzip"
    assert kept.headers["cache-control"] == "max-age=31536000, immutable"


def _hub_of(client) -> Hub:
    return next(
        c.cell_contents
        for route in client.app.routes
        if getattr(route, "path", "") == "/ws"
        for c in (route.endpoint.__closure__ or ())
        if isinstance(c.cell_contents, Hub)
    )


def test_eden_codes_window_gets_neither_the_huds_parts_nor_its_events(client):
    hub = _hub_of(client)
    hub.markets.summary = {"status": "open", "indices": [{"symbol": "SPX", "pct": 1.0}]}
    hub.status = {"next_event": {"title": "Dentist", "begin": "2026-10-10T15:00:00"}}
    code = f"{WS}?token=s3cret&app=eden-code"
    with client.websocket_connect(code, headers={"origin": BASE}) as ws:
        hello = ws.receive_json()
        for part in ("markets", "vitals", "defense", "status", "location"):
            assert part not in hello, part
        assert "tasks" in hello and "prefs" in hello and "usage" in hello
        hub.emit("vitals", cpu=1)
        hub.emit("status", next_event={"title": "Dentist"})
        hub.emit("caption", text="after")
        # (the HUD's two never came)
        assert _next_of(ws, "vitals", "status", "caption")["type"] == "caption"
    with client.websocket_connect(f"{WS}?token=s3cret&app=jarvis", headers={"origin": BASE}) as ws:
        hello = ws.receive_json()
        assert hello["markets"]["status"] == "open" and hello["status"]["next_event"]
        assert hello["vitals"] is not None
        hub.emit("vitals", cpu=1)
        assert _next_of(ws, "vitals", "caption")["type"] == "vitals"


def _next_of(ws, *kinds):
    """The next event of these kinds (others, such as app_windows, are passed over)."""
    while (event := ws.receive_json())["type"] not in kinds:
        pass
    return event


def test_an_answer_goes_to_the_window_that_asked_only(client):
    hub = _hub_of(client)
    hub.register_command("probe_ask", lambda msg: hub.emit_to_caller("probe_answer", n=msg["n"]))
    url = f"{WS}?token=s3cret&app=eden-code"
    with client.websocket_connect(url, headers={"origin": BASE}) as a:
        a.receive_json()
        with client.websocket_connect(url, headers={"origin": BASE}) as b:
            b.receive_json()
            a.send_json({"type": "probe_ask", "n": 1})
            got = _next_of(a, "probe_answer", "caption")
            assert (got["type"], got["n"]) == ("probe_answer", 1) and got["seq"] > 0
            b.send_json({"type": "probe_ask", "n": 2})
            assert _next_of(b, "probe_answer", "caption")["n"] == 2  # A's never reached it
            hub.emit("caption", text="to all")
            assert _next_of(a, "probe_answer", "caption")["type"] == "caption"  # nor B's A
    # With no window asking (the hub's own work, a test), it goes to every window as before.
    seen = []
    q = hub.subscribe()
    hub.emit_to_caller("probe_answer", n=3)
    while not q.empty():
        seen.append(q.get_nowait())
    hub.unsubscribe(q)
    assert [e["n"] for e in seen if e["type"] == "probe_answer"] == [3]


def test_the_line_serve_prints_once_up_says_eden():
    """CH3-4: run by the app it lands in backend.log and on the problem screen, under the current name."""
    from jarvis.server import listening_line

    assert (
        listening_line(5174, "t0k", by_app=True)
        == "Eden listening on http://127.0.0.1:5174/ (token kept by the app)"
    )
    assert (
        listening_line(5174, "t0k", by_app=False)
        == "Eden listening on http://127.0.0.1:5174/?token=t0k"
    )
