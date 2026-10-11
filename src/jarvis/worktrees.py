"""Isolated copies: an Eden Code session in a git worktree of its own.

Two sessions in one project folder edit the same files under each other. A session can
instead work in its own copy of the project: a git worktree on a branch of its own
(jarvis/<slug>), made from the folder's current commit and kept outside the project,
beside JARVIS's settings (<Application Support>/Jarvis/worktrees/<project>/<slug>/). The
copy's own folder keeps the project's name, so everything that names a session's folder
still names the project.

Nothing the session does there touches the main folder until it's landed: its work is
committed on its branch and merged back into the branch the copy came from (a fast-forward
when nothing else landed meanwhile, else a merge commit made without touching any working
tree; a conflict changes nothing and goes back to the session). Discarding keeps the whole
of it, uncommitted work included, as refs/jarvis/trash/<slug> for 30 days.

The sweeper removes only copies that are provably spent: no session in them, nothing
uncommitted and their branch already part of the branch they land in. Anything else is
listed, with Land and Discard, and never deleted on its own. (The owner once lost work to
stale worktrees.)

Dependencies: a new copy has no node_modules or .venv. With the project's opt-in they're
linked from the main folder instead of installed again, which is fast but shared: adding
or upgrading a package in the copy changes the main folder's too. Credentials (.env files)
are copied only with the project's own opt-in, and only when git ignores them in the copy,
so they can never be committed from it.

Every function here runs git with a timeout and is called off the event loop.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from . import code_changes
from .code_changes import git

BRANCH_PREFIX = "jarvis/"
TRASH_PREFIX = "refs/jarvis/trash/"
TRASH_DAYS = 30
CREATE_SECONDS = 300.0  # checking out a big repository takes a while
# A copy whose folder was made this long ago and still isn't on the list never will be (its
# session went away while it was made): the sweeper may take it in then.
MAKING_SECONDS = 2 * CREATE_SECONDS
MAX_COPIES = 60  # copies kept on the list (a runaway, past this, is refused)
ENV_FILES = 30
ENV_BYTES = 1_000_000
_ENV_NAME = re.compile(r"\.env(\.[\w.-]+)?")  # .env, .env.local… (never .envrc: it runs code)
LINKABLE = ("node_modules", ".venv")
# Who a recovery snapshot is by, when the repository names no one.
_SNAPSHOT_ID = {
    "GIT_AUTHOR_NAME": "Eden Code",
    "GIT_AUTHOR_EMAIL": "jarvis-code@localhost",
    "GIT_COMMITTER_NAME": "Eden Code",
    "GIT_COMMITTER_EMAIL": "jarvis-code@localhost",
}


class CopyError(Exception):
    """Why a copy couldn't be made, landed or discarded, in words for the owner."""


@dataclass
class Copy:
    slug: str
    project: str  # the project's folder name
    repo: str  # the main checkout's root
    prefix: str  # the project's folder inside it ("" at its root, else "sub/dir/")
    checkout: str  # the copy's root
    branch: str  # jarvis/<slug>
    base: str  # the commit it started from
    into: str  # the branch it lands in
    title: str = ""
    created: float = 0.0
    sessions: list[str] = field(default_factory=list)  # Claude Code sessions that ran in it
    group: str = ""  # a best-of-N run it belongs to
    label: str = ""  # its variant in that run ("Sonnet 5.5 · high")

    @property
    def cwd(self) -> Path:
        return Path(self.checkout) / self.prefix

    @property
    def folder(self) -> Path:
        """Its own folder under the worktrees root (the checkout is inside it)."""
        return Path(self.checkout).parent

    def public(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "project": self.project,
            "branch": self.branch,
            "into": self.into,
            "base": self.base[:12],
            "title": self.title[:200],
            "created": self.created,
            "group": self.group,
            "label": self.label,
            "path": str(self.cwd),
        }


_COPY_FIELDS = {f.name for f in fields(Copy)}


def _copy_from(raw: Any) -> Copy | None:
    """A kept copy, read defensively: a hand edit or another build's record is skipped."""
    if not isinstance(raw, dict):
        return None
    try:
        data = {k: v for k, v in raw.items() if k in _COPY_FIELDS}
        copy = Copy(**data)
    except TypeError:
        return None
    text = (copy.slug, copy.project, copy.repo, copy.checkout, copy.branch, copy.base, copy.into)
    if not all(isinstance(v, str) and v for v in text) or not isinstance(copy.prefix, str):
        return None
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", copy.slug):
        return None
    if not isinstance(copy.sessions, list):
        copy.sessions = []
    copy.sessions = [s for s in copy.sessions if isinstance(s, str)][-20:]
    if not isinstance(copy.created, int | float):
        copy.created = 0.0
    return copy


class CopyStore:
    """The copies and what was discarded, in <root>/copies.json. A file that can't be read
    is never saved over (jsonstore keeps a damaged one aside and reads its last good copy)."""

    def __init__(self, path: Path) -> None:
        from . import jsonstore

        self.path = path
        self.copies: list[Copy] = []
        self.trash: list[dict[str, Any]] = []
        self.unreadable = ""
        # Copies being made just now (slug -> when, time.monotonic()), from before their
        # folder is until the feature has them on the list: the sweeper, in its thread,
        # never takes one in as a copy the list lost.
        self.making: dict[str, float] = {}
        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            data = {}
        for raw in data.get("copies") or []:
            copy = _copy_from(raw)
            if copy is not None and self.find(copy.slug) is None:
                self.copies.append(copy)
        for item in data.get("trash") or []:
            if isinstance(item, dict) and all(
                isinstance(item.get(k), str) and item.get(k) for k in ("slug", "repo", "ref")
            ):
                self.trash.append(item)

    def save(self) -> None:
        from . import jsonstore

        if self.unreadable:
            return
        jsonstore.save_json(
            self.path, {"copies": [asdict(c) for c in self.copies], "trash": self.trash[-200:]}
        )

    def find(self, slug: str) -> Copy | None:
        return next((c for c in self.copies if c.slug == slug), None)

    def by_path(self, path: Path | str) -> Copy | None:
        """The copy a folder is (its session folder), if it's one."""
        try:
            wanted = Path(path).resolve()
        except OSError:
            return None
        for copy in self.copies:
            with contextlib.suppress(OSError):
                if copy.cwd.resolve() == wanted:
                    return copy
        return None

    def by_session(self, session_id: str) -> Copy | None:
        return next((c for c in self.copies if session_id and session_id in c.sessions), None)

    def slugs(self) -> set[str]:
        return {c.slug for c in self.copies} | {str(t.get("slug")) for t in self.trash}


# ── making one ──


def slug_for(title: str, taken: set[str]) -> str:
    """A short, readable, unique name: the request's first words and four hex digits."""
    words = re.findall(r"[a-z0-9]+", title.lower())[:5]
    stem = "-".join(words)[:32].strip("-") or "session"
    for _ in range(50):
        slug = f"{stem}-{secrets.token_hex(2)}"
        if slug not in taken:
            return slug
    return f"{stem}-{secrets.token_hex(6)}"


def create(
    project_dir: Path,
    root: Path,
    title: str,
    *,
    taken: set[str],
    copy_env: bool = False,
    link_deps: bool = False,
    making: dict[str, float] | None = None,
) -> tuple[Copy, list[str]]:
    """A new copy of the project at its current commit, on a branch of its own. Returns the
    copy and notes for the owner (what was linked or copied, and what wasn't and why).
    making: the store's copies being made; this one is in it from before its folder is
    (the caller takes it out once the copy is on the list), unless it couldn't be made."""
    project = project_dir.name
    repo = code_changes.repo_of(project_dir)
    if repo is None:
        raise CopyError(f"{project} isn't a git repository, so it can't have an isolated copy.")
    head = code_changes.head_commit(repo.top)
    if not head:
        raise CopyError(f"{project} has no commits yet, so there's nothing to copy.")
    into = git(repo.top, "symbolic-ref", "-q", "--short", "HEAD").out.strip()
    if not into:
        raise CopyError(
            f"{project} is on a detached HEAD, so a copy would have no branch to land in."
        )
    branches = git(repo.top, "for-each-ref", "--format=%(refname:short)", "refs/heads/jarvis/")
    slug = slug_for(title, taken | {b.removeprefix(BRANCH_PREFIX) for b in branches.out.split()})
    folder = root / project / slug
    checkout = folder / repo.top.name
    if making is not None:
        making[slug] = time.monotonic()
    try:
        folder.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        _not_making(making, slug)
        raise CopyError(f"Couldn't make a folder for the copy: {exc.strerror or exc}") from exc
    branch = BRANCH_PREFIX + slug
    # Its files written by one worker per core (git's parallel checkout, the same files as
    # one at a time): 20,000 files took 1.0-1.6 s instead of 1.8-2.2 s, and far longer one at
    # a time on a busy Mac. A git too old for it ignores the setting.
    made = git(
        repo.top,
        *("-c", "checkout.workers=0"),
        *("worktree", "add", "-b", branch, str(checkout), head),
        timeout=CREATE_SECONDS,
    )
    if not made.ok:
        shutil.rmtree(folder, ignore_errors=True)
        _not_making(making, slug)
        why = (made.err.strip().splitlines() or ["git refused"])[-1][:300]
        raise CopyError(f"Couldn't make an isolated copy of {project}: {why}")
    copy = Copy(
        slug=slug,
        project=project,
        repo=str(repo.top),
        prefix=repo.prefix,
        checkout=str(checkout),
        branch=branch,
        base=head,
        into=into,
        title=" ".join(title.split())[:200],
        created=time.time(),
    )
    notes: list[str] = []
    if copy_env:
        notes += copy_env_files(repo, copy)
    if link_deps:
        notes += link_dependencies(repo, copy)
    return copy, notes


def _not_making(making: dict[str, float] | None, slug: str) -> None:
    if making is not None:
        making.pop(slug, None)


def _ignored(checkout: Path, rel: str) -> bool:
    # (check-ignore takes paths, not pathspecs: literal pathspecs would make it refuse.)
    found = git(
        checkout, "check-ignore", "-q", "--no-index", "--", rel, env={"GIT_LITERAL_PATHSPECS": "0"}
    )
    return found.code == 0


def copy_env_files(repo: code_changes.Repo, copy: Copy) -> list[str]:
    """The project's .env files, into the copy: only ones git ignores (so the copy can never
    commit them), never read here, links kept as links."""
    listed = git(
        repo.top,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
        "--",
        repo.prefix or ".",
    )
    names = [p for p in listed.out.split("\0") if p and not p.endswith("/")]
    envs = [p for p in names if _ENV_NAME.fullmatch(Path(p).name)][:ENV_FILES]
    copied: list[str] = []
    for rel in envs:
        source, target = repo.top / rel, Path(copy.checkout) / rel
        try:
            if not source.is_symlink() and source.stat().st_size > ENV_BYTES:
                continue
            if target.exists() or target.is_symlink():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target, follow_symlinks=False)
        except OSError:
            continue
        if not _ignored(Path(copy.checkout), rel):
            target.unlink(missing_ok=True)  # it could be committed from here: not copied
            continue
        copied.append(repo.shown(rel))
    if not copied:
        return []
    return [f"Copied {', '.join(copied[:6])} from the main folder (they stay out of git)."]


def link_dependencies(repo: code_changes.Repo, copy: Copy) -> list[str]:
    """node_modules and .venv from the main folder, as links: nothing to install again,
    but shared (a package added or upgraded in the copy changes the main folder's too). A
    link git would see as a new file isn't made: node_modules then goes one folder above
    the copy, where Node still finds it; .venv isn't linked."""
    notes: list[str] = []
    main = repo.top / repo.prefix
    here = copy.cwd
    for name in LINKABLE:
        source, target = main / name, here / name
        if not source.is_dir() or target.exists() or target.is_symlink():
            continue
        try:
            target.symlink_to(source, target_is_directory=True)
        except OSError:
            continue
        if _ignored(Path(copy.checkout), f"{copy.prefix}{name}"):
            notes.append(f"Linked {name} from the main folder (shared with it).")
            continue
        target.unlink(missing_ok=True)
        if name == "node_modules":
            above = copy.folder / name
            with contextlib.suppress(OSError):
                above.symlink_to(source, target_is_directory=True)
                notes.append("Linked node_modules from the main folder (shared with it).")
                continue
        notes.append(f"{name} isn't linked: git would see the link as a new file.")
    return notes


# ── what a copy holds ──


@dataclass
class State:
    exists: bool  # its folder is there
    branch: bool  # its branch is there
    dirty: int  # files changed and not committed (untracked ones too)
    ahead: int  # commits on its branch the branch it lands in doesn't have
    merged: bool  # everything on its branch is in the branch it lands in
    files: int = 0
    added: int = 0
    removed: int = 0

    @property
    def spent(self) -> bool:
        """Nothing in it that isn't already landed: safe to remove."""
        return self.dirty == 0 and (self.merged or not self.branch)

    def public(self) -> dict[str, Any]:
        return asdict(self) | {"spent": self.spent}


def status_entries(out: str) -> list[tuple[str, str]]:
    """git status --porcelain -z as (XY, path) pairs (a rename's old name, which -z puts in
    a field of its own, is skipped)."""
    fields_ = out.split("\0")
    entries: list[tuple[str, str]] = []
    i = 0
    while i < len(fields_):
        entry = fields_[i]
        i += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        entries.append((code, path))
        if code[0] in "RC":
            i += 1
    return entries


def _rev(repo: Path | str, ref: str) -> str:
    found = git(repo, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}")
    return found.out.strip() if found.ok else ""


def _is_ancestor(repo: Path | str, a: str, b: str) -> bool:
    return bool(a and b) and git(repo, "merge-base", "--is-ancestor", a, b).code == 0


def _heads(repo: str, *branches: str) -> dict[str, str]:
    """Branch name -> its commit, for those that exist (one git call for all of them)."""
    refs = [f"refs/heads/{b}" for b in branches]
    listed = git(repo, "for-each-ref", "--format=%(refname)%00%(objectname)", *refs)
    out: dict[str, str] = {}
    for line in listed.out.splitlines():
        ref, _, sha = line.partition("\0")
        if ref.startswith("refs/heads/") and ref in refs:
            out[ref.removeprefix("refs/heads/")] = sha
    return out


def _names(files: list[str]) -> str:
    """Up to five names, and how many more."""
    return ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")


def _git_dir(checkout: Path | str) -> Path | None:
    """A checkout's own git folder (a copy's is under the repository's .git/worktrees/)."""
    found = git(checkout, "rev-parse", "--path-format=absolute", "--git-dir")
    text = found.out.strip()
    return Path(text) if found.ok and text else None


_UNDER_WAY = (
    ("MERGE_HEAD", "a merge"),
    ("CHERRY_PICK_HEAD", "a cherry-pick"),
    ("REVERT_HEAD", "a revert"),
    ("rebase-merge", "a rebase"),
    ("rebase-apply", "a rebase"),
)


def under_way(gitdir: Path) -> str:
    """What a checkout (by its own git folder) is in the middle of: "a merge", "a
    cherry-pick", "a revert" or "a rebase"; "" when nothing."""
    for name, what in _UNDER_WAY:
        if (gitdir / name).exists():
            return what
    return ""


def _dirty(checkout: Path, env: dict[str, str] | None = None) -> list[str]:
    """What in a checkout isn't in its index as it is on disk, or not committed (env: with
    another index): its paths, ["(git status failed)"] when git couldn't say."""
    status = git(checkout, "status", "--porcelain", "-z", "--untracked-files=all", env=env)
    if not status.ok:
        return ["(git status failed)"]
    return [path for _code, path in status_entries(status.out)]


def _untracked_repos(checkout: Path) -> list[str]:
    """Folders in a checkout that are git repositories of their own and not part of it: git
    lists each as one entry ending in "/" (add -A would keep only a link to it, and its
    files would go with the copy)."""
    listed = git(checkout, "ls-files", "--others", "--exclude-standard", "-z", timeout=120)
    return [p.rstrip("/") for p in listed.out.split("\0") if p.endswith("/")]


def _new_gitlinks(
    checkout: Path, since: str, *, cached: bool = False, env: dict[str, str] | None = None
) -> list[str]:
    """Links to other repositories (gitlinks) added since `since` that the checkout's
    .gitmodules doesn't declare: the repository they name lives only inside the copy.
    Committed ones (HEAD), or with cached the ones in the (env's) index."""
    args = ["diff", "--raw", "-z", "--no-renames", "--no-abbrev"]
    args += ["--cached", since] if cached else [since, "HEAD"]
    found = git(checkout, *args, env=env, timeout=60)
    fields_ = found.out.split("\0")
    added: list[str] = []
    for i in range(0, len(fields_) - 1, 2):
        meta = fields_[i].lstrip(":").split()
        if len(meta) >= 2 and meta[1] == "160000" and meta[0] != "160000":
            added.append(fields_[i + 1])
    if not added:
        return []
    declared = git(checkout, "config", "-f", ".gitmodules", "--get-regexp", r"\.path$")
    paths = {line.split(" ", 1)[1] for line in declared.out.splitlines() if " " in line}
    return [p for p in added if p not in paths]


_MARKER = ": leftover conflict marker"


def conflict_markers(checkout: Path, since: str) -> list[str]:
    """Files whose lines added since `since` (committed or not) hold both a <<<<<<< and a
    >>>>>>> conflict marker line: a merge's conflicts staged as they were. (A lone =======
    is a Markdown heading's underline as often as a marker.)"""
    found = git(checkout, "diff", "--check", since, timeout=120)
    if found.code == 0:
        return []
    flagged: dict[str, set[int]] = {}
    for line in found.out.splitlines():
        if not line.endswith(_MARKER):
            continue
        where, _, number = line[: -len(_MARKER)].rpartition(":")
        if number.isdigit() and where:
            where = code_changes._unquote(where) if where.startswith('"') else where
            flagged.setdefault(where, set()).add(int(number))
    files: list[str] = []
    for rel, numbers in list(flagged.items())[:50]:
        try:
            lines = (checkout / rel).read_bytes().split(b"\n")
        except OSError:
            continue
        kinds = {lines[n - 1][:7] for n in numbers if 0 < n <= len(lines)}
        if b"<<<<<<<" in kinds and b">>>>>>>" in kinds:
            files.append(rel)
    return files


def _not_ready(copy: Copy, fork: str) -> str:
    """Why the copy can't be landed as it is ("" when it can): a merge, rebase, cherry-pick
    or revert half done in it, conflicts or their markers left, its HEAD off its branch, or
    a git repository of its own inside it."""
    checkout = Path(copy.checkout)
    listed = git(checkout, "ls-files", "-u", "-z")
    unmerged = sorted({e.split("\t", 1)[1] for e in listed.out.split("\0") if "\t" in e})
    if unmerged:
        return (
            f"The copy has unresolved conflicts in {_names(unmerged)}; resolve and commit "
            "them (or use Resolve in session), then land."
        )
    gitdir = _git_dir(checkout)
    what = under_way(gitdir) if gitdir is not None else ""
    if what:
        return f"The copy is in the middle of {what}; finish it (or use Resolve in session), then land."
    on = git(checkout, "symbolic-ref", "-q", "HEAD").out.strip()
    if on != f"refs/heads/{copy.branch}":
        if on.startswith("refs/heads/"):
            other = on.removeprefix("refs/heads/")
            return (
                f"The copy is on {other}, not {copy.branch}; switch it back (git switch "
                f"{copy.branch}), then land."
            )
        return (
            f"The copy isn't on its branch {copy.branch} (its HEAD is detached); put its "
            f"commits back on {copy.branch}, then land."
        )
    nested = _untracked_repos(checkout)
    if nested:
        return (
            f"{_names(nested)} is a git repository of its own inside the copy, so landing "
            "would keep only a link to it. Remove its .git folder (or add it as a submodule), "
            "then land."
        )
    markers = conflict_markers(checkout, fork) if fork else []
    if markers:
        return f"Conflict markers are left in {_names(markers)}; resolve them, then land."
    return ""


def _lines_in(path: Path) -> int:
    """How many lines a new file adds (a big or unreadable one: none counted)."""
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1_000_000:
            return 0
        data = path.read_bytes()
    except OSError:
        return 0
    if b"\0" in data[:8000]:
        return 0
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


def state(copy: Copy) -> State:
    checkout = Path(copy.checkout)
    exists = checkout.is_dir() and (checkout / ".git").exists()
    heads = _heads(copy.repo, copy.branch, copy.into)
    head, tip = heads.get(copy.branch, ""), heads.get(copy.into, "")
    dirty = files = added = removed = 0
    if exists:
        status = git(checkout, "status", "--porcelain", "-z", "--untracked-files=all")
        entries = status_entries(status.out) if status.ok else [("??", "")]
        dirty = len(entries)
        stat = git(checkout, "diff", "--numstat", "-z", copy.base)
        for entry in stat.out.split("\0"):
            parts = entry.split("\t")
            if len(parts) >= 3 and parts[0]:
                files += 1
                added += int(parts[0]) if parts[0].isdigit() else 0
                removed += int(parts[1]) if parts[1].isdigit() else 0
        for code, path in entries[:500]:
            if code == "??" and path:
                files += 1
                added += _lines_in(checkout / path)
    ahead = 0
    if head and tip:
        counted = git(copy.repo, "rev-list", "--count", f"{tip}..{head}")
        ahead = int(counted.out.strip() or 0) if counted.ok else 1
    # Everything on its branch is in the branch it lands in exactly when nothing is ahead.
    merged = not head or (bool(tip) and ahead == 0)
    return State(exists, bool(head), dirty, ahead, merged, files, added, removed)


# ── landing it ──


@dataclass
class Landed:
    ok: bool
    message: str
    conflicts: list[str] = field(default_factory=list)
    commit: str = ""
    fast_forward: bool = False


def commit_all(copy: Copy, message: str) -> str:
    """Commit everything in the copy (new files too, never ignored ones). "" when done or
    there was nothing to commit, else why not (a hook said no, git knows no author…)."""
    checkout = Path(copy.checkout)
    status = git(checkout, "status", "--porcelain", "-z", "--untracked-files=all")
    if status.ok and not status_entries(status.out):
        return ""
    added = git(checkout, "add", "-A")
    if not added.ok:
        return f"Couldn't stage the copy's work: {added.err.strip()[:300]}"
    done = git(checkout, *code_changes.OWN_IDENTITY, "commit", "-q", "-m", message, timeout=120)
    if done.ok:
        return ""
    why = (done.err or done.out).strip()
    if "Please tell me who you are" in why or "empty ident" in why:
        return "git doesn't know who's committing here: set user.name and user.email first."
    return f"Couldn't commit the copy's work: {why[:400]}"


def _holder(repo: str, branch: str) -> str:
    """The checkout that has branch checked out (the main folder, usually), or ""."""
    listed = git(repo, "worktree", "list", "--porcelain")
    current = ""
    for line in listed.out.splitlines():
        if line.startswith("worktree "):
            current = line[9:]
        elif line == f"branch refs/heads/{branch}":
            return current
    return ""


def _busy_with(repo: str, branch: str) -> str:
    """What a checkout of the repository is in the middle of on branch, "rebase" or
    "bisect" (it shows as detached then, so _holder doesn't find it), else "". Moving the
    branch under it would break it: git rebase --continue can't lock the ref any more."""
    common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").out.strip()
    if not common:
        return ""
    root = Path(common)
    linked = root / "worktrees"
    try:
        dirs = [root, *(d for d in linked.iterdir() if d.is_dir())] if linked.is_dir() else [root]
    except OSError:
        dirs = [root]
    ref = f"refs/heads/{branch}"
    for gitdir in dirs:
        for name in ("rebase-merge/head-name", "rebase-apply/head-name"):
            with contextlib.suppress(OSError):
                if (gitdir / name).read_text(errors="replace").strip() == ref:
                    return "rebase"
        with contextlib.suppress(OSError):
            if (gitdir / "BISECT_START").read_text(errors="replace").strip() in (branch, ref):
                return "bisect"
        # A merge, cherry-pick or revert half done where the branch is checked out: "a
        # merge"… (said plainly, not with git's hints).
        with contextlib.suppress(OSError):
            if (gitdir / "HEAD").read_text(errors="replace").strip() == f"ref: {ref}":
                what = under_way(gitdir)
                if what and what != "a rebase":
                    return what
    return ""


def overwritten_files(err: str) -> list[str]:
    """The files git names when a merge would overwrite local changes."""
    names: list[str] = []
    grab = False
    for line in err.splitlines():
        if "would be overwritten" in line:
            grab = True
            continue
        if grab and line.startswith(("\t", "    ")):
            names.append(line.strip())
        elif grab:
            grab = False
    return names


def land(copy: Copy, message: str) -> Landed:
    """Commit what's left in the copy, then bring its branch into the branch it came from:
    a fast-forward when nothing landed there meanwhile, else a merge commit written
    straight to the branch (no working tree is touched to make it). A conflict leaves
    everything as it was and names the files. The branch is moved only if nobody moved it
    meanwhile, and where it's checked out (the main folder), only when its own uncommitted
    changes are in files the landing doesn't touch. Nothing is committed or landed while the
    copy is half way through a merge (or rebase, cherry-pick, revert), has conflicts or
    their markers left, isn't on its own branch, or holds a git repository of its own; and
    nothing is landed when files in it changed while it was being committed."""
    checkout = Path(copy.checkout)
    if checkout.is_dir():
        fork = code_changes.merge_base(checkout, "HEAD", f"refs/heads/{copy.into}") or copy.base
        problem = _not_ready(copy, fork) or commit_all(copy, message)
        if problem:
            return Landed(False, problem)
        changed = _dirty(checkout)
        if changed:
            return Landed(
                False,
                f"Files in the copy changed while it was being committed ({_names(changed)}); "
                "land again.",
            )
        links = _new_gitlinks(checkout, fork)
        if links:
            return Landed(
                False,
                f"{_names(links)} is a git repository of its own inside the copy, so landing "
                "would keep only a link to it. Remove its .git folder (or add it as a "
                "submodule), then land.",
            )
    head = _rev(copy.repo, f"refs/heads/{copy.branch}")
    tip = _rev(copy.repo, f"refs/heads/{copy.into}")
    if not head:
        return Landed(False, f"The branch {copy.branch} is gone, so there's nothing to land.")
    if not tip:
        return Landed(False, f"The branch {copy.into} it lands in is gone.")
    if head == tip or _is_ancestor(copy.repo, head, tip):
        return Landed(True, f"Everything in {copy.branch} is already in {copy.into}.", commit=tip)
    fast = _is_ancestor(copy.repo, tip, head)
    new = head
    if not fast:
        merged = git(
            copy.repo,
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            tip,
            head,
            timeout=120,
        )
        if merged.code == 1:
            lines = merged.out.splitlines()
            files = sorted({line for line in lines[1:] if line})
            names = ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")
            return Landed(
                False,
                f"Landing {copy.branch} in {copy.into} hits conflicts in {names}.",
                conflicts=files,
            )
        if not merged.ok:
            return Landed(False, f"Couldn't merge: {merged.err.strip()[:300]}")
        tree = merged.out.splitlines()[0].strip()
        title = copy.title or copy.slug
        made = git(
            copy.repo,
            *code_changes.OWN_IDENTITY,
            "commit-tree",
            tree,
            "-p",
            tip,
            "-p",
            head,
            "-m",
            f"Merge {copy.branch}: {title}",
        )
        if not made.ok:
            why = made.err.strip()
            if "Please tell me who you are" in why or "empty ident" in why:
                return Landed(
                    False,
                    "git doesn't know who's committing here: set user.name and user.email first.",
                )
            return Landed(False, f"Couldn't make the merge commit: {why[:300]}")
        new = made.out.strip()
    busy = _busy_with(copy.repo, copy.into)
    if busy == "rebase":
        return Landed(False, f"{copy.into} is in the middle of a rebase; finish it, then land.")
    if busy == "bisect":
        return Landed(False, f"{copy.into} is in the middle of a bisect; finish it, then land.")
    if busy:  # a merge, cherry-pick or revert there (git would refuse, in its own words)
        return Landed(False, f"{copy.into} is in the middle of {busy}; finish it, then land.")
    holder = _holder(copy.repo, copy.into)
    if holder:
        moved = git(holder, "merge", "--ff-only", "--no-edit", new, timeout=120)
        if not moved.ok:
            names = overwritten_files(moved.err)
            if names:
                shown = ", ".join(names[:5]) + (
                    f" and {len(names) - 5} more" if len(names) > 5 else ""
                )
                return Landed(
                    False,
                    f"The main folder has uncommitted changes in {shown} that landing would "
                    "overwrite. Commit or stash them, then land again.",
                )
            return Landed(False, f"Couldn't update {copy.into}: {moved.err.strip()[:300]}")
    else:
        moved = git(copy.repo, "update-ref", f"refs/heads/{copy.into}", new, tip)
        if not moved.ok:
            return Landed(False, f"{copy.into} moved while landing; land again.")
    how = "fast-forward" if fast else "a merge commit"
    return Landed(
        True, f"Landed {copy.branch} in {copy.into} ({how}).", commit=new, fast_forward=fast
    )


def remove_landed(copy: Copy, root: Path) -> str:
    """A landed copy taken away, only once everything in it is provably in the branch it
    landed in: nothing uncommitted (or untracked) in it and its HEAD part of that branch.
    Raises CopyError, the copy left as it is, when something there isn't (written after its
    work was committed, say). Else as remove: "" or what was left behind."""
    checkout = Path(copy.checkout)
    if checkout.is_dir():
        changed = _dirty(checkout)
        if changed:
            raise CopyError(
                f"{_names(changed)} changed in the copy after its work was committed, so the "
                "copy is kept: land or discard what's new."
            )
        head = _rev(checkout, "HEAD")
        tip = _rev(copy.repo, f"refs/heads/{copy.into}")
        if not head or not (head == tip or _is_ancestor(copy.repo, head, tip)):
            raise CopyError(
                f"The copy has commits that aren't in {copy.into}, so it's kept: land or "
                "discard them."
            )
    return remove(copy, root)


def remove(copy: Copy, root: Path, force: bool = True) -> str:
    """The copy's folder and branch gone (the caller has made sure nothing in them is lost:
    landed, or kept in the trash). "" when done, else what's left and why. Not forced (the
    sweeper's), only a spent copy goes, as it is at that moment: git refuses one with
    anything in it that isn't committed, and its branch goes only at the commit found
    landed. Work written or committed in it since it was looked at is never lost: what
    holds it stays."""
    problems: list[str] = []
    checkout = Path(copy.checkout)
    ref = f"refs/heads/{copy.branch}"
    landed = ""
    if not force:
        landed = _rev(copy.repo, ref)
        if landed and not _is_ancestor(copy.repo, landed, _rev(copy.repo, copy.into)):
            return f"{copy.branch} has commits that aren't in {copy.into}"
    if checkout.exists():
        args = ["worktree", "remove", *(["--force"] if force else []), str(checkout)]
        gone = git(copy.repo, *args, timeout=120)
        if not gone.ok:
            if not force:
                return gone.err.strip()[:200] or "git wouldn't remove it"
            problems.append(gone.err.strip()[:200])
    git(copy.repo, "worktree", "prune")
    if _rev(copy.repo, ref):
        if force:
            deleted = git(copy.repo, "branch", "-D", copy.branch)
        else:  # only as it was found landed: one committed to since stays
            deleted = git(copy.repo, "update-ref", "-d", ref, landed)
        if not deleted.ok:
            problems.append(deleted.err.strip()[:200])
    folder = copy.folder
    try:
        inside = root.resolve() in folder.resolve().parents
    except OSError:
        inside = False
    if inside and folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
        with contextlib.suppress(OSError):
            folder.parent.rmdir()  # the project's folder, once it holds no copies
    return "; ".join(p for p in problems if p)


# ── discarding and bringing back ──


KEEP_FAILED = "Couldn't keep a recovery copy, so nothing was discarded: "
SNAPSHOT_TRIES = 3  # a file that vanished while it was added, or one written meanwhile
_DISCARDED = "Eden Code: work left in "


def _commit_now(cwd: Path | str, tree: str, parent: str, branch: str, env: dict) -> str:
    """A recovery commit of tree on parent, dated now (its date is when it was discarded,
    for the sweeper, even when it holds nothing new): its id, "" when git couldn't."""
    made = git(
        cwd, "commit-tree", tree, "-p", parent, "-m", f"{_DISCARDED}{branch}, discarded", env=env
    )
    return made.out.strip() if made.ok else ""


def _add_problem(err: str) -> tuple[str, bool]:
    """Why add -A failed, in words, and whether trying again could help (a file that
    vanished while it ran could; one git can't read can't)."""
    m = re.search(r'open\("(.+?)"\): ([^\n]+)', err)
    if m and "No such file" not in m.group(2):
        return (
            f"{m.group(1)} can't be read ({m.group(2).strip()}); make it readable or move it "
            "out of the copy, then discard.",
            False,
        )
    lines = [ln.strip() for ln in err.splitlines() if ln.strip()]
    first = next(
        (ln for ln in lines if ln.startswith(("error:", "fatal:"))), lines[0] if lines else ""
    )
    return f"git couldn't add everything in the copy ({first[:200] or 'it failed'}).", True


def _snapshot(copy: Copy) -> str:
    """A commit of everything in the copy, uncommitted and untracked work included (never
    ignored files), on top of its HEAD, dated now. Raises CopyError (so nothing is
    discarded) unless it provably holds all of that: git failed to add a file (one it
    can't read, one that vanished), files kept changing while it was made, or a git
    repository of its own is inside (only a link to it would be kept)."""
    checkout = Path(copy.checkout)
    head = _rev(checkout, "HEAD")
    if not head:
        try:
            anything = any(p.name != ".git" for p in checkout.iterdir())
        except OSError:
            anything = False
        if anything:
            raise CopyError(
                f"{KEEP_FAILED}{checkout} isn't a git checkout git can read any more; move "
                "what you need out of it, then discard."
            )
        return ""
    nested = _untracked_repos(checkout)
    if nested:
        raise CopyError(
            f"{KEEP_FAILED}{_names(nested)} is a git repository of its own inside the copy, "
            "so its files can't go in a recovery copy. Move it out of the copy, then discard."
        )
    problem = "it failed"
    for _ in range(SNAPSHOT_TRIES):
        with tempfile.TemporaryDirectory() as scratch:
            env = {"GIT_INDEX_FILE": str(Path(scratch) / "index"), **_SNAPSHOT_ID}
            if not git(checkout, "read-tree", "HEAD", env=env).ok:
                problem = "git couldn't read the copy's last commit."
                continue
            added = git(checkout, "add", "-A", env=env, timeout=120)
            if not added.ok:
                problem, again = _add_problem(added.err)
                if not again:
                    break
                continue
            # Provably whole: nothing on disk differs from what was added (a file written or
            # changed meanwhile would), and no repository inside was kept as a mere link.
            status = git(checkout, "status", "--porcelain", "-z", "--untracked-files=all", env=env)
            # (Against the snapshot's own index: its second column is what isn't in it.)
            unseen = [p for code, p in status_entries(status.out) if code[1] != " "]
            if not status.ok or unseen:
                problem = (
                    f"files in it kept changing while it was saved ({_names(unseen or ['?'])}); "
                    "stop whatever is writing there, then discard."
                )
                continue
            links = _new_gitlinks(checkout, copy.base or head, cached=True, env=env)
            if links:
                raise CopyError(
                    f"{KEEP_FAILED}{_names(links)} is a git repository of its own inside the "
                    "copy, so its files can't go in a recovery copy. Move it out of the copy, "
                    "then discard."
                )
            tree = git(checkout, "write-tree", env=env).out.strip()
            made = _commit_now(checkout, tree, head, copy.branch, env) if tree else ""
            if made:
                return made
            problem = "git couldn't write the recovery commit."
    raise CopyError(KEEP_FAILED + problem)


def discard(copy: Copy, root: Path) -> dict[str, Any]:
    """Throw the copy away, keeping all of its work as refs/jarvis/trash/<slug> for
    TRASH_DAYS. Returns the trash record. Raises CopyError, and nothing is thrown away,
    when its work can't all be kept."""
    snapshot = _snapshot(copy) if Path(copy.checkout).is_dir() else ""
    if not snapshot:
        branch_head = _rev(copy.repo, f"refs/heads/{copy.branch}")
        tree = git(copy.repo, "rev-parse", f"{branch_head}^{{tree}}").out.strip()
        snapshot = (
            _commit_now(copy.repo, tree, branch_head, copy.branch, dict(_SNAPSHOT_ID))
            if branch_head and tree
            else ""
        ) or branch_head
    ref = TRASH_PREFIX + copy.slug
    if snapshot:
        n = 2
        while _rev(copy.repo, ref):
            ref = f"{TRASH_PREFIX}{copy.slug}-{n}"
            n += 1
        # (Its reflog says when it was discarded, for the sweeper: the commit's own date
        # says when the work was done.)
        kept = git(copy.repo, "update-ref", "--create-reflog", ref, snapshot)
        if not kept.ok:
            raise CopyError(
                f"Couldn't keep a recovery copy, so nothing was discarded: {kept.err.strip()[:200]}"
            )
    problem = remove(copy, root)
    return {
        "slug": copy.slug,
        "project": copy.project,
        "repo": copy.repo,
        "prefix": copy.prefix,
        "ref": ref if snapshot else "",
        "at": time.time(),
        "title": copy.title,
        "base": copy.base,
        "into": copy.into,
        "problem": problem,
    }


def restore(
    item: dict[str, Any], root: Path, taken: set[str], making: dict[str, float] | None = None
) -> Copy:
    """A discarded copy back, from its recovery ref, on a new branch (the ref then goes).
    making: as create's."""
    repo, ref = str(item.get("repo") or ""), str(item.get("ref") or "")
    if not repo or not ref or not _rev(repo, ref):
        raise CopyError("That discarded copy isn't there any more.")
    stem = re.sub(r"-[0-9a-f]{4}$", "", str(item.get("slug") or "copy"))
    slug = slug_for(stem, taken)
    folder = root / str(item.get("project") or Path(repo).name) / slug
    checkout = folder / Path(repo).name
    # A recovery commit that holds nothing new (it's there for its date) isn't brought back:
    # the copy comes back at its own last commit, as it was.
    start = ref
    info = git(repo, "log", "-1", "--format=%T %P%x00%s", ref).out.strip()
    ids, _, subject = info.partition("\0")
    parts = ids.split()
    if (
        len(parts) == 2
        and subject.startswith(_DISCARDED)
        and parts[0] == git(repo, "rev-parse", f"{parts[1]}^{{tree}}").out.strip()
    ):
        start = parts[1]
    if making is not None:
        making[slug] = time.monotonic()
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        _not_making(making, slug)
        raise
    made = git(
        repo,
        "worktree",
        "add",
        "-b",
        BRANCH_PREFIX + slug,
        str(checkout),
        start,
        timeout=CREATE_SECONDS,
    )
    if not made.ok:
        shutil.rmtree(folder, ignore_errors=True)
        _not_making(making, slug)
        raise CopyError(f"Couldn't bring it back: {made.err.strip()[:300]}")
    git(repo, "update-ref", "-d", ref)
    into = str(item.get("into") or "") or code_changes.local_default_branch(Path(repo)) or "main"
    return Copy(
        slug=slug,
        project=str(item.get("project") or Path(repo).name),
        repo=repo,
        prefix=str(item.get("prefix") or ""),
        checkout=str(checkout),
        branch=BRANCH_PREFIX + slug,
        base=str(item.get("base") or "") or _rev(repo, ref),
        into=into,
        title=str(item.get("title") or ""),
        created=time.time(),
    )


# ── the sweeper ──


@dataclass
class Swept:
    removed: list[str] = field(default_factory=list)  # spent copies taken away
    leftovers: list[str] = field(default_factory=list)  # copies with work in them, no session
    expired: list[str] = field(default_factory=list)  # recovery refs past TRASH_DAYS
    adopted: list[str] = field(default_factory=list)  # copies found on disk, not on the list


def _being_made(store: CopyStore, slug: str) -> bool:
    """Whether a copy is being made in the folder just now (it's not on the list yet). One
    made so long ago that it never will be is let go of: it's a copy the list lost."""
    since = store.making.get(slug)
    if since is None:
        return False
    if time.monotonic() - since < MAKING_SECONDS:
        return True
    store.making.pop(slug, None)
    return False


def adopt(store: CopyStore, root: Path) -> list[str]:
    """Copies on disk that aren't on the list (a lost or damaged list): put back on it, so
    they're shown, never forgotten. Only worktrees on a jarvis/ branch, and never one being
    made just now (it goes on the list once it's made)."""
    found: list[str] = []
    if not root.is_dir():
        return found
    for project in sorted(p for p in root.iterdir() if p.is_dir()):
        for folder in sorted(p for p in project.iterdir() if p.is_dir()):
            slug = folder.name
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", slug):
                continue
            # Being made is asked first: a copy is that from before its folder is until
            # it's on the list, so one this sees is always one or the other.
            if _being_made(store, slug) or store.find(slug) is not None:
                continue
            try:
                checkouts = [c for c in folder.iterdir() if c.is_dir() and (c / ".git").is_file()]
            except OSError:  # removed meanwhile (landed or discarded)
                continue
            if not checkouts:
                continue
            checkout = checkouts[0]
            branch = git(checkout, "symbolic-ref", "-q", "--short", "HEAD").out.strip()
            common = git(
                checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"
            ).out.strip()
            if not branch.startswith(BRANCH_PREFIX) or not common:
                continue
            repo = str(Path(common).parent)
            into = code_changes.local_default_branch(Path(repo)) or "main"
            base = code_changes.merge_base(Path(repo), branch, into) or _rev(checkout, "HEAD")
            store.copies.append(
                Copy(
                    slug, project.name, repo, "", str(checkout), branch, base, into, "", time.time()
                )
            )
            found.append(slug)
    return found


def sweep(
    store: CopyStore,
    root: Path,
    live: set[str],
    now: float | None = None,
    *,
    listed: list[Copy] | None = None,
    may_remove: Callable[[Copy], bool] | None = None,
) -> Swept:
    """Startup's and each day's tidy-up. A copy with a session in it (live) is left alone.
    One with no session that's spent (nothing uncommitted, its branch already landed) is
    removed; one with work in it is a leftover, listed for Land or Discard, never deleted.
    Recovery refs older than TRASH_DAYS go.

    listed: the copies on the list when live was taken (the list as it is now, if not
    given), and the ones it takes in as lost are all it looks at: a copy made while it runs
    is never one (a brand-new copy is spent: nothing in it, its branch at its base).
    may_remove(copy) is asked just before a spent one goes: False keeps it (a session has
    started in it since). A copy that goes is removed without force, so work written in it
    since it was looked at keeps it, as a leftover."""
    now = time.time() if now is None else now
    report = Swept()
    looked = list(store.copies) if listed is None else list(listed)
    report.adopted = adopt(store, root)
    looked += [c for c in store.copies if c.slug in report.adopted]
    for repo in sorted({c.repo for c in looked}):
        git(repo, "worktree", "prune")
    for copy in looked:
        if copy.slug in live:
            continue
        found = state(copy)
        if not found.exists and not found.branch:
            _forget(store, copy)  # nothing of it left anywhere
            report.removed.append(copy.slug)
        elif found.spent:
            if may_remove is not None and not may_remove(copy):
                continue
            if not remove(copy, root, force=False):
                _forget(store, copy)
                report.removed.append(copy.slug)
            else:
                report.leftovers.append(copy.slug)
        else:
            report.leftovers.append(copy.slug)
    cutoff = now - TRASH_DAYS * 86400
    for item in list(store.trash):
        if float(item.get("at") or 0) < cutoff:
            if item.get("ref"):
                git(str(item["repo"]), "update-ref", "-d", str(item["ref"]))
            store.trash.remove(item)
            report.expired.append(str(item.get("slug")))
    for repo in sorted({c.repo for c in store.copies} | {str(t["repo"]) for t in store.trash}):
        listed = git(
            repo, "for-each-ref", "--format=%(refname)%00%(committerdate:unix)", TRASH_PREFIX
        )
        kept = {str(t.get("ref")) for t in store.trash}
        for line in listed.out.splitlines():
            ref, _, when = line.partition("\0")
            if ref in kept or not when.isdigit() or int(when) >= cutoff:
                continue
            discarded = _discarded_at(repo, ref)  # (an old commit may have been thrown away today)
            if discarded is None or discarded < cutoff:
                git(repo, "update-ref", "-d", ref)
                report.expired.append(ref.removeprefix(TRASH_PREFIX))
    return report


def _discarded_at(repo: str, ref: str) -> float | None:
    """When a recovery ref was made, from its reflog (None for one made without one, by an
    older build: its commit's date is all there is then)."""
    found = git(repo, "reflog", "show", "--date=unix", "-n1", "--format=%gd", ref)
    m = re.search(r"@\{(\d+)\}$", found.out.strip()) if found.ok else None
    return float(m.group(1)) if m else None


def _forget(store: CopyStore, copy: Copy) -> None:
    """A copy off the list (landed or discarded meanwhile, it's off it already)."""
    with contextlib.suppress(ValueError):
        store.copies.remove(copy)


def root_for(feature_path: Path) -> Path:
    """Where copies live: <Application Support>/Jarvis/worktrees (a temp folder in tests)."""
    with contextlib.suppress(OSError):
        feature_path.mkdir(parents=True, exist_ok=True)
        os.chmod(feature_path, 0o700)
    return feature_path
