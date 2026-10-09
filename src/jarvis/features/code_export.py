"""Eden Code's full export (code_export), from the Export pane (web/features/code-export.js).

- cw_export {id, safe, anonymize, format: "html" | "pdf", ref}: the session read whole from
  Claude Code's own record (every message, each step's input and output, the thinking),
  written to ~/Documents/Jarvis/Eden Code as a page (HTML) or a PDF laid out by the app's
  window -> cw_export {ref, ok, path, name} or {ref, error}. Share-safe blanks out keys,
  tokens and passwords and leaves pictures out; anonymize hides where things are on this
  Mac. A session that never connected has no record: what its transcript kept goes.
- cw_export_reveal {path}: an export shown in Finder (only a file in that folder).

The core's Markdown export (/export) stays as it was.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
from pathlib import Path
from typing import Any

from .. import code_records, lang, mac_tools, tasks
from ..code_export import Anonymizer, entries_from, entries_from_transcript, file_stem, render
from .code_workspace import session_of, unopenable

log = logging.getLogger("jarvis")

ZH = {
    "Open a session to export it.": "打开一个会话才能导出它。",
    "A PDF needs the app's window: export the page instead, or try again in the app.": "PDF 需要应用的窗口：改为导出网页，或在应用里再试一次。",
    "Couldn't save the export: {error}": "没能保存导出的文件：{error}",
}
lang.add_texts(ZH)


def _entries(task: Any) -> list[dict[str, Any]]:
    """The session whole from Claude Code's record; its transcript when it has none."""
    if task.session_id:
        try:
            messages = tasks.get_session_messages(task.session_id, directory=str(task.cwd))
        except Exception:  # an unreadable record: what the transcript kept
            log.warning(
                "Couldn't read session %s's record to export it", task.session_id, exc_info=True
            )
            messages = []
        if messages:
            entries = entries_from(messages, tasks._history_said)
            times = code_records.timestamps(code_records.record_path(task.session_id, task.cwd))
            for e in entries:
                if e.get("uuid") in times:
                    e["at"] = times[e["uuid"]]
            return entries
    return entries_from_transcript(list(task.transcript))


def _write(stem: str, suffix: str, data: bytes) -> Path:
    folder = tasks.EXPORT_DIR
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{stem}{suffix}"
    for n in itertools.count(2):  # a second export in the same minute is its own file
        if not path.exists():
            break
        path = folder / f"{stem} {n}{suffix}"
    path.write_bytes(data)
    return path


class Exports:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    async def cmd_export(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:40]
        task = session_of(self.hub, msg)
        if task is None:
            self.hub.emit("cw_export", ref=ref, error=self.tr("Open a session to export it."))
            return
        safe = msg.get("safe") is True
        pdf = msg.get("format") == "pdf"
        title = task.title or task.prompt or "Eden Code session"
        try:
            entries = await asyncio.to_thread(_entries, task)
            page = await asyncio.to_thread(
                render,
                entries,
                title=title,
                project=str(task.cwd),
                model=str(getattr(task, "model_label", "") or task.model or ""),
                safe=safe,
                anonymize=Anonymizer.for_session(task.cwd)
                if msg.get("anonymize") is True
                else None,
                printing=pdf,
            )
            stem = file_stem(title, safe)
            if pdf:
                data = await self.hub.pdf_call(page)
                if not data:
                    raise ValueError(
                        "A PDF needs the app's window: export the page instead, or try again in the app."
                    )
                path = await asyncio.to_thread(_write, stem, ".pdf", data)
            else:
                path = await asyncio.to_thread(_write, stem, ".html", page.encode("utf-8"))
        except ValueError as exc:
            self.hub.emit("cw_export", ref=ref, error=self.tr(str(exc)))
            return
        except OSError as exc:  # a full disk, Documents not writable
            self.hub.emit(
                "cw_export",
                ref=ref,
                error=self.tr(f"Couldn't save the export: {exc.strerror or exc}"),
            )
            return
        self.hub.emit(
            "cw_export", ref=ref, ok=True, path=str(path), name=path.name, entries=len(entries)
        )

    async def cmd_reveal(self, msg: dict[str, Any]) -> None:
        """An export in Finder: only a file this feature writes to, never a path it's given."""
        given = str(msg.get("path") or "")
        if unopenable(given):
            return
        path = Path(given).expanduser()
        try:
            folder = tasks.EXPORT_DIR.resolve()
            path = path.resolve()
        except OSError:
            return
        if folder in path.parents and path.is_file():
            await mac_tools.run_command("open", "-R", str(path), timeout=20)


def install(hub: Any) -> None:
    exports = Exports(hub)
    hub.code_export = exports
    hub.register_command("cw_export", lambda msg: hub._spawn(exports.cmd_export(msg)))
    hub.register_command("cw_export_reveal", lambda msg: hub._spawn(exports.cmd_reveal(msg)))
