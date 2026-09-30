"""The browser desk: what the browser-ai feature keeps for one hub, and what it registers."""

from __future__ import annotations

from typing import Any

from ... import lang
from . import tabsread
from .bridge import Bridge
from .flags import Flags
from .handback import HandBack
from .memories import Memories
from .menuask import MenuAsk
from .pagectx import PageContext
from .pagevoice import PageVoice
from .reader import Reader
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
        self.handback = HandBack(hub, self.bridge)
        self.voice = PageVoice(hub, self.bridge, self.page, busy=self.handback.busy)
        self.watch = Watch(hub, self.sites, self.page)
        self.watch.then.append(self.handback.before)
        self.site_settings = SiteSettings(hub, self.sites)
        self.memories = Memories(hub, self.bridge, self.sites)
        self.menu = MenuAsk(hub, self.page, self.memories, self.sites)
        self.tabs = tabsread.TabsReader(hub, self.bridge, self.sites)
        self.reader = Reader(hub, self.bridge, self.page)

    def install(self) -> None:
        hub = self.hub
        lang.add_texts(TEXTS)
        hub.add_browser_check(self.watch.check)
        hub.add_browser_result(self.flags.on_result)
        hub.add_browser_result(self.watch.on_result)
        hub.add_browser_result(self.handback.on_result)
        hub.add_request_context(self.page.context)
        hub.add_request_context(self.handback.context)
        hub.register_instant(self.reader.instant)  # (before the page's: "continue reading")
        hub.register_instant(self.voice.instant)
        hub.add_event_sink(("turn",), self.reader.on_turn)
        hub.register_command("browser_ai_result", self.bridge.on_result)
        hub.register_command("browser_ai_page", self.page.on_page)
        hub.register_command("browser_ai_sites", self.site_settings.on_list)
        hub.register_command("browser_ai_site", self.site_settings.on_change)
        memories = self.memories
        hub.register_command("browser_ai_dwell", memories.command(memories.on_dwell))
        hub.register_command("browser_ai_memories", memories.command(memories.on_list))
        hub.register_command("browser_ai_memory_forget", memories.command(memories.on_forget))
        hub.register_command("browser_ai_ask", self.menu.command)
        hub.register_command("browser_ai_carry_on", self.handback.on_carry_on)
        hub.register_command("browser_ai_handback_cancel", self.handback.on_cancel)
        hub.register_command("browser_ai_read", self.reader.on_command)
        hub.register_server(
            tabsread.SERVER,
            self.tabs.build,
            prompt=tabsread.PROMPT,
            labels=tabsread.LABELS,
            web=[tabsread.TOOL],
        )
        # Before Jarvis Code's (code_voice), which takes the key for a session in front.
        hub.register_command("whats_this", self.page.on_whats_this)
