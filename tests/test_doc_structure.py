"""Documents read by their structure (doc_structure.py, features/doc_outline.py): a table of
contents from a PDF's bookmarks or its type, from Word's heading styles, from Markdown and plain
text; a named section read in parts; the captions listed apart. Real files made here."""

from __future__ import annotations

import asyncio
import io
import zipfile
from pathlib import Path

import pytest
from styled_pdf import BODY, PAPER, styled_pdf
from test_browser_pdf import tiny_pdf

from jarvis import doc_structure
from jarvis.features import doc_outline


@pytest.fixture(autouse=True)
def fresh_cache():
    doc_structure._CACHE.clear()


def test_a_pdfs_headings_are_guessed_from_the_size_and_weight_of_its_type(tmp_path):
    path = tmp_path / "paper.pdf"
    path.write_bytes(styled_pdf(PAPER))
    doc = doc_structure.structure(path)
    assert doc.source == "type sizes"
    assert [(h.level, h.title, h.page) for h in doc.headings] == [
        (1, "A Study of Things", 1),
        (2, "1 Introduction", 1),
        (2, "2 Methods", 2),
        (3, "Sampling", 2),  # bold at the body's size: a lower heading
        (2, "3 Results", 3),
    ]
    toc = doc_structure.table_of_contents(doc).splitlines()
    assert toc[0].startswith("paper.pdf: 5 headings guessed from the size and weight of its type")
    assert toc[3] == "  3. 2 Methods, page 2, 39 words"
    assert toc[-1] == "It has 1 figure and 1 table captions: list_captions reads them."


def test_skip_to_a_section_by_its_usual_name_or_number(tmp_path):
    path = tmp_path / "paper.pdf"
    path.write_bytes(styled_pdf(PAPER))
    doc = doc_structure.structure(path)
    said = doc_structure.read_section(doc, "the methods section")
    assert said.startswith("2 Methods (page 2):\n<document_section>\n2 Methods")
    assert "Sampling" in said and "The results were good" not in said
    assert said.endswith("(End of this section. Next is 3 Results.)")
    assert doc_structure.read_section(doc, "findings").startswith("3 Results")
    assert doc_structure.read_section(doc, "section 3").startswith("3 Results")
    assert doc_structure.read_section(doc, "2").startswith("2 Methods")  # its own numbering
    assert "and of the document" in doc_structure.read_section(doc, "results")
    with pytest.raises(ValueError, match="The headings are: A Study of Things"):
        doc_structure.read_section(doc, "acknowledgements")


def test_captions_are_listed_apart_with_their_pages(tmp_path):
    path = tmp_path / "paper.pdf"
    path.write_bytes(styled_pdf(PAPER))
    doc = doc_structure.structure(path)
    assert doc_structure.captions_said(doc).splitlines() == [
        "2 captions in paper.pdf:",
        "Figure 1 (page 1): Growth of things over time",
        "Table 1 (page 2): Sample sizes",
    ]
    assert "Figure 1" not in doc_structure.captions_said(doc, "tables")


def test_a_pdfs_bookmarks_come_first(tmp_path):
    from pypdf import PdfReader, PdfWriter

    plain = styled_pdf(
        [[("F1", 11, "Opening words. " + BODY)], [("F1", 11, "Middle part. " + BODY)]]
    )
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(plain)).pages:
        writer.add_page(page)
    top = writer.add_outline_item("Chapter One", 0)
    writer.add_outline_item("Middle part", 1, parent=top)
    path = tmp_path / "book.pdf"
    with path.open("wb") as fh:
        writer.write(fh)
    doc = doc_structure.structure(path)
    assert doc.source == "bookmarks"
    assert [(h.level, h.title, h.page) for h in doc.headings] == [
        (1, "Chapter One", 1),
        (2, "Middle part", 2),
    ]
    assert doc.text[doc.headings[1].start :].startswith("Middle part.")


def test_a_scanned_pdf_says_it_has_no_headings(tmp_path):
    path = tmp_path / "scan.pdf"
    path.write_bytes(tiny_pdf([None, None]))
    doc = doc_structure.structure(path)
    assert doc.scanned and "scanned pages" in doc_structure.table_of_contents(doc)


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def para(text: str, style: str = "") -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>"


def make_docx(path: Path) -> Path:
    body = "".join(
        [
            para("Grant Proposal", "Title"),
            para("Aims", "Heading1"),
            para("We aim to do good work."),
            para("Background", "Heading2"),
            para("Much has been done."),
            para("Table 2: Budget by year", "Caption"),
            para("Plan", "Kop1"),  # a Dutch Word's own name for Heading 1
            para("First we plan."),
        ]
    )
    styles = (
        f"<w:styles {W}>"
        '<w:style w:styleId="Kop1"><w:name w:val="heading 1"/></w:style>'
        '<w:style w:styleId="Caption"><w:name w:val="caption"/></w:style>'
        "</w:styles>"
    )
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("word/document.xml", f"<w:document {W}><w:body>{body}</w:body></w:document>")
        zf.writestr("word/styles.xml", styles)
    return path


def test_word_headings_come_from_their_styles(tmp_path):
    doc = doc_structure.structure(make_docx(tmp_path / "grant.docx"))
    assert doc.source == "styles"
    assert [(h.level, h.title) for h in doc.headings] == [
        (1, "Grant Proposal"),
        (2, "Aims"),
        (3, "Background"),
        (2, "Plan"),
    ]
    said = doc_structure.read_section(doc, "aims")
    assert "Much has been done" in said and "First we plan" not in said
    assert "Table 2: Budget by year" in doc_structure.captions_said(doc)


REPORT = (
    """# Heat pumps in cold climates

## Summary
They work.

## Findings
### Efficiency
"""
    + ("Efficiency stays high. " * 400)
    + """

### Costs
Costs are falling.

```
# not a heading inside code
```

## Sources
1. A paper.
"""
)


def test_a_research_report_is_found_by_name_and_read_in_parts(tmp_path, monkeypatch):
    research = tmp_path / "Documents" / "Jarvis" / "Research"
    research.mkdir(parents=True)
    (research / "heat-pumps-2026-10-01.md").write_text(REPORT, encoding="utf-8")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(doc_structure, "RESEARCH_DIR", research)
    monkeypatch.setattr(doc_structure, "PAPERS_DIR", tmp_path / "Documents" / "Jarvis" / "Papers")
    path = doc_structure.locate("heat pumps")
    doc = doc_structure.structure(path)
    assert [h.title for h in doc.headings] == [
        "Heat pumps in cold climates", "Summary", "Findings", "Efficiency", "Costs", "Sources",
    ]  # fmt: skip
    first = doc_structure.read_section(doc, "results")  # "results" finds Findings
    assert first.startswith("Findings, part 1 of 2:")
    assert first.endswith("(More of this section follows: ask read_section for part 2.)")
    last = doc_structure.read_section(doc, "findings", part=2)
    assert "Costs are falling" in last and last.endswith("Next is Sources.)")
    with pytest.raises(ValueError, match="couldn't find"):
        doc_structure.locate("budget spreadsheet")


PLAIN = """THE EFFECT OF SLEEP ON MEMORY

Abstract

Sleep helps.

1. Introduction

People sleep. This line is a sentence in a paragraph
and it goes on to a second line that is not a heading.

2. Methods

2.1 Participants

Forty students took part.

Results

Memory improved.

Figure 3: Recall by night
"""


def test_plain_text_headings_are_numbered_capitalised_or_usual_section_names(tmp_path):
    path = tmp_path / "sleep.txt"
    path.write_text(PLAIN, encoding="utf-8")
    doc = doc_structure.structure(path)
    assert [(h.level, h.title) for h in doc.headings] == [
        (1, "THE EFFECT OF SLEEP ON MEMORY"),
        (1, "Abstract"),
        (1, "1. Introduction"),
        (1, "2. Methods"),
        (2, "2.1 Participants"),
        (1, "Results"),
    ]
    assert "Forty students" in doc_structure.read_section(doc, "methods")
    assert doc_structure.read_section(doc, "2.1").startswith("2.1 Participants")
    assert "Figure 3 (page 0)" not in doc_structure.captions_said(doc)
    assert "Figure 3: Recall by night" in doc_structure.captions_said(doc)


def test_parts_are_cut_at_paragraphs():
    text = "\n\n".join(["word " * 300] * 6)
    parts = doc_structure.section_parts(text, size=4000)
    assert len(parts) == 3 and all(len(p) <= 4000 for p in parts)
    assert "".join(parts).replace(" ", "").replace("\n", "") == text.replace(" ", "").replace(
        "\n", ""
    )


def test_the_tools_read_the_outline_a_section_and_the_captions(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    path = tmp_path / "paper.pdf"
    path.write_bytes(styled_pdf(PAPER))
    tools = {t.name: t for t in doc_outline.build_tools()}
    out = asyncio.run(tools["get_document_outline"].handler({"path": str(path)}))
    assert "5 headings" in out["content"][0]["text"]
    out = asyncio.run(tools["read_section"].handler({"path": str(path), "section": "methods"}))
    assert out["content"][0]["text"].startswith("2 Methods (page 2)")
    out = asyncio.run(tools["list_captions"].handler({"path": str(path), "which": "figures"}))
    assert "Figure 1 (page 1)" in out["content"][0]["text"]
    out = asyncio.run(tools["read_section"].handler({"path": str(path), "section": "budget"}))
    assert out.get("is_error") and "The headings are" in out["content"][0]["text"]
