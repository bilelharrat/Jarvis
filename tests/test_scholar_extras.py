"""The researcher's extras: who cites a paper and related papers, paper alerts, the reference
checker, Zotero sync, and equations said in words. No network: stand-in servers."""

from __future__ import annotations

import asyncio
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import httpx

from jarvis import mathspeech as M
from jarvis import refcheck as R
from jarvis import scholar as S
from jarvis import zotero as Z
from jarvis.features import scholar as feature
from jarvis.features import scholar_extras as extras_feature
from jarvis.paper_alerts import CHECK_EVERY, PaperAlerts

MML = 'xmlns:mml="http://www.w3.org/1998/Math/MathML"'


def run(coro):
    return asyncio.run(coro)


def work(n: int, title: str = "", **kw) -> dict:
    return {
        "id": f"https://openalex.org/W{n}",
        "display_name": title or f"Paper {n}",
        "publication_year": 2026,
        "doi": f"https://doi.org/10.1000/p{n}",
        "type": "article",
        "cited_by_count": n,
        "authorships": [{"author": {"display_name": "Ann Lee"}}],
        "primary_location": {"source": {"display_name": "Sleep"}},
        "open_access": {"is_oa": False},
        **kw,
    }


def client(handle, seen=None):
    def wrapped(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handle(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(wrapped), follow_redirects=True)


# ── who cites it, and what is related ──


def test_who_cites_asks_for_the_works_that_cite_it_and_says_how_many(tmp_path):
    seen = []

    def handle(request):
        if request.url.path == "/works":
            return httpx.Response(200, json={"meta": {"count": 57}, "results": [work(2), work(3)]})
        return httpx.Response(404)

    s = S.Scholar(tmp_path / "l.json", tmp_path / "P", client=client(handle, seen))
    works, total = run(s.citing("https://openalex.org/W123", sort="newest", since=2020, limit=2))
    assert total == 57 and [S.short_id(w) for w in works] == ["W2", "W3"]
    params = seen[-1].url.params
    assert params["filter"] == "cites:W123,from_publication_date:2020-01-01"
    assert params["sort"] == "publication_date:desc" and params["per-page"] == "2"


def test_related_papers_come_from_the_works_related_list(tmp_path):
    seen = []

    def handle(request):
        return httpx.Response(200, json={"results": [work(9)]})

    s = S.Scholar(tmp_path / "l.json", tmp_path / "P", client=client(handle, seen))
    got = run(s.related({"related_works": ["https://openalex.org/W1", "https://openalex.org/W2", "junk"]}))
    assert [S.short_id(w) for w in got] == ["W9"]
    assert seen[-1].url.params["filter"] == "openalex_id:W1|W2"
    assert run(s.related({"related_works": []})) == []


def test_the_scholar_feature_has_the_citation_tools(tmp_path, monkeypatch):
    servers = {}
    hub = SimpleNamespace(
        feature_path=lambda name: tmp_path / name,
        prefs=SimpleNamespace(feature=lambda k: None),
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
    )
    monkeypatch.setattr(feature, "papers_folder", lambda: tmp_path / "Papers")
    feature.install(hub)
    _build, kw = servers["scholar"]
    assert {"who_cites", "related_papers"} <= set(kw["web"]) and "who_cites" in kw["prompt"]
    assert kw["labels"]["related_papers"]


# ── equations in words ──


def math(xml: str):
    return ET.fromstring(f"<mml:math {MML}>{xml}</mml:math>")


def test_mathml_is_said_in_words():
    assert M.formula_words(math("<mml:msup><mml:mi>x</mml:mi><mml:mn>2</mml:mn></mml:msup><mml:mo>+</mml:mo><mml:msub><mml:mi>y</mml:mi><mml:mi>i</mml:mi></mml:msub>")) == "x squared plus y sub i"
    assert M.formula_words(math("<mml:mfrac><mml:mi>a</mml:mi><mml:mi>b</mml:mi></mml:mfrac>")) == "a over b"
    assert M.formula_words(math("<mml:mfrac><mml:mrow><mml:mi>a</mml:mi><mml:mo>+</mml:mo><mml:mn>1</mml:mn></mml:mrow><mml:mi>b</mml:mi></mml:mfrac>")) == "the fraction a plus 1 over b, end fraction"
    assert M.formula_words(math("<mml:msqrt><mml:mi>π</mml:mi></mml:msqrt><mml:mo>≈</mml:mo><mml:mn>1.77</mml:mn>")) == "the square root of pi is approximately 1.77"
    assert M.formula_words(math("<mml:mroot><mml:mi>x</mml:mi><mml:mn>3</mml:mn></mml:mroot>")) == "the cube root of x"
    sum_ = "<mml:munderover><mml:mo>∑</mml:mo><mml:mrow><mml:mi>i</mml:mi><mml:mo>=</mml:mo><mml:mn>1</mml:mn></mml:mrow><mml:mi>n</mml:mi></mml:munderover><mml:msub><mml:mi>x</mml:mi><mml:mi>i</mml:mi></mml:msub>"
    assert M.formula_words(math(sum_)) == "the sum from i equals 1 to n of x sub i"
    power = "<mml:msup><mml:mi>e</mml:mi><mml:mrow><mml:mo>−</mml:mo><mml:mi>λ</mml:mi><mml:mi>t</mml:mi></mml:mrow></mml:msup>"
    assert M.formula_words(math(power)) == "e to the power minus lambda t, end power"
    assert M.formula_words(math("<mml:mi>p</mml:mi><mml:mo>&lt;</mml:mo><mml:mn>0.05</mml:mn>")) == "p is less than 0.05"


def test_tex_is_said_in_words_when_there_is_no_mathml():
    assert M.tex_words(r"\documentclass{article}\begin{document}$$\frac{\alpha}{2}$$\end{document}") == "alpha over 2"
    assert M.tex_words(r"\sum_{i=1}^{n} x_i^2") == "the sum from i equals 1 to n of x sub i squared"
    assert M.tex_words(r"\sqrt{x+1} \leq \beta") == "the square root of x plus 1, end root is less than or equal to beta"
    assert M.tex_words(r"\mathrm{CO}_2") == "CO sub 2"
    assert M.tex_words(r"\hat{\theta}") == "theta hat"


def test_a_formula_without_math_falls_back_to_its_alt_text():
    node = ET.fromstring("<inline-formula><inline-graphic><alt-text>p less than 0.05</alt-text></inline-graphic></inline-formula>")
    assert M.formula_words(node) == "p less than 0.05"
    node = ET.fromstring(f"<inline-formula><mml:math {MML} alttext='E = mc^2'></mml:math></inline-formula>")
    assert M.formula_words(node) == "E = mc^2"


def test_full_texts_say_their_equations():
    xml = f"""<article {MML}><body><sec><title>Methods</title>
<p>We fit <inline-formula><mml:math><mml:msup><mml:mi>r</mml:mi><mml:mn>2</mml:mn></mml:msup></mml:math></inline-formula>, then.</p>
<disp-formula id="e1"><label>(3)</label><mml:math><mml:mi>y</mml:mi><mml:mo>=</mml:mo><mml:mi>β</mml:mi><mml:mi>x</mml:mi></mml:math></disp-formula>
<p>And <inline-formula><alternatives><tex-math>$\\frac{{1}}{{n}}$</tex-math></alternatives></inline-formula> is small.</p>
</sec></body></article>"""
    text = S.jats_text(xml)
    assert "We fit r squared, then." in text
    assert "Equation 3: y equals beta x." in text
    assert "And 1 over n is small." in text


# ── paper alerts ──


class Clock:
    def __init__(self) -> None:
        self.now = 1_790_000_000.0

    def __call__(self) -> float:
        return self.now


def alerts_with(tmp_path, results: dict, seen=None):
    def handle(request):
        path = request.url.path
        if path == "/authors":
            return httpx.Response(200, json={"results": [{"id": "https://openalex.org/A77", "display_name": "Ann Lee", "works_count": 120, "last_known_institutions": [{"display_name": "MIT"}]}]})
        if path.startswith("/works/"):
            return httpx.Response(200, json=work(123, "Sleep and memory"))
        flt = request.url.params.get("filter", "")
        for key, works in results.items():
            if key in flt:
                return httpx.Response(200, json={"results": list(works)})
        return httpx.Response(200, json={"results": []})

    s = S.Scholar(tmp_path / "l.json", tmp_path / "P", client=client(handle, seen))
    clock = Clock()
    return PaperAlerts(tmp_path / "alerts.json", s, clock=clock), clock


def test_following_takes_what_is_there_as_seen_and_tells_only_of_new_papers(tmp_path):
    results = {"title_and_abstract.search": [work(1)], "authorships.author.id:A77": [work(5)], "cites:W123": []}
    alerts, clock = alerts_with(tmp_path, results)
    entry, said = run(alerts.follow("topic", "sleep, memory"))
    assert entry["seen"] == ["W1"] and "Following the topic sleep, memory" in said
    entry, said = run(alerts.follow("author", "Ann Lee"))
    assert entry["author"] == "A77" and "Ann Lee at MIT, 120 works" in said
    entry, said = run(alerts.follow("citations", "10.1000/abc"))
    assert entry["work"] == "W123" and "papers citing Sleep and memory" in said
    _again, said = run(alerts.follow("topic", "sleep, memory"))
    assert said.startswith("You already follow") and len(alerts.follows()) == 3

    assert alerts.due()
    assert run(alerts.check()) == []  # nothing new yet
    assert not alerts.due()
    clock.now += CHECK_EVERY
    results["title_and_abstract.search"] = [work(2, "New sleep"), work(1)]
    results["cites:W123"] = [work(3), work(4)]
    new = run(alerts.check())
    assert sorted(S.short_id(w) for _f, w in new) == ["W2", "W3", "W4"]
    assert PaperAlerts.heads_up(new).startswith("3 new papers for what you follow: 2 citing Sleep and memory, 1 on sleep, memory.")
    assert run(alerts.check()) == []  # each told once
    news = alerts.news(7)
    assert len(news) == 3 and all("display_name" in w for _f, w in news)
    clock.now += 8 * 86400
    assert alerts.news(7) == []


def test_a_check_looks_only_at_recent_papers_and_unfollowing_clears_their_news(tmp_path):
    seen = []
    alerts, clock = alerts_with(tmp_path, {"title_and_abstract.search": []}, seen)
    run(alerts.follow("topic", "glia"))
    flt = seen[-1].url.params["filter"]
    assert "from_publication_date:" in flt and "title_and_abstract.search:glia" in flt
    assert seen[-1].url.params["sort"] == "publication_date:desc"
    assert alerts.unfollow("GLIA")["label"] == "glia"
    assert alerts.follows() == [] and alerts.unfollow("glia") is None and not alerts.due()


def test_a_broken_alerts_file_is_no_follows(tmp_path):
    alerts, _ = alerts_with(tmp_path, {})
    (tmp_path / "alerts.json").write_text("[nope")
    assert alerts.follows() == [] and alerts.news() == []


# ── the reference checker ──

PAPER_TEXT = """Introduction
Sleep matters (Lee, 2011).

References

Lee, A., & Chen, B. (2011). Sleep and memory consolidation. Nature Reviews, 12, 1-10. https://doi.org/10.1000/real.1

Smith, J. (2015). A paper whose year is wrong. Journal of Things, 3, 4-5. doi:10.1000/year.2

Nobody, Q. (2019). An invented study of imaginary results. Fake Journal, 1, 1.

Garcia, M. (2020). Without a DOI but indexed. Science, 5, 6-7.
"""


def crossref(request):
    path = request.url.path
    if path == "/works/10.1000/real.1":
        item = {"title": ["Sleep and memory consolidation"], "author": [{"family": "Lee", "sequence": "first"}], "issued": {"date-parts": [[2011]]}, "DOI": "10.1000/real.1"}
        return httpx.Response(200, json={"message": item})
    if path == "/works/10.1000/year.2":
        item = {"title": ["A paper whose year is wrong"], "author": [{"family": "Smith", "sequence": "first"}], "published-print": {"date-parts": [[2018]]}, "DOI": "10.1000/year.2"}
        return httpx.Response(200, json={"message": item})
    if path == "/works" and request.url.host == "api.crossref.org":
        q = request.url.params.get("query.bibliographic", "")
        if "Garcia" in q:
            item = {"title": ["Without a DOI but indexed"], "author": [{"family": "Garcia", "sequence": "first"}], "issued": {"date-parts": [[2020]]}, "DOI": "10.1000/g.3"}
            return httpx.Response(200, json={"message": {"items": [item]}})
        item = {"title": ["Something else entirely about cats"], "author": [{"family": "Cat"}], "issued": {"date-parts": [[2001]]}}
        return httpx.Response(200, json={"message": {"items": [item]}})
    if request.url.host == "api.openalex.org":
        return httpx.Response(200, json={"results": []}) if path == "/works" else httpx.Response(404)
    return httpx.Response(404)


def test_references_are_found_in_a_document_and_split():
    refs = R.split_references(PAPER_TEXT)
    assert len(refs) == 4 and refs[0].startswith("Lee, A.") and "Sleep matters" not in " ".join(refs)
    numbered = R.split_references("[1] A. Lee, “Sleep,” Nature, 2011.\n[2] B. Chen, “Memory and\nsleep,” Science, 2012.")
    assert numbered == ["A. Lee, “Sleep,” Nature, 2011.", "B. Chen, “Memory and sleep,” Science, 2012."]
    wrapped = R.split_references("Lee, A. (2011). Sleep and\nmemory. Nature.\nChen, B. (2012). Memory and sleep. Science.")
    assert wrapped == ["Lee, A. (2011). Sleep and memory. Nature.", "Chen, B. (2012). Memory and sleep. Science."]
    assert R.first_author("A. B. Smith, “Title,” 2010") == "Smith" and R.first_author("Smith AB, Jones C. Title. 2010") == "Smith"
    assert R.year_of("Lee, A. (2011). Pages 1999-2003.") == 2011


def test_each_reference_is_checked_and_nothing_is_invented():
    checks = run(R.ReferenceChecker(client(crossref)).check(R.split_references(PAPER_TEXT)))
    assert [c.status for c in checks] == ["match", "differs", "not found", "match"]
    assert checks[1].differences == ["the year differs: the reference says 2015, the record says 2018"]
    assert checks[3].record["doi"] == "10.1000/g.3"
    said = R.report(checks)
    assert said.startswith("Checked 4 references: 2 found and matching, 1 found but different, 1 not found.")
    assert "Reference 2" in said and "Reference 3, Nobody, Q. (2019)" in said and "check these by hand" in said


def test_an_unregistered_doi_is_reported_never_filled_in():
    def handle(request):
        if request.url.host == "api.crossref.org" and request.url.path == "/works":
            return httpx.Response(200, json={"message": {"items": []}})
        if request.url.host == "api.openalex.org" and request.url.path == "/works":
            return httpx.Response(200, json={"results": []})
        return httpx.Response(404)

    check = run(R.ReferenceChecker(client(handle)).check_one(1, "Lee, A. (2011). Made up. J. 10.9999/nope.1"))
    assert check.status == "not found" and check.note == "its DOI 10.9999/nope.1 is not registered"
    assert check.record == {}


def test_a_title_that_does_not_match_its_doi_is_said():
    def handle(request):
        item = {"title": ["Completely different research topic"], "author": [{"family": "Lee", "sequence": "first"}], "issued": {"date-parts": [[2011]]}}
        return httpx.Response(200, json={"message": item})

    check = run(R.ReferenceChecker(client(handle)).check_one(1, "Lee, A. (2011). Sleep and memory in young adults. Nature. 10.1000/x.1"))
    assert check.status == "differs" and check.differences[0].startswith("the title differs: the record's title is “Completely different")


# ── Zotero ──

ITEMS = [
    {"key": "AAA", "data": {"key": "AAA", "itemType": "journalArticle", "title": "Sleep and memory", "DOI": "10.1000/ABC.1", "date": "2011-03", "publicationTitle": "Nature", "creators": [{"creatorType": "author", "firstName": "Ann", "lastName": "Lee"}]}},
    {"key": "BBB", "data": {"key": "BBB", "itemType": "book", "title": "Dreams", "date": "May 1999", "publisher": "Penguin", "extra": "DOI: 10.2000/d.2", "creators": [{"creatorType": "author", "name": "WHO"}]}},
    {"key": "CCC", "data": {"key": "CCC", "itemType": "note", "note": "hi"}},
]


def zotero_server(seen):
    def handle(request):
        seen.append(request)
        if request.headers.get("Zotero-API-Key") != "abcdefghijklmnopqrstuvwx":
            return httpx.Response(403)
        if request.url.path == "/keys/current":
            return httpx.Response(200, json={"userID": 4242, "username": "prof", "access": {"user": {"library": True, "write": True}}})
        if request.url.path == "/users/4242/items/top":
            return httpx.Response(200, json=ITEMS, headers={"Total-Results": "3"})
        if request.url.path == "/users/4242/items" and request.method == "POST":
            sent = json.loads(request.content)
            return httpx.Response(200, json={"success": {str(i): f"NEW{i}" for i in range(len(sent))}, "failed": {}})
        return httpx.Response(404)

    return client(handle)


def test_zotero_items_come_into_the_library_and_saved_papers_go_out(tmp_path):
    seen = []
    z = Z.Zotero(zotero_server(seen), Z.MemoryVault())
    assert not z.connected()
    account = run(z.probe("abcdefghijklmnopqrstuvwx"))
    assert account["user_id"] == "4242" and z.keep(account) == "Connected to Zotero as prof." and z.connected()

    s = S.Scholar(tmp_path / "lib.json", tmp_path / "P")
    s._write_library([{"id": "W1", "doi": "10.1000/abc.1", "title": "Sleep and memory", "authors": "Ann Lee", "year": 2011}])
    entries = [e for e in (Z.entry_from_item(i) for i in run(z.items())) if e]
    assert [e["title"] for e in entries] == ["Sleep and memory", "Dreams"]
    assert entries[1]["doi"] == "10.2000/d.2" and entries[1]["year"] == 1999 and entries[1]["venue"] == "Penguin"
    assert s.add_entries(entries) == (1, 1)
    lib = s.library()
    assert len(lib) == 2 and lib[0]["id"] == "W1" and lib[0]["zotero"] == "AAA"

    s.save(work(7, "A new one"))
    out = [i for i in s.library() if not i.get("zotero")]
    added = run(z.add(out))
    assert added == {0: "NEW0"}
    posted = json.loads(seen[-1].content)[0]
    assert posted["title"] == "A new one" and posted["DOI"] == "10.1000/p7"
    assert posted["creators"] == [{"creatorType": "author", "firstName": "Ann", "lastName": "Lee"}]
    assert seen[-1].headers["Zotero-API-Version"] == "3" and len(seen[-1].headers["Zotero-Write-Token"]) == 32
    z.forget()
    assert not z.connected()


def test_a_bad_zotero_key_is_never_kept(tmp_path):
    z = Z.Zotero(zotero_server([]), Z.MemoryVault())
    for bad in ("short", "zzzzzzzzzzzzzzzzzzzzzzzz"):
        try:
            run(z.probe(bad))
        except Z.ZoteroError:
            pass
        else:
            raise AssertionError("accepted a bad key")
    assert not z.connected()
    try:
        run(z.items())
    except Z.ZoteroError as exc:
        assert "isn't connected" in str(exc)


# ── the feature ──


def extras_hub(tmp_path, monkeypatch, answer=True):
    servers, loops, notes = {}, [], []

    async def confirm(question):
        notes.append(question)
        return answer

    hub = SimpleNamespace(
        feature_path=lambda name: tmp_path / name,
        prefs=SimpleNamespace(feature=lambda k: None),
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        register_loop=lambda name, factory: loops.append(name),
        notify=lambda alert: notes.append(alert),
        confirm=confirm,
    )
    monkeypatch.setattr(feature, "papers_folder", lambda: tmp_path / "Papers")
    feature.install(hub)
    extras_feature.install(hub)
    return hub, servers, loops, notes


def test_the_extras_feature_registers_its_tools_and_its_daily_loop(tmp_path, monkeypatch):
    hub, servers, loops, _ = extras_hub(tmp_path, monkeypatch)
    build, kw = servers["scholar_extras"]
    assert loops == ["paper_alerts"]
    assert "check_references" in kw["web"] and "follow_papers" in kw["prompt"]
    assert "Never correct a reference" in kw["prompt"]
    assert build()["name"] == "scholar_extras"


def test_new_papers_are_told_through_a_heads_up(tmp_path, monkeypatch):
    hub, _servers, _loops, notes = extras_hub(tmp_path, monkeypatch)
    x = hub.scholar_extras
    alerts, clock = alerts_with(tmp_path, {"title_and_abstract.search": [work(1)]})
    x.alerts = alerts
    run(alerts.follow("topic", "glia"))
    assert run(x.check_and_tell()) == 0 and notes == []
    clock.now += CHECK_EVERY
    alerts.scholar._client = client(lambda r: httpx.Response(200, json={"results": [work(2), work(1)]}))
    assert run(x.check_and_tell()) == 1
    alert = notes[-1]
    assert alert.kind == "papers" and alert.text.startswith("1 new paper for what you follow: 1 on glia.")
    assert "Paper 2" not in alert.note


def test_a_document_without_a_reference_list_is_said_so(tmp_path, monkeypatch):
    from jarvis import computer

    doc = tmp_path / "notes.txt"
    doc.write_text("Just some notes, 2020, with no references.")
    monkeypatch.setattr(computer, "safe_path", lambda raw: Path(raw))
    text, why = extras_feature._read(str(doc))
    assert why == "" and "notes" in text
    assert not R.HEADING.search(text)
    _text, why = extras_feature._read(str(tmp_path / "missing.txt"))
    assert why == "There's no such file."


def test_when_no_index_answers_a_reference_is_unchecked_not_missing():
    check = run(R.ReferenceChecker(client(lambda r: httpx.Response(503))).check_one(1, "Lee, A. (2011). Sleep and memory. Nature."))
    assert check.status == "unchecked"
    assert "1 couldn't be checked." in R.report([check]) and "Not found" not in R.report([check])
