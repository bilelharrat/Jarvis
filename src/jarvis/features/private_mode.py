"""Local-only mode for confidential material: "keep my Grades folder private". The owner marks
folders as private, and nothing in them is ever read into a request to Claude by any tool (the
readers ask private_folders.py, which says why they refuse).

Setting (prefs.features): private_folders, the list of folders (whole paths). It changes by voice
(the tools below) or from Settings › Privacy (web/features/private-folders.js sends
feature_prefs). Its copy beside the app's data (private_folders.json) is kept in step, for the
helper programs (the second brain's rebuild, the file index) that read it there.

Tools (server "private"): keep_folder_private, stop_keeping_private, private_folders. Making a
folder private needs no card (it only takes away); taking one off the list asks first, with a
card, whatever words asked for it, since that lets its files be read again. After either the
second brain is rebuilt, so what it held from that folder goes (until then its search already
leaves those notes out).

Claude cost policy: no model call; these are tools of the ordinary conversation.
"""

from __future__ import annotations

import logging
import weakref
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import private_folders
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

register_feature_pref(private_folders.SETTING, [], private_folders.clean)

PROMPT = (
    "\n- Private folders (local only): the owner can mark folders as private "
    "(keep_folder_private), and nothing in them is ever read into a request to you: file "
    "readers, document readers, the second brain, the file index, email attachments and Eden "
    "Code all refuse them. When a tool says a file is in a private folder, tell the owner that "
    "plainly (the folder's name and that it is kept local), and never try another way to read "
    "it. private_folders lists them; stop_keeping_private takes one off after the owner says yes."
)
LABELS = {
    "keep_folder_private": "Kept a folder private",
    "stop_keeping_private": "Stopped keeping a folder private",
    "private_folders": "Listed the private folders",
}


def _text(words: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": words}]}
    if error:
        out["is_error"] = True
    return out


def folder_path(raw: Any) -> Path | None:
    """A folder the owner named: a whole path, or one under their home folder ("Documents/Grades",
    "~/Grades"). None when it isn't a folder on this computer."""
    text = str(raw or "").strip().strip("\"'")
    if not text or "\x00" in text or len(text) > 1000:
        return None
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = Path.home() / path
    try:
        path = path.resolve()
    except (OSError, RuntimeError):
        return None
    return path if path.is_dir() else None


class PrivateMode:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._copied: list[str] | None = None  # what the copy on disk was last made from

    def current(self) -> list[str]:
        """The setting now; the copy on disk is brought in step when it changed (from the window too)."""
        value = private_folders.clean(self.hub.prefs.feature(private_folders.SETTING)) or []
        if value != self._copied:
            self._copied = list(value)
            private_folders.save_copy(value)
        return value

    def _set(self, folders: list[str]) -> None:
        self.hub.set_feature_prefs({private_folders.SETTING: folders})
        self.changed()

    def changed(self, _event: Any = None) -> None:
        """The list may have changed (a tool, or Settings): the copy follows, and the second
        brain is rebuilt so what it held from a newly private folder goes."""
        before = self._copied
        now = self.current()
        if before is None or now == before:
            return
        rebuild = getattr(self.hub, "rebuild_brain", None)
        if callable(rebuild) and getattr(self.hub, "poll", False):
            self.hub._spawn(rebuild())

    def add(self, raw: Any) -> tuple[str, bool]:
        path = folder_path(raw)
        if path is None:
            return f"I can't find a folder at {raw}. Give its whole path, or say where it is.", True
        listed = self.current()
        if private_folders.is_private(path):
            return f"{path.name} is already kept private.", False
        if len(listed) >= private_folders.MAX_FOLDERS:
            return f"At most {private_folders.MAX_FOLDERS} folders can be private.", True
        self._set([*listed, str(path)])
        return (
            f"{path.name} is private now: nothing in it will be read, indexed, searched or "
            f"attached for Claude. {len(listed) + 1} private folder"
            f"{'s' if listed else ''} in all.",
            False,
        )

    async def remove(self, raw: Any) -> tuple[str, bool]:
        listed = self.current()
        wanted = str(raw or "").strip()
        path = folder_path(wanted)
        keys = {str(path)} if path is not None else set()
        keys.add(wanted)
        match = [f for f in listed if f in keys or Path(f).name.casefold() == wanted.casefold()]
        if not match:
            names = ", ".join(Path(f).name for f in listed) or "none"
            return f"That folder isn't on the private list. The private folders are: {names}.", True
        gone = match[0]
        gate = getattr(self.hub, "feature_gate", None)
        question = (
            f"Stop keeping {Path(gone).name} private? Its files could then be read for Claude."
        )
        if gate is not None and not await gate("stop_keeping_private", question):
            return "The owner said no: it stays private.", True
        self._set([f for f in listed if f != gone])
        return f"{Path(gone).name} isn't private any more.", False

    def listing(self) -> str:
        listed = self.current()
        if not listed:
            return "No folders are private. Say 'keep my Grades folder private' to make one local only."
        lines = [f"{len(listed)} private folder{'s' if len(listed) != 1 else ''} (local only):"]
        lines += [f"- {Path(f).name} ({f})" for f in listed]
        return "\n".join(lines)

    def build(self) -> Any:
        @tool(
            "keep_folder_private",
            "Mark a folder as private (local only): from now on nothing in it is read into a "
            "request to Claude by any tool, indexed by the second brain or the file index, "
            "attached to an email, or opened by Eden Code. folder: its whole path, or one under "
            "the home folder like Documents/Grades.",
            {
                "type": "object",
                "properties": {"folder": {"type": "string"}},
                "required": ["folder"],
            },
        )
        async def keep_folder_private(args):
            words, error = self.add(args.get("folder"))
            return _text(words, error)

        @tool(
            "stop_keeping_private",
            "Take a folder off the private list (the owner is asked first: its files could then "
            "be read again). folder: its path or its name.",
            {
                "type": "object",
                "properties": {"folder": {"type": "string"}},
                "required": ["folder"],
            },
        )
        async def stop_keeping_private(args):
            words, error = await self.remove(args.get("folder"))
            return _text(words, error)

        @tool("private_folders", "The folders the owner keeps private (local only).", {})
        async def private_folders_tool(_args):
            return _text(self.listing())

        return create_sdk_mcp_server(
            name="private",
            version="0.1.0",
            tools=[keep_folder_private, stop_keeping_private, private_folders_tool],
        )


def install(hub: Any) -> None:
    feature = PrivateMode(hub)
    hub.private_mode = feature
    # (held weakly: the module outlives this hub, and a hub nothing else holds must be freed)
    current = weakref.WeakMethod(feature.current)

    def source() -> Any:
        method = current()
        return method() if method is not None else private_folders._from_file()

    private_folders.configure(source)
    if hasattr(hub, "add_event_sink"):
        hub.add_event_sink(("prefs",), feature.changed)  # Settings › Privacy changed it
    hub.register_server(
        "private",
        feature.build,
        prompt=PROMPT,
        labels=LABELS,
        quiet=("keep_folder_private", "stop_keeping_private", "private_folders"),
    )
