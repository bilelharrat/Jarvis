"""Eden Code's Browser pane and a session's browser tools (jarvis.browser_agent, the hub):
while the owner has the pane open, a session's calls that name no tab go to the tab on show
there (the page the owner watches, as the Claude desktop app's browser tools do), and
browser_open opens there too; with the pane closed a session keeps to its own tab. And
browser_find: the snapshot's lines that match some words, with their refs. The window is a
fake that answers the way app/browser-agent.js does."""

from types import SimpleNamespace

from jarvis import brain, browser_agent, code_tools
from jarvis.browser_agent import CodeSession, find_lines
from jarvis.hub import Hub, tool_label
from tests.test_browser_agent import TabWindow, Tasks, handlers, text_of


async def test_with_the_pane_open_a_session_works_in_the_tab_on_show():
    window = TabWindow()
    routes = browser_agent.TabRoutes()
    session = CodeSession(Tasks(), 7, routes)
    tools = handlers(code_tools.browser_tools(window, session))
    await tools["browser_open"]({"url": "http://localhost:5173/"})  # pane closed: its own tab
    own = session.tab
    assert own == 3 and window.last("open")["newTab"] is True

    routes.set_pane(True)  # the owner opens the Browser pane (code_browser_pane)
    assert session.tab is None and routes.session_tab(7) == own  # (its own tab is kept for later)
    window.shown = 2  # the owner is looking at another tab
    await tools["browser_read"]({})
    assert "tab" not in window.last("read") and window.last("read")["owner"] == "code:7"
    await tools["browser_open"]({"url": "http://localhost:5173/login"})
    assert window.last("open") == {"url": "http://localhost:5173/login", "owner": "code:7"}
    assert window.tabs[2]["url"] == "http://localhost:5173/login"  # in the tab on show
    assert routes.session_tab(7) == own  # …which doesn't become the session's own

    # a tab of its own, or one behind, when it asks for one
    await tools["browser_open"]({"url": "http://localhost:5173/a", "new_tab": True})
    assert window.last("open")["newTab"] is True
    await tools["browser_open"]({"url": "http://localhost:5173/b", "background": True})
    assert window.last("open")["newTab"] is True and window.last("open")["background"] is True
    # a call that names a tab still goes there
    await tools["browser_read"]({"tab": 2})
    assert window.last("read")["tab"] == 2

    routes.set_pane(False)  # the pane closed: back to its own tab
    assert session.tab == routes.session_tab(7)
    await tools["browser_read"]({})
    assert window.last("read")["tab"] == session.tab


async def test_the_gate_reads_the_page_the_session_will_act_on():
    """tasks.page_url (the hub's _session_page_url): the pane's tab on show while it's open."""
    asked = []

    async def raw(action, args=None):
        asked.append(dict(args or {}))
        return {"ok": True, "url": "http://localhost:5173/", "title": "App", "text": ""}

    routes = browser_agent.TabRoutes()
    routes.set_session(7, 5)
    hub = SimpleNamespace(browser_tabs=routes, _browser_raw=raw)
    await Hub._session_page_url(hub, 7)
    assert asked[-1].get("tab") == 5
    routes.set_pane(True)
    await Hub._session_page_url(hub, 7)
    assert "tab" not in asked[-1]
    await Hub._session_page_url(hub, 7, 9)  # a call that names its tab
    assert asked[-1].get("tab") == 9


def test_the_hub_hears_the_pane_open_and_close():
    source = (browser_agent.__file__.rsplit("/", 1)[0]) + "/hub.py"
    text = open(source, encoding="utf-8").read()
    assert 'elif kind == "code_browser_pane":' in text
    assert 'self.browser_tabs.set_pane(msg.get("open"))' in text
    routes = browser_agent.TabRoutes()
    routes.set_pane("yes")
    assert routes.pane_open is True
    routes.set_pane(None)
    assert routes.pane_open is False


SNAP = [
    "- heading \"Sign in\" [e1]\n- textbox \"Email\" [e2] (in view)\n- button \"Sign in\" [e3] (in view)",
    "- link \"Forgot password?\" [e4]\n- button \"Sign in with Apple\" [e5]",
]


class SnapWindow:
    """Snapshots in pages, as app/browser-agent.js gives them (offset, next, total)."""

    def __init__(self, pages=SNAP):
        self.pages = pages
        self.calls = []

    async def __call__(self, action, args=None):
        args = dict(args or {})
        self.calls.append((action, args))
        if action != "snapshot":
            return {"ok": True}
        at = int(args.get("offset") or 0)
        page = at // 10
        if page >= len(self.pages):
            return {"ok": True, "text": "", "tab": 2, "url": "http://localhost:5173/", "title": "App"}
        nxt = (page + 1) * 10 if page + 1 < len(self.pages) else 0
        return {"ok": True, "text": self.pages[page], "tab": 2, "url": "http://localhost:5173/", "title": "App", "total": 20, "next": nxt}


def test_find_lines_keeps_lines_with_every_word_and_a_ref():
    text = "\n".join(SNAP)
    assert find_lines(text, "sign in") == [
        '- heading "Sign in" [e1]',
        '- button "Sign in" [e3] (in view)',
        '- button "Sign in with Apple" [e5]',
    ]
    assert find_lines(text, "APPLE button") == ['- button "Sign in with Apple" [e5]']
    assert find_lines(text, "  ") == []
    assert find_lines("Sign in without a ref", "sign") == []
    assert len(find_lines(text, "sign", limit=1)) == 1


async def test_browser_find_reads_the_whole_page_and_marks_it_untrusted():
    window = SnapWindow()
    session = CodeSession(Tasks(), 7, browser_agent.TabRoutes())
    tools = handlers(code_tools.browser_tools(window, session))
    out = await tools["browser_find"]({"query": "sign in"})
    text = text_of(out)
    assert not out.get("is_error")
    assert "3 matches for “sign in”" in text and "[e5]" in text
    assert browser_agent.UNTRUSTED in text  # the page's words are data
    offsets = [a.get("offset") for c, a in window.calls if c == "snapshot"]
    assert offsets == [0, 10]  # both pages read, then it stopped
    assert all(a.get("owner") == "code:7" for _c, a in window.calls)
    none = await tools["browser_find"]({"query": "checkout"})
    assert "Nothing on the page matches" in text_of(none)
    empty = await tools["browser_find"]({"query": ""})
    assert empty.get("is_error")


async def test_browser_find_passes_the_window_error_on():
    async def window(action, args=None):
        return {"ok": False, "message": "The page's developer tools are open, so I can't drive it. Close them first."}

    tools = handlers(code_tools.browser_tools(window, CodeSession(Tasks(), 7)))
    out = await tools["browser_find"]({"query": "x"})
    assert out.get("is_error") and "developer tools" in text_of(out)


def test_browser_find_only_looks():
    assert f"mcp__{code_tools.BROWSER}__browser_find" in code_tools.READ_ONLY
    assert "browser_find" in brain.BROWSER_LOOKING
    assert tool_label("browser_find") == "Looked for something on the browser page"
