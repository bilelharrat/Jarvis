"""Spreadsheets told in words (tables.py) and their tools (features/spreadsheets.py): CSV, TSV and
Excel read with the standard library, each column summarised, the highest and lowest rows, a
column's trend, rows a few at a time, and a workbook's charts. Real files made here; no network."""

from __future__ import annotations

import asyncio
import zipfile
from pathlib import Path

import pytest

from jarvis import tables
from jarvis.features import spreadsheets

SALES = (
    "Month,Region,Sales,Returns,Paid\n"
    "2024-01-01,North,1200,5,yes\n"
    "2024-02-01,South,1350,,yes\n"
    "2024-03-01,North,1500,7,no\n"
    "2024-04-01,East,1490,3,yes\n"
    '2024-05-01,North,"1,800",2,yes\n'
    "2024-06-01,South,2100,4,no\n"
)


@pytest.fixture
def sales(tmp_path):
    path = tmp_path / "sales.csv"
    path.write_text(SALES, encoding="utf-8")
    return path


def test_a_csv_is_summarised_column_by_column_counts_first(sales):
    said = tables.overview(tables.load(sales))
    lines = said.splitlines()
    assert lines[0] == "6 rows and 5 columns."
    assert lines[1] == "Month: dates from 1 January 2024 to 1 June 2024."
    assert lines[2].startswith("Region: text, 3 different values; most common North (3)")
    assert lines[3] == "Sales: numbers, lowest 1,200, highest 2,100, mean 1,573.3, median 1,495."
    assert "1 blank" in lines[4]
    assert lines[5] == "Paid: text, 2 different values; most common yes (4), no (2)."


def test_the_highest_and_lowest_rows_are_named_by_their_label(sales):
    said = tables.extremes(tables.load(sales), "sales", count=2)
    assert said.splitlines() == [
        "Sales, 6 values.",
        "Highest: 1 June 2024 (row 7): 2,100; 1 May 2024 (row 6): 1,800.",
        "Lowest: 1 January 2024 (row 2): 1,200; 1 February 2024 (row 3): 1,350.",
    ]
    assert "isn't numbers" in tables.extremes(tables.load(sales), "region")


def test_a_trend_says_rising_or_falling_by_how_much_and_where_it_peaked(sales):
    said = tables.trend(tables.load(sales), "Sales")
    assert said.startswith("Sales over Month: rising overall, 6 points, from 1,200")
    assert "up 900, 75%" in said
    assert "Highest 2,100 at 1 June 2024" in said and "lowest 1,200 at 1 January 2024" in said
    assert "went up 4 times and down 1 time" in said
    falling = tables.describe_trend([10.0, 8.0, 9.0, 4.0], ["a", "b", "c", "d"], "Stock")
    assert "falling overall" in falling and "down 6, 60%" in falling
    flat = tables.describe_trend([5.0, 5.1, 4.9, 5.0], ["a", "b", "c", "d"], "Level")
    assert "roughly flat" in flat


def test_columns_are_found_by_heading_part_or_letter_and_a_wrong_one_lists_them(sales):
    sheet = tables.load(sales).sheets[0]
    assert tables.find_column(sheet, "sales") == 2
    assert tables.find_column(sheet, "ret") == 3
    assert tables.find_column(sheet, "column B") == 1
    with pytest.raises(ValueError, match="The columns are: Month, Region"):
        tables.find_column(sheet, "profit")


def test_rows_are_read_a_few_at_a_time_with_their_headings(sales):
    said = tables.read_rows(tables.load(sales), start=5, count=10)
    assert said.splitlines()[0] == "Rows 5 to 6 of 6:"
    assert (
        said.splitlines()[1]
        == "5. Month: 1 May 2024; Region: North; Sales: 1,800; Returns: 2; Paid: yes"
    )
    more = tables.read_rows(tables.load(sales), start=1, count=2)
    assert more.endswith("More follow: ask for rows from 3.")


def test_a_tsv_and_a_semicolon_file_and_a_headerless_one(tmp_path):
    tsv = tmp_path / "scores.tsv"
    tsv.write_text("Name\tScore\nAda\t91\nBen\t78\n", encoding="utf-8")
    assert tables.overview(tables.load(tsv)).splitlines()[0] == "2 rows and 2 columns."
    semi = tmp_path / "europe.csv"
    semi.write_text("Land;Wert\nDE;3\nFR;5\nIT;4\n", encoding="utf-8")
    assert "Wert: numbers, lowest 3, highest 5" in tables.overview(tables.load(semi))
    bare = tmp_path / "bare.csv"
    bare.write_text("1,2\n3,4\n", encoding="utf-8")
    sheet = tables.load(bare).sheets[0]
    assert sheet.header == ["Column A", "Column B"] and len(sheet.rows) == 2


def test_numbers_dates_and_odd_cells_are_understood():
    assert tables.parse_number("$1,234.50") == 1234.5
    assert tables.parse_number("(12)") == -12
    assert tables.parse_number("45%") == 0.45
    assert tables.parse_number("12 Main St") is None
    assert tables.parse_date("14/3/2024").month == 3
    assert tables.parse_date("March 2024").year == 2024
    assert tables.parse_date("hello") is None
    assert tables.letters(0) == "A" and tables.letters(27) == "AB"


# ── Excel ──

CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
CHART_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'


def chart_xml() -> str:
    def cache(tag, values, numeric):
        pts = "".join(f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in enumerate(values))
        kind = "numCache" if numeric else "strCache"
        ref = "numRef" if numeric else "strRef"
        return f'<c:{tag}><c:{ref}><c:f>x</c:f><c:{kind}><c:ptCount val="{len(values)}"/>{pts}</c:{kind}></c:{ref}></c:{tag}>'

    ser = (
        '<c:ser><c:idx val="0"/>'
        '<c:tx><c:strRef><c:f>B1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Enrolment</c:v></c:pt></c:strCache></c:strRef></c:tx>'
        + cache("cat", ["2021", "2022", "2023"], False)
        + cache("val", [120, 95, 80], True)
        + "</c:ser>"
    )
    return (
        f'<?xml version="1.0"?><c:chartSpace {CHART_NS}><c:chart>'
        "<c:title><c:tx><c:rich><a:p><a:r><a:t>Students per year</a:t></a:r></a:p></c:rich></c:tx></c:title>"
        f'<c:plotArea><c:barChart><c:barDir val="col"/>{ser}</c:barChart></c:plotArea>'
        "</c:chart></c:chartSpace>"
    )


def make_xlsx(path: Path) -> Path:
    shared = ["Date", "Course", "Students", "Statistics", "Ethics"]
    sst = "".join(f"<si><t>{s}</t></si>" for s in shared)
    # Style 1 is a date (built-in format 14); dates are Excel serials (45292 = 2024-01-01).
    sheet1 = (
        f"<worksheet {NS}><sheetData>"
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
        '<row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>40</v></c></row>'
        '<row r="3"><c r="A3" s="1"><v>45323</v></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>25</v></c></row>'
        '<row r="5"><c r="A5" s="1"><v>45352</v></c><c r="B5" t="inlineStr"><is><t>Logic</t></is></c><c r="C5"><v>31</v></c></row>'
        "</sheetData></worksheet>"
    )
    sheet2 = f'<worksheet {NS}><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>'
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", CT)
        zf.writestr(
            "xl/workbook.xml",
            f'<workbook {NS}><sheets><sheet name="Courses" sheetId="1" r:id="rId1"/>'
            f'<sheet name="Flags" sheetId="2" r:id="rId2"/></sheets></workbook>',
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            f'<Relationships {RELS}><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
        )
        zf.writestr("xl/sharedStrings.xml", f"<sst {NS}>{sst}</sst>")
        zf.writestr(
            "xl/styles.xml",
            f'<styleSheet {NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        )
        zf.writestr("xl/worksheets/sheet1.xml", sheet1)
        zf.writestr("xl/worksheets/sheet2.xml", sheet2)
        zf.writestr(
            "xl/worksheets/_rels/sheet1.xml.rels",
            f'<Relationships {RELS}><Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>',
        )
        zf.writestr("xl/drawings/drawing1.xml", "<wsDr/>")
        zf.writestr(
            "xl/drawings/_rels/drawing1.xml.rels",
            f'<Relationships {RELS}><Relationship Id="rId1" Target="../charts/chart1.xml"/></Relationships>',
        )
        zf.writestr("xl/charts/chart1.xml", chart_xml())
    return path


def test_an_excel_workbook_lists_its_sheets_and_reads_dates_and_shared_text(tmp_path):
    book = tables.load(make_xlsx(tmp_path / "courses.xlsx"))
    said = tables.overview(book)
    lines = said.splitlines()
    assert lines[0] == "2 sheets: Courses (4 rows); Flags (1 row). This is Courses."
    assert "Date: dates from 1 January 2024 to 1 March 2024, 1 blank." in lines
    assert "Students: numbers, lowest 25, highest 40, mean 32, median 31, 1 blank." in lines
    assert lines[-1] == "The workbook has 1 chart: ask for them to hear each."
    assert tables.pick_sheet(book, "flags").name == "Flags"
    with pytest.raises(ValueError, match="The sheets are: Courses, Flags"):
        tables.pick_sheet(book, "Budget")


def test_a_workbooks_chart_is_told_with_its_series_trend(tmp_path):
    said = tables.charts(tables.load(make_xlsx(tmp_path / "courses.xlsx")))
    lines = said.splitlines()
    assert lines[0] == "1 chart."
    assert lines[1] == "1. A column chart titled Students per year on Courses, 1 series: Enrolment."
    assert (
        "Enrolment: falling overall, 3 points, from 120 (2021) to 80 (2023), down 40, 33%"
        in lines[2]
    )


def test_a_damaged_or_wrong_file_says_so(tmp_path):
    broken = tmp_path / "broken.xlsx"
    broken.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="damaged"):
        tables.load(broken)
    with pytest.raises(ValueError, match="CSV, TSV or Excel"):
        tables.load(tmp_path / "notes.docx")


# ── the tools ──


def test_the_tools_find_a_file_by_its_name_and_answer_in_words(sales, monkeypatch, tmp_path):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    tools = {t.name: t for t in spreadsheets.build_tools()}
    out = asyncio.run(tools["read_spreadsheet"].handler({"path": str(sales)}))
    assert out["content"][0]["text"].startswith("sales.csv:\n6 rows and 5 columns.")
    out = asyncio.run(tools["get_trend"].handler({"path": str(sales), "column": "returns"}))
    assert "Returns over Month" in out["content"][0]["text"]
    out = asyncio.run(tools["find_extremes"].handler({"path": str(sales), "column": "nope"}))
    assert out.get("is_error") and "The columns are" in out["content"][0]["text"]
    out = asyncio.run(tools["read_charts"].handler({"path": str(sales)}))
    assert "no charts" in out["content"][0]["text"]
    out = asyncio.run(tools["read_spreadsheet"].handler({"path": "/etc/passwd"}))
    assert out.get("is_error")
