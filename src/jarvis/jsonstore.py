"""The small JSON files in Application Support, read and saved one way for every store.

A save goes to a temp file of its own (two writers never share one), is flushed to the
disk and swapped in whole, and the file it replaces stays beside it as <name>.bak. A file
that can't be used (cut short by a crash, torn, written by another build or program) is
never thrown away: it's kept as <name>.bad-<stamp>, and the last good copy is read
instead. A file that's there but can't be read just now is left alone, and nothing is
saved over it. One backend at a time uses the folder (claim_folder).

Versioned stores (register_store, load_store, save_store): a store whose shape changes
between releases carries its version in the file ("version", or the key it names), and
each step from one version to the next is registered beside it (register_migration). A
file of an older version is copied whole first (<name>.v<old>-<stamp>.pre-migration, never
over an earlier copy), then taken through every step in order and saved at once; a step
that fails leaves the file as it was and the store unreadable for this run (Unreadable:
nothing is saved over it). A file without a version is version 0, the shape from before
versions. One from a newer build is copied the same way before this build reads it (it
keeps what it knows and writes its own version back), so going back a release never
loses the newer file.
"""

from __future__ import annotations

import contextlib
import errno
import glob
import json
import logging
import os
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import IO, Any

from . import osplat

log = logging.getLogger("jarvis")

# What a file must hold: a JSON type (dict, list), or a check that says whether it fits.
Shape = type | tuple[type, ...] | Callable[[Any], bool]
_BAD = object()  # a file that can't be used (None is a value JSON can hold)
STALE_SECONDS = 600  # a temp file this old is one a killed save left behind
# Each folder's temp files as last listed: folder -> (its mtime when listed, their names).
# A read looks for its own file's leftovers; listing the folder for each one made reading
# a folder of many stores (Eden Code's kept sessions, a file each) take time growing
# with the square of their number: seconds for a thousand. A folder is listed again once
# its mtime moves (something in it was added, removed or renamed).
_LEFTOVERS: dict[Path, tuple[int, tuple[str, ...]]] = {}
_LEFTOVERS_KEPT = 256  # folders remembered; past that the memory starts over


class Unreadable(OSError):
    """The file is there but can't be used now: its permissions, a disk error, or damaged
    and it couldn't be moved aside. Nothing may be saved over it."""


class FolderTaken(OSError):
    """Another backend holds the data folder."""


def read_json(
    path: Path, shape: Shape, *, clock: Callable[[], datetime] = datetime.now
) -> tuple[Any, str]:
    """The file's data, and how it was read:

    ok        as it was saved
    missing   no file (None): a .bak never brings back a file the owner deleted
    empty     a file with nothing in it (None)
    restored  it was damaged or empty; a damaged one is kept as <name>.bad-<stamp>, and the
              last good copy (<name>.bak) is what's returned
    damaged   the same with no good copy (None)

    Raises Unreadable when it can't be read now, or is damaged and can't be moved aside."""
    _sweep(path)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None, "missing"
    except OSError as exc:  # its permissions, a disk error, a folder in its place
        raise Unreadable(exc.errno, exc.strerror or type(exc).__name__) from exc
    blank = not raw.strip()
    if not blank:
        data = _parse(raw, shape)
        if data is not _BAD:
            return data, "ok"
        del raw
        if set_aside(path, clock) is None:
            raise Unreadable(errno.EIO, "it's damaged and couldn't be moved aside")
    good = last_good(path, shape)
    if good is not None:
        log.warning(
            "%s was %s; using its last good copy", path.name, "empty" if blank else "damaged"
        )
        return good, "restored"
    return None, "empty" if blank else "damaged"


def last_good(path: Path, shape: Shape) -> Any:
    """The copy save_json kept of the file before its last save (<name>.bak), when it's
    there and fits; else None."""
    try:
        raw = path.with_name(path.name + ".bak").read_bytes()
    except OSError:
        return None
    data = _parse(raw, shape) if raw.strip() else _BAD
    return None if data is _BAD else data


def load_json(path: Path, shape: Shape, **kw: Any) -> Any:
    """read_json's data alone (None when there's none)."""
    return read_json(path, shape, **kw)[0]


def refusal(path: Path, why: str) -> Unreadable:
    """What a store raises instead of saving over a file it couldn't read."""
    return Unreadable(errno.EACCES, f"{path.name} can't be read ({why}), so nothing was saved")


def set_aside(path: Path, clock: Callable[[], datetime] = datetime.now) -> Path | None:
    """Keep a file that can't be used under a name of its own, never over an earlier one.
    None when it couldn't be moved."""
    stamp = clock().strftime("%Y%m%d-%H%M%S")
    for n in range(1, 100):
        backup = path.with_name(f"{path.name}.bad-{stamp}" + (f"-{n}" if n > 1 else ""))
        if os.path.lexists(backup):
            continue
        try:
            path.rename(backup)
        except OSError as exc:
            log.warning("%s couldn't be moved aside (%s)", path.name, exc)
            return None
        log.warning("%s couldn't be read; it's kept as %s", path.name, backup.name)
        return backup
    return None


def save_json(
    path: Path, data: Any, *, indent: int | None = 2, mode: int = 0o600, backup: bool = True
) -> None:
    """Written whole to a temp file of its own, flushed to the disk, then swapped in, so a
    crash or a second writer never leaves half a file; readable by the owner alone. The
    file it replaces stays as <name>.bak. backup False keeps no copy and drops the old one,
    so something just removed (a forgotten fact, an unpaired phone) can't come back from
    it. Half of a surrogate pair is written escaped: it never makes a file unsaveable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        try:
            _write(fd, data, indent, mode, ascii_only=False)
        except UnicodeEncodeError:
            _write(os.open(tmp, os.O_WRONLY | os.O_TRUNC), data, indent, mode, ascii_only=True)
        if backup:
            _keep_previous(path, tmp)
        osplat.replace_file(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    if not backup:
        with contextlib.suppress(OSError):
            os.unlink(path.with_name(path.name + ".bak"))
    _sync_folder(path.parent)


@dataclass
class Store:
    """A versioned store: its current version, where the version sits in the file, and the
    steps that bring an older file up to it (version n -> n + 1)."""

    name: str
    version: int
    key: str = "version"
    steps: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = field(default_factory=dict)


STORES: dict[str, Store] = {}


def register_store(name: str, version: int = 1, *, key: str = "version") -> Store:
    """A store that carries its version (registering it again with a higher version moves
    it on; the steps stay)."""
    store = STORES.get(name)
    if store is None:
        store = STORES[name] = Store(name, version, key)
    else:
        store.version, store.key = max(store.version, version), key
    return store


def register_migration(
    name: str, from_version: int, step: Callable[[dict[str, Any]], dict[str, Any]]
) -> None:
    """How a store's file goes from from_version to the next: given the data, the data at
    the next version (the version field itself is set afterwards)."""
    store = STORES.get(name) or register_store(name, from_version + 1)
    store.version = max(store.version, from_version + 1)
    store.steps[from_version] = step


def version_of(data: Any, key: str = "version") -> int:
    """A file's version: 0 for one from before versions (or with nonsense in the field)."""
    found = data.get(key) if isinstance(data, dict) else None
    return found if isinstance(found, int) and not isinstance(found, bool) and found >= 0 else 0


def stamped(name: str, data: Any) -> Any:
    """data with its store's current version in it, as it's saved (a dict; anything else
    as it is)."""
    store = STORES.get(name)
    if store is None or not isinstance(data, dict):
        return data
    return {**data, store.key: store.version}


def keep_before_migrating(
    path: Path, old: int, clock: Callable[[], datetime] = datetime.now
) -> Path | None:
    """The file as it is, copied whole beside it before a migration: its path, None when
    there was nothing to copy. Raises OSError when it couldn't be copied."""
    stamp = clock().strftime("%Y%m%d-%H%M%S")
    for n in range(1, 100):
        copy = path.with_name(
            f"{path.name}.v{old}-{stamp}" + (f"-{n}" if n > 1 else "") + ".pre-migration"
        )
        if os.path.lexists(copy):
            continue
        try:
            shutil.copy2(path, copy)
        except FileNotFoundError:
            return None
        with contextlib.suppress(OSError):
            os.chmod(copy, 0o600)
        return copy
    raise OSError(errno.EEXIST, f"no free name to keep {path.name} under before migrating")


def migrate(
    path: Path,
    name: str,
    data: Any,
    *,
    indent: int | None = 2,
    clock: Callable[[], datetime] = datetime.now,
) -> Any:
    """data (as read from path) brought up to its store's version: copied first, each step
    in order, then saved. Raises Unreadable when a step fails or the copy can't be made, so
    the store saves nothing over the file this run."""
    store = STORES.get(name)
    if store is None or not isinstance(data, dict):
        return data
    old = version_of(data, store.key)
    if old == store.version:
        return data
    try:
        # (one from a newer build is kept once: this build saves it back at its own version,
        # unless it never saves, and then each start would copy it again)
        if old < store.version or not any(path.parent.glob(f"{glob.escape(path.name)}.v{old}-*")):
            keep_before_migrating(path, old, clock)
    except OSError as exc:
        log.warning("%s couldn't be copied before its migration (%s)", path.name, exc)
        raise refusal(path, "it couldn't be copied before updating its format") from exc
    if old > store.version:
        log.warning(
            "%s is version %d, from a newer build than this one (%d); a copy is kept",
            path.name,
            old,
            store.version,
        )
        return data
    migrated = data
    try:
        for version in range(old, store.version):
            step = store.steps.get(version)
            if step is not None:
                migrated = step(dict(migrated))
            if not isinstance(migrated, dict):
                raise TypeError(f"the step from version {version} gave no record")
    except Exception as exc:
        log.warning("%s couldn't be updated from version %d (%s)", path.name, old, exc)
        raise refusal(path, f"its format couldn't be updated from version {old}") from exc
    migrated = stamped(name, migrated)
    try:
        save_json(path, migrated, indent=indent)
    except OSError as exc:  # kept in memory for this run; tried again on the next start
        log.warning("%s couldn't be saved after its migration (%s)", path.name, exc)
    else:
        log.info("%s updated from version %d to %d", path.name, old, store.version)
    return migrated


def load_store(
    path: Path,
    name: str,
    shape: Shape = dict,
    *,
    indent: int | None = 2,
    clock: Callable[[], datetime] = datetime.now,
) -> Any:
    """load_json for a versioned store: its data at the store's version (None when
    there's none). Raises Unreadable as load_json does, and when a migration couldn't run."""
    data = load_json(path, shape, clock=clock)
    if data is None:
        return None
    return migrate(path, name, data, indent=indent, clock=clock)


def save_store(path: Path, name: str, data: Any, **kw: Any) -> None:
    """save_json with the store's version stamped in."""
    save_json(path, stamped(name, data), **kw)


def shallow(value: Any, depth: int = 32) -> bool:
    """Nested no deeper than depth: fine to keep and write back as it came. (Data nested
    past reason is junk, not another build's record, and could fail the save.)"""
    if depth < 0:
        return False
    if isinstance(value, dict):
        return all(shallow(v, depth - 1) for v in value.values())
    if isinstance(value, list):
        return all(shallow(v, depth - 1) for v in value)
    return True


def claim_folder(folder: Path, wait: float = 0) -> IO[str] | None:
    """One backend at a time on a data folder: an exclusive lock on <folder>/backend.lock,
    held while the returned file stays open and let go by the system when the process ends,
    however it ends. Raises FolderTaken when another process still holds it after `wait`
    seconds (a backend that is quitting lets go within a few). None when the lock can't be
    made at all (a read-only disk): that alone is no reason not to start."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        fd = os.open(folder / "backend.lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        log.warning("couldn't make the backend lock (%s)", exc)
        return None
    handle = os.fdopen(fd, "r+", encoding="utf-8", errors="replace")
    deadline = time.monotonic() + wait
    waiting = False
    while True:
        try:
            osplat.lock_file(handle)
            break
        except BlockingIOError:
            if time.monotonic() < deadline:
                if not waiting:
                    waiting = True
                    log.warning(
                        "%s is in use: waiting up to %gs for that backend to quit", folder, wait
                    )
                time.sleep(0.25)
                continue
            try:
                holder = handle.read(40).strip()
            except OSError:  # (Windows won't let a file be read where it's locked)
                holder = ""
            handle.close()
            raise FolderTaken(
                errno.EWOULDBLOCK, f"another JARVIS backend (process {holder or '?'}) is using it"
            ) from None
        except OSError as exc:  # a disk that can't lock files
            log.warning("couldn't lock %s (%s)", folder, exc)
            handle.close()
            return None
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n")  # who holds it, for the one that's turned away
    handle.flush()
    return handle


def _parse(raw: bytes, shape: Shape) -> Any:
    try:
        data = json.loads(raw.decode("utf-8-sig"))  # an editor's byte-order mark is fine
    except (ValueError, RecursionError):  # not JSON, not UTF-8, or nested past reason
        return _BAD
    return data if _fits(data, shape) else _BAD


def _fits(data: Any, shape: Shape) -> bool:
    if isinstance(shape, type | tuple):
        return isinstance(data, shape)
    try:
        return bool(shape(data))
    except Exception:  # a check that trips over odd data: the data doesn't fit
        return False


def _write(fd: int, data: Any, indent: int | None, mode: int, *, ascii_only: bool) -> None:
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        osplat.fchmod(out.fileno(), mode)
        json.dump(data, out, indent=indent, ensure_ascii=ascii_only)
        out.flush()
        _sync(out.fileno())


def _sync(fd: int) -> None:
    osplat.full_sync(fd)


def _keep_previous(path: Path, tmp: str) -> None:
    """The file about to be replaced, kept as <name>.bak: a hard link to it (no copying),
    swapped in so the old .bak goes only once the new one is there. An empty file is no
    good copy."""
    link = f"{tmp}.bak"
    try:
        if os.stat(path).st_size == 0:
            return
        os.link(path, link)
    except OSError:  # nothing there yet, or a disk without hard links
        return
    try:
        osplat.replace_file(link, path.with_name(path.name + ".bak"))
    except OSError:
        pass
    finally:  # a rename between two names of one file does nothing and keeps both
        with contextlib.suppress(OSError):
            os.unlink(link)


def _sweep(path: Path) -> None:
    """Temp files that a save stopped half way (the app killed) left behind: never read,
    only litter. Old ones only, so a save under way is never touched. (Those named
    .<name>.*.tmp*, as a glob of the folder would find them.)"""
    cutoff = time.time() - STALE_SECONDS
    try:
        names = _leftovers(path.parent)
    except OSError:
        return
    prefix = f".{path.name}."
    for name in names:
        if name.startswith(prefix) and ".tmp" in name[len(prefix) :]:
            leftover = path.parent / name
            with contextlib.suppress(OSError):
                if leftover.stat().st_mtime < cutoff:
                    leftover.unlink()


def _leftovers(folder: Path) -> tuple[str, ...]:
    """The names of the temp files in a folder (hidden ones with .tmp in them): listed
    once, and again only after the folder has changed."""
    stamp = os.stat(folder).st_mtime_ns  # before listing: a change after it moves it
    known = _LEFTOVERS.get(folder)
    if known is not None and known[0] == stamp:
        return known[1]
    names = tuple(n for n in os.listdir(folder) if n.startswith(".") and ".tmp" in n)
    # A disk whose clock keeps whole milliseconds or less (HFS+, exFAT) can leave the mtime
    # unmoved by a change in the same tick: such a folder is listed afresh every time.
    if stamp % 1_000_000:
        if len(_LEFTOVERS) >= _LEFTOVERS_KEPT:
            _LEFTOVERS.clear()
        _LEFTOVERS[folder] = (stamp, names)
    return names


def _sync_folder(folder: Path) -> None:
    """The swap itself on the disk too."""
    with contextlib.suppress(OSError):
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
