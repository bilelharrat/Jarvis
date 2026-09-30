"""Price alerts: the owner's heads-ups for a stock, index, future or coin crossing a price, or
moving more than some percent in a day, and for big moves on their whole watchlist.

- "above 150" goes off when the price crosses up through 150. Set while it's already above,
  it waits for a dip below first, so it never goes off the moment it's made. Once it has
  gone off it's done (kept a day, shown as gone off, then dropped).
- "below 90" the same, the other way.
- "moves 5%" goes off when the day's change reaches 5% either way, at most once a day.
- The watchlist setting (a percent, 0 for off) does the same for every watchlist symbol.

At most DAILY_CAP heads-ups a day go out, all alerts together; past that they wait for
tomorrow. Quotes are CNBC's, as the Markets panel's (markets.py). The store is a JSON file
beside prefs.json (jsonstore: atomic saves, a .bak, a damaged file set aside).
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import asdict, dataclass, fields
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore, lang, markets

log = logging.getLogger("jarvis")

KINDS = ("above", "below", "move")
MAX_ALERTS = 30
DAILY_CAP = 8
KEEP_FIRED = timedelta(days=1)
MOVE_LIMITS = (0.5, 50.0)  # percent: a move alert or the watchlist setting
NAMES = dict(markets.INDICES + markets.MACRO)  # ".SPX" -> "S&P 500"
# CNBC's symbols: tickers (NVDA, BRK.B), indexes (.SPX), futures (@CL.1), coins (BTC.CM=).
SYMBOL = re.compile(r"^[.@]?[A-Z0-9][A-Z0-9.\-]{0,11}=?$")


def clean_symbols(values: Any) -> list[str]:
    """Symbols from a list or a string ("nvda, $AAPL .spx"), each once, at most 20."""
    raw = values if isinstance(values, list) else str(values or "").replace(",", " ").split()
    out: list[str] = []
    for item in raw:
        symbol = str(item).strip().upper().lstrip("$")
        if SYMBOL.match(symbol) and symbol not in out:
            out.append(symbol)
    return out[:20]


def display_name(symbol: str) -> str:
    return NAMES.get(symbol, symbol)


def _price(value: float) -> str:
    return f"{value:,.2f}" if abs(value) < 1000 else f"{value:,.0f}"


@dataclass
class PriceAlert:
    id: str
    symbol: str
    kind: str  # above | below | move
    value: float  # a price (above, below) or a percent (move)
    created: str
    armed: bool = True  # above/below: the price is on the near side of the line
    fired: str = ""  # when it went off (move: the last day it did)

    def describe(self) -> str:
        name = display_name(self.symbol)
        if self.kind == "move":
            return f"{name} moves {self.value:g}% in a day"
        return (
            f"{name} {'goes above' if self.kind == 'above' else 'goes below'} {_price(self.value)}"
        )


_FIELDS = frozenset(f.name for f in fields(PriceAlert))


def _alert_from(raw: Any) -> PriceAlert | None:
    if not isinstance(raw, dict):
        return None
    try:
        alert = PriceAlert(**{k: v for k, v in raw.items() if k in _FIELDS})
        alert.value = float(alert.value)
    except (TypeError, ValueError):
        return None
    texts = (alert.id, alert.symbol, alert.kind, alert.created, alert.fired)
    if not all(isinstance(t, str) for t in texts) or alert.kind not in KINDS:
        return None
    if not clean_symbols([alert.symbol]) or not alert.value > 0:
        return None
    alert.armed = alert.armed is not False
    return alert


def check_move(value: Any) -> float:
    """A percent for a move alert or the watchlist setting; ValueError when it's no sane one."""
    low, high = MOVE_LIMITS
    try:
        pct = float(value)
    except (TypeError, ValueError):
        pct = float("nan")
    if not low <= pct <= high:  # nan fails too
        raise ValueError(f"A move alert must be between {low:g}% and {high:g}%.")
    return pct


class AlertStore:
    def __init__(self, path: Path, clock=datetime.now) -> None:
        self.path = path
        self.clock = clock
        self.alerts: list[PriceAlert] = []
        self.sent: dict[str, int] = {}  # day -> heads-ups sent that day
        self.moved: dict[str, list[str]] = {}  # day -> watchlist symbols already said
        self.unreadable = ""
        self._load()

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("price alerts: %s can't be read; leaving it be", self.path.name)
            return
        rows = data.get("alerts")
        for raw in rows if isinstance(rows, list) else []:
            alert = _alert_from(raw)
            if alert is not None and len(self.alerts) < MAX_ALERTS:
                self.alerts.append(alert)
        today = self.clock().date().isoformat()
        sent = data.get("sent")
        if isinstance(sent, dict) and isinstance(sent.get(today), int):
            self.sent = {today: sent[today]}
        moved = data.get("moved")
        if isinstance(moved, dict) and isinstance(moved.get(today), list):
            self.moved = {today: [s for s in moved[today] if isinstance(s, str)][:50]}

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(
            self.path,
            {"alerts": [asdict(a) for a in self.alerts], "sent": self.sent, "moved": self.moved},
        )

    # ── changes ──

    def add(self, symbol: str, kind: str, value: float, last: float | None = None) -> PriceAlert:
        """A new alert (or the same one already set). last: the price now, so an alert set
        on the far side of its line waits for the price to come back first."""
        cleaned = clean_symbols([symbol])
        if not cleaned:
            raise ValueError(f"“{symbol}” isn't a ticker.")
        if kind not in KINDS:
            raise ValueError("An alert is above a price, below a price, or a move in percent.")
        value = check_move(value) if kind == "move" else float(value)
        if not value > 0:
            raise ValueError("Give a price above zero.")
        symbol = cleaned[0]
        for alert in self.alerts:
            if (alert.symbol, alert.kind, alert.value) == (symbol, kind, value) and not (
                alert.fired and kind != "move"
            ):
                return alert
        if len(self.alerts) >= MAX_ALERTS:
            raise ValueError(f"There are already {MAX_ALERTS} price alerts; remove some first.")
        armed = True
        if last is not None and kind == "above":
            armed = last < value
        elif last is not None and kind == "below":
            armed = last > value
        alert = PriceAlert(
            id=uuid.uuid4().hex[:8],
            symbol=symbol,
            kind=kind,
            value=value,
            created=self.clock().isoformat(timespec="seconds"),
            armed=armed,
        )
        self.alerts.append(alert)
        self.save()
        return alert

    def remove(self, alert_id: str = "", symbol: str = "") -> list[PriceAlert]:
        """By id, or every alert for a symbol; what went."""
        symbol = (clean_symbols([symbol]) or [""])[0] if symbol else ""
        gone = [
            a
            for a in self.alerts
            if (alert_id and a.id == alert_id) or (symbol and a.symbol == symbol)
        ]
        if gone:
            self.alerts = [a for a in self.alerts if a not in gone]
            self.save()
        return gone

    # ── the checks ──

    def symbols(self, watchlist: list[str], watch_move: float) -> list[str]:
        wanted = [a.symbol for a in self.live()]
        if watch_move > 0:
            wanted += list(watchlist)
        return list(dict.fromkeys(wanted))

    def live(self) -> list[PriceAlert]:
        return [a for a in self.alerts if a.kind == "move" or not a.fired]

    def sent_today(self) -> int:
        return self.sent.get(self.clock().date().isoformat(), 0)

    def check(
        self,
        quotes: dict[str, dict[str, Any]],
        watchlist: list[str],
        watch_move: float,
        language: str = "en",
    ) -> list[tuple[str, str, str]]:
        """The heads-ups these quotes call for: (key, title, text), within today's cap. Saves
        what went off, and re-arms alerts whose price came back across their line."""
        now = self.clock()
        today = now.date().isoformat()
        self.sent = {today: self.sent.get(today, 0)}
        self.moved = {today: self.moved.get(today, [])}
        changed = self._prune(now)
        out: list[tuple[str, str, str]] = []
        for alert in self.alerts:
            quote = quotes.get(alert.symbol)
            if quote is None:
                continue
            last, pct = float(quote["last"]), float(quote.get("pct") or 0.0)
            if alert.kind in ("above", "below"):
                if alert.fired:
                    continue
                past = last >= alert.value if alert.kind == "above" else last <= alert.value
                if not past:
                    changed |= not alert.armed
                    alert.armed = True
                    continue
                if not alert.armed:
                    continue
            elif abs(pct) < alert.value or alert.fired[:10] == today:
                continue
            if self.sent[today] >= DAILY_CAP:
                break
            alert.fired = now.isoformat(timespec="seconds")
            self.sent[today] += 1
            changed = True
            out.append(
                (
                    f"price:{alert.id}:{today}",
                    display_name(alert.symbol),
                    heads_up(alert.symbol, alert.kind, alert.value, last, pct, language),
                )
            )
        if watch_move > 0:
            for symbol in watchlist:
                quote = quotes.get(symbol)
                if quote is None or symbol in self.moved[today]:
                    continue
                pct = float(quote.get("pct") or 0.0)
                if abs(pct) < watch_move:
                    continue
                if self.sent[today] >= DAILY_CAP:
                    break
                self.moved[today].append(symbol)
                self.sent[today] += 1
                changed = True
                out.append(
                    (
                        f"move:{symbol}:{today}",
                        display_name(symbol),
                        heads_up(symbol, "move", watch_move, float(quote["last"]), pct, language),
                    )
                )
        if changed:
            try:
                self.save()
            except OSError as exc:
                log.warning("price alerts: couldn't save (%s)", exc)
        return out

    def _prune(self, now: datetime) -> bool:
        """Drop above/below alerts that went off more than a day ago."""
        keep = []
        for alert in self.alerts:
            if alert.kind != "move" and alert.fired:
                try:
                    if now - datetime.fromisoformat(alert.fired) > KEEP_FIRED:
                        continue
                except ValueError:
                    continue
            keep.append(alert)
        dropped = len(keep) != len(self.alerts)
        self.alerts = keep
        return dropped

    def public(self) -> dict[str, Any]:
        return {
            "items": [
                {
                    "id": a.id,
                    "symbol": a.symbol,
                    "name": display_name(a.symbol),
                    "kind": a.kind,
                    "value": a.value,
                    "created": a.created,
                    "fired": a.fired if a.kind != "move" else "",
                    "waiting": a.kind != "move" and not a.armed and not a.fired,
                }
                for a in self.alerts
            ],
            "sent_today": self.sent_today(),
            "cap": DAILY_CAP,
        }


def heads_up(symbol: str, kind: str, value: float, last: float, pct: float, language: str) -> str:
    """What JARVIS says when an alert goes off, in the owner's language."""
    name = display_name(symbol)
    if lang.is_zh(language):
        move = f"今天{'上涨' if pct >= 0 else '下跌'}{abs(pct):.1f}%"
        if kind == "above":
            return f"{name}涨破{_price(value)}，现报{_price(last)}，{move}。"
        if kind == "below":
            return f"{name}跌破{_price(value)}，现报{_price(last)}，{move}。"
        return f"{name}{move}，现报{_price(last)}。"
    move = f"{'up' if pct >= 0 else 'down'} {abs(pct):.1f}% today"
    if kind == "above":
        return f"{name} is above {_price(value)}: {_price(last)}, {move}."
    if kind == "below":
        return f"{name} is below {_price(value)}: {_price(last)}, {move}."
    return f"{name} is {move}, at {_price(last)}."
