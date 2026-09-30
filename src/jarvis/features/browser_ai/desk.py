"""The browser desk: what the browser-ai feature keeps for one hub, and what it registers."""

from __future__ import annotations

from typing import Any

from .flags import Flags


class BrowserAi:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.flags = Flags(hub)

    def install(self) -> None:
        self.hub.add_browser_result(self.flags.on_result)
