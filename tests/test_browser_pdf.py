"""A PDF open in the built-in browser, read for JARVIS and Jarvis Code (browser_pdf.py): the
window's answer carries the file, its text comes back in place of the bytes, and reading on
doesn't send the file again. PDFs made here; no browser, no network."""

from __future__ import annotations

import base64
import hashlib

import pytest
from conftest import FakeClient

from jarvis import browser_agent, browser_pdf
from jarvis import hub as hub_module
from jarvis.code_tools import browser_tools
from jarvis.hub import Hub


def tiny_pdf(pages: list[str | None]) -> bytes:
    """A small real PDF: a page per entry, with that text (None: a page with no text)."""
    objs: list[bytes | None] = [b"<< /Type /Catalog /Pages 2 0 R >>", None]
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    kids = []
    for text in pages:
        words = (
            ""
            if text is None
            else text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        )
        stream = (
            f"BT /F1 18 Tf 72 720 Td ({words}) Tj ET" if text is not None else "0 0 m"
        ).encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content = len(objs)
        objs.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % content
        )
        kids.append(len(objs))
    refs = b" ".join(b"%d 0 R" % k for k in kids)
    objs[1] = b"<< /Type /Pages /Kids [" + refs + b"] /Count %d >>" % len(kids)
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def answer(data: bytes | None, *, sha: str | None = None, offset: int = 0, send: bool = True):
    """The window's answer to a read on a tab showing a PDF (app/browser-parity.js pdfRead)."""
    pdf = {"sha1": sha or hashlib.sha1(data or b"", usedforsecurity=False).hexdigest()}
    if send and data is not None:
        pdf["data"] = base64.b64encode(data).decode()
    return {
        "ok": True,
        "url": "https://bank.example/statement.pdf",
        "title": "statement.pdf",
        "tab": 4,
        "offset": offset,
        "pdf": pdf,
    }


@pytest.fixture(autouse=True)
def _forget_pdfs():
    browser_pdf._texts.clear()
    yield
    browser_pdf._texts.clear()  # no PDF text left for another test to see


async def test_a_page_s_answer_passes_through_untouched():
    page = {"ok": True, "url": "https://a.example/", "text": "Hello", "links": []}
    assert await browser_pdf.expand(page) is page
    failed = {"error": "The browser is empty."}
    assert await browser_pdf.expand(failed) is failed


async def test_a_pdf_reads_as_its_text_page_by_page_and_reads_on_without_the_file():
    data = tiny_pdf(["Quarterly statement", "Balance due: 1,204.50"])
    r = await browser_pdf.expand(answer(data))
    assert r["ok"] is True and "pdf" not in r
    assert r["text"] == "[Page 1]\nQuarterly statement\n\n[Page 2]\nBalance due: 1,204.50"
    assert r["offset"] == 0 and r["total"] == len(r["text"]) and r["more"] is False
    assert r["url"] == "https://bank.example/statement.pdf" and r["tab"] == 4
    sha = hashlib.sha1(data, usedforsecurity=False).hexdigest()
    assert browser_pdf.ask({"rich": True, "offset": 30})["pdfKnown"] == [sha]
    # Reading on: the window sends no bytes for a PDF whose text is kept.
    later = await browser_pdf.expand(answer(data, offset=10, send=False))
    assert later["text"] == r["text"][10:] and later["offset"] == 10


async def test_a_long_pdf_reads_in_parts_as_a_page_does():
    data = tiny_pdf([f"Section {n} " + "word " * 10 for n in range(40)])
    first = await browser_pdf.expand(answer(data), limit=500)
    assert len(first["text"]) == 500 and first["more"] is True
    text = browser_agent.read_text(first)
    assert f"More: browser_read with offset {500}." in text
    assert browser_agent.UNTRUSTED in text, "a PDF's words are marked as untrusted content"
    tail = await browser_pdf.expand(answer(data, offset=first["total"] - 20, send=False))
    assert tail["more"] is False and len(tail["text"]) == 20


async def test_only_the_last_few_pdfs_are_kept():
    shas = []
    for n in range(browser_pdf.KEEP + 2):
        data = tiny_pdf([f"Document {n}"])
        shas.append(hashlib.sha1(data, usedforsecurity=False).hexdigest())
        await browser_pdf.expand(answer(data))
    assert browser_pdf.ask({})["pdfKnown"] == shas[-browser_pdf.KEEP :]
    gone = await browser_pdf.expand(answer(None, sha=shas[0], send=False))
    assert gone["ok"] is False and "call browser_read once more" in gone["message"]


async def test_a_scan_a_damaged_file_or_a_garbled_transfer_says_so():
    scan = await browser_pdf.expand(answer(tiny_pdf([None, None])))
    assert scan["ok"] is True and "no text to read" in scan["text"]
    broken = await browser_pdf.expand(answer(b"%PDF-1.4 not really a pdf"))
    assert broken["ok"] is False and "couldn't be read" in broken["message"]
    garbled = answer(tiny_pdf(["x"]))
    garbled["pdf"]["data"] = "***not base64***"
    assert "didn't arrive whole" in (await browser_pdf.expand(garbled))["message"]
    swapped = answer(tiny_pdf(["x"]), sha="0" * 40)
    assert "didn't arrive whole" in (await browser_pdf.expand(swapped))["message"]
    huge = answer(b"")
    huge["pdf"]["data"] = "A" * (browser_pdf.PDF_MAX_BYTES * 2)
    assert "too big" in (await browser_pdf.expand(huge))["message"]
    assert browser_pdf.ask({})["pdfKnown"] == [
        hashlib.sha1(tiny_pdf([None, None]), usedforsecurity=False).hexdigest()
    ]


async def test_jarvis_code_reads_a_pdf_through_its_browser_read():
    data = tiny_pdf(["API reference"])
    asked = []

    async def call(action, args=None):
        asked.append((action, args))
        return answer(data)

    tools = {t.name: t.handler for t in browser_tools(call)}
    out = await tools["browser_read"]({})
    assert "API reference" in out["content"][0]["text"]
    assert asked[0][1]["pdfKnown"] == [] and asked[0][1]["rich"] is True


async def test_jarvis_reads_a_pdf_through_the_hub_s_browser_read(
    settings, quiet_speaker, isolated, monkeypatch
):
    seen = {}
    real = hub_module.create_sdk_mcp_server

    def capture(name, version, tools):
        seen[name] = {t.name: t.handler for t in tools}
        return real(name=name, version=version, tools=tools)

    monkeypatch.setattr(hub_module, "create_sdk_mcp_server", capture)
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    data = tiny_pdf(["Lease agreement", "Rent is due on the first"])
    asked = []

    async def browser_call(action, args=None):
        asked.append((action, args))
        return answer(data, offset=args.get("offset", 0), send=data is not None)

    monkeypatch.setattr(hub, "browser_call", browser_call)
    hub._browser_server()
    out = await seen["browser"]["browser_read"]({})
    text = out["content"][0]["text"]
    assert "Rent is due on the first" in text and browser_agent.UNTRUSTED in text
    assert asked[0][0] == "read" and asked[0][1]["pdfKnown"] == []
    again = await seen["browser"]["browser_read"]({"offset": 5})
    assert asked[1][1]["pdfKnown"] == [hashlib.sha1(data, usedforsecurity=False).hexdigest()]
    assert "agreement" in again["content"][0]["text"]
