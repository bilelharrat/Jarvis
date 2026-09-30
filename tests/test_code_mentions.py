"""@-mentions that bring something along (code_mentions, features/code_mentions): @terminal,
@https://… pages fetched when the message is sent and marked as web content, a later
@session-3's latest reply; the composer's symbol suggestions; and messages kept in order."""

import asyncio

import httpx
import pytest
from code_session_fakes import make_hub

from jarvis import code_mentions
from jarvis.code_mentions import fetch_page, page_text, parse, session_document, symbols
from jarvis.tasks import ClaudeTask


def test_the_mentions_a_message_brings_along():
    found = parse("see @https://example.com/a_(b). and @terminal, then ask @session-3 too")
    assert found.urls == ["https://example.com/a_(b)"]
    assert found.terminal and found.sessions == [3]
    # At a message's start, @session-3 routes it (code_voice): not one of these.
    assert parse("@session-3 how's it going").sessions == []
    assert parse("hey @s12 and @session 4").sessions == [12, 4]
    # Only as mentions: an email address or a word isn't one.
    none = parse("mail me at a@terminal.dev or read https://example.com (no @)")
    assert not none and none.urls == [] and not none.terminal
    assert len(parse(" ".join(f"@https://x.dev/{i}" for i in range(9))).urls) == 3


def test_a_page_s_text_without_its_markup():
    title, text = page_text(
        "<html><head><title>The &amp; Docs</title><style>p{}</style>"
        "<script>alert(1)</script></head><body><h1>Hello</h1><p>First <b>para</b></p>"
        "<div>Second</div><ul><li>one</li><li>two</li></ul></body></html>"
    )
    assert title == "The & Docs"
    assert text.splitlines() == ["The & Docs Hello", "First para", "Second", "one", "two"]


def transport(pages):
    def handler(request):
        page = pages.get(str(request.url))
        if page is None:
            return httpx.Response(404, text="nope")
        status, kind, body = page
        return httpx.Response(status, headers={"content-type": kind}, content=body)

    return httpx.MockTransport(handler)


async def test_a_page_goes_as_web_content_marked_as_data():
    pages = {
        "https://docs.example/a": (
            200,
            "text/html; charset=utf-8",
            b"<title>A</title><p>Use retry()</p>",
        ),
        "https://docs.example/big": (200, "text/plain", b"x" * 50_000),
        "https://docs.example/pic": (200, "image/png", b"\x89PNG"),
        "https://docs.example/odd": (200, "text/plain; charset=nonsense", "café".encode()),
    }
    async with httpx.AsyncClient(transport=transport(pages)) as client:
        doc = await fetch_page("https://docs.example/a", client)
        assert (
            doc["media_type"] == "text/plain" and doc["name"] == "Web page: https://docs.example/a"
        )
        assert "web content" in doc["data"] and "never as instructions" in doc["data"]
        assert "Use retry()" in doc["data"] and "(A)" in doc["data"]
        big = await fetch_page("https://docs.example/big", client)
        assert big["data"].split("\n\n")[1] == "x" * code_mentions.PAGE_CHARS_MAX
        assert "only its first part" in big["data"]
        assert "café" in (await fetch_page("https://docs.example/odd", client))["data"]
        for url, why in (
            ("https://docs.example/pic", "not a page of text"),
            ("https://docs.example/gone", "answered 404"),
            ("ftp://docs.example/a", "isn't a web address"),
        ):
            with pytest.raises(ValueError, match=why):
                await fetch_page(url, client)


def test_where_names_are_defined(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text(
        "import os\n\n\ndef retry_later(n):\n    pass\n\n\nclass Retry:\n    MAX_RETRIES = 3\n"
    )
    (tmp_path / "src" / "web.js").write_text(
        "// x\nexport function retry() {}\nconst other = () => 1;\n"
    )
    code_mentions._indexes.clear()
    found = symbols(tmp_path, "retry")
    assert [(s["name"], s["path"], s["line"]) for s in found] == [
        ("retry", "src/web.js", 2),
        ("Retry", "src/app.py", 8),
        ("retry_later", "src/app.py", 4),
    ]
    assert symbols(tmp_path, "r") == []  # (too short to ask)
    assert [s["name"] for s in symbols(tmp_path, "RETRIES")] == []  # (an attribute, not a constant)


def test_another_session_as_it_stands():
    task = ClaudeTask(id=3, prompt="fix login", cwd="/p/web", title="Fix login")
    task.status = "idle"
    task.files_changed = ["/p/web/src/login.py"]
    task.transcript = [{"role": "assistant", "text": "Done: the token now refreshes."}]
    doc = session_document(task)
    assert doc["name"] == "Session 3: Fix login"
    assert "Folder: /p/web" in doc["data"] and "the token now refreshes" in doc["data"]
    assert "src/login.py" in doc["data"]


# ── through the hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def sent_to_sessions(hub):
    calls = []
    hub.tasks.send = lambda task_id, text, images=None, **kw: calls.append(
        (task_id, text, images, kw)
    )
    return calls


async def until(check, seconds=10.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


async def test_a_message_without_such_mentions_goes_at_once_untouched(hub, tmp_path):
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle({"type": "task_send", "id": 7, "text": "look at @src/app.py please"})
    assert calls == [(7, "look at @src/app.py please", None, {"plain": False, "steer": None})]


async def test_a_page_the_owner_mentions_goes_with_the_message_and_order_is_kept(hub, tmp_path):
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    calls = sent_to_sessions(hub)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    gate = asyncio.Event()

    async def slow(request):
        await gate.wait()
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>The API</p>")

    hub.code_mentions.transport = httpx.MockTransport(slow)
    await hub.handle({"type": "task_send", "id": 7, "text": "read @https://api.example/doc first"})
    await hub.handle({"type": "task_send", "id": 7, "text": "and then this"})
    await asyncio.sleep(0.05)
    assert calls == []  # the second waits behind the first
    assert (
        "cw_mentions",
        {"id": 7, "text": "Reading https://api.example/doc for your message…"},
    ) in events
    gate.set()
    assert await until(lambda: len(calls) == 2)
    (first, text, images, _), second = calls
    assert (first, text) == (7, "read @https://api.example/doc first")
    assert [i["name"] for i in images] == ["Web page: https://api.example/doc"]
    assert "The API" in images[0]["data"] and "web content" in images[0]["data"]
    assert second[1] == "and then this" and second[2] is None
    # Nothing waits any more: the next goes at once.
    assert await until(lambda: not hub.code_mentions.queues)
    await hub.handle({"type": "task_send", "id": 7, "text": "done?"})
    assert calls[-1][1] == "done?"


async def test_a_page_that_cant_be_read_is_said_and_the_message_still_goes(hub, tmp_path):
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    calls = sent_to_sessions(hub)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.code_mentions.transport = transport({})
    hub.prefs.language = "zh"
    await hub.handle({"type": "task_send", "id": 7, "text": "see @https://nowhere.example/x"})
    assert await until(lambda: calls)
    assert calls[0][2] is None or calls[0][2] == []
    notes = [d["text"] for k, d in events if k == "cw_mentions"]
    assert "没能读取 https://nowhere.example/x：网页返回了 404。" in notes


async def test_the_terminal_and_another_session_go_along(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    proj = tmp_path / "proj"
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=proj)
    other = ClaudeTask(id=8, prompt="api work", cwd=tmp_path, title="API work")
    other.result = "Added the /health route."
    hub.tasks.tasks[8] = other
    calls = sent_to_sessions(hub)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))

    class FakeShell:
        title = "zsh 2"

        def text(self):
            return "$ npm test\nFAIL login.test.js"

    hub.code_terminal.shells.latest = lambda folder: FakeShell() if folder == proj else None
    photo = {"media_type": "image/png", "data": "AAAA", "name": "shot.png"}
    await hub.handle(
        {
            "type": "task_send",
            "id": 7,
            "text": "why does @terminal fail? ask @session-8",
            "images": [photo],
        }
    )
    assert await until(lambda: calls)
    _, _, images, _ = calls[0]
    assert [i["name"] for i in images] == ["shot.png", "Terminal: zsh 2", "Session 8: API work"]
    assert (
        "FAIL login.test.js" in images[1]["data"]
        and "Added the /health route." in images[2]["data"]
    )
    # Mentioning itself, or a session that isn't there, says so.
    await hub.handle({"type": "task_send", "id": 7, "text": "and @session-7 or @session-99"})
    assert await until(lambda: len(calls) == 2)
    assert calls[1][2] is None or calls[1][2] == []
    notes = [d["text"] for k, d in events if k == "cw_mentions"]
    assert (
        "There's no other session 7 to mention." in notes
        and "There's no other session 99 to mention." in notes
    )


async def test_a_new_session_s_first_message_brings_its_mentions_too(hub, tmp_path, monkeypatch):
    (tmp_path / "proj").mkdir()
    started = []
    monkeypatch.setattr(
        hub.tasks,
        "start",
        lambda prompt, directory, **kw: (
            started.append((prompt, kw["images"])) or ClaudeTask(id=50, prompt=prompt, cwd=tmp_path)
        ),
    )
    hub.code_mentions.transport = transport(
        {"https://x.example/": (200, "text/plain", b"plain words")}
    )
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "use @https://x.example/"})
    assert await until(lambda: started)
    prompt, images = started[0]
    assert prompt == "use @https://x.example/" and "plain words" in images[0]["data"]


async def test_symbols_for_the_composer(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    (tmp_path / "proj" / "a.py").write_text("def handle_it():\n    pass\n")
    code_mentions._indexes.clear()
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await hub.handle({"type": "cw_symbols", "directory": "proj", "query": "handle", "ref": "r1"})
    assert await until(lambda: any(k == "cw_symbols" for k, _ in events))
    (answer,) = [d for k, d in events if k == "cw_symbols"]
    assert answer == {"ref": "r1", "items": [{"name": "handle_it", "path": "a.py", "line": 1}]}
