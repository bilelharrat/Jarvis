"""Eden Code's debugger: the Debug Adapter Protocol (DAP), the adapters it can use, and one
debugging run (code_dap.py). The feature that gives it to sessions and the Debug pane is
features/code_debugger.py; this module knows nothing of the hub, so it's tested on its own
against a fake adapter (tests/fake_dap.py).

Why a real debugger: an agent that can only add prints and rerun guesses at what a failing
test sees. With breakpoints, the stack and the locals it reads the actual values at the line
that goes wrong, as a person at a debugger does (JetBrains Junie already debugs this way).

- The protocol: messages are JSON with a Content-Length header, over the adapter's stdin and
  stdout (debugpy, lldb-dap) or a TCP connection (js-debug's dapDebugServer.js). DapClient
  sends requests and matches their responses, keeps the events it hears (a short history, to
  wait on), and answers the adapter's own "reverse" requests: runInTerminal is refused (the
  program's output comes to the debug console, never a terminal Eden didn't open), and
  startDebugging (js-debug's child session for the real Node process) opens a second
  connection to the same server, which then does the work.
- The adapters (find_adapters): Python through debugpy (the project's own interpreter:
  .venv/bin/python first, then python3), Node/JS through js-debug's DAP server (needs node and
  the js-debug download; EDEN_JS_DEBUG points at its dapDebugServer.js), Swift, C, C++ and
  Rust through lldb-dap (Xcode's, via xcrun, or LLVM's on the PATH). One that isn't there is
  listed with how to install it; nothing is ever installed for the owner.
- One run (DebugSession): its adapter in its own process group under runproc's supervisor
  (so nothing outlives the app, and stopping it stops the program it launched), started with
  the usual sequence (initialize, launch or attach, breakpoints once "initialized" comes,
  configurationDone). Its limits: START_SECONDS to get going, WAIT_SECONDS (at most
  WAIT_MAX) for each continue or step to stop somewhere, STEPS_MAX continues and steps,
  SESSION_SECONDS in all, and capped stacks, variables, values and output. Who drives it:
  "agent" or "user" (the Debug pane's Take over); the agent's tools that move it say so
  while the user has it.
- An attached run (a process it didn't start) is left running when it ends: disconnect
  without terminateDebuggee. A launched one ends with its program.

Cost policy (Claude): never calls a model. It runs only the owner's own debug adapters.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import osplat, runproc

log = logging.getLogger("jarvis")

REQUEST_SECONDS = 15.0  # one request's answer
START_SECONDS = 30.0  # the adapter up, the program launched (or attached) and configured
WAIT_SECONDS = 30.0  # a continue or step stopping somewhere, unless the call says otherwise
WAIT_MAX = 120.0  # ...and at most this
STEPS_MAX = 300  # continues and steps in one run
SESSION_SECONDS = 20 * 60  # one run in all; then it's stopped
FRAMES_MAX = 30  # stack frames shown
VARS_MAX = 60  # variables of one scope or object
VALUE_MAX = 400  # characters of one value
EVAL_MAX = 4000  # characters of an expression's result
OUTPUT_LINES = 300  # the program's output kept
MESSAGE_MAX = 32 * 1024 * 1024  # one DAP message, at most
LOCALS_IN_REPORT = 25  # variables in a stop's report
SOURCE_AROUND = 3  # lines either side of the stopped line in a report
DETECT_FRESH = 120.0  # seconds a look for an adapter is kept

STOP_EVENTS = ("stopped", "terminated", "exited")


class DapError(Exception):
    """A request the adapter refused or never answered, or an adapter that couldn't start."""


# ── the wire ──


def encode(message: dict[str, Any]) -> bytes:
    body = json.dumps(message, separators=(",", ":")).encode()
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


async def read_message(reader: asyncio.StreamReader) -> dict[str, Any] | None:
    """The next message, or None at the end of the stream. Raises DapError for one that
    isn't DAP (no length, too long, not JSON)."""
    length = None
    while True:
        line = await reader.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is None:
                continue  # (a stray blank line between messages)
            break
        name, _, value = line.decode("latin-1").partition(":")
        if name.strip().lower() == "content-length":
            try:
                length = int(value.strip())
            except ValueError as exc:
                raise DapError(f"a bad Content-Length: {value.strip()[:40]}") from exc
    if length < 0 or length > MESSAGE_MAX:
        raise DapError(f"a message of {length} bytes")
    try:
        body = await reader.readexactly(length)
    except asyncio.IncompleteReadError:
        return None
    try:
        message = json.loads(body)
    except ValueError as exc:
        raise DapError("a message that isn't JSON") from exc
    return message if isinstance(message, dict) else {}


class DapClient:
    """One DAP connection: requests and their responses, the events heard, the adapter's
    reverse requests answered."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: Any,
        on_event: Callable[[DapClient, dict[str, Any]], None] | None = None,
        on_request: Callable[[DapClient, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self.reader, self.writer = reader, writer
        self.on_event, self.on_request = on_event, on_request
        self.seq = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.events: deque[tuple[int, dict[str, Any]]] = deque(maxlen=500)
        self.event_count = 0
        self.waiters: list[tuple[int, Callable[[dict[str, Any]], bool], asyncio.Future]] = []
        self.closed = False
        self.capabilities: dict[str, Any] = {}
        self._loop_task: asyncio.Task | None = None
        self._side: set[asyncio.Task] = set()

    def start(self) -> None:
        self._loop_task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        why = "The debug adapter ended."
        try:
            while True:
                message = await read_message(self.reader)
                if message is None:
                    break
                self._take(message)
        except asyncio.CancelledError:
            raise
        except DapError as exc:
            why = f"The debug adapter sent {exc}."
            log.warning("debugger: %s", why)
        except Exception:
            log.exception("debugger: reading the adapter failed")
        finally:
            self._closed(why)

    def _closed(self, why: str) -> None:
        self.closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(DapError(why))
        self.pending.clear()
        for _since, _pred, future in self.waiters:
            if not future.done():
                future.set_result(None)
        self.waiters.clear()

    def _take(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "response":
            future = self.pending.pop(int(message.get("request_seq") or -1), None)
            if future is not None and not future.done():
                if message.get("success"):
                    future.set_result(message.get("body") or {})
                else:
                    future.set_exception(DapError(_refusal(message)))
        elif kind == "event":
            index = self.event_count
            self.event_count += 1
            self.events.append((index, message))
            if self.on_event is not None:
                try:
                    self.on_event(self, message)
                except Exception:
                    log.exception("debugger: an event couldn't be handled")
            for waiter in list(self.waiters):
                since, pred, future = waiter
                if index >= since and not future.done() and pred(message):
                    future.set_result(message)
                    self.waiters.remove(waiter)
        elif kind == "request":
            task = asyncio.create_task(self._answer(message))
            self._side.add(task)
            task.add_done_callback(self._side.discard)

    async def _answer(self, request: dict[str, Any]) -> None:
        """The adapter's own request: startDebugging to on_request; the rest refused."""
        command = str(request.get("command") or "")
        ok, body, message = False, {}, f"Eden's debugger doesn't do {command}."
        if command == "runInTerminal":
            message = "Eden shows the program's output in its debug console, not a terminal."
        elif command == "startDebugging" and self.on_request is not None:
            try:
                body = await self.on_request(self, request) or {}
                ok, message = True, ""
            except Exception as exc:  # (said to the adapter, which ends that child)
                message = str(exc) or "it couldn't start"
        self._send(
            {
                "type": "response",
                "request_seq": request.get("seq"),
                "command": command,
                "success": ok,
                **({"body": body} if ok else {"message": message}),
            }
        )

    def _send(self, message: dict[str, Any]) -> None:
        if self.closed:
            raise DapError("The debug adapter has ended.")
        self.seq += 1
        message = {"seq": self.seq, **message}
        try:
            self.writer.write(encode(message))
        except (OSError, RuntimeError) as exc:
            self._closed("The debug adapter has ended.")
            raise DapError("The debug adapter has ended.") from exc

    def send_request(self, command: str, arguments: dict[str, Any] | None = None) -> asyncio.Future:
        """A request sent; its answer (the response's body) as a future, not waited for."""
        future = asyncio.get_running_loop().create_future()
        self._send({"type": "request", "command": command, "arguments": arguments or {}})
        self.pending[self.seq] = future
        return future

    async def request(
        self,
        command: str,
        arguments: dict[str, Any] | None = None,
        timeout: float = REQUEST_SECONDS,
    ) -> dict[str, Any]:
        future = self.send_request(command, arguments)
        with contextlib.suppress(OSError, RuntimeError, AttributeError):
            await self.writer.drain()
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError as exc:
            raise DapError(f"The debug adapter didn't answer {command} in {timeout:g}s.") from exc

    async def wait_event(
        self, pred: Callable[[dict[str, Any]], bool], since: int, timeout: float
    ) -> dict[str, Any] | None:
        """The first event since index `since` that pred takes, waiting up to timeout; None
        when none came (or the adapter ended)."""
        for index, event in self.events:
            if index >= since and pred(event):
                return event
        if self.closed:
            return None
        future = asyncio.get_running_loop().create_future()
        waiter = (since, pred, future)
        self.waiters.append(waiter)
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            return None
        finally:
            if waiter in self.waiters:
                self.waiters.remove(waiter)

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            self.writer.close()
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(BaseException):
                await self._loop_task
        for task in list(self._side):
            task.cancel()
        self._closed("The debugger was stopped.")


def _refusal(message: dict[str, Any]) -> str:
    body = message.get("body") or {}
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and error.get("format"):
        text = str(error["format"])
        for key, value in (error.get("variables") or {}).items():
            text = text.replace("{" + str(key) + "}", str(value))
        return text[:1000]
    return str(message.get("message") or f"{message.get('command')} failed")[:1000]


# ── the adapters ──


@dataclass
class Adapter:
    """A debug adapter: what it debugs, the command that starts it (None: not installed
    here), and how to install it when it isn't."""

    id: str  # "python" | "node" | "lldb"
    name: str
    languages: tuple[str, ...]
    command: list[str] | None
    transport: str = "stdio"  # or "tcp": the command takes a port, then a host
    install: str = ""
    runtime: str = ""  # the interpreter it runs programs with (python, node), when it has one

    @property
    def available(self) -> bool:
        return bool(self.command)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "languages": list(self.languages),
            "available": self.available,
            "install": "" if self.available else self.install,
            "runtime": self.runtime,
        }


_detected: dict[tuple[str, ...], tuple[float, Any]] = {}


def _cached(key: tuple[str, ...], look: Callable[[], Any]) -> Any:
    hit = _detected.get(key)
    if hit is not None and time.monotonic() - hit[0] < DETECT_FRESH:
        return hit[1]
    value = look()
    _detected[key] = (time.monotonic(), value)
    return value


def _quiet(argv: list[str], env: dict[str, str], timeout: float = 10.0) -> tuple[int, str]:
    try:
        done = subprocess.run(  # noqa: S603 - the owner's own tools, only asked whether they're there
            argv, capture_output=True, text=True, timeout=timeout, env=env, check=False,
            stdin=subprocess.DEVNULL,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return -1, ""
    return done.returncode, (done.stdout or "").strip()


def python_for(root: Path, env: dict[str, str]) -> str | None:
    """The project's own Python: its .venv's (or venv's), else python3 / python on the PATH."""
    names = ("Scripts/python.exe",) if osplat.IS_WIN else ("bin/python3", "bin/python")
    for folder in (".venv", "venv", "env"):
        for name in names:
            path = root / folder / name
            if path.is_file():
                return str(path)  # (not resolved: a venv's python is the venv's by this path)
    return shutil.which("python3", path=env.get("PATH", "")) or shutil.which(
        "python", path=env.get("PATH", "")
    )


def js_debug_server(env: dict[str, str]) -> str | None:
    """js-debug's dapDebugServer.js: EDEN_JS_DEBUG, else where its download is usually put."""
    own = env.get("EDEN_JS_DEBUG") or os.environ.get("EDEN_JS_DEBUG")
    home = Path.home()
    for raw in (
        own,
        home / ".local/share/js-debug/src/dapDebugServer.js",
        home / ".local/share/js-debug/js-debug/src/dapDebugServer.js",
        home / "js-debug/src/dapDebugServer.js",
    ):
        if raw and Path(raw).expanduser().is_file():
            return str(Path(raw).expanduser())
    return None


def lldb_dap(env: dict[str, str]) -> str | None:
    """lldb-dap (lldb-vscode, its old name): on the PATH, else Xcode's through xcrun."""
    for name in ("lldb-dap", "lldb-vscode"):
        found = shutil.which(name, path=env.get("PATH", ""))
        if found:
            return found
    if osplat.IS_MAC and shutil.which("xcrun"):
        code, out = _quiet(["xcrun", "-f", "lldb-dap"], env)
        if code == 0 and out and Path(out).is_file():
            return out
    return None


def find_adapters(root: Path, env: dict[str, str]) -> list[Adapter]:
    """Every adapter Eden knows, each with its command when it's installed here."""
    py = python_for(root, env)
    has_debugpy = bool(py) and _cached(
        ("debugpy", py or ""), lambda: _quiet([py, "-c", "import debugpy"], env)[0] == 0
    )
    python = Adapter(
        "python",
        "debugpy",
        ("python",),
        [py, "-m", "debugpy.adapter"] if py and has_debugpy else None,
        runtime=py or "",
        install=(
            f"debugpy isn't installed for {py}. Install it with: {py} -m pip install debugpy"
            if py
            else "No Python found for this project (no .venv, no python3 on the PATH)."
        ),
    )
    node = shutil.which("node", path=env.get("PATH", ""))
    server = js_debug_server(env)
    js = Adapter(
        "node",
        "js-debug",
        ("javascript", "typescript", "node"),
        [node, server] if node and server else None,
        transport="tcp",
        runtime=node or "",
        install=(
            "Node.js isn't installed (https://nodejs.org)."
            if not node
            else "js-debug isn't here. Download js-debug-dap-<version>.tar.gz from "
            "https://github.com/microsoft/vscode-js-debug/releases and unpack it into "
            "~/.local/share/ (so ~/.local/share/js-debug/src/dapDebugServer.js exists), or set "
            "EDEN_JS_DEBUG to its dapDebugServer.js."
        ),
    )
    found = _cached(("lldb", env.get("PATH", "")), lambda: lldb_dap(env))
    lldb = Adapter(
        "lldb",
        "lldb-dap",
        ("swift", "c", "cpp", "objc", "rust"),
        [found] if found else None,
        install=(
            "lldb-dap comes with Xcode's command-line tools: xcode-select --install"
            if osplat.IS_MAC
            else "lldb-dap comes with LLVM's lldb (for example: sudo apt install lldb)."
        ),
    )
    return [python, js, lldb]


def adapter_for(language: str, adapters: list[Adapter]) -> Adapter | None:
    """The adapter for a language ("python", "node", "swift"…) or an adapter's own id."""
    word = (language or "").strip().lower()
    word = {"js": "javascript", "ts": "typescript", "c++": "cpp", "objective-c": "objc"}.get(
        word, word
    )
    for adapter in adapters:
        if word == adapter.id or word == adapter.name or word in adapter.languages:
            return adapter
    return None


def launch_config(
    adapter: Adapter,
    *,
    program: str = "",
    module: str = "",
    args: list[str] | None = None,
    cwd: str = "",
    stop_on_entry: bool = False,
) -> dict[str, Any]:
    """The launch request's arguments for an adapter."""
    args = [str(a) for a in (args or [])]
    if adapter.id == "python":
        config: dict[str, Any] = {
            "name": "Eden Code",
            "type": "python",
            "request": "launch",
            "console": "internalConsole",
            "justMyCode": True,
            "stopOnEntry": stop_on_entry,
            "args": args,
            "cwd": cwd,
        }
        if adapter.runtime:
            config["python"] = [adapter.runtime]
        if module:
            config["module"] = module
        else:
            config["program"] = program
        return config
    if adapter.id == "node":
        return {
            "name": "Eden Code",
            "type": "pwa-node",
            "request": "launch",
            "console": "internalConsole",
            "program": program,
            "args": args,
            "cwd": cwd,
            "stopOnEntry": stop_on_entry,
            **({"runtimeExecutable": adapter.runtime} if adapter.runtime else {}),
        }
    return {
        "name": "Eden Code",
        "program": program,
        "args": args,
        "cwd": cwd,
        "stopOnEntry": stop_on_entry,
    }


def attach_config(
    adapter: Adapter, *, pid: int = 0, port: int = 0, host: str = "127.0.0.1"
) -> dict[str, Any]:
    """The attach request's arguments: a process by its id, or a debug server by its port."""
    if adapter.id == "python":
        target = {"processId": pid} if pid else {"connect": {"host": host, "port": port}}
        return {
            "name": "Eden Code",
            "type": "python",
            "request": "attach",
            "justMyCode": True,
            **target,
        }
    if adapter.id == "node":
        target = {"processId": str(pid)} if pid else {"address": host, "port": port}
        return {"name": "Eden Code", "type": "pwa-node", "request": "attach", **target}
    if not pid:
        raise DapError("lldb-dap attaches to a process by its id (pid), not a port.")
    return {"name": "Eden Code", "pid": pid}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def clip(text: Any, limit: int = VALUE_MAX) -> str:
    text = str(text if text is not None else "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ── one debugging run ──


@dataclass
class Breakpoint:
    line: int
    condition: str = ""
    verified: bool | None = None
    message: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "line": self.line,
            "condition": self.condition,
            "verified": self.verified,
            "message": self.message,
        }


@dataclass
class DebugSession:
    """One debugger run: its adapter, the program it launched (or the process it attached
    to), where it's stopped, and its limits."""

    adapter: Adapter
    root: Path
    env: dict[str, str]
    driver: str = "agent"  # who started it: "agent" | "user"
    on_change: Callable[[], None] | None = None
    steps_max: int = STEPS_MAX
    seconds_max: float = SESSION_SECONDS
    control: str = "agent"  # who drives it now: "agent" | "user" (Take over)
    request_kind: str = "launch"  # | "attach"
    target: str = ""  # what it debugs, in words
    state: str = "starting"  # starting | running | stopped | ended
    reason: str = ""  # why it stopped (breakpoint, step, exception…), or how it ended
    thread_id: int | None = None
    exit_code: int | None = None
    steps: int = 0
    started_at: float = field(default_factory=time.monotonic)
    output: deque = field(default_factory=lambda: deque(maxlen=OUTPUT_LINES))
    breakpoints: dict[str, list[Breakpoint]] = field(default_factory=dict)
    pids: set[int] = field(default_factory=set)  # the debuggee's processes, as the adapter says
    frames: list[dict[str, Any]] = field(default_factory=list)  # (the latest stack, for the pane)
    scopes: list[dict[str, Any]] = field(default_factory=list)  # (the top frame's, for the pane)
    exception: str = ""

    def __post_init__(self) -> None:
        self.client: DapClient | None = None  # the adapter's connection
        self.child: DapClient | None = None  # js-debug's child session, which does the work
        self.proc: asyncio.subprocess.Process | None = None
        self.port = 0
        self._stderr: deque[str] = deque(maxlen=40)
        self._stderr_task: asyncio.Task | None = None
        self._watchdog: asyncio.Task | None = None
        self._stopping = False

    # ── which connection ──

    @property
    def active(self) -> DapClient:
        client = self.child or self.client
        if client is None or client.closed:
            raise DapError(
                "The debugger has ended."
                if self.state == "ended"
                else "The debugger isn't running."
            )
        return client

    def _changed(self) -> None:
        if self.on_change is not None:
            try:
                self.on_change()
            except Exception:
                log.exception("debugger: couldn't tell the window")

    # ── starting ──

    async def _start_adapter(self) -> DapClient:
        argv = list(self.adapter.command or [])
        if not argv:
            raise DapError(f"{self.adapter.name} isn't installed. {self.adapter.install}")
        if self.adapter.transport == "tcp":
            self.port = free_port()
            argv += [str(self.port), "127.0.0.1"]
        try:
            self.proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-S",
                "-c",
                runproc.SUPERVISE_WIN if osplat.IS_WIN else runproc.SUPERVISE,
                *argv,
                cwd=str(self.root),
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=MESSAGE_MAX,
                **osplat.group_popen_kwargs(),
            )
        except OSError as exc:
            raise DapError(f"{self.adapter.name} couldn't start: {exc.strerror or exc}") from exc
        self._stderr_task = asyncio.create_task(self._read_stderr())
        if self.adapter.transport == "tcp":
            reader, writer = await self._connect()
        else:
            assert self.proc.stdout is not None and self.proc.stdin is not None
            reader, writer = self.proc.stdout, self.proc.stdin
        client = DapClient(reader, writer, on_event=self._event, on_request=self._start_child)
        client.start()
        return client

    async def _connect(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        deadline = time.monotonic() + 10.0
        while True:
            try:
                return await asyncio.open_connection("127.0.0.1", self.port, limit=MESSAGE_MAX)
            except OSError:
                if time.monotonic() > deadline or (self.proc and self.proc.returncode is not None):
                    raise DapError(
                        f"{self.adapter.name} didn't open its port. {self._why()}".strip()
                    ) from None
                await asyncio.sleep(0.1)

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        with contextlib.suppress(Exception):
            while line := await self.proc.stderr.readline():
                self._stderr.append(line.decode(errors="replace").rstrip()[:300])

    def _why(self) -> str:
        return " ".join(list(self._stderr)[-3:])[:600]

    async def _initialize(self, client: DapClient) -> None:
        client.capabilities = await client.request(
            "initialize",
            {
                "clientID": "eden-code",
                "clientName": "Eden Code",
                "adapterID": self.adapter.id,
                "pathFormat": "path",
                "linesStartAt1": True,
                "columnsStartAt1": True,
                "supportsVariableType": True,
                "supportsRunInTerminalRequest": False,
                "supportsStartDebuggingRequest": True,
                "locale": "en",
            },
        )

    async def _configure(self, client: DapClient, command: str, config: dict[str, Any]) -> None:
        """launch or attach, breakpoints once the adapter is initialized, then
        configurationDone. (debugpy answers launch only after configurationDone; lldb-dap
        before "initialized"; either way the answer is awaited last.)"""
        since = client.event_count
        answer = client.send_request(command, config)
        initialized = asyncio.ensure_future(
            client.wait_event(lambda e: e.get("event") == "initialized", since, START_SECONDS)
        )
        done, _ = await asyncio.wait(
            {answer, initialized}, timeout=START_SECONDS, return_when=asyncio.FIRST_COMPLETED
        )
        if answer in done and answer.exception() is not None:
            initialized.cancel()
            raise answer.exception()
        event = await initialized
        if event is None:
            if not answer.done():
                answer.cancel()
            raise DapError(
                f"{self.adapter.name} didn't get ready in {START_SECONDS:g}s. {self._why()}".strip()
            )
        for path in list(self.breakpoints):
            await self._send_breakpoints(client, path)
        if client.capabilities.get("supportsConfigurationDoneRequest", True):
            await client.request("configurationDone")
        try:
            await asyncio.wait_for(answer, START_SECONDS)
        except TimeoutError as exc:
            raise DapError(f"{self.adapter.name} didn't {command} in {START_SECONDS:g}s.") from exc

    async def _start_child(self, parent: DapClient, request: dict[str, Any]) -> dict[str, Any]:
        """js-debug's startDebugging: the real program's session, on a connection of its own
        to the same server, which then takes the requests."""
        arguments = request.get("arguments") or {}
        config = dict(arguments.get("configuration") or {})
        kind = "attach" if arguments.get("request") == "attach" else "launch"
        if not self.port:
            raise DapError("only a server adapter starts child sessions")
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port, limit=MESSAGE_MAX)
        child = DapClient(reader, writer, on_event=self._event, on_request=self._start_child)
        child.start()
        old, self.child = self.child, child
        if old is not None:
            await old.close()
        await self._initialize(child)
        asyncio.ensure_future(self._configure_child(child, kind, config))
        return {}

    async def _configure_child(self, child: DapClient, kind: str, config: dict[str, Any]) -> None:
        try:
            await self._configure(child, kind, config)
        except DapError as exc:
            self.output.append(f"[debugger] the program's session couldn't start: {exc}")
            self._changed()

    async def launch(
        self, config: dict[str, Any], breakpoints: dict[str, list[Breakpoint]] | None = None
    ) -> None:
        self.request_kind = "launch"
        self.target = str(config.get("module") or config.get("program") or "")
        await self._begin("launch", config, breakpoints)

    async def attach(
        self, config: dict[str, Any], breakpoints: dict[str, list[Breakpoint]] | None = None
    ) -> None:
        self.request_kind = "attach"
        pid = config.get("processId") or config.get("pid")
        connect = config.get("connect") or {}
        port = config.get("port") or connect.get("port")
        self.target = f"process {pid}" if pid else f"port {port}"
        await self._begin("attach", config, breakpoints)

    async def _begin(
        self, command: str, config: dict[str, Any], breakpoints: dict[str, list[Breakpoint]] | None
    ) -> None:
        self.breakpoints = dict(breakpoints or {})
        self._watchdog = asyncio.create_task(self._watch())
        try:
            self.client = await asyncio.wait_for(self._start_adapter(), START_SECONDS)
            await self._initialize(self.client)
            await self._configure(self.client, command, config)
        except (DapError, TimeoutError) as exc:
            why = str(exc) or f"{self.adapter.name} didn't start in {START_SECONDS:g}s."
            await asyncio.sleep(0.05)  # (its last words on stderr)
            if self._why() and self._why() not in why:
                why = f"{why} {self._why()}"
            await self.stop(why=why)
            raise DapError(why) from exc
        if self.state == "starting":
            self.state = "running"
        self._changed()

    async def _watch(self) -> None:
        """SESSION_SECONDS in all, and the adapter's own end."""
        try:
            while not self._stopping:
                await asyncio.sleep(0.5)
                if time.monotonic() - self.started_at > self.seconds_max:
                    await self.stop(
                        why=f"Stopped after {self.seconds_max / 60:g} minutes (the debugger's limit)."
                    )
                    return
                if (
                    self.proc is not None
                    and self.proc.returncode is not None
                    and self.state != "ended"
                ):
                    self.state, self.reason = (
                        "ended",
                        self.reason or f"The debug adapter ended. {self._why()}".strip(),
                    )
                    self._changed()
                    return
        except asyncio.CancelledError:
            pass

    # ── what the adapter says ──

    def _event(self, client: DapClient, message: dict[str, Any]) -> None:
        if (
            self.child is not None
            and client is self.client
            and message.get("event") in ("stopped", "continued", "output")
        ):
            return  # (js-debug's parent: its child says these, for the real program)
        name = message.get("event")
        body = message.get("body") or {}
        if name == "stopped":
            self.state = "stopped"
            self.reason = str(body.get("reason") or "paused")
            self.thread_id = body.get("threadId", self.thread_id)
            self.exception = (
                clip(body.get("text") or body.get("description") or "", 600)
                if self.reason == "exception"
                else ""
            )
            self.frames, self.scopes = [], []
        elif name == "continued":
            if body.get("allThreadsContinued", True) or body.get("threadId") == self.thread_id:
                self.state, self.frames, self.scopes = "running", [], []
        elif name in ("terminated", "exited"):
            if name == "exited":
                self.exit_code = body.get("exitCode")
            if self.child is not None and client is self.child and name == "terminated":
                pass  # (the parent ends it too)
            self.state = "ended"
            self.reason = (
                f"The program ended (exit code {self.exit_code})."
                if self.exit_code is not None
                else "The program ended."
            )
            self.frames, self.scopes = [], []
        elif name == "output":
            category = str(body.get("category") or "console")
            if category != "telemetry":
                for line in str(body.get("output") or "").splitlines():
                    self.output.append(line[:1000])
        elif name == "process":
            with contextlib.suppress(TypeError, ValueError):
                if body.get("systemProcessId"):
                    self.pids.add(int(body["systemProcessId"]))
        elif name == "breakpoint":
            self._breakpoint_changed(body.get("breakpoint") or {})
        else:
            return
        self._changed()

    def _breakpoint_changed(self, found: dict[str, Any]) -> None:
        path = str((found.get("source") or {}).get("path") or "")
        for bp in self.breakpoints.get(path, []):
            if bp.line == found.get("line"):
                bp.verified = bool(found.get("verified"))
                bp.message = clip(found.get("message") or "", 200)

    # ── breakpoints ──

    async def _send_breakpoints(self, client: DapClient, path: str) -> None:
        wanted = self.breakpoints.get(path, [])
        body = await client.request(
            "setBreakpoints",
            {
                "source": {"path": path, "name": Path(path).name},
                "breakpoints": [
                    {"line": b.line, **({"condition": b.condition} if b.condition else {})}
                    for b in wanted
                ],
                "lines": [b.line for b in wanted],
            },
        )
        for bp, answer in zip(wanted, body.get("breakpoints") or [], strict=False):
            bp.verified = bool(answer.get("verified"))
            bp.message = clip(answer.get("message") or "", 200)
            if isinstance(answer.get("line"), int):
                bp.line = answer["line"]

    async def set_breakpoints(self, path: str, lines: list[tuple[int, str]]) -> list[Breakpoint]:
        """A file's breakpoints, all of them (an empty list clears them)."""
        self.breakpoints[path] = [Breakpoint(line, cond) for line, cond in lines]
        if self.state != "ended" and (self.child or self.client):
            await self._send_breakpoints(self.active, path)
        if not self.breakpoints[path]:
            del self.breakpoints[path]
        self._changed()
        return self.breakpoints.get(path, [])

    # ── moving ──

    def _count_step(self) -> None:
        if self.steps >= self.steps_max:
            raise DapError(
                f"This run has used its {self.steps_max} continues and steps. Stop it and start "
                "again with better breakpoints, or ask the user."
            )
        self.steps += 1

    async def threads(self) -> list[dict[str, Any]]:
        body = await self.active.request("threads")
        return list(body.get("threads") or [])

    async def _thread(self, thread_id: int | None) -> int:
        if thread_id:
            return int(thread_id)
        if self.thread_id:
            return int(self.thread_id)
        threads = await self.threads()
        if not threads:
            raise DapError("The program has no threads to debug.")
        self.thread_id = int(threads[0]["id"])
        return self.thread_id

    async def resume(
        self, action: str = "continue", thread_id: int | None = None, wait: float = WAIT_SECONDS
    ) -> dict[str, Any]:
        """continue, next (step over), stepIn, stepOut; then wait for it to stop somewhere
        (or end) for up to `wait` seconds."""
        if action not in ("continue", "next", "stepIn", "stepOut"):
            raise DapError(f"Unknown step: {action}")
        if self.state == "ended":
            raise DapError(self.reason or "The program has ended.")
        if action != "continue" and self.state != "stopped":
            raise DapError("The program isn't stopped: pause it first, or wait for a breakpoint.")
        self._count_step()
        client = self.active
        since = client.event_count
        thread = await self._thread(thread_id)
        self.state, self.frames, self.scopes = "running", [], []
        self._changed()
        await client.request(action, {"threadId": thread})
        return await self.wait(wait, since=since)

    async def wait(self, seconds: float = WAIT_SECONDS, since: int | None = None) -> dict[str, Any]:
        """Wait for the program to stop or end: where it is then, or that it's still running."""
        seconds = max(0.0, min(float(seconds), WAIT_MAX))
        if self.state in ("stopped", "ended") and since is None:
            return await self.where()
        client = self.active
        event = await client.wait_event(
            lambda e: e.get("event") in STOP_EVENTS,
            client.event_count if since is None else since,
            seconds,
        )
        if event is None and self.state not in ("stopped", "ended"):
            return {"state": "running", "note": f"Still running after {seconds:g}s."}
        return await self.where()

    async def pause(self, thread_id: int | None = None, wait: float = 10.0) -> dict[str, Any]:
        if self.state == "stopped":
            return await self.where()
        client = self.active
        since = client.event_count
        await client.request("pause", {"threadId": await self._thread(thread_id)})
        return await self.wait(wait, since=since)

    # ── reading ──

    async def stack(
        self, thread_id: int | None = None, levels: int = FRAMES_MAX
    ) -> list[dict[str, Any]]:
        if self.state != "stopped":
            raise DapError("The program isn't stopped, so it has no stack to show.")
        thread = await self._thread(thread_id)
        body = await self.active.request(
            "stackTrace",
            {"threadId": thread, "startFrame": 0, "levels": max(1, min(levels, FRAMES_MAX))},
        )
        frames = []
        for f in (body.get("stackFrames") or [])[:FRAMES_MAX]:
            source = f.get("source") or {}
            frames.append(
                {
                    "id": f.get("id"),
                    "name": clip(f.get("name"), 160),
                    "file": str(source.get("path") or source.get("name") or ""),
                    "line": f.get("line") or 0,
                }
            )
        if thread == self.thread_id:
            self.frames = frames
        return frames

    async def scopes_of(self, frame_id: int) -> list[dict[str, Any]]:
        body = await self.active.request("scopes", {"frameId": int(frame_id)})
        return [
            {
                "name": clip(s.get("name"), 80),
                "ref": s.get("variablesReference") or 0,
                "expensive": bool(s.get("expensive")),
            }
            for s in body.get("scopes") or []
        ]

    async def variables(self, ref: int, limit: int = VARS_MAX) -> list[dict[str, Any]]:
        if self.state != "stopped":
            raise DapError("The program isn't stopped, so its variables can't be read.")
        body = await self.active.request("variables", {"variablesReference": int(ref)})
        return [
            {
                "name": clip(v.get("name"), 120),
                "value": clip(v.get("value")),
                "type": clip(v.get("type") or "", 80),
                "ref": v.get("variablesReference") or 0,
            }
            for v in (body.get("variables") or [])[: max(1, min(limit, VARS_MAX))]
        ]

    async def evaluate(
        self, expression: str, frame_id: int | None = None, context: str = "repl"
    ) -> dict[str, Any]:
        if self.state != "stopped":
            raise DapError(
                "The program isn't stopped: expressions are evaluated where it's stopped."
            )
        if frame_id is None:
            frames = self.frames or await self.stack()
            frame_id = frames[0]["id"] if frames else None
        body = await self.active.request(
            "evaluate",
            {
                "expression": expression,
                "context": context,
                **({"frameId": int(frame_id)} if frame_id is not None else {}),
            },
        )
        return {
            "result": clip(body.get("result"), EVAL_MAX),
            "type": clip(body.get("type") or "", 80),
            "ref": body.get("variablesReference") or 0,
        }

    async def where(self) -> dict[str, Any]:
        """Where it is: stopped (why, the stack, the top frame's source and locals), running
        or ended (how)."""
        report: dict[str, Any] = {
            "state": self.state,
            "reason": self.reason,
            "steps": self.steps,
            "steps_max": self.steps_max,
        }
        if self.exception:
            report["exception"] = self.exception
        if self.state == "ended":
            report["output"] = list(self.output)[-20:]
            return report
        if self.state != "stopped":
            return report
        try:
            frames = await self.stack()
        except DapError as exc:
            report["error"] = str(exc)
            return report
        report["frames"] = frames[:12]
        if frames:
            top = frames[0]
            report["source"] = self.source_around(top["file"], int(top["line"] or 0))
            try:
                scopes = await self.scopes_of(top["id"])
                for scope in scopes:
                    scope["variables"] = (
                        []
                        if scope["expensive"]
                        else await self.variables(scope["ref"], LOCALS_IN_REPORT)
                    )
                self.scopes = scopes
                report["scopes"] = scopes[:2]
            except DapError as exc:
                report["error"] = str(exc)
        self._changed()
        return report

    def source_around(self, file: str, line: int) -> list[str]:
        """A few lines either side of a stopped line, for a file in the project only."""
        try:
            path = Path(file).resolve()
            root = self.root.resolve()
        except (OSError, RuntimeError, ValueError):
            return []
        if not file or not line or not (path == root or root in path.parents) or not path.is_file():
            return []
        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                lines = [next(fh, "") for _ in range(line + SOURCE_AROUND)]
        except OSError:
            return []
        first = max(1, line - SOURCE_AROUND)
        return [
            f"{'>' if n == line else ' '}{n:5} {clip(lines[n - 1].rstrip(), 200)}"
            for n in range(first, min(len(lines), line + SOURCE_AROUND) + 1)
            if n - 1 < len(lines)
        ]

    # ── ending ──

    async def stop(self, why: str = "") -> None:
        """Disconnect (a launched program goes with it; an attached one is left running),
        then the adapter's whole group."""
        if self._stopping:
            return
        self._stopping = True
        terminate = self.request_kind == "launch"
        for client in (self.child, self.client):
            if client is not None and not client.closed:
                with contextlib.suppress(Exception):
                    await client.request(
                        "disconnect",
                        {"terminateDebuggee": terminate, "restart": False},
                        timeout=3.0,
                    )
        for client in (self.child, self.client):
            if client is not None:
                await client.close()
        if self.proc is not None and self.proc.returncode is None:
            runproc.signal_group(self.proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(self.proc.wait(), 3.0)
            except TimeoutError:
                await asyncio.to_thread(runproc.kill_leftovers, self.proc.pid)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.proc.wait(), 3.0)
        if self._stderr_task is not None:
            self._stderr_task.cancel()
        if self._watchdog is not None and self._watchdog is not asyncio.current_task():
            self._watchdog.cancel()
        if self.state != "ended" or why:
            self.state = "ended"
            self.reason = why or self.reason or "Stopped."
        self.frames, self.scopes = [], []
        self._changed()

    def kill_now(self) -> None:
        """The app is quitting: the adapter's group goes at once."""
        self._stopping = True
        if self.proc is not None and self.proc.returncode is None:
            runproc.signal_group(self.proc.pid, signal.SIGTERM)

    # ── for the window ──

    def snapshot(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter.name,
            "language": self.adapter.id,
            "driver": self.driver,
            "control": self.control,
            "request": self.request_kind,
            "target": clip(self.target, 200),
            "state": self.state,
            "reason": self.reason,
            "exception": self.exception,
            "thread": self.thread_id,
            "steps": self.steps,
            "steps_max": self.steps_max,
            "seconds": round(time.monotonic() - self.started_at),
            "seconds_max": self.seconds_max,
            "frames": self.frames[:FRAMES_MAX],
            "scopes": self.scopes[:4],
            "breakpoints": {
                path: [b.public() for b in bps] for path, bps in self.breakpoints.items()
            },
            "output": list(self.output)[-80:],
        }


def report_text(report: dict[str, Any], root: Path | None = None) -> str:
    """A stop's report (DebugSession.where) as the agent reads it."""

    def short(file: str) -> str:
        if root is not None:
            with contextlib.suppress(ValueError, OSError):
                return str(Path(file).resolve().relative_to(root.resolve()))
        return file

    state = report.get("state")
    if state == "running":
        return f"Running. {report.get('note', '')}".strip()
    if state == "ended":
        lines = [str(report.get("reason") or "The program ended.")]
        if report.get("output"):
            lines += ["Last output:", *report["output"]]
        return "\n".join(lines)
    if state != "stopped":
        return f"The debugger is {state}."
    lines = [
        f"Stopped: {report.get('reason') or 'paused'} (step {report.get('steps')}/{report.get('steps_max')})."
    ]
    if report.get("exception"):
        lines.append(f"Exception: {report['exception']}")
    frames = report.get("frames") or []
    if frames:
        lines.append("Stack (innermost first):")
        lines += [f"  #{f['id']} {f['name']} at {short(f['file'])}:{f['line']}" for f in frames]
    if report.get("source"):
        lines += ["Source:", *report["source"]]
    for scope in report.get("scopes") or []:
        vars_ = scope.get("variables") or []
        lines.append(f"{scope['name']}:" + ("" if vars_ else " (not loaded; ask debug_variables)"))
        lines += [
            f"  {v['name']} = {v['value']}"
            + (f"  ({v['type']})" if v.get("type") else "")
            + (f"  [ref {v['ref']}]" if v.get("ref") else "")
            for v in vars_
        ]
    if report.get("error"):
        lines.append(f"(couldn't read everything: {report['error']})")
    return "\n".join(lines)
