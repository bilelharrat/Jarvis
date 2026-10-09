"""Local-only folders: the owner marks folders as private (student records, grades, a medical
file, confidential reviews), and nothing in them is ever read into a request to Claude.

The list is the setting private_folders (prefs.features, kept by features/private_mode.py) and a
copy of it in private_folders.json beside the app's data, so the helpers that run as programs of
their own (the second brain's rebuild, the file index) keep the same folders out.

Every reader that gives Claude a file's words asks here first: read_file and find_files
(computer.py), read_document (documents.py), the readers under them (knowledge.read_document,
pictures and scanned pages), the second brain and the file index, files attached to an email
or a text, Eden's file tools, Eden Code sessions, the reports' read_file and the teaching
tools. A file in a private folder is refused with refusal(path), which tells Claude why, so it
can tell the owner instead of trying another way.

A folder is private with everything under it, links followed (a shortcut into a private folder
is private too). Names are compared without regard to case, as Windows and macOS do.

Claude cost policy: no model call; this only says no.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import osplat

log = logging.getLogger("jarvis")

PATH = osplat.app_support() / "private_folders.json"  # the copy the helper programs read
MAX_FOLDERS = 50
SETTING = "private_folders"

_source: Callable[[], Any] | None = None  # the app's own setting, once the feature is installed
_resolved: tuple[tuple[str, ...], list[str]] = ((), [])  # (the raw list, its folders as compared)
_file_seen: tuple[float, list[str]] | None = None  # (the copy's mtime, its raw list)


class PrivateError(ValueError):
    """A file in a private folder; its message is refusal()'s."""


def configure(source: Callable[[], Any] | None) -> None:
    """Where the list comes from in the app: the setting (None: the copy on disk)."""
    global _source
    _source = source


def clean(value: Any) -> list[str] | None:
    """The setting as kept: whole paths, each once, at most MAX_FOLDERS; None for anything else."""
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or len(item) > 1000:
            return None
        text = str(Path(item.strip()).expanduser())
        if not Path(text).is_absolute():
            return None
        if text not in out:
            out.append(text)
    return out[:MAX_FOLDERS]


def _key(path: str) -> str:
    """A path as compared: Windows' own spelling, without regard to case."""
    return os.path.normcase(os.path.normpath(path)).casefold()


def _real(raw: str) -> str:
    try:
        return str(Path(raw).expanduser().resolve())
    except (OSError, RuntimeError, ValueError):
        return str(Path(raw).expanduser())


def _from_file() -> list[str]:
    """The copy on disk (read again only when it changed)."""
    global _file_seen
    try:
        mtime = PATH.stat().st_mtime
    except OSError:
        _file_seen = None
        return []
    if _file_seen is not None and _file_seen[0] == mtime:
        return _file_seen[1]
    try:
        data = json.loads(PATH.read_text(encoding="utf-8"))
        found = clean(data.get("folders") if isinstance(data, dict) else None) or []
    except (OSError, ValueError):
        log.info("private folders: the copy couldn't be read; keeping what was read before")
        return _file_seen[1] if _file_seen is not None else []
    _file_seen = (mtime, found)
    return found


def raw_list() -> list[str]:
    """The private folders as the owner gave them."""
    if _source is not None:
        try:
            return clean(_source()) or []
        except Exception:  # noqa: BLE001 - a setting that can't be read: the copy on disk still holds
            log.info("private folders: the setting couldn't be read", exc_info=True)
    return _from_file()


def folders() -> list[str]:
    """The private folders, links followed, as compared."""
    global _resolved
    raw = tuple(raw_list())
    if raw != _resolved[0]:
        _resolved = (raw, [_key(_real(r)) for r in raw])
    return _resolved[1]


def folder_of(path: Path | str, follow: bool = True) -> str:
    """The private folder a path is in (as the owner gave it), or "" when it is in none.
    follow False takes the path as it is spelled, without following links (for a walk that
    sees each of a hundred thousand files, and checks links itself)."""
    keys = folders()
    if not keys:
        return ""
    raw = str(path)
    if not raw:
        return ""
    candidates = {_key(str(Path(raw).expanduser()))}
    if follow:
        candidates.add(_key(_real(raw)))
    for given, key in zip(_resolved[0], keys, strict=False):
        for c in candidates:
            if c == key or c.startswith(key.rstrip(os.sep) + os.sep):
                return given
    return ""


def is_private(path: Path | str, follow: bool = True) -> bool:
    return bool(folder_of(path, follow))


def refusal(path: Path | str) -> str:
    """Why a file isn't read, for Claude to pass on (in words the owner can act on)."""
    name = Path(str(path)).name or str(path)
    where = folder_of(path) or "a private folder"
    return (
        f"{name} is in {where}, a folder the owner marked private (local only): nothing in it is "
        "ever read into a request to Claude, so I can't read, summarise, index, search or send "
        "it. Tell the owner that plainly, and don't try another way to get at it. They can open "
        "it themselves, or take the folder off the private list (Settings, Privacy, or say "
        "'stop keeping this folder private')."
    )


def check(path: Path | str) -> None:
    """PrivateError (refusal's words) for a file in a private folder."""
    if is_private(path):
        raise PrivateError(refusal(path))


def mentioned_in(text: str) -> str:
    """The private folder a command or a piece of text names, or "" (a shell command that reads
    a private file by its path)."""
    if not text:
        return ""
    low = text.casefold().replace("\\", "/")
    for given in raw_list():
        for form in {given, _real(given)}:
            spelled = form.casefold().replace("\\", "/").rstrip("/")
            if spelled and spelled in low:
                return given
            home = str(Path.home()).casefold().replace("\\", "/")
            if spelled.startswith(home + "/") and ("~" + spelled[len(home) :]) in low:
                return given
    return ""


def save_copy(values: list[str]) -> None:
    """Keep the copy the helper programs read (written whole, readable by the owner alone)."""
    from . import jsonstore

    try:
        jsonstore.save_json(PATH, {"folders": clean(values) or []}, backup=False)
    except OSError as exc:
        log.warning("private folders: couldn't keep the copy (%s)", exc)
