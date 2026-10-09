"""Lecture and seminar notes on a PC (features/lecture_notes.py, winloopback.py, and the PC path
of call notes): the room through the microphone as on a Mac, the PC's own sound through a
loopback input when the audio library offers one (a stand-in sounddevice here: nothing is
opened), and study notes instead of meeting minutes."""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from test_proactive_calls import rig, until  # noqa: F401 - the same hub, listener and ears

from jarvis import osplat, winloopback
from jarvis.features import lecture_notes
from jarvis.meeting import LECTURE_LABELED, LECTURE_PROMPT, SUMMARY_PROMPT, Meeting

WASAPI = [{"name": "MME"}, {"name": "Windows WASAPI"}]


class Stream:
    def __init__(self, kw):
        self.kw, self.started, self.closed = kw, False, False

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def close(self):
        self.closed = True


class FakeSD:
    """sounddevice as the PC's would answer, with these devices."""

    def __init__(self, devices, apis=WASAPI):
        self.devices, self.apis, self.streams = devices, apis, []

    def query_hostapis(self):
        return self.apis

    def query_devices(self, index=None):
        return self.devices if index is None else self.devices[index]

    def InputStream(self, **kw):  # noqa: N802 - sounddevice's own name
        self.streams.append(Stream(kw))
        return self.streams[-1]


def device(name, api=1, inputs=2, rate=48_000):
    return {"name": name, "hostapi": api, "max_input_channels": inputs, "default_samplerate": rate}


def sound_48k(*parts):
    """(seconds, amplitude) parts at 48 kHz in stereo: silence at 0, a 440 Hz tone otherwise."""
    out = []
    for seconds, amplitude in parts:
        t = np.arange(int(48_000 * seconds)) / 48_000
        out.append(amplitude * np.sin(2 * np.pi * 440 * t))
    mono = np.concatenate(out).astype(np.float32)
    return np.stack([mono, mono], axis=1)


def play(sd, data):
    """What the PC plays, handed over in the device's own blocks, as PortAudio would."""
    stream = sd.streams[-1]
    step = int(48_000 * 0.05)
    for i in range(0, len(data), step):
        stream.kw["callback"](data[i : i + step], step, None, None)


# ── finding the PC's own sound ──


def test_a_wasapi_loopback_input_comes_before_stereo_mix():
    sd = FakeSD(
        [
            device("Microphone (Realtek)"),
            device("Stereo Mix (Realtek)", api=0),
            device("Speakers (Realtek) [Loopback]"),
            device("Speakers (Realtek)", inputs=0),
        ]
    )
    assert winloopback.find_device(sd) == (2, "")
    only_mix = FakeSD([device("Microphone"), device("Stereo Mix (Realtek Audio)", api=0)])
    assert winloopback.find_device(only_mix) == (1, "")


def test_with_neither_it_says_what_to_turn_on():
    index, why = winloopback.find_device(FakeSD([device("Microphone (USB)")]))
    assert index is None and "Stereo Mix" in why and "Sound settings" in why

    class Broken(FakeSD):
        def query_devices(self, index=None):
            raise OSError("PortAudio not initialized")

    index, why = winloopback.find_device(Broken([]))
    assert index is None and "couldn't list" in why


def test_the_sound_becomes_the_microphones_16_khz_mono():
    stereo = np.ones((4800, 2), dtype=np.float32) * np.array([0.2, 0.4], dtype=np.float32)
    mono = winloopback.to_rate(stereo, 48_000)
    assert mono.dtype == np.float32 and len(mono) == 1600 and np.allclose(mono, 0.3)
    assert len(winloopback.to_rate(np.zeros(800, dtype=np.float32), 16_000)) == 800


def test_off_a_pc_nothing_is_opened(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", False)
    capture, why = asyncio.run(_open(None))
    assert capture is None and "only on Windows" in why


async def _open(sd):
    return winloopback.open_capture(sd)


async def test_a_capture_gives_blocks_until_stopped():
    sd = FakeSD([device("Speakers [Loopback]")])
    capture, why = winloopback.open_capture(sd)
    assert why == "" and sd.streams[0].started
    assert sd.streams[0].kw["samplerate"] == 48_000 and sd.streams[0].kw["channels"] == 2
    play(sd, sound_48k((0.2, 0.3)))
    await asyncio.sleep(0)
    got = []

    async def take():
        async for block in capture.blocks():
            got.append(block)

    reader = asyncio.ensure_future(take())
    await asyncio.sleep(0.05)
    capture.stop()
    await asyncio.wait_for(reader, 2)
    assert len(got) == 4 and all(len(b) == winloopback.BLOCK for b in got)
    assert sd.streams[0].closed


# ── the notes ──


def test_a_lecture_is_written_up_as_study_notes(tmp_path):
    prompts = []

    async def summarize(prompt):
        prompts.append(prompt)
        return "## Summary\n- Entropy.\n## Key points\n- More disorder.\n"

    meeting = Meeting("Thermo week 5", tmp_path)
    meeting.kind, meeting.prompt, meeting.labeled_text = "lecture", LECTURE_PROMPT, LECTURE_LABELED
    for _ in range(4):
        meeting.add_text("Entropy is a measure of disorder in a closed system over time.")
    meeting.add(None, "The lecturer on the stream explains the second law.", speaker="Them")
    result = asyncio.run(meeting.write_up(summarize))
    [prompt] = prompts
    assert "## Terms and definitions" in prompt and "## Assignments and dates" in prompt
    assert "the computer's own sound" in prompt and "It has no speaker labels" not in prompt
    assert "## Decisions" not in prompt and result["path"].endswith(".md")
    assert SUMMARY_PROMPT != LECTURE_PROMPT


class Hub:
    """Enough of the hub for the tool: start_meeting makes the notes, the gate says yes."""

    def __init__(self, tmp_path, microphone=True):
        self.meeting = None
        self.tmp_path, self.microphone = tmp_path, microphone
        self.spawned = []
        self.prefs = type("P", (), {"language": "en"})()

    async def start_meeting(self, title):
        if self.meeting is not None:
            return f"Already taking notes for {self.meeting.title}."
        if not self.microphone:
            return "I can't hear the room: the microphone isn't available."
        self.meeting = Meeting(title, self.tmp_path)
        return f"Taking notes for {title}. Everything said is transcribed here on this PC until the user says stop."

    def _spawn(self, coro):
        self.spawned.append(asyncio.ensure_future(coro))
        return self.spawned[-1]

    async def feature_gate(self, action, question):
        self.asked = (action, question)
        return True


async def test_start_lecture_notes_on_a_pc_hears_the_room_and_the_pc(tmp_path, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    hub = Hub(tmp_path)
    sd = FakeSD([device("Speakers [Loopback]")])
    part = lecture_notes.LectureNotes(hub, open_capture=lambda: winloopback.open_capture(sd))
    monkeypatch.setattr(lecture_notes, "create_sdk_mcp_server", lambda **k: k["tools"])
    [tool] = part.build()
    out = (await tool.handler({"title": "Thermo week 5", "computer_sound": True}))["content"][0][
        "text"
    ]
    assert hub.asked == ("start_meeting", "Start taking lecture notes for Thermo week 5?")
    assert out.endswith(
        "until the user says stop. The computer's own sound goes into the notes too."
    )
    assert hub.meeting.kind == "lecture" and hub.meeting.label == "You" and part.capture is not None
    await part.on_meeting({"active": False})
    assert part.capture is None and sd.streams[0].closed


async def test_without_a_loopback_input_the_microphone_carries_on_and_says_why(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    hub = Hub(tmp_path)
    part = lecture_notes.LectureNotes(
        hub, open_capture=lambda: winloopback.open_capture(FakeSD([device("Mic")]))
    )
    out = await part.start("Seminar", computer_sound=True)
    assert "This PC's own sound can't be captured (this PC offers no way" in out
    assert out.endswith("so the notes have the microphone only.") and hub.meeting.kind == "lecture"


async def test_on_a_mac_it_points_at_call_notes_and_the_room_alone_needs_nothing(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(osplat, "IS_WIN", False)
    out = await lecture_notes.LectureNotes(Hub(tmp_path)).start("Seminar", computer_sound=True)
    assert out.endswith("On a Mac, start_call_notes takes the computer's own sound too.")
    hub = Hub(tmp_path / "b")
    out = await lecture_notes.LectureNotes(hub).start("Seminar")
    assert out.startswith("Taking notes for Seminar.") and hub.meeting.prompt == LECTURE_PROMPT


async def test_no_microphone_or_notes_already_running_are_said_as_they_are(tmp_path):
    out = await lecture_notes.LectureNotes(Hub(tmp_path, microphone=False)).start("Seminar")
    assert out == "I can't hear the room: the microphone isn't available."
    hub = Hub(tmp_path)
    await hub.start_meeting("Staff meeting")
    out = await lecture_notes.LectureNotes(hub).start("Seminar")
    assert out == "Already taking notes for Staff meeting." and hub.meeting.kind == "meeting"


# ── end to end, on the real hub, as a PC ──


@pytest.fixture
def pc(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    sd = FakeSD([device("Speakers (Realtek) [Loopback]")])
    monkeypatch.setattr(winloopback, "open_capture", lambda sd_=None: _real_open(sd))
    return sd


_original_open = winloopback.open_capture


def _real_open(sd):
    return _original_open(sd)


async def test_call_notes_on_a_pc_hear_what_it_plays_as_them(rig, pc):  # noqa: F811
    hub, part, spawned, _helper, prompts = rig
    reply = await part.start("Release sync")
    assert reply == "Taking notes on the call Release sync: you and them, here on this PC."
    assert spawned == []  # no ScreenCaptureKit helper on a PC
    meeting = hub.meeting
    play(pc, sound_48k((0.6, 0), (1.0, 0.3), (1.0, 0)))
    assert await until(lambda: "Them" in meeting.speakers)
    assert "Them: We can ship the release on Friday." in meeting.transcript()
    reply = await hub.stop_meeting()
    assert await until(lambda: part.capture is None and pc.streams[0].closed)


async def test_a_lecture_on_the_real_hub_ends_with_its_own_words(rig, pc):  # noqa: F811
    hub, _part, _spawned, _helper, prompts = rig
    notes = lecture_notes.LectureNotes(hub)
    out = await notes.start("Thermo week 5", computer_sound=True)
    assert "here on this PC" in out and "own sound goes into the notes" in out
    play(pc, sound_48k((0.6, 0), (1.0, 0.3), (1.0, 0)))
    assert await until(lambda: "Them" in hub.meeting.speakers)
    for _ in range(4):
        hub.meeting.add_text("Entropy is a measure of disorder in a closed system over time.")
    reply = await hub.stop_meeting()
    assert reply.startswith("Lecture notes for Thermo week 5 saved to the second brain:")
    assert "## Key points" in prompts[-1]
    await notes.on_meeting({"active": False})
