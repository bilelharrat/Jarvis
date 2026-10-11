"""Round 2 fixes for Eden Code's workspace (askeden/docs/bug-sweep/r2-eden-code-workspace.md):
search anchors and line numbers in a plain folder (CF2-4, CF2-9), new files listed (CF2-5),
URL mentions connected to the address checked (CF2-8), answers to the asking window only
(CF2-10, project_files, cw_symbols), and searches in threads of their own."""

import asyncio
import contextvars
import subprocess
import threading
import time

import httpcore
import httpx
import pytest
from code_session_fakes import make_hub, until

from jarvis import code_mentions, code_search, code_vocab
from jarvis import hub as hub_mod
from jarvis.code_search import Query, search
from jarvis.features import code_workspace


def files(root, tree):
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in tree.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(text.encode() if isinstance(text, str) else text)
    return root


def git(root):
    run = lambda *a: subprocess.run(["git", "-C", str(root), *a], check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    run("add", "-A")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x")
    return root


def lines_of(result):
    return {f["path"]: [m["line"] for m in f["matches"]] for f in result["files"]}


ANCH = "# top\ndef go():\n    return \"end\"\nmore\n"


@pytest.mark.parametrize("kind", ["git", "walk"])
@pytest.mark.parametrize(
    ("pattern", "line"), [("^def", 2), ('end"$', 3), ("^more$", 4), ("^#", 1)]
)
def test_line_anchors_mean_each_line_in_a_plain_folder_as_in_git(tmp_path, kind, pattern, line):
    """CF2-4: ^ and $ found nothing in a plain folder unless at the file's start or end (the
    whole-file first look had no MULTILINE)."""
    tree = {"anch.py": ANCH}
    if kind == "walk":  # (git grep's $ doesn't match before a \r; the walk's lines leave it out)
        tree["crlf.txt"] = ANCH.replace("\n", "\r\n")
    root = files(tmp_path / kind, tree)
    if kind == "git":
        git(root)
    got = lines_of(search(root, Query(pattern, regex=True, case=True)))
    assert got == {name: [line] for name in tree}


def test_an_expression_that_reads_past_a_line_still_matches_each_line(tmp_path):
    root = files(tmp_path / "p", {"a.txt": "one\ntwo\n"})
    assert lines_of(search(root, Query(r"\Atwo", regex=True))) == {"a.txt": [2]}
    assert lines_of(search(root, Query(r"o(?!\n)$", regex=True))) == {"a.txt": [2]}


@pytest.mark.parametrize("kind", ["git", "walk"])
@pytest.mark.parametrize("regex", [False, True], ids=["text", "expression"])
def test_line_numbers_count_newlines_only(tmp_path, kind, regex):
    """CF2-9: splitlines() also split at a form feed, U+2028 and U+0085: the plain folder's
    line numbers ran ahead of the editor's and git's."""
    root = files(
        tmp_path / kind,
        {
            "ff.txt": "top\x0cpage two\nneedle_ff here\n",
            "ls.js": "a b\u0085c\nneedle_ls\n",
            "win.txt": "x\r\nneedle_cr\r\n",
        },
    )
    if kind == "git":
        git(root)
    got = lines_of(search(root, Query("needle", regex=regex)))
    assert got == {"ff.txt": [2], "ls.js": [2], "win.txt": [2]}
    (match,) = search(root, Query("needle_cr", regex=regex))["files"][0]["matches"]
    assert match["text"] == "needle_cr"  # (its \r left out, as before)


def test_file_lines():
    assert code_search.file_lines("a\nb\n") == ["a", "b"]
    assert code_search.file_lines("a\r\nb") == ["a", "b"]
    assert code_search.file_lines("a\x0cb c\n\n") == ["a\x0cb c", ""]
    assert code_search.file_lines("") == []


# ── CF2-5: files made after the list was read ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def drain(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev.get("type") == kind:
            out.append(dict(ev))
    return out


async def ask(hub, queue, msg, kind):
    """A window command from the window whose queue this is; its answers of that kind."""
    ctx = contextvars.copy_context()
    ctx.run(hub_mod.CALLER.set, queue)
    await asyncio.get_running_loop().create_task(hub._handle(msg), context=ctx)
    got = []
    assert await until(lambda: got.extend(drain(queue, kind)) or got, 1200), kind
    return got


@pytest.mark.parametrize("kind", ["git", "walk"])
async def test_a_file_made_after_the_list_was_read_is_listed(hub, tmp_path, monkeypatch, kind):
    """CF2-5: the list was read once per ten minutes, a reload included: a file Claude made
    couldn't be found in the Files pane or @-mentioned."""
    monkeypatch.setattr(code_vocab, "_vocabs", {})
    root = files(tmp_path / kind, {"anch.py": ANCH})
    if kind == "git":
        git(root)
    hub.tasks.resolve_dir = lambda directory: root
    mine = hub.subscribe()
    (first,) = await ask(hub, mine, {"type": "project_files", "directory": "p"}, "project_files")
    assert first["files"] == ["anch.py"]
    (root / "brandnew_84470.py").write_text("x = 1\n")
    # The window knows files changed (a turn ended): read again at once.
    monkeypatch.setattr(code_vocab, "FILES_CHANGED_SECONDS", 0.0)
    msg = {"type": "project_files", "directory": "p", "fresh": True}
    (again,) = await ask(hub, mine, msg, "project_files")
    assert "brandnew_84470.py" in again["files"] and again["total"] == 2
    # A query among all of them finds it too, and so does a plain ask a little later.
    (root / "later.py").write_text("")
    monkeypatch.setattr(code_vocab, "FILES_FRESH_SECONDS", 0.0)
    (plain,) = await ask(hub, mine, {"type": "project_files", "directory": "p"}, "project_files")
    assert "later.py" in plain["files"]
    found = await ask(
        hub, mine, {"type": "project_files", "directory": "p", "query": "brandnew"}, "project_files"
    )
    assert found[0]["files"] == ["brandnew_84470.py"]


async def test_a_file_list_and_symbols_go_to_the_window_that_asked(hub, tmp_path, monkeypatch):
    """Up to 6,000 paths, and the @-symbols, went to every window (and every pane)."""
    monkeypatch.setattr(code_vocab, "_vocabs", {})
    root = files(tmp_path / "p", {"a.py": "def retry_max():\n    pass\n"})
    hub.tasks.resolve_dir = lambda directory: root
    mine, other = hub.subscribe(), hub.subscribe()
    await ask(hub, mine, {"type": "project_files", "directory": "p"}, "project_files")
    msg = {"type": "cw_symbols", "directory": "p", "query": "retry", "ref": "~sv2~k" + "x" * 300}
    (sym,) = await ask(hub, mine, msg, "cw_symbols")
    assert sym["ref"] == msg["ref"]  # (echoed whole: a pane's mark and a long key)
    assert drain(other, "project_files") == [] and drain(other, "cw_symbols") == []


# ── CF2-10: export answers ──


async def test_an_export_answer_goes_to_the_window_that_asked(hub):
    mine, other = hub.subscribe(), hub.subscribe()
    (got,) = await ask(hub, mine, {"type": "cw_export", "id": 99, "ref": "pA-x1"}, "cw_export")
    assert got["ref"] == "pA-x1" and got["error"]
    await asyncio.sleep(0.05)
    assert drain(other, "cw_export") == []  # (before: every window, refs x1, x2… in each)


# ── CF2-8: a URL mention connects to the address it was checked at ──


async def test_a_name_that_doesn_t_resolve_isn_t_fetched(monkeypatch):
    async def nothing(host):
        return []

    monkeypatch.setattr(code_mentions, "_addresses", nothing)
    ((url, doc, why),) = await code_mentions.fetch_all(["https://rebind.example/x"])
    assert doc is None and "Couldn't find that site's address" in why


async def test_the_fetch_connects_to_the_checked_address_never_resolving_again(monkeypatch):
    """CF2-8 (DNS rebinding): the check resolved the name to a public address, then httpx
    resolved it again on connect, to 127.0.0.1, and fetched this Mac's page."""
    answers = iter([["93.184.216.34"], ["127.0.0.1"]])

    async def addresses(host):
        return next(answers)

    connected = []

    class Inner:
        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            connected.append((host, port))
            raise httpcore.ConnectError("(test: no network)")

        async def sleep(self, seconds):
            await asyncio.sleep(seconds)

    monkeypatch.setattr(code_mentions, "_addresses", addresses)
    monkeypatch.setattr(code_mentions.httpcore, "AnyIOBackend", Inner)
    ((url, doc, why),) = await code_mentions.fetch_all(["http://rebind.example:8853/x"])
    assert connected == [("93.184.216.34", 8853)]  # the address checked, not a new lookup
    assert doc is None and why == "Couldn't connect to the site."  # (r3 CF3-13: words, no class name)


async def test_a_pinned_connection_never_goes_to_a_name_that_wasnt_checked():
    backend = code_mentions._PinnedBackend({"ok.example": "93.184.216.34"})
    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("other.example", 80)


async def test_the_pinned_transport_reads_a_page_through_the_checked_address(monkeypatch):
    """End to end against a local server: the name resolves (in the test) to a public
    address; the connection goes where the pin says, with the site's own Host header."""
    import http.server

    seen = {}

    class Page(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen["host"] = self.headers.get("Host")
            body = b"<title>T</title><p>pinned page</p>"
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Page)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:

        async def addresses(host):
            return ["93.184.216.34"]

        real = httpcore.AnyIOBackend

        class Inner:  # the "public" address, served here by the local server
            async def connect_tcp(self, host, port_, timeout=None, local_address=None, socket_options=None):
                assert host == "93.184.216.34"
                return await real().connect_tcp("127.0.0.1", port_, timeout, local_address, socket_options)

            async def sleep(self, seconds):
                await asyncio.sleep(seconds)

        monkeypatch.setattr(code_mentions, "_addresses", addresses)
        monkeypatch.setattr(code_mentions.httpcore, "AnyIOBackend", Inner)
        ((url, doc, why),) = await code_mentions.fetch_all([f"http://site.example:{port}/x"])
        assert why == "" and "pinned page" in doc["data"]
        assert seen["host"] == f"site.example:{port}"
    finally:
        server.shutdown()


# ── searches in threads of their own ──


async def test_searches_never_hold_up_a_file_open(hub, tmp_path, monkeypatch):
    """Each search held a thread of the loop's shared pool for up to 20 s: forty windows'
    made a file open wait 5 s behind them. Now they have threads of their own."""
    root = files(tmp_path / "demo", {"src/app.py": "a\nb\n"})
    hub.tasks.resolve_dir = lambda directory: root
    release = threading.Event()

    def stuck(root, query, stop):
        release.wait(10)
        return {"files": [], "total": 0, "truncated": False, "stopped": bool(stop), "engine": "walk"}

    monkeypatch.setattr(code_search, "search", stuck)
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    try:
        for n in range(40):  # (forty windows: each its own page)
            await hub.handle({"type": "cw_search", "directory": "demo", "text": "x", "ref": f"p{n}-s1"})
        started = time.monotonic()
        await hub.handle({"type": "cw_file_read", "directory": "demo", "path": "src/app.py", "ref": "k"})
        assert await until(lambda: any(k == "cw_file" for k, _ in seen), 400)
        assert time.monotonic() - started < 1.5
    finally:
        release.set()
    assert await until(lambda: sum(k == "cw_search" for k, _ in seen) == 40, 2000)


async def test_one_window_runs_a_few_searches_at_once_and_the_rest_wait_their_turn(
    hub, tmp_path, monkeypatch
):
    """Its split view panes share its connection: of six panes' searches at once, only
    SEARCHES_PER_WINDOW run and the rest wait (round 3, CF3-4: they used to stop the
    oldest); another window's are its own."""
    root = files(tmp_path / "demo", {"a.py": "a\n"})
    hub.tasks.resolve_dir = lambda directory: root
    release = threading.Event()
    stops = {}

    def slow(root, query, stop):
        stops[query.text] = stop
        stop.event.wait(5) if not release.is_set() else None
        return {"files": [], "total": 0, "truncated": False, "stopped": bool(stop), "engine": "walk"}

    monkeypatch.setattr(code_search, "search", slow)
    mine, other = hub.subscribe(), hub.subscribe()

    async def from_window(queue, text, ref):
        ctx = contextvars.copy_context()
        ctx.run(hub_mod.CALLER.set, queue)
        await asyncio.get_running_loop().create_task(
            hub._handle({"type": "cw_search", "directory": "demo", "text": text, "ref": ref}),
            context=ctx,
        )

    await from_window(other, "theirs", "pZ-s1")
    for n in range(code_workspace.SEARCHES_PER_WINDOW + 2):
        await from_window(mine, f"pane{n}", f"~sv{n}~p{n}-s1")
    assert await until(lambda: len(stops) == 1 + code_workspace.SEARCHES_PER_WINDOW, 400)
    await asyncio.sleep(0.3)
    assert len(stops) == 1 + code_workspace.SEARCHES_PER_WINDOW  # the others wait
    assert not any(stop.event.is_set() for stop in stops.values())  # nobody was stopped
    release.set()
    for stop in list(stops.values()):
        stop.set()
    assert await until(lambda: len(stops) == 3 + code_workspace.SEARCHES_PER_WINDOW, 2000)
