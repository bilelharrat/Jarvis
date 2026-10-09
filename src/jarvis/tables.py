"""Spreadsheets and their charts, told in words: for someone who listens to a table rather than
looks at it.

A CSV, TSV or Excel workbook (.xlsx, .xlsm) is read with the standard library alone (an .xlsx is
a zip of XML: the shared strings, each sheet's cells, the styles that say which numbers are
dates). What comes out is plain facts, counts first: how many rows and columns, each column's
kind (numbers, dates, text, yes or no), and for each a short summary (lowest, highest, mean,
median, the most common values, how many are blank); the highest and lowest rows by a column;
the trend of a numeric column over an ordered one (rising or falling, by how much, where it
peaked); and the charts saved in a workbook (their kind, title and series), each series' trend
told the same way. Long files are summarised, never read out whole: a few rows at a time on
request.

Claude cost policy: no model call; these are tools of the ordinary conversation, and their
results are kept short so a large file costs a few hundred words, not its size.
"""

from __future__ import annotations

import csv
import io
import math
import re
import statistics
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

SUFFIXES = {".csv", ".tsv", ".tab", ".txt", ".xlsx", ".xlsm"}
MAX_BYTES = 50_000_000  # the biggest file read
MAX_PART = 200_000_000  # the most one part of a workbook may unpack to
MAX_ROWS = 200_000  # rows kept of a sheet; the rest are counted
MAX_COLUMNS = 200
SUMMARY_COLUMNS = 30  # columns summarised in one answer; the rest are named
ROWS_AT_A_TIME = 25
TEXT_LIMIT = 60  # characters of one cell said

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
CHART = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
DRAW = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

# Excel's built-in number formats that are dates or times.
DATE_FORMATS = set(range(14, 23)) | {27, 30, 36, 45, 46, 47, 50, 57}
EXCEL_EPOCH = datetime(1899, 12, 30)


@dataclass
class Sheet:
    name: str
    header: list[str]
    rows: list[list[Any]]  # cells: str, float, datetime, bool or None
    more_rows: int = 0  # rows past MAX_ROWS, counted but not kept
    charts: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Book:
    path: Path
    sheets: list[Sheet]


# ── reading ──


def load(path: Path) -> Book:
    """The file's sheets (a CSV or TSV is one). ValueError with a sentence when it can't be read."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in SUFFIXES:
        raise ValueError("That isn't a spreadsheet I can read: CSV, TSV or Excel (.xlsx) only.")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ValueError("I couldn't open that file.") from exc
    if size > MAX_BYTES:
        raise ValueError("That spreadsheet is too big for me to read (over 50 megabytes).")
    if suffix in (".xlsx", ".xlsm"):
        try:
            return Book(path, _xlsx(path))
        except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
            raise ValueError("That Excel file seems damaged; I couldn't read it.") from exc
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    delimiter = "\t" if suffix in (".tsv", ".tab") else _delimiter(text)
    rows, more = [], 0
    for row in csv.reader(io.StringIO(text), delimiter=delimiter):
        if len(rows) >= MAX_ROWS + 1:
            more += 1
            continue
        rows.append([_cell_from_text(c) for c in row[:MAX_COLUMNS]])
    header, body = _split_header(rows)
    return Book(path, [Sheet(path.stem, header, body, more)])


def _delimiter(text: str) -> str:
    sample = text[:20_000]
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


_NUMBER = re.compile(r"^[-+]?[$£€¥]?\s*[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\s*%?$")


def _cell_from_text(raw: str) -> Any:
    """A CSV cell as a number, a date, a yes or no, or text (None when blank)."""
    text = raw.strip()
    if not text:
        return None
    number = parse_number(text)
    if number is not None:
        return number
    when = parse_date(text)
    if when is not None:
        return when
    return text


def parse_number(text: str) -> float | None:
    t = text.strip()
    negative = t.startswith("(") and t.endswith(")")
    if negative:
        t = t[1:-1]
    if not t or not any(ch.isdigit() for ch in t) or not _NUMBER.match(t):
        return None
    percent = t.endswith("%")
    cleaned = re.sub(r"[$£€¥,%\s]", "", t)
    try:
        value = float(cleaned)
    except ValueError:
        return None
    if percent:
        value /= 100
    return -value if negative else value


_DATE_FORMATS = (
    "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d",
    "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y", "%b %Y", "%B %Y", "%Y-%m",
)  # fmt: skip


def parse_date(text: str) -> datetime | None:
    t = text.strip()
    if len(t) < 6 or len(t) > 25:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            continue
    m = re.fullmatch(r"(\d{1,2})[/.](\d{1,2})[/.](\d{4})", t)
    if m:
        a, b, year = (int(x) for x in m.groups())
        month, day = (a, b) if a <= 12 else (b, a)  # 3/14/2024 or 14/3/2024
        try:
            return datetime(year, month, day)
        except ValueError:
            return None
    return None


def _split_header(rows: list[list[Any]]) -> tuple[list[str], list[list[Any]]]:
    """The header row (the first non-blank one when it is all text) and the rows under it,
    each as long as the widest row. A sheet with no text header gets "Column A", "B"…"""
    while rows and all(c is None for c in rows[0]):
        rows = rows[1:]
    width = max((len(r) for r in rows), default=0)
    rows = [r + [None] * (width - len(r)) for r in rows]
    if not rows:
        return [], []
    first = rows[0]
    filled = [c for c in first if c is not None]
    looks_like_header = bool(filled) and all(isinstance(c, str) for c in filled)
    if looks_like_header and len(rows) > 1:
        header = [str(c).strip() if c is not None else "" for c in first]
        body = rows[1:]
    else:
        header, body = [""] * width, rows
    seen: Counter[str] = Counter()
    names = []
    for i, name in enumerate(header):
        name = name or f"Column {letters(i)}"
        seen[name.casefold()] += 1
        if seen[name.casefold()] > 1:
            name = f"{name} ({seen[name.casefold()]})"
        names.append(name)
    while body and all(c is None for c in body[-1]):
        body.pop()
    return names, body


def letters(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    out = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        out = chr(65 + rest) + out
    return out


def _column_index(ref: str) -> int:
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def _part(zf: zipfile.ZipFile, name: str) -> bytes:
    info = zf.getinfo(name)
    if info.file_size > MAX_PART:
        raise ValueError("That workbook unpacks to more than I can read.")
    data = zf.read(info)
    if b"<!ENTITY" in data or b"<!DOCTYPE" in data:  # Excel writes neither
        raise ValueError("That workbook defines its own entities; I won't read it.")
    return data


def _target(base: str, target: str) -> str:
    """A relationship's target as a path inside the zip."""
    if target.startswith("/"):
        return target.lstrip("/")
    parts = base.split("/")[:-1]
    for piece in target.split("/"):
        if piece == "..":
            if parts:
                parts.pop()
        elif piece and piece != ".":
            parts.append(piece)
    return "/".join(parts)


def _rels(zf: zipfile.ZipFile, part: str) -> dict[str, str]:
    folder, _, name = part.rpartition("/")
    rels_name = f"{folder}/_rels/{name}.rels" if folder else f"_rels/{name}.rels"
    if rels_name not in zf.namelist():
        return {}
    root = ET.fromstring(_part(zf, rels_name))
    return {
        r.get("Id", ""): _target(part, r.get("Target", ""))
        for r in root.iter(f"{PKG_REL}Relationship")
    }


def _xlsx(path: Path) -> list[Sheet]:
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(_part(zf, "xl/sharedStrings.xml")).iter(f"{MAIN}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{MAIN}t")))
        dates = _date_styles(zf) if "xl/styles.xml" in names else set()
        book = ET.fromstring(_part(zf, "xl/workbook.xml"))
        rels = _rels(zf, "xl/workbook.xml")
        sheets: list[Sheet] = []
        for el in book.iter(f"{MAIN}sheet"):
            name = el.get("name") or f"Sheet {len(sheets) + 1}"
            part = rels.get(el.get(f"{REL}id") or "", "")
            if part not in names:
                continue
            rows, more = _sheet_rows(_part(zf, part), shared, dates)
            header, body = _split_header(rows)
            sheet = Sheet(name, header, body, more)
            sheet.charts = _charts_of(zf, part, names)
            sheets.append(sheet)
        return sheets


def _date_styles(zf: zipfile.ZipFile) -> set[int]:
    """The cell style indexes whose number format is a date."""
    root = ET.fromstring(_part(zf, "xl/styles.xml"))
    custom = {}
    for fmt in root.iter(f"{MAIN}numFmt"):
        code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", fmt.get("formatCode", "")).lower()
        custom[int(fmt.get("numFmtId", "0"))] = bool(re.search(r"[dy]|m{3,}", code))
    out: set[int] = set()
    xfs = root.find(f"{MAIN}cellXfs")
    if xfs is None:
        return out
    for i, xf in enumerate(xfs.findall(f"{MAIN}xf")):
        fid = int(xf.get("numFmtId", "0"))
        if fid in DATE_FORMATS or custom.get(fid):
            out.add(i)
    return out


def _sheet_rows(data: bytes, shared: list[str], dates: set[int]) -> tuple[list[list[Any]], int]:
    rows: list[list[Any]] = []
    more = 0
    for _event, row in ET.iterparse(io.BytesIO(data), events=("end",)):
        if row.tag != f"{MAIN}row":
            continue
        if len(rows) >= MAX_ROWS + 1:
            more += 1
            row.clear()
            continue
        number = int(row.get("r") or len(rows) + 1)
        while len(rows) < number - 1:  # rows Excel left out because they are empty
            rows.append([])
        cells: list[Any] = []
        for c in row.findall(f"{MAIN}c"):
            col = _column_index(c.get("r") or "") if c.get("r") else len(cells)
            if col < 0 or col >= MAX_COLUMNS:
                continue
            while len(cells) < col:
                cells.append(None)
            cells.append(_xlsx_value(c, shared, dates))
        rows.append(cells)
        row.clear()
    return rows, more


def _xlsx_value(c: ET.Element, shared: list[str], dates: set[int]) -> Any:
    kind = c.get("t", "n")
    v = c.find(f"{MAIN}v")
    raw = v.text if v is not None else None
    if kind == "inlineStr":
        text = "".join(t.text or "" for t in c.iter(f"{MAIN}t"))
        return text.strip() or None
    if raw is None or raw == "":
        return None
    if kind == "s":
        try:
            text = shared[int(raw)]
        except (ValueError, IndexError):
            return None
        return text.strip() or None
    if kind == "b":
        return raw == "1"
    if kind in ("str", "e"):
        return raw.strip() or None
    try:
        number = float(raw)
    except ValueError:
        return raw
    if int(c.get("s", "0") or 0) in dates and 0 < number < 2_958_466:
        return EXCEL_EPOCH + timedelta(days=number)
    return number


def _charts_of(zf: zipfile.ZipFile, sheet_part: str, names: set[str]) -> list[dict[str, Any]]:
    """The charts drawn on a sheet: {kind, title, series: [{name, categories, values}]}."""
    out = []
    for target in _rels(zf, sheet_part).values():
        if "drawings/" not in target or target not in names:
            continue
        for chart_part in _rels(zf, target).values():
            if "charts/chart" in chart_part and chart_part in names:
                try:
                    out.append(_chart(ET.fromstring(_part(zf, chart_part))))
                except (ET.ParseError, ValueError):
                    continue
    return out


CHART_KINDS = {
    "lineChart": "line chart", "line3DChart": "line chart", "barChart": "bar chart",
    "bar3DChart": "bar chart", "pieChart": "pie chart", "pie3DChart": "pie chart",
    "doughnutChart": "doughnut chart", "areaChart": "area chart", "area3DChart": "area chart",
    "scatterChart": "scatter chart", "radarChart": "radar chart", "bubbleChart": "bubble chart",
    "stockChart": "stock chart", "surfaceChart": "surface chart",
}  # fmt: skip


def _cache(el: ET.Element | None) -> list[Any]:
    if el is None:
        return []
    words = el.find(f".//{CHART}strCache") is not None  # (category names: "2021" stays a name)
    points: dict[int, Any] = {}
    for pt in el.iter(f"{CHART}pt"):
        v = pt.find(f"{CHART}v")
        if v is None or v.text is None:
            continue
        try:
            points[int(pt.get("idx", "0"))] = v.text if words else float(v.text)
        except ValueError:
            points[int(pt.get("idx", "0"))] = v.text
    count = el.find(f".//{CHART}ptCount")
    n = int(count.get("val", "0")) if count is not None else (max(points) + 1 if points else 0)
    return [points.get(i) for i in range(n)]


def _either(el: ET.Element, first: str, second: str) -> ET.Element | None:
    found = el.find(f"{CHART}{first}")
    return found if found is not None else el.find(f"{CHART}{second}")


def _chart(root: ET.Element) -> dict[str, Any]:
    title_el = root.find(f".//{CHART}chart/{CHART}title")
    title = (
        " ".join(t.text or "" for t in title_el.iter(f"{DRAW}t")).strip()
        if title_el is not None
        else ""
    )
    plot = root.find(f".//{CHART}plotArea")
    kinds, series = [], []
    for group in list(plot) if plot is not None else []:
        kind = group.tag.replace(CHART, "")
        if kind not in CHART_KINDS:
            continue
        direction = group.find(f"{CHART}barDir")
        spoken = CHART_KINDS[kind]
        if direction is not None and direction.get("val") == "bar":
            spoken = "horizontal bar chart"
        elif kind.startswith("bar"):
            spoken = "column chart"
        kinds.append(spoken)
        for ser in group.findall(f"{CHART}ser"):
            tx = ser.find(f"{CHART}tx")
            name = ""
            if tx is not None:
                name = " ".join(str(x) for x in _cache(tx) if x is not None) or "".join(
                    v.text or "" for v in tx.iter(f"{CHART}v")
                )
            cat = _either(ser, "cat", "xVal")
            val = _either(ser, "val", "yVal")
            series.append(
                {
                    "name": name.strip() or f"Series {len(series) + 1}",
                    "categories": _cache(cat),
                    "values": [v if isinstance(v, float) else None for v in _cache(val)],
                }
            )
    return {"kind": " and ".join(dict.fromkeys(kinds)) or "chart", "title": title, "series": series}


# ── what's in a column ──


def kind_of(values: list[Any]) -> str:
    """number, date, yes/no or text: what most of a column's filled cells are."""
    filled = [v for v in values if v is not None]
    if not filled:
        return "empty"
    counts = Counter(
        "yes/no" if isinstance(v, bool) else "number" if isinstance(v, float) else
        "date" if isinstance(v, datetime) else "text"
        for v in filled
    )  # fmt: skip
    kind, n = counts.most_common(1)[0]
    return kind if n >= 0.8 * len(filled) else "text"


def column(sheet: Sheet, index: int) -> list[Any]:
    return [row[index] if index < len(row) else None for row in sheet.rows]


def find_column(sheet: Sheet, name: str) -> int:
    """The column a person named: its heading (exact, then start, then anywhere), or its letter."""
    want = " ".join(str(name or "").split()).casefold()
    if not want:
        raise ValueError("Say which column.")
    names = [h.casefold() for h in sheet.header]
    for test in (
        lambda h: h == want,
        lambda h: h.startswith(want),
        lambda h: want in h,
        lambda h: bool(set(want.split()) & set(h.split())),
    ):
        hits = [i for i, h in enumerate(names) if test(h)]
        if hits:
            return hits[0]
    m = re.fullmatch(r"(?:column\s+)?([a-z]{1,2})", want)
    if m and _column_index(m.group(1)) < len(sheet.header):
        return _column_index(m.group(1))
    raise ValueError(
        f"There's no column called {name}. The columns are: {', '.join(sheet.header[:SUMMARY_COLUMNS])}."
    )


def number_word(value: Any) -> str:
    """A value as it would be said: 1,234.5, 12%, 3 March 2024, yes."""
    if value is None:
        return "blank"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, datetime):
        if value.time() == datetime.min.time():
            return f"{value.day} {value:%B %Y}"
        return f"{value.day} {value:%B %Y, %H:%M}"
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return "not a number"
        if value == int(value) and abs(value) < 1e15:
            return f"{int(value):,}"
        if abs(value) >= 100:
            return f"{value:,.1f}"
        return f"{value:,.4g}" if abs(value) < 1 else f"{value:,.2f}".rstrip("0").rstrip(".")
    text = " ".join(str(value).split())
    return text if len(text) <= TEXT_LIMIT else text[: TEXT_LIMIT - 1] + "…"


def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}" if n == 1 else f"{n:,} {word}s"


def summarise_column(name: str, values: list[Any]) -> str:
    kind = kind_of(values)
    blanks = sum(1 for v in values if v is None)
    blank_note = f", {_plural(blanks, 'blank')}" if blanks else ""
    if kind == "empty":
        return f"{name}: empty."
    if kind == "number":
        nums = [v for v in values if isinstance(v, float) and not isinstance(v, bool)]
        return (
            f"{name}: numbers, lowest {number_word(min(nums))}, highest {number_word(max(nums))}, "
            f"mean {number_word(statistics.fmean(nums))}, median {number_word(statistics.median(nums))}"
            f"{blank_note}."
        )
    if kind == "date":
        when = [v for v in values if isinstance(v, datetime)]
        return (
            f"{name}: dates from {number_word(min(when))} to {number_word(max(when))}{blank_note}."
        )
    filled = [number_word(v) for v in values if v is not None]
    counts = Counter(filled)
    if kind == "yes/no":
        yes = sum(1 for v in values if v is True)
        return f"{name}: yes or no, {yes:,} yes and {len(filled) - yes:,} no{blank_note}."
    if len(counts) == len(filled):
        return f"{name}: text, every value different (for example {filled[0]}){blank_note}."
    common = ", ".join(f"{v} ({n:,})" for v, n in counts.most_common(3))
    return f"{name}: text, {_plural(len(counts), 'different value')}; most common {common}{blank_note}."


def overview(book: Book, sheet_name: str = "") -> str:
    """The workbook's sheets, then the chosen sheet's size and columns, each summarised."""
    sheet = pick_sheet(book, sheet_name)
    lines = []
    if len(book.sheets) > 1:
        listed = "; ".join(
            f"{s.name} ({_plural(len(s.rows) + s.more_rows, 'row')})" for s in book.sheets
        )
        lines.append(f"{_plural(len(book.sheets), 'sheet')}: {listed}. This is {sheet.name}.")
    rows = len(sheet.rows) + sheet.more_rows
    lines.append(f"{_plural(rows, 'row')} and {_plural(len(sheet.header), 'column')}.")
    if sheet.more_rows:
        lines.append(f"(Only the first {MAX_ROWS:,} rows are summarised.)")
    for i, name in enumerate(sheet.header[:SUMMARY_COLUMNS]):
        lines.append(summarise_column(name, column(sheet, i)))
    if len(sheet.header) > SUMMARY_COLUMNS:
        rest = sheet.header[SUMMARY_COLUMNS:]
        lines.append(f"{_plural(len(rest), 'more column')}: {', '.join(rest[:40])}.")
    charts = [c for s in book.sheets for c in s.charts]
    if charts:
        lines.append(
            f"The workbook has {_plural(len(charts), 'chart')}: ask for them to hear each."
        )
    return "\n".join(lines)


def pick_sheet(book: Book, name: str = "") -> Sheet:
    if not book.sheets:
        raise ValueError("That workbook has no sheets with anything in them.")
    want = (name or "").strip().casefold()
    if not want:
        return next((s for s in book.sheets if s.rows), book.sheets[0])
    for test in (lambda s: s == want, lambda s: want in s):
        for sheet in book.sheets:
            if test(sheet.name.casefold()):
                return sheet
    if want.isdigit() and 0 < int(want) <= len(book.sheets):
        return book.sheets[int(want) - 1]
    raise ValueError(
        f"There's no sheet called {name}. The sheets are: {', '.join(s.name for s in book.sheets)}."
    )


def _label_column(sheet: Sheet, skip: int) -> int | None:
    """The column that names a row: the first text column (not the one being measured)."""
    for i in range(len(sheet.header)):
        if i != skip and kind_of(column(sheet, i)) in ("text", "date"):
            return i
    return None


def _row_words(sheet: Sheet, index: int, label: int | None) -> str:
    """How a row is named aloud: its label cell, or its row number in the file."""
    row_number = (
        index + 2 if sheet.header and not sheet.header[0].startswith("Column ") else index + 1
    )
    if label is not None and sheet.rows[index][label] is not None:
        return f"{number_word(sheet.rows[index][label])} (row {row_number})"
    return f"row {row_number}"


def extremes(book: Book, column_name: str, sheet_name: str = "", count: int = 5) -> str:
    sheet = pick_sheet(book, sheet_name)
    index = find_column(sheet, column_name)
    name = sheet.header[index]
    values = column(sheet, index)
    kind = kind_of(values)
    if kind not in ("number", "date"):
        return f"{name} isn't numbers or dates, so it has no highest or lowest."
    typed = float if kind == "number" else datetime
    ranked = [
        (v, i) for i, v in enumerate(values) if isinstance(v, typed) and not isinstance(v, bool)
    ]
    count = max(1, min(20, int(count or 5)))
    label = _label_column(sheet, index)
    ranked.sort(key=lambda t: t[0])
    top = list(reversed(ranked[-count:]))
    low = ranked[:count]

    def said(pairs):
        return "; ".join(f"{_row_words(sheet, i, label)}: {number_word(v)}" for v, i in pairs)

    out = [f"{name}, {_plural(len(ranked), 'value')}."]
    out.append(f"Highest: {said(top)}.")
    out.append(f"Lowest: {said(low)}.")
    if kind == "number":
        ties = sum(1 for v, _ in ranked if v == top[0][0])
        if ties > 1:
            out.append(f"{ties} rows share the highest value.")
    return "\n".join(out)


def _order_key(value: Any) -> float | None:
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, float) and not isinstance(value, bool):
        return value
    return None


def describe_trend(values: list[float], labels: list[str], name: str, over: str = "") -> str:
    """Rising, falling or flat, by how much, and where it peaked and bottomed: told from the
    first and last points and the least-squares line through them all."""
    points = [(v, lab) for v, lab in zip(values, labels, strict=True) if v is not None]
    if len(points) < 2:
        return f"{name} has too few numbers for a trend."
    ys = [v for v, _ in points]
    n = len(ys)
    first, last = points[0], points[-1]
    change = last[0] - first[0]
    xbar, ybar = (n - 1) / 2, statistics.fmean(ys)
    slope = sum((i - xbar) * (y - ybar) for i, y in enumerate(ys)) / sum(
        (i - xbar) ** 2 for i in range(n)
    )
    # Flat: the fitted line's rise and the first-to-last change both under 5% of the level (or
    # of the spread, for values around nothing).
    scale = max(abs(ybar), max(ys) - min(ys)) or 1.0
    fitted = slope * (n - 1)
    if abs(fitted) < 0.05 * scale and abs(change) < 0.05 * scale:
        word = "roughly flat"
    elif fitted > 0:
        word = "rising"
    else:
        word = "falling"
    ups = sum(1 for a, b in zip(ys, ys[1:], strict=False) if b > a)
    downs = sum(1 for a, b in zip(ys, ys[1:], strict=False) if b < a)
    by = f" over {over}" if over else ""
    out = f"{name}{by}: {word} overall, {_plural(n, 'point')}, from {number_word(first[0])} ({first[1]}) to {number_word(last[0])} ({last[1]})"
    if change:
        pct = f", {abs(change) / abs(first[0]) * 100:.0f}%" if first[0] else ""
        out += f", {'up' if change > 0 else 'down'} {number_word(abs(change))}{pct}"
    out += "."
    peak = max(points, key=lambda p: p[0])
    trough = min(points, key=lambda p: p[0])
    out += f" Highest {number_word(peak[0])} at {peak[1]}; lowest {number_word(trough[0])} at {trough[1]}."
    out += f" It went up {_plural(ups, 'time')} and down {_plural(downs, 'time')} from one point to the next."
    if word != "roughly flat":
        out += f" The straight-line fit {'rises' if slope > 0 else 'falls'} about {number_word(abs(slope))} a step."
    return out


def trend(book: Book, column_name: str, by: str = "", sheet_name: str = "") -> str:
    sheet = pick_sheet(book, sheet_name)
    index = find_column(sheet, column_name)
    name = sheet.header[index]
    values = column(sheet, index)
    if kind_of(values) != "number":
        return f"{name} isn't a column of numbers, so it has no trend."
    order = None
    if by:
        order = find_column(sheet, by)
    else:
        for i in range(len(sheet.header)):
            if i != index and kind_of(column(sheet, i)) == "date":
                order = i
                break
    label = order if order is not None else _label_column(sheet, index)
    rows = list(range(len(sheet.rows)))
    over = "the rows in order"
    if order is not None:
        keys = column(sheet, order)
        if kind_of(keys) in ("date", "number"):
            rows = sorted(
                (i for i in rows if _order_key(keys[i]) is not None),
                key=lambda i: _order_key(keys[i]),
            )
        over = sheet.header[order]
    nums = [
        values[i] if isinstance(values[i], float) and not isinstance(values[i], bool) else None
        for i in rows
    ]
    labels = [_row_words(sheet, i, label) for i in rows]
    return describe_trend(nums, labels, name, over)


def read_rows(book: Book, start: int = 1, count: int = ROWS_AT_A_TIME, sheet_name: str = "") -> str:
    """A few rows, each as "heading: value" pairs (start counts from 1, the first row under the
    headings)."""
    sheet = pick_sheet(book, sheet_name)
    total = len(sheet.rows)
    start = max(1, int(start or 1))
    count = max(1, min(ROWS_AT_A_TIME, int(count or ROWS_AT_A_TIME)))
    if start > total:
        return f"There are only {_plural(total, 'row')}."
    end = min(total, start + count - 1)
    lines = [f"Rows {start} to {end} of {total:,}:"]
    for i in range(start - 1, end):
        cells = [
            f"{sheet.header[j]}: {number_word(v)}"
            for j, v in enumerate(sheet.rows[i][: len(sheet.header)])
            if v is not None
        ]
        lines.append(f"{i + 1}. " + "; ".join(cells[:SUMMARY_COLUMNS]))
    if end < total:
        lines.append(f"More follow: ask for rows from {end + 1}.")
    return "\n".join(lines)


def charts(book: Book) -> str:
    """Each chart in the workbook: its kind, title, series, and each series' trend."""
    found = [(s.name, c) for s in book.sheets for c in s.charts]
    if not found:
        return "This workbook has no charts."
    lines = [f"{_plural(len(found), 'chart')}."]
    for n, (sheet_name, chart) in enumerate(found, 1):
        title = f" titled {chart['title']}" if chart["title"] else ""
        names = ", ".join(s["name"] for s in chart["series"]) or "no series"
        lines.append(
            f"{n}. A {chart['kind']}{title} on {sheet_name}, "
            f"{_plural(len(chart['series']), 'series')}: {names}."
        )
        for series in chart["series"][:6]:
            cats = [
                number_word(c) if c is not None else f"point {i + 1}"
                for i, c in enumerate(series["categories"])
            ]
            if len(cats) < len(series["values"]):
                cats += [f"point {i + 1}" for i in range(len(cats), len(series["values"]))]
            if "pie" in chart["kind"] or "doughnut" in chart["kind"]:
                total = sum(v for v in series["values"] if v) or 1.0
                parts = sorted(
                    ((v, c) for v, c in zip(series["values"], cats, strict=False) if v),
                    reverse=True,
                )
                said = ", ".join(f"{c} {v / total * 100:.0f}%" for v, c in parts[:8])
                lines.append(f"   {series['name']}: {said}.")
            else:
                lines.append(
                    "   "
                    + describe_trend(
                        series["values"], cats[: len(series["values"])], series["name"]
                    )
                )
    return "\n".join(lines)
