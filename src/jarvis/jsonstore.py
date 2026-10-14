"""The small JSON files in Application Support, read and saved one way for every store.

A save goes to a temp file of its own (two writers never share one), is flushed to the
disk and swapped in whole, and the file it replaces stays beside it as <name>.bak. A file
that can't be used (cut short by a crash, torn, written by another build or program) is
never thrown away: it's kept as <name>.bad-<stamp>, and the last good copy is read
instead. A file that's there but can't be read just now is left alone, and nothing is
saved over it, by any store: save_json refuses a file this process couldn't read when it
last tried; once it can be read again, what this run saves goes beside it, as
<name>.unsaved-<stamp>, and the file is still never written over. One backend at a time
uses the folder (claim_folder).

Versioned stores (register_store, load_store, save_store): a store whose shape changes
between releases carries its version in the file ("version", or the key it names), and
each step from one version to the next is registered beside it (register_migration). A
file of an older version is copied whole first (<name>.v<old>-<stamp>.pre-migration, never
over an earlier copy), then taken through every step in order and saved at once; a step
that fails leaves the file as it was and the store unreadable for this run (Unreadable:
nothing is saved over it). A copy that can't be made (a read-only folder) leaves the file
as it was too: its data is updated in memory and used, and nothing is saved over it this
run. With no step to take (a store's first version, 0 -> 1) nothing is copied or
rewritten: the data is stamped in memory and the file at its next save. A file without a
version is version 0, the shape from before versions; nonsense in
the field (2.0, "2", -1, a 300-digit number) makes it Unreadable, never a version 0. One from a newer build is copied the same way before this build reads it (it
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


# Files this process couldn't read when it last tried (read_json raised Unreadable), by
# absolute path: save_json refuses to write over one until a read of it succeeds again.
# Each store was meant to keep that rule itself, and some caught Unreadable as "nothing
# yet" and then saved their empty start over the owner's file; this is the rule kept in
# one place, so a new store can't repeat it. (save_json(..., over_unreadable=True) is the
# way out for a store that means it.)
_REFUSED: set[str] = set()
# Of those, the ones refused because the file itself couldn't be read (its permissions, a
# disk error), not for what it holds (a migration that failed): only these can come right
# by themselves (REL-6, _cleared).
_UNREAD: set[str] = set()


def _key(path: Path) -> str:
    return os.path.abspath(os.fspath(path))


def read_json(
    path: Path, shape: Shape, *, clock: Callable[[], datetime] = datetime.now
) -> tuple[Any, str]:
    """_read_json, with what it couldn't read remembered (save_json won't save over it)."""
    try:
        found = _read_json(path, shape, clock=clock)
    except Unreadable:
        _REFUSED.add(_key(path))
        _UNREAD.add(_key(path))
        raise
    _REFUSED.discard(_key(path))
    _UNREAD.discard(_key(path))
    _UNSAVED.pop(_key(path), None)
    return found


def _cleared(path: Path, key: str) -> bool:
    """Whether a refused file has come right since (REL-6), so a save may go ahead: only
    when it's gone (the owner deleted it to start afresh: nothing is saved over anything).
    One that couldn't be read and can be now (its permissions fixed) is the owner's whole
    file again, while the store that couldn't read it holds something else in memory (many
    start empty: one phone paired this run, where the file has three). Setting the file
    aside and saving this run's data in its place left the next start reading the one
    phone (REL3-2), so it stays refused: save_json keeps this run's data beside it instead
    (_beside), and the next start reads the owner's file. A file refused for what it holds
    (a failed migration) stays refused while it's there; one that still can't be read too."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        _REFUSED.discard(key)
        _UNREAD.discard(key)
        _UNSAVED.pop(key, None)
        return True
    except OSError:
        return False
    return False


# This run's data for a refused file that can be read again (_cleared), by the refused
# file's path: where it's kept beside it (<name>.unsaved-<stamp>, one per run, saved over
# by each later save of the store), so it's said once and never piles up a file a save.
_UNSAVED: dict[str, Path] = {}


def _beside(path: Path, key: str, data: Any, indent: int | None, mode: int) -> bool:
    """A save the refusal stops, kept beside the file when the file can be read again
    (REL3-2): the owner's file stays as it is, and this run's data isn't lost either, in
    <name>.unsaved-<stamp>. False when the file still can't be read (nothing is written)."""
    if key not in _UNREAD:
        return False
    try:
        raw = path.read_bytes()
        if raw.strip():
            json.loads(raw)
    except (OSError, ValueError):
        return False
    kept = _UNSAVED.get(key)
    if kept is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        for n in range(1, 100):
            kept = path.with_name(f"{path.name}.unsaved-{stamp}" + (f"-{n}" if n > 1 else ""))
            if not os.path.lexists(kept):
                break
        else:
            return False
        log.warning(
            "%s can be read again but wasn't when this run loaded it: it's left as it is, "
            "and what this run saves is kept beside it as %s",
            path.name,
            kept.name,
        )
        _UNSAVED[key] = kept
    save_json(kept, data, indent=indent, mode=mode, backup=False, over_unreadable=True)
    return True


def _read_json(
    path: Path, shape: Shape, *, clock: Callable[[], datetime] = datetime.now
) -> tuple[Any, str]:
    """The file's data, and how it was read:

    ok        as it was saved
    missing   no file (None): a .bak never brings back a file the owner deleted
    empty     a file with nothing in it (None)
    restored  it was damaged or empty; a damaged one is kept as <name>.bad-<stamp>, and the
              last good copy (<name>.bak) is what's returned, written back as the file
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
        _put_back(path)
        return good, "restored"
    return None, "empty" if blank else "damaged"


def _put_back(path: Path) -> None:
    """The last good copy (<name>.bak) written back as the file itself, its bytes as they
    are, the .bak left where it is. Without it a restored store held its data in memory
    alone: the next start found no file at all ("missing", so the .bak isn't consulted)
    and began empty, and the next save made a .bak of nothing, so the last good copy was
    gone for good. A copy that can't be put back is no reason not to start; it's only
    said."""
    fd, tmp = -1, ""
    try:
        raw = path.with_name(path.name + ".bak").read_bytes()
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        with os.fdopen(fd, "wb") as out:
            fd = -1
            osplat.fchmod(out.fileno(), 0o600)
            out.write(raw)
            out.flush()
            _sync(out.fileno())
        osplat.replace_file(tmp, path)
        tmp = ""
        _sync_folder(path.parent)
    except OSError as exc:
        log.warning("%s's last good copy couldn't be put back (%s)", path.name, exc)
    finally:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)
        if tmp:
            with contextlib.suppress(OSError):
                os.unlink(tmp)


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
    path: Path,
    data: Any,
    *,
    indent: int | None = 2,
    mode: int = 0o600,
    backup: bool = True,
    over_unreadable: bool = False,
) -> None:
    """Written whole to a temp file of its own, flushed to the disk, then swapped in, so a
    crash or a second writer never leaves half a file; readable by the owner alone. The
    file it replaces stays as <name>.bak. backup False keeps no copy and drops the old one
    and its copies from before migrations, so something just removed (a forgotten fact, an
    unpaired phone, a crash report) can't come back from them. Half of a surrogate pair is
    written escaped: it never makes a file unsaveable. Raises Unreadable, saving nothing,
    over a file this process couldn't read when it last tried (unless over_unreadable); when
    that file can be read again, this run's data is saved beside it instead (_beside)."""
    if not over_unreadable and _key(path) in _REFUSED and not _cleared(path, _key(path)):
        if _beside(path, _key(path), data, indent, mode):
            return  # (kept beside the owner's file, never over it)
        raise refusal(path, "it couldn't be read when it was loaded")
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
        for copy in migration_copies(path):
            with contextlib.suppress(OSError):
                os.unlink(copy)
    _REFUSED.discard(_key(path))  # (what's there now is what was just written)
    _UNREAD.discard(_key(path))
    _UNSAVED.pop(_key(path), None)
    _sync_folder(path.parent)


def migration_copies(path: Path) -> list[Path]:
    """The copies kept of path before its migrations (<name>.v<old>-<stamp>.pre-migration)."""
    return sorted(path.parent.glob(f"{glob.escape(path.name)}.v*-*.pre-migration"))


def forget(path: Path) -> None:
    """A store's file gone for good, with everything kept of it beside it: its .bak and its
    copies from before migrations (a deleted session's words must not stay behind in one).
    Raises OSError when one couldn't be removed; the rest are still tried."""
    failed: OSError | None = None
    for each in (path, path.with_name(path.name + ".bak"), *migration_copies(path)):
        try:
            each.unlink(missing_ok=True)
        except OSError as exc:
            failed = failed or exc
    _REFUSED.discard(_key(path))
    _UNREAD.discard(_key(path))
    if failed is not None:
        raise failed


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


VERSION_MAX = 1_000_000  # a version past this is no build's: nonsense in the field


def version_of(data: Any, key: str = "version") -> int:
    """A file's version: 0 for one from before versions (no field, or null in it); -1 for
    nonsense in the field (a float, a string, a negative or a 300-digit number), which no
    step may be run over: 2.0 read as 0 ran the first steps over a newer build's data, and
    a huge one made a copy name too long for the disk."""
    found = data.get(key) if isinstance(data, dict) else None
    if found is None:
        return 0
    if isinstance(found, int) and not isinstance(found, bool) and 0 <= found <= VERSION_MAX:
        return found
    return -1


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
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return None
    for n in range(1, COPIES_A_SECOND):
        copy = path.with_name(
            f"{path.name}.v{old}-{stamp}" + (f"-{n}" if n > 1 else "") + ".pre-migration"
        )
        try:  # (made only if it isn't there: two at once never share a name)
            fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
                out.flush()
                _sync(out.fileno())
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(copy)
            raise
        with contextlib.suppress(OSError):
            st = path.stat()
            os.utime(copy, ns=(st.st_atime_ns, st.st_mtime_ns))
        return copy
    raise OSError(errno.EEXIST, f"no free name to keep {path.name} under before migrating")


COPIES_A_SECOND = 10_000  # copies of one file kept in one second, at most (99 ran out)


def _copied_already(path: Path, old: int) -> bool:
    """A copy of the file as it is now is there already (the same bytes, not just a copy
    of the same version: a newer build that wrote the file again since needs a new one, or
    going back a release a second time lost that build's second file)."""
    try:
        raw = path.read_bytes()
    except OSError:
        return False
    for copy in path.parent.glob(f"{glob.escape(path.name)}.v{old}-*.pre-migration"):
        try:
            if copy.stat().st_size == len(raw) and copy.read_bytes() == raw:
                return True
        except OSError:
            continue
    return False


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
    if old < 0:
        _REFUSED.add(_key(path))
        log.warning("%s has nonsense for its version; it's left as it is", path.name)
        raise refusal(path, "its version isn't one this app knows")
    if old == store.version:
        return data
    if old < store.version and not any(store.steps.get(v) for v in range(old, store.version)):
        # Nothing to change but the version (a store's first version, 0 -> 1, with no step):
        # the data as it is, stamped in memory; the file gets its version at its next save.
        # Copying and rewriting it changed nothing, and made every kept session three files
        # (.pre-migration, .bak, the file) at the first start, ~17 s for 2000 (REL3-18).
        return stamped(name, data)
    try:
        # (one from a newer build is kept once as it is: this build saves it back at its own
        # version, unless it never saves, and then each start would copy it again)
        if old < store.version or not _copied_already(path, old):
            keep_before_migrating(path, old, clock)
    except OSError as exc:
        # No copy (a read-only folder, a full disk): the data is still good, so it's used,
        # updated in memory, and the file is left as it was, nothing saved over it this run.
        log.warning("%s couldn't be copied before its migration (%s)", path.name, exc)
        _REFUSED.add(_key(path))
        if old > store.version:
            return data
        return _steps(path, name, store, data, old)
    if old > store.version:
        log.warning(
            "%s is version %d, from a newer build than this one (%d); a copy is kept",
            path.name,
            old,
            store.version,
        )
        return data
    migrated = _steps(path, name, store, data, old)
    try:
        save_json(path, migrated, indent=indent)
    except OSError as exc:  # kept in memory for this run; tried again on the next start
        log.warning("%s couldn't be saved after its migration (%s)", path.name, exc)
    else:
        log.info("%s updated from version %d to %d", path.name, old, store.version)
    return migrated


def _steps(path: Path, name: str, store: Store, data: dict[str, Any], old: int) -> Any:
    """data taken through every step from old to the store's version, stamped with it.
    Raises Unreadable (and nothing may be saved over the file) when a step fails."""
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
        _REFUSED.add(_key(path))
        raise refusal(path, f"its format couldn't be updated from version {old}") from exc
    return stamped(name, migrated)


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
