"""Markets, more of them: a quote for any ticker, the watchlist changed by voice, and price
alerts (the "stocks" tool server, a loop, Settings › Markets).

- stock_quote: CNBC's quote service for any symbols (stocks, indexes, futures, coins).
- change_watchlist: add or take off tickers. Unasked only when the owner's own words this
  turn asked for it ("add Nvidia to my watchlist"); otherwise a card (mac_gate.own_words).
- set_price_alert / list_price_alerts / remove_price_alert: stock_alerts.py's alerts, set and
  removed by the same rule. Settings lists them with a remove button, and holds the
  watchlist's big-move alert (stocks_move_alert: a percent, 0 for off).
- The loop checks the alerts' symbols once a minute while US markets trade (pre-market to
  after hours) and every ten minutes otherwise (coins trade all night), and raises each
  heads-up once, at most stock_alerts.DAILY_CAP a day.

Cost policy (Claude): nothing here calls a model. Quotes are one small request to CNBC's
public quote service per check, only while there are alerts to check.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import lang, markets, prefs
from ..mac_gate import MacGate, asks, asks_zh
from ..proactive import Alert
from ..stock_alerts import AlertStore, check_move, clean_symbols, display_name

log = logging.getLogger("jarvis")

SERVER = "stocks"
MOVE_PREF = "stocks_move_alert"
MAX_SYMBOLS = 10
OPEN_EVERY = 60  # seconds between checks while markets trade
CLOSED_EVERY = 600
LABELS = {
    "stock_quote": "Checked a quote",
    "change_watchlist": "Changed your watchlist",
    "set_price_alert": "Set a price alert",
    "list_price_alerts": "Checked your price alerts",
    "remove_price_alert": "Removed a price alert",
}
PROMPT = (
    "\n- Stocks: stock_quote gives the price of any ticker (NVDA; indexes .SPX .IXIC .DJI; "
    "oil @CL.1, gold @GC.1, Bitcoin BTC.CM=, the ten-year US10Y), with after-hours moves; "
    "turn company names into tickers yourself. change_watchlist adds or takes tickers off "
    "the user's watchlist. set_price_alert tells them when a ticker goes above or below a "
    "price or moves a percent in a day (list_price_alerts, remove_price_alert)."
)


def _clean_move(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if value == 0:
        return 0.0
    try:
        return check_move(value)
    except ValueError:
        return None


prefs.register_feature_pref(MOVE_PREF, 0.0, _clean_move)

_WATCHLIST = r"(?:my\s+|the\s+)?watch\s*-?\s*list"
ASKED = {
    "watchlist": asks(
        r"(?:add|put|include|stick|throw)\s+.{1,60}?\s+(?:to|on|onto|in|into)\s+"
        + _WATCHLIST
        + r"|(?:remove|delete|drop|take|pull|get\s+rid\s+of|kick)\s+.{1,60}?\s+(?:from|off|out\s+of)\s+"
        + _WATCHLIST
        + r"|(?:start|stop)\s+watching\s+\S"
        + r"|(?:add|remove|delete|drop)\s+(?:to|from)\s+"
        + _WATCHLIST
    ),
    "alert": asks(
        r"(?:alert|tell|notify|warn|ping|buzz)\s+me\s+(?:when|if|once|as\s+soon\s+as)\b"
        r"|let\s+me\s+know\s+(?:when|if|once|as\s+soon\s+as)\b"
        r"|(?:set|create|add|make|put\s+in)\s+(?:up\s+)?(?:a\s+|an\s+)?(?:price\s+|stock\s+)?alert"
    ),
    "unalert": asks(
        r"(?:remove|delete|cancel|clear|drop|kill|turn\s+off|stop|get\s+rid\s+of)\s+"
        r"(?:the\s+|my\s+|that\s+|this\s+|all\s+(?:my\s+|the\s+)?)?(?:[\w$.'-]+\s+){0,3}?"
        r"(?:price\s+|stock\s+)?alerts?\b"
        r"|(?:stop|quit)\s+(?:alerting|telling|notifying|warning)\s+me\s+about\b"
    ),
}
_LIST_ZH = r"(?:我的)?(?:自选股?|自选列表|关注列表|观察列表|自选)"
ASKED_ZH = {
    "watchlist": asks_zh(
        r"(?:把|将)?[^，,。]{1,20}?(?:加到|加入|添加到|放进|放到)"
        + _LIST_ZH
        + r"|(?:把|将)[^，,。]{1,20}?从"
        + _LIST_ZH
        + r"(?:里|中)?(?:删除|删掉|去掉|移除|拿掉)"
        + r"|从"
        + _LIST_ZH
        + r"(?:里|中)?(?:删除|删掉|去掉|移除)"
        + r"|(?:取消关注|不再关注|关注)\s*\S"
    ),
    "alert": asks_zh(
        r"(?:当|如果|要是|一旦)[^。]{1,30}?(?:的时候|时)?(?:提醒|告诉|通知)我"
        r"|(?:设置?|设个|加个|建个|添加)(?:一个)?(?:股价|价格)?(?:提醒|警报|预警)"
        r"|(?:提醒|告诉|通知)我[^。]{0,30}?(?:涨到|跌到|涨破|跌破|超过|低于|高于|涨跌)"
    ),
    "unalert": asks_zh(
        r"(?:删除|删掉|取消|关掉|关闭|去掉|移除)(?:掉)?[^，,。]{0,12}?(?:价格|股价)?(?:提醒|警报|预警)"
        r"|(?:别|不要|不用)再?(?:提醒|告诉|通知)我"
    ),
}
TEXTS = {
    "Add {symbols} to your watchlist?": "要把 {symbols} 加到你的自选股吗？",
    "Take {symbols} off your watchlist?": "要把 {symbols} 从你的自选股中删除吗？",
    "Add {added} to your watchlist and take {removed} off?": "要把 {added} 加到自选股，并删除 {removed} 吗？",
    "Tell you when {name} goes above {price}?": "要在{name}涨到{price}以上时告诉你吗？",
    "Tell you when {name} goes below {price}?": "要在{name}跌到{price}以下时告诉你吗？",
    "Tell you when {name} moves {pct}% in a day?": "要在{name}一天内涨跌{pct}%时告诉你吗？",
    "Stop telling you when {name} goes above {price}?": "要不再在{name}涨到{price}以上时告诉你吗？",
    "Stop telling you when {name} goes below {price}?": "要不再在{name}跌到{price}以下时告诉你吗？",
    "Stop telling you when {name} moves {pct}% in a day?": "要不再在{name}一天内涨跌{pct}%时告诉你吗？",
    "Remove {n} price alerts for {name}?": "要删除{name}的{n}个价格提醒吗？",
}
lang.add_texts(TEXTS)


def _text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _error(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _tickers(value: Any) -> list[str]:
    """Watchlist tickers from a list or a string ("NVDA, aapl $TSLA"), as Settings takes them."""
    return markets.clean_watchlist(value if isinstance(value, list) else str(value or ""))


def quote_line(q: dict[str, Any]) -> str:
    """One quote for Claude: price, the day's move, whether the market's open, and any
    after-hours price."""
    unit = "%" if q.get("yield") else ""
    line = (
        f"{q['symbol']} ({q.get('name') or q['symbol']}): {q['last']:,.2f}{unit}, "
        f"{q.get('change', 0.0):+,.2f} ({q.get('pct', 0.0):+.2f}%), market {q.get('status')}"
    )
    after = q.get("after") or {}
    if after.get("last") is not None:
        when = "pre-market" if after.get("kind") == "pre" else "after hours"
        pct = f" ({after['pct']:+.2f}%)" if after.get("pct") is not None else ""
        line += f"; {when} {after['last']:,.2f}{pct}"
    return line


class Stocks:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.gate = MacGate(hub)
        self.store = AlertStore(hub.feature_path("price_alerts.json"))
        self.quotes = lambda symbols: hub.markets.quotes(symbols)

    def watch_move(self) -> float:
        return float(self.hub.prefs.feature(MOVE_PREF) or 0.0)

    def emit(self) -> None:
        self.hub.emit("price_alerts", **self.store.public(), move=self.watch_move())

    async def quote(self, symbols: Any) -> dict[str, Any]:
        wanted = clean_symbols(symbols)[:MAX_SYMBOLS]
        if not wanted:
            return _error("Give tickers, like NVDA or AAPL (indexes: .SPX, .IXIC, .DJI).")
        try:
            found = await self.quotes(wanted)
        except (httpx.HTTPError, ValueError) as exc:
            log.info("stock_quote: no quotes (%s)", type(exc).__name__)
            return _error("The quote service didn't answer. Try again in a moment.")
        lines = [quote_line(found[s]) for s in wanted if s in found]
        missing = [s for s in wanted if s not in found]
        if missing:
            lines.append(f"No quote for {', '.join(missing)} (not a symbol CNBC knows).")
        return _text("\n".join(lines))

    async def change_watchlist(self, add: Any, remove: Any) -> dict[str, Any]:
        current = list(self.hub.prefs.watchlist)
        adding = [s for s in _tickers(add) if s not in current]
        taking = [s for s in _tickers(remove) if s in current]
        if not adding and not taking:
            return _text(f"Nothing to change; the watchlist is {', '.join(current) or 'empty'}.")
        if len(current) + len(adding) - len(taking) > 20:
            return _error("The watchlist holds at most 20 tickers; take some off first.")
        added, removed = ", ".join(adding), ", ".join(taking)
        if adding and taking:
            question = f"Add {added} to your watchlist and take {removed} off?"
        elif adding:
            question = f"Add {added} to your watchlist?"
        else:
            question = f"Take {removed} off your watchlist?"
        asked = self.gate.asked(ASKED["watchlist"], ASKED_ZH["watchlist"])
        if not await self.gate.own_words(asked, question):
            return _error("The user said no. The watchlist is as it was.")
        new = [s for s in current if s not in taking] + adding
        self.hub.set_prefs({"watchlist": new})
        return _text(f"The watchlist is now {', '.join(new) or 'empty'}.")

    async def set_alert(self, symbol: str, above: Any, below: Any, move: Any) -> dict[str, Any]:
        wanted = clean_symbols(symbol)
        if not wanted:
            return _error("Give one ticker, like NVDA.")
        symbol, name = wanted[0], display_name(wanted[0])
        given = [(k, v) for k, v in (("above", above), ("below", below), ("move", move)) if v]
        if len(given) != 1:
            return _error("Give exactly one of above (a price), below (a price) or move_percent.")
        kind, raw = given[0]
        try:
            value = check_move(raw) if kind == "move" else float(raw)
        except (TypeError, ValueError) as exc:
            return _error(str(exc) if kind == "move" else f"{raw} isn't a price.")
        if value <= 0:
            return _error("Give a price above zero.")
        last = None
        try:
            found = await self.quotes([symbol])
            if symbol in found:
                last = float(found[symbol]["last"])
            else:
                return _error(f"There's no quote for {symbol}, so I can't watch it.")
        except (httpx.HTTPError, ValueError) as exc:
            log.info("set_price_alert: no quote (%s)", type(exc).__name__)
        price = f"{value:,.2f}"
        question = {
            "above": f"Tell you when {name} goes above {price}?",
            "below": f"Tell you when {name} goes below {price}?",
            "move": f"Tell you when {name} moves {value:g}% in a day?",
        }[kind]
        asked = self.gate.asked(ASKED["alert"], ASKED_ZH["alert"])
        if not await self.gate.own_words(asked, question):
            return _error("The user said no. No alert was set.")
        try:
            alert = await asyncio.to_thread(self.store.add, symbol, kind, value, last)
        except (ValueError, OSError) as exc:
            return _error(str(exc))
        self.emit()
        now = f" It's at {last:,.2f} now." if last is not None else ""
        wait = (
            " It's already past that, so I'll wait for it to come back first."
            if not alert.armed
            else ""
        )
        return _text(f"I'll tell you when {alert.describe()}.{now}{wait}")

    async def remove_alert(self, alert_id: str, symbol: str) -> dict[str, Any]:
        store = self.store
        matches = [
            a
            for a in store.alerts
            if (alert_id and a.id == alert_id) or (symbol and a.symbol in clean_symbols(symbol))
        ]
        if not matches:
            return _error("No such price alert. list_price_alerts shows them.")
        if len(matches) == 1:
            one = matches[0]
            name, price = display_name(one.symbol), f"{one.value:,.2f}"
            question = {
                "above": f"Stop telling you when {name} goes above {price}?",
                "below": f"Stop telling you when {name} goes below {price}?",
                "move": f"Stop telling you when {name} moves {one.value:g}% in a day?",
            }[one.kind]
        else:
            question = f"Remove {len(matches)} price alerts for {display_name(matches[0].symbol)}?"
        asked = self.gate.asked(ASKED["unalert"], ASKED_ZH["unalert"])
        if not await self.gate.own_words(asked, question):
            return _error("The user said no. The alerts are as they were.")
        ids = {a.id for a in matches}
        try:
            for alert_id_ in ids:
                await asyncio.to_thread(store.remove, alert_id_)
        except OSError as exc:
            return _error(f"I couldn't save that: {exc}")
        self.emit()
        return _text("Removed: " + "; ".join(a.describe() for a in matches) + ".")

    def list_alerts(self) -> dict[str, Any]:
        rows = []
        for a in self.store.alerts:
            state = (
                "went off " + a.fired[:16].replace("T", " ")
                if a.fired and a.kind != "move"
                else "waiting for the price to come back first"
                if not a.armed
                else "watching"
            )
            rows.append(f"- [{a.id}] {a.describe()} ({state})")
        move = self.watch_move()
        if move:
            rows.append(f"- Every watchlist ticker that moves {move:g}% in a day (Settings)")
        return _text("\n".join(rows) or "No price alerts.")

    # ── the loop ──

    async def tick(self) -> int:
        """One check: quotes for what's watched, then the heads-ups they call for. How many
        went out."""
        watchlist = list(self.hub.prefs.watchlist)
        symbols = self.store.symbols(watchlist, self.watch_move())
        if not symbols:
            return 0
        try:
            found = await self.quotes(symbols)
        except (httpx.HTTPError, ValueError) as exc:
            log.info("price alerts: no quotes (%s)", type(exc).__name__)
            return 0
        due = await asyncio.to_thread(
            self.store.check, found, watchlist, self.watch_move(), self.hub.language
        )
        for key, title, text in due:
            self.hub.notify(Alert(key, "price", title, text))
        if due:
            self.emit()
        return len(due)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # a bad answer never stops the alerts for good
                log.exception("price alerts: a check failed")
            status = markets.market_status()
            await asyncio.sleep(OPEN_EVERY if status != "closed" else CLOSED_EVERY)

    # ── the window ──

    def cmd_alerts(self, _msg: dict[str, Any]) -> None:
        self.emit()

    async def cmd_remove(self, msg: dict[str, Any]) -> None:
        """Settings' remove button: the owner's own click, so no card."""
        alert_id = str(msg.get("id") or "")[:16]
        if alert_id:
            try:
                await asyncio.to_thread(self.store.remove, alert_id)
            except OSError as exc:
                self.hub.emit("error", text=f"Couldn't remove the alert: {exc.strerror or exc}")
        self.emit()


def build_server(desk: Stocks):
    @tool(
        "stock_quote",
        "Live quotes from CNBC: price, the day's change, whether the market is open, and "
        "pre-market or after-hours prices. symbols: up to 10 tickers, like NVDA AAPL, or "
        ".SPX .IXIC .DJI .VIX US10Y @CL.1 @GC.1 BTC.CM=.",
        {"symbols": str},
    )
    async def stock_quote(args):
        return await desk.quote(args.get("symbols"))

    @tool(
        "change_watchlist",
        "Add tickers to or take them off the user's watchlist (the Markets panel and market "
        "summaries). add, remove: tickers, space or comma separated. Only when the user asked.",
        {
            "type": "object",
            "properties": {"add": {"type": "string"}, "remove": {"type": "string"}},
        },
    )
    async def change_watchlist(args):
        return await desk.change_watchlist(args.get("add"), args.get("remove"))

    @tool(
        "set_price_alert",
        "Tell the user (a heads-up, spoken) when a ticker goes above a price, below a price, "
        "or moves a percent up or down in a day. Give symbol and exactly one of above, below "
        "or move_percent. Only when the user asked.",
        {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "above": {"type": "number"},
                "below": {"type": "number"},
                "move_percent": {"type": "number"},
            },
            "required": ["symbol"],
        },
    )
    async def set_price_alert(args):
        return await desk.set_alert(
            str(args.get("symbol") or ""),
            args.get("above"),
            args.get("below"),
            args.get("move_percent"),
        )

    @tool("list_price_alerts", "The user's price alerts, with their ids.", {})
    async def list_price_alerts(_args):
        return desk.list_alerts()

    @tool(
        "remove_price_alert",
        "Remove a price alert by its id (list_price_alerts), or every alert for a symbol.",
        {
            "type": "object",
            "properties": {"id": {"type": "string"}, "symbol": {"type": "string"}},
        },
    )
    async def remove_price_alert(args):
        return await desk.remove_alert(str(args.get("id") or ""), str(args.get("symbol") or ""))

    return create_sdk_mcp_server(
        name=SERVER,
        version="0.1.0",
        tools=[
            stock_quote,
            change_watchlist,
            set_price_alert,
            list_price_alerts,
            remove_price_alert,
        ],
    )


def install(hub: Any) -> None:
    desk = Stocks(hub)
    hub.stocks = desk
    hub.register_server(
        SERVER,
        lambda: build_server(desk),
        prompt=PROMPT,
        labels=LABELS,
        # Prices are public facts; the rest is JARVIS's own words about the owner's own
        # settings (tickers they named).
        quiet=tuple(LABELS),
    )
    hub.register_command("price_alerts", desk.cmd_alerts)
    hub.register_command("price_alert_remove", desk.cmd_remove)
    hub.register_loop("price_alerts", desk.run)
