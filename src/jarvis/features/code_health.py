"""Jarvis Code's Health pane (web/features/code-health.js): is the engine there, which
version, is Claude signed in, and how is this session's connection doing, with a Reconnect.

- cw_health {id?, fresh?}: -> cw_health {engine: {version, path, bundled}, signin: {state,
  summary, hint, plan, command}, sdk, session: {...} | null}. The engine and sign-in come
  from the checkup's own Claude check (features/ops/doctor.claude_check: the engine's
  --version and its own `auth status`, never a secret), at most once a minute unless asked
  fresh; the session's state is read as it is.
- cw_reconnect {id}: a session that ended (closed, failed to start, crashed) starts again on
  the same conversation; a live one gets a new connection between steps.

Cost policy (Claude): nothing here calls a model (auth status and --version are local).
"""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Any

from .. import lang
from .code_workspace import session_of

FRESH_SECONDS = 60.0  # the engine and sign-in are looked at again after this

ZH = {
    "Reconnecting this session.": "正在重新连接这个会话。",
    "Starting this session again.": "正在重新启动这个会话。",
    "There's no such session.": "没有这个会话。",
}
lang.add_texts(ZH)


def _version(meta: str) -> str:
    """The engine's version, from the check's meta ("Max · 2.1.3", or "2.1.3")."""
    for part in reversed(str(meta or "").split(" · ")):
        if re.match(r"^\d+\.\d+", part.strip()):
            return part.strip()
    return ""


def session_state(task: Any) -> dict[str, Any]:
    status = str(getattr(task, "status", ""))
    return {
        "id": task.id,
        "status": status,
        "connected": getattr(task, "client", None) is not None,
        "busy": bool(getattr(task, "busy", False)),
        "model": str(getattr(task, "model_label", "") or getattr(task, "model", "") or ""),
        "error": str(getattr(task, "result", "") or "")[:600] if status == "failed" else "",
        "fell_back": bool(getattr(task, "fell_back_from", None)),
    }


class Health:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._engine: dict[str, Any] | None = None
        self._at = 0.0
        self._looking: asyncio.Future | None = None  # a look under way, for others to share

    async def engine(self, fresh: bool = False) -> dict[str, Any]:
        """The engine and the sign-in, from the checkup's Claude check (kept a minute). An
        ask while a look is under way (the pane opened, then another session shown; two
        windows) shares that look rather than starting the engine twice more, and a check of
        the sign-in with it; a fresh ask still starts its own."""
        if self._engine is not None and not fresh and time.monotonic() - self._at < FRESH_SECONDS:
            return self._engine
        if fresh or self._looking is None or self._looking.done():
            self._looking = asyncio.ensure_future(self._look())
        return await asyncio.shield(self._looking)

    async def _look(self) -> dict[str, Any]:
        from .ops import desk_for, doctor

        desk = desk_for(self.hub)
        if desk is not None:
            probe = desk.probe()
        else:  # (the checkup isn't installed: its defaults)
            home = Path.home()
            probe = doctor.Probe(data=home, logs=home, home=home)
        check = await doctor.claude_check(probe)
        cli = (probe.claude_cli or doctor.claude_cli)() or ""
        try:
            import claude_agent_sdk

            sdk = str(getattr(claude_agent_sdk, "__version__", ""))
        except Exception:
            sdk = ""
        meta = str(check.get("meta") or "")
        version = _version(meta)
        plan = meta.split(" · ")[0] if meta and meta.split(" · ")[0] != version else ""
        self._engine = {
            "engine": {"version": version, "path": cli, "bundled": "/_bundled/" in cli},
            "signin": {
                "state": check.get("state", "unknown"),
                "summary": check.get("summary", ""),
                "hint": check.get("hint", ""),
                "plan": plan,
                "command": check.get("command", ""),
            },
            "sdk": sdk,
        }
        self._at = time.monotonic()
        return self._engine

    async def cmd_health(self, msg: dict[str, Any]) -> None:
        engine = await self.engine(fresh=msg.get("fresh") is True)
        task = session_of(self.hub, msg)
        self.hub.emit(
            "cw_health",
            id=msg.get("id") or 0,
            session=session_state(task) if task else None,
            quality=quality.public() if (quality := getattr(self.hub, "quality", None)) else None,
            **engine,
        )

    def cmd_reconnect(self, msg: dict[str, Any]) -> None:
        task = session_of(self.hub, msg)
        done = self.hub.tasks.reconnect(task.id) if task is not None else ""
        said = {
            "started": "Starting this session again.",
            "reopened": "Reconnecting this session.",
        }.get(done, "There's no such session.")
        self.hub.emit("caption", text=lang.translate(said, self.hub.language))
        if task is not None:
            self.hub.emit("cw_health_session", id=task.id, session=session_state(task))


def install(hub: Any) -> None:
    health = Health(hub)
    hub.code_health = health
    hub.register_command("cw_health", lambda msg: hub._spawn(health.cmd_health(msg)))
    hub.register_command("cw_reconnect", health.cmd_reconnect)
