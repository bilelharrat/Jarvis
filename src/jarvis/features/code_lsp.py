"""Eden Code: real language servers for sessions (lsp.py, code_lsp_mcp.py), and what they
say about the code live in the Problems pane.

- Sessions: every Claude Code session gets the eden_code_lsp tool server in-process
  (session_extras): go_to_definition, find_references, hover_info, rename_symbol (the
  server's rename as a plan of Edit calls: the session makes them with its own Edit tool, so
  each is checkpointed, shown in Changes and undoable like any other edit), diagnostics (a
  file's errors as the server sees it now, to check an edit) and language_servers (which are
  installed, and how to install the rest). They only read, so they're on the session's
  allow list. A session over ACP (Codex, Gemini CLI…: code_acp.py) gets the same tools as a
  stdio MCP server it starts itself (code_lsp_mcp.py), with language servers of its own
  that stop when it closes it.
- Live problems: when a session's edit (Edit, MultiEdit, Write, NotebookEdit) is done, the
  file is sent again to its language's server (started for it when one is installed) and
  what the server says joins the Problems pane, under the checkers', as "Language servers".
  At a turn's end every file open in the project's servers is sent again (an edit made with
  sed in Bash), and the rest of what changed is named to them. Nothing is sent to the
  session by itself: the pane's Fix these does that, as the checkers' does.
- Window commands: lsp_state {id | directory} is answered with lsp_problems {path,
  problems, errors, servers, on, live} (also sent, a moment after, whenever a server
  publishes or starts or stops); lsp_fix {id} sends the session what the servers say
  (diagnostics.fix_message). web/features/code-lsp.js draws the section and the Settings.
- Lifetime (lsp.Manager): a server starts only when first needed (a tool call, an edit),
  one a (session folder, language), shared by the sessions in that folder; it stops when the
  last session that used it ends (End session, a crash, let go), when unused for
  lsp.IDLE_SECONDS, when it holds more than lsp.MEMORY_MB, when lsp.SERVERS_MAX are already
  running, and when the app quits (the loop's end, and an exit handler for the hard way).
- Never installed by Eden, and only servers installed for the owner (never a project's own
  copy, which a session can write): lsp.py says why.

Settings (prefs.features): code_lsp (bool, on): off, sessions don't get the tools and no
server starts. code_lsp_live (bool, on): off, an edit never starts or asks a server; the
servers still answer the session's tools, and the pane still shows what they said then.

Cost policy (Claude): this feature never calls a model. The servers run on this computer,
started only when needed and kept to the limits above; nothing is sent anywhere.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import code_lsp_mcp, diagnostics, lsp, prefs, tasks

log = logging.getLogger("jarvis")

PREF = "code_lsp"
PREF_LIVE = "code_lsp_live"
prefs.register_feature_pref(PREF, True)
prefs.register_feature_pref(PREF_LIVE, True)

SERVER = code_lsp_mcp.SERVER
TOOLS = [f"mcp__{SERVER}__{name}" for name in code_lsp_mcp.NAMES]
LIVE_WAIT = 8.0  # seconds an edit's file waits for its server's diagnostics
EMIT_DELAY = 0.3  # a burst of publishes is one lsp_problems
SWEEP_EVERY = 30.0  # seconds between looks for idle and oversized servers
STATUS_SECONDS = 60.0  # which servers a project has, looked up again after this
SCAN_FILES = 3000  # files looked at for a project's languages
EDITS_KEPT = 500  # edits under way remembered (tool id -> file)
ENDED = ("stopped", "failed", "closed")
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "build", "dist", "target", "__pycache__", ".build", "Pods", "DerivedData"}  # fmt: skip


def project_languages(root: Path, specs: tuple[lsp.Spec, ...] = lsp.SPECS) -> list[str]:
    """Which of the servers' languages a project has files in (a quick look, capped)."""
    suffixes: set[str] = set()
    seen = 0
    for _folder, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in names:
            suffixes.add(Path(name).suffix.lower())
            seen += 1
        if seen > SCAN_FILES:
            break
    return [s.id for s in specs if suffixes & set(s.extensions)]


class LspDesk:
    """The hub's language servers, and the sessions' and Problems pane's way to them."""

    def __init__(self, hub: Any, manager: lsp.Manager | None = None) -> None:
        self.hub = hub
        self.manager = manager or lsp.Manager(
            on_diagnostics=self._published, on_change=self._server_changed
        )
        self._edits: dict[str, tuple[int, str]] = {}  # tool id -> (session, file), till done
        self._again: dict[str, bool] = {}  # file being refreshed -> asked again meanwhile
        self._emits: dict[str, asyncio.TimerHandle] = {}  # root -> the lsp_problems on its way
        self._statuses: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._work: set[asyncio.Task] = set()

    def on(self) -> bool:
        try:
            return bool(self.hub.prefs.feature(PREF))
        except Exception:
            return True

    def live_on(self) -> bool:
        try:
            return self.on() and bool(self.hub.prefs.feature(PREF_LIVE))
        except Exception:
            return True

    def spawn(self, coro: Any) -> asyncio.Task | None:
        try:
            task = asyncio.ensure_future(coro)
        except RuntimeError:  # no loop (a test building options)
            coro.close()
            return None
        self._work.add(task)
        task.add_done_callback(self._work.discard)
        task.add_done_callback(_log_failure)
        return task

    # ── the sessions' tools ──

    def tools(self, task: Any) -> list[Any]:
        desk, root, user = self, Path(task.cwd), task.id
        made = []
        for spec in code_lsp_mcp.TOOLS:

            def bind(name: str, spec: dict[str, Any]) -> Any:
                @tool(name, spec["description"], spec["inputSchema"])
                async def call(args):
                    if not desk.on():
                        return {
                            "content": [
                                {"type": "text", "text": "Language servers are off in Settings."}
                            ],
                            "is_error": True,
                        }
                    text, error = await code_lsp_mcp.run_tool(desk.manager, root, name, args, user)
                    if name in ("diagnostics", "rename_symbol") or not error:
                        desk.emit_soon(root)  # (what the servers said may be news to the pane)
                    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
                    if error:
                        out["is_error"] = True
                    return out

                return call

            made.append(bind(spec["name"], spec))
        return made

    def stdio_server(self, root: Path) -> dict[str, Any]:
        """The same tools as a command an ACP agent starts (code_lsp_mcp.py)."""
        return {
            "type": "stdio",
            "command": sys.executable,
            "args": [
                "-c",
                "from jarvis.code_lsp_mcp import main; main()",
                "--root",
                str(Path(root).resolve()),
            ],
        }

    def extend(self, task: Any, options: Any) -> None:
        """TaskManager.session_extras: the language-server tools for this session."""
        if not self.on() or getattr(task, "kind", "code") != "code":
            return
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        if str(getattr(task, "model_ref", "") or "").startswith("acp:"):
            options.mcp_servers = {**base, SERVER: self.stdio_server(Path(task.cwd))}
            return
        options.mcp_servers = {
            **base,
            SERVER: create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools(task)),
        }
        options.allowed_tools = [*options.allowed_tools, *TOOLS]

    # ── what the sessions do ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "tasks":
            self._sessions_changed(data.get("items") or [])
        elif kind == "task_log":
            self._logged(data.get("id"), data.get("entry") or {})
        elif kind == "task_log_update":
            got = self._edits.pop(str(data.get("tool_id") or ""), None)
            if got is not None and data.get("status") == "done":
                self.spawn(self.after_edit(*got))
        elif kind == "task_finished" and data.get("task_kind") == "code":
            files = [f for f in data.get("files") or [] if isinstance(f, str)]
            self.spawn(self.after_turn(data.get("id"), files))

    def _logged(self, task_id: Any, entry: dict[str, Any]) -> None:
        if entry.get("role") != "tool" or entry.get("tool") not in tasks.EDIT_TOOLS:
            return
        task = self.hub.tasks.tasks.get(task_id)
        tool_id = str(entry.get("tool_id") or "")
        path = task.pending_edits.get(tool_id) if task is not None else None
        if task is None or task.kind != "code" or not path or not self.live_on():
            return
        self._edits[tool_id] = (task.id, path)
        while len(self._edits) > EDITS_KEPT:
            del self._edits[next(iter(self._edits))]

    def _file(self, task: Any, raw: str) -> tuple[Path, Path] | None:
        """(the session's folder, the file) for a file it changed inside its folder, in a
        language a server knows."""
        root = Path(task.cwd).resolve()
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = root / path
        try:
            path = path.resolve()
        except (OSError, RuntimeError):
            return None
        if not path.is_relative_to(root) or self.manager.spec_for(path) is None:
            return None
        return root, path

    async def after_edit(self, task_id: int, raw: str) -> None:
        """A session's edit is done: its file's live diagnostics (once more, after, when it
        was edited again meanwhile)."""
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or not self.live_on():
            return
        found = self._file(task, raw)
        if found is None:
            return
        root, path = found
        key = str(path)
        if key in self._again:
            self._again[key] = True
            return
        self._again[key] = False
        try:
            while True:
                try:
                    server, language = await self.manager.server(root, path, task_id)
                    await server.refresh_open()
                    await server.diagnostics_for(path, language, LIVE_WAIT)
                except lsp.NoServer:
                    self._statuses.pop(str(root), None)
                except lsp.LspError as exc:
                    log.info("language servers: live diagnostics for %s: %s", path.name, exc)
                if not self._again.get(key):
                    break
                self._again[key] = False
        finally:
            self._again.pop(key, None)
        self.emit_soon(root)

    async def after_turn(self, task_id: Any, files: list[str]) -> None:
        """A turn ended: the project's servers see every open file as it is now (an edit
        made with Bash), and hear of the other files it changed."""
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or not self.live_on():
            return
        root = Path(task.cwd).resolve()
        servers = self.manager.running(root)
        if not servers:
            return
        changed = [p for f in files if (p := self._file(task, f)) is not None]
        for server in servers:
            try:
                await server.refresh_open()
                await server.files_changed([p for _, p in changed])
            except lsp.LspError:
                continue
        self.emit_soon(root)

    def _sessions_changed(self, items: list[dict[str, Any]]) -> None:
        """A session that ended (End session, a crash) or was let go: the servers only it
        used stop."""
        live = {i.get("id") for i in items}
        ended = {i.get("id") for i in items if i.get("kind") == "code" and i.get("status") in ENDED}
        users = {u for s in self.manager.servers.values() for u in s.users}
        for user in users:
            if user in ended or user not in live:
                self.spawn(self.manager.release(user))

    # ── the Problems pane ──

    def _published(self, server: lsp.Server, _uri: str, _items: list[dict[str, Any]]) -> None:
        self.emit_soon(server.root)

    def _server_changed(self, server: lsp.Server) -> None:
        self._statuses.pop(str(server.root), None)
        self.emit_soon(server.root)

    def problems(self, root: Path) -> list[diagnostics.Problem]:
        """What the project's running servers say, as the Problems pane's problems."""
        root = Path(root).resolve()
        out: list[diagnostics.Problem] = []
        for server in self.manager.running(root):
            for uri, items in list(server.diagnostics.items()):
                path = lsp.path_of(uri)
                if path is None or not items:
                    continue
                with contextlib.suppress(OSError, RuntimeError):
                    path = path.resolve()
                if not path.is_relative_to(root):
                    continue
                rel = str(path.relative_to(root))
                for d in items:
                    rng = d.get("range") if isinstance(d.get("range"), dict) else {}
                    start = rng.get("start") if isinstance(rng.get("start"), dict) else {}
                    line, col = start.get("line"), start.get("character")
                    sev = d.get("severity")
                    code = d.get("code")
                    out.append(
                        diagnostics.Problem(
                            file=rel,
                            line=line + 1 if isinstance(line, int) else None,
                            col=col + 1 if isinstance(col, int) else None,
                            severity=code_lsp_mcp.SEVERITY.get(
                                sev if isinstance(sev, int) else 1, "error"
                            ),
                            message=" ".join(str(d.get("message") or "").split()),
                            source=str(d.get("source") or server.name),
                            code=str(code) if isinstance(code, str | int) else "",
                        )
                    )
        out.sort(key=lambda p: (p.file, p.line or 0, p.col or 0))
        return out[: diagnostics.MAX_PROBLEMS]

    def statuses(self, root: Path) -> list[dict[str, Any]]:
        """The servers of the project's languages: running, installed or missing (with how
        to install it). Looked up again after STATUS_SECONDS; off the event loop."""
        key = str(Path(root).resolve())
        cached = self._statuses.get(key)
        if cached is not None and time.monotonic() - cached[0] < STATUS_SECONDS:
            return cached[1]
        wanted = set(project_languages(Path(key), self.manager.specs))
        wanted |= {s.spec.id for s in self.manager.running(Path(key))}
        found = [s for s in self.manager.status(Path(key)) if s["id"] in wanted]
        self._statuses[key] = (time.monotonic(), found)
        return found

    async def state(self, root: Path, task_id: Any = None) -> dict[str, Any]:
        root = Path(root).resolve()
        servers = await asyncio.to_thread(self.statuses, root)
        running = {s.spec.id: s.public() for s in self.manager.running(root)}
        servers = [{**s, **running.get(s["id"], {})} for s in servers]
        found = self.problems(root)
        return {
            "path": str(root),
            "id": task_id,
            "on": self.on(),
            "live": self.live_on(),
            "servers": servers,
            "problems": [p.public() for p in found],
            "errors": sum(1 for p in found if p.severity == "error"),
        }

    def emit_soon(self, root: Path) -> None:
        """lsp_problems for this folder, a moment from now (one for a burst)."""
        key = str(Path(root).resolve())
        if key in self._emits:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._emits[key] = loop.call_later(EMIT_DELAY, self._emit_now, key)

    def _emit_now(self, key: str) -> None:
        self._emits.pop(key, None)

        async def send() -> None:
            self.hub.emit("lsp_problems", **(await self.state(Path(key))))

        self.spawn(send())

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        from .code_workspace import folder_of, session_of

        try:
            root = folder_of(self.hub, msg)
        except ValueError as exc:
            self.hub.emit("cv_error", text=str(exc))
            return
        task = session_of(self.hub, msg)
        self.hub.emit("lsp_problems", **(await self.state(root, task.id if task else None)))

    async def cmd_fix(self, msg: dict[str, Any]) -> None:
        from .code_workspace import session_of

        task = session_of(self.hub, msg)
        if task is None:
            self.hub.emit("cv_error", text="Open a session to send it the problems.")
            return
        found = self.problems(Path(task.cwd))
        if not found:
            self.hub.emit("cv_error", text="The language servers have no problems to fix.")
        elif not self.hub.tasks.send(task.id, diagnostics.fix_message(found)):
            self.hub.emit("cv_error", text="The session couldn't take another message just now.")

    # ── running with the app ──

    async def forever(self) -> None:
        """Now and then the idle and oversized servers stop; when the app quits, all do."""
        try:
            while True:
                await asyncio.sleep(SWEEP_EVERY)
                try:
                    await self.manager.sweep()
                except Exception:
                    log.exception("language servers: the sweep failed")
        finally:  # shutdown and exit as the protocol asks, briefly; then the hard way
            with contextlib.suppress(BaseException):
                await asyncio.wait_for(self.manager.close(), 4.0)
            self.manager.kill_now()


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("language servers: background work failed", exc_info=task.exception())


def install(hub: Any) -> None:
    desk = LspDesk(hub)
    hub.code_lsp = desk  # (for the tests)
    hub.tasks.session_extras.append(desk.extend)
    hub.add_task_sink(desk.on_task_event)
    hub.register_command("lsp_state", desk.cmd_state, slow=True)
    hub.register_command("lsp_fix", desk.cmd_fix)
    hub.register_loop("code_lsp", desk.forever)
