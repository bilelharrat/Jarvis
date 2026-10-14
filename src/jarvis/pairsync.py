"""Pairing: an isolated copy mirrored, both ways, into a folder the owner opens in their own
editor (features/code_pairing.py runs it; this is the sync itself, called off the loop).

Each sync looks at both trees: the copy's files git lists (tracked, and new ones it doesn't
ignore) and every file in the pairing folder that the copy's git wouldn't ignore. For each
file it compares the two sides with what they were at the last sync both agreed on (the
base):
- only the copy changed: the session's work goes to the folder;
- only the folder changed: the owner's edit goes to the copy;
- both changed, differently: a conflict. Neither side is written; the file is listed, and
  stays out of the sync until the owner keeps one side (or makes them the same).
A file deleted on one side and untouched on the other is deleted on the other.

Files that run code by themselves never go from the copy to the owner's folder unasked:
git's and Claude Code's own folders, Eden's .jarvis/, hook managers' configs, .envrc, and an
editor's own settings (.vscode/, .idea/, .zed/; an editor runs a folder's tasks and
settings when the owner opens it). The session's changes to them are held, and listed,
until the owner brings them over (tasks._PROTECTED_DIRS and friends, plus the editors').
The owner's own edits to them in their folder go to the copy as any edit does: they're the
owner's.

Only regular files, never links, and never through a linked folder either: a path with a
link anywhere on the way (the session can swap its copy's lib/ for a link to ~/.ssh, the
owner's folder can hold docs -> ~/Documents) is left alone on both sides, never read,
written or deleted through. Names are compared casefolded where it matters (the Mac's disk
doesn't care about case: .Claude/ is .claude/). Nothing over FILE_MAX bytes; .git,
node_modules, .venv and caches are never looked at. A file the other side changed while it
was being written is left for the next sync, never overwritten; Keep and bring-over write
only the version the owner saw, over the version the owner saw.

The owner's folder is never emptied by accident: a sync stops (CopyUnreadable) when the
copy's git can't list its files (the copy being removed, its .git gone), and when the
session deletes more than DELETES_MAX files in one pass the deletions are held, like a
protected change, until the owner brings them over.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import secrets
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .code_changes import git
from .tasks import _hook_sections, _protected_rel

MARKER = ".eden-pair.json"  # in the pairing folder: whose mirror it is
FILE_MAX = 5_000_000
FILES_MAX = 20_000
# More of the session's deletions than this in one pass are held for the owner, not
# mirrored: a copy half taken away (or a session's rm -rf) must not empty their folder.
DELETES_MAX = 50
# Never mirrored, either way.
NEVER = {".git"}
# Not looked for in the owner's folder (what's in there is untracked noise: an editor's or
# a build's): a file git tracks in one of them is still mirrored, found from the copy's side.
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
             ".pytest_cache", ".ruff_cache", ".next", ".turbo", "dist", "build"}  # fmt: skip
EDITOR_DIRS = frozenset({".vscode", ".idea", ".zed", ".fleet", ".devcontainer"})


class CopyUnreadable(RuntimeError):
    """The copy's git couldn't list its files (its .git gone, the copy being removed): no
    sync this time, rather than one that takes every file as deleted by the session."""


def protected(rel: str, new: bytes | None, old: bytes | None) -> bool:
    """Whether a change from the copy to this file waits for the owner (it runs code by
    itself, in git or in the owner's editor). Casefolded (tasks._protected_rel): on the
    Mac's disk .VSCode/tasks.json is the .vscode/tasks.json the editor runs."""
    parts = Path(rel).parts
    name = parts[-1].casefold() if parts else ""
    if _protected_rel(Path(rel), EDITOR_DIRS):
        return True
    if name == "package.json":
        before = (old or b"").decode(errors="replace")
        after = (new or b"").decode(errors="replace")
        then, now = _hook_sections(before), _hook_sections(after)
        return then is None or now is None or then != now
    return False


@dataclass
class Pair:
    """One copy's pairing, as kept between syncs (code_pairs.json)."""

    slug: str
    copy: str  # the copy's session folder
    folder: str  # the owner's pairing folder
    on: bool = True
    base: dict[str, str] = field(default_factory=dict)  # file -> its digest both agreed on
    conflicts: dict[str, dict[str, str]] = field(default_factory=dict)  # file -> both digests
    held: dict[str, str] = field(default_factory=dict)  # file -> the copy's digest, waiting

    def public(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "folder": self.folder,
            "on": self.on,
            "conflicts": sorted(self.conflicts)[:200],
            "held": sorted(self.held)[:200],
        }

    def to_json(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "copy": self.copy,
            "folder": self.folder,
            "on": self.on,
            "base": self.base,
            "conflicts": self.conflicts,
            "held": self.held,
        }

    @classmethod
    def from_json(cls, raw: Any) -> Pair | None:
        if not isinstance(raw, dict):
            return None
        text = [raw.get(k) for k in ("slug", "copy", "folder")]
        if not all(isinstance(v, str) and v for v in text):
            return None

        def strings(value: Any) -> dict[str, str]:
            return (
                {k: v for k, v in value.items() if isinstance(k, str) and isinstance(v, str)}
                if isinstance(value, dict)
                else {}
            )

        conflicts = raw.get("conflicts") if isinstance(raw.get("conflicts"), dict) else {}
        return cls(
            slug=raw["slug"],
            copy=raw["copy"],
            folder=raw["folder"],
            on=raw.get("on") is True,
            base=strings(raw.get("base")),
            conflicts={k: strings(v) for k, v in conflicts.items() if isinstance(k, str)},
            held=strings(raw.get("held")),
        )


@dataclass
class Synced:
    to_folder: list[str] = field(default_factory=list)  # the session's work, mirrored
    to_copy: list[str] = field(default_factory=list)  # the owner's edits, brought in
    conflicts: list[str] = field(default_factory=list)  # new conflicts this time
    resolved: list[str] = field(default_factory=list)  # conflicts the two sides settled
    held: list[str] = field(default_factory=list)  # new protected changes held
    skipped: list[str] = field(default_factory=list)  # too big, or changed while written
    mass_held: int = 0  # of held: the session's deletions, too many at once to mirror
    changed: bool = False  # anything in the Pair to save

    @property
    def anything(self) -> bool:
        return bool(self.to_folder or self.to_copy or self.conflicts or self.resolved or self.held)


class Tree:
    """One side's files and their digests, read again only when a file's stat changes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._seen: dict[str, tuple[tuple[int, int, int], str]] = {}

    def path(self, rel: str) -> Path | None:
        """Where the file is, None when any folder on the way to it from the root is a link
        (or not a folder): a path through a link leads outside this side, so it's never
        read, written or deleted. A folder on the way that isn't there yet is fine (a
        write makes it)."""
        here = self.root
        for part in Path(rel).parts[:-1]:
            here = here / part
            try:
                st = here.lstat()
            except FileNotFoundError:
                break
            except OSError:  # (a file on the way: NotADirectoryError)
                return None
            if not stat.S_ISDIR(st.st_mode):
                return None
        return self.root / rel

    def present(self, rel: str) -> bool:
        """Whether anything at all is there (a link, a folder, a pipe count), or the way to
        it can't be walked safely: then a missing regular file isn't a deletion."""
        path = self.path(rel)
        return path is None or os.path.lexists(path)

    def digest(self, rel: str) -> str | None:
        """The file's digest, None when it isn't there (or isn't a regular file, or is
        through a linked folder), "big" past FILE_MAX."""
        path = self.path(rel)
        if path is None:
            return None
        try:
            st = path.lstat()
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode):
            return None
        if st.st_size > FILE_MAX:
            return "big"
        key = (st.st_mtime_ns, st.st_size, st.st_ino)
        seen = self._seen.get(rel)
        if seen is not None and seen[0] == key:
            return seen[1]
        data = self.read(rel)
        if data is None:
            return None
        found = _sha(data)
        self._seen[rel] = (key, found)
        return found

    def read(self, rel: str) -> bytes | None:
        """The file's bytes: a regular file only, opened without following a link (a link
        swapped in after the digest's lstat isn't read through)."""
        path = self.path(rel)
        if path is None:
            return None
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
        except OSError:
            return None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            with os.fdopen(fd, "rb") as fh:
                fd = -1
                return fh.read(FILE_MAX + 1)
        except OSError:
            return None
        finally:
            if fd >= 0:
                os.close(fd)


def _sha(data: bytes | None) -> str | None:
    return None if data is None else hashlib.sha1(data, usedforsecurity=False).hexdigest()


def _skipped(rel: str) -> bool:
    parts = [part.casefold() for part in Path(rel).parts]  # (.GIT is .git on the Mac)
    return (
        not parts
        or "/".join(parts) == MARKER
        or parts[-1] == ".ds_store"
        or bool(NEVER & set(parts))
        or ".." in parts
        or Path(rel).is_absolute()
    )


def copy_files(cwd: Path) -> set[str]:
    """What git lists in the copy's folder: tracked files, and new ones it doesn't ignore
    (a .gitignored node_modules is never mirrored)."""
    if not (cwd / ".git").exists():
        raise CopyUnreadable(f"{cwd} has no .git")
    listed = git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".")
    if not listed.ok:
        raise CopyUnreadable(listed.err.strip()[:200] or "git couldn't list the copy's files")
    return {p for p in listed.out.split("\0") if p and not _skipped(p)}


def folder_files(folder: Path) -> set[str]:
    found: set[str] = set()
    for top, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d.casefold() not in SKIP_DIRS]
        for name in files:
            rel = os.path.relpath(os.path.join(top, name), folder)
            if not _skipped(rel):
                found.add(Path(rel).as_posix())
            if len(found) >= FILES_MAX:
                return found
    return found


def ignored(cwd: Path, rels: set[str]) -> set[str]:
    """Which of these the copy's git ignores (build output the owner's editor made, say)."""
    if not rels:
        return set()
    asked = git(cwd, "check-ignore", "--no-index", "-z", "--stdin", input="\0".join(sorted(rels)))
    return {p for p in asked.out.split("\0") if p}


_ANY = object()
# Folders opened one by one, each never through a link (P2): where a write or a delete
# happens is held by its descriptor, so a folder swapped for a link after it was looked at
# can't lead it outside its side. Where the OS can't (Windows), the paths are checked again.
# (os.rename is renameat there, replacing as os.replace does; os.replace isn't listed.)
_BY_FD = os.name == "posix" and {os.open, os.rename, os.unlink} <= os.supports_dir_fd


def _open_dir(root: Path, rel: str) -> int | None:
    """A descriptor of the folder rel's file is in, opened from root a folder at a time,
    never through a link; None when one on the way is a link, not a folder, or missing."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(root, flags)
    except OSError:
        return None
    for part in Path(rel).parts[:-1]:
        try:
            nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
        except OSError:
            os.close(fd)
            return None
        os.close(fd)
        fd = nxt
    return fd


def _replace_at(folder: int, name: str, data: bytes, mode: int | None, still: Any) -> bool:
    """data written to a scratch file in the folder held open, then swapped in as name, if
    still() says the target is as it was looked at. True when written."""
    scratch = f".eden-pair-{secrets.token_hex(8)}"
    try:
        out = os.open(
            scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder
        )
    except OSError:
        return False
    try:
        with os.fdopen(out, "wb") as stream:
            stream.write(data)
            if mode is not None:
                with contextlib.suppress(OSError):
                    os.fchmod(stream.fileno(), mode)
        if not still():  # (changed just now: the next sync sees it)
            os.unlink(scratch, dir_fd=folder)
            return False
        os.rename(scratch, name, src_dir_fd=folder, dst_dir_fd=folder)
    except OSError:
        with contextlib.suppress(OSError):
            os.unlink(scratch, dir_fd=folder)
        return False
    return True


def _write(source: Tree, target: Tree, rel: str, expect: str | None, want: Any = _ANY) -> bool:
    """The source's file (or its absence) written over the target's, unless the target
    changed since it was looked at (expect: its digest then), or the source isn't the
    version meant (want: its digest, when given: what the owner saw on a card, what the
    sync looked at). Never through a linked folder on either side, and a source that has
    something other than a regular file there (a link, a folder) isn't a deletion. True
    when written."""
    path = target.path(rel)
    if path is None or source.path(rel) is None:
        return False
    data = source.read(rel)
    if data is None and source.present(rel):
        return False
    if want is not _ANY and _sha(data) != want:
        return False
    if target.digest(rel) != expect:
        return False
    if data is None:
        if _BY_FD:
            folder = _open_dir(target.root, rel)
            if folder is None:  # (a link swapped in on the way just now: nothing deleted)
                return False
            try:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(path.name, dir_fd=folder)
            finally:
                os.close(folder)
        else:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
        parent = path.parent
        while parent != target.root and target.root in parent.parents:
            try:
                parent.rmdir()  # (only once it's empty)
            except OSError:
                break
            parent = parent.parent
        return True
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:  # (a file in the way of a folder: left for the owner)
        return False
    if target.path(rel) is None:  # (a link swapped in on the way just now)
        return False
    if _BY_FD:
        folder = _open_dir(target.root, rel)
        if folder is None:
            return False
        try:
            mode = None
            with contextlib.suppress(OSError):
                mode = stat.S_IMODE((source.root / rel).lstat().st_mode)
            return _replace_at(
                folder, path.name, data, mode, lambda: target.digest(rel) == expect
            )
        finally:
            os.close(folder)
    fd, scratch = tempfile.mkstemp(dir=path.parent, prefix=".eden-pair-")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        with contextlib.suppress(OSError):
            os.chmod(scratch, stat.S_IMODE((source.root / rel).lstat().st_mode))
        if target.digest(rel) != expect:  # (changed just now: the next sync sees it)
            os.unlink(scratch)
            return False
        os.replace(scratch, path)
    except OSError:
        with contextlib.suppress(OSError):
            os.unlink(scratch)
        return False
    return True


class Syncer:
    """A pairing's two trees, kept between syncs so unchanged files aren't read again."""

    def __init__(self, pair: Pair) -> None:
        self.pair = pair
        self.copy = Tree(Path(pair.copy))
        self.folder = Tree(Path(pair.folder))

    def sync(self) -> Synced:
        pair, done = self.pair, Synced()
        cwd = Path(pair.copy)
        names = copy_files(cwd)  # (CopyUnreadable: no sync this time)
        theirs = folder_files(Path(pair.folder))
        names |= theirs - ignored(cwd, theirs - names)
        names |= set(pair.base) | set(pair.conflicts) | set(pair.held)
        deletes: list[str] = []  # the session's deletions, mirrored at the end (or held)
        for rel in sorted(names):
            if _skipped(rel):
                continue
            a, b = self.copy.digest(rel), self.folder.digest(rel)
            if "big" in (a, b):
                done.skipped.append(rel)
                continue
            base = pair.base.get(rel)
            if rel in pair.conflicts:
                if a != b:
                    if pair.conflicts[rel] != {"copy": a or "", "folder": b or ""}:
                        pair.conflicts[rel] = {"copy": a or "", "folder": b or ""}
                        done.changed = True
                    continue
                pair.conflicts.pop(rel)
                done.resolved.append(rel)
                done.changed = True
            if a == b:
                if base != a or rel in pair.held:
                    if a is None:
                        pair.base.pop(rel, None)
                    else:
                        pair.base[rel] = a
                    pair.held.pop(rel, None)
                    done.changed = True
                continue
            if b == base:  # only the session changed it
                new = self.copy.read(rel)
                if _sha(new) != a:  # (changed again just now: the next sync sees it)
                    done.skipped.append(rel)
                    continue
                if a is None:
                    deletes.append(rel)
                    continue
                if protected(rel, new, self.folder.read(rel)):
                    if pair.held.get(rel) != (a or ""):
                        if rel not in pair.held:
                            done.held.append(rel)
                        pair.held[rel] = a or ""
                        done.changed = True
                    continue
                if _write(self.copy, self.folder, rel, b, want=a):
                    _agree(pair, rel, a)
                    pair.held.pop(rel, None)  # (a held deletion the session took back)
                    done.to_folder.append(rel)
                else:
                    done.skipped.append(rel)
                done.changed = True
            elif a == base:  # only the owner changed it
                if _write(self.folder, self.copy, rel, a):
                    _agree(pair, rel, b)
                    pair.held.pop(rel, None)
                    done.to_copy.append(rel)
                else:
                    done.skipped.append(rel)
                done.changed = True
            else:
                pair.conflicts[rel] = {"copy": a or "", "folder": b or ""}
                pair.held.pop(rel, None)
                done.conflicts.append(rel)
                done.changed = True
        self._delete(deletes, done)
        return done

    def _delete(self, rels: list[str], done: Synced) -> None:
        """The session's deletions this pass, mirrored to the owner's folder; past
        DELETES_MAX at once (or of a protected file) held instead, listed for the owner."""
        pair = self.pair
        many = len([r for r in rels if pair.held.get(r) != ""]) > DELETES_MAX
        for rel in rels:
            if pair.held.get(rel) == "":  # (held already: it waits for the owner)
                continue
            if many or protected(rel, None, self.folder.read(rel)):
                if rel not in pair.held:
                    done.held.append(rel)
                    done.mass_held += many
                    pair.held[rel] = ""
                    done.changed = True
                continue
            if _write(self.copy, self.folder, rel, pair.base.get(rel), want=None):
                _agree(pair, rel, None)
                done.to_folder.append(rel)
            else:
                done.skipped.append(rel)
            done.changed = True

    def keep(self, rel: str, side: str) -> bool:
        """A conflict settled: the session's version ("copy") or the owner's ("folder")
        written over the other."""
        if rel not in self.pair.conflicts or side not in ("copy", "folder"):
            return False
        source, target = (self.copy, self.folder) if side == "copy" else (self.folder, self.copy)
        # The two versions the owner saw on the card: either changed since, it's not kept
        # (said "changed again just now"), so a newer one is never overwritten unseen.
        seen = self.pair.conflicts[rel]
        other = "folder" if side == "copy" else "copy"
        want, expect = seen.get(side) or None, seen.get(other) or None
        if not _write(source, target, rel, expect, want=want):
            return False
        self.pair.conflicts.pop(rel, None)
        _agree(self.pair, rel, want)
        return True

    def release(self, rels: list[str] | None = None) -> list[str]:
        """The held changes (all, or these) brought over to the owner's folder."""
        done = []
        for rel in sorted(rels if rels is not None else list(self.pair.held)):
            if rel not in self.pair.held:
                continue
            # The session's version held (and listed), over the owner's as it was when
            # held (the base: only the session had changed it): either changed since, it
            # stays held for the next sync to look at again.
            want = self.pair.held[rel] or None
            if _write(self.copy, self.folder, rel, self.pair.base.get(rel), want=want):
                self.pair.held.pop(rel)
                _agree(self.pair, rel, want)
                done.append(rel)
        return done


def _agree(pair: Pair, rel: str, digest: str | None) -> None:
    if digest is None:
        pair.base.pop(rel, None)
    else:
        pair.base[rel] = digest
