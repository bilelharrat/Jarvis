"""Stress round 2 on what JARVIS knows and does on its own, at sizes past real use: the file
index over a tree of 100,000 files (built, refreshed unchanged, searched, refreshed while
files come and go, damaged), the second brain with tens of thousands of notes, thousands
of routines and timers, the clock set wrong and moved back, documents from Markdown whose
markers never close, a burst of webhook calls, and the text helpers fed long input.

Nothing here reaches the network, a model or the owner's data: everything lives in a temp
folder (under 300 MB at the default sizes) that is deleted at the end.

    uv run python scripts/stress_r2_knowledge_automation.py            # every part
    uv run python scripts/stress_r2_knowledge_automation.py files      # one of them
    STRESS_FILES=20000 uv run python scripts/stress_r2_knowledge_automation.py files

Parts:
- files: STRESS_FILES files (100,000; four in five empty, so the tree stays small), how
  long the first and an unchanged refresh take, the event loop's worst lag while a refresh
  runs on its thread, search and status latency, three refreshes while another thread adds
  and deletes files (the index must match the disk after), then a damaged page: the index
  must come back by itself.
- brain: STRESS_NOTES notes (20,000) of 700 words: build, save, the event loop's lag while
  a load runs on a thread, search latency.
- routines: STRESS_ROUTINES routines (3,000) of every kind: load, the routine clock's look,
  Settings' list; then the clock a year ahead and put right (routines must run again), and
  the proactive watcher after the clock moves back three hours (the calendar must be read
  again).
- timers: 10,000 timers in the file (a hand edit; the app sets 50 at most): load, list,
  everything going off at once.
- markdown: documents' Markdown with *, _ and [ that never close, at growing sizes, and the
  event loop's lag while one is converted on a thread (the regex engine keeps the GIL).
- webhooks: 50 calls at once to a hook allowed 3 an hour.
- text: every text helper of these features fed 4,000 and 16,000 characters of each of a
  few dozen shapes; anything that grows more than 9x is named.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import resource
import shutil
import signal
import sqlite3
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

RESULTS: list[tuple[str, bool, str]] = []
WORDS = (
    "budget plan quarterly board deck okin acme invoice tax receipt contract design roadmap "
    "hiring offer lease garden rain oakland biscuit"
).split()


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}", flush=True)
    return ok


def note(text: str) -> None:
    print(f"      {text}", flush=True)


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS


class Lag:
    """The event loop's worst delay while something runs: a ticker measuring its own sleeps."""

    def __init__(self) -> None:
        self.worst = 0.0
        self._stop = False
        self._task: asyncio.Task | None = None

    async def _tick(self) -> None:
        while not self._stop:
            started = time.monotonic()
            await asyncio.sleep(0.01)
            self.worst = max(self.worst, time.monotonic() - started - 0.01)

    async def __aenter__(self) -> Lag:
        self._task = asyncio.create_task(self._tick())
        await asyncio.sleep(0)  # the ticker is asleep, and timing, before the work starts
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self._stop = True
        if self._task is not None:
            await self._task


def timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    started = time.monotonic()
    out = fn()
    return out, time.monotonic() - started


# ── the file index ──


def make_tree(docs: Path, count: int, per: int = 100) -> None:
    for d in range(max(1, count // per)):
        folder = docs / f"{WORDS[d % len(WORDS)]} folder {d}"
        folder.mkdir(parents=True)
        for i in range(per):
            name = f"{WORDS[(d + i) % len(WORDS)]} {WORDS[(d * 7 + i) % len(WORDS)]} {d}-{i}.md"
            path = folder / name
            if (d * per + i) % 5 == 0:  # a few words in one file in five; the rest are names
                path.write_text(f"{WORDS[i % len(WORDS)]} notes about {WORDS[d % len(WORDS)]}")
            else:
                path.touch()


async def files_part(root: Path) -> None:
    from jarvis.fileindex import FileIndex, _in_thread

    count = int(os.environ.get("STRESS_FILES", "100000"))
    home = root / "home"
    docs = home / "Documents"
    _, took = timed(lambda: make_tree(docs, count))
    note(f"made {count} files in {took:.1f}s")
    db = root / "files.db"
    index = FileIndex(db, [docs], home=home, pdf_text=str, rich_text=str)
    async with Lag() as lag:
        started = time.monotonic()
        stats = await _in_thread(index.refresh)
        took = time.monotonic() - started
    check(
        f"{count} files indexed",
        stats.get("files") == count and "error" not in stats,
        f"{took:.1f}s, worst event-loop lag {lag.worst * 1000:.0f} ms, db "
        f"{db.stat().st_size / 1e6:.0f} MB",
    )
    async with Lag() as lag:
        started = time.monotonic()
        stats = await _in_thread(index.refresh)
        took = time.monotonic() - started
    check(
        "an unchanged refresh only compares",
        stats.get("indexed") == 0 and took < 10,
        f"{took:.1f}s, lag {lag.worst * 1000:.0f} ms",
    )
    worst = 0.0
    for query in ("budget", "budget plan", "okin 42-7", "notes about acme", "folder", "zzz"):
        _, took = timed(lambda q=query: index.search(q, 20))
        worst = max(worst, took)
    _, related = timed(lambda: index.related("Okin board review", ["Ann Lee"], 30, 10))
    _, status = timed(index.status)
    check(
        "searches stay quick",
        worst < 0.5,
        f"worst search {worst * 1000:.0f} ms, related {related * 1000:.0f} ms, "
        f"status {status * 1000:.0f} ms",
    )

    folders = sorted(docs.iterdir())
    stop = threading.Event()
    done = [0]

    def churn() -> None:
        rnd = random.Random(1)
        while not stop.is_set():
            folder = rnd.choice(folders)
            try:
                kids = list(folder.iterdir())
                if kids and rnd.random() < 0.5:
                    rnd.choice(kids).unlink()
                else:
                    (folder / f"new {done[0]}.md").write_text("fresh budget")
                if rnd.random() < 0.01:
                    shutil.rmtree(folder)
                    folder.mkdir()
            except OSError:
                pass
            done[0] += 1

    thread = threading.Thread(target=churn)
    thread.start()
    errors = []
    try:
        for _ in range(3):
            stats = await _in_thread(index.refresh)
            if stats.get("error"):
                errors.append(stats["error"])
            index.search("budget", 20)
    finally:
        stop.set()
        thread.join()
    stats = index.refresh()
    real = sum(1 for _ in docs.rglob("*.md"))
    check(
        "refreshes while files come and go: never an error, and the index matches the disk",
        not errors and stats.get("files") == real,
        f"{done[0]} changes, index {stats.get('files')} files, disk {real}",
    )

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
        for rootpage in roots:
            fh.seek((rootpage - 1) * page)
            fh.write(b"\xff" * page)
    again = FileIndex(db, [docs], home=home, pdf_text=str, rich_text=str)
    first, second = again.refresh(), again.refresh()
    check(
        "a damaged index comes back by itself",
        "error" not in second and second.get("files") == real,
        f"refreshes after the damage: {first.get('error') or 'ok'}, {second.get('error') or 'ok'}",
    )
    try:
        again.clear()
        cleared = "ok"
    except sqlite3.Error as exc:
        cleared = f"{type(exc).__name__}: {exc}"
    check("forget my files works on a damaged index", cleared == "ok", cleared)
    note(f"peak RSS {rss_mb():.0f} MB")


# ── the second brain ──


async def brain_part(root: Path) -> None:
    from jarvis.knowledge import KnowledgeBase, Note

    count = int(os.environ.get("STRESS_NOTES", "20000"))
    rnd = random.Random(1)
    vocab = [f"w{i}" for i in range(20000)] + WORDS
    notes = [
        Note(
            f"n{i}",
            "notes" if i % 2 else "files",
            f"Note {i} {rnd.choice(vocab)}",
            " ".join(rnd.choice(vocab) for _ in range(700)),
            f"ref{i}",
            modified="2026-09-01T10:00:00",
        )
        for i in range(count)
    ]
    kb = KnowledgeBase(root / "brain" / "index.json")
    _, built = timed(lambda: kb.build({"notes": notes}))
    _, saved = timed(kb.save)
    size = (root / "brain" / "index.json").stat().st_size / 1e6
    note(f"{count} notes: built {built:.1f}s, saved {saved:.1f}s, {size:.0f} MB")
    worst = 0.0
    for query in ("budget plan", "okin board deck", "garden rain oakland", "w1 w2 w3 w4 w5 w6"):
        _, took = timed(lambda q=query: kb.search(q, 6))
        worst = max(worst, took)
    fresh = KnowledgeBase(root / "brain" / "index.json")
    async with Lag() as lag:
        started = time.monotonic()
        await asyncio.to_thread(fresh.load)
        loaded = time.monotonic() - started
    check(
        "the brain loads and searches at size",
        len(fresh.notes) == count and worst < 1.0 and lag.worst < 0.5,
        f"load {loaded:.2f}s (worst event-loop lag {lag.worst * 1000:.0f} ms), worst search "
        f"{worst * 1000:.0f} ms, peak RSS {rss_mb():.0f} MB",
    )


# ── routines and the clock ──


async def routines_part(root: Path) -> None:
    from jarvis.proactive import Watcher
    from jarvis.routines import RoutineStore

    count = int(os.environ.get("STRESS_ROUTINES", "3000"))
    kinds = [
        lambda i: ("daily", f"{i % 24:02d}:{i % 60:02d}", {}, None),
        lambda i: ("weekly", "07:00", {}, [i % 7]),
        lambda i: ("interval", "", {"every": 30 + i % 60, "start": "08:00", "end": "20:00"}, None),
        lambda i: ("monthly", "09:00", {"day": 1 + i % 28}, None),
        lambda i: ("cron", "", {"cron": f"{i % 60} {i % 24} * * 1-5", "tz": "Asia/Tokyo"}, None),
        lambda i: ("cron", "", {"cron": "0 9 29 2 *"}, None),
        lambda i: ("event", "", {"trigger": {"type": "mail", "from": f"p{i}@example.com"}}, None),
    ]
    rows = []
    maker = RoutineStore(root / "seed.json")
    for i in range(count):
        kind, at, spec, days = kinds[i % len(kinds)](i)
        maker.items = []  # made by add() one at a time (it saves the whole file each time)
        routine = maker.add(f"{kind} {i}", "do the thing", kind, at, days=days, spec=spec)
        rows.append(asdict(routine))
    (root / "routines.json").write_text(json.dumps(rows))
    store, loaded = timed(lambda: RoutineStore(root / "routines.json"))
    due, looked = timed(lambda: store.take_due(datetime(2026, 10, 6, 9, 0)))
    listed, public = timed(store.public)
    check(
        f"{count} routines: the clock's look and Settings' list stay quick",
        looked < 0.5 and public < 1.0,
        f"load {loaded * 1000:.0f} ms, look {looked * 1000:.0f} ms ({len(due)} due), list "
        f"{public * 1000:.0f} ms ({len(json.dumps(listed)) / 1e6:.1f} MB)",
    )

    clock = RoutineStore(root / "clock.json")
    brief = clock.add("Brief", "brief me", "daily", "07:00")
    brief.last_run = ""
    clock.take_due(datetime(2027, 10, 6, 7, 1))
    ran = [r.name for day in (6, 7, 8) for r in clock.take_due(datetime(2026, 10, day, 7, 1))]
    check("a routine runs again once a clock set a year ahead is put right", bool(ran), f"{ran}")

    reads: list[int] = []

    async def events() -> list[dict[str, Any]]:
        reads.append(1)
        return []

    async def no_eta(_place: str) -> None:
        return None

    watcher = Watcher(
        lambda _a: None, events=events, eta=no_eta, battery=lambda: None, weather=lambda: None
    )
    await watcher.tick(datetime(2026, 10, 6, 12, 0))
    for minute in range(30):
        await watcher.tick(datetime(2026, 10, 6, 9, 0) + timedelta(minutes=minute))
    check(
        "the watcher reads the calendar again after the clock moves back three hours",
        len(reads) >= 2,
        f"{len(reads)} reads in 30 looks",
    )


# ── timers ──


async def timers_part(root: Path) -> None:
    from jarvis import timers

    now = datetime(2026, 10, 6, 9, 0)
    rows = []
    for i in range(10_000):
        if i % 3 == 0:
            made = timers.new_timer(60 + i, f"t{i}", now)
        elif i % 3 == 1:
            made = timers.new_alarm(f"{(9 + i % 10) % 24:02d}:{i % 60:02d}", f"a{i}", now)
        else:
            made = timers.new_reminder(f"r{i}", now, every_minutes=20)
        rows.append(asdict(made))
    (root / "timers.json").write_text(json.dumps(rows))
    said: list[Any] = []
    clock = timers.Timers(root / "timers.json", lambda a, _b: said.append(a), now=lambda: now)
    clock.play = lambda _sound: None
    _, loaded = timed(lambda: clock.store.items)
    _, listed = timed(clock.public)
    later = now + timedelta(hours=1)
    fired, took = timed(lambda: clock.fire_due(later))
    clock.close()
    await asyncio.sleep(0)
    check(
        "10,000 timers in the file: loaded, listed and fired without a stall past a second",
        took < 1.0 and listed < 1.0,
        f"load {loaded * 1000:.0f} ms, list {listed * 1000:.0f} ms, fire {took * 1000:.0f} ms "
        f"({len(fired)} went off, {len(said)} said)",
    )


# ── documents' Markdown ──


async def markdown_part(_root: Path) -> None:
    from jarvis import documents

    for unclosed in ("*a ", "_a ", "[a"):
        times = []
        for size in (5_000, 10_000, 20_000):
            text = "Notes " + unclosed * (size // len(unclosed))
            _, took = timed(lambda t=text: documents.markdown_html(t))
            times.append(took)
        check(
            f"markdown_html with {unclosed!r} that never closes grows linearly",
            times[-1] < 8 * times[0] + 0.01,
            " -> ".join(f"{t * 1000:.0f} ms" for t in times) + " for 5k, 10k, 20k characters",
        )
    blank = " \t" * 8_000  # a line of nothing but spaces and tabs: a table's separator?
    times = []
    for size in (4_000, 8_000, 16_000):
        _, took = timed(lambda n=size: documents.markdown_text(f"Notes\n{blank[:n]}"))
        times.append(took)
    check(
        "markdown_text with a long line of blanks grows linearly",
        times[-1] < 8 * times[0] + 0.01,
        " -> ".join(f"{t * 1000:.0f} ms" for t in times) + " for 4k, 8k, 16k characters",
    )
    text = "Notes " + "*a " * 20_000
    async with Lag() as lag:
        started = time.monotonic()
        await asyncio.to_thread(documents.markdown_text, text)
        took = time.monotonic() - started
    check(
        "a document converted on a thread never holds the event loop",
        lag.worst < 0.5,
        f"60,000 characters: {took:.1f}s, worst event-loop lag {lag.worst:.1f}s",
    )


# ── webhooks ──


async def webhooks_part(root: Path) -> None:
    from jarvis import webhooks as wh
    from jarvis.connectors import MemoryVault

    class Slow:
        def __init__(self, token: str) -> None:
            self.headers = {"host": "127.0.0.1:8123", "x-jarvis-token": token}
            self.query_params: dict[str, str] = {}

        async def stream(self):
            await asyncio.sleep(0.01)
            yield b'{"build": 42}'

    handed: list[str] = []
    hooks = wh.Webhooks(root / "webhooks.json", MemoryVault(), lambda _h, t: handed.append(t))
    await hooks.add("ci")
    hooks.update("ci", per_hour=3)
    token = await hooks.token("ci")
    answers = await asyncio.gather(*(hooks.handle("ci", Slow(token)) for _ in range(50)))
    accepted = sum(1 for status, _ in answers if status == 202)
    check("50 calls at once to a hook allowed 3 an hour", accepted <= 3, f"{accepted} accepted")


# ── the text helpers ──


async def text_part(_root: Path) -> None:
    from jarvis import (
        about_me,
        commitments,
        documents,
        fileindex,
        intents,
        knowledge,
        memory,
        people,
        suggestions,
        wiki,
    )

    helpers: dict[str, Callable[[str], Any]] = {
        "people.names_in": people.names_in,
        "people.tokens": people.tokens,
        "wiki.mentions_in": wiki.mentions_in,
        "wiki.claims": wiki.claims,
        "wiki._journal_lines": wiki._journal_lines,
        "commitments.promising": commitments.promising,
        "intents.guess_parts": intents.guess_parts,
        "about_me.tidy": about_me.tidy,
        "memory.guess_category": memory.guess_category,
        "memory._SECRET": memory._SECRET.search,
        "fileindex.redact": fileindex.redact,
        "fileindex.parse_query": fileindex.parse_query,
        "fileindex.html_text": fileindex.html_text,
        "knowledge.tokens": knowledge.tokens,
        "suggestions.request_key": suggestions.request_key,
        "suggestions.due_date": lambda t: suggestions.due_date(t, datetime(2026, 10, 5, 9)),
        "documents.markdown_html": documents.markdown_html,
        "documents.markdown_text": documents.markdown_text,
    }
    shapes = [
        "a", "Ann ", "Ann Lee Bob Chen ", "*a ", "_a ", "(", "[a", "1 ", "Mr. ", "http://x",
        "预算会议", '"a ', "a-", "a'", " \t", "a\n", "#", "| ", "<a ", "&", "a: ", "a@b.",
        "sk-", "password ", "code 1 ", "by Friday ", "Ann, ",
    ]  # fmt: skip

    def alarm(*_a: Any) -> None:
        raise TimeoutError

    signal.signal(signal.SIGALRM, alarm)
    grew = []
    for name, fn in helpers.items():
        for shape in shapes:
            times = []
            for size in (4000, 16000):
                text = (shape * (size // len(shape) + 1))[:size]
                signal.alarm(20)
                started = time.monotonic()
                try:
                    fn(text)
                except TimeoutError:
                    times.append(99.0)
                    break
                except Exception as exc:  # a refusal is an answer too: only the time counts
                    del exc
                finally:
                    signal.alarm(0)
                times.append(time.monotonic() - started)
            if times[-1] > 0.05 and times[-1] > 9 * max(times[0], 1e-4):
                grew.append(f"{name} {shape!r}: {times[0] * 1000:.0f} -> {times[-1] * 1000:.0f} ms")
    check("every text helper is linear in its input", not grew, "; ".join(grew))


PARTS: dict[str, Callable[[Path], Any]] = {
    "files": files_part,
    "brain": brain_part,
    "routines": routines_part,
    "timers": timers_part,
    "markdown": markdown_part,
    "webhooks": webhooks_part,
    "text": text_part,
}


async def main(names: list[str]) -> int:
    logging.basicConfig(level=logging.CRITICAL)  # damaged files are logged, by design
    for name in names or list(PARTS):
        print(f"== {name}", flush=True)
        root = Path(tempfile.mkdtemp(prefix=f"stress-r2-{name}-"))
        try:
            await PARTS[name](root)
        finally:
            shutil.rmtree(root, ignore_errors=True)
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
