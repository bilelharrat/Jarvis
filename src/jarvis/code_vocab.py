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
import time
from collections import Counter
from pathlib import Path

REFRESH_SECONDS = 600
MAX_FILES = 20000
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
    r"^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|fn|struct|enum|interface|type"
    r"|protocol)\s+([A-Za-z_]\w{2,})"
    r"|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w{2,})\s*=\s*(?:async\s*)?(?:\(|function)"
    r"|^(?:export\s+)?(?:const\s+)?([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=",  # module constants
    re.MULTILINE,
)
_WORD = re.compile(r"[a-z0-9]+")


def _split_ident(name: str) -> list[str]:
    """useEffect -> use effect; max_retries -> max retries; HubServer -> hub server."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name).replace("_", " ").replace("-", " ")
    return [w.lower() for w in spaced.split() if w]


class ProjectVocab:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.files: list[str] = []  # relative paths
        self.idents: list[str] = []  # most common first
        self._at = 0.0

    def refresh(self, force: bool = False) -> None:
        if not force and self.files and time.monotonic() - self._at < REFRESH_SECONDS:
            return
        self._at = time.monotonic()
        self.files = self._list_files()
        self.idents = self._scan_idents()

    def _list_files(self) -> list[str]:
        try:
            out = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.root),
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.splitlines()[:MAX_FILES]
        except (OSError, subprocess.SubprocessError):
            pass
        found = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                found.append(str(Path(dirpath, name).relative_to(self.root)))
                if len(found) >= MAX_FILES:
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
        terms: list[str] = ["Jarvis"]
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

        by_name: dict[str, list[str]] = {}
        for rel in self.files:
            stem = Path(rel).stem
            by_name.setdefault(Path(rel).name.lower(), []).append(rel)
            by_name.setdefault(" ".join(_split_ident(stem)), []).append(rel)
            by_name.setdefault(stem.lower().replace("_", "").replace("-", ""), []).append(rel)
        for lit in literal:
            for rel in by_name.get(Path(lit).name.lower(), [])[:3]:
                add(rel)
        for gram in sorted(grams, key=len, reverse=True):
            if len(gram) < 4:
                continue
            # "voice code" also finds voicecode.py
            for rel in (by_name.get(gram, []) + by_name.get(gram.replace(" ", ""), []))[:2]:
                add(rel)
        ident_by_words = {" ".join(_split_ident(n)): n for n in self.idents}
        ident_lower = {n.lower(): n for n in self.idents}
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
            names = list(ident_by_words) + [Path(f).stem.lower() for f in self.files[:5000]]
            for gram in grams:
                if len(gram) >= 6:
                    close = difflib.get_close_matches(gram, names, n=1, cutoff=0.88)
                    if close:
                        hit = close[0]
                        add(
                            ident_by_words.get(hit)
                            or next((f for f in self.files if Path(f).stem.lower() == hit), hit)
                        )
        return found[:6]

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


_vocabs: dict[Path, ProjectVocab] = {}


def vocab_for(root: Path) -> ProjectVocab:
    root = Path(root).resolve()
    vocab = _vocabs.get(root)
    if vocab is None:
        vocab = _vocabs[root] = ProjectVocab(root)
    vocab.refresh()
    return vocab
