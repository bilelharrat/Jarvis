"""Every sentence the voice panes show has Chinese (web/i18n/voice.json, merged with the
window's own): the window's fixed strings, the ones it builds with a name in them, and the
messages the backend sends it."""

import re
from pathlib import Path

import pytest

from jarvis import speaking, voices, wakewords
from jarvis.server import zh_strings

WEB = Path(__file__).resolve().parents[1] / "src" / "jarvis" / "web"


@pytest.fixture(scope="module")
def zh():
    merged = zh_strings()
    patterns = [(re.compile(p), r) for p, r in merged["patterns"]]

    def translate(text):
        key = re.sub(r"\s+", " ", text).strip()
        if key in merged["strings"]:
            return merged["strings"][key]
        for pattern, _replacement in patterns:
            if pattern.search(key):
                return pattern.sub(_replacement, key)
        return None

    return translate


_BRANDS = {"Mac", "ElevenLabs", "Fish Audio", "Premium", "Enhanced", "Whisper"}
# Words only ever put inside a sentence that has its own translation.
_INSIDE = {"English", "Chinese"}


def _js_literals(source):
    """The plain string literals of a script ('…' and "…"; template literals, comments and
    what's inside ${…} skipped)."""
    found, i, n = [], 0, len(source)
    while i < n:
        if source.startswith("//", i):
            i = source.find("\n", i)
            i = n if i < 0 else i
            continue
        if source.startswith("/*", i):
            i = source.find("*/", i) + 2
            continue
        quote = source[i]
        if quote not in "'\"`":
            i += 1
            continue
        j, text = i + 1, []
        while j < n and source[j] != quote:
            if source[j] == "\\":
                text.append(source[j + 1])
                j += 2
            elif quote == "`" and source.startswith("${", j):
                depth, j = 1, j + 2
                while j < n and depth:
                    depth += {"{": 1, "}": -1}.get(source[j], 0)
                    j += 1
            else:
                text.append(source[j])
                j += 1
        if quote != "`":
            found.append("".join(text))
        i = j + 1
    return found


def window_strings():
    """What voice.js writes as words: literals that start like a sentence or a label."""
    source = (WEB / "features" / "voice.js").read_text(encoding="utf-8")
    shown = {s for s in _js_literals(source) if re.match(r"[A-Z“]", s) and "_" not in s}
    return sorted(shown - _BRANDS - _INSIDE)


def test_the_window_strings_are_found():
    strings = window_strings()
    assert "Wake words" in strings and "List my voices" in strings and len(strings) > 30


@pytest.mark.parametrize("text", window_strings())
def test_each_window_string_has_chinese(zh, text):
    assert zh(text), f"no Chinese for {text!r}"


@pytest.mark.parametrize(
    "text",
    [
        # built in the window with a name or value in them
        "Say “Hey Friday” · ",
        "Remove Friday",
        "Picked here; your .env says ElevenLabs.",
        "Saved in the Keychain (sk-…5678).",
        "ElevenLabs needs an API key and a voice; the Mac voice speaks until then.",
        "Fish Audio failed last time; Ava (Premium) spoke instead.",
        "If ElevenLabs fails, Daniel (Enhanced) speaks instead.",
        # sent by the backend
        "Paste your Fish Audio API key first.",
        "I couldn't reach ElevenLabs. Check the connection.",
        "ElevenLabs needs an API key and a voice first.",
        "The Mac couldn't speak with Ava (Premium).",
        "The provider answered 502; try again later.",
        "About 123 MB.",
        "Downloading from Apple… 42%",
        "Apple’s recognizer couldn’t start (no audio format), so Whisper listens.",
        "Talking over me needs the Mac’s echo cancellation, which couldn’t start (the Mac's "
        "input is AirPods Pro, not its own microphone). Say “Jarvis, stop” to interrupt.",
        f"That's {wakewords.MAX_WORDS} wake words already; remove one first.",
    ],
)
def test_sentences_with_names_have_chinese(zh, text):
    assert zh(text), f"no Chinese for {text!r}"


def _messages(module):
    """The fixed sentences a module can show: its string constants that read as sentences,
    docstrings and log lines left out."""
    import ast

    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    docs = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    logged = {
        id(arg)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in ("info", "warning", "debug", "exception", "error")
        for arg in node.args
    }
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docs | logged
        and re.fullmatch(r"[A-Z][^\n]* [^\n]*[.!?]", node.value)
    }


@pytest.mark.parametrize(
    "text", sorted(_messages(speaking) | _messages(voices) | _messages(wakewords))
)
def test_each_backend_message_has_chinese(zh, text):
    if text == speaking.PREVIEW:
        return  # spoken, not shown: lang.tr gives its Chinese (test_speaking)
    assert zh(text), f"no Chinese for {text!r}"
