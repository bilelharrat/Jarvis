"""Undo for JARVIS's own actions, for UNDO_SECONDS after each ("undo that").

Every tool call of JARVIS's conversation is weighed as it runs (the actions feature's
PreToolUse and PostToolUse hooks call before() and after(); the stream's results, result()):
what it changed is kept, with how to put it back.

- Calendar: an event added (removed again), changed (changed back to its old fields) or
  removed (added again from its old fields: a one-off, and without re-inviting anyone).
- Memory: facts remembered, forgotten or reworded (the store put back as it was for them).
- Routines: made, paused or resumed, deleted (removed, switched back, put back).
- Documents written (moved to the Trash, never deleted; not if it's been changed since).
- Shortcuts made instant ("Always" on a shortcut's card): made to ask first again.

Anything else that acts is kept too, as something that can't be undone, so "undo that" is
always about the last thing done: a message, an email or a call is said plainly to be past
undoing, and so is anything else ("I can't undo the last thing I did"). Looking (reading the
calendar, a search) isn't an action.

Everything is kept in memory only, never on disk: it's the owner's data (event titles, what
was remembered), and undo is for the next half hour.
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import brain, lang

log = logging.getLogger("jarvis")

UNDO_SECONDS = 30 * 60
KEPT = 40  # actions kept, newest first
# Words of "undo the last change you made" that don't name what to undo.
_FILLER = frozenset(
    "undo that this it the a an my your last latest recent thing things change changes one "
    "you i did made just please jarvis event events to of on from what fact facts".split()
)

# Tools that only look: never an action, never in the way of "undo that".
LOOKING = frozenset(
    {
        "list_events", "find_free_slots", "list_emails", "system_status", "now_playing",
        "list_shortcuts", "search_notes", "read_note", "second_brain_status", "recall",
        "list_routines", "weather_report", "where_am_i", "drive_time", "market_summary",
        "find_files", "read_file", "see_screen", "browser_page", "WebSearch", "WebFetch",
        "claude_task_status", "list_claude_sessions", "list_reports", "read_report",
        "recent_documents", "read_document", "meeting_transcript", "what_did_i_miss",
        "learned_words", "interruptions_status", "interruption_learning",
        "recent_transactions", "list_delegations", "delegation_transcript", "find_contact",
        "list_goals", "list_ai_models", "list_calls", "list_invoices", "recent_files",
        "recent_screens", "search_files", "find_my_files", "files_for", "suggestion_status",
        "video_status", "video_transcript", "whatsapp_chats", "whatsapp_read",
        "whatsapp_search", "session_summary", "list_sessions", "phone_health",
        "what_did_you_do", "undo_action", "research_read", "research_screenshot",
        "sim_list", "sim_screenshot",
        *brain.BROWSER_LOOKING,
    }
)  # fmt: skip
_LOOKING_NAME = re.compile(r"^(?:list|read|get|search|find|recent|check|lookup)_|_status$")
# Servers whose every tool only reads: the research desk's, the second brain's.
LOOKING_SERVERS = ("mcp__bsh__", "mcp__brain__")

# Things that went out into the world: said plainly, never undone.
OUTWARD = {
    "send_message": "That message has already gone, so I can't take it back.",
    "send_email": "That email has already gone, so I can't take it back.",
    "whatsapp_send": "That message has already gone, so I can't take it back.",
    "send_file_to_chat": "That file has already gone, so I can't take it back.",
    "email_invoice": "That email has already gone, so I can't take it back.",
    "delegate_conversation": "Those messages have already gone, so I can't take them back.",
    "continue_delegation": "Those messages have already gone, so I can't take them back.",
    "call_me": "That call has already been made; a call can't be undone.",
    "call_someone": "That call has already been made; a call can't be undone.",
    "call_for_me": "That call has already been made; a call can't be undone.",
    "ring_from_iphone": "That call has already been made; a call can't be undone.",
    "book_caller": "The caller has already been told, so I can't take it back.",
    "decline_caller": "The caller has already been told, so I can't take it back.",
    "confirm_transaction": "A purchase can't be undone from here; the seller's own cancellation is the way.",
    "reserve_table": "That booking was made with the restaurant; I can't undo it from here.",
}

ZH = {
    "There's nothing of mine to undo from the last half hour.": "最近半小时里，我没做过能撤销的事。",
    "I can't undo the last thing I did ({label}).": "刚才那一步（{label}）没法撤销。",
    "That message has already gone, so I can't take it back.": "那条消息已经发出去了，撤不回来。",
    "That email has already gone, so I can't take it back.": "那封邮件已经发出去了，撤不回来。",
    "That file has already gone, so I can't take it back.": "那个文件已经发出去了，撤不回来。",
    "Those messages have already gone, so I can't take them back.": "那些消息已经发出去了，撤不回来。",
    "That call has already been made; a call can't be undone.": "那通电话已经打过了，电话没法撤销。",
    "The caller has already been told, so I can't take it back.": "已经告诉来电的人了，收不回来。",
    "A purchase can't be undone from here; the seller's own cancellation is the way.": (
        "购买没法在这里撤销，得走商家自己的取消流程。"
    ),
    "That booking was made with the restaurant; I can't undo it from here.": (
        "那个订位已经在餐厅订好了，我没法在这里撤销。"
    ),
    "Undone: “{title}” is off your calendar again.": "已撤销：“{title}”已从日历上拿掉。",
    "Undone: “{title}” is back as it was.": "已撤销：“{title}”已改回原样。",
    "Undone: “{title}” is back on your calendar.": "已撤销：“{title}”已放回日历。",
    "Undone: “{title}” is back on your calendar as a one-off.": "已撤销：“{title}”已作为单次活动放回日历。",
    " Those who were in it weren't invited again.": "之前参加的人没有再次收到邀请。",
    "“{title}” was a repeating series and every later one went; I can't put a series back.": (
        "“{title}”是重复活动，之后的每一次也一起删了；整个系列我没法放回去。"
    ),
    "I couldn't undo that: {why}": "没能撤销：{why}",
    "Undone: I've forgotten that again.": "已撤销：我已经重新忘掉了那条。",
    "Undone: I remember it again.": "已撤销：我又记起来了。",
    "Undone: what I remember is back as it was.": "已撤销：我记住的内容已恢复原样。",
    "Undone: the routine “{name}” is gone.": "已撤销：例行任务“{name}”已删除。",
    "Undone: the routine “{name}” is back.": "已撤销：例行任务“{name}”已恢复。",
    "Undone: the routine “{name}” is on again.": "已撤销：例行任务“{name}”已重新开启。",
    "Undone: the routine “{name}” is paused again.": "已撤销：例行任务“{name}”已重新暂停。",
    "Undone: “{title}” is in the Trash.": "已撤销：“{title}”已移到废纸篓。",
    "You've changed “{title}” since I saved it, so I've left it where it is.": (
        "我保存之后你改过“{title}”，所以我没有动它。"
    ),
    "“{title}” isn't where I saved it any more.": "“{title}”已经不在我保存的位置了。",
    "Undone: the shortcut “{name}” asks first again.": "已撤销：快捷指令“{name}”恢复为先问你。",
    " What it did when it ran can't be undone from here.": "它运行时做过的事没法在这里撤销。",
    "That was undone already.": "那一步已经撤销过了。",
    "I haven't done anything like that in the last half hour.": "最近半小时里我没做过这样的事。",
    "Remembered “{fact}”": "记住了“{fact}”",
    "Forgot “{fact}”": "忘掉了“{fact}”",
    "Changed what I remember": "改了我记住的内容",
    "Added the routine “{name}”": "添加了例行任务“{name}”",
    "Deleted the routine “{name}”": "删除了例行任务“{name}”",
    "Resumed the routine “{name}”": "重新开启了例行任务“{name}”",
    "Paused the routine “{name}”": "暂停了例行任务“{name}”",
    "Saved the document “{title}”": "保存了文档“{title}”",
    "Ran the shortcut “{name}” and made it instant": "运行了快捷指令“{name}”，并设为不再询问",
    "Added “{title}” to your calendar": "把“{title}”加到了日历上",
    "Changed “{title}” on your calendar": "改了日历上的“{title}”",
    "Removed “{title}” from your calendar": "把“{title}”从日历上删掉了",
}
lang.add_texts(ZH)


@dataclass
class Action:
    """Something JARVIS did: what it was, and (for one that can be undone) how to put it
    back. kind: "undo" (inverse set), "outward" (said plainly, never undone) or "final"."""

    id: str
    tool: str
    label: str  # what it did, in a few words ("Added “Dentist” to your calendar")
    kind: str
    turn: int  # the request (hub.commands) it came in
    at: float = field(default_factory=time.monotonic)
    when: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    inverse: Callable[[], Awaitable[str]] | None = None
    undone: bool = False

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "tool": self.tool, "label": self.label, "when": self.when}


def short(tool_name: str) -> str:
    return str(tool_name or "").split("__")[-1]


def _asked_words(which: str) -> list[str]:
    return [w for w in re.findall(r"\w+", str(which or "").casefold()) if w not in _FILLER]


def looking(tool_name: str) -> bool:
    """A tool that only reads: never an action."""
    name = short(tool_name)
    return (
        name in LOOKING
        or bool(_LOOKING_NAME.search(name))
        or str(tool_name).startswith(LOOKING_SERVERS)
    )


def trash(path: Path) -> None:
    """Move a file to the Trash (the Finder's own, so it can be put back); never delete."""
    from Foundation import NSURL, NSFileManager

    ok, _where, error = NSFileManager.defaultManager().trashItemAtURL_resultingItemURL_error_(
        NSURL.fileURLWithPath_(str(path)), None, None
    )
    if not ok:
        raise OSError(str(error.localizedDescription()) if error is not None else "it said no")


def _stat(path: Path) -> tuple[int, int] | None:
    try:
        st = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    return (st.st_size, st.st_mtime_ns)


def _event_start(row: dict[str, Any]) -> str:
    """An event's start as the calendar tools take it: a day for an all-day one."""
    return row["begin"][:10] if row.get("all_day") else row["begin"][:16]


class Undo:
    """What JARVIS did lately, and undoing it (hub.conversation.undo)."""

    def __init__(self, hub: Any, clock: Callable[[], float] = time.monotonic) -> None:
        self.hub = hub
        self.clock = clock
        self.actions: list[Action] = []  # newest last
        self._ids = itertools.count(1)
        self._before: dict[str, Any] = {}  # a call's tool id -> what it saw before
        self._pending: dict[str, Action] = {}  # ... -> what it did, till its result comes
        # The calendar, the Trash: through these (tests put fakes here).
        from . import calendar_kit

        self.calendar = calendar_kit
        self.trash = trash

    def _say(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    # ── what a call changed ──

    async def before(self, tool_name: str, tool_input: dict[str, Any], tool_id: str) -> None:
        """Just before a call runs (before its card, if it has one): what it may change."""
        if looking(tool_name):
            return
        name, hub = short(tool_name), self.hub
        try:
            if tool_name.startswith("mcp__memory__"):
                self._before[tool_id] = copy.deepcopy(list(hub.memory.facts))
            elif tool_name.startswith("mcp__routines__"):
                self._before[tool_id] = copy.deepcopy(list(hub.routines.items))
            elif name == "write_document":
                self._before[tool_id] = {r.path for r in hub.documents.recent}
            elif name == "run_shortcut":
                self._before[tool_id] = list(hub.prefs.instant_shortcuts)
            elif tool_name == brain.mac_tool("create_event"):
                self._before[tool_id] = await self._ids_at(str(tool_input.get("start") or ""))
            elif tool_name in (brain.mac_tool("edit_event"), brain.mac_tool("remove_event")):
                self._before[tool_id] = await self._one_event(tool_input)
        except Exception:  # never in the way of the call itself
            log.warning("undo: couldn't look before %s", name, exc_info=True)

    def failed(self, tool_id: str) -> None:
        """A call that failed (PostToolUseFailure): it did nothing to keep."""
        self._before.pop(tool_id, None)
        self._pending.pop(tool_id, None)

    async def after(self, tool_name: str, tool_input: dict[str, Any], tool_id: str) -> None:
        """A call returned (PostToolUse): what it did, and how to undo it, kept once its
        result shows it went through (result())."""
        before = self._before.pop(tool_id, None)
        if looking(tool_name):
            return
        name = short(tool_name)
        try:
            action = await self._action(tool_name, name, tool_input, before)
        except Exception:
            log.warning("undo: couldn't weigh %s", name, exc_info=True)
            action = None
        if action is None:
            from .hub import tool_label

            kind = "outward" if name in OUTWARD else "final"
            action = self._new(name, tool_label(tool_name), kind)
        if action.kind != "none":  # "none": it changed nothing (a card said no)
            self._pending[tool_id] = action

    def result(self, tool_id: str, is_error: bool) -> None:
        """A call's result, as the conversation's stream brings it: an error did nothing."""
        action = self._pending.pop(tool_id, None)
        if action is not None and not is_error:
            self._keep(action)

    def turn_over(self) -> None:
        """The turn ended: a call whose result never came (the turn was stopped) is kept as
        something done that can't be undone, unless what it changed is known."""
        for action in self._pending.values():
            if action.kind == "outward":
                action.kind = "final"  # it may or may not have gone: never said to have
            self._keep(action)
        self._pending.clear()
        self._before.clear()  # calls a card said no to never ran

    def _keep(self, action: Action) -> None:
        self.actions.append(action)
        del self.actions[:-KEPT]

    def _new(self, tool: str, label: str, kind: str, inverse: Any = None) -> Action:
        return Action(
            id=f"u{next(self._ids)}",
            tool=tool,
            label=label,
            kind=kind,
            turn=int(getattr(self.hub, "commands", 0)),
            at=self.clock(),
            inverse=inverse,
        )

    async def _action(
        self, tool_name: str, name: str, args: dict[str, Any], before: Any
    ) -> Action | None:
        if tool_name.startswith("mcp__memory__") and before is not None:
            return self._memory(name, before)
        if tool_name.startswith("mcp__routines__") and before is not None:
            return self._routines(name, before)
        if name == "write_document" and before is not None:
            return self._document(before)
        if name == "run_shortcut" and before is not None:
            return self._shortcut(before, str(args.get("name") or ""))
        if tool_name == brain.mac_tool("create_event") and before is not None:
            return await self._created_event(args, before)
        if tool_name == brain.mac_tool("edit_event") and before:
            return self._edited_event(args, before)
        if tool_name == brain.mac_tool("remove_event") and before:
            return self._removed_event(args, before)
        return None

    # ── memory ──

    def _memory(self, name: str, before: list[Any]) -> Action:
        store = self.hub.memory
        was = {f.id: f for f in before}
        now = {f.id: f for f in store.facts}
        added = [f for i, f in now.items() if i not in was]
        gone = [f for i, f in was.items() if i not in now]
        changed = [(was[i], f) for i, f in now.items() if i in was and was[i].text != f.text]
        if not (added or gone or changed):
            return self._new(name, "", "none")
        after = {f.id: copy.deepcopy(f) for f in store.facts}
        order = [f.id for f in before]

        reworded = {old.id: (old, new) for old, new in changed}

        async def inverse() -> str:
            # Worked out on a copy: the store changes only once the file has it too.
            kept = []
            for fact in store.facts:
                if fact.id in after and fact.text == after[fact.id].text:
                    if fact.id in reworded:  # reworded: the old words back
                        kept.append(copy.deepcopy(reworded[fact.id][0]))
                        continue
                    if fact.id not in was:  # remembered: forgotten again, as it was put
                        continue
                kept.append(fact)
            present = {f.id for f in kept}
            for fact in gone:  # forgotten: back where it was
                if fact.id not in present:
                    spot = order.index(fact.id) if fact.id in order else len(kept)
                    kept.insert(min(spot, len(kept)), copy.deepcopy(fact))
            previous, store.facts = store.facts, kept
            try:
                # Nothing it had remembered is left behind in the backup copy.
                store.save(keep_copy=not added)
            except OSError:
                store.facts = previous
                raise
            self.hub._memory_changed()
            self.hub._add_style_note(
                "the user undid your last change to what you remember; go by what's there now"
            )
            if gone and not added and not changed:
                return self._say("Undone: I remember it again.")
            if added and not gone and not changed:
                return self._say("Undone: I've forgotten that again.")
            return self._say("Undone: what I remember is back as it was.")

        if added and not gone:
            label = self._say("Remembered “{fact}”", fact=added[0].text)
        elif gone and not added:
            label = self._say("Forgot “{fact}”", fact=gone[0].text)
        else:
            label = self._say("Changed what I remember")
        return self._new(name, label, "undo", inverse)

    # ── routines ──

    def _routines(self, name: str, before: list[Any]) -> Action:
        store = self.hub.routines
        was = {r.id: r for r in before}
        now = {r.id: r for r in store.items}
        added = [r for i, r in now.items() if i not in was]
        gone = [r for i, r in was.items() if i not in now]
        switched = [r for i, r in now.items() if i in was and was[i].enabled != r.enabled]
        if not (added or gone or switched):
            return self._new(name, "", "none")
        order = [r.id for r in before]

        async def inverse() -> str:
            said = ""
            for routine in added:
                if store.remove(routine.id) is not None:
                    said = self._say("Undone: the routine “{name}” is gone.", name=routine.name)
            for routine in switched:
                back = not routine.enabled
                if store.set_enabled(routine.id, back) is not None:
                    said = self._say(
                        "Undone: the routine “{name}” is on again."
                        if back
                        else "Undone: the routine “{name}” is paused again.",
                        name=routine.name,
                    )
            for routine in gone:
                if store.find(routine.id) is None:
                    spot = order.index(routine.id) if routine.id in order else len(store.items)
                    store.items.insert(min(spot, len(store.items)), copy.deepcopy(routine))
                    try:
                        store.save()
                    except OSError:
                        store.items = [r for r in store.items if r.id != routine.id]
                        raise
                    said = self._say("Undone: the routine “{name}” is back.", name=routine.name)
            self.hub._routines_changed()
            return said or self._say("That was undone already.")

        if added:
            label = self._say("Added the routine “{name}”", name=added[0].name)
        elif gone:
            label = self._say("Deleted the routine “{name}”", name=gone[0].name)
        else:
            label = self._say(
                "Resumed the routine “{name}”"
                if switched[0].enabled
                else "Paused the routine “{name}”",
                name=switched[0].name,
            )
        return self._new(name, label, "undo", inverse)

    # ── documents ──

    def _document(self, before: set[str]) -> Action | None:
        store = self.hub.documents
        record = next(
            (r for r in store.recent if r.action == "wrote" and r.path not in before), None
        )
        if record is None:  # an existing document written over: that can't be put back
            return None
        path, title = Path(record.path), record.title
        seen = _stat(path)

        async def inverse() -> str:
            now = _stat(path)
            if now is None:
                return self._say("“{title}” isn't where I saved it any more.", title=title)
            if now != seen:
                return self._say(
                    "You've changed “{title}” since I saved it, so I've left it where it is.",
                    title=title,
                )
            await asyncio.to_thread(self.trash, path)
            if store.forget(str(path)):
                self.hub._documents_changed()
            return self._say("Undone: “{title}” is in the Trash.", title=title)

        label = self._say("Saved the document “{title}”", title=title)
        return self._new("write_document", label, "undo", inverse)

    # ── shortcuts made instant ──

    def _shortcut(self, before: list[str], name: str) -> Action | None:
        made = [n for n in self.hub.prefs.instant_shortcuts if n not in before]
        if not made:
            return None  # it ran: that's final

        async def inverse() -> str:
            hub = self.hub
            hub.set_prefs(
                {"instant_shortcuts": [n for n in hub.prefs.instant_shortcuts if n not in made]}
            )
            return self._say("Undone: the shortcut “{name}” asks first again.", name=made[0]) + (
                self._say(" What it did when it ran can't be undone from here.")
            )

        return self._new(
            "run_shortcut",
            self._say("Ran the shortcut “{name}” and made it instant", name=name or made[0]),
            "undo",
            inverse,
        )

    # ── the calendar ──

    async def _ids_at(self, start: str) -> set[str] | None:
        found = await self.calendar.events_at(start)
        if "error" in found:
            return None
        return {row["id"] for row in found.get("events", [])}

    async def _one_event(self, args: dict[str, Any]) -> dict[str, Any] | None:
        found = await self.calendar.events_at(str(args.get("start") or "").strip())
        if "error" in found:
            return None
        hits = self.calendar.choose(
            found.get("events", []), str(args.get("title") or ""), str(args.get("calendar") or "")
        )
        return dict(hits[0]) if len(hits) == 1 else None

    async def _created_event(self, args: dict[str, Any], before: set[str]) -> Action | None:
        start = str(args.get("start") or "").strip()
        found = await self.calendar.events_at(start)
        if "error" in found:
            return None
        title = str(args.get("title") or "")
        new = [r for r in found.get("events", []) if r["id"] not in before]
        mine = self.calendar.choose(new, title) or new
        if len(mine) != 1:
            return None  # can't tell which it made: not undone by guessing
        row = mine[0]

        async def inverse() -> str:
            done = await self.calendar.remove_at(
                _event_start(row), row["id"], row["calendar"], False
            )
            if "error" in done:
                return self._say("I couldn't undo that: {why}", why=done["error"])
            return self._say("Undone: “{title}” is off your calendar again.", title=row["title"])

        return self._new(
            "create_event",
            self._say("Added “{title}” to your calendar", title=row["title"]),
            "undo",
            inverse,
        )

    def _edited_event(self, args: dict[str, Any], old: dict[str, Any]) -> Action:
        new_start = str(args.get("new_start") or "").strip()
        if new_start:
            moment, day_only = self.calendar.when(new_start)
            now_start = (
                moment.date().isoformat()
                if (day_only or old.get("all_day"))
                else (moment.isoformat(timespec="minutes"))
            )
        else:
            now_start = _event_start(old)
        future = bool(args.get("future"))
        changes: dict[str, Any] = {"title": old["title"], "location": old.get("location", "")}
        changes["start"] = _event_start(old)
        if not old.get("all_day"):
            begin, end = datetime.fromisoformat(old["begin"]), datetime.fromisoformat(old["end"])
            changes["duration_minutes"] = max(1, int((end - begin) / timedelta(minutes=1)))
        title = old["title"]

        async def inverse() -> str:
            done = await self.calendar.edit_at(
                now_start, old["id"], old["calendar"], future, changes
            )
            if "error" in done:
                return self._say("I couldn't undo that: {why}", why=done["error"])
            return self._say("Undone: “{title}” is back as it was.", title=title)

        label = self._say("Changed “{title}” on your calendar", title=title)
        return self._new("edit_event", label, "undo", inverse)

    def _removed_event(self, args: dict[str, Any], old: dict[str, Any]) -> Action:
        title = old["title"]
        series = bool(args.get("future")) and old.get("repeats")

        async def inverse() -> str:
            if series:
                return self._say(
                    "“{title}” was a repeating series and every later one went; I can't put a "
                    "series back.",
                    title=title,
                )
            done = await self.calendar.add_event(old)
            if "error" in done:
                return self._say("I couldn't undo that: {why}", why=done["error"])
            said = self._say(
                "Undone: “{title}” is back on your calendar as a one-off."
                if old.get("repeats")
                else "Undone: “{title}” is back on your calendar.",
                title=title,
            )
            if old.get("attendees"):
                said += self._say(" Those who were in it weren't invited again.")
            return said

        label = self._say("Removed “{title}” from your calendar", title=title)
        return self._new("remove_event", label, "undo", inverse)

    # ── undoing ──

    def recent(self) -> list[Action]:
        """What was done in the last UNDO_SECONDS, newest first."""
        now = self.clock()
        return [a for a in reversed(self.actions) if now - a.at <= UNDO_SECONDS]

    def undoable(self) -> list[Action]:
        return [a for a in self.recent() if a.kind == "undo" and not a.undone]

    def last(self) -> Action | None:
        """The last thing done that isn't undone yet, within UNDO_SECONDS."""
        return next((a for a in self.recent() if not a.undone), None)

    def find(self, action_id: str) -> Action | None:
        return next((a for a in self.recent() if a.id == action_id), None)

    def pick(self, which: str = "") -> Action | None:
        """What "undo …" means: the last thing done ("" or "that"), else the newest thing
        done lately whose label holds every word asked about ("the Dentist event")."""
        words = _asked_words(which)
        if not words:
            return self.last()
        for action in self.recent():
            said = re.findall(r"\w+", action.label.casefold())
            # A word's first letters: "removing" finds "Removed", "routines" finds "routine".
            if not action.undone and all(any(s.startswith(w[:5]) for s in said) for w in words):
                return action
        return None

    def nothing(self, which: str = "") -> str:
        """What's said when pick() found nothing."""
        if _asked_words(which):
            return self._say("I haven't done anything like that in the last half hour.")
        return self._say("There's nothing of mine to undo from the last half hour.")

    async def undo(self, action: Action | None) -> str:
        """Undo one action; what's said about it."""
        if action is None:
            return self._say("There's nothing of mine to undo from the last half hour.")
        if action.undone:
            return self._say("That was undone already.")
        if action.kind == "outward":
            return self._say(OUTWARD.get(action.tool, OUTWARD["send_message"]))
        if action.kind != "undo" or action.inverse is None:
            return self._say("I can't undo the last thing I did ({label}).", label=action.label)
        try:
            said = await action.inverse()
        except Exception as exc:
            log.warning("undo failed", exc_info=True)
            return self._say("I couldn't undo that: {why}", why=str(exc) or type(exc).__name__)
        action.undone = True
        return said
