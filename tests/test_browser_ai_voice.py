"""Short spoken commands for the page on show in the built-in browser, done without Claude:
the words (English and Chinese), when they apply (a web page on show in the dock of the
window in front), and what they ask the window to do."""

import pytest
from test_hub import make_hub

from jarvis.features import browser_ai
from jarvis.features.browser_ai import pagevoice
from jarvis.features.browser_ai.pagevoice import PageCommand, parse


@pytest.mark.parametrize(
    ("text", "op", "args"),
    [
        ("scroll down", "scroll", {"direction": "down", "amount": 1}),
        ("Jarvis, scroll up a bit please", "scroll", {"direction": "up", "amount": 0.4}),
        ("go to the top", "scroll", {"direction": "top"}),
        ("bottom of the page", "scroll", {"direction": "bottom"}),
        ("go back", "back", {}),
        ("forward", "forward", {}),
        ("zoom in", "zoom", {"direction": "in"}),
        ("make it smaller", "zoom", {"direction": "out"}),
        ("reset zoom", "zoom", {"direction": "reset"}),
        ("find lentils on this page", "find", {"text": "lentils"}),
        ("search the page for “return policy”", "find", {"text": "return policy"}),
        ("find", "find", {"text": ""}),
        ("open a new tab", "new_tab", {}),
        ("close this tab", "close_tab", {}),
        ("bookmark this page", "bookmark", {}),
        ("add this to my bookmarks", "bookmark", {}),
        ("refresh the page", "reload", {}),
        ("向下滚动", "scroll", {"direction": "down", "amount": 1}),
        ("往下翻两页", "scroll", {"direction": "down", "amount": 2}),
        ("回到顶部", "scroll", {"direction": "top"}),
        ("返回", "back", {}),
        ("前进", "forward", {}),
        ("放大一点", "zoom", {"direction": "in"}),
        ("在页面上查找价格", "find", {"text": "价格"}),
        ("查找退货政策", "find", {"text": "退货政策"}),
        ("打开新标签页", "new_tab", {}),
        ("关闭这个标签页", "close_tab", {}),
        ("收藏这个页面", "bookmark", {}),
        ("把这个页面加入书签", "bookmark", {}),
        ("刷新一下", "reload", {}),
    ],
)
def test_page_commands_in_both_languages(text, op, args):
    language = "zh" if any("一" <= c <= "鿿" for c in text) else "en"
    command = parse(text, language)
    assert command == PageCommand(op, args), text


@pytest.mark.parametrize(
    "text",
    [
        "find cheap flights to Lisbon",  # a search of the web, not of the page
        "close",  # the Research Center's own word
        "open reports",
        "click sign in",
        "what's the weather",
        "summarize this page",
        "bookmark the lease for later in my notes",
        "打开报告",
        "关闭研究中心",
        "明天天气怎么样",
    ],
)
def test_other_words_are_left_for_the_rest(text):
    language = "zh" if any("一" <= c <= "鿿" for c in text) else "en"
    assert parse(text, language) is None


def test_a_bare_more_is_only_a_follow_up():
    for text, language in (("more", "en"), ("keep going", "en"), ("继续", "zh"), ("更多", "zh")):
        command = parse(text, language)
        assert command is not None and command.op == "scroll" and command.follow_up, text
    assert not parse("continue scrolling", "en").follow_up
    assert not parse("继续往下", "zh").follow_up


# ── the handler ──


def voice_with(hub, answers, page=None):
    """The feature's page commands, the window's answers from answers (action -> dict)."""
    desk = browser_ai.desk_for(hub)
    calls = []

    async def call(action, args=None, timeout=None):
        calls.append((action, dict(args or {})))
        return dict(answers.get(action, {"ok": False, "message": "no"}))

    desk.bridge.call = call
    desk.page.on_page(
        page or {"open": True, "url": "https://news.example/soup", "title": "Soup", "tab": 3}
    )
    return desk.voice, calls


IN_FRONT = {"ok": True, "focused": True, "shown": True, "tab": 3}


async def test_a_page_command_is_done_in_the_window(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    voice, calls = voice_with(hub, {"front": IN_FRONT, "page_ui": {"ok": True}})
    assert await voice.instant("scroll down a bit") == ""
    assert calls == [
        ("front", {}),
        ("page_ui", {"op": "scroll", "direction": "down", "amount": 0.4}),
    ]
    assert await voice.instant("find soup on this page") == ""
    assert calls[-1] == ("page_ui", {"op": "find", "text": "soup"})


async def test_a_bookmark_is_said_and_one_already_there_too(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    voice, _ = voice_with(hub, {"front": IN_FRONT, "page_ui": {"ok": True}})
    assert await voice.instant("bookmark this") == pagevoice.BOOKMARKED
    voice, _ = voice_with(hub, {"front": IN_FRONT, "page_ui": {"ok": True, "already": True}})
    assert await voice.instant("bookmark this") == pagevoice.ALREADY


async def test_why_it_didnt_work_is_said(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    no_back = {"ok": False, "message": "There's no page to go back to."}
    voice, _ = voice_with(hub, {"front": IN_FRONT, "page_ui": no_back})
    assert await voice.instant("go back") == "There's no page to go back to."


async def test_only_with_a_web_page_in_front(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    # The window isn't the app in front: the Mac's own scroll takes it.
    voice, calls = voice_with(hub, {"front": {**IN_FRONT, "focused": False}})
    assert await voice.instant("scroll down") is None
    assert [a for a, _ in calls] == ["front"]
    for page in (
        {"open": False, "url": "https://news.example/soup", "tab": 3},  # the dock is closed
        {"open": True, "url": "https://rc.example/markets", "tab": 3, "research": True},
        {"open": True, "url": "about:blank", "tab": 3},
        {"open": True, "url": "https://news.example/soup", "tab": 3, "visible": False},
    ):
        voice, calls = voice_with(hub, {"front": IN_FRONT}, page)
        assert await voice.instant("scroll down") is None, page
        assert calls == [], page  # decided without asking the window
    voice, calls = voice_with(hub, {"front": IN_FRONT})
    assert await voice.instant("what's the weather") is None and calls == []


async def test_more_scrolls_again_only_right_after_a_scroll(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    voice, calls = voice_with(hub, {"front": IN_FRONT, "page_ui": {"ok": True}})
    assert await voice.instant("more") is None and calls == []
    assert await voice.instant("scroll down") == ""
    assert await voice.instant("more") == ""
    assert calls[-1] == ("page_ui", {"op": "scroll", "direction": "down", "amount": 1})
    voice._scrolled_at -= pagevoice.FOLLOW_UP + 1
    assert await voice.instant("more") is None


async def test_a_spoken_page_command_never_reaches_claude(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.set_prefs({"language": "zh"})
    no_back = {"ok": False, "message": "There's no page to go back to."}
    _, calls = voice_with(hub, {"front": IN_FRONT, "page_ui": no_back})
    q = hub.subscribe()
    await hub.ask("返回")
    assert hub.client.queries == []
    assert calls[-1] == ("page_ui", {"op": "back"})
    replies = []
    while not q.empty():
        ev = q.get_nowait()
        if ev["type"] == "reply":
            replies.append(ev["text"])
    assert replies == ["没有可以返回的页面。"]
