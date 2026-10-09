"""The second brain: Apple Notes, chosen folders, the BSH research desk and JARVIS's own
research reports, indexed locally for search and laid out in 3D as a "knowledge galaxy".

Everything stays on this Mac. Search is BM25 over ~1,200-character chunks, fused with
search by meaning when that's on (jarvis.embeddings, through KnowledgeBase.semantic). Galaxy
positions come from TF-IDF vectors projected down to three dimensions, so notes about
similar things drift together. The index (brain/index.json) keeps the notes; the words BM25
searches are kept beside it (index.words.npz), so a start needn't index them again.
"""

from __future__ import annotations

import contextlib
import hashlib
import heapq
import json
import logging
import math
import os
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from array import array
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import asdict, dataclass, fields
from datetime import datetime
from itertools import filterfalse, islice, repeat
from pathlib import Path
from typing import Any

import numpy as np

from . import osplat
from .jsonstore import _sweep
from .prefs import APP_SUPPORT

log = logging.getLogger("jarvis")

RESEARCH_DIR = Path.home() / "Documents" / "Jarvis" / "Research"
MEETINGS_DIR = Path.home() / "Documents" / "Jarvis" / "Meetings"
VIDEOS_DIR = Path.home() / "Documents" / "Jarvis" / "Videos"  # video.py files write-ups here
TEXT_SUFFIXES = {".md", ".markdown", ".txt", ".org", ".rst"}
RICH_SUFFIXES = {".docx", ".doc", ".rtf", ".rtfd", ".pages"}
DOC_SUFFIXES = TEXT_SUFFIXES | RICH_SUFFIXES | {".pdf"}
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", "venv", "dist", "build"}
FOLDER_SOURCES = {"files", "computer", "research", "meetings", "videos"}
MAX_FILES_PER_FOLDER = 4000
MAX_TEXT = 200_000
CHUNK = 1200
SOURCE_SECONDS = 300  # all sources' share of a rebuild; past it a source keeps its last copy
READ_SECONDS = 60  # one document; past it (a PDF the parser goes round in circles on) it's skipped
READERS = 4  # processes reading documents, shared by every folder source of a rebuild
MAX_QUERY_CHARS = 400  # a search reads this much of the query...
MAX_QUERY_TERMS = 12  # ...and at most this many of its words, the rarest
SF_DATALESS = 0x40000000  # stat flag: an iCloud file whose contents aren't on this Mac yet

_ASCII_WORD = re.compile(r"[a-z0-9][a-z0-9'\-]{2,}")  # three characters or more
# Words in any alphabet: letters and digits, with ' and - inside ("can't", "wi-fi"). "_" is
# made a space first, so snake_case splits the way it does in ASCII.
_WORD = re.compile(r"\w[\w'\-]{2,}")
# Chinese and Japanese have no spaces between words: a run of them is indexed as its
# characters and its overlapping pairs (预算会议: 预 算 会 议 预算 算会 会议), so a word of any
# length inside it is found, and a pair that matches counts for more than lone characters.
# The same characters fileindex treats as CJK.
_CJK = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002fa1f"
_CJK_RUN = re.compile(f"[{_CJK}]+")
_LATIN_MARKS = re.compile("[\u0300-\u036f]")
# What fold() has to take accents off: accented Latin letters, and accents on their own.
_ACCENTED = re.compile("[\u00c0-\u024f\u0300-\u036f\u1e00-\u1eff]")
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


def fold(text: str) -> str:
    """Lowercase, in NFKC form (full-width Ｑ３ as q3), without the accents on Latin letters
    (résumé as resume, Zürich as zurich): how fileindex compares text too."""
    if text.isascii():
        return text.lower()
    if unicodedata.is_normalized("NFKC", text) and not _ACCENTED.search(text):
        return text.lower()  # curly quotes and dashes, say: nothing to fold (and it's quick)
    decomposed = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", text).lower())
    return unicodedata.normalize("NFC", _LATIN_MARKS.sub("", decomposed))


def tokens(text: str) -> list[str]:
    text = fold(text)
    if text.isascii():
        return list(filterfalse(_STOP.__contains__, _ASCII_WORD.findall(text)))
    runs = _CJK_RUN.findall(text)
    if runs:
        text = _CJK_RUN.sub(" ", text)
    words = list(filterfalse(_STOP.__contains__, _WORD.findall(text.replace("_", " "))))
    for run in runs:
        words += run  # each character
        words += [run[i : i + 2] for i in range(len(run) - 1)]  # and each pair
    return words


@dataclass
class Note:
    id: str
    # notes | files | computer | bsh | research | meetings | videos | photos | mail | messages,
    # and jarvis.brain_sources' conversations | images | safari | bookmarks | reminders |
    # voicememos | journal
    source: str
    title: str
    text: str
    ref: str  # Apple Notes id, file path, or BSH reference
    group: str = ""
    modified: str = ""


_NOTE_FIELDS = {f.name for f in fields(Note)}


def _saved_note(raw: Any) -> Note | None:
    """A note as index.json has it, or None if it isn't one. Fields another version of the
    app added are left out; missing optional ones take their defaults."""
    if not isinstance(raw, dict):
        return None
    kept = {k: v for k, v in raw.items() if k in _NOTE_FIELDS and isinstance(v, str)}
    if not all(k in kept for k in ("id", "source", "title", "text", "ref")):
        return None
    return Note(**kept)


def _redacted(note: Note) -> Note:
    """The note with what looks like a password, key, token, card or account number blanked
    out (fileindex.redact), before it's stored or handed to Claude."""
    from .fileindex import redact

    note.title = redact(note.title)
    note.text = redact(note.text)
    note.group = redact(note.group)  # shown in the galaxy and given to Claude with each hit
    return note


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


def collect_folder(
    folder: Path,
    source: str = "files",
    limit: int = MAX_FILES_PER_FOLDER,
    newest_first: bool = False,
    readers: Any = None,
) -> list[Note]:
    """Index a folder's documents. The walk stops at `limit` documents (or, newest first,
    keeps only the newest `limit`), and only those are read, on reader processes
    (`readers`, the rebuild's, or a few of its own): PDFs are slow to parse, and a document
    that takes the parser round in circles is given up on after READ_SECONDS. What the file
    index keeps out stays out: files named for what they guard, private ones, links, iCloud
    files not on this Mac, and passwords, keys and card numbers in the rest (blanked out)."""
    if not folder.is_dir():
        return []
    if newest_first:  # every document's date is needed, but never a list of them all
        paths = heapq.nlargest(limit, _walk(folder), key=_mtime)
    else:  # the walk stops at the cut (70,000 paths were listed to keep 4,000)
        paths = list(islice(_walk(folder), limit))
    if readers is not None:
        texts = list(readers.map(_read_one, paths, chunksize=8))
    elif len(paths) > 40 or any(p.suffix.lower() == ".pdf" for p in paths):
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=READERS, initializer=_reader_start) as pool:
            texts = list(pool.map(_read_one, paths, chunksize=8))
    else:  # a few text files: never blocking (see read_document), no need for processes
        texts = [_read_one(p, deadline=False) for p in paths]
    notes: list[Note] = []
    for path, text in zip(paths, texts, strict=True):
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
                modified=datetime.fromtimestamp(_mtime(path)).isoformat(timespec="seconds"),
            )
        )
    return notes


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _walk(folder: Path):
    """The documents under a folder, the way the file index walks: no hidden or build
    folders, nothing named for a secret (Passwords.txt, Recovery codes/…) or private
    (computer.is_sensitive), and no links, which could lead anywhere. os.scandir says what
    each entry is from the folder's listing, without a stat per file."""
    from .computer import is_sensitive
    from .fileindex import SECRET_NAME
    from .private_folders import is_private

    if is_private(folder):
        return  # a folder the owner keeps private: none of it goes in the second brain
    stack = [str(folder)]
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
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            if is_dir:
                if name not in SKIP_DIRS and not is_private(entry.path):
                    stack.append(entry.path)
            elif os.path.splitext(name)[1].lower() in DOC_SUFFIXES:
                path = Path(entry.path)
                if not is_sensitive(path) and not is_private(path):
                    yield path


class _TooSlow(BaseException):
    """A document past READ_SECONDS. Not an Exception, so no `except Exception` in a parser
    swallows it and carries on."""


def _reader_start() -> None:
    """Each reader process: SIGALRM ends a document that takes too long (_read_one), and
    the process leaves once the rebuild that started it is gone, rather than wait on."""
    import signal

    def too_slow(_signum, _frame):
        raise _TooSlow

    if hasattr(signal, "SIGALRM"):  # (Windows has none: a slow document waits)
        signal.signal(signal.SIGALRM, too_slow)
    parent = os.getppid()

    def watch() -> None:
        if hasattr(os, "fork"):
            while os.getppid() == parent:
                time.sleep(2)
        else:
            import psutil

            while psutil.pid_exists(parent):
                time.sleep(2)
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def _read_one(path: Path, deadline: bool = True) -> str:
    """A document's text for the brain, secrets blanked out. In a reader process it gets
    READ_SECONDS at most."""
    import signal

    from .fileindex import redact

    try:
        if deadline and hasattr(signal, "alarm"):
            signal.alarm(READ_SECONDS)
        try:
            return redact(read_document(path, download=False))
        finally:
            if deadline and hasattr(signal, "alarm"):
                signal.alarm(0)
    except _TooSlow:
        log.info("second brain: a document took too long to read; skipped")
        return ""


def read_document(
    path: Path, limit: int = MAX_TEXT, *, download: bool = True, pages: int = 40
) -> str:
    """Plain text from a text, Markdown, PDF, Word, RTF or Pages file ('' if unreadable).
    Only a plain file is read (a pipe named notes.md would never answer); with
    download=False, an iCloud file whose contents aren't on this Mac is skipped rather than
    fetched just to be read. pages: how many pages of a PDF may be read (as many as are needed
    for `limit` characters, up to this)."""
    from .private_folders import is_private

    suffix = path.suffix.lower()
    if suffix not in DOC_SUFFIXES or is_private(path):
        return ""  # (a file in a folder the owner keeps private is never read for Claude)
    try:
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 25_000_000:
            return ""
        if not download and getattr(info, "st_flags", 0) & SF_DATALESS:
            return ""
        if suffix in RICH_SUFFIXES and osplat.IS_WIN:  # (no textutil on a PC)
            from .rich_text import text_of

            return text_of(path, limit)
        if suffix in RICH_SUFFIXES:
            out = subprocess.run(
                ["textutil", "-convert", "txt", "-stdout", str(path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            return out.stdout[:limit] if out.returncode == 0 else ""
        fd = os.open(path, os.O_RDONLY | osplat.O_NOFOLLOW | osplat.O_NONBLOCK | osplat.O_BINARY)
        with os.fdopen(fd, "rb") as fh:
            if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
                return ""  # swapped for something else since it was looked at
            if suffix in TEXT_SUFFIXES:
                # Enough bytes for `limit` characters of any UTF-8, never a 25 MB log whole.
                return fh.read(limit * 4).decode("utf-8", "replace")[:limit]
            from pypdf import PdfReader

            reader = PdfReader(fh)
            parts, size = [], 0
            for page in reader.pages[:pages]:
                text = page.extract_text() or ""
                parts.append(text)
                size += len(text)
                if size > limit:
                    break
            return "\n".join(parts)[:limit]
    except Exception:  # corrupt PDF, permission denied, odd encoding
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


class _Vocab(dict):
    """Word -> id, a new word getting the next one."""

    def __missing__(self, word: str) -> int:
        self[word] = n = len(self)
        return n


def _grouped(keys: np.ndarray) -> np.ndarray:
    """The order that groups equal keys, keeping their order within a group: a stable
    argsort done as radix passes over 16 bits at a time (a tenth of the time numpy's
    stable sort takes on 32-bit keys)."""
    order = np.argsort((keys & 0xFFFF).astype(np.uint16), kind="stable")
    if len(keys) and keys.max() > 0xFFFF:
        high = (keys >> 16).astype(np.uint16)[order]
        order = order[np.argsort(high, kind="stable")]
    return order


@dataclass
class _Index:
    """BM25 postings in flat numpy arrays: a term's chunks are ids[starts[t]:starts[t+1]].
    As Python lists of (chunk, count) tuples they cost ~100 bytes a posting (5.5x the text
    they index), and every full garbage collection walked them all, pausing the app for
    0.1-1.4 s; as arrays they cost 6 bytes a posting and the collector never looks inside.
    Chunks aren't kept as text: a hit's chunk is cut again from its note for the excerpt."""

    by_id: dict[str, int]
    by_source: dict[str, int]
    terms: dict[str, int]  # word -> its row in starts
    starts: np.ndarray  # int64, len(terms) + 1
    ids: np.ndarray  # int32 chunk ids, grouped by term, ascending within each
    tfs: np.ndarray  # uint16 counts, alongside ids
    chunk_note: np.ndarray  # int32: the note each chunk is from
    chunk_pos: np.ndarray  # int32: which of its note's chunks it is
    chunk_len: np.ndarray  # float32: words in the chunk
    avg_len: float
    note_day: np.ndarray  # float64 per note: its modified day (embeddings.day_of), NaN if none

    @classmethod
    def of(cls, notes: list[Note]) -> _Index:
        from .embeddings import day_of

        vocab = _Vocab()
        term_of, chunk_of, count_of = array("i"), array("i"), array("I")
        chunk_note, chunk_pos, chunk_len = array("i"), array("i"), array("f")
        for i, n in enumerate(notes):
            for pos, chunk in enumerate(chunk_text(n.title, n.text)):
                c = len(chunk_note)
                words = tokens(f"{n.title} {chunk}")
                chunk_note.append(i)
                chunk_pos.append(pos)
                chunk_len.append(len(words))
                counts = Counter(words)
                term_of.extend([vocab[w] for w in counts])
                count_of.extend(counts.values())
                chunk_of.extend(repeat(c, len(counts)))
        terms_arr = np.frombuffer(term_of, dtype=np.int32) if term_of else np.zeros(0, np.int32)
        order = _grouped(terms_arr)
        starts = np.zeros(len(vocab) + 1, dtype=np.int64)
        np.cumsum(np.bincount(terms_arr, minlength=len(vocab)), out=starts[1:])
        lengths = (
            np.frombuffer(chunk_len, dtype=np.float32).copy()
            if chunk_len
            else np.zeros(0, np.float32)
        )
        return cls(
            by_id={n.id: i for i, n in enumerate(notes)},
            by_source=dict(Counter(n.source for n in notes)),
            terms=vocab,
            starts=starts,
            ids=np.frombuffer(chunk_of, dtype=np.int32)[order]
            if chunk_of
            else np.zeros(0, np.int32),
            tfs=np.minimum(np.frombuffer(count_of, dtype=np.uint32)[order], 65535).astype(np.uint16)
            if count_of
            else np.zeros(0, np.uint16),
            chunk_note=np.frombuffer(chunk_note, dtype=np.int32).copy()
            if chunk_note
            else np.zeros(0, np.int32),
            chunk_pos=np.frombuffer(chunk_pos, dtype=np.int32).copy()
            if chunk_pos
            else np.zeros(0, np.int32),
            chunk_len=lengths,
            avg_len=float(lengths.mean()) if len(lengths) else 1.0,
            note_day=np.array([day_of(n.modified) for n in notes], dtype=np.float64),
        )

    def posting(self, word: str) -> tuple[np.ndarray, np.ndarray] | None:
        row = self.terms.get(word)
        if row is None:
            return None
        start, end = self.starts[row], self.starts[row + 1]
        return self.ids[start:end], self.tfs[start:end]

    def write(self, path: Path, key: bytes, *, compress: bool = False) -> None:
        """The words and postings in a file of their own beside the index (index.words.npz),
        for the next load of this same index (key: _fingerprint) to read instead of making
        them again. Readable by the owner alone, like what it's made from. compress: a third
        of the size, for a second of work (a rebuild's, in its own process).

        It's written to a temp file of its own (two writers, in one process or two, never
        share one) named as jsonstore names its own, so the leftover of a write that was
        killed half way (a rebuild stopped as the app quits or runs out of time) is swept
        by the same rule (sweep_words)."""
        words = "\n".join(self.terms).encode("utf-8", "surrogatepass")  # no word has a \n
        path.parent.mkdir(parents=True, exist_ok=True)
        sweep_words(path)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                (np.savez_compressed if compress else np.savez)(
                    fh,
                    key=np.frombuffer(key, dtype=np.uint8),
                    words=np.frombuffer(words, dtype=np.uint8),
                    **{name: getattr(self, name) for name in _SAVED},
                )
            os.replace(tmp, path)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(tmp)

    @classmethod
    def read(cls, path: Path, key: bytes, notes: list[Note]) -> _Index | None:
        """What write() kept for this very index, checked, with the rest made from its notes
        (as of() makes them); None when there's none, or it's damaged or another index's."""
        from .embeddings import day_of

        try:
            with np.load(path, allow_pickle=False) as data:
                if data["key"].tobytes() != key:
                    return None
                arrays = {name: data[name] for name in _SAVED}
                words = data["words"].tobytes().decode("utf-8", "surrogatepass")
        except FileNotFoundError:
            return None
        except Exception as exc:  # cut short, not an npz, written by another version
            log.info("second brain: the saved words can't be used (%s)", type(exc).__name__)
            return None
        listed = words.split("\n") if words else []
        terms = _Vocab(zip(listed, range(len(listed)), strict=True))
        starts, ids, chunk_note = arrays["starts"], arrays["ids"], arrays["chunk_note"]
        n_chunks = len(chunk_note)
        if not (
            all(a.ndim == 1 and a.dtype == _SAVED[name] for name, a in arrays.items())
            and len(starts) == len(terms) + 1
            and starts[0] == 0
            and starts[-1] == len(ids) == len(arrays["tfs"])
            and bool(np.all(starts[1:] >= starts[:-1]))
            and len(arrays["chunk_pos"]) == len(arrays["chunk_len"]) == n_chunks
            and (not n_chunks or 0 <= chunk_note.min() <= chunk_note.max() < len(notes))
            and (not len(ids) or 0 <= ids.min() <= ids.max() < n_chunks)
        ):
            log.info("second brain: the saved words don't fit the index; indexing again")
            return None
        lengths = arrays["chunk_len"]
        return cls(
            by_id={n.id: i for i, n in enumerate(notes)},
            by_source=dict(Counter(n.source for n in notes)),
            terms=terms,
            **arrays,
            avg_len=float(lengths.mean()) if len(lengths) else 1.0,
            note_day=np.array([day_of(n.modified) for n in notes], dtype=np.float64),
        )


# What _Index.write keeps, and each array's type.
_SAVED = {
    "starts": np.dtype(np.int64),
    "ids": np.dtype(np.int32),
    "tfs": np.dtype(np.uint16),
    "chunk_note": np.dtype(np.int32),
    "chunk_pos": np.dtype(np.int32),
    "chunk_len": np.dtype(np.float32),
}


def words_path(store: Path) -> Path:
    """Where the index's words are kept: index.words.npz beside index.json."""
    return Path(store).with_suffix(".words.npz")


def sweep_words(path: Path) -> None:
    """The temp files beside the words (path) that writes killed half way left behind: a
    killed process's finally never runs, so each would stay for good, up to 11 MB apiece.
    Old ones only (jsonstore.STALE_SECONDS), so a write under way in another process is
    never touched."""
    _sweep(path)


def _recipe() -> bytes:
    """What makes the words: this module's code, the Python it runs on (with its Unicode
    tables) and numpy. Words saved by anything else are never read; b"" (the code can't be
    read) keeps none."""
    try:
        code = Path(__file__).read_bytes()
    except OSError:
        return b""
    made_by = (sys.version, unicodedata.unidata_version, np.__version__)
    return b"\0".join([code, *(part.encode() for part in made_by)])


# Read as the module is imported: the code that's running, even if the file changes later.
_RECIPE = _recipe()


def _fingerprint(text: str) -> bytes | None:
    """index.json's text and what makes its words (_RECIPE), as a key: saved words are read
    only for the very index they were made from."""
    if not _RECIPE:
        return None
    digest = hashlib.blake2b(_RECIPE, digest_size=16)
    for start in range(0, len(text), 1 << 24):  # never a second whole copy of a big index
        digest.update(text[start : start + (1 << 24)].encode("utf-8", "surrogatepass"))
    return digest.digest()


def _in_private_folder(note: Note) -> bool:
    """A note made from a file in a folder the owner keeps private (private_folders.py)."""
    from .private_folders import is_private

    ref = str(note.ref or "")
    return bool(ref) and os.path.isabs(ref) and is_private(ref, follow=False)


class KnowledgeBase:
    def __init__(self, store: Path | None = None) -> None:
        self.store = store or APP_SUPPORT / "brain" / "index.json"
        self.notes: list[Note] = []
        self.positions: np.ndarray = np.zeros((0, 3), dtype=np.float32)
        self.edges: list[tuple[int, int]] = []
        self.clusters: list[dict[str, Any]] = []
        self.built_at = ""
        self.errors: dict[str, str] = {}
        self._index = _Index.of([])
        self._galaxy: dict[str, Any] | None = None
        # Search by meaning (embeddings.SemanticSearch), set by jarvis.features.brain; None
        # (or the setting off, or no vectors yet) searches by words alone.
        self.semantic: Any = None
        # Held only to swap in a finished index and to take a consistent look at one. The
        # slow work (parsing, indexing, laying out) happens before it's taken, so a search
        # or a window's hello never waits behind a load or a build.
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
        index = _Index.of(unique)
        built_at = datetime.now().isoformat(timespec="seconds")
        with self._lock:
            self.notes = unique
            self.positions = positions
            self.edges = edges
            self.clusters = clusters
            self.errors = dict(errors or {})
            self.built_at = built_at
            self._index = index
            self._galaxy = None

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
            index = self._index
        self.store.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data)
        tmp = self.store.with_suffix(".tmp")
        tmp.write_text(text)
        tmp.replace(self.store)
        self._keep_words(index, _fingerprint(text), compress=True)

    def _keep_words(self, index: _Index, key: bytes | None, *, compress: bool = False) -> None:
        """The index's words kept beside it, for the next load. Only ever a shortcut: one
        that can't be written is indexed again then."""
        if key is None:
            return
        try:
            index.write(words_path(self.store), key, compress=compress)
        except Exception as exc:  # a full disk, a folder that isn't writable
            log.info("second brain: its words couldn't be kept (%s)", type(exc).__name__)

    def load(self) -> bool:
        """Read the saved index. It's only a cache of the sources: one that can't be read,
        or that another version of the app wrote in a shape this one doesn't know, leaves
        the brain as it was (the next rebuild writes a good one) instead of raising.

        Its words are read from beside it (index.words.npz) when they were kept for this
        very index; else they're made again, which took seconds of the app's start for a big
        brain, and kept for next time."""
        try:
            sweep_words(words_path(self.store))  # a load that writes nothing sweeps too
            text = self.store.read_text()
            key = _fingerprint(text)
            data = json.loads(text)
            del text  # what's parsed is all that's needed now
            notes, positions, edges, clusters = _saved_state(data)
            index = _Index.read(words_path(self.store), key, notes) if key else None
            if index is None:
                index = _Index.of(notes)
                self._keep_words(index, key)
        except Exception as exc:  # unreadable, a shape this version doesn't know, too deep
            if not isinstance(exc, FileNotFoundError):
                log.warning("second brain: the saved index can't be used (%s)", type(exc).__name__)
            return False
        errors = data.get("errors")
        with self._lock:
            self.notes = notes
            self.positions = positions
            self.edges = edges
            self.clusters = clusters
            self.built_at = str(data.get("built_at") or "")
            self.errors = (
                {str(k): str(v) for k, v in errors.items()} if isinstance(errors, dict) else {}
            )
            self._index = index
            self._galaxy = None
        return True

    def notes_by_source(self) -> dict[str, list[Note]]:
        grouped: dict[str, list[Note]] = defaultdict(list)
        for n in self.notes:
            grouped[n.source].append(n)
        return dict(grouped)

    def age_hours(self) -> float:
        try:
            built = datetime.fromisoformat(self.built_at)
        except ValueError:  # never built, or a date this version can't read
            return math.inf
        return (datetime.now() - built).total_seconds() / 3600

    # querying

    def search(
        self,
        query: str,
        k: int = 6,
        *,
        sources: Any = None,
        since: str = "",
        until: str = "",
    ) -> list[dict[str, Any]]:
        """The notes that best answer a query, each with its best passage as the excerpt:
        BM25 over the words, fused with search by meaning when that's on (self.semantic).
        sources (names), since and until (ISO dates, both days included) narrow it."""
        from .fileindex import redact

        text = str(query)[:MAX_QUERY_CHARS]
        words = tokens(text)
        with self._lock:
            notes, index, built_at = self.notes, self._index, self.built_at
        if not len(index.chunk_note) or not text.strip():
            return []
        allowed = _allowed(notes, index, sources, since, until)
        keyword = _by_words(index, words, allowed)
        meaning = None
        semantic = self.semantic
        if semantic is not None:
            try:
                meaning = semantic.best_chunks(text, self.store, built_at, index, allowed)
            except Exception:  # never worse than the words alone
                log.warning("second brain: search by meaning failed; words only", exc_info=True)
        if meaning:
            from .embeddings import fuse

            picked = fuse(keyword, meaning, index.chunk_note, index.note_day, k)
        else:
            picked = [(c, score, "words") for c, score in keyword[:k]]
        out = []
        for c, score, how in picked:
            n = notes[int(index.chunk_note[c])]
            if _in_private_folder(n):
                continue  # indexed before its folder was made private: never shown again
            chunks = chunk_text(n.title, n.text)
            chunk = chunks[min(int(index.chunk_pos[c]), len(chunks) - 1)]
            out.append(
                {
                    "id": n.id,
                    "title": redact(n.title),
                    "source": n.source,
                    "group": n.group,
                    "score": round(float(score), 3),
                    "match": how,
                    "modified": n.modified[:25],
                    "excerpt": excerpt(redact(chunk), words),
                }
            )
        return out

    def get(self, note_id: str) -> Note | None:
        with self._lock:
            i = self._index.by_id.get(note_id)
            note = self.notes[i] if i is not None else None
        return None if note is not None and _in_private_folder(note) else note

    def galaxy(self) -> dict[str, Any]:
        """The galaxy for the windows: made once per build or load, then the same one."""
        with self._lock:
            if self._galaxy is not None:
                return self._galaxy
            notes, positions, index = self.notes, self.positions, self._index
            edges, clusters, built_at = self.edges, self.clusters, self.built_at
        # float64 before rounding: a float32 0.1234 prints as 0.12340000271797180.
        points = positions.astype(np.float64).round(4).tolist()
        if len(points) != len(notes):  # never, since load() and build() check; never a crash
            points = [[0.0, 0.0, 0.0]] * len(notes)
        days = index.note_day if len(index.note_day) == len(notes) else None
        galaxy = {
            "nodes": [
                {
                    "id": n.id,
                    "title": n.title,
                    "source": n.source,
                    "group": n.group,
                    "p": points[i],
                    # The day it was last changed (days since 1970, local), for the time slider.
                    "t": int(days[i] // 1) if days is not None and math.isfinite(days[i]) else None,
                }
                for i, n in enumerate(notes)
            ],
            "edges": edges,
            "clusters": clusters,
            "built_at": built_at,
        }
        with self._lock:
            if self.notes is not notes:  # replaced meanwhile: this was the old brain's
                return galaxy
            if self._galaxy is None:  # two made at once: one of them is the build's
                self._galaxy = galaxy
            return self._galaxy

    def warm_semantic(self) -> bool:
        """Search by meaning readied ahead of the first search (embeddings.SemanticSearch)."""
        with self._lock:
            store, built_at, n_chunks = self.store, self.built_at, len(self._index.chunk_note)
        semantic = self.semantic
        return bool(semantic is not None and semantic.warm(store, built_at, n_chunks))

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "notes": len(self.notes),
                "by_source": dict(self._index.by_source),
                "built_at": self.built_at,
                "errors": self.errors,
            }


def _saved_state(data: Any) -> tuple[list[Note], np.ndarray, list[tuple[int, int]], list]:
    """What index.json holds, checked: its notes, their positions (laid out again when they
    don't match the notes), the edges between them and the clusters."""
    if not isinstance(data, dict):
        raise ValueError("not an index")
    raw = data.get("notes") or []
    if not isinstance(raw, list):
        raise ValueError("notes aren't a list")
    notes = [n for n in map(_saved_note, raw) if n is not None]
    try:
        positions = np.asarray(data.get("positions") or [], dtype=np.float32).reshape(-1, 3)
    except (ValueError, TypeError):
        positions = np.zeros((0, 3), dtype=np.float32)
    edges = [
        (int(e[0]), int(e[1]))
        for e in (data.get("edges") or [])
        if isinstance(e, list | tuple) and len(e) == 2
    ]
    clusters = [c for c in (data.get("clusters") or []) if isinstance(c, dict)]
    if len(notes) != len(raw) or len(positions) != len(notes):
        positions, edges, clusters = layout(
            [f"{n.title}\n{n.text}" for n in notes], [n.source for n in notes]
        )
    edges = [(a, b) for a, b in edges if 0 <= a < len(notes) and 0 <= b < len(notes)]
    return notes, positions, edges, clusters


def _allowed(
    notes: list[Note], index: _Index, sources: Any, since: str, until: str
) -> np.ndarray | None:
    """Which notes a search may return (None: all of them): those from `sources`, modified
    from `since` to `until` (ISO dates, both included). A time limit leaves out the undated."""
    if not sources and not since and not until:
        return None
    mask = np.ones(len(notes), dtype=bool)
    if sources:
        wanted = {str(s) for s in sources} if not isinstance(sources, str) else {sources}
        mask &= np.fromiter((n.source in wanted for n in notes), dtype=bool, count=len(notes))
    if since or until:
        from .embeddings import day_of

        days = index.note_day
        known = np.isfinite(days)
        mask &= known
        filled = np.where(known, days, 0.0)
        low = day_of(since) if since else math.nan
        high = day_of(until) if until else math.nan
        if math.isfinite(low):
            mask &= filled >= math.floor(low)
        if math.isfinite(high):
            mask &= filled < math.floor(high) + 1
    return mask


def _by_words(
    index: _Index, words: list[str], allowed: np.ndarray | None
) -> list[tuple[int, float]]:
    """BM25: each note's best chunk with its score, best notes first (allowed ones only)."""
    n_chunks = len(index.chunk_note)
    found = [p for w in dict.fromkeys(words) if (p := index.posting(w)) is not None]
    # A pasted page of text is searched by its most telling words, not every one.
    found = sorted(found, key=lambda p: len(p[0]))[:MAX_QUERY_TERMS]
    if not found:
        return []
    scores = np.zeros(n_chunks, dtype=np.float32)
    for ids, counts in found:
        tf = counts.astype(np.float32)
        idf = math.log(1 + (n_chunks - len(ids) + 0.5) / (len(ids) + 0.5))
        norm = tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * index.chunk_len[ids] / index.avg_len))
        scores[ids] += idf * norm  # a chunk is in a word's postings once
    if allowed is not None:
        scores[~allowed[index.chunk_note]] = 0
    hit = np.flatnonzero(scores)
    ranked = hit[np.argsort(-scores[hit], kind="stable")]
    _, first = np.unique(index.chunk_note[ranked], return_index=True)
    best = ranked[np.sort(first)]  # each note's best chunk, best notes first
    return [(int(c), float(scores[c])) for c in best]


def excerpt(text: str, words: list[str], width: int = 360) -> str:
    lower = fold(text)
    if len(lower) != len(text):  # folding changed the length: positions wouldn't line up
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


NEAREST_BLOCK = 1 << 22  # similarities worked out at once: 16 MB of float32


def _nearest(vectors: np.ndarray, block: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Each row's most similar other row, and how similar, a block of rows at a time (16 MB
    of similarities however big the cluster). The whole m x m matrix for a cluster of m
    look-alike notes (statements, receipts) took 4*m^2 bytes: 1.6 GB for 20,000 of them."""
    m = len(vectors)
    block = block or max(1, NEAREST_BLOCK // max(1, m))
    best = np.zeros(m, dtype=np.int64)
    score = np.full(m, -1.0, dtype=np.float32)
    for start in range(0, m, block):
        sims = vectors[start : start + block] @ vectors.T
        rows = np.arange(sims.shape[0])
        sims[rows, rows + start] = -1  # not itself
        best[start : start + block] = np.argmax(sims, axis=1)
        score[start : start + block] = sims[rows, best[start : start + block]]
    return best, score


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
        best, score = _nearest(reduced[members])
        for a, b in enumerate(best):
            if score[a] > 0.35:
                i, j = int(members[a]), int(members[b])
                edges.add((min(i, j), max(i, j)))
    return positions, sorted(edges), clusters


def _label_word(w: str) -> bool:
    if w in _LABEL_STOP or w.isdigit():
        return False
    return len(w) > 3 or (len(w) == 2 and bool(_CJK_RUN.fullmatch(w)))  # 会议, 预算


def _cluster_label(docs, members, df_all, n, sources) -> str:
    """The words that set this cluster apart: common inside it, rarer everywhere else."""
    inside: Counter = Counter()
    for i in members:
        inside.update(w for w in docs[i] if _label_word(w))
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
        extra: dict[str, Callable[[], list[Note]]] | None = None,
        finish: Callable[[KnowledgeBase, Callable[[str], None]], None] | None = None,
    ) -> dict[str, Any]:
        """extra: more sources, name -> collect(), read like the others (jarvis.brain_sources:
        conversations, text in images, bookmarks, reminders, voice memos). finish(kb,
        progress): run on the built index before it's saved (vectors for search by meaning,
        and the galaxy's links by meaning); a finish that fails leaves the index as built."""
        from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
        from concurrent.futures import TimeoutError as FutureTimeout

        previous = self.kb.notes_by_source()
        collected: dict[str, list[Note]] = {}
        # A partial rebuild keeps the other sources' problems on record.
        errors: dict[str, str] = {k: v for k, v in self.kb.errors.items() if only and k not in only}
        # One set of reader processes for all the folder sources (started as they're needed):
        # four sources with four each ran sixteen PDF parsers at once.
        readers = ProcessPoolExecutor(max_workers=READERS, initializer=_reader_start)

        jobs: dict[str, Callable[[], list[Note]]] = {}

        def gather(source: str, fn: Callable[[], list[Note]]) -> None:
            if only is not None and source not in only:
                collected[source] = previous.get(source, [])
            elif source in FOLDER_SOURCES:  # blanked out already, in the readers
                jobs[source] = fn
            else:
                jobs[source] = lambda: [_redacted(n) for n in fn()]

        if notes:
            gather("notes", collect_apple_notes)
        if bsh and self.bsh_dir is not None:
            gather("bsh", lambda: collect_bsh(self.bsh_dir))
        if folders:
            gather(
                "files",
                lambda: [n for f in folders for n in collect_folder(Path(f), readers=readers)],
            )
        from . import sources as more

        if computer:
            gather("computer", lambda: more.collect_computer(readers=readers))
        if photos:
            gather("photos", more.collect_photos)
        if mail:
            gather("mail", more.collect_mail_fast)
        if messages:
            gather("messages", more.collect_messages)
        gather("research", lambda: collect_folder(RESEARCH_DIR, source="research", readers=readers))
        gather("meetings", lambda: collect_folder(MEETINGS_DIR, source="meetings", readers=readers))
        gather("videos", lambda: collect_folder(VIDEOS_DIR, source="videos", readers=readers))
        for source, fn in (extra or {}).items():
            gather(source, fn)

        # Sources are independent (mostly other apps answering), so read them side by
        # side; a slow one can't hold up the rest, and all must be done in SOURCE_SECONDS.
        started = time.monotonic()
        pool = ThreadPoolExecutor(max_workers=max(1, len(jobs)))
        try:
            futures = {source: pool.submit(fn) for source, fn in jobs.items()}
            for source, future in futures.items():
                progress(f"Reading {source}…")
                try:
                    collected[source] = future.result(
                        timeout=max(1, SOURCE_SECONDS - (time.monotonic() - started))
                    )
                except FutureTimeout:
                    errors[source] = "took too long; kept the last copy"
                    collected[source] = previous.get(source, [])
                except Exception as exc:  # permission denied, BSH broken, Notes busy
                    errors[source] = str(exc)[:300]
                    collected[source] = previous.get(source, [])
                progress(
                    f"Read {len(collected[source])} from {source} ({time.monotonic() - started:.0f}s)"
                )
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
            readers.shutdown(wait=False, cancel_futures=True)
        progress("Arranging the galaxy…")
        self.kb.build(collected, errors)
        if finish is not None:
            try:
                finish(self.kb, progress)
            except Exception:  # the index is still good: saved as built
                log.exception("second brain: finishing the rebuild failed")
        self.kb.save()
        return self.kb.summary()
