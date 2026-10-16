"""Rewind for other agents over ACP (acp.AcpClient, features/code_acp.py): Eden takes a
snapshot of the session's working tree just before each of the owner's messages is sent to
the agent, and another when the turn ends, so Rewind and Undo put the files back for Codex,
Gemini CLI or OpenCode just as Claude Code's own file checkpoints do for a Claude session.

An ACP agent edits files with its own tools, out of Eden's sight, and the protocol has no
"put the files back". So Eden keeps the files itself, in git, where they already live:

- A snapshot is a commit object made with a throwaway index (a copy of the repo's own, so
  only files that changed are read again): `git add -A` into it, `git write-tree`,
  `git commit-tree`. The owner's index, HEAD, branches and stash are never touched: no
  `git stash` (its stack is shared with every other checkout and session), no checkout.
- It is kept from git's garbage collection by a hidden ref, refs/eden/acp/<key>/before
  (and …/after for the turn's end), which no branch list, log or push shows. The last
  KEPT turns' refs are kept per repository; older ones go.
- Only the session's own folder is read into a snapshot (the rest of the tree is as the
  owner's index has it), so a session in one folder of a big repository reads only that
  folder, and only changes there count as the turn's.
- The files a turn changed are the difference between its two snapshots. A rewind to
  before a message puts back exactly the files the turns since then changed, each as it
  was in that message's "before" snapshot (a file that wasn't there then is removed), and
  leaves every other file alone: the owner's own edits between turns stay.
- Ignored files (.gitignore) are neither kept nor put back: build output, node_modules and
  secrets in .env stay out of the snapshots, as git keeps them out of commits.

What it can't do: a folder that isn't in a git repository has no snapshots (Rewind says
so); a file someone else changed in the same folder during the agent's turn counts as that
turn's, since a snapshot can't tell who changed it.

Cost policy (Claude): no model is called here. Only git, on the owner's Mac.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger("jarvis")

REF_ROOT = "refs/eden/acp/"
KEPT = 200  # turns' snapshots kept per repository (Eden keeps 50 checkpoints a session)
TIMEOUT = 120.0  # seconds for one git command
SNAPSHOT_TIMEOUT = 30.0  # ... for reading the folder into a snapshot: the turn waits for it,
# so a folder too big to read in time (a home folder kept in git) goes on without one
_IDENT = {
    "GIT_AUTHOR_NAME": "Eden Code",
    "GIT_AUTHOR_EMAIL": "eden-code@localhost",
    "GIT_COMMITTER_NAME": "Eden Code",
    "GIT_COMMITTER_EMAIL": "eden-code@localhost",
}


class CheckpointError(Exception):
    """A snapshot couldn't be taken or put back; the message says why, for the owner."""


def _git(
    where: str | Path,
    *args: str,
    env: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: float = TIMEOUT,
) -> str:
    try:
        done = subprocess.run(
            ["git", "-c", "core.quotepath=off", *args],
            cwd=str(where),
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})},
            input=data,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CheckpointError(f"git couldn't run ({exc})") from exc
    if done.returncode != 0:
        said = done.stderr.decode("utf-8", "replace").strip().splitlines()
        raise CheckpointError(said[-1][:300] if said else f"git {args[0]} failed")
    return done.stdout.decode("utf-8", "surrogateescape")


def repo_top(cwd: str | Path) -> Path | None:
    """The top of the git working tree a folder is in (None: it isn't in one)."""
    try:
        top = _git(cwd, "rev-parse", "--show-toplevel").strip()
    except CheckpointError:
        return None
    return Path(top) if top else None


def _scope(top: Path, cwd: str | Path) -> str:
    """The session's folder as a pathspec from the top ("." when it is the top): snapshots
    read, and changes are found, only there; the rest of the tree is the index's."""
    rel = os.path.relpath(os.path.realpath(cwd), os.path.realpath(top))
    return "." if rel in (".", "") or rel.startswith("..") else rel


def ref_for(uuid: str, part: str) -> str:
    """The hidden ref for one turn's snapshot (part: before | after). The message's id is
    the agent's words (its session id among them), so it's hashed into a ref-safe name."""
    key = hashlib.sha1(uuid.encode("utf-8", "replace")).hexdigest()[:24]
    return f"{REF_ROOT}{key}/{part}"


def snapshot(cwd: str | Path, label: str) -> str:
    """A commit of the working tree as it is now (tracked and untracked files, less the
    ignored ones), made without touching the owner's index or branches; its id."""
    top = repo_top(cwd)
    if top is None:
        raise CheckpointError("the folder isn't in a git repository")
    with tempfile.TemporaryDirectory(prefix="eden-acp-") as tmp:
        index = Path(tmp) / "index"
        own = Path(_git(top, "rev-parse", "--path-format=absolute", "--git-path", "index").strip())
        if own.is_file():  # (its file stats: only what changed is read again)
            with contextlib.suppress(OSError):
                shutil.copyfile(own, index)
        env = {"GIT_INDEX_FILE": str(index), **_IDENT}
        _git(top, "add", "-A", "--", _scope(top, cwd), env=env, timeout=SNAPSHOT_TIMEOUT)
        tree = _git(top, "write-tree", env=env).strip()
        parents: list[str] = []
        with contextlib.suppress(CheckpointError):  # (a repo with no commit yet: none)
            parents = ["-p", _git(top, "rev-parse", "--verify", "-q", "HEAD").strip()]
        made = _git(top, "commit-tree", "--no-gpg-sign", tree, *parents, "-m", label[:200], env=env)
        return made.strip()


def keep(cwd: str | Path, ref: str, commit: str) -> None:
    """Keep a snapshot under its hidden ref, and let the oldest ones go past KEPT turns."""
    top = repo_top(cwd)
    if top is None:
        return
    _git(top, "update-ref", ref, commit)
    with contextlib.suppress(CheckpointError):
        refs = _git(
            top, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", REF_ROOT
        ).split()
        turns = list(dict.fromkeys(r.rsplit("/", 1)[0] for r in refs))
        old = [r for r in refs if r.rsplit("/", 1)[0] in set(turns[KEPT:])]
        if old:
            _git(top, "update-ref", "--stdin", data="".join(f"delete {r}\n" for r in old).encode())


def find(cwd: str | Path, ref: str) -> str:
    """The snapshot a hidden ref keeps ("": none)."""
    top = repo_top(cwd)
    if top is None:
        return ""
    try:
        return _git(top, "rev-parse", "--verify", "-q", ref + "^{commit}").strip()
    except CheckpointError:
        return ""


def drop(cwd: str | Path, refs: list[str]) -> None:
    """Let some turns' snapshots go (a rewind put their changes back)."""
    top = repo_top(cwd)
    if top is None or not refs:
        return
    with contextlib.suppress(CheckpointError):
        _git(top, "update-ref", "--stdin", data="".join(f"delete {r}\n" for r in refs).encode())


def changed(cwd: str | Path, before: str, after: str) -> list[str]:
    """The files that differ between two snapshots, as absolute paths."""
    top = repo_top(cwd)
    if top is None or not before or not after or before == after:
        return []
    out = _git(
        top, "diff-tree", "-r", "-z", "--no-renames", "--name-only", before, after,
        "--", _scope(top, cwd),
    )  # fmt: skip
    return [str(top / p) for p in out.split("\0") if p]


def _inside(top: Path, path: str) -> Path | None:
    """A path a rewind may write, as one under the working tree's top (None: it isn't)."""
    full = Path(path) if os.path.isabs(path) else top / path
    try:
        rel = full.relative_to(top)
    except ValueError:
        return None
    if not rel.parts or ".." in rel.parts or rel.parts[0] == ".git":
        return None
    parent = Path(os.path.realpath(full.parent))
    real_top = Path(os.path.realpath(top))
    if parent != real_top and real_top not in parent.parents:
        return None  # (a folder that's a link out of the project: never written through)
    return full


def restore(cwd: str | Path, commit: str, paths: list[str]) -> list[str]:
    """Put these files back as they were in a snapshot: each one it had is written out as it
    was, each one it didn't have is removed (unless git ignores it: an ignored file was never
    kept, so its absence says nothing). Every other file is left alone. Returns the files
    put back (relative to the top)."""
    top = repo_top(cwd)
    if top is None:
        raise CheckpointError("the folder isn't in a git repository")
    wanted: dict[str, Path] = {}
    for path in paths:
        full = _inside(top, path)
        if full is not None:
            wanted[full.relative_to(top).as_posix()] = full
    if not wanted:
        return []
    listed = _git(top, "ls-tree", "-r", "-z", "--name-only", commit, "--", *wanted)
    had = {p for p in listed.split("\0") if p}
    gone = sorted(set(wanted) - had)
    if gone:  # an ignored file (.env, build output) was never kept: it's never removed
        try:
            out = _git(top, "check-ignore", "-z", "--stdin", data="\0".join(gone).encode())
        except CheckpointError:  # (exit 1: none of them is ignored)
            out = ""
        for rel in out.split("\0"):
            wanted.pop(rel, None)
    with tempfile.TemporaryDirectory(prefix="eden-acp-") as tmp:
        env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
        if had:
            _git(top, "read-tree", commit, env=env)
            for rel in had:  # (a folder where a file was: it goes first)
                spot = wanted[rel]
                if spot.is_dir() and not spot.is_symlink():
                    shutil.rmtree(spot)
            _git(
                top, "checkout-index", "-f", "-z", "--stdin", env=env,
                data="\0".join(sorted(had)).encode("utf-8", "surrogateescape"),
            )  # fmt: skip
    for rel, spot in wanted.items():
        if rel in had:
            continue
        with contextlib.suppress(FileNotFoundError):
            if spot.is_dir() and not spot.is_symlink():
                shutil.rmtree(spot)
            else:
                spot.unlink()
        folder = spot.parent  # (folders it left empty go too, up to the top)
        while folder != top and top in folder.parents:
            try:
                folder.rmdir()
            except OSError:
                break
            folder = folder.parent
    return sorted(wanted)
