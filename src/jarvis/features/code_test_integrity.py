"""Eden Code: before a receipt may say "tests passed", proof that the tests still test.

An agent asked to make the tests pass can make them pass the cheap way: take an assertion
out, loosen it (`assert x == 5` becomes `assert x`), mark a test skip or xfail, add `.only`
so the others stop running, put `|| true` after the test command or `continue-on-error` on
the CI step, delete the test, or mock away the very code under test. Each leaves a green run
that proves nothing, and a receipt that says "tests passed" over it is worse than none.

So when a turn that changed files ends, its receipt (code_receipts) asks this module first:

- The static check (on by default, Settings › Eden Code › Receipts, `code_test_integrity`):
  the turn's own edits (code_changes' marks: the lines each Edit wrote and took out; for a
  whole-file Write, the file against the last commit) are read for every one of the above.
  Tests deleted with `rm` / `git rm` in the turn's shell steps count too. What it finds goes
  on the receipt as a warning ("A test was weakened: 2 assertions taken out of
  tests/test_signup.py"), the tests line no longer reads as a plain pass, and the risk is
  high. Nothing found, in a turn that changed tests: "No test was weakened".
- The quick mutation pass (off by default: it reruns tests, `code_mutation_pass`): small,
  bounded changes to the lines the turn changed (a comparison flipped, a boolean, and/or,
  plus/minus, a constant), each run against only the relevant tests (the turn's own test
  files, and the tests named after the changed module), in a scratch copy of the project,
  never the owner's files. A mutant the tests notice is "caught": the receipt reads "Tests
  constrain this change: 7 of 9 mutants caught", or warns when most go unnoticed. Bounded:
  at most MAX_MUTANTS, PASS_BUDGET seconds in all, a baseline run that must pass first, and
  a copy of at most COPY_FILES / COPY_BYTES. Runs with the Tests pane's runners
  (codetests: the project's own pytest, vitest or jest, never npx; node --test; go test).

Cost policy: no model calls. The static check is local text reading (and git show); the
mutation pass runs the project's own tests locally, only when the owner turned it on.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import shlex
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import code_changes, codetests, prefs, runproc
from .. import codesupervisor as cs

log = logging.getLogger("jarvis")

PREF_CHECK = "code_test_integrity"
PREF_MUTANTS = "code_mutation_pass"
prefs.register_feature_pref(PREF_CHECK, True)
prefs.register_feature_pref(PREF_MUTANTS, False)

MAX_MUTANTS = 12  # tried in one pass, at most
PASS_BUDGET = 180.0  # seconds a pass may take in all (the copy, the baseline, the mutants)
BASELINE_LIMIT = 90.0  # a baseline slower than this: too slow for a quick pass
MUTANT_FLOOR = 10.0  # seconds each mutant's run may take, at least (else 3x the baseline)
MUTANT_CEILING = 120.0
COPY_FILES = 20_000  # a project bigger than this isn't copied for a quick pass
COPY_BYTES = 300 * 1024 * 1024
FINDINGS_KEPT = 12
FILE_BYTES = 2_000_000  # a changed file bigger than this isn't read
SURVIVORS_KEPT = 5
LOW_SCORE = 0.5  # fewer than this share of mutants caught: the tests barely constrain it

# ── what's a test, what's CI ──

_TEST_PATH = re.compile(
    r"(?:^|/)test_[^/]*\.py$|_test\.(?:py|go|rb|exs?)$|_spec\.rb$"
    r"|\.(?:test|spec)\.[cm]?[jt]sx?$|Tests?\.(?:swift|kt|java|cs)$|(?:^|/)conftest\.py$",
    re.IGNORECASE,
)
# Code in a tests folder is a test's too (helpers, fixtures in code); its data files aren't.
_IN_TESTS = re.compile(r"(?:^|/)(?:tests?|__tests__|spec|specs|testing)/", re.IGNORECASE)
_TEST_DIR = re.compile(r"(?:^|/)(?:tests?|__tests__|spec|specs)/?$", re.IGNORECASE)
_CI_PATH = re.compile(
    r"(?:^|/)\.github/workflows/[^/]+\.ya?ml$|(?:^|/)\.gitlab-ci\.ya?ml$|(?:^|/)\.circleci/"
    r"|azure-pipelines\.ya?ml$|bitbucket-pipelines\.yml$|(?:^|/)Jenkinsfile$"
    r"|(?:^|/)\.buildkite/|(?:^|/)\.pre-commit-config\.yaml$",
    re.IGNORECASE,
)
# Files a test command lives in (scripts, task runners, the runner's own config).
_COMMAND_PATH = re.compile(
    r"(?:^|/)(?:package\.json|Makefile|makefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py"
    r"|pyproject\.toml|setup\.cfg|pytest\.ini|Rakefile)$|\.sh$",
)
_CODE = (
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts", ".go", ".rs",
    ".swift", ".kt", ".java", ".rb", ".c", ".cc", ".cpp", ".cs", ".php", ".scala",
)  # fmt: skip
_JS = (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts")


def is_test_file(path: str) -> bool:
    path = path.replace("\\", "/")
    return bool(_TEST_PATH.search(path)) or (
        bool(_IN_TESTS.search(path)) and path.lower().endswith(_CODE)
    )


def is_ci_file(path: str) -> bool:
    return bool(_CI_PATH.search(path.replace("\\", "/")))


def is_source(path: str) -> bool:
    return path.lower().endswith(_CODE) and not is_test_file(path)


# ── what weakens a test ──

# An assertion, in the languages Eden Code sees most. A commented-out one isn't one.
_ASSERT = re.compile(
    r"^\s*assert\b|\bself\.assert\w*\s*\(|\bassert[A-Z]\w*\s*\(|\bexpect\s*\(|\bassert\.\w+\s*\("
    r"|\bassert(?:_eq|_ne)?!\s*\(|\bXCTAssert\w*\s*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\w*\("
    r"|\brequire\.\w+\s*\(|\bassertThat\s*\(|#expect\s*\(|#require\s*\(|\bpytest\.raises\s*\("
    r"|\.should\b|\bshould\.\w+"
)
# An assertion that checks less than a value: something is there, true or was called.
_WEAK = re.compile(
    r"\bassertTrue\s*\(|\bassertIsNotNone\s*\(|\bis not None\b|\.toBeTruthy\s*\(|\.toBeDefined\s*\("
    r"|\.not\.toBeNull\s*\(|\.not\.toBeUndefined\s*\(|\bassert\.ok\s*\(|\bassert\s*\(\s*\w+\s*\)"
    r"|\bassert!\s*\(|\bXCTAssertNotNil\s*\(|\bXCTAssertTrue\s*\(|\.to\.exist\b|\.to\.be\.ok\b"
    r"|\.toHaveBeenCalled\s*\(\s*\)|expect\.anything\s*\(|\bassert\.notEqual\s*\(|\bassertNotEqual\s*\("
    r"|^\s*assert\s+[\w.\[\]'\"()]+\s*(?:,.*)?$"
)
_COMMENT = re.compile(r"^\s*(?:#|//|/\*|\*|--|;)")
_SKIP = re.compile(
    r"@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\("
    r"|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\("
    r"|\b(?:it|test|describe|suite|context|specify)\.(?:skip|todo|failing)\b"
    r"|\b(?:xit|xtest|xdescribe|xspecify)\s*\(|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]"
    r"|\bXCTSkip(?:If|Unless)?\b|[{,]\s*(?:skip|todo)\s*:\s*(?:true\b|['\"])|@Disabled\b|@Ignore\b"
)
_ONLY = re.compile(
    r"\b(?:it|test|describe|suite|context|specify)\.only\s*\(|\b(?:fit|fdescribe|ftest)\s*\("
    r"|[{,]\s*only\s*:\s*true\b"
)
_TEST_DEF = re.compile(
    r"^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*(?:it|test|specify)\s*\(\s*['\"`]"
    r"|^\s*func\s+Test\w+\s*\(|^\s*#\[test\]|^\s*func\s+test\w+\s*\(\s*\)|^\s*@Test\b"
)
_SWALLOW = re.compile(r"\bexcept\s+(?:\(?\s*)?AssertionError\b|\bcatch\s*\(\s*AssertionError\b")
_CANNOT_FAIL = re.compile(
    r"\|\|\s*(?:true\b|exit\s+0\b|:(?=\s|$|['\"])|echo\b)|;\s*(?:true|exit\s+0)\s*['\"]?\s*$"
    r"|--passWithNoTests\b|--exit-zero\b|\bset\s+\+e\b"
)
_CI_SOFT = re.compile(r"\bcontinue-on-error\s*:\s*true\b|\ballow_failure\s*:\s*true\b")
_TESTISH = re.compile(r"\btest|\bspec\b|pytest|jest|vitest|mocha|\bcheck\b|\blint\b", re.I)
_MOCK = re.compile(
    r"\bmock\.patch(?:\.object)?\s*\(|@patch(?:\.object)?\s*\(|\bpatch(?:\.object)?\s*\(\s*['\"\w]"
    r"|\bmonkeypatch\.setattr\s*\(|\b(?:jest|vi)\.(?:mock|doMock|spyOn)\s*\(|\bsinon\.(?:stub|replace|mock)\s*\("
    r"|\btd\.replace\s*\(|\bsys\.modules\s*\[|\.mockImplementation\s*\(|\.mockReturnValue\s*\("
)
_RM = re.compile(r"(?:^|[;&|(]\s*|\s)(?:git\s+rm|rm|unlink|trash)\s+([^;&|)]+)")
_GENERIC = {
    "index", "main", "app", "utils", "util", "helpers", "helper", "common", "init", "__init__",
    "test", "tests", "conftest", "setup", "config", "types", "mod", "lib", "core", "base",
}  # fmt: skip


@dataclass
class FileChange:
    """What one turn did to one file: the lines it wrote and took out (stripped)."""

    path: str  # relative to the session's folder
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    deleted: bool = False
    functions: set[str] = field(default_factory=set)  # the functions its changed lines are in
    text: str = ""  # its contents now (source files, for the mutation pass)
    changed_lines: list[int] = field(default_factory=list)  # 1-based, its lines the turn wrote


@dataclass
class Finding:
    kind: str  # assert_removed | assert_loosened | skip_added | only_added | test_removed |
    #            file_deleted | mock_unit | cannot_fail | swallowed | run_cannot_fail
    file: str
    text: str

    def public(self) -> dict[str, str]:
        return {"kind": self.kind, "file": self.file, "text": self.text}


def _assertion(line: str) -> bool:
    return not _COMMENT.match(line) and bool(_ASSERT.search(line))


def _snippet(line: str, limit: int = 60) -> str:
    line = " ".join(line.split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def subject_of(path: str) -> str:
    """The module a test file is named after: test_signup.py, signup.test.js, signup_test.go
    and SignupTests.swift are all signup's."""
    name = Path(path).name
    stem = name.split(".")[0]
    stem = re.sub(r"^test_|_test$|_spec$|Tests?$", "", stem)
    return stem


def _unit_names(changes: list[FileChange]) -> tuple[set[str], set[str]]:
    """(the functions the turn changed in its source files, those files' module names), for
    telling a mock of the unit under test from a mock of what it calls."""
    functions: set[str] = set()
    modules: set[str] = set()
    for c in changes:
        if is_source(c.path) and not c.deleted:
            functions |= {f for f in c.functions if len(f) >= 3 and f not in _GENERIC}
            stem = Path(c.path).stem
            if len(stem) >= 3 and stem not in _GENERIC:
                modules.add(stem)
    return functions, modules


def inspect(
    changes: list[FileChange],
    commands: list[str] | None = None,
    runs: list[Any] | None = None,
    cwd: Path | None = None,
) -> list[Finding]:
    """Everything in a turn's changes that makes its tests prove less. changes: the files it
    edited; commands: its shell steps (for tests deleted with rm); runs: its test runs (a
    command that can't fail)."""
    found: list[Finding] = []
    functions, modules = _unit_names(changes)
    for c in changes:
        test = is_test_file(c.path)
        if c.deleted:
            if test:
                found.append(Finding("file_deleted", c.path, f"{c.path} was deleted"))
            continue
        added_set, removed_set = set(c.added), set(c.removed)
        new = [line for line in c.added if line not in removed_set]
        gone = [line for line in c.removed if line not in added_set]
        if test:
            found += _weakened(c.path, new, gone, functions, modules)
        if is_ci_file(c.path) or test or _COMMAND_PATH.search(c.path):
            for line in new:
                if _CI_SOFT.search(line) and is_ci_file(c.path):
                    found.append(
                        Finding(
                            "cannot_fail",
                            c.path,
                            f"a CI step in {c.path} no longer fails the build (`{_snippet(line)}`)",
                        )
                    )
                elif _CANNOT_FAIL.search(line) and (_TESTISH.search(line) or is_ci_file(c.path)):
                    found.append(
                        Finding(
                            "cannot_fail",
                            c.path,
                            f"a test command in {c.path} can no longer fail (`{_snippet(line)}`)",
                        )
                    )
    found += _removed_by_shell(commands or [], cwd, {c.path for c in changes if c.deleted})
    seen_commands: set[str] = set()
    for run in runs or []:
        command = str(getattr(run, "command", "") or "")
        if command and command not in seen_commands and _CANNOT_FAIL.search(command):
            seen_commands.add(command)
            found.append(
                Finding(
                    "run_cannot_fail",
                    "",
                    f"its test run couldn't fail (`{_snippet(command)}`)",
                )
            )
    return found[:FINDINGS_KEPT]


def _weakened(
    path: str, new: list[str], gone: list[str], functions: set[str], modules: set[str]
) -> list[Finding]:
    found: list[Finding] = []
    gone_asserts = [line for line in gone if _assertion(line)]
    new_asserts = [line for line in new if _assertion(line)]
    if len(gone_asserts) > len(new_asserts):
        n = len(gone_asserts) - len(new_asserts)
        found.append(
            Finding(
                "assert_removed",
                path,
                f"{_plural(n, 'assertion')} taken out of {path} (`{_snippet(gone_asserts[0])}`)",
            )
        )
    else:
        strong_gone = [line for line in gone_asserts if not _WEAK.search(line)]
        strong_new = [line for line in new_asserts if not _WEAK.search(line)]
        weak_new = [line for line in new_asserts if _WEAK.search(line)]
        if len(strong_gone) > len(strong_new) and weak_new:
            n = min(len(strong_gone) - len(strong_new), len(weak_new))
            found.append(
                Finding(
                    "assert_loosened",
                    path,
                    f"{_plural(n, 'assertion')} in {path} made looser "
                    f"(`{_snippet(strong_gone[0], 40)}` became `{_snippet(weak_new[0], 40)}`)",
                )
            )
    gone_tests = [line for line in gone if _TEST_DEF.search(line)]
    new_tests = [line for line in new if _TEST_DEF.search(line)]
    if len(gone_tests) > len(new_tests):
        n = len(gone_tests) - len(new_tests)
        found.append(
            Finding(
                "test_removed",
                path,
                f"{_plural(n, 'test')} taken out of {path} (`{_snippet(gone_tests[0])}`)",
            )
        )
    for line in new:
        if _COMMENT.match(line):
            continue
        if _ONLY.search(line):
            found.append(
                Finding(
                    "only_added",
                    path,
                    f"`.only` in {path}: the other tests stop running (`{_snippet(line)}`)",
                )
            )
        elif _SKIP.search(line):
            found.append(
                Finding("skip_added", path, f"a test in {path} is now skipped (`{_snippet(line)}`)")
            )
        elif _SWALLOW.search(line):
            found.append(
                Finding(
                    "swallowed",
                    path,
                    f"{path} now catches a failed assertion (`{_snippet(line)}`)",
                )
            )
        elif _MOCK.search(line) and (unit := _mocked_unit(line, path, functions, modules)):
            found.append(
                Finding(
                    "mock_unit",
                    path,
                    f"{path} now mocks {unit}, the code this turn changed (`{_snippet(line)}`)",
                )
            )
    return found


def _mocked_unit(line: str, test_path: str, functions: set[str], modules: set[str]) -> str:
    """The unit under test a mock line replaces ("" when it replaces something else): one
    of the functions the turn changed, by name; or, for a whole-module mock (jest.mock,
    vi.mock, sys.modules, a patch of the module itself), the changed module this test is
    named after."""
    for name in sorted(functions):
        if re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", line):
            return name
    subject = subject_of(test_path)
    if subject in modules:
        whole = re.search(
            rf"(?:jest|vi)\.(?:mock|doMock)\s*\(\s*['\"][^'\"]*\b{re.escape(subject)}(?:\.[\w]+)?['\"]"
            rf"|sys\.modules\s*\[\s*['\"][\w.]*\b{re.escape(subject)}['\"]"
            rf"|patch\s*\(\s*['\"][\w.]*\b{re.escape(subject)}['\"]",
            line,
        )
        if whole:
            return subject
    return ""


def _removed_by_shell(commands: list[str], cwd: Path | None, known: set[str]) -> list[Finding]:
    """Test files (or a tests folder) the turn's shell steps deleted, that are gone now."""
    found: list[Finding] = []
    for command in commands:
        for match in _RM.finditer(command):
            try:
                words = shlex.split(match.group(1))
            except ValueError:
                continue
            for word in words:
                if word.startswith("-") or any(ch in word for ch in "*?[$`"):
                    continue
                rel = word.removeprefix("./")
                if cwd is not None:
                    try:
                        target = Path(word) if Path(word).is_absolute() else cwd / word
                        if target.exists():
                            continue
                        rel = target.resolve().relative_to(cwd.resolve()).as_posix()
                    except (ValueError, OSError):
                        continue  # (outside the project: a scratch folder, not its tests)
                elif Path(word).is_absolute() or rel.startswith("../"):
                    continue
                if rel in known:
                    continue
                if is_test_file(rel) or _TEST_DIR.search(rel):
                    known.add(rel)
                    what = "the tests folder " + rel if _TEST_DIR.search(rel) else rel
                    found.append(Finding("file_deleted", rel, f"{what} was deleted"))
    return found


# ── the turn's changes, from its edits ──


def _norm_lines(text: str) -> list[str]:
    return [s for line in text.splitlines() if (s := line.strip())]


def _read(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size > FILE_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", errors="replace")


def _at_head(cwd: Path, rel: str) -> str | None:
    """A file as the last commit has it (None: not in git, or not there)."""
    repo = code_changes.repo_of(cwd)
    if repo is None:
        return None
    try:
        top_rel = (cwd / rel).resolve().relative_to(repo.top.resolve()).as_posix()
    except (ValueError, OSError):
        return None
    shown = code_changes.git(repo.top, "show", f"HEAD:{top_rel}")
    return shown.out if shown.ok else None


def gather(cwd: Path, marks: list[Any]) -> list[FileChange]:
    """The turn's files and the lines it wrote and took out, from its edits' marks (each
    Edit's own old and new text; a whole-file Write against the last commit). Reads the
    files: run it off the event loop."""
    by_path: dict[str, list[Any]] = {}
    root = cwd.resolve() if cwd.exists() else cwd
    for mark in marks:
        raw = Path(str(getattr(mark, "path", "") or ""))
        if not str(raw):
            continue
        try:
            full = raw if raw.is_absolute() else root / raw
            rel = full.resolve().relative_to(root).as_posix()
        except (ValueError, OSError):
            continue
        by_path.setdefault(rel, []).append(mark)
    changes: list[FileChange] = []
    for rel, file_marks in by_path.items():
        change = FileChange(rel)
        added: set[str] = set()
        removed: set[str] = set()
        for mark in file_marks:
            added |= set(mark.added)
            removed |= set(mark.removed)
        now = _read(root / rel)
        if now is None and not (root / rel).exists():
            change.deleted = True
            changes.append(change)
            continue
        if any(getattr(m, "whole", False) for m in file_marks):
            # A whole-file Write says what it wrote, not what it replaced: against the last
            # commit (which may hold an earlier turn's work too: said as this turn's).
            before = _at_head(root, rel)
            if before is not None:
                now_lines = set(_norm_lines(now or ""))
                before_lines = set(_norm_lines(before))
                removed |= before_lines - now_lines
                added = now_lines - before_lines
        change.added = sorted(added)
        change.removed = sorted(removed)
        if now is not None and is_source(rel):
            change.text = now
            lines = now.split("\n")
            change.changed_lines = [i + 1 for i, line in enumerate(lines) if line.strip() in added]
            for n in change.changed_lines[:200]:
                name = cs.enclosing(lines, n)
                if name:
                    change.functions.add(name)
        changes.append(change)
    return changes


# ── mutants: small changes to the changed lines ──


@dataclass
class Mutant:
    path: str  # relative to the session's folder
    line: int  # 1-based
    before: str  # the line as it is
    after: str  # the line mutated
    change: str  # "== → !=" (for the receipt)


# (pattern, replacement, label, languages: "" every one, "py" Python only, "c" the others)
_OPERATORS: list[tuple[re.Pattern[str], str, str, str]] = [
    (re.compile(r"==="), "!==", "=== → !==", "c"),
    (re.compile(r"!=="), "===", "!== → ===", "c"),
    (re.compile(r"(?<![=!<>])==(?!=)"), "!=", "== → !=", ""),
    (re.compile(r"(?<![=!])!=(?!=)"), "==", "!= → ==", ""),
    (re.compile(r"(?<![<>=])<=(?!=)"), ">", "<= → >", ""),
    (re.compile(r"(?<![<>=])>=(?!=)"), "<", ">= → <", ""),
    (re.compile(r"(?<=\s)<(?=\s)"), ">=", "< → >=", ""),
    (re.compile(r"(?<=\s)>(?=\s)"), "<=", "> → <=", ""),
    (re.compile(r"&&"), "||", "&& → ||", "c"),
    (re.compile(r"\|\|"), "&&", "|| → &&", "c"),
    (re.compile(r"\band\b"), "or", "and → or", "py"),
    (re.compile(r"\bor\b"), "and", "or → and", "py"),
    (re.compile(r"\bnot\s+(?!in\b)"), "", "not removed", "py"),
    (re.compile(r"\bTrue\b"), "False", "True → False", "py"),
    (re.compile(r"\bFalse\b"), "True", "False → True", "py"),
    (re.compile(r"\btrue\b"), "false", "true → false", "c"),
    (re.compile(r"\bfalse\b"), "true", "false → true", "c"),
    (re.compile(r"(?<=\s)\+(?=\s)"), "-", "+ → -", ""),
    (re.compile(r"(?<=\s)-(?=\s)"), "+", "- → +", ""),
]
_NUMBER = re.compile(r"(?<![\w.$])(\d{1,6})(?![\w.])")
# Lines a mutant there would say nothing about: imports, logging, decorators, assertions.
_NOT_MUTATED = re.compile(
    r"^\s*(?:import\b|from\s+\S+\s+import\b|#include\b|using\b|use\b|package\b|@|assert\b)"
    r"|\b(?:require|console\.\w+|print|log\.\w+|logger\.\w+|logging\.\w+|println!?|fmt\.Print\w*)\s*\("
)
_STRING = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`")


def _masked(line: str, python: bool) -> str:
    """The line with its strings and its comment blanked (the same length), so a mutant is
    only ever made in code."""
    out = _STRING.sub(lambda m: " " * len(m.group(0)), line)
    marker = "#" if python else "//"
    at = out.find(marker)
    if at >= 0:
        out = out[:at] + " " * (len(out) - at)
    return out


def _in_strings(text: str, python: bool) -> set[int]:
    """The 1-based lines inside a docstring or a block comment."""
    inside: set[int] = set()
    open_mark = ""
    for i, line in enumerate(text.split("\n"), 1):
        if python:
            for mark in ('"""', "'''"):
                count = line.count(mark)
                if open_mark == mark:
                    inside.add(i)
                    if count % 2 == 1:
                        open_mark = ""
                    break
                if not open_mark and count:
                    inside.add(i)
                    if count % 2 == 1:
                        open_mark = mark
                    break
        else:
            if open_mark:
                inside.add(i)
                if "*/" in line:
                    open_mark = ""
            elif "/*" in line and "*/" not in line.split("/*", 1)[1]:
                inside.add(i)
                open_mark = "/*"
    return inside


def mutants_of_line(line: str, python: bool) -> list[tuple[str, str]]:
    """Every mutant of one line: (the line mutated, what changed). One per operator, at its
    first place in code (never in a string or a comment)."""
    stripped = line.strip()
    if not stripped or _COMMENT.match(stripped) or _NOT_MUTATED.search(stripped):
        return []
    masked = _masked(line, python)
    out: list[tuple[str, str]] = []
    for pattern, replacement, label, langs in _OPERATORS:
        if (langs == "py" and not python) or (langs == "c" and python):
            continue
        m = pattern.search(masked)
        if m:
            out.append((line[: m.start()] + replacement + line[m.end() :], label))
    m = _NUMBER.search(masked)
    if m:
        n = m.group(1)
        swapped = "1" if n == "0" else "0" if n == "1" else str(int(n) + 1)
        out.append((line[: m.start()] + swapped + line[m.end() :], f"{n} → {swapped}"))
    return out


def plan_mutants(changes: list[FileChange], limit: int = MAX_MUTANTS) -> list[Mutant]:
    """Up to limit mutants over the turn's changed source lines, spread out: one per line
    first (in file and line order), then a second per line, and so on."""
    per_line: list[list[Mutant]] = []
    for c in changes:
        if c.deleted or not c.text or not is_source(c.path):
            continue
        python = c.path.endswith(".py")
        lines = c.text.split("\n")
        skip = _in_strings(c.text, python)
        for n in c.changed_lines:
            if n in skip or n > len(lines):
                continue
            found = [
                Mutant(c.path, n, lines[n - 1], after, label)
                for after, label in mutants_of_line(lines[n - 1], python)
            ]
            if found:
                per_line.append(found)
    out: list[Mutant] = []
    depth = 0
    while len(out) < limit and any(len(m) > depth for m in per_line):
        for found in per_line:
            if depth < len(found) and len(out) < limit:
                out.append(found[depth])
        depth += 1
    return out


# ── running them, in a scratch copy ──


DEP_DIRS = ("node_modules", ".venv", "venv", "env", "vendor")


def make_copy(cwd: Path, dest: Path) -> str:
    """The project's own files (git's tracked and untracked-not-ignored; else a walk) copied
    into dest, its dependency folders (node_modules, .venv) linked, not copied. "" when it
    worked, else why not."""
    listed = code_changes.git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if listed.ok:
        names = [n for n in listed.out.split("\0") if n]
    else:
        names = []
        for folder, dirs, files in os.walk(cwd):
            dirs[:] = [d for d in dirs if d not in codetests.SKIP_DIRS]
            for name in files:
                names.append(str((Path(folder) / name).relative_to(cwd)))
                if len(names) > COPY_FILES:
                    break
    if len(names) > COPY_FILES:
        return f"the project has more than {COPY_FILES:,} files"
    total = 0
    for name in names:
        if "__pycache__" in name or name.endswith(".pyc"):
            continue
        src = cwd / name
        try:
            if src.is_symlink():
                target = dest / name
                target.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(os.readlink(src), target)
                continue
            if not src.is_file():
                continue
            total += src.stat().st_size
            if total > COPY_BYTES:
                return f"the project is bigger than {COPY_BYTES // (1024 * 1024)} MB"
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
        except OSError as exc:
            return f"it couldn't copy {name} ({exc.strerror or exc})"
    for folder in [cwd, *(p for p in sorted(cwd.iterdir()) if p.is_dir() and not p.is_symlink())]:
        if folder != cwd and folder.name in DEP_DIRS:
            continue
        for dep in DEP_DIRS:
            source = folder / dep
            if source.is_dir():
                link = dest / source.relative_to(cwd)
                if not link.exists():
                    with contextlib.suppress(OSError):
                        link.parent.mkdir(parents=True, exist_ok=True)
                        os.symlink(source, link)
    return ""


@dataclass
class Plan:
    """How one language's mutants are tried: the command and where it runs."""

    argv: list[str]
    cwd: str = ""  # relative to the copy
    label: str = ""


def _node_test(project: Path) -> bool:
    package = codetests._package(project)
    script = str((package.get("scripts") or {}).get("test") or "")
    return "node --test" in script or "node  --test" in script


def related_tests(project: Path, sources: list[str], tests: list[str], suite_id: str) -> list[str]:
    """The tests to rerun: the turn's own changed test files, and the test files named after
    a changed module (test_signup.py, signup.test.js)."""
    stems = {Path(s).stem for s in sources if len(Path(s).stem) >= 3}
    found = [t for t in tests if (project / t).is_file()]
    probe = codetests.Suite(suite_id, suite_id, ())
    for name in codetests.test_files(project, probe):
        if subject_of(name) in stems and name not in found:
            found.append(name)
    return found[:20]


def plan_for(project: Path, language: str, sources: list[str], tests: list[str]) -> Plan | str:
    """The command that reruns the relevant tests for one language's mutants, or why none."""
    suites = {s.id: s for s in codetests.discover(project) if s.ready}
    if language == "py":
        suite = suites.get("pytest")
        if suite is None:
            return "no pytest found for its Python tests"
        argv = list(suite.argv)
        if argv[:2] == ["uv", "run"]:
            if not (project / ".venv" / "bin" / "python").exists():
                return "a uv project without a .venv (uv run would change it)"
            argv = [".venv/bin/python", *argv[3:]]
        files = related_tests(project, sources, [t for t in tests if t.endswith(".py")], "pytest")
        return Plan([*argv, "-x", "-q", "-p", "no:cacheprovider", *files], label="pytest")
    if language == "js":
        for runner in ("vitest", "jest"):
            suite = suites.get(runner)
            if suite is None:
                continue
            files = related_tests(project, sources, [t for t in tests if t.endswith(_JS)], runner)
            rel = [
                f[len(suite.cwd) + 1 :] if suite.cwd and f.startswith(suite.cwd + "/") else f
                for f in files
            ]
            return Plan([*suite.argv, *rel], cwd=suite.cwd, label=runner)
        if _node_test(project):
            files = related_tests(project, sources, [t for t in tests if t.endswith(_JS)], "jest")
            return Plan(["node", "--test", *files], label="node --test")
        return "no vitest, jest or node --test found for its JavaScript tests"
    if language == "go" and (project / "go.mod").exists():
        folders = sorted({str(Path(s).parent) for s in sources})
        return Plan(
            ["go", "test", *[f"./{f}" if f != "." else "." for f in folders]], label="go test"
        )
    return f"no quick runner for its {language} files"


def _language(path: str) -> str:
    if path.endswith(".py"):
        return "py"
    if path.endswith(_JS):
        return "js"
    if path.endswith(".go"):
        return "go"
    return Path(path).suffix.lstrip(".") or "other"


async def _run(argv: list[str], cwd: Path, env: dict[str, str], limit: float) -> int | None:
    """One run, to its end or its limit (then stopped: None). Its exit code."""
    proc = runproc.Proc(argv, cwd, env, lambda _lines: None)
    try:
        await proc.start()
    except OSError:
        return -1
    try:
        return await asyncio.wait_for(proc.wait(), limit)
    except TimeoutError:
        await proc.stop()
        return None


async def mutation_pass(
    cwd: Path,
    changes: list[FileChange],
    test_files: list[str],
    env: dict[str, str] | None = None,
    budget: float = PASS_BUDGET,
    limit: int = MAX_MUTANTS,
) -> dict[str, Any]:
    """Try the turn's mutants against its relevant tests in a scratch copy: status done |
    skipped, caught of tried (of planned), the first survivors, why when skipped."""
    started = time.monotonic()
    mutants = plan_mutants(changes, limit)
    if not mutants:
        return {"status": "skipped", "why": "no line it changed could be mutated"}
    if env is None:
        env = await asyncio.to_thread(runproc.shell_env)
    by_language: dict[str, list[Mutant]] = {}
    for m in mutants:
        by_language.setdefault(_language(m.path), []).append(m)
    caught = tried = 0
    survived: list[dict[str, Any]] = []
    why = ""
    out_of_time = False
    with tempfile.TemporaryDirectory(prefix="eden-mutants-") as scratch:
        copy = Path(scratch) / "project"
        copy.mkdir()
        trouble = await asyncio.to_thread(make_copy, cwd, copy)
        if trouble:
            return {"status": "skipped", "why": f"{trouble}, too big for a quick pass"}
        paths = [str(copy)] + ([str(copy / "src")] if (copy / "src").is_dir() else [])
        run_env = {
            **env,
            "CI": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": os.pathsep.join([*paths, *filter(None, [env.get("PYTHONPATH", "")])]),
        }
        for language, group in by_language.items():
            sources = sorted({m.path for m in group})
            plan = await asyncio.to_thread(plan_for, copy, language, sources, test_files)
            if isinstance(plan, str):
                why = why or plan
                continue
            where = copy / plan.cwd if plan.cwd else copy
            left = budget - (time.monotonic() - started)
            t0 = time.monotonic()
            code = await _run(plan.argv, where, run_env, min(BASELINE_LIMIT, max(1.0, left)))
            took = time.monotonic() - t0
            if code is None:
                why = why or f"its tests ({plan.label}) take too long for a quick pass"
                continue
            if code != 0:
                why = why or (
                    f"its tests ({plan.label}) didn't pass in a scratch copy, so no mutant "
                    "was tried"
                )
                continue
            each = min(MUTANT_CEILING, max(MUTANT_FLOOR, took * 3 + 5))
            for m in group:
                left = budget - (time.monotonic() - started)
                if left < min(each, took + 2):
                    out_of_time = True
                    break
                target = copy / m.path
                try:
                    original = target.read_text(encoding="utf-8", errors="replace")
                    stat = target.stat()
                except OSError:
                    continue
                lines = original.split("\n")
                if len(lines) < m.line or lines[m.line - 1] != m.before:
                    continue  # (the file changed since: that line isn't there any more)
                lines[m.line - 1] = m.after
                target.write_text("\n".join(lines), encoding="utf-8")
                # (a later mtime: no cached bytecode of the original is taken for it)
                os.utime(target, (stat.st_atime, stat.st_mtime + 2 + tried))
                try:
                    code = await _run(plan.argv, where, run_env, min(each, left))
                finally:
                    target.write_text(original, encoding="utf-8")
                    os.utime(target, (stat.st_atime, stat.st_mtime + 3 + tried))
                tried += 1
                if code != 0:  # (a run stopped at its limit counts too: it noticed)
                    caught += 1
                elif len(survived) < SURVIVORS_KEPT:
                    survived.append({"file": m.path, "line": m.line, "change": m.change})
    if not tried:
        return {
            "status": "skipped",
            "why": why or "no mutant could be tried",
            "total": len(mutants),
        }
    return {
        "status": "done",
        "caught": caught,
        "tried": tried,
        "total": len(mutants),
        "survived": survived,
        "out_of_time": out_of_time,
        "seconds": round(time.monotonic() - started, 1),
    }


# ── the receipt's lines ──


def lines_of(findings: list[Finding], mutants: dict[str, Any] | None, tests_changed: bool):
    """The receipt's integrity lines: (tone ok | warn | bad | none, text)."""
    out: list[dict[str, str]] = []
    if findings:
        tests_ones = [f for f in findings if f.kind not in ("cannot_fail", "run_cannot_fail")]
        head = "A test was weakened" if tests_ones else "A test can no longer fail"
        first = (tests_ones or findings)[0].text
        more = len(findings) - 1
        out.append(
            {"tone": "bad", "text": f"{head}: {first}" + (f" (and {more} more)" if more else "")}
        )
    elif tests_changed:
        out.append({"tone": "ok", "text": "No test was weakened"})
    if mutants:
        if mutants.get("status") == "done":
            caught, tried = mutants["caught"], mutants["tried"]
            low = tried and caught / tried < LOW_SCORE
            text = (
                f"Tests barely constrain this change: {caught} of {tried} mutants caught"
                if low
                else f"Tests constrain this change: {caught} of {tried} mutants caught"
            )
            survivor = (mutants.get("survived") or [None])[0]
            if low and survivor:
                text += (
                    f" ({survivor['change']} on {survivor['file']} line {survivor['line']} "
                    "went unnoticed)"
                )
            if mutants.get("out_of_time"):
                text += f"; {mutants['total'] - tried} more not tried in time"
            out.append({"tone": "warn" if low else "ok", "text": text})
        elif mutants.get("why"):
            out.append({"tone": "none", "text": f"Mutation pass skipped: {mutants['why']}"})
    return out


# ── the desk: what each turn did, for its receipt ──


@dataclass
class TurnRecord:
    marks: list[Any]
    commands: list[str]
    cwd: Path


class Integrity:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.commands: dict[int, list[str]] = {}  # task id -> this turn's shell steps
        self.boundary: dict[int, Any] = {}  # task id -> the last mark before this turn
        self.turns: dict[int, TurnRecord] = {}  # task id -> its last finished turn's record

    def on(self, key: str) -> bool:
        with contextlib.suppress(Exception):
            return bool(self.hub.prefs.feature(key))
        return False

    def _task(self, task_id: Any) -> Any:
        tasks = getattr(getattr(self.hub, "tasks", None), "tasks", None) or {}
        return tasks.get(task_id)

    def task_event(self, kind: str, data: dict[str, Any]) -> None:
        """hub.add_task_sink: a session's shell steps, and the edits each turn made."""
        task_id = data.get("id")
        if not isinstance(task_id, int):
            return
        task = self._task(task_id)
        if task is None or getattr(task, "kind", "code") != "code":
            return
        marks = getattr(task, "edit_marks", None)
        if task_id not in self.boundary:  # first heard of: what came before isn't its turn's
            self.boundary[task_id] = marks[-1] if marks else None
        if kind == "task_log":
            entry = data.get("entry") or {}
            if entry.get("role") == "tool" and entry.get("tool") == "Bash":
                steps = self.commands.setdefault(task_id, [])
                steps.append(str(entry.get("detail") or "").removeprefix("$ ")[:2000])
                del steps[:-200]
        elif kind == "task_finished":
            self.turns[task_id] = TurnRecord(
                self.marks_since(task, self.boundary.get(task_id)),
                self.commands.pop(task_id, []),
                Path(getattr(task, "cwd", ".")),
            )
            self.boundary[task_id] = marks[-1] if marks else None
            for kept in (self.turns, self.boundary, self.commands):
                while len(kept) > 200:
                    del kept[next(iter(kept))]

    @staticmethod
    def marks_since(task: Any, boundary: Any) -> list[Any]:
        marks = list(getattr(task, "edit_marks", None) or [])
        if boundary is None:
            if not marks:
                return []
            # Never seen before this turn: the marks of its latest user message's turn.
            checkpoints = getattr(task, "checkpoints", None) or []
            latest = checkpoints[-1] if checkpoints else ""
            return [m for m in marks if m.checkpoint == latest]
        for i in range(len(marks) - 1, -1, -1):
            if marks[i] is boundary:
                return marks[i + 1 :]
        checkpoints = getattr(task, "checkpoints", None) or []  # (rewound past it)
        latest = checkpoints[-1] if checkpoints else ""
        return [m for m in marks if m.checkpoint == latest]

    async def part(self, task: Any, tests: list[Any], verdict: dict[str, Any] | None):
        """The receipt's integrity part (None when there's nothing to say, or it's off)."""
        check, mutate = self.on(PREF_CHECK), self.on(PREF_MUTANTS)
        record = self.turns.pop(task.id, None)
        if record is None or not (check or mutate):
            return None
        changes = await asyncio.to_thread(gather, record.cwd, record.marks)
        findings = (
            await asyncio.to_thread(inspect, changes, record.commands, tests, record.cwd)
            if check
            else []
        )
        tests_changed = any(is_test_file(c.path) for c in changes)
        mutants = None
        state = (verdict or {}).get("state")
        if mutate and any(is_source(c.path) and not c.deleted for c in changes):
            if state in ("passed", "unknown", "stale"):
                test_files = [c.path for c in changes if is_test_file(c.path) and not c.deleted]
                for run in tests:
                    with contextlib.suppress(ValueError):
                        for word in shlex.split(str(getattr(run, "command", ""))):
                            if is_test_file(word) and (record.cwd / word).is_file():
                                test_files.append(word.removeprefix("./"))
                try:
                    mutants = await mutation_pass(record.cwd, changes, sorted(set(test_files)))
                except Exception as exc:  # a pass that broke never keeps the receipt back
                    log.warning("Eden Code's mutation pass failed: %s", exc)
                    mutants = {"status": "skipped", "why": "it ran into an error"}
            elif state == "failed":
                mutants = {"status": "skipped", "why": "its tests failed"}
            else:
                mutants = {"status": "skipped", "why": "no tests ran to the end this turn"}
        lines = lines_of(findings, mutants, tests_changed and check)
        if not lines:
            return None
        return {
            "status": "weakened" if findings else "ok",
            "findings": [f.public() for f in findings],
            "mutants": mutants,
            "lines": lines,
        }


def install(hub: Any) -> None:
    desk = Integrity(hub)
    hub.code_integrity = desk  # (for code_receipts and the tests)
    hub.add_task_sink(desk.task_event)
