"""Eden Code: AGENTS.md read alongside CLAUDE.md, so every agent starts from the project's notes.

Claude Code reads a project's CLAUDE.md by itself; Codex and OpenCode read AGENTS.md; Gemini
reads neither (GEMINI.md is its own). What Eden writes into a project (the "# note"s for it
and the lessons from the owner's corrections there) goes into Eden's section of both files,
kept the same (code_memory.write_shared). This makes sure each session also gets the notes
its agent wouldn't read by itself:

- A session with another agent over ACP (features/code_acp: a model "acp:<agent>") gets the
  project's AGENTS.md (or its CLAUDE.md, when it has no AGENTS.md) with its first message,
  marked as the project's notes, unless its agent reads that file itself (Codex and OpenCode
  read AGENTS.md: they're only told when the project has just a CLAUDE.md).
- A Claude Code session in a project that keeps its notes in AGENTS.md alone (a repository
  set up for Codex) gets that AGENTS.md the same way.
- Before either, Eden's section is brought into step in the two files (one edited by hand
  since: the one edited last wins), so the agent reads what Claude Code reads.

TaskManager.turn_notes: the notes go with a session's first message only (its transcript
and history show the message without them), at most NOTES_CHARS of the file.

Cost policy (Claude): nothing here calls a model. The notes ride along with the session's
own first message, on its own model (another agent's is on the owner's account there).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .. import code_memory
from ..codeplatform import other_agent, project_of

log = logging.getLogger("jarvis")

NOTES_CHARS = 8000  # of the file, with the first message
# Agents that read AGENTS.md themselves (the first word of their command, its file name).
READS_AGENTS_MD = frozenset({"codex", "codex-acp", "opencode", "opencode-acp"})


def reads_agents_md(command: list[str] | None) -> bool:
    """Whether the agent this command starts reads a project's AGENTS.md by itself."""
    words = [w for w in (command or []) if w and not w.startswith("-")]
    names = {os.path.basename(w).lower() for w in words[:3]}  # (npx codex-acp, bunx opencode)
    return bool(names & READS_AGENTS_MD)


class AgentsNotes:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.told: set[int] = set()  # sessions that had the notes (or needed none)

    def _command(self, task: Any) -> list[str]:
        desk = getattr(self.hub, "code_acp", None)
        ref = str(getattr(task, "model_ref", "") or "")
        try:
            agent = desk.book.agents.get(ref.removeprefix("acp:")) if desk else None
        except Exception:
            agent = None
        return list((agent or {}).get("command") or [])

    def turn_note(self, task: Any) -> str:
        """TaskManager.turn_notes: the project's notes, with the session's first message."""
        if getattr(task, "kind", "") != "code" or task.id in self.told:
            return ""
        self.told.add(task.id)
        folder = Path(task.cwd)
        try:
            code_memory.sync_shared(Path(project_of(self.hub, task)))
            if folder != Path(project_of(self.hub, task)):
                code_memory.sync_shared(folder)  # (the copy's own files, which it reads)
        except Exception:
            log.warning(
                "Eden Code: couldn't bring CLAUDE.md and AGENTS.md into step", exc_info=True
            )
        has_claude = (folder / "CLAUDE.md").is_file()
        has_agents = (folder / code_memory.AGENTS).is_file()
        if other_agent(task):
            if has_agents and reads_agents_md(self._command(task)):
                return ""  # (it reads the file itself)
        elif has_claude or not has_agents:
            return ""  # Claude Code reads CLAUDE.md itself; without one, AGENTS.md is told
        name, text = code_memory.project_notes(folder, NOTES_CHARS)
        if not text:
            return ""
        return (
            f"The project's notes for coding agents, from its {name} (written by the owner and "
            "their team; follow them as you would the owner's instructions for this project, "
            f"unless this request says otherwise):\n{text}\n"
        )

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "tasks":  # sessions let go of: forgotten
            live = set(self.hub.tasks.tasks)
            self.told &= live


def install(hub: Any) -> None:
    notes = AgentsNotes(hub)
    hub.code_agents_md = notes  # (for the tests)
    hub.tasks.turn_notes.append(notes.turn_note)
    hub.add_task_sink(notes.on_task_event)
