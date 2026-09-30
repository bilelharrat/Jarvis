"""The Jarvis Code workspace: what's around a session besides the conversation.

- Pictures in the transcript (cw_media): the owner's attachments and a step's screenshots,
  read from Claude Code's own record of the session (code_records) when a window shows
  the entry; the window draws the rest of the transcript (web/features/code-markdown.js).

Window commands are cw_*; each answers with an event of the same name. Work that reads
files or runs something happens off the event loop, in the background, so a slow one
never holds up the next command.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..code_records import RecordMedia

log = logging.getLogger("jarvis")


class Workspace:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.media = RecordMedia()
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


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("Jarvis Code workspace: background work failed", exc_info=task.exception())


def install(hub: Any) -> None:
    ws = Workspace(hub)
    hub.code_workspace = ws
    hub.register_command("cw_media", lambda msg: ws.spawn(ws.cmd_media(msg)))
