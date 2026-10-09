"""Word, OpenDocument and RTF text without macOS's textutil (rich_text.py): what a PC reads, a table
as rows, lists as lines, nothing from a hostile file."""

from __future__ import annotations

import zipfile
from pathlib import Path

from jarvis import documents, knowledge, osplat, rich_text

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(path: Path, body: str) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr(
            "word/document.xml",
            f'<?xml version="1.0"?><w:document {W}><w:body>{body}</w:body></w:document>',
        )
    return path


def para(*runs: str) -> str:
    return "<w:p>" + "".join(f"<w:r><w:t>{r}</w:t></w:r>" for r in runs) + "</w:p>"


def test_a_word_file_is_its_paragraphs_in_order(tmp_path):
    body = (
        para("Strategy and governance")
        + para("Boards in ", "emerging markets", " differ.")
        + "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>c</w:t></w:r></w:p>"
    )
    text = rich_text.text_of(make_docx(tmp_path / "paper.docx", body))
    assert text == "Strategy and governance\nBoards in emerging markets differ.\na\tb\nc"


def test_a_table_is_a_row_per_line_with_its_cells_side_by_side(tmp_path):
    table = (
        "<w:tbl><w:tr><w:tc>" + para("Year") + "</w:tc><w:tc>" + para("Boards") + "</w:tc></w:tr>"
        "<w:tr><w:tc>" + para("2024") + "</w:tc><w:tc>" + para("118") + "</w:tc></w:tr></w:tbl>"
    )
    text = rich_text.text_of(make_docx(tmp_path / "t.docx", para("Before") + table + para("After")))
    assert text.splitlines() == ["Before", "Year\tBoards", "2024\t118", "After"]


def test_an_opendocument_file_reads_too(tmp_path):
    ns = (
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
    )
    content = (
        f'<?xml version="1.0"?><office:document-content {ns}><office:body><office:text>'
        '<text:h>Title</text:h><text:p>One <text:span>bold</text:span> word<text:tab/>and<text:s text:c="2"/>more</text:p>'
        "</office:text></office:body></office:document-content>"
    )
    path = tmp_path / "n.odt"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("content.xml", content)
    assert rich_text.text_of(path) == "Title\nOne bold word\tand  more"


def test_rtf_loses_its_formatting_and_keeps_the_words_and_accents(tmp_path):
    rtf = (
        r"{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}{\colortbl;\red0\green0\blue0;}"
        r"\pard Caf\'e9 society\par {\b Second} line \u8212? done.\par {\*\generator Word;}}"
    )
    path = tmp_path / "x.rtf"
    path.write_bytes(rtf.encode("latin-1"))
    assert rich_text.text_of(path) == "Café society\nSecond line — done."


def test_a_hostile_or_broken_file_gives_nothing_not_a_crash(tmp_path):
    bad_zip = tmp_path / "a.docx"
    bad_zip.write_bytes(b"not a zip")
    assert rich_text.text_of(bad_zip) == ""
    entity = make_docx(tmp_path / "b.docx", para("x"))
    with zipfile.ZipFile(entity, "w") as zf:
        zf.writestr(
            "word/document.xml",
            f'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaa">]><w:document {W}><w:body>{para("&a;")}</w:body></w:document>',
        )
    assert rich_text.text_of(entity) == ""
    assert rich_text.text_of(tmp_path / "missing.docx") == ""
    assert rich_text.text_of(tmp_path / "old.doc") == ""


def test_a_pc_reads_word_files_in_the_second_brain_and_in_documents(tmp_path, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)  # (no textutil to call)
    path = make_docx(tmp_path / "plan.docx", para("Reading list") + para("Farah 2021"))
    assert knowledge.read_document(path) == "Reading list\nFarah 2021"
    assert documents.textutil_text(path) == "Reading list\nFarah 2021"
    html = tmp_path / "p.html"
    html.write_text("<p>Hello <b>there</b></p>")
    assert "Hello" in documents.textutil_text(html) and "<" not in documents.textutil_text(html)
