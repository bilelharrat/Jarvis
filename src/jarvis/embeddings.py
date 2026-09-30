"""Search by meaning for the second brain: each passage as a vector from Apple's on-device
language models, so a search finds notes about what was asked even in other words, fused
with the keyword search.

- Vectors come from NaturalLanguage's NLContextualEmbedding through a Swift helper
  (native/jarvis-embed.swift, built on first use and cached by its source's hash): one model
  for English and 19 other Latin-script languages, one for Chinese, Japanese and Korean, 512
  numbers a passage. A passage is only compared with passages of its own model.
- The rebuild (brain_build: its own low-priority process, under its lock) makes them: the
  passages without a cached vector, newest notes first, at most EMBED_PER_BUILD a rebuild
  and EMBED_SECONDS of its time, the first CHUNKS_PER_NOTE of each note, MAX_VECTORS in all
  (BM25 still searches every word of everything). They're kept in brain/vectors.npz beside
  the index, keyed by a hash of each passage's text, so a passage is embedded once however
  often the brain is rebuilt, and whatever didn't fit waits for the next rebuild. The notes'
  nearest neighbours by meaning become the galaxy's links.
- A search embeds the query with the same helper (kept running between searches), ranks the
  passages of the query's model by cosine similarity, and fuses that with BM25's ranking by
  reciprocal rank fusion, with a mild lift for recent notes.
- Anything missing (the setting off, no helper, no model files on this Mac, no vectors yet,
  vectors made for another build of the index, a helper slow to answer) leaves the keyword
  search exactly as it was.

It all runs on this Mac: no Claude calls, nothing sent anywhere. macOS itself downloads
Apple's model files once if they aren't here, and only after the owner turns Search by
meaning on (request_assets).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

import numpy as np

log = logging.getLogger("jarvis")

HELPER = "jarvis-embed"
VECTORS_NAME = "vectors.npz"  # beside the index (brain/index.json)
VERSION = 1
DIM = 512
EMBED_PER_BUILD = 2000  # passages embedded in one rebuild (about 50 ms each)
EMBED_TRIES = 4  # ...and at most this many times that asked (ones with no model skipped)
EMBED_SECONDS = 150.0  # ...within this long: the rebuild as a whole has 15 minutes
CHUNKS_PER_NOTE = 6  # the first six passages (~7,000 characters); the words cover the rest
MAX_VECTORS = 50_000  # about 50 MB as float16, in the app while search by meaning is on
EMBED_CHARS = 1500  # of a passage with its note's title: the models read 256 tokens
BATCH = 16  # lines in flight to the helper, well inside a pipe's buffer either way
BUILD_SECONDS = 60.0  # the rebuild's helper answering one batch
QUERY_SECONDS = 4.0  # a query's vector: past this, the search is by words alone
QUIET_SECONDS = 60.0  # after the helper failed a query, words alone for this long
WARM_SECONDS = 90.0  # the helper starting and loading its model, ahead of the first search
RRF_K = 60
MEANING_TOP = 20  # notes by meaning brought into a search
MEANING_MIN_Z = 1.5  # ...each standing out from how like the query everything else is
MEANING_Z_FROM = 50  # passages the z-score test needs to mean anything (fewer: the closest)
KEYWORD_TOP = 100  # notes by words brought into the fusion
RECENCY_LIFT = 0.1  # a note from today ranks up to 10% higher, half that at four months
RECENCY_HALF_DAYS = 120.0
LINK_BLOCK = 1 << 22  # note similarities worked out at once (16 MB of float32)
SIM_BLOCK = 8192  # float16 rows made float32 at once for a search (16 MB)
EPOCH = datetime(1970, 1, 1)

Vector = tuple[str, np.ndarray]  # (the model it's from, unit float32 vector)


class Embedder(Protocol):
    def embed(self, texts: list[str], timeout: float | None = None) -> list[Vector | str]:
        """For each text its vector, or why there's none ("no-assets": that language's
        model files aren't on this Mac; "empty"; "error: …")."""
        ...

    def close(self) -> None: ...


# ── days ──


def day_of(value: Any) -> float:
    """A note's `modified` (ISO time or date, any offset) as days since 1970-01-01 in local
    time, so that its floor is the local date's number; NaN when there's no date in it."""
    text = str(value or "").strip()
    if len(text) < 10:
        return math.nan
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            moment = datetime.fromisoformat(text[:10])
        except ValueError:
            return math.nan
    if moment.tzinfo is not None:
        try:
            moment = moment.astimezone().replace(tzinfo=None)
        except (OverflowError, OSError, ValueError):
            return math.nan
    return (moment - EPOCH).total_seconds() / 86400


def today() -> float:
    return (datetime.now() - EPOCH).total_seconds() / 86400


# ── passages and the vectors file ──


@dataclass
class Passage:
    chunk: int  # its number in the index (knowledge._Index)
    note: int  # its note's number
    pos: int  # which of its note's chunks it is
    text: str  # what's embedded: its note's title, then the passage
    key: bytes  # a hash of text: the cache key


def passage_key(text: str) -> bytes:
    return hashlib.blake2b(text.encode("utf-8", "replace"), digest_size=16).digest()


def passages(notes: list[Any]) -> tuple[list[Passage], int]:
    """The first CHUNKS_PER_NOTE passages of each note, numbered as the index numbers its
    chunks (every note's chunks, in order), and how many chunks the index has."""
    from .knowledge import chunk_text

    out: list[Passage] = []
    chunk = 0
    for i, note in enumerate(notes):
        for pos, piece in enumerate(chunk_text(note.title, note.text)):
            if pos < CHUNKS_PER_NOTE:
                text = f"{note.title}\n{piece}"[:EMBED_CHARS]
                out.append(Passage(chunk, i, pos, text, passage_key(text)))
            chunk += 1
    return out, chunk


def vectors_path(store: Path) -> Path:
    return Path(store).with_name(VECTORS_NAME)


@dataclass
class VectorFile:
    """brain/vectors.npz: a vector per passage (unit length, float16), which model it's from,
    which of the index's chunks it is, and its text's hash; plus the index build it's for."""

    built_at: str
    n_chunks: int
    spaces: list[str]  # model identifiers; `space` indexes this
    keys: np.ndarray  # uint8 [n, 16]
    vecs: np.ndarray  # float16 [n, DIM]
    space: np.ndarray  # uint8 [n]
    chunk: np.ndarray  # int32 [n]
    wanted: int = 0  # passages that should have a vector (within MAX_VECTORS)
    error: str = ""  # why some couldn't be made ("no-assets", "helper", …)

    @classmethod
    def empty(cls, built_at: str = "", n_chunks: int = 0) -> VectorFile:
        return cls(
            built_at,
            n_chunks,
            [],
            np.zeros((0, 16), np.uint8),
            np.zeros((0, DIM), np.float16),
            np.zeros(0, np.uint8),
            np.zeros(0, np.int32),
        )

    @classmethod
    def read(cls, path: Path) -> VectorFile | None:
        """The file, checked; None when there's none, or it's damaged or another version's
        (it's only a cache: the next rebuild writes a good one)."""
        try:
            with np.load(path, allow_pickle=False) as data:
                meta = json.loads(str(data["meta"]))
                keys, vecs = data["keys"], data["vecs"]
                space, chunk = data["space"], data["chunk"]
        except FileNotFoundError:
            return None
        except Exception as exc:  # cut short, not an npz, a shape this version doesn't know
            log.info("second brain: the vectors file can't be used (%s)", type(exc).__name__)
            return None
        try:
            if not isinstance(meta, dict) or meta.get("version") != VERSION:
                return None
            n = len(keys)
            spaces = [str(s) for s in meta.get("spaces") or []]
            ok = (
                keys.dtype == np.uint8
                and keys.shape == (n, 16)
                and vecs.dtype == np.float16
                and vecs.shape == (n, DIM)
                and space.dtype == np.uint8
                and space.shape == (n,)
                and chunk.dtype == np.int32
                and chunk.shape == (n,)
                and (n == 0 or int(space.max()) < len(spaces))
            )
            if not ok:
                return None
            return cls(
                str(meta.get("built_at") or ""),
                int(meta.get("n_chunks") or 0),
                spaces,
                keys,
                vecs,
                space,
                chunk,
                int(meta.get("wanted") or 0),
                str(meta.get("error") or ""),
            )
        except (TypeError, ValueError):
            return None

    def write(self, path: Path) -> None:
        meta = {
            "version": VERSION,
            "built_at": self.built_at,
            "n_chunks": self.n_chunks,
            "spaces": self.spaces,
            "vectors": len(self.keys),
            "wanted": self.wanted,
            "error": self.error,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        try:
            with open(tmp, "wb") as fh:
                np.savez(
                    fh,
                    meta=np.array(json.dumps(meta)),
                    keys=self.keys,
                    vecs=self.vecs,
                    space=self.space,
                    chunk=self.chunk,
                )
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)

    def cached(self) -> dict[bytes, tuple[str, np.ndarray]]:
        """Text hash -> (model, float16 vector): what a rebuild needn't embed again."""
        return {
            self.keys[i].tobytes(): (self.spaces[int(self.space[i])], self.vecs[i])
            for i in range(len(self.keys))
        }

    def status(self) -> dict[str, Any]:
        return {
            "vectors": len(self.keys),
            "wanted": self.wanted,
            "pending": max(0, self.wanted - len(self.keys)),
            "error": self.error,
            "built_at": self.built_at,
        }


# ── the helper ──


class HelperEmbedder:
    """`jarvis-embed serve`, kept running (swift_helper.LineProcess): texts in, vectors out."""

    def __init__(self, binary: Path, timeout: float = BUILD_SECONDS) -> None:
        from .swift_helper import LineProcess

        self.binary = Path(binary)
        self._process = LineProcess([str(binary), "serve"], timeout=timeout)

    def embed(self, texts: list[str], timeout: float | None = None) -> list[Vector | str]:
        # Half of a surrogate pair (a passage cut in an emoji) is one Foundation's JSON
        # refuses: the helper would never answer it, nor anything after it.
        whole = [
            t[:EMBED_CHARS].encode("utf-16", "surrogatepass").decode("utf-16", "replace")
            for t in texts
        ]
        answers = self._process.ask([{"text": t} for t in whole], timeout)
        return [_answer(a) for a in answers]

    def close(self) -> None:
        self._process.close()


def _answer(answer: Any) -> Vector | str:
    if not isinstance(answer, dict):
        return "error: no answer"
    if "v" not in answer:
        return str(answer.get("skip") or "error: no answer")[:200]
    try:
        vec = np.frombuffer(base64.b64decode(str(answer["v"])), dtype="<f4").astype(np.float32)
    except (ValueError, TypeError):
        return "error: a vector that isn't one"
    norm = float(np.linalg.norm(vec)) if vec.shape == (DIM,) else 0.0
    if not math.isfinite(norm) or norm <= 0:
        return "error: a vector that isn't one"
    return str(answer.get("model") or "")[:80], vec / norm


def helper_status(binary: Path, timeout: float = 30) -> dict[str, Any]:
    """`jarvis-embed status`: each model, and whether its files are on this Mac. Never
    downloads anything."""
    try:
        run = subprocess.run(  # noqa: S603 - our own helper
            [str(binary), "status"], capture_output=True, text=True, timeout=timeout
        )
        data = json.loads(run.stdout.strip().splitlines()[-1])
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list):
            raise ValueError("no models")
        return {"models": [m for m in models if isinstance(m, dict)]}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        return {"models": [], "error": f"the helper didn't answer ({type(exc).__name__})"}


def request_assets(binary: Path, timeout: float = 50 * 60) -> list[dict[str, Any]]:
    """`jarvis-embed assets`: macOS fetches the models' files that aren't here (a download,
    once). Only ever run after the owner turns Search by meaning on."""
    try:
        run = subprocess.run(  # noqa: S603 - our own helper
            [str(binary), "assets"], capture_output=True, text=True, timeout=timeout
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [{"result": "error", "error": type(exc).__name__}]
    out = []
    for line in run.stdout.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out or [{"result": "error", "error": "no answer"}]


# ── making them (in the rebuild) ──


Progress = Callable[[str], None]


def embed_index(
    notes: list[Any],
    built_at: str,
    path: Path,
    make_embedder: Callable[[], Embedder | None],
    progress: Progress = lambda _m: None,
    *,
    cap: int = EMBED_PER_BUILD,
    seconds: float = EMBED_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[VectorFile, list[Passage]]:
    """Vectors for the index's passages: the cached ones kept, up to `cap` new ones made
    (newest notes first) in at most `seconds`, the rest left for the next rebuild. Writes
    `path` (only the current passages: the file never keeps what the index dropped)."""
    plan, n_chunks = passages(notes)
    if plan:
        days = np.array([day_of(getattr(n, "modified", "")) for n in notes], dtype=np.float64)
        note_of = np.array([p.note for p in plan])
        newest = -np.nan_to_num(days[note_of], nan=-np.inf)
        order = np.lexsort((np.array([p.pos for p in plan]), note_of, newest))
        plan = [plan[int(j)] for j in order[:MAX_VECTORS]]
    old = VectorFile.read(path)
    cache = old.cached() if old is not None else {}
    kept: list[tuple[Passage, str, np.ndarray]] = []
    missing: list[Passage] = []
    for p in plan:
        hit = cache.get(p.key)
        if hit is not None:
            kept.append((p, hit[0], hit[1]))
        else:
            missing.append(p)
    del cache
    made: list[tuple[Passage, str, np.ndarray]] = []
    error = ""
    if missing and cap > 0:
        embedder = make_embedder()
        if embedder is None:
            error = "helper"
        else:
            started, asked, told = clock(), 0, 0
            try:
                while asked < len(missing) and len(made) < cap and asked < cap * EMBED_TRIES:
                    if clock() - started > seconds:
                        break
                    batch = missing[asked : asked + min(BATCH, cap - len(made))]
                    asked += len(batch)
                    try:
                        answers = embedder.embed([p.text for p in batch])
                    except Exception as exc:  # the helper stalled or died: next rebuild
                        error = f"the helper stopped ({type(exc).__name__})"
                        break
                    for p, answer in zip(batch, answers, strict=True):
                        if isinstance(answer, tuple):
                            made.append((p, answer[0], answer[1].astype(np.float16)))
                        elif answer == "no-assets":
                            error = "no-assets"
                    if len(made) - told >= 250:
                        told = len(made)
                        progress(f"Search by meaning: {told} new passages…")
            finally:
                embedder.close()
    rows = kept + made
    spaces = sorted({model for _, model, _ in rows})
    code = {model: i for i, model in enumerate(spaces)}
    rows.sort(key=lambda r: r[0].chunk)
    out = VectorFile(
        built_at,
        n_chunks,
        spaces,
        np.frombuffer(b"".join(p.key for p, _, _ in rows), dtype=np.uint8).reshape(-1, 16),
        np.stack([v for _, _, v in rows]).astype(np.float16)
        if rows
        else np.zeros((0, DIM), np.float16),
        np.array([code[m] for _, m, _ in rows], dtype=np.uint8),
        np.array([p.chunk for p, _, _ in rows], dtype=np.int32),
        wanted=len(plan),
        error=error if len(rows) < len(plan) else "",
    )
    out.write(path)
    if made:
        progress(f"Search by meaning: {len(rows)} of {len(plan)} passages have vectors")
    return out, [p for p, _, _ in rows]


def note_links(
    vectors: VectorFile, rows: list[Passage], n_notes: int
) -> tuple[list[tuple[int, int]], set[int]]:
    """Links between notes by meaning: each note's nearest neighbour (its passages' mean
    vector, in its main model), kept when they're closer than the median such pair. Returns
    the links and the notes that have vectors (the others keep the galaxy's word links)."""
    if not rows:
        return [], set()
    by_note: dict[int, dict[int, list[int]]] = {}
    for i, p in enumerate(rows):
        by_note.setdefault(p.note, {}).setdefault(int(vectors.space[i]), []).append(i)
    grouped: dict[int, tuple[list[int], list[np.ndarray]]] = {}
    for note, spaces in by_note.items():
        space, members = max(spaces.items(), key=lambda s: (len(s[1]), -s[0]))
        mean = vectors.vecs[members].astype(np.float32).mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm > 0 and 0 <= note < n_notes:
            ids, vecs = grouped.setdefault(space, ([], []))
            ids.append(note)
            vecs.append(mean / norm)
    pairs: list[tuple[float, int, int]] = []
    for ids, vecs in grouped.values():
        if len(ids) < 2:
            continue
        matrix = np.stack(vecs)
        best, score = _nearest(matrix)
        pairs += [(float(score[a]), ids[a], ids[int(best[a])]) for a in range(len(ids))]
    if not pairs:
        return [], set(by_note)
    cut = float(np.median([s for s, _, _ in pairs]))
    links = {(min(a, b), max(a, b)) for s, a, b in pairs if s >= cut and a != b}
    return sorted(links), set(by_note)


def _nearest(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each row's most similar other row and how similar, LINK_BLOCK similarities at once."""
    m = len(vectors)
    block = max(1, LINK_BLOCK // max(1, m))
    best = np.zeros(m, dtype=np.int64)
    score = np.full(m, -1.0, dtype=np.float32)
    for start in range(0, m, block):
        sims = vectors[start : start + block] @ vectors.T
        rows = np.arange(sims.shape[0])
        sims[rows, rows + start] = -2  # not itself
        best[start : start + block] = np.argmax(sims, axis=1)
        score[start : start + block] = sims[rows, best[start : start + block]]
    return best, score


def merged_links(
    word_links: Iterable[tuple[int, int]],
    meaning_links: list[tuple[int, int]],
    with_vectors: set[int],
) -> list[tuple[int, int]]:
    """The galaxy's links: by meaning between notes with vectors, by words (the layout's
    TF-IDF neighbours) for the rest."""
    kept = {(a, b) for a, b in word_links if a not in with_vectors or b not in with_vectors} | set(
        meaning_links
    )
    return sorted(kept)


# ── searching (in the app) ──


class SemanticSearch:
    """What KnowledgeBase.search asks for search by meaning (kb.semantic): the vectors for
    the index loaded now (read from vectors.npz when the index changes), and the query's
    vector from the helper, kept running between searches. enabled() is the setting;
    make_embedder() gives the query's helper, or None while it isn't built."""

    def __init__(
        self,
        enabled: Callable[[], bool],
        make_embedder: Callable[[], Embedder | None],
        *,
        query_seconds: float = QUERY_SECONDS,
    ) -> None:
        self.enabled = enabled
        self.make_embedder = make_embedder
        self.query_seconds = query_seconds
        self._embedder: Embedder | None = None
        self._lock = threading.Lock()  # the vectors in memory
        self._query_lock = threading.Lock()
        self._loaded_key: tuple[Any, ...] | None = None
        self._spaces: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self._status: dict[str, Any] = {}
        self._quiet_until = 0.0
        self._warned = False

    def vectors(
        self, store: Path, built_at: str, n_chunks: int
    ) -> dict[str, tuple[np.ndarray, np.ndarray]]:
        """model -> (chunk numbers, float16 unit vectors) for this build of the index; empty
        when the file is missing or made for another build."""
        path = vectors_path(store)
        try:
            stamp = path.stat().st_mtime_ns
        except OSError:
            stamp = None
        key = (str(path), built_at, n_chunks, stamp)
        with self._lock:
            if key == self._loaded_key:
                return self._spaces
            found = VectorFile.read(path) if stamp is not None else None
            spaces: dict[str, tuple[np.ndarray, np.ndarray]] = {}
            status: dict[str, Any] = {}
            if found is not None:
                status = found.status()
                if found.built_at == built_at and found.n_chunks == n_chunks:
                    for code, model in enumerate(found.spaces):
                        rows = found.space == code
                        chunks = found.chunk[rows]
                        ok = (chunks >= 0) & (chunks < n_chunks)
                        spaces[model] = (chunks[ok], np.ascontiguousarray(found.vecs[rows][ok]))
                else:
                    status["stale"] = True
            self._loaded_key, self._spaces, self._status = key, spaces, status
            return spaces

    def status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status)

    def forget(self) -> None:
        """The setting went off: the vectors leave memory and the helper stops."""
        with self._lock:
            self._loaded_key, self._spaces = None, {}
        with self._query_lock:
            embedder, self._embedder = self._embedder, None
        if embedder is not None:
            embedder.close()

    def warm(self, store: Path, built_at: str, n_chunks: int) -> bool:
        """Ahead of the first search: the vectors in memory, and the helper started with its
        model loaded (a cold start can take longer than a search waits). True when ready."""
        if not self.enabled() or not self.vectors(store, built_at, n_chunks):
            return False
        with self._query_lock:
            if self._embedder is None:
                self._embedder = self.make_embedder()
            embedder = self._embedder
            if embedder is None:
                return False
            try:
                embedder.embed(["hello"], timeout=WARM_SECONDS)
            except Exception as exc:
                log.info("second brain: search by meaning's helper didn't start (%s)", exc)
                return False
        self._quiet_until = 0.0
        return True

    def query(self, text: str) -> Vector | None:
        """The query's vector, or None (no helper yet, no model for its language, a helper
        that didn't answer in time: the search goes on by words)."""
        if time.monotonic() < self._quiet_until:
            return None
        with self._query_lock:
            if self._embedder is None:
                self._embedder = self.make_embedder()
                if self._embedder is None:
                    return None
            try:
                answer = self._embedder.embed([text[:EMBED_CHARS]], timeout=self.query_seconds)[0]
            except Exception as exc:
                self._quiet_until = time.monotonic() + QUIET_SECONDS
                if not self._warned:
                    self._warned = True
                    log.warning("second brain: no vector for a search (%s); words only", exc)
                return None
        return answer if isinstance(answer, tuple) else None

    def best_chunks(
        self,
        text: str,
        store: Path,
        built_at: str,
        index: Any,
        allowed: np.ndarray | None,
    ) -> list[tuple[int, float]] | None:
        """Each note's closest passage to the query by meaning, closest first (MEANING_TOP at
        most); None when search by meaning can't help this time."""
        if not text.strip() or not self.enabled():
            return None
        spaces = self.vectors(store, built_at, len(index.chunk_note))
        if not spaces:
            return None
        found = self.query(text)
        if found is None:
            return None
        model, q = found
        entry = spaces.get(model)
        if entry is None:
            return None
        chunks, matrix = entry
        sims = similarities(matrix, q)
        if not len(sims):
            return []
        # How much a passage stands out is judged against its whole model's passages, before
        # any filter: a filter narrows what's shown, not what counts as close.
        z = (sims - sims.mean()) / (float(sims.std()) or 1.0)
        if allowed is not None:
            ok = allowed[index.chunk_note[chunks]]
            chunks, sims, z = chunks[ok], sims[ok], z[ok]
        # A small brain: too few passages for the test to mean much, so only the closest.
        top = MEANING_TOP if len(matrix) >= MEANING_Z_FROM else 1
        picked: list[tuple[int, float]] = []
        seen: set[int] = set()
        for j in np.argsort(-sims, kind="stable")[: top * CHUNKS_PER_NOTE]:
            if len(matrix) >= MEANING_Z_FROM and z[j] < MEANING_MIN_Z:
                break
            note = int(index.chunk_note[chunks[j]])
            if note in seen:
                continue
            seen.add(note)
            picked.append((int(chunks[j]), float(sims[j])))
            if len(picked) >= top:
                break
        return picked


def similarities(matrix: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Cosine similarity of float16 unit rows with a unit query, SIM_BLOCK rows made float32
    at a time (numpy has no fast float16 product: 0.2 s for 60,000 rows, against 0.05 s)."""
    q = np.asarray(q, dtype=np.float32)
    out = np.empty(len(matrix), dtype=np.float32)
    for start in range(0, len(matrix), SIM_BLOCK):
        out[start : start + SIM_BLOCK] = matrix[start : start + SIM_BLOCK].astype(np.float32) @ q
    return out


def fuse(
    keyword: list[tuple[int, float]],
    meaning: list[tuple[int, float]],
    chunk_note: np.ndarray,
    note_day: np.ndarray,
    k: int,
    now: float | None = None,
) -> list[tuple[int, float, str]]:
    """Reciprocal rank fusion of each note's best passage by words and by meaning, with a
    mild lift for recent notes: [(chunk, score, "words" | "meaning" | "both")] best first.
    The passage shown is the words' one when there is one (its excerpt has them)."""
    ranked: dict[int, list[Any]] = {}
    for rank, (chunk, _score) in enumerate(keyword[:KEYWORD_TOP]):
        ranked[int(chunk_note[chunk])] = [1 / (RRF_K + rank + 1), int(chunk), "words"]
    for rank, (chunk, _sim) in enumerate(meaning):
        note = int(chunk_note[chunk])
        entry = ranked.get(note)
        if entry is None:
            ranked[note] = [1 / (RRF_K + rank + 1), int(chunk), "meaning"]
        else:
            entry[0] += 1 / (RRF_K + rank + 1)
            entry[2] = "both"
    now = today() if now is None else now
    scored = []
    for note, (score, chunk, how) in ranked.items():
        day = float(note_day[note]) if 0 <= note < len(note_day) else math.nan
        if math.isfinite(day):
            score *= 1 + RECENCY_LIFT * 0.5 ** (max(0.0, now - day) / RECENCY_HALF_DAYS)
        scored.append((score, note, chunk, how))
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [(chunk, score * 100, how) for score, _note, chunk, how in scored[:k]]
