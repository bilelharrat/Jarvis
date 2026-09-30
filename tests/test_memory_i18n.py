"""Every sentence the memory features' backend puts in the window has its Chinese: what a
refusal says (a Settings change it can't make comes back as an error), an import's notes and
the person card's "couldn't read" have theirs in web/i18n/memory.json, merged over
i18n-zh.json; toasts and heads-ups go through lang (lang.add_texts). The sentences are read
from the modules' own source, so a new one without its Chinese fails here."""

import ast
import re
from pathlib import Path

import pytest

from jarvis import lang, memory
from jarvis.features import memory as feature
from jarvis.server import zh_strings

SRC = Path(feature.__file__).parent.parent
MODULES = (
    "memory.py",
    "intents.py",
    "commitments.py",
    "memory_import.py",
    "features/memory.py",
)
# What a value in an f-string stands for, as the window would see it.
SAMPLES = {
    "MAX_FACTS": "200",
    "MAX_INTENTS": "50",
    "MAX_ITEMS": "200",
    "skipped": "2",
    "were": "were",
    "len(gone)": "4",
    "', '.join(CATEGORIES)": ", ".join(memory.CATEGORIES),
    "day.isoformat()": "2026-10-12",
}


def _sample(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                out.append(str(part.value))
            else:
                out.append(SAMPLES.get(ast.unparse(part.value), "x"))
        return "".join(out)
    return None


def shown(path: Path) -> set[str]:
    """Refusals (raise ValueError / NotImportable), notes and "couldn't read" entries, and
    errors emitted to the window."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        args: list[ast.expr] = []
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            name = getattr(node.exc.func, "id", "")
            if name in ("ValueError", "NotImportable"):
                args = node.exc.args[:1]
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            target = node.func.value
            if node.func.attr == "append" and (
                (isinstance(target, ast.Attribute) and target.attr == "notes")
                or (isinstance(target, ast.Subscript) and ast.unparse(target.slice) == "'missing'")
            ):
                args = node.args[:1]
            elif node.func.attr == "emit":
                args = [k.value for k in node.keywords if k.arg in ("text", "error")]
        for arg in args:
            text = _sample(arg)
            if text and re.search(r"[a-z]{2}", text):
                found.add(" ".join(text.split()))
    return found


def chinese(merged: dict, text: str) -> str | None:
    if text in merged["strings"]:
        return merged["strings"][text]
    for pattern, replacement in merged["patterns"]:
        if re.search(pattern, text):
            return replacement
    return None


@pytest.mark.parametrize("module", MODULES)
def test_every_sentence_the_window_shows_has_its_chinese(module):
    merged = zh_strings()
    found = shown(SRC / module)
    assert found, "the scan found nothing: it has gone wrong"
    assert sorted(s for s in found if chinese(merged, s) is None) == []


def test_the_scan_sees_the_sentences_it_should():
    assert "My memory is full (200 facts); forget some first." in shown(SRC / "memory.py")
    assert "2 that looked like a password, key or account number were left out." in shown(
        SRC / "memory_import.py"
    )
    assert "texts (Full Disk Access)" in shown(SRC / "features/memory.py")
    assert "That review has closed; import it again." in shown(SRC / "features/memory.py")


def test_toasts_and_heads_ups_go_through_lang():
    source = (SRC / "features/memory.py").read_text()
    said = set(re.findall(r'self\.toast\(\s*"([^"]+)"', source))
    said |= set(re.findall(r'lang\.tr\(\s*"([^"]+)"', source))
    assert len(said) > 15
    assert sorted(s for s in said if s not in lang.ZH_TEXTS) == []
