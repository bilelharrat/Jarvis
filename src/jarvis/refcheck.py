"""The reference checker: a manuscript's (or a student's, or a pasted list's) references, each
looked up in Crossref (the DOI registry's own records), then OpenAlex, and reported in three
groups: found and matching, found but differing (title, year or first author: the record's
value is said beside the reference's), and not found.

Nothing is ever "fixed": a reference that doesn't match is reported with what the record says,
never rewritten, and one that can't be found is said to be not found, never guessed at. Books,
reports and web pages are often missing from both indexes, so "not found" means "check by
hand", not "invented".

Claude cost policy: no model call; Crossref and OpenAlex are free and need no key.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from .scholar import DOI, OPENALEX, clean_doi

CROSSREF = "https://api.crossref.org/works"
MAX_REFS = 80
AT_ONCE = 4  # lookups at a time (the indexes ask for politeness)
TITLE_MATCH = 0.8  # share of the record's title words that must be in the reference
HEADING = re.compile(
    r"^\s*(?:\d+\.?\s*)?(references|reference list|bibliography|works cited|literature cited|"
    r"cited literature|sources)\s*:?\s*$",
    re.I | re.M,
)
STOP = {"a", "an", "the", "of", "and", "in", "on", "for", "to", "with", "by", "at", "from", "or", "is", "are"}
YEAR = re.compile(r"\b(1[6-9]\d{2}|20\d{2})[a-z]?\b")
NUMBERED = re.compile(r"(?m)^\s*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+")
NEW_ENTRY = re.compile(r"^[A-ZÀ-ɏ][\w'’\-À-ɏ]+(?: [A-ZÀ-ɏ][\w'’\-]+)?,\s+(?:[A-Z]\.|[A-Z][a-z])")


@dataclass
class Check:
    n: int
    text: str
    status: str = "not found"  # "match", "differs", "not found", "unchecked" (no index answered)
    differences: list[str] = field(default_factory=list)
    record: dict[str, Any] = field(default_factory=dict)  # title, year, author, doi, source
    note: str = ""


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", _fold(text)) if w not in STOP]


def references_part(text: str) -> str:
    """The reference list of a document: what follows its last References (or Bibliography…)
    heading; the whole text when there's no such heading (a pasted list)."""
    heads = list(HEADING.finditer(text))
    if heads:
        return text[heads[-1].end():]
    return text


def split_references(text: str) -> list[str]:
    """The reference list as separate references: by their numbers ([1], 1.) when numbered, by
    blank lines when there are some, else line by line, a wrapped line joined to the one before."""
    text = references_part(text).replace("\r\n", "\n").strip()
    if not text:
        return []
    marks = list(NUMBERED.finditer(text))
    if len(marks) >= 2:
        refs = [text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)] for i, m in enumerate(marks)]
    else:
        blocks = [b for b in re.split(r"\n\s*\n", text) if b.strip()]
        if len(blocks) >= 2:
            refs = blocks
        else:
            lines = [line.strip() for line in text.split("\n") if line.strip()]
            if sum(1 for line in lines if NEW_ENTRY.match(line)) >= 2:
                # "Surname, I." starts each reference: the lines between are its wrapped rest.
                refs = []
                for line in lines:
                    if refs and not NEW_ENTRY.match(line):
                        refs[-1] += " " + line
                    else:
                        refs.append(line)
            else:
                refs = lines
    cleaned = [re.sub(r"\s+", " ", r).strip() for r in refs]
    # A reference has some words and usually a year or a DOI; headers, page numbers don't.
    return [r for r in cleaned if len(r) >= 25 and (YEAR.search(r) or DOI.search(r))][:MAX_REFS]


def first_author(ref: str) -> str:
    """The reference's first author's family name, as written ("" when it can't be told)."""
    ref = re.sub(r"^\s*(\[\d+\]|\d+\.)\s*", "", ref)
    m = re.match(r"([A-ZÀ-ɏ][\w'’\-À-ɏ]+(?:\s(?:van|von|de|der|da|di|le|la)\s[\w'’\-]+)?)\s*,", ref)
    if m:
        return m.group(1)
    # "A. B. Smith, …" (IEEE) or "Smith AB, …" (Vancouver)
    m = re.match(r"(?:[A-Z]\.\s?-?)+\s*([A-Z][\w'’\-]+)", ref)
    if m:
        return m.group(1)
    m = re.match(r"([A-Z][\w'’\-]+)\s+[A-Z]{1,3}\b", ref)
    return m.group(1) if m else ""


def year_of(ref: str) -> int | None:
    found = YEAR.findall(ref)
    m = re.search(r"\((1[6-9]\d{2}|20\d{2})[a-z]?[),]", ref)  # (2011) is the year; a bare 2011 may be a page
    if m:
        return int(m.group(1))
    return int(found[0]) if found else None


def title_guess(ref: str) -> str:
    """The reference's title where its style shows it: after "(2011)." in APA, in quotes in
    IEEE and MLA ("" when it can't be told)."""
    m = re.search(r"[“\"]([^”\"]{8,300}?)[,.]?[”\"]", ref)
    if m:
        return m.group(1).strip()
    m = re.search(r"\((?:1[6-9]|20)\d{2}[a-z]?(?:, [^)]*)?\)\.\s+(.{8,300}?[^A-Z])[.?!](?:\s|$)", ref)
    return m.group(1).strip() if m else ""


def title_overlap(title: str, ref: str) -> float:
    """The share of a record's title words found in the reference (1.0: every one)."""
    words = _words(title)
    if not words:
        return 0.0
    have = set(_words(ref))
    return sum(1 for w in words if w in have) / len(words)


def _crossref_record(item: dict[str, Any]) -> dict[str, Any]:
    title = " ".join(item.get("title") or []) or ""
    sub = " ".join(item.get("subtitle") or [])
    year = None
    for key in ("published-print", "published-online", "issued", "published", "created"):
        parts = ((item.get(key) or {}).get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            year = int(parts[0])
            break
    authors = item.get("author") or []
    first = ""
    for a in authors:
        if a.get("sequence") == "first" or not first:
            first = str(a.get("family") or a.get("name") or "")
            if a.get("sequence") == "first":
                break
    years = set()
    for key in ("published-print", "published-online", "issued"):
        parts = ((item.get(key) or {}).get("date-parts") or [[None]])[0]
        if parts and parts[0]:
            years.add(int(parts[0]))
    return {
        "title": (title + (": " + sub if sub and sub.lower() not in title.lower() else "")).strip(),
        "year": year,
        "years": sorted(years),
        "author": first,
        "doi": str(item.get("DOI") or "").lower(),
        "source": "Crossref",
        "retracted": any((u or {}).get("type") == "retraction" for u in item.get("updated-by") or []),
    }


def _openalex_record(work: dict[str, Any]) -> dict[str, Any]:
    first = ""
    for a in work.get("authorships") or []:
        name = str((a.get("author") or {}).get("display_name") or "")
        first = name.split()[-1] if name else ""
        break
    year = work.get("publication_year")
    return {
        "title": str(work.get("display_name") or ""),
        "year": year,
        "years": [year] if year else [],
        "author": first,
        "doi": clean_doi(work.get("doi")).lower(),
        "source": "OpenAlex",
        "retracted": bool(work.get("is_retracted")),
    }


def compare(ref: str, record: dict[str, Any], *, by_doi: bool) -> list[str]:
    """How a reference differs from its record, in words ([] when it matches)."""
    out: list[str] = []
    title = record.get("title") or ""
    # A reference that is only a DOI has nothing to compare its title with.
    rest = DOI.sub("", ref)
    if by_doi and len(_words(rest)) >= 4 and title and title_overlap(title, rest) < TITLE_MATCH:
        out.append(f"the title differs: the record's title is “{title}”")
    year = year_of(ref)
    years = record.get("years") or ([record["year"]] if record.get("year") else [])
    # Online and print years often differ by one: either counts.
    if year and years and not any(abs(year - y) <= (0 if len(years) > 1 else 1) for y in years):
        out.append(f"the year differs: the reference says {year}, the record says {years[0]}")
    author = first_author(ref)
    rec_author = str(record.get("author") or "")
    if author and rec_author and _fold(author) not in _fold(rec_author) and _fold(rec_author) not in _fold(author):
        out.append(f"the first author differs: the reference says {author}, the record says {rec_author}")
    return out


class ReferenceChecker:
    def __init__(self, client: Any) -> None:
        self.client = client  # an httpx.AsyncClient (the scholar's)

    async def _crossref_doi(self, doi: str) -> dict[str, Any] | None:
        r = await self.client.get(f"{CROSSREF}/{quote(doi, safe='/:()')}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return _crossref_record(r.json().get("message") or {})

    async def _openalex_doi(self, doi: str) -> dict[str, Any] | None:
        r = await self.client.get(f"{OPENALEX}/works/doi:{quote(doi, safe='/:()')}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return _openalex_record(r.json())

    async def _crossref_search(self, ref: str) -> list[dict[str, Any]]:
        r = await self.client.get(CROSSREF, params={"query.bibliographic": ref[:400], "rows": "5"})
        r.raise_for_status()
        return [_crossref_record(i) for i in (r.json().get("message") or {}).get("items") or []]

    async def _openalex_search(self, ref: str) -> list[dict[str, Any]]:
        title = title_guess(ref)
        if title:  # the title alone finds a paper far better than the whole reference
            params = {"filter": f"title.search:{title.replace(',', ' ')}", "per-page": "5"}
        else:
            words = " ".join(w for w in re.findall(r"[^\W\d_]{3,}", ref))[:300]
            if not words:
                return []
            params = {"search": words, "per-page": "5"}
        r = await self.client.get(f"{OPENALEX}/works", params=params)
        r.raise_for_status()
        return [_openalex_record(w) for w in r.json().get("results") or []]

    async def check_one(self, n: int, ref: str) -> Check:
        result = Check(n, ref)
        doi = clean_doi(ref).lower()
        try:
            if doi:
                record = await self._by_doi(doi)
                if record is None:
                    result.note = f"its DOI {doi} is not registered"
                    # The DOI may be wrong while the paper is real: look for it by its words.
                    found = await self._search(ref)
                    if found:
                        result.status = "differs"
                        result.record = found
                        result.differences = [f"its DOI {doi} is not registered; a matching paper has DOI {found.get('doi') or 'none'}"]
                        result.differences += compare(ref, found, by_doi=False)
                        result.note = ""
                    return result
                result.record = record
                result.differences = compare(ref, record, by_doi=True)
                result.status = "differs" if result.differences else "match"
                return result
            found = await self._search(ref)
        except Exception as exc:
            result.status = "unchecked"
            result.note = f"the indexes didn't answer ({type(exc).__name__})"
            return result
        if found:
            result.record = found
            result.differences = compare(ref, found, by_doi=False)
            result.status = "differs" if result.differences else "match"
        return result

    async def _search(self, ref: str) -> dict[str, Any] | None:
        """The record whose title is in the reference (Crossref first, then OpenAlex), or None.
        Several papers can share a title ("Attention is all you need"): the one whose year and
        first author also agree is preferred, and OpenAlex is asked too when Crossref has none
        that agrees in everything."""
        best: dict[str, Any] | None = None
        best_score = -1.0
        failed: Exception | None = None
        answered = False
        for search in (self._crossref_search, self._openalex_search):
            try:
                candidates = await search(ref)
                answered = True
            except Exception as exc:
                failed = exc
                continue
            for c in candidates:
                title = c.get("title") or ""
                overlap = title_overlap(title, ref)
                if len(_words(title)) < 2 or overlap < TITLE_MATCH:
                    continue
                differences = len(compare(ref, c, by_doi=False))
                if differences >= 2:  # another year and another author: another paper of that title
                    continue
                score = overlap + 2 - differences
                if score > best_score:
                    best, best_score = c, score
            if best is not None and not compare(ref, best, by_doi=False):
                break
        if best is None and not answered and failed is not None:
            raise failed  # neither index answered: that's "couldn't check", not "not found"
        return best

    async def _by_doi(self, doi: str) -> dict[str, Any] | None:
        """The DOI's record: Crossref's, else OpenAlex's (also when Crossref doesn't answer)."""
        try:
            record = await self._crossref_doi(doi)
        except Exception:
            record = None
        return record or await self._openalex_doi(doi)

    async def check(self, refs: list[str]) -> list[Check]:
        gate = asyncio.Semaphore(AT_ONCE)

        async def one(i: int, ref: str) -> Check:
            async with gate:
                return await self.check_one(i, ref)

        return list(await asyncio.gather(*(one(i + 1, r) for i, r in enumerate(refs))))


def _short(ref: str, words: int = 14) -> str:
    parts = ref.split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def report(checks: list[Check]) -> str:
    """The checks said for the ear: the counts first, then the ones that need a look."""
    if not checks:
        return "I found no references to check."
    match = [c for c in checks if c.status == "match"]
    differs = [c for c in checks if c.status == "differs"]
    missing = [c for c in checks if c.status == "not found"]
    unchecked = [c for c in checks if c.status == "unchecked"]
    lines = [
        f"Checked {len(checks)} references: {len(match)} found and matching, "
        f"{len(differs)} found but different, {len(missing)} not found"
        + (f", {len(unchecked)} couldn't be checked." if unchecked else ".")
    ]
    retracted = [c for c in checks if c.record.get("retracted")]
    if differs:
        lines.append("\nDifferent from the record:")
        for c in differs:
            lines.append(f"Reference {c.n}, {_short(c.text)}: " + "; ".join(c.differences) + ".")
    if missing:
        lines.append("\nNot found in Crossref or OpenAlex (check these by hand; books and reports are often missing):")
        for c in missing:
            lines.append(f"Reference {c.n}, {_short(c.text)}" + (f": {c.note}." if c.note else "."))
    if unchecked:
        lines.append(
            "\nCouldn't check, the indexes didn't answer (try again in a while): "
            + ", ".join(f"reference {c.n}" for c in unchecked) + "."
        )
    if retracted:
        lines.append("\nRetracted, according to the record: " + ", ".join(f"reference {c.n}" for c in retracted) + ".")
    if match and len(match) <= 40:
        lines.append("\nMatching: " + ", ".join(str(c.n) for c in match) + ".")
    return "\n".join(lines)
