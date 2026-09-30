"""Page watchers: "tell me when this page changes", "when the price drops below $40", "when
it's back in stock". JARVIS looks at the page again every hour or so, compares, and gives a
heads-up when it's time.

- A watch is made by Claude's watch_page (the page on show, or an address), asked for in the
  owner's own words (a card otherwise, and always after the turn read private data: an
  address can carry it). Never a sensitive site or this Mac's own pages. At most MAX_WATCHES.
- How it's looked at is chosen when it's made: fetched with httpx when the page's own HTML
  has what's watched (the text, the price, whether it's in stock), else opened in a tab of
  its own in the built-in browser, behind the one on show, and closed again (a page that
  builds itself with scripts; only while the app is open).
- What's compared: a price from the page's product data (schema.org offers, product and og
  meta tags) or the amount after the same words as when it was made; in stock or not from
  the product data or the page's words (sold out, add to cart, 缺货, 加入购物车…); a change,
  as the page's lines that came or went (not the times and "5 minutes ago" that always
  change), counted by fingerprints of lines, never kept whole.
- A price or stock watch tells once and is done; a change watch tells at most every six
  hours. A page that can't be read six times running is paused, and the owner told.
- The owner sees them in Settings › Browser and stops them there (or says so: stop_watch).

Checks run on a background loop (every five minutes, at most three watches each time, each
watch no more often than every half hour), never in tests.

Cost policy: no model calls; watch_page is a tool call inside a turn the owner asked for.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import time
import uuid
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlsplit

import httpx
from claude_agent_sdk import tool

from ... import jsonstore, lang, transactions
from ...proactive import Alert
from .sites import Sites, host_of

log = logging.getLogger("jarvis")

KINDS = ("change", "below", "stock")
MAX_WATCHES = 20
EVERY_HOURS = 1.0
MIN_HOURS, MAX_HOURS = 0.5, 24.0
TICK_SECONDS = 5 * 60
PER_TICK = 3
FETCH_SECONDS = 20.0
MAX_BYTES = 2_000_000
CHANGE_QUIET = 6 * 3600  # a change watch tells at most this often
PAUSE_AFTER = 6  # failed looks in a row
DONE_KEPT = 7 * 24 * 3600  # a finished watch stays on the list this long
MAX_LINES = 1500
OWNER = "watch"  # the tab a look opens is this one's
UA = "JARVIS-page-watcher/1.0 (a personal assistant checking a page its owner asked about)"
ASKED = re.compile(
    r"\b(?:tell|let|notify|ping|alert|message|text)\s+me\s+(?:know\s+)?(?:when|if|once|as\s+soon\s+as)\b"
    r"|\b(?:watch|monitor|track|keep\s+(?:an\s+)?eye\s+on|keep\s+watching)\b"
    r"|告诉我|通知我|提醒我|盯着|关注|留意|监控|降价|到货",
    re.IGNORECASE,
)
STOP_ASKED = re.compile(
    r"\b(?:stop|cancel|remove|delete|forget|drop)\b[^.!?]{0,30}\b(?:watch|watching|monitor|tracking|alert)"
    r"|不要再?(?:盯|关注|监控)|取消(?:关注|监控)|停止(?:关注|监控)",
    re.IGNORECASE,
)
PROMPT = (
    "\n- Page watchers: watch_page tells the user when a page changes, when its price drops "
    "below an amount, or when it's back in stock (the page on show unless you give an "
    "address; checked about every hour; at most twenty). list_watches shows them and "
    "stop_watch stops one. Use them for 'tell me when this page changes', 'when the price "
    "drops below', 'when it's back in stock'."
)
LABELS = {
    "watch_page": "Watched a page",
    "list_watches": "Looked at the page watches",
    "stop_watch": "Stopped watching a page",
}
FOUND_BELOW = "{title} is now {price}, below your {below}."
FOUND_STOCK = "{title} is back in stock."
FOUND_CHANGE = "{title} changed: {what}"
PAUSED = "I stopped watching {host}: its page couldn't be read {n} times in a row."
TITLE = "Page watch"


# ── reading a page's HTML ──


class _Html(HTMLParser):
    """A page's text as it reads, its title, its meta tags and its JSON-LD scripts."""

    SKIP = frozenset({"script", "style", "noscript", "template", "svg", "iframe", "head"})
    BLOCK = frozenset(
        {"p", "div", "li", "tr", "br", "section", "article", "header", "footer", "td", "dd",
         "dt", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "main", "aside", "nav",
         "ul", "ol", "table", "form", "label", "button", "option"}
    )  # fmt: skip

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.meta: dict[str, str] = {}
        self.ld: list[str] = []
        self.title = ""
        self._skip = 0
        self._ld: list[str] | None = None
        self._in_title = False
        self._size = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
        if tag == "meta" and key and a.get("content"):
            self.meta.setdefault(key, a["content"][:500])
        elif tag == "link" and a.get("itemprop") and a.get("href"):
            self.meta.setdefault(a["itemprop"].lower(), a["href"][:500])
        elif a.get("itemprop") in ("price", "pricecurrency", "availability") and a.get("content"):
            self.meta.setdefault(a["itemprop"].lower(), a["content"][:500])
        if (
            tag == "script"
            and a.get("type", "").lower() == "application/ld+json"
            and len(self.ld) < 30
        ):
            self._ld = []
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self._skip += 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._ld is not None:
            self.ld.append("".join(self._ld)[:200_000])
            self._ld = None
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._ld is not None:
            self._ld.append(data)
            return
        if self._in_title and len(self.title) < 300:
            self.title += data
        if self._skip or self._size > 400_000:
            return
        self.parts.append(data)
        self._size += len(data)


def read_html(body: str) -> dict[str, Any]:
    """{text, title, meta, ld}: what a watcher needs of a page's HTML."""
    parser = _Html()
    try:
        parser.feed(body)
        parser.close()
    except Exception:  # (html.parser is forgiving; a page it chokes on is read as far as it got)
        log.debug("page watcher: the HTML couldn't be read to its end")
    lines = [" ".join(line.split()) for line in "".join(parser.parts).split("\n")]
    ld: list[Any] = []
    for raw in parser.ld:
        try:
            ld.append(json.loads(raw))
        except ValueError:
            continue
    return {
        "text": "\n".join(line for line in lines if line),
        "title": " ".join(parser.title.split())[:300],
        "meta": parser.meta,
        "ld": ld,
    }


def _offers(node: Any, depth: int = 0) -> list[dict[str, Any]]:
    """Every schema.org offer in JSON-LD (Product.offers, AggregateOffer, @graph…)."""
    if depth > 6:
        return []
    out: list[dict[str, Any]] = []
    if isinstance(node, list):
        for item in node[:50]:
            out += _offers(item, depth + 1)
    elif isinstance(node, dict):
        kind = node.get("@type")
        kinds = kind if isinstance(kind, list) else [kind]
        if any(str(k) in ("Offer", "AggregateOffer") for k in kinds):
            out.append(node)
        for key in ("offers", "@graph", "mainEntity", "itemOffered"):
            if key in node:
                out += _offers(node[key], depth + 1)
    return out


def _number(value: Any) -> float | None:
    try:
        number, _ = transactions.parse_amount(
            value if isinstance(value, int | float) else str(value).replace(",", "")
        )
    except ValueError:
        return None
    return number


_STOCK_IN = ("instock", "in stock", "limitedavailability", "onlineonly", "instoreonly", "presale")
_STOCK_OUT = ("outofstock", "out of stock", "soldout", "sold out", "discontinued", "oos")


def _stock_word(value: Any) -> bool | None:
    word = str(value or "").lower().rsplit("/", 1)[-1].replace("_", "").replace("-", " ")
    squeezed = word.replace(" ", "")
    if any(w.replace(" ", "") == squeezed for w in _STOCK_OUT):
        return False
    if any(w.replace(" ", "") == squeezed for w in _STOCK_IN):
        return True
    return None


def structured(page: dict[str, Any]) -> dict[str, Any]:
    """The page's own product data: {price: (value, currency) or None, stock: True, False
    or None}."""
    meta = page.get("meta") or {}
    price: tuple[float, str] | None = None
    stock: bool | None = None
    for offer in _offers(page.get("ld") or []):
        value = _number(
            offer.get("price") if offer.get("price") is not None else offer.get("lowPrice")
        )
        if value is not None and price is None:
            price = (value, str(offer.get("priceCurrency") or "").upper()[:3])
        if stock is None:
            stock = _stock_word(offer.get("availability"))
    if price is None:
        for key in ("product:price:amount", "og:price:amount", "price"):
            value = _number(meta.get(key)) if meta.get(key) else None
            if value is not None:
                currency = (
                    meta.get("product:price:currency")
                    or meta.get("og:price:currency")
                    or meta.get("pricecurrency")
                    or ""
                )
                price = (value, str(currency).upper()[:3])
                break
    if stock is None:
        for key in ("product:availability", "og:availability", "availability"):
            if meta.get(key):
                stock = _stock_word(meta[key])
                if stock is not None:
                    break
    return {"price": price, "stock": stock}


_OUT_WORDS = re.compile(
    r"\b(?:sold\s+out|out\s+of\s+stock|currently\s+unavailable|temporarily\s+(?:unavailable|"
    r"out\s+of\s+stock)|no\s+longer\s+available|notify\s+me\s+when\s+(?:it'?s\s+)?(?:available|"
    r"back)|email\s+me\s+when\s+(?:it'?s\s+)?(?:available|back))\b|缺货|售罄|无货|已售完|暂时无货|到货通知",
    re.IGNORECASE,
)
_IN_WORDS = re.compile(
    r"\b(?:add\s+to\s+(?:cart|bag|basket|trolley)|in\s+stock|buy\s+(?:it\s+)?now)\b|加入购物车|立即购买|有货|现货",
    re.IGNORECASE,
)


def text_stock(text: str) -> bool | None:
    """In stock by the page's words: True, False, or None when they don't say (or say both)."""
    out, back = bool(_OUT_WORDS.search(text)), bool(_IN_WORDS.search(text))
    if out != back:
        return back
    return None


def prices(text: str) -> list[tuple[float, frozenset[str], str]]:
    """The amounts with a currency on the page: (value, currencies, the words before it)."""
    found = []
    for line in text.splitlines()[:5000]:
        for m in transactions.money_in(line):
            if m.signed:
                found.append((m.value, m.signs, line[max(0, m.start - 40) : m.start].strip()))
    return found


def pick_price(text: str, anchor: str, last: float | None, currency: str) -> float | None:
    """The watched price on the page: the amount after the same words as before, else the
    one nearest the last price seen (never one far from it: a price elsewhere on the page)."""
    found = [p for p in prices(text) if not currency or not p[1] - {"?"} or currency in p[1]]
    key = anchor[-20:].strip().lower()
    if key:
        for value, _signs, before in found:
            if before.lower().endswith(key):
                return value
    if last is not None and found:
        value = min(found, key=lambda p: abs(p[0] - last))[0]
        if abs(value - last) <= 0.6 * last:
            return value
    return None


_NOISE = re.compile(
    r"\b\d+\s*(?:s|sec|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s+ago\b|\bjust\s+now\b"
    r"|\b(?:updated|posted|published)\b|\b\d{1,2}:\d{2}\b|\b(?:today|yesterday)\b|分钟前|小时前|刚刚",
    re.IGNORECASE,
)


def lines_of(text: str) -> list[str]:
    """The page's lines worth comparing: long enough to mean something, not the ones that
    change on their own (times, "5 minutes ago"), each once."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if len(line) < 8 or (not lang.has_cjk(line) and len(line.split()) < 4):
            continue
        if len(line) < 100 and _NOISE.search(line):
            continue
        key = line.lower()
        if key not in seen:
            seen.add(key)
            out.append(line[:300])
        if len(out) >= MAX_LINES:
            break
    return out


def _shingles(text: str, most: int) -> set[str]:
    """The page's runs of six words (at most `most` of them), for how alike two pages are."""
    words = text.lower().split()[: most + 5]
    return {" ".join(words[i : i + 6]) for i in range(max(0, len(words) - 5))}


def fingerprint(line: str) -> str:
    return hashlib.sha256(line.lower().encode()).hexdigest()[:12]


def changed(before: list[str], lines: list[str]) -> tuple[bool, list[str]]:
    """Whether the page changed from the fingerprints kept: at least two lines came or went
    (an edited line is both), and on a big page at least 2% of them (its rotating parts are
    what the quiet between heads-ups is for); and the first lines that came."""
    old = set(before)
    new = {fingerprint(line) for line in lines}
    came = [line for line in lines if fingerprint(line) not in old]
    moved = len(came) + len(old - new)
    return moved >= max(2, 0.02 * (len(old) + len(new))), came[:3]


def public_url(url: Any) -> str:
    """An http(s) address on the internet (not this Mac or the local network), without its
    fragment; "" otherwise."""
    text = str(url or "").strip()
    try:
        parts = urlsplit(text)
    except ValueError:
        return ""
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
        return ""
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home")):
        return ""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        return ""  # this Mac, the local network, link-local, reserved
    if address is None and "." not in host:
        return ""  # a single-label name: something on the local network
    return text.split("#", 1)[0][:2000]


def _amount(value: float | None, currency: str) -> str:
    if value is None:
        return ""
    return transactions.money(value, currency) if currency else f"{value:,.2f}"


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def _load_shape(value: Any) -> bool:
    return isinstance(value, list)


class Watchers:
    def __init__(self, hub: Any, bridge: Any, sites: Sites, page: Any) -> None:
        self.hub = hub
        self.bridge = bridge
        self.sites = sites
        self.page = page  # pagectx.PageContext: the page on show
        self.transport: httpx.AsyncBaseTransport | None = None  # tests hand one in
        self._watches: list[dict[str, Any]] | None = None

    # ── the list ──

    @property
    def path(self):
        return self.hub.feature_path("browser_watches.json")

    def watches(self) -> list[dict[str, Any]]:
        if self._watches is None:
            try:
                raw = jsonstore.load_json(self.path, _load_shape) or []
            except OSError:
                raw = []
            self._watches = [w for w in (self._clean(x) for x in raw[:100]) if w is not None]
        return self._watches

    @staticmethod
    def _clean(raw: Any) -> dict[str, Any] | None:
        """A watch as saved, read defensively (a hand-edited file never breaks the loop)."""
        if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
            return None
        url = public_url(raw.get("url"))
        if not url:
            return None
        try:
            every = min(MAX_HOURS, max(MIN_HOURS, float(raw.get("every") or EVERY_HOURS)))
            below = float(raw["below"]) if raw.get("below") is not None else None
            made = float(raw.get("made") or 0)
            last = float(raw.get("last") or 0)
            told = float(raw.get("told") or 0)
            failures = max(0, int(raw.get("failures") or 0))
            seen_price = float(raw["price"]) if raw.get("price") is not None else None
        except (TypeError, ValueError, OverflowError):
            return None
        if raw["kind"] == "below" and below is None:
            return None
        lines = [str(x)[:12] for x in raw.get("lines") or [] if isinstance(x, str)][:MAX_LINES]
        return {
            "id": str(raw.get("id") or uuid.uuid4().hex[:8])[:16],
            "url": url,
            "host": host_of(url),
            "title": str(raw.get("title") or "")[:200],
            "kind": raw["kind"],
            "below": below,
            "currency": str(raw.get("currency") or "")[:3],
            "every": every,
            "via": "tab" if raw.get("via") == "tab" else "fetch",
            "made": made,
            "last": last,
            "told": told,
            "failures": failures,
            "paused": bool(raw.get("paused")),
            "done": bool(raw.get("done")),
            "price": seen_price,
            "anchor": str(raw.get("anchor") or "")[:60],
            "stock": raw.get("stock") if isinstance(raw.get("stock"), bool) else None,
            "lines": lines,
            "result": str(raw.get("result") or "")[:200],
        }

    async def save(self) -> None:
        data = list(self.watches())
        try:
            await asyncio.to_thread(jsonstore.save_json, self.path, data, indent=None)
        except OSError:
            log.warning("page watcher: the watches couldn't be saved")

    def payload(self) -> dict[str, Any]:
        items = []
        for w in self.watches():
            items.append(
                {
                    k: w[k]
                    for k in (
                        "id",
                        "url",
                        "host",
                        "title",
                        "kind",
                        "below",
                        "currency",
                        "every",
                        "last",
                        "paused",
                        "done",
                        "result",
                    )
                }
            )
        return {"items": items, "max": MAX_WATCHES}

    def emit(self) -> None:
        self.hub.emit("browser_ai_watches", **self.payload())

    # ── looking at a page ──

    async def fetch(self, url: str) -> dict[str, Any] | None:
        """The page's HTML, read (read_html), or None when it can't be had."""

        async def public_only(request: httpx.Request) -> None:
            if not public_url(str(request.url)):
                raise httpx.RequestError("not a public address", request=request)

        try:
            async with httpx.AsyncClient(
                timeout=FETCH_SECONDS,
                follow_redirects=True,
                max_redirects=5,
                transport=self.transport,
                headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"},
                event_hooks={"request": [public_only]},
            ) as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        return None
                    kind = response.headers.get("content-type", "")
                    if kind and "html" not in kind:
                        return None
                    body = b""
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_BYTES:
                            break
                    encoding = response.encoding or "utf-8"
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            log.info("page watcher: %s didn't answer (%s)", host_of(url), type(exc).__name__)
            return None
        return await asyncio.to_thread(read_html, body.decode(encoding, errors="replace"))

    async def in_tab(self, url: str) -> dict[str, Any] | None:
        """The page opened in a tab of its own behind the one on show, read, and closed."""
        hub = self.hub
        if not hub.browser_available:
            return None
        opened = await hub._browser_raw(
            "open", {"url": url, "newTab": True, "background": True, "owner": OWNER}
        )
        tab = opened.get("tab")
        if not tab or opened.get("error") or opened.get("ok") is False:
            return None
        try:
            await hub._browser_raw("wait", {"tab": tab, "idle": True, "ms": 10000})
            read = await hub._browser_raw("read", {"tab": tab, "limit": 60000})
            if read.get("error") or read.get("ok") is False:
                return None
            return {
                "text": str(read.get("text") or ""),
                "title": str(read.get("title") or ""),
                "meta": {},
                "ld": [],
            }
        finally:  # (background: the window doesn't open the dock for it)
            await hub._browser_raw("tabs", {"op": "close", "id": tab, "background": True})

    async def look(self, watch: dict[str, Any]) -> dict[str, Any] | None:
        page = await (
            self.in_tab(watch["url"]) if watch["via"] == "tab" else self.fetch(watch["url"])
        )
        if page is None:
            return None
        data = structured(page)
        text = page["text"]
        price = None
        if watch["kind"] == "below":
            if data["price"] and (
                not watch["currency"]
                or not data["price"][1]
                or data["price"][1] == watch["currency"]
            ):
                price = data["price"][0]
            else:
                price = pick_price(text, watch["anchor"], watch["price"], watch["currency"])
        stock = data["stock"] if data["stock"] is not None else text_stock(text)
        currency = data["price"][1] if data["price"] and price == data["price"][0] else ""
        return {
            "text": text,
            "title": page["title"],
            "price": price,
            "currency": currency,
            "stock": stock,
            "lines": lines_of(text),
        }

    # ── making one ──

    async def _allowed(self, question: str, detail: str, spoken: str, asked_by: re.Pattern) -> bool:
        """Unasked when the owner's own words this turn asked for it and the turn read
        nothing private (an address can carry what was read); a card otherwise."""
        hub = self.hub
        reads = hub._gate_reads()
        if asked_by.search(hub._turn_text or "") and not reads.get("private"):
            return True
        return await hub._ask_user(question, detail, spoken)

    async def make(self, args: dict[str, Any]) -> dict[str, Any]:
        kind = str(args.get("kind") or "change")
        if kind not in KINDS:
            return _text("kind is change, below or stock.", True)
        state = self.page.page
        url = public_url(args.get("url") or (state.url if state.web else ""))
        if not url:
            return _text(
                "Give the page's address (the page on show isn't a page on the internet).", True
            )
        host = host_of(url)
        if self.sites.sensitive(host):
            return _text(
                f"{host} is a sensitive site (Settings › Browser): I don't watch those.", True
            )
        live = [w for w in self.watches() if not w["done"]]
        if len(live) >= MAX_WATCHES:
            return _text(
                f"There are already {MAX_WATCHES} page watches; stop one first (list_watches).",
                True,
            )
        below, currency, signs = None, "", frozenset()
        if kind == "below":
            try:
                below, signs = transactions.parse_amount(args.get("below"))
            except ValueError:
                return _text('below needs the amount, like 40 or "$39.99".', True)
            currency = next(iter(signs)) if len(signs) == 1 else ""
        try:
            every = min(MAX_HOURS, max(MIN_HOURS, float(args.get("every_hours") or EVERY_HOURS)))
        except (TypeError, ValueError):
            every = EVERY_HOURS
        what = {
            "change": "changes",
            "below": f"drops below {_amount(below, currency)}",
            "stock": "is back in stock",
        }[kind]
        if not await self._allowed(
            f"Watch {host}?",
            f"Tell you when {url} {what}. I'd look at it about every {every:g} hour{'s' if every != 1 else ''}.",
            f"Can I watch {host} and tell you when it {what}?",
            ASKED,
        ):
            return _text("The user said no. Don't watch it.", True)
        # How it's looked at: its own HTML when that has what's watched, else a tab.
        on_show = state.web and state.url.split("#", 1)[0] == url
        watch = {"id": uuid.uuid4().hex[:8], "url": url, "kind": kind, "below": below, "currency": currency,
                 "every": every, "via": "fetch", "made": time.time(), "last": time.time(), "told": 0, "failures": 0}  # fmt: skip
        watch = self._clean(watch)
        seen = await self.look(watch)
        usable = seen is not None and (
            (kind == "change" and len(seen["lines"]) >= 5)
            or (kind == "below" and seen["price"] is not None)
            or (kind == "stock" and seen["stock"] is not None)
        )
        if (
            usable
            and on_show
            and kind == "change"
            and not await self._like_on_show(seen, state.tab)
        ):
            usable = False  # what the page's HTML says isn't what the owner sees (it builds itself)
        if kind == "below" and not usable and on_show:
            main = await self.bridge.call(
                "price", {"tab": state.tab} if state.tab is not None else {}, timeout=4.0
            )
            found = transactions.money_in(str(main.get("text") or ""))
            if found:
                watch["price"], watch["anchor"] = (
                    found[0].value,
                    str(main.get("anchor") or "")[-60:],
                )
                seen = await self.look(watch)
                usable = seen is not None and seen["price"] is not None
        if not usable:
            watch["via"] = "tab"
            if kind == "below" and watch["price"] is None and args.get("price_now") is not None:
                watch["price"] = _number(args.get("price_now"))
            seen = await self.look(watch)
            if (
                seen is None
                or (kind == "below" and seen["price"] is None)
                or (kind == "stock" and seen["stock"] is None)
            ):
                return _text(
                    "I couldn't find that on the page to watch it"
                    + (
                        " (the price: give price_now, as the page shows it)"
                        if kind == "below"
                        else ""
                    )
                    + ".",
                    True,
                )
        if kind == "below" and not currency:  # "$40": the page's own kind of dollar
            if seen["currency"] and (not signs or seen["currency"] in signs):
                currency = seen["currency"]
            elif signs and signs <= transactions.DOLLARS:
                owner = getattr(self.hub.prefs, "pay_currency", "") or "USD"
                currency = transactions.clean_currency("$", owner) or ""
            watch["currency"] = currency
        watch["title"] = (seen["title"] or state.title or host)[:200]
        watch["lines"] = [fingerprint(line) for line in seen["lines"]]
        if kind == "below":
            watch["price"] = seen["price"]
            if seen["price"] < below:
                return _text(
                    f"It's already {_amount(seen['price'], currency)}, under that. Tell the "
                    "user; don't watch it."
                )
        if kind == "stock":
            watch["stock"] = seen["stock"]
            if seen["stock"]:
                return _text("It's in stock now. Tell the user; don't watch it.")
        self.watches().append(watch)
        await self.save()
        self.emit()
        how = (
            "fetching the page"
            if watch["via"] == "fetch"
            else "opening it in a tab behind the one on show"
        )
        return _text(
            f"Watching {watch['title']} ({host}): I'll tell the user when it {what}; checked about every {every:g} hour(s) by {how}."
        )

    async def _like_on_show(self, seen: dict[str, Any], tab: Any) -> bool:
        """Whether a fetched page has much of the text the tab on show shows."""
        read = await self.hub._browser_raw(
            "read", {"tab": tab, "limit": 30000} if tab is not None else {"limit": 30000}
        )
        shown = _shingles(str(read.get("text") or ""), 300)
        if read.get("error") or read.get("ok") is False or len(shown) < 20:
            return True  # nothing to hold it against
        fetched = _shingles(seen["text"], 20000)
        return len(shown & fetched) >= 0.3 * len(shown)

    # ── checking ──

    def due(self, now: float) -> list[dict[str, Any]]:
        return sorted(
            (
                w
                for w in self.watches()
                if not w["paused"] and not w["done"] and now - w["last"] >= w["every"] * 3600
            ),
            key=lambda w: w["last"],
        )[:PER_TICK]

    async def tick(self) -> None:
        now = time.time()
        watches = self.watches()
        kept = [w for w in watches if not (w["done"] and now - w["last"] > DONE_KEPT)]
        if len(kept) != len(watches):
            self._watches = kept
        for watch in self.due(now):
            await self.check(watch)
        await self.save()
        self.emit()

    async def check(self, watch: dict[str, Any]) -> None:
        seen = await self.look(watch)
        watch["last"] = time.time()
        if seen is None:
            watch["failures"] += 1
            if watch["failures"] >= PAUSE_AFTER:
                watch["paused"] = True
                self._tell(watch, PAUSED, host=watch["host"], n=str(PAUSE_AFTER))
            return
        watch["failures"] = 0
        title = watch["title"] or watch["host"]
        if watch["kind"] == "below":
            price = seen["price"]
            if price is not None:
                watch["price"] = price
                if price < watch["below"]:
                    shown = _amount(price, watch["currency"])
                    limit = _amount(watch["below"], watch["currency"])
                    watch["done"], watch["result"] = True, shown
                    self._tell(watch, FOUND_BELOW, title=title, price=shown, below=limit)
        elif watch["kind"] == "stock":
            if seen["stock"] is True and watch["stock"] is not True:
                watch["done"], watch["result"] = True, "in stock"
                self._tell(watch, FOUND_STOCK, title=title)
            elif seen["stock"] is not None:
                watch["stock"] = seen["stock"]
        else:
            moved, came = changed(watch["lines"], seen["lines"])
            if moved and time.time() - watch["told"] >= CHANGE_QUIET:
                watch["lines"] = [fingerprint(line) for line in seen["lines"]]
                snippet = came[0][:120] if came else ""
                watch["told"] = time.time()
                self._tell(watch, FOUND_CHANGE, title=title, what=snippet or watch["host"])
            elif moved:
                pass  # told just now: the next look compares with the page as it was then
            else:
                watch["lines"] = [fingerprint(line) for line in seen["lines"]]

    def _tell(self, watch: dict[str, Any], template: str, **values: str) -> None:
        language = self.hub.language
        text = lang.tr(template, language, **values)
        self.hub.notify(
            Alert(
                f"watch:{watch['id']}:{int(time.time())}",
                "watch",
                lang.translate(TITLE, language),
                text,
                note=f"a page watch on {watch['host']} (list_watches has it)",
            )
        )

    async def loop(self) -> None:
        await asyncio.sleep(60)  # after startup
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("page watcher: a round of checks failed")
            await asyncio.sleep(TICK_SECONDS)

    # ── stopping ──

    async def stop(self, watch_id: str, asked: bool = True) -> dict[str, Any]:
        found = [w for w in self.watches() if w["id"] == watch_id or watch_id == "all"]
        if not found:
            return _text(f"There's no watch {watch_id} (list_watches shows them).", True)
        if asked and not await self._allowed(
            "Stop watching?" if watch_id == "all" else f"Stop watching {found[0]['host']}?",
            "\n".join(w["url"] for w in found[:10]),
            "Can I stop watching those pages?"
            if watch_id == "all"
            else f"Can I stop watching {found[0]['host']}?",
            STOP_ASKED,
        ):
            return _text("The user said no. Keep watching.", True)
        gone = {w["id"] for w in found}
        self._watches = [w for w in self.watches() if w["id"] not in gone]
        await self.save()
        self.emit()
        return _text(f"Stopped {len(gone)} watch{'es' if len(gone) != 1 else ''}.")

    def listed(self) -> dict[str, Any]:
        if not self.watches():
            return _text("No page watches.")
        lines = []
        for w in self.watches():
            what = {
                "change": "any change",
                "below": f"price below {w['below']:g} {w['currency']}".strip(),
                "stock": "back in stock",
            }[w["kind"]]
            state = "done" if w["done"] else "paused" if w["paused"] else f"every {w['every']:g} h"
            lines.append(f"- {w['id']}: {w['title'] or w['host']} — {w['url']} ({what}; {state})")
        from ...browser_agent import untrusted

        return _text(untrusted("\n".join(lines)))

    # ── the window ──

    def on_list(self, _msg: dict[str, Any]) -> None:
        self.emit()

    def on_stop(self, msg: dict[str, Any]) -> None:
        """browser_ai_watch_stop: the owner's own Remove in Settings (no card)."""
        self.hub._spawn(self.stop(str(msg.get("id") or ""), asked=False))

    # ── Claude's tools ──

    def tools(self) -> list:
        watchers = self

        @tool(
            "watch_page",
            "Watch a page and tell the user when it changes (kind change), when its price drops "
            'below an amount (kind below, below: the amount, like 39.99 or "$39.99"; '
            "price_now: the price as the page shows it now, if you've read it), or when it's "
            "back in stock (kind stock). url: the page (default: the page on show in the "
            "built-in browser); every_hours: how often to look (0.5 to 24, default 1).",
            {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "url": {"type": "string"},
                    "below": {"type": ["number", "string"]},
                    "price_now": {"type": ["number", "string"]},
                    "every_hours": {"type": "number"},
                },
                "required": ["kind"],
            },
        )
        async def watch_page(args):
            return await watchers.make(args or {})

        @tool("list_watches", "The page watches: what each watches, and whether it's done.", {})
        async def list_watches(_args):
            return watchers.listed()

        @tool(
            "stop_watch",
            'Stop a page watch. id: from list_watches, or "all".',
            {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        )
        async def stop_watch(args):
            return await watchers.stop(str((args or {}).get("id") or ""))

        return [watch_page, list_watches, stop_watch]
