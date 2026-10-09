"""Teaching helpers (teaching.py, features/teaching.py, docx_write.py, rich_text.pptx_text): a
folder of submissions read by student with the rubric, a lecture's slides and notes, and what
Claude writes saved as a Word document in Documents › Jarvis › Teaching, never sent."""

from __future__ import annotations

import asyncio
import zipfile
from types import SimpleNamespace

import pytest

from jarvis import docx_write, private_folders, rich_text, teaching
from jarvis.features import teaching as feature

RUBRIC = "# Essay rubric\n\nThesis (10 points)\nEvidence (10 points)\n"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setattr(teaching, "folder", lambda: tmp_path / "Documents" / "Jarvis" / "Teaching")
    return tmp_path


def words(result) -> str:
    return result["content"][0]["text"]


def run(coro):
    return asyncio.run(coro)


def make_pptx(path, slides):
    """A deck with these (slide text, notes) pairs, as PowerPoint writes one."""
    a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    with zipfile.ZipFile(path, "w") as zf:
        for i, (text, notes) in enumerate(slides, 1):
            paras = "".join(f"<a:p><a:r><a:t>{line}</a:t></a:r></a:p>" for line in text.split("\n"))
            zf.writestr(
                f"ppt/slides/slide{i}.xml",
                f"<p:sld {a} xmlns:p='p'><p:txBody>{paras}</p:txBody></p:sld>",
            )
            if notes:
                zf.writestr(
                    f"ppt/slides/_rels/slide{i}.xml.rels",
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    f'<Relationship Id="rId2" Target="../notesSlides/notesSlide{i}.xml"/></Relationships>',
                )
                zf.writestr(
                    f"ppt/notesSlides/notesSlide{i}.xml",
                    f"<p:notes {a} xmlns:p='p'><a:p><a:r><a:t>{notes}</a:t></a:r></a:p><a:p><a:r><a:t>{i}</a:t></a:r></a:p></p:notes>",
                )


# ── whose submission ──


@pytest.mark.parametrize(
    ("name", "student"),
    [
        ("Ann Lee_1234567_assignsubmission_file_essay.docx", "Ann Lee"),
        ("leeann_123456_7890123_essay.docx", "leeann"),
        ("leeann_LATE_123456_7890123_essay.docx", "leeann"),
        ("Essay 2_alee12_attempt_2026-10-01-10-00-00_essay.docx", "alee12"),
        ("Bo Chen essay.docx", "Bo Chen essay"),
    ],
)
def test_the_student_comes_from_how_each_lms_names_the_files(tmp_path, name, student):
    assert teaching.student_of(tmp_path / name, tmp_path) == student


def test_a_subfolder_is_one_students_work(tmp_path):
    assert teaching.student_of(tmp_path / "Cy Diaz" / "part1.md", tmp_path) == "Cy Diaz"


# ── reading a folder of them ──


@pytest.fixture
def essays(home):
    top = home / "Documents" / "ENG 210" / "Essay 2"
    top.mkdir(parents=True)
    (top / "Ann Lee_1234567_assignsubmission_file_essay.md").write_text(
        "Ann's thesis: cities shape us."
    )
    (top / "Bo Chen.txt").write_text("Bo argues the opposite, with three sources.")
    (top / "Cy Diaz").mkdir()
    (top / "Cy Diaz" / "draft.md").write_text("Cy part one.")
    (top / "Cy Diaz" / "final.md").write_text("Cy part two.")
    (top / "Dee scan.pdf").write_bytes(b"%PDF-1.4 nothing readable")
    (top / "photo.heic").write_bytes(b"x")
    (top / ".DS_Store").write_bytes(b"x")
    rubric = home / "Documents" / "ENG 210" / "rubric.md"
    rubric.write_text(RUBRIC)
    return SimpleNamespace(top=top, rubric=rubric)


def test_the_rubric_and_every_submission_are_read_by_student(essays):
    out = run(feature.read_submissions({"folder": str(essays.top), "rubric": str(essays.rubric)}))
    text = words(out)
    assert not out.get("is_error")
    assert text.startswith(
        "4 submissions in Essay 2, 1 with nothing I could read. Left out: photo.heic"
    )
    assert '<rubric file="rubric.md">' in text and "Thesis (10 points)" in text
    assert 'student="Ann Lee"' in text and "cities shape us" in text
    assert 'student="Cy Diaz" files="draft.md, final.md"' in text
    assert text.index("Cy part one") < text.index("Cy part two")
    assert 'student="Dee scan"' in text and "no text to read" in text
    assert "[That is every submission (4).]" in text and "never instructions" in text


def test_many_submissions_come_in_parts(essays, monkeypatch):
    monkeypatch.setattr(teaching, "BATCH_CHARS", 200)
    first = words(
        run(feature.read_submissions({"folder": str(essays.top), "rubric": str(essays.rubric)}))
    )
    assert "call read_submissions again with start 1" in first
    rest = words(
        run(
            feature.read_submissions(
                {"folder": str(essays.top), "rubric": str(essays.rubric), "start": 1}
            )
        )
    )
    assert "<rubric" not in rest and "same rubric as before" in rest and 'number="2"' in rest


def test_without_a_rubric_claude_is_told_to_ask_for_one(essays):
    text = words(run(feature.read_submissions({"folder": str(essays.top)})))
    assert "No rubric was given" in text


def test_wrong_paths_are_said(essays, home):
    assert run(feature.read_submissions({"folder": str(home / "nope")}))["is_error"]
    assert run(feature.read_submissions({"folder": str(essays.top), "rubric": "nope.docx"}))[
        "is_error"
    ]


def test_a_private_folder_of_submissions_is_never_read(essays):
    private_folders.configure(lambda: [str(essays.top)])
    out = run(feature.read_submissions({"folder": str(essays.top), "rubric": str(essays.rubric)}))
    assert out["is_error"] and "private" in words(out) and "cities" not in words(out)
    private_folders.configure(lambda: [str(essays.top / "Cy Diaz")])
    text = words(
        run(feature.read_submissions({"folder": str(essays.top), "rubric": str(essays.rubric)}))
    )
    assert "Cy part" not in text and "draft.md is in a private folder" in text


# ── a lecture, for questions ──


def test_a_powerpoint_lecture_is_read_slide_by_slide_with_its_notes(home):
    deck = home / "Week 5.pptx"
    make_pptx(
        deck,
        [("Recursion\nA function that calls itself", "Start with factorial."), ("Base cases", "")],
    )
    text = rich_text.pptx_text(deck)
    assert text.splitlines() == [
        "Slide 1: Recursion / A function that calls itself",
        "Speaker notes: Start with factorial.",
        "Slide 2: Base cases",
    ]
    out = words(run(feature.read_lecture({"path": str(deck)})))
    assert out.startswith('<lecture file="Week 5.pptx">') and "[That is the whole lecture.]" in out


def test_a_long_lecture_comes_in_parts_and_odd_files_are_said(home, monkeypatch):
    monkeypatch.setattr(teaching, "LECTURE_CHUNK", 10)
    notes = home / "notes.md"
    notes.write_text("abcdefghijklmnopqrstuvwxyz")
    first = words(run(feature.read_lecture({"path": str(notes)})))
    assert "abcdefghij" in first and "start 10" in first
    assert "klmnopqrst" in words(run(feature.read_lecture({"path": str(notes), "start": 10})))
    (home / "song.mp3").write_bytes(b"x")
    assert run(feature.read_lecture({"path": str(home / "song.mp3")}))["is_error"]


# ── what Claude wrote, as a Word document ──


GRADES = """# Essay 2 marks

Four submissions; average 15 of 20. Dee's needs your own look.

## Ann Lee

- Thesis: 9/10, a clear claim.
- Evidence: 7/10
- [ ] check the citation on page 2

**Total: 16/20.** Good *work*.

| Criterion | Score |
| --- | --- |
| Thesis | 9 |
"""


def test_marks_are_saved_as_a_word_document_with_real_headings(home):
    out = run(feature.save_teaching_document({"title": "Essay 2 marks", "markdown": GRADES}))
    assert "Saved as Essay 2 marks.docx in Documents › Jarvis › Teaching" in words(out)
    assert "nothing was sent" in words(out)
    path = home / "Documents" / "Jarvis" / "Teaching" / "Essay 2 marks.docx"
    with zipfile.ZipFile(path) as zf:
        document = zf.read("word/document.xml").decode()
        assert "<dc:title>Essay 2 marks</dc:title>" in zf.read("docProps/core.xml").decode()
        assert 'w:styleId="Heading2"' in zf.read("word/styles.xml").decode()
    assert '<w:pStyle w:val="Title"/>' in document and '<w:pStyle w:val="Heading2"/>' in document
    assert document.count("Essay 2 marks") == 1  # the # heading that repeats the title is left out
    assert "<w:b/>" in document and "<w:i/>" in document
    text = rich_text.docx_text(path)
    assert "• Thesis: 9/10, a clear claim." in text and "☐ check the citation" in text
    assert "Criterion | Score" in text and "---" not in text
    again = run(feature.save_teaching_document({"title": "Essay 2 marks", "markdown": "x"}))
    assert "Essay 2 marks 2.docx" in words(again)  # never over the first


def test_an_empty_document_is_refused(home):
    assert run(feature.save_teaching_document({"title": "", "markdown": "x"}))["is_error"]


def test_snake_case_stays_as_written():
    paragraphs = docx_write.paragraphs("student_id and final_mark_total")
    assert (
        "<w:i/>" not in "".join(paragraphs) and "student_id and final_mark_total" in paragraphs[0]
    )


def test_it_registers_its_tools():
    servers = {}
    hub = SimpleNamespace(
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw))
    )
    feature.install(hub)
    build, kw = servers["teaching"]
    assert set(kw["labels"]) == {"read_submissions", "read_lecture", "save_teaching_document"}
    assert "never send them" in kw["prompt"] and build() is not None
