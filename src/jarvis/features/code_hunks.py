"""Eden Code's Changes pane: what a session changed (code_changes.py) as the window
shows it, and what's done to one hunk at a time.

Views: "turn" (its latest turn's hunks), "session" (all of its own; in its isolated copy,
everything since the copy began) and "branch" (everything on the branch that isn't on
the one it goes into, anyone's). Every view numbers the hunks as the session view does,
the numbers voice uses ("undo change 3"). Undo puts back just that hunk; Keep marks it
reviewed (folded away, for this run of the app).

Window commands: code_changes {id, view, path?}, code_hunk {id, hunk, action: undo|keep|
unkeep, view}, code_lines {id, path, start, end}.
Events: code_changes, code_kept, code_lines.

No Claude calls here: none of this costs anything.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from .. import code_changes, lang
from ..hub import _msg_int

VIEWS = ("turn", "session", "branch")
LINES_AT_ONCE = 200  # unchanged lines a click unfolds

ZH = {
    "Undid {n} change.": "已撤销 {n} 处改动。",
    "Undid {n} changes.": "已撤销 {n} 处改动。",
    "That change isn't there any more.": "那处改动已经不在了。",
    "{path} is a new file; delete it yourself if you don't want it.": "{path} 是新文件；不想要的话请自己删除。",
    "{path} can't be undone a change at a time here.": "{path} 没法在这里逐处撤销。",
    "That change in {path} has moved on since the view was made. Refresh and try again.": "{path} 里的那处改动在显示之后又变了。刷新后再试。",
    "Couldn't undo that change in {path}: {error}": "没能撤销 {path} 里的那处改动：{error}",
    "This folder isn't a git repository.": "这个文件夹不是 git 仓库。",
}
lang.add_texts(ZH)


class Hunks:
    """One hub's Changes pane: the views it asks for, and the hunks kept."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.kept: dict[int, set[str]] = {}  # session id -> hunk ids the owner kept

    def _task(self, msg: dict[str, Any]) -> Any:
        task = self.hub.tasks.tasks.get(_msg_int(msg, "id"))
        return task if task is not None and task.kind == "code" else None

    def caption(self, text: str) -> None:
        self.hub.emit("caption", text=lang.translate(text, self.hub.language))

    # ── views ──

    def cmd_changes(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.changes(msg))

    async def changes(self, msg: dict[str, Any]) -> None:
        task = self._task(msg)
        if task is None:
            return
        which = msg.get("view") if msg.get("view") in VIEWS else "session"
        path = str(msg.get("path") or "")[:1000]
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        self.hub.emit("code_changes", **self.payload(task, which, view, path))

    def payload(
        self, task: Any, which: str, view: code_changes.View | None, path: str = ""
    ) -> dict[str, Any]:
        desk = getattr(self.hub, "code_desk", None)
        slug = task.workspace.get("slug", "")
        base: dict[str, Any] = {
            "id": task.id,
            "view": which,
            "git": view is not None,
            "workspace": {k: v for k, v in task.workspace.items() if k != "base"},
            "conflicts": desk.conflicts.get(slug, []) if desk is not None and slug else [],
        }
        if view is None:
            gone = bool(task.workspace) and not task.cwd.exists()  # landed or discarded
            touched = sorted(task.files_changed)[:300]
            return base | {"gone": gone, "files": [], "touched": touched, "totals": {}}
        kept = self.kept.get(task.id, set())
        if path:
            return base | {"path": path, "file": code_changes.file_public(view, path, kept)}
        return base | code_changes.public(view, kept)

    # ── one hunk ──

    def cmd_hunk(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.hunk(msg))

    async def hunk(self, msg: dict[str, Any]) -> None:
        """Undo, keep or un-keep one hunk, by its id, in the view it was shown in."""
        task = self._task(msg)
        if task is None:
            return
        action = str(msg.get("action") or "")
        hunk_id = str(msg.get("hunk") or "")[:40]
        which = msg.get("view") if msg.get("view") in VIEWS else "session"
        if action in ("keep", "unkeep"):
            self.keep(task, [hunk_id], action == "keep")
        elif action == "undo":
            said = await self.undo(task, which, [hunk_id])
            self.caption(said)
            await self.changes({"id": task.id, "view": which})
            # (code_lessons hears it: the owner may say what to remember)
            self.hub.emit(
                "code_hunk_undone",
                id=task.id,
                undone=said.startswith("Undid"),
                file=str(msg.get("path") or ""),
            )

    def keep(self, task: Any, hunk_ids: list[str], on: bool = True) -> None:
        kept = self.kept.setdefault(task.id, set())
        for hunk_id in hunk_ids:
            if on:
                kept.add(hunk_id)
            else:
                kept.discard(hunk_id)
        self.hub.emit("code_kept", id=task.id, kept=sorted(kept))

    async def undo(self, task: Any, which: str, hunk_ids: list[str]) -> str:
        """Undo hunks by id, each file bottom to top (undoing one never moves the lines of
        the next). Returns what to say."""
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        if view is None:
            return "This folder isn't a git repository."
        head = await asyncio.to_thread(code_changes.head_commit, view.repo.top)
        found = [pair for hunk_id in hunk_ids if (pair := view.hunk(hunk_id)) is not None]
        if not found:
            return "That change isn't there any more."
        found.sort(key=lambda pair: (pair[0].path, -pair[1].new_start))
        for f, h in found:
            problem = await asyncio.to_thread(
                code_changes.undo_hunk, view.repo, f, h, against_head=view.base == head
            )
            if problem:
                return problem
        return f"Undid {len(found)} change{'s' if len(found) != 1 else ''}."

    # ── the unchanged lines between hunks ──

    def cmd_lines(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.lines(msg))

    async def lines(self, msg: dict[str, Any]) -> None:
        """Unchanged lines of a file the pane folded away between two hunks (at most
        LINES_AT_ONCE): a text file inside the session's folder, never credentials."""
        task = self._task(msg)
        if task is None:
            return
        path = str(msg.get("path") or "")[:1000]
        try:
            start = max(1, int(msg.get("start") or 1))
            end = min(int(msg.get("end") or start), start + LINES_AT_ONCE - 1)
        except (TypeError, ValueError, OverflowError):  # (infinity too)
            return
        found = await asyncio.to_thread(read_lines, task.cwd, path, start, end)
        if found is not None:
            self.hub.emit("code_lines", id=task.id, path=path, start=start, lines=found)


def read_lines(root: Path, path: str, start: int, end: int) -> list[str] | None:
    """Lines start..end (1-based) of a text file inside root, or None: outside it, a link
    out of it, credentials, too big, or not text."""
    from ..computer import is_sensitive

    try:
        base = root.resolve()
        target = (base / path).resolve()
        if base not in target.parents or is_sensitive(target) or not target.is_file():
            return None
        if target.stat().st_size > 5_000_000:
            return None
        data = target.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    text = data.decode("utf-8", errors="replace")
    lines = text.split("\n")
    if text.endswith("\n"):
        lines.pop()  # (nothing after the last line's newline)
    return [line[:2000] for line in lines[start - 1 : end]]


def install(hub: Any) -> None:
    hunks = Hunks(hub)
    hub.code_hunks = hunks  # (for voice, review and the tests)
    hub.register_command("code_changes", hunks.cmd_changes)
    hub.register_command("code_hunk", hunks.cmd_hunk)
    hub.register_command("code_lines", hunks.cmd_lines)
