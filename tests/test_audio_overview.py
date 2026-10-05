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


class FakeTools:
    """`say` and `afconvert` as render() runs them, without voicing anything: each line's
    part holds its number as its samples (and as many of them), and afconvert copies the
    joined file. Counts how many lines are voiced at once."""

    def __init__(self, fail: tuple[int, ...] = ()) -> None:
        import threading

        self.fail = fail
        self.lock = threading.Lock()
        self.running = self.most = 0
        self.voices: dict[int, str] = {}

    def __call__(self, args, **_kwargs):
        import subprocess
        import time
        import wave

        if args[0].endswith("afconvert"):
            shutil.copyfile(args[-2], args[-1])
            return subprocess.CompletedProcess(args, 0)
        part = Path(args[args.index("-o") + 1])
        number = int(part.stem)
        with self.lock:
            self.running += 1
            self.most = max(self.most, self.running)
        try:
            time.sleep(0.05 if number % 2 else 0.01)  # later lines can finish first
            if number in self.fail:
                raise subprocess.CalledProcessError(1, args, stderr=f"line {number}".encode())
            self.voices[number] = args[args.index("-v") + 1]
            with wave.open(str(part), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(ao.RATE)
                out.writeframes(((number + 1).to_bytes(2, "little")) * (number + 1))
        finally:
            with self.lock:
                self.running -= 1
        return subprocess.CompletedProcess(args, 0)


def test_lines_are_voiced_at_once_and_joined_in_order(tmp_path, monkeypatch):
    import wave

    tools = FakeTools()
    monkeypatch.setattr(ao.subprocess, "run", tools)
    lines = [(i % 2, f"Line {i}.") for i in range(9)]
    out = ao.render(lines, ("Ava", "Evan"), tmp_path / "Overview.m4a")
    assert 1 < tools.most <= ao.RENDERERS
    assert tools.voices == {i: ("Evan" if i % 2 else "Ava") for i in range(9)}
    with wave.open(str(out), "rb") as joined:
        frames = joined.readframes(joined.getnframes())
    pause = b"\x00\x00" * int(ao.RATE * ao.PAUSE_SECONDS)
    assert frames == b"".join(((i + 1).to_bytes(2, "little")) * (i + 1) + pause for i in range(9))


def test_the_first_line_that_fails_is_the_error(tmp_path, monkeypatch):
    import subprocess

    tools = FakeTools(fail=(2, 5))
    monkeypatch.setattr(ao.subprocess, "run", tools)
    with pytest.raises(subprocess.CalledProcessError) as failed:
        ao.render([(0, f"Line {i}.") for i in range(12)], ("Ava", "Evan"), tmp_path / "x.m4a")
    assert failed.value.stderr == b"line 2"
    assert not (tmp_path / "x.m4a").exists()
