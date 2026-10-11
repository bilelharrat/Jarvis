"""A project's vocabulary, for hearing code.

Speech recognition knows English, not `useEffect` or `tasks.py`. For the project in voice
focus this learns its file names and the identifiers defined in them, and uses them
three ways:

- hotwords: the names most worth hearing, handed to Whisper as hints;
- normalize: spoken forms back to code ("hub dot py" -> hub.py, "snake case max
  retries" -> max_retries, "camel case use effect" -> useEffect);
- mentions: which files and symbols the user most likely meant, sent to Claude Code
  alongside the request, so a misheard name still lands on the right file.
"""

from __future__ import annotations

import difflib
import os
import re
import subprocess
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

REFRESH_SECONDS = 600
# The file list alone (git ls-files, or a walk: not the names defined in the files) is
# listed again when it's older than this for the Files pane and @ (CF2-5: a file made after
# the list was read never showed for ten minutes, a reload included).
FILES_FRESH_SECONDS = 3.0  # the whole list, asked for as the Files pane opens or after a turn
FILES_QUERY_SECONDS = 15.0  # a big project's search among all of them, asked as one types
FILES_CHANGED_SECONDS = 0.5  # asked for because files changed (one ask per pane at once)
MAX_FILES = 20000  # files the vocabulary learns from (all_files lists them all)
ALL_FILES_MAX = 200_000  # a project's files listed, at most (for the Files pane's search)
WALK_FILES_MAX = 100_000  # ...and in a folder that isn't a git repository (walked)
MAX_SCANNED = 400
SOURCE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".swift", ".go", ".rs", ".java", ".kt",
    ".rb", ".c", ".h", ".cpp", ".cs", ".php", ".scala", ".sh",
}  # fmt: skip
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
SPOKEN_EXTS = {
    "py": "py", "python": "py", "js": "js", "javascript": "js", "ts": "ts", "typescript": "ts",
    "tsx": "tsx", "jsx": "jsx", "json": "json", "md": "md", "markdown": "md", "css": "css",
    "html": "html", "swift": "swift", "go": "go", "rs": "rs", "yaml": "yaml", "yml": "yml",
    "toml": "toml", "sh": "sh", "txt": "txt", "sql": "sql",
}  # fmt: skip
_DEFS = re.compile(
    # A line start never looks past its own line: with ^\s*, every line of a long blank
    # stretch rescanned the rest of it (15 s for 8,000 indented blank lines, the GIL
    # held), and a constant's type ran on to the next "=" anywhere below.
    r"^[^\S\n]*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|fn|struct|enum|interface"
    r"|type|protocol)\s+([A-Za-z_]\w{2,})"
    r"|^[^\S\n]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w{2,})\s*=\s*(?:async\s*)?"
    r"(?:\(|function)"
    r"|^(?:export\s+)?(?:const\s+)?([A-Z][A-Z0-9_]{2,})[^\S\n]*(?::[^=\n]+)?=",  # constants
    re.MULTILINE,
)
_WORD = re.compile(r"[a-z0-9]+")


def _split_ident(name: str) -> list[str]:
    """useEffect -> use effect; max_retries -> max retries; HubServer -> hub server."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name).replace("_", " ").replace("-", " ")
    return [w.lower() for w in spaced.split() if w]


@dataclass
class _Tables:
    """What mentions() looks names up in, made from one list of files and one of names."""

    files: list[str]  # the lists they were made from (refresh() makes new ones)
    idents: list[str]
    sizes: tuple[int, int]
    by_name: dict[str, list[str]] = field(default_factory=dict)  # a spoken name -> its files
    ident_by_words: dict[str, str] = field(default_factory=dict)  # "max retries" -> MAX_RETRIES
    ident_lower: dict[str, str] = field(default_factory=dict)  # max_retries -> MAX_RETRIES
    # For the fuzzy pass, made the first time one runs: the names it compares against, and
    # the first file with each (lowercased) stem.
    names: list[str] | None = None
    by_stem: dict[str, str] | None = None

    def fits(self, files: list[str], idents: list[str]) -> bool:
        return (
            self.files is files
            and self.idents is idents
            and self.sizes == (len(files), len(idents))
        )


class ProjectVocab:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.files: list[str] = []  # relative paths: the first MAX_FILES of all_files
        self.all_files: list[str] = []  # every one (up to ALL_FILES_MAX), for finding by name
        self.idents: list[str] = []  # most common first
        self._at = 0.0
        self._files_at = 0.0
        self._kept: _Tables | None = None

    def refresh(self, force: bool = False) -> None:
        if not force and self.files and time.monotonic() - self._at < REFRESH_SECONDS:
            return
        self._at = self._files_at = time.monotonic()
        self.all_files = self._list_files()
        self.files = self.all_files[:MAX_FILES]
        self.idents = self._scan_idents()

    def refresh_files(self, within: float) -> None:
        """The file list again when it was read more than `within` seconds ago."""
        if self.files and time.monotonic() - self._files_at < within:
            return
        self._files_at = time.monotonic()
        found = self._list_files()
        self.all_files, self.files = found, found[:MAX_FILES]

    def find(self, query: str, limit: int = 300) -> list[str]:
        """Files whose path has the words typed (any case) among all of them, the shortest
        first: the window's list carries only the first ones of a big project."""
        q = str(query or "").strip().lower()
        if not q:
            return []
        hits = [f for f in self.all_files if q in f.lower()]
        hits.sort(key=lambda f: (len(f), f))
        return hits[:limit]

    def _list_files(self) -> list[str]:
        try:
            # -z: names as they are. Without it git quotes one with a byte past ASCII in
            # octal ("caf\303\251.py"), which can't be opened or mentioned.
            out = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.root),
                    "-c",
                    "core.quotePath=false",
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
                capture_output=True,
                timeout=10,
            )
            if out.returncode == 0 and out.stdout.strip(b"\0"):
                names = out.stdout.decode("utf-8", errors="replace").split("\0")
                return [n for n in names if n][:ALL_FILES_MAX]
        except (OSError, subprocess.SubprocessError):
            pass
        found = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                found.append(str(Path(dirpath, name).relative_to(self.root)))
                if len(found) >= WALK_FILES_MAX:
                    return found
        return found

    def _scan_idents(self) -> list[str]:
        sources = [f for f in self.files if Path(f).suffix in SOURCE_EXTS]

        def mtime(rel: str) -> float:
            try:
                return (self.root / rel).stat().st_mtime
            except OSError:
                return 0.0

        counts: Counter[str] = Counter()
        for rel in sorted(sources, key=mtime, reverse=True)[:MAX_SCANNED]:
            try:
                path = self.root / rel
                if path.stat().st_size > 400_000:
                    continue
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            for m in _DEFS.finditer(text):
                name = m.group(1) or m.group(2) or m.group(3)
                if name and not name.startswith("__"):
                    counts[name] += 1
        return [name for name, _ in counts.most_common(4000)]

    # ── for the recognizer ──

    def hotwords(self, limit: int = 40) -> str:
        """Names worth biasing Whisper toward: recently touched files and top symbols."""

        def mtime(rel: str) -> float:
            try:
                return (self.root / rel).stat().st_mtime
            except OSError:
                return 0.0

        recent = sorted(
            (f for f in self.files if Path(f).suffix in SOURCE_EXTS), key=mtime, reverse=True
        )
        terms: list[str] = ["Eden"]
        for rel in recent[: limit // 2]:
            stem = Path(rel).stem
            if len(stem) > 2 and stem not in terms:
                terms.append(stem)
        for name in self.idents:
            if len(terms) >= limit:
                break
            if name not in terms:
                terms.append(name)
        return " ".join(terms)

    # ── from speech to code ──

    def mentions(self, text: str) -> list[str]:
        """Files and symbols the spoken text most likely refers to."""
        said = normalize(text)
        tokens = _WORD.findall(said.lower())
        grams = set(tokens)
        grams |= {" ".join(tokens[i : i + 2]) for i in range(len(tokens) - 1)}
        grams |= {" ".join(tokens[i : i + 3]) for i in range(len(tokens) - 2)}
        literal = set(re.findall(r"[\w./-]+\.[a-z]{1,5}\b|\b\w*_\w+\b|\b[a-z]+[A-Z]\w*\b", said))
        found: list[str] = []

        def add(item: str) -> None:
            if item not in found:
                found.append(item)

        tables = self._tables()
        by_name = tables.by_name
        for lit in literal:
            for rel in by_name.get(Path(lit).name.lower(), [])[:3]:
                add(rel)
        for gram in sorted(grams, key=len, reverse=True):
            if len(gram) < 4:
                continue
            # "voice code" also finds voicecode.py
            for rel in (by_name.get(gram, []) + by_name.get(gram.replace(" ", ""), []))[:2]:
                add(rel)
        ident_by_words, ident_lower = tables.ident_by_words, tables.ident_lower
        for lit in literal:
            if lit.lower() in ident_lower:  # max_buffer finds MAX_BUFFER
                add(ident_lower[lit.lower()])
        for token in tokens:  # one-word names: speakable, parse, Hub
            if len(token) >= 6 and token in ident_by_words:
                add(ident_by_words[token])
        for gram in grams:
            if " " in gram and gram in ident_by_words:
                add(ident_by_words[gram])
        if not found:  # one fuzzy pass for a misheard name
            names, by_stem = self._fuzzy(tables)
            for gram in grams:
                if len(gram) >= 6:
                    close = difflib.get_close_matches(gram, names, n=1, cutoff=0.88)
                    if close:
                        hit = close[0]
                        add(ident_by_words.get(hit) or by_stem.get(hit, hit))
        return found[:6]

    def _tables(self) -> _Tables:
        """mentions()'s lookups, made once for the files and names refresh() found: made
        again for each utterance, they took a tenth of a second and more in a big project."""
        kept = self._kept
        if kept is not None and kept.fits(self.files, self.idents):
            return kept
        tables = _Tables(self.files, self.idents, (len(self.files), len(self.idents)))
        by_name = tables.by_name
        for rel in self.files:
            stem = Path(rel).stem
            by_name.setdefault(Path(rel).name.lower(), []).append(rel)
            by_name.setdefault(" ".join(_split_ident(stem)), []).append(rel)
            by_name.setdefault(stem.lower().replace("_", "").replace("-", ""), []).append(rel)
        tables.ident_by_words = {" ".join(_split_ident(n)): n for n in self.idents}
        tables.ident_lower = {n.lower(): n for n in self.idents}
        self._kept = tables
        return tables

    @staticmethod
    def _fuzzy(tables: _Tables) -> tuple[list[str], dict[str, str]]:
        """The names a misheard one is compared with, and the first file with each stem."""
        if tables.names is None or tables.by_stem is None:
            by_stem: dict[str, str] = {}
            for rel in tables.files:
                by_stem.setdefault(Path(rel).stem.lower(), rel)
            tables.names = list(tables.ident_by_words) + [
                Path(f).stem.lower() for f in tables.files[:5000]
            ]
            tables.by_stem = by_stem
        return tables.names, tables.by_stem

    def hint(self, text: str) -> str:
        found = self.mentions(text)
        if not found:
            return ""
        return (
            "\n\n(Dictated by voice, so names may be misheard. Likely meant: "
            + ", ".join(found)
            + ".)"
        )


def normalize(text: str) -> str:
    """Spoken code back into code."""
    out = text

    def case(m: re.Match, joiner: str) -> str:
        parts = m.group(2).lower().split()
        if joiner == "camel":
            return parts[0] + "".join(p.capitalize() for p in parts[1:])
        if joiner == "pascal":
            return "".join(p.capitalize() for p in parts)
        return {"snake": "_", "kebab": "-", "constant": "_"}[joiner].join(
            p.upper() if joiner == "constant" else p for p in parts
        )

    for style in ("camel", "pascal", "snake", "kebab", "constant"):
        out = re.sub(
            rf"\b({style}[ -]?case)\s+([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){{0,4}}?)"
            rf"(?=$|[,.;:!?]|\s(?:in|on|to|from|and|with|for|the|of|at|into)\b)",
            lambda m, j=style: case(m, j),
            out,
            flags=re.IGNORECASE,
        )
    ext = "|".join(sorted(SPOKEN_EXTS, key=len, reverse=True))
    out = re.sub(
        rf"\b([\w-]+)\s+dot\s+({ext})\b",
        lambda m: f"{m.group(1)}.{SPOKEN_EXTS[m.group(2).lower()]}",
        out,
        flags=re.IGNORECASE,
    )
    out = re.sub(r"\s+underscore\s+", "_", out, flags=re.IGNORECASE)
    out = re.sub(r"(?<=\w)\s+slash\s+(?=\w)", "/", out, flags=re.IGNORECASE)
    return out


# The projects' vocabularies, the most lately used last: VOCABS_KEPT of them (each holds up
# to MAX_FILES names), so a long run that looks into many projects doesn't keep them all.
_vocabs: dict[Path, ProjectVocab] = {}
_vocabs_lock = threading.Lock()  # (asked for from more than one thread at once)
VOCABS_KEPT = 16


def vocab_for(root: Path, files_within: float | None = None) -> ProjectVocab:
    """The project's vocabulary; files_within: its file list no older than that (seconds)."""
    root = Path(root).resolve()
    with _vocabs_lock:
        vocab = _vocabs.pop(root, None) or ProjectVocab(root)
        _vocabs[root] = vocab
        while len(_vocabs) > VOCABS_KEPT:
            del _vocabs[next(iter(_vocabs))]
    vocab.refresh()
    if files_within is not None:
        vocab.refresh_files(files_within)
    return vocab
