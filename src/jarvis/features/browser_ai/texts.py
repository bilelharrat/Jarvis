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
    # the page's menu, Ask Jarvis (menuask.py): the owner's question, as they'd say it
    "Explain what I selected on this page.": "解释一下我在这个页面上选中的内容。",
    "Summarize what I selected on this page.": "总结一下我在这个页面上选中的内容。",
    "Translate what I selected into Chinese.": "把我选中的内容翻译成中文。",
    "Translate what I selected into English.": "把我选中的内容翻译成英文。",
    "Draft a reply to what I selected. Don't send anything.": "针对我选中的内容起草一条回复，先不要发送。",
    "Summarize the page this link goes to ({host}).": "总结一下这个链接指向的页面（{host}）。",
    "Explain this picture from the page.": "解释一下页面上的这张图片。",
    "Saved to your second brain.": "已保存到你的第二大脑。",
    "Second brain": "第二大脑",
    # the hand back (handback.py): the banner's Carry on, in the owner's words
    "Carry on.": "继续。",
}
