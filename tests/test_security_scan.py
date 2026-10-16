"""Security and dependency scanning (security_scan.py): each tool's JSON read from a
recorded output (tests/fixtures/security/), what a change added (its lines, its new
packages), and a scan of a real repository's change with fake tools: only findings on
added lines and in new dependencies, each pinned, two tools' twin found once, results
cached, a missing tool named with how to install it, a failing one said and skipped,
and commits about to be pushed scanned as they are in them. None of the tools is needed."""

import json
from pathlib import Path

from test_code_changes import git, make_repo, numbered

from jarvis import code_changes
from jarvis import security_scan as ss

FIXTURES = Path(__file__).parent / "fixtures" / "security"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


# ── the parsers ──


def test_semgreps_json_is_read_with_its_rule_cwe_and_fix():
    raws, errors = ss.parse_semgrep(fixture("semgrep.json"))
    assert [(r.path, r.start, r.end, r.finding.severity) for r in raws] == [
        ("app/run.py", 12, 12, "high"),
        ("app/run.py", 3, 4, "medium"),
        ("web/page.js", 7, 7, "high"),
    ]
    shell = raws[0].finding
    assert shell.tool == "Semgrep" and shell.kind == "code"
    assert shell.title == "Found 'subprocess' function 'run' with 'shell=True'."
    assert shell.detail.endswith("(Semgrep rule subprocess-shell-true, CWE-78)")
    assert shell.fix == "Semgrep suggests replacing it with: False"
    assert shell.url.startswith("https://semgrep.dev/r/")
    assert "requires login" not in json.dumps(shell.public())  # (Semgrep's "lines": never)
    assert errors == []  # (a warning-level error, a file it couldn't parse, isn't the owner's)
    assert ss.parse_semgrep("Semgrep crashed\n") == ([], ["Semgrep said something that isn't its JSON"])  # fmt: skip


def test_osv_scanners_json_gives_severity_ids_and_fixed_versions():
    vulns = ss.parse_osv(fixture("osv-scanner.json"))
    assert [(v.package, v.version, v.id, v.severity) for v in vulns] == [
        ("lodash", "4.17.20", "GHSA-35jh-r3h4-6jhm", "high"),  # its own word: HIGH
        ("lodash", "4.17.20", "GHSA-29mw-wpgm-hmr9", "medium"),  # MODERATE
        ("minimist", "1.2.5", "GHSA-xvch-5gv4-984h", "high"),  # no word: its score, 9.8
    ]
    assert vulns[0].aliases == ("CVE-2021-23337",) and vulns[0].fixed == ("4.17.21",)
    assert vulns[2].fixed == ("0.2.4", "1.2.6")
    assert ss.parse_osv("") == [] and ss.parse_osv('{"results": "odd"}') == []


def test_npm_audits_json_keeps_advisories_not_their_dependents():
    vulns, errors = ss.parse_npm_audit(fixture("npm-audit.json"))
    assert errors == []
    assert [(v.package, v.id, v.severity, v.fixed) for v in vulns] == [
        ("lodash", "GHSA-35jh-r3h4-6jhm", "high", ("4.17.21",)),
        ("old-thing", "GHSA-aaaa-bbbb-cccc", "high", ()),  # critical: high here
    ]  # (some-helper is only vulnerable through lodash: lodash's finding, not a second one)
    assert ss.parse_npm_audit(fixture("npm-audit-error.json")) == (
        [],
        ["npm audit: This command requires an existing lockfile."],
    )


def test_pip_audits_json_in_both_its_shapes():
    vulns = ss.parse_pip_audit(fixture("pip-audit.json"))
    assert [(v.package, v.version, v.id, v.fixed) for v in vulns] == [
        ("flask", "0.5", "PYSEC-2019-179", ("1.0",))
    ]
    assert vulns[0].summary == "The Pallets Project Flask before 1.0 is affected by: unexpected memory usage."  # fmt: skip
    old = json.dumps(json.loads(fixture("pip-audit.json"))["dependencies"])  # pip-audit 1.x
    assert [v.id for v in ss.parse_pip_audit(old)] == ["PYSEC-2019-179"]


# ── what a change adds ──


def diff_of(repo: Path, base: str = "HEAD"):
    return {f.path: f for f in code_changes.diff_files(code_changes.Repo(repo, ""), base)}


LOCK = """{
  "name": "app",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "dependencies": {
        "minimist": "^1.2.5"
      }
    },
    "node_modules/minimist": {
      "version": "1.2.5",
      "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz"
    }
  }
}
"""
LOCK_AFTER = LOCK.replace(
    """    "node_modules/minimist": {""",
    """    "node_modules/lodash": {
      "version": "4.17.20",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"
    },
    "node_modules/minimist": {""",
)
PACKAGE = '{\n  "name": "app",\n  "dependencies": {\n    "minimist": "^1.2.5"\n  }\n}\n'
PACKAGE_AFTER = PACKAGE.replace('"minimist": "^1.2.5"', '"lodash": "^4.17.20",\n    "minimist": "^1.2.5"')  # fmt: skip


def test_the_packages_a_change_brings_in(tmp_path):
    poetry = '[[package]]\nname = "flask"\nversion = "2.0"\n\n[[package]]\nname = "rich"\nversion = "13.0"\n'  # fmt: skip
    repo = make_repo(
        tmp_path / "p",
        {"package.json": PACKAGE, "package-lock.json": LOCK, "requirements.txt": "rich==13.0\n",
         "poetry.lock": poetry},
    )  # fmt: skip
    (repo / "package.json").write_text(PACKAGE_AFTER)
    (repo / "package-lock.json").write_text(LOCK_AFTER.replace('"1.2.5"', '"1.2.6"'))
    (repo / "requirements.txt").write_text("rich==13.0\nFlask_Login[extra]>=0.6 ; python_version>'3'\n")  # fmt: skip
    (repo / "poetry.lock").write_text(poetry.replace('version = "2.0"', 'version = "0.5"'))
    files = diff_of(repo)
    assert ss.dependency_names(files["package.json"]) == {"lodash": 4}
    # A changed version line is the entry's it's under; JSON keys are never packages.
    assert ss.dependency_names(files["package-lock.json"]) == {"lodash": 10, "minimist": 15}
    assert ss.dependency_names(files["requirements.txt"]) == {"flask-login": 2}
    assert ss.dependency_names(files["poetry.lock"]) == {"flask": 3}
    assert ss.added_lines(files["package.json"]) == {4}
    assert [ss.dependency_kind(p) for p in ("a/package-lock.json", "requirements-dev.txt", "pyproject.toml", "a.py")] == [  # fmt: skip
        "lockfile", "requirements", "manifest", ""
    ]  # fmt: skip
    assert ss.is_code("app/run.py") and ss.is_code("Dockerfile") and not ss.is_code("notes.md")


# ── a change scanned, with fake tools ──


SEMGREP_AT_12 = fixture("semgrep.json")


class Tools:
    """Fake tools: which are installed, each one's recorded output, and every run."""

    def __init__(self, monkeypatch, installed=("semgrep", "osv-scanner", "npm"), outputs=None):
        self.installed = set(installed)
        self.calls: list[tuple[list[str], Path]] = []
        self.outputs = {
            "semgrep": (0, SEMGREP_AT_12, ""),
            "osv-scanner": (1, fixture("osv-scanner.json"), ""),
            "npm": (1, fixture("npm-audit.json"), ""),
            "pip-audit": (1, fixture("pip-audit.json"), ""),
            **(outputs or {}),
        }
        monkeypatch.setattr(ss, "find_tool", self.find)
        monkeypatch.setattr(ss, "run", self.run)

    def find(self, command, _env, _root):
        return f"/fake/bin/{command}" if command in self.installed else None

    def run(self, argv, cwd, _env, _timeout):
        self.calls.append((list(argv), Path(cwd)))
        out = self.outputs[Path(argv[0]).name]
        return out(argv, Path(cwd)) if callable(out) else out

    def ran(self, command):
        return [argv for argv, _ in self.calls if Path(argv[0]).name == command]


def changed_project(tmp_path):
    repo = make_repo(
        tmp_path / "proj",
        {"app/run.py": numbered(20), "web/page.js": numbered(10), "package.json": PACKAGE,
         "package-lock.json": LOCK},
    )  # fmt: skip
    text = numbered(20).replace("line 12\n", "subprocess.run(cmd, shell=True)\n")
    (repo / "app/run.py").write_text(text)
    (repo / "package.json").write_text(PACKAGE_AFTER)
    (repo / "package-lock.json").write_text(LOCK_AFTER)
    return repo


def test_only_the_changes_own_lines_and_new_packages_are_kept_each_once(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)
    tools = Tools(monkeypatch)
    files = list(diff_of(repo).values())
    report = ss.Scanner(env=dict).scan(repo, files)
    assert report.ran == ["semgrep", "osv-scanner", "npm-audit"]
    assert report.missing == [] and report.errors == []
    got = [(f.tool, f.severity, f.path, f.line, f.rule) for f in report.findings]
    assert got == [
        # Line 12 was added; Semgrep's finding on lines 3-4 (untouched) and in web/page.js
        # (not in the change) are left out.
        (
            "Semgrep",
            "high",
            "app/run.py",
            12,
            "python.lang.security.audit.subprocess-shell-true.subprocess-shell-true",
        ),  # fmt: skip
        # lodash is new: pinned to the manifest's line that asked for it. npm audit's
        # twin of the same advisory is the same finding; minimist, there before, and
        # old-thing, never in this change, aren't this change's news.
        ("osv-scanner", "high", "package.json", 4, "CVE-2021-23337"),
        ("osv-scanner", "medium", "package.json", 4, "CVE-2020-28500"),
    ]
    lodash = report.findings[1]
    assert lodash.title == "lodash 4.17.20: Command Injection in lodash"
    assert lodash.fix == "Upgrade lodash to 4.17.21 or later."
    assert "GHSA-35jh-r3h4-6jhm, CVE-2021-23337" in lodash.detail
    semgrep = tools.ran("semgrep")[0]
    assert semgrep[-2:] == ["--", "app/run.py"] and "--metrics=off" in semgrep
    assert semgrep[semgrep.index("--config") + 1] == "p/default"
    assert tools.ran("npm")[0][1:] == ["audit", "--json", "--package-lock-only"]
    assert tools.ran("osv-scanner")[0][1:] == ["--format", "json", "--lockfile", "package-lock.json"]  # fmt: skip
    review = report.findings[0].as_review()
    assert review["source"] == "Semgrep" and review["file"] == "app/run.py" and review["line"] == 12
    assert report.public()["ran"] == ["Semgrep", "osv-scanner", "npm audit"]
    assert report.public()["high"] == 2


def test_results_are_cached_by_content(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)
    tools = Tools(monkeypatch)
    scanner = ss.Scanner(env=dict)
    first = scanner.scan(repo, list(diff_of(repo).values()))
    again = scanner.scan(repo, list(diff_of(repo).values()))
    assert [f.public() for f in again.findings] == [f.public() for f in first.findings]
    assert len(tools.calls) == 3  # each tool once
    (repo / "app/run.py").write_text(numbered(20).replace("line 12\n", "os.system(cmd)\n"))
    scanner.scan(repo, list(diff_of(repo).values()))
    assert len(tools.ran("semgrep")) == 2 and len(tools.calls) == 4  # only the file that changed


def test_a_project_with_its_own_semgrep_rules_uses_them(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)
    (repo / ".semgrep.yml").write_text("rules: []\n")
    tools = Tools(monkeypatch, installed=("semgrep",))
    ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    argv = tools.ran("semgrep")[0]
    assert argv[argv.index("--config") + 1] == str(repo / ".semgrep.yml")


def test_a_missing_tool_is_named_with_how_to_install_it(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)
    Tools(monkeypatch, installed=())
    report = ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    assert report.ran == [] and report.findings == []
    assert report.missing == ["semgrep", "osv-scanner", "npm-audit"]
    said = report.public()["missing"]
    assert said[0] == {"id": "semgrep", "label": "Semgrep", "install": ss.TOOLS["semgrep"][2]}
    assert "brew install semgrep" in ss.missing_line(report)
    # npm alone covers an npm lockfile: osv-scanner isn't missing then.
    Tools(monkeypatch, installed=("npm",))
    report = ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    assert report.missing == ["semgrep"] and report.ran == ["npm-audit"]
    assert [(f.tool, f.package) for f in report.findings] == [("npm audit", "lodash")]
    # Nothing a tool reads (a README): nothing to say at all.
    readme = make_repo(tmp_path / "docs", {"README.md": "hi\n"})
    (readme / "README.md").write_text("hello\n")
    assert ss.Scanner(env=dict).scan(readme, list(diff_of(readme).values())).empty


def test_a_failing_tool_is_said_and_never_raises(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)
    tools = Tools(
        monkeypatch,
        outputs={
            "semgrep": (124, "", "took too long"),
            "osv-scanner": (127, "", "osv-scanner: bad CPU type in executable"),
            "npm": (1, fixture("npm-audit-error.json"), ""),
        },
    )
    report = ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    assert report.findings == []
    assert report.errors[0] == "Semgrep: took too long"
    assert sorted(report.errors[1:]) == [
        "npm audit: This command requires an existing lockfile.",
        "osv-scanner: couldn't start",
    ]
    assert len(tools.ran("osv-scanner")) == 1  # (a tool that won't start isn't asked twice)
    again = ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    assert len(tools.ran("semgrep")) == 2 and again.errors  # failures aren't cached


def test_osv_scanner_2_is_asked_its_own_way(tmp_path, monkeypatch):
    repo = changed_project(tmp_path)

    def osv(argv, _cwd):
        if argv[1] == "scan":
            return 1, fixture("osv-scanner.json"), ""
        return 2, "", "unknown flag: --lockfile"

    tools = Tools(monkeypatch, installed=("osv-scanner",), outputs={"osv-scanner": osv})
    scanner = ss.Scanner(env=dict)
    report = scanner.scan(repo, list(diff_of(repo).values()))
    assert [f.package for f in report.findings] == ["lodash", "lodash"]
    assert [a[1:3] for a in tools.ran("osv-scanner")] == [["--format", "json"], ["scan", "source"]]
    ss.CACHE.clear()
    scanner.scan(repo, list(diff_of(repo).values()))
    assert tools.ran("osv-scanner")[-1][1:3] == ["scan", "source"]  # remembered


def test_pip_audit_reads_a_changed_requirements_file(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "py", {"requirements-dev.txt": "requests==2.31.0\n"})
    (repo / "requirements-dev.txt").write_text("requests==2.31.0\nflask==0.5\n")
    tools = Tools(monkeypatch, installed=("pip-audit", "osv-scanner"))
    report = ss.Scanner(env=dict).scan(repo, list(diff_of(repo).values()))
    assert tools.ran("pip-audit")[0][1:4] == ["-r", "requirements-dev.txt", "-f"]
    assert "--no-deps" in tools.ran("pip-audit")[0]
    # osv-scanner is told what a requirements file named otherwise is.
    assert tools.ran("osv-scanner")[0][-1] == "requirements.txt:requirements-dev.txt"
    assert [(f.tool, f.package, f.path, f.line) for f in report.findings] == [
        ("pip-audit", "flask", "requirements-dev.txt", 2)
    ]  # (osv-scanner's recorded lodash isn't in this change)


def test_commits_about_to_be_pushed_are_scanned_as_they_are_in_them(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "proj", {"app/run.py": numbered(20)})
    base = git(repo, "rev-parse", "HEAD").strip()
    committed = numbered(20).replace("line 12\n", "subprocess.run(cmd, shell=True)\n")
    (repo / "app/run.py").write_text(committed)
    git(repo, "commit", "-qam", "Run it")
    (repo / "app/run.py").write_text("# not committed\n" + committed)  # (shifts every line)
    seen = {}

    def semgrep(_argv, cwd):
        seen["cwd"], seen["text"] = cwd, (cwd / "app/run.py").read_text()
        return 0, SEMGREP_AT_12, ""

    Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": semgrep})
    report = ss.Scanner(env=dict).scan_commits(repo, base, "HEAD", lambda p: f"shown/{p}")
    assert seen["text"] == committed and seen["cwd"] != repo
    assert not seen["cwd"].exists()  # (the copy is gone afterwards)
    assert [(f.path, f.line) for f in report.findings] == [("shown/app/run.py", 12)]


def test_the_summary_lists_each_finding():
    f = ss.Finding("Semgrep", "code", "high", "a.py", 3, "Shell injection")
    assert ss.summary([f] * 6) == "\n".join(["• [high] Semgrep: Shell injection (a.py line 3)"] * 4 + ["…and 2 more."])  # fmt: skip
