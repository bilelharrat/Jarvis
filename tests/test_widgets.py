"""Widgets (jarvis.widgets, jarvis.features.widgets): kept and pinned, served on their own
address with a policy that lets nothing in or out and only into the window's own iframe, and
the brain's and the window's ways to show, pin and remove them."""

import asyncio
import json

import pytest
from conftest import FakeClient
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from jarvis import lang, widgets
from jarvis.features import widgets as widgets_feature
from jarvis.hub import Hub
from jarvis.server import create_app
from jarvis.widgets import WidgetStore, build_route, csp

BASE = "http://127.0.0.1:8123"
IFRAME = {"sec-fetch-dest": "iframe"}


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def client_for(store):
    app = Starlette(routes=[Route(f"{widgets.ROUTE}/{{wid}}", build_route(store))])
    return TestClient(app, base_url=BASE)


# ── the store ──


def test_widgets_are_kept_with_ids_nobody_could_guess(tmp_path):
    store = WidgetStore(tmp_path / "widgets.json")
    one = store.add("Week", "<svg></svg>", height=9999)
    two = store.add("", "<p>x</p>", scripts=True)
    assert len(one.id) >= 24 and one.id != two.id
    assert one.height == widgets.MAX_HEIGHT and two.title == "Widget" and two.scripts
    for html, why in (("  ", "nothing in it"), ("x" * (widgets.MAX_HTML + 1), "too big")):
        with pytest.raises(ValueError, match=why):
            store.add("t", html)
    store.pin(one.id)
    again = WidgetStore(tmp_path / "widgets.json")  # kept across a restart
    assert [w["id"] for w in again.public()] == [one.id] and again.get(one.id).html == "<svg></svg>"
    assert again.get(two.id) is None  # only pinned ones are kept
    again.remove(one.id)
    assert WidgetStore(tmp_path / "widgets.json").public() == []
    with pytest.raises(ValueError, match="isn't on the dashboard"):
        again.remove(one.id)


def test_the_dashboard_holds_so_many_and_a_damaged_file_pins_nothing(tmp_path):
    store = WidgetStore(tmp_path / "widgets.json")
    for n in range(widgets.MAX_PINNED):
        store.pin(store.add(f"w{n}", "<p>x</p>").id)
    with pytest.raises(ValueError, match="holds 12 widgets"):
        store.pin(store.add("one more", "<p>x</p>").id)
    (tmp_path / "bad.json").write_text("{nope")
    assert WidgetStore(tmp_path / "bad.json").public() == []
    (tmp_path / "odd.json").write_text(
        json.dumps({"pinned": [{"id": "short", "html": "x"}, {"id": "a" * 24, "html": ""}]})
    )
    assert WidgetStore(tmp_path / "odd.json").public() == []


# ── its own address ──


def test_a_widget_is_served_sealed_off(tmp_path):
    store = WidgetStore(tmp_path / "widgets.json")
    plain = store.add("Week", "<svg><rect width='10' height='10'/></svg>")
    scripted = store.add("Clock", "<p id=t></p><script>t.textContent = 1</script>", scripts=True)
    client = client_for(store)
    page = client.get(f"{widgets.ROUTE}/{plain.id}", headers=IFRAME)
    assert (
        page.status_code == 200
        and "<svg><rect" in page.text
        and page.text.startswith("<!doctype html>")
    )
    policy = page.headers["content-security-policy"]
    assert policy.startswith("default-src 'none'") and "script-src" not in policy
    assert (
        policy.endswith("sandbox")
        and "frame-ancestors 'self'" in policy
        and "connect-src" not in policy
    )
    assert (
        page.headers["referrer-policy"] == "no-referrer"
        and page.headers["x-content-type-options"] == "nosniff"
    )
    assert page.headers["cache-control"] == "no-store"
    with_scripts = client.get(f"{widgets.ROUTE}/{scripted.id}", headers=IFRAME).headers[
        "content-security-policy"
    ]
    assert "script-src 'unsafe-inline'" in with_scripts and with_scripts.endswith(
        "sandbox allow-scripts"
    )
    assert csp(False) == csp(False) and "img-src data:" in csp(True)


def test_only_the_windows_iframe_gets_a_widget(tmp_path):
    store = WidgetStore(tmp_path / "widgets.json")
    widget = store.add("Week", "<p>x</p>")
    client = client_for(store)
    assert (
        client.get(
            f"{widgets.ROUTE}/{widget.id}", headers={"sec-fetch-dest": "document"}
        ).status_code
        == 403
    )
    far = TestClient(
        Starlette(routes=[Route(f"{widgets.ROUTE}/{{wid}}", build_route(store))]),
        base_url="http://evil.test:8123",
    )
    assert (
        far.get(f"{widgets.ROUTE}/{widget.id}", headers=IFRAME).status_code == 403
    )  # a name pointed at this Mac
    assert client.get(f"{widgets.ROUTE}/{'x' * 24}", headers=IFRAME).status_code == 404
    assert client.get(f"{widgets.ROUTE}/..%2F..%2Fprefs.json", headers=IFRAME).status_code == 404


def test_the_window_server_serves_the_features_addresses(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    widget = hub.widgets.store.add("Week", "<p>the week</p>")
    client = TestClient(
        create_app(hub, "the-token"), base_url=BASE
    )  # no lifespan: the hub isn't started
    page = client.get(f"{widgets.ROUTE}/{widget.id}", headers=IFRAME)
    assert page.status_code == 200 and "the week" in page.text
    assert "default-src 'none'" in page.headers["content-security-policy"]


# ── the brain's tools ──


async def call(hub, name, args):
    tools = {t.name: t for t in hub.widgets.build_tools()}
    return await tools[name].handler(args)


async def test_show_pin_list_and_remove(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    shown = await call(
        hub, "show_widget", {"title": "The week", "html": "<svg></svg>", "height": 300}
    )
    assert shown["content"][0]["text"].startswith("It's on screen (widget ")
    kind, widget = events[-1]
    assert (
        kind == "widget"
        and widget["title"] == "The week"
        and widget["url"].startswith("/f/widgets/")
    )
    assert widget["scripts"] is False and widget["height"] == 300 and widget["pinned"] is False
    assert widget["rid"] == hub._rid  # the card goes with the request that made it
    pinned = await call(hub, "pin_widget", {"id": widget["id"]})
    assert pinned["content"][0]["text"] == "Pinned The week to the dashboard."
    fields = {k: v for k, v in widget.items() if k != "rid"}
    assert events[-1] == ("widgets", {"pinned": [dict(fields, pinned=True)], "error": ""})
    listed = await call(hub, "list_widgets", {})
    assert listed["content"][0]["text"] == f"The week ({widget['id']})"
    hub._turn_text = "remove the week widget"
    removed = await call(hub, "remove_widget", {"which": "week"})
    assert (
        removed["content"][0]["text"] == "Took The week off the dashboard."
        and hub.widgets.store.public() == []
    )
    both = await call(
        hub, "show_widget", {"title": "Clock", "html": "<p>1</p>", "scripts": True, "pin": True}
    )
    assert "pinned to the dashboard" in both["content"][0]["text"] and events[-1][0] == "widgets"
    assert (await call(hub, "show_widget", {"title": "Empty", "html": ""})).get("is_error")


async def test_removing_one_the_owner_didnt_ask_about_asks(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    store = hub.widgets.store
    for title in ("Stocks", "Stocks today"):
        store.pin(store.add(title, "<p>x</p>").id)
    hub._turn_text = "what's up?"
    ambiguous = await call(hub, "remove_widget", {"which": "stocks"})
    assert ambiguous.get("is_error") and "More than one fits" in ambiguous["content"][0]["text"]

    async def answer(choice):
        for _ in range(200):
            await asyncio.sleep(0)
            if hub.approvals:
                card = next(iter(hub.approvals.values()))
                assert card["question"] == "Take Stocks today off the dashboard?"
                hub.resolve(card["id"], choice)
                return

    kept, _ = await asyncio.gather(
        call(hub, "remove_widget", {"which": "stocks today"}), answer("deny")
    )
    assert kept.get("is_error") and len(store.public()) == 2
    hub.prefs.language = "zh"
    hub._turn_text = "把股票小组件删掉"
    gone = await call(hub, "remove_widget", {"which": "stocks today"})
    assert not gone.get("is_error") and len(store.public()) == 1


async def test_the_windows_own_clicks_pin_and_remove(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    widget = hub.widgets.store.add("Week", "<p>x</p>")
    await hub._handle({"type": "widget_pin", "id": widget.id})
    assert events[-1][1]["pinned"][0]["id"] == widget.id
    await hub._handle({"type": "widget_remove", "id": widget.id})
    assert events[-1][1]["pinned"] == []
    await hub._handle({"type": "widget_remove", "id": widget.id})
    assert events[-1][1]["error"] == "That widget isn't on the dashboard."
    await hub._handle({"type": "widgets_state"})
    assert events[-1] == ("widgets", {"pinned": [], "error": ""})


def test_their_words_and_results(settings, quiet_speaker, isolated):
    from jarvis import brain

    make_hub(settings, quiet_speaker, isolated)
    for tool in ("show_widget", "pin_widget", "list_widgets", "remove_widget"):
        assert brain.result_kind(f"mcp__widgets__{tool}") == "none"
    for english, chinese in widgets_feature.ZH.items():
        assert lang.translate(english, "zh") == chinese or "{" in english


@pytest.mark.parametrize(
    ("said", "language", "asked"),
    [
        ("remove the week widget", "en", True),
        ("please take the clock widget off the dashboard", "en", True),
        ("get rid of my stocks widget", "en", True),
        ("delete all the widgets", "en", True),
        ("what does the widget show", "en", False),
        ("show a widget of my week", "en", False),
        ("把股票小组件删掉", "zh", True),
        ("删掉股票小组件", "zh", True),
        ("把时钟小组件从仪表板上拿掉", "zh", True),
        ("小组件删掉了吗", "zh", False),
        ("显示一个小组件", "zh", False),
    ],
)
def test_the_words_that_ask_to_remove_one(said, language, asked):
    assert widgets_feature.ASKED.said(said, language) is asked


def test_the_words_are_read_in_linear_time():
    import time

    from jarvis.features import background, pictures

    hostile = [
        "remove" + " " * 4000 + "widget",
        "draw " * 2000,
        "take the " + "a " * 3000 + "widget",
        "你能不能" * 40 + "把",
        "把" * 3000 + "小组件",
        "在" * 3000,
    ]
    started = time.process_time()  # this process's own time: a busy Mac doesn't count
    for asked in (widgets_feature.ASKED, pictures.ASKED, background.ASKED):
        for text in hostile:
            asked.said(text, "zh")
    assert time.process_time() - started < 0.5  # about 50 ms here
