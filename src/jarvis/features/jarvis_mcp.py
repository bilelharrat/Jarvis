"""JARVIS for other apps: the endpoint (jarvis.mcp_endpoint) behind `jarvis mcp`
(jarvis.mcp_bridge), so Claude Code and Claude Desktop can use the owner's second brain,
memory and calendar, and send them heads-ups; and its part of Settings.

Settings (prefs.features):
- mcp_enabled: off until the owner turns it on; while off there's no socket at all.
- mcp_ask: on: each app session asks once, on a card said aloud, before its first call works.

Window commands: mcp_state, mcp_enable {on}, mcp_ask {on}, each answered with a "jarvis_mcp"
event: {enabled, ask, running, error, sessions, recent, tools, code_command, desktop_json}.
A loop (it runs only with the app) starts the endpoint when it's on, and stops it, removing
its socket and token, when the app quits.

Cost: no model calls: every read is local, and a heads-up is JARVIS's own.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shlex
import sys
from pathlib import Path
from typing import Any

from .. import lang
from ..mcp_endpoint import ASK_DETAIL, Endpoint
from ..prefs import register_feature_pref

register_feature_pref("mcp_enabled", False)
register_feature_pref("mcp_ask", True)

ZH = {
    "Let {app} use your second brain, memory and calendar?": "允许 {app} 使用你的第二大脑、记忆和日历吗？",
    ASK_DETAIL: "在它关闭之前，它可以搜索你的第二大脑、读取你的笔记、查看我记住的关于你的事、读取你的日历，并给你发提醒。它读到的内容会发给那个应用，以及它背后的模型。",
}
lang.add_texts(ZH)


def jarvis_command() -> list[str]:
    """How another app runs `jarvis mcp` on this Mac: the jarvis script beside this Python
    (JARVIS's own environment), else this Python running JARVIS's command line."""
    here = Path(sys.executable).parent / "jarvis"
    if here.is_file():
        return [str(here), "mcp"]
    return [sys.executable, "-c", "from jarvis.cli import main; main()", "mcp"]


def snippets() -> dict[str, str]:
    command = jarvis_command()
    return {
        "code_command": "claude mcp add --scope user jarvis -- " + shlex.join(command),
        "desktop_json": json.dumps(
            {"mcpServers": {"jarvis": {"command": command[0], "args": command[1:]}}}, indent=2
        ),
    }


class JarvisMcp:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.endpoint = Endpoint(hub, hub.feature_path("mcp"))
        self.endpoint.on_change = self._changed
        self.wake = asyncio.Event()

    def payload(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.hub.prefs.feature("mcp_enabled")),
            "ask": bool(self.hub.prefs.feature("mcp_ask")),
            **self.endpoint.public(),
            **snippets(),
        }

    def publish(self) -> None:
        self.hub.emit("jarvis_mcp", **self.payload())

    def _changed(self) -> None:
        self.publish()

    async def apply(self) -> None:
        """The endpoint running exactly when the setting says so."""
        want = bool(self.hub.prefs.feature("mcp_enabled"))
        if want and not self.endpoint.running:
            await self.endpoint.start()
        elif not want and self.endpoint.running:
            await self.endpoint.stop()

    async def state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    async def enable(self, msg: dict[str, Any]) -> None:
        self.hub.set_feature_prefs({"mcp_enabled": bool(msg.get("on"))})
        await self.apply()
        self.publish()

    async def ask(self, msg: dict[str, Any]) -> None:
        self.hub.set_feature_prefs({"mcp_ask": bool(msg.get("on"))})
        self.publish()

    async def keep(self) -> None:
        """With the app: on when the setting's on (checked each minute too), off at quit."""
        try:
            while True:
                await self.apply()
                self.wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.wake.wait(), 60)
        finally:
            await self.endpoint.stop()


def install(hub: Any) -> None:
    mcp = JarvisMcp(hub)
    hub.jarvis_mcp = mcp
    hub.register_command("mcp_state", mcp.state)
    hub.register_command("mcp_enable", mcp.enable)
    hub.register_command("mcp_ask", mcp.ask)
    hub.register_loop("jarvis_mcp", mcp.keep)
