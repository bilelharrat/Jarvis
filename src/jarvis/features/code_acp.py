"""Other coding agents in Jarvis Code, over the Agent Client Protocol (acp): the owner adds an
agent by its command (codex-acp, gemini --experimental-acp, opencode acp…), and starts a
session with it in a project. It's an ordinary Jarvis Code session: its transcript, its
cards, its queue and Stop; what it can't do (switch models, rewind files, report its
context or cost) says so.

What it adds, and where:
- TaskManager.client_factory, wrapped: a session whose model is "acp:<agent>" talks to that
  agent (acp.AcpClient); every other session to Claude Code, as before.
- Window commands: acp_state {}, acp_add {name, command}, acp_remove {agent},
  acp_start {agent, directory, mode?}. Events: acp_state {agents, error?},
  acp_started {id}.
- The agents are kept in code_acp.json beside the settings (the command as its words;
  nothing secret belongs there: an agent signs in by itself).

The agent runs as the owner, in the session's folder, with the owner's environment. JARVIS
answers only the steps it asks about (by JARVIS's own policy: the mode, the owner's rules,
a card); what it does without asking is up to its own settings. It gets no MCP servers or
file access from JARVIS.

Cost policy (Claude): this feature never calls a Claude model. The agent's own model is its
own, on the owner's account with its provider.
"""

from __future__ import annotations

import logging
import re
import shlex
from pathlib import Path
from typing import Any

from .. import jsonstore
from ..acp import AcpClient, AcpError
from ..textclean import clean_text

log = logging.getLogger("jarvis")

PREFIX = "acp:"
AGENTS_KEPT = 30
WORDS_KEPT = 30


class AgentBook:
    """The ACP agents the owner added, in code_acp.json (path None: in memory)."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.agents: dict[str, dict[str, Any]] = {}
        self.unreadable = ""
        if path is None:
            return
        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("Jarvis Code agents: %s can't be read (%s)", path.name, exc)
            return
        agents = data.get("agents")
        for raw in (agents if isinstance(agents, list) else [])[:AGENTS_KEPT]:
            if not isinstance(raw, dict):
                continue
            words, name, agent_id = raw.get("command"), raw.get("name"), raw.get("id")
            if (
                isinstance(agent_id, str)
                and re.fullmatch(r"[a-z0-9][a-z0-9\-]{0,39}", agent_id)
                and isinstance(name, str)
                and isinstance(words, list)
                and words
                and all(isinstance(w, str) for w in words)
            ):
                self.agents[agent_id] = {
                    "id": agent_id,
                    "name": name[:40],
                    "command": words[:WORDS_KEPT],
                }

    def add(self, name: str, command: str) -> dict[str, Any]:
        """An agent from its name and command line; ValueError says what's wrong."""
        name = clean_text(str(name or "")).strip()[:40]
        if not name:
            raise ValueError("Give the agent a name, like Codex.")
        try:
            words = shlex.split(str(command or ""))
        except ValueError as exc:
            raise ValueError("That command has a quote that isn't closed.") from exc
        if not words or len(words) > WORDS_KEPT:
            raise ValueError(
                "Type the command that starts it, like codex-acp or gemini --experimental-acp."
            )
        if len(self.agents) >= AGENTS_KEPT:
            raise ValueError("That's as many agents as can be kept.")
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "agent"
        agent_id, n = base, 2
        while agent_id in self.agents:
            agent_id, n = f"{base}-{n}", n + 1
        agent = {"id": agent_id, "name": name, "command": words}
        self.agents[agent_id] = agent
        self.save()
        return agent

    def remove(self, agent_id: str) -> bool:
        if self.agents.pop(agent_id, None) is None:
            return False
        self.save()
        return True

    def save(self) -> None:
        if self.path is None:
            return
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, {"agents": list(self.agents.values())})


class AcpDesk:
    """One hub's other agents."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._book: AgentBook | None = None
        self.env: dict[str, str] | None = None  # (the tests' own)

    @property
    def book(self) -> AgentBook:
        if self._book is None:
            self._book = AgentBook(self.hub.feature_path("code_acp.json"))
        return self._book

    def client(self, options: Any) -> AcpClient | None:
        """The client for a session on one of the agents (None: a Claude Code session)."""
        model = getattr(options, "model", "") or ""
        if not isinstance(model, str) or not model.startswith(PREFIX):
            return None
        agent = self.book.agents.get(model[len(PREFIX) :])
        if agent is None:
            raise AcpError("That agent isn't set up any more: add it again in Other agents.")
        return AcpClient(list(agent["command"]), agent["name"], options, self.env)

    def public(self) -> list[dict[str, Any]]:
        return [
            {"id": a["id"], "name": a["name"], "command": shlex.join(a["command"])[:300]}
            for a in self.book.agents.values()
        ]

    def emit(self, **extra: Any) -> None:
        self.hub.emit("acp_state", agents=self.public(), **extra)

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.emit()

    def cmd_add(self, msg: dict[str, Any]) -> None:
        try:
            agent = self.book.add(str(msg.get("name") or ""), str(msg.get("command") or ""))
        except ValueError as exc:
            self.emit(error=str(exc))
            return
        except OSError:
            self.emit(error="Couldn't save that; try again.")
            return
        self.emit(added=agent["id"])

    def cmd_remove(self, msg: dict[str, Any]) -> None:
        try:
            self.book.remove(str(msg.get("agent") or ""))
        except OSError:
            self.emit(error="Couldn't save that; try again.")
            return
        self.emit()

    def cmd_start(self, msg: dict[str, Any]) -> None:
        """A session with one of the agents, in a project."""
        agent = self.book.agents.get(str(msg.get("agent") or ""))
        if agent is None:
            self.emit(error="That agent isn't set up any more.")
            return
        try:
            task = self.hub.tasks.start(
                str(msg.get("prompt") or ""),
                str(msg.get("directory") or ""),
                str(msg.get("mode") or "ask"),
                model=PREFIX + agent["id"],
                model_label=agent["name"],
                model_ref=PREFIX + agent["id"],
            )
        except (ValueError, OSError) as exc:
            self.emit(error=str(exc)[:300] or "That folder can't be opened.")
            return
        self.hub.emit("acp_started", id=task.id)


def install(hub: Any) -> None:
    desk = AcpDesk(hub)
    hub.code_acp = desk  # (for the tests)
    inner = hub.tasks.client_factory

    def factory(options: Any = None, **kw: Any) -> Any:
        return desk.client(options) or inner(options=options, **kw)

    hub.tasks.client_factory = factory
    hub.register_command("acp_state", desk.cmd_state)
    hub.register_command("acp_add", desk.cmd_add)
    hub.register_command("acp_remove", desk.cmd_remove)
    hub.register_command("acp_start", desk.cmd_start)
