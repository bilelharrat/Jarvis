"""Eden Code's MCP manager (codemcp): a session's MCP servers in every scope with how each
is doing, added, removed, approved and signed in to from the MCP servers pane, and JARVIS's
own connectors (Tools & Accounts: GitHub, Linear, Sentry…) shared into a session with a
switch of their own.

What it adds, and where:
- Window commands: cm_state {id}; cm_add {id, name, scope, kind: "command" | "url",
  target, transport?}; cm_remove {id, name, scope}; cm_approve {id, name, approve};
  cm_login {id, name}; cm_reconnect {id, name}; cm_share {id, connector, on}. Each answers
  with cm_state {id, folder, name, servers, connectors, live, signing, note?, error?}.
- TaskManager.option_hooks: the connectors shared into a session, as JARVIS's in-process
  servers (JARVIS holds their sign-in: no secret goes to Claude Code), with the tools the
  connector lets run unasked (its read-only ones, and those the owner allowed); every other
  tool asks, as any of the session's steps does. Its key is the shared connectors and what
  changed in the session's config, so a change reopens the session between steps.
- Adding, removing and signing in go through Claude Code's own CLI in the session's folder
  (claude mcp add-json, remove, login: the sign-in opens the browser, and the server is
  reconnected when it's done).

A project's shared servers (.mcp.json) run commands whoever wrote the file chose: one found
there waits for the owner's approval (the pane shows what it runs), kept in the folder's
settings.local.json (the owner's alone). Nothing goes into a project's shared files but a
server the owner adds there with "This project, shared".

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path
from typing import Any

from .. import codemcp
from ..codeplatform import background, code_task
from ..connectors import SERVER_PREFIX as SHARED_PREFIX
from ..connectors import server_name

log = logging.getLogger("jarvis")

RECONNECT_WAIT = 20.0
STATUS_WAIT = 10.0
# A session's notes as its MCP servers change (the window's Chinese: web/i18n/code-mcp.json).
ADDED = "Added the MCP server {name}: the session has it from its next step."
REMOVED = "Removed the MCP server {name}."
APPROVED = "Approved the project's MCP server {name}: the session has it from its next step."
REFUSED = "The project's MCP server {name} stays off here."
SHARED = "{name} (from Tools & Accounts) is shared with this session now."
UNSHARED = "{name} isn't shared with this session any more."
SIGNED_IN = "Signed in to {name}."


def _last_line(text: str) -> str:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    return lines[-1][:300] if lines else ""


class McpDesk:
    """One hub's MCP manager."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.shared: dict[int, set[str]] = {}  # task id -> connector ids shared into it
        self.changes: dict[int, int] = {}  # task id -> its config changes (for its key)
        self.signing: dict[tuple[str, str], asyncio.Future] = {}  # (folder, name) -> sign-in
        self._running: set[asyncio.Future] = set()  # (held till done: never let go mid-way)
        self.run = codemcp.run_cli  # (the tests' own)
        self.state_path: Path | None = None  # Claude Code's state file (the tests' own)
        self.settings_path: Path | None = None  # its user settings (the tests' own)

    def paths(self) -> tuple[Path, Path]:
        return (
            self.state_path or codemcp.claude_json(),
            self.settings_path or codemcp.user_settings(),
        )

    # ── the connection's options ──

    def apply(self, task: Any, options: Any) -> None:
        ids = self.shared.get(task.id)
        if task.kind != "code" or not ids:
            return
        servers, allowed = self.hub.connectors.build_servers()
        wanted = {server_name(conn_id) for conn_id in ids}
        add = {name: server for name, server in servers.items() if name in wanted}
        if not add:
            return
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        options.mcp_servers = {**base, **add}
        options.allowed_tools = [
            *options.allowed_tools,
            *(tool for tool in allowed if tool.split("__", 2)[1] in add),
        ]

    def key(self, task: Any) -> Any:
        if task.kind != "code":
            return None
        return (tuple(sorted(self.shared.get(task.id, ()))), self.changes.get(task.id, 0))

    def reopen(self, task: Any, note: str) -> None:
        """What the session loads changed: a new connection has it, between steps."""
        self.changes[task.id] = self.changes.get(task.id, 0) + 1
        self.hub.tasks.reopen(task.id, note)

    # ── what the window shows ──

    async def live(self, task: Any) -> dict[str, dict[str, Any]]:
        """How each of the session's servers is doing now, as Claude Code says ({} when it
        isn't connected, or doesn't answer in time)."""
        client = task.client
        if client is None:
            return {}
        try:
            status = await asyncio.wait_for(client.get_mcp_status(), STATUS_WAIT)
        except Exception:
            return {}
        servers = status.get("mcpServers") if isinstance(status, dict) else None
        found: dict[str, dict[str, Any]] = {}
        for server in servers if isinstance(servers, list) else []:
            if not isinstance(server, dict) or not isinstance(server.get("name"), str):
                continue
            tools = server.get("tools")
            found[server["name"][:64]] = {
                "status": str(server.get("status") or "")[:20],
                "error": " ".join(str(server.get("error") or "").split())[:300],
                "tools": len(tools) if isinstance(tools, list) else None,
            }
        return found

    def connectors(self, task: Any) -> list[dict[str, Any]]:
        manager = self.hub.connectors
        shared = self.shared.get(task.id, set())
        out = []
        for conn_id, conn in list(manager.connections.items())[:50]:
            live = manager.live.get(conn_id)
            out.append(
                {
                    "id": conn_id,
                    "name": conn.name,
                    "status": live.status if live else "off",
                    "on": conn_id in shared,
                }
            )
        return out

    async def state(self, task: Any, **extra: Any) -> None:
        state_path, settings_path = self.paths()
        servers = await asyncio.to_thread(codemcp.configured, task.cwd, state_path, settings_path)
        live = await self.live(task)
        rows = []
        for server in servers:
            row = server.public()
            info = live.pop(server.name, {})
            if server.approved is not False:  # (one refused here isn't the session's)
                row.update(info)
            row.update(off=server.name in task.disabled_mcp, removable=True)
            rows.append(row)
        for name, info in live.items():  # JARVIS's own, a plugin's, or claude.ai's
            rows.append(
                {
                    "name": name,
                    "scope": "shared" if name.startswith(SHARED_PREFIX) else "other",
                    "kind": "",
                    "target": "",
                    "approved": None,
                    **info,
                    "off": name in task.disabled_mcp,
                    "removable": False,
                }
            )
        folder = str(task.cwd)
        self.hub.emit(
            "cm_state",
            id=task.id,
            folder=folder,
            name=task.cwd.name,
            servers=rows,
            connectors=self.connectors(task),
            live=task.client is not None,
            signing=sorted(name for (where, name) in self.signing if where == folder),
            **extra,
        )

    # ── window commands ──

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            await self.state(task)

    async def cmd_add(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        name = str(msg.get("name") or "").strip()
        scope = msg.get("scope") if msg.get("scope") in codemcp.SCOPES else "local"
        if not codemcp.NAME.match(name):
            await self.state(
                task, error="A name is letters, digits, dots, dashes or underscores, up to 64."
            )
            return
        try:
            config = codemcp.server_config(
                str(msg.get("kind") or ""),
                str(msg.get("target") or ""),
                str(msg.get("transport") or ""),
            )
        except ValueError as exc:
            await self.state(task, error=str(exc))
            return
        code, said = await self.run(
            ["mcp", "add-json", name, json.dumps(config), "--scope", scope], task.cwd
        )
        if code != 0:
            await self.state(task, error=f"Claude Code didn't add it: {_last_line(said) or code}")
            return
        if scope == "project":  # the owner's own server: approved here as it's added
            with contextlib.suppress(OSError):
                await asyncio.to_thread(codemcp.approve, task.cwd, name, True)
        self.reopen(task, ADDED.format(name=name))
        await self.state(task, added=name)

    async def cmd_remove(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        name = str(msg.get("name") or "")
        scope = msg.get("scope")
        if not codemcp.NAME.match(name) or scope not in codemcp.SCOPES:
            return
        code, said = await self.run(["mcp", "remove", name, "--scope", scope], task.cwd)
        if code != 0:
            await self.state(
                task, error=f"Claude Code didn't remove it: {_last_line(said) or code}"
            )
            return
        self.reopen(task, REMOVED.format(name=name))
        await self.state(task)

    async def cmd_approve(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        name = str(msg.get("name") or "")
        if not codemcp.NAME.match(name):
            return
        yes = msg.get("approve") is True
        try:
            await asyncio.to_thread(codemcp.approve, task.cwd, name, yes)
        except OSError as exc:
            await self.state(task, error=str(exc))
            return
        self.reopen(task, (APPROVED if yes else REFUSED).format(name=name))
        await self.state(task)

    async def cmd_login(self, msg: dict[str, Any]) -> None:
        """Sign in to one of the session's servers (Claude Code's own sign-in, in the
        browser); it's reconnected once that's done."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        name = str(msg.get("name") or "")
        if not codemcp.NAME.match(name):
            return
        key = (str(task.cwd), name)
        if key not in self.signing:
            run = self.signing[key] = asyncio.ensure_future(self._login(task, name, key))
            self._running.add(run)
            run.add_done_callback(self._running.discard)
        await self.state(task)

    async def _login(self, task: Any, name: str, key: tuple[str, str]) -> None:
        try:
            code, said = await self.run(["mcp", "login", name], task.cwd, codemcp.LOGIN_TIMEOUT)
        finally:
            self.signing.pop(key, None)
        if code != 0:
            await self.state(task, error=f"The sign-in didn't finish: {_last_line(said) or code}")
            return
        error = await self._reconnect(task, name)
        if error:
            await self.state(task, error=error)
        else:
            await self.state(task, note=SIGNED_IN.format(name=name))

    async def _reconnect(self, task: Any, name: str) -> str:
        client = task.client
        if client is None:
            return ""  # (its next connection has it)
        try:
            await asyncio.wait_for(client.reconnect_mcp_server(name), RECONNECT_WAIT)
        except Exception as exc:
            return f"It didn't reconnect: {' '.join(str(exc).split())[:200] or type(exc).__name__}"
        return ""

    async def cmd_reconnect(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        name = str(msg.get("name") or "")
        if not codemcp.NAME.match(name):
            return
        error = await self._reconnect(task, name)
        if error:
            await self.state(task, error=error)
        else:
            await self.state(task)

    async def cmd_share(self, msg: dict[str, Any]) -> None:
        """Share one of JARVIS's connectors with the session (or stop sharing it)."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        conn = self.hub.connectors.connections.get(str(msg.get("connector") or ""))
        if conn is None:
            return
        on = msg.get("on") is True
        shared = self.shared.setdefault(task.id, set())
        if (conn.id in shared) != on:
            (shared.add if on else shared.discard)(conn.id)
            self.reopen(task, (SHARED if on else UNSHARED).format(name=conn.name))
        await self.state(task)

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind != "tasks":
            return
        for task_id in set(self.shared) - set(self.hub.tasks.tasks):
            self.shared.pop(task_id, None)  # a session let go of
            self.changes.pop(task_id, None)


class _Options:
    """What a session's connection gets from the MCP manager (TaskManager.option_hooks)."""

    def __init__(self, desk: McpDesk) -> None:
        self.desk = desk

    def apply(self, task: Any, options: Any) -> None:
        self.desk.apply(task, options)

    def key(self, task: Any) -> Any:
        return self.desk.key(task)


def install(hub: Any) -> None:
    desk = McpDesk(hub)
    hub.code_mcp = desk  # (for the tests)
    hub.tasks.option_hooks.append(_Options(desk))
    hub.add_task_sink(desk.on_task_event)
    for kind, handler in (
        ("cm_state", desk.cmd_state),
        ("cm_add", desk.cmd_add),
        ("cm_remove", desk.cmd_remove),
        ("cm_approve", desk.cmd_approve),
        ("cm_login", desk.cmd_login),
        ("cm_reconnect", desk.cmd_reconnect),
        ("cm_share", desk.cmd_share),
    ):  # (each may wait on Claude Code: never holding up the window's next command)
        hub.register_command(kind, background(hub, handler))
