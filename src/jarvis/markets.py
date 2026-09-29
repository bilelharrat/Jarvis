"""The day in the markets: indices, rates and commodities, and the user's watchlist.

Quotes come from CNBC's public quote service (one batched call, no key), the same
primary source the BSH research center uses; intraday bars for the index sparklines
come from CNBC's chart service. Refreshed every minute while the market is open and
every ten minutes otherwise.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger("jarvis")

QUOTE_URL = (
    "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol"
    "?symbols={symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1"
    "&output=json&events=1"
)
CHART_URL = "https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol={symbol}"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

INDICES = [(".SPX", "S&P 500"), (".IXIC", "Nasdaq"), (".DJI", "Dow"), (".RUT", "Russell 2000")]
MACRO = [
    ("US10Y", "10-yr"),
    (".VIX", "VIX"),
    ("@CL.1", "Oil"),
    ("@GC.1", "Gold"),
    ("BTC.CM=", "Bitcoin"),
]
DEFAULT_WATCHLIST = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]
TICKER = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
SPARK_POINTS = 60
STATUS = {"REG_MKT": "open", "PRE_MKT": "pre", "POST_MKT": "after", "CLOSED": "closed"}


def market_status(now: datetime | None = None) -> str:
    """NYSE hours in New York time: pre (4:00), open (9:30-16:00), after (to 20:00),
    closed otherwise and at weekends."""
    from zoneinfo import ZoneInfo

    et = (now or datetime.now(ZoneInfo("America/New_York"))).astimezone(
        ZoneInfo("America/New_York")
    )
    if et.weekday() >= 5:
        return "closed"
    minutes = et.hour * 60 + et.minute
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return "open"
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return "pre"
    if 16 * 60 <= minutes < 20 * 60:
        return "after"
    return "closed"


def clean_watchlist(values: Any) -> list[str]:
    out: list[str] = []
    for raw in values if isinstance(values, list) else str(values or "").replace(",", " ").split():
        ticker = str(raw).strip().upper().lstrip("$")
        if TICKER.match(ticker) and ticker not in out:
            out.append(ticker)
    return out[:20]


def _number(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).replace(",", "").replace("%", "").strip()
    if not text or text in ("-", "UNCH"):
        return 0.0 if text == "UNCH" else None
    try:
        return float(text)
    except ValueError:
        return None


def parse_quotes(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """CNBC's restQuote answer -> {symbol: {name, last, change, pct, status}}."""
    found = payload.get("FormattedQuoteResult", {}).get("FormattedQuote") or []
    if isinstance(found, dict):
        found = [found]
    out = {}
    for q in found:
        if str(q.get("code", "0")) != "0":
            continue  # unknown symbol
        last = _number(q.get("last"))
        if last is None:
            continue
        pct = _number(q.get("change_pct"))
        change = _number(q.get("change"))
        extended = q.get("ExtendedMktQuote") or {}
        out[str(q.get("symbol"))] = {
            "symbol": str(q.get("symbol")),
            "name": str(q.get("shortName") or q.get("name") or q.get("symbol")),
            "last": last,
            "change": change or 0.0,
            "pct": pct or 0.0,
            "status": STATUS.get(str(q.get("curmktstatus", "")), "closed"),
            "yield": str(q.get("last", "")).endswith("%"),
            "after": {
                "last": _number(extended.get("last")),
                "pct": _number(extended.get("change_pct")),
                "kind": "pre" if "PRE" in str(extended.get("type", "")) else "after",
            }
            if extended.get("last")
            else None,
        }
    return out


def parse_chart(payload: dict[str, Any]) -> list[float]:
    """The latest session's closes, thinned to about SPARK_POINTS points."""
    bars = (payload.get("barData") or {}).get("priceBars") or []
    if not bars:
        return []
    day = str(bars[-1].get("tradeTime", ""))[:8]
    closes = [
        float(b["close"])
        for b in bars
        if str(b.get("tradeTime", ""))[:8] == day and _number(b.get("close")) is not None
    ]
    if len(closes) > SPARK_POINTS:
        step = len(closes) / SPARK_POINTS
        closes = [closes[int(i * step)] for i in range(SPARK_POINTS)] + [closes[-1]]
    return closes


class Markets:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client
        self.summary: dict[str, Any] | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=8, headers=HEADERS, follow_redirects=True)
        return self._client

    async def quotes(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        if not symbols:
            return {}
        url = QUOTE_URL.format(symbols=quote("|".join(symbols), safe=""))
        response = await self._http().get(url)
        response.raise_for_status()
        return parse_quotes(response.json())

    async def spark(self, symbol: str) -> list[float]:
        try:
            response = await self._http().get(CHART_URL.format(symbol=quote(symbol, safe="")))
            response.raise_for_status()
            return parse_chart(response.json())
        except (httpx.HTTPError, ValueError):
            return []

    async def refresh(self, watchlist: list[str]) -> dict[str, Any]:
        symbols = [s for s, _ in INDICES + MACRO] + list(watchlist)
        quotes, *sparks = await asyncio.gather(
            self.quotes(symbols), *(self.spark(s) for s, _ in INDICES)
        )
        rows = []
        for (symbol, name), spark in zip(INDICES, sparks, strict=True):
            if symbol in quotes:
                rows.append({**quotes[symbol], "name": name, "spark": spark})
        macro = [{**quotes[s], "name": n} for s, n in MACRO if s in quotes]
        watch = [quotes[s] for s in watchlist if s in quotes]
        status = market_status()
        self.summary = {
            "as_of": datetime.now().isoformat(timespec="seconds"),
            "status": status,
            "indices": rows,
            "macro": macro,
            "watchlist": watch,
            "headline": headline(rows, watch, status),
        }
        return self.summary


def _pct(value: float) -> str:
    return f"{'+' if value >= 0 else '−'}{abs(value):.2f}%"


def headline(indices: list[dict[str, Any]], watch: list[dict[str, Any]], status: str) -> str:
    """One line for the panel, and what JARVIS says for 'how's the market?'."""
    if not indices:
        return "No market data right now."
    spx = indices[0]
    moves = ", ".join(f"{i['name']} {_pct(i['pct'])}" for i in indices[:3])
    mood = "up" if spx["pct"] > 0.15 else "down" if spx["pct"] < -0.15 else "flat"
    when = {
        "open": "Stocks are",
        "pre": "Stocks closed",  # before the open, the numbers are yesterday's close
        "after": "Stocks closed",
        "closed": "Stocks closed",
    }[status]
    line = f"{when} {mood}: {moves}."
    if watch:
        best = max(watch, key=lambda q: q["pct"])
        worst = min(watch, key=lambda q: q["pct"])
        if best["pct"] > 0:
            line += f" Leading your list: {best['symbol']} {_pct(best['pct'])}."
        if worst["pct"] < 0 and worst is not best:
            line += f" Lagging: {worst['symbol']} {_pct(worst['pct'])}."
    return line


def spoken(summary: dict[str, Any] | None) -> str:
    """The summary as JARVIS would say it (numbers read naturally)."""
    if not summary or not summary.get("indices"):
        return "I couldn't get market data just now."
    parts = [
        re.sub(
            r"([+−])(\d+\.\d+)%",
            lambda m: f"{'up' if m.group(1) == '+' else 'down'} {m.group(2)} percent",
            summary["headline"],
        )
    ]
    macro = {m["name"]: m for m in summary.get("macro", [])}
    if "10-yr" in macro:
        parts.append(f"The ten-year yield is {macro['10-yr']['last']:.2f} percent.")
    if "Bitcoin" in macro:
        btc = macro["Bitcoin"]
        way = "up" if btc["pct"] >= 0 else "down"
        parts.append(
            f"Bitcoin is at {btc['last']:,.0f} dollars, {way} {abs(btc['pct']):.1f} percent."
        )
    return " ".join(parts)
