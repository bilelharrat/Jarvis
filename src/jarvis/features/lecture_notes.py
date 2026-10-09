"""Lecture and seminar notes: "take notes on this lecture", "record the seminar". The same notes
as meetings (meeting.py: transcribed on this computer with local Whisper, saved as it grows, filed
in the second brain), written up as study notes instead: a summary, the key points, terms and
their definitions, questions raised, and the readings, assignments and dates mentioned.

- The room: the microphone, through the hands-free listener (sounddevice and faster-whisper, on a
  PC as on a Mac).
- The computer's own sound too, when asked (a lecture or seminar watched online): on a PC through
  a loopback input (winloopback.py: a WASAPI loopback device or the sound card's Stereo Mix, when
  the bundled audio library can open one; otherwise the microphone alone, and it says what to
  turn on). On a Mac the call notes' ScreenCaptureKit helper does this (start_call_notes).

stop_meeting_notes stops them (meeting.py's tool), as for any notes.

Claude cost policy: one write-up when the notes stop (meeting.py's), nothing else.
"""

from __future__ import annotations

import logging
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import lang, osplat, winloopback
from ..meeting import LECTURE_LABELED, LECTURE_PROMPT

log = logging.getLogger("jarvis")

TEXTS = {
    "Start taking lecture notes for {title}?": "要开始为“{title}”记课堂笔记吗？",
    " The computer's own sound goes into the notes too.": " 电脑本身播放的声音也会记进笔记。",
    " This PC's own sound can't be captured ({why}), so the notes have the microphone only.": (
        " 这台电脑本身的声音录不下来（{why}），所以笔记只有麦克风的声音。"
    ),
    " On a Mac, start_call_notes takes the computer's own sound too.": (
        " 在 Mac 上，start_call_notes 也能录下电脑本身的声音。"
    ),
}
lang.add_texts(TEXTS)

PROMPT = (
    "\n- Lecture and seminar notes: for 'take notes on this lecture', 'record the seminar', "
    "start_lecture_notes (computer_sound true when the lecture plays on this computer, an online "
    "class or a recording); stop_meeting_notes stops them and writes up study notes (summary, "
    "key points, terms, questions, assignments and dates). meeting_transcript reads what was "
    "said so far ('what did she say about entropy?')."
)
LABELS = {"start_lecture_notes": "Started lecture notes"}


def _text(words: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": words}]}
    if error:
        out["is_error"] = True
    return out


class LectureNotes:
    def __init__(self, hub: Any, open_capture: Any = None) -> None:
        self.hub = hub
        self.open_capture = open_capture or winloopback.open_capture
        self.capture: Any = None
        self.reader: Any = None

    def language(self) -> str:
        prefs = getattr(self.hub, "prefs", None)
        return "zh" if lang.is_zh(getattr(prefs, "language", "") or "") else "en"

    def say(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.language(), **values)

    async def start(self, title: str, computer_sound: bool = False) -> str:
        title = " ".join(str(title or "").split())[:80] or "Lecture"
        before = self.hub.meeting
        reply = await self.hub.start_meeting(title)
        meeting = self.hub.meeting
        if meeting is None or meeting is before:
            return reply  # no microphone, or notes already running: it says which
        meeting.kind = "lecture"
        meeting.prompt = LECTURE_PROMPT
        meeting.labeled_text = LECTURE_LABELED
        if not computer_sound:
            return reply
        if not osplat.IS_WIN:
            return reply + self.say(
                " On a Mac, start_call_notes takes the computer's own sound too."
            )
        capture, why = self.open_capture()
        if capture is None:
            log.info("lecture notes: the PC's own sound isn't being heard (%s)", why)
            return reply + self.say(
                " This PC's own sound can't be captured ({why}), so the notes have the microphone only.",
                why=why,
            )
        meeting.label = "You"
        self.capture = capture
        self.reader = self.hub._spawn(winloopback.feed(capture, meeting, self.hub))
        return reply + self.say(" The computer's own sound goes into the notes too.")

    async def on_meeting(self, event: dict[str, Any]) -> None:
        """hub.add_event_sink: the notes stopped, so the computer's sound stops being heard."""
        if not event.get("active") and self.capture is not None:
            capture, self.capture = self.capture, None
            self.reader = None
            capture.stop()

    def build(self) -> Any:
        @tool(
            "start_lecture_notes",
            "Take notes on a lecture or seminar: what is said in the room is transcribed on this "
            "computer until stop_meeting_notes, then written up as study notes (summary, key "
            "points, terms and definitions, questions raised, assignments and dates). "
            "computer_sound: also the computer's own sound, for a lecture playing on it (an "
            "online class or a recording).",
            {
                "type": "object",
                "properties": {"title": {"type": "string"}, "computer_sound": {"type": "boolean"}},
            },
        )
        async def start_lecture_notes(args):
            title = " ".join(str(args.get("title") or "").split())[:80] or "Lecture"
            gate = getattr(self.hub, "feature_gate", None)
            question = self.say("Start taking lecture notes for {title}?", title=title)
            if gate is not None and not await gate("start_meeting", question):
                return _text("The user said no. Don't take notes.", error=True)
            return _text(await self.start(title, bool(args.get("computer_sound"))))

        return create_sdk_mcp_server(name="lecture", version="0.1.0", tools=[start_lecture_notes])


def install(hub: Any) -> None:
    feature = LectureNotes(hub)
    hub.lecture_notes = feature
    hub.register_server(
        "lecture", feature.build, prompt=PROMPT, labels=LABELS, quiet=("start_lecture_notes",)
    )
    if hasattr(hub, "add_event_sink"):
        hub.add_event_sink(("meeting",), feature.on_meeting)
