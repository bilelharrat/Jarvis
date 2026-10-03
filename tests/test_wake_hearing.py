"""Hearing the wake word through Whisper (listen.Transcriber): the name is never a hotword
on the first hearing (as one, Whisper dropped it from the start of a request), and a near
miss ("job is", "Okay, JavaS") is heard again with it as a hint, kept only when the name
is then in it. A fake model: no Whisper, no microphone."""

import numpy as np
import pytest

from jarvis import listen
from jarvis.listen import Transcriber, near_wake


class FakeModel:
    """Answers by its hotwords: what it hears without the name, and with it."""

    def __init__(self, plain: str, hinted: str):
        self.plain, self.hinted, self.calls = plain, hinted, []

    def transcribe(self, _audio, **options):
        self.calls.append(options.get("hotwords", ""))
        text = self.hinted if "Jarvis" in options.get("hotwords", "") else self.plain

        class Segment:
            pass

        seg = Segment()
        seg.text = text
        return [seg], None


def ear(plain: str, hinted: str, language: str = "en") -> tuple[Transcriber, FakeModel]:
    stt = Transcriber("base.en", language)
    model = FakeModel(plain, hinted)
    stt._load = lambda: model
    return stt, model


AUDIO = np.zeros(16000, dtype=np.float32)


def test_a_near_miss_is_heard_again_with_the_name():
    stt, model = ear(
        "Okay, job is how many emails do I have?", "Okay Jarvis, how many emails do I have?"
    )
    assert stt.transcribe(AUDIO) == "Okay Jarvis, how many emails do I have?"
    assert model.calls == ["", "Jarvis"]  # first without the name, then with it


def test_the_second_hearing_is_kept_only_when_it_has_the_name():
    stt, model = ear("John is coming over at six.", "John is coming over at six.")
    assert stt.transcribe(AUDIO) == "John is coming over at six."
    assert model.calls == ["", "Jarvis"]


@pytest.mark.parametrize(
    "plain",
    ["Jarvis, what's on my calendar tomorrow?", "I think the meeting went well today."],
)
def test_no_second_hearing_when_it_woke_or_nothing_sounds_like_the_name(plain):
    stt, model = ear(plain, "Jarvis, something else")
    assert stt.transcribe(AUDIO) == plain and model.calls == [""]


def test_learned_words_stay_hints_but_the_name_never_does_first():
    stt, model = ear("Okay, JavaS, call Okin", "Okay Jarvis, call Okin")
    assert stt.transcribe(AUDIO, "Jarvis Okin Hormuz") == "Okay Jarvis, call Okin"
    assert model.calls == ["Okin Hormuz", "Jarvis Okin Hormuz"]


def test_chinese_is_heard_as_before():
    stt, model = ear("工作", "贾维斯", language="zh")
    assert stt.transcribe(AUDIO, "贾维斯") == "工作" and model.calls == ["贾维斯"]


@pytest.mark.parametrize(
    ("text", "near"),
    [
        ("job is", True),
        ("Hey Joggers, play some music.", True),
        ("What's the weather like today, JavaS?", True),
        ("Okay, JARLVIS", True),
        ("Play some music", False),
        ("I said yes", False),  # a J nowhere near the ends
        ("", False),
    ],
)
def test_what_counts_as_a_near_miss(text, near):
    assert near_wake(text) is near


def test_the_first_hearing_never_hints_the_name():
    assert listen.near_wake("Jo") is False  # too short to be the name
