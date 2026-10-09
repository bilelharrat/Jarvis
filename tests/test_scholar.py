"""Scholarly research (jarvis.scholar, features/scholar.py): papers found, described for the ear,
fetched only from open copies, cited exactly, kept in a library. No network: a stand-in server."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from jarvis import scholar as S
from jarvis.features import scholar as feature

WORK = {
    "id": "https://openalex.org/W123",
    "display_name": "Sleep and memory",
    "publication_year": 2011,
    "doi": "https://doi.org/10.1000/abc.1",
    "type": "article",
    "cited_by_count": 42,
    "is_retracted": False,
    "authorships": [{"author": {"display_name": n}} for n in ("Ann Lee", "Bo Chen", "Cy Diaz", "Di Eve")],
    "primary_location": {"source": {"display_name": "Nature Reviews"}, "pdf_url": None},
    "best_oa_location": {"pdf_url": "https://repo.example/paper.pdf", "is_oa": True},
    "locations": [{"landing_page_url": "https://repo.example/landing"}],
    "open_access": {"is_oa": True, "oa_url": "https://repo.example/landing"},
    "ids": {"pmid": "https://pubmed.ncbi.nlm.nih.gov/111"},
    "abstract_inverted_index": {"Sleep": [0], "helps": [1], "memory.": [2]},
}
JATS = """<article><front><article-meta><title-group><article-title>Sleep and memory</article-title></title-group>
<abstract><p>Sleep helps memory.</p></abstract></article-meta></front>
<body><sec><title>Introduction</title><p>First   point.</p><fig><caption>no</caption></fig></sec>
<sec><title>Results</title><sec><title>Sub</title><p>Second point.</p></sec></sec></body></article>"""


def server(*, pmc_open=True, pdf=b"%PDF-1.7 data", seen=None):
    def handle(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if seen is not None:
            seen.append(url)
        if "api.openalex.org/works?" in url or url.startswith("https://api.openalex.org/works?"):
            return httpx.Response(200, json={"results": [WORK]})
        if "api.openalex.org/works/" in url:
            return httpx.Response(200, json=WORK)
        if "europepmc/webservices/rest/search" in url:
            hit = {"isOpenAccess": "Y" if pmc_open else "N", "pmcid": "PMC999"}
            return httpx.Response(200, json={"resultList": {"result": [hit]}})
        if url.endswith("/PMC999/fullTextXML"):
            return httpx.Response(200, text=JATS)
        if url.startswith("https://doi.org/"):
            accept = request.headers.get("accept", "")
            if "bibtex" in accept:
                return httpx.Response(200, text="@article{lee2011, title={Sleep and memory}}")
            style = accept.split("style=")[1].split(";")[0]
            return httpx.Response(200, text=f"Lee, A. (2011). Sleep and memory [{style}], edited by , Nature.")
        if url == "https://repo.example/paper.pdf":
            return httpx.Response(200, content=pdf, headers={"content-type": "application/pdf"})
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=True)


def make(tmp_path: Path, **kw) -> S.Scholar:
    return S.Scholar(tmp_path / "lib.json", tmp_path / "Papers", client=server(**kw))


def run(coro):
    return asyncio.run(coro)


def test_a_paper_is_said_the_way_it_is_best_heard():
    text = S.describe(WORK, 1)
    assert text.startswith("1. Sleep and memory, Ann Lee, Bo Chen, Cy Diaz and 1 others, 2011, in Nature Reviews.")
    assert "Cited 42 times." in text and "A free copy is available." in text and "DOI 10.1000/abc.1." in text
    retracted = S.describe({**WORK, "is_retracted": True, "type": "preprint"})
    assert "was retracted" in retracted and "not yet peer reviewed" in retracted


def test_the_abstract_is_put_back_in_order_and_dois_are_found_in_anything():
    assert S.abstract_from_index({"memory.": [2], "Sleep": [0], "helps": [1]}) == "Sleep helps memory."
    assert S.abstract_from_index(None) == ""
    assert S.clean_doi("see https://doi.org/10.1234/x.y(2), ok") == "10.1234/x.y(2"
    assert S.clean_doi("no doi here") == ""
    assert [S.style_key(s) for s in ("MLA", "chicago author-date", "BibTeX", "nonsense", None)] == ["mla", "chicago", "bibtex", "apa", "apa"]


def test_search_sorted_by_citations_keeps_to_papers_about_the_topic(tmp_path):
    seen = []
    s = make(tmp_path, seen=seen)
    run(s.search("sleep, memory", sort="cited", since=2010, open_access=True, limit=50))
    url = seen[-1]
    assert "title_and_abstract.search" in url and "sort=cited_by_count" in url and "is_oa%3Atrue" in url.replace(":", "%3A")
    assert "from_publication_date%3A2010-01-01" in url.replace(":", "%3A") and "per-page=10" in url
    run(s.search("sleep", limit=3))
    assert "search=sleep" in seen[-1] and "sort=" not in seen[-1]


def test_a_citation_comes_from_the_dois_registry_in_the_style_asked(tmp_path):
    s = make(tmp_path)
    assert run(s.cite("10.1000/abc.1", "mla")) == "Lee, A. (2011). Sleep and memory [modern-language-association], Nature."
    assert run(s.cite("doi 10.1000/abc.1", "bibtex")).startswith("@article")
    with pytest.raises(ValueError):
        run(s.cite("not a doi"))


def test_the_free_copy_is_the_open_archives_full_text_with_its_headings(tmp_path):
    s = make(tmp_path)
    path = run(s.fetch_pdf(WORK))
    assert path.name == "Sleep and memory (2011).txt"
    text = path.read_text()
    assert text.splitlines()[0] == "Sleep and memory"
    assert "Abstract\nSleep helps memory." in text and "\nIntroduction\nFirst point." in text and "\nSub\nSecond point." in text
    assert "no" not in text.split("Introduction")[1].split("Results")[0].replace("Introduction", "").split()  # figures left out


def test_without_an_open_archive_copy_the_open_pdf_is_saved_but_never_a_web_page(tmp_path):
    s = make(tmp_path, pmc_open=False)
    path = run(s.fetch_pdf(WORK))
    assert path.suffix == ".pdf" and path.read_bytes().startswith(b"%PDF")
    s2 = S.Scholar(tmp_path / "l2.json", tmp_path / "P2", client=server(pmc_open=False, pdf=b"<html>sign in</html>"))
    assert run(s2.fetch_pdf(WORK)) is None
    assert run(s.fetch_pdf({**WORK, "best_oa_location": None, "ids": {}, "doi": None})) is None


def test_the_library_keeps_one_entry_a_paper_and_its_bibliography_is_written(tmp_path):
    s = make(tmp_path)
    entry, new = s.save(WORK, "for the grant")
    assert new and entry["doi"] == "10.1000/abc.1" and entry["note"] == "for the grant"
    _, again = s.save(WORK)
    assert not again and len(s.library()) == 1
    text, files = run(s.bibliography("apa"))
    assert "[apa]" in text and [f.name for f in files] == ["Bibliography (APA).txt", "Library.bib"]
    assert s.remove("Sleep and")["title"] == "Sleep and memory"
    assert s.library() == []
    assert s.remove("anything") is None


def test_a_broken_library_file_is_an_empty_library(tmp_path):
    s = make(tmp_path)
    (tmp_path / "lib.json").write_text("{nope")
    assert s.library() == []


# ── the feature: its tools, its settings, and what it will never use ──


def hub_for(tmp_path, monkeypatch):
    prefs = {"scholar_style": "mla", "scholar_proxy": ""}
    servers = {}
    hub = SimpleNamespace(
        feature_path=lambda name: tmp_path / name,
        prefs=SimpleNamespace(feature=lambda k: prefs.get(k)),
        set_feature_prefs=lambda changes: prefs.update(changes) or list(changes),
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        tasks=SimpleNamespace(citation_style=lambda: "apa"),
    )
    monkeypatch.setattr(feature, "papers_folder", lambda: tmp_path / "Papers")
    feature.install(hub)
    hub.scholar._client = server()
    return hub, servers, prefs


def test_the_feature_registers_its_tools_and_the_owners_citation_style(tmp_path, monkeypatch):
    hub, servers, prefs = hub_for(tmp_path, monkeypatch)
    build, kw = servers["scholar"]
    assert "Never use or suggest Library Genesis, Anna's Archive or Sci-Hub" in kw["prompt"]
    assert set(kw["web"]) == {"find_papers", "paper_details", "cite", "bibliography"}
    assert hub.tasks.citation_style() == "mla"
    assert build()["name"] == "scholar"


def test_the_library_link_is_only_an_https_address_and_papers_open_through_it(tmp_path, monkeypatch):
    assert feature._proxy("https://login.lib.example.edu/login?url=") == "https://login.lib.example.edu/login?url="
    assert feature._proxy("") == ""
    assert feature._proxy("http://insecure/") is None and feature._proxy("javascript:alert(1)") is None
    assert feature.through_library("https://p.example/login?url=", "https://doi.org/10.1/x") == "https://p.example/login?url=https%3A%2F%2Fdoi.org%2F10.1%2Fx"
    assert feature.through_library("https://p.example/", "https://doi.org/10.1/x") == "https://p.example/https://doi.org/10.1/x"
    assert feature.through_library("", "https://doi.org/10.1/x") == "https://doi.org/10.1/x"
