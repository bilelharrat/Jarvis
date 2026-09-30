"""The utility model: the one JARVIS uses for its own quick jobs in the background (triage,
summaries, proposals), set in Settings › Brain › Utility model. Haiku unless the owner picks
another: one of Claude's, or a model they added in Settings › Models (a model on this Mac
included, so these jobs can stay on the Mac too).

For any module that makes such a call:
- ref(prefs): the model ref the owner picked ("haiku", "sonnet", "custom:…").
- config(hub): what a Claude Code call needs for it (model, env, settings, label), as
  providers.session_config gives it, with the relays it goes through started.
- complete(hub, prompt, system=…, purpose=…): one tool-less call on it (or on the model a
  caller names with model=), counted against that purpose's cap for the day. A purpose not
  in POLICY is registered with register_purpose(name, per_day) first.
Existing callers keep their own models; this is where new ones find the owner's choice.

Cost policy: the calls are the callers', each purpose capped per day here (the counts are
kept in utility_usage.json beside the settings; past a cap the call is refused, OverBudget,
and nothing is sent). The purposes this module knows:

  skill_triage  (the utility model)  after a long multi-step request the owner made (six
                tool steps or more): is it worth keeping as a skill? One tool-less turn on
                at most 6,000 characters of the request, its steps and its reply.   20 a day
  skill_draft   (Sonnet 5.5)  a skill written from such a request, when triage says yes or
                the owner says "make that a skill": one tool-less turn on at most 12,000
                characters.                                                           8 a day

Other features count their own capped calls here too (register_purpose), each with its cost
policy in its own module: picture (Google Gemini on the owner's key, not Claude:
features.pictures, 50 a day).

Nothing here runs at import or install: a call happens only when a caller makes one. Tests
never reach a model: conftest refuses run_turn unless a test fakes it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from datetime import date
from pathlib import Path
from typing import Any

from .prefs import MODELS, register_feature_pref

log = logging.getLogger("jarvis")

PREF = "utility_model"
DEFAULT = "haiku"
CALL_SECONDS = 90.0
_REF = re.compile(r"custom:[a-z0-9]{6,32}")


def _clean(value: Any) -> str | None:
    """A built-in model's key or an added model's ref (whether it's still there is asked
    when a call is made: a removed one means the default)."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value in MODELS or _REF.fullmatch(value) else None


register_feature_pref(PREF, DEFAULT, _clean)

# purpose -> calls a day
POLICY: dict[str, int] = {"skill_triage": 20, "skill_draft": 8}


class OverBudget(Exception):
    """Today's cap for this purpose is reached: nothing was sent."""


def register_purpose(name: str, per_day: int) -> None:
    """A caller's own purpose and its cap, before its first call."""
    POLICY[str(name)] = max(0, int(per_day))


class Usage:
    """How many calls of each purpose today, in a small JSON file (read defensively: a
    damaged one starts the day's counts over, never blocks a purpose for good)."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.day = date.today().isoformat()
        self.counts: dict[str, int] = {}
        if path is None:
            return
        from . import jsonstore

        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        counts = data.get("counts") if isinstance(data, dict) else None
        if isinstance(data, dict) and data.get("day") == self.day and isinstance(counts, dict):
            self.counts = {
                k: v for k, v in counts.items() if isinstance(k, str) and type(v) is int and v >= 0
            }

    def take(self, purpose: str, today: date | None = None) -> None:
        day = (today or date.today()).isoformat()
        if day != self.day:
            self.day, self.counts = day, {}
        cap = POLICY.get(purpose, 0)
        if self.counts.get(purpose, 0) >= cap:
            raise OverBudget(purpose)
        self.counts[purpose] = self.counts.get(purpose, 0) + 1
        if self.path is not None:
            from . import jsonstore

            with contextlib.suppress(OSError):
                jsonstore.save_json(self.path, {"day": self.day, "counts": self.counts})

    def left(self, purpose: str, today: date | None = None) -> int:
        day = (today or date.today()).isoformat()
        used = self.counts.get(purpose, 0) if day == self.day else 0
        return max(0, POLICY.get(purpose, 0) - used)


def usage_for(hub: Any) -> Usage:
    """The one count a hub's callers share (two on one file would each save over the other's)."""
    found = getattr(hub, "utility_usage", None)
    if found is None:
        found = Usage(hub.feature_path("utility_usage.json"))
        hub.utility_usage = found
    return found


def ref(prefs: Any) -> str:
    """The utility model the owner picked, as a model ref."""
    try:
        chosen = prefs.feature(PREF)
    except Exception:
        chosen = None
    return chosen if isinstance(chosen, str) and _clean(chosen) else DEFAULT


def _usable(hub: Any, wanted: str) -> str:
    store = getattr(hub, "providers", None)
    if wanted in MODELS or store is None:
        return wanted if wanted in MODELS else DEFAULT
    return wanted if store.known(wanted) else DEFAULT


async def config(hub: Any, wanted: str | None = None) -> dict[str, Any]:
    """What a call on the utility model (or the ref given) needs: providers.session_config's
    {model, env, settings, label, …}. A model added with a key that no longer works falls
    back to the default, with the reason logged."""
    chosen = _usable(hub, wanted or ref(hub.prefs))
    store = getattr(hub, "providers", None)
    if store is None or chosen in MODELS:
        return {"model": MODELS[chosen], "env": {}, "settings": None, "label": chosen}
    kind = store.kind_of(chosen)
    try:
        if kind == "gemini":
            from .gemini_proxy import PROXY

            await PROXY.start()
        elif kind == "openai":
            from . import openai_relay

            await openai_relay.ready(store, chosen)
        return store.session_config(chosen)
    except Exception as exc:  # gone, or its key: the default then
        log.warning("utility model %s isn't usable (%s); using %s", chosen, exc, DEFAULT)
        return {"model": MODELS[DEFAULT], "env": {}, "settings": None, "label": DEFAULT}


async def run_turn(prompt: str, options: Any, timeout: float = CALL_SECONDS) -> str:
    """One query: Claude's words, joined. (Tests replace this: conftest refuses it.)"""
    from claude_agent_sdk import AssistantMessage, TextBlock, query

    parts: list[str] = []

    async def run() -> None:
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                parts.extend(b.text for b in message.content if isinstance(b, TextBlock))

    await asyncio.wait_for(run(), timeout)
    return "\n".join(parts).strip()


async def complete(
    hub: Any,
    prompt: str,
    *,
    system: str,
    purpose: str,
    model: str | None = None,
    timeout: float = CALL_SECONDS,
) -> str:
    """One tool-less call on the utility model (or model, a ref), counted against purpose's cap for
    today: OverBudget, and nothing sent, once it's reached. None of the owner's settings,
    hooks or MCP servers are loaded; what the prompt carries is data to the model."""
    from claude_agent_sdk import ClaudeAgentOptions

    from .claude_signin import signed_in
    from .config import MAX_BUFFER

    usage_for(hub).take(purpose)
    cfg = await config(hub, model)
    workspace = hub.feature_path("workspace")
    with contextlib.suppress(OSError):
        workspace.mkdir(parents=True, exist_ok=True)
    options = ClaudeAgentOptions(
        max_buffer_size=MAX_BUFFER,
        model=cfg["model"],
        system_prompt=system,
        tools=[],
        allowed_tools=[],
        setting_sources=[],
        strict_mcp_config=True,
        max_turns=1,
        cwd=str(workspace),
        env={**(cfg.get("env") or {}), "ENABLE_TOOL_SEARCH": "false"},
        settings=cfg.get("settings"),
    )
    # The user's own API key, if that's how Jarvis signs in (a provider's settings stay).
    options = signed_in(options)
    return await run_turn(prompt, options, timeout)
