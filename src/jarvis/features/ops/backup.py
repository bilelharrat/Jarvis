"""Backups of JARVIS's data folder, as one zip each, and restoring one.

What goes in: the JSON stores beside prefs.json (the settings, memory, routines, goals, the
Jarvis Code rules in permissions.json, paired phones, providers, connections, the purchase
log…) and, when the owner asks for it, the second brain's index (brain/index.json). Never:
Keychain secrets (they aren't in the folder), logs (~/Library/Logs), binaries (bin/,
models/), the file index (a cache of the disk that rebuilds itself), the built-in browser's
profile (its cookies and caches share the folder), damaged copies (.bad-*) or the previous
copies jsonstore keeps (.bak).

Integrity: manifest.json lists every file with its size and SHA-256, and verify() reads the
whole zip back against it.

A restore never writes into files the running app has open: stage() checks the zip and
extracts it into ops/restore/ inside the data folder, and apply_pending() moves the files
into place at the next start, before any store has read its file (features.prepare_all,
from server.serve, while that backend holds the folder). Every path comes from the manifest
and is checked on the way in and again on the way out: relative, no "..", never a link in
the zip or at the destination, and only the kinds of file a backup holds. Two files are
never rolled back: the purchase log (what was spent today stays counted against the daily
limit) and the paired phones (a phone unpaired since, perhaps a lost one, stays unpaired).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import zipfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

log = logging.getLogger("jarvis")

FORMAT = 1
MANIFEST = "manifest.json"
DATA = "data/"
KNOWLEDGE = "brain/index.json"
# Kept as they are by a restore, though a backup holds them (see the module's note).
KEEP_ON_RESTORE = frozenset({"transactions.json", "devices.json"})
KINDS = ("manual", "daily", "safety", "fix")
SUFFIX = {
    "manual": "",
    "daily": " (daily)",
    "safety": " (before restore)",
    "fix": " (before a fix)",
}
KEEP = {"daily": 7, "safety": 5, "fix": 5}  # the newest kept of each kind; manual ones stay
MAX_FILE = 512 * 1024 * 1024  # bytes in one file: the second brain's index can be large
MAX_TOTAL = 2 * 1024 * 1024 * 1024  # bytes a backup may unpack to, all files together
MAX_FILES = 2000
MAX_LISTED = 200  # backups listed from one folder
CHUNK = 1024 * 1024
RESTORE_DIR = ("ops", "restore")
RESULT = ("ops", "restore-result.json")
PENDING = "pending.json"

# A store's name: beside prefs.json, ending in .json. Temp files start with a dot, previous
# copies end in .bak and damaged ones in .bad-<stamp>, so none of them can match.
_STORE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.@+-]{0,120}\.json$")


class BackupError(Exception):
    """What went wrong, in words the window can show."""


class NothingToBackUp(BackupError):
    """A data folder with no stores yet (a fresh install): no backup, and nothing wrong."""


def default_folder(home: Path | None = None) -> Path:
    return (home or Path.home()) / "Documents" / "Jarvis" / "Backups"


def store_name(name: str) -> bool:
    return bool(_STORE.match(name))


def safe_rel(rel: Any) -> str | None:
    """rel as a backup may hold it (a store beside prefs.json, or the knowledge index), or
    None: absolute, "..", a backslash, a NUL, a hidden or odd name. Never touches the disk."""
    if not isinstance(rel, str) or not rel or len(rel) > 200 or "\\" in rel or "\x00" in rel:
        return None
    if rel.startswith("/") or ":" in rel:
        return None
    parts = PurePosixPath(rel).parts
    if any(p in ("", ".", "..") for p in parts) or "/".join(parts) != rel:
        return None
    if rel == KNOWLEDGE:
        return rel
    return rel if len(parts) == 1 and store_name(rel) else None


def _is_link(path: Path) -> bool:
    try:
        return stat.S_ISLNK(os.lstat(path).st_mode)
    except OSError:
        return False


def _regular(path: Path) -> bool:
    """A plain file, not a link (lstat: a link is never followed)."""
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def _real_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def collect(folder: Path, knowledge: bool = False) -> list[str]:
    """What a backup of the folder holds, as paths relative to it, in order."""
    found: list[str] = []
    with contextlib.suppress(OSError), os.scandir(folder) as entries:
        for entry in entries:
            with contextlib.suppress(OSError):
                if entry.is_file(follow_symlinks=False) and store_name(entry.name):
                    found.append(entry.name)
    found.sort()
    if knowledge and _real_dir(folder / "brain") and _regular(folder / KNOWLEDGE):
        found.append(KNOWLEDGE)
    return found[:MAX_FILES]


def _read_nofollow(path: Path, limit: int = MAX_FILE) -> bytes:
    """The whole file, refusing a link and anything larger than limit."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as fh:
        data = fh.read(limit + 1)
    if len(data) > limit:
        raise BackupError(f"{path.name} is too large to back up.")
    return data


def _stamp(when: datetime) -> str:
    """As macOS names a screenshot: 2026-09-29 at 20.15.12 (a colon can't be in a name)."""
    return when.strftime("%Y-%m-%d at %H.%M.%S")


def _unique(folder: Path, base: str) -> Path:
    path = folder / f"{base}.zip"
    n = 2
    while os.path.lexists(path):
        path = folder / f"{base} {n}.zip"
        n += 1
    return path


def ensure_folder(folder: Path) -> Path:
    """The backup folder, made (owner only) when it isn't there. A link or a file in its
    place is refused: a backup goes where the owner can see it went."""
    if os.path.lexists(folder) and not _real_dir(folder):
        raise BackupError("The backup folder isn't a folder.")
    try:
        made = not folder.exists()
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        if made:
            os.chmod(folder, 0o700)  # the owner's alone, whatever the umask
    except OSError as exc:
        raise BackupError(f"The backup folder can't be made ({exc.strerror or exc}).") from exc
    return folder


def create(
    folder: Path,
    dest: Path,
    *,
    kind: str = "manual",
    knowledge: bool = False,
    clock: Callable[[], datetime] = datetime.now,
) -> dict[str, Any]:
    """Back the data folder up into a new zip in dest; what was made (see describe())."""
    if kind not in KINDS:
        raise ValueError(kind)
    ensure_folder(dest)
    files = collect(folder, knowledge)
    if not files:
        raise NothingToBackUp("There's nothing to back up yet.")
    now = clock()
    target = _unique(dest, f"Jarvis backup {_stamp(now)}{SUFFIX[kind]}")
    partial = target.with_name(f".{target.name}.part")
    rows: list[dict[str, Any]] = []
    total = 0
    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for rel in files:
                try:
                    data = _read_nofollow(folder / rel)
                except (OSError, BackupError) as exc:
                    log.warning("backup: skipped %s (%s)", rel, exc)
                    continue
                total += len(data)
                if total > MAX_TOTAL:
                    raise BackupError("The data folder is too large to back up.")
                info = zipfile.ZipInfo(DATA + rel, date_time=now.timetuple()[:6])
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o600) << 16
                zf.writestr(info, data)
                rows.append(
                    {"path": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                )
            if not rows:
                raise BackupError("None of the data files could be read.")
            manifest = {
                "format": FORMAT,
                "app": "jarvis",
                "kind": kind,
                "created": now.isoformat(timespec="seconds"),
                "knowledge": KNOWLEDGE in {r["path"] for r in rows},
                "files": rows,
            }
            info = zipfile.ZipInfo(MANIFEST, date_time=now.timetuple()[:6])
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            zf.writestr(info, json.dumps(manifest, indent=1))
        os.chmod(partial, 0o600)
        os.replace(partial, target)
    finally:
        with contextlib.suppress(OSError):
            partial.unlink()
    return describe(target, manifest)


def describe(path: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """A backup as the window lists it."""
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    files = manifest.get("files") if isinstance(manifest.get("files"), list) else []
    return {
        "name": path.name,
        "path": str(path),
        "created": str(manifest.get("created", ""))[:25],
        "kind": manifest.get("kind") if manifest.get("kind") in KINDS else "manual",
        "files": len(files),
        "size": size,
        "knowledge": manifest.get("knowledge") is True,
    }


def _manifest(zf: zipfile.ZipFile) -> dict[str, Any]:
    try:
        info = zf.getinfo(MANIFEST)
    except KeyError:
        raise BackupError("It isn't a Jarvis backup (it has no list of files).") from None
    if info.file_size > 4 * 1024 * 1024 or _zip_link(info):
        raise BackupError("Its list of files can't be read.")
    try:
        data = json.loads(zf.read(info).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, zipfile.BadZipFile, OSError):
        raise BackupError("Its list of files can't be read.") from None
    if not isinstance(data, dict) or data.get("app") != "jarvis":
        raise BackupError("It isn't a Jarvis backup (it has no list of files).")
    if not isinstance(data.get("format"), int) or data["format"] > FORMAT:
        raise BackupError("It was made by a newer version of Jarvis.")
    if not isinstance(data.get("files"), list) or len(data["files"]) > MAX_FILES:
        raise BackupError("Its list of files can't be read.")
    return data


def read_manifest(path: Path) -> dict[str, Any] | None:
    """The manifest alone (for the list), or None when it isn't a Jarvis backup."""
    try:
        with zipfile.ZipFile(path) as zf:
            return _manifest(zf)
    except (BackupError, zipfile.BadZipFile, OSError, ValueError):
        return None


def _zip_link(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _rows(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """The manifest's files, each checked: a path a restore may write, a size and a hash."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in manifest.get("files", []):
        if not isinstance(row, dict):
            raise BackupError("Its list of files can't be read.")
        rel = safe_rel(row.get("path"))
        if rel is None:
            name = str(row.get("path", ""))[:80]
            raise BackupError(f"{name} isn't a place a backup can restore to.")
        size, digest = row.get("size"), row.get("sha256")
        ok_size = isinstance(size, int) and not isinstance(size, bool) and 0 <= size <= MAX_FILE
        ok_hash = isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
        if not ok_size or not ok_hash or rel in seen:
            raise BackupError("Its list of files can't be read.")
        seen.add(rel)
        rows.append({"path": rel, "size": size, "sha256": digest})
    if sum(r["size"] for r in rows) > MAX_TOTAL:
        raise BackupError("It's too large to be a Jarvis backup.")
    return rows


def _check_entries(zf: zipfile.ZipFile, rows: list[dict[str, Any]]) -> None:
    listed = {DATA + r["path"] for r in rows} | {MANIFEST}
    for info in zf.infolist():
        if info.is_dir() and not _zip_link(info):
            continue
        if info.filename not in listed:
            raise BackupError("It holds files that aren't in its list.")
    for row in rows:
        try:
            info = zf.getinfo(DATA + row["path"])
        except KeyError:
            raise BackupError(f"{row['path']} is missing from it.") from None
        if _zip_link(info):
            raise BackupError(f"{row['path']} is a link, which a backup never holds.")
        if info.file_size != row["size"]:
            raise BackupError(f"{row['path']} doesn't match its checksum.")


def _stream(zf: zipfile.ZipFile, row: dict[str, Any], out: Any = None) -> None:
    """Read one file from the zip, checking its size and hash as it goes (and writing it to
    out, when given). A mismatch raises before anything is trusted."""
    digest = hashlib.sha256()
    seen = 0
    with zf.open(DATA + row["path"]) as src:
        while chunk := src.read(CHUNK):
            seen += len(chunk)
            if seen > row["size"]:
                raise BackupError(f"{row['path']} doesn't match its checksum.")
            digest.update(chunk)
            if out is not None:
                out.write(chunk)
    if seen != row["size"] or digest.hexdigest() != row["sha256"]:
        raise BackupError(f"{row['path']} doesn't match its checksum.")


def _open_zip(path: Path) -> zipfile.ZipFile:
    if not _regular(path):
        raise BackupError("That backup isn't there any more.")
    try:
        return zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise BackupError("It isn't a zip file, or it's damaged.") from None


def verify(path: Path) -> dict[str, Any]:
    """Read the whole backup back against its manifest: {"ok", "files", "problem",
    "manifest"}. Never raises."""
    try:
        with _open_zip(path) as zf:
            manifest = _manifest(zf)
            rows = _rows(manifest)
            _check_entries(zf, rows)
            for row in rows:
                _stream(zf, row)
    except BackupError as exc:
        return {"ok": False, "files": 0, "problem": str(exc), "manifest": None}
    except (zipfile.BadZipFile, OSError, ValueError, EOFError) as exc:
        log.warning("backup: %s couldn't be read (%s)", path.name, type(exc).__name__)
        return {"ok": False, "files": 0, "problem": "It isn't a zip file, or it's damaged."}
    return {"ok": True, "files": len(rows), "problem": "", "manifest": manifest}


def list_backups(folders: list[Path]) -> list[dict[str, Any]]:
    """The Jarvis backups in these folders, newest first. Other zips are left out."""
    found: dict[str, dict[str, Any]] = {}
    for folder in folders:
        try:
            with os.scandir(folder) as entries:
                names = sorted(
                    (e.name for e in entries if e.is_file(follow_symlinks=False)), reverse=True
                )
        except OSError:
            continue
        for name in [n for n in names if n.endswith(".zip") and not n.startswith(".")][:MAX_LISTED]:
            path = folder / name
            manifest = read_manifest(path)
            if manifest is not None and str(path) not in found:
                found[str(path)] = describe(path, manifest)
    return sorted(found.values(), key=lambda b: (b["created"], b["name"]), reverse=True)


def _hash_file(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as fh:
            while chunk := fh.read(CHUNK):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def preview(path: Path, folder: Path) -> dict[str, Any]:
    """What restoring this backup would change in the folder: the files it replaces, brings
    back and finds the same, the ones it never rolls back (keep), and the ones it doesn't
    hold, left as they are (left)."""
    checked = verify(path)
    if not checked["ok"]:
        return {"ok": False, "problem": checked["problem"]}
    manifest = checked["manifest"]
    rows = _rows(manifest)
    out: dict[str, list[str]] = {"replace": [], "add": [], "same": [], "keep": []}
    for row in rows:
        rel = row["path"]
        if rel in KEEP_ON_RESTORE:
            out["keep"].append(rel)
            continue
        current = folder / rel
        if not os.path.lexists(current):
            out["add"].append(rel)
        elif _hash_file(current) == row["sha256"]:
            out["same"].append(rel)
        else:
            out["replace"].append(rel)
    in_backup = {r["path"] for r in rows}
    left = [rel for rel in collect(folder, knowledge=True) if rel not in in_backup]
    return {"ok": True, "backup": describe(path, manifest), **out, "left": left, "problem": ""}


def _restore_dir(folder: Path) -> Path:
    return folder.joinpath(*RESTORE_DIR)


def _clear_dir(path: Path, folder: Path) -> None:
    """Remove one of ops/'s own folders (never through a link, never outside folder)."""
    if not os.path.lexists(path):
        return
    if not _real_dir(path) or folder.resolve() not in path.resolve().parents:
        raise BackupError("The restore folder isn't what Jarvis made.")
    shutil.rmtree(path)


def _make_dir(path: Path) -> None:
    """A folder of ops's own (inside the data folder), made owner-only; a link in its place
    is refused."""
    if os.path.lexists(path) and not _real_dir(path):
        raise BackupError("The restore folder isn't what Jarvis made.")
    if not os.path.lexists(path):
        path.mkdir(mode=0o700)
        os.chmod(path, 0o700)


def stage(
    path: Path,
    folder: Path,
    *,
    safety: str = "",
    clock: Callable[[], datetime] = datetime.now,
) -> dict[str, Any]:
    """Check the backup and unpack it beside the data (ops/restore/), for apply_pending() at
    the next start. Raises BackupError when it can't be restored."""
    staging = _restore_dir(folder)
    _clear_dir(staging, folder)
    _make_dir(staging.parent)
    _make_dir(staging)
    try:
        with _open_zip(path) as zf:
            manifest = _manifest(zf)
            every = _rows(manifest)
            _check_entries(zf, every)
            rows = [r for r in every if r["path"] not in KEEP_ON_RESTORE]
            for row in every:
                if row["path"] in KEEP_ON_RESTORE:
                    _stream(zf, row)  # checked all the same: a backup is whole or refused
                    continue
                target = staging / row["path"]
                if "/" in row["path"]:
                    _make_dir(target.parent)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out:
                    _stream(zf, row, out)
    except BaseException:
        with contextlib.suppress(OSError, BackupError):
            _clear_dir(staging, folder)
        raise
    pending = {
        "format": FORMAT,
        "backup": path.name,
        "created": str(manifest.get("created", ""))[:25],
        "staged": clock().isoformat(timespec="seconds"),
        "safety": safety,
        "files": rows,
    }
    fd = os.open(staging / PENDING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(pending, out, indent=1)
    return {k: v for k, v in pending.items() if k != "files"} | {"files": len(rows)}


def pending(folder: Path) -> dict[str, Any] | None:
    """The restore waiting for the next start, as the window shows it, or None."""
    marker = _restore_dir(folder) / PENDING
    if not _regular(marker):
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        return None
    return {
        "backup": str(data.get("backup", ""))[:200],
        "created": str(data.get("created", ""))[:25],
        "staged": str(data.get("staged", ""))[:25],
        "safety": str(data.get("safety", ""))[:200],
        "files": len(data["files"]),
    }


def cancel_pending(folder: Path) -> bool:
    staging = _restore_dir(folder)
    if not os.path.lexists(staging):
        return False
    _clear_dir(staging, folder)
    return True


def apply_pending(
    folder: Path, clock: Callable[[], datetime] = datetime.now
) -> dict[str, Any] | None:
    """At the start, before any store reads its file: move a staged restore into place.
    All of it or none of it: every staged file is checked against what was staged before
    the first one moves. The outcome is kept for the window (ops/restore-result.json).
    None when nothing was waiting. Never raises: the app starts either way."""
    staging = _restore_dir(folder)
    marker = staging / PENDING
    if not os.path.lexists(staging):
        return None
    result: dict[str, Any] = {"ok": False, "at": clock().isoformat(timespec="seconds")}
    try:
        if not _real_dir(staging) or not _regular(marker):
            raise BackupError("The restore folder isn't what Jarvis made.")
        data = json.loads(marker.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("files"), list):
            raise BackupError("The restore folder isn't what Jarvis made.")
        result["backup"] = str(data.get("backup", ""))[:200]
        result["created"] = str(data.get("created", ""))[:25]
        rows = _rows({"files": data["files"]})
        moves: list[tuple[Path, Path]] = []
        for row in rows:
            rel = row["path"]
            if rel in KEEP_ON_RESTORE:
                continue
            source = staging / rel
            if not _regular(source) or _hash_file(source) != row["sha256"]:
                raise BackupError(f"{rel} changed after it was checked.")
            target = folder / rel
            if "/" in rel and os.path.lexists(target.parent) and not _real_dir(target.parent):
                raise BackupError(f"{rel} isn't a place a backup can restore to.")
            if _is_link(target):
                raise BackupError(f"{rel} is a link, which a restore never writes through.")
            if os.path.lexists(target) and not _regular(target):
                raise BackupError(f"{rel} isn't a place a backup can restore to.")
            moves.append((source, target))
        result["files"] = 0
        for source, target in moves:
            if not os.path.lexists(target.parent):
                target.parent.mkdir(mode=0o700)
            os.replace(source, target)
            result["files"] += 1
            with contextlib.suppress(OSError):
                os.chmod(target, 0o600)
        result["ok"] = True
        log.info("restored %d files from %s", len(moves), result.get("backup", "a backup"))
    except (BackupError, OSError, ValueError) as exc:
        result["problem"] = str(exc) if isinstance(exc, BackupError) else "It couldn't be read."
        log.warning("the staged restore wasn't applied: %s", exc)
    finally:
        with contextlib.suppress(OSError, BackupError):
            _clear_dir(staging, folder)
    _save_result(folder, result)
    return result


def _save_result(folder: Path, result: dict[str, Any]) -> None:
    from ... import jsonstore

    try:
        _make_dir(folder / RESULT[0])
        jsonstore.save_json(folder.joinpath(*RESULT), result, backup=False)
    except (OSError, BackupError) as exc:
        log.warning("couldn't keep the restore's outcome (%s)", exc)


def take_result(folder: Path) -> dict[str, Any] | None:
    """The outcome of the restore applied at this start, once (it's removed as it's read)."""
    from ... import jsonstore

    path = folder.joinpath(*RESULT)
    try:
        data = jsonstore.load_json(path, dict)
    except jsonstore.Unreadable:
        return None
    with contextlib.suppress(OSError):
        path.unlink()
    if not isinstance(data, dict):
        return None
    keep = ("ok", "at", "backup", "created", "files", "problem")
    return {k: data[k] for k in keep if k in data and isinstance(data[k], str | int | bool)}


def prune(dest: Path, kind: str, keep: int | None = None) -> list[str]:
    """Remove the oldest backups of one kind (daily, safety) past the newest `keep`; what
    was removed. A manual backup is never removed, nor any zip that isn't a Jarvis backup
    of that kind."""
    if kind not in KEEP:
        return []
    keep = KEEP[kind] if keep is None else keep
    mine = [b for b in list_backups([dest]) if b["kind"] == kind]
    removed: list[str] = []
    for backup in mine[max(0, keep) :]:
        path = Path(backup["path"])
        if path.parent != dest or not _regular(path):
            continue
        try:
            path.unlink()
        except OSError as exc:
            log.warning("backup: couldn't remove an old one (%s)", exc)
            continue
        removed.append(backup["name"])
    return removed


def newest(backups: list[dict[str, Any]], kind: str | None = None) -> dict[str, Any] | None:
    return next((b for b in backups if kind is None or b["kind"] == kind), None)
