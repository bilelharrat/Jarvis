"""JARVIS for other apps: the endpoint (jarvis.mcp_endpoint) behind `jarvis mcp`
(jarvis.mcp_bridge), so Claude Code, Claude Desktop and Eden can use the owner's second
brain, memory, calendar and email (an email goes only on the owner's yes), and send them
heads-ups; and its part of Settings.

Settings (prefs.features):
- mcp_enabled: off until the owner turns it on; while off there's no socket at all.
- mcp_ask: on: each app session asks once, on a card said aloud, before its first call works.
- mcp_trusted: the apps the owner chose "Always allow" for on that card: never asked again.

Connecting: one click each. Claude Code through its own CLI (`claude mcp add --scope user
jarvis -- <jarvis> mcp`, no shell); Claude Desktop by adding just the "jarvis" entry to its
claude_desktop_config.json (every other key kept, written whole or not at all, a one-time
.bak beside it; a file that isn't JSON is left alone). Disconnecting takes out only that entry.

Window commands: mcp_state, mcp_enable {on}, mcp_ask {on}, mcp_connect {app: code|desktop},
mcp_disconnect {app}, mcp_forget {app: a remembered app's name}, each answered with a
"jarvis_mcp" event: {enabled, ask, running, error, sessions, recent, trusted, tools, apps,
code_command, desktop_json}; apps: {code, desktop} -> {status: connected | other | off |
missing, message}.
A loop (it runs only with the app) starts the endpoint when it's on, and stops it, removing
its socket and token, when the app quits.

Cost: no model calls: every read is local, and a heads-up is JARVIS's own.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from .. import codemcp, lang
from ..mcp_endpoint import ASK_DETAIL, ASK_QUESTION, TRUSTED_APPS, Endpoint, client_name
from ..prefs import register_feature_pref


def _app_names(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    names = [client_name(v) for v in value if isinstance(v, str) and v.strip()]
    return list(dict.fromkeys(names))[-TRUSTED_APPS:]


register_feature_pref("mcp_enabled", False)
register_feature_pref("mcp_ask", True)
register_feature_pref("mcp_trusted", [], _app_names)

NAME = "jarvis"  # the server's name in each app
DESKTOP_APPS = (Path("/Applications/Claude.app"), Path.home() / "Applications" / "Claude.app")
NOT_JSON = (
    "Claude Desktop's settings file isn't valid JSON, so Jarvis left it alone. "
    "Fix it in Claude Desktop (Settings › Developer › Edit Config), or set it up by hand."
)

ZH = {
    ASK_QUESTION: "允许 {app} 使用你的第二大脑、记忆、日历和邮件吗？",
    "Always allow": "始终允许",
    "Allow this time": "这次允许",
    NOT_JSON: "Claude Desktop 的设置文件不是有效的 JSON，所以 Jarvis 没有改动它。请在 Claude Desktop 中修正（设置 › 开发者 › 编辑配置），或者手动设置。",
    ASK_DETAIL: "在它关闭之前，它可以搜索你的第二大脑、读取你的笔记、查看我记住的关于你的事、读取你的日历和邮件、打开邮件草稿，并给你发提醒。它想发送的邮件会先给你看，只有你同意才会发出。它读到的内容会发给那个应用，以及它背后的模型。",
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


def desktop_config() -> Path:
    return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"


def server_entry() -> dict[str, Any]:
    command = jarvis_command()
    return {"command": command[0], "args": command[1:]}


def read_desktop(path: Path) -> dict[str, Any] | None:
    """Claude Desktop's settings as they are: {} when there's no file yet, None when it isn't
    a JSON object (or its mcpServers isn't one), so nothing may write over it."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError):
        return None
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        return None
    return data


def write_desktop(path: Path, entry: dict[str, Any] | None) -> str:
    """Put Jarvis's entry in (entry) or take it out (None), keeping everything else: written
    to a temporary file beside it and swapped in, after a one-time copy of the original
    (.bak). What went wrong, or ""."""
    data = read_desktop(path)
    if data is None:
        return NOT_JSON
    servers = dict(data.get("mcpServers") or {})
    if entry is None:
        if NAME not in servers:
            return ""
        servers.pop(NAME)
    else:
        servers[NAME] = entry
    data["mcpServers"] = servers
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        backup = path.with_name(path.name + ".bak")
        if path.exists() and not backup.exists():
            shutil.copy2(path, backup)
        fd, tmp = tempfile.mkstemp(prefix=".jarvis-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                out.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            if path.exists():
                os.chmod(tmp, path.stat().st_mode & 0o777)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except OSError as exc:
        return f"Couldn't save Claude Desktop's settings ({exc.strerror or exc})."
    return ""


def code_entry(state: Path) -> dict[str, Any] | None:
    """Jarvis's user-scope entry in Claude Code's ~/.claude.json (read only: the CLI writes it)."""
    servers = codemcp._read(state).get("mcpServers")
    entry = servers.get(NAME) if isinstance(servers, dict) else None
    return entry if isinstance(entry, dict) else None


class JarvisMcp:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.endpoint = Endpoint(hub, hub.feature_path("mcp"))
        self.endpoint.on_change = self._changed
        self.wake = asyncio.Event()
        # Where each app keeps its settings (tests point these at temp files)
        self.desktop_path = desktop_config()
        self.desktop_apps: tuple[Path, ...] = DESKTOP_APPS
        self.code_state = codemcp.claude_json()
        self.apps: dict[str, dict[str, str]] = {}  # looked at on mcp_state and after a change
        self.messages: dict[str, str] = {}  # what the last connect/disconnect had to say

    def payload(self) -> dict[str, Any]:
        if not self.apps:
            self.look()
        return {
            "enabled": bool(self.hub.prefs.feature("mcp_enabled")),
            "ask": bool(self.hub.prefs.feature("mcp_ask")),
            **self.endpoint.public(),
            "apps": {k: {**v, "message": self.messages.get(k, "")} for k, v in self.apps.items()},
            **snippets(),
        }

    def look(self) -> None:
        """Each app: connected (with this Jarvis), other (a "jarvis" that runs something
        else), off, or missing (not installed)."""
        want = server_entry()
        if codemcp.cli_path() is None:
            code = "missing"
        else:
            found = code_entry(self.code_state)
            code = (
                "off"
                if found is None
                else "connected"
                if (found.get("command") == want["command"] and found.get("args") == want["args"])
                else "other"
            )
        data = read_desktop(self.desktop_path)
        if not self.desktop_path.parent.is_dir() and not any(p.exists() for p in self.desktop_apps):
            desktop = "missing"
        elif data is None:
            desktop = "off"
        else:
            found = (data.get("mcpServers") or {}).get(NAME)
            desktop = "off" if found is None else "connected" if found == want else "other"
        self.apps = {"code": {"status": code}, "desktop": {"status": desktop}}

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
        self.look()
        self.publish()

    async def connect(self, msg: dict[str, Any]) -> None:
        await self._set_up(str(msg.get("app") or ""), True)

    async def disconnect(self, msg: dict[str, Any]) -> None:
        await self._set_up(str(msg.get("app") or ""), False)

    async def _set_up(self, app: str, on: bool) -> None:
        if app == "code":
            self.messages[app] = await self._code(on)
        elif app == "desktop":
            error = write_desktop(self.desktop_path, server_entry() if on else None)
            done = (
                "Restart Claude Desktop to use Jarvis there."
                if on
                else ("Restart Claude Desktop to finish disconnecting.")
            )
            self.messages[app] = error or done
        else:
            return
        self.look()
        self.publish()

    async def _code(self, on: bool) -> str:
        """claude mcp add/remove --scope user jarvis (its own CLI, no shell). One with another
        command is taken out first, so connecting always leaves this Jarvis's."""
        home = Path.home()
        found = code_entry(self.code_state)
        want = server_entry()
        if (
            on
            and found is not None
            and [found.get("command"), found.get("args")]
            == [
                want["command"],
                want["args"],
            ]
        ):
            return "New Claude Code sessions can use Jarvis."
        if found is not None:
            status, out = await codemcp.run_cli(["mcp", "remove", "--scope", "user", NAME], home)
            if status != 0:
                return out or "Claude Code couldn't take Jarvis out."
        if not on:
            return ""
        args = ["mcp", "add", "--scope", "user", NAME, "--", *jarvis_command()]
        status, out = await codemcp.run_cli(args, home)
        if status != 0:
            return out or "Claude Code couldn't add Jarvis."
        return "New Claude Code sessions can use Jarvis."

    async def forget(self, msg: dict[str, Any]) -> None:
        self.endpoint.trust(client_name(msg.get("app")), on=False)
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
    hub.register_command("mcp_connect", mcp.connect)
    hub.register_command("mcp_disconnect", mcp.disconnect)
    hub.register_command("mcp_forget", mcp.forget)
    hub.register_loop("jarvis_mcp", mcp.keep)
