"""Watch mode and the owner's say per site: on a sensitive site the browser acts only while
its tab is on show for the owner, a site can be set to always, ask or never (only from
Settings), and what JARVIS reads on a sensitive site counts as the owner's private data."""

from test_hub import make_hub

from jarvis.features import browser_ai
from jarvis.features.browser_ai import watch
from jarvis.features.browser_ai.sites import ADDED_KEY, REMOVED_KEY, RULES_KEY

BANK = "https://secure.chase.com/web/auth/dashboard"
NEWS = "https://news.example/soup"


def desk_with(hub, tabs, on_show=4, window_seen=True):
    """The desk; the browser's own list of tabs answers with tabs ([{id, url, shown}], or a
    whole answer), and the window says which tab is on show and whether it's in view."""
    desk = browser_ai.desk_for(hub)
    calls = []

    async def raw(action, args=None):
        calls.append((action, dict(args or {})))
        if action == "tabs":
            return {"ok": True, "tabs": tabs} if isinstance(tabs, list) else dict(tabs)
        return {"ok": True}

    async def nothing_to_hand_back(action, args=None, timeout=None):
        return {"ok": True, "kind": ""}

    hub._browser_raw = raw
    hub.browser_available = True
    desk.bridge.call = nothing_to_hand_back
    desk.page.on_page({"open": True, "url": NEWS, "tab": on_show, "visible": window_seen})
    return desk, calls


def seen(url, visible, tab=4):
    """One tab, on show in the dock or not."""
    return [{"id": tab, "url": url, "shown": visible, "title": "", "owner": ""}]


def asker(hub, answer=True):
    asked = []

    async def ask(question, detail="", spoken=""):
        asked.append((question, detail, spoken))
        return answer

    hub._ask_user = ask
    return asked


def test_what_counts_as_acting():
    assert watch.acting("click", {}) and watch.acting("type", {})
    assert watch.acting("act", {"kind": "fill"}) and watch.acting("act", {})
    assert watch.acting("dialog", {"accept": True}) and watch.acting("upload", {})
    for action, args in (
        ("act", {"kind": "scroll"}),
        ("dialog", {"op": "status"}),
        ("read", {}),
        ("snapshot", {}),
        ("screenshot", {}),
        ("scroll", {}),
        ("back", {}),
        ("open", {"url": BANK}),
        ("tabs", {"op": "switch", "id": 3}),
        ("wait", {}),
    ):
        assert not watch.acting(action, args), action


async def test_looking_never_asks_the_window(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, calls = desk_with(hub, seen(BANK, False))
    assert await desk.watch.check("read", {}) is None
    assert await desk.watch.check("act", {"kind": "scroll", "ref": "e3"}) is None
    assert calls == []


async def test_a_sensitive_site_is_acted_on_only_while_it_s_seen(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, calls = desk_with(hub, seen(BANK, False))
    refused = await desk.watch.check("click", {"text": "Pay bills", "tab": 4, "owner": "jarvis"})
    assert refused["ok"] is False and "chase.com is sensitive (a bank" in refused["message"]
    assert "browser_tabs" in refused["message"]
    assert calls == [("tabs", {"op": "list"})]  # the browser's own word on the tab, right then
    desk, _ = desk_with(hub, seen(BANK, True))
    assert await desk.watch.check("click", {"text": "Pay bills", "tab": 4}) is None
    # On show, but the window is hidden, minimized or covered: no one is watching.
    desk, _ = desk_with(hub, seen(BANK, True), window_seen=False)
    assert (await desk.watch.check("click", {"text": "Pay bills"}))["ok"] is False
    # An ordinary site: acted on in a tab behind as before.
    desk, _ = desk_with(hub, seen(NEWS, False))
    assert await desk.watch.check("type", {"text": "soup"}) is None


async def test_the_tab_the_action_lands_in_is_the_one_weighed(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    tabs = [
        {"id": 4, "url": BANK, "shown": False},
        {"id": 5, "url": NEWS, "shown": True},
    ]
    desk, _ = desk_with(hub, tabs)
    assert (await desk.watch.check("click", {"text": "Go", "tab": 4}))["ok"] is False
    assert await desk.watch.check("click", {"text": "Go"}) is None  # the tab on show: news
    # The dock closed: the tab last on show, as the window said.
    tabs = [{**t, "shown": False} for t in tabs]
    desk, _ = desk_with(hub, tabs, on_show=4)
    assert (await desk.watch.check("click", {"text": "Go"}))["ok"] is False
    desk, _ = desk_with(hub, tabs, on_show=5)
    assert await desk.watch.check("click", {"text": "Go"}) is None
    # Which one can't be told, and one of them is watched: left alone.
    desk, _ = desk_with(hub, tabs, on_show=None)
    assert await desk.watch.check("click", {"text": "Go"}) == {
        "ok": False,
        "message": watch.UNCHECKED,
    }
    desk, _ = desk_with(hub, [{**tabs[1], "id": 6}, tabs[1]], on_show=None)
    assert await desk.watch.check("click", {"text": "Go"}) is None  # neither is watched


async def test_the_owner_s_own_sensitive_sites_count_and_taken_off_ones_don_t(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_feature_prefs(
        {ADDED_KEY: [{"host": "mycreditunion.org", "kind": "bank"}], REMOVED_KEY: ["chase.com"]}
    )
    desk, _ = desk_with(hub, seen("https://www.mycreditunion.org/login", False))
    assert (await desk.watch.check("click", {"text": "Go"}))["ok"] is False
    desk, _ = desk_with(hub, seen(BANK, False))
    assert await desk.watch.check("click", {"text": "Go"}) is None


async def test_always_lifts_watch_mode_and_never_stops_every_action(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_feature_prefs({RULES_KEY: {"chase.com": "always", "news.example": "never"}})
    desk, _ = desk_with(hub, seen(BANK, False))
    assert await desk.watch.check("click", {"text": "Pay bills"}) is None
    desk, _ = desk_with(hub, seen(NEWS, True))
    refused = await desk.watch.check("act", {"kind": "click", "ref": "e2"})
    assert refused["ok"] is False and "never to act on news.example" in refused["message"]
    assert await desk.watch.check("read", {}) is None  # reading is still fine


async def test_ask_puts_up_a_card_once_per_request(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_feature_prefs({RULES_KEY: {"news.example": "ask"}})
    desk, _ = desk_with(hub, seen(NEWS, True))
    asked = asker(hub, True)
    hub._rid = "r1"
    assert await desk.watch.check("click", {"text": "Subscribe"}) is None
    assert await desk.watch.check("type", {"text": "soup"}) is None
    assert len(asked) == 1
    question, detail, spoken = asked[0]
    assert question == "Let Jarvis act on news.example?" and "Press “Subscribe”" in detail
    assert "Settings › Browser" in detail and spoken.startswith("Can I act on news.example?")
    hub._rid = "r2"  # the next request asks again
    asked = asker(hub, False)
    refused = await desk.watch.check("click", {"text": "Subscribe"})
    assert refused["ok"] is False and "said no" in refused["message"] and len(asked) == 1


async def test_a_session_s_yes_to_ask_holds_a_while(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_feature_prefs({RULES_KEY: {"news.example": "ask"}})
    desk, _ = desk_with(hub, seen(NEWS, True))
    asked = asker(hub, True)
    assert await desk.watch.check("click", {"text": "Go", "owner": "code:3"}) is None
    assert await desk.watch.check("click", {"text": "Go", "owner": "code:3"}) is None
    assert await desk.watch.check("click", {"text": "Go", "owner": "code:4"}) is None
    assert len(asked) == 2  # once for each session
    desk.watch._session_yes["code:3"]["news.example"] = 0.0  # its yes ran out
    assert await desk.watch.check("click", {"text": "Go", "owner": "code:3"}) is None
    assert len(asked) == 3


async def test_a_site_it_can_t_name_is_left_alone(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _ = desk_with(hub, {"error": "The browser didn't answer in time."})
    refused = await desk.watch.check("click", {"text": "Go"})
    assert refused == {"ok": False, "message": watch.UNCHECKED}
    # No such tab, or no browser at all: the call itself says so.
    desk, _ = desk_with(hub, seen(NEWS, True))
    assert await desk.watch.check("click", {"text": "Go", "tab": 9}) is None
    desk, _ = desk_with(hub, seen("", True))
    assert await desk.watch.check("click", {"text": "Go"}) is None  # a blank tab
    hub.browser_available = False
    assert await desk.watch.check("click", {"text": "Go"}) is None


async def test_a_refusal_comes_before_the_purchase_guard(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk_with(hub, seen(BANK, False))
    guarded = []

    async def guard(action, args=None):
        guarded.append(action)
        return {"ok": True}

    hub._guarded_browser = guard
    result = await hub.browser_call("click", {"text": "Transfer"})
    assert result["ok"] is False and "sensitive" in result["message"] and guarded == []
    assert (await hub.browser_call("read", {}))["ok"] is True and guarded == ["read"]


async def test_what_jarvis_reads_on_a_sensitive_site_is_private(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _ = desk_with(hub, seen(BANK, True))
    hub._rid = "r1"
    await desk.watch.on_result("read", {"owner": "jarvis"}, {"ok": True, "url": NEWS})
    assert not hub._gate_reads()["private"]
    await desk.watch.on_result("read", {}, {"ok": True, "url": BANK, "text": "Balance"})
    reads = hub._gate_reads()
    assert reads["private"] and "a page on secure.chase.com" in reads["what"]
    # An Eden Code session's reads are its own; nothing is marked between requests.
    hub._rid = "r2"
    await desk.watch.on_result("read", {"owner": "code:2"}, {"ok": True, "url": BANK})
    assert not hub._reads()["private"]


# ── Settings › Browser ──


def sites_event(q):
    events = []
    while not q.empty():
        ev = q.get_nowait()
        if ev["type"] == "browser_ai_sites":
            events.append(ev)
    return events[-1]


async def test_the_window_lists_and_changes_the_sites(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    q = hub.subscribe()
    await hub._handle({"type": "browser_ai_sites"})
    ev = sites_event(q)
    hosts = {x["host"]: x for x in ev["sites"]}
    assert hosts["chase.com"]["kind"] == "bank" and hosts["chase.com"]["default"]
    assert hosts["mail.google.com"]["kind"] == "email" and ev["removed"] == [] and ev["rules"] == {}
    change = {"type": "browser_ai_site"}
    await hub._handle(
        {**change, "op": "add", "host": "https://www.MyCreditUnion.org/login", "kind": "bank"}
    )
    await hub._handle({**change, "op": "remove", "host": "chase.com"})
    await hub._handle({**change, "op": "rule", "host": "news.example", "rule": "never"})
    await hub._handle({**change, "op": "rule", "host": "shop.example", "rule": "ask"})
    ev = sites_event(q)
    hosts = {x["host"]: x for x in ev["sites"]}
    assert hosts["mycreditunion.org"] == {
        "host": "mycreditunion.org",
        "kind": "bank",
        "default": False,
    }
    assert "chase.com" not in hosts and ev["removed"] == ["chase.com"]
    assert ev["rules"] == {"news.example": "never", "shop.example": "ask"}
    await hub._handle({**change, "op": "add", "host": "chase.com"})  # put back
    await hub._handle({**change, "op": "rule", "host": "shop.example", "rule": ""})
    await hub._handle({**change, "op": "remove", "host": "mycreditunion.org"})
    ev = sites_event(q)
    hosts = {x["host"] for x in ev["sites"]}
    assert "chase.com" in hosts and "mycreditunion.org" not in hosts and ev["removed"] == []
    assert ev["rules"] == {"news.example": "never"}
    await hub._handle({**change, "op": "add", "host": "not a site"})
    ev = sites_event(q)
    assert ev["error"] == "That isn't a site's address."


def test_hand_edited_site_settings_are_read_defensively(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_feature_prefs(
        {
            ADDED_KEY: [{"host": "Example.ORG", "kind": "spaceship"}, "junk", {"host": "a b"}],
            REMOVED_KEY: ["chase.com", 7, None, "chase.com"],
            RULES_KEY: {"news.example": "sometimes", "shop.example": "never", "": "ask"},
        }
    )
    features = hub.prefs.features
    assert features[ADDED_KEY] == [{"host": "example.org", "kind": "other"}]
    assert features[REMOVED_KEY] == ["chase.com"]
    assert features[RULES_KEY] == {"shop.example": "never"}
    hub.set_feature_prefs({RULES_KEY: "all of them"})  # not a rule list: the old one stays
    assert hub.prefs.features[RULES_KEY] == {"shop.example": "never"}
