"""The browser desk: what the browser-ai feature keeps for one hub, and what it registers."""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import create_sdk_mcp_server

from ... import lang
from . import macros, tabsread, watchers
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
        self.watchers = watchers.Watchers(hub, self.bridge, self.sites, self.page)
        self.macros = macros.Macros(hub, self.bridge, self.page)

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
        # The browser_ai tools: read_tabs, the page watchers' and the recorded tasks'.
        hub.register_server(
            tabsread.SERVER,
            self.server,
            prompt=tabsread.PROMPT + watchers.PROMPT + macros.PROMPT,
            labels={**tabsread.LABELS, **watchers.LABELS, **macros.LABELS},
            web=[tabsread.TOOL, "watch_page", "list_watches"],  # pages' words (titles)
            quiet=["stop_watch"],
        )
        hub.register_loop("browser_watches", self.watchers.loop)
        hub.register_command("browser_ai_watches", self.watchers.on_list)
        hub.register_command("browser_ai_watch_stop", self.watchers.on_stop)
        tasks = self.macros  # record and replay
        hub.register_command("browser_ai_record", tasks.command(tasks.on_record))
        hub.register_command("browser_ai_record_step", tasks.on_step)
        hub.register_command("browser_ai_macro_save", tasks.command(tasks.on_save))
        hub.register_command("browser_ai_macro_delete", tasks.command(tasks.on_delete))
        hub.register_command("browser_ai_macros", tasks.on_list)
        hub.register_command("browser_ai_macro_run", tasks.on_run)
        # Before Eden Code's (code_voice), which takes the key for a session in front.
        hub.register_command("whats_this", self.page.on_whats_this)

    def server(self) -> Any:
        return create_sdk_mcp_server(
            name=tabsread.SERVER,
            version="0.1.0",
            tools=[self.tabs.tool(), *self.watchers.tools(), *self.macros.tools()],
        )
