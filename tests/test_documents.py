"""Documents JARVIS writes and remembers. A temp home folder (HOME points at it), a fake
converter and opener; one test runs macOS's own textutil into the temp folder."""

import asyncio
import json
import shutil
import zipfile
from datetime import datetime

import pytest

from jarvis import documents as docs
from jarvis.documents import DocumentStore, claim, file_stem, markdown_html, markdown_text

NOW = datetime(2026, 9, 29, 10, 0)
MEMO = """# Q3 plan

To: the team

We ship the **new desk** on *Friday*. Details at [the wiki](https://example.com/wiki).

- Priya: pricing
- Bob: launch notes
  - with legal

1. Draft
2. Review

> Keep it short.

| Who | What |
| --- | --- |
| Ann | Budget |
"""


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


class Fakes:
    def __init__(self):
        self.converted = []
        self.opened = []

    def convert(self, source, fmt, out):
        self.converted.append((source.read_text(), fmt))
        out.write_bytes(f"{fmt}:".encode() + source.read_bytes()[:50])

    def extract(self, path):
        return "The memo text. " + path.read_bytes().decode(errors="replace")

    def open(self, path):
        self.opened.append(path)


@pytest.fixture
def fakes():
    return Fakes()


@pytest.fixture
def store(home, fakes):
    return DocumentStore(
        home / "state" / "documents.json",
        convert=fakes.convert,
        extract=fakes.extract,
        opener=fakes.open,
        now=lambda: NOW,
    )


# ── Markdown ──


def test_markdown_html():
    page = markdown_html(MEMO, "Q3 plan")
    assert "<h1>Q3 plan</h1>" in page and "<title>Q3 plan</title>" in page
    assert "<b>new desk</b>" in page and "<i>Friday</i>" in page
    assert '<a href="https://example.com/wiki">the wiki</a>' in page
    assert page.count("<ul>") == 2 and "<ol>" in page and "<li>with legal</li>" in page
    assert "<blockquote>" in page and "<th>Who</th>" in page and "<td>Budget</td>" in page


def test_markdown_html_escapes_the_words():
    page = markdown_html("Hello <script>alert(1)</script> & [x](javascript:alert(1))")
    assert "<script>" not in page and "&lt;script&gt;" in page
    assert "javascript:" not in page.split("<body>")[1].replace("[x](javascript:", "")


def test_markdown_text():
    text = markdown_text(MEMO)
    assert text.startswith("Q3 plan\n")
    assert "new desk" in text and "**" not in text and "• Priya: pricing" in text
    assert "the wiki (https://example.com/wiki)" in text


def test_file_stem_and_claim(tmp_path):
    assert file_stem("Q3/Q4: plan?") == "Q3-Q4- plan"
    assert file_stem("../../etc") == "etc"
    assert file_stem("") == "Untitled"
    first = claim(tmp_path, "Memo", ".docx")
    second = claim(tmp_path, "Memo", ".docx")
    assert (first.name, second.name) == ("Memo.docx", "Memo 2.docx")


# ── writing ──


def test_write_word_by_default(store, fakes, home):
    record = store.write("Team memo", MEMO)
    path = home / "Documents" / "JARVIS" / "Team memo.docx"
    assert record.path == str(path) and path.read_bytes().startswith(b"docx:")
    assert fakes.converted[0][1] == "docx" and "<h1>Q3 plan</h1>" in fakes.converted[0][0]
    assert record.gist.startswith("Q3 plan")
    assert not list(path.parent.glob(".jarvis-*"))  # the temp folder is gone


@pytest.mark.parametrize(
    "fmt, ext, converted",
    [
        ("pages", ".docx", True),
        ("word", ".docx", True),
        ("rtf", ".rtf", True),
        ("odt", ".odt", True),
        ("md", ".md", False),
        ("txt", ".txt", False),
        ("html", ".html", False),
    ],
)
def test_formats(store, fakes, fmt, ext, converted):
    record = store.write("Letter", MEMO, fmt)
    assert record.path.endswith(ext)
    assert bool(fakes.converted) == converted


def test_never_overwrites(store, home):
    folder = home / "Documents" / "JARVIS"
    folder.mkdir(parents=True)
    (folder / "Memo.md").write_text("the owner's own")
    record = store.write("Memo", "new text", "md")
    assert record.path.endswith("Memo 2.md")
    assert (folder / "Memo.md").read_text() == "the owner's own"


def test_a_failed_conversion_leaves_nothing(store, fakes, home):
    def broken(source, fmt, out):
        raise RuntimeError("textutil failed")

    store._convert = broken
    with pytest.raises(ValueError, match="couldn't make"):
        store.write("Memo", MEMO)
    assert not list((home / "Documents" / "JARVIS").iterdir())
    assert store.recent == []


def test_folders(store, home):
    (home / "Projects").mkdir()
    assert store.write("A", "x", "md", folder="~/Projects").path == str(home / "Projects" / "A.md")
    with pytest.raises(ValueError, match="home folder"):
        store.write("A", "x", "md", folder="/tmp")
    with pytest.raises(ValueError, match="Library"):
        store.write("A", "x", "md", folder="~/Library/Preferences")
    with pytest.raises(ValueError):
        store.write("A", "x", "md", folder="~/.ssh")
    icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    icloud.mkdir(parents=True)
    assert store.write("A", "x", "md", folder=str(icloud)).path.startswith(str(icloud))


def test_bad_input(store):
    with pytest.raises(ValueError, match="empty"):
        store.write("A", "   ")
    with pytest.raises(ValueError, match="format"):
        store.write("A", "x", "pdf")
    with pytest.raises(ValueError, match="too long"):
        store.write("A", "x" * (docs.MAX_BODY + 1))


# ── remembering across sessions ──


def test_recent_documents_survive_a_restart(store, home, fakes):
    store.write("Team memo", MEMO, gist="Q3 plan for the team")
    again = DocumentStore(home / "state" / "documents.json", extract=fakes.extract)
    assert again.recent[0].title == "Team memo"
    block = again.prompt_block()
    assert "wrote “Team memo” (docx)" in block and "Q3 plan for the team" in block
    assert again.find("the memo from yesterday").title == "Team memo"


def test_read_back_to_continue(store, home):
    written = store.write("Team memo", MEMO, "md")
    record, text = store.read("Team memo")
    assert record.path == written.path and text.startswith("# Q3 plan")
    assert record.action == "wrote"  # still the one it wrote
    newer = store.write("Team memo", MEMO + "\nMore.", "md", based_on=written.path)
    assert newer.path.endswith("Team memo 2.md") and newer.based_on == written.path
    assert [r.title for r in store.recent] == ["Team memo", "Team memo"]


def test_read_other_documents(store, home):
    (home / "Documents").mkdir(exist_ok=True)
    letter = home / "Documents" / "Letter.docx"
    letter.write_bytes(b"docx bytes")
    record, text = store.read(str(letter))
    assert record.action == "read" and text.startswith("The memo text.")
    with pytest.raises(ValueError, match="home folder"):
        store.read("/etc/hosts")
    (home / ".aws").mkdir()
    (home / ".aws" / "credentials.txt").write_text("secret")
    with pytest.raises(ValueError):
        store.read(str(home / ".aws" / "credentials.txt"))
    (home / "photo.png").write_bytes(b"png")
    with pytest.raises(ValueError, match="can read"):
        store.read(str(home / "photo.png"))
    with pytest.raises(ValueError, match="isn't there"):
        store.read(str(home / "gone.md"))


def test_recent_is_capped(store):
    for i in range(docs.MAX_RECENT + 5):
        store.write(f"Doc {i}", "x", "txt")
    assert len(store.recent) == docs.MAX_RECENT
    assert store.recent[0].title == f"Doc {docs.MAX_RECENT + 4}"
    data = json.loads(store.path.read_text())
    assert len(data) == docs.MAX_RECENT


def test_open_only_known_documents(store, fakes, home):
    record = store.write("Memo", "x", "md")
    store.open("Memo")
    assert fakes.opened == [record.path and home / "Documents" / "JARVIS" / "Memo.md"]
    (home / "elsewhere.txt").write_text("hi")
    with pytest.raises(ValueError, match="only open"):
        store.open(str(home / "elsewhere.txt"))


def test_damaged_list_is_kept_aside(home, fakes):
    path = home / "state" / "documents.json"
    path.parent.mkdir(parents=True)
    path.write_text("{oops")
    store = DocumentStore(path, convert=fakes.convert, now=lambda: NOW)
    assert store.recent == []
    store.write("Memo", "x", "md")
    assert list(path.parent.glob("documents.json.bad-*"))


# ── tools ──


def test_tools(store, fakes):
    asked = []

    async def gate(action, question):
        asked.append((action, question))
        return True

    tools = {t.name: t.handler for t in docs.build_tools(store, gate)}
    out = asyncio.run(
        tools["write_document"](
            {"title": "Cover letter", "markdown": "Dear Ann,", "format": "pages", "open": True}
        )
    )
    reply = out["content"][0]["text"]
    assert "Saved “Cover letter” as ~/Documents/JARVIS/Cover letter.docx" in reply
    assert "Pages opens it" in reply and "It's open" in reply
    assert asked[0] == ("write_document", "Save a document “Cover letter” in ~/Documents/JARVIS?")
    listed = asyncio.run(tools["recent_documents"]({}))
    assert "Cover letter" in listed["content"][0]["text"]
    read = asyncio.run(tools["read_document"]({"path": "cover letter"}))
    assert "<document>" in read["content"][0]["text"]


def test_tools_respect_a_no(store):
    async def no(_action, _question):
        return False

    tools = {t.name: t.handler for t in docs.build_tools(store, no)}
    out = asyncio.run(tools["write_document"]({"title": "X", "markdown": "y"}))
    assert out.get("is_error") and store.recent == []


@pytest.mark.skipif(shutil.which("textutil") is None, reason="macOS textutil")
def test_real_textutil_makes_a_word_file(home):
    store = DocumentStore(home / "state" / "documents.json", now=lambda: NOW)
    record = store.write("Team memo", MEMO)
    with zipfile.ZipFile(record.path) as z:
        xml = z.read("word/document.xml").decode()
    assert "new desk" in xml and "Priya" in xml
    _, text = store.read(record.path)
    assert "new desk" in text
    rtf = store.write("Team memo", MEMO, "rtf")
    assert open(rtf.path, "rb").read(5) == b"{\\rtf"


def test_mentions_a_meeting(store):
    store.write("Budget review prep", "Notes for the budget review.", "md")
    assert store.mentions("Budget review")
    assert not store.mentions("Hiring sync")
