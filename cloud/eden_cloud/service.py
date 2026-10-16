"""Eden Cloud's runs: the queue, the limits, the machines, and what the runners send back.

A run's life: uploading (a bundle source, until its bytes arrive) → queued → starting (its
machine asked for) → running (its runner fetched the job) → done | failed | cancelled |
timed_out | over_budget. At the end, whichever way it ends, its machine is stopped (deleting
the workspace), its source bundle is deleted and its runner token stops working; its events,
result bundle and diff stay keep_hours for the Mac, then the run is deleted entirely.

Limits, all per account (config.Settings), checked when a run is submitted and again when it
would start:
- plan: Eden Plus only unless the owner says otherwise (EDEN_CLOUD_REQUIRE_PLAN);
- runs at once (max_running_per_user) and waiting (max_queued_per_user), and the service's
  own max_running_total;
- minutes: each run's own limit (max_minutes_per_run), and what's left of the account's
  daily_minutes_per_user over the last 24 hours, whichever is less, becomes its deadline;
- money: each run's budget (passed to Claude Code as --max-budget-usd, and watched here in
  the cost its events report: past it, the run is stopped as over_budget), and
  daily_budget_usd_per_user over the last 24 hours of reported cost.

The user's Anthropic key: held in this process's memory from submission until the run's
machine is started with it, then dropped (never written, never logged, never sent back). A
service restart before a run starts loses it: that run fails, asking for it to be sent again.

Cost policy: no model is called here (the runs call Anthropic with the user's own key).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import secrets
import time
from typing import Any

from . import backends
from .backends import Backend, BackendNotReady, Launch
from .config import Settings
from .store import TERMINAL, Run, Store, token_hash

log = logging.getLogger("eden_cloud")

DAY = 86400.0
LINE_MAX = 1 << 20  # one event line, at most (a longer one is cut to a note)
BRANCH = re.compile(r"^(?!-)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]{1,200}(?<!/)(?<!\.lock)$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
MODEL = re.compile(r"^[A-Za-z0-9._:\[\]-]{1,80}$")
KEY = re.compile(r"^sk-ant-[A-Za-z0-9_-]{16,400}$")
URL = re.compile(r"^https://[A-Za-z0-9.-]+(:\d{1,5})?/[A-Za-z0-9._~/%+-]{1,400}$")
RESTARTED = (
    "Eden Cloud restarted before this run started, so it no longer has your key: send it again."
)


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def clean_source(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ServiceError(400, "bad_request", "Say where the code comes from (source).")
    kind = raw.get("kind")
    branch = str(raw.get("branch") or "")
    if not BRANCH.match(branch):
        raise ServiceError(400, "bad_request", "That isn't a branch name Eden Cloud takes.")
    if kind == "bundle":
        base = str(raw.get("base") or "")
        if not COMMIT.match(base):
            raise ServiceError(400, "bad_request", "A bundle needs the commit it starts from.")
        return {"kind": "bundle", "branch": branch, "base": base, "url": ""}
    if kind == "git":
        url = str(raw.get("url") or "")
        if not URL.match(url) or "@" in url.split("/", 3)[2]:
            raise ServiceError(
                400,
                "bad_request",
                "Only an https:// address without a password in it: a private repository "
                "goes as a bundle instead.",
            )
        base = str(raw.get("base") or "")
        if base and not COMMIT.match(base):
            raise ServiceError(400, "bad_request", "That isn't a commit.")
        return {"kind": "git", "branch": branch, "base": base, "url": url}
    raise ServiceError(400, "bad_request", 'source.kind is "bundle" or "git".')


class Service:
    def __init__(self, settings: Settings, store: Store, backend: Backend, clock=time.time) -> None:
        self.settings = settings
        self.store = store
        self.backend = backend
        self.clock = clock
        self._keys: dict[str, str] = {}
        self._signals: dict[str, asyncio.Event] = {}
        self._pumping = False
        self._again = False
        self._recovered = False

    # ── waiting for news of a run ──

    def notify(self, run_id: str) -> None:
        signal = self._signals.pop(run_id, None)
        if signal is not None:
            signal.set()

    async def wait(self, run_id: str, timeout: float) -> None:
        signal = self._signals.setdefault(run_id, asyncio.Event())
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(signal.wait(), timeout)

    # ── an account's use ──

    def usage(self, account: str) -> dict[str, Any]:
        now = self.clock()
        runs = self.store.since(account, now - DAY)
        seconds = 0.0
        for run in runs:
            if run.started:
                end = run.ended or now
                seconds += max(0.0, end - max(run.started, now - DAY))
        s = self.settings
        live = [r for r in runs if not r.terminal]
        cost = sum(r.cost_usd for r in runs)
        return {
            "running": sum(1 for r in live if r.state in ("starting", "running")),
            "waiting": sum(1 for r in live if r.state in ("uploading", "queued")),
            "minutes_used": round(seconds / 60, 1),
            "minutes_left": max(0.0, round(s.daily_minutes_per_user - seconds / 60, 1)),
            "cost_usd": round(cost, 4),
            "budget_left_usd": max(0.0, round(s.daily_budget_usd_per_user - cost, 4)),
        }

    def limits(self) -> dict[str, Any]:
        s = self.settings
        return {
            "plan": s.require_plan or "any",
            "max_running": s.max_running_per_user,
            "max_waiting": s.max_queued_per_user,
            "max_minutes_per_run": s.max_minutes_per_run,
            "default_minutes": s.default_minutes,
            "daily_minutes": s.daily_minutes_per_user,
            "max_budget_usd_per_run": s.max_budget_usd_per_run,
            "default_budget_usd": s.default_budget_usd,
            "daily_budget_usd": s.daily_budget_usd_per_user,
            "max_source_mb": s.max_source_mb,
            "keep_hours": s.keep_hours,
        }

    def may_use(self, user: Any) -> None:
        s = self.settings
        if s.allowed_accounts and user.account not in s.allowed_accounts:
            raise ServiceError(403, "forbidden", "Eden Cloud isn't open to this account yet.")
        if s.require_plan == "plus" and user.plan != "plus":
            raise ServiceError(402, "plan_needed", "Eden Cloud runs come with Eden Plus.")

    # ── submitting ──

    async def create(self, user: Any, body: dict[str, Any]) -> Run:
        self.may_use(user)
        s = self.settings
        brief = str(body.get("brief") or "").strip()
        if not brief:
            raise ServiceError(400, "bad_request", "Say what the run should do (brief).")
        if len(brief) > s.max_brief_chars:
            raise ServiceError(413, "too_big", "That brief is too long.")
        model = str(body.get("model") or "")
        if model and not MODEL.match(model):
            raise ServiceError(400, "bad_request", "That isn't a model name.")
        key = str(body.get("anthropic_key") or "")
        if not KEY.match(key):
            raise ServiceError(
                400, "key_needed", "Eden Cloud runs on your own Anthropic key: send it (sk-ant-…)."
            )
        source = clean_source(body.get("source"))
        try:
            budget = float(body.get("budget_usd") or s.default_budget_usd)
            minutes = int(body.get("max_minutes") or s.default_minutes)
        except (TypeError, ValueError):
            raise ServiceError(
                400, "bad_request", "budget_usd and max_minutes are numbers."
            ) from None
        budget = round(max(0.01, min(budget, s.max_budget_usd_per_run)), 2)
        minutes = max(1, min(minutes, s.max_minutes_per_run))
        use = self.usage(user.account)
        if use["running"] + use["waiting"] >= s.max_running_per_user + s.max_queued_per_user:
            raise ServiceError(
                429, "slow_down", "You have as many runs waiting as Eden Cloud takes."
            )
        if use["minutes_left"] < 1:
            raise ServiceError(429, "over_daily", "Today's Eden Cloud minutes are used up.")
        if use["budget_left_usd"] < 0.01:
            raise ServiceError(429, "over_daily", "Today's Eden Cloud budget is used up.")
        budget = min(budget, use["budget_left_usd"])
        now = self.clock()
        run = Run(
            id=secrets.token_hex(8),
            account=user.account,
            state="uploading" if source["kind"] == "bundle" else "queued",
            created=now,
            title=str(body.get("title") or brief.splitlines()[0])[:120],
            brief=brief,
            model=model,
            budget_usd=budget,
            max_minutes=minutes,
            source_kind=source["kind"],
            source_url=source["url"],
            branch=source["branch"],
            base=source["base"],
        )
        self._keys[run.id] = key
        self.store.put(run)
        if run.state == "queued":
            await self.pump()
        return self.store.get(run.id) or run

    def owned(self, user: Any, run_id: str) -> Run:
        run = self.store.get(run_id) if re.match(r"^[0-9a-f]{16}$", run_id or "") else None
        if run is None or run.account != user.account:
            raise ServiceError(404, "not_found", "No such run.")
        return run

    async def put_source(self, user: Any, run_id: str, data: bytes) -> Run:
        run = self.owned(user, run_id)
        if run.state != "uploading":
            raise ServiceError(409, "conflict", "This run already has its source.")
        if not data.startswith(b"# v2 git bundle\n") and not data.startswith(b"# v3 git bundle\n"):
            raise ServiceError(400, "bad_request", "That isn't a git bundle.")
        self.store.write_file(run.id, "source.bundle", data)
        run.state = "queued"
        self.store.put(run)
        await self.pump()
        return self.store.get(run.id) or run

    # ── starting ──

    async def pump(self) -> None:
        """Start what's waiting, as far as the limits allow, oldest first. One pump at a
        time: one asked for meanwhile (a run that ended as another started) goes round again
        rather than waiting on the first (a run failing to start ends inside the pump)."""
        if self._pumping:
            self._again = True
            return
        self._pumping = True
        try:
            while True:
                self._again = False
                await self._pump_once()
                if not self._again:
                    break
        finally:
            self._pumping = False

    async def _pump_once(self) -> None:
        s = self.settings
        busy = self.store.in_states(("starting", "running"))
        per: dict[str, int] = {}
        for run in busy:
            per[run.account] = per.get(run.account, 0) + 1
        for run in self.store.in_states(("queued",)):
            if len(busy) >= s.max_running_total:
                break
            if per.get(run.account, 0) >= s.max_running_per_user:
                continue
            if await self._start(run):
                busy.append(run)
                per[run.account] = per.get(run.account, 0) + 1

    async def _start(self, run: Run) -> bool:
        key = self._keys.pop(run.id, None)
        if key is None:
            await self.finish(run, "failed", RESTARTED)
            return False
        use = self.usage(run.account)
        left = min(run.max_minutes, use["minutes_left"])
        if left < 1:
            await self.finish(
                run, "failed", "Today's Eden Cloud minutes ran out before it started."
            )
            return False
        token = "ert1." + secrets.token_urlsafe(32)
        now = self.clock()
        run.runner_hash = token_hash(token)
        run.state, run.started = "starting", now
        run.deadline = now + left * 60
        self.store.put(run)
        s = self.settings
        launch = Launch(
            run_id=run.id,
            image=s.runner_image,
            env={
                "EDEN_RUN_ID": run.id,
                "EDEN_RUN_URL": s.public_url,
                "EDEN_RUN_TOKEN": token,
                "ANTHROPIC_API_KEY": key,
            },
            cpus=s.cpus,
            memory_mb=s.memory_mb,
            max_minutes=int(left),
        )
        del key
        try:
            run.handle = await self.backend.start(launch)
        except (BackendNotReady, ValueError) as exc:
            await self.finish(run, "failed", f"Couldn't start its machine: {exc}")
            return False
        except Exception:
            log.exception("backend start failed for %s", run.id)
            await self.finish(run, "failed", "Couldn't start its machine.")
            return False
        finally:
            launch.env.clear()
        self.store.put(run)
        self.notify(run.id)
        return True

    # ── ending ──

    async def finish(
        self, run: Run, state: str, error: str = "", exit_code: int | None = None
    ) -> Run:
        if run.terminal:
            return run
        run.state = state
        run.ended = self.clock()
        run.error = error[:1000]
        if exit_code is not None:
            run.exit_code = exit_code
        run.runner_hash = ""  # its token stops working
        self._keys.pop(run.id, None)
        self.store.put(run)
        await backends.stop_quietly(self.backend, run.handle)
        self.store.drop_file(run.id, "source.bundle")
        self.notify(run.id)
        with contextlib.suppress(Exception):
            await self.pump()
        return run

    async def cancel(self, user: Any, run_id: str) -> Run:
        run = self.owned(user, run_id)
        return await self.finish(run, "cancelled", "Cancelled from the Mac.")

    async def delete(self, user: Any, run_id: str) -> None:
        run = self.owned(user, run_id)
        await self.finish(run, "cancelled", "Deleted from the Mac.")
        self.store.delete(run.id)

    # ── the runner's side ──

    def runner(self, run_id: str, header: str) -> Run:
        match = re.match(r"^Bearer\s+(ert1\.[A-Za-z0-9_-]{43})$", header or "")
        run = self.store.get(run_id) if re.match(r"^[0-9a-f]{16}$", run_id or "") else None
        if (
            match is None
            or run is None
            or not run.runner_hash
            or run.terminal
            or not secrets.compare_digest(run.runner_hash, token_hash(match.group(1)))
        ):
            raise ServiceError(401, "signed_out", "Not this run's runner.")
        return run

    def job(self, run: Run) -> dict[str, Any]:
        if run.state == "starting":
            run.state = "running"
            self.store.put(run)
            self.notify(run.id)
        return {
            "id": run.id,
            "title": run.title,
            "brief": run.brief,
            "model": run.model,
            "budget_usd": run.budget_usd,
            "max_minutes": max(1, int((run.deadline - self.clock()) / 60)),
            "source": {
                "kind": run.source_kind,
                "url": run.source_url,
                "branch": run.branch,
                "base": run.base,
            },
        }

    async def add_events(self, run: Run, lines: list[str]) -> int:
        s = self.settings
        kept: list[str] = []
        over = False
        for raw in lines:
            line = raw.strip()
            if not line:
                continue
            if len(line) > LINE_MAX:
                line = json.dumps(
                    {"type": "eden_cloud", "note": "A line too long to keep was left out."}
                )
            if run.events_bytes + sum(len(k) for k in kept) + len(line) > s.max_events_mb << 20:
                over = True
                break
            kept.append(line)
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if isinstance(data, dict) and data.get("type") == "result":
                with contextlib.suppress(TypeError, ValueError):
                    run.cost_usd = max(run.cost_usd, float(data.get("total_cost_usd") or 0.0))
        seq = self.store.add_events(run, kept) if kept else run.events
        self.store.put(run)
        self.notify(run.id)
        if over:
            await self.finish(run, "failed", "It wrote more than Eden Cloud keeps.")
        elif run.cost_usd > run.budget_usd + 0.005:
            await self.finish(
                run, "over_budget", f"It reached its budget of ${run.budget_usd:.2f}."
            )
        return seq

    def put_result(self, run: Run, name: str, data: bytes) -> None:
        self.store.write_file(run.id, name, data)
        if name == "result.bundle":
            run.result_bytes = len(data)
        else:
            run.has_diff = True
        self.store.put(run)

    async def done(self, run: Run, body: dict[str, Any]) -> Run:
        try:
            code = int(body.get("exit_code"))
        except (TypeError, ValueError):
            code = -1
        error = str(body.get("error") or "")[:1000]
        return await self.finish(run, "done" if code == 0 and not error else "failed", error, code)

    # ── the watchdog ──

    async def recover(self) -> None:
        """At startup: runs that never got a machine can't (their keys are gone)."""
        if self._recovered:
            return
        self._recovered = True
        for run in self.store.in_states(("uploading", "queued")):
            if run.id not in self._keys:
                await self.finish(run, "failed", RESTARTED)

    async def tick(self) -> None:
        now = self.clock()
        s = self.settings
        for run in self.store.in_states(("starting", "running")):
            if run.deadline and now >= run.deadline:
                await self.finish(run, "timed_out", f"It ran out of time ({run.max_minutes} min).")
                continue
            if run.state == "starting" and now - run.started > s.start_seconds:
                await self.finish(run, "failed", "Its machine started but the run never did.")
                continue
            alive = await self.backend.alive(run.handle) if run.handle else False
            if alive is False and now - run.started > 30:
                await self.finish(run, "failed", "Its machine stopped before the run finished.")
        for run in self.store.in_states(("uploading",)):
            if now - run.created > 3600:
                await self.finish(run, "failed", "Its source never arrived.")
        for run in self.store.in_states(TERMINAL):
            if run.ended and now - run.ended > s.keep_hours * 3600:
                self.store.delete(run.id)
        await self.pump()

    async def watch(self, every: float = 10.0) -> None:
        await self.recover()
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("watchdog tick failed")
            await asyncio.sleep(every)
