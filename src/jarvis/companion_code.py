"""Jarvis Code from the phone, the whole of it: what the Mac's window does with a session,
the phone can ask for too.

- GET /api/code/options: what a new session can be (projects, models, permission modes,
  efforts, and the owner's defaults).
- POST /api/code/new {prompt, directory, model?, mode?, effort?, isolated?, images?}: starts
  one, as the window's composer does (task_new); answers with its id.
- POST /api/code/action {id, action, ...}: one of ACTIONS, each the window's own command for
  it (git, pull requests, slash commands, "!" commands, settings, rename, archive, close,
  rewind, files, context, export), run through hub.handle exactly as a window's would be.
  Their answers come as hub events (a caption, the git panel's state, a command's output);
  the ones each action waits for are gathered and sent back.

Only the actions listed here: there is no way through to any other window command. The
phone asks for Face ID before the ones that run things on this Mac ("!" commands, Bypass
permissions); every action is in the companion's audit log.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

log = logging.getLogger("jarvis")

PICTURES_BODY = 6 * 8_000_000 * 4 // 3 + 64 * 1024  # up to six pictures or PDFs, as base64


@dataclass(frozen=True)
class Action:
    command: str  # the window's command
    fields: tuple[str, ...] = ()  # what the phone may pass on, as is
    wait: tuple[str, ...] = ()  # events that answer it
    seconds: float = 8.0
    by_ref: bool = False  # the answer is matched by a ref this asks with (task_bash)
    session: bool = True  # needs a session id


ACTIONS: dict[str, Action] = {
    # Settings of a session.
    "mode": Action("task_mode", ("mode",)),
    "model": Action("task_model", ("ref",), ("caption", "error"), 4),
    "effort": Action("task_effort", ("effort",)),
    "rename": Action("task_rename", ("title",)),
    "meta": Action("code_meta_set", ("pinned", "archived")),
    "close": Action("task_cancel"),
    "interrupt": Action("task_interrupt"),
    "steer": Action("task_steer", ("item",)),
    "unqueue": Action("task_unqueue", ("item",)),
    # Talking to it.
    "command": Action("code_command", ("text",), ("caption",), 15),
    "bash": Action("task_bash", ("command",), ("task_bash",), 130, by_ref=True),
    "rewind": Action("task_rewind", ("uuid",), ("caption",), 60),
    "undo": Action("task_undo", (), ("caption",), 30),
    "context": Action("task_context", (), ("task_context",), 15),
    "export": Action("task_export", (), ("caption",), 15),
    # Its changes.
    "revert": Action("task_revert", ("path",), ("caption",), 30),
    "git": Action("code_git", (), ("code_git",), 20),
    "stage": Action("code_git_stage", ("paths", "all", "unstage"), ("code_git",), 20),
    "commit_message": Action("code_git_message", (), ("code_git_message",), 90),
    "commit": Action("code_git_commit", ("message",), ("code_git_committed", "caption"), 90),
    "branch": Action("code_git_branch", ("name", "create"), ("caption", "code_git"), 30),
    "push": Action("code_git_push", (), ("caption",), 120),
    "pr": Action("code_pr", (), ("code_prs",), 30),
    "pr_draft": Action("code_pr_draft", ("base",), ("code_pr_draft", "caption"), 150),
    "pr_open": Action(
        "code_pr_open", ("title", "body", "base", "draft"), ("code_prs", "caption"), 150
    ),
    "pr_merge": Action("code_pr_merge", ("method",), ("code_prs", "caption"), 120),
    # Its project.
    "files": Action("project_files", ("directory",), ("project_files",), 20, session=False),
    "file": Action("file_read", ("directory", "path"), ("file_content",), 15, session=False),
    "commands": Action("slash_list", ("directory",), ("slash_list",), 15, session=False),
}
LISTENED = sorted({kind for a in ACTIONS.values() for kind in a.wait})


class CodeDesk:
    """Runs a window command for the phone and gathers the events that answer it."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waiting: list[tuple[set[str], Callable[[dict[str, Any]], bool], asyncio.Queue]] = []
        hub.add_event_sink(LISTENED, self._heard)

    def _heard(self, event: dict[str, Any]) -> None:
        for kinds, wanted, queue in list(self.waiting):
            if event.get("type") in kinds and wanted(event):
                queue.put_nowait(event)

    async def run(
        self,
        command: dict[str, Any],
        wait: tuple[str, ...] = (),
        seconds: float = 8.0,
        wanted: Callable[[dict[str, Any]], bool] | None = None,
    ) -> list[dict[str, Any]]:
        """hub.handle(command), then the answering events: the first of each kind, until
        every kind came, or a caption or error (which says it's done), or time ran out."""
        queue: asyncio.Queue = asyncio.Queue()
        entry = (set(wait), wanted or (lambda _e: True), queue)
        if wait:
            self.waiting.append(entry)
        try:
            await self.hub.handle(command)
            heard: list[dict[str, Any]] = []
            if not wait:
                return heard
            deadline = time.monotonic() + seconds
            kinds = set(wait)
            while kinds and (left := deadline - time.monotonic()) > 0:
                try:
                    event = await asyncio.wait_for(queue.get(), left)
                except TimeoutError:
                    break
                heard.append(event)
                kinds.discard(event.get("type"))
                if event.get("type") in ("caption", "error") and len(wait) > 1:
                    break  # said how it went
            return heard
        finally:
            if entry in self.waiting:
                self.waiting.remove(entry)


def options(hub: Any) -> dict[str, Any]:
    """What a new session can be. Projects come separately (they read git)."""
    from .prefs import MODEL_NAMES, MODELS
    from .tasks import EFFORTS, MODE_LABELS, MODES

    prefs = hub.prefs
    return {
        "models": [{"ref": key, "name": MODEL_NAMES.get(key, key)} for key in MODELS],
        "modes": [{"id": m, "name": MODE_LABELS.get(m, m)} for m in MODES],
        "efforts": list(EFFORTS),
        "defaults": {
            "model": getattr(prefs, "code_model", "") or "",
            "mode": getattr(prefs, "code_mode", "") or "ask",
            "effort": getattr(prefs, "code_effort", "") or "",
        },
    }


def _bad(reason: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": reason}, status_code=status)


def _pictures(data: dict[str, Any]) -> list[dict[str, Any]]:
    raw = data.get("images")
    if not isinstance(raw, list):
        return []
    return [
        {
            "media_type": str(i.get("media_type") or "")[:100],
            "data": str(i.get("data") or ""),
            "name": str(i.get("name") or "")[:200],
        }
        for i in raw[:6]
        if isinstance(i, dict) and i.get("data")
    ]


def _value(value: Any) -> Any:
    """A field as passed on: text and lists capped, numbers and switches as they are."""
    if isinstance(value, str):
        return value[:20000]
    if isinstance(value, list):
        return [str(v)[:1000] for v in value[:200]]
    if isinstance(value, bool | int | float) or value is None:
        return value
    raise TypeError("not a plain value")


def routes(api: Any) -> list[Route]:
    hub = api.hub
    desk = getattr(hub, "phone_code_desk", None) or CodeDesk(hub)
    hub.phone_code_desk = desk

    async def code_options(request: Request) -> Response:
        _device, refused = api._read(request)
        if refused is not None:
            return refused
        found = options(hub)
        try:
            found["projects"] = await hub._projects_overview()
        except Exception:
            log.warning("companion: couldn't list the projects", exc_info=True)
            found["projects"] = []
        return JSONResponse(found)

    async def code_new(request: Request) -> Response:
        device, data, refused = await api._post(request, "act", PICTURES_BODY, upload=True)
        if refused is not None:
            return refused
        prompt = str(data.get("prompt") or "").strip()[:20000]
        directory = str(data.get("directory") or "").strip()[:1000]
        if not prompt or not directory:
            return _bad("a project and what to do")
        known = set(hub.tasks.tasks)
        command: dict[str, Any] = {"type": "task_new", "prompt": prompt, "directory": directory}
        for key in ("model", "mode", "effort", "title"):
            if isinstance(data.get(key), str) and data[key]:
                command[key] = data[key][:200]
        if isinstance(data.get("isolated"), bool):
            command["isolated"] = data["isolated"]
        pictures = _pictures(data)
        if pictures:
            command["images"] = pictures
        said = await desk.run(command, ("error",), 3)
        new = sorted(set(hub.tasks.tasks) - known)
        if not new:
            problem = next((e.get("text") for e in said if e.get("type") == "error"), "")
            return _bad(str(problem or "the session didn't start"))
        api.companion.record(device, "code_started", f"#{new[-1]}")
        return JSONResponse({"ok": True, "id": new[-1]})

    async def code_action(request: Request) -> Response:
        device, data, refused = await api._post(request, "act")
        if refused is not None:
            return refused
        name = str(data.get("action") or "")
        action = ACTIONS.get(name)
        if action is None:
            return _bad("not something the phone can do")
        command: dict[str, Any] = {"type": action.command}
        task = api._session(data.get("id")) if data.get("id") is not None else None
        if action.session and task is None:
            return _bad("no such session", 404)
        if task is not None:
            command["id"] = task.id
        for key in action.fields:
            if key in data:
                try:
                    command[key] = _value(data[key])
                except TypeError:
                    continue
        if "directory" in action.fields and not command.get("directory"):
            command["directory"] = str(task.cwd) if task is not None else ""
        ref = uuid.uuid4().hex if action.by_ref else ""
        if ref:
            command["ref"] = ref

        def wanted(event: dict[str, Any]) -> bool:
            # A "!" command's output is matched by its ref: another one's isn't this answer.
            return not ref or event.get("type") != "task_bash" or event.get("ref") == ref

        heard = await desk.run(command, action.wait, action.seconds, wanted)
        api.companion.record(device, f"code_{name}", f"#{task.id}" if task is not None else "")
        answer: dict[str, Any] = {"ok": True}
        for event in heard:
            kind = event.get("type")
            body = {k: v for k, v in event.items() if k != "type"}
            if kind == "caption":
                answer["said"] = str(body.get("text") or "")
            elif kind == "error":
                answer["ok"] = False
                answer["said"] = str(body.get("text") or "")
            else:
                answer[str(kind)] = body
        return JSONResponse(answer)

    return [
        Route("/api/code/options", code_options),
        Route("/api/code/new", code_new, methods=["POST"]),
        Route("/api/code/action", code_action, methods=["POST"]),
    ]
