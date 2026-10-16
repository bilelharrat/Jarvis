"""Eden Code as an app of its own (app/flavor.js): its page (/?app=code), the backend it
starts (JARVIS_PROFILE=code: no microphone, voice or screen watching), and a Jarvis.
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
    hub.prefs.hands_free = True  # on in Jarvis's settings
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
    hub.window_joined("jarvis")  # a Jarvis window: the assistant wakes
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
    assert "<title>Eden Secretary</title>" in jarvis and 'data-app="eden-code"' not in jarvis


def test_eden_code_wears_ask_eden_s_look_whatever_jarvis_wears(client):
    client.hub.prefs.look = "obsidian"
    assert 'data-skin="obsidian"' in client.get("/").text
    page = client.get("/?app=code").text
    assert 'data-skin="obsidian"' not in page and 'data-look="orb"' in page


def test_eden_code_page_marks_only_the_first_body():
    html = '<title>Eden Secretary</title><body data-state="idle"><p>a <body x></p>'
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
    assert "<title>Eden Daredevil</title>" in page
    assert '<html lang="en" data-contrast="yellow">' in page
    assert '<body data-edition="daredevil" data-state="idle"' in page
    plain = client.get("/").text
    assert "<title>Eden Secretary</title>" in plain and "data-edition" not in plain and "data-contrast" not in plain
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
    html = '<html lang="en"><title>Eden Secretary</title><body data-state="idle"><p>a <body x></p>'
    out = daredevil_page(html)
    assert out.count('data-edition="daredevil"') == 1 and "<title>Eden Daredevil</title>" in out
    assert out.count("data-contrast") == 1


def test_the_hub_knows_its_edition_from_what_the_app_started_it_with(monkeypatch, settings, quiet_speaker, isolated):
    monkeypatch.setenv("JARVIS_EDITION", "daredevil")
    assert make_hub(settings, quiet_speaker, isolated).edition == "daredevil"
    monkeypatch.setenv("JARVIS_EDITION", "something else")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""
    monkeypatch.delenv("JARVIS_EDITION")
    assert make_hub(settings, quiet_speaker, isolated).edition == ""


# ── the second brain: Eden Code alone reads none of the owner's own life (F8) ──


def _no_personal_reads(monkeypatch, tmp_path):
    """Every personal source's reader is a trap (the real ones would open Notes, Mail,
    Messages and Photos); the app's own folders point at an empty temp folder."""
    from jarvis import brain_sources, knowledge, sources

    read = []

    def trap(name):
        def reader(*_a, **_k):
            read.append(name)
            return []

        return reader

    monkeypatch.setattr(knowledge, "collect_apple_notes", trap("notes"))
    for name in ("collect_mail_fast", "collect_messages", "collect_photos", "collect_computer"):
        monkeypatch.setattr(sources, name, trap(name))
    for name in ("collect_safari", "collect_bookmarks", "collect_reminders"):
        monkeypatch.setattr(brain_sources, name, trap(name))
    for name in ("RESEARCH_DIR", "MEETINGS_DIR", "VIDEOS_DIR"):
        monkeypatch.setattr(knowledge, name, tmp_path / "none")
    return read


def test_withheld_sources_are_never_read_and_keep_what_was_read_before(tmp_path, monkeypatch):
    from jarvis import brain_sources
    from jarvis.knowledge import Collector, KnowledgeBase, Note

    read = _no_personal_reads(monkeypatch, tmp_path)
    kb = KnowledgeBase(tmp_path / "index.json")
    kept = Note(id="notes:1", title="Groceries", text="eggs", source="notes", group="Notes", ref="1")
    kb.build({"notes": [kept]})
    summary = Collector(kb, None).run(
        notes=True,
        bsh=False,
        folders=[],
        computer=True,
        photos=True,
        mail=True,
        messages=True,
        extra={"safari": brain_sources.collect_safari},
        withhold=brain_sources.PERSONAL,
    )
    assert read == []
    assert summary["by_source"].get("notes") == 1 and kb.get("notes:1") is not None


def test_the_rebuild_process_honours_withhold(tmp_path, monkeypatch, capsys):
    import json
    import sys

    from jarvis import brain_build, osplat

    read = _no_personal_reads(monkeypatch, tmp_path)
    monkeypatch.setattr(osplat, "lower_priority", lambda: None)  # (not this test process)
    args = {
        "store": str(tmp_path / "brain" / "index.json"),
        "notes": True,
        "mail": True,
        "messages": True,
        "photos": True,
        "computer": True,
        "folders": [],
        "withhold": ["notes", "mail", "messages", "photos", "computer"],
    }
    monkeypatch.setattr(sys, "argv", ["brain_build", json.dumps(args)])
    try:
        brain_build.main()
    finally:
        if brain_build._lock is not None:
            brain_build._lock.close()
            brain_build._lock = None
    assert read == [] and '"done"' in capsys.readouterr().out


async def _rebuild_args(hub, monkeypatch):
    import asyncio
    import json

    asked = []

    async def spawn(*argv, **_kw):
        asked.append(json.loads(argv[-1]))
        raise RuntimeError("no process in a test")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    await hub.rebuild_brain()
    return asked[0]


async def test_eden_code_alone_withholds_notes_mail_messages_and_photos(
    settings, quiet_speaker, isolated, monkeypatch
):
    """The real-UI check found Eden Code alone reading 517 of the owner's Apple Notes."""
    from jarvis.brain_sources import PERSONAL

    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.brain_notes = hub.prefs.brain_mail = hub.prefs.brain_messages = True
    args = await _rebuild_args(hub, monkeypatch)
    assert {"notes", "mail", "messages", "photos", "computer"} <= set(args["withhold"])
    assert set(args["withhold"]) == PERSONAL
    hub.window_joined("jarvis")  # an Eden Secretary window: its brain reads them again
    assert "withhold" not in await _rebuild_args(hub, monkeypatch)


async def test_eden_secretary_s_brain_withholds_nothing(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    assert "withhold" not in await _rebuild_args(hub, monkeypatch)


# Every background loop a hub starts, by side. PERSONAL: what reads the owner's own life
# (calendar, mail, texts, contacts, calls, Focus…) or talks to services only Eden Secretary
# uses (Twilio, WhatsApp, markets, the weather…): none of it on Eden Code alone. The rest
# are Eden Code's own or touch nothing of the owner's. A new loop fails the first test
# below until it's put on one side (hub.PERSONAL_LOOPS for a feature's loop).
PERSONAL_BUILT_IN = {
    "Hub._refresh_recent",
    "Shortcuts.refresh",
    "Watcher.run",
    "Interrupter.run",
    "Suggester.run",
    "DelegateEngine.run",
    "Answering.run",
    "keep_fresh",
    "Hub._routine_clock",
    "Hub._markets_loop",
    "Hub._defense_loop",
}
EDEN_CODE_S_OWN = {
    "Hub._poll_status",  # the battery (and the calendar only on Eden Secretary's: below)
    "Hub.rebuild_brain",  # withholding the personal sources (the test above)
    "Hub._vitals_loop",
    "Hub._plan_loop",
    "Hub._sysmon_loop",
    "Hub._awake_loop",
    "Hub._number_gemini_starters",
    "DesktopHands.watch",  # lets go of a held button
    "AXProbe.prepare",  # the accessibility probe
} | {
    f"feature:{name}"
    for name in (
        # Eden Code's own
        "code-secrets-sweep",
        "code_answers_digest",
        "code_containers_tidy",
        "code_copies_sweeper",
        "code_handoff_watch",
        "code_index_tidy",
        "code_issue_watch",
        "code_pairing",
        "code_pr_review_watch",
        "code_pr_watch",
        "code_queue_tick",
        "code_sessions",
        "code_stack_watch",
        "code_triggers_listener",
        "code_api_listener",  # the local API, on 127.0.0.1 only while its switch is on
        "code_automate_hooks",  # the webhooks' listener, only while they're on
        "code_automate_watches",  # a project's files, only while watches are on
        "code_usage_midnight",
        "code_verify",
        "code_voice_journal",
        "model_router_nightly",
        "openai_relay",
        # the app's own, touching nothing of the owner's life
        "account",  # the Eden account and its relay (Eden Plus answers Eden Code too)
        "brain_semantic_warm",  # the search model, on this Mac
        "companion_live",  # the phone's Live Activities it asked for (Eden Code sessions)
        "crash_reports",
        "defense_watch",  # FileVault, the firewall, SIP, Gatekeeper turned off
        "ops_daily_backup",
        "quality_keeper",
        "voice_ears",  # voice coding's ears and voice (no microphone until asked)
        "voice_id_setup",
        "voice_setup",
    )
}


def _loop_name(coro) -> str:
    """A spawned coroutine's name: a feature loop by the name it registered with."""
    if coro.__qualname__ == "Hub._feature_loop":
        return "feature:" + coro.cr_frame.f_locals["name"]
    return coro.__qualname__


def _trap_personal_readers(monkeypatch):
    """Everything that reads the owner's calendar or talks to the Mac's apps blows up, so a
    loop that slipped through can't touch anything real even if it ran."""
    from jarvis import hub as hub_module
    from jarvis import mac_tools

    async def trap(*_a, **_k):
        raise AssertionError("a personal reader ran on Eden Code alone")

    monkeypatch.setattr(hub_module, "next_event", trap)
    monkeypatch.setattr(mac_tools, "run_applescript", trap)
    monkeypatch.setattr(mac_tools, "run_command", trap)


def _recording_hub(settings, speaker, isolated):
    """A hub that polls as the app's does, its background tasks listed and never run."""

    class Client(FakeClient):
        script = CALENDAR_TURN

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=True,
        **isolated,
    )
    started: list[str] = []

    def spawn(coro):
        started.append(_loop_name(coro))
        coro.close()  # listed, never run

    hub._spawn = spawn
    hub.started = started
    return hub


async def test_eden_code_alone_starts_no_loop_that_reads_the_owner_s_life(
    settings, quiet_speaker, isolated, monkeypatch
):
    """The log showed "answering: couldn't read the calendar" every ten minutes in Eden Code
    alone: the calls answering read the Calendar and asked Twilio, for nobody."""
    from jarvis.hub import PERSONAL_LOOPS

    monkeypatch.setenv("JARVIS_PROFILE", "code")
    _trap_personal_readers(monkeypatch)
    hub = _recording_hub(settings, quiet_speaker, isolated)
    hub._relay_if_needed = _nothing
    feature_loops = {name for name, _factory in hub._loops}
    assert PERSONAL_LOOPS <= feature_loops | {"reminders", "mail_index"}  # (PC-only two)
    await hub.start()
    started = set(hub.started)
    personal = PERSONAL_BUILT_IN | {f"feature:{n}" for n in PERSONAL_LOOPS}
    assert not started & personal, sorted(started & personal)
    assert started <= EDEN_CODE_S_OWN, sorted(started - EDEN_CODE_S_OWN)  # each one said
    # The status poll asks the battery, never the Calendar.
    status = await _one_status_tick(hub, monkeypatch)
    assert "next_event" not in status


async def test_an_eden_secretary_window_starts_them(
    settings, quiet_speaker, isolated, monkeypatch
):
    from jarvis.hub import PERSONAL_LOOPS

    monkeypatch.setenv("JARVIS_PROFILE", "code")
    _trap_personal_readers(monkeypatch)
    hub = _recording_hub(settings, quiet_speaker, isolated)
    hub._relay_if_needed = _nothing
    hub._start_listening = lambda: None
    await hub.start()
    before = len(hub.started)
    hub.window_joined("eden-code")  # Eden Code's own window: still nothing
    assert len(hub.started) == before
    hub.window_joined("jarvis")
    joined = set(hub.started[before:])
    registered = {name for name, _factory in hub._loops}
    assert PERSONAL_BUILT_IN <= joined
    assert {f"feature:{n}" for n in PERSONAL_LOOPS & registered} <= joined
    count = len(hub.started)
    hub.window_left("jarvis")
    hub.window_joined("jarvis")  # once is enough: nothing started twice
    assert len(hub.started) == count


async def test_eden_secretary_s_backend_starts_them_at_once(
    settings, quiet_speaker, isolated, monkeypatch
):
    from jarvis.hub import PERSONAL_LOOPS

    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = _recording_hub(settings, quiet_speaker, isolated)
    hub._relay_if_needed = _nothing
    hub._start_listening = lambda: None
    hub._warm_up_ears = lambda: None
    await hub.start()
    started = set(hub.started)
    registered = {name for name, _factory in hub._loops}
    assert PERSONAL_BUILT_IN <= started
    assert {f"feature:{n}" for n in PERSONAL_LOOPS & registered} <= started
    assert len(hub.started) == len(set(hub.started))  # each once


async def _nothing():
    return None


async def _one_status_tick(hub, monkeypatch):
    """_poll_status's first tick (the one that would read the Calendar), then stopped."""
    import asyncio
    import contextlib

    from jarvis import hub as hub_module

    monkeypatch.setattr(hub_module, "battery", lambda: {"percent": 50})
    hub.emit = lambda *_a, **_k: None
    task = asyncio.ensure_future(hub._poll_status())
    await asyncio.sleep(0.05)
    assert not task.done(), task.exception()  # (the Calendar trap would have ended it)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return dict(hub.status)
