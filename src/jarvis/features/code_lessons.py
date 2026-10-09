"""Eden Code: an engineering memory across every project, learned from corrections.

When the owner corrects a session ("no, use pnpm", "never mock the database in these
tests", "always run the linter before you say it's done"), the rule in their words becomes
a lesson in Jarvis's own memory (category work, origin "Eden Code correction"), not a
per-repository CLAUDE.md: it's theirs, seen and edited in Settings › Memory like any fact,
and it follows them into every repository. A rule said for everywhere ("always…", "in
every project") applies to every session; any other, to sessions in the project it was
said in.

Each session hears the lessons that apply with its first message, and again when one is
added (TaskManager.turn_notes), marked as the owner's standing preferences.

What counts as a correction is decided by its words (a rule: never, always, don't,
instead, prefer, use … not …), not by a model: nothing here costs anything. Steers and
follow-ups alike are heard (task_log, the owner's own messages).
Setting (prefs.features): code_lessons (bool, on).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .. import prefs

log = logging.getLogger("jarvis")

PREF = "code_lessons"
prefs.register_feature_pref(PREF, True)

ORIGIN = "Eden Code correction"
EVERYWHERE = "every project"
MAX_CHARS = 240  # longer is a request, not a rule
MIN_WORDS = 4
SHOWN = 12  # lessons a session hears, the newest

_RULE = re.compile(
    r"\b(always|never|don'?t|do not|stop|instead|prefer|avoid|must|should(?:n'?t)?|"
    r"rather than|not \w+ but|use \S+ (?:not|instead of|over) \S+)\b",
    re.IGNORECASE,
)
_CORRECTING = re.compile(
    r"^\s*(no\b|nope\b|wrong\b|not like that|that'?s not|please don'?t|don'?t|never|always|"
    r"stop\b|instead\b|from now on|in future|going forward|we (?:use|don'?t|never|always)|"
    r"i (?:prefer|want|like|hate)|prefer\b|use\b|avoid\b)",
    re.IGNORECASE,
)
_GLOBAL = re.compile(
    r"\b(always|from now on|every (?:project|repo\w*)|everywhere|in general|any project|all projects)\b",
    re.IGNORECASE,
)


def lesson_in(text: str, correcting: bool = False) -> tuple[str, bool] | None:
    """(the rule, for every project) when the owner's message is a correction with a rule
    in it; None for anything else (a request, a question, code). correcting: it's a
    correction already (their words saying no to a step or a plan)."""
    text = " ".join((text or "").split())
    if not text or len(text) > MAX_CHARS or "```" in text or text.endswith("?"):
        return None
    if len(text.split()) < MIN_WORDS or not _RULE.search(text):
        return None
    if not correcting and not _CORRECTING.search(text):
        return None
    rule = re.sub(r"^\s*(no|nope|wrong)[,.!:;\s-]+", "", text, flags=re.IGNORECASE).strip()
    rule = rule[:1].upper() + rule[1:]
    return rule, bool(_GLOBAL.search(text))


def scope_of(origin: str) -> str:
    m = re.search(r"\(([^)]*)\)\s*$", origin or "")
    return m.group(1) if m else EVERYWHERE


class Lessons:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.told: dict[int, int] = {}  # task id -> how many lessons it heard

    def on(self) -> bool:
        return bool(self.hub.prefs.feature(PREF))

    def _project(self, task: Any) -> str:
        copy = getattr(task, "workspace", None)
        if isinstance(copy, dict) and copy.get("slug"):
            return task.cwd.parent.name
        return task.cwd.name

    def all(self) -> list[Any]:
        memory = getattr(self.hub, "memory", None)
        facts = getattr(memory, "facts", None) or []
        return [f for f in facts if str(getattr(f, "origin", "")).startswith(ORIGIN)]

    def for_project(self, project: str) -> list[str]:
        out = []
        for fact in self.all():
            scope = scope_of(fact.origin)
            if scope in (EVERYWHERE, f"project {project}"):
                out.append(fact.text)
        return out[-SHOWN:]

    def heard(self, kind: str, data: dict[str, Any]) -> None:
        """hub.add_task_sink: the owner's own message to a session."""
        if kind != "task_log" or not self.on():
            return
        entry = data.get("entry") or {}
        if entry.get("role") != "user":
            return
        task = self.hub.tasks.tasks.get(data.get("id"))
        self.learn(task, lesson_in(str(entry.get("text") or "")))

    def corrected(self, task: Any, words: str) -> None:
        """TaskManager.corrected: the owner said no to a step or a plan, with why."""
        if self.on():
            self.learn(task, lesson_in(words, correcting=True))

    def changes_undone(self, event: dict[str, Any]) -> None:
        """A change the session made was undone (the Changes pane): the window asks the
        owner, in one optional line, what Jarvis should remember (code_lesson_add)."""
        if self.on() and event.get("undone"):
            self.hub.emit("code_lesson_ask", id=event.get("id"), file=str(event.get("file") or ""))

    def _cmd_add(self, msg: dict[str, Any]) -> None:
        """What the owner typed after undoing a change: kept as they wrote it."""
        try:
            task = self.hub.tasks.tasks.get(msg.get("id"))
        except TypeError:  # (an id that can't be one: a list, an object)
            task = None
        text = " ".join(str(msg.get("text") or "").split())[:MAX_CHARS]
        if task is None or len(text.split()) < 2:
            return
        self.learn(task, (text[:1].upper() + text[1:], bool(_GLOBAL.search(text))))
        self.hub.emit("code_lesson_kept", id=task.id, text=text)

    def learn(self, task: Any, found: tuple[str, bool] | None) -> None:
        if found is None or task is None or getattr(task, "kind", "") != "code":
            return
        rule, everywhere = found
        scope = EVERYWHERE if everywhere else f"project {self._project(task)}"
        if any(f.text.lower() == rule.lower() for f in self.all()):
            return  # known already
        try:
            self.hub.memory.add(
                rule,
                category="work",
                confidence="high",
                source="noticed",
                origin=f"{ORIGIN} ({scope})",
            )
        except Exception as exc:
            log.warning("Eden Code: couldn't keep a lesson (%s)", exc)

    def turn_note(self, task: Any) -> str:
        """TaskManager.turn_notes: the lessons, with a session's first message and again
        when there are more."""
        if not self.on() or task.kind != "code":
            return ""
        lessons = self.for_project(self._project(task))
        if not lessons or self.told.get(task.id) == len(lessons):
            return ""
        self.told[task.id] = len(lessons)
        rules = " ".join(f"({n}) {text}" for n, text in enumerate(lessons, 1))
        return (
            "The owner's standing coding preferences, learned from their corrections in past "
            f"sessions; follow them unless this request says otherwise: {rules}"
        )


def install(hub: Any) -> None:
    desk = Lessons(hub)
    hub.code_lessons = desk  # (for the tests)
    hub.add_task_sink(desk.heard)
    hub.tasks.turn_notes.append(desk.turn_note)
    hub.tasks.corrected.append(desk.corrected)
    hub.add_event_sink(("code_hunk_undone",), desk.changes_undone)
    hub.register_command("code_lesson_add", desk._cmd_add)
