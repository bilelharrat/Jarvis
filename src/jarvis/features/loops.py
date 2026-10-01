"""Loop detection (jarvis.loopguard) in JARVIS's own turns and in Jarvis Code sessions.

- JARVIS's turn: each tool call of the conversation's stream (hub.add_message_sink; the
  turn's own calls, not a subagent's) goes to a guard that starts over with every request
  (hub.add_query_hook). When the same call comes three times in a row, or a cycle of two or
  three calls goes round three times, the turn is stopped politely: the reply says what
  happened and offers to try another way (said aloud unless the turn is silent), and Claude
  hears it in a note with the next request, so "yes, try again" gets a different approach.
- A Jarvis Code session: each step of its timeline (hub.add_task_sink: task_log entries of
  role "tool") goes to the session's own guard, which starts over when the owner writes to
  it. A loop puts a notice in the session's timeline (role "loop") with a Stop button: the
  owner decides; the session is never stopped by this.
- Background tasks have the same guard in background.py: one that loops stops and says so
  in its heads-up.

Claude cost policy: no model is called here (a stopped turn spends less, never more).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from claude_agent_sdk import AssistantMessage, ToolUseBlock

from .. import hub as hub_module
from .. import lang, loopguard
from ..loopguard import Loop, LoopGuard

log = logging.getLogger("jarvis")

REPEATED = (
    "I stopped there: I kept repeating the same step ({step}) without getting anywhere. "
    "Shall I try a different way?"
)
CIRCLES = (
    "I stopped there: I was going round in circles ({step}) without getting anywhere. "
    "Shall I try a different way?"
)
REPEATED_PLAIN = (
    "I stopped there: I kept repeating the same step without getting anywhere. "
    "Shall I try a different way?"
)
CIRCLES_PLAIN = (
    "I stopped there: I was going round in circles without getting anywhere. "
    "Shall I try a different way?"
)
CODE_NOTICE = "Jarvis Code seems stuck: {what}. Stop it, or let it carry on."
lang.add_texts(
    {
        REPEATED: "我先停下了：我一直在重复同一步（{step}），却没有进展。要我换个办法再试吗？",
        CIRCLES: "我先停下了：我一直在原地兜圈子（{step}），却没有进展。要我换个办法再试吗？",
        REPEATED_PLAIN: "我先停下了：我一直在重复同一步，却没有进展。要我换个办法再试吗？",
        CIRCLES_PLAIN: "我先停下了：我一直在原地兜圈子，却没有进展。要我换个办法再试吗？",
    }
)
NOTE = (
    "the app stopped your last turn because you {what} without getting anywhere, and told "
    "the user so. If they want you to try again, take a different approach (other tools, "
    "other arguments, or ask them what they want), never the same calls again"
)


def owner_words(loop: Loop, labels: list[str], language: str) -> str:
    """What the owner hears about a loop, in their language: the step's name when it can
    be said in that language, the plain sentence otherwise."""
    said = [lang.translate(label, language) if lang.is_zh(language) else label for label in labels]
    said = list(dict.fromkeys(s for s in said if s))
    step = "、".join(said) if lang.is_zh(language) else ", ".join(said)
    nameable = bool(step) and (not lang.is_zh(language) or all(lang.has_cjk(s) for s in said))
    if loop.kind == "repeat":
        template = REPEATED if nameable else REPEATED_PLAIN
    else:
        template = CIRCLES if nameable else CIRCLES_PLAIN
    return lang.tr(template, language, step=step) if nameable else lang.tr(template, language)


class Loops:
    """The loops feature on one hub (hub.loops)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.turn = LoopGuard()
        self.tripped = False  # this turn was stopped for a loop: the rest of it isn't weighed
        self.code: dict[int, LoopGuard] = {}  # Jarvis Code session id -> its guard

    # ── JARVIS's own turn ──

    def on_query(self, _text: str, _rid: str) -> None:
        self.turn.reset()
        self.tripped = False

    def on_message(self, message: Any) -> None:
        if self.tripped or not isinstance(message, AssistantMessage):
            return
        if getattr(message, "parent_tool_use_id", None):
            return  # a subagent's step: its own business
        seen: set[str] = set()  # the same call made twice at once is one step, not a loop
        for block in message.content:
            if not isinstance(block, ToolUseBlock):
                continue
            fingerprint = loopguard.fingerprint(block.name, block.input)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            loop = self.turn.note(block.name, block.input)
            if loop is not None:
                self.stop_turn(loop)
                return

    def stop_turn(self, loop: Loop) -> None:
        """Stop the turn politely: the words go on the turn's reply now (so they're in its
        history and in what a chat gets back), the turn is interrupted, and they're said."""
        hub = self.hub
        self.tripped = True
        labels = [hub_module.tool_label(name) for name in loop.tools]
        words = owner_words(loop, labels, hub.language)
        log.info("loops: stopped a turn (%s)", loop.describe())
        rid = hub._rid
        if hub.turn.get("rid") == rid and rid:
            hub.turn["reply"] = f"{hub.turn.get('reply', '').strip()} {words}".strip()
            hub.emit("reply", rid=rid, text=hub.turn["reply"])
        hub._add_style_note(NOTE.format(what=loop.describe()))
        hub._spawn(self._stop_then_say(words))

    async def _stop_then_say(self, words: str) -> None:
        hub = self.hub
        await hub.stop()
        hub.say(words)

    # ── Jarvis Code sessions ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "task_finished":
            self.code.pop(int(data.get("id") or 0), None)
            return
        if kind != "task_log":
            return
        entry = data.get("entry")
        task_id = int(data.get("id") or 0)
        if not isinstance(entry, dict) or not task_id:
            return
        role = entry.get("role")
        if role == "user":  # the owner wrote to it: a fresh start
            self.code.pop(task_id, None)
            return
        if role != "tool":
            return
        guard = self.code.setdefault(task_id, LoopGuard())
        loop = guard.note(
            str(entry.get("tool") or ""), [entry.get("text") or "", entry.get("detail") or ""]
        )
        if loop is not None:
            asyncio.get_running_loop().call_soon(self._code_notice, task_id, loop)

    def _code_notice(self, task_id: int, loop: Loop) -> None:
        tasks = getattr(self.hub, "tasks", None)
        task = tasks.tasks.get(task_id) if tasks is not None else None
        if task is None or task.status != "running":
            return
        steps = [
            str(e.get("text") or "")
            for e in task.transcript[-len(loop.tools) * loop.times :]
            if e.get("role") == "tool"
        ][-len(loop.tools) :]
        tasks._log(
            task,
            "loop",
            CODE_NOTICE.format(what=loop.describe()),
            task_id=task_id,
            kind=loop.kind,
            times=loop.times,
            steps=steps,
        )

    def install(self) -> None:
        hub = self.hub
        hub.loops = self
        hub.add_query_hook(self.on_query)
        hub.add_message_sink(self.on_message)
        hub.add_task_sink(self.on_task_event)


def install(hub: Any) -> None:
    Loops(hub).install()
