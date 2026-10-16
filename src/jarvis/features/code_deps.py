"""Eden Code: dependency upgrades that understand breaking changes.

- Check: Eden Code settings › Dependency upgrades › Check now (or the scheduled dependency
  check, features/code_triggers.py) runs each of the project's package managers' own
  outdated command (code_deps.OUTDATED: npm, pnpm, Yarn, pip, uv, Poetry, Swift Package
  Manager, CocoaPods, Cargo, Go) in the project's folder, reads what they print, and plans
  the upgrades: one batch of every patch and minor upgrade per manager, and each major on its
  own. Nothing is fetched beyond what those commands fetch themselves; no release notes yet.
- Upgrade: the owner picks a batch or a major and presses Upgrade. Only then are its release
  notes read (the package's registry names its GitHub repository; its releases between the
  two versions, else its CHANGELOG.md), kept for code_deps.CACHE_DAYS in
  code_deps_notes.json, unless the owner turned code_deps_notes off. The breaking lines in
  them name code (`fooBar`, baz()); the code index (features/code_index.py) gives the files
  that import the package, and git grep in those files the call sites, each with the symbol
  it's in. That, the commands that upgrade the packages and the project's test command
  (the Tests pane's own discovery, codetests.discover) make the session's brief.
- The session: a run without the owner (features/code_unattended.py) in an isolated copy,
  on a card with the whole scope first. The release notes are someone else's words, so it's
  locked down as an issue's run is (none of the owner's settings, hooks, MCP servers or web
  tools), but its commands keep the network (installing a package needs it). It may run
  only the upgrade commands and the test command beyond the read-only ones.
- Landing: when it finishes, the receipt (the packages and versions, each breaking change
  and whether it was handled, not needed or left, the tests' result) goes into the
  transcript, and its pull request is drafted and held for the owner's OK (features/
  code_pr.py, as an issue's is), with the receipt in its description (pr_section). Nothing
  is pushed until the owner opens it.

Window commands: code_deps {project?}, code_deps_check {project}, code_deps_upgrade
{project, group}. Event: code_deps {project, managers, candidates, groups, errors, checked,
running}.
Settings (prefs.features): code_deps_notes (read release notes when an upgrade starts, on),
code_deps_spend (each upgrade's spending cap, $5). Kept in code_deps.json beside the
settings (each project's last check and the upgrades under way).

Cost policy: the check and the plan call no model. Each upgrade is one Eden Code session on
the model the project's sessions use, capped at code_deps_spend (default $5) and HOURS.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import time
from dataclasses import asdict, fields, replace
from pathlib import Path
from typing import Any

from .. import code_deps, code_search, codetests, jsonstore, lang, prefs
from ..proactive import Alert
from .code_unattended import check_command, end_hooks_of

log = logging.getLogger("jarvis")

PREF_NOTES = "code_deps_notes"
PREF_SPEND = "code_deps_spend"
HOURS = 2.0
COMMAND_SECONDS = 180.0  # an outdated command this long is stopped
OUTPUT_MAX = 2_000_000
FETCH_MAX = 3_000_000
FETCH_SECONDS = 15.0
CANDIDATES_KEPT = 300


def _spend(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if 0.5 <= value <= 50 else None


prefs.register_feature_pref(PREF_NOTES, True)
prefs.register_feature_pref(PREF_SPEND, 5.0, _spend)

ZH = {
    "Dependency upgrades": "依赖升级",
    "Upgrade {title} in {project} without you?": "要在 {project} 里不用你在场就升级 {title} 吗？",
    "Upgrade it": "升级",
    "Not now": "暂不",
    "Not started.": "没有开始。",
    "Started the upgrade in {project}: {title}.": "已在 {project} 里开始升级：{title}。",
    "Check {project} first.": "先检查 {project}。",
    "That upgrade isn't in the last check any more: check again.": "上次检查里已经没有这个升级了：再检查一次。",
    "Everything in {project} is up to date.": "{project} 里的依赖都是最新的。",
    "{project}: {n} out of date ({summary}).": "{project}：{n} 个过时（{summary}）。",
    "No package manager found in {project}.": "在 {project} 里没找到包管理器。",
    "An upgrade of {project} is already running.": "{project} 已经有一个升级在运行。",
    "The upgrade in {project} is done: its pull request waits for your OK.": "{project} 的升级完成了：它的拉取请求等你确认。",
    "The upgrade in {project} {how}.": "{project} 的升级{how}。",
}
lang.add_texts(ZH)


class Deps:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.path = hub.feature_path("code_deps.json")
        self.cache = code_deps.NotesCache(hub.feature_path("code_deps_notes.json"))
        self.fetch = self._fetch  # (the tests' fake answers instead)
        self.run_command = self._run_command
        self.have = lambda program: shutil.which(program) is not None
        self.search = code_search.search
        self.projects: dict[str, dict[str, Any]] = {}  # name -> its last check
        self.runs: dict[str, dict[str, Any]] = {}  # task id -> the upgrade under way
        self._checking: set[str] = set()
        self._loaded = False

    # ── plumbing ──

    def tr(self, text: str, **values: Any) -> str:
        if values:
            return lang.tr(text, self.hub.language, **values)
        return lang.translate(text, self.hub.language)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=text)

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        self.projects = {k: v for k, v in (data.get("projects") or {}).items() if isinstance(v, dict)}
        self.runs = {k: v for k, v in (data.get("runs") or {}).items() if isinstance(v, dict)}

    def save(self) -> None:
        try:
            jsonstore.save_json(self.path, {"projects": self.projects, "runs": dict(list(self.runs.items())[-50:])})
        except OSError as exc:
            log.info("deps: couldn't save (%s)", exc)

    def folder(self, project: str) -> Path:
        return self.hub.tasks.resolve_dir(project)

    def _run_command(self, argv: list[str], cwd: Path) -> tuple[int, str, str]:
        """A manager's command in the project's folder: (exit code, out, err)."""
        proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=COMMAND_SECONDS,
                              stdin=subprocess.DEVNULL, check=False)  # fmt: skip
        return proc.returncode, proc.stdout[:OUTPUT_MAX], proc.stderr[:OUTPUT_MAX]

    def _fetch(self, url: str) -> tuple[int, str]:
        """A registry's or GitHub's answer (status, text): only when an upgrade starts."""
        import httpx

        try:
            with httpx.Client(timeout=FETCH_SECONDS, follow_redirects=True,
                              headers={"User-Agent": "Eden-Code", "Accept": "application/json, text/plain"}) as c:  # fmt: skip
                r = c.get(url)
                return r.status_code, r.text[:FETCH_MAX]
        except httpx.HTTPError as exc:
            log.info("deps: %s didn't answer (%s)", url, exc)
            return 0, ""

    # ── the check ──

    def _check(self, root: Path) -> dict[str, Any]:
        managers = code_deps.detect(root)
        found: list[code_deps.Candidate] = []
        errors: list[str] = []
        declared = code_deps.declared_python(root)
        for m in managers:
            argv = code_deps.outdated_command(m, root, self.have)
            try:
                code, out, err = self.run_command(argv, root)
            except FileNotFoundError:
                errors.append(f"{code_deps.LABELS[m]} isn't installed here ({argv[0]}).")
                continue
            except subprocess.TimeoutExpired:
                errors.append(f"{' '.join(argv)} took too long; stopped.")
                continue
            text = out + ("\n" + err if m == "cargo" and argv[1] == "update" else "")
            rows = code_deps.parse(m, text, declared if m in ("pip", "uv") else None)
            if m == "swiftpm":
                where = code_deps.swift_locations(root)
                for c in rows:
                    c.repo = where.get(c.name.lower(), "")
            if not rows and code not in (0, 1) and err.strip():
                errors.append(f"{' '.join(argv)}: {err.strip().splitlines()[-1][:200]}")
            found += rows
        found = found[:CANDIDATES_KEPT]
        return {
            "managers": managers,
            "candidates": [asdict(c) for c in found],
            "groups": [g.public() for g in code_deps.plan(found)],
            "errors": errors,
            "checked": time.time(),
        }

    async def check(self, project: str) -> dict[str, Any]:
        """The project's outdated dependencies and the plan, published and kept."""
        self.load()
        root = await asyncio.to_thread(self.folder, project)
        name = root.name
        self._checking.add(name)
        self.publish(name)
        try:
            state = await asyncio.to_thread(self._check, root)
        finally:
            self._checking.discard(name)
        state["folder"] = str(root)
        self.projects[name] = state
        self.save()
        self.publish(name)
        return state

    def summary(self, name: str, state: dict[str, Any]) -> str:
        """One line for a check: how many, and of which kinds."""
        if not state.get("managers"):
            return self.tr("No package manager found in {project}.", project=name)
        rows = state.get("candidates") or []
        if not rows:
            return self.tr("Everything in {project} is up to date.", project=name)
        kinds = {k: sum(1 for r in rows if r.get("kind") == k) for k in code_deps.KINDS}
        parts = [f"{n} {k}" for k, n in kinds.items() if n]
        majors = [f"{r['name']} {r['latest']}" for r in rows if r.get("kind") == "major"][:3]
        summary = ", ".join(parts) + (f": {', '.join(majors)}" if majors else "")
        return self.tr("{project}: {n} out of date ({summary}).", project=name, n=len(rows), summary=summary)

    def under_way(self, name: str) -> list[dict[str, Any]]:
        """The project's upgrades still running: a run the app's quit stopped (its end
        hooks never heard it) isn't, so it never blocks the next."""
        active = getattr(getattr(self.hub, "code_runs", None), "active", {}) or {}
        return [r for t, r in self.runs.items()
                if r.get("project") == name and not r.get("ended") and t.isdigit() and int(t) in active]  # fmt: skip

    def publish(self, name: str = "") -> None:
        self.load()
        state = self.projects.get(name) or {}
        running = [r["group"]["id"] for r in self.under_way(name)]
        self.hub.emit("code_deps", project=name, managers=state.get("managers") or [],
                      candidates=state.get("candidates") or [], groups=state.get("groups") or [],
                      errors=state.get("errors") or [], checked=state.get("checked") or 0,
                      checking=name in self._checking, running=running)  # fmt: skip

    # ── an upgrade ──

    @staticmethod
    def group_of(raw: dict[str, Any]) -> code_deps.Group:
        names = {f.name for f in fields(code_deps.Candidate)}
        packages = [code_deps.Candidate(**{k: v for k, v in p.items() if k in names})
                    for p in raw.get("packages") or [] if isinstance(p, dict)]  # fmt: skip
        return code_deps.Group(str(raw.get("id") or ""), str(raw.get("manager") or ""),
                               str(raw.get("kind") or "batch"), packages)  # fmt: skip

    def _gather(self, root: Path, group: code_deps.Group, index: Any) -> dict[str, Any]:
        """The release notes (cached), the files that import each package, its call sites,
        and the test command: what the brief is made of."""
        read = self.hub.prefs.feature(PREF_NOTES) is not False
        notes: dict[str, code_deps.Notes] = {}
        users: dict[str, list[str]] = {}
        sites: dict[str, list[dict[str, Any]]] = {}
        files = getattr(index, "files", None) or {}
        for p in group.packages:
            if read:
                cached = self.cache.get(p.key())
                if cached is None:
                    cached = code_deps.notes_for(p, self.fetch)
                    if cached.source or cached.lines:
                        self.cache.put(p.key(), cached)
                notes[p.name] = cached
            else:
                notes[p.name] = code_deps.Notes(note="Release notes weren't read (Settings).")
            users[p.name] = code_deps.importers(files, p) if files else []
            sites[p.name] = code_deps.call_sites(root, notes[p.name].names, users[p.name] or None,
                                                 self.search, index)  # fmt: skip
        try:
            suites = codetests.discover(root)
        except OSError:
            suites = []
        return {"notes": notes, "users": users, "sites": sites,
                "tests": code_deps.test_command(root, suites)}  # fmt: skip

    async def upgrade(self, project: str, group_id: str, *, ask: bool = True, origin: str = "deps") -> str:
        """An upgrade the owner picked (or the scheduled check's batch, ask=False: approved
        when the check was turned on): its brief, the card, then the run."""
        self.load()
        root = await asyncio.to_thread(self.folder, project)
        name = root.name
        state = self.projects.get(name)
        if not state:
            return self.tr("Check {project} first.", project=name)
        raw = next((g for g in state.get("groups") or [] if g.get("id") == group_id), None)
        if raw is None:
            return self.tr("That upgrade isn't in the last check any more: check again.")
        if self.under_way(name):
            return self.tr("An upgrade of {project} is already running.", project=name)
        group = self.group_of(raw)
        index = None
        desk = getattr(self.hub, "code_index", None)
        if desk is not None and getattr(desk, "on", False):
            try:
                index = await desk.ready(root)
            except Exception:  # (no index: the call sites come from the whole project)
                log.info("deps: no code index for %s", name, exc_info=True)
        got = await asyncio.to_thread(self._gather, root, group, index)
        prompt = code_deps.brief(group, root, got["notes"], got["sites"], got["users"], got["tests"])
        commands = [c for c in [*code_deps.upgrade_commands(group, root), got["tests"]]
                    if c and not check_command(c)][:20]  # fmt: skip
        runs = self.hub.code_runs
        scope = runs.scope_from({
            "prompt": prompt, "project": str(root), "title": f"Upgrade {group.title()}"[:80],
            "mode": "edits", "commands": commands,
            "spend_cap": self.hub.prefs.feature(PREF_SPEND) or 5.0, "hours": HOURS,
        })  # fmt: skip
        if isinstance(scope, str):
            return scope
        if ask:
            noted = sum(len(n.lines) for n in got["notes"].values())
            placed = sum(len(s) for s in got["sites"].values())
            short = replace(scope, prompt=f"Upgrade {group.title()}, fix what its breaking "
                            "changes break, and run the tests.")  # (the brief itself is long)
            detail = runs.card(short, name)[1]
            detail = "\n".join([
                *(f"{p.name}: {p.current} → {p.latest} ({p.kind})" for p in group.packages),
                f"Release notes: {noted} breaking change{'s' if noted != 1 else ''} named; "
                f"{placed} call site{'s' if placed != 1 else ''} in the project.",
                f"Tests: {got['tests'] or 'none found'}.",
                "The release notes are someone else's words: the session gets none of your own "
                "settings, hooks, connectors or web tools. Its commands keep the network, to "
                "install the packages. When it's done, its pull request waits for your OK.",
                "", detail,
            ])  # fmt: skip
            question = self.tr("Upgrade {title} in {project} without you?", title=group.title(), project=name)
            if not await runs.ask(question, detail, "Upgrade it", False):
                return self.tr("Not started.")
        run = runs.start(scope, origin=origin, untrusted=True, sandbox=False)
        if isinstance(run, str):
            return run
        self.runs[str(run.task_id)] = {
            "project": name, "group": group.public(), "run": run.id, "started": run.started,
            "notes": {k: asdict(v) for k, v in got["notes"].items()}, "tests": got["tests"],
        }  # fmt: skip
        self.save()
        self.publish(name)
        return self.tr("Started the upgrade in {project}: {title}.", project=name, title=group.title())

    # ── its end ──

    def _tests(self, task: Any, since: float) -> dict[str, Any] | None:
        desk = getattr(self.hub, "code_receipts", None)
        found = desk.tests_of(task.id, since) if desk is not None else []
        if not found:
            return None
        last = found[-1]
        unknown = last.passed and not (last.passed_count or last.failed_count)
        return {"command": last.command[:120], "passed": None if unknown else last.passed,
                "passed_count": last.passed_count, "failed_count": last.failed_count}  # fmt: skip

    async def on_run_end(self, run: Any, task: Any, why: str) -> None:
        """An upgrade's run is over: its receipt in the transcript, and its pull request
        drafted and held for the owner's OK."""
        self.load()
        rec = self.runs.get(str(task.id))
        if rec is None or rec.get("ended"):
            return
        rec["ended"] = time.time()
        group = self.group_of(rec.get("group") or {})
        nf = set(code_deps.Notes.__dataclass_fields__)
        notes = {k: code_deps.Notes(**{a: b for a, b in v.items() if a in nf})
                 for k, v in (rec.get("notes") or {}).items() if isinstance(v, dict)}  # fmt: skip
        receipt = code_deps.receipt(group, notes, task.result or "", self._tests(task, float(rec.get("started") or 0)))
        receipt["why"] = why
        rec["receipt"] = receipt
        self.save()
        self.publish(rec.get("project") or "")
        self.hub.tasks._log(task, "system", code_deps.receipt_text(receipt), deps_receipt=receipt)
        name = rec.get("project") or run.project
        if why != "finished":
            how = self.hub.code_runs.how(run)
            self.notify(f"deps:{task.id}", self.tr("The upgrade in {project} {how}.", project=name, how=how))
            return
        desk = getattr(self.hub, "code_pr", None)
        if desk is None:
            return
        event = await desk.draft(task)
        if event.get("draft"):
            desk.drafts[task.id] = event["draft"] | {"waiting": True}
            await desk.publish(task)
            self.notify(f"deps:{task.id}", self.tr("The upgrade in {project} is done: its pull request waits for your OK.", project=name))

    def notify(self, key: str, text: str) -> None:
        self.hub.notify(Alert(key, "task", self.tr("Dependency upgrades"), text,
                              note="an Eden Code dependency upgrade is over"))  # fmt: skip

    def pr_section(self, task: Any, body: str) -> str:
        """The upgrade's receipt at the end of its pull request's description, once."""
        self.load()
        rec = self.runs.get(str(getattr(task, "id", "")))
        r = (rec or {}).get("receipt")
        if not r or code_deps.RECEIPT_MARK in body:
            return body
        return f"{body}\n\n{code_deps.receipt_text(r)}".strip()

    # ── window commands ──

    def _reply(self, coro: Any) -> None:
        async def run() -> None:
            try:
                said = await coro
            except (ValueError, OSError) as exc:
                said = str(exc)
            if isinstance(said, str):
                self.caption(said)

        self.hub._spawn(run())

    def cmd_state(self, msg: dict[str, Any]) -> None:
        project = str(msg.get("project") or "")
        name = ""
        if project:
            try:
                name = self.folder(project).name
            except (ValueError, OSError):
                name = ""
        self.publish(name)

    def cmd_check(self, msg: dict[str, Any]) -> None:
        async def run() -> str:
            project = str(msg.get("project") or "")
            state = await self.check(project)
            return self.summary(Path(state["folder"]).name, state)

        self._reply(run())

    def cmd_upgrade(self, msg: dict[str, Any]) -> None:
        self._reply(self.upgrade(str(msg.get("project") or ""), str(msg.get("group") or "")[:300]))


def install(hub: Any) -> None:
    deps = Deps(hub)
    hub.code_deps = deps  # (for the scheduled check, the pull requests and the tests)
    hub.register_command("code_deps", deps.cmd_state)
    hub.register_command("code_deps_check", deps.cmd_check, slow=True)
    hub.register_command("code_deps_upgrade", deps.cmd_upgrade, slow=True)
    end_hooks_of(hub).append(deps.on_run_end)
