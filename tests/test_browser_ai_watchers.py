"""Page watchers: "tell me when this page changes", "when the price drops below $40", "when
it's back in stock". Pages come from httpx's MockTransport or a fake browser: nothing
leaves the machine."""

import asyncio
import json
import time

import httpx
import pytest
from test_hub import make_hub

from jarvis.features import browser_ai
from jarvis.features.browser_ai import watchers
from jarvis.features.browser_ai.watchers import (
    changed,
    fingerprint,
    lines_of,
    pick_price,
    public_url,
    read_html,
    structured,
    text_stock,
)

SHOP = "https://shop.example/kettle"


def drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def product(price="45.00", stock="https://schema.org/InStock", words="", title="Blue kettle"):
    ld = {"@context": "https://schema.org", "@graph": [{"@type": "Product", "name": title,
          "offers": {"@type": "Offer", "price": price, "priceCurrency": "USD", "availability": stock}}]}  # fmt: skip
    body = "".join(
        f"<p>The {title} boils a litre in three minutes, line {n}.</p>" for n in range(8)
    )
    return (
        f"<html><head><title>{title} | Shop</title><script type='application/ld+json'>{json.dumps(ld)}"
        f"</script><style>p {{ color: red }}</style></head><body><h1>{title}</h1>{body}<p>{words}</p>"
        "<script>var hidden = 'never read';</script></body></html>"
    )


def serve(pages):
    """A MockTransport answering from pages (url -> html, or a status number)."""
    asked = []

    def answer(request):
        asked.append(str(request.url))
        page = pages.get(str(request.url), 404)
        if isinstance(page, int):
            return httpx.Response(page)
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=page)

    return httpx.MockTransport(answer), asked


# ── reading pages ──


def test_a_page_s_html_is_read_as_text_title_and_product_data():
    page = read_html(product())
    assert page["title"] == "Blue kettle | Shop"
    assert "boils a litre" in page["text"] and "never read" not in page["text"]
    assert "color: red" not in page["text"]
    assert structured(page) == {"price": (45.0, "USD"), "stock": True}
    meta = read_html(
        '<meta property="product:price:amount" content="1,299.00"><meta property="product:price:currency" '
        'content="eur"><link itemprop="availability" href="https://schema.org/OutOfStock"><p>x</p>'
    )
    assert structured(meta) == {"price": (1299.0, "EUR"), "stock": False}
    assert structured(read_html("<p>Nothing to see</p>")) == {"price": None, "stock": None}


def test_in_stock_by_the_page_s_words():
    assert text_stock("Sorry, this item is sold out.") is False
    assert text_stock("Add to cart") is True
    assert text_stock("暂时缺货") is False and text_stock("加入购物车") is True
    assert text_stock("Sold out in blue. Add to cart in red.") is None  # both: it can't be told
    assert text_stock("A kettle") is None


def test_the_watched_price_is_found_again_and_never_a_far_one():
    text = "Related: Red kettle $120.00\nNow only $39.99 was $45.00\nShipping $5.00"
    assert pick_price(text, "Now only", None, "USD") == 39.99
    assert pick_price(text, "", 44.0, "USD") == 45.0  # the one nearest the price seen before
    assert pick_price("Related: Toaster $9.99", "", 45.0, "USD") is None  # too far to be it
    assert pick_price("Now only €39.99", "Now only", None, "USD") is None  # another currency


def test_a_change_is_lines_that_came_or_went_not_the_times():
    before = "\n".join(f"Paragraph {n} of the story about kettles and tea." for n in range(40))
    lines = lines_of(before + "\nUpdated 5 minutes ago\n12:30\nShort")
    assert len(lines) == 40  # the time lines and the short one aren't compared
    kept = [fingerprint(line) for line in lines]
    assert changed(kept, lines_of(before + "\nUpdated 2 minutes ago")) == (False, [])
    edited = changed(kept, lines_of(before.replace("Paragraph 3 of", "Chapter three of")))
    assert edited[0] and edited[1] == ["Chapter three of the story about kettles and tea."]
    big = "\n".join(f"Headline {n} about kettles, teapots and all that." for n in range(400))
    big_kept = [fingerprint(line) for line in lines_of(big)]
    assert not changed(big_kept, lines_of(big.replace("Headline 7 ", "Story 7 ")))[0]  # rotating
    after = (
        before
        + "\nThe kettle is now sold in green and in yellow as well.\nPrices fall by a fifth this week for all kettles."
    )
    moved, came = changed(kept, lines_of(after))
    assert moved and came[0].startswith("The kettle is now sold in green")


@pytest.mark.parametrize(
    "url",
    ["http://localhost:3000/", "http://127.0.0.1/", "http://10.0.0.4/x", "http://192.168.1.2/",
     "http://[::1]/", "http://printer/", "http://nas.local/", "file:///etc/hosts",
     "https://user:pw@shop.example/", "javascript:alert(1)", "http://169.254.169.254/latest"],
)  # fmt: skip
def test_only_pages_on_the_internet_are_watched(url):
    assert public_url(url) == ""


def test_a_public_page_keeps_its_query():
    assert public_url(SHOP + "?colour=blue#reviews") == SHOP + "?colour=blue"


# ── making one ──


def desk_with(hub, pages, words="tell me when the price drops below 40", on_show=True):
    desk = browser_ai.desk_for(hub)
    transport, asked = serve(pages)
    desk.watchers.transport = transport
    hub._turn_text = words
    hub._rid = "r1"
    if on_show:
        desk.page.on_page({"open": True, "url": SHOP, "title": "Blue kettle", "tab": 4})
    cards = []

    async def ask_user(question, detail="", spoken=""):
        cards.append(question)
        return False

    hub._ask_user = ask_user
    return desk, asked, cards


def body(result):
    return result["content"][0]["text"]


async def test_a_price_watch_is_made_from_the_page_s_own_data(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, asked, cards = desk_with(hub, {SHOP: product()})
    q = hub.subscribe()
    result = await desk.watchers.make({"kind": "below", "below": "$40"})
    assert not result.get("is_error") and "Watching Blue kettle | Shop" in body(result), body(
        result
    )
    assert cards == [] and asked == [SHOP]
    watch = desk.watchers.watches()[0]
    assert watch["via"] == "fetch" and watch["price"] == 45.0 and watch["below"] == 40.0
    assert watch["currency"] == "USD" and watch["kind"] == "below"
    saved = json.loads(desk.watchers.path.read_text())
    assert saved[0]["url"] == SHOP and "text" not in saved[0]  # the page's words aren't kept
    shown = [e for e in drain(q) if e["type"] == "browser_ai_watches"]
    assert shown and shown[-1]["items"][0]["kind"] == "below"


async def test_unasked_or_after_a_private_read_a_card_asks_first(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, cards = desk_with(hub, {SHOP: product()}, words="what's this kettle like?")
    result = await desk.watchers.make({"kind": "below", "below": 40})
    assert result["is_error"] and cards == ["Watch shop.example?"] and desk.watchers.watches() == []
    desk, _, cards = desk_with(hub, {SHOP: product()})
    hub.mark_turn_untrusted("your email")
    result = await desk.watchers.make({"kind": "below", "below": 40})
    assert result["is_error"] and cards == ["Watch shop.example?"]


async def test_what_isn_t_watched(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub, {SHOP: product(price="35.00")})
    result = await desk.watchers.make({"kind": "below", "below": 40})
    assert "already $35.00" in body(result) and desk.watchers.watches() == []
    result = await desk.watchers.make({"kind": "stock"})
    assert "in stock now" in body(result) and desk.watchers.watches() == []
    result = await desk.watchers.make({"kind": "change", "url": "https://secure.chase.com/x"})
    assert result["is_error"] and "sensitive" in body(result)
    result = await desk.watchers.make({"kind": "change", "url": "http://localhost:3000/"})
    assert result["is_error"]
    result = await desk.watchers.make({"kind": "below", "below": "cheap"})
    assert result["is_error"] and "amount" in body(result)


async def test_there_are_at_most_twenty(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    monkeypatch.setattr(watchers, "MAX_WATCHES", 1)
    desk, _, _ = desk_with(
        hub,
        {SHOP: product(stock="https://schema.org/OutOfStock")},
        words="tell me when it's back in stock",
    )
    assert not (await desk.watchers.make({"kind": "stock"})).get("is_error")
    result = await desk.watchers.make({"kind": "stock"})
    assert result["is_error"] and "already 1 page watches" in body(result)


async def test_a_page_that_builds_itself_is_watched_in_a_tab_behind(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub, {SHOP: 404}, words="tell me when this page changes")
    calls = []
    story = "\n".join(
        f"Paragraph {n} about the new kettle range, in some detail." for n in range(12)
    )

    async def raw(action, args=None):
        calls.append((action, dict(args or {})))
        if action == "open":
            return {"ok": True, "tab": 9, "url": SHOP}
        if action == "read":
            return {"ok": True, "url": SHOP, "title": "Blue kettle", "text": story}
        return {"ok": True}

    hub._browser_raw = raw
    hub.browser_available = True
    result = await desk.watchers.make({"kind": "change"})
    assert not result.get("is_error") and "opening it in a tab" in body(result), body(result)
    assert desk.watchers.watches()[0]["via"] == "tab"
    opened = [a for a in calls if a[0] == "open"][0][1]
    assert opened == {"url": SHOP, "newTab": True, "background": True, "owner": "watch"}
    assert ("tabs", {"op": "close", "id": 9, "background": True}) in calls  # never opens the dock


# ── checking ──


async def made(hub, pages, kind, **args):
    desk, _, _ = desk_with(hub, pages, words="tell me when it changes, or drops below 40")
    result = await desk.watchers.make({"kind": kind, **args})
    assert not result.get("is_error"), body(result)
    told = []
    hub.notify = lambda alert, **_: told.append(alert)
    return desk, desk.watchers.watches()[0], told


def serve_now(desk, pages):
    desk.watchers.transport, _ = serve(pages)


async def test_a_price_drop_is_told_once(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, told = await made(hub, {SHOP: product()}, "below", below=40)
    await desk.watchers.check(watch)
    assert told == [] and watch["price"] == 45.0
    serve_now(desk, {SHOP: product(price="38.50")})
    await desk.watchers.check(watch)
    assert len(told) == 1 and told[0].kind == "watch" and told[0].title == "Page watch"
    assert told[0].text == "Blue kettle | Shop is now $38.50, below your $40.00."
    assert (
        "shop.example" in told[0].note and "kettle" not in told[0].note
    )  # no page words for Claude
    assert watch["done"] and desk.watchers.due(time.time() + 10**6) == []


async def test_back_in_stock_is_told_once(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    out = product(stock="https://schema.org/OutOfStock")
    desk, watch, told = await made(hub, {SHOP: out}, "stock")
    await desk.watchers.check(watch)
    assert told == []
    serve_now(desk, {SHOP: product()})
    await desk.watchers.check(watch)
    assert [a.text for a in told] == ["Blue kettle | Shop is back in stock."] and watch["done"]


async def test_a_change_is_told_at_most_every_six_hours(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, told = await made(hub, {SHOP: product()}, "change")
    await desk.watchers.check(watch)
    assert told == []  # the same page
    news = "The kettle now comes in green and in yellow as well, from today on."
    serve_now(
        desk, {SHOP: product(words=news).replace("line 1.", "line one, and more to say about it.")}
    )
    await desk.watchers.check(watch)
    assert len(told) == 1 and told[0].text.startswith("Blue kettle | Shop changed:")
    serve_now(
        desk,
        {
            SHOP: product(words="Now in red and in purple too, from next week on for all.").replace(
                "line 2.", "line two, with news."
            )
        },
    )
    await desk.watchers.check(watch)
    assert len(told) == 1  # told just now: it waits
    watch["told"] -= watchers.CHANGE_QUIET + 1
    await desk.watchers.check(watch)
    assert len(told) == 2


async def test_a_page_that_can_t_be_read_is_paused_and_told(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, told = await made(hub, {SHOP: product()}, "change")
    serve_now(desk, {SHOP: 503})
    for _ in range(watchers.PAUSE_AFTER):
        await desk.watchers.check(watch)
    assert watch["paused"] and [a.text for a in told] == [
        "I stopped watching shop.example: its page couldn't be read 6 times in a row."
    ]


async def test_rounds_of_checks_are_capped_and_timed(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, _ = await made(hub, {SHOP: product()}, "change")
    now = time.time()
    assert desk.watchers.due(now) == []  # just looked
    for n in range(5):
        desk.watchers.watches().append({**watch, "id": f"w{n}", "last": now - 7200})
    assert len(desk.watchers.due(now)) == watchers.PER_TICK
    desk.watchers.watches()[0].update(done=True, last=now - watchers.DONE_KEPT - 1)
    looked = []

    async def check(w):
        looked.append(w["id"])
        w["last"] = time.time()

    desk.watchers.check = check
    await desk.watchers.tick()
    assert len(looked) == watchers.PER_TICK and watch["id"] not in [
        w["id"] for w in desk.watchers.watches()
    ]


def test_a_hand_edited_watch_file_is_read_defensively(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    desk.watchers.path.write_text(
        json.dumps([
            {"kind": "change", "url": SHOP, "every": 999, "lines": ["abc", 7]},
            {"kind": "below", "url": SHOP},  # no amount
            {"kind": "teleport", "url": SHOP},
            {"kind": "change", "url": "http://192.168.1.1/"},
            {"kind": "stock", "url": SHOP, "last": "yesterday"},
            "junk",
        ])
    )  # fmt: skip
    kept = desk.watchers.watches()
    assert len(kept) == 1 and kept[0]["every"] == watchers.MAX_HOURS and kept[0]["lines"] == ["abc"]


async def test_stopping_a_watch(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, _ = await made(hub, {SHOP: product()}, "change")
    desk, _, cards = desk_with(hub, {}, words="what's the weather")
    result = await desk.watchers.stop(watch["id"])
    assert result["is_error"] and cards == ["Stop watching shop.example?"]
    hub._turn_text = "stop watching that kettle"
    assert "Stopped 1 watch" in body(await desk.watchers.stop(watch["id"]))
    assert desk.watchers.watches() == []
    assert (await desk.watchers.stop("nope"))["is_error"]


async def test_the_owner_removes_one_in_settings_without_a_card(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, watch, _ = await made(hub, {SHOP: product()}, "change")
    cards = []

    async def ask_user(*args):
        cards.append(args)
        return False

    hub._ask_user = ask_user
    hub._turn_text = ""
    await hub._handle({"type": "browser_ai_watch_stop", "id": watch["id"]})
    for _ in range(100):
        if not desk.watchers.watches():
            break
        await asyncio.sleep(0.01)
    assert desk.watchers.watches() == [] and cards == []


async def test_a_watch_s_heads_up_shows_with_heads_ups_off(settings, quiet_speaker, isolated):
    from jarvis.proactive import Alert

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_prefs({"proactive": False})
    q = hub.subscribe()
    hub.notify(
        Alert("watch:x", "watch", "Page watch", "Blue kettle is back in stock."), speak=False
    )
    hub.notify(Alert("rain:x", "rain", "Weather", "Rain soon."), speak=False)
    await asyncio.sleep(0.01)  # (what hears heads-ups runs on the loop)
    kinds = [e.get("alert_kind") for e in drain(q) if e["type"] == "alert"]
    assert kinds == ["watch"]


def test_the_tools_and_what_their_results_count_as(settings, quiet_speaker, isolated):
    from jarvis.brain import result_kind

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    assert "browser_ai" in hub._feature_servers()
    assert result_kind("mcp__browser_ai__watch_page") == "web"
    assert result_kind("mcp__browser_ai__list_watches") == "web"
    assert result_kind("mcp__browser_ai__stop_watch") == "none"
    assert result_kind("mcp__browser_ai__read_tabs") == "web"
    assert "browser_watches" in [name for name, _ in hub._loops]
