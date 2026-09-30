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
- Ask Jarvis in the page's own menu (menuask.py; the app's browser-ai.js adds it): explain,
  summarize, translate between English and Chinese or draft a reply to a selection,
  summarize a link's page, explain a picture, and save any of them to the second brain.
  Beside it, Translate puts a selection into English or Chinese over the page at once
  (translate.py: the utility model, no conversation turn; browser_ai_translation).
- Questions across the open tabs (tabsread.py): the read_tabs tool on the browser_ai
  server reads up to six open tabs at once, as the page's words.
- Reader mode (reader.py; the view is the window's): the page's article in place of the
  page, from the address bar's Reader button or "reader mode" / "read this to me" said, read
  aloud in JARVIS's voice through the speech queue a paragraph at a time, with pause,
  resume, skip, back and again (buttons, or said); a new request or "stop" pauses it.
- Page watchers (watchers.py): watch_page tells the owner when a page changes, its price
  drops below an amount or it's back in stock; looked at about every hour (fetched with
  httpx, or in a tab behind for a page that builds itself), at most twenty, on a loop;
  listed and removed in Settings › Browser.
- Hand back (handback.py): at a captcha (never touched), a password, card details, a
  one-time code or a sign-in wall, JARVIS stops and it's the owner's turn: a "Your turn"
  banner over the page, and nothing acts on that tab until they say "carry on" (or press
  it); the page is looked at before each action and after each landing.
- Record and replay (macros.py): the address bar's Record button records a task in a tab
  (clicks, typing, choices and Enter, as page-ai-preload.js tells them: never a password, a
  card or a code), named and edited before it's saved; run_macro does it again by name,
  each step through the turn gate and the browser's guards (watch mode, the hand back, the
  purchase guard), stopping safely, and saying where, when a page isn't as it was recorded
  or it's the owner's turn. Listed, run and removed in Settings › Browser.

Window commands: browser_ai_page, browser_ai_result, browser_ai_sites, browser_ai_site,
browser_ai_dwell, browser_ai_memories, browser_ai_memory_forget, browser_ai_ask,
browser_ai_carry_on, browser_ai_handback_cancel, browser_ai_read, browser_ai_watches,
browser_ai_watch_stop, browser_ai_record, browser_ai_record_step, browser_ai_macro_save,
browser_ai_macro_delete, browser_ai_macros, browser_ai_macro_run, whats_this (before
Jarvis Code's).
Tool server: browser_ai (read_tabs, watch_page, list_watches, stop_watch, run_macro,
list_macros). Loop: browser_watches. Files: browser_watches.json and browser_macros.json
(hub.feature_path); the remembered pages in a browsing/ folder beside the brain's index.
Events: browser_ai_flag, browser_ai_cmd, browser_ai_sites, browser_ai_memories,
browser_ai_handback, browser_ai_reading, browser_ai_watches, browser_ai_recording,
browser_ai_macros, browser_ai_translation.
Settings (prefs.features): browser_sites_added, browser_sites_removed, browser_site_rules,
browser_memories (the brain's browsing source).

Everything here is registered through the feature kit; install() only registers.

Cost policy (Claude): nothing here calls a model on its own, but for the menu's Translate:
one tool-less utility-model call per click (Haiku by default), at most 60 a day. A page's text rides along only
inside a request the owner made (at most 12,000 characters of it); ⌥⇧Space and each Ask
Jarvis question from the page's menu are one ordinary turn, asked by the owner's own key
press or click; read_tabs is read in the turn that called it; run_macro runs in the turn
that called it (Settings' Run asks for one ordinary turn, in the owner's words).
"""

from __future__ import annotations

from typing import Any


def desk_for(hub: Any) -> Any:
    """The hub's browser desk (tests reach it here)."""
    return getattr(hub, "browser_ai_desk", None)


def install(hub: Any) -> None:
    from .desk import BrowserAi

    desk = BrowserAi(hub)
    # Kept on the hub, never in a map of this module's: one keyed weakly by the hub still
    # holds its desk, the desk holds the hub, and no hub would ever be freed.
    hub.browser_ai_desk = desk
    desk.install()
