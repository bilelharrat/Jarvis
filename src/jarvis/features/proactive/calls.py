"""Notes for online calls: the call's own sound beside the microphone, so the notes say who
spoke, "You" (the microphone) and "Them" (the call), titled from the calendar event on now.

- The call's sound is what the Mac plays, captured by a ScreenCaptureKit helper
  (native/jarvis-callaudio.swift, built with swiftc the first time it's needed, cached by its
  source's hash): audio only, every app but JARVIS itself, 16 kHz mono. It needs Screen
  Recording for J.A.R.V.I.S. (macOS asks once); without it the notes go on with the
  microphone alone, and JARVIS says why. A Mac that can't build the helper says so once.
- The sound is cut into utterances as the microphone's is (listen.Segmenter) and each goes
  into the notes as Them; the notes model transcribes it like the room's lines. What plays
  while JARVIS itself speaks is left out. A microphone line that only repeats what the call
  just said (no headphones) is left out of the notes (meeting.py).
- Opt-in: Settings › Meetings › Notes for online calls (call_notes, off). Then the meeting
  offer (meetings.py) has "Notes on the call" for a meeting with a call link, and "take
  notes on this call" works by voice (start_call_notes: asks unless the owner's own words
  asked). The helper stops when the notes do.

Tools (server "calls"): start_call_notes. Settings (prefs.features): call_notes.
Cost: no model calls beyond the notes' own write-up (one, as for any meeting notes).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from datetime import datetime
from typing import Any

import numpy as np
from claude_agent_sdk import create_sdk_mcp_server, tool

from ... import hub as hub_module
from ... import lang, listen, prefs, swift_helper
from .briefing import quote
from .meetings import covers, is_call

log = logging.getLogger("jarvis")

SERVER_NAME = "calls"
HELPER = "jarvis-callaudio"
RATE = listen.SAMPLE_RATE
BLOCK = int(RATE * listen.BLOCK_SECONDS)  # samples in one block, as the microphone's
READY_SECONDS = 20  # the helper says it's listening within this long, or it isn't
STOP_SECONDS = 3

prefs.register_feature_pref("call_notes", False)

TEXTS = {
    "Call notes are off: turn on Notes for online calls in Settings › Meetings.": (
        "通话笔记没开：请在“设置 › 会议”里打开“在线通话笔记”。"
    ),
    "Already taking notes for {title}.": "已经在为“{title}”记笔记了。",
    "Taking notes on the call {title}: you and them, here on the Mac.": (
        "正在为通话“{title}”记笔记：你和对方的话都在这台 Mac 上转写。"
    ),
    "Taking notes for {title} with the microphone only: allow Screen Recording for "
    "J.A.R.V.I.S. in System Settings › Privacy & Security so the notes hear the call too.": (
        "正在用麦克风为“{title}”记笔记：请在“系统设置 › 隐私与安全性”里允许 J.A.R.V.I.S. "
        "录屏，笔记才能听到通话本身。"
    ),
    "Taking notes for {title} with the microphone only: the call's sound couldn't be "
    "captured on this Mac.": "正在用麦克风为“{title}”记笔记：这台 Mac 没法录下通话的声音。",
    "Take notes on the call {title}?": "要为通话“{title}”记笔记吗？",
}
lang.add_texts(TEXTS)

_ZH = lang._ASK_LEAD_ZH
ASKED = {
    "start_call_notes": (
        r"(?:take|make|start|keep)\s+(?:some\s+)?notes?\s+(?:on|for|of|during|in)\s+(?:this|the"
        r"|my|our)\s+(?:call|zoom|meet|teams(?:\s+call)?|video\s+call|webex|facetime)\b"
        r"|(?:record|transcribe)\s+(?:this|the|my|our)\s+(?:call|zoom|meeting|video\s+call)\b"
        rf"|{_ZH}(?:(?:给|为)?(?:这个|这次|这通)?(?:通话|电话会议|视频会议|视频通话)(?:做|记)(?:个|一下|一份)?笔记"
        r"|记(?:一下)?(?:这个|这次|这通)?(?:通话|视频会议|电话会议)(?:的)?(?:笔记|内容))"
    ),
}
hub_module.FEATURE_ASKED.update({a: hub_module._asks(p) for a, p in ASKED.items()})


def pcm_blocks(data: bytes) -> list[np.ndarray]:
    """16-bit little-endian PCM as float blocks the length of the microphone's."""
    samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    return [samples[i : i + BLOCK] for i in range(0, len(samples) - BLOCK + 1, BLOCK)]


class Calls:
    """One hub's call notes: the helper while a call's notes run, and what it hears."""

    def __init__(self, hub: Any, look: Any) -> None:
        self.hub = hub
        self.look = look
        self.proc: Any = None
        self.reader: asyncio.Task | None = None
        self.meeting: Any = None
        self._now = datetime.now  # the clock (tests set their own)

    def install(self) -> None:
        self.hub.register_server(
            SERVER_NAME,
            self.build_server,
            prompt=PROMPT,
            labels=LABELS,
            quiet=("start_call_notes",),  # what it says is JARVIS's own words
        )
        self.hub.add_event_sink(("meeting",), self.on_meeting)

    def on(self) -> bool:
        return bool(self.hub.prefs.feature("call_notes"))

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def say(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.language(), **values)

    def title_now(self) -> str:
        """The meeting on the calendar now (a call, or with people in it), as a title."""
        now = self._now()
        for event in self.look.timed():
            if covers(event, now) and (is_call(event) or event.get("attendees")):
                return quote(event.get("title"), 80)
        return ""

    # ── starting and stopping ──

    async def start(self, title: str = "") -> str:
        """Notes on the call: the room's notes (the microphone, as You) and the call's sound
        (as Them). What to say."""
        if not self.on():
            return self.say(
                "Call notes are off: turn on Notes for online calls in Settings › Meetings."
            )
        if self.hub.meeting is not None:
            return self.say("Already taking notes for {title}.", title=self.hub.meeting.title)
        helper = await asyncio.to_thread(swift_helper.ensure, HELPER)
        title = " ".join(str(title or "").split())[:80] or self.title_now() or "Call"
        reply = await self.hub.start_meeting(title)
        meeting = self.hub.meeting
        if meeting is None:
            return reply  # no microphone: no notes at all, and it says why
        meeting.label = "You"
        if helper is None:
            return self.say(
                "Taking notes for {title} with the microphone only: the call's sound couldn't "
                "be captured on this Mac.",
                title=meeting.title,
            )
        why = await self._listen(helper, meeting)
        if why == "no_permission":
            return self.say(
                "Taking notes for {title} with the microphone only: allow Screen Recording for "
                "J.A.R.V.I.S. in System Settings › Privacy & Security so the notes hear the "
                "call too.",
                title=meeting.title,
            )
        if why:
            log.info("calls: the call's sound isn't being heard (%s)", why)
            return self.say(
                "Taking notes for {title} with the microphone only: the call's sound couldn't "
                "be captured on this Mac.",
                title=meeting.title,
            )
        return self.say(
            "Taking notes on the call {title}: you and them, here on the Mac.", title=meeting.title
        )

    async def _listen(self, helper: Any, meeting: Any) -> str:
        """Start the helper and wait for it to listen: "" when it does, else why not."""
        proc = await asyncio.create_subprocess_exec(
            str(helper),
            str(os.getpid()),  # JARVIS's own voice isn't the call's: the backend…
            str(os.getppid()),  # …and the app it runs in
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        answer = await _answer(proc)
        if not answer.get("ready"):
            await _end(proc)
            return str(answer.get("error") or "no answer")[:200]
        self.proc, self.meeting = proc, meeting
        self.reader = self.hub._spawn(self._read(proc, meeting))
        return ""

    async def stop(self) -> None:
        proc, self.proc = self.proc, None
        reader, self.reader = self.reader, None
        self.meeting = None
        if proc is not None:
            await _end(proc)
        if reader is not None and not reader.done():
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader

    async def on_meeting(self, event: dict[str, Any]) -> None:
        """hub.add_event_sink: the notes stopped, so the call's sound stops too."""
        if not event.get("active") and self.proc is not None:
            await self.stop()

    # ── what the call says ──

    async def _read(self, proc: Any, meeting: Any) -> None:
        segmenter = listen.Segmenter(calibration_blocks=10)
        pending = b""
        while True:
            chunk = await proc.stdout.read(BLOCK * 2 * 20)
            if not chunk:
                break
            pending += chunk
            usable = len(pending) - len(pending) % (BLOCK * 2)
            data, pending = pending[:usable], pending[usable:]
            speaking = self.hub.state == "speaking"
            for block in pcm_blocks(data):
                rms = float(np.sqrt(np.mean(block * block)))
                utterance = segmenter.feed(block, rms)
                if utterance is None or speaking or self.hub.meeting is not meeting:
                    continue  # JARVIS's own voice, or notes that have stopped
                await self._add(meeting, utterance)
        if self.proc is proc:  # the helper ended by itself
            self.proc = None

    async def _add(self, meeting: Any, audio: np.ndarray) -> None:
        """One utterance from the call into the notes as Them: the notes model hears it when
        it's running, else the quick model does now."""
        if meeting.refining():
            meeting.add(audio, "", speaker="Them")
            return
        ears = getattr(self.hub, "transcriber", None)
        text = ""
        if ears is not None and hasattr(ears, "transcribe"):
            try:
                text = await asyncio.to_thread(ears.transcribe, audio, "")
            except Exception as exc:  # a model that failed to load: the line stays empty
                log.info("calls: couldn't transcribe the call (%s)", exc)
        if text and not listen.is_hallucination(text):
            meeting.add(audio, text, speaker="Them")

    # ── the brain's tool ──

    def build_server(self):
        return create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=self.tools())

    def tools(self) -> list:
        @tool(
            "start_call_notes",
            "Take notes on an online call (Zoom, Meet, Teams, FaceTime…): the call's own sound "
            "and the microphone, so the notes say who spoke (You and Them), titled from the "
            "calendar event on now unless a title is given. Stop them with "
            "stop_meeting_notes. Needs Notes for online calls on in Settings.",
            {"type": "object", "properties": {"title": {"type": "string"}}},
        )
        async def start_call_notes(args):
            title = " ".join(str(args.get("title") or "").split())[:80] or self.title_now()
            question = self.say("Take notes on the call {title}?", title=title or "Call")
            if not await self.hub.feature_gate("start_call_notes", question):
                return _text("The user said no. Don't take notes.", error=True)
            return _text(await self.start(title))

        return [start_call_notes]


async def _answer(proc: Any) -> dict[str, Any]:
    """The helper's answer on stderr ({"ready": true} or {"error": why}), skipping any line
    that isn't one (a system warning); {} when none comes within READY_SECONDS."""
    deadline = time.monotonic() + READY_SECONDS
    for _ in range(50):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            line = await asyncio.wait_for(proc.stderr.readline(), left)
        except TimeoutError:
            break
        if not line:
            break  # the helper ended without one
        try:
            found = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        if isinstance(found, dict) and ("ready" in found or "error" in found):
            return found
    return {}


async def _end(proc: Any) -> None:
    """Close the helper's input (it stops itself), and kill it if it doesn't."""
    with contextlib.suppress(Exception):
        if proc.stdin is not None:
            proc.stdin.close()
    try:
        await asyncio.wait_for(proc.wait(), STOP_SECONDS)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()


LABELS = {"start_call_notes": "Started call notes"}
PROMPT = (
    "\n- Online calls: start_call_notes takes notes on a call with the call's own sound too, so "
    "the notes say who spoke (You and Them); stop_meeting_notes stops them."
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out
