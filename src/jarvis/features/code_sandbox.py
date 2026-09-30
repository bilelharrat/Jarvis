"""Claude Code's sandbox for Jarvis Code sessions that run unwatched (codesandbox): with the
switch on, a session in Bypass permissions, or an unattended one, runs its commands in
Claude Code's sandbox, where they can write only in the project (and its added folders) and
reach only the domains the owner allowed for the project; any session can also be put in
it, or kept out, on its own.

What it adds, and where:
- TaskManager.option_hooks: the sandbox settings (enabled, no way out of it for a command,
  the project's allowlist, this Mac's own servers reachable) on a session's connection. Its
  key is whether it's on and the allowlist, so either changing reopens the session, same
  conversation, between steps. A sandbox another feature set (an unattended run's own, for
  an issue's untrusted text) is left as it is.
- A task sink: a session switched into Bypass (or out of it) reopens with the sandbox at
  once when it's idle, or when its step ends.
- TaskManager.rule_check (beside the permission rules: the strictest answer wins): while a
  session should be in the sandbox but its connection isn't yet, its commands ask first.
- Window commands: cs_state {id}, cs_session {id, on: true | false | null (the default)},
  cs_domains {id, add: [domain] | preset, remove: domain}; each answers with cs_state.
- Settings (feature prefs): code_sandbox_bypass (off by default: today's behaviour).

The allowlists are JARVIS's, in code_sandbox.json beside the settings.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .. import prefs
from ..codeplatform import add_rule_check, code_task, project_of
from ..codesandbox import PRESETS, DomainError, SandboxBook

log = logging.getLogger("jarvis")

PREF = "code_sandbox_bypass"
prefs.register_feature_pref(PREF, False)

# What a session's transcript says as the sandbox comes or goes (the window's Chinese:
# web/i18n/code-sandbox.json).
NOW_ON = "Commands run in the sandbox now: they can write only in the project and reach only the domains allowed for it."
NOW_OFF = "Commands run outside the sandbox now."
ALLOWLIST = "The sandbox's allowed domains changed; it goes on with them."
PENDING = "the sandbox (on at this session's next step)"
DOMAINS_AT_ONCE = 20  # domains one window command may add


class SandboxDesk:
    """One hub's sandbox switch and allowlists."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._book: SandboxBook | None = None
        self.own: dict[int, bool] = {}  # task id -> the session's own choice
        self._applied: dict[int, tuple[bool, tuple[str, ...]]] = {}  # what its connection has

    @property
    def book(self) -> SandboxBook:
        """The allowlists, read at first use (never at install: tests make many hubs)."""
        if self._book is None:
            self._book = SandboxBook(self.hub.feature_path("code_sandbox.json"))
        return self._book

    def project(self, task: Any) -> str:
        return project_of(self.hub, task)

    def unattended(self, task: Any) -> bool:
        """An unattended run's session ("Run this without me", features.code_unattended)."""
        runs = getattr(getattr(self.hub, "code_runs", None), "active", None)
        return isinstance(runs, dict) and task.id in runs

    def wanted(self, task: Any) -> bool:
        """Whether a session's commands should run in the sandbox."""
        if task.kind != "code":
            return False
        if task.id in self.own:
            return self.own[task.id]
        if self.hub.prefs.feature(PREF) is not True:
            return False
        return task.mode == "auto" or self.unattended(task)

    def key(self, task: Any) -> Any:
        if not self.wanted(task):
            return None
        return (True, tuple(self.book.domains(self.project(task))))

    def apply(self, task: Any, options: Any) -> None:
        """TaskManager.option_hooks: the sandbox on this connection, when it's wanted."""
        if task.kind != "code":
            return
        wanted = self.wanted(task)
        domains = tuple(self.book.domains(self.project(task))) if wanted else ()
        if wanted and options.sandbox is None:  # (another feature's own sandbox stands)
            options.sandbox = {
                "enabled": True,
                "autoAllowBashIfSandboxed": False,  # JARVIS still decides what may run
                "allowUnsandboxedCommands": False,  # no way out for a command
                "network": {"allowedDomains": list(domains), "allowLocalBinding": True},
            }
        self._applied[task.id] = (wanted and options.sandbox is not None, domains)

    def check(self, task: Any, tool: str, _tool_input: dict[str, Any]) -> Any:
        """TaskManager.rule_check: a command asks first while the sandbox this session
        should have isn't on its connection yet (switched into Bypass mid-step)."""
        if tool != "Bash" or task.client is None or not self.wanted(task):
            return None
        applied = self._applied.get(task.id)
        return None if applied is not None and applied[0] else ("ask", PENDING)

    def settle(self, task: Any) -> None:
        """A session whose connection doesn't have the sandbox it should (or has one it
        shouldn't): reopened, same conversation, between steps."""
        applied = self._applied.get(task.id)
        if task.client is None or applied is None or task.kind != "code":
            return
        wanted = self.wanted(task)
        same = not wanted or applied[1] == tuple(self.book.domains(self.project(task)))
        if applied[0] == wanted and same:
            return
        if task.reopen:
            return  # (a reopen is on its way: it takes this up)
        note = ALLOWLIST if applied[0] and wanted else NOW_ON if wanted else NOW_OFF
        self.hub.tasks.reopen(task.id, note)

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind != "tasks":
            return
        tasks = self.hub.tasks.tasks
        for task_id in [t for t in self._applied if t not in tasks]:
            self._applied.pop(task_id, None)  # sessions let go of
            self.own.pop(task_id, None)
        for task in list(tasks.values()):
            self.settle(task)

    # ── the window ──

    def state(self, task: Any, **extra: Any) -> None:
        project = self.project(task)
        applied = self._applied.get(task.id)
        self.hub.emit(
            "cs_state",
            id=task.id,
            on=self.wanted(task),
            own=self.own.get(task.id),
            default=self.hub.prefs.feature(PREF) is True,
            bypass=task.mode == "auto",
            unattended=self.unattended(task),
            live=bool(task.client is not None and applied is not None and applied[0]),
            project=project,
            name=Path(project).name,
            domains=self.book.domains(project),
            presets={k: list(v) for k, v in PRESETS.items()},
            **extra,
        )

    def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self.state(task)

    def cmd_session(self, msg: dict[str, Any]) -> None:
        """One session's own choice: in the sandbox, out of it, or back to the default."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        on = msg.get("on")
        if on is None:
            self.own.pop(task.id, None)
        elif isinstance(on, bool):
            self.own[task.id] = on
        self.settle(task)
        self.state(task)

    def cmd_domains(self, msg: dict[str, Any]) -> None:
        """The project's allowlist: domains added (or a preset's), or one removed."""
        task = code_task(self.hub, msg)
        if task is None:
            return
        project = self.project(task)
        add = msg.get("add")
        try:
            if isinstance(add, str) and add in PRESETS:
                self.book.add(project, list(PRESETS[add]))
            elif isinstance(add, list):
                self.book.add(project, [str(d) for d in add[:DOMAINS_AT_ONCE]])
            elif isinstance(msg.get("remove"), str):
                self.book.remove(project, msg["remove"])
        except DomainError as exc:
            self.state(task, error=str(exc))
            return
        except OSError:
            self.state(task, error="Couldn't save that; try again.")
            return
        for other in list(self.hub.tasks.tasks.values()):
            if other.kind == "code" and self.project(other) == project:
                self.settle(other)
        self.state(task)

    def on_prefs(self, _event: dict[str, Any]) -> None:
        """The switch may have changed: sessions it covers take it up."""
        for task in list(self.hub.tasks.tasks.values()):
            self.settle(task)


class _Options:
    """What a session's connection gets from the sandbox (TaskManager.option_hooks)."""

    def __init__(self, desk: SandboxDesk) -> None:
        self.desk = desk

    def apply(self, task: Any, options: Any) -> None:
        self.desk.apply(task, options)

    def key(self, task: Any) -> Any:
        return self.desk.key(task)


def install(hub: Any) -> None:
    desk = SandboxDesk(hub)
    hub.code_sandbox = desk  # (for the other Jarvis Code features and the tests)
    hub.tasks.option_hooks.append(_Options(desk))
    add_rule_check(hub.tasks, desk.check)
    hub.add_task_sink(desk.on_task_event)
    hub.add_event_sink(["prefs"], desk.on_prefs)
    hub.register_command("cs_state", desk.cmd_state)
    hub.register_command("cs_session", desk.cmd_session)
    hub.register_command("cs_domains", desk.cmd_domains)
