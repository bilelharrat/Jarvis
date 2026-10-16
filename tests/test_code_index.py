"""The code index (code_index.py, code_index_mcp.py, features/code_index.py): symbols by
Python's parser and by patterns, which files it reads, updates a file at a time, the hybrid
search with a deterministic embedder, and the tools in Claude and ACP sessions."""

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from code_session_fakes import make_hub, until

from jarvis import acp, code_index
from jarvis import code_index_mcp as cim
from jarvis.features import code_index as fci
from jarvis.tasks import ClaudeTask

# ── a small project ──

APP = '''"""The app."""
import os
from pathlib import Path


def parse_config(path):
    """Read the settings file into a dict."""
    return dict(line.split("=", 1) for line in Path(path).read_text().splitlines())


class Uploader:
    """Sends files to the server."""

    def send(self, name, data):
        return self.post(name, data)

    async def wait_and_try_again(self, attempt: int) -> float:
        """Sleep a little longer after each failure."""
        return 2 ** attempt
'''

WEB = """// The page's helpers.
import { api } from './api.js';

/** Show the cart's total in euros. */
export function renderTotal(cart) {
  return cart.items.reduce((sum, i) => sum + i.price, 0);
}

export const formatPrice = (n) => `€${n}`;

export interface Cart { items: Item[] }

export class CheckoutForm {
  constructor(node) { this.node = node; }

  submitOrder(event) {
    event.preventDefault();
  }
}
"""

SWIFT = """import SwiftUI

/// The login screen.
struct LoginView: View {
    var body: some View { Text("hi") }

    func signIn(user: String) async throws {
    }
}
"""

GO = """package store

import (
\t"fmt"
)

// Store keeps the rows.
type Store struct{}

// Get returns one row.
func (s *Store) Get(id int) string { return fmt.Sprint(id) }

func Open(path string) *Store { return nil }
"""

RUST = """use std::io;

pub struct Pool {}

impl Pool {
    pub fn acquire(&self) -> io::Result<()> { Ok(()) }
}

pub async fn spawn_worker() {}
"""


def make_project(root: Path, git: bool = True) -> Path:
    (root / "src").mkdir(parents=True)
    (root / "web").mkdir()
    (root / "src" / "app.py").write_text(APP)
    (root / "web" / "cart.ts").write_text(WEB)
    (root / "src" / "Login.swift").write_text(SWIFT)
    (root / "src" / "store.go").write_text(GO)
    (root / "src" / "pool.rs").write_text(RUST)
    (root / "README.md").write_text(
        "# Demo\n\nA demo project.\n\n## Uploads\n\nHow uploads work.\n"
    )
    # What's never indexed:
    (root / "node_modules" / "left-pad").mkdir(parents=True)
    (root / "node_modules" / "left-pad" / "index.js").write_text("function leftPad() {}\n")
    (root / "vendor").mkdir()
    (root / "vendor" / "lib.py").write_text("def vendored(): pass\n")
    (root / ".env").write_text("SECRET=1\n")
    (root / "src" / "logo.py").write_bytes(b"\0\1\2binary")
    (root / "web" / "bundle.min.js").write_text("function a(){}\n")
    (root / "web" / "huge.js").write_text("x" * 5000 + "\n")
    (root / "src" / "ignored.py").write_text("def ignored_by_git(): pass\n")
    (root / ".gitignore").write_text("src/ignored.py\n")
    if git:
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t",
             "commit", "-qm", "init"],
            check=True,
        )  # fmt: skip
    return root


CONCEPTS = {  # a dimension each: texts about the same thing come out alike
    0: ("again", "retry", "failure", "attempt", "backoff", "longer"),
    1: ("total", "price", "euros", "cart", "sum"),
    2: ("settings", "config", "dict"),
}


class ConceptEmbedder:
    """Deterministic vectors: a text's weight on each concept, so meaning is testable."""

    def __init__(self, log=None):
        self.log = log if log is not None else []

    def embed(self, texts, timeout=None):
        self.log.extend(texts)
        out = []
        for text in texts:
            low = text.lower()
            vec = np.zeros(code_index.DIM, np.float32)
            for dim, words in CONCEPTS.items():
                vec[dim] = sum(low.count(w) for w in words)
            vec[10] = 0.1  # (never all zeros)
            out.append(("concepts", vec / np.linalg.norm(vec)))
        return out

    def close(self):
        pass


def concept_source(log=None, kind="concepts"):
    return code_index.Source(kind, lambda: ConceptEmbedder(log))


def query(text):
    return ConceptEmbedder().embed([text])[0]


@pytest.fixture
def project(tmp_path):
    return make_project(tmp_path / "proj")


@pytest.fixture
def index(project, tmp_path):
    return code_index.CodeIndex(project, tmp_path / "data" / "idx")


# ── symbols ──


def test_python_symbols_come_from_its_own_parser():
    symbols, imports = code_index.extract(APP, "python")
    got = {(s.qualified(), s.kind, s.line) for s in symbols}
    assert got == {
        ("parse_config", "function", 6),
        ("Uploader", "class", 11),
        ("Uploader.send", "method", 14),
        ("Uploader.wait_and_try_again", "method", 17),
    }
    wait = next(s for s in symbols if s.name == "wait_and_try_again")
    assert wait.signature == "async def wait_and_try_again(self, attempt: int) -> float"
    assert wait.doc == "Sleep a little longer after each failure." and wait.end == 19
    assert imports == ["os", "pathlib"]


def test_other_languages_by_patterns_with_their_classes_and_docs():
    def names(text, lang):
        return {(s.qualified(), s.kind) for s in code_index.extract(text, lang)[0]}

    assert names(WEB, "js") == {
        ("renderTotal", "function"),
        ("formatPrice", "function"),
        ("Cart", "interface"),
        ("CheckoutForm", "class"),
        ("CheckoutForm.constructor", "method"),
        ("CheckoutForm.submitOrder", "method"),
    }
    js, js_imports = code_index.extract(WEB, "js")
    assert next(s for s in js if s.name == "renderTotal").doc == "Show the cart's total in euros."
    assert js_imports == ["./api.js"]
    assert names(SWIFT, "swift") == {("LoginView", "struct"), ("LoginView.signIn", "method")}
    assert next(s for s in code_index.extract(SWIFT, "swift")[0]).doc == "The login screen."
    assert names(GO, "go") == {("Store", "struct"), ("Store.Get", "method"), ("Open", "function")}
    assert code_index.extract(GO, "go")[1] == ["fmt"]
    assert names(RUST, "rust") == {
        ("Pool", "struct"),
        ("Pool", "impl"),
        ("Pool.acquire", "method"),
        ("spawn_worker", "function"),
    }
    # A Python file its parser can't read still has its definitions found.
    assert names("def broken(:\n    pass\nclass Kept:\n    pass\n", "python") == {
        ("broken", "function"),
        ("Kept", "class"),
    }


def test_a_pathological_line_never_hangs_the_patterns():
    import time

    text = ("  " + "a" * 4000 + "(\n") + (" \t" * 3000 + "\n") * 200
    started = time.monotonic()
    for lang in code_index.PATTERNS:
        code_index.extract(text, lang)
    assert time.monotonic() - started < 5


# ── which files ──


def test_only_the_project_s_own_text_files_are_indexed(index):
    index.refresh(code_index.hash_source())
    assert sorted(index.files) == [
        "README.md",
        "src/Login.swift",
        "src/app.py",
        "src/pool.rs",
        "src/store.go",
        "web/cart.ts",
    ]


def test_a_folder_that_isn_t_git_reads_its_gitignore(tmp_path):
    root = make_project(tmp_path / "plain", git=False)
    files, truncated = code_index.list_files(root)
    assert "src/ignored.py" not in files and "src/app.py" in files and not truncated
    assert not any(f.startswith(("node_modules/", "vendor/")) for f in files)


def test_the_index_lives_in_the_app_s_folder_never_the_project(index, project, tmp_path):
    index.refresh(code_index.hash_source())
    assert (index.folder / "index.json").is_file() and (index.folder / "vectors.npz").is_file()
    status = subprocess.run(
        ["git", "-C", str(project), "status", "--porcelain", "--ignored"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert status.strip() == "!! src/ignored.py"  # (only the file the test itself ignores)
    a = code_index.index_folder(tmp_path / "base", project)
    assert a.parent == tmp_path / "base" and a.name.startswith("proj-")
    assert a != code_index.index_folder(tmp_path / "base", tmp_path / "other" / "proj")


# ── up to date, a file at a time ──


def test_only_changed_files_are_read_and_only_new_passages_embedded(index, project):
    log = []
    first = index.refresh(concept_source(log))
    assert first["changed"] == 6 and first["pending"] == 0 and first["embedded"] == len(log)
    log.clear()
    again = index.refresh(concept_source(log))
    assert again["changed"] == 0 and again["embedded"] == 0 and log == []
    app = project / "src" / "app.py"
    app.write_text(APP.replace("self.post(name, data)", "self.post(name, data, retry=True)"))
    third = index.refresh(concept_source(log))
    assert third["changed"] == 1 and third["embedded"] == 1  # that passage; the rest cached
    assert "retry=True" in log[0] and "Uploader.send" in log[0]
    (project / "src" / "store.go").unlink()
    gone = index.refresh(concept_source(log), only=[str(project / "src" / "store.go")])
    assert gone["removed"] == 1 and "src/store.go" not in index.files


def test_it_survives_a_restart_and_a_new_embedder_embeds_again(index, project, tmp_path):
    index.refresh(concept_source())
    vectors = index.status()["vectors"]
    again = code_index.CodeIndex(project, index.folder)
    log = []
    assert again.refresh(concept_source(log))["changed"] == 0 and log == []
    assert again.status()["vectors"] == vectors and again.lookup("parse_config")
    other = again.refresh(code_index.hash_source())
    assert other["changed"] == 6 and again.status()["embedder"] == "hash-v1"
    assert again.status()["vectors"] == other["embedded"] > 0


def test_embedding_is_capped_and_the_rest_waits_for_the_next_update(index):
    first = index.refresh(concept_source(), embed_cap=2)
    assert first["embedded"] == 2 and first["pending"] > 0
    second = index.refresh(concept_source(), embed_cap=1000)
    assert second["embedded"] == first["pending"] and second["pending"] == 0


def test_a_search_is_never_held_up_by_an_update_that_s_embedding(index):
    import threading

    index.refresh(code_index.hash_source())
    gate = threading.Event()

    class Slow(ConceptEmbedder):
        def embed(self, texts, timeout=None):
            gate.wait(5)
            return super().embed(texts, timeout)

    worker = threading.Thread(
        target=index.refresh, args=(code_index.Source("concepts", Slow),), daemon=True
    )
    worker.start()
    try:
        assert index.lookup("parse_config")[0]["path"] == "src/app.py"
        found = code_index.search(index, "renderTotal")
        assert found["results"][0]["symbol"] == "renderTotal"
    finally:
        gate.set()
        worker.join(10)


# ── the hybrid search ──


def test_meaning_finds_code_in_other_words(index):
    index.refresh(concept_source())
    found = code_index.search(index, "back off after a failed attempt", query_vector=query)
    top = found["results"][0]
    assert top["symbol"] == "Uploader.wait_and_try_again" and top["path"] == "src/app.py"
    assert top["line"] == 17 and "meaning" in top["why"]
    assert "async def wait_and_try_again" in top["snippet"]
    assert "meaning" in found["how"]


def test_an_exact_name_ranks_first_and_says_so(index):
    index.refresh(concept_source())
    found = code_index.search(index, "submitOrder", query_vector=query)
    top = found["results"][0]
    assert (
        top["symbol"] == "CheckoutForm.submitOrder"
        and "named CheckoutForm.submitOrder" in top["why"]
    )
    assert top["path"] == "web/cart.ts" and top["line"] == 16


def test_words_find_a_file_changed_a_moment_ago_by_git_grep(index, project):
    index.refresh(concept_source())
    (project / "src" / "app.py").write_text(APP + "\n# zebra crossing handled here\n")
    found = code_index.search(index, "zebra")  # (not re-indexed yet: words still find it)
    assert (
        found["results"][0]["path"] == "src/app.py" and "words: zebra" in found["results"][0]["why"]
    )


def test_a_file_filter_and_the_tool_text(index):
    index.refresh(concept_source())
    found = code_index.search(index, "cart total", include="*.py", query_vector=query)
    assert all(r["path"].endswith(".py") for r in found["results"])
    text = code_index.results_text(code_index.search(index, "renderTotal"), "renderTotal")
    assert "web/cart.ts:5  function renderTotal" in text and "```" in text
    with pytest.raises(code_search_error()):
        code_index.search(index, "   ")


def code_search_error():
    from jarvis.code_search import SearchError

    return SearchError


def test_symbol_lookup_exact_then_by_case_then_partial(index):
    index.refresh(code_index.hash_source())
    assert [s["name"] for s in index.lookup("Uploader.send")] == ["Uploader.send"]
    assert index.lookup("uploader")[0]["name"] == "Uploader"
    assert {s["name"] for s in index.lookup("sign")} == {"LoginView.signIn"}
    assert index.lookup("Store", kind="struct")[0]["path"] == "src/store.go"
    text = code_index.lookup_text(index.lookup("parse_config"), "parse_config")
    assert "function parse_config — src/app.py:6" in text and "Read the settings file" in text
    assert "No symbol" in code_index.lookup_text([], "nothing")


def test_the_hash_embedder_matches_identifier_parts():
    e = code_index.HashEmbedder()
    (_, a), (_, b), (_, c) = (
        e.embed(["parseConfig"])[0],
        e.embed(["parse the config"])[0],
        e.embed(["render the cart"])[0],
    )
    assert float(a @ b) > 0.9 > float(a @ c)
    assert e.embed(["the a of"])[0] == "empty"


# ── the MCP server for ACP agents ──


async def test_the_stdio_server_answers_the_two_tools(index):
    index.refresh(code_index.hash_source())
    server = cim.IndexServer(index.root, index.folder)
    hello = await server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert hello["result"]["serverInfo"]["name"] == "eden_code_index"
    listed = await server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert [t["name"] for t in listed["result"]["tools"]] == ["codebase_search", "symbol_lookup"]
    call = await server.handle(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "symbol_lookup", "arguments": {"name": "Open"}},
        }
    )
    assert "src/store.go:13" in call["result"]["content"][0]["text"]
    assert not call["result"]["isError"]


def test_acp_gets_only_the_stdio_servers_in_its_shape():
    options = SimpleNamespace(
        mcp_servers={
            "jarvis_life": {"type": "sdk", "name": "jarvis_life", "instance": object()},
            "eden_code_index": {
                "type": "stdio",
                "command": "/py",
                "args": ["-c", "x"],
                "env": {"A": "1"},
            },
            "odd": {"type": "stdio", "command": ""},
        }
    )
    assert acp.mcp_servers_for(options) == [
        {
            "name": "eden_code_index",
            "command": "/py",
            "args": ["-c", "x"],
            "env": [{"name": "A", "value": "1"}],
        }
    ]
    assert acp.mcp_servers_for(SimpleNamespace()) == []


# ── in the app ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def options():
    return SimpleNamespace(mcp_servers={}, allowed_tools=["TodoWrite"])


def test_a_claude_session_gets_the_tools_in_process_and_an_acp_one_a_command(hub, project):
    desk = hub.code_index
    claude = ClaudeTask(id=1, prompt="", cwd=project)
    opts = options()
    desk.extend(claude, opts)
    assert opts.mcp_servers[fci.SERVER]["type"] == "sdk" and set(fci.TOOLS) <= set(
        opts.allowed_tools
    )
    other = ClaudeTask(id=2, prompt="", cwd=project, model_ref="acp:codex")
    opts = options()
    desk.extend(other, opts)
    spec = opts.mcp_servers[fci.SERVER]
    assert spec["type"] == "stdio" and spec["command"] == sys.executable
    assert "--root" in spec["args"] and str(project.resolve()) in spec["args"]
    assert opts.allowed_tools == ["TodoWrite"]
    hub.prefs.feature = lambda key: False if key == fci.PREF else None  # the setting off
    opts = options()
    desk.extend(claude, opts)
    assert opts.mcp_servers == {}


async def test_the_command_an_acp_agent_starts_really_serves_the_index(hub, project):
    desk = hub.code_index
    await desk.update(project)
    spec = desk.stdio_server(project)
    lines = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "codebase_search", "arguments": {"query": "parse_config"}},
        },
    ]
    proc = await asyncio.create_subprocess_exec(
        spec["command"],
        *spec["args"],
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(
        proc.communicate("".join(json.dumps(m) + "\n" for m in lines).encode()), 60
    )
    answers = {m["id"]: m for m in map(json.loads, out.decode().splitlines())}
    assert answers[1]["result"]["serverInfo"]["name"] == "eden_code_index", err.decode()
    assert "src/app.py:6  function parse_config" in answers[2]["result"]["content"][0]["text"]


async def test_the_session_tool_and_the_window_search(hub, project):
    desk = hub.code_index
    desk.source_override = concept_source()
    desk.query_override = query
    [codebase_search, symbol_lookup] = desk.tools(project)
    answer = await codebase_search.handler({"query": "retry after a failure"})
    assert "src/app.py:17  method Uploader.wait_and_try_again" in answer["content"][0]["text"]
    looked = await symbol_lookup.handler({"name": "renderTotal"})
    assert "web/cart.ts:5" in looked["content"][0]["text"]
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await desk.cmd_search({"directory": str(project), "text": "cart price total", "ref": "m1"})
    [(kind, got)] = seen
    assert kind == "ci_search" and got["ref"] == "m1" and got["results"]
    assert got["results"][0]["symbol"] == "renderTotal" and "meaning" in got["results"][0]["why"]
    seen.clear()
    await desk.cmd_search({"directory": "/etc", "text": "root", "ref": "m2"})
    assert seen[0][1]["error"] and seen[0][1]["results"] == []


async def test_a_session_s_finished_turn_reindexes_the_files_it_changed(hub, project):
    desk = hub.code_index
    await desk.update(project)
    task = ClaudeTask(id=9, prompt="", cwd=project)
    hub.tasks.tasks[task.id] = task
    (project / "src" / "app.py").write_text(APP + "\ndef brand_new():\n    pass\n")
    desk.finished({"task_kind": "code", "id": 9, "files": [str(project / "src" / "app.py")]})
    index = desk.index_for(project)
    assert await until(lambda: "brand_new" in {s.name for s in index.files["src/app.py"].symbols})


async def test_an_acp_session_is_given_the_index_server_on_session_new(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_code_acp import _hub, _start, _turn

    hub = _hub(settings, quiet_speaker, isolated, tmp_path)
    task = await _start(hub)
    await _turn(hub, task, "say hello")
    logged = [json.loads(line) for line in (tmp_path / "agent.log").read_text().splitlines()]
    [new] = [m for m in logged if m.get("method") == "session/new"]
    # (beside the language servers' one, features/code_lsp.py)
    [server] = [s for s in new["params"]["mcpServers"] if s["name"] == "eden_code_index"]
    assert server["name"] == "eden_code_index" and server["command"] == sys.executable
    assert server["args"][-3] == str((tmp_path / "proj").resolve())
    from code_session_fakes import end_all

    await end_all(hub)


# ── odd folders: links out of the project, named pipes, odd names (round-1 breaks) ──

OUTSIDE = "def outside_secret_token_xyzzy():\n    return 'TOPSECRET-OUTSIDE'\n"


def _commit(root):
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t",
         "commit", "-qm", "x"],
        check=True,
    )  # fmt: skip


def _swap_for_link(folder, outside):
    import shutil

    shutil.rmtree(folder)
    folder.symlink_to(outside, target_is_directory=True)


def test_a_tracked_folder_swapped_for_a_link_out_is_never_read(tmp_path):
    """I1: git still lists pkg/a.py once pkg is a link to a folder outside; its a.py was
    indexed and shown. And I1b: indexed first, then swapped: the snippet read it."""
    root = tmp_path / "proj"
    (root / "pkg").mkdir(parents=True)
    (root / "pkg" / "a.py").write_text("def outside_secret_token_xyzzy():\n    return 1\n")
    _commit(root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "a.py").write_text(OUTSIDE)
    idx = code_index.CodeIndex(root, tmp_path / "data")
    idx.refresh(code_index.hash_source())
    _swap_for_link(root / "pkg", outside)
    found = code_index.search(idx, "outside_secret_token_xyzzy")  # (no refresh: I1b)
    assert not any("TOPSECRET" in r["snippet"] for r in found["results"])
    fresh = code_index.CodeIndex(root, tmp_path / "data2")
    fresh.refresh(code_index.hash_source())
    names = {s.name for e in fresh.files.values() for s in e.symbols}
    assert "pkg/a.py" not in fresh.files and "outside_secret_token_xyzzy" not in names
    fresh.refresh(code_index.hash_source(), only=["pkg/a.py"])
    assert "pkg/a.py" not in fresh.files


def _within(fn, fifo, seconds=10):
    """fn() on a thread; a read stuck on the pipe fails the test instead of hanging it."""
    import concurrent.futures
    import contextlib
    import os

    pool = concurrent.futures.ThreadPoolExecutor(1)
    future = pool.submit(fn)
    try:
        return future.result(timeout=seconds)
    finally:
        with contextlib.suppress(OSError):  # (a writer lets a stuck read end)
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        pool.shutdown(wait=False)


@pytest.mark.parametrize("git_repo", [False, True], ids=["folder", "git"])
def test_a_named_pipe_where_a_file_was_never_hangs_an_update(tmp_path, git_repo):
    """I8: a .py that's a named pipe (untracked, or a tracked file replaced by one) looked
    0 bytes long, then its read waited for a writer for good, with the update lock held."""
    import os

    root = tmp_path / "proj"
    root.mkdir()
    (root / "a.py").write_text("def alpha_func(): pass\n")
    (root / "p.py").write_text("def p(): pass\n")
    if git_repo:
        _commit(root)
    (root / "p.py").unlink()
    os.mkfifo(root / "p.py")
    idx = code_index.CodeIndex(root, tmp_path / "data")
    _within(lambda: idx.refresh(code_index.hash_source()), root / "p.py")
    assert set(idx.files) == {"a.py"}
    os.mkfifo(root / "z.py")  # I8b: and the word search walks past one
    found = _within(lambda: code_index.search(idx, "alpha_func"), root / "z.py")
    assert [r["path"] for r in found["results"]] == ["a.py"]


async def test_a_named_pipe_never_wedges_the_window_s_search(hub, tmp_path):
    """I8c: through the window, the update thread never ended: the desk stayed busy."""
    import os
    import time

    root = tmp_path / "proj"
    root.mkdir()
    (root / "a.py").write_text("def alpha_func(): pass\n")
    os.mkfifo(root / "b.py")
    seen = []
    hub.emit = lambda kind, **d: seen.append((kind, d))
    started = time.monotonic()
    try:
        await asyncio.wait_for(
            hub.code_index.cmd_search({"directory": str(root), "text": "alpha_func", "ref": "1"}),
            20,
        )
    finally:
        took, busy = time.monotonic() - started, dict(hub.code_index._busy)
        import contextlib

        with contextlib.suppress(OSError):
            os.close(os.open(root / "b.py", os.O_WRONLY | os.O_NONBLOCK))
    assert took < 10 and not busy


def test_a_nul_in_the_file_filter_is_an_error_said(index):
    """I9: it raised ValueError out of the tool (subprocess can't carry a NUL)."""
    index.refresh(code_index.hash_source())
    text, err = cim.run_tool(index, "codebase_search", {"query": "parse_config", "files": "a\0"})
    assert err and "NUL" in text


def test_a_file_name_with_a_newline_gives_no_phantom_match(tmp_path):
    """I10: git grep -z's output split by lines made "new<newline>line.py" a match in a
    "line.py" that isn't there."""
    from jarvis import code_search

    root = tmp_path / "proj"
    root.mkdir()
    (root / "new\nline.py").write_text("def odd_name_func(): pass\n")
    (root / "plain.py").write_text("def odd_name_func(): pass\n")
    _commit(root)
    found = code_search.search(root, code_search.Query("odd_name_func"))
    assert sorted(f["path"] for f in found["files"]) == ["new\nline.py", "plain.py"]


def test_a_walk_stopped_by_the_time_says_so_and_removes_nothing(tmp_path):
    """F4: a folder that isn't git, walked out of time, said truncated False, and the
    update dropped every file the walk hadn't reached (15 of them, in the break)."""
    root = make_project(tmp_path / "plain", git=False)
    idx = code_index.CodeIndex(root, tmp_path / "data")
    idx.refresh(code_index.hash_source())
    before = set(idx.files)
    assert len(before) > 3
    ticks = iter(range(10**6))
    out = idx.refresh(code_index.hash_source(), seconds=0, clock=lambda: next(ticks))
    assert out["removed"] == 0 and set(idx.files) == before and out["truncated"]
    files, truncated = code_index.list_files(root, stop=lambda: True)
    assert truncated and files == []


# ── indexes whose project is gone (F5) ──


def test_an_index_whose_project_is_gone_goes_after_a_while_or_at_once(tmp_path):
    import os
    import shutil

    base = tmp_path / "base"
    roots = {}
    for name in ("kept", "gone", "copy", "busy"):
        roots[name] = make_project(tmp_path / name, git=False)
        idx = code_index.CodeIndex(roots[name], code_index.index_folder(base, roots[name]))
        idx.refresh(code_index.hash_source())
    for name in ("gone", "copy", "busy"):
        shutil.rmtree(roots[name])
    copy_root = str(roots["copy"].resolve())
    busy_root = str(roots["busy"].resolve())
    removed = code_index.tidy(
        base, in_use={busy_root}.__contains__, gone_now=lambda r: r == copy_root
    )
    assert removed == [copy_root]  # at once; the other gone one waits STALE_DAYS
    later = code_index.tidy(base, in_use={busy_root}.__contains__, now=lambda: 1e12)
    assert later == [str(roots["gone"].resolve())]
    left = {code_index.root_of(f) for f in base.iterdir()}
    assert left == {str(roots["kept"].resolve()), busy_root}
    assert os.path.isdir(roots["kept"])


async def test_an_isolated_copy_s_index_goes_with_the_copy(hub, tmp_path):
    import shutil

    desk = hub.code_index
    copy = make_project(Path(hub.code_desk.root) / "proj-copy", git=False)
    await desk.update(copy)
    folder = desk.index_for(copy).folder
    assert folder.is_dir()
    shutil.rmtree(copy)
    hub.code_desk.gone("proj-copy")  # landed or discarded
    assert await until(lambda: not folder.exists())
    assert str(copy.resolve()) not in desk.indexes


async def test_the_stdio_server_reads_an_index_saved_after_it_started(project, tmp_path):
    """F6: started before the app's first save, it marked the index loaded with nothing in
    it and answered an empty index for the whole session; and it never saw an update."""
    folder = tmp_path / "data" / "idx"
    server = cim.IndexServer(project, folder)

    async def lookup(name):
        call = await server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "symbol_lookup", "arguments": {"name": name}}}
        )  # fmt: skip
        return call["result"]["content"][0]["text"]

    assert "src/store.go" not in await lookup("Open")  # nothing saved yet
    app = code_index.CodeIndex(project, folder)
    app.refresh(code_index.hash_source())
    assert "src/store.go:13" in await lookup("Open")
    (project / "src" / "late.py").write_text("def arrived_later():\n    pass\n")
    app.refresh(code_index.hash_source())
    assert "src/late.py" in await lookup("arrived_later")


# ── the stdio server's edges (coverage) ──


def test_the_tools_say_what_s_missing_and_name_no_tool_that_isn_t(index):
    index.refresh(code_index.hash_source())
    assert cim.run_tool(index, "symbol_lookup", {"name": "  "}) == (
        "Which symbol? Give its name.",
        True,
    )
    assert cim.run_tool(index, "nope", {}) == ("No tool named nope.", True)
    text, err = cim.run_tool(index, "codebase_search", {"query": ""})
    assert err and text


def test_the_stdio_server_s_query_vectors_follow_the_index_s_embedder(index):
    index.refresh(code_index.hash_source())
    server = cim.IndexServer(index.root, index.folder)
    vector = server.query_vector("parse the config")
    assert vector is not None and vector[0] == "hash-v1"
    assert server.query_vector("again")[0] == "hash-v1"  # (the same embedder kept)


def test_main_serves_the_index_it_s_given(index, monkeypatch):
    served = []

    async def run(server):
        served.append((server.index.root, server.index.folder))

    monkeypatch.setattr(cim, "_run_stdio", run)
    cim.main(["--root", str(index.root), "--index", str(index.folder)])
    assert served == [(index.root, index.folder)]
