"""The browser desk: what the browser-ai feature keeps for one hub, and what it registers."""

from __future__ import annotations

from typing import Any

from ... import lang
from .bridge import Bridge
from .flags import Flags
from .pagectx import PageContext
from .pagevoice import PageVoice
from .sites import Sites
from .texts import TEXTS


class BrowserAi:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.sites = Sites(lambda: hub.prefs)
        self.bridge = Bridge(hub)
        self.flags = Flags(hub)
        self.page = PageContext(hub, self.bridge, self.sites)
        self.voice = PageVoice(hub, self.bridge, self.page)

    def install(self) -> None:
        hub = self.hub
        lang.add_texts(TEXTS)
        hub.add_browser_result(self.flags.on_result)
        hub.add_request_context(self.page.context)
        hub.register_instant(self.voice.instant)
        hub.register_command("browser_ai_result", self.bridge.on_result)
        hub.register_command("browser_ai_page", self.page.on_page)
        # Before Jarvis Code's (code_voice), which takes the key for a session in front.
        hub.register_command("whats_this", self.page.on_whats_this)
