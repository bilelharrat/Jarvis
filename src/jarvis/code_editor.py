"""Jarvis Code's editor: a project's files, read to be edited and written back.

- Only files inside the project, never a credentials file or private folder (by the name
  asked for or the one a link points to), and text only: UTF-8, no NULs.
- Each read says which version of the file it is (its size, modification time and a hash
  of its bytes). A save names the version it was edited from; if the file has changed on
  disk since (Claude edited it, another editor saved it), nothing is written and the save
  comes back as a conflict, with what's on disk now, until the owner chooses to overwrite.
- A save is atomic (a new file beside it, then renamed over it), keeps the file's mode, its
  line endings (CRLF stays CRLF) and writes through a link to the file it points to.
- Files too big to edit here open read-only, their first part only; ones that aren't
  UTF-8, or mix their line endings, open read-only too (a save would change their bytes).

"Open in": the editors on this Mac (VS Code, Cursor, Xcode, Zed) open a file, at its
line where the editor can be told one, or the whole project.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import stat
import tempfile
import time
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .computer import is_sensitive

EDIT_MAX = 1_000_000  # bytes: bigger files open read-only
VIEW_MAX = 300_000  # ... showing this much of them
SNIFF = 8000  # bytes looked at for a NUL (a binary file)


class EditorError(ValueError):
    """Why a file can't be opened or saved, in words for the owner."""


def locate(root: Path, rel: str) -> Path:
    """A project file, named from the project's folder: its real path. Raises EditorError
    for anything outside the project or private."""
    rel = str(rel or "").strip()
    if not rel or "\0" in rel or len(rel) > 1000:
        raise EditorError("No file named.")
    root = Path(root).resolve()
    asked = Path(rel)
    if asked.is_absolute():
        try:
            asked = asked.resolve().relative_to(root)
        except ValueError:
            raise EditorError("That's outside the project.") from None
    named = root / asked
    path = named.resolve()
    if root not in path.parents:
        raise EditorError("That's outside the project.")
    if is_sensitive(path) or is_sensitive(named):
        raise EditorError("That file holds credentials or private data.")
    return path


def git_internal(root: Path, path: Path) -> bool:
    """Inside the project's .git folder: git's own files, changed through git, not here."""
    try:
        return ".git" in path.relative_to(Path(root).resolve()).parts
    except ValueError:
        return False


def version_of(path: Path, data: bytes | None = None) -> dict[str, Any]:
    """Which version of a file this is: enough to tell it from any other."""
    st = path.stat()
    if data is None:
        data = path.read_bytes()
    return {"mtime_ns": st.st_mtime_ns, "size": st.st_size, "sha": hashlib.sha256(data).hexdigest()}


def same_version(path: Path, base: dict[str, Any]) -> bool:
    """Whether the file on disk is still the version the editor started from (a new
    modification time with the same bytes counts as the same)."""
    try:
        st = path.stat()
    except FileNotFoundError:
        return False
    if st.st_mtime_ns == base.get("mtime_ns") and st.st_size == base.get("size"):
        return True
    if st.st_size != base.get("size"):
        return False
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest() == base.get("sha")
    except OSError:
        return False


def _decode(raw: bytes) -> tuple[str, bool, bool, bool]:
    """(text with \\n line ends, whether the file used \\r\\n, whether it's UTF-8, whether
    its line ends are mixed: a lone \\r, or \\r\\n and \\n both, which a save can't keep)."""
    try:
        text, utf8 = raw.decode("utf-8"), True
    except UnicodeDecodeError:
        text, utf8 = raw.decode("utf-8", errors="replace"), False
    crlf = text.count("\r\n")
    mixed = text.count("\r") != crlf or (crlf > 0 and text.count("\n") != crlf)
    return (text.replace("\r\n", "\n") if crlf else text), crlf > 0, utf8, mixed


def read(root: Path, rel: str) -> dict[str, Any]:
    """A file to edit: {path, text, version, crlf, editable, why (when it isn't)}; or
    {path, error}."""
    try:
        path = locate(root, rel)
    except EditorError as exc:
        return {"path": rel, "error": str(exc)}
    if not path.exists():
        return {"path": rel, "error": "There's no such file.", "missing": True}
    if not path.is_file():
        return {"path": rel, "error": "Not a file."}
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            raw = f.read(EDIT_MAX + 1 if size <= EDIT_MAX else VIEW_MAX)
    except OSError as exc:
        return {"path": rel, "error": f"Couldn't read it: {exc.strerror or exc}"}
    if b"\0" in raw[:SNIFF]:
        return {"path": rel, "error": "That's a binary file."}
    text, crlf, utf8, mixed = _decode(raw)
    out: dict[str, Any] = {"path": rel, "text": text, "crlf": crlf, "editable": True}
    if size > EDIT_MAX or len(raw) > EDIT_MAX:
        out.update(editable=False, truncated=True, why="too_big")
    elif not utf8:
        out.update(editable=False, why="not_utf8")
    elif mixed:
        out.update(editable=False, why="line_endings")
    elif git_internal(root, path):
        out.update(editable=False, why="git")
    if out["editable"]:
        out["version"] = version_of(path, raw)
    return out


def stat_of(root: Path, rel: str) -> dict[str, Any]:
    """Whether a file has changed: {path, version} ({path, missing} once it's gone)."""
    try:
        path = locate(root, rel)
    except EditorError as exc:
        return {"path": rel, "error": str(exc)}
    try:
        return {"path": rel, "version": version_of(path)}
    except FileNotFoundError:
        return {"path": rel, "missing": True}
    except OSError as exc:
        return {"path": rel, "error": f"Couldn't read it: {exc.strerror or exc}"}


def save(
    root: Path,
    rel: str,
    text: str,
    base: dict[str, Any] | None,
    *,
    crlf: bool = False,
    force: bool = False,
    create: bool = False,
) -> dict[str, Any]:
    """Write the editor's text over the file, unless it changed on disk since the version
    `base` (None: the file didn't exist when opened). A conflict writes nothing and says
    what's there now, unless force. create: the file may be new (a CLAUDE.md)."""
    try:
        path = locate(root, rel)
    except EditorError as exc:
        return {"path": rel, "error": str(exc)}
    if not isinstance(text, str):
        return {"path": rel, "error": "Nothing to save."}
    if git_internal(root, path):
        return {"path": rel, "error": "That's one of git's own files: change it through git."}
    data = (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")
    if len(data) > EDIT_MAX * 2:
        return {"path": rel, "error": "That's too big to save from here."}
    exists = path.exists()
    if exists and not path.is_file():
        return {"path": rel, "error": "Not a file."}
    if base is None and not exists and not create:
        return {"path": rel, "error": "There's no such file."}
    if not force:
        # Opened as new, and made meanwhile; or opened, and changed or deleted since.
        if (base is None and exists) or (base is not None and not same_version(path, base)):
            return {"path": rel, "conflict": True, **disk_now(path)}
    try:
        write_atomic(path, data)
    except OSError as exc:
        return {"path": rel, "error": f"Couldn't save it: {exc.strerror or exc}"}
    return {"path": rel, "ok": True, "version": version_of(path, data)}


def disk_now(path: Path) -> dict[str, Any]:
    """What's on disk now, for a conflict: its version and, when it can be edited, text."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {"missing": True}
    except OSError:
        return {}
    out: dict[str, Any] = {"version": version_of(path, raw)}
    if len(raw) <= EDIT_MAX and b"\0" not in raw[:SNIFF]:
        text, crlf, utf8, mixed = _decode(raw)
        if utf8 and not mixed:
            out.update(disk_text=text, disk_crlf=crlf)
    return out


def write_atomic(path: Path, data: bytes) -> None:
    """The new bytes beside the file, flushed, then renamed over it: a crash mid-save
    never leaves half a file. The old file's mode stays."""
    mode = None
    with contextlib.suppress(FileNotFoundError):
        mode = stat.S_IMODE(path.stat().st_mode)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".jarvis", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode if mode is not None else 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ── Open in: the editors on this Mac ──

# (id, name, bundle ids, the app's usual names, its URL scheme for "open at a line")
EDITORS: list[tuple[str, str, tuple[str, ...], tuple[str, ...], str]] = [
    ("vscode", "VS Code", ("com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"),
     ("Visual Studio Code.app", "Visual Studio Code - Insiders.app"), "vscode"),
    ("cursor", "Cursor", ("com.todesktop.230313mzl4w4u92",), ("Cursor.app",), "cursor"),
    ("xcode", "Xcode", ("com.apple.dt.Xcode",), ("Xcode.app", "Xcode-beta.app"), ""),
    ("zed", "Zed", ("dev.zed.Zed", "dev.zed.Zed-Preview"), ("Zed.app", "Zed Preview.app"), ""),
]  # fmt: skip
EDITORS_FRESH = 600.0  # seconds the list of installed editors is kept


def _app_folders() -> list[Path]:
    return [Path("/Applications"), Path.home() / "Applications"]


def find_editors(
    folders: Callable[[], list[Path]] = _app_folders,
    spotlight: Callable[[tuple[str, ...]], bool] | None = None,
) -> list[dict[str, str]]:
    """The editors installed here: {id, name, bundle}, in a fixed order. Looked for where
    apps live, then (spotlight) by their bundle id anywhere else."""
    found = []
    places = folders()
    for editor_id, name, bundles, apps, _scheme in EDITORS:
        hit = None
        for app, bundle in zip(apps, bundles + bundles[-1:] * len(apps), strict=False):
            if any((place / app).is_dir() for place in places):
                hit = bundle  # (each usual name goes with the bundle id in its place)
                break
        if hit is None and spotlight is not None:
            hit = next((b for b in bundles if spotlight((b,))), None)
        if hit is not None:
            found.append({"id": editor_id, "name": name, "bundle": hit})
    return found


def spotlight_has(bundles: tuple[str, ...]) -> bool:
    """Whether Spotlight knows an app by one of these bundle ids (quick; False on doubt)."""
    import subprocess

    query = " || ".join(f"kMDItemCFBundleIdentifier == '{b}'" for b in bundles)
    try:
        out = subprocess.run(
            ["mdfind", query], capture_output=True, text=True, timeout=3, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.endswith(".app") for line in out.splitlines())


class Editors:
    """The installed editors, looked for at most every EDITORS_FRESH seconds."""

    def __init__(self, find: Callable[[], list[dict[str, str]]] | None = None) -> None:
        self.find = find or (lambda: find_editors(spotlight=spotlight_has))
        self._found: list[dict[str, str]] | None = None
        self._at = 0.0

    def list(self) -> list[dict[str, str]]:
        if self._found is None or time.monotonic() - self._at > EDITORS_FRESH:
            self._found, self._at = self.find(), time.monotonic()
        return list(self._found)

    def get(self, editor_id: str) -> dict[str, str] | None:
        return next((e for e in self.list() if e["id"] == editor_id), None)


def open_command(editor: dict[str, str], path: Path, line: int = 0) -> list[str]:
    """The command that opens a file (at a line, where the editor takes one) or a folder."""
    scheme = next((e[4] for e in EDITORS if e[0] == editor["id"]), "")
    if line > 0 and path.is_file():
        if scheme:
            url = f"{scheme}://file{urllib.parse.quote(str(path))}:{int(line)}:1"
            return ["open", url]
        if editor["id"] == "xcode" and shutil.which("xed"):
            return ["xed", "--line", str(int(line)), str(path)]
    return ["open", "-b", editor["bundle"], str(path)]
