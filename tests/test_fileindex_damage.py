"""The file index after a bad write: damage a disk error or a crash mid-write leaves in its
pages, which only shows when they're read. The index is only a cache of what's on disk, so
a damaged one starts again, in place (a search reading it meanwhile is never left with a
deleted file), and "Forget my files" still erases it. Temp folders only."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from jarvis import fileindex
from jarvis.fileindex import FileIndex, _damaged

NOTES = 120


def indexed(tmp_path: Path) -> tuple[Path, Path, FileIndex]:
    home = tmp_path / "home"
    folder = home / "Documents" / "sub"
    folder.mkdir(parents=True)
    for i in range(NOTES):
        (folder / f"budget note {i}.md").write_text(f"budget plan for the board {i}")
    db = tmp_path / "files.db"
    index = FileIndex(db, [home / "Documents"], home=home, pdf_text=str, rich_text=str)
    assert index.refresh()["files"] == NOTES
    return home, db, index


def overwrite_pages(db: Path, tables: tuple[str, ...] = ("files", "files_dir")) -> None:
    """The root pages of these tables overwritten: the header and schema still read."""
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        page = conn.execute("PRAGMA page_size").fetchone()[0]
        marks = ", ".join("?" * len(tables))
        sql = f"SELECT rootpage FROM sqlite_master WHERE name IN ({marks})"
        roots = [r for (r,) in conn.execute(sql, tables)]
    with open(db, "r+b") as fh:
        for root in roots:
            fh.seek((root - 1) * page)
            fh.write(b"\xff" * page)


def reopened(home: Path, db: Path) -> FileIndex:
    return FileIndex(db, [home / "Documents"], home=home, pdf_text=str, rich_text=str)


def test_the_refresh_that_finds_the_damage_fills_the_index_again_at_once(tmp_path):
    home, db, _ = indexed(tmp_path)
    overwrite_pages(db)
    index = reopened(home, db)
    stats = index.refresh()
    assert "error" not in stats and stats["files"] == NOTES and stats["indexed"] == NOTES
    assert len(index.search("budget plan", 5)) == 5
    with sqlite3.connect(db) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert conn.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert conn.execute("PRAGMA user_version").fetchone() == (fileindex.SCHEMA_VERSION,)


def test_a_search_that_finds_the_damage_has_the_next_refresh_start_again(tmp_path):
    home, db, _ = indexed(tmp_path)
    overwrite_pages(db, ("files_fts_data",))  # the full-text index's own pages
    index = reopened(home, db)
    with pytest.raises(sqlite3.DatabaseError):
        index.search("budget plan", 5)
    stats = index.refresh()
    assert "error" not in stats and stats["indexed"] == NOTES  # all read again, in one go
    assert len(index.search("budget plan", 5)) == 5


def test_starting_again_never_deletes_the_file_from_under_a_reader(tmp_path):
    home, db, _ = indexed(tmp_path)
    overwrite_pages(db)
    inode = os.stat(db).st_ino
    reader = sqlite3.connect(db, isolation_level=None, check_same_thread=False)
    reader.execute("BEGIN")
    before = reader.execute("SELECT value FROM meta WHERE key = 'refreshed_at'").fetchone()
    index = reopened(home, db)
    assert "error" not in index.refresh()
    # the reader's snapshot holds, and once it ends the same file has the new index
    assert reader.execute("SELECT value FROM meta WHERE key = 'refreshed_at'").fetchone() == before
    reader.execute("COMMIT")
    assert reader.execute("SELECT count(*) FROM files").fetchone() == (NOTES,)
    reader.close()
    assert os.stat(db).st_ino == inode


def test_a_header_damaged_while_running_starts_again_too(tmp_path):
    home, db, index = indexed(tmp_path)  # the same index, already set up
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    with open(db, "r+b") as fh:
        fh.write(b"this is not a database at all" * 4)
    stats = index.refresh()
    assert "error" not in stats and stats["files"] == NOTES
    assert len(index.search("budget plan", 5)) == 5


def test_forget_my_files_erases_a_damaged_index_and_says_so(tmp_path):
    home, db, _ = indexed(tmp_path)
    overwrite_pages(db)
    index = reopened(home, db)
    assert index.clear() is True
    assert index.status()["files"] == 0
    on_disk = b"".join(p.read_bytes() for p in tmp_path.iterdir() if p.name.startswith("files.db"))
    assert b"budget plan for the board" not in on_disk
    assert index.refresh()["files"] == NOTES  # and it fills again from the files


def test_a_failure_that_isnt_damage_keeps_the_index(tmp_path, monkeypatch):
    home, db, index = indexed(tmp_path)

    def failing(*_args):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(index, "_walk", failing)
    assert "error" in index.refresh()
    assert not index._damage.is_set()
    monkeypatch.undo()
    assert index.status()["files"] == NOTES and len(index.search("budget plan", 5)) == 5


def test_what_counts_as_damage(tmp_path):
    home, db, _ = indexed(tmp_path)
    with sqlite3.connect(db) as conn:
        with pytest.raises(sqlite3.OperationalError) as missing:
            conn.execute("SELECT * FROM no_such_table")
    assert not _damaged(missing.value)
    assert not _damaged(sqlite3.OperationalError("database is locked"))
    assert not _damaged(OSError("disk full"))
    overwrite_pages(db)
    with sqlite3.connect(db) as conn, pytest.raises(sqlite3.DatabaseError) as corrupt:
        conn.execute("SELECT * FROM files WHERE dir = 'x'").fetchall()
    assert _damaged(corrupt.value)
    junk = tmp_path / "junk.db"
    junk.write_bytes(b"not a database " * 300)
    with sqlite3.connect(junk) as conn, pytest.raises(sqlite3.DatabaseError) as notadb:
        conn.execute("PRAGMA user_version").fetchone()
    assert _damaged(notadb.value)
