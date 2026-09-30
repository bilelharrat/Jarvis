"""The chat channels' shared pieces: replies cut to each app's limit (code blocks closed and
reopened), Markdown shown each app's way with everything escaped, commands and pairing
codes read in English and Chinese, rate limits, and the fixed sentences in both languages."""

import re
from collections import Counter

import pytest

from jarvis import lang
from jarvis.channels import base, words
from jarvis.channels.base import (
    PairingCode,
    RateLimit,
    pair_code,
    parse_command,
    plain_text,
    slack_mrkdwn,
    split_text,
    telegram_html,
    utf16_len,
)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# ── cutting a reply ──


def test_a_short_reply_is_one_message():
    assert split_text("  Two meetings tomorrow.  ", 100) == ["Two meetings tomorrow."]
    assert split_text("", 100) == [] and split_text("   \n ", 100) == []


def test_a_long_reply_breaks_at_paragraphs_then_sentences():
    para = "First paragraph sentence. " * 3
    text = (para.strip() + "\n\n") * 10
    parts = split_text(text, 200)
    assert all(len(p) <= 200 for p in parts)
    assert all(p.endswith(".") for p in parts)
    assert " ".join(" ".join(p.split()) for p in parts) == " ".join(text.split())


def test_chinese_without_spaces_breaks_at_its_own_stops():
    text = "今天天气很好，我们去公园散步。" * 40
    parts = split_text(text, 100)
    assert all(len(p) <= 100 for p in parts) and all(p.endswith("。") for p in parts[:-1])
    assert "".join(parts) == text


def test_a_word_longer_than_the_limit_is_cut_hard():
    parts = split_text("x" * 250, 100)
    assert "".join(parts) == "x" * 250 and all(len(p) <= 100 for p in parts)


def test_a_code_block_cut_in_two_is_closed_and_reopened():
    code = "\n".join(f"line_{i} = {i}" for i in range(60))
    text = f"Here it is:\n```python\n{code}\n```\nDone."
    parts = split_text(text, 300)
    assert len(parts) > 2
    for part in parts:
        assert part.count("```") % 2 == 0, part  # every message's fences are balanced
        assert len(part) <= 300
    joined = "\n".join(parts)
    assert "line_0 = 0" in joined and "line_59 = 59" in joined and joined.endswith("Done.")


def test_telegram_counts_characters_past_the_basic_plane_twice():
    text = "😀" * 3000  # 6000 UTF-16 units
    parts = split_text(text, 4096, utf16_len)
    assert all(utf16_len(p) <= 4096 for p in parts) and "".join(parts) == text


# ── markup ──


def test_telegram_html_escapes_everything_and_keeps_the_formatting():
    html = telegram_html(
        "# Plan\n**Bold** <script>alert(1)</script> & `a<b>` then [docs](https://x.y/a?b=1&c=2)\n"
        "- one\n```py\nif a < b: print('x')\n```"
    )
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "<b>Plan</b>" in html and "<b>Bold</b>" in html
    assert "<code>a&lt;b&gt;</code>" in html
    assert '<a href="https://x.y/a?b=1&amp;c=2">docs</a>' in html
    assert "• one" in html
    assert "<pre><code class=\"language-py\">if a &lt; b: print('x')</code></pre>" in html
    assert html.count("<b>") == html.count("</b>") and html.count("<pre>") == html.count("</pre>")


def test_only_web_links_become_links():
    html = telegram_html("[click](javascript:alert(1)) [mail](mailto:a@b.c)")
    assert "<a " not in html


def test_slack_gets_its_own_markup():
    out = slack_mrkdwn("**Bold** a<b & [site](https://x.y) `c<d`\n```\nx > 1\n```")
    assert "*Bold*" in out and "a&lt;b &amp;" in out and "<https://x.y|site>" in out
    assert "`c&lt;d`" in out and "```\nx &gt; 1\n```" in out


def test_plain_text_drops_the_marks_and_keeps_links_readable():
    out = plain_text("## Title\n**Bold** see [docs](https://x.y) and `code`\n```\nls -la\n```")
    assert out == "Title\nBold see docs (https://x.y) and code\nls -la"


def test_someone_elses_words_cant_open_a_discord_code_block_or_hide_a_link():
    out = base.discord_safe("```hidden``` [safe](https://evil.example)")
    assert "```" not in out and "](" not in out


# ── commands and pairing ──


@pytest.mark.parametrize(
    ("text", "parsed"),
    [
        ("/stop", ("stop", "")),
        ("!status", ("status", "")),
        ("/status@jarvis_bot", ("status", "")),
        ("stop", ("stop", "")),
        ("Stop.", ("stop", "")),
        ("停止", ("stop", "")),
        ("/简报", ("brief", "")),
        ("状态", ("status", "")),
        ("/code 3 run the tests", ("code", "3 run the tests")),
        ("/CODE alpha fix it\nplease", ("code", "alpha fix it\nplease")),
        ("代码 2 修一下", ("code", "2 修一下")),
        ("/new", ("new", "")),
        ("help", ("help", "")),
        ("stop the music", None),
        ("/unknown", None),
        ("what's the status of my order?", None),
    ],
)
def test_commands_in_english_and_chinese(text, parsed):
    assert parse_command(text) == parsed


def test_pairing_messages_are_recognized_with_or_without_the_code():
    assert pair_code("/pair 123456") == "123456"
    assert pair_code("/pair 123 456") == "123456"
    assert pair_code("!pair@jarvis_bot 123-456") == "123456"
    assert pair_code("配对 654321") == "654321"
    assert pair_code("配对 ６５４ ３２１") == "654321"  # a Chinese keyboard's full-width digits
    assert pair_code("/pair ٦٥٤٣٢١") == ""  # another script's digits: no code
    assert pair_code("/pair 12345") == "" and pair_code("/pair") == ""
    assert pair_code("pair programming tips") is None and pair_code("hello") is None


def test_a_code_is_single_use_and_expires():
    clock = Clock()
    codes = PairingCode(clock)
    assert codes.check("123456", "a") == "none"  # nothing on the Mac: nothing to guess
    code = codes.start()
    assert len(code) == 6 and codes.seconds_left() == base.CODE_SECONDS
    assert codes.check(code, "a") == "ok"
    assert codes.check(code, "a") == "none"  # used up
    code = codes.start()
    clock.now += base.CODE_SECONDS + 1
    assert codes.check(code, "a") == "none" and not codes.active()


def test_wrong_codes_lock_the_guesser_out_but_not_the_owner():
    clock = Clock()
    codes = PairingCode(clock)
    code = codes.start()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(base.CODE_TRIES):
        assert codes.check(wrong, "stranger") == "wrong"
    assert codes.check(code, "stranger") == "locked"  # even with the right one
    assert codes.check(code, "owner") == "ok"  # someone else guessing never locks the owner
    clock.now += base.CODE_LOCK + 1
    assert not codes.locked("stranger")


def test_enough_wrong_guesses_from_everyone_spend_the_code():
    codes = PairingCode(Clock())
    code = codes.start()
    wrong = "000000" if code != "000000" else "111111"
    for n in range(base.CODE_SPENT):
        codes.check(wrong, f"guesser{n}")
    assert not codes.active() and codes.check(code, "owner") == "none"


def test_a_rate_limit_allows_a_burst_then_refills():
    clock = Clock()
    limit = RateLimit(3, 60, clock)
    assert [limit.take() for _ in range(4)] == [True, True, True, False]
    clock.now += 20  # one back
    assert limit.take() and not limit.take()


# ── what JARVIS writes ──

_SLOT = re.compile(r"\{(\w+)\}")


def test_every_fixed_sentence_has_its_chinese_with_the_same_slots():
    english = [
        v
        for k, v in vars(words).items()
        if k.isupper() and isinstance(v, str) and k not in ("TAG",) and v and v != "none"
    ]
    for sentence in english:
        assert sentence in words.ZH, sentence
        chinese = words.ZH[sentence]
        assert Counter(_SLOT.findall(sentence)) == Counter(_SLOT.findall(chinese)), sentence
        assert lang.has_cjk(chinese), sentence
        assert not lang.find_wake_zh(_SLOT.sub("X", chinese))[0], chinese  # never says its name


def test_say_uses_the_owners_language_through_lang():
    assert words.say(words.HEARD, "en", text="hi") == "Heard: “hi”"
    assert words.say(words.HEARD, "zh", text="你好") == "听到：“你好”"
    assert lang.tr(words.STOPPED, "zh") == "已停止。"  # it's one of lang's templates now
    assert words.say(words.HELP, "en", c="!").startswith("Write to me here")
    assert "!stop" in words.say(words.HELP, "zh", c="!")


def test_a_card_tells_how_to_answer_it_in_words():
    card = {"choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Not now"}]}
    assert "no, because" in words.hint_for(card, "en")
    assert "确认购买" in words.hint_for({**card, "ask_kind": "purchase"}, "zh")
    question = {
        "ask_kind": "question",
        "choices": [
            {"id": "opt0", "label": "Postgres"},
            {"id": "opt1", "label": "SQLite"},
            {"id": "skip", "label": "Skip"},
        ],
    }
    assert words.hint_for(question, "en").endswith("1. Postgres\n2. SQLite")


# ── what the window shows, in Chinese too ──


def _window_sentences():
    """Every sentence the channels' backend puts in the window: errors and notes (ValueError,
    set_state, note), Discord's close codes, the pairing toast; an f-string's slots filled
    with a chat app's name, as the window would get it."""
    import ast
    from pathlib import Path

    folder = Path(base.__file__).parent
    found = []

    def text(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            return "".join(
                v.value if isinstance(v, ast.Constant) else "Telegram" for v in node.values
            )
        return None

    for path in sorted(folder.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call):
                name = getattr(node.func, "attr", getattr(node.func, "id", ""))
                args = node.args
                pick = None
                if name == "ValueError" and args:
                    pick = args[0]
                elif name in ("set_state", "note") and len(args) >= 2:
                    pick = args[1]
                elif name == "emit" and args and getattr(args[0], "value", "") == "toast":
                    pick = next((k.value for k in node.keywords if k.arg == "text"), None)
                if pick is not None and text(pick):
                    found.append(text(pick))
            elif isinstance(node, ast.Assign) and any(
                getattr(t, "id", "") == "FATAL" for t in node.targets
            ):
                found += [text(v) for v in node.value.values]
    return [s for s in found if s]


def test_every_sentence_the_window_shows_has_chinese():
    from jarvis.server import zh_strings

    merged = zh_strings()
    strings, patterns = merged["strings"], [(re.compile(p), r) for p, r in merged["patterns"]]

    def chinese(sentence):
        if sentence in strings:
            return True
        return any(p.search(sentence) for p, _r in patterns)

    sentences = _window_sentences()
    assert len(sentences) > 30
    missing = [s for s in sentences if not chinese(s)]
    assert not missing, missing
    from jarvis.channels.router import LABELS

    assert all(label in strings for label in LABELS.values())


def test_cutting_a_long_reply_reads_it_once_not_once_a_message():
    """A long reply cut for Telegram or Discord (UTF-16 counted) measured everything still
    to send before each cut: a megabyte took half a minute on the event loop, Discord's a
    minute and a half. Each cut now measures one message's worth at most."""
    scanned = []

    def counting(text: str) -> int:
        scanned.append(len(text))
        return utf16_len(text)

    text = ("A line with 中文 and an emoji 😀 in it.\n" * 6_000)[:200_000]
    pieces = split_text(text, 4096, counting)
    assert "".join(pieces).replace("\n", "") == text.replace("\n", "").strip()
    assert all(utf16_len(p) <= 4096 for p in pieces)
    assert max(scanned) <= 4096  # never what's left of the reply, one message's worth at most
    assert sum(scanned) < 16 * len(text), sum(scanned)  # so about len × log, never len² / 4096
