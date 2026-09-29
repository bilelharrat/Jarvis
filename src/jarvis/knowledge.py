"""The second brain: Apple Notes, chosen folders, the BSH research desk and JARVIS's own
research reports, indexed locally for search and laid out in 3D as a "knowledge galaxy".

Everything stays on this Mac. Search is BM25 over ~1,200-character chunks. Galaxy
positions come from TF-IDF vectors projected down to three dimensions, so notes about
similar things drift together.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from .prefs import APP_SUPPORT

RESEARCH_DIR = Path.home() / "Documents" / "Jarvis" / "Research"
TEXT_SUFFIXES = {".md", ".markdown", ".txt", ".org", ".rst"}
RICH_SUFFIXES = {".docx", ".doc", ".rtf", ".rtfd", ".pages"}
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv", "dist", "build"}
MAX_FILES_PER_FOLDER = 4000
MAX_TEXT = 200_000
CHUNK = 1200

_WORD = re.compile(r"[a-z0-9][a-z0-9'\-]+")
_STOP = set(
    "the and for with that this from are was were has have its our their into not but you they "
    "them than then will would can could should about which what when where who how also just "
    "your been being there here some more most other such only over very any all may one two "
    "out off per via use used using make made get got".split()
)
# Words too generic to name a cluster in the galaxy.
_LABEL_STOP = _STOP | set(
    "com https http www html org net new note notes had like time back people know want need "
    "going good think really thing things well much many even still said says see way day days "
    "year years week today yes okay thanks thank please let can't don't i'm it's that's".split()
)


def tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 2]


@dataclass
class Note:
    id: str
    source: str  # notes | files | computer | bsh | research | photos | mail | messages
    title: str
    text: str
    ref: str  # Apple Notes id, file path, or BSH reference
    group: str = ""
    modified: str = ""


# ── collectors ──

NOTES_JXA = r"""
const Notes = Application('Notes');
const out = [];
for (const folder of Notes.folders()) {
  const fname = folder.name();
  if (fname === 'Recently Deleted') continue;
  const notes = folder.notes;
  const ids = notes.id(), names = notes.name(), bodies = notes.plaintext(), mods = notes.modificationDate();
  for (let i = 0; i < ids.length; i++) {
    out.push({id: ids[i], title: names[i], text: bodies[i], folder: fname, modified: mods[i] ? mods[i].toISOString() : ''});
  }
}
JSON.stringify(out);
"""

BSH_EXPORT = (
    "import json; from server import firm_search; "
    "print(json.dumps([{k: d.get(k) for k in ('kind','title','text','company_id','ref','at')} "
    "for d in firm_search._docs()], default=str))"
)


def collect_apple_notes(run: Callable[..., str] | None = None) -> list[Note]:
    run = run or _run_jxa
    data = json.loads(run(NOTES_JXA) or "[]")
    notes = []
    for item in data:
        text = (item.get("text") or "").strip()
        if not text:
            continue
        notes.append(
            Note(
                id=f"notes:{item['id']}",
                source="notes",
                title=(item.get("title") or text.splitlines()[0])[:120],
                text=text[:MAX_TEXT],
                ref=item["id"],
                group=item.get("folder", ""),
                modified=item.get("modified", ""),
            )
        )
    return notes


def _run_jxa(script: str) -> str:
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", "-"],
        input=script,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "Apple Notes didn't answer")
    return proc.stdout


def collect_folder(folder: Path, source: str = "files") -> list[Note]:
    notes: list[Note] = []
    if not folder.is_dir():
        return notes
    for path in _walk(folder):
        text = read_document(path)
        if not text or not text.strip():
            continue
        notes.append(
            Note(
                id=f"file:{path}",
                source=source,
                title=_title_for(path, text),
                text=text[:MAX_TEXT],
                ref=str(path),
                group=folder.name if path.parent == folder else path.parent.name,
                modified=datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
            )
        )
        if len(notes) >= MAX_FILES_PER_FOLDER:
            break
    return notes


def _walk(folder: Path):
    stack = [folder]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                if entry.name not in SKIP_DIRS and not entry.is_symlink():
                    stack.append(entry)
            elif entry.suffix.lower() in TEXT_SUFFIXES | RICH_SUFFIXES | {".pdf"}:
                yield entry


def read_document(path: Path, limit: int = MAX_TEXT) -> str:
    """Plain text from a text, Markdown, PDF, Word, RTF or Pages file ('' if unreadable)."""
    suffix = path.suffix.lower()
    try:
        if path.stat().st_size > 40_000_000:
            return ""
        if suffix in TEXT_SUFFIXES:
            return path.read_text(errors="replace")[:limit]
        if suffix == ".pdf":
            from pypdf import PdfReader

            reader = PdfReader(str(path))
            parts, size = [], 0
            for page in reader.pages[:200]:
                text = page.extract_text() or ""
                parts.append(text)
                size += len(text)
                if size > limit:
                    break
            return "\n".join(parts)[:limit]
        if suffix in RICH_SUFFIXES:
            out = subprocess.run(
                ["textutil", "-convert", "txt", "-stdout", str(path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            return out.stdout[:limit] if out.returncode == 0 else ""
    except Exception:  # corrupt PDF, permission denied, odd encoding
        return ""
    return ""


def _title_for(path: Path, text: str) -> str:
    for line in text.splitlines()[:5]:
        line = line.strip().lstrip("#").strip()
        if 3 <= len(line) <= 120:
            return line
    return path.stem


def collect_bsh(bsh_dir: Path) -> list[Note]:
    if not (bsh_dir / "server" / "firm_search.py").is_file():
        return []
    proc = subprocess.run(
        ["uv", "run", "--directory", str(bsh_dir), "python", "-c", BSH_EXPORT],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-400:] or "BSH export failed")
    docs = json.loads(proc.stdout.strip().splitlines()[-1] or "[]")
    notes = []
    for i, d in enumerate(docs):
        text = (d.get("text") or "").strip()
        if not text:
            continue
        title = d.get("title") or d.get("kind") or "BSH record"
        notes.append(
            Note(
                id=f"bsh:{d.get('kind')}:{d.get('ref') or i}:{i}",
                source="bsh",
                title=title[:140],
                text=text[:MAX_TEXT],
                ref=str(d.get("ref") or ""),
                group=title.split(" — ")[0][:60],
                modified=str(d.get("at") or ""),
            )
        )
    return notes


# ── the index ──


def chunk_text(title: str, text: str, size: int = CHUNK) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    chunks, current = [], ""
    for para in paragraphs:
        if current and len(current) + len(para) > size:
            chunks.append(current)
            current = ""
        while len(para) > size:
            chunks.append(para[:size])
            para = para[size:]
        current = f"{current}\n{para}".strip()
    if current:
        chunks.append(current)
    return chunks or [title]


class KnowledgeBase:
    def __init__(self, store: Path | None = None) -> None:
        self.store = store or APP_SUPPORT / "brain" / "index.json"
        self.notes: list[Note] = []
        self.positions: np.ndarray = np.zeros((0, 3), dtype=np.float32)
        self.edges: list[tuple[int, int]] = []
        self.clusters: list[dict[str, Any]] = []
        self.built_at = ""
        self.errors: dict[str, str] = {}
        self._by_id: dict[str, int] = {}
        self._chunks: list[tuple[int, str]] = []
        self._postings: dict[str, list[tuple[int, int]]] = {}
        self._chunk_len: list[int] = []
        self._avg_len = 1.0
        self._lock = threading.RLock()

    # building

    def build(self, collected: dict[str, list[Note]], errors: dict[str, str] | None = None) -> None:
        notes = [n for source in sorted(collected) for n in collected[source]]
        seen, unique = set(), []
        for n in notes:
            if n.id not in seen:
                seen.add(n.id)
                unique.append(n)
        positions, edges, clusters = layout(
            [f"{n.title}\n{n.text}" for n in unique], [n.source for n in unique]
        )
        with self._lock:
            self.notes = unique
            self.positions = positions
            self.edges = edges
            self.clusters = clusters
            self.errors = dict(errors or {})
            self.built_at = datetime.now().isoformat(timespec="seconds")
            self._reindex()

    def _reindex(self) -> None:
        self._by_id = {n.id: i for i, n in enumerate(self.notes)}
        self._chunks = []
        for i, n in enumerate(self.notes):
            for chunk in chunk_text(n.title, n.text):
                self._chunks.append((i, chunk))
        postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self._chunk_len = []
        for c, (i, chunk) in enumerate(self._chunks):
            words = tokens(f"{self.notes[i].title} {chunk}")
            self._chunk_len.append(len(words))
            for word, tf in Counter(words).items():
                postings[word].append((c, tf))
        self._postings = dict(postings)
        self._avg_len = (sum(self._chunk_len) / len(self._chunk_len)) if self._chunk_len else 1.0

    # persistence

    def save(self) -> None:
        with self._lock:
            data = {
                "built_at": self.built_at,
                "errors": self.errors,
                "notes": [asdict(n) for n in self.notes],
                "positions": self.positions.round(4).tolist(),
                "edges": self.edges,
                "clusters": self.clusters,
            }
        self.store.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.store.with_suffix(".tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(self.store)

    def load(self) -> bool:
        try:
            data = json.loads(self.store.read_text())
        except (OSError, ValueError):
            return False
        with self._lock:
            self.notes = [Note(**n) for n in data.get("notes", [])]
            self.positions = np.array(data.get("positions") or [], dtype=np.float32).reshape(-1, 3)
            self.edges = [tuple(e) for e in data.get("edges", [])]
            self.clusters = data.get("clusters", [])
            self.built_at = data.get("built_at", "")
            self.errors = data.get("errors", {})
            self._reindex()
        return True

    def notes_by_source(self) -> dict[str, list[Note]]:
        grouped: dict[str, list[Note]] = defaultdict(list)
        for n in self.notes:
            grouped[n.source].append(n)
        return dict(grouped)

    def age_hours(self) -> float:
        if not self.built_at:
            return math.inf
        return (datetime.now() - datetime.fromisoformat(self.built_at)).total_seconds() / 3600

    # querying

    def search(self, query: str, k: int = 6) -> list[dict[str, Any]]:
        words = tokens(query)
        with self._lock:
            if not words or not self._chunks:
                return []
            n_chunks = len(self._chunks)
            scores: dict[int, float] = defaultdict(float)
            for word in set(words):
                posting = self._postings.get(word)
                if not posting:
                    continue
                idf = math.log(1 + (n_chunks - len(posting) + 0.5) / (len(posting) + 0.5))
                for c, tf in posting:
                    norm = (
                        tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * self._chunk_len[c] / self._avg_len))
                    )
                    scores[c] += idf * norm
            best: dict[int, tuple[float, int]] = {}
            for c, score in scores.items():
                note = self._chunks[c][0]
                if note not in best or score > best[note][0]:
                    best[note] = (score, c)
            ranked = sorted(best.items(), key=lambda item: -item[1][0])[:k]
            return [
                {
                    "id": self.notes[i].id,
                    "title": self.notes[i].title,
                    "source": self.notes[i].source,
                    "group": self.notes[i].group,
                    "score": round(score, 3),
                    "excerpt": excerpt(self._chunks[c][1], words),
                }
                for i, (score, c) in ranked
            ]

    def get(self, note_id: str) -> Note | None:
        with self._lock:
            i = self._by_id.get(note_id)
            return self.notes[i] if i is not None else None

    def galaxy(self) -> dict[str, Any]:
        with self._lock:
            return {
                "nodes": [
                    {
                        "id": n.id,
                        "title": n.title,
                        "source": n.source,
                        "group": n.group,
                        "p": [round(float(v), 4) for v in self.positions[i]],
                    }
                    for i, n in enumerate(self.notes)
                ],
                "edges": self.edges,
                "clusters": self.clusters,
                "built_at": self.built_at,
            }

    def summary(self) -> dict[str, Any]:
        with self._lock:
            counts = Counter(n.source for n in self.notes)
            return {
                "notes": len(self.notes),
                "by_source": dict(counts),
                "built_at": self.built_at,
                "errors": self.errors,
            }


def excerpt(text: str, words: list[str], width: int = 360) -> str:
    lower = text.lower()
    hits = [lower.find(w) for w in words if lower.find(w) >= 0]
    start = max(0, min(hits) - width // 3) if hits else 0
    snippet = text[start : start + width].strip()
    return ("…" if start else "") + snippet + ("…" if start + width < len(text) else "")


def _vectors(texts: list[str], rng) -> tuple[np.ndarray, list[str], list[Counter]]:
    """Unit TF-IDF vectors randomly projected to 64 dims (zero rows for word-less notes)."""
    n = len(texts)
    docs = [Counter(tokens(t)) for t in texts]
    df = Counter(w for d in docs for w in d)
    vocab = [w for w, c in df.most_common(6000) if 1 < c <= max(2, int(0.5 * n))]
    reduced = np.zeros((n, 64), dtype=np.float32)
    if len(vocab) < 8:
        return reduced, vocab, docs
    index = {w: j for j, w in enumerate(vocab)}
    idf = np.array([math.log(n / df[w]) + 1 for w in vocab], dtype=np.float32)
    projection = rng.standard_normal((len(vocab), 64)).astype(np.float32) / 8
    for i, d in enumerate(docs):
        cols = [(index[w], c) for w, c in d.items() if w in index]
        if not cols:
            continue
        j = np.array([c[0] for c in cols])
        v = (1 + np.log(np.array([c[1] for c in cols], dtype=np.float32))) * idf[j]
        v /= np.linalg.norm(v) or 1
        reduced[i] = v @ projection[j]
    norms = np.linalg.norm(reduced, axis=1, keepdims=True)
    reduced /= np.where(norms == 0, 1, norms)
    return reduced, vocab, docs


def _kmeans(x: np.ndarray, k: int, rng, rounds: int = 15) -> np.ndarray:
    """Spherical k-means (cosine) with k-means++ seeding; returns a label per row."""
    n = x.shape[0]
    centers = [x[rng.integers(n)]]
    for _ in range(1, k):
        d = 1 - np.max(x @ np.array(centers).T, axis=1)
        d = np.clip(d, 0, None) ** 2
        total = d.sum()
        centers.append(x[rng.choice(n, p=d / total)] if total > 0 else x[rng.integers(n)])
    c = np.array(centers)
    labels = np.zeros(n, dtype=int)
    for _ in range(rounds):
        labels = np.argmax(x @ c.T, axis=1)
        for j in range(k):
            members = x[labels == j]
            if len(members):
                mean = members.mean(axis=0)
                c[j] = mean / (np.linalg.norm(mean) or 1)
    return labels


def _ball(m: int, rng) -> np.ndarray:
    """m points spread evenly through a unit ball (Fibonacci shells), so nothing overlaps."""
    i = np.arange(m) + 0.5
    radius = np.cbrt(i / m)
    z = 1 - 2 * ((i * 0.618034) % 1)
    theta = np.pi * (1 + 5**0.5) * i
    ring = np.sqrt(np.clip(1 - z * z, 0, 1))
    pts = np.stack([ring * np.cos(theta), z, ring * np.sin(theta)], axis=1) * radius[:, None]
    return pts + rng.normal(0, 0.02, pts.shape)


def layout(
    texts: list[str], sources: list[str] | None = None, seed: int = 7
) -> tuple[np.ndarray, list[tuple[int, int]], list[dict[str, Any]]]:
    """Galaxy coordinates, a few links per note, and labelled clusters.

    Notes are grouped into topic clusters ("star systems"). Clusters sit on a spiral
    disc, biggest near the middle; inside each, stars are spaced evenly through a ball
    and ordered by topic, so similar notes stay near each other without piling up.
    """
    n = len(texts)
    rng = np.random.default_rng(seed)
    if n == 0:
        return np.zeros((0, 3), dtype=np.float32), [], []
    reduced, vocab, docs = _vectors(texts, rng)
    df_all = Counter(w for d in docs for w in d)
    has_words = np.linalg.norm(reduced, axis=1) > 0
    labels = np.full(n, -1)
    k = int(np.clip(round(math.sqrt(n / 5)), 1, 30)) if has_words.sum() >= 6 else 1
    if has_words.sum() >= 6 and k > 1:
        labels[has_words] = _kmeans(reduced[has_words], k, rng)
    else:
        labels[has_words] = 0
    # Word-less notes (photos, one-liners) cluster by source instead of piling in the middle.
    extra = k
    for source in sorted(set(sources or ["other"])):
        mask = (labels == -1) & (np.array(sources) == source if sources else True)
        if mask.any():
            labels[mask] = extra
            extra += 1
    ids = [c for c in range(extra) if (labels == c).any()]
    ids.sort(key=lambda c: -(labels == c).sum())
    biggest = max((labels == c).sum() for c in ids)
    positions = np.zeros((n, 3), dtype=np.float32)
    clusters: list[dict[str, Any]] = []
    golden = math.pi * (3 - math.sqrt(5))
    for rank, c in enumerate(ids):
        members = np.where(labels == c)[0]
        m = len(members)
        radius = 0.35 + 1.25 * math.sqrt((rank + 0.5) / len(ids)) if len(ids) > 1 else 0.0
        angle = rank * golden
        center = np.array([radius * math.cos(angle), rng.normal(0, 0.06), radius * math.sin(angle)])
        size = 0.09 + 0.3 * math.sqrt(m / biggest)
        pts = _ball(m, rng) * size
        pts[:, 1] *= 0.7
        # Keep topic order inside the cluster: pair stars sorted by their main direction
        # with ball points sorted along x.
        if m > 2 and has_words[members].all():
            local = reduced[members] - reduced[members].mean(axis=0)
            _, _, vt = np.linalg.svd(local, full_matrices=False)
            order = np.argsort(local @ vt[0])
            members = members[order]
            pts = pts[np.argsort(pts[:, 0])]
        positions[members] = center + pts
        clusters.append(
            {
                "label": _cluster_label(docs, members, df_all, n, sources),
                "p": center.round(4).tolist(),
                "size": m,
            }
        )
    edges = set()
    for c in ids:
        members = np.where(labels == c)[0]
        if len(members) < 2 or not has_words[members].all():
            continue
        sims = reduced[members] @ reduced[members].T
        np.fill_diagonal(sims, -1)
        best = np.argmax(sims, axis=1)
        for a, b in enumerate(best):
            if sims[a, b] > 0.35:
                i, j = int(members[a]), int(members[b])
                edges.add((min(i, j), max(i, j)))
    return positions, sorted(edges), clusters


def _cluster_label(docs, members, df_all, n, sources) -> str:
    """The words that set this cluster apart: common inside it, rarer everywhere else."""
    inside: Counter = Counter()
    for i in members:
        inside.update(w for w in docs[i] if w not in _LABEL_STOP and not w.isdigit() and len(w) > 3)
    m = len(members)
    scored = [
        (count / m * math.log(n / df_all[w]), w)
        for w, count in inside.items()
        if count >= max(2, m * 0.08)
    ]
    top = [w for _, w in sorted(scored, reverse=True)[:3]]
    if top:
        return " · ".join(top)
    if sources:
        return {"photos": "Photos", "messages": "Texts", "mail": "Email"}.get(
            sources[members[0]], "Notes"
        )
    return "Notes"


class Collector:
    """Gathers every enabled source, reusing what a partial rebuild doesn't touch."""

    def __init__(self, kb: KnowledgeBase, bsh_dir: Path | None) -> None:
        self.kb = kb
        self.bsh_dir = bsh_dir

    def run(
        self,
        *,
        notes: bool,
        bsh: bool,
        folders: list[str],
        computer: bool = False,
        photos: bool = False,
        mail: bool = False,
        messages: bool = False,
        only: set[str] | None = None,
        progress: Callable[[str], None] = lambda _msg: None,
    ) -> dict[str, Any]:
        previous = self.kb.notes_by_source()
        collected: dict[str, list[Note]] = {}
        # A partial rebuild keeps the other sources' problems on record.
        errors: dict[str, str] = {k: v for k, v in self.kb.errors.items() if only and k not in only}

        def gather(source: str, fn: Callable[[], list[Note]]) -> None:
            if only is not None and source not in only:
                collected[source] = previous.get(source, [])
                return
            progress(f"Reading {source}…")
            started = time.monotonic()
            try:
                collected[source] = fn()
            except Exception as exc:  # permission denied, BSH broken, Notes busy
                errors[source] = str(exc)[:300]
                collected[source] = previous.get(source, [])
            progress(
                f"Read {len(collected[source])} from {source} in {time.monotonic() - started:.0f}s"
            )

        if notes:
            gather("notes", collect_apple_notes)
        if bsh and self.bsh_dir is not None:
            gather("bsh", lambda: collect_bsh(self.bsh_dir))
        if folders:
            gather("files", lambda: [n for f in folders for n in collect_folder(Path(f))])
        from . import sources as more

        if computer:
            gather("computer", more.collect_computer)
        if photos:
            gather("photos", more.collect_photos)
        if mail:
            gather("mail", more.collect_mail)
        if messages:
            gather("messages", more.collect_messages)
        gather("research", lambda: collect_folder(RESEARCH_DIR, source="research"))
        progress("Arranging the galaxy…")
        self.kb.build(collected, errors)
        self.kb.save()
        return self.kb.summary()
