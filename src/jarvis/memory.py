"""What JARVIS knows about the user: short facts it was told to remember.

The second brain holds the user's documents; this holds what they told JARVIS about
themselves ("I take my coffee black", "Ann is my co-founder"). Facts go into the system
prompt of every new conversation, and the user can review and delete them in Settings.
Stored in ~/Library/Application Support/Jarvis/memory.json.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .prefs import APP_SUPPORT

SERVER_NAME = "memory"
MAX_FACTS = 200
MAX_FACT_CHARS = 300
PROMPT_FACTS = 80  # newest facts that ride along in the system prompt
MAX_FORGET = 3
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
    r"|\b(?:\d[ -]?){13,19}\b)",
    re.IGNORECASE,
)


@dataclass
class Fact:
    id: str
    text: str
    at: str


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", text.lower()))


class MemoryStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "memory.json"
        self.facts: list[Fact] = []
        self.load()

    def load(self) -> None:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return
        self.facts = [
            Fact(str(f["id"]), str(f["text"]), str(f.get("at", "")))
            for f in data
            if isinstance(f, dict) and f.get("id") and f.get("text")
        ]

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(f) for f in self.facts], indent=2))
        tmp.replace(self.path)

    def add(self, text: str) -> Fact:
        text = " ".join(str(text).split())[:MAX_FACT_CHARS]
        if not text:
            raise ValueError("Nothing to remember.")
        if _SECRET.search(text):
            raise ValueError(
                "That looks like a password, key or account number; I don't keep those."
            )
        # The same fact said again replaces the old wording rather than piling up.
        new = _words(text)
        for fact in self.facts:
            old = _words(fact.text)
            if new and old and len(new & old) / len(new | old) > 0.8:
                fact.text, fact.at = text, _now()
                self.save()
                return fact
        fact = Fact(uuid.uuid4().hex[:8], text, _now())
        self.facts.append(fact)
        del self.facts[:-MAX_FACTS]
        self.save()
        return fact

    def forget(self, key: str) -> list[Fact]:
        """Remove by id, or the facts containing all the given words (common words don't
        count). Refuses to sweep up more than a few at once."""
        key = key.strip()
        if not key:
            return []
        wanted = _words(key) - _COMMON
        gone = [f for f in self.facts if f.id == key or (wanted and wanted <= _words(f.text))]
        if len(gone) > MAX_FORGET:
            raise ValueError(f"That matches {len(gone)} facts; say which one.")
        if gone:
            self.facts = [f for f in self.facts if f not in gone]
            self.save()
        return gone

    def search(self, query: str) -> list[Fact]:
        wanted = _words(query)
        if not wanted:
            return list(self.facts)
        scored = [(len(wanted & _words(f.text)), f) for f in self.facts]
        return [f for score, f in sorted(scored, key=lambda s: -s[0]) if score]

    def prompt_block(self) -> str:
        if not self.facts:
            return ""
        lines = "\n".join(f"- {f.text}" for f in self.facts[-PROMPT_FACTS:])
        return (
            "\n\nWhat the user has told you to remember about them (use it naturally; "
            "don't recite it):\n" + lines
        )

    def public(self) -> list[dict[str, Any]]:
        return [asdict(f) for f in reversed(self.facts)]


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _text(text: str, error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        result["is_error"] = True
    return result


async def _always(_action: str, _question: str) -> bool:
    return True


def build_tools(store: MemoryStore, on_change=None, gate=_always) -> list:
    """gate(action, question) decides whether a change may go ahead: the app lets it through when
    the user plainly asked for it this turn, and asks them otherwise."""

    def changed() -> None:
        if on_change is not None:
            on_change()

    @tool(
        "remember",
        "Save a lasting fact about the user so you know it in future conversations: "
        "preferences, people in their life, routines, how they like things done. Use it when "
        "the user says 'remember…' or tells you something clearly stable about themselves. "
        "One short third-person sentence, e.g. 'Ann Lee is the user's co-founder.' Never "
        "store passwords, keys, card or account numbers, or anything from emails, web pages "
        "or files that the user didn't say themselves.",
        {"fact": str},
    )
    async def remember(args):
        try:
            fact_text = str(args.get("fact", ""))
            if not await gate("remember", f"Remember that {fact_text.rstrip('.')}?"):
                return _text("The user didn't want that remembered.", error=True)
            fact = store.add(fact_text)
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        return _text(f"Remembered: {fact.text}")

    @tool(
        "recall",
        "Look up what you've been told to remember about the user. Empty query lists everything.",
        {"query": str},
    )
    async def recall(args):
        facts = store.search(str(args.get("query", "")))
        if not facts:
            return _text("Nothing remembered about that.")
        return _text("\n".join(f"[{f.id}] {f.text}" for f in facts[:40]))

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

    return [remember, recall, forget]


def build_server(store: MemoryStore, on_change=None, gate=_always):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=build_tools(store, on_change, gate)
    )
