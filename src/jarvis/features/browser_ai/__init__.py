"""AI-native browsing and browser safety for the built-in browser.

- Hidden text (flags.py, aitext.py): text no one can see is left out of reads and snapshots
  (app/page-preload.js, app/browser-agent-core.js); page words written to an AI are flagged
  to Claude as the page's own and told to the owner.
- The page as part of a request (pagectx.py): the site on show goes with every request; its
  address, title, selection and text with a request about it; ⌥⇧Space with the browser in
  front asks about the page and a picture of it. The window says which page is on show
  (browser_ai_page) and answers the feature's calls into the browser (bridge.py, through
  web/features/browser_ai.js and app/features/browser-ai.js, whose page-ai-preload.js reads
  pages the way a reader view does).
- Page commands (pagevoice.py): scroll, top and bottom, back and forward, zoom, find, a new
  tab, close the tab, bookmark and reload, said in English or Chinese, done at once without
  Claude while a web page is on show in the dock of the window in front (an instant handler;
  the window's browser_ai.js works the dock's own controls: page_ui).
- Sensitive sites (sites.py) and watch mode (watch.py): on banks, email and health sites
  (the owner's list, Settings › Browser) the browser acts only while that tab is on show for
  the owner to watch, and what JARVIS reads there counts as their private data; each site
  can have the owner's rule: always, ask first, or never (a browser check, weighing the tab
  the action lands in; sitesettings.py changes them, from the window only).
- Browser memories (memories.py), opt-in: a page on show for a minute is kept as text for
  the second brain's Browsing source (brain_sources reads it; never a sensitive site or
  this Mac's own pages), listed and forgotten in Settings › Browser.

Window commands: browser_ai_page, browser_ai_result, browser_ai_sites, browser_ai_site,
browser_ai_dwell, browser_ai_memories, browser_ai_memory_forget, whats_this (before Jarvis
Code's).
Events: browser_ai_flag, browser_ai_cmd, browser_ai_sites, browser_ai_memories.
Settings (prefs.features): browser_sites_added, browser_sites_removed, browser_site_rules,
browser_memories (the brain's browsing source).

Everything here is registered through the feature kit; install() only registers.

Cost policy (Claude): nothing here calls a model on its own. A page's text rides along only
inside a request the owner made (at most 12,000 characters of it), and ⌥⇧Space asks one
ordinary turn, as the What's-this key always has.
"""

from __future__ import annotations

import weakref
from typing import Any

_DESKS: weakref.WeakKeyDictionary[Any, Any] = weakref.WeakKeyDictionary()


def desk_for(hub: Any) -> Any:
    """The hub's browser desk (tests reach it here)."""
    return _DESKS.get(hub)


def install(hub: Any) -> None:
    from .desk import BrowserAi

    desk = BrowserAi(hub)
    _DESKS[hub] = desk
    desk.install()
