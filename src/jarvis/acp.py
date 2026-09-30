"""Other coding agents in Jarvis Code over the Agent Client Protocol (ACP): a JSON-RPC 2.0
client over an agent's stdin and stdout (AcpConnection), and AcpClient, which looks to
TaskManager like the Claude Agent SDK's client, so an ACP session is an ordinary Jarvis Code
session: transcript, cards, queue, interrupt.

The protocol, as used here (version 1): the client sends initialize, session/new (or
session/load to resume, when the agent can), session/prompt (it answers when the turn
ends, with a stop reason) and the session/cancel notification; the agent sends session/update
notifications (its words and thinking in chunks, tool calls and their updates, its plan) and
asks session/request_permission, which JARVIS's own policy answers (TaskManager.policy_for:
the mode, the owner's rules, a card). JARVIS offers the agent no file system or terminal of
its own (clientCapabilities all false) and no MCP servers: the agent works with its own
tools, and asks before the steps it would ask its user about.

Its steps are shown as the SDK's messages (ToolUseBlock / ToolResultBlock), under the names
JARVIS's policy knows: execute is Bash, read is Read, edit is Edit, fetch is WebFetch,
search is Grep; any other kind of step has a name no policy lets by unasked.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import shlex
import time
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import StreamEvent

from .packaged import owner_env

log = logging.getLogger("jarvis")

PROTOCOL_VERSION = 1
LINE_LIMIT = 8 * 1024 * 1024  # one JSON-RPC message, at most
START_TIMEOUT = 60.0  # initialize, and a session made or loaded
STDERR_KEPT = 20  # the agent's last lines of stderr, for saying why it stopped
TOOLS_KEPT = 500
TEXT_CHARS = 4000
KIND_TOOLS = {
    "execute": "Bash",
    "read": "Read",
    "edit": "Edit",
    "fetch": "WebFetch",
    "search": "Grep",
    "delete": "Delete",
    "move": "Move",
    "think": "Think",
    "switch_mode": "SwitchMode",
}
STOPS = {  # a stop reason, as a turn's end: (subtype, is an error)
    "end_turn": ("success", False),
    "max_tokens": ("success", False),
    "max_turn_requests": ("error_max_turns", True),
    "refusal": ("error_during_execution", True),
    "cancelled": ("success", False),
}


class AcpError(Exception):
    """A JSON-RPC error (code, message), or the agent gone."""

    def __init__(self, message: str, code: int = -32603) -> None:
        super().__init__(message)
        self.code = code


class AcpConnection:
    """One ACP agent process, and JSON-RPC over its stdin and stdout (a message a line).
    on_notify(method, params) hears its notifications; on_request(method, params) answers
    its requests (a result, or AcpError); on_close() hears it end."""

    def __init__(
        self,
        command: list[str],
        cwd: str | Path,
        on_notify: Callable[[str, dict[str, Any]], None],
        on_request: Callable[[str, dict[str, Any]], Awaitable[Any]],
        on_close: Callable[[], None] | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.command = command
        self.cwd = str(cwd)
        self.on_notify, self.on_request, self.on_close = on_notify, on_request, on_close
        self.env = env
        self.proc: asyncio.subprocess.Process | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.ids = itertools.count(1)
        self.stderr: deque[str] = deque(maxlen=STDERR_KEPT)
        self.closed = False
        self._tasks: set[asyncio.Task] = set()
        self._write_lock = asyncio.Lock()

    async def start(self) -> None:
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.command,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=LINE_LIMIT,
            )
        except OSError as exc:
            raise AcpError(f"It couldn't be started: {exc.strerror or exc}") from exc
        self._spawn(self._read())
        self._spawn(self._read_stderr())

    def _spawn(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def why(self) -> str:
        """The agent's last words on stderr, for an error message."""
        said = [line for line in self.stderr if line.strip()]
        return said[-1][:300] if said else ""

    async def _send(self, message: dict[str, Any]) -> None:
        if self.closed or self.proc is None or self.proc.stdin is None:
            raise AcpError("The agent isn't running.")
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        async with self._write_lock:
            try:
                self.proc.stdin.write(data)
                await self.proc.stdin.drain()
            except (ConnectionError, RuntimeError) as exc:
                raise AcpError("The agent isn't running.") from exc

    async def request(
        self, method: str, params: dict[str, Any], timeout: float | None = None
    ) -> Any:
        request_id = next(self.ids)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self._send(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
            return await (asyncio.wait_for(future, timeout) if timeout else future)
        except TimeoutError as exc:
            raise AcpError(f"The agent didn't answer {method} in time.") from exc
        finally:
            self.pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            while True:
                try:
                    line = await self.proc.stdout.readline()
                except ValueError:  # a line past the limit: skipped, as it can't be read
                    log.warning("ACP agent: a message past %d bytes was skipped", LINE_LIMIT)
                    continue
                if not line:
                    break
                try:
                    message = json.loads(line)
                except (ValueError, RecursionError):
                    continue  # (a log line on stdout, or JSON nested too deep to read)
                if isinstance(message, dict):
                    try:
                        self._take(message)
                    except Exception:  # one message it can't use never ends the session
                        log.warning("ACP agent: a message that couldn't be used was skipped")
        finally:
            self._closed()

    def _take(self, message: dict[str, Any]) -> None:
        if "method" not in message:  # a response to one of ours
            request_id = message.get("id")
            future = self.pending.get(request_id) if isinstance(request_id, int | str) else None
            if future is None or future.done():
                return
            error = message.get("error")
            if isinstance(error, dict):
                code = error.get("code") if isinstance(error.get("code"), int) else -32603
                future.set_exception(AcpError(str(error.get("message") or "error")[:500], code))
            else:
                future.set_result(message.get("result"))
            return
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if "id" in message:
            self._spawn(self._answer(message["id"], method, params))
            return
        try:
            self.on_notify(method, params)
        except Exception:
            log.exception("ACP agent: couldn't take in a %s", method)

    async def _answer(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self.on_request(method, params)
            reply = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except AcpError as exc:
            reply = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": exc.code, "message": str(exc)},
            }
        except Exception:
            log.exception("ACP agent: couldn't answer a %s", method)
            reply = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": "internal error"},
            }
        with contextlib.suppress(AcpError):
            await self._send(reply)

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        with contextlib.suppress(Exception):
            while line := await self.proc.stderr.readline():
                self.stderr.append(line.decode("utf-8", "replace").rstrip())

    def _closed(self) -> None:
        if self.closed:
            return
        self.closed = True
        why = self.why()
        for future in self.pending.values():
            if not future.done():
                future.set_exception(AcpError(f"The agent stopped{': ' + why if why else '.'}"))
        if self.on_close is not None:
            self.on_close()

    async def close(self) -> None:
        """End the agent: its stdin closed, then a stop, then a kill."""
        proc = self.proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(Exception):
                if proc.stdin is not None:
                    proc.stdin.close()
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), 3)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                    with contextlib.suppress(Exception):
                        await proc.wait()
        self._closed()
        for task in list(self._tasks):
            task.cancel()


def _text(content: Any) -> str:
    """A content block's text (only text blocks have words to show)."""
    if isinstance(content, dict) and content.get("type") == "text":
        return str(content.get("text") or "")
    return ""


def tool_of(call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """An ACP tool call as a step JARVIS's policy and transcript know: (name, input)."""
    kind = str(call.get("kind") or "other")
    name = KIND_TOOLS.get(kind, "AgentTool")
    raw = call.get("rawInput") if isinstance(call.get("rawInput"), dict) else {}
    locations = call.get("locations") if isinstance(call.get("locations"), list) else []
    paths = [str(loc["path"]) for loc in locations if isinstance(loc, dict) and loc.get("path")]
    title = " ".join(str(call.get("title") or "").split())[:500]
    path = (
        paths[0]
        if paths
        else str(raw.get("path") or raw.get("file_path") or raw.get("abs_path") or "")
    )
    if name == "Bash":
        command = raw.get("command") or raw.get("cmd")
        if isinstance(command, list):
            command = shlex.join(str(c) for c in command)
        return name, {"command": str(command or title)[:4000], "description": title}
    if name in ("Read", "Edit", "Delete"):
        return name, {"file_path": path}
    if name == "Move":
        return name, {"file_path": path, "destination": paths[1] if len(paths) > 1 else ""}
    if name == "Grep":
        return name, {
            "pattern": str(raw.get("pattern") or raw.get("query") or title)[:500],
            "path": path,
        }
    if name == "WebFetch":
        return name, {"url": str(raw.get("url") or title)[:2000], "prompt": ""}
    shown = json.dumps(raw, ensure_ascii=False)[:2000] if raw else ""
    return name, {"title": title, "input": shown}


def _output(update: dict[str, Any]) -> str:
    """What a finished tool call gave back, as text for its result."""
    parts: list[str] = []
    for item in update.get("content") or [] if isinstance(update.get("content"), list) else []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "content":
            parts.append(_text(item.get("content")))
        elif item.get("type") == "diff":
            parts.append(f"Changed {item.get('path') or 'a file'}")
        elif item.get("type") == "terminal":
            parts.append("(ran in the agent's terminal)")
    if not parts and update.get("rawOutput") is not None:
        raw = update["rawOutput"]
        parts.append(raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False))
    return "\n".join(p for p in parts if p)[:TEXT_CHARS]


class AcpClient:
    """The Claude Agent SDK's client as TaskManager uses it (connect, query,
    receive_messages, interrupt…), over an ACP agent: a session there, its updates as the
    SDK's messages, its permission requests answered by options.can_use_tool."""

    def __init__(
        self, command: list[str], name: str, options: Any, env: dict[str, str] | None = None
    ) -> None:
        self.command, self.name, self.options = command, name, options
        self.env = {
            **owner_env(os.environ),
            **(env or {}),
            **dict(getattr(options, "env", {}) or {}),
        }
        self.conn: AcpConnection | None = None
        self.session_id = ""
        self.caps: dict[str, Any] = {}
        self.queue: asyncio.Queue = asyncio.Queue()
        self.prompting: asyncio.Task | None = None
        self.asking: set[asyncio.Task] = set()
        self.loading = False
        self.turns = 0
        self.words: list[str] = []
        self.thought: list[str] = []
        self.said = ""  # the turn's reply so far
        self.tools: OrderedDict[str, dict[str, Any]] = OrderedDict()

    async def __aenter__(self) -> AcpClient:
        await self.connect()
        return self

    async def __aexit__(self, *_exc: Any) -> bool:
        await self.disconnect()
        return False

    async def connect(self, _prompt: Any = None) -> None:
        cwd = str(getattr(self.options, "cwd", None) or os.getcwd())
        self.conn = AcpConnection(
            self.command, cwd, self._notified, self._requested, self._gone, self.env
        )
        await self.conn.start()
        try:
            hello = await self.conn.request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {"name": "Jarvis", "version": "1"},
                },
                START_TIMEOUT,
            )
            hello = hello if isinstance(hello, dict) else {}
            if hello.get("protocolVersion") not in (None, PROTOCOL_VERSION):
                raise AcpError(
                    f"It speaks ACP version {hello.get('protocolVersion')}, not {PROTOCOL_VERSION}."
                )
            self.caps = (
                hello.get("agentCapabilities")
                if isinstance(hello.get("agentCapabilities"), dict)
                else {}
            )
            resume = str(getattr(self.options, "resume", "") or "")
            if resume and self.caps.get("loadSession"):
                self.loading = True  # (its history comes back as updates: already shown)
                try:
                    await self.conn.request(
                        "session/load",
                        {"sessionId": resume, "cwd": cwd, "mcpServers": []},
                        START_TIMEOUT,
                    )
                finally:
                    self.loading = False
                self.session_id = resume
            else:
                made = await self.conn.request(
                    "session/new", {"cwd": cwd, "mcpServers": []}, START_TIMEOUT
                )
                self.session_id = (
                    str((made or {}).get("sessionId") or "") if isinstance(made, dict) else ""
                )
                if not self.session_id:
                    raise AcpError("It didn't start a session.")
        except AcpError as exc:
            await self.conn.close()
            if exc.code == -32000 or "auth" in str(exc).lower():
                raise AcpError(
                    f"{self.name} needs you to sign in: run it once in Terminal, then try again."
                ) from exc
            raise

    # ── what TaskManager calls ──

    async def query(self, prompt: Any, session_id: str = "default") -> None:
        """A turn: the agent's session/prompt. One at a time (a message sent into a running
        step waits for its end: TaskManager queues it again when this says no)."""
        if self.prompting is not None and not self.prompting.done():
            raise AcpError(f"{self.name} takes one message at a time.")
        text = prompt if isinstance(prompt, str) else await _words_of(prompt)
        self.turns += 1
        self.said = ""
        self.queue.put_nowait(UserMessage(content=text, uuid=f"acp-{self.session_id}-{self.turns}"))
        self.prompting = asyncio.ensure_future(self._prompt(text))

    async def _prompt(self, text: str) -> None:
        started = time.monotonic()
        reason, error = "end_turn", ""
        try:
            assert self.conn is not None
            done = await self.conn.request(
                "session/prompt",
                {"sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]},
            )
            reason = (
                str((done or {}).get("stopReason") or "end_turn")
                if isinstance(done, dict)
                else "end_turn"
            )
        except AcpError as exc:
            reason, error = "error", str(exc)
        self._flush()
        subtype, is_error = STOPS.get(reason, ("error_during_execution", True))
        self.queue.put_nowait(
            ResultMessage(
                subtype=subtype,
                duration_ms=round((time.monotonic() - started) * 1000),
                duration_api_ms=0,
                is_error=is_error,
                num_turns=1,
                session_id=self.session_id,
                result=self.said,
                errors=[error] if error else None,
                stop_reason=reason,
                terminal_reason="aborted_by_user" if reason == "cancelled" else None,
            )
        )

    async def receive_messages(self):
        while True:
            message = await self.queue.get()
            if message is None:
                return
            yield message

    async def receive_response(self):
        async for message in self.receive_messages():
            yield message
            if isinstance(message, ResultMessage):
                return

    async def interrupt(self) -> None:
        for asking in list(self.asking):
            asking.cancel()  # (its card goes; the agent hears "cancelled")
        if self.conn is not None and self.prompting is not None and not self.prompting.done():
            with contextlib.suppress(AcpError):
                await self.conn.notify("session/cancel", {"sessionId": self.session_id})

    async def set_permission_mode(self, _mode: str) -> None:
        return None  # (JARVIS's own policy answers the agent's requests, in whatever mode)

    async def set_model(self, _model: str | None = None) -> None:
        raise AcpError(f"{self.name} picks its own model.")

    async def get_mcp_status(self) -> dict[str, Any]:
        return {"mcpServers": []}

    async def get_context_usage(self) -> dict[str, Any]:
        raise AcpError(f"{self.name} doesn't say what fills its context.")

    async def rewind_files(self, _user_message_id: str) -> None:
        raise AcpError(f"{self.name} can't put files back.")

    async def stop_task(self, _task_id: str) -> None:
        raise AcpError(f"{self.name} has no tasks to stop.")

    async def reconnect_mcp_server(self, _name: str) -> None:
        raise AcpError(f"{self.name} has no MCP servers here.")

    async def disconnect(self) -> None:
        for asking in list(self.asking):
            asking.cancel()
        if self.prompting is not None and not self.prompting.done():
            self.prompting.cancel()
            with contextlib.suppress(BaseException):
                await self.prompting
        if self.conn is not None:
            await self.conn.close()
        self.queue.put_nowait(None)

    # ── what the agent says ──

    def _gone(self) -> None:
        """The agent ended: the reader stops once what it said so far is taken in (a turn
        it was on ends first, with its error)."""
        with contextlib.suppress(RuntimeError):
            asyncio.get_running_loop().call_soon(self.queue.put_nowait, None)

    def _put(self, *messages: Any) -> None:
        for message in messages:
            self.queue.put_nowait(message)

    def _stream(self, part: str, text: str) -> None:
        delta = (
            {"type": "text_delta", "text": text}
            if part == "text"
            else {"type": "thinking_delta", "thinking": text}
        )
        self._put(
            StreamEvent(
                uuid=f"acp-s-{self.turns}",
                session_id=self.session_id,
                event={"type": "content_block_delta", "index": 0, "delta": delta},
            )
        )

    def _flush(self) -> None:
        """The thinking and words so far, as the messages that carry them."""
        if self.thought:
            thinking, self.thought = "".join(self.thought), []
            if thinking.strip():
                self._put(
                    AssistantMessage(
                        content=[ThinkingBlock(thinking=thinking, signature="")], model=self.name
                    )
                )
        if self.words:
            words, self.words = "".join(self.words), []
            if words.strip():
                self.said = words.strip()
                self._put(AssistantMessage(content=[TextBlock(text=words)], model=self.name))

    def _notified(self, method: str, params: dict[str, Any]) -> None:
        if method != "session/update" or self.loading or params.get("sessionId") != self.session_id:
            return
        update = params.get("update") if isinstance(params.get("update"), dict) else {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            if text := _text(update.get("content")):
                if self.thought:
                    self._flush()
                self.words.append(text)
                self._stream("text", text)
        elif kind == "agent_thought_chunk":
            if text := _text(update.get("content")):
                if self.words:
                    self._flush()
                self.thought.append(text)
                self._stream("thinking", text)
        elif kind in ("tool_call", "tool_call_update"):
            self._flush()
            self._tool(update)
        elif kind == "plan":
            self._flush()
            entries = update.get("entries") if isinstance(update.get("entries"), list) else []
            todos = [
                {"content": str(e.get("content") or "")[:300], "status": str(e.get("status") or "pending"),
                 "activeForm": str(e.get("content") or "")[:300]}
                for e in entries[:30] if isinstance(e, dict)
            ]  # fmt: skip
            self._put(
                AssistantMessage(
                    content=[
                        ToolUseBlock(
                            id=f"acp-plan-{self.turns}-{len(entries)}",
                            name="TodoWrite",
                            input={"todos": todos},
                        )
                    ],
                    model=self.name,
                )
            )

    def _tool(self, update: dict[str, Any]) -> dict[str, Any] | None:
        """A tool call, or an update to one: its step shown once, its result once it ends."""
        call_id = str(update.get("toolCallId") or "")[:200]
        if not call_id:
            return None
        known = self.tools.get(call_id)
        if known is None:
            name, tool_input = tool_of(update)
            known = self.tools[call_id] = {"name": name, "input": tool_input, "done": False}
            while len(self.tools) > TOOLS_KEPT:
                self.tools.popitem(last=False)
            self._put(
                AssistantMessage(
                    content=[ToolUseBlock(id=call_id, name=name, input=tool_input)], model=self.name
                )
            )
        status = update.get("status")
        if status in ("completed", "failed") and not known["done"]:
            known["done"] = True
            self._put(
                UserMessage(
                    content=[
                        ToolResultBlock(
                            tool_use_id=call_id,
                            content=_output(update),
                            is_error=status == "failed",
                        )
                    ]
                )
            )
        return known

    async def _requested(self, method: str, params: dict[str, Any]) -> Any:
        if method != "session/request_permission":
            raise AcpError(f"{method} isn't offered here.", -32601)
        asking = asyncio.ensure_future(self._permission(params))
        self.asking.add(asking)
        try:
            return await asking
        except asyncio.CancelledError:
            return {"outcome": {"outcome": "cancelled"}}
        finally:
            self.asking.discard(asking)

    async def _permission(self, params: dict[str, Any]) -> dict[str, Any]:
        """The agent asks before a step: JARVIS's policy decides (its mode, the owner's
        rules, a card), and the agent hears its own option for that answer."""
        call = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        known = self._tool({**call, "status": None}) if call.get("toolCallId") else None
        name, tool_input = (known["name"], known["input"]) if known else tool_of(call)
        choices = [
            o for o in params.get("options") or [] if isinstance(o, dict) and o.get("optionId")
        ]
        policy = getattr(self.options, "can_use_tool", None)
        allowed = False
        if policy is not None:
            decision = await policy(name, tool_input, ToolPermissionContext())
            allowed = isinstance(decision, PermissionResultAllow)
        order = ("allow_once", "allow_always") if allowed else ("reject_once", "reject_always")
        chosen = next((o for kind in order for o in choices if o.get("kind") == kind), None)
        if chosen is None:
            return {"outcome": {"outcome": "cancelled"}}
        return {"outcome": {"outcome": "selected", "optionId": str(chosen["optionId"])}}


async def _words_of(prompt: Any) -> str:
    """A message with pictures (the SDK's stream of message dicts) as its words: the agent
    is sent the text (pictures aren't passed on)."""
    words: list[str] = []
    async for item in prompt:
        content = (item.get("message") or {}).get("content") if isinstance(item, dict) else None
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") == "text":
                words.append(str(block.get("text") or ""))
    return "\n".join(w for w in words if w)
