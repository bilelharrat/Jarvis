"""A PDF open in the built-in browser, read for JARVIS and Eden Code (browser_read).

The app fetches the PDF through the tab's own session, so one behind a sign-in reads too
(app/browser-parity.js pdfRead), and sends its bytes with the read's answer. Its words come
out here with pypdf, off the event loop; the last few PDFs' text is kept, and the app is
told which (ask), so reading on with an offset doesn't send or read the file again.

What a PDF says is untrusted content, like a page's: browser_agent.read_text marks it so.

Cost policy: no model calls here; the text is extracted on this Mac.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import logging
from collections import OrderedDict
from typing import Any

log = logging.getLogger(__name__)

PDF_MAX_BYTES = 25 * 1024 * 1024  # the app refuses bigger ones before sending
PAGES_MAX = 400
TEXT_MAX = 2_000_000
KEEP = 4  # PDFs whose text is kept for reading on
READ_LIMIT = 20000  # characters per read, as for a page (browser_agent.READ_LIMIT)

_texts: OrderedDict[str, str] = OrderedDict()  # sha1 of the file -> its text (or NO_TEXT)
NO_TEXT = "(This PDF has no text to read: its pages are pictures, such as a scan.)"


def ask(request: dict[str, Any]) -> dict[str, Any]:
    """browser_read's ask of the window, with the PDFs whose text is kept here: for one of
    those the app sends no bytes again."""
    return {**request, "pdfKnown": list(_texts)}


def extract(data: bytes) -> str:
    """A PDF's words, page by page ([Page 3] before each)."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("the PDF needs a password")
    parts: list[str] = []
    size = 0
    for number, page in enumerate(reader.pages[:PAGES_MAX], 1):
        text = (page.extract_text() or "").strip()
        parts.append(f"[Page {number}]\n{text}")
        size += len(text)
        if size > TEXT_MAX:
            break
    return "\n\n".join(parts)[:TEXT_MAX]


def _text_of(raw: str, sha: str) -> str | None:
    """The text of the PDF sent as raw (base64), NO_TEXT for one with no words on its pages,
    or None when it didn't arrive whole. Run in a thread, all of it: 25 MB takes a while to
    decode and hash, and that's once a file, not once a read. Raises what extract raises."""
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        return None
    if hashlib.sha1(data, usedforsecurity=False).hexdigest() != sha:  # the file's name here
        return None
    text = extract(data)
    words = "".join(line for line in text.splitlines() if not line.startswith("[Page "))
    return text if words.strip() else NO_TEXT


def _failed(r: dict[str, Any], message: str) -> dict[str, Any]:
    out = {k: v for k, v in r.items() if k != "pdf"}
    return {**out, "ok": False, "message": message}


async def expand(r: dict[str, Any], limit: int = READ_LIMIT) -> dict[str, Any]:
    """The window's answer to a read, with a PDF's text in place of its bytes (any other
    answer as it is): the part from the read's offset, as a page's text would be."""
    pdf = r.get("pdf")
    if not isinstance(pdf, dict):
        return r
    sha = str(pdf.get("sha1") or "")
    text = _texts.get(sha)
    if text is None:
        raw = pdf.get("data")
        if not isinstance(raw, str):  # its text was let go meanwhile
            return _failed(r, "The PDF has to be read again: call browser_read once more.")
        if len(raw) > PDF_MAX_BYTES * 4 // 3 + 4:
            return _failed(r, "This PDF is too big to read (over 25 MB).")
        try:
            text = await asyncio.to_thread(_text_of, raw, sha)
        except Exception as err:  # a damaged file, a password, pypdf's own limits
            log.info("browser pdf: unreadable (%s)", type(err).__name__)
            return _failed(
                r, "This PDF couldn't be read: it may be damaged, or locked with a password."
            )
        if text is None:
            return _failed(r, "The PDF didn't arrive whole. Try reading it again.")
        _texts[sha] = text
        while len(_texts) > KEEP:
            _texts.popitem(last=False)
    _texts.move_to_end(sha)
    try:
        offset = max(0, int(r.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    piece = text[offset : offset + limit]
    out = {k: v for k, v in r.items() if k != "pdf"}
    out.update(
        text=piece,
        offset=offset,
        total=len(text),
        more=offset + len(piece) < len(text),
        actions=[],
    )
    return out
