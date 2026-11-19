"""A project's code, indexed so a search finds what was meant: a map of its symbols
(functions, classes, methods, types, with their file and line, signature, docstring, and each
file's imports) and its code in passages as vectors, built on this Mac and kept up to date a
file at a time. Eden Code's sessions ask it through the codebase_search and symbol_lookup
tools (features/code_index.py, code_index_mcp.py); the project search pane asks it "By
meaning" (web/features/code-search.js).

- Which files: git's own list in a git repository (its tracked files and its untracked ones,
  never those .gitignore leaves out), else a walk of the folder that reads the top-level
  .gitignore; never credentials (computer.is_sensitive), binaries (a NUL in the first
  SNIFF bytes), files over FILE_BYTES_MAX, minified ones (a line over LONG_LINE), lock files,
  or what a project doesn't own (node_modules, vendor, Pods, build output: VENDORED). At most
  FILES_MAX files and SCAN_SECONDS a pass; the rest waits for the next one, and says so.
- Symbols: Python's own parser (ast) for Python; for JavaScript, TypeScript, Swift, Go, Rust,
  Java, Kotlin, C#, C and C++, Ruby, PHP, Lua and shell, patterns a line at a time (every
  line cut to LINE_CHARS first, so no pattern ever looks past its own line), a method's class
  told by its indentation, its doc from the comment just above it. tree-sitter would read
  those languages exactly; it isn't in the app (an owner decision: it's a new native
  dependency), so the patterns are what there is.
- Passages: one from each symbol to the next (a long one in CHUNK_LINES pieces), the lines
  before the first symbol (imports, a module's docstring) as their own, a file without
  symbols in CHUNK_LINES pieces. What's embedded is the passage with its path, symbol,
  signature and doc on top, keyed by a hash of that text and of the embedder, so a passage
  is embedded once however often the project changes around it.
- Vectors: the second brain's own embedder (embeddings.py: Apple's on-device models on a Mac,
  the small ONNX model on a PC) when the owner has turned Search by meaning on and it's ready
  here (nothing is ever downloaded or built for this); otherwise HashEmbedder, a local
  hashed bag of the identifiers' parts (parseConfig, parse_config and "parse the config" come
  out alike), which needs nothing. At most EMBED_PER_UPDATE new passages and EMBED_SECONDS an
  update, files changed most recently first; the rest wait for the next update.
- Up to date: refresh() looks at each file's size and modification time and reads only those
  that changed (or only the files it's told changed); a search refreshes first when the last
  look is older than REFRESH_SECONDS.
- A search is hybrid: by meaning (cosine similarity with the query's vector), by words (git
  grep for the query's words, via code_search, so a file changed a second ago is found), and
  by symbol name; fused by reciprocal rank, each result saying why it's there.

The index lives in the app's data folder, one folder a project (index.json, vectors.npz),
never in the project itself. It all runs on this Mac: no Claude calls, nothing sent anywhere.
"""

from __future__ import annotations

import ast
import contextlib
import fnmatch
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import code_changes, code_search, embeddings
from .code_vocab import SKIP_DIRS
from .computer import is_sensitive

log = logging.getLogger("jarvis")

VERSION = 1
INDEX_NAME = "index.json"
VECTORS_NAME = "vectors.npz"
ROOT_NAME = "root.txt"  # the project's path alone, for a tidy that needn't read index.json
DIM = embeddings.DIM  # every embedder's vectors are this long (winembed pads to it)
FILES_MAX = 20_000  # files an index holds, at most
FILE_BYTES_MAX = 512_000  # bigger files are left out (generated, data, bundles)
LONG_LINE = 3000  # a line longer than this: a minified or generated file, left out
SNIFF = 8000  # bytes looked at for a NUL (a binary file)
STALE_DAYS = 30.0  # an index whose project is gone is kept this long (an unplugged drive)
SCAN_SECONDS = 30.0  # one pass reading changed files, at most
SYMBOLS_PER_FILE = 2000
IMPORTS_PER_FILE = 100
LINE_CHARS = 500  # of a line, what a pattern looks at
CHUNK_LINES = 60  # a passage, at most
EMBED_CHARS = 1500  # of a passage with its heading: what the models read
EMBED_PER_UPDATE = 1500  # new passages a model embeds in one update (Apple's: ~50 ms each)
EMBED_SECONDS = 60.0  # ...within this long (HashEmbedder: everything, ~2,000 a second)
VECTORS_MAX = 60_000  # vectors a project keeps (about 60 MB as float16, on disk and in memory)
BATCH = 16
REFRESH_SECONDS = 10.0  # a search looks for changed files when the last look is older
QUERY_SECONDS = 4.0  # the query's vector: past this, the search goes on without meaning
QUERY_MAX = 500
RESULTS_MAX = 30
SNIPPET_LINES = 12
SNIPPET_CHARS = 200  # of a line in a snippet
LOOKUP_MAX = 30
RRF_K = 60
MEANING_TOP = 60  # passages by meaning brought into the fusion
WORDS_TOP = 60
SYMBOLS_TOP = 60
WORD_SECONDS = 5.0  # the git grep inside a search
HASH_EMBEDDER = "hash-v1"

# Folders a project doesn't own, wherever they are (beside code_vocab's SKIP_DIRS).
VENDORED = SKIP_DIRS | {
    "vendor", "vendors", "third_party", "third-party", "thirdparty", "external", "extern",
    "Pods", "Carthage", "DerivedData", ".build", "target", "out", "coverage", "site-packages",
    "bower_components", "jspm_packages", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    ".gradle", ".idea", ".svn", ".hg", "__snapshots__", ".turbo", ".parcel-cache", ".nuxt",
    ".svelte-kit", ".expo", "elm-stuff", ".dart_tool", "Godeps", "_build", "deps",
}  # fmt: skip
SKIP_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
    "Pipfile.lock", "uv.lock", "composer.lock", "Gemfile.lock", "go.sum", "Podfile.lock",
    "bun.lockb", "flake.lock", "Package.resolved",
}  # fmt: skip
SKIP_SUFFIXES = (".min.js", ".min.css", ".map", ".bundle.js", ".pb.go", "_pb2.py", ".d.ts.map")

# The languages read, by extension: Python by its parser, the rest by patterns.
LANGS = {
    "py": "python", "pyi": "python",
    "js": "js", "jsx": "js", "mjs": "js", "cjs": "js", "ts": "js", "tsx": "js", "mts": "js",
    "cts": "js", "vue": "js", "svelte": "js",
    "swift": "swift", "go": "go", "rs": "rust",
    "java": "java", "kt": "java", "kts": "java", "scala": "java", "cs": "java", "groovy": "java",
    "dart": "java",
    "c": "c", "h": "c", "cc": "c", "cpp": "c", "cxx": "c", "hpp": "c", "hh": "c", "m": "c",
    "mm": "c",
    "rb": "ruby", "rake": "ruby", "php": "php", "lua": "lua",
    "sh": "shell", "bash": "shell", "zsh": "shell",
    "md": "markdown", "mdx": "markdown", "rst": "text", "txt": "text",
    "sql": "text", "css": "text", "scss": "text", "less": "text", "html": "text",
    "toml": "text", "yaml": "text", "yml": "text", "graphql": "text", "proto": "text",
    "tf": "text", "gradle": "text", "cmake": "text", "ex": "text", "exs": "text",
    "erl": "text", "hs": "text", "ml": "text", "clj": "text", "r": "text", "jl": "text",
    "zig": "text", "nim": "text",
}  # fmt: skip
NAMED_FILES = {"Makefile", "Dockerfile", "Rakefile", "Gemfile", "Justfile", "Procfile"}


# ── which files ──


def language_of(rel: str) -> str:
    name = rel.rsplit("/", 1)[-1]
    if name in NAMED_FILES:
        return "text"
    _, dot, ext = name.rpartition(".")
    return LANGS.get(ext.lower(), "") if dot else ""


def indexable(rel: str) -> bool:
    """A path worth indexing by its name alone: a language read here, nothing vendored,
    generated or locked, nothing hidden but the folders a project keeps its config in."""
    parts = rel.split("/")
    name = parts[-1]
    if not language_of(rel) or name in SKIP_NAMES or name.lower().endswith(SKIP_SUFFIXES):
        return False
    return not any(p in VENDORED for p in parts[:-1])


def is_git(root: Path) -> bool:
    return code_search.is_git(root)


def list_files(root: Path, stop: Callable[[], bool] = lambda: False) -> tuple[list[str], bool]:
    """The project's files to index (paths relative to root, sorted), and whether the list
    stopped short: at FILES_MAX, or (a folder that isn't git, walked) when stop() said the
    time was up. A list stopped short is never the whole project, so nothing missing from
    it may be taken as deleted (CodeIndex.refresh)."""
    root = Path(root)
    found: list[str] = []
    if is_git(root):
        try:
            out = subprocess.run(  # noqa: S603 - git, on the owner's own project
                ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others",
                 "--exclude-standard"],
                capture_output=True,
                timeout=30,
                check=False,
                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", **code_changes.pinned_env(root)[0]},
            )  # fmt: skip
        except (OSError, subprocess.SubprocessError):
            out = None
        if out is not None and out.returncode == 0:
            names = sorted({n.decode("utf-8", "replace") for n in out.stdout.split(b"\0") if n})
            for rel in names:
                if indexable(rel):
                    found.append(rel)
                    if len(found) >= FILES_MAX:
                        return found, True
            return found, False
    ignored = _gitignore(root)
    for dirpath, dirnames, filenames in os.walk(root):
        if stop():  # out of time: what's listed is part of the folder, and says so
            return sorted(found), True
        here = Path(dirpath).relative_to(root).as_posix()
        here = "" if here == "." else f"{here}/"
        dirnames[:] = sorted(
            d
            for d in dirnames
            if d not in VENDORED and not d.startswith(".") and not ignored(f"{here}{d}/")
        )
        for name in sorted(filenames):
            rel = f"{here}{name}"
            if indexable(rel) and not ignored(rel):
                found.append(rel)
                if len(found) >= FILES_MAX:
                    return found, True
    return sorted(found), False


def _gitignore(root: Path) -> Callable[[str], bool]:
    """The top-level .gitignore of a folder that isn't a git repository, read simply: a
    pattern with no slash matches a name anywhere, one with a slash a path from the top, a
    trailing slash only folders; "!" lines bring a path back."""
    raw = code_search.read_regular(root / ".gitignore", 1_000_000)  # (never a pipe)
    if raw is None:
        return lambda _rel: False
    lines = raw.decode("utf-8", errors="replace").splitlines()
    rules: list[tuple[bool, bool, bool, str]] = []  # (negated, folders only, anchored, glob)
    for raw in lines[:500]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        line = line.lstrip("!")
        folder = line.endswith("/")
        line = line.strip("/")
        if line:
            rules.append((negated, folder, "/" in line, line))

    def ignored(rel: str) -> bool:
        is_dir = rel.endswith("/")
        rel = rel.rstrip("/")
        out = False
        for negated, folder, anchored, glob in rules:
            if folder and not is_dir:
                continue
            hit = (
                fnmatch.fnmatch(rel, glob) or fnmatch.fnmatch(rel, f"{glob}/*")
                if anchored
                else fnmatch.fnmatch(rel.rsplit("/", 1)[-1], glob)
            )
            if hit:
                out = not negated
        return out

    return ignored


def read_text(path: Path, root: Path | None = None) -> str | None:
    """A file's text, or None for one left out: too big, binary, minified, unreadable, a
    link, not a regular file (a named pipe used to hang the read for good), or, with root
    (the project, resolved), anywhere but really inside it, through a folder on the way
    that became a link (code_search.read_regular)."""
    raw = code_search.read_regular(path, FILE_BYTES_MAX, root)
    if raw is None:
        return None
    if b"\0" in raw[:SNIFF]:
        return None
    text = raw.decode("utf-8", errors="replace")
    if any(len(line) > LONG_LINE for line in text.split("\n", 400)[:400]):
        return None
    return text


# ── symbols ──


@dataclass
class Symbol:
    name: str
    kind: str  # function, method, class, struct, enum, interface, type, heading…
    line: int
    end: int = 0  # its last line, when the language says (Python); else 0
    signature: str = ""
    doc: str = ""
    parent: str = ""  # its class, for a method

    def qualified(self) -> str:
        return f"{self.parent}.{self.name}" if self.parent else self.name

    def to_json(self) -> list[Any]:
        return [self.name, self.kind, self.line, self.end, self.signature, self.doc, self.parent]

    @classmethod
    def from_json(cls, raw: Any) -> Symbol | None:
        if not isinstance(raw, list) or len(raw) != 7:
            return None
        name, kind, line, end, signature, doc, parent = raw
        if not (isinstance(name, str) and isinstance(line, int) and isinstance(end, int)):
            return None
        return cls(name, str(kind), line, end, str(signature), str(doc), str(parent))


def _first_paragraph(text: str, limit: int = 300) -> str:
    text = (text or "").strip().split("\n\n", 1)[0]
    return " ".join(text.split())[:limit]


def python_symbols(text: str) -> tuple[list[Symbol], list[str]] | None:
    """Python's functions, classes and methods (with their nested classes), and its imports,
    by Python's own parser; None for a file it can't parse (the patterns read it then)."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None
    symbols: list[Symbol] = []
    imports: list[str] = []

    def signature(node: Any) -> str:
        try:
            args = ast.unparse(node.args)
            ret = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
        except Exception:
            args, ret = "…", ""
        prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        return f"{prefix} {node.name}({args}){ret}"[:300]

    def visit(body: list[Any], parent: str, depth: int) -> None:
        for node in body:
            if len(symbols) >= SYMBOLS_PER_FILE:
                return
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                symbols.append(
                    Symbol(
                        node.name,
                        "method" if parent else "function",
                        node.lineno,
                        node.end_lineno or node.lineno,
                        signature(node),
                        _first_paragraph(ast.get_docstring(node) or ""),
                        parent,
                    )
                )
            elif isinstance(node, ast.ClassDef):
                try:
                    bases = ", ".join(ast.unparse(b) for b in node.bases)
                except Exception:
                    bases = ""
                symbols.append(
                    Symbol(
                        node.name,
                        "class",
                        node.lineno,
                        node.end_lineno or node.lineno,
                        f"class {node.name}({bases})" if bases else f"class {node.name}",
                        _first_paragraph(ast.get_docstring(node) or ""),
                        parent,
                    )
                )
                if depth < 3:
                    visit(node.body, node.name, depth + 1)
            elif isinstance(node, ast.Import) and not parent:
                imports.extend(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and not parent:
                imports.append("." * (node.level or 0) + (node.module or ""))

    visit(tree.body, "", 0)
    symbols.sort(key=lambda s: s.line)
    return symbols, list(dict.fromkeys(i for i in imports if i))[:IMPORTS_PER_FILE]


_ID = r"[A-Za-z_$][\w$]*"
_MODS = r"(?:(?:public|private|protected|internal|static|final|abstract|sealed|override|virtual|async|open|fileprivate|mutating|nonisolated|inline|export|default|declare|readonly|synchronized|suspend|data|unsafe|extern|partial|const)[ \t]+)*"
# (kind, pattern): group "name" the name; a pattern only ever sees one line.
PATTERNS: dict[str, list[tuple[str, re.Pattern[str]]]] = {
    "js": [
        ("function", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*(?P<name>{_ID})[ \t]*\(")),
        ("class", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?class[ \t]+(?P<name>{_ID})")),
        ("function", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+(?P<name>{_ID})[ \t]*(?::[^=]{{0,120}})?=[ \t]*(?:async[ \t]+)?(?:function\b|\([^()]{{0,200}}\)[ \t]*(?::[^=]{{0,80}})?=>|{_ID}[ \t]*=>)")),
        ("interface", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?interface[ \t]+(?P<name>{_ID})")),
        ("type", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?type[ \t]+(?P<name>{_ID})[ \t]*(?:<[^>]{{0,100}}>)?[ \t]*=")),
        ("enum", re.compile(rf"^[ \t]*(?:export[ \t]+)?(?:const[ \t]+)?enum[ \t]+(?P<name>{_ID})")),
        ("method", re.compile(rf"^[ \t]+(?:(?:public|private|protected|static|async|get|set|readonly|override)[ \t]+)*\*?(?P<name>{_ID})[ \t]*\([^()]{{0,200}}\)[ \t]*(?::[^{{]{{0,120}})?\{{")),
    ],
    "swift": [
        ("function", re.compile(rf"^[ \t]*(?:@\w+[ \t]+)*{_MODS}(?:class[ \t]+|static[ \t]+)?func[ \t]+(?P<name>[^\s(<]+)")),
        ("init", re.compile(rf"^[ \t]*(?:@\w+[ \t]+)*{_MODS}(?:convenience[ \t]+|required[ \t]+)*(?P<name>init)[?!]?[ \t]*\(")),
        ("class", re.compile(rf"^[ \t]*(?:@\w+[ \t]+)*{_MODS}(?:final[ \t]+)?(?P<kind>class|struct|enum|protocol|actor|extension)[ \t]+(?P<name>[A-Za-z_][\w.]*)")),
    ],
    "go": [
        ("function", re.compile(r"^func[ \t]+(?:\((?P<recv>[^()]{0,120})\)[ \t]*)?(?P<name>[A-Za-z_]\w*)[ \t]*[(\[]")),
        ("type", re.compile(r"^type[ \t]+(?P<name>[A-Za-z_]\w*)[ \t]+(?P<kind>struct|interface)?")),
    ],
    "rust": [
        ("function", re.compile(r"^[ \t]*(?:pub(?:\([^()]{0,40}\))?[ \t]+)?(?:(?:async|unsafe|const|extern(?:[ \t]+\"\w+\")?)[ \t]+)*fn[ \t]+(?P<name>[A-Za-z_]\w*)")),
        ("class", re.compile(r"^[ \t]*(?:pub(?:\([^()]{0,40}\))?[ \t]+)?(?P<kind>struct|enum|trait|mod|union)[ \t]+(?P<name>[A-Za-z_]\w*)")),
        ("impl", re.compile(r"^[ \t]*(?:unsafe[ \t]+)?impl(?:<[^>]{0,80}>)?[ \t]+(?:[\w:<>, ]{0,80}[ \t]+for[ \t]+)?(?P<name>[A-Za-z_][\w:]*)")),
    ],
    "java": [
        ("class", re.compile(rf"^[ \t]*(?:@\w+[ \t]+)*{_MODS}(?P<kind>class|interface|enum|record|object|struct|trait)[ \t]+(?P<name>[A-Za-z_]\w*)")),
        ("function", re.compile(rf"^[ \t]*{_MODS}fun[ \t]+(?:<[^>]{{0,60}}>[ \t]*)?(?:[\w.]+\.)?(?P<name>[A-Za-z_]\w*)[ \t]*\(")),
        ("function", re.compile(r"^[ \t]*def[ \t]+(?P<name>[A-Za-z_]\w*)")),
        ("method", re.compile(r"^[ \t]+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|async|virtual|sealed|new)[ \t]+)+[\w<>\[\],.?]{1,80}[ \t]+(?P<name>[A-Za-z_]\w*)[ \t]*\(")),
    ],
    "c": [
        ("class", re.compile(r"^(?:typedef[ \t]+)?(?:template[ \t]*<[^>]{0,80}>[ \t]*)?(?P<kind>struct|class|enum|union|namespace)[ \t]+(?P<name>[A-Za-z_]\w*)[^;]*$")),
        ("class", re.compile(r"^@(?P<kind>interface|implementation|protocol)[ \t]+(?P<name>[A-Za-z_]\w*)")),
        ("method", re.compile(r"^[-+][ \t]*\([^()]{0,60}\)[ \t]*(?P<name>[A-Za-z_]\w*)")),
        ("function", re.compile(r"^(?!(?:if|else|while|for|switch|return|do|case|typedef|using)\b)[A-Za-z_][\w*&:<>, \t]{0,120}?[ \t*&](?P<name>[A-Za-z_][\w:~]*)[ \t]*\([^;]{0,300}$")),
    ],
    "ruby": [
        ("method", re.compile(r"^[ \t]*def[ \t]+(?:self\.)?(?P<name>[A-Za-z_]\w*[?!=]?)")),
        ("class", re.compile(r"^[ \t]*(?P<kind>class|module)[ \t]+(?P<name>[A-Z]\w*(?:::\w+)*)")),
    ],
    "php": [
        ("function", re.compile(rf"^[ \t]*{_MODS}function[ \t]+&?(?P<name>[A-Za-z_]\w*)[ \t]*\(")),
        ("class", re.compile(rf"^[ \t]*{_MODS}(?P<kind>class|interface|trait|enum)[ \t]+(?P<name>[A-Za-z_]\w*)")),
    ],
    "lua": [
        ("function", re.compile(r"^[ \t]*(?:local[ \t]+)?function[ \t]+(?P<name>[\w.:]+)[ \t]*\(")),
    ],
    "shell": [
        ("function", re.compile(r"^[ \t]*(?:function[ \t]+)?(?P<name>[A-Za-z_][\w-]*)[ \t]*\(\)[ \t]*\{?")),
    ],
    "markdown": [
        ("heading", re.compile(r"^(?P<hashes>#{1,4})[ \t]+(?P<name>\S.{0,150})$")),
    ],
    "python": [  # a file Python can't parse (a template, an old Python 2 one)
        ("function", re.compile(r"^[ \t]*(?:async[ \t]+)?def[ \t]+(?P<name>[A-Za-z_]\w*)[ \t]*\(")),
        ("class", re.compile(r"^[ \t]*class[ \t]+(?P<name>[A-Za-z_]\w*)")),
    ],
}  # fmt: skip
KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try",
    "with", "new", "typeof", "await", "sizeof", "super", "this", "constructor_", "elif",
}  # fmt: skip
CLASSLIKE = {"class", "struct", "enum", "interface", "protocol", "actor", "extension",
             "trait", "impl", "record", "object", "module", "implementation", "namespace"}  # fmt: skip
# How a comment line starts, by language: its words become the doc of the symbol below it.
_HASH_COMMENT = ("#",)
_SLASH_COMMENT = ("//", "/*", "* ", "*/", "**")
COMMENTS = {"python": _HASH_COMMENT, "ruby": _HASH_COMMENT, "shell": _HASH_COMMENT,
            "lua": ("--",), "php": (*_SLASH_COMMENT, "#")}  # fmt: skip
_COMMENT_MARKS = re.compile(r"^(?:/\*+|\*+/?|//+!?|#+|--+)[ \t]?|[ \t]*\*+/$")
_IMPORT_PATTERNS = [
    re.compile(r"""^[ \t]*import[ \t]+(?:[^'"]{0,200}?[ \t]from[ \t]+)?['"](?P<m>[^'"]{1,200})['"]"""),
    re.compile(r"""\brequire\([ \t]*['"](?P<m>[^'"]{1,200})['"][ \t]*\)"""),
    re.compile(r"""^[ \t]*(?:import|use|using|from|@import|#import|#include|require_relative)[ \t]+[<"']?(?P<m>[\w.:/@-]{1,200})"""),
    re.compile(r"""^[ \t]+"(?P<m>[\w./-]{1,200})"[ \t]*$"""),  # (a Go import block's lines)
]  # fmt: skip


def pattern_symbols(text: str, lang: str) -> tuple[list[Symbol], list[str]]:
    """Symbols and imports by patterns, a line at a time."""
    patterns = PATTERNS.get(lang) or []
    symbols: list[Symbol] = []
    imports: list[str] = []
    classes: list[tuple[int, str]] = []  # (indent, name): the classes a line is inside
    comment: list[str] = []
    in_go_imports = False
    for n, full in enumerate(text.split("\n"), 1):
        line = full[:LINE_CHARS].rstrip("\r")
        stripped = line.strip()
        if not stripped:
            comment = []
            continue
        indent = len(line) - len(line.lstrip(" \t"))
        if (
            lang != "markdown"
            and (stripped.startswith(COMMENTS.get(lang, _SLASH_COMMENT)) or stripped == "*")
            and not stripped.startswith(("#!", "#[", "#{"))
        ):
            words = _COMMENT_MARKS.sub("", stripped).strip()
            if words:
                comment = [*comment[-5:], words]
            continue
        if len(imports) < IMPORTS_PER_FILE and lang != "markdown":
            if lang == "go" and stripped.startswith("import ("):
                in_go_imports = True
            elif in_go_imports and stripped.startswith(")"):
                in_go_imports = False
            for p in _IMPORT_PATTERNS[: 4 if in_go_imports else 3]:
                if (m := p.search(line)) is not None:
                    imports.append(m.group("m"))
                    break
        while classes and indent <= classes[-1][0] and lang not in ("go", "c", "markdown"):
            classes.pop()
        for kind, pattern in patterns:
            m = pattern.search(line)
            if m is None:
                continue
            name = m.group("name").strip()
            if not name or name in KEYWORDS:
                continue
            groups = m.groupdict()
            found_kind = groups.get("kind") or kind
            if lang == "markdown":
                found_kind = f"heading {len(groups.get('hashes') or '#')}"
            parent = ""
            if lang == "go" and groups.get("recv"):
                found_kind = "method"
                parent = groups["recv"].split()[-1].lstrip("*").split("[")[0]
            elif classes and found_kind not in CLASSLIKE:
                parent = classes[-1][1]
                if found_kind == "function" and lang not in ("lua", "shell"):
                    found_kind = "method"
            elif found_kind == "method" and not classes and lang not in ("c", "ruby"):
                break  # a call, not a method: methods are only found inside a class
            symbols.append(
                Symbol(
                    name[:120],
                    found_kind,
                    n,
                    0,
                    stripped[:300],
                    " ".join(comment)[:300],
                    parent,
                )
            )
            if found_kind in CLASSLIKE and lang not in ("go", "markdown"):
                classes.append((indent, name.split(".")[-1].split("::")[-1]))
            break
        comment = []
        if len(symbols) >= SYMBOLS_PER_FILE:
            break
    return symbols, list(dict.fromkeys(imports))[:IMPORTS_PER_FILE]


def extract(text: str, lang: str) -> tuple[list[Symbol], list[str]]:
    """A file's symbols (in line order) and imports."""
    if lang == "python":
        found = python_symbols(text)
        if found is not None:
            return found
    if lang == "text":
        return [], []
    return pattern_symbols(text, lang)


# ── passages ──


@dataclass
class Chunk:
    path: str
    start: int  # first line (1-based)
    end: int  # last line
    symbol: int  # its symbol's number in the file's list, or -1
    key: bytes = b""


def chunks_for(path: str, lines: list[str], symbols: list[Symbol]) -> list[Chunk]:
    """The file in passages: one from each symbol to the next (CHUNK_LINES at most a piece),
    what comes before the first as its own."""
    total = len(lines)
    if not total:
        return []
    starts: list[tuple[int, int]] = []  # (line, symbol)
    for i, s in enumerate(symbols):
        if 1 <= s.line <= total and (not starts or s.line > starts[-1][0]):
            starts.append((s.line, i))
    if not starts or starts[0][0] > 1:
        starts.insert(0, (1, -1))
    out: list[Chunk] = []
    for j, (line, sym) in enumerate(starts):
        last = (starts[j + 1][0] - 1) if j + 1 < len(starts) else total
        while line <= last:
            end = min(last, line + CHUNK_LINES - 1)
            if any(lines[k].strip() for k in range(line - 1, end)):
                out.append(Chunk(path, line, end, sym))
            line = end + 1
    return out


def chunk_text(chunk: Chunk, lines: list[str], symbols: list[Symbol]) -> str:
    """What's embedded for a passage: its path, symbol, signature and doc, then its lines."""
    head = [chunk.path]
    if chunk.symbol >= 0:
        s = symbols[chunk.symbol]
        head.append(f"{s.kind} {s.qualified()}: {s.signature}")
        if s.doc:
            head.append(s.doc)
    body = "\n".join(line[: SNIPPET_CHARS * 2] for line in lines[chunk.start - 1 : chunk.end])
    return ("\n".join(head) + "\n" + body)[:EMBED_CHARS]


def chunk_key(embedder: str, text: str) -> bytes:
    return hashlib.blake2b(
        f"{embedder}\0{text}".encode("utf-8", "replace"), digest_size=16
    ).digest()


# ── the local embedder ──

_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")
STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "from",
    "is", "are", "was", "be", "it", "its", "this", "that", "these", "those", "as", "into",
    "where", "what", "which", "who", "how", "why", "when", "do", "does", "did", "we", "our",
    "i", "me", "my", "you", "your", "can", "should", "would", "there", "here", "all", "any",
    "code", "function", "functions", "file", "files", "find", "show", "get", "gets", "part",
    "thing", "things", "happen", "happens", "handle", "handles", "handled", "self", "def",
    "return", "none", "true", "false", "null", "const", "let", "var", "if", "else", "not",
}  # fmt: skip


def stem(word: str) -> str:
    """A word's plain root, roughly: uploads, uploading, uploaded -> upload."""
    w = word.lower()
    for suffix in ("ingly", "ing", "ers", "ies", "ed", "es", "er", "s"):
        if len(w) > len(suffix) + 2 and w.endswith(suffix):
            w = w[: -len(suffix)]
            if suffix == "ies":
                w += "y"
            break
    return w


def parts_of(text: str) -> list[str]:
    """The words in text, identifiers split into their parts (parseConfig, parse_config:
    parse, config), each as its stem; stopwords out."""
    out: list[str] = []
    for word in _WORD.findall(text):
        pieces = [p for chunk in word.split("_") for p in _PART.findall(chunk)] or [word]
        for p in pieces:
            s = stem(p)
            if len(s) >= 2 and s not in STOPWORDS:
                out.append(s)
    return out


class HashEmbedder:
    """Vectors with no model: each part of each identifier and word, and its letter
    trigrams more faintly, hashed into DIM numbers (signed, by log count), unit length.
    Not meaning in the model's sense, but "retry the upload" lands near retryUpload and
    upload_retries, which words alone miss. Deterministic, instant, nothing to fetch."""

    name = HASH_EMBEDDER

    def embed(self, texts: list[str], timeout: float | None = None) -> list[Any]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> tuple[str, np.ndarray] | str:
        counts: dict[int, float] = {}
        for part in parts_of(text[: EMBED_CHARS * 2]):
            for feature, weight in [(part, 1.0)] + [
                (f"#{part[i : i + 3]}", 0.25) for i in range(max(0, len(part) - 2))
            ]:
                h = int.from_bytes(
                    hashlib.blake2b(feature.encode(), digest_size=8).digest(), "little"
                )
                slot = h % DIM
                counts[slot] = counts.get(slot, 0.0) + (weight if (h >> 40) & 1 else -weight)
        if not counts:
            return "empty"
        vec = np.zeros(DIM, dtype=np.float32)
        for slot, value in counts.items():
            vec[slot] = math.copysign(math.log1p(abs(value)), value)
        norm = float(np.linalg.norm(vec))
        return (HASH_EMBEDDER, vec / norm) if norm > 0 else "empty"

    def close(self) -> None:
        pass


# ── the index ──


@dataclass
class FileEntry:
    mtime: int
    size: int
    lang: str
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    chunks: list[Chunk] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "m": self.mtime,
            "s": self.size,
            "l": self.lang,
            "sy": [s.to_json() for s in self.symbols],
            "im": self.imports,
            "ch": [[c.start, c.end, c.symbol, c.key.hex()] for c in self.chunks],
        }

    @classmethod
    def from_json(cls, path: str, raw: Any) -> FileEntry | None:
        try:
            symbols = [s for s in (Symbol.from_json(r) for r in raw["sy"]) if s is not None]
            chunks = [
                Chunk(path, int(a), int(b), int(c), bytes.fromhex(str(k)))
                for a, b, c, k in raw["ch"]
            ]
            imports = [str(i) for i in raw.get("im") or []]
            return cls(int(raw["m"]), int(raw["s"]), str(raw["l"]), symbols, imports, chunks)
        except (KeyError, TypeError, ValueError):
            return None


def _pending(files: dict[str, FileEntry], vectors: dict[bytes, Any]) -> int:
    """Passages without a vector yet."""
    return len({c.key for e in files.values() for c in e.chunks} - vectors.keys())


def root_of(folder: Path) -> str:
    """The project an index folder is for ("" when it can't be told): root.txt, else (an
    index from before it) index.json's "root"."""
    try:
        return (Path(folder) / ROOT_NAME).read_text(encoding="utf-8").strip()
    except OSError:
        pass
    try:
        data = json.loads((Path(folder) / INDEX_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(data.get("root") or "") if isinstance(data, dict) else ""


def tidy(
    base: Path,
    *,
    in_use: Callable[[str], bool] = lambda _root: False,
    gone_now: Callable[[str], bool] = lambda _root: False,
    days: float = STALE_DAYS,
    now: Callable[[], float] = time.time,
) -> list[str]:
    """Remove the index folders under base whose project is no longer there: at once when
    gone_now(root) says it's one that went for good (an isolated copy landed or discarded:
    each had an index of its own, and none was ever removed), else once nothing has
    touched the index for `days` (a project on a drive that isn't plugged in keeps its
    index a while). Never one in_use(root), nor one whose project can't be told. Returns
    the projects whose indexes went."""
    removed: list[str] = []
    try:
        folders = [f for f in Path(base).iterdir() if f.is_dir() and not f.is_symlink()]
    except OSError:
        return removed
    for folder in folders:
        root = root_of(folder)
        if not root or in_use(root) or os.path.lexists(root):
            continue
        if not gone_now(root):
            try:
                touched = max(
                    (folder / n).stat().st_mtime
                    for n in (INDEX_NAME, ROOT_NAME, VECTORS_NAME)
                    if (folder / n).exists()
                )
            except (OSError, ValueError):  # (nothing in it to date it by)
                touched = 0.0
            if now() - touched < days * 86400:
                continue
        try:
            shutil.rmtree(folder)
        except OSError as exc:
            log.info("code index: couldn't remove %s (%s)", folder.name, exc)
            continue
        removed.append(root)
    return removed


def index_folder(base: Path, root: Path) -> Path:
    """Where a project's index lives under the app's folder for them: by a hash of its path,
    with its name for whoever looks."""
    resolved = str(Path(root).resolve())
    digest = hashlib.sha256(resolved.encode()).hexdigest()[:16]
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(resolved).name)[:40] or "project"
    return Path(base) / f"{name}-{digest}"


class CodeIndex:
    """One project's index: its files' symbols and passages, and the passages' vectors.

    An update (refresh) works on copies and puts them in place at the end, under `lock`
    for an instant: a search never waits behind an update that's embedding for a minute,
    and what it reads (self.files, the vectors) is never changed under it, only replaced."""

    def __init__(self, root: Path, folder: Path) -> None:
        self.root = Path(root).resolve()
        self.folder = Path(folder)
        self.files: dict[str, FileEntry] = {}
        self.embedder_name = ""
        self.truncated = False
        self.looked_at = 0.0  # time.monotonic() of the last refresh
        self.updated = ""  # when it last changed, ISO
        self.pending = 0  # passages waiting for a vector
        self.error = ""
        self.lock = threading.Lock()  # (an instant: the swap, the caches)
        self.updating = threading.Lock()  # (one update at a time)
        self._vectors: dict[bytes, tuple[str, np.ndarray]] = {}
        self._matrix: dict[str, tuple[np.ndarray, list[bytes]]] | None = None  # space -> rows
        self._chunks_by_key: dict[bytes, list[Chunk]] | None = None
        self._symbols: tuple[dict[str, FileEntry], list[Any]] | None = None
        self.loaded = False
        self._seen: tuple[Any, Any] = (None, None)  # _stamp() as last read or written

    # ── on disk ──

    def load(self) -> None:
        """What's on disk, read once, and again whenever it changes there: the index.json
        and vectors.npz another process wrote (the stdio server an ACP agent starts reads
        what the app's own update saves). An index not saved yet is looked for again on the
        next load: marked loaded with nothing there, the stdio server answered an empty
        index for the whole session, though the app saved one a moment later."""
        with self.lock:
            stamp = self._stamp()
            if stamp[0] is None or (self.loaded and stamp == self._seen):
                return
            self.loaded, self._seen = True, stamp
            try:
                data = json.loads((self.folder / INDEX_NAME).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return
            if not isinstance(data, dict) or data.get("version") != VERSION:
                return
            if data.get("root") != str(self.root):
                return
            raw_files = data.get("files") if isinstance(data.get("files"), dict) else {}
            files: dict[str, FileEntry] = {}
            for path, raw in raw_files.items():
                entry = FileEntry.from_json(path, raw)
                if entry is not None:
                    files[path] = entry
            self.files = files
            self.embedder_name = str(data.get("embedder") or "")
            self.truncated = bool(data.get("truncated"))
            self.updated = str(data.get("updated") or "")
            vectors = embeddings.VectorFile.read(self.folder / VECTORS_NAME)
            if vectors is not None and vectors.built_at == self.embedder_name:
                self._vectors = vectors.cached()
            self.pending = _pending(self.files, self._vectors)
            self._matrix = self._chunks_by_key = self._symbols = None  # (built from these)

    def _stamp(self) -> tuple[tuple[int, int] | None, tuple[int, int] | None]:
        """index.json's and vectors.npz's (mtime, size) as they are now (None: not there)."""
        out: list[tuple[int, int] | None] = []
        for name in (INDEX_NAME, VECTORS_NAME):
            try:
                st = (self.folder / name).stat()
            except OSError:
                out.append(None)
            else:
                out.append((st.st_mtime_ns, st.st_size))
        return out[0], out[1]

    def save(self) -> None:
        """index.json and vectors.npz, each written whole or not at all."""
        files, vectors = self.files, self._vectors
        self.folder.mkdir(parents=True, exist_ok=True)
        data = {
            "version": VERSION,
            "root": str(self.root),
            "embedder": self.embedder_name,
            "truncated": self.truncated,
            "updated": self.updated,
            "files": {p: e.to_json() for p, e in sorted(files.items())},
        }
        path = self.folder / INDEX_NAME
        for target, text in ((path, json.dumps(data, separators=(",", ":"))),
                             (self.folder / ROOT_NAME, str(self.root))):  # fmt: skip
            tmp = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                tmp.write_text(text, encoding="utf-8")
                tmp.replace(target)
            finally:
                tmp.unlink(missing_ok=True)
        keys = sorted(vectors)
        spaces = sorted({vectors[k][0] for k in keys})
        code = {s: i for i, s in enumerate(spaces)}
        embeddings.VectorFile(
            self.embedder_name,
            len(keys),
            spaces,
            np.frombuffer(b"".join(keys), dtype=np.uint8).reshape(-1, 16),
            np.stack([vectors[k][1] for k in keys]).astype(np.float16)
            if keys
            else np.zeros((0, DIM), np.float16),
            np.array([code[vectors[k][0]] for k in keys], dtype=np.uint8),
            np.arange(len(keys), dtype=np.int32),
            wanted=len(keys) + self.pending,
            error=self.error,
        ).write(self.folder / VECTORS_NAME)
        self._seen = self._stamp()  # (its own files: nothing to read back)

    # ── keeping it up to date ──

    def refresh(
        self,
        embedder_source: Source | None = None,
        *,
        only: Iterable[str] | None = None,
        save: bool = True,
        seconds: float = SCAN_SECONDS,
        embed_cap: int | None = None,
        embed_seconds: float = EMBED_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> dict[str, Any]:
        """Read the files that changed since the last look (all of them, or `only` these
        paths, relative to the project or absolute inside it), then embed passages that have
        no vector yet with the embedder embedder_source gives (none: none embedded; its kind
        still names the space). Returns what it did."""
        self.load()
        with self.updating:
            started = clock()
            files = dict(self.files)
            vectors = dict(self._vectors)
            embedder_name = self.embedder_name
            truncated = self.truncated
            changed = removed = 0
            out_of_time = False
            if only is None:
                timed_out: list[bool] = []

                def out_of_listing_time() -> bool:
                    if clock() - started > seconds:
                        timed_out.append(True)
                        return True
                    return False

                listed, truncated = list_files(self.root, out_of_listing_time)
                # A walk cut short by the time lists part of the folder: what it didn't
                # reach isn't gone, and dropping it emptied a big project's index a part
                # at a time (each pass removed what it hadn't got to). A list cut at
                # FILES_MAX is the same first files each time, so past it goes.
                if not timed_out:
                    wanted = set(listed)
                    for path in [p for p in files if p not in wanted]:
                        del files[path]
                        removed += 1
                candidates = listed
            else:
                candidates = []
                for raw in only:
                    rel = self._relative(str(raw))
                    if rel is None:
                        continue
                    if (self.root / rel).is_file() and indexable(rel):
                        candidates.append(rel)
                    elif files.pop(rel, None) is not None:
                        removed += 1
            name = getattr(embedder_source, "kind", "") or embedder_name or HASH_EMBEDDER
            if name != embedder_name:
                # Another embedder from now on: its vectors are another space, and every
                # passage's key names its embedder, so every file is read again.
                embedder_name, vectors = name, {}
                candidates = list(dict.fromkeys([*files, *candidates]))
                files = {}
            # Newest first: what was just edited is what a search is most likely about.
            stats: list[tuple[int, int, str]] = []
            for rel in candidates:
                try:
                    st = (self.root / rel).stat()
                except OSError:
                    if files.pop(rel, None) is not None:
                        removed += 1
                    continue
                entry = files.get(rel)
                if entry is not None and entry.mtime == st.st_mtime_ns and entry.size == st.st_size:
                    continue
                stats.append((st.st_mtime_ns, st.st_size, rel))
            stats.sort(reverse=True)
            for mtime, size, rel in stats:
                if clock() - started > seconds:
                    out_of_time = True
                    break
                entry = self._read(rel, mtime, size, embedder_name)
                if entry is not None:
                    files[rel] = entry
                    changed += 1
                elif files.pop(rel, None) is not None:
                    removed += 1
            wanted_keys = {c.key for e in files.values() for c in e.chunks}
            dropped = [k for k in vectors if k not in wanted_keys]
            for key in dropped:
                del vectors[key]
            if embed_cap is None:
                embed_cap = int(getattr(embedder_source, "per_update", EMBED_PER_UPDATE))
            made, error = self._embed(
                files, vectors, embedder_name, embedder_source, embed_cap, embed_seconds, clock
            )
            pending = _pending(files, vectors)
            with self.lock:
                self.files, self._vectors = files, vectors
                self.embedder_name, self.truncated = embedder_name, truncated
                self.error, self.pending = error, pending
                self.looked_at = clock()
                if changed or removed or made or dropped:
                    self.updated = time.strftime("%Y-%m-%dT%H:%M:%S")
                    self._matrix = self._chunks_by_key = None
            if (changed or removed or made or dropped) and save:
                try:
                    self.save()
                except OSError as exc:
                    log.warning("code index: couldn't save (%s)", exc)
            return {
                "files": len(files),
                "changed": changed,
                "removed": removed,
                "embedded": made,
                "pending": pending,
                "truncated": truncated or out_of_time,
                "error": error,
            }

    def _relative(self, raw: str) -> str | None:
        path = Path(raw)
        path = path if path.is_absolute() else self.root / path
        try:
            rel = path.resolve().relative_to(self.root).as_posix()
        except (ValueError, OSError):
            return None
        return None if is_sensitive(path) else rel

    def _read(self, rel: str, mtime: int, size: int, embedder_name: str) -> FileEntry | None:
        path = self.root / rel
        if is_sensitive(path):
            return None
        text = read_text(path, self.root)
        if text is None:
            return None
        lang = language_of(rel)
        try:
            symbols, imports = extract(text, lang)
        except Exception:  # a pattern that met something odd: the file without symbols
            log.debug("code index: no symbols for %s", rel, exc_info=True)
            symbols, imports = [], []
        lines = text.split("\n")
        chunks = chunks_for(rel, lines, symbols)
        for c in chunks:
            c.key = chunk_key(embedder_name, chunk_text(c, lines, symbols))
        return FileEntry(mtime, size, lang, symbols, imports, chunks)

    def _embed(
        self,
        files: dict[str, FileEntry],
        vectors: dict[bytes, tuple[str, np.ndarray]],
        embedder_name: str,
        source: Source | None,
        cap: int,
        seconds: float,
        clock: Callable[[], float],
    ) -> tuple[int, str]:
        """Vectors for passages without one (newest files first), within the caps."""
        missing: list[tuple[Chunk, FileEntry]] = []
        seen: set[bytes] = set()
        for _rel, entry in sorted(files.items(), key=lambda kv: (-kv[1].mtime, kv[0])):
            for c in entry.chunks:
                if c.key not in vectors and c.key not in seen:
                    seen.add(c.key)
                    missing.append((c, entry))
        cap = min(cap, VECTORS_MAX - len(vectors))
        if not missing or cap <= 0 or source is None:
            return 0, ""
        embedder = source()
        if embedder is None:
            return 0, "no embedder"
        made, error = 0, ""
        started = clock()
        lines_of: dict[str, list[str]] = {}
        try:
            for start in range(0, min(len(missing), cap), BATCH):
                if clock() - started > seconds:
                    break
                batch = missing[start : min(start + BATCH, cap)]
                texts = []
                for c, entry in batch:
                    lines = lines_of.get(c.path)
                    if lines is None:
                        lines = (read_text(self.root / c.path, self.root) or "").split("\n")
                        lines_of[c.path] = lines
                        if len(lines_of) > 64:
                            lines_of.pop(next(iter(lines_of)))
                    texts.append(chunk_text(c, lines, entry.symbols))
                try:
                    answers = embedder.embed(texts)
                except Exception as exc:  # the helper stalled or died: next update
                    error = f"the embedder stopped ({type(exc).__name__})"
                    break
                for (c, _entry), text, answer in zip(batch, texts, answers, strict=True):
                    # The file may have changed since it was read: the key says which text.
                    if isinstance(answer, tuple) and chunk_key(embedder_name, text) == c.key:
                        vectors[c.key] = (answer[0], np.asarray(answer[1], np.float16))
                        made += 1
                    elif answer == "no-assets":
                        error = "no-assets"
        finally:
            with contextlib.suppress(Exception):
                embedder.close()
        return made, error

    def stale(self, clock: Callable[[], float] = time.monotonic) -> bool:
        return not self.looked_at or clock() - self.looked_at > REFRESH_SECONDS

    # ── searching ──

    def _spaces(self) -> dict[str, tuple[np.ndarray, list[bytes]]]:
        """space -> (its vectors as one matrix, their keys), made when the vectors change."""
        with self.lock:
            return self._spaces_locked()

    def _spaces_locked(self) -> dict[str, tuple[np.ndarray, list[bytes]]]:
        if self._matrix is None:
            rows: dict[str, list[bytes]] = {}
            for key, (space, _vec) in self._vectors.items():
                rows.setdefault(space, []).append(key)
            self._matrix = {
                space: (np.stack([self._vectors[k][1] for k in keys]), keys)
                for space, keys in rows.items()
            }
        return self._matrix

    def _by_key(self) -> dict[bytes, list[Chunk]]:
        with self.lock:
            return self._by_key_locked()

    def _by_key_locked(self) -> dict[bytes, list[Chunk]]:
        if self._chunks_by_key is None:
            out: dict[bytes, list[Chunk]] = {}
            for entry in self.files.values():
                for c in entry.chunks:
                    out.setdefault(c.key, []).append(c)
            self._chunks_by_key = out
        return self._chunks_by_key

    def chunk_at(self, path: str, line: int) -> Chunk:
        """The passage a line is in (one made up around it for a file not indexed)."""
        entry = self.files.get(path)
        if entry is not None:
            for c in entry.chunks:
                if c.start <= line <= c.end:
                    return c
        return Chunk(path, max(1, line - 2), line + SNIPPET_LINES - 3, -1)

    def symbol_of(self, chunk: Chunk) -> Symbol | None:
        entry = self.files.get(chunk.path)
        if entry is None or not 0 <= chunk.symbol < len(entry.symbols):
            return None
        return entry.symbols[chunk.symbol]

    def by_meaning(self, vector: tuple[str, np.ndarray], include: str) -> list[tuple[Chunk, float]]:
        space, q = vector
        found = self._spaces().get(space)
        if found is None:
            return []
        matrix, keys = found
        sims = embeddings.similarities(matrix, np.asarray(q, np.float32))
        by_key = self._by_key()
        out: list[tuple[Chunk, float]] = []
        for j in np.argsort(-sims, kind="stable"):
            for c in by_key.get(keys[int(j)], []):
                if code_search.wanted(c.path, include):
                    out.append((c, float(sims[int(j)])))
            if len(out) >= MEANING_TOP:
                break
        return out[:MEANING_TOP]

    def _symbol_table(self) -> list[tuple[str, Symbol, Chunk, str, frozenset, frozenset, int]]:
        """Every symbol that starts a passage, with the parts of its name and doc worked out
        once an update: (path, symbol, passage, lowered qualified name, name parts, doc
        parts, how many parts its own name has)."""
        with self.lock:
            files = self.files
            if self._symbols is not None and self._symbols[0] is files:
                return self._symbols[1]
        table = []
        for path, entry in files.items():
            starts: dict[int, Chunk] = {}
            for c in entry.chunks:
                if c.symbol >= 0:
                    starts.setdefault(c.symbol, c)
            for i, s in enumerate(entry.symbols):
                chunk = starts.get(i)
                if chunk is not None:
                    name_parts = frozenset(parts_of(s.qualified()))
                    table.append(
                        (
                            path,
                            s,
                            chunk,
                            s.qualified().lower(),
                            name_parts,
                            frozenset(parts_of(s.doc)) - name_parts,
                            max(1, len(parts_of(s.name))),
                        )
                    )
        with self.lock:
            self._symbols = (files, table)
        return table

    def by_symbol(
        self, terms: list[str], names: list[str], include: str
    ) -> list[tuple[Chunk, float, str]]:
        """Passages whose symbol is named like the query: an identifier in it exactly
        (parseConfig), else the parts of its words in the name, more faintly in the doc."""
        wanted_parts = set(terms)
        lowered = {n.lower() for n in names}
        scored: list[tuple[float, str, int, Chunk, str]] = []
        for path, s, chunk, qualified, name_parts, doc_parts, own in self._symbol_table():
            exact = s.name.lower() in lowered or qualified in lowered
            in_name = wanted_parts & name_parts if wanted_parts else set()
            if not (exact or in_name) or not code_search.wanted(path, include):
                continue
            if exact:
                score = 10.0
            else:
                score = len(in_name) + 0.3 * len(wanted_parts & doc_parts)
                score += 0.5 * len(in_name) / own
            scored.append((score, path, s.line, chunk, s.qualified()))
        scored.sort(key=lambda t: (-t[0], t[1], t[2]))
        return [(c, score, name) for score, _p, _l, c, name in scored[:SYMBOLS_TOP]]

    def lookup(self, name: str, kind: str = "", limit: int = 10) -> list[dict[str, Any]]:
        """Symbols by name: exact first (Class.method too), then ignoring case, then those
        that start with it, then those that contain it."""
        self.load()
        name = (name or "").strip()[:200]
        if not name:
            return []
        low = name.lower()
        ranked: list[tuple[int, str, int, Symbol]] = []
        for path, entry in self.files.items():
            for s in entry.symbols:
                if kind and s.kind != kind:
                    continue
                q = s.qualified()
                if name in (s.name, q):
                    rank = 0
                elif low in (s.name.lower(), q.lower()):
                    rank = 1
                elif s.name.lower().startswith(low):
                    rank = 2
                elif low in q.lower():
                    rank = 3
                else:
                    continue
                ranked.append((rank, path, s.line, s))
        ranked.sort(key=lambda t: (t[0], len(t[3].name), t[1], t[2]))
        return [
            {
                "name": s.qualified(),
                "kind": s.kind,
                "path": path,
                "line": line,
                "end": s.end,
                "signature": s.signature,
                "doc": s.doc,
            }
            for _r, path, line, s in ranked[: max(1, min(limit, LOOKUP_MAX))]
        ]

    def status(self) -> dict[str, Any]:
        files = self.files
        return {
            "files": len(files),
            "symbols": sum(len(e.symbols) for e in files.values()),
            "chunks": sum(len(e.chunks) for e in files.values()),
            "vectors": len(self._vectors),
            "pending": self.pending,
            "embedder": self.embedder_name,
            "truncated": self.truncated,
            "updated": self.updated,
            "error": self.error,
        }

    def snippet(self, chunk: Chunk, around: int = 0) -> tuple[int, str]:
        """A passage's lines to show (SNIPPET_LINES, from where the words matched when they
        did): (its first line, the text)."""
        path = self.root / chunk.path
        if is_sensitive(path):
            return chunk.start, ""
        text = read_text(path, self.root)
        if text is None:
            return chunk.start, ""
        lines = text.split("\n")
        first = chunk.start
        if around and around - 2 > first:
            first = around - 2
        last = min(len(lines), first + SNIPPET_LINES - 1, max(chunk.end, first))
        shown = [line[:SNIPPET_CHARS].rstrip() for line in lines[first - 1 : last]]
        return first, "\n".join(shown)


# ── a hybrid search ──


def query_terms(text: str) -> tuple[list[str], list[str]]:
    """A query's words as stems (for symbols and git grep), and its identifiers as typed
    (an exact symbol name): words that look like code (parse_config, parseConfig,
    Bridge.call), or the query's one word when it's a single word."""
    words = re.findall(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*", text)
    names = [
        w
        for w in words
        if len(w) >= 3
        and w.lower() not in STOPWORDS
        and (len(words) == 1 or "_" in w or "." in w or re.search(r"[a-z][A-Z]", w))
    ]
    terms = list(dict.fromkeys(parts_of(text)))[:12]
    return terms, list(dict.fromkeys(names))[:12]


def by_words(
    index: CodeIndex, terms: list[str], include: str, stop: code_search.Stop | None = None
) -> list[tuple[Chunk, float, list[str], int]]:
    """Passages where the query's words are, by git grep (or a walk) on the files as they
    are now: [(passage, score, the words found, its first matching line)], most words first."""
    grep = [t for t in terms if len(t) >= 3][:10]
    if not grep:
        return []
    pattern = "|".join(re.escape(t) for t in sorted(grep, key=len, reverse=True))
    try:
        found = code_search.search(
            index.root,
            code_search.Query(text=pattern, regex=True, include=include),
            stop or code_search.Stop(WORD_SECONDS),
        )
    except code_search.SearchError:
        return []
    hits: dict[tuple[str, int], list[Any]] = {}  # (path, start) -> [chunk, words, lines, first]
    for f in found.get("files") or []:
        path = f["path"]
        if not indexable(path) and path not in index.files:
            continue
        for m in f["matches"]:
            chunk = index.chunk_at(path, int(m["line"]))
            low = str(m["text"]).lower()
            words = {t for t in grep if t in low}
            entry = hits.setdefault((path, chunk.start), [chunk, set(), 0, int(m["line"])])
            entry[1] |= words
            entry[2] += 1
    scored = [
        (c, len(words) + 0.1 * min(lines, 5), sorted(words), first)
        for c, words, lines, first in hits.values()
    ]
    scored.sort(key=lambda t: (-t[1], t[0].path, t[0].start))
    return scored[:WORDS_TOP]


def search(
    index: CodeIndex,
    text: str,
    *,
    limit: int = 10,
    include: str = "",
    query_vector: Callable[[str], tuple[str, np.ndarray] | None] | None = None,
    stop: code_search.Stop | None = None,
) -> dict[str, Any]:
    """The project's passages for a query, best first: {results: [{path, line, end, symbol,
    kind, score, why, snippet, snippet_line}], how: which ways found them, note}."""
    text = (text or "").strip()
    if not text:
        raise code_search.SearchError("Say what to look for.")
    if len(text) > QUERY_MAX or "\0" in text:
        raise code_search.SearchError("That's too long to search for.")
    if "\0" in (include or ""):  # (the word search's git grep would raise ValueError)
        raise code_search.SearchError("A file filter can't contain a NUL character.")
    limit = max(1, min(int(limit or 10), RESULTS_MAX))
    index.load()
    terms, names = query_terms(text)
    meaning: list[tuple[Chunk, float]] = []
    note = ""
    vector = None
    if query_vector is not None:
        try:
            vector = query_vector(text)
        except Exception as exc:
            log.info("code index: no vector for a search (%s)", exc)
    if vector is not None:
        meaning = index.by_meaning(vector, include)
    elif index.embedder_name and index.embedder_name != HASH_EMBEDDER:
        note = "By words and names only this time: the meaning model didn't answer."
    symbols = index.by_symbol(terms, names, include)
    words = by_words(index, terms, include, stop)
    fused: dict[tuple[str, int], dict[str, Any]] = {}

    def add(chunk: Chunk, rank: int, weight: float, why: str, around: int = 0) -> None:
        key = (chunk.path, chunk.start)
        item = fused.setdefault(key, {"chunk": chunk, "score": 0.0, "why": [], "around": 0})
        item["score"] += weight / (RRF_K + rank + 1)
        item["why"].append(why)
        if around and not item["around"]:
            item["around"] = around

    for rank, (chunk, sim) in enumerate(meaning):
        add(chunk, rank, 1.0, f"meaning {sim:.2f}")
    for rank, (chunk, score, name) in enumerate(symbols):
        weight = 1.6 if score >= 10 else 1.0
        add(chunk, rank, weight, f"{'named' if score >= 10 else 'name like'} {name}")
    for rank, (chunk, _score, found_words, first) in enumerate(words):
        add(chunk, rank, 0.9, "words: " + ", ".join(found_words), first)
    ranked = sorted(fused.values(), key=lambda i: (-i["score"], i["chunk"].path, i["chunk"].start))[
        :limit
    ]
    top = ranked[0]["score"] if ranked else 1.0
    results = []
    for item in ranked:
        chunk = item["chunk"]
        symbol = index.symbol_of(chunk)
        first, shown = index.snippet(chunk, item["around"])
        results.append(
            {
                "path": chunk.path,
                "line": symbol.line if symbol is not None else chunk.start,
                "end": chunk.end,
                "symbol": symbol.qualified() if symbol is not None else "",
                "kind": symbol.kind if symbol is not None else "",
                "signature": symbol.signature if symbol is not None else "",
                "score": round(item["score"] / top, 3),
                "why": "; ".join(item["why"]),
                "snippet": shown,
                "snippet_line": first,
            }
        )
    how = [h for h, found in (("meaning", meaning), ("names", symbols), ("words", words)) if found]
    return {"results": results, "how": how, "note": note, "status": index.status()}


def results_text(found: dict[str, Any], query: str) -> str:
    """A search's results as a session reads them: file:line, symbol, why, the lines."""
    results = found.get("results") or []
    if not results:
        return f"Nothing in the project matched “{query[:200]}”." + (
            f" {found['note']}" if found.get("note") else ""
        )
    out = [f"{len(results)} places in the project for “{query[:200]}” (best first):"]
    for r in results:
        head = f"{r['path']}:{r['line']}"
        if r["symbol"]:
            head += f"  {r['kind']} {r['symbol']}"
        out.append(f"\n{head}  ({r['why']})")
        if r["snippet"]:
            out.append(f"```\n{r['snippet']}\n```")
    if found.get("note"):
        out.append(found["note"])
    status = found.get("status") or {}
    if status.get("pending"):
        out.append(f"(The index is still embedding {status['pending']} passages.)")
    return "\n".join(out)


def lookup_text(found: list[dict[str, Any]], name: str) -> str:
    if not found:
        return f"No symbol named like “{name[:200]}” in the project's index."
    out = []
    for s in found:
        out.append(f"{s['kind']} {s['name']} — {s['path']}:{s['line']}\n  {s['signature']}")
        if s["doc"]:
            out.append(f"  {s['doc']}")
    return "\n".join(out)


# ── the embedders here ──


def query_vector_for(embedder: Any) -> Callable[[str], tuple[str, np.ndarray] | None]:
    """A function giving a query's vector from an embedder (None: no vector this time)."""

    def vector(text: str) -> tuple[str, np.ndarray] | None:
        answer = embedder.embed([text[:EMBED_CHARS]], timeout=QUERY_SECONDS)[0]
        return answer if isinstance(answer, tuple) else None

    return vector


def model_embedder(kind: str, timeout: float = embeddings.BUILD_SECONDS) -> Any:
    """The second brain's embedder of this kind, if it's ready on this computer without
    fetching or building anything: Apple's ("apple") or the ONNX model ("minilm")."""
    try:
        if kind == "minilm":
            from . import winembed

            return winembed.embedder()
        if kind == "apple":
            from . import swift_helper

            binary = swift_helper.binary_for(embeddings.HELPER)
            if binary is None or not binary.exists():
                return None
            return embeddings.HelperEmbedder(binary, timeout=timeout)
    except Exception as exc:
        log.info("code index: the %s embedder isn't usable (%s)", kind, exc)
    return None


def model_ready(kind: str) -> bool:
    try:
        if kind == "minilm":
            from . import winembed

            return winembed.model_ready()
        if kind == "apple":
            from . import swift_helper

            binary = swift_helper.binary_for(embeddings.HELPER)
            return binary is not None and binary.exists()
    except Exception:
        return False
    return False


class Source:
    """An embedder source for refresh(): kind names its space ("hash-v1", "apple",
    "minilm"); calling it gives a fresh embedder (closed after the update), or None."""

    def __init__(
        self, kind: str, make: Callable[[], Any], per_update: int = EMBED_PER_UPDATE
    ) -> None:
        self.kind = kind
        self.make = make
        self.per_update = per_update

    def __call__(self) -> Any:
        return self.make()


def hash_source() -> Source:
    return Source(HASH_EMBEDDER, HashEmbedder, per_update=VECTORS_MAX)


def source_for(kind: str) -> Source:
    if kind in ("apple", "minilm"):
        return Source(kind, lambda: model_embedder(kind))
    return hash_source()


def query_embedder_for(kind: str) -> Any:
    """For a search: an embedder of the kind its index's vectors came from (None when that
    one isn't here now, so the search goes by words and names)."""
    if kind in ("", HASH_EMBEDDER):
        return HashEmbedder()
    return model_embedder(kind, timeout=QUERY_SECONDS)
