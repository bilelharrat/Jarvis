"""The owner's files moved, renamed and put in the Trash, each one undoable, and the clipboard
read and written (text only).

- Only inside the home folder (and iCloud Drive; on a PC also the folders Windows keeps for the
  person, wherever OneDrive or their school has put them), never a credentials file (computer's
  is_sensitive), never app data (Library, and the home's hidden settings folders and all
  that's in them), never the home's own folders themselves (Desktop, Documents…), never
  over a file that's already there. The disk ignores case and Unicode's two ways of writing
  an accent, so these are checked the same way (~/library is Library), both where a path
  says and where its links really lead. Nothing is ever deleted: "delete" moves it to the
  Trash (the Recycle Bin on a PC), the way Finder does, and remembers where it went.
- Every change is written to the undo log (a JSON file beside prefs.json: what went where,
  when), so undo() puts things back: the last one, or one by its id. The conversation
  track's general undo can call FileActions.undo() too.
- The clipboard: its text only. What a password manager marks as private on the clipboard
  (org.nspasteboard's concealed and transient types) is never read. What JARVIS writes
  there replaces the owner's copy, so the text it replaced is kept in memory (never on
  disk) for undo.
"""

from __future__ import annotations

import errno
import logging
import os
import shutil
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore, osplat
from .computer import SENSITIVE_PARTS, is_sensitive

log = logging.getLogger("jarvis")

KEEP = 100
KEEP_DAYS = 30
MAX_FILES = 50
# The home's own folders: things are moved into and out of them, never they themselves.
HOME_FOLDERS = frozenset(
    "Desktop Documents Downloads Library Pictures Movies Music Applications Public Sites .Trash".split()
)
# (a PC's own: the folders Windows adds in a home, and app data where a Mac has Library)
WINDOWS_HOME_FOLDERS = frozenset(
    ["Videos", "Favorites", "Links", "Contacts", "Searches", "AppData", "OneDrive", "iCloudDrive"]
    + ["Saved Games", "3D Objects"]
)
WINDOWS_APP_DATA = ("appdata", "application data", "local settings")
ICLOUD = Path("Library") / "Mobile Documents" / "com~apple~CloudDocs"
NAME_LIMIT = 255  # characters of a file's name the disk takes
# Characters a new name never has: controls (a NUL can't be on disk) and the ones that make
# text read in another order, so a card can't show "invoice<U+202E>fdp.exe" as "invoiceexe.pdf".
_NOT_IN_NAMES = frozenset("\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
PRIVATE_TYPES = ("org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType")
CLIPBOARD_LIMIT = 20_000


class Refused(ValueError):
    """What can't be done to this path, and why, in words for the owner."""


@dataclass
class Record:
    id: str
    kind: str  # move | rename | trash | clipboard
    at: str
    items: list[dict[str, str]] = field(default_factory=list)  # [{"from": …, "to": …}]
    undone: bool = False
    before: str = ""  # clipboard only: the text it replaced (never saved)


def trash_item(path: Path) -> Path:
    """Finder's Move to Trash, through NSFileManager (a PC: the Recycle Bin): where it went (so
    it can come back)."""
    if osplat.IS_WIN:
        from . import winfiles

        return winfiles.trash_item(path)
    from Foundation import NSURL, NSFileManager

    url = NSURL.fileURLWithPath_(str(path))
    ok, landed, error = NSFileManager.defaultManager().trashItemAtURL_resultingItemURL_error_(
        url, None, None
    )
    if not ok or landed is None:
        why = str(error.localizedDescription()) if error is not None else "it couldn't be moved"
        raise OSError(why)
    return Path(str(landed.path()))


def read_clipboard() -> str:
    """The clipboard's text; Refused when a password manager marked it private."""
    if osplat.IS_WIN:
        from . import winfiles

        return winfiles.read_clipboard(Refused)
    from AppKit import NSPasteboard, NSPasteboardTypeString

    board = NSPasteboard.generalPasteboard()
    kinds = [str(t) for t in (board.types() or [])]
    if any(t in kinds for t in PRIVATE_TYPES):
        raise Refused("The clipboard holds something a password manager marked private.")
    return str(board.stringForType_(NSPasteboardTypeString) or "")


def write_clipboard(text: str) -> None:
    if osplat.IS_WIN:
        from . import winfiles

        return winfiles.write_clipboard(text)
    from AppKit import NSPasteboard, NSPasteboardTypeString

    board = NSPasteboard.generalPasteboard()
    board.clearContents()
    board.setString_forType_(text, NSPasteboardTypeString)


def bin_name() -> str:
    return "Recycle Bin" if osplat.IS_WIN else "Trash"


def _plain_path(raw: str | Path) -> Path:
    """The path as given, made absolute, without following a symlink at its end (a link is
    moved as a link, never swapped for what it points to). A NUL can't be in a path on disk
    (the system calls raise on one), so a path with one is refused here, in words."""
    text = str(raw).strip()
    if "\x00" in text:
        raise Refused("That path has a character no file's path can have.")
    return Path(os.path.abspath(os.path.expanduser(text)))


def _fold(text: str) -> str:
    """A path as the disk compares it: case and the way an accent is written ignored (and a
    PC's backslashes read as slashes)."""
    text = unicodedata.normalize("NFD", text).casefold()
    return text.replace("\\", "/") if osplat.IS_WIN else text


_FOLDED_PARTS = tuple(_fold(part) for part in SENSITIVE_PARTS)
_FOLDED_HOME_FOLDERS = frozenset(_fold(name) for name in HOME_FOLDERS)
_FOLDED_WINDOWS_FOLDERS = frozenset(_fold(name) for name in WINDOWS_HOME_FOLDERS)
_FOLDED_ICLOUD = tuple(_fold(part) for part in ICLOUD.parts)


def _credentials(path: Path) -> bool:
    """A credentials file, or a folder that keeps them (~/.ssh, a copy of one elsewhere):
    what's inside it counts as credentials by its path, however its name is spelled."""
    if is_sensitive(path) or is_sensitive(path / "_"):
        return True
    text = _fold(str(path)) + "/"
    return any(part in text for part in _FOLDED_PARTS)


def _real(path: Path) -> Path:
    """Where the item itself really is: its folder with every link in it followed, and its own
    name (a link at the end is the link)."""
    return Path(os.path.realpath(path.parent)) / path.name


def _bad_name(name: str) -> bool:
    return len(name) > NAME_LIMIT or any(
        c in _NOT_IN_NAMES or unicodedata.category(c) == "Cc" for c in name
    )


class FileActions:
    def __init__(
        self,
        path: Path,
        home: Path | None = None,
        trash: Callable[[Path], Path] = trash_item,
        clock: Callable[[], datetime] = datetime.now,
        clipboard: tuple[Callable[[], str], Callable[[str], None]] = (
            read_clipboard,
            write_clipboard,
        ),
    ) -> None:
        self.path = path
        self.home = _plain_path(home or Path.home())
        # Where things may be moved: the home, and (a PC, the real home) the folders Windows keeps
        # for the person when they live elsewhere: OneDrive's, a school's network share.
        self.roots: list[Path] = [self.home]
        self.protected: set[str] = set()  # those folders themselves: moved into, never moved
        if osplat.IS_WIN and home is None:
            try:
                from . import winfiles

                places = [*winfiles.known_folders().values(), *winfiles.cloud_roots()]
            except OSError:
                places = []
            for place in places:
                place = _plain_path(place)
                self.protected.add(_fold(str(place)))
                if (
                    place != self.home
                    and self.home not in place.parents
                    and place not in self.roots
                ):
                    self.roots.append(place)
        self.trash_one = trash
        self.clock = clock
        self.read_clipboard, self.write_clipboard = clipboard
        self.records: list[Record] = []
        self.unreadable = ""
        self._load()

    # ── the log ──

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("file actions: %s can't be read; undo starts empty", self.path.name)
            return
        rows = data.get("records")
        for raw in rows if isinstance(rows, list) else []:
            record = _record_from(raw)
            if record is not None:
                self.records.append(record)
        self.records = self.records[-KEEP:]

    def _save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        cutoff = self.clock() - timedelta(days=KEEP_DAYS)
        kept = [r for r in self.records if r.kind != "clipboard" and _when(r.at) >= cutoff]
        jsonstore.save_json(
            self.path,
            {
                "records": [
                    {k: v for k, v in asdict(r).items() if k != "before"} for r in kept[-KEEP:]
                ]
            },
        )

    def _record(self, kind: str, items: list[dict[str, str]], before: str = "") -> Record:
        record = Record(
            id=uuid.uuid4().hex[:8],
            kind=kind,
            at=self.clock().isoformat(timespec="seconds"),
            items=items,
            before=before,
        )
        self.records.append(record)
        del self.records[:-KEEP]
        if kind != "clipboard":
            try:
                self._save()
            except OSError as exc:  # it's done; only its undo won't outlast a restart
                log.warning("file actions: couldn't save the undo log (%s)", exc)
        return record

    # ── what may be touched ──

    def _inside(self, path: Path) -> bool:
        return any(path != root and root in path.parents for root in self.roots)

    def _under_home(self, path: Path) -> tuple[str, ...] | None:
        """The path's parts below the home folder as the disk compares them (folded), or None
        when it isn't in there."""
        home, text = _fold(str(self.home)).rstrip("/"), _fold(str(path))
        if text == home:
            return ()
        if not text.startswith(home + "/"):
            return None
        return tuple(text[len(home) + 1 :].split("/"))

    def _home_folder(self, path: Path) -> bool:
        """One of the home's own folders (Desktop, Documents, Library…), or iCloud Drive."""
        if osplat.IS_WIN and _fold(str(path)) in self.protected:
            return True
        parts = self._under_home(path)
        if parts is None:
            return False
        names = (
            _FOLDED_HOME_FOLDERS | _FOLDED_WINDOWS_FOLDERS
            if osplat.IS_WIN
            else _FOLDED_HOME_FOLDERS
        )
        if len(parts) == 1 and osplat.IS_WIN and parts[0].startswith("onedrive"):
            return True  # "OneDrive - Springfield College" and the like
        return (len(parts) == 1 and parts[0] in names) or (
            not osplat.IS_WIN and parts == _FOLDED_ICLOUD
        )

    def _app_data(self, path: Path) -> bool:
        """Library (iCloud Drive aside), the home's hidden settings folders and files and all
        that's in them (~/.ssh, ~/.config, ~/.zshrc; the Trash aside), and credentials
        anywhere: by the path, by where its links lead, whatever its case."""
        for where in (path, _real(path)):
            parts = self._under_home(where)
            if parts:
                top = parts[0]
                if top.startswith(".") and top != ".trash":
                    return True
                if top == "library" and parts[1:3] != _FOLDED_ICLOUD[1:]:
                    return True
                if osplat.IS_WIN and (top in WINDOWS_APP_DATA or top.startswith("ntuser.")):
                    return True  # (a PC's app data, with the links Windows leaves to it)
            if _credentials(where):
                return True
        return _credentials(Path(os.path.realpath(path)))

    def check_item(self, raw: str | Path) -> Path:
        """A file or folder the owner has that JARVIS may move, rename or trash."""
        path = _plain_path(raw)
        name = path.name or str(raw)
        parent = _plain_path(path.parent.resolve())  # no way out of the home through a link
        if not self._inside(path) or not (parent in self.roots or self._inside(parent)):
            raise Refused(f"“{name}” isn't in your home folder; I only move things in there.")
        if self._home_folder(path) or self._home_folder(_real(path)):
            raise Refused(
                f"“{name}” is one of your home's own folders; I leave those where they are."
            )
        if self._app_data(path):
            raise Refused(f"“{name}” is app data or credentials; I won't touch it.")
        if not os.path.lexists(path):
            raise Refused(f"There's no “{name}” there.")
        return path

    def check_folder(self, raw: str | Path) -> Path:
        path = _plain_path(raw)
        real = Path(os.path.realpath(path))  # where what's moved really lands
        if not (path in self.roots or self._inside(path)) or any(
            self._app_data(p) for p in (path, real)
        ):
            raise Refused(f"“{path.name or raw}” isn't a folder in your home folder.")
        if not self._inside(real) and path not in self.roots:
            raise Refused(f"“{path.name or raw}” isn't a folder in your home folder.")
        if not path.is_dir():
            raise Refused(f"There's no folder “{path.name or raw}”.")
        return path

    # ── changes ──

    def plan_move(self, items: list[str], folder: str) -> list[tuple[Path, Path]]:
        """Each file and where it would go; Refused (with why) if any can't."""
        if not items:
            raise Refused("Say which files.")
        if len(items) > MAX_FILES:
            raise Refused(f"That's more than {MAX_FILES} files at once.")
        target = self.check_folder(folder)
        plan = []
        for raw in items:
            src = self.check_item(raw)
            dest = target / src.name
            if src.parent == target:
                raise Refused(f"“{src.name}” is already in {target.name}.")
            if src.is_dir() and not src.is_symlink() and (target == src or src in target.parents):
                raise Refused(f"“{src.name}” can't go inside itself.")
            if os.path.lexists(dest) or any(_fold(str(d)) == _fold(str(dest)) for _, d in plan):
                raise Refused(f"There's already a “{src.name}” in {target.name}.")
            plan.append((src, dest))
        return plan

    def move(self, plan: list[tuple[Path, Path]]) -> Record:
        """The plan carried out. Each place is looked at again first: a card can wait a
        minute, and whatever arrived there meanwhile is never replaced (nor moved into)."""
        done: list[dict[str, str]] = []
        try:
            for src, dest in plan:
                if os.path.lexists(dest):
                    raise FileExistsError(errno.EEXIST, f"there's now a “{dest.name}” there")
                shutil.move(str(src), str(dest))
                done.append({"from": str(src), "to": str(dest)})
        except OSError:
            if done:  # what did move can be put back, even though a later one failed
                self._record("move", done)
            raise
        return self._record("move", done)

    def plan_rename(self, item: str, new_name: str) -> tuple[Path, Path]:
        src = self.check_item(item)
        name = " ".join(str(new_name or "").split()).strip()
        if not name or "/" in name or name in (".", "..") or name.startswith(".") or ":" in name:
            raise Refused("Give a plain new name (no slashes, and not starting with a dot).")
        if osplat.IS_WIN and (why := _windows_name_problem(name)):
            raise Refused(f"Give a plain new name: {why}.")
        if not Path(name).suffix and src.suffix and not src.is_dir():
            name += src.suffix  # "rename it budget" keeps its .xlsx
        if _bad_name(name):
            raise Refused(
                f"Give a plain new name (at most {NAME_LIMIT} characters, and only ones that "
                "show as they are)."
            )
        dest = src.with_name(name)
        if str(dest) == str(
            src
        ):  # (not ==: a PC's paths ignore case, and notes to Notes is a rename)
            raise Refused(f"It's already called “{name}”.")
        if os.path.lexists(dest) and not _same_item(src, dest):  # "notes" to "Notes" is fine
            raise Refused(f"There's already a “{name}” there.")
        if _credentials(dest):
            raise Refused(f"“{name}” is a name for credentials; I won't give a file that name.")
        return src, dest

    def rename(self, src: Path, dest: Path) -> Record:
        if os.path.lexists(dest) and not _same_item(src, dest):  # arrived while it asked
            raise FileExistsError(errno.EEXIST, f"there's now a “{dest.name}” there")
        os.rename(src, dest)
        return self._record("rename", [{"from": str(src), "to": str(dest)}])

    def plan_trash(self, items: list[str]) -> list[Path]:
        if not items:
            raise Refused("Say which files.")
        if len(items) > MAX_FILES:
            raise Refused(f"That's more than {MAX_FILES} files at once.")
        paths, seen = [], set()
        for raw in items:
            path = self.check_item(raw)
            info = os.lstat(path)
            if (info.st_dev, info.st_ino) not in seen:  # one file, however it's spelled
                seen.add((info.st_dev, info.st_ino))
                paths.append(path)
        return paths

    def trash(self, paths: list[Path]) -> Record:
        done: list[dict[str, str]] = []
        try:
            for path in paths:
                landed = self.trash_one(path)
                done.append({"from": str(path), "to": str(landed)})
        except OSError:
            if done:  # what went can be taken back out, even though a later one failed
                self._record("trash", done)
            raise
        return self._record("trash", done)

    # ── the clipboard ──

    def clipboard(self) -> str:
        return self.read_clipboard()[:CLIPBOARD_LIMIT]

    def copy(self, text: str) -> Record:
        try:
            before = self.read_clipboard()
        except (Refused, OSError, ValueError):
            before = ""  # a password manager's secret: never kept, even in memory
        self.write_clipboard(text)
        return self._record("clipboard", [], before=before[:CLIPBOARD_LIMIT])

    # ── undo ──

    def recent(self, limit: int = 10) -> list[Record]:
        return [r for r in reversed(self.records) if not r.undone][:limit]

    def undo(self, record_id: str = "") -> str:
        """Put back the last change (or the one with this id); what was done, in words.
        Refused when there's nothing to undo or it can't be put back as it was."""
        pending = [r for r in reversed(self.records) if not r.undone]
        record = next((r for r in pending if r.id == record_id), None) if record_id else None
        if record is None and not record_id and pending:
            record = pending[0]
        if record is None:
            raise Refused(
                "There's nothing of mine to undo." if not record_id else "No such change."
            )
        if record.kind == "clipboard":
            self.write_clipboard(record.before)
            record.undone = True
            return "Put back what was on the clipboard before."
        back = 0
        problems = []
        for item in reversed(record.items):
            src, dest = Path(item["from"]), Path(item["to"])
            if os.path.lexists(src):
                problems.append(f"something called “{src.name}” is back where it was")
                continue
            if not os.path.lexists(dest):
                problems.append(f"“{dest.name}” isn't where I left it")
                continue
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(dest), str(src))
            if record.kind == "trash" and osplat.IS_WIN:
                from . import winfiles

                winfiles.left_the_bin(dest)  # (the bin shouldn't list what isn't in it)
            back += 1
        record.undone = True
        try:
            self._save()
        except OSError as exc:
            log.warning("file actions: couldn't save the undo log (%s)", exc)
        verb = {"move": "Moved", "rename": "Renamed", "trash": "Took"}[record.kind]
        where = {"move": "back", "rename": "back", "trash": f"out of the {bin_name()}"}[record.kind]
        said = f"{verb} {back} {'item' if back == 1 else 'items'} {where}." if back else ""
        if problems:
            said = (said + " " if said else "") + "Not all of it: " + "; ".join(problems[:3]) + "."
        return said


def _windows_name_problem(name: str) -> str:
    from . import winfiles

    return winfiles.bad_name(name)


def _same_item(a: Path, b: Path) -> bool:
    """Both names lead to the one file (a case-only rename on a case-insensitive disk)."""
    try:
        return os.path.samestat(os.lstat(a), os.lstat(b))
    except OSError:
        return False


def _when(stamp: str) -> datetime:
    """A record's time as this Mac's clock reads it (one with a zone, hand-edited in, too)."""
    try:
        when = datetime.fromisoformat(stamp)
    except ValueError:
        return datetime.min
    if when.tzinfo is not None:
        try:
            when = when.astimezone().replace(tzinfo=None)
        except (OverflowError, ValueError, OSError):
            return datetime.min
    return when


def _record_from(raw: Any) -> Record | None:
    if not isinstance(raw, dict):
        return None
    kind, items = raw.get("kind"), raw.get("items")
    if kind not in ("move", "rename", "trash") or not isinstance(items, list):
        return None
    clean = []
    for item in items:
        if not isinstance(item, dict):
            return None
        src, dest = item.get("from"), item.get("to")
        if not (isinstance(src, str) and isinstance(dest, str) and src and dest):
            return None
        clean.append({"from": src, "to": dest})
    if not (isinstance(raw.get("id"), str) and isinstance(raw.get("at"), str)):
        return None
    return Record(
        id=raw["id"], kind=kind, at=raw["at"], items=clean, undone=raw.get("undone") is True
    )
