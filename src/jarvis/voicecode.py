"""Claude Code by voice.

"Jarvis, let's code in jarvis" puts a Claude Code session in voice focus. From then on
what you say goes to that session, except the handful of things that are about the
session rather than for it, which are handled here at once:

    plan mode / accept edits / auto mode / full auto      change the permission mode
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

Each is recognized only as a whole, plainly phrased utterance: "use haiku for the
summaries" or "compact the json output" is a request for Claude, never a command.

While it works, JARVIS narrates briefly (what it's editing or running), reads its
replies as a few spoken sentences (the rest is on screen), puts each approval as a
spoken question you answer with "yes", "no, <what to do instead>", "option two" or a
label, and reads a plan as its steps before asking you to approve it.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from typing import Any

from .speech import clean_for_speech, split_sentences
from .tasks import ALLOW_EDITS, ALWAYS, PLAN_APPROVE, PLAN_APPROVE_EDITS, PLAN_KEEP
from .wake import _is_wake_token

MODEL_KEYS = ("opus", "sonnet", "haiku", "fable")
ORDINALS = {
    "first": 0, "one": 0, "1": 0, "1st": 0,
    "second": 1, "two": 1, "2": 1, "2nd": 1,
    "third": 2, "three": 2, "3": 2, "3rd": 2,
    "fourth": 3, "four": 3, "4": 3, "4th": 3,
    "fifth": 4, "five": 4, "5": 4, "5th": 4,
    "sixth": 5, "six": 5, "6": 5, "6th": 5,
}  # fmt: skip

# The mode commands typed in the panel, named as the composer's menu names the modes:
# /auto is Claude Code's Auto (its safety check decides), /bypass runs anything.
SLASH_MODES = {
    "plan": "plan", "ask": "ask", "manual": "ask", "edits": "edits", "auto": "smart", "bypass": "auto",
}  # fmt: skip

# Slash commands typed in the panel, as the words that mean them by voice.
SLASH = {
    "plan": "plan mode",
    "ask": "ask first",
    "edits": "accept edits",
    "manual": "ask first",
    "auto": "auto mode",
    "bypass": "full auto",
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


_LEADING = ("please", "okay", "ok", "so", "now", "and", "hey", "can", "could", "you")


def _tokens(text: str) -> list[str]:
    """Lowercase words and numbers, without the wake word."""
    found = re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))
    return [t for t in found if not _is_wake_token(t)]


def _clean(text: str) -> str:
    w = _tokens(text)
    while w and w[0] in _LEADING:
        w = w[1:]
    return " ".join(w)


def parse(text: str) -> Intent:
    """What an utterance in voice-code mode means. Commands must be the whole utterance,
    plainly phrased; everything else goes to Claude."""
    said = _clean(text)
    n = len(said.split())
    raw = re.sub(r"^\W*(jarvis|jervis|jarvus)\W+", "", text.strip(), flags=re.IGNORECASE)

    def whole(pattern: str, limit: int = 8):
        return re.fullmatch(pattern, said) if 0 < n <= limit else None

    if whole(
        r"(exit|leave|stop|end|quit|close|turn off)( the)?( voice)? (code|coding)( mode)?"
        r"|(that's|thats) all( for now)?|i'm done( coding)?|back to normal"
    ):
        return Intent("exit")
    if whole(
        r"ultrathink|ultra think|think as hard as you can|max(imum)? effort|think really hard"
    ):
        return Intent("effort", "max")
    if whole(
        r"(think|thinks) (harder|more|deeper|carefully)( about (this|it))?|more effort|high effort",
        6,
    ):
        return Intent("effort", "up")
    if whole(r"think less|(be )?quick(er)?( mode| answers)?|low effort|less effort", 6):
        return Intent("effort", "low")
    if whole(r"(fork|branch off)( this| the session| the conversation| it)?( here)?", 5):
        return Intent("fork")
    m = whole(r"(rename|call|name) (this|the) (session|conversation|chat) (to |as )?(?P<t>.+)", 14)
    if m:
        return Intent("rename", m.group("t").strip())
    if whole(
        r"(what's|what is|read( me)?|show( me)?|tell me)( on)? (the |your )?(to ?do|todo)( list)?"
        r"|what's left( to do)?|what are you working on|to ?do list"
    ):
        return Intent("todos")
    if whole(r"(export|save)( the| this)? (transcript|session|conversation)", 6):
        return Intent("export")
    m = whole(r"(rewind|roll back)( the code| the files)? to (before|when) (?P<t>.+)", 14)
    if m:
        return Intent("rewind", m.group("t").strip())
    if whole(r"stop|stop it|stop that|hold on|hold it|wait|cancel|cancel that|pause|halt", 3):
        return Intent("interrupt")
    if whole(
        r"(undo|revert|roll back|rollback)( that| it| this| the last( change| edit| step)?"
        r"| those changes| your( last)? changes?| what you did)?",
        6,
    ):
        return Intent("undo")
    if whole(r"compact( it| this| that| the (conversation|context|session|chat))?"
             r"|compress the (conversation|context)", 5):  # fmt: skip
        return Intent("compact")
    mode = _mode(said)
    if mode:
        rest = re.sub(_MODE_WORDS, " ", said)
        rest = [w for w in rest.split() if w not in _MODE_FILLER]
        if not rest:
            return Intent("mode", mode)
        if mode == "plan":
            return Intent("mode", mode, raw)  # "let's plan the migration": mode, then the ask
        # "full auto and fix the tests": the mode, then the ask without the mode's words
        body = re.sub(r"^\W*((please|okay|ok|so|now)\W+)*", "", raw, flags=re.IGNORECASE)
        lead = re.match(
            r"(switch to |go |use )?(full auto|auto mode|autopilot|bypass( permissions)?"
            r"|auto[- ]?edits?|accept( all)? edits)( mode)?\b"
            r"[\s,.:;-]*((and then|and|then)\b[\s,]*)?",
            body,
            re.IGNORECASE,
        )
        if lead and mode in ("auto", "smart", "edits") and body[lead.end() :].strip():
            return Intent("mode", mode, body[lead.end() :].strip())
    m = whole(
        r"(read|explain|walk me through|tell me about|describe|what's|what is|what was)( me)?"
        r" (the |your )?(?P<o>first|second|third|fourth|fifth|sixth|last|\d+(st|nd|rd|th)?)"
        r"( one)? (change|edit|diff|hunk)( you made| in the diff)?( again)?",
        10,
    )
    if m:
        which = m.group("o")
        return Intent("explain_change", -1 if which == "last" else _nth(which))
    if whole(
        r"(what|which)( files)?( did| have)? you (change|changed|touch|touched|edit|edited)"
        r"( so far| today)?|what's the diff|what is the diff|what('s| has)? changed( so far)?"
        r"|summari[sz]e (the |your )?changes|show me the (diff|changes)|what are the changes( so far)?"
    ):
        return Intent("changes")
    m = whole(
        r"(read|tell me|go over|repeat|show me|what's|what is)( me)?( the| your)?"
        r"( (?P<f>whole|full|entire))? plan( again| please)?"
    )
    if m:
        return Intent("plan", bool(m.group("f")))
    if whole(
        r"status|what are you doing|what're you doing|where are (you|we) at|how's it going"
        r"|are you done( yet)?|progress|what's happening|what's going on",
        6,
    ):
        return Intent("status")
    if whole(
        r"how much context( is| do we have| have (we|you) used)?( left| used| remaining)?"
        r"|(what's|what is|check) the context( usage| left)?|context (usage|left)"
    ):
        return Intent("context")
    if whole(
        r"(what's|what is|how much is) (this|the|it) cost(ing)?( so far| us)?"
        r"|how much (did|has|does) (this|it|the session) cost( so far| us)?"
        r"|how much have (we|i|you) spent( so far)?|what have (we|i|you) spent( so far)?"
    ):
        return Intent("cost")
    m = whole(
        r"(use|switch to|change to|switch the model to|change the model to)( the)?"
        r" (?P<m>opus|sonnet|haiku|fable)( model)?( for this session| now| instead)?"
    )
    if m:
        return Intent("model", m.group("m"))
    if whole(r"(new|fresh) (session|conversation|chat)|start (over|fresh|a new session)", 5):
        return Intent("new_session")
    if whole(r"repeat|repeat that|say that again|what did you say|come again|pardon", 5):
        return Intent("repeat")
    if whole(r"(read|say)( me)? the rest|the rest( please)?|go on reading", 5):
        return Intent("rest")
    m = whole(
        r"(switch to|let's work on|let's switch to|work on|move to|change to)( the)?"
        r" (?P<p>[\w .'-]+?) (project|repo|repository)",
        10,
    )
    if m:
        return Intent("project", m.group("p").strip(), raw)
    m = whole(
        r"(resume|reopen|go back to|pick up)( the| my| our)?( session| conversation| chat)?"
        r"( (from )?(yesterday|last time|earlier))?( about| on| for| called)?"
        r" (?P<t>.+?)( session| conversation| chat)?",
        10,
    )
    # Only when it's plainly about a session: "resume the upload after a failure" isn't.
    if m and re.search(r"\b(session|conversation|chat|yesterday('s)?|last time|earlier)\b", said):
        return Intent("resume", m.group("t").strip(), raw)
    if whole(r"(what|which) branch( am i| are we| is this)?( on)?", 6):
        return Intent("branch")
    if whole(
        r"show( me)?( it| that| the session| the panel| the changes on screen)?"
        r"|open the (panel|deck|session)",
        5,
    ):
        return Intent("show")
    if whole(r"commit( that| this| it| (the |your |these |those )?changes)?( please)?", 6):
        return Intent("git", "commit")
    if whole(r"push( it| that| the branch)?( up)?( please)?", 5):
        return Intent("git", "push")
    if whole(
        r"(open|make|create|raise|file|put up|send) (a |the |an )?(pr|pull request)"
        r"( for (this|it|that|these changes))?( please)?"
    ):
        return Intent("git", "pr")
    if whole(r"(run|rerun|re run) (the |all the )?tests( again| please)?", 6):
        return Intent("git", "tests")
    return Intent("send", text=raw)


def slash_intent(name: str, arg: str) -> Intent | None:
    """A slash command typed in the panel, with what was typed after it ("/plan fix the
    login", "/commit Fix the retry", "/model claude-sonnet-5-5"). None: not one of ours."""
    arg = arg.strip()
    if name == "model":
        key = arg.lower().split()[0] if arg else ""
        if key in MODEL_KEYS:
            return Intent("model", key)
        return Intent("model_id", arg) if arg else None
    if name in SLASH_MODES:
        return Intent("mode", SLASH_MODES[name], arg)
    if name == "commit" and arg:
        return Intent("git", "commit", arg)
    if name in ("test", "tests") and arg:
        return Intent("git", "tests", arg)
    utterance = SLASH.get(name)
    return parse(utterance) if utterance is not None and "{arg}" not in utterance else None


def _nth(word: str) -> int:
    """'second', '2nd' or '2' -> 1."""
    if word[:1].isdigit():
        return int(re.sub(r"\D", "", word)) - 1
    return ORDINALS.get(word, 0)


_MODE_WORDS = (
    r"\b(plan mode|planning mode|switch to plan|plan first|accept( all)? edits|auto[- ]?edits?"
    r"|edit mode|full auto|auto mode|autopilot|bypass( permissions)?|manual mode|ask mode"
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
    if re.search(r"\b(full auto|bypass( permissions)?)\b", said):
        return "auto"  # Bypass permissions: runs anything
    if re.search(r"\b(auto mode|autopilot)\b", said):
        return "smart"  # Claude Code's Auto: its classifier decides what needs asking
    if re.search(r"\b(ask mode|ask (me )?first|ask before|normal mode|default mode)\b", said):
        return "ask"
    return None


MODE_NAMES = {
    "plan": "Plan mode: I'll plan and check with you before changing anything.",
    "ask": "Ask mode: I'll ask before each edit and command.",
    "edits": "Auto-edits: edits go ahead, commands still ask.",
    "smart": "Auto mode: safe steps go ahead, I'll check with you on anything risky.",
    "auto": "Full auto: I'll run anything without asking.",
}


# ── answering JARVIS's questions by voice ──

HOLD = "hold"  # "give me a second": the question stays open
REASK = "reask"  # an answer that doesn't fit this question ("yes" to "which one?"): ask again
LAST = -1

_THROAT = {"um", "umm", "uh", "uhh", "er", "erm", "well", "hmm", "oh", "ah", "so"}
_NUMBERS = {"one": 0, "two": 1, "three": 2, "four": 3, "five": 4, "six": 5}
_PICK = r"(?:(?:let's |i'll )?(?:go with|pick|choose|take|use|do) )?"
_EXPLICIT = (
    re.compile(_PICK + r"(?:option|number|choice|answer) (?P<n>one|two|three|four|five|six|[1-6])(?: please)?"),
    re.compile(_PICK + r"(?:the )?(?P<n>first|second|third|fourth|fifth|sixth|last|[1-6](?:st|nd|rd|th))"
               r"(?: one| option| choice)?(?: please)?"),
    re.compile(r"(?P<n>one|two|three|four|five|six|[1-6])(?: please)?"),
)  # fmt: skip
_HESITATION = re.compile(
    r"(?:(?:um+|uh+|hmm+|erm?|ah+|oh|well|okay|ok|so|just) )*"
    r"(?:(?:hold on|hang on|hold it|hang tight|wait|wait wait)(?: (?:a|one|just a|for a)"
    r" (?:sec|second|moment|minute|min|bit|tick))?"
    r"|(?:(?:give me|gimme|just|wait|hold on|hang on) )?(?:a|one|just a) (?:sec|second|moment|minute|min|bit|tick)"
    r"|let me (?:think|see|check|look|read)(?: about (?:it|that))?(?: (?:a|for a) (?:sec|second|moment|minute|bit))?"
    r"|(?:i'm |i am )?(?:not sure|thinking)(?: yet)?|i don't know(?: yet)?|um+|uh+|hmm+|erm?)"
)  # fmt: skip
_WAITS = re.compile(r"\b(wait|hold on|hang on|one sec|a sec|a second|a moment|one moment)\b")
_NO_WORDS = {
    "no", "nope", "nah", "negative", "nay", "deny", "denied", "cancel", "abort", "stop", "reject",
    "decline", "nevermind",
}  # fmt: skip
_ACTIONS = {
    "do", "run", "allow", "approve", "edit", "change", "touch", "write", "delete", "remove",
    "create", "make", "go", "send", "commit", "push", "install", "use", "execute", "proceed",
    "continue", "start", "accept", "apply", "save", "overwrite", "it", "that", "this",
}  # fmt: skip
_YES = {
    "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed", "correct",
    "go ahead", "go for it", "do it", "run it", "allow", "allow it", "approve", "approved",
    "absolutely", "definitely", "of course", "affirmative", "yes please", "sounds good",
    "looks good", "fine", "alright", "all right", "please do", "proceed", "send it", "send",
}  # fmt: skip
_PLAN_GO = _YES | {
    "go",
    "go on",
    "let's go",
    "let's do it",
    "ship it",
    "start",
    "make it so",
    "great",
    "perfect",
}
# What may follow a plain yes and leave it a plain yes ("yes please, just this once").
_HARMLESS = {
    "please", "thanks", "thank", "you", "just", "this", "once", "time", "only", "for", "now",
    "it", "that", "go", "ahead", "do", "sure", "thing", "but", "ask", "me", "every", "next",
    "again", "keep", "asking", "yes", "yeah", "ok", "okay", "run", "allow", "fine", "great",
    "perfect", "good", "then", "send", "proceed", "approve", "continue", "start", "commit",
    "push", "sounds", "looks", "with", "on", "right",
}  # fmt: skip
_ALWAYS = re.compile(
    r"(?:(?:yes|yeah|yep|sure|ok|okay)(?: and)? )?"
    r"(?:always(?: (?:allow|approve|run|do|accept|say yes to))?(?: (?:it|that|this|those|these|them))?"
    r"|(?:allow|approve|run|do) (?:it |that |this )?always|always allow this"
    r"|(?:don't|dont|do not|never) ask(?: me)?(?: that| this)? again"
    r"(?: (?:for|about) (?:it|that|this|those|these)(?: commands?)?)?)"
    r"(?: please| thanks)?"
)  # fmt: skip
_ALL_EDITS = re.compile(
    r"(?:(?:yes|yeah|yep|sure|ok|okay)(?: and)? )?(?:(?:allow|accept|approve) (?:all )?(?:the )?edits"
    r"(?: (?:this|for the) session)?|(?:to )?all edits|auto ?accept(?: edits)?|auto ?edits)(?: please)?"
)  # fmt: skip
_AUTO_EDITS_GO = re.compile(
    r"(?:(?:yes|yeah|yep|sure|ok|okay|go|go ahead)(?: and)?(?: go)? )?(?:with )?"
    r"(?:auto ?accept(?: (?:all )?edits)?|auto ?edits?|accept (?:all )?edits|(?:and )?accept edits)"
    r"(?: please| on)?"
)  # fmt: skip
_KEEP_PLANNING = re.compile(
    r"keep (?:planning|going with the plan|working on (?:it|the plan))|plan (?:some )?more"
    r"|revise (?:it|the plan)|not yet|change the plan"
)
_SKIP = re.compile(
    r"(?:skip(?: it| this| that| (?:this|that|the) question)?|none(?: of (?:them|those|these))?"
    r"|neither(?: of them)?|pass)(?: please)?"
)
_NO_OPENING = re.compile(
    r"\W*(?:(?:jarvis|okay|ok|oh|um+|uh+|well|so|hmm+)\W+)*"
    r"(?:no|nope|nah|negative|cancel|stop|not now|not yet|not that)\b[\s,.!;:-]*(.*)",
    re.IGNORECASE | re.DOTALL,
)
_GLUE = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "please",
    "let's",
    "go",
    "with",
    "use",
    "i'll",
    "take",
    "pick",
}


def _answer_words(text: str) -> list[str]:
    """A spoken answer's words: lowercase, numbers kept, without the wake word or the
    throat-clearing before it ("um, well, …")."""
    w = _tokens(text)
    while len(w) > 1 and w[0] in _THROAT:
        w = w[1:]
    return w


def explicit_choice(said: str) -> int | None:
    """'option two', 'number 2', 'the second one', 'the last one', or just 'two': which
    option (LAST for the last). Never 'a second', 'one sec' or 'one moment'."""
    for pattern in _EXPLICIT:
        m = pattern.fullmatch(said)
        if m:
            word = m.group("n")
            if word == "last":
                return LAST
            return _NUMBERS[word] if word in _NUMBERS else _nth(word)
    return None


def _label_match(w: list[str], labels: list[str]) -> int | None:
    """The label the answer is mostly made of ("keep planning", "Postgres")."""
    said = set(w) - _GLUE
    best, best_score = None, 0.0
    for i, label in enumerate(labels):
        lab_words = _answer_words(label)
        lab = set(lab_words) - _GLUE
        if not lab:
            continue
        hit = len(lab & said)
        overlap = min(hit / len(lab), hit / max(1, len(said)))
        ratio = difflib.SequenceMatcher(None, " ".join(w), " ".join(lab_words)).ratio()
        score = max(overlap, ratio)
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= 0.6 else None


def pick_choice(text: str, labels: list[str]) -> int | None:
    """'option two', 'the second one', 'the last one', or (enough of) a label's words.
    Numbers count only in those explicit forms: never 'a second', 'one sec' or 'one moment'."""
    w = _answer_words(text)
    if not w or not labels:
        return None
    index = explicit_choice(" ".join(w))
    if index is not None:
        index = len(labels) - 1 if index == LAST else index
        return index if 0 <= index < len(labels) else None
    return _label_match(w, labels)


def _negated(w: list[str]) -> bool:
    """A no anywhere in the answer: "no", "not now", "not Postgres", "don't do that",
    "sure, actually no". ("Don't forget the tests" is an instruction, not a no; "no
    problem" and "why not" aren't one either.)"""
    for k, word in enumerate(w):
        before, after = (w[k - 1] if k else ""), (w[k + 1] if k + 1 < len(w) else "")
        if word == "no" and after in ("problem", "worries", "doubt"):
            continue
        if word in _NO_WORDS:
            return True
        if word == "not" and before not in ("why", "do") and after not in ("sure", "bad", "only"):
            return True
        if word == "never" and after == "mind":
            return True
        if word in ("don't", "dont") or (word == "do" and after == "not"):
            verb = w[k + 2] if word == "do" and k + 2 < len(w) else "" if word == "do" else after
            if not verb or verb in _ACTIONS:
                return True
    return False


def _feedback(text: str, w: list[str]) -> str:
    """What to do instead, as the user said it: "No, use the Makefile" -> "use the
    Makefile"; "don't run the migration, just generate it" -> all of it."""
    if w[0] in ("don't", "dont", "do"):
        rest = re.sub(r"^\W*(?:jarvis\W+)?", "", text.strip(), flags=re.IGNORECASE)
        return rest if len(w) >= 4 else ""
    m = _NO_OPENING.match(text.strip())
    if m is None:  # the no comes later ("yes, but no tests"): all of it
        m = re.search(r"\b(?:but|actually)\b[\s,]*(.*)", text, re.IGNORECASE | re.DOTALL)
    rest = (m.group(1) if m else text).strip()
    rest = re.sub(r"^(?:but|and|instead|actually|rather)\b[\s,]*", "", rest, flags=re.IGNORECASE)
    rest_words = _answer_words(rest)
    if len(rest_words) < 2 or _HESITATION.fullmatch(" ".join(rest_words)):
        return ""
    return rest


def _yes_lead(w: list[str], phrases: set[str] = _YES) -> int:
    """How many words at the start make a yes ("yes please" -> 2), 0 if they don't."""
    for size in (3, 2, 1):
        if len(w) >= size and " ".join(w[:size]) in phrases:
            return size
    return 0


def voice_answer(text: str, approval: dict[str, Any]) -> tuple[str, str] | None:
    """What a spoken reply to one of JARVIS's questions means: (choice id, feedback);
    (HOLD, "") when they asked for a moment; (REASK, "") for an answer that doesn't fit
    this question; None when it isn't an answer at all (a request for Claude, say).

    Safe by construction: a no anywhere wins; numbers count only as "option two" or
    "the second one" (never "a second" or "one sec"); "always" and "allow all edits"
    need those words said plainly and are never reached by a number or a no; and a
    word that opens the question ("Send this to Ben?", "Run the shortcut…?") isn't
    taken as its answer, since it may be JARVIS's own voice heard back."""
    ids = [c["id"] for c in approval.get("choices") or []]
    labels = [c["label"] for c in approval.get("choices") or []]
    if approval.get("ask_kind") == "purchase" and ids:
        from .transactions import is_confirm_phrase

        if is_confirm_phrase(text):  # "confirm purchase", or 确认购买 said in Chinese
            return (ids[0], "")
    w = _answer_words(text)
    if not w or not ids:
        return None
    said = " ".join(w)
    kind = approval.get("ask_kind")
    question = _tokens(str(approval.get("question", "")))
    opener = question[0] if question else ""
    if kind == "question":
        return _question_answer(said, w, ids, labels)
    if kind == "purchase":  # money: only the deliberate phrase (above) is a yes
        return (ids[-1], "") if _negated(w) else (REASK, "")
    if _negated(w):
        return (PLAN_KEEP if kind == "plan" else ids[-1], _feedback(text, w))
    if _HESITATION.fullmatch(said) or _WAITS.search(said):
        return (HOLD, "")
    if kind == "plan":
        return _plan_answer(said, w, ids, labels)
    if ALWAYS in ids and _ALWAYS.fullmatch(said):
        return (ALWAYS, "")
    if ALLOW_EDITS in ids and _ALL_EDITS.fullmatch(said):
        return (ALLOW_EDITS, "")
    lead = _yes_lead(w)
    if lead and w[0] != opener:
        tail = w[lead:]
        if all(t in _HARMLESS for t in tail):
            return (ids[0], "")
        if tail[0] in ("but", "except", "however", "instead"):  # "yes, but use make instead"
            return (ids[-1], _feedback(text, w))
        return (REASK, "")
    index = explicit_choice(said)
    if index is not None:
        index = len(ids) - 1 if index == LAST else index
        if index in (0, len(ids) - 1):
            return (ids[index], "")
        return (REASK, "")  # never "always" or "all edits" by number
    match = _label_match(w, labels)
    if match is not None and ids[match] not in (ALWAYS, ALLOW_EDITS) and w[0] != opener:
        return (ids[match], "")
    return None


def _plan_answer(said: str, w: list[str], ids: list[str], labels: list[str]):
    if PLAN_APPROVE_EDITS in ids and _AUTO_EDITS_GO.fullmatch(said):
        return (PLAN_APPROVE_EDITS, "")  # "go with auto-edits"
    if _KEEP_PLANNING.fullmatch(said):
        return (PLAN_KEEP, "")
    lead = _yes_lead(w, _PLAN_GO)
    if lead and all(
        t in _HARMLESS | {"ask", "before", "edits", "with", "asking"} for t in w[lead:]
    ):
        return (PLAN_APPROVE, "")  # a plain go: it still asks before each edit
    index = explicit_choice(said)
    if index is not None:
        chosen = ids[len(ids) - 1 if index == LAST else index] if index < len(ids) else ""
        return (chosen, "") if chosen in (PLAN_APPROVE, PLAN_KEEP) else (REASK, "")
    match = _label_match(w, labels)
    if match is not None and ids[match] != PLAN_APPROVE_EDITS:
        return (ids[match], "")
    return (REASK, "") if lead else None


def _question_answer(said: str, w: list[str], ids: list[str], labels: list[str]):
    options = [i for i in ids if i != "skip"]
    if "skip" in ids and _SKIP.fullmatch(said):
        return ("skip", "")
    if _HESITATION.fullmatch(said) or _WAITS.search(said):
        return (HOLD, "")
    if _negated(w):
        return (REASK, "")
    index = explicit_choice(said)
    if index is not None:  # "the last one" is the last option, not the unspoken Skip
        index = len(options) - 1 if index == LAST else index
        return (options[index], "") if 0 <= index < len(options) else (REASK, "")
    match = _label_match(w, labels)
    if match is not None:
        return (ids[match], "")
    return (REASK, "") if _yes_lead(w) else None  # "yes" doesn't answer "which one?"


# ── turning Claude Code's output into speech ──


def speakable(text: str, sentences: int = 3) -> str:
    """A reply, a few spoken sentences long; code stays on screen."""
    text = re.sub(r"```.*?```", " (code on screen) ", text or "", flags=re.DOTALL)
    text = text[: 400 * sentences + 4000]  # only what can be said; runs on the hub loop
    # A line start never looks past its own line: blank lines are each tried once.
    text = re.sub(r"^[^\S\n]*#+\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[^\S\n]*(?:[-*]|\d+[.)])\s+", "", text, flags=re.MULTILINE)
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
    """An approval as a spoken question with its answers. It never ends on a word that
    answers it ("…OK?"), which JARVIS could hear back as a yes."""
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
        return f"It wants to run {_verbal(spoken)}. Should it?"
    if tool in ("Edit", "MultiEdit", "Write", "NotebookEdit"):
        path = detail.splitlines()[0].split(" (")[0] if detail else "a file"
        verb = "create" if "(new contents)" in detail[:200] else "edit"
        return f"It wants to {verb} {_verbal(path.rsplit('/', 1)[-1])}. Should it?"
    if tool == "WebFetch":
        match = re.match(r"^\w+://([^/:?#]+)", detail.strip())
        return f"It wants to read a page on {_verbal(match.group(1) if match else 'the web')}. Should it?"
    return f"{approval.get('question', 'It needs your OK')}. Should it?"


def _verbal(code: str) -> str:
    """Enough of a command or file name to say aloud."""
    code = code.replace(".py", " dot py").replace(".js", " dot js").replace(".ts", " dot ts")
    code = code.replace(".com", " dot com").replace(".org", " dot org").replace(".io", " dot io")
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

    async def handle(
        self, text: str, task: Any = None, typed: bool = False, intent: Intent | None = None
    ) -> None:
        """One utterance for the focused session, or (typed=True) a slash command typed
        in the panel for any session, answered in its transcript instead of out loud."""
        task = task or self.task
        if task is None:
            self.exit()
            return
        intent = intent or parse(text)
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
                name = MODE_NAMES[intent.arg].split(":")[0]
                doing = "Planning that now." if intent.arg == "plan" else "On it."
                say(f"{name}. {doing}", follow_up=False)
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
        elif intent.kind == "model_id":
            ok = await tasks.set_model(task.id, intent.arg)
            say(f"Switched this session to {intent.arg}." if ok else "Couldn't switch models.")
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
            later = " From the next step." if task.busy else ""
            max_note = " Thinking as hard as it can." if effort == "max" else ""
            say(f"Effort {effort}.{max_note}{later}")
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
            reply = self._rewind_by_words(task, intent.arg)
            if reply:
                say(reply, follow_up=False)
        elif intent.kind == "repeat":
            say(self._last_reply_spoken or "I haven't said anything about this session yet.")
        elif intent.kind == "rest":
            rest = self._rest_of_reply()
            say(rest or "That was everything.")
        elif intent.kind == "project":
            name = self._project(intent.arg)
            if name is None:  # not a project we know: a request about the code, for Claude
                await self._send(task, intent.text)
            else:
                say(await self.hub.voice_code(name))
        elif intent.kind == "resume":
            say(await self.hub.resume_by_voice(task, intent.arg))
        elif intent.kind == "branch":
            branch = await self.hub.current_branch(task)
            say(f"You're on {branch}." if branch else "This folder isn't a git repository.")
        elif intent.kind == "show":
            self.hub.emit("show_session", id=task.id)
            say("It's on screen.", follow_up=False)
        elif intent.kind == "git":
            prompt = GIT_PROMPTS[intent.arg]
            if intent.text and intent.arg == "commit":
                prompt = (
                    f"Commit the changes you made with this commit message: {intent.text}\n"
                    "Then tell me in one sentence how it went."
                )
            elif intent.text:
                prompt = (
                    f"Run the tests in {intent.text} and tell me the result in a sentence or "
                    "two; if anything fails, say what."
                )
            await self._send(task, prompt, plain=True)  # git's own wording: no ultracode
            say({"commit": "Committing.", "push": "Pushing.", "pr": "Opening a pull request.",
                 "tests": "Running the tests."}[intent.arg], follow_up=False)  # fmt: skip
        else:
            await self._send(task, intent.text)

    def _project(self, spoken: str) -> str | None:
        """The known project a spoken name means ("bsh research center" is
        bsh-research-center), if any."""
        key = re.sub(r"[^a-z0-9]", "", spoken.lower())
        for name in self.hub.tasks.projects():
            if re.sub(r"[^a-z0-9]", "", name.lower()) == key:
                return name
        return None

    def _rewind_by_words(self, task, words_said: str) -> str:
        """'Rewind to before the tests': the most recent user message that best matches,
        once the user says yes (it puts files back, so it asks first)."""
        said = set(words_said.lower().split()) - {"the", "a", "i", "you", "we", "asked", "said"}
        best, best_score = None, 0.0
        for entry in task.transcript:  # later matches win ties: the latest such message
            if entry.get("role") != "user" or not entry.get("uuid"):
                continue
            text = set(str(entry.get("text", "")).lower().split())
            score = len(said & text) / max(1, len(said))
            if score >= best_score and score > 0:
                best, best_score = entry, score
        if best is None or best_score < 0.34:
            return "I couldn't tell which message you mean. Say undo that to go back one step."
        self.hub._spawn(self._confirm_rewind(task, best))
        return ""

    async def _confirm_rewind(self, task, entry: dict[str, Any]) -> None:
        quoted = _short(str(entry.get("text", "")), 12)
        question = f"Put the files back to before “{quoted}”?"
        ok = await self.hub.confirm(question)
        if ok:
            self.hub.say(await self.hub.tasks.rewind_to(task.id, entry["uuid"]), follow_up=False)
        else:
            self.hub.say("Left the files as they are.", follow_up=False)

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

    async def _send(self, task, text: str, hint: bool = True, plain: bool = False) -> None:
        typed = getattr(self, "_typed", False)
        if hint and not typed:  # typed names are already exact
            text = await self.hub.with_code_hints(task, text)
        if plain:
            self.hub.tasks.send(task.id, text, plain=True)
        else:
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
            status = data.get("status", "done")
            if status == "stopped":
                return  # the user stopped it; "Stopped." was said already
            # The turn's own reply (none: "Done."), never an earlier one said again.
            self._last_reply = task.result or ""
            self._reply_said = self.hub.prefs.code_sentences
            if status == "failed" and not task.result:
                reply = "It stopped with an error; the details are on screen."
            else:
                reply = speakable(task.result or "Done.", sentences=self.hub.prefs.code_sentences)
            changed = len(data.get("files") or [])
            if changed and "file" not in reply.lower():
                reply += f" {changed} file{'s' if changed != 1 else ''} changed."
            if data.get("origin") not in (None, "user"):
                reply = f"Heads up: {reply}"  # a turn it took on its own
            self._last_reply_spoken = reply
            self.hub.say(reply)

    def speak_approval(self, approval: dict[str, Any]) -> str:
        """Put the focused session's approval as a spoken question; what was said, or ""
        if it's another session's (the usual heads-up handles those)."""
        if self.focus is None or approval.get("task_id") != self.focus:
            return ""
        spoken = approval_speech(approval)
        self.hub.say(spoken)
        return spoken


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
