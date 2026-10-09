"""A Word document (.docx) from Markdown, with nothing but the standard library: on a PC there is
no textutil to make one, and a screen reader user moves through a Word file by its headings.

What it keeps of Markdown: headings (#, ##, ###) as Word's own Heading 1-3 styles (so NVDA's and
JAWS's heading keys and Word's navigation pane find them), paragraphs, bullet and numbered items
(as indented paragraphs that start with a bullet or their number, which every reader says),
checkboxes, **bold** and *italic*. A table's rows become lines with their cells joined by " | ".
The document's title is kept in its properties (Word's accessibility check asks for one), and
its language is English.
"""

from __future__ import annotations

import re
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from xml.sax.saxutils import escape

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

PACKAGE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _style(
    style_id: str, name: str, size: int, bold: bool, level: int | None, indent: int = 0
) -> str:
    outline = f'<w:outlineLvl w:val="{level}"/>' if level is not None else ""
    spacing = '<w:spacing w:before="240" w:after="120"/>' if level is not None else ""
    ind = f'<w:ind w:left="{indent}" w:hanging="360"/>' if indent else ""
    keep = "<w:keepNext/>" if level is not None else ""
    return (
        f'<w:style w:type="paragraph" w:styleId="{style_id}"><w:name w:val="{name}"/>'
        '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        f"<w:pPr>{keep}{spacing}{ind}{outline}</w:pPr>"
        f'<w:rPr>{"<w:b/>" if bold else ""}<w:sz w:val="{size}"/></w:rPr></w:style>'
    )


STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:styles xmlns:w="{W_NS}">'
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" '
    'w:cs="Calibri"/><w:sz w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>'
    "</w:pPrDefault></w:docDefaults>"
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
    "<w:qFormat/></w:style>"
    + _style("Title", "Title", 40, True, None)
    + _style("Heading1", "heading 1", 34, True, 0)
    + _style("Heading2", "heading 2", 30, True, 1)
    + _style("Heading3", "heading 3", 26, True, 2)
    + _style("ListParagraph", "List Paragraph", 24, False, None, indent=720)
    + "</w:styles>"
)

INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)")  # (never _x_: snake_case stays)


def _runs(text: str) -> str:
    """A line's runs: **bold**, *italic* and `code` kept as such, the rest plain."""
    out = []
    for piece in INLINE.split(text):
        if not piece:
            continue
        props = ""
        if piece.startswith("**") and piece.endswith("**") and len(piece) > 4:
            piece, props = piece[2:-2], "<w:b/>"
        elif len(piece) > 2 and piece[0] == piece[-1] == "*":
            piece, props = piece[1:-1], "<w:i/>"
        elif len(piece) > 2 and piece[0] == piece[-1] == "`":
            piece, props = piece[1:-1], '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
        rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
        out.append(f'<w:r>{rpr}<w:t xml:space="preserve">{escape(piece)}</w:t></w:r>')
    return "".join(out)


def _paragraph(text: str, style: str = "") -> str:
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{ppr}{_runs(text)}</w:p>"


def paragraphs(markdown: str, title: str = "") -> list[str]:
    """The document's paragraphs (w:p) from Markdown, the title first when there is one."""
    out = [_paragraph(title, "Title")] if title else []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            out.append(_paragraph(" ".join(pending)))
            pending.clear()

    for raw in markdown.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if m := re.match(r"^(#{1,6})\s+(.*)$", stripped):
            flush()
            level = min(3, len(m.group(1)))
            words = m.group(2).strip().strip("#").strip()
            if not (level == 1 and title and words == title):  # (the title is there already)
                out.append(_paragraph(words, f"Heading{level}"))
            continue
        if re.fullmatch(r"\|?[\s:|-]+\|?", stripped) and "-" in stripped:
            continue  # a table's dashes under its header
        if stripped.startswith("|") and stripped.endswith("|"):
            flush()
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            out.append(_paragraph(" | ".join(cells)))
            continue
        if m := re.match(r"^[-*+]\s+\[([ xX])\]\s+(.*)$", stripped):
            flush()
            box = "☒" if m.group(1).strip() else "☐"
            out.append(_paragraph(f"{box} {m.group(2)}", "ListParagraph"))
            continue
        if m := re.match(r"^[-*+]\s+(.*)$", stripped):
            flush()
            out.append(_paragraph(f"• {m.group(1)}", "ListParagraph"))
            continue
        if m := re.match(r"^(\d+)[.)]\s+(.*)$", stripped):
            flush()
            out.append(_paragraph(f"{m.group(1)}. {m.group(2)}", "ListParagraph"))
            continue
        if stripped.startswith(">"):
            flush()
            out.append(_paragraph(stripped.lstrip("> ").strip(), "ListParagraph"))
            continue
        pending.append(stripped)
    flush()
    return out


def write_docx(path: Path, markdown: str, title: str = "", now: datetime | None = None) -> Path:
    """Write the Markdown as a .docx at path (over whatever is there: the caller claims the name)."""
    body = "".join(paragraphs(markdown, title)) or "<w:p/>"
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W_NS}"><w:body>{body}'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" '
        'w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")
    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f"<dc:title>{escape(title)}</dc:title><dc:language>en-US</dc:language>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{stamp}</dcterms:created>'
        "</cp:coreProperties>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES)
        zf.writestr("_rels/.rels", PACKAGE_RELS)
        zf.writestr("word/_rels/document.xml.rels", DOCUMENT_RELS)
        zf.writestr("word/document.xml", document)
        zf.writestr("word/styles.xml", STYLES)
        zf.writestr("docProps/core.xml", core)
    return path
