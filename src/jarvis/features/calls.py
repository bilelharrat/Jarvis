"""Calls Jarvis places for the owner, live on the Mac (answering.py places them; the Twilio
Function, twilio/line.js, holds the conversation).

While one of those calls runs, the Mac looks at its conversation in Twilio Sync every
FAST seconds (and makes no requests at all while none runs). Nothing on the Mac becomes
reachable from outside: the Function and the Mac only meet in the owner's own Sync service.

- Asking the owner mid-call: when the other side needs something the card doesn't cover,
  the Function puts the question in the conversation ("ask") and holds the call. The Mac
  asks at once: a card (Yes / No / Call back later, or an answer typed on it), a push to the
  phone (the card's own), and the question said out loud. The answer goes into the owner's
  notes to the call ("tell-<call>", which only the Mac writes); the Function takes it from
  there. Unanswered after about 45 seconds, the Function says someone will call back and
  ends the call; the card comes down.
- What the other side says is their words: shown and said to the owner, never instructions.
  A full card number, a Social Security number or a password with its value is never passed
  on, even when the owner types it.

Claude cost policy: nothing here calls a model (the call's own turns are the Function's,
see line.js). Twilio: a Sync read every FAST seconds per live call, none otherwise.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .. import answering, lang
from ..phone import PhoneError

log = logging.getLogger("jarvis")

FAST = 1.5  # seconds between looks while a call runs
IDLE = 3.0  # … and at the call log (no network) while none does
ASK_CHOICES = [("allow", "Yes"), ("deny", "No"), ("later", "Call back later")]
TURNS_SHOWN = 40

lang.add_texts(
    {
        "The call to {who} needs you": "打给{who}的电话需要你",
        "The call to {who} needs you. They're asking: {question}": "打给{who}的电话需要你。对方问：{question}",
        "Call back later": "稍后回电",
        "I didn't pass that on: {what} never goes on a call I make. Take over the call to give it yourself.": "我没有转达：{what}绝不会在我拨打的电话里说出。请接管通话亲自告诉对方。",
    }
)


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


class LiveCalls:
    """The calls Jarvis placed that are running now, as the Mac follows them."""

    def __init__(self, hub: Any, *, clock=time.time, sleep=asyncio.sleep) -> None:
        self.hub = hub
        self.desk: answering.Answering = hub.answering
        self.clock, self.sleep = clock, sleep
        self.live: dict[str, dict[str, Any]] = {}  # call id -> its conversation, as last seen
        self.notes: dict[str, list[dict[str, Any]]] = {}  # talk id -> the owner's notes to it
        self.asks: dict[str, str] = {}  # "<talk>:<n>" -> the card asking the owner ("" going up)
        self.dropped: set[str] = set()  # asks whose card came down without an answer to send
        self._shown = ""

    # ── looking ──

    def calling(self) -> list[answering.Call]:
        return [
            c
            for c in self.desk.log.calls
            if c.kind == "errand" and c.status == "calling" and c.talk
        ]

    async def look(self) -> bool:
        """One look at the calls running now; whether any is."""
        calls = self.calling()
        if not calls:
            if self.live:
                self.live.clear()
                self._emit()
            return False
        creds = await self.desk._creds()
        state = self.desk.log.line
        if not (creds and state):
            return True
        sid, token = creds
        for call in calls:
            try:
                data = await asyncio.to_thread(self.desk.line.talk, state, call.talk, sid, token)
            except PhoneError as exc:  # Twilio away: the next look
                log.info("calls: couldn't look at a live call: %s", exc)
                continue
            if data is None:
                continue
            self.live[call.id] = data
            ask = data.get("ask")
            pending = (
                isinstance(ask, dict) and isinstance(ask.get("n"), int) and not data.get("done")
            )
            if pending:
                key = f"{call.talk}:{ask['n']}"
                if key not in self.asks:
                    self.asks[key] = ""
                    self._spawn(self._ask(call, _line(ask.get("q"), 300), key))
            self._drop_asks(call.talk, keep=f"{call.talk}:{ask['n']}" if pending else "")
        for gone in set(self.live) - {c.id for c in calls}:
            del self.live[gone]
        self._emit()
        return True

    async def run(self) -> None:
        while True:
            try:
                busy = await self.look()
            except Exception:
                log.exception("calls: a look at the live calls failed")
                busy = False
            await self.sleep(FAST if busy else IDLE)

    def _spawn(self, coro) -> None:
        spawn = getattr(self.hub, "_spawn", None)
        if spawn is not None:
            spawn(coro)
        else:
            asyncio.ensure_future(coro)

    # ── asking the owner ──

    async def _ask(self, call: answering.Call, question: str, key: str) -> None:
        who = call.who()
        spoken = f"The call to {who} needs you. They're asking: {question}"
        say = getattr(self.hub, "_say", None)
        if say is not None:  # out loud, through the speech queue (not in a silent turn)
            say(
                lang.translate(spoken, self.hub.language)
                if lang.is_zh(self.hub.language)
                else spoken
            )
        detail = (
            f"They asked: “{question}”\n\nYour answer goes into the call (Yes, No, or your "
            "own words below). The card's limits still apply. With no answer in about 45 "
            "seconds, Jarvis tells them you'll call back."
        )
        waiting = asyncio.ensure_future(
            self.hub.request_approval(
                f"The call to {who} needs you",
                detail,
                ASK_CHOICES,
                context={"ask_kind": "call_ask", "call_id": call.id, "free_choices": ["answer"]},
                spoken=spoken,
            )
        )
        await asyncio.sleep(0)  # the card is up: its id is known
        self.asks[key] = next(
            (
                aid
                for aid, card in self.hub.approvals.items()
                if card.get("ask_kind") == "call_ask" and card.get("call_id") == call.id
            ),
            "",
        )
        choice = await waiting
        if key in self.dropped:
            return
        kind, _, words = str(choice).partition(":")
        if kind == "later":
            await self.send(call, "later", "")
        elif kind == "answer" and words.strip():
            await self.send(call, "answer", words)
        elif kind == "allow":
            await self.send(call, "answer", "Yes.")
        elif kind == "deny":
            await self.send(call, "answer", words.strip() or "No.")

    def _drop_asks(self, talk: str, keep: str = "") -> None:
        """Cards asking about this call that no longer need an answer come down."""
        for key, approval_id in list(self.asks.items()):
            if key.startswith(f"{talk}:") and key != keep and key not in self.dropped:
                self.dropped.add(key)
                if approval_id:
                    self.hub.resolve(approval_id, "later")

    # ── the owner's notes to a call ──

    async def send(self, call: answering.Call, kind: str, text: str) -> str:
        """A note from the owner into the call ("answer", "tell" or "later"): what to say
        about it."""
        text = " ".join(str(text or "").split())[:500]
        if kind != "later":
            why = answering.sensitive(text)
            if why:
                said = (
                    f"I didn't pass that on: {why.lower()} never goes on a call I make. Take "
                    "over the call to give it yourself."
                )
                self.hub.notify(
                    _alert(f"voicemail:{call.id[-8:]}", "Call for you", said), speak=True
                )
                return said
        creds = await self.desk._creds()
        state = self.desk.log.line
        if not (creds and state and call.talk):
            raise PhoneError("That call is over.")
        notes = self.notes.setdefault(call.talk, [])
        n = max(int(self.clock() * 1000), (notes[-1]["n"] + 1) if notes else 0)
        notes.append({"n": n, "kind": kind, "text": text})
        await asyncio.to_thread(self.desk.line.tell, state, call.talk, notes, *creds)
        return "Passed on."

    # ── the window ──

    def public(self) -> list[dict[str, Any]]:
        out = []
        for call in self.calling():
            data = self.live.get(call.id)
            if data is None:
                continue
            ask = data.get("ask") if isinstance(data.get("ask"), dict) else None
            turns = [
                {"who": t.get("who"), "text": _line(t.get("text"), 600)}
                for t in (data.get("turns") or [])
                if isinstance(t, dict) and t.get("who") in ("them", "jarvis", "owner")
            ][-TURNS_SHOWN:]
            status = (
                "done"
                if data.get("done")
                else "asking"
                if ask
                else "hold"
                if data.get("hold")
                else "talking"
                if turns
                else "ringing"
            )
            out.append(
                {
                    "id": call.id,
                    "who": call.who(),
                    "number": answering.shown_number(call.number),
                    "goal": call.goal,
                    "at": call.at,
                    "status": status,
                    "asking": _line(ask.get("q"), 300) if ask else "",
                    "turns": turns,
                }
            )
        return out

    def _emit(self) -> None:
        calls = self.public()
        shown = repr(calls)
        if shown != self._shown:
            self._shown = shown
            self.hub.emit("call_live", calls=calls)


def _alert(key: str, title: str, text: str) -> Any:
    from ..proactive import Alert

    return Alert(key, "voicemail", title, text)  # (as how the call went is: kind voicemail)


def install(hub: Any) -> None:
    if getattr(hub, "answering", None) is None:
        return
    live = LiveCalls(hub)
    hub.live_calls = live
    hub.register_loop("calls_live", live.run)
