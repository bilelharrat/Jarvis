"""Documents read by their structure: a table of contents to listen to, a section read on its
own ("read the methods section", "skip to results"), and the figure and table captions listed
apart. For someone who can't skim a page with their eyes, this is skimming.

Where the headings come from:
- PDF: its bookmarks (the outline pypdf reads) when it has them; otherwise headings guessed from
  how the text is set: lines in a bigger type than the body, or short lines all in bold, that
  don't repeat on every page (running heads). A scanned PDF has no text, so no headings.
- Word (.docx): paragraphs styled as headings (Heading 1-9, Title) or given an outline level.
- Markdown and plain text (the research reports in Documents/Jarvis/Research and the papers in
  Documents/Jarvis/Papers among them): # headings, underlined ones, and in plain text short
  lines that are numbered ("2.1 Data"), in capitals, or the usual names of a paper's sections.

Each heading has a place in the document's text, so a section is the text from its heading to
the next heading at its level or above, read a part at a time.

Claude cost policy: no model call; these are tools of the ordinary conversation, and a section
comes back a few thousand characters at a time, not the whole document.
"""

from __future__ import annotations

import os
import re
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .knowledge import RESEARCH_DIR

PAPERS_DIR = Path.home() / "Documents" / "Jarvis" / "Papers"
SUFFIXES = {".pdf", ".docx", ".md", ".markdown", ".txt", ".text"}
MAX_BYTES = 40_000_000
MAX_PAGES = 400
MAX_TEXT = 3_000_000
PART_CHARS = 5000  # of a section read at once
MAX_HEADINGS = 150  # said in a table of contents
SEARCH_FILES = 4000  # files looked at to find a document by name

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# The usual names of a paper's or report's sections, and other words people use for them.
KNOWN_SECTIONS = {
    "abstract", "summary", "executive summary", "introduction", "background", "literature review",
    "related work", "theory", "theoretical framework", "methods", "method", "methodology",
    "materials and methods", "data", "data and methods", "research design", "experiments",
    "experimental setup", "results", "findings", "analysis", "discussion", "results and discussion",
    "conclusion", "conclusions", "concluding remarks", "limitations", "future work",
    "recommendations", "implications", "acknowledgements", "acknowledgments", "references",
    "bibliography", "works cited", "appendix", "appendices", "notes", "contents", "key findings",
    "sources", "overview",
}  # fmt: skip
SYNONYMS = {
    "methods": ("method", "methodology", "materials and methods", "data and methods",
                "research design", "experimental setup", "experiments"),
    "results": ("findings", "results and discussion", "key findings", "analysis"),
    "conclusion": ("conclusions", "concluding remarks", "summary and conclusion"),
    "introduction": ("intro", "background", "overview"),
    "references": ("bibliography", "works cited", "sources", "literature cited"),
    "abstract": ("summary", "executive summary"),
    "literature review": ("related work", "background"),
    "discussion": ("results and discussion",),
}  # fmt: skip
CAPTION = re.compile(
    r"^\s*(Figure|Fig\.|Table|Chart|Graph|Exhibit|Plate|Scheme|Box|Map)\s+"
    r"(S?\d+[A-Za-z]?(?:\.\d+)?|[IVXLC]+)\b\s*([.:|—–-]?)\s*(.*)$",
    re.IGNORECASE,
)
NUMBERED = re.compile(r"^(?:(?:section|chapter|part)\s+)?(\d+(?:\.\d+){0,3})\.?\s+(\S.*)$", re.I)


@dataclass
class Heading:
    level: int
    title: str
    start: int  # where in the text the section begins
    page: int = 0  # (PDFs) the page it is on, from 1


@dataclass
class Structure:
    path: Path
    text: str
    headings: list[Heading]
    pages: list[int] = field(default_factory=list)  # (PDFs) where each page starts in the text
    source: str = ""  # bookmarks, styles, type sizes, markdown, text
    scanned: bool = False

    def page_at(self, offset: int) -> int:
        page = 0
        for i, start in enumerate(self.pages):
            if start <= offset:
                page = i + 1
            else:
                break
        return page

    def end_of(self, index: int) -> int:
        level = self.headings[index].level
        for later in self.headings[index + 1 :]:
            if later.level <= level and later.start > self.headings[index].start:
                return later.start
        return len(self.text)


# ── finding the document ──


def locate(raw: str, suffixes: set[str] = SUFFIXES, folders: list[Path] | None = None) -> Path:
    """A document by its path, or by words of its name in the research and papers folders,
    Documents, Desktop and Downloads (the newest that has every word). ValueError when none."""
    from .computer import safe_path

    raw = str(raw or "").strip().strip("\"'")
    if not raw:
        raise ValueError("Say which document.")
    looks_like_path = raw.startswith(("~", "/", "\\")) or bool(re.match(r"^[A-Za-z]:[\\/]", raw))
    if looks_like_path or os.sep in raw or "/" in raw:
        path = safe_path(raw)
        if not path.is_file():
            raise ValueError("There's no file there.")
        return path
    home = Path.home()
    folders = folders or [
        RESEARCH_DIR,
        PAPERS_DIR,
        home / "Documents",
        home / "Desktop",
        home / "Downloads",
    ]
    want = [
        w for w in re.findall(r"\w+", raw.casefold()) if w not in {"the", "a", "my", "pdf", "doc"}
    ]
    exact = raw.casefold()
    best: tuple[int, float, Path] | None = None
    looked = 0
    for folder in folders:
        try:
            walker = os.walk(folder)
        except OSError:
            continue
        for depth_root, dirs, files in walker:
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            if (
                Path(depth_root) != Path(folder)
                and len(Path(depth_root).relative_to(folder).parts) > 2
            ):
                dirs[:] = []
            for name in files:
                looked += 1
                if looked > SEARCH_FILES:
                    break
                path = Path(depth_root, name)
                if path.suffix.lower() not in suffixes or name.startswith("."):
                    continue
                stem = path.stem.casefold()
                if name.casefold() == exact or stem == exact:
                    score = 2
                elif want and all(w in stem for w in want):
                    score = 1
                else:
                    continue
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if best is None or (score, mtime) > best[:2]:
                    best = (score, mtime, path)
    if best is None and folders and folders[0] == RESEARCH_DIR:
        from .reports import find_report

        report = find_report(raw)
        if report is not None:
            return report
    if best is None:
        raise ValueError(f"I couldn't find a document called {raw}.")
    return safe_path(str(best[2]))


# ── reading the structure ──

_CACHE: dict[tuple[str, int, int], Structure] = {}


def structure(path: Path) -> Structure:
    """The document's text and headings (kept for the last few documents, as a section is
    read in parts)."""
    path = Path(path)
    info = path.stat()
    if info.st_size > MAX_BYTES:
        raise ValueError("That document is too big for me to read.")
    key = (str(path), info.st_mtime_ns, info.st_size)
    if key in _CACHE:
        return _CACHE[key]
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        found = pdf_structure(path)
    elif suffix == ".docx":
        found = docx_structure(path)
    elif suffix in SUFFIXES:
        with path.open(encoding="utf-8", errors="replace") as fh:
            text = fh.read(MAX_TEXT)
        found = text_structure(path, text, markdown=suffix in (".md", ".markdown"))
    else:
        raise ValueError("I can read the structure of PDF, Word, Markdown and text files.")
    while len(_CACHE) >= 4:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = found
    return found


def _norm(text: str) -> str:
    return " ".join(str(text or "").split())


def _find_in(text: str, title: str, start: int = 0, end: int | None = None) -> int:
    """Where a heading's words are in the text (spacing and case aside); -1 when they aren't."""
    words = re.findall(r"\w+", title)
    if not words:
        return -1
    pattern = r"\W*".join(re.escape(w) for w in words[:12])
    m = re.compile(pattern, re.IGNORECASE).search(text, start, len(text) if end is None else end)
    return m.start() if m else -1


def pdf_structure(path: Path) -> Structure:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = reader.pages[:MAX_PAGES]
    texts: list[str] = []
    lines_by_page: list[list[dict[str, Any]]] = []
    for page in pages:
        lines: list[dict[str, Any]] = []

        def visit(text, cm, tm, font, size, lines=lines):
            if not text:
                return
            scale = abs(tm[3]) if tm[3] else 1.0
            if cm and cm[3]:
                scale *= abs(cm[3])
            real = round(float(size or 0) * scale, 1)
            y = round(
                float(tm[5]) * (abs(cm[3]) if cm and cm[3] else 1.0) + (cm[5] if cm else 0), 0
            )
            base = str((font or {}).get("/BaseFont", "")) if hasattr(font, "get") else ""
            bold = bool(re.search(r"bold|black|heavy|semibold|demi", base, re.I))
            for i, piece in enumerate(text.split("\n")):
                if i > 0 or not lines or abs(lines[-1]["y"] - y) > 1.5:
                    if not piece.strip() and i > 0:
                        continue
                    lines.append({"y": y, "text": "", "sizes": Counter(), "bold": 0, "chars": 0})
                line = lines[-1]
                line["text"] += piece
                n = len(piece.strip())
                line["sizes"][real] += n
                line["chars"] += n
                line["bold"] += n if bold else 0

        try:
            text = page.extract_text(visitor_text=visit) or ""
        except Exception:  # noqa: BLE001 - one page that won't read leaves a gap, not a failure
            text = ""
        texts.append(text)
        lines_by_page.append([ln for ln in lines if ln["text"].strip()])
    starts, joined = [], []
    at = 0
    for text in texts:
        starts.append(at)
        joined.append(text)
        at += len(text) + 2
    full = "\n\n".join(joined)
    if len("".join(full.split())) < 20 * max(1, len(texts)):  # (as read_file tells a scan)
        return Structure(path, full, [], starts, "none", scanned=True)
    headings = _bookmarks(reader, full, starts)
    source = "bookmarks"
    if not headings:
        headings = _set_headings(lines_by_page, full, starts)
        source = "type sizes"
    if not headings:
        found = text_structure(path, full, markdown=False)
        headings = found.headings
        for h in headings:
            h.page = Structure(path, full, [], starts).page_at(h.start)
        source = "text"
    return Structure(path, full, headings, starts, source)


def _bookmarks(reader: Any, full: str, starts: list[int]) -> list[Heading]:
    out: list[Heading] = []

    def walk(items: Any, level: int) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
                continue
            title = _norm(getattr(item, "title", "") or "")
            if not title:
                continue
            try:
                page = reader.get_destination_page_number(item)
            except Exception:  # noqa: BLE001 - a bookmark to nowhere
                page = -1
            if page < 0 or page >= len(starts):
                continue
            end = starts[page + 1] if page + 1 < len(starts) else len(full)
            spot = _find_in(full, title, starts[page], end)
            out.append(Heading(level, title, spot if spot >= 0 else starts[page], page + 1))

    try:
        walk(reader.outline, 1)
    except Exception:  # noqa: BLE001 - a damaged outline: guess from the type instead
        return []
    return out


def _set_headings(pages: list[list[dict[str, Any]]], full: str, starts: list[int]) -> list[Heading]:
    """Headings guessed from the type: the body's size is the one most characters are set in;
    a line clearly bigger than that, or short and all bold, is a heading, bigger ones higher."""
    sizes: Counter[float] = Counter()
    for lines in pages:
        for line in lines:
            sizes.update(line["sizes"])
    if not sizes:
        return []
    body = sizes.most_common(1)[0][0]
    if body <= 0:
        return []
    repeats = Counter(_norm(ln["text"]).casefold() for lines in pages for ln in lines)
    many = max(3, len(pages) // 2)
    found: list[tuple[int, float, str]] = []  # (page, size, title)
    for number, lines in enumerate(pages):
        for line in lines:
            title = _norm(line["text"])
            words = title.split()
            if (
                not words
                or len(title) > 120
                or len(words) > 16
                or not re.search(r"[A-Za-z]{2}", title)
            ):
                continue
            if len(pages) >= 3 and repeats[title.casefold()] >= many:
                continue  # a running head or foot
            if re.fullmatch(r"[\d\s.\-–|/]+|page \d+.*", title, re.I):
                continue
            size = line["sizes"].most_common(1)[0][0]
            bigger = size >= body * 1.15
            all_bold = line["chars"] and line["bold"] >= 0.9 * line["chars"] and size >= body * 0.98
            if bigger or (all_bold and len(words) <= 10 and not title.endswith((".", ",", ";"))):
                found.append((number, size if bigger else body * 1.01, title))
    if not found or len(found) > 400:
        return []
    ranks = sorted({round(s, 0) for _, s, _ in found}, reverse=True)
    out: list[Heading] = []
    for number, size, title in found:
        level = min(4, ranks.index(round(size, 0)) + 1)
        end = starts[number + 1] if number + 1 < len(starts) else len(full)
        spot = _find_in(full, title, starts[number], end)
        if spot < 0:
            continue
        if (
            out
            and out[-1].page == number + 1
            and out[-1].level == level
            and spot - out[-1].start < len(out[-1].title) + 3
        ):
            # A heading set on two lines: one heading.
            out[-1].title = f"{out[-1].title} {title}"
            continue
        out.append(Heading(level, title, spot, number + 1))
    return out


def _docx_styles(path: Path) -> dict[str, tuple[str, int | None]]:
    from .rich_text import _part

    try:
        root = ET.fromstring(_part(path, "word/styles.xml"))
    except (KeyError, ValueError, ET.ParseError, zipfile.BadZipFile):
        return {}
    out = {}
    for style in root.iter(f"{W}style"):
        sid = style.get(f"{W}styleId") or ""
        name_el = style.find(f"{W}name")
        name = (name_el.get(f"{W}val") if name_el is not None else sid) or sid
        level_el = style.find(f"{W}pPr/{W}outlineLvl")
        level = int(level_el.get(f"{W}val", "9")) if level_el is not None else None
        out[sid] = (name.casefold(), level)
    return out


def _docx_level(style_name: str, style_level: int | None, own_level: int | None) -> int | None:
    m = re.fullmatch(r"heading\s*(\d)", style_name)
    if m:
        return int(m.group(1))
    if style_name == "title":
        return 1
    level = own_level if own_level is not None else style_level
    if level is not None and level < 9:
        return level + 1
    return None


def docx_structure(path: Path) -> Structure:
    from .rich_text import _paragraph, _part

    styles = _docx_styles(path)
    root = ET.fromstring(_part(path, "word/document.xml"))
    body = root.find(f"{W}body")
    lines: list[str] = []
    headings: list[Heading] = []
    at = 0
    title_seen = False

    def add(line: str) -> int:
        nonlocal at
        start = at
        lines.append(line)
        at += len(line) + 1
        return start

    def walk(el: ET.Element) -> None:
        nonlocal title_seen
        for child in el:
            if child.tag == f"{W}p":
                text = _paragraph(child).strip()
                if not text:
                    continue
                ppr = child.find(f"{W}pPr")
                sid, own = "", None
                if ppr is not None:
                    st = ppr.find(f"{W}pStyle")
                    sid = st.get(f"{W}val", "") if st is not None else ""
                    lvl = ppr.find(f"{W}outlineLvl")
                    own = int(lvl.get(f"{W}val", "9")) if lvl is not None else None
                name, style_level = styles.get(sid, (sid.casefold(), None))
                level = _docx_level(name, style_level, own)
                start = add(text)
                if level is not None and len(text) <= 200:
                    if name == "title":
                        title_seen = True
                    elif title_seen:
                        level += 1  # under the document's title
                    headings.append(Heading(min(level, 6), _norm(text), start))
            elif child.tag == f"{W}tbl":
                for row in child.iter(f"{W}tr"):
                    cells = [
                        " ".join(_paragraph(p).strip() for p in cell.iter(f"{W}p")).strip()
                        for cell in row.findall(f"{W}tc")
                    ]
                    add("\t".join(cells))
            elif child.tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml", f"{W}ins"):
                walk(child)

    if body is not None:
        walk(body)
    text = "\n".join(lines)
    if headings:
        return Structure(path, text, headings, source="styles")
    found = text_structure(path, text, markdown=False)
    return found


def _plain_heading(line: str, before: str, after: str) -> int | None:
    """A plain-text line's heading level, or None: numbered ("2.1 Data", level by its dots),
    in capitals, or one of the usual section names, short, and standing on its own line."""
    title = line.strip()
    words = title.split()
    if not words or len(title) > 90 or len(words) > 12 or title.endswith((",", ";")):
        return None
    if before.strip() and after.strip() and not NUMBERED.match(title):
        return None  # in the middle of a paragraph
    bare = re.sub(r"^[\dIVX]+(\.\d+)*\.?\s+", "", title).rstrip(":").strip().casefold()
    m = NUMBERED.match(title)
    if m and not title.endswith(".") and m.group(2)[:1].isupper() and len(words) <= 10:
        if CAPTION.match(title):
            return None
        return min(4, m.group(1).count(".") + 1)
    if bare in KNOWN_SECTIONS:
        return 1
    letters = re.sub(r"[^A-Za-z]", "", title)
    if len(letters) >= 4 and letters.isupper() and len(words) <= 8:
        return 1
    return None


def text_structure(path: Path, text: str, markdown: bool = True) -> Structure:
    headings: list[Heading] = []
    lines = text.split("\n")
    offsets, at = [], 0
    for line in lines:
        offsets.append(at)
        at += len(line) + 1
    fence = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if markdown and stripped.startswith(("```", "~~~")):
            fence = not fence
            continue
        if fence or not stripped:
            continue
        if markdown:
            m = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
            if m:
                headings.append(Heading(len(m.group(1)), _clean_md(m.group(2)), offsets[i]))
                continue
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if nxt and re.fullmatch(r"=+|-+", nxt) and len(nxt) >= 3 and len(stripped) <= 120:
                headings.append(Heading(1 if nxt[0] == "=" else 2, _clean_md(stripped), offsets[i]))
                continue
            bold = re.fullmatch(r"\*\*(.+?)\*\*:?", stripped)
            if bold and len(stripped) <= 80:
                before = lines[i - 1] if i else ""
                after = lines[i + 1] if i + 1 < len(lines) else ""
                if not before.strip() and not after.strip():
                    headings.append(Heading(3, _clean_md(bold.group(1)), offsets[i]))
                continue
        else:
            before = lines[i - 1] if i else ""
            after = lines[i + 1] if i + 1 < len(lines) else ""
            level = _plain_heading(stripped, before, after)
            if level is not None:
                headings.append(Heading(level, _norm(stripped.rstrip(":")), offsets[i]))
    return Structure(path, text, headings[:2000], source="markdown" if markdown else "text")


def _clean_md(text: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return _norm(re.sub(r"[*_`]+", "", text))


# ── what's said ──


def _words(text: str) -> int:
    return len(text.split())


def table_of_contents(doc: Structure) -> str:
    name = doc.path.name
    if doc.scanned:
        return (
            f"{name} is scanned pages with no text in them, so it has no headings to find. "
            "read_file shows its pages to read out."
        )
    if not doc.headings:
        return (
            f"{name} has no headings I can find ({_words(doc.text):,} words). "
            "Read it from the start with read_file, or ask for a part by a word in it."
        )
    how = {
        "bookmarks": "from its bookmarks",
        "type sizes": "guessed from the size and weight of its type",
        "styles": "from its heading styles",
        "markdown": "",
        "text": "guessed from its short numbered or capitalised lines",
    }.get(doc.source, "")
    lines = [
        f"{name}: {len(doc.headings)} headings{' ' + how if how else ''}, "
        f"{_words(doc.text):,} words in all."
    ]
    for i, h in enumerate(doc.headings[:MAX_HEADINGS], 1):
        words = _words(doc.text[h.start : doc.end_of(i - 1)])
        page = f", page {h.page}" if h.page else ""
        lines.append(f"{'  ' * (h.level - 1)}{i}. {h.title}{page}, {words:,} words")
    if len(doc.headings) > MAX_HEADINGS:
        lines.append(f"…and {len(doc.headings) - MAX_HEADINGS} more headings.")
    caps = captions(doc)
    if caps:
        figures = sum(1 for c in caps if c["kind"] not in ("table",))
        tables = len(caps) - figures
        lines.append(
            f"It has {figures} figure and {tables} table captions: list_captions reads them."
        )
    return "\n".join(lines)


def _bare(title: str) -> str:
    return re.sub(
        r"^(?:section|chapter|part)?\s*[\dIVX]+(\.\d+)*\.?\s+", "", title.casefold(), flags=re.I
    ).strip(" :.")


def find_section(doc: Structure, name: str) -> int:
    """The heading a person named: by its number in the contents, its own numbering ("2.1"),
    its title or a usual other name for it ("methods" finds "Materials and Methods")."""
    if not doc.headings:
        raise ValueError("That document has no headings to go to.")
    want = _norm(name).casefold().strip(" .:")
    want = re.sub(r"^(the|a)\s+", "", want)
    want = re.sub(r"\s+(section|part|chapter)$", "", want)
    if not want:
        raise ValueError("Say which section.")
    m = re.fullmatch(r"(?:section|heading|number|chapter|part)?\s*(\d+(?:\.\d+)*)", want)
    if m:
        own = [
            i
            for i, h in enumerate(doc.headings)
            if re.match(rf"^{re.escape(m.group(1))}\.?\s", h.title)
        ]
        if own:
            return own[0]
        if "." not in m.group(1) and 0 < int(m.group(1)) <= len(doc.headings):
            return int(m.group(1)) - 1
    titles = [_bare(h.title) for h in doc.headings]
    names = {want, *SYNONYMS.get(want, ())}
    for key, others in SYNONYMS.items():
        if want in others:
            names.add(key)
    for test in (
        lambda t: t == want,
        lambda t: t in names,
        lambda t: t.startswith(want),
        lambda t: any(n in t for n in names),
        lambda t: set(want.split()) <= set(re.findall(r"\w+", t)),
    ):
        hits = [i for i, t in enumerate(titles) if test(t)]
        if hits:
            return hits[0]
    listed = ", ".join(h.title for h in doc.headings[:20])
    raise ValueError(f"There's no section like {name}. The headings are: {listed}.")


def section_parts(text: str, size: int = PART_CHARS) -> list[str]:
    """A section cut into parts of about `size` characters, at paragraph or sentence ends."""
    text = text.strip()
    parts = []
    while len(text) > size:
        cut = text.rfind("\n\n", size // 2, size)
        if cut < 0:
            cut = max(text.rfind(". ", size // 2, size) + 1, 0)
        if cut <= 0:
            cut = text.rfind(" ", size // 2, size)
        if cut <= 0:
            cut = size
        parts.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        parts.append(text)
    return parts or [""]


def read_section(doc: Structure, name: str, part: int = 1) -> str:
    index = find_section(doc, name)
    heading = doc.headings[index]
    body = doc.text[heading.start : doc.end_of(index)]
    parts = section_parts(body)
    part = max(1, int(part or 1))
    if part > len(parts):
        return f"{heading.title} has only {len(parts)} parts."
    where = f" (page {heading.page})" if heading.page else ""
    head = f"{heading.title}{where}"
    if len(parts) > 1:
        head += f", part {part} of {len(parts)}"
    after = ""
    if part < len(parts):
        after = f"\n\n(More of this section follows: ask read_section for part {part + 1}.)"
    else:
        end = doc.end_of(index)
        following = next((h for h in doc.headings[index + 1 :] if h.start >= end), None)
        if following is not None:
            after = f"\n\n(End of this section. Next is {following.title}.)"
        else:
            after = "\n\n(End of this section, and of the document.)"
    return f"{head}:\n<document_section>\n{parts[part - 1]}\n</document_section>{after}"


def captions(doc: Structure) -> list[dict[str, Any]]:
    """Figure and table captions: {kind, label, text, page}, one per label (a line with a
    stop or colon after its number beats a mention in a sentence)."""
    found: dict[str, dict[str, Any]] = {}
    at = 0
    for line in doc.text.split("\n"):
        m = CAPTION.match(line)
        if m and len(line) <= 400:
            kind = m.group(1).casefold().rstrip(".")
            kind = "figure" if kind == "fig" else kind
            label = f"{kind} {m.group(2)}"
            strong = bool(m.group(3)) or (len(line) < 160 and m.group(4)[:1].isupper())
            rest = _norm(m.group(4))
            if strong and (label not in found or not found[label]["strong"]):
                found[label] = {
                    "kind": kind,
                    "label": label[0].upper() + label[1:],
                    "text": rest[:300],
                    "page": doc.page_at(at),
                    "strong": True,
                }
        at += len(line) + 1
    return list(found.values())


def captions_said(doc: Structure, which: str = "") -> str:
    caps = captions(doc)
    want = (which or "").casefold()
    if want in ("figures", "figure", "fig"):
        caps = [c for c in caps if c["kind"] != "table"]
    elif want in ("tables", "table"):
        caps = [c for c in caps if c["kind"] == "table"]
    if not caps:
        return f"I found no {want or 'figure or table'} captions in {doc.path.name}."
    lines = [f"{len(caps)} captions in {doc.path.name}:"]
    for c in caps:
        page = f" (page {c['page']})" if c["page"] else ""
        lines.append(f"{c['label']}{page}: {c['text'] or 'no caption text'}")
    return "\n".join(lines)
