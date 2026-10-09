"""Reader mode's reading aloud: the article the dock's reader view shows (page-ai-preload.js
extract, as a reader view finds it), read in JARVIS's own voice through the speech queue, a
paragraph at a time, with pause, resume, skip and back.

- The window starts it (browser_ai_read: the reader's Listen button, or "read this to me"
  said on a page, which opens the reader first) and hears where it is (browser_ai_reading:
  the paragraph, and playing, paused or done), to light that paragraph up.
- Said while it reads (no Claude): pause, stop reading, resume, continue reading, skip, next
  paragraph, back, previous paragraph, read that again; 暂停, 继续读, 跳过, 下一段, 上一段…
- It gives way: a new request (the owner asks something else), "stop" or the mute button
  pauses it where it was; "resume" picks up from that paragraph.
- Code (a <pre> block) is never read aloud; what's read is the page's own words, spoken
  as they are, never handed to a model.

Cost policy: no model calls.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from ... import lang, research
from ...speech import is_silent

MAX_BLOCKS = 400
BLOCK_CHARS = 4000
TOTAL_CHARS = 150_000
KINDS = frozenset({"h", "p", "li", "quote", "caption"})  # what's read (never "pre": code)

_COMMANDS_EN = [
    (re.compile(r"^(?:pause|hold on|wait|pause (?:reading|it|that)|stop reading|stop reading (?:it|this))$"), "pause"),
    (re.compile(r"^(?:resume|continue reading|keep reading|go on reading|carry on reading|resume reading|start reading again)$"), "resume"),
    (re.compile(r"^(?:skip|skip (?:it|this|that|ahead|this (?:paragraph|part|bit|one))|next (?:paragraph|part|one)|skip to the next (?:paragraph|part|one))$"), "skip"),
    (re.compile(r"^(?:previous (?:paragraph|part|one)|back a (?:paragraph|bit)|go back a (?:paragraph|bit)|last paragraph)$"), "back"),
    (re.compile(r"^(?:read (?:that|it) again|again|repeat (?:that|it)|say (?:that|it) again)$"), "again"),
]  # fmt: skip
_COMMANDS_ZH = [
    (re.compile(r"^(?:暂停|先停|停一下|等一下|停止朗读|别读了|不要读了|暂停朗读)$"), "pause"),
    (re.compile(r"^(?:继续读|继续朗读|接着读|接着念|继续念|恢复朗读)$"), "resume"),
    (re.compile(r"^(?:跳过|跳过这段|下一段|读下一段)$"), "skip"),
    (re.compile(r"^(?:上一段|回到上一段|读上一段)$"), "back"),
    (re.compile(r"^(?:再读一遍|重读一遍|再念一遍)$"), "again"),
]
_START_EN = re.compile(
    r"^(?:read (?:this|it|the (?:page|article|story|post))(?: (?:page|article))?(?: (?:to me|aloud|out loud|out))+"
    r"|read (?:this|the) (?:page|article|story|post)(?: for me)?"
    r"|reader (?:mode|view)|open (?:the )?reader(?: (?:mode|view))?)$"
)
_START_ZH = re.compile(
    r"^(?:(?:把)?(?:这篇文章|这个页面|这页|它|这篇)?(?:读|念|朗读)(?:给我)?(?:听)?(?:一下)?"
    r"|朗读(?:这篇文章|这个页面|这页)|打开阅读(?:模式|视图)|阅读模式)$"
)
_SPOKEN = re.compile(
    r"^(?:read (?:this|it|the )|把|读|念|朗读)"
)  # starts the reading, not only the view


def parse(text: str, language: str = "en") -> str | None:
    """A reading command: pause, resume, skip, back, again; open (the reader view) or listen
    (the reader, read aloud); or None."""
    text = str(text or "")
    if lang.has_cjk(text):
        t = re.sub(r"[\s\W_]+", "", lang.to_simplified(text))
        for pattern, action in _COMMANDS_ZH:
            if pattern.match(t):
                return action
        if _START_ZH.match(t):
            return "listen" if "阅读" not in t or "朗读" in t else "open"
        return None
    t = research.normalize(text)
    for pattern, action in _COMMANDS_EN:
        if pattern.match(t):
            return action
    if _START_EN.match(t):
        return "listen" if _SPOKEN.match(t) else "open"
    return None


def clean_blocks(raw: Any) -> list[str]:
    """What's read, from the window's blocks ({kind, text}): headings, paragraphs, list
    items and quotes, never code; bounded."""
    out: list[str] = []
    total = 0
    for block in raw if isinstance(raw, list) else []:
        if len(out) >= MAX_BLOCKS or total >= TOTAL_CHARS:
            break
        if not isinstance(block, dict) or block.get("kind") not in KINDS:
            continue
        text = " ".join(str(block.get("text") or "").split())[:BLOCK_CHARS]
        if text:
            out.append(text)
            total += len(text)
    return out


class Reader:
    def __init__(self, hub: Any, bridge: Any, page: Any) -> None:
        self.hub = hub
        self.bridge = bridge
        self.page = page  # pagectx.PageContext: the page on show, as the window said
        self.blocks: list[str] = []
        self.at = 0
        self.state = "idle"  # playing | paused | idle
        self.title = ""
        self.url = ""
        self._gen = 0  # bumped by anything that ends a paragraph early
        self._task: asyncio.Task | None = None

    # ── the reading itself ──

    def _emit(self) -> None:
        self.hub.emit(
            "browser_ai_reading",
            state=self.state,
            at=self.at,
            count=len(self.blocks),
            url=self.url[:500],
            title=self.title[:300],
            muted=is_silent(self.hub.speaker),  # the window says the voice is off
        )

    def _cut(self) -> None:
        """End the reading's paragraph now. Only while it's playing is the speech queue
        its own to clear: paused, JARVIS may be saying something else."""
        playing = self.state == "playing"
        self._gen += 1
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
        if playing:
            self.hub.speech.clear()

    def _play(self) -> None:
        if is_silent(self.hub.speaker):
            self.state = "paused"
            self._emit()
            return
        self.state = "playing"
        gen = self._gen
        self._task = self.hub._spawn(self._loop(gen))

    async def _loop(self, gen: int) -> None:
        hub = self.hub
        while gen == self._gen and self.at < len(self.blocks):
            self._emit()
            stops = hub._stops  # "stop", the stop button, Esc: hub.stop()
            sentences, rest = lang.split_sentences(
                self.blocks[self.at], final=True, lang=hub.language
            )
            for sentence in [*sentences, rest]:
                if sentence.strip():
                    hub.speech.push(sentence)
            await hub.speech.drain()
            if gen != self._gen:
                return  # paused, skipped, stopped here
            if hub._stops != stops or is_silent(hub.speaker):
                self.state = "paused"  # the owner stopped it: it waits where it was
                self._emit()
                return
            self.at += 1
        if gen == self._gen:
            self.state = "idle"
            self.at = min(self.at, len(self.blocks))
            self._emit()

    def start(self, blocks: list[str], at: int = 0, title: str = "", url: str = "") -> None:
        self._cut()
        self.blocks = blocks
        self.at = max(0, min(at, len(blocks) - 1)) if blocks else 0
        self.title, self.url = title, url
        if not blocks:
            self.state = "idle"
            self._emit()
            return
        self._play()

    def act(self, action: str) -> bool:
        """pause, resume, skip, back, again, stop: False when there's nothing to do it to."""
        if not self.blocks:
            return False
        if action == "pause":
            if self.state != "playing":
                return self.state == "paused"
            self._cut()
            self.state = "paused"
            self._emit()
            return True
        if action == "stop":
            self._cut()
            self.blocks, self.at, self.state = [], 0, "idle"
            self._emit()
            return True
        if action == "resume":
            if self.state == "playing":
                return True
            if self.at >= len(self.blocks):
                self.at = 0
        elif action == "skip":
            self.at += 1
            if self.at >= len(self.blocks):
                self._cut()
                self.state, self.at = "idle", len(self.blocks)
                self._emit()
                return True
        elif action == "back":
            self.at = max(0, self.at - 1)
        elif action != "again":
            return False
        self._cut()
        self._play()
        return True

    # ── what else is going on ──

    def on_turn(self, _event: dict[str, Any]) -> None:
        """hub.add_event_sink("turn"): a request began; the reading gives way."""
        if self.state == "playing":
            self._cut()
            self.state = "paused"
            self._emit()

    # ── the window and the voice ──

    async def instant(self, text: str) -> str | None:
        """hub.register_instant: "read this to me" or "reader mode" on a web page in the
        front window (the window opens its reader, and reads it aloud); while there's a
        reading, pause, resume, skip, back and again. None for anything else."""
        action = parse(text, self.hub.language)
        if action is None:
            return None
        if action in ("open", "listen"):
            state = self.page.page
            if not (state.web and state.visible):
                return None
            front = await self.bridge.call("front", {}, timeout=2.0)
            if not (front.get("ok") and front.get("focused") and front.get("shown")):
                return None
            result = await self.bridge.call(
                "page_ui", {"op": "reader", "listen": action == "listen"}, timeout=12.0
            )
            if result.get("error") or result.get("ok") is False:
                return str(result.get("error") or result.get("message") or "That didn't work.")
            return ""
        if not self.blocks:
            return None  # nothing being read: "pause" is someone else's (the music)
        return "" if self.act(action) else None

    def on_command(self, msg: dict[str, Any]) -> None:
        """browser_ai_read: {action: start (blocks, at, title, url) | pause | resume | skip |
        back | again | stop}."""
        action = str(msg.get("action") or "")
        if action == "start":
            try:
                at = int(msg.get("at") or 0)
            except (TypeError, ValueError):
                at = 0
            self.start(
                clean_blocks(msg.get("blocks")),
                at,
                str(msg.get("title") or "")[:300],
                str(msg.get("url") or "")[:2000],
            )
        else:
            self.act(action)
