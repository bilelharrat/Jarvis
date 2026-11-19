"""Security and dependency scanning of what a change adds, with the owner's own tools.

Beside the secret scan (secret_scan.py), the changed code and the new dependencies are
checked by whichever of these the owner has installed:

- Semgrep (static analysis): the changed files, read whole (a rule follows data through a
  file), but only findings on the lines the change added are kept. The rules are the
  project's own (.semgrep.yml, .semgrep.yaml or a .semgrep folder at its top) when it has
  them, else Semgrep's p/default set (fetched by Semgrep itself; its metrics are off).
- osv-scanner: every lockfile the change touched (package-lock.json, yarn.lock,
  pnpm-lock.yaml, poetry.lock, uv.lock, Pipfile.lock, requirements*.txt, Cargo.lock,
  go.mod, Gemfile.lock, composer.lock…), against the OSV database.
- npm audit: a changed package-lock.json (or package.json beside one), --package-lock-only.
- pip-audit: a changed requirements*.txt (pinned versions only: --no-deps, no pip run).

A dependency finding counts only when it's about a package the change added or changed
(named on an added line of the manifest or lockfile, or under the lockfile entry an added
line is in): a known vulnerability the project already had isn't this change's news. Each
is pinned to the line that brought the package in (the manifest's, else the lockfile's).

None of these is installed by Eden Code, and none is needed: a tool that isn't there is
named, with how to install it (INSTALL), and the scan goes on without it. A tool that
fails or times out is said and skipped; nothing here ever blocks. Results are cached by
the scanned files' contents (CACHE_SECONDS), so a receipt, a Deep review and a push of
the same work run each tool once.

Cost policy: no model calls. The tools run on this Mac; Semgrep fetches its rules, and
osv-scanner, npm audit and pip-audit ask their advisory databases, as they always do.

The parsers (parse_semgrep, parse_osv, parse_npm_audit, parse_pip_audit) are pure, and
tested against recorded outputs (tests/fixtures/security/), so the tests need none of the
tools.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any

from .code_changes import EMPTY_TREE, FileDiff, git

log = logging.getLogger("jarvis")

SEVERITIES = ("high", "medium", "low")  # as code_review's findings have them
MAX_FILES = 200  # changed files Semgrep reads at most
MAX_FILE_BYTES = 1_000_000  # a file bigger than this isn't read (generated, minified)
MAX_FINDINGS = 50
MAX_OUTPUT = 20_000_000  # characters of a tool's JSON read
CACHE_SECONDS = 6 * 3600  # advisories change; a day-old answer is asked again
CACHE_ENTRIES = 512
TIMEOUTS = {"semgrep": 150.0, "osv-scanner": 90.0, "npm-audit": 90.0, "pip-audit": 120.0}
TEXT_CHARS = 1200

# id -> (the name shown, what it checks, how to install it). Never installed by Eden Code.
TOOLS: dict[str, tuple[str, str, str]] = {
    "semgrep": (
        "Semgrep",
        "static analysis of the changed code",
        "brew install semgrep  (or: pipx install semgrep)",
    ),
    "osv-scanner": (
        "osv-scanner",
        "known vulnerabilities in any lockfile",
        "brew install osv-scanner  (or: go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest)",
    ),
    "npm-audit": (
        "npm audit",
        "known vulnerabilities in npm packages",
        "comes with Node.js: brew install node",
    ),
    "pip-audit": (
        "pip-audit",
        "known vulnerabilities in Python requirements",
        "pipx install pip-audit  (or: brew install pip-audit)",
    ),
}
COMMANDS = {"semgrep": "semgrep", "osv-scanner": "osv-scanner", "npm-audit": "npm", "pip-audit": "pip-audit"}  # fmt: skip

# What Semgrep reads: code and the config it has rules for.
CODE_SUFFIXES = {
    ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue",
    ".svelte", ".go", ".java", ".kt", ".kts", ".scala", ".rb", ".php", ".cs", ".rs",
    ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".sh", ".bash", ".zsh",
    ".lua", ".ex", ".exs", ".erl", ".dart", ".sol", ".tf", ".hcl", ".yaml", ".yml",
    ".html", ".htm", ".json", ".dockerfile",
}  # fmt: skip
CODE_NAMES = {"Dockerfile", "Containerfile", "Makefile"}
SEMGREP_CONFIGS = (".semgrep.yml", ".semgrep.yaml", ".semgrep")
SEMGREP_DEFAULT = "p/default"

# Dependency files: lockfiles (scanned) and manifests (what the change asked for).
NPM_LOCKS = ("package-lock.json", "npm-shrinkwrap.json")
LOCKFILES = {
    *NPM_LOCKS, "yarn.lock", "pnpm-lock.yaml", "bun.lock", "poetry.lock", "uv.lock",
    "Pipfile.lock", "pdm.lock", "Cargo.lock", "go.mod", "Gemfile.lock", "composer.lock",
    "pubspec.lock", "mix.lock", "gradle.lockfile", "packages.lock.json",
}  # fmt: skip
MANIFESTS = {
    "package.json": ("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"),
    "pyproject.toml": ("poetry.lock", "uv.lock", "pdm.lock"),
    "Pipfile": ("Pipfile.lock",),
    "Cargo.toml": ("Cargo.lock",),
    "Gemfile": ("Gemfile.lock",),
    "composer.json": ("composer.lock",),
    "pubspec.yaml": ("pubspec.lock",),
    "mix.exs": ("mix.lock",),
}  # fmt: skip
_REQUIREMENTS = re.compile(r"^(?:requirements|constraints)[\w.-]*\.(?:txt|in)$", re.I)

# The lines of a dependency file that name a package: "header" opens a package's entry
# (the lines under it, its version and hash, are that package's); "inline" names one on
# the line itself. Rough on purpose: an extra name only widens what's kept a little.
_JSON_KEY_BLOCK = re.compile(r'^\s*"(?:[^"]*node_modules/)?((?:@[^/"]+/)?[^/"]+)"\s*:\s*\{')
_JSON_KEY_VALUE = re.compile(r'"((?:@[^/"\s]+/)?[A-Za-z0-9][\w.-]*)"\s*:\s*"[^"]*"')
_TOML_NAME = re.compile(r'^\s*name\s*=\s*"([^"]+)"')
_TOML_KEY = re.compile(r"^\s*([A-Za-z0-9][\w.-]*)\s*=\s*[\"'{]")
_PEP508 = re.compile(r"""["']([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!]=?|@|;)""")
_REQ_LINE = re.compile(r"^\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!]=|===|[<>]|@|;|$)")
_YARN = re.compile(r'^"?((?:@[^@/\s"]+/)?[^@\s",]+)@')
_PNPM = re.compile(r"^\s+'?/?((?:@[^/\s']+/)?[^@/\s:']+)[@/]\d")
_GEM = re.compile(r"^\s{4}([A-Za-z0-9][\w.-]*) \(")
_GO = re.compile(r"^\s*(?:require\s+)?([\w.~-]+\.[\w.~/-]+)\s+v\d")
_COMPOSER = re.compile(r'^\s*"name"\s*:\s*"([^"/]+/[^"]+)"')
_SYNTAX: dict[str, tuple[re.Pattern[str] | None, tuple[re.Pattern[str], ...]]] = {
    "npm-lock": (_JSON_KEY_BLOCK, (_JSON_KEY_VALUE,)),
    "package.json": (None, (_JSON_KEY_VALUE,)),
    "yarn": (_YARN, ()),
    "pnpm": (_PNPM, ()),
    "toml-lock": (_TOML_NAME, ()),
    "toml-manifest": (None, (_TOML_KEY, _PEP508)),
    "json-lock": (_JSON_KEY_BLOCK, (_COMPOSER,)),
    "requirements": (None, (_REQ_LINE,)),
    "gem": (_GEM, ()),
    "go": (None, (_GO,)),
    "yaml-lock": (re.compile(r"^\s{2}([A-Za-z0-9][\w.-]*):\s*$"), ()),
}
# Keys of a JSON manifest or lockfile that are never a package's name.
_NOT_NAMES = {
    "name", "version", "resolved", "integrity", "dev", "optional", "peer", "license",
    "engines", "bin", "funding", "requires", "dependencies", "devdependencies",
    "peerdependencies", "optionaldependencies", "lockfileversion", "packages",
    "hasinstallscript", "cpu", "os", "main", "description", "scripts", "type", "author",
    "private", "workspaces", "repository", "homepage", "keywords", "files", "exports",
    "module", "types", "overrides", "resolutions", "node", "npm", "link", "url", "reference",
    "shasum", "dist", "source", "require", "require-dev", "content-hash", "markers", "hashes",
    "index", "extras",
}  # fmt: skip
_KIND_OF = {
    "package-lock.json": "npm-lock", "npm-shrinkwrap.json": "npm-lock", "bun.lock": "npm-lock",
    "package.json": "package.json", "yarn.lock": "yarn", "pnpm-lock.yaml": "pnpm",
    "poetry.lock": "toml-lock", "uv.lock": "toml-lock", "pdm.lock": "toml-lock",
    "Cargo.lock": "toml-lock", "pyproject.toml": "toml-manifest", "Cargo.toml": "toml-manifest",
    "Pipfile": "toml-manifest", "Pipfile.lock": "json-lock", "composer.lock": "json-lock",
    "composer.json": "package.json", "packages.lock.json": "json-lock", "Gemfile.lock": "gem",
    "Gemfile": "gem", "go.mod": "go", "pubspec.lock": "yaml-lock", "pubspec.yaml": "yaml-lock",
}  # fmt: skip


# ── what's found ──


@dataclass(frozen=True)
class Finding:
    tool: str  # the name shown: Semgrep, osv-scanner, npm audit, pip-audit
    kind: str  # code | dependency
    severity: str  # high | medium | low
    path: str  # as the owner sees it (shown)
    line: int  # in the new file (0: the whole file)
    title: str
    detail: str = ""
    fix: str = ""
    rule: str = ""  # Semgrep's rule id, or the advisory's id
    package: str = ""
    version: str = ""
    ids: tuple[str, ...] = ()
    url: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "kind": self.kind,
            "severity": self.severity,
            "path": self.path,
            "line": self.line,
            "title": self.title,
            "detail": self.detail,
            "fix": self.fix,
            "rule": self.rule,
            "package": self.package,
            "version": self.version,
            "ids": list(self.ids),
            "url": self.url,
        }

    def as_review(self) -> dict[str, Any]:
        """As code_review's findings are (its pins, Fix this, the verifier's listing)."""
        return {
            "severity": self.severity,
            "file": self.path,
            "line": self.line,
            "title": self.title[:160],
            "detail": self.detail[:TEXT_CHARS],
            "fix": self.fix[:TEXT_CHARS],
            "source": self.tool,
            "rule": self.rule,
        }

    def said(self) -> str:
        where = f"{self.path} line {self.line}" if self.line else self.path
        return f"[{self.severity}] {self.tool}: {self.title} ({where})"


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    ran: list[str] = field(default_factory=list)  # tool ids that ran
    missing: list[str] = field(default_factory=list)  # tool ids that would have, not installed
    errors: list[str] = field(default_factory=list)  # "Semgrep: took too long"
    checked: int = 0  # files and lockfiles looked at

    @property
    def high(self) -> int:
        return sum(1 for f in self.findings if f.severity == "high")

    @property
    def empty(self) -> bool:
        """Nothing ran and nothing would have: say nothing at all."""
        return not (self.ran or self.missing or self.errors or self.findings)

    def public(self, limit: int = 12) -> dict[str, Any]:
        return {
            "count": len(self.findings),
            "high": self.high,
            "findings": [f.public() for f in self.findings[:limit]],
            "ran": [TOOLS[t][0] for t in self.ran],
            "missing": [
                {"id": t, "label": TOOLS[t][0], "install": TOOLS[t][2]} for t in self.missing
            ],
            "errors": self.errors[:4],
        }


def summary(findings: list[Finding], limit: int = 4) -> str:
    """A card's detail: each finding on a line, and how many more."""
    lines = [f"• {f.said()}" for f in findings[:limit]]
    more = len(findings) - limit
    if more > 0:
        lines.append(f"…and {more} more.")
    return "\n".join(lines)


def missing_line(report: Report) -> str:
    """The tools that would have checked this and aren't installed, with how to get them."""
    return "; ".join(f"{TOOLS[t][0]} isn't installed ({TOOLS[t][2]})" for t in report.missing)


# ── the parsers (pure: a tool's JSON in, findings out) ──


def _json(text: str) -> Any:
    """The JSON a tool printed, after anything it said before it."""
    text = (text or "")[:MAX_OUTPUT]
    start = min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=-1)
    if start < 0:
        return None
    try:
        return json.loads(text[start:])
    except ValueError:
        return None


def _clip(text: Any, n: int = TEXT_CHARS) -> str:
    return " ".join(str(text or "").split())[:n]


def _first_sentence(text: str, n: int = 160) -> str:
    text = _clip(text, 600)
    m = re.match(r"(.+?[.!?])(?:\s|$)", text)
    return (m.group(1) if m else text)[:n].rstrip()


_SEMGREP_SEVERITY = {"ERROR": "high", "CRITICAL": "high", "HIGH": "high", "WARNING": "medium",
                     "MEDIUM": "medium", "INFO": "low", "LOW": "low", "INVENTORY": "low"}  # fmt: skip


@dataclass(frozen=True)
class Raw:
    """One Semgrep result before it's scoped: where it is and what it says."""

    path: str
    start: int
    end: int
    finding: Finding


def parse_semgrep(text: str) -> tuple[list[Raw], list[str]]:
    """Semgrep's --json: (results, errors). A result's lines run start..end; its path is
    as Semgrep was given it."""
    data = _json(text)
    if not isinstance(data, dict):
        return [], ["Semgrep said something that isn't its JSON"]
    out: list[Raw] = []
    for r in data.get("results") or []:
        if not isinstance(r, dict):
            continue
        extra = r.get("extra") if isinstance(r.get("extra"), dict) else {}
        meta = extra.get("metadata") if isinstance(extra.get("metadata"), dict) else {}
        try:
            start = int((r.get("start") or {}).get("line") or 0)
            end = int((r.get("end") or {}).get("line") or start)
        except (TypeError, ValueError, AttributeError):
            continue
        rule = str(r.get("check_id") or "")
        message = _clip(extra.get("message"))
        if not rule or not message:
            continue
        cwe = meta.get("cwe")
        cwe = cwe[0] if isinstance(cwe, list) and cwe else cwe
        cwe_id = re.match(r"CWE-\d+", str(cwe or ""))
        short = rule.rsplit(".", 1)[-1]
        detail = (
            message + f" (Semgrep rule {short}" + (f", {cwe_id.group(0)}" if cwe_id else "") + ")"
        )
        fix = _clip(extra.get("fix"), 400)
        refs = meta.get("references") if isinstance(meta.get("references"), list) else []
        url = str(meta.get("source") or meta.get("shortlink") or (refs[0] if refs else ""))
        finding = Finding(
            tool="Semgrep",
            kind="code",
            severity=_SEMGREP_SEVERITY.get(str(extra.get("severity") or "").upper(), "medium"),
            path=str(r.get("path") or ""),
            line=max(start, 0),
            title=_first_sentence(message),
            detail=detail[:TEXT_CHARS],
            fix=f"Semgrep suggests replacing it with: {fix}" if fix else "",
            rule=rule,
            url=url[:300] if url.startswith("https://") else "",
        )
        out.append(Raw(finding.path, max(start, 0), max(end, start, 0), finding))
    errors = []
    for e in data.get("errors") or []:
        if isinstance(e, dict) and str(e.get("level") or "error").lower() == "error":
            errors.append(f"Semgrep: {_clip(e.get('message') or e.get('type'), 160)}")
    return out, errors[:3]


def _osv_severity(vuln: dict[str, Any], group_max: str) -> str:
    said = str((vuln.get("database_specific") or {}).get("severity") or "").upper()
    if said in ("CRITICAL", "HIGH"):
        return "high"
    if said in ("MODERATE", "MEDIUM"):
        return "medium"
    if said == "LOW":
        return "low"
    try:
        score = float(group_max)
    except (TypeError, ValueError):
        return "medium"
    return "high" if score >= 7 else "medium" if score >= 4 else "low"


def _osv_fixed(vuln: dict[str, Any], name: str) -> list[str]:
    fixed: list[str] = []
    for affected in vuln.get("affected") or []:
        if not isinstance(affected, dict):
            continue
        pkg = affected.get("package") or {}
        if norm(str(pkg.get("name") or "")) not in ("", norm(name)):
            continue
        for rng in affected.get("ranges") or []:
            for ev in (rng or {}).get("events") or []:
                if isinstance(ev, dict) and ev.get("fixed"):
                    fixed.append(str(ev["fixed"]))
    return list(dict.fromkeys(fixed))


@dataclass(frozen=True)
class Vuln:
    """One known vulnerability in one package, before it's scoped and pinned."""

    tool: str
    source: str  # the lockfile it was found through (as the tool said it)
    package: str
    version: str
    severity: str
    id: str
    aliases: tuple[str, ...]
    summary: str
    fixed: tuple[str, ...] = ()
    url: str = ""


def parse_osv(text: str) -> list[Vuln]:
    """osv-scanner's --format json (v1 and v2 alike)."""
    data = _json(text)
    results = data.get("results") if isinstance(data, dict) else None
    out: list[Vuln] = []
    for result in results if isinstance(results, list) else []:
        source = str(((result or {}).get("source") or {}).get("path") or "")
        for pkg in (result or {}).get("packages") or []:
            info = (pkg or {}).get("package") or {}
            name, version = str(info.get("name") or ""), str(info.get("version") or "")
            groups = {
                i: str(g.get("max_severity") or "")
                for g in (pkg or {}).get("groups") or []
                if isinstance(g, dict)
                for i in g.get("ids") or []
            }
            for v in (pkg or {}).get("vulnerabilities") or []:
                if not isinstance(v, dict) or not v.get("id") or not name:
                    continue
                vid = str(v["id"])
                out.append(
                    Vuln(
                        tool="osv-scanner",
                        source=source,
                        package=name,
                        version=version,
                        severity=_osv_severity(v, groups.get(vid, "")),
                        id=vid,
                        aliases=tuple(str(a) for a in v.get("aliases") or []),
                        summary=_clip(v.get("summary") or v.get("details"), 300),
                        fixed=tuple(_osv_fixed(v, name)),
                        url=f"https://osv.dev/vulnerability/{vid}",
                    )
                )
    return out


_NPM_SEVERITY = {"critical": "high", "high": "high", "moderate": "medium", "low": "low", "info": "low"}  # fmt: skip


def parse_npm_audit(text: str, source: str = "package-lock.json") -> tuple[list[Vuln], list[str]]:
    """npm audit --json (npm 7 and later). An entry is kept when it has an advisory of its
    own (a "via" that's an object); one that's only vulnerable through another package
    (its vias are names) is that package's finding, not a second one."""
    data = _json(text)
    if not isinstance(data, dict):
        return [], ["npm audit said something that isn't its JSON"]
    if isinstance(data.get("error"), dict):
        return [], [
            f"npm audit: {_clip(data['error'].get('summary') or data['error'].get('code'), 160)}"
        ]
    out: list[Vuln] = []
    for name, entry in (data.get("vulnerabilities") or {}).items():
        if not isinstance(entry, dict):
            continue
        fix = entry.get("fixAvailable")
        fixed = (
            (str(fix.get("version")),) if isinstance(fix, dict) and fix.get("name") == name else ()
        )
        for via in entry.get("via") or []:
            if not isinstance(via, dict):
                continue
            url = str(via.get("url") or "")
            ghsa = url.rsplit("/", 1)[-1] if "/advisories/GHSA-" in url else ""
            out.append(
                Vuln(
                    tool="npm audit",
                    source=source,
                    package=str(via.get("name") or name),
                    version=str(via.get("range") or entry.get("range") or ""),
                    severity=_NPM_SEVERITY.get(
                        str(via.get("severity") or entry.get("severity")), "medium"
                    ),
                    id=ghsa or str(via.get("source") or ""),
                    aliases=(),
                    summary=_clip(via.get("title"), 300),
                    fixed=fixed,
                    url=url if url.startswith("https://") else "",
                )
            )
    return out, []


def parse_pip_audit(text: str, source: str = "requirements.txt") -> list[Vuln]:
    """pip-audit -f json: {"dependencies": [...]} (2.x) or the bare list (1.x)."""
    data = _json(text)
    deps = data.get("dependencies") if isinstance(data, dict) else data
    out: list[Vuln] = []
    for dep in deps if isinstance(deps, list) else []:
        if not isinstance(dep, dict):
            continue
        for v in dep.get("vulns") or []:
            if not isinstance(v, dict) or not v.get("id"):
                continue
            out.append(
                Vuln(
                    tool="pip-audit",
                    source=source,
                    package=str(dep.get("name") or ""),
                    version=str(dep.get("version") or ""),
                    severity="medium",  # (pip-audit says no severity)
                    id=str(v["id"]),
                    aliases=tuple(str(a) for a in v.get("aliases") or []),
                    summary=_first_sentence(v.get("description") or "", 300),
                    fixed=tuple(str(x) for x in v.get("fix_versions") or []),
                    url=f"https://osv.dev/vulnerability/{v['id']}",
                )
            )
    return out


# ── what the change added ──


def norm(name: str) -> str:
    """A package name as registries compare them (PEP 503 for Python: case, - _ . alike)."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def added_lines(f: FileDiff) -> set[int]:
    """The new file's lines this diff added."""
    out: set[int] = set()
    for h in f.hunks:
        line = h.new_start
        for tag, _text in h.lines:
            if tag == "+":
                out.add(line)
            if tag in " +":
                line += 1
    return out


def dependency_kind(path: str) -> str:
    """lockfile | manifest | requirements | "" (not a dependency file)."""
    name = PurePosixPath(path).name
    if _REQUIREMENTS.match(name):
        return "requirements"
    if name in LOCKFILES:
        return "lockfile"
    if name in MANIFESTS:
        return "manifest"
    return ""


def dependency_names(f: FileDiff) -> dict[str, int]:
    """The packages a manifest's or lockfile's diff adds or changes: norm(name) -> the
    first added line that brings it in."""
    name = PurePosixPath(f.path).name
    syntax = "requirements" if _REQUIREMENTS.match(name) else _KIND_OF.get(name, "")
    header, inline = _SYNTAX.get(syntax, (None, ()))
    found: dict[str, int] = {}
    for h in f.hunks:
        line, current = h.new_start, ""
        for tag, text in h.lines:
            if tag not in " +":
                continue
            opened = header.match(text) if header else None
            if opened:
                current = opened.group(1)
            if tag == "+":
                names = [m.group(1) for p in inline for m in p.finditer(text)]
                # (a lockfile's added version or hash line is the entry's it's under)
                names += [opened.group(1)] if opened else [current] if current else []
                for n in names:
                    if n and norm(n) not in _NOT_NAMES:
                        found.setdefault(norm(n), line)
            line += 1
    return found


def is_code(path: str) -> bool:
    p = PurePosixPath(path)
    return p.suffix.lower() in CODE_SUFFIXES or p.name in CODE_NAMES


# ── running the tools ──


def default_env() -> dict[str, str]:
    """The owner's login shell's environment, as a terminal has it (Homebrew, pipx and nvm
    on the PATH), which an app started from the Dock doesn't have. (The tests put the
    test's own here: no login shell is asked in a test.)"""
    from . import runproc

    return runproc.shell_env()


def find_tool(command: str, env: dict[str, str], root: Path) -> str | None:
    """Where a tool is: the project's own (.venv, node_modules/.bin), else on the PATH.
    (The tests put a fake here: no real tool runs in a test.)"""
    for rel in (f".venv/bin/{command}", f"venv/bin/{command}", f"node_modules/.bin/{command}"):
        if command != "npm" and (root / rel).is_file() and os.access(root / rel, os.X_OK):
            return str(root / rel)
    return shutil.which(command, path=env.get("PATH", ""))


def run(argv: list[str], cwd: Path, env: dict[str, str], timeout: float) -> tuple[int, str, str]:
    """One tool, its output read: (exit code, stdout, stderr). Never raises: a timeout is
    124, a tool that won't start 127. (The tests put a fake here.)"""
    try:
        proc = subprocess.run(  # noqa: S603 - the owner's own tool, given file paths only
            argv,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except subprocess.TimeoutExpired:
        return 124, "", "took too long"
    except OSError as exc:
        return 127, "", str(exc)
    return proc.returncode, proc.stdout[:MAX_OUTPUT], proc.stderr[-4000:]


class Cache:
    """Results by what was scanned (the tool, its settings and the files' contents), kept
    CACHE_SECONDS, at most CACHE_ENTRIES: the same work scanned for its receipt, its Deep
    review and its push runs each tool once."""

    def __init__(self) -> None:
        self._items: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Any:
        with self._lock:
            item = self._items.get(key)
            if item is None or time.monotonic() - item[0] > CACHE_SECONDS:
                self._items.pop(key, None)
                return None
            self._items.move_to_end(key)
            return item[1]

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._items[key] = (time.monotonic(), value)
            self._items.move_to_end(key)
            while len(self._items) > CACHE_ENTRIES:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


CACHE = Cache()


def _digest(*parts: bytes | str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode() if isinstance(p, str) else p)
        h.update(b"\0")
    return h.hexdigest()


def _read(path: Path) -> bytes | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES * 20:
            return None
        return path.read_bytes()
    except OSError:
        return None


class Scanner:
    """The tools the owner has, run on a change. env() is the environment they run in (the
    owner's login shell's, as a terminal has it: Homebrew, pipx and nvm on the PATH)."""

    def __init__(self, env: Callable[[], dict[str, str]] | None = None) -> None:
        self.env = env or (lambda: default_env())
        self.cache = CACHE
        self._osv_v2: dict[str, bool] = {}  # osv-scanner's path -> it wants "scan source"

    def tools(self, root: Path) -> dict[str, str | None]:
        """Each tool's path, or None when it isn't installed."""
        env = self.env()
        return {tid: find_tool(cmd, env, root) for tid, cmd in COMMANDS.items()}

    def scan(
        self,
        root: Path,
        files: list[FileDiff],
        shown: Callable[[str], str] | None = None,
        config_root: Path | None = None,
    ) -> Report:
        """The change (files, paths relative to root, root holding them as they are now)
        checked by every tool that applies and is installed. config_root: where the
        project's own Semgrep rules are looked for (root, unless the files were copied
        out of it)."""
        name = shown or (lambda p: p)
        report = Report()
        code: list[tuple[FileDiff, set[int]]] = []
        deps: list[FileDiff] = []
        for f in files:
            if f.status == "D" or f.binary or f.sensitive:
                continue
            if dependency_kind(f.path):
                deps.append(f)
            if is_code(f.path) and not dependency_kind(f.path):
                lines = added_lines(f)
                if lines:
                    code.append((f, lines))
        code = code[:MAX_FILES]
        locks = self._lockfiles(root, deps)
        if not code and not locks:
            return report
        env = self.env()
        have = {tid: find_tool(cmd, env, root) for tid, cmd in COMMANDS.items()}
        # Each tool's job, given a report of its own for what it has to say (its errors),
        # so what's said is in the same order however the tools finish.
        jobs: list[tuple[str, Callable[[Report], list[Finding]]]] = []
        if code:
            if have["semgrep"]:
                jobs.append(("semgrep", lambda part: self._semgrep(have["semgrep"], root, code, config_root or root, env, part, name)))  # fmt: skip
            else:
                report.missing.append("semgrep")
        if locks:
            names = self._new_names(deps)
            npm = [lk for lk in locks if PurePosixPath(lk).name in NPM_LOCKS]
            reqs = [lk for lk in locks if _REQUIREMENTS.match(PurePosixPath(lk).name)]
            if have["osv-scanner"]:
                jobs.append(("osv-scanner", lambda part: self._deps("osv-scanner", have["osv-scanner"], root, locks, env, part, names, name)))  # fmt: skip
            if npm and have["npm-audit"]:
                jobs.append(("npm-audit", lambda part: self._deps("npm-audit", have["npm-audit"], root, npm, env, part, names, name)))  # fmt: skip
            if reqs and have["pip-audit"]:
                jobs.append(("pip-audit", lambda part: self._deps("pip-audit", have["pip-audit"], root, reqs, env, part, names, name)))  # fmt: skip
            if not have["osv-scanner"]:
                covered = (not npm or have["npm-audit"]) and (not reqs or have["pip-audit"])
                others = [lk for lk in locks if lk not in npm and lk not in reqs]
                if others or not covered:
                    report.missing.append("osv-scanner")
                    if npm and not have["npm-audit"]:
                        report.missing.append("npm-audit")
                    if reqs and not have["pip-audit"]:
                        report.missing.append("pip-audit")
        report.checked = len(code) + len(locks)
        found: list[Finding] = []
        if jobs:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as pool:
                parts = [Report() for _ in jobs]
                futures = [
                    (tid, part, pool.submit(job, part))
                    for (tid, job), part in zip(jobs, parts, strict=True)
                ]
                for tid, part, fut in futures:
                    try:
                        found += fut.result()
                    except Exception as exc:  # a parser's surprise: said, never raised
                        log.warning("security scan: %s failed: %s", tid, exc)
                        part.errors.append(f"{TOOLS[tid][0]}: {str(exc)[:160]}")
                    else:
                        report.ran.append(tid)
                    report.errors += part.errors
        report.findings = _dedupe(found)[:MAX_FINDINGS]
        return report

    # ── Semgrep ──

    def _semgrep(
        self,
        exe: str,
        root: Path,
        code: list[tuple[FileDiff, set[int]]],
        config_root: Path,
        env: dict[str, str],
        report: Report,
        shown: Callable[[str], str],
    ) -> list[Finding]:
        config = next(
            (str(config_root / c) for c in SEMGREP_CONFIGS if (config_root / c).exists()),
            SEMGREP_DEFAULT,
        )
        config_key = config if config == SEMGREP_DEFAULT else _digest(*_config_bytes(Path(config)))
        results: dict[str, list[Raw]] = {}
        todo: list[str] = []
        keys: dict[str, str] = {}
        for f, _lines in code:
            body = _read(root / f.path)
            if body is None or len(body) > MAX_FILE_BYTES:
                continue
            keys[f.path] = _digest("semgrep", config_key, f.path, body)
            cached = self.cache.get(keys[f.path])
            if cached is None:
                todo.append(f.path)
            else:
                results[f.path] = cached
        if todo:
            argv = [
                exe, "scan", "--json", "--quiet", "--metrics=off", "--disable-version-check",
                "--timeout", "20", "--config", config, "--", *todo,
            ]  # fmt: skip
            status, out, err = run(
                argv, root, {**env, "SEMGREP_SEND_METRICS": "off"}, TIMEOUTS["semgrep"]
            )
            raws, errors = parse_semgrep(out) if out.strip() else ([], [])
            if status in (124, 127) or _json(out) is None:
                report.errors.append(f"Semgrep: {_said_error(status, err)}")
            else:
                report.errors += errors
                by_path: dict[str, list[Raw]] = {p: [] for p in todo}
                for raw in raws:
                    p = raw.path.removeprefix("./")
                    if p in by_path:
                        by_path[p].append(raw)
                for p, items in by_path.items():
                    results[p] = items
                    if not errors:  # (a file Semgrep couldn't read is asked again next time)
                        self.cache.put(keys[p], items)
        out_findings: list[Finding] = []
        for f, lines in code:
            for raw in results.get(f.path, []):
                if any(n in lines for n in range(raw.start, raw.end + 1)):
                    out_findings.append(replace(raw.finding, path=shown(f.path)))
        return out_findings

    # ── dependencies ──

    def _lockfiles(self, root: Path, deps: list[FileDiff]) -> list[str]:
        """The lockfiles to scan, root-relative: each changed one, and the one beside each
        changed manifest."""
        out: list[str] = []
        for f in deps:
            kind = dependency_kind(f.path)
            if kind in ("lockfile", "requirements"):
                out.append(f.path)
            elif kind == "manifest":
                parent = PurePosixPath(f.path).parent
                for lock in MANIFESTS[PurePosixPath(f.path).name]:
                    rel = str(parent / lock) if str(parent) != "." else lock
                    if (root / rel).is_file():
                        out.append(rel)
        return [p for p in dict.fromkeys(out) if (root / p).is_file()]

    @staticmethod
    def _new_names(deps: list[FileDiff]) -> dict[str, dict[str, tuple[str, int]]]:
        """For each folder, the packages its dependency files' diffs bring in: norm(name)
        -> (the path, the line), a manifest's line before a lockfile's."""
        by_dir: dict[str, dict[str, tuple[str, int]]] = {}
        ordered = sorted(deps, key=lambda f: dependency_kind(f.path) != "manifest")
        for f in ordered:
            folder = str(PurePosixPath(f.path).parent)
            names = by_dir.setdefault(folder, {})
            for n, line in dependency_names(f).items():
                names.setdefault(n, (f.path, line))
        return by_dir

    def _deps(
        self,
        tid: str,
        exe: str,
        root: Path,
        locks: list[str],
        env: dict[str, str],
        report: Report,
        names: dict[str, dict[str, tuple[str, int]]],
        shown: Callable[[str], str],
    ) -> list[Finding]:
        out: list[Finding] = []
        for lock in locks:
            vulns = self._dep_vulns(tid, exe, root, lock, env, report)
            if vulns is None:
                continue
            folder = str(PurePosixPath(lock).parent)
            wanted = names.get(folder, {})
            for v in vulns:
                pin = wanted.get(norm(v.package))
                if pin is None:
                    continue  # the project had it before this change
                out.append(_dep_finding(v, shown(pin[0]), pin[1]))
        return out

    def _dep_vulns(
        self, tid: str, exe: str, root: Path, lock: str, env: dict[str, str], report: Report
    ) -> list[Vuln] | None:
        body = _read(root / lock)
        if body is None:
            return None
        sibling = (
            _read(root / PurePosixPath(lock).parent / "package.json") if tid == "npm-audit" else b""
        )
        key = _digest(tid, lock, body, sibling or b"")
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        folder = root / PurePosixPath(lock).parent
        name = PurePosixPath(lock).name
        if tid == "osv-scanner":
            target = (
                f"requirements.txt:{name}"
                if _REQUIREMENTS.match(name) and name != "requirements.txt"
                else name
            )
            v1 = [exe, "--format", "json", "--lockfile", target]
            v2 = [exe, "scan", "source", "--format", "json", "--lockfile", target]
            argv = v2 if self._osv_v2.get(exe) else v1
            status, out, err = run(argv, folder, env, TIMEOUTS[tid])
            if _json(out) is None and status not in (124, 127, 128) and argv is v1:
                status, out, err = run(v2, folder, env, TIMEOUTS[tid])
                if _json(out) is not None:
                    self._osv_v2[exe] = True
            if status == 128:  # no packages in it
                vulns: list[Vuln] = []
            elif _json(out) is None:
                report.errors.append(f"osv-scanner: {_said_error(status, err)}")
                return None
            else:
                vulns = parse_osv(out)
        elif tid == "npm-audit":
            if not (folder / "package.json").is_file():
                return None
            status, out, err = run(
                [exe, "audit", "--json", "--package-lock-only"], folder, env, TIMEOUTS[tid]
            )
            if _json(out) is None:
                report.errors.append(f"npm audit: {_said_error(status, err)}")
                return None
            vulns, errors = parse_npm_audit(out, lock)
            if errors:
                report.errors += errors
                return None
        else:
            argv = [
                exe,
                "-r",
                name,
                "-f",
                "json",
                "--progress-spinner",
                "off",
                "--no-deps",
                "--disable-pip",
            ]
            status, out, err = run(argv, folder, env, TIMEOUTS[tid])
            if _json(out) is None:
                report.errors.append(f"pip-audit: {_said_error(status, err)}")
                return None
            vulns = parse_pip_audit(out, lock)
        self.cache.put(key, vulns)
        return vulns

    # ── commits about to be pushed ──

    def scan_commits(
        self, top: Path, base: str, head: str = "HEAD", shown: Callable[[str], str] | None = None
    ) -> Report:
        """What base..head adds, as head has it: its changed files copied out of git into
        a temporary folder and scanned there (the working tree may hold other, uncommitted
        edits, and its line numbers would then be wrong)."""
        diff = git(
            top, "diff", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "-M",
            base or EMPTY_TREE, head, timeout=60,
        )  # fmt: skip
        if not diff.ok:
            return Report()
        from .code_changes import parse_patch
        from .computer import is_sensitive

        files = [f for f in parse_patch(diff.out) if not is_sensitive(top / f.path)]
        wanted: list[str] = []
        for f in files:
            if f.status == "D" or f.binary:
                continue
            if is_code(f.path) or dependency_kind(f.path):
                wanted.append(f.path)
            if dependency_kind(f.path):
                parent = PurePosixPath(f.path).parent
                kin = MANIFESTS.get(PurePosixPath(f.path).name, ()) + ("package.json",)
                wanted += [str(parent / k) if str(parent) != "." else k for k in kin]
        if not wanted:
            return Report()
        with tempfile.TemporaryDirectory(prefix="eden-security-") as tmp:
            root = Path(tmp)
            for path in dict.fromkeys(wanted[: MAX_FILES * 2]):
                shown_blob = git(top, "show", f"{head}:{path}", timeout=30)
                if not shown_blob.ok or len(shown_blob.out) > MAX_FILE_BYTES * 20:
                    continue
                dest = root / path
                try:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(shown_blob.out, encoding="utf-8")
                except OSError:
                    continue
            return self.scan(root, files, shown, config_root=top)


def _config_bytes(path: Path) -> list[bytes]:
    if path.is_file():
        return [_read(path) or b""]
    try:
        return [_read(p) or b"" for p in sorted(path.rglob("*.y*ml"))[:100]]
    except OSError:
        return []


def _said_error(code: int, err: str) -> str:
    if code == 124:
        return "took too long"
    if code == 127:
        return "couldn't start"
    last = [line for line in (err or "").splitlines() if line.strip()]
    return _clip(last[-1] if last else f"stopped with code {code}", 160)


def _dep_finding(v: Vuln, path: str, line: int) -> Finding:
    ids = tuple(dict.fromkeys([v.id, *v.aliases]))
    cve = next((i for i in ids if i.startswith("CVE-")), "")
    shown_id = cve or v.id
    title = f"{v.package} {v.version}: {v.summary or shown_id}".strip()
    detail = f"{v.summary or 'A known vulnerability'} ({', '.join(ids[:4])}; found by {v.tool})."
    if v.fixed:
        detail += f" Fixed in {', '.join(v.fixed[:3])}."
        fix = f"Upgrade {v.package} to {v.fixed[0]} or later."
    else:
        fix = f"No fixed version of {v.package} is published yet: avoid the affected versions or use another package."
    return Finding(
        tool=v.tool,
        kind="dependency",
        severity=v.severity,
        path=path,
        line=line,
        title=title[:160],
        detail=detail[:TEXT_CHARS],
        fix=fix,
        rule=shown_id,
        package=v.package,
        version=v.version,
        ids=ids,
        url=v.url,
    )


def _dedupe(findings: list[Finding]) -> list[Finding]:
    """Each problem once: a vulnerability two tools found (by any of its ids, in the same
    package), a rule's finding on one line once; the worst first."""
    out: list[Finding] = []
    seen: set[tuple[str, ...]] = set()
    for f in findings:
        if f.kind == "dependency":
            keys = {("dep", norm(f.package), i) for i in f.ids or (f.title,)}
        else:
            keys = {("code", f.path, str(f.line), f.rule)}
        if keys & seen:
            continue
        seen |= keys
        out.append(f)
    out.sort(key=lambda f: (SEVERITIES.index(f.severity), f.kind != "code", f.path, f.line))
    return out
