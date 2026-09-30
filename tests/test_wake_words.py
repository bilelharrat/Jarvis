"""Wake words the owner keeps (wakewords.py, wake.py, lang.py): "Jarvis" anywhere in a
sentence while it's one of them; other names (a persona's own, or added) only when called,
in English and in Chinese; answers and announcements treat them as names, not words."""

import types

import pytest
from conftest import FakeClient

from jarvis import lang, wake, wakewords
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub
from jarvis.interrupts import speakable
from jarvis.voicecode import voice_answer


@pytest.fixture(autouse=True)
def only_jarvis_after():
    """Each test sets its own wake words; nothing is left for the next one."""
    yield
    wake.configure(None)


def use(*names):
    wake.configure(lambda: names)


def test_by_default_it_is_jarvis_alone_as_ever():
    wake.configure(None)
    assert wake.wake_names() == ("Jarvis",) and wake.jarvis_on()
    assert wake.find_wake("What's the weather, Jarvis?") == (True, "What's the weather")
    assert wake.find_wake("Friday, what's the weather?") == (False, "")


@pytest.mark.parametrize(
    ("said", "woke"),
    [
        ("Friday, what's the weather?", (True, "what's the weather")),
        ("Friday. Turn the lights off.", (True, "Turn the lights off")),
        ("Hey Friday", (True, "")),
        ("Hey Friday what's up", (True, "what's up")),
        ("Hi, Friday, lights off.", (True, "lights off")),
        ("Fryday, lights off please.", (True, "lights off please")),  # Whisper's near-miss
        ("Friday.", (False, "")),  # an answer to someone, not a call
        ("Friday works for me.", (False, "")),
        ("I'll see you on Friday, okay?", (False, "")),
        ("Okay, Friday works.", (False, "")),
        ("Is it Monday, Tuesday, or Friday?", (False, "")),
        ("Jarvis, what time is it?", (True, "what time is it")),  # still one of them
    ],
)
def test_another_name_wakes_it_only_when_called(said, woke):
    use("Jarvis", "Friday")
    assert wake.find_wake(said) == woke


def test_without_jarvis_the_name_is_just_a_word():
    use("Friday")
    assert not wake.jarvis_on()
    for said in ("Jarvis, what time is it?", "Hey Travis, lights off.", "What's up, Jarvis?"):
        assert wake.find_wake(said) == (False, ""), said
    assert wake.find_wake("Friday, what time is it?") == (True, "what time is it")
    assert wake.find_wake("wake up, daddy's home") == (True, "")  # the phrase stays


def test_a_short_name_has_to_be_heard_exactly():
    use("Jarvis", "TARS")
    assert wake.find_wake("TARS, status report.") == (True, "status report")
    assert wake.find_wake("Tars, status report.") == (True, "status report")
    for said in ("Bars, status report.", "Stars, status report.", "Tar, status report."):
        assert wake.find_wake(said) == (False, ""), said


def test_answers_leave_the_name_out():
    use("Jarvis", "Friday")
    assert wake.yes_no("Friday, yes") is True
    assert wake.yes_no("Friday, no, don't send it") is False
    approval = {"choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "No"}]}
    assert voice_answer("Friday, yes, send it", approval)[0] == "allow"


def test_announcements_keep_the_word_when_it_isnt_a_call():
    use("Jarvis", "Friday")
    assert speakable("Ann says the meeting moved to Friday.") == (
        "Ann says the meeting moved to Friday."
    )
    assert "Jarvis" not in speakable("Ann says: Jarvis, call me.")


@pytest.mark.parametrize(
    ("said", "woke"),
    [
        ("星期五，明天天气怎么样？", (True, "明天天气怎么样")),
        ("嘿，星期五", (True, "")),
        ("你好星期五，几点了", (True, "几点了")),
        ("星期五我们开会", (False, "")),
        ("星期五。", (False, "")),
        ("我们星期五，开会", (False, "")),
        ("Friday，明天天气怎么样", (True, "明天天气怎么样")),
        ("贾维斯，几点了", (True, "几点了")),
    ],
)
def test_in_chinese_too(said, woke):
    use("Jarvis", "Friday", "星期五")
    assert lang.find_wake(said, "zh") == woke


def test_in_chinese_without_jarvis():
    use("星期五")
    assert lang.find_wake("贾维斯，几点了", "zh") == (False, "")
    assert lang.find_wake("星期五，几点了", "zh") == (True, "几点了")
    assert lang.yes_no("星期五，好的", "zh") is True
    assert lang.yes_no("星期五可以", "zh") is None  # "Friday works": not a yes


# ── what the owner keeps (wakewords.py) ──


def prefs(persona="jarvis", language="en", **features):
    return types.SimpleNamespace(
        persona=persona, language=language, feature=lambda key: features.get(key)
    )


def test_a_persona_brings_its_own_name():
    assert wakewords.of(prefs()) == ["Jarvis"]
    assert wakewords.of(prefs("friday")) == ["Jarvis", "Friday"]
    assert wakewords.of(prefs("tars", "zh")) == ["Jarvis", "TARS", "塔斯"]


def test_added_and_removed_names_follow_the_persona():
    kept = {"added": ["Computer"], "removed": ["Jarvis"]}
    assert wakewords.of(prefs("friday", wake_words=kept)) == ["Friday", "Computer"]
    assert wakewords.of(prefs("jarvis", wake_words=kept)) == ["Computer"]
    everything_removed = {"added": [], "removed": ["Jarvis"]}
    assert wakewords.of(prefs(wake_words=everything_removed)) == ["Jarvis"]  # never none


def test_adding_and_removing():
    p = prefs("friday")
    kept, why = wakewords.add(p, "  Computer ")
    assert why == "" and kept == {"added": ["Computer"], "removed": []}
    p = prefs("friday", wake_words=kept)
    assert wakewords.add(p, "computer")[0] == kept  # already one
    kept, why = wakewords.remove(p, "Friday")
    assert why == "" and kept == {"added": ["Computer"], "removed": ["Friday"]}
    p = prefs("friday", wake_words=kept)
    assert wakewords.of(p) == ["Jarvis", "Computer"]
    kept, _ = wakewords.add(p, "friday")  # a persona's name put back
    assert kept == {"added": ["Computer"], "removed": []}
    kept, _ = wakewords.remove(prefs(), "Jarvis")
    assert kept is None  # the last one stays


@pytest.mark.parametrize(
    "bad", ["stop", "yes", "Hey", "x", "two words", "a" * 21, "星", "<b>", 7, None]
)
def test_a_wake_word_is_one_name(bad):
    kept, why = wakewords.add(prefs(), bad)
    assert kept is None and why


def test_what_is_kept_is_read_defensively():
    assert wakewords.clean_pref({"added": ["Friday", "friday", "stop", 3], "removed": "x"}) is None
    assert wakewords.clean_pref({"added": ["Friday", "friday", "stop", 3]}) == {
        "added": ["Friday"],
        "removed": [],
    }
    assert wakewords.clean_pref("Friday") is None


# ── on the hub ──


def make_hub(settings, speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=speaker, poll=False, **isolated)


async def test_the_pane_adds_and_removes_and_the_hub_hears_them(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    assert wake.find_wake("Friday, lights off.") == (False, "")
    hub.set_prefs({"persona": "friday"})
    assert wake.find_wake("Friday, lights off.") == (True, "lights off")  # followed at once

    await hub._handle({"type": "voice_settings", "changes": {"wake_add": "Computer"}})
    assert sent[-1][1]["wake_words"] == ["Jarvis", "Friday", "Computer"]
    assert wake.find_wake("Hey Computer") == (True, "")
    await hub._handle({"type": "voice_settings", "changes": {"wake_remove": "Jarvis"}})
    assert wake.find_wake("Jarvis, lights off.") == (False, "")
    assert hub.prefs.feature("wake_words") == {"added": ["Computer"], "removed": ["Jarvis"]}

    await hub._handle({"type": "voice_settings", "changes": {"wake_add": "stop"}})
    assert "not one I already answer to" in sent[-1][1]["wake_error"]
    await hub._handle({"type": "voice_status"})
    assert sent[-1][1]["wake_error"] == ""  # said once


async def test_a_hands_free_call_by_another_name_asks(settings, quiet_speaker, isolated):
    from test_hub import Listener
    from test_hub import make_hub as hub_with_script

    hub = hub_with_script(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"persona": "friday", "hands_free": True})
    await hub.on_heard("Friday, what's on tomorrow?")
    import asyncio

    await asyncio.sleep(0.01)
    assert hub.client.said == ["what's on tomorrow"]
    assert voice_feature.feature_for(hub) is not None
