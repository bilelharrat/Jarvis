"""No source file hides characters. Bidi overrides, zero widths and other invisible
characters are written as escapes (\\u200b), so what a reviewer reads is what runs: source
that hides its characters is how a "Trojan Source" change slips through review."""

import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".html", ".css", ".json", ".sh", ".toml", ".md"}
SKIP = {"node_modules", "__pycache__", ".venv", "dist", "build", ".git"}


def _hidden(c: str) -> bool:
    kind = unicodedata.category(c)
    return kind in ("Cf", "Co", "Cs", "Cn", "Zl", "Zp") or (kind == "Cc" and c not in "\t\n\r")


def _sources():
    for top in ("src", "tests", "scripts"):
        for path in (ROOT / top).rglob("*"):
            if path.suffix in SUFFIXES and not SKIP.intersection(path.parts) and path.is_file():
                yield path
    yield from (p for p in (ROOT / "app").glob("*") if p.suffix in SUFFIXES and p.is_file())


def test_no_source_file_hides_characters():
    found = []
    for path in _sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            chars = [f"U+{ord(c):04X}" for c in line if _hidden(c)]
            if chars:
                found.append(f"{path.relative_to(ROOT)}:{n}: {', '.join(chars[:5])}")
    assert not found, "write these as escapes:\n" + "\n".join(found[:40])
