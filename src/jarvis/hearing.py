"""The owner's own words, learned so JARVIS hears them right.

Whisper knows English, not the owner's colleagues, companies and projects. This learns
their vocabulary and uses it two ways:

- corrections: "no, I said Okin", "I meant Hormuz", "not akin, Okin" (and 我说的是…,
  不是…是…), or a transcript edited in the window, teach misheard -> meant. From then on
  the misheard form is replaced, whole words only, before a request is acted on, and the
  word goes to Whisper as a hotword;
- their own words: names and unusual words they say or type often become hotwords;
- names: people in upcoming meetings, what memory holds, Contacts they've mentioned.
  These are hints only: a name never rewrites what was heard.

Only the owner's own words teach it: what they said or typed to JARVIS, never an email,
a page or a file JARVIS read (those never reach owner_said; the tools are gated like
memory's). A correction is undone by saying it the other way round, by forget_word, or in
Settings. Kept in ~/Library/Application Support/Jarvis/hearing.json, capped; no request
is stored, only the words and mappings learned from them.
"""

from __future__ import annotations

import difflib
import functools
import logging
import re
import time
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import jsonstore
from .prefs import APP_SUPPORT
from .textclean import clean_text

log = logging.getLogger("jarvis")

SERVER_NAME = "hearing"
MAX_CORRECTIONS = 300
MAX_WORDS = 1000
MAX_SEEDS = 60  # per source
MAX_TERM_CHARS = 40
MAX_SPAN_WORDS = 4  # a correction is a name or a short phrase, not a sentence
HOTWORDS = 30  # terms handed to Whisper (its prompt holds ~224 tokens in all)
HOTWORD_CHARS = 250
SAID_ENOUGH = 3  # a word the owner used this often is worth a hint
CORRECTION_SECONDS = 180  # "no, I said…" refers to a request this recent
RECENT_HEARD = 8
EDIT_SECONDS = 600  # a transcript edited in the window this soon after it was heard
EDITED = 0.7  # how alike the sent text must be to the dictated one to count as an edit
SIMILAR = 0.5  # how alike misheard and meant must sound (letters or consonants)
SIMILAR_GUESS = 0.6  # the same, when the owner didn't say which words were misheard
SAVE_EVERY = 60.0  # usage counts are saved at most this often; corrections at once
WAKE_WORDS = ("jarvis", "贾维斯")

# Frequent English words: one of these alone is too easy to mishear on purpose or by
# accident, so as the misheard side it takes two corrections before it's replaced, and
# none of them is ever a "word the owner uses".
COMMON = frozenset(
    """a about above after again all also am an and any are as at back be because been
    before being below between both but by call can come could day did do does doing
    done down each email even every few find first for from get give go going good got
    had has have having he her here him his how i if in into is it its just know last
    let like look make many me meeting message more most my new next no nor not now of
    off on once one only open or other our out over own please put read remind right
    said same say see send set she should show so some start stop such take tell text
    than thank thanks that the their them then there these they thing think this those
    through time to today tomorrow too two under until up us very want was way we week
    well were what when where which while who why will with would write yes yet you
    your""".split()
)
_ZH_COMMON = frozenset("的 了 是 我 你 他 她 在 有 和 不 这 那 一 个 吗 呢 吧".split())

_TOKEN = re.compile(r"[\w][\w'’.-]*[\w]|[\w]")
_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_QUOTE = "\"'“”‘’「」『』"
_LEAD = r"^(?:(?:no|nope|sorry|wait|actually|oops|jarvis|well|hey)\b[\s,.!:;-]*)*"
_SPAN = r"[\"“'‘]?(?P<{name}>[^\"”’,.!?;:]+?)[\"”'’]?"
_EN_SAID = re.compile(
    _LEAD
    + r"(?:i\s+(?:said|say|meant|mean|was\s+saying|was\s+asking\s+(?:about|for))"
    + r"|what\s+i\s+(?:said|meant)\s+(?:was|is))\s*[:,]?\s+"
    + _SPAN.format(name="meant")
    + r"(?:\s*,?\s+not\s+"
    + _SPAN.format(name="heard")
    + r")?\s*[.!]*$",
    re.IGNORECASE,
)
_EN_ITS = re.compile(  # "no, it's Okin": only after a no, since "it's raining" isn't one
    r"^(?:no|nope)\b[\s,.!:;-]+(?:it'?s|it\s+is|that'?s|that\s+is|it\s+should\s+be"
    r"|that\s+should\s+be|the\s+name\s+is)\s+"
    + _SPAN.format(name="meant")
    + r"(?:\s*,?\s+not\s+"
    + _SPAN.format(name="heard")
    + r")?\s*[.!]*$",
    re.IGNORECASE,
)
_EN_NOT = re.compile(
    _LEAD
    + r"not\s+"
    + _SPAN.format(name="heard")
    + r"\s*[,;:–—-]+\s*(?:but\s+|i\s+said\s+|i\s+meant\s+|it'?s\s+)?"
    + _SPAN.format(name="meant")
    + r"\s*[.!]*$",
    re.IGNORECASE,
)
_ZH_BIT = r"[^，,。！？!?；;：:]+?"
_ZH_PATTERNS = (
    re.compile(
        rf"^(?:不对|不是)?[，,\s]*我(?:说的是|是说|说的|的意思是|要说的是)(?P<meant>{_ZH_BIT})"
        rf"(?:[，,\s]*(?:而)?不是(?P<heard>{_ZH_BIT}))?[。！!]*$"
    ),
    re.compile(rf"^不是(?P<heard>{_ZH_BIT})[，,\s]*(?:而)?是(?P<meant>{_ZH_BIT})[。！!]*$"),
    re.compile(rf"^(?:不对|不是)[，,\s]*是(?P<meant>{_ZH_BIT})[。！!]*$"),
)
_SPELLED = re.compile(
    r"^(?P<word>.+?)\s*,?\s*(?:spelled|spelt|that'?s)?\s*,?\s*(?P<letters>(?:[A-Za-z][\s.-]+){2,}[A-Za-z])\.?$"
)

_SPELL_TAIL = re.compile(r"\s*,\s*(?:spelled\s+|spelt\s+)?((?:[A-Za-z][\s.-]+){2,}[A-Za-z])\.?$")

WORDS = {
    "en": {
        "learned": "Got it: “{meant}”, not “{heard}”. I'll hear it right from now on.",
        "learned_word": "Got it: “{meant}”. I'll listen for it from now on.",
        "undone": "Okay, I won't change “{heard}” to “{meant}” any more.",
    },
    "zh": {
        "learned": "明白了：是“{meant}”，不是“{heard}”。以后我会听对的。",
        "learned_word": "明白了：“{meant}”。以后我会留意这个词。",
        "undone": "好的，我不会再把“{heard}”改成“{meant}”了。",
    },
}


def _now_iso(now: datetime) -> str:
    return now.isoformat(timespec="seconds")


def _zh(lang: str) -> bool:
    return str(lang or "").lower().startswith("zh")


def _term(text: Any) -> str:
    """A word or short phrase as it may be kept: nothing hidden, quotes and edge punctuation
    off, one line, short."""
    text = " ".join(clean_text(text or "").split())
    return text.strip(_QUOTE + " .,!?;:-—–")[:MAX_TERM_CHARS]


def _key(text: str) -> str:
    return _term(text).lower()


def _letters(text: str) -> str:
    return "".join(c for c in text.lower() if c.isalnum())


def _skeleton(text: str) -> str:
    """Roughly how it sounds: consonants, with ones that sound alike made one, repeats
    folded ("for moose" and "Hormuz" come out close)."""
    s = _letters(text)
    s = s.replace("ph", "f").replace("ck", "k").replace("qu", "kw").replace("x", "ks")
    s = s.translate(str.maketrans("cqzvdbgj", "kksftpkj"))
    out = []
    for c in s:
        if c in "aeiouyhw":
            continue
        if not out or out[-1] != c:
            out.append(c)
    return "".join(out)


def similarity(a: str, b: str) -> float:
    """How alike two spoken forms are: their letters, or (a little less) their sounds.
    Chinese is compared character by character."""
    la, lb = _letters(a), _letters(b)
    if not la or not lb:
        return 0.0
    score = difflib.SequenceMatcher(None, la, lb).ratio()
    sa, sb = _skeleton(a), _skeleton(b)
    if sa and sb:
        score = max(score, 0.95 * difflib.SequenceMatcher(None, sa, sb).ratio())
    return score


def _words_of(text: str) -> list[str]:
    return _TOKEN.findall(text or "")


def _has_wake(text: str) -> bool:
    low = text.lower()
    return any(w in low for w in WAKE_WORDS)


# Asked of every correction on each transcript (is it in force yet?), so the answers are
# kept: they depend on the term alone, and cleaning every term again was most of the time
# a transcript spent here.
@functools.lru_cache(maxsize=4096)
def _common(term: str) -> bool:
    words = _key(term).split()
    if _CJK.search(term):
        return len(term) <= 1 or term in _ZH_COMMON
    return bool(words) and all(w in COMMON for w in words)


def _spelled(meant: str) -> str:
    """ "Okin, O-K-I-N" -> Okin; "spelled K-A-I" -> Kai."""
    m = _SPELLED.match(meant.strip())
    if not m:
        letters = re.fullmatch(r"(?:spelled\s+)?((?:[A-Za-z][\s.-]+){2,}[A-Za-z])", meant.strip())
        if letters:
            joined = re.sub(r"[\s.-]", "", letters.group(1))
            return joined.capitalize() if joined.isupper() else joined
        return meant
    joined = re.sub(r"[\s.-]", "", m.group("letters"))
    return joined.capitalize() if joined.isupper() else joined


@dataclass
class Correction:
    """One thing the owner corrected: what was heard, what they meant, and their last
    request with it put right ("" when it wasn't in it)."""

    heard: str
    meant: str
    previous: str = ""
    corrected: str = ""
    via: str = "voice"  # voice | typed | edit | tool

    def told(self, lang: str = "en") -> str:
        words = WORDS["zh" if _zh(lang) else "en"]
        if not self.heard:
            return words["learned_word"].format(meant=self.meant)
        return words["learned"].format(meant=self.meant, heard=self.heard)

    def note(self) -> str:
        """For the request that made it: what the app learned, so Claude reads the owner's
        "no, I said Okin" against the request it corrects."""
        if not self.heard:
            return f"the user said the word is “{self.meant}” (the app will listen for it)"
        text = f"speech recognition misheard “{self.meant}” as “{self.heard}”"
        if self.corrected:
            text += f"; their previous request, put right, was: “{self.corrected}”"
        return text + " (the app learned it)"


@dataclass
class _Heard:
    text: str  # as acted on (corrections applied); the request alone once it's asked
    at: float
    raw: str = ""  # as Whisper wrote it: "no, I said akin" must not become "…Okin"
    request: bool = False


class Hearing:
    """The learned vocabulary. enabled(): Settings' switch (off: nothing learned, nothing
    replaced, only the wake word hinted). lang(): "en" or "zh". clock: seconds, for the
    "recent" of corrections; now: dates on disk. Both are for tests."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        enabled: Callable[[], bool] = lambda: True,
        lang: Callable[[], str] = lambda: "en",
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.path = path or APP_SUPPORT / "hearing.json"
        self._enabled, self._lang = enabled, lang
        self._clock, self._now = clock, now
        self.corrections: dict[str, dict[str, Any]] = {}  # heard (lower) -> meant, count, at
        self.words: dict[str, dict[str, Any]] = {}  # lower -> word, count, at, why
        self.seeds: dict[str, list[str]] = {}  # source -> names (in memory only)
        self._heard: deque[_Heard] = deque(maxlen=RECENT_HEARD)
        self._pattern: re.Pattern[str] | None = None
        self._pattern_for: tuple[str, ...] = ()
        self._dirty = False
        self._saved_at = 0.0
        self.unreadable = ""
        self._load()

    # ── on disk ──

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("hearing: %s can't be read (%s); leaving it be", self.path.name, exc)
            return
        if not data:
            return
        # A section that isn't a mapping (hand-edited, another build's) is left out: the Hub
        # makes this store as it starts, so nothing in the file may stop that.
        corrections, words = data.get("corrections"), data.get("words")
        corrections = corrections if isinstance(corrections, dict) else {}
        words = words if isinstance(words, dict) else {}
        for heard, raw in list(corrections.items())[-MAX_CORRECTIONS:]:
            if not isinstance(raw, dict):
                continue
            heard, meant = _key(heard), _term(raw.get("meant"))
            if heard and meant and heard != meant.lower():
                self.corrections[heard] = {
                    "meant": meant,
                    "count": _count(raw.get("count")),
                    "at": str(raw.get("at") or "")[:25],
                    "via": str(raw.get("via") or "voice")[:8],
                }
        for key, raw in list(words.items())[-MAX_WORDS:]:
            if isinstance(raw, dict) and (word := _term(raw.get("word"))):
                self.words[_key(key) or word.lower()] = {
                    "word": word,
                    "count": _count(raw.get("count")),
                    "at": str(raw.get("at") or "")[:25],
                    "why": str(raw.get("why") or "said")[:10],
                }

    def save(self, force: bool = False) -> None:
        """Corrections are saved at once (force); usage counts at most once a minute."""
        if not self._dirty or self.unreadable:
            return
        if not force and self._clock() - self._saved_at < SAVE_EVERY:
            return
        try:
            jsonstore.save_json(
                self.path,
                {"version": 1, "corrections": self.corrections, "words": self.words},
                indent=1,
            )
            self._dirty, self._saved_at = False, self._clock()
        except OSError as exc:
            log.info("hearing: couldn't save (%s)", exc)

    def flush(self) -> None:
        self.save(force=True)

    def _on(self) -> bool:
        try:
            return bool(self._enabled())
        except Exception:
            return False

    # ── what was heard, put right ──

    def _active(self) -> dict[str, str]:
        """Corrections in force: a common word as the misheard side needs two."""
        return {
            heard: c["meant"]
            for heard, c in self.corrections.items()
            if c["count"] >= (2 if _common(heard) else 1)
        }

    def _compiled(self, active: dict[str, str]) -> re.Pattern[str] | None:
        keys = tuple(sorted(active, key=len, reverse=True))
        if keys != self._pattern_for:
            self._pattern_for = keys
            parts = [
                re.escape(k) if _CJK.search(k) else rf"(?<![\w'’]){re.escape(k)}(?![\w'’])"
                for k in keys
            ]
            self._pattern = re.compile("|".join(parts), re.IGNORECASE) if parts else None
        return self._pattern

    def apply(self, text: str) -> str:
        """Learned corrections, whole words only (longest first, one pass, so a
        replacement is never itself replaced)."""
        if not text or not self._on():
            return text
        active = self._active()
        pattern = self._compiled(active)
        if pattern is None:
            return text
        return pattern.sub(lambda m: active.get(m.group(0).lower(), m.group(0)), text)

    def fix(self, text: str) -> str:
        """A fresh transcript: corrections applied, and kept a few minutes so the owner's
        "no, I said…" can be matched against it. Call it on every transcript."""
        fixed = self.apply(text)
        if fixed.strip():
            self._heard.append(_Heard(fixed.strip(), self._clock(), raw=text.strip()))
        return fixed

    # ── learning from the owner's own words ──

    def owner_said(self, text: str) -> Correction | None:
        """A request in the owner's own words (typed or said): their words counted, and a
        correction of the last spoken request learned. Never call it with anything JARVIS
        read (an email, a page, a routine's prompt)."""
        text = clean_text(text or "").strip()
        if not text or not self._on():
            return None
        try:  # learning is a bonus: it never stands in the way of the request
            now = self._clock()
            spoken = self._mark_request(text, now)
            if spoken is None:
                self._edited_dictation(text, now)
            correction = self._correction(text, now, spoken)
            if correction is None:
                self._count_words(text)
                self.save()
            return correction
        except Exception:
            log.exception("hearing: couldn't learn from a request")
            return None

    def _mark_request(self, text: str, now: float) -> _Heard | None:
        """The transcript this request came from, if it was spoken (the hub asks with the
        words after the wake word, so the ending is what's matched)."""
        for heard in reversed(self._heard):
            if not heard.request and now - heard.at <= CORRECTION_SECONDS:
                if heard.text.endswith(text):
                    heard.request, heard.text = True, text
                    return heard
        return None

    def _edited_dictation(self, text: str, now: float) -> list[Correction]:
        """Typed right after dictating: the composer's mic put the words in the box and
        the owner fixed some before sending. What they changed was misheard."""
        for heard in list(reversed(self._heard))[:3]:
            if heard.request or now - heard.at > EDIT_SECONDS:
                continue
            alike = difflib.SequenceMatcher(None, heard.text.lower(), text.lower()).ratio()
            if alike < EDITED:
                continue
            original = heard.text
            heard.request, heard.text = True, text
            return self.learn_edit(original, text) if original != text else []
        return []

    def _previous(self, now: float, current: _Heard | None) -> _Heard | None:
        for heard in reversed(self._heard):
            if heard is current or not heard.request:
                continue
            return heard if now - heard.at <= CORRECTION_SECONDS else None
        return None

    def _correction(self, text: str, now: float, current: _Heard | None) -> Correction | None:
        # Spoken, it's read as Whisper wrote it: a learned correction applied to the
        # correction itself ("no, I said akin" undoing akin -> Okin) would hide it.
        said = parse_correction(current.raw if current and current.raw else text, self._lang())
        if said is None:
            return None
        meant, heard = said
        before = self._previous(now, current)
        previous = before.text if before is not None else ""
        via = "voice" if current is not None else "typed"
        if heard:
            where = _find(previous, heard) if previous else None
            corrected = _replace(previous, where, meant) if where else ""
            found = Correction(heard, meant, previous, corrected, via)
        elif previous and len(meant.split()) > MAX_SPAN_WORDS and not _CJK.search(meant):
            # "I said call Okin about the lease": the request again, put right.
            pairs = diff_pairs(previous, meant)
            if len(pairs) != 1:
                return None
            heard, meant = pairs[0]
            found = Correction(heard, meant, previous, said[0], via)
            if similarity(heard, meant) < SIMILAR_GUESS:
                return None  # a changed mind ("Tuesday", not "Friday"), not a mishearing
        else:
            where = best_span(previous, meant) if previous else None
            if where is None:
                return self._learn_word_only(meant, via)
            heard = previous[where[0] : where[1]]
            found = Correction(heard, meant, previous, _replace(previous, where, meant), via)
        if not self._learn(found):
            return None
        if before is not None:  # a second "no, I said…" is about the same request
            before.text = found.corrected or before.text
        if current is not None:
            current.request = False  # the correction itself is nothing to correct
        return found

    def _learn_word_only(self, meant: str, via: str) -> Correction | None:
        # Only what reads like a name ("I mean the weather" is talk, not a word to learn).
        if not (_CJK.search(meant) or re.search(r"[A-Z]|\d", meant)):
            return None
        if not self._teach(meant, "corrected"):
            return None
        self.save(force=True)
        return Correction("", _term(meant), via=via)

    def _learn(self, found: Correction) -> bool:
        """Keep heard -> meant (and the word). Said the other way round, an earlier
        correction is undone instead of piling a second one on it."""
        heard, meant = _term(found.heard), _term(found.meant)
        if not heard or not meant or heard.lower() == meant.lower():
            return False
        if _has_wake(heard) or _has_wake(meant) or len(_letters(heard)) < 2:
            return False
        if len(heard.split()) > MAX_SPAN_WORDS or len(meant.split()) > MAX_SPAN_WORDS:
            return False
        found.heard, found.meant = heard, meant
        undo = self.corrections.get(meant.lower())
        if undo is not None and undo["meant"].lower() == heard.lower():
            del self.corrections[meant.lower()]
            self._dirty = True
            self.save(force=True)
            return True
        entry = self.corrections.get(heard.lower())
        count = entry["count"] + 1 if entry and entry["meant"] == meant else 1
        self.corrections.pop(heard.lower(), None)  # re-inserted: the newest last
        self.corrections[heard.lower()] = {
            "meant": meant,
            "count": min(count, 99),
            "at": _now_iso(self._now()),
            "via": found.via,
        }
        while len(self.corrections) > MAX_CORRECTIONS:  # the oldest go first
            del self.corrections[next(iter(self.corrections))]
        self._teach(meant, "corrected")
        self._dirty = True
        self.save(force=True)
        return True

    def learn_edit(self, original: str, edited: str) -> list[Correction]:
        """The owner edited what JARVIS heard, in the window. Only a recent transcript can
        teach this way, and only small, like-sounding changes count: a rewrite, or a
        changed mind ("Tuesday" to "Friday"), teaches nothing."""
        original, edited = clean_text(original or "").strip(), clean_text(edited or "").strip()
        if not original or not edited or not self._on():
            return []
        now = self._clock()
        recent = [h for h in self._heard if now - h.at <= EDIT_SECONDS]
        if not any(original in h.text or original in h.raw for h in recent):
            return []  # only words JARVIS heard lately can be put right this way
        pairs = diff_pairs(original, edited)
        if not pairs or len(pairs) > 3:
            return []
        learned = []
        for heard, meant in pairs:
            found = Correction(heard, meant, original, edited, "edit")
            if similarity(heard, meant) >= SIMILAR and self._learn(found):
                learned.append(found)
        return learned

    def correct(self, heard: str, meant: str, via: str = "tool") -> Correction:
        """An explicit correction (the tool, Settings). Raises ValueError when it can't be
        one."""
        found = Correction(_term(heard), _term(_spelled(meant)), via=via)
        if not found.heard or not found.meant:
            raise ValueError("Say what I heard and what you meant.")
        if not self._learn(found):
            raise ValueError("That can't be learned (the wake word, or the same word twice).")
        return found

    def teach(self, word: str) -> str:
        """Learn a word or name to listen for. Raises ValueError when it can't be one."""
        word = _term(_spelled(word))
        if not self._teach(word, "taught"):
            raise ValueError("That isn't a word I can learn.")
        self.save(force=True)
        return word

    def _teach(self, word: str, why: str) -> bool:
        word = _term(word)
        if not word or _has_wake(word) or _common(word) or len(word.split()) > MAX_SPAN_WORDS:
            return False
        entry = self.words.pop(word.lower(), None)
        count = entry["count"] if entry else 0
        weight = max(count, SAID_ENOUGH) + (1 if why != "said" else 0)
        self.words[word.lower()] = {
            "word": word,
            "count": min(weight, 999),
            "at": _now_iso(self._now()),
            "why": why if why != "said" or entry is None else entry["why"],
        }
        self._trim_words()
        self._dirty = True
        return True

    def _count_words(self, text: str) -> None:
        """Names and unusual words the owner uses: capitalized mid-sentence, mixed case,
        letters with digits. Common words and the wake word never count."""
        tokens = _words_of(text)
        for i, token in enumerate(tokens):
            low = token.lower().strip("'’.-")
            coded = bool(re.search(r"[a-z]\d|\d[a-z]", low))  # Q3, 10x, A380
            if (len(low) < 3 and not coded) or low in COMMON or _has_wake(low) or low.isdigit():
                continue
            proper = (i > 0 and token[0].isupper()) or (
                any(c.isupper() for c in token[1:]) and any(c.islower() for c in token)
            )
            if not (proper or coded):
                continue
            entry = self.words.get(low)
            if entry is None:
                self.words[low] = {
                    "word": token.strip("'’.-"),
                    "count": 1,
                    "at": _now_iso(self._now()),
                    "why": "said",
                }
            else:
                entry["count"] = min(entry["count"] + 1, 999)
                entry["at"] = _now_iso(self._now())
            self._dirty = True
        self._trim_words()

    def _trim_words(self) -> None:
        if len(self.words) <= MAX_WORDS:
            return
        # Words said once long ago go first; corrected and taught ones last.
        order = sorted(
            self.words,
            key=lambda k: (
                self.words[k]["why"] != "said",
                self.words[k]["count"],
                self.words[k]["at"],
            ),
        )
        for key in order[: len(self.words) - MAX_WORDS]:
            del self.words[key]

    def seed(self, source: str, names: Iterable[Any]) -> None:
        """Names from somewhere the owner keeps them (calendar, memory, contacts): hints
        for Whisper, never corrections. Replaces what that source gave before."""
        kept: list[str] = []
        for raw in names:
            name = _term(str(raw).split("@")[0] if "@" in str(raw) else raw)
            if not name or _has_wake(name) or _common(name) or name in kept:
                continue
            if not re.search(r"[^\W\d_]", name):
                continue
            kept.append(name)
            if len(kept) >= MAX_SEEDS * (20 if source == "contacts" else 1):
                break
        self.seeds[source] = kept

    # ── for the recognizer ──

    def hotwords(self, base: str = "Jarvis", limit: int = HOTWORDS) -> str:
        """base (the wake word, or a code project's names) and then what was learned:
        corrected and taught words, words the owner says often, names in upcoming meetings
        and memory, and Contacts they've mentioned by name."""
        if not self._on():
            return base
        terms: list[str] = base.split() if base else []
        seen = {t.lower() for t in terms}
        chars = [len(base)]

        def add(term: str) -> bool:
            if len(terms) >= limit or chars[0] + len(term) + 1 > HOTWORD_CHARS:
                return False
            if term.lower() not in seen:
                seen.add(term.lower())
                terms.append(term)
                chars[0] += len(term) + 1
            return True

        learned = sorted(
            (w for w in self.words.values() if w["why"] != "said"),
            key=lambda w: (w["count"], w["at"]),
            reverse=True,
        )
        often = sorted(
            (w for w in self.words.values() if w["why"] == "said" and w["count"] >= SAID_ENOUGH),
            key=lambda w: (w["count"], w["at"]),
            reverse=True,
        )
        said = {k for k, w in self.words.items() if w["count"] >= 1}
        mentioned = [
            n for n in self.seeds.get("contacts", []) if any(p.lower() in said for p in n.split())
        ]
        for group in (
            [w["word"] for w in learned],
            [w["word"] for w in often],
            self.seeds.get("calendar", [])[:8],
            self.seeds.get("memory", [])[:8],
            mentioned[:8],
        ):
            for term in group:
                if not add(term):
                    return " ".join(terms)
        return " ".join(terms)

    # ── what it knows, and taking it back ──

    def forget(self, what: str) -> list[str]:
        """Remove a correction (by either side) and the word. Returns what went."""
        key = _key(what)
        if not key:
            return []
        gone = []
        for heard, c in list(self.corrections.items()):
            if key in (heard, c["meant"].lower()):
                del self.corrections[heard]
                gone.append(f"“{heard}” → “{c['meant']}”")
        if key in self.words:
            gone.append(f"“{self.words.pop(key)['word']}”")
        if gone:
            self._dirty = True
            self.save(force=True)
        return gone

    def clear(self) -> None:
        self.corrections, self.words = {}, {}
        self._dirty = True
        self.save(force=True)

    def describe(self, query: str = "") -> str:
        query = query.strip().lower()
        active = self._active()  # once, not again for each correction
        fixes = [
            f"“{h}” → “{c['meant']}”" + (" (needs one more)" if h not in active else "")
            for h, c in reversed(self.corrections.items())
            if not query or query in h or query in c["meant"].lower()
        ]
        words = [
            w["word"]
            for w in sorted(self.words.values(), key=lambda w: w["count"], reverse=True)
            if (w["why"] != "said" or w["count"] >= SAID_ENOUGH)
            and (not query or query in w["word"].lower())
        ]
        if not fixes and not words:
            return "Nothing learned about that yet." if query else "Nothing learned yet."
        parts = []
        if fixes:
            parts.append("Corrections I apply: " + "; ".join(fixes[:40]) + ".")
        if words:
            parts.append("Words I listen for: " + ", ".join(words[:60]) + ".")
        return " ".join(parts)

    def public(self) -> dict[str, Any]:
        """For Settings: corrections newest first, and the words."""
        return {
            "corrections": [
                {"heard": h, "meant": c["meant"], "count": c["count"], "at": c["at"]}
                for h, c in reversed(self.corrections.items())
            ],
            "words": [
                {"word": w["word"], "count": w["count"], "why": w["why"]}
                for w in sorted(self.words.values(), key=lambda w: w["count"], reverse=True)
                if w["why"] != "said" or w["count"] >= SAID_ENOUGH
            ][:200],
        }


def names_in(texts: Iterable[str]) -> list[str]:
    """Names in sentences (memory's facts): capitalized words after a sentence's first
    word, and runs of them ("Ann Lee"), common words and the wake word aside."""
    found: list[str] = []
    for text in texts:
        for sentence in re.split(r"(?<=[.!?])\s+", str(text or "")):
            run: list[str] = []
            for i, token in enumerate(_words_of(sentence) + [""]):
                word = token.strip("'’.-")
                if i > 0 and word[:1].isupper() and word.lower() not in COMMON:
                    run.append(word)
                    continue
                if run:
                    name = " ".join(run)
                    if not _has_wake(name) and name not in found:
                        found.append(name)
                    run = []
    return found[:MAX_SEEDS]


# ── reading a correction ──


def parse_correction(text: str, lang: str = "en") -> tuple[str, str] | None:
    """(meant, heard) from "no, I said Okin", "I meant Hormuz, not for moose", "not akin,
    Okin", 我说的是…, 不是…是… (heard "" when not said). None when it isn't one."""
    text = " ".join(clean_text(text or "").split()).strip()
    if not text or len(text) > 200:
        return None
    if _CJK.search(text):
        for pattern in _ZH_PATTERNS:
            m = pattern.match(text)
            if m:
                meant = _term(m.group("meant"))
                heard = _term(m.groupdict().get("heard") or "")
                return (meant, heard) if meant and len(meant) <= 20 else None
        if not re.search(r"[A-Za-z]", text):
            return None
    spelled = ""
    tail = _SPELL_TAIL.search(text)
    if tail:  # "no, I said Kai, K-A-I": the letters are the word
        letters = re.sub(r"[\s.-]", "", tail.group(1))
        spelled = letters.capitalize() if letters.isupper() else letters
        text = text[: tail.start()]
    for pattern in (_EN_SAID, _EN_ITS, _EN_NOT):
        m = pattern.match(text)
        if not m:
            continue
        meant = _spelled(m.group("meant")).strip(_QUOTE + " ")
        if spelled and similarity(meant, spelled) >= SIMILAR:
            meant = spelled
        heard = _term(m.groupdict().get("heard") or "")
        if len(heard.split()) > MAX_SPAN_WORDS:
            return None
        if len(meant.split()) <= MAX_SPAN_WORDS:
            meant = _term(meant)
        elif pattern is not _EN_SAID or heard:
            return None  # only "I said <the request again>" may be long
        if not meant or meant.lower() == heard.lower():
            return None
        return meant, heard
    return None


def _spans(text: str) -> list[tuple[int, int, str]]:
    return [(m.start(), m.end(), m.group()) for m in _TOKEN.finditer(text)]


def _find(text: str, heard: str) -> tuple[int, int] | None:
    m = re.search(rf"(?<![\w'’]){re.escape(heard)}(?![\w'’])", text, re.IGNORECASE)
    return (m.start(), m.end()) if m else None


def _replace(text: str, where: tuple[int, int] | None, meant: str) -> str:
    if not where:
        return ""
    return text[: where[0]] + meant + text[where[1] :]


def best_span(previous: str, meant: str) -> tuple[int, int] | None:
    """Where in the previous request the misheard words were: the run of one to a few
    words (characters, in Chinese) that sounds most like what was meant."""
    if _CJK.search(meant):
        # Homophones share no letters to compare: a name heard wrong in a character
        # (奥金 for 欧金) keeps the others in place, so same-length runs are compared
        # character by character.
        n = len(meant)
        best: tuple[float, tuple[int, int]] | None = None
        for i in range(0, len(previous) - n + 1):
            piece = previous[i : i + n]
            if piece == meant:
                return None  # heard right: nothing to correct
            if not _CJK.search(piece):
                continue
            score = sum(x == y for x, y in zip(piece, meant, strict=True)) / n
            if best is None or score > best[0]:
                best = (score, (i, i + n))
        return best[1] if best and best[0] >= SIMILAR else None
    tokens = _spans(previous)
    width = len(meant.split())
    best_en: tuple[float, int, tuple[int, int]] | None = None
    for size in range(1, min(MAX_SPAN_WORDS, width + 2) + 1):
        for i in range(0, len(tokens) - size + 1):
            run = tokens[i : i + size]
            piece = previous[run[0][0] : run[-1][1]]
            if piece.lower() == meant.lower():
                return None  # it was heard right: nothing to correct
            if all(t[2].lower() in COMMON for t in run) or _has_wake(piece):
                continue
            score = similarity(piece, meant)
            rank = (score, -abs(size - width), (run[0][0], run[-1][1]))
            if best_en is None or rank[:2] > best_en[:2]:
                best_en = rank
    return best_en[2] if best_en and best_en[0] >= SIMILAR_GUESS else None


def diff_pairs(before: str, after: str) -> list[tuple[str, str]]:
    """The short runs of words that changed between two versions of one request, as
    (was, now) in the original spelling. Inserted or deleted words aren't mishearings."""
    a, b = _spans(before), _spans(after)
    matcher = difflib.SequenceMatcher(
        None, [t[2].lower() for t in a], [t[2].lower() for t in b], autojunk=False
    )
    pairs = []
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op != "replace":
            continue
        if i2 - i1 > MAX_SPAN_WORDS or j2 - j1 > MAX_SPAN_WORDS:
            return []  # a rewrite, not a mishearing
        was = before[a[i1][0] : a[i2 - 1][1]]
        now = after[b[j1][0] : b[j2 - 1][1]]
        pairs.append((was, now))
    return pairs


def _count(value: Any) -> int:
    try:
        return max(1, min(999, int(value)))
    except (TypeError, ValueError, OverflowError):
        return 1


# ── Claude's tools ──


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


async def _always(_action: str, _question: str) -> bool:
    return True


def build_tools(hearing: Hearing, gate=_always, on_change=None) -> list:
    """gate(action, question): the hub lets a change through when the user plainly asked
    for it this turn, and asks them otherwise (a name from an email is never learned
    unasked)."""

    def changed() -> None:
        if on_change is not None:
            on_change()

    @tool(
        "learn_word",
        "Learn how the user says a word or name so speech recognition gets it right: a "
        "person, company, place or project ('learn the name Okin', 'it's spelled K-A-I'). "
        "sounds_like: what you mis-heard it as, when the user says so ('you keep hearing "
        "for moose, I mean Hormuz'). Only for words the user says themselves, never names "
        "from an email, page or file. Corrections like 'no, I said Okin' are learned by the "
        "app on its own; don't call this for those.",
        {
            "type": "object",
            "properties": {"word": {"type": "string"}, "sounds_like": {"type": "string"}},
            "required": ["word"],
        },
    )
    async def learn_word(args):
        word = _term(_spelled(str(args.get("word") or "")))
        heard = _term(args.get("sounds_like") or "")
        if not word:
            return _text("Which word?", error=True)
        question = f"Learn to hear “{heard}” as “{word}”?" if heard else f"Learn the word “{word}”?"
        if not await gate("learn_word", question):
            return _text("The user said no; nothing learned.", error=True)
        try:
            if heard:
                found = hearing.correct(heard, word)
                reply = f"Learned: “{found.heard}” is “{found.meant}”."
            else:
                reply = f"Learned the word “{hearing.teach(word)}”."
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        return _text(reply)

    @tool(
        "learned_words",
        "What you've learned about the user's words: the mishearings you correct and the "
        "names and words you listen for. query narrows it.",
        {"type": "object", "properties": {"query": {"type": "string"}}},
    )
    async def learned_words(args):
        return _text(hearing.describe(str(args.get("query") or "")))

    @tool(
        "forget_word",
        "Stop correcting or listening for a word: either side of a correction, or a "
        "learned word ('stop changing X', 'forget the word Okin').",
        {"what": str},
    )
    async def forget_word(args):
        what = _term(args.get("what") or "")
        if not what:
            return _text("Which word?", error=True)
        if not await gate("forget_word", f"Forget what I learned about “{what}”?"):
            return _text("The user said no.", error=True)
        gone = hearing.forget(what)
        if not gone:
            return _text("I hadn't learned anything like that.")
        changed()
        return _text("Forgot: " + "; ".join(gone))

    return [learn_word, learned_words, forget_word]


def build_server(hearing: Hearing, gate=_always, on_change=None):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=build_tools(hearing, gate, on_change)
    )


PROMPT = (
    "\n- Hearing: the app learns the user's words so speech recognition gets them right. "
    "When they correct a mishearing ('no, I said Okin', 'I meant Hormuz'), the app learns it "
    "by itself and a note tells you what their earlier request meant: act on that, briefly "
    "acknowledging it. learn_word learns a name or word when they ask you to; "
    "learned_words lists what's learned; forget_word undoes one. Only ever the user's own "
    "words: never learn a name because an email, page or file mentions it."
)

# For hub.FEATURE_ASKED: the user's own words plainly asked to learn or forget a word.
ASKED = {
    "learn_word": (
        r"(?:learn|remember|note)\s+(?:the\s+|this\s+|my\s+|a\s+|how\s+i\s+say\s+)?"
        r"(?:(?:new\s+)?(?:word|name|spelling|pronunciation)s?\b|how\s+(?:to\s+)?(?:say|spell))"
        r"|(?:it'?s|that'?s)\s+spelled\b|you\s+keep\s+(?:hearing|mishearing|getting)\b"
    ),
    "forget_word": (
        r"(?:forget|unlearn)\s+(?:the\s+)?(?:word|name|correction|spelling)\b"
        r"|stop\s+(?:changing|correcting|replacing)\b"
    ),
}
