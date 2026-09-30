"""What JARVIS did (the actions feature): a lasting, searchable log of every tool call of its
own conversation (action_log.py), for the owner and for JARVIS itself.

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

Claude cost policy: no model is called here. what_did_you_do is a tool of the conversation
itself, answered from the file.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    tool,
)

from .. import action_log
from ..action_log import ActionLog, short_name, summary
from ..hub import tool_label

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
)
LABELS = {"what_did_you_do": "Looked back at what I did"}

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

    async def flush(self) -> None:
        """Wait for the writes and searches under way (tests)."""
        while self._tasks:
            await asyncio.wait(list(self._tasks))

    # ── recording ──

    def on_message(self, message: Any) -> None:
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

        return [what_did_you_do]

    def install(self) -> None:
        hub = self.hub
        hub.actions = self
        hub.add_message_sink(self.on_message)
        hub.register_server(SERVER, self.build_server, prompt=PROMPT, labels=LABELS)
        hub.register_command("action_log", lambda msg: self._spawn(self.search(msg)) and None)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        result["is_error"] = True
    return result


def install(hub: Any) -> None:
    Actions(hub).install()
