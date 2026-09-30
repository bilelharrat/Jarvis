"""The browser desk: what the browser-ai feature keeps for one hub, and what it registers."""

from __future__ import annotations

from typing import Any

from ... import lang
from .bridge import Bridge
from .flags import Flags
from .pagectx import PageContext
from .pagevoice import PageVoice
from .sites import Sites
from .sitesettings import SiteSettings
from .texts import TEXTS
from .watch import Watch


class BrowserAi:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.sites = Sites(lambda: hub.prefs)
        self.bridge = Bridge(hub)
        self.flags = Flags(hub)
        self.page = PageContext(hub, self.bridge, self.sites)
        self.voice = PageVoice(hub, self.bridge, self.page)
        self.watch = Watch(hub, self.sites, self.page)
        self.site_settings = SiteSettings(hub, self.sites)

    def install(self) -> None:
        hub = self.hub
        lang.add_texts(TEXTS)
        hub.add_browser_check(self.watch.check)
        hub.add_browser_result(self.flags.on_result)
        hub.add_browser_result(self.watch.on_result)
        hub.add_request_context(self.page.context)
        hub.register_instant(self.voice.instant)
        hub.register_command("browser_ai_result", self.bridge.on_result)
        hub.register_command("browser_ai_page", self.page.on_page)
        hub.register_command("browser_ai_sites", self.site_settings.on_list)
        hub.register_command("browser_ai_site", self.site_settings.on_change)
        # Before Jarvis Code's (code_voice), which takes the key for a session in front.
        hub.register_command("whats_this", self.page.on_whats_this)
