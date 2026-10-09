"""Scholarly research as JARVIS's tools (jarvis.scholar does the work): find papers, hear about
one, who cites it and what is related to it, get its free copy to read aloud, cite it, and keep a
library with its bibliography. (Paper alerts, the reference checker and Zotero sync are in
scholar_extras.)

Settings (prefs.features): scholar_style, the citation style used when none is asked for
("apa", "mla", "chicago", "harvard", "ieee", "vancouver"); scholar_proxy, the owner's university
library sign-in link (EZproxy and the like), through which open_paper opens a paywalled paper so
their own library subscription lets them read it (they sign in themselves).

Shadow libraries (Library Genesis, Anna's Archive, Sci-Hub) are never used: copies come only
from open access, the owner's own library, or the publisher.

Claude cost policy: no model call of its own; these are tools of the ordinary conversation.
"""

from __future__ import annotations

import logging
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import osplat
from ..prefs import register_feature_pref
from ..scholar import STYLES, Scholar, abstract_from_index, clean_doi, describe, free_link, free_pdf

log = logging.getLogger("jarvis")

register_feature_pref("scholar_style", "apa", lambda v: v if v in STYLES else None)


def _proxy(value: Any) -> Any:
    """The library's sign-in link for papers (an EZproxy-style prefix the DOI link is added to)."""
    v = str(value or "").strip()
    if v == "":
        return ""
    return v if v.startswith("https://") and len(v) <= 300 and " " not in v else None


register_feature_pref("scholar_proxy", "", _proxy)


def through_library(prefix: str, url: str) -> str:
    """A paper's address through the library's proxy: prefix + the address (encoded when the prefix
    ends in "url=", the common EZproxy form), or the address itself when there's no prefix."""
    from urllib.parse import quote

    if not prefix:
        return url
    return prefix + (quote(url, safe="") if prefix.endswith("=") else url)

PROMPT = (
    "Scholarly research: for papers, studies, the literature on a topic, citations or a "
    "bibliography, use the scholar tools (find_papers, paper_details, get_paper, cite, "
    "save_paper, list_library, remove_paper, bibliography), not a general web search. For the "
    "papers that cite a paper (its forward citations, its influence) use who_cites; for papers "
    "like one they liked, related_papers. Say how "
    "many papers you found first, then each in a sentence: title, first authors, year, venue, "
    "citations, and whether a free copy exists. Never invent a paper, an author or a DOI: only "
    "what these tools returned. To read a paper aloud, get_paper saves its free copy, then "
    "read_document reads it in parts. Cite in the owner's style unless they ask for another. "
    "Say plainly when a paper is a preprint or was retracted. For a full literature review, "
    "start_research with style 'academic'. When a paper has no free copy, open_paper opens it "
    "through the owner's university library (set_library_link keeps that sign-in link), and "
    "readers with a print disability can also get books through Bookshare or their library's "
    "HathiTrust access. Never use or suggest Library Genesis, Anna's Archive or Sci-Hub."
)

LABELS = {
    "find_papers": "Finding papers",
    "paper_details": "Reading about a paper",
    "who_cites": "Finding who cites a paper",
    "related_papers": "Finding related papers",
    "get_paper": "Getting a paper",
    "cite": "Citing a paper",
    "save_paper": "Saving a paper",
    "list_library": "Reading the library",
    "remove_paper": "Removing a paper",
    "bibliography": "Making a bibliography",
    "open_paper": "Opening a paper",
    "set_library_link": "Keeping the library link",
}

PAPER = {"type": "string", "description": "A DOI, an OpenAlex id (W…), or the paper's title"}


def _text(words: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": words}]}
    if error:
        out["is_error"] = True
    return out


def papers_folder():
    return osplat.personal_folders()[0] / "Jarvis" / "Papers"


def install(hub: Any) -> None:
    scholar = Scholar(hub.feature_path("scholar") / "library.json", papers_folder())
    hub.scholar = scholar
    if getattr(hub, "tasks", None) is not None:  # an academic review cites in the owner's style
        hub.tasks.citation_style = lambda: str(hub.prefs.feature("scholar_style") or "apa")

    def style(args: dict[str, Any]) -> str:
        return str(args.get("style") or hub.prefs.feature("scholar_style") or "apa")

    def build() -> Any:
        @tool(
            "find_papers",
            "Find scholarly papers on a topic in OpenAlex (journals, conferences, preprints, books, "
            "theses). sort: relevance (default), cited (most cited first) or newest. since/until: "
            "years. open_access: only papers with a free copy.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "since": {"type": "integer"},
                    "until": {"type": "integer"},
                    "open_access": {"type": "boolean"},
                    "sort": {"type": "string", "enum": ["relevance", "cited", "newest"]},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        )
        async def find_papers(args):
            try:
                works = await scholar.search(
                    str(args["query"]),
                    since=args.get("since"),
                    until=args.get("until"),
                    open_access=bool(args.get("open_access")),
                    sort=str(args.get("sort") or "relevance"),
                    limit=int(args.get("limit") or 6),
                )
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}). Try again in a moment.", True)
            if not works:
                return _text("No papers found for that. Try other words, or fewer years.")
            lines = [f"{len(works)} papers:"] + [describe(w, i + 1) for i, w in enumerate(works)]
            return _text("\n".join(lines))

        @tool(
            "paper_details",
            "One paper: its abstract, authors, venue, citations, retraction, and where a free copy is.",
            {"type": "object", "properties": {"paper": PAPER}, "required": ["paper"]},
        )
        async def paper_details(args):
            try:
                work = await scholar.work(str(args["paper"]))
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}).", True)
            if not work:
                return _text("I couldn't find that paper.")
            abstract = abstract_from_index(work.get("abstract_inverted_index"))
            more = [describe(work)]
            more.append(f"Abstract: {abstract}" if abstract else "The index has no abstract for it.")
            link = free_link(work) or free_pdf(work)
            if link:
                more.append(f"Free copy: {link}")
            return _text("\n".join(more))

        @tool(
            "who_cites",
            "The papers that cite a paper (forward citations), from OpenAlex. sort: cited (most "
            "cited first, default) or newest. since: a year. Says how many cite it in all.",
            {
                "type": "object",
                "properties": {
                    "paper": PAPER,
                    "sort": {"type": "string", "enum": ["cited", "newest"]},
                    "since": {"type": "integer"},
                    "limit": {"type": "integer"},
                },
                "required": ["paper"],
            },
        )
        async def who_cites(args):
            try:
                work = await scholar.work(str(args["paper"]))
                if not work:
                    return _text("I couldn't find that paper.")
                works, total = await scholar.citing(
                    str(work.get("id") or ""),
                    sort=str(args.get("sort") or "cited"),
                    since=args.get("since"),
                    limit=int(args.get("limit") or 6),
                )
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}). Try again in a moment.", True)
            title = work.get("display_name") or "that paper"
            if not works:
                return _text(f"The index knows of no papers citing {title}" + (" in those years." if args.get("since") else "."))
            order = "the newest first" if args.get("sort") == "newest" else "the most cited first"
            lines = [f"{total} papers cite {title}. Here are {len(works)}, {order}:"]
            lines += [describe(w, i + 1) for i, w in enumerate(works)]
            return _text("\n".join(lines))

        @tool(
            "related_papers",
            "Papers related to a paper (OpenAlex's related works: shared topics and citations), the "
            "most cited first.",
            {
                "type": "object",
                "properties": {"paper": PAPER, "limit": {"type": "integer"}},
                "required": ["paper"],
            },
        )
        async def related_papers(args):
            try:
                work = await scholar.work(str(args["paper"]))
                if not work:
                    return _text("I couldn't find that paper.")
                works = await scholar.related(work, limit=int(args.get("limit") or 6))
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}). Try again in a moment.", True)
            title = work.get("display_name") or "that paper"
            if not works:
                return _text(f"The index lists no related papers for {title}. find_papers on its topic may help.")
            lines = [f"{len(works)} papers related to {title}:"] + [describe(w, i + 1) for i, w in enumerate(works)]
            return _text("\n".join(lines))

        @tool(
            "get_paper",
            "Save a paper's free, legal copy (open access only) in Documents › Jarvis › Papers: its full "
            "text with headings when an open archive has it, else its PDF. Then read it aloud with "
            "read_document, a part at a time. Says so when there is no free copy.",
            {"type": "object", "properties": {"paper": PAPER}, "required": ["paper"]},
        )
        async def get_paper(args):
            try:
                work = await scholar.work(str(args["paper"]))
                if not work:
                    return _text("I couldn't find that paper.")
                path = await scholar.fetch_pdf(work)
            except Exception as exc:
                return _text(f"I couldn't get the paper ({exc}).", True)
            if path is None:
                where = free_link(work)
                return _text(
                    "There is no free PDF of this paper I can save."
                    + (f" A free version may be readable on the web at {where}." if where else "")
                    + " Your library or the publisher may have it."
                )
            return _text(f"Saved: {path}. Read it with read_document, a part at a time.")

        @tool(
            "cite",
            "The exact reference for a paper from its DOI's registry. style: apa, mla, chicago, "
            "harvard, ieee, vancouver or bibtex (default: the owner's).",
            {"type": "object", "properties": {"paper": PAPER, "style": {"type": "string"}}, "required": ["paper"]},
        )
        async def cite(args):
            doi = clean_doi(str(args["paper"]))
            try:
                if not doi:
                    work = await scholar.work(str(args["paper"]))
                    doi = clean_doi((work or {}).get("doi"))
                if not doi:
                    return _text("That paper has no DOI, so I can't give an exact reference for it.")
                return _text(await scholar.cite(doi, style(args)))
            except Exception as exc:
                return _text(f"The DOI registry didn't give a reference ({type(exc).__name__}).", True)

        @tool(
            "save_paper",
            "Add a paper to the owner's library, with an optional note.",
            {"type": "object", "properties": {"paper": PAPER, "note": {"type": "string"}}, "required": ["paper"]},
        )
        async def save_paper(args):
            try:
                work = await scholar.work(str(args["paper"]))
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}).", True)
            if not work:
                return _text("I couldn't find that paper.")
            entry, new = scholar.save(work, str(args.get("note") or ""))
            n = len(scholar.library())
            return _text(f"{'Saved' if new else 'Already in the library, updated'}: {entry['title']}. The library has {n} papers.")

        @tool("list_library", "The papers in the owner's library.", {"type": "object", "properties": {}})
        async def list_library(_args):
            items = scholar.library()
            if not items:
                return _text("The library is empty.")
            lines = [f"{len(items)} papers in the library:"]
            for i, it in enumerate(items, 1):
                lines.append(f"{i}. {it.get('title')}, {it.get('authors')}, {it.get('year') or 'no year'}." + (f" Note: {it['note']}" if it.get("note") else ""))
            return _text("\n".join(lines))

        @tool(
            "remove_paper",
            "Take a paper out of the library (by DOI or words of its title).",
            {"type": "object", "properties": {"paper": PAPER}, "required": ["paper"]},
        )
        async def remove_paper(args):
            gone = scholar.remove(str(args["paper"]))
            return _text(f"Removed: {gone['title']}." if gone else "That paper isn't in the library.")

        @tool(
            "bibliography",
            "The library's reference list in a style (default: the owner's), written to Documents › "
            "Jarvis › Papers as text, with a .bib file for a reference manager.",
            {"type": "object", "properties": {"style": {"type": "string"}}},
        )
        async def bibliography(args):
            if not scholar.library():
                return _text("The library is empty: save papers first.")
            text, files = await scholar.bibliography(style(args))
            return _text(f"Written to {', '.join(str(f) for f in files)}.\n\n{text}")

        @tool(
            "open_paper",
            "Open a paper's page in the owner's browser, through their university library's sign-in "
            "when that link is set (so a paywalled paper opens with their own library access).",
            {"type": "object", "properties": {"paper": PAPER}, "required": ["paper"]},
        )
        async def open_paper(args):
            doi = clean_doi(str(args["paper"]))
            try:
                if not doi:
                    work = await scholar.work(str(args["paper"]))
                    doi = clean_doi((work or {}).get("doi"))
            except Exception as exc:
                return _text(f"The paper index didn't answer ({type(exc).__name__}).", True)
            if not doi:
                return _text("That paper has no DOI to open.")
            prefix = str(hub.prefs.feature("scholar_proxy") or "")
            url = through_library(prefix, f"https://doi.org/{doi}")
            osplat.open_target(url)
            return _text(
                ("Opened through your library. Sign in there if it asks." if prefix else "Opened the publisher's page. ")
                + ("" if prefix else "To open papers through your university library, tell me its sign-in link.")
            )

        @tool(
            "set_library_link",
            "Keep the owner's university library sign-in link for papers (an EZproxy-style prefix, "
            "such as https://login.libproxy.example.edu/login?url=). Empty clears it.",
            {"type": "object", "properties": {"link": {"type": "string"}}, "required": ["link"]},
        )
        async def set_library_link(args):
            link = str(args.get("link") or "").strip()
            if _proxy(link) is None:
                return _text("That isn't a library sign-in link: it should start with https://.", True)
            hub.set_feature_prefs({"scholar_proxy": link})
            return _text("Library link kept." if link else "Library link cleared.")

        return create_sdk_mcp_server(
            name="scholar",
            version="0.1.0",
            tools=[find_papers, paper_details, who_cites, related_papers, get_paper, cite, save_paper, list_library, remove_paper, bibliography, open_paper, set_library_link],
        )

    hub.register_server(
        "scholar",
        build,
        prompt=PROMPT,
        labels=LABELS,
        web=("find_papers", "paper_details", "who_cites", "related_papers", "cite", "bibliography"),
    )
