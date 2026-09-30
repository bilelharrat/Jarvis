"""Exchange rates for the purchase guard's limits, with no key.

A purchase in another currency is weighed against the owner's limits in their own
currency (transactions.Transactions' convert). The rates come from the European Central
Bank's reference rates (through Frankfurter) and from open.er-api.com, both asked at once.
When both know a currency, the one that makes the purchase count for more is used: a
wrong answer from one source can only refuse a purchase, never let a large one slip under
the limits. A currency only one source knows (the ECB's list is about thirty) is counted
by that one.

A table of rates is kept for six hours, in memory and in a small file beside the settings
(fx_rates.json), so a restart doesn't ask again. When neither source answers and nothing
fresher than that is kept, there's no rate: the purchase guard refuses the purchase, as it
did before there were rates. A failed look isn't repeated for a minute, so one purchase's
checks don't each wait out the timeout.

Nothing runs at import, and a hub that doesn't poll (tests) never asks the network.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from . import jsonstore

log = logging.getLogger("jarvis")

FRANKFURTER = "https://api.frankfurter.dev/v1/latest"
OPEN_ER = "https://open.er-api.com/v6/latest/{base}"
FRESH_SECONDS = 6 * 3600
RETRY_SECONDS = 60
TIMEOUT = 5.0
_CODE = re.compile(r"[A-Z]{3}")


def clean_code(value: Any) -> str | None:
    code = str(value or "").strip().upper()
    return code if _CODE.fullmatch(code) else None


def _rates(value: Any) -> dict[str, float]:
    """A source's rates, whatever came back: currency codes to positive, finite numbers."""
    if not isinstance(value, dict):
        return {}
    out: dict[str, float] = {}
    for code, rate in list(value.items())[:400]:
        code = clean_code(code)
        if code is None or isinstance(rate, bool) or not isinstance(rate, int | float):
            continue
        rate = float(rate)
        if math.isfinite(rate) and rate > 0:
            out[code] = rate
    return out


class Rates:
    """convert(amount, source, target) -> the amount in target, or None without a rate.
    path: where the tables are kept (None: memory only). enabled: whether the network may
    be asked at all. transport: httpx's, for tests."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        enabled: bool = True,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = path
        self.enabled = enabled
        self._transport = transport
        self._clock = clock
        # base -> {"at": when fetched (epoch), "sources": {"ecb": {code: rate}, "er": {…}}}
        self._tables: dict[str, dict[str, Any]] = {}
        self._failed: dict[str, float] = {}
        self._loaded = False
        self._locks: dict[str, asyncio.Lock] = {}

    async def convert(self, amount: float, source: str, target: str) -> float | None:
        source_code, target_code = clean_code(source), clean_code(target)
        if source_code is None or target_code is None:
            return None
        if source_code == target_code:
            return float(amount)
        table = await self._table(target_code)
        # A table for the owner's currency says how much of every other one it buys:
        # an amount in another currency is that amount over its rate.
        counted = [
            float(amount) / rates[source_code] for rates in table.values() if source_code in rates
        ]
        return max(counted) if counted else None

    # ── the tables ──

    async def _table(self, base: str) -> dict[str, dict[str, float]]:
        self._load()
        kept = self._tables.get(base)
        if kept is not None and self._fresh(kept):
            return kept["sources"]
        if not self.enabled or self._clock() - self._failed.get(base, -1e18) < RETRY_SECONDS:
            return {}
        lock = self._locks.setdefault(base, asyncio.Lock())
        async with lock:
            kept = self._tables.get(base)  # another look may have just brought it
            if kept is not None and self._fresh(kept):
                return kept["sources"]
            sources = await self._fetch(base)
            if not sources:
                self._failed[base] = self._clock()
                return {}
            self._tables[base] = {"at": self._clock(), "sources": sources}
            self._save()
            return sources

    def _fresh(self, kept: dict[str, Any]) -> bool:
        age = self._clock() - float(kept.get("at") or 0)
        return 0 <= age < FRESH_SECONDS and bool(kept.get("sources"))

    async def _fetch(self, base: str) -> dict[str, dict[str, float]]:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=self._transport) as client:
            ecb, er = await asyncio.gather(
                self._get(client, FRANKFURTER, {"base": base}, base, "rates"),
                self._get(client, OPEN_ER.format(base=base), None, base, "rates"),
            )
        return {name: rates for name, rates in (("ecb", ecb), ("er", er)) if rates}

    @staticmethod
    async def _get(
        client: httpx.AsyncClient, url: str, params: dict[str, str] | None, base: str, key: str
    ) -> dict[str, float]:
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.info(
                "exchange rates: %s didn't answer (%s)", httpx.URL(url).host, type(exc).__name__
            )
            return {}
        if not isinstance(data, dict):
            return {}
        said = clean_code(data.get("base") or data.get("base_code"))
        if said != base or data.get("result", "success") != "success":
            return {}  # rates for another currency than asked, or an error
        return _rates(data.get(key))

    # ── on disk ──

    def _load(self) -> None:
        if self._loaded or self.path is None:
            self._loaded = True
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            log.info("exchange rates: %s can't be read (%s)", self.path.name, exc)
            return
        for base, kept in (data or {}).items():
            base = clean_code(base)
            if base is None or not isinstance(kept, dict):
                continue
            at = kept.get("at")
            raw = kept.get("sources")
            if isinstance(at, bool) or not isinstance(at, int | float) or not isinstance(raw, dict):
                continue
            sources = {str(name)[:10]: _rates(r) for name, r in list(raw.items())[:4]}
            sources = {name: rates for name, rates in sources.items() if rates}
            if sources:
                self._tables[base] = {"at": float(at), "sources": sources}

    def _save(self) -> None:
        if self.path is None:
            return
        try:
            jsonstore.save_json(self.path, self._tables, indent=None)
        except OSError as exc:  # a full disk: the rates still count in memory
            log.info("exchange rates: couldn't keep them (%s)", exc)
