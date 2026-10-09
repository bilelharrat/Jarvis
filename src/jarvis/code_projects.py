"""Eden Code's projects beyond the projects folder, and the settings kept with them
(features.code_sessions): more folders of projects (roots), single folders opened one by one,
each project's own defaults for new sessions, saved prompts (snippets) and sidebar groups.

A project may be any folder in the home folder except ones too broad to be one: the home
folder itself, /, Desktop, Documents, Downloads and the other top folders of home, anything
in Library, and folders holding credentials (computer.is_sensitive). Those are refused with a
reason, the same as a session's own folder is (tasks.TaskManager.resolve_dir).
"""

from __future__ import annotations

import re
import tempfile
import time
from pathlib import Path
from typing import Any

from .computer import is_sensitive

ROOTS_MAX = 10
FOLDERS_MAX = 50
DEFAULTS_MAX = 100
SNIPPETS_MAX = 100
SNIPPET_TEXT = 8000
GROUPS_MAX = 30
# The home folder's own top folders: far more than a project (tasks._HOME_FOLDERS).
HOME_FOLDERS = (
    "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public",
    "Applications", "iCloud Drive", ".Trash",
    # (a PC's: the folders Windows adds to a home, and where its apps keep their data)
    "Videos", "AppData", "OneDrive", "Favorites", "Links", "Contacts", "Saved Games", "Searches",
)  # fmt: skip
MODES = ("plan", "ask", "edits", "smart", "auto")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
SNIPPET_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
MODEL_REF = re.compile(r"[\w.:\-/@]{1,200}")
# Per-project settings other features may add (auto-verify, say): key -> its clean().
EXTRA_DEFAULTS: dict[str, Any] = {}


def in_app_data(home: Path, path: Path) -> bool:
    """Inside the home's AppData (a PC's Library: its programs' settings and caches), apart from the temp
    folder, where a scratch project may well be."""
    if (home / "AppData") not in path.parents:
        return False
    try:
        temp = Path(tempfile.gettempdir()).resolve()
    except OSError:
        return False
    return not (path == temp or temp in path.parents)


def folder_problem(
    raw: Any, home: Path | None = None, *, must_exist: bool = True
) -> tuple[Path | None, str]:
    """(the folder, "") when it may be a project or a folder of projects; (None, why) when
    it can't. must_exist False: only where it is counts (a folder kept in Settings that's
    gone for now, on a disk that isn't there, stays kept)."""
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw or len(raw) > 1000:
        return None, "That isn't a folder."
    if not (raw.strip().startswith("~") or Path(raw.strip()).is_absolute()):
        return None, "Pick a folder in your home folder."  # a whole path, never a relative one
    home = (home or Path.home()).resolve()
    try:
        path = Path(raw.strip()).expanduser().resolve()
    except (OSError, RuntimeError):
        return None, "That folder can't be found."
    broad = {home, Path("/"), Path(path.anchor)} | {home / n for n in HOME_FOLDERS}
    if path in broad:
        return (
            None,
            f"{path.name or path.anchor or '/'} is too broad for a project: pick a folder inside it.",
        )
    if home not in path.parents:
        return None, "Pick a folder in your home folder."
    # (~/.ssh itself isn't a credential, but everything in it is.)
    if (
        (home / "Library") in path.parents
        or in_app_data(home, path)
        or is_sensitive(path)
        or is_sensitive(path / "_")
    ):
        return None, "That folder holds private settings or keys, so it can't be a project."
    if must_exist:
        try:
            if not path.is_dir():
                return None, "That isn't a folder."
        except OSError:
            return None, "That folder can't be looked at just now."
    return path, ""


def clean_folders(limit: int):
    """A feature-pref check: a list of folder paths that may be projects (see folder_problem),
    each once."""

    def clean(value: Any) -> list[str] | None:
        if not isinstance(value, list):
            return None
        kept: list[str] = []
        for item in value[: limit * 2]:
            path, _why = folder_problem(item, must_exist=False)
            if path is not None and str(path) not in kept:
                kept.append(str(path))
        return kept[:limit]

    return clean


def clean_defaults(value: Any) -> dict[str, dict[str, Any]] | None:
    """{project path: {mode, model, effort, ultracode, ...}}: only what's set, each checked."""
    if not isinstance(value, dict):
        return None
    kept: dict[str, dict[str, Any]] = {}
    for path, fields in list(value.items())[:DEFAULTS_MAX]:
        if not isinstance(path, str) or not path.startswith("/") or not isinstance(fields, dict):
            continue
        own: dict[str, Any] = {}
        if fields.get("mode") in MODES:
            own["mode"] = fields["mode"]
        if isinstance(fields.get("model"), str) and MODEL_REF.fullmatch(fields["model"]):
            own["model"] = fields["model"]
        if fields.get("effort") in EFFORTS:
            own["effort"] = fields["effort"]
        if isinstance(fields.get("ultracode"), bool):
            own["ultracode"] = fields["ultracode"]
        for key, check in EXTRA_DEFAULTS.items():
            if key in fields:
                try:
                    cleaned = check(fields[key])
                except Exception:
                    cleaned = None
                if cleaned is not None:
                    own[key] = cleaned
        if own:
            kept[path[:1000]] = own
    return kept


def clean_snippets(value: Any) -> list[dict[str, str]] | None:
    """[{name, text}]: names as a slash command types them (letters, digits, dashes), each
    once; the text as saved, up to 8,000 characters."""
    if not isinstance(value, list):
        return None
    kept: list[dict[str, str]] = []
    names: set[str] = set()
    for item in value[: SNIPPETS_MAX * 2]:
        if not isinstance(item, dict):
            continue
        name, text = item.get("name"), item.get("text")
        if not isinstance(name, str) or not isinstance(text, str) or not text.strip():
            continue
        name = name.strip().lower()
        if not SNIPPET_NAME.fullmatch(name) or name in names:
            continue
        names.add(name)
        kept.append({"name": name, "text": text[:SNIPPET_TEXT]})
    return kept[:SNIPPETS_MAX]


def clean_groups(value: Any) -> list[str] | None:
    """Sidebar groups: names of up to 40 characters, each once."""
    if not isinstance(value, list):
        return None
    kept: list[str] = []
    for item in value[: GROUPS_MAX * 2]:
        name = " ".join(item.split())[:40] if isinstance(item, str) else ""
        if name and name.lower() not in {k.lower() for k in kept}:
            kept.append(name)
    return kept[:GROUPS_MAX]


class Projects:
    """The projects Settings adds, for TaskManager.more_projects: ({name: path}, [roots]).
    A folder named like a project already on the list is left off it (the sidebar knows a
    project by its name): hidden() says which. Folders are listed at most once a few seconds,
    however often the list is asked for."""

    TTL = 3.0

    def __init__(self, settings: Any, prefs: Any) -> None:
        self.settings = settings
        self.prefs = prefs  # () -> the current Prefs
        self._cache: tuple[float, tuple, tuple[dict[str, Path], list[Path], list[str]]] | None
        self._cache = None

    def roots(self) -> list[Path]:
        return self._paths("code_project_roots")

    def folders(self) -> list[Path]:
        return self._paths("code_project_folders")

    def _paths(self, key: str) -> list[Path]:
        value = self.prefs().feature(key)
        return [Path(p) for p in value if isinstance(p, str)] if isinstance(value, list) else []

    def more(self) -> tuple[dict[str, Path], list[Path]]:
        found = self._listing()
        return found[0], found[1]

    def hidden(self) -> list[str]:
        """Folders left off the list: another project has their name."""
        return self._listing()[2]

    def forget(self) -> None:
        self._cache = None

    def _listing(self) -> tuple[dict[str, Path], list[Path], list[str]]:
        roots, folders = self.roots(), self.folders()
        stamp = (tuple(roots), tuple(folders), str(self.settings.projects_dir))
        now = time.monotonic()
        if self._cache is not None and self._cache[1] == stamp and now - self._cache[0] < self.TTL:
            return self._cache[2]
        main = self.settings.projects_dir
        taken = set(_children(main))
        names: dict[str, Path] = {}
        hidden: list[str] = []
        live_roots: list[Path] = []
        for root in roots:
            if not _is_dir(root) or root == main:
                continue
            live_roots.append(root)
            for name, path in _children(root).items():
                if name in taken or name in names:
                    hidden.append(str(path))
                else:
                    names[name] = path
        for folder in folders:
            if not _is_dir(folder):
                continue
            if folder.parent == main or any(folder == p for p in names.values()):
                continue  # already on the list, as itself
            if folder.name in taken or folder.name in names:
                hidden.append(str(folder))
            else:
                names[folder.name] = folder
        found = (names, live_roots, hidden)
        self._cache = (now, stamp, found)
        return found

    def defaults(self, path: Path) -> dict[str, Any]:
        value = self.prefs().feature("code_project_defaults")
        own = value.get(str(path)) if isinstance(value, dict) else None
        return dict(own) if isinstance(own, dict) else {}


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _children(root: Path) -> dict[str, Path]:
    """A folder's folders (not hidden ones), by name; none when it can't be read."""
    try:
        return {
            p.name: p for p in sorted(root.iterdir()) if not p.name.startswith(".") and _is_dir(p)
        }
    except OSError:
        return {}
