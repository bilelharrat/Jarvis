"""Rewind and branches for JARVIS's own conversation (not Jarvis Code's sessions, which have
their own in tasks.py): going back to an earlier message, branching off, and editing a request.

- Rewind: the conversation carries on from just before one of the owner's messages, so it and
  everything after leave Claude's context. It's a new Claude Code session resumed at that point
  (the SDK's resume, fork_session and resume_session_at, as Jarvis Code forks), so the version
  from before stays whole in Past conversations. From the window (Conversations › This
  conversation › a message › Rewind to before this) or by voice ("go back to before I asked
  about the flights", 回到我问机票之前). A card asks first, and says what a rewind doesn't do:
  nothing done in the world is undone, what was remembered stays, the action log keeps
  everything. When the dropped turns did things JARVIS can undo (undo.py's, within its half
  hour), the card lists them and offers "Rewind and undo those".
- Fork: a parallel conversation from a chosen message (or from here: all of it), the original
  kept as it is ("branch from here", 从这里分支; the window's Branch buttons, on this or a past
  conversation). "Try that differently" (换个思路再试一次) branches from just before the last
  request and asks it again there, the first answer kept in the original. Words that weren't
  the owner's own (a jarvis:// link's, a forwarded message, a routine's) go again as they
  first went, someone else's to every gate; so does a request heard before a restart, as
  Claude Code's record doesn't say who wrote it.
- Edit and resend: rewind to before a request and send the edited words (the window's Edit).
- The branch is the source's session id until Claude Code gives the branch its own, at its
  first turn's end; until then every connect carries the source on up to the point (a restart
  too: it's kept in conversation.json), and the window shows it that far. Its first turn's id
  is kept with where it came from ("Branched from “…”" in Past conversations).
- Incognito: an incognito conversation keeps no record, so it can't be rewound or branched
  (nothing of it can become a kept conversation), and a past one isn't branched while
  incognito. The turn gate's record of what was read goes with the branch (a rewind keeps the
  conversation's; a fork, its source's): a branch never opens the gates wider.

Window commands: conversation_rewind {session_id, uuid}, conversation_edit {session_id, uuid,
text}, conversation_fork {session_id, uuid ("" for all of it), live}. Events: the
conversation's own (history, conversation, turn), and a toast.

Claude cost policy: nothing here calls a model on its own. A branch is the conversation's own
model carrying on, when the owner next speaks; "try that differently" and an edited request
are one request each, of the conversation's model, asked by the owner (no cap beyond the
conversation's own). No background calls.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from datetime import datetime
from typing import Any

from claude_agent_sdk import ResultMessage

from .. import conversation_past as past
from .. import incognito, lang
from ..conversation_state import valid_id

log = logging.getLogger("jarvis")

TURNS_KEPT = 200  # requests remembered with their session (for the undo offer)
EDIT_CHARS = 8000
SHOWN = 20  # a branch's last lines, shown in the window
UNDO_LISTED = 4  # actions named on the card

ZH = {
    "Rewind to before “{words}”?": "要回到“{words}”之前吗？",
    "Rewind to before “{words}” and send your edited request?": "要回到“{words}”之前，再发出改好的请求吗？",
    "Everything said from there on leaves my context; the conversation as it is now stays in "
    "Past conversations. Rewinding doesn't undo anything I did, what I remembered stays "
    "remembered, and the action log keeps everything.": (
        "从那里开始说过的内容都会离开我的上下文；现在这段对话会原样留在“过去的对话”里。"
        "回退不会撤销我做过的任何事，记住的内容也还记着，操作记录全部保留。"
    ),
    " I can still undo these from those turns: {labels}.": "那几轮里这些还能撤销：{labels}。",
    "Rewound to before “{words}”. Nothing I did was undone and what I remembered stays; the "
    "earlier version is in Past conversations.": (
        "已回到“{words}”之前。我做过的事都没有撤销，记住的内容也还在；之前的版本在“过去的对话”里。"
    ),
    "Branched from “{title}”; the original stays as it was in Past conversations.": (
        "已从“{title}”分出一个分支；原来的对话原样留在“过去的对话”里。"
    ),
    "Started afresh from before the first message; the original stays in Past conversations.": (
        "已从第一句之前重新开始；原来的对话留在“过去的对话”里。"
    ),
    "Trying that again in a new branch; the first answer stays in the original.": (
        "在新分支里换个思路再试一次；第一个回答留在原来的对话里。"
    ),
    "An incognito conversation keeps no record, so it can't be rewound or branched.": (
        "无痕对话不留记录，所以没法回退或分支。"
    ),
    "Leave incognito to branch a past conversation.": "先退出无痕模式，才能从过去的对话分支。",
    "There's nothing to go back to yet.": "还没有可以回去的地方。",
    "I couldn't find where you asked about that in this conversation.": (
        "在这段对话里没找到你问这件事的地方。"
    ),
    "That message isn't in this conversation any more.": "那条消息已经不在这段对话里了。",
    "The conversation changed while you were deciding, so nothing was rewound.": (
        "你决定的时候对话变了，所以没有回退。"
    ),
    "Not rewound.": "没有回退。",
    "Couldn't rewind just now, so you're still where you were.": "现在没能回退，所以还在原来的地方。",
    "Couldn't branch just now, so you're still where you were.": "现在没能分支，所以还在原来的地方。",
    "Undid: {labels}.": "已撤销：{labels}。",
    " Couldn't undo: {labels}.": "没能撤销：{labels}。",
    "Rewind": "回退",
    "Rewind and undo those": "回退并撤销这些",
    "Rewind and send": "回退并发送",
    "Rewind, undo those and send": "回退、撤销这些并发送",
    "Not now": "暂不",
    "Conversations": "对话",
}
lang.add_texts(ZH)

# "Go back to before I asked about the flights", "rewind to before the Lisbon question".
_ABOUT = r"(?:(?:i|we)\s+(?:asked|talked|spoke|said\s+something|was\s+asking)(?:\s+you)?\s+(?:about\s+)?)?"
REWIND = re.compile(
    incognito._LEAD
    + r"(?:go\s+back|rewind(?:\s+(?:the|this|our)\s+conversation)?|take\s+(?:us|me|it)\s+back)"
    + r"\s+to\s+(?:just\s+)?before\s+"
    + _ABOUT
    + r"(?P<about>.+?)"
    + incognito._END,
    re.IGNORECASE,
)
# 回到我问机票之前, 退回到我们聊里斯本之前.
REWIND_ZH = lang.LazyPattern(
    incognito._LEAD_ZH
    + r"(?:回到|退回到?|倒回到?|回退到)(?:我们?|咱们)?(?:问|聊|说|提到|谈到|讲)?(?:了|过)?"
    + r"(?:关于)?(?P<about>.+?)(?:的(?:时候|事))?之前"
    + incognito._END_ZH,
    re.IGNORECASE,
)
# "Branch from here", "fork the conversation", "start a branch here".
BRANCH = incognito._command(
    r"(?:branch|fork)(?:\s+(?:the|this|our)\s+conversation)?(?:\s+(?:off\s+)?(?:from\s+)?here)?",
    r"(?:start|make|open)\s+a\s+(?:new\s+)?branch(?:\s+(?:from\s+)?here)?",
)
BRANCH_ZH = lang.LazyPattern(
    incognito._LEAD_ZH
    + r"(?:从这里|在这里|从这儿)?(?:开(?:一?个)?|分出(?:一?个)?|新建(?:一?个)?)?分支(?:对话)?"
    + incognito._END_ZH,
    re.IGNORECASE,
)
# "Try that differently", "try that again a different way", "give me a different take".
TRY_AGAIN = incognito._command(
    r"try\s+(?:that|this|it)\s+(?:again\s+)?(?:differently|another\s+way|a\s+different\s+way)",
    r"try\s+again\s+(?:differently|another\s+way|a\s+different\s+way)",
    r"(?:give\s+me|try)\s+a\s+different\s+(?:take|answer|approach)(?:\s+on\s+(?:that|this))?",
)
TRY_AGAIN_ZH = lang.LazyPattern(
    incognito._LEAD_ZH
    + r"(?:换(?:个|一个|种|一种)(?:思路|方式|方法|说法|角度)(?:再)?(?:试(?:一)?(?:次|下)|来(?:一次)?|答(?:一次)?))"
    + incognito._END_ZH,
    re.IGNORECASE,
)
TRY_AGAIN_NOTE = (
    "the user asked you to try this request again a different way, in a branch of the "
    "conversation that leaves your first answer out: take another approach than the obvious one"
)
# How approval cards name a request tried again that isn't known to be the owner's own words
# (a link's or a forwarded message's, a routine's, one from before a restart).
AGAIN_WORDS = "a request tried again that may not be in your own words"
# Words of "before I asked about …" that don't say which message.
_FILLER = frozenset(
    "the a an my your our about that this it when where what you i we me us asked question "
    "thing stuff part bit one".split()
)


def _norm(text: str) -> str:
    return " ".join(str(text or "").split()).casefold()


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"\w+", _norm(text)) if w not in _FILLER]


def _short(text: str, n: int = 80) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def find_request(entries: list[dict[str, Any]], about: str) -> dict[str, Any] | None:
    """The newest of the owner's requests that's about those words (each word, or its
    first letters, in it; Chinese: the words as a part of it)."""
    asked = [e for e in entries if e.get("role") == "user" and e.get("uuid")]
    words = _words(about)
    if not words:
        return None
    for entry in reversed(asked):
        text = _norm(entry["text"])
        said = re.findall(r"\w+", text)
        if all(
            w in text if not w.isascii() else any(s.startswith(w[:5]) for s in said) for w in words
        ):
            return entry
    return None


class Branching:
    """Rewind, fork and edit-and-resend on one hub (hub.branching)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._turns: list[dict[str, Any]] = []  # {sid, turn, text, open}: requests to Claude
        self._switching = False  # a connect of this feature's own

    @property
    def convo(self) -> Any:
        return self.hub.conversation

    def _say(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def _toast(self, text: str) -> None:
        self.hub.emit("toast", title=self._say("Conversations"), text=text)

    # ── hooks ──

    def on_connect(self, options: Any, resume: str) -> None:
        """A branch not yet spoken in: every connect to its source carries the source on up
        to its point, as a new session (fork_session). Another conversation carried on, or
        a new one, leaves it."""
        hub, state = self.hub, self.convo.state
        branch = state.branch
        if not branch or hub.incognito:  # (incognito's connects never carry anything on)
            return
        if resume and resume == branch["source"] and not branch["fresh"]:
            options.fork_session = True
            if branch["at"]:
                options.resume_session_at = branch["at"]
        elif resume or not (self._switching or self.convo._reconnecting):
            state.branch = None
            self.convo._save_soon()

    def on_query(self, text: str, _rid: str) -> None:
        """Each request Claude gets, with the turn it came in (undo.py's count), for the
        actions a rewind would leave behind, and whether it was the owner's own words (text
        is "" for anyone else's: a link's, a forwarded message, a routine's), for Try Again."""
        if self.hub.incognito:
            return
        self._turns.append(
            {
                "sid": "",
                "turn": int(self.hub.commands),
                "text": _norm(text),
                "own": bool(text),
                "open": True,
            }
        )
        del self._turns[:-TURNS_KEPT]

    def on_message(self, message: Any) -> None:
        if not isinstance(message, ResultMessage):
            return
        hub, state = self.hub, self.convo.state
        sid = valid_id(message.session_id)
        if not sid or hub.incognito:
            return
        for turn in self._turns:
            if turn["open"]:
                turn["sid"], turn["open"] = sid, False
        branch = state.branch
        if not branch:
            return
        if branch["fresh"] or sid != branch["source"]:
            state.relate(sid, branch["source"], branch["relation"])
        else:  # Claude Code carried the source on instead of branching it: left as it is
            log.warning("conversation: a branch went on in its source's session")
        state.branch = None
        self.convo._save_soon()
        self.convo.emit()

    # ── reading the points ──

    async def _entries(self, sid: str, live: bool) -> list[dict[str, Any]] | None:
        until = self.convo.until(sid) if live else ""
        return await asyncio.to_thread(
            past.entries, sid, None, get_messages=self.convo.get_messages, until=until
        )

    def _live_sid(self) -> str:
        """The session of the conversation under way, "" when it has none to go back in."""
        return "" if self.hub.incognito else self.hub._session_id

    def owner_asked(self, sid: str, text: str) -> bool:
        """The newest of sid's requests was the owner's own words, and these. Claude Code's
        record keeps no say in who wrote a request, so only one heard this run counts: a
        link's or a forwarded message's words, a routine's, and anything from before a
        restart aren't known to be theirs."""
        turns = [t for t in self._turns if t["sid"] == sid and not t["open"]]
        return bool(turns) and turns[-1].get("own") is True and turns[-1]["text"] == _norm(text)

    def dropped_actions(self, sid: str, text: str) -> list[Any]:
        """What JARVIS did in the turns a rewind to before that request leaves behind and
        can still undo (newest first). Turns from before this run aren't known, nor
        undoable: undo is kept in memory for half an hour."""
        actions = getattr(self.hub, "actions", None)
        if actions is None:
            return []
        turns = [t for t in self._turns if t["sid"] == sid and not t["open"]]
        wanted = _norm(text)
        start = next((i for i in range(len(turns) - 1, -1, -1) if turns[i]["text"] == wanted), 0)
        numbers = {t["turn"] for t in turns[start:]}
        return [a for a in actions.undo.undoable() if a.turn in numbers]

    # ── the card ──

    async def _ask_rewind(
        self, entry: dict[str, Any], dropped: list[Any], edit: bool, spoken: bool = False
    ) -> str:
        """The rewind's card: what it does and doesn't do, and the undo it can offer.
        "allow", "undo" (rewind and undo those) or "deny"."""
        hub = self.hub
        text = _short(entry["text"])
        question = self._say(
            "Rewind to before “{words}” and send your edited request?"
            if edit
            else "Rewind to before “{words}”?",
            words=text,
        )
        detail = self._say(
            "Everything said from there on leaves my context; the conversation as it is now "
            "stays in Past conversations. Rewinding doesn't undo anything I did, what I "
            "remembered stays remembered, and the action log keeps everything."
        )
        choices = [("allow", "Rewind and send" if edit else "Rewind")]
        if dropped:
            labels = "; ".join(a.label for a in dropped[:UNDO_LISTED])
            detail += self._say(
                " I can still undo these from those turns: {labels}.", labels=labels
            )
            choices.append(
                ("undo", "Rewind, undo those and send" if edit else "Rewind and undo those")
            )
        choices.append(("deny", "Not now"))
        if spoken:  # asked by voice: said too, so it can be answered by voice
            hub._say(question)
        choice = await hub.request_approval(question, detail, choices)
        return choice.split(":", 1)[0]

    # ── doing it (the hub's lock held) ──

    async def _switch(
        self,
        source: str,
        at: str,
        relation: str,
        kept: list[dict[str, Any]],
        note: str,
        claude_note: str,
        reads: dict[str, Any],
    ) -> bool:
        """Connect to the branch: source carried on up to at (its message id; "" for all of
        it; "-" for before its first message: a new conversation). kept: the lines of it the
        window shows. False when it couldn't, the conversation as it was."""
        hub, convo, state = self.hub, self.convo, self.convo.state
        fresh = at == "-"
        at = "" if fresh else at
        was, was_reads, was_branch = hub._session_id, hub._session_reads, state.branch
        title = state.titles().get(source, "")
        self._switching = True
        try:
            with contextlib.suppress(Exception):
                await hub.client.disconnect()
            try:
                if fresh:
                    await hub._connect()
                else:
                    state.branch = {
                        "source": source,
                        "at": at,
                        "relation": relation,
                        "fresh": False,
                    }
                    await hub._connect(resume=source)
            except Exception:
                log.warning("conversation: couldn't branch", exc_info=True)
                state.branch = was_branch
                with contextlib.suppress(Exception):
                    await hub.client.disconnect()
                with contextlib.suppress(Exception):
                    await hub._connect(resume=was)
                hub._session_id, hub._session_reads = was, was_reads
                return False
        finally:
            self._switching = False
        if fresh:
            state.branch = {"source": source, "at": "", "relation": relation, "fresh": True}
            hub._session_id, convo._title, convo.cost_base = "", "", None
        else:
            hub._session_id, hub._session_reads = source, reads
            convo._title, convo.cost_base = title, state.cost_of(source)
            state.current = source  # carried on after a restart until the branch speaks
        convo.resumed = None
        hub.turn = {}
        hub.history.clear()
        for line in kept[-SHOWN:]:
            hub.history.append({"role": line["role"], "text": line["text"], "at": ""})
        hub.history.append(
            {"role": "note", "text": note, "at": datetime.now().isoformat(timespec="seconds")}
        )
        if not fresh:
            hub._add_style_note(claude_note)
        convo._save_soon()
        return True

    async def rewind_locked(
        self, sid: str, entry: dict[str, Any], entries: list[dict[str, Any]], undo: bool
    ) -> tuple[bool, str]:
        """Rewind the conversation under way to before entry (the hub's lock held): whether
        it did, and what's said about it."""
        hub = self.hub
        if self._live_sid() != sid:
            return False, self._say(
                "The conversation changed while you were deciding, so nothing was rewound."
            )
        index = entries.index(entry)
        text = _short(entry["text"])
        note = self._say(
            "Rewound to before “{words}”. Nothing I did was undone and what I remembered "
            "stays; the earlier version is in Past conversations.",
            words=text,
        )
        dropped = self.dropped_actions(sid, entry["text"]) if undo else []
        ok = await self._switch(
            sid,
            entry.get("before") or "-",
            "rewind",
            entries[:index],
            note,
            f"the user rewound this conversation to just before their message “{text}”: that "
            "message and everything after it are gone from your context. Nothing done in the "
            "world was undone and anything remembered is still remembered",
            hub._session_reads,
        )
        if not ok:
            return False, self._say("Couldn't rewind just now, so you're still where you were.")
        said = note
        if dropped:
            done, failed = [], []
            for action in dropped:
                await hub.actions.undo_now(action)
                (done if action.undone else failed).append(action.label)
            if done:
                said += " " + self._say("Undid: {labels}.", labels="; ".join(done))
            if failed:
                said += self._say(" Couldn't undo: {labels}.", labels="; ".join(failed))
        return True, said

    async def fork_locked(
        self, sid: str, entry: dict[str, Any] | None, entries: list[dict[str, Any]], live: bool
    ) -> tuple[bool, str]:
        """A branch of sid from before entry (None: all of it), the original kept (the
        hub's lock held): whether it was made, and what's said about it."""
        hub, state = self.hub, self.convo.state
        if hub.incognito:  # gone incognito while it waited: nothing is branched into it
            return False, self._say(
                "An incognito conversation keeps no record, so it can't be rewound or branched."
                if live
                else "Leave incognito to branch a past conversation."
            )
        title = state.titles().get(sid, "") or next(
            (e["text"] for e in entries if e.get("role") == "user"), ""
        )
        if entry is None:
            at = self.convo.until(sid) if live else ""
            kept = entries
            if not at:  # all of it: up to its last message, as the record has it now
                at = await asyncio.to_thread(self._last_uuid, sid)
        else:
            at = entry.get("before") or "-"  # "-": before its first message, a new one
            kept = entries[: entries.index(entry)]
        fresh = at == "-"
        note = (
            self._say(
                "Started afresh from before the first message; the original stays in Past "
                "conversations."
            )
            if fresh
            else self._say(
                "Branched from “{title}”; the original stays as it was in Past conversations.",
                title=_short(title) or "…",
            )
        )
        reads = hub._session_reads if sid == hub._session_id else state.reads_of(sid)
        ok = await self._switch(
            sid,
            at,
            "fork",
            kept,
            note,
            "the user branched this conversation off from an earlier point of another one; the "
            "original carries on separately, and what came after that point isn't in your "
            "context. Nothing done in the world was undone",
            reads,
        )
        if not ok:
            return False, self._say("Couldn't branch just now, so you're still where you were.")
        return True, note

    def _last_uuid(self, sid: str) -> str:
        try:
            messages = self.convo.get_messages(sid, directory=str(past.workspace()))
        except Exception:
            return ""
        ids = [str(getattr(m, "uuid", "") or "") for m in messages or []]
        return next((u for u in reversed(ids) if u), "")

    def _after(self) -> None:
        """The window shown the branch: its lines, the conversation, the meter."""
        hub = self.hub
        hub.emit("history", items=list(hub.history))
        hub.emit("turn", rid="", user="")
        self.convo.emit()
        self.convo._spawn(self.convo.context())

    async def _after_turn(self, then: Any = None) -> None:
        """Once the request under way is over: the window shown the branch, then (then) a
        request asked in it."""
        async with self.hub._lock:
            pass
        self._after()
        if then is not None:
            await then

    # ── the window ──

    async def _point(self, msg: dict[str, Any], live: bool) -> tuple[str, list, dict | None]:
        sid = valid_id(msg.get("session_id"))
        if not sid:
            return "", [], None
        entries = await self._entries(sid, live) or []
        uid = valid_id(msg.get("uuid"))
        entry = next((e for e in entries if e.get("uuid") == uid and uid), None)
        return sid, entries, entry

    async def rewind_command(self, msg: dict[str, Any], edit: str = "") -> None:
        """Rewind to before a message of the conversation under way (and send edit: an
        edited request), after the card."""
        hub = self.hub
        if hub.incognito:
            self._toast(
                self._say(
                    "An incognito conversation keeps no record, so it can't be rewound or branched."
                )
            )
            return
        sid, entries, entry = await self._point(msg, True)
        if not sid or sid != self._live_sid():
            return
        if entry is None:
            self._toast(self._say("That message isn't in this conversation any more."))
            return
        choice = await self._ask_rewind(entry, self.dropped_actions(sid, entry["text"]), bool(edit))
        if choice not in ("allow", "undo"):
            return
        async with hub._lock:  # between requests, never in the middle of one
            ok, said = await self.rewind_locked(sid, entry, entries, choice == "undo")
        self._after()
        self._toast(said)
        if ok and edit:  # the owner's own edited words, as though typed now
            await hub.ask(edit)

    async def edit_command(self, msg: dict[str, Any]) -> None:
        text = str(msg.get("text") or "").strip()[:EDIT_CHARS]
        if text:
            await self.rewind_command(msg, edit=text)

    async def fork_command(self, msg: dict[str, Any]) -> None:
        """A branch of this or a past conversation, from before a message or all of it."""
        hub = self.hub
        if hub.incognito:
            live = msg.get("live") is True
            self._toast(
                self._say(
                    "An incognito conversation keeps no record, so it can't be rewound or branched."
                    if live
                    else "Leave incognito to branch a past conversation."
                )
            )
            return
        live = msg.get("live") is True and valid_id(msg.get("session_id")) == self._live_sid()
        sid, entries, entry = await self._point(msg, live)
        if not sid or not entries:
            return
        if msg.get("uuid") and entry is None:
            self._toast(self._say("That message isn't in this conversation any more."))
            return
        async with hub._lock:
            _ok, said = await self.fork_locked(sid, entry, entries, live)
        self._after()
        self._toast(said)

    # ── by voice (inside the request's turn: the hub's lock is held) ──

    async def instant(self, text: str) -> str | None:
        hub = self.hub
        zh = lang.is_zh(hub.language)
        clean = " ".join(text.split())
        rewind = REWIND.match(clean) or (zh and REWIND_ZH.match(clean)) or None
        branch = bool(BRANCH.match(clean) or (zh and BRANCH_ZH.match(clean)))
        again = bool(TRY_AGAIN.match(clean) or (zh and TRY_AGAIN_ZH.match(clean)))
        if not (rewind or branch or again):
            return None
        if hub.incognito:
            return self._say(
                "An incognito conversation keeps no record, so it can't be rewound or branched."
            )
        sid = self._live_sid()
        entries = (await self._entries(sid, True) or []) if sid else []
        asked = [e for e in entries if e.get("role") == "user" and e.get("uuid")]
        if not asked:
            return self._say("There's nothing to go back to yet.")
        if rewind:
            entry = find_request(entries, rewind.group("about"))
            if entry is None:
                return self._say("I couldn't find where you asked about that in this conversation.")
            dropped = self.dropped_actions(sid, entry["text"])
            choice = await self._ask_rewind(entry, dropped, False, spoken=True)
            if choice not in ("allow", "undo"):
                return self._say("Not rewound.")
            _ok, said = await self.rewind_locked(sid, entry, entries, choice == "undo")
            self.convo._spawn(self._after_turn())
            return said
        if branch:
            _ok, said = await self.fork_locked(sid, None, entries, True)
            self.convo._spawn(self._after_turn())
            return said
        last = asked[-1]
        words = last["text"]
        own = self.owner_asked(sid, words)
        ok, said = await self.fork_locked(sid, last, entries, True)
        if not ok:
            return said
        if own:
            again = hub.ask(words, note=TRY_AGAIN_NOTE)
        else:
            # Words not known to be the owner's stay so when tried again: shown as they are,
            # never the owner's to the gates (no instant command, nothing counts as them
            # asking to remember, forget or change a routine), outside content read.
            again = hub.ask(words, display=words, untrusted=AGAIN_WORDS, note=TRY_AGAIN_NOTE)
        self.convo._spawn(self._after_turn(again))
        return self._say(
            "Trying that again in a new branch; the first answer stays in the original."
        )

    def install(self) -> None:
        hub = self.hub
        hub.branching = self
        hub.add_connect_hook(self.on_connect)
        hub.add_query_hook(self.on_query)
        hub.add_message_sink(self.on_message)

        def later(work: Any) -> Any:
            return lambda msg: self.convo._spawn(work(msg)) and None

        hub.register_command("conversation_rewind", later(self.rewind_command))
        hub.register_command("conversation_edit", later(self.edit_command))
        hub.register_command("conversation_fork", later(self.fork_command))
        hub.register_instant(self.instant)


def install(hub: Any) -> None:
    if getattr(hub, "conversation", None) is None:  # the conversation feature is left out
        return
    Branching(hub).install()
