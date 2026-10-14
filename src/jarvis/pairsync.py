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

Only regular files, never links; nothing over FILE_MAX bytes; .git, node_modules, .venv and
caches are never looked at. A file the other side changed while it was being written is
left for the next sync, never overwritten.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .code_changes import git
from .tasks import (
    _HOOK_CONFIG_PREFIXES,
    _HOOK_CONFIGS,
    _PROTECTED_DIRS,
    _PROTECTED_FILES,
    _hook_sections,
)

MARKER = ".eden-pair.json"  # in the pairing folder: whose mirror it is
FILE_MAX = 5_000_000
FILES_MAX = 20_000
# Never mirrored, either way.
NEVER = {".git"}
# Not looked for in the owner's folder (what's in there is untracked noise: an editor's or
# a build's): a file git tracks in one of them is still mirrored, found from the copy's side.
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
             ".pytest_cache", ".ruff_cache", ".next", ".turbo", "dist", "build"}  # fmt: skip
EDITOR_DIRS = {".vscode", ".idea", ".zed", ".fleet", ".devcontainer"}


def protected(rel: str, new: bytes | None, old: bytes | None) -> bool:
    """Whether a change from the copy to this file waits for the owner (it runs code by
    itself, in git or in the owner's editor)."""
    parts = Path(rel).parts
    name = parts[-1] if parts else ""
    if (_PROTECTED_DIRS | EDITOR_DIRS) & set(parts[:-1]) or rel in _PROTECTED_FILES:
        return True
    if name in _HOOK_CONFIGS or name.startswith(_HOOK_CONFIG_PREFIXES):
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
    changed: bool = False  # anything in the Pair to save

    @property
    def anything(self) -> bool:
        return bool(self.to_folder or self.to_copy or self.conflicts or self.resolved or self.held)


class Tree:
    """One side's files and their digests, read again only when a file's stat changes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._seen: dict[str, tuple[tuple[int, int, int], str]] = {}

    def digest(self, rel: str) -> str | None:
        """The file's digest, None when it isn't there (or isn't a regular file), "big"
        past FILE_MAX."""
        path = self.root / rel
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
        try:
            found = hashlib.sha1(path.read_bytes(), usedforsecurity=False).hexdigest()
        except OSError:
            return None
        self._seen[rel] = (key, found)
        return found

    def read(self, rel: str) -> bytes | None:
        try:
            return (self.root / rel).read_bytes()
        except OSError:
            return None


def _skipped(rel: str) -> bool:
    parts = Path(rel).parts
    return (
        not parts
        or rel == MARKER
        or parts[-1] == ".DS_Store"
        or bool(NEVER & set(parts))
        or ".." in parts
        or Path(rel).is_absolute()
    )


def copy_files(cwd: Path) -> set[str]:
    """What git lists in the copy's folder: tracked files, and new ones it doesn't ignore
    (a .gitignored node_modules is never mirrored)."""
    listed = git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".")
    return {p for p in listed.out.split("\0") if p and not _skipped(p)}


def folder_files(folder: Path) -> set[str]:
    found: set[str] = set()
    for top, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
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


def _write(source: Tree, target: Tree, rel: str, expect: str | None) -> bool:
    """The source's file (or its absence) written over the target's, unless the target
    changed since it was looked at (expect: its digest then). True when written."""
    data = source.read(rel)
    if target.digest(rel) != expect:
        return False
    path = target.root / rel
    if data is None:
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
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, scratch = tempfile.mkstemp(dir=path.parent, prefix=".eden-pair-")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        with contextlib.suppress(OSError):
            os.chmod(scratch, stat.S_IMODE((source.root / rel).stat().st_mode))
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
        names = copy_files(cwd)
        theirs = folder_files(Path(pair.folder))
        names |= theirs - ignored(cwd, theirs - names)
        names |= set(pair.base) | set(pair.conflicts) | set(pair.held)
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
                if protected(rel, self.copy.read(rel), self.folder.read(rel)):
                    if pair.held.get(rel) != (a or ""):
                        if rel not in pair.held:
                            done.held.append(rel)
                        pair.held[rel] = a or ""
                        done.changed = True
                    continue
                if _write(self.copy, self.folder, rel, b):
                    _agree(pair, rel, a)
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
        return done

    def keep(self, rel: str, side: str) -> bool:
        """A conflict settled: the session's version ("copy") or the owner's ("folder")
        written over the other."""
        if rel not in self.pair.conflicts or side not in ("copy", "folder"):
            return False
        source, target = (self.copy, self.folder) if side == "copy" else (self.folder, self.copy)
        if not _write(source, target, rel, target.digest(rel)):
            return False
        self.pair.conflicts.pop(rel, None)
        _agree(self.pair, rel, source.digest(rel))
        return True

    def release(self, rels: list[str] | None = None) -> list[str]:
        """The held changes (all, or these) brought over to the owner's folder."""
        done = []
        for rel in sorted(rels if rels is not None else list(self.pair.held)):
            if rel not in self.pair.held:
                continue
            if _write(self.copy, self.folder, rel, self.folder.digest(rel)):
                self.pair.held.pop(rel)
                _agree(self.pair, rel, self.copy.digest(rel))
                done.append(rel)
        return done


def _agree(pair: Pair, rel: str, digest: str | None) -> None:
    if digest is None:
        pair.base.pop(rel, None)
    else:
        pair.base[rel] = digest
