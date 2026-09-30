"""What JARVIS did (the actions feature): a lasting, searchable log of every tool call of its
own conversation (action_log.py), for the owner and for JARVIS itself; and undoing what it
did lately (undo.py).

- Recorded from the conversation's stream (hub.add_message_sink): when each call started,
  its label as the Activity drawer says it, a few words that say nothing private
  (action_log.summary: an app's or a site's name, never a message, an email, a search or a
  person) and how it ended: done, failed, or stopped (the turn ended before its result).
  Nothing at all while the conversation is incognito.
- Kept per day on this Mac (action_log/ beside prefs.json, the owner's alone) for LOG_DAYS
  days, at most DAY_MAX calls a day; the days past that are deleted as each new day's first
  calls are written. The writes are appends, in a thread, one at a time.
- JARVIS can look back: what_did_you_do ("what did you do yesterday?", "did you open
  Safari?"). Its answers are read from the log.
- The owner can too: the Activity drawer's History tab, searched and paged (window command
  action_log {q, before, seq} -> action_log {q, before, seq, items, more}).
- Undo, for 30 minutes after each action (undo.py weighs every call: PreToolUse and
  PostToolUse hooks added at each connect, and the stream's results): "undo that" (撤销) at
  once, without Claude; undo_action for Claude ("undo the calendar change", asked first
  unless the owner's own words asked for it); and an Undo button under the reply after a
  turn that did something undoable (window command undo_action {id}, event undo_offer).
  Sent messages, emails and calls are said plainly to be past undoing.

Claude cost policy: no model is called here. what_did_you_do and undo_action are tools of
the conversation itself; "undo that" is answered without Claude.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    HookMatcher,
    ResultMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

from .. import action_log, lang
from ..action_log import ActionLog, short_name, summary
from ..hub import FEATURE_ASKED, _asks, tool_label
from ..undo import Undo

log = logging.getLogger("jarvis")

SERVER = "actions"
LOG_FOLDER = "action_log"
PAGE = 60  # entries the History tab gets at a time
TOLD = 120  # entries what_did_you_do reads back at most

PROMPT = (
    "\n- Your own actions: what_did_you_do reads your action log, every tool call you made "
    f"in the last {action_log.LOG_DAYS} days with when, what and how it went, for a day "
    "('today', 'yesterday', a weekday or YYYY-MM-DD) or matching words: use it for 'what "
    "did you do yesterday?' or 'did you open that page?'. It names apps and sites, never "
    "what a message or search said."
    "\n- Undo: undo_action undoes something you did in the last half hour (an event added, "
    "changed or removed; something remembered or forgotten; a routine made, paused or "
    "deleted; a document saved, moved to the Trash; a shortcut made instant). Give which "
    "(words from what it was) or leave it empty for the last thing. Sent messages, emails "
    "and calls can't be undone: say so plainly."
)
LABELS = {
    "what_did_you_do": "Looked back at what I did",
    "undo_action": "Undid something I did",
}

# The owner asking to undo, for undo_action's gate: "undo that", "take it back", 撤销.
FEATURE_ASKED["undo"] = _asks(
    r"undo\b|take\s+(?:that|it|this)\s+back\b|reverse\s+(?:that|it|this|what\s+you)\b"
    r"|put\s+(?:it|that|things)\s+back\b"
)
lang.FEATURE_ASKED_ZH["undo"] = lang._asks_zh(r"(?:撤销|撤消|撤回|还原|恢复原样|改回去)")

# "Undo that", "undo the last thing you did", "take that back": answered at once.
UNDO_THAT = re.compile(
    r"^(?:(?:ok(?:ay)?|jarvis|please|actually|no|wait|oops|hmm|sorry)\b[\s,]*)*"
    r"(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?"
    r"(?:undo(?:\s+(?:that|this|it|the\s+last\s+(?:thing|change|one|action)"
    r"(?:\s+you\s+(?:just\s+)?(?:did|made))?|what\s+you\s+(?:just\s+)?did))?"
    r"|take\s+(?:that|it)\s+back)"
    r"(?:[\s,]+(?:please|jarvis))*[\s.!?]*$",
    re.IGNORECASE,
)
# 撤销, 撤销刚才的操作, 把刚才那步撤销了.
UNDO_THAT_ZH = re.compile(
    r"^(?:(?:好的|好|请|麻烦|帮我|贾维斯|jarvis|等等|哎呀|不对|算了)[，,\s]*)*"
    r"(?:(?:撤销|撤消|撤回)(?:一下)?(?:刚才|刚刚)?(?:的|那个|那步|那一步|这个)?(?:操作)?"
    r"|把?(?:刚才|刚刚)(?:的|那个|那步|那一步)?(?:操作)?(?:撤销|撤消|撤回)(?:了|掉)?)"
    r"(?:吧|一下)?[。！!.？?\s]*$",
    re.IGNORECASE,
)
ZH = {
    "Undo this: {label}?": "要撤销这一步吗：{label}？",
    "Undid: {label}": "撤销了：{label}",
    "Undo": "撤销",
}
lang.add_texts(ZH)


def asks_undo(text: str, language: str) -> bool:
    """The whole request is "undo that" (or its Chinese)."""
    words = " ".join(str(text or "").split())
    return bool(UNDO_THAT.match(words)) or (
        lang.is_zh(language) and bool(UNDO_THAT_ZH.match(lang.to_simplified(words)))
    )


_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_WEEKDAYS_ZH = ("一", "二", "三", "四", "五", "六", "日")


def parse_day(value: Any, today: date | None = None) -> date | None:
    """A day as the tool gets it: today, yesterday, the day before yesterday, a weekday (the
    last one, today included), YYYY-MM-DD; 今天, 昨天, 前天, 周一…周日 / 星期一…. None when
    it's none of those."""
    today = today or datetime.now().date()
    text = " ".join(str(value or "").casefold().split()).removeprefix("on ").removeprefix("last ")
    if text in ("", "today", "今天"):
        return today
    if text in ("yesterday", "昨天"):
        return today - timedelta(days=1)
    if text in ("the day before yesterday", "day before yesterday", "前天"):
        return today - timedelta(days=2)
    if text in _WEEKDAYS:
        return today - timedelta(days=(today.weekday() - _WEEKDAYS.index(text)) % 7)
    match = re.fullmatch(r"(?:周|星期|礼拜)([一二三四五六日天])", text)
    if match:
        wanted = _WEEKDAYS_ZH.index("日" if match.group(1) == "天" else match.group(1))
        return today - timedelta(days=(today.weekday() - wanted) % 7)
    if _ISO_DAY.match(text):
        try:
            return date.fromisoformat(text)
        except ValueError:
            return None
    return None


def _line(entry: dict[str, str], with_day: bool) -> str:
    when = datetime.fromisoformat(entry["t"])
    stamp = f"{when:%a %d %b} {when:%H:%M}" if with_day else f"{when:%H:%M}"
    words = f" ({entry['summary']})" if entry["summary"] else ""
    outcome = "" if entry["outcome"] == "done" else f" — {entry['outcome']}"
    return f"{stamp} {entry['label']}{words}{outcome}"


def told(entries: list[dict[str, str]], day: date | None, query: str) -> str:
    """what_did_you_do's answer: the calls, oldest first for a day, newest first for words."""
    if not entries:
        if query:
            return f"Nothing in your action log matches “{query}”" + (
                f" on {day:%A %d %B}." if day else "."
            )
        return f"Nothing in your action log for {day:%A %d %B}: you used no tools that day."
    shown = entries[:TOLD]
    if query:
        head = f"Your tool calls matching “{query}”" + (f" on {day:%A %d %B}" if day else "")
        head += ", newest first (from your action log):"
        lines = [_line(e, with_day=day is None) for e in shown]
    else:
        head = f"What you did on {day:%A %d %B} (from your action log, oldest first):"
        lines = [_line(e, with_day=False) for e in reversed(shown)]
    more = len(entries) - len(shown)
    if more > 0:
        lines.append(f"… and {more} more" + (" earlier." if query else " before these."))
    return "\n".join([head, *lines])


class Actions:
    """The actions feature on one hub (hub.actions)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._log: ActionLog | None = None  # made on first use, never at install
        self._pending: dict[str, dict[str, str]] = {}  # tool id -> its call, till its result
        self._done: list[dict[str, str]] = []  # this turn's calls with their outcome
        self._pruned: date | None = None
        self._writing = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self.undo = Undo(hub)
        self._offered = ""  # the Undo button's action under the reply, if one is shown

    @property
    def log(self) -> ActionLog:
        if self._log is None:
            self._log = ActionLog(self.hub.feature_path(LOG_FOLDER))
        return self._log

    def _spawn(self, coro: Any) -> asyncio.Task:
        task = self.hub._spawn(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _say(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    async def flush(self) -> None:
        """Wait for the writes and searches under way (tests)."""
        while self._tasks:
            await asyncio.wait(list(self._tasks))

    # ── recording ──

    def on_message(self, message: Any) -> None:
        self._for_undo(message)
        if self.hub.incognito:  # nothing of an incognito conversation is kept
            self._pending.clear()
            self._done.clear()
            return
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    self._pending[block.id] = {
                        "t": datetime.now().isoformat(timespec="seconds"),
                        "tool": short_name(block.name),
                        "label": tool_label(block.name),
                        "summary": summary(block.name, block.input),
                    }
        elif isinstance(message, UserMessage) and isinstance(message.content, list):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    entry = self._pending.pop(block.tool_use_id, None)
                    if entry is not None:
                        outcome = "failed" if block.is_error else "done"
                        self._done.append({**entry, "outcome": outcome})
        elif isinstance(message, ResultMessage):
            for entry in self._pending.values():  # no result came: the turn was stopped
                self._done.append({**entry, "outcome": "stopped"})
            self._pending.clear()
            if self._done:
                entries, self._done = self._done, []
                self._spawn(self._write(entries))

    def note(self, label: str, outcome: str = "done") -> None:
        """Something done without a tool call (an undo asked for in words or with the
        button), kept like one."""
        if self.hub.incognito:
            return
        entry = {"t": datetime.now().isoformat(timespec="seconds"), "tool": "undo"}
        self._spawn(self._write([{**entry, "label": label, "summary": "", "outcome": outcome}]))

    async def _write(self, entries: list[dict[str, str]]) -> None:
        async with self._writing:  # one at a time: a day's count stays right
            today = datetime.now().date()
            prune, self._pruned = self._pruned != today, today
            try:
                await asyncio.to_thread(self._write_now, entries, prune)
            except OSError as exc:  # a full disk: those calls go unlogged, nothing else
                log.warning("actions: couldn't keep the log (%s)", exc)

    def _write_now(self, entries: list[dict[str, str]], prune: bool) -> None:
        self.log.add(entries)
        if prune:
            self.log.prune()

    # ── looking back ──

    def lookup(self, day: date | None, query: str) -> list[dict[str, str]]:
        """Newest first: a day's calls (matching query, when given), or every day's."""
        if day is None:
            return self.log.search(query, limit=TOLD + 1)
        found = [
            e
            for e in reversed(self.log.day(day))
            if all(
                w in f"{e['label']} {e['summary']} {e['tool']}".casefold()
                for w in query.casefold().split()
            )
        ]
        return found

    async def search(self, msg: dict[str, Any]) -> None:
        """The History tab: entries matching q, newest first, older than before."""
        query = " ".join(str(msg.get("q") or "").split())[:200]
        before = str(msg.get("before") or "")[:19]
        try:
            datetime.fromisoformat(before)
        except ValueError:
            before = ""
        items = await asyncio.to_thread(self.log.search, query, before, PAGE + 1)
        self.hub.emit(
            "action_log",
            q=query,
            before=before,
            seq=str(msg.get("seq") or "")[:40],
            items=items[:PAGE],
            more=len(items) > PAGE,
        )

    # ── undo ──

    def on_connect(self, options: Any, _resume: str) -> None:
        """Every call of the conversation weighed as it runs: what it may change (before),
        what it did (after), or nothing (it failed)."""
        hooks = {kind: list(matchers) for kind, matchers in (options.hooks or {}).items()}
        for kind, hook in (
            ("PreToolUse", self._before_tool),
            ("PostToolUse", self._after_tool),
            ("PostToolUseFailure", self._tool_failed),
        ):
            hooks.setdefault(kind, []).append(HookMatcher(matcher=None, hooks=[hook]))
        options.hooks = hooks

    async def _before_tool(self, data: Any, tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        tool_id = str(tool_use_id or data.get("tool_use_id") or "")
        args = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
        await self.undo.before(str(data.get("tool_name") or ""), args, tool_id)
        return {}

    async def _after_tool(self, data: Any, tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        tool_id = str(tool_use_id or data.get("tool_use_id") or "")
        args = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
        await self.undo.after(str(data.get("tool_name") or ""), args, tool_id)
        return {}

    async def _tool_failed(self, data: Any, tool_use_id: Any, _context: Any) -> dict[str, Any]:
        data = data if isinstance(data, dict) else {}
        self.undo.failed(str(tool_use_id or data.get("tool_use_id") or ""))
        return {}

    def _for_undo(self, message: Any) -> None:
        if isinstance(message, UserMessage) and isinstance(message.content, list):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    self.undo.result(block.tool_use_id, bool(block.is_error))
        elif isinstance(message, ResultMessage):
            self.undo.turn_over()
            self._offer()

    def _offer(self) -> None:
        """The Undo button under the reply: this turn's last undoable action, if any."""
        turn = int(getattr(self.hub, "commands", 0))
        found = next(
            (a for a in self.undo.undoable() if a.turn == turn),
            None,
        )
        shown = found.id if found is not None else ""
        if shown or self._offered:
            self._offered = shown
            self.hub.emit("undo_offer", id=shown, label=found.label if found is not None else "")

    async def undo_now(self, action: Any) -> str:
        """Undo one action; what's said about it. Kept in the log when something ran."""
        said = await self.undo.undo(action)
        if action is not None and action.undone:
            self.note(self._say("Undid: {label}", label=action.label))
        if self._offered and (action is None or action.id == self._offered):
            self._offered = ""
            self.hub.emit("undo_offer", id="", label="")
        return said

    async def instant(self, text: str) -> str | None:
        """ "Undo that" (撤销): the last thing done, undone at once. The owner's own words
        asked for exactly this, so there's no card."""
        if not asks_undo(text, self.hub.language):
            return None
        return await self.undo_now(self.undo.last())

    async def undo_clicked(self, msg: dict[str, Any]) -> None:
        """The Undo button under the reply: the owner's own click, so no card. Between
        requests: never in the middle of one that may be changing the same things."""
        async with self.hub._lock:
            action = self.undo.find(str(msg.get("id") or ""))
            said = await self.undo_now(action) if action is not None else self.undo.nothing()
        self.hub.emit("toast", title=self._say("Undo"), text=said)

    def build_server(self) -> Any:
        return create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools())

    def tools(self) -> list[Any]:
        @tool(
            "what_did_you_do",
            "What you did: your own tool calls from your action log, with when, what, a few "
            "words (an app or a site, never what a message said) and how each went. day: "
            "'today' (the default), 'yesterday', a weekday or YYYY-MM-DD; query: words to "
            "look for (with no day, across every day kept).",
            {
                "type": "object",
                "properties": {"day": {"type": "string"}, "query": {"type": "string"}},
            },
        )
        async def what_did_you_do(args: dict[str, Any]) -> dict[str, Any]:
            query = " ".join(str(args.get("query") or "").split())[:100]
            raw_day = str(args.get("day") or "").strip()
            day = parse_day(raw_day) if raw_day or not query else None
            if raw_day and day is None:
                return _text(
                    "Give the day as today, yesterday, a weekday or YYYY-MM-DD.", error=True
                )
            oldest = datetime.now().date() - timedelta(days=action_log.LOG_DAYS - 1)
            if day is not None and day < oldest:
                return _text(f"Your action log keeps {action_log.LOG_DAYS} days, from {oldest}.")
            entries = await asyncio.to_thread(self.lookup, day, query)
            return _text(told(entries, day, query))

        @tool(
            "undo_action",
            "Undo something you did in the last half hour: an event you added, changed or "
            "removed; something you remembered or forgot; a routine you made, paused or "
            "deleted; a document you saved (moved to the Trash); a shortcut made instant. "
            "which: words from what it was ('the Dentist event'), or empty for the last "
            "thing you did. Messages, emails and calls can't be undone.",
            {"type": "object", "properties": {"which": {"type": "string"}}},
        )
        async def undo_action(args: dict[str, Any]) -> dict[str, Any]:
            which = " ".join(str(args.get("which") or "").split())[:200]
            action = self.undo.pick(which)
            if action is None:
                return _text(self.undo.nothing(which))
            if action.kind == "undo" and not action.undone:
                question = self._say("Undo this: {label}?", label=action.label)
                if not await self.hub.feature_gate("undo", question):
                    return _text("The user didn't want that undone.", error=True)
            return _text(await self.undo_now(action))

        return [what_did_you_do, undo_action]

    def install(self) -> None:
        hub = self.hub
        hub.actions = self
        hub.add_message_sink(self.on_message)
        hub.register_server(SERVER, self.build_server, prompt=PROMPT, labels=LABELS)
        hub.register_command("action_log", lambda msg: self._spawn(self.search(msg)) and None)
        hub.add_connect_hook(self.on_connect)
        hub.register_instant(self.instant)
        hub.register_command(
            "undo_action", lambda msg: self._spawn(self.undo_clicked(msg)) and None
        )


def _text(text: str, error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        result["is_error"] = True
    return result


def install(hub: Any) -> None:
    Actions(hub).install()
