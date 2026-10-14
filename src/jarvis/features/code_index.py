"""Eden Code: a codebase index that understands meaning (code_index.py), in every session and
in the project search pane.

- Sessions: every Claude Code session gets the eden_code_index tool server in-process
  (session_extras): codebase_search {query, limit?, files?} (the best places by meaning,
  words and symbol names, each with file:line, its symbol, why it matched, its first lines)
  and symbol_lookup {name, kind?, limit?} (where a function, class or method is defined).
  Both only read, so they're on the session's allow list. A session over ACP (Codex, Gemini
  CLI…: code_acp.py) gets the same two tools as a stdio MCP server it starts itself
  (code_index_mcp.py), which only reads the index this feature keeps.
- Keeping it up to date: a session starting in a project brings its index up to date in the
  background (only the files that changed since: their size and time); a session's turn
  finishing re-reads the files it changed (the hub's task_finished); a search looks for
  changed files first when the last look is more than code_index.REFRESH_SECONDS old. One
  update a project at a time; one asked for meanwhile runs after it.
- Where: the app's data folder (code_index/<project>-<hash>/), never in the project.
- Window commands: ci_search {id | directory, text, include?, limit?, ref} answered with
  ci_search {ref, results, how, note, status, seconds} or {ref, error}; ci_status {id |
  directory} answered with ci_status {status}. web/features/code-search.js's "By meaning"
  switch asks them.

Setting (prefs.features): code_index (bool, on): off, sessions don't get the tools and
nothing is indexed.

Cost policy (Claude): this feature never calls a model. The vectors come from the second
brain's own embedder on this computer when the owner has turned Search by meaning on and it's
ready here (Apple's models on a Mac, the ONNX model on a PC: nothing is fetched or built for
this), else from code_index.HashEmbedder, which needs nothing. Capped per update
(code_index.EMBED_PER_UPDATE, EMBED_SECONDS, SCAN_SECONDS, FILES_MAX, VECTORS_MAX).
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import code_index, code_index_mcp, osplat, prefs
from ..brain_sources import SEMANTIC

log = logging.getLogger("jarvis")

PREF = "code_index"
prefs.register_feature_pref(PREF, True)

SERVER = code_index_mcp.SERVER
TOOLS = [f"mcp__{SERVER}__codebase_search", f"mcp__{SERVER}__symbol_lookup"]
FOLDER = "code_index"
INDEXES_KEPT = 12  # projects' indexes kept in memory at once (the rest load again when asked)
TOOL_REFRESH_SECONDS = 20.0  # a session's search waits this long for changed files at most
TOOL_EMBED_SECONDS = 5.0  # ...and embeds new passages for this long (the rest: in the background)


class IndexDesk:
    """One hub's code indexes, a project each."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.indexes: dict[str, code_index.CodeIndex] = {}
        self._busy: dict[str, list[Any]] = {}  # root -> updates asked for while one runs
        self._queries: dict[str, Any] = {}  # embedder kind -> the query's embedder
        self._query_lock = threading.Lock()
        self.source_override: Any = None  # (the tests' own embedder source)
        self.query_override: Any = None  # (the tests' own query vectors)

    def on(self) -> bool:
        try:
            return bool(self.hub.prefs.feature(PREF))
        except Exception:
            return True

    def base(self) -> Path:
        return self.hub.feature_path(FOLDER)

    def index_for(self, root: Path) -> code_index.CodeIndex:
        key = str(Path(root).resolve())
        index = self.indexes.get(key)
        if index is None:
            if len(self.indexes) >= INDEXES_KEPT:
                idle = [k for k in self.indexes if k not in self._busy]
                if idle:
                    del self.indexes[idle[0]]
            index = self.indexes[key] = code_index.CodeIndex(
                Path(key), code_index.index_folder(self.base(), Path(key))
            )
        return index

    # ── the embedder ──

    def kind(self) -> str:
        """Which embedder: the second brain's model when the owner turned Search by meaning
        on and it's ready here, else the hashed one."""
        if self.source_override is not None:
            return self.source_override.kind
        try:
            semantic = bool(self.hub.prefs.feature(SEMANTIC[0]))
        except Exception:
            semantic = False
        model = "minilm" if osplat.IS_WIN else "apple"
        if semantic and code_index.model_ready(model):
            return model
        return code_index.HASH_EMBEDDER

    def source(self) -> code_index.Source:
        if self.source_override is not None:
            return self.source_override
        return code_index.source_for(self.kind())

    def query_vector(self, index: code_index.CodeIndex) -> Any:
        """The function giving a query's vector in the index's own space (None: no vector)."""
        if self.query_override is not None:
            return self.query_override
        kind = index.embedder_name or code_index.HASH_EMBEDDER

        def vector(text: str) -> Any:
            with self._query_lock:
                embedder = self._queries.get(kind)
                if embedder is None:
                    embedder = code_index.query_embedder_for(kind)
                    if embedder is None:
                        return None
                    self._queries[kind] = embedder
            return code_index.query_vector_for(embedder)(text)

        return vector

    # ── keeping indexes up to date ──

    async def update(self, root: Path, only: list[str] | None = None, **kw: Any) -> dict[str, Any]:
        """Bring a project's index up to date (only these files, when given) off the event
        loop; asked while one runs, it runs once that's done (with every file asked for)."""
        index = self.index_for(root)
        key = str(index.root)
        if key in self._busy:
            self._busy[key].append(only)
            return index.status()
        self._busy[key] = []
        result: dict[str, Any] = {}
        try:
            while True:
                source = self.source()
                result = await asyncio.to_thread(index.refresh, source, only=only, **kw)
                asked = self._busy[key]
                if not asked:
                    break
                self._busy[key] = []
                only = (
                    None if any(a is None for a in asked) else sorted({p for a in asked for p in a})
                )
                kw = {}
        except Exception:
            log.exception("code index: an update failed for %s", key)
        finally:
            self._busy.pop(key, None)
        return result

    def update_soon(self, root: Path, only: list[str] | None = None) -> None:
        spawn = getattr(self.hub, "_spawn", None)
        if spawn is None or not self.on():
            return
        work = self.update(root, only)
        try:
            spawn(work)
        except RuntimeError:  # no event loop running (a test building options)
            work.close()

    async def ready(self, root: Path) -> code_index.CodeIndex:
        """The index for a search: changed files read first when the last look is old (in
        the background when an update is already running: the search uses what's there)."""
        index = self.index_for(root)
        if index.stale() and str(index.root) not in self._busy:
            running = asyncio.ensure_future(self.update(root, embed_seconds=TOOL_EMBED_SECONDS))
            try:  # (past the wait, the update goes on: the search uses what's there now)
                await asyncio.wait_for(asyncio.shield(running), TOOL_REFRESH_SECONDS)
            except TimeoutError:
                pass
            if index.pending:
                self.update_soon(root)  # (the rest of the vectors, in the background)
        else:
            await asyncio.to_thread(index.load)
        return index

    def finished(self, event: dict[str, Any]) -> None:
        """The hub's task_finished: a code session's turn changed these files."""
        if event.get("task_kind") != "code" or not self.on():
            return
        files = [str(f) for f in event.get("files") or [] if isinstance(f, str)]
        task = self.hub.tasks.tasks.get(event.get("id"))
        if task is None or not files:
            return
        if str(Path(task.cwd).resolve()) in self.indexes:
            self.update_soon(Path(task.cwd), files)

    # ── the sessions' tools ──

    async def run_tool(self, root: Path, name: str, args: dict[str, Any]) -> dict[str, Any]:
        index = await self.ready(root)
        text, error = await asyncio.to_thread(
            code_index_mcp.run_tool, index, name, args, self.query_vector(index)
        )
        out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
        if error:
            out["is_error"] = True
        return out

    def tools(self, root: Path) -> list[Any]:
        desk = self

        @tool(
            "codebase_search",
            code_index_mcp.SEARCH["description"],
            code_index_mcp.SEARCH["inputSchema"],
        )
        async def codebase_search(args):
            return await desk.run_tool(root, "codebase_search", args)

        @tool(
            "symbol_lookup",
            code_index_mcp.LOOKUP["description"],
            code_index_mcp.LOOKUP["inputSchema"],
        )
        async def symbol_lookup(args):
            return await desk.run_tool(root, "symbol_lookup", args)

        return [codebase_search, symbol_lookup]

    def stdio_server(self, root: Path) -> dict[str, Any]:
        """The same tools as a command an ACP agent starts (code_index_mcp.py)."""
        index = self.index_for(root)
        return {
            "type": "stdio",
            "command": sys.executable,
            "args": [
                "-c",
                "from jarvis.code_index_mcp import main; main()",
                "--root",
                str(index.root),
                "--index",
                str(index.folder),
            ],
        }

    def extend(self, task: Any, options: Any) -> None:
        """TaskManager.session_extras: the index's tools for this session, and its index
        brought up to date in the background."""
        if not self.on() or getattr(task, "kind", "code") != "code":
            return
        root = Path(task.cwd)
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        if str(getattr(task, "model_ref", "") or "").startswith("acp:"):
            options.mcp_servers = {**base, SERVER: self.stdio_server(root)}
        else:
            options.mcp_servers = {
                **base,
                SERVER: create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools(root)),
            }
            options.allowed_tools = [*options.allowed_tools, *TOOLS]
        self.update_soon(root)

    # ── the window ──

    async def cmd_search(self, msg: dict[str, Any]) -> None:
        from .code_workspace import folder_of

        ref = str(msg.get("ref") or "")[:40]
        started = time.monotonic()
        if not self.on():
            self.hub.emit(
                "ci_search",
                ref=ref,
                error="Search by meaning is off (Settings › Eden Code: the code index).",
                results=[],
            )
            return
        try:
            root = folder_of(self.hub, msg)
            index = await self.ready(root)
            limit = msg.get("limit") if isinstance(msg.get("limit"), int) else 20
            found = await asyncio.to_thread(
                code_index.search,
                index,
                str(msg.get("text") or ""),
                limit=limit,
                include=str(msg.get("include") or "")[:300],
                query_vector=self.query_vector(index),
            )
        except ValueError as exc:  # a query that can't run, or not a project
            self.hub.emit("ci_search", ref=ref, error=str(exc), results=[])
            return
        self.hub.emit("ci_search", ref=ref, seconds=round(time.monotonic() - started, 2), **found)

    async def cmd_status(self, msg: dict[str, Any]) -> None:
        from .code_workspace import folder_of

        try:
            index = self.index_for(folder_of(self.hub, msg))
        except ValueError as exc:
            self.hub.emit("ci_status", error=str(exc), status={})
            return
        await asyncio.to_thread(index.load)
        self.hub.emit(
            "ci_status", status={**index.status(), "updating": str(index.root) in self._busy}
        )


def install(hub: Any) -> None:
    desk = IndexDesk(hub)
    hub.code_index = desk  # (for the tests)
    hub.tasks.session_extras.append(desk.extend)
    hub.add_event_sink(("task_finished",), desk.finished)
    hub.register_command("ci_search", desk.cmd_search, slow=True)
    hub.register_command("ci_status", desk.cmd_status, slow=True)
