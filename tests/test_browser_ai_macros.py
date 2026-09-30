"""Record and replay: a task recorded in the built-in browser as steps (never a password, a
card or a code), named and edited, saved; done again by name through the same guards as
JARVIS's own browser tools (the turn gate, watch mode, the hand back, the purchase guard),
stopping safely when a page isn't as it was recorded."""

import asyncio
import json

from test_hub import make_hub

from jarvis import jsonstore, transactions
from jarvis.features import browser_ai
from jarvis.features.browser_ai import macros
from jarvis.features.browser_ai.macros import add_step, clean_step, describe, page_path

HOME = "https://shop.example/"
RESULTS = "https://shop.example/search?q=tomato+soup"
CHECKOUT = "https://shop.example/checkout"
SOUP = [
    {"kind": "open", "url": HOME},
    {"kind": "type", "url": HOME, "selector": "#q", "field": "Search", "text": "tomato soup",
     "submit": True},
    {"kind": "click", "url": RESULTS, "selector": "#add-1", "text": "Add to cart", "tag": "button"},
]  # fmt: skip
PAGES = {
    HOME: ("Shop", "Search the shop. Deals of the week."),
    RESULTS: ("Results", "Tomato soup, 4 cans. $6.00 Add to cart"),
    CHECKOUT: ("Checkout", "Order summary. Total $42.00. Continue shopping Place order"),
}


async def until(done, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if done():
            return True
        await asyncio.sleep(0.01)
    return done()


def body(result):
    return result["content"][0]["text"]


class Browser:
    """The window's browser, one tab (7) that JARVIS opens: pages as PAGES has them, typing
    with Enter going to the results, and every call kept."""

    def __init__(self, after_search=RESULTS):
        self.url = ""
        self.calls = []
        self.after_search = after_search
        self.confirm_first = set()  # labels the window says need the user's OK
        self.snapshot = '  [e4] combobox "Size" = "Small"\n+ [e5] button "Add to cart"'

    async def __call__(self, action, args=None):
        args = dict(args or {})
        self.calls.append((action, args))
        where = {"url": self.url, "title": PAGES.get(self.url, ("", ""))[0], "tab": 7}
        if action == "tabs":
            return {
                "ok": True,
                "tabs": [{"id": 7, "url": self.url, "shown": True, "owner": "jarvis"}],
            }
        if action == "open":
            self.url = args["url"]
            return {"ok": True, **where, "url": self.url, "title": PAGES[self.url][0]}
        if action == "read":
            if not self.url:
                return {"error": "The browser is empty. Open a page first."}
            title, text = PAGES.get(self.url, ("", ""))
            actions = [w for w in ("Add to cart", "Continue shopping", "Place order") if w in text]
            return {**where, "text": text, "actions": actions, "links": [], "fields": []}
        if action == "type" and args.get("submit"):
            self.url = self.after_search
            return {"ok": True, **where, "url": self.url}
        label = args.get("text") or {"e5": "Add to cart", "e9": "Add to cart"}.get(args.get("ref"))
        if action in ("click", "act") and label in self.confirm_first and not args.get("force"):
            return {
                "ok": False,
                "needsConfirm": True,
                "label": label,
                "message": "needs the OK",
                **where,
            }
        if action == "snapshot":
            return {"ok": True, **where, "text": self.snapshot}
        names = {ref: name for ref, _, name in macros.snapshot_items(self.snapshot)}
        if action == "describe":  # (the purchase guard's look at what a ref presses)
            return {
                "ok": True,
                "refs": {r: {"tag": "button", "ax": names.get(r, "")} for r in args["refs"]},
            }
        return {"ok": True, "message": "Done", **where}

    def acts(self):
        return [(a, args) for a, args in self.calls if a in ("open", "type", "click", "act")]


def desk_with(hub, browser=None, probe=None, needs=None, steps=SOUP, name="soup order"):
    """The desk with a recorded task, the browser answering, and the page's own answers
    (probe: what a step's selector finds now; needs: what the page needs the owner for)."""
    desk = browser_ai.desk_for(hub)
    browser = browser or Browser()
    looks = []

    async def call(action, args=None, timeout=None):
        args = dict(args or {})
        looks.append((action, args))
        if action == "probe":
            found = probe(args) if callable(probe) else probe
            found = found or {"selector": args["selector"], "count": 1, "nth": 0}
            return {"ok": True, "url": browser.url, **found}
        if action == "handback":
            return {
                "ok": True,
                "url": browser.url,
                "kind": "",
                **((needs or {}).get(browser.url) or {}),
            }
        return {"ok": True, "url": browser.url}

    desk.bridge.call = call
    hub._browser_raw = browser
    hub._guarded_browser = transactions.guard_browser(
        hub.transactions, browser
    )  # the purchase guard
    hub.browser_available = True
    hub._rid = "r1"
    hub._turn_text = f"run my {name}"
    desk.page.on_page({"open": True, "url": HOME, "tab": 7, "visible": True})
    desk.macros._macros = [{"name": name, "steps": [dict(s) for s in steps], "saved": 1.0}]
    return desk, browser, looks


# ── the steps ──


def test_where_a_step_happens():
    assert page_path("https://www.Shop.example/search?q=soup#top") == "shop.example/search"
    assert (
        page_path("https://shop.example") == page_path("https://shop.example/") == "shop.example/"
    )
    assert page_path("https://shop.example/cart/") == "shop.example/cart"
    for url in ("", "file:///etc/hosts", "javascript:alert(1)", "about:blank", "http://"):
        assert page_path(url) == "", url


def test_steps_are_bounded_and_a_secret_is_never_kept():
    typed = clean_step({"kind": "type", "url": HOME, "selector": "#pw", "field": "Password",
                        "text": "hunter2", "secret": True})  # fmt: skip
    assert typed == {"kind": "type", "url": HOME, "selector": "#pw", "field": "Password",
                     "secret": True, "text": ""}  # fmt: skip
    long = clean_step({"kind": "type", "url": HOME, "selector": "x" * 900, "text": "y" * 9000})
    assert len(long["selector"]) == 300 and len(long["text"]) == 2000
    assert clean_step({"kind": "press", "url": HOME, "key": "Delete"})["key"] == "Enter"
    for junk in (
        {"kind": "eval", "url": HOME},
        {"kind": "click", "url": "file:///x", "text": "Go"},
        {"kind": "click", "url": HOME},  # nothing to find it by
        "click",
        None,
    ):
        assert clean_step(junk) is None, junk


def test_steps_merge_as_a_person_types_and_an_address_typed_opens():
    steps = [{"kind": "open", "url": HOME}]
    for raw in (
        {"kind": "type", "url": HOME, "selector": "#q", "field": "Search", "text": "tom"},
        {"kind": "type", "url": HOME, "selector": "#q", "field": "Search", "text": "tomato soup"},
        {"kind": "press", "url": HOME, "selector": "#q"},
        {"kind": "type", "url": RESULTS, "selector": "#q", "text": "tomato soup"},  # its change
        {"kind": "type", "url": RESULTS, "selector": "#q", "text": "tomato soup"},  # (twice)
        {"kind": "click", "url": RESULTS, "selector": "#add-1", "text": "Add to cart"},
        # the owner typed an address: nothing before it could have gone there
        {"kind": "type", "url": RESULTS, "selector": "#note", "text": "hi"},
        {"kind": "click", "url": CHECKOUT, "selector": "#go", "text": "Go"},
    ):
        add_step(steps, clean_step(raw))
    kinds = [(s["kind"], s.get("text")) for s in steps]
    assert kinds == [
        ("open", None),
        ("type", "tomato soup"),
        ("click", "Add to cart"),
        ("type", "hi"),
        ("open", None),
        ("click", "Go"),
    ]
    assert steps[1]["submit"] is True and steps[4]["url"] == CHECKOUT
    # A secret box and Enter: it's never "typed then sent".
    steps = [{"kind": "open", "url": HOME}]
    add_step(steps, clean_step({"kind": "type", "url": HOME, "selector": "#pw", "secret": True}))
    add_step(steps, clean_step({"kind": "press", "url": HOME, "selector": "#pw"}))
    assert [s["kind"] for s in steps] == ["open", "type", "press"] and "submit" not in steps[1]


def test_steps_in_words():
    assert [describe(s) for s in (clean_step(x) for x in SOUP)] == [
        "open https://shop.example/",
        "type “tomato soup” into “Search”, then Enter",
        "press “Add to cart”",
    ]
    assert describe({"kind": "type", "url": HOME, "field": "Password", "secret": True}) == (
        "the user types into “Password” themselves"
    )


# ── replay ──


async def test_a_task_is_done_again_step_by_step(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, browser, looks = desk_with(hub)
    result = await desk.macros.run("my soup order")
    assert not result.get("is_error") and "“soup order”: done (steps 1 to 3)" in body(result)
    assert browser.acts() == [
        ("open", {"url": HOME, "owner": "jarvis", "newTab": True}),
        ("type", {"text": "tomato soup", "field": "Search", "submit": True, "selector": "#q", "tab": 7}),
        ("act", {"kind": "click", "ref": "e5", "tab": 7}),  # the one a snapshot gives its words
    ]  # fmt: skip
    # Each step was looked for in the tab it lands in first.
    probes = [args for action, args in looks if action == "probe"]
    assert [(p["kind"], p["tab"]) for p in probes] == [("type", 7), ("click", 7)]
    assert "Results" in body(result)  # where it ended, as the page's own words


async def test_it_stops_where_the_page_isn_t_the_one_recorded(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, browser, _ = desk_with(hub, Browser(after_search="https://shop.example/sorry"))
    result = await desk.macros.run("soup order")
    text = body(result)
    assert result["is_error"] and "Stopped at “soup order”, step 3 of 3" in text
    assert "isn't the one recorded (it's https://shop.example/sorry" in text
    assert "don't try the step another way" in text and "Done before it: 1. open" in text
    assert [a for a, _ in browser.acts()] == ["open", "type"]  # nothing pressed


async def test_it_never_guesses_between_two(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)

    def probe(args):
        if args["kind"] == "click":
            return {"selector": "", "count": 2, "nth": -1}  # it's gone; two others say it
        return {"selector": args["selector"], "count": 1, "nth": 0}

    desk, browser, _ = desk_with(hub, probe=probe)
    result = await desk.macros.run("soup order")
    assert "there's more than one “Add to cart” on the page now" in body(result)
    assert [a for a, _ in browser.acts()] == ["open", "type"]
    desk, browser, _ = desk_with(hub, probe=lambda args: {"selector": "", "count": 0, "nth": -1})
    result = await desk.macros.run("soup order")
    assert "step 2 of 3" in body(result) and "“Search” isn't on the page any more" in body(result)
    assert [a for a, _ in browser.acts()] == ["open"]


async def test_the_box_the_page_finds_now_is_the_one_typed_into(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, browser, _ = desk_with(hub, probe={"selector": 'input[name="q"]', "count": 1, "nth": 0})
    await desk.macros.run("soup order")
    assert browser.acts()[1][1]["selector"] == 'input[name="q"]'


async def test_the_same_words_twice_press_the_one_recorded(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)

    def probe(args):
        if args["kind"] == "click":
            return {"selector": "#add-1", "count": 2, "nth": 1}  # the second "Add to cart"
        return {"selector": args["selector"], "count": 1, "nth": 0}

    browser = Browser()
    browser.snapshot = (
        '  [e5] button "Add to cart"\n  [e7] link "Soup"\n  [e9] button "Add to cart"'
    )
    desk, browser, _ = desk_with(hub, browser, probe=probe)
    result = await desk.macros.run("soup order")
    assert "done" in body(result), body(result)
    assert browser.acts()[-1] == ("act", {"kind": "click", "ref": "e9", "tab": 7})
    # The snapshot doesn't list as many as the page counted: no guessing.
    browser = Browser()
    browser.snapshot = '  [e5] button "Add to cart"'
    desk, browser, _ = desk_with(hub, browser, probe=probe)
    result = await desk.macros.run("soup order")
    assert "more than one “Add to cart”" in body(result)
    assert [a for a, _ in browser.acts()] == ["open", "type"]


async def test_a_press_the_snapshot_doesn_t_name_goes_by_its_words(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    browser = Browser()
    browser.snapshot = '  [e5] button "Add to basket"'  # (the page's own name for it differs)
    desk, browser, _ = desk_with(hub, browser)
    result = await desk.macros.run("soup order")
    assert "done" in body(result)
    assert browser.acts()[-1] == ("click", {"text": "Add to cart", "tab": 7})  # as browser_click


async def test_a_password_is_the_owner_s_to_type(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    steps = [*SOUP[:2], {"kind": "type", "url": RESULTS, "selector": "#pw", "field": "Password",
                         "secret": True}, SOUP[2]]  # fmt: skip
    desk, browser, _ = desk_with(hub, steps=steps)
    result = await desk.macros.run("soup order")
    text = body(result)
    assert "Stopped at “soup order”, step 3 of 4" in text and "it's the user's turn" in text
    assert "from_step 4 carries on after it." in text  # (never "does that step again")
    assert [a for a, _ in browser.acts()] == ["open", "type"]
    # A box that wants a password now, though it didn't when it was recorded: the same.
    desk, browser, _ = desk_with(
        hub, probe={"selector": "#q", "count": 1, "nth": 0, "secret": True}
    )
    result = await desk.macros.run("soup order")
    assert "the box “Search” wants a password, a card or a code now" in body(result)
    assert [a for a, _ in browser.acts()] == ["open"]


async def test_picking_up_from_a_step(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    browser = Browser()
    browser.url = RESULTS  # where the owner left it
    desk, browser, _ = desk_with(hub, browser)
    result = await desk.macros.run("soup order", 3)
    assert "done (steps 3 to 3)" in body(result)
    assert [a for a, _ in browser.acts()] == ["act"]


async def test_after_a_private_read_typing_asks_first(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    desk, browser, _ = desk_with(hub)
    hub.mark_turn_untrusted("your email")
    q = hub.subscribe()
    cards = []

    async def answer_cards():  # the owner, at the approval cards as they go up
        while True:
            ev = await q.get()
            if ev["type"] == "approval":
                cards.append(ev["question"])
                opening = ev["question"].startswith("Open ")  # the shop: yes; typing there: no
                hub.resolve(ev["id"], "allow" if opening else "deny")

    owner = asyncio.get_running_loop().create_task(answer_cards())
    try:
        result = await asyncio.wait_for(desk.macros.run("soup order"), 60)
    finally:
        owner.cancel()
    assert cards == [
        "Open shop.example in the built-in browser?",  # as browser_open asks
        "Type into shop.example in the built-in browser?",  # the typing gate, as browser_type
    ]
    assert "step 2 of 3" in body(result) and "the user said no" in body(result)
    assert [a for a, _ in browser.acts()] == ["open"]  # nothing typed


async def test_a_press_that_sends_or_pays_needs_the_owner_s_ok(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.set_prefs({"control_always": False})  # (on, the owner said never to ask)
    browser = Browser()
    browser.confirm_first = {"Add to cart"}
    desk, browser, _ = desk_with(hub, browser)
    asked = []

    async def confirm(question):
        asked.append(question)
        return False

    hub.confirm = confirm
    result = await desk.macros.run("soup order")
    assert asked == ["Click “Add to cart” in the browser?"]
    assert "the user said no to pressing “Add to cart”" in body(result)
    assert not any(args.get("force") for _, args in browser.acts())

    async def yes(question):
        return True

    hub.confirm = yes
    desk, browser, _ = desk_with(hub, browser)
    result = await desk.macros.run("soup order")
    assert "done" in body(result) and browser.acts()[-1][1].get("force") is True


async def test_the_purchase_guard_still_stands_in_front(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    steps = [{"kind": "open", "url": CHECKOUT},
             {"kind": "click", "url": CHECKOUT, "selector": "#buy", "text": "Place order"}]  # fmt: skip
    for listed in ("", '  [e8] button "Place order"'):  # pressed by its words, or by its ref
        browser = Browser()
        browser.snapshot = listed
        desk, browser, _ = desk_with(hub, browser, steps=steps, name="order")
        result = await desk.macros.run("order")
        assert result["is_error"] and "step 2 of 2" in body(result), body(result)
        assert "tries it again" in body(result)  # once confirm_transaction has the owner's OK
        assert [a for a, _ in browser.acts()] == ["open"]  # "Place order" never pressed


async def test_where_the_page_needs_the_owner_it_s_their_turn(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, browser, _ = desk_with(hub, needs={RESULTS: {"kind": "login", "what": "signing in"}})
    result = await desk.macros.run("soup order")
    text = body(result)
    # Typing landed on a page that wants a sign-in: it stops right after, the owner's turn.
    assert "step 2 of 3" in text and "went, and now it's the user's turn: signing in" in text
    assert "from_step 3 carries on" in text and desk.handback.live()["kind"] == "login"
    assert [a for a, _ in browser.acts()] == ["open", "type"]
    # Picked up before the owner carried on: the tab is still theirs.
    result = await desk.macros.run("soup order", 3)
    assert "it's the user's turn" in body(result) and "from_step 3 does that step again" in body(
        result
    )
    assert [a for a, _ in browser.acts()] == ["open", "type"]


async def test_tasks_it_doesn_t_know(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub)
    result = await desk.macros.run("pay rent")
    assert result["is_error"] and "no recorded task called “pay rent”" in body(result)
    assert "Recorded: “soup order”" in body(result)
    listed = body(desk.macros.listed())
    assert "- “soup order”: 3 steps on shop.example" in listed and "2. type “tomato soup”" in listed


# ── recording, from the window ──


def recording_events(q):
    out = []
    while not q.empty():
        ev = q.get_nowait()
        if ev["type"] in ("browser_ai_recording", "browser_ai_macros"):
            out.append(ev)
    return out


async def test_recording_a_task_from_the_window(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    calls = []

    async def call(action, args=None, timeout=None):
        calls.append((action, dict(args or {})))
        return {"ok": True, "url": HOME, "recording": bool((args or {}).get("on"))}

    desk.bridge.call = call
    desk.page.on_page({"open": True, "url": HOME, "tab": 4, "visible": True})
    q = hub.subscribe()
    await hub._handle({"type": "browser_ai_record", "action": "start"})
    assert await until(lambda: desk.macros.recording is not None)
    assert calls == [("record", {"tab": 4, "on": True})]
    for tab, step in (
        (
            4,
            {
                "kind": "type",
                "url": HOME,
                "selector": "#q",
                "field": "Search",
                "text": "tomato soup",
            },
        ),
        (4, {"kind": "press", "url": HOME, "selector": "#q"}),
        (
            5,
            {"kind": "click", "url": HOME, "selector": "#x", "text": "Another tab"},
        ),  # not this tab
        (4, {"kind": "click", "url": RESULTS, "selector": "#add-1", "text": "Add to cart"}),
        (4, {"kind": "open", "url": "https://evil.example/"}),  # a page never says "open"
    ):
        await hub._handle({"type": "browser_ai_record_step", "tab": tab, "step": step})
    assert [s["kind"] for s in desk.macros.recording["steps"]] == ["open", "type", "click"]
    await hub._handle({"type": "browser_ai_record", "action": "stop"})
    assert await until(lambda: desk.macros.recording and desk.macros.recording["state"] == "review")
    assert calls[-1] == ("record", {"on": False})
    shown = recording_events(q)
    assert shown[0]["state"] == "recording" and shown[0]["count"] == 1
    review = shown[-1]
    assert review["state"] == "review" and [s["kind"] for s in review["steps"]] == [
        "open",
        "type",
        "click",
    ]
    # The owner names it, changes what's typed and saves.
    steps = [dict(s) for s in review["steps"]]
    steps[1]["text"] = "chicken soup"
    await hub._handle({"type": "browser_ai_macro_save", "name": "  soup   order ", "steps": steps})
    assert await until(lambda: desk.macros.recording is None)
    saved = json.loads(desk.macros.path.read_text())
    assert saved[0]["name"] == "soup order" and saved[0]["steps"][1]["text"] == "chicken soup"
    assert saved[0]["steps"][1]["submit"] is True
    shown = recording_events(q)
    assert shown[-1] == {"type": "browser_ai_macros",
                         "items": [{"name": "soup order", "steps": 3, "site": "shop.example"}]}  # fmt: skip
    # Settings' Remove.
    await hub._handle({"type": "browser_ai_macro_delete", "name": "Soup Order"})
    assert await until(lambda: json.loads(desk.macros.path.read_text()) == [])


async def test_what_can_t_be_recorded_or_saved(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)

    async def call(action, args=None, timeout=None):
        return {"ok": True, "url": HOME}

    desk.bridge.call = call
    q = hub.subscribe()
    await desk.macros.on_record({"action": "start"})  # no page on show
    assert recording_events(q)[-1] == {"type": "browser_ai_recording", "state": "idle",
                                       "error": "There's no web page to record."}  # fmt: skip
    desk.page.on_page({"open": True, "url": HOME, "tab": 4, "visible": True})
    await desk.macros.on_record({"action": "start"})
    await desk.macros.on_record({"action": "stop"})  # nothing done yet: nothing to keep
    assert desk.macros.recording is None and recording_events(q)[-1]["state"] == "idle"
    await desk.macros.on_record({"action": "start"})
    desk.macros.on_step({"tab": 4, "step": SOUP[1]})
    await desk.macros.on_record({"action": "stop"})
    await desk.macros.on_save({"name": "", "steps": SOUP})
    assert recording_events(q)[-1]["error"] == "Give it a name and keep at least one step."
    await desk.macros.on_save({"name": "soup", "steps": SOUP[:1]})
    assert desk.macros.recording["state"] == "review"  # still there to fix
    await desk.macros.on_record({"action": "cancel"})
    assert desk.macros.recording is None and not desk.macros.path.exists()


async def test_settings_run_asks_in_the_owner_s_words(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, _ = desk_with(hub)
    asked = []

    async def ask(text, *args, **kwargs):
        asked.append(text)
        return ""

    hub.ask = ask
    desk.macros.on_run({"name": "soup order"})
    hub.set_prefs({"language": "zh"})
    desk.macros.on_run({"name": "soup order"})
    desk.macros.on_run({"name": "nothing like it"})
    assert await until(lambda: len(asked) == 2)
    assert asked == ["Run my recorded task “soup order”.", "运行我录制的任务“soup order”。"]


# ── the file ──


async def test_a_hand_edited_file_is_read_with_care(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    path = desk.macros.path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([
        {"name": "soup order", "steps": SOUP, "saved": "x"},
        {"name": "no start page", "steps": SOUP[1:]},
        {"name": "", "steps": SOUP},
        {"name": "junk steps", "steps": [{"kind": "eval"}]},
        "junk",
    ]))  # fmt: skip
    kept = desk.macros.macros()
    assert [m["name"] for m in kept] == ["soup order"] and kept[0]["saved"] == 0.0


async def test_a_file_that_can_t_be_read_is_never_saved_over(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    path = desk.macros.path
    path.mkdir(parents=True)  # a folder in its place: it can't be read
    assert desk.macros.macros() == [] and desk.macros.unreadable
    desk.macros._macros = [{"name": "soup order", "steps": SOUP, "saved": 1.0}]
    assert await desk.macros.save() is False and path.is_dir()
    assert isinstance(jsonstore.Unreadable(5, "x"), OSError)


def test_the_tools_and_what_claude_is_told(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    names = [t.name for t in desk.macros.tools()]
    assert names == ["run_macro", "list_macros"]
    assert "run_macro" in macros.PROMPT and set(macros.LABELS) == set(names)
