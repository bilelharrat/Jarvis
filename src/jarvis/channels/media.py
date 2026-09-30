"""What comes with a chat message, made ready for a request, and the files JARVIS made
that it may send back.

Voice notes are transcribed on this Mac by JARVIS's own Whisper model (hub.transcriber):
no model call and nothing leaves the Mac. Pictures and PDFs go to Claude as attachments,
text files as their text; a picture's type is read from its bytes, not from what the chat
app said. The only files JARVIS sends back are ones it made itself: documents it wrote,
invoices, research reports."""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

SAMPLE_RATE = 16_000
MAX_VOICE_SECONDS = 300
MAX_VOICE_BYTES = 25_000_000
MAX_IMAGE_BYTES = 5_000_000  # what Claude takes for one picture
MAX_CONVERT_BYTES = 30_000_000  # a HEIC photo before it's made a JPEG
MAX_PDF_BYTES = 10_000_000
MAX_TEXT_BYTES = 300_000
MAX_TEXT_CHARS = 120_000
IMAGE_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
CONVERT_TYPES = ("image/heic", "image/heif", "image/tiff", "image/bmp")
CONVERT_SUFFIXES = (".heic", ".heif", ".tif", ".tiff", ".bmp")
TEXT_TYPES = (
    "application/json", "application/xml", "application/javascript", "application/x-yaml",
    "application/yaml", "application/toml", "application/x-sh", "application/sql",
    "application/csv",
)  # fmt: skip
TEXT_SUFFIXES = (
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".toml",
    ".py", ".js", ".ts", ".swift", ".html", ".css", ".sh", ".sql", ".log", ".ini", ".rtf",
)  # fmt: skip


class Unsupported(Exception):
    """Not something JARVIS can read."""


class TooLong(Exception):
    """A voice note past MAX_VOICE_SECONDS."""


def classify(media_type: str, name: str) -> str | None:
    """image, convert (a picture Claude can't take as it is), pdf, text, or None."""
    media_type = (media_type or "").split(";")[0].strip().lower()
    suffix = Path(name or "").suffix.lower()
    if media_type in IMAGE_TYPES:
        return "image"
    if media_type in CONVERT_TYPES or suffix in CONVERT_SUFFIXES:
        return "convert"
    if media_type == "application/pdf" or suffix == ".pdf":
        return "pdf"
    if media_type.startswith("text/") or media_type in TEXT_TYPES or suffix in TEXT_SUFFIXES:
        return "text"
    if media_type.startswith("image/") or suffix in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        return "image"  # its bytes decide below
    return None


def limit_for(kind: str) -> int:
    return {
        "image": MAX_IMAGE_BYTES,
        "convert": MAX_CONVERT_BYTES,
        "pdf": MAX_PDF_BYTES,
        "text": MAX_TEXT_BYTES,
    }.get(kind, 0)


def sniff_image(data: bytes) -> str | None:
    """A picture's real type, from its first bytes."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def attachment(
    kind: str, data: bytes, name: str, convert: Callable[[bytes], bytes] | None = None
) -> dict[str, str]:
    """{media_type, data, name} as a request takes it: base64 for a picture or a PDF, the
    text itself for a text file. Unsupported when it isn't what it says it is."""
    from ..textclean import clean_text

    if kind == "convert":
        if convert is None:
            raise Unsupported("no converter")
        data, kind = convert(data), "image"
    if kind == "image":
        real = sniff_image(data)
        if real is None and convert is not None:
            data = convert(data)  # a HEIC photo sent as a file, say
            real = sniff_image(data)
        if real is None or len(data) > MAX_IMAGE_BYTES:
            raise Unsupported("not a picture Claude takes")
        return {"media_type": real, "data": base64.b64encode(data).decode("ascii"), "name": ""}
    if kind == "pdf":
        if not data.startswith(b"%PDF"):
            raise Unsupported("not a PDF")
        return {
            "media_type": "application/pdf",
            "data": base64.b64encode(data).decode("ascii"),
            "name": clean_text(name)[:200] or "document.pdf",
        }
    if kind == "text":
        if b"\x00" in data[:4096]:
            raise Unsupported("binary")
        text = clean_text(data.decode("utf-8", errors="replace"))[:MAX_TEXT_CHARS]
        return {"media_type": "text/plain", "data": text, "name": clean_text(name)[:200]}
    raise Unsupported(kind)


def heic_to_jpeg(data: bytes) -> bytes:
    """A picture Claude can't take (HEIC from an iPhone, TIFF) as a JPEG at most 2048 px
    across, by macOS's own sips. Unsupported when it can't be converted."""
    with tempfile.TemporaryDirectory(prefix="jarvis-chat-") as folder:
        src, out = Path(folder) / "in", Path(folder) / "out.jpg"
        src.write_bytes(data)
        try:
            done = subprocess.run(
                [
                    "/usr/bin/sips",
                    "-s",
                    "format",
                    "jpeg",
                    "-Z",
                    "2048",
                    str(src),
                    "--out",
                    str(out),
                ],
                capture_output=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise Unsupported("sips failed") from exc
        if done.returncode != 0 or not out.is_file():
            raise Unsupported("sips couldn't read it")
        return out.read_bytes()


def decode_voice(data: bytes, path: Path | None = None) -> Any:
    """A voice note as 16 kHz mono samples: WAV read directly, anything else (Telegram's
    OGG Opus, an iPhone's CAF) by Whisper's own decoder, and a file on this Mac that it
    can't read through macOS's afconvert."""
    from ..answering import decode_wav

    try:
        return decode_wav(data, SAMPLE_RATE)
    except Exception as first:
        if path is None or not path.is_file():
            raise Unsupported("can't decode the voice note") from first
    with tempfile.TemporaryDirectory(prefix="jarvis-voice-") as folder:
        wav = Path(folder) / "voice.wav"
        try:
            done = subprocess.run(
                ["/usr/bin/afconvert", "-f", "WAVE", "-d", f"LEI16@{SAMPLE_RATE}", "-c", "1",
                 str(path), str(wav)],
                capture_output=True,
                timeout=60,
            )  # fmt: skip
        except (OSError, subprocess.SubprocessError) as exc:
            raise Unsupported("afconvert failed") from exc
        if done.returncode != 0 or not wav.is_file():
            raise Unsupported("afconvert couldn't read it")
        return decode_wav(wav.read_bytes(), SAMPLE_RATE)


def transcribe(hub: Any, stt: Any, data: bytes, path: Path | None = None) -> str:
    """A voice note's words, by JARVIS's Whisper (run in a thread). "" for silence."""
    from ..textclean import clean_text

    audio = decode_voice(data, path)
    seconds = len(audio) / SAMPLE_RATE
    if seconds > MAX_VOICE_SECONDS + 5:
        raise TooLong(seconds)
    if seconds < 0.3:
        return ""
    own = getattr(hub, "_transcribe", None)  # with the words JARVIS learned the owner says
    text = own(stt, audio) if callable(own) else stt.transcribe(audio)
    return " ".join(clean_text(text or "").split())


def size_words(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.0f} MB"
    return f"{max(1, n // 1000)} KB"


# ── the files JARVIS made ──


@dataclass
class Made:
    path: Path
    title: str
    kind: str  # document | invoice | research


def made_files(hub: Any, research_dir: Path | None) -> list[Made]:
    """What JARVIS made that's still on disk, newest kinds first: documents it wrote,
    invoices it issued, research reports. Nothing else can be sent from here."""
    found: list[Made] = []
    for record in list(getattr(hub.documents, "recent", []))[:200]:
        if getattr(record, "action", "") == "wrote" and record.path:
            found.append(
                Made(Path(record.path), record.title or Path(record.path).stem, "document")
            )
    for invoice in list(getattr(hub.invoices, "invoices", []))[-200:]:
        if getattr(invoice, "path", ""):
            title = f"Invoice {invoice.number}" + (f" ({invoice.client})" if invoice.client else "")
            found.append(Made(Path(invoice.path), title, "invoice"))
    for task in list(hub.tasks.tasks.values()):
        if task.kind == "research" and task.report_path:
            found.append(Made(Path(task.report_path), task.prompt[:80], "research"))
    if research_dir is not None:
        try:
            reports = sorted(
                (p for p in research_dir.glob("*.md") if p.is_file()),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )[:60]
        except OSError:
            reports = []
        found += [Made(p, p.stem, "research") for p in reports]
    kept: dict[str, Made] = {}
    for item in found:
        try:
            real = item.path.expanduser().resolve()
            if not real.is_file():
                continue
        except (OSError, RuntimeError):
            continue
        kept.setdefault(str(real), Made(real, item.title, item.kind))
    return list(kept.values())


def find_made(files: list[Made], query: str) -> list[Made]:
    """The made files that fit what was asked for: its path, or words of its title or name."""
    query = " ".join(str(query or "").split())
    if not query:
        return []
    try:
        wanted = str(Path(query).expanduser().resolve())
    except (OSError, RuntimeError, ValueError):
        wanted = ""
    exact = [f for f in files if str(f.path) == wanted]
    if exact:
        return exact
    q = query.lower()
    named = [f for f in files if q in (f.title.lower(), f.path.name.lower(), f.path.stem.lower())]
    if named:
        return named
    words = q.split()
    return [f for f in files if all(w in f"{f.title} {f.path.name}".lower() for w in words)]


def file_size(path: Path) -> int:
    try:
        return os.stat(path).st_size
    except OSError:
        return -1
