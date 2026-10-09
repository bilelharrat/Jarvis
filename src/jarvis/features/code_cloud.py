"""Eden Code in the cloud: sessions that keep working while the Mac sleeps, is shut or is
off. Built on the hand-offs (features/code_handoff.py): the owner's cloud machine is one of
the Machines there (an SSH host; Settings' default alias "jarvis-cloud", a small Google Cloud
server with git, tmux and the Claude Code CLI signed in to the owner's own Claude account).

- Start in the cloud: the composer's "Cloud" switch (task_new {cloud: true}) starts the
  session in an isolated copy here and hands it straight off with its first message as the
  instructions; the owner asked for it, so the hand-off card doesn't ask again (unless the
  secret scan finds something).
- I'm heading out: "/away", the code_cloud_away command or by voice ("I'm heading out",
  "move my sessions to the cloud"): one card for every session that's working, then each is
  interrupted between steps if it must be and continues there, told where it was.
- A session that isn't in an isolated copy can't move (the hand-off needs a branch of its
  own): it's named, and stays here.

Window: task_new {cloud: true, ...} (taken here; without cloud the usual), code_cloud_away {},
code_cloud_state {} -> event code_cloud {machine, ready, problem}.
Tools (server jarvis_code_cloud): move_sessions_to_cloud, start_session_in_cloud.

Cost policy: no model is called here. Runs on the cloud machine use that machine's Claude
sign-in (the owner's own account), billed there and outside JARVIS's limits, as any
hand-off; the server itself is billed by Google to the owner's project.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

SERVER = "jarvis_code_cloud"
PREF_MACHINE = "code_cloud_machine"
DEFAULT_MACHINE = "jarvis-cloud"
COPY_WAIT = 90.0  # seconds for a new session's isolated copy to be made
IDLE_WAIT = 30.0  # seconds for an interrupted session to stop between steps
ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

register_feature_pref(PREF_MACHINE, DEFAULT_MACHINE, lambda v: v if ALIAS.match(str(v)) else None)

PROMPT = (
    "\n- Eden Code in the cloud: the owner has a cloud machine where Eden Code sessions "
    "keep working while the Mac is asleep or shut. When they say they're heading out, "
    "closing the laptop, or want sessions to keep going without the Mac, call "
    "move_sessions_to_cloud (one card asks). To start new work there, start_session_in_cloud."
)
RESUME_NOTE = (
    "This session was just moved to another machine so it can keep working while the owner's "
    "Mac sleeps; it was interrupted to move. Carry on with the task where you left off."
)


class Cloud:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._moving = False

    # ── the machine ──

    def desk(self) -> Any:
        return getattr(self.hub, "code_handoff", None)

    def alias(self) -> str:
        """The cloud machine: the one Settings names, else the only one added ("" none)."""
        desk = self.desk()
        if desk is None:
            return ""
        desk.load()
        wanted = str(self.hub.prefs.feature(PREF_MACHINE) or DEFAULT_MACHINE)
        if desk.machine(wanted) is not None:
            return wanted
        return desk.machines[0].alias if len(desk.machines) == 1 else ""

    def state(self, _msg: dict[str, Any] | None = None) -> None:
        desk, alias = self.desk(), self.alias()
        machine = desk.machine(alias) if desk is not None and alias else None
        self.hub.emit(
            "code_cloud",
            machine=alias,
            ready=bool(machine is not None and machine.ok),
            problem=(machine.problem if machine is not None else "")
            or ("" if alias else "No cloud machine added in Eden Code settings › Machines."),
        )

    def tr(self, text: str) -> str:
        desk = self.desk()
        return desk.tr(text) if desk is not None else text

    # ── starting in the cloud ──

    async def task_new(self, msg: dict[str, Any]) -> Any:
        """The composer's new session with Cloud on; anything else is left to the hub."""
        if not msg.get("cloud") or msg.get("session_id"):
            return False
        prompt = str(msg.get("prompt") or "").strip()
        if not prompt:
            return False  # nothing to do there yet: an ordinary session
        alias = self.alias()
        if not alias:
            self.hub.emit(
                "error",
                text=self.tr("Add a cloud machine in Eden Code settings › Machines first."),
            )
            return None
        tm = self.hub.tasks
        known = set(tm.tasks)
        here = {k: v for k, v in msg.items() if k != "cloud"}
        here.update(prompt="", isolated=True, title=str(msg.get("title") or prompt[:80]))
        await self.hub._handle(here)  # the hub's own new session (this handler passes it on)
        fresh = [tm.tasks[i] for i in set(tm.tasks) - known]
        if not fresh:
            return None
        self.hub._spawn(self.to_cloud(fresh[0], alias, prompt))
        return None

    async def to_cloud(self, task: Any, alias: str, prompt: str) -> str:
        """A new session, once its isolated copy is made, carried on there from the start."""
        tm = self.hub.tasks
        task.last_action = self.tr(f"Starting on {alias}…")
        tm._changed()
        waited = 0.0
        while not (task.workspace or {}).get("slug") and waited < COPY_WAIT:
            await asyncio.sleep(0.5)
            waited += 0.5
        if not (task.workspace or {}).get("slug"):
            tm._log(task, "system", self.tr("Couldn't make an isolated copy, so it runs here."))
            tm.send(task.id, prompt)
            return "It runs here: no isolated copy."
        said = await self.desk().hand_off(task, alias, prompt, preapproved=True)
        if not said.startswith("Handed off"):
            tm._log(task, "system", self.tr(said))
        return said

    # ── I'm heading out ──

    def working(self) -> list[Any]:
        desk = self.desk()
        out = []
        for task in self.hub.tasks.tasks.values():
            if task.kind != "code" or not task.busy:
                continue
            rec = desk.of_task(task) if desk is not None else None
            if rec is not None and rec.live:
                continue  # already on a machine
            out.append(task)
        return out

    async def away(self, by_voice: bool = False) -> str:
        """Every working session moved to the cloud machine, after one card."""
        alias = self.alias()
        if not alias:
            return "Add a cloud machine in Eden Code settings › Machines first."
        if self._moving:
            return "Already moving them."
        working = self.working()
        if not working:
            return "No Eden Code session is working right now, so there's nothing to move."
        movable = [t for t in working if (t.workspace or {}).get("slug")]
        stuck = [t for t in working if t not in movable]
        if not movable:
            return (
                "None of the working sessions is in an isolated copy, so they can't move: start "
                "sessions with Isolated copy (or Cloud) on to be able to."
            )
        lines = [f"• {t.title or t.prompt[:60] or f'Session {t.id}'}" for t in movable]
        if stuck:
            lines.append("")
            lines.append(
                "Staying here (not in an isolated copy): "
                + ", ".join(t.title or f"session {t.id}" for t in stuck)
            )
        lines += [
            "",
            "Each is paused between steps, its work committed and sent there, and it carries "
            "on where it was. Runs there use that machine's Claude sign-in.",
        ]
        question = self.tr(
            f"Move {len(movable)} working session{'s' if len(movable) != 1 else ''} to {alias}?"
        )
        if by_voice:
            self.hub._say(question)
        choice = await self.hub.request_approval(
            question,
            self.tr("\n".join(lines)),
            [("go", self.tr(f"Move to {alias}")), ("deny", self.tr("Not now"))],
            context={"tool": "code_cloud"},
        )
        if choice != "go":
            return "Left them here."
        self._moving = True
        try:
            results = await asyncio.gather(*(self._move(t, alias) for t in movable))
        finally:
            self._moving = False
        moved = sum(1 for r in results if r.startswith("Handed off"))
        said = (
            f"Moved {moved} of {len(movable)} to {alias}: they keep working while the Mac sleeps."
        )
        problems = [r for r in results if not r.startswith("Handed off")]
        if problems:
            said += " Not moved: " + " ".join(dict.fromkeys(problems))
        return said

    async def _move(self, task: Any, alias: str) -> str:
        tm = self.hub.tasks
        doing = task.last_action or ""
        if task.busy:
            await tm.interrupt(task.id)
            waited = 0.0
            while task.busy and waited < IDLE_WAIT:
                await asyncio.sleep(0.5)
                waited += 0.5
            if task.busy:
                return f"{task.title or f'Session {task.id}'} didn't pause in time."
        note = RESUME_NOTE + (f" It was last: {doing}." if doing else "")
        return await self.desk().hand_off(task, alias, note, preapproved=True)

    async def cmd_away(self, _msg: dict[str, Any]) -> None:
        said = await self.away()
        self.hub.emit("toast", title=self.tr("Eden Code"), text=self.tr(said))

    # ── by voice ──

    def build_server(self) -> Any:
        cloud = self

        def text(said: str) -> dict[str, Any]:
            return {"content": [{"type": "text", "text": cloud.tr(said)}]}

        @tool(
            "move_sessions_to_cloud",
            "Move every Eden Code session that's working to the owner's cloud machine so it "
            'keeps going while the Mac sleeps or is shut ("I\'m heading out", "I\'m closing '
            'the laptop", "keep them going without the Mac"). One card asks first.',
            {"type": "object", "properties": {}},
        )
        async def move_sessions_to_cloud(_args):
            return text(await cloud.away(by_voice=True))

        @tool(
            "start_session_in_cloud",
            "Start a new Eden Code session on the owner's cloud machine, where it keeps "
            "working while the Mac is asleep. prompt: what to do. project: the project's folder "
            "or name (default: the latest session's).",
            {
                "type": "object",
                "properties": {"prompt": {"type": "string"}, "project": {"type": "string"}},
                "required": ["prompt"],
            },
        )
        async def start_session_in_cloud(args):
            prompt = str(args.get("prompt") or "").strip()[:8000]
            project = str(args.get("project") or "").strip()
            if not project:
                code = [t for t in cloud.hub.tasks.tasks.values() if t.kind == "code"]
                project = str(max(code, key=lambda t: t.id).cwd) if code else ""
            if not prompt or not project:
                return text("Say what to do, and in which project.")
            if not cloud.alias():
                return text("Add a cloud machine in Eden Code settings › Machines first.")
            await cloud.task_new(
                {"type": "task_new", "cloud": True, "prompt": prompt, "directory": project}
            )
            return text(f"Started on {cloud.alias()}: it carries on there while the Mac sleeps.")

        return create_sdk_mcp_server(SERVER, tools=[move_sessions_to_cloud, start_session_in_cloud])


def install(hub: Any) -> None:
    cloud = Cloud(hub)
    hub.code_cloud = cloud
    hub.register_command("task_new", cloud.task_new)
    hub.register_command("code_cloud_away", cloud.cmd_away, slow=True)
    hub.register_command("code_cloud_state", cloud.state)
    hub.register_server(
        SERVER,
        cloud.build_server,
        prompt=PROMPT,
        labels={
            "move_sessions_to_cloud": "Moved sessions to the cloud",
            "start_session_in_cloud": "Started a session in the cloud",
        },
    )
