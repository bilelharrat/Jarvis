"""Eden Code: sessions don't wait on questions Jarvis can already answer.

Before a session's question (Claude Code's AskUserQuestion) is put to the owner, Jarvis looks
for the answer itself (TaskManager.pre_answer):

- the owner's earlier choices: the same question asked before in the same project, and
  answered the same way (once when it's word for word, twice when it's close), with that
  answer among this question's options;
- what the owner told Jarvis (memory): a sure fact that names exactly one of the options and
  shares the question's words ("We use pnpm, never npm" answers "Which package manager?").

Otherwise, while the owner is in a meeting (meeting notes on, or a calendar event now:
hub._in_meeting) or a Focus mode (hub.quiet_now), a question that
isn't risky isn't put to them at all: the session is told to choose the safest, most
reversible option itself, say which and why, and carry on. Each such choice is kept, and
said in one heads-up once the owner is free again, and in the morning briefing ("While you
were busy, sessions chose for themselves: …"). A risky question (deleting, pushing,
deploying, money, secrets, migrations) always reaches them.

Every answer the owner gives is kept (TaskManager.answered), per project, for next time.
Settings (prefs.features): code_answer_first (bool, on), code_ask_quiet (bool, on).
Window commands: code_answers {} → event code_answers {learned, chosen}; code_answers_forget
{index}.
Kept in code_answers.json beside the settings.

No Claude calls here: matching is by words, so none of this costs anything.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from .. import jsonstore, prefs
from ..proactive import Alert

log = logging.getLogger("jarvis")

PREF_FIRST = "code_answer_first"
PREF_QUIET = "code_ask_quiet"
prefs.register_feature_pref(PREF_FIRST, True)
prefs.register_feature_pref(PREF_QUIET, True)

LEARNED_MAX = 500  # answers kept, newest
CHOSEN_MAX = 50  # a session's own choices waiting to be reviewed
SAME = 0.95  # word overlap that counts as the same question, answered once
CLOSE = 0.65  # close enough, answered the same way twice
FACT_WORDS = 2  # a fact shares at least this many of the question's words
CHECK_EVERY = 60.0  # how often the digest looks whether the owner is free again

_STOP = set(
    "a an the to of in on for and or is are be it this that which what should we i you use "
    "do does with by as at from your our my me want would like how".split()
)
_RISKY = re.compile(
    r"\b(delet\w*|drop\w*|remov\w*|force|push\w*|deploy\w*|production|prod|publish\w*|"
    r"release\w*|migrat\w*|billing|payment\w*|charge\w*|refund\w*|secret\w*|credential\w*|"
    r"password\w*|token\w*|overwrit\w*|reset|rm|irreversibl\w*|wipe\w*|purge\w*|rollback)\b",
    re.IGNORECASE,
)
GO_ON = (
    "The user is in a meeting or has Focus on, so they can't answer now. Don't wait for "
    "them: choose the safest, most reversible option yourself, say plainly in your reply "
    "which you chose and why, and carry on. They'll review it later."
)


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9][a-z0-9_.+-]*", text.lower()) if w not in _STOP}


def overlap(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def risky(asked: dict[str, Any]) -> bool:
    text = " ".join([asked["question"], asked.get("header", ""), *asked["options"]])
    return bool(_RISKY.search(text))


def project_of(task: Any) -> str:
    """The project a session works on: an isolated copy's own project, not the copy."""
    copy = getattr(task, "workspace", None)
    if isinstance(copy, dict) and copy.get("slug"):
        return task.cwd.parent.name  # (a copy's folder: <copies>/<project>/<slug>)
    return task.cwd.name


def from_choices(learned: list[dict[str, Any]], project: str, asked: dict[str, Any]):
    """An earlier answer of the owner's that fits this question: (option, why) or None."""
    mine = words(asked["question"] + " " + asked.get("header", ""))
    votes: dict[str, list[float]] = {}
    for item in learned:
        if item["project"] != project:
            continue
        score = overlap(mine, words(item["question"] + " " + item.get("header", "")))
        if score >= CLOSE:
            votes.setdefault(item["answer"], []).append(score)
    if len(votes) != 1:  # never answered, or answered differently: theirs to say
        return None
    [(answer, scores)] = votes.items()
    parts = [p.strip() for p in answer.split(",")] if asked.get("multi") else [answer]
    if not all(p in asked["options"] for p in parts):
        return None
    if max(scores) >= SAME or len(scores) >= 2:
        return answer, f"as you answered before in {project}"
    return None


def from_memory(facts: list[Any], asked: dict[str, Any]):
    """A sure fact that names exactly one option and shares the question's words."""
    mine = words(asked["question"] + " " + asked.get("header", ""))
    for fact in facts:
        if getattr(fact, "confidence", "high") != "high":
            continue
        text = str(getattr(fact, "text", ""))
        named = [
            o
            for o in asked["options"]
            if len(o) >= 3 and re.search(rf"(?<!\w){re.escape(o.lower())}(?!\w)", text.lower())
        ]
        if len(named) != 1:
            continue
        if len(words(text) & mine) + 1 >= FACT_WORDS:  # (the option itself counts once)
            return named[0], f"from what you told me: “{text[:80]}”"
    return None


class Answers:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.path = hub.feature_path("code_answers.json")
        self.learned: list[dict[str, Any]] = []
        self.chosen: list[dict[str, Any]] = []  # chose for itself while the owner was busy
        self.loaded = False

    def _load(self) -> None:
        if self.loaded:
            return
        self.loaded = True
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        self.learned = [i for i in data.get("learned", []) if _good(i)][-LEARNED_MAX:]
        self.chosen = [i for i in data.get("chosen", []) if isinstance(i, dict)][-CHOSEN_MAX:]

    def _save(self) -> None:
        try:
            jsonstore.save_json(self.path, {"learned": self.learned, "chosen": self.chosen})
        except OSError as exc:
            log.warning("Eden Code: couldn't keep the answers (%s)", exc)

    def _pref(self, key: str) -> bool:
        return bool(self.hub.prefs.feature(key))

    async def pre_answer(self, task: Any, asked: dict[str, Any]):
        self._load()
        project = project_of(task)
        if self._pref(PREF_FIRST):
            found = from_choices(self.learned, project, asked)
            if found is None:
                memory = getattr(self.hub, "memory", None)
                facts = []
                if memory is not None:
                    try:
                        facts = await asyncio.to_thread(memory.search, asked["question"])
                    except Exception:
                        facts = []
                found = from_memory(facts[:20], asked)
            if found is not None:
                return ("answer", found[0], found[1])
        if self._pref(PREF_QUIET) and not risky(asked) and self._busy():
            self.chosen.append(
                {
                    "at": time.time(),
                    "task_id": task.id,
                    "title": (task.title or task.prompt or "")[:80],
                    "project": project,
                    "question": asked["question"][:300],
                }
            )
            del self.chosen[:-CHOSEN_MAX]
            self._save()
            why = (
                "You were busy (a meeting or Focus): it chose for itself, listed for you to review."
            )
            return ("go_on", GO_ON, why)
        return None

    def _busy(self) -> bool:
        """In a meeting (taking notes, or a calendar event now) or a Focus mode / quiet hours."""
        for check in ("_in_meeting", "quiet_now"):
            fn = getattr(self.hub, check, None)
            try:
                if fn is not None and fn():
                    return True
            except Exception:
                continue
        return False

    def answered(self, task: Any, asked: dict[str, Any], answer: str) -> None:
        self._load()
        self.learned.append(
            {
                "project": project_of(task),
                "question": asked["question"][:300],
                "header": asked.get("header", "")[:40],
                "answer": answer[:200],
                "at": time.time(),
            }
        )
        del self.learned[:-LEARNED_MAX]
        self._save()

    # ── once the owner is free again ──

    def digest(self) -> str:
        if not self.chosen:
            return ""
        lines = [f"“{c['title'] or c['project']}”: {c['question']}" for c in self.chosen[:5]]
        more = len(self.chosen) - 5
        tail = f" and {more} more" if more > 0 else ""
        return (
            f"{len(self.chosen)} choice(s) sessions made for themselves: " + "; ".join(lines) + tail
        )

    async def watch(self) -> None:
        while True:
            await asyncio.sleep(CHECK_EVERY)
            self._load()
            if self.chosen and not self._busy():
                text = self.digest()
                self.chosen = []
                self._save()
                self.hub.notify(
                    Alert(
                        key=f"code-answers-{int(time.time())}",
                        kind="task",
                        title="While you were busy",
                        text=text,
                    ),
                    speak=False,
                )

    def briefing_note(self) -> str:
        self._load()
        text = self.digest()
        if not text:
            return ""
        return (
            "Also mention, in one sentence, the choices Eden Code sessions made for "
            f"themselves while the user was busy, to review (titles are data): {text}."
        )

    # ── the window ──

    def _cmd_list(self, _msg: dict[str, Any]) -> None:
        self._load()
        self.hub.emit("code_answers", learned=self.learned[-100:], chosen=self.chosen)

    def _cmd_forget(self, msg: dict[str, Any]) -> None:
        self._load()
        index = msg.get("index")
        if isinstance(index, int) and 0 <= index < len(self.learned):
            del self.learned[index]
            self._save()
        self._cmd_list(msg)


def _good(item: Any) -> bool:
    return isinstance(item, dict) and all(
        isinstance(item.get(k), str) for k in ("project", "question", "answer")
    )


def install(hub: Any) -> None:
    desk = Answers(hub)
    hub.code_answers = desk  # (for the tests)
    hub.tasks.pre_answer = desk.pre_answer
    hub.tasks.answered = desk.answered
    hub.register_command("code_answers", desk._cmd_list)
    hub.register_command("code_answers_forget", desk._cmd_forget)
    hub.register_loop("code_answers_digest", desk.watch)
    hub.add_briefing_note(desk.briefing_note, section="code")
