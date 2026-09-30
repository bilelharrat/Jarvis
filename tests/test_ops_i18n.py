"""Every sentence the ops feature's backend puts in front of the owner (a check's title,
summary and hint, a finding and its tighten, a backup's problem) has its Chinese in the
window's strings: web/i18n/ops.json, merged over i18n-zh.json. The sentences are read from
the modules' own source, so a new one without its Chinese fails here."""

import ast
import re
from pathlib import Path

import pytest

from jarvis import lang
from jarvis.features.ops import desk
from jarvis.server import zh_strings

OPS = Path(desk.__file__).parent
SHOWN = ("doctor.py", "audit.py", "permissions.py", "backup.py", "desk.py")
# What a value in an f-string stands for, as the window would see it.
SAMPLES = {"currency": "USD", "name": "Notion", "label": "Webhooks on", "folder": "app"}
# Sentences that aren't the window's: file and folder names, the spoken summary for Claude
# (Claude says it in the owner's language), the voice sample (lang.py has its Chinese).
NOT_SHOWN = re.compile(
    r"^(?:Jarvis backup|Jarvis diagnostics|Damaged files|Checkup done|Details and fixes|"
    r"Hello\. This is how I sound|Run Jarvis's own checkup|Today's backup didn't work|"
    # the plan and the paths are shown as they are (data-no-i18n)
    r"(?:Max|Pro|Team|Enterprise|API key|Library|Logs|Documents|Jarvis|Backups|Diagnostics)$)"
)


def _sample(node: ast.JoinedStr) -> str:
    out = []
    for part in node.values:
        if isinstance(part, ast.Constant):
            out.append(str(part.value))
            continue
        value = part.value
        name = value.id if isinstance(value, ast.Name) else ""
        if isinstance(value, ast.Subscript) and isinstance(value.value, ast.Name):
            name = value.value.id
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
            name = getattr(value.func.value, "id", "")
        out.append(SAMPLES.get(name, "memory.json" if name in ("rel", "row") else "2"))
    return "".join(out)


def sentences(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    skip: set[int] = set()
    for node in ast.walk(tree):
        # Docstrings, and what's written to the log, are nobody's window text.
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef | ast.Module):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                skip.add(id(body[0].value))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if getattr(node.func.value, "id", "") in ("log", "logging"):
                for arg in ast.walk(node):
                    skip.add(id(arg))
    found: set[str] = set()
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        if isinstance(node, ast.JoinedStr):
            for part in node.values:
                skip.add(id(part))
            text = _sample(node)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            text = node.value
        else:
            continue
        worded = re.match(r"^[A-Z][a-z']*(?: |[.,:?!…]|$)", text) or re.match(
            r"^\d[\d.,]* [a-zA-Z]", text
        )
        if worded and re.search(r"[a-z]", text):
            if not NOT_SHOWN.match(text) and " · " not in text and "auth login" not in text:
                found.add(text)  # " · " joins data (a name and a date); the command is typed
    return found


def chinese(merged: dict, text: str) -> str | None:
    key = " ".join(text.split())
    if key in merged["strings"]:
        return merged["strings"][key]
    for pattern, replacement in merged["patterns"]:
        if re.search(pattern, key):
            return replacement
    return None


@pytest.mark.parametrize("module", SHOWN)
def test_every_sentence_the_backend_shows_has_its_chinese(module):
    merged = zh_strings()
    found = sentences(OPS / module)
    assert found, "the scan found nothing: it has gone wrong"
    missing = sorted(s for s in found if chinese(merged, s) is None)
    assert missing == []


def test_the_scan_sees_the_sentences_it_should():
    doctor_sentences = sentences(OPS / "doctor.py")
    assert "Claude sign-in" in doctor_sentences
    assert "2 couldn't connect" in doctor_sentences
    assert "2 GB free" in doctor_sentences
    assert "2 USD a purchase, 2 a transfer, 2 a day" in sentences(OPS / "audit.py")
    assert not any(s.startswith("the checkup") for s in doctor_sentences)


def test_what_jarvis_says_itself_goes_through_lang():
    assert lang.tr(desk.VOICE_SAMPLE, "zh") == desk.VOICE_SAMPLE_ZH
    assert lang.translate(desk.VOICE_SAMPLE, "zh") == desk.VOICE_SAMPLE_ZH
    said = lang.tr(desk.BACKUP_FAILED, "zh", why="The backup folder isn't a folder.")
    assert said.startswith("今天的备份没有成功")
    assert lang.tr(desk.BACKUP_FAILED, "en", why="x") == "Today's backup didn't work: x"
