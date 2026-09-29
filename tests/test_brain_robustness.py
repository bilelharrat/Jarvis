"""The second brain under stress: other languages, odd saved indexes, secrets, files that
never finish reading, a rebuild that hangs, and reloads that must not stall the app."""

import asyncio
import contextlib
import gc
import json
import os
import subprocess
import sys
import textwrap
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from test_hub import make_hub

from jarvis import (
    fileindex,  # noqa: F401 - imported up front, not timed in a test
    knowledge,
)
from jarvis import hub as hub_module
from jarvis.knowledge import (
    Collector,
    KnowledgeBase,
    Note,
    collect_folder,
    layout,
    read_document,
    tokens,
)


def note(i, title, text, source="files"):
    return Note(id=f"{source}:{i}", source=source, title=title, text=text, ref=str(i))


CORPUS = [
    note(1, "Sourdough starter", "Feed the sourdough starter flour and water daily; bake bread."),
    note(2, "Bread baking temps", "Bake the sourdough bread at 250C with steam, then lower."),
    note(3, "ZaiNar risks", "Key risks: RF positioning adoption, telecom sales cycles, capital."),
    note(4, "Wi-Fi positioning", "Positioning over Wi-Fi and 5G networks; RF phase sync patents."),
    note(5, "Marathon plan", "Long run on Sunday, tempo run Tuesday, rest on Monday."),
    note(6, "Running shoes", "Rotate running shoes for the marathon; long run mileage."),
]


# ── other languages ──


def test_chinese_japanese_and_accented_notes_are_found(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build(
        {
            "notes": [
                note(1, "季度预算会议", "第三季度预算会议纪要：收入增长，董事会审议。", "notes"),
                note(2, "会議メモ", "来週の取締役会の議題と予算。", "notes"),
                note(3, "Café résumé", "From the café: my résumé and the Zürich trip.", "notes"),
                note(4, "Sum of costs", "The sum of all costs this month.", "notes"),
                note(5, "Rich list", "The rich list for 2026.", "notes"),
                note(6, "税务申报", "今年的税务申报材料放在这里。", "notes"),
                note(7, "Ｑ３ ｂｏａｒｄ", "Full-width letters from a Chinese keyboard.", "notes"),
            ]
        }
    )

    def top(query):
        hits = kb.search(query)
        return hits[0]["id"] if hits else None

    assert top("预算") == "notes:1"
    assert top("董事会审议") == "notes:1"
    assert top("取締役会") == "notes:2"
    assert top("税") == "notes:6"  # one character is a word too
    assert top("找一下关于税务的笔记") == "notes:6"  # a spoken sentence, no spaces
    for query in ("résumé", "resume", "Zürich", "zurich", "CAFÉ"):
        assert top(query) == "notes:3", query
    # Accented words were cut apart: résumé was searched as "sum", Zürich as "rich".
    assert tokens("Zürich résumé") == ["zurich", "resume"]
    assert "notes:4" not in {h["id"] for h in kb.search("résumé")}
    assert "notes:5" not in {h["id"] for h in kb.search("Zürich")}
    assert top("q3 board") == "notes:7"
    assert "预算" in kb.search("预算")[0]["excerpt"]
    # The galaxy can name a cluster of Chinese notes.
    texts = [f"预算会议 第{i}次 讨论收入" for i in range(8)] + [
        f"marathon run {i}" for i in range(8)
    ]
    _, _, clusters = layout(texts, ["notes"] * 16)
    assert any("预算" in c["label"] or "会议" in c["label"] for c in clusters)


def test_a_pasted_page_is_searched_by_its_telling_words(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": CORPUS})
    page = ("the quick report about budgets and plans " * 3000) + " sourdough"
    started = time.perf_counter()
    hits = kb.search(page)
    assert time.perf_counter() - started < 1.0
    assert hits == [] or hits[0]["id"].startswith("files:")


def test_a_long_query_uses_its_rarest_words(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    common = " ".join(f"word{i}" for i in range(30))  # words every note has
    kb.build(
        {
            "notes": [note(i, f"Note {i}", common, "notes") for i in range(20)]
            + [note(99, "Trip", f"{common} zanzibar", "notes")]
        }
    )
    # 31 words, of which a search keeps the 12 rarest: the one that tells notes apart.
    assert kb.search(f"{common} zanzibar")[0]["id"] == "notes:99"


def test_a_pasted_page_as_a_query_is_capped_not_scanned(tmp_path):
    page = " ".join(f"w{i}x" for i in range(2000))  # every word in every note
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"notes": [note(i, f"Note {i}", page, "notes") for i in range(300)]})
    kb.search("warm up")
    started = time.monotonic()
    assert kb.search(page)
    assert time.monotonic() - started < 0.1  # every word's postings: 0.35 s and more


# ── the saved index ──


def _saved(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": CORPUS})
    kb.save()
    return tmp_path / "index.json"


@pytest.mark.parametrize(
    "change, notes",
    [
        (lambda d: d["notes"][0].update(pinned=True), 6),  # a field from a newer version
        (lambda d: d["notes"][0].pop("group"), 6),  # an optional one missing
        (lambda d: d["notes"][0].pop("ref"), 5),  # a required one missing: that note goes
        (lambda d: d["notes"][0].update(text=None), 5),
        (lambda d: d.update(positions=[0.1, 0.2]), 6),  # positions not in threes
        (lambda d: d.update(positions=d["positions"][:2]), 6),  # fewer positions than notes
        (lambda d: d.update(edges=[[0, 99], [1, 2], "x"]), 6),
    ],
)
def test_a_saved_index_from_another_version_still_loads(tmp_path, change, notes):
    store = _saved(tmp_path)
    data = json.loads(store.read_text())
    change(data)
    store.write_text(json.dumps(data))
    kb = KnowledgeBase(store)
    assert kb.load()
    galaxy = kb.galaxy()
    assert len(galaxy["nodes"]) == notes == kb.summary()["notes"]
    assert all(len(n["p"]) == 3 for n in galaxy["nodes"])
    assert all(0 <= a < notes and 0 <= b < notes for a, b in galaxy["edges"])
    assert kb.search("marathon")


@pytest.mark.parametrize(
    "raw",
    ['[{"notes": []}]', '{"notes": {"a": 1}}', "{", "null", "[" * 100_000 + "]" * 100_000],
)
def test_a_saved_index_that_is_not_one_leaves_the_brain_empty(tmp_path, raw):
    (tmp_path / "index.json").write_text(raw)
    kb = KnowledgeBase(tmp_path / "index.json")
    assert kb.load() is False  # never raises: Hub.__init__ and brain_build both call it
    assert kb.summary()["notes"] == 0 and kb.search("anything") == [] and kb.age_hours() > 24


def test_galaxy_positions_are_short_numbers(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": CORPUS})
    assert all(round(v, 4) == v for n in kb.galaxy()["nodes"] for v in n["p"])
    assert kb.galaxy() is kb.galaxy()  # made once per build


# ── reloads don't stall the app ──


def test_nothing_waits_for_a_load_or_a_build(tmp_path, monkeypatch):
    """A window's hello (summary), Claude's search_notes and the galaxy answer at once while
    a reload indexes: the old index serves until the new one is swapped in."""
    kb = KnowledgeBase(_saved(tmp_path))
    kb.load()
    indexing, release = threading.Event(), threading.Event()
    real = knowledge._Index.of.__func__

    def slow(cls, notes):
        indexing.set()
        release.wait(10)
        return real(cls, notes)

    monkeypatch.setattr(knowledge._Index, "of", classmethod(slow))
    for work in (kb.load, lambda: kb.build({"files": CORPUS[:3]})):
        indexing.clear()
        release.clear()
        worker = threading.Thread(target=work)
        worker.start()
        assert indexing.wait(10)
        started = time.monotonic()
        assert kb.summary()["notes"] >= 3
        assert kb.search("sourdough")
        assert kb.galaxy()["nodes"]
        assert kb.get("files:1") is not None
        assert time.monotonic() - started < 1.0
        release.set()
        worker.join(10)
    assert kb.summary()["notes"] == 3  # and then the new index is the one in use


def test_the_index_leaves_the_garbage_collector_little_to_walk(tmp_path):
    """Postings as millions of Python tuples in lists made every full collection walk them
    all (0.1-1.4 s with the whole app stopped). They live in arrays now."""
    words = [f"term{i}" for i in range(4000)]
    notes = [
        note(i, f"Note {i}", " ".join(words[(i * 31 + j * 7) % 4000] for j in range(500)))
        for i in range(1200)
    ]
    gc.collect()

    def pointers():
        return sum(len(o) for o in gc.get_objects() if isinstance(o, list | tuple | dict))

    before = pointers()
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": notes})
    gc.collect()
    postings = sum(len(set(n.text.split())) for n in notes)  # roughly
    assert postings > 300_000
    assert pointers() - before < 30 * len(notes)
    arrays = [v for v in vars(kb._index).values() if isinstance(v, np.ndarray)]
    assert sum(len(a) for a in arrays) > postings and not any(map(gc.is_tracked, arrays))


# ── what's read, and what's kept of it ──


def test_secrets_and_links_out_of_the_folder_stay_out(tmp_path):
    folder = tmp_path / "Desktop"
    folder.mkdir()
    (folder / "Passwords.txt").write_text("Bank login\npassword: Hunter2-bank!\n")
    (folder / "Recovery codes").mkdir()
    (folder / "Recovery codes" / "github.md").write_text("8812-3321-9090")
    (folder / "notes.md").write_text(
        "# Setup\nOPENAI key sk-proj-abcdefghijklmnopqrstuvwx1234 and card 4111 1111 1111 1111\n"
    )
    (folder / "id_rsa.md").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n")
    outside = tmp_path / "elsewhere.md"
    outside.write_text("private text outside the chosen folder: ssn 123-45-6789")
    (folder / "linked.md").symlink_to(outside)
    notes = collect_folder(folder)
    assert [n.title for n in notes] == ["Setup"]
    assert "sk-proj" not in notes[0].text and "4111" not in notes[0].text
    assert "[redacted]" in notes[0].text


def test_a_folder_is_walked_only_as_far_as_its_limit(tmp_path, monkeypatch):
    """The whole tree was listed before the limit applied: 70,000 paths to keep 4,000."""
    for i in range(50):
        path = tmp_path / f"note {i:02}.md"
        path.write_text(f"# Note {i}\nbudget review")
        os.utime(path, (1_700_000_000 + i, 1_700_000_000 + i))
    walked: list = []
    real = knowledge._walk

    def walk(folder):
        for path in real(folder):
            walked.append(path)
            yield path

    monkeypatch.setattr(knowledge, "_walk", walk)
    assert len(collect_folder(tmp_path, limit=5)) == 5
    assert len(walked) == 5
    newest = collect_folder(tmp_path, limit=3, newest_first=True)  # every date is needed
    assert [n.title for n in newest] == ["Note 49", "Note 48", "Note 47"]


def test_a_rebuild_starts_one_set_of_readers(tmp_path, monkeypatch):
    """Each folder source opened its own four reader processes: sixteen PDF parsers at once."""
    import concurrent.futures

    made = []
    real = concurrent.futures.ProcessPoolExecutor

    class Counted(real):
        def __init__(self, *args, **kwargs):
            made.append(kwargs.get("max_workers"))
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(concurrent.futures, "ProcessPoolExecutor", Counted)
    for name in ("Research", "Meetings", "Chosen"):
        (tmp_path / name).mkdir()
        for i in range(60):  # more than a source reads without reader processes
            (tmp_path / name / f"{name} {i}.md").write_text(f"# {name} {i}\nbudget review")
    monkeypatch.setattr(knowledge, "RESEARCH_DIR", tmp_path / "Research")
    monkeypatch.setattr(knowledge, "MEETINGS_DIR", tmp_path / "Meetings")
    kb = KnowledgeBase(tmp_path / "index.json")
    summary = Collector(kb, None).run(notes=False, bsh=False, folders=[str(tmp_path / "Chosen")])
    assert summary["by_source"] == {"files": 60, "meetings": 60, "research": 60}
    assert len(made) == 1, made  # one set of readers for all three sources


def test_search_and_other_sources_never_hand_over_a_secret(tmp_path, monkeypatch):
    kb = KnowledgeBase(tmp_path / "index.json")  # built by an older version: kept as it was
    kb.build({"notes": [note(1, "Wifi", "home wifi password: hunter2-secret", "notes")]})
    hit = kb.search("wifi password")[0]
    assert "hunter2" not in hit["excerpt"] and "[redacted]" in hit["excerpt"]

    monkeypatch.setattr(knowledge, "RESEARCH_DIR", tmp_path / "none")
    monkeypatch.setattr(knowledge, "MEETINGS_DIR", tmp_path / "none")
    monkeypatch.setattr(
        knowledge,
        "collect_apple_notes",
        lambda: [note(2, "Bank", "PIN: 4321 and api_key=sk-live-abcdefghijklmnop1234", "notes")],
    )
    fresh = KnowledgeBase(tmp_path / "fresh.json")
    Collector(fresh, None).run(notes=True, bsh=False, folders=[])
    stored = fresh.get("notes:2").text
    assert "4321" not in stored and "sk-live" not in stored


def _within_seconds(fn, fifo, seconds=5):
    """fn() on a worker thread. A read that blocks on the pipe (the bug) fails the test
    instead of hanging the suite: the pipe then gets a writer, so the read sees its end."""
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(fn)
        try:
            return future.result(timeout=seconds)
        finally:
            with contextlib.suppress(OSError):
                os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))


def test_read_document_never_blocks_on_a_pipe(tmp_path):
    fifo = tmp_path / "notes.md"
    os.mkfifo(fifo)
    assert _within_seconds(lambda: read_document(fifo), fifo) == ""


def test_a_file_that_never_finishes_reading_costs_nothing(tmp_path):
    """A pipe named notes.md used to block the read for good (and with it the rebuild);
    the rest of the folder was lost with it."""
    (tmp_path / "ideas.md").write_text("# Ideas\nBuild the thing.")
    fifo = tmp_path / "notes.md"
    os.mkfifo(fifo)
    notes = _within_seconds(lambda: collect_folder(tmp_path), fifo)
    assert [n.title for n in notes] == ["Ideas"]


def test_a_reader_gives_up_on_a_document_past_its_time(tmp_path):
    """A PDF that sends the parser round in circles: the reader process drops it after
    READ_SECONDS and goes on."""
    doc = tmp_path / "loop.pdf"
    doc.write_bytes(b"%PDF-1.4")
    script = textwrap.dedent(
        f"""
        import time
        from pathlib import Path
        from jarvis import knowledge
        def forever(*_a, **_k):
            while True:
                try:
                    time.sleep(0.01)
                except Exception:  # a parser that swallows errors can't swallow this
                    pass
        knowledge.read_document = forever
        knowledge.READ_SECONDS = 1
        knowledge._reader_start()
        started = time.monotonic()
        text = knowledge._read_one(Path({str(doc)!r}))
        print(repr(text), round(time.monotonic() - started, 1))
        """
    )
    run = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-2000:]
    text, seconds = run.stdout.split()
    assert text == "''" and float(seconds) < 5


def test_the_builder_leaves_when_a_source_is_stuck(tmp_path):
    """A source the Collector gave up on (still stuck in a read) kept brain_build from ever
    exiting, and the app waited on it for good."""
    script = textwrap.dedent(
        f"""
        import json, sys, threading
        from jarvis import brain_build, knowledge
        knowledge.SOURCE_SECONDS = 1
        knowledge.collect_apple_notes = lambda: threading.Event().wait()  # never returns
        sys.argv = ["brain_build", json.dumps({{"store": {str(tmp_path / "b" / "index.json")!r},
                                              "notes": True}})]
        brain_build.run()
        """
    )
    env = {**os.environ, "HOME": str(tmp_path)}  # no real Research or Meetings folder
    started = time.monotonic()
    run = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120, env=env
    )
    assert time.monotonic() - started < 60
    assert run.returncode == 0, run.stderr[-2000:]
    done = json.loads(run.stdout.strip().splitlines()[-1])["done"]
    assert done["errors"]["notes"].startswith("took too long")


def test_layout_links_look_alike_notes_without_a_square_matrix(monkeypatch):
    rng = np.random.default_rng(3)
    vectors = rng.standard_normal((300, 64)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    dense = vectors @ vectors.T
    np.fill_diagonal(dense, -1)
    monkeypatch.setattr(knowledge, "NEAREST_BLOCK", 64 * 300, raising=False)  # 64 rows a block
    best, score = knowledge._nearest(vectors)
    assert (best == dense.argmax(axis=1)).all()
    assert np.allclose(score, dense.max(axis=1), atol=1e-5)


# ── the app's side of a rebuild ──


def _builder(monkeypatch, script):
    """The app starts `script` in place of jarvis.brain_build."""
    real = asyncio.create_subprocess_exec

    async def start(*_args, **kwargs):
        return await real(sys.executable, "-c", textwrap.dedent(script), **kwargs)

    monkeypatch.setattr(hub_module.asyncio, "create_subprocess_exec", start)


async def test_a_rebuild_that_hangs_is_stopped(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    monkeypatch.setattr(hub_module, "BRAIN_BUILD_SECONDS", 1)
    _builder(
        monkeypatch,
        """
        import json, time
        print(json.dumps({"progress": "Reading files"}), flush=True)
        time.sleep(120)
        """,
    )
    started = time.monotonic()
    await hub.rebuild_brain()
    assert time.monotonic() - started < 10
    assert hub.brain_state["state"] == "error" and "too long" in hub.brain_state["detail"]
    await asyncio.sleep(0.2)
    assert hub._build_proc.returncode is not None  # killed, not left running


async def test_a_rebuild_that_is_done_but_stays_is_not_waited_for(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    monkeypatch.setattr(hub_module, "BRAIN_DONE_GRACE", 0.5)
    kb = KnowledgeBase(hub.kb.store)
    kb.build({"files": CORPUS})
    kb.save()
    _builder(
        monkeypatch,
        """
        import json, time
        print(json.dumps({"done": {"notes": 6}}), flush=True)
        time.sleep(120)  # a reader thread stuck on a file
        """,
    )
    await asyncio.wait_for(hub.rebuild_brain(), 20)
    assert hub.brain_state["state"] == "ready" and hub.kb.summary()["notes"] == 6


async def test_a_failed_rebuild_says_why(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    _builder(monkeypatch, "raise OSError(28, 'No space left on device')")
    await asyncio.wait_for(hub.rebuild_brain(), 20)
    assert hub.brain_state["state"] == "error"
    assert "No space left on device" in hub.brain_state["detail"]


async def test_a_rebuild_with_a_pipe_in_a_chosen_folder_finishes(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    """The real builder, end to end: the pipe is skipped, the folder's notes kept."""
    folder = tmp_path / "Chosen"
    folder.mkdir()
    (folder / "ideas.md").write_text("# Ideas\nBuild the thing.")
    os.mkfifo(folder / "notes.md")
    monkeypatch.setenv("HOME", str(tmp_path))  # the builder's Research and Meetings folders
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    for name in ("notes", "bsh", "computer", "photos", "mail", "messages"):
        setattr(hub.prefs, f"brain_{name}", False)
    hub.prefs.brain_folders = [str(folder)]
    await asyncio.wait_for(hub.rebuild_brain(), 120)
    assert hub.brain_state["state"] == "ready", hub.brain_state
    assert [n.title for n in hub.kb.notes] == ["Ideas"]


async def test_search_notes_runs_off_the_event_loop(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.kb.build({"files": CORPUS})
    q = hub.subscribe()
    threads = []
    real = hub.kb.search

    def search(query, k=6):
        threads.append(threading.get_ident())
        return real(query, k)

    monkeypatch.setattr(hub.kb, "search", search)
    text = await hub.find_notes("sourdough starter")
    assert text.startswith("[files:1] Sourdough starter")
    assert threads and threads[0] != threading.get_ident()  # not the event loop's thread
    assert q.get_nowait()["type"] == "sources"


def _drain(queue) -> list[dict]:
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_each_window_gets_the_galaxy_once_per_build(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.kb.build({"notes": [note(1, "Budget", "budget review", "notes")]})
    windows = [hub.subscribe(), hub.subscribe()]
    for _ in windows:  # after galaxy_changed, every window asks
        await hub.handle({"type": "galaxy"})
    for window in windows:
        assert [e["type"] for e in _drain(window)].count("galaxy") == 1
    hub.kb.build({"notes": [note(2, "Plan", "plan review", "notes")]})
    await hub.handle({"type": "galaxy"})
    for window in windows:  # a new build goes out again
        assert [e["type"] for e in _drain(window)].count("galaxy") == 1


async def test_notes_reach_claude_with_secrets_blanked_out(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    secret = note(
        1,
        "Wi-Fi",
        "Home network password: Hunter2-bank! and key sk-live-abcdefghijklmnop1234",
        "notes",
    )
    hub.kb.build({"notes": [secret]})  # as an index from before the fix holds it
    for text in (hub.search_notes("home network password"), hub.note_text(hub.kb.get("notes:1"))):
        assert "Hunter2" not in text and "sk-live" not in text and "[redacted]" in text
