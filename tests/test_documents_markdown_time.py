"""A document's Markdown becomes HTML and plain text in time in proportion to its length,
whatever never closes, and writing one never holds up the event loop; what it becomes is
what it was. No textutil: .html and .txt only, into a temp folder."""

from __future__ import annotations

import asyncio
import time

from jarvis import documents
from jarvis.documents import MAX_BODY, DocumentStore, markdown_html, markdown_text

SECONDS = 0.25  # 20,000 characters: a few milliseconds when it's linear
N = 20_000

HOSTILE = {  # each was quadratic in its length, the heading cubic
    "spaces mid-heading": "# a" + " " * N + "x",
    "links whose address never closes": "[a](http://" * (N // 11),
    "brackets before one address": "[" * (N // 2) + "a](http://" + "x" * (N // 2),
    "spaces before a table's separator?": "| a | b |\n" + " " * N + "-x",
    "spaces after a table's separator?": "| a | b |\n|---|---" + " " * N + "x",
    "underscores after bold": "**" + "_a " * (N // 3),
    "every mark at once": "*a [b _c `d **e #f |g " * (N // 22),
}


def slow(fn, texts: dict[str, str]) -> list[str]:
    out = []
    for name, text in texts.items():
        started = time.monotonic()
        fn(text)
        took = time.monotonic() - started
        if took >= SECONDS:
            out.append(f"{name} ({len(text)} characters): {took:.2f}s")
    return out


def test_markdown_takes_time_in_proportion_to_its_length():
    assert not slow(markdown_html, HOSTILE)
    assert not slow(markdown_text, HOSTILE)


async def test_writing_a_long_hostile_document_never_holds_up_the_event_loop(tmp_path):
    store = DocumentStore(tmp_path / "documents.json", folder=tmp_path / "out")
    body = "# a" + " " * 2000 + "x\n" + ("*a [b _c " * 2000 + "\n") * 10
    assert len(body) <= MAX_BODY
    gaps: list[float] = []
    done = False

    async def tick():
        last = time.monotonic()
        while not done:
            await asyncio.sleep(0.005)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    ticker = asyncio.create_task(tick())
    for fmt in ("html", "txt"):
        await asyncio.to_thread(store.write, f"Long {fmt}", body, fmt)
    done = True
    await ticker
    assert max(gaps) < SECONDS, f"the loop waited {max(gaps):.2f}s"


def test_what_markdown_becomes_is_what_it_was():
    page = markdown_html(
        "## Plan ##\n"
        "See [a [b](https://x.test/q) and *one*, _two_, snake_case_name, 2*3*4 and *a**b*.\n"
        "[no](javascript:alert(1)) [mail](mailto:ann@example.com) [x](http://a b)\n"
        "| A | B |\n| :-- | --: |\n| 1 | 2 |"
    )
    assert "<h2>Plan</h2>" in page
    assert '<a href="https://x.test/q">a [b</a>' in page
    assert "<i>one</i>, <i>two</i>, snake_case_name, 2*3*4 and <i>a</i>*b*." in page
    assert "[no](javascript:alert(1))" in page and "[x](http://a b)" in page
    assert '<a href="mailto:ann@example.com">mail</a>' in page
    assert "<th>A</th><th>B</th>" in page and "<td>2</td>" in page
    text = markdown_text("# Title #\n|---|---|\nA *b* _c_ [d](e) [f](g h) `i`\n---")
    assert text == "Title\nA b _c_ d (e) [f](g h) i\n"
    assert documents._heading("####### seven") is None and documents._heading("#tag") is None
    assert documents._table_sep(" | :--: |---: ") and not documents._table_sep("|| --- |")
