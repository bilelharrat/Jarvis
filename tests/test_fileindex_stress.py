"""The file index at its limits: the file cap, words most files have, pasted Chinese,
stopping, forgetting, and a schema from another version."""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from jarvis import fileindex
from jarvis.fileindex import MAX_TERMS, FileIndex, parse_query


def home_with(tmp_path, counts: dict[str, int]):
    home = tmp_path / "home"
    for root, count in counts.items():
        folder = home / root / "sub"
        folder.mkdir(parents=True)
        for i in range(count):
            (folder / f"{root} note {i}.md").write_text(f"{root} budget plan {i}")
    return home, [home / root for root in counts]


def per_root(index: FileIndex, home) -> dict[str, int]:
    with sqlite3.connect(index.path) as conn:
        paths = [p for (p,) in conn.execute("SELECT path FROM files")]
    real = os.path.realpath(home)
    out: dict[str, int] = {}
    for path in paths:
        root = os.path.relpath(path, real).split(os.sep)[0]
        out[root] = out.get(root, 0) + 1
    return out


def test_the_file_cap_leaves_every_root_a_share(tmp_path):
    counts = {"Documents": 300, "Desktop": 20, "Downloads": 60, "Projects": 80}
    home, roots = home_with(tmp_path, counts)
    index = FileIndex(
        tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str, max_files=200
    )
    stats = index.refresh()
    held = per_root(index, home)
    reserve = 200 // (fileindex.ROOT_RESERVE * len(roots))
    assert stats["capped"] and sum(held.values()) <= 200
    assert all(held.get(root, 0) >= min(reserve, count) for root, count in counts.items()), held


def test_a_word_most_files_have_is_not_ranked_over_every_match(tmp_path, monkeypatch):
    home, roots = home_with(tmp_path, {"Documents": 400})
    named = home / "Documents" / "sub" / "Budget plan for the board.md"  # indexed first
    named.write_text("the budget plan")
    os.utime(named, (1_000_000_000, 1_000_000_000))  # and years old
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    monkeypatch.setattr(fileindex, "RANK_ALL", 50)  # 401 files match: "most files"
    ranked: list[str] = []
    real = fileindex._ranked

    def ranking(conn, match, *rest):
        ranked.append(match)
        return real(conn, match, *rest)

    monkeypatch.setattr(fileindex, "_ranked", ranking)
    hits = index.search("budget plan", limit=20)
    assert len(hits) == 20
    assert ranked and all(m.startswith("{name}") for m in ranked)  # only the names ranked
    assert hits[0].name == "Budget plan for the board.md"  # not lost among the latest


def test_pasted_chinese_is_looked_up_as_a_few_pairs():
    sentence = "第三季度预算会议纪要收入增长董事会审议" * 20  # 400 characters, no spaces
    loose = parse_query(sentence).loose()
    assert loose.count(" OR ") + 1 <= MAX_TERMS
    assert '"第 三"' in loose and '"审 议"' in loose  # spread from one end to the other
    short = parse_query("季度预算会议纪要").loose()  # 7 pairs: every one
    assert short.count(" OR ") + 1 == 7 and '"纪 要"' in short


def test_counts_come_from_the_indexes_not_every_row(tmp_path):
    home, roots = home_with(tmp_path, {"Documents": 30})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    assert index.status()["files"] == 30
    with sqlite3.connect(index.path) as conn:
        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        assert fileindex._file_counts(conn) == (30, 0)
        conn.set_trace_callback(None)
        for sql in statements:  # each answered from an index, never by reading every row
            plan = str(conn.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall())
            assert "COVERING INDEX" in plan, plan


def test_a_stop_during_the_sweep_is_heeded(tmp_path):
    home, roots = home_with(tmp_path, {"Documents": 10, "Projects": 10})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    (home / "Projects").rename(tmp_path / "moved")  # a whole root's folders to sweep
    flag = {"stop": False}
    real = index._sweep

    def sweep(conn, run):
        flag["stop"] = True  # asked to stop just as the sweep begins
        real(conn, run)

    index._sweep = sweep
    index.refresh(should_stop=lambda: flag["stop"])
    assert per_root(index, home).get("Projects") == 10  # left for the next refresh
    index._sweep = real
    index.refresh()
    assert "Projects" not in per_root(index, home)


def test_a_stop_is_heeded_while_a_big_folder_empties(tmp_path, monkeypatch):
    home, roots = home_with(tmp_path, {"Documents": 100})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    for path in (home / "Documents" / "sub").iterdir():
        path.unlink()  # a whole folder emptied at once
    monkeypatch.setattr(fileindex, "BATCH_ROWS", 10)
    flag = {"stop": False}
    real = index._flush

    def flush(conn, run):
        if run.gone:
            flag["stop"] = True  # asked to stop just as the deletions begin
        real(conn, run)

    index._flush = flush
    index.refresh(should_stop=lambda: flag["stop"])
    assert per_root(index, home).get("Documents", 0) >= 90  # not all in one go
    index._flush = real
    index.refresh()
    assert "Documents" not in per_root(index, home)  # the rest go on the next refresh


def test_forgetting_says_so_when_a_reader_keeps_the_old_pages(tmp_path, monkeypatch):
    home, roots = home_with(tmp_path, {"Documents": 50})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    monkeypatch.setattr(fileindex, "BUSY_SECONDS", 0.2)
    monkeypatch.setattr(fileindex, "CLEAR_TRIES", 2)
    reader = sqlite3.connect(index.path, isolation_level=None, check_same_thread=False)
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM files_fts WHERE files_fts MATCH 'budget'").fetchone()
    assert index.clear() is False  # not erased yet, and it says so
    reader.execute("COMMIT")
    reader.close()
    assert index.clear() is True
    assert b"budget" not in (tmp_path / "files.db").read_bytes()


def test_an_index_from_another_version_starts_as_a_new_file(tmp_path):
    home, roots = home_with(tmp_path, {"Documents": 20})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    index.refresh()
    with sqlite3.connect(index.path) as conn:
        conn.execute(f"PRAGMA user_version = {fileindex.SCHEMA_VERSION - 1}")
    FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str).status()
    assert b"budget" not in (tmp_path / "files.db").read_bytes()  # nothing of the old one


def test_status_answers_while_another_thread_sets_the_index_up(tmp_path):
    """The window's hello asks for status() on the event loop; replacing an old version's
    index (a refresh thread, under the schema lock) mustn't hold it up."""
    home, roots = home_with(tmp_path, {"Documents": 5})
    index = FileIndex(tmp_path / "files.db", roots, home=home, pdf_text=str, rich_text=str)
    held, release = threading.Event(), threading.Event()

    def setting_up():
        with index._schema_lock:
            held.set()
            release.wait(10)

    worker = threading.Thread(target=setting_up)
    worker.start()
    pool = ThreadPoolExecutor(1)
    try:
        assert held.wait(5)
        status = pool.submit(index.status).result(timeout=2)
        assert status["files"] == 0 and status["state"] == "idle"
    finally:
        release.set()
        worker.join(10)
        pool.shutdown()
    index.refresh()
    assert index.status()["files"] == 5


def test_stopping_ends_a_stuck_spotlight_read_at_once(tmp_path, monkeypatch):
    home, roots = home_with(tmp_path, {"Documents": 1})
    for i in range(3):
        (home / "Documents" / f"report {i}.pdf").write_bytes(b"%PDF-1.4 fake")
    stuck = threading.Event()
    killed = []

    class Stuck:
        def __init__(self, cmd, **_kwargs):
            self.args, self.dead = cmd, False
            stuck.set()

        def communicate(self, timeout=None):
            if self.dead:
                return b"", b""
            threading.Event().wait(min(timeout or 0, 0.05))
            raise fileindex.subprocess.TimeoutExpired(self.args, timeout)

        def poll(self):
            return -9 if self.dead else None

        def kill(self):
            self.dead = True
            killed.append(self.args)

    monkeypatch.setattr(fileindex.subprocess, "Popen", Stuck)
    index = FileIndex(tmp_path / "files.db", roots, home=home)  # Spotlight's own reader
    flag = {"stop": False}
    done = {}
    worker = threading.Thread(
        target=lambda: done.update(index.refresh(should_stop=lambda: flag["stop"]))
    )
    worker.start()
    assert stuck.wait(10)
    begun = time.monotonic()
    flag["stop"] = True
    worker.join(10)
    assert not worker.is_alive() and time.monotonic() - begun < 2  # not SPOTLIGHT_SECONDS
    assert killed and done["stopped"]
