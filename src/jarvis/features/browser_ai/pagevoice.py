"""Short spoken commands for the page on show in the built-in browser, done at once without
asking Claude: scroll (a bit, a page, a lot), top and bottom, back and forward, zoom in, out
and back to normal, find on the page, a new tab, close the tab, bookmark the page, reload.

The Research Center's words are reused (research.parse and its Chinese twin, reached through
lang.parse_research): scrolling, the page's ends, history and zoom mean the same on any
page. What only a browser has (find, tabs, bookmarks, reload) is parsed here, in English and
Chinese. They apply only while a web page is on show in the dock of the J.A.R.V.I.S. window
in front (desk.PageVoice checks); anything else goes on as before, to the Mac's own commands
or to Claude.

A bare "more", "next", "continue" or "keep going" (继续, 更多, 接着看) scrolls only right
after a scroll: on its own it could mean anything.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from ... import lang, research

FOLLOW_UP = 15.0  # seconds after a scroll that a bare "more" scrolls again
FRONT_SECONDS = 2.0
UI_SECONDS = 5.0
BOOKMARKED = "Bookmarked."
ALREADY = "It's already bookmarked."


@dataclass(frozen=True)
class PageCommand:
    op: str  # scroll | back | forward | zoom | find | new_tab | close_tab | bookmark | reload
    args: dict[str, Any] = field(default_factory=dict)
    follow_up: bool = False  # a bare "more": only right after a scroll


_BARE_MORE = frozenset({"more", "next", "continue", "keep going"})
_BARE_MORE_ZH = frozenset({"继续", "更多", "接着看"})
_KEEP_SCROLLING = re.compile(r"^(?:keep|continue|carry\s+on)\s+scrolling(?:\s+down)?$")
_PAGE = r"(?:the|this|current)\s+(?:web\s?)?(?:page|article|site|tab)"
_FIND = [
    re.compile(rf"^(?:find|search\s+for|look\s+for|locate)\s+(?P<q>.+?)\s+(?:on|in)\s+{_PAGE}$"),
    re.compile(rf"^(?:search|look\s+through)\s+{_PAGE}\s+for\s+(?P<q>.+)$"),
    re.compile(r"^find\s+(?:on|in)\s+(?:the\s+|this\s+)?page\s+(?P<q>.+)$"),
]
_FIND_BARE = re.compile(
    r"^(?:find|find\s+(?:on|in)\s+(?:the\s+|this\s+)?page|search\s+(?:the|this)\s+page)$"
)
_NEW_TAB = re.compile(r"^(?:open\s+)?(?:a\s+)?new\s+tab$")
_CLOSE_TAB = re.compile(r"^close\s+(?:the\s+|this\s+)?(?:current\s+)?tab$")
_BOOKMARK = re.compile(
    r"^(?:bookmark(?:\s+(?:this|it|this\s+page|the\s+page))?"
    r"|add\s+(?:a\s+bookmark|(?:this|it)(?:\s+page)?\s+to\s+(?:my\s+)?bookmarks)"
    r"|save\s+(?:this|it)(?:\s+page)?\s+(?:to|in)\s+(?:my\s+)?bookmarks)$"
)
_RELOAD = re.compile(r"^(?:reload|refresh)(?:\s+(?:the|this)\s+page)?$")

_THIS_PAGE_ZH = r"(?:这个|这|本|当前|此)?(?:页面|网页|页)"
_FIND_ZH = [
    re.compile(rf"^(?:在)?{_THIS_PAGE_ZH}(?:上|里|中|内)?(?:查找|搜索|找一下|找找|找)(?P<q>.+)$"),
    re.compile(r"^(?:页内|页面内)?查找(?P<q>.+)$"),
]
_FIND_BARE_ZH = re.compile(r"^(?:页内查找|页面查找|在页面上查找|查找)$")
_NEW_TAB_ZH = re.compile(r"^(?:打开|新建|新开|开)?(?:一个)?新(?:的)?标签(?:页)?$")
_CLOSE_TAB_ZH = re.compile(
    r"^(?:关闭|关掉|关上)(?:这个|当前|此)?标签(?:页)?$|^把(?:这个|当前)?标签(?:页)?关(?:掉|闭|上)?$"
)
_BOOKMARK_ZH = re.compile(
    rf"^(?:收藏|收藏一下)(?:{_THIS_PAGE_ZH})?$"
    r"|^(?:添加|加入|加个|加一个)书签$"
    rf"|^(?:把)?(?:{_THIS_PAGE_ZH})?(?:加入|添加到|加到|存到|保存到|放进)(?:我的)?书签(?:里|中)?$"
)
_RELOAD_ZH = re.compile(rf"^(?:刷新|重新加载|重载)(?:一下)?(?:{_THIS_PAGE_ZH})?$")
_SHARED = ("scroll", "back", "forward", "zoom")  # what the Research Center's words mean here


def _shared(text: str, language: str) -> PageCommand | None:
    command = lang.parse_research(text, language)
    if command is None or command.action not in _SHARED:
        return None
    return PageCommand(command.action, dict(command.args))


def _clean_query(query: str) -> str:
    query = query.strip().strip("\"'“”‘’「」『』").strip()
    return re.sub(r"^(?:the\s+(?:word|words|phrase|text)\s+)", "", query).strip()[:100]


def parse(text: str, language: str = "en") -> PageCommand | None:
    """A short command for the page on show, or None (it's for something else)."""
    text = str(text or "")
    if lang.has_cjk(text):
        return _parse_zh(text, language)
    t = research.normalize(text)
    if not t or len(t.split()) > 10:
        return None
    if t in _BARE_MORE:
        return PageCommand("scroll", {"direction": "down", "amount": 1}, follow_up=True)
    if _KEEP_SCROLLING.match(t):
        return PageCommand("scroll", {"direction": "down", "amount": 1})
    for pattern in _FIND:
        if m := pattern.match(t):
            query = _clean_query(m.group("q"))
            return PageCommand("find", {"text": query}) if query else None
    if _FIND_BARE.match(t):
        return PageCommand("find", {"text": ""})
    if _NEW_TAB.match(t):
        return PageCommand("new_tab")
    if _CLOSE_TAB.match(t):
        return PageCommand("close_tab")
    if _BOOKMARK.match(t):
        return PageCommand("bookmark")
    if _RELOAD.match(t):
        return PageCommand("reload")
    return _shared(text, "en")


def _parse_zh(text: str, language: str) -> PageCommand | None:
    t = lang._command_zh(text)
    if not t or len(t) > 30:
        return None
    if t in _BARE_MORE_ZH:
        return PageCommand("scroll", {"direction": "down", "amount": 1}, follow_up=True)
    for pattern in _FIND_ZH:
        if m := pattern.match(t):
            query = _clean_query(m.group("q"))
            return PageCommand("find", {"text": query}) if query else None
    if _FIND_BARE_ZH.match(t):
        return PageCommand("find", {"text": ""})
    if _NEW_TAB_ZH.match(t):
        return PageCommand("new_tab")
    if _CLOSE_TAB_ZH.match(t):
        return PageCommand("close_tab")
    if _BOOKMARK_ZH.match(t):
        return PageCommand("bookmark")
    if _RELOAD_ZH.match(t):
        return PageCommand("reload")
    return _shared(text, "zh")


class PageVoice:
    """hub.register_instant: a page command, done in the window's browser (the window's
    browser_ai.js carries out page_ui) when a web page is on show in the dock of the window
    in front; None for anything else. The reply is said only when it's news (a bookmark, or
    why it didn't work): the page itself shows the rest."""

    def __init__(self, hub: Any, bridge: Any, page: Any) -> None:
        self.hub = hub
        self.bridge = bridge
        self.page = page  # pagectx.PageContext: the page on show, as the window said
        self._scrolled_at = float("-inf")

    async def instant(self, text: str) -> str | None:
        command = parse(text, self.hub.language)
        if command is None:
            return None
        state = self.page.page
        if not (state.web and state.visible):
            return None
        if command.follow_up and time.monotonic() - self._scrolled_at > FOLLOW_UP:
            return None
        front = await self.bridge.call("front", {}, timeout=FRONT_SECONDS)
        if not (front.get("ok") and front.get("focused") and front.get("shown")):
            return None  # the Mac's own commands, or Claude, take it
        result = await self.bridge.call(
            "page_ui", {"op": command.op, **command.args}, timeout=UI_SECONDS
        )
        if result.get("error") or result.get("ok") is False:
            return str(result.get("error") or result.get("message") or "That didn't work.")
        if command.op == "scroll":
            self._scrolled_at = time.monotonic()
        if command.op == "bookmark":
            return ALREADY if result.get("already") else BOOKMARKED
        return ""
