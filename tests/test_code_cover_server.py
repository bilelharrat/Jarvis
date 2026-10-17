"""The window server (server.py) as Eden Code's window and the app see it: the pages and
files it serves, the socket's checks and what it does with a window's frames and events,
the helpers that make an event sendable, and serve's start and stop with uvicorn faked.
Also end_children, which ends what the backend started and nothing else."""

import asyncio
import logging
import subprocess
import sys

import httpx
import pytest
from code_session_fakes import make_hub
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import jarvis.prefs as prefs_module
from jarvis import server
from jarvis.hub import Event, WindowQueue
from jarvis.server import create_app

BASE = "http://127.0.0.1:8123"
WS = "ws://127.0.0.1:8123/ws"
ORIGIN = {"origin": BASE}


class Calendar(FakeClient):
    script = CALENDAR_TURN


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated, client=Calendar)


@pytest.fixture
def client(hub):
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        yield c


def _until_done(ws):
    seen = []
    while not seen or seen[-1]["type"] != "turn_done":
        seen.append(ws.receive_json())
    return seen


# ── pages and files ──


def test_eden_codes_window_gets_its_own_page_in_ask_edens_look(client):
    """/?app=code is the same page named Eden Code and marked for Eden Code alone, in the
    orb look whatever the owner picked for J.A.R.V.I.S."""
    page = client.get("/?app=code")
    assert page.headers["cache-control"] == "no-store"
    assert "<title>Eden Code</title>" in page.text
    assert 'data-app="eden-code" class="eden-code"' in page.text
    assert 'data-look="orb"' in page.text and "?v=" in page.text


def test_the_daredevil_window_gets_the_edition_marked_on_its_page(client):
    """/?edition=daredevil is named for the edition and marked so screen-reader mode is on."""
    page = client.get("/?edition=daredevil").text
    assert "<title>Eden Daredevil</title>" in page
    assert 'data-edition="daredevil"' in page


def test_health_counts_a_broken_busy_check_as_busy(client, hub):
    """The app's quiet update waits when the backend can't tell whether it is busy."""
    assert client.get("/health").json() == {"ok": True, "busy": False, "protocol": 1}
    hub.busy = lambda: 1 / 0
    assert client.get("/health").json() == {"ok": True, "busy": True, "protocol": 1}


def test_the_chinese_strings_and_feature_list_are_served(client):
    """The translation and the feature modules' files come back as JSON, not cached stale."""
    zh = client.get("/static/i18n-zh.json")
    assert zh.headers["cache-control"] == "no-cache"
    assert set(zh.json()) == {"strings", "patterns"}
    features = client.get("/features.json")
    assert features.headers["cache-control"] == "no-store"
    assert set(features.json()) == {"scripts", "styles"}
    assert all("?v=" in path for path in features.json()["scripts"])


def test_a_static_file_is_revalidated_on_every_load(client):
    """The window's own modules are served with no-cache so an import is never stale."""
    assert client.get("/static/app.js").headers["cache-control"] == "no-cache"


def test_an_inbound_hook_answers_with_the_handlers_status_and_body(client, hub):
    """POST /hooks/<name> goes to the registered handler and its answer is the reply; a
    handler that fails is a 500, never a traceback."""
    seen = []

    async def handler(name, request):
        seen.append((name, await request.body()))
        return 202, {"took": name}

    hub.register_webhook(handler)
    reply = client.post("/hooks/build-done", content=b"ok")
    assert reply.status_code == 202 and reply.json() == {"took": "build-done"}
    assert reply.headers["cache-control"] == "no-store"
    assert seen == [("build-done", b"ok")]

    async def broken(name, request):
        raise RuntimeError("no")

    hub.register_webhook(broken)
    reply = client.post("/hooks/x")
    assert reply.status_code == 500 and reply.json() == {"error": "failed"}
    assert client.get("/hooks/x").status_code == 405  # POST only


def test_the_hand_model_is_downloaded_once_then_served_from_the_cache(
    client, tmp_path, monkeypatch
):
    """The first request fetches the model (the network faked) and keeps it; later ones
    never go out again."""
    monkeypatch.setattr(prefs_module, "APP_SUPPORT", tmp_path / "support")
    fetched = []

    def answer(request):
        fetched.append(str(request.url))
        return httpx.Response(200, content=b"MODEL")

    real = httpx.AsyncClient

    def faked(**kwargs):
        return real(transport=httpx.MockTransport(answer), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", faked)
    first = client.get("/models/hand_landmarker.task")
    assert first.status_code == 200 and first.content == b"MODEL"
    assert fetched == [server.HAND_MODEL_URL]
    kept = tmp_path / "support" / "models" / "hand_landmarker.task"
    assert kept.read_bytes() == b"MODEL" and not kept.with_suffix(".part").exists()
    assert client.get("/models/hand_landmarker.task").content == b"MODEL"
    assert len(fetched) == 1


# ── the socket ──


def test_the_socket_refuses_a_missing_origin_and_a_host_that_isnt_this_machine(client):
    """With the right token, no Origin header, or a Host other than this machine's own
    address, is still refused with 4403."""
    for headers in ({}, {"host": "127.0.0.1:9999", "origin": "http://127.0.0.1:9999"}):
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect(f"{WS}?token=s3cret", headers=headers) as ws:
                ws.receive_json()
        assert refused.value.code == 4403


def test_the_socket_takes_localhost_as_this_machine(client):
    """localhost with its matching origin is this machine: the window gets its hello."""
    url = "ws://localhost:8123/ws?token=s3cret"
    with client.websocket_connect(url, headers={"origin": "http://localhost:8123"}) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_an_eden_code_window_is_counted_while_it_is_open(client, hub):
    """A window that names itself eden-code is counted on the backend, and let go when it
    closes; an unknown app name counts as none."""
    with client.websocket_connect(f"{WS}?token=s3cret&app=eden-code", headers=ORIGIN) as ws:
        ws.receive_json()
        assert hub.app_windows.get("eden-code") == 1
    assert "eden-code" not in hub.app_windows
    with client.websocket_connect(f"{WS}?token=s3cret&app=nope", headers=ORIGIN) as ws:
        ws.receive_json()
        assert "nope" not in hub.app_windows


def test_a_reconnect_with_a_garbled_since_gets_the_snapshot_alone(client, hub):
    """A since that isn't a number is ignored: the snapshot, no replay."""
    url = f"{WS}?token=s3cret&since=abc&hub={hub.instance_id}"
    with client.websocket_connect(url, headers=ORIGIN) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["replay"] is False


def test_a_reconnecting_window_gets_the_session_events_it_missed(client, hub):
    """From the same backend, the events after the number it names come after the
    snapshot, each with its number."""
    with client.websocket_connect(f"{WS}?token=s3cret", headers=ORIGIN) as ws:
        last = ws.receive_json()["seq"]
    hub.emit("task_log", id=3, entry={"n": 1, "text": "missed"})
    url = f"{WS}?token=s3cret&since={last}&hub={hub.instance_id}"
    with client.websocket_connect(url, headers=ORIGIN) as ws:
        hello = ws.receive_json()
        assert hello["replay"] is True
        missed = ws.receive_json()
        assert missed["type"] == "task_log" and missed["entry"]["text"] == "missed"
        assert missed["seq"] == last + 1


def test_a_long_burst_of_frames_is_all_handled(client):
    """Many frames in one go (past YIELD_EVERY), odd ones among them, are each taken; the
    ask at the end is still answered."""
    with client.websocket_connect(f"{WS}?token=s3cret", headers=ORIGIN) as ws:
        ws.receive_json()
        for n in range(server.YIELD_EVERY * 2):
            ws.send_text("not json" if n % 3 else '{"type": "nothing_like_this"}')
        ws.send_json({"type": "ask", "text": "what's on tomorrow?"})
        seen = _until_done(ws)
        assert any(e["type"] == "reply" for e in seen)


class Scripted(WindowQueue):
    """A window's queue that hands out a fixed list, then waits; an exception in it is
    raised from get()."""

    def __init__(self, items):
        super().__init__()
        self.items = list(items)

    async def get(self):
        if not self.items:
            await asyncio.Event().wait()
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _queue(hub, items):
    queue = Scripted(items)

    def subscribe():
        hub._subscribers.add(queue)
        return queue

    hub.subscribe = subscribe
    return queue


def test_an_event_no_json_can_carry_is_skipped_and_the_rest_go_on(client, hub, caplog):
    """An event with a key JSON can't hold is skipped (logged once per kind); the events
    after it still reach the window, and a queue that cuts the window off closes it with
    4408 so it comes back to a fresh snapshot."""
    late = Event({"type": "late", "n": 1})
    late.seq = 99
    _queue(
        hub,
        [{"type": "odd", (1, 2): "x"}, {"type": "odd", (3,): "y"}, {"type": "fine"}, late, None],
    )
    with caplog.at_level(logging.ERROR, logger="jarvis"):
        with client.websocket_connect(f"{WS}?token=s3cret", headers=ORIGIN) as ws:
            assert ws.receive_json()["type"] == "hello"
            assert ws.receive_json() == {"type": "fine"}
            assert ws.receive_json() == {"type": "late", "n": 1, "seq": 99}
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
    assert closed.value.code == 4408
    assert sum("can't be sent" in r.getMessage() for r in caplog.records) == 1
    assert not hub._subscribers


def test_a_queue_that_fails_under_the_window_closes_it_with_1011(client, hub):
    """A failure while pumping events never leaves the window deaf: it is closed so it
    reconnects."""
    _queue(hub, [RuntimeError("broken")])
    with client.websocket_connect(f"{WS}?token=s3cret", headers=ORIGIN) as ws:
        assert ws.receive_json()["type"] == "hello"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1011


# ── helpers ──


def test_the_chinese_merges_fragments_and_skips_the_ones_it_cant_read(tmp_path, caplog):
    """No base file is no warning; a broken fragment is skipped with one, a fragment that
    isn't an object is ignored, and only string pairs and two-item patterns are kept."""
    (tmp_path / "i18n").mkdir()
    (tmp_path / "i18n" / "a.json").write_text("{broken")
    (tmp_path / "i18n" / "b.json").write_text("[1, 2]")
    (tmp_path / "i18n" / "c.json").write_text(
        '{"strings": {"Hi": "Ni hao", "n": 3}, "patterns": [["a", "b"], ["c"], "d"]}'
    )
    with caplog.at_level(logging.WARNING, logger="jarvis"):
        merged = server.zh_strings(tmp_path)
    assert merged == {"strings": {"Hi": "Ni hao"}, "patterns": [["a", "b"]]}
    said = [r.getMessage() for r in caplog.records]
    assert "i18n: skipped a.json" in said and not any("i18n-zh" in s for s in said)


def test_feature_assets_leave_out_labs_features_that_are_off_and_unreadable_files(tmp_path):
    """Files of a skipped feature, and one that can't be looked at, aren't listed."""
    folder = tmp_path / "features"
    folder.mkdir()
    (folder / "keep.js").write_text("")
    (folder / "keep.css").write_text("")
    (folder / "off.js").write_text("")
    (folder / "gone.js").symlink_to(tmp_path / "missing.js")
    found = server.feature_assets(tmp_path, skip={"off"})
    assert [p.split("?")[0] for p in found["scripts"]] == ["/static/features/keep.js"]
    assert [p.split("?")[0] for p in found["styles"]] == ["/static/features/keep.css"]


def test_the_body_look_falls_back_for_unknown_looks_and_tones():
    """An unknown look is the orb and an unknown tone is dark: nothing odd reaches the page."""
    page = f"<html>{server.BODY}</html>"
    assert 'data-look="orb" data-glass-tone="dark"' in server.body_look(page, "nope", "<x>")


def test_edition_colors_follow_the_owners_choice(hub):
    """Screen-reader mode or colours off: none; an unknown colour: yellow; a broken prefs
    store: yellow."""

    class Prefs:
        def __init__(self, values):
            self.values = values

        def feature(self, name):
            return self.values[name]

    class Hub:
        prefs = Prefs({"a11y_mode": "on", "a11y_colors": "white"})

    assert server.edition_colors(Hub) == "white"
    Hub.prefs = Prefs({"a11y_mode": "off", "a11y_colors": "white"})
    assert server.edition_colors(Hub) == ""
    Hub.prefs = Prefs({"a11y_mode": "on", "a11y_colors": "pink"})
    assert server.edition_colors(Hub) == "yellow"
    Hub.prefs = Prefs({})
    assert server.edition_colors(Hub) == "yellow"
    page = server.daredevil_page('<html lang="en"><body x>', "white")
    assert 'data-contrast="white"' in page and 'data-edition="daredevil"' in page


def test_event_text_turns_nan_and_lone_surrogates_into_something_a_window_reads():
    """NaN and infinities anywhere (in lists and tuples too) become null; a half surrogate
    becomes the replacement character."""
    import json

    text = server.event_text({"a": [float("nan"), (float("inf"), 1)], "b": {"c": float("-inf")}})
    assert json.loads(text) == {"a": [None, [None, 1]], "b": {"c": None}}
    assert "�" in json.loads(server.event_text({"name": "x\udc80"}))["name"]


def test_an_events_own_seq_is_kept_only_when_the_window_cant_take_it_for_a_later_one():
    """A plain dict goes as it is; an Event takes its number unless its own seq could not
    be read as later than what the window has."""
    assert server.numbered({"type": "x"}) == {"type": "x"}
    event = Event({"type": "brain_results", "seq": "w1:3"})
    event.seq = 50
    assert server.numbered(event, 10) is event  # not number-like: kept
    event = Event({"type": "brain_results", "seq": "121"})
    event.seq = 50
    assert server.numbered(event, 10)["seq"] == 50  # would read as later: renumbered
    assert server.numbered(event, 200) is event


@pytest.mark.parametrize(
    ("value", "heard", "later"),
    [
        ("", 0, False),
        ("5", 4, True),
        ("5", 5, False),
        (" 0x1F ", 100, True),
        ("w1:3", 0, False),
        (3, 2, True),
        (2.0, 2, False),
        (float("nan"), 2, True),
        (True, 2, True),
        (None, 2, True),
    ],
)
def test_later_than_reads_a_seq_as_javascript_would(value, heard, later):
    """Digits compare as numbers; other number-like text, NaN and other types count as
    later; text with anything else in it never does."""
    assert server._later_than(value, heard) is later


def test_progress_bars_without_tqdm_are_no_trouble(monkeypatch):
    """No tqdm installed: nothing to set up, and no error."""
    monkeypatch.setitem(sys.modules, "tqdm", None)
    assert server.thread_lock_for_progress_bars() is None


def test_progress_bars_get_a_thread_lock(monkeypatch):
    """With tqdm there, its lock is set to a thread lock (no named semaphore to leak)."""
    import threading

    from tqdm import tqdm

    locks = []
    monkeypatch.setattr(tqdm, "set_lock", lambda lock: locks.append(lock))
    server.thread_lock_for_progress_bars()
    assert len(locks) == 1 and isinstance(locks[0], type(threading.RLock()))


def test_the_listening_line_names_the_port_only():
    """What the backend prints names the port and nothing else."""
    assert server.listening_line(8123) == "JARVIS listening on http://127.0.0.1:8123/"


# ── end_children ──


def _sleeper(ignore_term=False):
    code = "import signal, sys, time\n"
    if ignore_term:
        code += "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    code += "print('ready', flush=True)\ntime.sleep(30)\n"
    child = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE)
    assert child.stdout.readline().strip() == b"ready"
    return child


def test_end_children_ends_the_processes_it_is_given_and_kills_the_stubborn_one(monkeypatch):
    """A child that ends on request is ended; one that ignores the request is killed after
    the grace. Only the children named (this test's own) are touched."""
    import psutil

    polite, stubborn = _sleeper(), _sleeper(ignore_term=True)
    try:
        mine = [psutil.Process(polite.pid), psutil.Process(stubborn.pid)]

        class Me(psutil.Process):
            """This process, as far as end_children can tell, with only this test's
            children (never the test runner's others). psutil checks pids with
            isinstance(..., Process), so this stays a Process."""

            def children(self, recursive=False):
                assert recursive
                return mine

        monkeypatch.setattr(psutil, "Process", Me)
        assert server.end_children(grace=0.5) == 2
        assert polite.wait(timeout=5) is not None and stubborn.wait(timeout=5) is not None
        # (psutil reaped the polite one itself; the stubborn one needed the kill.)
        assert stubborn.returncode == -9
    finally:
        for child in (polite, stubborn):
            if child.poll() is None:
                child.kill()
                child.wait()


def test_end_children_without_psutil_ends_nothing(monkeypatch):
    """No psutil to look with: nothing is ended, and it says none."""
    monkeypatch.setitem(sys.modules, "psutil", None)
    assert server.end_children() == 0


# ── serve ──


@pytest.fixture
def faked_serve(monkeypatch, tmp_path):
    """serve with everything outside it faked: the folder lock, uvicorn, the features,
    the launcher watch, the hub, the file limit and the log folder. The root logger is put
    back as it was."""
    import resource

    import uvicorn

    from jarvis import config as config_module
    from jarvis import features, jsonstore, launcher_watch

    seen = {"ran": [], "closed": 0, "limits": []}

    class Lock:
        def close(self):
            seen["closed"] += 1

    monkeypatch.setattr(prefs_module, "APP_SUPPORT", tmp_path / "support")
    monkeypatch.setattr(jsonstore, "claim_folder", lambda folder, wait=0: Lock())
    monkeypatch.setitem(sys.modules, "sounddevice", None)
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen["ran"].append((app, kw)))
    monkeypatch.setattr(features, "prepare_all", lambda folder: seen.setdefault("prep", folder))
    monkeypatch.setattr(launcher_watch, "start", lambda: seen.setdefault("watch", True))
    monkeypatch.setattr(config_module, "load_settings", lambda: "SETTINGS")

    class FakeHub:
        def __init__(self, settings):
            seen["settings"] = settings

    monkeypatch.setattr(server, "Hub", FakeHub)
    def made(hub, token, **kw):
        seen["share_folder"] = kw.get("share_folder")
        seen["hub"] = hub
        record = server.share_record.read(kw["share_folder"]) if kw.get("share_folder") else None
        seen["record"] = record
        return ("APP", token)

    monkeypatch.setattr(server, "create_app", made)
    monkeypatch.setattr(server, "end_children", lambda: 2)
    monkeypatch.setattr(server, "thread_lock_for_progress_bars", lambda: None)
    monkeypatch.setattr(server.osplat, "IS_WIN", False)
    monkeypatch.setattr(server.osplat, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(resource, "getrlimit", lambda kind: (256, resource.RLIM_INFINITY))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, pair: seen["limits"].append(pair))
    root = logging.getLogger()
    handlers, levels = list(root.handlers), {h: h.level for h in root.handlers}
    noisy = {n: logging.getLogger(n).level for n in ("pypdf", "fontTools", "httpx", "httpx2", "mcp")}
    yield seen
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
            handler.close()
    for handler, level in levels.items():
        handler.setLevel(level)
    for name, level in noisy.items():
        logging.getLogger(name).setLevel(level)


def test_serve_starts_the_app_on_this_machine_only_and_cleans_up_after(
    faked_serve, tmp_path, capsys, monkeypatch
):
    """serve raises the open-file limit, prepares the features, runs the app on 127.0.0.1
    with the frame and shutdown options, prints the port (never the token), ends what is
    left and lets go of the folder last. Run by the app, stderr gets warnings only."""
    monkeypatch.setenv("JARVIS_LAUNCHER_PID", "1")
    server.serve(8123, "tok3n")
    seen = faked_serve
    assert seen["ran"] == [(("APP", "tok3n"), {"host": "127.0.0.1", "port": 8123, **server.SERVE_OPTIONS})]
    assert seen["settings"] == "SETTINGS" and seen["prep"] == tmp_path / "support"
    assert seen["watch"] is True and seen["closed"] == 1
    assert seen["limits"] == [(4096, __import__("resource").RLIM_INFINITY)]
    out = capsys.readouterr().out
    assert "127.0.0.1:8123" in out and "tok3n" not in out
    assert (tmp_path / "logs").is_dir()
    assert logging.getLogger("httpx").level == logging.ERROR
    # It said where it is once it held the folder (share_record.py), and took that away
    # as it stopped, before letting go of the folder.
    assert seen["share_folder"] == tmp_path / "support"
    assert seen["record"]["port"] == 8123 and seen["record"]["token"] == "tok3n"
    assert server.share_record.read(tmp_path / "support") is None


def test_serve_ends_with_76_once_it_has_handed_the_data_over(faked_serve, tmp_path, monkeypatch):
    """/share/shutdown (a newer app taking over): the app that started this backend reads
    76 as "open on the new one", never as a crash to restart (app/main.js)."""
    import uvicorn

    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: setattr(faked_serve["hub"], "handed_over", True))
    with pytest.raises(SystemExit) as stop:
        server.serve(8123, "tok3n")
    assert stop.value.code == server.share_record.HANDED_OVER == 76
    assert faked_serve["closed"] == 1
    assert server.share_record.read(tmp_path / "support") is None


def test_a_sigterm_still_cleans_up_before_the_process_ends(faked_serve, tmp_path, monkeypatch):
    """uvicorn stops gently on SIGTERM, then raises it again with the handler it found: the
    default one ended the process before the record was taken away and the children ended.
    Now serve's own handler only notes it, cleans up, and raises it for real at the end."""
    import signal

    import uvicorn

    before = signal.getsignal(signal.SIGTERM)
    raised = []
    monkeypatch.setattr(signal, "raise_signal", lambda sig: raised.append(sig))
    # what uvicorn's capture_signals does after a SIGTERM: re-raise into the handler it found
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None))
    try:
        server.serve(8123, "tok3n")
    finally:
        signal.signal(signal.SIGTERM, before)
    assert raised == [signal.SIGTERM]
    assert faked_serve["closed"] == 1
    assert server.share_record.read(tmp_path / "support") is None


def test_serve_says_so_and_exits_75_when_another_backend_holds_the_folder(
    faked_serve, monkeypatch, capsys
):
    """A second backend on the same data folder never starts: it explains and exits with
    EX_TEMPFAIL so the app tries again later."""
    from jarvis import jsonstore

    def taken(folder, wait=0):
        raise jsonstore.FolderTaken(35, "held by another backend")

    monkeypatch.setattr(jsonstore, "claim_folder", taken)
    with pytest.raises(SystemExit) as stopped:
        server.serve(8123, "tok3n")
    assert stopped.value.code == 75
    assert "held by another backend" in capsys.readouterr().err
    assert faked_serve["ran"] == []
