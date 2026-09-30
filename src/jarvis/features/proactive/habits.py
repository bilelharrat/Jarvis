"""Habits into routines. A habit card ("You usually ask “what's the weather” around 8 am on
weekdays") gains "Make it a routine"; a tap, or "make it a routine" said while the card is
up, puts up the same card create_routine does, with the schedule the habit keeps (its days,
at its usual time to five minutes) and exactly what it will ask. Yes adds the routine
(routines.py), and the habit is never suggested again: the routine asks it now. No adds
nothing, and the card stays for "Do it" or "Not now".

Window: {"type": "habit_routine", "key": <the suggestion's key>}; the "proactive" event's
"habit" part, {key, done}, once it's answered (done: the routine was added, and the card
goes). The words said about it come as a "caption".

Cost: no model calls. (The routine then runs as any routine does.)
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ... import lang, routines, suggestions
from ...textclean import clean_text

log = logging.getLogger("jarvis")

TEXTS = {
    "Added the routine “{name}”, {when}.": "已添加例行任务“{name}”，{when}。",
    "That habit card isn't up any more.": "那张习惯卡片已经不在了。",
    "The routine wasn't added.": "没有添加这个例行任务。",
    "I couldn't save the routine ({why}).": "例行任务没能保存（{why}）。",
}
lang.add_texts(TEXTS)

# "Make it a routine" while a habit card is up; anything else is Claude's.
_SAY = re.compile(
    r"^(?:(?:ok(?:ay)?|yes|yeah|sure|jarvis)[,\s]+)*(?:please\s+)?(?:make|turn)\s+(?:it|this"
    r"|that)\s+(?:into\s+)?(?:a\s+)?(?:daily\s+)?routine(?:\s+please)?[\s.!]*$",
    re.IGNORECASE,
)
_SAY_ZH = re.compile(
    r"^(?:好的?|可以|行|嗯)?[，,\s]*(?:请|帮我)?(?:把(?:它|这个|那个))?(?:设为|设成|变成|做成|改成)"
    r"(?:一个)?(?:例行任务|例行事项|日常任务)[吧。！!\s]*$"
)


def schedule_of(habit: suggestions.Habit) -> tuple[str, list[int], str]:
    """A habit's days and usual time as a routine's schedule: (kind, days, "HH:MM")."""
    minutes = int(round(habit.minutes / 5) * 5) % 1440
    time = f"{minutes // 60:02d}:{minutes % 60:02d}"
    if habit.days == "weekdays":
        return "weekdays", [], time
    if habit.days == "weekends":
        return "weekly", [5, 6], time
    if habit.days.isdigit():
        return "weekly", [int(habit.days)], time
    return "daily", [], time


def said_make_routine(text: str) -> bool:
    said = " ".join(str(text or "").split())
    return (
        bool(said)
        and len(said) < 80
        and bool(_SAY.match(said) or _SAY_ZH.match(lang.to_simplified(said)))
    )


class Habits:
    """One hub's habit cards made into routines."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def install(self) -> None:
        self.hub.register_command("habit_routine", self.command)
        self.hub.register_instant(self.instant)

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def habit_for(self, key: str) -> tuple[Any, suggestions.Habit] | None:
        """The open habit card with this key and the habit it's about; None when it's gone."""
        suggester = self.hub.suggester
        card = suggester.open.get(key)
        if card is None or card.suggestion != "habit":
            return None
        for habit in suggestions.find_habits(suggester.history, suggester._now()):
            if f"habit:{suggestions._topic_id(habit.key)}" == card.topic:
                return card, habit
        return None

    async def make(self, key: str) -> str:
        """The routine's card for this habit, and the routine added on yes. What to say."""
        say = lambda template, **v: lang.tr(template, self.language(), **v)  # noqa: E731
        found = self.habit_for(key)
        if found is None:
            return say("That habit card isn't up any more.")
        _card, habit = found
        kind, days, time = schedule_of(habit)
        request = " ".join(clean_text(habit.request).split())
        name = request[:60].rstrip("?.! ") or "Routine"
        preview = routines.Routine("", name, "", kind, time, days)
        question = routines._add_question(preview, request.rstrip("?.! "), self.language())
        if not await self.hub.confirm(question):
            self.send(key, done=False)
            return say("The routine wasn't added.")
        try:
            routine = self.hub.routines.add(name, request, kind, time, days)
        except (ValueError, OSError) as exc:
            self.send(key, done=False)
            why = getattr(exc, "strerror", None) or str(exc)
            return say("I couldn't save the routine ({why}).", why=why)
        self.hub._routines_changed()
        self.hub.suggester.covered(key)
        self.send(key, done=True)
        return say(
            "Added the routine “{name}”, {when}.",
            name=routine.name,
            when=routine.describe(self.language()),
        )

    async def command(self, msg: dict[str, Any]) -> None:
        """The card's "Make it a routine": the owner's tap."""
        text = await self.make(str(msg.get("key") or ""))
        self.hub.emit("caption", text=text)

    async def instant(self, text: str) -> str | None:
        """hub.register_instant: "make it a routine" while a habit card is up."""
        if not said_make_routine(text):
            return None
        open_cards = [k for k, s in self.hub.suggester.open.items() if s.suggestion == "habit"]
        if not open_cards:
            return None  # no card up: Claude hears it (create_routine)
        return await self.make(open_cards[-1])

    def send(self, key: str, done: bool) -> None:
        self.hub.emit("proactive", habit={"key": key, "done": done})
