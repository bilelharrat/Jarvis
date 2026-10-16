"""Eden Code's evals for the owner's own repository: the parts with no hub in them (the
feature is features/code_repo_evals.py, its pane web/features/code-evals.js).

An eval case is a past task of the owner's, made repeatable: the commit it started from, the
prompt it was given, and a check that says whether a new attempt did it. The check is either
the tests the landed change itself added or changed (they are copied into the attempt's
folder after it's done, as SWE-bench does, so the attempt never sees them and can't write to
pass them), run with the project's own test runner, or a command the owner writes. A case can
be calibrated: its check run at the starting commit (it should fail there, else it can't tell
a good attempt from no attempt) and at the landed commit (it should pass there, else the
check itself is wrong). Calibrating runs the project's tests only: it costs nothing.

A run is a suite of cases against one to MAX_CONFIGS configurations (the model, the effort,
the Claude Code engine, Eden's full prompt or Claude Code's own lean one, the project's rules
on or off, or the Model Router's pick), each attempt in a throwaway git worktree of its own
at the case's starting commit (detached: no branch is made in the owner's repository, and
the worktree is removed when the attempt is scored). Every attempt is scored on pass/fail,
cost, time and diff size, and the configurations are compared side by side.

The results format other features read (the engine radar, say), FORMAT, one JSON file per
run in <feature folder>/runs/<run id>.json and from CodeEvals.results():

    {"format": "eden-code-evals/1", "run": "r1a2b3c", "project": "<folder name>",
     "project_hash": "<12 hex: the SHA-256 of the project's folder, as the Model Router's and
                      the radar's logs name a project>",
     "started": <epoch s>, "finished": <epoch s or null>, "status": "running|done|stopped",
     "ceiling_usd": 10.0, "spent_usd": 1.23,
     "configs": [{"id": "c1", "label": "Sonnet 5.5 · high", "model": "<ref>",
                  "model_id": "claude-sonnet-5-5", "effort": "high", "engine": "<path or ''>",
                  "engine_version": "2.1.3 or ''", "prompt": "full|lean", "rules": "on|off",
                  "router": false}],
     "results": [{"case": "e…", "config": "c1", "status": "passed|failed|error|skipped",
                  "passed": true, "cost_usd": 0.42, "seconds": 95.0, "files": 2,
                  "added": 30, "removed": 4, "check_code": 0, "error": ""}],
     "summary": {"c1": {"label": …, "total": 20, "passed": 14, "failed": 5, "errors": 1,
                        "skipped": 0, "pass_rate": 0.7, "cost_usd": 6.1,
                        "cost_per_pass": 0.44, "seconds_median": 88.0,
                        "diff_lines_median": 31}}}

Never prompt text or file contents in that file: case ids, model ids and numbers (the cases
themselves, prompts included, are in evals.json beside it, for the pane).

Cost policy (Claude): nothing here calls a model. The forecast is arithmetic on what earlier
attempts and the landed sessions cost.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shlex
import statistics
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from . import code_changes
from .code_changes import NO_HOOKS, git

FORMAT = "eden-code-evals/1"
MAX_CONFIGS = 4
MAX_CASES = 200  # per project
MAX_CANDIDATES = 100  # landed tasks kept per project, the newest
PROMPT_MAX = 20_000
COMMAND_MAX = 500
EFFORTS = ("", "low", "medium", "high", "xhigh", "max")
PROMPTS = ("full", "lean")
RULES = ("on", "off")
# What a case costs on a model, before any attempt has cost anything (a Sonnet-sized guess,
# in dollars): the forecast says "rough" while it leans on this.
GUESS_USD = 0.60
GUESS_SECONDS = 240.0
# Rough ratios of the models' API prices (Opus about five times Haiku, Sonnet three), only
# to scale what a case cost on one model to another; a real attempt's cost replaces it.
RELATIVE_PRICE = {"opus": 5.0, "fable": 5.0, "sonnet": 3.0, "haiku": 1.0}
# Rough: more effort, more thinking tokens.
EFFORT_FACTOR = {"": 1.0, "low": 0.6, "medium": 0.8, "high": 1.0, "xhigh": 1.3, "max": 1.6}

# A file that is a test, by its path (relative to the repository's top).
_TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|spec)/"
    r"|(^|/)test_[^/]+\.py$|_test\.(py|go)$"
    r"|\.(test|spec)\.(m?[jt]sx?|cjs|cts|mts)$"
)
_SHA = re.compile(r"[0-9a-f]{7,40}")


def project_hash(folder: str) -> str:
    """The project as the Model Router's event log and the radar name it (code_router_events)."""
    return hashlib.sha256(str(folder or "").encode("utf-8")).hexdigest()[:12]


def new_id(prefix: str) -> str:
    return prefix + secrets.token_hex(4)


# ── cases, candidates and configurations ──


@dataclass
class Case:
    """One eval case (or, with command "" and in the candidates list, a landed task that
    could become one)."""

    id: str
    project: str  # the project's folder name
    folder: str  # the project's folder (the main checkout's, its prefix included)
    repo: str  # the repository's top
    prefix: str  # the project's folder inside it ("" at its root, else "sub/dir/")
    base: str  # the commit it starts from
    prompt: str
    landed: str = ""  # the commit the owner's own attempt landed as ("" when not known)
    command: str = ""  # the check, run in the project's folder of the attempt's worktree
    test_files: list[str] = field(default_factory=list)  # from landed, copied in before the check
    title: str = ""
    source: str = "landed"  # landed (a landed isolated copy) | commit (added by hand)
    model: str = ""  # the model the landed session ran on (an id), for the forecast
    cost: float = 0.0  # what the landed session cost
    added: float = 0.0  # when it was added (or landed, for a candidate)
    calibrated: dict[str, Any] | None = None  # {base: exit code, landed: exit code, at}

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        out["prompt"] = self.prompt[:2000]
        out["base"] = self.base[:12]
        out["landed"] = self.landed[:12]
        out["verdict"] = calibration_verdict(self.calibrated)
        return out


_CASE_FIELDS = {f.name for f in fields(Case)}


def case_from(raw: Any) -> Case | None:
    """A kept case, read defensively (a hand edit, another build's record: skipped)."""
    if not isinstance(raw, dict):
        return None
    try:
        case = Case(**{k: v for k, v in raw.items() if k in _CASE_FIELDS})
    except TypeError:
        return None
    text = (case.id, case.project, case.folder, case.repo, case.base, case.prompt)
    if not all(isinstance(v, str) and v for v in text) or not _SHA.fullmatch(case.base):
        return None
    if not isinstance(case.prefix, str) or not isinstance(case.command, str):
        return None
    if not isinstance(case.test_files, list):
        case.test_files = []
    case.test_files = [f for f in case.test_files if isinstance(f, str) and _safe_rel(f)][:50]
    if not isinstance(case.cost, int | float) or isinstance(case.cost, bool):
        case.cost = 0.0
    if not isinstance(case.calibrated, dict):
        case.calibrated = None
    return case


def _safe_rel(path: str) -> bool:
    """A path inside the repository, as git names one (never absolute, never up out of it)."""
    return bool(path) and not path.startswith(("/", "\\")) and ".." not in Path(path).parts


def calibration_verdict(calibrated: dict[str, Any] | None) -> str:
    """What calibrating found: "" (not done), ok, passes_at_start (the check passes before any
    attempt: it can't tell them apart), fails_landed (the owner's own landed work fails it)."""
    if not calibrated:
        return ""
    if calibrated.get("landed") not in (None, 0):
        return "fails_landed"
    if calibrated.get("base") == 0:
        return "passes_at_start"
    return "ok"


@dataclass
class Config:
    """One configuration a suite runs on."""

    id: str
    model: str = ""  # a model ref (Settings › Models), "" for the default model
    label: str = ""  # the model's name as the window shows it
    model_id: str = ""  # what it runs (claude-sonnet-5-5), for the results and the forecast
    effort: str = ""
    engine: str = ""  # a Claude Code engine's path ("" for the one Eden runs)
    engine_version: str = ""
    prompt: str = "full"  # full: Eden Code's prompt; lean: Claude Code's own, nothing added
    rules: str = "on"  # off: no CLAUDE.md, project settings, hooks or skills (setting_sources [])
    router: bool = False  # each case on the Model Router's pick for its prompt

    def name(self) -> str:
        """What the comparison calls it: "Sonnet 5.5 · high · lean · rules off"."""
        base = "Model Router" if self.router else (self.label or self.model or "Default model")
        parts = [base]
        if self.effort and not self.router:
            parts.append(self.effort)
        if self.prompt == "lean":
            parts.append("lean prompt")
        if self.rules == "off":
            parts.append("rules off")
        if self.engine:
            parts.append(f"engine {self.engine_version or Path(self.engine).parent.name}")
        return " · ".join(parts)

    def signature(self) -> str:
        """What makes two configurations the same for the forecast's memory."""
        return "|".join(
            [self.model_id or self.model, self.effort, self.engine_version or self.engine,
             self.prompt, self.rules, "router" if self.router else ""]
        )  # fmt: skip

    def public(self) -> dict[str, Any]:
        return {**asdict(self), "label": self.name()}


def config_from(raw: Any, n: int) -> Config | str:
    """A configuration as the window sends it ({model, label?, effort?, engine?,
    engine_version?, prompt?, rules?, router?}), checked; a string says what's wrong."""
    if not isinstance(raw, dict):
        return "That configuration isn't one Eden can run."
    effort = raw.get("effort") or ""
    prompt = raw.get("prompt") or "full"
    rules = raw.get("rules") or "on"
    if effort not in EFFORTS or prompt not in PROMPTS or rules not in RULES:
        return "That configuration isn't one Eden can run."
    engine = str(raw.get("engine") or "").strip()
    if engine and not engine_ok(engine):
        return "That engine isn't a Claude Code engine Eden can run."
    return Config(
        id=f"c{n}",
        model=str(raw.get("model") or "").strip()[:200],
        label=str(raw.get("label") or "").strip()[:80],
        effort=effort,
        engine=engine,
        engine_version=str(raw.get("engine_version") or "").strip()[:40],
        prompt=prompt,
        rules=rules,
        router=raw.get("router") is True,
    )


def engine_ok(path: str) -> bool:
    """A Claude Code program: a file named claude (claude.exe) that can run. Never any
    program a message names (what the engine radar's pin allows too, features.code_engines)."""
    p = Path(path).expanduser()
    if not p.is_absolute() or p.name not in ("claude", "claude.exe"):
        return False
    try:
        return p.is_file() and bool(p.stat().st_mode & 0o111)
    except OSError:
        return False


# ── checks ──


def test_files(paths: list[str]) -> list[str]:
    """Which of a change's files are tests (paths relative to the repository's top)."""
    return [p for p in paths if _TEST_PATH.search(p)]


def check_command(folder: Path, tests: list[str], prefix: str, fallback: str) -> str:
    """The check for a case: its tests with the project's own runner (pytest, in its .venv or
    through uv when it has one; node --test,
    vitest or jest by the project's package.json), else the owner's test command for the
    project (fallback, the one best of N remembers), else "" (the owner writes one)."""
    shown = [t[len(prefix) :] if prefix and t.startswith(prefix) else t for t in tests]
    shown = [t for t in shown if not t.startswith("../")]
    py = [t for t in shown if t.endswith(".py")]
    js = [t for t in shown if re.search(r"\.(m?[jt]sx?|cjs|cts|mts)$", t)]
    if py:
        files = " ".join(shlex.quote(t) for t in py)
        if (folder / ".venv" / "bin" / "python").exists():
            return f".venv/bin/python -m pytest -q {files}"
        if (folder / "uv.lock").exists():
            return f"uv run python -m pytest -q {files}"
        # (python -m: the project's folder is on the path, as its imports expect)
        return f"python3 -m pytest -q {files}"
    if js:
        runner = _js_runner(folder)
        files = " ".join(shlex.quote(t) for t in js)
        if runner == "vitest":
            return f"npx vitest run {files}"
        if runner == "jest":
            return f"npx jest {files}"
        if all(t.endswith((".mjs", ".js", ".cjs")) for t in js):
            return f"node --test {files}"
    return fallback.strip()[:COMMAND_MAX]


def _js_runner(folder: Path) -> str:
    try:
        data = json.loads((folder / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    test = str(((data or {}).get("scripts") or {}).get("test") or "")
    deps = {**(data.get("devDependencies") or {}), **(data.get("dependencies") or {})}
    for name in ("vitest", "jest"):
        if name in test or name in deps:
            return name
    return ""


# ── git: what a landed change was, and an attempt's throwaway worktree ──


def changed_files(repo: str, base: str, landed: str, prefix: str) -> list[str]:
    """The files a landed change touched inside the project's folder (repository paths)."""
    args = ["diff", "--name-only", "--no-renames", base, landed]
    if prefix:
        args += ["--", prefix]
    found = git(repo, *args)
    return [line for line in found.out.splitlines() if line][:2000] if found.ok else []


def landed_head(repo: str, branch: str, into: str) -> str:
    """The commit a landed isolated copy's own work ended at: the tip of the branch it landed
    in when that was a fast-forward, else that merge commit's second parent (worktrees.land
    writes "Merge <branch>: …"). "" when it can't be told."""
    tip = git(repo, "rev-parse", "-q", "--verify", f"refs/heads/{into}^{{commit}}")
    if not tip.ok:
        return ""
    tip_sha = tip.out.strip()
    info = git(repo, "log", "-1", "--format=%P%x00%s", tip_sha)
    if not info.ok:
        return tip_sha
    parents, _, subject = info.out.strip().partition("\0")
    both = parents.split()
    if len(both) == 2 and subject.startswith(f"Merge {branch}:"):
        return both[1]
    return tip_sha


def resolve_commit(repo: str, ref: str) -> str:
    """A commit the owner names (a SHA, a tag, HEAD~3), as a full SHA; "" when it isn't one."""
    ref = ref.strip()
    if not ref or ref.startswith("-") or len(ref) > 200:
        return ""
    found = git(repo, "rev-parse", "-q", "--verify", f"{ref}^{{commit}}")
    return found.out.strip() if found.ok else ""


def first_parent(repo: str, sha: str) -> str:
    found = git(repo, "rev-parse", "-q", "--verify", f"{sha}^1")
    return found.out.strip() if found.ok else ""


def make_checkout(repo: str, base: str, where: Path) -> str:
    """A detached worktree of repo at base, at where; "" when made, else why not."""
    where.parent.mkdir(parents=True, exist_ok=True)
    made = git(repo, *NO_HOOKS, "worktree", "add", "--detach", "-q", str(where), base, timeout=300)
    return "" if made.ok else (made.err.strip()[:300] or "git couldn't make the copy")


def remove_checkout(repo: str, where: Path) -> None:
    """The attempt's worktree gone (it never had a branch: nothing else to clean up)."""
    git(repo, "worktree", "remove", "--force", str(where), timeout=120)
    git(repo, "worktree", "prune", timeout=60)


def diff_stats(checkout: Path, base: str) -> dict[str, int]:
    """What an attempt changed from base, new files included: files, added, removed."""
    git(checkout, "add", "-A", "-N")  # (its own throwaway index: new files counted)
    stat = git(checkout, "diff", "--numstat", "-z", base)
    files = added = removed = 0
    for entry in stat.out.split("\0"):
        parts = entry.split("\t")
        if len(parts) >= 3 and parts[0]:
            files += 1
            added += int(parts[0]) if parts[0].isdigit() else 0
            removed += int(parts[1]) if parts[1].isdigit() else 0
    return {"files": files, "added": added, "removed": removed}


def overlay_tests(checkout: Path, landed: str, files: list[str]) -> str:
    """The landed change's test files copied over the attempt's, before its check (they're
    the check: an attempt that edited them doesn't get to keep its own versions). "" or why
    not."""
    if not files or not landed:
        return ""
    present = git(checkout, "ls-tree", "-r", "--name-only", landed, "--", *files)
    keep = [f for f in present.out.splitlines() if f] if present.ok else []
    if not keep:
        return ""
    done = git(checkout, "checkout", landed, "--", *keep)
    return "" if done.ok else (done.err.strip()[:300] or "couldn't copy the tests in")


# ── the forecast ──


def _family(model_id: str) -> str:
    low = model_id.lower()
    return next((f for f in RELATIVE_PRICE if f in low), "")


def scaled(cost: float, from_model: str, to_model: str, effort: str) -> float | None:
    """A cost on one model scaled to another (None when either model's price is unknown)."""
    a, b = RELATIVE_PRICE.get(_family(from_model)), RELATIVE_PRICE.get(_family(to_model))
    if not a or not b:
        return None
    return cost * b / a * EFFORT_FACTOR.get(effort, 1.0)


def estimate(case: Case, config: Config, history: dict[tuple[str, str], dict[str, float]]) -> tuple[float, float, str]:  # fmt: skip
    """(dollars, seconds, basis) one attempt is expected to take. basis: measured (this case
    on this configuration before), scaled (the landed session's cost, scaled to the model),
    guess (neither)."""
    seen = history.get((case.id, config.signature()))
    if seen:
        return seen["cost"], seen["seconds"], "measured"
    model = config.model_id or config.model
    if case.cost > 0 and case.model and not config.router:
        found = scaled(case.cost, case.model, model, config.effort)
        if found is not None:
            return found, GUESS_SECONDS, "scaled"
    ratio = RELATIVE_PRICE.get(_family(model), RELATIVE_PRICE["sonnet"]) / RELATIVE_PRICE["sonnet"]
    return GUESS_USD * ratio * EFFORT_FACTOR.get(config.effort, 1.0), GUESS_SECONDS, "guess"


def forecast(cases: list[Case], configs: list[Config], history: dict[tuple[str, str], dict[str, float]],
             parallel: int, ceiling: float) -> dict[str, Any]:  # fmt: skip
    """What a run would cost and take, per configuration and in all."""
    per: dict[str, dict[str, Any]] = {}
    total = seconds = 0.0
    bases: dict[str, int] = {"measured": 0, "scaled": 0, "guess": 0}
    for cfg in configs:
        usd = secs = 0.0
        for case in cases:
            c, s, basis = estimate(case, cfg, history)
            usd, secs = usd + c, secs + s
            bases[basis] += 1
        per[cfg.id] = {"label": cfg.name(), "usd": round(usd, 2), "seconds": round(secs)}
        total, seconds = total + usd, seconds + secs
    attempts = len(cases) * len(configs)
    return {
        "attempts": attempts,
        "usd": round(total, 2),
        "minutes": round(seconds / max(1, parallel) / 60),
        "per_config": per,
        "basis": bases,
        "rough": bases["guess"] + bases["scaled"] > 0,
        "ceiling": ceiling,
        "over_ceiling": total > ceiling,
        "parallel": parallel,
    }


def history_from(runs: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, float]]:
    """(case, configuration signature) -> what its latest real attempt cost and took."""
    out: dict[tuple[str, str], dict[str, float]] = {}
    for run in sorted(runs, key=lambda r: r.get("started") or 0):
        sigs = {c.get("id"): c.get("signature", "") for c in run.get("configs") or []}
        for r in run.get("results") or []:
            sig = sigs.get(r.get("config"))
            if sig and r.get("status") in ("passed", "failed"):
                out[(str(r.get("case")), sig)] = {
                    "cost": float(r.get("cost_usd") or 0.0),
                    "seconds": float(r.get("seconds") or 0.0),
                }
    return out


# ── scoring ──


def summarize(configs: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    """Each configuration's score: passes, cost, median time and diff size."""
    out: dict[str, Any] = {}
    for cfg in configs:
        mine = [r for r in results if r.get("config") == cfg["id"]]
        scored = [r for r in mine if r.get("status") in ("passed", "failed")]
        passed = sum(1 for r in mine if r.get("status") == "passed")
        cost = round(sum(float(r.get("cost_usd") or 0.0) for r in mine), 4)
        times = [float(r.get("seconds") or 0.0) for r in scored]
        diffs = [int(r.get("added") or 0) + int(r.get("removed") or 0) for r in scored]
        out[cfg["id"]] = {
            "label": cfg.get("label", ""),
            "total": len(mine),
            "passed": passed,
            "failed": sum(1 for r in mine if r.get("status") == "failed"),
            "errors": sum(1 for r in mine if r.get("status") == "error"),
            "skipped": sum(1 for r in mine if r.get("status") == "skipped"),
            "pass_rate": round(passed / len(mine), 3) if mine else 0.0,
            "cost_usd": cost,
            "cost_per_pass": round(cost / passed, 4) if passed else None,
            "seconds_median": round(statistics.median(times), 1) if times else None,
            "diff_lines_median": round(statistics.median(diffs)) if diffs else None,
        }
    return out


def run_record(run_id: str, project: str, folder: str, configs: list[Config], ceiling: float) -> dict[str, Any]:  # fmt: skip
    """A new run's record in FORMAT (results filled in as attempts are scored)."""
    return {
        "format": FORMAT,
        "run": run_id,
        "project": project,
        "project_hash": project_hash(folder),
        "started": time.time(),
        "finished": None,
        "status": "running",
        "ceiling_usd": ceiling,
        "spent_usd": 0.0,
        "configs": [{**c.public(), "signature": c.signature()} for c in configs],
        "cases": [],
        "results": [],
        "summary": {},
    }


def readable_run(raw: Any) -> bool:
    """A run file another feature (or this one, after a restart) can use."""
    return (
        isinstance(raw, dict)
        and raw.get("format") == FORMAT
        and isinstance(raw.get("run"), str)
        and isinstance(raw.get("configs"), list)
        and isinstance(raw.get("results"), list)
    )
