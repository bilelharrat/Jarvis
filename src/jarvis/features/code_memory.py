"""Eden Code's memory files (code_memory): which CLAUDE.md a "#" note goes to.

- task_memory (the composer's "# note") is taken from the core here: the note waits, and the
  window asks where it goes (cw_memory_ask {ref, id, text, choices, last}): the project's
  CLAUDE.md, its CLAUDE.local.md, or the owner's ~/.claude/CLAUDE.md.
- cw_memory_save {ref, target}: the note goes there (target null: it doesn't), and the core's
  task_memory event says so, as before. The choice is remembered for the next note
  (the code_memory_target setting).

The Files pane edits the three files (features/code_workspace: {memory: "user"} for the
owner's own, outside any project).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from .. import code_memory
from ..prefs import register_feature_pref

PREF = "code_memory_target"
WAITING_MAX = 20  # notes waiting for their answer
WAITING_SECONDS = 30 * 60  # a note left unanswered this long is dropped


def _target(value: Any) -> str | None:
    return value if value in code_memory.TARGETS else None


register_feature_pref(PREF, "project", _target)


class Memory:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waiting: dict[str, dict[str, Any]] = {}

    def on_note(self, msg: dict[str, Any]) -> None:
        """ "# note": asked where it goes before anything is written."""
        note = code_memory.clean_note(str(msg.get("text", "")))
        folder = self.hub._code_folder(msg)
        if not note or folder is None:
            self.hub.emit("task_memory", ok=False, text=note, path="")
            return
        now = time.monotonic()
        for ref in [r for r, w in self.waiting.items() if now - w["at"] > WAITING_SECONDS]:
            del self.waiting[ref]
        while len(self.waiting) >= WAITING_MAX:
            self.waiting.pop(next(iter(self.waiting)))
        ref = uuid.uuid4().hex[:12]
        self.waiting[ref] = {"note": note, "folder": folder, "at": now}
        self.hub.emit(
            "cw_memory_ask",
            ref=ref,
            id=msg.get("id") or 0,
            text=note,
            choices=code_memory.choices(folder),
            last=self.hub.prefs.feature(PREF) or "project",
        )

    async def cmd_save(self, msg: dict[str, Any]) -> None:
        waiting = self.waiting.pop(str(msg.get("ref") or ""), None)
        target = _target(msg.get("target"))
        if waiting is None or target is None:
            return  # (declined, or asked too long ago: nothing written)
        path = code_memory.path_for(target, waiting["folder"])
        try:
            await asyncio.to_thread(code_memory.append_note, path, waiting["note"])
        except OSError:  # read-only, a link, not a file: the window says it wasn't saved
            self.hub.emit("task_memory", ok=False, text=waiting["note"], path="")
            return
        if self.hub.prefs.feature(PREF) != target:
            self.hub.set_feature_prefs({PREF: target})
        self.hub.emit("task_memory", ok=True, text=waiting["note"], path=str(path), target=target)


def install(hub: Any) -> None:
    memory = Memory(hub)
    hub.code_memory = memory
    hub.register_command("task_memory", memory.on_note)
    hub.register_command("cw_memory_save", lambda msg: hub._spawn(memory.cmd_save(msg)))
