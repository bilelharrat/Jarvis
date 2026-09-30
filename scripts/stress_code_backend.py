"""Stress the Jarvis Code backend's isolated copies and diff parsing, with git but no model,
no network and no real backend (as the sweep requires):

    uv run python scripts/stress_code_backend.py

- 8 copies of one project made at once (the session cap), each committing on its own branch,
  then all landed or discarded, with the folders and recovery refs checked;
- a project whose path has spaces and Unicode, and one with a submodule;
- parse_patch on a huge single-file diff, timed.
Everything runs off a temp folder it removes at the end.
"""

from __future__ import annotations

import concurrent.futures
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jarvis import code_changes, worktrees  # noqa: E402


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


def make_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "t@example.com")
    git(path, "config", "user.name", "t")
    for name, text in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
    git(path, "add", "-A")
    git(path, "commit", "-qm", "start")
    return path


def eight_copies_at_once(project: Path, root: Path) -> None:
    taken: set[str] = set()
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        made = list(
            pool.map(
                lambda i: worktrees.create(project, root, f"task {i}", taken=taken.copy()), range(8)
            )
        )
    copies = [c for c, _ in made]
    slugs = {c.slug for c in copies}
    assert len(slugs) == 8, f"slug collision: {sorted(slugs)}"
    dur = time.perf_counter() - started
    # Each copy is its own checkout on its own branch; each edits its own file (landing one
    # after another into main is then clean; the same line in each is a conflict, checked
    # below).
    for i, copy in enumerate(copies):
        (Path(copy.checkout) / f"a{i}.py").write_text(f"made by {i}\n")
        problem = worktrees.commit_all(copy, f"copy {i}")
        assert not problem, problem
    # Land the even ones, discard the odd ones.
    landed = discarded = 0
    for i, copy in enumerate(copies):
        if i % 2 == 0:
            out = worktrees.land(copy, f"land {i}")
            assert out.ok, out.message
            assert not worktrees.remove(copy, root)  # the feature removes a landed copy
            landed += 1
        else:
            rec = worktrees.discard(copy, root)
            assert rec["ref"], "no recovery ref kept"
            assert not rec["problem"], rec["problem"]
            discarded += 1
    # main now has each landed copy's own file (the first land fast-forwards, the rest are
    # merge commits, serialised so none is lost).
    for i in range(0, 8, 2):
        assert (project / f"a{i}.py").exists(), f"a{i}.py not landed into main"
    for i in range(1, 8, 2):
        assert not (project / f"a{i}.py").exists(), f"a{i}.py landed though discarded"
    left = (
        [p for p in (root / project.name).iterdir() if p.is_dir()]
        if (root / project.name).is_dir()
        else []
    )
    print(
        f"  8 copies made in {dur:.2f}s; {landed} landed, {discarded} discarded; "
        f"{len(left)} copy folders left (expected 0)"
    )
    assert not left, f"folders left behind: {left}"


def a_conflict_changes_nothing(project: Path, root: Path) -> None:
    """Two copies changing the same line: the first lands, the second's land is refused and
    leaves main as it was (the copy is untouched, to go back to the session)."""
    a, _ = worktrees.create(project, root, "conflict a", taken=set())
    b, _ = worktrees.create(project, root, "conflict b", taken={a.slug})
    for copy, text in ((a, "from a\n"), (b, "from b\n")):
        (Path(copy.checkout) / "a.py").write_text(text)
        assert not worktrees.commit_all(copy, "edit")
    assert worktrees.land(a, "land a").ok
    before = git(project, "rev-parse", "main")
    out = worktrees.land(b, "land b")
    assert not out.ok and "conflict" in out.message.lower(), out.message
    assert git(project, "rev-parse", "main") == before, "a refused land moved main"
    assert Path(b.checkout).is_dir(), "the copy was removed by a refused land"
    print("  a second copy's conflicting land was refused and changed nothing")


def odd_paths(tmp: Path) -> None:
    for name in ["a project with spaces", "проект-☃"]:
        project = make_repo(tmp / name, {"a.py": "x = 1\n"})
        root = tmp / f"root-{abs(hash(name))}"
        copy, _ = worktrees.create(project, root, "edit", taken=set())
        (Path(copy.checkout) / "a.py").write_text("x = 2\n")
        assert not worktrees.commit_all(copy, "change")
        out = worktrees.land(copy, "land it")
        assert out.ok, f"{name}: {out.message}"
        print(f"  path {name!r}: created, committed and landed")


def with_submodule(tmp: Path) -> None:
    sub = make_repo(tmp / "dep", {"lib.py": "y = 1\n"})
    project = make_repo(tmp / "app", {"a.py": "x = 1\n"})
    git(project, "-c", "protocol.file.allow=always", "submodule", "add", str(sub), "vendor")
    git(project, "commit", "-qm", "add submodule")
    root = tmp / "root-sub"
    copy, notes = worktrees.create(project, root, "sub work", taken=set())
    (Path(copy.checkout) / "a.py").write_text("x = 3\n")
    assert not worktrees.commit_all(copy, "edit app")
    out = worktrees.land(copy, "land app")
    assert out.ok, out.message
    files = code_changes.diff_files(
        code_changes.repo_of(Path(copy.checkout)) or code_changes.Repo(Path(copy.checkout), ""),
        "HEAD~1",
    )
    print(
        f"  submodule project: copy made (notes: {len(notes)}), edited, landed; diff sees {len(files)} file(s)"
    )


def huge_diff() -> None:
    for n in (5_000, 30_000):
        body = "".join(f"-- comment {i}\n-SELECT {i};\n" for i in range(n))
        patch = (
            f"diff --git a/d.sql b/d.sql\ndeleted file mode 100644\n--- a/d.sql\n"
            f"+++ /dev/null\n@@ -1,{2 * n} +0,0 @@\n" + body
        )
        started = time.perf_counter()
        [f] = code_changes.parse_patch(patch)
        print(
            f"  parse_patch {2 * n:>6} removed lines: {time.perf_counter() - started:6.3f}s "
            f"(removed={f.removed})"
        )


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jv-stress-"))
    try:
        print("8 isolated copies at once:")
        project = make_repo(tmp / "proj", {"a.py": "x = 1\n"})
        eight_copies_at_once(project, tmp / "root")
        print("a conflicting land changes nothing:")
        a_conflict_changes_nothing(make_repo(tmp / "conf", {"a.py": "base\n"}), tmp / "root-conf")
        print("paths with spaces and Unicode:")
        odd_paths(tmp)
        print("a project with a submodule:")
        with_submodule(tmp)
        print("huge single-file diff:")
        huge_diff()
        print("OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
