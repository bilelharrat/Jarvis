"""Eden on this Mac's settings (jarvis.eden_files, eden_screen, eden_knowledge): what Eden and
other apps reaching Jarvis (jarvis.mcp_endpoint) may do with the owner's files and screen,
in Settings › Jarvis in other apps.

Settings (prefs.features):
- eden_files: other apps may search and read files (on; each app asks once on a card).
- eden_file_folders: only in these folders ([]: the home folder; never Library, caches,
  hidden files or keys either way).
- eden_screen_picture: "What's on my screen?" may send a picture of the window (off).

Window commands: eden_mac_state, eden_mac_set {files?, folders?, picture?} and
eden_knowledge_remove {id}, each answered with an "eden_mac" event: {files, folders: [{path,
display}], picture, screen_aware, knowledge: [{id, display, name, status, files, built_at,
error}]}. Removing a knowledge folder deletes Jarvis's index of it, never the files.
"""

from __future__ import annotations

from typing import Any

from .. import lang
from ..eden_files import (
    ASK_FILES,
    ASK_FILES_DETAIL,
    FILES_PREF,
    FOLDERS_PREF,
    clean_folders,
    display,
    roots_for,
)
from ..eden_knowledge import FOLDER, Knowledge
from ..eden_screen import ASK_SCREEN, ASK_SCREEN_DETAIL, PICTURE_PREF
from ..prefs import register_feature_pref

register_feature_pref(FILES_PREF, True)
register_feature_pref(FOLDERS_PREF, [], clean_folders)
register_feature_pref(PICTURE_PREF, False)

lang.add_texts(
    {
        ASK_FILES: "允许 {app} 搜索和读取你的文件吗？",
        ASK_FILES_DETAIL: "只读：它可以按名称和内容查找文件，并读取{where}中的文件。绝不包括资源库、隐藏文件、密钥或密码。它读到的内容会发给 {app} 以及它背后的模型。可在“设置 › 其他应用中的 Jarvis”中选择文件夹。",
        ASK_SCREEN: "允许 {app} 查看你的屏幕吗？",
        ASK_SCREEN_DETAIL: "仅此一次：最前面的应用、它窗口的标题和文字，以及你选中的内容{picture}。这些会发给 {app} 以及它背后的模型。",
        "Allow once": "允许一次",
    }
)


class EdenMac:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def knowledge(self) -> Knowledge:
        """The endpoint's own (its indexing in progress), else one reading the same list."""
        mcp = getattr(self.hub, "jarvis_mcp", None)
        endpoint = getattr(mcp, "endpoint", None)
        if endpoint is not None:
            from ..eden_knowledge import knowledge_for

            return knowledge_for(endpoint)
        return Knowledge(self.hub, self.hub.feature_path(FOLDER))

    def payload(self) -> dict[str, Any]:
        prefs = self.hub.prefs
        listed = prefs.feature(FOLDERS_PREF) or []
        return {
            "files": prefs.feature(FILES_PREF) is not False,
            "folders": [{"path": p, "display": display(p)} for p in listed],
            "home": not listed,
            "allowed": [display(r) for r in roots_for(prefs)],
            "picture": prefs.feature(PICTURE_PREF) is True,
            "screen_aware": bool(getattr(prefs, "screen_aware", False)),
            "knowledge": [
                {k: e.get(k) for k in ("id", "name", "status", "files", "built_at", "error")}
                | {"display": display(e.get("path") or "")}
                for e in self.knowledge().entries()
            ],
        }

    def publish(self) -> None:
        self.hub.emit("eden_mac", **self.payload())

    async def state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    async def set(self, msg: dict[str, Any]) -> None:
        changes: dict[str, Any] = {}
        if isinstance(msg.get("files"), bool):
            changes[FILES_PREF] = msg["files"]
        if isinstance(msg.get("picture"), bool):
            changes[PICTURE_PREF] = msg["picture"]
        if isinstance(msg.get("folders"), list):
            folders = clean_folders(msg["folders"])
            if folders is not None:
                if len(folders) < len([f for f in msg["folders"] if str(f).strip()]):
                    self.hub.emit(
                        "toast",
                        title="Eden on your Mac",
                        text="Some folders can't be used: only folders in your home folder, "
                        "not hidden ones, caches or ~/Library (iCloud Drive is fine).",
                    )
                changes[FOLDERS_PREF] = folders
        if changes:
            self.hub.set_feature_prefs(changes)
        self.publish()

    async def remove(self, msg: dict[str, Any]) -> None:
        ident = msg.get("id")
        if isinstance(ident, str) and ident:
            self.knowledge().remove(ident)
        self.publish()


def install(hub: Any) -> None:
    eden = EdenMac(hub)
    hub.register_command("eden_mac_state", eden.state)
    hub.register_command("eden_mac_set", eden.set)
    hub.register_command("eden_knowledge_remove", eden.remove)
