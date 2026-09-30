"""JARVIS's own conversation (the conversation feature): what outlasts a restart, and the
owner's view of it.

- It survives restarts: the current conversation's session id is kept (conversation.json
  beside prefs.json, with what each conversation has read, for the turn gate, its cost and
  its title) and carried on at startup (hub.first_connect) with a "Carrying on from earlier"
  note, when Settings says so (conversation_resume, on by default). One that won't resume is
  left and a new one starts. "New conversation" still starts afresh.
- Past conversations: listed, searched and read back from Claude Code's own records of the
  brain's sessions (conversation_past), and carried on as the current conversation after a
  card. One reopened whose reads aren't on record counts as having read private data.
- How full it is: the conversation's context (the SDK's context usage, as Jarvis Code's ring
  shows a session's) and what it has cost, after every turn and when the window asks;
  "Compact now" (Claude Code's /compact), and a note in the conversation when it's summed up,
  by itself or when asked.
- Thinking: a Settings level for everyday turns (conversation_thinking: off, low, medium,
  high; off by default, for speed), and "think hard about…", "take your time" (and their
  Chinese) for one request. The Python SDK has no way to turn thinking on for one query, so
  that request's connection is made again with thinking and a higher effort, keeping the
  conversation (the same session, resumed), and made again without them after it. Not on
  the fallback model, nor while incognito (a connection made again would lose it).
- Incognito (jarvis.incognito): a conversation nothing is kept of. Claude Code writes no
  record of it, it can't remember or forget, the hub learns nothing from its words and none
  of it goes into conversation.json; the conversation from before stays the one carried on,
  after a restart and when the owner leaves ("go incognito", "leave incognito", 开启无痕模式,
  退出无痕模式; the window's banner and Conversations). Past conversations can be read in it,
  not carried on.

Hooks it uses: hub.first_connect, hub.add_connect_hook (a new conversation), hub.add_query_hook
(its title, the note put away), hub.add_message_sink (each turn's end: its session id, what
it has read, its cost; a summary made to make room).

Window commands: conversation_state (-> conversation), conversation_list {q, seq} (->
conversation_list), conversation_open {session_id} (-> conversation_transcript),
conversation_resume {session_id} (a card, then the conversation it carries on),
conversation_context (-> conversation_context), conversation_compact,
conversation_thinking {level}, conversation_incognito {on}. heard_edit is taken while
incognito (a transcript fixed then teaches nothing); otherwise it goes on to the hub.

Claude cost policy: nothing here calls a model on its own. "Compact now" is one call of the
conversation's own model, only when the owner presses it; the automatic summing-up is Claude
Code's own, as before. Thinking is the conversation's own model thinking before it answers:
for a "think hard" request (the owner's own words only), adaptive thinking at high effort (max
when the everyday level is high); every turn at the Settings level when that's on. Off by
default; no background calls.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from datetime import datetime
from typing import Any

from claude_agent_sdk import ResultMessage, SystemMessage

from .. import conversation_past as past
from .. import incognito, lang, prefs
from ..conversation_state import ConversationState, clean_reads, valid_id
from ..hub import _asks, user_asked
from ..tasks import shape_context

log = logging.getLogger("jarvis")

RESUME_PREF = "conversation_resume"
prefs.register_feature_pref(RESUME_PREF, True)
THINKING_PREF = "conversation_thinking"
THINKING_LEVELS = ("off", "low", "medium", "high")
prefs.register_feature_pref(THINKING_PREF, "off", lambda v: v if v in THINKING_LEVELS else None)

# "Think hard about…", "take your time and…", "think it through": that request gets thinking.
THINK_HARD = _asks(
    r"(?:really\s+)?think\s+(?:(?:long\s+and\s+)?hard(?:er)?|carefully|deeply|it\s+(?:all\s+)?through"
    r"|this\s+through|that\s+through|things\s+through|step\s+by\s+step)\b"
    r"|take\s+(?:your|some|all\s+the)\s+time\b"
    r"|ultrathink\b"
    r"|give\s+(?:it|this|that)\s+(?:some\s+)?(?:real\s+|careful\s+|serious\s+|proper\s+)?thought\b"
    r"|(?:don'?t|do\s+not)\s+rush\b|no\s+rush\b(?!\s+hours?\b)"
    r"|(?:reason|work)\s+(?:it|this|that)\s+(?:out\s+)?carefully\b"
)
# 好好想想, 仔细思考一下, 认真考虑, 慢慢来, 不着急, 深度思考. (The lead-in takes 好 as "okay",
# so 好好 can be gone before the verb: the lookbehind finds it there.)
THINK_HARD_ZH = lang._asks_zh(
    r"(?:(?:好好|仔细|认真|深入|慢慢)地?|(?<=好好)地?)(?:想想|想一想|想一下|思考|考虑|琢磨)"
    r"|多(?:想想|想一想|思考一下)"
    r"|慢慢来|不着急|别着急|不用急|深度思考"
)


def asks_for_thought(text: str, language: str) -> bool:
    """The owner's own words asked for a considered answer to this request."""
    return user_asked(THINK_HARD, text) or (
        lang.is_zh(language) and lang.user_asked_zh(THINK_HARD_ZH, text)
    )


STATE_FILE = "conversation.json"
TAIL_SHOWN = 20  # a carried-on conversation's last lines, shown in the window again
LISTED = 100  # past conversations a list or a search sends the window
BRAIN_HITS = 40  # the second brain's passages a search of past conversations weighs
_CONVERSATION_NOTE = re.compile(r"^conversation:([\w-]+):\d+$")

ZH = {
    "Carrying on from earlier.": "接着之前的对话继续。",
    "Carrying on “{title}”.": "接着“{title}”继续。",
    "Carry on the conversation “{title}” from {when}?": "要接着{when}的对话“{title}”继续吗？",
    "The conversation you're in now ends here; it stays in Past conversations.": (
        "现在这段对话在这里结束；它会留在“过去的对话”里。"
    ),
    "That conversation isn't there any more.": "那段对话已经不在了。",
    "That conversation couldn't be carried on, so you're still in this one.": (
        "那段对话没能接上，所以还在现在这段对话里。"
    ),
    "That's the conversation you're in.": "这就是现在这段对话。",
    "Conversations": "对话",
    "Summed up the earlier conversation to make room.": "为了腾出空间，前面的对话已做成摘要。",
    "Summed up the conversation to make room, as you asked.": "已按你的要求，把对话做成摘要腾出空间。",
    "Couldn't make room just now; try again in a moment.": "现在没能腾出空间，稍后再试。",
    "Let me think that through.": "让我好好想想。",
    "Incognito: nothing from this conversation is kept.": "无痕模式：这段对话的内容一概不保留。",
    "Incognito: nothing from here on is kept.": "无痕模式：从这里开始的内容都不保留。",
    "We're already incognito.": "已经在无痕模式里了。",
    "We weren't incognito.": "现在不在无痕模式里。",
    "Back to your conversation. Nothing from the incognito one was kept.": (
        "回到你原来的对话了。无痕对话的内容一概没有保留。"
    ),
    "Nothing from the incognito conversation was kept.": "无痕对话的内容一概没有保留。",
    "Leave incognito to carry on a past conversation.": "先退出无痕模式，才能接着过去的对话。",
    "Couldn't go incognito just now; try again in a moment.": "现在没能进入无痕模式，稍后再试。",
    "Incognito is over, but the conversation couldn't start again just now; try again in a "
    "moment.": "无痕模式已结束，但对话暂时没能重新开始，稍后再试。",
}
lang.add_texts(ZH)
# What's said when going in (True) or out (False) of incognito fails.
FAILED = {
    True: "Couldn't go incognito just now; try again in a moment.",
    False: "Incognito is over, but the conversation couldn't start again just now; try again "
    "in a moment.",
}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _day(moment: datetime, language: str) -> str:
    """A day as it's said: today, yesterday, Monday 28 September (今天, 昨天, 9月28日)."""
    days = (datetime.now().date() - moment.date()).days
    if lang.is_zh(language):
        return "今天" if days == 0 else "昨天" if days == 1 else f"{moment.month}月{moment.day}日"
    if days == 0:
        return "today"
    if days == 1:
        return "yesterday"
    return f"{moment:%A} {moment.day} {moment:%B}"


def _brain_ids(hits: list[dict[str, Any]]) -> set[str]:
    """The conversations the second brain's passages come from (their session ids)."""
    found = set()
    for hit in hits:
        match = _CONVERSATION_NOTE.match(str(hit.get("id") or ""))
        if match:
            found.add(match.group(1))
    return found


class Conversation:
    """The conversation feature on one hub (hub.conversation)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._state: ConversationState | None = None  # read on first use, never at install
        # Claude Code's records, through the SDK (tests put fakes here).
        self.list_sessions, self.get_messages, self.get_info = past._sdk()
        self.resumed: dict[str, Any] | None = None  # carried on, until the next request
        self._title = ""  # the first request of a conversation with no title yet
        self._conn_total: float | None = None  # this connection's running cost, as reported
        self.compacting = False
        self._hard = False  # the connection should think hard (a request asked it to)
        self._hard_connected = False  # ... and the connection made last does
        self._hard_turn = False  # the turn under way asked for thought
        self._reconnecting = False  # a connect of this feature's own, not a new conversation
        # While incognito: the conversation from before it (to go back to), and what the
        # incognito one has cost (kept in memory only).
        self._before: dict[str, Any] | None = None
        self._incognito_cost = 0.0
        self._dirty = False
        self._saver: asyncio.Task | None = None
        self._tasks: set[asyncio.Task] = set()

    # ── the record ──

    @property
    def state(self) -> ConversationState:
        if self._state is None:
            self._state = ConversationState(self.hub.feature_path(STATE_FILE))
        return self._state

    def _save_soon(self) -> None:
        """Save in the background, once for a burst of changes; a save in a thread writes a
        copy taken here, never what the loop is changing."""
        self._dirty = True
        if self._saver is None or self._saver.done():
            self._saver = self._spawn(self._save_all())

    async def _save_all(self) -> None:
        while self._dirty:
            self._dirty = False
            data = self.state.snapshot()
            try:
                await asyncio.to_thread(self.state.save, data)
            except OSError as exc:  # a full disk: kept in memory, saved with the next turn
                log.warning("conversation: couldn't save (%s)", exc)

    def _spawn(self, coro: Any) -> asyncio.Task:
        """Work in the background (the hub's), known here so flush() can wait for it."""
        task = self.hub._spawn(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def flush(self) -> None:
        """Wait for everything this feature started in the background: saves, the context,
        a card being answered (tests)."""
        while self._tasks:
            await asyncio.wait(list(self._tasks))

    def _say(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def _toast(self, text: str) -> None:
        self.hub.emit("toast", title=self._say("Conversations"), text=text)

    # ── carrying a conversation on: after a restart, or one reopened ──

    async def _show_carried_on(
        self, sid: str, info: Any, note: str, why: str, keep: bool = False
    ) -> None:
        """The window's conversation list becomes the carried-on conversation's last lines
        and the app's note (keep: what it already shows stays after them, a notice from
        startup); Claude hears when its last message was."""
        hub = self.hub
        entries = await asyncio.to_thread(past.entries, sid, None, get_messages=self.get_messages)
        last = int(getattr(info, "last_modified", 0) or 0)
        when = datetime.fromtimestamp(last / 1000) if last else None
        kept = list(hub.history) if keep else []
        hub.history.clear()
        for entry in (entries or [])[-TAIL_SHOWN:]:
            hub.history.append({**entry, "at": ""})
        hub.history.append({"role": "note", "text": note, "at": _now()})
        hub.history.extend(kept)
        if when is not None:
            hub._add_style_note(
                f"{why} (its last message was {when:%A %-d %B at %H:%M}); it carries on from there"
            )
        title = self._title_of(sid, info)
        self.resumed = {"title": title, "at": when.isoformat(timespec="seconds") if when else ""}

    def _title_of(self, sid: str, info: Any) -> str:
        return (
            self.state.titles().get(sid)
            or past.owner_words(getattr(info, "custom_title", "") or "")
            or past.owner_words(getattr(info, "first_prompt", "") or "")
        )[:100]

    async def first_connect(self) -> bool:
        """At startup: carry on the conversation from before, when Settings says so and
        Claude Code still has its record. False when a new one should start instead."""
        hub = self.hub
        if not hub.prefs.feature(RESUME_PREF):
            return False
        sid = valid_id(self.state.current)
        if not sid:
            return False
        info = await asyncio.to_thread(past.exists, sid, None, get_info=self.get_info)
        if info is None:
            log.info("conversation: the last one's record is gone; starting a new one")
            self.state.current = ""
            self._save_soon()
            return False
        try:
            await hub._connect(resume=sid)
        except Exception:
            log.warning("conversation: couldn't carry on the last one", exc_info=True)
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            hub.client = None
            return False
        hub._session_id = sid
        # What it had read before the restart is still in its context: the gates weigh it.
        hub._session_reads = self.state.reads_of(sid)
        await self._show_carried_on(
            sid,
            info,
            self._say("Carrying on from earlier."),
            "the app restarted since this conversation",
            keep=True,
        )
        log.info("conversation: carried on from before the restart")
        return True

    async def reopen(self, session_id: str) -> None:
        """Carry on a past conversation as the current one, after a card."""
        hub = self.hub
        sid = valid_id(session_id)
        if not sid:
            return
        if hub.incognito:  # carrying one on would end it: the owner leaves it first
            self._toast(self._say("Leave incognito to carry on a past conversation."))
            return
        if sid == hub._session_id:
            self._toast(self._say("That's the conversation you're in."))
            return
        info = await asyncio.to_thread(past.exists, sid, None, get_info=self.get_info)
        if info is None:
            self._toast(self._say("That conversation isn't there any more."))
            return
        title = self._title_of(sid, info) or "…"
        last = int(getattr(info, "last_modified", 0) or 0)
        when = _day(datetime.fromtimestamp(last / 1000), hub.language) if last else ""
        question = self._say(
            "Carry on the conversation “{title}” from {when}?", title=title, when=when
        )
        detail = self._say(
            "The conversation you're in now ends here; it stays in Past conversations."
        )
        choice = await hub.request_approval(
            question, detail, [("allow", "Carry on"), ("deny", "Not now")]
        )
        if choice != "allow":
            return
        async with hub._lock:  # after the request being answered, never in the middle of it
            was, reads = hub._session_id, hub._session_reads
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            try:
                await hub._connect(resume=sid)
            except Exception:
                log.warning("conversation: couldn't reopen a past one", exc_info=True)
                with contextlib.suppress(Exception):
                    await hub.client.disconnect()
                with contextlib.suppress(Exception):
                    await hub._connect(resume=was)
                    hub._session_reads = reads
                self._toast(
                    self._say(
                        "That conversation couldn't be carried on, so you're still in this one."
                    )
                )
                return
            hub._session_id = sid
            hub._session_reads = self.state.reads_of(sid)
            hub.turn = {}
            self._title = self.state.titles().get(sid, "")
            await self._show_carried_on(
                sid,
                info,
                self._say("Carrying on “{title}”.", title=title),
                "the user reopened this earlier conversation",
            )
            self.state.current = sid
            self._save_soon()
        hub.emit("history", items=list(hub.history))
        hub.emit("turn", rid="", user="")
        self.emit()

    # ── past conversations, for the window ──

    async def list_past(self, msg: dict[str, Any]) -> None:
        hub = self.hub
        query = " ".join(str(msg.get("q") or "").split())[:200]
        items = await asyncio.to_thread(
            past.listing, None, self.state.titles(), list_sessions=self.list_sessions
        )
        if query:
            try:
                hits = await asyncio.to_thread(
                    hub.kb.search, query, BRAIN_HITS, sources=["conversations"]
                )
            except Exception:  # the brain's index is being rebuilt: titles alone
                hits = []
            items = past.matching(items, query, _brain_ids(hits))
        current = hub._session_id
        shown = []
        for item in items[:LISTED]:
            sid = item["session_id"]
            shown.append({**item, "current": sid == current, "cost": self.state.cost_of(sid)})
        hub.emit("conversation_list", q=query, seq=str(msg.get("seq") or "")[:40], items=shown)

    async def open_past(self, msg: dict[str, Any]) -> None:
        hub = self.hub
        sid = valid_id(msg.get("session_id"))
        if not sid:
            return
        entries = await asyncio.to_thread(past.entries, sid, None, get_messages=self.get_messages)
        hub.emit(
            "conversation_transcript",
            session_id=sid,
            title=self.state.titles().get(sid, ""),
            current=sid == hub._session_id,
            entries=entries or [],
            error="" if entries is not None else "unreadable",
        )

    # ── the conversation as it goes ──

    def on_connect(self, options: Any, resume: str) -> None:
        self._conn_total = None  # a new connection reports its own running total
        hub = self.hub
        if hub.incognito:
            # No record, no memory writes; a reconnect has nothing to resume, and Claude
            # hears that what came before is gone. Nothing of it touches the record.
            if incognito.apply(options):
                hub._add_style_note(incognito.LOST)
            self._apply_thinking(options)
            return
        self._apply_thinking(options)
        if resume or self._reconnecting:
            return
        # A new conversation ("New conversation", or one that wouldn't carry on).
        self._title = ""
        if self.resumed is not None:
            self.resumed = None
            self.emit()
        if self.state.current:
            self.state.current = ""
            self._save_soon()

    async def on_query(self, text: str, _rid: str) -> None:
        if not self._title:
            self._title = text or str(self.hub.turn.get("user") or "")
        if self.resumed is not None:  # a new turn: the note has done its work
            self.resumed = None
            self.emit()
        await self._think(text)

    # ── thinking ──

    def _apply_thinking(self, options: Any) -> None:
        """A connect's thinking: hard for a request that asked for it, else the Settings
        level; as brain.build_options has it (off) when neither, or on the fallback model."""
        hub = self.hub
        self._hard_connected = False
        if hub._connected_ref:
            return
        level = hub.prefs.feature(THINKING_PREF)
        if self._hard:
            options.thinking = {"type": "adaptive"}
            options.effort = "max" if level == "high" else "high"
            self._hard_connected = True
        elif level in ("low", "medium", "high"):
            options.thinking = {"type": "adaptive"}
            options.effort = level

    async def _reconnect(self) -> None:
        """Make the conversation's connection again, carrying the conversation on (the
        caller holds the hub's lock). What it has read stays weighed by the gates: before
        its first reply a conversation has no session to resume, and a connect without one
        would count as a new conversation that had read nothing."""
        hub = self.hub
        reads = hub._session_reads
        self._reconnecting = True
        try:
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            await hub._connect(resume=hub._session_id)
        finally:
            self._reconnecting = False
            hub._session_reads = reads

    async def _think(self, text: str) -> None:
        """This request asked to think hard (or the one before did): the connection made
        again to suit it. Never on the fallback model. text is "" for a routine's or the
        briefing's request: only the owner's own words ask for this."""
        hub = self.hub
        want = (
            bool(text)
            and asks_for_thought(text, hub.language)
            and not hub._connected_ref
            and not hub.incognito
        )
        self._hard = want
        if want != self._hard_connected and hub.client is not None:
            await self._reconnect()
        self._hard_turn = want and self._hard_connected
        if self._hard_turn:
            hub._speak(self._say("Let me think that through."))
            self.emit()

    async def _think_less(self) -> None:
        """After a request that thought hard: the everyday connection again, between
        requests (the next request checks too, should this not have run by then), and how
        full the conversation is, asked of the new connection."""
        hub = self.hub
        async with hub._lock:
            if self._hard_connected and not self._hard and hub.client is not None:
                try:
                    await self._reconnect()
                except Exception:
                    log.warning("conversation: couldn't switch thinking back", exc_info=True)
        self.emit()
        await self.context()

    async def set_thinking(self, msg: dict[str, Any]) -> None:
        """Settings' thinking level: kept, and the connection made again with it, between
        requests (while incognito, from its next conversation: a connection made again
        would lose it)."""
        hub = self.hub
        level = str(msg.get("level") or "")
        if level not in THINKING_LEVELS:
            return
        changed = hub.set_feature_prefs({THINKING_PREF: level})
        if changed and hub.client is not None and not hub.incognito:
            async with hub._lock:
                try:
                    await self._reconnect()
                except Exception:
                    log.warning("conversation: couldn't apply thinking", exc_info=True)
        self.emit()

    def on_message(self, message: Any) -> None:
        if isinstance(message, ResultMessage):
            self._turn_over(message)
            if self._hard_turn:  # back to everyday thinking, then how full it is
                self._hard_turn = self._hard = False
                self._spawn(self._think_less())
            else:
                self._spawn(self.context())
        elif isinstance(message, SystemMessage) and message.subtype == "compact_boundary":
            self._summed_up(message.data or {})

    def _summed_up(self, data: dict[str, Any]) -> None:
        """Claude Code summed up the conversation to make room (compact_boundary): a note in
        it, shown once the turn is over (mid-turn, the window's list is the turn's own)."""
        meta = (
            data.get("compact_metadata") if isinstance(data.get("compact_metadata"), dict) else {}
        )
        note = self._say(
            "Summed up the conversation to make room, as you asked."
            if meta.get("trigger") == "manual"
            else "Summed up the earlier conversation to make room."
        )
        self.hub.history.append({"role": "note", "text": note, "at": _now()})
        self._spawn(self._history_after_turn())

    async def _history_after_turn(self) -> None:
        async with self.hub._lock:
            pass
        self.hub.emit("history", items=list(self.hub.history))

    # ── how full it is ──

    async def context(self, _msg: Any = None) -> None:
        """How full the conversation's context is, and what it has cost, for the window."""
        hub = self.hub
        client = hub.client
        payload: dict[str, Any] = {"available": False}
        if client is not None and hasattr(client, "get_context_usage"):
            try:
                usage = await client.get_context_usage()
            except Exception:  # between connects, or an older Claude Code
                usage = None
            if isinstance(usage, dict):
                model = getattr(getattr(client, "options", None), "model", None)
                payload = {"available": True, **shape_context(usage, model)}
        payload["cost"] = round(self._cost(), 4)
        payload["compacting"] = self.compacting
        hub.emit("conversation_context", **payload)

    async def compact(self, _msg: Any = None) -> None:
        """Sum the conversation up now to make room (Claude Code's /compact), between
        requests: nothing is said or shown but the note it leaves."""
        hub = self.hub
        if self.compacting or hub.client is None or not hub._session_id:
            return  # already under way, not connected, or nothing said yet
        self.compacting = True
        await self.context()
        try:
            async with hub._lock:
                hub.set_state("thinking")
                try:
                    await hub.client.query("/compact")
                    async for message in hub.client.receive_response():
                        self.on_message(message)
                finally:
                    hub.set_state("idle")
        except Exception:
            log.warning("conversation: /compact failed", exc_info=True)
            self._toast(self._say("Couldn't make room just now; try again in a moment."))
        finally:
            self.compacting = False
        await self.context()

    # ── incognito ──

    async def set_incognito(self, msg: dict[str, Any]) -> None:
        """The window's switch (between requests)."""
        hub = self.hub
        wanted = msg.get("on") is True
        async with hub._lock:
            if wanted == hub.incognito:
                return
            try:
                await (self._go_incognito() if wanted else self._leave_incognito())
            except Exception:
                log.warning("conversation: couldn't change incognito", exc_info=True)
                self._toast(self._say(FAILED[wanted]))
            hub.turn = {}
        hub.emit("turn", rid="", user="")
        self._show_changed()

    async def instant(self, text: str) -> str | None:
        """ "Go incognito", "leave incognito" (and the Chinese), done at once without Claude.
        It runs inside the request's turn: the hub's lock is held."""
        hub = self.hub
        wanted = incognito.asked(text, hub.language)
        if wanted is None:
            return None
        if wanted == hub.incognito:
            return self._say("We're already incognito." if wanted else "We weren't incognito.")
        try:
            said = await (self._go_incognito() if wanted else self._leave_incognito())
        except Exception:
            log.warning("conversation: couldn't change incognito", exc_info=True)
            said = self._say(FAILED[wanted])
        self._spawn(self._show_after_turn())
        return said

    async def _go_incognito(self) -> str:
        """A new conversation nothing is kept of (the caller holds the hub's lock). The one
        before is left as it is: still the one to carry on, after this or a restart."""
        hub = self.hub
        before = {
            "session_id": hub._session_id,
            "reads": hub._session_reads,
            "history": list(hub.history),
            "title": self._title,
        }
        hub.incognito, self._before, self._incognito_cost = True, before, 0.0
        self.resumed = None
        with contextlib.suppress(Exception):
            await hub.client.disconnect()
        try:
            await hub._connect()  # on_connect makes it incognito
        except Exception:  # Claude Code wouldn't start it: back to the one before
            hub.incognito, self._before = False, None
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            with contextlib.suppress(Exception):
                await self._back_to(before)
            raise
        hub._session_id, self._title = "", ""
        hub.history.clear()
        note = self._say("Incognito: nothing from here on is kept.")
        hub.history.append({"role": "note", "text": note, "at": _now()})
        self.emit()
        return self._say("Incognito: nothing from this conversation is kept.")

    async def _leave_incognito(self) -> str:
        """Back to the conversation from before (the caller holds the hub's lock), or a new
        one when it can't be carried on. Nothing of the incognito one is kept, on screen
        either."""
        hub = self.hub
        before = self._before or {}
        hub.incognito, self._before, self._incognito_cost = False, None, 0.0
        with contextlib.suppress(Exception):
            await hub.client.disconnect()
        back = await self._back_to(before)
        hub.history.clear()
        if back:
            hub.history.extend(before.get("history") or [])
            said = self._say("Back to your conversation. Nothing from the incognito one was kept.")
        else:
            said = self._say("Nothing from the incognito conversation was kept.")
        hub.history.append({"role": "note", "text": said, "at": _now()})
        self.emit()
        return said

    async def _back_to(self, before: dict[str, Any]) -> bool:
        """Connect to the conversation from before incognito: True when it carried on; a
        new conversation when there was none, or its record is gone."""
        hub = self.hub
        sid = valid_id(before.get("session_id"))
        info = None
        if sid:
            info = await asyncio.to_thread(past.exists, sid, None, get_info=self.get_info)
        if info is not None:
            try:
                await hub._connect(resume=sid)
            except Exception:
                log.warning("conversation: couldn't go back after incognito", exc_info=True)
                with contextlib.suppress(Exception):
                    await hub.client.disconnect()
            else:
                hub._session_id = sid
                hub._session_reads = before.get("reads") or self.state.reads_of(sid)
                self._title = before.get("title") or self.state.titles().get(sid, "")
                return True
        await hub._connect()  # a new conversation: on_connect forgets the one to carry on
        hub._session_id = ""
        return False

    def _heard_edit(self, _msg: dict[str, Any]) -> Any:
        """A transcript fixed in the window: while incognito it teaches nothing (taken
        here); otherwise the hub's own heard_edit learns from it."""
        return None if self.hub.incognito else False

    async def _show_after_turn(self) -> None:
        async with self.hub._lock:
            pass
        self._show_changed()

    def _show_changed(self) -> None:
        """Incognito came or went: the window's conversation list, the banner, the meter."""
        self.hub.emit("history", items=list(self.hub.history))
        self.emit()
        self._spawn(self.context())

    def _turn_cost(self, sid: str, total: float | None) -> float:
        """This turn's cost. Claude Code reports a running total per connection (after a
        resume, one that starts from the session's earlier total)."""
        if total is None:
            return 0.0
        before = self.state.cost_of(sid)
        if self._conn_total is None:
            turn = total - before if total >= before else total
        else:
            turn = max(0.0, total - self._conn_total)
        self._conn_total = total
        return max(0.0, turn)

    def _turn_over(self, message: ResultMessage) -> None:
        hub = self.hub
        sid = valid_id(message.session_id)
        if not sid:
            return
        cost = self._turn_cost(sid, message.total_cost_usd)
        if hub.incognito:  # nothing of it is kept: what it cost is shown, from memory
            self._incognito_cost += cost
            return
        reads = clean_reads(hub._session_reads) or {}
        self.state.turn_over(sid, reads, cost, title=self._title)
        self._title = self.state.titles().get(sid, "") or self._title
        self._save_soon()

    # ── the window ──

    def _cost(self) -> float:
        """What the conversation has cost so far."""
        if self.hub.incognito:
            return self._incognito_cost
        sid = self.hub._session_id
        return self.state.cost_of(sid) if sid else 0.0

    def public(self) -> dict[str, Any]:
        hub = self.hub
        sid = hub._session_id
        return {
            "resume": bool(hub.prefs.feature(RESUME_PREF)),
            "resumed": self.resumed,
            "thinking": hub.prefs.feature(THINKING_PREF),
            "thinking_hard": self._hard_turn,
            "incognito": hub.incognito,
            "session_id": sid,
            "title": self.state.titles().get(sid, "") if sid and not hub.incognito else "",
            "cost": self._cost(),
        }

    def emit(self) -> None:
        self.hub.emit("conversation", **self.public())

    def install(self) -> None:
        hub = self.hub
        hub.conversation = self
        hub.first_connect = self.first_connect
        hub.add_connect_hook(self.on_connect)
        hub.add_query_hook(self.on_query)
        hub.add_message_sink(self.on_message)

        def later(work: Any) -> Any:
            """A command whose work reads files or waits on a card runs in the background:
            the window's socket reads one command at a time."""
            return lambda msg: self._spawn(work(msg)) and None

        hub.register_command("conversation_state", lambda _msg: self.emit())
        hub.register_command("conversation_context", later(self.context))
        hub.register_command("conversation_compact", later(self.compact))
        hub.register_command("conversation_thinking", later(self.set_thinking))
        hub.register_command("conversation_list", later(self.list_past))
        hub.register_command("conversation_open", later(self.open_past))
        hub.register_command(
            "conversation_resume", later(lambda msg: self.reopen(str(msg.get("session_id") or "")))
        )
        hub.register_command("conversation_incognito", later(self.set_incognito))
        hub.register_command("heard_edit", self._heard_edit)
        hub.register_instant(self.instant)


def install(hub: Any) -> None:
    Conversation(hub).install()
