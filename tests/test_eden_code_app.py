"""Eden Code as an app of its own (app/flavor.js): its page (/?app=code), the backend it
starts (JARVIS_PROFILE=code: no microphone, voice or screen watching), and a J.A.R.V.I.S.
window joining that backend, which wakes what it left off (hub.window_joined)."""

from pathlib import Path

import pytest
from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient

from jarvis.hub import Hub
from jarvis.server import APPS, create_app, daredevil_page, eden_code_page, edition_colors

BASE = "http://127.0.0.1:8123"
WS = "ws://127.0.0.1:8123/ws"


class Transcriber:
    def __init__(self):
        self.warmed = 0

    def warm_up(self):
        self.warmed += 1

    def transcribe(self, _audio):
        return ""


def make_hub(settings, speaker, isolated, transcriber=None):
    class Client(FakeClient):
        script = CALENDAR_TURN

    return Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=transcriber or Transcriber(),
        poll=False,
        **isolated,
    )


def test_the_profile_comes_from_the_app_that_started_it(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    assert make_hub(settings, quiet_speaker, isolated).profile == "full"
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    assert make_hub(settings, quiet_speaker, isolated).profile == "code"
    monkeypatch.setenv("JARVIS_PROFILE", "anything else")
    assert make_hub(settings, quiet_speaker, isolated).profile == "full"


async def test_a_code_backend_opens_no_microphone_until_jarvis_joins(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.hands_free = True  # on in J.A.R.V.I.S.'s settings
    hub.prefs.screen_aware = True
    listening, watching = [], []
    hub._apply_hands_free = lambda: listening.append(True)
    hub.screen_watch.start = lambda: watching.append(True)
    await hub.start()
    assert (listening, watching) == ([], [])
    assert hub.transcriber.warmed == 0  # the speech model isn't even loaded

    q = hub.subscribe()
    hub.window_joined("eden-code")  # Eden Code's own window: still nothing
    assert (listening, watching, hub.profile) == ([], [], "code")
    hub.window_joined("jarvis")  # a J.A.R.V.I.S. window: the assistant wakes
    assert (listening, watching, hub.profile) == ([True], [True], "full")
    assert hub.transcriber.warmed == 1
    hub.window_joined("jarvis")  # a second one wakes nothing again
    assert listening == [True]
    events = [q.get_nowait() for _ in range(q.qsize())]
    counts = [e["windows"] for e in events if e["type"] == "app_windows"]
    assert counts[-1] == {"eden-code": 1, "jarvis": 2}
    hub.window_left("jarvis")
    hub.window_left("jarvis")
    hub.window_left("jarvis")  # one too many never goes below none
    assert hub.app_windows == {"eden-code": 1}
    assert hub.snapshot()["app_windows"] == {"eden-code": 1}
    # the last J.A.R.V.I.S. window gone: Eden Code's profile again (CH4)
    assert hub.snapshot()["profile"] == "code"


async def test_the_last_jarvis_window_leaving_stops_what_it_woke(
    settings, quiet_speaker, isolated, monkeypatch
):
    """CH4: a J.A.R.V.I.S. window joined Eden Code's backend and quit; the backend stays
    (Eden Code owns it) and must stop listening, watching and its voice loops."""
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()

    class Listener:
        running = True
        stopped = 0

        def stop(self):
            self.stopped += 1

    mic = Listener()
    hub._apply_hands_free = lambda: setattr(hub, "_listener", mic)
    hub.prefs.hands_free = True
    hub.prefs.screen_aware = True
    watching = []
    hub.screen_watch.start = lambda: watching.append("on")
    hub.screen_watch.stop = lambda: watching.append("off")
    hub.poll = True  # so the voice loops are started (and must be cancelled)

    async def forever():
        await __import__("asyncio").sleep(3600)

    hub._spawn_voice_loops = lambda: [hub._spawn(forever()) for _ in range(2)]
    hub._briefing_clock = forever
    hub._spawn_eden_loops = lambda: None  # (the Mail, calendar and file loops: not in a test)
    hub.window_joined("eden-code")
    hub.window_joined("jarvis")
    started = list(hub._joined_voice)
    assert hub.profile == "full" and hub._listener is mic and len(started) == 3
    hub.window_joined("jarvis")
    hub.window_left("jarvis")  # one J.A.R.V.I.S. window still open: nothing changes
    assert hub.profile == "full" and mic.stopped == 0
    hub.window_left("jarvis")
    assert hub.profile == "code"
    assert mic.stopped == 1 and hub._listener is None
    assert watching[-1] == "off"
    await __import__("asyncio").sleep(0)
    assert all(t.cancelled() for t in started)
    assert hub.prefs.hands_free is True  # the settings stay as they were
    hub.window_left("eden-code")  # Eden Code's own window leaving changes nothing
    assert hub.profile == "code"


async def test_jarvis_s_own_backend_stays_full_when_its_windows_go(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub.window_joined("jarvis")
    hub.window_left("jarvis")
    assert hub.profile == "full"


async def test_jarvis_s_own_backend_listens_as_before(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.hands_free = True
    listening = []
    hub._apply_hands_free = lambda: listening.append(True)
    await hub.start()
    assert listening == [True]
    assert hub.profile == "full"


@pytest.fixture
def client(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    with TestClient(create_app(hub, "s3cret"), base_url=BASE) as c:
        c.hub = hub
        yield c


def test_eden_code_s_page_is_the_same_page_marked_for_eden_code(client):
    page = client.get("/?app=code").text
    assert "<title>Eden Code</title>" in page
    assert '<body data-app="eden-code" class="eden-code" data-state="idle"' in page
    assert "/static/eden-code.css" in page
    jarvis = client.get("/").text
    assert "<title>Eden</title>" in jarvis and 'data-app="eden-code"' not in jarvis


def test_eden_code_wears_ask_eden_s_look_whatever_jarvis_wears(client):
    client.hub.prefs.look = "obsidian"
    assert 'data-skin="obsidian"' in client.get("/").text
    page = client.get("/?app=code").text
    assert 'data-skin="obsidian"' not in page and 'data-look="orb"' in page


def test_eden_code_page_marks_only_the_first_body():
    html = '<title>Jarvis</title><body data-state="idle"><p>a <body x></p>'
    out = eden_code_page(html)
    assert out.count('data-app="eden-code"') == 1 and "<title>Eden Code</title>" in out


def test_eden_code_s_page_leaves_the_second_brain_s_stars_out(client):
    """r3 optimization: galaxy.js (the second brain's stars, never shown in Eden Code) isn't
    loaded there; app.js stands in for it. Eden's own page keeps it."""
    page = client.get("/?app=code").text
    assert "/static/galaxy.js" not in page and "/static/app.js?v=" in page
    assert "/static/galaxy.js?v=" in client.get("/").text
    app = (Path(__file__).resolve().parents[1] / "src/jarvis/web/app.js").read_text()
    assert (
        "const galaxy = window.Galaxy ? new window.Galaxy($('galaxy-canvas')) : new Proxy(" in app
    )


def test_the_assistants_own_notices_skip_eden_code_s_window(settings, quiet_speaker, isolated):
    """CH3-10: Eden's hearing toasts ("Getting my hearing ready…", "I couldn't download my
    speech model… restart me") reached Eden Code's window too."""
    hub = make_hub(settings, quiet_speaker, isolated)
    code = hub.subscribe()
    code.app = "eden-code"
    eden = hub.subscribe()
    eden.app = "jarvis"
    hub.emit("toast", title="Speech", text="Getting my hearing ready.", eden_only=True)
    hub.emit("toast", title="Saved", text="for every window")
    seen = lambda q: [q.get_nowait() for _ in range(q.qsize())]  # noqa: E731
    assert [e["text"] for e in seen(eden)] == ["Getting my hearing ready.", "for every window"]
    got = seen(code)
    assert [e["text"] for e in got] == ["for every window"]
    assert all("eden_only" not in e for e in got)
    hub.unsubscribe(code)
    hub.unsubscribe(eden)


def test_windows_say_which_app_they_are(client):
    hub = client.hub
    with client.websocket_connect(
        f"{WS}?token=s3cret&app=eden-code", headers={"origin": BASE}
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["app_windows"] == {"eden-code": 1}
        with client.websocket_connect(
            f"{WS}?token=s3cret&app=jarvis", headers={"origin": BASE}
        ) as jw:
            assert jw.receive_json()["app_windows"] == {"eden-code": 1, "jarvis": 1}
            while (ev := ws.receive_json())["type"] != "app_windows":
                pass
            assert ev["windows"] == {"eden-code": 1, "jarvis": 1}
        while (ev := ws.receive_json())["type"] != "app_windows":
            pass
        assert ev["windows"] == {"eden-code": 1}
    assert hub.app_windows == {}
    # a name that isn't an app counts as none
    with client.websocket_connect(f"{WS}?token=s3cret&app=evil", headers={"origin": BASE}) as ws:
        assert ws.receive_json()["app_windows"] == {}
    assert APPS == {"jarvis", "eden-code"}


# ── J.A.R.V.I.S. Daredevil: the same page, the same backend, opened in screen-reader mode ──


def test_daredevil_s_page_is_named_marked_and_in_its_colours_from_the_first_paint(client):
    page = client.get("/?edition=daredevil").text
    assert "<title>J.A.R.V.I.S. Daredevil</title>" in page
    assert '<html lang="en" data-contrast="yellow">' in page
    assert '<body data-edition="daredevil" data-state="idle"' in page
    plain = client.get("/").text
    assert (
        "<title>Eden</title>" in plain
        and "data-edition" not in plain
        and "data-contrast" not in plain
    )
    # a word that isn't the edition is no edition
    assert "data-edition" not in client.get("/?edition=other").text


def test_daredevil_s_page_follows_the_owners_colours_and_a_switched_off_mode(client):
    prefs = {"a11y_mode": "auto", "a11y_colors": "white"}
    client.hub.prefs.feature = lambda key: prefs.get(key)
    assert 'data-contrast="white"' in client.get("/?edition=daredevil").text
    prefs["a11y_colors"] = "off"
    assert "data-contrast" not in client.get("/?edition=daredevil").text
    prefs.update(a11y_colors="auto", a11y_mode="off")
    page = client.get("/?edition=daredevil").text
    assert (
        "data-contrast" not in page and 'data-edition="daredevil"' in page
    )  # (the page still says what it is)


def test_edition_colors_are_a_known_pairing_or_nothing():
    class Hub:
        def __init__(self, **prefs):
            self.prefs = type("P", (), {"feature": staticmethod(lambda key: prefs.get(key))})()

    assert edition_colors(Hub(a11y_mode="auto", a11y_colors="auto")) == "yellow"
    assert edition_colors(Hub(a11y_mode="on", a11y_colors="yellow-blue")) == "yellow-blue"
    assert edition_colors(Hub(a11y_mode="on", a11y_colors="<script>")) == "yellow"
    assert edition_colors(Hub(a11y_mode="off", a11y_colors="auto")) == ""
    assert edition_colors(Hub(a11y_mode="auto", a11y_colors="off")) == ""
    assert edition_colors(object()) == "yellow"  # (a hub that can't say)


def test_daredevil_page_marks_only_the_first_body():
    html = '<html lang="en"><title>Jarvis</title><body data-state="idle"><p>a <body x></p>'
    out = daredevil_page(html)
    assert (
        out.count('data-edition="daredevil"') == 1
        and "<title>J.A.R.V.I.S. Daredevil</title>" in out
    )
    assert out.count("data-contrast") == 1


def test_the_hub_knows_its_edition_from_what_the_app_started_it_with(
    monkeypatch, settings, quiet_speaker, isolated
):
    monkeypatch.setenv("JARVIS_EDITION", "daredevil")
    assert make_hub(settings, quiet_speaker, isolated).edition == "daredevil"
    monkeypatch.setenv("JARVIS_EDITION", "something else")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""
    monkeypatch.delenv("JARVIS_EDITION")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""


async def test_voice_coding_in_eden_code_alone_fetches_no_speech_model(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    """CH5: the voice button in Eden Code alone: nothing listens there, so the larger
    (~480 MB) speech model isn't fetched; a J.A.R.V.I.S. window joining fetches it."""
    import jarvis.listen as listen

    warmed = []

    class Big:
        def __init__(self, model, language):
            self.model = model

        def warm_up(self):
            warmed.append(self.model)

        def loaded(self):
            return False

    monkeypatch.setattr(listen, "Transcriber", Big)
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    ears = Transcriber()
    ears.model_name = "small"  # looks like the real one, not a test fake
    hub = make_hub(settings, quiet_speaker, isolated, transcriber=ears)
    await hub.start()

    class Task:
        cwd = tmp_path
        id = 1

    await hub._prepare_code_listening(Task())
    assert warmed == [] and hub._code_stt is None
    monkeypatch.setattr(type(hub.voicecode), "task", property(lambda self: Task()))
    hub._start_listening = lambda: None
    hub.window_joined("jarvis")
    for _ in range(50):
        if warmed:
            break
        await __import__("asyncio").sleep(0.01)
    assert len(warmed) == 1


def test_eden_code_s_page_draws_without_the_network(client):
    """CH23: Eden Code's page asks Google Fonts for nothing (its look falls back to the
    system fonts); the window's favicon request is answered, not a 404."""
    page = client.get("/?token=s3cret&app=code").text
    assert "fonts.googleapis.com/css2" not in page
    assert client.get("/favicon.ico").status_code == 204


async def test_eden_code_alone_starts_none_of_edens_own_loops_until_an_eden_window_joins(
    settings, quiet_speaker, isolated, monkeypatch
):
    """Heads-ups from Mail and Messages, the calendar's next event, suggestion cards, the
    file index, the markets and the features' loops of that kind (hub.EDEN_ONLY_LOOPS) read
    the owner's data on their own: Eden Code alone never asked for them. An Eden window
    starts them, once; Eden Code's own loops (and the owner's routines, lines and alerts) run
    from the start."""
    import asyncio

    from jarvis import hub as hubmod

    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.poll = True
    started: list[str] = []

    def spawn(coro):
        started.append(getattr(coro, "__qualname__", repr(coro)))
        coro.close()  # nothing really runs
        done = asyncio.get_running_loop().create_future()
        done.set_result(None)
        return done

    monkeypatch.setattr(hub, "_spawn", spawn)
    hub._loops = [
        ("code_pr_watch", lambda: asyncio.sleep(0)),
        ("calendar_look", lambda: asyncio.sleep(0)),
    ]
    feature_loops = []
    monkeypatch.setattr(
        hub, "_feature_loop", lambda name, factory: feature_loops.append(name) or asyncio.sleep(0)
    )
    await hub.start()
    eden_only = {
        "Hub._poll_status",
        "Interrupter.run",
        "Suggester.run",
        "Watcher.run",
        "keep_fresh",
        "Hub._markets_loop",
        "Shortcuts.refresh",
    }
    assert not eden_only & set(started), eden_only & set(started)
    assert {"Hub._vitals_loop", "Hub._awake_loop", "Hub._routine_clock"} <= set(started)
    assert feature_loops == ["code_pr_watch"]
    hub.window_joined("eden-code")  # Eden Code's own window: still none
    assert not eden_only & set(started)
    monkeypatch.setattr(hub, "_connect_soon", lambda: None)
    hub.window_joined("jarvis")
    assert eden_only <= set(started)
    assert feature_loops == ["code_pr_watch", "calendar_look"]
    count = len(started)
    hub.window_joined("jarvis")  # started once: a second Eden window starts nothing again
    hub.window_left("jarvis")  # (one of the two left: they keep running)
    assert sum(1 for s in started[count:] if s in eden_only) == 0
    assert hub._eden_loops
    # The last Eden window leaving stops them (CA2-7); the next one starts them again, once.
    hub.window_left("jarvis")
    assert hub._eden_loops == []
    hub.window_joined("jarvis")
    assert sorted(s for s in started[count:] if s in eden_only) == sorted(eden_only)
    assert hubmod.EDEN_ONLY_LOOPS >= {"calendar_look", "mail_index", "oura"}


async def test_edens_own_backend_starts_its_loops_at_once(
    settings, quiet_speaker, isolated, monkeypatch
):
    import asyncio

    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.poll = True
    started: list[str] = []

    def spawn(coro):
        started.append(getattr(coro, "__qualname__", repr(coro)))
        coro.close()
        done = asyncio.get_running_loop().create_future()
        done.set_result(None)
        return done

    monkeypatch.setattr(hub, "_spawn", spawn)
    monkeypatch.setattr(hub, "_start_listening", lambda: None)
    await hub.start()
    eden_only = {"Hub._poll_status", "Interrupter.run", "Hub._markets_loop", "keep_fresh"}
    assert eden_only <= set(started)


def test_the_hud_loops_look_only_while_a_window_that_shows_the_hud_is_open(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert not hub._hud_watched()
    code = hub.subscribe()
    code.app = "eden-code"
    assert not hub._hud_watched()  # Eden Code's window hides the HUD: no samples for it
    eden = hub.subscribe()
    eden.app = "jarvis"
    assert hub._hud_watched()
    hub.unsubscribe(eden)
    other = hub.subscribe()  # a window that didn't say which app it is: as before
    assert hub._hud_watched()
    hub.unsubscribe(other)
    hub.unsubscribe(code)
