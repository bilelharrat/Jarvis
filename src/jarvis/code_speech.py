"""Eden Code's changes and test results said for the ear, for someone who can't look at a diff:
files first, then where in each file by function, class or section (never line numbers), then the
tests, with the names of the ones that failed.

- changes_words(cwd, changes): diffspeak's changes (git's diff of the working tree), each hunk
  placed by what encloses it in the file as it is now: the def/class/function around it, or the
  Markdown heading above it. Functions a change adds are said as added.
- TestReport / read_test_output(text): the counts and the failing tests' names from a test run's
  output (pytest, Jest, Vitest, node --test, go test, cargo test, dotnet test), as Eden Code ran
  it in a session.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAX_FILES = 6
MAX_PLACES = 4
MAX_FAILED = 5

_PY = re.compile(r"^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)")
_JS = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)"
    r"|class\s+([A-Za-z_$][\w$]*)"
    r"|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))"
)
_METHOD = re.compile(
    r"^\s+(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{"
)
_C_LIKE = re.compile(
    r"^\s*(?:public|private|protected|internal|static|async|override|virtual|func|fn|pub|impl|"
    r"struct|enum|interface|type|class|void|int|bool|string|[\w<>\[\]]+\s)+\s*([A-Za-z_]\w*)\s*[({<]"
)
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
_NOT_NAMES = {"if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with"}

CODE = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".swift", ".java",
        ".kt", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".rb", ".php"}  # fmt: skip
PROSE = {".md", ".markdown", ".mdx", ".rst", ".txt"}


def _name_at(line: str, suffix: str) -> tuple[str, str] | None:
    """(kind, name) when this line opens a function, class or section."""
    if suffix in PROSE:
        m = _HEADING.match(line)
        return ("section", m.group(2).strip()) if m else None
    if suffix == ".py":
        m = _PY.match(line)
        return (("class" if m.group(1) == "class" else "function"), m.group(2)) if m else None
    if m := _JS.match(line):
        name = next(g for g in m.groups() if g)
        return ("class" if m.group(2) else "function", name)
    if (m := _METHOD.match(line)) and m.group(1) not in _NOT_NAMES:
        return "function", m.group(1)
    if suffix in CODE and (m := _C_LIKE.match(line)) and m.group(1) not in _NOT_NAMES:
        return "function", m.group(1)
    return None


def enclosing(lines: list[str], line_no: int, suffix: str) -> tuple[str, str] | None:
    """What a line (1-based) is in: the nearest function, class or section that opens above
    it and, for Python, isn't indented deeper than it."""
    index = min(max(line_no, 1), len(lines)) - 1
    if index < 0:
        return None
    here = lines[index]
    depth = len(here) - len(here.lstrip()) if here.strip() else 10_000
    for i in range(index, -1, -1):
        found = _name_at(lines[i], suffix)
        if found is None:
            continue
        if suffix == ".py":
            indent = len(lines[i]) - len(lines[i].lstrip())
            if i != index and indent >= depth:
                continue  # a sibling's def above, not the one this line is in
        return found
    return None


def _spoken_list(items: list[str]) -> str:
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _file_words(cwd: Path, change: Any) -> str:
    name = change.path
    if change.new:
        return f"New file {name}"
    if change.deleted:
        return f"Deleted {name}"
    suffix = Path(name).suffix.lower()
    try:
        lines = (Path(cwd) / name).read_text(errors="ignore").splitlines()
    except OSError:
        lines = []
    added: list[str] = []
    changed: list[str] = []
    for hunk in change.hunks:
        for line in hunk.added:
            if (found := _name_at(line, suffix)) and found[1] not in added:
                added.append(found[1])
        place = enclosing(lines, hunk.line, suffix) if lines else None
        if place is None and hunk.where:
            place = ("function", hunk.where)
        if place and place[1] not in changed and place[1] not in added:
            changed.append(place[1])
    parts = []
    kind = "sections" if suffix in PROSE else "functions"
    one = kind[:-1]
    if changed:
        shown = changed[:MAX_PLACES]
        more = f" and {len(changed) - MAX_PLACES} more" if len(changed) > MAX_PLACES else ""
        parts.append(
            f"changed the {one if len(shown) == 1 and not more else kind} {_spoken_list(shown)}{more}"
        )
    if added:
        shown = added[:MAX_PLACES]
        parts.append(f"added {_spoken_list(shown)}")
    if not parts:
        count = sum(len(h.added) + len(h.removed) for h in change.hunks)
        parts.append(f"{count} line{'s' if count != 1 else ''} changed at the top level")
    return f"{name}: " + ", ".join(parts)


def changes_words(cwd: Path, changes: list[Any] | None) -> str:
    """The changes, said: how many files, then each, biggest first, by what changed in it."""
    if changes is None:
        return "This project isn't in git, so I can't say what changed."
    if not changes:
        return "No files changed."
    ordered = sorted(changes, key=lambda c: -(c.added + c.removed))
    head = f"{len(changes)} file{'s' if len(changes) != 1 else ''} changed."
    lines = [_file_words(cwd, c) for c in ordered[:MAX_FILES]]
    tail = [f"And {len(ordered) - MAX_FILES} more files."] if len(ordered) > MAX_FILES else []
    return " ".join([head, *(line + "." for line in lines), *tail])


# ── test results ──


@dataclass
class TestReport:
    __test__ = False  # (not a pytest class, whatever its name)
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    failures: list[str] = field(default_factory=list)  # "test_name in test_file.py"
    runner: str = ""

    def words(self) -> str:
        if not (self.passed or self.failed or self.skipped):
            return ""
        parts = [f"{self.passed} passed"]
        if self.failed:
            parts.append(f"{self.failed} failed")
        if self.skipped:
            parts.append(f"{self.skipped} skipped")
        text = "Tests: " + ", ".join(parts) + "."
        if self.failures:
            shown = self.failures[:MAX_FAILED]
            more = len(self.failures) - len(shown)
            text += (
                " Failing: " + _spoken_list(shown) + (f", and {more} more" if more else "") + "."
            )
        return text


def _count(pattern: str, text: str) -> int:
    found = re.findall(pattern, text, re.IGNORECASE)
    return int(found[-1]) if found else 0


def _test_name(node: str) -> str:
    """ "tests/test_x.py::TestA::test_b[1]" as "test_b in test_x.py"."""
    path, _, rest = node.partition("::")
    name = rest.rsplit("::", 1)[-1] if rest else path
    name = re.sub(r"\[.*\]$", "", name)
    return f"{name} in {Path(path).name}" if rest else name


def read_test_output(text: str) -> TestReport | None:
    """The counts and failing names in a test run's output, or None when it isn't one."""
    if not text:
        return None
    out = TestReport()
    pytest_end = re.findall(r"(?m)^=*\s*((?:\d+ \w+(?:, )?)+) in [\d.]+s", text)
    if pytest_end or re.search(r"(?m)^(FAILED|ERROR) \S+::", text):
        summary = pytest_end[-1] if pytest_end else ""
        out.runner = "pytest"
        out.passed = _count(r"(\d+) passed", summary)
        out.failed = _count(r"(\d+) failed", summary) + _count(r"(\d+) errors?", summary)
        out.skipped = _count(r"(\d+) skipped", summary)
        for m in re.finditer(r"(?m)^(?:FAILED|ERROR) (\S+::\S+)", text):
            name = _test_name(m.group(1))
            if name not in out.failures:
                out.failures.append(name)
        return out
    if m := re.search(r"(?m)^\s*Tests:\s+(.*?)\d+ total", text):  # Jest
        out.runner = "jest"
        out.passed, out.failed = (
            _count(r"(\d+) passed", m.group(1)),
            _count(r"(\d+) failed", m.group(1)),
        )
        out.skipped = _count(r"(\d+) skipped", m.group(1))
        out.failures = list(dict.fromkeys(re.findall(r"(?m)^\s*●\s+(.+?)\s*$", text)))
        out.failures = [f.replace(" › ", ", ") for f in out.failures]
        return out
    if m := re.search(r"(?m)^\s*Tests\s+(.*\(\d+\))", text):  # Vitest
        out.runner = "vitest"
        out.passed, out.failed = (
            _count(r"(\d+) passed", m.group(1)),
            _count(r"(\d+) failed", m.group(1)),
        )
        out.skipped = _count(r"(\d+) skipped", m.group(1))
        names = re.findall(r"(?m)^\s*(?:FAIL|×|✗)\s+(\S+\.[jt]sx?)\s+>\s+(.+?)\s*$", text)
        out.failures = list(
            dict.fromkeys(f"{n.split(' > ')[-1]} in {Path(f).name}" for f, n in names)
        )
        return out
    if re.search(r"(?m)^# (?:pass|fail) \d+", text):  # node --test (TAP)
        out.runner = "node"
        out.passed, out.failed = (
            _count(r"(?m)^# pass (\d+)", text),
            _count(r"(?m)^# fail (\d+)", text),
        )
        out.skipped = _count(r"(?m)^# skipped (\d+)", text)
        out.failures = list(dict.fromkeys(re.findall(r"(?m)^\s*not ok \d+ - (.+?)\s*$", text)))
        return out
    if m := re.search(
        r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored", text
    ):  # cargo
        out.runner = "cargo"
        out.passed, out.failed, out.skipped = (int(g) for g in m.groups())
        out.failures = list(dict.fromkeys(re.findall(r"(?m)^test (\S+) \.\.\. FAILED", text)))
        return out
    if re.search(r"(?m)^(?:--- (?:PASS|FAIL):|ok\s+\S+\s+[\d.]+s|FAIL\s+\S+)", text):  # go test
        out.runner = "go"
        out.passed = len(re.findall(r"(?m)^\s*--- PASS:", text))
        out.failures = list(dict.fromkeys(re.findall(r"(?m)^\s*--- FAIL: (\S+)", text)))
        out.failed = len(out.failures)
        out.skipped = len(re.findall(r"(?m)^\s*--- SKIP:", text))
        if not (out.passed or out.failed):
            out.passed = len(re.findall(r"(?m)^ok\s+\S+", text))  # packages, without -v
        return out
    if m := re.search(r"Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+)", text):  # dotnet test
        out.runner = "dotnet"
        out.failed, out.passed, out.skipped = (int(g) for g in m.groups())
        out.failures = list(dict.fromkeys(re.findall(r"(?m)^\s*Failed (\S+) \[", text)))
        return out
    return None


TEST_COMMAND = re.compile(
    r"\b(?:pytest|py\.test|jest|vitest|mocha|ava|go\s+test|cargo\s+test|dotnet\s+test|"
    r"node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|rspec|phpunit|swift\s+test|mvn\s+test|"
    r"gradle\w*\s+test|unittest)\b"
)


def runs_tests(command: str) -> bool:
    return bool(TEST_COMMAND.search(command or ""))
