"""Rename, pin and delete past conversations, as the Claude, ChatGPT and Gemini apps do (the
window's features/convo-manage.js puts the menu on each row of Conversations' list).

- Rename: Claude Code's own record gets the title (claude_agent_sdk.rename_session), and so
  does the app's (conversation.json), which the list prefers.
- Pin: kept here (conversation-pins.json beside prefs.json); the window puts pinned ones first.
- Delete: the conversation's record is removed for good (delete_session: its JSONL and its
  subagents' transcripts), and the app forgets it. Never the one going on now.
- Export: the conversation as Markdown in ~/Documents/Jarvis/Conversations, shown in Finder.

Window commands: conversation_rename {session_id, title}, conversation_pin {session_id,
pinned}, conversation_delete {session_id}, conversation_export {session_id}, conversation_marks {};
each but export answers with the event
conversation_marks {pins}, after which the window asks for the list again.

Claude cost policy: no model is called here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..conversation_state import title_line, valid_id

log = logging.getLogger("jarvis")

PINS_FILE = "conversation-pins.json"
MAX_PINS = 50


def _sdk() -> tuple[Callable[..., Any], Callable[..., Any]]:
    from claude_agent_sdk import delete_session, rename_session

    return rename_session, delete_session


class ConversationManage:
    def __init__(self, hub: Any, folder: Path | None = None, sdk: Any = None) -> None:
        from .. import jsonstore
        from ..prefs import APP_SUPPORT

        self.hub = hub
        self.path = (folder or APP_SUPPORT) / PINS_FILE
        self.sdk = sdk
        try:
            raw = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable:
            raw = []
        self.pins: list[str] = [p for p in (valid_id(x) for x in raw or []) if p][:MAX_PINS]

    def _functions(self) -> tuple[Callable[..., Any], Callable[..., Any]]:
        return self.sdk or _sdk()

    @staticmethod
    def _directory() -> str:
        from ..brain_sources import workspace

        return str(workspace())

    def _save_pins(self) -> None:
        from .. import jsonstore

        jsonstore.save_json(self.path, self.pins)

    def _state(self) -> Any:
        convo = getattr(self.hub, "conversation", None)
        return getattr(convo, "state", None)

    def marks(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("conversation_marks", pins=list(self.pins))

    async def rename(self, msg: dict[str, Any]) -> None:
        sid = valid_id(msg.get("session_id"))
        title = title_line(msg.get("title"))
        if not sid or not title:
            return
        rename_session, _delete = self._functions()
        try:
            await asyncio.to_thread(rename_session, sid, title, self._directory())
        except Exception as exc:  # a record Claude Code can't find: the app's title still changes
            log.warning("conversation: couldn't rename %s in Claude Code's record: %s", sid, exc)
        state = self._state()
        if state is not None:
            entry = state.sessions.setdefault(
                sid, {"reads": None, "cost": 0.0, "at": "", "title": ""}
            )
            entry["title"] = title
            await asyncio.to_thread(state.save, state.snapshot())
        self.marks()

    async def pin(self, msg: dict[str, Any]) -> None:
        sid = valid_id(msg.get("session_id"))
        if not sid:
            return
        self.pins = [p for p in self.pins if p != sid]
        if msg.get("pinned") is not False:
            self.pins.insert(0, sid)
            self.pins = self.pins[:MAX_PINS]
        await asyncio.to_thread(self._save_pins)
        self.marks()

    async def delete(self, msg: dict[str, Any]) -> None:
        hub = self.hub
        sid = valid_id(msg.get("session_id"))
        if not sid:
            return
        if sid == getattr(hub, "_session_id", ""):
            hub.emit(
                "toast",
                title="Conversations",
                text="That’s the conversation going on now. Start a new one first.",
            )
            return
        _rename, delete_session = self._functions()
        try:
            await asyncio.to_thread(delete_session, sid, self._directory())
        except Exception as exc:
            log.warning("conversation: couldn't delete %s: %s", sid, exc)
            hub.emit("toast", title="Conversations", text="That conversation couldn’t be deleted.")
            return
        state = self._state()
        if state is not None and sid in state.sessions:
            state.sessions.pop(sid, None)
            await asyncio.to_thread(state.save, state.snapshot())
        if sid in self.pins:
            self.pins.remove(sid)
            await asyncio.to_thread(self._save_pins)
        self.marks()

    async def export(self, msg: dict[str, Any]) -> Path | None:
        """The conversation as Markdown beside the current one's exports; its path."""
        from .. import conversation_past as past
        from ..hub import CONVERSATIONS_DIR

        hub = self.hub
        sid = valid_id(msg.get("session_id"))
        convo = getattr(hub, "conversation", None)
        if not sid or convo is None:
            return None
        entries = await asyncio.to_thread(past.entries, sid, None, get_messages=convo.get_messages)
        if not entries:
            hub.emit("toast", title="Conversations", text="That conversation couldn’t be read.")
            return None
        title = convo.state.titles().get(sid, "") or "Conversation"
        path = await asyncio.to_thread(write_markdown, CONVERSATIONS_DIR, title, entries)
        hub.emit("caption", text=f"Saved “{title}” to {path.name}.")
        with contextlib.suppress(Exception):
            from .. import mac_tools

            await mac_tools.run_command("open", "-R", str(path))
        return path

    def install(self) -> None:
        hub = self.hub
        hub.conversation_manage = self

        hub.register_command("conversation_marks", self.marks)
        hub.register_command("conversation_rename", self.rename, slow=True)
        hub.register_command("conversation_pin", self.pin)
        hub.register_command("conversation_delete", self.delete, slow=True)
        hub.register_command("conversation_export", self.export, slow=True)


def write_markdown(folder: Path, title: str, entries: list[dict[str, Any]]) -> Path:
    """A conversation's words as Markdown, named for its title (never over another file)."""
    folder.mkdir(parents=True, exist_ok=True)
    safe = "".join(c for c in title if c not in '/\\:*?"<>|').strip()[:80] or "Conversation"
    path = folder / f"{safe}.md"
    n = 2
    while path.exists():
        path = folder / f"{safe} ({n}).md"
        n += 1
    lines = [f"# {title}", ""]
    for entry in entries:
        who = "You" if entry.get("role") == "user" else "J.A.R.V.I.S."
        lines += [f"**{who}**", "", str(entry.get("text", "")).strip(), ""]
    path.write_text("\n".join(lines))
    return path


def install(hub: Any) -> None:
    if getattr(hub, "conversation", None) is None:  # the conversation feature is left out
        return
    ConversationManage(hub).install()
