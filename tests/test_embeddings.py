"""Search by meaning (jarvis.embeddings): vectors made once per passage and cached by its
text, capped per rebuild, fused with the keyword search by rank, and never worse than the
keyword search when anything is missing. A fake embedder stands in for Apple's models."""

import hashlib
import math
import os
import stat
import sys
from datetime import datetime, timedelta

import numpy as np
import pytest

from jarvis import embeddings, swift_helper
from jarvis.embeddings import (
    DIM,
    SemanticSearch,
    VectorFile,
    day_of,
    embed_index,
    fuse,
    merged_links,
    note_links,
    vectors_path,
)
from jarvis.knowledge import KnowledgeBase, Note

# Words that mean the same thing share a direction, so the fake finds paraphrases the way the
# real models do, and the keyword search doesn't.
SYNONYMS = {
    "vehicle": "car",
    "automobile": "car",
    "garage": "repair",
    "mechanic": "repair",
    "fix": "repair",
    "fixing": "repair",
    "brakes": "repair",
    "costs": "price",
    "expensive": "price",
    "charged": "price",
    "sourdough": "bread",
    "baking": "bread",
    "loaf": "bread",
    "investors": "fundraising",
    "series": "fundraising",
    "sequoia": "fundraising",
    "round": "fundraising",
}


def fake_vector(text):
    vec = np.zeros(DIM, dtype=np.float32)
    for word in text.lower().replace(",", " ").replace(".", " ").split():
        word = SYNONYMS.get(word, word)
        vec[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM] += 1.0
    norm = np.linalg.norm(vec)
    return vec / norm if norm else vec


class FakeEmbedder:
    """Deterministic vectors: a bag of words, synonyms folded together. CJK text gets
    "no-assets" when asked to (as when Apple's Chinese model isn't on the Mac)."""

    def __init__(self, no_cjk=False, fail_after=None):
        self.calls = []
        self.no_cjk = no_cjk
        self.fail_after = fail_after
        self.closed = False

    def embed(self, texts, timeout=None):
        self.calls.append(list(texts))
        if self.fail_after is not None and len(self.calls) > self.fail_after:
            raise TimeoutError("stuck")
        out = []
        for t in texts:
            if self.no_cjk and any("一" <= ch <= "鿿" for ch in t):
                out.append("no-assets")
            elif not t.strip():
                out.append("empty")
            else:
                out.append(("fake-model", fake_vector(t)))
        return out

    def embedded(self):
        return [t for call in self.calls for t in call]

    def close(self):
        self.closed = True


def note(i, title, text, source="files", modified=""):
    return Note(
        id=f"{source}:{i}", source=source, title=title, text=text, ref=str(i), modified=modified
    )


def days_ago(n):
    return (datetime.now() - timedelta(days=n)).isoformat(timespec="seconds")


CORPUS = [
    note(
        1,
        "Garage visit",
        "The mechanic replaced the brakes on the vehicle; expensive.",
        modified=days_ago(3),
    ),
    note(
        2,
        "Sourdough starter",
        "Feed the starter flour and water daily; bake a loaf.",
        modified=days_ago(40),
    ),
    note(
        3,
        "Board notes",
        "Notes from the call with Sequoia about leading our next round.",
        modified=days_ago(10),
    ),
    note(
        4,
        "Marathon plan",
        "Long run on Sunday, tempo run Tuesday, rest on Monday.",
        modified=days_ago(400),
    ),
    note(
        5, "Car insurance", "Renew the car insurance policy before it lapses.", modified=days_ago(1)
    ),
    note(6, "Dinner", "Pasta with tomatoes, garlic and basil.", source="notes"),
]


def built(tmp_path, notes=CORPUS):
    kb = KnowledgeBase(tmp_path / "brain" / "index.json")
    kb.build(
        {
            "files": [n for n in notes if n.source == "files"],
            "notes": [n for n in notes if n.source == "notes"],
        }
    )
    return kb


def make_vectors(kb, embedder=None, **kw):
    embedder = embedder or FakeEmbedder()
    vf, rows = embed_index(kb.notes, kb.built_at, vectors_path(kb.store), lambda: embedder, **kw)
    return embedder, vf, rows


def semantic_for(kb, embedder=None, on=True):
    embedder = embedder or FakeEmbedder()
    kb.semantic = SemanticSearch(lambda: on, lambda: embedder)
    return embedder


# ── making vectors ──


def test_every_passage_is_embedded_once_and_cached_by_its_text(tmp_path):
    kb = built(tmp_path)
    first, vf, rows = make_vectors(kb)
    assert len(first.embedded()) == len(kb.notes) == len(vf.keys) == len(rows)
    assert vf.status()["pending"] == 0 and vf.error == ""
    # Rebuilt from the same notes (a new built_at): nothing is embedded again.
    kb.build({"files": CORPUS[:5], "notes": CORPUS[5:]})
    again, vf2, _ = make_vectors(kb)
    assert again.embedded() == []
    assert len(vf2.keys) == len(vf.keys) and vf2.built_at == kb.built_at
    # One note changed, one gone: only the changed one is embedded, the gone one dropped.
    changed = note(2, "Sourdough starter", "Feed it twice a day now.", modified=days_ago(0))
    kb.build({"files": [CORPUS[0], changed, CORPUS[2]], "notes": CORPUS[5:]})
    third, vf3, _ = make_vectors(kb)
    assert len(third.embedded()) == 1 and "twice a day" in third.embedded()[0]
    assert len(vf3.keys) == 4  # garage, starter, board notes, dinner


def test_a_rebuild_embeds_at_most_its_cap_newest_notes_first_and_the_next_carries_on(tmp_path):
    kb = built(tmp_path)
    first, vf, _ = make_vectors(kb, cap=2)
    embedded = first.embedded()
    assert len(embedded) <= 2 + embeddings.BATCH  # stops at the batch that reaches the cap
    assert "Car insurance" in embedded[0] and "Garage visit" in embedded[1]  # newest first
    assert vf.status()["pending"] == len(kb.notes) - len(vf.keys) > 0
    second, vf2, _ = make_vectors(kb)
    assert set(second.embedded()).isdisjoint(embedded)  # only what was left
    assert vf2.status()["pending"] == 0


def test_a_rebuild_stops_embedding_when_its_time_is_up(tmp_path):
    kb = built(tmp_path)
    clock = iter([0.0, 0.0, 999.0, 999.0, 999.0])
    embedder, vf, _ = make_vectors(kb, seconds=10, clock=lambda: next(clock, 999.0))
    assert len(embedder.calls) == 1  # the first batch, then out of time
    assert vf.status()["pending"] == len(kb.notes) - len(vf.keys)


def test_only_the_first_passages_of_a_long_note_are_embedded(tmp_path):
    long = note(
        9, "Long report", "\n\n".join(f"Paragraph {i}. " + "word " * 250 for i in range(40))
    )
    kb = built(tmp_path, [long])
    embedder, vf, _ = make_vectors(kb)
    assert len(embedder.embedded()) == embeddings.CHUNKS_PER_NOTE
    assert vf.n_chunks > embeddings.CHUNKS_PER_NOTE  # the words still search all of it


def test_a_language_without_its_model_is_skipped_and_said(tmp_path):
    notes = [
        note(1, "预算会议", "下周二上午十点开预算会议"),
        note(2, "Budget", "The budget meeting is Tuesday."),
    ]
    kb = built(tmp_path, notes)
    _, vf, _ = make_vectors(kb, FakeEmbedder(no_cjk=True))
    assert len(vf.keys) == 1 and vf.error == "no-assets"


def test_a_helper_that_stalls_or_is_missing_leaves_what_was_cached(tmp_path):
    kb = built(tmp_path)
    make_vectors(kb, cap=2)
    stalled = FakeEmbedder(fail_after=0)
    _, vf, _ = make_vectors(kb, stalled)
    assert vf.error.startswith("the helper stopped") and len(vf.keys) >= 2 and stalled.closed
    vf2, _ = embed_index(kb.notes, kb.built_at, vectors_path(kb.store), lambda: None)
    assert vf2.error == "helper" and len(vf2.keys) == len(vf.keys)


@pytest.mark.parametrize(
    "blob",
    [b"", b"not a zip", b"PK\x03\x04garbage"],
    ids=["empty", "not-a-zip", "cut-short"],
)
def test_a_damaged_vectors_file_is_ignored_and_rewritten(tmp_path, blob):
    kb = built(tmp_path)
    path = vectors_path(kb.store)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    assert VectorFile.read(path) is None
    embedder, vf, _ = make_vectors(kb)
    assert len(embedder.embedded()) == len(kb.notes)
    assert VectorFile.read(path) is not None


def test_a_vectors_file_of_another_shape_or_version_is_not_used(tmp_path):
    path = tmp_path / "vectors.npz"
    good = VectorFile.empty("b", 0)
    good.write(path)
    assert VectorFile.read(path) is not None
    with open(path, "wb") as fh:
        np.savez(
            fh,
            meta=np.array('{"version": 99}'),
            keys=good.keys,
            vecs=good.vecs,
            space=good.space,
            chunk=good.chunk,
        )
    assert VectorFile.read(path) is None
    with open(path, "wb") as fh:  # vectors of another size
        np.savez(
            fh,
            meta=np.array('{"version": 1, "spaces": ["m"]}'),
            keys=np.zeros((1, 16), np.uint8),
            vecs=np.zeros((1, 3), np.float16),
            space=np.zeros(1, np.uint8),
            chunk=np.zeros(1, np.int32),
        )
    assert VectorFile.read(path) is None


# ── searching ──


def test_a_paraphrase_is_found_by_meaning_and_ranked_with_the_words(tmp_path):
    kb = built(tmp_path)
    assert kb.search("automobile fixing price") == []  # no word in common with any note
    make_vectors(kb)
    semantic_for(kb)
    hits = kb.search("automobile fixing price")
    assert hits[0]["title"] == "Garage visit" and hits[0]["match"] == "meaning"
    both = kb.search("car repair")
    assert both[0]["match"] in ("both", "words")
    assert {h["title"] for h in both[:2]} == {"Garage visit", "Car insurance"}


def test_search_by_meaning_off_or_missing_is_exactly_the_keyword_search(tmp_path):
    kb = built(tmp_path)
    plain = kb.search("car insurance brakes")
    make_vectors(kb)
    semantic_for(kb, on=False)
    assert kb.search("car insurance brakes") == plain

    class Broken(FakeEmbedder):
        def embed(self, texts, timeout=None):
            raise TimeoutError("no answer")

    kb.semantic = SemanticSearch(lambda: True, lambda: Broken())
    assert kb.search("car insurance brakes") == plain
    kb.semantic = SemanticSearch(lambda: True, lambda: None)  # the helper isn't built yet
    assert kb.search("car insurance brakes") == plain


def test_vectors_made_for_another_build_of_the_index_are_not_used(tmp_path):
    kb = built(tmp_path)
    make_vectors(kb)
    kb.build({"files": CORPUS[:5], "notes": CORPUS[5:]})
    kb.built_at = "2026-01-01T00:00:00"  # another build of the index, with no new vectors
    semantic_for(kb)
    assert kb.search("automobile fixing price") == []
    assert kb.semantic.status().get("stale") is True


def test_a_query_in_a_language_with_no_vectors_is_searched_by_words(tmp_path):
    kb = built(tmp_path)
    make_vectors(kb)

    class OtherModel(FakeEmbedder):
        def embed(self, texts, timeout=None):
            return [("another-model", fake_vector(t)) for t in texts]

    kb.semantic = SemanticSearch(lambda: True, lambda: OtherModel())
    assert kb.search("automobile fixing price") == []


def test_a_failing_helper_is_left_alone_for_a_while(tmp_path, monkeypatch):
    kb = built(tmp_path)
    make_vectors(kb)
    calls = []

    class Broken(FakeEmbedder):
        def embed(self, texts, timeout=None):
            calls.append(texts)
            raise OSError("gone")

    kb.semantic = SemanticSearch(lambda: True, lambda: Broken())
    kb.search("car")
    kb.search("car")
    assert len(calls) == 1  # the second search didn't wait on it again


def test_filters_narrow_both_searches(tmp_path):
    kb = built(tmp_path)
    make_vectors(kb)
    semantic_for(kb)
    assert [h["source"] for h in kb.search("pasta garlic", sources=["notes"])] == ["notes"]
    assert kb.search("pasta garlic", sources=["files"]) == [] or all(
        h["source"] == "files" for h in kb.search("pasta garlic", sources=["files"])
    )
    since = (datetime.now() - timedelta(days=5)).date().isoformat()
    recent = kb.search("car vehicle repair insurance", since=since)
    assert {h["title"] for h in recent} <= {"Garage visit", "Car insurance"} and recent
    old = kb.search("marathon run", until=(datetime.now() - timedelta(days=100)).date().isoformat())
    assert [h["title"] for h in old] == ["Marathon plan"]
    assert "Dinner" not in {h["title"] for h in kb.search("pasta", since="2000-01-01")}


def test_fusion_ranks_what_both_find_first_and_lifts_recent_notes_a_little():
    chunk_note = np.array([0, 1, 2, 3])
    now = 20000.0
    note_day = np.array([now - 1, now - 1, now - 1000, math.nan])
    keyword = [(0, 9.0), (1, 5.0)]
    meaning = [(1, 0.9), (2, 0.8)]
    fused = fuse(keyword, meaning, chunk_note, note_day, 10, now=now)
    assert [c for c, _, _ in fused] == [1, 0, 2]
    assert [how for _, _, how in fused] == ["both", "words", "meaning"]
    # Same ranks: the recent note first; the lift is mild, never more than RECENCY_LIFT.
    tie = fuse([(2, 1.0)], [(0, 1.0)], chunk_note, note_day, 2, now=now)
    assert tie[0][0] == 0 and tie[0][1] / tie[1][1] <= 1 + embeddings.RECENCY_LIFT + 1e-9


def test_a_note_found_by_meaning_alone_must_stand_out(tmp_path):
    notes = [
        note(i, f"Filler {i}", f"Unrelated filler text number {i} about weather and tides.")
        for i in range(80)
    ]
    notes.append(note(99, "Garage visit", "The mechanic replaced the brakes on the vehicle."))
    kb = built(tmp_path, notes)
    make_vectors(kb, cap=200)
    semantic_for(kb)
    hits = kb.search("automobile fixing", 10)
    assert hits and hits[0]["title"] == "Garage visit"
    assert len(hits) < 10  # the filler doesn't stand out from the rest: not brought in


# ── links ──


def test_notes_close_in_meaning_are_linked_and_the_rest_keep_their_word_links(tmp_path):
    kb = built(tmp_path)
    _, vf, rows = make_vectors(kb)
    links, with_vectors = note_links(vf, rows, len(kb.notes))
    ids = [n.id for n in kb.notes]
    garage, car = ids.index("files:1"), ids.index("files:5")
    assert (min(garage, car), max(garage, car)) in links
    assert with_vectors == set(range(len(kb.notes)))
    merged = merged_links([(0, 1), (7, 8)], links, {0, 1, 2})
    assert (7, 8) in merged and (0, 1) not in merged or (0, 1) in links


def test_day_of_reads_the_dates_notes_carry():
    assert day_of("2026-09-12") == pytest.approx(
        (datetime(2026, 9, 12) - datetime(1970, 1, 1)).days
    )
    assert math.isfinite(day_of("2026-09-12T10:14:22Z"))
    assert math.isfinite(day_of("2026-09-12 10:14:22.123456"))
    for bad in ("", "None", "yesterday", None, "2026-13-45"):
        assert math.isnan(day_of(bad))


# ── the helper's plumbing ──


def fake_helper(tmp_path, body):
    """A stand-in for jarvis-embed serve: a Python script speaking its line protocol."""
    script = tmp_path / "fake-embed"
    script.write_text(f"#!{sys.executable}\n{body}")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


ANSWERS = """
import base64, json, struct, sys
for line in sys.stdin:
    item = json.loads(line)
    if not item["text"].strip():
        print(json.dumps({"id": item["id"], "skip": "empty"}), flush=True)
        continue
    vec = [1.0] + [0.0] * 511
    data = base64.b64encode(struct.pack("<512f", *vec)).decode()
    print(json.dumps({"id": item["id"], "model": "m1", "v": data}), flush=True)
"""


def test_the_helper_answers_each_text_by_its_id(tmp_path):
    embedder = embeddings.HelperEmbedder(fake_helper(tmp_path, ANSWERS), timeout=10)
    try:
        out = embedder.embed(["one", "", "two"])
        assert out[1] == "empty"
        assert out[0][0] == "m1" and out[0][1][0] == pytest.approx(1.0)
        assert embedder.embed(["again"])[0][0] == "m1"  # the same process, still answering
    finally:
        embedder.close()


def test_a_helper_that_stalls_times_out_and_starts_afresh(tmp_path):
    stuck = fake_helper(tmp_path, "import sys, time\nfor line in sys.stdin:\n    time.sleep(30)\n")
    embedder = embeddings.HelperEmbedder(stuck, timeout=0.5)
    try:
        with pytest.raises(TimeoutError):
            embedder.embed(["hello"])
        assert embedder._process._proc is None  # stopped; the next call starts a new one
    finally:
        embedder.close()


def test_a_bad_vector_is_no_vector():
    assert embeddings._answer({"id": 1, "v": "not base64!!"}).startswith("error")
    assert embeddings._answer({"id": 1, "model": "m", "v": ""}).startswith("error")
    assert embeddings._answer(None).startswith("error")
    assert embeddings._answer({"id": 1, "skip": "no-assets"}) == "no-assets"


def test_swift_helpers_are_built_once_by_source_hash_and_a_failed_build_is_not_retried(
    tmp_path, monkeypatch
):
    runs = []

    def fake_swiftc(argv, **_kw):
        runs.append(argv)
        out = argv[argv.index("-o") + 1]
        with open(out, "w") as fh:
            fh.write("binary")
        os.chmod(out, 0o755)

    native, bins = tmp_path / "native", tmp_path / "bin"
    native.mkdir()
    (native / "one.swift").write_text("print(1)")
    (native / "two.swift").write_text("print(2)")
    monkeypatch.setattr(swift_helper, "NATIVE", native)
    monkeypatch.setattr(swift_helper.subprocess, "run", fake_swiftc)
    monkeypatch.setattr(swift_helper, "_failed", set())
    first = swift_helper.ensure("one", bins)
    assert first is not None and first.exists() and first.name.startswith("one-")
    assert swift_helper.ensure("one", bins) == first
    assert len(runs) == 1 and runs[0][0] == "swiftc"
    assert not list(bins.glob("*.part"))
    (native / "one.swift").write_text("print(11)")  # a new source: a new build
    assert swift_helper.ensure("one", bins) not in (None, first) and len(runs) == 2

    def broken(argv, **_kw):
        runs.append(argv)
        raise swift_helper.subprocess.CalledProcessError(1, argv, stderr=b"error: nope")

    monkeypatch.setattr(swift_helper.subprocess, "run", broken)
    assert swift_helper.ensure("two", bins) is None
    assert swift_helper.ensure("two", bins) is None
    assert len(runs) == 3  # tried once
    assert swift_helper.ensure("no-such-helper", bins) is None
