"""Eden Code's OpenTelemetry export (code_otel): its sessions, turns, steps, subagents,
tokens and cost as OTLP/HTTP JSON spans and events, to a collector the owner names.

Off until the owner gives an endpoint (Settings › General › OpenTelemetry). What it hears:
the sessions' own events (hub.add_task_sink: the owner's message, each step and its end,
a subagent and its steps, the turn's end) and each turn's usage (TaskManager.on_usage,
chained to the Session card's, which runs first and unchanged). What's sent and what never
is: code_otel's docstring (no file contents, step inputs or outputs, paths or keys; the
owner's prompts and Claude's replies only with code_otel_prompts on, secrets blanked).

- A turn's spans go when it ends (and a batch sooner, past code_otel.BATCH_MAX). A
  collector that can't be reached keeps them waiting (up to code_otel.BUFFER_MAX, oldest
  first to go) for the next try; Settings shows what was sent and the last error.
- cw_otel_test {}: one test span and event sent now -> code_otel {..., tested, error}.
- cw_otel_status {}: -> code_otel {enabled, endpoint_ok, sent, waiting, error, at}.

Settings (prefs.features): code_otel_endpoint (str, "" = off), code_otel_prompts (bool,
off).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.error
from dataclasses import dataclass, field
from typing import Any

from .. import code_otel as otel
from .. import prefs

log = logging.getLogger("jarvis")

PREF_ENDPOINT = "code_otel_endpoint"
PREF_PROMPTS = "code_otel_prompts"


def _clean_endpoint(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 500:
        return None
    text = value.strip()
    return text if not text or otel.endpoints(text) is not None else None


prefs.register_feature_pref(PREF_ENDPOINT, "", _clean_endpoint)
prefs.register_feature_pref(PREF_PROMPTS, False)


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("jarvis")
    except Exception:
        return "dev"


@dataclass
class Turn:
    root: otel.Span
    steps: dict[str, otel.Span] = field(default_factory=dict)  # tool_use id -> its span
    reply: str = ""


class Telemetry:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.version = _version()
        self.turns: dict[int, Turn] = {}
        self.seen: set[int] = set()  # sessions whose start went
        self.usage: dict[int, tuple[float, Any]] = {}  # the turn's usage, till its end entry
        self.spans: list[otel.Span] = []
        self.logs: list[dict[str, Any]] = []
        self.sending = False
        self.sent = 0
        self.error = ""
        self.at = 0.0
        self.opener: Any = None  # (tests: urllib's urlopen's stand-in)

    # ── the owner's settings ──

    def where(self) -> tuple[str, str] | None:
        return otel.endpoints(str(self.hub.prefs.feature(PREF_ENDPOINT) or ""))

    def prompts(self) -> bool:
        return self.hub.prefs.feature(PREF_PROMPTS) is True

    def status(self, **extra: Any) -> dict[str, Any]:
        given = str(self.hub.prefs.feature(PREF_ENDPOINT) or "")
        return {
            "enabled": bool(given),
            "endpoint_ok": self.where() is not None,
            "sent": self.sent,
            "waiting": len(self.spans) + len(self.logs),
            "error": self.error,
            "at": self.at,
            **extra,
        }

    # ── what it hears ──

    def _task(self, data: dict[str, Any]) -> Any:
        task = self.hub.tasks.tasks.get(data.get("id"))
        return task if task is not None and getattr(task, "kind", "") == "code" else None

    def _common(self, task: Any) -> dict[str, Any]:
        model = str(task.model or getattr(self.hub.tasks, "model", "") or "")
        return {
            "gen_ai.provider.name": otel.provider_of(model),
            "gen_ai.request.model": model,
            "gen_ai.conversation.id": task.session_id,
            "eden_code.session.number": int(task.id),
            "eden_code.mode": str(task.mode or ""),
        }

    def _start_turn(self, task: Any) -> Turn:
        root = otel.Span("invoke_agent Eden Code", otel.new_trace_id(), kind=otel.INTERNAL)
        root.attrs.update(
            {
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.agent.name": "Eden Code",
                **self._common(task),
            }
        )
        turn = self.turns[task.id] = Turn(root)
        return turn

    def on_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind not in ("task_log", "task_log_update") or self.where() is None:
            return
        task = self._task(data)
        if task is None:
            return
        if task.id not in self.seen:
            self.seen.add(task.id)
            self.logs.append(otel.log_record("eden_code.session.start", self._common(task)))
        if kind == "task_log_update":
            self._step_ended(task, str(data.get("tool_id") or ""), str(data.get("status") or ""))
            return
        entry = data.get("entry") if isinstance(data.get("entry"), dict) else {}
        role = entry.get("role")
        turn = self.turns.get(task.id)
        if role == "user":
            if turn is None:
                turn = self._start_turn(task)
                if self.prompts():
                    turn.root.attrs["gen_ai.input.messages"] = otel.messages_attr(
                        "user", entry.get("text") or ""
                    )
            else:  # sent into the running turn (steering)
                turn.root.event("eden_code.user.message")
        elif role == "tool":
            turn = turn or self._start_turn(task)
            self._step_started(task, turn, entry)
        elif role == "subtool":
            turn = turn or self._start_turn(task)
            parent = turn.steps.get(str(entry.get("parent") or ""), turn.root)
            parent.event(
                "eden_code.subagent.tool", {"gen_ai.tool.name": str(entry.get("tool") or "")}
            )
        elif role == "assistant" and turn is not None:
            turn.reply = str(entry.get("text") or "")
        elif role == "turn":
            self._turn_ended(task, turn or self._start_turn(task), entry)

    def _step_started(self, task: Any, turn: Turn, entry: dict[str, Any]) -> None:
        tool = str(entry.get("tool") or "tool")[:100]
        call = str(entry.get("tool_id") or "")
        if tool == "Agent":
            agent = str(entry.get("agent") or "general-purpose")[:100]
            span = otel.Span(
                f"invoke_agent {agent}", turn.root.trace_id, parent_id=turn.root.span_id
            )
            span.attrs.update(
                {
                    "gen_ai.operation.name": "invoke_agent",
                    "gen_ai.agent.name": agent,
                    "gen_ai.tool.name": "Agent",
                    "gen_ai.tool.call.id": call,
                    "gen_ai.conversation.id": task.session_id,
                }
            )
        else:
            span = otel.Span(
                f"execute_tool {tool}", turn.root.trace_id, parent_id=turn.root.span_id
            )
            span.attrs.update(
                {
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": tool,
                    "gen_ai.tool.call.id": call,
                    "gen_ai.tool.type": "extension" if tool.startswith("mcp__") else "function",
                }
            )
        if call:
            turn.steps[call] = span
            if len(turn.steps) > 2000:  # (a runaway turn: its oldest open step goes as it is)
                self._push(turn.steps.pop(next(iter(turn.steps))).finish())

    def _step_ended(self, task: Any, call: str, status: str) -> None:
        turn = self.turns.get(task.id)
        span = turn.steps.pop(call, None) if turn is not None else None
        if span is None:
            return
        self._push(span.finish("tool_error" if status == "failed" else ""))

    def on_usage(self, task: Any, cost: float, message: Any) -> None:
        if getattr(task, "kind", "") == "code" and self.where() is not None:
            self.usage[task.id] = (cost, message)

    def _turn_ended(self, task: Any, turn: Turn, entry: dict[str, Any]) -> None:
        self.turns.pop(task.id, None)
        cost, message = self.usage.pop(task.id, (entry.get("cost"), None))
        usage = (getattr(message, "usage", None) or {}) if message is not None else {}
        models = (getattr(message, "model_usage", None) or {}) if message is not None else {}
        figures: dict[str, Any] = {
            "gen_ai.conversation.id": task.session_id,  # (known now, a new session's too)
            "gen_ai.response.model": next(iter(models), None) if isinstance(models, dict) else None,
            "gen_ai.usage.input_tokens": _int(usage.get("input_tokens")),
            "gen_ai.usage.output_tokens": _int(usage.get("output_tokens")),
            "gen_ai.usage.cache_read.input_tokens": _int(usage.get("cache_read_input_tokens")),
            "gen_ai.usage.cache_creation.input_tokens": _int(
                usage.get("cache_creation_input_tokens")
            ),
            "eden_code.tokens": _int(entry.get("tokens")),
            "eden_code.cost_usd": round(float(cost), 6) if isinstance(cost, int | float) else None,
            "eden_code.turn.seconds": _int(entry.get("seconds")),
        }
        error = ""
        if message is not None and getattr(message, "is_error", False):
            error = str(getattr(message, "subtype", "") or "error")
        for call, span in list(turn.steps.items()):  # steps with no end heard: as far as they got
            del turn.steps[call]
            self._push(span.finish())
        turn.root.attrs.update({k: v for k, v in figures.items() if v is not None})
        if self.prompts() and turn.reply:
            turn.root.attrs["gen_ai.output.messages"] = otel.messages_attr("assistant", turn.reply)
        self._push(turn.root.finish(error))
        self.logs.append(
            otel.log_record(
                "eden_code.turn",
                {**self._common(task), **{k: v for k, v in figures.items() if v is not None}},
                turn.root.trace_id,
                turn.root.span_id,
            )
        )
        self.flush()

    # ── sending ──

    def _push(self, span: otel.Span) -> None:
        self.spans.append(span)
        if len(self.spans) >= otel.BATCH_MAX:
            self.flush()

    def flush(self) -> None:
        if self.sending or not (self.spans or self.logs):
            return
        self.sending = True
        self.hub._spawn(self._send())

    async def _send(self) -> None:
        try:
            while self.spans or self.logs:
                where = self.where()
                if where is None:  # switched off meanwhile: nothing waits for it
                    self.spans.clear()
                    self.logs.clear()
                    break
                spans, logs = self.spans[: otel.BATCH_MAX], self.logs[: otel.BATCH_MAX]
                try:
                    if spans:
                        body = otel.traces_body(spans, self.version)
                        await asyncio.to_thread(otel.post, where[0], body, self.opener)
                        del self.spans[: len(spans)]
                        self.sent += len(spans)
                    if logs:
                        body = otel.logs_body(logs, self.version)
                        await asyncio.to_thread(otel.post, where[1], body, self.opener)
                        del self.logs[: len(logs)]
                        self.sent += len(logs)
                except (OSError, ValueError) as exc:
                    self.error = _why(exc)
                    self.at = time.time()
                    del self.spans[: max(0, len(self.spans) - otel.BUFFER_MAX)]
                    del self.logs[: max(0, len(self.logs) - otel.BUFFER_MAX)]
                    log.info("OpenTelemetry export failed: %s", self.error)
                    break
                self.error, self.at = "", time.time()
        finally:
            self.sending = False
            self.hub.emit("code_otel", **self.status())

    async def cmd_test(self, _msg: dict[str, Any]) -> None:
        where = self.where()
        if where is None:
            self.hub.emit(
                "code_otel",
                **self.status(
                    tested=False,
                    error="Give an OTLP/HTTP endpoint first: https://…, or http:// on this Mac or your network.",
                ),
            )
            return
        span = otel.Span("eden_code.test", otel.new_trace_id())
        span.attrs["eden_code.test"] = True
        try:
            await asyncio.to_thread(
                otel.post, where[0], otel.traces_body([span.finish()], self.version), self.opener
            )
            await asyncio.to_thread(
                otel.post,
                where[1],
                otel.logs_body(
                    [otel.log_record("eden_code.test", {}, span.trace_id, span.span_id)],
                    self.version,
                ),
                self.opener,
            )
        except (OSError, ValueError) as exc:
            self.error, self.at = _why(exc), time.time()
            self.hub.emit("code_otel", **self.status(tested=False))
            return
        self.sent += 2
        self.error, self.at = "", time.time()
        self.hub.emit("code_otel", **self.status(tested=True))


def _int(v: Any) -> int | None:
    return int(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _why(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"The collector answered {exc.code}."
    reason = getattr(exc, "reason", None) or getattr(exc, "strerror", None) or exc
    return f"Couldn't reach the collector: {str(reason)[:160]}"


def install(hub: Any) -> None:
    telemetry = Telemetry(hub)
    hub.code_otel = telemetry
    hub.add_task_sink(telemetry.on_event)
    before = hub.tasks.on_usage

    def chained(task: Any, cost: float, message: Any) -> None:
        try:
            if before is not None:
                before(task, cost, message)  # (the Session card's first, as it was)
        finally:
            try:
                telemetry.on_usage(task, cost, message)
            except Exception:
                log.exception("OpenTelemetry couldn't take a turn's usage")

    hub.tasks.on_usage = chained
    hub.register_command("cw_otel_test", lambda msg: hub._spawn(telemetry.cmd_test(msg)), slow=True)
    hub.register_command("cw_otel_status", lambda _msg: hub.emit("code_otel", **telemetry.status()))
