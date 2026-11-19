"""Eden Code from code: a local API, and the eden-code command that speaks it, so scripts,
CI on this Mac and other agents can drive Eden Code as the window does.

Off until the owner turns it on (Eden Code settings › Control from code), on a card with the
whole scope, marked for Touch ID (code_touchid: tap-only, the Mac's window alone answers it).
Then it listens on 127.0.0.1 only, on a port that stays put across launches (code_api_port,
8767 unless the owner picks another), through hook_listener's guarded server: a deadline for
each whole request, a cap on open connections and on a request's headers. The address and
port are written to code_api.json beside the settings (never the token), for the command to
find.

Who may call it: whoever has the owner's API token, a random one made when it's first turned
on and kept in the Keychain (the connectors vault: "Jarvis connectors", code-api:token), sent
as Authorization: Bearer <token>. Settings shows it (only when asked: Show) and makes a new
one (Regenerate: the old one stops working at once). A request is refused, before its token
is looked at, when its Host isn't this Mac's own address (a web page that points its own
name at 127.0.0.1) or it has an Origin (any web page); a POST must be JSON (a form can't
send it). Wrong tokens are counted: WRONG_MAX in WRONG_WINDOW seconds lock wrong tokens out
for LOCKED_FOR (the right token still gets in), and every caller together gets PER_MINUTE
requests a minute.

What it can do, each as the window's own command through hub.handle, so every gate and cap
a window's command meets applies (the spending caps of code_usage, the projects folder,
the number of open sessions, Exterminator Mode's and the copies' cards, the isolation and
lock-down features):

- GET /v1/status, GET /v1/sessions, GET /v1/sessions/<id> (status and settings),
  GET /v1/sessions/<id>/transcript?tail=N (the last N entries, at most TAIL_MAX);
- POST /v1/sessions {project, prompt, model?, mode?, title?, isolated?, cloud?,
  untrusted?}: a new session (task_new). mode is Ask, Plan or Accept edits at most: Auto and
  Bypass permissions are the window's alone (Bypass needs the owner's fingerprint, which no
  script has), and without a mode it's the project's default only when that is one of those
  three, else Ask. untrusted: true starts it locked down as an issue's session is (its
  prompt is someone else's words).
- POST /v1/sessions/<id>/messages {text} (task_send; a slash command is the window's own and
  refused here: /bypass, /clear and the like are typed by the owner), POST …/stop (the step
  under way: task_interrupt), POST …/end (task_cancel);
- POST /v1/sessions/<id>/land and …/discard: the isolated copy's own card in the window
  (code_copy), with its secret scan and its Touch ID; the API never answers a card itself;
- the Changes pane, for an editor (editors/vscode: the VS Code extension, which Cursor,
  Windsurf and VSCodium load too): GET /v1/sessions/<id>/changes?view=turn|session|branch
  &path= (code_hunks' own payload, the same hunk ids and numbers), GET …/lines?path&start&end
  (the unchanged lines between hunks), GET …/receipts?tail=N (the turns' receipts), POST
  …/hunks {hunk, action: keep | unkeep | undo, view?} (the pane's Keep and Undo, the window's
  pane kept in step) and POST …/comments {comments: [{path, line, side?, excerpt?, text}]}
  (line comments sent to the session as one message, worded as the pane sends them);
- POST /v1/exterminate {project, spend_cap?, focus?}: Exterminator Mode's own card;
- POST /v1/todos {project, prompt, title?, model?, mode?}: a to-do card (todo_add);
- GET /v1/attention: the Needs attention inbox (code_attention.py);
- GET /v1/events: JSON lines as things happen (sessions, their transcripts, approvals up
  and down, the inbox, a hunk kept or undone), one {"type": "ping"} every PING seconds while it's quiet. Only
  Eden Code's own events: nothing of the owner's mail, calendar, messages or chat goes out.
- schedules, watches and webhooks: features/code_automate.py (POST /v1/schedules,
  /v1/watches, /v1/webhooks…), behind a second switch of their own.

The eden-code command (jarvis/eden_code_cli.py; `uv run eden-code …` in the repo, and
Settings' "Install the eden-code command" writes ~/.local/bin/eden-code, which runs this
backend's own Python) reads the token from the Keychain or EDEN_CODE_TOKEN.
Docs: docs/eden-code-api.md.

Window commands: code_api_state {}, code_api_turn {on}, code_api_token {action: show |
regenerate}, code_api_port {port}, code_api_install_cli {}.
Events: code_api {on, port, listening, error, has_token, cli}, code_api_token {token}.
Settings (prefs.features): code_api (on or off: changed only through its card, never by
feature_prefs), code_api_port.

Cost policy: the API calls no model. A session it starts is an ordinary Eden Code session on
its model, under the owner's spending caps (features/code_usage.py), exactly as one the
window starts.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import os
import secrets
import shlex
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any

from .. import code_changes, jsonstore, lang, launches, osplat, prefs
from ..hook_listener import HookListener
from ..proactive import Alert

log = logging.getLogger("jarvis")

PREF = "code_api"
PREF_PORT = "code_api_port"
PORT = 8767
VAULT = "code-api"  # the connectors vault's id (Keychain: "Jarvis connectors", code-api:token)
TOKEN_KEY = "token"
DISCOVERY = "code_api.json"
SAFE_MODES = ("ask", "plan", "edits")  # Accept edits at most: never Auto or Bypass
MAX_BYTES = 256 * 1024
PER_MINUTE = 240
WRONG_MAX, WRONG_WINDOW, LOCKED_FOR = 20, 600.0, 600.0
TAIL_DEFAULT, TAIL_MAX = 20, 200
START_WAIT = 30.0  # seconds a POST /v1/sessions waits for its session to appear
PING = 15.0
STREAM_QUEUE = 1000  # events a slow reader may fall behind by before it's cut off
STREAM_MAX = 8  # event streams open at once
CLI_MARK = "# eden-code: written by Eden Code"
REVIEW_VIEWS = ("turn", "session", "branch")  # the Changes pane's views (code_hunks.VIEWS)
COMMENTS_MAX = 100  # line comments sent at once

# The events a stream carries: Eden Code's own, nothing else of the owner's.
STREAMED = ("tasks", "task_log", "task_finished", "approval", "approval_resolved",
            "code_attention", "code_bugfix", "code_runs", "todo_state",
            "code_kept", "code_hunk_undone")  # fmt: skip


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _port(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 1024 <= value <= 65535:
        return value
    return None


prefs.register_feature_pref(PREF, False, _bool)
prefs.register_feature_pref(PREF_PORT, PORT, _port)

ZH = {
    "Let programs on this Mac control Eden Code?": "要让这台 Mac 上的程序控制 Eden Code 吗？",
    "Scripts, CI and other agents on this Mac that have your API token can list and read your sessions, start them (in Ask, Plan or Accept edits, never Auto or Bypass permissions), send them messages, stop them, add to-do cards and ask for Exterminator Mode. Landing, discarding and Exterminator Mode still ask you here, on their own cards. It listens on 127.0.0.1:{port} only; nothing on the network can reach it.": "这台 Mac 上持有你的 API 令牌的脚本、CI 和其他智能体可以列出和读取你的会话、启动会话（询问、计划或自动接受编辑模式，绝不会是自动或绕过权限）、给会话发消息、停止会话、添加待办卡片，以及请求灭虫模式。合并、丢弃和灭虫模式仍会在这里用各自的卡片问你。它只在 127.0.0.1:{port} 上监听；网络上的任何东西都连不到它。",
    "Turn it on": "开启",
    "Not now": "暂不",
    "Not turned on.": "没有开启。",
    "Programs on this Mac can control Eden Code now.": "这台 Mac 上的程序现在可以控制 Eden Code 了。",
    "Programs can't control Eden Code now.": "程序现在不能控制 Eden Code 了。",
    "Made a new API token; the old one doesn't work any more.": "已生成新的 API 令牌；旧的不能再用了。",
    "Port {port} on this Mac is taken by another app, so the eden-code command can't reach Eden Code. Quit that app, or choose another port here.": "这台 Mac 的 {port} 端口被另一个应用占用了，所以 eden-code 命令连不上 Eden Code。请退出那个应用，或在这里换一个端口。",
    "Installed the eden-code command in {path}.": "已把 eden-code 命令安装到 {path}。",
    "{path} is there already and isn't Eden Code's, so it was left alone.": "{path} 已经存在，而且不是 Eden Code 的，所以没有动它。",
    "Couldn't install the eden-code command: {why}": "没能安装 eden-code 命令：{why}",
    "A program on this Mac started a session in {project}.": "这台 Mac 上的一个程序在 {project} 里开了一个会话。",
}
lang.add_texts(ZH)


class Refused(Exception):
    """A request that can't be done: (status, the reason, in words for the caller)."""

    def __init__(self, status: int, why: str) -> None:
        super().__init__(why)
        self.status, self.why = status, why


def _json_response(body: Any, status: int = 200) -> Any:
    from starlette.responses import JSONResponse

    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def session_view(item: dict[str, Any]) -> dict[str, Any]:
    """A session as the API shows it: what a script needs, none of the window's drawing."""
    keys = ("id", "title", "prompt", "folder", "path", "status", "busy", "mode", "model",
            "model_label", "effort", "last_action", "result", "cost_usd", "started",
            "session_id", "queued", "workspace")  # fmt: skip
    out = {k: item.get(k) for k in keys if k in item}
    out["files_changed"] = list(item.get("files_changed") or [])[:50]
    return out


def entry_view(entry: dict[str, Any]) -> dict[str, Any]:
    keep = ("n", "role", "text", "at", "tool", "status", "detail")
    return {k: entry[k] for k in keep if k in entry}


def comment_message(comments: Any) -> str:
    """Line comments as one message to the session, word for word as the window's Changes
    pane sends them (web/features/code_changes.js, commentMessage): "Review comments:", then
    file:line, the line itself, and the comment. A removed line (side "o") is named so."""
    if not isinstance(comments, list) or not comments:
        raise Refused(400, 'send the comments: {"comments": [{"path", "line", "text"}]}')
    rows = []
    for c in comments[:COMMENTS_MAX]:
        if not isinstance(c, dict):
            continue
        path = str(c.get("path") or "").strip()[:500]
        text = " ".join(str(c.get("text") or "").split())[:2000]
        line = c.get("line")
        if not path or not text or not isinstance(line, int) or isinstance(line, bool):
            continue
        where = f"{path} (removed line {line})" if c.get("side") == "o" else f"{path}:{line}"
        excerpt = str(c.get("excerpt") or "")[:300].replace("`", "'")
        quote = f" (`{excerpt}`)" if excerpt else ""
        rows.append(f"- {where}{quote} — {text}")
    if not rows:
        raise Refused(400, "each comment needs a path, a line number and its words")
    return "Review comments:\n" + "\n".join(rows)


HIDDEN = "A card is waiting for you in the Eden Code window."


def redact(item: dict[str, Any]) -> dict[str, Any]:
    """An inbox item as a program sees it: a card that isn't an Eden Code session's (the
    owner's chat may have put it up: an email to send, a purchase) is said to be there,
    never what it asks or its answers."""
    if item.get("kind") != "approval" or item.get("task"):
        return item
    return {**item, "title": "Eden Code", "text": HIDDEN, "said": HIDDEN, "choices": []}


def cli_shim(python: str, windows: bool | None = None) -> str:
    """~/.local/bin/eden-code: this backend's own Python, running the command's module. On
    Windows (item 49) eden-code.cmd beside Claude Code's own claude.exe (cmd and PowerShell
    both run a .cmd by its name; the mark is a REM line), with CRLF line ends."""
    if osplat.IS_WIN if windows is None else windows:
        lines = ["@echo off", f"REM {CLI_MARK}", f'"{python}" -m jarvis.eden_code_cli %*', ""]
        return "\r\n".join(lines)
    return f'#!/bin/sh\n{CLI_MARK}\nexec {shlex.quote(python)} -m jarvis.eden_code_cli "$@"\n'


class Api:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.mono = time.monotonic
        self.listener = HookListener((), self._no_hooks, app=self.build_app())
        self._syncing = asyncio.Lock()
        self._wrong: deque[float] = deque()
        self._locked_until = 0.0
        self._calls: deque[float] = deque()
        self.streams: set[asyncio.Queue] = set()
        self.routes: list[
            Any
        ] = []  # (method, path) -> handler, from other features (code_automate)
        self.cli_dir = Path.home() / ".local" / "bin"

    async def _no_hooks(self, _name: str, _request: Any) -> Any:
        return 404, {"error": "not found"}

    # ── plumbing ──

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=text)

    @property
    def on(self) -> bool:
        return self.hub.prefs.feature(PREF) is True

    def port(self) -> int:
        return _port(self.hub.prefs.feature(PREF_PORT)) or PORT

    @property
    def vault(self) -> Any:
        return self.hub.connectors.vault

    def token(self) -> str:
        try:
            return (self.vault.get(VAULT, TOKEN_KEY) or "").strip()
        except Exception:  # a locked Keychain: no token, so nothing gets in
            return ""

    def new_token(self) -> str:
        token = "edc_" + secrets.token_urlsafe(32)
        self.vault.set(VAULT, TOKEN_KEY, token)
        return token

    def discovery_path(self) -> Path:
        return self.hub.feature_path(DISCOVERY)

    def write_discovery(self) -> None:
        """The address the command finds the API at (never the token)."""
        path = self.discovery_path()
        with contextlib.suppress(OSError):
            if self.listener.running:
                jsonstore.save_json(path, {"url": f"http://127.0.0.1:{self.listener.port}",
                                           "pid": os.getpid()})  # fmt: skip
            elif path.exists():
                path.unlink()

    def cli_path(self) -> Path:
        return self.cli_dir / ("eden-code.cmd" if osplat.IS_WIN else "eden-code")

    def cli_state(self) -> dict[str, Any]:
        path = self.cli_path()
        try:
            ours = path.exists() and CLI_MARK in path.read_text(errors="replace")[:400]
        except OSError:
            ours = False
        return {"installed": ours, "path": str(path)}

    def publish(self) -> None:
        lis = self.listener
        self.hub.emit(
            "code_api",
            on=self.on,
            port=lis.port or self.port(),
            listening=lis.running,
            error=lis.error,
            has_token=bool(self.token()),
            cli=self.cli_state(),
        )

    # ── on and off ──

    async def sync(self, _event: Any = None) -> None:
        """Listening while the switch is on, on the port the settings name; never otherwise."""
        async with self._syncing:
            lis = self.listener
            before = (lis.running, lis.port, lis.error)
            if self.on:
                if not await lis.start(self.port()) and "taken" in lis.error:
                    lis.error = self.tr(
                        "Port {port} on this Mac is taken by another app, so the eden-code "
                        "command can't reach Eden Code. Quit that app, or choose another port here.",
                        port=self.port(),
                    )
            else:
                await lis.stop()
                lis.error = ""
            if (lis.running, lis.port, lis.error) != before:
                await asyncio.to_thread(self.write_discovery)
                self.publish()

    def on_prefs(self, _event: Any = None) -> Any:
        lis = self.listener
        want = (True, self.port()) if self.on else (False, 0)
        if (lis.running, lis.port) == want:
            return None
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return None
        return self.sync()

    async def turn(self, on: bool) -> str:
        if not on:
            self.hub.set_feature_prefs({PREF: False})
            await self.sync()
            self.publish()
            return self.tr("Programs can't control Eden Code now.")
        if self.on:
            await self.sync()
            self.publish()
            return ""
        question = self.tr("Let programs on this Mac control Eden Code?")
        detail = self.tr(
            "Scripts, CI and other agents on this Mac that have your API token can list and read "
            "your sessions, start them (in Ask, Plan or Accept edits, never Auto or Bypass "
            "permissions), send them messages, stop them, add to-do cards and ask for "
            "Exterminator Mode. Landing, discarding and Exterminator Mode still ask you here, on "
            "their own cards. It listens on 127.0.0.1:{port} only; nothing on the network can "
            "reach it.",
            port=self.port(),
        )
        choice = await self.hub.request_approval(
            question,
            detail,
            [("allow", self.tr("Turn it on")), ("deny", self.tr("Not now"))],
            context={"touchid": True, "tap_only": True, "tool": "code_api_on"},
        )
        if choice != "allow":
            return self.tr("Not turned on.")
        if not self.token():
            await asyncio.to_thread(self.new_token)
        self.hub.set_feature_prefs({PREF: True})
        await self.sync()
        self.publish()
        return self.tr("Programs on this Mac can control Eden Code now.")

    # ── the doors ──

    def _check(self, request: Any) -> None:
        """Raise Refused unless this request may go on: this Mac's own address, no web page,
        the owner's token, within the minute's calls."""
        headers = request.headers
        host = headers.get("host", "")
        port = self.listener.port
        if host not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
            raise Refused(403, "only this Mac's own address (http://127.0.0.1:<port>)")
        if headers.get("origin") or headers.get("sec-fetch-site"):
            raise Refused(403, "the API doesn't take requests from web pages")
        stamp = self.mono()
        calls = self._calls
        while calls and stamp - calls[0] >= 60:
            calls.popleft()
        if len(calls) >= PER_MINUTE:
            raise Refused(429, "too many calls this minute")
        calls.append(stamp)
        auth = headers.get("authorization", "")
        offered = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
        expected = self.token()
        good = bool(expected) and hmac.compare_digest(
            offered.encode(errors="replace"), expected.encode()
        )
        if not good:
            if stamp < self._locked_until:
                raise Refused(429, "too many wrong tokens; try again later")
            wrong = self._wrong
            wrong.append(stamp)
            while wrong and stamp - wrong[0] >= WRONG_WINDOW:
                wrong.popleft()
            if len(wrong) >= WRONG_MAX:
                self._locked_until = stamp + LOCKED_FOR
                wrong.clear()
                log.warning("code api: too many wrong tokens; refusing them for a while")
            raise Refused(
                401, "unauthorized: send Authorization: Bearer <your Eden Code API token>"
            )

    async def _body(self, request: Any) -> dict[str, Any]:
        if "application/json" not in request.headers.get("content-type", ""):
            raise Refused(415, "send JSON (Content-Type: application/json)")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BYTES:
            raise Refused(413, f"at most {MAX_BYTES // 1024} KB")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BYTES:
                raise Refused(413, f"at most {MAX_BYTES // 1024} KB")
        try:
            data = json.loads(bytes(body) or b"{}")
        except (ValueError, RecursionError):
            raise Refused(400, "not JSON") from None
        if not isinstance(data, dict):
            raise Refused(400, "send a JSON object")
        return data

    def build_app(self) -> Any:
        from starlette.applications import Starlette
        from starlette.routing import Route

        async def entry(request: Any) -> Any:
            try:
                self._check(request)
                if not self.on:
                    raise Refused(404, "not found")
                return await self.dispatch(request)
            except Refused as exc:
                return _json_response({"error": exc.why}, exc.status)
            except Exception:
                log.exception("code api: a request failed")
                return _json_response({"error": "failed"}, 500)

        every = ["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]
        return Starlette(routes=[Route("/{path:path}", entry, methods=every)])

    async def dispatch(self, request: Any) -> Any:
        method = request.method
        parts = [p for p in request.url.path.split("/") if p]
        if not parts or parts[0] != "v1":
            raise Refused(404, "not found")
        parts = parts[1:]
        for route_method, prefix, handler in self.routes:
            if method == route_method and parts[: len(prefix)] == list(prefix):
                return await handler(self, request, parts[len(prefix) :])
        if method == "GET" and parts == ["status"]:
            return _json_response(self.status())
        if method == "GET" and parts == ["attention"]:
            return _json_response(self.attention())
        if method == "GET" and parts == ["events"]:
            return self.events()
        if parts[:1] == ["sessions"]:
            return await self.sessions(request, method, parts[1:])
        if method == "POST" and parts == ["exterminate"]:
            return _json_response(await self.exterminate(await self._body(request)), 202)
        if method == "POST" and parts == ["todos"]:
            return _json_response(await self.add_todo(await self._body(request)), 202)
        raise Refused(404, "not found")

    # ── what it answers ──

    def status(self) -> dict[str, Any]:
        tasks = [t for t in self.hub.tasks.tasks.values() if t.kind == "code"]
        attention = getattr(self.hub, "code_attention", None)
        return {
            "ok": True,
            "app": "Eden Code",
            "sessions": len(tasks),
            "working": sum(1 for t in tasks if t.busy),
            "attention": len(attention.collect()) if attention is not None else 0,
        }

    def attention(self) -> dict[str, Any]:
        attention = getattr(self.hub, "code_attention", None)
        if attention is None:
            return {"items": [], "count": 0, "summary": ""}
        items = [redact(i) for i in attention.collect()]
        return {"items": items, "count": len(items), "summary": attention.summary(items)}

    def task(self, raw: str) -> Any:
        try:
            task_id = int(raw)
        except ValueError:
            raise Refused(404, "no such session") from None
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or task.kind != "code":
            raise Refused(404, "no such session")
        return task

    def view(self, task: Any) -> dict[str, Any]:
        found = next((i for i in self.hub.tasks.public() if i.get("id") == task.id), None)
        return session_view(found or task.public())

    async def sessions(self, request: Any, method: str, rest: list[str]) -> Any:
        if not rest:
            if method == "GET":
                items = [
                    session_view(i) for i in self.hub.tasks.public() if i.get("kind") == "code"
                ]
                return _json_response({"sessions": items})
            if method == "POST":
                return await self.start(await self._body(request))
            raise Refused(405, "use GET or POST")
        task = self.task(rest[0])
        action = rest[1] if len(rest) > 1 else ""
        if method == "GET" and not action:
            return _json_response(self.view(task))
        if method == "GET" and action == "transcript":
            try:
                tail = int(request.query_params.get("tail", TAIL_DEFAULT))
            except ValueError:
                raise Refused(400, "tail is a number") from None
            tail = max(1, min(TAIL_MAX, tail))
            entries = [entry_view(e) for e in task.transcript[-tail:]]
            return _json_response({"id": task.id, "entries": entries})
        if method == "GET" and action in ("changes", "lines", "receipts"):
            return _json_response(await getattr(self, action)(task, request.query_params))
        if method != "POST":
            raise Refused(405, "use POST")
        if action == "hunks":
            return _json_response(await self.hunk(task, await self._body(request)))
        if action == "comments":
            body = await self._body(request)
            text = comment_message(body.get("comments"))
            await self.hub.handle(
                {"type": "task_send", "id": task.id, "text": text[:20000], "from": "api"}
            )
            return _json_response({"id": task.id, "sent": True, "text": text}, 202)
        if action == "messages":
            body = await self._body(request)
            text = str(body.get("text") or "").strip()
            if not text:
                raise Refused(400, 'say what to send: {"text": "…"}')
            if text.startswith("/"):
                raise Refused(400, "slash commands are typed in the window; send words")
            await self.hub.handle(
                {"type": "task_send", "id": task.id, "text": text[:20000], "from": "api"}
            )
            return _json_response({"id": task.id, "sent": True}, 202)
        if action == "stop":
            await self.hub.handle({"type": "task_interrupt", "id": task.id})
            return _json_response({"id": task.id, "stopped": True}, 202)
        if action == "end":
            await self.hub.handle({"type": "task_cancel", "id": task.id})
            return _json_response({"id": task.id, "ending": True}, 202)
        if action in ("land", "discard"):
            slug = str((task.workspace or {}).get("slug") or "")
            if not slug:
                raise Refused(409, "that session isn't in an isolated copy")
            await self.hub.handle({"type": "code_copy", "slug": slug, "action": action})
            return _json_response(
                {"id": task.id, "asked": "on its card in the Eden Code window"}, 202
            )
        raise Refused(404, "not found")

    # ── the Changes pane, for an editor (editors/vscode) ──

    def _hunks(self) -> Any:
        hunks = getattr(self.hub, "code_hunks", None)
        if hunks is None:
            raise Refused(409, "the Changes pane isn't available here")
        return hunks

    async def changes(self, task: Any, query: Any) -> dict[str, Any]:
        """What the window's Changes pane shows (code_hunks.payload): the same views, the
        same hunk ids and numbers, the hunks kept marked."""
        hunks = self._hunks()
        which = query.get("view") if query.get("view") in REVIEW_VIEWS else "session"
        path = str(query.get("path") or "")[:1000]
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        return hunks.payload(task, which, view, path)

    async def lines(self, task: Any, query: Any) -> dict[str, Any]:
        """Unchanged lines between two hunks, as the pane unfolds them (code_hunks.read_lines:
        inside the session's folder, never credentials, at most LINES_AT_ONCE)."""
        from .code_hunks import LINES_AT_ONCE, read_lines

        path = str(query.get("path") or "")[:1000]
        try:
            start = max(1, int(query.get("start") or 1))
            end = min(int(query.get("end") or start), start + LINES_AT_ONCE - 1)
        except (TypeError, ValueError, OverflowError):
            raise Refused(400, "start and end are line numbers") from None
        found = await asyncio.to_thread(read_lines, task.cwd, path, start, end)
        if found is None:
            raise Refused(404, "that file can't be read here")
        return {"id": task.id, "path": path, "start": start, "lines": found}

    async def receipts(self, task: Any, query: Any) -> dict[str, Any]:
        """The turns' receipts (code_receipts.py) still in the transcript, newest last: the
        card's fields and its words, without the check's picture (the window has it)."""
        try:
            tail = max(1, min(TAIL_MAX, int(query.get("tail", TAIL_DEFAULT))))
        except ValueError:
            raise Refused(400, "tail is a number") from None
        found = [e for e in task.transcript if isinstance(e.get("receipt"), dict)][-tail:]
        out = []
        for e in found:
            receipt = dict(e["receipt"])
            if isinstance(receipt.get("check"), dict):
                receipt["check"] = {k: v for k, v in receipt["check"].items() if k != "thumb"}
            out.append({"n": e.get("n"), "at": e.get("at"), "text": e.get("text", ""),
                        "receipt": receipt})  # fmt: skip
        return {"id": task.id, "receipts": out}

    async def hunk(self, task: Any, body: dict[str, Any]) -> dict[str, Any]:
        """Keep, un-keep or undo one hunk by its id, as the pane's buttons do (code_hunks):
        a kept hunk is marked in the window too, an undo puts back just that hunk and the
        window's pane is drawn again. Answers with the view as it is now."""
        hunks = self._hunks()
        action = str(body.get("action") or "")
        hunk_id = str(body.get("hunk") or "")[:40]
        which = body.get("view") if body.get("view") in REVIEW_VIEWS else "session"
        if not hunk_id or action not in ("keep", "unkeep", "undo"):
            raise Refused(
                400, 'say which hunk and what: {"hunk": "…", "action": "keep" | "unkeep" | "undo"}'
            )
        said = ""
        if action == "undo":
            said = await hunks.undo(task, which, [hunk_id])
            await hunks.changes({"id": task.id, "view": which})  # (the window's pane, again)
            self.hub.emit("code_hunk_undone", id=task.id, undone=said.startswith("Undid"),
                          file=str(body.get("path") or "")[:1000])  # fmt: skip
        else:
            hunks.keep(task, [hunk_id], action == "keep")
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        return {"id": task.id, "action": action, "done": action != "undo" or said.startswith("Undid"),
                "said": self.tr(said) if said else "", "changes": hunks.payload(task, which, view)}  # fmt: skip

    def safe_mode(self, project: str, mode: Any) -> str:
        """The mode a session or card from the API starts in: Ask, Plan or Accept edits."""
        if mode not in (None, ""):
            if mode not in SAFE_MODES:
                raise Refused(
                    400,
                    "mode is ask, plan or edits: Auto and Bypass permissions are only the "
                    "window's to choose",
                )
            return str(mode)
        try:
            own = self.hub.tasks.defaults_for(project)
        except Exception:
            own = {}
        default = own.get("mode") or self.hub.prefs.code_mode or "ask"
        return default if default in SAFE_MODES else "ask"

    def project(self, body: dict[str, Any]) -> str:
        project = str(body.get("project") or "").strip()[:500]
        if not project:
            raise Refused(400, 'name the project: {"project": "…"}')
        try:
            self.hub.tasks.resolve_dir(project)
        except (ValueError, OSError) as exc:
            raise Refused(400, str(exc)[:300] or "that folder can't be opened") from None
        return project

    async def start(self, body: dict[str, Any]) -> Any:
        project = self.project(body)
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            raise Refused(400, 'say what the session should do: {"prompt": "…"}')
        if prompt.startswith("/"):
            raise Refused(400, "slash commands are typed in the window; send words")
        mode = self.safe_mode(project, body.get("mode"))
        token = launches.token()
        msg: dict[str, Any] = {
            "type": "task_new",
            "prompt": prompt[:20000],
            "directory": project,
            "mode": mode,
            "title": str(body.get("title") or "")[:200],
            launches.KEY: token,
            "from": "api",  # (Model Router picks for it unless a model is named)
        }
        if body.get("model"):
            msg["model"] = str(body["model"])[:200]
        if isinstance(body.get("isolated"), bool):
            msg["isolated"] = body["isolated"]
        if body.get("untrusted") is True:
            msg["untrusted"] = True
        if body.get("cloud") is True:
            msg["cloud"] = True
        await self.hub.handle(msg)
        task = await launches.started(self.hub.tasks, token, 0 if msg.get("cloud") else START_WAIT)
        why = launches.refusal(token)
        if why:
            raise Refused(400, why)
        if task is None:
            return _json_response(
                {"started": False, "launch_token": token,
                 "note": "asked; it hasn't started yet (a card in the window, or the cloud)"},
                202,
            )  # fmt: skip
        if task.mode not in SAFE_MODES:  # (nothing should have moved it: say so if it did)
            log.warning("code api: session %s started in %s", task.id, task.mode)
        self.hub.notify(Alert(f"code-api:{task.id}:{time.time():.0f}", "task", "Eden Code",
                              self.tr("A program on this Mac started a session in {project}.",
                                      project=task.cwd.name),
                              note="a program with the owner's API token started a session"),
                        speak=False)  # fmt: skip
        return _json_response({"started": True, "session": self.view(task)}, 201)

    async def exterminate(self, body: dict[str, Any]) -> dict[str, Any]:
        if getattr(self.hub, "code_bugfix", None) is None:
            raise Refused(409, "Exterminator Mode isn't available here")
        project = self.project(body)
        msg: dict[str, Any] = {"type": "code_bugfix_start", "project": project}
        if isinstance(body.get("spend_cap"), int | float) and not isinstance(
            body["spend_cap"], bool
        ):
            msg["spend_cap"] = body["spend_cap"]
        if isinstance(body.get("focus"), str):
            msg["focus"] = body["focus"][:2000]
        await self.hub.handle(msg)
        return {"asked": "on Exterminator Mode's card in the Eden Code window"}

    async def add_todo(self, body: dict[str, Any]) -> dict[str, Any]:
        todo = getattr(self.hub, "code_todo", None)
        if todo is None:
            raise Refused(409, "the to-do column isn't available here")
        project = self.project(body)
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            raise Refused(400, 'say what the card\'s session should do: {"prompt": "…"}')
        mode = body.get("mode")
        if mode not in (None, "") and mode not in SAFE_MODES:
            raise Refused(400, "mode is ask, plan or edits")
        folder = str(self.hub.tasks.resolve_dir(project))
        before = {c["id"] for c in todo.board.cards}
        await self.hub.handle({
            "type": "todo_add", "directory": project, "prompt": prompt[:20000],
            "title": str(body.get("title") or "")[:200], "model": str(body.get("model") or "")[:200],
            "mode": mode or "",
        })  # fmt: skip
        added = [c for c in todo.board.cards if c["id"] not in before and c["folder"] == folder]
        if not added:
            raise Refused(400, "the card wasn't added (the window says why)")
        return {"added": added[-1]["id"]}

    # ── events ──

    def on_event(self, event: dict[str, Any]) -> None:
        if not self.streams:
            return
        shown = self.shape(event)
        if shown is None:
            return
        for queue in list(self.streams):
            try:
                queue.put_nowait(shown)
            except asyncio.QueueFull:  # too far behind: its stream ends, the reader reconnects
                self.streams.discard(queue)
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(None)

    def shape(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """An event as a stream carries it, or None for one it doesn't."""
        kind = event.get("type")
        code = {t.id for t in self.hub.tasks.tasks.values() if t.kind == "code"}
        if kind == "tasks":
            items = [session_view(i) for i in event.get("items") or [] if i.get("kind") == "code"]
            return {"type": "sessions", "sessions": items}
        if kind == "task_log":
            if event.get("id") not in code or not isinstance(event.get("entry"), dict):
                return None
            return {"type": "entry", "id": event["id"], "entry": entry_view(event["entry"])}
        if kind == "task_finished":
            if event.get("task_kind") != "code":
                return None
            keep = ("id", "status", "folder", "result", "files", "cost_usd")
            return {"type": "finished", **{k: event[k] for k in keep if k in event}}
        if kind == "approval":
            task_id = event.get("task_id")
            # A card that isn't an Eden Code session's may be anything of the owner's (an
            # email to send): that one is said to be there, never what it asks.
            return {"type": "approval", "id": event.get("id"),
                    "task": task_id if task_id in code else 0,
                    "question": str(event.get("question") or "")[:500] if task_id in code else ""}  # fmt: skip
        if kind == "approval_resolved":
            return {"type": "approval_resolved", "id": event.get("id")}
        if kind == "code_attention":
            attention = getattr(self.hub, "code_attention", None)
            items = [redact(i) for i in event.get("items") or [] if isinstance(i, dict)]
            summary = attention.summary(items) if attention is not None else ""
            return {"type": "attention", "count": len(items), "summary": summary, "items": items}
        if kind in ("code_kept", "code_hunk_undone"):  # (a hunk kept or undone: GET its changes)
            return {"type": "changes", "id": event.get("id")} if event.get("id") in code else None
        if kind in ("code_bugfix", "code_runs", "todo_state"):
            return {"type": kind}  # (something changed there: GET what's needed)
        return None

    def events(self) -> Any:
        from starlette.responses import StreamingResponse

        if len(self.streams) >= STREAM_MAX:
            raise Refused(429, f"at most {STREAM_MAX} event streams at once")
        queue: asyncio.Queue = asyncio.Queue(STREAM_QUEUE)
        self.streams.add(queue)

        async def lines() -> Any:
            try:
                yield json.dumps({"type": "hello", **self.status()}) + "\n"
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), PING)
                    except TimeoutError:
                        item = {"type": "ping"}
                    if item is None or not self.on:
                        return
                    yield json.dumps(item, default=str) + "\n"
            finally:
                self.streams.discard(queue)

        return StreamingResponse(lines(), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-store"})  # fmt: skip

    # ── the eden-code command ──

    def install_cli(self) -> str:
        path = self.cli_path()
        try:
            if path.exists() and CLI_MARK not in path.read_text(errors="replace")[:400]:
                return self.tr("{path} is there already and isn't Eden Code's, so it was left alone.",
                               path=str(path))  # fmt: skip
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_text(cli_shim(sys.executable), newline="")  # (the .cmd's own CRLF)
            tmp.chmod(0o755)
            tmp.replace(path)
        except OSError as exc:
            return self.tr(
                "Couldn't install the eden-code command: {why}", why=exc.strerror or str(exc)
            )
        return self.tr("Installed the eden-code command in {path}.", path=str(path.parent))

    # ── window commands ──

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    async def cmd_turn(self, msg: dict[str, Any]) -> None:
        self.caption(await self.turn(msg.get("on") is True))

    async def cmd_token(self, msg: dict[str, Any]) -> None:
        action = msg.get("action")
        if action == "regenerate":
            await asyncio.to_thread(self.new_token)
            self.caption(self.tr("Made a new API token; the old one doesn't work any more."))
            self.publish()
        elif action == "show":
            token = await asyncio.to_thread(self.token)
            if not token and self.on:
                token = await asyncio.to_thread(self.new_token)
            self.hub.emit("code_api_token", token=token)

    async def cmd_port(self, msg: dict[str, Any]) -> None:
        port = _port(msg.get("port"))
        if port is None:
            return
        self.hub.set_feature_prefs({PREF_PORT: port})
        await self.sync()
        self.publish()

    async def cmd_install_cli(self, _msg: dict[str, Any]) -> None:
        self.caption(await asyncio.to_thread(self.install_cli))
        self.publish()

    def on_feature_prefs(self, msg: dict[str, Any]) -> bool:
        """The switch changes only through its card (code_api_turn): a feature_prefs naming
        it is left without it (code_settings_gate's rule, for this feature's own setting)."""
        changes = msg.get("changes")
        if isinstance(changes, dict) and PREF in changes:
            changes.pop(PREF)
            log.warning("code api: the switch from feature_prefs; refused")
        return False

    async def close(self) -> None:
        for queue in list(self.streams):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(None)
        await self.listener.stop()


def install(hub: Any) -> None:
    api = Api(hub)
    hub.code_api = api
    hub.register_command("code_api_state", api.cmd_state)
    hub.register_command("code_api_turn", api.cmd_turn, slow=True)
    hub.register_command("code_api_token", api.cmd_token, slow=True)
    hub.register_command("code_api_port", api.cmd_port, slow=True)
    hub.register_command("code_api_install_cli", api.cmd_install_cli, slow=True)
    hub.register_command("feature_prefs", api.on_feature_prefs)
    hub.register_loop("code_api_listener", api.sync)  # (on at start if it was)
    hub.add_event_sink(("prefs",), api.on_prefs)
    hub.add_event_sink(STREAMED, api.on_event)
    hub.add_quit_hook(api.listener.close_now)
