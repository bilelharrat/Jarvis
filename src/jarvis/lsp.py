"""Language servers for Eden Code: a small client of the Language Server Protocol, and a
manager that starts the right server for a project's language, keeps it to a budget and stops
it when nobody needs it. The sessions' tools (code_lsp_mcp.py) and the Problems pane's live
diagnostics (features/code_lsp.py) both go through it.

Why: a session's grep finds words, not symbols. A language server knows that `send` on line
40 is Uploader.send and not the other three: where it's defined, every place that uses it,
what type it has, and which edits rename it everywhere at once. Developers asked for this more
than for anything else in an agent's toolbox after hooks (Codex's LSP request), and Claude
Code itself added an LSP tool.

- Which servers: Python (basedpyright, pyright or pylsp), TypeScript and JavaScript
  (typescript-language-server), Swift (sourcekit-lsp, also through Xcode's xcrun), Go
  (gopls), Rust (rust-analyzer) and C, C++ and Objective-C (clangd, also through xcrun). The
  first one installed wins (SPECS' order). A file's language is its extension.
- Never installed by Eden: one that isn't there is said so, with the command that installs
  it (Spec.install), and the tools work again once the owner has run it.
- Only the owner's own installs: a server is looked for on the login shell's PATH and in the
  usual tool folders (EXTRA_DIRS: ~/.local/bin, ~/go/bin, ~/.cargo/bin, Homebrew's), never
  inside the project. A project's node_modules/.bin or .venv/bin is a file a session can
  write, and a server runs as the owner, outside any sandbox; one found there is named, and
  the owner is asked to install it for themselves. rust-analyzer starts with build scripts
  and proc macros off and no cargo check on save, so no project code runs by being looked
  at. (A server still reads the project's own config, as the editor's would: tsserver comes
  from the project's node_modules when it has one, as in VS Code.)
- One server a (project folder, language), shared by every session working in that folder
  (an isolated copy is a folder of its own). Started the first time it's needed, never at a
  session's start. It stops when the last session using it ends (Manager.release), after
  IDLE_SECONDS unused, when it uses more than MEMORY_MB with its children (then it's held
  off for HOLD_SECONDS and says why), when SERVERS_MAX are running and another is needed
  (the least recently used goes), and when the app quits. One that crashes is started again
  when next needed, at most RESTARTS_MAX times in RESTART_WINDOW.
- Bounded: every request has a time limit (REQUEST_SECONDS; INIT_SECONDS to start), a message
  past MESSAGE_MAX ends the server, at most OPEN_MAX files are open in it (a file bigger than
  FILE_MAX never is), and the diagnostics kept are capped (DIAG_FILES_MAX, DIAG_PER_FILE).
- Files are sent as they are on disk: before each request, every file open in the server
  whose size or time changed is sent again (didChange), so a session's edits (Edit, a sed in
  Bash) are what the server sees. The server's own edits are never applied
  (workspace/applyEdit is refused): a rename comes back as a plan the session makes with its
  own edit tool (code_lsp_mcp.py), as reviewable and undoable as any other edit.
- Positions: the protocol counts a line's characters in UTF-16 (an emoji is two); Lines
  turns them into Python's string offsets and back.

Cost policy (Claude): this module never calls a model; everything runs on this computer.
"""

from __future__ import annotations

import asyncio
import atexit
import bisect
import contextlib
import hashlib
import itertools
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import time
import weakref
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from . import osplat, runproc

log = logging.getLogger("jarvis")

INIT_SECONDS = 60.0  # to start and answer initialize (rust-analyzer, tsserver load a while)
REQUEST_SECONDS = 30.0  # one request (a first references in a big project can take a while)
SHUTDOWN_SECONDS = 3.0  # to answer shutdown, before it's stopped the hard way
IDLE_SECONDS = 15 * 60  # unused this long: stopped
MEMORY_MB = 4096  # a server and its children past this: stopped and held off
HOLD_SECONDS = 10 * 60  # ...for this long
SERVERS_MAX = 4  # running at once, across projects
RESTARTS_MAX = 3  # crashes in RESTART_WINDOW before it's held off
RESTART_WINDOW = 10 * 60
OPEN_MAX = 100  # files open in one server
FILE_MAX = 2_000_000  # bytes: a bigger file is never sent
MESSAGE_MAX = 64 * 1024 * 1024  # bytes of one message from a server
DIAG_FILES_MAX = 1000  # files whose diagnostics a server keeps
DIAG_PER_FILE = 200
STDERR_KEPT = 40  # lines of a server's stderr kept, for saying why it stopped
FIND_SECONDS = 5.0  # xcrun --find
RETRIES = 3  # a request the server cancelled (it was busy indexing, the file changed)

# Folders a server is often installed in that a login shell's PATH can leave out.
EXTRA_DIRS = (
    "~/.local/bin",  # pipx, uv tool
    "~/go/bin",
    "~/.cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.npm-global/bin",
    "~/.bun/bin",
)
# The project's own copies a session could have written: named, never started.
PROJECT_BINS = ("node_modules/.bin", ".venv/bin", "venv/bin", ".venv/Scripts", "venv/Scripts")


class LspError(Exception):
    """Why a request couldn't be answered, in words for the session or the owner."""


class NoServer(LspError):
    """No server for this file: none for its language, none installed, or held off."""


class RequestError(LspError):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


CONTENT_MODIFIED = -32801
SERVER_CANCELLED = -32802
REQUEST_CANCELLED = -32800


# ── which servers ──


@dataclass
class Spec:
    id: str
    label: str  # the language, as the owner reads it
    extensions: dict[str, str]  # ".py" -> the protocol's languageId
    commands: tuple[tuple[str, ...], ...]  # tried in order; "xcrun:<tool>" is Xcode's
    install: str  # how the owner installs one
    init_options: dict[str, Any] | None = None
    settings: dict[str, Any] = field(default_factory=dict)  # workspace/configuration's answers
    hint: str = ""  # said with an empty answer, when the server needs more to answer


SPECS: tuple[Spec, ...] = (
    Spec(
        "python",
        "Python",
        {".py": "python", ".pyi": "python"},
        (
            ("basedpyright-langserver", "--stdio"),
            ("pyright-langserver", "--stdio"),
            ("pylsp",),
        ),
        "pipx install basedpyright (or: npm install -g pyright, or: pipx install "
        "python-lsp-server)",
    ),
    Spec(
        "typescript",
        "TypeScript and JavaScript",
        {
            ".ts": "typescript",
            ".mts": "typescript",
            ".cts": "typescript",
            ".tsx": "typescriptreact",
            ".js": "javascript",
            ".mjs": "javascript",
            ".cjs": "javascript",
            ".jsx": "javascriptreact",
        },
        (("typescript-language-server", "--stdio"),),
        "npm install -g typescript-language-server typescript",
    ),
    Spec(
        "swift",
        "Swift",
        {".swift": "swift"},
        (("sourcekit-lsp",), ("xcrun:sourcekit-lsp",)),
        "It comes with Xcode (or the command line tools: xcode-select --install) and with "
        "the Swift toolchain from swift.org",
        hint="sourcekit-lsp finds references and definitions in other files from the index "
        "a build leaves: build the project once (in Xcode, or swift build), then ask again.",
    ),
    Spec(
        "go",
        "Go",
        {".go": "go"},
        (("gopls",),),
        "go install golang.org/x/tools/gopls@latest",
    ),
    Spec(
        "rust",
        "Rust",
        {".rs": "rust"},
        (("rust-analyzer",),),
        "rustup component add rust-analyzer",
        init_options={
            "cargo": {"buildScripts": {"enable": False}},
            "procMacro": {"enable": False},
            "checkOnSave": False,
        },
    ),
    Spec(
        "c",
        "C, C++ and Objective-C",
        {
            ".c": "c",
            ".h": "c",
            ".cc": "cpp",
            ".cpp": "cpp",
            ".cxx": "cpp",
            ".hpp": "cpp",
            ".hh": "cpp",
            ".hxx": "cpp",
            ".m": "objective-c",
            ".mm": "objective-cpp",
        },
        (("clangd",), ("xcrun:clangd",)),
        "brew install llvm, or Xcode's command line tools (xcode-select --install)",
    ),
)


def spec_for(path: Path | str, specs: tuple[Spec, ...] = SPECS) -> tuple[Spec, str] | None:
    """The server for a file, and its languageId: by its extension."""
    suffix = Path(path).suffix.lower()
    for spec in specs:
        if suffix in spec.extensions:
            return spec, spec.extensions[suffix]
    return None


def known_languages(specs: tuple[Spec, ...] = SPECS) -> str:
    return ", ".join(s.label for s in specs)


_xcrun_found: dict[str, tuple[float, str | None]] = {}


def _xcrun(tool: str) -> str | None:
    """Where Xcode's own copy of a tool is (xcrun --find), looked up once a minute."""
    if not osplat.IS_MAC:
        return None
    now = time.monotonic()
    cached = _xcrun_found.get(tool)
    if cached is not None and now - cached[0] < 60:
        return cached[1]
    found: str | None = None
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        done = subprocess.run(
            ["xcrun", "--find", tool],
            capture_output=True,
            text=True,
            timeout=FIND_SECONDS,
            stdin=subprocess.DEVNULL,
        )
        line = done.stdout.strip().splitlines()[-1] if done.stdout.strip() else ""
        if done.returncode == 0 and line and os.access(line, os.X_OK):
            found = line
    _xcrun_found[tool] = (now, found)
    return found


def _resolve(command: str, env: dict[str, str]) -> str | None:
    """Where a server's command is: Xcode's (xcrun:<tool>), a path as it is, else the PATH's
    or one of EXTRA_DIRS."""
    if command.startswith("xcrun:"):
        return _xcrun(command[6:])
    if "/" in command or (osplat.IS_WIN and "\\" in command):
        path = Path(command).expanduser()
        return (
            str(path)
            if path.is_absolute() and path.is_file() and os.access(path, os.X_OK)
            else None
        )
    dirs = [d for d in env.get("PATH", "").split(os.pathsep) if d and os.path.isabs(d)]
    dirs += [os.path.expanduser(d) for d in EXTRA_DIRS]
    return shutil.which(command, path=os.pathsep.join(dirs))


def _inside(path: str, root: Path) -> bool:
    try:
        return Path(path).resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def find_command(spec: Spec, root: Path, env: dict[str, str]) -> tuple[list[str] | None, str]:
    """The command that starts this language's server here, or (None, why not and how to
    install one)."""
    inside: list[str] = []
    for command in spec.commands:
        exe = _resolve(command[0], env)
        if exe is None:
            continue
        if _inside(exe, root):
            inside.append(exe)
            continue
        return [exe, *command[1:]], ""
    for command in spec.commands:
        name = command[0].split(":")[-1]
        for folder in PROJECT_BINS:
            if (root / folder / name).exists():
                inside.append(f"{folder}/{name}")
    why = f"No language server for {spec.label} is installed for you on this computer."
    if inside:
        why += (
            f" This project has its own copy ({inside[0]}), but Eden Code only starts servers "
            "installed outside the project: a session can change what's in it, and a server "
            "runs as you, outside any sandbox."
        )
    why += (
        f" Eden Code never installs one by itself. To use these tools, install one: "
        f"{spec.install}. Then ask again."
    )
    return None, why


# ── files, positions, addresses ──

_BREAK = re.compile(r"\r\n|\r|\n")


class Lines:
    """A text's lines as the protocol counts them (\\n, \\r\\n or \\r ends one) and its
    UTF-16 columns."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.starts = [0]
        self.ends: list[int] = []
        for m in _BREAK.finditer(text):
            self.ends.append(m.start())
            self.starts.append(m.end())
        self.ends.append(len(text))

    def __len__(self) -> int:
        return len(self.starts)

    def line(self, n: int) -> str:
        if not 0 <= n < len(self.starts):
            return ""
        return self.text[self.starts[n] : self.ends[n]]

    def offset(self, line: int, col16: int) -> int:
        """The string offset of a protocol position (clamped to the line, as servers do)."""
        if line >= len(self.starts):
            return len(self.text)
        if line < 0:
            return 0
        return self.starts[line] + index_of_utf16(self.line(line), col16)

    def position(self, offset: int) -> tuple[int, int]:
        """(line, UTF-16 column) of a string offset."""
        line = max(0, bisect.bisect_right(self.starts, offset) - 1)
        return line, utf16_len(self.text[self.starts[line] : offset])


def utf16_len(text: str) -> int:
    return sum(2 if ord(c) > 0xFFFF else 1 for c in text)


def index_of_utf16(text: str, col16: int) -> int:
    """The string index of a UTF-16 column in one line (its end past it)."""
    units = 0
    for i, c in enumerate(text):
        if units >= col16:
            return i
        units += 2 if ord(c) > 0xFFFF else 1
    return len(text)


def uri_of(path: Path) -> str:
    return Path(path).resolve().as_uri()


def path_of(uri: str) -> Path | None:
    """The file a file:// address names (None for any other kind)."""
    try:
        parsed = urlparse(str(uri))
    except ValueError:
        return None
    if parsed.scheme != "file":
        return None
    raw = unquote(parsed.path)
    if osplat.IS_WIN and re.match(r"^/[A-Za-z]:", raw):
        raw = raw[1:]
    return Path(raw)


def read_text(path: Path, limit: int | None = None) -> str:
    """A source file's text for a server; LspError for one too big, binary or unreadable."""
    limit = FILE_MAX if limit is None else limit
    try:
        size = path.stat().st_size
        if size > limit:
            raise LspError(f"{path.name} is too big for the language server ({size:,} bytes).")
        with path.open("rb") as f:
            data = f.read(limit + 1)
    except FileNotFoundError:
        raise LspError(f"There's no file {path}.") from None
    except OSError as exc:
        raise LspError(f"Couldn't read {path.name}: {exc.strerror or exc}") from None
    if b"\0" in data[:8192]:
        raise LspError(f"{path.name} isn't a text file.")
    return data.decode("utf-8", errors="replace")


# ── the wire: a header, then a JSON body ──


def frame(message: dict[str, Any]) -> bytes:
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


class ProtocolError(LspError):
    pass


async def read_message(reader: asyncio.StreamReader, limit: int = MESSAGE_MAX) -> Any:
    """The next message, or None when the stream ended. ProtocolError for one that isn't
    the protocol's (a server printing to stdout) or is past the limit."""
    length: int | None = None
    while True:
        try:
            line = await reader.readuntil(b"\n")
        except asyncio.IncompleteReadError as exc:
            if not exc.partial.strip():
                return None
            raise ProtocolError("The server's output ended in the middle of a message.") from None
        except asyncio.LimitOverrunError:
            raise ProtocolError("The server wrote something that isn't the protocol.") from None
        line = line.strip()
        if not line:
            if length is None:
                continue  # (a stray blank line between messages)
            break
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            try:
                length = int(value.strip())
            except ValueError:
                raise ProtocolError("The server sent a message of no length.") from None
        elif not name.strip().lower().startswith(b"content-"):
            raise ProtocolError("The server wrote something that isn't the protocol.")
    if length < 0 or length > limit:
        raise ProtocolError(f"The server sent a message past {limit // (1024 * 1024)} MB.")
    try:
        body = await reader.readexactly(length)
    except asyncio.IncompleteReadError:
        raise ProtocolError("The server's output ended in the middle of a message.") from None
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        raise ProtocolError("The server sent a message that isn't JSON.") from None


# ── one server ──

CLIENT_CAPABILITIES: dict[str, Any] = {
    "general": {"positionEncodings": ["utf-16"]},
    "workspace": {
        "applyEdit": False,
        "workspaceFolders": True,
        "configuration": True,
        "didChangeWatchedFiles": {"dynamicRegistration": False},
        "workspaceEdit": {
            "documentChanges": True,
            "resourceOperations": ["create", "rename", "delete"],
        },
    },
    "textDocument": {
        "synchronization": {"didSave": True, "dynamicRegistration": False},
        "definition": {"linkSupport": True},
        "typeDefinition": {"linkSupport": True},
        "implementation": {"linkSupport": True},
        "references": {},
        "hover": {"contentFormat": ["markdown", "plaintext"]},
        "rename": {"prepareSupport": True},
        "publishDiagnostics": {"relatedInformation": False, "versionSupport": True},
        "diagnostic": {"dynamicRegistration": False, "relatedDocumentSupport": False},
    },
    "window": {"workDoneProgress": True},
}


@dataclass
class Doc:
    version: int
    stamp: tuple[int, int]  # (mtime_ns, size) when last sent
    digest: str
    awaiting: bool = True  # sent, and the server hasn't published for it since


def _stamp(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


Published = Callable[["Server", str, list[dict[str, Any]]], None]


class Server:
    """One language server process, spoken to over its stdin and stdout."""

    def __init__(
        self,
        spec: Spec,
        argv: list[str],
        root: Path,
        env: dict[str, str],
        on_diagnostics: Published | None = None,
    ) -> None:
        self.spec, self.argv, self.root, self.env = spec, list(argv), Path(root), env
        self.name = Path(argv[0]).name
        self.on_diagnostics = on_diagnostics
        self.proc: asyncio.subprocess.Process | None = None
        self.capabilities: dict[str, Any] = {}
        self.status = "starting"  # starting | ready | stopped | failed
        self.why = ""  # why it stopped or failed
        self.users: set[Any] = set()
        self.started = time.monotonic()
        self.last_used = time.monotonic()
        self.docs: OrderedDict[str, Doc] = OrderedDict()
        self.diagnostics: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self.generation: dict[str, int] = {}  # uri -> diagnostics published for it so far
        self._published = asyncio.Event()
        self.stderr: deque[str] = deque(maxlen=STDERR_KEPT)
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._write_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []
        self._sync_lock = asyncio.Lock()

    # ── the process ──

    @property
    def alive(self) -> bool:
        return (
            self.proc is not None
            and self.proc.returncode is None
            and self.status in ("starting", "ready")
        )

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None else None

    def touch(self) -> None:
        self.last_used = time.monotonic()

    async def start(self) -> None:
        """Start it and say hello (initialize): LspError when it can't."""
        kw: dict[str, Any] = {}
        if osplat.IS_WIN:
            kw["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            kw["start_new_session"] = True  # its own group: stopped with its children
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv,
                cwd=str(self.root),
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=1024 * 1024,
                **kw,
            )
        except OSError as exc:
            self.status, self.why = "failed", f"it didn't start: {exc.strerror or exc}"
            raise LspError(self.why) from None
        _LIVE.add(self)
        self._tasks = [
            asyncio.ensure_future(self._read()),
            asyncio.ensure_future(self._read_stderr()),
        ]
        root_uri = uri_of(self.root)
        try:
            result = await self.request(
                "initialize",
                {
                    "processId": os.getpid(),  # (a server whose parent is gone stops itself)
                    "clientInfo": {"name": "Eden Code"},
                    "locale": "en",
                    "rootUri": root_uri,
                    "rootPath": str(self.root),
                    "workspaceFolders": [{"uri": root_uri, "name": self.root.name}],
                    "capabilities": CLIENT_CAPABILITIES,
                    "initializationOptions": self.spec.init_options,
                },
                INIT_SECONDS,
                retry=False,
            )
        except LspError as exc:
            tail = self.stderr_tail()
            raise LspError(f"{exc}{f' It said: {tail}' if tail else ''}") from None
        caps = result.get("capabilities") if isinstance(result, dict) else None
        self.capabilities = caps if isinstance(caps, dict) else {}
        await self.notify("initialized", {})
        if self.spec.settings:
            await self.notify("workspace/didChangeConfiguration", {"settings": self.spec.settings})
        self.status = "ready"

    def stderr_tail(self) -> str:
        return " ".join(line for line in list(self.stderr)[-3:] if line.strip())[:400]

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        with contextlib.suppress(Exception):
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    break
                self.stderr.append(line.decode("utf-8", errors="replace").rstrip()[:500])

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            while True:
                message = await read_message(self.proc.stdout)
                if message is None:
                    break
                self._dispatch(message)
        except ProtocolError as exc:
            self.why = self.why or str(exc)
            log.warning("language server %s: %s", self.name, exc)
            self._signal(signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("language server %s: its output couldn't be read", self.name)
        finally:
            if self.status in ("starting", "ready") and len(self._tasks) > 1:
                with contextlib.suppress(Exception):  # (its last words on stderr, read first)
                    await asyncio.wait([self._tasks[1]], timeout=1.0)
            if self.status in ("starting", "ready"):
                self.status = "failed"
                if not self.why:
                    code = self.proc.returncode
                    tail = self.stderr_tail()
                    self.why = "it stopped" + (
                        f" ({runproc.describe_exit(code)})" if code is not None else ""
                    )
                    if tail:
                        self.why += f": {tail}"
            self._fail_pending(
                LspError(
                    f"The {self.spec.label} language server ({self.name}) stopped: {self.why}."
                )
            )

    def _fail_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        method = message.get("method")
        if method is None and "id" in message:  # an answer to one of ours
            fut = (
                self._pending.pop(message.get("id"), None)
                if isinstance(message.get("id"), int)
                else None
            )
            if fut is None or fut.done():
                return
            error = message.get("error")
            if isinstance(error, dict):
                code = error.get("code")
                fut.set_exception(
                    RequestError(
                        code if isinstance(code, int) else 0, str(error.get("message") or "")[:500]
                    )
                )
            else:
                fut.set_result(message.get("result"))
            return
        if not isinstance(method, str):
            return
        params = message.get("params")
        if "id" in message:  # the server asks the client something
            self._tasks = [t for t in self._tasks if not t.done()]
            self._tasks.append(
                asyncio.ensure_future(self._answer(message.get("id"), method, params))
            )
            return
        if method == "textDocument/publishDiagnostics" and isinstance(params, dict):
            self._store(params.get("uri"), params.get("diagnostics"))

    async def _answer(self, ident: Any, method: str, params: Any) -> None:
        result: Any = None
        error: dict[str, Any] | None = None
        if method == "workspace/configuration":
            items = params.get("items") if isinstance(params, dict) else None
            result = [
                self.spec.settings.get(str(i.get("section") or "")) if isinstance(i, dict) else None
                for i in (items if isinstance(items, list) else [])
            ]
        elif method == "workspace/workspaceFolders":
            result = [{"uri": uri_of(self.root), "name": self.root.name}]
        elif method == "workspace/applyEdit":
            result = {
                "applied": False,
                "failureReason": "Eden Code makes edits through the session's own edit tool.",
            }
        elif method == "window/showDocument":
            result = {"success": False}
        elif method in (
            "window/workDoneProgress/create",
            "client/registerCapability",
            "client/unregisterCapability",
            "window/showMessageRequest",
            "workspace/diagnostic/refresh",
            "workspace/semanticTokens/refresh",
            "workspace/inlayHint/refresh",
            "workspace/codeLens/refresh",
            "workspace/inlineValue/refresh",
        ):
            result = None
        else:
            error = {"code": -32601, "message": f"Eden Code doesn't do {method}."}
        reply: dict[str, Any] = {"jsonrpc": "2.0", "id": ident}
        if error is not None:
            reply["error"] = error
        else:
            reply["result"] = result
        with contextlib.suppress(LspError):
            await self._send(reply)

    async def _send(self, message: dict[str, Any]) -> None:
        if self.proc is None or self.proc.stdin is None or self.proc.returncode is not None:
            await self._gone()
            raise LspError(self.down_text())
        try:
            async with self._write_lock:
                self.proc.stdin.write(frame(message))
                await self.proc.stdin.drain()
        except (ConnectionError, BrokenPipeError, RuntimeError):
            await self._gone()
            raise LspError(self.down_text()) from None

    async def _gone(self) -> None:
        """It has just stopped by itself: a moment for its last words (stderr) and its end
        to be read, so what's said of it says why."""
        reading = [t for t in self._tasks[:2] if not t.done()]
        if reading:
            with contextlib.suppress(Exception):
                await asyncio.wait(reading, timeout=1.0)

    def down_text(self) -> str:
        why = f": {self.why}" if self.why else ""
        return f"The {self.spec.label} language server ({self.name}) isn't running{why}."

    async def notify(self, method: str, params: Any) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def request(
        self, method: str, params: Any, timeout: float | None = None, retry: bool = True
    ) -> Any:
        """A request's result; LspError when it fails or takes past timeout. One the server
        cancelled while it was busy (indexing, a file just changed) is asked again a few
        times, as editors do."""
        timeout = REQUEST_SECONDS if timeout is None else timeout
        self.touch()
        for attempt in range(RETRIES if retry else 1):
            ident = next(self._ids)
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            self._pending[ident] = fut
            try:
                await self._send(
                    {"jsonrpc": "2.0", "id": ident, "method": method, "params": params}
                )
                return await asyncio.wait_for(fut, timeout)
            except TimeoutError:
                self._pending.pop(ident, None)
                with contextlib.suppress(LspError):
                    await self.notify("$/cancelRequest", {"id": ident})
                raise LspError(
                    f"The {self.spec.label} language server ({self.name}) took more than "
                    f"{timeout:.0f} seconds to answer {method}. It may still be reading the "
                    "project: try again in a moment."
                ) from None
            except RequestError as exc:
                busy = exc.code in (CONTENT_MODIFIED, SERVER_CANCELLED, REQUEST_CANCELLED)
                if not busy or attempt == RETRIES - 1 or not retry:
                    raise
                await asyncio.sleep(0.3 * (attempt + 1))
            finally:
                self._pending.pop(ident, None)
                self.touch()
        raise LspError("unreachable")  # pragma: no cover

    # ── files ──

    async def sync(self, path: Path, language: str) -> tuple[str, bool]:
        """Send a file as it is on disk (opened, or its new text): its uri, and whether
        anything was sent."""
        async with self._sync_lock:
            return await self._sync(Path(path).resolve(), language)

    async def _sync(self, path: Path, language: str) -> tuple[str, bool]:
        uri = uri_of(path)
        stamp = _stamp(path)
        doc = self.docs.get(uri)
        if stamp is None:
            if doc is not None:
                del self.docs[uri]
                await self.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
            raise LspError(f"There's no file {path}.")
        if doc is not None and doc.stamp == stamp:
            self.docs.move_to_end(uri)
            return uri, False
        text = await asyncio.to_thread(read_text, path)
        digest = hashlib.sha1(text.encode("utf-8", errors="replace")).hexdigest()
        if doc is None:
            while len(self.docs) >= OPEN_MAX:
                old, _ = self.docs.popitem(last=False)
                await self.notify("textDocument/didClose", {"textDocument": {"uri": old}})
            self.docs[uri] = Doc(1, stamp, digest)
            await self.notify(
                "textDocument/didOpen",
                {"textDocument": {"uri": uri, "languageId": language, "version": 1, "text": text}},
            )
            return uri, True
        self.docs.move_to_end(uri)
        doc.stamp = stamp
        if doc.digest == digest:
            return uri, False
        doc.version += 1
        doc.digest = digest
        doc.awaiting = True
        await self.notify(
            "textDocument/didChange",
            {
                "textDocument": {"uri": uri, "version": doc.version},
                "contentChanges": [{"text": text}],
            },
        )
        sync = self.capabilities.get("textDocumentSync")
        if isinstance(sync, dict) and sync.get("save"):
            await self.notify("textDocument/didSave", {"textDocument": {"uri": uri}})
        return uri, True

    async def refresh_open(self) -> list[str]:
        """Every open file whose size or time changed is sent again (a session's edit, a
        sed in Bash); one that's gone is closed. The uris sent."""
        sent = []
        for uri in list(self.docs):
            path = path_of(uri)
            if path is None:
                continue
            found = spec_for(path, (self.spec,))
            language = found[1] if found else next(iter(self.spec.extensions.values()))
            with contextlib.suppress(LspError):
                _, changed = await self.sync(path, language)
                if changed:
                    sent.append(uri)
        return sent

    async def files_changed(self, paths: list[Path]) -> None:
        """Files changed on disk that aren't open: the server is told, so its view of the
        rest of the project keeps up (workspace/didChangeWatchedFiles)."""
        changes = []
        for p in paths:
            uri = uri_of(p)
            if uri not in self.docs:
                changes.append({"uri": uri, "type": 2 if p.exists() else 3})
        if changes:
            with contextlib.suppress(LspError):
                await self.notify("workspace/didChangeWatchedFiles", {"changes": changes[:200]})

    # ── diagnostics ──

    def _store(self, uri: Any, items: Any) -> None:
        if not isinstance(uri, str) or not isinstance(items, list):
            return
        kept = [d for d in items[:DIAG_PER_FILE] if isinstance(d, dict)]
        self.diagnostics[uri] = kept
        self.diagnostics.move_to_end(uri)
        while len(self.diagnostics) > DIAG_FILES_MAX:
            old, _ = self.diagnostics.popitem(last=False)
            self.generation.pop(old, None)
        self.generation[uri] = self.generation.get(uri, 0) + 1
        if uri in self.docs:
            self.docs[uri].awaiting = False
        event, self._published = self._published, asyncio.Event()
        event.set()
        if self.on_diagnostics is not None:
            try:
                self.on_diagnostics(self, uri, kept)
            except Exception:
                log.exception("language server %s: a diagnostics sink failed", self.name)

    @property
    def pulls(self) -> bool:
        return bool(self.capabilities.get("diagnosticProvider"))

    async def diagnostics_for(self, path: Path, language: str, wait: float) -> list[dict[str, Any]]:
        """A file's diagnostics as they are now: asked for (pull) when the server answers
        that, else those it publishes after seeing the file (waiting up to `wait` seconds
        for them, and a moment more for a second batch)."""
        uri, _ = await self.sync(path, language)
        if self.pulls:
            try:
                report = await self.request(
                    "textDocument/diagnostic", {"textDocument": {"uri": uri}}, max(wait, 5.0)
                )
            except RequestError:
                report = None
            if isinstance(report, dict) and isinstance(report.get("items"), list):
                self._store(uri, report["items"])
                return self.diagnostics.get(uri, [])
            if isinstance(report, dict) and report.get("kind") == "unchanged":
                return self.diagnostics.get(uri, [])
        doc = self.docs.get(uri)
        if (doc is None or not doc.awaiting) and uri in self.diagnostics:
            return self.diagnostics[uri]  # what it last said is about the file as it is
        deadline = time.monotonic() + wait
        while (doc := self.docs.get(uri)) is not None and doc.awaiting and self.alive:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._published.wait(), left)
        if doc is not None and not doc.awaiting:  # a second batch often follows the first
            seen = self.generation.get(uri, 0)
            end = time.monotonic() + min(0.4, max(0.0, deadline - time.monotonic()))
            while self.generation.get(uri, 0) == seen and time.monotonic() < end:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._published.wait(), end - time.monotonic())
        return self.diagnostics.get(uri, [])

    # ── its size, and stopping it ──

    def memory_mb(self) -> float:
        """What it and its children (tsserver is node's child) hold in memory, in MB."""
        pid = self.pid
        if pid is None or not self.alive:
            return 0.0
        try:
            import psutil

            proc = psutil.Process(pid)
            total = proc.memory_info().rss
            for child in proc.children(recursive=True):
                with contextlib.suppress(psutil.Error):
                    total += child.memory_info().rss
            return total / (1024 * 1024)
        except Exception:
            return 0.0

    def _signal(self, sig: int) -> None:
        pid = self.pid
        if pid is None or self.proc is None or self.proc.returncode is not None:
            return
        with contextlib.suppress(OSError, ProcessLookupError):
            if osplat.IS_WIN:
                self.proc.kill() if sig != signal.SIGTERM else self.proc.terminate()
            else:
                os.killpg(pid, sig)

    async def stop(self, why: str = "") -> None:
        """shutdown and exit, as the protocol asks; then the hard way for one that doesn't."""
        was_ready = self.status == "ready"
        if self.status in ("starting", "ready"):
            self.status = "stopped"
            self.why = why or self.why
        if self.proc is not None and self.proc.returncode is None:
            if was_ready:
                with contextlib.suppress(LspError, Exception):
                    await asyncio.wait_for(self._shutdown(), SHUTDOWN_SECONDS)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.proc.wait(), 1.0)
            if self.proc.returncode is None:
                self._signal(signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.proc.wait(), 2.0)
            if self.proc.returncode is None:
                self._signal(signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.proc.wait(), 2.0)
        if self.proc is not None and not osplat.IS_WIN:
            # Its children too (tsserver under node), whose group outlives the leader.
            with contextlib.suppress(OSError, ProcessLookupError):
                os.killpg(self.proc.pid, signal.SIGKILL)
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        self._fail_pending(LspError(self.down_text()))
        self.docs.clear()
        _LIVE.discard(self)

    async def _shutdown(self) -> None:
        # The server's own words, not the request helper's: no retries, its own short wait.
        ident = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[ident] = fut
        await self._send({"jsonrpc": "2.0", "id": ident, "method": "shutdown", "params": None})
        with contextlib.suppress(Exception):
            await fut
        await self._send({"jsonrpc": "2.0", "method": "exit", "params": None})

    def kill_now(self) -> None:
        """The app is quitting: its group gets SIGTERM, then SIGKILL, now."""
        self._signal(signal.SIGTERM)
        self._signal(signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.spec.id,
            "label": self.spec.label,
            "name": self.name,
            "status": self.status,
            "why": self.why,
            "files": len(self.docs),
        }


_LIVE: set[Server] = set()  # every server running, for the exit handler


def _kill_all_at_exit() -> None:
    for server in list(_LIVE):
        with contextlib.suppress(Exception):
            server.kill_now()


atexit.register(_kill_all_at_exit)


# ── the manager ──


class Manager:
    """The servers of every project: started when first needed, one a (folder, language),
    each stopped when no session uses it any more, unused for a while, too big, or the
    app quits."""

    def __init__(
        self,
        env: Callable[[], dict[str, str]] | None = None,
        specs: tuple[Spec, ...] = SPECS,
        on_diagnostics: Published | None = None,
        on_change: Callable[[Server], None] | None = None,
        servers_max: int = SERVERS_MAX,
        idle_seconds: float = IDLE_SECONDS,
        memory_mb: float = MEMORY_MB,
    ) -> None:
        self.env = env or runproc.shell_env
        self.specs = specs
        self.on_diagnostics = on_diagnostics
        self.on_change = on_change  # a server started or stopped
        self.servers_max = servers_max
        self.idle_seconds = idle_seconds
        self.memory_mb = memory_mb
        self.servers: dict[tuple[str, str], Server] = {}
        self._starting: dict[tuple[str, str], asyncio.Lock] = {}
        self._held: dict[tuple[str, str], tuple[float, str]] = {}  # key -> (until, why)
        self._crashes: dict[tuple[str, str], list[float]] = {}
        self._made: weakref.WeakSet[Server] = weakref.WeakSet()  # (one cut short stopping too)

    def spec_for(self, path: Path | str) -> tuple[Spec, str] | None:
        return spec_for(path, self.specs)

    def running(self, root: Path | None = None) -> list[Server]:
        key = str(Path(root).resolve()) if root is not None else None
        return [s for (r, _), s in self.servers.items() if s.alive and (key is None or r == key)]

    def _changed(self, server: Server) -> None:
        if self.on_change is not None:
            try:
                self.on_change(server)
            except Exception:
                log.exception("language servers: a change sink failed")

    async def server(self, root: Path, path: Path, user: Any = None) -> tuple[Server, str]:
        """The running server for this file (started now when it isn't yet), and the file's
        languageId. NoServer, with what to do, when there's none."""
        root = Path(root).resolve()
        found = self.spec_for(path)
        if found is None:
            suffix = Path(path).suffix or Path(path).name
            raise NoServer(
                f"Eden Code has no language server for {suffix} files. It knows "
                f"{known_languages(self.specs)}."
            )
        spec, language = found
        key = (str(root), spec.id)
        lock = self._starting.setdefault(key, asyncio.Lock())
        async with lock:
            server = self.servers.get(key)
            if server is not None and server.alive and server.status == "ready":
                server.touch()
                if user is not None:
                    server.users.add(user)
                return server, language
            if server is not None:  # it stopped by itself: a crash, counted
                del self.servers[key]
                users = server.users
                if server.status == "failed":
                    self._crashed(key, server)
            else:
                users = set()
            held = self._held.get(key)
            if held is not None:
                if held[0] > time.monotonic():
                    raise NoServer(held[1])
                del self._held[key]
            env = await asyncio.to_thread(self.env)
            argv, why = await asyncio.to_thread(find_command, spec, root, env)
            if argv is None:
                raise NoServer(why)
            await self._make_room()
            server = Server(spec, argv, root, env, self.on_diagnostics)
            server.users = users | ({user} if user is not None else set())
            self.servers[key] = server
            self._made.add(server)
            try:
                await server.start()
            except LspError as exc:
                await server.stop()
                self.servers.pop(key, None)
                self._crashed(key, server)
                raise NoServer(
                    f"The {spec.label} language server ({server.name}) didn't start: {exc}"
                ) from None
            self._changed(server)
            return server, language

    def _crashed(self, key: tuple[str, str], server: Server) -> None:
        now = time.monotonic()
        times = [t for t in self._crashes.get(key, []) if now - t < RESTART_WINDOW] + [now]
        self._crashes[key] = times
        if len(times) >= RESTARTS_MAX:
            self._held[key] = (
                now + RESTART_WINDOW,
                f"The {server.spec.label} language server ({server.name}) stopped "
                f"{len(times)} times in a few minutes, so Eden Code has stopped starting it "
                f"for now{f' (the last time: {server.why})' if server.why else ''}. It will try "
                "again in a while.",
            )
            self._crashes.pop(key, None)

    async def _make_room(self) -> None:
        """Past SERVERS_MAX, the least recently used one stops (one nobody uses first)."""
        live = [(k, s) for k, s in self.servers.items() if s.alive]
        while len(live) >= self.servers_max:
            live.sort(key=lambda ks: (bool(ks[1].users), ks[1].last_used))
            key, oldest = live.pop(0)
            await self._stop(key, oldest, "others were needed (at most "
                             f"{self.servers_max} run at once)")  # fmt: skip

    async def _stop(self, key: tuple[str, str], server: Server, why: str) -> None:
        if self.servers.get(key) is server:
            del self.servers[key]
        await server.stop(why)
        self._changed(server)

    async def release(self, user: Any) -> None:
        """A session ended: each server it used that no other session uses now stops."""
        for key, server in list(self.servers.items()):
            if user in server.users:
                server.users.discard(user)
                if not server.users:
                    await self._stop(key, server, "the sessions using it ended")

    async def sweep(self) -> None:
        """Now and then: servers that stopped by themselves are let go; one unused past
        idle_seconds stops; one using more than memory_mb stops and is held off."""
        now = time.monotonic()
        for key, server in list(self.servers.items()):
            if not server.alive:
                if server.status == "failed":
                    self._crashed(key, server)
                self.servers.pop(key, None)
                self._changed(server)
                continue
            if now - server.last_used > self.idle_seconds:
                await self._stop(key, server, "it wasn't used for a while")
                continue
            used = await asyncio.to_thread(server.memory_mb)
            if used > self.memory_mb:
                why = (
                    f"The {server.spec.label} language server ({server.name}) used "
                    f"{used:,.0f} MB, more than the {self.memory_mb:,.0f} MB Eden Code lets one "
                    "use, so it was stopped. It can start again in a few minutes."
                )
                self._held[key] = (now + HOLD_SECONDS, why)
                await self._stop(key, server, f"it used {used:,.0f} MB")

    def status(self, root: Path) -> list[dict[str, Any]]:
        """Each language's server for this project: running, installed (not running yet) or
        missing, with how to install it. Looks on the disk: off the event loop."""
        root = Path(root).resolve()
        env = self.env()
        out = []
        for spec in self.specs:
            server = self.servers.get((str(root), spec.id))
            held = self._held.get((str(root), spec.id))
            if server is not None and server.alive:
                out.append({**server.public(), "install": ""})
                continue
            argv, why = find_command(spec, root, env)
            entry = {
                "id": spec.id,
                "label": spec.label,
                "name": Path(argv[0]).name if argv else "",
                "status": "installed" if argv else "missing",
                "why": "" if argv else why,
                "install": "" if argv else spec.install,
                "files": 0,
            }
            if held is not None and held[0] > time.monotonic():
                entry.update(status="held", why=held[1])
            out.append(entry)
        return out

    async def close(self) -> None:
        await asyncio.gather(
            *(self._stop(k, s, "the app quit") for k, s in list(self.servers.items())),
            return_exceptions=True,
        )

    def kill_now(self) -> None:
        for server in list(self._made):
            server.kill_now()
