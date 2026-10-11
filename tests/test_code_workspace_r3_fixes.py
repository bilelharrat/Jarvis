"""Round 3 fixes for Eden Code's workspace (askeden/docs/bug-sweep/r3-eden-code-workspace.md,
CF3-1...CF3-16): saves of one file at the same moment (CF3-1), searches from several panes of
one window (CF3-4), terminal answers to the asking window (CF3-10), URL mention limits and
wording (CF3-13), the export folder and User-Agent (CF3-14), and one shared relist for
concurrent fresh file-list asks."""

import threading
import time

from jarvis import code_editor
from jarvis.code_editor import read, save


def test_cf3_1_thirty_saves_from_one_version_at_once_make_one_save_and_29_conflicts(tmp_path, monkeypatch):
    (tmp_path / "race.txt").write_text("start\n")
    base = read(tmp_path, "race.txt")["version"]
    # Widen the window between the version check and the write, as a busy Mac does.
    checked = code_editor.same_version

    def slow_check(path, base):
        ok = checked(path, base)
        time.sleep(0.01)
        return ok

    monkeypatch.setattr(code_editor, "same_version", slow_check)
    go = threading.Barrier(30)
    answers = [None] * 30

    def one(i):
        go.wait()
        answers[i] = save(tmp_path, "race.txt", f"pane {i}\n", base)

    threads = [threading.Thread(target=one, args=(i,)) for i in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    saved = [a for a in answers if a.get("ok")]
    assert len(saved) == 1
    assert sum(1 for a in answers if a.get("conflict")) == 29
    winner = answers.index(saved[0])
    assert (tmp_path / "race.txt").read_text() == f"pane {winner}\n"


# ── a window's searches (CF3-4) ──

import asyncio  # noqa: E402
import contextvars  # noqa: E402

import pytest  # noqa: E402
from code_session_fakes import make_hub, until  # noqa: E402

from jarvis import code_search  # noqa: E402
from jarvis import hub as hub_mod  # noqa: E402
from jarvis.features import code_workspace  # noqa: E402


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def files(root, tree):
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in tree.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    return root


async def from_window(hub, queue, msg):
    ctx = contextvars.copy_context()
    ctx.run(hub_mod.CALLER.set, queue)
    await asyncio.get_running_loop().create_task(hub._handle(msg), context=ctx)


def drain(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev.get("type") == kind:
            out.append(dict(ev))
    return out


async def test_cf3_4_six_panes_searching_at_once_all_get_their_matches(hub, tmp_path, monkeypatch):
    root = files(tmp_path / "demo", {f"f{n}.py": "needle\n" for n in range(4)})
    hub.tasks.resolve_dir = lambda directory: root
    real = code_search.search
    running, most = [0], [0]
    lock = threading.Lock()

    def slowish(root, query, stop):
        with lock:
            running[0] += 1
            most[0] = max(most[0], running[0])
        time.sleep(0.3)
        try:
            return real(root, query, stop)
        finally:
            with lock:
                running[0] -= 1

    monkeypatch.setattr(code_search, "search", slowish)
    window = hub.subscribe()
    for n in range(6):  # six panes of one window: one connection, six pages
        await from_window(hub, window, {"type": "cw_search", "directory": "demo", "text": "needle", "ref": f"~sv{n}~p{n}-s1"})
    got = []
    assert await until(lambda: got.extend(drain(window, "cw_search")) or len(got) == 6, 5000)
    assert sorted(ev["ref"] for ev in got) == sorted(f"~sv{n}~p{n}-s1" for n in range(6))
    assert all(ev["total"] == 4 and not ev.get("stopped") for ev in got)
    assert most[0] <= code_workspace.SEARCHES_PER_WINDOW  # still a few at once per window


async def test_cf3_4_a_waiting_search_is_still_stopped_by_its_own_page_s_newer_one(hub, tmp_path, monkeypatch):
    root = files(tmp_path / "demo", {"a.py": "needle\n"})
    hub.tasks.resolve_dir = lambda directory: root
    release = threading.Event()

    def stuck(root, query, stop):
        release.wait(5)
        return {"files": [], "total": 0, "truncated": False, "stopped": False, "engine": "walk"}

    monkeypatch.setattr(code_search, "search", stuck)
    window = hub.subscribe()
    try:
        for n in range(code_workspace.SEARCHES_PER_WINDOW):
            await from_window(hub, window, {"type": "cw_search", "directory": "demo", "text": "x", "ref": f"busy{n}-s1"})
        await from_window(hub, window, {"type": "cw_search", "directory": "demo", "text": "x", "ref": "late-s1"})
        await asyncio.sleep(0.1)
        await from_window(hub, window, {"type": "cw_search", "directory": "demo", "text": "xy", "ref": "late-s2"})
        got = []
        assert await until(lambda: got.extend(drain(window, "cw_search")) or any(e["ref"] == "late-s1" for e in got), 2000)
        first = next(e for e in got if e["ref"] == "late-s1")
        assert first["stopped"] is True and first["total"] == 0
    finally:
        release.set()


# ── terminal notes to the asking window (CF3-10) ──


async def test_cf3_10_a_new_terminal_and_a_still_running_note_go_to_the_asking_window_only(
    hub, tmp_path, monkeypatch
):
    monkeypatch.setenv("SHELL", "/bin/zsh")
    (tmp_path / "proj").mkdir()
    hub.tasks.resolve_dir = lambda directory: tmp_path / "proj"
    mine, other = hub.subscribe(), hub.subscribe()
    try:
        await from_window(hub, mine, {"type": "cw_term_new", "directory": "proj", "ref": "task:proj"})
        new = []
        assert await until(lambda: new.extend(drain(mine, "cw_term_new")) or new, 4000)
        assert drain(other, "cw_term_new") == []  # the other window's view stays where it is
        term = new[0]["term"]
        shell = hub.code_terminal.shells.get(term)
        await from_window(hub, mine, {"type": "cw_term_input", "term": term, "data": "sleep 60\r"})
        assert await until(lambda: "sleep" in shell.busy(), 6000)
        await from_window(hub, mine, {"type": "cw_term_close", "term": term, "ref": term})
        busy = []
        assert await until(lambda: busy.extend(drain(mine, "cw_term_busy")) or busy, 4000)
        assert busy[0]["ref"] == term and "sleep" in busy[0]["what"]
        assert drain(other, "cw_term_busy") == []  # no armed one-click close over there
    finally:
        for s in list(hub.code_terminal.shells.of(tmp_path / "proj")):
            hub.code_terminal.shells.close(s.id)


# ── URL mentions: a 4th one, error words, User-Agent (CF3-13, CF3-14) ──

import httpx  # noqa: E402

from jarvis import code_mentions  # noqa: E402
from jarvis.tasks import ClaudeTask  # noqa: E402


@pytest.fixture
def public_names(monkeypatch):
    async def public(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(code_mentions, "_addresses", public)


async def test_cf3_13_a_fourth_page_mentioned_is_said_not_dropped_silently(hub, tmp_path, public_names):
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    calls = []
    hub.tasks.send = lambda task_id, text, images=None, **kw: calls.append((task_id, text, images))
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    agents = []

    def page(request):
        agents.append(request.headers.get("user-agent", ""))
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"hello")

    hub.code_mentions.transport = httpx.MockTransport(page)
    urls = [f"https://site{n}.example/" for n in range(4)]
    await hub.handle({"type": "task_send", "id": 7, "text": "read " + " ".join(f"@{u}" for u in urls)})
    assert await until(lambda: calls, 2000)
    notes = [d["text"] for k, d in events if k == "cw_mentions"]
    assert "Only three pages are read per message: https://site3.example/ wasn't." in notes
    assert len(agents) == 3
    assert all(a.endswith(" Eden") and "Jarvis" not in a for a in agents)  # (CF3-14)
    assert code_mentions.parse(" ".join(f"@{u}" for u in urls)).dropped == urls[3:]


def test_cf3_13_why_a_page_couldnt_be_reached_is_in_words():
    request = httpx.Request("GET", "https://x.example/")
    cases = {
        httpx.ConnectError("[Errno 61] Connection refused", request=request): "The site refused the connection.",
        httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED]", request=request): "A secure connection to the site couldn't be made.",
        httpx.ReadTimeout("timed out", request=request): "The site didn't answer in time.",
        httpx.ConnectError("boom", request=request): "Couldn't connect to the site.",
        httpx.RemoteProtocolError("closed", request=request): "The site closed the connection.",
    }
    for exc, words in cases.items():
        said = code_mentions._unreachable(exc)
        assert said == words and type(exc).__name__ not in said


async def test_cf3_13_a_fetch_error_shows_words_not_a_class_name(public_names):
    def broken(request):
        raise httpx.ConnectError("[Errno 61] Connection refused", request=request)

    ((url, doc, why),) = await code_mentions.fetch_all(["https://down.example/"], httpx.MockTransport(broken))
    assert doc is None and why == "The site refused the connection."


# ── the export folder (CF3-14) ──

from jarvis import tasks as tasks_mod  # noqa: E402
from jarvis.features import code_export as export_feature  # noqa: E402


def test_cf3_14_exports_go_to_documents_eden_code_and_the_old_folder_moves_in(tmp_path, monkeypatch):
    assert tasks_mod.EXPORT_DIR.parts[-2:] == ("Documents", "Eden Code")
    docs = tmp_path / "Documents"
    old = docs / "Jarvis" / "Eden Code"
    old.mkdir(parents=True)
    (old / "2026-10-01 0900 Before.html").write_text("kept")
    monkeypatch.setattr(tasks_mod, "EXPORT_DIR", docs / "Eden Code")
    assert tasks_mod.old_export_dir() == old
    written = export_feature._write("2026-10-11 1200 After", ".html", b"new")
    assert written.parent == docs / "Eden Code"
    assert (docs / "Eden Code" / "2026-10-01 0900 Before.html").read_text() == "kept"
    assert not old.exists()


def test_cf3_14_when_both_folders_exist_nothing_is_moved_or_lost(tmp_path, monkeypatch):
    docs = tmp_path / "Documents"
    (docs / "Jarvis" / "Eden Code").mkdir(parents=True)
    (docs / "Jarvis" / "Eden Code" / "old.md").write_text("old")
    (docs / "Eden Code").mkdir()
    monkeypatch.setattr(tasks_mod, "EXPORT_DIR", docs / "Eden Code")
    assert tasks_mod.export_dir() == docs / "Eden Code"
    assert (docs / "Jarvis" / "Eden Code" / "old.md").read_text() == "old"


async def test_cf3_14_show_in_finder_still_works_for_an_export_in_the_old_folder(hub, tmp_path, monkeypatch):
    docs = tmp_path / "Documents"
    (docs / "Eden Code").mkdir(parents=True)
    old = docs / "Jarvis" / "Eden Code"
    old.mkdir(parents=True)
    (old / "a.html").write_text("x")
    monkeypatch.setattr(tasks_mod, "EXPORT_DIR", docs / "Eden Code")
    opened = []

    async def run_command(*args, **kw):
        opened.append(args)

    monkeypatch.setattr(export_feature.mac_tools, "run_command", run_command)
    await export_feature.Exports(hub).cmd_reveal({"path": str(old / "a.html")})
    await export_feature.Exports(hub).cmd_reveal({"path": str(tmp_path / "elsewhere.html")})
    assert opened == [("open", "-R", str((old / "a.html").resolve()))]
