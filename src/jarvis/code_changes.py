"""What an Eden Code session changed, as hunks you can undo, keep or stage one at a time.

Several sessions (and the owner) can edit one project folder at once, so "what changed"
has to mean what *this* session changed. Each edit a session makes (Edit, MultiEdit,
Write, NotebookEdit) leaves a mark: the lines it wrote and the lines it took out. A hunk of
the folder's diff is the session's when its changed lines are ones the session's edits
wrote or removed; the other hunks are someone else's and are left alone. A session in its
own isolated copy (worktrees.py) owns everything that differs from where the copy started.

Hunks carry three lines of context, as git shows them, and a stable id (the file and the
hunk's lines, never its line numbers, which move as the file changes). Undoing one applies
just that hunk in reverse (git apply -R), never the whole file: the old Revert put a file
back to the last commit and took every other edit in it along.

Everything here runs git in the project (or the copy) with a timeout, off the event loop.
"""

from __future__ import annotations

import contextlib
import difflib
import hashlib
import os
import re
import subprocess
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import osplat
from .computer import is_sensitive

GIT_SECONDS = 20.0
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # git's own id for "nothing"
# Settings every git call here runs with: never an fsmonitor hook, a pager or a terminal
# prompt, and file names as they are (not \-escaped octal). And git diff never rewrites the
# index on its way out (diff.autoRefreshIndex, which GIT_OPTIONAL_LOCKS below doesn't stop):
# its index.lock made the owner's own git commit fail now and then while the Changes pane
# refreshed. (Files only touched still don't show as changed: their content is compared.)
_SAFE = (
    *("-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"),
    *("-c", "diff.autoRefreshIndex=false"),
)
# For a commit: never as an identity git makes up from the Mac's name (user@Host.local,
# then pushed); with nothing configured, it refuses, and that says to set one.
OWN_IDENTITY = ("-c", "user.useConfigOnly=true")
# GIT_OPTIONAL_LOCKS=0: a read (git status above all) never takes index.lock to refresh the
# index on the way, which made the owner's own git commands, and a session's, fail with
# "index.lock: File exists" while a panel was refreshing. Writes (add, apply --cached,
# commit) still lock as they must.
_ENV = {
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_LITERAL_PATHSPECS": "1",
    "GIT_PAGER": "cat",
    "LC_ALL": "C",
}

# What a view of the changes may carry to a window: past these, files are listed without
# their lines (a window asks for one file when it's opened) and long hunks are cut.
MAX_FILES = 300
MAX_VIEW_LINES = 20_000
MAX_HUNK_LINES = 1_500
MAX_UNTRACKED = 200
SCAN_UNTRACKED = 10_000  # untracked files a secret scan reads (what landing or a PR commits)
UNTRACKED_BYTES = 256_000
# A tracked file whose patch is bigger than this is listed (as binary, as an untracked file
# past UNTRACKED_BYTES is) without its lines, which are dropped as git writes them: a 48 MB
# rewrite took 11 s and half a gigabyte to parse, after every step, for a view that shows a
# few thousand of its lines.
PATCH_BYTES = 8_000_000
# Marks a session keeps (each holds the stripped lines of one edit, capped per edit).
MAX_MARKS = 2_000
MARK_LINES = 400


# ── git ──


@dataclass
class Git:
    code: int
    out: str
    err: str

    @property
    def ok(self) -> bool:
        return self.code == 0


def git(
    cwd: Path | str,
    *args: str,
    input: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float = GIT_SECONDS,
    cut: set[int] | None = None,
    stop: dict[str, Any] | None = None,
) -> Git:
    """One git command in cwd. Never raises: a missing git, a timeout or a folder that went
    away come back as a failure with the reason in err. Its output is read as git wrote it:
    \r\n line ends stay, and bytes that aren't UTF-8 come back as surrogates (and go back
    out the same in input), so a patch made from a diff of a Windows or Latin-1 file still
    applies. Text for a window or for Claude goes through readable() first. cut: a patch
    (git diff) read as it's written, each file's lines past PATCH_BYTES dropped; the files
    cut so (by their order in it) are added to cut. stop: git is stopped at the first file
    cut so, and stop gets that file's header ("section") and its place ("index"); what
    came before it is returned (_diff_patch makes the rest)."""
    if cut is not None and input is None:
        return _patch(cwd, list(args), env, timeout, cut, stop)
    started = time.time()
    try:
        # Its own process group: past its time it's asked to stop (SIGTERM, which git
        # catches to take its lock files away) with whatever it started (a clean filter, a
        # hook), and only killed if it doesn't (CB3-2).
        proc = subprocess.Popen(
            ["git", "-C", str(cwd), *_SAFE, *args],
            stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **_ENV, **(env or {})},
            **osplat.group_popen_kwargs(),
        )
    except OSError as exc:
        return Git(127, "", str(exc))
    try:
        out, err = proc.communicate(
            input.encode("utf-8", "surrogateescape") if input is not None else None,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        if _stop(proc):  # killed: whatever lock it held is still there
            clear_stale_locks(cwd, newer_than=started)
        return Git(124, "", f"git {args[0] if args else ''} took too long")
    except BaseException:
        _stop(proc, grace=0)
        raise
    return Git(
        proc.returncode, out.decode("utf-8", "surrogateescape"), err.decode("utf-8", "replace")
    )


STOP_GRACE = 3.0  # seconds a git asked to stop has to go (it takes its lock files away)


def _stop(proc: subprocess.Popen, grace: float = STOP_GRACE) -> bool:
    """Stop a git and what it started: SIGTERM, a few seconds, then SIGKILL. True when it
    had to be killed (a lock file it held is left behind then). Its output isn't waited for
    (a filter it started could hold the pipe open for minutes)."""
    if grace > 0:
        with contextlib.suppress(OSError):
            osplat.kill_group(proc.pid)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=grace)
    killed = proc.poll() is None
    with contextlib.suppress(OSError):  # (what it started, too, if that ignored SIGTERM)
        osplat.kill_group(proc.pid, force=True)
    if killed:
        with contextlib.suppress(OSError):
            proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        with contextlib.suppress(OSError):
            if pipe is not None:
                pipe.close()
    return killed


# ── lock files a killed git left ──

LOCK_REF_FOLDERS = ("refs/heads", "refs/jarvis")


def _git_dirs(cwd: Path | str) -> tuple[Path, Path] | None:
    """A checkout's own git folder and the repository's common one."""
    try:
        found = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--path-format=absolute", "--git-dir",
             "--git-common-dir"],
            capture_output=True, text=True, env={**os.environ, **_ENV}, timeout=GIT_SECONDS,
            stdin=subprocess.DEVNULL, check=False,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return None
    lines = found.stdout.splitlines() if found.returncode == 0 else []
    if len(lines) < 2:
        return None
    return Path(lines[0]), Path(lines[1])


def lock_files(cwd: Path | str) -> list[Path]:
    """The lock files git has in a checkout's repository just now: its index's (and the main
    checkout's), HEAD's, packed-refs' and those of the branches and recovery refs."""
    dirs = _git_dirs(cwd)
    return _locks_in(*dirs) if dirs is not None else []


def _locks_in(own: Path, common: Path) -> list[Path]:
    found = [
        p
        for p in {own / "index.lock", common / "index.lock", own / "HEAD.lock",
                  common / "packed-refs.lock"}
        if p.exists()
    ]  # fmt: skip
    for sub in LOCK_REF_FOLDERS:
        with contextlib.suppress(OSError):
            found += [p for p in (common / sub).rglob("*.lock") if p.is_file()]
    return sorted(found)


def _checkouts(common: Path) -> list[Path]:
    """Every checkout of a repository, by its common git folder: the main one and each
    linked worktree (read from the files git keeps, no git started)."""
    out = [common.parent]
    with contextlib.suppress(OSError):
        for linked in (common / "worktrees").iterdir():
            with contextlib.suppress(OSError):
                out.append(Path((linked / "gitdir").read_text().strip()).parent)
    return out


def git_running(folders: list[Path]) -> bool | None:
    """Whether a git process is at work in any of these folders (or under them), by its
    working folder (git -C moves there). None when it can't be told (no lsof): then
    nothing is taken for stale."""
    if osplat.IS_WIN:
        return None
    try:
        found = subprocess.run(
            ["lsof", "-a", "-c", "git", "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL, check=False,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return None
    if found.returncode not in (0, 1):
        return None
    roots = []
    for folder in folders:
        with contextlib.suppress(OSError):
            roots.append(folder.resolve())
    for line in found.stdout.splitlines():
        if not line.startswith("n/"):
            continue
        try:
            where = Path(line[1:]).resolve()
        except OSError:
            continue
        if any(where == r or r in where.parents for r in roots):
            return True
    return False


def clear_stale_locks(
    cwd: Path | str, *, before: float | None = None, newer_than: float | None = None
) -> list[str]:
    """Take away lock files a git that's gone left behind (killed part-way, or a crash), so
    git works in the repository again: only when no git is at work in it, and only locks
    made before `before` (a check before a command: they were there when it began) or since
    `newer_than` (the git just killed made them). The ones taken away, by path."""
    dirs = _git_dirs(cwd)
    if dirs is None:
        return []
    own, common = dirs
    picked = []
    for lock in _locks_in(own, common):
        try:
            made = lock.stat().st_mtime
        except OSError:
            continue
        if (before is not None and made < before) or (
            newer_than is not None and made >= newer_than - 1
        ):
            picked.append(lock)
    if not picked or git_running([Path(cwd), common, *_checkouts(common)]) is not False:
        return []
    gone = []
    for lock in picked:
        with contextlib.suppress(OSError):
            lock.unlink()
            gone.append(str(lock))
    return gone


def _patch(
    cwd: Path | str,
    args: list[str],
    env: dict[str, str] | None,
    timeout: float,
    cut: set[int],
    stop: dict[str, Any] | None = None,
) -> Git:
    """git diff's patch as git() gives it, read as git writes it: a file whose patch grows
    past PATCH_BYTES keeps its header and a "Binary files differ" line, and its lines are
    dropped as they come (never all held at once). Which files (by their order in the
    patch) were cut so goes in cut."""
    try:
        proc = subprocess.Popen(
            ["git", "-C", str(cwd), *_SAFE, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env={**os.environ, **_ENV, **(env or {})},
        )
    except OSError as exc:
        return Git(127, "", str(exc))
    late = threading.Timer(timeout, proc.kill)
    late.start()
    kept: list[bytes] = []
    section: list[bytes] = []
    size, index, cutting = 0, -1, False
    try:
        assert proc.stdout is not None and proc.stderr is not None
        for line in proc.stdout:
            if line.startswith(b"diff --git "):
                kept += section
                section, size, index, cutting = [line], len(line), index + 1, False
                continue
            if cutting:
                continue
            section.append(line)
            size += len(line)
            if size > PATCH_BYTES and index >= 0:
                head = []
                for kept_line in section:
                    if kept_line.startswith(b"@@"):
                        break
                    head.append(kept_line)
                section = [*head, b"Binary files differ\n"]
                cut.add(index)
                cutting = True
                if stop is not None:  # (git would go on writing it for a while yet)
                    stop["section"], stop["index"] = b"".join(section), index
                    proc.kill()
                    proc.wait()
                    return Git(0, b"".join(kept).decode("utf-8", "surrogateescape"), "")
        kept += section
        err = proc.stderr.read()
        proc.wait()
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        timed_out = not late.is_alive() and proc.returncode is not None and proc.returncode < 0
        late.cancel()
    if timed_out:
        cut.clear()
        return Git(124, "", f"git {args[0] if args else ''} took too long")
    return Git(
        proc.returncode,
        b"".join(kept).decode("utf-8", "surrogateescape"),
        err.decode("utf-8", "replace"),
    )


def readable(text: str) -> str:
    """Text from git() as a window or Claude reads it: a byte that isn't UTF-8 becomes U+FFFD."""
    if text.isascii():
        return text
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


@dataclass
class Repo:
    top: Path  # the checkout's root
    prefix: str  # the session's folder inside it ("" at the root, else "sub/dir/")

    def shown(self, path: str) -> str:
        """A root-relative path as the session sees it (relative to its folder)."""
        return path[len(self.prefix) :] if self.prefix and path.startswith(self.prefix) else path


def repo_of(cwd: Path) -> Repo | None:
    """The git checkout a folder is in, or None when it isn't in one."""
    found = git(cwd, "rev-parse", "--show-toplevel", "--show-prefix")
    if not found.ok:
        return None
    lines = found.out.splitlines()
    if not lines:
        return None
    return Repo(Path(lines[0]), lines[1] if len(lines) > 1 else "")


def head_commit(top: Path) -> str:
    """HEAD's commit, or "" in a repository with no commits yet."""
    found = git(top, "rev-parse", "--verify", "-q", "HEAD^{commit}")
    return found.out.strip() if found.ok else ""


_SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")  # a commit's id (SHA-1, or SHA-256)


def _repo_and_head(cwd: Path) -> tuple[Repo | None, str | None]:
    """repo_of(cwd) and HEAD's commit, from one git call where both answer plainly (a
    checkout with commits: a view of the changes is made after every step while the pane
    shows, and each git started costs some milliseconds). Anything else (no commits yet, no
    checkout, an answer of another shape) is repo_of's own, with None for HEAD: head_commit
    reads it then, as before."""
    found = git(
        cwd, "rev-parse", "--show-toplevel", "--show-prefix", "--verify", "-q", "HEAD^{commit}"
    )
    lines = found.out.splitlines()
    if found.ok and len(lines) == 3 and lines[0] and _SHA.fullmatch(lines[2]):
        return Repo(Path(lines[0]), lines[1]), lines[2]
    return repo_of(cwd), None


def default_branch(top: Path) -> str:
    """The branch work lands in: the remote's default (origin/HEAD) if there is one, else a
    local main or master, else ""."""
    remote = git(top, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
    if remote.ok and remote.out.strip():
        return remote.out.strip()
    for name in ("main", "master", "trunk", "develop"):
        if git(top, "rev-parse", "--verify", "-q", f"refs/heads/{name}").ok:
            return name
    return ""


def local_default_branch(top: Path) -> str:
    """default_branch as a local branch, the kind work lands in: the remote's default by its
    local name ("origin/main" is main), else a local main or master…, else ""."""
    name = default_branch(top)
    if not name.startswith("origin/"):
        return name
    for local in (name.removeprefix("origin/"), "main", "master", "trunk", "develop"):
        if git(top, "rev-parse", "--verify", "-q", f"refs/heads/{local}").ok:
            return local
    return ""


def merge_base(top: Path, a: str, b: str) -> str:
    found = git(top, "merge-base", a, b)
    return found.out.strip() if found.ok else ""


# ── a diff, parsed ──

_HUNK_HEAD = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$")
_CONTEXT_NAME = re.compile(
    r"(?:def|class|function|func|fn|const|let|var|struct|interface|enum|impl|module|sub)\s+"
    r"([A-Za-z_$][\w$]*)"
)
_ESCAPES = {"a": "\a", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v"}


def _unquote(raw: str) -> str:
    """A path as git wrote it: C-quoted ("a/tab\\tname") when it holds odd characters."""
    raw = raw.rstrip("\t") if not raw.startswith('"') else raw
    if not (len(raw) >= 2 and raw.startswith('"') and raw.endswith('"')):
        return raw
    body, out, i = raw[1:-1], bytearray(), 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt in "01234567" and re.match(r"[0-7]{3}", body[i + 1 : i + 4]):
                out.append(int(body[i + 1 : i + 4], 8))
                i += 4
                continue
            out += _ESCAPES.get(nxt, nxt).encode()
            i += 2
            continue
        out += ch.encode()
        i += 1
    return out.decode("utf-8", errors="replace")


def _quote(path: str) -> str:
    """A path for a patch header, quoted the way git quotes one when it has to be."""
    if not re.search(r'[\s"\\\x00-\x1f\x7f]', path):
        return path
    out = []
    for ch in path:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch in "\t\n\r":
            out.append({"\t": "\\t", "\n": "\\n", "\r": "\\r"}[ch])
        elif ord(ch) < 32 or ord(ch) == 127:
            out.append(f"\\{ord(ch):03o}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _strip_side(path: str) -> str:
    return path[2:] if path.startswith(("a/", "b/")) else path


@dataclass
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    header: str = ""
    lines: list[tuple[str, str]] = field(default_factory=list)  # (" ", "+", "-" or "\\", text)
    id: str = ""

    @property
    def added(self) -> list[str]:
        return [t for tag, t in self.lines if tag == "+"]

    @property
    def removed(self) -> list[str]:
        return [t for tag, t in self.lines if tag == "-"]

    @property
    def where(self) -> str:
        """The function or class git named for it ("" when none)."""
        m = _CONTEXT_NAME.search(self.header)
        return m.group(1) if m else ""

    @property
    def first_changed(self) -> int:
        """The new file's line of its first change (where a comment on it points)."""
        line = self.new_start
        for tag, _ in self.lines:
            if tag in "+-":
                return max(1, line)
            if tag == " ":
                line += 1
        return max(1, self.new_start)


@dataclass
class FileDiff:
    path: str  # relative to the checkout's root, as git names it
    old_path: str = ""
    status: str = "M"  # M, A (added), D (deleted), R (renamed), ? (untracked)
    binary: bool = False
    old_mode: str = ""
    new_mode: str = ""
    sensitive: bool = False  # credentials: listed, never their lines
    hunks: list[Hunk] = field(default_factory=list)
    big: bool = False  # its patch past PATCH_BYTES: listed (as binary), its lines dropped

    @property
    def added(self) -> int:
        return sum(len(h.added) for h in self.hunks)

    @property
    def removed(self) -> int:
        return sum(len(h.removed) for h in self.hunks)

    @property
    def new(self) -> bool:
        return self.status in ("A", "?")


def parse_patch(text: str) -> list[FileDiff]:
    """git diff's output (any context size) as files and hunks."""
    files: list[FileDiff] = []
    current: FileDiff | None = None
    hunk: Hunk | None = None
    # The current hunk's lines so far on each side, to tell when it has all its header
    # counts: kept as it's read (counting them again at each line was quadratic, minutes for
    # a deleted SQL dump, whose "-- " comments each asked).
    old_seen = new_seen = 0
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            current = FileDiff(_path_from_header(line[11:]))
            files.append(current)
            hunk = None
            continue
        if current is None:
            continue
        if hunk is not None:
            tag = line[:1]
            full = old_seen >= hunk.old_count and new_seen >= hunk.new_count
            if tag in (" ", "+", "-", "\\") and not (tag == "-" and line.startswith("--- ")
                                                      and full):  # fmt: skip
                hunk.lines.append((tag, line[1:]))
                if tag != "\\":
                    old_seen += tag != "+"
                    new_seen += tag != "-"
                continue
            if line == "" and full:
                continue
            if line == "":  # an empty context line whose space an editor stripped
                hunk.lines.append((" ", ""))
                old_seen, new_seen = old_seen + 1, new_seen + 1
                continue
            hunk = None
        if line.startswith("@@"):
            m = _HUNK_HEAD.match(line)
            if m is None:
                continue
            hunk = Hunk(
                int(m.group(1)),
                int(m.group(2)) if m.group(2) is not None else 1,
                int(m.group(3)),
                int(m.group(4)) if m.group(4) is not None else 1,
                m.group(5).strip(),
            )
            old_seen = new_seen = 0
            current.hunks.append(hunk)
        elif line.startswith("new file mode "):
            current.status, current.new_mode = "A", line[14:].strip()
        elif line.startswith("deleted file mode "):
            current.status, current.old_mode = "D", line[18:].strip()
        elif line.startswith("old mode "):
            current.old_mode = line[9:].strip()
        elif line.startswith("new mode "):
            current.new_mode = line[9:].strip()
        elif line.startswith("rename from "):
            current.old_path, current.status = _unquote(line[12:]), "R"
        elif line.startswith("rename to "):
            current.path = _unquote(line[10:])
        elif line.startswith("--- "):
            side = _unquote(line[4:])
            if side != "/dev/null":
                current.old_path = current.old_path or _strip_side(side)
        elif line.startswith("+++ "):
            side = _unquote(line[4:])
            if side != "/dev/null":
                current.path = _strip_side(side)
        elif line.startswith(("Binary files ", "GIT binary patch")):
            current.binary = True
    for f in files:
        if f.old_path == f.path and f.status != "R":
            f.old_path = ""
        _stamp(f)
    return files


def _path_from_header(rest: str) -> str:
    """The path in `diff --git a/x b/x` (the ---/+++ lines refine it when there are any)."""
    if rest.startswith('"'):
        end = rest.find('" ', 1)
        return _strip_side(_unquote(rest[: end + 1])) if end > 0 else _strip_side(rest)
    if rest.startswith("a/") and len(rest) % 2 == 1:  # "a/p b/p": the same p on both sides
        half = (len(rest) - 1) // 2
        if rest[half : half + 3] == " b/" and rest[2:half] == rest[half + 3 :]:
            return rest[2:half]
    parts = rest.split(" b/", 1)
    return _strip_side(parts[0]) if parts else rest


def _stamp(f: FileDiff) -> None:
    """Give each hunk its id: its file and its lines (not its line numbers, which move)."""
    seen: dict[str, int] = {}
    for h in f.hunks:
        body = "\n".join(tag + text for tag, text in h.lines)
        digest = hashlib.sha1(f"{f.path}\0{body}".encode(errors="replace")).hexdigest()[:12]
        n = seen.get(digest, 0)
        seen[digest] = n + 1
        h.id = digest if not n else f"{digest}-{n}"


# ── what's changed in a folder ──

_XFUNCNAME = (
    r"^[ \t]*((async[ \t]+)?(def|class|function|func|fn|struct|interface|enum|impl)[ \t].*"
    r"|(export[ \t]+)?(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*"
    r"(async[ \t]*)?(\(|function).*)$"
)


def _diff_args() -> list[str]:
    from .diffspeak import _attributes

    # Hunks named by the nearest function or method, indented or not (git's default names
    # a method's change after its class).
    return [
        "-c",
        f"core.attributesFile={_attributes()}",
        "-c",
        f"diff.spoken.xfuncname={_XFUNCNAME}",
        "diff",
    ]


def diff_files(
    repo: Repo,
    base: str,
    *,
    untracked: bool = True,
    cached: bool = False,
    worktree: bool = True,
    only: set[str] | None = None,
    untracked_cap: int = MAX_UNTRACKED,
) -> list[FileDiff]:
    """Every file that differs between base and the working tree (or, cached, between base
    and the index; worktree False with cached: the index against base only), within the
    session's folder, plus untracked files as new ones. Credentials show as changed, never
    with their lines; an untracked link shows as new, never with what it points to. only:
    the untracked files wanted, by root-relative path (untracked_files); untracked_cap: how
    many of them (a secret scan reads up to SCAN_UNTRACKED)."""
    spec = repo.prefix or "."
    args = [*_diff_args(), "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "-M"]
    if cached:
        args.append("--cached")
    if base:
        args.append(base)
    files = _diff_patch(repo.top, args, spec)
    for f in files:
        if is_sensitive(repo.top / f.path):
            f.sensitive, f.hunks = True, []
    if untracked and worktree:
        files += untracked_files(repo, only, cap=untracked_cap)
    return files


def _diff_patch(top: Path, args: list[str], spec: str) -> list[FileDiff]:
    """git diff's files for diff_files, a file whose patch passes PATCH_BYTES listed as big,
    without its lines. Git is stopped as soon as one does (it took as long again to write
    the rest of a big rewrite's patch, and longer still to read it) and run again without
    that file, which goes back in its place: they're found in git's order."""
    skip: list[str] = []
    bigs: list[tuple[str | None, FileDiff]] = []  # (the path listed before it, the file)
    stopping = True
    while True:
        cut: set[int] = set()
        stop: dict[str, Any] | None = {} if stopping else None
        if skip:  # (GIT_LITERAL_PATHSPECS off: each path says :(literal) itself)
            found = git(top, *args, "--", f":(literal){spec}", *skip, timeout=60, cut=cut,
                        stop=stop, env={"GIT_LITERAL_PATHSPECS": "0"})  # fmt: skip
        else:
            found = git(top, *args, "--", spec, timeout=60, cut=cut, stop=stop)
        files = parse_patch(found.out) if found.ok else []
        for i in cut - {stop.get("index", -1) if stop else -1}:
            if i < len(files):
                files[i].big, files[i].binary, files[i].hunks = True, True, []
        if not stop:
            break
        big = parse_patch(stop["section"].decode("utf-8", "surrogateescape"))
        if not big or len(bigs) >= MAX_FILES:  # (then as before: cut, and git goes on)
            stopping = False
            continue
        big[0].big, big[0].binary, big[0].hunks = True, True, []
        bigs.append((files[-1].path if files else None, big[0]))
        skip += [
            f":(exclude,literal){p}" for p in dict.fromkeys((big[0].old_path, big[0].path)) if p
        ]
    found_big = set()
    for before, f in bigs:
        at = next((i + 1 for i, g in enumerate(files) if g.path == before), 0)
        while at < len(files) and id(files[at]) in found_big:  # (found earlier: before it)
            at += 1
        files.insert(at, f)
        found_big.add(id(f))
    return files


def untracked_files(
    repo: Repo, only: set[str] | None = None, *, cap: int = MAX_UNTRACKED
) -> list[FileDiff]:
    """The untracked files (the first cap of them git lists), each as a new file with its
    lines. only: the root-relative paths wanted; the rest are left out unread (a session's
    own view keeps the files its edits touched alone, and reading every other untracked file
    in the project, after every step, was for nothing). The cap counts the wanted ones, so a
    session's own new file shows however many others the project has."""
    listed = git(
        repo.top, "ls-files", "--others", "--exclude-standard", "-z", "--", repo.prefix or "."
    )
    out: list[FileDiff] = []
    wanted = [p for p in listed.out.split("\0") if p and (only is None or _nfc(p) in only)]
    for rel in wanted[:cap]:
        path = repo.top / rel
        f = FileDiff(rel, status="?", new_mode="100644")
        out.append(f)
        if path.is_symlink() or is_sensitive(path):
            f.sensitive = is_sensitive(path)
            continue  # listed, never read
        try:
            if not path.is_file() or path.stat().st_size > UNTRACKED_BYTES:
                f.binary = path.is_file()
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            f.binary = True
            continue
        text = data.decode("utf-8", errors="surrogateescape")  # as git() reads a diff
        lines = text.split("\n")
        ends_open = not text.endswith("\n") and bool(text)
        if not ends_open:
            lines = lines[:-1]
        if not lines:
            continue
        hunk = Hunk(0, 0, 1, len(lines), "", [("+", line) for line in lines])
        if ends_open:
            hunk.lines.append(("\\", " No newline at end of file"))
        f.hunks.append(hunk)
        _stamp(f)
    return out


# ── marks: the lines a session's own edits wrote and removed ──


@dataclass(frozen=True, slots=True)
class Fingerprint:
    added: frozenset[str]
    removed: frozenset[str]
    whole: bool = False  # a Write: the whole file was the session's as of then


@dataclass(frozen=True, slots=True)
class EditMark:
    path: str
    checkpoint: str  # the user message whose turn made it ("" before the first)
    added: frozenset[str]
    removed: frozenset[str]
    whole: bool = False


def _norm(lines: list[str]) -> set[str]:
    return {s for line in lines if (s := line.strip())}


def fingerprint(tool: str, tool_input: dict[str, Any]) -> Fingerprint | None:
    """What an edit tool call writes and takes out, from its own input (read before it
    runs, so nothing is read from disk)."""
    if not isinstance(tool_input, dict):
        return None
    if tool == "Write":
        lines = str(tool_input.get("content") or "").splitlines()[: MARK_LINES * 10]
        return Fingerprint(frozenset(_norm(lines)), frozenset(), whole=True)
    if tool == "NotebookEdit":
        lines = str(tool_input.get("new_source") or "").splitlines()[:MARK_LINES]
        return Fingerprint(frozenset(_norm(lines)), frozenset())
    if tool == "Edit":
        pairs = [(tool_input.get("old_string"), tool_input.get("new_string"))]
    elif tool == "MultiEdit":
        pairs = [
            (e.get("old_string"), e.get("new_string"))
            for e in (tool_input.get("edits") or [])[:100]
            if isinstance(e, dict)
        ]
    else:
        return None
    added: set[str] = set()
    removed: set[str] = set()
    for old, new in pairs:
        old_lines = str(old or "").splitlines()
        new_lines = str(new or "").splitlines()
        if len(old_lines) > MARK_LINES or len(new_lines) > MARK_LINES:
            # Too big to line up cheaply: what's only on one side is what changed.
            o, n = _norm(old_lines), _norm(new_lines)
            removed |= o - n
            added |= n - o
            continue
        matcher = difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False)
        for op, i1, i2, j1, j2 in matcher.get_opcodes():
            if op in ("replace", "delete"):
                removed |= _norm(old_lines[i1:i2])
            if op in ("replace", "insert"):
                added |= _norm(new_lines[j1:j2])
    return Fingerprint(frozenset(added), frozenset(removed))


def remember(task: Any, path: str, found: Fingerprint | None) -> None:
    """Keep a finished edit's mark on its session, with the turn it belongs to."""
    if found is None or not path:
        return
    checkpoint = task.checkpoints[-1] if task.checkpoints else ""
    task.edit_marks.append(EditMark(str(path), checkpoint, found.added, found.removed, found.whole))
    del task.edit_marks[:-MAX_MARKS]


def forget(task: Any, checkpoints: set[str]) -> None:
    """A rewind (or undo) put these turns' files back: their marks go with them."""
    if checkpoints:
        task.edit_marks[:] = [m for m in task.edit_marks if m.checkpoint not in checkpoints]


# Words every language repeats ("else:", "return None", "end"): a line of only these (and
# punctuation) says nothing about who wrote it.
_KEYWORDS = frozenset(
    """if else elif for while return true false none null nil def class function try except
    finally catch end begin do done then fi esac break continue pass import from export
    default const let var public private protected static void self this new await async
    yield case switch not and or with super package func struct impl match where type
    interface enum module require include use mut pub raise throw throws lambda del global
    nonlocal assert undefined int str bool float string char long double auto final val
    override extends implements get set del print println""".split()
)
_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}|\d{2,}")


def _telling(line: str) -> bool:
    return any(t.lower() not in _KEYWORDS for t in _TOKEN.findall(line))


def owns(hunk: Hunk, marks: list[EditMark]) -> bool:
    """Whether a hunk is the session's: its changed lines are ones its edits wrote or took
    out. Lines like "}" or "else:" appear everywhere, so when a hunk has anything more
    telling, only that counts."""
    if not marks:
        return False
    return _owned(hunk, *_written(marks))


def _written(marks: list[EditMark]) -> tuple[set[str], set[str], bool]:
    """What a file's marks wrote and took out, all told, and whether one rewrote it whole:
    worked out once for all of the file's hunks (once per hunk was every mark's lines
    again for each of them)."""
    wrote: set[str] = set()
    took: set[str] = set()
    for mark in marks:
        wrote |= mark.added
        took |= mark.removed
    return wrote, took, any(m.whole for m in marks)


def _spellings(lines: set[str]) -> set[str]:
    """A hunk's lines and, for one holding bytes that aren't UTF-8 (git() keeps them as
    surrogates), the ways the session may have seen it: with U+FFFD for them, and read as
    Latin-1 (café). What the session's edit wrote then matches either way."""
    out = set(lines)
    for line in lines:
        if line.isascii() or not any("\udc80" <= ch <= "\udcff" for ch in line):
            continue
        raw = line.encode("utf-8", "surrogateescape")
        out.add(raw.decode("utf-8", "replace"))
        out.add(raw.decode("latin-1"))
    return out


def _owned(hunk: Hunk, wrote: set[str], took: set[str], whole: bool) -> bool:
    added = _spellings(_norm(hunk.added))
    removed = _spellings(_norm(hunk.removed))
    check_added = {line for line in added if _telling(line)} or added
    check_removed = {line for line in removed if _telling(line)} or removed
    if check_added & wrote or check_removed & took:
        return True
    return not added and whole  # lines gone from a file it rewrote


def marks_by_file(marks: list[EditMark], top: Path) -> dict[str, list[EditMark]]:
    """The marks keyed by the root-relative path they're in (marks outside it are left out).
    Each path is resolved once, however many marks it has (a long session's 2,000 marks
    are mostly the same few files, and each resolve looks at every folder on the way)."""
    try:
        root = top.resolve()
    except OSError:
        return {}
    out: dict[str, list[EditMark]] = {}
    where: dict[str, str | None] = {}  # a mark's path -> its root-relative one (None: outside)
    for mark in marks:
        if mark.path in where:
            rel = where[mark.path]
        else:
            rel = where[mark.path] = _relative(mark.path, root)
        if rel is not None:
            out.setdefault(rel, []).append(mark)
    return out


def _relative(raw: str, root: Path) -> str | None:
    """Where a mark's path leads, relative to the (resolved) root, composed (NFC); None when
    it's outside."""
    try:
        path = Path(raw)
        path = (path if path.is_absolute() else root / path).resolve()
        return _nfc(path.relative_to(root).as_posix())
    except (OSError, ValueError, RuntimeError):
        return None


def _nfc(path: str) -> str:
    """A path with its accents composed (NFC). On a Mac git names files composed
    (core.precomposeunicode) while a file's name on disk, and so the path a session's edit
    names, can be decomposed (NFD: from a zip or an old disk): compared composed, a
    session's own change to résumé.txt is its own whichever way it was spelled."""
    return path if path.isascii() else unicodedata.normalize("NFC", path)


def scope(files: list[FileDiff], marks: list[EditMark], top: Path) -> list[FileDiff]:
    """Only the session's: files its edits touched, and in them only the hunks it made."""
    return _scoped(files, marks_by_file(marks, top))


def _scoped(files: list[FileDiff], by_file: dict[str, list[EditMark]]) -> list[FileDiff]:
    """scope, with the marks by file already worked out (marks_by_file)."""
    kept: list[FileDiff] = []
    for f in files:
        mine = by_file.get(_nfc(f.path)) or (by_file.get(_nfc(f.old_path)) if f.old_path else None)
        if not mine:
            continue
        if f.sensitive or f.binary or not f.hunks:
            kept.append(f)
            continue
        written = _written(mine)
        hunks = [h for h in f.hunks if _owned(h, *written)]
        if hunks:
            kept.append(
                FileDiff(
                    f.path,
                    f.old_path,
                    f.status,
                    f.binary,
                    f.old_mode,
                    f.new_mode,
                    f.sensitive,
                    hunks,
                    f.big,
                )
            )
    return kept


def spoken_order(files: list[FileDiff]) -> list[FileDiff]:
    """The biggest changes first, as "what changed" names them: "the first change" is in the
    first file it names."""
    return sorted(files, key=lambda f: (-(f.added + f.removed), f.path))


# ── a view for the window ──


@dataclass
class View:
    """One way of looking at a session's changes: its files (in spoken order) and a number
    for each hunk, the one "undo change 3" means."""

    repo: Repo
    base: str
    files: list[FileDiff]
    numbers: dict[str, int] = field(default_factory=dict)  # hunk id -> its number

    def hunk(self, hunk_id: str) -> tuple[FileDiff, Hunk] | None:
        for f in self.files:
            for h in f.hunks:
                if h.id == hunk_id:
                    return f, h
        return None

    def numbered(self) -> list[tuple[int, FileDiff, Hunk]]:
        out = [
            (self.numbers[h.id], f, h) for f in self.files for h in f.hunks if h.id in self.numbers
        ]
        return sorted(out, key=lambda item: item[0])

    def by_number(self, n: int) -> tuple[FileDiff, Hunk] | None:
        for number, f, h in self.numbered():
            if number == n:
                return f, h
        return None


def number(files: list[FileDiff]) -> dict[str, int]:
    numbers: dict[str, int] = {}
    for f in files:
        for h in f.hunks:
            numbers.setdefault(h.id, len(numbers) + 1)
    return numbers


def public(
    view: View, kept: set[str] | frozenset[str] = frozenset(), budget: int | None = None
) -> dict[str, Any]:
    """The view as a window shows it, bounded: past MAX_VIEW_LINES a file is listed with its
    counts but not its lines (omitted), and a hunk past MAX_HUNK_LINES is cut."""
    budget = MAX_VIEW_LINES if budget is None else budget
    files = []
    for f in view.files[:MAX_FILES]:
        item: dict[str, Any] = {
            "path": readable(view.repo.shown(f.path)),
            "old_path": readable(view.repo.shown(f.old_path)) if f.old_path else "",
            "status": f.status,
            "binary": f.binary,
            "big": f.big,
            "sensitive": f.sensitive,
            "added": f.added,
            "removed": f.removed,
            "omitted": False,
            "hunks": [],
        }
        size = sum(min(len(h.lines), MAX_HUNK_LINES) for h in f.hunks)
        if size > budget:
            item["omitted"] = True
        else:
            budget -= size
            item["hunks"] = [
                {
                    "id": h.id,
                    "n": view.numbers.get(h.id, 0),
                    "old_start": h.old_start,
                    "old_count": h.old_count,
                    "new_start": h.new_start,
                    "new_count": h.new_count,
                    "header": readable(h.header[:200]),
                    "where": h.where,
                    "line": h.first_changed,
                    "lines": [
                        [tag, readable(text[:2000])] for tag, text in h.lines[:MAX_HUNK_LINES]
                    ],
                    "cut": max(0, len(h.lines) - MAX_HUNK_LINES),
                    "kept": h.id in kept,
                }
                for h in f.hunks
            ]
        files.append(item)
    return {
        "base": view.base[:12],
        "files": files,
        "truncated": len(view.files) > MAX_FILES,
        "totals": {
            "files": len(view.files),
            "added": sum(f.added for f in view.files),
            "removed": sum(f.removed for f in view.files),
            "hunks": sum(len(f.hunks) for f in view.files),
        },
    }


def file_public(
    view: View, path: str, kept: set[str] | frozenset[str] = frozenset()
) -> dict[str, Any] | None:
    """One file of a view with its lines (one the whole view listed as omitted), up to four
    views' worth of lines."""
    for f in view.files:
        if readable(view.repo.shown(f.path)) == path:
            item = public(View(view.repo, view.base, [f], view.numbers), kept, 4 * MAX_VIEW_LINES)
            return item["files"][0] if item["files"] else None
    return None


def describe(repo: Repo, f: FileDiff, h: Hunk, max_lines: int = 30) -> str:
    """One change, for Claude to explain or act on (never read aloud): where, and its lines."""
    where = f" in {h.where}" if h.where else ""
    body = [f"-{line}" for line in h.removed[:max_lines]] + [
        f"+{line}" for line in h.added[:max_lines]
    ]
    return readable(f"{repo.shown(f.path)} line {h.first_changed}{where}:\n" + "\n".join(body))


def as_text(view: View, limit: int = 60_000) -> str:
    """The view as the reviewer reads it: each hunk with its file and new-file line
    numbers ("   42 + text"), so a finding can name the line it means."""
    out: list[str] = []
    size = 0
    for f in view.files:
        shown = view.repo.shown(f.path)
        if f.sensitive:
            out.append(f"### {shown}\n(credentials: changed, lines withheld)\n")
            continue
        if f.binary:
            out.append(f"### {shown}\n(binary file changed)\n")
            continue
        head = f"### {shown}" + (
            " (new file)" if f.new else " (deleted)" if f.status == "D" else ""
        )
        out.append(head)
        for h in f.hunks:
            line = h.new_start
            rows = [f"@@ {h.where or 'hunk'} @@"]
            for tag, text in h.lines:
                if tag == "\\":
                    continue
                if tag == "-":
                    rows.append(f"      - {text}")
                    continue
                rows.append(f"{line:>5} {'+' if tag == '+' else ' '} {text}")
                line += 1
            block = "\n".join(rows)
            if size + len(block) > limit:
                out.append("[… the rest of the diff is left out]")
                return readable("\n".join(out))
            size += len(block)
            out.append(block)
        out.append("")
    return readable("\n".join(out))


# ── undoing, keeping and staging one hunk ──


def hunk_patch(f: FileDiff, h: Hunk) -> str:
    """A patch of just this hunk, which git apply takes on its own (its counts recounted
    from its lines, so a hunk cut from a longer diff still applies)."""
    old = sum(1 for tag, _ in h.lines if tag in " -")
    new = sum(1 for tag, _ in h.lines if tag in " +")
    old_path = f.old_path or f.path
    a = "/dev/null" if f.new else _quote(f"a/{old_path}")
    b = "/dev/null" if f.status == "D" else _quote(f"b/{f.path}")
    head = [f"diff --git {_quote(f'a/{old_path}')} {_quote(f'b/{f.path}')}"]
    if f.new:
        head.append(f"new file mode {f.new_mode or '100644'}")
    elif f.status == "D":
        head.append(f"deleted file mode {f.old_mode or '100644'}")
    head += [f"--- {a}", f"+++ {b}"]
    old_start = h.old_start if old else 0
    new_start = h.new_start if new else 0
    body = [f"@@ -{old_start},{old} +{new_start},{new} @@"]
    body += [tag + text for tag, text in h.lines]
    return "\n".join(head + body) + "\n"


def undo_hunk(repo: Repo, f: FileDiff, h: Hunk, *, against_head: bool = True) -> str:
    """Put one hunk back as it was (git apply -R of just that hunk): "" when done, else why
    not. A new file is never undone (that would delete it), nor credentials or a binary
    file, whose lines were never shown. against_head: the view is against HEAD, so a staged
    copy of the same change is taken out of the index too (it would be committed anyway)."""
    shown = repo.shown(f.path)
    if f.new:
        return f"{shown} is a new file; delete it yourself if you don't want it."
    if f.sensitive or f.binary:
        return f"{shown} can't be undone a change at a time here."
    patch = hunk_patch(f, h)
    # One undo at a time in a checkout: git apply rewrites a file whole (unlink, create), so
    # two at once in one file lost one of them, or failed on the file briefly not there.
    with _undo_lock(repo.top):
        if not git(repo.top, "apply", "-R", "--check", "--whitespace=nowarn", "-", input=patch).ok:
            return (
                f"That change in {shown} has moved on since the view was made. Refresh and try "
                "again."
            )
        done = git(repo.top, "apply", "-R", "--whitespace=nowarn", "-", input=patch)
        if not done.ok:
            return f"Couldn't undo that change in {shown}: {done.err.strip()[:200]}"
        if against_head and not _unstage(repo, patch):
            return STILL_STAGED.format(path=shown)
    return ""


STILL_STAGED = (
    "Undid that change in {path}, but it's still staged: another git was using the index. "
    "Unstage it in the Git panel before you commit."
)
INDEX_TRIES = 12  # an index another git has locked is tried again for a few seconds


def _unstage(repo: Repo, patch: str) -> bool:
    """A staged copy of an undone hunk taken out of the index too. False only when it's
    still there: another git held the index each time it was tried (CB3-4). Half way, a
    lock no git holds any more (one killed, a crash) is taken away."""
    started = time.time()
    for i in range(INDEX_TRIES):
        if not git(repo.top, "apply", "-R", "--cached", "--check", "-", input=patch).ok:
            return True  # not staged (or staged otherwise): nothing of it to take out
        done = git(repo.top, "apply", "-R", "--cached", "-", input=patch)
        if done.ok:
            return True
        if "index.lock" not in done.err and i >= 2:
            return False
        if i == INDEX_TRIES // 2:
            clear_stale_locks(repo.top, before=started)
        time.sleep(min(0.05 * (i + 1), 0.4))
    return False


_UNDO_LOCKS: dict[str, threading.Lock] = {}
_UNDO_LOCKS_GUARD = threading.Lock()


def _undo_lock(top: Path) -> threading.Lock:
    with _UNDO_LOCKS_GUARD:
        return _UNDO_LOCKS.setdefault(str(top), threading.Lock())


def stage_hunk(repo: Repo, f: FileDiff, h: Hunk, *, unstage: bool = False) -> str:
    """Stage one hunk of the unstaged changes (or, unstage, take one staged hunk back out of
    the index). "" when done, else why not."""
    shown = repo.shown(f.path)
    if f.sensitive:
        return f"{shown} holds credentials; stage it as a whole file if you really mean to."
    patch = hunk_patch(f, h)
    args = ["apply", "--cached", "--whitespace=nowarn"] + (["-R"] if unstage else [])
    if not git(repo.top, *args, "--check", "-", input=patch).ok:
        return f"That change in {shown} has moved on. Refresh and try again."
    done = git(repo.top, *args, "-", input=patch)
    return (
        ""
        if done.ok
        else f"Couldn't {'unstage' if unstage else 'stage'} it: {done.err.strip()[:200]}"
    )


# ── the session's views ──


def session_view(
    cwd: Path, marks: list[EditMark], *, base: str = "", scoped: bool = True
) -> View | None:
    """What the session changed: against base (HEAD when ""), only the hunks its own edits
    made when scoped (a shared folder), else everything (its own isolated copy). None when
    the folder isn't in a git repository."""
    return _session_view(cwd, marks, base=base, scoped=scoped)[0]


def _session_view(
    cwd: Path, marks: list[EditMark], *, base: str = "", scoped: bool = True
) -> tuple[View | None, str | None]:
    """session_view, and HEAD's commit when it was read on the way (None when it wasn't),
    for a branch view made right after it."""
    repo, head = _repo_and_head(cwd)
    if repo is None:
        return None, None
    if not base:
        if head is None:
            head = head_commit(repo.top)
        base = head or EMPTY_TREE
    if scoped:  # (an untracked file is the session's only when its edits touched it)
        by_file = marks_by_file(marks, repo.top)
        files = _scoped(diff_files(repo, base, only=set(by_file)), by_file)
    else:
        files = diff_files(repo, base)
    files = spoken_order(files)
    return View(repo, base, files, number(files)), head


def turn_marks(task: Any) -> list[EditMark]:
    """The marks of the session's latest turn (since its latest message)."""
    last = task.checkpoints[-1] if task.checkpoints else ""
    return [m for m in task.edit_marks if m.checkpoint == last]


def view_for(
    cwd: Path,
    marks: list[EditMark],
    turn: list[EditMark],
    which: str,
    *,
    base: str = "",
    scoped: bool = True,
    branch_into: str = "",
) -> View | None:
    """A session's changes as one of the Changes pane's views: "turn" (what its latest turn
    did), "session" (everything it did) or "branch" (everything on this branch that isn't
    on the branch it goes back into, anyone's, plus the work not committed yet). Numbers
    are always the session view's, so "change 3" is the same hunk in every view; with
    nothing of its own yet (its changes came from commands, say), the branch's."""
    session, head = _session_view(cwd, marks, base=base, scoped=scoped)
    if session is None:
        return None
    # The branch's own view, for the branch view alone: a session or turn view with nothing
    # of the session's own has no files, so none of its hunks takes a number from the
    # branch's (making it anyway cost a dozen gits and a whole diff after every step of a
    # session that has committed its work, or has only run commands).
    # (An isolated copy's session view is the whole diff from its start: when the branch's
    # fork is that same commit, the branch view is that same diff, not a second one.)
    same = None if scoped else session
    branch = (
        branch_view(session.repo, branch_into, head=head, same=same)
        if which not in ("session", "turn")
        else None
    )
    numbers = session.numbers if session.files or branch is None else branch.numbers
    if which == "session":
        return View(session.repo, session.base, session.files, numbers)
    if which == "turn":
        files = scope(session.files, turn, session.repo.top)
        return View(session.repo, session.base, files, numbers)
    branch = branch or branch_view(session.repo, branch_into, head=head, same=same)
    return View(branch.repo, branch.base, branch.files, numbers)


def branch_view(
    repo: Repo, into: str = "", *, head: str | None = None, same: View | None = None
) -> View:
    """Everything on this branch that isn't on the one it goes into (anyone's), plus the
    work not committed yet: on that branch itself, just the uncommitted work. head: HEAD's
    commit when the caller has just read it (None: read here). same: a whole (unscoped)
    view of this checkout just made; when its base is the branch's fork, its files are
    the branch's and the diff isn't made twice."""
    into = into or default_branch(repo.top)
    head = head_commit(repo.top) if head is None else head
    fork = merge_base(repo.top, head, into) if into and head else ""
    base = fork or head or EMPTY_TREE
    if same is not None and same.repo.top == repo.top and same.base == base:
        files = same.files
    else:
        files = spoken_order(diff_files(repo, base))
    return View(repo, base, files, number(files))


def numbered_view(task: Any) -> View | None:
    """The view "change 3" counts in: the session's own changes, or with none yet, the
    branch's (the same numbers the Changes pane shows)."""
    view = task_view(task, "session")
    if view is None or view.files:
        return view
    return task_view(task, "branch")


def task_view(task: Any, which: str = "session") -> View | None:
    """A session's view: in its isolated copy (task.workspace), everything since the copy's
    start; in a shared folder, only the hunks its own edits made."""
    ws = getattr(task, "workspace", None) or {}
    return view_for(
        task.cwd,
        list(task.edit_marks),
        turn_marks(task),
        which,
        base=ws.get("base", ""),
        scoped=not ws,
        branch_into=ws.get("into", ""),
    )


def undo_file(task: Any, path: str) -> str:
    """Undo a session's own hunks in one file (the old whole-file Revert, made safe): the
    other hunks in it, the owner's or another session's, stay. Returns what to say."""
    view = task_view(task)
    if view is None:
        return "This folder isn't a git repository."
    target = next((f for f in view.files if readable(view.repo.shown(f.path)) == path), None)
    if target is None:
        repo_changed = any(
            readable(view.repo.shown(f.path)) == path for f in diff_files(view.repo, view.base)
        )
        if repo_changed:
            return (
                f"None of the changes in {path} are this session's own edits; undo them one "
                "change at a time in the Changes pane."
            )
        return f"{path or 'That file'} has no changes to revert."
    if target.new:
        return f"{path} is a new file; delete it yourself if you don't want it."
    if target.sensitive or target.binary or not target.hunks:
        return f"{path} can't be undone a change at a time here."
    # Bottom to top: undoing one never moves the lines of the ones above it.
    against_head = view.base == head_commit(view.repo.top)
    for h in sorted(target.hunks, key=lambda h: -h.new_start):
        problem = undo_hunk(view.repo, target, h, against_head=against_head)
        if problem:
            return problem
    count = len(target.hunks)
    return f"Undid this session's {count} change{'s' if count != 1 else ''} in {path}."
