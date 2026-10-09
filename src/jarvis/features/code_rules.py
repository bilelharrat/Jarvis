"""The owner's permission rules for Eden Code (coderules): allow, ask or deny a session's
steps by web domain, MCP server or tool, file path or command, per project; the editor for
them (the Permissions pane); and import from and export to a project's .claude settings.

What it adds, and where:
- TaskManager.rule_check: every step a session asks about is weighed against the rules
  first (deny beats ask beats allow; a deny or an ask holds in every mode, Bypass too).
- TaskManager.option_hooks: the project's deny rules as Claude Code's own disallowed
  tools, and its ask rules in the session's settings, so they hold where Claude Code
  decides by itself too (Auto mode's safety check). Its key is those rules: a change
  reopens an open session in that project between steps (JARVIS's own check applies at
  once either way).
- Window commands: cr_state {id}, cr_add {id, behavior, rule}, cr_remove {id, behavior,
  rule}, cr_import {id}, cr_export {id, target: "local" | "project"}; each answers with
  cr_state for that session.

The rules are JARVIS's, kept in code_rules.json beside the settings: nothing is written into
a project unless the owner exports them (a second press in the pane).

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from .. import coderules
from ..codeplatform import add_rule_check, code_task, project_of
from ..coderules import BEHAVIORS, RuleBook, RuleError

log = logging.getLogger("jarvis")

REOPEN_NOTE = "Permission rules changed; it goes on with them."


def merge_ask(settings: str | None, ask: list[str]) -> str | None:
    """A session's settings (Claude Code's --settings JSON, or None) with these ask rules
    added to its own. A settings file's path is left as it is (it can't be added to)."""
    base: dict[str, Any] = {}
    if settings:
        try:
            parsed = json.loads(settings)
        except ValueError:
            log.warning(
                "Eden Code rules: a session's settings aren't JSON; its ask rules hold in JARVIS only"
            )
            return settings
        if not isinstance(parsed, dict):
            return settings
        base = parsed
    permissions = base.get("permissions") if isinstance(base.get("permissions"), dict) else {}
    have = permissions.get("ask") if isinstance(permissions.get("ask"), list) else []
    permissions["ask"] = [*have, *(r for r in ask if r not in have)]
    base["permissions"] = permissions
    return json.dumps(base)


class RuleDesk:
    """One hub's permission rules."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._book: RuleBook | None = None
        self._applied: dict[int, Any] = {}  # task id -> the rules its connection was given

    @property
    def book(self) -> RuleBook:
        """The rules, read at first use (never at install: tests make many hubs)."""
        if self._book is None:
            self._book = RuleBook(self.hub.feature_path("code_rules.json"))
        return self._book

    def project(self, task: Any) -> str:
        return project_of(self.hub, task)

    def rules_of(self, task: Any) -> dict[str, list[str]]:
        """The rules of a session's project. With none kept for any project that's none,
        and an isolated copy's project isn't looked up (that follows every copy's folder
        on the disk, and every step a session asks about is checked)."""
        book = self.book
        return book.rules(self.project(task) if book.projects else "")

    def check(self, task: Any, tool: str, tool_input: dict[str, Any]) -> tuple[str, str] | None:
        """TaskManager.rule_check."""
        if task.kind != "code":
            return None
        return coderules.decide(self.rules_of(task), tool, tool_input, task.cwd)

    # ── a session's options ──

    def key(self, task: Any) -> Any:
        if task.kind != "code":
            return None
        rules = self.rules_of(task)
        return (tuple(rules["deny"]), tuple(rules["ask"]))

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code":
            return
        rules = self.rules_of(task)
        self._applied[task.id] = (tuple(rules["deny"]), tuple(rules["ask"]))
        if rules["deny"]:
            options.disallowed_tools = [*options.disallowed_tools, *rules["deny"]]
        if rules["ask"]:
            options.settings = merge_ask(options.settings, rules["ask"])

    def changed(self, project: str) -> None:
        """A project's rules changed: its open sessions take them now (JARVIS's check, and
        questions already waiting look again) and at their next connection (Claude Code's)."""
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code" or self.project(task) != project:
                continue
            self.hub.tasks._loosen(task)  # a card waiting on a step an allow now covers goes
            applied = self._applied.get(task.id)
            if task.client is not None and applied is not None and applied != self.key(task):
                self.hub.tasks.reopen(task.id, REOPEN_NOTE)

    # ── window commands ──

    async def state(self, task: Any, **extra: Any) -> None:
        project = self.project(task)
        claude = await asyncio.to_thread(coderules.read_claude, Path(project))
        self.hub.emit(
            "cr_state",
            id=task.id,
            project=project,
            name=Path(project).name,
            rules=self.book.rules(project),
            legacy=self.hub.tasks.rules.for_project(task.cwd),
            claude=claude,
            **extra,
        )

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            await self.state(task)

    async def cmd_add(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        project = self.project(task)
        try:
            rule = self.book.add(
                project, str(msg.get("behavior") or ""), str(msg.get("rule") or "")
            )
        except RuleError as exc:
            await self.state(task, error=str(exc))
            return
        except OSError:
            await self.state(task, error="Couldn't save that rule; try again.")
            return
        self.changed(project)
        await self.state(task, added=rule)

    async def cmd_remove(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        project = self.project(task)
        try:
            removed = self.book.remove(
                project, str(msg.get("behavior") or ""), str(msg.get("rule") or "")
            )
        except OSError:
            await self.state(task, error="Couldn't save that; try again.")
            return
        if removed:
            self.changed(project)
        await self.state(task)

    async def cmd_import(self, msg: dict[str, Any]) -> None:
        """The rules in the project's .claude settings files, into JARVIS's for it."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        project = self.project(task)
        found = await asyncio.to_thread(coderules.read_claude, Path(project))
        have = self.book.rules(project)
        added = skipped = 0
        # Every file's rules weighed together, as Claude Code does: a deny beats an ask beats
        # an allow, whichever file says it. (BEHAVIORS runs strictest first.)
        wanted: dict[str, int] = {}  # rule -> the strictest behavior any file gives it
        for rules in found.values():
            for strictness, behavior in enumerate(BEHAVIORS):
                for text in rules.get(behavior, []):
                    rule = coderules.valid(text)
                    if rule is None:
                        skipped += 1
                    else:
                        wanted[rule.text] = min(wanted.get(rule.text, strictness), strictness)
        try:
            for text, strictness in wanted.items():
                # The files are the project's words, not the owner's: a rule the owner keeps
                # as strictly or more (their deny, say) is never loosened by one.
                kept = next((i for i, b in enumerate(BEHAVIORS) if text in have[b]), None)
                if kept is not None and kept <= strictness:
                    continue
                self.book.add(project, BEHAVIORS[strictness], text)
                added += 1
        except (RuleError, OSError) as exc:
            await self.state(task, error=f"Stopped importing: {exc}")
            return
        if added:
            self.changed(project)
        note = (
            f"Imported {added} rule{'' if added == 1 else 's'}."
            if added
            else "Nothing new to import."
        )
        if skipped:
            note += f" Left out {skipped} this can't read."
        await self.state(task, note=note)

    async def cmd_export(self, msg: dict[str, Any]) -> None:
        """JARVIS's rules for the project (and its "don't ask again" commands, as Bash
        rules) into one of its .claude settings files, beside what's already there."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        target = "project" if msg.get("target") == "project" else "local"
        project = self.project(task)
        rules = self.book.rules(project)
        legacy = [f"Bash({key}:*)" for key in self.hub.tasks.rules.for_project(task.cwd)]
        rules["allow"] = [*rules["allow"], *(r for r in legacy if r not in rules["allow"])]
        name = coderules.CLAUDE_FILES[target]
        try:
            added = await asyncio.to_thread(coderules.write_claude, Path(project), target, rules)
        except (OSError, ValueError) as exc:
            await self.state(task, error=str(exc))
            return
        note = (
            f"Added {added} rule{'' if added == 1 else 's'} to .claude/{name}."
            if added
            else f"They're all in .claude/{name} already."
        )
        await self.state(task, note=note)


class _Options:
    """What a session's connection gets from the rules (TaskManager.option_hooks)."""

    def __init__(self, desk: RuleDesk) -> None:
        self.desk = desk

    def apply(self, task: Any, options: Any) -> None:
        self.desk.apply(task, options)

    def key(self, task: Any) -> Any:
        return self.desk.key(task)


def install(hub: Any) -> None:
    desk = RuleDesk(hub)
    hub.code_rules = desk  # (for the other Eden Code features and the tests)
    add_rule_check(hub.tasks, desk.check)
    hub.tasks.option_hooks.append(_Options(desk))
    hub.register_command("cr_state", desk.cmd_state)
    hub.register_command("cr_add", desk.cmd_add)
    hub.register_command("cr_remove", desk.cmd_remove)
    hub.register_command("cr_import", desk.cmd_import)
    hub.register_command("cr_export", desk.cmd_export)
