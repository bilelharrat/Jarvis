"""The search engine the built-in browser's address bar uses (Settings › Browser, kept by the
app in its own file): words JARVIS or an Eden Code session opens as a search go to that
engine's site, so the turn gate and the approval cards weigh that site, not always Google's
(browser_gate.SEARCH_HOST).

Window command: {"type": "browser_engine", "engine": "duckduckgo"}, sent when the window
starts and when the owner picks another engine. No model calls.
"""

from __future__ import annotations

from typing import Any

from .. import browser_gate

# app/url-input.js's ENGINES, by the host their searches go to.
HOSTS = {
    "google": "www.google.com",
    "duckduckgo": "duckduckgo.com",
    "bing": "www.bing.com",
    "brave": "search.brave.com",
    "kagi": "kagi.com",
}


def install(hub: Any) -> None:
    def on_engine(msg: dict[str, Any]) -> None:
        host = HOSTS.get(str(msg.get("engine") or ""))
        if host:
            browser_gate.SEARCH_HOST = host

    hub.register_command("browser_engine", on_engine)
