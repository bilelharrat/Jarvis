"""The owner's agents: several JARVISes, such as "Work Jarvis" and "Family Jarvis", each built
on a persona, with its own memory, its own tools and its own way of being reached.

There is always the everyday JARVIS ("main"): with no agent made, nothing changes. Each agent
the owner makes in Settings has
- a name ("Work Jarvis", and optionally in Chinese) and a persona (jarvis, tars, friday or
  one of the owner's own), whose voice, humor and wake word it uses;
- the tool servers it may use, by name as the conversation knows them ("mail", "calendar",
  "messages", "claude" for Eden Code, "acct_<id>" for a connected account). Memory is
  always there (its facts are the agent's own and the shared ones). Everything else is left
  out of its conversation altogether: never an agent's way to more than it was given;
- where it's reached: chat routes (a chat app, and optionally one Slack workspace or one
  chat in it).

Routing picks the agent for a request:
- by name: the persona's wake word called ("Friday, what's on today?"). "Jarvis" is
  everyone's, so it never switches;
- by where it came from: a route that names the chat app and its workspace or chat wins over
  one that names the app alone;
- by the owner's words: "switch to work", "go back to Jarvis", 切换到工作.

Kept in agents.json beside prefs.json (with the agent in use), read defensively: a damaged
or hand-edited file never stops the app starting, and the everyday JARVIS is always there.
No model is called here.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import jsonstore, wake
from .lang import has_cjk, to_simplified
from .textclean import clean_text

log = logging.getLogger("jarvis")

MAIN = "main"
MAX_AGENTS = 6
MAX_ROUTES = 8
NAME_CHARS = 32
PLACE_CHARS = 80
CHANNELS = ("telegram", "imessage", "slack", "discord")
# Always in every agent's conversation: memory (its facts are scoped to the agent).
ALWAYS = ("memory",)
_ID = re.compile(r"[a-z][a-z0-9-]{0,23}")
_SERVER = re.compile(r"[A-Za-z0-9_-]{1,64}")


def _line(value: Any, limit: int) -> str:
    return " ".join(clean_text(value).split())[:limit] if isinstance(value, str) else ""


@dataclass
class Route:
    channel: str
    place: str = ""  # a Slack workspace, or one chat ("" for the whole app)

    def matches(self, origin: dict[str, Any]) -> int:
        """How well it matches where a request came from: 2 for the app and its workspace
        or chat, 1 for the app alone, 0 for no match."""
        if origin.get("channel") != self.channel:
            return 0
        if not self.place:
            return 1
        wanted = self.place.casefold()
        for key in ("team", "chat"):
            value = origin.get(key)
            if isinstance(value, str) and value and value.casefold() == wanted:
                return 2
        return 0


@dataclass
class Agent:
    id: str
    name: str
    persona: str = "jarvis"
    zh_name: str = ""
    servers: list[str] = field(default_factory=list)
    routes: list[Route] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return asdict(self)

    def keeps(self, server: str) -> bool:
        return server in ALWAYS or server in self.servers


def clean_servers(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    kept = [v for v in value[:200] if isinstance(v, str) and _SERVER.fullmatch(v)]
    return sorted(dict.fromkeys(kept))


def clean_routes(value: Any) -> list[Route]:
    if not isinstance(value, list):
        return []
    routes: list[Route] = []
    for raw in value[: MAX_ROUTES * 2]:
        if not isinstance(raw, dict) or raw.get("channel") not in CHANNELS:
            continue
        route = Route(str(raw["channel"]), _line(raw.get("place"), PLACE_CHARS))
        if route not in routes:
            routes.append(route)
    return routes[:MAX_ROUTES]


def agent_from(raw: Any) -> Agent | None:
    """An agent from the file or the window, tidied; None when it can't be one."""
    if not isinstance(raw, dict):
        return None
    ident = str(raw.get("id") or "")
    name = _line(raw.get("name"), NAME_CHARS)
    persona = str(raw.get("persona") or "jarvis")
    if not _ID.fullmatch(ident) or ident == MAIN or not name or not _ID.fullmatch(persona):
        return None
    return Agent(
        id=ident,
        name=name,
        persona=persona,
        zh_name=_line(raw.get("zh_name"), NAME_CHARS),
        servers=clean_servers(raw.get("servers")),
        routes=clean_routes(raw.get("routes")),
    )


def make_id(name: str, taken: set[str]) -> str:
    """A new agent's id from its name ("Work Jarvis" -> "work"), numbered when taken."""
    words = re.findall(r"[a-z0-9]+", name.casefold())
    words = [w for w in words if w not in ("jarvis", "agent")] or words
    base = "-".join(words)[:16].strip("-")
    if not base or not base[0].isalpha():
        base = "agent"
    taken = taken | {MAIN}
    if base not in taken and base != "agent":
        return base
    n = 2 if base != "agent" else 1
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


class AgentStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.items: list[Agent] = []
        self.active = MAIN
        self.main_persona = ""  # the everyday JARVIS's persona while another is in use
        self.unreadable = ""
        try:
            data = jsonstore.load_json(path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("agents: %s can't be read (%s)", path.name, exc)
            data = None
        data = data or {}
        seen: set[str] = set()
        for raw in data.get("agents") or []:
            agent = agent_from(raw)
            if agent is not None and agent.id not in seen and len(self.items) < MAX_AGENTS:
                seen.add(agent.id)
                self.items.append(agent)
        active = data.get("active")
        self.active = active if isinstance(active, str) and active in seen else MAIN
        persona = data.get("main_persona")
        self.main_persona = persona if isinstance(persona, str) and _ID.fullmatch(persona) else ""

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(
            self.path,
            {
                "agents": [a.public() for a in self.items],
                "active": self.active,
                "main_persona": self.main_persona,
            },
        )

    def get(self, ident: str) -> Agent | None:
        return next((a for a in self.items if a.id == ident), None)

    def current(self) -> Agent | None:
        """The agent in use; None for the everyday JARVIS."""
        return self.get(self.active)

    def put(self, raw: dict[str, Any]) -> Agent:
        """Add an agent, or change one (by its id). Raises ValueError with why not."""
        ident = str(raw.get("id") or "")
        old = self.get(ident) if ident else None
        if ident and old is None:
            raise ValueError("That agent isn't there any more.")
        if old is None and len(self.items) >= MAX_AGENTS:
            raise ValueError(f"There's room for {MAX_AGENTS} agents.")
        name = _line(raw.get("name"), NAME_CHARS)
        if not name:
            raise ValueError("Give the agent a name.")
        if any(a.name.casefold() == name.casefold() and a is not old for a in self.items):
            raise ValueError("Another agent has that name.")
        if old is None:
            ident = make_id(name, {a.id for a in self.items})
        agent = agent_from({**raw, "id": ident})
        if agent is None:
            raise ValueError("That agent can't be kept.")
        before = list(self.items)
        if old is None:
            self.items.append(agent)
        else:
            self.items[self.items.index(old)] = agent
        try:
            self.save()
        except OSError:
            self.items = before
            raise
        return agent

    def remove(self, ident: str) -> Agent | None:
        agent = self.get(ident)
        if agent is None:
            return None
        before, active = list(self.items), self.active
        self.items.remove(agent)
        if self.active == ident:
            self.active = MAIN
        try:
            self.save()
        except OSError:
            self.items, self.active = before, active
            raise
        return agent

    def use(self, ident: str, persona_now: str) -> None:
        """Make this agent (or MAIN) the one in use, kept. persona_now: the persona in use
        until now, kept as the everyday JARVIS's when leaving it."""
        if ident != MAIN and self.get(ident) is None:
            raise ValueError("That agent isn't there any more.")
        before = (self.active, self.main_persona)
        if self.active == MAIN and ident != MAIN:
            self.main_persona = persona_now
        self.active = ident
        try:
            self.save()
        except OSError:
            self.active, self.main_persona = before
            raise


# ── routing ──


def best_route(items: list[Agent], origin: dict[str, Any] | None) -> str | None:
    """The agent a request from a chat goes to: the best-matching route (an app and its
    workspace or chat over the app alone; the first agent on a tie); None when none."""
    if not origin or not origin.get("channel"):
        return None
    best, score = None, 0
    for agent in items:
        for route in agent.routes:
            found = route.matches(origin)
            if found > score:
                best, score = agent.id, found
    return best


def persona_names(persona: str) -> tuple[str, str]:
    """A persona's wake word, in English and Chinese, as the voice feature keeps them (the
    built-in FRIDAY and TARS, and the owner's own personas). Jarvis's is everyone's: none."""
    from . import wakewords

    if persona == "jarvis":
        return "", ""
    return wakewords.PERSONA_NAMES.get(persona, ("", ""))


def callers(items: list[Agent], main_persona: str) -> dict[str, str]:
    """Each wake word that picks one agent (folded) -> that agent's id (MAIN for the
    everyday JARVIS's persona). A name two of them share picks neither."""
    found: dict[str, str] = {}
    shared: set[str] = set()
    pairs = [(MAIN, main_persona)] + [(a.id, a.persona) for a in items]
    for ident, persona in pairs:
        for name in persona_names(persona):
            if not name:
                continue
            key = _fold(name)
            if key in found and found[key] != ident:
                shared.add(key)
            found.setdefault(key, ident)
    return {k: v for k, v in found.items() if k not in shared}


def wake_words(items: list[Agent], main_persona: str) -> list[str]:
    """The names that wake JARVIS for the agents (whichever is in use)."""
    names: list[str] = []
    for persona in [main_persona] + [a.persona for a in items]:
        for name in persona_names(persona):
            if name and name not in names:
                names.append(name)
    return names


def _fold(name: str) -> str:
    return to_simplified(name).casefold() if has_cjk(name) else wake._key(name)


def called(raw: str, items: list[Agent], main_persona: str) -> str | None:
    """The agent whose name was called at the start of what was heard ("Friday, …",
    "Hey Friday", 星期五，…); None when it was "Jarvis" or no agent's name."""
    names = callers(items, main_persona)
    if not names:
        return None
    text = (raw or "").strip()
    for key, ident in names.items():
        if has_cjk(key) and to_simplified(text).startswith(key):
            return ident
    tokens = [wake._key(t) for t in text.split()[:3]]
    tokens = [t for t in tokens if t]
    if tokens and tokens[0] in wake.CALL_GREETINGS:
        tokens = tokens[1:]
    if not tokens:
        return None
    for key, ident in names.items():
        if not has_cjk(key) and wake._near(tokens[0], key):
            return ident
    return None


_SWITCH = re.compile(
    r"^(?:(?:ok(?:ay)?|hey|please|now|so|and|alright|jarvis)\b[\s,]*)*"
    r"(?:(?:switch|change|swap)\s+(?:back\s+|over\s+)?to|go\s+back\s+to|talk\s+to|use)\s+"
    r"(?:the\s+|my\s+)?(?P<name>.+?)(?:\s+(?:agent|profile|mode))?\s*(?:,?\s*please)?[.!]*$",
    re.IGNORECASE,
)
_SWITCH_ZH = re.compile(
    r"^(?:请|麻烦)?(?:切换到|切换成|切到|换成|换到|转到|改用|回到)(?P<name>.+?)[。！!.]*$"
)
MAIN_WORDS = ("jarvis", "default", "the default", "everyday jarvis", "main", "normal jarvis")
MAIN_WORDS_ZH = ("贾维斯", "默认", "普通模式", "日常")


def _keys(agent: Agent) -> set[str]:
    name = agent.name.casefold()
    keys = {name}
    trimmed = re.sub(r"\s+(?:jarvis|agent)$", "", name).strip()
    if trimmed:
        keys.add(trimmed)
    if agent.zh_name:
        keys.add(to_simplified(agent.zh_name))
        keys.add(_ZH_SUFFIX.sub("", to_simplified(agent.zh_name)))
    return keys - {""}


_ZH_SUFFIX = re.compile(r"(?:助手|模式|代理)$")


def asked_for(text: str, items: list[Agent], main_persona: str = "") -> str | None:
    """The agent the owner's words switch to ("switch to work", "go back to Jarvis",
    切换到工作): its id, MAIN, or None when the words aren't that (or name no agent)."""
    if not items:
        return None
    raw = " ".join((text or "").split())
    match = _SWITCH_ZH.match(to_simplified(raw)) if has_cjk(raw) else _SWITCH.match(raw)
    if match is None:
        return None
    wanted = match.group("name").strip(" ,.!?。！").casefold()
    wanted = re.sub(r"^(?:the|my)\s+", "", wanted)
    if has_cjk(wanted):
        wanted = to_simplified(wanted)
    choices = {wanted, _ZH_SUFFIX.sub("", wanted)} - {""}
    if choices & (set(MAIN_WORDS) | set(MAIN_WORDS_ZH)):
        return MAIN
    for agent in items:
        if choices & _keys(agent):
            return agent.id
    names = callers(items, main_persona)  # a persona's name: "switch to Friday"
    key = to_simplified(wanted) if has_cjk(wanted) else wake._key(wanted)
    return names.get(key)


def server_of(tool: str) -> str:
    """The tool server of an "mcp__<server>__<tool>" name ("" for a built-in tool)."""
    if not tool.startswith("mcp__"):
        return ""
    return tool.split("__", 2)[1] if tool.count("__") >= 1 else ""
