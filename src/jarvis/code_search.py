"""Search an Eden Code project's files: git grep in a git repository (its tracked files and
its untracked ones, never those git ignores), else a walk of the folder in Python that
leaves out the folders a project doesn't own (node_modules, .venv, build output, hidden
ones).

- Text or a regular expression (Perl-style in git grep, as Python's and the window's are),
  match case or not, whole words or not, and a filter of which files: "*.py", "src/",
  "src/**/*.ts", several split by commas, "!tests/" to leave some out.
- Bounded: at most MATCHES_MAX matches, PER_FILE_MAX in one file, FILES_MAX files, each line
  cut to LINE_MAX characters, and SECONDS in all; a search can be stopped (a newer one
  replaces it), and says when it stopped short.
- An expression the owner typed is matched in Python by a process of its own (_Matcher):
  Python's re holds the GIL while it matches, so one that backtracks without end, (a+)+$,
  froze the whole backend. Now that process is stopped after REGEX_SECONDS on one file or
  line, and the answer says the expression was too slow ("slow").
- Where a line matched ("spans") is counted in UTF-16 units, as the window's strings are:
  an emoji before a match moved its mark.
- Credentials files and private folders never show up (computer.is_sensitive), whatever
  matches in them; binary files neither.

Nothing here calls a model.
"""

from __future__ import annotations

import contextlib
import fnmatch
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .code_vocab import SKIP_DIRS
from .computer import is_sensitive

MATCHES_MAX = 2000
PER_FILE_MAX = 100
FILES_MAX = 500
LINE_MAX = 400  # characters of a matching line shown
SECONDS = 20.0
WALK_FILES_MAX = 300_000  # files a walk looks at, at most (SECONDS ends one sooner, saying so)
FILE_BYTES_MAX = 2_000_000  # bigger files are left out of a walk
QUERY_MAX = 500
SNIFF = 8000  # bytes looked at for a NUL (a binary file)
REGEX_SECONDS = 2.0  # an expression's matching on one file or line, at most (_Matcher)


class SearchError(ValueError):
    """Why a search can't run, in words for the owner."""


@dataclass
class Query:
    text: str
    regex: bool = False
    case: bool = False
    word: bool = False
    include: str = ""  # which files: "*.py, src/, !tests/"

    def pattern(self) -> re.Pattern[str]:
        """The query as a Python pattern (for a walk, and for where on a line it matched)."""
        source = self.text if self.regex else re.escape(self.text)
        if self.word:
            source = rf"\b(?:{source})\b"
        try:
            return re.compile(source, 0 if self.case else re.IGNORECASE)
        except re.error as exc:
            raise SearchError(f"That isn't a regular expression here: {exc}") from None


@dataclass
class Found:
    files: list[dict[str, Any]] = field(default_factory=list)
    total: int = 0
    truncated: bool = False  # stopped at a limit: there may be more
    stopped: bool = False  # stopped by a newer search, or the time limit
    engine: str = ""
    slow: str = ""  # the file an expression was too slow on (its matching was stopped)

    def add(self, path: str, line: int, text: str, spans: list[list[int]]) -> bool:
        """One match; False once a limit is reached (the rest are skipped)."""
        if self.total >= MATCHES_MAX:
            self.truncated = True
            return False
        if not self.files or self.files[-1]["path"] != path:
            if len(self.files) >= FILES_MAX:
                self.truncated = True
                return False
            self.files.append({"path": path, "matches": []})
        matches = self.files[-1]["matches"]
        if len(matches) >= PER_FILE_MAX:
            self.files[-1]["more"] = True
            self.truncated = True
            return True
        shown = text[:LINE_MAX]
        matches.append({"line": line, "text": shown, "spans": utf16_spans(shown, spans)})
        self.total += 1
        return True

    def result(self) -> dict[str, Any]:
        return {
            "files": self.files,
            "total": self.total,
            "truncated": self.truncated,
            "stopped": self.stopped,
            "engine": self.engine,
            **({"slow": self.slow} if self.slow else {}),
        }


def utf16_spans(text: str, spans: list[list[int]]) -> list[list[int]]:
    """Spans counted in characters as the window counts them (UTF-16 units): a character
    past U+FFFF (an emoji) is two there."""
    if text.isascii() or not spans:
        return spans
    wide = [i for i, ch in enumerate(text) if ord(ch) > 0xFFFF]
    if not wide:
        return spans

    def at(i: int) -> int:
        return i + sum(1 for w in wide if w < i)

    return [[at(s), at(e)] for s, e in spans]


def spans_in(pattern: re.Pattern[str] | None, text: str) -> list[list[int]]:
    """Where a pattern matched in a (shown) line: [[start, end]], at most 20 (in characters:
    Found.add makes them UTF-16 units)."""
    if pattern is None:
        return []
    out = []
    for m in pattern.finditer(text[:LINE_MAX]):
        if m.end() > m.start():
            out.append([m.start(), m.end()])
            if len(out) >= 20:
                break
    return out


# ── which files ──


def _globs(include: str) -> tuple[list[str], list[str]]:
    """The file filter as (wanted, left out) patterns: "src/" means everything under it."""
    wanted, unwanted = [], []
    for raw in re.split(r"[,\n]", include or ""):
        item = raw.strip()
        if not item:
            continue
        (unwanted if item.startswith("!") else wanted).append(item.lstrip("!").strip())
    return [g for g in wanted if g], [g for g in unwanted if g]


def _matches_glob(path: str, glob: str) -> bool:
    glob = glob[2:] if glob.startswith("./") else glob
    if glob.endswith("/"):
        if re.search(r"[*?\[]", glob):  # a folder by a pattern, at any depth: src/d9*/
            return fnmatch.fnmatch(f"/{path}", f"*/{glob}*")
        return path.startswith(glob) or f"/{glob}" in f"/{path}"
    if "/" not in glob:  # a name pattern, anywhere: *.py, Makefile
        return fnmatch.fnmatch(path.rsplit("/", 1)[-1], glob)
    return fnmatch.fnmatch(path, glob) or fnmatch.fnmatch(path, glob.replace("**/", ""))


def wanted(path: str, include: str) -> bool:
    ins, outs = _globs(include)
    if any(_matches_glob(path, g) for g in outs):
        return False
    return not ins or any(_matches_glob(path, g) for g in ins)


# ── the search ──


class Stop:
    """Asked to stop (a newer search), or out of time."""

    def __init__(self, seconds: float = SECONDS) -> None:
        self.event = threading.Event()
        self.until = time.monotonic() + seconds

    def set(self) -> None:
        self.event.set()

    def __bool__(self) -> bool:
        return self.event.is_set() or time.monotonic() > self.until


def is_git(root: Path) -> bool:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and out.stdout.strip() == "true"


def search(root: Path, query: Query, stop: Stop | None = None) -> dict[str, Any]:
    """The project's matches for a query: {files: [{path, matches: [{line, text, spans}],
    more?}], total, truncated, stopped, engine}. Raises SearchError for a query that can't
    run."""
    text = query.text
    if not text.strip():
        raise SearchError("Type something to search for.")
    if len(text) > QUERY_MAX or "\0" in text or "\n" in text:
        raise SearchError("That's too long to search for.")
    pattern = query.pattern()  # (a bad expression says so before anything runs)
    # (Not `stop or Stop()`: a Stop not yet set is falsy, and the caller's was replaced, so
    # nothing could stop a search.)
    stop = stop if stop is not None else Stop()
    root = Path(root).resolve()
    matcher = _Matcher(pattern, stop) if query.regex else None
    try:
        if is_git(root):
            return _git_grep(root, query, pattern, stop, matcher)
        return _walk(root, query, pattern, stop, matcher)
    finally:
        if matcher is not None:
            matcher.close()


def _git_grep(
    root: Path, query: Query, pattern: re.Pattern[str], stop: Stop, matcher: _Matcher | None
) -> dict[str, Any]:
    found = Found(engine="git")
    args = ["git", "-C", str(root), "grep", "-n", "-z", "-I", "--no-color", "--untracked"]
    args += [f"--max-count={PER_FILE_MAX + 1}"]
    args += ["-P" if query.regex else "-F"]
    if not query.case:
        args.append("-i")
    if query.word:
        args.append("-w")
    args += ["-e", query.text, "--"]
    ins, outs = _globs(query.include)
    args += [_pathspec(g) for g in ins] or ["."]
    args += [_pathspec(g, exclude=True) for g in outs]
    try:
        proc = subprocess.Popen(  # noqa: S603 - git, on the owner's own project
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except OSError as exc:
        raise SearchError(f"git grep didn't start: {exc}") from None
    watcher = threading.Thread(target=_kill_when, args=(proc, stop), daemon=True)
    watcher.start()
    assert proc.stdout is not None
    stopped = False
    try:
        for raw in proc.stdout:
            if stop:
                stopped = True
                break
            parts = raw.rstrip(b"\n").removesuffix(b"\r").split(b"\0", 2)  # (a CRLF line: as the walk shows it)
            if len(parts) != 3:
                continue
            path = parts[0].decode("utf-8", errors="replace")
            try:
                line = int(parts[1])
            except ValueError:
                continue
            if is_sensitive(root / path):
                continue
            shown = parts[2].decode("utf-8", errors="replace")
            if matcher is None:
                spans = spans_in(pattern, shown)
            elif found.slow:  # (too slow on a line already: the rest go unmarked)
                spans = []
            else:
                try:
                    spans = matcher.spans(shown)
                except _TooSlow:
                    found.slow, spans = path, []
                except _Stopped:
                    stopped = True
                    break
            if not found.add(path, line, shown, spans):
                break
        else:
            stopped = bool(stop)  # (git ended: by itself, or ended by the watcher)
    finally:
        with contextlib.suppress(OSError):
            proc.kill()
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        proc.wait()
        stop.set()  # (the watcher's done too)
    found.stopped = stopped
    if proc.returncode not in (0, 1, -9) and not found.total and not stopped:
        # 1: nothing matched; -9: killed at a limit. Anything else is git saying why.
        message = err.strip().splitlines()[-1] if err.strip() else "git grep failed."
        raise SearchError(message.removeprefix("fatal: ")[:300])
    return found.result()


def _pathspec(glob: str, exclude: bool = False) -> str:
    """A file filter's pattern as git's pathspec: "src/" a folder, "*.py" a name anywhere,
    "src/**/*.ts" a glob (** is any folders, none too)."""
    glob = glob[2:] if glob.startswith("./") else glob
    magic = ["exclude"] if exclude else []
    if glob.endswith("/") and re.search(r"[*?\[]", glob):  # a folder by a pattern: src/d9*/
        body = glob if "/" in glob[:-1] else f"**/{glob}"
        return f":({','.join([*magic, 'glob'])}){body}**"
    if not glob.endswith("/"):
        if "/" not in glob:
            glob = f"**/{glob}"
        if re.search(r"[*?\[]", glob):
            magic.append("glob")
    return f":({','.join(magic)}){glob}" if magic else glob


def _kill_when(proc: subprocess.Popen, stop: Stop) -> None:
    """End git grep when the search is stopped or out of time."""
    while proc.poll() is None:
        if stop:
            with contextlib.suppress(OSError):
                proc.kill()
            return
        stop.event.wait(0.1)


def _walk(
    root: Path, query: Query, pattern: re.Pattern[str], stop: Stop, matcher: _Matcher | None
) -> dict[str, Any]:
    found = Found(engine="walk")
    looked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            looked += 1
            if looked > WALK_FILES_MAX:
                found.truncated = True
                return found.result()
            if stop:
                found.stopped = True
                return found.result()
            path = Path(dirpath, name)
            rel = path.relative_to(root).as_posix()
            if not wanted(rel, query.include) or is_sensitive(path) or path.is_symlink():
                continue
            if matcher is not None:
                try:
                    lines = matcher.file(path)
                except _TooSlow:  # (it would be as slow on the next one: the search ends)
                    found.slow = rel
                    return found.result()
                except _Stopped:
                    found.stopped = True
                    return found.result()
                if not _add_lines(rel, lines, found):
                    return found.result()
            elif not _search_file(path, rel, pattern, found):
                return found.result()
    return found.result()


def _add_lines(rel: str, lines: list[list[Any]], found: Found) -> bool:
    """A file's matching lines ([line, text, spans]) from the matcher; False once a limit
    is reached."""
    for n, shown, spans in lines:
        if not found.add(rel, n, shown, spans):
            return False
        if found.files[-1].get("more"):
            return True
    return True


def file_lines(text: str) -> list[str]:
    """A file's lines as git and the editor count them: split at "\n" only (a form feed,
    U+2028 or U+0085 inside a line is part of it; splitlines() made the numbers run ahead,
    CF2-9), a "\r" before it left out. (The worker's file_lines is this one.)"""
    out = text.split("\n")
    if out and out[-1] == "":
        out.pop()
    return [x[:-1] if x.endswith("\r") else x for x in out]


def _search_file(path: Path, rel: str, pattern: re.Pattern[str], found: Found) -> bool:
    """One file's matches; False once a limit is reached."""
    try:
        if path.stat().st_size > FILE_BYTES_MAX:
            return True
        raw = path.read_bytes()
    except OSError:
        return True
    if b"\0" in raw[:SNIFF]:
        return True
    text = raw.decode("utf-8", errors="replace")
    if not pattern.search(text):
        return True
    for n, line in enumerate(file_lines(text), 1):
        if pattern.search(line):
            shown = line[:LINE_MAX]
            if not found.add(rel, n, shown, spans_in(pattern, shown)):
                return False
            if found.files[-1].get("more"):
                return True
    return True


# ── an expression the owner typed, matched in a process of its own ──

_REGEX_WORKER = r"""
import json, os, re, sys
source, flags, line_max, per_file, size_max, sniff = json.loads(sys.stdin.readline())
pattern = re.compile(source, flags)
# A first look over the whole file, before line by line: ^ and $ at every line's ends, as
# they are on one line (without MULTILINE they meant the file's ends, and a plain folder
# found nothing for ^def). An expression that reads past a line's ends (\A, \Z, \n, a
# lookaround) has no such look: every line is matched.
whole = None if re.search(r"\\[AZznr]|\(\?<?[=!]", source) else re.compile(source, flags | re.MULTILINE)
def file_lines(text):
    out = text.split("\n")
    if out and out[-1] == "":
        out.pop()
    return [x[:-1] if x.endswith("\r") else x for x in out]
def spans(text):
    out = []
    for m in pattern.finditer(text[:line_max]):
        if m.end() > m.start():
            out.append([m.start(), m.end()])
            if len(out) >= 20:
                break
    return out
def lines(path):
    try:
        if os.stat(path).st_size > size_max:
            return []
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return []
    if b"\0" in raw[:sniff]:
        return []
    text = raw.decode("utf-8", "replace")
    out = []
    if whole is None or whole.search(text.replace("\r\n", "\n") if "\r" in text else text):
        for n, line in enumerate(file_lines(text), 1):
            if pattern.search(line):
                shown = line[:line_max]
                out.append([n, shown, spans(shown)])
                if len(out) > per_file:
                    break
    return out
for ask in sys.stdin:
    ask = json.loads(ask)
    answer = spans(ask["line"]) if "line" in ask else lines(ask["file"])
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()
"""


class _TooSlow(Exception):
    """The expression took over REGEX_SECONDS on one file or line."""


class _Stopped(Exception):
    """The search was stopped (a newer one, or its time) while the expression matched."""


class _Matcher:
    """Python's re for an expression the owner typed, in a process of its own: re holds the
    GIL while it matches, so an expression that backtracks without end, (a+)+$, run in the
    backend's own threads froze every session and window. This process is killed when a
    file or line takes over REGEX_SECONDS, or when the search is stopped. Same re, same
    flags: the matches are the ones the search found before."""

    def __init__(self, pattern: re.Pattern[str], stop: Stop) -> None:
        self.stop = stop
        self.answers: queue.Queue[str | None] = queue.Queue()
        try:
            self.proc: subprocess.Popen | None = subprocess.Popen(  # noqa: S603 - this Python
                [sys.executable, "-I", "-S", "-c", _REGEX_WORKER],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
            )
        except OSError as exc:
            raise SearchError(f"The search didn't start: {exc}") from None
        threading.Thread(target=self._read, args=(self.proc.stdout,), daemon=True).start()
        flags = pattern.flags & (re.IGNORECASE | re.MULTILINE | re.DOTALL | re.VERBOSE)
        setup = [pattern.pattern, flags, LINE_MAX, PER_FILE_MAX, FILE_BYTES_MAX, SNIFF]
        self._write(setup)

    def _read(self, stream: Any) -> None:
        with contextlib.suppress(Exception):
            for line in stream:
                self.answers.put(line)
        self.answers.put(None)  # (the process ended)

    def _write(self, item: Any) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise _TooSlow
        try:
            self.proc.stdin.write(json.dumps(item) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):  # it ended (killed, or out of memory)
            self.close()
            raise _TooSlow from None

    def _ask(self, item: dict[str, str]) -> Any:
        self._write(item)
        until = time.monotonic() + REGEX_SECONDS
        while True:
            if self.stop:
                self.close()
                raise _Stopped
            if time.monotonic() > until:
                self.close()
                raise _TooSlow
            try:
                line = self.answers.get(timeout=0.05)
            except queue.Empty:
                continue
            if line is None:
                self.close()
                raise _TooSlow
            return json.loads(line)

    def spans(self, text: str) -> list[list[int]]:
        return self._ask({"line": text})

    def file(self, path: Path) -> list[list[Any]]:
        return self._ask({"file": str(path)})

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        with contextlib.suppress(OSError):
            proc.kill()
        for stream in (proc.stdin, proc.stdout):
            with contextlib.suppress(Exception):
                stream.close()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)
