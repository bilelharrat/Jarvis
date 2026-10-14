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
- Credentials files and private folders never show up (computer.is_sensitive), whatever
  matches in them; binary files neither.

Nothing here calls a model.
"""

from __future__ import annotations

import contextlib
import fnmatch
import os
import re
import stat
import subprocess
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
WALK_FILES_MAX = 30000  # files a walk looks at, at most
FILE_BYTES_MAX = 2_000_000  # bigger files are left out of a walk
QUERY_MAX = 500
SNIFF = 8000  # bytes looked at for a NUL (a binary file)


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
        matches.append({"line": line, "text": text[:LINE_MAX], "spans": spans})
        self.total += 1
        return True

    def result(self) -> dict[str, Any]:
        return {
            "files": self.files,
            "total": self.total,
            "truncated": self.truncated,
            "stopped": self.stopped,
            "engine": self.engine,
        }


def spans_in(pattern: re.Pattern[str] | None, text: str) -> list[list[int]]:
    """Where a pattern matched in a (shown) line: [[start, end]], at most 20."""
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
    if "\0" in (query.include or ""):  # (no command can carry one: git grep raised)
        raise SearchError("A file filter can't contain a NUL character.")
    pattern = query.pattern()  # (a bad expression says so before anything runs)
    stop = stop or Stop()
    root = Path(root).resolve()
    if is_git(root):
        return _git_grep(root, query, pattern, stop)
    return _walk(root, query, pattern, stop)


def _git_grep(root: Path, query: Query, pattern: re.Pattern[str], stop: Stop) -> dict[str, Any]:
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
    except ValueError:  # a NUL in the words or the file filter: no command can carry it
        raise SearchError("A search can't contain a NUL character.") from None
    except OSError as exc:
        raise SearchError(f"git grep didn't start: {exc}") from None
    watcher = threading.Thread(target=_kill_when, args=(proc, stop), daemon=True)
    watcher.start()
    assert proc.stdout is not None
    stopped = False
    try:
        for name, number, text in _grep_records(proc.stdout):
            if stop:
                stopped = True
                break
            path = name.decode("utf-8", errors="replace")
            try:
                line = int(number)
            except ValueError:
                continue
            if is_sensitive(root / path):
                continue
            shown = text.decode("utf-8", errors="replace")
            if not found.add(path, line, shown, spans_in(pattern, shown)):
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


def _grep_records(stream: Any) -> Any:
    """git grep -z's matches as (path, line number, text): each is path NUL number NUL text
    and a newline. Read by its NULs, not by lines: a file name may hold a newline (git
    leaves -z names as they are), and split by lines "new<newline>line.py" gave a match in
    a file "line.py" that isn't there."""
    buf = b""
    while True:
        chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
        if not chunk:
            return
        buf += chunk
        at = 0
        while True:
            first = buf.find(b"\0", at)
            second = buf.find(b"\0", first + 1) if first >= 0 else -1
            end = buf.find(b"\n", second + 1) if second >= 0 else -1
            if end < 0:
                break
            yield buf[at:first], buf[first + 1 : second], buf[second + 1 : end]
            at = end + 1
        buf = buf[at:]


def _pathspec(glob: str, exclude: bool = False) -> str:
    """A file filter's pattern as git's pathspec: "src/" a folder, "*.py" a name anywhere,
    "src/**/*.ts" a glob (** is any folders, none too)."""
    glob = glob[2:] if glob.startswith("./") else glob
    magic = ["exclude"] if exclude else []
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


def _walk(root: Path, query: Query, pattern: re.Pattern[str], stop: Stop) -> dict[str, Any]:
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
            if not _search_file(path, rel, pattern, found):
                return found.result()
    return found.result()


def read_regular(path: Path, limit: int, root: Path | None = None) -> bytes | None:
    """A regular file's bytes, None for anything else or more than limit bytes. Opened
    without waiting and without following a link in its last part, then looked at through
    what was opened (fstat): a named pipe where a .py was used to block the read for good
    (and with it a refresh, a search, the index's one update at a time), and a device or a
    socket is no file to read either. With root (resolved), the file must really be inside
    it: a folder on the way swapped for a link to somewhere else (a tracked pkg/ that's now
    a link to ~/secrets) is refused, and so is a credentials file it really is; the file
    opened must be the one checked (same device and inode), so a swap in between is
    refused too."""
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        real = None
        if root is not None:
            real = path.resolve()
            if not real.is_relative_to(root) or is_sensitive(real):
                return None
        if path.is_symlink():  # (O_NOFOLLOW says so too, where the system has it)
            return None
        fd = os.open(path, flags)
    except (OSError, RuntimeError, ValueError):  # gone, a link loop, a NUL in the name
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            return None
        if real is not None:
            seen = os.stat(real)
            if (seen.st_dev, seen.st_ino) != (st.st_dev, st.st_ino):
                return None
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            return handle.read(limit + 1)[:limit]
    except OSError:
        return None
    finally:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)


def _search_file(path: Path, rel: str, pattern: re.Pattern[str], found: Found) -> bool:
    """One file's matches; False once a limit is reached."""
    raw = read_regular(path, FILE_BYTES_MAX)
    if raw is None:
        return True
    if b"\0" in raw[:SNIFF]:
        return True
    text = raw.decode("utf-8", errors="replace")
    if not pattern.search(text):
        return True
    for n, line in enumerate(text.splitlines(), 1):
        if pattern.search(line):
            shown = line[:LINE_MAX]
            if not found.add(rel, n, shown, spans_in(pattern, shown)):
                return False
            if found.files[-1].get("more"):
                return True
    return True
