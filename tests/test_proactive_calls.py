"""Notes for online calls (jarvis.features.proactive.calls, and the speaker labels in
jarvis.meeting): the ScreenCaptureKit helper is faked (a process that says it's ready, then
plays silence and a tone), the microphone is a fake listener and no model runs."""

import asyncio
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from conftest import FakeClient

from jarvis import swift_helper
from jarvis.features.proactive import calls as c
from jarvis.features.proactive import feature_of
from jarvis.hub import Hub
from jarvis.meeting import LABELED, UNLABELED, Meeting

WRITE_UP = "## Summary\n- Shipping Friday.\n## Decisions\n- Ship.\n## Action items\n- [ ] Ann: tag the release\n"


def pcm(*parts):
    """(seconds, amplitude) parts: silence at 0, a 440 Hz tone otherwise, as 16-bit PCM."""
    out = []
    for seconds, amplitude in parts:
        t = np.arange(int(c.RATE * seconds)) / c.RATE
        out.append(amplitude * np.sin(2 * np.pi * 440 * t))
    return (np.concatenate(out) * 32767).astype("<i2").tobytes()


class Stream:
    def __init__(self, data=b"", lines=()):
        self.data, self.lines = data, list(lines)
        self.ended = asyncio.Event()

    async def read(self, n):
        if not self.data:
            await self.ended.wait()  # the helper keeps listening until its input closes
            return b""
        await asyncio.sleep(0)
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk

    async def readline(self):
        return self.lines.pop(0) if self.lines else b""


class Helper:
    """The helper process: its answer on stderr (after a system warning), the call's sound
    on stdout."""

    def __init__(self, answer, sound=b""):
        warning = b"2026-09-30 10:00:00.000 jarvis-callaudio[42:7] a system warning\n"
        self.stderr = Stream(lines=[warning, json.dumps(answer).encode() + b"\n"])
        self.stdout = Stream(sound)
        self.stdin = self
        self.closed = False
        self.returncode = None

    def close(self):  # stdin.close(): the helper stops
        self.closed = True
        self.stdout.ended.set()

    async def wait(self):
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


class Ears:
    """The quick model: whatever it hears, the other side said this."""

    def __init__(self):
        self.heard = []

    def transcribe(self, audio, hotwords="Jarvis"):
        self.heard.append((len(audio), hotwords))
        return "We can ship the release on Friday."


class Listener:
    running = False

    def __init__(self, *_a):
        pass

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


@pytest.fixture
async def rig(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.listener_factory = Listener
    hub.notes_transcriber = None
    prompts = []

    async def summarize(prompt):
        prompts.append(prompt)
        return WRITE_UP

    async def rebuild_brain(only=None):
        return None

    hub._summarize = summarize
    hub.rebuild_brain = rebuild_brain
    hub.meetings_dir = tmp_path / "meetings"
    await hub.start()
    hub.transcriber = Ears()
    hub.set_feature_prefs({"call_notes": True})
    spawned = []
    helper = {"answer": {"ready": True}, "sound": pcm((0.6, 0), (1.0, 0.3), (1.0, 0))}

    async def spawn(*argv, **_kw):
        proc = Helper(helper["answer"], helper["sound"])
        spawned.append((argv, proc))
        return proc

    monkeypatch.setattr(swift_helper, "ensure", lambda name: Path(f"/fake/{name}"))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    yield hub, feature_of(hub).calls, spawned, helper, prompts
    if hub.meeting is not None:
        await hub.stop_meeting()
    hub.set_prefs({"hands_free": False})


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


async def test_the_call_is_them_and_the_microphone_is_you(rig):
    hub, part, spawned, _helper, prompts = rig
    reply = await part.start("Release sync")
    assert reply == "Taking notes on the call Release sync: you and them, here on the Mac."
    [(argv, proc)] = spawned
    assert argv[0] == "/fake/jarvis-callaudio" and argv[1:] == (str(os.getpid()), str(os.getppid()))
    meeting = hub.meeting
    assert meeting.label == "You"
    assert await until(lambda: "Them" in meeting.speakers)
    assert "Them: We can ship the release on Friday." in meeting.transcript()
    assert hub.transcriber.heard[0][1] == ""  # no "Jarvis" bias for someone else's words
    # The microphone hears the call through the speakers: that line isn't kept twice.
    assert hub._meeting_capture(None, "we can ship the release on friday")
    assert hub._meeting_capture(None, "Sounds good, let's tag it tonight.")
    assert hub._meeting_capture(
        None, "I'll write the notes tonight and send them round to everyone."
    )
    text = meeting.transcript()
    assert "You: Sounds good, let's tag it tonight." in text
    assert "You: we can ship" not in text
    reply = await hub.stop_meeting()
    assert "action items" in reply
    assert await until(lambda: proc.closed and part.proc is None)  # it stopped with the notes
    [prompt] = prompts
    assert LABELED in prompt and UNLABELED not in prompt
    [notes] = list(hub.meetings_dir.glob("*.md"))
    written = notes.read_text()
    assert (
        "] Them: We can ship the release on Friday." in written and "] You: Sounds good" in written
    )


async def test_without_screen_recording_the_microphone_carries_on(rig):
    hub, part, spawned, helper, _prompts = rig
    helper["answer"] = {"error": "no_permission"}
    reply = await part.start("Release sync")
    assert reply.startswith(
        "Taking notes for Release sync with the microphone only: allow Screen Recording"
    )
    [(_argv, proc)] = spawned
    assert proc.closed and part.proc is None
    assert hub.meeting is not None and hub.meeting.label == "You"


async def test_a_mac_that_cant_build_the_helper_says_so(rig, monkeypatch):
    hub, part, spawned, _helper, _prompts = rig
    monkeypatch.setattr(swift_helper, "ensure", lambda name: None)
    reply = await part.start("")
    assert reply == (
        "Taking notes for Call with the microphone only: the call's sound couldn't be "
        "captured on this Mac."
    )
    assert spawned == [] and hub.meeting.title == "Call"
    assert (await part.start("Again")).startswith("Already taking notes for Call")


async def test_off_until_the_owner_turns_it_on(rig):
    hub, part, spawned, _helper, _prompts = rig
    hub.set_feature_prefs({"call_notes": False})
    assert (await part.start("x")).startswith("Call notes are off")
    assert hub.meeting is None and spawned == []


async def test_the_title_comes_from_the_calendar_and_the_tool_asks_unless_said(rig):
    hub, part, _spawned, _helper, _prompts = rig
    now = datetime.now()
    await feature_of(hub).look.update(
        [
            {
                "title": "Weekly sync with Acme",
                "begin": now - timedelta(minutes=3),
                "end": now + timedelta(minutes=27),
                "all_day": False,
                "location": "https://zoom.us/j/9",
                "id": "w1",
                "attendees": [],
            }
        ]
    )
    assert part.title_now() == "Weekly sync with Acme"
    [tool] = part.tools()
    cards = []
    hub.add_approval_sink(cards.append)
    hub._turn_text = ""  # not the owner's words: a card first
    task = asyncio.create_task(tool.handler({}))
    assert await until(lambda: cards)
    assert cards[0]["question"] == "Take notes on the call Weekly sync with Acme?"
    hub.resolve(cards[0]["id"], "deny")
    assert (await task)["is_error"] and hub.meeting is None
    hub._turn_text = "take notes on this call"
    out = await tool.handler({})
    assert len(cards) == 1 and hub.meeting.title == "Weekly sync with Acme"
    assert out["content"][0]["text"].startswith("Taking notes on the call Weekly sync with Acme")


def test_labels_and_echoes_in_the_notes_file(tmp_path):
    m = Meeting("Call", tmp_path, now=datetime(2026, 9, 30, 10, 0))
    m.label = "You"
    at = datetime(2026, 9, 30, 10, 1)
    m.add(None, "Can everyone see my screen?", at, speaker="Them")
    m.add(None, "can everyone see my screen", at + timedelta(seconds=2))  # the echo
    m.add(None, "Yes, all good.", at + timedelta(seconds=4))
    m.add(None, "Can everyone see my screen?", at + timedelta(minutes=5))  # later: said again
    m.lines.append((at + timedelta(minutes=6), "a line added directly"))  # no speaker kept
    kept = [(who, text) for _at, text, who in m.kept()]
    assert kept == [
        ("Them", "Can everyone see my screen?"),
        ("You", "Yes, all good."),
        ("You", "Can everyone see my screen?"),
        ("You", "a line added directly"),
    ]
    plain = Meeting("Room", tmp_path, now=datetime(2026, 9, 30, 11, 0))
    plain.add(None, "No labels here.", at)
    assert plain.transcript() == "[10:01] No labels here." and not plain.labeled()
