"""Screen-reader mode (features/accessibility.py): who speaks, and how Claude writes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from jarvis.features import accessibility
from jarvis.prefs import FEATURE_PREFS, clean_feature_values
from jarvis.speech import Speaker, is_silent


@pytest.fixture(autouse=True)
def _the_window_is_believed(monkeypatch):
    """(On a PC JARVIS asks Windows whether a screen reader runs; these tests are about the window's
    word, so Windows has no answer, unless a test says otherwise.)"""
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: None)


def installed(**prefs):
    values = {
        "a11y_mode": "auto",
        "a11y_voice": "reader",
        "a11y_verbosity": "normal",
        **prefs,
    }
    contexts, commands, emitted, loops = [], {}, [], []
    hub = SimpleNamespace(
        register_loop=lambda name, factory: loops.append((name, factory)),
        prefs=SimpleNamespace(feature=lambda key: values.get(key)),
        speaker=Speaker("", 190),
        add_request_context=contexts.append,
        register_command=lambda kind, handler, **_: commands.__setitem__(kind, handler),
        emit=lambda kind, **data: emitted.append((kind, data)),
        set_prefs=lambda changes, from_tool=False: [],
    )
    accessibility.install(hub)
    return hub, contexts[0], commands, emitted


def ask(context, text="what's next?", display=None):
    return asyncio.run(context(text, display))


def test_it_does_nothing_until_a_screen_reader_is_there_or_it_is_switched_on():
    hub, context, commands, _ = installed()
    assert ask(context) is None
    assert not hub.speaker.silent
    commands["a11y_state"]({"screen_reader": True})
    assert "blind" in ask(context)["note"]
    assert hub.speaker.silent  # the screen reader reads the replies


def test_on_means_on_even_without_a_detected_screen_reader_and_off_means_off():
    hub, context, commands, _ = installed(a11y_mode="on")
    assert ask(context) is not None and hub.speaker.silent
    hub, context, commands, _ = installed(a11y_mode="off")
    commands["a11y_state"]({"screen_reader": True})
    assert ask(context) is None and not hub.speaker.silent


def test_in_the_daredevil_edition_auto_is_on_and_off_is_still_off():
    hub, context, commands, emitted = installed(a11y_mode="auto", a11y_voice="auto")
    hub.edition = "daredevil"
    assert ask(context) is not None  # no screen reader running, and it is on
    commands["a11y_state"]({"screen_reader": False})
    assert emitted[-1] == (
        "a11y",
        {"effective": True, "reader_speaks": False, "detected": False, "edition": "daredevil"},
    )
    assert not hub.speaker.silent  # nobody to read the replies: Jarvis still speaks them
    commands["a11y_state"]({"screen_reader": True})
    assert emitted[-1][1]["reader_speaks"] is True and hub.speaker.silent
    hub2, context2, _, _ = installed(a11y_mode="off")
    hub2.edition = "daredevil"
    assert ask(context2) is None  # switched off in Settings: off
    hub3, context3, _, _ = installed(a11y_mode="auto")
    assert ask(context3) is None  # the plain app: only a screen reader turns it on


def test_jarvis_can_keep_the_voice_while_the_notes_still_shape_the_replies():
    hub, context, _, _ = installed(a11y_mode="on", a11y_voice="jarvis")
    assert ask(context) is not None
    assert not hub.speaker.silent


def test_the_owners_mute_is_never_set_or_cleared_by_it():
    hub, _, _, _ = installed(a11y_mode="on")
    assert hub.speaker.muted is False and hub.speaker.silent is True
    hub.speaker.muted = True
    assert hub.speaker.silent is True
    hub2, _, _, _ = installed(a11y_mode="off")
    hub2.speaker.muted = True
    assert hub2.speaker.silent is True


def test_words_someone_else_sent_on_get_no_note():
    _, context, _, _ = installed(a11y_mode="on")
    assert ask(context, "from a link", display="from a link") is None


@pytest.mark.parametrize(
    "verbosity, marker",
    [("brief", "one to three sentences"), ("normal", "a few sentences"), ("detailed", "signpost")],
)
def test_verbosity_sets_how_much_is_said(verbosity, marker):
    _, context, _, _ = installed(a11y_mode="on", a11y_verbosity=verbosity)
    note = ask(context)["note"]
    assert marker in note
    assert note.startswith("The user is blind")


def test_the_note_asks_for_what_a_blind_reader_needs():
    note = accessibility.note_for("normal")
    for phrase in ("first sentence", "no tables", "layout or colour", "yes or no", "not sure"):
        assert phrase in note.lower()


def test_each_window_report_is_answered_with_what_is_on():
    _, _, commands, emitted = installed(a11y_mode="auto")
    commands["a11y_state"]({"screen_reader": True})
    commands["a11y_state"]({"screen_reader": False})
    assert emitted == [
        ("a11y", {"effective": True, "reader_speaks": True, "detected": True}),
        ("a11y", {"effective": False, "reader_speaks": False, "detected": False}),
    ]


def test_its_settings_are_registered_with_safe_defaults_and_reject_nonsense():
    assert FEATURE_PREFS["a11y_mode"][0] == "auto"
    assert FEATURE_PREFS["a11y_voice"][0] == "auto"
    assert FEATURE_PREFS["a11y_cues"][0] is True
    assert clean_feature_values({"a11y_mode": "loud", "a11y_verbosity": "brief"}) == {
        "a11y_verbosity": "brief"
    }
    assert clean_feature_values({"a11y_cue_volume": 250}) == {"a11y_cue_volume": 100}
    assert clean_feature_values({"a11y_cue_volume": True}) == {}


def test_a_stand_in_speaker_without_the_flag_is_judged_by_its_mute():
    assert is_silent(SimpleNamespace(muted=True)) is True
    assert is_silent(SimpleNamespace(muted=False)) is False


# ── on the real hub ──


def test_on_the_real_hub_screen_reader_mode_quiets_the_voice_and_adds_the_note(
    settings, quiet_speaker, isolated
):
    from conftest import FakeClient

    from jarvis.hub import Hub

    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    quiet_speaker.muted = False  # (the fixture is muted: this is about the other way to be quiet)
    assert hub.accessibility.reader_speaks() is False and quiet_speaker.silent is False
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    asyncio.run(hub.handle({"type": "a11y_state", "screen_reader": True}))
    assert hub.accessibility.reader_speaks() is True and quiet_speaker.silent is True
    assert events[-1] == ("a11y", {"effective": True, "reader_speaks": True, "detected": True})
    extras = asyncio.run(hub._request_extras("what's next?", None))
    assert any("blind or has low vision" in e.get("note", "") for e in extras)
    hub.set_feature_prefs({"a11y_voice": "jarvis"})
    assert quiet_speaker.silent is False
    assert events[-1][0] == "a11y" and events[-1][1]["reader_speaks"] is False
    hub.set_feature_prefs({"a11y_mode": "off"})
    assert not any(
        "blind" in e.get("note", "") for e in asyncio.run(hub._request_extras("hi", None))
    )


def test_on_a_pc_windows_flag_decides_not_the_windows_word(monkeypatch):
    # Something that reads windows through UI Automation (JARVIS's own PC control, a dictation
    # tool) makes Electron say "a screen reader" for the rest of the session. Windows' own flag,
    # which only Narrator, NVDA and JAWS set, says there isn't one.
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: False)
    hub, context, commands, _ = installed()
    commands["a11y_state"]({"screen_reader": True})
    assert ask(context) is None and not hub.speaker.silent
    # NVDA is running and the window hasn't noticed yet: it is believed.
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: True)
    commands["a11y_state"]({"screen_reader": False})
    assert "blind" in ask(context)["note"] and hub.speaker.silent


def test_where_windows_cannot_say_the_window_is_believed(monkeypatch):
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: None)
    hub, context, commands, _ = installed()
    commands["a11y_state"]({"screen_reader": True})
    assert ask(context) is not None and hub.speaker.silent
    commands["a11y_state"]({"screen_reader": False})
    assert ask(context) is None and not hub.speaker.silent


def test_a_screen_reader_that_starts_or_quits_is_followed_on_a_pc(monkeypatch):
    running = {"now": False}
    monkeypatch.setattr(accessibility.osplat, "IS_WIN", True)
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: running["now"])
    monkeypatch.setattr(accessibility, "WATCH_SECONDS", 0.01)
    hub, context, commands, emitted = installed()

    async def go():
        task = asyncio.create_task(hub.accessibility.watch())
        await asyncio.sleep(0.05)
        assert emitted == []  # nothing changed, nothing said
        running["now"] = True  # NVDA starts
        await asyncio.sleep(0.1)
        assert emitted[-1][0] == "a11y" and emitted[-1][1]["effective"] is True
        assert hub.speaker.silent
        running["now"] = False  # …and quits
        await asyncio.sleep(0.1)
        assert emitted[-1][1]["effective"] is False and not hub.speaker.silent
        task.cancel()

    asyncio.run(go())


def test_the_watch_runs_only_on_a_pc(monkeypatch):
    monkeypatch.setattr(accessibility.osplat, "IS_WIN", False)
    hub, _, _, _ = installed()
    asyncio.run(asyncio.wait_for(hub.accessibility.watch(), 1))  # returns at once


def test_the_loop_is_registered_on_a_pc_only(monkeypatch):
    seen = []
    for on in (True, False):
        monkeypatch.setattr(accessibility.osplat, "IS_WIN", on)
        hub = SimpleNamespace(
            register_loop=lambda name, factory: seen.append(name),
            prefs=SimpleNamespace(feature=lambda key: "auto"),
            speaker=Speaker("", 190),
            add_request_context=lambda f: None,
            register_command=lambda *a, **k: None,
            emit=lambda *a, **k: None,
            set_prefs=lambda changes, from_tool=False: [],
        )
        accessibility.install(hub)
    assert seen == ["a11y"]


def test_with_no_screen_reader_jarvis_still_speaks_unless_told_to_leave_it_to_one(monkeypatch):
    """Someone with low vision and no screen reader turns Daredevil on and still hears Jarvis."""
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: None)
    hub, context, commands, _ = installed(a11y_mode="on", a11y_voice="auto")
    assert ask(context) is not None and not hub.speaker.silent  # on, but nobody to read the replies
    commands["a11y_state"]({"screen_reader": True})  # a screen reader starts
    assert hub.speaker.silent
    commands["a11y_state"]({"screen_reader": False})
    assert not hub.speaker.silent
    hub, _, commands, _ = installed(
        a11y_mode="on", a11y_voice="reader"
    )  # "my screen reader", whatever is detected
    assert hub.speaker.silent
    hub, _, commands, _ = installed(a11y_mode="auto", a11y_voice="jarvis")
    commands["a11y_state"]({"screen_reader": True})
    assert not hub.speaker.silent


def test_the_colours_and_the_size_are_choices_of_a_few_words():
    from jarvis.prefs import FEATURE_PREFS, clean_feature_values

    assert (
        FEATURE_PREFS["a11y_colors"][0] == "auto" and FEATURE_PREFS["a11y_text_size"][0] == "auto"
    )
    assert FEATURE_PREFS["a11y_voice"][0] == "auto"
    kept = clean_feature_values(
        {
            "a11y_colors": "yellow",
            "a11y_text_size": "larger",
            "a11y_voice": "reader",
        }
    )
    assert kept == {"a11y_colors": "yellow", "a11y_text_size": "larger", "a11y_voice": "reader"}
    for key in ("a11y_colors", "a11y_text_size", "a11y_voice"):
        assert clean_feature_values({key: "<script>"}) == {}
    assert set(accessibility.COLORS) == {
        "auto",
        "yellow",
        "white",
        "yellow-bg",
        "yellow-blue",
        "off",
    }
