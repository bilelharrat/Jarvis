"""Jarvis Code's terminals and "!" commands (code_terminals), for the window's Terminal pane
(web/features/code-terminal.js) and composer.

Terminals, several per project, kept running when the pane closes:
- cw_terms {id | directory, ref}: the terminals in that folder -> cw_terms {folder, items,
  ref} (also sent, without a ref, whenever that folder's terminals change).
- cw_term_new {id | directory, ref}: a new one -> cw_term_new {ref, ...its info}, cw_terms
  (cw_term_new {ref, error} when it can't start).
- cw_term_attach {term}: what it printed lately, for a window showing it -> cw_term_replay.
- cw_term_input {term, data}, cw_term_resize {term, cols, rows}.
- cw_term_close {term, force}: hang it up -> cw_terms; while something runs in it and not
  force, cw_term_busy {term, what} instead, for the window to ask.
- Output comes as cw_term_data {term, data (base64)}; cw_term_exit {term} when its shell ends.

"!" commands: the composer's task_bash is taken from the core here and runs on a
pseudo-terminal, streaming (cw_bang_start, cw_bang_data), with no time limit;
cw_bang_cancel {ref} stops one. It ends with the core's own task_bash event, so what it
printed goes to Claude with the next message as before.

These run the owner's own shell and commands, typed by them in the window: nothing asks
first, as nothing did for the core's terminal and "!".

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

from .. import lang
from ..code_terminals import BangRun, Shells
from ..hub import _msg_int
from .code_workspace import folder_of

log = logging.getLogger("jarvis")

BASH_OUTPUT = 20_000  # characters of a "!" command's output that go with the next message

ZH = {
    "That's the most terminals at once: close one first.": "终端已经开到上限了：先关掉一个。",
    "The terminal didn't start: {error}": "终端没能启动：{error}",
}
lang.add_texts(ZH)


class Terminals:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.shells = Shells(hub.emit, getattr(hub, "workbench", None))
        self.runs: dict[str, BangRun] = {}

    def caption(self, text: str) -> None:
        self.hub.emit("caption", text=lang.translate(text, self.hub.language))

    # ── terminals ──

    def listing(self, folder: Any, ref: str = "") -> None:
        items = [s.info() for s in self.shells.of(folder)]
        self.hub.emit("cw_terms", folder=str(folder), items=items, **({"ref": ref} if ref else {}))

    def cmd_list(self, msg: dict[str, Any]) -> None:
        try:
            folder = folder_of(self.hub, msg)
        except ValueError:
            return
        self.listing(folder, str(msg.get("ref") or "")[:200])

    def cmd_new(self, msg: dict[str, Any]) -> None:
        try:
            folder = folder_of(self.hub, msg)
        except ValueError:
            return
        ref = str(msg.get("ref") or "")[:200]
        try:
            shell = self.shells.open(folder)
        except ValueError as exc:
            why = str(exc)
        except OSError as exc:  # no pseudo-terminal left, the shell wouldn't start
            why = f"The terminal didn't start: {exc}"
        else:
            self.hub.emit("cw_term_new", ref=ref, **shell.info())
            self.listing(folder)
            return
        why = lang.translate(why, self.hub.language)
        self.hub.emit("cw_term_new", ref=ref, error=why)
        self.hub.emit("caption", text=why)

    def cmd_attach(self, msg: dict[str, Any]) -> None:
        shell = self.shells.get(str(msg.get("term") or ""))
        if shell is not None:
            data = base64.b64encode(bytes(shell.scrollback)).decode()
            self.hub.emit("cw_term_replay", term=shell.id, data=data, alive=not shell.exited)

    def cmd_input(self, msg: dict[str, Any]) -> None:
        shell = self.shells.get(str(msg.get("term") or ""))
        if shell is not None and not shell.exited:
            shell.term.write(str(msg.get("data", ""))[:100_000])

    def cmd_resize(self, msg: dict[str, Any]) -> None:
        shell = self.shells.get(str(msg.get("term") or ""))
        cols, rows = _msg_int(msg, "cols"), _msg_int(msg, "rows")  # (not a number: 0)
        if shell is not None and 0 < cols <= 1000 and 0 < rows <= 1000:
            shell.term.resize(cols, rows)

    async def cmd_close(self, msg: dict[str, Any]) -> None:
        shell = self.shells.get(str(msg.get("term") or ""))
        if shell is None:
            return
        if not shell.exited and msg.get("force") is not True:
            what = await asyncio.to_thread(shell.busy)
            if what:
                self.hub.emit("cw_term_busy", term=shell.id, what=what)
                return
        self.shells.close(shell.id)
        self.listing(shell.cwd)

    # ── "!" commands ──

    def on_bash(self, msg: dict[str, Any]) -> None:
        """The composer's "!command": streamed from a pseudo-terminal, however long it runs."""
        command = str(msg.get("command", "")).strip()[:2000]
        ref = str(msg.get("ref", ""))[:40]
        folder = self.hub._code_folder(msg)
        if not command or folder is None:
            self.hub.emit(
                "task_bash", ref=ref, command=command, output="No project folder.", code=-1
            )
            return
        run = BangRun(ref, command, folder, self.hub.emit)
        try:
            run.start()
        except OSError as exc:  # the folder went away, no pseudo-terminal left
            self.hub.emit("task_bash", ref=ref, command=command, output=str(exc), code=-1)
            return
        self.runs[ref] = run
        self.hub.emit("cw_bang_start", ref=ref)
        self.hub._spawn(self._finish(run))  # (cancelled when the app quits: then it's killed)

    async def _finish(self, run: BangRun) -> None:
        try:
            code = await run.done
        except asyncio.CancelledError:
            run.kill()
            raise
        finally:
            self.runs.pop(run.ref, None)
        output = run.output(BASH_OUTPUT)
        if run.cancelled:
            output = f"{output}\n(cancelled)" if output else "(cancelled)"
        self.hub.emit(
            "task_bash",
            ref=run.ref,
            command=run.command,
            output=output,
            code=code,
            cancelled=run.cancelled,
            seconds=run.seconds,
        )

    async def cmd_bang_cancel(self, msg: dict[str, Any]) -> None:
        run = self.runs.get(str(msg.get("ref") or ""))
        if run is not None:
            await run.cancel()


def install(hub: Any) -> None:
    terms = Terminals(hub)
    hub.code_terminal = terms
    hub.register_command("cw_terms", terms.cmd_list)
    hub.register_command("cw_term_new", terms.cmd_new)
    hub.register_command("cw_term_attach", terms.cmd_attach)
    hub.register_command("cw_term_input", terms.cmd_input)
    hub.register_command("cw_term_resize", terms.cmd_resize)
    hub.register_command("cw_term_close", lambda msg: hub._spawn(terms.cmd_close(msg)))
    hub.register_command("task_bash", terms.on_bash)
    hub.register_command("cw_bang_cancel", lambda msg: hub._spawn(terms.cmd_bang_cancel(msg)))
