"""Model Router for Eden Code (code_router): the window's ✦ chip and Route popover
(web/features/code-router.js, with the router from the Model Router repo built into
web/features/vendor/model-router.js) pick a model and effort for each message; this puts
the session on them before the message goes.

- task_send with route {ref, effort?, model?, info?, fallbacks?, shadow?}: held while the
  session moves to that model at that effort (the window sends an effort only for a model
  whose way of running takes one: Claude, an Anthropic key, OpenAI-compatible models through
  openai_relay, Gemini Flash through gemini_proxy), then goes on; the same session's later
  messages wait behind it, so they keep their order. A session mid-step isn't moved (the
  message goes as it would have), nor one with messages still queued for the model it's on
  (they'd go on the next one's), unless they wait out Claude's limit; nor back onto Claude
  while Claude can't answer (a fallback took it off Claude: it'd only fail, fall back and
  move again, message after message). Moving onto another provider's model ends a wait for
  Claude's limit (code_limit). Auto (smart), which other providers' models can't run,
  comes back when the router returns to a Claude model that can, unless the owner picked a
  mode meanwhile (Manual too: only the mode the router left it in goes back). shadow: Shadow mode, the pick is logged and the session isn't
  moved. info: the route's numbers for the event log (code_router_events; never prompt text).
  fallbacks: the route's next picks ({ref, model, effort?}, at most 3), for the fallback.
- task_new with route: the new session starts on that model (and effort).
- route_wait: <token> on either (with the route): Gemini's rating of this very text is still
  on its way. The window sends the best pick it has at once (the rules' while Gemini rates)
  and the rated one after it; the message waits for it, inside its hold (so the session's
  order is kept), at most ROUTE_WAIT_SECONDS from when it came, then goes on the rated route
  if one came, else on its own. A window whose last pick for the text was already rated (or
  whose Gemini is unavailable, or for a trivial message: a few words, "yes", "go ahead")
  sends no route_wait: nothing waits.
- Automatic fallback (TaskManager.on_claude_down, wrapped): when a routed session's turn
  fails on its routed model (a rate or usage limit, an overload, a provider error), the
  session moves to the route's next pick and carries on from where it stopped (the hub's
  own move, hub._code_fallback), once per routed message. Only to a pick on the same
  provider (Claude to Claude, OpenRouter to OpenRouter): the session's code and transcript
  go to another company only with code_router_cross_fallback on. Claude's usage limit with
  "wait for it to reset" on (code_limit) is waited out, not fallen back from. Anything else,
  or with nothing to move to, goes on to the hub's fallback as before. Off with
  code_router_auto_fallback, or with Settings › Brain's fallback for Eden Code off.
- model_router_route {token, route?}: the rated route for a route_wait (no route: keep the
  message's own, as when the rating failed or changed nothing). Fast: never queued. One for a
  message still to come (sent after a question, as Bypass's) is kept EARLY_SECONDS; a late or
  unknown one changes nothing.
- model_router_classify {rid, model, body}: Ask Gemini. The router's rating request goes to
  Google with the Gemini key from Settings › Models, which never reaches the window ->
  model_router_classified {rid, status, body} (401: no key, 429: today's ratings are used up,
  502: Google couldn't be reached).
- model_router_claude {down, until}: whether Claude can answer now (its limit, an outage, as
  the hub's fallback sees it: hub._claude_back), and until when it can't (epoch ms), sent as
  it changes and on model_router_claude_get; the window's router leaves Claude out of its
  picks meanwhile, so it stops suggesting a model that would only fail.
- model_router_open: the full Model Router page (its own small server from the Model Router
  folder, started if it isn't running), in the browser.

Settings (prefs.features): code_router_on (every session's messages are routed until a model
is picked from the menu) and code_router_settings {efficiency, performance, classifier,
subscriptionClaude, shadow, learn, learnFromPrompts}: classifier "always" (the default:
Gemini rates every routed prompt; the rules' pick is the instant preview while typing and
the fallback), "auto" (only when the rating could change the pick) or "off" (the rules
alone); subscriptionClaude (default on: Claude on the owner's sign-in is priced as plan
quota, a fraction of its API price, and weighed by how much of the plan's windows is used);
shadow (default off: every message's pick is logged, the session isn't moved); learn
(default on) and learnFromPrompts (default off): see code_router_events, which also keeps
the event log, the learned overrides, spend, the budget and per-project defaults.

Privacy: a route carries model ids, efforts and the router's numbers; the prompt's text
goes only where it always went (the session; Google for a rating, with the key added here).

Cost policy: the routing itself calls no model. By default Gemini rates every routed prompt:
one small Gemini call (Flash, minimal thinking) per prompt it rates (the draft the owner
pauses on, or the message as it goes), on the owner's key, at most RATINGS_PER_DAY a day;
the same text again is rated from the window's memory, for nothing. The full page's own
server rates with the same key under its own cap of RATINGS_PER_DAY a day (passed to it),
and answers only pages on this machine. When the day's cap is
hit, or there's no Gemini key, the rules route alone (the window stops asking until the
keys change, or for a while) and messages never wait for a rating. Trivial messages are
never rated. The automatic fallback sends the failed turn's carry-on note to the next pick
once (that model's usual price); the event log and the learner call no model.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from .. import lang, mac_tools, osplat, utility_model
from ..prefs import MODELS, register_feature_pref
from ..tasks import EFFORTS, auto_capable

log = logging.getLogger("jarvis")

_DONE = "_cw_routed"  # set on a message once its session is on the routed model
PURPOSE = "model_router"
RATINGS_PER_DAY = 2000
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_GEMINI_MODEL = re.compile(r"gemini-[a-z0-9][a-z0-9.\-]{0,60}")
_REQUEST_KEYS = ("contents", "systemInstruction", "generationConfig")
MAX_REQUEST = 100_000  # bytes of JSON (the router sends a prompt's start and end, ~8,000 chars)
UI_PORT = 5174
UI_URL = f"http://127.0.0.1:{UI_PORT}/"
NODE_PATHS = ("/opt/homebrew/bin/node", "/usr/local/bin/node")
ROUTE_WAIT_SECONDS = 4.0  # the longest a message waits for Gemini's rating (from when it came)
EARLY_SECONDS = 120.0  # a rating that came before its message (one sent after a question)
MAX_TOKENS = 64  # ratings kept ahead of their messages, and tokens remembered as done
MAX_INFO = 16_000  # bytes of JSON a route's info may be (the event log's numbers)
_TOKEN = re.compile(r"[A-Za-z0-9_-]{8,64}")

ON_PREF = "code_router_on"
SETTINGS_PREF = "code_router_settings"
FALLBACK_PREF = "code_router_auto_fallback"
CROSS_PREF = "code_router_cross_fallback"  # the fallback may go to another provider's pick
DEFAULT_SETTINGS = {
    "efficiency": 50,
    "performance": 50,
    "classifier": "always",
    "subscriptionClaude": True,
    "shadow": False,
    "learn": True,
    "learnFromPrompts": False,
}
_SWITCHES = ("subscriptionClaude", "shadow", "learn", "learnFromPrompts")
# What a routed model's failure moves the session on for (TaskManager CLAUDE_DOWN kinds): a
# rate or usage limit, an overload, a provider's error. A sign-in or account problem doesn't.
RETRY_KINDS = frozenset({"rate_limit", "overloaded", "server_error", "billing_error"})
FALLBACK_SECONDS = 6 * 3600.0  # a route older than this is no guide for where to go
# What the Model Router page's server is started with (_start_page): enough for Node to run,
# never the backend's whole environment (with-keys.sh puts every Keychain key in it).
PAGE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE")


def clean_settings(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    out = dict(DEFAULT_SETTINGS)
    for key in ("efficiency", "performance"):
        v = value.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[key] = max(0, min(100, round(v)))
    if value.get("classifier") in ("off", "auto", "always"):
        out["classifier"] = value["classifier"]
    for key in _SWITCHES:
        if isinstance(value.get(key), bool):
            out[key] = value[key]
    return out


register_feature_pref(ON_PREF, False)
register_feature_pref(SETTINGS_PREF, dict(DEFAULT_SETTINGS), clean_settings)
register_feature_pref(FALLBACK_PREF, True)
register_feature_pref(CROSS_PREF, False)
utility_model.register_purpose(PURPOSE, RATINGS_PER_DAY)

ZH = {
    "There's no Google Gemini key: add one in Settings › Models to use Ask Gemini.": (
        "没有 Google Gemini 密钥：在 设置 › 模型 里添加一个，才能用“问 Gemini”。"
    ),
    "That's {n} Gemini ratings today; the router uses its own rules until tomorrow.": (
        "今天已经请 Gemini 评了 {n} 次；明天之前路由器只用自己的规则。"
    ),
    "Model Router isn't built in {folder}: run npm run build there.": (
        "{folder} 里的 Model Router 还没有构建：在那里运行 npm run build。"
    ),
    "Model Router needs Node.js to open its page: install it from nodejs.org.": (
        "打开 Model Router 的页面需要 Node.js：从 nodejs.org 安装。"
    ),
    "Model Router's page didn't start.": "Model Router 的页面没有启动。",
}
lang.add_texts(ZH)


def _queued(task: Any) -> bool:
    """Messages wait in the session's queue for the model it's on now (sent on their own
    routes, or before a reopen onto it): moving it would send them on another. Not while
    they wait out Claude's limit: they're no model's yet."""
    return not task.inbox.empty() and task.hold_until <= time.time()


def _error_body(message: str) -> str:
    return json.dumps({"error": {"message": message}})


def _token(value: Any) -> str:
    """A route_wait token as the window makes them, else ""."""
    return value if isinstance(value, str) and _TOKEN.fullmatch(value) else ""


def _plain_route(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or not isinstance(value.get("ref"), str):
        return None
    out = {k: value[k][:200] for k in ("ref", "effort", "model") if isinstance(value.get(k), str)}
    return out if out["ref"].strip() else None


def _clean_route(value: Any) -> dict[str, Any] | None:
    """A route as a message carries it ({ref, effort?, model?, shadow?, info?, fallbacks?}),
    or None. info is passed on for the event log (which keeps only its numbers and ids)."""
    out: dict[str, Any] | None = _plain_route(value)
    if out is None:
        return None
    if value.get("shadow") is True:
        out["shadow"] = True
    info = value.get("info")
    if isinstance(info, dict):
        with contextlib.suppress(TypeError, ValueError, RecursionError):
            if len(json.dumps(info)) <= MAX_INFO:
                out["info"] = info
    fallbacks = value.get("fallbacks")
    if isinstance(fallbacks, list):
        kept = [r for r in (_plain_route(f) for f in fallbacks[:3]) if r]
        if kept:
            out["fallbacks"] = kept
    return out


class Router:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.queues: dict[tuple[str, Any], asyncio.Task] = {}
        # Sessions whose Auto a routed model set aside -> the mode it left them in (Auto
        # comes back only while they're still in it: a mode the owner picks is theirs).
        self.auto_held: dict[int, str] = {}
        self.transport: Any = None  # (tests: an httpx MockTransport)
        self.server: Any = None  # the Model Router page's process, once started here
        # route_wait: token -> its rated route (None: the message's own), while it waits
        self.waits: dict[str, asyncio.Future] = {}
        self.early: dict[str, tuple[float, dict[str, Any] | None]] = {}  # came before it
        self.closed: collections.deque[str] = collections.deque(maxlen=MAX_TOKENS)
        # Each session's latest route the router moved it on: where its fallback goes.
        self.routes: dict[int, dict[str, Any]] = {}
        self._claude_told: dict[str, Any] | None = None  # model_router_claude, as last sent

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    # ── a message on its way ──

    def on_send(self, msg: dict[str, Any]) -> bool | None:
        """False: no route and nothing of the session's ahead of it (it goes on now)."""
        if msg.get(_DONE):
            return False
        try:
            key: Any = ("send", int(msg.get("id") or 0))
        except (TypeError, ValueError, OverflowError):  # (null, words, infinity: no session)
            return False
        token = self._wait_token(msg)
        if not isinstance(msg.get("route"), dict) and not token and key not in self.queues:
            return False
        return self._hold(key, self._send(msg, self._expect(token)))

    def on_new(self, msg: dict[str, Any]) -> bool | None:
        if msg.get(_DONE):
            return False
        key = ("new", str(msg.get("directory") or ""))
        token = self._wait_token(msg)
        if not isinstance(msg.get("route"), dict) and not token and key not in self.queues:
            return False
        return self._hold(key, self._new(msg, self._expect(token)))

    # ── Gemini's rating, for a message sent on the rules' pick (route_wait) ──

    def _wait_token(self, msg: dict[str, Any]) -> str:
        token = _token(msg.get("route_wait"))
        return "" if token in self.waits or token in self.closed else token  # (once only)

    def _expect(self, token: str) -> tuple[str, float]:
        """Wait for the token's rated route from now (the deadline counts from when the
        message came, not from when the ones ahead of it are done): (token, deadline)."""
        if not token:
            return "", 0.0
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        early = self.early.pop(token, None)
        if early is not None:
            future.set_result(early[1])
        self.waits[token] = future
        return token, loop.time() + ROUTE_WAIT_SECONDS

    def cmd_route(self, msg: dict[str, Any]) -> None:
        """model_router_route {token, route?}: the rated route a waiting message goes on."""
        token = _token(msg.get("token"))
        if not token or token in self.closed:
            return  # not a token the window makes, or its message went already
        route = _clean_route(msg.get("route"))
        future = self.waits.get(token)
        if future is not None:
            if not future.done():
                future.set_result(route)
            return
        now = time.monotonic()  # its message isn't here yet: kept a while, a few at most
        self.early = {t: v for t, v in self.early.items() if now - v[0] < EARLY_SECONDS}
        if len(self.early) < MAX_TOKENS:
            self.early[token] = (now, route)

    async def _rated(self, msg: dict[str, Any], wait: tuple[str, float], movable: bool) -> dict:
        """The message on its rated route, if that comes by the deadline; else as it is."""
        token, deadline = wait
        future = self.waits.get(token) if token else None
        if future is None:
            return msg
        try:
            remaining = deadline - asyncio.get_running_loop().time()
            if movable and not future.done() and remaining > 0:
                await asyncio.wait({future}, timeout=remaining)
            route = future.result() if future.done() else None
        finally:
            self.waits.pop(token, None)
            self.closed.append(token)
            future.cancel()  # (a no-op once it has its route)
        return {**msg, "route": route} if route else msg

    def _movable(self, task_id: int) -> bool:
        """A session a route can move now (else nothing to wait for)."""
        task = self.hub.tasks.tasks.get(task_id)
        return task is not None and task.kind == "code" and not task.busy and not _queued(task)

    def _hold(self, key: tuple[str, Any], work: Any) -> None:
        before = self.queues.get(key)
        task = self.hub._spawn(self._after(before, work))
        self.queues[key] = task
        task.add_done_callback(
            lambda t: self.queues.pop(key) if self.queues.get(key) is t else None
        )
        return None

    async def _after(self, before: Any, work: Any) -> None:
        if before is not None:
            await asyncio.wait([before])  # (in order: the one ahead of it goes first)
        await work

    @staticmethod
    def _route(msg: dict[str, Any]) -> tuple[str, str]:
        route = msg.get("route") if isinstance(msg.get("route"), dict) else {}
        ref = str(route.get("ref") or "").strip()[:200]
        effort = str(route.get("effort") or "")
        return ref, effort if effort in EFFORTS else ""

    @staticmethod
    def _onward(msg: dict[str, Any], **changes: Any) -> dict[str, Any]:
        out = {k: v for k, v in msg.items() if k not in ("route", "route_wait")}
        return {**out, **changes, _DONE: True}

    @staticmethod
    def _shadow(msg: dict[str, Any]) -> bool:
        route = msg.get("route")
        return isinstance(route, dict) and route.get("shadow") is True

    def _events(self) -> Any:
        return getattr(self.hub, "code_router_events", None)

    async def _send(self, msg: dict[str, Any], wait: tuple[str, float] = ("", 0.0)) -> None:
        loop = asyncio.get_running_loop()
        came = loop.time()
        task_id, skipped, before = 0, "", msg.get("route")
        try:
            task_id = int(msg.get("id") or 0)
            msg = await self._rated(msg, wait, self._movable(task_id))
            ref, effort = self._route(msg)
            if ref and not self._shadow(msg):
                skipped = await self._switch(task_id, ref, effort)
        except Exception:  # whatever went wrong, the message itself still goes
            log.exception("Model Router: couldn't move a session to its routed model")
            skipped = "error"
        source = "chip" if not wait[0] else "rated" if msg.get("route") is not before else "rules"
        self._log_route(
            task_id, msg, str(msg.get("text") or ""), source, skipped, loop.time() - came
        )
        await self.hub._handle_logged(self._onward(msg))

    def _log_route(
        self,
        task_id: int,
        msg: dict[str, Any],
        text: str,
        source: str,
        skipped: str,
        waited: float,
        new: bool = False,
    ) -> None:
        """The route into the event log (before the message goes, so its turn is expected),
        and remembered for the fallback when the router moved the session on it."""
        route = _clean_route(msg.get("route"))
        task = self.hub.tasks.tasks.get(task_id)
        if route is None or task is None:
            return
        shadow = route.get("shadow") is True
        events = self._events()
        sent = ""
        if events is not None:
            sent = events.routed(
                task, text, route, source=source, moved=not skipped, skipped=skipped,
                shadow=shadow, waited_ms=round(waited * 1000), new=new,
            )  # fmt: skip
        if shadow or skipped:
            return
        self.routes[task_id] = {
            "msg": sent,
            "ref": route["ref"],
            "model": route.get("model", ""),
            "fallbacks": route.get("fallbacks", []),
            "at": time.monotonic(),
            "retried": False,
        }

    async def _new(self, msg: dict[str, Any], wait: tuple[str, float] = ("", 0.0)) -> None:
        loop = asyncio.get_running_loop()
        came = loop.time()
        before = msg.get("route")
        msg = await self._rated(msg, wait, True)
        ref, effort = self._route(msg)
        changes: dict[str, Any] = {}
        shadow = self._shadow(msg)
        if ref and not shadow and self.hub.providers.known(ref):
            with contextlib.suppress(Exception):
                await self.hub._gemini_ready(ref)
            changes["model"] = ref
            if effort:
                changes["effort"] = effort
        known = set(self.hub.tasks.tasks)
        waited = loop.time() - came
        await self.hub._handle_logged(self._onward(msg, **changes))
        source = "chip" if not wait[0] else "rated" if msg.get("route") is not before else "rules"
        skipped = "" if shadow or changes else "unknown"
        for task_id in sorted(set(self.hub.tasks.tasks) - known):
            self._log_route(
                task_id, msg, str(msg.get("prompt") or ""), source, skipped, waited, new=True
            )

    async def _switch(self, task_id: int, ref: str, effort: str) -> str:
        """Put the session on the routed model (and effort): "" when it's on them, else why
        not ("busy", "not_code", "unknown": a model that's gone)."""
        hub = self.hub
        task = hub.tasks.tasks.get(task_id)
        if task is None or task.kind != "code":
            return "not_code"
        if task.busy:
            return "busy"
        if _queued(task):
            return "queued"  # what's waiting goes on the model it was sent for
        if not hub.providers.known(ref):
            return "unknown"
        claude = ref in MODELS
        if claude and str(task.model_ref).startswith("custom:") and not hub._claude_back():
            # Claude can't answer yet (its limit, an outage): onto it, the message would only
            # fail and fall back again. The session stays where the fallback put it, and
            # still goes back to Claude by itself once Claude is (fell_back_from is kept).
            return "claude_down"
        if task.model_ref != ref:
            was = task.mode
            await hub._gemini_ready(ref)
            await hub._task_model(task_id, ref)
            if was == "smart" and task.mode != "smart":
                self.auto_held[task_id] = task.mode  # Auto is Claude's: back when the router is
            if task.model_ref != ref:
                return "unknown"  # (its key, or the relay: the error is on screen)
        elif task.fell_back_from:
            # The router picked the model a fallback moved it to: it stays there (as a model
            # picked from the menu would), not back to the one that failed once Claude is back.
            task.fell_back_from = {}
        if claude and task_id in self.auto_held:
            left = self.auto_held.pop(task_id)
            if task.mode == left and auto_capable(task.model):  # (unless they chose since)
                hub.tasks.set_mode(task_id, "smart")
        # An effort comes only for a model whose way of running takes it (the window's
        # routeFor): Claude's own, and other providers' through Jarvis's relays.
        if effort and task.effort != effort:
            hub.tasks.set_effort(task_id, effort)
        return ""

    def on_mode(self, msg: dict[str, Any]) -> bool:
        """task_mode (the owner picks a permission mode): theirs from now on, so the router
        won't put Auto back over it, Manual included. The mode itself is the hub's to set."""
        with contextlib.suppress(TypeError, ValueError, OverflowError):
            self.auto_held.pop(int(msg.get("id") or 0), None)
        return False

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        """A session gone from the list (closed and pruned) takes its route and held Auto
        with it."""
        if kind != "tasks":
            return
        live = self.hub.tasks.tasks
        for gone in [t for t in self.routes if t not in live]:
            self.routes.pop(gone, None)
        for gone in [t for t in self.auto_held if t not in live]:
            self.auto_held.pop(gone, None)

    # ── the automatic fallback ──

    def claude_down(self, inner: Any) -> Any:
        """TaskManager.on_claude_down, wrapped: a routed session whose routed model couldn't
        answer moves to the route's next pick; anything else goes on as before."""

        def down(task: Any, why: str, said: str = "") -> bool:
            ref = ""
            try:
                ref = self._fallback_for(task, why)
                if ref:
                    self._fall_back(task, ref, why)
                    return True
            except Exception:
                log.exception("Model Router: couldn't move a session to its next pick")
            return inner(task, why, said) if inner is not None else False

        return down

    def _fallback_for(self, task: Any, why: str) -> str:
        hub = self.hub
        if why not in RETRY_KINDS or task.kind != "code" or task.falling_back:
            return ""
        if hub.prefs.feature(ON_PREF) is not True or hub.prefs.feature(FALLBACK_PREF) is False:
            return ""
        if getattr(hub.prefs, "fallback_code", True) is False:
            return ""  # the owner keeps Eden Code sessions where they are
        limit = getattr(hub, "code_limit", None)
        if (
            why == "rate_limit"
            and limit is not None
            and limit.wanted()
            and not str(task.model_ref).startswith("custom:")
        ):
            return ""  # Claude's usage limit, with "wait for it to reset" on: code_limit's
        last = self.routes.get(task.id)
        if not last or last["retried"] or time.monotonic() - last["at"] > FALLBACK_SECONDS:
            return ""
        if task.model_ref != last["ref"]:
            return ""  # not on its routed model now: not the router's to move
        here = self._company(task.model_ref)
        cross = hub.prefs.feature(CROSS_PREF) is True
        for route in last["fallbacks"]:
            if route["ref"] == task.model_ref or not hub.providers.known(route["ref"]):
                continue
            if not cross and self._company(route["ref"]) != here:
                continue  # the session's code and transcript stay with the provider it's on
            last["retried"] = True  # once per routed message
            last["to"] = route
            return route["ref"]
        return ""

    def _company(self, ref: str) -> str:
        """Whose servers a model's requests go to: "anthropic" for Claude (the owner's
        sign-in, or an Anthropic key), else the provider it was added under."""
        provider = self.hub.providers.provider_of(ref)
        if provider is None or provider.kind == "anthropic":
            return "anthropic"
        return str(provider.id)

    def _fall_back(self, task: Any, ref: str, why: str) -> None:
        if not str(task.model_ref).startswith("custom:"):
            with contextlib.suppress(Exception):
                self.hub._claude_couldnt()  # Claude itself: when, for the conversation's fallback
        events = self._events()
        if events is not None:
            to = (self.routes.get(task.id) or {}).get("to") or {}
            events.signal_task(
                task.id,
                {
                    "fellBack": {
                        "from": str(task.model or ""),
                        "to": to.get("model", ""),
                        "why": why,
                    }
                },
            )
        self.hub._spawn(self.hub._code_fallback(task, ref, why))

    # ── whether Claude can answer (model_router_claude) ──

    def claude_state(self) -> dict[str, Any]:
        """{down, until}: Claude can't answer until `until` (epoch ms), as the hub's own
        fallback reckons it (the reset time its limit gave, else half an hour on)."""
        from ..hub import FALLBACK_SECONDS as CLAUDE_BACK_SECONDS

        hub = self.hub
        if hub._claude_back():
            return {"down": False, "until": 0}
        down, back = hub._claude_down_at, hub._claude_back_at
        until = back if back > down else down + CLAUDE_BACK_SECONDS
        return {"down": True, "until": int(until * 1000)}

    def tell_claude(self, *, always: bool = False) -> None:
        """model_router_claude to the windows, when it changed since it was last sent."""
        state = self.claude_state()
        if always or state != self._claude_told:
            self._claude_told = state
            self.hub.emit("model_router_claude", **state)

    def cmd_claude(self, _msg: dict[str, Any]) -> None:
        self.tell_claude(always=True)

    def watch_claude(self) -> None:
        """The hub's own marks of Claude down (hub._claude_couldnt) and of its limit's reset
        time (on_rate_limit), wrapped so the windows hear of each change."""
        hub = self.hub
        couldnt, limit = hub._claude_couldnt, hub.tasks.on_rate_limit

        def claude_couldnt() -> None:
            couldnt()
            self.tell_claude()

        def on_rate_limit(info: Any) -> None:
            if limit is not None:
                limit(info)
            self.tell_claude()

        hub._claude_couldnt = claude_couldnt
        hub.tasks.on_rate_limit = on_rate_limit

    # ── Ask Gemini ──

    async def cmd_classify(self, msg: dict[str, Any]) -> None:
        rid = str(msg.get("rid") or "")[:40]

        def answer(status: int, body: str) -> None:
            self.hub.emit("model_router_classified", rid=rid, status=status, body=body)

        model = str(msg.get("model") or "")
        body = msg.get("body")
        if not _GEMINI_MODEL.fullmatch(model) or not isinstance(body, dict):
            answer(400, _error_body("Not a request the router makes."))
            return
        request = {k: body[k] for k in _REQUEST_KEYS if k in body}
        raw = json.dumps(request)
        if "contents" not in request or len(raw) > MAX_REQUEST:
            answer(400, _error_body("Not a request the router makes."))
            return
        key = await asyncio.to_thread(self.hub.providers.key_of, "gemini")
        if not key:
            answer(
                401,
                _error_body(
                    self.tr(
                        "There's no Google Gemini key: add one in Settings › Models to use Ask Gemini."
                    )
                ),
            )
            return
        try:  # counted before anything is sent
            utility_model.usage_for(self.hub).take(PURPOSE)
        except utility_model.OverBudget:
            answer(
                429,
                _error_body(
                    self.tr(
                        "That's {n} Gemini ratings today; the router uses its own rules until tomorrow.",
                        n=RATINGS_PER_DAY,
                    )
                ),
            )
            return
        import httpx

        try:
            async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
                reply = await client.post(
                    GEMINI_URL.format(model=model),
                    headers={"x-goog-api-key": key, "content-type": "application/json"},
                    content=raw,
                )
        except httpx.HTTPError as exc:
            answer(502, _error_body(f"Couldn't reach Google: {type(exc).__name__}"))
            return
        answer(reply.status_code, reply.text[:200_000].replace(key, "…"))

    # ── the full page ──

    async def cmd_open(self, _msg: dict[str, Any]) -> None:
        if not await self._answers():
            problem = await self._start_page()
            if problem:
                self.hub.emit("model_router_note", text=problem)
                return
        await mac_tools.run_command("open", UI_URL)

    async def _answers(self) -> bool:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=1.5, transport=self.transport) as client:
                return (await client.get(UI_URL + "api/meta")).status_code == 200
        except httpx.HTTPError:
            return False

    async def _start_page(self) -> str:
        """Start the Model Router page's server (from $MODEL_ROUTER_HOME or ~/Model Router),
        with the Gemini key so its Ask Gemini works too; "" once it answers, else why not."""
        folder = Path(os.environ.get("MODEL_ROUTER_HOME") or Path.home() / "Model Router")
        server = folder / "dist" / "ui" / "server.js"
        if not server.is_file():
            return self.tr(
                "Model Router isn't built in {folder}: run npm run build there.", folder=folder
            )
        node = shutil.which("node") or next((p for p in NODE_PATHS if Path(p).is_file()), None)
        if not node:
            return self.tr(
                "Model Router needs Node.js to open its page: install it from nodejs.org."
            )
        env = {
            k: v for k, v in os.environ.items() if k in PAGE_ENV or k.startswith("MODEL_ROUTER_")
        }
        key = await asyncio.to_thread(self.hub.providers.key_of, "gemini")
        if key:
            env["GEMINI_API_KEY"] = key
            env["MODEL_ROUTER_UI_RATINGS_PER_DAY"] = str(RATINGS_PER_DAY)
        self.server = await asyncio.create_subprocess_exec(
            node, str(server), "--port", str(UI_PORT),
            cwd=str(folder), env=env,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, **osplat.group_popen_kwargs(),
        )  # fmt: skip
        for _ in range(30):
            await asyncio.sleep(0.2)
            if await self._answers():
                return ""
        return self.tr("Model Router's page didn't start.")


def install(hub: Any) -> None:
    router = Router(hub)
    hub.code_router = router
    hub.tasks.on_claude_down = router.claude_down(hub.tasks.on_claude_down)
    hub.register_command("task_mode", router.on_mode)  # (then the hub's own)
    hub.add_task_sink(router.on_task_event)
    hub.register_command("task_send", router.on_send)
    hub.register_command("task_new", router.on_new)
    hub.register_command("model_router_route", router.cmd_route)  # (fast: a waiting message's)
    hub.register_command("model_router_classify", router.cmd_classify, slow=True)
    hub.register_command("model_router_open", router.cmd_open, slow=True)
    hub.register_command("model_router_claude_get", router.cmd_claude)
    router.watch_claude()
