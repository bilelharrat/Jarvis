"""Interruptions that learn from how the owner reacts.

Every interruption is followed up: did the owner reply within minutes (a text back to
that person), open it (read it, or open the card), dismiss the card, or leave it unread
for hours? A text that waited, answered within minutes anyway, counts too. Per sender, and
per urgent word ("asap", "call me"), the last few reactions decide a standing:

- muted: the last MUTE_AFTER interruptions from them were all dismissed or ignored. They
  stop interrupting (their messages still wait for "what did I miss?");
- boosted: the owner answered BOOST_OF[0] of their last BOOST_OF[1] within minutes (a
  person in their Contacts only). Their messages get through as if urgent;
- lowered or raised a point: mostly dismissed, or a word that rarely/always matters.

A VIP always wins: never muted or lowered. Every standing comes with its reason in plain
words ("I've stopped interrupting you for Ann because you dismissed her last 5
messages"), said once when it starts and listed on request, and reset() takes it back.

What's kept (interrupt_learning.json): per sender a one-way hash of their address, the
owner's own Contacts name for them (or a masked address), and the last few reactions with
their times; per word, reactions. Never a message's words. What's still being watched
for a reaction (the address, to look for a reply) stays in memory.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore
from .prefs import APP_SUPPORT

log = logging.getLogger("jarvis")

QUICK_MINUTES = 15  # a reply or a read this soon means it mattered
IGNORE_HOURS = 4  # still unread this long after: ignored
HISTORY = 10  # reactions kept per sender
MUTE_AFTER = 5
BOOST_OF = (3, 4)  # quick replies among the last reactions
LOWER_OF = (3, 5)  # dismissed or ignored among the last reactions
WORD_OF = (5, 6)  # the same, for an urgent word
WORD_HISTORY = 12
MAX_SENDERS = 300
MAX_PENDING = 200
BOOST = 3  # enough to make a known contact's plain message urgent (1 + 3 = interrupts.URGENT)

POSITIVE = frozenset({"replied", "opened"})
NEGATIVE = frozenset({"dismissed", "ignored"})
OUTCOMES = POSITIVE | NEGATIVE | {"read"}

WORDS = {
    "en": {
        "muted": "I've stopped interrupting you for {who} because you {how} their last {n} "
        "messages. Say “start interrupting me for {who} again” to undo it.",
        "boosted": "{who}'s messages will reach you right away from now on: you answered {k} "
        "of their last {n} within minutes.",
        "how_dismissed": "dismissed",
        "how_ignored": "didn't open",
        "how_both": "dismissed or didn't open",
        "reset": "I've forgotten what I learned about {who}; they'll interrupt as before.",
        "reset_all": "I've forgotten everything I learned about your interruptions.",
        "nothing": "I haven't learned anything about who or what to interrupt you for yet.",
        "none_for": "I hadn't learned anything about {who}.",
        "lowered": "{who}: you usually dismiss their messages, so fewer of them interrupt.",
        "word_up": "“{word}”: you always answer those quickly, so it counts for more.",
        "word_down": "“{word}”: those rarely needed you right away, so it counts for less.",
    },
    "zh": {
        "muted": "我不再因为{who}的消息打扰你了，因为你{how}了他们最近{n}条消息。"
        "说“恢复{who}的提醒”就能撤销。",
        "boosted": "以后{who}的消息会马上告诉你：他们最近{n}条消息里有{k}条你几分钟内就回复了。",
        "how_dismissed": "关掉",
        "how_ignored": "没有打开",
        "how_both": "关掉或没打开",
        "reset": "我已忘掉关于{who}的学习结果，他们的消息会像以前一样提醒你。",
        "reset_all": "我已忘掉关于打扰提醒学到的所有内容。",
        "nothing": "我还没有学到该为谁或什么打扰你。",
        "none_for": "我没有学到关于{who}的任何内容。",
        "lowered": "{who}：你通常会关掉他们的消息，所以较少打扰你。",
        "word_up": "“{word}”：这类消息你总是很快回复，所以更重要。",
        "word_down": "“{word}”：这类消息很少需要你马上处理，所以不那么重要。",
    },
}


def person_key(source: str, handle: str) -> str:
    """One sender, however their number is written, as a one-way hash (the file never
    holds an address)."""
    handle = (handle or "").strip().lower().removeprefix("mailto:")
    if "@" not in handle:
        digits = re.sub(r"\D", "", handle)
        handle = digits[-10:] if len(digits) >= 7 else handle
    return hashlib.sha256(f"{source}:{handle}".encode()).hexdigest()[:20]


def masked(handle: str) -> str:
    """An address as the owner may be told it without the file holding it whole."""
    handle = (handle or "").strip()
    if "@" in handle:
        user, _, domain = handle.partition("@")
        return f"{user[:1]}…@{domain}"
    digits = re.sub(r"\D", "", handle)
    return f"the number ending {digits[-4:]}" if len(digits) >= 4 else "someone"


@dataclass
class Standing:
    """How learning changes an item's score, and why (for the item's reasons)."""

    delta: int = 0
    muted: bool = False
    boosted: bool = False
    reasons: list[str] = field(default_factory=list)


@dataclass
class Pending:
    """An interruption (or a text that waited) whose reaction isn't known yet. In memory."""

    key: str  # the item's key: "message:123"
    source: str
    rowid: int
    handle: str
    person: str  # person_key
    who: str
    words: list[str]
    at: datetime  # when the owner was told (or the text arrived)
    interrupted: bool
    dismissed: bool = False
    opened: bool = False


def _lang(value: str) -> str:
    return "zh" if str(value or "").lower().startswith("zh") else "en"


class ReactionLearner:
    """enabled(): Settings' switch (off: nothing learned and no standing applied). now:
    the clock, for tests."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        enabled: Callable[[], bool] = lambda: True,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.path = path or APP_SUPPORT / "interrupt_learning.json"
        self._enabled, self._now = enabled, now
        self.senders: dict[str, dict[str, Any]] = {}
        self.words: dict[str, list[list[str]]] = {}
        self.pending: dict[str, Pending] = {}
        self.unreadable = ""
        self._held = 0  # learn() within held(): one save for the lot (flush)
        self._unsaved = False
        self._load()

    def on(self) -> bool:
        try:
            return bool(self._enabled())
        except Exception:
            return False

    # ── on disk ──

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.info("interruptions: %s can't be read (%s)", self.path.name, exc)
            return
        if not data:
            return
        for key, raw in list((data.get("senders") or {}).items())[-MAX_SENDERS:]:
            if isinstance(key, str) and isinstance(raw, dict):
                self.senders[key[:40]] = {
                    "who": str(raw.get("who") or "someone")[:80],
                    "log": _log(raw.get("log"), HISTORY),
                    "state": raw.get("state") if raw.get("state") in ("muted", "boosted") else "",
                }
        for word, raw in (data.get("words") or {}).items():
            if isinstance(word, str) and len(word) <= 40:
                self.words[word] = _log(raw, WORD_HISTORY)

    def _save(self) -> None:
        self._unsaved = False
        if self.unreadable:
            return
        try:
            jsonstore.save_json(
                self.path, {"version": 1, "senders": self.senders, "words": self.words}, indent=1
            )
        except OSError as exc:
            log.info("interruptions: couldn't save what was learned (%s)", exc)

    @contextlib.contextmanager
    def held(self) -> Iterator[None]:
        """What learn() learns within it is saved once, when it ends or at flush(), not at
        each reaction: a look that settles many reactions at once (all of a night's, once the
        Mac wakes) writes the file once, not once each, flushed to the disk every time, with
        the event loop waiting on every write."""
        self._held += 1
        try:
            yield
        finally:
            self._held -= 1
            if not self._held:
                self.flush()

    def flush(self) -> None:
        """Save what was learned and not saved yet (within held())."""
        if self._unsaved:
            self._save()

    # ── watching for a reaction ──

    def announced(
        self,
        key: str,
        source: str,
        rowid: int,
        handle: str,
        who: str,
        words: Iterable[str] = (),
        interrupted: bool = True,
    ) -> None:
        """The owner was just told about this message (interrupted), or it's a text from
        someone they know that waited (interrupted False: only a quick reply counts)."""
        if not self.on() or not handle:
            return
        if key in self.pending and self.pending[key].interrupted and not interrupted:
            return
        self.pending[key] = Pending(
            key,
            source,
            int(rowid),
            handle,
            person_key(source, handle),
            who or masked(handle),
            [str(w) for w in words][:6],
            self._now(),
            interrupted,
        )
        while len(self.pending) > MAX_PENDING:
            del self.pending[next(iter(self.pending))]

    def card(self, key: str, action: str) -> None:
        """What the owner did with its card in the window: "opened" or "dismissed". Keys
        come as the alert's ("interrupt:message:12") or the item's."""
        item = self.pending.get(key.removeprefix("interrupt:"))
        if item is None:
            return
        if action == "opened":
            item.opened = True
        elif action == "dismissed":
            item.dismissed = True

    def due(self) -> list[Pending]:
        return list(self.pending.values())

    def settle(
        self, item: Pending, replied_at: datetime | None, read: bool | None, lang: str = "en"
    ) -> str | None:
        """Decide what the owner's reaction was, if it's known yet, and learn it. Returns
        the sentence to tell them when a sender's standing just changed."""
        outcome = self.outcome(item, replied_at, read)
        if outcome is None:
            return None
        self.pending.pop(item.key, None)
        if outcome == "drop":
            return None
        return self.learn(item.person, item.who, outcome, item.words, lang)

    def outcome(self, item: Pending, replied_at: datetime | None, read: bool | None) -> str | None:
        """replied, opened, dismissed, ignored, read (neutral), drop (nothing to learn) or
        None (not known yet). A quick reply or read beats a dismissed card: they dismissed
        it and answered on their phone."""
        now = self._now()
        age = now - item.at
        quick = timedelta(minutes=QUICK_MINUTES)
        if replied_at is not None and replied_at - item.at <= quick:
            return "replied"
        if item.opened or (read and age <= quick and item.interrupted):
            return "opened"
        if not item.interrupted:
            return "drop" if age > quick else None
        if item.dismissed and age > quick:
            return "dismissed"
        if age >= timedelta(hours=IGNORE_HOURS):
            if read or replied_at is not None:
                return "read"
            return "ignored" if read is False else "drop"
        return None

    # ── learning ──

    def learn(
        self, person: str, who: str, outcome: str, words: Iterable[str] = (), lang: str = "en"
    ) -> str | None:
        if outcome not in OUTCOMES:
            raise ValueError(f"unknown reaction {outcome!r}")
        stamp = self._now().isoformat(timespec="minutes")
        record = self.senders.pop(person, None) or {"who": who, "log": [], "state": ""}
        record["who"] = who or record["who"]
        record["log"] = [*record["log"], [outcome, stamp]][-HISTORY:]
        self.senders[person] = record  # newest last: the oldest go first
        while len(self.senders) > MAX_SENDERS:
            del self.senders[next(iter(self.senders))]
        for word in words:
            if outcome != "read":
                self.words[word] = [*self.words.get(word, []), [outcome, stamp]][-WORD_HISTORY:]
        told = self._restate(record, lang)
        if self._held:
            self._unsaved = True
        else:
            self._save()
        return told

    def _restate(self, record: dict[str, Any], lang: str) -> str | None:
        """The sender's standing, and the sentence for the owner when it just changed."""
        was = record["state"]
        now = "muted" if _muted(record["log"]) else "boosted" if _boosted(record["log"]) else ""
        record["state"] = now
        if now == was or not now:
            return None
        return self._sentence(now, record, lang)

    def _sentence(self, state: str, record: dict[str, Any], lang: str) -> str:
        words = WORDS[_lang(lang)]
        outcomes = [o for o, _ in record["log"]]
        if state == "muted":
            last = outcomes[-MUTE_AFTER:]
            how = (
                "how_dismissed"
                if set(last) == {"dismissed"}
                else "how_ignored"
                if set(last) == {"ignored"}
                else "how_both"
            )
            return words["muted"].format(who=record["who"], how=words[how], n=MUTE_AFTER)
        k = sum(o in POSITIVE for o in outcomes[-BOOST_OF[1] :])
        return words["boosted"].format(who=record["who"], k=k, n=BOOST_OF[1])

    def standing(
        self, source: str, handle: str, words: Iterable[str], vip: bool, known: bool
    ) -> Standing:
        """What learning does to a new message's score. A VIP is never muted or lowered;
        only someone in Contacts is ever boosted."""
        found = Standing()
        if not self.on():
            return found
        record = self.senders.get(person_key(source, handle))
        if record is not None:
            outcomes = [o for o, _ in record["log"]]
            who = record["who"]
            if record["state"] == "muted" and not vip:
                found.muted = True
                found.reasons.append(f"muted: you dismissed or ignored {who}'s last messages")
            elif record["state"] == "boosted" and known:
                found.boosted = True
                found.delta += BOOST
                found.reasons.append(f"you usually answer {who} within minutes")
            elif not vip and sum(o in NEGATIVE for o in outcomes[-LOWER_OF[1] :]) >= LOWER_OF[0]:
                found.delta -= 1
                found.reasons.append(f"you usually dismiss {who}'s messages")
        for word in dict.fromkeys(words):
            lean = _word_lean(self.words.get(word, []))
            if lean > 0:
                found.delta += 1
                found.reasons.append(f"you answer “{word}” messages quickly")
            elif lean < 0 and not vip:
                found.delta -= 1
                found.reasons.append(f"“{word}” messages rarely needed you right away")
        return found

    # ── explaining, and taking it back ──

    def explain(self, query: str = "", lang: str = "en") -> str:
        words = WORDS[_lang(lang)]
        query = query.strip().lower()
        lines: list[str] = []
        for record in reversed(self.senders.values()):
            if query and query not in record["who"].lower():
                continue
            outcomes = [o for o, _ in record["log"]]
            if record["state"]:
                lines.append(self._sentence(record["state"], record, lang))
            elif sum(o in NEGATIVE for o in outcomes[-LOWER_OF[1] :]) >= LOWER_OF[0]:
                lines.append(words["lowered"].format(who=record["who"]))
        if not query:
            for word, log_ in self.words.items():
                lean = _word_lean(log_)
                if lean:
                    lines.append(words["word_up" if lean > 0 else "word_down"].format(word=word))
        if not lines:
            return words["none_for"].format(who=query) if query else words["nothing"]
        return " ".join(lines[:30])

    def reset(self, who: str = "", lang: str = "en") -> str:
        """Forget what was learned about a sender (by the name they're known by), or, with
        no name, everything."""
        words = WORDS[_lang(lang)]
        if not who.strip():
            self.senders, self.words, self.pending = {}, {}, {}
            self._save()
            return words["reset_all"]
        want = who.strip().lower()
        gone = [k for k, r in self.senders.items() if want in r["who"].lower()]
        if not gone:
            return words["none_for"].format(who=who.strip())
        names = {self.senders[k]["who"] for k in gone}
        for key in gone:
            del self.senders[key]
        self._save()
        return " ".join(words["reset"].format(who=name) for name in sorted(names))

    def public(self, lang: str = "en") -> list[dict[str, Any]]:
        """For Settings: senders with a standing, newest first, and why."""
        return [
            {"who": r["who"], "state": r["state"], "why": self._sentence(r["state"], r, lang)}
            for r in reversed(self.senders.values())
            if r["state"]
        ]


def _muted(outcomes_log: list[list[str]]) -> bool:
    last = [o for o, _ in outcomes_log if o != "read"][-MUTE_AFTER:]
    return len(last) == MUTE_AFTER and all(o in NEGATIVE for o in last)


def _boosted(outcomes_log: list[list[str]]) -> bool:
    outcomes = [o for o, _ in outcomes_log]
    recent = outcomes[-BOOST_OF[1] :]
    return sum(o in POSITIVE for o in recent) >= BOOST_OF[0] and not any(
        o in NEGATIVE for o in outcomes[-2:]
    )


def _word_lean(outcomes_log: list[list[str]]) -> int:
    recent = [o for o, _ in outcomes_log][-WORD_OF[1] :]
    if len(recent) < WORD_OF[1]:
        return 0
    if sum(o in POSITIVE for o in recent) >= WORD_OF[0]:
        return 1
    if sum(o in NEGATIVE for o in recent) >= WORD_OF[0]:
        return -1
    return 0


def _log(raw: Any, limit: int) -> list[list[str]]:
    out = []
    for entry in raw if isinstance(raw, list) else ():
        if (
            isinstance(entry, list)
            and len(entry) == 2
            and entry[0] in OUTCOMES
            and isinstance(entry[1], str)
        ):
            out.append([entry[0], entry[1][:20]])
    return out[-limit:]
