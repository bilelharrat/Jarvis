"""Bring over from another coding tool (code_import, import_sources/*, features/code_import):
every adapter finds its tool in a fake home folder and lists what it has, with no secret ever
in what the window sees; Import brings the ticked things into Eden Code (projects, MCP servers,
rules, saved prompts, defaults, past chats), the same import twice adds nothing twice, Undo
takes away exactly that, and not one file of any tool's ever changes."""

import json
import logging
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from code_session_fakes import events_of, make_hub, until
from import_fixtures import SECRET, SECRET2, SECRET3, SECRETS, SESSION, build, tree_hash

from jarvis import code_import as ci
from jarvis import import_mcp_launch
from jarvis.features import code_import as feature

KNOWN = {"opus", "sonnet", "haiku", "fable"}


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    for var in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "APPDATA", "XDG_CONFIG_HOME"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(home))  # (Path.home(), and the ~ the window is shown)
    return home


@pytest.fixture
def tree(home):
    return build(home)


def ctx(tree, **kw):
    return ci.Context(known_model=lambda r: r in KNOWN, folders=[tree["alpha"], tree["beta"]], **kw)


def _scan(source_id, home, tree, **kw):
    return {
        i.id: i
        for i in ci.scan(ci.source_by_id(source_id), ci.Env(home, "darwin"), ctx(tree, **kw))
    }


def _public(items):
    return json.dumps([i.public() for i in (items.values() if isinstance(items, dict) else items)])


# ── finding things ──


def test_every_tool_is_found_and_read_without_an_error_or_a_secret(home, tree):
    env = ci.Env(home, "darwin")
    ids = [s.id for s in ci.sources()]
    assert ids[0] == "claude_code"
    assert set(ids) >= {"codex", "cursor", "windsurf", "copilot", "gemini", "cline", "roo_code", "aider",
                        "zed", "opencode", "continue", "amp", "kiro", "warp", "junie"}  # fmt: skip
    for source in ci.sources():
        assert ci.detect(source, env), source.id
        items = ci.scan(source, env, ctx(tree))
        assert items, source.id
        assert not [i for i in items if i.status == "error"], source.id
        blob = _public(items)
        assert not any(s in blob for s in SECRETS), source.id
        assert {i.status for i in items} <= set(ci.STATUSES)


def test_nothing_is_found_in_an_empty_home(home):
    env = ci.Env(home, "darwin")
    assert not [s.id for s in ci.sources() if ci.detect(s, env)]


def test_claude_code_shows_what_already_works_and_brings_the_rest(home, tree):
    items = _scan("claude_code", home, tree)
    assert items["signin"].status == "already"
    alpha = items[f"project:{tree['alpha']}"]
    assert alpha.status == "new" and alpha.count == 1 and "1 past conversation" in alpha.detail
    assert items[f"project:{tree['gone']}"].status == "skip"  # not there any more
    assert items[f"project:{tree['worktree']}"].status == "skip"  # a working copy
    assert items["chats:claude_code"].status == "already"
    for key in ("rules:claude-user", "setting:permissions", "setting:hooks", "setting:env", "setting:outputStyle",
                "setting:commands", "setting:agents", "setting:skills", "mcp:gh", "mcp:local", "mcp:projects"):  # fmt: skip
        assert items[key].status == "already", key
    assert (
        items["setting:statusLine"].status == "skip"
        and items["setting:keybindings"].status == "skip"
    )
    assert items["model:sonnet"].status == "new" and items["model:sonnet"].payload == {
        "pref": "code_model",
        "value": "sonnet",
    }
    assert items["setting:mode:acceptEdits"].payload == {"pref": "code_mode", "value": "edits"}
    assert "API_TOKEN" in items["setting:env"].detail and SECRET not in _public(items)
    # Eden signs in with a key, or Claude Code isn't signed in: the owner's step, through Eden's own sign-in.
    assert _scan("claude_code", home, tree, using_key=True)["signin"].status == "manual"
    assert _scan("claude_code", home, tree, signed_in=False)["signin"].status == "manual"


def test_mcp_keys_are_masked_and_only_move_when_ticked(home, tree):
    codex = _scan("codex", home, tree)
    search = codex["mcp:search"]
    assert search.status == "new" and search.public()["checked"] is False
    assert search.secrets == ["SEARCH_API_KEY"] and "SEARCH_API_KEY" in search.why
    assert search.payload["spec"] == {
        "type": "stdio",
        "command": "search-mcp",
        "args": ["--fast"],
        "env": {"REGION": "eu"},
    }
    assert SECRET3 not in _public(codex)
    wind = _scan("windsurf", home, tree)
    assert wind["mcp:wind"].status == "manual" and "header" in wind["mcp:wind"].why
    assert wind["mcp:wind-ok"].public()["checked"] is True
    vs = _scan("copilot", home, tree)
    assert "VS_PAT" in vs["mcp:fs"].why and "VS_PAT" not in vs["mcp:fs"].payload["spec"].get(
        "env", {}
    )
    assert vs["mcp:vs-web"].payload["spec"] == {
        "type": "http",
        "url": "https://web.example.com/mcp",
    }  # (JSONC)
    zed = _scan("zed", home, tree)["mcp:zz"]
    assert zed.payload["spec"]["command"] == "zz-mcp" and zed.secrets == ["ZZ_TOKEN"]
    oc = _scan("opencode", home, tree)["mcp:oc"]
    assert oc.payload["spec"] == {
        "type": "stdio",
        "command": "oc-mcp",
        "args": ["--x"],
        "env": {"A": "b"},
    }
    assert _scan("cline", home, tree)["mcp:cl"].public()["checked"] is False  # off in Cline
    assert "mcp:ampy" in _scan("amp", home, tree)  # ("amp.mcpServers" is one key)


@pytest.mark.parametrize(("config", "want"), [
    ({"command": "x", "args": ["--token", SECRET2]}, "manual"),
    ({"url": f"https://u:{SECRET}@h.example.com/mcp"}, "manual"),
    ({"url": "ftp://h.example.com"}, "manual"),
    ({"transport": {"type": "stdio", "command": "t", "args": ["a"]}}, "new"),
    ({"url": "https://h.example.com/mcp", "headers": {"Authorization": "Bearer ${env:TOKEN}"}}, "new"),
    ({"url": "https://h.example.com", "bearer_token_env_var": "GH"}, "new"),
    ("not a config", "manual"),
])  # fmt: skip
def test_every_tool_s_server_shapes(config, want):
    item = ci.mcp_items("t", {"srv": config}, "here", ci.Context())[0]
    assert item.status == want
    assert not any(s in json.dumps(item.public()) for s in SECRETS)
    if want == "new" and "headers" in config:
        assert item.payload["spec"]["headers"] == {"Authorization": "Bearer ${TOKEN}"}
    if want == "new" and "bearer_token_env_var" in config:
        assert item.payload["spec"]["headers"] == {"Authorization": "Bearer ${GH}"}


def test_damaged_and_odd_files_fail_soft_one_item_each(home, tree):
    (home / ".cursor" / "mcp.json").write_text("{damaged")
    (home / ".codex" / "config.toml").write_text("not = [toml")
    (
        home.joinpath(
            *("Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
        )
    ).write_bytes(b"not sqlite")
    cursor = _scan("cursor", home, tree)
    errors = [i for i in cursor.values() if i.status == "error"]
    assert len(errors) == 2 and all("Couldn't" in i.why for i in errors)
    assert f"rules:{tree['alpha'] / '.cursorrules'}" in cursor  # the rest still loads
    codex = _scan("codex", home, tree)
    assert [i.title for i in codex.values() if i.status == "error"] == ["config.toml"]
    assert "command:fix" in codex
    broken = ci.Source("broken", "Broken", lambda e: [home], lambda e, c: 1 / 0)
    assert [i.status for i in ci.scan(broken, ci.Env(home), ci.Context())] == ["error"]


def test_jsonc_and_paths():
    assert json.loads(ci.strip_jsonc('{"a": "http://x//y", /* c */ "b": [1,2,], // end\n}')) == {
        "a": "http://x//y",
        "b": [1, 2],
    }
    assert ci.file_uri("file:///Users/a/my%20proj") == Path("/Users/a/my proj")
    assert ci.file_uri("vscode-remote://ssh/x") is None
    assert (
        ci.env_ref("${env:A}") == "A" and ci.env_ref("$B") == "B" and ci.env_ref("{env:C}") == "C"
    )
    assert ci.env_ref("plain") is None
    assert ci.snippet_name("Git/Commit Msg") == "git-commit-msg" and ci.snippet_name("--") == ""


def test_past_chats_are_read_back_from_each_tool(home, tree):
    for source_id, first in (("codex", "rename the module"), ("cursor", "fix the login"), ("copilot", "explain this"),
                             ("gemini", "hello gemini"), ("cline", "<task>add docs</task>"), ("aider", "make it faster"),
                             ("continue", "hey")):  # fmt: skip
        item = _scan(source_id, home, tree)[f"chats:{source_id}"]
        assert item.status == "new" and item.count == 1, source_id
        entry = item.payload["chats"][0]
        messages = ci.source_by_id(source_id).read_chat(entry)
        assert messages[0] == {"role": "user", "text": first}, source_id
        assert messages[1]["role"] == "assistant", source_id
    assert (
        _scan("codex", home, tree)["chats:codex"].payload["chats"][0]["title"]
        == "rename the module"
    )


def test_cursor_agent_chats_are_read_from_its_transcripts(home, tree):
    """The Cursor of 2026 keeps its agent chats as ~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl
    (Claude-style turns, the question inside <user_query>); a subagent's own record is not a chat."""
    folder = home / ".cursor" / "projects" / "Users-x-code-alpha" / "agent-transcripts" / "c0ffee"
    turns = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<timestamp>Mon</timestamp>\n<user_query>\nadd a retry\n</user_query>"}]}},
        {"role": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
        {"role": "assistant", "message": {"content": [{"type": "text", "text": "Added a retry."}, {"type": "tool_use", "name": "Edit", "input": {}}]}},
        {"status": "done", "type": "result"},
    ]  # fmt: skip
    folder.mkdir(parents=True)
    (folder / "c0ffee.jsonl").write_text("\n".join(json.dumps(t) for t in turns) + "\n")
    (folder / "subagents").mkdir()
    (folder / "subagents" / "sub1.jsonl").write_text(json.dumps(turns[0]) + "\n")
    item = _scan("cursor", home, tree)["chats:cursor"]
    assert item.count == 2  # (the database's chat and this one; the subagent's record is not a third)
    entry = next(c for c in item.payload["chats"] if c.get("agent"))
    assert entry["title"] == "add a retry"
    assert ci.source_by_id("cursor").read_chat(entry) == [
        {"role": "user", "text": "add a retry"},
        {"role": "assistant", "text": "Added a retry."},
    ]


# ── into Eden Code, and back out ──


def _hub(settings, quiet_speaker, isolated, home, tree):
    hub = make_hub(replace(settings, projects_dir=home / "Projects"), quiet_speaker, isolated)
    hub.code_import.home = home
    hub.code_import.platform = "darwin"

    async def yes():
        return True

    async def no_git(*_args, **_kw):
        return ""

    hub.code_import.signed_in = yes
    hub._git = no_git  # (the projects' overview: no git runs in these tests)
    return hub


async def _ask(hub, seen, msg, answer):
    # (An answer for this tool: an import's own fresh preview can still be on its way when the
    # next tool's preview is asked for, and must not be taken for that one.)
    def mine():
        return [e for e in seen() if e["type"] == answer and e.get("source", msg.get("source")) == msg.get("source")]

    before = len(mine())
    await hub._handle(msg)
    assert await until(lambda: len(mine()) > before, 2000)
    return mine()[-1]


def _ticked(preview, also=()):
    return [i["id"] for i in preview["items"] if i["checked"] or i["id"] in also]


async def test_import_is_idempotent_and_undo_takes_back_exactly_that(
    settings, quiet_speaker, isolated, home, tree, caplog
):
    caplog.set_level(logging.DEBUG)
    before = tree_hash(home)
    hub = _hub(settings, quiet_speaker, isolated, home, tree)
    seen = events_of(hub)
    hub.set_feature_prefs({"code_snippets": [{"name": "mine", "text": "My own."}]})
    found = await _ask(hub, seen, {"type": "cimp_sources"}, "cimp_sources")
    assert {s["id"] for s in found["sources"] if s["found"]} >= {"claude_code", "codex", "cursor"}
    # Claude Code: the project, Eden's default model and mode.
    preview = await _ask(
        hub, seen, {"type": "cimp_preview", "source": "claude_code"}, "cimp_preview"
    )
    assert preview["counts"]["new"] == 3 and SECRET not in json.dumps(preview)
    done = await _ask(
        hub,
        seen,
        {"type": "cimp_import", "source": "claude_code", "items": _ticked(preview)},
        "cimp_done",
    )
    assert {a["kind"] for a in done["added"]} == {"project", "model"}
    assert hub.prefs.feature("code_project_folders") == [str(tree["alpha"])]
    assert (hub.prefs.code_model, hub.prefs.code_mode) == ("sonnet", "edits")
    assert "alpha" in hub.tasks.projects()
    again = await _ask(hub, seen, {"type": "cimp_preview", "source": "claude_code"}, "cimp_preview")
    status = {i["id"]: i["status"] for i in again["items"]}
    assert status[f"project:{tree['alpha']}"] == "added" and status["model:sonnet"] == "already"
    assert "new" not in again["counts"]
    await _ask(
        hub,
        seen,
        {"type": "cimp_import", "source": "claude_code", "items": _ticked(preview)},
        "cimp_done",
    )
    assert hub.prefs.feature("code_project_folders") == [str(tree["alpha"])]  # not twice
    # Codex: its server with its key (ticked), a saved prompt, rules, past chats.
    preview = await _ask(hub, seen, {"type": "cimp_preview", "source": "codex"}, "cimp_preview")
    done = await _ask(hub, seen, {"type": "cimp_import", "source": "codex",
                                  "items": _ticked(preview, also=("mcp:search",))}, "cimp_done")  # fmt: skip
    assert {a["title"] for a in done["added"]} >= {"search", "/fix", "Codex AGENTS.md", "beta"}
    assert {m["title"] for m in done["manual"]} >= {"Default model: gpt-5-codex", "Provider azure"}
    vault = hub.connectors.vault
    assert vault.get("code-import:search", "SEARCH_API_KEY") == SECRET3
    assert [s["name"] for s in hub.prefs.feature("code_snippets")] == ["mine", "fix"]
    ledger_text = (hub.feature_path("code-import.json")).read_text()
    assert not any(s in ledger_text for s in SECRETS)
    again = await _ask(hub, seen, {"type": "cimp_preview", "source": "codex"}, "cimp_preview")
    assert {i["id"]: i["status"] for i in again["items"]}["mcp:search"] == "added"
    await _ask(
        hub,
        seen,
        {"type": "cimp_import", "source": "codex", "items": _ticked(preview, ("mcp:search",))},
        "cimp_done",
    )
    assert [s["name"] for s in hub.prefs.feature("code_snippets")] == ["mine", "fix"]  # not twice
    history = await _ask(hub, seen, {"type": "cimp_history"}, "cimp_history")
    assert [c["title"] for c in history["chats"]] == ["rename the module"]
    chat = await _ask(
        hub,
        seen,
        {"type": "cimp_chat", "source": "codex", "id": history["chats"][0]["id"]},
        "cimp_chat",
    )
    assert chat["messages"] == [
        {"role": "user", "text": "rename the module"},
        {"role": "assistant", "text": "Renamed."},
    ]
    # The owner changes the saved prompt: Undo leaves it.
    hub.set_feature_prefs(
        {
            "code_snippets": [
                {"name": "mine", "text": "My own."},
                {"name": "fix", "text": "Mine now."},
            ]
        }
    )
    undone = await _ask(hub, seen, {"type": "cimp_undo", "source": "codex"}, "cimp_undone")
    assert {k["title"] for k in undone["kept"]} == {"/fix"}
    assert vault.get("code-import:search", "SEARCH_API_KEY") is None
    assert "codex" not in hub.code_import.ledger.data
    assert hub.prefs.feature("code_project_folders") == [str(tree["alpha"])]  # Claude Code's stays
    # The owner moves the model on: Undo of Claude Code puts the mode back, keeps their model.
    hub.set_prefs({"code_model": "opus"})
    undone = await _ask(hub, seen, {"type": "cimp_undo", "source": "claude_code"}, "cimp_undone")
    assert hub.prefs.feature("code_project_folders") == []
    assert (hub.prefs.code_model, hub.prefs.code_mode) == ("opus", "ask")
    assert hub.code_import.ledger.data == {}
    assert [s["name"] for s in hub.prefs.feature("code_snippets")] == ["mine", "fix"]
    # Not one file of any tool's changed, and no secret was logged.
    assert tree_hash(home) == before
    assert not any(s in caplog.text for s in SECRETS)


async def test_every_tool_imports_and_undoes_without_touching_its_files(
    settings, quiet_speaker, isolated, home, tree
):
    before = tree_hash(home)
    hub = _hub(settings, quiet_speaker, isolated, home, tree)
    seen = events_of(hub)
    for source in ci.sources():
        preview = await _ask(
            hub, seen, {"type": "cimp_preview", "source": source.id}, "cimp_preview"
        )
        assert not any(s in json.dumps(preview) for s in SECRETS), source.id
        await _ask(hub, seen, {"type": "cimp_import", "source": source.id,
                               "items": [i["id"] for i in preview["items"] if i["can_import"]]}, "cimp_done")  # fmt: skip
    assert tree_hash(home) == before
    assert not any(s in hub.feature_path("code-import.json").read_text() for s in SECRETS)
    for source in ci.sources():
        await _ask(hub, seen, {"type": "cimp_undo", "source": source.id}, "cimp_undone")
    assert hub.code_import.ledger.data == {}
    assert (
        hub.prefs.feature("code_project_folders") == [] and hub.prefs.feature("code_snippets") == []
    )
    assert hub.connectors.vault.data == {}
    assert tree_hash(home) == before


async def test_sessions_get_the_servers_and_rules_brought_over(
    settings, quiet_speaker, isolated, home, tree
):
    hub = _hub(settings, quiet_speaker, isolated, home, tree)
    imp = hub.code_import
    hub.set_feature_prefs({"code_project_folders": [str(tree["alpha"])]})  # (on Eden's list)
    items = {i.id: i for i in await imp.preview("codex")}
    imp.apply("codex", [items["mcp:search"], items["rules:" + str(home / ".codex" / "AGENTS.md")],
                        items["rules:" + str(tree["alpha"] / "AGENTS.md")]])  # fmt: skip
    cursor = {i.id: i for i in await imp.preview("cursor")}
    imp.apply("cursor", [cursor["mcp:alpha-db"], cursor["mcp:linear"]])
    task = SimpleNamespace(id=7, kind="code", cwd=tree["alpha"], workspace=None)
    options = SimpleNamespace(mcp_servers={"linear": {"type": "stdio", "command": "theirs"}})
    imp.apply_options(task, options)
    assert options.mcp_servers["linear"] == {
        "type": "stdio",
        "command": "theirs",
    }  # the session's own wins
    assert options.mcp_servers["alpha-db"]["command"] == "db-mcp"
    search = options.mcp_servers["search"]
    assert (
        search["args"][0] == "-I"
        and search["args"][1].endswith("import_mcp_launch.py")
        and search["args"][-1] == "search"
    )
    assert SECRET3 not in json.dumps(options.mcp_servers)
    elsewhere = SimpleNamespace(id=8, kind="code", cwd=tree["beta"], workspace=None)
    assert "alpha-db" not in imp.servers_for(elsewhere)  # a project's server, for that project
    note = imp.turn_note(task)
    assert "Codex: write tests first." in note and "Use pnpm in alpha." in note
    assert imp.turn_note(task) == ""  # once, with the first message
    assert "Use pnpm in alpha." not in imp.turn_note(elsewhere)
    hub.set_feature_prefs({feature.PREF_ON: False})
    assert (
        imp.servers_for(task) == {}
        and imp.turn_note(SimpleNamespace(id=9, kind="code", cwd=tree["alpha"], workspace=None))
        == ""
    )


def test_the_launcher_starts_a_server_with_its_keys_from_the_keychain(tmp_path, monkeypatch):
    ledger = {"sources": {"codex": {"mcp": {"search": {"spec": {"type": "stdio", "command": "search-mcp",
                                                                   "args": ["--fast"], "env": {"REGION": "eu"}},
                                                          "keys": ["SEARCH_API_KEY"]}}}}}  # fmt: skip
    kept = {**import_mcp_launch.spec_of(ledger, "search"), "name": "search"}
    env = import_mcp_launch.environment(kept, {"code-import:search:SEARCH_API_KEY": SECRET3}.get)
    assert env["SEARCH_API_KEY"] == SECRET3 and env["REGION"] == "eu"
    assert import_mcp_launch.spec_of(ledger, "other") is None
    path = tmp_path / "ledger.json"
    path.write_text(json.dumps(ledger))
    ran = []
    monkeypatch.setattr(
        import_mcp_launch.os, "execvpe", lambda c, a, e: ran.append((c, a, e.get("SEARCH_API_KEY")))
    )
    import keyring

    monkeypatch.setattr(
        keyring,
        "get_password",
        lambda service, account: SECRET3 if account.endswith("SEARCH_API_KEY") else None,
    )
    assert import_mcp_launch.main(["x", str(path), "search"]) == 0
    assert ran == [("search-mcp", ["search-mcp", "--fast"], SECRET3)]
    assert import_mcp_launch.main(["x", str(path), "nope"]) == 1


async def test_what_was_brought_over_takes_effect_in_a_real_session(
    settings, quiet_speaker, isolated, home, tree
):
    """Not just ledger rows: the imported project lists its Claude Code conversations, and a session
    opened in it is made with the imported MCP servers (the project's only in that project)."""
    hub = _hub(settings, quiet_speaker, isolated, home, tree)
    imp = hub.code_import
    claude = {i.id: i for i in await imp.preview("claude_code")}
    imp.apply("claude_code", [claude[f"project:{tree['alpha']}"]])
    codex = {i.id: i for i in await imp.preview("codex")}
    cursor = {i.id: i for i in await imp.preview("cursor")}
    imp.apply("codex", [codex["mcp:search"]])
    imp.apply("cursor", [cursor["mcp:alpha-db"], cursor["mcp:linear"]])
    assert "alpha" in hub.tasks.projects()
    # (Claude Code files a project's conversations under its path with every non-letter a dash.)
    slug = "".join(c if c.isalnum() else "-" for c in str(tree["alpha"].resolve()))
    kept = home / ".claude" / "projects"
    (kept / slug).mkdir()
    (kept / "-Users-x-code-alpha" / f"{SESSION}.jsonl").rename(kept / slug / f"{SESSION}.jsonl")
    assert [s["session_id"] for s in hub.tasks.past_sessions("alpha")] == [SESSION]
    here = hub.tasks.start("", "alpha")
    servers = hub.tasks.options_for(here).mcp_servers
    assert {"search", "alpha-db", "linear"} <= set(servers)
    assert SECRET3 not in json.dumps(servers["search"])
    imp.undo("codex")
    imp.undo("cursor")
    assert not {"search", "alpha-db", "linear"} & set(hub.tasks.options_for(here).mcp_servers)
