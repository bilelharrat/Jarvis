"""Claude Code's plugins in Jarvis Code (codeplugins): the Plugins pane browses the
marketplaces the owner added, installs a plugin after a card that says what's in it (and a
second one for a command its marketplace would run to fetch it), switches plugins on and
off and uninstalls them; edits the project's and the owner's agents, skills, commands and
hooks in place; and shows what fills a session's context, by what put it there.

What it adds, and where:
- Window commands: cx_state {id}; cx_details {id, plugin}; cx_install {id, plugin};
  cx_enable {id, plugin, on}; cx_uninstall {id, plugin}; cx_market {id, add: source |
  remove: name | update: name}; cx_read {id, kind, scope, name}; cx_write {id, kind, scope,
  name, text, stamp}; cx_delete {id, kind, scope, name, stamp}; cx_context {id}.
- Events: cx_state {id, installed, available, marketplaces, files, error?, note?},
  cx_details {id, plugin, text, tokens}, cx_file {id, file_kind, scope, name, text, stamp,
  exists, conflict?, error?, saved?, deleted?}, cx_context {id, rows, total, max}.
- Everything through Claude Code's own plugin CLI (claude plugin …, in the session's
  folder). A plugin installed, switched or removed, or a file saved, reopens the session
  (same conversation) so it has it from its next step.

Adding a marketplace fetches it from where the owner said, and installing a plugin brings
code that can run on this Mac (its hooks and MCP servers): both ask first on a card.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
from pathlib import Path
from typing import Any

from .. import codemcp, codeplugins
from ..codeplatform import background, code_task
from ..codeplugins import Conflict, EditError

log = logging.getLogger("jarvis")

INSTALL_TIMEOUT = 180.0
CONTEXT_WAIT = 15.0
PLUGIN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}(?:@[A-Za-z0-9][A-Za-z0-9_.\-]{0,99})?$")
KIND_WORD = {"agents": "agent", "commands": "command", "skills": "skill"}
# A session's notes (the window's Chinese: web/i18n/code-plugins.json).
INSTALLED = "Installed the plugin {name}: the session has it from its next step."
REMOVED = "Removed the plugin {name}."
SWITCHED_ON = "The plugin {name} is on: the session has it from its next step."
SWITCHED_OFF = "The plugin {name} is off."
SAVED = "Saved the {kind} {name}: the session has it from its next step."
DELETED = "Deleted the {kind} {name}."
HOOKS_SAVED = "Saved the hooks: the session has them from its next step."


def _last_line(text: str) -> str:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    return lines[-1][:300] if lines else ""


class PluginDesk:
    """One hub's plugins, and its .claude files."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.run = codemcp.run_cli  # (the tests' own)
        self.user_dir: Path | None = None  # ~/.claude (the tests' own)
        self.changes: dict[int, int] = {}  # task id -> what changed for it (its key)

    def home(self) -> Path:
        if self.user_dir is not None:
            return self.user_dir
        base = os.environ.get("CLAUDE_CONFIG_DIR")
        return Path(base) if base else Path.home() / ".claude"

    def reopen(self, task: Any, note: str) -> None:
        self.changes[task.id] = self.changes.get(task.id, 0) + 1
        self.hub.tasks.reopen(task.id, note)

    def key(self, task: Any) -> Any:
        return self.changes.get(task.id, 0) if task.kind == "code" else None

    async def cli(
        self, task: Any, *args: str, timeout: float = codemcp.CLI_TIMEOUT
    ) -> tuple[int, str]:
        return await self.run(list(args), task.cwd, timeout)

    # ── the pane ──

    async def state(self, task: Any, **extra: Any) -> None:
        code, listed = await self.cli(task, "plugin", "list", "--json", "--available")
        installed, available = codeplugins.plugin_lists(
            codeplugins.json_line(listed) if code == 0 else None
        )
        code, markets = await self.cli(task, "plugin", "marketplace", "list", "--json")
        files = await asyncio.to_thread(codeplugins.list_files, task.cwd, self.home())
        self.hub.emit(
            "cx_state",
            id=task.id,
            folder=str(task.cwd),
            name=task.cwd.name,
            installed=installed,
            available=available,
            marketplaces=codeplugins.marketplaces(
                codeplugins.json_line(markets) if code == 0 else None
            ),
            files=files,
            **extra,
        )

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            await self.state(task)

    def plugin(self, msg: dict[str, Any]) -> str:
        plugin = str(msg.get("plugin") or "")
        return plugin if PLUGIN_ID.match(plugin) else ""

    async def details(self, task: Any, plugin: str) -> tuple[str, int | None]:
        code, said = await self.cli(task, "plugin", "details", plugin)
        text = said.strip()[:4000] if code == 0 else ""
        return text, codeplugins.always_on_tokens(text)

    async def cmd_details(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        plugin = self.plugin(msg)
        if task is None or not plugin:
            return
        text, tokens = await self.details(task, plugin)
        self.hub.emit("cx_details", id=task.id, plugin=plugin, text=text, tokens=tokens)

    async def cmd_install(self, msg: dict[str, Any]) -> None:
        """Install a plugin after the owner's OK on a card that says what's in it (and a
        second one for a command its marketplace declares to fetch it)."""
        task = code_task(self.hub, msg)
        plugin = self.plugin(msg)
        if task is None or not plugin:
            return
        text, _ = await self.details(task, plugin)
        choice = await self.hub.request_approval(
            f"Install the plugin {plugin}?",
            (text or f"{plugin}: its marketplace lists it.")
            + "\n\nIts hooks and MCP servers run on this Mac, in every session.",
            [("install", "Install"), ("cancel", "Not now")],
            context={"task_id": task.id, "feature": "code_plugins"},
        )
        if choice != "install":
            await self.state(task)
            return
        args = ["plugin", "install", plugin, "--scope", "user", "--json"]
        code, said = await self.cli(task, *args, timeout=INSTALL_TIMEOUT)
        result = codeplugins.json_line(said)
        shown = result.get("shownCommand") if isinstance(result, dict) else None
        if isinstance(shown, dict) and isinstance(shown.get("sha256"), str):
            command = " ".join(str(shown.get("command") or shown.get("text") or "").split())[:1500]
            again = await self.hub.request_approval(
                f"{plugin} is fetched by running a command its marketplace gives. Run it?",
                command or "(the marketplace didn't say what it runs)",
                [("run", "Run it"), ("cancel", "Not now")],
                context={"task_id": task.id, "feature": "code_plugins"},
            )
            if again != "run":
                await self.state(task)
                return
            code, said = await self.cli(
                task, *args, "--accept-command", shown["sha256"], timeout=INSTALL_TIMEOUT
            )
            result = codeplugins.json_line(said)
        ok = code == 0 and (not isinstance(result, dict) or result.get("outcome") in (None, "ok"))
        if not ok:
            why = result.get("message") if isinstance(result, dict) else _last_line(said)
            await self.state(task, error=f"It wasn't installed: {str(why or code)[:300]}")
            return
        self.reopen(task, INSTALLED.format(name=plugin))
        await self.state(task, note=f"Installed {plugin}.")

    async def cmd_enable(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        plugin = self.plugin(msg)
        if task is None or not plugin:
            return
        on = msg.get("on") is True
        code, said = await self.cli(task, "plugin", "enable" if on else "disable", plugin)
        if code != 0:
            await self.state(task, error=f"Claude Code said: {_last_line(said) or code}")
            return
        self.reopen(task, (SWITCHED_ON if on else SWITCHED_OFF).format(name=plugin))
        await self.state(task)

    async def cmd_uninstall(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        plugin = self.plugin(msg)
        if task is None or not plugin:
            return
        code, said = await self.cli(task, "plugin", "uninstall", plugin, "--json")
        if code != 0:
            await self.state(task, error=f"It wasn't removed: {_last_line(said) or code}")
            return
        self.reopen(task, REMOVED.format(name=plugin))
        await self.state(task)

    async def cmd_market(self, msg: dict[str, Any]) -> None:
        """A marketplace added (after a card: it's fetched from where the owner said),
        removed, or brought up to date."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        if isinstance(msg.get("add"), str) and msg["add"].strip():
            source = " ".join(msg["add"].split())[:500]
            if source.startswith("-"):
                await self.state(
                    task,
                    error="That isn't a marketplace: give a GitHub repo, an address or a folder.",
                )
                return
            choice = await self.hub.request_approval(
                "Add this plugin marketplace?",
                f"{source}\n\nClaude Code fetches its list of plugins from there; nothing is installed until you pick one.",
                [("add", "Add it"), ("cancel", "Not now")],
                context={"task_id": task.id, "feature": "code_plugins"},
            )
            if choice != "add":
                await self.state(task)
                return
            code, said = await self.cli(
                task, "plugin", "marketplace", "add", source, timeout=INSTALL_TIMEOUT
            )
            if code != 0:
                await self.state(task, error=f"It wasn't added: {_last_line(said) or code}")
                return
            await self.state(task, note=_last_line(said).lstrip("✔ ") or "Added.")
            return
        for action in ("remove", "update"):
            name = msg.get(action)
            if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}", name):
                code, said = await self.cli(
                    task, "plugin", "marketplace", action, name, timeout=INSTALL_TIMEOUT
                )
                if code != 0:
                    await self.state(task, error=f"Claude Code said: {_last_line(said) or code}")
                else:
                    await self.state(task)
                return

    # ── the .claude files ──

    def where(self, task: Any, msg: dict[str, Any]) -> tuple[str, str, str, Path]:
        """The file a command names: (kind, scope, name, path); EditError when it isn't one."""
        kind, scope, name = (str(msg.get(k) or "") for k in ("kind", "scope", "name"))
        if kind == "hooks":
            return kind, scope, "", codeplugins.settings_path(scope, task.cwd, self.home())
        return kind, scope, name, codeplugins.file_path(kind, scope, name, task.cwd, self.home())

    async def cmd_read(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        try:
            kind, scope, name, path = self.where(task, msg)
        except EditError as exc:
            self.hub.emit("cx_file", id=task.id, error=str(exc))
            return
        reader = codeplugins.read_hooks if kind == "hooks" else codeplugins.read_file
        text, stamp = await asyncio.to_thread(reader, path)
        exists = bool(stamp) if kind != "hooks" else True
        if kind != "hooks" and not exists:
            text = codeplugins.TEMPLATES[kind].format(name=name.rsplit("/", 1)[-1])
        self.hub.emit(
            "cx_file",
            id=task.id,
            file_kind=kind,
            scope=scope,
            name=name,
            text=text,
            stamp=stamp,
            exists=exists,
        )

    async def cmd_write(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        text, stamp = str(msg.get("text") or ""), str(msg.get("stamp") or "")
        try:
            kind, scope, name, path = self.where(task, msg)
            writer = codeplugins.write_hooks if kind == "hooks" else codeplugins.write_file
            new = await asyncio.to_thread(writer, path, text, stamp)
        except Conflict as exc:
            self.hub.emit(
                "cx_file", id=task.id, file_kind=msg.get("kind"), scope=msg.get("scope"), name=msg.get("name"),
                conflict=exc.current, error="It changed on disk since you opened it.",
            )  # fmt: skip
            return
        except (EditError, OSError) as exc:
            self.hub.emit(
                "cx_file",
                id=task.id,
                file_kind=msg.get("kind"),
                scope=msg.get("scope"),
                name=msg.get("name"),
                error=str(exc)[:300],
            )
            return
        self.hub.emit(
            "cx_file",
            id=task.id,
            file_kind=kind,
            scope=scope,
            name=name,
            text=text,
            stamp=new,
            exists=True,
            saved=True,
        )
        note = HOOKS_SAVED if kind == "hooks" else SAVED.format(kind=KIND_WORD[kind], name=name)
        self.reopen(task, note)
        await self.state(task)

    async def cmd_delete(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        try:
            kind, _scope, name, path = self.where(task, msg)
            if kind == "hooks":
                raise EditError("Hooks are emptied, not deleted.")
            await asyncio.to_thread(codeplugins.delete_file, path, str(msg.get("stamp") or ""))
        except Conflict as exc:
            self.hub.emit("cx_file", id=task.id, file_kind=msg.get("kind"), scope=msg.get("scope"), name=msg.get("name"),
                          conflict=exc.current, error="It changed on disk since you opened it.")  # fmt: skip
            return
        except (EditError, OSError) as exc:
            self.hub.emit("cx_file", id=task.id, error=str(exc)[:300])
            return
        self.hub.emit(
            "cx_file", id=task.id, file_kind=kind, scope=msg.get("scope"), name=name, deleted=True
        )
        self.reopen(task, DELETED.format(kind=KIND_WORD[kind], name=name))
        await self.state(task)

    async def cmd_context(self, msg: dict[str, Any]) -> None:
        """What fills the session's context now, by what put it there."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        usage = None
        if task.client is not None:
            with contextlib.suppress(Exception):
                usage = await asyncio.wait_for(task.client.get_context_usage(), CONTEXT_WAIT)
        usage = usage if isinstance(usage, dict) else {}
        total, most = usage.get("totalTokens"), usage.get("maxTokens")
        self.hub.emit(
            "cx_context",
            id=task.id,
            live=task.client is not None,
            rows=codeplugins.context_rows(usage),
            total=total if isinstance(total, int) else None,
            max=most if isinstance(most, int) else None,
        )

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind == "tasks":
            for task_id in set(self.changes) - set(self.hub.tasks.tasks):
                self.changes.pop(task_id, None)


class _Options:
    """A session's key for what changed in its plugins and files (TaskManager.option_hooks):
    the connection itself takes them from Claude Code's own settings."""

    def __init__(self, desk: PluginDesk) -> None:
        self.desk = desk

    @staticmethod
    def apply(_task: Any, _options: Any) -> None:
        return None

    def key(self, task: Any) -> Any:
        return self.desk.key(task)


def install(hub: Any) -> None:
    desk = PluginDesk(hub)
    hub.code_plugins = desk  # (for the tests)
    hub.tasks.option_hooks.append(_Options(desk))
    hub.add_task_sink(desk.on_task_event)
    for kind, handler in (
        ("cx_state", desk.cmd_state),
        ("cx_details", desk.cmd_details),
        ("cx_install", desk.cmd_install),
        ("cx_enable", desk.cmd_enable),
        ("cx_uninstall", desk.cmd_uninstall),
        ("cx_market", desk.cmd_market),
        ("cx_read", desk.cmd_read),
        ("cx_write", desk.cmd_write),
        ("cx_delete", desk.cmd_delete),
        ("cx_context", desk.cmd_context),
    ):  # (each may wait on Claude Code or a card: never holding up the window's next command)
        hub.register_command(kind, background(hub, handler))
