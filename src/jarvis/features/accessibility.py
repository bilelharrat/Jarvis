"""Screen-reader mode: J.A.R.V.I.S. Daredevil, for people who are blind or have low vision.

What it changes while it is on:

- Who reads a reply aloud. With the owner's own screen reader (NVDA, JAWS, Narrator,
  VoiceOver) in charge, JARVIS says nothing out loud for replies and heads-ups: the window
  hands each finished reply to the screen reader once (web/features/accessibility.js), in the
  owner's own voice and speed, so nothing is spoken twice. "Jarvis's voice" keeps JARVIS
  speaking and the window quiet for the screen reader.
- How Claude writes. Every request carries a note: the answer first, plain sentences, no
  tables or decorative symbols, no pointing at layout or colour, counts before lists, what
  was done and what changed, a spoken yes/no before anything that sends, buys, deletes or
  posts, and "I'm not sure" instead of a guess. Verbosity (brief, normal, detailed) sets how
  much.

When it is on: the window reports whether a screen reader is running (Electron says so;
`a11y_state`), and the setting a11y_mode is "auto" (on when one is), "on" or "off". In the app
named J.A.R.V.I.S. Daredevil (hub.edition) Auto is on, whatever is running: it is the same program,
opened in this mode. On a PC
Windows' own flag for a running screen reader, or a well-known one among the programs
(osplat.screen_reader_running), decides, because Electron's answer is "yes" for any program
reading the window through UI Automation, JARVIS's own PC control included, and stays yes for
the session. (One that sets no flag and isn't known is switched on in Settings.)

Settings (prefs.features, changed from Settings › Accessibility): a11y_mode, a11y_voice
("auto": the screen reader when there is one, else JARVIS; "reader"; "jarvis"), a11y_colors
and a11y_text_size (for low vision), a11y_cues (short sounds for listening, thinking, done, needs your
OK and errors) and a11y_cue_volume, a11y_verbosity, a11y_focus (move the keyboard focus to
a question that needs an answer), a11y_say_state (also say what JARVIS is doing).

Commands: a11y_state ({"screen_reader": bool}) from each window. Events: "a11y"
({"effective", "reader_speaks", "detected"}) whenever any of it changes.

Claude cost policy: no extra model call; the note rides on each request.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .. import osplat
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

MODES = ("auto", "on", "off")
VOICES = ("auto", "reader", "jarvis")
VERBOSITY = ("brief", "normal", "detailed")
# For low vision (the window applies them: web/features/zz-contrast.css): the pairing, and the size.
# "auto" is yellow on black and larger text while J.A.R.V.I.S. Daredevil is on, the window's own
# look and size otherwise.
COLORS = ("auto", "yellow", "white", "yellow-bg", "yellow-blue", "off")
SIZES = ("auto", "normal", "large", "larger", "largest")


def _one_of(allowed: tuple[str, ...]):
    def clean(value: Any) -> Any:
        return value if isinstance(value, str) and value in allowed else None

    return clean


def _volume(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return max(0, min(100, int(value)))


register_feature_pref("a11y_mode", "auto", _one_of(MODES))
register_feature_pref("a11y_voice", "auto", _one_of(VOICES))
register_feature_pref("a11y_colors", "auto", _one_of(COLORS))
register_feature_pref("a11y_text_size", "auto", _one_of(SIZES))
register_feature_pref("a11y_cues", True)
register_feature_pref("a11y_cue_volume", 60, _volume)
register_feature_pref("a11y_verbosity", "normal", _one_of(VERBOSITY))
register_feature_pref("a11y_focus", True)
register_feature_pref("a11y_say_state", False)

NOTE = (
    "The user is blind or has low vision and takes in your replies through a screen reader or "
    "by ear, so write for the ear. Put the answer or the result in the first sentence. Use "
    "plain sentences and short paragraphs. No tables, no ASCII art, no emoji or decorative "
    "symbols, and no markdown marks (asterisks, pound signs, backticks) around words. Never "
    'point at layout or colour ("above", "on the left", "the red button"): name what '
    "something is, and give its place in reading order. When you list things, say how many "
    'first ("Three results:") and keep each to a line. Say numbers, times, money and dates '
    "the way you would say them aloud. When you describe a screen or a page, go in reading "
    "order and start with what has focus or what changed; read_window (the controls, as a screen "
    "reader reads them) comes before a screenshot, and a screenshot is for pictures and for apps that "
    "show nothing to read_window. After you do something for the "
    "user, say what you did and what changed, in one sentence. Before anything that sends, "
    "buys, deletes or posts, say exactly what and to whom, then wait for a yes or no. If you "
    "are not sure what you see or read, say so plainly instead of guessing. No filler, and "
    "don't repeat the question back."
)

STYLE = {
    "brief": " Keep every reply to one to three sentences unless the user asks for more.",
    "normal": " Keep replies short, a few sentences; a little more only when the task needs it.",
    "detailed": (
        " Give complete answers with the reasoning, in short spoken paragraphs; for a long "
        'one, signpost it aloud ("First," "Next," "Finally,").'
    ),
}


def note_for(verbosity: str) -> str:
    return NOTE + STYLE.get(verbosity, STYLE["normal"])


WATCH_SECONDS = 5  # how often a PC is asked whether its screen reader is still there


class Accessibility:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.reported = False  # the window says a screen reader is running
        self.detected = False  # …and it is believed (see believed())

    # ── what is on ──

    def edition_on(self) -> bool:
        """The app is J.A.R.V.I.S. Daredevil: its Auto is on."""
        return getattr(self.hub, "edition", "") == "daredevil"

    def effective(self) -> bool:
        mode = self.hub.prefs.feature("a11y_mode")
        if mode == "on":
            return True
        if mode == "off":
            return False
        return self.detected or self.edition_on()

    def reader_speaks(self) -> bool:
        """The screen reader reads JARVIS's replies: JARVIS says nothing out loud. Auto: when there
        is one. Someone with low vision and no screen reader still hears JARVIS."""
        if not self.effective():
            return False
        voice = self.hub.prefs.feature("a11y_voice")
        return voice == "reader" or (voice == "auto" and self.detected)

    def snapshot(self) -> dict[str, Any]:
        snap = {
            "effective": self.effective(),
            "reader_speaks": self.reader_speaks(),
            "detected": self.detected,
        }
        edition = getattr(self.hub, "edition", "")
        if edition:
            snap["edition"] = edition
        return snap

    def announce(self) -> None:
        self.hub.emit("a11y", **self.snapshot())

    # ── the window ──

    def believed(self) -> bool:
        """Is a screen reader there? On a PC Windows is asked first: its flag is set by Narrator,
        NVDA and JAWS and by nothing else, where the window's word also covers any program that
        reads windows through UI Automation (this app's own PC control does, and so do
        dictation tools), and never goes back to "no". Windows with no answer, a Mac: the window."""
        asked = osplat.screen_reader_running()
        return self.reported if asked is None else asked

    def settle(self) -> bool:
        """Work out what is believed; whether it changed."""
        detected = self.believed()
        if detected == self.detected:
            return False
        self.detected = detected
        log.info("accessibility: screen reader %s", "detected" if detected else "not detected")
        return True

    def state(self, msg: dict[str, Any]) -> None:
        self.reported = bool(msg.get("screen_reader"))
        self.settle()
        self.announce()  # (always: a new window needs the answer too)

    async def watch(self) -> None:
        """On a PC, a screen reader started or quit since the window last said."""
        if not osplat.IS_WIN:
            return
        while True:
            await asyncio.sleep(WATCH_SECONDS)
            if self.settle():
                self.announce()

    # ── Claude ──

    async def context(self, _text: str, display: str | None) -> dict[str, Any] | None:
        if display is not None or not self.effective():  # (words someone else sent on)
            return None
        return {"note": note_for(self.hub.prefs.feature("a11y_verbosity"))}


def install(hub: Any) -> None:
    feature = Accessibility(hub)
    hub.accessibility = feature
    hub.speaker.defer_to_reader = feature.reader_speaks
    hub.add_request_context(feature.context)
    hub.register_command("a11y_state", feature.state)
    if osplat.IS_WIN:
        hub.register_loop("a11y", feature.watch)
    # Settings changed in the window or by voice: the window is told what is on now.
    set_prefs = hub.set_prefs

    def set_prefs_then_tell(changes: dict[str, Any], from_tool: bool = False) -> list[str]:
        changed = set_prefs(changes, from_tool=from_tool)
        if "features" in changed:
            feature.announce()
        return changed

    hub.set_prefs = set_prefs_then_tell
