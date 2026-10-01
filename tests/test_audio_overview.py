"""Audio overviews (features/audio_overview.py): the dialogue voiced by two of the Mac's voices
and saved as an .m4a."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest

from jarvis.features import audio_overview as ao


def test_two_different_voices_best_installed_first():
    assert ao.pick_voices(["Samantha", "Daniel", "Ava (Premium)"]) == ("Ava (Premium)", "Daniel")
    assert ao.pick_voices(["Samantha (English (US))", "Daniel (English (UK))"]) == (
        "Samantha (English (US))",
        "Daniel (English (UK))",
    )
    a, b = ao.pick_voices(["Samantha"])
    assert a == "Samantha" and b == ""  # only one voice: the tool says so


def test_voice_names_are_read_from_says_list():
    assert ao.voice_name("Samantha (English (US)) en_US    # Hello! My name is Samantha.") == (
        "Samantha (English (US))"
    )
    assert ao.voice_name("Albert              en_US    # Hello! My name is Albert.") == "Albert"
    assert ao.voice_name("Flo (English (UK))  en_GB  # Hi") == "Flo (English (UK))"


def test_the_dialogue_is_cleaned_and_capped():
    lines = ao.clean_lines(
        [
            {"speaker": "A", "text": "  Welcome   back. "},
            {"speaker": "b", "text": "So what is it?"},
            {"speaker": "A", "text": ""},
            "not a line",
        ]
    )
    assert lines == [(0, "Welcome back."), (1, "So what is it?")]
    assert len(ao.clean_lines([{"speaker": "A", "text": "x"}] * 500)) == ao.MAX_LINES
    assert ao.clean_lines(None) == []


def test_names_never_overwrite(tmp_path):
    first = ao.file_name("Lease: the key points", tmp_path)
    assert first.name == "Lease the key points.m4a"
    first.write_bytes(b"x")
    assert ao.file_name("Lease: the key points", tmp_path).name == "Lease the key points (2).m4a"


def test_too_short_a_dialogue_makes_nothing():
    text, error = asyncio.run(
        ao.AudioOverview(object()).make("x", [{"speaker": "A", "text": "Hi"}])
    )
    assert error and "at least two" in text


@pytest.mark.skipif(not (shutil.which("say") and shutil.which("afconvert")), reason="macOS voices")
def test_it_really_voices_the_lines(tmp_path, monkeypatch):
    voices = ao.pick_voices(ao.installed_voices())
    if not all(voices):
        pytest.skip("the tests never voice anything (conftest blocks say); checked by hand")
    out = ao.render([(0, "Hello."), (1, "Hi there.")], voices, tmp_path / "Test.m4a")
    assert out.exists() and out.stat().st_size > 1000
    assert out.read_bytes()[4:8] == b"ftyp"  # an MPEG-4 audio file
    assert not list(Path(tmp_path).glob("*.wav"))  # the parts were temporary
