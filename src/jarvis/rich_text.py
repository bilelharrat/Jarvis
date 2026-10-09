"""The text of Word, OpenDocument and RTF files, with nothing but the standard library.

macOS has textutil for this and Windows has nothing, so on a PC (knowledge.read_document and the
documents feature) this reads .docx, .odt and .rtf itself: paragraphs in order, a table's cells
side by side and its rows on lines of their own, a list item as a line. It is for reading and
for the second brain; it makes no attempt at fonts or layout. A file it can't read gives "".
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_BYTES = 25_000_000  # the biggest file read (as knowledge.read_document)
MAX_PART = 40_000_000  # the biggest the document part may unpack to: a zip bomb stays a bomb unread

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"


def _part(path: Path, name: str) -> bytes:
    with zipfile.ZipFile(path) as zf:
        info = zf.getinfo(name)
        if info.file_size > MAX_PART:
            raise ValueError("too big")
        data = zf.read(info)
    if b"<!ENTITY" in data or b"<!DOCTYPE" in data:  # a word processor writes neither
        raise ValueError("a document that defines entities")
    return data


def _paragraph(p: ET.Element) -> str:
    """One w:p's text: its runs, a tab as a tab, a line break as a line."""
    out: list[str] = []
    for node in p.iter():
        if node.tag == f"{W}t" and node.text:
            out.append(node.text)
        elif node.tag == f"{W}tab":
            out.append("\t")
        elif node.tag in (f"{W}br", f"{W}cr"):
            out.append("\n")
    return "".join(out)


def _block(el: ET.Element, lines: list[str]) -> None:
    for child in el:
        if child.tag == f"{W}p":
            lines.append(_paragraph(child))
        elif child.tag == f"{W}tbl":
            for row in child.iter(f"{W}tr"):
                cells = []
                for cell in row.findall(f"{W}tc"):
                    inner: list[str] = []
                    _block(cell, inner)
                    cells.append(" ".join(t for t in inner if t).strip())
                lines.append("\t".join(cells))
        elif child.tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml", f"{W}ins", f"{W}smartTag"):
            _block(child, lines)


def docx_text(path: Path) -> str:
    root = ET.fromstring(_part(path, "word/document.xml"))
    body = root.find(f"{W}body")
    lines: list[str] = []
    if body is not None:
        _block(body, lines)
    return _tidy("\n".join(lines))


def odt_text(path: Path) -> str:
    root = ET.fromstring(_part(path, "content.xml"))
    lines: list[str] = []

    def spans(el: ET.Element) -> str:
        out = [el.text or ""]
        for child in el:
            if child.tag == f"{TEXT}tab":
                out.append("\t")
            elif child.tag == f"{TEXT}line-break":
                out.append("\n")
            elif child.tag == f"{TEXT}s":
                out.append(" " * int(child.get(f"{TEXT}c", "1") or 1))
            else:
                out.append(spans(child))
            out.append(child.tail or "")
        return "".join(out)

    def walk(el: ET.Element) -> None:
        for child in el:
            if child.tag in (f"{TEXT}p", f"{TEXT}h"):
                lines.append(spans(child))
            elif child.tag == f"{TABLE}table-row":
                cells = [" ".join(spans(p) for p in c.iter(f"{TEXT}p")).strip() for c in child]
                lines.append("\t".join(cells))
            else:
                walk(child)

    walk(root)
    return _tidy("\n".join(lines))


# RTF: groups that hold no text of the page (fonts, colours, styles, document info, pictures).
_RTF_SKIP = {
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "headerl", "headerr",
    "footerl", "footerr", "themedata", "colorschememapping", "latentstyles", "datastore",
    "listtable", "listoverridetable", "rsidtbl", "generator", "private", "xmlnstbl", "object",
}  # fmt: skip
_RTF_TOKEN = re.compile(
    r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\([\\{}~_\-*\n\r])|([{}])|([^\\{}]+)"
)


def rtf_text(data: str) -> str:
    out: list[str] = []
    stack: list[bool] = []  # per group: is its text skipped?
    skipping = False
    star = False  # the next group is a "\*" destination: skipped unless known
    unicode_skip = 1
    pending_skip = 0  # characters after \uN that stand in for it
    for m in _RTF_TOKEN.finditer(data):
        word, num, hexa, symbol, brace, plain = m.groups()
        if brace == "{":
            stack.append(skipping)
            continue
        if brace == "}":
            skipping = stack.pop() if stack else False
            continue
        if symbol:
            if symbol == "*":
                star = True
            elif not skipping:
                out.append(
                    {"~": "\u00a0", "_": "\u2011", "-": ""}.get(
                        symbol, symbol if symbol in "\\{}" else ""
                    )
                )
            continue
        if hexa:
            if not skipping:
                if pending_skip:
                    pending_skip -= 1
                else:
                    out.append(bytes([int(hexa, 16)]).decode("cp1252", "replace"))
            continue
        if word:
            if star:
                skipping, star = True, False
            if word in _RTF_SKIP:
                skipping = True
            elif skipping:
                continue
            elif word in ("par", "line", "sect", "page"):
                out.append("\n")
            elif word == "tab":
                out.append("\t")
            elif word == "cell":
                out.append("\t")
            elif word == "row":
                out.append("\n")
            elif word == "emdash":
                out.append("\u2014")
            elif word == "endash":
                out.append("\u2013")
            elif word in ("lquote", "rquote"):
                out.append("\u2019" if word == "rquote" else "\u2018")
            elif word in ("ldblquote", "rdblquote"):
                out.append("\u201d" if word == "rdblquote" else "\u201c")
            elif word == "bullet":
                out.append("\u2022")
            elif word == "uc" and num:
                unicode_skip = int(num)
            elif word == "u" and num:
                code = int(num)
                out.append(chr(code + 65536 if code < 0 else code))
                pending_skip = unicode_skip
            continue
        if plain and not skipping:
            text = plain.replace("\r", "").replace("\n", "")
            while pending_skip and text:
                text, pending_skip = text[1:], pending_skip - 1
            out.append(text)
    return _tidy("".join(out))


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]+\n", "\n", text.replace("\r", ""))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def text_of(path: Path, limit: int | None = None) -> str:
    """A .docx, .odt or .rtf file's text; "" for anything else or anything that won't read
    (an old binary .doc, a damaged or hostile file)."""
    suffix = path.suffix.lower()
    try:
        if path.stat().st_size > MAX_BYTES:
            return ""
        if suffix == ".docx":
            text = docx_text(path)
        elif suffix == ".odt":
            text = odt_text(path)
        elif suffix == ".rtf":
            text = rtf_text(path.read_bytes().decode("latin-1"))
        else:
            return ""
    except (OSError, zipfile.BadZipFile, KeyError, ValueError, ET.ParseError):
        return ""
    return text[:limit] if limit else text
