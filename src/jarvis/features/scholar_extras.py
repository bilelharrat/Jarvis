"""More for the researcher, beside the scholar tools: paper alerts (follow a topic, an author or a
paper's citations; a daily check and a heads-up when there is new work, and "what's new this
week"), the reference checker (a document's or a pasted list's references verified against
Crossref and OpenAlex), and Zotero sync (the owner's Zotero items into the library JARVIS keeps,
and papers saved with JARVIS into Zotero).

The Zotero key is kept in the system's secret store (Windows Credential Manager, the macOS
Keychain), and connecting an account asks the owner first: a key slipped in by a page or a mail
would otherwise send their library to someone else's Zotero.

Claude cost policy: no model call of its own; these are tools of the ordinary conversation, and
the alerts loop only asks OpenAlex, at most once a day.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ..paper_alerts import KINDS, PaperAlerts
from ..proactive import Alert
from ..refcheck import HEADING, ReferenceChecker, report, split_references
from ..scholar import Scholar, describe
from ..zotero import Zotero, ZoteroError, entry_from_item

log = logging.getLogger("jarvis")

WAKE_EVERY = 3600  # the loop looks hourly whether a day has passed since the last check
FIRST_WAIT = 300  # and not in the first minutes after the app starts
MAX_PASTED = 200_000
MAX_DOC = 2_000_000

PROMPT = (
    "Paper alerts: when the owner wants to keep up with a topic, an author or who cites a "
    "paper, follow_papers (kind topic, author or citations); list_followed and unfollow_papers "
    "manage them. JARVIS checks once a day and gives a heads-up; for what's new, "
    "whats_new_papers. To check a manuscript's or a student's references, check_references "
    "with the document's path or the pasted reference list: report its counts first, then the "
    "references that differ or weren't found. Never correct a reference with details you made "
    "up: only what the record says, said as the record's, and 'not found' means check by hand. "
    "Zotero: connect_zotero keeps the owner's Zotero API key (from zotero.org/settings/keys) in "
    "the system's secret store; zotero_import brings their Zotero items into the library, "
    "zotero_add puts library papers into Zotero, forget_zotero removes the key. Never repeat a "
    "key aloud."
)

LABELS = {
    "follow_papers": "Following new papers",
    "unfollow_papers": "Unfollowing",
    "list_followed": "Reading what you follow",
    "whats_new_papers": "Looking for new papers",
    "check_references": "Checking references",
    "connect_zotero": "Connecting Zotero",
    "forget_zotero": "Forgetting Zotero",
    "zotero_import": "Importing from Zotero",
    "zotero_add": "Adding to Zotero",
}


def _text(words: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": words}]}
    if error:
        out["is_error"] = True
    return out


def _read(raw: str) -> tuple[str, str]:
    """A document's whole text (the reference list is at its end), or a reason it can't be read."""
    from ..computer import safe_path
    from ..knowledge import read_document

    try:
        path = safe_path(raw)
    except ValueError as exc:
        return "", str(exc)
    if not path.is_file():
        return "", "There's no such file."
    text = read_document(path, MAX_DOC, pages=400)
    if not text.strip():
        return "", "I couldn't read text from that file (a scanned PDF has no words to check)."
    return text, ""


class Extras:
    def __init__(self, hub: Any, scholar: Scholar) -> None:
        self.hub = hub
        self.scholar = scholar
        self.alerts = PaperAlerts(hub.feature_path("scholar") / "alerts.json", scholar)
        self._zotero: Zotero | None = None

    def zotero(self) -> Zotero:
        if self._zotero is None:
            self._zotero = Zotero(self.scholar.client())
        return self._zotero

    async def watch(self) -> None:
        """The alerts loop: hourly, a check when a day has passed; a heads-up for what's new."""
        await asyncio.sleep(FIRST_WAIT)
        while True:
            try:
                if self.alerts.due():
                    await self.check_and_tell()
            except Exception:  # a bad answer never stops the alerts for good
                log.exception("paper alerts: a check failed")
            await asyncio.sleep(WAKE_EVERY)

    async def check_and_tell(self) -> int:
        new = await self.alerts.check()
        if new:
            self.hub.notify(
                Alert(
                    f"papers:{date.today().isoformat()}",
                    "papers",
                    "New papers",
                    PaperAlerts.heads_up(new),
                    note="new papers for what the owner follows (whats_new_papers has them)",
                )
            )
        return len(new)

    async def confirm(self, question: str) -> bool:
        confirm = getattr(self.hub, "confirm", None)
        return bool(confirm) and await confirm(question)


def build_server(x: Extras) -> Any:
    @tool(
        "follow_papers",
        "Follow new papers: kind topic (words), author (a name), or citations (a paper, by DOI, "
        "OpenAlex id or title: new papers that cite it). JARVIS checks once a day and gives a "
        "heads-up when there are new ones.",
        {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": list(KINDS)},
                "what": {"type": "string"},
            },
            "required": ["kind", "what"],
        },
    )
    async def follow_papers(args):
        try:
            entry, said = await x.alerts.follow(str(args.get("kind") or "topic"), str(args.get("what") or ""))
        except Exception as exc:
            return _text(f"The paper index didn't answer ({type(exc).__name__}). Try again in a moment.", True)
        return _text(said, entry is None)

    @tool(
        "unfollow_papers",
        "Stop following a topic, author or paper (words of its name, as list_followed says it).",
        {"type": "object", "properties": {"what": {"type": "string"}}, "required": ["what"]},
    )
    async def unfollow_papers(args):
        gone = x.alerts.unfollow(str(args.get("what") or ""))
        return _text(f"No longer following {x.alerts.said(gone)}." if gone else "You don't follow anything like that.")

    @tool("list_followed", "The topics, authors and papers' citations the owner follows.", {"type": "object", "properties": {}})
    async def list_followed(_args):
        follows = x.alerts.follows()
        if not follows:
            return _text("You don't follow any topics, authors or papers yet.")
        lines = [f"You follow {len(follows)}:"]
        lines += [f"{i}. {x.alerts.said(f)}, since {f.get('added')}." for i, f in enumerate(follows, 1)]
        return _text("\n".join(lines))

    @tool(
        "whats_new_papers",
        "New papers for what the owner follows, found in the last days (default 7: this week). "
        "Checks the index first when a day has passed since the last check.",
        {"type": "object", "properties": {"days": {"type": "integer"}}},
    )
    async def whats_new_papers(args):
        if not x.alerts.follows():
            return _text("You don't follow any topics, authors or papers yet: say what to follow.")
        if x.alerts.due():
            try:
                await x.alerts.check()
            except Exception as exc:
                log.info("paper alerts: a check failed (%s)", type(exc).__name__)
        days = max(1, min(60, int(args.get("days") or 7)))
        news = x.alerts.news(days)
        span = "this week" if days == 7 else f"in the last {days} days"
        if not news:
            return _text(f"No new papers {span} for what you follow.")
        groups: dict[str, list[dict[str, Any]]] = {}
        follows: dict[str, dict[str, Any]] = {}
        for follow, work in news:
            groups.setdefault(follow["id"], []).append(work)
            follows[follow["id"]] = follow
        lines = [f"{len(news)} new papers {span}."]
        for fid, works in groups.items():
            lines.append(f"\nFor {x.alerts.said(follows[fid])}, {len(works)}:")
            lines += [describe(w, i + 1) for i, w in enumerate(works[:10])]
            if len(works) > 10:
                lines.append(f"And {len(works) - 10} more.")
        return _text("\n".join(lines))

    @tool(
        "check_references",
        "Check a document's references (path: a PDF, Word or text file in the home folder) or a "
        "pasted reference list (text): each is looked up in Crossref and OpenAlex and reported as "
        "found and matching, found but different (title, year, first author), or not found.",
        {"type": "object", "properties": {"path": {"type": "string"}, "text": {"type": "string"}}},
    )
    async def check_references(args):
        path = str(args.get("path") or "").strip()
        text = str(args.get("text") or "")[:MAX_PASTED]
        if path:
            text, why = await asyncio.to_thread(_read, path)
            if why:
                return _text(why, True)
            if not HEADING.search(text):
                return _text(
                    "I couldn't find a References or Bibliography heading in that document. Paste "
                    "the reference list and I'll check it."
                )
        if not text.strip():
            return _text("Give me a document's path or paste the reference list.", True)
        refs = split_references(text)
        if not refs:
            return _text("I found no references in that: each should have its authors, year and title.")
        checks = await ReferenceChecker(x.scholar.client()).check(refs)
        return _text(report(checks))

    @tool(
        "connect_zotero",
        "Connect the owner's Zotero library: their Zotero API key (from zotero.org/settings/keys; "
        "allow library access, and write access to add papers) and, optionally, their user id. "
        "The key is checked with Zotero, the owner confirms, and it is kept in the system's "
        "secret store.",
        {
            "type": "object",
            "properties": {"api_key": {"type": "string"}, "user_id": {"type": "string"}},
            "required": ["api_key"],
        },
    )
    async def connect_zotero(args):
        z = x.zotero()
        try:
            account = await z.probe(str(args.get("api_key") or ""), str(args.get("user_id") or ""))
        except ZoteroError as exc:
            return _text(str(exc), True)
        except Exception as exc:
            return _text(f"Zotero didn't answer ({type(exc).__name__}).", True)
        who = f"the Zotero account {account['name']}" if account.get("name") else f"Zotero user {account['user_id']}"
        if not await x.confirm(f"Connect JARVIS to {who}?"):
            return _text("Not connected: the owner said no.", True)
        try:
            return _text(z.keep(account))
        except Exception as exc:
            return _text(f"I couldn't keep the key in the secret store ({type(exc).__name__}).", True)

    @tool("forget_zotero", "Forget the owner's Zotero key and user id.", {"type": "object", "properties": {}})
    async def forget_zotero(_args):
        try:
            x.zotero().forget()
        except Exception as exc:
            return _text(f"I couldn't reach the secret store ({type(exc).__name__}).", True)
        return _text("Zotero key forgotten.")

    @tool(
        "zotero_import",
        "Bring the owner's Zotero items into the library JARVIS keeps (to list, cite and put in a "
        "bibliography by voice). Papers already there are kept, not doubled.",
        {"type": "object", "properties": {}},
    )
    async def zotero_import(_args):
        try:
            items = await x.zotero().items()
        except ZoteroError as exc:
            return _text(str(exc), True)
        except Exception as exc:
            return _text(f"Zotero didn't answer ({type(exc).__name__}).", True)
        entries = [e for e in (entry_from_item(i) for i in items) if e]
        if not entries:
            return _text("Your Zotero library has no items to bring in.")
        new, known = x.scholar.add_entries(entries)
        skipped = len(items) - len(entries)
        return _text(
            f"{len(entries)} items from Zotero: {new} added to the library, {known} already there."
            + (f" {skipped} notes or files left out." if skipped else "")
            + f" The library has {len(x.scholar.library())} papers."
        )

    @tool(
        "zotero_add",
        "Add library papers to the owner's Zotero: one paper (words of its title or its DOI), or "
        "every saved paper not yet in Zotero when paper is left out.",
        {"type": "object", "properties": {"paper": {"type": "string"}}},
    )
    async def zotero_add(args):
        want = str(args.get("paper") or "").strip().lower()
        items = [i for i in x.scholar.library() if not i.get("zotero")]
        if want:
            items = [i for i in items if want in str(i.get("title") or "").lower() or (i.get("doi") and i["doi"] in want)]
        if not items:
            return _text("That paper is already in Zotero, or not in the library." if want else "Every paper in the library is already in Zotero.")
        try:
            added = await x.zotero().add(items)
        except ZoteroError as exc:
            return _text(str(exc), True)
        except Exception as exc:
            return _text(f"Zotero didn't answer ({type(exc).__name__}).", True)
        for place, key in added.items():
            if key:
                x.scholar.mark(items[place]["id"], zotero=key)
        failed = len(items) - len(added)
        return _text(
            f"Added {len(added)} paper{'s' if len(added) != 1 else ''} to Zotero."
            + (f" {failed} didn't go in; try again later." if failed else "")
        )

    return create_sdk_mcp_server(
        name="scholar_extras",
        version="0.1.0",
        tools=[
            follow_papers,
            unfollow_papers,
            list_followed,
            whats_new_papers,
            check_references,
            connect_zotero,
            forget_zotero,
            zotero_import,
            zotero_add,
        ],
    )


def install(hub: Any) -> None:
    scholar = getattr(hub, "scholar", None)
    if scholar is None:  # (the scholar feature installs first, by name; this is in case it didn't)
        from .scholar import papers_folder

        scholar = Scholar(hub.feature_path("scholar") / "library.json", papers_folder())
    extras = Extras(hub, scholar)
    hub.scholar_extras = extras
    hub.register_server(
        "scholar_extras",
        lambda: build_server(extras),
        prompt=PROMPT,
        labels=LABELS,
        quiet=("unfollow_papers", "list_followed", "forget_zotero"),
        web=("follow_papers", "whats_new_papers", "check_references"),
    )
    hub.register_loop("paper_alerts", extras.watch)
