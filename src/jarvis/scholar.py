"""Scholarly research for the owner: finding papers, reading the open-access ones, citing them
exactly, and keeping a library with its bibliography. Made for a professor who works by ear
(J.A.R.V.I.S. Daredevil), so every answer is plain sentences with counts first, ready to be
read aloud.

- find_papers: OpenAlex (the open index of some 250 million scholarly works: no key, no
  account), by topic, with years, open access only, a field's newest or most cited.
- paper_details: one paper's abstract (OpenAlex keeps it as a word index: rebuilt here), its
  venue, citations, whether it was retracted, and where a free copy is.
- get_paper: the free, legal copy of a paper (the open-access PDF OpenAlex names, never a
  paywall around) saved in Documents › Jarvis › Papers, to be read aloud in parts with
  read_document.
- cite: the exact reference from the DOI's own registry (doi.org content negotiation, the
  publishers' CSL styles): APA, MLA, Chicago, Harvard, IEEE, Vancouver, or BibTeX.
- save_paper / list_library / remove_paper / bibliography: the owner's library (a file in the
  feature's folder) and its reference list in a style, written to Documents › Jarvis › Papers
  as text and as a .bib for a reference manager.

Nothing here calls a model. What the indexes return is third-party text (titles, abstracts):
those results are marked "web" for the turn gate.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

OPENALEX = "https://api.openalex.org"
USER_AGENT = "JARVIS/1.0 (askeden.com; scholarly search for a researcher)"
TIMEOUT = 20.0
MAX_RESULTS = 10
MAX_PDF_BYTES = 80 * 1024 * 1024

# Spoken names -> doi.org's CSL style names.
STYLES = {
    "apa": "apa",
    "mla": "modern-language-association",
    "chicago": "chicago-author-date",
    "harvard": "harvard-cite-them-right",
    "ieee": "ieee",
    "vancouver": "vancouver",
}
DOI = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.I)


def style_key(style: str | None) -> str:
    s = str(style or "apa").strip().lower()
    if s.startswith("bib"):
        return "bibtex"
    for key in STYLES:
        if s.startswith(key):
            return key
    return "apa"


def clean_doi(value: str | None) -> str:
    m = DOI.search(str(value or ""))
    return m.group(0).rstrip(".,;)") if m else ""


def abstract_from_index(index: dict[str, list[int]] | None) -> str:
    """OpenAlex keeps abstracts as {word: [positions]}: the text back in order."""
    if not isinstance(index, dict) or not index:
        return ""
    words: dict[int, str] = {}
    for word, places in index.items():
        for p in places or []:
            if isinstance(p, int):
                words[p] = word
    return " ".join(words[i] for i in sorted(words))


def authors_of(work: dict[str, Any], most: int = 3) -> str:
    names = [
        ((a.get("author") or {}).get("display_name") or "").strip()
        for a in work.get("authorships") or []
    ]
    names = [n for n in names if n]
    if not names:
        return "unknown authors"
    if len(names) <= most:
        return ", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1]
    return f"{', '.join(names[:most])} and {len(names) - most} others"


def venue_of(work: dict[str, Any]) -> str:
    source = (work.get("primary_location") or {}).get("source") or {}
    return str(source.get("display_name") or "").strip()


def free_pdfs(work: dict[str, Any]) -> list[str]:
    """Every open-access PDF the index knows for the paper, the best first."""
    urls: list[str] = []
    for loc in [work.get("best_oa_location"), work.get("primary_location"), *(work.get("locations") or [])]:
        if isinstance(loc, dict) and loc.get("pdf_url") and loc.get("is_oa", True) and loc["pdf_url"] not in urls:
            urls.append(str(loc["pdf_url"]))
    return urls


def arxiv_pdfs(work: dict[str, Any]) -> list[str]:
    for loc in work.get("locations") or []:
        url = str((loc or {}).get("landing_page_url") or "")
        m = re.search(r"arxiv\.org/abs/([\w./-]+?)(v\d+)?$", url)
        if m:
            return [f"https://arxiv.org/pdf/{m.group(1)}"]
    return []


def jats_text(xml: str) -> str:
    """An article's full text (JATS XML, as Europe PMC gives it) as plain text with its headings:
    the title, the abstract, then each section's heading and paragraphs. Figures, tables and the
    reference list are left out (they read badly aloud); the references stay in the paper's record."""
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml)

    def words(node: Any) -> str:
        return re.sub(r"\s+", " ", "".join(node.itertext())).strip()

    out: list[str] = []
    title = root.find(".//article-meta//article-title")
    if title is not None:
        out.append(words(title))
    abstract = root.find(".//article-meta/abstract")
    if abstract is not None:
        out.append("\nAbstract\n" + "\n".join(words(p) for p in abstract.iter("p")))
    body = root.find(".//body")

    def section(node: Any, depth: int) -> None:
        for child in node:
            tag = child.tag
            if tag == "sec":
                head = child.find("title")
                if head is not None and words(head):
                    out.append("\n" + words(head))
                section(child, depth + 1)
            elif tag == "p":
                text = words(child)
                if text:
                    out.append(text)

    if body is not None:
        section(body, 0)
    return "\n".join(out).strip() + "\n"


def free_pdf(work: dict[str, Any]) -> str:
    found = free_pdfs(work)
    return found[0] if found else ""


def free_link(work: dict[str, Any]) -> str:
    oa = work.get("open_access") or {}
    return str(oa.get("oa_url") or "") if oa.get("is_oa") else ""


def short_id(work: dict[str, Any]) -> str:
    return str(work.get("id") or "").rsplit("/", 1)[-1]


def describe(work: dict[str, Any], n: int | None = None) -> str:
    """One paper as a sentence or two, the way it is best heard."""
    parts = [f"{n}. " if n else "", f"{work.get('display_name') or 'Untitled'}"]
    year = work.get("publication_year")
    parts.append(f", {authors_of(work)}")
    if year:
        parts.append(f", {year}")
    venue = venue_of(work)
    if venue:
        parts.append(f", in {venue}")
    parts.append(f". Cited {int(work.get('cited_by_count') or 0)} times.")
    if work.get("is_retracted"):
        parts.append(" This paper was retracted.")
    if (work.get("type") or "") == "preprint":
        parts.append(" A preprint, not yet peer reviewed.")
    parts.append(" A free copy is available." if free_link(work) or free_pdf(work) else " No free copy found.")
    doi = clean_doi(work.get("doi"))
    parts.append(f" DOI {doi}." if doi else f" OpenAlex {short_id(work)}.")
    return "".join(parts)


class Scholar:
    def __init__(self, library_file: Path, papers_dir: Path, *, client: Any = None) -> None:
        self.library_file = Path(library_file)
        self.papers_dir = Path(papers_dir)
        self._client = client

    def client(self) -> Any:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=TIMEOUT, follow_redirects=True, headers={"user-agent": USER_AGENT}
            )
        return self._client

    # ── the index ──

    async def search(
        self,
        query: str,
        *,
        since: int | None = None,
        until: int | None = None,
        open_access: bool = False,
        sort: str = "relevance",
        limit: int = 6,
    ) -> list[dict[str, Any]]:
        filters = ["type:article|preprint|review|book-chapter|book|dissertation"]
        if since:
            filters.append(f"from_publication_date:{int(since)}-01-01")
        if until:
            filters.append(f"to_publication_date:{int(until)}-12-31")
        if open_access:
            filters.append("is_oa:true")
        params = {"per-page": str(max(1, min(MAX_RESULTS, int(limit))))}
        if sort in ("cited", "newest"):
            # Sorted by something else than relevance, only papers whose title or abstract is about it
            # (a plain search sorted by citations brings famous papers that mention the words once).
            filters.append(f"title_and_abstract.search:{query.replace(',', ' ')}")
        else:
            params["search"] = query
        params["filter"] = ",".join(filters)
        if sort == "cited":
            params["sort"] = "cited_by_count:desc"
        elif sort == "newest":
            params["sort"] = "publication_date:desc"
        r = await self.client().get(f"{OPENALEX}/works", params=params)
        r.raise_for_status()
        return list(r.json().get("results") or [])

    async def work(self, ident: str) -> dict[str, Any] | None:
        """A paper by DOI, OpenAlex id (W123…) or title words (the best match)."""
        ident = str(ident or "").strip()
        doi = clean_doi(ident)
        if doi:
            path = f"doi:{quote(doi, safe='/:')}"
        elif re.fullmatch(r"(https://openalex\.org/)?W\d+", ident, re.I):
            path = ident.rsplit("/", 1)[-1].upper()
        else:
            found = await self.search(ident, limit=1)
            return found[0] if found else None
        r = await self.client().get(f"{OPENALEX}/works/{path}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    # ── citing ──

    async def cite(self, doi: str, style: str = "apa") -> str:
        doi = clean_doi(doi)
        if not doi:
            raise ValueError("no DOI to cite")
        key = style_key(style)
        accept = (
            "application/x-bibtex"
            if key == "bibtex"
            else f"text/x-bibliography; style={STYLES[key]}; locale=en-US"
        )
        r = await self.client().get(f"https://doi.org/{doi}", headers={"accept": accept})
        r.raise_for_status()
        if key == "bibtex":
            return r.text.strip()
        text = re.sub(r"\s+", " ", r.text).strip()
        return re.sub(r",? edited by\s*,", ",", text)  # (an empty editor field in some publishers' records)

    # ── the free copy ──

    async def fetch_pdf(self, work: dict[str, Any]) -> Path | None:
        """The paper's free copy, saved: the full text from Europe PMC (the open biomedical archive,
        as clean sections, which read aloud better than a PDF), arXiv's PDF, or the first open
        PDF a repository will actually give. None when there is none to get."""
        title = re.sub(r"[^\w\s-]", "", str(work.get("display_name") or "paper"))[:80].strip() or "paper"
        year = work.get("publication_year") or ""
        stem = f"{title} ({year})" if year else title
        pmcid = await self._pmcid(work)
        if pmcid:
            try:
                text = await self._europe_pmc(pmcid.upper())
            except Exception:
                text = ""
            if text:
                self.papers_dir.mkdir(parents=True, exist_ok=True)
                target = self.papers_dir / f"{stem}.txt"
                target.write_text(text, encoding="utf-8")
                return target
        for url in arxiv_pdfs(work) + free_pdfs(work):
            try:
                data = await self._download(url)
            except Exception:
                continue  # a repository that refuses or fails: the next copy
            if data is not None:
                self.papers_dir.mkdir(parents=True, exist_ok=True)
                target = self.papers_dir / f"{stem}.pdf"
                target.write_bytes(data)
                return target
        return None

    async def _pmcid(self, work: dict[str, Any]) -> str:
        """The paper's open-access PubMed Central id: the index's, else Europe PMC's answer for its
        DOI or PubMed id ("" when it has no open full text there)."""
        ids = work.get("ids") or {}
        known = str(ids.get("pmcid") or "").rsplit("/", 1)[-1].upper()
        if known.startswith("PMC"):
            return known
        doi = clean_doi(work.get("doi"))
        pmid = str(ids.get("pmid") or "").rstrip("/").rsplit("/", 1)[-1]
        query = f'DOI:"{doi}"' if doi else (f"EXT_ID:{pmid} AND SRC:MED" if pmid.isdigit() else "")
        if not query:
            return ""
        try:
            r = await self.client().get(
                "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                params={"query": query, "format": "json", "resultType": "lite", "pageSize": "1"},
            )
            hit = ((r.json().get("resultList") or {}).get("result") or [{}])[0]
        except Exception:
            return ""
        if hit.get("isOpenAccess") == "Y" and str(hit.get("pmcid") or "").startswith("PMC"):
            return str(hit["pmcid"])
        return ""

    async def _europe_pmc(self, pmcid: str) -> str:
        r = await self.client().get(f"https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML")
        if r.status_code != 200 or "<article" not in r.text[:2000]:
            return ""
        return jats_text(r.text)

    async def _download(self, url: str) -> bytes | None:
        # (some repositories serve their open copies only to a browser's name)
        headers = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS/1.0", "accept": "application/pdf,*/*"}
        async with self.client().stream("GET", url, headers=headers) as r:
            r.raise_for_status()
            data = bytearray()
            async for chunk in r.aiter_bytes():
                data += chunk
                if len(data) > MAX_PDF_BYTES:
                    raise ValueError("larger than 80 MB")
        return bytes(data) if bytes(data[:1024]).lstrip().startswith(b"%PDF") else None

    # ── the library ──

    def library(self) -> list[dict[str, Any]]:
        try:
            items = json.loads(self.library_file.read_text())
            return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []
        except (OSError, ValueError):
            return []

    def _write_library(self, items: list[dict[str, Any]]) -> None:
        self.library_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.library_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, indent=1, ensure_ascii=False))
        tmp.replace(self.library_file)

    def save(self, work: dict[str, Any], note: str = "") -> tuple[dict[str, Any], bool]:
        entry = {
            "id": short_id(work),
            "doi": clean_doi(work.get("doi")),
            "title": str(work.get("display_name") or "Untitled"),
            "authors": authors_of(work, most=20),
            "year": work.get("publication_year"),
            "venue": venue_of(work),
            "note": str(note or "")[:500],
            "saved": time.strftime("%Y-%m-%d"),
        }
        items = self.library()
        for i, old in enumerate(items):
            if (entry["doi"] and old.get("doi") == entry["doi"]) or old.get("id") == entry["id"]:
                items[i] = {**old, **{k: v for k, v in entry.items() if v}}
                self._write_library(items)
                return items[i], False
        items.append(entry)
        self._write_library(items)
        return entry, True

    def remove(self, words: str) -> dict[str, Any] | None:
        items = self.library()
        key = str(words or "").strip().lower()
        doi = clean_doi(words)
        for i, it in enumerate(items):
            if (doi and it.get("doi") == doi) or (key and key in str(it.get("title", "")).lower()):
                gone = items.pop(i)
                self._write_library(items)
                return gone
        return None

    async def bibliography(self, style: str = "apa") -> tuple[str, list[Path]]:
        key = style_key(style)
        items = self.library()
        refs: list[str] = []
        bib: list[str] = []
        for it in items:
            doi = it.get("doi")
            ref = ""
            if doi:
                try:
                    ref = await self.cite(doi, key if key != "bibtex" else "apa")
                except Exception:
                    ref = ""
                try:
                    bib.append(await self.cite(doi, "bibtex"))
                except Exception:
                    pass
            if not ref:
                ref = f"{it.get('authors')} ({it.get('year') or 'n.d.'}). {it.get('title')}. {it.get('venue') or ''}".strip()
            refs.append(ref)
        refs.sort(key=str.lower)
        self.papers_dir.mkdir(parents=True, exist_ok=True)
        label = key.upper() if key in ("apa", "mla", "ieee") else key.capitalize()
        text_file = self.papers_dir / f"Bibliography ({label}).txt"
        text_file.write_text("\n\n".join(refs) + "\n", encoding="utf-8")
        files = [text_file]
        if bib:
            bib_file = self.papers_dir / "Library.bib"
            bib_file.write_text("\n\n".join(bib) + "\n", encoding="utf-8")
            files.append(bib_file)
        return "\n\n".join(refs), files
