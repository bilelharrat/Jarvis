"""Projects, as the Claude, ChatGPT and Gemini apps have them: conversations kept together
with instructions and files they share. While a project is open, every conversation started
belongs to it, and each request carries the project's instructions; its files go along once
per conversation (and again when one is added). Not Jarvis Code's projects (folders of code):
these are the main chat's.

Kept in chat-projects.json beside prefs.json: {"active": id or "", "projects": [{id, name,
instructions, files: [{name, chars, added}], sessions: [session ids], created}]}; each
file's text in chat-projects/<id>/<n>.txt (PDFs are read to text when they're added).

Window commands (features/projects.js), each answered with the event chat_projects {items,
active, current}:
- chat_projects {}
- chat_project_save {id?, name, instructions}: a new project (opened) or one changed
- chat_project_delete {id}: the project and its files; its conversations stay, unfiled
- chat_project_use {id or ""}: open a project (a new conversation in it, unless the one
  going on is already its) or close it
- chat_project_file {id, name, text | pdf (base64)}: a file added
- chat_project_unfile {id, name}: a file taken away
- chat_project_assign {session_id, id or ""}: a conversation moved in or out

The phone's /api/projects routes (companion_projects.py) use the same desk.

Claude cost policy: no model is called here; the note rides on the owner's own request.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from ..conversation_state import valid_id

log = logging.getLogger("jarvis")

STATE_FILE = "chat-projects.json"
FILES_DIR = "chat-projects"
MAX_PROJECTS = 100
MAX_FILES = 20
MAX_SESSIONS = 500
NAME_MAX = 60
INSTRUCTIONS_MAX = 8000
FILE_CHARS = 100_000  # one file's text
NOTE_CHARS = 150_000  # all the files that go with one request
PDF_MAX_BYTES = 25 * 1024 * 1024


def _line(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _file_name(value: Any) -> str:
    name = "".join(c for c in str(value or "") if c not in "/\\:\x00").strip()
    return name[:120]


def _pdf_text(data: bytes) -> str:
    from ..browser_pdf import extract

    return extract(data)


class ChatProjects:
    def __init__(self, hub: Any, folder: Path | None = None) -> None:
        from .. import jsonstore
        from ..prefs import APP_SUPPORT

        self.hub = hub
        self.folder = folder or APP_SUPPORT
        self.path = self.folder / STATE_FILE
        try:
            raw = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable:
            raw = {}
        raw = raw if isinstance(raw, dict) else {}
        self.projects: list[dict[str, Any]] = [
            p for p in (self._clean(x) for x in raw.get("projects") or []) if p
        ][:MAX_PROJECTS]
        active = str(raw.get("active") or "")
        self.active = active if self.find(active) else ""
        # Which of a project's files each conversation has had (this run only: after a
        # restart a conversation carried on gets them once more).
        self.sent: dict[str, set[str]] = {}
        self._pending: tuple[str, list[str]] | None = None

    # ── the record ──

    @staticmethod
    def _clean(raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, dict):
            return None
        pid = str(raw.get("id") or "")
        name = _line(raw.get("name"), NAME_MAX)
        if not pid.isalnum() or not name:
            return None
        files = []
        for f in raw.get("files") or []:
            if isinstance(f, dict) and _file_name(f.get("name")):
                files.append(
                    {
                        "name": _file_name(f.get("name")),
                        "chars": int(f.get("chars") or 0),
                        "added": int(f.get("added") or 0),
                    }
                )
        sessions = [s for s in (valid_id(x) for x in raw.get("sessions") or []) if s]
        return {
            "id": pid,
            "name": name,
            "instructions": str(raw.get("instructions") or "")[:INSTRUCTIONS_MAX],
            "files": files[:MAX_FILES],
            "sessions": sessions[-MAX_SESSIONS:],
            "created": int(raw.get("created") or 0),
        }

    def find(self, pid: Any) -> dict[str, Any] | None:
        return next((p for p in self.projects if p["id"] == str(pid or "")), None)

    def project_of(self, session_id: str) -> dict[str, Any] | None:
        return next((p for p in self.projects if session_id in p["sessions"]), None)

    def _save(self) -> None:
        from .. import jsonstore

        jsonstore.save_json(self.path, {"active": self.active, "projects": self.projects})

    def _dir(self, pid: str) -> Path:
        return self.folder / FILES_DIR / pid

    def _text_path(self, pid: str, index: int) -> Path:
        return self._dir(pid) / f"{index}.txt"

    def _read_texts(self, project: dict[str, Any]) -> dict[str, str]:
        texts = {}
        for index, f in enumerate(project["files"]):
            with contextlib.suppress(OSError):
                texts[f["name"]] = self._text_path(project["id"], index).read_text()
        return texts

    def _file_text(self, pid: str, indexes: list[int]) -> str | None:
        """A file's text as _read_texts has it: the last of its copies that can be read
        (one name has one file, unless the list was edited by hand)."""
        for index in reversed(indexes):
            with contextlib.suppress(OSError):
                return self._text_path(pid, index).read_text()
        return None

    def _write_texts(self, project: dict[str, Any], texts: dict[str, str]) -> None:
        folder = self._dir(project["id"])
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*.txt"):
            old.unlink()
        for index, f in enumerate(project["files"]):
            self._text_path(project["id"], index).write_text(texts.get(f["name"], ""))

    def listing(self) -> dict[str, Any]:
        convo = getattr(self.hub, "conversation", None)
        titles = convo.state.titles() if convo is not None else {}
        current = getattr(self.hub, "_session_id", "")
        items = [
            {
                **{k: v for k, v in p.items() if k != "sessions"},
                "conversations": [
                    {"session_id": s, "title": titles.get(s, "")} for s in reversed(p["sessions"])
                ],
            }
            for p in self.projects
        ]
        return {"items": items, "active": self.active, "current": current}

    def emit(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("chat_projects", **self.listing())

    # ── changes ──

    def save(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        name = _line(msg.get("name"), NAME_MAX)
        instructions = str(msg.get("instructions") or "").strip()[:INSTRUCTIONS_MAX]
        project = self.find(msg.get("id"))
        if project is None:
            if not name or len(self.projects) >= MAX_PROJECTS:
                return None
            project = {
                "id": secrets.token_hex(4),
                "name": name,
                "instructions": instructions,
                "files": [],
                "sessions": [],
                "created": int(time.time() * 1000),
            }
            self.projects.insert(0, project)
            self.active = project["id"]
        else:
            if name:
                project["name"] = name
            if "instructions" in msg:
                project["instructions"] = instructions
        self._save()
        self.emit()
        return project

    def delete(self, msg: dict[str, Any]) -> None:
        project = self.find(msg.get("id"))
        if project is None:
            return
        self.projects.remove(project)
        if self.active == project["id"]:
            self.active = ""
        shutil.rmtree(self._dir(project["id"]), ignore_errors=True)
        self._save()
        self.emit()

    async def use(self, msg: dict[str, Any]) -> None:
        pid = str(msg.get("id") or "")
        project = self.find(pid)
        self.active = project["id"] if project else ""
        self._save()
        current = getattr(self.hub, "_session_id", "")
        if project is not None and current and current not in project["sessions"]:
            await self.hub.reset()  # a new conversation, in the project
        self.emit()

    async def add_file(self, msg: dict[str, Any]) -> str:
        """'' once added, or why it wasn't."""
        project = self.find(msg.get("id"))
        name = _file_name(msg.get("name"))
        if project is None or not name:
            return "No such project."
        if len(project["files"]) >= MAX_FILES and not any(
            f["name"] == name for f in project["files"]
        ):
            return f"A project holds {MAX_FILES} files at most."
        if isinstance(msg.get("pdf"), str):
            raw = msg["pdf"]
            if len(raw) > PDF_MAX_BYTES * 4 // 3 + 4:
                return "This PDF is too big (over 25 MB)."
            try:
                data = base64.b64decode(raw, validate=True)
                text = await asyncio.to_thread(_pdf_text, data)
            except (binascii.Error, ValueError):
                return "The PDF didn't arrive whole."
            except Exception:
                return "This PDF couldn't be read: it may be damaged, or locked with a password."
        else:
            text = str(msg.get("text") or "")
        text = text.replace("\x00", "")[:FILE_CHARS]
        if not text.strip():
            return "There's no text in that file to keep."
        texts = self._read_texts(project)
        project["files"] = [f for f in project["files"] if f["name"] != name]
        project["files"].append(
            {"name": name, "chars": len(text), "added": int(time.time() * 1000)}
        )
        texts[name] = text
        self._write_texts(project, texts)
        for sent in self.sent.values():  # a new version goes again
            sent.discard(name)
        self._save()
        self.emit()
        return ""

    async def window_file(self, msg: dict[str, Any]) -> None:
        problem = await self.add_file(msg)
        if problem:
            self.hub.emit("toast", title="Projects", text=problem)

    def remove_file(self, msg: dict[str, Any]) -> None:
        project = self.find(msg.get("id"))
        name = _file_name(msg.get("name"))
        if project is None:
            return
        texts = self._read_texts(project)
        project["files"] = [f for f in project["files"] if f["name"] != name]
        texts.pop(name, None)
        self._write_texts(project, texts)
        self._save()
        self.emit()

    def assign(self, msg: dict[str, Any]) -> None:
        sid = valid_id(msg.get("session_id"))
        if not sid:
            return
        for p in self.projects:
            if sid in p["sessions"]:
                p["sessions"].remove(sid)
        project = self.find(msg.get("id"))
        if project is not None:
            project["sessions"] = [*project["sessions"], sid][-MAX_SESSIONS:]
        self._save()
        self.emit()

    # ── what goes to Claude ──

    def note(self, session_id: str) -> tuple[str, str, list[str]] | None:
        """(project id, the note, the files it carries) for a request in this conversation."""
        hub = self.hub
        if getattr(hub, "incognito", False):
            return None
        if session_id:
            # Its own project's; one outside any, carried on while a project is open, stays out.
            project = self.project_of(session_id)
        else:  # a new conversation: the open project's
            project = self.find(self.active)
        if project is None:
            return None
        parts = [f"This conversation is in the owner's project “{project['name']}”."]
        if project["instructions"].strip():
            parts.append(f"The owner's instructions for this project:\n{project['instructions']}")
        sent = self.sent.get(session_id, set()) if session_id else set()
        # Only the files that go are read: this runs on every request, and once each file
        # has gone with one, none is.
        where: dict[str, list[int]] = {}
        for index, f in enumerate(project["files"]):
            where.setdefault(f["name"], []).append(index)
        carried: list[str] = []
        room = NOTE_CHARS
        for f in project["files"]:
            if f["name"] in sent:
                continue
            whole = self._file_text(project["id"], where[f["name"]])
            if whole is None:
                continue
            text = whole[:room]
            if not text:
                break
            parts.append(f"Project file “{f['name']}”:\n<file>\n{text}\n</file>")
            carried.append(f["name"])
            room -= len(text)
        others = [f["name"] for f in project["files"] if f["name"] in sent]
        if others:
            parts.append(
                "The project's other files were given earlier in this conversation: "
                + ", ".join(others)
                + "."
            )
        return project["id"], "\n\n".join(parts), carried

    async def context(self, _text: str, display: str | None) -> dict[str, Any] | None:
        if display is not None:  # words someone else sent on, not the owner asking
            return None
        found = self.note(getattr(self.hub, "_session_id", ""))
        if found is None:
            self._pending = None
            return None
        pid, note, carried = found
        self._pending = (pid, carried)
        return {"note": note}

    def turn_done(self, _event: dict[str, Any]) -> None:
        """After a turn in a project: the conversation is the project's, and has its files."""
        pending, self._pending = self._pending, None
        sid = valid_id(getattr(self.hub, "_session_id", ""))
        if pending is None or not sid or getattr(self.hub, "incognito", False):
            return
        pid, carried = pending
        project = self.find(pid)
        if project is None:
            return
        self.sent.setdefault(sid, set()).update(carried)
        if self.project_of(sid) is None:
            project["sessions"] = [*project["sessions"], sid][-MAX_SESSIONS:]
            self._save()
            self.emit()

    def install(self) -> None:
        hub = self.hub
        hub.chat_projects = self
        hub.register_command("chat_projects", self.emit)
        hub.register_command("chat_project_save", self.save)
        hub.register_command("chat_project_delete", self.delete)
        hub.register_command("chat_project_use", self.use, slow=True)
        hub.register_command("chat_project_file", self.window_file, slow=True)
        hub.register_command("chat_project_unfile", self.remove_file)
        hub.register_command("chat_project_assign", self.assign)
        hub.add_request_context(self.context)
        hub.add_event_sink(("turn_done",), self.turn_done)


def install(hub: Any) -> None:
    ChatProjects(hub).install()
