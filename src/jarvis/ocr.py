"""Text in screenshots and images, for the second brain.

The images in the folders the brain reads (Documents, Desktop and Downloads while Computer
files is on, and the folders added under Second brain) are read on this Mac by Apple's Vision
(native/jarvis-ocr.swift: accurate recognition, Simplified Chinese and English), newest first
and at most OCR_PER_BUILD new ones a rebuild within OCR_SECONDS, in the rebuild's own
low-priority process. What each image says is cached by a hash of its contents (TextCache),
so a screenshot moved or renamed is never read twice, and one read once is never read again.

Never read: the Photos library (no package is ever walked into: .photoslibrary, apps, Pages
documents…), anything in ~/Library, hidden files and folders, links, files named for what
they guard or kept in a folder that is (computer.is_sensitive and fileindex.SECRET_NAME), iCloud
files that aren't on this Mac, and images too small to hold text or too big to be a picture
of some. What's read has passwords, keys and card numbers blanked out before it's stored.
"""

from __future__ import annotations

import hashlib
import heapq
import logging
import os
import sqlite3
import stat
import time
from collections.abc import Callable, Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from .knowledge import Note

log = logging.getLogger("jarvis")

HELPER = "jarvis-ocr"
IMAGE_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".heic",
    ".heif",
    ".tif",
    ".tiff",
    ".gif",
    ".bmp",
    ".webp",
}
MIN_BYTES = 8 * 1024  # icons and thumbnails hold no text worth reading
MAX_BYTES = 40 * 1024 * 1024
CONSIDERED = 3000  # the newest images looked at in a rebuild
OCR_PER_BUILD = 300  # new ones read in a rebuild...
OCR_SECONDS = 200.0  # ...within this long (all sources share five minutes)
IMAGE_SECONDS = 30.0  # one image
MIN_TEXT = 12  # characters: less is a logo or a button, not text worth finding
MAX_TEXT = 20_000
SF_DATALESS = 0x40000000  # an iCloud file whose contents aren't on this Mac


class TextCache:
    """What files say, by a hash of their contents (texts), and each path's last known size,
    modified time and hash (files), so an unchanged file isn't even hashed again. SQLite in
    the brain's folder; a damaged one is started afresh (it's only a cache)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.conn = self._open()
        except sqlite3.DatabaseError:
            log.warning("second brain: %s was damaged; starting it afresh", self.path.name)
            for suffix in ("", "-wal", "-shm"):
                Path(f"{self.path}{suffix}").unlink(missing_ok=True)
            self.conn = self._open()

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS files "
            "(path TEXT PRIMARY KEY, size INTEGER, mtime REAL, key TEXT)"
        )
        conn.execute("CREATE TABLE IF NOT EXISTS texts (key TEXT PRIMARY KEY, text TEXT, at REAL)")
        conn.execute("SELECT count(*) FROM files").fetchone()  # damage shows here
        return conn

    def key_for(self, path: str, size: int, mtime: float) -> str | None:
        row = self.conn.execute(
            "SELECT key FROM files WHERE path = ? AND size = ? AND mtime = ?", (path, size, mtime)
        ).fetchone()
        return row[0] if row else None

    def text(self, key: str) -> str | None:
        row = self.conn.execute("SELECT text FROM texts WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def remember(self, path: str, size: int, mtime: float, key: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO files (path, size, mtime, key) VALUES (?, ?, ?, ?)",
            (path, size, mtime, key),
        )

    def store(self, key: str, text: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO texts (key, text, at) VALUES (?, ?, ?)",
            (key, text, time.time()),
        )

    def forget_missing(self, seen: set[str], roots: Iterable[Path]) -> None:
        """Paths under these roots that weren't found this time, and texts no path has."""
        prefixes = [f"{root}{os.sep}" for root in roots]
        gone = [
            (path,)
            for (path,) in self.conn.execute("SELECT path FROM files")
            if path not in seen and any(path.startswith(p) for p in prefixes)
        ]
        self.conn.executemany("DELETE FROM files WHERE path = ?", gone)
        self.conn.execute("DELETE FROM texts WHERE key NOT IN (SELECT key FROM files)")

    def commit(self) -> None:
        self.conn.commit()

    def close(self) -> None:
        try:
            self.conn.commit()
        finally:
            self.conn.close()


def content_key(path: Path, limit: int = MAX_BYTES) -> str:
    """A hash of a file's contents (read in blocks, never more than `limit` bytes)."""
    digest = hashlib.blake2b(digest_size=16)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
            raise OSError("not a plain file")
        left = limit
        while left > 0 and (block := fh.read(min(1 << 20, left))):
            digest.update(block)
            left -= len(block)
    return digest.hexdigest()


def _library(home: Path) -> Path:
    return home / "Library"


def walk_images(folder: Path, home: Path | None = None) -> Iterator[tuple[Path, os.stat_result]]:
    """The images under a folder with their stat: no packages (so never the Photos library),
    nothing in ~/Library, nothing hidden, linked, private or named for a secret."""
    from .computer import is_sensitive
    from .fileindex import DOC_PACKAGES, OPAQUE_PACKAGES, SECRET_NAME, SKIP_DIRS

    home = (home or Path.home()).resolve()
    library = _library(home)
    try:
        start = folder.resolve()
    except (OSError, RuntimeError):
        return
    if start == library or library in start.parents:
        return
    packages = OPAQUE_PACKAGES | DOC_PACKAGES
    stack = [str(start)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as listing:
                entries = sorted(listing, key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            if name.startswith(".") or entry.is_symlink() or SECRET_NAME.search(name):
                continue
            suffix = os.path.splitext(name)[1].lower()
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                # ~/Library on the way down too: the home folder can be a brain folder.
                if name not in SKIP_DIRS and suffix not in packages and entry.path != str(library):
                    stack.append(entry.path)
                continue
            if suffix not in IMAGE_SUFFIXES:
                continue
            path = Path(entry.path)
            if is_sensitive(path):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode) or not MIN_BYTES <= info.st_size <= MAX_BYTES:
                continue
            if getattr(info, "st_flags", 0) & SF_DATALESS:
                continue  # in iCloud, not on this Mac: reading it would download it
            yield path, info


Reader = Callable[[Path], str | None]  # an image's text; None when it couldn't be read now


class HelperReader:
    """`jarvis-ocr serve`, kept running for a rebuild: an image in, its text out."""

    def __init__(self, binary: Path, timeout: float = IMAGE_SECONDS) -> None:
        from .swift_helper import LineProcess

        self._process = LineProcess([str(binary), "serve"], timeout=timeout)

    def __call__(self, path: Path) -> str | None:
        answer = self._process.ask([{"path": str(path)}])[0]
        if not isinstance(answer, dict):
            return None
        if "text" in answer:
            return str(answer["text"])
        return ""  # Vision couldn't open it (not really an image): nothing to find there

    def close(self) -> None:
        self._process.close()


def helper_reader() -> HelperReader | None:
    from . import swift_helper

    binary = swift_helper.ensure(HELPER)
    return HelperReader(binary) if binary is not None else None


def collect_images(
    folders: list[Path],
    cache_path: Path,
    make_reader: Callable[[], Any] = helper_reader,
    *,
    home: Path | None = None,
    limit: int = OCR_PER_BUILD,
    seconds: float = OCR_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> list[Note]:
    """Notes for the images under these folders that have text in them: cached ones as
    they are, up to `limit` new ones read (newest first) in at most `seconds`."""
    from .fileindex import redact

    found: dict[str, tuple[Path, os.stat_result]] = {}
    for folder in folders:
        for path, info in walk_images(Path(folder), home):
            found.setdefault(str(path), (path, info))
    newest = heapq.nlargest(CONSIDERED, found.values(), key=lambda item: item[1].st_mtime)
    cache = TextCache(cache_path)
    reader: Any = None
    notes: list[Note] = []
    started, read, broken = clock(), 0, False
    try:
        for path, info in newest:
            where, size, mtime = str(path), int(info.st_size), float(info.st_mtime)
            key = cache.key_for(where, size, mtime)
            text = cache.text(key) if key else None
            if text is None:
                if broken or read >= limit or clock() - started > seconds:
                    continue  # the next rebuild reads it
                try:
                    key = key or content_key(path)
                except OSError:
                    continue
                cache.remember(where, size, mtime, key)
                text = cache.text(key)  # the same picture under another name: read already
                if text is None:
                    if reader is None:
                        reader = make_reader()
                        if reader is None:
                            broken = True
                            continue
                    try:
                        got = reader(path)
                    except Exception as exc:  # stalled or died: the rest wait a rebuild
                        log.info("second brain: reading text in images stopped (%s)", exc)
                        broken = True
                        continue
                    read += 1
                    if got is None:
                        continue
                    text = redact(got.strip()[: MAX_TEXT + 400])[:MAX_TEXT]
                    cache.store(key, text)
                    if read % 20 == 0:
                        cache.commit()
            if len(text) >= MIN_TEXT:
                notes.append(_note(path, info, text))
        cache.forget_missing(set(found), [Path(f) for f in folders])
    finally:
        if reader is not None and hasattr(reader, "close"):
            reader.close()
        cache.close()
    return notes


def _note(path: Path, info: os.stat_result, text: str) -> Note:
    return Note(
        id=f"image:{path}",
        source="images",
        title=path.stem[:120],
        text=f"Text in the image {path.name}:\n{text}",
        ref=str(path),
        group=path.parent.name,
        modified=datetime.fromtimestamp(info.st_mtime).isoformat(timespec="seconds"),
    )
