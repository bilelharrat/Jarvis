"""The owner's secrets for a Jarvis Code session, asked for on a masked card and never seen by
Claude.

A session that needs an API key or a password (a CLI login, a test against a real service)
calls ask_secret(name, why). The owner gets a card in the transcript with a masked field,
types the value and picks where it's kept:

- This session: a Keychain entry of its own, deleted when the session ends (and swept at the
  next start, should the app have quit first).
- This project: a Keychain entry kept for every session in the project's folder, until the
  owner removes it (the "Secrets" pane).

Claude only ever gets a placeholder: $SECRET_STRIPE_KEY. How the value reaches a command, and
nothing else:

- A session's Bash command that names a placeholder is run through secret_run.py (JARVIS's
  own Python, isolated), which reads the values from the Keychain into that one command's
  environment and scrubs them from everything it prints, so the tool output Claude and the
  transcript get carries $SECRET_… instead. The value is never on a command line, in a file
  or in the session's own environment: a command that doesn't go through it has no value.
  (The rewrite is the session's permission policy's own answer, after the owner's rules and
  cards have looked at the command as Claude wrote it; a PreToolUse hook sends every such
  command there, past any allow rule in the owner's settings.)
- A step that would show Claude a file holding a value (Read, Edit's snippet, Grep's lines)
  is refused, naming the placeholder to use instead.
- Everything the session records (transcript entries, tool output, live words, exports) goes
  through a redaction pass (TaskManager.redactors) that replaces each value with its
  placeholder, belt and braces.
- The value goes from the card straight to the Keychain: it is never logged, kept in prefs,
  sent back to a window, or shown again (the Secrets pane lists names only).

Values are Keychain items under connectors.SERVICE, "code-secret:<scope>:<NAME>"; the names
of each project's secrets (no values) are kept in code-secrets.json beside the app's files.

Cost policy: no model is called; ask_secret is a card for the owner, never a model call.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import re
import secrets
import shlex
import sys
import uuid
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    HookMatcher,
    PermissionResultAllow,
    create_sdk_mcp_server,
    tool,
)

from .. import jsonstore, lang, secret_run, tasks
from ..connectors import SERVICE

log = logging.getLogger("jarvis")

SERVER = "jarvis_secrets"
ASK_TOOL = f"mcp__{SERVER}__ask_secret"
LIST_TOOL = f"mcp__{SERVER}__secrets"
VAULT_PREFIX = "code-secret:"
ASK_WAIT = 600.0  # seconds a card waits for the owner
MAX_SECRETS = 20  # per session, and per project
VALUE_MAX = 10_000
VALUE_MIN = 4  # shorter isn't a secret (and would scrub every "the" from the transcript)
NAME = re.compile(r"^SECRET_[A-Z0-9_]{1,48}$")
PLACEHOLDER = re.compile(r"\$\{?(SECRET_[A-Z0-9_]{1,48})\}?")
READS = {"Read", "NotebookRead"}
SNIPPETS = {"Edit", "MultiEdit"}  # their result shows Claude the file around the change
FILE_BYTES = 5_000_000  # a file bigger than this is only checked this far
GREP_FILES = 3000  # files a Grep's folder is checked through, at most
GREP_BYTES = 40_000_000

lang.add_texts(
    {
        "Secrets": "密钥",
        "Jarvis Code asks for a secret": "Jarvis Code 请求一个密钥",
        "This session": "仅此会话",
        "This project": "此项目",
        "Saved for this session.": "已为此会话保存。",
        "Saved for this project, in the Keychain.": "已为此项目保存在钥匙串中。",
        "You declined.": "你已拒绝。",
        "No answer: the request expired.": "没有回应：请求已过期。",
        "That secret is too short or too long.": "这个密钥太短或太长。",
        "That request isn't waiting any more.": "这个请求已不再等待。",
        "I couldn't save it in the Keychain, so nothing changed.": "无法保存到钥匙串，所以没有任何改动。",
        "Removed.": "已删除。",
    }
)


def clean_name(raw: Any) -> str:
    """ "stripe key", "STRIPE_KEY", "$SECRET_STRIPE_KEY" → "SECRET_STRIPE_KEY"; "" if none."""
    text = re.sub(r"[^A-Za-z0-9]+", "_", str(raw or "")).strip("_").upper()
    text = re.sub(r"^SECRET_", "", text)
    if not text:
        return ""
    name = f"SECRET_{text}"[:55]
    return name if NAME.match(name) else ""


def project_scope(cwd: Path) -> str:
    """The Keychain scope of a project's secrets: its folder, hashed."""
    return _scope_of_folder(_folder(cwd))


def _folder(cwd: Path) -> str:
    """A project's folder as its secrets are kept by (symlinks followed): a few file system
    calls, so it's looked up once per pass, never once per name."""
    return str(Path(cwd).resolve())


def _scope_of_folder(folder: str) -> str:
    return "p-" + hashlib.sha256(folder.encode()).hexdigest()[:20]


def wrap(command: str, names: dict[str, str], python: str | None = None) -> str:
    """The command as it runs: through secret_run.py, with each NAME's Keychain account."""
    shell = os.environ.get("SHELL", "")
    shell = (
        shell if Path(shell).name in ("zsh", "bash") and Path(shell).is_absolute() else "/bin/bash"
    )
    pairs = [f"{name}={account}" for name, account in sorted(names.items())]
    return shlex.join(
        [
            python or sys.executable,
            "-I",
            str(Path(secret_run.__file__).resolve()),
            SERVICE,
            *pairs,
            "--",
            shell,
            "-c",
            command,
        ]
    )


def named_in(command: str) -> set[str]:
    return set(PLACEHOLDER.findall(command or ""))


class Secrets:
    """The secrets of every session and project, by name; values only in the Keychain (and,
    for the redaction pass, in memory once read)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.vault = hub.connectors.vault
        self.path = hub.feature_path("code-secrets.json")
        self.sessions: dict[int, str] = {}  # task id -> its session scope
        self.session_names: dict[int, set[str]] = {}
        self.values: dict[tuple[str, str], str] = {}  # (scope, name) -> value, once read
        self.asks: dict[str, dict[str, Any]] = {}  # card id -> {future, task_id, name, entry}
        self._index: dict[str, Any] | None = None

    # ── the index (names only) ──

    def index(self) -> dict[str, Any]:
        if self._index is None:
            try:
                data = jsonstore.load_json(self.path, dict)
            except jsonstore.Unreadable:
                data = {}
            data = data if isinstance(data, dict) else {}
            projects = data.get("projects") if isinstance(data.get("projects"), dict) else {}
            scopes = data.get("sessions") if isinstance(data.get("sessions"), dict) else {}
            self._index = {
                "projects": {
                    str(k): sorted({n for n in v if isinstance(n, str) and NAME.match(n)})
                    for k, v in projects.items()
                    if isinstance(v, list)
                },
                # Session scopes not yet cleared away, with their names: swept at the next start.
                "sessions": {
                    str(k): sorted({n for n in v if isinstance(n, str) and NAME.match(n)})
                    for k, v in scopes.items()
                    if str(k).startswith("s-") and isinstance(v, list)
                },
            }
        return self._index

    def _save(self) -> None:
        try:
            jsonstore.save_json(self.path, {"version": 1, **self.index()})
        except OSError:
            log.warning("couldn't save the list of Jarvis Code secrets' names")

    # ── a session's secrets ──

    def session_scope(self, task_id: int) -> str:
        scope = self.sessions.get(task_id)
        if scope is None:
            scope = self.sessions[task_id] = "s-" + secrets.token_hex(10)
        return scope

    def project_names(self, cwd: Path) -> list[str]:
        projects = self.index()["projects"]
        if not projects:  # (no project has any: where the folder leads needn't be looked up)
            return []
        return list(projects.get(_folder(cwd), []))

    def _scopes(self, task: Any, make: bool = False) -> dict[str, Any]:
        """{NAME: its scope} of a session's secrets: its own, over its project's (the
        project's folder looked up once). make: a session scope is made if it has none."""
        out: dict[str, Any] = {}
        projects = self.index()["projects"]
        if projects:
            folder = _folder(task.cwd)
            names = projects.get(folder)
            if names:
                out = dict.fromkeys(names, _scope_of_folder(folder))
        own = self.session_names.get(task.id)
        if own:
            scope = self.session_scope(task.id) if make else self.sessions.get(task.id)
            for name in own:
                out[name] = scope
        return out

    def names_for(self, task: Any) -> dict[str, str]:
        """{NAME: Keychain account} of a session's secrets: its own, over its project's."""
        return {name: f"{VAULT_PREFIX}{scope}:{name}" for name, scope in self._scopes(task).items()}

    def scope_of(self, task: Any, name: str) -> str:
        if name in self.session_names.get(task.id, ()):
            return self.session_scope(task.id)
        return project_scope(task.cwd)

    def value(self, scope: str, name: str) -> str | None:
        key = (scope, name)
        if key not in self.values:
            try:
                found = self.vault.get(f"{VAULT_PREFIX}{scope}", name)
            except Exception:
                return None  # a locked Keychain: not cached, asked again next time
            self.values[key] = found or ""  # (none saved: not asked again on every line)
        return self.values[key] or None

    def values_for(self, task: Any) -> dict[str, str]:
        """{value: $NAME} for a session's secrets, for the redaction pass."""
        out: dict[str, str] = {}
        for name, scope in self._scopes(task, make=True).items():
            found = self.value(scope, name)
            if found and len(found) >= VALUE_MIN:
                out[found] = f"${name}"
        return out

    def redact(self, task: Any, text: str) -> str:
        """Every value a session's text holds, replaced by its placeholder. Called for each
        piece of live words of every session: with no secret given anywhere (the usual
        case) it touches nothing, not even the disk to see where the folder leads."""
        if not text or task is None or getattr(task, "kind", "") != "code":
            return text
        if not self.session_names.get(task.id) and not self.index()["projects"]:
            return text
        for found, placeholder in sorted(
            self.values_for(task).items(), key=lambda vp: len(vp[0]), reverse=True
        ):
            text = text.replace(found, placeholder)
        return text

    def save(self, task: Any, name: str, value: str, scope_kind: str) -> str:
        """Keep a value: in the Keychain for the session or the project. Raises ValueError
        (with a sentence for the owner, never the value)."""
        if scope_kind == "project":
            scope = project_scope(task.cwd)
            names = set(self.project_names(task.cwd))
            if name not in names and len(names) >= MAX_SECRETS:
                raise ValueError(f"This project already has {MAX_SECRETS} secrets.")
        else:
            scope = self.session_scope(task.id)
            names = self.session_names.get(task.id, set())
            if name not in names and len(names) >= MAX_SECRETS:
                raise ValueError(f"This session already has {MAX_SECRETS} secrets.")
        try:
            self.vault.set(f"{VAULT_PREFIX}{scope}", name, value)
        except Exception:
            raise ValueError("I couldn't save it in the Keychain, so nothing changed.") from None
        self.values[(scope, name)] = value
        index = self.index()
        if scope_kind == "project":
            path = str(Path(task.cwd).resolve())
            index["projects"][path] = sorted({*index["projects"].get(path, []), name})
            # One kept for the project wins over the session's own from now on.
            self.session_names.get(task.id, set()).discard(name)
        else:
            self.session_names.setdefault(task.id, set()).add(name)
            index["sessions"][scope] = sorted({*index["sessions"].get(scope, []), name})
        self._save()
        return scope

    def remove(self, task: Any, name: str, scope_kind: str) -> bool:
        if scope_kind == "project":
            path = str(Path(task.cwd).resolve())
            names = self.index()["projects"].get(path, [])
            if name not in names:
                return False
            scope = project_scope(task.cwd)
            self.index()["projects"][path] = [n for n in names if n != name]
            if not self.index()["projects"][path]:
                del self.index()["projects"][path]
        else:
            if name not in self.session_names.get(task.id, set()):
                return False
            scope = self.session_scope(task.id)
            self.session_names[task.id].discard(name)
            kept = [n for n in self.index()["sessions"].get(scope, []) if n != name]
            self.index()["sessions"][scope] = kept
        with contextlib.suppress(Exception):
            self.vault.delete(f"{VAULT_PREFIX}{scope}", name)
        self.values.pop((scope, name), None)
        self._save()
        return True

    def session_ended(self, task_id: int) -> None:
        """A session that ended or was let go: its own secrets leave the Keychain."""
        scope = self.sessions.pop(task_id, None)
        names = self.session_names.pop(task_id, set())
        if scope is None:
            return
        for name in names:
            with contextlib.suppress(Exception):
                self.vault.delete(f"{VAULT_PREFIX}{scope}", name)
            self.values.pop((scope, name), None)
        index = self.index()
        if index["sessions"].pop(scope, None) is not None:
            self._save()

    def sweep(self) -> int:
        """At startup: session secrets left by a run that quit before its sessions ended
        leave the Keychain (this run's sessions have scopes of their own)."""
        index = self.index()
        stale = {k: v for k, v in index["sessions"].items() if k not in self.sessions.values()}
        removed = 0
        for scope, names in stale.items():
            for name in names:
                with contextlib.suppress(Exception):
                    self.vault.delete(f"{VAULT_PREFIX}{scope}", name)
                    removed += 1
            index["sessions"].pop(scope, None)
        if stale:
            self._save()
        return removed

    # ── the card ──

    async def ask(self, task: Any, name: str, why: str) -> dict[str, Any]:
        if name in self.names_for(task) and self.value(self.scope_of(task, name), name):
            return _text(
                f"${name} is already set for this session. Use it in a command as ${name}."
            )
        ask_id = uuid.uuid4().hex[:16]
        future = asyncio.get_running_loop().create_future()
        self.hub.tasks.add_entry(
            task.id,
            "secret",
            f"Jarvis Code asks for a secret: ${name}.",
            ask=ask_id,
            name=name,
            why=why,
            state="waiting",
            project=Path(task.cwd).name,
        )
        entry = next(
            (e for e in reversed(task.transcript) if e.get("ask") == ask_id),
            None,
        )
        self.asks[ask_id] = {"future": future, "task_id": task.id, "name": name, "entry": entry}
        try:
            answer = await asyncio.wait_for(future, ASK_WAIT)
        except (TimeoutError, asyncio.CancelledError) as exc:
            self._settle(ask_id, "expired")
            if isinstance(exc, asyncio.CancelledError):
                raise
            return _text(
                f"The owner didn't answer the request for ${name}. Carry on without it, or "
                "ask them in words.",
                error=True,
            )
        finally:
            self.asks.pop(ask_id, None)
        if answer == "declined":
            return _text(
                f"The owner declined to give ${name}. Don't ask for it again this turn: carry "
                "on without it, or ask them in words what to do."
            )
        where = "this project" if answer == "project" else "this session"
        return _text(
            f"The owner gave ${name} (kept for {where}). Use it in shell commands as ${name} "
            f'(for example: --api-key "${name}"); the command gets the value, you never do. '
            "Don't write it into files: where a tool or config needs it, read it from the "
            "environment variable at run time. Its value never appears in output: it shows "
            f"as ${name}."
        )

    def _settle(self, ask_id: str, state: str, scope: str = "") -> None:
        pending = self.asks.get(ask_id)
        if pending is None:
            return
        entry = pending.get("entry")
        if entry is not None:
            entry["state"] = state
            if scope:
                entry["scope"] = scope
        self.hub.emit("sec_state", id=pending["task_id"], ask=ask_id, state=state, scope=scope)

    def answer(self, msg: dict[str, Any]) -> None:
        """The card's answer. Nothing of msg is ever logged: it may carry the value."""
        ask_id = str(msg.get("ask") or "")
        pending = self.asks.get(ask_id)
        if pending is None or pending["future"].done():
            self.hub.emit("sec_error", ask=ask_id, text="That request isn't waiting any more.")
            return
        if msg.get("decline") is True:
            self._settle(ask_id, "declined")
            pending["future"].set_result("declined")
            return
        task = self.hub.tasks.tasks.get(pending["task_id"])
        value = msg.get("value")
        scope_kind = "project" if msg.get("scope") == "project" else "session"
        if isinstance(value, str):
            value = value.rstrip("\r\n")
        if (
            task is None
            or not isinstance(value, str)
            or not (VALUE_MIN <= len(value) <= VALUE_MAX)
            or "\x00" in value
        ):
            self.hub.emit("sec_error", ask=ask_id, text="That secret is too short or too long.")
            return
        try:
            self.save(task, pending["name"], value, scope_kind)
        except ValueError as exc:
            self.hub.emit("sec_error", ask=ask_id, text=str(exc))
            return
        self._settle(ask_id, "given", scope_kind)
        pending["future"].set_result(scope_kind)

    def listing(self, task: Any) -> dict[str, Any]:
        return {
            "id": task.id,
            "project": Path(task.cwd).name,
            "session": sorted(self.session_names.get(task.id, set())),
            "projects": self.project_names(task.cwd),
        }

    # ── a session's tools, hooks and policy ──

    def tools(self, task: Any) -> list[Any]:
        @tool(
            "ask_secret",
            "Ask the owner for a secret this task needs (an API key, a token, a password for "
            "a CLI login). They type it on a masked card; you never see the value. You get a "
            "placeholder instead, an environment variable like $SECRET_STRIPE_KEY that your "
            'Bash commands can use. name: a short name for it ("stripe key"); why: one '
            "sentence on what it's for. Never ask the owner to paste a secret in the chat.",
            {"name": str, "why": str},
        )
        async def ask_secret(args):
            name = clean_name(args.get("name"))
            if not name:
                return _text("Give the secret a short name, like 'stripe key'.", error=True)
            why = " ".join(str(args.get("why") or "").split())[:300]
            return await self.ask(task, name, why)

        @tool(
            "secrets",
            "The names of the secrets the owner has given this session (and its project), as "
            "the placeholders to use in commands. Never their values.",
            {},
        )
        async def listing(_args):
            names = sorted(self.names_for(task))
            if not names:
                return _text("No secrets have been given yet: ask_secret asks the owner.")
            return _text("Secrets you can use in commands: " + ", ".join(f"${n}" for n in names))

        return [ask_secret, listing]

    def holds_secret(self, task: Any, path: Path, limit: int = FILE_BYTES) -> str:
        """The placeholder of a secret whose value is in this file, or ""."""
        return _holding(self.values_for(task), path, limit)

    def folder_holds_secret(self, task: Any, folder: Path) -> str:
        values = self.values_for(task)  # (once for the folder, not for each of its files)
        if not values:
            return ""
        seen = total = 0
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".venv", "__pycache__")]
            for name in files:
                path = Path(root) / name
                with contextlib.suppress(OSError):
                    total += path.stat().st_size
                seen += 1
                if seen > GREP_FILES or total > GREP_BYTES:
                    return ""
                if found := _holding(values, path, FILE_BYTES):
                    return found
        return ""

    def guard(self, task: Any, tool_name: str, tool_input: dict[str, Any]) -> str:
        """Why a step that would show Claude a file holding a secret is refused, or ""."""
        if not self.names_for(task):
            return ""
        if tool_name in READS or tool_name in SNIPPETS:
            raw = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
            path = Path(str(raw)).expanduser()
            path = path if path.is_absolute() else Path(task.cwd) / path
            found = self.holds_secret(task, path) if path.is_file() else ""
        elif tool_name == "Grep" and tool_input.get("output_mode") == "content":
            raw = str(tool_input.get("path") or "")
            path = Path(raw).expanduser() if raw else Path(task.cwd)
            path = path if path.is_absolute() else Path(task.cwd) / path
            found = (
                self.holds_secret(task, path)
                if path.is_file()
                else self.folder_holds_secret(task, path)
                if path.is_dir()
                else ""
            )
        else:
            return ""
        if not found:
            return ""
        return (
            f"That would show you a secret the owner gave ({found}), which is kept from you. "
            f"Work with it through the environment variable {found} in commands instead; "
            "the owner can edit that file themselves."
        )

    def hook(self, task: Any) -> HookMatcher:
        async def pre_tool(input_data: dict[str, Any], _tool_use_id: Any, _context: Any):
            name = str(input_data.get("tool_name") or "")
            tool_input = input_data.get("tool_input") or {}
            if name == "Bash":
                wanted = named_in(str(tool_input.get("command", "")))
                if wanted and wanted & set(self.names_for(task)):
                    # To the session's own policy, past any allow rule: it runs the command
                    # through secret_run (the only way the value gets to it).
                    return {
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "ask",
                            "permissionDecisionReason": "It uses one of the owner's secrets",
                        }
                    }
                return {}
            why = await asyncio.to_thread(self.guard, task, name, tool_input)
            if not why:
                return {}
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": why,
                }
            }

        return HookMatcher(matcher="Bash|Read|NotebookRead|Edit|MultiEdit|Grep", hooks=[pre_tool])

    def policy(self, task: Any, inner: Any) -> Any:
        """The session's permission policy, with a Bash command that names a secret run
        through secret_run once the policy (rules, cards, the mode) has let it go as Claude
        wrote it."""

        async def can_use_tool(tool_name: str, tool_input: dict[str, Any], context: Any):
            result = await inner(tool_name, tool_input, context)
            if tool_name != "Bash" or not isinstance(result, PermissionResultAllow):
                return result
            given = getattr(result, "updated_input", None) or tool_input
            command = str(given.get("command", ""))
            names = self.names_for(task)
            wanted = {n: a for n, a in names.items() if n in named_in(command)}
            if not wanted:
                return result
            return PermissionResultAllow(
                updated_input={**given, "command": wrap(command, wanted)},
                updated_permissions=getattr(result, "updated_permissions", None),
            )

        return can_use_tool


def _holding(values: dict[str, str], path: Path, limit: int) -> str:
    """The placeholder of one of these values found in the file's first limit bytes, or ""."""
    if not values:
        return ""
    try:
        with path.open("rb") as fh:
            data = fh.read(limit)
    except OSError:
        return ""
    for found, placeholder in values.items():
        if found.encode() in data:
            return placeholder
    return ""


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


class _SessionOptions:
    """What a session's connection gets (TaskManager.option_hooks): the ask_secret tools
    (allowed outright: asking is the owner's card), the hook and the policy's wrapper."""

    def __init__(self, sec: Secrets) -> None:
        self.sec = sec

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code":
            return
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        options.mcp_servers = {
            **base,
            SERVER: create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.sec.tools(task)),
        }
        options.allowed_tools = [*options.allowed_tools, ASK_TOOL, LIST_TOOL]
        hooks = dict(options.hooks or {})
        hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), self.sec.hook(task)]
        options.hooks = hooks
        if options.can_use_tool is not None:
            options.can_use_tool = self.sec.policy(task, options.can_use_tool)

    def key(self, task: Any) -> Any:
        return None  # nothing here needs a new connection: names are looked up as it goes


def install(hub: Any) -> None:
    sec = Secrets(hub)
    hub.code_secrets = sec
    hub.tasks.option_hooks.append(_SessionOptions(sec))
    hub.tasks.redactors.append(sec.redact)
    tasks.FEATURE_TOOLS[ASK_TOOL] = ("ask you for a secret", None)

    def sessions_changed(kind: str, data: dict[str, Any]) -> None:
        if kind != "tasks":
            return
        try:
            items = data.get("items") or []
            live = {i.get("id") for i in items if i.get("status") not in ("stopped", "failed")}
            for task_id in list(sec.sessions):
                if task_id not in live:
                    sec.session_ended(task_id)
        except Exception:
            log.exception("Jarvis Code secrets: couldn't take in the sessions")

    hub.add_task_sink(sessions_changed)

    def answer(msg: dict[str, Any]) -> None:
        try:
            sec.answer(msg)
        except Exception:  # (logged without msg: it may carry the value)
            log.error(
                "Jarvis Code secrets: an answer failed (%s)", type(sys.exc_info()[1]).__name__
            )
            hub.emit("sec_error", ask=str(msg.get("ask") or ""), text="That didn't work.")

    def listing(msg: dict[str, Any]) -> None:
        task = hub.tasks.tasks.get(_int(msg.get("id")))
        if task is not None and task.kind == "code":
            hub.emit("sec_list", **sec.listing(task))

    def remove(msg: dict[str, Any]) -> None:
        task = hub.tasks.tasks.get(_int(msg.get("id")))
        name = str(msg.get("name") or "")
        if task is None or task.kind != "code" or not NAME.match(name):
            return
        sec.remove(task, name, "project" if msg.get("scope") == "project" else "session")
        hub.emit("sec_list", **sec.listing(task))

    async def sweep_once() -> None:
        await asyncio.to_thread(sec.sweep)

    hub.register_command("sec_answer", answer)
    hub.register_command("sec_list", listing)
    hub.register_command("sec_remove", remove)
    hub.register_loop("code-secrets-sweep", sweep_once)


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):  # (infinity too)
        return 0
