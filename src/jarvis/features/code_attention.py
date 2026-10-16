"""Eden Code's "Needs attention" inbox: everything waiting on the owner, across every
session, in one list.

Nothing new is tracked for it: each item is read from what the other features already keep,
each time the list is made (collect), so it can never say something is waiting that its own
feature has let go of:

- approval: a card up on the hub (hub.approvals: a step to allow, a question, a landing, a
  run to start), answered from the inbox with the window's own answerApproval, so its checks
  (Touch ID, the settle time) still apply;
- reply: a session whose turn ended (status "waiting") that the owner hasn't looked at since
  (the sessions a task_finished came for, until a window says it has been seen: the
  window's code_attention_seen, sent as the sidebar's "unread" dot goes, web/features/
  code-sessions.js);
- failed: a session that stopped with an error;
- exterminator: an Exterminator Mode run that stopped (not by the owner) or finished and
  waits to be landed (features/code_bugfix.py);
- run: a run without the owner (features/code_unattended.py: the owner's, a routine's, an
  issue's, Linear's, Slack's, a watch's or a webhook's) stopped by its caps, its copy or a
  failure;
- queue: a to-do card the routing queue failed (features/code_todo.py, code_queue.py);
- pr: a pull request whose checks still fail after its automatic fixes (or with autofix
  off), or whose work waits to be pushed (features/code_pr.py);
- handoff: a session handed off to another machine that finished its turn there or failed
  (features/code_handoff.py);
- conflict: a pairing folder with files both sides changed (features/code_pairing.py).

Each item says what it is, what it's about, and how to get to it (the session, and the pane
that has its buttons). The count is on the sidebar's inbox button and in the Dock's badge
(app/features/code-sessions.js keeps each feature's count apart and shows their sum); ⌘⇧A
opens the inbox; a screen reader hears the count each time it changes (a polite live
region), and "what's waiting?" (said or typed to Eden, or said while voice coding) is
answered with a spoken summary: "3 things are waiting for you: …".

Window commands: code_attention {} (the list now), code_attention_seen {ids: [task id…]}
(those sessions' replies have been seen).
Events: code_attention {items, count, summary}.
Also: hub.code_attention (Attention: collect(), summary()), for the local API
(features/code_api.py: GET /v1/attention).

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from .. import lang

log = logging.getLogger("jarvis")

PUBLISH_DELAY = 0.25  # seconds: a burst of events makes one list, not one each
NAMED = 3  # items named in the spoken summary; the rest are counted
TEXT_MAX = 200
SEEN_KEPT = 500  # sessions remembered as unseen, at most

# The order the inbox lists them in: what blocks a session first.
ORDER = ("approval", "conflict", "failed", "exterminator", "run", "queue", "pr", "handoff", "reply")

# A run without the owner that ended on its own: these ways of ending want a look.
RUN_TROUBLE = {"spend", "time", "copy", "failed"}

ZH = {
    "Nothing is waiting for you.": "没有在等你的事。",
    "One thing is waiting for you: {items}.": "有一件事在等你：{items}。",
    "{n} things are waiting for you: {items}.": "有 {n} 件事在等你：{items}。",
    "{items}, and {n} more": "{items}，还有 {n} 件",
    "{title} asks: {question}": "{title} 在问：{question}",
    "{title} finished and waits for your reply": "{title} 完成了，在等你回复",
    "{title} stopped with an error": "{title} 出错停下了",
    "Exterminator Mode in {project} stopped: {why}": "{project} 的灭虫模式停下了：{why}",
    "Exterminator Mode in {project} finished; land it when you're ready": "{project} 的灭虫模式完成了；准备好就合并",
    "The run without you in {project} stopped: {why}": "{project} 里无人值守的运行停下了：{why}",
    "The queue's card {title} failed": "队列里的卡片 {title} 失败了",
    "Pull request #{n} still fails its checks": "拉取请求 #{n} 的检查还是失败",
    "Pull request #{n} is ready to push": "拉取请求 #{n} 可以推送了",
    "{title} on {alias} waits for you": "{title} 在 {alias} 上等你",
    "{title} on {alias} failed": "{title} 在 {alias} 上失败了",
    "{n} files changed on both sides in {title}'s pairing folder": "{title} 的配对文件夹里有 {n} 个文件两边都改了",
    "it reached its spending cap": "达到了花费上限",
    "it ran out of time": "超时了",
    "its isolated copy couldn't be made": "没能建立它的独立副本",
    "it failed": "它失败了",
    "the app quit": "应用退出了",
}
lang.add_texts(ZH)

WHY = {
    "spend": "it reached its spending cap",
    "time": "it ran out of time",
    "copy": "its isolated copy couldn't be made",
    "failed": "it failed",
    "restart": "the app quit",
}

# "what's waiting", "what needs me", "anything waiting for me?", "what needs my attention",
# "open my inbox", 有什么在等我
ASKED = re.compile(
    r"^(?:hey\s+)?(?:eden[,!.]?\s+)?(?:what(?:'s|\s+is)\s+waiting(?:\s+(?:for|on)\s+me)?"
    r"|what\s+needs\s+(?:me|my\s+attention|attention)|(?:is\s+)?anything\s+waiting(?:\s+(?:for|on)\s+me)?"
    r"|what\s+(?:do\s+the\s+)?agents\s+need|(?:read|check|open)\s+(?:my\s+)?(?:inbox|attention\s+list))"
    r"[\s?.!]*$",
    re.I,
)
ASKED_ZH = re.compile(r"(有什么|哪些事|什么事)(在)?等(着)?我|需要我处理")


def asked(text: str) -> bool:
    words = " ".join(str(text or "").split())
    return bool(ASKED.match(words) or ASKED_ZH.search(words))


def _line(text: Any) -> str:
    """One line of someone's words, short enough for a list and a sentence."""
    first = next((x.strip() for x in str(text or "").splitlines() if x.strip()), "")
    return first if len(first) <= TEXT_MAX else first[: TEXT_MAX - 1] + "…"


def _title(task: Any) -> str:
    named = _line(getattr(task, "title", "") or getattr(task, "prompt", ""))[:80]
    return f"Session {task.id}" + (f" ({named})" if named else "")


class Attention:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.unseen: dict[int, float] = {}  # session -> when its turn ended, not seen yet
        self._published = ""
        self._timer: asyncio.TimerHandle | None = None

    def tr(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.hub.language, **values)

    # ── what's waiting ──

    def collect(self) -> list[dict[str, Any]]:
        """Every item waiting on the owner, in ORDER, newest first within a kind. A source
        that fails is left out (logged), never the whole list."""
        items: list[dict[str, Any]] = []
        for source in (self._approvals, self._sessions, self._bugfix, self._runs, self._queue,
                       self._prs, self._handoffs, self._pairs):  # fmt: skip
            try:
                items.extend(source())
            except Exception:
                log.exception("attention: %s failed", source.__name__)
        rank = {kind: n for n, kind in enumerate(ORDER)}
        # (the newest first within a kind; the higher session number first when they tie)
        items.sort(key=lambda i: (rank.get(i["kind"], len(ORDER)), -float(i.get("at") or 0), -i["task"]))
        return items

    def _code_task(self, task_id: Any) -> Any:
        task = self.hub.tasks.tasks.get(task_id) if isinstance(task_id, int) else None
        return task if task is not None and task.kind == "code" else None

    def _approvals(self) -> list[dict[str, Any]]:
        out = []
        for a in list(self.hub.approvals.values()):
            task = self._code_task(a.get("task_id"))
            title = _title(task) if task is not None else "Eden Code"
            question = _line(a.get("question")) or "Waiting for your answer"
            out.append({
                "key": f"approval:{a['id']}",
                "kind": "approval",
                "task": task.id if task is not None else 0,
                "approval": a["id"],
                "title": title,
                "project": task.cwd.name if task is not None else "",
                "text": question,
                "said": self.tr("{title} asks: {question}", title=title, question=question),
                "choices": [c for c in a.get("choices") or [] if isinstance(c, dict)][:6],
                "at": float(a.get("at") or 0) or time.time(),
            })  # fmt: skip
        return out

    def _sessions(self) -> list[dict[str, Any]]:
        out = []
        asking = {a.get("task_id") for a in self.hub.approvals.values()}
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind != "code" or task.id in asking:
                continue
            title = _title(task)
            if task.status == "failed":
                out.append(self._item(f"failed:{task.id}", "failed", task, title,
                                      _line(task.result) or "Stopped with an error.",
                                      self.tr("{title} stopped with an error", title=title),
                                      at=task.started.timestamp()))  # fmt: skip
            elif task.status == "waiting" and not task.busy and task.id in self.unseen:
                out.append(self._item(f"reply:{task.id}", "reply", task, title,
                                      _line(task.result) or "Finished its turn.",
                                      self.tr("{title} finished and waits for your reply", title=title),
                                      at=self.unseen[task.id]))  # fmt: skip
        return out

    def _item(self, key: str, kind: str, task: Any, title: str, text: str, said: str,
              *, pane: str = "", at: float = 0.0, **extra: Any) -> dict[str, Any]:  # fmt: skip
        return {
            "key": key,
            "kind": kind,
            "task": task.id if task is not None else 0,
            "title": title,
            "project": task.cwd.name if task is not None else "",
            "text": text,
            "said": said,
            "pane": pane,
            "at": at or time.time(),
            **extra,
        }

    def _bugfix(self) -> list[dict[str, Any]]:
        desk = getattr(self.hub, "code_bugfix", None)
        if desk is None:
            return []
        desk.load()
        out = []
        for run in desk.runs:
            if run.landed or run.state == "running":
                continue
            task = self._code_task(run.task_id)
            if run.state == "done":
                said = self.tr("Exterminator Mode in {project} finished; land it when you're ready",
                               project=run.project)  # fmt: skip
            elif run.why in ("owner",) or run.state not in ("stopped", "paused"):
                continue
            else:
                why = self.tr(WHY.get(run.why, "it failed"))
                said = self.tr("Exterminator Mode in {project} stopped: {why}",
                               project=run.project, why=why)  # fmt: skip
            out.append(self._item(f"exterminator:{run.id}", "exterminator", task, "Exterminator Mode",
                                  said, said, pane="bugfix", at=run.ended or run.started,
                                  run=run.id, project_name=run.project))  # fmt: skip
            out[-1]["project"] = run.project
        return out

    def _runs(self) -> list[dict[str, Any]]:
        runs = getattr(self.hub, "code_runs", None)
        if runs is None:
            return []
        runs.load()
        out = []
        for run in runs.runs[-20:]:
            if run.state != "stopped" or run.why not in RUN_TROUBLE:
                continue
            if time.time() - (run.ended or run.started) > 7 * 86400:
                continue  # a week on, it's history (the Without you pane still has it)
            why = self.tr(WHY.get(run.why, "it failed"))
            said = self.tr("The run without you in {project} stopped: {why}", project=run.project, why=why)
            task = self._code_task(run.task_id)
            out.append(self._item(f"run:{run.id}", "run", task, _line(run.title) or "Without you",
                                  said, said, pane="unattended", at=run.ended, run=run.id))  # fmt: skip
            out[-1]["project"] = run.project
        return out

    def _queue(self) -> list[dict[str, Any]]:
        todo = getattr(self.hub, "code_todo", None)
        if todo is None:
            return []
        out = []
        for card in todo.board.cards:
            if card.get("state") != "failed":
                continue
            title = _line(card.get("title") or card.get("prompt"))[:80]
            task = self._code_task(card.get("task"))
            said = self.tr("The queue's card {title} failed", title=title)
            out.append(self._item(f"queue:{card['id']}", "queue", task, title, said, said,
                                  pane="board", card=card["id"]))  # fmt: skip
            out[-1]["project"] = card.get("folder", "")
        return out

    def _prs(self) -> list[dict[str, Any]]:
        desk = getattr(self.hub, "code_pr", None)
        if desk is None:
            return []
        from ..code_prs import FIX_ATTEMPTS

        out = []
        for rec in desk.store().watched():
            stuck = rec.checks == "failed" and (not rec.autofix or rec.fix_attempts >= FIX_ATTEMPTS)
            if not (stuck or rec.awaiting_push):
                continue
            said = (
                self.tr("Pull request #{n} still fails its checks", n=rec.number)
                if stuck
                else self.tr("Pull request #{n} is ready to push", n=rec.number)
            )
            task = next((t for t in self.hub.tasks.tasks.values()
                         if t.kind == "code" and rec.session_id and t.session_id == rec.session_id), None)  # fmt: skip
            out.append(self._item(f"pr:{rec.key}", "pr", task, _line(rec.title), said, said,
                                  pane="pr", at=rec.opened, url=rec.url))  # fmt: skip
            out[-1]["project"] = rec.project
        return out

    def _handoffs(self) -> list[dict[str, Any]]:
        desk = getattr(self.hub, "code_handoff", None)
        if desk is None:
            return []
        out = []
        for rec in list(getattr(desk, "handoffs", [])):
            if rec.state not in ("idle", "failed") or rec.pending:
                continue  # (its permission requests are cards already: approval items)
            title = _line(rec.title) or rec.project
            template = "{title} on {alias} waits for you" if rec.state == "idle" else "{title} on {alias} failed"
            said = self.tr(template, title=title, alias=rec.alias)
            task = self._code_task(rec.task_id)
            out.append(self._item(f"handoff:{rec.id}", "handoff", task, title, said, said,
                                  at=rec.started))  # fmt: skip
            out[-1]["project"] = rec.project
        return out

    def _pairs(self) -> list[dict[str, Any]]:
        pairing = getattr(self.hub, "code_pairing", None)
        desk = getattr(self.hub, "code_desk", None)
        if pairing is None:
            return []
        out = []
        for slug, pair in pairing.pairs().items():
            if not pair.conflicts:
                continue
            task = None
            if desk is not None:
                task = next((self._code_task(tid) for tid, s in desk.bound.items() if s == slug), None)
            title = _title(task) if task is not None else slug
            said = self.tr("{n} files changed on both sides in {title}'s pairing folder",
                           n=len(pair.conflicts), title=title)  # fmt: skip
            out.append(self._item(f"conflict:{slug}", "conflict", task, title, said, said,
                                  pane="pairing", files=sorted(pair.conflicts)[:20]))  # fmt: skip
        return out

    # ── said ──

    def summary(self, items: list[dict[str, Any]] | None = None) -> str:
        """The list in a sentence, for voice and a screen reader."""
        items = self.collect() if items is None else items
        if not items:
            return self.tr("Nothing is waiting for you.")
        named = "; ".join(i["said"] for i in items[:NAMED])
        if len(items) > NAMED:
            named = self.tr("{items}, and {n} more", items=named, n=len(items) - NAMED)
        if len(items) == 1:
            return self.tr("One thing is waiting for you: {items}.", items=named)
        return self.tr("{n} things are waiting for you: {items}.", n=len(items), items=named)

    # ── kept up to date ──

    def publish(self, force: bool = False) -> None:
        items = self.collect()
        payload = {"items": items, "count": len(items), "summary": self.summary(items)}
        shown = json.dumps([[i["key"], i["said"], i.get("choices")] for i in items])
        if shown == self._published and not force:
            return
        self._published = shown
        self.hub.emit("code_attention", **payload)

    def soon(self, *_args: Any) -> None:
        """A source changed: the list again in a moment (one for a burst of events)."""
        if self._timer is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._timer = loop.call_later(PUBLISH_DELAY, self._due)

    def _due(self) -> None:
        self._timer = None
        try:
            self.publish()
        except Exception:
            log.exception("attention: publishing failed")

    def on_task(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "task_finished" and data.get("task_kind") == "code":
            task_id = data.get("id")
            if isinstance(task_id, int):
                self.unseen[task_id] = time.time()
                while len(self.unseen) > SEEN_KEPT:
                    self.unseen.pop(next(iter(self.unseen)))
        if kind in ("task_finished", "tasks"):
            self.soon()

    # ── window commands, and voice ──

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.publish(force=True)

    def cmd_seen(self, msg: dict[str, Any]) -> None:
        ids = msg.get("ids") if isinstance(msg.get("ids"), list) else []
        gone = [i for i in ids[:500] if type(i) is int and i in self.unseen]
        for task_id in gone:
            self.unseen.pop(task_id, None)
        if gone:
            self.publish()

    async def instant(self, text: str) -> str | None:
        """ "What's waiting?" said or typed to Eden: the summary, answered at once."""
        if not asked(text):
            return None
        return self.summary()

    async def voice_hook(self, text: str, _task: Any) -> bool:
        """The same while voice coding."""
        if not asked(text):
            return False
        self.hub.say(self.summary())
        return True


def install(hub: Any) -> None:
    attention = Attention(hub)
    hub.code_attention = attention
    hub.register_command("code_attention", attention.cmd_state)
    hub.register_command("code_attention_seen", attention.cmd_seen)
    hub.register_instant(attention.instant)
    voicecode = getattr(hub, "voicecode", None)
    if voicecode is not None:
        voicecode.hooks.append(attention.voice_hook)
    hub.add_task_sink(attention.on_task)
    hub.add_event_sink(
        ("approval", "approval_resolved", "code_bugfix", "code_runs", "todo_state",
         "code_handoffs", "code_pair", "code_pr", "code_prs"),
        attention.soon,
    )  # fmt: skip
