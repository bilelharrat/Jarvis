"""Model Router for messages that don't come from an Eden Code window (code_router_backend).

The window routes the messages typed in it (web/features/code-router.js: the router from the
Model Router repo, built into web/features/vendor/model-router.js). A message from anywhere
else used to go to whatever model its session was last routed to: from the phones (Eden
Code for iPhone and Android: features/_code_phone_routes.py, and the companion's code_send
and code_new), and from the local API (features/code_api.py) with the `eden-code` CLI and
the editor extension on it. Now each is routed too, wherever it comes from, with the pick
the window would make for it (code_router.Router: the sender marks it "from": "phone" or
"api", or calls Router.send; the router asks decide() here, then moves the session as it
does for the window's own messages, in the session's order with them).

How a pick is made, the first that can:
1. Here, with no window needed: the same bundle and the window's own helpers run in Node
   (features/_router_worker.cjs), kept running while it's used (stopped after IDLE_SECONDS
   with nothing to route, and when the app quits). It gets what the window knows: the model
   picker's list (providers.picker), the router's prefs, model_router_state
   (code_router_events: learned overrides, plan quota, the month's budget, sessions'
   projects and context) and whether Claude can answer (Router.claude_state). So the
   budget's lean, subscriptionClaude, the per-project levels, the providers left out in the
   pane and Shadow mode all count as they do in the window. Node is the owner's own (on the
   PATH, or Homebrew's): the app people download ships none, and its Electron can't run as
   Node (fuses: RunAsNode off), so there it's step 2.
2. A connected Eden Code window, asked over its socket (model_router_ask {rid, text, task?,
   rate} -> model_router_answer {rid, route?, final}): the rules' pick at once, then
   Gemini's when it's rated. A window that doesn't answer within ASK_FIRST_SECONDS isn't
   there (Eden chat's windows never answer).
3. Neither: no pick. The message goes to the session's own model (the one it was last
   routed to), and while Model Router is the model its next receipt says so
   (code_receipts: router_note).

Gemini's rating stays as the classifier setting says, as in the window: for a message to a
session (rate), while Model Router is the model, at most ROUTE_WAIT_SECONDS; never for a
new session's first message (the phone waits for the session to start: the rules' pick),
never in Shadow mode (the rules alone), never for a trivial message. The worker's rating
request comes back here and goes to Google as the window's does (Router.classify: the
owner's key from the Keychain, which never reaches Node, and the same RATINGS_PER_DAY).

Recorded in the router's event log as the window's routes are (code_router_events.routed),
with the route's source the sender ("phone", "api") and via how it was picked ("worker",
"window"): the Model Router pane's recent list says "from your phone".

Not routed here, on purpose: runs without the owner (code_unattended: GitHub issues, Linear
and Slack triggers, alerts, scheduled runs) start on the model their scope was approved
with; the to-do queue (code_queue) has its own ladder; a Linear agent's session names its
model; and the app's own notes to a session (a check's findings, a fallback's carry-on)
are no one's message to route.

Window commands: model_router_answer {rid, route?, final}.
Events: model_router_ask {rid, text, task?, rate}.

Cost policy: the routing itself calls no model. A rating is one small Gemini call (Flash,
minimal thinking) on the owner's key, as the window's, under the same daily cap; only
while Model Router is the model, its classifier is on and the message isn't trivial.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from .. import osplat
from .code_router import (
    NODE_PATHS,
    ON_PREF,
    PAGE_ENV,
    PROVIDERS_PREF,
    ROUTE_WAIT_SECONDS,
    SETTINGS_PREF,
    SHADOW_PREF,
    _clean_route,
    clean_settings,
)

log = logging.getLogger("jarvis")

WORKER = Path(__file__).with_name("_router_worker.cjs")
PROJECTS_PREF = "code_router_projects"  # = code_router_events.PREF_PROJECTS
START_SECONDS = 8.0  # Node loading the bundle
ANSWER_SECONDS = ROUTE_WAIT_SECONDS + 2.0  # the worker's answer, a rating included
ASK_FIRST_SECONDS = 1.0  # a window's first answer (the rules' pick): else there's none
IDLE_SECONDS = 1800.0  # the worker stops after this long with nothing to route
RETRY_SECONDS = 300.0  # a worker that couldn't start isn't tried again before this
NODE_LOOK_SECONDS = 60.0  # Node looked for again (installed meanwhile) at most this often
LINE_LIMIT = 4 * 1024 * 1024  # bytes of one line from the worker
MAX_TEXT = 20_000


def mode_of(feature: Any) -> str:
    """As code-router.js's modeOf, from prefs.feature: "live" (Model Router chosen: sessions
    move), "shadow" (picks logged, nothing moves), "" (off)."""
    on = feature(ON_PREF) is True
    settings = clean_settings(feature(SETTINGS_PREF)) or {}
    shadow = settings.get("shadow") is True or (not on and feature(SHADOW_PREF) is not False)
    return "live" if on and not shadow else "shadow" if shadow else ""


def find_node() -> str | None:
    return shutil.which("node") or next((p for p in NODE_PATHS if Path(p).is_file()), None)


class WorkerError(Exception):
    pass


class Backend:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.proc: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.answers: dict[int, asyncio.Future] = {}
        self.seq = 0
        self.starting: asyncio.Lock | None = None
        self.failed_at = float("-inf")  # when the worker last couldn't start (monotonic)
        self.used_at = 0.0
        self.idle: asyncio.TimerHandle | None = None
        self._node: tuple[float, str | None] | None = None
        self.asks: dict[str, dict[str, asyncio.Future]] = {}  # rid -> {first, final}
        self.find_node: Any = None  # (tests: a stand-in for find_node)

    def mode(self) -> str:
        return mode_of(self.hub.prefs.feature)

    # ── what the window would know ──

    def inputs(self, task: Any, text: str, rate: bool) -> dict[str, Any]:
        prefs = self.hub.prefs
        features = {
            k: prefs.feature(k)
            for k in (ON_PREF, SHADOW_PREF, SETTINGS_PREF, PROVIDERS_PREF, PROJECTS_PREF)
        }
        events = getattr(self.hub, "code_router_events", None)
        state = None
        if events is not None:
            try:
                state = events.state()
            except Exception:
                log.warning("Model Router: no model_router_state for a route", exc_info=True)
        router = getattr(self.hub, "code_router", None)
        claude = router.claude_state() if router is not None else {"down": False, "until": 0}
        return {
            "text": text[:MAX_TEXT],
            "task": _task_view(task),
            "picker": self.hub.providers.picker(),
            "features": features,
            "state": state,
            "claude": claude,
            "rate": rate,
            "waitMs": int(ROUTE_WAIT_SECONDS * 1000),
        }

    # ── the pick ──

    async def decide(self, task: Any, text: str, *, rate: bool) -> tuple[dict | None, str]:
        """The route the window would give this message ({ref, effort?, model, info?,
        fallbacks?, shadow?}) and how it was picked ("worker", "window"), or (None, "")."""
        if not self.mode() or not str(text or "").strip():
            return None, ""
        payload = self.inputs(task, str(text), rate)
        if self.node() is not None and time.monotonic() - self.failed_at >= RETRY_SECONDS:
            try:
                answer = await self.request(payload)
                return _clean_route(answer.get("route")), "worker"
            except WorkerError as exc:
                log.warning("Model Router: the backend's worker couldn't route: %s", exc)
        found, route = await self.ask_window(task, payload["text"], rate)
        if found:
            return route, "window"
        return None, ""

    # ── a window asked ──

    async def ask_window(self, task: Any, text: str, rate: bool) -> tuple[bool, dict | None]:
        """(whether a window answered, its route)."""
        if not getattr(self.hub, "_subscribers", None):
            return False, None
        loop = asyncio.get_running_loop()
        rid = "ra" + secrets.token_hex(8)
        first, final = loop.create_future(), loop.create_future()
        self.asks[rid] = {"first": first, "final": final}
        try:
            self.hub.emit("model_router_ask", rid=rid, text=text, task=_task_view(task), rate=rate)
            try:
                route, done = await asyncio.wait_for(asyncio.shield(first), ASK_FIRST_SECONDS)
            except TimeoutError:
                return False, None
            if not done:
                with contextlib.suppress(TimeoutError):
                    route = await asyncio.wait_for(asyncio.shield(final), ROUTE_WAIT_SECONDS + 0.5)
            return True, route
        finally:
            self.asks.pop(rid, None)

    def cmd_answer(self, msg: dict[str, Any]) -> None:
        """model_router_answer {rid, route?, final}: the first answer for each (another
        window's later one changes nothing)."""
        ask = self.asks.get(str(msg.get("rid") or ""))
        if ask is None:
            return
        route = _clean_route(msg.get("route"))
        final = msg.get("final") is not False
        if not ask["first"].done():
            ask["first"].set_result((route, final))
        if final and not ask["final"].done():
            ask["final"].set_result(route)

    # ── the worker ──

    def node(self) -> str | None:
        now = time.monotonic()
        if self._node is None or now - self._node[0] > NODE_LOOK_SECONDS:
            self._node = (now, (self.find_node or find_node)())
        return self._node[1]

    def can_route(self) -> bool:
        """Whether a pick may be had now: the worker can run (Node is here and it hasn't
        just failed to start), or a window is connected to ask."""
        worker = self.node() is not None and time.monotonic() - self.failed_at >= RETRY_SECONDS
        return worker or bool(getattr(self.hub, "_subscribers", None))

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        await self.ensure()
        proc = self.proc
        if proc is None or proc.stdin is None:
            raise WorkerError("not running")
        self.seq += 1
        rid = self.seq
        future = asyncio.get_running_loop().create_future()
        self.answers[rid] = future
        self.used_at = time.monotonic()
        try:
            await self._write({"id": rid, "op": "route", "input": payload})
            answer = await asyncio.wait_for(future, ANSWER_SECONDS)
        except TimeoutError:
            raise WorkerError("no answer in time") from None
        except (OSError, RuntimeError) as exc:
            raise WorkerError(f"the pipe failed: {exc}") from None
        finally:
            self.answers.pop(rid, None)
            self._idle_later()
        if not isinstance(answer, dict) or not answer.get("ok"):
            raise WorkerError(str((answer or {}).get("error") or "it failed"))
        return answer

    async def ensure(self) -> None:
        if self.proc is not None and self.proc.returncode is None:
            return
        if self.starting is None:
            self.starting = asyncio.Lock()
        async with self.starting:
            if self.proc is not None and self.proc.returncode is None:
                return
            node = self.node()
            if node is None:
                raise WorkerError("no Node.js")
            try:
                await self._start(node)
            except WorkerError:
                self.failed_at = time.monotonic()
                await self.stop()
                raise

    async def _start(self, node: str) -> None:
        env = {k: v for k, v in os.environ.items() if k in PAGE_ENV}  # (never the keys)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                node, str(WORKER), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                env=env, limit=LINE_LIMIT, **osplat.group_popen_kwargs(),
            )  # fmt: skip
        except OSError as exc:
            raise WorkerError(f"couldn't start Node: {exc}") from None
        assert self.proc.stdout is not None
        try:
            line = await asyncio.wait_for(self.proc.stdout.readline(), START_SECONDS)
        except TimeoutError:
            raise WorkerError("Node didn't load the router in time") from None
        try:
            hello = json.loads(line or b"{}")
        except ValueError:
            hello = {}
        if hello.get("op") != "ready":
            raise WorkerError(str(hello.get("error") or "the router didn't load"))
        self.reader = asyncio.get_running_loop().create_task(self._read(self.proc))

    async def _read(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        try:
            while line := await proc.stdout.readline():
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("op") == "classify":
                    self.hub._spawn(self._classify(msg))
                    continue
                future = self.answers.get(msg.get("id"))  # type: ignore[arg-type]
                if future is not None and not future.done():
                    future.set_result(msg)
        except (OSError, ValueError, asyncio.LimitOverrunError):
            log.warning("Model Router: the backend's worker said something unreadable")
        finally:
            for future in self.answers.values():
                if not future.done():
                    future.set_exception(WorkerError("the worker stopped"))

    async def _classify(self, msg: dict[str, Any]) -> None:
        """The worker's rating request: to Google as the window's goes (Router.classify)."""
        router = getattr(self.hub, "code_router", None)
        if router is None:
            status, body = 502, ""
        else:
            status, body = await router.classify(msg.get("model"), msg.get("body"))
        with contextlib.suppress(WorkerError, OSError, RuntimeError):
            await self._write(
                {
                    "op": "classified",
                    "rid": str(msg.get("rid") or ""),
                    "status": status,
                    "body": body,
                }
            )

    async def _write(self, msg: dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise WorkerError("not running")
        proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()

    def _idle_later(self) -> None:
        if self.idle is not None:
            self.idle.cancel()
        with contextlib.suppress(RuntimeError):
            loop = asyncio.get_running_loop()
            self.idle = loop.call_later(IDLE_SECONDS, lambda: self.hub._spawn(self._idle_stop()))

    async def _idle_stop(self) -> None:
        if time.monotonic() - self.used_at >= IDLE_SECONDS - 1 and not self.answers:
            await self.stop()

    async def stop(self) -> None:
        proc, self.proc = self.proc, None
        if self.reader is not None:
            self.reader.cancel()
            self.reader = None
        if proc is None or proc.returncode is not None:
            return
        with contextlib.suppress(Exception):
            if proc.stdin is not None:
                proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()

    def quit(self) -> None:
        """At the app's quit: the worker goes with it."""
        proc = self.proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()


def _task_view(task: Any) -> dict[str, Any] | None:
    """A session as the window's router sees it (its id, model and effort), or None."""
    if task is None:
        return None
    return {"id": task.id, "model": str(task.model or ""), "effort": str(task.effort or "")}


def install(hub: Any) -> None:
    backend = Backend(hub)
    hub.code_router_backend = backend
    hub.register_command("model_router_answer", backend.cmd_answer)  # (fast: one waits)
    hub.add_quit_hook(backend.quit)
