"""The small JSON files in Application Support, read and saved one way for every store.

A save goes to a temp file of its own (two writers never share one), is flushed to the
disk and swapped in whole, and the file it replaces stays beside it as <name>.bak. A file
that can't be used (cut short by a crash, torn, written by another build or program) is
never thrown away: it's kept as <name>.bad-<stamp>, and the last good copy is read
instead. A file that's there but can't be read just now is left alone, and nothing is
saved over it. One backend at a time uses the folder (claim_folder).
"""

from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import logging
import os
import tempfile
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import IO, Any

log = logging.getLogger("jarvis")

# What a file must hold: a JSON type (dict, list), or a check that says whether it fits.
Shape = type | tuple[type, ...] | Callable[[Any], bool]
_BAD = object()  # a file that can't be used (None is a value JSON can hold)
STALE_SECONDS = 600  # a temp file this old is one a killed save left behind


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
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    if not backup:
        with contextlib.suppress(OSError):
            os.unlink(path.with_name(path.name + ".bak"))
    _sync_folder(path.parent)


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


def claim_folder(folder: Path) -> IO[str] | None:
    """One backend at a time on a data folder: an exclusive lock on <folder>/backend.lock,
    held while the returned file stays open and let go by the system when the process ends,
    however it ends. Raises FolderTaken when another process holds it. None when the lock
    can't be made at all (a read-only disk): that alone is no reason not to start."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        fd = os.open(folder / "backend.lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        log.warning("couldn't make the backend lock (%s)", exc)
        return None
    handle = os.fdopen(fd, "r+", encoding="utf-8", errors="replace")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        holder = handle.read(40).strip()
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
        os.fchmod(out.fileno(), mode)
        json.dump(data, out, indent=indent, ensure_ascii=ascii_only)
        out.flush()
        _sync(out.fileno())


def _sync(fd: int) -> None:
    """On the disk itself: macOS's fsync stops at the drive's cache; F_FULLFSYNC doesn't."""
    try:
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    except (AttributeError, OSError):
        os.fsync(fd)


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
        os.replace(link, path.with_name(path.name + ".bak"))
    except OSError:
        pass
    finally:  # a rename between two names of one file does nothing and keeps both
        with contextlib.suppress(OSError):
            os.unlink(link)


def _sweep(path: Path) -> None:
    """Temp files that a save stopped half way (the app killed) left behind: never read,
    only litter. Old ones only, so a save under way is never touched."""
    cutoff = time.time() - STALE_SECONDS
    with contextlib.suppress(OSError):
        for leftover in path.parent.glob(f".{path.name}.*.tmp*"):
            with contextlib.suppress(OSError):
                if leftover.stat().st_mtime < cutoff:
                    leftover.unlink()


def _sync_folder(folder: Path) -> None:
    """The swap itself on the disk too."""
    with contextlib.suppress(OSError):
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
