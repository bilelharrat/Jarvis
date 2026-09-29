"""Code changes, out loud.

A diff is made for eyes. This reads a project's working changes (git, against HEAD,
plus new files) and turns them into something you can listen to: how many files and
lines, and for each file roughly where (the functions git names in its hunk headers).
Individual changes are numbered so you can say "explain the second change".
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$")
_CONTEXT_NAME = re.compile(r"(?:def|class|function|func|fn|const|let|var|struct|interface)\s+(\w+)")


@dataclass
class Hunk:
    path: str
    line: int
    context: str
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)

    @property
    def where(self) -> str:
        m = _CONTEXT_NAME.search(self.context)
        return m.group(1) if m else ""


@dataclass
class FileChange:
    path: str
    added: int = 0
    removed: int = 0
    new: bool = False
    deleted: bool = False
    hunks: list[Hunk] = field(default_factory=list)


XFUNCNAME = (
    r"^[ \t]*((async[ \t]+)?(def|class|function|func|fn|struct|interface|enum|impl)[ \t].*"
    r"|(export[ \t]+)?(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*(async[ \t]*)?(\(|function).*)$"
)


def _attributes() -> str:
    """A git attributes file (outside any repo) that routes every file to our pattern."""
    import tempfile

    path = Path(tempfile.gettempdir()) / "jarvis-diffspeak.gitattributes"
    if not path.exists():
        path.write_text("* diff=spoken\n")
    return str(path)


def _git(cwd: Path, *args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout if out.returncode == 0 else ""


def parse(diff: str) -> list[FileChange]:
    files: list[FileChange] = []
    current: FileChange | None = None
    hunk: Hunk | None = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.+?) b/(.+)$", line)
            current = FileChange(m.group(2) if m else line[11:])
            files.append(current)
            hunk = None
        elif current is None:
            continue
        elif line.startswith("new file mode"):
            current.new = True
        elif line.startswith("deleted file mode"):
            current.deleted = True
        elif line.startswith(("--- ", "+++ ", "index ", "similarity", "rename ")):
            continue
        elif line.startswith("@@"):
            m = _HUNK.match(line)
            hunk = Hunk(
                current.path, int(m.group(1)) if m else 0, (m.group(2) if m else "").strip()
            )
            current.hunks.append(hunk)
        elif hunk is not None and line.startswith("+"):
            hunk.added.append(line[1:])
            current.added += 1
        elif hunk is not None and line.startswith("-"):
            hunk.removed.append(line[1:])
            current.removed += 1
    return files


def collect(cwd: Path, only: set[str] | None = None) -> list[FileChange] | None:
    """Working changes against HEAD, plus untracked files. None if not a git repo.
    only: absolute paths to keep (the files a session touched)."""
    cwd = Path(cwd)
    if not _git(cwd, "rev-parse", "--is-inside-work-tree").strip():
        return None
    changes = parse(
        _git(
            cwd,
            # Name hunks by the nearest function or method, indented or not (git's own
            # default skips indented lines, so a method change is named after its class).
            "-c",
            f"core.attributesFile={_attributes()}",
            "-c",
            f"diff.spoken.xfuncname={XFUNCNAME}",
            "diff",
            "HEAD",
            "--no-color",
            "--no-ext-diff",
            "-U0",
        )
    )
    for rel in _git(cwd, "ls-files", "--others", "--exclude-standard").splitlines()[:200]:
        path = cwd / rel
        try:
            lines = (
                path.read_text(errors="ignore").splitlines()
                if path.stat().st_size < 400_000
                else []
            )
        except OSError:
            continue
        change = FileChange(rel, added=len(lines), new=True)
        change.hunks.append(Hunk(rel, 1, "", added=lines[:200]))
        changes.append(change)
    if only:
        keep = {str(Path(p).resolve()) for p in only}
        root = cwd.resolve()
        changes = [c for c in changes if str((root / c.path).resolve()) in keep] or changes
    return changes


def _spoken_name(path: str) -> str:
    name = Path(path).name
    return re.sub(r"\.(\w+)$", r" dot \1", name).replace("_", " ")


def summary(changes: list[FileChange], max_files: int = 4) -> str:
    if not changes:
        return "No changes yet: the working tree matches the last commit."
    added = sum(c.added for c in changes)
    removed = sum(c.removed for c in changes)
    head = (
        f"{len(changes)} file{'s' if len(changes) != 1 else ''} changed, "
        f"{added} line{'s' if added != 1 else ''} added and {removed} removed."
    )
    parts = []
    for c in sorted(changes, key=lambda c: -(c.added + c.removed))[:max_files]:
        if c.new:
            parts.append(f"New file {_spoken_name(c.path)}, {c.added} lines.")
            continue
        if c.deleted:
            parts.append(f"Deleted {_spoken_name(c.path)}.")
            continue
        where = [h.where for h in c.hunks if h.where]
        where = list(dict.fromkeys(where))[:3]
        spot = (
            f", in {', '.join(where[:-1]) + ' and ' + where[-1] if len(where) > 1 else where[0]}"
            if where
            else ""
        )
        parts.append(f"{_spoken_name(c.path)}: {c.added} added, {c.removed} removed{spot}.")
    more = len(changes) - max_files
    tail = f" And {more} more file{'s' if more != 1 else ''}." if more > 0 else ""
    return " ".join([head, *parts]) + tail


def hunks(changes: list[FileChange]) -> list[Hunk]:
    return [h for c in changes for h in c.hunks]


def describe_hunk(h: Hunk, max_lines: int = 30) -> str:
    """One change, for Claude to explain (not to be read aloud)."""
    body = [f"-{line}" for line in h.removed[:max_lines]] + [
        f"+{line}" for line in h.added[:max_lines]
    ]
    where = f" in {h.where}" if h.where else ""
    return f"{h.path} line {h.line}{where}:\n" + "\n".join(body)
