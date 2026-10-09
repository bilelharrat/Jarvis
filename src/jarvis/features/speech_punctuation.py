"""Punctuation by voice, for whoever can't see the screen: saying it when dictating, hearing it when
Jarvis reads, and asking about it, on anything (an email, a document, a page, what Jarvis just said).

Two settings (Settings › Accessibility, or just say so), both kept in prefs.features:
- a11y_dictate_punct: "auto" (the default: Jarvis punctuates what is dictated) or "spoken" (the person says
  "comma", "period", "new paragraph", and gets the marks: in voice typing, and in an email, document or note
  Jarvis writes from their words).
- a11y_read_punct: "none" (the default), "some" (the main marks) or "all" (every mark): how much of the
  punctuation Jarvis's voice says aloud when it speaks, a screen reader's punctuation level. It applies to
  everything Jarvis says (replies, an email read out, a reminder), and the window applies the same to what
  it hands the screen reader.

Said aloud, with no model call: "read the punctuation", "read every punctuation mark", "stop reading
punctuation", "I'll say the punctuation", "punctuate for me". The tools are for the rest:
set_punctuation (the same settings), describe_punctuation (how a text is punctuated: counts, sentences, and
the text with its marks spelled out) and read_with_punctuation (a text with its marks spelled out, to be
said exactly, whatever the level is).

The marks and their words, in either direction, are punctuation.py's.

Claude cost policy: no model call is made here.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import punctuation
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

DICTATE = ("auto", "spoken")
READ = punctuation.LEVELS  # none, some, all
SERVER_NAME = "punctuation"


def _one_of(allowed: tuple[str, ...]):
    def clean(value: Any) -> Any:
        return value if isinstance(value, str) and value in allowed else None

    return clean


register_feature_pref("a11y_dictate_punct", "auto", _one_of(DICTATE))
register_feature_pref("a11y_read_punct", "none", _one_of(READ))

LABELS = {
    "set_punctuation": "Changed the punctuation setting",
    "describe_punctuation": "Described the punctuation",
    "read_with_punctuation": "Spelled out the punctuation",
}
PROMPT = (
    "\n- Punctuation: the user may want it said or dictated. set_punctuation changes the settings: dictate "
    "(auto: you punctuate what they dictate; spoken: they say the marks) and read (none, some or all: how "
    "much of the punctuation your voice says aloud, which the app does for everything you say, so write "
    "normally). describe_punctuation tells how a text is punctuated (pass the text: an email's body, a "
    "paragraph from the screen, what you just said). read_with_punctuation gives a text with its marks "
    "spelled out; say its result exactly, word for word, and nothing else. When they ask you to read "
    "something with its punctuation, fetch the text first (read_email, read_window, the document), then use "
    "read_with_punctuation."
)

# Said to Jarvis, answered at once. "read the punctuation" is the main marks; "every mark" is all.
_READ_ALL = re.compile(
    r"^(?:please\s+)?(?:(?:read|say|speak|give me|tell me)\s+(?:me\s+)?(?:out\s+)?(?:all|every|each)\s+"
    r"(?:the\s+)?(?:punctuation|punctuation marks?|marks?)(?:\s+to me)?"
    r"|(?:punctuation|punctuation level)\s+(?:to\s+)?all|read (?:the )?punctuation (?:level )?all)[.!]?$",
    re.IGNORECASE,
)
_READ_SOME = re.compile(
    r"^(?:please\s+)?(?:(?:read|say|speak|tell me|give me|spell out|include)\s+(?:me\s+)?(?:out\s+)?"
    r"(?:the\s+|all\s+the\s+)?(?:punctuation|punctuation marks?|commas and periods)(?:\s+to me)?"
    r"|(?:turn on|switch on|enable)\s+(?:the\s+)?(?:punctuation|punctuation reading)"
    r"|punctuation\s+(?:on|some))[.!]?$",
    re.IGNORECASE,
)
_READ_NONE = re.compile(
    r"^(?:please\s+)?(?:(?:stop|quit|don'?t|do not|no more)\s+(?:reading|saying|speaking)\s+"
    r"(?:out\s+)?(?:the\s+)?(?:punctuation|punctuation marks?)(?:\s+to me)?"
    r"|(?:turn off|switch off|disable)\s+(?:the\s+)?(?:punctuation|punctuation reading)"
    r"|punctuation\s+off|no punctuation)[.!]?$",
    re.IGNORECASE,
)
_DICTATE_SPOKEN = re.compile(
    r"^(?:please\s+)?(?:(?:i(?:'ll| will)|let me|i want to|i'd like to|i would like to)\s+"
    r"(?:say|dictate|speak)\s+(?:the\s+|my\s+)?(?:punctuation|punctuation marks?)(?:\s+myself)?"
    r"|(?:i(?:'ll| will)\s+)?dictate\s+(?:the\s+)?punctuation"
    r"|(?:turn on|switch on|enable)\s+(?:spoken|dictated)\s+punctuation"
    r"|spoken punctuation\s+on)[.!]?$",
    re.IGNORECASE,
)
_DICTATE_AUTO = re.compile(
    r"^(?:please\s+)?(?:punctuate\s+(?:it\s+|that\s+)?for me|(?:you\s+)?(?:add|put in)\s+the\s+punctuation"
    r"(?:\s+for me|\s+yourself)?|you punctuate|(?:turn off|switch off|disable)\s+(?:spoken|dictated)\s+"
    r"punctuation|spoken punctuation\s+off|stop dictating punctuation)[.!]?$",
    re.IGNORECASE,
)

WORDS_READ = {
    "none": "I won't read the punctuation aloud.",
    "some": "I'll read the main punctuation marks aloud: commas, periods, question marks and the like.",
    "all": "I'll read every punctuation mark aloud.",
}
WORDS_DICTATE = {
    "auto": "I'll punctuate what you dictate.",
    "spoken": "Say the punctuation as you dictate: comma, period, question mark, new paragraph.",
}


class SpeechPunctuation:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    # ── the settings ──

    def read_level(self) -> str:
        value = self.hub.prefs.feature("a11y_read_punct")
        return value if value in READ else "none"

    def dictating(self) -> bool:
        return self.hub.prefs.feature("a11y_dictate_punct") == "spoken"

    def set(self, dictate: str | None = None, read: str | None = None) -> list[str]:
        """Change either setting; the words that say what is now so."""
        changes: dict[str, Any] = {}
        if dictate in DICTATE:
            changes["a11y_dictate_punct"] = dictate
        if read in READ:
            changes["a11y_read_punct"] = read
        if changes:
            self.hub.set_prefs({"features": changes}, from_tool=True)
        said = []
        if "a11y_read_punct" in changes:
            said.append(WORDS_READ[changes["a11y_read_punct"]])
        if "a11y_dictate_punct" in changes:
            said.append(WORDS_DICTATE[changes["a11y_dictate_punct"]])
        return said

    # ── hearing it: what Jarvis's voice says ──

    def speak(self, text: str) -> str:
        """The text with its marks said, at the person's level: what the voice is given."""
        level = self.read_level()
        if level == "none" or not text:
            return text
        try:
            return punctuation.to_speech(text, level, self.hub.language)
        except Exception:  # a text it can't read: it is spoken as it is
            log.exception("punctuation: couldn't spell out a text")
            return text

    # ── saying it: what is dictated ──

    def dictated(self, said: str, after: str = "") -> str:
        """Words dictated into voice typing, with the spoken marks turned into marks (when the person says
        the punctuation); `after` is what was typed just before, so a phrase that carries on a sentence
        keeps its own first letter and one that begins a sentence has a capital."""
        if not self.dictating() or not said.strip():
            return said
        try:
            made = punctuation.from_speech(said, self.hub.language)
        except Exception:
            log.exception("punctuation: couldn't read dictated marks")
            return said
        carries_on = bool(after.strip()) and not re.search(
            r"[.!?…。！？]\s*[)\"'”’]*\s*$|\n\s*$", after
        )
        if carries_on:  # (a phrase in the middle of a sentence is not a new sentence)
            word = re.search(r"[^\W\d_][\w'’-]*", made)
            if word:
                original = next(
                    (w for w in re.findall(r"[\w'’-]+", said) if w.lower() == word.group().lower()),
                    "",
                )
                if original and original[0].islower() and word.group()[0].isupper():
                    at = word.start()
                    made = made[:at] + original[0] + made[at + 1 :]
        return made

    async def context(self, _text: str, display: str | None) -> dict[str, Any] | None:
        """What Claude is told with a request while the person says their punctuation."""
        if display is not None or not self.dictating():
            return None
        return {
            "note": (
                "The user dictates their punctuation. In words they give you to put in an email, a message, a "
                "document or a note, 'comma', 'period' or 'full stop', 'question mark', 'exclamation mark', "
                "'colon', 'semicolon', 'dash', 'hyphen', 'open quote' and 'close quote', 'open parenthesis' "
                "and 'close parenthesis', 'new line' and 'new paragraph' are the marks, not words: write the "
                "mark (a comma, a period...) with the usual spacing and a capital after a period, a question "
                "mark or a new paragraph. A mark word used as an ordinary word ('the Renaissance period', 'a "
                "dash of salt') stays a word. Use their words exactly, and read the whole text back before it "
                "is sent."
            )
        }

    # ── said aloud, answered at once ──

    async def instant(self, text: str) -> str | None:
        said = " ".join(str(text or "").split())
        if not said or len(said) > 90:
            return None
        if _READ_ALL.match(said):
            return " ".join(self.set(read="all"))
        if _READ_NONE.match(said):
            return " ".join(self.set(read="none"))
        if _READ_SOME.match(said):
            return " ".join(self.set(read="some"))
        if _DICTATE_SPOKEN.match(said):
            return " ".join(self.set(dictate="spoken"))
        if _DICTATE_AUTO.match(said):
            return " ".join(self.set(dictate="auto"))
        return None

    # ── the tools ──

    def build_server(self):
        desk = self

        @tool(
            "set_punctuation",
            "Change how the user wants punctuation handled. dictate: 'auto' (you punctuate what they dictate) or "
            "'spoken' (they say comma, period, new paragraph themselves). read: 'none', 'some' (the main marks) "
            "or 'all' (every mark): how much punctuation your voice says aloud when it speaks.",
            {
                "type": "object",
                "properties": {"dictate": {"type": "string"}, "read": {"type": "string"}},
            },
        )
        async def set_punctuation(args):
            dictate, read = args.get("dictate"), args.get("read")
            if dictate not in (None, "", *DICTATE) or read not in (None, "", *READ):
                return _text("dictate is auto or spoken; read is none, some or all.", True)
            said = desk.set(dictate or None, read or None)
            return _text(" ".join(said) or "Nothing was changed.")

        @tool(
            "describe_punctuation",
            "How a text is punctuated: its sentences and each kind of mark counted, and the text with its marks "
            "spelled out. Pass the text itself (an email's body, a paragraph read from the screen, what you "
            "just said). For 'how is this punctuated?' and 'is there a comma after however?'.",
            {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        )
        async def describe_punctuation(args):
            text = str(args.get("text") or "")
            if not text.strip():
                return _text("There's no text to describe.", True)
            found = punctuation.describe(text[:20000], desk.hub.language)
            return _text(f"{found['summary']}\nWith the marks spelled out: {found['spoken']}")

        @tool(
            "read_with_punctuation",
            "A text with its punctuation spelled out (comma, period, new paragraph...), for you to say exactly, "
            "word for word, and nothing else. level: 'all' (every mark, the default) or 'some' (the main ones).",
            {
                "type": "object",
                "properties": {"text": {"type": "string"}, "level": {"type": "string"}},
                "required": ["text"],
            },
        )
        async def read_with_punctuation(args):
            text = str(args.get("text") or "")
            if not text.strip():
                return _text("There's no text to read.", True)
            level = str(args.get("level") or "all")
            if level not in ("some", "all"):
                level = "all"
            spoken = punctuation.to_speech(text[:20000], level, desk.hub.language)
            return _text("Say this exactly, word for word, and nothing else:\n" + spoken)

        return create_sdk_mcp_server(
            name=SERVER_NAME,
            version="0.1.0",
            tools=[set_punctuation, describe_punctuation, read_with_punctuation],
        )


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def install(hub: Any) -> None:
    desk = SpeechPunctuation(hub)
    hub.speech_punctuation = desk
    hub.speaker.punctuation = desk.speak  # (speech.Speaker.clean hands every sentence to it first)
    hub.add_request_context(desk.context)
    hub.register_instant(desk.instant)
    hub.register_server(
        SERVER_NAME,
        desk.build_server,
        prompt=PROMPT,
        labels=LABELS,
        quiet=("set_punctuation", "describe_punctuation", "read_with_punctuation"),
    )
