"""Eden Code as an app of its own (app/flavor.js): its page (/?app=code), the backend it
starts (JARVIS_PROFILE=code: no microphone, voice or screen watching), and a J.A.R.V.I.S.
window joining that backend, which wakes what it left off (hub.window_joined)."""

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
    assert hub.snapshot()["profile"] == "full"


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
    assert "<title>Jarvis</title>" in jarvis and 'data-app="eden-code"' not in jarvis


def test_eden_code_wears_ask_eden_s_look_whatever_jarvis_wears(client):
    client.hub.prefs.look = "obsidian"
    assert 'data-skin="obsidian"' in client.get("/").text
    page = client.get("/?app=code").text
    assert 'data-skin="obsidian"' not in page and 'data-look="orb"' in page


def test_eden_code_page_marks_only_the_first_body():
    html = '<title>Jarvis</title><body data-state="idle"><p>a <body x></p>'
    out = eden_code_page(html)
    assert out.count('data-app="eden-code"') == 1 and "<title>Eden Code</title>" in out


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
    assert "<title>Jarvis</title>" in plain and "data-edition" not in plain and "data-contrast" not in plain
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
    assert "data-contrast" not in page and 'data-edition="daredevil"' in page  # (the page still says what it is)


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
    assert out.count('data-edition="daredevil"') == 1 and "<title>J.A.R.V.I.S. Daredevil</title>" in out
    assert out.count("data-contrast") == 1


def test_the_hub_knows_its_edition_from_what_the_app_started_it_with(monkeypatch, settings, quiet_speaker, isolated):
    monkeypatch.setenv("JARVIS_EDITION", "daredevil")
    assert make_hub(settings, quiet_speaker, isolated).edition == "daredevil"
    monkeypatch.setenv("JARVIS_EDITION", "something else")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""
    monkeypatch.delenv("JARVIS_EDITION")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""
