"""Eden Code: a real debugger for sessions and the owner (code_debugger.py), over the Debug
Adapter Protocol (code_dap.py: the protocol, the adapters, one run and its limits).

- Sessions: every Claude Code session gets the eden_code_debugger tool server in-process
  (session_extras), so it can debug a failing test instead of guessing: debug_adapters
  (which debuggers are here, and how to install a missing one: never installed for the
  owner), debug_launch {language, program | module, args, cwd, stop_on_entry, breakpoints,
  wait} (Python through debugpy, Node/JS through js-debug, Swift/C/C++/Rust through lldb-dap;
  python module "pytest" with a test's path debugs that test), debug_attach {language, pid |
  port}, debug_breakpoints {file, lines | breakpoints}, debug_continue / debug_step {kind:
  over, into, out} / debug_pause / debug_wait (each waits for the program to stop somewhere
  and says where: the stack, the source around the line, the locals), debug_status,
  debug_stack, debug_variables {frame_id | ref}, debug_evaluate {expression, frame_id} and
  debug_stop.
- What asks: debug_launch and debug_evaluate go past the session's permission check as a
  command does (they run the project's code), with their own wording on the card
  (tasks.FEATURE_TOOLS). debug_attach asks too, and for a process this debugger didn't start
  (or any port), the owner is asked again by name on a card of its own: a session never
  attaches to something it didn't start unless the owner says yes. The rest only read or
  move a run the owner already allowed, so they're on the session's allow list. Program,
  folder and breakpoint files must be inside the session's project; a port only on this Mac.
- Limits (code_dap): one run a session (a new launch ends the old one), RUNS_MAX at once,
  START_SECONDS to start, WAIT_SECONDS (at most WAIT_MAX) a wait, STEPS_MAX continues and
  steps, SESSION_SECONDS in all; capped stacks, variables and output. A session that's
  stopped or gone takes its run with it; quitting the app stops them all.
- The Debug pane (web/features/code-debug.js): the session's run (where it's stopped, the
  stack, a frame's variables to open, the output), and Take over: while the owner has it,
  the session's tools that move it say so and leave it alone (it reads still); Hand back
  gives it back. The owner can start a run of their own there too (control theirs from the
  start), set breakpoints, step and evaluate. Window commands: dbg_state {id} answered with
  dbg_state {id, on, run, adapters}; dbg_do {id, action, …} (launch, continue, next, stepIn,
  stepOut, pause, stop, take, release, frame, expand, evaluate, breakpoint) answered with
  dbg_state, dbg_vars {id, ref, variables}, dbg_eval {id, expression, result | error} or
  dbg_error {id, error}. An ACP session (code_acp.py) doesn't get the tools.

Setting (prefs.features): code_debugger (bool, on): off, sessions don't get the tools and
the pane can't start a run.

Cost policy (Claude): this feature never calls a model. It runs only the debug adapters the
owner has installed, on this computer.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shlex
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import code_dap, prefs
from ..code_dap import Adapter, Breakpoint, DapError, DebugSession

log = logging.getLogger("jarvis")

PREF = "code_debugger"
prefs.register_feature_pref(PREF, True)

SERVER = "eden_code_debugger"
RUNS_MAX = 4  # debug runs at once, across sessions
EMIT_DELAY = 0.15  # seconds a run's changes are gathered before the window hears of them
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")

# The tools that only read or move a run already allowed: unasked.
FREE = (
    "debug_adapters", "debug_breakpoints", "debug_continue", "debug_step", "debug_pause",
    "debug_wait", "debug_status", "debug_stack", "debug_variables", "debug_stop",
)  # fmt: skip
ASKED = ("debug_launch", "debug_attach", "debug_evaluate")
TOOLS = [f"mcp__{SERVER}__{name}" for name in FREE]

BREAKPOINTS_SCHEMA = {
    "type": "array",
    "description": "Breakpoints to set before it starts: [{file, line, condition?}].",
    "items": {
        "type": "object",
        "properties": {
            "file": {"type": "string"},
            "line": {"type": "integer"},
            "condition": {"type": "string"},
        },
        "required": ["file", "line"],
    },
}
WAIT_SCHEMA = {
    "type": "number",
    "description": f"Seconds to wait for it to stop (default {code_dap.WAIT_SECONDS:g}, at most {code_dap.WAIT_MAX:g}).",
}


def _text(text: str, error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], **({"is_error": True} if error else {})}


def _inside(root: Path, raw: str) -> Path | None:
    from ..tasks import _inside as inside

    return inside(root, raw)


def _launch_detail(tool_input: dict[str, Any], cwd: Path) -> str:
    what = str(tool_input.get("program") or "")
    if tool_input.get("module"):
        what = f"-m {tool_input['module']}"
    args = " ".join(shlex.quote(str(a)) for a in tool_input.get("args") or [])
    where = str(tool_input.get("cwd") or ".")
    return (
        f"{tool_input.get('language', '')} debugger: {what} {args}".rstrip()
        + f"\nin {where} ({cwd.name})"
    )


def _attach_detail(tool_input: dict[str, Any], _cwd: Path) -> str:
    if tool_input.get("pid"):
        return f"{tool_input.get('language', '')} debugger: attach to process {tool_input['pid']}"
    return f"{tool_input.get('language', '')} debugger: attach to port {tool_input.get('port')}"


def _evaluate_detail(tool_input: dict[str, Any], _cwd: Path) -> str:
    return f"In the program being debugged: {str(tool_input.get('expression') or '')[:600]}"


class DebugDesk:
    """One hub's debug runs: one a session at most, by its id."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.runs: dict[int, DebugSession] = {}
        self.adapters_override: Any = None  # (the tests' own: root -> [Adapter])
        self.env_override: dict[str, str] | None = None  # (the tests' own environment)
        self._emit_soon: dict[int, asyncio.TimerHandle] = {}

    def on(self) -> bool:
        try:
            return bool(self.hub.prefs.feature(PREF))
        except Exception:
            return True

    # ── where and with what ──

    def env_for(self, task: Any) -> dict[str, str]:
        if self.env_override is not None:
            base = dict(self.env_override)
        else:
            from .. import runproc

            base = runproc.shell_env()
        return {**base, **{k: v for k, v in dict(getattr(task, "env", {}) or {}).items() if v}}

    def adapters(self, root: Path, env: dict[str, str]) -> list[Adapter]:
        if self.adapters_override is not None:
            return list(self.adapters_override(root))
        return code_dap.find_adapters(root, env)

    def task(self, task_id: int) -> Any:
        return self.hub.tasks.tasks.get(task_id)

    def known_pids(self) -> set[int]:
        """The processes this debugger's runs launched (as their adapters said)."""
        found: set[int] = set()
        for run in self.runs.values():
            if run.request_kind == "launch":
                found |= run.pids
        return found

    # ── a run ──

    def _changed(self, task_id: int) -> None:
        """A run changed: the window hears of it shortly (its output comes line by line)."""
        if task_id in self._emit_soon:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._emit_soon[task_id] = loop.call_later(EMIT_DELAY, self._emit, task_id)

    def _emit(self, task_id: int) -> None:
        self._emit_soon.pop(task_id, None)
        run = self.runs.get(task_id)
        self.hub.emit("dbg_state", id=task_id, on=self.on(), run=run.snapshot() if run else None)

    async def start(
        self,
        task: Any,
        adapter: Adapter,
        kind: str,
        config: dict[str, Any],
        breakpoints: dict[str, list[Breakpoint]],
        driver: str,
    ) -> DebugSession:
        if not self.on():
            raise DapError("The debugger is off (Settings › Eden Code › General: Debugger).")
        old = self.runs.pop(task.id, None)
        if old is not None:
            await old.stop(why="A new run took its place.")
        live = [r for r in self.runs.values() if r.state != "ended"]
        if len(live) >= RUNS_MAX:
            raise DapError(f"{RUNS_MAX} debug runs are going already; stop one first.")
        run = DebugSession(
            adapter,
            Path(task.cwd),
            self.env_for(task),
            driver=driver,
            control=driver,
            on_change=lambda: self._changed(task.id),
        )
        self.runs[task.id] = run
        try:
            if kind == "attach":
                await run.attach(config, breakpoints)
            else:
                await run.launch(config, breakpoints)
        finally:
            self._changed(task.id)
        return run

    def run_of(self, task_id: int) -> DebugSession:
        run = self.runs.get(task_id)
        if run is None:
            raise DapError("No debug run in this session: start one with debug_launch.")
        return run

    def agent_may_move(self, run: DebugSession) -> None:
        if run.control == "user":
            raise DapError(
                "The user has taken over this debugger in the Debug pane. Leave it to them: "
                "wait until they hand it back (they'll say), or ask them what they found. "
                "debug_status, debug_stack and debug_variables still read it."
            )

    def breakpoints_from(self, root: Path, items: Any) -> dict[str, list[Breakpoint]]:
        found: dict[str, list[Breakpoint]] = {}
        for item in items or []:
            if not isinstance(item, dict):
                continue
            path = self.file_in(root, str(item.get("file") or ""))
            try:
                line = int(item.get("line"))
            except (TypeError, ValueError):
                raise DapError(f"A breakpoint needs a line number: {item}") from None
            found.setdefault(str(path), []).append(
                Breakpoint(line, str(item.get("condition") or "")[:300])
            )
        return found

    def file_in(self, root: Path, raw: str) -> Path:
        path = _inside(root, raw) if raw else None
        if path is None:
            raise DapError(f"{raw or 'That'} isn't a file inside this project.")
        return path

    async def launch_for(self, task: Any, args: dict[str, Any], driver: str) -> DebugSession:
        root = Path(task.cwd)
        env = self.env_for(task)
        adapters = await asyncio.to_thread(self.adapters, root, env)
        adapter = code_dap.adapter_for(str(args.get("language") or ""), adapters)
        if adapter is None:
            names = ", ".join(sorted({lang for a in adapters for lang in a.languages}))
            raise DapError(f"No debugger for {args.get('language')!r}. Eden debugs: {names}.")
        if not adapter.available:
            raise DapError(
                f"{adapter.name} isn't installed here, so {args.get('language')} can't be debugged yet. {adapter.install} (Ask the user to install it; don't install it yourself.)"
            )
        module = str(args.get("module") or "").strip()
        if module and adapter.id != "python":
            raise DapError("module is for Python (python -m); give a program for this language.")
        program = ""
        if not module:
            program = str(self.file_in(root, str(args.get("program") or "")))
        cwd = self.file_in(root, str(args.get("cwd") or "")) if args.get("cwd") else root
        argv = args.get("args") or []
        if isinstance(argv, str):
            argv = shlex.split(argv)
        config = code_dap.launch_config(
            adapter,
            program=program,
            module=module,
            args=[str(a) for a in argv][:100],
            cwd=str(cwd),
            stop_on_entry=bool(args.get("stop_on_entry")),
        )
        return await self.start(
            task,
            adapter,
            "launch",
            config,
            self.breakpoints_from(root, args.get("breakpoints")),
            driver,
        )

    async def attach_for(self, task: Any, args: dict[str, Any]) -> DebugSession:
        root = Path(task.cwd)
        env = self.env_for(task)
        adapters = await asyncio.to_thread(self.adapters, root, env)
        adapter = code_dap.adapter_for(str(args.get("language") or ""), adapters)
        if adapter is None or not adapter.available:
            raise DapError(
                f"No debugger for {args.get('language')!r} here."
                + (f" {adapter.install}" if adapter is not None else "")
            )
        try:
            pid = int(args.get("pid") or 0)
            port = int(args.get("port") or 0)
        except (TypeError, ValueError):
            raise DapError("pid and port are numbers.") from None
        host = str(args.get("host") or "127.0.0.1")
        if host not in LOCAL_HOSTS:
            raise DapError("The debugger attaches only on this computer (127.0.0.1).")
        if not pid and not port:
            raise DapError("Say which process (pid) or debug port to attach to.")
        if not (pid and pid in self.known_pids()) and not await self.owner_allows_attach(
            task, adapter, pid, port
        ):
            raise DapError(
                "The user said no to attaching the debugger to that process. Don't try "
                "another way; ask them, or launch the program under the debugger instead."
            )
        config = code_dap.attach_config(adapter, pid=pid, port=port, host="127.0.0.1")
        return await self.start(
            task,
            adapter,
            "attach",
            config,
            self.breakpoints_from(root, args.get("breakpoints")),
            "agent",
        )

    async def owner_allows_attach(self, task: Any, adapter: Adapter, pid: int, port: int) -> bool:
        """A process this debugger didn't start: the owner says, on a card naming it."""
        what = f"port {port}"
        if pid:
            what = f"process {pid}"
            with contextlib.suppress(Exception):
                import psutil

                proc = psutil.Process(pid)
                what = f"{proc.name()} (process {pid})"
        choice = await self.hub.request_approval(
            f"Let Eden Code attach the debugger to {what}?",
            f"Eden Code in {Path(task.cwd).name} didn't start it. With {adapter.name} attached it can "
            "pause it, read its memory and run expressions in it. It's left running when the debugger stops.",
            [("allow", "Attach"), ("deny", "Not now")],
            context={"task_id": task.id, "tap_only": True},
        )
        return choice == "allow"

    # ── the session's tools ──

    def tools(self, task: Any) -> list[Any]:
        desk = self
        root = Path(task.cwd)

        async def guarded(work) -> dict[str, Any]:
            try:
                return _text(await work())
            except DapError as exc:
                return _text(str(exc), error=True)
            except Exception as exc:  # a tool never takes the session down
                log.exception("debugger: a tool failed")
                return _text(f"The debugger failed: {exc}", error=True)

        def wait_of(args: dict[str, Any]) -> float:
            try:
                return max(
                    0.0, min(float(args.get("wait") or code_dap.WAIT_SECONDS), code_dap.WAIT_MAX)
                )
            except (TypeError, ValueError):
                return code_dap.WAIT_SECONDS

        @tool(
            "debug_adapters",
            "Which debuggers Eden Code can use here (Python: debugpy, Node/JS: js-debug, Swift/C/"
            "C++/Rust: lldb-dap), and how to install a missing one. Never install one yourself: "
            "tell the user the command.",
            {"type": "object", "properties": {}},
        )
        async def debug_adapters(_args):
            async def work():
                env = desk.env_for(task)
                found = await asyncio.to_thread(desk.adapters, root, env)
                return "\n".join(
                    f"{a.name} ({', '.join(a.languages)}): "
                    + (
                        "ready" + (f", runs {a.runtime}" if a.runtime else "")
                        if a.available
                        else f"not installed. {a.install}"
                    )
                    for a in found
                )

            return await guarded(work)

        @tool(
            "debug_launch",
            "Start a program under a real debugger, with breakpoints, and wait for it to stop "
            "(a breakpoint, an exception, the entry with stop_on_entry). Says where it stopped: "
            "the stack, the source around the line and the locals. To debug a failing Python "
            "test: language python, module pytest, args [the test's path or node id, -x], a "
            "breakpoint where it goes wrong. program (inside the project) for a script or a "
            "built binary (lldb: build with debug info first). A new launch ends this session's "
            f"earlier run. Limits: {code_dap.STEPS_MAX} continues and steps, "
            f"{code_dap.SESSION_SECONDS // 60} minutes a run.",
            {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "description": "python, javascript, typescript, node, swift, c, cpp, rust",
                    },
                    "program": {
                        "type": "string",
                        "description": "The file to run (inside the project).",
                    },
                    "module": {
                        "type": "string",
                        "description": "Python only: run this module (python -m), e.g. pytest.",
                    },
                    "args": {"type": "array", "items": {"type": "string"}},
                    "cwd": {"type": "string"},
                    "stop_on_entry": {"type": "boolean"},
                    "breakpoints": BREAKPOINTS_SCHEMA,
                    "wait": WAIT_SCHEMA,
                },
                "required": ["language"],
            },
        )
        async def debug_launch(args):
            async def work():
                run = await desk.launch_for(task, args, "agent")
                return f"Started {run.adapter.name}: {run.target}.\n" + code_dap.report_text(
                    await run.wait(wait_of(args)), root
                )

            return await guarded(work)

        @tool(
            "debug_attach",
            "Attach the debugger to a running process on this computer (pid; Python and Node "
            "also by debug port). A process this debugger didn't start needs the user's yes, "
            "asked on a card. It's left running when the debugger stops.",
            {
                "type": "object",
                "properties": {
                    "language": {"type": "string"},
                    "pid": {"type": "integer"},
                    "port": {"type": "integer"},
                    "breakpoints": BREAKPOINTS_SCHEMA,
                },
                "required": ["language"],
            },
        )
        async def debug_attach(args):
            async def work():
                run = await desk.attach_for(task, args)
                return f"Attached {run.adapter.name} to {run.target}.\n" + code_dap.report_text(
                    await run.wait(1.0), root
                )

            return await guarded(work)

        @tool(
            "debug_breakpoints",
            "Set all of a file's breakpoints in this session's debug run (replacing that file's "
            "earlier ones; an empty list clears them). Each line may have a condition.",
            {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "lines": {"type": "array", "items": {"type": "integer"}},
                    "breakpoints": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "line": {"type": "integer"},
                                "condition": {"type": "string"},
                            },
                            "required": ["line"],
                        },
                    },
                },
                "required": ["file"],
            },
        )
        async def debug_breakpoints(args):
            async def work():
                run = desk.run_of(task.id)
                desk.agent_may_move(run)
                path = desk.file_in(root, str(args.get("file") or ""))
                wanted = [(int(n), "") for n in args.get("lines") or []]
                wanted += [
                    (int(b["line"]), str(b.get("condition") or "")[:300])
                    for b in args.get("breakpoints") or []
                    if isinstance(b, dict) and "line" in b
                ]
                set_ = await run.set_breakpoints(str(path), wanted)
                if not set_:
                    return f"No breakpoints in {path.name} now."
                return "\n".join(
                    f"{path.name}:{b.line}"
                    + (f" if {b.condition}" if b.condition else "")
                    + (
                        ""
                        if b.verified is not False
                        else f" (not set: {b.message or 'no code there'})"
                    )
                    for b in set_
                )

            return await guarded(work)

        def mover(action: str):
            async def run_it(args):
                async def work():
                    run = desk.run_of(task.id)
                    desk.agent_may_move(run)
                    return code_dap.report_text(await run.resume(action, wait=wait_of(args)), root)

                return await guarded(work)

            return run_it

        debug_continue = tool(
            "debug_continue",
            "Let the program run on to the next breakpoint (or its end), and say where it stopped.",
            {"type": "object", "properties": {"wait": WAIT_SCHEMA}},
        )(mover("continue"))

        step_kinds = {"over": "next", "into": "stepIn", "out": "stepOut"}

        @tool(
            "debug_step",
            "One step from where it's stopped: over (the next line), into (the call on this "
            "line) or out (back to the caller). Says where it is then.",
            {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["over", "into", "out"]},
                    "wait": WAIT_SCHEMA,
                },
            },
        )
        async def debug_step(args):
            return await mover(step_kinds.get(str(args.get("kind") or "over"), "next"))(args)

        @tool(
            "debug_pause",
            "Pause the running program where it is, and say where.",
            {"type": "object", "properties": {}},
        )
        async def debug_pause(_args):
            async def work():
                run = desk.run_of(task.id)
                desk.agent_may_move(run)
                return code_dap.report_text(await run.pause(), root)

            return await guarded(work)

        @tool(
            "debug_wait",
            "Wait for the running program to stop at a breakpoint or end, and say where it is.",
            {"type": "object", "properties": {"seconds": WAIT_SCHEMA}},
        )
        async def debug_wait(args):
            async def work():
                run = desk.run_of(task.id)
                seconds = wait_of({"wait": args.get("seconds")})
                return code_dap.report_text(await run.wait(seconds), root)

            return await guarded(work)

        @tool(
            "debug_status",
            "This session's debug run: running, stopped (where, with the stack and locals) or "
            "ended (how, with the last output); who has it (you, or the user in the Debug pane).",
            {"type": "object", "properties": {}},
        )
        async def debug_status(_args):
            async def work():
                run = desk.run_of(task.id)
                head = f"{run.adapter.name}: {run.target} ({run.request_kind}). "
                head += (
                    "The user has it in the Debug pane."
                    if run.control == "user"
                    else "You have it."
                )
                report = (
                    await run.where()
                    if run.state in ("stopped", "ended")
                    else {"state": run.state, "note": ""}
                )
                return head + "\n" + code_dap.report_text(report, root)

            return await guarded(work)

        @tool(
            "debug_stack",
            "The stopped program's stack, innermost frame first (each frame's id is for "
            "debug_variables and debug_evaluate).",
            {"type": "object", "properties": {"thread_id": {"type": "integer"}}},
        )
        async def debug_stack(args):
            async def work():
                run = desk.run_of(task.id)
                frames = await run.stack(args.get("thread_id"))
                return (
                    "\n".join(f"#{f['id']} {f['name']} at {f['file']}:{f['line']}" for f in frames)
                    or "No frames."
                )

            return await guarded(work)

        @tool(
            "debug_variables",
            "Variables where it's stopped: a frame's scopes and their variables (frame_id from "
            "debug_stack; the top frame by default), or the children of one variable (ref, as "
            "shown in [ref N]).",
            {
                "type": "object",
                "properties": {"frame_id": {"type": "integer"}, "ref": {"type": "integer"}},
            },
        )
        async def debug_variables(args):
            async def work():
                run = desk.run_of(task.id)
                if args.get("ref"):
                    rows = await run.variables(int(args["ref"]))
                    return "\n".join(_var_line(v) for v in rows) or "Nothing in it."
                frame = args.get("frame_id")
                if frame is None:
                    frames = await run.stack()
                    if not frames:
                        return "No frames."
                    frame = frames[0]["id"]
                lines = []
                for scope in await run.scopes_of(int(frame)):
                    lines.append(
                        f"{scope['name']}:"
                        + (
                            f" [ref {scope['ref']}] (large: open it with ref)"
                            if scope["expensive"]
                            else ""
                        )
                    )
                    if not scope["expensive"]:
                        lines += [f"  {_var_line(v)}" for v in await run.variables(scope["ref"])]
                return "\n".join(lines) or "No variables."

            return await guarded(work)

        @tool(
            "debug_evaluate",
            "Evaluate an expression in the stopped program (the top frame, or frame_id). It "
            "runs in the program: an expression that calls code can change its state.",
            {
                "type": "object",
                "properties": {"expression": {"type": "string"}, "frame_id": {"type": "integer"}},
                "required": ["expression"],
            },
        )
        async def debug_evaluate(args):
            async def work():
                run = desk.run_of(task.id)
                desk.agent_may_move(run)
                found = await run.evaluate(
                    str(args.get("expression") or "")[:4000], args.get("frame_id")
                )
                return (
                    found["result"]
                    + (f"  ({found['type']})" if found["type"] else "")
                    + (f"  [ref {found['ref']}]" if found["ref"] else "")
                )

            return await guarded(work)

        @tool(
            "debug_stop",
            "End this session's debug run (a launched program ends with it; an attached one is left running).",
            {"type": "object", "properties": {}},
        )
        async def debug_stop(_args):
            async def work():
                run = desk.run_of(task.id)
                desk.agent_may_move(run)
                await run.stop(why="Stopped by Eden Code.")
                return "Stopped."

            return await guarded(work)

        return [
            debug_adapters, debug_launch, debug_attach, debug_breakpoints, debug_continue,
            debug_step, debug_pause, debug_wait, debug_status, debug_stack, debug_variables,
            debug_evaluate, debug_stop,
        ]  # fmt: skip

    def extend(self, task: Any, options: Any) -> None:
        """TaskManager.session_extras: the debugger's tools for this session."""
        if not self.on() or getattr(task, "kind", "code") != "code":
            return
        if str(getattr(task, "model_ref", "") or "").startswith("acp:"):
            return  # (an ACP agent gets no in-process servers)
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        options.mcp_servers = {
            **base,
            SERVER: create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools(task)),
        }
        options.allowed_tools = [*options.allowed_tools, *TOOLS]

    # ── the window ──

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        from .code_workspace import session_of

        task = session_of(self.hub, msg)
        if task is None:
            self.hub.emit("dbg_state", id=msg.get("id"), on=self.on(), run=None, adapters=[])
            return
        env = self.env_for(task)
        adapters = await asyncio.to_thread(self.adapters, Path(task.cwd), env)
        run = self.runs.get(task.id)
        self.hub.emit(
            "dbg_state",
            id=task.id,
            on=self.on(),
            run=run.snapshot() if run else None,
            adapters=[a.public() for a in adapters],
        )

    async def cmd_do(self, msg: dict[str, Any]) -> None:
        from .code_workspace import session_of

        task = session_of(self.hub, msg)
        task_id = msg.get("id")
        action = str(msg.get("action") or "")
        try:
            if task is None:
                raise DapError("Open a session to debug in.")
            await self._do(task, action, msg)
        except DapError as exc:
            self.hub.emit("dbg_error", id=task_id, action=action, error=str(exc))
        except Exception as exc:
            log.exception("debugger: the pane's %s failed", action)
            self.hub.emit(
                "dbg_error", id=task_id, action=action, error=f"The debugger failed: {exc}"
            )

    async def _do(self, task: Any, action: str, msg: dict[str, Any]) -> None:
        if action == "launch":
            args = {
                "language": msg.get("language"),
                "program": msg.get("program"),
                "module": msg.get("module"),
                "args": shlex.split(str(msg.get("args") or "")),
                "stop_on_entry": bool(msg.get("stop_on_entry")),
                "breakpoints": msg.get("breakpoints") or [],
            }
            await self.launch_for(task, args, "user")
            return
        run = self.run_of(task.id)
        if action in ("continue", "next", "stepIn", "stepOut", "pause"):
            run.control = "user"  # (the owner's hand on it: theirs till they hand it back)
            if action == "pause":
                await run.pause()
            else:
                await run.resume(action)
        elif action == "take":
            run.control = "user"
        elif action == "release":
            run.control = "agent"
        elif action == "stop":
            await run.stop(why="Stopped from the Debug pane.")
        elif action == "frame":
            scopes = await run.scopes_of(int(msg.get("frame")))
            for scope in scopes:
                scope["variables"] = [] if scope["expensive"] else await run.variables(scope["ref"])
            run.scopes = scopes
        elif action == "expand":
            ref = int(msg.get("ref"))
            self.hub.emit("dbg_vars", id=task.id, ref=ref, variables=await run.variables(ref))
            return
        elif action == "evaluate":
            expression = str(msg.get("expression") or "")[:4000]
            try:
                found = await run.evaluate(expression, msg.get("frame"))
                self.hub.emit(
                    "dbg_eval",
                    id=task.id,
                    expression=expression,
                    result=found["result"],
                    type=found["type"],
                )
            except DapError as exc:
                self.hub.emit("dbg_eval", id=task.id, expression=expression, error=str(exc))
            return
        elif action == "breakpoint":
            path = self.file_in(Path(task.cwd), str(msg.get("file") or ""))
            line = int(msg.get("line"))
            have = [
                (b.line, b.condition) for b in run.breakpoints.get(str(path), []) if b.line != line
            ]
            if msg.get("on", True):
                have.append((line, str(msg.get("condition") or "")[:300]))
            await run.set_breakpoints(str(path), sorted(have))
        else:
            raise DapError(f"Unknown debugger action: {action}")
        self._changed(task.id)

    # ── ending ──

    def tasks_changed(self, _event: dict[str, Any]) -> None:
        """A session gone or stopped takes its run with it."""
        for task_id, run in list(self.runs.items()):
            task = self.task(task_id)
            if task is None or getattr(task, "status", "") in ("stopped", "failed"):
                self.runs.pop(task_id, None)
                if run.state != "ended" or run.proc is not None:
                    self.hub._spawn(run.stop(why="Its session ended."))

    def quit(self) -> None:
        for run in self.runs.values():
            run.kill_now()


def _var_line(v: dict[str, Any]) -> str:
    return (
        f"{v['name']} = {v['value']}"
        + (f"  ({v['type']})" if v.get("type") else "")
        + (f"  [ref {v['ref']}]" if v.get("ref") else "")
    )


def install(hub: Any) -> None:
    from .. import tasks as tasks_mod

    desk = DebugDesk(hub)
    hub.code_debugger = desk  # (for the tests)
    hub.tasks.session_extras.append(desk.extend)
    hub.add_event_sink(("tasks",), desk.tasks_changed)
    hub.add_quit_hook(desk.quit)
    hub.register_command("dbg_state", desk.cmd_state, slow=True)
    hub.register_command("dbg_do", desk.cmd_do, slow=True)
    tasks_mod.FEATURE_TOOLS[f"mcp__{SERVER}__debug_launch"] = (
        "start a program under the debugger",
        _launch_detail,
    )
    tasks_mod.FEATURE_TOOLS[f"mcp__{SERVER}__debug_attach"] = (
        "attach the debugger to a process",
        _attach_detail,
    )
    tasks_mod.FEATURE_TOOLS[f"mcp__{SERVER}__debug_evaluate"] = (
        "evaluate an expression in the debugged program",
        _evaluate_detail,
    )
