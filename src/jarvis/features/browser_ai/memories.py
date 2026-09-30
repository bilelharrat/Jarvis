"""Browser memories, opt-in (Settings › Browser, off until the owner turns it on): pages the
owner spends a minute on in the built-in browser are kept as readable text in the second
brain, as its Browsing source, so "that article about soup I read last week" can be found
and asked about later.

- The window counts the time a web page is on show in the dock of a window in view, and
  says so once a page has had a minute (browser_ai_dwell). The page's article is then read
  in its tab (page-ai-preload.js extract: the text a reader view shows, text hidden from
  view left out) and kept, one small file per page, in a folder beside the brain's index.
- Never kept: sensitive sites (banks, email, health: sites.py, the owner's list), this Mac's
  own pages (localhost), the Research Center, pages with little text; and nothing that looks
  like a secret in an address (tokens, codes and keys in its query are dropped).
- The brain's rebuild reads the folder (collect_browsing, through jarvis.brain_sources: the
  switch is its "browsing" source) a few minutes after new pages come, with the rest of
  the recent sources every four hours, and after a full rebuild. What's kept has
  passwords, keys and card numbers blanked out, as every source's has.
- The owner sees the latest in Settings › Browser, and forgets one or all there
  (browser_ai_memories, browser_ai_memory_forget); a page forgotten leaves no copy.

Cost policy: no model calls; the text is the page's own.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from ... import jsonstore
from ... import prefs as prefs_module
from ...browser_agent import loopback
from ...knowledge import Note
from ...textclean import clean_text
from .sites import Sites, host_of

log = logging.getLogger("jarvis")

PREF = "browser_memories"  # the Browsing source's switch (brain_sources.SWITCHES)
SOURCE = "browsing"
TEXT_MAX = 12_000  # of a page's text kept
MIN_TEXT = 200  # less than this is no page worth remembering (a search box, a login)
MAX_PAGES = 500  # the oldest go first
REFRESH_DELAY = 5 * 60.0  # seconds from a new page to the brain's refresh of this source
EXTRACT_SECONDS = 8.0
LIST_MAX = 12  # the latest pages Settings shows
# A query parameter that can carry a secret: dropped from what's kept of an address.
_SECRET_PARAM = re.compile(
    r"token|auth|session|sid|pass|pwd|secret|key|code|otp|sig|jwt|access|refresh|ticket|nonce|"
    r"state|reset|login|email|phone",
    re.IGNORECASE,
)

prefs_module.register_feature_pref(PREF, False)


def folder_for(store: Any) -> Path:
    """Where the pages are kept: a folder beside the brain's index (the rebuild finds it
    from the index's path, as it finds the other sources' files)."""
    return Path(store).with_name(SOURCE)


def clean_url(url: Any) -> str:
    """A page's address as it's kept: http(s) only, without its fragment or any query
    parameter that could carry a secret."""
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return ""
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not _SECRET_PARAM.search(k)
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))[:2000]


def _file(folder: Path, url: str) -> Path:
    return folder / f"{hashlib.sha256(url.encode()).hexdigest()[:24]}.json"


def _page(raw: Any) -> dict[str, Any] | None:
    """A kept page as read back, or None for a file that isn't one."""
    if not isinstance(raw, dict) or not isinstance(raw.get("url"), str) or not raw["url"]:
        return None
    try:
        last = float(raw.get("last") or 0)
        first = float(raw.get("first") or last)
        visits = max(1, int(raw.get("visits") or 1))
    except (TypeError, ValueError, OverflowError):
        return None
    return {
        "url": raw["url"][:2000],
        "title": str(raw.get("title") or "")[:300],
        "site": str(raw.get("site") or "")[:120],
        "text": str(raw.get("text") or "")[:TEXT_MAX],
        "first": first,
        "last": last,
        "visits": visits,
    }


def read_pages(folder: Path) -> list[dict[str, Any]]:
    """Every kept page, the latest first. A damaged file is skipped, never fatal."""
    pages = []
    try:
        files = list(folder.glob("*.json"))
    except OSError:
        return []
    for path in files:
        try:
            page = _page(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
        if page is not None:
            pages.append(page)
    pages.sort(key=lambda p: p["last"], reverse=True)
    return pages


def collect_browsing(folder: Path) -> list[Note]:
    """The Browsing source's notes, for the brain's rebuild (brain_sources.extra_sources)."""
    notes = []
    for page in read_pages(folder):
        title = page["title"] or page["url"]
        stamp = (
            datetime.fromtimestamp(page["last"]).isoformat(timespec="seconds")
            if page["last"]
            else ""
        )
        notes.append(
            Note(
                id=f"{SOURCE}:{hashlib.sha256(page['url'].encode()).hexdigest()[:24]}",
                source=SOURCE,
                title=title,
                text=f"{title}\n{page['site'] or host_of(page['url'])}\n{page['url']}\n\n{page['text']}",
                ref=page["url"],
                group=page["site"] or host_of(page["url"]),
                modified=stamp,
            )
        )
    return notes


class Memories:
    def __init__(self, hub: Any, bridge: Any, sites: Sites) -> None:
        self.hub = hub
        self.bridge = bridge
        self.sites = sites
        self._refresh_task: asyncio.Task | None = None

    @property
    def folder(self) -> Path:
        return folder_for(self.hub.kb.store)

    def on(self) -> bool:
        return bool(self.hub.prefs.feature(PREF))

    def keeps(self, url: str) -> bool:
        """Whether a page may be kept: a web page that isn't sensitive or this Mac's."""
        host = host_of(url)
        return bool(host) and not loopback(url) and self.sites.sensitive(host) is None

    def command(self, handler: Any) -> Any:
        """A window command that runs in the background: its reads of the page are answered
        over the same connection, which mustn't wait on it."""
        return lambda msg: self.hub._spawn(handler(msg))

    async def on_dwell(self, msg: dict[str, Any]) -> None:
        """browser_ai_dwell: a page has had a minute on show."""
        url = clean_url(msg.get("url"))
        if not self.on() or not url or not self.keeps(url) or msg.get("research"):
            return
        args: dict[str, Any] = {"limit": TEXT_MAX}
        if isinstance(msg.get("tab"), int):
            args["tab"] = msg["tab"]
        seen = await self.bridge.call("extract", args, timeout=EXTRACT_SECONDS)
        if seen.get("ok") is False or seen.get("error") or clean_url(seen.get("url")) != url:
            return  # the page moved on, or it couldn't be read
        text = clean_text(str(seen.get("text") or ""))[:TEXT_MAX].strip()
        if len(text) < MIN_TEXT or not self.on():
            return
        page = {
            "url": url,
            "title": clean_text(str(seen.get("title") or ""))[:300],
            "site": clean_text(str(seen.get("site") or ""))[:120] or host_of(url),
            "text": text,
        }
        await asyncio.to_thread(self._keep, page)
        self._refresh_soon()
        self.emit()

    def _keep(self, page: dict[str, Any]) -> None:
        folder = self.folder
        path = _file(folder, page["url"])
        now = time.time()
        before = None
        try:
            before = _page(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        page = {
            **page,
            "first": before["first"] if before else now,
            "last": now,
            "visits": (before["visits"] + 1) if before else 1,
        }
        jsonstore.save_json(path, page, indent=None, backup=False)
        pages = read_pages(folder)
        for old in pages[MAX_PAGES:]:  # the oldest past the cap
            _file(folder, old["url"]).unlink(missing_ok=True)

    def _refresh_soon(self) -> None:
        """The brain reads the new pages a few minutes from now (one refresh for a run of
        pages, not one each)."""
        if self._refresh_task is not None and not self._refresh_task.done():
            return
        self._refresh_task = self.hub._spawn(self._refresh_later())

    async def _refresh_later(self) -> None:
        await asyncio.sleep(REFRESH_DELAY)
        if self.on():
            await self.refresh()

    async def refresh(self) -> None:
        await self.hub.rebuild_brain(only={SOURCE})

    # ── the window ──

    def payload(self) -> dict[str, Any]:
        pages = read_pages(self.folder)
        return {
            "on": self.on(),
            "count": len(pages),
            "recent": [
                {k: p[k] for k in ("url", "title", "site", "last")} for p in pages[:LIST_MAX]
            ],
        }

    def emit(self) -> None:
        self.hub.emit("browser_ai_memories", **self.payload())

    async def on_list(self, _msg: dict[str, Any]) -> None:
        self.hub.emit("browser_ai_memories", **await asyncio.to_thread(self.payload))

    async def on_forget(self, msg: dict[str, Any]) -> None:
        """browser_ai_memory_forget: one page (url), or all of them (all: true); gone from
        the brain at once."""
        folder = self.folder
        if msg.get("all") is True:
            await asyncio.to_thread(self._forget_all, folder)
        else:
            url = clean_url(msg.get("url"))
            if not url:
                return
            await asyncio.to_thread(lambda: _file(folder, url).unlink(missing_ok=True))
        self.hub._spawn(self.refresh())
        self.hub.emit("browser_ai_memories", **await asyncio.to_thread(self.payload))

    @staticmethod
    def _forget_all(folder: Path) -> None:
        try:
            files = list(folder.glob("*.json"))
        except OSError:
            return
        for path in files:
            path.unlink(missing_ok=True)
