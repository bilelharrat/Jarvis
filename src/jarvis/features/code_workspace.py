"""The Jarvis Code workspace: what's around a session besides the conversation.

- Pictures in the transcript (cw_media): the owner's attachments and a step's screenshots,
  read from Claude Code's own record of the session (code_records) when a window shows
  the entry; the window draws the rest of the transcript (web/features/code-markdown.js).
- Files, editable (cw_file_*; code_editor): read with their version, saved only over the
  version they were edited from (a conflict otherwise, with the differences), checked for
  changes on disk; "Open in" the editors on this Mac (cw_editors, cw_open_in). The window
  is web/features/code-editor.js, in place of the core's read-only viewer.

Window commands are cw_*; each answers with an event of the same name. Work that reads
files or runs something happens off the event loop, in the background, so a slow one
never holds up the next command.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import difflib
import logging
from pathlib import Path
from typing import Any

from .. import code_editor, lang, mac_tools
from ..code_editor import Editors
from ..code_records import RecordMedia

log = logging.getLogger("jarvis")

# The sentences this feature shows in the caption line, with their Chinese.
ZH = {
    "That editor isn't on this Mac.": "这台 Mac 上没有那个编辑器。",
    "Couldn't open it: {error}": "没能打开：{error}",
    "No file named.": "没有指定文件。",
    "That's outside the project.": "那在项目之外。",
    "That file holds credentials or private data.": "那个文件含有凭据或隐私数据。",
}
lang.add_texts(ZH)


class Workspace:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.media = RecordMedia()
        self.editors = Editors()
        self._tasks: set[asyncio.Task] = set()

    # ── helpers ──

    def spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return task

    def session(self, msg: dict[str, Any]) -> Any:
        """The Jarvis Code session a command names (by id), or None."""
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError):
            return None
        return task if task is not None and task.kind == "code" else None

    def folder(self, msg: dict[str, Any]) -> Path:
        """The folder a command is about: its session's (id), whose files the session works
        on (its own isolated copy, when it has one); else a project (directory). Raises
        ValueError for one that isn't a project."""
        task = self.session(msg)
        if task is not None:
            return Path(task.cwd)
        return self.hub.tasks.resolve_dir(str(msg.get("directory") or ""))

    def caption(self, text: str) -> None:
        """A line in the caption, in the owner's language."""
        self.hub.emit("caption", text=lang.translate(text, self.hub.language))

    def _answer(self, kind: str, msg: dict[str, Any], **data: Any) -> None:
        """An event answering a window command: the file it was about and the ref the
        window gave it, with what came of it."""
        self.hub.emit(
            kind,
            path=str(msg.get("path") or "")[:1000],
            ref=str(msg.get("ref") or "")[:2000],
            **data,
        )

    # ── pictures in the transcript ──

    async def cmd_media(self, msg: dict[str, Any]) -> None:
        """{id, keys: [a message's uuid or a step's tool id], ref?}: the pictures Claude
        Code's record holds for those entries (keys it has none for are left out)."""
        task = self.session(msg)
        keys = [k for k in msg.get("keys") or [] if isinstance(k, str)][:24]
        ref = str(msg.get("ref") or "")[:40]
        items: dict[str, Any] = {}
        if task is not None and task.session_id and keys:
            items = await asyncio.to_thread(self.media.pictures, task.session_id, task.cwd, keys)
        self.hub.emit(
            "cw_media",
            id=task.id if task else 0,
            keys=keys,
            items=items,
            **({"ref": ref} if ref else {}),
        )

    # ── files: read, saved over the version they came from, compared, opened elsewhere ──

    async def cmd_file_read(self, msg: dict[str, Any]) -> None:
        try:
            root = self.folder(msg)
        except ValueError as exc:
            self._answer("cw_file", msg, error=str(exc))
            return
        result = await asyncio.to_thread(code_editor.read, root, str(msg.get("path") or ""))
        result.pop("path", None)
        self._answer("cw_file", msg, **result)

    async def cmd_file_stat(self, msg: dict[str, Any]) -> None:
        """Has the file changed since the version the window has (base)?"""
        base = msg.get("base") if isinstance(msg.get("base"), dict) else {}
        try:
            root = self.folder(msg)
            path = code_editor.locate(root, str(msg.get("path") or ""))
        except ValueError:
            return
        changed = not await asyncio.to_thread(code_editor.same_version, path, base)
        missing = not path.exists()
        self._answer("cw_file_stat", msg, changed=changed, missing=missing)

    async def cmd_file_save(self, msg: dict[str, Any]) -> None:
        base = msg.get("base") if isinstance(msg.get("base"), dict) else None
        try:
            root = self.folder(msg)
        except ValueError as exc:
            self._answer("cw_file_saved", msg, error=str(exc))
            return
        result = await asyncio.to_thread(
            code_editor.save,
            root,
            str(msg.get("path") or ""),
            msg.get("text"),
            base,
            crlf=msg.get("crlf") is True,
            force=msg.get("force") is True,
            create=msg.get("create") is True,
        )
        result.pop("path", None)
        result.pop("disk_text", None)  # (the window asks for the differences when it wants them)
        self._answer("cw_file_saved", msg, **result)

    async def cmd_file_compare(self, msg: dict[str, Any]) -> None:
        """What's on disk against the window's text, as hunks the diff view draws."""
        try:
            root = self.folder(msg)
            path = code_editor.locate(root, str(msg.get("path") or ""))
        except ValueError as exc:
            self._answer("cw_file_compare", msg, hunks=[], error=str(exc))
            return
        mine = msg.get("text") if isinstance(msg.get("text"), str) else ""
        disk = await asyncio.to_thread(code_editor.disk_now, path)
        if disk.get("missing"):
            self._answer("cw_file_compare", msg, hunks=hunks("", mine))
            return
        if "disk_text" not in disk:
            self._answer(
                "cw_file_compare", msg, hunks=[], error="What's on disk can't be compared here."
            )
            return
        found = await asyncio.to_thread(hunks, disk["disk_text"], mine)
        self._answer("cw_file_compare", msg, hunks=found)

    async def cmd_editors(self, _msg: dict[str, Any]) -> None:
        found = await asyncio.to_thread(self.editors.list)
        self.hub.emit("cw_editors", items=[{"id": e["id"], "name": e["name"]} for e in found])

    async def cmd_open_in(self, msg: dict[str, Any]) -> None:
        """A file (at a line) or the whole project in an editor on this Mac, in the file's
        own app, or in Finder: the owner's own click, on a file inside the project."""
        try:
            root = self.folder(msg)
            rel = str(msg.get("path") or "")
            path = code_editor.locate(root, rel) if rel else Path(root).resolve()
        except ValueError as exc:
            self.caption(str(exc))
            return
        editor_id = str(msg.get("editor") or "")
        if editor_id == "finder":
            command = ["open", "-R", str(path)]
        elif editor_id == "app":  # the file's own app (Preview, a browser, Numbers…)
            command = ["open", str(path)]
        else:
            editor = await asyncio.to_thread(self.editors.get, editor_id)
            if editor is None:
                self.caption("That editor isn't on this Mac.")
                return
            line = msg.get("line") if isinstance(msg.get("line"), int) else 0
            command = code_editor.open_command(editor, path, max(0, line))
        try:
            await mac_tools.run_command(*command, timeout=20)
        except (mac_tools.ToolFailure, OSError) as exc:
            self.caption(f"Couldn't open it: {exc}")


HUNKS_MAX = 60  # hunks a comparison shows
HUNK_LINES_MAX = 4000  # lines, all of its hunks together


def hunks(old: str, new: str, context: int = 3) -> list[dict[str, Any]]:
    """old -> new as unified hunks ({old_start, old_count, new_start, new_count, lines:
    [[tag, text]]}, tag " ", "-" or "+"), as code_changes gives them to the diff view."""
    a, b = old.split("\n"), new.split("\n")
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=len(a) + len(b) > 4000)
    out: list[dict[str, Any]] = []
    total = 0
    for group in matcher.get_grouped_opcodes(context):
        first, last = group[0], group[-1]
        lines: list[list[str]] = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                lines += [[" ", line] for line in a[i1:i2]]
                continue
            if tag in ("replace", "delete"):
                lines += [["-", line] for line in a[i1:i2]]
            if tag in ("replace", "insert"):
                lines += [["+", line] for line in b[j1:j2]]
        total += len(lines)
        out.append(
            {
                "old_start": first[1] + 1,
                "old_count": last[2] - first[1],
                "new_start": first[3] + 1,
                "new_count": last[4] - first[3],
                "lines": lines,
            }
        )
        if len(out) >= HUNKS_MAX or total >= HUNK_LINES_MAX:
            break
    return out


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("Jarvis Code workspace: background work failed", exc_info=task.exception())


def install(hub: Any) -> None:
    ws = Workspace(hub)
    hub.code_workspace = ws
    hub.register_command("cw_media", lambda msg: ws.spawn(ws.cmd_media(msg)))
    hub.register_command("cw_file_read", lambda msg: ws.spawn(ws.cmd_file_read(msg)))
    hub.register_command("cw_file_stat", lambda msg: ws.spawn(ws.cmd_file_stat(msg)))
    hub.register_command("cw_file_save", lambda msg: ws.spawn(ws.cmd_file_save(msg)))
    hub.register_command("cw_file_compare", lambda msg: ws.spawn(ws.cmd_file_compare(msg)))
    hub.register_command("cw_editors", lambda msg: ws.spawn(ws.cmd_editors(msg)))
    hub.register_command("cw_open_in", lambda msg: ws.spawn(ws.cmd_open_in(msg)))
