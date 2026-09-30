"""Hand back: at a captcha, a password, card details, a one-time code or a sign-in wall
JARVIS stops, says it's the owner's turn and waits; "carry on" picks up. It never touches a
captcha."""

import asyncio

import pytest
from test_hub import make_hub

from jarvis.features import browser_ai
from jarvis.features.browser_ai import handback
from jarvis.features.browser_ai.handback import is_carry_on

LOGIN = "https://accounts.example/login"
NEWS = "https://news.example/soup"


def desk_with(hub, needs=None, tabs=None, on_show=4):
    """The desk; the page answers the hand back's look with needs ({kind, what} or a fn of
    the args), and the browser lists tabs (by default one tab 4, on show, on LOGIN)."""
    desk = browser_ai.desk_for(hub)
    looks = []
    raw_calls = []
    tabs = tabs if tabs is not None else [{"id": 4, "url": LOGIN, "shown": True}]

    async def call(action, args=None, timeout=None):
        looks.append((action, dict(args or {})))
        answer = needs(args or {}) if callable(needs) else needs
        url = next((t["url"] for t in tabs if t["id"] == (args or {}).get("tab")), tabs[0]["url"])
        return {"ok": True, "url": url, "kind": "", **(answer or {})}

    async def raw(action, args=None):
        raw_calls.append(action)
        if action == "tabs":
            return {"ok": True, "tabs": tabs}
        return {"ok": True, "url": tabs[0]["url"], "tab": tabs[0]["id"], "message": "Clicked"}

    desk.bridge.call = call
    hub._browser_raw = raw
    hub._guarded_browser = raw
    hub.browser_available = True
    desk.page.on_page({"open": True, "url": tabs[0]["url"], "tab": on_show, "visible": True})
    return desk, looks, raw_calls


def events(q, kind="browser_ai_handback"):
    out = []
    while not q.empty():
        ev = q.get_nowait()
        if ev["type"] == kind:
            out.append(ev)
    return out


@pytest.mark.parametrize(
    "text",
    ["carry on", "Carry on.", "OK, continue", "go ahead", "I'm done", "done", "all set",
     "I've signed in", "you can carry on now", "继续", "继续吧", "好了", "我登录了", "完成了"],
)  # fmt: skip
def test_carry_on_in_both_languages(text):
    assert is_carry_on(text, "zh" if any("一" <= c <= "鿿" for c in text) else "en")


@pytest.mark.parametrize(
    "text", ["carry on with the email to Ann", "continue scrolling", "what's done", "明天继续开会"]
)
def test_other_words_aren_t_carry_on(text):
    assert not is_carry_on(text, "zh" if any("一" <= c <= "鿿" for c in text) else "en")


async def test_a_captcha_is_never_touched_and_the_page_is_handed_back(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, looks, raw_calls = desk_with(hub, {"kind": "captcha", "what": "a captcha"})
    q = hub.subscribe()
    refused = await hub.browser_call("click", {"text": "I'm not a robot"})
    assert refused["ok"] is False and "never try to solve a captcha" in refused["message"]
    assert "click" not in raw_calls  # the press never happened
    assert looks[-1] == ("handback", {"codes": True, "tab": 4})  # the tab it would land in
    shown = events(q)
    assert shown == [{"type": "browser_ai_handback", "tab": 4, "url": LOGIN,
                      "host": "accounts.example", "need": "captcha", "what": "a captcha"}]  # fmt: skip
    # Until the owner carries on, nothing acts on that tab.
    waiting = await hub.browser_call("act", {"kind": "click", "ref": "e2"})
    assert waiting["ok"] is False and "user's turn" in waiting["message"]
    assert await hub.browser_call("read", {}) is not None  # reading is fine


async def test_a_password_page_is_handed_back_until_the_owner_carries_on(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    desk, _, raw_calls = desk_with(hub, {"kind": "password", "what": "a password"})
    q = hub.subscribe()
    refused = await hub.browser_call("type", {"text": "ann@example.com", "field": "Email"})
    assert refused["ok"] is False and "needs the user: a password" in refused["message"]
    assert "type" not in raw_calls and desk.handback.live()["kind"] == "password"
    await hub.ask("I'm done, carry on")
    sent = hub.client.queries[-1]
    assert "needed the user (a password) and they say they've done their part" in sent
    assert desk.handback.live() is None and events(q)[-1] == {
        "type": "browser_ai_handback",
        "tab": None,
    }
    # The same page just cleared: acting there goes ahead (the sign-in form is still up).
    assert (await hub.browser_call("click", {"text": "Next"}))["message"] == "Clicked"


async def test_a_captcha_is_refused_even_on_a_page_just_cleared(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub, {"kind": "login", "what": "signing in"})
    await hub.browser_call("click", {"text": "Go"})
    desk.handback.on_cancel({})
    assert (await hub.browser_call("click", {"text": "Go"}))["ok"] is True
    desk, _, _ = desk_with(hub, {"kind": "captcha", "what": "a captcha"})
    assert (await hub.browser_call("click", {"text": "Go"}))["ok"] is False


async def test_landing_on_such_a_page_says_so_to_claude(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    tabs = [{"id": 4, "url": NEWS, "shown": True}]
    desk, _, _ = desk_with(hub, None, tabs=tabs)

    def needs(args):
        return {"kind": "login", "what": "signing in"} if args.get("tab") == 7 else {}

    desk, looks, _ = desk_with(hub, needs, tabs=tabs + [{"id": 7, "url": LOGIN}])
    result = {"ok": True, "url": LOGIN, "title": "Sign in", "tab": 7, "message": "Opened"}
    out = await desk.handback.on_result("open", {"owner": "jarvis"}, result)
    assert out["message"].startswith("This page needs the user: signing in.")
    assert out["message"].endswith("Opened") and out["notices"][-1].startswith("This page needs")
    assert desk.handback.live()["tab"] == 7
    # Nothing to hand back, a scroll, a failed call: left as they are.
    assert await desk.handback.on_result("read", {}, {"ok": True, "url": NEWS, "tab": 4}) is None
    assert await desk.handback.on_result("act", {"kind": "scroll"}, result) is None
    assert await desk.handback.on_result("open", {}, {"ok": False, "message": "no"}) is None


async def test_a_jarvis_code_session_gets_the_note_but_no_banner(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, looks, _ = desk_with(hub, {"kind": "password", "what": "a password"})
    q = hub.subscribe()
    refused = await hub.browser_call("click", {"text": "Sign in", "owner": "code:2"})
    assert refused["ok"] is False and desk.handback.live() is None and events(q) == []
    # Its own app on this Mac: signing in there is its work.
    local = [{"id": 5, "url": "http://localhost:3000/login", "shown": True}]
    desk, looks, _ = desk_with(
        hub, {"kind": "password", "what": "a password"}, tabs=local, on_show=5
    )
    looks.clear()
    assert (await hub.browser_call("click", {"text": "Sign in", "owner": "code:2"}))["ok"] is True
    assert looks == []


async def test_codes_follow_the_owner_s_setting(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, looks, _ = desk_with(hub, {})
    await hub.browser_call("click", {"text": "Go"})
    assert looks[-1][1]["codes"] is True  # JARVIS may type a code from the owner's mail
    hub.set_prefs({"type_codes": False})
    await hub.browser_call("click", {"text": "Go"})
    assert looks[-1][1]["codes"] is False


async def test_the_banner_s_buttons_and_letting_go(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    desk, _, _ = desk_with(hub, {"kind": "code", "what": "a one-time code"})
    await hub.browser_call("click", {"text": "Go"})
    await hub._handle({"type": "browser_ai_carry_on"})
    for _ in range(100):
        if hub.client.queries:
            break
        await asyncio.sleep(0.01)
    assert hub.client.queries[-1].endswith("Carry on.") and desk.handback.live() is None
    await hub.browser_call("click", {"text": "Go"})  # (cleared: not handed back again)
    assert desk.handback.live() is None
    desk.handback._cleared.clear()
    await hub.browser_call("click", {"text": "Go"})
    await hub._handle({"type": "browser_ai_handback_cancel"})
    assert desk.handback.live() is None
    hub.client.queries.clear()
    await hub._handle({"type": "browser_ai_carry_on"})  # nothing open: nothing asked
    await asyncio.sleep(0.05)
    assert hub.client.queries == []
    desk.handback._cleared.clear()
    await hub.browser_call("click", {"text": "Go"})
    monkeypatch.setattr(handback, "OPEN_SECONDS", -1)  # left open too long: it lets go
    assert desk.handback.live() is None


async def test_continue_is_carry_on_not_a_scroll_while_one_is_open(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub, {"kind": "login", "what": "signing in"})
    await hub.browser_call("click", {"text": "Go"})
    desk.voice._scrolled_at = asyncio.get_running_loop().time()  # a scroll just now
    assert await desk.voice.instant("continue") is None


def test_the_feature_s_chinese_never_says_the_wake_word():
    """What JARVIS says in Chinese must never wake it (test_lang checks the core's; these
    join the core's only once a hub has installed the feature)."""
    import re

    from jarvis import lang
    from jarvis.features.browser_ai.texts import TEXTS

    for chinese in TEXTS.values():
        assert not lang.find_wake_zh(re.sub(r"\{[a-z_]+\}", "X", chinese))[0], chinese
