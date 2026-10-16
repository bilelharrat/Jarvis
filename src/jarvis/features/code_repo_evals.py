"""Eden Code's evals for the owner's own repository (the pane: web/features/code-evals.js;
the parts with no hub in them, and the results format other features read: codeevals.py).

"Opus 5.5 vs Sonnet 5.5 on my last 20 tasks": past real tasks become eval cases, a suite of
them runs against the configurations the owner picks, each attempt in a throwaway copy of the
repository, and the configurations are compared side by side on what passed, what it cost,
how long it took and how big the diff was.

Where cases come from:
- Landed work. Each time an isolated copy lands (its Land card, or best of N's Keep this one:
  features.code_isolation's Desk.land_result, wrapped here), the task is kept as a candidate:
  the commit the copy started from, the prompt its first session was given, the commit its
  work landed as, the files it changed (the test files among them), and what its sessions
  cost on which model. Only with "Collect landed work for evals" on (code_evals_collect, on);
  the newest codeevals.MAX_CANDIDATES per project are kept. Nothing runs and nothing is
  sent: it's git and the session's own record.
- A commit, by hand: the commit's parent is the start, the commit is the landed work, and the
  owner writes the prompt.
A candidate becomes a case with "Add": its check is the tests the landed change added or
changed, with the project's runner (codeevals.check_command), else the project's test
command (best of N's, code_quick_tests), else one the owner writes. Each new case is then
calibrated once by itself (the check at the start should fail, at the landed commit pass):
the project's own tests, nothing more.

A run (cev_run {directory, cases, configs, routes?}): first a forecast (codeevals.forecast:
what earlier attempts of each case on that configuration cost, else the landed session's cost
scaled to the model, else a guess, said as rough), then a card that says it and the run's
ceiling, and nothing starts until the owner says Run. Then up to code_evals_parallel
attempts at once (2; at most PARALLEL_MAX), each:
- a detached git worktree at the case's start (no branch in the owner's repository), in
  this feature's folder, with node_modules and .venv linked from the main folder when the
  project allows it for isolated copies (code_iso_link); never its .env files;
- an Eden Code session there, on the configuration: its model and effort (or the Model
  Router's pick for that case's prompt, which the window sends as routes, as the routing
  queue's are), its engine (ClaudeAgentOptions.cli_path, a Claude Code program only; the
  engine radar's kept engines are offered, features.code_engines), Eden Code's full prompt or
  Claude Code's own (lean: nothing of Eden's appended), the project's rules on or off (off:
  setting_sources [], so no CLAUDE.md, project settings, hooks or skills; Eden's own
  permission rules still hold). Bypass permissions for the run with one Touch ID proof when
  the gate gives it, else Auto. It ends after its first turn, or after CASE_SECONDS;
- the landed change's tests copied in over the attempt's work, the check run (at most ten
  minutes, code_bestof.run_tests), the diff measured, the worktree removed.
Other features can tell an eval's session by CodeEvals.config_for(task) (its configuration,
or None): the rules-to-guardrails compiler should leave its guardrails out when rules is off.

Money: every attempt is a real session, under the owner's spending caps (code_usage) and
under the run's own ceiling (code_evals_ceiling, $10, said on the card): each session gets
Claude Code's max_budget_usd of at most CASE_CAP_FACTOR times its forecast (at least
CASE_CAP_MIN) and never more than what's left of the ceiling, less what the attempts running
have been given; once the ceiling is reached, the attempts left are skipped. Stop
(cev_stop) starts no more and interrupts those running.

Window commands: cev_state {directory} -> code_evals {project, candidates, cases, runs,
running, settings}; cev_add {directory, candidate | commit + prompt, command?};
cev_edit {case, prompt?, command?}; cev_remove {case}; cev_dismiss {candidate};
cev_calibrate {case}; cev_forecast {directory, cases, configs, routes?} ->
code_evals_forecast; cev_run {…the same}; cev_stop {run}; cev_run_get {run} ->
code_evals_run. Settings (feature prefs, Eden Code settings): code_evals_collect,
code_evals_parallel, code_evals_ceiling.

Cost policy (Claude): this feature calls no model of its own. A run's attempts are Eden Code
sessions on the models the owner picked, each capped as above, only after the forecast's card
is answered Run; collecting, calibrating and the forecast cost nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import code_changes, codeevals, jsonstore, lang, prefs, worktrees
from ..codeevals import Case, Config
from ..tasks import bypass_vouched
from .code_bestof import PREF_TESTS, run_tests
from .code_router import _plain_route
from .code_usage import spent

log = logging.getLogger("jarvis")

PREF_COLLECT = "code_evals_collect"
PREF_PARALLEL = "code_evals_parallel"
PREF_CEILING = "code_evals_ceiling"
PARALLEL_DEFAULT = 2
PARALLEL_MAX = 4
CEILING_DEFAULT = 10.0
CEILING_MAX = 1000.0
CASE_CAP_FACTOR = 3.0  # an attempt may spend this many times its forecast…
CASE_CAP_MIN = 0.5  # …and at least this
MIN_ROOM = 0.05  # less than this left under the ceiling: no more attempts start
CASE_SECONDS = 30 * 60  # an attempt's session, at most
POLL_SECONDS = 2.0
RUNS_KEPT = 50
STORE = "evals.json"


def _parallel(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return max(1, min(PARALLEL_MAX, int(value)))


def _ceiling(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != value:
        return None
    return round(max(MIN_ROOM, min(CEILING_MAX, float(value))), 2)


prefs.register_feature_pref(PREF_COLLECT, True)
prefs.register_feature_pref(PREF_PARALLEL, PARALLEL_DEFAULT, _parallel)
prefs.register_feature_pref(PREF_CEILING, CEILING_DEFAULT, _ceiling)

ZH = {
    "Pick a project first.": "请先选择一个项目。",
    "That case isn't there any more.": "那个用例已经不在了。",
    "That landed task isn't there any more.": "那个已合并的任务已经不在了。",
    "Pick at least one case.": "请至少选一个用例。",
    "Pick one to four configurations.": "请选一到四个配置。",
    "That configuration isn't one Eden can run.": "Eden 没法运行那个配置。",
    "That engine isn't a Claude Code engine Eden can run.": "那个引擎不是 Eden 能运行的 Claude Code 引擎。",
    "The Model Router had no pick for every case; try again in a moment.": "模型路由器还没给每个用例选好模型；请稍后再试。",
    "{name} isn't a git repository, so its tasks can't be replayed.": "{name} 不是 git 仓库，所以它的任务没法重放。",
    "That isn't a commit in {name}.": "那不是 {name} 里的提交。",
    "That commit has no parent to start from.": "那个提交没有可以作为起点的父提交。",
    "That commit changed nothing in {name}.": "那个提交没有改动 {name} 里的任何东西。",
    "Say what the task asked for.": "请写下这个任务要做什么。",
    "That task is an eval case already.": "这个任务已经是评测用例了。",
    "Write a check command for it: its change added no tests and this project has no test command.": "请为它写一个检查命令：它的改动没有加测试，这个项目也没有测试命令。",
    "An eval run is going already in {name}; stop it or wait for it.": "{name} 里已经有一个评测在运行；请停止它或等它完成。",
    "Run {n} attempts on {k} configurations?": "要在 {k} 个配置上运行 {n} 次尝试吗？",
    "About {usd}{rough}, {minutes} min at {parallel} at once. It stops at the run's {ceiling} ceiling, and each attempt may spend at most {cap}. Each runs in a throwaway copy of the repository; your spending limits still hold.": "大约 {usd}{rough}，同时 {parallel} 个约需 {minutes} 分钟。花到这次运行的 {ceiling} 上限就会停止，每次尝试最多花 {cap}。每次尝试都在仓库的一次性副本里运行；你的花费上限照样有效。",
    " (rough)": "（粗略估计）",
    "The forecast is more than the ceiling: some attempts will be skipped.": "预估超过了上限：有些尝试会被跳过。",
    "Run": "运行",
    "Not now": "暂不",
    "Not run.": "没有运行。",
    "Stopped: no more attempts start.": "已停止：不会再开始新的尝试。",
    "The run's ceiling was reached.": "已经到了这次运行的花费上限。",
    "Stopped before it started.": "开始前就已停止。",
    "No Model Router pick for this case.": "这个用例没有模型路由器的选择。",
    "Couldn't make its copy: {error}": "没能做出它的副本：{error}",
    "It ran out of time ({minutes} min).": "它超时了（{minutes} 分钟）。",
    "The check couldn't run: {error}": "检查没能运行：{error}",
    "Eval run done: {summary}": "评测完成：{summary}",
    "{label} {passed}/{total}": "{label} {passed}/{total}",
}
lang.add_texts(ZH)


def _money(value: float) -> str:
    return f"${value:,.2f}"


@dataclass
class Job:
    """One attempt: a case on a configuration."""

    run: Run
    case: Case
    config: Config
    route: dict[str, Any] | None = None  # the Model Router's pick, for a router configuration
    cwd: Path | None = None
    budget: float = 0.0
    mode: str = "smart"
    task_id: int = 0
    stop: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class Run:
    id: str
    project: str
    folder: str
    record: dict[str, Any]
    cases: list[Case]
    configs: list[Config]
    routes: dict[str, dict[str, Any]]
    estimates: dict[tuple[str, str], float]
    stopping: bool = False
    reserved: float = 0.0
    jobs: list[Job] = field(default_factory=list)


class SessionRunner:
    """Runs one attempt as an Eden Code session in the attempt's folder (the tests put a fake
    runner here: never a real model in a test)."""

    def __init__(self, evals: CodeEvals) -> None:
        self.evals = evals
        self.hub = evals.hub
        self.poll = POLL_SECONDS

    def _finished(self, task: Any) -> bool:
        if task.status in ("failed", "stopped", "closed"):
            return True
        turned = any(entry.get("role") == "turn" for entry in task.transcript)
        return turned and not task.busy and task.inbox.empty()

    async def run(self, job: Job) -> dict[str, Any]:
        """{status: done | failed | timeout | stopped | error, cost, seconds, error}."""
        cfg = job.config
        ref = (job.route or {}).get("ref", "") if cfg.router else cfg.model
        effort = (job.route or {}).get("effort", "") if cfg.router else cfg.effort
        model = self.hub._model_config(ref)
        started = time.monotonic()
        try:
            task = self.hub.tasks.start(
                job.case.prompt,
                str(job.cwd),
                mode=job.mode,
                model=model["model"] or "",
                model_label=model["label"] if model["model"] else "",
                model_ref=model["ref"],
                effort=effort,
                env=model["env"],
                provider_settings=model.get("settings") or "",
                isolate=False,
                title=f"Eval: {job.case.title or job.case.prompt[:60]} ({cfg.name()})",
            )
        except ValueError as exc:
            return {"status": "error", "cost": 0.0, "seconds": 0.0, "error": str(exc)[:300]}
        job.task_id = task.id
        self.evals.by_task[task.id] = job
        status = ""
        try:
            while not self._finished(task):
                if job.stop.is_set():
                    status = "stopped"
                elif time.monotonic() - started > CASE_SECONDS:
                    status = "timeout"
                if status:
                    with contextlib.suppress(Exception):
                        await self.hub.tasks.interrupt(task.id)
                    break
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(job.stop.wait(), self.poll)
            status = status or ("failed" if task.status == "failed" else "done")
            cost = spent(task)
        finally:
            self.hub.tasks.cancel(task.id)  # (its session ends: the copy is going)
            self.evals.by_task.pop(task.id, None)
        return {
            "status": status,
            "cost": cost,
            "seconds": round(time.monotonic() - started, 1),
            "model_id": model["model"] or "",
            "error": "",
        }


class CodeEvals:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.folder = hub.feature_path("code_evals")
        self.runner: Any = SessionRunner(self)
        self.by_task: dict[int, Job] = {}  # an attempt's session -> its job
        self.paths: dict[Path, Path] = {}  # an attempt's folder (resolved) -> itself
        self.runs: dict[str, Run] = {}  # the runs going, by id
        self.calibrating: set[str] = set()
        self.jobs: set[asyncio.Task] = set()
        self._data: dict[str, Any] | None = None

    # ── what's kept ──

    @property
    def data(self) -> dict[str, Any]:
        if self._data is None:
            raw = jsonstore.load_json(self.folder / STORE, dict) or {}
            self._data = {
                "candidates": [c for c in map(codeevals.case_from, raw.get("candidates") or []) if c],
                "cases": [c for c in map(codeevals.case_from, raw.get("cases") or []) if c],
            }  # fmt: skip
        return self._data

    def save(self) -> None:
        data = {k: [c.__dict__ for c in v] for k, v in self.data.items()}
        try:
            jsonstore.save_json(self.folder / STORE, data)
        except OSError as exc:
            log.warning("couldn't save the eval cases (%s)", exc)

    def cases(self, project: str = "") -> list[Case]:
        return [c for c in self.data["cases"] if not project or c.project == project]

    def candidates(self, project: str = "") -> list[Case]:
        return [c for c in self.data["candidates"] if not project or c.project == project]

    def find(self, case_id: str, kind: str = "cases") -> Case | None:
        return next((c for c in self.data[kind] if c.id == case_id), None)

    def run_files(self) -> list[Path]:
        folder = self.folder / "runs"
        return sorted(folder.glob("r*.json"), key=lambda p: p.stat().st_mtime) if folder.is_dir() else []

    def results(self, project: str = "", limit: int = 20) -> list[dict[str, Any]]:
        """The latest runs in codeevals.FORMAT, newest first (for the pane and for other
        features: the engine radar, the Model Router's learner)."""
        out = []
        for path in reversed(self.run_files()):
            raw = jsonstore.load_json(path, dict)
            if codeevals.readable_run(raw) and (not project or raw.get("project") == project):
                out.append(raw)
            if len(out) >= limit:
                break
        live = {r.id: r.record for r in self.runs.values()}
        return [live.get(r["run"], r) for r in out]

    def save_run(self, run: Run) -> None:
        folder = self.folder / "runs"
        try:
            folder.mkdir(parents=True, exist_ok=True)
            jsonstore.save_json(folder / f"{run.id}.json", run.record, backup=False)
        except OSError as exc:
            log.warning("couldn't save an eval run (%s)", exc)
        for old in self.run_files()[:-RUNS_KEPT]:
            with contextlib.suppress(OSError):
                old.unlink()

    def config_for(self, task: Any) -> dict[str, Any] | None:
        """An eval attempt's configuration (Config.public()), or None for any other session."""
        job = self.by_task.get(getattr(task, "id", 0))
        return job.config.public() if job is not None else None

    # ── the windows ──

    def tr(self, text: str, **values: Any) -> str:
        if not values:  # (a sentence already made: a git error's braces are never a format)
            return lang.translate(text, self.hub.language)
        return lang.tr(text, self.hub.language, **values)

    def say(self, text: str, **values: Any) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text, **values))

    def spawn(self, coro: Any) -> asyncio.Task:
        job = asyncio.get_running_loop().create_task(coro)
        self.jobs.add(job)
        job.add_done_callback(self.jobs.discard)
        job.add_done_callback(_log_failure)
        return job

    def settings(self) -> dict[str, Any]:
        f = self.hub.prefs.feature
        return {
            "collect": bool(f(PREF_COLLECT)),
            "parallel": _parallel(f(PREF_PARALLEL)) or PARALLEL_DEFAULT,
            "ceiling": _ceiling(f(PREF_CEILING)) or CEILING_DEFAULT,
        }

    def publish(self, project: str) -> None:
        running = [r.id for r in self.runs.values() if r.project == project]
        runs = [_brief(r) for r in self.results(project)]
        self.hub.emit(
            "code_evals",
            project=project,
            candidates=[c.public() for c in reversed(self.candidates(project))],
            cases=[c.public() for c in reversed(self.cases(project))],
            calibrating=sorted(self.calibrating),
            runs=runs,
            running=running,
            settings=self.settings(),
        )

    def _project(self, msg: dict[str, Any]) -> tuple[Path | None, str]:
        directory = str(msg.get("directory") or "").strip()
        if not directory:
            return None, "Pick a project first."
        try:
            return self.hub.tasks.resolve_dir(directory), ""
        except ValueError as exc:
            return None, str(exc)

    def cmd_state(self, msg: dict[str, Any]) -> None:
        folder, said = self._project(msg)
        if folder is None:
            return self.say(said)
        self.publish(folder.name)

    def cmd_add(self, msg: dict[str, Any]) -> None:
        self.spawn(self._reply(self.add(msg)))

    async def _reply(self, coro: Any) -> None:
        said = await coro
        if said:
            self.say(said)

    async def add(self, msg: dict[str, Any]) -> str:
        """A case from a landed task (candidate) or from a commit; then it's calibrated."""
        command = str(msg.get("command") or "").strip()[: codeevals.COMMAND_MAX]
        quick = dict(self.hub.prefs.feature(PREF_TESTS) or {})
        if msg.get("candidate"):
            found = self.find(str(msg["candidate"]), "candidates")
            if found is None:
                return "That landed task isn't there any more."
            case = Case(**{**found.__dict__, "id": codeevals.new_id("e"), "added": time.time()})
        else:
            folder, said = self._project(msg)
            if folder is None:
                return said
            made = await asyncio.to_thread(self._from_commit, folder, msg)
            if isinstance(made, str):
                return made
            case, found = made, None
        if any(c.landed == case.landed and c.project == case.project for c in self.data["cases"]):
            return "That task is an eval case already."
        if not command:
            command = await asyncio.to_thread(
                codeevals.check_command, Path(case.folder), case.test_files, case.prefix,
                quick.get(case.project, ""),
            )  # fmt: skip
        if not command:
            return "Write a check command for it: its change added no tests and this project has no test command."
        case.command = command
        prompt = str(msg.get("prompt") or "").strip()
        if prompt:
            case.prompt = prompt[: codeevals.PROMPT_MAX]
        if found is not None:
            self.data["candidates"].remove(found)
        self.data["cases"].append(case)
        mine = self.cases(case.project)
        for old in mine[: max(0, len(mine) - codeevals.MAX_CASES)]:
            self.data["cases"].remove(old)
        self.save()
        self.publish(case.project)
        self.spawn(self.calibrate(case.id))
        return ""

    def _from_commit(self, folder: Path, msg: dict[str, Any]) -> Case | str:
        prompt = str(msg.get("prompt") or "").strip()[: codeevals.PROMPT_MAX]
        if not prompt:
            return "Say what the task asked for."
        repo = code_changes.repo_of(folder)
        if repo is None:
            return lang.tr("{name} isn't a git repository, so its tasks can't be replayed.", self.hub.language, name=folder.name)  # fmt: skip
        landed = codeevals.resolve_commit(str(repo.top), str(msg.get("commit") or ""))
        if not landed:
            return lang.tr("That isn't a commit in {name}.", self.hub.language, name=folder.name)
        base = codeevals.first_parent(str(repo.top), landed)
        if not base:
            return "That commit has no parent to start from."
        files = codeevals.changed_files(str(repo.top), base, landed, repo.prefix)
        if not files:
            return lang.tr("That commit changed nothing in {name}.", self.hub.language, name=folder.name)  # fmt: skip
        return Case(
            id=codeevals.new_id("e"),
            project=folder.name,
            folder=str(folder),
            repo=str(repo.top),
            prefix=repo.prefix,
            base=base,
            prompt=prompt,
            landed=landed,
            test_files=codeevals.test_files(files),
            title=prompt.splitlines()[0][:80],
            source="commit",
            added=time.time(),
        )

    def cmd_edit(self, msg: dict[str, Any]) -> None:
        case = self.find(str(msg.get("case") or ""))
        if case is None:
            return self.say("That case isn't there any more.")
        if isinstance(msg.get("prompt"), str) and msg["prompt"].strip():
            case.prompt = msg["prompt"].strip()[: codeevals.PROMPT_MAX]
        if isinstance(msg.get("command"), str) and msg["command"].strip():
            command = msg["command"].strip()[: codeevals.COMMAND_MAX]
            if command != case.command:
                case.command, case.calibrated = command, None
        self.save()
        self.publish(case.project)

    def cmd_remove(self, msg: dict[str, Any]) -> None:
        self._drop(str(msg.get("case") or ""), "cases")

    def cmd_dismiss(self, msg: dict[str, Any]) -> None:
        self._drop(str(msg.get("candidate") or ""), "candidates")

    def _drop(self, case_id: str, kind: str) -> None:
        case = self.find(case_id, kind)
        if case is None:
            return
        self.data[kind].remove(case)  # (runs keep their results: they name it by its id)
        self.save()
        self.publish(case.project)

    # ── collecting landed work ──

    def watch_landing(self, desk: Any) -> None:
        """Desk.land_result, wrapped: a copy that landed becomes a candidate."""
        original = desk.land_result

        async def land_result(copy: worktrees.Copy) -> tuple[bool, str]:
            before = None
            with contextlib.suppress(Exception):  # (never in the way of a landing)
                before = self._before_landing(desk, copy)
            ok, said = await original(copy)
            if ok and before is not None:
                self.spawn(self.collect(copy, before))
            return ok, said

        desk.land_result = land_result

    def _before_landing(self, desk: Any, copy: worktrees.Copy) -> dict[str, Any] | None:
        if not self.hub.prefs.feature(PREF_COLLECT):
            return None
        tasks = sorted(desk.tasks_in(copy), key=lambda t: t.id)
        prompt = next((t.prompt.strip() for t in tasks if (t.prompt or "").strip()), "")
        if not prompt:
            return None
        first = tasks[0]
        return {
            "prompt": prompt[: codeevals.PROMPT_MAX],
            "model": first.model or self.hub.tasks.model or "",
            "cost": round(sum(spent(t) for t in tasks), 4),
        }

    async def collect(self, copy: worktrees.Copy, before: dict[str, Any]) -> None:
        landed = await asyncio.to_thread(codeevals.landed_head, copy.repo, copy.branch, copy.into)
        if not landed:
            return
        files = await asyncio.to_thread(codeevals.changed_files, copy.repo, copy.base, landed, copy.prefix)  # fmt: skip
        if not files:
            return
        if any(c.landed == landed for c in self.data["candidates"] + self.data["cases"]):
            return
        case = Case(
            id=codeevals.new_id("e"),
            project=copy.project,
            folder=str(Path(copy.repo) / copy.prefix).rstrip("/"),
            repo=copy.repo,
            prefix=copy.prefix,
            base=copy.base,
            prompt=before["prompt"],
            landed=landed,
            test_files=codeevals.test_files(files),
            title=(copy.title or before["prompt"].splitlines()[0])[:80],
            source="landed",
            model=before["model"],
            cost=before["cost"],
            added=time.time(),
        )
        self.data["candidates"].append(case)
        mine = self.candidates(case.project)
        for old in mine[: max(0, len(mine) - codeevals.MAX_CANDIDATES)]:
            self.data["candidates"].remove(old)
        self.save()
        self.publish(case.project)

    # ── an attempt's folder ──

    def wrap_isolated_dir(self, original: Any) -> Any:
        """tasks.resolve_dir finds an attempt's folder (it's in this feature's folder, which
        isn't a project folder), as it finds an isolated copy's."""

        def isolated_dir(directory: str) -> Path | None:
            found = original(directory) if original is not None else None
            raw = (directory or "").strip()
            if found is not None or not raw.startswith("/"):
                return found
            with contextlib.suppress(OSError):
                return self.paths.get(Path(raw).resolve())
            return None

        return isolated_dir

    def checkout_root(self) -> Path:
        return self.folder / "attempts"

    async def checkout(self, case: Case, where: Path) -> tuple[Path | None, str]:
        """An attempt's own worktree at the case's start: (its project folder, "") or why not."""
        problem = await asyncio.to_thread(codeevals.make_checkout, case.repo, case.base, where)
        if problem:
            return None, problem
        cwd = where / case.prefix
        linked = case.project in (self.hub.prefs.feature("code_iso_link") or [])
        if linked:
            copy = worktrees.Copy(case.id, case.project, case.repo, case.prefix, str(where), "", case.base, "")  # fmt: skip
            repo = code_changes.Repo(Path(case.repo), case.prefix)
            with contextlib.suppress(OSError):
                await asyncio.to_thread(worktrees.link_dependencies, repo, copy)
        return cwd, ""

    async def drop_checkout(self, case: Case, where: Path) -> None:
        await asyncio.to_thread(codeevals.remove_checkout, case.repo, where)
        await asyncio.to_thread(shutil.rmtree, where.parent, True)

    async def check(self, case: Case, where: Path, cwd: Path) -> dict[str, Any]:
        """The landed tests copied in, then the case's check: {code, tail}."""
        problem = await asyncio.to_thread(codeevals.overlay_tests, where, case.landed, case.test_files)
        if problem:
            return {"code": -1, "tail": problem}
        return await run_tests(case.command, cwd)

    # ── calibrating ──

    def cmd_calibrate(self, msg: dict[str, Any]) -> None:
        self.spawn(self.calibrate(str(msg.get("case") or "")))

    async def calibrate(self, case_id: str) -> None:
        """The check at the start (should fail) and at the landed commit (should pass)."""
        case = self.find(case_id)
        if case is None or case_id in self.calibrating or not case.landed:
            return
        self.calibrating.add(case_id)
        self.publish(case.project)
        found: dict[str, Any] = {"at": time.time()}
        try:
            for name, commit in (("base", case.base), ("landed", case.landed)):
                where = self.checkout_root() / f"cal-{case.id}-{name}" / case.project
                at = Case(**{**case.__dict__, "base": commit})
                cwd, problem = await self.checkout(at, where)
                try:
                    if cwd is None:
                        found[name], found[f"{name}_tail"] = -1, problem
                        continue
                    result = await self.check(case, where, cwd)
                    found[name], found[f"{name}_tail"] = result["code"], result["tail"][-400:]
                finally:
                    await self.drop_checkout(case, where)
        finally:
            self.calibrating.discard(case_id)
        if self.find(case_id) is case:
            case.calibrated = found
            self.save()
        self.publish(case.project)

    # ── forecasting and running ──

    def _suite(self, msg: dict[str, Any]) -> tuple[Path, list[Case], list[Config], dict[str, dict[str, Any]]] | str:  # fmt: skip
        folder, said = self._project(msg)
        if folder is None:
            return said
        wanted = msg.get("cases")
        mine = self.cases(folder.name)
        if isinstance(wanted, list):
            ids = [w for w in wanted if isinstance(w, str)]
            mine = [c for c in mine if c.id in ids]
        if not mine:
            return "Pick at least one case."
        raw = msg.get("configs")
        raw = raw if isinstance(raw, list) else []
        if not 1 <= len(raw) <= codeevals.MAX_CONFIGS:
            return "Pick one to four configurations."
        configs: list[Config] = []
        for n, item in enumerate(raw, 1):
            cfg = codeevals.config_from(item, n)
            if isinstance(cfg, str):
                return cfg
            if not cfg.router:
                model = self.hub._model_config(cfg.model)
                cfg.model_id = model["model"] or self.hub.tasks.model or ""
                cfg.label = cfg.label or model.get("label") or ""
            configs.append(cfg)
        routes: dict[str, dict[str, Any]] = {}
        given = msg.get("routes") if isinstance(msg.get("routes"), dict) else {}
        for case in mine:
            route = _plain_route(given.get(case.id))
            if route:
                routes[case.id] = route
        if any(c.router for c in configs) and any(c.id not in routes for c in mine):
            return "The Model Router had no pick for every case; try again in a moment."
        return folder, mine, configs, routes

    def _history(self, project: str) -> dict[tuple[str, str], dict[str, float]]:
        return codeevals.history_from(self.results(project, RUNS_KEPT))

    def cmd_forecast(self, msg: dict[str, Any]) -> None:
        suite = self._suite(msg)
        if isinstance(suite, str):
            return self.say(suite)
        folder, cases, configs, _routes = suite
        s = self.settings()
        found = codeevals.forecast(cases, configs, self._history(folder.name), s["parallel"], s["ceiling"])  # fmt: skip
        self.hub.emit("code_evals_forecast", project=folder.name, **found)

    def cmd_run(self, msg: dict[str, Any]) -> None:
        self.spawn(self._reply(self.start(msg)))

    async def start(self, msg: dict[str, Any]) -> str:
        """The forecast on a card; on Run, the suite goes (see the module's docstring)."""
        suite = self._suite(msg)
        if isinstance(suite, str):
            return suite
        folder, cases, configs, routes = suite
        if any(r.project == folder.name for r in self.runs.values()):
            return lang.tr("An eval run is going already in {name}; stop it or wait for it.", self.hub.language, name=folder.name)  # fmt: skip
        s = self.settings()
        history = self._history(folder.name)
        found = codeevals.forecast(cases, configs, history, s["parallel"], s["ceiling"])
        estimates = {
            (case.id, cfg.id): codeevals.estimate(case, cfg, history)[0]
            for case in cases
            for cfg in configs
        }
        cap = max(CASE_CAP_MIN, max(estimates.values()) * CASE_CAP_FACTOR)
        detail = self.tr(
            "About {usd}{rough}, {minutes} min at {parallel} at once. It stops at the run's "
            "{ceiling} ceiling, and each attempt may spend at most {cap}. Each runs in a "
            "throwaway copy of the repository; your spending limits still hold.",
            usd=_money(found["usd"]),
            rough=self.tr(" (rough)") if found["rough"] else "",
            minutes=max(1, found["minutes"]),
            parallel=s["parallel"],
            ceiling=_money(s["ceiling"]),
            cap=_money(min(cap, s["ceiling"])),
        )
        if found["over_ceiling"]:
            detail += "\n\n" + self.tr(
                "The forecast is more than the ceiling: some attempts will be skipped."
            )
        detail += "\n\n" + "\n".join(
            f"• {p['label']}: {_money(p['usd'])}" for p in found["per_config"].values()
        )
        question = self.tr(
            "Run {n} attempts on {k} configurations?", n=found["attempts"], k=len(configs)
        )
        answer = await self.hub.request_approval(
            question, detail, [("run", self.tr("Run")), ("deny", self.tr("Not now"))]
        )
        if answer != "run":
            return "Not run."
        if any(r.project == folder.name for r in self.runs.values()):  # (another card said yes)
            return lang.tr("An eval run is going already in {name}; stop it or wait for it.", self.hub.language, name=folder.name)  # fmt: skip
        run_id = codeevals.new_id("r")
        record = codeevals.run_record(run_id, folder.name, str(folder), configs, s["ceiling"])
        record["cases"] = [c.id for c in cases]
        record["forecast_usd"] = found["usd"]
        run = Run(run_id, folder.name, str(folder), record, cases, configs, routes, estimates)
        self.runs[run_id] = run
        self.save_run(run)
        self._last_hook()
        # Bypass for every attempt with one proof, as best of N's (the run's own task is made
        # inside the proof, so its sessions' starts carry it); refused: Auto.
        mode = "auto" if self.hub.tasks.may_bypass(folder) else "smart"
        with bypass_vouched() if mode == "auto" else contextlib.nullcontext():
            self.spawn(self.go(run, mode, s["parallel"]))
        self.publish(folder.name)
        return ""

    def _last_hook(self) -> None:
        """This feature's session options after every other feature's (its lean prompt is
        Claude Code's own, nothing appended after it)."""
        hooks = self.hub.tasks.option_hooks
        mine = [h for h in hooks if isinstance(h, _Options)]
        for h in mine:
            hooks.remove(h)
        hooks.extend(mine or [_Options(self)])

    async def go(self, run: Run, mode: str, parallel: int) -> None:
        gate = asyncio.Semaphore(parallel)

        async def one(job: Job) -> None:
            async with gate:
                await self.attempt(job)

        for case in run.cases:  # each case on every configuration before the next case
            for cfg in run.configs:
                run.jobs.append(Job(run, case, cfg, run.routes.get(case.id), mode=mode))
        try:
            await asyncio.gather(*(one(j) for j in run.jobs))
        finally:
            run.record["status"] = "stopped" if run.stopping else "done"
            run.record["finished"] = time.time()
            self.runs.pop(run.id, None)
            await asyncio.to_thread(shutil.rmtree, self.checkout_root() / run.id, True)
            self.save_run(run)
            self.emit_run(run)
            self.publish(run.project)
            summary = ", ".join(
                self.tr("{label} {passed}/{total}", label=s["label"], passed=s["passed"], total=s["total"])  # fmt: skip
                for s in run.record["summary"].values()
            )
            self.say("Eval run done: {summary}", summary=summary)

    def room(self, run: Run) -> float:
        return run.record["ceiling_usd"] - run.record["spent_usd"] - run.reserved

    async def attempt(self, job: Job) -> None:
        run, case, cfg = job.run, job.case, job.config
        result: dict[str, Any] = {"case": case.id, "config": cfg.id, "status": "skipped",
                                  "passed": False, "cost_usd": 0.0, "seconds": 0.0, "files": 0,
                                  "added": 0, "removed": 0, "check_code": None, "error": ""}  # fmt: skip
        if run.stopping:
            result["error"] = self.tr("Stopped before it started.")
            return self.scored(run, result)
        room = self.room(run)
        if room < MIN_ROOM:
            result["error"] = self.tr("The run's ceiling was reached.")
            return self.scored(run, result)
        if cfg.router and not job.route:
            result["error"] = self.tr("No Model Router pick for this case.")
            return self.scored(run, result)
        job.budget = round(min(room, max(CASE_CAP_MIN, run.estimates.get((case.id, cfg.id), 0) * CASE_CAP_FACTOR)), 2)  # fmt: skip
        run.reserved += job.budget
        where = self.checkout_root() / run.id / f"{case.id}-{cfg.id}" / case.project
        try:
            cwd, problem = await self.checkout(case, where)
            if cwd is None:
                result.update(status="error", error=self.tr("Couldn't make its copy: {error}", error=problem))  # fmt: skip
                return self.scored(run, result)
            job.cwd = cwd
            with contextlib.suppress(OSError):
                self.paths[cwd.resolve()] = cwd
            try:
                went = await self.runner.run(job)
            finally:
                with contextlib.suppress(OSError):
                    self.paths.pop(cwd.resolve(), None)
            result["cost_usd"] = round(float(went.get("cost") or 0.0), 4)
            result["seconds"] = float(went.get("seconds") or 0.0)
            if went.get("model_id"):
                result["model_id"] = went["model_id"]
            stats = await asyncio.to_thread(codeevals.diff_stats, where, case.base)
            result.update(stats)
            status = went.get("status")
            if status in ("error", "stopped"):
                result.update(status="error" if status == "error" else "skipped", error=str(went.get("error") or self.tr("Stopped: no more attempts start.")))  # fmt: skip
                return self.scored(run, result)
            if status == "timeout":
                result["error"] = self.tr("It ran out of time ({minutes} min).", minutes=CASE_SECONDS // 60)  # fmt: skip
            checked = await self.check(case, where, cwd)
            result["check_code"] = checked["code"]
            result["passed"] = checked["code"] == 0
            result["status"] = "passed" if result["passed"] else "failed"
            if checked["code"] == -1 and not result["error"]:
                result["error"] = self.tr("The check couldn't run: {error}", error=checked["tail"][-200:])  # fmt: skip
            self.scored(run, result)
        finally:
            run.reserved = max(0.0, run.reserved - job.budget)
            with contextlib.suppress(Exception):
                await self.drop_checkout(case, where)

    def scored(self, run: Run, result: dict[str, Any]) -> None:
        run.record["results"].append(result)
        run.record["spent_usd"] = round(run.record["spent_usd"] + result["cost_usd"], 4)
        run.record["summary"] = codeevals.summarize(run.record["configs"], run.record["results"])
        self.save_run(run)
        self.emit_run(run)

    def emit_run(self, run: Run) -> None:
        self.hub.emit("code_evals_run", **run.record)

    def cmd_stop(self, msg: dict[str, Any]) -> None:
        run = self.runs.get(str(msg.get("run") or ""))
        if run is None:
            return
        run.stopping = True
        for job in run.jobs:
            job.stop.set()
        self.say("Stopped: no more attempts start.")

    def cmd_run_get(self, msg: dict[str, Any]) -> None:
        wanted = str(msg.get("run") or "")
        for record in self.results(limit=RUNS_KEPT):
            if record["run"] == wanted:
                self.hub.emit("code_evals_run", **record)
                return


def _brief(record: dict[str, Any]) -> dict[str, Any]:
    """A run as the pane's list shows it."""
    return {k: record.get(k) for k in ("run", "started", "finished", "status", "spent_usd", "ceiling_usd", "summary", "configs")}  # fmt: skip


class _Options:
    """An attempt's session options (TaskManager.option_hooks): its share of the run's
    ceiling as Claude Code's max_budget_usd, its engine, its prompt and its rules."""

    def __init__(self, evals: CodeEvals) -> None:
        self.evals = evals

    def apply(self, task: Any, options: Any) -> None:
        job = self.evals.by_task.get(task.id)
        if job is None:
            return
        cfg = job.config
        if job.budget > 0:
            other = options.max_budget_usd
            known = isinstance(other, int | float) and not isinstance(other, bool) and other > 0
            options.max_budget_usd = min(job.budget, float(other)) if known else job.budget
        if cfg.engine and codeevals.engine_ok(cfg.engine):
            options.cli_path = cfg.engine
            options.env = {**(options.env or {}), "DISABLE_AUTOUPDATER": "1"}
        if cfg.rules == "off":
            options.setting_sources = []
        if cfg.prompt == "lean":
            options.system_prompt = {"type": "preset", "preset": "claude_code"}

    def key(self, task: Any) -> Any:
        job = self.evals.by_task.get(task.id)
        return (job.config.signature(), job.budget) if job is not None else None


def _log_failure(job: asyncio.Task) -> None:
    if not job.cancelled() and job.exception() is not None:
        log.error("Eden Code evals: a job failed", exc_info=job.exception())


def install(hub: Any) -> None:
    evals = CodeEvals(hub)
    hub.code_evals = evals  # (for the other features and the tests)
    hub.tasks.option_hooks.append(_Options(evals))
    hub.tasks.isolated_dir = evals.wrap_isolated_dir(hub.tasks.isolated_dir)
    desk = getattr(hub, "code_desk", None)  # (code_isolation installs before this one)
    if desk is not None:
        evals.watch_landing(desk)
    hub.register_command("cev_state", evals.cmd_state)
    hub.register_command("cev_add", evals.cmd_add)
    hub.register_command("cev_edit", evals.cmd_edit)
    hub.register_command("cev_remove", evals.cmd_remove)
    hub.register_command("cev_dismiss", evals.cmd_dismiss)
    hub.register_command("cev_calibrate", evals.cmd_calibrate)
    hub.register_command("cev_forecast", evals.cmd_forecast)
    hub.register_command("cev_run", evals.cmd_run)
    hub.register_command("cev_stop", evals.cmd_stop)
    hub.register_command("cev_run_get", evals.cmd_run_get)
