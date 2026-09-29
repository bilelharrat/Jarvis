"""Claude Code by voice.

"Jarvis, let's code in jarvis" puts a Claude Code session in voice focus. From then on
what you say goes to that session, except the handful of things that are about the
session rather than for it, which are handled here at once:

    plan mode / accept edits / full auto / ask first      change the permission mode
    stop / hold on                                         interrupt the current step
    undo that                                              rewind the files
    compact                                                /compact
    what changed / what's the diff                         a spoken summary of the diff
    explain the second change                              Claude explains it, briefly
    read the plan                                          the plan's steps, out loud
    status / what are you doing                            what it's on right now
    how much context / what's this cost                    context used, money spent
    use sonnet                                             switch the session's model
    commit that / push / open a PR / run the tests         git and tests, via Claude Code
    new session                                            start fresh in the same project
    exit code mode                                         back to plain JARVIS

While it works, JARVIS narrates briefly (what it's editing or running), reads its
replies as a few spoken sentences (the rest is on screen), puts each approval as a
spoken question you answer with "yes", "no", "option two" or a label, and reads a plan
as its steps before asking you to approve it.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from typing import Any

from .speech import clean_for_speech, split_sentences
from .wake import _is_wake_token, words

MODEL_KEYS = ("opus", "sonnet", "haiku", "fable")
ORDINALS = {
    "first": 0, "one": 0, "1": 0, "1st": 0,
    "second": 1, "two": 1, "2": 1, "2nd": 1,
    "third": 2, "three": 2, "3": 2, "3rd": 2,
    "fourth": 3, "four": 3, "4": 3, "4th": 3,
    "fifth": 4, "five": 4, "5": 4, "5th": 4,
    "sixth": 5, "six": 5, "6": 5, "6th": 5,
}  # fmt: skip

# Slash commands typed in the panel, as the words that mean them by voice.
SLASH = {
    "plan": "plan mode",
    "ask": "ask first",
    "edits": "accept edits",
    "auto": "full auto",
    "undo": "undo that",
    "diff": "what changed",
    "changes": "what changed",
    "cost": "what's this cost",
    "context": "how much context",
    "status": "status",
    "model": "use {arg}",
    "commit": "commit that",
    "push": "push it",
    "pr": "open a pull request",
    "test": "run the tests",
    "tests": "run the tests",
    "new": "new session",
    "clear": "new session",
    "stop": "stop",
    "branch": "what branch am I on",
    "readplan": "read the whole plan",
}

GIT_PROMPTS = {
    "commit": "Commit the changes you made with a clear commit message, then tell me the "
    "message in one sentence.",
    "push": "Push the current branch to its remote and tell me in one sentence how it went.",
    "pr": "Push this branch and open a pull request with gh, with a clear title and summary. "
    "Tell me the PR's number when it's up.",
    "tests": "Run the project's tests and tell me the result in a sentence or two; if "
    "anything fails, say what.",
}


@dataclass
class Intent:
    kind: str
    arg: Any = None
    text: str = ""  # anything to forward to the session along with the intent


def _clean(text: str) -> str:
    w = [t for t in words(text) if not _is_wake_token(t)]
    while w and w[0] in ("please", "okay", "ok", "so", "now", "and", "hey", "can", "could", "you"):
        w = w[1:]
    return " ".join(w).replace("’", "'")


def parse(text: str) -> Intent:
    """What an utterance in voice-code mode means. Unknown means: send it to Claude."""
    said = _clean(text)
    n = len(said.split())
    raw = re.sub(r"^\W*(jarvis|jervis|jarvus)\W+", "", text.strip(), flags=re.IGNORECASE)

    def short(limit: int = 6) -> bool:
        return 0 < n <= limit

    if re.fullmatch(
        r"(exit|leave|stop|end|quit|close|turn off)( the)?( voice)? (code|coding)( mode)?"
        r"|(that's|thats) all( for now)?|i'm done( coding)?|back to normal",
        said,
    ):
        return Intent("exit")
    if re.fullmatch(
        r"(ultrathink|ultra think|think as hard as you can|max(imum)? effort|think really hard)",
        said,
    ):
        return Intent("effort", "max")
    if short(6) and re.fullmatch(
        r"(think|thinks) (harder|more|deeper|carefully)( about (this|it))?|more effort|high effort",
        said,
    ):
        return Intent("effort", "up")
    if short(6) and re.fullmatch(
        r"think less|(be )?quick(er)?( mode| answers)?|low effort|less effort", said
    ):
        return Intent("effort", "low")
    if short(5) and re.fullmatch(
        r"(fork|branch off)( this| the session| the conversation| it)?( here)?", said
    ):
        return Intent("fork")
    m = re.fullmatch(
        r"(rename|call|name) (this|the|this session|the session|it) (to |as )?(?P<t>.+)", said
    )
    if m and n <= 14:
        return Intent("rename", re.sub(r"^(session )?(to |as )", "", m.group("t")).strip())
    if short(8) and re.fullmatch(
        r"(what's|what is|read( me)?|show( me)?)( on)? (the |your )?(to ?do|todo)( list)?|what's left( to do)?"
        r"|what are you working on|to ?do list",
        said,
    ):
        return Intent("todos")
    if short(6) and re.fullmatch(
        r"(export|save)( the| this)? (transcript|session|conversation)", said
    ):
        return Intent("export")
    m = re.fullmatch(r"(rewind|roll back|go back) (the code )?to (before|when) (?P<t>.+)", said)
    if m:
        return Intent("rewind", m.group("t").strip())
    if short(3) and re.fullmatch(
        r"(stop|stop it|stop that|hold on|hold it|wait|cancel|cancel that|pause|halt)", said
    ):
        return Intent("interrupt")
    if short(6) and re.fullmatch(
        r"(undo|revert|roll back|rollback)( that| it| this| the last( change| edit| step)?"
        r"| those changes| your( last)? changes?| what you did)?",
        said,
    ):
        return Intent("undo")
    if short(5) and re.search(r"\bcompact\b", said):
        return Intent("compact")
    mode = _mode(said)
    if mode:
        rest = re.sub(_MODE_WORDS, " ", said)
        rest = [w for w in rest.split() if w not in _MODE_FILLER]
        if not rest:
            return Intent("mode", mode)
        if mode == "plan" or re.match(
            r"(switch to |go )?(full auto|auto edits?|accept edits)", said
        ):
            # "let's plan the migration", "full auto and fix the tests": mode, then the ask
            return Intent("mode", mode, raw)
    m = re.search(
        r"\b(read|explain|walk me through|tell me about|what's|what is|describe)\b.*?"
        r"\b(first|second|third|fourth|fifth|sixth|last|\d+(?:st|nd|rd|th)?)\b\s*(one\s*)?"
        r"(change|edit|diff|hunk)\b",
        said,
    )
    if m:
        which = m.group(2)
        return Intent("explain_change", -1 if which == "last" else ORDINALS.get(which, 0))
    if short(8) and re.search(
        r"(what|which)( files)?( did| have)? you (change|changed|touch|touched|edit|edited)"
        r"|what's the diff|what changed|summari[sz]e (the |your )?changes|show me the (diff|changes)"
        r"|what are the changes|what's changed",
        said,
    ):
        return Intent("changes")
    if short(8) and re.search(
        r"(read|what's|what is|tell me|go over|repeat)( me)?( the| your)?( whole| full)? plan", said
    ):
        return Intent("plan", "full" in said or "whole" in said)
    if short(6) and re.fullmatch(
        r"(status|what are you doing|what're you doing|where are (you|we) at|how's it going"
        r"|are you done( yet)?|progress|what's happening|what's going on)",
        said,
    ):
        return Intent("status")
    if short(8) and re.search(r"context (usage|left|window|used)|how much context", said):
        return Intent("context")
    if short(8) and re.search(r"(how much|what).*(cost|spent|spend)", said):
        return Intent("cost")
    m = re.search(r"\b(use|switch to|change to)( the)? (opus|sonnet|haiku|fable)\b", said)
    if m and short(6):
        return Intent("model", m.group(3))
    if short(5) and re.fullmatch(
        r"(new|fresh) (session|conversation|chat)|start (over|fresh|a new session)", said
    ):
        return Intent("new_session")
    if short(5) and re.fullmatch(
        r"(repeat|repeat that|say that again|what did you say|come again|pardon)", said
    ):
        return Intent("repeat")
    if short(5) and re.fullmatch(
        r"(read|say)( me)? the rest|the rest( please)?|go on reading", said
    ):
        return Intent("rest")
    m = re.fullmatch(
        r"(switch to|let's work on|work on|go to|move to|open)( the)? (?P<p>[\w .-]+?) (project|repo|repository|folder)",
        said,
    )
    if m:
        return Intent("project", m.group("p").strip())
    m = re.fullmatch(
        r"(resume|reopen|go back to|pick up)( the| my| our)?( session| conversation)?"
        r"( (from )?(yesterday|last time|earlier))?( about| on| for)? (?P<t>.+?)( session| conversation)?",
        said,
    )
    # Only when it's clearly about a session: "pick up the pace on the tests" isn't.
    if (
        m
        and n <= 10
        and (said.startswith(("resume", "reopen")) or said.endswith(("session", "conversation")))
    ):
        return Intent("resume", m.group("t").strip())
    if short(6) and re.fullmatch(r"(what|which) branch( am i| are we| is this)?( on)?", said):
        return Intent("branch")
    if short(5) and re.fullmatch(
        r"show( me)?( it| that| the session| the panel| the changes on screen)?|open the (panel|deck|session)",
        said,
    ):
        return Intent("show")
    if short(6) and re.fullmatch(
        r"commit( that| this| it| (the |your |these |those )?changes)?( please)?", said
    ):
        return Intent("git", "commit")
    if short(5) and re.fullmatch(r"push( it| that| the branch)?( up)?", said):
        return Intent("git", "push")
    if short(8) and re.search(r"(open|make|create|raise|file) (a |the )?(pr|pull request)", said):
        return Intent("git", "pr")
    if short(5) and re.fullmatch(r"(run|rerun|re-run) (the |all the )?tests", said):
        return Intent("git", "tests")
    return Intent("send", text=raw)


_MODE_WORDS = (
    r"\b(plan mode|planning mode|switch to plan|plan first|accept( all)? edits|auto[- ]?edits?"
    r"|edit mode|full auto|auto mode|autopilot|don't ask( me)?|run anything|ask mode"
    r"|ask( me)? first|ask before( edits)?|normal mode|default mode)\b"
)
_MODE_FILLER = {"switch", "to", "go", "into", "use", "turn", "on", "please", "mode", "the", "back"}


def _mode(said: str) -> str | None:
    if re.search(
        r"\b(plan mode|planning mode|switch to plan|plan first|let's plan|make a plan)\b", said
    ):
        return "plan"
    if re.search(r"\b(accept edits|auto[- ]?edits?|edit mode|accept all edits)\b", said):
        return "edits"
    if re.search(r"\b(full auto|auto mode|autopilot|don't ask( me)?|run anything)\b", said):
        return "auto"
    if re.search(r"\b(ask mode|ask (me )?first|ask before|normal mode|default mode)\b", said):
        return "ask"
    return None


MODE_NAMES = {
    "plan": "Plan mode: I'll plan and check with you before changing anything.",
    "ask": "Ask mode: I'll ask before each edit and command.",
    "edits": "Auto-edits: edits go ahead, commands still ask.",
    "auto": "Full auto: I'll run anything without asking.",
}


# ── choosing among options by voice ──


def pick_choice(text: str, labels: list[str]) -> int | None:
    """'option two', 'the second one', 'the last', or (enough of) a label's words."""
    said = _clean(text)
    if not said or not labels:
        return None
    tokens = said.split()
    if "last" in tokens and len(tokens) <= 4:
        return len(labels) - 1
    for token in tokens[:5]:
        if token in ORDINALS and len(tokens) <= 5 and ORDINALS[token] < len(labels):
            return ORDINALS[token]
    best, best_score = None, 0.0
    for i, label in enumerate(labels):
        lab = _clean(label)
        if not lab:
            continue
        lab_words = set(lab.split()) - {"the", "a", "an", "and", "or", "to"}
        overlap = len(lab_words & set(tokens)) / max(1, len(lab_words))
        score = max(overlap, difflib.SequenceMatcher(None, said, lab).ratio())
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= 0.6 else None


# ── turning Claude Code's output into speech ──


def speakable(text: str, sentences: int = 3) -> str:
    """A reply, a few spoken sentences long; code stays on screen."""
    text = re.sub(r"```.*?```", " (code on screen) ", text or "", flags=re.DOTALL)
    text = re.sub(r"^\s*#+\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*(?:[-*]|\d+[.)])\s+", "", text, flags=re.MULTILINE)
    text = clean_for_speech(text)
    parts, rest = split_sentences(text, final=True)
    parts = [p for p in parts + ([rest] if rest.strip() else []) if p.strip()]
    if len(parts) <= sentences:
        return " ".join(parts).strip()
    return " ".join(parts[:sentences]).strip() + " The rest is on screen."


def plan_steps(plan: str) -> list[str]:
    """Numbered or bulleted lines are the steps; headings only when there are none."""

    def grab(pattern: str) -> list[str]:
        found = []
        for line in (plan or "").splitlines():
            m = re.match(pattern, line)
            if m:
                step = re.sub(r"[*_`]", "", m.group(1)).strip().rstrip(":")
                if len(step) > 3:
                    found.append(step)
        return found

    return grab(r"^\s*(?:\d+[.)]|[-*])\s+(.+)") or grab(r"^\s*#{2,4}\s+(.+)")


def plan_speech(plan: str, full: bool = False) -> str:
    steps = plan_steps(plan)
    if not steps:
        return speakable(plan, sentences=6 if full else 3)
    shown = steps if full else steps[:5]
    names = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
    said = " ".join(
        f"{names[i] if i < len(names) else i + 1}: {_short(s, 24 if full else 14)}."
        for i, s in enumerate(shown)
    )
    more = "" if full or len(steps) <= 5 else f" And {len(steps) - 5} more on screen."
    return f"The plan has {len(steps)} step{'s' if len(steps) != 1 else ''}. {said}{more}"


def _short(text: str, max_words: int) -> str:
    w = clean_for_speech(text).split()
    return " ".join(w[:max_words]) + ("…" if len(w) > max_words else "")


def approval_speech(approval: dict[str, Any]) -> str:
    """An approval as a spoken question with its answers."""
    kind, tool = approval.get("ask_kind"), approval.get("tool")
    detail = str(approval.get("detail", ""))
    labels = [c["label"] for c in approval.get("choices", [])]
    if kind == "plan":
        return (
            f"{plan_speech(detail)} Shall I go ahead? Say go, go with auto-edits, or keep planning."
        )
    if kind == "question":
        options = "; ".join(f"{i + 1}, {label}" for i, label in enumerate(labels[:-1]))
        return f"{approval.get('question', '')} Options: {options}."
    if tool == "Bash":
        command = detail.removeprefix("$ ").strip()
        spoken = command if len(command.split()) <= 8 else "a command, on screen"
        return f"It wants to run {_verbal(spoken)}. OK?"
    if tool in ("Edit", "MultiEdit", "Write", "NotebookEdit"):
        path = detail.splitlines()[0].split(" (")[0] if detail else "a file"
        verb = "create" if "(new contents)" in detail[:200] else "edit"
        return f"It wants to {verb} {_verbal(path.rsplit('/', 1)[-1])}. OK?"
    return f"{approval.get('question', 'It needs your OK')}. OK?"


def _verbal(code: str) -> str:
    """Enough of a command or file name to say aloud."""
    code = code.replace(".py", " dot py").replace(".js", " dot js").replace(".ts", " dot ts")
    code = code.replace("_", " ").replace("--", " ").replace("|", " pipe ")
    return re.sub(r"\s+", " ", code).strip()


# ── the session in voice focus ──

NARRATE_EVERY = 12.0  # seconds between spoken progress notes
FOLLOW_UP = 10.0  # after JARVIS speaks in code mode, answer back without the wake word


class VoiceCoder:
    """Keeps one Claude Code session in voice focus and speaks for it. `hub` provides
    tasks (the TaskManager), say(text), set_state(), emit() and models."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.focus: int | None = None
        self._narrated = 0.0
        self._last_reply = ""
        self._last_reply_spoken = ""
        self._reply_said = 0
        self._clock = __import__("time").monotonic

    @property
    def task(self):
        return self.hub.tasks.tasks.get(self.focus) if self.focus is not None else None

    def public(self) -> dict[str, Any] | None:
        task = self.task
        if task is None:
            return None
        return {"id": task.id, "folder": task.cwd.name, "mode": task.mode, "busy": task.busy}

    def _changed(self) -> None:
        self.hub.emit("voicecode", focus=self.public())

    # ── entering and leaving ──

    def enter(self, task_id: int) -> str:
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or task.kind != "code":
            return "There's no Jarvis Code session with that number."
        self.focus = task_id
        self._changed()
        return (
            f"Voice coding in {task.cwd.name}, {MODE_NAMES[task.mode].split(':')[0].lower()}. "
            "Everything you say now goes to Jarvis Code; say 'exit code mode' to stop."
        )

    def exit(self) -> None:
        self.focus = None
        self._changed()

    # ── what the user says ──

    async def handle(self, text: str, task: Any = None, typed: bool = False) -> None:
        """One utterance for the focused session, or (typed=True) a slash command typed
        in the panel for any session, answered in its transcript instead of out loud."""
        task = task or self.task
        if task is None:
            self.exit()
            return
        intent = parse(text)
        tasks = self.hub.tasks
        self._typed = typed
        if typed:

            def say(note: str, follow_up: bool = True) -> None:
                tasks._log(task, "note", note)

        else:
            say = self.hub.say
        if intent.kind == "exit":
            self.exit()
            say("Leaving code mode.", follow_up=False)
        elif intent.kind == "interrupt":
            stopped = await tasks.interrupt(task.id)
            say("Stopped." if stopped else "It wasn't doing anything.")
        elif intent.kind == "undo":
            say(await tasks.undo(task.id))
        elif intent.kind == "compact":
            tasks.send(task.id, "/compact")
            say("Compacting the conversation.", follow_up=False)
        elif intent.kind == "mode":
            tasks.set_mode(task.id, intent.arg)
            self._changed()
            if intent.text:
                await self._send(task, intent.text)
                say("Plan mode. Planning that now.", follow_up=False)
            else:
                say(MODE_NAMES[intent.arg])
        elif intent.kind == "changes":
            say(await self.hub.changes_speech(task))
        elif intent.kind == "explain_change":
            await self._send(
                task, await self.hub.explain_change_prompt(task, intent.arg), hint=False
            )
        elif intent.kind == "plan":
            say(plan_speech(task.plan, full=intent.arg) if task.plan else "There's no plan yet.")
        elif intent.kind == "status":
            state = "working" if task.busy else "waiting for you"
            say(f"{task.last_action}. It's {state}.")
        elif intent.kind == "context":
            usage = await tasks.context_usage(task.id)
            say(
                f"About {usage['percent']} percent of the context is used."
                if usage
                else "I can't tell until the session is running."
            )
        elif intent.kind == "cost":
            cost = task.cost_usd or 0
            say(f"This session has cost about {cost:.2f} dollars so far.")
        elif intent.kind == "model":
            model = self.hub.models[intent.arg]
            ok = await tasks.set_model(task.id, model)
            name = self.hub.model_names[intent.arg]
            say(f"Switched this session to {name}." if ok else "Couldn't switch models.")
        elif intent.kind == "new_session":
            fresh = tasks.start("", str(task.cwd), mode=task.mode)
            if self.focus == task.id:
                self.focus = fresh.id
                self._changed()
            self.hub.emit("show_session", id=fresh.id)
            say(f"Fresh session in {task.cwd.name}. What should we do?")
        elif intent.kind == "effort":
            from .tasks import EFFORTS

            current = task.effort or self.hub.settings.task_effort
            index = EFFORTS.index(current) if current in EFFORTS else 2
            effort = {"max": "max", "low": "low"}.get(
                intent.arg, EFFORTS[min(index + 1, len(EFFORTS) - 1)]
            )
            tasks.set_effort(task.id, effort)
            say(
                f"Effort {effort}. {'Thinking as hard as it can.' if effort == 'max' else ''}".strip()
            )
        elif intent.kind == "fork":
            fork = tasks.fork(task.id)
            if fork is None:
                say("There's nothing to fork yet; send it a message first.")
            else:
                if self.focus == task.id:
                    self.focus = fork.id
                    self._changed()
                self.hub.emit("show_session", id=fork.id)
                say("Forked. This copy goes its own way; the original is untouched.")
        elif intent.kind == "rename":
            tasks.rename(task.id, intent.arg)
            say(f"Renamed to {intent.arg}.")
        elif intent.kind == "todos":
            say(todo_speech(task.todos))
        elif intent.kind == "export":
            path = tasks.export(task.id)
            say(
                f"Saved the transcript to {path.name} in Documents, Jarvis, Jarvis Code."
                if path
                else "Nothing to export."
            )
        elif intent.kind == "rewind":
            say(await self._rewind_by_words(task, intent.arg))
        elif intent.kind == "repeat":
            say(self._last_reply_spoken or "I haven't said anything about this session yet.")
        elif intent.kind == "rest":
            rest = self._rest_of_reply()
            say(rest or "That was everything.")
        elif intent.kind == "project":
            say(await self.hub.voice_code(intent.arg))
        elif intent.kind == "resume":
            say(await self.hub.resume_by_voice(task, intent.arg))
        elif intent.kind == "branch":
            branch = await self.hub.current_branch(task)
            say(f"You're on {branch}." if branch else "This folder isn't a git repository.")
        elif intent.kind == "show":
            self.hub.emit("show_session", id=task.id)
            say("It's on screen.", follow_up=False)
        elif intent.kind == "git":
            await self._send(task, GIT_PROMPTS[intent.arg])
            say({"commit": "Committing.", "push": "Pushing.", "pr": "Opening a pull request.",
                 "tests": "Running the tests."}[intent.arg], follow_up=False)  # fmt: skip
        else:
            await self._send(task, intent.text)

    async def _rewind_by_words(self, task, words_said: str) -> str:
        """'Rewind to before the tests': the user message that best matches."""
        said = set(words_said.lower().split()) - {"the", "a", "i", "you", "we", "asked", "said"}
        best, best_score = None, 0.0
        for entry in task.transcript:
            if entry.get("role") != "user" or not entry.get("uuid"):
                continue
            text = set(str(entry.get("text", "")).lower().split())
            score = len(said & text) / max(1, len(said))
            if score > best_score:
                best, best_score = entry, score
        if best is None or best_score < 0.34:
            return "I couldn't tell which message you mean. Say undo that to go back one step."
        return await self.hub.tasks.rewind_to(task.id, best["uuid"])

    def _rest_of_reply(self) -> str:
        """The next few sentences of the last reply ('read the rest')."""
        full = speakable(self._last_reply, sentences=200).removesuffix(" The rest is on screen.")
        parts, tail = split_sentences(full, final=True)
        parts = [p for p in parts + ([tail] if tail.strip() else []) if p.strip()]
        start, self._reply_said = self._reply_said, self._reply_said + 4
        chunk = parts[start : start + 4]
        if not chunk:
            return ""
        more = " There's more; say read the rest." if len(parts) > start + 4 else ""
        return " ".join(chunk) + more

    async def _send(self, task, text: str, hint: bool = True) -> None:
        typed = getattr(self, "_typed", False)
        if hint and not typed:  # typed names are already exact
            text = await self.hub.with_code_hints(task, text)
        self.hub.tasks.send(task.id, text)
        if typed:
            return
        self.hub.acknowledge()  # "On it." right away; the work takes a moment
        self._narrated = self._clock()  # nothing to narrate for a moment
        self.hub.set_state("thinking")

    # ── what the session does ──

    def on_event(self, kind: str, data: dict[str, Any]) -> None:
        task = self.task
        if task is None or data.get("id") != task.id:
            return
        if kind == "task_log":
            entry = data.get("entry") or {}
            if entry.get("role") == "system":
                self._changed()  # a mode change (e.g. a plan approved) shows in the pill
            narrate = self.hub.prefs.code_narrate
            if (
                narrate
                and entry.get("role") == "tool"
                and self._clock() - self._narrated >= NARRATE_EVERY
            ):
                if self.hub.quiet_enough():
                    self._narrated = self._clock()
                    self.hub.say(_narration(entry.get("text", "")), follow_up=False)
        elif kind == "task_log_update" and data.get("status") == "failed":
            if self.hub.quiet_enough() and self._clock() - self._narrated >= 4:
                self._narrated = self._clock()
                self.hub.say("That step failed; it's looking into it.", follow_up=False)
        elif kind == "task_finished":
            self.hub.set_state("idle")
            self._last_reply = task.result or ""
            self._reply_said = self.hub.prefs.code_sentences
            reply = speakable(task.result or "Done.", sentences=self.hub.prefs.code_sentences)
            changed = len(task.files_changed)
            if changed and "file" not in reply.lower():
                reply += f" {changed} file{'s' if changed != 1 else ''} changed."
            self._last_reply_spoken = reply
            self.hub.say(reply)

    def speak_approval(self, approval: dict[str, Any]) -> bool:
        """Put the focused session's approval as a spoken question. False if it's
        another session's (the usual heads-up handles those)."""
        if self.focus is None or approval.get("task_id") != self.focus:
            return False
        self.hub.say(approval_speech(approval))
        return True


def todo_speech(todos: list[dict[str, Any]]) -> str:
    if not todos:
        return "There's no to-do list in this session."
    done = [t for t in todos if t["status"] == "completed"]
    doing = [t for t in todos if t["status"] == "in_progress"]
    left = [t for t in todos if t["status"] == "pending"]
    parts = [f"{len(done)} of {len(todos)} done."]
    if doing:
        parts.append(f"Now: {_short(doing[0]['active'] or doing[0]['content'], 12)}.")
    if left:
        parts.append("Still to do: " + "; ".join(_short(t["content"], 8) for t in left[:3]) + ".")
    return " ".join(parts)


def _narration(action: str) -> str:
    action = action.strip().rstrip(".")
    if action.startswith("Running "):
        command = action[8:]
        return "Running a command." if len(command.split()) > 6 else f"Running {_verbal(command)}."
    return f"{_verbal(action)}." if action else "Working."
