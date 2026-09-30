"""Isolated copies: a Jarvis Code session in a git worktree of its own.

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
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from . import code_changes
from .code_changes import git

BRANCH_PREFIX = "jarvis/"
TRASH_PREFIX = "refs/jarvis/trash/"
TRASH_DAYS = 30
CREATE_SECONDS = 300.0  # checking out a big repository takes a while
MAX_COPIES = 60  # copies kept on the list (a runaway, past this, is refused)
ENV_FILES = 30
ENV_BYTES = 1_000_000
_ENV_NAME = re.compile(r"\.env(\.[\w.-]+)?")  # .env, .env.local… (never .envrc: it runs code)
LINKABLE = ("node_modules", ".venv")
# Who a recovery snapshot is by, when the repository names no one.
_SNAPSHOT_ID = {
    "GIT_AUTHOR_NAME": "Jarvis Code",
    "GIT_AUTHOR_EMAIL": "jarvis-code@localhost",
    "GIT_COMMITTER_NAME": "Jarvis Code",
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
) -> tuple[Copy, list[str]]:
    """A new copy of the project at its current commit, on a branch of its own. Returns the
    copy and notes for the owner (what was linked or copied, and what wasn't and why)."""
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
    try:
        folder.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        raise CopyError(f"Couldn't make a folder for the copy: {exc.strerror or exc}") from exc
    branch = BRANCH_PREFIX + slug
    made = git(
        repo.top, "worktree", "add", "-b", branch, str(checkout), head, timeout=CREATE_SECONDS
    )
    if not made.ok:
        shutil.rmtree(folder, ignore_errors=True)
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
    done = git(checkout, "commit", "-q", "-m", message, timeout=120)
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
    changes are in files the landing doesn't touch."""
    if Path(copy.checkout).is_dir():
        problem = commit_all(copy, message)
        if problem:
            return Landed(False, problem)
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


def remove(copy: Copy, root: Path) -> str:
    """The copy's folder and branch gone (the caller has made sure nothing in them is lost:
    landed, or kept in the trash). "" when done, else what's left and why."""
    problems: list[str] = []
    checkout = Path(copy.checkout)
    if checkout.exists():
        gone = git(copy.repo, "worktree", "remove", "--force", str(checkout), timeout=120)
        if not gone.ok:
            problems.append(gone.err.strip()[:200])
    git(copy.repo, "worktree", "prune")
    if _rev(copy.repo, f"refs/heads/{copy.branch}"):
        deleted = git(copy.repo, "branch", "-D", copy.branch)
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


def _snapshot(copy: Copy) -> str:
    """A commit of everything in the copy, uncommitted and untracked work included (never
    ignored files), on top of its branch; its branch's head when there's nothing more."""
    checkout = Path(copy.checkout)
    head = _rev(checkout, "HEAD")
    if not head:
        return ""
    with tempfile.TemporaryDirectory() as scratch:
        env = {"GIT_INDEX_FILE": str(Path(scratch) / "index"), **_SNAPSHOT_ID}
        if not git(checkout, "read-tree", "HEAD", env=env).ok:
            return head
        git(checkout, "add", "-A", env=env, timeout=120)
        tree = git(checkout, "write-tree", env=env).out.strip()
        if not tree or tree == git(checkout, "rev-parse", "HEAD^{tree}").out.strip():
            return head
        made = git(
            checkout,
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            f"Jarvis Code: work left in {copy.branch}, discarded",
            env=env,
        )
        return made.out.strip() if made.ok else head


def discard(copy: Copy, root: Path) -> dict[str, Any]:
    """Throw the copy away, keeping all of its work as refs/jarvis/trash/<slug> for
    TRASH_DAYS. Returns the trash record."""
    snapshot = _snapshot(copy) if Path(copy.checkout).is_dir() else ""
    snapshot = snapshot or _rev(copy.repo, f"refs/heads/{copy.branch}")
    ref = TRASH_PREFIX + copy.slug
    if snapshot:
        n = 2
        while _rev(copy.repo, ref):
            ref = f"{TRASH_PREFIX}{copy.slug}-{n}"
            n += 1
        kept = git(copy.repo, "update-ref", ref, snapshot)
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


def restore(item: dict[str, Any], root: Path, taken: set[str]) -> Copy:
    """A discarded copy back, from its recovery ref, on a new branch (the ref then goes)."""
    repo, ref = str(item.get("repo") or ""), str(item.get("ref") or "")
    if not repo or not ref or not _rev(repo, ref):
        raise CopyError("That discarded copy isn't there any more.")
    stem = re.sub(r"-[0-9a-f]{4}$", "", str(item.get("slug") or "copy"))
    slug = slug_for(stem, taken)
    folder = root / str(item.get("project") or Path(repo).name) / slug
    checkout = folder / Path(repo).name
    folder.mkdir(parents=True, exist_ok=True)
    made = git(
        repo,
        "worktree",
        "add",
        "-b",
        BRANCH_PREFIX + slug,
        str(checkout),
        ref,
        timeout=CREATE_SECONDS,
    )
    if not made.ok:
        shutil.rmtree(folder, ignore_errors=True)
        raise CopyError(f"Couldn't bring it back: {made.err.strip()[:300]}")
    git(repo, "update-ref", "-d", ref)
    into = str(item.get("into") or "") or code_changes.default_branch(Path(repo)) or "main"
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


def adopt(store: CopyStore, root: Path) -> list[str]:
    """Copies on disk that aren't on the list (a lost or damaged list): put back on it, so
    they're shown, never forgotten. Only worktrees on a jarvis/ branch."""
    found: list[str] = []
    if not root.is_dir():
        return found
    for project in sorted(p for p in root.iterdir() if p.is_dir()):
        for folder in sorted(p for p in project.iterdir() if p.is_dir()):
            slug = folder.name
            if store.find(slug) is not None or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", slug):
                continue
            checkouts = [c for c in folder.iterdir() if c.is_dir() and (c / ".git").is_file()]
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
            into = code_changes.default_branch(Path(repo)) or "main"
            base = code_changes.merge_base(Path(repo), branch, into) or _rev(checkout, "HEAD")
            store.copies.append(
                Copy(
                    slug, project.name, repo, "", str(checkout), branch, base, into, "", time.time()
                )
            )
            found.append(slug)
    return found


def sweep(store: CopyStore, root: Path, live: set[str], now: float | None = None) -> Swept:
    """Startup's and each day's tidy-up. A copy with a session in it (live) is left alone.
    One with no session that's spent (nothing uncommitted, its branch already landed) is
    removed; one with work in it is a leftover, listed for Land or Discard, never deleted.
    Recovery refs older than TRASH_DAYS go."""
    now = time.time() if now is None else now
    report = Swept()
    report.adopted = adopt(store, root)
    for repo in sorted({c.repo for c in store.copies}):
        git(repo, "worktree", "prune")
    for copy in list(store.copies):
        if copy.slug in live:
            continue
        found = state(copy)
        if not found.exists and not found.branch:
            store.copies.remove(copy)  # nothing of it left anywhere
            report.removed.append(copy.slug)
        elif found.spent:
            if not remove(copy, root):
                store.copies.remove(copy)
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
            if ref not in kept and when.isdigit() and int(when) < cutoff:
                git(repo, "update-ref", "-d", ref)
                report.expired.append(ref.removeprefix(TRASH_PREFIX))
    return report


def root_for(feature_path: Path) -> Path:
    """Where copies live: <Application Support>/Jarvis/worktrees (a temp folder in tests)."""
    with contextlib.suppress(OSError):
        feature_path.mkdir(parents=True, exist_ok=True)
        os.chmod(feature_path, 0o700)
    return feature_path
