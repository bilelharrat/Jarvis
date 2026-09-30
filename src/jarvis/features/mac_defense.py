"""The Mac's defenses, to ask about and to hear about (the "defense" tool server, a loop,
Settings › Speaking up):

- security_status: the shields (FileVault, the firewall, Gatekeeper, System Integrity
  Protection, Time Machine), the network link, the macOS updates waiting (softwareupdate -l,
  checked at most once a day unless asked), and the programs listening for connections
  (lsof: this user's own programs; others' need an administrator).
- A heads-up when FileVault, the firewall, SIP or Gatekeeper turns off: checked every ten
  minutes and remembered across restarts, so one turned off while JARVIS was closed is said
  at the next check. Settings › Speaking up › Security heads-ups turns them off.
- The morning briefing hears of macOS updates waiting.

What it saw last is read from its file the first time it's needed, never while the hub is
being made.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import defense, jsonstore, lang, prefs
from ..proactive import Alert

log = logging.getLogger("jarvis")

SERVER = "defense"
ALERTS_PREF = "defense_alerts"
CHECK_EVERY = 600
UPDATES_EVERY = timedelta(hours=24)
FIRST_CHECK = 90  # seconds after startup
LABELS = {"security_status": "Checked your Mac's defenses"}
PROMPT = (
    "\n- Security: security_status says whether FileVault, the firewall, Gatekeeper, System "
    "Integrity Protection and Time Machine are on, which macOS updates are waiting, and "
    "which programs are listening for connections. You get a heads-up if a defense turns off."
)
OFF_TEXT = {
    "FileVault": (
        "FileVault is off",
        "FileVault just turned off: this Mac's disk isn't encrypted any more.",
        "FileVault 已关闭",
        "FileVault 刚刚关闭了：这台 Mac 的磁盘不再加密。",
    ),
    "Firewall": (
        "The firewall is off",
        "The firewall just turned off: this Mac takes connections it used to block.",
        "防火墙已关闭",
        "防火墙刚刚关闭了：原本会被拦下的连接现在也能进来。",
    ),
    "SIP": (
        "System Integrity Protection is off",
        "System Integrity Protection is off: macOS's own files aren't protected.",
        "系统完整性保护已关闭",
        "系统完整性保护已关闭：macOS 自身的文件不再受保护。",
    ),
    "Gatekeeper": (
        "Gatekeeper is off",
        "Gatekeeper just turned off: apps from anywhere can open now.",
        "Gatekeeper 已关闭",
        "Gatekeeper 刚刚关闭了：现在任何来源的 app 都能打开。",
    ),
}

prefs.register_feature_pref(ALERTS_PREF, True)


def _text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


class Defense:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.path = hub.feature_path("defense_watch.json")
        self.shields = defense.read_shields
        self.link = defense.read_link
        self.updates = defense.read_updates
        self.listening = defense.read_listening
        self.clock = datetime.now
        self._state: dict[str, Any] | None = None
        self._updating = asyncio.Lock()  # one softwareupdate at a time (the loop, a question)

    @property
    def state(self) -> dict[str, Any]:
        """What it saw last (the shields, the updates and when they were checked)."""
        if self._state is None:
            self._state = self._load()
        return self._state

    def _load(self) -> dict[str, Any]:
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable:
            return {"shields": {}, "updates": [], "updates_at": "", "updates_error": ""}
        shields = data.get("shields") if isinstance(data.get("shields"), dict) else {}
        updates = data.get("updates") if isinstance(data.get("updates"), list) else []
        return {
            "shields": {
                k: v for k, v in shields.items() if k in defense.WATCHED and isinstance(v, bool)
            },
            "updates": [
                u for u in updates if isinstance(u, dict) and isinstance(u.get("title"), str)
            ][:30],
            "updates_at": data.get("updates_at") if isinstance(data.get("updates_at"), str) else "",
            "updates_error": str(data.get("updates_error") or "")[:200],
        }

    def _save(self) -> None:
        try:
            jsonstore.save_json(self.path, self.state)
        except OSError as exc:
            log.warning("defense: couldn't save what it saw (%s)", exc)

    # ── the checks ──

    async def check_shields(self) -> list[str]:
        """Read the shields; a heads-up for each watched one that went from on to off."""
        now = defense.shield_states(await asyncio.to_thread(self.shields))
        off = defense.turned_off(self.state["shields"], now)
        if now and now != {k: self.state["shields"].get(k) for k in now}:
            self.state["shields"] = {**self.state["shields"], **now}
            self._save()
        if off and self.hub.prefs.feature(ALERTS_PREF):
            day = self.clock().date().isoformat()
            zh = lang.is_zh(self.hub.language)
            for name in off:
                title, text, title_zh, text_zh = OFF_TEXT[name]
                self.hub.notify(
                    Alert(
                        f"shield:{name}:{day}",
                        "security",
                        title_zh if zh else title,
                        text_zh if zh else text,
                    )
                )
        return off

    def _updates_stale(self) -> bool:
        try:
            checked = datetime.fromisoformat(self.state["updates_at"])
        except ValueError:
            return True
        return self.clock() - checked > UPDATES_EVERY

    async def check_updates(self, force: bool = False) -> None:
        """Ask softwareupdate, when the last answer is a day old (or now, forced). A check
        already under way is waited for, never run twice."""
        if not (force or self._updates_stale()):
            return
        started = self.state["updates_at"]
        async with self._updating:
            if self.state["updates_at"] != started:
                return  # one that was under way has just answered
            found = await asyncio.to_thread(self.updates)
            self.state["updates_at"] = self.clock().isoformat(timespec="seconds")
            if "updates" in found:
                self.state["updates"], self.state["updates_error"] = found["updates"][:30], ""
            else:
                self.state["updates_error"] = str(found.get("error") or "")[:200]
            self._save()

    async def run(self) -> None:
        await asyncio.sleep(FIRST_CHECK)
        while True:
            try:
                await self.check_shields()
                await self.check_updates()
            except Exception:  # a check that fails never stops the next
                log.exception("defense: a check failed")
            await asyncio.sleep(CHECK_EVERY)

    def briefing(self) -> str:
        updates = self.state["updates"]
        if not updates:
            return ""
        names = ", ".join(
            u["title"] + (" (restarts the Mac)" if u.get("restart") else "") for u in updates[:3]
        )
        return f"macOS updates waiting: {names}."

    # ── the tool ──

    async def status(self, refresh_updates: bool = False) -> dict[str, Any]:
        shields, link, listening = await asyncio.gather(
            asyncio.to_thread(self.shields),
            asyncio.to_thread(self.link),
            asyncio.to_thread(self.listening),
        )
        await self.check_updates(force=refresh_updates)
        lines = ["Defenses:"]
        for s in shields:
            state = "on" if s["on"] else "OFF" if s["on"] is False else "unknown"
            lines.append(f"- {s['name']}: {state} ({s['detail']})")
        kind = link.get("kind") or "Offline"
        lines.append(f"Network: {kind}" + (f" “{link['name']}”" if link.get("name") else ""))
        at = self.state["updates_at"][:16].replace("T", " ") or "never"
        if self.state["updates"]:
            lines.append(f"macOS updates waiting (checked {at}):")
            for u in self.state["updates"][:10]:
                bits = [u["title"]]
                if u.get("version"):
                    bits.append(f"version {u['version']}")
                if u.get("restart"):
                    bits.append("restarts the Mac")
                if u.get("recommended"):
                    bits.append("recommended")
                lines.append("- " + ", ".join(bits))
        elif self.state["updates_error"]:
            lines.append(f"macOS updates: couldn't check ({self.state['updates_error']}).")
        else:
            lines.append(f"macOS updates: none waiting (checked {at}).")
        exposed = [p for p in listening if p["exposed"]]
        local = [p for p in listening if not p["exposed"]]
        lines.append(
            f"Listening for connections (this user's programs): {len(exposed)} reachable from "
            f"the network, {len(local)} only from this Mac."
        )
        for p in (exposed + local)[:25]:
            reach = "network" if p["exposed"] else "this Mac only"
            lines.append(f"- {p['command']} (pid {p['pid']}) on port {p['port']}: {reach}")
        return _text("\n".join(lines))


def build_server(desk: Defense):
    @tool(
        "security_status",
        "The Mac's defenses: FileVault, the firewall, Gatekeeper, System Integrity Protection "
        "and Time Machine; the network; macOS updates waiting; programs listening for "
        "connections. refresh_updates: check Apple for updates now (slower; otherwise the "
        "day's check).",
        {"type": "object", "properties": {"refresh_updates": {"type": "boolean"}}},
    )
    async def security_status(args):
        return await desk.status(bool(args.get("refresh_updates")))

    return create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=[security_status])


def install(hub: Any) -> None:
    desk = Defense(hub)
    hub.defense_watch = desk
    hub.register_server(SERVER, lambda: build_server(desk), prompt=PROMPT, labels=LABELS)
    hub.register_loop("defense_watch", desk.run)
    hub.add_briefing_note(desk.briefing)
