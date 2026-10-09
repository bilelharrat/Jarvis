"""Punctuation by voice (features/speech_punctuation.py): said when dictating, heard when Jarvis speaks,
asked about on anything. A stand-in hub; the marks and their words are punctuation.py's (tested there)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from jarvis.features import speech_punctuation as sp
from jarvis.prefs import clean_feature_values
from jarvis.speech import Speaker


def installed(**prefs):
    values = {"a11y_dictate_punct": "auto", "a11y_read_punct": "none", **prefs}
    contexts, instants, servers, changed = [], [], {}, []
    hub = SimpleNamespace(
        prefs=SimpleNamespace(feature=lambda key: values.get(key)),
        language="en",
        speaker=Speaker("", 190),
        add_request_context=contexts.append,
        register_instant=instants.append,
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        set_prefs=lambda changes, from_tool=False: (
            values.update(changes["features"]) or changed.append(changes) or ["features"]
        ),
    )
    sp.install(hub)
    return SimpleNamespace(
        hub=hub,
        values=values,
        context=contexts[0],
        instant=instants[0],
        servers=servers,
        changed=changed,
    )


def run(coro):
    return asyncio.run(coro)


def test_the_two_settings_are_kept_and_junk_is_not():
    assert clean_feature_values({"a11y_read_punct": "all", "a11y_dictate_punct": "spoken"}) == {
        "a11y_read_punct": "all",
        "a11y_dictate_punct": "spoken",
    }
    assert clean_feature_values({"a11y_read_punct": "loud", "a11y_dictate_punct": "yes"}) == {}


def test_what_the_voice_is_given_has_its_marks_said_at_the_persons_level():
    box = installed()
    assert box.hub.speaker.punctuation("Hello, world.") == "Hello, world."  # none: as it is
    box.values["a11y_read_punct"] = "some"
    assert box.hub.speaker.punctuation("Hello, world.") == "Hello comma world period"
    box.values["a11y_read_punct"] = "all"
    assert box.hub.speaker.punctuation("Note: ann@x.edu") == "Note colon ann at x dot edu"
    assert box.hub.speaker.punctuation("") == ""


def test_the_speakers_clean_hands_every_sentence_to_the_hook_first():
    """(hub._speak_language builds `clean` so: the hook, then the speaking-voice cleaning.)"""
    from jarvis import lang

    box = installed(a11y_read_punct="some")
    speaker = box.hub.speaker

    def clean(text):
        marks = getattr(speaker, "punctuation", None)
        return lang.clean_for_speech(marks(text) if marks else text, "en")

    assert clean("Dear Ann, thanks.") == "Dear Ann comma thanks period"
    box.values["a11y_read_punct"] = "none"
    assert clean("Dear Ann, thanks.") == "Dear Ann, thanks."


def test_a_text_the_engine_cannot_read_is_spoken_as_it_is(monkeypatch):
    box = installed(a11y_read_punct="all")

    def boom(*_a, **_k):
        raise RuntimeError("no")

    monkeypatch.setattr(sp.punctuation, "to_speech", boom)
    assert box.hub.speaker.punctuation("Hello, world.") == "Hello, world."


def test_the_instant_words_change_the_settings_and_say_so():
    box = installed()
    assert "main punctuation marks" in run(box.instant("read the punctuation"))
    assert box.values["a11y_read_punct"] == "some"
    assert "every punctuation mark" in run(box.instant("read every punctuation mark"))
    assert box.values["a11y_read_punct"] == "all"
    assert "won't read" in run(box.instant("stop reading punctuation"))
    assert box.values["a11y_read_punct"] == "none"
    assert "Say the punctuation as you dictate" in run(box.instant("I'll say the punctuation"))
    assert box.values["a11y_dictate_punct"] == "spoken"
    assert "punctuate what you dictate" in run(box.instant("punctuate for me"))
    assert box.values["a11y_dictate_punct"] == "auto"
    assert "main punctuation marks" in run(box.instant("Turn on the punctuation"))


@pytest.mark.parametrize(
    "said",
    [
        "what is the punctuation in this sentence",
        "how is that paragraph punctuated",
        "is there a comma after however",
        "read my email",
        "what's the period of the moon",
        "read the last email with punctuation",  # (a request for the model: it fetches the text)
        "",
        "x" * 200,
    ],
)
def test_other_words_are_left_for_the_model(said):
    box = installed()
    assert run(box.instant(said)) is None
    assert box.changed == []


def test_dictated_marks_are_made_only_when_the_person_says_their_punctuation():
    box = installed()
    desk = box.hub.speech_punctuation
    assert (
        desk.dictated("hello comma world period") == "hello comma world period"
    )  # auto: left to Jarvis
    box.values["a11y_dictate_punct"] = "spoken"
    assert desk.dictated("dear ann comma new paragraph thanks period") == "Dear ann,\n\nThanks."
    assert desk.dictated("   ") == "   "


def test_a_phrase_that_carries_on_a_sentence_keeps_its_first_letter_and_one_that_begins_one_has_a_capital():
    box = installed(a11y_dictate_punct="spoken")
    desk = box.hub.speech_punctuation
    assert (
        desk.dictated("to the store comma then home", after="I will go")
        == "to the store, then home"
    )
    assert desk.dictated("to the store", after="I went home.") == "To the store"
    assert desk.dictated("to the store", after="I went home.\n") == "To the store"
    assert desk.dictated("to the store", after="") == "To the store"
    assert desk.dictated("comma and then", after="I will go") == ", and then"
    assert desk.dictated("John said hello", after="I will tell") == "John said hello"


def test_claude_is_told_about_the_dictated_marks_only_while_they_are_dictated():
    box = installed()
    assert run(box.context("email Ann", None)) is None
    box.values["a11y_dictate_punct"] = "spoken"
    note = run(box.context("email Ann", None))["note"]
    assert (
        "dictates their punctuation" in note and "new paragraph" in note and "stays a word" in note
    )
    assert run(box.context("words someone else sent on", "shown text")) is None


def tools_of(box, monkeypatch):
    monkeypatch.setattr(sp, "create_sdk_mcp_server", lambda **k: k["tools"])
    return {t.name: t.handler for t in box.servers["punctuation"][0]()}


def said(result):
    return result["content"][0]["text"]


def test_the_settings_can_be_changed_in_words_and_a_bad_one_changes_nothing():
    box = installed()
    desk = box.hub.speech_punctuation
    assert desk.set(read="some") == [sp.WORDS_READ["some"]]
    assert desk.set(dictate="spoken", read="all") == [
        sp.WORDS_READ["all"],
        sp.WORDS_DICTATE["spoken"],
    ]
    assert desk.set(read="loud") == []  # (nothing changes for what isn't one of the levels)
    assert box.values["a11y_read_punct"] == "all" and box.values["a11y_dictate_punct"] == "spoken"


def test_the_tools_change_the_settings_describe_a_text_and_spell_it_out(monkeypatch):
    box = installed()
    tools = tools_of(box, monkeypatch)
    out = run(tools["set_punctuation"]({"read": "all", "dictate": "spoken"}))
    assert "every punctuation mark" in said(out) and box.values["a11y_read_punct"] == "all"
    assert run(tools["set_punctuation"]({"read": "loud"}))["is_error"]
    assert said(run(tools["set_punctuation"]({}))) == "Nothing was changed."
    described = said(run(tools["describe_punctuation"]({"text": "Dear Ann, hello. Are you well?"})))
    assert described.startswith("2 sentences. 1 comma, 1 period and 1 question mark.")
    assert (
        "With the marks spelled out: Dear Ann comma hello period Are you well question mark"
        in described
    )
    assert run(tools["describe_punctuation"]({"text": "  "}))["is_error"]
    spelled = said(run(tools["read_with_punctuation"]({"text": "Dear Ann,\n\nThanks."})))
    assert spelled.startswith("Say this exactly, word for word, and nothing else:")
    assert "Dear Ann comma new paragraph Thanks period" in spelled
    some = said(run(tools["read_with_punctuation"]({"text": "Hi - there", "level": "some"})))
    assert "dash" in some  # (a level that isn't one of them is "all")
    assert run(tools["read_with_punctuation"]({"text": ""}))["is_error"]


def test_the_server_offers_the_three_tools_and_its_prompt_names_them():
    box = installed()
    _build, kw = box.servers["punctuation"]
    for name in ("set_punctuation", "describe_punctuation", "read_with_punctuation"):
        assert name in kw["prompt"] and name in kw["labels"] and name in kw["quiet"]


# ── in a whole hub ──


def test_a_real_hub_says_the_marks_aloud_and_types_the_dictated_ones(
    settings, quiet_speaker, isolated
):
    from conftest import FakeClient

    from jarvis.hub import Hub

    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert hub.speech_punctuation is not None and "punctuation" in hub._extra_servers
    assert (
        hub.speaker.clean("Hello, world.") == "Hello, world."
    )  # (the default: nothing spelled out)
    hub.set_prefs({"features": {"a11y_read_punct": "some"}})
    assert hub.speaker.clean("Hello, world.") == "Hello comma world period"
    hub.set_prefs({"features": {"a11y_read_punct": "none", "a11y_dictate_punct": "spoken"}})
    assert hub._with_dictated_marks("dear ann comma new paragraph") == "Dear ann,\n\n"
    hub.voice_typing.start()
    hub.voice_typing.did_type("I will go")
    assert hub._with_dictated_marks("to the store period") == "to the store."
    hub.set_prefs({"features": {"a11y_dictate_punct": "auto"}})
    assert hub._with_dictated_marks("dear ann comma") == "dear ann comma"
