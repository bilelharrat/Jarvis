"""Other coding agents in Eden Code, over the Agent Client Protocol (acp): the owner adds an
agent by its command (codex-acp, gemini --experimental-acp, opencode acp…), and starts a
session with it in a project. It's an ordinary Eden Code session: its transcript, its
cards, its queue and Stop, and, as for a Claude session, Rewind and Undo, its usage and a
receipt for each turn that changed files; what it can't do (switch models, report its
context) says so. It left Labs once it had those (features/_labs.py GRADUATED): on for
everyone, with its own switch in Settings › Eden Code › General (code_acp_agents).

What it adds, and where:
- TaskManager.client_factory, wrapped: a session whose model is "acp:<agent>" talks to that
  agent (acp.AcpClient); every other session to Claude Code, as before.
- TaskManager.option_hooks: a session's options carry its id, so its client can hand a
  rewind back here (AcpDesk.rewind), where the session's later turns are known.
- Rewind and Undo (acp_checkpoints.py): Eden snapshots the working tree before each of the
  owner's messages and at each turn's end (git commit objects under hidden refs, never
  `git stash`); a rewind puts back the files the turns since that message changed. The
  files a turn changed (its snapshots' difference, whatever tool the agent used) join the
  session's changed files, so the Changes pane, the turn's end and its receipt have them.
- TaskManager.on_usage, wrapped: an agent's turn is counted here, not in Claude's usage:
  its tokens (the agent's own report, else an estimate, marked so) and its cost when the
  agent says it (a usage_update's session cost, in dollars), per session and per agent a
  day, kept in code_acp_usage.json. The Usage pane shows them (code_usage.public's
  "agents"), and a receipt carries the turn's (code_receipts: receipt_part).
- Window commands: acp_state {}, acp_add {name, command}, acp_remove {agent},
  acp_start {agent, directory, mode?} (Bypass from the window wants Touch ID's proof, as
  task_new does: code_touchid.py). Events: acp_state {agents, error?},
  acp_started {id}.
- The agents are kept in code_acp.json beside the settings (the command as its words;
  nothing secret belongs there: an agent signs in by itself).

The agent runs as the owner, in the session's folder, with the owner's environment. JARVIS
answers only the steps it asks about (by JARVIS's own policy: the mode, the owner's rules,
a card); what it does without asking is up to its own settings. It gets no file access from
JARVIS, and of the MCP servers only the stdio ones a feature adds for it (Eden's read-only
code index: features/code_index.py, acp.mcp_servers_for).

Cost policy (Claude): this feature never calls a Claude model. The agent's own model is its
own, on the owner's account with its provider; what it spends is counted apart from
Claude's, and Claude's spending limits never hold it up.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shlex
from datetime import date
from functools import partial
from pathlib import Path
from typing import Any

from .. import acp_checkpoints as ck
from .. import jsonstore
from ..acp import AcpClient, AcpError
from ..codeplatform import other_agent
from ..textclean import clean_text

log = logging.getLogger("jarvis")

PREFIX = "acp:"
AGENTS_KEPT = 30
WORDS_KEPT = 30
DAYS_KEPT = 31  # days of each agent's usage kept
SEEN_KEPT = 200  # agent sessions whose last-said cost is kept (for a reopen's first report)
TASK_ATTR = "_eden_task_id"  # (on a session's options: whose they are)


def tokens_text(n: Any, estimated: bool = False) -> str:
    """12, 4.2k, 1.3M tokens: as a receipt and the Usage pane say them (≈: an estimate)."""
    n = max(0, int(n or 0))
    shown = f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(n)
    shown = shown.replace(".0M", "M").replace(".0k", "k")
    return f"{'≈' if estimated else ''}{shown} tokens"


class AgentUsage:
    """What each agent used, per session (this run) and per day (code_acp_usage.json).
    A count that can't be saved is kept for this run: usage never stops a session."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.days: dict[str, dict[str, dict[str, Any]]] = {}
        self.seen: dict[str, float] = {}  # agent session id -> its cost so far, as last said
        self.sessions: dict[int, dict[str, Any]] = {}  # task id -> its totals
        self.last: dict[int, dict[str, Any]] = {}  # task id -> its last turn's
        if path is None:
            return
        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        days = data.get("days") if isinstance(data.get("days"), dict) else {}
        for day, agents in days.items():
            if isinstance(day, str) and isinstance(agents, dict):
                self.days[day] = {
                    a: _row(v)
                    for a, v in agents.items()
                    if isinstance(a, str) and isinstance(v, dict)
                }
        seen = data.get("seen") if isinstance(data.get("seen"), dict) else {}
        self.seen = {
            str(k): float(v) for k, v in seen.items()
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0
        }  # fmt: skip

    @staticmethod
    def today() -> str:
        return date.today().isoformat()

    def record(self, task: Any, agent: str, name: str, usage: dict[str, Any]) -> dict[str, Any]:
        """One turn's usage; returns the turn's row (tokens, cost when said, estimate)."""
        cost: float | None = None
        total = usage.get("cost_total")
        sid = str(getattr(task, "session_id", "") or "")
        if isinstance(total, (int, float)) and total >= 0:
            before = self.seen.get(sid) if sid else None
            cost = total - before if before is not None and total >= before else float(total)
            if sid:
                self.seen[sid] = float(total)
                for old in list(self.seen)[:-SEEN_KEPT]:
                    del self.seen[old]
        turn = {
            "agent": agent,
            "name": name,
            "input": int(usage.get("input") or 0),
            "output": int(usage.get("output") or 0),
            "tokens": int(usage.get("tokens") or 0),
            "estimated": bool(usage.get("estimated")),
            "cost": round(cost, 6) if cost is not None else None,
            "context": usage.get("context"),
        }
        self.last[task.id] = turn
        mine = self.sessions.setdefault(task.id, {**_row({}), "name": name, "agent": agent})
        _add(mine, turn)
        mine["context"] = turn["context"]
        day = self.days.setdefault(self.today(), {})
        _add(day.setdefault(agent, _row({})), turn)
        day[agent]["name"] = name
        for old in sorted(self.days)[:-DAYS_KEPT]:
            del self.days[old]
        self.save()
        return turn

    def save(self) -> None:
        if self.path is None:
            return
        try:
            jsonstore.save_json(self.path, {"days": self.days, "seen": self.seen})
        except OSError:
            log.warning("Eden Code agents: their usage couldn't be saved; kept for this run")

    def public(self, tasks: dict[int, Any]) -> dict[str, Any]:
        today = self.days.get(self.today(), {})
        return {
            "today": [{"id": a, **row} for a, row in sorted(today.items())],
            "sessions": {
                str(task_id): dict(row)
                for task_id, row in self.sessions.items()
                if task_id in tasks
            },
        }


def _row(raw: dict[str, Any]) -> dict[str, Any]:
    def number(key: str) -> int:
        value = raw.get(key)
        return (
            int(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
            else 0
        )

    cost = raw.get("cost")
    return {
        "name": str(raw.get("name") or "")[:40],
        "turns": number("turns"),
        "input": number("input"),
        "output": number("output"),
        "tokens": number("tokens"),
        "estimated": number("estimated"),  # (of those tokens, how many are an estimate)
        "cost": float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0 else 0.0,
        "cost_said": bool(raw.get("cost_said")),
    }  # fmt: skip


def _add(row: dict[str, Any], turn: dict[str, Any]) -> None:
    row["turns"] += 1
    for key in ("input", "output", "tokens"):
        row[key] += turn[key]
    if turn["estimated"]:
        row["estimated"] += turn["tokens"]
    if turn["cost"] is not None:
        row["cost"] = round(row["cost"] + turn["cost"], 6)
        row["cost_said"] = True


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
            log.warning("Eden Code agents: %s can't be read (%s)", path.name, exc)
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
        self._usage: AgentUsage | None = None
        self.env: dict[str, str] | None = None  # (the tests' own)

    @property
    def book(self) -> AgentBook:
        if self._book is None:
            self._book = AgentBook(self.hub.feature_path("code_acp.json"))
        return self._book

    @property
    def usage(self) -> AgentUsage:
        """The counts, read at first use (never at install: tests make many hubs)."""
        if self._usage is None:
            self._usage = AgentUsage(self.hub.feature_path("code_acp_usage.json"))
        return self._usage

    def client(self, options: Any) -> AcpClient | None:
        """The client for a session on one of the agents (None: a Claude Code session)."""
        model = getattr(options, "model", "") or ""
        if not isinstance(model, str) or not model.startswith(PREFIX):
            return None
        agent = self.book.agents.get(model[len(PREFIX) :])
        if agent is None:
            raise AcpError("That agent isn't set up any more: add it again in Other agents.")
        task_id = getattr(options, TASK_ATTR, None)
        rewinder = partial(self.rewind, task_id) if isinstance(task_id, int) else None
        return AcpClient(list(agent["command"]), agent["name"], options, self.env, rewinder)

    # ── Rewind and Undo ──

    async def rewind(self, task_id: int, uuid: str) -> None:
        """Files back as they were before one of the owner's messages (TaskManager._rewind,
        through AcpClient.rewind_files): the files that message's turn and every later one
        changed, each as it was in that message's "before" snapshot. AcpError says why not."""
        task = self.hub.tasks.tasks.get(task_id)
        if task is None:
            raise AcpError("that session is gone.")
        cwd = str(task.cwd)
        points = list(task.checkpoints)
        later = points[points.index(uuid) :] if uuid in points else [uuid]
        told = {c: set(task.checkpoint_files.get(c, set())) for c in later}

        def put_back() -> list[str]:
            start = ck.find(cwd, ck.ref_for(uuid, "before"))
            if not start:
                raise ck.CheckpointError(
                    "there's no snapshot from before that message (Eden keeps them for other "
                    "agents in a git repository only)."
                )
            paths: set[str] = set()
            now = ""
            for point in later:
                before = ck.find(cwd, ck.ref_for(point, "before"))
                after = ck.find(cwd, ck.ref_for(point, "after"))
                if before and not after:  # (its end wasn't kept: what's there now)
                    now = now or ck.snapshot(cwd, "Eden Code: before a rewind")
                    after = now
                paths.update(ck.changed(cwd, before, after))
                paths.update(str(Path(cwd) / p) for p in told[point])
            done = ck.restore(cwd, start, sorted(paths))
            ck.drop(cwd, [ck.ref_for(p, part) for p in later for part in ("before", "after")])
            return done

        try:
            await asyncio.to_thread(put_back)
        except ck.CheckpointError as exc:
            raise AcpError(str(exc)) from exc

    # ── a turn's end: its files and usage ──

    def on_turn(self, task: Any, message: Any) -> None:
        """An agent's turn ended (TaskManager.on_usage, before the turn's end is told): the
        files its snapshots say it changed join the session's, and its usage is counted."""
        turn = getattr(message, "acp_turn", None)
        if not isinstance(turn, dict):
            return
        uuid = str(turn.get("uuid") or "")
        for path in turn.get("files") or []:
            task.files_changed.add(path)
            task.turn_files.add(path)
            if uuid in task.checkpoints:
                task.checkpoint_files.setdefault(uuid, set()).add(path)
        agent_id = str(getattr(task, "model_ref", "") or "")[len(PREFIX) :]
        agent = self.book.agents.get(agent_id)
        name = agent["name"] if agent else str(getattr(task, "model_label", "") or agent_id)
        usage = turn.get("usage") if isinstance(turn.get("usage"), dict) else {}
        self.usage.record(task, agent_id, name, usage)
        meter = getattr(self.hub, "code_usage", None)
        if meter is not None:
            with contextlib.suppress(Exception):
                meter.changed()

    def receipt_part(self, task_id: int) -> dict[str, Any] | None:
        """The last turn's usage, for its receipt (code_receipts)."""
        turn = self.usage.last.get(task_id)
        if not turn:
            return None
        return {k: turn[k] for k in ("name", "tokens", "input", "output", "estimated", "cost")}

    def usage_public(self) -> dict[str, Any]:
        """The agents' usage for the Usage pane (code_usage.public)."""
        return self.usage.public(self.hub.tasks.tasks)

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
        # Bypass from the window wants Touch ID's proof here too, as task_new does (round 1
        # A5): tasks.start asks the gate (code_touchid.Gate.bypass_gate); without one, the
        # session starts all the same, in Manual.
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


class _Tag:
    """A session's options say whose they are (TaskManager.option_hooks): its client hands a
    rewind back to the desk, which knows the session's turns."""

    def apply(self, task: Any, options: Any) -> None:
        if other_agent(task):
            setattr(options, TASK_ATTR, task.id)

    def key(self, _task: Any) -> Any:
        return None


def install(hub: Any) -> None:
    desk = AcpDesk(hub)
    hub.code_acp = desk  # (for the tests)
    inner = hub.tasks.client_factory

    def factory(options: Any = None, **kw: Any) -> Any:
        return desk.client(options) or inner(options=options, **kw)

    hub.tasks.client_factory = factory
    hub.tasks.option_hooks.append(_Tag())
    counted = hub.tasks.on_usage

    def on_usage(task: Any, cost: float, message: Any) -> None:
        if other_agent(task):  # (counted as the agent's, never in Claude's usage)
            try:
                desk.on_turn(task, message)
            except Exception:
                log.exception("Eden Code agents: couldn't count a turn")
            return
        if counted is not None:
            counted(task, cost, message)

    hub.tasks.on_usage = on_usage
    hub.register_command("acp_state", desk.cmd_state)
    hub.register_command("acp_add", desk.cmd_add)
    hub.register_command("acp_remove", desk.cmd_remove)
    hub.register_command("acp_start", desk.cmd_start)
