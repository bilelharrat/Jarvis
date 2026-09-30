"""Quotes for any ticker, the watchlist by voice and price alerts (jarvis.stock_alerts and the
stocks feature), with CNBC faked: no request leaves the Mac."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import httpx
import pytest
from conftest import FakeClient

from jarvis import prefs as prefs_module
from jarvis.features import stocks as feature
from jarvis.hub import Hub
from jarvis.stock_alerts import DAILY_CAP, AlertStore, check_move, heads_up


class Clock:
    def __init__(self, at):
        self.at = at

    def __call__(self):
        return self.at


def q(last, pct=0.0, **extra):
    return {"symbol": "X", "name": "X", "last": last, "change": 0.0, "pct": pct, **extra}


# ── the store ──


def test_an_above_alert_goes_off_once_when_the_price_crosses_up(tmp_path):
    clock = Clock(datetime(2026, 9, 29, 10, 0))
    store = AlertStore(tmp_path / "alerts.json", clock)
    alert = store.add("nvda", "above", 150, last=140)
    assert (alert.symbol, alert.armed) == ("NVDA", True)
    assert store.check({"NVDA": q(149.5, 1.0)}, [], 0) == []
    fired = store.check({"NVDA": q(151.2, 2.34)}, [], 0)
    assert fired == [
        (
            "price:" + alert.id + ":2026-09-29",
            "NVDA",
            "NVDA is above 150.00: 151.20, up 2.3% today.",
        )
    ]
    assert store.check({"NVDA": q(160, 5.0)}, [], 0) == []  # once
    assert store.sent_today() == 1
    # Kept a day (shown as gone off), then dropped.
    clock.at += timedelta(days=1, hours=1)
    store.check({}, [], 0)
    assert store.alerts == []


def test_an_alert_set_past_its_line_waits_for_the_price_to_come_back(tmp_path):
    store = AlertStore(tmp_path / "alerts.json", Clock(datetime(2026, 9, 29, 10, 0)))
    alert = store.add("TSLA", "below", 200, last=190)  # already below
    assert alert.armed is False
    assert store.check({"TSLA": q(185, -3)}, [], 0) == []  # never the moment it's made
    assert store.check({"TSLA": q(205, 1)}, [], 0) == []  # back above: armed again
    assert AlertStore(tmp_path / "alerts.json").alerts[0].armed is True  # and saved
    fired = store.check({"TSLA": q(198.5, -1.25)}, [], 0)
    assert fired[0][2] == "TSLA is below 200.00: 198.50, down 1.2% today."


def test_a_move_alert_goes_off_at_most_once_a_day(tmp_path):
    clock = Clock(datetime(2026, 9, 29, 10, 0))
    store = AlertStore(tmp_path / "alerts.json", clock)
    store.add(".SPX", "move", 2)
    assert store.check({".SPX": q(7600, -1.5)}, [], 0) == []
    fired = store.check({".SPX": q(7500, -2.6)}, [], 0)
    assert fired[0][1:] == ("S&P 500", "S&P 500 is down 2.6% today, at 7,500.")
    assert store.check({".SPX": q(7400, -3.9)}, [], 0) == []
    clock.at += timedelta(days=1)
    assert len(store.check({".SPX": q(7700, 2.2)}, [], 0)) == 1  # a new day
    assert len(store.alerts) == 1  # a move alert stays


def test_big_moves_on_the_watchlist_and_the_daily_cap(tmp_path):
    store = AlertStore(tmp_path / "alerts.json", Clock(datetime(2026, 9, 29, 10, 0)))
    watch = [f"T{i}" for i in range(DAILY_CAP + 3)]
    quotes = {s: q(10, 6.0) for s in watch}
    fired = store.check(quotes, watch, 5)
    assert len(fired) == DAILY_CAP  # the rest wait for tomorrow
    assert fired[0] == ("move:T0:2026-09-29", "T0", "T0 is up 6.0% today, at 10.00.")
    assert store.check(quotes, watch, 5) == []
    store2 = AlertStore(tmp_path / "alerts.json", Clock(datetime(2026, 9, 29, 11, 0)))
    assert store2.sent_today() == DAILY_CAP  # remembered across a restart


def test_heads_ups_in_chinese():
    assert (
        heads_up("NVDA", "above", 150, 151.2, 2.34, "zh")
        == "NVDA涨破150.00，现报151.20，今天上涨2.3%。"
    )
    assert heads_up("BTC.CM=", "move", 5, 61234, -5.5, "zh") == "Bitcoin今天下跌5.5%，现报61,234。"


def test_bad_alerts_are_refused(tmp_path):
    store = AlertStore(tmp_path / "alerts.json")
    with pytest.raises(ValueError):
        store.add("not a ticker!", "above", 1)
    with pytest.raises(ValueError):
        store.add("NVDA", "sideways", 1)
    with pytest.raises(ValueError):
        store.add("NVDA", "move", 90)
    with pytest.raises(ValueError):
        store.add("NVDA", "above", -3)
    first = store.add("NVDA", "above", 150)
    assert store.add("NVDA", "above", 150) is first  # the same one, not a second
    with pytest.raises(ValueError):
        check_move("lots")


def test_a_hand_edited_or_damaged_file_never_stops_it(tmp_path):
    path = tmp_path / "alerts.json"
    path.write_text(
        json.dumps(
            {
                "alerts": [
                    {"id": "a1", "symbol": "NVDA", "kind": "above", "value": 150, "created": "x"},
                    {"id": "a2", "symbol": "NVDA", "kind": "sideways", "value": 1, "created": "x"},
                    {"id": "a3", "symbol": "$$$", "kind": "above", "value": 1, "created": "x"},
                    "junk",
                    {
                        "id": "a4",
                        "symbol": "AAPL",
                        "kind": "below",
                        "value": "cheap",
                        "created": "x",
                    },
                ],
                "sent": "many",
                "moved": [],
            }
        )
    )
    store = AlertStore(path)
    assert [a.id for a in store.alerts] == ["a1"]
    assert store.sent_today() == 0
    path.write_text("{torn")
    assert AlertStore(path).alerts == []  # set aside, nothing lost that was good


# ── the feature ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated, monkeypatch):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    desk = hub.stocks
    desk.prices = {"NVDA": q(140.0, 1.2, symbol="NVDA", name="NVIDIA", status="open")}

    async def quotes(symbols):
        desk.asked_for = list(symbols)
        return {s: desk.prices[s] for s in symbols if s in desk.prices}

    desk.quotes = quotes
    desk.tools = {t.name: t.handler for t in feature.build_server(desk)}
    hub.cards = []
    hub.answer = "deny"

    def card(approval):
        hub.cards.append(approval["question"])
        hub.resolve(approval["id"], hub.answer)

    hub.add_approval_sink(card)
    hub.refreshed = []

    async def refresh():
        hub.refreshed.append(True)

    hub.refresh_markets = refresh
    return hub


def _said(result):
    return result["content"][0]["text"]


async def test_a_quote_for_any_ticker(hub):
    after = {"last": 141.1, "pct": 0.79, "kind": "after"}
    hub.stocks.prices["AAPL"] = q(
        250, -0.5, symbol="AAPL", name="Apple", status="after", after=after
    )
    out = await hub.stocks.tools["stock_quote"]({"symbols": "nvda, $aapl ZZZZ"})
    assert hub.stocks.asked_for == ["NVDA", "AAPL", "ZZZZ"]
    assert _said(out).splitlines() == [
        "NVDA (NVIDIA): 140.00, +0.00 (+1.20%), market open",
        "AAPL (Apple): 250.00, +0.00 (-0.50%), market after; after hours 141.10 (+0.79%)",
        "No quote for ZZZZ (not a symbol CNBC knows).",
    ]
    assert (await hub.stocks.tools["stock_quote"]({"symbols": "!!"}))["is_error"]

    async def down(_symbols):
        raise httpx.ConnectError("offline")

    hub.stocks.quotes = down
    assert (await hub.stocks.tools["stock_quote"]({"symbols": "NVDA"}))["is_error"]


async def test_the_watchlist_changes_unasked_only_when_the_owner_said_so(hub):
    hub.prefs.watchlist = ["AAPL", "NVDA"]
    hub._turn_text = "add Tesla to my watchlist and drop Apple"
    out = await hub.stocks.tools["change_watchlist"]({"add": "TSLA", "remove": "AAPL"})
    assert hub.cards == [] and hub.prefs.watchlist == ["NVDA", "TSLA"]
    assert _said(out) == "The watchlist is now NVDA, TSLA."
    # An email suggested it: a card, and a no leaves it be.
    hub._turn_text = "what does this email say?"
    out = await hub.stocks.tools["change_watchlist"]({"add": "GME"})
    assert hub.cards == ["Add GME to your watchlist?"] and out["is_error"]
    assert hub.prefs.watchlist == ["NVDA", "TSLA"]
    hub.answer = "allow"
    await hub.stocks.tools["change_watchlist"]({"add": "GME", "remove": "NVDA"})
    assert hub.cards[-1] == "Add GME to your watchlist and take NVDA off?"
    assert hub.prefs.watchlist == ["TSLA", "GME"]
    out = await hub.stocks.tools["change_watchlist"]({"add": "TSLA"})
    assert "Nothing to change" in _said(out)


async def test_chinese_words_ask_for_it_too(hub):
    hub.prefs.watchlist = []
    hub._turn_text = "把英伟达加到我的自选股"
    await hub.stocks.tools["change_watchlist"]({"add": "NVDA"})
    assert hub.cards == [] and hub.prefs.watchlist == ["NVDA"]
    hub._turn_text = "当英伟达涨到150的时候提醒我"
    out = await hub.stocks.tools["set_price_alert"]({"symbol": "NVDA", "above": 150})
    assert hub.cards == [] and not out.get("is_error")


async def test_a_price_alert_set_by_voice(hub):
    hub._turn_text = "tell me when Nvidia goes above 150"
    out = await hub.stocks.tools["set_price_alert"]({"symbol": "NVDA", "above": 150})
    assert hub.cards == []
    assert _said(out) == "I'll tell you when NVDA goes above 150.00. It's at 140.00 now."
    [alert] = hub.stocks.store.alerts
    assert (alert.symbol, alert.kind, alert.value, alert.armed) == ("NVDA", "above", 150.0, True)
    listed = _said(await hub.stocks.tools["list_price_alerts"]({}))
    assert listed == f"- [{alert.id}] NVDA goes above 150.00 (watching)"


async def test_an_alert_nobody_asked_for_gets_a_card(hub):
    hub._turn_text = ""  # a routine
    out = await hub.stocks.tools["set_price_alert"]({"symbol": "NVDA", "below": 120})
    assert hub.cards == ["Tell you when NVDA goes below 120.00?"] and out["is_error"]
    assert hub.stocks.store.alerts == []
    hub.answer = "allow"
    out = await hub.stocks.tools["set_price_alert"]({"symbol": "NVDA", "move_percent": 4})
    assert hub.cards[-1] == "Tell you when NVDA moves 4% in a day?"
    assert len(hub.stocks.store.alerts) == 1


async def test_alert_arguments_are_checked(hub):
    hub._turn_text = "alert me when it moves"
    tools = hub.stocks.tools
    assert (await tools["set_price_alert"]({"symbol": "NVDA"}))["is_error"]
    assert (await tools["set_price_alert"]({"symbol": "NVDA", "above": 1, "below": 2}))["is_error"]
    out = await tools["set_price_alert"]({"symbol": "NVDA", "move_percent": 80})
    assert "between 0.5% and 50%" in _said(out)
    assert (await tools["set_price_alert"]({"symbol": "NVDA", "above": "lots"}))["is_error"]
    out = await tools["set_price_alert"]({"symbol": "QQQQQ", "above": 5})
    assert "no quote for QQQQQ" in _said(out)
    assert hub.stocks.store.alerts == []


async def test_removing_alerts(hub):
    store = hub.stocks.store
    first = store.add("NVDA", "above", 150)
    store.add("NVDA", "below", 100)
    hub._turn_text = "look at my inbox"
    out = await hub.stocks.tools["remove_price_alert"]({"id": first.id})
    assert hub.cards == ["Stop telling you when NVDA goes above 150.00?"] and out["is_error"]
    hub._turn_text = "cancel my Nvidia alerts"
    out = await hub.stocks.tools["remove_price_alert"]({"symbol": "nvda"})
    assert len(hub.cards) == 1 and store.alerts == []
    assert _said(out).startswith("Removed: NVDA goes above 150.00; NVDA goes below 100.00")
    assert (await hub.stocks.tools["remove_price_alert"]({"id": "nope"}))["is_error"]


async def test_the_loop_raises_heads_ups(hub):
    heard = []
    hub.add_notify_sink(heard.append)
    hub.prefs.proactive = True
    store = hub.stocks.store
    store.add("NVDA", "above", 150, last=140)
    assert await hub.stocks.tick() == 0
    hub.stocks.prices["NVDA"] = q(152.0, 8.6, symbol="NVDA")
    assert await hub.stocks.tick() == 1
    assert [(a.kind, a.title, a.text) for a in heard] == [
        ("price", "NVDA", "NVDA is above 150.00: 152.00, up 8.6% today.")
    ]
    assert await hub.stocks.tick() == 0  # once


async def test_the_loop_checks_nothing_when_nothing_is_watched(hub):
    hub.stocks.asked_for = None
    assert await hub.stocks.tick() == 0
    assert hub.stocks.asked_for is None  # no request at all
    hub.set_feature_prefs({feature.MOVE_PREF: 5})
    hub.prefs.watchlist = ["NVDA"]
    await hub.stocks.tick()
    assert hub.stocks.asked_for == ["NVDA"]


async def test_the_window_lists_and_removes_alerts(hub):
    events = hub.subscribe()
    alert = hub.stocks.store.add("NVDA", "above", 150, last=160)
    await hub._handle({"type": "price_alerts"})
    shown = events.get_nowait()
    assert shown["type"] == "price_alerts" and shown["cap"] == DAILY_CAP
    assert shown["items"][0]["id"] == alert.id and shown["items"][0]["waiting"] is True
    await hub._handle({"type": "price_alert_remove", "id": alert.id})
    assert hub.stocks.store.alerts == [] and hub.cards == []  # the owner's own click
    assert events.get_nowait()["items"] == []


def test_the_move_setting_is_checked():
    clean = prefs_module.FEATURE_PREFS[feature.MOVE_PREF][1]
    assert clean(5) == 5.0 and clean(0) == 0.0 and clean(2.5) == 2.5
    assert clean(99) is None and clean(True) is None and clean("5") is None
