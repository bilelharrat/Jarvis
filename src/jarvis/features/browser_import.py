"""Bookmarks and history from the owner's other browsers, for the built-in one.

- Chrome, Arc, Brave and Edge: their profile's Bookmarks JSON, and its History database,
  copied first (the browser holds it open while it runs).
- Safari: Bookmarks.plist and History.db. macOS guards both: without Full Disk Access for
  J.A.R.V.I.S. the read is refused, and the window says how to allow it.

Read only when the owner presses Import in Settings › Browser, never on its own. Nothing
leaves the Mac and no model sees it (no Claude cost). The window hands the result to the app
(app/browser-parity.js), which files the bookmarks under "Imported from …" and merges the
history into the built-in browser's own.

Window commands and the events they answer with:
- {"type": "browser_import_sources"} → browser_import_sources {sources: [{id, name, found}]}
- {"type": "browser_import", "browser": id} → browser_import {browser, name, ok, bookmarks:
  [{url, title, folder}], history: [{url, title, at (ms), visits}], error}. error is
  "not_found", "full_disk_access", "unreadable" or "unknown".
"""

from __future__ import annotations

import asyncio
import json
import logging
import plistlib
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

BOOKMARKS_MAX = 5000
HISTORY_MAX = 2000  # the built-in browser keeps this many visits
URL_MAX = 4000
TITLE_MAX = 300
DEPTH_MAX = 20  # folders in folders

# Chromium browsers: their name and where their profiles live, under the home folder.
CHROMIUM = {
    "chrome": ("Chrome", "Library/Application Support/Google/Chrome"),
    "arc": ("Arc", "Library/Application Support/Arc/User Data"),
    "brave": ("Brave", "Library/Application Support/BraveSoftware/Brave-Browser"),
    "edge": ("Edge", "Library/Application Support/Microsoft Edge"),
}
SAFARI = "Library/Safari"
NAMES = {**{key: name for key, (name, _) in CHROMIUM.items()}, "safari": "Safari"}

WEBKIT_EPOCH_MS = 11_644_473_600_000  # 1601-01-01 to 1970-01-01: Chromium's visit times
CORE_DATA_EPOCH_S = 978_307_200  # 2001-01-01: Safari's


def home() -> Path:
    """The owner's home folder (tests point this at a temp one)."""
    return Path.home()


def _web(url: Any) -> bool:
    return isinstance(url, str) and url.startswith(("http://", "https://")) and len(url) <= URL_MAX


def _name(text: Any) -> str:
    """A folder's name as one step of a path ("Work/Reading"): no slashes of its own."""
    return " ".join(str(text or "").replace("/", "∕").split())[:60]


def _join(folder: str, name: str) -> str:
    return f"{folder}/{name}" if folder and name else folder or name


def profile(root: Path) -> Path | None:
    """A Chromium browser's main profile: Default, else its first other one."""
    try:
        if (root / "Default").is_dir():
            return root / "Default"
        others = sorted(p for p in root.glob("Profile *") if p.is_dir())
    except OSError:
        return None
    return others[0] if others else None


def chromium_bookmarks(path: Path) -> list[dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    roots = data.get("roots") if isinstance(data, dict) else None
    if not isinstance(roots, dict):
        return []
    out: list[dict[str, str]] = []

    def walk(node: Any, folder: str, depth: int) -> None:
        if len(out) >= BOOKMARKS_MAX or depth > DEPTH_MAX or not isinstance(node, dict):
            return
        if node.get("type") == "url":
            url = node.get("url")
            if _web(url):
                title = " ".join(str(node.get("name") or "").split())[:TITLE_MAX] or url
                out.append({"url": url, "title": title, "folder": folder})
            return
        for child in node.get("children") or []:
            walk(child, _join(folder, _name(node.get("name"))) if depth else folder, depth + 1)

    shelves = {"bookmark_bar": "Bookmarks bar", "other": "Other bookmarks", "synced": "Mobile"}
    for key, shelf in shelves.items():
        node = roots.get(key)
        if isinstance(node, dict):
            for child in node.get("children") or []:
                walk(child, shelf, 1)
    return out


def _copy_db(path: Path, folder: Path) -> Path:
    """A browser's database, copied with its journal (the browser has it open)."""
    copy = folder / path.name
    shutil.copy2(path, copy)
    for extra in ("-wal", "-shm", "-journal"):
        side = path.with_name(path.name + extra)
        if side.exists():
            shutil.copy2(side, folder / side.name)
    return copy


def _rows(path: Path, query: str) -> list[tuple]:
    with tempfile.TemporaryDirectory() as folder:
        con = sqlite3.connect(_copy_db(path, Path(folder)))
        try:
            return con.execute(query, (HISTORY_MAX * 2,)).fetchall()
        finally:
            con.close()


def _history(rows: list[tuple], to_ms) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for url, title, visits, last in rows:
        if not _web(url) or not isinstance(last, (int, float)) or last <= 0:
            continue
        at = to_ms(last)
        if at <= 0:
            continue
        visits = int(visits) if isinstance(visits, int) and visits > 0 else 1
        out.append({"url": url, "title": str(title or "")[:TITLE_MAX], "at": at, "visits": visits})
        if len(out) >= HISTORY_MAX:
            break
    return out


def chromium_history(path: Path) -> list[dict[str, Any]]:
    rows = _rows(
        path,
        "SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 "
        "ORDER BY last_visit_time DESC LIMIT ?",
    )
    return _history(rows, lambda t: int(t) // 1000 - WEBKIT_EPOCH_MS)


def safari_bookmarks(path: Path) -> list[dict[str, str]]:
    with path.open("rb") as fh:
        data = plistlib.load(fh)
    shelves = {
        "BookmarksBar": "Favorites",
        "BookmarksMenu": "Bookmarks Menu",
        "com.apple.ReadingList": "Reading List",
    }
    out: list[dict[str, str]] = []

    def walk(node: Any, folder: str, depth: int) -> None:
        if len(out) >= BOOKMARKS_MAX or depth > DEPTH_MAX or not isinstance(node, dict):
            return
        kind = node.get("WebBookmarkType")
        if kind == "WebBookmarkTypeLeaf":
            url = node.get("URLString")
            about = node.get("URIDictionary")
            title = about.get("title") if isinstance(about, dict) else ""
            if _web(url):
                title = " ".join(str(title or "").split())[:TITLE_MAX] or url
                out.append({"url": url, "title": title, "folder": folder})
        elif kind == "WebBookmarkTypeList":
            title = str(node.get("Title") or "")
            here = _join(folder, _name(shelves.get(title, title))) if depth else folder
            for child in node.get("Children") or []:
                walk(child, here, depth + 1)

    walk(data, "", 0)
    return out


def safari_history(path: Path) -> list[dict[str, Any]]:
    rows = _rows(
        path,
        "SELECT i.url, (SELECT v.title FROM history_visits v WHERE v.history_item = i.id "
        "ORDER BY v.visit_time DESC LIMIT 1), i.visit_count, MAX(v2.visit_time) AS last "
        "FROM history_items i JOIN history_visits v2 ON v2.history_item = i.id "
        "GROUP BY i.id ORDER BY last DESC LIMIT ?",
    )
    return _history(rows, lambda t: int((float(t) + CORE_DATA_EPOCH_S) * 1000))


def read_browser(browser: str, where: Path) -> dict[str, Any]:
    """One browser's bookmarks and history, or why they can't be read."""
    if browser in CHROMIUM:
        found = profile(where / CHROMIUM[browser][1])
        if found is None:
            return {"ok": False, "error": "not_found"}
        files = (found / "Bookmarks", chromium_bookmarks), (found / "History", chromium_history)
    elif browser == "safari":
        root = where / SAFARI
        files = (root / "Bookmarks.plist", safari_bookmarks), (root / "History.db", safari_history)
    else:
        return {"ok": False, "error": "unknown"}
    got: dict[str, list] = {"bookmarks": [], "history": []}
    missing = failed = 0
    for (path, read), key in zip(files, ("bookmarks", "history"), strict=True):
        try:
            got[key] = read(path)
        except FileNotFoundError:
            missing += 1
        except PermissionError:
            # macOS guards Safari's folder (and a file the owner locked): Full Disk Access.
            return {"ok": False, "error": "full_disk_access"}
        except (OSError, ValueError, sqlite3.Error, plistlib.InvalidFileException):
            log.warning("browser import: %s's %s couldn't be read", browser, path.name)
            failed += 1
    if missing == 2:
        return {"ok": False, "error": "not_found"}
    if failed and not (got["bookmarks"] or got["history"]):
        return {"ok": False, "error": "unreadable"}
    return {"ok": True, **got}


def sources(where: Path) -> list[dict[str, Any]]:
    """The browsers there's something to import from on this Mac."""
    out = [
        {"id": key, "name": name, "found": profile(where / rel) is not None}
        for key, (name, rel) in CHROMIUM.items()
    ]
    try:
        safari = (where / SAFARI).exists()
    except OSError:  # the folder is there, guarded
        safari = True
    out.append({"id": "safari", "name": "Safari", "found": safari})
    return out


class Importer:
    """The window's import commands: each read runs in a thread, off the hub's loop, and the
    window's next command never waits for it."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._tasks: set[asyncio.Task] = set()

    def _spawn(self, work) -> None:
        task = asyncio.get_running_loop().create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def cmd_sources(self, _msg: dict[str, Any]) -> None:
        self._spawn(self._sources())

    async def _sources(self) -> None:
        found = await asyncio.to_thread(sources, home())
        self.hub.emit("browser_import_sources", sources=found)

    def cmd_import(self, msg: dict[str, Any]) -> None:
        browser = str(msg.get("browser") or "")
        if browser not in NAMES:
            self.hub.emit("browser_import", browser=browser, name="", ok=False, error="unknown")
            return
        self._spawn(self._import(browser))

    async def _import(self, browser: str) -> None:
        try:
            result = await asyncio.to_thread(read_browser, browser, home())
        except Exception:  # anything unforeseen in another app's files: that import only
            log.exception("browser import from %s failed", browser)
            result = {"ok": False, "error": "unreadable"}
        self.hub.emit("browser_import", browser=browser, name=NAMES[browser], **result)


def install(hub: Any) -> None:
    importer = Importer(hub)
    hub.register_command("browser_import_sources", importer.cmd_sources)
    hub.register_command("browser_import", importer.cmd_import)
