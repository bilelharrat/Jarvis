"""What JARVIS knows about the user: short facts, where each was learned, and how sure.

The second brain holds the user's documents; this holds what they told JARVIS about
themselves ("I take my coffee black", "Ann is my co-founder"). Facts go into the system
prompt of every new conversation, and the user can review, change and delete them in
Settings. Stored in ~/Library/Application Support/Jarvis/memory.json.

Memory 2.0: every fact has
- a category (people, preferences, work, health, places, other), guessed from its words
  when nobody says;
- a confidence: sure ("high", what the owner said), fairly sure ("medium", noticed or
  inferred) or not sure ("low");
- an optional last day it holds ("I'm in Tokyo until Friday"): after it the fact goes;
- its provenance: when it was learned (learned), how (source: said in a conversation, added
  in Settings, noticed after a conversation, a suggestion or a dream the owner approved, an
  import, synced from the owner's iPhone through their Jarvis account) and a short excerpt of the owner's words, the file it came from, or the tool
  (origin). Facts kept before memory 2.0 say so ("before"), with the date they had.

A fact is edited in place (its provenance stays; `at` says when it last changed), and the
owner can ask why JARVIS knows something, or have it forget everything learned from one
source or on one day. Passwords, keys and codes are refused, whoever offers them.

Agents (features.agents): a fact can belong to one of the owner's agents ("work", "family");
one with no agent is shared. The store's `agent` is the agent in use: what JARVIS reads (the
prompt, recall, forget, finding by words or id) is the shared facts and that agent's own,
and what it learns belongs to that agent. With no agents made, every fact is shared and
nothing changes. Settings sees and edits all of them.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import jsonstore
from .prefs import APP_SUPPORT
from .textclean import clean_text

log = logging.getLogger("jarvis")

SERVER_NAME = "memory"
MAX_FACTS = 200
MAX_FACT_CHARS = 300
MAX_ORIGIN_CHARS = 160  # an excerpt of the owner's words, a file's name, a tool
PROMPT_FACTS = 80  # newest facts that ride along in the system prompt
MAX_FORGET = 3  # forget() by words sweeps at most this many; more need their own card
MAX_LISTED = 40
CATEGORIES = ("people", "preferences", "work", "health", "places", "other")
CATEGORY_TITLES = {
    "people": "People",
    "preferences": "Preferences",
    "work": "Work",
    "health": "Health",
    "places": "Places",
    "other": "Other",
}
CONFIDENCES = ("high", "medium", "low")
# How a fact was learned. "before": kept before memory 2.0, where it came from unknown.
SOURCES = ("said", "settings", "noticed", "proposed", "dream", "import", "synced", "before")
# The words the owner (or Claude, for them) may use for a source when forgetting by source.
SOURCE_WORDS: dict[str, tuple[str, ...]] = {
    "conversation": ("said", "noticed", "proposed"),
    "conversations": ("said", "noticed", "proposed"),
    "said": ("said",),
    "settings": ("settings",),
    "suggestions": ("noticed", "proposed"),
    "proposed": ("proposed",),
    "noticed": ("noticed",),
    "dream": ("dream",),
    "dreams": ("dream",),
    "dream diary": ("dream",),
    "daily notes": ("dream",),
    "journal": ("dream",),
    "import": ("import",),
    "imports": ("import",),
    "chatgpt": ("import",),
    "claude": ("import",),
    "claude code": ("import",),
    "jarvis code": ("import",),
    "pasted": ("import",),
    "synced": ("synced",),
    "iphone": ("synced",),
    "phone": ("synced",),
    "before": ("before",),
    "old": ("before",),
    "legacy": ("before",),
}
# An import's origin names what it came from; these narrow "import" down to one of them.
IMPORT_ORIGINS = {
    "chatgpt": "ChatGPT",
    "claude": "CLAUDE.md",
    "claude code": "CLAUDE.md",
    "jarvis code": "CLAUDE.md",
    "pasted": "pasted",
}
_COMMON = {
    "the",
    "a",
    "an",
    "that",
    "this",
    "it",
    "is",
    "are",
    "was",
    "my",
    "me",
    "i",
    "user",
    "user's",
    "about",
    "of",
    "to",
    "and",
    "or",
    "in",
    "on",
    "for",
    "with",
    "fact",
    "thing",
}

# Things that must never be stored, even when asked: they'd sit in plain text on disk
# and in every prompt.
_SECRET = re.compile(
    r"(password|passcode|passwd|\bpin\b|api[ _-]?key|secret|token|social security|\bssn\b"
    r"|credit card|card number|cvv|routing number|account number|sk-[a-z0-9-]{8,}"
    r"|\b(?:\d[ -]?){13,19}\b|密码|口令|验证码|卡号|身份证号"
    # A code with its digits ("the door code is 4821", "the code to the garage is 55123"),
    # never a zip code's; a passport's or a licence's number.
    r"|(?<!zip )(?<!postal )(?<!area )\bcode\b[^.\n\d]{0,24}?\d(?:[\s-]?\d){2,}"
    r"|passport\s*(?:number|no\b|#)|passport\W+(?:is\W+)?[a-z]{0,2}\d{6,}"
    r"|licen[cs]e\s*(?:number|no\b|#)|护照号|驾照号|门禁码)",
    re.IGNORECASE,
)

# A fact's category from its words, when nobody said (a fact kept before memory 2.0, one
# typed in Settings, one Claude saved without saying). The first that matches wins, so
# "Ann's dentist is Dr Ruiz" is health before people.
_CATEGORY_WORDS: list[tuple[str, re.Pattern[str]]] = [
    (
        "health",
        re.compile(
            r"\b(?:allerg\w*|doctor|dr\.?|dentist|therap\w*|medic\w*|pills?|diet\w*|vegan"
            r"|vegetarian|gluten|lactose|asthma|diabet\w*|blood|injur\w*|surgery|workouts?"
            r"|gym|sleeps?|sleeping|health\w*|sick|illness|pregnan\w*|physio|symptoms?"
            r"|prescri\w*|hospital|clinic|intoleran\w*)\b"
            r"|过敏|医生|牙医|药|饮食|素食|健身|睡眠|健康|医院|体检|怀孕",
            re.IGNORECASE,
        ),
    ),
    (
        "places",
        re.compile(
            r"\b(?:lives?\s+(?:in|at|on)|living\s+in|address|home\s+is|office\s+is|moved\s+to"
            r"|city|street|avenue|road|apartment|neighbou?rhood|hometown|born\s+in"
            r"|grew\s+up\s+in|based\s+in|parks?\s+(?:at|in)|postcode)\b"
            r"|住在|地址|家在|办公室在|搬到|城市|街|小区|老家|出生在",
            re.IGNORECASE,
        ),
    ),
    (
        "people",
        re.compile(
            r"\b(?:wife|husband|partner|spouse|son|daughter|kids?|children|child|mom|mum"
            r"|mother|dad|father|parents?|sister|brother|sibling|aunt|uncle|cousin|grand\w+"
            r"|friend|girlfriend|boyfriend|fianc\w*|boss|manager|colleague|co-?founder"
            r"|cofounder|assistant|neighbou?r|mentor|investor|lawyer|accountant|nanny"
            r"|birthday|anniversary|named|name\s+is|'s\s+(?:number|email))\b"
            r"|妻子|老婆|丈夫|老公|儿子|女儿|孩子|妈妈|母亲|爸爸|父亲|父母|姐姐|妹妹|哥哥|弟弟"
            r"|朋友|女朋友|男朋友|老板|同事|合伙人|联合创始人|生日|纪念日",
            re.IGNORECASE,
        ),
    ),
    (
        "work",
        re.compile(
            r"\b(?:work\w*|job|company|startup|office|team|clients?|customers?|projects?"
            r"|meetings?|deadline|role|ceo|cto|founder|employer|business|fund|portfolio"
            r"|revenue|product|launch|investors?|board|deck|contract|salary|career|sprint"
            r"|repo|code|engineer\w*|design\w*|manag\w*)\b"
            r"|工作|公司|创业|团队|客户|项目|会议|老板|职位|业务|基金|产品|融资|合同|工资",
            re.IGNORECASE,
        ),
    ),
    (
        "preferences",
        re.compile(
            r"\b(?:likes?|liked|loves?|loved|prefers?|preferred|favou?rite|hates?|dislikes?"
            r"|can't\s+stand|enjoys?|into|fan\s+of|rather|always|never|usually|coffee|tea"
            r"|seat|music|food|wine|beer|style|tone|call\s+me|address\s+me)\b"
            r"|喜欢|爱|偏好|讨厌|不喜欢|最爱|习惯|总是|从不|咖啡|茶|座位|音乐|口味",
            re.IGNORECASE,
        ),
    ),
]


@dataclass
class Fact:
    id: str
    text: str
    at: str  # when it was learned or last changed
    category: str = "other"
    confidence: str = "high"
    expires: str = ""  # the last day it holds (YYYY-MM-DD); "" for as long as it's true
    source: str = "before"  # how it was learned: one of SOURCES
    origin: str = ""  # the owner's words it came from, the file, the tool
    learned: str = ""  # when it was first learned (at changes with every edit)
    agent: str = ""  # the agent it belongs to (features.agents); "" for shared


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", text.lower()))


def signature_of(text: str) -> str:
    """A fact's words, sorted: two wordings with the same words are the same fact."""
    return " ".join(sorted(_words(text)))


def _match_words(text: str) -> set[str]:
    """A fact's words for finding it: "Ann's" is found by "Ann" too."""
    found = _words(text)
    return found | {w[:-2] for w in found if w.endswith("'s") and len(w) > 2}


# Words that never make two wordings of a fact different facts: who it's about said another
# way ("my", "the user's", "their"), articles and joins. Never a negation, a number or a name.
_FILLER = _COMMON | {
    "user",
    "users",
    "user's",
    "their",
    "they",
    "them",
    "his",
    "her",
    "he",
    "she",
    "we",
    "our",
    "your",
    "you",
    "has",
    "have",
    "had",
    "be",
    "been",
    "s",
}


def _content(words: set[str]) -> set[str]:
    """A fact's words that carry what it says: filler aside, "takes" as "take" and "kids" as
    "kid" (so "I take my coffee black" and "The user takes their coffee black" match)."""
    out = set()
    for word in words:
        word = word.replace("'", "")
        if word in _FILLER:
            continue
        if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        out.add(word)
    return out


def _alike(new: set[str], old: set[str]) -> bool:
    """The same fact said again: the very same words that carry meaning, worded another way.
    Two facts that differ in even one such word ("lives in Oakland", "lives in Seattle";
    "likes", "never likes") are two facts, never one silently put over the other: a change
    is an edit, and a conflict is the wiki's to show."""
    a, b = _content(new), _content(old)
    return bool(a and b and a == b)


def _tidy(text: Any) -> str:
    """A fact as it may be kept: nothing hidden in it (a NUL would stop Claude Code from
    starting; a bidi override or TAG letters could say what the approval card doesn't),
    on one line, and short."""
    return " ".join(clean_text(text).split())[:MAX_FACT_CHARS]


def tidy_origin(text: Any) -> str:
    """An excerpt of the owner's words or a file's name, kept as provenance: tidied the way
    facts are, and short."""
    text = " ".join(clean_text(text or "").split())
    if len(text) > MAX_ORIGIN_CHARS:
        text = text[: MAX_ORIGIN_CHARS - 1].rstrip() + "…"
    return text


def guess_category(text: str) -> str:
    """The category a fact's words suggest; "other" when none does."""
    for name, pattern in _CATEGORY_WORDS:
        if pattern.search(text or ""):
            return name
    return "other"


def clean_category(value: Any) -> str:
    """A category as given ("People", "preference", "人物" aside), or "" for none."""
    if not isinstance(value, str):
        return ""
    word = value.strip().lower()
    if word in CATEGORIES:
        return word
    plural = f"{word}s"
    if plural in CATEGORIES:
        return plural
    return {"person": "people", "place": "places", "job": "work", "medical": "health"}.get(word, "")


def clean_confidence(value: Any) -> str:
    """high, medium or low from what Claude or the window gives; "" for none."""
    if not isinstance(value, str):
        return ""
    word = value.strip().lower()
    aliases = {
        "sure": "high",
        "certain": "high",
        "fairly sure": "medium",
        "likely": "medium",
        "probably": "medium",
        "unsure": "low",
        "not sure": "low",
        "guess": "low",
    }
    return word if word in CONFIDENCES else aliases.get(word, "")


def clean_expiry(value: Any, today: date | None = None) -> str:
    """The last day a fact holds, as YYYY-MM-DD ("" for none: "", "never", None). A value
    that isn't a date, or a day already past, is refused (ValueError): a fact that stops
    being true before it's saved isn't worth saving."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("The last day it holds should be a date like 2026-10-12.")
    text = value.strip()
    if text.lower() in ("", "never", "none", "no", "forever", "permanent"):
        return ""
    try:
        day = date.fromisoformat(text[:10])
    except ValueError:
        raise ValueError(f"“{text[:40]}” isn't a date: give it like 2026-10-12.") from None
    if day < (today or date.today()):
        raise ValueError(f"{day.isoformat()} has already passed.")
    return day.isoformat()


def _stored_expiry(value: Any) -> str:
    """An expiry as the file has it: a real date or nothing, never an error."""
    if not isinstance(value, str) or not value:
        return ""
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return ""


def expired(fact: Fact, today: date | None = None) -> bool:
    if not fact.expires:
        return False
    try:
        return date.fromisoformat(fact.expires) < (today or date.today())
    except ValueError:
        return False


def _fact_from(raw: Any) -> Fact | None:
    """A fact from the file, tidied as add() tidies them, or None when it can't be one. A
    fact from before memory 2.0 (no source) is kept with provenance "before", its date as
    when it was learned and its category guessed from its words."""
    if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
        return None
    ident, at = raw.get("id"), raw.get("at")
    if isinstance(ident, bool) or not isinstance(ident, str | int):
        return None
    text = _tidy(raw["text"])
    if not text or not str(ident):
        return None
    at = at[:40] if isinstance(at, str) else ""
    source = raw.get("source")
    source = source if source in SOURCES else "before"
    learned = raw.get("learned")
    return Fact(
        str(ident)[:40],
        text,
        at,
        category=clean_category(raw.get("category")) or guess_category(text),
        confidence=clean_confidence(raw.get("confidence")) or "high",
        expires=_stored_expiry(raw.get("expires")),
        source=source,
        origin=tidy_origin(raw.get("origin")) if isinstance(raw.get("origin"), str) else "",
        learned=learned[:40] if isinstance(learned, str) and learned else at,
        agent=_agent_of(raw.get("agent")),
    )


_AGENT = re.compile(r"[a-z][a-z0-9-]{0,23}")


def _agent_of(value: Any) -> str:
    """An agent's id as kept on a fact ("" for shared, and for anything that isn't one)."""
    return value if isinstance(value, str) and _AGENT.fullmatch(value) else ""


def _day_of(stamp: str) -> str:
    """The YYYY-MM-DD of an ISO time ("" when it isn't one)."""
    try:
        return datetime.fromisoformat(stamp).date().isoformat()
    except (TypeError, ValueError):
        return ""


def _day_words(stamp: str) -> str:
    try:
        when = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return ""
    return f"{when:%A} {when.day} {when:%B %Y}"


def why(fact: Fact) -> str:
    """Where and when a fact was learned, in a sentence (for Claude, which says it in the
    owner's language)."""
    day = _day_words(fact.learned or fact.at)
    on = f" on {day}" if day else ""
    quote = f" (“{fact.origin}”)" if fact.origin else ""
    if fact.source == "said":
        how = f"you told me{on}{quote}"
    elif fact.source == "settings":
        how = f"you added it in Settings{on}"
    elif fact.source == "noticed":
        how = f"I noticed it in what you said{on}{quote} and kept it"
    elif fact.source == "proposed":
        how = f"I suggested it after a conversation{on}{quote} and you approved it"
    elif fact.source == "dream":
        how = f"I found it going over your daily notes{on}{quote} and you approved it"
    elif fact.source == "import":
        what = f" from {fact.origin}" if fact.origin else ""
        how = f"you imported it{what}{on}"
    else:
        how = (
            f"you told me before my memory kept track of where things came from (saved{on})"
            if day
            else "you told me before my memory kept track of where things came from"
        )
    changed = ""
    if fact.at and fact.learned and fact.at != fact.learned and _day_words(fact.at):
        changed = f"; last changed on {_day_words(fact.at)}"
    return f"“{fact.text}”: {how}{changed}."


class MemoryStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "memory.json"
        self.facts: list[Fact] = []
        self.forgotten: list[Fact] = []  # what the last add() let go to make room
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self.migrated = 0  # facts read from before memory 2.0 (saved in the new form later)
        self.agent = ""  # the agent in use (features.agents): what it reads and learns
        self.load()

    def mine(self, fact: Fact) -> bool:
        """Whether the agent in use reads this fact: shared, or its own."""
        return not fact.agent or fact.agent == self.agent

    def _visible(self) -> list[Fact]:
        return [f for f in self.facts if self.mine(f)]

    def load(self) -> None:
        """The newest MAX_FACTS facts that can be read (a file with more is no slower to
        open). One that can't be read is skipped; a damaged file is kept aside and its last
        good copy read; one that can't be read just now is left alone. A fact whose last
        day has passed isn't kept."""
        self.unreadable = ""
        try:
            data = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("memory: %s can't be read (%s); leaving it be", self.path.name, exc)
            return
        kept: list[Fact] = []
        migrated = 0
        today = date.today()
        for raw in reversed(data or []):
            fact = _fact_from(raw)
            if fact is None or expired(fact, today):
                continue
            migrated += isinstance(raw, dict) and raw.get("source") not in SOURCES
            kept.append(fact)
            if len(kept) == MAX_FACTS:
                break
        self.facts = kept[::-1]
        self.migrated = migrated

    def save(self, *, keep_copy: bool = True) -> None:
        """keep_copy False: nothing just forgotten is left behind in the backup copy."""
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(f) for f in self.facts], backup=keep_copy)
        self.migrated = 0

    def _saved(self, before: list[Fact], undo: Callable[[], None] | None = None, **kw) -> None:
        """Save, or put everything back as it was and say why (ValueError)."""
        try:
            self.save(**kw)
        except OSError as exc:  # a full disk, a file it can't read: nothing changes
            self.facts = before
            if undo is not None:
                undo()
            raise ValueError(
                f"I couldn't save that just now ({exc.strerror or exc}), so nothing changed."
            ) from None

    def room(self) -> int:
        return max(0, MAX_FACTS - len(self.facts))

    def add(
        self,
        text: str,
        *,
        category: str | None = None,
        confidence: str | None = None,
        expires: str | None = "",
        source: str = "settings",
        origin: str = "",
        make_room: bool = True,
    ) -> Fact:
        """Remember a fact, saved before this returns: one that can't be saved is dropped
        (ValueError), so what's known always matches the file. When it's full, the oldest
        fact makes room (make_room False: refused instead), and forgotten says which."""
        text = _tidy(text)  # before the checks: "pass\u200dword" is a password too
        if not text:
            raise ValueError("Nothing to remember.")
        if _SECRET.search(text):
            raise ValueError(
                "That looks like a password, key or account number; I don't keep those."
            )
        kind = clean_category(category)
        sure = clean_confidence(confidence) or "high"
        until = clean_expiry(expires)
        source = source if source in SOURCES else "settings"
        origin = tidy_origin(origin)
        before, self.forgotten = list(self.facts), []
        # The same fact said again replaces the old wording rather than piling up.
        new = _words(text)
        fact = next((f for f in self._visible() if _alike(new, _words(f.text))), None)
        was = replace(fact) if fact is not None else None
        now = _now()
        if fact is not None:
            fact.text, fact.at, fact.confidence, fact.expires = text, now, sure, until
            fact.category = kind or fact.category
            fact.source, fact.origin = source, origin
            fact.learned = fact.learned or now
        else:
            if not make_room and not self.room():
                raise ValueError(f"My memory is full ({MAX_FACTS} facts); forget some first.")
            fact = Fact(
                uuid.uuid4().hex[:8],
                text,
                now,
                category=kind or guess_category(text),
                confidence=sure,
                expires=until,
                source=source,
                origin=origin,
                learned=now,
                agent=_agent_of(self.agent),
            )
            self.facts.append(fact)
            self.forgotten = self.facts[:-MAX_FACTS]
            del self.facts[:-MAX_FACTS]

        def undo() -> None:
            self.forgotten = []
            if was is not None:
                for name, value in asdict(was).items():
                    setattr(fact, name, value)

        try:
            self.save()
        except OSError as exc:  # a full disk, a file it can't read: nothing changes
            self.facts = before
            undo()
            raise ValueError(
                f"I couldn't save that just now ({exc.strerror or exc}), so I haven't "
                "remembered it."
            ) from None
        return fact

    def add_many(
        self, items: Iterable[dict[str, Any]], *, source: str, origin: str = ""
    ) -> tuple[list[Fact], list[str]]:
        """Several facts at once (an import, a batch of suggestions), in one save. Nothing
        old is let go to make room: what doesn't fit is handed back unsaved, with anything
        refused (a secret, nothing to keep). Returns (saved, not saved)."""
        before = list(self.facts)
        saved: list[Fact] = []
        left: list[str] = []
        now = _now()
        for item in items:
            text = _tidy(item.get("text", ""))
            if not text or _SECRET.search(text):
                if text:
                    left.append(text)
                continue
            try:
                until = clean_expiry(item.get("expires") or "")
            except ValueError:
                until = ""
            new = _words(text)
            same = next((f for f in self._visible() if _alike(new, _words(f.text))), None)
            if same is not None:  # already known: nothing to add
                continue
            if not self.room():
                left.append(text)
                continue
            fact = Fact(
                uuid.uuid4().hex[:8],
                text,
                now,
                category=clean_category(item.get("category")) or guess_category(text),
                confidence=clean_confidence(item.get("confidence")) or "high",
                expires=until,
                source=source if source in SOURCES else "settings",
                origin=tidy_origin(item.get("origin") or origin),
                learned=now,
                agent=_agent_of(self.agent),
            )
            self.facts.append(fact)
            saved.append(fact)
        if saved:
            self._saved(before)
        return saved, left

    def apply_synced(
        self, changes: Iterable[dict[str, Any]], gone: Iterable[str]
    ) -> tuple[list[str], list[str]]:
        """What the owner's other devices changed (account_sync), in one save: each change
        ({id, text, category, at}) puts that fact in place, and the ids in gone are removed.
        A fact of the Mac's own keeps its provenance (source, origin, when learned, how
        sure, its last day); a new one is "synced". Words the Mac never keeps (a password, a
        code) are left out, and nothing old is let go to make room: a new fact that doesn't
        fit waits. Returns (the ids put in place, the ids removed); ValueError when it
        can't be saved (nothing changes)."""
        before = [replace(f) for f in self.facts]
        by_id = {f.id: f for f in self.facts}
        placed: list[str] = []
        for change in changes:
            ident = str(change.get("id") or "")[:40]
            text = _tidy(change.get("text", ""))
            if not ident or not text or _SECRET.search(text):
                continue
            at = str(change.get("at") or "")[:40] or _now()
            fact = by_id.get(ident)
            if fact is not None:
                if fact.agent:
                    continue  # an agent's own fact isn't synced
                fact.text, fact.at = text, at
                fact.category = clean_category(change.get("category")) or fact.category
                fact.learned = fact.learned or at
            else:
                if not self.room():
                    continue
                fact = Fact(
                    ident,
                    text,
                    at,
                    category=clean_category(change.get("category")) or guess_category(text),
                    source="synced",
                    origin=tidy_origin(change.get("origin") or ""),
                    learned=at,
                )
                self.facts.append(fact)
                by_id[ident] = fact
            placed.append(ident)
        drop = {str(i) for i in gone} & {f.id for f in self.facts if not f.agent}
        if drop:
            self.facts = [f for f in self.facts if f.id not in drop]
        if placed or drop:
            try:
                self.save(keep_copy=not drop)
            except OSError as exc:
                self.facts = before
                raise ValueError(
                    f"I couldn't save that just now ({exc.strerror or exc}), so nothing changed."
                ) from None
        return placed, sorted(drop)

    def find(self, key: str, anyone: bool = False) -> list[Fact]:
        """By id, or the facts containing all the given words (common words don't count):
        the agent in use's (anyone: every agent's, for Settings)."""
        key = (key or "").strip()
        if not key:
            return []
        wanted = _words(key) - _COMMON
        facts = self.facts if anyone else self._visible()
        return [f for f in facts if f.id == key or (wanted and wanted <= _match_words(f.text))]

    def get(self, ident: str) -> Fact | None:
        return next((f for f in self.facts if f.id == ident), None)

    def forget(self, key: str, anyone: bool = False) -> list[Fact]:
        """Remove by id, or the facts containing all the given words (common words don't
        count). Refuses to sweep up more than a few at once. anyone: as find's."""
        gone = self.find(key, anyone)
        if len(gone) > MAX_FORGET:
            raise ValueError(f"That matches {len(gone)} facts; say which one.")
        if gone:
            before = self.facts
            self.facts = [f for f in self.facts if f not in gone]
            try:
                self.save(keep_copy=False)
            except OSError as exc:
                self.facts = before
                raise ValueError(
                    f"I couldn't save that just now ({exc.strerror or exc}), so nothing "
                    "was forgotten."
                ) from None
        return gone

    def remove(self, facts: Iterable[Fact]) -> list[Fact]:
        """These facts (any number: the caller asked the owner first), gone and saved with
        no copy of them left behind."""
        ids = {f.id for f in facts}
        gone = [f for f in self.facts if f.id in ids]
        if gone:
            before = self.facts
            self.facts = [f for f in self.facts if f.id not in ids]
            try:
                self.save(keep_copy=False)
            except OSError as exc:
                self.facts = before
                raise ValueError(
                    f"I couldn't save that just now ({exc.strerror or exc}), so nothing "
                    "was forgotten."
                ) from None
        return gone

    def restore(self, facts: Iterable[Fact]) -> list[Fact]:
        """Facts put back as they were (an undo of a forget): their ids and provenance
        kept, in the order they were learned, as room allows."""
        before = list(self.facts)
        known = {f.id for f in self.facts}
        back = [replace(f) for f in facts if f.id not in known][: self.room()]
        if back:
            self.facts = sorted(self.facts + back, key=lambda f: f.learned or f.at)
            self._saved(before)
        return back

    def edit(
        self,
        ident: str,
        *,
        text: str | None = None,
        category: str | None = None,
        confidence: str | None = None,
        expires: str | None = None,
    ) -> tuple[Fact, Fact]:
        """Change a fact in place: its words, category, confidence or last day (None leaves
        each as it is; expires "" clears it). Its provenance stays, and `at` says when it
        changed. Returns (the fact now, a copy of it before). ValueError says what's wrong."""
        fact = self.get(ident)
        if fact is None:
            raise ValueError("I don't have that fact any more.")
        was = replace(fact)
        changes: dict[str, Any] = {}
        if text is not None:
            words = _tidy(text)
            if not words:
                raise ValueError("A fact needs some words.")
            if _SECRET.search(words):
                raise ValueError(
                    "That looks like a password, key or account number; I don't keep those."
                )
            changes["text"] = words
        if category is not None:
            kind = clean_category(category)
            if not kind:
                raise ValueError(f"The categories are {', '.join(CATEGORIES)}.")
            changes["category"] = kind
        if confidence is not None:
            sure = clean_confidence(confidence)
            if not sure:
                raise ValueError("How sure: high, medium or low.")
            changes["confidence"] = sure
        if expires is not None:
            changes["expires"] = clean_expiry(expires)
        changes = {k: v for k, v in changes.items() if getattr(fact, k) != v}
        if not changes:
            return fact, was
        before = list(self.facts)
        for name, value in changes.items():
            setattr(fact, name, value)
        fact.at = _now()
        fact.learned = fact.learned or was.at

        def undo() -> None:
            for name, value in asdict(was).items():
                setattr(fact, name, value)

        self._saved(before, undo)
        return fact, was

    def where(
        self,
        source: str = "",
        day: str = "",
        since: str = "",
        until: str = "",
    ) -> list[Fact]:
        """The facts learned from a source ("chatgpt", "dreams", "settings", "before"…),
        on a day, or between two days (YYYY-MM-DD, both included); every condition given
        must hold. ValueError for a source or day it doesn't know."""
        source = (source or "").strip().lower()
        kinds: tuple[str, ...] = ()
        narrow = ""
        if source:
            if source not in SOURCE_WORDS:
                raise ValueError(
                    "I can forget by where I learned things: conversations, Settings, "
                    "suggestions, the dream diary, imports (ChatGPT, Jarvis Code, a pasted "
                    "list) or from before memory 2.0."
                )
            kinds = SOURCE_WORDS[source]
            narrow = IMPORT_ORIGINS.get(source, "")
        days = []
        for value in (day, since, until):
            value = (value or "").strip()
            if value:
                try:
                    value = date.fromisoformat(value[:10]).isoformat()
                except ValueError:
                    raise ValueError(
                        f"“{value[:40]}” isn't a date: give it like 2026-09-22."
                    ) from None
            days.append(value)
        day, since, until = days
        if not (kinds or day or since or until):
            return []
        found = []
        for fact in self._visible():
            learned = _day_of(fact.learned or fact.at)
            if kinds and fact.source not in kinds:
                continue
            if narrow and narrow.lower() not in fact.origin.lower():
                continue
            if day and learned != day:
                continue
            if since and (not learned or learned < since):
                continue
            if until and (not learned or learned > until):
                continue
            found.append(fact)
        return found

    def sweep(self, today: date | None = None) -> list[Fact]:
        """Facts whose last day has passed, taken out and saved (no copy left)."""
        gone = [f for f in self.facts if expired(f, today)]
        if gone:
            try:
                self.remove(gone)
            except ValueError:
                return []
        return gone

    def search(self, query: str) -> list[Fact]:
        live = [f for f in self._visible() if not expired(f)]
        kind = clean_category(query)
        if kind:  # "people", "preferences": that category's facts
            return [f for f in reversed(live) if f.category == kind]
        wanted = _words(query)
        if not wanted:
            return list(live)
        scored = [(len(wanted & _match_words(f.text)), f) for f in live]
        return [f for score, f in sorted(scored, key=lambda s: -s[0]) if score]

    def prompt_block(self) -> str:
        """The newest facts still true, grouped by category, with how sure and until when
        where that isn't plain."""
        live = [f for f in self._visible() if not expired(f)][-PROMPT_FACTS:]
        if not live:
            return ""
        lines: list[str] = []
        for kind in CATEGORIES:
            group = [f for f in live if f.category == kind]
            if group:
                lines.append(f"{CATEGORY_TITLES[kind]}:")
                lines += [f"- {_prompt_line(f)}" for f in group]
        stray = [f for f in live if f.category not in CATEGORIES]  # appended by hand
        lines += [f"- {_prompt_line(f)}" for f in stray]
        return (
            "\n\nWhat you know about the user, from what they told you or approved (use it "
            "naturally; don't recite it; facts marked fairly or not sure aren't confirmed, "
            "and one with an end date stops being true after it):\n" + "\n".join(lines)
        )

    def counts(self) -> dict[str, int]:
        found = {kind: 0 for kind in CATEGORIES}
        for fact in self.facts:
            found[fact.category] = found.get(fact.category, 0) + 1
        return found

    def public(self) -> list[dict[str, Any]]:
        return [asdict(f) for f in reversed(self.facts)]


def _prompt_line(fact: Fact) -> str:
    notes = []
    if fact.confidence == "medium":
        notes.append("fairly sure")
    elif fact.confidence == "low":
        notes.append("not sure")
    if fact.expires:
        notes.append(f"until {fact.expires}")
    return fact.text + (f" ({'; '.join(notes)})" if notes else "")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _text(text: str, error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        result["is_error"] = True
    return result


async def _always(_action: str, _question: str) -> bool:
    return True


Gate = Callable[[str, str], Awaitable[bool]]
Confirm = Callable[[str, str], Awaitable[bool]]


def _listed(facts: list[Fact]) -> str:
    lines = []
    for f in facts[:MAX_LISTED]:
        notes = [f.category]
        if f.confidence != "high":
            notes.append({"medium": "fairly sure", "low": "not sure"}[f.confidence])
        if f.expires:
            notes.append(f"until {f.expires}")
        lines.append(f"[{f.id}] {f.text} ({'; '.join(notes)})")
    more = len(facts) - MAX_LISTED
    return "\n".join(lines) + (f"\n…and {more} more." if more > 0 else "")


def build_tools(
    store: MemoryStore,
    on_change: Callable[[], Any] | None = None,
    gate: Gate = _always,
    *,
    provenance: Callable[[], tuple[str, str]] | None = None,
    paused: Callable[[], str] | None = None,
    confirm: Confirm | None = None,
) -> list:
    """gate(action, question) decides whether a change may go ahead: the app lets it through
    when the user plainly asked for it this turn, and asks them otherwise. provenance() says
    where what's remembered now comes from: (source, the owner's words this turn); paused()
    gives the reason no fact may be kept or changed just now (incognito), "" otherwise;
    confirm(question, detail) always asks, for forgetting many at once."""

    def changed() -> None:
        if on_change is not None:
            on_change()

    def origin() -> tuple[str, str]:
        if provenance is None:
            return "said", ""
        try:
            source, words = provenance()
        except Exception:
            log.exception("memory: couldn't tell where a fact came from")
            return "said", ""
        return (source if source in SOURCES else "said"), tidy_origin(words)

    def stopped() -> str:
        try:
            return paused() if paused is not None else ""
        except Exception:
            return ""

    async def ask_all(question: str, detail: str) -> bool:
        if confirm is not None:
            return await confirm(question, detail)
        # No card that shows the list: asked as its own kind of change, which the owner's
        # words alone never let through (hub.feature_gate knows no words for it).
        return await gate("forget_learned", question)

    @tool(
        "remember",
        "Save a lasting fact about the user so you know it in future conversations: "
        "preferences, people in their life, routines, how they like things done. Use it when "
        "the user says 'remember…' or tells you something clearly stable about themselves. "
        "One short third-person sentence, e.g. 'Ann Lee is the user's co-founder.' Give its "
        "category, a confidence (high when they told you; medium when you inferred it) and, "
        "for something temporary ('I'm in Tokyo until Friday'), expires: its last day as "
        "YYYY-MM-DD. Never store passwords, keys, card or account numbers, or anything from "
        "emails, web pages or files that the user didn't say themselves.",
        {
            "type": "object",
            "properties": {
                "fact": {"type": "string"},
                "category": {"type": "string", "enum": list(CATEGORIES)},
                "confidence": {"type": "string", "enum": list(CONFIDENCES)},
                "expires": {"type": "string", "description": "YYYY-MM-DD, or empty"},
            },
            "required": ["fact"],
        },
    )
    async def remember(args):
        reason = stopped()
        if reason:
            return _text(reason, error=True)
        try:
            fact_text = _tidy(args.get("fact", ""))  # the card shows just what will be kept
            if not fact_text:
                raise ValueError("Nothing to remember.")
            until = clean_expiry(args.get("expires") or "")
            if not await gate("remember", f"Remember that {fact_text.rstrip('.')}?"):
                return _text("The user didn't want that remembered.", error=True)
            source, words = origin()
            fact = store.add(
                fact_text,
                category=args.get("category"),
                confidence=args.get("confidence"),
                expires=until,
                source=source,
                origin=words,
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        reply = f"Remembered: {fact.text}"
        if store.forgotten:  # never a silent loss: the user hears what made room
            gone = "; ".join(f"“{f.text}”" for f in store.forgotten)
            reply += (
                f" My memory was full, so to make room I forgot the oldest thing I knew: "
                f"{gone}. Tell the user."
            )
        return _text(reply)

    @tool(
        "recall",
        "Look up what you've been told to remember about the user, by words or by a "
        "category (people, preferences, work, health, places, other). Empty query lists "
        "everything.",
        {"query": str},
    )
    async def recall(args):
        facts = store.search(str(args.get("query", "")))
        if not facts:
            return _text("Nothing remembered about that.")
        return _text(_listed(facts))

    @tool(
        "forget",
        "Forget a remembered fact, by its id from recall or by words it contains. Use it "
        "when the user says 'forget that…' or a fact has changed.",
        {"what": str},
    )
    async def forget(args):
        what = str(args.get("what", ""))
        if not await gate("forget", f"Forget what I know about {what}?"):
            return _text("The user said no.", error=True)
        try:
            gone = store.forget(what)
        except ValueError as exc:
            return _text(str(exc), error=True)
        if not gone:
            return _text("I had nothing like that remembered.")
        changed()
        return _text("Forgot: " + "; ".join(f.text for f in gone))

    @tool(
        "edit_memory",
        "Correct a remembered fact in place, by its id from recall or words it contains: new "
        "words, its category, how sure you are (high, medium, low) or its last day "
        "(YYYY-MM-DD; 'never' clears it). Where it was learned stays on record. Use it when "
        "the user corrects something you know ('actually Ann is my co-founder, not my "
        "partner') instead of forgetting and remembering again.",
        {
            "type": "object",
            "properties": {
                "what": {"type": "string"},
                "text": {"type": "string"},
                "category": {"type": "string", "enum": list(CATEGORIES)},
                "confidence": {"type": "string", "enum": list(CONFIDENCES)},
                "expires": {"type": "string"},
            },
            "required": ["what"],
        },
    )
    async def edit_memory(args):
        reason = stopped()
        if reason:
            return _text(reason, error=True)
        found = store.find(str(args.get("what", "")))
        if not found:
            return _text("I have nothing like that remembered.", error=True)
        if len(found) > 1:
            return _text(
                "That matches several facts; say which one (by id):\n" + _listed(found),
                error=True,
            )
        fact = found[0]
        fields = {k: args.get(k) for k in ("text", "category", "confidence", "expires")}
        fields = {k: v for k, v in fields.items() if isinstance(v, str) and v.strip()}
        if not fields:
            return _text("Say what to change: its words, category, confidence or last day.")
        try:
            if "expires" in fields:
                fields["expires"] = clean_expiry(fields["expires"])
            new_text = _tidy(fields.get("text", fact.text))
            if new_text != fact.text:
                question = f"Change “{fact.text}” to “{new_text}”?"
            else:
                question = f"Change what I know: “{fact.text}”?"
            if not await gate("edit_memory", question):
                return _text("The user didn't want that changed.", error=True)
            fact, was = store.edit(fact.id, **fields)
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        return _text(f"Updated: {fact.text} ({fact.category}). It was: {was.text}")

    @tool(
        "why_i_know",
        "Say where and when you learned something about the user ('why do you know that?', "
        "'how do you know my sister's name?'): by a fact's id from recall or words in it.",
        {"what": str},
    )
    async def why_i_know(args):
        what = str(args.get("what", ""))
        found = store.find(what) or store.search(what)[:3]
        if not found:
            return _text("Nothing I remember matches that.")
        return _text("\n".join(why(f) for f in found[:5]))

    @tool(
        "forget_learned",
        "Forget everything you learned from one source or on one day, when the user asks "
        "('forget everything you learned from the ChatGPT import', 'forget what you learned "
        "yesterday'). source: conversations, settings, suggestions, dream diary, imports, "
        "chatgpt, claude code, pasted, or before (from before memory 2.0). date: one day, "
        "or since/until for a stretch (YYYY-MM-DD). The user confirms the list first.",
        {
            "type": "object",
            "properties": {
                "source": {"type": "string"},
                "date": {"type": "string"},
                "since": {"type": "string"},
                "until": {"type": "string"},
            },
        },
    )
    async def forget_learned(args):
        try:
            found = store.where(
                str(args.get("source") or ""),
                str(args.get("date") or ""),
                str(args.get("since") or ""),
                str(args.get("until") or ""),
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        if not found:
            return _text("Nothing I remember came from there.")
        n = len(found)
        question = f"Forget {n} thing{'s' if n != 1 else ''} I learned that way?"
        detail = "\n".join(f"• {f.text}" for f in found[:5])
        if n > 5:
            detail += f"\n…and {n - 5} more."
        # One or a few, plainly asked for: as forget. More than that always shows its list.
        ok = await (ask_all(question, detail) if n > MAX_FORGET else gate("forget", question))
        if not ok:
            return _text("The user said no; nothing was forgotten.", error=True)
        try:
            gone = store.remove(found)
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        listed = "; ".join(f.text for f in gone[:10])
        more = f" and {len(gone) - 10} more" if len(gone) > 10 else ""
        return _text(f"Forgot {len(gone)}: {listed}{more}.")

    return [remember, recall, forget, edit_memory, why_i_know, forget_learned]


def build_server(store: MemoryStore, on_change=None, gate=_always, **extra: Any):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.2.0", tools=build_tools(store, on_change, gate, **extra)
    )
