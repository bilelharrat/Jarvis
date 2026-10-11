"""Eden Code's full export (code_export, features/code_export): the whole session from
Claude Code's record, every step's input and output and the thinking, as a page or a PDF;
share-safe with secrets blanked out and pictures left out; paths hidden when asked."""

import asyncio
import re
from datetime import datetime
from pathlib import Path

import pytest
from claude_agent_sdk.types import SessionMessage
from code_session_fakes import make_hub, until

from jarvis import tasks
from jarvis.code_export import Anonymizer, entries_from, redact_secrets, render
from jarvis.tasks import ClaudeTask, _history_said

SID = "0f5d8c1e-7a41-4b8e-9d6b-2f1a3c4e5b6d"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="
KEY = "sk-ant-api03-" + "A1b2C3d4" * 6


def msg(kind, uuid, content):
    return SessionMessage(
        type=kind, uuid=uuid, session_id=SID, message={"role": kind, "content": content}
    )


def conversation():
    return [
        msg("user", "u1", [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}},
                           {"type": "text", "text": f"Why does <script>alert(1)</script> fail? my key is {KEY}"},
                           {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": "x"}, "title": "log.txt"}]),
        msg("assistant", "a1", [{"type": "thinking", "thinking": "The owner's key should never be printed."},
                                {"type": "text", "text": "Let me look.\n\n```python\nprint('<b>hi</b>')\n```"},
                                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cat /Users/owner/proj/.env.example"}},
                                {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/Users/owner/proj/a.py"}},
                                {"type": "redacted_thinking", "data": "xyz"}]),
        msg("user", "r1", [{"type": "tool_result", "tool_use_id": "t1", "content": 'API_KEY="zQ8xLm2Pv7Rt9Wk3Yn5Bc1Df"\nDONE', "is_error": False},
                           {"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "no such file"}], "is_error": True}]),
        msg("user", "c1", "<command-name>/compact</command-name>\n<command-args></command-args>"),
        msg("assistant", "a2", [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "sleep 99"}}]),
        msg("assistant", "a3", [{"type": "text", "text": "Fixed it, owner."}]),
    ]  # fmt: skip


def test_the_record_as_entries_every_step_with_its_output_and_the_thinking():
    entries = entries_from(conversation(), _history_said)
    kinds = [e["kind"] for e in entries]
    assert kinds == [
        "user",
        "thinking",
        "assistant",
        "step",
        "step",
        "thinking",
        "user",
        "step",
        "assistant",
    ]
    user = entries[0]
    assert user["files"] == ["log.txt"] and user["pictures"][0]["data"] == PNG
    bash, read = entries[3], entries[4]
    assert bash["output"].endswith("DONE") and not bash["error"]
    assert read["output"] == "no such file" and read["error"]
    assert entries[5]["hidden"] and entries[6]["text"] == "/compact"
    assert entries[7]["output"] is None  # (a step whose result never came)


def page(**kw):
    return render(entries_from(conversation(), _history_said), title="Fix <the> bug", project="/Users/owner/proj",
                  model="Fable", when=datetime(2026, 9, 30, 9, 30), **kw)  # fmt: skip


def test_the_page_is_everything_escaped_self_contained_and_never_markup():
    full = page()
    assert "<script>" not in full and "&lt;script&gt;alert(1)&lt;/script&gt;" in full
    assert "Fix &lt;the&gt; bug" in full and "Content-Security-Policy" in full
    assert "The owner&#x27;s key should never be printed." in full
    assert "&quot;command&quot;: &quot;cat /Users/owner/proj/.env.example&quot;" in full
    assert (
        "no such file" in full and 'class="state failed"' in full and "(no result recorded)" in full
    )
    assert f"data:image/png;base64,{PNG}" in full
    assert "print(&#x27;&lt;b&gt;hi&lt;/b&gt;&#x27;)" in full and "<pre><code>" in full
    assert KEY in full  # (everything: nothing blanked out unless share-safe)
    assert '<details class="entry step"><summary>' in full  # closed on a page


def test_share_safe_blanks_secrets_and_leaves_pictures_out_and_hides_paths():
    safe = page(
        safe=True,
        anonymize=Anonymizer(project="/Users/owner/proj", home="/Users/owner", user="owner"),
    )
    assert KEY not in safe and "zQ8xLm2Pv7Rt9Wk3Yn5Bc1Df" not in safe and "[redacted]" in safe
    assert PNG not in safe and "left out of a share-safe export" in safe
    assert (
        "/Users/owner" not in safe
        and "&lt;project&gt;/a.py" in safe
        and "Fixed it, &lt;user&gt;." in safe
    )
    assert "A share-safe export" in safe
    # A PDF: steps open to be read on paper, no pictures.
    printed = page(printing=True)
    assert '<details class="entry step" open>' in printed and PNG not in printed


def test_secrets_blanked_out_in_their_usual_forms():
    text = "\n".join([
        f"key {KEY}",
        "token ghp_" + "a" * 36,
        'password = "correct horse battery"',
        "db postgres://admin:s3cretPassw0rd@db.example.com/app",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "AKIA" + "ABCDEFGHIJKLMNOP",
    ])  # fmt: skip
    out = redact_secrets(text)
    for secret in (
        KEY,
        "ghp_",
        "correct horse",
        "s3cretPassw0rd",
        "MIIEow",
        "AKIAABCDEFGHIJKLMNOP",
    ):
        assert secret not in out, secret
    assert "db.example.com" in out  # (only the password of the address)
    # A placeholder isn't a secret, and a coding session's paths and hashes stay.
    kept = 'api_key = "your-api-key-here" in /Users/amy/Projects/app2024/src/components/Button, commit 4075c9c2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7'
    assert redact_secrets(kept) == kept
    assert (
        redact_secrets('x = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF"') == 'x = "[redacted]"'
    )  # (random-looking)


def test_claude_s_markdown_is_drawn_escaped_and_links_go_only_to_the_web():
    from jarvis.code_export import markdown_html

    drawn = markdown_html(
        "## Plan\n\n1. Read **hub.py**\n2. Fix `retry()`\n   - [x] tests\n\n| File | Lines |\n|:--|--:|\n| a.py | 12 |\n\n"
        "> a <b>quote</b>\n\nSee [docs](https://example.com/d) or [bad](javascript:alert(1)) and [hub](src/hub.py:7).\n"
        "<img src=x onerror=alert(1)>\n\n```python\nprint('<i>')\n```"
    )
    assert (
        "<h3>Plan</h3>" in drawn
        and "<strong>hub.py</strong>" in drawn
        and "<code>retry()</code>" in drawn
    )
    assert '<ul class="tasks"><li><span class="task done">' in drawn
    assert '<th class="l">File</th>' in drawn and '<td class="r">12</td>' in drawn
    assert "<blockquote><p>a &lt;b&gt;quote&lt;/b&gt;</p></blockquote>" in drawn
    assert "style=" not in drawn  # (classes: a style attribute may not survive a page's policy)
    assert '<a href="https://example.com/d">docs</a>' in drawn and "javascript" not in drawn
    assert (
        "and hub." in drawn
        and "&lt;img src=x onerror=alert(1)&gt;" in drawn
        and "<img" not in drawn
    )
    assert "print(&#x27;&lt;i&gt;&#x27;)" in drawn


def test_hidden_paths_leave_other_words_alone():
    hide = Anonymizer(project="/Users/amy/code/app", home="/Users/amy", user="amy")
    assert (
        hide("/Users/amy/code/app/src and /Users/amy/Desktop, by amy")
        == "<project>/src and ~/Desktop, by <user>"
    )
    assert hide("amygdala and dreamy") == "amygdala and dreamy"


# ── through the hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks, "EXPORT_DIR", tmp_path / "exports")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))  # (never the owner's records)
    monkeypatch.setattr(
        tasks, "get_session_messages", lambda sid, directory: conversation() if sid == SID else []
    )
    return make_hub(settings, quiet_speaker, isolated)


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def answers(seen, n=1):
    assert await until(lambda: sum(k == "cw_export" for k, _ in seen) >= n, 1200)
    return [d for k, d in seen if k == "cw_export"]


async def test_an_export_is_written_whole_as_a_page_and_as_a_pdf(hub, tmp_path):
    task = ClaudeTask(id=7, prompt="fix it", cwd=tmp_path, session_id=SID, title="Fix the bug")
    hub.tasks.tasks[7] = task
    seen = record(hub)
    await hub.handle({"type": "cw_export", "id": 7, "ref": "x1"})
    (done,) = await answers(seen)
    path = Path(done["path"])
    assert done["ok"] and done["ref"] == "x1" and path.parent == tmp_path / "exports"
    assert re.fullmatch(r"\d{4}-\d\d-\d\d \d{4} Fix the bug\.html", done["name"])
    assert KEY in path.read_text() and done["entries"] == 9
    await hub.handle({"type": "cw_export", "id": 7, "safe": True, "ref": "x2"})
    safe = (await answers(seen, 2))[-1]
    assert (
        safe["name"].endswith("Fix the bug (share-safe).html")
        and KEY not in Path(safe["path"]).read_text()
    )
    # A PDF, laid out by the app's window; without the app, said so.
    pages = []

    async def pdf(html):
        pages.append(html)
        return b"%PDF-1.7 fake"

    hub.pdf_call = pdf
    await hub.handle({"type": "cw_export", "id": 7, "format": "pdf", "ref": "x3"})
    printed = (await answers(seen, 3))[-1]
    assert (
        printed["name"].endswith(".pdf") and Path(printed["path"]).read_bytes() == b"%PDF-1.7 fake"
    )
    assert '<details class="entry step" open>' in pages[0]

    async def no_app(html):
        return None

    hub.pdf_call = no_app
    await hub.handle({"type": "cw_export", "id": 7, "format": "pdf", "ref": "x4"})
    assert "needs the app's window" in (await answers(seen, 4))[-1]["error"]


async def test_no_session_no_export_and_one_never_connected_goes_from_its_transcript(hub, tmp_path):
    seen = record(hub)
    await hub.handle({"type": "cw_export", "id": 99, "ref": "x1"})
    assert (await answers(seen))[0]["error"] == "Open a session to export it."
    task = ClaudeTask(id=8, prompt="plan it", cwd=tmp_path)
    task.transcript = [
        {"role": "user", "text": "plan it"},
        {"role": "assistant", "text": "Here's the plan."},
    ]
    hub.tasks.tasks[8] = task
    await hub.handle({"type": "cw_export", "id": 8, "ref": "x2"})
    done = (await answers(seen, 2))[-1]
    assert done["ok"] and "Here's the plan." in Path(done["path"]).read_text()


async def test_only_an_export_is_shown_in_finder(hub, tmp_path, monkeypatch):
    from jarvis import mac_tools

    ran = []

    async def run(*args, timeout=30):
        ran.append(list(args))
        return ""

    monkeypatch.setattr(mac_tools, "run_command", run)
    (tmp_path / "exports").mkdir()
    made = tmp_path / "exports" / "a.html"
    made.write_text("x")
    (tmp_path / "secret.txt").write_text("x")
    await hub.handle({"type": "cw_export_reveal", "path": str(made)})
    await hub.handle({"type": "cw_export_reveal", "path": str(tmp_path / "secret.txt")})
    await hub.handle(
        {"type": "cw_export_reveal", "path": str(tmp_path / "exports" / ".." / "secret.txt")}
    )
    await asyncio.sleep(0.1)
    assert ran == [["open", "-R", str(made.resolve())]]


def test_each_message_says_when_it_was_written():
    entries = entries_from(conversation(), _history_said)
    entries[0]["at"] = "2026-09-30T16:30:00.000Z"
    shown = render(entries, title="t", project="p")
    local = datetime.fromisoformat("2026-09-30T16:30:00+00:00").astimezone().strftime("%H:%M")
    assert f'<div class="who">You · {local}</div>' in shown
    assert '<div class="who">Eden Code</div>' in shown  # (no time known: none shown)


def test_export_names_keep_every_language_s_letters():
    """CF18: every non-ASCII letter was dropped: "修复登录 bug" -> "… bug"."""
    from datetime import datetime

    from jarvis.code_export import file_stem

    when = datetime(2026, 10, 10, 6, 4)
    assert file_stem("修复登录 bug", False, when) == "2026-10-10 0604 修复登录 bug"
    assert file_stem("Café ✓ résumé", True, when) == "2026-10-10 0604 Café résumé (share-safe)"
    assert file_stem("a/b:c\0d", False, when) == "2026-10-10 0604 a b c d"
    assert file_stem("✓✓", False, when) == "2026-10-10 0604 Session"


# ── an app's output on its way to a session (mask_output) ──

KEY = "sk-ant-api03-" + "Q7wZ" * 10


@pytest.mark.parametrize(
    ("text", "secret"),
    [
        ("redis connect failed redis://:S3cretRedisPass99@localhost:6379/0", "S3cretRedisPass99"),
        ("db failed postgres://app:p@ssw0rd!x9@db.local:5432/shop", "ssw0rd!x9"),
        ("postgres://app:ab/cd3fgh@db.local:5432/x", "cd3fgh"),
        ("POSTGRES://app:hunter2hunter2@db:5432/x", "hunter2hunter2"),
        (
            "upstream 401 Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeedd",
            "9f8e7d6c5b4a",
        ),
        ("upstream 401 Authorization: Basic YWRtaW46VHIwdWI0ZG9yJjMtaG9yc2U=", "YWRtaW46VHIw"),
        ("Error: key was " + KEY[:20] + "\n" + KEY[20:] + " more", KEY[20:]),
        ("Error: key was " + KEY[:40] + "\n" + KEY[40:] + "zz12", KEY[40:]),
        (
            "Set-Cookie: session=eyJ1c2VyIjoxfQ.ZxYwVw.abcdefghijklmnopqrstuvwxyz12; Path=/",
            "abcdefghijkl",
        ),
        ("Cookie: sid=s%3Aabc123def456ghi; theme=dark", "abc123def456"),
        (
            '{"k":"sk\\u002dant\\u002dapi03\\u002dAbcdefghij0123456789KLMNOPqrstuv"}',
            "Abcdefghij0123",
        ),
        (
            "env QU5USFJPUElDX0FQSV9LRVk9c2stYW50LWFwaTAzLVE3d1pRN3daUTd3WlE3d1pRN3daUTd3WlE3d1pRN3daUTd3WlE3d1o=",
            "QU5USFJPUElD",
        ),
        (
            "AccountName=x;AccountKey=abcdEFGH1234ijklMNOP5678qrstUVWX9012yzAB==;EndpointSuffix=x",
            "abcdEFGH1234",
        ),
        ("GET /cb?code=4/0AX4XfWh123456789abcdefghijklmno&state=x", "0AX4XfWh123"),
        ("DB_PASSWORD=MyVault2024x9q", "MyVault2024x9q"),
        (
            "MIIEowIBAAKCAQEA7abcdefgh\nQWERTYUIOPASDFGHJKL123\n-----END RSA PRIVATE KEY-----",
            "MIIEow",
        ),
        ('{"url":"postgres:\\/\\/app:s3cretpw99@db.local\\/x"}', "s3cretpw99"),
        ("key \x1b[1msk-ant-api03-\x1b[0m" + "Q7wZ" * 10, "Q7wZQ7wZQ7wZ"),
    ],
)
def test_output_sent_to_a_session_has_every_form_of_a_secret_masked(text, secret):
    from jarvis.code_export import mask_output

    out = mask_output(text)
    assert secret not in out and "[redacted]" in out, out


def test_output_masking_leaves_what_isnt_a_secret():
    from jarvis.code_export import mask_output

    for text in (
        "GET http://localhost:3000/login?email=bob@x.com 200",
        "https://cdn.jsdelivr.net/npm/foo@1.2.3/dist/x.js",
        "Missing bearer authentication for the route",
        "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 merged",
        "API_KEY=${API_KEY} and token = process.env.TOKEN",
        "Server listening on http://127.0.0.1:8000, ready",
    ):
        assert mask_output(text) == text
    # A whole key ending its line: the next line's first word is its own.
    assert (
        mask_output(f"Error: bad key {KEY}\nError: no db")
        == "Error: bad key [redacted]\nError: no db"
    )


def test_a_saved_secret_is_masked_in_any_form_it_is_printed_in():
    import base64
    import json as jsonlib
    from urllib.parse import quote

    from jarvis.code_export import mask_output

    saved = {"Hunter2Saved!": "$DB_PW"}
    for text in (
        "pw HUNTER2SAVED! up",
        "q=" + quote("Hunter2Saved!", safe=""),
        jsonlib.dumps({"p": "Hunter2Saved!"}),
        "x " + base64.b64encode(b"Hunter2Saved!").decode(),
        "b64 " + base64.b64encode(b"user=bob pass=Hunter2Saved! end").decode(),
        "Hunter\x1b[1m2Saved!",
    ):
        out = mask_output(text, saved)
        assert "unter2" not in out.lower() and out != text, (text, out)
