"""Eden Code's background routing queue (code_queue): "Run my queue" works through a project's
to-do cards (features/code_todo) by itself, each on the cheapest model that does the job.

How a card runs:
- The queue starts the project's waiting cards in their order, one at a time or N at once
  (its "at once" setting, 1 to PARALLEL_MAX), as ordinary sessions with the card's own mode,
  isolated copy and cloud settings.
- Its model: the card's own when it names one. Else the cheapest model on the ladder (the
  code_queue_ladder setting, cheapest first: Haiku, Sonnet, Opus unless the owner says
  otherwise) whose past results on this project passed Eden's checks: what the Model
  Router's event log (features/code_router_events) says each model's routed messages in
  this project came to (Eden's own check after the turn, "verified", first; else the owner
  undoing the work, or the turn's tests), a model qualifying with at least one pass and
  PASS_RATE of its results passing. With nothing learned yet, the Model Router's own pick
  for the card's prompt (the window's, sent with "Run my queue", rules only, never a
  Gemini rating), else the owner's default model.
- When its turn ends, Eden's checks run on it (features/code_verify: the page, the dev
  server's output, the checkers, a watch run of the tests). Passed: the card is done.
  Problems (or a turn that failed): the session moves to the next model up the ladder and
  is told what the checks found, to fix it there; past the top of the ladder, the card
  failed. Nothing to check (no dev server, tests or checkers; nothing changed): done, not
  verified. Each result goes into the router's event log as the "verified" signal on that
  model's routed message, so the next pick in the project learns from it.
- Stopped by the owner: the card says so, and the queue goes on with the next.

Money: every queued session is under the owner's spending caps (features/code_usage: a
day's or the project's cap used up pauses the queue, which goes on when there's room again)
and under the queue's own dollar ceiling (default CEILING_DEFAULT): its sessions together
never spend past it (each connection gets its share of what's left as Claude Code's own
max_budget_usd), and nothing starts or moves up the ladder once it's reached.

Window commands: todo_queue_run {directory, parallel?, ceiling?, routes?: {card id: route}}
(starts the queue; the settings are kept for the project), todo_queue_stop {directory} (no
more cards start; those running go on). The queues' state goes with code_todo's todo_state
{queues: {folder: {on, parallel, ceiling, spent, running, note}}}.
Settings (prefs.features): code_queue_ladder (model refs, cheapest first).
Labs: off until turned on in Settings › Eden Code › Labs ("Routing queue").

Cost policy: the queue calls no model of its own: each card is one session on the model
picked as above, and a card whose checks fail goes on in that session on the next model up
(that model's price), at most once per rung of the ladder, all within the caps and the
queue's ceiling. Picking reads the local event log; the checks run the project's own tools.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import secrets
import time
from pathlib import Path
from typing import Any

from .. import lang
from ..codeplatform import other_agent
from ..prefs import MODELS, register_feature_pref
from .code_router import _clean_route
from .code_usage import NEAR, spent

log = logging.getLogger("jarvis")

PREF_LADDER = "code_queue_ladder"
DEFAULT_LADDER = ["haiku", "sonnet", "opus"]  # cheapest first
PARALLEL_MAX = 4
CEILING_DEFAULT = 5.0  # dollars a queue may spend, unless the owner sets another
CEILING_MAX = 1000.0
PASS_RATE = 2 / 3  # of a model's results in the project that passed, to be picked
LOOK_BACK = 90 * 86400.0  # the event log's own retention
VERIFY_WAIT = 240.0  # seconds to wait for a check already running on the session
TICK = 60.0  # a paused queue looks again this often (a new day, a cap raised)


def _ladder(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    out = [v.strip()[:200] for v in value if isinstance(v, str) and v.strip()][:8]
    return list(dict.fromkeys(out)) or None


register_feature_pref(PREF_LADDER, list(DEFAULT_LADDER), _ladder)

ZH = {
    "Stopped: the queue has spent its {cap} ceiling.": "已停止：队列已花到 {cap} 的上限。",
    "Waiting: today's Eden Code spending limit is used up.": "等待中：今天的 Eden Code 花费上限已用完。",
    "Waiting: {project} has used up today's spending limit.": "等待中：{project} 今天的花费上限已用完。",
    "All the cards have run.": "所有卡片都运行过了。",
    "The checks after the last turn found problems: {what}": "上一轮之后的检查发现了问题：{what}",
    "The checks after the last turn found problems.": "上一轮之后的检查发现了问题。",
    "{model} takes over from here: fix what the checks found, run them again, and say what you changed.": "接下来由 {model} 接手：修好检查发现的问题，再跑一遍检查，并说明你改了什么。",
    "A queue's ceiling is at least $0.05.": "队列的上限至少是 $0.05。",
}
lang.add_texts(ZH)


def _money(value: float) -> str:
    return f"${value:,.2f}"


class Run:
    """One project's queue while it's on."""

    def __init__(self, folder: str, parallel: int, ceiling: float) -> None:
        self.folder = folder
        self.parallel = parallel
        self.ceiling = ceiling
        self.id = secrets.token_hex(4)
        self.on = True
        self.note = ""
        self.gone = 0.0  # what its cards deleted since had spent: still the run's


class Queue:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.runs: dict[str, Run] = {}  # folder -> its queue (on, or stopped with a note)
        self.by_task: dict[int, str] = {}  # session -> the card it runs
        self.jobs: set[asyncio.Task] = set()

    # ── plumbing ──

    @property
    def todo(self) -> Any:
        return self.hub.code_todo

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def spawn(self, coro: Any) -> asyncio.Task:
        job = asyncio.get_running_loop().create_task(coro)
        self.jobs.add(job)
        job.add_done_callback(self.jobs.discard)
        job.add_done_callback(_log_failure)
        return job

    def ladder(self) -> list[str]:
        return _ladder(self.hub.prefs.feature(PREF_LADDER)) or list(DEFAULT_LADDER)

    def model_id(self, ref: str) -> str:
        """The model a ref runs (what the event log names a turn's model by)."""
        if ref in MODELS:
            return MODELS[ref]
        try:
            # (only its name: no pass for a run that isn't starting)
            return str(self.hub.providers.session_config(ref, grant=False).get("model") or ref)
        except Exception:
            return ref

    def label(self, ref: str) -> str:
        try:
            return str(self.hub.providers.describe(ref) or ref)
        except Exception:
            return ref

    def cards(self, run: Run) -> list[dict[str, Any]]:
        return [c for c in self.todo.board.of(run.folder) if c.get("run") == run.id]

    def running(self, run: Run) -> list[dict[str, Any]]:
        return [c for c in self.cards(run) if c.get("state") == "running"]

    def spent(self, run: Run) -> float:
        """What the queue's sessions have spent, the open ones as they stand now."""
        total = 0.0
        for card in self.cards(run):
            task = self.hub.tasks.tasks.get(card.get("task"))
            if task is not None and card.get("state") == "running":
                total += spent(task)
            else:
                total += float(card.get("cost") or 0.0)
        return round(total + run.gone, 6)

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for folder, conf in self.todo.board.queues.items():
            out[folder] = {"on": False, "parallel": conf.get("parallel", 1)}
            out[folder]["ceiling"] = conf.get("ceiling", CEILING_DEFAULT)
        for folder, run in self.runs.items():
            out[folder] = {
                "on": run.on,
                "parallel": run.parallel,
                "ceiling": run.ceiling,
                "spent": self.spent(run),
                "running": len(self.running(run)),
                "note": run.note,
            }
        return out

    def changed(self) -> None:
        with contextlib.suppress(OSError):
            self.todo.board.save()
        self.todo.emit()

    # ── the window ──

    def cmd_run(self, msg: dict[str, Any]) -> None:
        folder = self.todo._folder(msg.get("directory"))
        if folder is None:
            return
        conf = self.todo.board.queues.setdefault(folder, {})
        parallel = msg.get("parallel", conf.get("parallel", 1))
        if not isinstance(parallel, int) or isinstance(parallel, bool):
            parallel = 1
        ceiling = msg.get("ceiling", conf.get("ceiling", CEILING_DEFAULT))
        if not isinstance(ceiling, int | float) or isinstance(ceiling, bool):
            ceiling = CEILING_DEFAULT
        try:  # (a 400-digit number is past any float: the default, as infinity is)
            ceiling = float(ceiling) if math.isfinite(ceiling) else CEILING_DEFAULT
        except OverflowError:
            ceiling = CEILING_DEFAULT
        if ceiling < 0.05:  # ($0 or less was taken up to $0.05, and a card started on it)
            self.todo.error(self.tr("A queue's ceiling is at least $0.05."))
            return
        conf["parallel"] = max(1, min(PARALLEL_MAX, parallel))
        conf["ceiling"] = round(max(0.05, min(CEILING_MAX, ceiling)), 2)
        routes = msg.get("routes") if isinstance(msg.get("routes"), dict) else {}
        for card in self.todo.board.of(folder):
            route = _clean_route(routes.get(card["id"]))
            if route is not None and not route.get("shadow"):
                card["route"] = {k: route[k] for k in ("ref", "model", "effort") if k in route}
        run = self.runs.get(folder)
        if run is None or (not run.on and not self.running(run)):
            run = self.runs[folder] = Run(folder, conf["parallel"], conf["ceiling"])
        else:  # (on, or stopped with cards still running: the same run, so they count in it)
            run.on, run.note = True, ""
            run.parallel, run.ceiling = conf["parallel"], conf["ceiling"]
        for card in self.todo.board.of(folder):
            if card.get("state") == "todo":
                card["state"], card["run"] = "queued", run.id
        self.changed()
        self.pump(folder)

    def cmd_stop(self, msg: dict[str, Any]) -> None:
        folder = self.todo._folder(msg.get("directory"))
        run = self.runs.get(folder or "")
        if run is None:
            return
        run.on = False
        for card in self.cards(run):
            if card.get("state") == "queued":
                card["state"] = "todo"
        self.changed()

    def forget(self, card: dict[str, Any]) -> None:
        """A card deleted (never a running one: code_todo refuses): what it spent stays
        its run's, so tidying the board never makes room under the ceiling."""
        run = self.runs.get(card.get("folder") or "")
        if run is not None and card.get("run") == run.id:
            run.gone = round(run.gone + float(card.get("cost") or 0.0), 6)
        for task_id, cid in list(self.by_task.items()):
            if cid == card["id"]:
                del self.by_task[task_id]

    # ── starting cards ──

    def blocked(self, run: Run) -> str:
        """Why no card may start now ("" when one may): the ceiling, then the owner's caps."""
        if self.spent(run) >= run.ceiling - NEAR:
            run.on = False
            for card in self.cards(run):
                if card.get("state") == "queued":
                    card["state"] = "todo"
            return self.tr(
                "Stopped: the queue has spent its {cap} ceiling.", cap=_money(run.ceiling)
            )
        meter = getattr(self.hub, "code_usage", None)
        if meter is None:
            return ""
        try:
            defaults = meter.defaults()
            caps = meter.usage.caps_for("", run.folder, defaults)
            if caps.day > 0 and meter.usage.today() >= caps.day - NEAR:
                return self.tr("Waiting: today's Eden Code spending limit is used up.")
            if caps.project > 0 and meter.usage.project_today(run.folder) >= caps.project - NEAR:
                return self.tr(
                    "Waiting: {project} has used up today's spending limit.",
                    project=Path(run.folder).name,
                )
        except Exception:  # (a cap that can't be worked out is no cap, as code_usage says)
            log.warning("Eden Code queue: couldn't read the spending caps", exc_info=True)
        return ""

    def pump(self, folder: str) -> None:
        """Start the queue's next cards, as many as it runs at once."""
        run = self.runs.get(folder)
        if run is None or not run.on:
            return
        while len(self.running(run)) < run.parallel:  # (a card starting is running already)
            waiting = [c for c in self.cards(run) if c.get("state") == "queued"]
            if not waiting:
                if not self.running(run):
                    run.on = False
                    run.note = self.tr("All the cards have run.")
                    self.changed()
                return
            why = self.blocked(run)
            if why != run.note:
                run.note = why
                self.changed()
            if why:
                return
            card = waiting[0]
            card["state"] = "running"
            card["attempts"] = []
            card.pop("verified", None)
            self.spawn(self._start(run, card))

    async def _start(self, run: Run, card: dict[str, Any]) -> None:
        try:
            ref, why = await self.pick(run.folder, card)
            task = await self.todo.start(card, model=ref)
        except Exception:  # (never a card left "running" with no session)
            log.exception("Eden Code queue: a card couldn't start")
            ref, why, task = "", "", None
        if task is None:
            card["state"] = "failed"
            self.changed()
            self.pump(run.folder)
            return
        self.by_task[task.id] = card["id"]
        used = ref or str(task.model_ref or "")
        card["attempts"].append({"model": used, "why": why})
        self.routed(task, card["prompt"], used, new=True)
        self.changed()

    async def pick(self, folder: str, card: dict[str, Any]) -> tuple[str, str]:
        """(the model ref for a card, why: "card", "learned", "router" or "default")."""
        if card.get("model"):
            return str(card["model"]), "card"
        results = await self.learned(folder)
        for ref in self.ladder():
            passed, failed = results.get(self.model_id(ref), (0, 0))
            if passed and passed / (passed + failed) >= PASS_RATE:
                return ref, "learned"
        route = card.get("route") if isinstance(card.get("route"), dict) else {}
        ref = str(route.get("ref") or "")
        if ref and self.hub.providers.known(ref):
            return ref, "router"
        return "", "default"

    async def learned(self, folder: str) -> dict[str, tuple[int, int]]:
        """What each model's routed messages in this project came to, from the router's
        event log: model -> (passed, failed)."""
        events = getattr(self.hub, "code_router_events", None)
        if events is None:
            return {}
        from .code_router_events import project_hash

        project = project_hash(folder)
        since = time.time() - LOOK_BACK
        with contextlib.suppress(Exception):
            await events.log.flush()

        def read() -> dict[str, tuple[int, int]]:
            models: dict[str, str] = {}
            signals: dict[str, dict[str, Any]] = {}
            for record in events.log.read(since=since):
                msg = str(record.get("msg") or "")
                if not msg:
                    continue
                if record.get("kind") is None and record.get("project") == project:
                    models[msg] = str((record.get("applied") or {}).get("model") or "")
                elif record.get("kind") == "update" and isinstance(record.get("signals"), dict):
                    signals.setdefault(msg, {}).update(record["signals"])
            out: dict[str, list[int]] = {}
            for msg, model in models.items():
                found = signals.get(msg) or {}
                if isinstance(found.get("verified"), bool):
                    passed = found["verified"]
                elif found.get("reverted") is True:
                    passed = False
                elif isinstance(found.get("testsPassed"), bool):
                    passed = found["testsPassed"]
                else:
                    continue  # (nothing said how it went)
                row = out.setdefault(model, [0, 0])
                row[0 if passed else 1] += 1
            return {m: (p, f) for m, (p, f) in out.items()}

        try:
            return await asyncio.to_thread(read)
        except Exception:
            log.warning("Eden Code queue: couldn't read the router's event log", exc_info=True)
            return {}

    def routed(self, task: Any, text: str, ref: str, new: bool = False) -> None:
        """The message logged as the router's (source "queue"), so its result is learned."""
        events = getattr(self.hub, "code_router_events", None)
        if events is None or other_agent(task):
            return
        route = {"ref": ref or str(task.model_ref or "default"), "model": str(task.model or "")}
        events.routed(task, text, route, source="queue", new=new)

    # ── a card's turn ends ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind != "task_finished" or data.get("task_kind") != "code":
            return
        cid = self.by_task.get(data.get("id"))
        card = self.todo.board.get(cid) if cid else None
        task = self.hub.tasks.tasks.get(data.get("id"))
        if card is None or task is None or card.get("state") != "running":
            return
        self.spawn(
            self._finished(
                card, task, str(data.get("status") or ""), data.get("files"), time.time()
            )
        )

    async def _finished(
        self, card: dict[str, Any], task: Any, status: str, files: Any, ended: float
    ) -> None:
        run = self.runs.get(card["folder"])
        attempt = card["attempts"][-1] if card.get("attempts") else {}
        card["cost"] = round(spent(task), 6)
        if status == "stopped":
            card["state"] = "stopped"
            self._done(card, task, run)
            return
        outcome: bool | None
        what = ""
        if status == "done":
            outcome, what = await self.verify(task, bool(files), ended)
        else:
            outcome = False  # (the turn failed: the next model up may get further)
        attempt["outcome"] = outcome
        if outcome is not None:
            events = getattr(self.hub, "code_router_events", None)
            if events is not None and not other_agent(task):
                events.signal_task(task.id, {"verified": outcome})
        if outcome is False and run is not None and await self.escalate(card, task, run, what):
            self.changed()
            return
        card["state"] = "failed" if outcome is False else "done"
        card["verified"] = outcome
        self._done(card, task, run)

    def _done(self, card: dict[str, Any], task: Any, run: Run | None) -> None:
        self.by_task.pop(task.id, None)
        self.changed()
        if run is not None:
            self.pump(run.folder)

    async def verify(self, task: Any, changed: bool, ended: float) -> tuple[bool | None, str]:
        """(whether the session's work passed Eden's checks, None when there was nothing to
        check; what the checks said). ended: when the turn ended (a check since is its)."""
        cv = getattr(self.hub, "code_verify", None)
        if cv is None or not changed:
            return None, ""
        await asyncio.sleep(0)  # (a check the session's own setting starts goes first)
        checks = cv.session(task.id)
        waited = 0.0
        while checks.checking and waited < VERIFY_WAIT:
            await asyncio.sleep(0.1)
            waited += 0.1
        last = checks.last or {}
        if float(last.get("at") or 0) < ended:  # (none since this turn ended: run one)
            await cv.check_turn(task, by_owner=True)
            last = checks.last or {}
        status = last.get("status")
        what = str(last.get("text") or "")
        return (True if status == "ok" else False if status == "problems" else None), what

    def stronger(self, ref: str, model: str) -> str:
        """The next model up the ladder from this one ("" at the top). One not on the ladder
        goes to its top."""
        ladder = self.ladder()
        for n, rung in enumerate(ladder):
            if rung == ref or (model and self.model_id(rung) == model):
                return ladder[n + 1] if n + 1 < len(ladder) else ""
        return ladder[-1] if ladder and ladder[-1] != ref else ""

    async def escalate(self, card: dict[str, Any], task: Any, run: Run, what: str) -> bool:
        """The card's session onto the next model up, told what the checks found: True when
        it goes on there."""
        if other_agent(task) or card.get("model"):
            return False  # (the owner named its model: never another behind their back)
        nxt = self.stronger(str(task.model_ref or ""), str(task.model or ""))
        if not nxt or any(a.get("model") == nxt for a in card.get("attempts") or []):
            return False
        if self.blocked(run):
            return False
        before = task.model_ref
        try:
            await self.hub._task_model(task.id, nxt)
        except Exception:
            log.warning("Eden Code queue: couldn't move a session up the ladder", exc_info=True)
            return False
        if task.model_ref == before and before != nxt:
            return False
        found = (
            self.tr("The checks after the last turn found problems: {what}", what=what[:600])
            if what
            else self.tr("The checks after the last turn found problems.")
        )
        text = f"{found}\n\n" + self.tr(
            "{model} takes over from here: fix what the checks found, run them again, and say "
            "what you changed.",
            model=self.label(nxt),
        )
        self.routed(task, text, nxt)
        card["attempts"].append({"model": nxt, "why": "escalated"})
        return bool(self.hub.tasks.send(task.id, text))

    # ── what a queued session may spend ──

    def budget(self, task: Any) -> float | None:
        cid = self.by_task.get(task.id)
        card = self.todo.board.get(cid) if cid else None
        run = self.runs.get(card["folder"]) if card else None
        if run is None or card.get("run") != run.id:
            return None
        others = max(1, len(self.running(run)))
        room = max(0.0, run.ceiling - self.spent(run))  # (Claude Code counts from the connection)
        return round(max(0.05, room / others), 2)

    async def tick(self) -> None:
        """A paused queue looks again now and then (a new day; a cap raised)."""
        while True:
            await asyncio.sleep(TICK)
            for folder, run in list(self.runs.items()):
                if run.on:
                    self.pump(folder)


class _Budget:
    """TaskManager.option_hooks: a queued session's share of the queue's ceiling, as Claude
    Code's own max_budget_usd (code_usage's caps, after it, keep the lower)."""

    def __init__(self, queue: Queue) -> None:
        self.queue = queue

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code" or other_agent(task):
            return
        cap = self.queue.budget(task)
        if cap is None:
            return
        other = options.max_budget_usd
        if isinstance(other, int | float) and not isinstance(other, bool) and other > 0:
            cap = min(cap, float(other))
        options.max_budget_usd = cap

    def key(self, task: Any) -> Any:
        # The card it runs, not the figure: the share is taken up at the next connection,
        # never by reopening one mid-card.
        return self.queue.by_task.get(task.id)


def _log_failure(job: asyncio.Task) -> None:
    if not job.cancelled() and job.exception() is not None:
        log.error("Eden Code queue: a job failed", exc_info=job.exception())


def install(hub: Any) -> None:
    queue = Queue(hub)
    hub.code_queue = queue
    hub.tasks.option_hooks.append(_Budget(queue))
    hub.add_task_sink(queue.on_task_event)
    hub.add_event_sink(["prefs"], lambda _e: [queue.pump(f) for f in list(queue.runs)])
    hub.register_command("todo_queue_run", queue.cmd_run)
    hub.register_command("todo_queue_stop", queue.cmd_stop)
    hub.register_loop("code_queue_tick", queue.tick)
