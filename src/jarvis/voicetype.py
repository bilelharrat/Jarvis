"""Voice typing with hands-free: "Jarvis, start typing", and what the owner says next is
typed where the keyboard focus is, in any app, until "stop typing" (or "Jarvis, stop").
"Jarvis, type <words>" types one line. Nothing goes to Claude: the words are typed as heard,
with a few spoken edits ("new line", "new paragraph", "scratch that", "press enter").

"Read that back" (or "read the last line") reads what voice typing typed, in JARVIS's voice
or to the screen reader; it is never typed. It works while typing and after it has stopped.

"New line" is Shift-Return, the newline that doesn't send in chat apps; only "press enter"
(or "press return") presses Return itself, because the owner said to. Only the owner's own
voice types (the hands-free voice check), and JARVIS's own voice is dropped before this.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# The voice typing commands, said after the wake word ("Jarvis, start typing").
_START = re.compile(
    r"^(?:please\s+)?(?:(?:start|begin|turn\s+on|switch\s+on)\s+(?:voice\s+)?(?:typing|dictation|dictating)"
    r"|(?:type|dictate|write)\s+(?:for\s+me|what\s+i\s+say)"
    r"|(?:voice\s+typing|dictation\s+mode|typing\s+mode|talk\s+to\s+type)(?:\s+on)?"
    # The everyday ways: "let me dictate", "I want to type by voice", "take dictation",
    # "type what I say", "help me write by talking". Anything else goes to JARVIS, whose
    # voice_typing tool understands the rest ("I'm trying to write with you").
    r"|(?:let\s+me|i\s+(?:want|need|would\s+like|'d\s+like)\s+to)\s+(?:dictate|type\s+by\s+(?:voice|talking)|write\s+by\s+(?:voice|talking))"
    r"|take\s+(?:a\s+|some\s+)?dictation"
    r"|(?:type|write)\s+(?:what|everything|whatever)\s+i\s+(?:say|tell\s+you)"
    r"|(?:help\s+me\s+)?(?:type|write)\s+by\s+(?:voice|talking))$",
    re.IGNORECASE,
)
_STOP = re.compile(
    r"^(?:(?:stop|end|finish|quit|turn\s+off|switch\s+off)\s+(?:voice\s+)?(?:typing|dictation|dictating)"
    r"|(?:voice\s+typing|dictation\s+mode|typing\s+mode|talk\s+to\s+type)\s+off"
    r"|done\s+(?:typing|dictating)|i'?m\s+done(?:\s+typing)?)$",
    re.IGNORECASE,
)
# "Type" only: "write an email to Pepper" is a request for JARVIS, not words to type.
_ONCE = re.compile(r"^type(?:\s+(?:this|out|in))?\s*[:,]?\s+(.+)$", re.IGNORECASE)

_START_ZH = re.compile(r"^(?:开始|打开)(?:语音)?(?:打字|输入|听写)$|^语音输入$|^帮我打字$")
_STOP_ZH = re.compile(r"^(?:停止|结束|关闭|退出)(?:语音)?(?:打字|输入|听写)$|^打完了$")
_ONCE_ZH = re.compile(r"^(?:输入|打字)[:：，,]?\s*(.+)$")

# Spoken edits inside voice typing: (pattern, action).
_EDITS = [
    (re.compile(r"^new\s+paragraph$|^新段落$|^另起一段$", re.IGNORECASE), "paragraph"),
    (re.compile(r"^(?:new\s+line|next\s+line|line\s+break)$|^换行$", re.IGNORECASE), "line"),
    (re.compile(r"^(?:scratch|delete|undo|erase)\s+that$|^删掉$|^撤销$", re.IGNORECASE), "scratch"),
    (re.compile(r"^press\s+(?:enter|return)$|^按回车$", re.IGNORECASE), "enter"),
    (re.compile(r"^press\s+tab$", re.IGNORECASE), "tab"),
    (
        re.compile(
            r"^(?:read\s+(?:that|it|this|what\s+i(?:'ve)?\s+(?:typed|wrote|written|said))\s+back(?:\s+to\s+me)?|read\s+(?:me\s+)?back\s+what\s+i\s+(?:typed|wrote)|read\s+back|what\s+did\s+(?:i|you)\s+(?:just\s+)?(?:type|write))$|^读一遍$",
            re.IGNORECASE,
        ),
        "readback",
    ),
    (
        re.compile(
            r"^read\s+(?:me\s+)?the\s+last\s+(?:line|sentence)(?:\s+back)?$|^读最后一行$",
            re.IGNORECASE,
        ),
        "lastline",
    ),
]
READ_BACK = ("readback", "lastline")

# How long voice typing waits with nothing typed before it turns itself off.
IDLE_SECONDS = 300.0


def _clean(text: str) -> str:
    """A command as said, without the punctuation speech recognition adds around it."""
    return re.sub(r"^[\s,，。.!?！？]+|[\s,，。.!?！？]+$", "", text or "").strip()


def command(said: str) -> tuple[str, str] | None:
    """What a wake-word command means for voice typing: ("start", ""), ("stop", ""),
    ("once", words to type), ("readback" or "lastline", ""), or None (not about typing)."""
    text = _clean(said)
    if not text:
        return None
    if _START.match(text) or _START_ZH.match(text):
        return ("start", "")
    if _STOP.match(text) or _STOP_ZH.match(text):
        return ("stop", "")
    which = read_back_request(text)
    if which:
        return (which, "")
    match = _ONCE.match(text) or _ONCE_ZH.match(text)
    if match and _clean(match.group(1)):
        return ("once", match.group(1).strip())
    return None


def read_back_request(said: str) -> str | None:
    """ "read that back" -> "readback", "read the last line" -> "lastline", else None."""
    action = edit(said)
    return action if action in READ_BACK else None


def ends(said: str) -> bool:
    """Said without the wake word while typing: whether it ends voice typing."""
    text = _clean(said)
    return bool(_STOP.match(text) or _STOP_ZH.match(text)) or text.lower() in {"stop", "停", "停止"}


def edit(said: str) -> str | None:
    """A spoken edit ("new line", "scratch that"...), or None for words to type."""
    text = _clean(said)
    for pattern, action in _EDITS:
        if pattern.match(text):
            return action
    return None


_NO_SPACE_BEFORE = tuple(".,;:!?)]}'\"”’，。；：！？、）")


@dataclass
class VoiceTyping:
    """Whether voice typing is on, and what it typed last (for "scratch that" and for the
    space between one phrase and the next)."""

    on: bool = False
    typed: list[str] = field(default_factory=list)
    # Whether each typed phrase began a line, so "scratch that" puts the line start back.
    began_line: list[bool] = field(default_factory=list)
    line_start: bool = (
        True  # the focus is at the start of a line (nothing typed yet, or a new line)
    )
    # Everything typed since voice typing last started, line breaks too ("\n"), for "read
    # that back". Kept after it stops; a new start begins it again.
    written: list[str] = field(default_factory=list)

    def start(self) -> None:
        self.on = True
        self.typed = []
        self.began_line = []
        self.line_start = True
        self.written = []

    def stop(self) -> None:
        self.on = False
        self.typed = []
        self.began_line = []

    def chunk(self, words: str) -> str:
        """The words as they should be typed after what came before: a space between one
        phrase and the next (none before punctuation, at a line start or after CJK)."""
        words = words.strip()
        if not words:
            return ""
        if self.line_start or words.startswith(_NO_SPACE_BEFORE):
            return words
        if self.typed and re.search(r"[　-鿿]$", self.typed[-1]) and re.match(r"[　-鿿]", words):
            return words
        return " " + words

    def did_type(self, chunk: str) -> None:
        self.written.append(chunk)
        self.typed.append(chunk)
        self.began_line.append(self.line_start)
        self.typed, self.began_line = self.typed[-20:], self.began_line[-20:]
        self.line_start = False

    def did_break(self) -> None:
        self.line_start = True
        self.written.append("\n")

    def scratch(self) -> int:
        """How many characters "scratch that" deletes: the last phrase typed (0: nothing)."""
        if not self.typed:
            return 0
        self.line_start = self.began_line.pop()
        chunk = self.typed.pop()
        for i in range(len(self.written) - 1, -1, -1):
            if self.written[i] == chunk:
                del self.written[i]
                break
        return len(chunk)

    def read_back(self, which: str = "readback") -> str:
        """What was typed ("readback"), or its last line ("lastline"); "" when nothing was."""
        text = "".join(self.written).strip()
        if which == "lastline":
            lines = [line.strip() for line in text.split("\n") if line.strip()]
            return lines[-1] if lines else ""
        return re.sub(r"\n{2,}", "\n\n", text)
