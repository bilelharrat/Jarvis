"""Stress round 2, what JARVIS knows and does on its own, at scale and under odd clocks: the
file index with a damaged database, routines after the Mac's clock was wrong, the
proactive watcher after the clock moves back (flying west), documents written from
Markdown with markers that never close, webhook calls that arrive together, and the
trigger engine's memory of routines that are gone. Temp folders only: no network, no
model, never the real calendar. scripts/stress_r2_knowledge_automation.py is the heavier
run (100,000 files, 30,000 notes, thousands of routines and timers).

Each test names the behavior that should hold; each failed when it was written."""

from __future__ import annotations

import asyncio
import sqlite3
import time
from datetime import datetime, timedelta

from jarvis import documents
from jarvis import webhooks as wh
from jarvis.connectors import MemoryVault
from jarvis.fileindex import FileIndex
from jarvis.proactive import Watcher
from jarvis.routines import RoutineStore
from jarvis.triggers import TriggerEngine

# ── the file index: a damaged database ──


def damaged_index(tmp_path, files: int = 300):
    """An index of `files` notes whose files table (and its folder index) took a bad write:
    the header and the schema still read, the rows don't ("database disk image is
    malformed"), as a disk error or a crash mid-write leaves one."""
    home = tmp_path / "home"
    folder = home / "Documents" / "sub"
    folder.mkdir(parents=True)
    for i in range(files):
        (folder / f"budget note {i}.md").write_text(f"budget plan for the board {i}")
    db = tmp_path / "files.db"
    index = FileIndex(db, [home / "Documents"], home=home, pdf_text=str, rich_text=str)
    assert index.refresh()["files"] == files
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        page = conn.execute("PRAGMA page_size").fetchone()[0]
        roots = [
            r
            for (r,) in conn.execute(
                "SELECT rootpage FROM sqlite_master WHERE name IN ('files', 'files_dir')"
            )
        ]
    with open(db, "r+b") as fh:
        for root in roots:
            fh.seek((root - 1) * page)
            fh.write(b"\xff" * page)
    return home, db


def test_a_damaged_file_index_is_built_again_not_left_failing_every_refresh(tmp_path):
    home, db = damaged_index(tmp_path)
    index = FileIndex(db, [home / "Documents"], home=home, pdf_text=str, rich_text=str)
    index.refresh()  # the next start: it may find the damage on this one…
    stats = index.refresh()  # …but by the next it has started again from the files
    assert "error" not in stats, stats
    assert stats["files"] == 300
    assert len(index.search("budget plan", 5)) == 5


def test_forget_my_files_erases_a_damaged_index(tmp_path):
    home, db = damaged_index(tmp_path)
    index = FileIndex(db, [home / "Documents"], home=home, pdf_text=str, rich_text=str)
    index.clear()  # Settings › Forget my files
    assert index.status()["files"] == 0
    on_disk = b"".join(p.read_bytes() for p in tmp_path.iterdir() if p.name.startswith("files.db"))
    assert b"budget plan for the board" not in on_disk


# ── routines after the Mac's clock was wrong ──


def test_a_routine_runs_again_once_a_clock_set_ahead_is_put_right(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    brief = store.add("Brief", "brief me", "daily", "07:00")
    tidy = store.add("Tidy", "tidy up", "interval", "", spec={"every": 30})
    brief.last_run = tidy.last_run = ""
    ran = store.take_due(datetime(2027, 10, 6, 7, 1))  # the clock a year ahead: they ran "then"
    assert {r.name for r in ran} == {"Brief", "Tidy"}
    mornings = [datetime(2026, 10, day, 7, 1) for day in (6, 7, 8)]  # the clock put right
    ran_after = [r.name for now in mornings for r in store.take_due(now)]
    assert "Brief" in ran_after, "the daily routine waits a year for the clock to catch up"
    assert "Tidy" in ran_after, "the every-30-minutes routine waits a year too"


# ── the proactive watcher after the clock moves back ──


async def test_the_watcher_reads_the_calendar_again_after_the_clock_moves_back(monkeypatch):
    real = time.monotonic
    elapsed = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: real() + elapsed[0])
    reads: list[datetime] = []
    meeting = {
        "id": "e1",
        "title": "Board review",
        "begin": datetime(2026, 10, 6, 9, 20),
        "end": datetime(2026, 10, 6, 10, 0),
        "location": "",
        "all_day": False,
    }

    async def events():
        reads.append(datetime.now())
        return [meeting] if len(reads) > 1 else []  # added to the calendar after the first look

    async def no_eta(_place):
        return None

    said = []
    watcher = Watcher(
        said.append, events=events, eta=no_eta, battery=lambda: None, weather=lambda: None
    )
    await watcher.tick(datetime(2026, 10, 6, 12, 0))  # in New York
    landed = datetime(2026, 10, 6, 9, 0)  # in San Francisco: the wall clock is 3 hours back
    for minute in range(20):  # a look every minute, as the watcher's loop makes them
        elapsed[0] += 60
        await watcher.tick(landed + timedelta(minutes=minute))
    assert len(reads) >= 2, "the calendar isn't read again until the wall clock passes noon"
    assert any(a.kind == "soon" for a in said), "the 9:20 meeting is never announced"


# ── documents from Markdown whose markers never close ──

DOCUMENT_SECONDS = 0.25  # 20,000 characters: a few milliseconds when it's linear
BLANKS = " \t" * 10_000  # a line of nothing but spaces and tabs (is it a table's separator?)


def _slow(fn, texts: dict[str, str]) -> list[str]:
    """The texts fn took too long over, with how long."""
    slow = []
    for name, text in texts.items():
        started = time.monotonic()
        fn(text)
        took = time.monotonic() - started
        if took >= DOCUMENT_SECONDS:
            slow.append(f"{name} ({len(text)} characters): {took:.2f}s")
    return slow


def test_a_documents_markdown_becomes_html_in_linear_time_whatever_never_closes():
    texts = {
        f"{unclosed!r} that never closes": "Notes " + unclosed * (20_000 // len(unclosed))
        for unclosed in ("*a ", "_a ", "[a")
    }
    texts["blanks after a table row"] = f"| a | b |\n{BLANKS}"
    assert not _slow(documents.markdown_html, texts)


def test_a_documents_markdown_becomes_plain_text_in_linear_time_whatever_never_closes():
    texts = {
        "'*a ' that never closes": "Notes " + "*a " * 6_666,
        "'[a' that never closes": "Notes " + "[a" * 10_000,
        "a line of blanks": f"Notes\n{BLANKS}",
    }
    assert not _slow(documents.markdown_text, texts)


# ── webhook calls that arrive together ──


class SlowBody:
    """A POST whose body is still on its way when the next one arrives (what Starlette's
    request.stream() is to handle(), for calls made at once)."""

    def __init__(self, token: str) -> None:
        self.headers = {"host": "127.0.0.1:8123", "x-jarvis-token": token}
        self.query_params: dict[str, str] = {}

    async def stream(self):
        await asyncio.sleep(0.01)
        yield b'{"build": 42, "status": "failed"}'


async def test_a_webhooks_hourly_limit_holds_for_calls_that_arrive_together(tmp_path):
    handed: list[str] = []
    hooks = wh.Webhooks(tmp_path / "webhooks.json", MemoryVault(), lambda _h, t: handed.append(t))
    await hooks.add("ci")
    hooks.update("ci", per_hour=3)
    token = await hooks.token("ci")
    answers = await asyncio.gather(*(hooks.handle("ci", SlowBody(token)) for _ in range(20)))
    accepted = [status for status, _body in answers if status == 202]
    assert len(accepted) <= 3, f"{len(accepted)} of 20 accepted with a limit of 3 an hour"
    assert len(handed) <= 3


# ── the trigger engine's memory of routines that are gone ──


class Routine:
    def __init__(self, ident: str) -> None:
        self.id, self.kind, self.enabled = ident, "event", True
        self.spec = {"trigger": {"type": "mail", "from": "ann@example.com"}, "debounce": 5}


async def test_the_trigger_engine_forgets_routines_that_were_deleted(tmp_path):
    routines = [Routine(f"r{i}") for i in range(50)]
    engine = TriggerEngine(lambda: list(routines), lambda _r, _c: None, tmp_path / "t.json")
    now = datetime(2026, 10, 6, 9, 0)
    for routine in routines:
        assert engine._allowed(routine, now)  # each fired once (an email rule's email came)
    routines.clear()  # every one of them deleted since
    for minute in range(3):
        await engine.tick(now + timedelta(minutes=minute))
    engine._dirty = True
    engine.save()
    kept = TriggerEngine(lambda: [], lambda _r, _c: None, tmp_path / "t.json").state  # its file
    assert not kept["last"] and not kept["counts"], (
        f"{len(kept['last'])} deleted routines still kept"
    )
