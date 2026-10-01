"""The owner's agents (jarvis.agents): "Work Jarvis", "Family Jarvis", each with its own
persona, memory and tools, and the routing that picks one. With none made, nothing changes:
there is only the everyday JARVIS.

- Settings › Agents (web/features/agents.js) makes, edits and removes them, and the orb shows
  the one in use. Window commands: agents_state (-> agents), agent_save {agent}, agent_delete
  {id}, agent_use {id} ("main" for the everyday JARVIS).
- Switching (to an agent, or back): its persona is chosen (its voice, humor and wake word come
  with it), memory reads and learns as that agent (MemoryStore.agent), and its own
  conversation carries on (or a new one starts) with only its tools. Each agent's
  conversation keeps what it has read, for the gates, as the conversation feature's do.
- What picks one: the owner's words ("switch to work", "go back to Jarvis", 切换到工作:
  answered at once, without Claude), a persona's wake word called hands-free ("Friday, …";
  hub.add_wake_sink), and a chat's route (hub.ask's origin from the chat channels). A
  routine's or the briefing's request runs on the agent in use. Never while incognito: that
  conversation stays as it is until the owner leaves it.
- Tools: at each connect (hub.add_connect_hook) every tool server the agent wasn't given is
  taken out of its conversation, with its allowed tools, and a PreToolUse hook refuses any
  call to one all the same. The gates and cards are the same for every agent: this only
  ever takes tools away. Only the owner, in Settings, changes what an agent has: there's no
  tool for Claude to do it, and nothing an agent does reaches another agent's tools.

Claude cost policy: no model is called here. A switch reconnects the conversation (no model
call of its own).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import HookMatcher

from .. import agents, lang, wake
from ..agents import MAIN, AgentStore

log = logging.getLogger("jarvis")

FILE = "agents.json"
WAKE_SECONDS = 30.0  # a name called this long ago still picks the agent for its request
_PREPARED: dict[str, AgentStore] = {}

# Tool servers by what the owner knows them as (the rest are shown by their own names).
LABELS = {
    "mac": "Mac apps and Shortcuts",
    "mac_read": "Reading the Mac",
    "calendar": "Calendar",
    "mail": "Mail",
    "messages": "Messages",
    "reminders": "Reminders",
    "claude": "Jarvis Code and research",
    "jarvis_code_runs": "Jarvis Code runs",
    "brain": "Second brain",
    "browser": "Built-in browser",
    "browser_ai": "Browser assistant",
    "computer": "Mouse and keyboard",
    "jarvis": "Jarvis settings, weather and maps",
    "chats": "Chat apps",
    "phone": "Phone calls",
    "calls": "Calls",
    "pictures": "Making pictures",
    "video_gen": "Making videos",
    "video": "Watching videos",
    "music": "Music",
    "files": "Files on this Mac",
    "file_actions": "Moving and renaming files",
    "documents": "Documents",
    "invoices": "Invoices",
    "transactions": "Purchases",
    "orders": "Orders",
    "stocks": "Stocks",
    "routines": "Routines",
    "background": "Background tasks",
    "research": "Research Center",
    "bsh": "Research Center data",
    "whatsapp": "WhatsApp",
    "delegate": "Conversations held for you",
    "meeting": "Meeting notes",
    "places": "Places",
    "wiki": "Memory wiki",
}
TEXTS = {
    "Switched to {name}.": "已切换到{name}。",
    "You're already talking to {name}.": "你已经在和{name}说话了。",
    "Leave incognito first, then switch agents.": "请先退出无痕模式，再切换助手。",
    "Jarvis": "贾维斯",
}
lang.add_texts(TEXTS)

PROMPT = (
    "\n\nYou are working as the owner's “{name}” (one of their agents; the everyday JARVIS "
    "and any others have their own conversations). Only the tools given to {name} are here: "
    "when the owner asks for something they don't reach, say so in a sentence, and that "
    "saying “switch to Jarvis” (or another agent's name) gives them the rest. What you "
    "remember here is {name}'s own memory and what's shared."
)


def prepare(folder: Path) -> None:
    """Before the hub is made: the agents read, so the first conversation already is the
    agent in use's (its memory and tools)."""
    _PREPARED[str(folder / FILE)] = AgentStore(folder / FILE)


def _deny(why: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": why,
        }
    }


class AgentDesk:
    """The agents feature on one hub (hub.agents)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._store: AgentStore | None = _PREPARED.pop(str(hub.feature_path(FILE)), None)
        if self._store is not None:
            self._scope_memory()
        self.available: list[str] = []  # the tool servers at the last connect, before any left out
        self.connected = ""  # the agent whose conversation is connected ("" before the first)
        self.sessions: dict[str, tuple[str, dict[str, Any]]] = {}  # agent -> (session, reads)
        self.called: tuple[str, float] | None = None  # a wake word heard: (agent, when)
        self._changing = asyncio.Lock()

    # ── the store ──

    def store(self) -> AgentStore:
        """The agents, read on first use (a small file) when the backend didn't already."""
        if self._store is None:
            self._store = AgentStore(self.hub.feature_path(FILE))
            self._scope_memory()
        return self._store

    def active(self) -> agents.Agent | None:
        return self.store().current()

    def active_id(self) -> str:
        return self.store().active

    def name_of(self, ident: str) -> str:
        agent = self.store().get(ident)
        if agent is None:
            return (
                lang.translate("Jarvis", self.hub.language)
                if lang.is_zh(self.hub.language)
                else "Jarvis"
            )
        if lang.is_zh(self.hub.language) and agent.zh_name:
            return agent.zh_name
        return agent.name

    def _scope_memory(self) -> None:
        memory = getattr(self.hub, "memory", None)
        if memory is not None and self._store is not None:
            current = self._store.current()
            memory.agent = current.id if current is not None else ""

    def _wake_names(self) -> list[str]:
        if self._store is None or not self._store.items:  # never a file read in a wake check
            return []
        return agents.wake_words(self._store.items, self._main_persona())

    def _main_persona(self) -> str:
        store = self.store()
        if store.active == MAIN:
            return self.hub.prefs.persona
        return store.main_persona or "jarvis"

    # ── switching ──

    def choose(self, ident: str) -> bool:
        """Make this agent (or MAIN) the one in use: kept, its persona chosen, memory scoped
        to it; its conversation is connected before the next request. False when it can't
        be (incognito, gone, or the file can't be written)."""
        hub = self.hub
        store = self.store()
        if ident == store.active:
            return True
        if hub.incognito:
            return False
        target = store.get(ident)
        if ident != MAIN and target is None:
            return False
        try:
            store.use(ident, hub.prefs.persona)
        except (OSError, ValueError) as exc:
            log.warning("agents: couldn't switch (%s)", exc)
            return False
        persona = target.persona if target is not None else (store.main_persona or "")
        if persona and persona != hub.prefs.persona and persona in _personas():
            hub.set_prefs({"persona": persona})
        self._scope_memory()
        hub._memory_changed()
        note = f"{self.name_of(ident)}"
        hub.history.append({"role": "note", "text": f"→ {note}", "at": _now()})
        hub.emit("history", items=list(hub.history))
        self.publish()
        return True

    async def on_query(self, _text: str, _rid: str) -> None:
        """Just before Claude gets a request: the agent it's for (a chat's route, a name
        called hands-free), and that agent's conversation connected."""
        hub = self.hub
        store = self.store()
        target = None
        if store.items:
            target = agents.best_route(store.items, getattr(hub, "turn_origin", None))
            if target is None and self.called is not None:
                ident, when = self.called
                if time.monotonic() - when <= WAKE_SECONDS:
                    target = ident
            self.called = None
        if target is not None:
            self.choose(target)
        if self.connected and self.connected != store.active and not hub.incognito:
            await self._swap()

    async def _swap(self) -> None:
        """Connect the agent in use's own conversation (the caller holds the turn's lock):
        the one it had, carried on with what it had read, or a new one."""
        hub = self.hub
        leaving = self.connected
        if hub._session_id:
            self.sessions[leaving] = (hub._session_id, dict(hub._session_reads))
        sid, reads = self.sessions.get(self.store().active, ("", {}))
        with contextlib.suppress(Exception):
            await hub.client.disconnect()
        try:
            await hub._connect(resume=sid)
        except Exception:
            if not sid:
                raise
            log.warning("agents: the agent's conversation didn't carry on; a new one starts")
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            await hub._connect()
            sid = ""
        hub._session_id = sid
        if sid:
            hub._session_reads = reads

    # ── the conversation's tools ──

    def on_connect(self, options: Any, _resume: str) -> None:
        servers = dict(options.mcp_servers or {})
        self.available = sorted(servers)
        fresh = self._store is None  # read just now: the prompt's memory was everyone's
        agent = self.active()
        self.connected = self.store().active
        if agent is None:
            return
        if fresh:
            self._rescope_prompt(options, agent.id)
        keep = {name for name in servers if agent.keeps(name)}
        options.mcp_servers = {name: server for name, server in servers.items() if name in keep}
        options.allowed_tools = [
            tool
            for tool in (options.allowed_tools or [])
            if not tool.startswith("mcp__") or agents.server_of(tool) in keep
        ]
        name = agent.name

        async def only_its_own(data: Any, _tool_use_id: Any, _context: Any) -> dict[str, Any]:
            tool = str((data or {}).get("tool_name") or "") if isinstance(data, dict) else ""
            if tool.startswith("mcp__") and agents.server_of(tool) not in keep:
                return _deny(f"{tool} isn't one of {name}'s tools.")
            return {}

        hooks = {kind: list(matchers) for kind, matchers in (options.hooks or {}).items()}
        hooks.setdefault("PreToolUse", []).insert(
            0, HookMatcher(matcher=None, hooks=[only_its_own])
        )
        options.hooks = hooks
        if isinstance(options.system_prompt, str):
            options.system_prompt += PROMPT.format(name=name)

    def _rescope_prompt(self, options: Any, ident: str) -> None:
        """The prompt's memory as this agent reads it (it was made before the agents were)."""
        memory = getattr(self.hub, "memory", None)
        if memory is None or not isinstance(options.system_prompt, str):
            return
        memory.agent = ""
        shared = memory.prompt_block()
        memory.agent = ident
        own = memory.prompt_block()
        if shared and shared in options.system_prompt:
            options.system_prompt = options.system_prompt.replace(shared, own, 1)
        elif own:
            options.system_prompt += own

    # ── how it's picked ──

    def on_wake(self, heard: str, _command: str) -> None:
        store = self.store()
        if not store.items:
            return
        ident = agents.called(heard, store.items, self._main_persona())
        if ident is not None:
            self.called = (ident, time.monotonic())

    async def instant(self, text: str) -> str | None:
        """ "switch to work", "go back to Jarvis", 切换到工作: answered without Claude."""
        store = self.store()
        if not store.items:
            return None
        ident = agents.asked_for(text, store.items, self._main_persona())
        if ident is None:
            return None
        name = self.name_of(ident)
        if ident == store.active:
            return lang.tr("You're already talking to {name}.", self.hub.language, name=name)
        if self.hub.incognito:
            return lang.tr("Leave incognito first, then switch agents.", self.hub.language)
        if not self.choose(ident):
            return None
        return lang.tr("Switched to {name}.", self.hub.language, name=name)

    # ── the window ──

    def payload(self) -> dict[str, Any]:
        store = self.store()
        from .. import prefs as prefs_module

        names = {}
        with contextlib.suppress(Exception):
            from ..connectors import server_name

            for conn_id, conn in self.hub.connectors.connections.items():
                names[server_name(conn_id)] = conn.name
        tools = [
            {"name": n, "label": LABELS.get(n, ""), "account": names.get(n, "")}
            for n in self.available
            if n not in agents.ALWAYS
        ]
        return {
            "items": [a.public() for a in store.items],
            "active": store.active,
            "max": agents.MAX_AGENTS,
            "personas": [
                {"id": ident, "name": name}
                for ident, (name, _about) in prefs_module.PERSONAS.items()
            ],
            "tools": tools,
            "channels": list(agents.CHANNELS),
        }

    def publish(self, error: str = "") -> None:
        self.hub.emit("agents", error=error, **self.payload())

    async def state(self, _msg: Any = None) -> None:
        if self._store is None:
            await asyncio.to_thread(self.store)
        self.publish()

    async def save(self, msg: dict[str, Any]) -> None:
        raw = msg.get("agent")
        if not isinstance(raw, dict):
            return
        async with self._changing:
            store = await asyncio.to_thread(self.store)
            try:
                agent = await asyncio.to_thread(store.put, raw)
            except ValueError as exc:
                self.publish(error=str(exc))
                return
            except OSError as exc:
                self.publish(error=f"Couldn't save it just now ({exc.strerror or exc}).")
                return
            wake.add_names("agents", self._wake_names)
            if agent.id == store.active:
                await self._reload()  # its tools changed: its conversation gets them now
        self.publish()

    async def delete(self, msg: dict[str, Any]) -> None:
        ident = str(msg.get("id") or "")
        async with self._changing:
            store = await asyncio.to_thread(self.store)
            if store.get(ident) is None:
                return
            if store.active == ident:
                self.choose(MAIN)
            try:
                await asyncio.to_thread(store.remove, ident)
            except OSError as exc:
                self.publish(error=f"Couldn't remove it just now ({exc.strerror or exc}).")
                return
            self.sessions.pop(ident, None)
        self.publish()

    async def use(self, msg: dict[str, Any]) -> None:
        ident = str(msg.get("id") or "")
        if self.choose(ident) and self.connected != self.store().active:
            async with self.hub._lock:  # after the request being answered
                if self.connected != self.store().active and self.hub.client is not None:
                    await self._swap()
        self.publish()

    async def _reload(self) -> None:
        hub = self.hub
        if hub.client is None:
            return
        async with hub._lock:
            reads = hub._session_reads
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            await hub._connect(resume=hub._session_id)
            hub._session_reads = reads

    def install(self) -> None:
        hub = self.hub
        hub.agents = self
        wake.add_names("agents", self._wake_names)
        hub.add_connect_hook(self.on_connect)
        hub.add_query_hook(self.on_query)
        hub.add_wake_sink(self.on_wake)
        hub.register_instant(self.instant)

        def later(work: Any) -> Any:
            return lambda msg: hub._spawn(work(msg)) and None

        hub.register_command("agents_state", later(self.state))
        hub.register_command("agent_save", later(self.save))
        hub.register_command("agent_delete", later(self.delete))
        hub.register_command("agent_use", later(self.use))


def _personas() -> set[str]:
    from ..prefs import PERSONAS

    return set(PERSONAS)


def _now() -> str:
    from datetime import datetime

    return datetime.now().isoformat(timespec="seconds")


def install(hub: Any) -> None:
    AgentDesk(hub).install()
