"""The browser-ai feature's fixed sentences, as JARVIS says or shows them, with their Chinese
(lang.add_texts at install: translate() and tr() know them from then on)."""

from __future__ import annotations

TEXTS: dict[str, str] = {
    "What's this page?": "这个页面是什么？",
    # page commands (pagevoice.py) and the window's answers to them
    "Bookmarked.": "已加入书签。",
    "It's already bookmarked.": "这个页面已经在书签里了。",
    "There's no page to go back to.": "没有可以返回的页面。",
    "There's no page to go forward to.": "没有可以前进的页面。",
    "The browser didn't answer in time.": "浏览器没有及时响应。",
    "The built-in browser is only in the J.A.R.V.I.S. app.": "内置浏览器只在 J.A.R.V.I.S. 应用里。",
    # watch mode (watch.py): the card before acting on a site set to "ask"
    "Can I act on {host}? You asked me to check first.": "我可以在 {host} 上操作吗？你让我先问你。",
}
